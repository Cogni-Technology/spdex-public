/**
 * Turning money into a token amount, and a token amount into money.
 *
 * Both directions go through two rates, and only these two: the token's
 * price in US dollars from spDEX's 10-minute average (the Guard's own oracle,
 * read through the person's network service), and, for any currency but the
 * dollar, Chainlink's dollar price of that currency, read the same way. USDC
 * is taken as exactly one dollar, as everywhere else in spDEX.
 *
 * All integer arithmetic, one division per direction, so there is one
 * rounding and it goes one way: down.
 */

import { ETH_USD_FEED, FX_REFERENCE, fxProblem, NATIVE_TOKEN, TOKENS, type FxCode } from "@spdex/chain";
import { formatFiat } from "./format.js";
import type { CurrencyCode, FiatAmount, FxAnswer, FxSnapshot } from "./pricing.js";

const WAD = 10n ** 18n;
/** USDC's base units per dollar: USD is carried in millionths, as USDC is. */
const USDC_UNIT = 1_000_000n;

/** A rate to divide or multiply by: dollars per unit of the currency, times 10^decimals. */
export interface FxRate {
  answer: bigint;
  decimals: number;
}

/** The dollar, against itself. */
const ONE_DOLLAR: FxRate = { answer: 1n, decimals: 0 };

/**
 * `code`'s answer from `s`, or null when it is unknown: missing, stale by
 * chain time, of the wrong decimals, outside its band, or never updated. The
 * dollar has no feed and is always itself.
 */
export function validFx(s: FxSnapshot | null, code: CurrencyCode): FxAnswer | null {
  if (code === "USD") return { answer: 1n, decimals: 0, updatedAt: s?.chainTime ?? 0 };
  if (s === null) return null;
  const answer = s.rates[code];
  return fxProblem(code as FxCode, answer, s.chainTime) === null ? (answer ?? null) : null;
}

/** The rate `code` converts at, from `s`, or null when it is unknown. */
export function fxRate(s: FxSnapshot | null, code: CurrencyCode): FxRate | null {
  if (code === "USD") return ONE_DOLLAR;
  const answer = validFx(s, code);
  return answer === null ? null : { answer: answer.answer, decimals: answer.decimals };
}

/** The key a token is priced under: native ether is priced as WETH, which it trades as. */
export function pricedAs(token: string): string {
  const address = token.toLowerCase();
  return address === NATIVE_TOKEN.toLowerCase() ? TOKENS.WETH.address.toLowerCase() : address;
}

/** A Chainlink dollar answer as a rate in `usd`'s terms: raw USDC per raw ether, times 1e18. */
const etherRateOf = (answer: FxRate): bigint => (answer.answer * USDC_UNIT) / 10n ** BigInt(answer.decimals);

/**
 * What ether's dollar rate is always checked against: Chainlink's ETH/USD
 * answer at the fork's pinned block (`FX_REFERENCE.ETH`, $2,451.31), read
 * again for each release as the currency references are.
 */
export const ETH_USD_REFERENCE = etherRateOf({ answer: FX_REFERENCE.ETH, decimals: ETH_USD_FEED.decimals });
/** A rate more than this many times from its reference, either way, is unknown. */
const ETH_BAND_FACTOR = 5n;
/**
 * How far ether's rate may be from a usable Chainlink ETH/USD answer read
 * with the page's currencies, in percent either way. The two measure the same
 * market, one as a 10-minute average and the other on every half-percent
 * move, so an honest pair is far closer than this.
 */
export const ETH_USD_AGREEMENT_PERCENT = 10n;

/**
 * Whether ether's dollar rate may be used: inside a fifth to five times
 * `ETH_USD_REFERENCE`, and, when `fx` holds a usable ETH/USD answer (fresh
 * and in its own band, `fxProblem`), within `ETH_USD_AGREEMENT_PERCENT` of it.
 */
function etherRatePlausible(rate: bigint, fx: FxSnapshot | null): boolean {
  if (rate * ETH_BAND_FACTOR < ETH_USD_REFERENCE || rate > ETH_USD_REFERENCE * ETH_BAND_FACTOR) return false;
  const eth = fx?.eth ?? null;
  if (fx === null || eth === null || fxProblem("ETH", eth, fx.chainTime) !== null) return true;
  const chainlink = etherRateOf(eth);
  const gap = rate > chainlink ? rate - chainlink : chainlink - rate;
  return gap * 100n <= chainlink * ETH_USD_AGREEMENT_PERCENT;
}

/**
 * Raw USDC per raw token, times 1e18, or null when the token has no price in
 * `usd`. Ether's is unknown, too, when it is implausible
 * (`etherRatePlausible`), as a currency's answer outside its band is: the
 * rate comes from the main service's 10-minute average, and a lying service
 * or a pushed average would otherwise size "$20" as any amount of ether,
 * with the "≈" figure beside it agreeing, since it uses the same rate.
 */
