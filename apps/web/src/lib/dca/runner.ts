/**
 * The auto-buy runner: the host's side of a recurring buy.
 *
 * A plan is an instruction in the config; the scheduler module says when each
 * buy is due; the Guard says whether a buy is the plan. What is left — the
 * clock, the record, the key, the transactions — is host work, and it is all
 * here, in one loop that runs while a spDEX tab is open. There is no server:
 * when no tab is open, nothing is bought, and a buy time that passes unseen is
 * recorded as missed rather than made up later. (A vault plan is the
 * exception, and is not run here at all: its vault buys on chain.)
 *
 * ## The rules every path below keeps
 *
 * 1. **Quoted fresh, checked as a scheduled buy, executed as checked.** Every
 *    buy is quoted at the moment it is made (`Engine.quoteScheduled`), judged
 *    by the `ScheduledBuyGuard`, and sent through `executeQuote` — all calls
 *    of every leg, from the account that was checked.
 * 2. **Unknown is not zero.** A record that cannot be read, a plan with no
 *    record here, a balance or a fee that cannot be read, a receipt that has
 *    not arrived: each stops or holds the plan and says why. None becomes 0.
 * 3. **Claim before signing.** A buy's window and its most-it-can-spend are
 *    written to the ledger after a signable verdict and before the first
 *    signature, and given back only when nothing can have been spent. A crash
 *    costs a skipped buy, never a second one.
 * 4. **One tab.** A Web Locks lock (`spdex.dca.leader`) held for the tab's
 *    life decides which tab acts. Others watch, and take over when it closes.
 *    Without Web Locks nothing acts, and the snapshot says why.
 * 5. **Nothing unattended goes out publicly after privacy was asked for.** The
 *    wallet sender a scheduled buy uses refuses the public fallback, and a buy
 *    that cannot be sent privately is skipped with that reason.
 * 6. **A warning asks; it never refuses.** A buy whose fresh quote carries a
 *    warning (the oracle's price cross-check) is not signed: the owner's
 *    Confirm comes back with the figure, and "Buy anyway" re-quotes and goes
 *    ahead only if the fresh figure is no worse than the one the owner saw.
 * 7. **Scheduled buys never tip.** Tips are a manual-swap feature and nothing
 *    here sends one.
 *
 * ## Every plan here waits for a click
 *
 * Every plan this runner runs is a wallet plan, and its buy is never started
 * by the timer: a wallet prompt that appears by itself, on a tab someone left
 * open, is a prompt they will learn to click through. When one is due the
 * plan says `due`, and the buy runs when the owner presses Confirm
 * (`confirmDue`) — quoted, checked and claimed at that moment. A window that
 * ends unconfirmed is recorded once as not confirmed. The timer's work is
 * only to notice: what is due, what was missed, and what an earlier session
 * left unsettled. (Until config version 8 an autopilot plan bought by itself
 * from a spending wallet; that is gone, and what its records left behind is
 * read here as the spending wallet's, not the owner's — see `#reconcile`.)
 */

import { NATIVE_TOKEN, TOPICS, isNativeToken, type JsonRpc } from "@spdex/chain";
import {
  scheduleRequest,
  slotAt,
  slotOpensAt,
  vetScheduleDecision,
  type DcaPlan,
  type GuardViolation,
  type RefusedDueBuy,
  type SpdexConfig,
  type WireDueBuy,
} from "@spdex/core";
import type { Engine, QuoteResult } from "../engine.js";
import { balanceOf } from "../erc20.js";
import { ExecutionError, OwnerWalletLock, executeQuote, type ExecuteStep, type TxSender } from "../execute.js";
import { LateSignature, PrivateSubmissionUnavailable, RawTransactionRejected } from "../submit.js";
import { TOKEN_LIST, tradedAs, type TokenInfo } from "../tokens.js";
import { isUserRejection } from "../wallet.js";
import {
  ClaimRefusedError,
  HALT_AFTER_FAILURES,
  RUN_CODES,
  RunStateError,
  browserStorage,
  claimBuy,
  closeWindow,
  entryKey,
  entryOf,
  heldRun,
  markSeen,
  markUnknown,
  progressOf,
  recordAttempt,
  recordMissed,
  recordSent,
  replaceSent,
  reinstateClaim,
  releaseBuy,
  resolveHeld,
  settleBuy,
  unsettledRun,
  type DcaLedger,
  type DcaLedgerEntry,
  type DcaRun,
  type EntryRef,
  type LedgerStore,
  type RunStep,
  type StorageLike,
} from "./ledger.js";

/** How often the runner looks. Hidden tabs are throttled to about once a minute, which windows of 5 minutes and up absorb. */
export const TICK_MS = 15_000;
/** After a refused buy, how long the plan shows as waiting before it offers the buy again in its window. */
export const RETRY_MS = 5 * 60_000;
/** The Web Locks name. One holder per origin, which is one tab. */
export const LEADER_LOCK = "spdex.dca.leader";
/**
 * After a buy's deadline, how long before a transaction that never showed up
 * is taken as never happening. Past the deadline its swap can only revert, so
 * no money can move; the margin covers an endpoint that is slow to show a
 * receipt for something mined just in time.
 */
export const RECEIPT_GRACE_SECONDS = 600;
/**
 * A wallet-mode buy sent privately is posted only if the wallet signed it at
 * least this long before the quote's deadline (or a quarter of the quote's
 * lifetime, if that is shorter). Posted any later, it would most likely reach
 * a block after the deadline and revert, paying its fee for nothing; so it is
 * not posted at all (`LATE_SIGNATURE`).
 */
export const LATE_SIGNATURE_MARGIN_SECONDS = 30;

/**
 * The leader's heartbeat, in localStorage: which tab leads and when it last
 * looked. For display only — "Last checked 14:05", "Running in another tab
 * (last checked 14:03)" — since a frozen tab and a working one look alike
 * otherwise. Who leads is decided by the Web Lock alone; the lease never
 * grants or takes leadership, so a wrong or stale one can mislead the
 * display and nothing else.
 */
export const LEASE_KEY = "spdex.dca.lease.v1";
/**
 * A lease older than this is stale: two looks at the once-a-minute rate
 * browsers throttle background timers to, so a slow leader is not called
 * stale but a frozen or closed one is.
 */
export const LEASE_STALE_MS = 150_000;

export interface RunnerLease {
  /** Random per tab (per page load); see `TAB_ID`. */
  tabId: string;
  /** When the leading tab last looked, ms since the epoch. */
  lastTick: number;
}

/**
 * This page's id for the lease: one per tab, shared by every runner the page
 * creates, so a runner rebuilt after a config change is still "this tab".
 */
export const TAB_ID: string = randomTabId();

function randomTabId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The lease, or null when there is none or it cannot be read. Never throws. */
export function readLease(storage: StorageLike | null = browserStorage()): RunnerLease | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LEASE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { tabId, lastTick } = parsed as Record<string, unknown>;
    if (typeof tabId !== "string" || !/^[0-9a-f]{1,64}$/.test(tabId)) return null;
    if (!Number.isSafeInteger(lastTick) || (lastTick as number) < 0) return null;
    return { tabId, lastTick: lastTick as number };
  } catch {
    return null;
  }
}

export type AttentionCode =
  | "ledger-unavailable"
  | "ledger-write"
  | "chain-mismatch"
  | "unknown-token"
  | "halted"
  | "unsettled"
  | "wallet-disconnected"
  | "owner-mismatch"
  | "wrong-network"
  /** The record names an old autopilot plan's spending wallet as signer: see `#walletProblem`. */
  | "old-signer"
  | "scheduler";

export type PlanState =
  | { kind: "paused" }
  | { kind: "done" }
  /** Nothing to do until `nextAt`, unix seconds (what `countdown` in format.ts takes). */
  | { kind: "waiting"; nextAt: number }
  /** The buy is due and waits for the owner to confirm it, until `endsAt` (unix seconds). */
  | { kind: "due"; slot: number; endsAt: number }
  /**
   * A buy in progress. `step`: `quoting` (getting a price), `checking` (the
   * safety check), `approving` / `swapping` (the wallet is asking to sign),
   * `confirming` (sent, waiting for the network), `measuring` (confirmed,
   * reading what arrived). `detail` is the transaction's `ExecuteStep` (leg i
   * of n, the market's label).
   */
  | {
      kind: "buying";
      step?: "quoting" | "checking" | "approving" | "swapping" | "confirming" | "measuring";
      detail?: ExecuteStep;
    }
  | { kind: "attention"; reason: string; code: AttentionCode }
  /** Active in the config, with no record in this browser: started elsewhere, or imported. */
  | { kind: "not-started-here" };

