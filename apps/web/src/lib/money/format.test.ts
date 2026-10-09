/**
 * Money and amounts written for people, and amounts written back into fields.
 *
 * Expected strings are built from Intl in this process where the ICU data
 * decides them (a group mark, a currency's decimal places), so the tests pin
 * the rules rather than one ICU build's spelling.
 */

import { afterEach, describe, expect, it } from "vitest";
import { formatAmount, formatAmountExact } from "../tokens.js";
import { formatSignificant } from "../dca/format.js";
import { currencyDigits } from "./currency.js";
import {
  decimalMark,
  displayLocale,
  formatAmountForField,
  formatCount,
  formatFiat,
  setDisplayLocale,
} from "./format.js";
import { parseDecimal } from "./parse.js";
import { CURRENCY_CODES } from "./pricing.js";

afterEach(() => setDisplayLocale("en-US"));

const usd = (minor6: bigint) => ({ minor6, currency: "USD" as const });

describe("formatFiat", () => {
  it("writes each currency with its own decimal places, from Intl", () => {
    expect(formatFiat(usd(20_000_000n), "en-US")).toBe("$20.00");
    expect(formatFiat({ minor6: 18_400_000n, currency: "EUR" }, "en-US")).toBe("€18.40");
    for (const code of ["JPY", "KRW", "IDR"] as const) {
      const digits = currencyDigits(code);
      const text = formatFiat({ minor6: 2_940_000_000n, currency: code }, "en-US");
      expect(text.includes(".")).toBe(digits > 0);
      expect(text).toContain("2,940");
    }
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("KRW")).toBe(0);
  });

  it("follows the number format, sign placement included", () => {
    const eur = { minor6: 1_234_560_000n, currency: "EUR" as const };
    expect(formatFiat(eur, "de-DE")).toBe(new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1234.56));
    expect(formatFiat(usd(1_234_560_000n), "en-IN")).toBe("$1,234.56");
  });

  it("is exact for figures no float can hold", () => {
    // $90,071,992,547,409.93: past 2^53 millionths, and still to the cent.
    expect(formatFiat(usd(90_071_992_547_409_930_000n), "en-US")).toBe("$90,071,992,547,409.93");
  });

  it("rounds half up to the currency's smallest unit", () => {
    expect(formatFiat(usd(5_000n), "en-US")).toBe("$0.01");
    expect(formatFiat(usd(20_004_999n), "en-US")).toBe("$20.00");
    expect(formatFiat(usd(20_005_000n), "en-US")).toBe("$20.01");
  });

  it("writes a real amount too small to show as below the smallest unit, never zero", () => {
    expect(formatFiat(usd(4_999n), "en-US")).toBe("< $0.01");
    expect(formatFiat(usd(1n), "en-US", { approx: true })).toBe("< $0.01");
    expect(formatFiat({ minor6: 499_999n, currency: "JPY" }, "en-US")).toBe("< ¥1");
    expect(formatFiat(usd(0n), "en-US")).toBe("$0.00");
  });

  it("leads with ≈ joined by a no-break space", () => {
    expect(formatFiat(usd(26_000_000n), "en-US", { approx: true })).toBe("≈ $26.00");
  });

  it("writes compact figures for tables, to four figures", () => {
    expect(formatFiat(usd(12_261_904_170_000n), "en-US", { compact: true })).toBe("$12.26M");
    expect(formatFiat(usd(192_600_000_000n), "en-US", { compact: true })).toBe("$192.6K");
    expect(formatFiat(usd(12_340_000n), "en-US", { compact: true })).toBe("$12.34");
  });

  it("writes every one of the 17 currencies", () => {
    for (const currency of CURRENCY_CODES) {
      expect(formatFiat({ minor6: 1_000_000n, currency }, "en-US")).toMatch(/1/);
    }
  });
});

describe("amounts in fields", () => {
  it("writes the locale's decimal mark and no grouping, and reads back exactly", () => {
    for (const locale of ["en-US", "de-DE", "fr-FR", "de-CH", "en-IN"]) {
      for (const [value, decimals] of [
        [10_000_500_000_000_000_000_000n, 18],
        [123_456_789n, 8],
        [1n, 18],
        [0n, 6],
      ] as const) {
        const text = formatAmountForField(value, decimals, locale);
        expect(text).not.toMatch(/[\s'’]/);
        const parsed = parseDecimal(text, locale, decimals);
        expect(parsed, `${locale} ${text}`).toEqual({ ok: true, value });
      }
    }
    expect(formatAmountForField(5n * 10n ** 17n, 18, "de-DE")).toBe("0,5");
  });

});

describe("the display locale", () => {
  it("is en-US until set, so tests and anything outside the page keep one format", () => {
    expect(displayLocale()).toBe("en-US");
    expect(formatAmount(10_000_500_000_000_000_000_000n, 18)).toBe("10,000.5");
  });

  it("changes grouping and the decimal mark of every token figure", () => {
    setDisplayLocale("de-DE");
    expect(formatAmount(10_000_500_000_000_000_000_000n, 18)).toBe("10.000,5");
    expect(formatSignificant(1_234_567n * 10n ** 15n, 18, 6)).toBe("1.234,57");
    expect(formatCount(1_000)).toBe("1.000");
    expect(decimalMark(displayLocale())).toBe(",");
  });

  it("never changes the machine format tip flows compare with a wallet's", () => {
    setDisplayLocale("de-DE");
    expect(formatAmountExact(10_000_500_000_000_000_000_000n, 18)).toBe("10000.5");
  });

  it("ignores a tag Intl doesn't know", () => {
    setDisplayLocale("not a locale!");
    expect(displayLocale()).toBe("en-US");
  });
});
