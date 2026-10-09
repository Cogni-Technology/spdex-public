/**
 * Volume, from the only place it exists: the logs.
 *
 * ## Why this is not a module
 *
 * Everything else about a pool — balances, fee, tokens — a tracker module can
 * read through `ctx.multicall`. Volume cannot, because it needs `eth_getLogs`,
 * and that is deliberately not a capability the broker offers. A log filter is
 * a much larger surface than a batched `eth_call`: unbounded block ranges,
 * arbitrary addresses, arbitrary topics, and an easy way to make a user's
 * endpoint do expensive work on a stranger's behalf. Widening the broker to
 * satisfy a display statistic would be a bad trade.
 *
 * So the host reads it and attaches it afterwards. That also keeps the tracker
 * a pure function of its inputs at a given block, which is what the
 * conformance suite requires and what makes the parity gate mean anything.
 *
 * ## Fail-open, loudly
 *
 * Plenty of endpoints refuse wide ranges, and some refuse `eth_getLogs`
 * outright. Volume is a number on a screen, not an input to a signature, so
 * failure returns a *reason* rather than throwing — and the UI prints the
 * reason rather than a zero. A zero that means "your endpoint said no" and a
 * zero that means "nobody traded" are different facts, and only one of them is
 * a reason to avoid a pool.
 */

import { TOPICS } from "./constants.js";
import type { Address } from "@spdex/core";
import type { JsonRpc } from "./reader.js";

export interface PoolVolume {
  poolId: Address;
  /** Absolute token0 moved over the window, raw units. In plus out. */
  volume0: bigint;
  volume1: bigint;
  swaps: number;
}

export interface VolumeWindow {
  fromBlock: bigint;
  toBlock: bigint;
  /** Blocks actually covered, which may be far fewer than asked for. */
  blocks: number;
  byPool: Map<string, PoolVolume>;
  /** Set when volume could not be read at all. One short, actionable line. */
  note?: string;
}

/** Roughly 24 hours at 12s blocks. */
export const DEFAULT_VOLUME_BLOCKS = 7200;

/**
 * What to retry with when an endpoint refuses the full window.
 *
 * Hosted endpoints cap `eth_getLogs` aggressively — Alchemy's free tier allows
 * ten blocks — and a capped window is still a real measurement as long as
 * nobody is told it covers a day when it covers two minutes. So the reader
 * steps down and reports the window it actually got, and the UI labels the
 * column with it.
 */
const FALLBACK_WINDOWS = [1000, 100, 10];

/**
 * Turn a provider's error into one line a user can act on.
 *
 * These arrive as nested JSON wrapped in transport errors wrapped in fork
 * errors, several hundred characters of it, and pasting that into a panel is
 * not honesty — it is an unwillingness to decide what matters.
 */
export function summariseLogError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // A rate limit or a used-up allowance first: Alchemy's monthly cap reads
  // "limit exceeded" too, and it is no block-range limit. Said plainly: the
  // service's own words are addressed to whoever holds its key.
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (status === 429 || code === 429 || /exceeded its compute units|Monthly capacity limit exceeded|\brate.?limit|too many requests|HTTP 429/i.test(raw)) {
    return "the network service is turning requests away for now";
  }
  if (/block range|range should work|query returned more than|too many results|limit exceeded/i.test(raw)) {
    return "this endpoint limits how many blocks of logs it will serve at once";
  }
  if (/method .*not (supported|found)|does not exist/i.test(raw)) {
    return "this endpoint does not support eth_getLogs";
  }
  if (/timeout|timed out/i.test(raw)) return "the log query timed out";
  // No answer: the browser's own words for a request that got none (Chrome's,
  // Firefox's, Safari's), which is also how a refusal without CORS headers
  // reads, or a gateway's error page in place of a JSON-RPC answer.
  if (/Failed to fetch|NetworkError|Load failed|^(?:[a-z][a-z0-9]*_[A-Za-z0-9_]+:\s*)?HTTP 5\d\d\b/i.test(raw)) {
    return "the network service didn't answer";
  }
  // Unrecognised: keep it, but keep it short, and without the "eth_getLogs: "
  // the transport puts in front.
  const said = raw.replace(/^[a-z][a-z0-9]*_[A-Za-z0-9_]+:\s*/, "");
  return said.length > 120 ? `${said.slice(0, 120)}…` : said;
}

const word = (body: string, index: number): bigint => {
  const start = index * 64;
  const slice = body.slice(start, start + 64);
  return slice.length === 64 ? BigInt(`0x${slice}`) : 0n;
};

