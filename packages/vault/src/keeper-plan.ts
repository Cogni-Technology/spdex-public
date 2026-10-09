/**
 * The keeper's decisions, as pure functions: when a vault's buy is due and
 * when its window closes, whether this block is cheap enough to send in, which
 * due vaults a batch should carry, how much gas to give it, and what to bid.
 *
 * Nothing here reads the chain or a clock. `keeper.ts` gathers the figures —
 * the head's base fee, each vault's terms and cached progress — and these
 * functions decide, so that every rule a keeper spends money by can be tested
 * with plain numbers.
 */

import type { Address } from "@spdex/core";
import type { PreparedFees } from "@spdex/chain";
import { BATCHER_LIMITS, CURRENT_SOURCE, DEPLOYMENTS, type SourceId } from "./artifacts.js";
import { BATCH_FIRST_BUY_EXTRA_GAS, BATCH_FIXED_GAS, FEE_TIP_REFERENCE, SOURCE_BUYS } from "./fee.js";
import type { VaultRelease } from "./index.js";

const BPS = 10_000n;
const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;

// ─── Policy ───────────────────────────────────────────────────────────────────

/**
 * How one keeper operator chooses to spend: when to send, what to bid, and how
 * much of their own money a batch may lose. Every field has a default a
 * stranger can run unchanged (`DEFAULT_KEEPER_POLICY`); `keeper-config.ts`
 * reads overrides from the environment.
 */
export interface KeeperPolicy {
  /** "cheap": wait for a cheap block until a deadline; "deadline": standby, deadlines only; "now": whenever due. */
  sendWhen: "cheap" | "deadline" | "now";
  /** The base-fee percentile a block must be at or under at a window's start… */
  cheapPercentileStart: number;
  /** …rising to this one at its deadline. */
  cheapPercentileEnd: number;
  /** A fixed target base fee, in wei; overrides the percentiles. */
  cheapBaseFee: bigint | null;
  /** Plans with a shorter interval are sent as soon as due. */
  shortIntervalSeconds: bigint;
  /** The deadline's margin before a window ends, as a share of the interval… */
  deadlineShareBps: bigint;
  /** …but at least this… */
  deadlineMinSeconds: bigint;
  /** …and at most this. */
  deadlineMaxSeconds: bigint;
  /** The tip a normal send bids, wei per gas. */
  tip: bigint;
  /** The first tip of a deadline send. */
  urgentTip: bigint;
  /** The most a deadline send's tip escalates to. */
  maxTip: bigint;
  /** Never bid more than this per gas. */
  maxFeePerGas: bigint;
  /** The margin the economics add to the next block's base fee. */
  feeMarginBps: bigint;
  /** The most a batch may plan to lose on one buy (0: no subsidy). */
  maxLossPerBuy: bigint;
  /** A circuit breaker on realised losses over 24 hours. */
  maxLossPerDay: bigint;
  maxLossPerVaultPerDay: bigint;
  maxSubsidyPerOwnerPerDay: bigint;
  /** Buys smaller than this are never subsidised… */
  subsidyMinBuy: bigint;
  /** …nor plans that buy more often than this. */
  subsidyMinInterval: bigint;
  /** Trigger vaults that pay no fee at all. */
  includeZeroReward: boolean;
  /** The largest batch, in gas; at most 16,000,000 (EIP-7825 caps a transaction at 16,777,216). */
  maxBatchGas: bigint;
  /** The most vaults in one batch; at most `BATCHER_LIMITS.MAX_VAULTS`. */
  maxVaultsPerBatch: number;
  /** A public batch's total buys on one pair, in basis points of the pair's WETH reserve. */
  maxPublicBatchBpsOfPair: bigint;
  /** The longest wait, in blocks, before a transaction not yet mined is rebuilt and resent. */
  resendAfterBlocks: number;
  /** A private send not mined after this many blocks is abandoned. */
  privateExpiryBlocks: number;
  /** Blocks a receipt must have (its own counts) before it is processed. */
  confirmations: number;
  /** How long a vault rests after a paid refusal on chain. */
  refusalRetrySeconds: bigint;
  /** Paid refusals in one window before the vault rests until the next. */
  maxPaidRefusalsPerWindow: number;
  /** A head older than this by the wall clock, or dated this much ahead of it, is stale (0: never). */
  maxHeadLagSeconds: bigint;
  /** Below this much ether the keeper warns, and unwraps its rewards if it holds them. */
  minEth: bigint;
  /**
   * Below this many days of runway — the key's ether over its last week's
   * spend — the keeper warns (`low_runway`); 0 never warns. A keeper paid at
   * a cold `rewardTo` earns nothing back into its hot key, so its gas money
   * only runs down, and its operator tops it up by hand (decision 18).
   */
  minRunwayDays: number;
  /** How long a trapped vault stays trapped, chain time. */
  trapSeconds: bigint;
  /** The longest sleep between ticks. */
  intervalSeconds: number;
  /** How often the factories' lists are read for new vaults, chain time. */
  discoverySeconds: bigint;
  /** How often every active vault is read, due or not, chain time. */
  accountingSeconds: bigint;
}