export interface RunnerSnapshot {
  leader: "this-tab" | "other-tab" | "unsupported" | "stopped";
  ledger: "ok" | "unavailable";
  plans: Record<string, PlanState>;
  /** Proposals from the scheduler module that were not acted on, and why, from the last look. */
  refused: RefusedDueBuy[];
  /**
   * The leader's heartbeat as of the last look (this tab's own when it leads),
   * or null when none has been written or it cannot be read. `thisTab` is
   * whether this page wrote it. Stale when `now − lastTick > LEASE_STALE_MS`.
   */
  lease: (RunnerLease & { thisTab: boolean }) | null;
}

/** What a button press came to. */
export type BuyOutcome =
  | { kind: "bought"; amountOut?: bigint; partial: boolean }
  /** The fresh quote carries a price warning; call again with `acceptDivergenceBps` to go ahead. */
  | { kind: "needs-price-consent"; needsPriceConsent: number; codes: string[] }
  | {
      kind: "declined" | "skipped" | "failed" | "unknown" | "refused" | "busy" | "not-due" | "unavailable";
      reason: string;
      codes?: string[];
    };

/** The parts of the Web Locks API the runner uses; `navigator.locks` in the app. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** What the runner asks of the engine. A real `Engine` is one. */
export type DcaEngine = Pick<Engine, "rpc" | "dueBuys" | "quoteScheduled">;

export interface DcaRunnerDeps {
  engine: DcaEngine;
  config: SpdexConfig;
  ledger: LedgerStore;
  /** The connected account, lowercase, or null. */
  account: () => `0x${string}` | null;
  /** Whether the connected wallet is on `config.chainId`. */
  walletChainOk: () => boolean;
  /**
   * The owner's wallet as a sender, for a confirmed buy. Build it
   * with `walletSender({ …, onPublicFallback: () => false, notAfter, onSigned })`:
   * the public fallback prompt is for a person at the swap button, never for
   * a scheduled buy; `notAfter` (the buy's deadline less
   * `LATE_SIGNATURE_MARGIN_SECONDS`) keeps a private signature that came back
   * too late from being posted; and `onSigned` records a private
   * transaction's hash before it is posted, so a relay answer lost on the way
   * back leaves a transaction to look for.
   */
  walletSender: (
    account: `0x${string}`,
    options: { notAfter: number; onSigned: (hash: `0x${string}`) => Promise<void> },
  ) => TxSender;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** `navigator.locks`; null means the browser has none, and the runner will not act. */
  locks?: LockManagerLike | null;
  onChange?: (snapshot: RunnerSnapshot) => void;
  /** Shared with the manual swap, so a wallet never has two sequences of prompts at once. */
  ownerWalletLock?: OwnerWalletLock;
  /** For tests; the global timers otherwise. */
  timers?: Timers;
  /** For tests; `document` otherwise. */
  visibility?: VisibilitySource | null;
  /** Where refusals and swallowed errors are reported; `console.warn` otherwise. */
  log?: (message: string, detail?: unknown) => void;
  /** Where the lease is kept; the page's localStorage otherwise, null for none. */
  lease?: StorageLike | null;
  /** This tab's lease id; `TAB_ID` otherwise. */
  tabId?: string;
}

interface Candidate {
  plan: DcaPlan;
  entry: DcaLedgerEntry;
  ref: EntryRef;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
}

