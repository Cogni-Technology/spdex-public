/**
 * The buy fee, to the wei. The examples are docs/ARCHITECTURE.md's ("The buy
 * fee"), at ETH $2,643.94: each amount is `round(usd / 2643.94 × 1e18)` wei, and each fee is
 * what a vault created from this release will pay on every buy, for life. A
 * change to any figure here is a change to what new plans cost, so it is a
 * release decision, not a test to update. v1's rule is kept beside it, frozen,
 * with the figures every v1 vault was made with.
 */

import { describe, expect, it } from "vitest";
import {
  BATCHED_BUY_GAS,
  BATCH_FIRST_BUY_EXTRA_GAS,
  BATCH_FIXED_GAS,
  BATCH_PER_BUY_GAS,
  BUY_FEE_CEILING_BPS,
  BUY_FEE_SHARE_BPS,
  CEILING_BINDS_BELOW,
  CHEAP_BATCHED_BUY_THRESHOLD,
  FEE_BATCH_SIZE,
  FEE_CHEAP_REFERENCE,
  FEE_NETWORK_REFERENCE,
  FEE_TIP_REFERENCE,
  NETWORK_PART,
  V1_BATCHED_BUY_GAS,
  V1_BATCH_PER_BUY_GAS,
  V1_BUY_FEE_MARKUP_BPS,
  atFeeCeiling,
  buyFee,
  buyFeeAt,
  coversCheapBatchedBuy,
  feeCeiling,
  feeShareBps,
  feeShareText,
  v1BuyFee,
  withinFeeCeiling,
} from "./fee.js";
import { VAULT_LIMITS } from "./artifacts.js";

describe("constants", () => {
  it("are the release's: one batched buy's gas at 0.15 gwei, 0.25% of the buy, and a 0.69% ceiling", () => {
    expect(BUY_FEE_SHARE_BPS).toBe(25n);
    expect(BUY_FEE_CEILING_BPS).toBe(69n);
    expect(BATCH_FIXED_GAS).toBe(160_000n);
    expect(BATCH_PER_BUY_GAS).toBe(110_000n);
    expect(BATCH_FIRST_BUY_EXTRA_GAS).toBe(51_000n);
    expect(FEE_BATCH_SIZE).toBe(10n);
    expect(BATCHED_BUY_GAS).toBe(126_000n);
    expect(FEE_TIP_REFERENCE).toBe(20_000_000n);
    expect(FEE_NETWORK_REFERENCE).toBe(150_000_000n);
    expect(FEE_CHEAP_REFERENCE).toBe(83_000_000n);
    expect(NETWORK_PART).toBe(18_900_000_000_000n);
  });

  it("has no ceiling of its own: the app's is the contract's, so neither can promise what the other does not hold", () => {
    expect(VAULT_LIMITS.MAX_REWARD_BPS).toBe(69n);
    expect(BUY_FEE_CEILING_BPS).toBe(VAULT_LIMITS.MAX_REWARD_BPS);
  });
});

