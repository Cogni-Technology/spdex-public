/**
 * Pricing and ranking pool statistics.
 *
 * The cases here are the ones where a plausible-looking number would be wrong:
 * a pool priced on one side only, an unpriced pool sorted as if it were empty,
 * and volume counted at both ends of the same swap.
 */

import { describe, expect, it } from "vitest";
import type { WirePoolStats } from "@spdex/core";
import type { PoolVolume } from "@spdex/chain";
import { formatFee, formatPoolMoney, priceStats, type UsdRates } from "./stats.js";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";

const WAD = 10n ** 18n;

/**
 * Raw USDC per raw token, scaled 1e18 — the oracle's convention.
 * WETH (18dp) at $2,500: 2500 * 1e6 / 1e18 * 1e18 = 2500e6.
 * SPX (8dp) at $0.50:    0.5 * 1e6 / 1e8  * 1e18 = 5e15.
 */
const rates: UsdRates = new Map([
  [USDC, WAD],
  [WETH, 2_500n * 10n ** 6n],
  [SPX, 5n * 10n ** 15n],
]);

const stat = (over: Partial<WirePoolStats> = {}): WirePoolStats => ({
  poolId: "0xpool1",
  supported: true,
  token0: SPX,
  token1: WETH,
  balance0: "0",
  balance1: "0",
  fee: 3000,
  ...over,
});

describe("priceStats", () => {
  it("values both sides and sums them", () => {
    // 1,000,000 SPX ($500,000) + 200 WETH ($500,000) = $1,000,000.
    const [pool] = priceStats({
      stats: [stat({ balance0: (1_000_000n * 10n ** 8n).toString(), balance1: (200n * WAD).toString() })],
      volumes: new Map(),
      rates,
    });
    expect(pool!.tvlUsd).toBe(1_000_000n * 10n ** 6n);
    expect(formatPoolMoney(pool!.tvlUsd, undefined)).toBe("$1M");
  });

  it("reports unknown rather than half a pool when one side has no price", () => {
    // Half of a TVL figure is wrong by exactly the amount that matters, and it
    // looks entirely reasonable on screen.
    const [pool] = priceStats({
      stats: [stat({ token1: DAI, balance0: (1_000_000n * 10n ** 8n).toString(), balance1: "5" })],
      volumes: new Map(),
      rates,
    });
    expect(pool!.tvlUsd).toBeNull();
    expect(formatPoolMoney(pool!.tvlUsd, undefined)).toBe("unknown");
  });

  it("reports unknown for a pool the tracker could not read", () => {
    const [pool] = priceStats({
      stats: [stat({ supported: false, balance0: "0", balance1: "0" })],
      volumes: new Map(),
      rates,
    });
    expect(pool!.tvlUsd).toBeNull();
  });

  it("counts one side of a swap, not both", () => {
    // A swap moves value across; adding both ends doubles every figure.
    const volume: PoolVolume = {
      poolId: "0xpool1",
      volume0: 100_000n * 10n ** 8n, // 100,000 SPX = $50,000
      volume1: 20n * WAD, // 20 WETH = $50,000
      swaps: 7,
    };
    const [pool] = priceStats({
      stats: [stat()],
      volumes: new Map([["0xpool1", volume]]),
      rates,
    });
    expect(pool!.volumeUsd).toBe(50_000n * 10n ** 6n);
    expect(pool!.swaps).toBe(7);
  });

  it("ranks by TVL and puts unpriced pools last", () => {
    const ranked = priceStats({
      stats: [
        stat({ poolId: "0xsmall", balance0: "0", balance1: (1n * WAD).toString() }),
        stat({ poolId: "0xunknown", token1: DAI, balance1: "1" }),
        stat({ poolId: "0xbig", balance0: "0", balance1: (100n * WAD).toString() }),
      ],
      volumes: new Map(),
      rates,
    });
    expect(ranked.map((p) => p.poolId)).toEqual(["0xbig", "0xsmall", "0xunknown"]);
  });

  it("computes each pool's share of priced liquidity", () => {
    const ranked = priceStats({
      stats: [
        stat({ poolId: "0xa", balance0: "0", balance1: (75n * WAD).toString() }),
        stat({ poolId: "0xb", balance0: "0", balance1: (25n * WAD).toString() }),
      ],
      volumes: new Map(),
      rates,
    });
    expect(ranked[0]!.shareBps).toBe(7500);
    expect(ranked[1]!.shareBps).toBe(2500);
  });

  it("does not divide by zero when nothing can be priced", () => {
    const ranked = priceStats({
      stats: [stat({ token0: DAI, token1: DAI })],
      volumes: new Map(),
      rates,
    });
    expect(ranked[0]!.shareBps).toBeNull();
  });
});

describe("formatting", () => {
  it("abbreviates dollars for a table", () => {
    expect(formatPoolMoney(1_234_000_000n * 10n ** 6n, undefined)).toBe("$1.234B");
    expect(formatPoolMoney(2_500_000n * 10n ** 6n, undefined)).toBe("$2.5M");
    expect(formatPoolMoney(12_345n * 10n ** 6n, undefined)).toBe("$12.35K");
    expect(formatPoolMoney(10_000n * 10n ** 6n, undefined)).toBe("$10K");
    // Below ten thousand, written out: compact read as "$1.637K".
    expect(formatPoolMoney(1_637_420_000n, undefined)).toBe("$1,637.42");
    expect(formatPoolMoney(365_000_000n, undefined)).toBe("$365.00");
    expect(formatPoolMoney(0n, undefined)).toBe("$0");
    expect(formatPoolMoney(null, undefined)).toBe("unknown");
  });

  it("renders fee tiers as percentages", () => {
    expect(formatFee(100)).toBe("0.01%");
    expect(formatFee(500)).toBe("0.05%");
    expect(formatFee(3000)).toBe("0.30%");
    expect(formatFee(10_000)).toBe("1.00%");
  });
});

describe("formatPoolMoney", () => {
  const WETH_RATE = new Map([["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 1n]]);

  it("writes a pool figure compact, in dollars without a view", () => {
    expect(formatPoolMoney(12_261_904_170_000n, undefined)).toBe("$12.26M");
    expect(formatPoolMoney(null, undefined)).toBe("unknown");
  });

  it("writes it in the view's currency, and in dollars when that currency has no rate", () => {
    const fx = {
      block: 1n,
      chainTime: 10_000,
      rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: 9_000 } },
      usdc: null,
    };
    expect(formatPoolMoney(1_148_100_000_000n, { usd: WETH_RATE, fx, currency: "EUR", locale: "en-US" })).toBe("€1M");
    expect(formatPoolMoney(1_000_000_000_000n, { usd: WETH_RATE, fx, currency: "GBP", locale: "en-US" })).toBe("$1M");
  });
});
