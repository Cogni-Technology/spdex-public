/**
 * The second opinion: every test-run the Guard relies on, run on two network
 * services the user chose, on the same block, and compared.
 *
 * ## What it closes
 *
 * The Guard's strongest layer is a simulation, and a simulation is the answer
 * of one network service. A service that lies about it — or is compromised,
 * or is simply wrong — can show a clean transfer where a theft would happen,
 * and within one service there is no defence against that
 * (docs/THREAT-MODEL.md). With two services run by different people, faking
 * a test-run needs both.
 *
 * ## The rule everything here follows
 *
 * The second opinion is *unavailable* only when the second service itself
 * fails: an error, a timeout, no `eth_simulateV1`, no answer for a block it
 * must have. Nothing the main service reports can produce that state. An
 * unavailable second opinion leaves a verdict signable (`unverified`, worded
 * "Checked on one service"), so if a lying main service could cause one, it
 * would turn every disagreement it expects into something the user can sign.
 * So whatever the main service says that stops the two being compared — a
 * head far from the second's, a header that differs from the second's — is a
 * *disagreement*, which refuses.
 *
 * And when the main service *fails* before a comparison — it says it can't
 * test-run at all, or doesn't answer for its latest block, the agreed header
 * or its test-run on that block — the second service's answer is not thrown
 * away, since the main service can choose which of its own requests fail.
 * Its test-run (on the agreed block when there is one, else as it answers
 * without a pin) is compared with the main service's unpinned one, and any
 * difference is a disagreement; when the main service gives no test-run at
 * all, the second's is judged in its place. Either way the outcome is marked
 * `SimulationOutcome.uncompared`: whatever wrong it shows is refused, and a
 * pass is only ever "not checked" (`SIMULATION_UNAVAILABLE`). Only when the second
 * service fails as well does the main service's word stand alone, and then
 * because of the second's own failure.
 *
 * ## How two services are made to run the same thing
 *
 * Asked to simulate "on the latest block", two services answer about
 * different blocks, with headers each fills in itself, and every answer would
 * differ a little. So both are asked about one block both vouch for:
 *
 *   1. Heads. Each service's latest block number, in parallel. One up to 3
 *      behind the other is given a moment to catch up. Still more than 1
 *      apart → wait 2 s and read both again; still more than 1 → disagree,
 *      whichever is behind. Either one lagging pins the check to an older
 *      block than the main service alone would have used, where a token
 *      changed since could still look harmless; a main service reporting
 *      itself behind would be choosing that block.
 *   2. The block. B is the lower head. Both are asked for B's header, and the
 *      hash, time and gas limit must be identical. If not → wait 2 s and start
 *      again from step 1, once (a one-block reorg at the tip); still not →
 *      disagree.
 *   3. Both simulate the identical request on top of B, named by its hash
 *      (EIP-1898, so a service on another branch fails rather than answering
 *      for other state), with the next block's whole header pinned: number
 *      B + 1, time B's + 12, B's gas limit, a zero fee recipient, randomness
 *      and base fee. Every call gets an explicit gas limit. The time comes from
 *      the agreed header, never from the main service alone: a contract that
 *      behaves only before some time can't be shown to the Guard at an early
 *      time.
 *   4. Compared: the status; for a success, every real log in order (address,
 *      topics, data), and the ether each account gains or loses, summed from
 *      the `traceTransfers` pseudo-logs so that two clients that order those
 *      differently still agree. Not compared: gas used and revert strings,
 *      which differ between honest clients. The larger gas used is the one
 *      reported, for the one check that rests on it (what a batch of vault
 *      buys must earn to cover its network fee).
 *
 * One check waits at most 12 s on the second service in all, across every
 * request it makes there; past that, the second has failed. Only the second's
 * own requests count towards it, so a slow main service can't use it up.
 *
 * A disagreement comes back as a *reverted* simulation, so every Guard path
 * refuses it whatever `requireSimulation` says — a path that forgot the
 * second opinion entirely still refuses. `applySecondOpinion` then relabels
 * that refusal `SECOND_OPINION_DISAGREES`, so the person is told why.
 *
 * ## What it doesn't check
 *
 * Only the test-run. Prices and the Guard's 10-minute price check, balances,
 * allowances, which contract sits at an address, vault state and fees
 * (including the gas price a batch of vault buys is signed at) are read from
 * the main service alone. A check can run a block behind the main service's
 * newest, the lag two honest services commonly have, so a change made in that
 * one block isn't seen. And no test-run, on one service or two, catches a
 * contract built to behave differently a few seconds later.
 */

