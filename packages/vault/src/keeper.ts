/**
 * A keeper: finds due vault buys and makes many of them in one transaction,
 * through the batcher, for their buy fees.
 *
 * ## Anyone can run this, and nobody has to trust whoever does
 *
 * A vault enforces its own plan. Whoever calls `execute` picks only the
 * moment, inside a window that is already due; the amount, the token, the
 * recipient and the price floor are the vault's, and a call that breaks any of
 * them reverts. The batcher (`batcher.ts`) is one more such caller: it runs
 * each due vault with a fixed gas cap, passes every fee on to the address its
 * caller names in the same transaction, and keeps nothing. So a keeper needs
 * no permission from owners, and they need no trust in it — it can make a buy
 * happen or not happen, never happen differently. None of it is promised: a
 * plan runs while somebody runs a keeper, and a window nobody triggers is
 * skipped.
 *
 * ## What a keeper does have to distrust
 *
 * A token's own code runs inside every buy, in a transaction the keeper pays
 * for, and a clone made by hand can name any token. So the keeper triggers
 * only vaults a listed factory vouches for — found in the factory's own list,
 * which the same call that set `isVault` wrote — and the batcher checks
 * `isVault` again on chain. Each attempt is capped at `EXECUTE_GAS_CAP`, every
 * batch is simulated at the fee it will pay, and a vault whose buy burned its
 * gas on chain is left alone for a week. Most failures are honest, though —
 * another keeper got there first, the price moved — and are never held
 * against a vault for longer than a window.
 *
 * ## One tick
 *
 * Read the head (and refuse to act on a stale one); follow the transaction in
 * flight, if any (`keeper-pending.ts`); read the factories' lists for new
 * vaults (`keeper-read.ts`); work out from the cached terms which vaults are
 * due and whether any justifies a send now — a cheap block, a deadline, a
 * short plan; only then read those vaults and their prices; choose a batch the
 * fees pay for (`keeper-plan.ts`); simulate it; sign and send it through the
 * nonce manager (`keeper-send.ts`). Every decision is a JSONL record
 * (`keeper-log.ts`), and the state (`keeper-state.ts`) carries what the
 * keeper learned into the next tick. This file is the tick itself and its
 * planning; the others never call back into it.
 *
 * Nothing here uses a Node API: the loop, files, signals and the wall clock
 * are `scripts/keeper.ts`'s. `index.ts` does not re-export this file; it is an
 * operator's tool, behind `@spdex/vault/keeper`, and nothing the app imports
 * reaches it.
 */

import { encodeFunctionData, parseTransaction } from "viem";
import type { Address, Hex } from "@spdex/core";
import type { JsonRpc, PreparedFees } from "@spdex/chain";
import { BATCHER_LIMITS, VAULT_LIMITS, type Deployment } from "./artifacts.js";
import {
  decodeBatchRevert,
  decodeExecuteBatchResult,
  deployBatcherCall,
  encodeExecuteBatch,
  reasonName,
  type BatchSimulation,
} from "./batcher.js";
import { WETH_ABI, type VaultProgress } from "./index.js";
import { keeperAddress, rewardToOf, type KeeperConfig } from "./keeper-config.js";
import { stampRecord, type KeeperLogBody, type KeeperLogRecord, type SentVault, type WaitReason } from "./keeper-log.js";
import {
  SECONDS_PER_BLOCK,
  awaitReceipt,
  dailyLossLeft,
  maxFeePerGasOf,
  pollOrphans,
  pollReceipt,
  replaceWith,
  send,
  settlePending,
  subsidisedBy,
  tipOf,
} from "./keeper-pending.js";
import {
  batchGasLimit,
  cheapTarget,
  chooseFees,
  deadlineOf,
  earliestBuyAt,
  economicFeePerGas,
  nextBaseFee,
  replacementFees,
  selectBatch,
  shouldSend,
  splitRoundRobin,
  windowOf,
  type BatchCandidate,
  type BatchSelection,
  type BuyWindow,
  type KeeperPolicy,
  type SendReason,
} from "./keeper-plan.js";
import { RECHECK_SECONDS, accountingRead, applyRead, currentSlot, discover, readHead, readReserves, readVaults, type Head } from "./keeper-read.js";
import { CANCEL_GAS, UNWRAP_GAS, buildTransaction, newPendingTx, nextNonceFor, revertDataOf, type BatchMined } from "./keeper-send.js";
import type { KeeperState, PendingTx, SkipCode, VaultEntry } from "./keeper-state.js";

export * from "./keeper-plan.js";
export * from "./keeper-config.js";
export * from "./keeper-state.js";
export * from "./keeper-log.js";
export * from "./keeper-send.js";

// ─── Figures ──────────────────────────────────────────────────────────────────

const DAY = 86_400n;
const WEEK = 7n * DAY;
/** A transaction in flight longer than this needs the operator's attention. */
const STUCK_PENDING_BLOCKS = 50n;
const MIN_TICK_SECONDS = 12;
/** A dry run with nowhere to send rewards still needs a `rewardTo` the batcher accepts, for its simulation only. */
const DRY_RUN_REWARD_TO: Address = "0x0000000000000000000000000000000000000001";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

// ─── The tick's interface ─────────────────────────────────────────────────────

export interface KeeperTickInput {
  config: KeeperConfig;
  /** Mutated: what this tick learned. */
  state: KeeperState;
  /** Where `eth_sendRawTransaction` goes, when not `rpc`: a private relay. */
  sendRpc?: JsonRpc;
  log?: (record: KeeperLogRecord) => void;
  /** Awaited before every broadcast and after every change to the transaction in flight. */
  persist?: (state: KeeperState) => Promise<void>;
  /** The `ts` field and the head-lag check only; never a decision about a vault. */
  wallClockMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a sent transaction's receipt within this tick; default 0 (look again next tick). */
  waitForReceiptMs?: number;
  /** Adds a `tick` record every tick. */
  debug?: boolean;
}

export interface KeeperHealth {
  ok: boolean;
  headLagSeconds: bigint;
  active: number;
  due: number;
  pending: { batchId: string; nonce: number; hash: Hex; sentBlock: bigint } | null;
  lastBatchHash: Hex | null;
  lastBatchAt: bigint | null;
  balanceWei: bigint | null;
  runwayDays: number | null;
  attention: string[];
}

