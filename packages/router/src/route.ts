/**
 * Split routing.
 *
 * Deliberately host-side rather than a module: routing decides where the
 * user's money actually goes, so it stays in the trusted core where it can be
 * audited once, rather than being something each venue gets to influence.
 *
 * ## The algorithm
 *
 * Greedy marginal allocation. Divide the input into `chunkCount` equal pieces,
 * then hand out one piece at a time to whichever pool offers the most
 * additional output for it. AMM curves have diminishing returns, so the
 * marginal value of another piece falls as a pool fills up, and greedy
 * allocation on a concave curve is optimal for this grid.
 *
 * ## Why gas is priced into the marginal, not bolted on afterwards
 *
 * Splitting *always* increases gross output — that is what diminishing returns
 * guarantee — so an optimiser that maximises output alone will always split,
 * and will cheerfully add a third leg to win a few basis points while spending
 * more than that on gas. Here, opening a new leg has its gas charged against
 * its own marginal gain, so a leg has to pay for itself at the moment it is
 * considered. The finished split is then compared against the best single-pool
 * route net of gas, and only wins if it clears `minSplitGainBps`.
 *
 * ## Conservative by construction
 *
 * Chunk boundaries rarely divide an input exactly. The remainder — always less
 * than `chunkCount` base units — is added to the largest leg, while that leg's
 * output is still counted at its quoted amount. The plan therefore slightly
 * *under*-states what the user receives. That direction is deliberate: the
 * host derives minimum-out from this plan, and a plan that promised marginally
 * too much would produce avoidable reverts.
 */

import type { GasModel } from "./gas.js";

export interface CandidateQuote {
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
}

export interface RouteCandidate {
  venueId: string;
  poolId: string;
  label?: string;
  /** Quotes at the chunk grid. Gaps are treated as "cannot trade this size". */
  quotes: readonly CandidateQuote[];
}

export interface RoutePlanInput {
  amountIn: bigint;
  candidates: readonly RouteCandidate[];
  /** Granularity of the split. More chunks means finer routes and more quoting. */
  chunkCount: number;
  /** Ceiling on legs, so gas cannot be spent chasing dust. */
  maxSplits: number;
  /** A split must beat the best single pool by this much, net of gas. */
  minSplitGainBps: number;
  gas: GasModel;
}

export interface RouteLeg {
  venueId: string;
  poolId: string;
  label?: string;
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
  /** Share of the total input, in basis points. */
  shareBps: number;
}

export interface RouteRationale {
  consideredPools: number;
  chunkCount: number;
  /** The best single-pool route, always computed, for comparison. */
  bestSingle: { poolId: string; amountOut: bigint; netAmountOut: bigint } | null;
  /** Present when a split was computed and then rejected as not worth its gas. */
  rejectedSplit?: { legs: number; gainBps: number; requiredBps: number };
}