import {
  EthSimulateV1Provider,
  NATIVE_TOKEN,
  SimulationUnavailableError,
  TOPICS,
  probeSimulateV1,
  type JsonRpc,
  type SecondOpinion,
  type SecondOpinionDisagreement,
  type SimLog,
  type SimulationBlock,
  type SimulationOutcome,
  type SimulationProvider,
  type SimulationRequest,
} from "@spdex/chain";
import { rejected, unverified, type Address, type GuardVerdict, type GuardViolation, type Hex } from "@spdex/core";

// ─── Figures ──────────────────────────────────────────────────────────────────

/** How long any one request to the second service may take. */
export const SECOND_OPINION_TIMEOUT_MS = 8_000;
/**
 * How long one check may wait on the second service, across all its requests
 * there. Without it, a second service answering each request just inside the
 * timeout would hold every check for most of a minute, and the plan checked
 * would wait that long to be signed.
 */
export const SECOND_OPINION_BUDGET_MS = 12_000;
/** The wait before reading both services again, after heads too far apart or headers that differ. */
export const SECOND_OPINION_RETRY_MS = 2_000;
/** How long an agreed block's header is reused, across the checks of one quote. */
export const SECOND_OPINION_HEADER_SHARE_MS = 4_000;
/**
 * The most two services' latest blocks may differ by, once the one behind has
 * had a moment to catch up, and still be compared. The check runs on the
 * lower of the two, so every block of lag is state the check doesn't see;
 * one block is how far two honest services commonly are apart.
 */
export const MAX_HEAD_GAP = 1n;
/** How far behind a service may be and still be given a moment to catch up (see CATCH_UP_MS). */
const CATCH_UP_BLOCKS = 3n;
/**
 * The gas each call is simulated with, at most: EIP-7825's per-transaction
 * cap. A request that names its own gas (a batch of vault buys) keeps it.
 */
export const MAX_SIMULATED_CALL_GAS = 16_777_216n;
/** How a disagreement's synthetic revert reason starts; `applySecondOpinion` relabels those. */
export const SECOND_OPINION_REVERT_PREFIX = "second opinion disagrees: ";

/**
 * When one service is a block or a few behind the other, how long to wait for
 * it, and how often. A check made right after the person's own transaction
 * (tips after their swap, a batch of tips after its Permit2 permission) needs
 * the block that transaction is in; the main service has it, since it
 * reported the receipt, and a second service a moment behind would pin the
 * check to the block before, where it would fail. A main service more than
 * a block behind gets the same moment, rather than a refusal at once.
 */
const CATCH_UP_MS = 500;
const CATCH_UP_TRIES = 2;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_WORD = `0x${"00".repeat(32)}` as Hex;

// ─── Options ──────────────────────────────────────────────────────────────────

export interface SecondOpinionOptions {
  /** The main service, for its latest block and headers: the one the Guard's own simulations go to. */
  primaryRpc: JsonRpc;
  /** The second service. Every request to it is given `timeoutMs`. */
  secondRpc: JsonRpc;
  /**
   * The second service's host name only, never its URL, which may carry an
   * API key in its path: it goes into refusals and warnings the person reads
   * ("If alchemy.com keeps disagreeing…"). `secondOpinionHost` makes one.
   */
  host: string;
  timeoutMs?: number;
  budgetMs?: number;
  retryMs?: number;
  catchUpMs?: number;
  shareMs?: number;
  /** Tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds, for the header share and the budget. */
  now?: () => number;
}

/** A URL's host name, lowercased, for `SecondOpinionOptions.host`; "" when it isn't a URL. */
export function secondOpinionHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// ─── Failures, by whose they are ──────────────────────────────────────────────

/**
 * The second service's own failure: the one thing that makes a second
 * opinion unavailable. The message is a fixed phrase, never the service's
 * error text, which could quote its URL and the key in it.
 */
class SecondServiceFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SecondServiceFailed";
  }
}

/**
 * The main service's own failure before a comparison: a read the pin needs,
 * or its test-run on the agreed block. Its unpinned test-run is then judged,
 * and a pass is only "not checked" (`SimulationOutcome.uncompared`).
 */
class MainServiceFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MainServiceFailed";
  }
}

/** `promise`, with any failure turned into the main service's `reason`. */
const mainService = <T>(promise: Promise<T>, reason: string): Promise<T> =>
  promise.catch(() => {
    throw new MainServiceFailed(reason);
  });

class Timeout extends Error {
  constructor(method: string, ms: number) {
    super(`${method}: no answer within ${ms} ms`);
    this.name = "Timeout";
  }
}

/** Every request to `rpc` refused after `ms`. The request itself runs on; its answer is ignored. */
function withTimeout(rpc: JsonRpc, ms: number): JsonRpc {
  return (method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Timeout(method, ms)), ms);
      rpc(method, params).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}

