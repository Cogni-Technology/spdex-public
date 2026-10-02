/**
 * TickMath and the tick→price conversions.
 *
 * Pure integer maths with no network in sight, so it is unit-testable and worth
 * testing hard: every number the oracle produces passes through here, and a
 * quiet off-by-one in the conversion would show up as spurious divergence
 * warnings on perfectly good swaps — which trains people to ignore the warning.
 *
 * Then which pool the oracle reads, against a scripted Uniswap: the fork suite
 * checks the rules against real pools, and this checks each rule on its own.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import { NATIVE_TOKEN, TOKENS } from "./constants.js";
import {
  TWAP_MIN_DEPTH,
  TWAP_MIN_OBSERVATIONS,
  UniswapV3TwapOracle,
  harmonicMeanLiquidity,
  inversePriceX18AtTick,
  meanTick,
  priceX18AtTick,
  sqrtRatioAtTick,
  wethDepthAtTick,
} from "./oracle.js";

const Q96 = 1n << 96n;
const WAD = 10n ** 18n;

describe("sqrtRatioAtTick", () => {
  it("is exactly 2^96 at tick zero", () => {
    // Uniswap's own anchor: sqrt(1) in Q64.96.
    expect(sqrtRatioAtTick(0)).toBe(Q96);
    expect(Q96).toBe(79228162514264337593543950336n);
  });

  it("matches the v3 core library at the tick extremes", () => {
    // MIN_SQRT_RATIO and MAX_SQRT_RATIO, straight from TickMath.sol.
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n);
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n);
  });

  it("is monotonic in the tick", () => {
    let previous = sqrtRatioAtTick(-5000);
    for (let tick = -4999; tick <= 5000; tick += 137) {
      const current = sqrtRatioAtTick(tick);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("refuses a tick outside the representable range", () => {
    expect(() => sqrtRatioAtTick(887273)).toThrow(RangeError);
    expect(() => sqrtRatioAtTick(-887273)).toThrow(RangeError);
    expect(() => sqrtRatioAtTick(1.5)).toThrow(RangeError);
  });
});

describe("priceX18AtTick", () => {
  it("is 1e18 at tick zero", () => {
    expect(priceX18AtTick(0)).toBe(WAD);
    expect(inversePriceX18AtTick(0)).toBe(WAD);
  });

  it("tracks 1.0001^tick", () => {
    // A tick is one basis point of price, so 10000 ticks is roughly e.
    const ratio = Number(priceX18AtTick(10_000)) / Number(WAD);
    expect(ratio).toBeCloseTo(1.0001 ** 10_000, 3);
  });

  it("inverts consistently", () => {
    for (const tick of [-60000, -1000, 1000, 60000]) {
      const product =
        (priceX18AtTick(tick) * inversePriceX18AtTick(tick)) / WAD;
      // Both sides round, so allow a hair either way rather than exact 1e18.
      const drift = product > WAD ? product - WAD : WAD - product;
      expect(drift).toBeLessThan(WAD / 1_000_000n);
    }
  });
});

describe("meanTick", () => {
  it("averages over the window", () => {
    expect(meanTick(0n, 6000n, 600)).toBe(10);
  });

  it("floors toward negative infinity, as Uniswap does", () => {
    // -5999/600 truncates to -9 and floors to -10. Truncating would bias every
    // pair whose token ordering happens to put the price below 1.
    expect(meanTick(0n, -5999n, 600)).toBe(-10);
    expect(meanTick(0n, -6000n, 600)).toBe(-10);
  });

  it("handles a cumulative that has not moved", () => {
    expect(meanTick(1234n, 1234n, 600)).toBe(0);
  });
});

describe("harmonicMeanLiquidity", () => {
  const WINDOW = 600;
  const Q128 = 1n << 128n;

  it("is the liquidity that was in range for the whole window", () => {
    const liquidity = 10n ** 20n;
    const grew = (BigInt(WINDOW) * Q128) / liquidity;
    const mean = harmonicMeanLiquidity(12_345n, 12_345n + grew, WINDOW);
    // The accumulator rounds down once, so the mean may be a hair under.
    expect(liquidity - mean).toBeGreaterThanOrEqual(0n);
    expect(liquidity - mean).toBeLessThan(liquidity / 10n ** 12n);
  });

  it("is dragged towards nothing by one minute with nothing in range", () => {
    // Nine minutes deep, one minute empty (which Uniswap counts as liquidity
    // 1): the harmonic mean is about 600 / 60 = 10, not nine tenths of the
    // depth. That is what makes a position added for the moment of choosing
    // worth nothing here.
    const grew = (540n * Q128) / 10n ** 20n + 60n * Q128;
    expect(harmonicMeanLiquidity(0n, grew, WINDOW)).toBeLessThanOrEqual(10n);
  });

  it("wraps as the uint160 accumulator does", () => {
    const grew = (BigInt(WINDOW) * Q128) / 10n ** 20n;
    const top = 1n << 160n;
    expect(harmonicMeanLiquidity(top - 5n, grew - 5n, WINDOW)).toBe(harmonicMeanLiquidity(0n, grew, WINDOW));
  });

  it("answers an accumulator that did not move as no liquidity, not infinite", () => {
    expect(harmonicMeanLiquidity(1234n, 1234n, WINDOW)).toBe(0n);
  });
});

describe("wethDepthAtTick", () => {
  it("is the liquidity itself at price one, whichever side WETH is on", () => {
    expect(wethDepthAtTick(0, 5n * WAD, true)).toBe(5n * WAD);
    expect(wethDepthAtTick(0, 5n * WAD, false)).toBe(5n * WAD);
  });

  it("is L / √P for token0 and L · √P for token1", () => {
    const sqrtPrice = sqrtRatioAtTick(-150_000);
    const liquidity = 10n ** 16n;
    expect(wethDepthAtTick(-150_000, liquidity, true)).toBe((liquidity * Q96) / sqrtPrice);
    expect(wethDepthAtTick(-150_000, liquidity, false)).toBe((liquidity * sqrtPrice) / Q96);
  });
});

// ─── A scripted Uniswap ──────────────────────────────────────────────────────
//
// Pools and pairs against WETH, answering exactly the calls the oracle makes,
// so each test states a market and the only thing under test is the choice.

const WETH = TOKENS.WETH.address;
const SPX = TOKENS.SPX.address;
const USDC = TOKENS.USDC.address;
const WINDOW = 600;
const ETHER = 10n ** 18n;
const Q192 = 1n << 192n;

/** SPX per WETH, in the pool's own orientation (WETH is token0). */
const SPX_TICK = -150_000;
/** WETH per USDC (USDC is token0). */
const USDC_TICK = 198_000;