export interface KeeperTickResult {
  block: bigint;
  chainTime: bigint;
  phase: "syncing" | "running";
  sent: { batchId: string; hash: Hex; nonce: number; vaults: Address[]; urgent: boolean }[];
  /** Receipts processed this tick. */
  mined: BatchMined[];
  skipped: { vault: Address; code: SkipCode; detail: string }[];
  waiting: { reason: WaitReason; candidates: number } | null;
  /** When each watched vault's next buy may be made, chain time; null when it has none left. */
  upcoming: { vault: Address; nextBuyAt: bigint | null }[];
  nextTickSeconds: number;
  health: KeeperHealth;
}

// ─── One tick ─────────────────────────────────────────────────────────────────

/** What a tick carries between its steps, here and in keeper-read.ts and keeper-pending.ts; not the keeper's API. */
export interface Tick {
  rpc: JsonRpc;
  sendRpc: JsonRpc;
  config: KeeperConfig;
  policy: KeeperPolicy;
  state: KeeperState;
  keeper: Address | null;
  rewardTo: Address | null;
  persist: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  wallClockMs: () => number;
  waitForReceiptMs: number;
  debug: boolean;
  head: Head;
  block: bigint;
  chainTime: bigint;
  /** The fee per gas the next block charges: its base fee, or the gas price where there is none. */
  next: bigint;
  legacy: boolean;
  result: KeeperTickResult;
  /** Per vault, how this tick ended for it: a skip, or fine; reconciled into `skip`/`skip_cleared` records once. */
  outcomes: Map<Address, { code: SkipCode; detail: string; extra?: { spotOut?: bigint; floorOut?: bigint; depth?: bigint } } | "ok">;
  /** The keeper's WETH, when it is its own `rewardTo` and it was read this tick. */
  keeperWeth: bigint | null;
  stale: boolean;
  emit: (body: KeeperLogBody) => void;
}

/**
 * One tick of the keeper. `state` is mutated and should be persisted after;
 * `persist` is also called before every broadcast, so a crash never loses a
 * transaction that may be on the wire.
 *
 * Without `config.keeperKey` this is a dry run: it discovers, reads, selects
 * and simulates, logs what it would send, and never signs or sends anything.
 * It never deploys: `deployMissingBatchers` does that, once.
 */
export async function keeperTick(rpc: JsonRpc, input: KeeperTickInput): Promise<KeeperTickResult> {
  const t = await tickContext(rpc, input);
  const { state, keeper, head } = t;

  // 1. A stale or backwards head: say so, and do nothing on it.
  const lag = BigInt(Math.floor(t.wallClockMs() / 1000)) - head.timestamp;
  t.result.health.headLagSeconds = lag;
  if ((t.policy.maxHeadLagSeconds > 0n && lag > t.policy.maxHeadLagSeconds) || (state.maxHeadSeen !== null && head.number < state.maxHeadSeen)) {
    t.stale = true;
    wait(t, "stale-head", 0, null, null);
    return finish(t);
  }
  state.maxHeadSeen = head.number;
  await sampleFees(t);

  // 2. The transaction in flight, and any that were abandoned but may still land.
  if (keeper !== null) {
    const p = state.pending;
    if (p && (await settlePending(t, p)) === "resend-due") await resend(t, p);
    await pollOrphans(t);
  }

  // 3. New vaults.
  t.result.phase = await discover(t);

  // 4–8. Due vaults, and a batch.
  if (state.pending) {
    wait(t, "pending-tx", state.pending.vaults.length, null, null);
  } else {
    await batchStep(t);
  }

  // 9. Windows that ended without a buy.
  checkMissedWindows(t);
  if (keeper !== null && !state.pending) await maybeUnwrap(t);
  return finish(t);
}

/**
 * Follow the transaction a keeper left in flight, and nothing else: its
 * receipt, a rebroadcast, and a replacement once its resend interval has
 * passed, waiting up to `waitForReceiptMs` for it to settle. True while it is
 * still in flight. A keeper starting with one pending runs this before
 * anything that must sign — a missing batcher's deployment — since nothing
 * else may be signed until it settles, and it may be that very deployment.
 */
export async function settleInFlight(rpc: JsonRpc, input: KeeperTickInput): Promise<boolean> {
  const t = await tickContext(rpc, input);
  const p = t.state.pending;
  if (t.keeper === null || !p) return false;
  if ((await settlePending(t, p)) === "resend-due") await resend(t, p);
  if (t.state.pending && t.waitForReceiptMs > 0) await awaitReceipt(t);
  reconcileSkips(t);
  return t.state.pending !== null;
}

/** The head, the fee the next block charges, and what every step of a tick shares. */
async function tickContext(rpc: JsonRpc, input: KeeperTickInput): Promise<Tick> {
  const { config, state } = input;
  const keeper = keeperAddress(config);
  if (state.chainId !== config.chainId) throw new Error(`the state is for chain ${state.chainId}, not ${config.chainId}`);
  if (keeper !== null && state.keeper !== keeper) throw new Error("the state belongs to another keeper");

  const head = await readHead(rpc);
  const legacy = head.baseFee === null;
  const next = legacy ? BigInt((await rpc("eth_gasPrice", [])) as string) : nextBaseFee({ baseFee: head.baseFee!, gasUsed: head.gasUsed, gasLimit: head.gasLimit });
  const wallClockMs = input.wallClockMs ?? (() => Date.now());
  return {
    rpc,
    sendRpc: input.sendRpc ?? rpc,
    config,
    policy: config.policy,
    state,
    keeper,
    rewardTo: rewardToOf(config),
    persist: async () => input.persist?.(state),
    sleep: input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    wallClockMs,
    waitForReceiptMs: input.waitForReceiptMs ?? 0,
    debug: input.debug ?? false,
    head,
    block: head.number,
    chainTime: head.timestamp,
    next,
    legacy,
    result: {
      block: head.number,
      chainTime: head.timestamp,
      phase: "running",
      sent: [],
      mined: [],
      skipped: [],
      waiting: null,
      upcoming: [],
      nextTickSeconds: config.policy.intervalSeconds,
      health: emptyHealth(),
    },
    outcomes: new Map(),
    keeperWeth: null,
    stale: false,
    emit: (body) => {
      if (body.type === "tick" && !(input.debug ?? false)) return;
      input.log?.(stampRecord(state, keeper, wallClockMs(), body, { block: head.number, chainTime: head.timestamp }));
    },
  };
}