export const DEFAULT_KEEPER_POLICY: KeeperPolicy = {
  sendWhen: "cheap",
  cheapPercentileStart: 10,
  cheapPercentileEnd: 60,
  cheapBaseFee: null,
  shortIntervalSeconds: 3_600n,
  deadlineShareBps: 2_000n,
  deadlineMinSeconds: 60n,
  deadlineMaxSeconds: 7_200n,
  tip: FEE_TIP_REFERENCE,
  urgentTip: GWEI / 10n,
  maxTip: GWEI / 2n,
  maxFeePerGas: 3n * GWEI,
  feeMarginBps: 1_250n,
  maxLossPerBuy: 0n,
  maxLossPerDay: (2n * ETHER) / 1_000n,
  maxLossPerVaultPerDay: ETHER / 10_000n,
  maxSubsidyPerOwnerPerDay: (2n * ETHER) / 10_000n,
  subsidyMinBuy: (3n * ETHER) / 10_000n,
  subsidyMinInterval: 3_600n,
  includeZeroReward: false,
  maxBatchGas: 8_000_000n,
  maxVaultsPerBatch: 100,
  maxPublicBatchBpsOfPair: 10n,
  resendAfterBlocks: 10,
  privateExpiryBlocks: 25,
  confirmations: 2,
  refusalRetrySeconds: 600n,
  maxPaidRefusalsPerWindow: 2,
  maxHeadLagSeconds: 120n,
  minEth: ETHER / 100n,
  minRunwayDays: 7,
  trapSeconds: 604_800n,
  intervalSeconds: 60,
  discoverySeconds: 300n,
  accountingSeconds: 300n,
};

/** EIP-7825's per-transaction gas cap is 16,777,216; a batch stays under a round figure below it. */
export const MAX_BATCH_GAS_CEILING = 16_000_000n;

// ─── The next block's base fee ────────────────────────────────────────────────

/**
 * The base fee the next block will charge, by EIP-1559's rule: the target is
 * half the gas limit; above it the fee rises by up to 12.5% (at least 1 wei),
 * below it falls by up to 12.5%. The cheap test, the economics and the fee cap
 * all use this, not the head's own base fee: the head's block is already made.
 */
export function nextBaseFee(header: { baseFee: bigint; gasUsed: bigint; gasLimit: bigint }): bigint {
  const { baseFee, gasUsed } = header;
  const target = header.gasLimit / 2n;
  if (target === 0n || gasUsed === target) return baseFee;
  if (gasUsed > target) {
    const delta = (baseFee * (gasUsed - target)) / target / 8n;
    return baseFee + (delta > 1n ? delta : 1n);
  }
  return baseFee - (baseFee * (target - gasUsed)) / target / 8n;
}

// ─── A vault's clock ──────────────────────────────────────────────────────────

type Clock = { startAt: bigint; interval: bigint };

/**
 * The earliest the vault's next buy may happen — the vault's own
 * `_nextBuyAt` (SpdexDcaVault.sol) — or null when it has no buys left.
 * `lastBuyAt` is 0 before the first buy.
 */
export function earliestBuyAt(terms: Clock & { maxBuys: bigint }, buysDone: bigint, lastBuyAt: bigint): bigint | null {
  if (buysDone >= terms.maxBuys) return null;
  if (lastBuyAt === 0n) return terms.startAt;
  const nextWindow = terms.startAt + ((lastBuyAt - terms.startAt) / terms.interval + 1n) * terms.interval;
  const spaced = lastBuyAt + terms.interval / 2n;
  return nextWindow > spaced ? nextWindow : spaced;
}

export interface BuyWindow {
  /** The window's number, as `Bought.slot` counts it. */
  slot: bigint;
  windowStart: bigint;
  windowEnd: bigint;
}

/** The window containing `at` (the first, before the start). */
export function windowOf(terms: Clock, at: bigint): BuyWindow {
  const slot = at <= terms.startAt ? 0n : (at - terms.startAt) / terms.interval;
  const windowStart = terms.startAt + slot * terms.interval;
  return { slot, windowStart, windowEnd: windowStart + terms.interval };
}

/**
 * When a keeper should stop waiting for a cheap block and pay what it takes:
 * a margin before the window closes, a share of the interval within bounds —
 * about two hours for a daily plan, twelve minutes for an hourly one, a minute
 * for a five-minute one.
 */