export function usdRateOf(token: string, usd: ReadonlyMap<string, bigint>, fx: FxSnapshot | null = null): bigint | null {
  const key = pricedAs(token);
  const rate = usd.get(key);
  if (rate === undefined || rate <= 0n) return null;
  if (key === TOKENS.WETH.address.toLowerCase() && !etherRatePlausible(rate, fx)) return null;
  return rate;
}

/**
 * The most base units that `typed` (the amount times 10^18) buys:
 * `floor(typed × answer × 10^6 / (10^decimals × usdRate))`.
 *
 * Dollars per unit of currency times units typed is dollars; times 10^6 is
 * USDC base units; divided by USDC per base unit of the token is base units.
 */
export function fiatToTokenRaw(typed: bigint, fx: FxRate, usdRate: bigint): bigint {
  if (typed <= 0n || usdRate <= 0n || fx.answer <= 0n) return 0n;
  return (typed * fx.answer * USDC_UNIT) / (10n ** BigInt(fx.decimals) * usdRate);
}

/**
 * The top `significant` digits of a base-unit amount, the rest zeroed:
 * 8,158,902,790,752,699 wei becomes 8,158,900,000,000,000 (0.0081589 ETH).
 * Amounts under 10^significant base units are kept whole.
 *
 * Rounded down, so what is spent never exceeds what was typed, and short
 * enough to read back and compare with the wallet.
 */
export function floorSignificant(raw: bigint, significant = 6): bigint {
  if (raw <= 0n) return 0n;
  const digits = raw.toString().length;
  if (digits <= significant) return raw;
  const step = 10n ** BigInt(digits - significant);
  return (raw / step) * step;
}

/** Dollar millionths (USDC base units, as pool statistics price in) in `c`, or null without a valid rate. */
export function usdToFiat(usd: bigint, fx: FxSnapshot | null, c: CurrencyCode): FiatAmount | null {
  const rate = fxRate(fx, c);
  return rate === null ? null : { minor6: (usd * 10n ** BigInt(rate.decimals)) / rate.answer, currency: c };
}

/**
 * The inverse, for a figure the person typed: `typed` (the amount times
 * 10^18) in `c` as millionths of `c`.
 */
export function typedToFiat(typed: bigint, c: CurrencyCode): FiatAmount {
  return { minor6: typed / 10n ** 12n, currency: c };
}

// ── Display ───────────────────────────────────────────────────────────────

/**
 * What a "≈" figure needs: the dollar prices and currency rates on hand, the
 * currency to show, and the number format. Built once per render from the
 * page's `Pricing` (`moneyView`, rates.ts), or from a dollar-only map where
 * that is all there is.
 */
export interface MoneyView {
  /** Raw USDC per raw token, times 1e18, by lowercase address. */
  usd: ReadonlyMap<string, bigint>;
  fx: FxSnapshot | null;
  currency: CurrencyCode;
  locale: string;
}

/** A figure for display, and whether it is in dollars because the chosen currency's rate is unknown. */
export interface ShownFiat {
  value: FiatAmount;
  fellBack: boolean;
}

/**
 * Dollar millionths in `currency` when `fx` has its rate, otherwise in
 * dollars (`fellBack`): how every money figure is shown. Display only: an
 * amount is never sized from a fallback.
 */
export function usdShown(usd: bigint, fx: FxSnapshot | null, currency: CurrencyCode): ShownFiat {
  const local = usdToFiat(usd, fx, currency);
  return local !== null ? { value: local, fellBack: false } : { value: { minor6: usd, currency: "USD" }, fellBack: true };
}

/**
 * `amount` of `token` in the view's currency, or in dollars when that
 * currency's rate is unknown (`fellBack`), or null when the token has no
 * price at all.
 */
export function fiatOf(amount: bigint, token: string, view: MoneyView): ShownFiat | null {
  const usdRate = usdRateOf(token, view.usd, view.fx);
  return usdRate === null ? null : usdShown((amount * usdRate) / WAD, view.fx, view.currency);
}

/**
 * "≈ $0.52" or "≈ €0.45": what `wei` of ether is worth in the page's
 * currency, to its smallest unit, or null without a rate for it (or for
 * nothing). Rounded to the nearest cent, where cutting to the cent below
 * would understate a small buy's fee by up to a third. Worth less than half a
 * cent reads "< $0.01", never "$0.00". The space after "≈" and "<" doesn't
 * break, so a narrow line never leaves the sign at the end of one line and
 * the figure on the next.
 */
export function fiatCostText(wei: bigint, money: MoneyView | undefined): string | null {
  if (money === undefined || wei <= 0n) return null;
  const value = fiatOf(wei, NATIVE_TOKEN, money);
  return value === null ? null : formatFiat(value.value, money.locale, { approx: true });
}

/** True when the view's currency can't be shown and figures fall back to dollars. */
export function fallsBack(view: MoneyView): boolean {
  return fxRate(view.fx, view.currency) === null;
}