const attention = (code: AttentionCode, reason: string): PlanState => ({ kind: "attention", code, reason });
const HOST_CODES: ReadonlySet<string> = new Set(Object.values(RUN_CODES));
const lower = (address: string) => address.toLowerCase() as `0x${string}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function tokenFor(address: string): TokenInfo | null {
  return TOKEN_LIST.find((token) => token.address.toLowerCase() === address.toLowerCase()) ?? null;
}

function defaultLocks(): LockManagerLike | null {
  // Typed through `Navigator` so the DOM's LockManager is checked against
  // LockManagerLike at compile time.
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const locks: LockManagerLike | undefined = nav?.locks;
  return locks ?? null;
}

function defaultVisibility(): VisibilitySource | null {
  const doc = (globalThis as { document?: VisibilitySource }).document;
  return doc ?? null;
}

const defaultTimers: Timers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export class DcaRunner {
  readonly #deps: DcaRunnerDeps;
  readonly #now: () => number;
  readonly #rpc: JsonRpc;
  readonly #locks: LockManagerLike | null;
  readonly #timers: Timers;
  readonly #visibility: VisibilitySource | null;
  readonly #ownerWalletLock: OwnerWalletLock;
  readonly #log: (message: string, detail?: unknown) => void;
  readonly #leaseStorage: StorageLike | null;
  readonly #tabId: string;
  #lease: RunnerLease | null = null;

  #running = false;
  /** Bumped on every start and stop, so a lock granted to a superseded start is let go at once. */
  #generation = 0;
  #leader: RunnerSnapshot["leader"] = "stopped";
  #releaseLock: (() => void) | null = null;
  #abort: AbortController | null = null;
  #interval: unknown = null;
  #unsubscribeLedger: (() => void) | null = null;
  #leaderWaiters: (() => void)[] = [];

  /** Every tick and button press runs one after another through this chain. */
  #chain: Promise<unknown> = Promise.resolve();
  #tickQueued: Promise<void> | null = null;

  #ledgerState: "ok" | "unavailable" = "ok";
  #plans: Record<string, PlanState> = {};
  #refused: RefusedDueBuy[] = [];
  /** A buy in progress shows through whatever the last look said. */
  readonly #overrides = new Map<string, PlanState>();
  /** `${entryKey}#${slot}` of buys this runner is executing, which reconciliation must leave alone. */
  readonly #inFlight = new Set<string>();

  constructor(deps: DcaRunnerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#rpc = deps.engine.rpc;
    this.#locks = deps.locks === undefined ? defaultLocks() : deps.locks;
    this.#timers = deps.timers ?? defaultTimers;
    this.#visibility = deps.visibility === undefined ? defaultVisibility() : deps.visibility;
    this.#ownerWalletLock = deps.ownerWalletLock ?? new OwnerWalletLock();
    this.#log = deps.log ?? ((message, detail) => console.warn(`[spdex auto-buy] ${message}`, detail ?? ""));
    this.#leaseStorage = deps.lease === undefined ? browserStorage() : deps.lease;
    this.#tabId = deps.tabId ?? TAB_ID;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start looking, and ask to lead. Idempotent: React's StrictMode mounts
   * twice, and a second start must not add a second interval or lock request.
   */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const generation = ++this.#generation;
    this.#interval = this.#timers.setInterval(() => void this.tick(), TICK_MS);
    this.#visibility?.addEventListener("visibilitychange", this.#onVisible);
    this.#unsubscribeLedger = this.#deps.ledger.subscribe(this.#onLedgerChange);
    this.#acquire(generation);
    void this.tick();
  }

  /**
   * Stop looking and let another tab lead. A buy already past its claim is
   * finished first — abandoning it half-sent would leave the record behind
   * the chain — and the lock is released after it.
   */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#generation += 1;
    if (this.#interval !== null) this.#timers.clearInterval(this.#interval);
    this.#interval = null;
    this.#visibility?.removeEventListener("visibilitychange", this.#onVisible);
    this.#unsubscribeLedger?.();
    this.#unsubscribeLedger = null;
    this.#abort?.abort();
    this.#abort = null;
    const release = this.#releaseLock;
    this.#releaseLock = null;
    if (release) void this.#chain.then(release, release);
    this.#leader = "stopped";
    for (const wake of this.#leaderWaiters.splice(0)) wake();
    this.#emit();
  }

  snapshot(): RunnerSnapshot {
    const plans: Record<string, PlanState> = { ...this.#plans };
    for (const [planId, state] of this.#overrides) plans[planId] = state;
    const lease = this.#lease === null ? null : { ...this.#lease, thisTab: this.#lease.tabId === this.#tabId };
    return { leader: this.#leader, ledger: this.#ledgerState, plans, refused: [...this.#refused], lease };
  }

  /**
   * Look now. Never overlapping: a look requested while one is waiting to run
   * joins it, and one requested while a look is running runs after it.
   */
  tick(): Promise<void> {
    if (this.#tickQueued) return this.#tickQueued;
    const queued: Promise<void> = this.#serial(async () => {
      if (this.#tickQueued === queued) this.#tickQueued = null;
      const generation = this.#generation;
      try {
        // The leader looks holding the ledger lock, so no other tab's write
        // lands between reading the record and recording what a buy did.
        // Other tabs only read, and take no lock.
        if (this.#mayWrite(generation)) await this.#deps.ledger.exclusive(() => this.#look(generation));
        else await this.#look(generation);
      } catch (error) {
        this.#log("a look at the auto-buy plans failed", error);
      }
      this.#heartbeat(generation);
      this.#emit();
    });
    this.#tickQueued = queued;
    return queued;
  }

  readonly #onVisible = () => {
    if (this.#visibility?.visibilityState === "visible") void this.tick();
  };

  /** Another tab wrote; a watching tab refreshes what it shows. The leader wrote it itself. */
  readonly #onLedgerChange = () => {
    if (this.#leader !== "this-tab") void this.tick();
  };

  #acquire(generation: number): void {
    const locks = this.#locks;
    if (!locks) {
      // Two tabs each running plans would each make every buy. Without a
      // way to know which tab is the only one, none is.
      this.#leader = "unsupported";
      this.#emit();
      return;
    }
    const current = () => generation === this.#generation && this.#running;
    const hold = (lock: unknown) =>
      new Promise<void>((release) => {
        if (lock === null || lock === undefined || !current()) {
          release();
          return;
        }
        this.#releaseLock = release;
        this.#leader = "this-tab";
        for (const wake of this.#leaderWaiters.splice(0)) wake();
        this.#emit();
        void this.tick();
      });

    locks
      .request(LEADER_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock !== null && lock !== undefined) return hold(lock);
        if (!current()) return;
        this.#leader = "other-tab";
        this.#emit();
        // Queue behind the leading tab, so this one takes over when it closes.
        const abort = new AbortController();
        this.#abort = abort;
        locks.request(LEADER_LOCK, { signal: abort.signal }, hold).catch(() => {
          // Aborted by stop(); nothing to do.
        });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        this.#leader = "unsupported";
        this.#log("Web Locks refused the leader lock", error);
        this.#emit();
      });
  }

  /** Resolves true once this tab leads, false if it does not within the time. */
  #whenLeader(timeoutMs: number): Promise<boolean> {
    if (this.#leader === "this-tab") return Promise.resolve(true);
    if (!this.#running || this.#leader === "unsupported") return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.#leader === "this-tab"), timeoutMs);
      this.#leaderWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.#leader === "this-tab");
      });
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #emit(): void {
    try {
      this.#deps.onChange?.(this.snapshot());
    } catch (error) {
      this.#log("an onChange listener threw", error);
    }
  }

  #setBuying(planId: string, step: NonNullable<Extract<PlanState, { kind: "buying" }>["step"]>, detail?: ExecuteStep) {
    this.#overrides.set(planId, { kind: "buying", step, ...(detail === undefined ? {} : { detail }) });
    this.#emit();
  }

  /**
   * After each look: the leader writes the lease, every other tab reads it.
   * Best effort — storage that refuses leaves the display without a
   * heartbeat, never the runner without a look.
   */
  #heartbeat(generation: number): void {
    if (this.#mayWrite(generation)) {
      const lease: RunnerLease = { tabId: this.#tabId, lastTick: this.#now() };
      try {
        this.#leaseStorage?.setItem(LEASE_KEY, JSON.stringify(lease));
        this.#lease = lease;
      } catch (error) {
        this.#log("could not write the auto-buy heartbeat", error);
        this.#lease = readLease(this.#leaseStorage);
      }
      return;
    }
    this.#lease = readLease(this.#leaseStorage);
  }

  #mayWrite(generation: number): boolean {
    return this.#running && generation === this.#generation && this.#leader === "this-tab";
  }

  /** Apply a ledger transition; null (and a log line) if it could not be written. */
  #write(change: (ledger: DcaLedger) => DcaLedger): DcaLedger | null {
    try {
      return this.#deps.ledger.update(change);
    } catch (error) {
      this.#log("could not update this browser's auto-buy record", error);
      return null;
    }
  }

  // ── One look ────────────────────────────────────────────────────────────

  async #look(generation: number): Promise<void> {
    const config = this.#deps.config;
    const leading = this.#mayWrite(generation);
    const nowMs = this.#now();
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));

    const read = this.#deps.ledger.read();
    if (read === "unavailable") {
      this.#ledgerState = "unavailable";
      this.#refused = [];
      this.#plans = Object.fromEntries(
        config.dca.plans.map((plan) => [
          plan.id,
          plan.paused || !config.dca.enabled
            ? { kind: "paused" }
            : attention(
                "ledger-unavailable",
                "spDEX can't read this browser's record of this plan, so it won't buy — it would rather skip a buy than risk buying twice.",
              ),
        ]),
      );
      return;
    }
    this.#ledgerState = "ok";
    let ledger: DcaLedger = read;

    const states: Record<string, PlanState> = {};
    const candidates: Candidate[] = [];

    for (const plan of config.dca.plans) {
      const ref = { planId: plan.id, chainId: plan.chainId };
      if (plan.chainId !== config.chainId) {
        states[plan.id] = attention(
          "chain-mismatch",
          `Set up on chain ${plan.chainId}; spDEX is connected to chain ${config.chainId}. It won't buy here.`,
        );
        continue;
      }
      let entry = entryOf(ledger, ref);
      if (entry && entry.buysDone >= plan.maxBuys && !unsettledRun(entry)) {
        states[plan.id] = { kind: "done" };
        continue;
      }
      if (!config.dca.enabled) {
        states[plan.id] = { kind: "paused" };
        continue;
      }
      if (!entry) {
        states[plan.id] = plan.paused ? { kind: "paused" } : { kind: "not-started-here" };
        continue;
      }

      // Settle what an earlier session left unsettled, paused or not: money
      // may have moved, and the record should say so before anything else.
      if (leading) {
        ledger = (await this.#reconcile(plan, entry)) ?? ledger;
        entry = entryOf(ledger, ref)!;
        if (entry.buysDone >= plan.maxBuys && !unsettledRun(entry)) {
          states[plan.id] = { kind: "done" };
          continue;
        }
      }

      const tokenIn = tokenFor(plan.sell);
      const tokenOut = tokenFor(plan.buy);
      if (!tokenIn || !tokenOut) {
        states[plan.id] = attention(
          "unknown-token",
          `Uses a token spDEX doesn't list (${!tokenIn ? plan.sell : plan.buy}), so it won't buy.`,
        );
        continue;
      }
      if (tradedAs(tokenIn).address === tradedAs(tokenOut).address) {
        states[plan.id] = attention(
          "unknown-token",
          `${tokenIn.symbol} and ${tokenOut.symbol} are the same asset — spDEX swaps, it does not wrap, so this plan won't buy.`,
        );
        continue;
      }

      const open = unsettledRun(entry);
      const slot = slotAt(plan, nowSeconds);
      if (leading && slot !== null) {
        ledger = this.#bookkeep(plan, entry, slot, !plan.paused && entry.halted === undefined && !open, nowMs) ?? ledger;
        entry = entryOf(ledger, ref)!;
      }

      if (plan.paused) {
        states[plan.id] = { kind: "paused" };
        continue;
      }
      if (entry.halted !== undefined) {
        states[plan.id] = haltedState(entry);
        continue;
      }
      if (open) {
        states[plan.id] = unsettledState(open);
        continue;
      }
      candidates.push({ plan, entry, ref, tokenIn, tokenOut });
    }

    if (candidates.length === 0) {
      this.#refused = [];
      this.#plans = states;
      return;
    }

    const request = scheduleRequest(
      candidates.map((c) => c.plan),
      candidates.map((c) => progressOf(c.entry)),
      nowSeconds,
    );
    let decision;
    try {
      decision = await this.#deps.engine.dueBuys(request);
    } catch (error) {
      // Automation that fails silently is automation nobody knows has
      // stopped: every plan says so.
      for (const c of candidates) states[c.plan.id] = attention("scheduler", messageOf(error));
      this.#refused = [];
      this.#plans = states;
      return;
    }
    const { accepted, refused } = vetScheduleDecision(request, decision);
    for (const r of refused) this.#log(`the scheduler proposed a buy spDEX will not make (${r.reason})`, r.buy);
    this.#refused = refused;
    const due = new Map(accepted.map((buy) => [buy.planId, buy]));
    const next = new Map(decision.next.map((n) => [n.planId, n.at]));

    // A look makes no buy: a due one waits for its owner's Confirm, so every
    // plan's state is known at once.
    for (const c of candidates) {
      const buy = due.get(c.plan.id);
      if (buy !== undefined) {
        states[c.plan.id] = this.#onDue(c, buy);
        continue;
      }
      const at = next.get(c.plan.id);
      states[c.plan.id] =
        at === null || at === undefined
          ? { kind: "waiting", nextAt: Number(slotOpensAt(c.plan, (c.entry.lastSlot ?? -1) + 1)) }
          : { kind: "waiting", nextAt: Number(at) };
    }
    this.#plans = states;
  }

  /** The state of a plan whose buy is due: waiting for its owner's Confirm, or why the owner's wallet can't make it. */
  #onDue(c: Candidate, buy: WireDueBuy): PlanState {
    const endsAt = Number(slotOpensAt(c.plan, buy.slot + 1));
    return this.#walletProblem(c.entry) ?? { kind: "due", slot: buy.slot, endsAt };
  }

  /** Why the owner's wallet cannot make a plan's buy right now, or null if it can. */
  #walletProblem(entry: DcaLedgerEntry): PlanState | null {
    // Only a plan resumed without going through Resume can get here like
    // this: one migrated from autopilot and set running by a hand edit. Its
    // record still names the old spending wallet, so the Guard would refuse
    // every buy; Resume binds the record to its owner first.
    if (entry.signer !== entry.owner) {
      return attention(
        "old-signer",
        "This plan used to buy with a spending wallet, which spDEX no longer uses. Pause it, then resume it to confirm its buys in your wallet.",
      );
    }
    const account = this.#deps.account();
    if (account === null) {
      return attention("wallet-disconnected", "Due now — connect your wallet to make this buy.");
    }
    if (lower(account) !== entry.owner) {
      return attention(
        "owner-mismatch",
        `This plan buys for ${entry.owner}. Connect that wallet to continue — to buy for a different wallet, set up a new plan.`,
      );
    }
    if (!this.#deps.walletChainOk()) {
      return attention(
        "wrong-network",
        `Your wallet is on another network. Switch to chain ${entry.chainId} to keep buying.`,
      );
    }
    return null;
  }

  async #quote(
    c: Candidate,
    buy: WireDueBuy,
    nowMs: number,
    nowSeconds: bigint,
  ): Promise<{ quote: QuoteResult } | { state: PlanState; reason: string }> {
    const { plan, entry } = c;
    try {
      const quote = await this.#deps.engine.quoteScheduled({
        plan,
        progress: progressOf(entry),
        slot: buy.slot,
        amountIn: BigInt(buy.amountIn),
        tokenIn: c.tokenIn,
        tokenOut: c.tokenOut,
        nowSeconds,
        onCheck: () => this.#setBuying(plan.id, "checking"),
      });
      return { quote };
    } catch (error) {
      const reason = `no price could be found: ${messageOf(error)}`;
      const endsAt = Number(slotOpensAt(plan, buy.slot + 1));
      return { state: this.#skip(c, buy.slot, BigInt(buy.amountIn), nowMs, endsAt, reason, [RUN_CODES.QUOTE_FAILED]), reason };
    }
  }

  #skip(c: Candidate, slot: number, amountIn: bigint, nowMs: number, endsAt: number, reason: string, codes: string[]): PlanState {
    const ledger = this.#write((l) => recordAttempt(l, c.ref, { slot, status: "skipped", reason, codes, amountIn, at: nowMs }));
    const entry = ledger ? entryOf(ledger, c.ref) : undefined;
    if (entry?.halted !== undefined) {
      return haltedState(entry);
    }
    return { kind: "waiting", nextAt: Math.min(Math.ceil((nowMs + RETRY_MS) / 1000), endsAt) };
  }

  // ── Claim, execute, settle ──────────────────────────────────────────────

  /**
   * Claim the window, execute, and record what happened.
   *
   * The claim is the line: before it, stopping costs nothing; after it, the
   * buy is finished and recorded whatever happens, because a half-recorded
   * buy is how a budget gets spent twice. Every record of the buy after the
   * claim goes through `#recordClaimed`, which puts the claim back (and stops
   * the plan) if the record lost it meanwhile.
   */
  async #execute(
    c: Candidate,
    slot: number,
    quote: QuoteResult,
    makeSender: (onSigned: (hash: `0x${string}`) => Promise<void>) => Promise<TxSender>,
    generation: number,
    nowMs: number,
    extra: { ownerNonce?: number } = {},
  ): Promise<PlanState> {
    const { plan, ref } = c;
    const endsAt = Number(slotOpensAt(plan, slot + 1));
    if (!this.#mayWrite(generation)) return { kind: "waiting", nextAt: Math.ceil(nowMs / 1000) };

    const claim = quote.legs.reduce((sum, leg) => sum + leg.plan.intent.maxAmountIn, 0n);
    const calls = quote.legs.reduce((sum, leg) => sum + leg.plan.calls.length, 0);
    const deadline = deadlineOf(quote);

    let ledger: DcaLedger;
    try {
      ledger = this.#deps.ledger.update((l) =>
        claimBuy(l, ref, {
          slot,
          amountIn: claim,
          at: nowMs,
          calls,
          deadline,
          ...(extra.ownerNonce === undefined ? {} : { ownerNonce: extra.ownerNonce }),
        }),
      );
    } catch (error) {
      if (error instanceof ClaimRefusedError) {
        this.#log(`not claiming window ${slot} of ${plan.id}: ${error.message}`);
        return { kind: "waiting", nextAt: endsAt };
      }
      // Principle 3: no claim written, no signature.
      return attention("ledger-write", `spDEX couldn't write this browser's record, so it didn't buy: ${messageOf(error)}`);
    }
    const entry = entryOf(ledger, ref)!;
    const owner = entry.owner;
    const flightKey = `${entryKey(ref.chainId, ref.planId)}#${slot}`;
    this.#inFlight.add(flightKey);

    // What this runner knows of its own buy, kept here as well as in the
    // record, so a claim the record lost can be put back as it stood.
    const claimedRun = entry.runs.find((r) => r.slot === slot && r.status === "pending")!;
    const known = { hashes: [] as string[], steps: [] as RunStep[] };
    const claimed = (): DcaRun => ({ ...claimedRun, hashes: [...known.hashes], steps: [...known.steps] });
    const record = (change: (l: DcaLedger) => DcaLedger) => this.#recordClaimed(ref, claimed, change);

    let step: RunStep = "swap";
    const persist = async (hash: `0x${string}`, kind: RunStep) => {
      const h = hash.toLowerCase();
      if (!known.hashes.includes(h)) {
        known.hashes.push(h);
        known.steps.push(kind);
      }
      // Throws if it cannot be written; before a broadcast that stops the
      // transaction going out, after one executeQuote stops before
      // confirming, and the buy is settled from the chain later.
      if (record((l) => recordSent(l, ref, slot, hash, kind)) === null) {
        throw new Error("spDEX couldn't record this transaction in this browser's record");
      }
    };

    try {
      // Native ether out is measured from the owner's balance; an ERC-20 from
      // the Transfer logs, which needs no "before".
      let before: bigint | null = null;
      if (isNativeToken(plan.buy)) {
        try {
          before = await balanceOf(this.#rpc, NATIVE_TOKEN, owner);
        } catch {
          // Unmeasured, then; never guessed.
        }
      }

      let sender: TxSender;
      try {
        sender = await makeSender((hash) => persist(hash, step));
      } catch (error) {
        record((l) =>
          releaseBuy(l, ref, {
            slot,
            status: "skipped",
            reason: `spDEX couldn't ask your wallet for this buy: ${messageOf(error)}`,
            at: this.#now(),
            countsAsFailure: true,
          }),
        );
        return this.#stateAfter(c, endsAt);
      }

      try {
        let detail: ExecuteStep | undefined;
        const result = await executeQuote(quote, sender, this.#rpc, {
          onStep: (s) => {
            step = s.kind;
            detail = s;
            this.#setBuying(plan.id, s.kind === "approve" ? "approving" : "swapping", s);
          },
          onSent: async (hash, kind) => {
            await persist(hash, kind);
            this.#setBuying(plan.id, "confirming", detail);
          },
          // A wallet's faster copy takes the original's place, so a tab that
          // closes now looks for the hash that can still be mined.
          onReplaced: (hash, _kind, original) => {
            const at = known.hashes.indexOf(original.toLowerCase());
            if (at !== -1) known.hashes[at] = hash.toLowerCase();
            record((l) => replaceSent(l, ref, slot, original, hash));
          },
        });
        this.#setBuying(plan.id, "measuring");
        const amountOut = await this.#measure(plan, owner, result.hashes, true, before);
        record((l) =>
          settleBuy(l, ref, {
            slot,
            ...(amountOut === undefined ? {} : { amountOut }),
            hashes: result.hashes,
            ...(result.via === null ? {} : { via: result.via }),
            at: this.#now(),
          }),
        );
      } catch (error) {
        return await this.#afterFailure(c, slot, quote, error, before, flightKey, record);
      }
      return this.#stateAfter(c, endsAt);
    } finally {
      this.#inFlight.delete(flightKey);
      this.#overrides.delete(plan.id);
    }
  }

  /**
   * Record something about a buy this runner claimed.
   *
   * If the claim is not in the record — something wrote over the record while
   * the buy was under way — the claim is put back first, as this runner knows
   * it (`reinstateClaim`: its window used, its spending committed, the plan
   * stopped for a person to look at), and then the change is made. Never
   * "log and carry on": a buy that happened with no claim on record is a buy
   * whose window could be bought in again.
   */
  #recordClaimed(ref: EntryRef, claimed: () => DcaRun, change: (l: DcaLedger) => DcaLedger): DcaLedger | null {
    try {
      return this.#deps.ledger.update(change);
    } catch (error) {
      if (!(error instanceof RunStateError)) {
        this.#log("could not update this browser's auto-buy record", error);
        return null;
      }
      this.#log("a buy's claim was missing from this browser's record; putting it back and stopping the plan", error);
      try {
        return this.#deps.ledger.update((l) =>
          change(
            reinstateClaim(
              l,
              ref,
              claimed(),
              "this plan's record changed while a buy was being made (another spDEX tab wrote over it). spDEX put the buy back in the record — check the history, then resume",
            ),
          ),
        );
      } catch (again) {
        this.#log("could not put a buy's claim back in this browser's record", again);
        return null;
      }
    }
  }

  /**
   * Record a buy that stopped part-way or before it started.
   *
   * Decided by what is known to have left: nothing (the wallet said no, the
   * wallet cannot send privately, the relay refused the bytes, the signature
   * would have been too late) releases the claim; some legs done settles it
   * as a partial buy; anything that may have been sent and whose fate is not
   * known yet is left unknown and checked against the chain straight away.
   * "May have been sent" includes every error the wallet answers but a
   * refusal: a wallet broadcasts before it answers, so a timeout or a dropped
   * WalletConnect session says nothing about whether the buy went out.
   */
  async #afterFailure(
    c: Candidate,
    slot: number,
    quote: QuoteResult,
    thrown: unknown,
    before: bigint | null,
    flightKey: string,
    record: (change: (l: DcaLedger) => DcaLedger) => DcaLedger | null,
  ): Promise<PlanState> {
    const { plan, ref } = c;
    const endsAt = Number(slotOpensAt(plan, slot + 1));
    const error = thrown instanceof ExecutionError ? thrown : new ExecutionError(thrown, 0, [], "send");
    const cause = error.cause;
    const at = this.#now();
    const release = (
      status: "failed" | "declined" | "skipped",
      reason: string,
      codes: string[] = [],
      countsAsFailure?: boolean,
    ) =>
      record((l) =>
        releaseBuy(l, ref, {
          slot,
          status,
          reason,
          codes,
          hashes: error.hashes,
          at,
          ...(countsAsFailure === undefined ? {} : { countsAsFailure }),
        }),
      );

    if (error.legsDone > 0) {
      // Money moved. The buy counts, with what arrived, and says it was partial.
      const run = this.#runFor(ref, slot);
      const hashes = run?.hashes ?? error.hashes;
      const amountOut = await this.#measure(plan, c.entry.owner, hashes, true, before);
      record((l) =>
        settleBuy(l, ref, {
          slot,
          ...(amountOut === undefined ? {} : { amountOut }),
          hashes: error.hashes,
          note: `only ${error.legsDone} of ${quote.legs.length} parts of this buy went through: ${error.message}`,
          codes: [RUN_CODES.PARTIAL],
          at,
        }),
      );
      return this.#stateAfter(c, endsAt);
    }

    // Refused or failed before this step's transaction was asked for.
    if (error.stage === "check") {
      release("failed", error.message, [], true);
      return this.#stateAfter(c, endsAt);
    }

    if (error.stage === "send") {
      if (isUserRejection(cause)) {
        // The window opens again (`releaseBuy`): the buy is due as before,
        // for the owner to confirm after all or skip, and a look now puts its
        // Confirm back on the card rather than at the next tick.
        release("declined", "declined in your wallet", [RUN_CODES.DECLINED], false);
        void this.tick();
        return this.#stateAfter(c, endsAt);
      }
      if (cause instanceof PrivateSubmissionUnavailable) {
        // Never a public broadcast instead: the fallback prompt is for a
        // person at the swap button.
        release(
          "skipped",
          "your wallet can't send privately, and spDEX won't send a scheduled buy publicly without asking",
          [RUN_CODES.PRIVATE_UNAVAILABLE],
          true,
        );
        return this.#stateAfter(c, endsAt);
      }
      if (cause instanceof LateSignature) {
        // Too late to be worth a fee, so not sent. A person who signed late
        // is not a failure.
        release(
          "skipped",
          "signed too close to its deadline, so spDEX didn't send it; no network fee was spent on it",
          [RUN_CODES.LATE_SIGNATURE],
          false,
        );
        return this.#stateAfter(c, endsAt);
      }
      if (cause instanceof RawTransactionRejected) {
        // Answered and refused: this transaction did not go out, and it is
        // never offered anywhere else instead. Counted, so a relay or an
        // endpoint that refuses every buy stops the plan rather than being
        // asked forever.
        const refusedBy =
          this.#deps.config.submitter.mode === "private"
            ? `the private relay didn't take it (${cause.reason}), and spDEX never sends an auto-buy publicly without asking`
            : `your network service refused the transaction (${cause.reason}); nothing was sent`;
        release("skipped", refusedBy, [RUN_CODES.RELAY_FAILED], true);
        return this.#stateAfter(c, endsAt);
      }
      // A wallet that answered with something other than a refusal: it may
      // be out there.
    }

    // Sent, or perhaps sent, and not confirmed: reverted, not seen in time,
    // or unknown. Ask the chain now; if it cannot say yet, the buy stays
    // unknown.
    const walletUnanswered = error.stage === "send";
    record((l) =>
      markUnknown(l, ref, {
        slot,
        hashes: error.hashes,
        reason: error.message,
        at,
        ...(walletUnanswered ? { walletUnanswered: true } : {}),
      }),
    );
    // No longer this runner's to finish: it is the chain's to decide.
    this.#inFlight.delete(flightKey);
    const read = this.#deps.ledger.read();
    const entry = read === "unavailable" ? undefined : entryOf(read, ref);
    if (entry) await this.#reconcile(plan, entry, before);
    return this.#stateAfter(c, endsAt);
  }

  #runFor(ref: EntryRef, slot: number): DcaRun | undefined {
    const read = this.#deps.ledger.read();
    if (read === "unavailable") return undefined;
    return entryOf(read, ref)?.runs.find(
      (run) => run.slot === slot && (run.status === "pending" || run.status === "unknown"),
    );
  }

  /** A plan's state after a buy attempt, from the record as it now stands. */
  #stateAfter(c: Candidate, endsAt: number): PlanState {
    const read = this.#deps.ledger.read();
    if (read === "unavailable") {
      return attention("ledger-unavailable", "spDEX can't read this browser's record of this plan, so it won't buy.");
    }
    const entry = entryOf(read, c.ref);
    if (!entry) return { kind: "not-started-here" };
    if (entry.buysDone >= c.plan.maxBuys && !unsettledRun(entry)) return { kind: "done" };
    if (entry.halted !== undefined) {
      return haltedState(entry);
    }
    const open = unsettledRun(entry);
    if (open) return unsettledState(open);
    return { kind: "waiting", nextAt: endsAt };
  }

  // ── Reading the chain ───────────────────────────────────────────────────

  async #receipts(hashes: readonly string[]): Promise<(Receipt | null)[] | null> {
    try {
      return await Promise.all(
        hashes.map(async (hash) => {
          const receipt = await this.#rpc("eth_getTransactionReceipt", [hash]);
          return receipt && typeof receipt === "object" ? (receipt as Receipt) : null;
        }),
      );
    } catch (error) {
      this.#log("could not read receipts", error);
      return null;
    }
  }

  /**
   * What arrived at the owner, measured, or undefined.
   *
   * An ERC-20 from the swaps' Transfer logs to the owner — exact, and not
   * thrown off by anything else the owner received meanwhile. Native ether
   * from the owner's balance, before and after, plus the fees the owner paid
   * when their own wallet sent the buy (`ownerPaid`; an old autopilot buy's
   * fees were the spending wallet's). Anything that cannot be read is
   * undefined: the UI shows "from k of n buys", never a made-up figure.
   */
  async #measure(
    plan: DcaPlan,
    owner: string,
    hashes: readonly string[],
    ownerPaid: boolean,
    before: bigint | null,
    known?: (Receipt | null)[],
  ): Promise<bigint | undefined> {
    const receipts = known ?? (await this.#receipts(hashes));
    if (!receipts) return undefined;
    if (isNativeToken(plan.buy)) {
      if (before === null) return undefined;
      let after: bigint;
      try {
        after = await balanceOf(this.#rpc, NATIVE_TOKEN, owner);
      } catch {
        return undefined;
      }
      let fees = 0n;
      if (ownerPaid) {
        for (const receipt of receipts) {
          const paid = feePaid(receipt);
          if (paid === null) return undefined;
          fees += paid;
        }
      }
      const delivered = after - before + fees;
      return delivered > 0n ? delivered : undefined;
    }
    const delivered = transfersTo(receipts, plan.buy, owner);
    return delivered !== null && delivered > 0n ? delivered : undefined;
  }

  /**
   * Settle an unsettled buy from the chain.
   *
   * - Every transaction has a receipt, or the deadline has passed (after which
   *   a swap can only revert, so a missing one cannot deliver): decided — a
   *   swap succeeded, it settles, partial if not every swap did; none did, it
   *   is released.
   * - Otherwise it stays unknown, and no new buy starts.
   *
   * "The deadline has passed" is the chain's word, not this device's: the
   * latest block's timestamp (never later than this device's clock either),
   * because a device clock running ahead would release a buy the chain can
   * still execute — and releasing it gives its spending back to the budget.
   *
   * A buy with no hash recorded: the owner's wallet reports the hash only
   * after sending, so it is decided by the owner's nonce: once the account
   * has used the nonce the buy was to use, something went out in its place,
   * and the buy is counted as made (`ASSUMED_SPENT`) rather than given back;
   * until then it is released only after the deadline. The same holds for a
   * wallet buy whose hash never confirmed — the wallet may have replaced it
   * ("speed up") with another.
   *
   * Who signed is read from the record, not the plan. A record that still
   * names an old autopilot plan's spending wallet (config version 8 made the
   * plan a wallet plan; `bindToOwner` refuses to rebind a record with a buy
   * unsettled) holds that wallet's buy, which recorded each hash before
   * broadcasting: none means nothing was sent, and it is released.
   */
  async #reconcile(plan: DcaPlan, entry: DcaLedgerEntry, before: bigint | null = null): Promise<DcaLedger | null> {
    const run = unsettledRun(entry);
    if (!run) return null;
    const ref = { planId: entry.planId, chainId: entry.chainId };
    if (this.#inFlight.has(`${entryKey(ref.chainId, ref.planId)}#${run.slot}`)) return null;
    const at = this.#now();
    const byWallet = entry.signer === entry.owner;
    const interrupted = run.status === "pending" ? [RUN_CODES.INTERRUPTED] : [];
    // Left unknown. A pending wallet run whose wallet may hold a transaction
    // with no hash on record keeps saying so once it is unknown.
    const stayUnknown = (walletUnanswered: boolean) =>
      run.status === "pending"
        ? this.#write((l) =>
            markUnknown(l, ref, {
              slot: run.slot,
              reason: walletUnanswered
                ? "spDEX closed while your wallet was asked to send this buy"
                : "not confirmed by the network yet",
              at,
              ...(walletUnanswered ? { walletUnanswered: true } : {}),
            }),
          )
        : null;
    const assumeSpent = () =>
      this.#write((l) =>
        settleBuy(l, ref, {
          slot: run.slot,
          note:
            "your wallet sent a transaction in this buy's place and spDEX couldn't find the buy itself on chain; " +
            "it counts as made, so the plan never spends more than its budget — check your wallet's activity",
          codes: [...interrupted, RUN_CODES.ASSUMED_SPENT],
          at,
        }),
      );

    if (run.hashes.length === 0 && !byWallet) {
      return this.#write((l) =>
        releaseBuy(l, ref, {
          slot: run.slot,
          status: "failed",
          reason: "spDEX closed before this buy was sent; nothing was bought",
          codes: [RUN_CODES.INTERRUPTED],
          at,
          countsAsFailure: false,
        }),
      );
    }

    const receipts = run.hashes.length === 0 ? [] : await this.#receipts(run.hashes);
    if (!receipts) return null;
    const missing = receipts.some((r) => r === null);
    const steps = run.steps ?? run.hashes.map((_, i): RunStep => (i === run.hashes.length - 1 ? "swap" : "approve"));
    const swaps = receipts.filter((_, i) => steps[i] === "swap");
    const succeeded = swaps.filter((r): r is Receipt => r !== null && succeededReceipt(r));
    const reverted = receipts.some((r) => r !== null && !succeededReceipt(r));
    // A wallet may hold one of this buy's transactions whose hash never
    // reached the record: the tab closed while the wallet was asking (the
    // run is still pending), or the wallet answered with an error that was
    // not a refusal — and the buy has fewer swaps recorded than it needed.
    const unrecorded =
      byWallet &&
      (run.status === "pending" || run.walletUnanswered === true) &&
      (run.calls ?? Math.max(1, swaps.length)) > swaps.length;

    if (succeeded.length === 0 && byWallet && (missing || unrecorded)) {
      // Once the account has used the nonce the unconfirmed transaction was
      // to take, something went out there: the buy, or a replacement for it.
      const moved = await this.#nonceUsed(entry.owner, run, receipts.filter((r) => r !== null).length);
      if (moved === null) return null;
      if (moved) return assumeSpent();
    }
    if ((missing || unrecorded) && !(await this.#pastDeadline(run))) return stayUnknown(unrecorded);

    if (succeeded.length === 0) {
      return this.#write((l) =>
        releaseBuy(l, ref, {
          slot: run.slot,
          status: "failed",
          reason: reverted
            ? "the buy's transaction reverted on chain; nothing was bought, and the network fee was spent"
            : run.hashes.length === 0
              ? "your wallet never sent this buy, and its deadline has passed; nothing was bought"
              : "the buy was never confirmed before its deadline; nothing was bought",
          codes: reverted ? [RUN_CODES.REVERTED, ...interrupted] : [RUN_CODES.INTERRUPTED],
          at,
          countsAsFailure: reverted,
        }),
      );
    }

    const amountOut = await this.#measure(plan, entry.owner, run.hashes, byWallet, before, receipts);
    const partial = succeeded.length < (run.calls ?? swaps.length);
    return this.#write((l) =>
      settleBuy(l, ref, {
        slot: run.slot,
        ...(amountOut === undefined ? {} : { amountOut }),
        ...(partial ? { note: `only ${succeeded.length} of ${run.calls ?? swaps.length} parts of this buy went through` } : {}),
        codes: [...interrupted, ...(partial ? [RUN_CODES.PARTIAL] : [])],
        at,
      }),
    );
  }

  /**
   * Whether the chain's clock is past a buy's deadline and the grace after
   * it. The latest block's timestamp, capped at this device's clock, so that
   * neither a device running fast nor an endpoint reporting the future can
   * release a buy on its own; unreadable is "not yet".
   */
  async #pastDeadline(run: DcaRun): Promise<boolean> {
    if (run.deadline === undefined) return false;
    let chainSeconds: number;
    try {
      const block = await this.#rpc("eth_getBlockByNumber", ["latest", false]);
      const stamp = (block as { timestamp?: unknown } | null)?.timestamp;
      if (typeof stamp !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(stamp)) return false;
      chainSeconds = Number(BigInt(stamp));
    } catch {
      return false;
    }
    const now = Math.min(chainSeconds, Math.floor(this.#now() / 1000));
    return now > run.deadline + RECEIPT_GRACE_SECONDS;
  }

  /** The owner's transaction count ("pending": for the next nonce; "latest": mined), or null when unreadable. */
  async #ownerNonce(owner: string, block: "pending" | "latest"): Promise<number | null> {
    try {
      const raw = await this.#rpc("eth_getTransactionCount", [owner, block]);
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,13}$/.test(raw)) return null;
      return Number(BigInt(raw));
    } catch {
      return null;
    }
  }

  /**
   * Whether the owner's account has had a transaction mined at the nonce this
   * buy's next unconfirmed transaction was to use: `ownerNonce + confirmed`.
   * Null when that cannot be known — the count is unreadable, or the run
   * predates recording a nonce, which is then treated as "not used".
   */
  async #nonceUsed(owner: string, run: DcaRun, confirmed: number): Promise<boolean | null> {
    if (run.ownerNonce === undefined) return false;
    const mined = await this.#ownerNonce(owner, "latest");
    if (mined === null) return null;
    return mined > run.ownerNonce + confirmed;
  }

  // ── Windows that ended ──────────────────────────────────────────────────

  /**
   * Keep the history honest about windows that ended without a buy.
   *
   * When the window the runner last looked in has ended: a buy held for its
   * owner (only an old autopilot plan's record has one) is recorded as
   * expired; a window where the plan could have bought and did not is
   * recorded once as not confirmed. Windows nobody looked in at all — spDEX
   * was closed — become one "missed" entry, however many there were, but
   * only for a plan that could have bought in them: one last seen paused,
   * stopped or waiting on an unsettled buy did not miss anything by spDEX
   * being closed, and saying it did would be untrue. None of these counts as
   * the plan failing.
   */
  #bookkeep(plan: DcaPlan, entry: DcaLedgerEntry, slot: number, active: boolean, nowMs: number): DcaLedger | null {
    const ref = { planId: entry.planId, chainId: entry.chainId };
    let ledger: DcaLedger | null = null;
    const apply = (change: (l: DcaLedger) => DcaLedger) => {
      const next = this.#write(change);
      if (next) ledger = next;
      return next !== null;
    };
    const seen = entry.lastSeen;
    const buysLeft = entry.buysDone < plan.maxBuys;

    if (seen === undefined) {
      // Only windows since the plan was started here: before that it was not
      // this browser's to run, and "missed while spDEX wasn't running" would
      // be untrue of an imported plan started today.
      const covered = Math.max(entry.lastSlot ?? -1, ...entry.runs.map((r) => r.slot));
      const startedIn = slotAt(plan, BigInt(Math.floor(entry.startedAt / 1000))) ?? 0;
      const from = Math.max(covered + 1, startedIn);
      if (slot - 1 >= from && buysLeft && active) {
        apply((l) => recordMissed(l, ref, { fromSlot: from, toSlot: slot - 1, at: nowMs }));
      }
    } else if (slot > seen.slot) {
      const last = seen.slot;
      const claimed = entry.lastSlot !== null && entry.lastSlot >= last;
      const held = heldRun(entry, last);
      const recorded = entry.runs.some((r) => r.slot === last && r.status !== "held");
      if (held && !claimed) {
        apply((l) => resolveHeld(l, ref, { slot: last, outcome: "expire", at: nowMs }));
      } else if (seen.active && !claimed && !recorded && buysLeft) {
        const amountIn = BigInt(plan.amountPerBuy);
        apply((l) =>
          closeWindow(l, ref, {
            slot: last,
            code: RUN_CODES.NOT_CONFIRMED,
            reason: "not confirmed before its buy time ended",
            amountIn,
            at: nowMs,
          }),
        );
      }
      if (slot - last - 1 > 0 && buysLeft && seen.active) {
        apply((l) => recordMissed(l, ref, { fromSlot: last + 1, toSlot: slot - 1, at: nowMs }));
      }
    }
    if (!seen || seen.slot !== slot || seen.active !== active) {
      apply((l) => markSeen(l, ref, { slot, active }));
    }
    return ledger;
  }

  // ── What a person can press ─────────────────────────────────────────────

  /**
   * Confirm a plan's due buy: quote it now, check it, claim it, and ask the
   * wallet. The first buy of a plan just started comes here too, from the
   * Start click itself: that click is the confirmation.
   *
   * If the fresh quote carries a price warning, nothing is signed: the answer
   * is `needs-price-consent` with the figure, and a second call with
   * `acceptDivergenceBps` at least that figure goes ahead — if the price has
   * not got worse in between.
   */
  confirmDue(planId: string, options: { acceptDivergenceBps?: number } = {}): Promise<BuyOutcome> {
    return this.#serial(() => this.#asLeader(() => this.#confirmDue(planId, options)));
  }

  /** Skip a plan's due buy. The window is used; the next buy is the next window's. */
  skipDue(planId: string): Promise<BuyOutcome> {
    return this.#serial(() => this.#asLeader(async () => {
      const found = await this.#dueFor(planId);
      if ("outcome" in found) return found.outcome;
      const { c, buy } = found;
      const written = this.#write((l) =>
        closeWindow(l, c.ref, {
          slot: buy.slot,
          code: RUN_CODES.SKIPPED_BY_USER,
          reason: "skipped by you",
          amountIn: BigInt(buy.amountIn),
          at: this.#now(),
        }),
      );
      void this.tick();
      return written
        ? { kind: "skipped", reason: "skipped by you", codes: [RUN_CODES.SKIPPED_BY_USER] }
        : { kind: "unavailable", reason: "spDEX couldn't write this browser's record" };
    }));
  }

  /**
   * A button press: only in the leading tab, and holding the ledger lock
   * while it records — so no other tab's write lands between this press
   * reading the record and writing what it did. Leadership is settled first,
   * so a tab that does not lead answers at once rather than waiting behind
   * the leader's buy for the lock.
   */
  async #asLeader(task: () => Promise<BuyOutcome>): Promise<BuyOutcome> {
    if (!(await this.#whenLeader(2_000))) return this.#notLeading();
    return this.#deps.ledger.exclusive(task);
  }

  #notLeading(): BuyOutcome {
    if (this.#leader === "unsupported") {
      return { kind: "unavailable", reason: "This browser can't make sure only one tab buys, so auto-buys don't run here." };
    }
    if (this.#leader === "other-tab") {
      // The lock can be held by this very page: a runner replaced after a
      // config change keeps it until the buy it was making has finished.
      return this.#lease?.tabId === this.#tabId
        ? { kind: "unavailable", reason: "This tab is still finishing another auto-buy. Try again in a moment." }
        : { kind: "unavailable", reason: "Another spDEX tab is running your auto-buys. Use that tab." };
    }
    return { kind: "unavailable", reason: "Auto-buys aren't running in this tab." };
  }

  /** The plan's buy due now, with everything needed to make it — or why there is none. */
  async #dueFor(planId: string): Promise<
    | { outcome: BuyOutcome }
    | { c: Candidate; buy: WireDueBuy; generation: number; nowMs: number; nowSeconds: bigint }
  > {
    if (!(await this.#whenLeader(2_000))) return { outcome: this.#notLeading() };
    const generation = this.#generation;
    const config = this.#deps.config;
    const plan = config.dca.plans.find((p) => p.id === planId);
    if (!plan) return { outcome: { kind: "not-due", reason: "There is no such plan." } };
    if (!config.dca.enabled) return { outcome: { kind: "not-due", reason: "Auto-buy is switched off." } };
    if (plan.paused) return { outcome: { kind: "not-due", reason: "This plan is paused." } };
    if (plan.chainId !== config.chainId) {
      return { outcome: { kind: "not-due", reason: `This plan is for chain ${plan.chainId}, not ${config.chainId}.` } };
    }
    const read = this.#deps.ledger.read();
    if (read === "unavailable") {
      return { outcome: { kind: "unavailable", reason: "spDEX can't read this browser's record of this plan, so it won't buy." } };
    }
    const ref = { planId, chainId: plan.chainId };
    const entry = entryOf(read, ref);
    if (!entry) return { outcome: { kind: "not-due", reason: "This plan hasn't been started in this browser." } };
    if (entry.halted !== undefined) return { outcome: { kind: "not-due", reason: `This plan has stopped: ${entry.halted}` } };
    if (unsettledRun(entry)) {
      return { outcome: { kind: "not-due", reason: "An earlier buy hasn't been confirmed yet; spDEX won't start another." } };
    }
    if (entry.buysDone >= plan.maxBuys) return { outcome: { kind: "not-due", reason: "This plan has finished." } };
    const tokenIn = tokenFor(plan.sell);
    const tokenOut = tokenFor(plan.buy);
    if (!tokenIn || !tokenOut) return { outcome: { kind: "refused", reason: "This plan uses a token spDEX doesn't list." } };

    const nowMs = this.#now();
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));
    const request = scheduleRequest([plan], [progressOf(entry)], nowSeconds);
    let buy: WireDueBuy | undefined;
    try {
      buy = vetScheduleDecision(request, await this.#deps.engine.dueBuys(request)).accepted[0];
    } catch (error) {
      return { outcome: { kind: "unavailable", reason: messageOf(error) } };
    }
    if (!buy) return { outcome: { kind: "not-due", reason: "This plan's next buy isn't due yet." } };
    return { c: { plan, entry, ref, tokenIn, tokenOut }, buy, generation, nowMs, nowSeconds };
  }

  async #confirmDue(planId: string, options: { acceptDivergenceBps?: number }): Promise<BuyOutcome> {
    const found = await this.#dueFor(planId);
    if ("outcome" in found) return found.outcome;
    const { c, buy, generation, nowMs, nowSeconds } = found;
    if (c.plan.signer !== "wallet") {
      // A vault plan is paused and never gets this far; this does not rely on it.
      return { kind: "refused", reason: "This plan's buys aren't made from this tab." };
    }
    const problem = this.#walletProblem(c.entry);
    if (problem?.kind === "attention") return { kind: "refused", reason: problem.reason };
    if (!this.#ownerWalletLock.tryAcquire()) {
      return { kind: "busy", reason: "Your wallet is busy with another transaction. Try again when it's done." };
    }
    const endsAt = Number(slotOpensAt(c.plan, buy.slot + 1));
    const amountIn = BigInt(buy.amountIn);
    try {
      // The owner's wallet must hold what the buy sells. Otherwise the check
      // below would refuse it anyway (the swap reverts in simulation), but as
      // a Guard refusal rather than the plain "not enough in your wallet" it
      // is. A balance that cannot be read is left to the Guard: unknown is not
      // a shortfall. Fees are the wallet's to judge; it shows them.
      let held: bigint | null = null;
      try {
        held = await balanceOf(this.#rpc, c.plan.sell, c.entry.owner);
      } catch {
        // Unknown; the safety check still runs.
      }
      if (held !== null && held < amountIn) {
        const reason = `not enough ${c.tokenIn.symbol} in your wallet for this buy`;
        this.#skip(c, buy.slot, amountIn, nowMs, endsAt, reason, [RUN_CODES.INSUFFICIENT_FUNDS]);
        return { kind: "skipped", reason, codes: [RUN_CODES.INSUFFICIENT_FUNDS] };
      }

      this.#setBuying(planId, "quoting");
      const quoted = await this.#quote(c, buy, nowMs, nowSeconds);
      if ("state" in quoted) {
        return { kind: "skipped", reason: quoted.reason, codes: [RUN_CODES.QUOTE_FAILED] };
      }
      const judged = judge(quoted.quote, options.acceptDivergenceBps);
      if (judged.kind === "refused") {
        this.#skip(c, buy.slot, amountIn, nowMs, endsAt, judged.reason, judged.codes);
        return { kind: "refused", reason: judged.reason, codes: judged.codes };
      }
      if (judged.kind === "hold") {
        // The owner is at the button: ask them, rather than holding.
        return { kind: "needs-price-consent", needsPriceConsent: judged.divergenceBps, codes: judged.codes };
      }
      // The nonce the buy's first transaction will take, read before the
      // claim: the wallet names a hash only after it has sent, so if this tab
      // loses track of the buy mid-prompt, the owner's account using this
      // nonce is how a later look knows something went out. Unreadable, the
      // buy does not start — nothing is recorded and nothing is lost.
      const ownerNonce = await this.#ownerNonce(c.entry.owner, "pending");
      if (ownerNonce === null) {
        return {
          kind: "unavailable",
          reason: "spDEX couldn't read your wallet's transaction count from your network service, so it didn't start the buy. Try again.",
        };
      }
      const notAfter = latestSignature(quoted.quote, nowSeconds);
      const state = await this.#execute(
        c,
        buy.slot,
        quoted.quote,
        async (onSigned) => this.#deps.walletSender(c.entry.owner, { notAfter, onSigned }),
        generation,
        nowMs,
        { ownerNonce },
      );
      this.#plans = { ...this.#plans, [planId]: state };
      return this.#outcomeFor(c.ref, buy.slot, state);
    } finally {
      this.#ownerWalletLock.release();
      this.#overrides.delete(planId);
      this.#emit();
      void this.tick();
    }
  }

  /** What the record says became of a window's buy. */
  #outcomeFor(ref: EntryRef, slot: number, state: PlanState): BuyOutcome {
    const read = this.#deps.ledger.read();
    const run =
      read === "unavailable"
        ? undefined
        : [...(entryOf(read, ref)?.runs ?? [])].reverse().find((r) => r.slot === slot && !r.codes?.includes(RUN_CODES.MISSED));
    if (!run) {
      return { kind: "unavailable", reason: state.kind === "attention" ? state.reason : "nothing was recorded for this buy" };
    }
    const codes = run.codes ?? [];
    switch (run.status) {
      case "confirmed":
        return {
          kind: "bought",
          partial: codes.includes(RUN_CODES.PARTIAL),
          ...(run.amountOut === undefined ? {} : { amountOut: BigInt(run.amountOut) }),
        };
      case "pending":
      case "unknown":
        return { kind: "unknown", reason: run.reason ?? "not confirmed by the network yet", codes };
      case "held":
        // Only an old autopilot plan's record holds one, and a claim for its
        // window replaces it; were one still there, nothing was bought.
        return { kind: "skipped", reason: run.reason ?? "held", codes };
      case "declined":
        return { kind: "declined", reason: run.reason ?? "declined in your wallet", codes };
      case "failed":
        return { kind: "failed", reason: run.reason ?? "the buy failed", codes };
      case "skipped":
        // "refused" when the Guard said no; any other skip is the host's.
        return { kind: codes.some((code) => !HOST_CODES.has(code)) ? "refused" : "skipped", reason: run.reason ?? "skipped", codes };
    }
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