function emptyHealth(): KeeperHealth {
  return { ok: true, headLagSeconds: 0n, active: 0, due: 0, pending: null, lastBatchHash: null, lastBatchAt: null, balanceWei: null, runwayDays: null, attention: [] };
}

/**
 * One `(chainTime, baseFee)` sample a tick, kept for a day: the history the
 * cheap target is a percentile of. A keeper waiting for cheap blocks with no
 * history seeds it once from `eth_feeHistory` rather than waiting an hour.
 */
async function sampleFees(t: Tick): Promise<void> {
  const { state, policy } = t;
  if (state.feeSamples.length === 0 && policy.sendWhen === "cheap" && policy.cheapBaseFee === null && !t.legacy) {
    try {
      const history = (await t.rpc("eth_feeHistory", ["0x400", "latest", []])) as { baseFeePerGas?: string[] } | null;
      // The last entry is the next block's; the others are the blocks before and at the head.
      const fees = (history?.baseFeePerGas ?? []).slice(0, -1).map((f) => BigInt(f));
      fees.forEach((fee, i) => state.feeSamples.push([t.chainTime - SECONDS_PER_BLOCK * BigInt(fees.length - 1 - i), fee]));
    } catch {
      // No history from this endpoint: the samples build up one a tick instead.
    }
  }
  state.feeSamples.push([t.chainTime, t.head.baseFee ?? t.next]);
  state.feeSamples = state.feeSamples.filter(([at]) => at > t.chainTime - DAY);
}

function wait(t: Tick, reason: WaitReason, candidates: number, target: bigint | null, nextDeadline: bigint | null, key = ""): void {
  t.result.waiting = { reason, candidates };
  const said = `${reason}:${candidates}:${key}`;
  if (t.state.lastWait === said) return;
  t.state.lastWait = said;
  t.emit({ type: "wait", reason, nextBaseFeeWei: t.next, targetWei: target, candidates, nextDeadline });
}

// ─── Due vaults and a batch ───────────────────────────────────────────────────

/** One clock-due vault, judged from the head and the cache alone. */
interface Due {
  vault: Address;
  entry: VaultEntry;
  earliest: bigint;
  window: BuyWindow;
  deadline: bigint;
  urgent: boolean;
  shortInterval: boolean;
  target: bigint | null;
  reason: SendReason | null;
}

type Pricing = (urgent: boolean) => { fees: PreparedFees; tip: bigint } | "fees-above-max" | "resend-blocked";

interface SendPlan {
  kind: "send";
  deployment: Deployment;
  selection: BatchSelection;
  gasLimit: bigint;
  fees: PreparedFees;
  reason: SendReason;
  urgent: boolean;
  quotes: Map<Address, VaultProgress["quote"]>;
}

type Plan = SendPlan | { kind: "wait"; reason: WaitReason | "resend-blocked" | null; candidates: number; target: bigint | null; nextDeadline: bigint | null };

/** Steps 4–8 for a new batch: plan it, then sign and send it (or, in a dry run, say what it would send). */
async function batchStep(t: Tick): Promise<void> {
  const plan = await planBatch(t, {
    rebuildOf: null,
    pricing: (urgent) => {
      const chosen = chooseFees({ next: t.next, legacy: t.legacy, urgent }, t.policy);
      return "blocked" in chosen ? chosen.blocked : chosen;
    },
  });
  reconcileSkips(t);
  if (plan.kind === "wait") {
    if (plan.reason !== null && plan.reason !== "resend-blocked") wait(t, plan.reason, plan.candidates, plan.target, plan.nextDeadline);
    return;
  }
  const vaults = plan.selection.vaults.map((v) => v.vault);
  if (t.keeper === null) {
    wait(t, "dry-run", vaults.length, null, null, vaults.join(","));
    return;
  }
  // A send is refused only when the key cannot cover this batch at its highest price.
  const balance = BigInt((await t.rpc("eth_getBalance", [t.keeper, "latest"])) as string);
  t.state.balanceWei = balance;
  const maxFee = plan.gasLimit * maxFeePerGasOf(plan.fees);
  if (balance < maxFee) {
    if (!t.state.lowBalance) {
      t.state.lowBalance = true;
      t.emit({ type: "low_balance", etherWei: balance, thresholdWei: t.policy.minEth, neededWei: maxFee });
    }
    wait(t, "low-balance", vaults.length, null, null);
    return;
  }

  const nonce = await nextNonceFor(t.rpc, t.keeper, t.state);
  const pending = newPendingTx(t.state, t.keeper, nonce, "batch", { deployment: plan.deployment.id, reason: plan.reason, ...batchFields(plan) });
  const { attempt, refused } = await send(t, pending, batchTx(t, plan, nonce), "batch");
  t.state.lastWait = null;
  t.emit({
    type: "batch_sent",
    batchId: pending.batchId,
    nonce,
    attempt: 1,
    hash: attempt.hash,
    deployment: plan.deployment.id,
    batcher: lower(plan.deployment.batcher),
    endpoint: t.config.privateSend ? "private" : "public",
    reason: plan.reason,
    urgent: plan.urgent,
    gasLimit: plan.gasLimit,
    maxFeePerGas: maxFeePerGasOf(plan.fees),
    maxPriorityFeePerGas: tipOf(plan.fees),
    nextBaseFeeWei: t.next,
    expectedGas: plan.selection.expectedGas,
    expectedCostWei: plan.selection.expectedCostWei,
    expectedEarnedWei: plan.selection.expectedEarnedWei,
    allowedLossWei: plan.selection.allowedLossWei,
    minRewardsWei: plan.selection.minRewards,
    vaults: plan.selection.vaults.map((v): SentVault => {
      const quote = plan.quotes.get(v.vault) ?? null;
      return {
        vault: v.vault,
        reward: v.reward,
        marginWei: v.marginWei,
        subsidyWei: v.subsidyWei,
        urgent: v.urgent,
        firstBuy: v.firstBuy,
        spotOut: quote?.spotOut ?? null,
        floorOut: quote?.floorOut ?? null,
        depth: quote?.oracleDepth ?? null,
        secondsToDeadline: v.deadline - t.chainTime,
      };
    }),
  });
  if (refused) t.emit({ type: "error", where: "send", message: `${refused.kind}: ${refused.message}` });
  t.result.sent.push({ batchId: pending.batchId, hash: attempt.hash, nonce, vaults, urgent: plan.urgent });
  if (t.waitForReceiptMs > 0) await awaitReceipt(t);
}

