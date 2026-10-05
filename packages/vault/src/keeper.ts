/**
 * A keeper: finds due vault buys and makes many of them in one transaction,
 * through the batcher, for their buy fees.
 *
 * ## Anyone can run this, and nobody has to trust whoever does
 *
 * A vault enforces its own plan. Whoever calls `execute` picks only the
 * moment, inside a window that is already due, and — in a v2 vault — who is
 * paid the caller's own fee; the amount, the token, the recipient of what is
 * bought and the price floor are the vault's, and a call that breaks any of
 * them reverts. The batcher (`batcher.ts`) is one more such caller: it runs
 * each due vault with a gas cap and keeps nothing — from v2 on it has each
 * vault pay the `rewardTo` its caller names, and gives each the gas its caller
 * names (`gasPerVault`); v1's passes every fee on to it in the same
 * transaction, at a fixed cap. So a keeper needs no permission from owners, and they
 * need no trust in it — it can make a buy happen or not happen, never happen
 * differently. None of it is promised: a plan runs while somebody runs a
 * keeper, and a window nobody triggers is skipped.
 *
 * ## Every release, and the community window
 *
 * Every listed release's vaults are served, each batch to its release's
 * batcher — v1's own, or the one every later release shares — and each judged
 * by what its source can do (`SOURCES[source].features`), never by its name:
 * v1's as they always were, v2's with their community window (docs/
 * V2_UPGRADE.md). For the first minutes after such a buy falls due, its fee
 * may be paid only to the vault's owner or to an address the SPX holder
 * registry finds eligible. So every tick reads whether this keeper's
 * `rewardTo` is eligible (`readEligibility`). An ineligible keeper leaves
 * those buys to holders and comes back when the window ends (`holders-first`);
 * an eligible one takes them as soon as they are due, at the patient tip, and
 * never bids up against other holders inside the window — only in its last
 * two minutes (its last quarter, for a window under eight), when the window's
 * end is a deadline after which anyone may take the buy, does it switch to
 * the urgent tip (decision 19). A plan with turns gives the window's first
 * half to the holders in one bucket (`turnBuckets`); an eligible keeper whose
 * `rewardTo` is in another waits for the turn's end (`other-turn`), as an
 * ineligible one waits for the window's. With `SPDEX_KEEPER_PROVE=1` it also proves
 * its `rewardTo`'s SPX before the proof lapses; either way it logs when the
 * proof will lapse. Its runway — days of sends its ether covers — is in every
 * heartbeat, with a warning below `minRunwayDays`: a keeper paid at a cold
 * `rewardTo` earns nothing back into its hot key.
 *
 * ## What a keeper does have to distrust
 *
 * A token's own code runs inside every buy, in a transaction the keeper pays
 * for, and a clone made by hand can name any token. So the keeper triggers
 * only vaults a listed factory vouches for — found in the factory's own list,
 * which the same call that set `isVault` wrote — and, since the batcher from
 * v2 on asks no factory and the endpoint that answers the list could lie,
 * proves each one its factory's clone before it is first sent: its CREATE2
 * address recomputed from the factory, its owner and terms, and a nonce below
 * the factory's count (`proveClones`). Each attempt is capped at the gas the
 * batch gives a vault (`gasPerVault`), every batch is simulated at the fee it
 * will pay, and a vault whose buy burned its gas on chain is left alone for a
 * week. Most failures are honest, though — another keeper got there first,
 * the price moved — and are never held against a vault for longer than a window.
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

import { decodeFunctionData, encodeFunctionData, parseTransaction } from "viem";
import type { Address, Hex } from "@spdex/core";
import { HeaderHashMismatchError, parseHeaderRlp, type JsonRpc, type PreparedFees } from "@spdex/chain";
import { REGISTRY_ABI, VAULT_LIMITS, type Deployment } from "./artifacts.js";
import {
  decodeBatchRevert,
  decodeExecuteBatchResult,
  reasonName,
  type BatchSimulation,
} from "./batcher.js";
import {
  HoldingBelowMinimumError,
  MIN_SPX,
  PROOF_LAPSE_WARNING_SECONDS,
  PROOF_TTL,
  WETH_ABI,
  buildHolderProof,
  decodeVaultError,
  describeRegistryError,
  proveCall,
  proveGasLimit,
  type HolderProof,
  type VaultRelease,
  type VaultProgress,
} from "./index.js";
import { keeperAddress, rewardToOf, type KeeperConfig } from "./keeper-config.js";
import { stampRecord, type KeeperLogBody, type KeeperLogRecord, type ProveSkipReason, type SentVault, type WaitReason } from "./keeper-log.js";
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
  turnEndsAtOf,
  windowOf,
  type BatchCandidate,
  type BatchSelection,
  type BuyWindow,
  type KeeperPolicy,
  type SendReason,
} from "./keeper-plan.js";
import {
  RECHECK_SECONDS,
  accountingRead,
  applyRead,
  communityWindowOf,
  currentSlot,
  discover,
  holdersFirstUntil,
  mayBePaidInWindow,
  proveClones,
  readEligibility,
  readHead,
  readReserves,
  readVaults,
  turnHeldUntil,
  type Head,
} from "./keeper-read.js";
import {
  CANCEL_GAS,
  UNWRAP_GAS,
  batcherDeploymentOf,
  buildTransaction,
  encodeBatchFor,
  gasPerVaultOf,
  newPendingTx,
  nextNonceFor,
  revertDataOf,
  type BatchMined,
} from "./keeper-send.js";
import type { Eligibility, KeeperState, PendingAttempt, PendingTx, SkipCode, VaultEntry } from "./keeper-state.js";

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
/**
 * A dry run with nowhere to send rewards still needs a `rewardTo` the batcher
 * accepts, for its simulation only. It is never eligible, and nothing is
 * read of it, so a dry run without a `rewardTo` leaves every buy inside its
 * community window to holders and simulates only those open to anyone.
 */
