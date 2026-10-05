/**
 * The buy fee: what the app proposes as a new vault's `keeperReward`.
 *
 * A vault pays a fixed amount of WETH for each of its buys, to whoever the
 * buy's trigger names (`rewardTo`; v1's vaults paid the caller itself). That
 * amount is written into the vault's code when it is created, and nothing can
 * change it afterwards, spDEX included. This file is where the app's default
 * for new plans comes from, and so it is the only place the fee can change: by
 * a release, which reaches only plans created after it.
 *
 *   reward = min(BATCHED_BUY_GAS × FEE_NETWORK_REFERENCE + ceil(0.25% × buy),
 *                floor(0.69% × buy))
 *
 * The first figure is what making the buy costs, and a quarter of a percent of
 * the buy (decision 9 of docs/V2_UPGRADE.md). The cost is one buy's share of a
 * batched transaction's gas, priced at a constant rather than at the fee of the
 * moment: a plan fixes its fee for every buy it will ever make, and keepers pay
 * at the time of each buy, so the fee at creation says nothing about what they
 * will pay. Two identical plans always pay the same. The share is what makes
 * keeping worth a community keeper's while — paid work, a fee for each buy
 * made, and what comparable recurring-buy services charge (0.3% plus gas, on
 * Ethereum, on 2026-10-02) — and it is the same for the whole community window
 * (decision 5): the vault pays one fee whoever makes the buy, and whenever.
 *
 * The second is the ceiling: 0.69% of the buy, the network cost included. It
 * is the contract's own `MAX_REWARD_BPS`, so it holds for every vault of this
 * factory whoever wrote its terms, and it is the most anyone who triggers a
 * buy, or is named to be paid for one, can be paid for it, spDEX's developers
 * included. What a keeper keeps is the fee less the network fee it paid, so it
 * is less than that. The fee may be changed under the ceiling by a later
 * release; it cannot pass it without a new factory.
 *
 * v1's vaults were made under an earlier default — the network cost and a tenth
 * more, nothing in proportion to the buy — and keep it for good. `v1BuyFee` is
 * that rule, frozen, for the one thing still judged by it: whether a v1 vault
 * pays what spDEX proposed for its size (the keeper's subsidy rule).
 *
 * Nothing here reads the chain, and nothing here uses a Node API: the app,
 * the Guard and the keeper all import it.
 */

import { VAULT_LIMITS, type SourceId } from "./artifacts.js";

const BPS = 10_000n;

/**
 * What the fee asks for beyond the network cost, in basis points of the buy:
 * 0.25%. A constant, not a setting, for the reason `MAX_TOTAL_TIP_BPS` is.
 * Changing it is a release, and it only affects plans created after that
 * release.
 */
export const BUY_FEE_SHARE_BPS = 25n;

/**
 * The ceiling on the whole fee, in basis points of the buy: 0.69%, the
 * network cost included. Not a figure of the app's own: it is the contract's
 * `MAX_REWARD_BPS`, read from the build, so the app cannot promise a ceiling
 * the factory does not hold. Where it binds, a keeper that makes the buy keeps
 * less of its share, or pays the rest of its network cost on the smallest
 * buys, or skips it; nothing obliges any keeper to. It binds for buys under
 * `CEILING_BINDS_BELOW`, 0.004295454545454638 ETH (about $11.36 at $2,643.94).
 */
export const BUY_FEE_CEILING_BPS = VAULT_LIMITS.MAX_REWARD_BPS;

/**
 * Gas one batch pays once, whatever its size, kept from v1 although v2
 * measures less. A v2 batch no longer forwards rewards (each vault pays its
 * `rewardTo` itself), but the first vault inside its community window asks the
 * registry about `rewardTo` from cold: 151,686 measured for an in-window batch
 * whose `rewardTo` already holds WETH (the first vault's cold eligibility check
 * included, about 9,000), and 142,680 for one after the window, against v1's
 * 150,602. A `rewardTo` holding no WETH yet costs about 17,000 more, once.
 * Pinned by `test/forge/BatchGas.t.sol`.
 */
export const BATCH_FIXED_GAS = 160_000n;

/**
 * Marginal gas for a later buy in a batch on a busy oracle pool, inside its
 * community window and paid to an eligible `rewardTo`: what community keepers
 * send, the dear case, and 71% of hours. Measured at 105,969 (v1's buy was
 * 101,255): the registry's check, warm after the batch's first vault (about
 * 3,000), `Bought`'s two new words and `dueSince`'s arithmetic. After the
 * window it is 102,968, and a quiet pool costs less again, so this errs high.
 * Pinned by `test/forge/BatchGas.t.sol`.
 */