interface ScriptedPool {
  address: Address;
  /** The token priced against WETH. */
  token: Address;
  fee: number;
  /** Mean tick over the window: token1 per token0, as the pool orders them. */
  tick: number;
  observations: number;
  /** Harmonic-mean depth over the window, in wei of WETH. */
  depth: bigint;
  /** False for a pool whose history does not reach back a window: `observe` reverts. */
  answers?: boolean;
}

interface ScriptedPair {
  address: Address;
  token: Address;
  wethReserve: bigint;
  tokenReserve: bigint;
}

const word = (value: bigint) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");
const addressAt = (data: string, index: number) => `0x${data.slice(10 + index * 64 + 24, 10 + (index + 1) * 64)}`;
const wethIsToken0 = (token: Address) => WETH < token.toLowerCase();

/** A pool on the WETH/SPX market; real addresses, so the fixture reads like the chain. */
const spxPool = (fee: 500 | 3000 | 10_000, overrides: Partial<ScriptedPool> = {}): ScriptedPool => ({
  address: (
    {
      500: "0xe60fba68aa34040a1da64cc661d06920853c16cf",
      3000: "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3",
      10_000: "0x00ed26e794b949e18b142f9108429b74ce08ac99",
    } as const
  )[fee],
  token: SPX,
  fee,
  tick: SPX_TICK,
  observations: 1_800,
  depth: 60n * ETHER,
  ...overrides,
});

const usdcPool = (overrides: Partial<ScriptedPool> = {}): ScriptedPool => ({
  address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  token: USDC,
  fee: 500,
  tick: USDC_TICK,
  observations: 723,
  depth: 90_000n * ETHER,
  ...overrides,
});

