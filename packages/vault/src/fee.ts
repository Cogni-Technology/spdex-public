/**
 * The buy fee: what the app proposes as a new vault's `keeperReward`.
 *
 * A vault pays a fixed amount of WETH to whoever triggers each of its buys.
 * That amount is written into the vault's code when it is created, and nothing
 * can change it afterwards, spDEX included. This file is where the app's
 * default for new plans comes from, and so it is the only place the fee can
 * change: by a release, which reaches only plans created after it.
 *
 *   reward = min(ceil(110% × BATCHED_BUY_GAS × FEE_NETWORK_REFERENCE),
 *                floor(0.69% × buy))
 *
 * The first figure is what making the buy costs, and a tenth more. The cost is
 * one buy's share of a batched transaction's gas, priced at a constant rather
 * than at the fee of the moment: a plan fixes its fee for every buy it will
 * ever make, and keepers pay at the time of each buy, so the fee at creation
 * says nothing about what they will pay. Two identical plans always pay the
 * same. The tenth is all the fee asks for beyond cost while spDEX is a
 * prototype.
 *
 * The second is the ceiling: 0.69% of the buy, the network cost included. It
 * is the contract's own `MAX_REWARD_BPS`, so it holds for every vault of this
 * factory whoever wrote its terms, and it is the most anyone who triggers a
 * buy can be paid for it, spDEX's developers included. What a keeper keeps is
 * the fee less the network fee it paid, so it is less than that. The fee may
 * be raised towards the ceiling by a later release; it cannot pass it without
 * a new factory.
 *
 * Nothing here reads the chain, and nothing here uses a Node API: the app,
 * the Guard and the keeper all import it.
 */

import { VAULT_LIMITS } from "./artifacts.js";

const BPS = 10_000n;

/**
 * What the fee asks for beyond the network cost, in basis points of that
 * cost: 10%. A constant, not a setting, for the reason `MAX_TOTAL_TIP_BPS`
 * is. Changing it is a release, and it only affects plans created after that
 * release.
 */
export const BUY_FEE_MARKUP_BPS = 1_000n;

/**
 * The ceiling on the whole fee, in basis points of the buy: 0.69%, the
 * network cost included. Not a figure of the app's own: it is the contract's
 * `MAX_REWARD_BPS`, read from the build, so the app cannot promise a ceiling
 * the factory does not hold. Where it binds, a keeper that triggers the buy
 * pays the rest of its network cost, or skips it; nothing obliges any keeper
 * to. It binds for buys under 0.002917391304347827 ETH (about $7.71 at
 * $2,643.94).
 */
export const BUY_FEE_CEILING_BPS = VAULT_LIMITS.MAX_REWARD_BPS;

/**
 * Gas one batch pays once, whatever its size. The research's batch contract
 * measured 142,340 on a busy pool; add about 7,000 to forward the rewards to a
 * `rewardTo` that already holds WETH, about 2,500 for the `Batch` event, about
 * 500 for the entry balance read and about 300 for the lock and `minRewards`.
 * A `rewardTo` holding no WETH yet costs about 15,000 more, once. Pinned by
 * `test/forge/BatchGas.t.sol`.
 */
export const BATCH_FIXED_GAS = 160_000n;

/**
 * Marginal gas for a later buy in a batch on a busy oracle pool: the dear
 * case, and 71% of hours. Measured at 97,763, plus about 3,500 for the
 * factory's `isVault`, 1,800 for `Triggered`, 1,000 for `Bought`'s three new
 * words and 600 of bookkeeping: about 104,700. A quiet pool costs about 85,000,
 * so this errs high. Pinned by `test/forge/BatchGas.t.sol`.
 */
export const BATCH_PER_BUY_GAS = 106_000n;

/**
 * What a plan's first buy costs over a later one, because it writes slots from
 * zero: 50,687 measured in a batch. The fee does not use it, since it prices
 * every buy of a plan alike; a keeper's cost model does. Pinned by
 * `test/forge/BatchGas.t.sol`.
 */
