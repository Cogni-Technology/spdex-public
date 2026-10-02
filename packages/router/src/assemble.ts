/**
 * Turning a venue's flat quote list into per-pool curves.
 *
 * `quoteBatch` returns one entry per (requested amount, pool) pair, flattened,
 * with failures simply absent — a pool that cannot trade a given size produces
 * no quote rather than a zero. The router needs the opposite shape: one
 * ascending curve per pool.
 *
 * Kept here rather than in the app because getting it wrong is quiet. Group by
 * the wrong key, or leave the curve unsorted, and every grid lookup misses;
 * the router then reports "no route" for a pair with perfectly good liquidity,
 * and nothing anywhere throws.
 */

import type { WireVenueQuote } from "@spdex/core";
import type { RouteCandidate } from "./route.js";

export interface PoolDescriptor {
  poolId: string;
  venueId: string;
  label?: string;
}

export function candidatesFromQuotes(
  quotes: readonly WireVenueQuote[],
  pools: readonly PoolDescriptor[],
): RouteCandidate[] {
  const byPool = new Map<string, PoolDescriptor>();
  for (const pool of pools) byPool.set(pool.poolId.toLowerCase(), pool);

  const grouped = new Map<string, Map<string, { amountIn: bigint; amountOut: bigint; gasEstimate: bigint }>>();

  for (const quote of quotes) {
    const key = quote.poolId.toLowerCase();
    // A quote for a pool the caller did not offer is discarded rather than
    // trusted: the candidate set is the user's pool policy made concrete, and
    // a venue must not be able to widen it by naming an extra pool.
    if (!byPool.has(key)) continue;

    let curve = grouped.get(key);
    if (!curve) {
      curve = new Map();
      grouped.set(key, curve);
    }

    const amountIn = BigInt(quote.amountIn);
    const existing = curve.get(quote.amountIn);
    const candidate = {
      amountIn,
      amountOut: BigInt(quote.amountOut),
      gasEstimate: BigInt(quote.gasEstimate),
    };
    // Duplicates at the same size keep the better one; a venue quoting twice is
    // odd but not a reason to fail a swap.
    if (!existing || candidate.amountOut > existing.amountOut) {
      curve.set(quote.amountIn, candidate);
    }
  }

  const candidates: RouteCandidate[] = [];
  for (const [poolId, curve] of grouped) {
    const pool = byPool.get(poolId)!;
    candidates.push({
      venueId: pool.venueId,
      poolId: pool.poolId,
      ...(pool.label === undefined ? {} : { label: pool.label }),
      quotes: [...curve.values()].sort((a, b) => (a.amountIn < b.amountIn ? -1 : 1)),
    });
  }
  return candidates;
}
