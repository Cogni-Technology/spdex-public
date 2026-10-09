/**
 * What the ticker under the masthead says, as a pure function of what the
 * page already knows.
 *
 * The ticker is spx6900.com's marquee, and a marquee is the one place on a
 * page where it is tempting to put a number because the strip looks empty
 * without one. The rule here is the rest of the app's: a figure that is not
 * known is left out, never shown as $0 or as a placeholder. What is always
 * there are the ethos lines, which are true whatever the network says, so the
 * strip is never empty and never needs a stand-in.
 *
 * There is no price in it. "There is no chart" is SPX6900's own line: holders
 * watch the movement, not the price, so the strip leads with how far SPX6900
 * is from flipping the stock market instead. The only place spDEX shows what a
 * token costs is where a trade needs it — the swap's rate, the "≈ $" beside an
 * amount, what a market holds — never as a figure to watch for its own sake.
 *
 * Nothing here reads the network, a clock or storage. Every figure comes from
 * state App already holds — the dollar rates the page read (the Guard's own
 * TWAP feed), the markets panel's balances, the auto-buy runner's next buy
 * time, SPX's total supply, which App reads from the token itself now and
 * then for this strip, and the vault buys the Collective DCA panel counted
 * when it was opened — so the ticker can never disagree with the panel a
 * figure was taken from, and the strip itself asks the network nothing.
 *
 * Liquidity is in the person's currency, as the markets panel shows it. "% to
 * flip" stays a share of $69 trillion, the meme's own figure, in dollars.
 */

import type { Known } from "@spdex/vault";
import type { PricedPool } from "./stats.js";
import { formatPoolMoney, USD_DECIMALS } from "./stats.js";
import type { MoneyView } from "./money/convert.js";
import { formatCount } from "./money/format.js";
import { countdown, formatSignificant } from "./dca/format.js";

export interface TickerItem {
  /** Stable across renders, so React keeps the node and the scroll never restarts. */
  id: string;
  /** The quiet half ("ETH/SPX liquidity", "to flip"), or absent for an ethos line. */
  label?: string;
  /** The label follows the figure ("0.0006751% to flip") rather than leading it. */
  labelAfter?: true;
  /** The figure, or the whole ethos line. */
  text: string;
  /**
   * What a screen reader is given in place of what the strip shows, when the
   * shorthand on screen doesn't say what it is: "0.0006751% to flip" is a
   * slogan to someone who can see the rest of the page, and a riddle read
   * aloud on its own.
   */
  spoken?: string;
  kind: "figure" | "ethos";
}

/**
 * The lines that are true whatever the network says. Written in sentence case
 * and set in capitals by the stylesheet, so a screen reader reads words
 * rather than spelling out letters.
 *
 * One community slogan, never a claim about how spDEX works, and nothing
 * the page already says: "no servers" is said in the sticker, the footer and
 * the disclaimer (UI rule R5, docs/ARCHITECTURE.md); "community project" sits
 * under the wordmark at every width. "Believe in something"
 * is left out too: it is half of the community's motto without its
 * attribution, and spx6900.com's own header line. The strip's real figures
 * fill the rest.
 */
export const TICKER_ETHOS: readonly string[] = ["Flip the stock market"];

export interface TickerInput {
  /**
   * Dollar rates by lowercase token address, as `loadUsdRates` makes them:
   * raw USDC per raw token, scaled by 1e18. A token missing from the map has
   * no price, and nothing that needs one is shown.
   */
  rates: ReadonlyMap<string, bigint>;
  /**
   * SPX: its address, to find its rate, and its total supply in raw units as
   * the token's own `totalSupply()` answered — or null while that is unknown
   * (not read yet, the read failed, statistics off, no network service). Null
   * leaves "% to flip" out.
   */
  spx: { address: string; supply: bigint | null };
  /**
   * The markets for the pair on screen, once they have been read for that
   * pair, or null while they have not (loading, another pair's still in
   * state, the tracker switched off). Null leaves the item out.
   */
  liquidity: { pair: string; pools: readonly Pick<PricedPool, "tvlUsd">[] } | null;
  /**
   * The page's rates and currency for the liquidity figure, when they have
   * been read for something on screen; without them it is in dollars.
   */
  money?: MoneyView | undefined;
  /** When the soonest running auto-buy is next due, in unix seconds, or null. */
  nextBuyAt: number | null;
  /**
   * Buys every auto-buy vault has made, as the Collective DCA panel last
   * read them through this network service; null until it has been opened.
   */
  vaultBuys?: Known<bigint> | null;
  nowMs: number;
}

const WAD_DIGITS = 18;

/**
 * The flip target, in whole dollars: $69 trillion.
 *
 * SPX6900's own round figure for the stock market it means to flip — a
 * meme's number, not a measurement of the S&P 500 — so it is a constant here
 * rather than something read, and nothing pretends it tracks a real index.
 */
export const FLIP_TARGET_USD = 69_000_000_000_000n;

/** How the spoken sentence names the target, kept beside the number it names. */
const FLIP_TARGET_WORDS = "$69 trillion";

/**
 * Decimal places the share is worked to before its one rounding. Enough that
 * even the smallest inputs there are (one raw unit of supply at the lowest
 * rate, about 1.4 × 10⁻³⁶ %) keep five significant digits, so rounding to four
 * never works from a figure already cut short.
 */
