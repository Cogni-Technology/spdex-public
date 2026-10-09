/**
 * Routing tests.
 *
 * Candidates are generated from a real constant-product curve rather than
 * hand-written numbers, so the diminishing returns the greedy allocator
 * depends on are actually present — a table of made-up outputs could satisfy
 * every assertion here while being convex, which is the one shape the
 * algorithm is not valid for.
 */

import { describe, expect, it } from "vitest";
import { IGNORE_GAS, linearGasModel } from "./gas.js";
import { chunkGrid, planRoute, RoutingError, type RouteCandidate } from "./route.js";

/** x*y=k with a fee, the shape every AMM quote approximates. */
function constantProduct(reserveIn: bigint, reserveOut: bigint, feeBps: bigint) {
  return (amountIn: bigint): bigint => {
    const afterFee = (amountIn * (10_000n - feeBps)) / 10_000n;
    return (reserveOut * afterFee) / (reserveIn + afterFee);
  };
}

function poolCandidate(options: {
  poolId: string;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps?: bigint;
  gasEstimate?: bigint;
  amountIn: bigint;
  chunkCount: number;
  /** Cap beyond which the pool cannot quote, modelling thin liquidity. */
  maxQuotable?: bigint;
}): RouteCandidate {
  const curve = constantProduct(options.reserveIn, options.reserveOut, options.feeBps ?? 30n);
  const gasEstimate = options.gasEstimate ?? 150_000n;
  const quotes = chunkGrid(options.amountIn, options.chunkCount)
    .filter((amount) => options.maxQuotable === undefined || amount <= options.maxQuotable)
    .map((amount) => ({ amountIn: amount, amountOut: curve(amount), gasEstimate }));
  return { venueId: "venue-uniswap-v3", poolId: options.poolId, quotes };
}

const ONE = 10n ** 18n;
const AMOUNT_IN = 100n * ONE;
const CHUNKS = 10;

const base = {
  amountIn: AMOUNT_IN,
  chunkCount: CHUNKS,
  maxSplits: 4,
  minSplitGainBps: 5,
};

describe("chunkGrid", () => {
  it("produces ascending cumulative amounts", () => {
    const grid = chunkGrid(1000n, 4);
    expect(grid).toEqual([250n, 500n, 750n, 1000n]);
  });

  it("quotes the whole amount when it is smaller than the chunk count", () => {
    // Splitting 5 wei ten ways is meaningless; one quote is the honest answer.
    expect(chunkGrid(5n, 10)).toEqual([5n]);
  });

  it("returns nothing for a zero amount", () => {
    expect(chunkGrid(0n, 10)).toEqual([]);
  });
});

describe("splitting when it pays", () => {
  const twoEqualPools = [
    poolCandidate({ poolId: "0xaaa", reserveIn: 1000n * ONE, reserveOut: 1000n * ONE, ...base }),
    poolCandidate({ poolId: "0xbbb", reserveIn: 1000n * ONE, reserveOut: 1000n * ONE, ...base }),
  ];

  it("splits across two comparable pools and beats either alone", () => {
    const plan = planRoute({ ...base, candidates: twoEqualPools, gas: IGNORE_GAS });

    expect(plan.legs.length).toBe(2);
    expect(plan.rationale.bestSingle).not.toBeNull();
    expect(plan.amountOut).toBeGreaterThan(plan.rationale.bestSingle!.amountOut);
  });

  it("allocates the input exactly, with no dust lost", () => {
    // Legs that did not sum to the input would silently strand user funds.
    const plan = planRoute({ ...base, candidates: twoEqualPools, gas: IGNORE_GAS });
    const total = plan.legs.reduce((sum, leg) => sum + leg.amountIn, 0n);
    expect(total).toBe(AMOUNT_IN);
  });

  it("reports shares that account for the whole trade", () => {
    const plan = planRoute({ ...base, candidates: twoEqualPools, gas: IGNORE_GAS });
    const shares = plan.legs.reduce((sum, leg) => sum + leg.shareBps, 0);
    expect(shares).toBeGreaterThanOrEqual(9_990);
    expect(shares).toBeLessThanOrEqual(10_000);
  });

  it("concentrates on the deeper pool when depths are lopsided", () => {
    const plan = planRoute({
      ...base,
      candidates: [
        poolCandidate({ poolId: "0xdeep", reserveIn: 5000n * ONE, reserveOut: 5000n * ONE, ...base }),
        poolCandidate({ poolId: "0xthin", reserveIn: 20n * ONE, reserveOut: 20n * ONE, ...base }),
      ],
      gas: IGNORE_GAS,
    });

    const deep = plan.legs.find((l) => l.poolId === "0xdeep");
    expect(deep).toBeDefined();
    expect(deep!.shareBps).toBeGreaterThan(7_000);
  });
});

