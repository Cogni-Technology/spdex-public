/**
 * Reading typed amounts, and the round trip with the formatter.
 *
 * The round-trip cases came from tokens.test.ts with the parser they tested.
 * "use all" writes `formatAmountExact` into the field and the quote reads it
 * back, so any disagreement between the two is someone staring at their whole
 * balance in a field the app says is empty. That shipped once, for every
 * balance of four figures or more.
 *
 * The table of hostile input is parse.adversarial.test.ts; this file pins
 * the rules one at a time.
 */

import { describe, expect, it } from "vitest";
import { formatAmount, formatAmountExact, TOKEN_LIST } from "../tokens.js";
import { APP_NUMBER_LOCALE, parseDecimal } from "./parse.js";

const US = "en-US";

function value(text: string, decimals: number, locale = US): bigint {
  const parsed = parseDecimal(text, locale, decimals);
  if (!parsed.ok) throw new Error(`"${text}" was refused: ${parsed.error}`);
  return parsed.value;
}

describe("parseDecimal", () => {
  it("reads whole and fractional amounts exactly, without floating point", () => {
    expect(value("1", 18)).toBe(10n ** 18n);
    expect(value("0.5", 18)).toBe(5n * 10n ** 17n);
    expect(value("1.23456789", 8)).toBe(123456789n);
    expect(value("0.1", 18)).toBe(10n ** 17n);
  });

  it("refuses more decimal places than the field holds rather than cutting them off", () => {
    // Truncating was the old behaviour: 1.999999999 SPX quietly became
    // 1.99999999. Refuse, never clamp.
    expect(parseDecimal("1.999999999", US, 8, { symbol: "SPX" })).toEqual({
      ok: false,
      error: "Too many decimal places for SPX (at most 8).",
    });
    expect(parseDecimal("1.5", US, 0)).toEqual({ ok: false, error: "Type a whole number." });
  });

  it("does not count trailing zeros as decimal places", () => {
    expect(value("1.500000000", 8)).toBe(150_000_000n);
  });

  it("reads an empty field as zero, which every caller refuses in its own words", () => {
    expect(value("", 18)).toBe(0n);
    expect(value("   ", 18)).toBe(0n);
  });

  it("still reads a grouped amount that has only one meaning", () => {
    expect(value("1,234,567.5", 8)).toBe(123_456_750_000_000n);
    expect(value("10,000.5", 18)).toBe(10_000_500_000_000_000_000_000n);
    expect(value("1,000,000", 6)).toBe(10n ** 12n);
  });

  it("reads 0.001 as itself: no grouped number starts with 0", () => {
    expect(value("0.001", 18)).toBe(10n ** 15n);
    expect(value("0.500", 18)).toBe(5n * 10n ** 17n);
  });

  it("offers a reading with three decimal places left as four, which no format reads as a thousand", () => {
    const parsed = parseDecimal("1,234", US, 18);
    expect(parsed).toMatchObject({ ok: false, choices: ["1234", "1.2340"] });
    for (const choice of (parsed.ok ? [] : parsed.choices) ?? []) expect(parseDecimal(choice, US, 18).ok).toBe(true);
  });

  it("offers only the readings the field could hold", () => {
    expect(parseDecimal("1,234", US, 2)).toEqual({
      ok: false,
      error: "Did you mean 1234? Type it without a thousands separator.",
      choices: ["1234"],
    });
  });

  it("in a field of whole numbers, reads the format's own group mark as grouping, and offers only the whole reading for the other", () => {
    // Nobody writes ten won as "10.000", so "10,000" in a won field is ten thousand.
    expect(parseDecimal("1,500", US, 0)).toEqual({ ok: true, value: 1500n });
    expect(parseDecimal("10,000", "ko-KR", 0, { unit: "KRW" })).toEqual({ ok: true, value: 10_000n });
    expect(parseDecimal("100.000", "id-ID", 0, { unit: "IDR" })).toEqual({ ok: true, value: 100_000n });
    expect(parseDecimal("1.500", US, 0)).toEqual({
      ok: false,
      error: "Did you mean 1500? Type it without a thousands separator.",
      choices: ["1500"],
    });
  });

  it("never offers a fix the field would refuse", () => {
    // Read the other way this is 0.0000000001, past SPX's eight places, so
    // "Type 0.0000000001" would only be refused next.
    expect(parseDecimal("0,0000000001", US, 8, { symbol: "SPX" })).toEqual({
      ok: false,
      error: "Too many decimal places for SPX (at most 8).",
    });
  });

  it("accepts the field's own token beside the number, and nothing else", () => {
    const eth = { symbol: "ETH" };
    expect(parseDecimal("0.5 ETH", US, 18, eth)).toEqual({ ok: true, value: 5n * 10n ** 17n });
    expect(parseDecimal("eth 0.5", US, 18, eth)).toEqual({ ok: true, value: 5n * 10n ** 17n });
    expect(parseDecimal("0.5 WETH", US, 18, eth)).toEqual({
      ok: false,
      error: "This field is in ETH. Type the number only.",
    });
    expect(parseDecimal("0.5 SPX", US, 18, eth)).toMatchObject({ ok: false });
    expect(parseDecimal("$20", US, 18)).toEqual({ ok: false, error: "Type the number only." });
  });

  it("gives an ungrouped fix for grouping this format doesn't use, and none for groups that aren't", () => {
    expect(parseDecimal("12 345", US, 18)).toMatchObject({ ok: false, fix: "12345" });
    expect(parseDecimal("1,50,5", US, 18)).toEqual({ ok: false, error: "Type a number, like 0.5." });
    expect(parseDecimal("1 500,000", US, 18)).toEqual({ ok: false, error: "Type a number, like 0.5." });
  });

  it("refuses two decimal marks, a lone mark and anything that isn't a number", () => {
    for (const text of ["1.2.3", ".", ",", "abc", "1_000", "+5", "1..5", "0.5\t1"]) {
      expect(parseDecimal(text, US, 18)).toEqual({ ok: false, error: "Type a number, like 0.5." });
    }
  });

  it("takes each format's marks from Intl", () => {
    // Beyond en-US these rows are A2's; here they show the marks aren't
    // written into the parser.
    expect(value("1,5", 18, "de-DE")).toBe(15n * 10n ** 17n);
    expect(parseDecimal("1.5", "de-DE", 18)).toMatchObject({ ok: false, fix: "1,5" });
    expect(value("1 500", 18, "fr-FR")).toBe(1500n * 10n ** 18n);
    expect(value("1,00,000.5", 18, "en-IN")).toBe(100_000_500_000_000_000_000_000n);
  });

  it("is the one format the app reads in until A2", () => {
    expect(APP_NUMBER_LOCALE).toBe("en-US");
  });
});

