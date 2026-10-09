/**
 * Simulation — running a plan before the user signs it.
 *
 * This is the layer that makes untrusted modules safe. Static checks bound what
 * a plan may *reference*; simulation establishes what it will actually *do*.
 * A module that lies about its intentions still produces observable transfers,
 * and those are what the Guard judges.
 *
 * Deliberately an interface with a detectable capability. `eth_simulateV1` is
 * not universal, and a user on a limited endpoint must get an honest
 * "unverified" rather than a silent downgrade to trusting the module's word.
 */

import type { Address, Call, Hex } from "@spdex/core";

export interface SimLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface SimulationOutcome {
  status: "success" | "reverted";
  revertReason?: string;
  gasUsed: bigint;
  /**
   * Logs across every call in the plan, in order.
   *
   * With `traceTransfers` enabled, native ETH movements appear here as
   * synthetic Transfer logs too — so the Guard has one uniform thing to
   * analyse rather than two parallel mechanisms.
   */
  logs: SimLog[];
  /**
   * The reverting call's revert data, or on success the last call's return
   * data, when the service reported it. Absent when it did not.
   *
   * For decoding only: what a batch of vault buys says about each vault
   * (`decodeExecuteBatchResult`, `decodeBatchRevert`). Nothing the Guard
   * allows rests on it, and two services' return data is never compared.
   */
  returnData?: Hex;
  /**
   * What a second network service made of the same request, when the user
   * set one (config `guard.secondOpinion.url`). Absent when none was asked,
   * which is also what every single-service provider returns.
   *
   * A disagreement is not reported here alone: the provider that compares
   * returns it as `status: "reverted"` as well, so every Guard path that
   * refuses a reverted simulation refuses it, including one written before
   * this field existed. Only the second service's own failure is ever
   * `unavailable`; nothing the main service reports can produce that state.
   */
  secondOpinion?: SecondOpinion;
  /**
   * Set only by a provider that compares with a second service, when the
   * *main* service failed before the two could be compared on one block —
   * its availability, its latest block, the agreed block's header, or its
   * test-run on that block. Says what failed, in words.
   *
   * The test-run here is the main service's as it answers without a pin,
   * found equal to the second service's (a difference comes back as a
   * disagreement instead); or the second's alone when the main service gave
   * none; or the main service's alone when the second failed too. The Guard
   * judges it as usual, so a theft it shows is still refused; but a pass is
   * never `verified`, only "not checked" (`SIMULATION_UNAVAILABLE`), as when
   * a main service can't simulate at all. The main service must not be able
   * to step around the comparison by failing the requests it needs, and the
   * second service is not blamed for it.
   */
  uncompared?: string;
}

/**
 * Why two services' answers could not be compared, or how they differed:
 * - `heads`: their latest blocks stayed more than 3 apart after a retry;
 * - `block-hash`: they returned different hashes for the agreed block, after a retry;
 * - `result`: they ran the same request at the same block and got different effects.
 */
export type SecondOpinionDisagreement = "heads" | "block-hash" | "result";

/**
 * The second opinion's verdict on one simulation.
 *
 * `host` is the second service's host name only (never its full URL, which
 * may carry an API key in its path), for sentences such as "If <host> keeps
 * disagreeing, remove it in Expert → Safety".
 */
export type SecondOpinion =
  | { kind: "agrees"; host: string }
  | {
      kind: "disagrees";
      host: string;
      reason: SecondOpinionDisagreement;
      /** The first difference found, in words, for "Details". */
      detail: string;
    }
  | {
      kind: "unavailable";
      host: string;
      /** What failed on the second service: a timeout, an error, no `eth_simulateV1`. */
      reason: string;
    };

/**
 * The simulated block's header, every field a node would otherwise fill in
 * from its own view: two services asked to run the same calls only give
 * comparable answers when neither chooses anything.
 */
export interface SimulationBlockOverrides {
  /** The simulated block's number: the base block's plus one. */
  number: bigint;
  /** Unix seconds. Taken from the agreed base header, never from one service alone. */
  time: bigint;
  gasLimit: bigint;
  feeRecipient: Address;
  /** 32 bytes. */
  prevRandao: Hex;
  baseFeePerGas: bigint;
}

/** Where a simulation runs: on top of one exact block, with the next block's header pinned. */
export interface SimulationBlock {
  /**
   * The base block, by hash (EIP-1898), so that a service on another branch
   * fails to find it rather than answering for a different state.
   */
  baseHash: Hex;
  overrides: SimulationBlockOverrides;
}

