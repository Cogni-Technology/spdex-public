/**
 * Turning a tracker's raw balances into something worth reading.
 *
 * Three sources meet here, and they are separate on purpose:
 *
 *   - the **tracker module** reports balances, untrusted and sandboxed;
 *   - the **host** reads volume from logs, because `eth_getLogs` is not a
 *     capability any module gets;
 *   - the **oracle** prices it, reusing the same time-weighted feed the Guard
 *     cross-checks swaps against rather than inventing a second one.
 *
 * Nothing here is in the path of a signature. A tracker that lies costs the
 * user a bad decision, not a bad transaction — which is why it is allowed to
 * be wrong in ways a venue is not, and why every number below degrades to
 * "unknown" rather than to zero.
 */

import { TOKENS, type PoolVolume } from "@spdex/chain";
import type { Address, WirePoolStats } from "@spdex/core";
import { usdShown, type MoneyView } from "./money/convert.js";
import { formatFiat, formatNumber } from "./money/format.js";

/** USDC is the unit of account here; it has six decimals. */
export const USD_DECIMALS = 6;
const WAD = 10n ** 18n;

export interface PricedPool {
  poolId: string;
  supported: boolean;
  token0: string;
  token1: string;
  /** Hundredths of a bip, as the venue reported it. */
  fee: number;
  balance0: bigint;
  balance1: bigint;
  /**
   * Total value locked, in USDC base units, or null when it could not be
   * priced. Null is not zero: an unpriced pool is unknown, and showing "$0"
   * for one would rank it below a genuinely empty one.
   */
  tvlUsd: bigint | null;
  /** Volume over the window, in USDC base units, or null if unavailable. */
  volumeUsd: bigint | null;
  swaps: number | null;
  /** Share of this pair's total priced TVL, in basis points. */
  shareBps: number | null;
}

/**
 * How much one raw unit of a token is worth in raw USDC, scaled by 1e18.
 *
 * The same convention the Guard's oracle uses, deliberately: raw on both sides
 * with no decimal correction, so the two never need reconciling. USDC against
 * itself is the identity, which no oracle will answer — a pair of the same
 * token is not a market.
 */
export type UsdRates = Map<string, bigint>;

export async function loadUsdRates(
  tokens: readonly string[],
  priceRatio: (a: Address, b: Address) => Promise<bigint | null>,
): Promise<UsdRates> {
  const usdc = TOKENS.USDC.address.toLowerCase();
  const rates: UsdRates = new Map([[usdc, WAD]]);

  await Promise.all(
    [...new Set(tokens.map((t) => t.toLowerCase()))]
      .filter((token) => token !== usdc)
      .map(async (token) => {
        try {
          const ratio = await priceRatio(token as Address, TOKENS.USDC.address);
          if (ratio !== null && ratio > 0n) rates.set(token, ratio);
        } catch {
          // Unpriced is a legitimate answer; see `tvlUsd`.
        }
      }),
  );

  return rates;
}

const valueIn = (amount: bigint, token: string, rates: UsdRates): bigint | null => {
  const rate = rates.get(token.toLowerCase());
  return rate === undefined ? null : (amount * rate) / WAD;
};

/**
 * Combine everything into one sorted, ranked list.
 *
 * Sorted by TVL descending, with unpriced and unsupported pools last: the
 * question a user is asking is "where is the liquidity", and a pool nobody can
 * price is not an answer to it.
 */
export function priceStats(options: {
  stats: readonly WirePoolStats[];
  volumes: ReadonlyMap<string, PoolVolume>;
  rates: UsdRates;
}): PricedPool[] {
  const priced: PricedPool[] = options.stats.map((stat) => {
    const balance0 = BigInt(stat.balance0);
    const balance1 = BigInt(stat.balance1);

    const side0 = stat.supported ? valueIn(balance0, stat.token0, options.rates) : null;
    const side1 = stat.supported ? valueIn(balance1, stat.token1, options.rates) : null;
    // Both sides or neither. Half a pool's value reported as its total would
    // be wrong by exactly the amount that matters, and silently so.
    const tvlUsd = side0 !== null && side1 !== null ? side0 + side1 : null;

    const volume = options.volumes.get(stat.poolId.toLowerCase());
    const volume0 = volume ? valueIn(volume.volume0, stat.token0, options.rates) : null;
    const volume1 = volume ? valueIn(volume.volume1, stat.token1, options.rates) : null;
    // One side, not both: a swap moves value across, and counting each end
    // would double every figure. Token0's side is used when it can be priced.
    const volumeUsd = volume0 ?? volume1;

    return {
      poolId: stat.poolId,
      supported: stat.supported,
      token0: stat.token0,
      token1: stat.token1,
      fee: stat.fee,
      balance0,
      balance1,
      tvlUsd,
      volumeUsd,
      swaps: volume?.swaps ?? null,
      shareBps: null,
    };
  });

  const total = priced.reduce((sum, pool) => sum + (pool.tvlUsd ?? 0n), 0n);
  if (total > 0n) {
    for (const pool of priced) {
      if (pool.tvlUsd !== null) {
        pool.shareBps = Number((pool.tvlUsd * 10_000n) / total);
      }
    }
  }

  return priced.sort((a, b) => {
    if (a.tvlUsd === null && b.tvlUsd === null) return 0;
    if (a.tvlUsd === null) return 1;
    if (b.tvlUsd === null) return -1;
    return a.tvlUsd === b.tvlUsd ? 0 : a.tvlUsd > b.tvlUsd ? -1 : 1;
  });
}

/**
 * A pool figure (dollar millionths, as `priceStats` gives them) in the page's
 * currency, compact from ten thousand up: "$12.26M", "€10.68M", "$12.35K".
 * Below that it is written out, "$1,637.42": compact there read as "$1.637K".
 * Dollars when there is no view, or when the view's currency has no rate
 * right now (`fallsBack` says so), and "unknown" for a figure that couldn't
 * be priced, never "$0".
 */
export function formatPoolMoney(usd: bigint | null, view: MoneyView | undefined): string {
  if (usd === null) return "unknown";
  const shown = usdShown(usd, view?.fx ?? null, view?.currency ?? "USD");
  const whole = shown.value.minor6 < 0n ? -shown.value.minor6 : shown.value.minor6;
  // A measured zero stays "$0", as compact writes it.
  return formatFiat(shown.value, view?.locale ?? "en-US", { compact: whole === 0n || whole >= COMPACT_FROM });
}

/** Ten thousand, in millionths: where pool figures start to be written compact. */
const COMPACT_FROM = 10_000n * 10n ** 6n;

/** A share in basis points to one decimal, in the page's number format: 9840 → "98.4%" ("98,4%" in German). */
export function shareText(bps: number): string {
  return `${formatNumber(bps / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** A fee tier as a percentage, in the page's number format: 3000 → "0.30%" ("0,30%" in German). */
export function formatFee(fee: number): string {
  return `${formatNumber(fee / 10_000, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
