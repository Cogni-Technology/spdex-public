/**
 * Hostile and careless input, row by row, against the parsing rules in
 * docs/ARCHITECTURE.md ("Money", Parsing): in the five number formats the app
 * offers (en-US, de-DE, fr-FR, de-CH, en-IN), and in a field typed in money
 * as well as one typed in a token.
 *
 * Every row ends in the exact amount or a named refusal with its way out.
 * None may end in a different amount than the person meant, which is how
 * "0,5" used to quote five ether.
 *
 * The expected marks come from Intl in this process, not from the page:
 * unit tests run on Node's ICU, and a row that hard-coded a mark would pass
 * or fail on the build of ICU rather than on the parser.
 */

import { describe, expect, it } from "vitest";
import { currencyPhrase } from "./currency.js";
import { parseDecimal, type ParsedDecimal } from "./parse.js";

const LOCALE = "en-US";
const parts = new Intl.NumberFormat(LOCALE).formatToParts(1234567.8);
const D = parts.find((p) => p.type === "decimal")!.value;
const G = parts.find((p) => p.type === "group")!.value;

const ETH = { decimals: 18, symbol: "ETH" };
const SPX = { decimals: 8, symbol: "SPX" };

/** `whole` and `fraction` digits as base units of `decimals`. */
function units(whole: string, fraction: string, decimals: number): ParsedDecimal {
  return { ok: true, value: BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0") };
}

const wrongMark = (fix: string): ParsedDecimal => ({
  ok: false,
  error: `In your number format the decimal mark is "${D}". Type ${fix}.`,
  fix,
});
const ambiguous = (asGroup: string, asDecimal: string): ParsedDecimal => ({
  ok: false,
  error: `Is that ${asGroup} or ${asDecimal}? Type it without a thousands separator.`,
  choices: [asGroup, asDecimal],
});
const ungrouped = (fix: string): ParsedDecimal => ({
  ok: false,
  error: `Type it without thousands separators: ${fix}.`,
  fix,
});
const refused = (error: string): ParsedDecimal => ({ ok: false, error });

const ROWS: readonly { input: string; field: { decimals: number; symbol: string }; expected: ParsedDecimal }[] = [
  // A comma-decimal keypad: refused, never read as 15.
  { input: "1,5", field: ETH, expected: wrongMark(`1${D}5`) },
  { input: "1.5", field: ETH, expected: units("1", "5", 18) },
  // A thousand and five hundred, or one and a half: never guessed.
  { input: "1.500", field: ETH, expected: ambiguous("1500", `1${D}5`) },
  { input: "1,500", field: ETH, expected: ambiguous("1500", `1${D}5`) },
  // Space groups, as typed (U+0020) and as a French format writes them (U+202F, U+00A0).
  { input: "1 500", field: ETH, expected: ungrouped("1500") },
  { input: "1 500", field: ETH, expected: ungrouped("1500") },
  { input: "1 500", field: ETH, expected: ungrouped("1500") },
  // Swiss groups, as a keyboard types them and as the format shows them.
  { input: "1'500.5", field: ETH, expected: ungrouped(`1500${D}5`) },
  { input: "1’500.5", field: ETH, expected: ungrouped(`1500${D}5`) },
  // Indian grouping, where this format groups in threes.
  { input: `1${G}00${G}000${D}5`, field: ETH, expected: ungrouped(`100000${D}5`) },
  // Pasted from a displayed balance: one meaning, so accepted.
  { input: `10${G}000${D}5`, field: ETH, expected: units("10000", "5", 18) },
  // Past SPX's eight places either way it is read.
  { input: "0,0000000001", field: SPX, expected: refused("Too many decimal places for SPX (at most 8).") },
  { input: `0${D}0000000001`, field: SPX, expected: refused("Too many decimal places for SPX (at most 8).") },
  // A Japanese IME's full-width digits.
  { input: "１２", field: ETH, expected: units("12", "", 18) },
  { input: "1e3", field: ETH, expected: refused('Type the number out in full, without "e".') },
  { input: "-1", field: ETH, expected: refused("An amount can't be negative.") },
  { input: "−1", field: ETH, expected: refused("An amount can't be negative.") },
  { input: "0x10", field: ETH, expected: refused("Type the amount as an ordinary number, not a 0x one.") },
  { input: `${D}5`, field: ETH, expected: units("0", "5", 18) },
  { input: `5${D}`, field: ETH, expected: units("5", "", 18) },
  // A currency in a token field: never converted, whatever "$" was meant to be.
  { input: "$20", field: ETH, expected: refused("This field is in ETH. Type the number only.") },
  { input: "20 €", field: ETH, expected: refused("This field is in ETH. Type the number only.") },
  { input: "20,00 €", field: ETH, expected: refused("This field is in ETH. Type the number only.") },
  { input: "EUR 20", field: ETH, expected: refused("This field is in ETH. Type the number only.") },
];

describe(`parseDecimal, ${LOCALE}: the adversarial table`, () => {
  it("runs on a format whose marks are the ones the inputs are written for", () => {
    // The literal inputs above ("1,5", "1.500") assume these two marks.
    expect([D, G]).toEqual([".", ","]);
  });

  for (const { input, field, expected } of ROWS) {
    it(`${JSON.stringify(input)} in an ${field.symbol} field`, () => {
      expect(parseDecimal(input, LOCALE, field.decimals, { symbol: field.symbol })).toEqual(expected);
    });
  }

  it("types an accepted amount for every choice and fix it offers", () => {
    for (const { input, field } of ROWS) {
      const parsed = parseDecimal(input, LOCALE, field.decimals, { symbol: field.symbol });
      if (parsed.ok) continue;
      for (const offered of [...(parsed.choices ?? []), ...(parsed.fix === undefined ? [] : [parsed.fix])]) {
        expect(parseDecimal(offered, LOCALE, field.decimals).ok, `${input} → ${offered}`).toBe(true);
      }
    }
  });
});

describe(`parseDecimal, ${LOCALE}: the exact sentences`, () => {
  it('says what to type for "0,5", and never reads it as 5', () => {
    expect(parseDecimal("0,5", LOCALE, 18)).toEqual({
      ok: false,
      error: 'In your number format the decimal mark is ".". Type 0.5.',
      fix: "0.5",
    });
  });

  it('asks which of two readings "1,500" and "1.500" mean', () => {
    for (const input of ["1,500", "1.500"]) {
      expect(parseDecimal(input, LOCALE, 18)).toMatchObject({
        ok: false,
        error: "Is that 1500 or 1.5? Type it without a thousands separator.",
      });
    }
  });

  it('accepts "10,000.5" pasted from a displayed balance, as before', () => {
    expect(parseDecimal("10,000.5", LOCALE, 18)).toEqual({ ok: true, value: 10_000_500_000_000_000_000_000n });
  });
});

// ── The other formats ─────────────────────────────────────────────────────

/** A format's marks as the parser compares them: no-break spaces are the space a keyboard types, ’ is '. */
function marksOf(locale: string): { d: string; g: string; other: string } {
  const p = new Intl.NumberFormat(locale).formatToParts(1234567.8);
  const d = p.find((x) => x.type === "decimal")!.value;
  const g = p.find((x) => x.type === "group")!.value.normalize("NFKC").replace(/’/g, "'");
  return { d, g, other: d === "." ? "," : "." };
}

/**
 * The rows every format shares, written in that format's own marks: its
 * decimal mark reads, the other one is refused with a fix, "1,500" and
 * "1.500" are refused everywhere with both readings, and a grouped paste in
 * the format's own groups reads.
 */
function formatRows(locale: string): { input: string; decimals: number; expected: ParsedDecimal }[] {
  const { d, g, other } = marksOf(locale);
  const grouped = locale === "en-IN" ? `1${g}00${g}000${d}5` : `100${g}000${d}5`;
  return [
    { input: `1${d}5`, decimals: 18, expected: units("1", "5", 18) },
    {
      input: `1${other}5`,
      decimals: 18,
      expected: { ok: false, error: `In your number format the decimal mark is "${d}". Type 1${d}5.`, fix: `1${d}5` },
    },
    ...["1.500", "1,500"].map((input) => ({
      input,
      decimals: 18,
      expected: {
        ok: false as const,
        error: `Is that 1500 or 1${d}5? Type it without a thousands separator.`,
        choices: ["1500", `1${d}5`],
      },
    })),
    { input: grouped, decimals: 18, expected: units("100000", "5", 18) },
    { input: `${d}5`, decimals: 18, expected: units("0", "5", 18) },
    { input: `5${d}`, decimals: 18, expected: units("5", "", 18) },
    { input: "１２", decimals: 18, expected: units("12", "", 18) },
    { input: `0${d}0000000001`, decimals: 8, expected: { ok: false, error: "Too many decimal places for SPX (at most 8)." } },
    { input: "1e3", decimals: 18, expected: { ok: false, error: 'Type the number out in full, without "e".' } },
    { input: "-1", decimals: 18, expected: { ok: false, error: "An amount can't be negative." } },
    { input: "0x10", decimals: 18, expected: { ok: false, error: "Type the amount as an ordinary number, not a 0x one." } },
  ];
}

for (const locale of ["en-US", "de-DE", "fr-FR", "de-CH", "en-IN"]) {
  describe(`parseDecimal, ${locale}: the shared rows`, () => {
    for (const { input, decimals, expected } of formatRows(locale)) {
      it(`${JSON.stringify(input)}`, () => {
        expect(parseDecimal(input, locale, decimals, { symbol: "SPX" })).toEqual(expected);
      });
    }

    it("types an accepted amount for every choice and fix it offers", () => {
      for (const { input, decimals } of formatRows(locale)) {
        const parsed = parseDecimal(input, locale, decimals);
        if (parsed.ok) continue;
        for (const offered of [...(parsed.choices ?? []), ...(parsed.fix === undefined ? [] : [parsed.fix])]) {
          expect(parseDecimal(offered, locale, decimals).ok, `${input} → ${offered}`).toBe(true);
        }
      }
    });

    it("reads a euro field's own sign and code, and refuses another currency's sign", () => {
      const { d } = marksOf(locale);
      for (const input of ["20 €", "€20", `20${d}00 €`, "EUR 20", "20 eur"]) {
        expect(parseDecimal(input, locale, 2, { unit: "EUR" }), input).toEqual({ ok: true, value: 2_000n });
      }
      expect(parseDecimal("$20", locale, 2, { unit: "EUR" })).toEqual({
        ok: false,
        error: `This field is in ${currencyPhrase("EUR", locale)}. Type the number only, or switch the unit.`,
      });
    });
  });
}

describe("parseDecimal: what each format does with the others' habits", () => {
  it("de-DE: 0,5 is half, and 1.5 is refused with its fix", () => {
    expect(parseDecimal("0,5", "de-DE", 18)).toEqual(units("0", "5", 18));
    expect(parseDecimal("1.5", "de-DE", 18)).toMatchObject({ ok: false, fix: "1,5" });
  });

  it("fr-FR: a space group, typed or as the format writes it, is never ambiguous", () => {
    for (const input of ["1 500", "1\u202f500", "1\u00a0500"]) {
      expect(parseDecimal(input, "fr-FR", 18), JSON.stringify(input)).toEqual(units("1500", "", 18));
    }
  });

  it("de-CH: the apostrophe group, as typed and as shown", () => {
    expect(parseDecimal("1'500.5", "de-CH", 18)).toEqual(units("1500", "5", 18));
    expect(parseDecimal("1’500.5", "de-CH", 18)).toEqual(units("1500", "5", 18));
  });

  it("en-IN: Indian grouping reads, and a thousands group is offered without its marks", () => {
    expect(parseDecimal("1,00,000.5", "en-IN", 18)).toEqual(units("100000", "5", 18));
    expect(parseDecimal("100,000.5", "en-IN", 18)).toMatchObject({ ok: false, fix: "100000.5" });
  });

  it("a yen field has no decimal places, and says so in words", () => {
    expect(parseDecimal("2940.5", "en-US", 0, { unit: "JPY" })).toEqual({
      ok: false,
      error: "Japanese yen have no decimal places. Type a whole number.",
    });
    expect(parseDecimal("¥2940", "en-US", 0, { unit: "JPY" })).toEqual({ ok: true, value: 2_940n });
  });

  it("$ is the Argentine peso's own sign in es-AR, and a dollar sign elsewhere", () => {
    expect(parseDecimal("$20", "es-AR", 2, { unit: "ARS" })).toEqual({ ok: true, value: 2_000n });
    expect(parseDecimal("$20", "en-US", 2, { unit: "ARS" })).toMatchObject({ ok: false });
    // A dollar field takes "$" where no other currency is written "$" ...
    expect(parseDecimal("$20", "fr-FR", 2, { unit: "USD" })).toEqual({ ok: true, value: 2_000n });
    expect(parseDecimal("$20", "ko-KR", 2, { unit: "USD" })).toEqual({ ok: true, value: 2_000n });
    expect(parseDecimal("US$5", "en-US", 2, { unit: "USD" })).toEqual({ ok: true, value: 500n });
    // ... and not where "$" is the peso: that reading is a thousandfold mistake.
    expect(parseDecimal("$20", "es-AR", 2, { unit: "USD" })).toMatchObject({ ok: false });
  });

  it("a won field reads amounts written the usual Korean way", () => {
    const won = { unit: "KRW" } as const;
    expect(parseDecimal("₩10,000", "ko-KR", 0, won)).toEqual({ ok: true, value: 10_000n });
    expect(parseDecimal("10000원", "ko-KR", 0, won)).toEqual({ ok: true, value: 10_000n });
    expect(parseDecimal("10,000원", "ko-KR", 0, won)).toEqual({ ok: true, value: 10_000n });
    expect(parseDecimal("500円", "ja-JP", 0, { unit: "JPY" })).toEqual({ ok: true, value: 500n });
    // Its own signs twice is no other currency: nothing to switch.
    expect(parseDecimal("₩10,000원", "ko-KR", 0, won)).toEqual({ ok: false, error: "Type the number only." });
    expect(parseDecimal("1만", "ko-KR", 0, won)).toEqual({ ok: false, error: "Type the whole number in digits, without 만, 万 or 千." });
    // Another currency is still named.
    expect(parseDecimal("€20", "ko-KR", 0, won)).toMatchObject({ ok: false, error: expect.stringMatching(/^This field is in South Korean won/) });
  });

  it("reads the digits of Arabic, Persian and Indian keyboards as the digits they are", () => {
    expect(parseDecimal("٢٠", "ar-EG-u-nu-latn", 2, { unit: "USD" })).toEqual({ ok: true, value: 2_000n });
    expect(parseDecimal("٢٠٫٥", "ar-EG-u-nu-latn", 2, { unit: "USD" })).toEqual({ ok: true, value: 2_050n });
    expect(parseDecimal("۱۲", "fa-IR-u-nu-latn", 0, { unit: "USD" })).toEqual({ ok: true, value: 12n });
    expect(parseDecimal("२०.५", "hi-IN", 18)).toEqual(units("20", "5", 18));
  });
});
