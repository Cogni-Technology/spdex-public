/**
 * The keeper's pure decisions, with plain numbers: when a window closes, what
 * counts as a cheap block, which vaults a batch carries and what it may lose,
 * how much gas it gets and what it bids. A mistake here is a keeper that
 * misses windows, or pays for other people's buys without meaning to.
 */

import { describe, expect, it } from "vitest";
import type { Address } from "@spdex/core";
import { BATCHER_LIMITS } from "./artifacts.js";
import { BATCH_FIRST_BUY_EXTRA_GAS, BATCH_FIXED_GAS, BATCH_PER_BUY_GAS } from "./fee.js";
import {
  DEFAULT_KEEPER_POLICY,
  RATIO_ONE,
  batchGasLimit,
  cheapTarget,
  chooseFees,
  deadlineOf,
  earliestBuyAt,
  economicFeePerGas,
  nextBaseFee,
  percentile,
  replacementFees,
  resendIntervalBlocks,
  selectBatch,
  shouldSend,
  splitRoundRobin,
  urgentTipAfter,
  windowOf,
  type BatchCandidate,
  type KeeperPolicy,
} from "./keeper-plan.js";

const GWEI = 10n ** 9n;
const ETHER = 10n ** 18n;
const P = DEFAULT_KEEPER_POLICY;
const policy = (overrides: Partial<KeeperPolicy> = {}): KeeperPolicy => ({ ...P, ...overrides });
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

describe("nextBaseFee", () => {
  const limit = 30_000_000n;
  it("stays at the target, rises above it by up to 12.5%, falls below it by up to 12.5%", () => {
    expect(nextBaseFee({ baseFee: 100n * GWEI, gasUsed: limit / 2n, gasLimit: limit })).toBe(100n * GWEI);
    expect(nextBaseFee({ baseFee: 100n * GWEI, gasUsed: limit, gasLimit: limit })).toBe(112_500_000_000n);
    expect(nextBaseFee({ baseFee: 100n * GWEI, gasUsed: 0n, gasLimit: limit })).toBe(87_500_000_000n);
    // Three quarters full: half of the maximum rise.
    expect(nextBaseFee({ baseFee: 100n * GWEI, gasUsed: (limit * 3n) / 4n, gasLimit: limit })).toBe(106_250_000_000n);
  });

  it("rises by at least one wei above the target, even from a tiny fee", () => {
    expect(nextBaseFee({ baseFee: 7n, gasUsed: 15_000_001n, gasLimit: limit })).toBe(8n);
  });
});

describe("windows and deadlines", () => {
  const daily = { startAt: 1_000_000n, interval: 86_400n, maxBuys: 10n };
  const hourly = { ...daily, interval: 3_600n };
  const fiveMinutes = { ...daily, interval: 300n };

  it("is the vault's own formula: the start first, then the next window or half an interval after the last buy", () => {
    expect(earliestBuyAt(daily, 0n, 0n)).toBe(daily.startAt);
    // Bought early in window 0: the next buy may come at window 1's start.
    expect(earliestBuyAt(daily, 1n, daily.startAt + 100n)).toBe(daily.startAt + 86_400n);
    // Bought late in window 0: pushed to half an interval after it, past window 1's start.
    const late = daily.startAt + 80_000n;
    expect(earliestBuyAt(daily, 1n, late)).toBe(late + 43_200n);
    expect(earliestBuyAt(daily, 10n, late)).toBeNull();
  });

  it("gives a daily plan a two-hour margin, an hourly one twelve minutes, a five-minute one a minute", () => {
    const at = (terms: typeof daily) => windowOf(terms, terms.startAt + 10n);
    expect(deadlineOf(daily, at(daily), P)).toBe(daily.startAt + 86_400n - 7_200n);
    expect(deadlineOf(hourly, at(hourly), P)).toBe(hourly.startAt + 3_600n - 720n);
    expect(deadlineOf(fiveMinutes, at(fiveMinutes), P)).toBe(fiveMinutes.startAt + 300n - 60n);
  });

  it("keeps the half-interval push inside the next window's wait, and makes a push past the deadline urgent at once", () => {
    // An hourly buy at the very end of window 0 pushes the next to 5,399 s; window 1's deadline is 6,480 s.
    const e = earliestBuyAt(hourly, 1n, hourly.startAt + 3_599n)!;
    expect(e).toBe(hourly.startAt + 5_399n);
    expect(e < deadlineOf(hourly, windowOf(hourly, e), P)).toBe(true);
    // With a margin longer than half the interval, the push lands past the deadline: urgent as soon as due.
    const wide = policy({ deadlineMinSeconds: 200n });
    const pushed = earliestBuyAt(fiveMinutes, 1n, fiveMinutes.startAt + 299n)!;
    expect(pushed).toBe(fiveMinutes.startAt + 449n);
    expect(deadlineOf(fiveMinutes, windowOf(fiveMinutes, pushed), wide)).toBe(fiveMinutes.startAt + 400n);
  });

  it("numbers windows as Bought.slot does", () => {
    expect(windowOf(daily, daily.startAt - 5n)).toEqual({ slot: 0n, windowStart: daily.startAt, windowEnd: daily.startAt + 86_400n });
    expect(windowOf(daily, daily.startAt + 86_400n * 3n + 1n).slot).toBe(3n);
  });
});