const PERCENT_DECIMALS = 40;

/**
 * SPX6900's market cap as a share of the flip target, e.g. "0.0006751%", or
 * null when it is not known.
 *
 * Market cap is total supply × price, and both halves stay raw: the supply in
 * the token's base units, the rate in raw USDC per raw token × 1e18. Their
 * product is dollars with 6 + 18 decimals whatever the token's own decimals
 * are, so there is no decimal correction to get wrong — the mistake that
 * would be a silent factor of 10¹⁰ on an 8-decimal token like SPX.
 *
 * Worked in integers and rounded once, at the end, to four significant
 * digits (fewer when the last are zeros: "0.000628%"). Significant digits
 * rather than a fixed number of places: today the share is under a
 * thousandth of a percent, so two places would say "0.00%", and the digits
 * that move are the ones the figure is for.
 *
 * Null rather than "0%" when either half is missing. A supply of zero is
 * treated the same way: a token that markets price but nobody holds is a
 * contradiction, so a zero there means the read answered for something other
 * than the token that was priced.
 */
export function flipPercentText(supply: bigint | null, rate: bigint | undefined): string | null {
  if (supply === null || rate === undefined || supply <= 0n || rate <= 0n) return null;
  const scaled =
    (supply * rate * 100n * 10n ** BigInt(PERCENT_DECIMALS)) /
    (FLIP_TARGET_USD * 10n ** BigInt(USD_DECIMALS + WAD_DIGITS));
  return `${formatSignificant(scaled, PERCENT_DECIMALS, 4)}%`;
}

/** The sentence a screen reader hears for "% to flip". */
export function flipSpokenText(percent: string): string {
  return `SPX6900 market cap is ${percent} of the ${FLIP_TARGET_WORDS} flip target`;
}

/**
 * The pair's total liquidity, the same sum the markets panel shows as "Total
 * liquidity" — or null when no market on screen could be priced.
 *
 * When some markets were priced and others weren't, the sum covers only the
 * priced ones, so it is a floor and says so with "≥". A pool nobody could
 * price is unknown, not empty, and counting it as zero would pass a lower
 * bound off as the total.
 */
export function liquidityText(pools: readonly Pick<PricedPool, "tvlUsd">[], money?: MoneyView): string | null {
  const priced = pools.filter((pool) => pool.tvlUsd !== null);
  if (priced.length === 0) return null;
  const total = priced.reduce((sum, pool) => sum + pool.tvlUsd!, 0n);
  const text = formatPoolMoney(total, money);
  return priced.length === pools.length ? text : `≥ ${text}`;
}

/**
 * "186 vault buys", or "≥ 186 vault buys" when some vault couldn't be read,
 * or null before the panel has counted them. A count, never money.
 */
export function vaultBuysText(buys: Known<bigint> | null | undefined): string | null {
  if (buys === null || buys === undefined) return null;
  return `${buys.atLeast ? "≥ " : ""}${formatCount(buys.value)}`;
}

/**
 * The soonest next buy among running plans, in unix seconds, or null.
 *
 * The same selection the status strip makes, from the strip's own cards
 * (`useAutoBuy`'s `nextBuyAt`): a plan counts only while it is running and
 * waiting for a time. A due buy — a vault's waiting for a keeper included —
 * a paused plan or one that needs attention has no countdown to show, and
 * the plan card is where it is acted on. A vault's time is the chain's,
 * carried into this device's clock before it gets here.
 */
export function nextBuyAt(plans: readonly { running: boolean; nextAt: number | null }[]): number | null {
  let soonest: number | null = null;
  for (const plan of plans) {
    if (!plan.running || plan.nextAt === null || !Number.isFinite(plan.nextAt)) continue;
    if (soonest === null || plan.nextAt < soonest) soonest = plan.nextAt;
  }
  return soonest;
}

/** Everything the ticker shows, in order: the figures that are known, then the ethos. */
export function tickerItems(input: TickerInput): TickerItem[] {
  const items: TickerItem[] = [];

  const flip = flipPercentText(input.spx.supply, input.rates.get(input.spx.address.toLowerCase()));
  if (flip !== null) {
    items.push({
      id: "flip",
      label: "to flip",
      labelAfter: true,
      text: flip,
      spoken: flipSpokenText(flip),
      kind: "figure",
    });
  }

  const liquidity = input.liquidity === null ? null : liquidityText(input.liquidity.pools, input.money);
  if (liquidity !== null) {
    items.push({ id: "liquidity", label: `${input.liquidity!.pair} liquidity`, text: liquidity, kind: "figure" });
  }

  const vaultBuys = vaultBuysText(input.vaultBuys);
  if (vaultBuys !== null) {
    items.push({ id: "vault-buys", label: "vault buys", labelAfter: true, text: vaultBuys, kind: "figure" });
  }

  if (input.nextBuyAt !== null) {
    // `countdown` says "in 3h 12m", "any moment" or "now", from the wall
    // clock rather than from ticks. It stays lower case on screen: in
    // capitals "12M" beside a dollar figure reads as twelve million.
    items.push({ id: "next-buy", label: "Next auto-buy", text: countdown(input.nextBuyAt, input.nowMs), kind: "figure" });
  }

  TICKER_ETHOS.forEach((line, index) => items.push({ id: `ethos-${index}`, text: line, kind: "ethos" }));
  return items;
}