describe("buyFee", () => {
  // [usd, amountPerBuy, reward, sharePart, shareBps, shown, atCeiling]
  const TABLE = [
    [1, 378223409003230n, 2609741522122n, 945558522509n, 69, "0.69", true],
    [5, 1891117045016150n, 13048707610611n, 4727792612541n, 69, "0.69", true],
    [6.9, 2609741522122287n, 18007216502643n, 6524353805306n, 69, "0.69", true],
    [10, 3782234090032301n, 26097415221222n, 9455585225081n, 69, "0.69", true],
    [25, 9455585225080750n, 42538963062702n, 23638963062702n, 45, "0.45", false],
    [69, 26097415221222872n, 84143538053058n, 65243538053058n, 33, "0.33", false],
    [690, 260974152212228719n, 671335380530572n, 652435380530572n, 26, "0.26", false],
  ] as const;

  it.each(TABLE)("is the documented figure for a $%s buy, to the wei", (_usd, amount, reward, sharePart, shareBps, shown, atCeiling) => {
    const fee = buyFee(amount);
    expect(fee.networkPart).toBe(18_900_000_000_000n);
    expect(fee.sharePart).toBe(sharePart);
    expect(fee.sharePart).toBe((amount * 25n + 9_999n) / 10_000n);
    expect(fee.reward).toBe(reward);
    expect(fee.shareBps).toBe(shareBps);
    expect(feeShareText(fee.shareBps)).toBe(shown);
    expect(fee.atCeiling).toBe(atCeiling);
    expect(fee.ceiling).toBe((amount * 69n) / 10_000n);
    if (!atCeiling) expect(fee.reward).toBe(NETWORK_PART + sharePart);
  });

  it("is never more than 0.69% of the buy, the network cost included, at any amount and any network fee", () => {
    const amounts = [
      1n,
      144n,
      145n,
      12_345n,
      10n ** 12n,
      1_515_652_173_913_044n,
      4_295_454_545_454_637n,
      4_295_454_545_454_638n,
      10n ** 16n,
      VAULT_LIMITS.MAX_FUNDING,
    ];
    // From free to 1,000 gwei: no network fee, however dear, lifts the fee past the ceiling.
    for (const networkFeePerGas of [0n, 1n, FEE_CHEAP_REFERENCE, FEE_NETWORK_REFERENCE, 10n ** 9n, 10n ** 12n]) {
      for (const amountPerBuy of amounts) {
        const fee = buyFeeAt({ amountPerBuy, networkFeePerGas });
        expect(fee.reward * 10_000n <= amountPerBuy * 69n).toBe(true);
        expect(fee.shareBps).toBeLessThanOrEqual(69);
        expect(fee.reward <= fee.ceiling).toBe(true);
        // The ceiling binds exactly when the network part and the share come to more than it.
        expect(fee.atCeiling).toBe(fee.networkPart + fee.sharePart > fee.ceiling);
        expect(fee.reward).toBe(fee.atCeiling ? fee.ceiling : fee.networkPart + fee.sharePart);
        // And it is a fee the factory accepts: `keeperReward × 10,000 ≤ amountPerBuy × MAX_REWARD_BPS`.
        expect(fee.reward * 10_000n <= amountPerBuy * VAULT_LIMITS.MAX_REWARD_BPS).toBe(true);
        expect(withinFeeCeiling(fee.reward, amountPerBuy)).toBe(true);
      }
    }
  });

  it("rounds the share up and the ceiling down", () => {
    // 1 wei a gas: 126,000 wei of network cost; 0.25% of 10,001 wei is 25.0025, asked as 26.
    expect(buyFeeAt({ amountPerBuy: 10n ** 16n, networkFeePerGas: 1n })).toMatchObject({ networkPart: 126_000n, sharePart: 25n * 10n ** 12n });
    expect(buyFeeAt({ amountPerBuy: 10_001n, networkFeePerGas: 0n })).toMatchObject({ sharePart: 26n, ceiling: 69n, reward: 26n, atCeiling: false });
    expect(buyFeeAt({ amountPerBuy: 10_000n, networkFeePerGas: 0n })).toMatchObject({ sharePart: 25n, reward: 25n });
    // 10,144 wei: 0.69% of it is 69.99…, held to 69.
    expect(buyFee(10_144n)).toMatchObject({ ceiling: 69n, reward: 69n, atCeiling: true });
    expect(buyFee(10_145n)).toMatchObject({ ceiling: 70n, reward: 70n, atCeiling: true });
  });

  it("binds at the ceiling for buys under 0.004295454545454638 ETH, and not from there up", () => {
    const binds = 4_295_454_545_454_638n;
    expect(CEILING_BINDS_BELOW).toBe(binds);
    const at = buyFee(binds);
    expect(at).toMatchObject({ atCeiling: false, reward: NETWORK_PART + at.sharePart });
    expect(at.reward).toBeLessThanOrEqual(at.ceiling);
    const below = buyFee(binds - 1n);
    expect(below).toMatchObject({ atCeiling: true, reward: below.ceiling });
    expect(NETWORK_PART + below.sharePart).toBe(below.ceiling + 1n);
    // Above it the ceiling never binds again: not for the next few thousand wei, nor further up.
    for (let amount = binds; amount < binds + 5_000n; amount++) expect(buyFee(amount).atCeiling, String(amount)).toBe(false);
    for (const amount of [10n ** 16n, 10n ** 17n, VAULT_LIMITS.MAX_FUNDING]) expect(buyFee(amount).atCeiling).toBe(false);
  });

  it("grows with the buy where the ceiling doesn't bind: the network part the same for every plan, and 0.25% of the buy", () => {
    expect(buyFee(10n ** 16n)).toMatchObject({ reward: NETWORK_PART + 25n * 10n ** 12n, shareBps: 44 });
    expect(buyFee(VAULT_LIMITS.MAX_FUNDING)).toMatchObject({ reward: NETWORK_PART + 1_250n * 10n ** 12n, shareBps: 26 });
  });

  it("is 0 for a buy under 145 wei, whose 0.69% rounds down to nothing", () => {
    expect(buyFee(144n).reward).toBe(0n);
    expect(buyFee(145n).reward).toBe(1n);
  });

  it("depends on the amount alone: buyFee is buyFeeAt at the release's reference", () => {
    const amount = 3782234090032301n;
    expect(buyFee(amount)).toEqual(buyFeeAt({ amountPerBuy: amount, networkFeePerGas: FEE_NETWORK_REFERENCE }));
  });

  it("prices the network part at any other fee when asked", () => {
    const amount = 26097415221222872n; // $69
    const atOneGwei = buyFeeAt({ amountPerBuy: amount, networkFeePerGas: 1_000_000_000n });
    expect(atOneGwei).toMatchObject({ networkPart: 126_000_000_000_000n, sharePart: 65_243_538_053_058n });
    // 191.2e12 is above 0.69% (180,072,165,026,437): held there.
    expect(atOneGwei).toMatchObject({ reward: 180_072_165_026_437n, ceiling: 180_072_165_026_437n, atCeiling: true, shareBps: 69 });
    // With no network cost, the share is all there is: 0.25% rounded up to the wei, which
    // is a hair over 25 basis points, and a share is never shown smaller than it is.
    const free = buyFeeAt({ amountPerBuy: amount, networkFeePerGas: 0n });
    expect(free).toMatchObject({ networkPart: 0n, sharePart: 65_243_538_053_058n, reward: 65_243_538_053_058n, atCeiling: false, shareBps: 26 });
    expect(buyFeeAt({ amountPerBuy: 10n ** 16n, networkFeePerGas: 0n }).shareBps).toBe(25);
  });

  it("refuses an amount that is not a buy, and a negative fee per gas, rather than returning a fee", () => {
    expect(() => buyFee(0n)).toThrow(RangeError);
    expect(() => buyFee(-1n)).toThrow(RangeError);
    expect(() => buyFeeAt({ amountPerBuy: 10n ** 15n, networkFeePerGas: -1n })).toThrow(RangeError);
    expect(() => feeCeiling(0n)).toThrow(RangeError);
    expect(() => feeShareBps(1n, 0n)).toThrow(RangeError);
    expect(() => feeShareBps(-1n, 1n)).toThrow(RangeError);
  });
});