describe("waiting for a cheap block", () => {
  const samples = Array.from({ length: 100 }, (_, i) => [10_000n + BigInt(i) * 12n, BigInt(i + 1) * GWEI] as const);
  const now = 10_000n + 99n * 12n;

  it("is a percentile by nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5n, 1n, 3n], 0)).toBe(1n);
    expect(percentile([5n, 1n, 3n], 50)).toBe(3n);
    expect(percentile([5n, 1n, 3n], 100)).toBe(5n);
  });

  it("rises from the 10th percentile at the start of the wait to the 60th at the deadline", () => {
    const input = { samples, chainTime: now, from: now, deadline: now + 1_000n, interval: 86_400n };
    expect(cheapTarget(input, P)).toBe(10n * GWEI);
    expect(cheapTarget({ ...input, from: now - 500n, deadline: now + 500n }, P)).toBe(35n * GWEI);
    expect(cheapTarget({ ...input, from: now - 1_000n, deadline: now }, P)).toBe(60n * GWEI);
    expect(cheapTarget({ ...input, from: now - 2_000n, deadline: now - 1_000n }, P)).toBe(60n * GWEI);
  });

  it("looks back over the plan's interval, at least an hour, and knows nothing without samples", () => {
    const old = [[now - 7_200n, GWEI] as const, [now, 50n * GWEI] as const];
    expect(cheapTarget({ samples: old, chainTime: now, from: now, deadline: now + 100n, interval: 300n }, P)).toBe(50n * GWEI);
    expect(cheapTarget({ samples: old, chainTime: now, from: now, deadline: now + 100n, interval: 86_400n }, P)).toBe(GWEI);
    expect(cheapTarget({ samples: [], chainTime: now, from: now, deadline: now + 100n, interval: 300n }, P)).toBeNull();
  });

  it("takes a fixed target over the percentiles", () => {
    expect(cheapTarget({ samples, chainTime: now, from: now, deadline: now + 1n, interval: 300n }, policy({ cheapBaseFee: 7n }))).toBe(7n);
  });

  it("decides to send by the policy: cheap blocks, deadlines, short plans, or now", () => {
    const quiet = { urgent: false, shortInterval: false, target: 10n };
    expect(shouldSend(quiet, 11n, P)).toBeNull();
    expect(shouldSend(quiet, 10n, P)).toBe("cheap");
    expect(shouldSend({ ...quiet, target: null }, 0n, P)).toBeNull();
    expect(shouldSend({ ...quiet, urgent: true }, 99n, P)).toBe("deadline");
    expect(shouldSend({ ...quiet, shortInterval: true }, 99n, P)).toBe("short-interval");
    // A standby keeper sends deadlines only.
    expect(shouldSend({ ...quiet, shortInterval: true }, 0n, policy({ sendWhen: "deadline" }))).toBeNull();
    expect(shouldSend({ ...quiet, urgent: true }, 99n, policy({ sendWhen: "deadline" }))).toBe("deadline");
    expect(shouldSend(quiet, 99n, policy({ sendWhen: "now" }))).toBe("now");
  });
});

