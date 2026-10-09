/**
 * Scripted simulation providers.
 *
 * The Guard's contract is "given these observed effects, reach this verdict".
 * Scripting the effects tests that contract directly, with no chain and no
 * flake. Fork-based tests then confirm the *provider* reports reality
 * faithfully — two separate claims, tested separately.
 */

import type {
  JsonRpc,
  SimulationOutcome,
  SimulationProvider,
  SimulationRequest,
  SimLog,
} from "@spdex/chain";
import { SimulationUnavailableError } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";

export class ScriptedSimulationProvider implements SimulationProvider {
  readonly kind = "eth_simulateV1" as const;
  /** What the Guard actually asked to be simulated, so tests can assert on it. */
  lastRequest: SimulationRequest | null = null;
  /** Every request, in order: with its pinned `block` and `gas`, when a caller set them. */
  readonly requests: SimulationRequest[] = [];

  constructor(private readonly outcome: SimulationOutcome) {}

  static succeedingWith(logs: SimLog[], gasUsed = 150_000n): ScriptedSimulationProvider {
    return new ScriptedSimulationProvider({ status: "success", gasUsed, logs });
  }

  static reverting(reason = "execution reverted"): ScriptedSimulationProvider {
    return new ScriptedSimulationProvider({
      status: "reverted",
      revertReason: reason,
      gasUsed: 21_000n,
      logs: [],
    });
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    this.lastRequest = request;
    this.requests.push(request);
    return this.outcome;
  }
}

// ─── Two scripted services ────────────────────────────────────────────────────

/** A block header as a scripted service reports it: the fields the second opinion reads. */
export interface ScriptedHeader {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  gasLimit: bigint;
}

/** One `eth_simulateV1` as a scripted service reads it off the wire. */
export interface ScriptedRun {
  calls: { from: Address; to: Address; data: Hex; value: bigint; gas: bigint | null }[];
  /** The base block's hash as the request pinned it, or "latest". */
  base: Hex | "latest";
  /** The header the request pinned for the simulated block; null when it pinned none. */
  overrides: {
    number: bigint;
    time: bigint;
    gasLimit: bigint;
    feeRecipient: Address;
    prevRandao: Hex;
    baseFeePerGas: bigint;
  } | null;
  /** The simulated block's time: the pinned one, else this service's head's plus 12 seconds. */
  time: bigint;
  /** State overrides as sent, if any. */
  stateOverrides: Record<string, { balance?: Hex }> | null;
}

/** What a scripted service's simulation comes to. */
export type ScriptedResult =
  | { status: "success"; logs: SimLog[]; gasUsed?: bigint; returnData?: Hex }
  | { status: "reverted"; reason?: string; returnData?: Hex; gasUsed?: bigint };

export type ScriptedMethod = "eth_blockNumber" | "eth_getBlockByNumber" | "eth_simulateV1";

/** How one of the two services departs from the honest chain; every field is optional. */
export interface ScriptedService {
  /** The head it reports, given the honest head. */
  head?: (honest: bigint) => bigint;
  /** How it reports a header; null for "no such block". */
  header?: (honest: ScriptedHeader) => ScriptedHeader | null;
  /** How it runs a simulation; the pair's `run` by default. */
  run?: (run: ScriptedRun) => ScriptedResult;
  /** Methods it answers with an error. */
  fail?: readonly ScriptedMethod[];
  /** Methods it never answers. */
  hang?: readonly ScriptedMethod[];
  /** It answers `eth_simulateV1` with "Method not found", as an endpoint without it does. */
  noSimulateV1?: boolean;
  /**
   * It answers a pinned `eth_simulateV1` (one run on a block named by its
   * hash) with an error, and an unpinned one as usual: the one failure a
   * lying main service would choose, so that its own test-run is compared
   * with nothing.
   */
  failPinned?: boolean;
}

