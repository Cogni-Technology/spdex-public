/**
 * Writing money and amounts for people to read, and amounts back into fields.
 *
 * - **Money** is written by Intl in the currency's own style and decimal
 *   places ("$20.00", "20,00 €", "¥2,940"), exactly: the value is carried as
 *   an integer and only its layout comes from Intl, never a float's digits.
 *   A real amount too small to show reads "< $0.01", never "$0.00".
 * - **Amounts written into a field** use the number format's decimal mark
 *   and no grouping, so what the field shows reads back as exactly the same
 *   amount ("0,5" in de-DE).
 * - **The display locale** is the page's number format, which `formatAmount`
 *   (tokens.ts) and `formatSignificant` (dca/format.ts) read for grouping and
 *   the decimal mark. It stays en-US until the money store sets it, so tests
 *   and anything outside the page keep one format.
 */

import { currencyDigits } from "./currency.js";
import type { FiatAmount, FormatFiatOptions } from "./pricing.js";


let pageLocale = "en-US";

/** The page's number format: en-US until `setDisplayLocale` says otherwise. */
export function displayLocale(): string {
  return pageLocale;
}

/**
 * Change the page's number format. A tag Intl doesn't know is ignored rather
 * than stored: every figure on the page is written through it.
 */
export function setDisplayLocale(locale: string): void {
  try {
    if (Intl.NumberFormat.supportedLocalesOf([locale]).length > 0) pageLocale = locale;
  } catch {
    // A malformed tag: keep the one that works.
  }
}

/** The decimal mark `locale` writes: "." or ",". */
export function decimalMark(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * "≈ $20.00", "20,00 €", "< ¥1", "$12.26M" (compact).
 *
 * Rounded half up to the currency's own decimal places. A positive amount
 * that rounds to nothing is written as below the smallest unit, so a tiny
 * real figure never reads as zero. "≈" and "<" are joined to the figure by a
 * no-break space, so a narrow line never leaves one alone at its end.
 */
export function formatFiat(value: FiatAmount, locale: string, options: FormatFiatOptions = {}): string {
  const digits = currencyDigits(value.currency);
  const step = 10n ** BigInt(6 - digits);
  const negative = value.minor6 < 0n;
  const abs = negative ? -value.minor6 : value.minor6;

  if (abs > 0n && abs * 2n < step) {
    return `< ${exactCurrency(1n, digits, value.currency, locale)}`;
  }
  const lead = options.approx ? "≈ " : "";
  if (options.compact) {
    // Four figures at most: a table scanned for size, where "$12.26M" says
    // everything "$12,261,904.17" does. Beyond 2^53 millionths a float
    // rounds, which four figures never show.
    const text = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currency,
      notation: "compact",
      maximumSignificantDigits: 4,
    }).format(Number(value.minor6) / 1e6);
    return lead + text;
  }
  const units = (abs + step / 2n) / step;
  return lead + (negative ? "-" : "") + exactCurrency(units, digits, value.currency, locale);
}

/**
 * `units` of the currency's smallest unit, written by Intl exactly: the whole
 * part is formatted as an integer (bigint, so nothing rounds) and its decimal
 * places are put in from the integer.
 */
function exactCurrency(units: bigint, digits: number, currency: string, locale: string): string {
  const scale = 10n ** BigInt(digits);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(digits, "0");
  // The decimal places pinned to `digits`, so Intl's own count for the
  // currency (which varies between browsers) never leaves a stray mark.
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).formatToParts(whole);
  return parts.map((part) => (part.type === "fraction" ? fraction : part.value)).join("");
}

/**
 * An amount as a field holds it: every digit, the locale's decimal mark, no
 * grouping, trailing zeros dropped. "Use all" and a plan's prefill write
 * this, so the field reads back as exactly the amount written.
 */
export function formatAmountForField(value: bigint, decimals: number, locale: string): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  const fraction = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = fraction === "" ? whole : `${whole}${decimalMark(locale)}${fraction}`;
  return negative ? `-${text}` : text;
}

/** A count grouped in the page's number format: "1,000", "1.000", "1 000". */
export function formatCount(count: number | bigint, locale: string = displayLocale()): string {
  return count.toLocaleString(locale);
}

/**
 * A number that isn't a count or an amount (a percentage, minutes, a
 * multiple) in the page's number format, with the caller's decimal places:
 * "0.5", "0,5". Never for a token amount, which is exact (tokens.ts), nor
 * money, which is `formatFiat`.
 */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, locale: string = displayLocale()): string {
  return value.toLocaleString(locale, options);
}

/**
 * Whole basis points as a percentage, without the sign, in the page's number
 * format: 69 → "0.69" ("0,69" in German), 110 → "1.1", 100 → "1". Exact:
 * whole basis points have at most two decimals, so none is rounded. For
 * copy a person reads; `@spdex/vault`'s `feeShareText` is the same figure
 * with "." always.
 */
export function bpsPercentText(bps: number, locale: string = displayLocale()): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new RangeError("a share is a whole, non-negative number of basis points");
  return formatNumber(bps / 100, { maximumFractionDigits: 2 }, locale);
}

// ── When ──────────────────────────────────────────────────────────────────

/**
 * The wall-clock time of a `performance.now()` stamp, for saying when a rate
 * was read. Stamps are what the money layer keeps, since the device's clock
 * can be changed under it; the page's time origin turns one into a time of
 * day only for showing it.
 */
export function wallClockOf(stamp: number): number {
  return (typeof performance === "undefined" ? 0 : performance.timeOrigin) + stamp;
}

/** "14:02", in this device's time zone. */
export function clockText(wallMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(wallMs));
}

/**
 * "Sep 12", from unix seconds, in this device's time zone. In English, like
 * the sentence it sits in ("EUR rate unavailable (last update Sep 12)"): the
 * browser's language would put "12. Sept." or "9월 12일" mid-sentence.
 */
export function dayText(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(unixSeconds * 1000));
}

/** "Fri 17:00", from unix seconds: when a currency rate last updated, which is often before a weekend. In English, as `dayText`. */
export function weekdayClockText(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(unixSeconds * 1000),
  );
}