const DRY_RUN_REWARD_TO: Address = "0x0000000000000000000000000000000000000001";
/**
 * A `prove` still unmined this many blocks after the block it proves is
 * withdrawn: the registry checks a block's hash only while it is one of the
 * last 8,191, and the next try builds a proof from a newer block.
 */
const PROVE_STALE_BLOCKS = 7_000n;
/**
 * How often the keeper may pay for a proof, by the wall clock, whatever its
 * endpoint says. The endpoint answers every figure a proof depends on — the
 * record's `validUntil`, the holding, the test-run, the receipt, and the
 * chain's time — so one that lies could, by any of those alone, have a key
 * that sends publicly pay about 650,000 gas a proof (each reverting
 * `NotNewer` on the real chain) every tick. Only this machine's own clock is
 * out of its reach, so the bounds are kept on it (`KeeperState.proveSentAt`,
 * `proveRevertedAt`, `proveTriedAt`):
 *
 * - at most one proof sent each `PROVE_SPACING_SECONDS` (a day), whatever the
 *   endpoint later says of it. An honest proof lasts 30 days and is renewed
 *   from five days before it lapses, so a day costs an honest keeper nothing;
 * - none for `PROVE_REVERT_BACKOFF_SECONDS` (a day) after one is reported
 *   reverted, which `attention: prove_reverted` says;
 * - at most one try (reads, never a signature) an accounting period.
 *
 * So the most a lying endpoint can make the key pay for proofs is one proof's
 * worst price a day (`PROVE_GAS_CAP` × `maxFeePerGas`, 0.00225 ETH at the
 * default cap). A head dated ahead of the wall clock is refused besides, as
 * a lagging one is (`maxHeadLagSeconds`).
 */
const PROVE_SPACING_SECONDS = DAY;
/** After a proof of `rewardTo` this keeper sent is reported reverted, none is sent for this long, by the wall clock. */
const PROVE_REVERT_BACKOFF_SECONDS = DAY;
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
  /** The `ts` field, the head-time check and the bounds on proving only; never a decision about a vault. */
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
  /**
   * Days of sends the key's ether covers at its spend over the time that
   * spend covers, at most the last week; null before it has spent anything,
   * while it has kept its spend for less than a day, or unread.
   */
  runwayDays: number | null;
  attention: string[];
  /** Whether `rewardTo` may be paid inside the latest release's community windows, by this tick's read; null when unknown. */
  eligible: boolean | null;
  /** Until when its proof is valid, chain time (0: never proved); null when unknown. */
  proofValidUntil: bigint | null;
  /** Days until it lapses, to a tenth, negative once lapsed; null when unknown or never proved. */
  proofDaysLeft: number | null;
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

  // 1. A stale, future or backwards head: say so, and do nothing on it. A real head is dated at most seconds before the
  // wall clock; one dated further ahead than the lag allowed is an endpoint, or this machine's clock, that is wrong.
  const lag = wallSeconds(t) - head.timestamp;
  t.result.health.headLagSeconds = lag;
  const max = t.policy.maxHeadLagSeconds;
  if ((max > 0n && (lag > max || -lag > max)) || (state.maxHeadSeen !== null && head.number < state.maxHeadSeen)) {
    t.stale = true;
    wait(t, "stale-head", 0, null, null);
    return finish(t);
  }
  state.maxHeadSeen = head.number;
  await sampleFees(t);
  // Whether `rewardTo` may be paid inside each release's community windows, at this head; and, whatever the
  // answer, when its proof lapses, in the log.
  await readEligibility(t);
  logEligibility(t);

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

  // 9. Windows that ended without a buy; then, one at a time, an unwrap or a proof.
  checkMissedWindows(t);
  if (keeper !== null && !state.pending) await maybeUnwrap(t);
  if (keeper !== null && !state.pending) await maybeProve(t);
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
  // A rebuild judges community windows by eligibility at this head, as a tick's does.
  await readEligibility(t);
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
  // From this tick on, every transaction mined is in `spend`: what runway is measured over.
  state.spendSince ??= head.timestamp;
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
  return {
    ok: true,
    headLagSeconds: 0n,
    active: 0,
    due: 0,
    pending: null,
    lastBatchHash: null,
    lastBatchAt: null,
    balanceWei: null,
    runwayDays: null,
    attention: [],
    eligible: null,
    proofValidUntil: null,
    proofDaysLeft: null,
  };
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
  /** The slot's deadline: from here the buy is sent whatever the fee — once outside any community window. */
  deadline: bigint;
  /**
   * In the urgent tail of a community window this keeper may be paid in; or,
   * outside one, past the slot's deadline. Inside the window the slot's
   * deadline counts for nothing: an operator's `deadlineShareBps` above a
   * quarter can put it inside the window, and the window's own urgent point
   * comes before the slot ends anyway.
   */
  urgent: boolean;
  /** In the urgent tail of a community window this keeper may be paid in (decision 19). */
  windowUrgent: boolean;
  /**
   * Whether this buy is bid at the urgent tip: in a window's urgent tail, or
   * past its slot's deadline unless the plan is short (its deadline is minutes
   * off anyway). The tail is urgent whatever the plan, since after it anyone
   * may take the buy: the 5-minute plan's 75-second window has an 18-second
   * tail.
   */
  hurried: boolean;
  shortInterval: boolean;
  target: bigint | null;
  reason: SendReason | null;
  /** The community window the buy is inside, when this keeper may be paid there; null for v1, after the window, or not due. */
  community: { dueSince: bigint; endsAt: bigint; urgentAt: bigint } | null;
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
  /** Each vault's community window's end, when it is sent inside one. */
  communityEnds: Map<Address, bigint>;
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
        communityWindowEndsAt: plan.communityEnds.get(v.vault) ?? null,
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