/** What a batch puts in the transaction in flight, for its resends and its receipt. */
function batchFields(plan: SendPlan): Partial<PendingTx> {
  const { selection } = plan;
  return {
    vaults: selection.vaults.map((v) => v.vault),
    urgent: plan.urgent,
    gasLimit: plan.gasLimit,
    modelGas: selection.modelGas,
    expectedGas: selection.expectedGas,
    expectedCostWei: selection.expectedCostWei,
    expectedEarnedWei: selection.expectedEarnedWei,
    minRewards: selection.minRewards,
    subsidy: selection.vaults.filter((v) => v.subsidyWei > 0n).map((v) => ({ vault: v.vault, owner: v.owner, wei: v.subsidyWei })),
  };
}

/** A batch's transaction, by hand: its own release's batcher, its own gas limit, paying `rewardTo`. */
function batchTx(t: Tick, plan: SendPlan, nonce: number): ReturnType<typeof buildTransaction> {
  const vaults = plan.selection.vaults.map((v) => v.vault);
  return buildTransaction({
    from: t.keeper!,
    chainId: t.config.chainId,
    nonce,
    to: lower(plan.deployment.batcher),
    data: encodeExecuteBatch(vaults, t.rewardTo!, plan.selection.minRewards),
    gas: plan.gasLimit,
    fees: plan.fees,
  });
}

/**
 * Choose a batch: the clock filter, the send decision, the reads, the
 * candidates, the economics, the gas limit and up to two simulations. Used for
 * a new batch and, with `rebuildOf`, for a resend at the same nonce, which
 * reselects from fresh reads rather than resending what may no longer pay.
 */
async function planBatch(t: Tick, options: { rebuildOf: PendingTx | null; pricing: Pricing }): Promise<Plan> {
  const { state, policy } = t;
  const rebuild = options.rebuildOf;
  const accountingDue = rebuild === null && (state.accountedAt === null || t.chainTime >= state.accountedAt + policy.accountingSeconds);
  if (accountingDue) await accountingRead(t);

  // 4–5: from the cache, which vaults are due by the clock, and whether any justifies a send.
  let clockDue = clockFilter(t);
  if (rebuild?.deployment) clockDue = clockDue.filter((vault) => state.vaults[vault]?.deployment === rebuild.deployment);
  const dues = clockDue.map((vault) => dueOf(t, vault)).filter((d): d is Due => d !== null);
  const unread = clockDue.filter((vault) => state.vaults[vault]?.readAt === null);
  const lowestTarget = minOrNull(dues.map((d) => d.target));
  const nextDeadline = minOrNull(dues.map((d) => d.deadline));
  const waitFor = (reason: Extract<Plan, { kind: "wait" }>["reason"], candidates: number): Plan => ({ kind: "wait", reason, candidates, target: lowestTarget, nextDeadline });
  if (t.debug) t.emit({ type: "tick", nextBaseFeeWei: t.next, lowestTargetWei: lowestTarget, active: Object.keys(state.vaults).length, clockDue: clockDue.length, candidates: dues.length });
  // Until the reads below, the vaults due by the clock are the best count there is.
  t.result.health.due = dues.length;
  const triggered = rebuild !== null || dues.some((d) => d.reason !== null) || (policy.sendWhen === "now" && unread.length > 0);
  if (!triggered) return waitFor(dues.length > 0 ? "not-cheap" : null, dues.length);

  // 6: read what is about to be sent: progress, balance and price.
  const reads = await readVaults(t.rpc, t.config.weth, clockDue, true);
  const candidates: (BatchCandidate & { due: Due })[] = [];
  const quotes = new Map<Address, VaultProgress["quote"]>();
  for (const vault of clockDue) {
    const read = reads.get(vault);
    if (!read || !applyRead(t, vault, read)) continue;
    quotes.set(vault, read.quote);
    const due = dueOf(t, vault);
    if (due === null || t.chainTime < due.earliest) {
      t.outcomes.set(vault, "ok");
      continue;
    }
    const candidate = candidateOf(t, due, read);
    if (candidate) candidates.push(candidate);
  }
  t.result.health.due = candidates.length;

  // A standby keeper sends only what is about to miss its window.
  const eligible = policy.sendWhen === "deadline" ? candidates.filter((c) => c.urgent) : candidates;
  const reasons = eligible.map((c) => c.due.reason).filter((r): r is SendReason => r !== null);
  if (eligible.length === 0 || (rebuild === null && reasons.length === 0)) return waitFor(eligible.length > 0 ? "not-cheap" : null, eligible.length);

  // Each batch goes to its own release's batcher: the one with the most urgent need first.
  const byDeployment = new Map<string, typeof eligible>();
  for (const c of eligible) byDeployment.set(c.due.entry.deployment, [...(byDeployment.get(c.due.entry.deployment) ?? []), c]);
  const [deploymentId, group] = [...byDeployment.entries()].sort(([, a], [, b]) => Number(b.some((c) => c.urgent)) - Number(a.some((c) => c.urgent)) || b.length - a.length)[0]!;
  const deployment = t.config.deployments.find((d) => d.id === deploymentId)!;

  const urgent = group.some((c) => c.urgent && !c.due.shortInterval);
  const priced = options.pricing(urgent);
  if (priced === "fees-above-max" || priced === "resend-blocked") return waitFor(priced, group.length);
  // The most pressing reason any vault gives; a rebuild that none gives keeps its first send's.
  const reason: SendReason = (["deadline", "now", "short-interval"] as const).find((r) => reasons.includes(r)) ?? reasons[0] ?? rebuild?.reason ?? "deadline";

  const reserves = t.config.privateSend ? new Map<Address, bigint | null>() : await readReserves(t.rpc, t.config.weth, group.map((c) => c.due.entry.terms));
  const feePerGas = economicFeePerGas(t.next, priced.tip, policy, state.breakerOpen);
  const select = (pool: readonly BatchCandidate[]) =>
    selectBatch({
      candidates: pool,
      feePerGas,
      ratioPpm: state.gasModel.ratioPpm,
      privateSend: t.config.privateSend,
      pairReserves: reserves,
      ownerSubsidised24h: subsidisedBy(t, "owner"),
      dailyLossLeft: dailyLossLeft(t),
      policy,
    });

  let selection = select(group);
  noteSelectionSkips(t, selection);
  if (selection.vaults.length === 0) return waitFor("economics", group.length);
  // Too big for one transaction: the first of the fewest chunks that fit, each paying its own way.
  const chunks = splitRoundRobin([...selection.vaults].sort((a, b) => (a.marginWei > b.marginWei ? -1 : a.marginWei < b.marginWei ? 1 : 0)), policy);
  if (chunks.length > 1) {
    selection = select(chunks[0]!);
    if (selection.vaults.length === 0) return waitFor("economics", group.length);
  }

  // 8: simulate at the fee it will pay, at most twice.
  for (let round = 1; round <= 2; round++) {
    const gasLimit = batchGasLimit(selection.vaults);
    const simulation = await simulate(t, deployment, selection, gasLimit, priced.fees);
    if (simulation === null) return waitFor(null, group.length);
    const refusedHere = simulation.outcomes.filter((o) => !o.bought);
    if (simulation.kind === "ok" && refusedHere.length === 0) {
      for (const v of selection.vaults) t.outcomes.set(v.vault, "ok");
      return { kind: "send", deployment, selection, gasLimit, fees: priced.fees, reason, urgent, quotes };
    }
    for (const outcome of refusedHere) simulatedRefusal(t, outcome.vault, outcome.reason ?? "0x", outcome.reasonName);
    const refusedSet = new Set(refusedHere.map((o) => o.vault));
    const survivors = selection.vaults.filter((v) => !refusedSet.has(v.vault));
    if (survivors.length === 0) return waitFor(null, 0);
    selection = select(survivors);
    noteSelectionSkips(t, selection);
    if (selection.vaults.length === 0) return waitFor("economics", survivors.length);
    if (round === 2) {
      // The second simulation still refused some: they are dropped, and the rest goes without a third.
      for (const v of selection.vaults) t.outcomes.set(v.vault, "ok");
      return { kind: "send", deployment, selection, gasLimit: batchGasLimit(selection.vaults), fees: priced.fees, reason, urgent, quotes };
    }
  }
  return waitFor(null, 0);
}

