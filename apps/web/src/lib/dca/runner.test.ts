/**
 * The runner, driven end to end with fakes for everything outside it: the
 * engine (the real scheduler module, a scripted quote), the chain, the
 * owner's wallet, Web Locks and the clock. The ledger is the real one over an
 * in-memory storage, so every assertion about what was recorded is about the
 * record the app would read back.
 *
 * Every plan here is one its owner confirms; the timer only notices. Records
 * an autopilot plan left before config version 8 (signed by its spending
 * wallet) are seeded where what the runner does with one is the point.
 */

import { describe, expect, it, vi } from "vitest";
import { signAsAsked } from "../signedTx.fixture.js";
import { NATIVE_TOKEN, TOKENS, TOPICS, transactionHash } from "@spdex/chain";
import { addDcaPlan, recommendedConfig } from "@spdex/config";
import type { DcaPlan, GuardVerdict, SpdexConfig, SubmitterConfig, TxPlan, WireScheduleRequest } from "@spdex/core";
import schedulerModule from "../../../../../modules/scheduler-dca/index.mjs";
import type { QuoteResult, ScheduledQuoteInput } from "../engine.js";
import type { TxSender } from "../execute.js";
import { OwnerWalletLock } from "../execute.js";
import { walletSender } from "../senders.js";
import { LateSignature, RawTransactionRejected } from "../submit.js";
import type { Eip1193Provider } from "../wallet.js";
import {
  LEDGER_KEY,
  LedgerStore,
  RUN_CODES,
  entryOf,
  startEntry,
  type DcaLedger,
  type DcaLedgerEntry,
  type StorageLike,
} from "./ledger.js";
import {
  DcaRunner,
  LATE_SIGNATURE_MARGIN_SECONDS,
  LEASE_KEY,
  RETRY_MS,
  readLease,
  type LockManagerLike,
  type PlanState,
} from "./runner.js";

const CHAIN = 690069;
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const STRANGER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;
/** An old autopilot plan's spending wallet, as a record from before config version 8 names it. */
const SPENDING = "0x5a1e00000000000000000000000000000000beef" as const;
const ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as const;
const SPX = TOKENS.SPX.address;
const HOUR = 3600;
/** A whole hour, so windows line up with round numbers. */
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR);
const AMOUNT = 10n ** 16n;
const GWEI = 1_000_000_000n;

const VERIFIED: GuardVerdict = { level: "verified", signable: true, violations: [], warnings: [] };
const REJECTED: GuardVerdict = {
  level: "rejected",
  signable: false,
  violations: [{ code: "MIN_OUT_NOT_MET", message: "the swap would deliver less than its floor" }],
  warnings: [],
};
const divergent = (bps: number): GuardVerdict => ({
  level: "verified",
  signable: true,
  violations: [],
  warnings: [{ code: "ORACLE_DIVERGENCE", message: `differs by ${bps} bps`, detail: { divergenceBps: String(bps) } }],
});

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "spx-daily",
    paused: false,
    chainId: CHAIN,
    sell: NATIVE_TOKEN,
    buy: SPX,
    amountPerBuy: AMOUNT.toString(),
    intervalSeconds: HOUR,
    maxBuys: 3,
    startAt: T0,
    signer: "wallet",
    ...overrides,
  };
}

function configWith(p: DcaPlan, submitter?: SubmitterConfig): SpdexConfig {
  const base: SpdexConfig = {
    ...recommendedConfig(),
    chainId: CHAIN,
    rpc: { url: "http://127.0.0.1:8545", source: "user" },
    ...(submitter ? { submitter } : {}),
  };
  const added = addDcaPlan(base, p);
  if (!added.ok) throw new Error(added.error);
  return added.config;
}