export interface SimulationRequest {
  chainId: number;
  /** The account the calls execute as, and whose balances the Guard asserts. */
  account: Address;
  calls: Call[];
  /**
   * Optional state overrides — used by tests to fund an account without
   * touching the chain. Never set from module-supplied data.
   */
  stateOverrides?: Record<Address, { balance?: bigint }>;
  /**
   * The block to run on. Unset, the calls run on "latest" with whatever
   * header the node chooses, as they always have.
   */
  block?: SimulationBlock;
  /**
   * The gas limit every call runs with. Unset, the node chooses.
   *
   * A call whose behaviour depends on its gas (the vault batcher reads
   * `gasleft()` before each vault) has to be simulated at the limit it will
   * be signed with, or the simulation describes some other transaction.
   */
  gas?: bigint;
}

export interface SimulationProvider {
  readonly kind: "eth_simulateV1" | "unavailable";
  /** Cheap, cached probe. Drives the UNVERIFIED banner. */
  isAvailable(): Promise<boolean>;
  simulate(request: SimulationRequest): Promise<SimulationOutcome>;
}

export class SimulationUnavailableError extends Error {
  constructor(reason: string) {
    super(`simulation unavailable: ${reason}`);
    this.name = "SimulationUnavailableError";
  }
}

type JsonRpc = (method: string, params: unknown[]) => Promise<unknown>;

const toQuantity = (v: bigint): Hex => `0x${v.toString(16)}`;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The request's block and gas as `eth_simulateV1` takes them, or a
 * `RangeError` before anything is sent.
 *
 * Checked here rather than left to the node: a malformed pin that one client
 * rejects and another quietly reads as "latest" would make two services
 * disagree, or worse, agree about different blocks.
 */
function pinned(request: SimulationRequest): {
  blockTag: "latest" | { blockHash: Hex };
  blockOverrides: Record<string, Hex | Address> | null;
  gas: Hex | null;
} {
  let gas: Hex | null = null;
  if (request.gas !== undefined) {
    if (request.gas <= 0n) throw new RangeError(`simulation gas must be positive, not ${request.gas}`);
    gas = toQuantity(request.gas);
  }
  const block = request.block;
  if (block === undefined) return { blockTag: "latest", blockOverrides: null, gas };

  const { baseHash, overrides } = block;
  if (!BYTES32.test(baseHash)) throw new RangeError(`simulation base block hash is not 32 bytes: ${baseHash}`);
  if (!BYTES32.test(overrides.prevRandao)) {
    throw new RangeError(`simulation prevRandao is not 32 bytes: ${overrides.prevRandao}`);
  }
  if (!ADDRESS.test(overrides.feeRecipient)) {
    throw new RangeError(`simulation feeRecipient is not an address: ${overrides.feeRecipient}`);
  }
  for (const key of ["number", "time", "gasLimit", "baseFeePerGas"] as const) {
    if (overrides[key] < 0n) throw new RangeError(`simulation ${key} must not be negative`);
  }
  return {
    blockTag: { blockHash: baseHash.toLowerCase() as Hex },
    blockOverrides: {
      number: toQuantity(overrides.number),
      time: toQuantity(overrides.time),
      gasLimit: toQuantity(overrides.gasLimit),
      feeRecipient: overrides.feeRecipient.toLowerCase() as Address,
      prevRandao: overrides.prevRandao.toLowerCase() as Hex,
      baseFeePerGas: toQuantity(overrides.baseFeePerGas),
    },
    gas,
  };
}

interface RawSimCall {
  status?: Hex;
  gasUsed?: Hex;
  error?: { message?: string; data?: unknown };
  logs?: { address?: string; topics?: string[]; data?: string }[];
  returnData?: Hex;
}

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Hex bytes as the service reported them, lowercased; null for anything else. */
function hexData(value: unknown): Hex | null {
  return typeof value === "string" && HEX_DATA.test(value) ? (value.toLowerCase() as Hex) : null;
}

/** The no-op simulation every probe sends: cheap, and any endpoint with the method answers it. */
const PROBE_PARAMS = [{ blockStateCalls: [{ calls: [] }], validation: false, traceTransfers: false }, "latest"] as const;

/**
 * Did the endpoint answer "there is no such method"?
 *
 * By the JSON-RPC code when the transport attached one (-32601), else by the
 * wording endpoints use for it — geth and Infura's "the method … does not
 * exist/is not available", anvil's and QuickNode's "Method not found",
 * Nethermind's "… is not supported", Alchemy's "Unsupported method". Only an
 * answer counts (`httpRpc` prefixes those with the method name): a request
 * that never got one says nothing about the method. A rate limit, an
 * internal error or anything else the endpoint answers is not this either.
 */