/**
 * Which vaults the cache says are due by the clock, with no RPC: not resting,
 * not trapped, not waiting to be rechecked, funded as last read. A vault never
 * read is included, to be read. Retired vaults are gone from the cache.
 */
function clockFilter(t: Tick): Address[] {
  const { state } = t;
  const due: Address[] = [];
  for (const [vault, e] of entries(state.vaults)) {
    const trap = state.trapped[vault];
    if (trap) {
      const deployment = t.config.deployments.find((d) => d.id === e.deployment);
      const moved = deployment !== undefined && (lower(deployment.batcher) !== trap.batcher || BATCHER_LIMITS.EXECUTE_GAS_CAP !== trap.cap);
      if (moved || t.chainTime >= trap.since + t.policy.trapSeconds) {
        delete state.trapped[vault];
        t.emit({ type: "untrapped", vault, why: moved ? "new-batcher" : "expired" });
      } else {
        noteSkip(t, vault, "trapped", `its buy burned its gas on chain in ${trap.txHash}`);
        continue;
      }
    }
    if (e.restingUntil !== null) {
      if (t.chainTime < e.restingUntil) {
        noteSkip(t, vault, "resting", `not tried again before ${e.restingUntil} (chain time)`);
        continue;
      }
      e.restingUntil = null;
    }
    if (e.recheckAt !== null) {
      if (t.chainTime < e.recheckAt) {
        noteSkip(t, vault, "unfunded", `rechecked at ${e.recheckAt} (chain time)`);
        continue;
      }
      e.recheckAt = null;
    }
    if (e.readAt === null) {
      due.push(vault);
      continue;
    }
    const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
    if (earliest === null || t.chainTime < earliest) continue;
    if (e.balance !== null && e.balance < e.terms.amountPerBuy + e.terms.keeperReward) {
      noteSkip(t, vault, "unfunded", "it holds less than its next buy and its buy fee");
      continue;
    }
    due.push(vault);
  }
  return due;
}

/** A read vault's window, deadline and send reason; null when it has not been read or has no buys left. */
function dueOf(t: Tick, vault: Address): Due | null {
  const e = t.state.vaults[vault];
  if (!e || e.readAt === null) return null;
  const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
  if (earliest === null) return null;
  const window = windowOf(e.terms, earliest > t.chainTime ? earliest : t.chainTime);
  const deadline = deadlineOf(e.terms, window, t.policy);
  const urgent = t.chainTime >= deadline;
  const shortInterval = e.terms.interval < t.policy.shortIntervalSeconds;
  const from = window.windowStart > earliest ? window.windowStart : earliest;
  const target = cheapTarget({ samples: t.state.feeSamples, chainTime: t.chainTime, from, deadline, interval: e.terms.interval }, t.policy);
  const reason = t.chainTime >= earliest ? shouldSend({ urgent, shortInterval, target }, t.next, t.policy) : null;
  return { vault, entry: e, earliest, window, deadline, urgent, shortInterval, target, reason };
}

/**
 * The vault is due and buyable, by the vault's own checks computed locally —
 * funded, the oracle answering with depth, the price inside the floor — and
 * pays a fee; else a skip saying which check failed.
 */