interface Receipt {
  status?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  logs?: { address?: string; topics?: string[]; data?: string }[];
}

function succeededReceipt(receipt: Receipt): boolean {
  // No status field predates Byzantium; treated as success, as confirmTransaction does.
  return receipt.status === undefined || BigInt(receipt.status) !== 0n;
}

function feePaid(receipt: Receipt | null): bigint | null {
  if (!receipt || !receipt.gasUsed || !receipt.effectiveGasPrice) return null;
  try {
    return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  } catch {
    return null;
  }
}

/** Σ Transfer(token → owner) across receipts, or null if a receipt is missing. */
export function transfersTo(receipts: readonly (Receipt | null)[], token: string, owner: string): bigint | null {
  const want = token.toLowerCase();
  const to = owner.toLowerCase().replace(/^0x/, "");
  let total = 0n;
  for (const receipt of receipts) {
    if (!receipt) return null;
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== want) continue;
      const topics = log.topics ?? [];
      if (topics[0]?.toLowerCase() !== TOPICS.transfer) continue;
      if (!topics[2] || topics[2].toLowerCase().slice(-40) !== to) continue;
      try {
        total += BigInt(log.data ?? "0x0");
      } catch {
        return null;
      }
    }
  }
  return total;
}

/** A stopped plan, and why: failures in a row, or the reason it was stopped for. */
function haltedState(entry: DcaLedgerEntry): PlanState {
  return attention(
    "halted",
    entry.consecutiveFailures >= HALT_AFTER_FAILURES
      ? `Stopped after ${entry.consecutiveFailures} buys in a row failed. The last one: ${entry.halted}`
      : `Stopped: ${entry.halted}`,
  );
}