export function isMethodMissing(error: unknown, method = "eth_simulateV1"): boolean {
  if ((error as { code?: unknown } | null)?.code === -32601) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(`${method}:`)) return false;
  return /method\b.*\b(not found|does not exist|not available|not supported|unsupported)|(unknown|unsupported|invalid) method|not implemented/i.test(
    message,
  );
}

/**
 * Whether the endpoint can test-run a transaction: `true` when it simulated,
 * `false` when it answered that it has no `eth_simulateV1`, `"unknown"`
 * otherwise — no answer, a rate limit, an internal error — because none of
 * those says what the endpoint can do.
 */
export async function probeSimulateV1(rpc: JsonRpc): Promise<boolean | "unknown"> {
  try {
    await rpc("eth_simulateV1", [...PROBE_PARAMS]);
    return true;
  } catch (error) {
    return isMethodMissing(error) ? false : "unknown";
  }
}

/**
 * `eth_simulateV1` — the good path.
 *
 * Runs the plan's calls as one atomic sequence against current state and
 * reports logs and gas per call, so the Guard sees precisely what the user
 * would be signing.
 */
export class EthSimulateV1Provider implements SimulationProvider {
  readonly kind = "eth_simulateV1" as const;
  #available: boolean | null = null;

  constructor(private readonly rpc: JsonRpc) {}

  async isAvailable(): Promise<boolean> {
    if (this.#available !== null) return this.#available;
    try {
      // A no-op simulation: cheap, and any endpoint supporting the method
      // answers it. A "method not found" tells us to degrade honestly.
      await this.rpc("eth_simulateV1", [...PROBE_PARAMS]);
      this.#available = true;
    } catch {
      this.#available = false;
    }
    return this.#available;
  }

  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    // Before anything is sent, including the availability probe.
    const { blockTag, blockOverrides, gas } = pinned(request);

    if (!(await this.isAvailable())) {
      throw new SimulationUnavailableError("endpoint does not support eth_simulateV1");
    }

    const stateOverrides: Record<string, { balance: Hex }> = {};
    for (const [addr, override] of Object.entries(request.stateOverrides ?? {})) {
      if (override.balance !== undefined) {
        stateOverrides[addr] = { balance: toQuantity(override.balance) };
      }
    }

    const result = (await this.rpc("eth_simulateV1", [
      {
        blockStateCalls: [
          {
            ...(blockOverrides === null ? {} : { blockOverrides }),
            calls: request.calls.map((c) => ({
              from: request.account,
              to: c.to,
              data: c.data,
              value: toQuantity(c.value),
              ...(gas === null ? {} : { gas }),
            })),
            ...(Object.keys(stateOverrides).length > 0 ? { stateOverrides } : {}),
          },
        ],
        // Surfaces native ETH movement as logs, so the Guard analyses one
        // uniform stream rather than reconciling two mechanisms.
        traceTransfers: true,
        // Skip nonce/balance validation: we are asking "what would this do",
        // not "is this submittable right now".
        validation: false,
      },
      blockTag,
    ])) as { calls?: RawSimCall[] }[];

    const calls = result?.[0]?.calls ?? [];
    const logs: SimLog[] = [];
    let gasUsed = 0n;

    for (const call of calls) {
      gasUsed += call.gasUsed ? BigInt(call.gasUsed) : 0n;

      // Any reverting call fails the whole plan. Plans are atomic — a partial
      // success would leave the user having paid for nothing.
      if (call.status !== undefined && BigInt(call.status) === 0n) {
        // Clients put revert data in different places: anvil in
        // `returnData`, geth in the error's `data` as well.
        const reverted = hexData(call.error?.data) ?? hexData(call.returnData);
        return {
          status: "reverted",
          revertReason: call.error?.message ?? "call reverted",
          gasUsed,
          logs,
          ...(reverted === null ? {} : { returnData: reverted }),
        };
      }

      for (const log of call.logs ?? []) {
        logs.push({
          address: (log.address ?? "0x").toLowerCase() as Address,
          topics: (log.topics ?? []).map((t) => t.toLowerCase() as Hex),
          data: (log.data ?? "0x") as Hex,
        });
      }
    }

    const returned = hexData(calls.at(-1)?.returnData);
    return { status: "success", gasUsed, logs, ...(returned === null ? {} : { returnData: returned }) };
  }
}

/**
 * Used when the endpoint cannot simulate.
 *
 * It reports unavailability rather than pretending to succeed, which is what
 * lets the Guard return `unverified` instead of a false `verified`.
 */
export class UnavailableSimulationProvider implements SimulationProvider {
  readonly kind = "unavailable" as const;
  constructor(private readonly reason = "no simulation provider configured") {}
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async simulate(): Promise<SimulationOutcome> {
    throw new SimulationUnavailableError(this.reason);
  }
}