/** Web Locks, in memory, shared between "tabs" that share one instance. */
class FakeLocks implements LockManagerLike {
  requests = 0;
  #held = new Set<string>();
  #queue = new Map<string, (() => void)[]>();

  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown> {
    this.requests += 1;
    const run = async () => {
      this.#held.add(name);
      try {
        return await callback({ name });
      } finally {
        this.#held.delete(name);
        this.#queue.get(name)?.shift()?.();
      }
    };
    if (!this.#held.has(name)) return run();
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const waiting = () => void run().then(resolve, reject);
      const queue = this.#queue.get(name) ?? [];
      queue.push(waiting);
      this.#queue.set(name, queue);
      options.signal?.addEventListener("abort", () => {
        const q = this.#queue.get(name) ?? [];
        const index = q.indexOf(waiting);
        if (index >= 0) q.splice(index, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
}

function memoryStorage(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const pad = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const hashN = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

interface Harness {
  runner: DcaRunner;
  store: LedgerStore;
  storage: ReturnType<typeof memoryStorage>;
  /** Device time, ms. */
  clock: { now: number };
  /** The chain's clock, as the latest block says: device time plus `offset` seconds (null: no timestamp). */
  chain: { offset: number | null };
  /** Transaction counts by address: mined (`latest`) and with the pool (`pending`). */
  nonces: Map<string, { latest: number; pending: number }>;
  /** Every RPC method asked, in order. */
  asked: string[];
  /** Answers to replace, by method; an Error is thrown. */
  rpcOverrides: Map<string, unknown>;
  entryFor: (planId: string) => DcaLedgerEntry;
  quotes: ScheduledQuoteInput[];
  sent: { kind: string; to: string; at: number }[];
  receipts: Map<string, unknown>;
  balances: Map<string, bigint>;
  fees: { base: bigint; tip: bigint };
  verdicts: GuardVerdict[];
  locks: FakeLocks;
  states: () => Record<string, PlanState>;
  entry: () => DcaLedgerEntry;
  intervals: { live: number };
  setAccount: (account: `0x${string}` | null) => void;
  sendBehaviour: {
    /** An error for the next send to throw, or undefined for it to go through. */
    fail?: () => unknown;
    noReceipt?: boolean;
    delivered?: bigint;
    /** Milliseconds each send takes, by the clock (a slow confirmation). */
    takesMs?: number;
    /** Receipt to give each hash instead of a success. */
    receipt?: (hash: string, call: { to: string; value: bigint }) => unknown;
  };
  /** What each wallet sender was built with. */
  walletOptions: { notAfter: number; onSigned: (hash: `0x${string}`) => Promise<void> }[];
  /** Every distinct `buying` step the snapshots showed, in order. */
  buyingSteps: string[];
}

function harness(options: {
  plan?: DcaPlan;
  /** Several plans at once (each started the same way); overrides `plan`. */
  plans?: DcaPlan[];
  /**
   * How each plan's record starts: bound to the owner (the default), not at
   * all, or as an autopilot plan's from before config version 8, signed by
   * its spending wallet.
   */
  start?: "none" | "wallet" | "old-autopilot";
  /** Web Locks for the ledger store (none by default). */
  ledgerLocks?: FakeLocks;
  dueBuys?: (request: WireScheduleRequest) => Promise<unknown>;
  quote?: (input: ScheduledQuoteInput) => Promise<QuoteResult>;
  /** The chain the runner's config is on, when not the plan's. */
  configChainId?: number;
  locks?: FakeLocks | null;
  storage?: ReturnType<typeof memoryStorage>;
  walletSender?: (
    account: `0x${string}`,
    options: { notAfter: number; onSigned: (hash: `0x${string}`) => Promise<void> },
  ) => TxSender;
  submitter?: SubmitterConfig;
  confirmTimeoutMs?: number;
  seed?: (ledger: DcaLedger) => DcaLedger;
  ownerWalletLock?: OwnerWalletLock;
  /** When the entry was started here, ms. */
  startedAt?: number;
  /** Where the lease is kept; none by default. */
  lease?: StorageLike;
  tabId?: string;
} = {}): Harness {
  const all = options.plans ?? [options.plan ?? plan()];
  const p = all[0]!;
  let config = configWith(p, options.submitter);
  for (const other of all.slice(1)) {
    const added = addDcaPlan(config, other);
    if (!added.ok) throw new Error(added.error);
    config = added.config;
  }
  if (options.configChainId !== undefined) config = { ...config, chainId: options.configChainId };
  const storage = options.storage ?? memoryStorage();
  const store = new LedgerStore(storage, { events: null, locks: options.ledgerLocks ?? null });
  const clock = { now: T0 * 1000 + 60_000 };
  const chain: Harness["chain"] = { offset: 0 };
  const nonces: Harness["nonces"] = new Map();
  const asked: string[] = [];
  const rpcOverrides = new Map<string, unknown>();
  const quotes: ScheduledQuoteInput[] = [];
  const sent: { kind: string; to: string; at: number }[] = [];
  const receipts = new Map<string, unknown>();
  const balances = new Map<string, bigint>([[OWNER, 10n ** 18n]]);
  const walletOptions: Harness["walletOptions"] = [];
  const fees = { base: GWEI, tip: GWEI };
  const verdicts: GuardVerdict[] = [];
  const sendBehaviour: Harness["sendBehaviour"] = {};
  let account: `0x${string}` | null = OWNER;
  let hashes = 0;

  const start = options.start ?? "wallet";
  if (start !== "none") {
    for (const each of all) {
      store.update((l) =>
        startEntry(l, {
          planId: each.id,
          chainId: CHAIN,
          owner: OWNER,
          signer: start === "old-autopilot" ? SPENDING : OWNER,
          at: options.startedAt ?? clock.now,
        }),
      );
    }
  }
  if (options.seed) store.update(options.seed);

  const hexOf = (v: bigint | number) => `0x${v.toString(16)}`;
  const rpc = async (method: string, params: unknown[]) => {
    asked.push(method);
    if (rpcOverrides.has(method)) {
      const answer = rpcOverrides.get(method);
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? (answer as (params: unknown[]) => unknown)(params) : answer;
    }
    switch (method) {
      case "eth_getBalance":
        return hexOf(balances.get((params[0] as string).toLowerCase()) ?? 0n);
      case "eth_call":
        return `0x${"0".repeat(64)}`;
      case "eth_getBlockByNumber":
        return {
          baseFeePerGas: hexOf(fees.base),
          ...(chain.offset === null ? {} : { timestamp: hexOf(Math.floor(clock.now / 1000) + chain.offset) }),
        };
      case "eth_maxPriorityFeePerGas":
        return hexOf(fees.tip);
      case "eth_getTransactionReceipt":
        return receipts.get(params[0] as string) ?? null;
      case "eth_getTransactionCount": {
        const count = nonces.get((params[0] as string).toLowerCase()) ?? { latest: 0, pending: 0 };
        return hexOf(params[1] === "latest" ? count.latest : count.pending);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };

  const successReceipt = (delivered: bigint) => ({
    status: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: [{ address: SPX, topics: [TOPICS.transfer, pad(ROUTER), pad(OWNER)], data: `0x${delivered.toString(16)}` }],
  });

  // The owner's wallet. Sending privately, it is held to the latest moment
  // a signature may come back, as the real one is (`walletSender`).
  const privately = options.submitter?.mode === "private";
  const fakeSender = (address: `0x${string}`, notAfter?: number): TxSender => ({
    account: address,
    kind: "wallet",
    confirm: { rpc, timeoutMs: options.confirmTimeoutMs ?? 2_000 },
    async send(call) {
      const failure = sendBehaviour.fail?.();
      if (failure !== undefined) throw failure;
      const at = Math.floor(clock.now / 1000);
      if (privately && notAfter !== undefined && at > notAfter) throw new LateSignature(notAfter, at);
      const hash = hashN(++hashes);
      sent.push({ kind: "wallet", to: call.to, at });
      if (sendBehaviour.takesMs) clock.now += sendBehaviour.takesMs;
      if (!sendBehaviour.noReceipt) {
        receipts.set(
          hash,
          sendBehaviour.receipt?.(hash, call) ?? successReceipt(sendBehaviour.delivered ?? 5_000_000n),
        );
      }
      return { hash, via: privately ? "private" : "wallet" };
    },
  });

  const intervals = { live: 0 };
  const locks = options.locks === undefined ? new FakeLocks() : options.locks;
  let snapshot: Record<string, PlanState> = {};
  const buyingSteps: string[] = [];

  const runner = new DcaRunner({
    engine: {
      rpc,
      dueBuys: (request: WireScheduleRequest) =>
        (options.dueBuys ? options.dueBuys(request) : schedulerModule.dueBuys(request)) as ReturnType<
          typeof schedulerModule.dueBuys
        >,
      quoteScheduled: async (input: ScheduledQuoteInput): Promise<QuoteResult> => {
        quotes.push(input);
        if (options.quote) return options.quote(input);
        input.onCheck?.();
        const verdict = verdicts.shift() ?? VERIFIED;
        const txPlan: TxPlan = {
          version: 1,
          intent: {
            version: 1,
            chainId: CHAIN,
            account: input.progress.signer,
            recipient: input.progress.owner,
            tokenIn: input.tokenIn.address,
            tokenOut: input.tokenOut.address,
            maxAmountIn: input.amountIn,
            minAmountOut: 1n,
            deadline: (input.nowSeconds ?? 0n) + 1_200n,
            nonce: "0x01",
          },
          approvals: [],
          calls: [{ to: ROUTER, data: "0x01", value: input.amountIn }],
          meta: { venueId: "venue-uniswap-v2", poolIds: [], quotedAmountOut: 1n, gasEstimate: 1n },
        };
        return {
          route: { amountIn: input.amountIn, amountOut: 1n, legs: [] } as unknown as QuoteResult["route"],
          pools: [],
          legs: [{ poolId: "0xpool", venueId: "venue-uniswap-v2", shareBps: 10_000, amountIn: input.amountIn, amountOut: 1n, plan: txPlan, verdict }],
          verdict,
          minAmountOut: 1n,
          previewOnly: false,
        };
      },
    },
    config,
    ledger: store,
    account: () => account,
    walletChainOk: () => true,
    walletSender:
      options.walletSender ??
      ((a, o) => {
        walletOptions.push(o);
        return fakeSender(a, o.notAfter);
      }),
    now: () => clock.now,
    locks,
    ...(options.ownerWalletLock ? { ownerWalletLock: options.ownerWalletLock } : {}),
    timers: {
      setInterval: () => {
        intervals.live += 1;
        return intervals.live;
      },
      clearInterval: () => {
        intervals.live -= 1;
      },
    },
    visibility: null,
    log: () => {},
    onChange: (s) => {
      snapshot = s.plans;
      const current = s.plans[p.id];
      if (current?.kind === "buying" && current.step && buyingSteps[buyingSteps.length - 1] !== current.step) {
        buyingSteps.push(current.step);
      }
    },
    lease: options.lease ?? null,
    ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
  });

  return {
    runner,
    store,
    storage,
    clock,
    chain,
    nonces,
    asked,
    rpcOverrides,
    entryFor: (planId) => {
      const read = store.read();
      if (read === "unavailable") throw new Error("unavailable");
      const found = entryOf(read, { planId, chainId: CHAIN });
      if (!found) throw new Error("no entry");
      return found;
    },
    quotes,
    sent,
    receipts,
    balances,
    fees,
    verdicts,
    locks: locks ?? new FakeLocks(),
    states: () => ({ ...snapshot, ...runner.snapshot().plans }),
    entry: () => {
      const read = store.read();
      if (read === "unavailable") throw new Error("unavailable");
      const found = entryOf(read, { planId: p.id, chainId: CHAIN });
      if (!found) throw new Error("no entry");
      return found;
    },
    intervals,
    setAccount: (a) => {
      account = a;
    },
    sendBehaviour,
    walletOptions,
    buyingSteps,
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function leading(h: Harness): Promise<void> {
  h.runner.start();
  await settled();
  expect(h.runner.snapshot().leader).toBe("this-tab");
  await h.runner.tick();
}

const state = (h: Harness) => h.runner.snapshot().plans["spx-daily"];

describe("DcaRunner — a buy, from due to settled", () => {
  it("due → Confirm → claim → execute → settle, delivered measured from the owner's Transfer logs", async () => {
    const h = harness();
    await leading(h);
    expect(state(h)).toEqual({ kind: "due", slot: 0, endsAt: T0 + HOUR });
    expect(h.quotes).toHaveLength(0);

    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought", amountOut: 5_000_000n, partial: false });
    expect(h.quotes).toHaveLength(1);
    expect(h.quotes[0]!.progress).toMatchObject({ signer: OWNER, owner: OWNER, committed: 0n, lastSlot: null });
    expect(h.quotes[0]!.slot).toBe(0);
    expect(h.sent).toEqual([{ kind: "wallet", to: ROUTER, at: Math.floor(h.clock.now / 1000) }]);
    // What a status line can say at each moment, in order.
    expect(h.buyingSteps).toEqual(["quoting", "checking", "swapping", "confirming", "measuring"]);
    const e = h.entry();
    expect(e).toMatchObject({ buysDone: 1, committed: AMOUNT.toString(), lastSlot: 0, consecutiveFailures: 0 });
    expect(e.runs.at(-1)).toMatchObject({ status: "confirmed", amountOut: "5000000", via: "wallet", steps: ["swap"] });
    await h.runner.tick();
    expect(state(h)).toEqual({ kind: "waiting", nextAt: T0 + HOUR });

    // Nothing more in the same window, however often it looks or is pressed.
    await h.runner.tick();
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "not-due" });
    expect(h.quotes).toHaveLength(1);
    h.runner.stop();
  });

  it("a plan started here late does not report the windows before it as missed", async () => {
    const h = harness({ plan: plan({ maxBuys: 10 }), startedAt: (T0 + 3 * HOUR) * 1000 + 5 });
    h.clock.now = (T0 + 3 * HOUR) * 1000 + 1_000;
    await leading(h);
    expect(h.entry().runs.filter((r) => r.codes?.includes(RUN_CODES.MISSED))).toHaveLength(0);
    expect(state(h)).toMatchObject({ kind: "due", slot: 3 });
    h.runner.stop();
  });

  it("a refused buy is skipped without using its window, counts once per window, and three windows in a row halt the plan", async () => {
    const h = harness({ plan: plan({ maxBuys: 10 }) });
    h.verdicts.push(REJECTED, REJECTED);
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "refused", codes: ["MIN_OUT_NOT_MET"] });
    expect(h.entry().runs.at(-1)).toMatchObject({ status: "skipped", codes: ["MIN_OUT_NOT_MET"] });
    expect(h.entry().lastSlot).toBeNull();
    // Pressed again in the same window: still one failure.
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "refused" });
    expect(h.entry().consecutiveFailures).toBe(1);

    h.verdicts.push(REJECTED, REJECTED);
    h.clock.now = (T0 + HOUR) * 1000 + 1_000;
    await h.runner.tick();
    await h.runner.confirmDue("spx-daily");
    h.clock.now = (T0 + 2 * HOUR) * 1000 + 1_000;
    await h.runner.tick();
    await h.runner.confirmDue("spx-daily");
    expect(h.entry().consecutiveFailures).toBe(3);
    await h.runner.tick();
    expect(state(h)).toMatchObject({ kind: "attention", code: "halted" });

    const quotesBefore = h.quotes.length;
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "not-due" });
    expect(h.quotes).toHaveLength(quotesBefore);
    expect(h.sent).toHaveLength(0);
    h.runner.stop();
  });

  it("a timeout leaves the buy unknown, blocks the next, and is settled from the chain on a later look", async () => {
    const h = harness({ confirmTimeoutMs: 300 });
    h.sendBehaviour.noReceipt = true;
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "unknown" });
    expect(h.entry().runs.at(-1)).toMatchObject({ status: "unknown", hashes: [hashN(1)] });
    expect(h.entry().committed).toBe(AMOUNT.toString());
    expect(state(h)).toMatchObject({ kind: "attention", code: "unsettled" });

    // Still inside the quote's deadline and still no receipt: nothing new.
    h.clock.now += RETRY_MS;
    await h.runner.tick();
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "not-due" });
    expect(h.quotes).toHaveLength(1);
    expect(h.entry().runs.at(-1)!.status).toBe("unknown");

    // The receipt arrives; the buy settles, measured.
    h.receipts.set(hashN(1), {
      status: "0x1",
      logs: [{ address: SPX, topics: [TOPICS.transfer, pad(ROUTER), pad(OWNER)], data: "0x2a" }],
    });
    await h.runner.tick();
    expect(h.entry().runs.find((r) => r.slot === 0)).toMatchObject({ status: "confirmed", amountOut: "42" });
    expect(h.entry()).toMatchObject({ buysDone: 1, committed: AMOUNT.toString() });

    // And the plan carries on in the next window.
    h.sendBehaviour.noReceipt = false;
    h.clock.now = (T0 + HOUR) * 1000 + 1_000;
    await h.runner.tick();
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought" });
    expect(h.entry().buysDone).toBe(2);
    h.runner.stop();
  });

  it("an unknown buy whose deadline has passed can no longer deliver, and is released", async () => {
    const h = harness({ confirmTimeoutMs: 300 });
    h.sendBehaviour.noReceipt = true;
    await leading(h);
    await h.runner.confirmDue("spx-daily");
    expect(h.entry().runs.at(-1)!.status).toBe("unknown");

    // Deadline (quote + 1,200 s) plus the grace period, and still nothing.
    h.clock.now += (1_200 + 601) * 1000;
    h.sendBehaviour.noReceipt = false;
    await h.runner.tick();
    const released = h.entry().runs.find((r) => r.slot === 0)!;
    expect(released).toMatchObject({ status: "failed", codes: [RUN_CODES.INTERRUPTED] });
    expect(h.entry()).toMatchObject({ committed: "0", buysDone: 0, consecutiveFailures: 0, lastSlot: 0 });
    h.runner.stop();
  });

  it("a buy interrupted by a closed tab is settled from its receipts, and marked interrupted", async () => {
    const h = harness({
      seed: (l) => {
        const key = `${CHAIN}:spx-daily`;
        const entry = l.entries[key]!;
        return {
          version: 1,
          entries: {
            [key]: {
              ...entry,
              committed: AMOUNT.toString(),
              lastSlot: 0,
              runs: [{ slot: 0, at: T0 * 1000, status: "pending", amountIn: AMOUNT.toString(), hashes: [hashN(99)], steps: ["swap"], calls: 1 }],
            },
          },
        };
      },
    });
    h.receipts.set(hashN(99), { status: "0x1", logs: [] });
    await leading(h);
    expect(h.entry().runs[0]).toMatchObject({ status: "confirmed", codes: [RUN_CODES.INTERRUPTED] });
    // No Transfer log to the owner: delivery unmeasured, not zero.
    expect(h.entry().runs[0]!.amountOut).toBeUndefined();
    expect(h.entry().buysDone).toBe(1);
    h.runner.stop();
  });

  it("a transaction the relay refuses is skipped as relay-failed, never re-sent publicly, and counts", async () => {
    const relay: SubmitterConfig = { mode: "private", url: "https://relay.invalid/rpc" };
    const h = harness({ submitter: relay });
    h.sendBehaviour.fail = () => new RawTransactionRejected("nonce too low");
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "skipped", codes: [RUN_CODES.RELAY_FAILED] });
    const run = h.entry().runs.at(-1)!;
    expect(run).toMatchObject({ status: "skipped", codes: [RUN_CODES.RELAY_FAILED] });
    expect(run.reason).toMatch(/private relay didn't take it \(nonce too low\)/);
    expect(h.entry()).toMatchObject({ committed: "0", lastSlot: 0, consecutiveFailures: 1, buysDone: 0 });
    expect(h.sent).toHaveLength(0);
    h.runner.stop();
  });

  it("buy times that passed unseen become one missed entry, never a catch-up burst", async () => {
    const h = harness({ plan: plan({ maxBuys: 10 }) });
    await leading(h);
    await h.runner.confirmDue("spx-daily");
    expect(h.entry().buysDone).toBe(1);
    h.clock.now = (T0 + 5 * HOUR) * 1000 + 1_000;
    await h.runner.tick();
    const missed = h.entry().runs.find((r) => r.codes?.includes(RUN_CODES.MISSED));
    expect(missed).toMatchObject({ missed: 4, slot: 4 });
    // One buy is due now, for window 5; nothing for 1–4.
    expect(state(h)).toMatchObject({ kind: "due", slot: 5 });
    await h.runner.confirmDue("spx-daily");
    expect(h.sent).toHaveLength(2);
    expect(h.entry().lastSlot).toBe(5);
    h.runner.stop();
  });

  it("a paused plan misses nothing while spDEX is closed, first look or later", async () => {
    // Seen paused, then the tab closed for five buy times.
    const h = harness({ plan: plan({ maxBuys: 10, paused: true }) });
    await leading(h);
    expect(state(h)).toEqual({ kind: "paused" });
    h.clock.now = (T0 + 5 * HOUR) * 1000 + 1_000;
    await h.runner.tick();
    expect(h.entry().runs).toEqual([]);
    expect(h.sent).toHaveLength(0);
    h.runner.stop();

    // Started here long ago, first looked at while paused.
    const late = harness({ plan: plan({ maxBuys: 10, paused: true }), startedAt: T0 * 1000 });
    late.clock.now = (T0 + 3 * HOUR) * 1000 + 1_000;
    await leading(late);
    expect(late.entry().runs).toEqual([]);
    late.runner.stop();
  });
});