/** A batch's transaction, by hand: its release's batcher, its own gas limit, paying `rewardTo`, at the configured gas per vault. */
function batchTx(t: Tick, plan: SendPlan, nonce: number): ReturnType<typeof buildTransaction> {
  const vaults = plan.selection.vaults.map((v) => v.vault);
  return buildTransaction({
    from: t.keeper!,
    chainId: t.config.chainId,
    nonce,
    to: lower(plan.deployment.batcher),
    data: encodeBatchFor(plan.deployment, vaults, t.rewardTo!, plan.selection.minRewards, gasPerVaultOf(t.config, plan.deployment)),
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
  // Nothing else to send, and due buys left to SPX holders until their windows end: the keeper waits for those ends.
  const nothingFor = (candidates: number): Plan => {
    const heldBack = [...t.outcomes.values()].filter((o) => o !== "ok" && o.code === "holders-first").length;
    return candidates > 0 ? waitFor("not-cheap", candidates) : waitFor(heldBack > 0 ? "holders-first" : null, heldBack);
  };
  if (t.debug) t.emit({ type: "tick", nextBaseFeeWei: t.next, lowestTargetWei: lowestTarget, active: Object.keys(state.vaults).length, clockDue: clockDue.length, candidates: dues.length });
  // Until the reads below, the vaults due by the clock are the best count there is.
  t.result.health.due = dues.length;
  const triggered = rebuild !== null || dues.some((d) => d.reason !== null) || (policy.sendWhen === "now" && unread.length > 0);
  if (!triggered) return nothingFor(dues.length);

  // 6: read what is about to be sent: progress, balance and price; and prove each vault never sent before is its
  // factory's clone, whatever the endpoint says (`proveClones`).
  const reads = await readVaults(t.rpc, t.config.weth, clockDue, true);
  await proveClones(t, clockDue);
  const candidates: (BatchCandidate & { due: Due })[] = [];
  const quotes = new Map<Address, VaultProgress["quote"]>();
  for (const vault of clockDue) {
    const read = reads.get(vault);
    if (!read || !applyRead(t, vault, read)) continue;
    if (t.state.vaults[vault]?.nonce === null) {
      // Never sent before it is proven: `proveClones` said why, or reaches it on a later tick.
      if (!t.outcomes.has(vault)) noteSkip(t, vault, "unproven", "not yet proven its factory's clone; proven before it is first sent");
      continue;
    }
    quotes.set(vault, read.quote);
    const due = dueOf(t, vault);
    if (due === null || t.chainTime < due.earliest) {
      t.outcomes.set(vault, "ok");
      continue;
    }
    // The read may show what the cache did not: a new slot, and its window.
    if (holdersFirst(t, vault, due.entry)) continue;
    const candidate = candidateOf(t, due, read);
    if (candidate) candidates.push(candidate);
  }
  t.result.health.due = candidates.length;

  // A standby keeper sends only what is about to miss its window, or its community window.
  const sendable = policy.sendWhen === "deadline" ? candidates.filter((c) => c.urgent) : candidates;
  const reasons = sendable.map((c) => c.due.reason).filter((r): r is SendReason => r !== null);
  if (sendable.length === 0 || (rebuild === null && reasons.length === 0)) return nothingFor(sendable.length);

  // Each batch goes to its release's batcher, one release a batch: the one with the most urgent need first. (Releases
  // sharing a batcher are still sent one a batch: the transaction in flight names one release.)
  const byDeployment = new Map<string, typeof sendable>();
  for (const c of sendable) byDeployment.set(c.due.entry.deployment, [...(byDeployment.get(c.due.entry.deployment) ?? []), c]);
  const [deploymentId, group] = [...byDeployment.entries()].sort(([, a], [, b]) => Number(b.some((c) => c.urgent)) - Number(a.some((c) => c.urgent)) || b.length - a.length)[0]!;
  const deployment = t.config.deployments.find((d) => d.id === deploymentId)!;

  // A batch is bid at the urgent tip when any buy in it is hurried (`Due.hurried`); a buy inside a community window,
  // before its tail, is not, and is never bid up against other holders (decision 19). So the two never share a
  // transaction: a hurried buy would lend its tip to the patient one, at the first send and at every resend. The
  // hurried go first, with whatever else is due outside a window; the patient wait for the next transaction, unless
  // the hurried can't pay their way alone, when the patient go instead. With nothing hurried, one batch carries all,
  // and waits patiently as one (`waitsPatiently`).
  const patient = group.filter((c) => c.due.community !== null && !c.due.hurried);
  const pools = group.some((c) => c.due.hurried) && patient.length > 0 ? [group.filter((c) => !patient.includes(c)), patient] : [group];

  const reserves = t.config.privateSend ? new Map<Address, bigint | null>() : await readReserves(t.rpc, t.config.weth, group.map((c) => c.due.entry.terms));
  const selectingAt = (tip: bigint) => {
    const feePerGas = economicFeePerGas(t.next, tip, policy, state.breakerOpen);
    return (candidates: readonly BatchCandidate[]) =>
      selectBatch({
        candidates,
        feePerGas,
        ratioPpm: state.gasModel.ratioPpm,
        privateSend: t.config.privateSend,
        pairReserves: reserves,
        ownerSubsidised24h: subsidisedBy(t, "owner"),
        dailyLossLeft: dailyLossLeft(t),
        policy,
      });
  };
  let chosen: { pool: typeof group; selection: BatchSelection; urgent: boolean; priced: { fees: PreparedFees; tip: bigint } } | null = null;
  let blocked: "fees-above-max" | "resend-blocked" | null = null;
  for (const pool of pools) {
    const urgent = pool.some((c) => c.due.hurried);
    const priced = options.pricing(urgent);
    if (priced === "fees-above-max" || priced === "resend-blocked") {
      // The urgent tip above the cap need not hold back what goes at the patient one.
      blocked ??= priced;
      continue;
    }
    const select = selectingAt(priced.tip);
    let selection = select(pool);
    noteSelectionSkips(t, selection);
    if (selection.vaults.length === 0) continue;
    // Too big for one transaction: the first of the fewest chunks that fit, each paying its own way.
    const chunks = splitRoundRobin([...selection.vaults].sort((a, b) => (a.marginWei > b.marginWei ? -1 : a.marginWei < b.marginWei ? 1 : 0)), policy);
    if (chunks.length > 1) {
      selection = select(chunks[0]!);
      if (selection.vaults.length === 0) continue;
    }
    chosen = { pool, selection, urgent, priced };
    break;
  }
  if (chosen === null) return waitFor(blocked ?? "economics", group.length);
  const { urgent, priced } = chosen;
  let { selection } = chosen;
  // The most pressing reason any vault it carries gives; a rebuild that none gives keeps its first send's.
  const poolReasons = chosen.pool.map((c) => c.due.reason).filter((r): r is SendReason => r !== null);
  const reason: SendReason =
    (["deadline", "now", "window", "short-interval"] as const).find((r) => poolReasons.includes(r)) ?? poolReasons[0] ?? rebuild?.reason ?? "deadline";
  const communityEnds = new Map(chosen.pool.flatMap((c) => (c.due.community === null ? [] : [[c.vault, c.due.community.endsAt] as const])));
  const select = selectingAt(priced.tip);

  // 8: simulate at the fee it will pay, at most twice.
  const gasPerVault = gasPerVaultOf(t.config, deployment);
  for (let round = 1; round <= 2; round++) {
    const gasLimit = batchGasLimit(selection.vaults, gasPerVault);
    const simulation = await simulate(t, deployment, selection, gasLimit, priced.fees);
    if (simulation === null) return waitFor(null, group.length);
    const refusedHere = simulation.outcomes.filter((o) => !o.bought);
    if (simulation.kind === "ok" && refusedHere.length === 0) {
      for (const v of selection.vaults) t.outcomes.set(v.vault, "ok");
      return { kind: "send", deployment, selection, gasLimit, fees: priced.fees, reason, urgent, quotes, communityEnds };
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
      return { kind: "send", deployment, selection, gasLimit: batchGasLimit(selection.vaults, gasPerVault), fees: priced.fees, reason, urgent, quotes, communityEnds };
    }
  }
  return waitFor(null, 0);
}

/**
 * Which vaults the cache says are due by the clock, with no RPC: not resting,
 * not trapped, not waiting to be rechecked, funded as last read, and not
 * inside a community window this keeper may not be paid in. A vault never
 * read is included, to be read. Retired vaults are gone from the cache.
 */
function clockFilter(t: Tick): Address[] {
  const { state } = t;
  const due: Address[] = [];
  for (const [vault, e] of entries(state.vaults)) {
    const trap = state.trapped[vault];
    if (trap) {
      const deployment = t.config.deployments.find((d) => d.id === e.deployment);
      // Another batcher, or another gas per vault, and the trap no longer says what this keeper's batch would do.
      const moved = deployment !== undefined && (lower(deployment.batcher) !== trap.batcher || gasPerVaultOf(t.config, deployment) !== trap.cap);
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
    if (holdersFirst(t, vault, e)) continue;
    due.push(vault);
  }
  return due;
}

/**
 * A due buy inside a community window this keeper's `rewardTo` may not be
 * paid in — not eligible, or eligibility unknown — is left to SPX holders: a
 * `holders-first` skip, until the window ends, when anyone may make it. One it
 * may be paid in, but inside another bucket's turn (`turnHeldUntil`), is left
 * to that bucket's holders: an `other-turn` skip, until the turn ends, when any
 * eligible holder may make it. The tick after is planned for that moment
 * (`finish`). True when it is.
 */
function holdersFirst(t: Tick, vault: Address, e: VaultEntry): boolean {
  if (mayBePaidInWindow(t, e)) {
    const turnEnds = turnHeldUntil(t, vault, e);
    if (turnEnds === null) return false;
    noteSkip(t, vault, "other-turn", `holders in another bucket have first claim until ${turnEnds} (chain time)`);
    return true;
  }
  const until = holdersFirstUntil(e, t.chainTime);
  if (until === null) return false;
  noteSkip(t, vault, "holders-first", `SPX holders have first claim until ${until} (chain time)`);
  return true;
}

/**
 * A read vault's window, deadline and send reason; null when it has not been
 * read or has no buys left. A due v2 buy inside a community window this
 * keeper may be paid in goes as soon as it is due ("window"), at the patient
 * tip until the window's urgent tail, and urgently in it — whatever its slot's
 * deadline says, which only counts once the window is over.
 */
function dueOf(t: Tick, vault: Address): Due | null {
  const e = t.state.vaults[vault];
  if (!e || e.readAt === null) return null;
  const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
  if (earliest === null) return null;
  const window = windowOf(e.terms, earliest > t.chainTime ? earliest : t.chainTime);
  const deadline = deadlineOf(e.terms, window, t.policy);
  const shortInterval = e.terms.interval < t.policy.shortIntervalSeconds;
  const open = communityWindowOf(e, t.chainTime);
  const community = open !== null && t.chainTime >= earliest && t.chainTime < open.endsAt && mayBePaidInWindow(t, e) ? open : null;
  const windowUrgent = community !== null && t.chainTime >= community.urgentAt;
  const urgent = community !== null ? windowUrgent : t.chainTime >= deadline;
  const hurried = windowUrgent || (urgent && !shortInterval);
  const from = window.windowStart > earliest ? window.windowStart : earliest;
  const target = cheapTarget({ samples: t.state.feeSamples, chainTime: t.chainTime, from, deadline, interval: e.terms.interval }, t.policy);
  const reason = t.chainTime >= earliest ? shouldSend({ urgent, shortInterval, target, inCommunityWindow: community !== null }, t.next, t.policy) : null;
  return { vault, entry: e, earliest, window, deadline, urgent, windowUrgent, hurried, shortInterval, target, reason, community };
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
    // Inside a community window, its end is the deadline that counts: after it, anyone may take the buy.
    deadline: due.community !== null ? due.community.endsAt : due.deadline,
    subsidised24h: subsidisedBy(t, "vault").get(due.vault) ?? 0n,
    // Its release, by the factory that vouches for it: what its gas and its proposed fee are judged by.
    release: e.deployment as VaultRelease,
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
    data: encodeBatchFor(deployment, vaults, rewardTo, selection.minRewards, gasPerVaultOf(t.config, deployment)),
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
 * not vouch for it after all; `rewardTo` is not eligible after all, so its
 * release's eligibility counts as unknown for the rest of the tick (every
 * tick reads it again) and the buy is left to holders until its community
 * window ends; or something that should not happen to a listed vault, so
 * rest it for the window. A simulation never traps: an endpoint that strips
 * revert data is an honest cause.
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
    case "NotEligible": {
      const read = t.state.eligibility[e.deployment];
      if (read) read.eligible = null;
      e.restingUntil = holdersFirstUntil(e, t.chainTime) ?? communityWindowOf(e, t.chainTime)?.endsAt ?? windowOf(e.terms, t.chainTime).windowEnd;
      return;
    }
    case "NotYourTurn": {
      // Eligible, but another bucket's turn: back when the turn ends, when any eligible holder may be paid; or, when
      // this keeper reckoned the turn over and the vault did not, when its window ends.
      const turnEnds = turnEndsAtOf(e.terms, e.buysDone, e.lastBuyAt, t.chainTime);
      e.restingUntil =
        turnEnds !== null && turnEnds > t.chainTime ? turnEnds : (communityWindowOf(e, t.chainTime)?.endsAt ?? windowOf(e.terms, t.chainTime).windowEnd);
      return;
    }
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
 * its resend interval has passed: an unwrap, a deployment, a proof or a
 * cancel is the same transaction bid higher (a proof that can no longer do
 * anything is withdrawn instead, `proofWithdrawal`); a batch is reselected
 * from fresh reads, and one no longer worth sending is cancelled in the
 * public pool or left to expire through a private relay.
 *
 * A batch sent patiently, carrying a buy inside its community window and
 * nothing hurried, is left as it is — broadcast again every tick, never bid
 * up against other holders — until a buy in it is hurried: its window's
 * urgent point, or, for a buy riding along outside any window, its slot's
 * deadline (decision 19; `waitsPatiently`). A holder that bids higher may
 * still win; that is the race the window runs, and a lost one through a
 * private relay costs nothing. So that a lost race does not hold the
 * keeper's one transaction in flight until then, each resend reads the
 * batch's own vaults (no prices): a buy another keeper made ends the wait,
 * and the batch is rebuilt without it, or withdrawn, as any other.
 */
async function resend(t: Tick, p: PendingTx): Promise<void> {
  const last = p.attempts.at(-1)!;
  const replace = (urgent: boolean) => replacementFees(last.fees, { next: t.next, urgent, resends: p.resends + 1 }, t.policy);

  if (p.purpose === "batch" && last.kind === "batch" && !p.urgent && waitsPatiently(t, p)) {
    const reads = await readVaults(t.rpc, t.config.weth, p.vaults, false);
    for (const vault of p.vaults) {
      const read = reads.get(vault);
      if (read) applyRead(t, vault, read);
    }
    if (waitsPatiently(t, p)) return;
  }

  // A proof that can no longer do what it was sent for is withdrawn, never bid up: its block about to leave the
  // registry's reach (built again from a newer block next time), a proof as new already recorded — someone else's
  // of the same holder, which a revert-protected relay would never include, holding every batch behind it for
  // hours — or proving turned off since it was sent, which the keeper may no longer sign.
  if (p.purpose === "prove" && last.kind === "prove") {
    const why = proofWithdrawal(t, p, last);
    if (why !== null) {
      if (why.skip !== null) {
        t.state.lastProveSkip = `${p.deployment}:${why.skip}`;
        t.emit({ type: "prove_skipped", deployment: p.deployment ?? "", holder: why.holder, reason: why.skip, detail: why.detail });
      }
      if (t.config.privateSend) {
        p.stoppedResending = true;
        await t.persist();
        return;
      }
      const fees = replace(false);
      if (fees === null) return t.emit({ type: "resend_blocked", batchId: p.batchId, nonce: p.nonce, why: "fee-cap" });
      const tx = buildTransaction({ from: t.keeper!, chainId: t.config.chainId, nonce: p.nonce, to: t.keeper!, data: "0x", gas: CANCEL_GAS, fees });
      const { attempt } = await send(t, p, tx, "cancel");
      p.resends += 1;
      t.emit({ type: "batch_cancel_sent", batchId: p.batchId, nonce: p.nonce, hash: attempt.hash });
      return;
    }
  }

  // An unwrap, a deployment, a proof or a cancel: the same transaction, bid higher.
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

/**
 * Why a proof in flight is to be withdrawn rather than sent again, bid
 * higher; null when it may still do what it was sent for. Judged at this
 * head, from this tick's read of the registry (`readEligibility`), with no
 * request of its own:
 *
 * - its block is about to leave the 8,191 the registry can check
 *   (`PROVE_STALE_BLOCKS`);
 * - the registry already records `rewardTo` as proven at least as long as
 *   this proof would (`not-newer`): it would revert `NotNewer`, which a
 *   private relay never includes, and the keeper's one transaction in flight
 *   would wait out the 7,000 blocks behind it;
 * - the keeper may no longer sign it again (`assertKeeperMaySign`): proving
 *   is off (`off`), or `rewardTo` is another address since a restart
 *   (`other-holder`). Refusing to sign is right; failing every tick over it
 *   until the proof lands or goes stale is not.
 *
 * `skip` is the `prove_skipped` reason it is logged with, if any. Through a
 * private relay "withdrawn" means not sent again, and left to expire.
 */
function proofWithdrawal(t: Tick, p: PendingTx, last: PendingAttempt): { skip: ProveSkipReason | null; holder: Address; detail: string } | null {
  const sent = proofSent(last.raw);
  const holder = sent?.holder ?? t.rewardTo ?? ZERO;
  if (!t.config.prove) return { skip: "off", holder, detail: "proving was turned off while a proof was in flight: it is not sent again" };
  if (sent === null || sent.holder !== t.rewardTo) {
    return { skip: "other-holder", holder, detail: `the proof in flight is not of rewardTo, ${t.rewardTo}, now: it is not sent again` };
  }
  if (p.proveBlock !== null && t.block - p.proveBlock >= PROVE_STALE_BLOCKS) return { skip: null, holder, detail: "" };
  const read = p.deployment === null ? undefined : t.state.eligibility[p.deployment];
  if (read !== undefined && read.readAt === t.chainTime && read.holder === holder && read.validUntil !== null && sent.until !== null && read.validUntil >= sent.until) {
    return { skip: "not-newer", holder, detail: `a proof valid until ${read.validUntil} is already recorded; this one, until ${sent.until}, would revert` };
  }
  return null;
}

/**
 * Whose proof a signed `prove` carries, and until when it would make them
 * eligible (its header's time and 30 days; null when the header can't be
 * read); null when it is not a `prove` at all.
 */
function proofSent(raw: Hex): { holder: Address; until: bigint | null } | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data: parseTransaction(raw).data ?? "0x" });
    if (functionName !== "prove") return null;
    const header = parseHeaderRlp(String(args[1]));
    return { holder: lower(String(args[0])), until: header === null ? null : header.timestamp + PROOF_TTL };
  } catch {
    return null;
  }
}