export function deadlineOf(terms: Clock, window: BuyWindow, policy: KeeperPolicy): bigint {
  let margin = (terms.interval * policy.deadlineShareBps) / BPS;
  if (margin < policy.deadlineMinSeconds) margin = policy.deadlineMinSeconds;
  if (margin > policy.deadlineMaxSeconds) margin = policy.deadlineMaxSeconds;
  return window.windowEnd - margin;
}

// ─── The community window ─────────────────────────────────────────────────────
//
// v2's vaults give SPX holders first claim on each buy's fee: from the moment a
// buy falls due (`dueSince`) and for the plan's `communityWindow` seconds, the
// fee may be paid only to the vault's owner or to an address the SPX holder
// registry finds eligible; from the window's end, to anyone (docs/DESIGN.md,
// "How a buy works"). These are the vault's own arithmetic (`_dueSince` and
// `status()` in contracts/SpdexDcaVault.sol), to the second, so the keeper, the
// app's Help run the network and Collective DCA all judge a window exactly as
// the vault will. `test/forge/Window.t.sol` pins the contract's edges; the unit
// tests here pin the same edges against these.
//
// "Window" alone keeps its meaning in this file — the buy slot a buy is made in
// (`windowOf`, `BuyWindow`) — and the new thing is always the community window.
// A v1 vault has none: its terms carry `communityWindow: null`, and every
// helper here answers accordingly.

type CommunityClock = Clock & { maxBuys: bigint; communityWindow: bigint | null };
type TurnClock = CommunityClock & { turnBuckets: bigint | null };

/**
 * The last part of a community window in which an eligible keeper stops
 * waiting patiently and bids the urgent tip (decision 19): two minutes…
 */
export const COMMUNITY_URGENT_SECONDS = 120n;

/** …or, for a window shorter than eight minutes, its last quarter. */
export const COMMUNITY_URGENT_SHORT_BELOW = 480n;

/**
 * The start of the buy slot `now` falls in: `startAt + ⌊(now − startAt) /
 * interval⌋ × interval`, the vault's own rounding; `startAt` itself before the
 * plan starts.
 */
export function slotStartAt(terms: Clock, now: bigint): bigint {
  if (now <= terms.startAt) return terms.startAt;
  return terms.startAt + ((now - terms.startAt) / terms.interval) * terms.interval;
}

/**
 * When the vault's next buy falls (or fell) due, as `status()` reports it at
 * `now`: `earliestBuyAt` while the clock doesn't allow it yet; from then on the
 * later of that and the start of the slot `now` is in, so that the first buy
 * after a missed slot gets a window of its own rather than one that ended long
 * ago (decision 10). Null when the plan has no buy left (the vault reports 0).
 *
 * For a v1 vault this is when its buy fell due too; v1 simply opens it to
 * anyone at once.
 */
export function dueSinceAt(terms: Clock & { maxBuys: bigint }, buysDone: bigint, lastBuyAt: bigint, now: bigint): bigint | null {
  const earliest = earliestBuyAt(terms, buysDone, lastBuyAt);
  if (earliest === null) return null;
  if (now < earliest) return earliest;
  const slotStart = slotStartAt(terms, now);
  return earliest > slotStart ? earliest : slotStart;
}

/**
 * The first second at which the fee of the buy due at `now` can be paid to
 * anyone: `dueSince + communityWindow`, as `status()` reports `windowEndsAt`.
 * The vault refuses an ineligible `rewardTo` while `block.timestamp` is below
 * it, strictly, so this second itself is already open. Null for a v1 vault,
 * which has no window, and when no buy is left.
 */
export function communityWindowEndsAt(terms: CommunityClock, buysDone: bigint, lastBuyAt: bigint, now: bigint): bigint | null {
  if (terms.communityWindow === null) return null;
  const dueSince = dueSinceAt(terms, buysDone, lastBuyAt, now);
  return dueSince === null ? null : dueSince + terms.communityWindow;
}

/**
 * Whether a buy made at `now` would be made inside its community window: due
 * (the clock allows it) and before the window's end — exactly when the vault
 * asks the registry about a `rewardTo` other than the owner. False for a v1
 * vault, for a plan with no buy left, and before the buy is due, when the
 * vault refuses every caller anyway (`TooSoon`).
 */
export function inCommunityWindow(terms: CommunityClock, buysDone: bigint, lastBuyAt: bigint, now: bigint): boolean {
  const earliest = earliestBuyAt(terms, buysDone, lastBuyAt);
  const endsAt = communityWindowEndsAt(terms, buysDone, lastBuyAt, now);
  return earliest !== null && endsAt !== null && now >= earliest && now < endsAt;
}

/**
 * The moment inside a community window from which an eligible keeper bids the
 * urgent tip (decision 19): `COMMUNITY_URGENT_SECONDS` before the window ends,
 * or its last quarter when the window is shorter than
 * `COMMUNITY_URGENT_SHORT_BELOW` (18 seconds of a 5-minute plan's 75). The
 * window's end is a deadline: after it, any bot may take the buy and its fee.
 */