/**
 * A v2 pair whose mid is the price at `tick`, moved `offBps` basis points
 * (more of the token per WETH for a positive figure).
 */
function pairAt(token: Address, tick: number, wethReserve: bigint, offBps = 0): ScriptedPair {
  const sqrtPrice = sqrtRatioAtTick(tick);
  const tokenPerWeth = wethIsToken0(token)
    ? (wethReserve * sqrtPrice * sqrtPrice) / Q192
    : (wethReserve * Q192) / (sqrtPrice * sqrtPrice);
  return {
    address: token === SPX ? "0x52c77b0cb827afbad022e6d6caf2c44452edbc39" : "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
    token,
    wethReserve,
    tokenReserve: (tokenPerWeth * BigInt(10_000 + offBps)) / 10_000n,
  };
}

class ScriptedUniswap {
  readonly calls: { to: Address; data: Hex }[] = [];
  rounds = 0;

  constructor(
    private readonly pools: readonly ScriptedPool[] = [],
    private readonly pairs: readonly ScriptedPair[] = [],
  ) {}

  async multicall(calls: { to: Address; data: Hex }[]): Promise<string[]> {
    this.rounds += 1;
    this.calls.push(...calls);
    return calls.map(({ to, data }) => this.#answer(to.toLowerCase(), data));
  }

  #answer(to: string, data: string): string {
    const selector = data.slice(0, 10);
    const asked = new Set([addressAt(data, 0), addressAt(data, 1)]);
    const forToken = (token: Address) => asked.has(WETH) && asked.has(token);

    if (selector === "0x1698ee82") {
      // getPool(a, b, fee)
      const fee = Number(BigInt(`0x${data.slice(10 + 128, 10 + 192)}`));
      const pool = this.pools.find((p) => forToken(p.token) && p.fee === fee);
      return `0x${word(pool ? BigInt(pool.address) : 0n)}`;
    }
    if (selector === "0xe6a43905") {
      // getPair(a, b)
      const pair = this.pairs.find((p) => forToken(p.token));
      return `0x${word(pair ? BigInt(pair.address) : 0n)}`;
    }

    const pool = this.pools.find((p) => p.address === to);
    if (pool && selector === "0x3850c7bd") {
      // slot0: sqrtPriceX96, tick, index, cardinality, cardinalityNext, feeProtocol, unlocked.
      const count = BigInt(pool.observations);
      return `0x${[sqrtRatioAtTick(pool.tick), BigInt(pool.tick), 0n, count, count, 0n, 1n].map(word).join("")}`;
    }
    if (pool && selector === "0x883bdbfd") {
      if (pool.answers === false) return "0x";
      // observe([WINDOW, 0]): the tick cumulatives, then seconds per liquidity,
      // grown by exactly what `depth` held in range for the whole window means.
      const sqrtPrice = sqrtRatioAtTick(pool.tick);
      const liquidity = wethIsToken0(pool.token) ? (pool.depth * sqrtPrice) / Q96 : (pool.depth * Q96) / sqrtPrice;
      const grew = liquidity === 0n ? BigInt(WINDOW) << 128n : (BigInt(WINDOW) << 128n) / liquidity;
      const base = 987_654_321n;
      return `0x${[0x40n, 0xa0n, 2n, 0n, BigInt(pool.tick * WINDOW), 2n, base, base + grew].map(word).join("")}`;
    }

    const pair = this.pairs.find((p) => p.address === to);
    if (pair && selector === "0x0902f1ac") {
      // getReserves: reserve0, reserve1 (by address order, as v3's tokens), timestamp.
      const [reserve0, reserve1] = wethIsToken0(pair.token)
        ? [pair.wethReserve, pair.tokenReserve]
        : [pair.tokenReserve, pair.wethReserve];
      return `0x${[reserve0, reserve1, 0n].map(word).join("")}`;
    }
    return "0x";
  }
}

/** A healthy WETH/SPX market: SPX's 0.3% pool with its history and depth, and its v2 pair. */
const spxMarket = () => new ScriptedUniswap([spxPool(3000)], [pairAt(SPX, SPX_TICK, 2_500n * ETHER)]);