export const BATCH_PER_BUY_GAS = 110_000n;

/**
 * What a plan's first buy costs over a later one, because it writes slots from
 * zero: 50,686 measured in a batch, in v1 and v2 alike. The fee does not use
 * it, since it prices every buy of a plan alike; a keeper's cost model does.
 * Pinned by `test/forge/BatchGas.t.sol`.
 */
export const BATCH_FIRST_BUY_EXTRA_GAS = 51_000n;

/**
 * The batch size the network part assumes: a daily keeper's batch at about ten
 * users. Early beta will see batches of one to three (about 163,000 to 270,000
 * gas a buy), so at first the network part is understated, and a buy's share
 * of the fee is what covers the difference for all but the smallest buys. How
 * many users there are matters much less than whether their buys share
 * transactions.
 */
export const FEE_BATCH_SIZE = 10n;

/** The network cost of one batched buy, in gas: its own gas and its share of the batch's (126,000; v1's was 122,000). */
export const BATCHED_BUY_GAS = BATCH_PER_BUY_GAS + BATCH_FIXED_GAS / FEE_BATCH_SIZE;

/** The tip a patient keeper bids, wei per gas (0.02 gwei): the keeper's default. */
export const FEE_TIP_REFERENCE = 20_000_000n;

/**
 * The all-in fee per gas the network part is priced at, for every plan: 0.15
 * gwei. Priced live, identical plans made in a dip and in a spike paid up to
 * 2.2 times apart for life, for a figure that says nothing about the fees
 * keepers will pay later. The derivation, from 2026-09-24's week of fees:
 * about 90% of sends go at a cheap block (a 25th-percentile base fee of 0.063
 * plus the 0.02 tip, 0.083) and about 10% are deadline sends at the median
 * base fee plus a 0.1 urgent tip (0.212); the blend is about 0.096, and 0.15
 * leaves room for early beta's small batches. Re-derive it when mainnet's fees
 * change regime; that is a release.
 */
export const FEE_NETWORK_REFERENCE = 150_000_000n;

/**
 * What a buy's gas costs per unit when fees are low (0.083 gwei): the week's
 * 25th-percentile base fee, 0.063, plus `FEE_TIP_REFERENCE`. Only
 * `coversCheapBatchedBuy` uses it, to tell a newcomer honestly when a buy may
 * never be made.
 */
export const FEE_CHEAP_REFERENCE = 83_000_000n;

/**
 * One batched buy's network cost at the release's reference, the part of every
 * fee that does not depend on the buy: 126,000 gas at 0.15 gwei,
 * 18,900,000,000,000 wei (0.0000189 ETH, about $0.05 at $2,643.94).
 */
export const NETWORK_PART = BATCHED_BUY_GAS * FEE_NETWORK_REFERENCE;

/** A plan's buy fee, and how it was reached. */
export interface BuyFee {
  /** The vault's `keeperReward`: wei of WETH paid for each buy, to the `rewardTo` its trigger names. */
  reward: bigint;
  /** `BATCHED_BUY_GAS × the fee per gas`, the same for every plan. */
  networkPart: bigint;
  /** `ceil(0.25% × amountPerBuy)`: what the fee asks for beyond the network cost. */
  sharePart: bigint;
  /** `floor(0.69% × amountPerBuy)`: the contract's own limit. */
  ceiling: bigint;
  /** Whether the ceiling cut the fee: the two parts came to more than it. */
  atCeiling: boolean;
  /** `ceil(reward / amountPerBuy)` in basis points; at most 69, by construction. */
  shareBps: number;
}

/** The buy fee spDEX proposes for a new plan, at the release's `FEE_NETWORK_REFERENCE`. */
export function buyFee(amountPerBuy: bigint): BuyFee {
  return buyFeeAt({ amountPerBuy, networkFeePerGas: FEE_NETWORK_REFERENCE });
}

/**
 * The buy fee at any fee per gas: the pure core of `buyFee`, for tests and for
 * asking "what if fees were…". The share is rounded up and the ceiling down,
 * so the fee never exceeds 0.69% and never falls short of the network part
 * and its share except where the ceiling binds.
 */