/**
 * What one check may still spend waiting on the second service
 * (`SECOND_OPINION_BUDGET_MS`). Only the second's own requests draw on it,
 * never the main service's time or the waits between reads: if a slow main
 * service could use it up, it could have the second called "unavailable",
 * which is exactly the state the main service must never be able to cause.
 */
export class SecondOpinionBudget {
  #left: number;

  constructor(
    ms: number,
    private readonly now: () => number,
  ) {
    this.#left = ms;
  }

  /** `promise`, refused once the budget runs out; the time it took is spent either way. */
  spend<T>(promise: Promise<T>, asked: string): Promise<T> {
    const ms = this.#left;
    if (ms <= 0) {
      // Still settled, so that a request already sent can't reject unhandled.
      promise.catch(() => {});
      return Promise.reject(new Timeout(asked, 0));
    }
    const started = this.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Timeout(asked, ms)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    }).finally(() => {
      this.#left -= Math.max(this.now() - started, 0);
    });
  }

  /** `rpc`, every request of it drawing on this budget. */
  rpc(rpc: JsonRpc): JsonRpc {
    return (method, params) => this.spend(rpc(method, params), method);
  }
}

function whatFailed(error: unknown, asked: string): string {
  if (error instanceof SecondServiceFailed) return error.reason;
  if (error instanceof Timeout) return `it didn't answer ${asked} in time`;
  return `it answered ${asked} with an error`;
}

// ─── Reading blocks ───────────────────────────────────────────────────────────

const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

/** The block both services vouch for: the fields the pinned simulation is built from. */
export interface AgreedHeader {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  gasLimit: bigint;
}

/** A latest block number; throws on anything that isn't one. */
async function readHead(rpc: JsonRpc): Promise<bigint> {
  const answer = await rpc("eth_blockNumber", []);
  if (typeof answer !== "string" || !QUANTITY.test(answer)) throw new Error("eth_blockNumber: not a block number");
  return BigInt(answer);
}

/** Block `number`'s header; throws when it is missing, another block's, or malformed. */
async function readHeader(rpc: JsonRpc, number: bigint): Promise<AgreedHeader> {
  const answer = (await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false])) as Record<string, unknown> | null;
  if (answer === null || typeof answer !== "object") throw new Error(`eth_getBlockByNumber: no block ${number}`);
  const { number: n, hash, timestamp, gasLimit } = answer;
  if (typeof n !== "string" || !QUANTITY.test(n) || BigInt(n) !== number) {
    throw new Error(`eth_getBlockByNumber: asked for block ${number}, answered another`);
  }
  if (typeof hash !== "string" || !WORD.test(hash)) throw new Error("eth_getBlockByNumber: no hash");
  if (typeof timestamp !== "string" || !QUANTITY.test(timestamp)) throw new Error("eth_getBlockByNumber: no time");
  if (typeof gasLimit !== "string" || !QUANTITY.test(gasLimit)) throw new Error("eth_getBlockByNumber: no gas limit");
  return { number, hash: hash.toLowerCase() as Hex, timestamp: BigInt(timestamp), gasLimit: BigInt(gasLimit) };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Settles to `{ ok }` or `{ error }`, so a promise awaited later never rejects unhandled. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ─── The second service's test-runs ───────────────────────────────────────────

/**
 * Whether the second service has `eth_simulateV1`, remembering only a
 * definite answer (the rule `DefiniteSimulationProvider` follows for
 * scheduled buys). `EthSimulateV1Provider` alone remembers a failed probe for
 * its whole life, so one dropped connection would leave every later check
 * "checked on one service" until the page reloads.
 */
class SecondService {
  #known: boolean | null = null;
  #pending: Promise<boolean | "unknown"> | null = null;

  constructor(private readonly timed: JsonRpc) {}

  probe(): Promise<boolean | "unknown"> {
    if (this.#known !== null) return Promise.resolve(this.#known);
    this.#pending ??= probeSimulateV1(this.timed).then((answer) => {
      if (answer !== "unknown") this.#known = answer;
      this.#pending = null;
      return answer;
    });
    return this.#pending;
  }
}

/**
 * `eth_simulateV1` on a service `SecondService.probe` has already found to
 * have it, through one check's budgeted requests, so no probe is sent again.
 */
class Probed extends EthSimulateV1Provider {
  override isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

// ─── The pair ─────────────────────────────────────────────────────────────────

type Agreement =
  | { kind: "agreed"; header: AgreedHeader }
  | { kind: "disagrees"; reason: Exclude<SecondOpinionDisagreement, "result">; detail: string }
  | { kind: "unavailable"; reason: string };

type Heads = { kind: "heads"; primary: bigint; second: bigint };

type HeaderMatch = { kind: "agreed"; header: AgreedHeader } | { kind: "mismatch"; detail: string } | { kind: "unavailable"; reason: string };

/**
 * One main service and one second service, and what they currently agree on.
 * The Engine builds one per config and wraps every simulating Guard's
 * provider with it (`provider`), so that the checks of one quote share the
 * agreed block's header, and the second service's availability is probed
 * once for all of them.
 */
export class SecondOpinionPair {
  readonly host: string;
  readonly #primary: JsonRpc;
  readonly #second: JsonRpc;
  readonly #secondService: SecondService;
  readonly #budgetMs: number;
  readonly #retryMs: number;
  readonly #catchUpMs: number;
  readonly #shareMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #headers = new Map<bigint, { at: number; match: Promise<HeaderMatch> }>();