/** Why a plan with a buy in flight waits: the hash to look for, or why there is none. */
function unsettledState(open: DcaRun): PlanState {
  const hash = open.hashes[open.hashes.length - 1];
  if (hash !== undefined) {
    return attention(
      "unsettled",
      `A buy hasn't been confirmed by the network yet (${hash}). spDEX won't start another until it has.`,
    );
  }
  if (open.status === "unknown" && open.reason !== undefined) {
    return attention(
      "unsettled",
      `Your wallet didn't say whether it sent a buy (${open.reason}). spDEX won't start another until it knows — ` +
        "at the latest once that buy's deadline has passed. Check your wallet's activity.",
    );
  }
  return attention(
    "unsettled",
    "spDEX closed in the middle of a buy. It is waiting to be sure nothing was sent before it buys again.",
  );
}

/** The quote's deadline: the latest any of its legs may execute, unix seconds. */
function deadlineOf(quote: QuoteResult): number {
  return quote.legs.reduce((max, leg) => {
    const d = Number(leg.plan.intent.deadline);
    return d > max ? d : max;
  }, 0);
}

/**
 * The latest moment a buy's transaction may be signed: its deadline, less
 * `LATE_SIGNATURE_MARGIN_SECONDS` or a quarter of the time the quote allows,
 * whichever is shorter — so a short deadline setting (30 s is allowed) still
 * leaves time to sign.
 */
