/**
 * Facts about the 17 currencies and the number formats: names, symbols, how
 * many decimal places each has, which one a browser starts in, and which
 * locale writes numbers in each style.
 *
 * Symbols come from Intl, never from a table here, so they are the ones the
 * person's own browser writes: "$" is the Argentine peso's own sign in es-AR.
 * Decimal places are the one table (`CURRENCY_DIGITS`): browsers ship
 * different ICU data, and Chromium writes the rupiah with two decimal places
 * where Node writes none, so reading them from Intl gave a field that
 * accepts cents in one browser and refuses them in another.
 * Nothing here reads storage or the network.
 */

import { CURRENCY_CODES, type CurrencyCode, type NumberStyle } from "./pricing.js";

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCY_CODES as readonly string[]).includes(value);
}

/**
 * What a sentence calls each currency: "Too many decimal places for euros".
 * Plural and in lower case where English writes them so, for the sentences
 * they finish.
 */
export const CURRENCY_NAMES: Readonly<Record<CurrencyCode, string>> = {
  USD: "US dollars",
  EUR: "euros",
  GBP: "British pounds",
  JPY: "Japanese yen",
  KRW: "South Korean won",
  CNY: "Chinese yuan",
  CHF: "Swiss francs",
  CAD: "Canadian dollars",
  AUD: "Australian dollars",
  SGD: "Singapore dollars",
  NZD: "New Zealand dollars",
  BRL: "Brazilian reais",
  MXN: "Mexican pesos",
  TRY: "Turkish lira",
  IDR: "Indonesian rupiah",
  ARS: "Argentine pesos",
  PHP: "Philippine pesos",
};

/**
 * Six currencies people ask for that aren't offered. Reading a rate for them
 * from anywhere but a feed on Ethereum would mean asking a third party, and
 * every request goes to the person's own service. The amount field's unit
 * menu lists them as a disabled "No rate" group.
 */
export const MISSING_CURRENCY_CODES: readonly string[] = ["INR", "HKD", "SEK", "NOK", "PLN", "ZAR"];

/**
 * Why they aren't offered, for the ⓘ that explains where rates come from
 * (the amount field's "sources", and the currency setting's label).
 */
export const MISSING_CURRENCIES_HINT =
  "INR, HKD, SEK, NOK, PLN and ZAR aren't offered: no rate for them on Ethereum can be read without asking a third party.";

/**
 * Decimal places each currency is typed and written with: none for the yen,
 * the won and the rupiah, whose smallest coins nobody pays in (Chromium's ICU
 * gives the rupiah two, Node's none), and two for every other.
 */
export const CURRENCY_DIGITS: Readonly<Record<CurrencyCode, number>> = Object.fromEntries(
  CURRENCY_CODES.map((code) => [code, code === "JPY" || code === "KRW" || code === "IDR" ? 0 : 2]),
) as Record<CurrencyCode, number>;