function candidateOf(t: Tick, due: Due, read: VaultProgress): (BatchCandidate & { due: Due }) | null {
  const e = due.entry;
  const need = e.terms.amountPerBuy + e.terms.keeperReward;
  if (read.balance === null || read.balance < need) {
    noteSkip(t, due.vault, "unfunded", "it holds less than its next buy and its buy fee");
    return null;
  }
  const q = read.quote;
  if (q === null) {
    noteSkip(t, due.vault, "oracle-unavailable", "its oracle pool cannot answer a 10-minute average right now");
    return null;
  }
  const extra = { spotOut: q.spotOut, floorOut: q.floorOut, depth: q.oracleDepth };
  if (q.oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH) {
    noteSkip(t, due.vault, "oracle-thin", "its oracle pool is too thin to price a buy", extra);
    return null;
  }
  if (q.spotOut < q.floorOut) {
    noteSkip(t, due.vault, "below-floor", "the price is outside its floor", extra);
    return null;
  }
  if (e.terms.keeperReward === 0n && !t.policy.includeZeroReward) {
    noteSkip(t, due.vault, "zero-reward", "it pays no buy fee, so only its owner has a reason to trigger it");
    return null;
  }
  return {
    vault: due.vault,
    owner: e.owner,
    order: e.index,
    pair: e.terms.pair,
    amountPerBuy: e.terms.amountPerBuy,
    interval: e.terms.interval,
    reward: e.terms.keeperReward,
    firstBuy: e.buysDone === 0n,
    urgent: due.urgent,
    deadline: due.deadline,
    subsidised24h: subsidisedBy(t, "vault").get(due.vault) ?? 0n,
    due,
  };
}

/**
 * Run the batch as an `eth_call` from the keeper at the fees it will sign,
 * with its gas limit: a simulation at a gas price of zero is one a contract
 * can tell from the real thing. Null, after an `error` record, when the
 * endpoint's answer is not one this batcher gives — never a refusal.
 */
async function simulate(t: Tick, deployment: Deployment, selection: BatchSelection, gasLimit: bigint, fees: PreparedFees): Promise<BatchSimulation | null> {
  const vaults = selection.vaults.map((v) => v.vault);
  const rewardTo = t.rewardTo ?? DRY_RUN_REWARD_TO;
  const call = {
    from: t.keeper ?? ZERO,
    to: lower(deployment.batcher),
    data: encodeExecuteBatch(vaults, rewardTo, selection.minRewards),
    gas: hex(gasLimit),
    // A dry run has no balance to bid with, and simulates without fees.
    ...(t.keeper === null ? {} : feeFields(fees)),
  };
  try {
    const data = (await t.rpc("eth_call", [call, "latest"])) as Hex;
    return decodeExecuteBatchResult(vaults, data);
  } catch (error) {
    const data = revertDataOf(error);
    if (data !== null) {
      const decoded = decodeBatchRevert(vaults, data);
      if (decoded) return decoded;
      const selector = data.slice(0, 10) as Hex;
      t.emit({ type: "error", where: "simulate", message: `the batch reverts with ${reasonName(selector) ?? selector}` });
      return null;
    }
    t.emit({ type: "error", where: "simulate", message: messageOf(error) });
    return null;
  }
}

/**
 * What a vault's refusal in a simulation means:
 * someone else bought it or it ended, so read it again; the price or oracle,
 * so skip this tick; it cannot pay, so look again in an hour; its factory does
 * not vouch for it after all; or something that should not happen to a listed
 * vault, so rest it for the window. A simulation never traps: an endpoint
 * that strips revert data is an honest cause.
 */
function simulatedRefusal(t: Tick, vault: Address, reason: Hex, name: string | null): void {
  const e = t.state.vaults[vault];
  noteSkip(t, vault, "sim-refused", name ?? reason);
  if (!e) return;
  switch (name) {
    case "TooSoon":
    case "NoBuysLeft":
    case "VaultClosed":
    case "NotStarted":
      e.readAt = null;
      return;
    case "PriceBelowFloor":
    case "OracleTooThin":
      return;
    case "InsufficientBalance":
      e.recheckAt = t.chainTime + RECHECK_SECONDS;
      return;
    case "NotFromFactory":
      if (e.index === null) {
        // An allowlisted vault the batcher's factory does not vouch for, whatever the reads said: rechecked hourly.
        delete t.state.vaults[vault];
        t.outcomes.delete(vault);
        t.state.notVouched[vault] = { since: t.chainTime, recheckAt: t.chainTime + RECHECK_SECONDS };
        t.emit({ type: "skip", vault, slot: null, code: "not-vouched", detail: "the batcher's factory does not vouch for it" });
      } else {
        t.emit({ type: "error", where: "simulate", message: `the batcher says its factory does not vouch for ${vault}, which is on the factory's list` });
      }
      return;
    case "NotTried":
      t.emit({ type: "error", where: "simulate", message: `${vault} was not tried: the gas limit was too low` });
      return;
    default:
      e.restingUntil = windowOf(e.terms, t.chainTime).windowEnd;
  }
}

function noteSelectionSkips(t: Tick, selection: BatchSelection): void {
  for (const skip of selection.skipped) noteSkip(t, skip.vault, skip.code, skip.detail);
}

// ─── Skips ────────────────────────────────────────────────────────────────────

function noteSkip(t: Tick, vault: Address, code: SkipCode, detail: string, extra?: { spotOut?: bigint; floorOut?: bigint; depth?: bigint }): void {
  t.result.skipped.push({ vault, code, detail });
  t.outcomes.set(vault, extra ? { code, detail, extra } : { code, detail });
}

/**
 * One `skip` record when a vault's reason changes, and one `skip_cleared`
 * with how long it lasted when it clears: a keeper that skips a vault every
 * tick for a day says so twice, not 1,440 times.
 */
function reconcileSkips(t: Tick): void {
  for (const [vault, outcome] of t.outcomes) {
    const e = t.state.vaults[vault];
    if (!e) continue;
    // The window the skip is in now: the watched one may be an earlier window still waiting to be judged.
    const slot = currentSlot(t, e) ?? e.watchedSlot;
    if (outcome === "ok") {
      if (e.lastSkip) {
        t.emit({ type: "skip_cleared", vault, slot, code: e.lastSkip.code, seconds: t.chainTime - e.lastSkip.since });
        e.lastSkip = null;
      }
      continue;
    }
    if (e.lastSkip?.code === outcome.code) continue;
    if (e.lastSkip) t.emit({ type: "skip_cleared", vault, slot, code: e.lastSkip.code, seconds: t.chainTime - e.lastSkip.since });
    t.emit({ type: "skip", vault, slot, code: outcome.code, detail: outcome.detail, ...(outcome.extra ?? {}) });
    e.lastSkip = { code: outcome.code, detail: outcome.detail, since: t.chainTime };
  }
  t.outcomes.clear();
}