function latestSignature(quote: QuoteResult, quotedAt: bigint): number {
  const deadline = deadlineOf(quote);
  const margin = Math.min(LATE_SIGNATURE_MARGIN_SECONDS, Math.floor((deadline - Number(quotedAt)) / 4));
  return deadline - Math.max(0, margin);
}

/**
 * What to do with a scheduled buy's verdict.
 *
 * Refused if not signable. Held if it carries any warning — unless every
 * warning is the oracle's and the owner already accepted a divergence at
 * least this large. Otherwise, go.
 */
export function judge(
  quote: QuoteResult,
  acceptedDivergenceBps?: number,
):
  | { kind: "go" }
  | { kind: "refused"; reason: string; codes: string[] }
  | { kind: "hold"; reason: string; codes: string[]; divergenceBps: number } {
  const verdict = quote.verdict;
  if (!verdict.signable || verdict.level !== "verified") {
    const violations = verdict.violations.length > 0 ? verdict.violations : verdict.warnings;
    return {
      kind: "refused",
      reason: violations.map((v) => v.message).join("; ") || "spDEX refused this buy",
      codes: unique(violations.map((v) => v.code)),
    };
  }
  if (verdict.warnings.length === 0) return { kind: "go" };
  const divergenceBps = maxDivergence(verdict.warnings);
  const onlyOracle = verdict.warnings.every((w) => w.code === "ORACLE_DIVERGENCE");
  if (onlyOracle && acceptedDivergenceBps !== undefined && divergenceBps <= acceptedDivergenceBps) {
    return { kind: "go" };
  }
  return {
    kind: "hold",
    reason: verdict.warnings.map((w) => w.message).join("; "),
    codes: unique(verdict.warnings.map((w) => w.code)),
    divergenceBps,
  };
}

function maxDivergence(warnings: readonly GuardViolation[]): number {
  let max = 0;
  for (const warning of warnings) {
    const raw = warning.detail?.["divergenceBps"];
    const value = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