describe("selectBatch", () => {
  const F = GWEI / 10n; // 0.1 gwei all in
  const candidate = (n: number, overrides: Partial<BatchCandidate> = {}): BatchCandidate => ({
    vault: addr(n),
    owner: addr(1_000 + n),
    order: BigInt(n),
    pair: addr(0xfa),
    amountPerBuy: ETHER / 100n,
    interval: 86_400n,
    reward: 50_000_000_000_000n, // 0.00005 ETH
    firstBuy: false,
    urgent: false,
    deadline: 10_000n + BigInt(n),
    subsidised24h: 0n,
    ...overrides,
  });
  const select = (candidates: BatchCandidate[], overrides: Partial<Parameters<typeof selectBatch>[0]> = {}) =>
    selectBatch({
      candidates,
      feePerGas: F,
      ratioPpm: RATIO_ONE,
      privateSend: true,
      pairReserves: new Map(),
      ownerSubsidised24h: new Map(),
      dailyLossLeft: P.maxLossPerDay,
      policy: P,
      ...overrides,
    });
  const perBuyCost = BATCH_PER_BUY_GAS * F; // 10,600,000,000,000
  const fixedCost = BATCH_FIXED_GAS * F; // 16,000,000,000,000

  it("sends vaults that pay for themselves and together cover the fixed gas, and plans no loss by default", () => {
    const chosen = select([candidate(1), candidate(2)]);
    expect(chosen.vaults.map((v) => v.vault)).toEqual([addr(1), addr(2)]);
    expect(chosen.allowedLossWei).toBe(0n);
    expect(chosen.expectedCostWei).toBe(fixedCost + 2n * perBuyCost);
    expect(chosen.expectedEarnedWei).toBe(2n * 50_000_000_000_000n);
    expect(chosen.modelGas).toBe(BATCH_FIXED_GAS + 2n * BATCH_PER_BUY_GAS);
  });

  it("sends nothing when the margins don't cover the fixed gas and nothing is subsidised", () => {
    // Each margin is 1 wei: the fixed gas is not covered.
    const thin = candidate(1, { reward: perBuyCost + 1n });
    const chosen = select([thin]);
    expect(chosen.vaults).toEqual([]);
    expect(chosen.skipped).toEqual([{ vault: addr(1), code: "economics", detail: "fees-below-gas" }]);
  });

  it("prices a first buy's extra gas", () => {
    const [later, first] = [select([candidate(1)]).vaults[0]!, select([candidate(1, { firstBuy: true })]).vaults[0]!];
    expect(first.costWei - later.costWei).toBe(BATCH_FIRST_BUY_EXTRA_GAS * F);
  });

  it("scales gas by the calibration ratio", () => {
    const chosen = select([candidate(1)], { ratioPpm: 1_100_000n });
    expect(chosen.vaults[0]!.costWei).toBe(((BATCH_PER_BUY_GAS * 11n) / 10n) * F);
    expect(chosen.expectedGas).toBe(((BATCH_FIXED_GAS + BATCH_PER_BUY_GAS) * 11n) / 10n);
  });

  describe("the subsidy", () => {
    // A $1 buy, 0.000378 ETH, at its 0.69% ceiling: 2,609,741,522,122 wei.
    const small = (n: number, overrides: Partial<BatchCandidate> = {}) =>
      candidate(n, { amountPerBuy: 378_223_409_003_230n, reward: 2_609_741_522_122n, interval: 86_400n, ...overrides });
    const subsidy = policy({ maxLossPerBuy: 60_000_000_000_000n });

    it("serves an eligible losing vault within its caps, and books its share of the loss to it", () => {
      const chosen = select([small(1)], { policy: subsidy });
      expect(chosen.vaults.map((v) => v.vault)).toEqual([addr(1)]);
      const loss = fixedCost + perBuyCost - 2_609_741_522_122n;
      expect(chosen.allowedLossWei).toBe(loss);
      expect(chosen.vaults[0]!.subsidyWei).toBe(loss);
    });

    it("never subsidises dust, or a plan that buys more often than hourly", () => {
      const dust = small(1, { amountPerBuy: 10n ** 9n });
      const frequent = small(2, { interval: 300n });
      const chosen = select([dust, frequent], { policy: subsidy });
      expect(chosen.vaults).toEqual([]);
      expect(chosen.skipped).toEqual([
        { vault: addr(1), code: "economics", detail: "not-subsidised" },
        { vault: addr(2), code: "economics", detail: "not-subsidised" },
      ]);
    });

    it("holds each buy to the per-buy cap", () => {
      const chosen = select([small(1)], { policy: policy({ maxLossPerBuy: 1_000n }) });
      expect(chosen.skipped).toEqual([{ vault: addr(1), code: "economics", detail: "subsidy-cap" }]);
    });

    it("holds each vault to its daily cap", () => {
      const chosen = select([small(1, { subsidised24h: P.maxLossPerVaultPerDay - 1_000n })], { policy: subsidy });
      expect(chosen.skipped).toEqual([{ vault: addr(1), code: "economics", detail: "subsidy-cap" }]);
    });

    it("holds each owner to their daily cap, shared by all their vaults in the batch", () => {
      const owner = addr(0xabc);
      const loss = fixedCost + perBuyCost - 2_609_741_522_122n;
      // Room for about one loss today: the first vault is served, the second is not.
      const chosen = select([small(1, { owner }), small(2, { owner })], {
        policy: subsidy,
        ownerSubsidised24h: new Map([[owner, P.maxSubsidyPerOwnerPerDay - loss - 1_000n]]),
      });
      expect(chosen.vaults.map((v) => v.vault)).toEqual([addr(1)]);
      expect(chosen.skipped).toEqual([{ vault: addr(2), code: "economics", detail: "subsidy-cap" }]);
    });

    it("serves the oldest vaults first, so a flood of new ones cannot crowd them out", () => {
      const vaults = [small(5, { order: 5n }), small(3, { order: 3n }), small(9, { order: null }), small(4, { order: 4n })];
      // The day's budget covers a batch of exactly two: the fixed gas and two buys' shortfalls.
      const shortfall = perBuyCost - 2_609_741_522_122n;
      const chosen = select(vaults, { policy: subsidy, dailyLossLeft: fixedCost + 2n * shortfall });
      expect(new Set(chosen.vaults.map((v) => v.vault))).toEqual(new Set([addr(3), addr(4)]));
    });

    it("gives nothing while the daily breaker is open", () => {
      const chosen = select([small(1)], { policy: subsidy, dailyLossLeft: 0n });
      expect(chosen.vaults).toEqual([]);
    });

    it("books each vault at most its own shortfall and caps, so none is carried on another's allowance", () => {
      // Three $1 buys that pay their own gas but not the fixed gas: each needs a third of the loss.
      const paying = (n: number, overrides: Partial<BatchCandidate> = {}) => small(n, { reward: perBuyCost + 2_000_000_000_000n, ...overrides });
      const spentOwner = addr(0x5b1);
      const chosen = select(
        [
          paying(1),
          paying(2),
          paying(3),
          // Its owner's cap for the day is spent: it is left out, and the others still go.
          paying(5, { owner: spentOwner }),
          // Its own cap for the day is spent: the others' unused caps do not carry it.
          small(4, { subsidised24h: P.maxLossPerVaultPerDay }),
        ],
        { policy: subsidy, ownerSubsidised24h: new Map([[spentOwner, P.maxSubsidyPerOwnerPerDay]]) },
      );
      expect(chosen.vaults.map((v) => v.vault)).toEqual([addr(1), addr(2), addr(3)]);
      expect(chosen.skipped).toEqual([
        { vault: addr(5), code: "economics", detail: "fees-below-gas" },
        { vault: addr(4), code: "economics", detail: "subsidy-cap" },
      ]);
      expect(chosen.allowedLossWei).toBe(fixedCost - 3n * 2_000_000_000_000n);
      const ownShortfall = perBuyCost + (fixedCost + 2n) / 3n - (perBuyCost + 2_000_000_000_000n);
      for (const v of chosen.vaults) expect(v.subsidyWei > 0n && v.subsidyWei <= ownShortfall).toBe(true);
      expect(chosen.vaults.reduce((sum, v) => sum + v.subsidyWei, 0n) <= chosen.allowedLossWei).toBe(true);
    });
  });

  describe("a buy the other fees carry", () => {
    // A $1 buy at spDEX's proposed fee (its 0.69% ceiling), which does not cover its own gas.
    const small = (n: number, overrides: Partial<BatchCandidate> = {}) =>
      candidate(n, { amountPerBuy: 378_223_409_003_230n, reward: 2_609_741_522_122n, ...overrides });

    it("rides on the others' surplus with no subsidy, when it pays the fee spDEX proposes", () => {
      const chosen = select([candidate(1), small(2)]);
      expect(new Set(chosen.vaults.map((v) => v.vault))).toEqual(new Set([addr(1), addr(2)]));
      expect(chosen.allowedLossWei).toBe(0n);
      expect(chosen.vaults.every((v) => v.subsidyWei === 0n)).toBe(true);
    });

    it("pays its own way or waits when it set itself a lower fee", () => {
      const chosen = select([candidate(1), small(2, { reward: 1n })]);
      expect(chosen.vaults.map((v) => v.vault)).toEqual([addr(1)]);
      expect(chosen.skipped).toEqual([{ vault: addr(2), code: "economics", detail: "not-subsidised" }]);
    });

    it("says no subsidy is on offer, rather than a cap, when the others can't carry it", () => {
      expect(select([small(1)]).skipped).toEqual([{ vault: addr(1), code: "economics", detail: "no-subsidy" }]);
    });
  });

  it("opens the breaker's price: the margin applied twice", () => {
    expect(economicFeePerGas(100n, 20n, P, false)).toBe(112n + 20n);
    expect(economicFeePerGas(1_000_000n, 20n, P, true)).toBe(1_265_625n + 20n);
  });

  it("holds a public batch's buys on one pair to 10 bps of its WETH reserve, best margins first", () => {
    const reserve = 2_329n * ETHER;
    const big = (n: number, reward: bigint) => candidate(n, { amountPerBuy: ETHER, reward });
    const chosen = select([big(1, ETHER / 1_000n), big(2, ETHER / 100n), big(3, ETHER / 500n)], {
      privateSend: false,
      pairReserves: new Map([[addr(0xfa), reserve]]),
    });
    // 2.329 WETH of room: the two best-paying 1-ETH buys.
    expect(new Set(chosen.vaults.map((v) => v.vault))).toEqual(new Set([addr(2), addr(3)]));
    expect(chosen.skipped).toEqual([{ vault: addr(1), code: "public-pair-cap", detail: expect.any(String) }]);
    // An unknown reserve is not a zero cap, nor no cap: those buys wait.
    const unknown = select([big(1, ETHER / 100n)], { privateSend: false, pairReserves: new Map([[addr(0xfa), null]]) });
    expect(unknown.vaults).toEqual([]);
    expect(unknown.skipped[0]).toMatchObject({ code: "public-pair-cap" });
  });

  it("runs small buys first, and ties by address", () => {
    const chosen = select([
      candidate(3, { amountPerBuy: ETHER / 10n }),
      candidate(1, { amountPerBuy: ETHER / 1_000n }),
      candidate(2, { amountPerBuy: ETHER / 1_000n }),
    ]);
    expect(chosen.vaults.map((v) => v.vault)).toEqual([addr(1), addr(2), addr(3)]);
  });

  it("asks a private batch to earn what it costs, less the loss it may take; a public one nothing", () => {
    const chosen = select([candidate(1), candidate(2)]);
    expect(chosen.minRewards).toBe(chosen.expectedCostWei);
    const loss = select([candidate(1, { amountPerBuy: 378_223_409_003_230n, reward: 2_609_741_522_122n })], { policy: policy({ maxLossPerBuy: ETHER }) });
    expect(loss.minRewards).toBe(loss.expectedCostWei - loss.allowedLossWei);
    expect(loss.minRewards).toBe(2_609_741_522_122n);
    expect(select([candidate(1), candidate(2)], { privateSend: false, pairReserves: new Map([[addr(0xfa), 1_000n * ETHER]]) }).minRewards).toBe(0n);
  });
});

