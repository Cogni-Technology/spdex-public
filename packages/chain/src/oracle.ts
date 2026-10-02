/**
 * The Guard's independent price check.
 *
 * Layers one and two of the Guard both reason about the transaction in front
 * of them: what it references, and what it would do. Neither can answer the
 * question "is this price sane?", because a swap that moves a manipulated pool
 * simulates perfectly — the user really does receive the amount they were
 * promised, and that amount really is terrible. Catching that needs a second
 * opinion from somewhere the transaction cannot reach.
 *
 * ## Why a TWAP, and not spot
 *
 * Reading the current price of the pool being traded is not a second opinion —
 * it is the same opinion, from the same place, and an attacker who moved the
 * pool has moved both numbers together. A time-weighted average over a window
 * has to be held off-market for the whole window to be shifted, which costs
 * real money for every block of it. That is the property being bought here.
 *
 * ## Why not a price feed
 *
 * Chainlink and friends would be less code. They would also mean a swap
 * interface that refuses to work for any pair somebody else decided to
 * publish, a second trusted party with an upgradeable contract, and — for the
 * hosted variety — an HTTP call to a server that learns what the user is about
 * to trade. This reads Uniswap's own accumulator through the endpoint the user
 * already chose. No key, no account, no third party, nothing new to trust.
 *
 * ## Which pool
 *
 * An average is only as hard to move as the pool it is read from, so the
 * choice of pool is what an attacker goes after. The rule this replaces — the
 * most liquidity in range right now, among pools whose `observe` answers right
 * now — could be met by one narrow position for one block. And a pool nobody
 * has traded in for ten minutes answers `observe` with its current tick:
 * whatever price its last trade left, presented as an average.
 *
 * Every price is now read from markets against WETH (see "Through WETH"
 * below), and a pool is read only if it passes the tests the vault's factory
 * makes of its oracle pool (`packages/vault`):
 *
 * 1. **History.** It keeps at least `TWAP_MIN_OBSERVATIONS`. Uniswap writes at
 *    most one observation a block, so on mainnet no run of trades can push the
 *    start of the window out of reach of a pool that keeps that many. A pool
 *    that keeps a handful can be knocked out of the running by a few trades,
 *    which hands the choice to whichever pool is left. This is not a defence
 *    against a determined attacker: anyone can pay to grow a pool's history,
 *    about 2M gas for 100 observations.
 * 2. **Depth across the window.** Its harmonic-mean in-range liquidity over the
 *    window, as a virtual WETH reserve, is at least `TWAP_MIN_DEPTH`. Uniswap
 *    accumulates seconds per unit of liquidity, so any stretch the price spent
 *    where nobody provides liquidity drags the mean towards zero. A position
 *    counts only if it was there for the whole window, not just for the block
 *    in which the choice is made. The same figure ranks the pools that pass:
 *    the deepest over the window wins. How deep a pool is *right now* is no
 *    longer read at all.
 * 3. **Agreement.** Its average is within `TWAP_AGREEMENT_BPS` of the mid price
 *    of Uniswap v2's pair for the same two tokens, when that pair holds at
 *    least the depth floor in WETH. A thinner pair can be moved to vouch for
 *    anything.
 *
 * The third test is a preference here, not a veto, and that is the one place
 * this departs from the vault. Tests one and two can be passed at a price of
 * someone's choosing. Depth measured at one price is what a narrow position
 * buys cheaply: in a pool whose ticks are 0.1% apart, the tokens behind the
 * floor's worth of virtual depth are worth about 0.005 ETH, and out-depthing
 * SPX's own pool takes about 0.03 ETH. Held a few percent off the market, a
 * position that size offers an arbitrageur about a thousandth of an ether.
 * That is not always worth a transaction, and when it is, the position is
 * cheap to put back. Only an independent market limits how far off that price
 * can be. So while any pool that passes agrees with the pair, only the pools
 * that agree are considered.
 *
 * As a veto, agreement would do harm. The vault can afford one: its factory
 * tests agreement once, when a market is listed, and every buy afterwards
 * reads that fixed pool and checks only its depth again (a pool's history
 * never shrinks). This check runs in front of every swap, and for SPX the v2
 * pair is the market being traded.
 * Requiring agreement here would switch the check off whenever that pair is
 * pushed more than 2% from the pools, and the bigger the push, the surer the
 * silence. That is backwards for a check whose job is to notice a pushed
 * market. So when no pool that passes agrees, the deepest one answers anyway.
 * Either the pair has moved, and the check should say so, or the pools have,
 * and depth across the window is all that is left to go on.
 *
 * The limits. Someone can hold a narrow position for the whole window that is
 * deeper than the genuine pool and within 2% of the pair's price. That shifts
 * the reference by up to 2%. If they also hold the pair itself off-market
 * across a block boundary, where arbitrage takes a share of its depth every
 * block, they can make the reference agree with the pushed pair. Either one
 * buys a missing or an unwarranted warning. Neither buys a signature, because
 * this layer cannot refuse anything.
 *
 * ## Through WETH
 *
 * Depth has to be stated in some unit, and WETH is the side almost every deep
 * Uniswap market has. So each leg is a token against WETH, and a pair of two
 * other tokens is priced through WETH. The two legs' mean ticks add, as in
 * Uniswap's `OracleLibrary.getChainedPrice`, so nothing is rounded between
 * them. There is one hub rather than a search, because every extra route is
 * another set of pools to choose among. A token whose only market is against
 * something other than WETH gets no opinion.
 *
 * This also prices SPX in dollars for display. The old rule took that price
 * from SPX's 1% USDC pool. At the pinned block that pool keeps one
 * observation, so its "average" was simply the price its last trade left,
 * however long ago.
 *
 * ## Fail-open, on purpose
 *
 * `priceRatio` returns null rather than throwing. The Guard treats a null
 * ratio as "no opinion" and an opinion as a *warning*, never a violation —
 * so a pool with no usable history, an endpoint that drops the call, or a pair
 * with no v3 market cannot block a swap. That asymmetry is deliberate: this
 * layer exists to catch a price that is obviously wrong, and an oracle that
 * can refuse transactions is an oracle that can be attacked into refusing them.
 */