describe("gas has to be earned", () => {
  const twoEqualPools = [
    poolCandidate({ poolId: "0xaaa", reserveIn: 1000n * ONE, reserveOut: 1000n * ONE, ...base }),
    poolCandidate({ poolId: "0xbbb", reserveIn: 1000n * ONE, reserveOut: 1000n * ONE, ...base }),
  ];

  it("refuses a second leg when gas costs more than the split gains", () => {
    // The same pools that split profitably above collapse to one leg once the
    // extra leg's gas is priced in. Without this the router would always split.
    const plan = planRoute({
      ...base,
      candidates: twoEqualPools,
      gas: linearGasModel({ gasPriceWei: 500n * 10n ** 9n, tokenOutPerNative: 1000n * ONE }),
    });

    expect(plan.legs.length).toBe(1);
  });

  it("still splits when gas is cheap relative to the gain", () => {
    const plan = planRoute({
      ...base,
      candidates: twoEqualPools,
      gas: linearGasModel({ gasPriceWei: 1n * 10n ** 9n, tokenOutPerNative: ONE / 1000n }),
    });

    expect(plan.legs.length).toBe(2);
  });

  it("ranks routes by output net of gas", () => {
    const gas = linearGasModel({ gasPriceWei: 20n * 10n ** 9n, tokenOutPerNative: ONE });
    const plan = planRoute({ ...base, candidates: twoEqualPools, gas });
    expect(plan.netAmountOut).toBe(plan.amountOut - gas.costInTokenOut(plan.gasEstimate));
    expect(plan.netAmountOut).toBeLessThan(plan.amountOut);
  });

  it("records why a split was rejected", () => {
    // Expert mode shows this; "we picked one pool" without a reason is not an
    // explanation a user can check.
    const plan = planRoute({
      ...base,
      minSplitGainBps: 9_000,
      candidates: twoEqualPools,
      gas: IGNORE_GAS,
    });

    expect(plan.legs.length).toBe(1);
    expect(plan.rationale.rejectedSplit).toBeDefined();
    expect(plan.rationale.rejectedSplit!.legs).toBe(2);
    expect(plan.rationale.rejectedSplit!.requiredBps).toBe(9_000);
    expect(plan.rationale.rejectedSplit!.gainBps).toBeLessThan(9_000);
  });
});

describe("limits and pinning", () => {
  const fourPools = [1000n, 900n, 800n, 700n, 600n].map((reserve, i) =>
    poolCandidate({
      poolId: `0xpool${i}`,
      reserveIn: reserve * ONE,
      reserveOut: reserve * ONE,
      ...base,
    }),
  );

  it("never exceeds maxSplits", () => {
    const plan = planRoute({ ...base, maxSplits: 2, candidates: fourPools, gas: IGNORE_GAS });
    expect(plan.legs.length).toBeLessThanOrEqual(2);
  });

  it("routes through exactly one pool when only one is offered", () => {
    // This is what "pin to a single pool" reduces to: the policy filters the
    // candidate set, and the router must not reach outside it.
    const pinned = fourPools[2]!;
    const plan = planRoute({ ...base, candidates: [pinned], gas: IGNORE_GAS });

    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]!.poolId).toBe(pinned.poolId);
    expect(plan.legs[0]!.amountIn).toBe(AMOUNT_IN);
  });

  it("returns an empty plan rather than inventing a route", () => {
    const plan = planRoute({ ...base, candidates: [], gas: IGNORE_GAS });
    expect(plan.legs).toEqual([]);
    expect(plan.amountOut).toBe(0n);
  });
});

describe("bad or partial quote data", () => {
  it("uses a pool only up to the size it can quote", () => {
    // A thin pool that reverts above some size shows up as missing grid entries.
    const plan = planRoute({
      ...base,
      candidates: [
        poolCandidate({ poolId: "0xdeep", reserveIn: 2000n * ONE, reserveOut: 2000n * ONE, ...base }),
        poolCandidate({
          poolId: "0xcapped",
          reserveIn: 900n * ONE,
          reserveOut: 900n * ONE,
          maxQuotable: 30n * ONE,
          ...base,
        }),
      ],
      gas: IGNORE_GAS,
    });

    const capped = plan.legs.find((l) => l.poolId === "0xcapped");
    if (capped) expect(capped.amountIn).toBeLessThanOrEqual(30n * ONE);
    expect(plan.legs.reduce((s, l) => s + l.amountIn, 0n)).toBe(AMOUNT_IN);
  });

  it("ignores a pool whose output falls as its input grows", () => {
    // Physically impossible, so it means the venue is misquoting. Excluding it
    // is safer than letting a negative marginal distort the allocation.
    const broken: RouteCandidate = {
      venueId: "venue-broken",
      poolId: "0xbroken",
      quotes: chunkGrid(AMOUNT_IN, CHUNKS).map((amountIn, i) => ({
        amountIn,
        amountOut: (100n - BigInt(i)) * ONE,
        gasEstimate: 150_000n,
      })),
    };
    const good = poolCandidate({
      poolId: "0xgood",
      reserveIn: 1000n * ONE,
      reserveOut: 1000n * ONE,
      ...base,
    });

    const plan = planRoute({ ...base, candidates: [broken, good], gas: IGNORE_GAS });
    // It may appear at one chunk, but must never absorb the trade.
    const brokenLeg = plan.legs.find((l) => l.poolId === "0xbroken");
    expect(brokenLeg?.shareBps ?? 0).toBeLessThan(2_000);
  });

  it("rejects a non-positive input rather than producing a degenerate plan", () => {
    expect(() => planRoute({ ...base, amountIn: 0n, candidates: [], gas: IGNORE_GAS })).toThrow(
      RoutingError,
    );
  });
});