export const BATCH_FIRST_BUY_EXTRA_GAS = 51_000n;

/**
 * The batch size the network part assumes: a daily keeper's batch at about ten
 * users. Early beta will see batches of one to three (186,000 to 266,000 gas a
 * buy), so at first the network part is understated and the keeper's operator
 * absorbs the difference. How many users there are matters much less than
 * whether their buys share transactions.
 */
export const FEE_BATCH_SIZE = 10n;

/** The network cost of one batched buy, in gas: its own gas and its share of the batch's (122,000). */
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

/** A plan's buy fee, and how it was reached. */
export interface BuyFee {
  /** The vault's `keeperReward`: wei of WETH paid to whoever triggers each buy. */
  reward: bigint;
  /** `BATCHED_BUY_GAS × the fee per gas`, the same for every plan. */
  networkPart: bigint;
  /** `ceil(10% × networkPart)`: what the fee asks for beyond the network cost. */
  markupPart: bigint;
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
 * asking "what if fees were…". The tenth is rounded up and the ceiling down,
 * so the fee never exceeds 0.69% and never falls short of the network part
 * and its tenth except where the ceiling binds.
 */
export function buyFeeAt(input: { amountPerBuy: bigint; networkFeePerGas: bigint }): BuyFee {
  const { amountPerBuy, networkFeePerGas } = input;
  if (networkFeePerGas < 0n) throw new RangeError("the network fee per gas cannot be negative");
  const ceiling = feeCeiling(amountPerBuy);
  const { networkPart, markupPart } = partsAt(networkFeePerGas);
  const wanted = networkPart + markupPart;
  const atCeiling = wanted > ceiling;
  const reward = atCeiling ? ceiling : wanted;
  return { reward, networkPart, markupPart, ceiling, atCeiling, shareBps: feeShareBps(reward, amountPerBuy) };
}

/** One batched buy's network cost at a fee per gas, and the tenth the fee asks for on top, rounded up. */
function partsAt(networkFeePerGas: bigint): { networkPart: bigint; markupPart: bigint } {
  const networkPart = BATCHED_BUY_GAS * networkFeePerGas;
  return { networkPart, markupPart: ceilDiv(networkPart * BUY_FEE_MARKUP_BPS, BPS) };
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
 * plan whose fee is less than the network part and its tenth. False for an
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

/** What one batched buy costs in network fees when fees are low: 10,126,000,000,000 wei. */
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
 * 1,467,536,231,884,058 wei, about 0.00147 ETH ($3.88 at $2,643.94). There
 * the ceiling binds, so it is the least amount whose 0.69% reaches the cost.
 */
export const CHEAP_BATCHED_BUY_THRESHOLD = ceilDiv(CHEAP_BATCHED_BUY_COST * BPS, BUY_FEE_CEILING_BPS);

/**
 * What every buy pays unless the ceiling holds it lower: the network part at
 * the release's reference and its tenth, 20,130,000,000,000 wei (0.00002013
 * ETH, about $0.05 at $2,643.94).
 */
export const FULL_BUY_FEE = partsAt(FEE_NETWORK_REFERENCE).networkPart + partsAt(FEE_NETWORK_REFERENCE).markupPart;

/**
 * The least `amountPerBuy` the ceiling does not hold down: 2,917,391,304,347,827
 * wei, about 0.00292 ETH ($7.71 at $2,643.94). From there up every buy pays
 * `FULL_BUY_FEE`; below it, 0.69% of the buy, which is less.
 */
export const FULL_FEE_BUY_THRESHOLD = ceilDiv(FULL_BUY_FEE * BPS, BUY_FEE_CEILING_BPS);

function assertAmount(amountPerBuy: bigint): void {
  if (amountPerBuy <= 0n) throw new RangeError("a buy's amount must be positive");
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