describe("DcaRunner — what it refuses to do", () => {
  it("a second tab does not lead, and buys nothing; it takes over when the first stops", async () => {
    const locks = new FakeLocks();
    const storage = memoryStorage();
    const first = harness({ locks, storage });
    await leading(first);
    await first.runner.confirmDue("spx-daily");
    expect(first.sent).toHaveLength(1);

    const second = harness({ locks, storage, start: "none" });
    second.clock.now = (T0 + HOUR) * 1000 + 1_000;
    second.runner.start();
    await settled();
    expect(second.runner.snapshot().leader).toBe("other-tab");
    await second.runner.tick();
    expect(second.quotes).toHaveLength(0);
    expect(second.sent).toHaveLength(0);

    first.runner.stop();
    await settled();
    expect(second.runner.snapshot().leader).toBe("this-tab");
    await second.runner.tick();
    expect(await second.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought" });
    expect(second.sent).toHaveLength(1);
    second.runner.stop();
  });

  it("a runner replaced in the same page waits for the old one's lock, and does not blame another tab", async () => {
    const locks = new FakeLocks();
    const storage = memoryStorage();
    const lease = memoryStorage();
    const old = harness({ locks, storage, lease, tabId: "abcd" });
    await leading(old);

    const next = harness({ locks, storage, lease, tabId: "abcd", start: "none" });
    next.runner.start();
    await settled();
    await next.runner.tick();
    expect(next.runner.snapshot()).toMatchObject({ leader: "other-tab", lease: { tabId: "abcd", thisTab: true } });
    expect(await next.runner.skipDue("spx-daily")).toEqual({
      kind: "unavailable",
      reason: "This tab is still finishing another auto-buy. Try again in a moment.",
    });

    old.runner.stop();
    await settled();
    expect(next.runner.snapshot().leader).toBe("this-tab");
    next.runner.stop();
  });

  it("the leader writes a heartbeat lease every look; another tab reads it and never writes it", async () => {
    const locks = new FakeLocks();
    const storage = memoryStorage();
    const lease = memoryStorage();
    const first = harness({ locks, storage, lease, tabId: "aaaa" });
    await leading(first);
    expect(readLease(lease)).toEqual({ tabId: "aaaa", lastTick: first.clock.now });
    expect(first.runner.snapshot().lease).toEqual({ tabId: "aaaa", lastTick: first.clock.now, thisTab: true });

    const second = harness({ locks, storage, lease, tabId: "bbbb", start: "none" });
    second.clock.now = first.clock.now + 30_000;
    second.runner.start();
    await settled();
    await second.runner.tick();
    expect(second.runner.snapshot().leader).toBe("other-tab");
    expect(second.runner.snapshot().lease).toEqual({ tabId: "aaaa", lastTick: first.clock.now, thisTab: false });
    expect(readLease(lease)?.tabId).toBe("aaaa");

    first.clock.now += 60_000;
    await first.runner.tick();
    expect(readLease(lease)?.lastTick).toBe(first.clock.now);

    // A lease that is not what this code writes reads as none, never as a guess.
    lease.data[LEASE_KEY] = "{broken";
    expect(readLease(lease)).toBeNull();
    lease.data[LEASE_KEY] = JSON.stringify({ tabId: "aaaa", lastTick: -1 });
    expect(readLease(lease)).toBeNull();
    expect(readLease(null)).toBeNull();
    first.runner.stop();
    second.runner.stop();
  });

  it("without Web Locks it refuses to run and says why", async () => {
    const h = harness({ locks: null });
    h.runner.start();
    await settled();
    await h.runner.tick();
    expect(h.runner.snapshot().leader).toBe("unsupported");
    expect(h.quotes).toHaveLength(0);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "unavailable" });
    h.runner.stop();
  });

  it("an active plan with no record here is not-started-here, and is not bought", async () => {
    const h = harness({ start: "none" });
    await leading(h);
    expect(state(h)).toEqual({ kind: "not-started-here" });
    expect(h.quotes).toHaveLength(0);
    h.runner.stop();
  });

  it("an unreadable ledger buys nothing and says so", async () => {
    const storage = memoryStorage();
    storage.data[LEDGER_KEY] = "{corrupt";
    const h = harness({ storage, start: "none" });
    await leading(h);
    expect(h.runner.snapshot().ledger).toBe("unavailable");
    expect(state(h)).toMatchObject({ kind: "attention", code: "ledger-unavailable" });
    expect(h.quotes).toHaveLength(0);
    expect(storage.data[LEDGER_KEY]).toBe("{corrupt");
    h.runner.stop();
  });

  it("StrictMode's double start is idempotent, and start-stop-start ends leading with one interval", async () => {
    const h = harness();
    h.runner.start();
    h.runner.start();
    await settled();
    expect(h.locks.requests).toBe(1);
    expect(h.intervals.live).toBe(1);
    h.runner.stop();
    h.runner.start();
    await settled();
    expect(h.intervals.live).toBe(1);
    expect(h.runner.snapshot().leader).toBe("this-tab");
    await h.runner.tick();
    expect(state(h)).toMatchObject({ kind: "due", slot: 0 });
    h.runner.stop();
    expect(h.runner.snapshot().leader).toBe("stopped");
  });
});