  constructor(options: SecondOpinionOptions) {
    this.host = options.host;
    this.#primary = options.primaryRpc;
    this.#second = withTimeout(options.secondRpc, options.timeoutMs ?? SECOND_OPINION_TIMEOUT_MS);
    this.#secondService = new SecondService(this.#second);
    this.#budgetMs = options.budgetMs ?? SECOND_OPINION_BUDGET_MS;
    this.#retryMs = options.retryMs ?? SECOND_OPINION_RETRY_MS;
    this.#catchUpMs = options.catchUpMs ?? CATCH_UP_MS;
    this.#shareMs = options.shareMs ?? SECOND_OPINION_HEADER_SHARE_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
  }

  /** `primary`, with every simulation also run on the second service and compared. */
  provider(primary: SimulationProvider): AgreeingSimulationProvider {
    return new AgreeingSimulationProvider(primary, this);
  }

  /** A fresh budget for one check's requests to the second service (`SECOND_OPINION_BUDGET_MS`). */
  budget(): SecondOpinionBudget {
    return new SecondOpinionBudget(this.#budgetMs, this.#now);
  }

  /** Whether the second service has `eth_simulateV1`; false when it hasn't answered. */
  async secondCanSimulate(): Promise<boolean> {
    return (await this.#secondService.probe().catch(() => "unknown" as const)) === true;
  }

  /**
   * Steps 1 and 2: the block both services vouch for, or why there is none.
   * Throws `MainServiceFailed` when the main service fails.
   */
  async agree(budget: SecondOpinionBudget): Promise<Agreement> {
    // Probed alongside the first reads rather than after them; the answer is
    // wanted only at step 3, and a definite one is remembered.
    void this.#secondService.probe().catch(() => {});
    const second = budget.rpc(this.#second);
    for (let round = 0; ; round++) {
      const heads = await this.#heads(second);
      if (heads.kind !== "heads") return heads;
      const base = heads.primary < heads.second ? heads.primary : heads.second;
      const match = await this.#headersAt(base, second);
      if (match.kind !== "mismatch") return match;
      if (round >= 1) return { kind: "disagrees", reason: "block-hash", detail: match.detail };
      await this.#sleep(this.#retryMs);
    }
  }

  /** Step 3 on the second service. Throws `SecondServiceFailed` for any failure of its own. */
  async simulateOnSecond(request: SimulationRequest, budget: SecondOpinionBudget): Promise<SimulationOutcome> {
    let available: boolean | "unknown";
    try {
      available = await budget.spend(this.#secondService.probe(), "eth_simulateV1");
    } catch (error) {
      throw new SecondServiceFailed(whatFailed(error, "whether it can test-run transactions"));
    }
    if (available === false) throw new SecondServiceFailed("it can't test-run transactions (it has no eth_simulateV1)");
    if (available === "unknown") throw new SecondServiceFailed("it didn't answer whether it can test-run transactions");
    try {
      return await new Probed(budget.rpc(this.#second)).simulate(request);
    } catch (error) {
      throw new SecondServiceFailed(
        error instanceof SimulationUnavailableError ? "it can't test-run transactions right now" : whatFailed(error, "the test-run"),
      );
    }
  }

  async #readHeads(second: JsonRpc): Promise<Heads | { kind: "unavailable"; reason: string }> {
    const answer = settle(readHead(second));
    // The main service failing is thrown at once: its own failure, never the
    // second's (see `MainServiceFailed`).
    const primary = await mainService(readHead(this.#primary), "it didn't say which block is its newest");
    const theirs = await answer;
    if (!theirs.ok) return { kind: "unavailable", reason: whatFailed(theirs.error, "for its latest block") };
    return { kind: "heads", primary, second: theirs.value };
  }

  async #heads(second: JsonRpc): Promise<Heads | { kind: "unavailable"; reason: string } | { kind: "disagrees"; reason: "heads"; detail: string }> {
    for (let round = 0; ; round++) {
      const read = await this.#readHeads(second);
      if (read.kind !== "heads") return read;
      const heads = await this.#catchUp(read, second);
      if (gap(heads.primary, heads.second) <= MAX_HEAD_GAP) return heads;
      // Too far apart to compare, whichever is behind, and never
      // "unavailable": the main service could report any head it liked to
      // make the second look behind. A second service that lags pins the
      // check to an older block than the main service alone would use, and a
      // main service that lags would be choosing that block itself.
      if (round >= 1) {
        const behind = heads.primary < heads.second ? "main service's" : "second's";
        return {
          kind: "disagrees",
          reason: "heads",
          detail: `their latest blocks are ${gap(heads.primary, heads.second)} apart, the ${behind} behind (${heads.primary} on the main service, ${heads.second} on the second)`,
        };
      }
      await this.#sleep(this.#retryMs);
    }
  }

  /**
   * The service behind given a moment to catch up (see CATCH_UP_MS): the
   * second whenever it is behind at all, the main service when it is further
   * behind than the two may be. Only the lagging head is read again, and a
   * failure to answer keeps the head it already gave.
   */
  async #catchUp(heads: Heads, second: JsonRpc): Promise<Heads> {
    let { primary, second: theirs } = heads;
    for (let i = 0; i < CATCH_UP_TRIES; i++) {
      const secondLags = theirs < primary && primary - theirs <= CATCH_UP_BLOCKS;
      const primaryLags = primary < theirs && theirs - primary > MAX_HEAD_GAP && theirs - primary <= CATCH_UP_BLOCKS;
      if (!secondLags && !primaryLags) break;
      await this.#sleep(this.#catchUpMs);
      const again = await settle(readHead(secondLags ? second : this.#primary));
      if (!again.ok) break;
      if (secondLags && again.value > theirs) theirs = again.value;
      if (primaryLags && again.value > primary) primary = again.value;
    }
    return { kind: "heads", primary, second: theirs };
  }

  /** Stop sharing block `number`'s header. */
  forget(number: bigint): void {
    this.#headers.delete(number);
  }

  /** Both services' header for `number`, shared for `shareMs` once they agree on it. */
  #headersAt(number: bigint, second: JsonRpc): Promise<HeaderMatch> {
    const now = this.#now();
    for (const [key, entry] of this.#headers) if (now - entry.at >= this.#shareMs) this.#headers.delete(key);
    const shared = this.#headers.get(number);
    if (shared) return shared.match;

    const match = this.#readHeaders(number, second);
    const entry = { at: now, match };
    this.#headers.set(number, entry);
    // Only an agreement is shared: a mismatch is read again after the retry
    // wait, and a failure is nobody's answer.
    const forget = () => {
      if (this.#headers.get(number) === entry) this.#headers.delete(number);
    };
    match.then((result) => {
      if (result.kind !== "agreed") forget();
    }, forget);
    return match;
  }

  async #readHeaders(number: bigint, second: JsonRpc): Promise<HeaderMatch> {
    const theirs = settle(readHeader(second, number));
    const primary = await mainService(readHeader(this.#primary, number), `it didn't return block ${number}`);
    const answer = await theirs;
    if (!answer.ok) return { kind: "unavailable", reason: whatFailed(answer.error, `for block ${number}`) };
    const header = answer.value;
    for (const field of ["hash", "timestamp", "gasLimit"] as const) {
      if (primary[field] !== header[field]) {
        const words = field === "hash" ? "hash" : field === "timestamp" ? "time" : "gas limit";
        return {
          kind: "mismatch",
          detail: `they report a different ${words} for block ${number} (${String(primary[field])} on the main service, ${String(header[field])} on the second)`,
        };
      }
    }
    return { kind: "agreed", header: primary };
  }
}

const gap = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

// ─── The provider ─────────────────────────────────────────────────────────────

/**
 * A `SimulationProvider` that runs every simulation on the main service and
 * the second one, on the block both vouch for, and reports what the second
 * made of it in `secondOpinion`: agrees, disagrees (and the status is then
 * `reverted`), or unavailable (the main service's answer stands alone).
 *
 * `isAvailable` is the main service's, or failing that the second's: a main
 * service that says it can't test-run still has the second service's
 * test-run judged (`#uncompared`). Only when neither can does nothing change
 * from a Guard without a second opinion.
 */
export class AgreeingSimulationProvider implements SimulationProvider {
  readonly #pair: SecondOpinionPair;

  constructor(
    private readonly primary: SimulationProvider,
    pair: SecondOpinionPair | SecondOpinionOptions,
  ) {
    this.#pair = pair instanceof SecondOpinionPair ? pair : new SecondOpinionPair(pair);
  }

  get kind(): SimulationProvider["kind"] {
    return this.primary.kind;
  }

  /** The pair this provider compares with, for sharing with another Guard's provider. */
  get pair(): SecondOpinionPair {
    return this.#pair;
  }

  async isAvailable(): Promise<boolean> {
    if (await this.primary.isAvailable()) return true;
    // Otherwise every Guard would answer "not checked" without asking the
    // second service at all: a way around the comparison that a lying main
    // service could choose by failing its availability probe.
    return this.#pair.secondCanSimulate();
  }

  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    const host = this.#pair.host;
    const budget = this.#pair.budget();
    let agreement: Awaited<ReturnType<SecondOpinionPair["agree"]>>;
    try {
      agreement = await this.#pair.agree(budget);
    } catch (error) {
      return this.#uncompared(request, error, budget, null);
    }

    if (agreement.kind === "disagrees") {
      return disagreement({ gasUsed: 0n, logs: [] }, { kind: "disagrees", host, reason: agreement.reason, detail: agreement.detail });
    }
    if (agreement.kind === "unavailable") {
      // The main service's answer, exactly as without a second opinion.
      const outcome = await this.primary.simulate(request);
      return { ...outcome, secondOpinion: { kind: "unavailable", host, reason: agreement.reason } };
    }

    const pinned: SimulationRequest = {
      ...request,
      block: pinnedBlock(agreement.header),
      gas: request.gas ?? callGas(agreement.header.gasLimit, request.calls.length),
    };
    const second = settle(this.#pair.simulateOnSecond(pinned, budget));
    let outcome: SimulationOutcome;
    try {
      outcome = await this.primary.simulate(pinned);
    } catch (error) {
      // Perhaps the agreed block is gone (a reorg while its header was
      // shared): the next check agrees on one afresh.
      this.#pair.forget(agreement.header.number);
      const reason =
        error instanceof SimulationUnavailableError ? "it can't test-run transactions" : "its test-run on the agreed block failed";
      return this.#uncompared(request, new MainServiceFailed(reason), budget, second);
    }
    const theirs = await second;
    if (!theirs.ok) {
      return { ...outcome, secondOpinion: { kind: "unavailable", host, reason: whatFailed(theirs.error, "the test-run") } };
    }

    const difference = compareOutcomes(outcome, theirs.value);
    if (difference === null) {
      return { ...outcome, gasUsed: larger(outcome.gasUsed, theirs.value.gasUsed), secondOpinion: { kind: "agrees", host } };
    }
    const opinion: SecondOpinion = { kind: "disagrees", host, reason: "result", detail: difference };
    // When the main service's own run reverts, its refusal stands with its
    // own reason; a disagreement can only add a refusal, never replace one.
    if (outcome.status === "reverted") return { ...outcome, secondOpinion: opinion };
    return disagreement(outcome, opinion);
  }

  /**
   * The main service failed before a comparison. Which of its requests fail
   * is its own choice, so the second service's answer still counts: its
   * test-run (`pinnedSecond`, already asked on the agreed block, or else one
   * run now without a pin) is compared with the main service's unpinned one,
   * and a difference refuses as any disagreement does. When the main service
   * gives no test-run at all, the second's is judged in its place. Either
   * way the outcome is `uncompared`, so a pass is never more than "not
   * checked". Only when the second service fails too does the main
   * service's word stand alone, and when both fail the failure is thrown
   * ("Not checked").
   */
  async #uncompared(
    request: SimulationRequest,
    error: unknown,
    budget: SecondOpinionBudget,
    pinnedSecond: Promise<Settled<SimulationOutcome>> | null,
  ): Promise<SimulationOutcome> {
    if (!(error instanceof MainServiceFailed)) throw error;
    const host = this.#pair.host;
    const [mine, theirs] = await Promise.all([
      settle(this.primary.simulate(request)),
      pinnedSecond ?? settle(this.#pair.simulateOnSecond(request, budget)),
    ]);
    if (!theirs.ok) {
      if (!mine.ok) throw mine.error;
      return {
        ...mine.value,
        uncompared: error.reason,
        secondOpinion: { kind: "unavailable", host, reason: whatFailed(theirs.error, "the test-run") },
      };
    }
    if (!mine.ok) return { ...theirs.value, uncompared: error.reason };

    const difference = compareOutcomes(mine.value, theirs.value);
    if (difference === null) {
      return { ...mine.value, gasUsed: larger(mine.value.gasUsed, theirs.value.gasUsed), uncompared: error.reason };
    }
    // Not at one block, so an honest pair can differ here where a pinned
    // comparison wouldn't; the detail says so, and a refusal is the safe way
    // to be wrong.
    const opinion: SecondOpinion = {
      kind: "disagrees",
      host,
      reason: "result",
      detail: `${difference} (compared without an agreed block, because your main service failed first: ${error.reason})`,
    };
    if (mine.value.status === "reverted") return { ...mine.value, secondOpinion: opinion };
    return disagreement(mine.value, opinion);
  }
}

/**
 * Gas used isn't compared, since honest clients report it differently; where
 * a check rests on it (what a batch of vault buys must earn to cover its
 * network fee), the larger figure is the one to go by, so the main service
 * alone can't understate it.
 */
const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** A disagreement as a reverted simulation: refused by every path, with the main service's logs kept for "Details". */
function disagreement(outcome: Pick<SimulationOutcome, "gasUsed" | "logs">, opinion: Extract<SecondOpinion, { kind: "disagrees" }>): SimulationOutcome {
  return {
    status: "reverted",
    revertReason: `${SECOND_OPINION_REVERT_PREFIX}${opinion.detail}`,
    gasUsed: outcome.gasUsed,
    logs: outcome.logs,
    secondOpinion: opinion,
  };
}

/** Step 3's pin: on top of `header`, the next block with every field fixed. */
export function pinnedBlock(header: AgreedHeader): SimulationBlock {
  return {
    baseHash: header.hash,
    overrides: {
      number: header.number + 1n,
      // From the agreed header, never from one service's clock.
      time: header.timestamp + 12n,
      gasLimit: header.gasLimit,
      feeRecipient: ZERO_ADDRESS,
      prevRandao: ZERO_WORD,
      // With validation off nothing charges it, and no contract the Guard
      // checks reads BASEFEE; pinned, it is one less thing to differ.
      baseFeePerGas: 0n,
    },
  };
}

/** Each call's gas when the request names none: the block's limit shared out, at most the per-transaction cap. */
function callGas(blockGasLimit: bigint, calls: number): bigint {
  const share = blockGasLimit / BigInt(Math.max(calls, 1));
  return share < MAX_SIMULATED_CALL_GAS ? share : MAX_SIMULATED_CALL_GAS;
}

// ─── Comparing two test-runs ──────────────────────────────────────────────────

const isPseudoLog = (log: SimLog): boolean => log.address.toLowerCase() === NATIVE_TOKEN;

const normalised = (log: SimLog) => ({
  address: log.address.toLowerCase(),
  topics: log.topics.map((t) => t.toLowerCase()),
  data: log.data.toLowerCase(),
});

/**
 * The ether each account gains or loses, from the pseudo-logs, with the ones
 * that can't be read kept as text: summed, because clients order these logs
 * differently, and a sum doesn't care.
 */
function etherMoved(logs: readonly SimLog[]): { deltas: Map<string, bigint>; unreadable: string[] } {
  const deltas = new Map<string, bigint>();
  const unreadable: string[] = [];
  for (const log of logs) {
    const { topics, data } = normalised(log);
    const [topic, from, to] = topics;
    if (topic !== TOPICS.transfer || topics.length !== 3 || !WORD.test(from!) || !WORD.test(to!) || !WORD.test(data)) {
      unreadable.push(JSON.stringify(normalised(log)));
      continue;
    }
    const amount = BigInt(data);
    const fromAddress = `0x${from!.slice(26)}`;
    const toAddress = `0x${to!.slice(26)}`;
    deltas.set(fromAddress, (deltas.get(fromAddress) ?? 0n) - amount);
    deltas.set(toAddress, (deltas.get(toAddress) ?? 0n) + amount);
  }
  for (const [account, delta] of deltas) if (delta === 0n) deltas.delete(account);
  return { deltas, unreadable: unreadable.sort() };
}

/**
 * The first way two test-runs of one request differ, in words; null when they
 * agree on everything compared (see the header).
 */
export function compareOutcomes(main: SimulationOutcome, second: SimulationOutcome): string | null {
  if (main.status !== second.status) {
    const said = (o: SimulationOutcome) => (o.status === "success" ? "goes through" : "reverts");
    return `the transaction ${said(main)} on the main service and ${said(second)} on the second`;
  }
  if (main.status === "reverted") return null;

  const ours = main.logs.filter((log) => !isPseudoLog(log)).map(normalised);
  const theirs = second.logs.filter((log) => !isPseudoLog(log)).map(normalised);
  const shared = Math.min(ours.length, theirs.length);
  for (let i = 0; i < shared; i++) {
    const a = ours[i]!;
    const b = theirs[i]!;
    const what =
      a.address !== b.address
        ? "comes from a different contract"
        : a.topics.length !== b.topics.length || a.topics.some((t, k) => t !== b.topics[k])
          ? "has different topics"
          : a.data !== b.data
            ? "has different data"
            : null;
    if (what !== null) return `event ${i + 1} of ${ours.length} (from ${a.address}) ${what} on the second service`;
  }
  if (ours.length !== theirs.length) {
    return `the main service reports ${ours.length} events and the second ${theirs.length}`;
  }

  const a = etherMoved(main.logs.filter(isPseudoLog));
  const b = etherMoved(second.logs.filter(isPseudoLog));
  for (const account of new Set([...a.deltas.keys(), ...b.deltas.keys()])) {
    const x = a.deltas.get(account) ?? 0n;
    const y = b.deltas.get(account) ?? 0n;
    if (x !== y) return `ether moves differently for ${account} (${x} wei on the main service, ${y} on the second)`;
  }
  if (a.unreadable.length !== b.unreadable.length || a.unreadable.some((raw, i) => raw !== b.unreadable[i])) {
    return "they report ether moving in ways that can't be compared";
  }
  return null;
}

// ─── The verdict ──────────────────────────────────────────────────────────────

/**
 * The second opinion's say in a verdict, applied last in every check that
 * simulates, after the main service's own checks have run in full.
 *
 * - `agrees`, or none asked: unchanged. Agreement never un-refuses.
 * - `disagrees`: refused. A refusal that came from the disagreement's
 *   synthetic revert is relabelled `SECOND_OPINION_DISAGREES`; the main
 *   service's own refusal (its run reverted too) keeps its own code.
 * - `unavailable`: a refusal stays one. A pass becomes `unverified` with the
 *   warning `SECOND_OPINION_UNAVAILABLE`, or is refused with that code where
 *   the path never signs unchecked (`neverUnchecked`): under
 *   `requireSimulation`, a Permit2 grant, a vault transaction that sends
 *   ether, and a batch of vault buys.
 * - `uncompared` (the main service failed first): a refusal stays one, and so
 *   does a difference between the two services' unpinned test-runs; a pass
 *   becomes `SIMULATION_UNAVAILABLE`, `unverified` or refused as above.
 *
 * The oracle is untouched: its warnings stay warnings.
 */
export function applySecondOpinion(
  verdict: GuardVerdict,
  outcome: Pick<SimulationOutcome, "status" | "revertReason" | "secondOpinion" | "uncompared"> | null | undefined,
  options: { neverUnchecked: boolean },
): GuardVerdict {
  if (outcome?.uncompared !== undefined && verdict.level !== "rejected") {
    // The main service's own failure: "not checked", as when it can't
    // simulate at all, and never blamed on the second service.
    const violation: GuardViolation = {
      code: "SIMULATION_UNAVAILABLE",
      message: `your main network service failed before its test-run could be compared with your second opinion's on one block (${outcome.uncompared}), so this has not been checked`,
      // Tells this apart from a main service that simply can't test-run,
      // which the same code also means.
      detail: { failure: outcome.uncompared },
    };
    return options.neverUnchecked ? rejected([violation]) : unverified([...verdict.warnings, violation]);
  }
  const opinion = outcome?.secondOpinion;
  if (opinion === undefined || opinion.kind === "agrees") return verdict;

  if (opinion.kind === "disagrees") {
    const violation = secondOpinionDisagrees(opinion);
    // A path that let a reverted simulation through is a bug; it still refuses here.
    if (verdict.level !== "rejected") return rejected([violation, ...verdict.violations]);
    const synthetic = outcome!.status === "reverted" && (outcome!.revertReason ?? "").startsWith(SECOND_OPINION_REVERT_PREFIX);
    if (!synthetic) return verdict;
    let relabelled = false;
    const violations = verdict.violations.flatMap((v) => {
      if (v.code !== "SIMULATION_REVERTED") return [v];
      if (relabelled) return [];
      relabelled = true;
      return [violation];
    });
    return rejected(relabelled ? violations : [violation, ...violations]);
  }

  if (verdict.level === "rejected") return verdict;
  const warning = secondOpinionUnavailable(opinion, options.neverUnchecked);
  return options.neverUnchecked ? rejected([warning]) : unverified([...verdict.warnings, warning]);
}

function secondOpinionDisagrees(opinion: Extract<SecondOpinion, { kind: "disagrees" }>): GuardViolation {
  const lead =
    opinion.reason === "heads"
      ? "your two network services' latest blocks are too far apart, so their test-runs can't be compared"
      : opinion.reason === "block-hash"
        ? "your two network services report different blocks at the same height, so their test-runs can't be compared"
        : "your two network services disagree about what this transaction would do";
  return {
    code: "SECOND_OPINION_DISAGREES",
    message: `${lead}: ${opinion.detail}`,
    detail: { host: opinion.host, reason: opinion.reason, difference: opinion.detail },
  };
}

function secondOpinionUnavailable(opinion: Extract<SecondOpinion, { kind: "unavailable" }>, refused: boolean): GuardViolation {
  const who = opinion.host === "" ? "your second network service" : `your second network service, ${opinion.host},`;
  return {
    code: "SECOND_OPINION_UNAVAILABLE",
    message: refused
      ? `${who} didn't answer (${opinion.reason}), and this is never signed on one service's test-run alone`
      : `${who} didn't answer (${opinion.reason}), so this was checked on one service only`,
    detail: { host: opinion.host, failure: opinion.reason },
  };
}