// ─── A resend ─────────────────────────────────────────────────────────────────

/**
 * Rebuild the transaction in flight at its nonce, once `settlePending` says
 * its resend interval has passed: an unwrap, a deployment or a cancel is the
 * same transaction bid higher; a batch is reselected from fresh reads, and
 * one no longer worth sending is cancelled in the public pool or left to
 * expire through a private relay.
 */
async function resend(t: Tick, p: PendingTx): Promise<void> {
  const last = p.attempts.at(-1)!;
  const replace = (urgent: boolean) => replacementFees(last.fees, { next: t.next, urgent, resends: p.resends + 1 }, t.policy);

  // An unwrap, a deployment or a cancel: the same transaction, bid higher.
  if (p.purpose !== "batch" || last.kind === "cancel") {
    const fees = replace(false);
    if (fees === null) return t.emit({ type: "resend_blocked", batchId: p.batchId, nonce: p.nonce, why: "fee-cap" });
    const old = parseTransaction(last.raw);
    const tx = buildTransaction({ from: t.keeper!, chainId: t.config.chainId, nonce: p.nonce, to: lower(old.to!), data: old.data ?? "0x", gas: old.gas!, fees });
    await replaceWith(t, p, last, tx, last.kind);
    return;
  }

  const plan = await planBatch(t, {
    rebuildOf: p,
    pricing: (urgent) => {
      const fees = replace(urgent);
      return fees === null ? "resend-blocked" : { fees, tip: tipOf(fees) };
    },
  });
  reconcileSkips(t);
  if (plan.kind === "send") {
    // The earlier attempts keep what they carried: whichever is mined is processed with its own.
    Object.assign(p, batchFields(plan));
    await replaceWith(t, p, last, batchTx(t, plan, p.nonce), "batch");
    return;
  }
  if (plan.reason === "resend-blocked" || plan.reason === "fees-above-max") {
    t.emit({ type: "resend_blocked", batchId: p.batchId, nonce: p.nonce, why: "fee-cap" });
    return;
  }
  // Nothing is worth sending any more.
  if (t.config.privateSend) {
    // A private relay drops what does not land: stop resending, and let it expire.
    p.stoppedResending = true;
    await t.persist();
    return;
  }
  // In the public pool it could still land and lose money: replace it with a cancel.
  const fees = replace(p.urgent);
  if (fees === null) return t.emit({ type: "resend_blocked", batchId: p.batchId, nonce: p.nonce, why: "fee-cap" });
  const tx = buildTransaction({ from: t.keeper!, chainId: t.config.chainId, nonce: p.nonce, to: t.keeper!, data: "0x", gas: CANCEL_GAS, fees });
  const { attempt } = await send(t, p, tx, "cancel");
  p.resends += 1;
  t.emit({ type: "batch_cancel_sent", batchId: p.batchId, nonce: p.nonce, hash: attempt.hash });
}

// ─── Windows ──────────────────────────────────────────────────────────────────

/**
 * A window that ended with no buy, once a read after its end confirms it:
 * `window_missed`, with why as far as the keeper can tell — the vault could
 * not pay, the keeper was not running, or the keeper skipped it (and why).
 */
function checkMissedWindows(t: Tick): void {
  for (const [vault, e] of entries(t.state.vaults)) {
    if (e.watchedSlot === null || e.readAt === null) continue;
    const windowStart = e.terms.startAt + e.watchedSlot * e.terms.interval;
    const windowEnd = windowStart + e.terms.interval;
    if (t.chainTime < windowEnd || e.readAt < windowEnd) continue;
    const bought = e.lastBuyAt >= windowStart && e.lastBuyAt < windowEnd;
    if (!bought) {
      const up = t.state.feeSamples.some(([at]) => at >= windowStart && at < windowEnd);
      const unfunded = e.balance !== null && e.balance < e.terms.amountPerBuy + e.terms.keeperReward;
      t.emit({
        type: "window_missed",
        vault,
        slot: e.watchedSlot,
        windowStart,
        windowEnd,
        class: unfunded ? "unfunded" : !up ? "keeper-down" : e.lastSkip ? "keeper-skipped" : "unknown",
        lastSkip: e.lastSkip?.code ?? null,
        lastDetail: e.lastSkip?.detail ?? null,
      });
      t.state.lastMissedAt = t.chainTime;
    }
    e.watchedSlot = currentSlot(t, e);
  }
}

// ─── Rewards to ether ─────────────────────────────────────────────────────────

/**
 * When the keeper is its own `rewardTo` and runs low on ether, unwrap its WETH
 * rewards so they can pay for gas — through the nonce manager like any other
 * transaction, and without waiting for it.
 */
async function maybeUnwrap(t: Tick): Promise<void> {
  const { state } = t;
  if (t.keeper === null || t.rewardTo !== t.keeper || state.balanceWei === null || state.balanceWei >= t.policy.minEth) return;
  if (t.keeperWeth === null || t.keeperWeth === 0n) return;
  const chosen = chooseFees({ next: t.next, legacy: t.legacy, urgent: false }, t.policy);
  if ("blocked" in chosen) return;
  const nonce = await nextNonceFor(t.rpc, t.keeper, state);
  const pending = newPendingTx(state, t.keeper, nonce, "unwrap", { gasLimit: UNWRAP_GAS, amountWei: t.keeperWeth });
  const tx = buildTransaction({
    from: t.keeper,
    chainId: t.config.chainId,
    nonce,
    to: lower(t.config.weth),
    data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [t.keeperWeth] }),
    gas: UNWRAP_GAS,
    fees: chosen.fees,
  });
  const { attempt } = await send(t, pending, tx, "unwrap");
  t.emit({ type: "unwrap_sent", batchId: pending.batchId, hash: attempt.hash, amountWei: t.keeperWeth });
}

