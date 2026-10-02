/**
 * The buy fee, to the wei. The examples are docs/ARCHITECTURE.md's ("The buy
 * fee"), at ETH $2,643.94: each amount is `round(usd / 2643.94 × 1e18)` wei, and each fee is
 * what a vault created from this release will pay on every buy, for life. A
 * change to any figure here is a change to what new plans cost, so it is a
 * release decision, not a test to update.
 */

import { describe, expect, it } from "vitest";
import {
  BATCHED_BUY_GAS,
  BATCH_FIRST_BUY_EXTRA_GAS,
  BATCH_FIXED_GAS,
  BATCH_PER_BUY_GAS,
  BUY_FEE_CEILING_BPS,
  BUY_FEE_MARKUP_BPS,
  CHEAP_BATCHED_BUY_THRESHOLD,
  FEE_BATCH_SIZE,
  FULL_FEE_BUY_THRESHOLD,
  FEE_CHEAP_REFERENCE,
  FEE_NETWORK_REFERENCE,
  FEE_TIP_REFERENCE,
  FULL_BUY_FEE,
  atFeeCeiling,
  buyFee,
  buyFeeAt,
  coversCheapBatchedBuy,
  feeCeiling,
  feeShareBps,
  feeShareText,
  withinFeeCeiling,
} from "./fee.js";
import { VAULT_LIMITS } from "./artifacts.js";

describe("constants", () => {
  it("are the release's: one batched buy's gas at 0.15 gwei, a tenth more, and a 0.69% ceiling", () => {
    expect(BUY_FEE_MARKUP_BPS).toBe(1_000n);
    expect(BUY_FEE_CEILING_BPS).toBe(69n);
    expect(BATCH_FIXED_GAS).toBe(160_000n);
    expect(BATCH_PER_BUY_GAS).toBe(106_000n);
    expect(BATCH_FIRST_BUY_EXTRA_GAS).toBe(51_000n);
    expect(FEE_BATCH_SIZE).toBe(10n);
    expect(BATCHED_BUY_GAS).toBe(122_000n);
    expect(FEE_TIP_REFERENCE).toBe(20_000_000n);
    expect(FEE_NETWORK_REFERENCE).toBe(150_000_000n);
    expect(FEE_CHEAP_REFERENCE).toBe(83_000_000n);
  });

  it("has no ceiling of its own: the app's is the contract's, so neither can promise what the other does not hold", () => {
    expect(VAULT_LIMITS.MAX_REWARD_BPS).toBe(69n);
    expect(BUY_FEE_CEILING_BPS).toBe(VAULT_LIMITS.MAX_REWARD_BPS);
  });
});