import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, TOKENS, UNI_V3_FEE_TIERS, isNativeToken } from "./constants.js";
import type { Multicall3Reader } from "./reader.js";

/** `getPool(address,address,uint24)` on the v3 factory. */
const SELECTOR_GET_POOL = "0x1698ee82";
/** `slot0()` on a v3 pool: price, tick, and how many observations it keeps. */
const SELECTOR_SLOT0 = "0x3850c7bd";
/** `observe(uint32[])` on a v3 pool. */
const SELECTOR_OBSERVE = "0x883bdbfd";
/** `getPair(address,address)` on the v2 factory. */
const SELECTOR_GET_PAIR = "0xe6a43905";
/** `getReserves()` on a v2 pair. */
const SELECTOR_GET_RESERVES = "0x0902f1ac";

/**
 * The least history a pool must keep, in observations: the vault's
 * `MIN_OBSERVATIONS`. On mainnet's 12-second slots ten minutes is at most 50
 * blocks, so 51 always reach back far enough; 100 leaves room for blocks that
 * come closer together than that, as a local fork's can. It is not enough for
 * a chain with two-second blocks, which would need its own figure.
 */
export const TWAP_MIN_OBSERVATIONS = 100;

/**
 * The least depth a pool must have behind its price across the whole window,
 * in wei of WETH: its harmonic-mean in-range liquidity as a virtual WETH
 * reserve. The vault's `MIN_ORACLE_DEPTH`, so the app's two price references
 * refuse the same pools. SPX's 0.3% pool has about 60 WETH.
 */
export const TWAP_MIN_DEPTH = 10n * 10n ** 18n;