/** Read a 32-byte word as two's-complement signed, then take its magnitude. */
const magnitude = (raw: bigint): bigint => {
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  return signed < 0n ? -signed : signed;
};

interface RawLog {
  address?: string;
  topics?: string[];
  data?: string;
}

/**
 * Decode one Swap log into the absolute amounts it moved.
 *
 * Returns null for anything unrecognised rather than guessing. An
 * unknown-but-similar event decoded as if it were a Swap would inflate a
 * number the user is comparing pools with.
 */
export function decodeSwapAmounts(log: RawLog): { amount0: bigint; amount1: bigint } | null {
  const topic0 = log.topics?.[0]?.toLowerCase();
  const body = (log.data ?? "0x").replace(/^0x/, "");

  if (topic0 === TOPICS.uniV2Swap.toLowerCase()) {
    // amount0In, amount1In, amount0Out, amount1Out — all unsigned. A swap
    // touches one side in and the other out, so summing both per token is the
    // same as taking the magnitude, and is correct for the odd pair that does
    // both.
    if (body.length < 256) return null;
    return {
      amount0: word(body, 0) + word(body, 2),
      amount1: word(body, 1) + word(body, 3),
    };
  }

  if (topic0 === TOPICS.uniV3Swap.toLowerCase()) {
    // amount0, amount1 signed — negative means leaving the pool. One of the
    // two is always negative, so magnitudes are what a volume figure wants.
    if (body.length < 128) return null;
    return {
      amount0: magnitude(word(body, 0)),
      amount1: magnitude(word(body, 1)),
    };
  }

  return null;
}

/**
 * Sum Swap volume across a set of pools in one request.
 *
 * One `eth_getLogs` for every pool rather than one each: an address array and
 * a topic alternation cover both venues at once, which turns "six pools" from
 * six round trips into one, and is the difference between a statistic that
 * appears with the route and one that arrives after the user has moved on.
 */
export class SwapLogVolumeReader {
  readonly #windowBlocks: number;

  constructor(
    private readonly rpc: JsonRpc,
    options: { windowBlocks?: number } = {},
  ) {
    this.#windowBlocks = options.windowBlocks ?? DEFAULT_VOLUME_BLOCKS;
  }

  async read(pools: readonly Address[]): Promise<VolumeWindow> {
    const empty = (note: string, from = 0n, to = 0n): VolumeWindow => ({
      fromBlock: from,
      toBlock: to,
      blocks: 0,
      byPool: new Map(),
      note,
    });

    if (pools.length === 0) {
      return { fromBlock: 0n, toBlock: 0n, blocks: 0, byPool: new Map() };
    }

    let head: bigint;
    try {
      head = BigInt((await this.rpc("eth_blockNumber", [])) as string);
    } catch {
      return empty("the endpoint did not report a block height");
    }

    // Ask for the full window, then step down. Stopping at the first refusal
    // would report "unavailable" on endpoints that are perfectly willing to
    // answer a narrower question.
    const attempts = [this.#windowBlocks, ...FALLBACK_WINDOWS.filter((w) => w < this.#windowBlocks)];

    let logs: RawLog[] | null = null;
    let from = head;
    let used = 0;
    let lastError: unknown;

    for (const window of attempts) {
      from = head > BigInt(window) ? head - BigInt(window) : 0n;
      try {
        logs = (await this.rpc("eth_getLogs", [
          {
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${head.toString(16)}`,
            address: pools.map((p) => p.toLowerCase()),
            // A nested array is an alternation: "topic0 is either of these".
            topics: [[TOPICS.uniV2Swap, TOPICS.uniV3Swap]],
          },
        ])) as RawLog[];
        used = window;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (logs === null) return empty(summariseLogError(lastError), from, head);

    const byPool = new Map<string, PoolVolume>();
    for (const log of logs ?? []) {
      const address = log.address?.toLowerCase();
      if (!address) continue;
      const amounts = decodeSwapAmounts(log);
      if (!amounts) continue;

      const existing = byPool.get(address);
      if (existing) {
        existing.volume0 += amounts.amount0;
        existing.volume1 += amounts.amount1;
        existing.swaps += 1;
      } else {
        byPool.set(address, {
          poolId: address as Address,
          volume0: amounts.amount0,
          volume1: amounts.amount1,
          swaps: 1,
        });
      }
    }

    return { fromBlock: from, toBlock: head, blocks: used, byPool };
  }
}