describe("gas limits and splitting", () => {
  it("gives every vault its figure and the last one a whole attempt's tail", () => {
    expect(batchGasLimit([])).toBe(60_000n + BATCHER_LIMITS.MIN_GAS_PER_ATTEMPT);
    // Ten later buys: 60k + 1.27M + 460k.
    expect(batchGasLimit(Array.from({ length: 10 }, () => ({ firstBuy: false })))).toBe(1_790_000n);
    expect(batchGasLimit([{ firstBuy: true }, { firstBuy: false }])).toBe(60_000n + 178_000n + 127_000n + 460_000n);
  });

  it("deals round-robin into the fewest chunks that fit", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: i, firstBuy: false }));
    expect(splitRoundRobin(items, P)).toEqual([items]);
    const chunks = splitRoundRobin(items, policy({ maxVaultsPerBatch: 3 }));
    expect(chunks.map((c) => c.map((x) => x.id))).toEqual([
      [0, 3, 6],
      [1, 4],
      [2, 5],
    ]);
    // A gas cap that fits five later buys a chunk.
    const byGas = splitRoundRobin(items, policy({ maxBatchGas: 60_000n + 5n * 127_000n + 460_000n }));
    expect(byGas.map((c) => c.length)).toEqual([4, 3]);
  });
});