export function buyFeeAt(input: { amountPerBuy: bigint; networkFeePerGas: bigint }): BuyFee {
  const { amountPerBuy, networkFeePerGas } = input;
  if (networkFeePerGas < 0n) throw new RangeError("the network fee per gas cannot be negative");
  const ceiling = feeCeiling(amountPerBuy);
  const networkPart = BATCHED_BUY_GAS * networkFeePerGas;
  const sharePart = ceilDiv(amountPerBuy * BUY_FEE_SHARE_BPS, BPS);
  const wanted = networkPart + sharePart;
  const atCeiling = wanted > ceiling;
  const reward = atCeiling ? ceiling : wanted;
  return { reward, networkPart, sharePart, ceiling, atCeiling, shareBps: feeShareBps(reward, amountPerBuy) };
}

/**
 * The most a buy of `amountPerBuy` may be charged: 0.69% of it, rounded down,
 * which is exactly what the factory accepts (`keeperReward × 10,000 ≤
 * amountPerBuy × MAX_REWARD_BPS`).
 */
export function feeCeiling(amountPerBuy: bigint): bigint {
  assertAmount(amountPerBuy);
  return (amountPerBuy * BUY_FEE_CEILING_BPS) / BPS;
}

/**
 * Whether `reward` is a fee the factory would accept for this amount: at or
 * under `feeCeiling`. False rather than a throw for a negative fee or an
 * amount that is not a buy, because the Guard asks this of terms it has not
 * yet trusted, and "no" is the answer that refuses them.
 */
export function withinFeeCeiling(reward: bigint, amountPerBuy: bigint): boolean {
  if (amountPerBuy <= 0n || reward < 0n) return false;
  return reward <= feeCeiling(amountPerBuy);
}

/**
 * Whether `reward` is held at the ceiling, or above it: what a card shows for a
 * plan whose fee is less than the network part and its share. False for an
 * amount that is not a buy, which has no ceiling to be at.
 */
export function atFeeCeiling(reward: bigint, amountPerBuy: bigint): boolean {
  if (amountPerBuy <= 0n) return false;
  return reward >= feeCeiling(amountPerBuy);
}

/** A fee's share of its buy in basis points, rounded up, so a share is never shown smaller than it is. */
export function feeShareBps(reward: bigint, amountPerBuy: bigint): number {
  assertAmount(amountPerBuy);
  if (reward < 0n) throw new RangeError("a fee cannot be negative");
  return Number(ceilDiv(reward * BPS, amountPerBuy));
}

/**
 * A share in basis points as a percentage, exactly: whole basis points have at
 * most two decimals, so none is rounded, and trailing zeros are dropped.
 * 69 → "0.69", 50 → "0.5", 8 → "0.08", 100 → "1", 110 → "1.1".
 */
export function feeShareText(shareBps: number): string {
  if (!Number.isSafeInteger(shareBps) || shareBps < 0) throw new RangeError("a share is a whole, non-negative number of basis points");
  const whole = Math.floor(shareBps / 100);
  const hundredths = String(shareBps % 100).padStart(2, "0").replace(/0+$/, "");
  return hundredths === "" ? `${whole}` : `${whole}.${hundredths}`;
}

/** What one batched buy costs in network fees when fees are low: 10,458,000,000,000 wei. */
const CHEAP_BATCHED_BUY_COST = BATCHED_BUY_GAS * FEE_CHEAP_REFERENCE;

/**
 * Whether a fee covers one batched buy's network cost even when fees are low.
 * A fee that does not may never be worth a keeper's while, and the app says
 * so rather than let a newcomer believe the plan will run.
 */
export function coversCheapBatchedBuy(reward: bigint): boolean {
  return reward >= CHEAP_BATCHED_BUY_COST;
}

/**
 * The least `amountPerBuy` whose fee covers a cheap batched buy:
 * 1,515,652,173,913,044 wei, about 0.00152 ETH ($4.01 at $2,643.94). There
 * the ceiling binds, so it is the least amount whose 0.69% reaches the cost.
 */
export const CHEAP_BATCHED_BUY_THRESHOLD = ceilDiv(CHEAP_BATCHED_BUY_COST * BPS, BUY_FEE_CEILING_BPS);

/**
 * The least `amountPerBuy` the ceiling does not hold down, at the release's
 * reference: 4,295,454,545,454,638 wei, about 0.0043 ETH ($11.36 at
 * $2,643.94). From there up every buy pays `NETWORK_PART` and its 0.25%; below
 * it, 0.69% of the buy, which is less. Where the two meet the roundings (the
 * share up, the ceiling down) could make the answer flicker by a wei, so this
 * is found rather than divided out: the amount after the last one at which
 * the ceiling binds, which a unit test pins one wei either side.
 */