describe("buyFee", () => {
  /** One batched buy's network cost at the release's reference, and a tenth more: 0.00002013 ETH. */
  const FULL = 20_130_000_000_000n;

  it("asks every buy the ceiling does not hold for the same 0.00002013 ETH", () => {
    expect(FULL_BUY_FEE).toBe(FULL);
  });

  // [usd, amountPerBuy, reward, shareBps, shown, atCeiling]
  const TABLE = [
    [1, 378223409003230n, 2609741522122n, 69, "0.69", true],
    [5, 1891117045016150n, 13048707610611n, 69, "0.69", true],
    [6.9, 2609741522122287n, 18007216502643n, 69, "0.69", true],
    [10, 3782234090032301n, FULL, 54, "0.54", false],
    [25, 9455585225080750n, FULL, 22, "0.22", false],
    [69, 26097415221222872n, FULL, 8, "0.08", false],
    [690, 260974152212228719n, FULL, 1, "0.01", false],
  ] as const;

  it.each(TABLE)("is the documented figure for a $%s buy, to the wei", (_usd, amount, reward, shareBps, shown, atCeiling) => {
    const fee = buyFee(amount);
    expect(fee.networkPart).toBe(18_300_000_000_000n);
    expect(fee.markupPart).toBe(1_830_000_000_000n);
    expect(fee.reward).toBe(reward);
    expect(fee.shareBps).toBe(shareBps);
    expect(feeShareText(fee.shareBps)).toBe(shown);
    expect(fee.atCeiling).toBe(atCeiling);
    expect(fee.ceiling).toBe((amount * 69n) / 10_000n);
  });

  it("is never more than 0.69% of the buy, the network cost included, at any amount and any network fee", () => {
    const amounts = [1n, 144n, 145n, 12_345n, 10n ** 12n, 1_467_536_231_884_058n, 2_917_391_304_347_827n, 10n ** 16n, VAULT_LIMITS.MAX_FUNDING];
    // From free to 1,000 gwei: no network fee, however dear, lifts the fee past the ceiling.
    for (const networkFeePerGas of [0n, 1n, FEE_CHEAP_REFERENCE, FEE_NETWORK_REFERENCE, 10n ** 9n, 10n ** 12n]) {
      for (const amountPerBuy of amounts) {
        const fee = buyFeeAt({ amountPerBuy, networkFeePerGas });
        expect(fee.reward * 10_000n <= amountPerBuy * 69n).toBe(true);
        expect(fee.shareBps).toBeLessThanOrEqual(69);
        expect(fee.reward <= fee.ceiling).toBe(true);
        // The ceiling binds exactly when the network part and its tenth come to more than it.
        expect(fee.atCeiling).toBe(fee.networkPart + fee.markupPart > fee.ceiling);
        expect(fee.reward).toBe(fee.atCeiling ? fee.ceiling : fee.networkPart + fee.markupPart);
        // And it is a fee the factory accepts: `keeperReward × 10,000 ≤ amountPerBuy × MAX_REWARD_BPS`.
        expect(fee.reward * 10_000n <= amountPerBuy * VAULT_LIMITS.MAX_REWARD_BPS).toBe(true);
        expect(withinFeeCeiling(fee.reward, amountPerBuy)).toBe(true);
      }
    }
  });

  it("rounds the tenth up and the ceiling down", () => {
    // 1 wei a gas: 122,000 wei of network cost, and a tenth of it is 12,200 exactly.
    expect(buyFeeAt({ amountPerBuy: 10n ** 16n, networkFeePerGas: 1n })).toMatchObject({ networkPart: 122_000n, markupPart: 12_200n, reward: 134_200n });
    // 10,144 wei: 0.69% of it is 69.99…, held to 69.
    expect(buyFee(10_144n)).toMatchObject({ ceiling: 69n, reward: 69n, atCeiling: true });
    expect(buyFee(10_145n)).toMatchObject({ ceiling: 70n, reward: 70n, atCeiling: true });
  });

  it("binds at the ceiling for buys under 0.002917391304347827 ETH, and not from there up", () => {
    const binds = 2_917_391_304_347_827n;
    expect(FULL_FEE_BUY_THRESHOLD).toBe(binds);
    expect(buyFee(binds)).toMatchObject({ reward: FULL, atCeiling: false });
    expect(buyFee(binds - 1n)).toMatchObject({ reward: FULL - 1n, atCeiling: true });
  });

  it("is the same for every buy the ceiling does not bind, whatever its size", () => {
    expect(buyFee(10n ** 16n).reward).toBe(FULL);
    expect(buyFee(VAULT_LIMITS.MAX_FUNDING)).toMatchObject({ reward: FULL, shareBps: 1 });
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
    const amount = 3782234090032301n; // $10
    const atOneGwei = buyFeeAt({ amountPerBuy: amount, networkFeePerGas: 1_000_000_000n });
    expect(atOneGwei).toMatchObject({ networkPart: 122_000_000_000_000n, markupPart: 12_200_000_000_000n });
    // 134.2e12 is above 0.69% (26,097,415,221,222): held there.
    expect(atOneGwei).toMatchObject({ reward: 26_097_415_221_222n, ceiling: 26_097_415_221_222n, atCeiling: true, shareBps: 69 });
    // With no network cost there is nothing to ask a tenth of: the fee is nothing.
    const free = buyFeeAt({ amountPerBuy: amount, networkFeePerGas: 0n });
    expect(free).toMatchObject({ networkPart: 0n, markupPart: 0n, reward: 0n, atCeiling: false, shareBps: 0 });
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
    const cost = 10_126_000_000_000n;
    expect(BATCHED_BUY_GAS * FEE_CHEAP_REFERENCE).toBe(cost);
    expect(coversCheapBatchedBuy(cost)).toBe(true);
    expect(coversCheapBatchedBuy(cost - 1n)).toBe(false);
  });

  it("holds from 1,467,536,231,884,058 wei a buy, and not one wei below", () => {
    expect(CHEAP_BATCHED_BUY_THRESHOLD).toBe(1_467_536_231_884_058n);
    expect(coversCheapBatchedBuy(buyFee(CHEAP_BATCHED_BUY_THRESHOLD).reward)).toBe(true);
    expect(coversCheapBatchedBuy(buyFee(CHEAP_BATCHED_BUY_THRESHOLD - 1n).reward)).toBe(false);
  });
});