describe("round trip with the formatter", () => {
  it("reads back what 'use all' writes, at full precision", () => {
    // Four figures and a dust tail past the display cutoff of 6.
    const balance = 12_345n * 10n ** 18n + 123_456_789_012_345_678n;
    const text = formatAmountExact(balance, 18);
    expect(text).not.toContain(",");
    expect(value(text, 18)).toBe(balance);
  });

  it("reads back every token in the shipped list", () => {
    for (const token of TOKEN_LIST) {
      const balance = 98_765n * 10n ** BigInt(token.decimals) + 1n;
      expect(value(formatAmountExact(balance, token.decimals), token.decimals)).toBe(balance);
    }
  });

  it("reads back many balances, of every size, for every token", () => {
    // A fixed-seed generator, so a failure names the same balance every run.
    let seed = 0x5eed_5eedn;
    const next = () => (seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n);
    for (const token of TOKEN_LIST) {
      for (let i = 0; i < 500; i += 1) {
        const balance = (next() << 64n) | next();
        const shifted = balance >> BigInt(i % 120);
        expect(value(formatAmountExact(shifted, token.decimals), token.decimals)).toBe(shifted);
      }
    }
  });

  it("reads back a grouped balance pasted from the display, as displayed", () => {
    // The display keeps six places; the paste means what it shows.
    const balance = 10_000n * 10n ** 18n + 5n * 10n ** 17n;
    expect(formatAmount(balance, 18)).toBe("10,000.5");
    expect(value(formatAmount(balance, 18), 18)).toBe(balance);
  });
});