/**
 * Two scripted network services over one honest chain: a main service and a
 * second opinion, each answering `eth_blockNumber`, `eth_getBlockByNumber`
 * and `eth_simulateV1` as a node would, and each able to depart from the
 * truth in one way — a head it made up, a header it rewrote, a simulation it
 * ran differently, an error, or silence.
 *
 * It provides the two `JsonRpc`s, not a provider: the provider that compares
 * them (`AgreeingSimulationProvider`) lives in `@spdex/guard`, which this
 * package cannot depend on. A red-team test builds it from `primary` and
 * `second`, and reads `requests` to see what each service was asked.
 */
export class ScriptedPairProvider {
  readonly primary: JsonRpc;
  readonly second: JsonRpc;
  readonly requests: { primary: { method: string; params: unknown[] }[]; second: { method: string; params: unknown[] }[] } = {
    primary: [],
    second: [],
  };
  #head: bigint;

  constructor(
    private readonly options: {
      /** How both services run a simulation, unless one says otherwise. */
      run: (run: ScriptedRun) => ScriptedResult;
      primary?: ScriptedService;
      second?: ScriptedService;
      /** The honest head. */
      head?: bigint;
    },
  ) {
    this.#head = options.head ?? SCRIPTED_HEAD;
    this.primary = this.#service(options.primary ?? {}, this.requests.primary);
    this.second = this.#service(options.second ?? {}, this.requests.second);
  }

  /** The honest chain's newest block. */
  get head(): bigint {
    return this.#head;
  }

  /** A new block on the honest chain, as a service catching up sees it. */
  advance(blocks = 1n): void {
    this.#head += blocks;
  }

  /** The honest chain's header at `number`. */
  header(number: bigint): ScriptedHeader {
    return {
      number,
      // Distinct per block and shaped like a hash; nothing reads more into it.
      hash: `0x${((number * 0x9e3779b97f4a7c15n) ^ 0x5eed5eed5eedn).toString(16).padStart(64, "0").slice(-64)}` as Hex,
      timestamp: SCRIPTED_TIME + 12n * (number - SCRIPTED_HEAD),
      gasLimit: 36_000_000n,
    };
  }