/**
 * How far a pool's average may be from the v2 pair's mid price and still
 * agree with it, in basis points — the same figure as the vault factory's
 * `MAX_MARKET_GAP_BPS` (`FACTORY_LIMITS` in `packages/vault`).
 * The two venues' fees alone can keep them up to 1.3% apart while arbitrage is
 * idle, and a ten-minute average lags a moving market.
 */
export const TWAP_AGREEMENT_BPS = 200;

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const WAD = 10n ** 18n;
const UINT160_MAX = (1n << 160n) - 1n;

const encAddress = (address: string) => address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const encUint = (value: number | bigint) => value.toString(16).padStart(64, "0");

/** Read a 32-byte word as an unsigned integer. */
function wordAt(data: string, index: number): bigint | null {
  const body = data.replace(/^0x/, "");
  const start = index * 64;
  if (body.length < start + 64) return null;
  return BigInt(`0x${body.slice(start, start + 64)}`);
}

/** Read a 32-byte word as a two's-complement signed integer. */
function signedWordAt(data: string, index: number): bigint | null {
  const raw = wordAt(data, index);
  if (raw === null) return null;
  return raw >= 1n << 255n ? raw - (1n << 256n) : raw;
}

/** An address returned in the first word, or null for none (a zero word, or no answer). */
function addressAt(data: string | undefined): Address | null {
  const word = wordAt(data ?? "0x", 0);
  if (word === null || word === 0n || word >= 1n << 160n) return null;
  return `0x${word.toString(16).padStart(40, "0")}` as Address;
}

/**
 * Uniswap's TickMath.getSqrtRatioAtTick, transcribed.
 *
 * Returns sqrt(token1/token0) as a Q64.96 fixed-point number. The magic
 * constants are successive powers of sqrt(1.0001) in Q128.128 and are copied
 * from the v3 core library rather than recomputed — they are consensus
 * constants, and a "cleaner" derivation that rounds differently would disagree
 * with the chain by a tick at the boundaries.
 *
 * Integer throughout. Doing this in floating point loses precision exactly
 * where prices are largest, which is where a wrong answer costs the most.
 */
