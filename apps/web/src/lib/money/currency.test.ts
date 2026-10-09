/**
 * Which currency a browser starts in, and the facts each currency is written
 * with.
 */

import { describe, expect, it } from "vitest";
import {
  CURRENCY_NAMES,
  currencyPhrase,
  currencySigns,
  currencySymbol,
  defaultCurrency,
  isCurrencyCode,
  numberLocale,
  currencyDigits,
  numberStyleLabel,
  symbolLeads,
} from "./currency.js";
import { CURRENCY_CODES, NUMBER_STYLES } from "./pricing.js";

describe("defaultCurrency", () => {
  it("takes the first tag that names a region", () => {
    expect(defaultCurrency(["en-US"])).toBe("USD");
    expect(defaultCurrency(["es-AR"])).toBe("ARS");
    expect(defaultCurrency(["de", "de-DE"])).toBe("EUR");
    expect(defaultCurrency(["fr-CH", "fr-FR"])).toBe("CHF");
    expect(defaultCurrency(["en-GB"])).toBe("GBP");
    expect(defaultCurrency(["zh-Hans-CN"])).toBe("CNY");
    expect(defaultCurrency(["pt-BR"])).toBe("BRL");
  });

  it("never guesses a region from a bare language", () => {
    // Intl would maximize "es" to Spain and "pt" to Brazil.
    expect(defaultCurrency(["es"])).toBe("USD");
    expect(defaultCurrency(["pt"])).toBe("USD");
    expect(defaultCurrency([])).toBe("USD");
  });

  it("starts in dollars where the region's money isn't one of the 17", () => {
    expect(defaultCurrency(["hi-IN"])).toBe("USD");
    expect(defaultCurrency(["sv-SE"])).toBe("USD");
  });

  it("covers the euro area and Liechtenstein", () => {
    for (const region of ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"]) {
      expect(defaultCurrency([`en-${region}`]), region).toBe("EUR");
    }
    expect(defaultCurrency(["de-LI"])).toBe("CHF");
  });

  it("skips a malformed tag rather than failing", () => {
    expect(defaultCurrency(["not a tag", "ja-JP"])).toBe("JPY");
  });
});

describe("currency facts", () => {
  it("names all 17, and knows a code when it sees one", () => {
    expect(Object.keys(CURRENCY_NAMES).sort()).toEqual([...CURRENCY_CODES].sort());
    expect(isCurrencyCode("EUR")).toBe(true);
    expect(isCurrencyCode("INR")).toBe(false);
    expect(isCurrencyCode(undefined)).toBe(false);
  });

  it("writes signs as the locale does", () => {
    expect(currencySymbol("USD", "en-US")).toBe("$");
    expect(currencySymbol("ARS", "es-AR")).toBe("$");
    expect(currencySymbol("CAD", "en-US")).not.toBe("$");
    expect(currencySigns("EUR", "de-DE")).toEqual(expect.arrayContaining(["€", "EUR"]));
  });

  it("knows where the sign goes", () => {
    expect(symbolLeads("USD", "en-US")).toBe(true);
    expect(symbolLeads("EUR", "de-DE")).toBe(false);
  });

  it("phrases a currency for a sentence, leaving out a sign that is only the code", () => {
    expect(currencyPhrase("EUR", "en-US")).toBe("euros (€)");
    expect(currencyPhrase("CHF", "en-US")).toBe("Swiss francs");
  });
});

describe("number styles", () => {
  it("each style is its own locale; automatic is the browser's", () => {
    expect(numberLocale("de-DE")).toBe("de-DE");
    expect(numberLocale("auto")).toBe(Intl.NumberFormat().resolvedOptions().locale);
  });

  it("automatic writes 0 to 9 even where the browser writes its own digits, so amounts never mix scripts", () => {
    for (const [locale, numberingSystem] of [["ar-EG", "arab"], ["fa-IR", "arabext"], ["bn-BD", "beng"]] as const) {
      const tag = numberLocale("auto", () => ({ locale, numberingSystem }));
      expect(tag).toBe(`${locale}-u-nu-latn`);
      expect(new Intl.NumberFormat(tag, { minimumFractionDigits: 2 }).format(1234.5)).toMatch(/^[\d.,\u00a0\u202f\u066b\u066c\u200f\u200e ]+$/);
      expect(new Intl.NumberFormat(tag).format(20)).toBe("20");
    }
    expect(numberLocale("auto", () => ({ locale: "de-DE", numberingSystem: "latn" }))).toBe("de-DE");
  });

  it("pins decimal places rather than take each browser's ICU: none for the yen, won and rupiah", () => {
    expect(["JPY", "KRW", "IDR"].map((code) => currencyDigits(code as "JPY"))).toEqual([0, 0, 0]);
    expect(currencyDigits("USD")).toBe(2);
    expect(currencyDigits("EUR")).toBe(2);
  });

  it("labels each style by how it writes a number", () => {
    const d = (locale: string) => new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")!.value;
    expect(numberStyleLabel("en-US")).toBe("1,234.56");
    expect(numberStyleLabel("de-DE")).toBe("1.234,56");
    expect(numberStyleLabel("en-IN")).toBe("1,23,456.78");
    expect(numberStyleLabel("fr-FR")).toContain(`234${d("fr-FR")}56`);
    expect(numberStyleLabel("auto")).toMatch(/^Automatic \(/);
    expect(NUMBER_STYLES.map(numberStyleLabel)).toHaveLength(6);
  });
});