  #service(script: ScriptedService, log: { method: string; params: unknown[] }[]): JsonRpc {
    const headOf = () => (script.head ? script.head(this.#head) : this.#head);
    const headerOf = (number: bigint): ScriptedHeader | null => {
      if (number < 0n || number > this.#head) return null;
      const honest = this.header(number);
      return script.header ? script.header(honest) : honest;
    };
    return async (method, params) => {
      log.push({ method, params });
      if (script.hang?.includes(method as ScriptedMethod)) return new Promise<never>(() => {});
      if (script.fail?.includes(method as ScriptedMethod)) throw new Error(`${method}: scripted failure`);
      switch (method) {
        case "eth_blockNumber":
          return quantity(headOf());
        case "eth_getBlockByNumber": {
          const header = headerOf(BigInt(params[0] as string));
          return header === null
            ? null
            : { number: quantity(header.number), hash: header.hash, timestamp: quantity(header.timestamp), gasLimit: quantity(header.gasLimit) };
        }
        case "eth_simulateV1":
          if (script.noSimulateV1) throw Object.assign(new Error("eth_simulateV1: Method not found"), { code: -32601 });
          return this.#simulate(params, script, headerOf, headOf);
        default:
          throw new Error(`${method}: not scripted`);
      }
    };
  }

  #simulate(
    params: unknown[],
    script: ScriptedService,
    headerOf: (number: bigint) => ScriptedHeader | null,
    headOf: () => bigint,
  ): unknown {
    const [body, tag] = params as [
      {
        blockStateCalls: {
          blockOverrides?: Record<string, string>;
          calls: { from: Address; to: Address; data: Hex; value: Hex; gas?: Hex }[];
          stateOverrides?: Record<string, { balance?: Hex }>;
        }[];
      },
      "latest" | { blockHash: Hex },
    ];
    const state = body.blockStateCalls[0]!;
    if (state.calls.length === 0) return [{ calls: [] }];

    let base: Hex | "latest" = "latest";
    if (tag !== "latest" && script.failPinned) throw new Error("eth_simulateV1: scripted failure on a pinned block");
    if (tag !== "latest") {
      // A service knows only the blocks it reports: a hash it never gave out is not found.
      let known = false;
      for (let n = this.#head; n >= 0n && n > this.#head - 256n; n--) {
        if (headerOf(n)?.hash.toLowerCase() === tag.blockHash.toLowerCase()) known = true;
      }
      if (!known) throw new Error("eth_simulateV1: header not found");
      base = tag.blockHash;
    }
    const o = state.blockOverrides;
    const overrides =
      o === undefined
        ? null
        : {
            number: BigInt(o["number"]!),
            time: BigInt(o["time"]!),
            gasLimit: BigInt(o["gasLimit"]!),
            feeRecipient: o["feeRecipient"] as Address,
            prevRandao: o["prevRandao"] as Hex,
            baseFeePerGas: BigInt(o["baseFeePerGas"]!),
          };
    const head = headerOf(headOf()) ?? this.header(this.#head);
    const run: ScriptedRun = {
      calls: state.calls.map((c) => ({ from: c.from, to: c.to, data: c.data, value: BigInt(c.value), gas: c.gas === undefined ? null : BigInt(c.gas) })),
      base,
      overrides,
      time: overrides?.time ?? head.timestamp + 12n,
      stateOverrides: state.stateOverrides ?? null,
    };
    const result = (script.run ?? this.options.run)(run);
    const last = state.calls.length - 1;
    if (result.status === "reverted") {
      return [
        {
          calls: [
            {
              status: "0x0",
              gasUsed: quantity(result.gasUsed ?? 21_000n),
              logs: [],
              returnData: result.returnData ?? "0x",
              error: { message: result.reason ?? "execution reverted" },
            },
          ],
        },
      ];
    }
    return [
      {
        calls: state.calls.map((_, i) => ({
          status: "0x1",
          gasUsed: quantity(i === last ? (result.gasUsed ?? 150_000n) : 21_000n),
          logs: i === last ? result.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) : [],
          returnData: i === last ? (result.returnData ?? "0x") : "0x",
        })),
      },
    ];
  }
}

/** The honest head of a `ScriptedPairProvider`, and its time. */
export const SCRIPTED_HEAD = 26_000_000n;
export const SCRIPTED_TIME = 1_790_000_000n;

const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;

/** Reports unavailable — drives the UNVERIFIED path. */
export class NoSimulationProvider implements SimulationProvider {
  readonly kind = "unavailable" as const;
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async simulate(): Promise<SimulationOutcome> {
    throw new SimulationUnavailableError("scripted unavailable");
  }
}

/**
 * Claims to be available, then fails.
 *
 * Models a flaky or rate-limited endpoint — the case where a naive
 * implementation would fall through to a verdict of `verified`.
 */
export class FlakySimulationProvider implements SimulationProvider {
  readonly kind = "eth_simulateV1" as const;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async simulate(): Promise<SimulationOutcome> {
    throw new Error("rate limited");
  }
}

/**
 * A deterministic stand-in for chain reads.
 *
 * Returns data derived from the call itself, so results are reproducible and a
 * module's determinism can be tested without a node. Counts calls so budget
 * enforcement can be asserted.
 */
export class StubChainReader {
  calls: { to: string; data: string }[] = [];

  async multicall(calls: { to: string; data: string }[]): Promise<string[]> {
    this.calls.push(...calls);

    // A real suspension point, deliberately.
    //
    // An async function that never actually yields resolves on the
    // microtask queue and, in the QuickJS sandbox, asyncify never suspends the
    // VM. That made this double *faster* than reality in a way that hid a real
    // bug: mixing a synchronous host function into a suspended async frame
    // corrupts asyncify, and it only surfaced against a live RPC. A stub whose
    // timing is unrepresentative tests a code path users never take.
    await new Promise((resolve) => setTimeout(resolve, 0));

    return calls.map((c) => `0x${c.to.slice(2, 10)}${c.data.slice(2).padStart(8, "0")}`);
  }
}

/** Fails every read — proves a module surfaces RPC failure rather than fabricating. */
export class FailingChainReader {
  async multicall(): Promise<string[]> {
    throw new Error("rpc unavailable");
  }
}