function currencyFormat(code: CurrencyCode, locale: string, display: "symbol" | "narrowSymbol" = "symbol") {
  const digits = CURRENCY_DIGITS[code];
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    currencyDisplay: display,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * The sign `locale` writes for `code`: "$", "€", "CA$" in en-US but "$" in
 * en-CA. Where the locale has no sign of its own it is the code ("CHF").
 */
export function currencySymbol(code: CurrencyCode, locale: string): string {
  return currencyFormat(code, locale).formatToParts(1).find((p) => p.type === "currency")?.value ?? code;
}

function narrowSign(code: CurrencyCode, locale: string): string | undefined {
  return currencyFormat(code, locale, "narrowSymbol").formatToParts(1).find((p) => p.type === "currency")?.value;
}

/**
 * How people write some currencies beside a number that no Intl symbol
 * gives: the won's, yen's and yuan's own words ("10000원", "500円") and the
 * dollar's code form ("US$5").
 */
const CURRENCY_WORDS: Readonly<Partial<Record<CurrencyCode, readonly string[]>>> = {
  USD: ["US$"],
  KRW: ["원"],
  JPY: ["円"],
  CNY: ["元"],
};

/**
 * Every way `code` may be written beside a number in its own field: its sign
 * as this locale writes it, the code itself, its own word (`CURRENCY_WORDS`),
 * a short sign that no other of the 17 shares ("€" in a Swiss format, which
 * writes euros as "EUR"), and its short sign where that is no other
 * currency's sign in this locale ("$" in a dollar field in French, which
 * writes dollars "$US").
 *
 * A short sign this locale writes for another currency never counts: "$20"
 * is 20 pesos in es-AR, but refused in a peso field in en-US, where "$"
 * means dollars and the field says "ARS", and refused in a dollar field in
 * es-AR, where it means pesos. Reading one as the other is a thousandfold
 * mistake.
 */
export function currencySigns(code: CurrencyCode, locale: string): string[] {
  // Asked on every keystroke in a money field, and fixed for a code and locale.
  const key = `${code} ${locale}`;
  const known = SIGNS.get(key);
  if (known !== undefined) return known;
  const unshared = (loc: string): string[] => {
    const sign = narrowSign(code, loc);
    if (sign === undefined) return [];
    return CURRENCY_CODES.some((other) => other !== code && narrowSign(other, loc) === sign) ? [] : [sign];
  };
  const own = narrowSign(code, locale);
  const ownHere =
    own === undefined || CURRENCY_CODES.some((other) => other !== code && currencySymbol(other, locale) === own) ? [] : [own];
  const signs = [
    ...new Set([currencySymbol(code, locale), code, ...(CURRENCY_WORDS[code] ?? []), ...unshared(locale), ...unshared("en"), ...ownHere]),
  ];
  SIGNS.set(key, signs);
  return signs;
}

const SIGNS = new Map<string, string[]>();

/** Decimal places `code` is written with: 2 for most, 0 for the yen, won and rupiah (`CURRENCY_DIGITS`). */
export function currencyDigits(code: CurrencyCode): number {
  return CURRENCY_DIGITS[code];
}

/** Whether `locale` writes this currency's sign before the number ("$20") rather than after ("20 €"). */
export function symbolLeads(code: CurrencyCode, locale: string): boolean {
  const parts = currencyFormat(code, locale).formatToParts(20);
  const sign = parts.findIndex((p) => p.type === "currency");
  const number = parts.findIndex((p) => p.type === "integer");
  return sign !== -1 && sign < number;
}

/** "EUR €" as a unit menu names it, or "CHF" where the locale's sign is the code itself. */
export function currencyUnitText(code: CurrencyCode, locale: string): string {
  const symbol = currencySymbol(code, locale);
  return symbol === code ? code : `${code} ${symbol}`;
}

/** "euros (€)", or "Swiss francs" where the sign is only the code. */
export function currencyPhrase(code: CurrencyCode, locale: string): string {
  const symbol = currencySymbol(code, locale);
  return symbol === code ? CURRENCY_NAMES[code] : `${CURRENCY_NAMES[code]} (${symbol})`;
}

/**
 * Where each region's money is one of the 17. The euro area is listed by
 * country; anything not here starts in US dollars.
 */
const REGION_CURRENCY: Readonly<Record<string, CurrencyCode>> = {
  US: "USD",
  ...Object.fromEntries(
    ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"].map(
      (region) => [region, "EUR" as const],
    ),
  ),
  GB: "GBP",
  JP: "JPY",
  KR: "KRW",
  CN: "CNY",
  CH: "CHF",
  LI: "CHF",
  CA: "CAD",
  AU: "AUD",
  SG: "SGD",
  NZ: "NZD",
  BR: "BRL",
  MX: "MXN",
  TR: "TRY",
  ID: "IDR",
  AR: "ARS",
  PH: "PHP",
};

/**
 * The currency a browser starts in: the region named by the first language
 * tag that names one, or US dollars.
 *
 * Only a region the tag spells out counts. "es" names no country, and
 * guessing one (Spain, by Intl's `maximize`) would start half the Americas
 * in euros. Nothing is revealed by this: the rate read is the same request
 * whatever the currency (packages/chain/src/fx.ts).
 */
export function defaultCurrency(languages: readonly string[]): CurrencyCode {
  for (const tag of languages) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(tag).region;
    } catch {
      continue;
    }
    if (region !== undefined) return REGION_CURRENCY[region.toUpperCase()] ?? "USD";
  }
  return "USD";
}

/** The browser's language tags, or none where there is no navigator. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/**
 * The locale that writes numbers in `style`; "auto" is whatever this browser
 * uses, with the digits 0 to 9. A browser in Arabic, Persian, Bengali or
 * Marathi writes its own digits by default, and spDEX splices exact decimal
 * places into what Intl writes, so its amounts would mix two scripts; the
 * marks and grouping stay the browser's.
 */
export function numberLocale(
  style: NumberStyle,
  browser: () => Pick<Intl.ResolvedNumberFormatOptions, "locale" | "numberingSystem"> = () => Intl.NumberFormat().resolvedOptions(),
): string {
  if (style !== "auto") return style;
  try {
    const resolved = browser();
    if (resolved.numberingSystem === "latn") return resolved.locale;
    return new Intl.Locale(resolved.locale, { numberingSystem: "latn" }).toString();
  } catch {
    return "en-US";
  }
}

/** How each style writes one thousand two hundred and thirty-four and a bit, for the style menu. */
export function numberStyleLabel(style: NumberStyle): string {
  const sample = (locale: string) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(style === "en-IN" ? 123456.78 : 1234.56);
  return style === "auto" ? `Automatic (${sample(numberLocale("auto"))})` : sample(style);
}