/**
 * Whether a batch in flight waits as it was sent: it carries a buy inside a
 * community window this keeper may be paid in, every buy it carries is still
 * due, and none is hurried — none in its window's urgent tail, none past its
 * slot's deadline (`Due.hurried`). A buy open to anyone that rides with a
 * patient one waits with it, unbid, until something in the batch is hurried:
 * replacing the batch at all would bid the patient buy up too, 12.5% a
 * resend. By the cache: `resend` reads the batch's own vaults first, so a buy
 * another keeper made ends the wait.
 */
function waitsPatiently(t: Tick, p: PendingTx): boolean {
  if (p.vaults.length === 0) return false;
  const dues = p.vaults.map((vault) => dueOf(t, vault));
  if (dues.some((due) => due === null || t.chainTime < due.earliest || due.hurried)) return false;
  return dues.some((due) => due!.community !== null);
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

// ─── The SPX holder registry ──────────────────────────────────────────────────

/**
 * An `eligibility` record for each release with a registry, from this tick's
 * read: when anything in it changes, and once a day of chain time besides —
 * so the log says when `rewardTo`'s proof lapses, and how many days are left,
 * whether or not this keeper proves it.
 */
function logEligibility(t: Tick): void {
  const reads = t.config.deployments.flatMap((d) => {
    const read = t.state.eligibility[d.id];
    return read !== undefined && read.readAt === t.chainTime ? [{ d, read }] : [];
  });
  if (reads.length === 0) return;
  const said = reads.map(({ d, read }) => `${d.id}:${read.eligible}:${read.validUntil}:${whyNotEligible(read, t.chainTime)}`).join(",");
  const daily = t.state.eligibilityLoggedAt === null || t.chainTime >= t.state.eligibilityLoggedAt + DAY;
  if (said === t.state.lastEligibility && !daily) return;
  t.state.lastEligibility = said;
  t.state.eligibilityLoggedAt = t.chainTime;
  for (const { d, read } of reads) {
    t.emit({
      type: "eligibility",
      deployment: d.id,
      registry: read.registry,
      rewardTo: read.holder,
      eligible: read.eligible,
      validUntil: read.validUntil,
      daysLeft: daysLeft(read.validUntil, t.chainTime),
      spxWei: read.spx,
      minSpxWei: MIN_SPX,
      isAccount: read.isAccount,
      reason: whyNotEligible(read, t.chainTime),
    });
  }
}

/**
 * Why a read is not eligible, as `readHolderStatus` says it: a contract
 * first, which no proof can fix, then the registry's own order; null when
 * eligible, or unknown.
 */
function whyNotEligible(read: Eligibility, chainTime: bigint): string | null {
  if (read.eligible === true || read.isAccount === null) return null;
  if (!read.isAccount) return "contract";
  if (read.validUntil === null) return null;
  if (read.validUntil === 0n) return "not-proven";
  if (chainTime > read.validUntil) return "lapsed";
  if (read.spx !== null && read.spx < MIN_SPX) return "below-minimum";
  return null;
}

/** This machine's clock, in whole seconds: what the bounds on proving are kept on, never the endpoint's. */
const wallSeconds = (t: Pick<Tick, "wallClockMs">): bigint => BigInt(Math.floor(t.wallClockMs() / 1000));

/** A proof this keeper sent was reported reverted less than a day ago, by the wall clock: no other is sent until the day is out. */
const proveBackingOff = (t: Tick): boolean => t.state.proveRevertedAt !== null && wallSeconds(t) < t.state.proveRevertedAt + PROVE_REVERT_BACKOFF_SECONDS;

/** Days from `chainTime` to a proof's lapse, to a tenth, negative once past; null when unknown or never proved. */
function daysLeft(validUntil: bigint | null, chainTime: bigint): number | null {
  if (validUntil === null || validUntil === 0n) return null;
  return Number(((validUntil - chainTime) * 10n) / DAY) / 10;
}

/**
 * With `SPDEX_KEEPER_PROVE=1`, prove `rewardTo`'s SPX to a release's registry
 * once its proof has `PROOF_LAPSE_WARNING_SECONDS` (five days) or less left,
 * or it never proved, and only when no other transaction is in flight. By
 * this machine's clock, never the endpoint's (`PROVE_SPACING_SECONDS`): at
 * most one try an accounting period, at most one proof sent a day, and none
 * for a day after one reverted (`PROVE_REVERT_BACKOFF_SECONDS`). The keeper
 * signs it through the nonce manager like any other, and
 * `assertKeeperMaySign` allows it for the configured `rewardTo` alone.
 */
async function maybeProve(t: Tick): Promise<void> {
  const { state, policy } = t;
  if (!t.config.prove || t.keeper === null || t.rewardTo === null || state.pending) return;
  const now = wallSeconds(t);
  if (state.proveTriedAt !== null && now < state.proveTriedAt + policy.accountingSeconds) return;
  if (state.proveSentAt !== null && now < state.proveSentAt + PROVE_SPACING_SECONDS) return;
  if (proveBackingOff(t)) return;
  for (const d of t.config.deployments) {
    const read = d.registry === null ? undefined : state.eligibility[d.id];
    // Unread at this head, or no registry on this chain: nothing to prove to.
    if (read === undefined || read.readAt !== t.chainTime || read.validUntil === null) continue;
    if (read.validUntil > t.chainTime + PROOF_LAPSE_WARNING_SECONDS) continue;
    state.proveTriedAt = now;
    await proveTo(t, d, read);
    return;
  }
}

/**
 * One `prove`: the proof built from the `finalized` block, whose header is
 * rebuilt and must hash to that block's hash, and checked against its state
 * root before anything is signed (`buildHolderProof`); one that would not
 * move `validUntil` is never sent (the registry would revert `NotNewer`); its
 * gas limit is its estimate and a fifth (`proveGasLimit`), which is its
 * test-run too; and it is bid at the patient tip. Every reason it is not sent
 * is a `prove_skipped`, logged once until the reason changes.
 */
async function proveTo(t: Tick, d: Deployment, read: Eligibility): Promise<void> {
  const { state } = t;
  const holder = t.rewardTo!;
  const keeper = t.keeper!;
  const skip = (reason: Extract<KeeperLogBody, { type: "prove_skipped" }>["reason"], detail: string) => {
    const said = `${d.id}:${reason}`;
    if (state.lastProveSkip === said) return;
    state.lastProveSkip = said;
    t.emit({ type: "prove_skipped", deployment: d.id, holder, reason, detail });
  };
  if (read.isAccount === false) return skip("contract", "the registry pays only an account; rewardTo has code");
  let proof: HolderProof;
  try {
    proof = await buildHolderProof(t.rpc, holder, { block: "finalized" });
  } catch (error) {
    if (error instanceof HoldingBelowMinimumError) return skip("below-min-spx", messageOf(error));
    if (error instanceof HeaderHashMismatchError) return skip("header-mismatch", messageOf(error));
    // `eth_getProof` refused (`ProofUnavailableError`), or a proof that is not of that block's state: the endpoint
    // cannot serve a proof this keeper would send. Tried again next accounting period, and said once.
    return skip("unsupported", messageOf(error));
  }
  if (proof.validUntil <= read.validUntil!) return skip("not-newer", `a proof valid until ${read.validUntil} is already recorded`);
  const call = proveCall(proof, lower(d.registry!));
  let estimate: bigint;
  try {
    estimate = BigInt((await t.rpc("eth_estimateGas", [{ from: keeper, to: call.to, data: call.data, value: "0x0" }])) as string);
  } catch (error) {
    const data = revertDataOf(error);
    if (data === null) throw error;
    const named = decodeVaultError(data);
    return skip(named?.name === "NotNewer" ? "not-newer" : "refused", describeRegistryError(named) ?? named?.name ?? data.slice(0, 10));
  }
  let gas: bigint;
  try {
    gas = proveGasLimit(estimate);
  } catch (error) {
    return skip("gas", messageOf(error));
  }
  const chosen = chooseFees({ next: t.next, legacy: t.legacy, urgent: false }, t.policy);
  if ("blocked" in chosen) return skip("fees-above-max", "network fees are above the policy's cap");
  const balance = BigInt((await t.rpc("eth_getBalance", [keeper, "latest"])) as string);
  state.balanceWei = balance;
  if (balance < gas * maxFeePerGasOf(chosen.fees)) return skip("low-balance", "the key cannot pay for the proof at its highest price");

  const nonce = await nextNonceFor(t.rpc, keeper, state);
  const pending = newPendingTx(state, keeper, nonce, "prove", { deployment: d.id, gasLimit: gas, proveBlock: proof.blockNumber });
  // Counted before it is broadcast, with the state persisted before the broadcast: a crash never forgets one went.
  state.proveSentAt = wallSeconds(t);
  const tx = buildTransaction({ from: keeper, chainId: t.config.chainId, nonce, to: call.to, data: call.data, gas, fees: chosen.fees });
  const { attempt, refused } = await send(t, pending, tx, "prove");
  state.lastProveSkip = null;
  t.emit({
    type: "prove_sent",
    batchId: pending.batchId,
    hash: attempt.hash,
    deployment: d.id,
    registry: call.to,
    holder,
    provenBlock: proof.blockNumber,
    gasLimit: gas,
    maxFeePerGas: maxFeePerGasOf(chosen.fees),
    maxPriorityFeePerGas: tipOf(chosen.fees),
    validUntil: proof.validUntil,
  });
  if (refused) t.emit({ type: "error", where: "send", message: `${refused.kind}: ${refused.message}` });
  if (t.waitForReceiptMs > 0) await awaitReceipt(t);
}

// ─── The end of a tick ────────────────────────────────────────────────────────

function finish(t: Tick): KeeperTickResult {
  const { state, result, policy } = t;
  reconcileSkips(t);
  const upcoming = entries(state.vaults).map(([vault, e]) => ({ vault, nextBuyAt: e.readAt === null ? null : earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt) }));
  result.upcoming = upcoming;

  // The next tick: the nearest deadline, due time, resend, community window's urgent point or end, within [12 s, interval].
  const moments: bigint[] = [];
  for (const [vault, e] of entries(state.vaults)) {
    const due = dueOf(t, vault);
    if (!due) continue;
    if (due.earliest > t.chainTime) moments.push(due.earliest);
    if (due.deadline > t.chainTime) moments.push(due.deadline);
    if (due.community !== null && due.community.urgentAt > t.chainTime) moments.push(due.community.urgentAt);
    // Left to holders, or to another bucket's: back when they no longer have first claim.
    const opens = mayBePaidInWindow(t, e) ? turnHeldUntil(t, vault, e) : holdersFirstUntil(e, t.chainTime);
    if (opens !== null && opens > t.chainTime) moments.push(opens);
  }
  const p = state.pending;
  if (p) moments.push(t.chainTime + SECONDS_PER_BLOCK * 2n);
  const soonest = minOrNull(moments);
  const seconds = soonest === null ? policy.intervalSeconds : Number(soonest - t.chainTime);
  result.nextTickSeconds = Math.min(Math.max(seconds, MIN_TICK_SECONDS), policy.intervalSeconds);

  state.spend = state.spend.filter(([at]) => at > t.chainTime - WEEK);
  const spentWeek = state.spend.reduce((sum, [, cost]) => sum + cost, 0n);
  // Runway is the spend over the time it covers: since the keeper began keeping it, at most the last week. A keeper
  // a day old is not taken to have spent a day's worth in a week (seven times the runway it has); one younger than a
  // day has too little to say, and its runway is unknown.
  const since = minOrNull([state.spendSince, ...state.spend.map(([at]) => at)]);
  const covered = since === null || since < t.chainTime - WEEK ? WEEK : t.chainTime - since;
  const runwayDays =
    state.balanceWei === null || spentWeek === 0n || covered < DAY ? null : Number((state.balanceWei * covered * 10n) / (spentWeek * DAY)) / 10;
  const lowRunway = runwayDays !== null && policy.minRunwayDays > 0 && runwayDays < policy.minRunwayDays;
  if (lowRunway && !state.lowRunway) {
    t.emit({ type: "low_runway", runwayDays: runwayDays!, thresholdDays: policy.minRunwayDays, etherWei: state.balanceWei!, spentWeekWei: spentWeek });
  }
  if (runwayDays !== null) state.lowRunway = lowRunway;
  // The latest release's registry is the one new vaults ask; its read is what the heartbeat reports.
  const latest = [...t.config.deployments].reverse().find((d) => d.registry !== null);
  const kept = latest === undefined ? undefined : state.eligibility[latest.id];
  // Another rewardTo's figures, from before a restart with a new one, say nothing about this one.
  const read = kept?.holder === t.rewardTo ? kept : undefined;
  const fresh = read !== undefined && read.readAt === t.chainTime;
  const attention: string[] = [];
  if (state.lowBalance) attention.push("low_balance");
  if (state.lowRunway) attention.push("low_runway");
  if (fresh && read.validUntil !== null && read.validUntil > 0n && t.chainTime <= read.validUntil && read.validUntil - t.chainTime <= PROOF_LAPSE_WARNING_SECONDS) {
    attention.push("proof_lapsing");
  }
  // Only for an operator who means to be eligible: one who once proved, or proves.
  if (fresh && read.eligible === false && ((read.validUntil ?? 0n) > 0n || t.config.prove)) attention.push("not_eligible");
  if (proveBackingOff(t)) attention.push("prove_reverted");
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
    runwayDays,
    attention,
    eligible: fresh ? read.eligible : null,
    proofValidUntil: read?.validUntil ?? null,
    proofDaysLeft: daysLeft(read?.validUntil ?? null, t.chainTime),
  };
  return result;
}

// ─── Deploying a batcher ──────────────────────────────────────────────────────

/**
 * Deploy every listed release's batcher whose factory is on this chain and
 * whose batcher is not, through the nonce manager like any other transaction
 * (`--deploy-batcher`). Anyone may; the address is fixed by the bytecode and
 * its one argument — WETH for the batcher every release from v2 on shares,
 * v1's factory for v1's — so a second deployment, by anyone, lands nowhere
 * new, and releases that share a batcher deploy it once.
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
    // Each release's batcher from its own code — v1's frozen one for v1's factory — and only where that code lands.
    const call = batcherDeploymentOf(deployment, config.weth);
    if (call === null) throw new Error(`this build's code for ${deployment.id}'s batcher does not land at ${lower(deployment.batcher)}`);
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