describe("DcaRunner — plans wait for the owner", () => {
  const walletPlan = () => plan();

  it("a due wallet buy is never started by the timer; Confirm makes it", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    await leading(h);
    expect(state(h)).toEqual({ kind: "due", slot: 0, endsAt: T0 + HOUR });
    expect(h.quotes).toHaveLength(0);
    expect(h.sent).toHaveLength(0);

    const outcome = await h.runner.confirmDue("spx-daily");
    expect(outcome).toMatchObject({ kind: "bought", amountOut: 5_000_000n });
    expect(h.sent.map(({ kind, to }) => ({ kind, to }))).toEqual([{ kind: "wallet", to: ROUTER }]);
    expect(h.quotes[0]!.progress).toMatchObject({ signer: OWNER, owner: OWNER });
    h.runner.stop();
  });

  it("the wallet sender is told the latest a private signature may come back", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    await leading(h);
    await h.runner.confirmDue("spx-daily");
    // The scripted quote's deadline is the moment it was quoted plus 1,200 s.
    const quotedAt = Number(h.quotes[0]!.nowSeconds);
    expect(h.walletOptions.map((o) => o.notAfter)).toEqual([quotedAt + 1_200 - LATE_SIGNATURE_MARGIN_SECONDS]);
    h.runner.stop();
  });

  it("a signature that came back too late is skipped, not sent, and not a failure", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.sendBehaviour.fail = () => new LateSignature(100, 200);
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "skipped", codes: [RUN_CODES.LATE_SIGNATURE] });
    expect(h.entry()).toMatchObject({ committed: "0", lastSlot: 0, consecutiveFailures: 0, buysDone: 0 });
    expect(h.sent).toHaveLength(0);
    h.runner.stop();
  });

  it("not enough in the owner's wallet is said plainly before quoting, and leaves the window open", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.balances.set(OWNER, AMOUNT - 1n);
    await leading(h);
    const outcome = await h.runner.confirmDue("spx-daily");
    expect(outcome).toMatchObject({ kind: "skipped", codes: [RUN_CODES.INSUFFICIENT_FUNDS] });
    expect(h.quotes).toHaveLength(0);
    expect(h.entry().lastSlot).toBeNull();
    expect(h.entry().runs.at(-1)).toMatchObject({ status: "skipped", codes: [RUN_CODES.INSUFFICIENT_FUNDS] });

    // Topped up in the same window: the buy goes ahead.
    h.balances.set(OWNER, 10n ** 18n);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought" });
    h.runner.stop();
  });

  it("the owner's wallet must be the one connected", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.setAccount(STRANGER);
    await leading(h);
    expect(state(h)).toMatchObject({ kind: "attention", code: "owner-mismatch" });
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "refused" });
    expect(h.sent).toHaveLength(0);
    h.setAccount(null);
    await h.runner.tick();
    expect(state(h)).toMatchObject({ kind: "attention", code: "wallet-disconnected" });
    h.runner.stop();
  });

  it("a price warning asks for consent instead of signing, and consent at that figure goes ahead", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.verdicts.push(divergent(500), divergent(480));
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toEqual({
      kind: "needs-price-consent",
      needsPriceConsent: 500,
      codes: ["ORACLE_DIVERGENCE"],
    });
    expect(h.sent).toHaveLength(0);
    expect(await h.runner.confirmDue("spx-daily", { acceptDivergenceBps: 500 })).toMatchObject({ kind: "bought" });
    h.runner.stop();
  });

  it("the owner wallet lock keeps a scheduled buy from interleaving with a manual swap", async () => {
    const lock = new OwnerWalletLock();
    const h = harness({ plan: walletPlan(), start: "wallet", ownerWalletLock: lock });
    await leading(h);
    expect(lock.tryAcquire()).toBe(true); // the swap button has the wallet
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "busy" });
    expect(h.quotes).toHaveLength(0);
    lock.release();
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought" });
    expect(lock.isBusy()).toBe(false);
    h.runner.stop();
  });

  it("a declined buy is recorded as declined, releases its claim, and does not count as a failure", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.sendBehaviour.fail = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "declined" });
    // The window is given back: nothing was bought, and the buy is still due.
    expect(h.entry()).toMatchObject({ committed: "0", lastSlot: null, consecutiveFailures: 0, buysDone: 0 });
    expect(h.entry().runs.at(-1)).toMatchObject({ status: "declined", codes: [RUN_CODES.DECLINED] });
    h.runner.stop();
  });

  it("a declined buy can be confirmed after all in the same window, and the wallet isn't asked again until then", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.sendBehaviour.fail = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "declined" });
    const asked = h.sent.length;
    await h.runner.tick();
    expect(h.sent).toHaveLength(asked);
    delete h.sendBehaviour.fail;
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought" });
    expect(h.entry()).toMatchObject({ lastSlot: 0, buysDone: 1 });
    expect(h.entry().runs.map((r) => r.status)).toEqual(["declined", "confirmed"]);
    h.runner.stop();
  });

  it("private submission that the wallet cannot do is skipped — never sent publicly instead", async () => {
    const methods: string[] = [];
    const provider: Eip1193Provider = {
      request: async ({ method }) => {
        methods.push(method);
        if (method === "eth_signTransaction") throw Object.assign(new Error("not supported"), { code: 4200 });
        if (method === "eth_chainId") return `0x${CHAIN.toString(16)}`;
        if (method === "eth_sendTransaction") return hashN(7);
        return "0x1";
      },
    };
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x5208" : "0x1");
    const relay: SubmitterConfig = { mode: "private", url: "https://relay.invalid/rpc" };
    const h = harness({
      plan: walletPlan(),
      start: "wallet",
      submitter: relay,
      walletSender: (account) => walletSender({ submitter: relay, account, onPublicFallback: () => false, reads, provider }),
    });
    await leading(h);
    const outcome = await h.runner.confirmDue("spx-daily");
    expect(outcome).toMatchObject({ kind: "skipped", codes: [RUN_CODES.PRIVATE_UNAVAILABLE] });
    expect(methods).not.toContain("eth_sendTransaction");
    expect(h.entry()).toMatchObject({ committed: "0", lastSlot: 0 });
    h.runner.stop();
  });

  it("Skip uses the window; a window left unconfirmed is recorded once as not confirmed", async () => {
    const h = harness({ plan: plan({ signer: "wallet", maxBuys: 10 }), start: "wallet" });
    await leading(h);
    expect(await h.runner.skipDue("spx-daily")).toMatchObject({ kind: "skipped" });
    expect(h.entry().lastSlot).toBe(0);
    await h.runner.tick();
    expect(state(h)).toEqual({ kind: "waiting", nextAt: T0 + HOUR });

    // Window 1 opens and ends with nobody pressing Confirm.
    h.clock.now = (T0 + HOUR) * 1000 + 1_000;
    await h.runner.tick();
    expect(state(h)).toMatchObject({ kind: "due", slot: 1 });
    h.clock.now = (T0 + 2 * HOUR) * 1000 + 1_000;
    await h.runner.tick();
    await h.runner.tick();
    const notConfirmed = h.entry().runs.filter((r) => r.codes?.includes(RUN_CODES.NOT_CONFIRMED));
    expect(notConfirmed).toHaveLength(1);
    expect(notConfirmed[0]!.slot).toBe(1);
    expect(h.entry().lastSlot).toBe(1);
    expect(state(h)).toMatchObject({ kind: "due", slot: 2 });
    h.runner.stop();
  });
});