describe("fees", () => {
  it("bids the policy's tip normally, and never above the cap", () => {
    const next = 100_000_000n;
    expect(chooseFees({ next, legacy: false, urgent: false }, P)).toEqual({
      fees: { type: "eip1559", maxFeePerGas: 2n * next + P.tip, maxPriorityFeePerGas: P.tip },
      tip: P.tip,
    });
    expect(chooseFees({ next: 2n * GWEI, legacy: false, urgent: false }, P)).toMatchObject({ fees: { maxFeePerGas: 3n * GWEI } });
    expect(chooseFees({ next: 3n * GWEI, legacy: false, urgent: false }, P)).toEqual({ blocked: "fees-above-max" });
  });

  it("escalates a deadline send's tip by half each resend, up to the cap", () => {
    expect([0, 1, 2, 3, 4, 5].map((r) => urgentTipAfter(r, P))).toEqual([
      100_000_000n,
      150_000_000n,
      225_000_000n,
      337_500_000n,
      500_000_000n,
      500_000_000n,
    ]);
    expect(chooseFees({ next: 0n, legacy: false, urgent: true, resends: 2 }, P)).toMatchObject({ tip: 225_000_000n });
  });

  it("bids a legacy chain its gas price, capped", () => {
    expect(chooseFees({ next: GWEI, legacy: true, urgent: false }, P)).toEqual({ fees: { type: "legacy", gasPrice: GWEI }, tip: 0n });
    expect(chooseFees({ next: 4n * GWEI, legacy: true, urgent: false }, P)).toEqual({ blocked: "fees-above-max" });
  });

  it("replaces with both fields up at least 10%, or not at all", () => {
    const old = { type: "eip1559" as const, maxFeePerGas: 220_000_000n, maxPriorityFeePerGas: 20_000_000n };
    const replaced = replacementFees(old, { next: 100_000_000n, urgent: false, resends: 1 }, P)!;
    expect(replaced.type).toBe("eip1559");
    if (replaced.type !== "eip1559") return;
    expect(replaced.maxPriorityFeePerGas).toBe(22_500_000n);
    expect(replaced.maxFeePerGas).toBe(247_500_000n);
    // An urgent resend jumps to the escalated tip.
    const urgent = replacementFees(old, { next: 100_000_000n, urgent: true, resends: 1 }, P)!;
    expect(urgent).toMatchObject({ maxPriorityFeePerGas: 150_000_000n, maxFeePerGas: 350_000_000n });
    // At the caps, nothing clears +10%: blocked.
    const capped = { type: "eip1559" as const, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: P.maxTip };
    expect(replacementFees(capped, { next: GWEI, urgent: true, resends: 5 }, P)).toBeNull();
  });

  it("gives a five-minute plan its resends inside the window", () => {
    // 300 s left is 25 blocks: a resend every 8. Two minutes left: every 3. Seconds left: every 2.
    expect(resendIntervalBlocks(25n, P)).toBe(8);
    expect(resendIntervalBlocks(10n, P)).toBe(3);
    expect(resendIntervalBlocks(1n, P)).toBe(2);
    expect(resendIntervalBlocks(1_000n, P)).toBe(10);
  });
});