export interface RoutePlan {
  legs: RouteLeg[];
  amountIn: bigint;
  /** Sum of leg outputs, before gas. */
  amountOut: bigint;
  gasEstimate: bigint;
  /** amountOut less gas priced in tokenOut — what routes are ranked by. */
  netAmountOut: bigint;
  rationale: RouteRationale;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * The cumulative amounts a venue must be quoted at.
 *
 * Exported because the host needs the same grid to build its `quoteBatch`
 * request; a mismatch would leave every lookup missing and silently produce
 * an empty route.
 */
export function chunkGrid(amountIn: bigint, chunkCount: number): bigint[] {
  if (amountIn <= 0n) return [];
  const chunks = BigInt(Math.max(1, Math.trunc(chunkCount)));
  const base = amountIn / chunks;
  // Inputs smaller than the chunk count cannot be divided; quote the whole.
  if (base === 0n) return [amountIn];
  const grid: bigint[] = [];
  for (let i = 1n; i <= chunks; i++) grid.push(base * i);
  return grid;
}

interface Indexed {
  candidate: RouteCandidate;
  /** amountIn (decimal string) -> quote */
  byAmount: Map<string, CandidateQuote>;
}

function index(candidates: readonly RouteCandidate[]): Indexed[] {
  return candidates.map((candidate) => ({
    candidate,
    byAmount: new Map(candidate.quotes.map((q) => [q.amountIn.toString(), q])),
  }));
}

function quoteAt(pool: Indexed, amount: bigint): CandidateQuote | null {
  return pool.byAmount.get(amount.toString()) ?? null;
}

export function planRoute(input: RoutePlanInput): RoutePlan {
  const { amountIn, chunkCount, maxSplits, minSplitGainBps, gas } = input;

  if (amountIn <= 0n) throw new RoutingError("amountIn must be positive");
  if (maxSplits < 1) throw new RoutingError("maxSplits must be at least 1");

  const grid = chunkGrid(amountIn, chunkCount);
  const chunks = grid.length;
  const pools = index(input.candidates);

  const emptyRationale = (): RouteRationale => ({
    consideredPools: pools.length,
    chunkCount: chunks,
    bestSingle: null,
  });

  if (pools.length === 0 || chunks === 0) {
    return {
      legs: [],
      amountIn,
      amountOut: 0n,
      gasEstimate: 0n,
      netAmountOut: 0n,
      rationale: emptyRationale(),
    };
  }

  // ── Best single-pool route, always computed ──
  // It is both a fallback and the yardstick a split has to beat.
  const fullAmount = grid[chunks - 1]!;
  let bestSingle: { pool: Indexed; quote: CandidateQuote; net: bigint } | null = null;
  for (const pool of pools) {
    const quote = quoteAt(pool, fullAmount);
    if (!quote || quote.amountOut <= 0n) continue;
    const net = quote.amountOut - gas.costInTokenOut(quote.gasEstimate);
    if (!bestSingle || net > bestSingle.net) bestSingle = { pool, quote, net };
  }

  // ── Greedy marginal allocation ──
  const allocation = new Map<number, number>(); // pool index -> chunks held
  for (let chunk = 0; chunk < chunks; chunk++) {
    let bestIndex = -1;
    let bestMarginal = 0n;

    for (const [i, pool] of pools.entries()) {
      const held = allocation.get(i) ?? 0;
      const next = quoteAt(pool, grid[held]!);
      if (!next || next.amountOut <= 0n) continue;

      const current = held === 0 ? 0n : (quoteAt(pool, grid[held - 1]!)?.amountOut ?? 0n);
      let marginal = next.amountOut - current;
      // A pool whose output falls as its input grows is misquoting; ignore it
      // rather than letting a negative marginal distort the allocation.
      if (marginal <= 0n) continue;

      if (held === 0) {
        if (allocation.size >= maxSplits) continue;
        // Gas is charged only against *optional* legs. The first leg is not
        // optional — you cannot trade without one — so pricing it the same way
        // made every pool unprofitable under expensive gas and produced a route
        // with no legs at all. Beyond the first, a leg pays for its own gas out
        // of the gain that justified opening it.
        if (allocation.size > 0) {
          marginal -= gas.costInTokenOut(next.gasEstimate);
          if (marginal <= 0n) continue;
        }
      }

      if (marginal > bestMarginal) {
        bestMarginal = marginal;
        bestIndex = i;
      }
    }

    // No pool can absorb another chunk profitably; stop rather than force it.
    if (bestIndex === -1) break;
    allocation.set(bestIndex, (allocation.get(bestIndex) ?? 0) + 1);
  }

  const buildPlan = (
    entries: [number, number][],
    rationale: RouteRationale,
  ): RoutePlan => {
    const legs: RouteLeg[] = [];
    let gross = 0n;
    let gasUnits = 0n;
    let allocated = 0n;

    for (const [poolIndex, held] of entries) {
      if (held <= 0) continue;
      const pool = pools[poolIndex]!;
      const quote = quoteAt(pool, grid[held - 1]!);
      if (!quote) continue;
      legs.push({
        venueId: pool.candidate.venueId,
        poolId: pool.candidate.poolId,
        ...(pool.candidate.label === undefined ? {} : { label: pool.candidate.label }),
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        gasEstimate: quote.gasEstimate,
        shareBps: 0,
      });
      gross += quote.amountOut;
      gasUnits += quote.gasEstimate;
      allocated += quote.amountIn;
    }

    if (legs.length === 0) {
      return {
        legs: [],
        amountIn,
        amountOut: 0n,
        gasEstimate: 0n,
        netAmountOut: 0n,
        rationale,
      };
    }

    // Chunk boundaries rarely divide the input exactly. Give the dust to the
    // largest leg without crediting extra output for it — the plan then
    // slightly under-promises, which is the safe direction.
    const dust = amountIn - allocated;
    if (dust > 0n) {
      let largest = 0;
      for (let i = 1; i < legs.length; i++) {
        if (legs[i]!.amountIn > legs[largest]!.amountIn) largest = i;
      }
      legs[largest]!.amountIn += dust;
    }

    for (const leg of legs) {
      leg.shareBps = Number((leg.amountIn * 10_000n) / amountIn);
    }

    return {
      legs,
      amountIn,
      amountOut: gross,
      gasEstimate: gasUnits,
      netAmountOut: gross - gas.costInTokenOut(gasUnits),
      rationale,
    };
  };

  const singlePlanEntries = (): [number, number][] =>
    bestSingle ? [[pools.indexOf(bestSingle.pool), chunks]] : [];

  const rationale: RouteRationale = {
    consideredPools: pools.length,
    chunkCount: chunks,
    bestSingle: bestSingle
      ? {
          poolId: bestSingle.pool.candidate.poolId,
          amountOut: bestSingle.quote.amountOut,
          netAmountOut: bestSingle.net,
        }
      : null,
  };

  const split = buildPlan([...allocation.entries()], rationale);

  // Belt and braces: if allocation produced nothing but some pool could quote
  // the full amount, trade through it rather than returning an empty route.
  if (split.legs.length === 0 && bestSingle) {
    return buildPlan(singlePlanEntries(), rationale);
  }

  // A single-leg result needs no comparison — it either is the best single
  // pool, or the only pool that could quote at all.
  if (split.legs.length <= 1) {
    if (split.legs.length === 1 && bestSingle && split.netAmountOut < bestSingle.net) {
      return buildPlan(singlePlanEntries(), rationale);
    }
    return split;
  }

  if (!bestSingle) return split;

  // Final check: the split must clear the configured margin over the best
  // single pool, net of gas. Without it, a route gains a leg for a rounding
  // error's worth of output.
  const gain = split.netAmountOut - bestSingle.net;
  const gainBps =
    bestSingle.net > 0n ? Number((gain * 10_000n) / bestSingle.net) : gain > 0n ? 10_000 : 0;

  if (gainBps < minSplitGainBps) {
    return buildPlan(singlePlanEntries(), {
      ...rationale,
      rejectedSplit: {
        legs: split.legs.length,
        gainBps,
        requiredBps: minSplitGainBps,
      },
    });
  }

  return split;
}