// ── Fixes from review: the record across tabs, what a wallet may have sent, the clock per buy ──

const USDC = TOKENS.USDC.address;

/** A quote with the legs given: each `{ amountIn, approve? }` becomes one leg with one swap call. */
function quoteWith(
  input: ScheduledQuoteInput,
  legs: { amountIn: bigint; approve?: boolean }[],
  verdict: GuardVerdict = VERIFIED,
): QuoteResult {
  const built = legs.map((leg, i) => {
    const txPlan: TxPlan = {
      version: 1,
      intent: {
        version: 1,
        chainId: CHAIN,
        account: input.progress.signer,
        recipient: input.progress.owner,
        tokenIn: input.tokenIn.address,
        tokenOut: input.tokenOut.address,
        maxAmountIn: leg.amountIn,
        minAmountOut: 1n,
        deadline: (input.nowSeconds ?? 0n) + 1_200n,
        nonce: "0x01",
      },
      approvals: leg.approve ? [{ token: input.tokenIn.address, spender: ROUTER, amount: leg.amountIn }] : [],
      calls: [{ to: ROUTER, data: `0x0${i + 1}`, value: leg.approve ? 0n : leg.amountIn }],
      meta: { venueId: "venue-uniswap-v2", poolIds: [], quotedAmountOut: 1n, gasEstimate: 1n },
    };
    return {
      poolId: `0xpool${i}`,
      venueId: "venue-uniswap-v2",
      shareBps: 10_000 / legs.length,
      amountIn: leg.amountIn,
      amountOut: 1n,
      plan: txPlan,
      verdict,
    };
  });
  return {
    route: { amountIn: input.amountIn, amountOut: 1n, legs: [] } as unknown as QuoteResult["route"],
    pools: [],
    legs: built,
    verdict,
    minAmountOut: 1n,
    previewOnly: false,
  };
}