describe("the ceiling", () => {
  it("is 0.69% of the buy, rounded down", () => {
    expect(feeCeiling(10_000n)).toBe(69n);
    expect(feeCeiling(10_144n)).toBe(69n);
    expect(feeCeiling(10_145n)).toBe(70n);
    expect(feeCeiling(10n ** 16n)).toBe(69n * 10n ** 12n);
  });

  it("a fee at it is within it and at it; one wei more is neither within nor under it", () => {
    const amount = 378223409003230n;
    const ceiling = feeCeiling(amount);
    expect(withinFeeCeiling(ceiling, amount)).toBe(true);
    expect(atFeeCeiling(ceiling, amount)).toBe(true);
    expect(withinFeeCeiling(ceiling + 1n, amount)).toBe(false);
    expect(atFeeCeiling(ceiling + 1n, amount)).toBe(true);
    expect(atFeeCeiling(ceiling - 1n, amount)).toBe(false);
    expect(withinFeeCeiling(0n, amount)).toBe(true);
  });

  it("refuses the old rules' fees: 10%, 1.69%, and 0.69% with a network part on top", () => {
    const amount = 10n ** 16n;
    expect(withinFeeCeiling(amount / 10n, amount)).toBe(false);
    expect(withinFeeCeiling((amount * 169n) / 10_000n, amount)).toBe(false);
    expect(withinFeeCeiling((amount * 69n) / 10_000n + 18_300_000_000_000n, amount)).toBe(false);
    expect(withinFeeCeiling((amount * 69n) / 10_000n, amount)).toBe(true);
  });

  it("answers no, rather than throwing, for terms nobody should sign", () => {
    expect(withinFeeCeiling(-1n, 10n ** 15n)).toBe(false);
    expect(withinFeeCeiling(0n, 0n)).toBe(false);
    expect(withinFeeCeiling(0n, -1n)).toBe(false);
    expect(atFeeCeiling(0n, 0n)).toBe(false);
  });
});