// ─── The end of a tick ────────────────────────────────────────────────────────

function finish(t: Tick): KeeperTickResult {
  const { state, result, policy } = t;
  reconcileSkips(t);
  const upcoming = entries(state.vaults).map(([vault, e]) => ({ vault, nextBuyAt: e.readAt === null ? null : earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt) }));
  result.upcoming = upcoming;

  // The next tick: the nearest deadline, due time or resend, within [12 s, interval].
  const moments: bigint[] = [];
  for (const [vault] of entries(state.vaults)) {
    const due = dueOf(t, vault);
    if (!due) continue;
    if (due.earliest > t.chainTime) moments.push(due.earliest);
    if (due.deadline > t.chainTime) moments.push(due.deadline);
  }
  const p = state.pending;
  if (p) moments.push(t.chainTime + SECONDS_PER_BLOCK * 2n);
  const soonest = minOrNull(moments);
  const seconds = soonest === null ? policy.intervalSeconds : Number(soonest - t.chainTime);
  result.nextTickSeconds = Math.min(Math.max(seconds, MIN_TICK_SECONDS), policy.intervalSeconds);

  state.spend = state.spend.filter(([at]) => at > t.chainTime - WEEK);
  const spentWeek = state.spend.reduce((sum, [, cost]) => sum + cost, 0n);
  const attention: string[] = [];
  if (state.lowBalance) attention.push("low_balance");
  if (p && t.block - p.attempts[0]!.sentBlock > STUCK_PENDING_BLOCKS) attention.push("stuck_pending");
  if (state.lastMissedAt !== null && state.lastMissedAt > t.chainTime - DAY) attention.push("windows_missed_24h");
  if (state.breakerOpen) attention.push("subsidy_exhausted");
  if (t.stale) attention.push("stale_head");
  if (!t.config.privateSend) attention.push("public_mempool");
  const last = p?.attempts.at(-1);
  result.health = {
    ...result.health,
    ok: !t.stale,
    active: Object.keys(state.vaults).length,
    pending: p && last ? { batchId: p.batchId, nonce: p.nonce, hash: last.hash, sentBlock: last.sentBlock } : null,
    lastBatchHash: state.lastBatch?.hash ?? null,
    lastBatchAt: state.lastBatch?.at ?? null,
    balanceWei: state.balanceWei,
    runwayDays: state.balanceWei === null || spentWeek === 0n ? null : Number((state.balanceWei * 70n) / spentWeek) / 10,
    attention,
  };
  return result;
}

// ─── Deploying a batcher ──────────────────────────────────────────────────────

/**
 * Deploy every listed release's batcher whose factory is on this chain and
 * whose batcher is not, through the nonce manager like any other transaction
 * (`--deploy-batcher`). Anyone may; the address is fixed by the bytecode and
 * the factory, so a second deployment, by anyone, lands nowhere new.
 */
export async function deployMissingBatchers(
  rpc: JsonRpc,
  input: Omit<KeeperTickInput, "debug"> & { waitForReceiptMs: number },
): Promise<{ deployed: { deployment: string; batcher: Address; hash: Hex }[]; pending: boolean }> {
  const t = await tickContext(rpc, input);
  const { config, state, keeper } = t;
  if (keeper === null) throw new Error("deploying a batcher needs the keeper's key");
  if (state.pending) throw new Error("a transaction is already in flight; let the keeper settle it first");
  const deployed: { deployment: string; batcher: Address; hash: Hex }[] = [];

  for (const deployment of config.deployments) {
    const hasCode = async (address: Address) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";
    if (!(await hasCode(lower(deployment.factory))) || (await hasCode(lower(deployment.batcher)))) continue;
    const call = deployBatcherCall(lower(deployment.factory));
    const estimate = BigInt((await rpc("eth_estimateGas", [{ from: keeper, to: call.to, data: call.data, value: "0x0" }])) as string);
    const chosen = chooseFees({ next: t.next, legacy: t.legacy, urgent: false }, config.policy);
    if ("blocked" in chosen) throw new Error("network fees are above SPDEX_KEEPER_MAX_FEE_GWEI; try again later");
    const nonce = await nextNonceFor(rpc, keeper, state);
    const gas = (estimate * 12n) / 10n;
    const pending = newPendingTx(state, keeper, nonce, "deploy", { deployment: deployment.id, gasLimit: gas });
    const tx = buildTransaction({ from: keeper, chainId: config.chainId, nonce, to: call.to, data: call.data, gas, fees: chosen.fees });
    const { attempt, refused } = await send(t, pending, tx, "deploy");
    if (refused) throw new Error(`the deployment was refused (${refused.kind})`);
    const receipt = await pollReceipt(t, attempt.hash);
    // Not mined yet: it stays in flight, and the next start follows it (`settleInFlight`).
    if (receipt === null) return { deployed, pending: true };
    state.pending = null;
    state.nextNonce = nonce + 1;
    state.spend.push([t.chainTime, receipt.gasUsed * receipt.effectiveGasPrice]);
    await t.persist();
    if (receipt.status !== 1n || !(await hasCode(lower(deployment.batcher)))) throw new Error(`the deployment of ${deployment.id}'s batcher reverted`);
    t.emit({ type: "batcher_deployed", deployment: deployment.id, hash: attempt.hash, address: lower(deployment.batcher) });
    deployed.push({ deployment: deployment.id, batcher: lower(deployment.batcher), hash: attempt.hash });
  }
  return { deployed, pending: false };
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function feeFields(fees: PreparedFees): Record<string, Hex> {
  return fees.type === "legacy"
    ? { gasPrice: hex(fees.gasPrice) }
    : { maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas) };
}

function minOrNull(values: readonly (bigint | null)[]): bigint | null {
  let out: bigint | null = null;
  for (const v of values) if (v !== null && (out === null || v < out)) out = v;
  return out;
}

const entries = (vaults: Record<Address, VaultEntry>): [Address, VaultEntry][] => Object.entries(vaults) as [Address, VaultEntry][];
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const lower = (a: string): Address => a.toLowerCase() as Address;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