export function sqrtRatioAtTick(tick: number): bigint {
  const MAX_TICK = 887272;
  if (!Number.isInteger(tick) || tick < -MAX_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick ${tick} is out of range`);
  }

  const absTick = BigInt(Math.abs(tick));
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;

  const mul = (bit: bigint, constant: bigint) => {
    if ((absTick & bit) !== 0n) ratio = (ratio * constant) >> 128n;
  };

  mul(0x2n, 0xfff97272373d413259a46990580e213an);
  mul(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  mul(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  mul(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
  mul(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
  mul(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
  mul(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
  mul(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  mul(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
  mul(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
  mul(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  mul(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  mul(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  mul(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
  mul(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
  mul(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  mul(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
  mul(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
  mul(0x80000n, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;

  // Q128.128 down to Q64.96, rounding up so the result never understates.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * Raw token1 per raw token0 at a tick, scaled by 1e18.
 *
 * Deliberately *raw* units on both sides, with no decimal correction. That is
 * what the Guard compares against, because the Guard derives the executed price
 * from observed balance deltas, which are also raw. Introducing decimals here
 * would mean two conventions meeting in the middle, and the failure mode is a
 * silent factor of 10^10 on a token like SPX.
 */
export function priceX18AtTick(tick: number): bigint {
  const sqrtPriceX96 = sqrtRatioAtTick(tick);
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / Q192;
}

/** The inverse of the above: raw token0 per raw token1, scaled by 1e18. */
export function inversePriceX18AtTick(tick: number): bigint {
  const sqrtPriceX96 = sqrtRatioAtTick(tick);
  const denominator = sqrtPriceX96 * sqrtPriceX96;
  if (denominator === 0n) return 0n;
  return (Q192 * WAD) / denominator;
}

/**
 * Mean tick across a window, from two cumulative readings.
 *
 * Floors toward negative infinity rather than toward zero, matching Uniswap's
 * own OracleLibrary. Truncating instead would bias every negative-tick pair —
 * which, given token ordering is by address, is an arbitrary half of them.
 */
export function meanTick(olderCumulative: bigint, newerCumulative: bigint, windowSeconds: number): number {
  const window = BigInt(windowSeconds);
  const delta = newerCumulative - olderCumulative;
  let tick = delta / window;
  if (delta < 0n && delta % window !== 0n) tick -= 1n;
  return Number(tick);
}

/**
 * Harmonic-mean in-range liquidity across a window, from two readings of a
 * pool's seconds-per-liquidity accumulator: Uniswap's `OracleLibrary.consult`.
 *
 * The pool adds `seconds × 2^128 / liquidity` to that accumulator, counting an
 * empty range as liquidity 1, so `window × 2^128` over the difference is the
 * harmonic mean. That is dominated by its smallest terms, which is the point:
 * a few seconds with nothing in range drag it towards zero. The accumulator is
 * a uint160 that wraps, and so does the difference. Uniswap narrows the result
 * to uint128; this does not, because an accumulator that grew by less than the
 * window would be silently truncated. No difference at all would mean infinite
 * liquidity, which no genuine pool reports, so it is answered as none.
 */
export function harmonicMeanLiquidity(olderPerLiquidity: bigint, newerPerLiquidity: bigint, windowSeconds: number): bigint {
  const perLiquidity = (newerPerLiquidity - olderPerLiquidity) & UINT160_MAX;
  if (perLiquidity === 0n) return 0n;
  return (BigInt(windowSeconds) * UINT160_MAX) / (perLiquidity << 32n);
}

/**
 * The WETH a pool behaves as if it held at `tick`, given `liquidity` in range:
 * its virtual WETH reserve, `L / √P` when WETH is token0 and `L · √P` when it
 * is token1. The vault's `OracleQuote.wethDepth`.
 *
 * A constant-product pool holding this much WETH would move exactly as this
 * pool does for a small trade at this price. It says nothing about how far
 * that depth extends, which is why a narrow position can have a lot of it
 * cheaply (see "Which pool" above).
 */
export function wethDepthAtTick(tick: number, liquidity: bigint, wethIsToken0: boolean): bigint {
  const sqrtPriceX96 = sqrtRatioAtTick(tick);
  return wethIsToken0 ? (liquidity * Q96) / sqrtPriceX96 : (liquidity * sqrtPriceX96) / Q96;
}

function encodeObserve(windowSeconds: number): Hex {
  // One dynamic uint32[2]: head offset, length, then the two ages.
  return `0x${SELECTOR_OBSERVE.slice(2)}${encUint(0x20)}${encUint(2)}${encUint(windowSeconds)}${encUint(0)}` as Hex;
}

/**
 * Decode both of `observe`'s arrays: `tickCumulatives` (int56) and
 * `secondsPerLiquidityCumulativeX128s` (uint160). Layout: two head words
 * holding offsets, then at each offset a length followed by the entries.
 */
function decodeObserve(data: string): { ticks: [bigint, bigint]; perLiquidity: [bigint, bigint] } | null {
  const pairAt = (headIndex: number, read: typeof wordAt): [bigint, bigint] | null => {
    const offset = wordAt(data, headIndex);
    if (offset === null || offset % 32n !== 0n) return null;
    const base = Number(offset / 32n);
    const length = wordAt(data, base);
    if (length === null || length < 2n) return null;
    const older = read(data, base + 1);
    const newer = read(data, base + 2);
    return older === null || newer === null ? null : [older, newer];
  };
  const ticks = pairAt(0, signedWordAt);
  const perLiquidity = pairAt(1, wordAt);
  return ticks && perLiquidity ? { ticks, perLiquidity } : null;
}

export interface TwapOracleOptions {
  /**
   * Averaging window. Longer is harder to manipulate and slower to follow a
   * genuine move; ten minutes is the compromise, and a volatile pair legitimately
   * trading away from its ten-minute mean is exactly the case this must not
   * turn into a refusal — which is why divergence is only ever a warning.
   */
  windowSeconds?: number;
  factory?: Address;
  feeTiers?: readonly number[];
  /**
   * The token whose pools price native ether. v3 has no native pools, so ether
   * is priced as the token it wraps into 1:1. It is also the hub every other
   * price is read through.
   */
  wrappedNative?: Address;
  /** Uniswap v2's factory, where each market's reference pair comes from. */
  v2Factory?: Address;
  /** Defaults to `TWAP_MIN_OBSERVATIONS`. */
  minObservations?: number;
  /** In wei of the wrapped native token. Defaults to `TWAP_MIN_DEPTH`. */
  minDepth?: bigint;
  /** Defaults to `TWAP_AGREEMENT_BPS`. */
  agreementBps?: number;
}

/** One Uniswap v3 pool considered for a market, and what was read from it. */
export interface TwapPoolReading {
  pool: Address;
  fee: number;
  /** How many observations it keeps (`slot0`'s cardinality); null when it would not say. */
  observations: number | null;
  /** Its mean tick over the window; null when `observe` could not reach back that far. */
  meanTick: number | null;
  /**
   * Its harmonic-mean in-range liquidity over the window, as a virtual WETH
   * reserve in wei; null whenever `meanTick` is.
   */
  depth: bigint | null;
  /**
   * Whether its average is within the agreement tolerance of the reference
   * pair's mid; null when there is no reference pair or no average.
   */
  agrees: boolean | null;
  /** Why it is not read from at all, or null when it may be. */
  refused: "history" | "depth" | null;
}

/** What the oracle found for one token's market against WETH. */
export interface TwapMarket {
  token: Address;
  /**
   * The Uniswap v2 pair whose mid price the pools are checked against; null
   * when there is none, or it holds less WETH than the depth floor.
   */
  reference: Address | null;
  /** Every v3 pool Uniswap's factory lists for the token and WETH, in fee-tier order. */
  pools: TwapPoolReading[];
  /** The pool whose average is the opinion; null for no opinion. */
  chosen: TwapPoolReading | null;
}

/**
 * A second opinion from Uniswap v3's built-in accumulator.
 *
 * Reads each token's market against WETH, picks a pool by the rules under
 * "Which pool" at the top of this file, and reports the time-weighted mid
 * price. Two round trips per check however many legs, because this sits
 * directly in front of the user's swap button.
 */
export class UniswapV3TwapOracle {
  readonly #window: number;
  readonly #factory: Address;
  readonly #feeTiers: readonly number[];
  readonly #hub: string;
  readonly #v2Factory: Address;
  readonly #minObservations: number;
  readonly #minDepth: bigint;
  readonly #agreementBps: bigint;

  constructor(
    // Only `multicall` is used. Typed structurally so a scripted reader can
    // stand in for it in unit tests without a node behind it.
    private readonly chain: Pick<Multicall3Reader, "multicall">,
    options: TwapOracleOptions = {},
  ) {
    this.#window = options.windowSeconds ?? 600;
    this.#factory = options.factory ?? CONTRACTS.uniV3Factory;
    this.#feeTiers = options.feeTiers ?? UNI_V3_FEE_TIERS;
    this.#hub = (options.wrappedNative ?? TOKENS.WETH.address).toLowerCase();
    this.#v2Factory = options.v2Factory ?? CONTRACTS.uniV2Factory;
    this.#minObservations = options.minObservations ?? TWAP_MIN_OBSERVATIONS;
    this.#minDepth = options.minDepth ?? TWAP_MIN_DEPTH;
    this.#agreementBps = BigInt(options.agreementBps ?? TWAP_AGREEMENT_BPS);
  }

  async priceRatio(tokenIn: Address, tokenOut: Address): Promise<bigint | null> {
    // Native ether is priced as WETH. The swap path names ether by the
    // 0xeeee…eeee marker, and no v3 pool is keyed on that address, so asked
    // as-is the factory answers "no pool" and every swap into or out of ether
    // — which is what a recurring buy most often is — silently loses its price
    // check. The substitution is exact rather than approximate: WETH redeems
    // 1:1 for ether at the same 18 decimals, and the Guard measures ether in
    // raw wei from the same simulation, so the raw ratio carries over unchanged.
    //
    // It also makes ether against WETH one token against itself, which has no
    // market and so no opinion. That is right: wrapping is 1:1 by contract, and
    // there is no price to be wrong about.
    const a = this.#priced(tokenIn);
    const b = this.#priced(tokenOut);
    if (a === b) return null;

    try {
      const markets = await this.#markets([a, b].filter((token) => token !== this.#hub));

      // Each leg as a tick of raw WETH per raw token. v3 prices token1 in
      // token0, and orders a pool's tokens by address, so which way round a
      // leg's tick points depends only on whether the token sorts below WETH.
      const towardsHub = (token: string): number | null => {
        if (token === this.#hub) return 0;
        const tick = markets.get(token)?.chosen?.meanTick ?? null;
        if (tick === null) return null;
        return token < this.#hub ? tick : -tick;
      };
      const inTick = towardsHub(a);
      const outTick = towardsHub(b);
      if (inTick === null || outTick === null) return null;

      // Raw tokenOut per raw tokenIn: in → WETH, then WETH → out. Ticks are
      // logarithms of price, so the legs add; a sum beyond the tick range
      // throws, and lands in the catch below as no opinion.
      const ratio = priceX18AtTick(inTick - outTick);
      // A ratio of zero would make the Guard's divergence arithmetic divide by
      // zero; it means the tick is far enough out that 1e18 scaling underflows,
      // which is not an opinion worth having.
      return ratio > 0n ? ratio : null;
    } catch {
      // No opinion. See the fail-open note at the top of this file.
      return null;
    }
  }

  /**
   * How the oracle sees `token`'s market against WETH: every v3 pool the
   * factory lists, what was read from each, the reference pair, and the pool
   * whose average is the opinion.
   *
   * This is for finding out *why* there is or is not an opinion, so unlike
   * `priceRatio` it throws when the endpoint fails: "the read failed" is an
   * answer to that question. Null for WETH itself, and for ether, which is
   * priced as WETH.
   */
  async market(token: Address): Promise<TwapMarket | null> {
    const priced = this.#priced(token);
    if (priced === this.#hub) return null;
    return (await this.#markets([priced])).get(priced) ?? null;
  }

  /** The address whose v3 pools price a token: itself, or WETH for ether. */
  #priced(token: Address): string {
    return isNativeToken(token) ? this.#hub : token.toLowerCase();
  }

  /** Every token's market against WETH, in two round trips however many tokens. */
  async #markets(tokens: readonly string[]): Promise<Map<string, TwapMarket>> {
    const hub = this.#hub;
    const tiers = this.#feeTiers.length;

    // Round one: where the markets are. Every fee tier's pool, and the v2 pair.
    const lookups = await this.chain.multicall(
      tokens.flatMap((token) => [
        ...this.#feeTiers.map((fee) => ({
          to: this.#factory,
          data: `0x${SELECTOR_GET_POOL.slice(2)}${encAddress(token)}${encAddress(hub)}${encUint(fee)}` as Hex,
        })),
        {
          to: this.#v2Factory,
          data: `0x${SELECTOR_GET_PAIR.slice(2)}${encAddress(token)}${encAddress(hub)}` as Hex,
        },
      ]),
    );
    const found = tokens.map((token, index) => {
      const row = lookups.slice(index * (tiers + 1), (index + 1) * (tiers + 1));
      const pools = this.#feeTiers.flatMap((fee, tier) => {
        const pool = addressAt(row[tier]);
        return pool === null ? [] : [{ pool, fee }];
      });
      return { token, pools, pair: addressAt(row[tiers]) };
    });

    // Round two: whether they can be used. History, the window's cumulatives
    // and the pair's reserves together, since every one of them is needed.
    const reads = found.flatMap(({ pools, pair }) => [
      ...pools.flatMap(({ pool }) => [
        { to: pool, data: SELECTOR_SLOT0 as Hex },
        { to: pool, data: encodeObserve(this.#window) },
      ]),
      ...(pair === null ? [] : [{ to: pair, data: SELECTOR_GET_RESERVES as Hex }]),
    ]);
    const results = reads.length === 0 ? [] : await this.chain.multicall(reads);

    const markets = new Map<string, TwapMarket>();
    let cursor = 0;
    for (const { token, pools, pair } of found) {
      const answers = pools.map(() => ({ slot0: results[cursor++] ?? "0x", observed: results[cursor++] ?? "0x" }));
      const reserves = pair === null ? "0x" : (results[cursor++] ?? "0x");
      markets.set(token, this.#judge(token, pools, answers, pair, reserves));
    }
    return markets;
  }

  /** Read one market's pools, and choose: see "Which pool" at the top of this file. */
  #judge(
    token: string,
    pools: readonly { pool: Address; fee: number }[],
    answers: readonly { slot0: string; observed: string }[],
    pair: Address | null,
    reservesData: string,
  ): TwapMarket {
    // v2 and v3 both order a market's tokens by address, so the pair's
    // reserves line up with the pool's token0 and token1.
    const hubIsToken0 = this.#hub < token;
    const reserve0 = wordAt(reservesData, 0);
    const reserve1 = wordAt(reservesData, 1);
    const reference =
      pair !== null &&
      reserve0 !== null &&
      reserve1 !== null &&
      reserve0 > 0n &&
      reserve1 > 0n &&
      (hubIsToken0 ? reserve0 : reserve1) >= this.#minDepth
        ? { pair, reserve0, reserve1 }
        : null;

    const readings = pools.map(({ pool, fee }, index): TwapPoolReading => {
      const { slot0, observed } = answers[index]!;
      // `observationCardinality`, the fourth word; a uint16 in any genuine pool.
      const cardinality = wordAt(slot0, 3);
      const observations = cardinality !== null && cardinality <= 0xffffn ? Number(cardinality) : null;

      let tick: number | null = null;
      let depth: bigint | null = null;
      let agrees: boolean | null = null;
      // `observe` reverts with "OLD" when the pool's history does not reach
      // back a whole window, which comes back as "0x" rather than throwing.
      const cumulatives = decodeObserve(observed);
      if (cumulatives) {
        try {
          const mean = meanTick(cumulatives.ticks[0], cumulatives.ticks[1], this.#window);
          const liquidity = harmonicMeanLiquidity(cumulatives.perLiquidity[0], cumulatives.perLiquidity[1], this.#window);
          depth = wethDepthAtTick(mean, liquidity, hubIsToken0);
          tick = mean;
          if (reference) {
            // Price as token1 per token0 on both sides, cross-multiplied so
            // nothing is rounded: √P² / 2^192 against reserve1 / reserve0.
            const sqrtPriceX96 = sqrtRatioAtTick(mean);
            const average = sqrtPriceX96 * sqrtPriceX96 * reference.reserve0;
            const mid = reference.reserve1 * Q192;
            const gap = average > mid ? average - mid : mid - average;
            agrees = gap * 10_000n <= this.#agreementBps * mid;
          }
        } catch {
          // A mean tick outside the tick range: no genuine pool reports one.
          tick = null;
          depth = null;
          agrees = null;
        }
      }

      const refused =
        observations === null || observations < this.#minObservations || tick === null
          ? "history"
          : depth === null || depth < this.#minDepth
            ? "depth"
            : null;
      return { pool, fee, observations, meanTick: tick, depth, agrees, refused };
    });

    const usable = readings.filter((reading) => reading.refused === null);
    const agreeing = usable.filter((reading) => reading.agrees === true);
    let chosen: TwapPoolReading | null = null;
    for (const reading of agreeing.length > 0 ? agreeing : usable) {
      if (chosen === null || reading.depth! > chosen.depth!) chosen = reading;
    }

    return { token: token as Address, reference: reference?.pair ?? null, pools: readings, chosen };
  }
}