describe("feeShareText", () => {
  it("shows whole basis points exactly, with no rounding and no trailing zeros", () => {
    expect(feeShareText(169)).toBe("1.69");
    expect(feeShareText(154)).toBe("1.54");
    expect(feeShareText(112)).toBe("1.12");
    expect(feeShareText(113)).toBe("1.13");
    expect(feeShareText(110)).toBe("1.1");
    expect(feeShareText(100)).toBe("1");
    expect(feeShareText(76)).toBe("0.76");
    expect(feeShareText(69)).toBe("0.69");
    expect(feeShareText(54)).toBe("0.54");
    expect(feeShareText(50)).toBe("0.5");
    expect(feeShareText(8)).toBe("0.08");
    expect(feeShareText(5)).toBe("0.05");
    expect(feeShareText(0)).toBe("0");
    expect(feeShareText(1000)).toBe("10");
  });

  it("never says more than 0.69 for any fee, whatever the amount", () => {
    // A spread of amounts across the range where the ceiling binds, and beyond it.
    let amount = 145n;
    while (amount <= VAULT_LIMITS.MAX_FUNDING) {
      const fee = buyFee(amount);
      expect(fee.shareBps).toBeLessThanOrEqual(69);
      expect(Number(feeShareText(fee.shareBps))).toBeLessThanOrEqual(0.69);
      amount = amount * 3n + 7n;
    }
  });

  it("refuses what is not a whole, non-negative number of basis points", () => {
    expect(() => feeShareText(1.5)).toThrow(RangeError);
    expect(() => feeShareText(-1)).toThrow(RangeError);
    expect(() => feeShareText(Number.NaN)).toThrow(RangeError);
  });
});

describe("coversCheapBatchedBuy", () => {
  it("asks whether the fee pays for a batched buy's gas at 0.083 gwei", () => {
    const cost = 10_458_000_000_000n;
    expect(BATCHED_BUY_GAS * FEE_CHEAP_REFERENCE).toBe(cost);
    expect(coversCheapBatchedBuy(cost)).toBe(true);
    expect(coversCheapBatchedBuy(cost - 1n)).toBe(false);
  });

  it("holds from 1,515,652,173,913,044 wei a buy, and not one wei below", () => {
    expect(CHEAP_BATCHED_BUY_THRESHOLD).toBe(1_515_652_173_913_044n);
    expect(coversCheapBatchedBuy(buyFee(CHEAP_BATCHED_BUY_THRESHOLD).reward)).toBe(true);
    expect(coversCheapBatchedBuy(buyFee(CHEAP_BATCHED_BUY_THRESHOLD - 1n).reward)).toBe(false);
  });
});

describe("v1BuyFee", () => {
  /** v1's batched buy's network cost at the reference, and a tenth more: 0.00002013 ETH. */
  const V1_FULL = 20_130_000_000_000n;

  it("is v1's rule, frozen: 122,000 gas at 0.15 gwei and a tenth more, at most 0.69%", () => {
    expect(V1_BATCHED_BUY_GAS).toBe(122_000n);
    // Its later buy's gas, which a keeper still costs v1's buys at.
    expect(V1_BATCH_PER_BUY_GAS).toBe(106_000n);
    expect(V1_BUY_FEE_MARKUP_BPS).toBe(1_000n);
    expect(v1BuyFee(10n ** 16n)).toEqual({
      reward: V1_FULL,
      networkPart: 18_300_000_000_000n,
      markupPart: 1_830_000_000_000n,
      ceiling: 69n * 10n ** 12n,
      atCeiling: false,
      shareBps: 21,
    });
  });

  // The table every v1 vault was made from, as the app proposed it before v2: [usd, amountPerBuy, reward, shareBps, atCeiling].
  const V1_TABLE = [
    [1, 378223409003230n, 2609741522122n, 69, true],
    [5, 1891117045016150n, 13048707610611n, 69, true],
    [6.9, 2609741522122287n, 18007216502643n, 69, true],
    [10, 3782234090032301n, V1_FULL, 54, false],
    [25, 9455585225080750n, V1_FULL, 22, false],
    [69, 26097415221222872n, V1_FULL, 8, false],
    [690, 260974152212228719n, V1_FULL, 1, false],
  ] as const;

  it.each(V1_TABLE)("still gives a $%s v1 plan its fee, to the wei", (_usd, amount, reward, shareBps, atCeiling) => {
    expect(v1BuyFee(amount)).toMatchObject({ reward, shareBps, atCeiling });
  });

  it("held at the ceiling below 0.002917391304347827 ETH, as v1 was", () => {
    expect(v1BuyFee(2_917_391_304_347_827n)).toMatchObject({ reward: V1_FULL, atCeiling: false });
    expect(v1BuyFee(2_917_391_304_347_826n)).toMatchObject({ reward: V1_FULL - 1n, atCeiling: true });
  });

  it("asks less than v2's fee of every buy the ceiling doesn't hold, so a v1 vault never pays what v2 proposes", () => {
    for (const amount of [CEILING_BINDS_BELOW, 10n ** 16n, VAULT_LIMITS.MAX_FUNDING]) {
      expect(v1BuyFee(amount).reward < buyFee(amount).reward).toBe(true);
    }
    // Where both are held at the ceiling, they are the same 0.69%.
    expect(v1BuyFee(378223409003230n).reward).toBe(buyFee(378223409003230n).reward);
  });

  it("refuses an amount that is not a buy", () => {
    expect(() => v1BuyFee(0n)).toThrow(RangeError);
  });
});