describe("UniswapV3TwapOracle: which pool it reads", () => {
  it("reads nothing from a pool keeping fewer than 100 observations, however deep", async () => {
    const market = (observations: number) =>
      new ScriptedUniswap([spxPool(500, { observations, depth: 1_000n * ETHER })], [pairAt(SPX, SPX_TICK, 2_500n * ETHER)]);

    const short = new UniswapV3TwapOracle(market(TWAP_MIN_OBSERVATIONS - 1));
    await expect(short.priceRatio(WETH, SPX)).resolves.toBeNull();
    expect((await short.market(SPX))?.pools[0]?.refused).toBe("history");

    await expect(new UniswapV3TwapOracle(market(TWAP_MIN_OBSERVATIONS)).priceRatio(WETH, SPX)).resolves.toBe(
      priceX18AtTick(SPX_TICK),
    );
  });

  it("reads nothing from a pool whose history does not reach back a whole window", async () => {
    const oracle = new UniswapV3TwapOracle(
      new ScriptedUniswap([spxPool(3000, { answers: false })], [pairAt(SPX, SPX_TICK, 2_500n * ETHER)]),
    );
    await expect(oracle.priceRatio(WETH, SPX)).resolves.toBeNull();
    const [pool] = (await oracle.market(SPX))!.pools;
    expect(pool).toMatchObject({ refused: "history", meanTick: null, depth: null });
  });

  it("counts depth across the whole window, and never asks how deep a pool is right now", async () => {
    // The rule this replaced ranked by `liquidity()`, which one narrow
    // position sets for as long as it likes. It is not asked at all now.
    const market = (depth: bigint) =>
      new ScriptedUniswap([spxPool(3000, { depth })], [pairAt(SPX, SPX_TICK, 2_500n * ETHER)]);

    const thinReader = market(TWAP_MIN_DEPTH - ETHER);
    const thin = new UniswapV3TwapOracle(thinReader);
    await expect(thin.priceRatio(WETH, SPX)).resolves.toBeNull();
    expect((await thin.market(SPX))?.pools[0]?.refused).toBe("depth");

    await expect(new UniswapV3TwapOracle(market(TWAP_MIN_DEPTH + ETHER)).priceRatio(WETH, SPX)).resolves.toBe(
      priceX18AtTick(SPX_TICK),
    );
    expect(thinReader.calls.some((call) => call.data.startsWith("0x1a686502"))).toBe(false);
  });

  it("ranks the pools that pass by their depth across the window", async () => {
    const reader = new ScriptedUniswap(
      [spxPool(3000), spxPool(10_000, { tick: SPX_TICK + 50, depth: 500n * ETHER })],
      [pairAt(SPX, SPX_TICK, 2_500n * ETHER)],
    );
    const oracle = new UniswapV3TwapOracle(reader);
    expect((await oracle.market(SPX))?.chosen?.fee).toBe(10_000);
    await expect(oracle.priceRatio(WETH, SPX)).resolves.toBe(priceX18AtTick(SPX_TICK + 50));
  });

  it("prefers a pool that agrees with the v2 pair to a deeper one that does not", async () => {
    // The steer this exists for: a narrow position in a finely spaced pool,
    // deeper at its one price than SPX's own pool, held 5% off the market.
    const steered = spxPool(500, { tick: SPX_TICK + 500, observations: 100, depth: 500n * ETHER });
    const oracle = new UniswapV3TwapOracle(
      new ScriptedUniswap([steered, spxPool(3000)], [pairAt(SPX, SPX_TICK, 2_500n * ETHER)]),
    );
    const market = (await oracle.market(SPX))!;
    expect(market.pools.map((pool) => [pool.fee, pool.refused, pool.agrees])).toEqual([
      [500, null, false],
      [3000, null, true],
    ]);
    expect(market.chosen?.fee).toBe(3000);
    await expect(oracle.priceRatio(WETH, SPX)).resolves.toBe(priceX18AtTick(SPX_TICK));
  });

  it("still answers when the pair has been pushed away from every pool", async () => {
    // For SPX the pair is where the swap happens, so a pair pushed 10% away
    // from the pools is the very thing this check exists to report. Had
    // agreement been a veto, the answer here would be null: no opinion,
    // exactly when one matters.
    const oracle = new UniswapV3TwapOracle(
      new ScriptedUniswap([spxPool(3000)], [pairAt(SPX, SPX_TICK, 2_500n * ETHER, 1_000)]),
    );
    const market = (await oracle.market(SPX))!;
    expect(market.chosen).toMatchObject({ fee: 3000, agrees: false });
    await expect(oracle.priceRatio(WETH, SPX)).resolves.toBe(priceX18AtTick(SPX_TICK));
  });

  it("takes no word from a pair too thin to be hard to move", async () => {
    // A pair holding one WETH, set to the steered pool's price. Were it a
    // reference, the steered pool would be the one that agrees, and chosen.
    const steered = spxPool(500, { tick: SPX_TICK + 500, observations: 100, depth: 20n * ETHER });
    const oracle = new UniswapV3TwapOracle(
      new ScriptedUniswap([steered, spxPool(3000)], [pairAt(SPX, SPX_TICK + 500, ETHER)]),
    );
    const market = (await oracle.market(SPX))!;
    expect(market.reference).toBeNull();
    expect(market.pools.every((pool) => pool.agrees === null)).toBe(true);
    expect(market.chosen?.fee).toBe(3000);
  });

  it("reads the deepest pool that passes when the token has no v2 pair", async () => {
    const oracle = new UniswapV3TwapOracle(
      new ScriptedUniswap([spxPool(3000), spxPool(10_000, { tick: SPX_TICK + 50, depth: 80n * ETHER })]),
    );
    const market = (await oracle.market(SPX))!;
    expect(market.reference).toBeNull();
    expect(market.chosen?.fee).toBe(10_000);
  });

  it("prices two other tokens through WETH, adding the legs' ticks", async () => {
    const reader = new ScriptedUniswap(
      [spxPool(3000), usdcPool()],
      [pairAt(SPX, SPX_TICK, 2_500n * ETHER), pairAt(USDC, USDC_TICK, 4_000n * ETHER)],
    );
    const oracle = new UniswapV3TwapOracle(reader);

    // SPX sorts above WETH and USDC below it, so the legs point opposite ways:
    // WETH per SPX is 1.0001^-SPX_TICK, USDC per WETH is 1.0001^-USDC_TICK.
    const spxInUsdc = await oracle.priceRatio(SPX, USDC);
    expect(spxInUsdc).toBe(priceX18AtTick(-SPX_TICK - USDC_TICK));
    await expect(oracle.priceRatio(USDC, SPX)).resolves.toBe(priceX18AtTick(SPX_TICK + USDC_TICK));

    // And it is the product of the two legs, less the rounding the sum avoids.
    const viaWeth = ((await oracle.priceRatio(SPX, WETH))! * (await oracle.priceRatio(WETH, USDC))!) / WAD;
    const drift = spxInUsdc! > viaWeth ? spxInUsdc! - viaWeth : viaWeth - spxInUsdc!;
    expect(drift * 1_000_000n).toBeLessThan(viaWeth);
  });

  it("has no opinion on a pair when either leg has none", async () => {
    const oracle = new UniswapV3TwapOracle(
      new ScriptedUniswap(
        [spxPool(3000), usdcPool({ observations: 51 })],
        [pairAt(SPX, SPX_TICK, 2_500n * ETHER), pairAt(USDC, USDC_TICK, 4_000n * ETHER)],
      ),
    );
    await expect(oracle.priceRatio(SPX, USDC)).resolves.toBeNull();
    await expect(oracle.priceRatio(WETH, SPX)).resolves.toBe(priceX18AtTick(SPX_TICK));
  });

  it("asks in two round trips, for one leg or two", async () => {
    // It sits in front of the swap button; a round trip per leg per question
    // would be latency the user waits through for a warning they rarely see.
    const one = spxMarket();
    await new UniswapV3TwapOracle(one).priceRatio(WETH, SPX);
    expect(one.rounds).toBe(2);

    const two = new ScriptedUniswap(
      [spxPool(3000), usdcPool()],
      [pairAt(SPX, SPX_TICK, 2_500n * ETHER), pairAt(USDC, USDC_TICK, 4_000n * ETHER)],
    );
    await new UniswapV3TwapOracle(two).priceRatio(SPX, USDC);
    expect(two.rounds).toBe(2);
  });

  it("has no market to describe for WETH, or for ether", async () => {
    const reader = spxMarket();
    const oracle = new UniswapV3TwapOracle(reader);
    await expect(oracle.market(WETH)).resolves.toBeNull();
    await expect(oracle.market(NATIVE_TOKEN)).resolves.toBeNull();
    expect(reader.calls).toEqual([]);
  });

  it("throws from market() when the endpoint fails, while priceRatio has no opinion", async () => {
    const broken = {
      multicall: async (): Promise<string[]> => {
        throw new TypeError("fetch failed");
      },
    };
    const oracle = new UniswapV3TwapOracle(broken);
    await expect(oracle.market(SPX)).rejects.toThrow("fetch failed");
    await expect(oracle.priceRatio(WETH, SPX)).resolves.toBeNull();
  });
});