/** An endpoint answer to `eth_call`: a large balance for `balanceOf`, no allowance for `allowance`. */
const holdsTokensNoAllowance = (params: unknown[]) => {
  const data = (params[0] as { data: string }).data;
  return data.startsWith("0x70a08231") ? `0x${(10n ** 24n).toString(16)}` : `0x${"0".repeat(64)}`;
};

describe("DcaRunner — the record across tabs", () => {
  it("another tab's write made during a buy waits for the buy to be recorded", async () => {
    const ledgerLocks = new FakeLocks();
    const h = harness({ ledgerLocks, plan: plan({ maxBuys: 10 }) });
    const otherTab = new LedgerStore(h.storage, { events: null, locks: ledgerLocks });
    let resumed: Promise<unknown> | null = null;
    let seenByResume: DcaLedgerEntry | null = null;
    h.sendBehaviour.receipt = () => {
      // Resume pressed in another tab while the swap is out.
      resumed ??= otherTab.updateShared((l) => {
        seenByResume = entryOf(l, { planId: "spx-daily", chainId: CHAIN })!;
        return l;
      });
      return undefined;
    };
    await leading(h);
    await h.runner.confirmDue("spx-daily");
    await resumed;
    expect(seenByResume).toMatchObject({ lastSlot: 0, buysDone: 1 });
    expect(h.entry()).toMatchObject({ lastSlot: 0, buysDone: 1, committed: AMOUNT.toString() });
    h.runner.stop();
  });

  it("a claim written over during a buy is put back, the plan stopped — and the window is never bought twice", async () => {
    const h = harness({ plan: plan({ maxBuys: 10 }) });
    const beforeClaim = h.storage.data[LEDGER_KEY]!;
    h.sendBehaviour.receipt = () => {
      // A tab writing from a copy taken before the claim, around every lock.
      h.storage.data[LEDGER_KEY] = beforeClaim;
      return undefined;
    };
    await leading(h);
    await h.runner.confirmDue("spx-daily");
    expect(h.sent).toHaveLength(1);
    expect(h.entry()).toMatchObject({ lastSlot: 0, buysDone: 1, committed: AMOUNT.toString() });
    expect(h.entry().halted).toMatch(/another spDEX tab/);
    expect(h.entry().runs.find((r) => r.slot === 0)).toMatchObject({ status: "confirmed", amountOut: "5000000" });
    expect(state(h)).toMatchObject({ kind: "attention", code: "halted" });
    expect((state(h) as { reason: string }).reason).toMatch(/^Stopped: this plan's record changed/);

    delete h.sendBehaviour.receipt;
    h.clock.now += RETRY_MS;
    await h.runner.tick();
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "not-due" });
    expect(h.sent).toHaveLength(1);
    h.runner.stop();
  });
});