/**
 * When the turn of the buy due at `now` ends, for a plan with turns
 * (`turnBuckets` 2 or more): `dueSince + communityWindow / 2`, the vault's own
 * figure. Until then, inside the window, only an eligible `rewardTo` in the
 * slot's bucket may be paid (`onTurn` in index.ts says whether one is; the
 * hash is not this module's to work out). Null for a plan without turns, a
 * vault with no window, and one with no buy left.
 */
export function turnEndsAtOf(terms: TurnClock, buysDone: bigint, lastBuyAt: bigint, now: bigint): bigint | null {
  if (terms.communityWindow === null || terms.turnBuckets === null || terms.turnBuckets === 0n) return null;
  const dueSince = dueSinceAt(terms, buysDone, lastBuyAt, now);
  return dueSince === null ? null : dueSince + terms.communityWindow / 2n;
}

export function urgentFrom(windowEndsAt: bigint, communityWindow: bigint): bigint {
  const tail = communityWindow < COMMUNITY_URGENT_SHORT_BELOW ? communityWindow / 4n : COMMUNITY_URGENT_SECONDS;
  return windowEndsAt - tail;
}

// ─── Waiting for a cheap block ────────────────────────────────────────────────

/** The `pct` percentile of `values` by nearest rank; null for no values. */
export function percentile(values: readonly bigint[], pct: number): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.ceil((Math.min(Math.max(pct, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/**
 * The base fee a vault waits for: a low percentile of recent base fees at the
 * start of its wait, rising linearly to a higher one at its deadline. Early in
 * a window only a really cheap block qualifies; near the deadline an ordinary
 * one does. Samples are `(chainTime, baseFee)` pairs, one a tick; the look-back
 * is the plan's interval, at least an hour. Null when there are no samples to
 * judge by, which never counts as cheap.
 */
export function cheapTarget(
  input: {
    samples: readonly (readonly [bigint, bigint])[];
    chainTime: bigint;
    /** When the wait began: the later of the window's start and the earliest buy. */
    from: bigint;
    deadline: bigint;
    interval: bigint;
  },
  policy: KeeperPolicy,
): bigint | null {
  if (policy.cheapBaseFee !== null) return policy.cheapBaseFee;
  const span = input.deadline - input.from;
  const elapsed = input.chainTime - input.from;
  const fraction = span <= 0n ? 1 : Math.min(Math.max(Number(elapsed) / Number(span), 0), 1);
  const pct = policy.cheapPercentileStart + (policy.cheapPercentileEnd - policy.cheapPercentileStart) * fraction;
  const lookBack = input.interval > 3_600n ? input.interval : 3_600n;
  const recent = input.samples.filter(([at]) => at >= input.chainTime - lookBack).map(([, fee]) => fee);
  return percentile(recent, pct);
}

/**
 * Why a batch was sent: a cheap block, a deadline (a slot's, or the last
 * minutes of a community window), a short plan, `sendWhen` "now", or a buy
 * inside its community window that this keeper may be paid for ("window").
 */
export type SendReason = "cheap" | "deadline" | "short-interval" | "now" | "window";

/**
 * Whether this vault alone justifies sending a batch now, and why; null when
 * it can wait. Short-interval plans go as soon as due: waiting minutes for a
 * cheap block rarely finds one and turns most sends into dearer deadline sends.
 *
 * A buy inside its community window that this keeper may take
 * (`inCommunityWindow`: its `rewardTo` is eligible, or is the vault's owner)
 * goes as soon as it is due too, at the patient tip: the window is when a
 * community keeper is paid ahead of everyone else, and it is short, so
 * waiting in it for a cheap block would mostly hand the buy to whoever is
 * open after it. A standby keeper (`sendWhen` "deadline") still waits, for
 * the window's urgent tail, which arrives here as `urgent`.
 */
export function shouldSend(
  vault: { urgent: boolean; shortInterval: boolean; target: bigint | null; inCommunityWindow?: boolean },
  next: bigint,
  policy: KeeperPolicy,
): SendReason | null {
  if (policy.sendWhen === "now") return "now";
  if (vault.urgent) return "deadline";
  if (policy.sendWhen === "deadline") return null;
  if (vault.inCommunityWindow === true) return "window";
  if (vault.shortInterval) return "short-interval";
  if (vault.target !== null && next <= vault.target) return "cheap";
  return null;
}

// ─── Which vaults a batch carries ─────────────────────────────────────────────

/** One due vault, as the economics see it. */
export interface BatchCandidate {
  vault: Address;
  owner: Address;
  /** Its place in its factory's list (older first); allowlisted vaults come after, by address. */
  order: bigint | null;
  pair: Address;
  amountPerBuy: bigint;
  interval: bigint;
  reward: bigint;
  /** Its first buy writes slots from zero, and costs more. */
  firstBuy: boolean;
  urgent: boolean;
  deadline: bigint;
  /** The subsidy it received in the last 24 hours. */
  subsidised24h: bigint;
  /**
   * The release whose factory made it, for the fee spDEX proposed for its
   * size when it was made (`v1BuyFee` for v1); absent, this build's. Help run
   * the network serves v2 alone and leaves it out.
   */
  release?: VaultRelease;
}

export interface SelectedVault extends BatchCandidate {
  costWei: bigint;
  marginWei: bigint;
  /** Its share of the batch's planned loss. */
  subsidyWei: bigint;
}

export interface BatchSelection {
  /** In execution order: smallest buy first. Empty when nothing should be sent. */
  vaults: SelectedVault[];
  skipped: { vault: Address; code: "economics" | "public-pair-cap"; detail: string }[];
  /** Gas by the constants alone: the batch's fixed gas and each buy's. */
  modelGas: bigint;
  /** `modelGas` scaled by the calibration ratio. */
  expectedGas: bigint;
  expectedCostWei: bigint;
  expectedEarnedWei: bigint;
  /** The loss the batch plans to take, within the subsidy's caps. */
  allowedLossWei: bigint;
  /** What the batch must earn or revert; 0 on a public send, where a revert costs the gas anyway. */
  minRewards: bigint;
}

/** Parts per million: the calibration ratio's unit (1,000,000 = the constants exactly). */
export const RATIO_ONE = 1_000_000n;

/**
 * The fee per gas a batch's economics are priced at: the next block's base fee
 * plus a margin, plus the tip it bids. While the daily loss breaker is open
 * the margin applies twice, so the keeper sends only batches that pay with
 * room to spare until the day's losses age out.
 */
export function economicFeePerGas(next: bigint, tip: bigint, policy: KeeperPolicy, breakerOpen: boolean): bigint {
  let fee = (next * (BPS + policy.feeMarginBps)) / BPS;
  if (breakerOpen) fee = (fee * (BPS + policy.feeMarginBps)) / BPS;
  return fee + tip;
}

/** The source a candidate's release was built from; the current one when it names none, or one the record lacks. */
const sourceOf = (c: { release?: VaultRelease }): SourceId =>
  (c.release === undefined ? undefined : DEPLOYMENTS.find((d) => d.id === c.release)?.source) ?? CURRENT_SOURCE;

/**
 * One buy's gas in a batch, by its source's measurement (`SOURCE_BUYS`): v1's
 * later buy is 106,000, v2's 110,000 (an in-window buy, which asks the
 * registry); a first buy costs the same 51,000 more in both.
 */
const buyGas = (c: { firstBuy: boolean; release?: VaultRelease }): bigint =>
  SOURCE_BUYS[sourceOf(c)].perBuyGas + (c.firstBuy ? BATCH_FIRST_BUY_EXTRA_GAS : 0n);

/**
 * A batch's gas by the constants alone: its fixed gas and each buy's, by its
 * release (`BatchSelection.modelGas`). The app prices "Help run the network"
 * with it before a test-run has measured the batch.
 */
export function modelBatchGas(vaults: readonly { firstBuy: boolean; release?: VaultRelease }[]): bigint {
  return vaults.reduce((sum, c) => sum + buyGas(c), BATCH_FIXED_GAS);
}

const scaled = (gas: bigint, ratioPpm: bigint): bigint => (gas * ratioPpm + RATIO_ONE - 1n) / RATIO_ONE;

/**
 * Choose the vaults a batch carries, and what it may lose.
 *
 * Each vault's margin is its fee less its own gas at `feePerGas`; the batch's
 * fixed gas is shared. The vaults that pay for themselves go in, and the batch
 * is sent only if together they also cover the fixed gas — or the subsidy
 * covers the difference. A vault whose fee falls short of its own gas rides
 * along when the others' surplus or the subsidy covers it, but only if it is
 * large enough and slow enough to be worth helping and pays the fee spDEX
 * proposed for its size when it was made — `v1BuyFee` for a v1 vault, whose
 * fee was set by v1's rule and can never change, `buyFee` for this build's: a
 * vault that set itself a token fee pays its own way or waits. Those are
 * served oldest first, so a flood of new vaults cannot crowd out the ones that
 * were there first.
 *
 * The subsidy is booked vault by vault: each is booked at most its own
 * shortfall (its gas and its share of the fixed gas, less its fee) and at most
 * what its per-buy, per-vault and per-owner caps leave, and the batch never
 * plans past what is left of the day's loss budget. So no vault is ever
 * carried on another's allowance. With the default policy nothing is
 * subsidised and no batch plans to lose money.
 *
 * A public batch also holds each pair's total buying to a sliver of its
 * reserve, because a public batch's total is what a sandwich profits from.
 */
export function selectBatch(input: {
  candidates: readonly BatchCandidate[];
  feePerGas: bigint;
  ratioPpm: bigint;
  privateSend: boolean;
  /** The WETH reserve of each pair, for public sends; null where it could not be read. */
  pairReserves: ReadonlyMap<Address, bigint | null>;
  /** Each owner's subsidy over the last 24 hours. */
  ownerSubsidised24h: ReadonlyMap<Address, bigint>;
  /** What is left of the day's loss budget; 0 while the breaker is open. */
  dailyLossLeft: bigint;
  policy: KeeperPolicy;
}): BatchSelection {
  const { feePerGas, ratioPpm, policy } = input;
  const fixedCost = scaled(BATCH_FIXED_GAS, ratioPpm) * feePerGas;
  const skipped: BatchSelection["skipped"] = [];
  const priced = input.candidates.map((c) => {
    const costWei = scaled(buyGas(c), ratioPpm) * feePerGas;
    return { ...c, costWei, marginWei: c.reward - costWei, subsidyWei: 0n };
  });
  const byMargin = (a: SelectedVault, b: SelectedVault) =>
    a.marginWei !== b.marginWei ? (a.marginWei > b.marginWei ? -1 : 1) : a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;

  // The public pair cap, in margin order.
  let eligible = priced;
  if (!input.privateSend) {
    const used = new Map<Address, bigint>();
    eligible = [];
    for (const c of [...priced].sort(byMargin)) {
      const reserve = input.pairReserves.get(c.pair) ?? null;
      const cap = reserve === null ? null : (reserve * policy.maxPublicBatchBpsOfPair) / BPS;
      const total = (used.get(c.pair) ?? 0n) + c.amountPerBuy;
      if (cap === null || total > cap) {
        skipped.push({
          vault: c.vault,
          code: "public-pair-cap",
          detail: cap === null ? "its pair's reserve could not be read" : `this batch already buys ${used.get(c.pair) ?? 0n} wei on its pair`,
        });
        continue;
      }
      used.set(c.pair, total);
      eligible.push(c);
    }
  }

  const paying = eligible.filter((c) => c.marginWei >= 0n).sort(byMargin);
  const losing = eligible.filter((c) => c.marginWei < 0n);
  const helpable = (c: BatchCandidate): boolean =>
    c.amountPerBuy >= policy.subsidyMinBuy &&
    c.interval >= policy.subsidyMinInterval &&
    c.amountPerBuy > 0n &&
    c.reward >= SOURCE_BUYS[sourceOf(c)].proposedFee(c.amountPerBuy).reward;
  const lossOf = (batch: readonly SelectedVault[]) => clampZero(fixedCost - batch.reduce((sum, c) => sum + c.marginWei, 0n));

  /**
   * Each vault's shortfall in a batch — its gas and its share of the fixed
   * gas, less its fee — and how much of it its own caps allow the subsidy to
   * cover; an owner's cap is shared by all their vaults in the batch.
   */
  const allowancesOf = (batch: readonly SelectedVault[]) => {
    // Rounded up, so the shortfalls always add up to at least the batch's loss.
    const shareOfFixed = (fixedCost + BigInt(batch.length) - 1n) / BigInt(batch.length);
    const ownerLeft = new Map<Address, bigint>();
    return batch.map((c) => {
      const shortfall = clampZero(c.costWei + shareOfFixed - c.reward);
      if (!helpable(c)) return { shortfall, allowance: 0n };
      const owner = ownerLeft.get(c.owner) ?? policy.maxSubsidyPerOwnerPerDay - (input.ownerSubsidised24h.get(c.owner) ?? 0n);
      const allowance = clampZero(min(shortfall, policy.maxLossPerBuy, policy.maxLossPerVaultPerDay - c.subsidised24h, owner));
      ownerLeft.set(c.owner, owner - allowance);
      return { shortfall, allowance };
    });
  };
  /**
   * How a batch's planned loss is booked to its vaults, or null when it may
   * not be taken: spread in proportion to the allowances, so each vault is
   * booked at most its own. The allowances fall short of the loss exactly when
   * some vault's shortfall is covered by neither its caps nor the others'
   * surplus.
   */
  const book = (batch: readonly SelectedVault[]): bigint[] | null => {
    const loss = lossOf(batch);
    if (loss === 0n) return batch.map(() => 0n);
    if (loss > input.dailyLossLeft) return null;
    const allowances = allowancesOf(batch).map((a) => a.allowance);
    const total = allowances.reduce((a, b) => a + b, 0n);
    return total < loss ? null : allowances.map((a) => (loss * a) / total);
  };

  // A paying vault that needs help it cannot have — its fee covers its own gas but not its share of the batch's,
  // and its caps are spent or the subsidy does not serve it — is left out, worst margin first, rather than
  // holding back everyone else's buys.
  const batch: SelectedVault[] = [...paying];
  while (batch.length > 0 && book(batch) === null) {
    const needy = allowancesOf(batch).flatMap((a, i) => (a.allowance < a.shortfall ? [i] : []));
    if (needy.length === 0) break;
    const [dropped] = batch.splice(needy.at(-1)!, 1);
    skipped.push({ vault: dropped!.vault, code: "economics", detail: "fees-below-gas" });
  }
  // Oldest first: the vaults that were there first are served first.
  const oldestFirst = [...losing].sort((a, b) =>
    a.order !== b.order ? (a.order === null ? 1 : b.order === null ? -1 : a.order < b.order ? -1 : 1) : a.vault < b.vault ? -1 : 1,
  );
  for (const c of oldestFirst) {
    if (!helpable(c)) {
      skipped.push({ vault: c.vault, code: "economics", detail: "not-subsidised" });
      continue;
    }
    if (book([...batch, c]) === null) {
      // Without a subsidy on offer, the others' fees simply could not carry it; with one, a cap or the day's budget ran out.
      skipped.push({ vault: c.vault, code: "economics", detail: policy.maxLossPerBuy === 0n ? "no-subsidy" : "subsidy-cap" });
      continue;
    }
    batch.push(c);
  }

  const booked = batch.length === 0 ? null : book(batch);
  if (booked === null) {
    for (const c of batch) skipped.push({ vault: c.vault, code: "economics", detail: "fees-below-gas" });
    return { vaults: [], skipped, modelGas: 0n, expectedGas: 0n, expectedCostWei: 0n, expectedEarnedWei: 0n, allowedLossWei: 0n, minRewards: 0n };
  }
  batch.forEach((c, i) => {
    c.subsidyWei = booked[i]!;
  });
  const loss = lossOf(batch);

  const modelGas = modelBatchGas(batch);
  const expectedGas = scaled(modelGas, ratioPpm);
  const expectedCostWei = fixedCost + batch.reduce((sum, c) => sum + c.costWei, 0n);
  const expectedEarnedWei = batch.reduce((sum, c) => sum + c.reward, 0n);
  // Small buys first: later buys pay for earlier buys' price impact.
  const vaults = [...batch].sort((a, b) =>
    a.amountPerBuy !== b.amountPerBuy ? (a.amountPerBuy < b.amountPerBuy ? -1 : 1) : a.vault < b.vault ? -1 : 1,
  );
  return {
    vaults,
    skipped,
    modelGas,
    expectedGas,
    expectedCostWei,
    expectedEarnedWei,
    allowedLossWei: loss,
    minRewards: input.privateSend ? clampZero(expectedCostWei - loss) : 0n,
  };
}

// ─── Gas limit and splitting ──────────────────────────────────────────────────

/** Intrinsic gas, calldata head, dispatch, the lock, the entry balance read and the reasons array, with margin. */
export const BATCH_SETUP_GAS_LIMIT = 60_000n;
/** A later buy's gas, its calldata, and about 20,000 of margin. */
export const PER_VAULT_GAS_LIMIT_LATER = 127_000n;
/** A first buy's: the same plus what writing its slots from zero costs. */
export const PER_VAULT_GAS_LIMIT_FIRST = 178_000n;

/**
 * What the batcher must have left before it attempts a vault given
 * `gasPerVault`: that gas after the 63/64 rule, rounded up, and its
 * `ATTEMPT_OVERHEAD`. 460,000 at the least gas, `MIN_EXECUTE_GAS`, which is
 * also v1's batcher's fixed `MIN_GAS_PER_ATTEMPT`.
 */
export function minGasPerAttempt(gasPerVault: bigint = BATCHER_LIMITS.MIN_EXECUTE_GAS): bigint {
  return gasPerVault + (gasPerVault + 62n) / 63n + BATCHER_LIMITS.ATTEMPT_OVERHEAD;
}

/**
 * The gas limit a batch is signed with — never `eth_estimateGas`'s. The
 * batcher catches each vault's failure, so an estimate settles on the least
 * gas at which the transaction succeeds: enough for the first vaults, with the
 * rest silently not tried. Instead: setup, each vault's figure, and a tail of
 * `minGasPerAttempt` so the batcher's precheck lets the last vault through
 * with its whole `gasPerVault`. Unused gas is refunded.
 */
export function batchGasLimit(vaults: readonly { firstBuy: boolean }[], gasPerVault: bigint = BATCHER_LIMITS.MIN_EXECUTE_GAS): bigint {
  const perVault = vaults.reduce((sum, v) => sum + (v.firstBuy ? PER_VAULT_GAS_LIMIT_FIRST : PER_VAULT_GAS_LIMIT_LATER), 0n);
  return BATCH_SETUP_GAS_LIMIT + perVault + minGasPerAttempt(gasPerVault);
}

/**
 * Deal `items` (in margin order, best first) round-robin into the fewest
 * chunks that each fit the policy's gas and count limits, so every chunk mixes
 * well- and poorly-paying vaults and each can pay its own way. One chunk is
 * sent per tick.
 */
export function splitRoundRobin<T extends { firstBuy: boolean }>(items: readonly T[], policy: KeeperPolicy): T[][] {
  if (items.length === 0) return [];
  for (let k = 1; k <= items.length; k++) {
    const chunks: T[][] = Array.from({ length: k }, () => []);
    items.forEach((item, i) => chunks[i % k]!.push(item));
    if (chunks.every((chunk) => chunk.length <= policy.maxVaultsPerBatch && batchGasLimit(chunk) <= policy.maxBatchGas)) return chunks;
  }
  return items.map((item) => [item]);
}

// ─── What to bid ──────────────────────────────────────────────────────────────

/** A deadline send's tip after `resends` resends: ×1.5 each, from `urgentTip` up to `maxTip`. */
export function urgentTipAfter(resends: number, policy: KeeperPolicy): bigint {
  let tip = policy.urgentTip;
  for (let i = 0; i < resends && tip < policy.maxTip; i++) tip = (tip * 3n) / 2n;
  return tip < policy.maxTip ? tip : policy.maxTip;
}

/**
 * The fees a new transaction bids: the policy's tip, or an urgent one for a
 * deadline send; `maxFeePerGas = 2 × next + tip`, as the app's own signer
 * bids, never above the policy's cap. When even the next block's base fee
 * plus the tip is above the cap, nothing is sent. A chain without a base fee
 * gets its gas price, capped the same way.
 */
export function chooseFees(
  input: { next: bigint; legacy: boolean; urgent: boolean; resends?: number },
  policy: KeeperPolicy,
): { fees: PreparedFees; tip: bigint } | { blocked: "fees-above-max" } {
  if (input.legacy) {
    if (input.next > policy.maxFeePerGas) return { blocked: "fees-above-max" };
    return { fees: { type: "legacy", gasPrice: input.next }, tip: 0n };
  }
  const tip = input.urgent ? urgentTipAfter(input.resends ?? 0, policy) : policy.tip;
  if (input.next + tip > policy.maxFeePerGas) return { blocked: "fees-above-max" };
  const wanted = 2n * input.next + tip;
  return { fees: { type: "eip1559", maxFeePerGas: min(wanted, policy.maxFeePerGas), maxPriorityFeePerGas: tip }, tip };
}

/**
 * The fees a replacement at the same nonce bids: each field at least 12.5%
 * over the last, the tip at least the escalated urgent tip (capped at
 * `maxTip`), and the max fee at least `2 × next + tip`, never above the
 * policy's cap. Nodes accept a replacement only when both fields rise by 10%;
 * when the caps stop that, null — the transaction may still land, or expire.
 */
export function replacementFees(
  old: PreparedFees,
  input: { next: bigint; urgent: boolean; resends: number },
  policy: KeeperPolicy,
): PreparedFees | null {
  const up = (v: bigint) => (v * 1_125n + 999n) / 1_000n;
  const clears = (now: bigint, before: bigint) => now * 100n >= before * 110n;
  if (old.type === "legacy") {
    const price = min(up(old.gasPrice) > input.next ? up(old.gasPrice) : input.next, policy.maxFeePerGas);
    return clears(price, old.gasPrice) ? { type: "legacy", gasPrice: price } : null;
  }
  const escalated = input.urgent ? urgentTipAfter(input.resends, policy) : policy.tip;
  let tip = up(old.maxPriorityFeePerGas);
  if (escalated > tip) tip = escalated;
  if (input.urgent && tip > policy.maxTip) tip = policy.maxTip;
  const floor = 2n * input.next + tip;
  const maxFee = min(up(old.maxFeePerGas) > floor ? up(old.maxFeePerGas) : floor, policy.maxFeePerGas);
  if (tip > maxFee || !clears(tip, old.maxPriorityFeePerGas) || !clears(maxFee, old.maxFeePerGas)) return null;
  return { type: "eip1559", maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
}

/**
 * How many blocks to wait for a transaction before rebuilding and resending
 * it: a third of the blocks left before its earliest window closes, between 2
 * and the policy's `resendAfterBlocks`, so even a five-minute plan gets its
 * resends before its window is gone.
 */
export function resendIntervalBlocks(blocksToEarliestWindowEnd: bigint, policy: KeeperPolicy): number {
  const third = Number(blocksToEarliestWindowEnd / 3n);
  return Math.min(Math.max(third, 2), Math.max(policy.resendAfterBlocks, 2));
}

// ─── Arithmetic ───────────────────────────────────────────────────────────────

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

const clampZero = (v: bigint): bigint => (v > 0n ? v : 0n);