describe("UniswapV3TwapOracle and native ether", () => {
  // A scripted chain with one healthy WETH/SPX market, so the only thing under
  // test is which addresses the oracle asks about. The fork suite checks the
  // numbers against real pools; this checks the question.
  const getPoolQueries = (reader: ScriptedUniswap) =>
    reader.calls.filter((c) => c.data.startsWith("0x1698ee82")).map((c) => c.data);

  it("prices ether exactly as it prices WETH", async () => {
    // The bug this pins: asked about 0xeeee…eeee, the factory has no pool, so
    // every ether sale went without its price check while the same trade in
    // WETH had one.
    const oracle = new UniswapV3TwapOracle(spxMarket());
    const asWeth = await oracle.priceRatio(WETH, SPX);
    expect(asWeth).not.toBeNull();
    expect(asWeth).toBe(priceX18AtTick(SPX_TICK));
    await expect(oracle.priceRatio(NATIVE_TOKEN, SPX)).resolves.toBe(asWeth);
    // And the other way round, which inverts rather than repeats.
    await expect(oracle.priceRatio(SPX, NATIVE_TOKEN)).resolves.toBe(await oracle.priceRatio(SPX, WETH));
  });

  it("asks the factory about WETH, never the native marker", async () => {
    const reader = spxMarket();
    await new UniswapV3TwapOracle(reader).priceRatio(NATIVE_TOKEN, SPX);
    const queries = getPoolQueries(reader);
    expect(queries.length).toBeGreaterThan(0);
    for (const data of queries) {
      expect(data).not.toContain(NATIVE_TOKEN.slice(2));
      expect(data).toContain(WETH.slice(2));
    }
  });

  it("recognises the marker whatever its case", async () => {
    // Checksummed, the marker is mixed case; a lowercase comparison alone
    // would miss it and quietly bring the bug back.
    const oracle = new UniswapV3TwapOracle(spxMarket());
    const mixed = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
    await expect(oracle.priceRatio(mixed, SPX)).resolves.toBe(await oracle.priceRatio(WETH, SPX));
  });

  it("has no opinion on ether against WETH, and spends no call finding that out", async () => {
    // Wrapping is 1:1 by contract. There is no market between a token and its
    // own wrapper, so there is no price to be wrong about.
    const reader = spxMarket();
    const oracle = new UniswapV3TwapOracle(reader);
    await expect(oracle.priceRatio(NATIVE_TOKEN, WETH)).resolves.toBeNull();
    await expect(oracle.priceRatio(WETH, NATIVE_TOKEN)).resolves.toBeNull();
    expect(reader.calls).toEqual([]);
  });

  it("uses the configured wrapped token when one is given", async () => {
    // Another chain wraps ether at another address; the factory option already
    // allows for that, and this is the other half of it.
    const reader = spxMarket();
    const elsewhere = "0x4200000000000000000000000000000000000006" as Address;
    await new UniswapV3TwapOracle(reader, { wrappedNative: elsewhere }).priceRatio(NATIVE_TOKEN, SPX);
    for (const data of getPoolQueries(reader)) {
      expect(data).toContain(elsewhere.slice(2));
      expect(data).not.toContain(WETH.slice(2));
    }
  });
});