describe("DcaRunner — what a wallet may have sent", () => {
  const walletPlan = () => plan({ maxBuys: 10 });
  /** A wallet plan whose buy for window 0 was claimed, and the tab closed while the wallet was asking. */
  const interrupted = (l: DcaLedger): DcaLedger => {
    const key = `${CHAIN}:spx-daily`;
    const entry = l.entries[key]!;
    return {
      version: 1,
      entries: {
        [key]: {
          ...entry,
          committed: AMOUNT.toString(),
          lastSlot: 0,
          runs: [
            { slot: 0, at: T0 * 1000, status: "pending", amountIn: AMOUNT.toString(), hashes: [], steps: [], calls: 1, deadline: T0 + 1_260, ownerNonce: 7 },
          ],
        },
      },
    };
  };

  it("claims with the owner's pending nonce", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.nonces.set(OWNER, { latest: 3, pending: 5 });
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought" });
    expect(h.entry().runs.at(-1)).toMatchObject({ ownerNonce: 5 });

    // Unreadable: the buy does not start, and nothing is recorded.
    h.rpcOverrides.set("eth_getTransactionCount", new Error("eth_getTransactionCount: upstream timeout"));
    h.clock.now = (T0 + HOUR) * 1000 + 1_000;
    await h.runner.tick();
    const sent = h.sent.length;
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "unavailable" });
    expect(h.sent).toHaveLength(sent);
    expect(h.entry().lastSlot).toBe(0);
    h.runner.stop();
  });

  it("a hashless buy is counted as made once the owner's account used its nonce — never given back", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet", seed: interrupted });
    h.nonces.set(OWNER, { latest: 8, pending: 8 });
    await leading(h);
    const run = h.entry().runs.find((r) => r.slot === 0)!;
    expect(run).toMatchObject({ status: "confirmed", codes: [RUN_CODES.INTERRUPTED, RUN_CODES.ASSUMED_SPENT] });
    expect(run.amountOut).toBeUndefined();
    expect(h.entry()).toMatchObject({ buysDone: 1, committed: AMOUNT.toString(), lastSlot: 0 });
    // Window 0 is not due again.
    expect(state(h)).toEqual({ kind: "waiting", nextAt: T0 + HOUR });
    h.runner.stop();
  });

  it("judges the deadline by the chain's clock: a device running ahead does not release a buy the chain can still make", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet", seed: interrupted });
    h.nonces.set(OWNER, { latest: 7, pending: 8 });
    // The device is an hour past the deadline; the chain (a fork, days behind) is not.
    h.clock.now = (T0 + 1_260 + HOUR) * 1000;
    h.chain.offset = -5 * 86_400;
    await leading(h);
    expect(h.entry().runs.find((r) => r.slot === 0)!.status).toBe("unknown");
    expect(h.entry().committed).toBe(AMOUNT.toString());
    expect(state(h)).toMatchObject({ kind: "attention", code: "unsettled" });

    // No timestamp at all: still not past.
    h.chain.offset = null;
    await h.runner.tick();
    expect(h.entry().runs.find((r) => r.slot === 0)!.status).toBe("unknown");

    // The chain passes the deadline and the nonce was never used: nothing went out.
    h.chain.offset = 0;
    await h.runner.tick();
    const released = h.entry().runs.find((r) => r.slot === 0)!;
    expect(released).toMatchObject({ status: "failed", codes: [RUN_CODES.INTERRUPTED] });
    expect(released.reason).toMatch(/never sent/);
    expect(h.entry()).toMatchObject({ committed: "0", buysDone: 0 });
    h.runner.stop();
  });

  it("a wallet error that is not a refusal leaves the buy unknown, not failed", async () => {
    const h = harness({ plan: walletPlan(), start: "wallet" });
    h.nonces.set(OWNER, { latest: 4, pending: 4 });
    h.sendBehaviour.fail = () => new Error("WalletConnect: request expired");
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "unknown" });
    expect(h.entry().runs.at(-1)).toMatchObject({ status: "unknown", walletUnanswered: true, hashes: [] });
    expect(h.entry()).toMatchObject({ committed: AMOUNT.toString(), consecutiveFailures: 0, lastSlot: 0 });

    // The wallet did send it after all: the nonce is used, and the buy counts.
    h.nonces.set(OWNER, { latest: 5, pending: 5 });
    await h.runner.tick();
    expect(h.entry().runs.at(-1)).toMatchObject({ status: "confirmed", codes: [RUN_CODES.ASSUMED_SPENT] });
    expect(h.entry()).toMatchObject({ buysDone: 1, committed: AMOUNT.toString() });
    h.runner.stop();
  });

  it("a hashed wallet buy that never confirmed is counted, not released, when its nonce went to a replacement", async () => {
    const h = harness({
      plan: walletPlan(),
      start: "wallet",
      seed: (l) => {
        const next = interrupted(l);
        const e = next.entries[`${CHAIN}:spx-daily`]!;
        e.runs = [{ ...e.runs[0]!, status: "unknown", hashes: [hashN(70)], steps: ["swap"] }];
        return next;
      },
    });
    h.nonces.set(OWNER, { latest: 8, pending: 8 }); // "speed up" replaced it
    h.chain.offset = HOUR; // well past the deadline
    await leading(h);
    expect(h.entry().runs.find((r) => r.slot === 0)).toMatchObject({ status: "confirmed", codes: [RUN_CODES.ASSUMED_SPENT] });
    expect(h.entry().committed).toBe(AMOUNT.toString());
    h.runner.stop();
  });

  it("a private buy whose relay answer is lost stays unknown under the hash of what was signed", async () => {
    const relay: SubmitterConfig = { mode: "private", url: "https://relay.invalid/rpc" };
    let signed = "";
    const provider: Eip1193Provider = {
      request: async ({ method, params }) => {
        if (method === "eth_signTransaction") return (signed = signAsAsked(params));
        if (method === "eth_chainId") return `0x${CHAIN.toString(16)}`;
        throw new Error(`unexpected ${method}`);
      },
    };
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x5208" : "0x1");
    const h = harness({
      plan: walletPlan(),
      start: "wallet",
      submitter: relay,
      walletSender: (account, o) =>
        walletSender({
          submitter: relay,
          account,
          onPublicFallback: () => false,
          reads,
          provider,
          notAfter: o.notAfter,
          onSigned: o.onSigned,
          now: () => h.clock.now,
        }),
    });
    try {
      // The relay took it, and the answer never came back.
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("fetch failed");
      });
      await leading(h);
      expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "unknown" });
      const hash = transactionHash(signed);
      expect(h.entry().runs.at(-1)).toMatchObject({ status: "unknown", hashes: [hash] });
      expect(h.entry()).toMatchObject({ committed: AMOUNT.toString(), consecutiveFailures: 0 });

      // It lands: settled from the chain by the hash spDEX computed.
      h.receipts.set(hash, {
        status: "0x1",
        logs: [{ address: SPX, topics: [TOPICS.transfer, pad(ROUTER), pad(OWNER)], data: "0x2a" }],
      });
      await h.runner.tick();
      expect(h.entry().runs.at(-1)).toMatchObject({ status: "confirmed", amountOut: "42" });
    } finally {
      vi.unstubAllGlobals();
      h.runner.stop();
    }
  });

  it("a relay that reports another hash is not believed: the buy is watched by the hash signed", async () => {
    const relay: SubmitterConfig = { mode: "private", url: "https://relay.invalid/rpc" };
    let signed = "";
    const provider: Eip1193Provider = {
      request: async ({ method, params }) => (method === "eth_signTransaction" ? (signed = signAsAsked(params)) : `0x${CHAIN.toString(16)}`),
    };
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x5208" : "0x1");
    const h = harness({
      plan: walletPlan(),
      start: "wallet",
      submitter: relay,
      walletSender: (account, o) =>
        walletSender({
          submitter: relay,
          account,
          onPublicFallback: () => false,
          reads,
          provider,
          notAfter: o.notAfter,
          onSigned: o.onSigned,
          now: () => h.clock.now,
        }),
    });
    try {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"ab".repeat(32)}` })));
      await leading(h);
      expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "unknown" });
      expect(h.entry().runs.at(-1)).toMatchObject({ status: "unknown", hashes: [transactionHash(signed)] });
    } finally {
      vi.unstubAllGlobals();
      h.runner.stop();
    }
  });
});

describe("DcaRunner — the clock, per buy", () => {
  it("each buy is quoted, and its window judged, at the moment it is confirmed", async () => {
    // Two plans due at once — the usual case when spDEX reopens. The first
    // buy takes 90 s to confirm and carries the clock over a window boundary.
    const h = harness({ plans: [plan({ id: "a-plan" }), plan({ id: "b-plan" })] });
    h.clock.now = (T0 + HOUR) * 1000 - 30_000;
    h.sendBehaviour.takesMs = 90_000;
    await leading(h);
    await h.runner.confirmDue("a-plan");
    await h.runner.confirmDue("b-plan");
    expect(h.quotes.slice(0, 2).map((q) => [q.plan.id, q.slot, Number(q.nowSeconds)])).toEqual([
      ["a-plan", 0, T0 + HOUR - 30],
      ["b-plan", 1, T0 + HOUR + 60],
    ]);
    // b-plan's buy was for the window open when it was made, not the one the
    // look began in; the one that ended while a-plan's was confirming ended
    // unconfirmed, and says so.
    expect(h.entryFor("a-plan").runs.find((r) => r.slot === 0)).toMatchObject({ status: "confirmed" });
    expect(h.entryFor("b-plan").runs.map((r) => [r.slot, r.status, r.codes?.[0]])).toEqual([
      [0, "skipped", RUN_CODES.NOT_CONFIRMED],
      [1, "confirmed", undefined],
    ]);
    h.runner.stop();
  });

  it("a private swap is never posted after its deadline, even when its permission confirmed late", async () => {
    const relay: SubmitterConfig = { mode: "private", url: "https://relay.invalid/rpc" };
    const h = harness({
      plan: plan({ sell: USDC, amountPerBuy: "25000000", maxBuys: 10 }),
      submitter: relay,
      quote: async (input) => quoteWith(input, [{ amountIn: input.amountIn, approve: true }]),
    });
    h.rpcOverrides.set("eth_call", holdsTokensNoAllowance);
    // The permission takes 21 minutes to confirm; the quote allowed 20.
    h.sendBehaviour.takesMs = 1_260_000;
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "skipped", codes: [RUN_CODES.LATE_SIGNATURE] });
    expect(h.sent).toHaveLength(1); // the permission only
    const run = h.entry().runs.at(-1)!;
    expect(run).toMatchObject({ status: "skipped", codes: [RUN_CODES.LATE_SIGNATURE], steps: ["approve"] });
    // A person who signed late is not the plan failing.
    expect(h.entry()).toMatchObject({ committed: "0", lastSlot: 0, consecutiveFailures: 0 });
    h.runner.stop();
  });
});

describe("DcaRunner — fail closed, every way", () => {
  it("a claim that cannot be written is never signed", async () => {
    const h = harness();
    const setItem = h.storage.setItem;
    h.storage.setItem = (key, value) => {
      if (value.includes('"status":"pending"')) throw new Error("QuotaExceededError");
      setItem(key, value);
    };
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/couldn't write this browser's record, so it didn't buy/),
    });
    expect(h.sent).toHaveLength(0);
    expect(h.entry().lastSlot).toBeNull();
    h.runner.stop();
  });

  it("a scheduler that fails says so on every plan, and nothing is bought", async () => {
    const h = harness({
      dueBuys: async () => {
        throw new Error("The auto-buy scheduler is turned off in Features.");
      },
    });
    await leading(h);
    expect(state(h)).toEqual({ kind: "attention", code: "scheduler", reason: "The auto-buy scheduler is turned off in Features." });
    expect(h.quotes).toHaveLength(0);
    h.runner.stop();
  });

  it("a plan for another chain, or for a token spDEX doesn't list, is not bought", async () => {
    const elsewhere = harness({ configChainId: 1 });
    await leading(elsewhere);
    expect(state(elsewhere)).toMatchObject({ kind: "attention", code: "chain-mismatch" });
    expect(elsewhere.quotes).toHaveLength(0);
    elsewhere.runner.stop();

    const unlisted = harness({ plan: plan({ buy: "0x00000000000000000000000000000000000dead1" }) });
    await leading(unlisted);
    expect(state(unlisted)).toMatchObject({ kind: "attention", code: "unknown-token" });
    expect(unlisted.quotes).toHaveLength(0);
    unlisted.runner.stop();
  });

});

describe("DcaRunner — what an old autopilot plan left", () => {
  /** A migrated plan's record, still naming its spending wallet, with `runs` from before version 8. */
  const oldRecord = (runs: DcaLedgerEntry["runs"], extra: Partial<DcaLedgerEntry> = {}) => (l: DcaLedger): DcaLedger => {
    const key = `${CHAIN}:spx-daily`;
    return { version: 1, entries: { [key]: { ...l.entries[key]!, runs, ...extra } } };
  };

  it("is never offered to its owner until Resume binds its record to them", async () => {
    // Set running by a hand edit, skipping Resume: the Guard would refuse
    // every buy the owner confirmed, since the record names another signer.
    const h = harness({ start: "old-autopilot" });
    await leading(h);
    expect(state(h)).toMatchObject({ kind: "attention", code: "old-signer" });
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/spending wallet/) });
    expect(h.quotes).toHaveLength(0);
    h.runner.stop();
  });

  it("settles a buy its spending wallet left unsent as nothing sent, whatever the owner's nonce", async () => {
    // The spending wallet recorded each hash before broadcasting: none means
    // nothing went out, and the owner's account never had anything to do with it.
    const h = harness({
      plan: plan({ paused: true }),
      start: "old-autopilot",
      seed: oldRecord(
        [{ slot: 0, at: T0 * 1000, status: "pending", amountIn: AMOUNT.toString(), hashes: [], steps: [], calls: 1, deadline: T0 + 1_260 }],
        { committed: AMOUNT.toString(), lastSlot: 0 },
      ),
    });
    h.nonces.set(OWNER, { latest: 9, pending: 9 });
    await leading(h);
    expect(h.entry().runs[0]).toMatchObject({ status: "failed", codes: [RUN_CODES.INTERRUPTED] });
    expect(h.entry()).toMatchObject({ committed: "0", buysDone: 0 });
    h.runner.stop();
  });

  it("measures ether its spending wallet bought without adding back fees the owner never paid", async () => {
    const h = harness({
      plan: plan({ paused: true, sell: SPX, buy: NATIVE_TOKEN }),
      start: "old-autopilot",
      seed: oldRecord(
        [{ slot: 0, at: T0 * 1000, status: "unknown", amountIn: AMOUNT.toString(), hashes: [hashN(42)], steps: ["swap"], calls: 1 }],
        { committed: AMOUNT.toString(), lastSlot: 0 },
      ),
    });
    // Mined, successful, and with no before-balance to measure ether against:
    // counted as bought, the amount unmeasured rather than guessed.
    h.receipts.set(hashN(42), { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [] });
    await leading(h);
    expect(h.entry().runs[0]).toMatchObject({ status: "confirmed" });
    expect(h.entry().runs[0]!.amountOut).toBeUndefined();
    expect(h.entry().buysDone).toBe(1);
    h.runner.stop();
  });
});

describe("DcaRunner — what each end of a buy time records", () => {
  it("a buy an old autopilot plan held, that nobody answered, becomes HELD_EXPIRED when its buy time ends", async () => {
    const h = harness({
      plan: plan({ maxBuys: 10, paused: true }),
      start: "old-autopilot",
      seed: (l) => {
        const key = `${CHAIN}:spx-daily`;
        return {
          version: 1,
          entries: {
            [key]: {
              ...l.entries[key]!,
              lastSeen: { slot: 0, active: true },
              runs: [
                { slot: 0, at: T0 * 1000, status: "held", amountIn: AMOUNT.toString(), hashes: [], reason: "held", codes: ["ORACLE_DIVERGENCE"], divergenceBps: 720 },
              ],
            },
          },
        };
      },
    });
    h.clock.now = (T0 + HOUR) * 1000 + 1_000;
    await leading(h);
    expect(h.entry().runs.find((r) => r.slot === 0)).toMatchObject({
      status: "skipped",
      codes: [RUN_CODES.HELD_EXPIRED, "ORACLE_DIVERGENCE"],
      divergenceBps: 720,
    });
    expect(h.entry().runs.filter((r) => r.status === "held")).toHaveLength(0);
    h.runner.stop();
  });

  it("a split buy that went through in part settles, with what arrived and a note", async () => {
    const h = harness({
      quote: async (input) => quoteWith(input, [{ amountIn: 6n * 10n ** 15n }, { amountIn: 4n * 10n ** 15n }]),
    });
    // The first leg goes through; the node refuses the second.
    let sends = 0;
    h.sendBehaviour.fail = () => (++sends === 2 ? new RawTransactionRejected("nonce too low") : undefined);
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought", partial: true });
    const run = h.entry().runs.at(-1)!;
    expect(run).toMatchObject({ status: "confirmed", codes: [RUN_CODES.PARTIAL], amountOut: "5000000" });
    expect(run.reason).toMatch(/only 1 of 2 parts/);
    expect(h.entry()).toMatchObject({ buysDone: 1, committed: AMOUNT.toString() });
    h.runner.stop();
  });

  it("ether bought by a wallet plan is measured from the owner's balance, with the fees it paid added back", async () => {
    const h = harness({ plan: plan({ sell: SPX, buy: NATIVE_TOKEN }) });
    h.rpcOverrides.set("eth_call", holdsTokensNoAllowance);
    const before = h.balances.get(OWNER)!;
    // 1,000,000 wei arrives; the owner's wallet paid 21,000 gas at 1 wei.
    h.sendBehaviour.receipt = () => {
      h.balances.set(OWNER, before + 1_000_000n - 21_000n);
      return { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [] };
    };
    await leading(h);
    expect(await h.runner.confirmDue("spx-daily")).toMatchObject({ kind: "bought", amountOut: 1_000_000n });
    expect(h.entry().runs.at(-1)!.amountOut).toBe("1000000");
    h.runner.stop();
  });
});