export const CEILING_BINDS_BELOW = ceilingBindsBelow(NETWORK_PART);

/**
 * Below `networkPart × 10,000 / 44` the ceiling always binds, since 0.69% less
 * 0.25% is 0.44% of the buy; above `(networkPart × 10,000 + 20,000) / 44` it
 * never does, the two roundings being worth at most a wei each. In between,
 * about 450 amounts, it is counted.
 */
function ceilingBindsBelow(networkPart: bigint): bigint {
  const spread = BUY_FEE_CEILING_BPS - BUY_FEE_SHARE_BPS;
  const from = (networkPart * BPS) / spread;
  const to = (networkPart * BPS + 2n * BPS) / spread + 1n;
  let last = from - 1n;
  for (let amount = from; amount <= to; amount++) {
    if (networkPart + ceilDiv(amount * BUY_FEE_SHARE_BPS, BPS) > (amount * BUY_FEE_CEILING_BPS) / BPS) last = amount;
  }
  return last + 1n;
}

// ─── v1's fee, frozen ─────────────────────────────────────────────────────────

/**
 * v1's marginal gas for a later buy in a batch: 101,255 measured, budgeted at
 * 106,000. A v1 vault asks no registry and writes no `dueSince` or `rewardTo`,
 * so a keeper costs its buys at this, not at `BATCH_PER_BUY_GAS`, v2's in-window
 * figure: the calibration ratio only ever scales the model up, so a model
 * that overstates v1's buys could never be brought back down.
 */
export const V1_BATCH_PER_BUY_GAS = 106_000n;

/** v1's batched buy, in gas: 106,000 a later buy and a tenth of a 160,000 batch. */
export const V1_BATCHED_BUY_GAS = 122_000n;

/** What v1's fee asked beyond the network cost, in basis points of that cost: a tenth. */
export const V1_BUY_FEE_MARKUP_BPS = 1_000n;

/** A v1 plan's buy fee by v1's rule, and how it was reached. */
export interface V1BuyFee {
  reward: bigint;
  /** `V1_BATCHED_BUY_GAS × the fee per gas`. */
  networkPart: bigint;
  /** `ceil(10% × networkPart)`. */
  markupPart: bigint;
  ceiling: bigint;
  atCeiling: boolean;
  shareBps: number;
}

/**
 * The buy fee v1 proposed for a plan of this size, frozen: `min(ceil(110% ×
 * 122,000 gas × 0.15 gwei), floor(0.69% × buy))`, which is 0.00002013 ETH for
 * every buy the ceiling does not hold down. Every v1 vault was made under it
 * and keeps its fee for good; this is what "pays the fee spDEX proposed for its
 * size" means for one, now that `buyFee` proposes v2's. Never offered for a new
 * plan.
 */
export function v1BuyFee(amountPerBuy: bigint): V1BuyFee {
  const ceiling = feeCeiling(amountPerBuy);
  const networkPart = V1_BATCHED_BUY_GAS * FEE_NETWORK_REFERENCE;
  const markupPart = ceilDiv(networkPart * V1_BUY_FEE_MARKUP_BPS, BPS);
  const wanted = networkPart + markupPart;
  const atCeiling = wanted > ceiling;
  const reward = atCeiling ? ceiling : wanted;
  return { reward, networkPart, markupPart, ceiling, atCeiling, shareBps: feeShareBps(reward, amountPerBuy) };
}

// ─── Each source's buys ───────────────────────────────────────────────────────

/**
 * What a keeper costs one later buy of each source's vaults at in a batch, and
 * the fee spDEX proposed for a plan of a given size when that source's vaults
 * were being made. Keyed by source and typed so, a new source does not compile
 * without its row: what a buy of its code costs is measured, and what fee its
 * plans are offered is decided, once per source, as v1's and v2's were. A
 * release built from an existing source shares its row.
 */
export const SOURCE_BUYS: Record<SourceId, { perBuyGas: bigint; proposedFee: (amountPerBuy: bigint) => { reward: bigint } }> = {
  v1: { perBuyGas: V1_BATCH_PER_BUY_GAS, proposedFee: v1BuyFee },
  v2: { perBuyGas: BATCH_PER_BUY_GAS, proposedFee: buyFee },
};

function assertAmount(amountPerBuy: bigint): void {
  if (amountPerBuy <= 0n) throw new RangeError("a buy's amount must be positive");
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
