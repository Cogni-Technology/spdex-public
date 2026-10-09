/**
 * Reading an amount someone typed: the part of the money layer that moves money.
 *
 * The parser this replaces deleted every comma before reading. Both amount
 * fields ask for a decimal keypad, and a phone in a comma-decimal region types
 * "0,5" for half an ether, so spDEX quoted five. This one reads the text by one
 * number format, accepts it only when that format gives it exactly one
 * meaning, and otherwise refuses with a sentence that says what to type. It
 * never picks a reading for the person.
 *
 * - **Grouped pastes still read.** Balances are shown grouped, and people
 *   paste what they see. Deleting the commas was the fix for exactly that:
 *   "use all" once wrote "10,000" into a field whose parser refused commas, and
 *   the app said "enter an amount" while the field held the whole balance.
 *   "10,000.5" can only mean one number, so it is still accepted.
 * - **"1,500" and "1.500" are refused in every format.** Half the world reads
 *   one of them as one and a half. A thousandfold mistake is not a guess worth
 *   making for someone, and two choices cost one more tap.
 * - **Too many decimal places is refused, never cut off.** Refuse, never
 *   clamp: what the person typed is what they agreed to, or nothing is.
 *
 * - **A field in money takes its own currency's sign and nothing else.** "$20"
 *   and "20 €" read in a dollar and a euro field, as Intl writes each sign in
 *   the number format ("$" is the Argentine peso's own sign in es-AR). Any
 *   other sign is refused, never converted: "$" alone names half a dozen
 *   currencies, and reading one as another sizes an amount a thousandfold
 *   wrong.
 *
 * The marks are taken from Intl rather than written in, so the same code
 * reads every format the app offers.
 */

import { CURRENCY_NAMES, currencyPhrase, currencySigns } from "./currency.js";
import type { CurrencyCode } from "./pricing.js";

/**
 * The number format a field is read in when no other is given: the one tests
 * use. The page reads fields in the person's own format (`Pricing.locale`).
 */
export const APP_NUMBER_LOCALE = "en-US";

export type ParsedDecimal =
  /** `value` is the amount times 10^maxFraction: base units, when maxFraction is a token's decimals. */
  | { ok: true; value: bigint }
  /**
   * `error` is a whole sentence, fix included. `choices` are the readings of
   * an ambiguous amount, and `fix` the one way to type what was meant; both
   * are written in this format, for buttons that type them.
   */
  | { ok: false; error: string; choices?: string[]; fix?: string };

export interface ParseDecimalOptions {
  /** The token the field is typed in ("SPX"): allowed beside the number, and named in refusals. */
  symbol?: string;
  /**
   * What the field is in: its token (the default), or a currency. A currency
   * field accepts that currency's own signs and code beside the number and
   * names the currency in its refusals ("This field is in euros (€)").
   */
  unit?: "token" | CurrencyCode;
}

/** Who a refusal names: a token by its symbol, or a currency by its name and sign. */
interface FieldUnit {
  /** "SPX", "euros (€)": the end of "This field is in …". */
  phrase: string | undefined;
  /** "SPX", "euros": the end of "Too many decimal places for …". */
  name: string | undefined;
  /** What may stand beside the number: the token's symbol, or the currency's signs and code. */
  signs: string[];
  money: boolean;
}

function fieldUnit(options: ParseDecimalOptions, locale: string): FieldUnit {
  const unit = options.unit;
  if (unit !== undefined && unit !== "token") {
    return { phrase: currencyPhrase(unit, locale), name: CURRENCY_NAMES[unit], signs: currencySigns(unit, locale), money: true };
  }
  const symbol = options.symbol === "" ? undefined : options.symbol;
  return { phrase: symbol, name: symbol, signs: symbol === undefined ? [] : [symbol], money: false };
}

/**
 * Read `text` as an amount with at most `maxFraction` decimal places, in the
 * number format of `locale`.
 *
 * Empty text reads as zero. Nothing typed is no amount rather than a mistake
 * to explain, and every caller already refuses zero with "Enter an amount
 * greater than zero."
 */
export function parseDecimal(
  text: string,
  locale: string,
  maxFraction: number,
  options: ParseDecimalOptions = {},
): ParsedDecimal {
  const marks = marksFor(locale);
  const unit = fieldUnit(options, locale);
  const typed = withoutSigns(normalize(text).trim(), unit.signs);
  if (typed === "") return { ok: true, value: 0n };

  const shape = shapeProblem(typed, marks, unit);
  if (shape !== null) return { ok: false, error: shape };

  const ambiguous = ambiguity(typed, maxFraction, marks);
  if (ambiguous !== null) return ambiguous;

  const reading = readAs(typed, marks.decimal, marks.group, marks);
  if (reading !== null) return accept(reading, maxFraction, unit);

  // Not a number in this format. Say what to type instead of reading it
  // another way: the other format's decimal mark first, since that is the
  // mistake a phone keypad makes.
  return (
    otherFormat(typed, maxFraction, marks, unit) ??
    misgrouped(typed, maxFraction, marks, unit) ?? { ok: false, error: notANumber(marks) }
  );
}

// ── The format ────────────────────────────────────────────────────────────

interface Marks {
  /** "." or ",". */
  decimal: string;
  /** After `normalize`: ",", ".", " " (for any no-break space) or "'". */
  group: string;
  /** Digits in the last group (3), and in each group before it (3, or 2 in Indian grouping). */
  primary: number;
  secondary: number;
}

/**
 * The marks `locale` writes, from how Intl formats 1,234,567.8 there.
 *
 * Read rather than tabled, because unit tests and browsers carry different
 * ICU data: Node writes de-CH's group mark as ', a browser may write ’.
 */
function marksFor(locale: string): Marks {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
  const mark = (type: string, fallback: string) => normalize(parts.find((p) => p.type === type)?.value ?? fallback);
  const sizes = parts.filter((p) => p.type === "integer").map((p) => p.value.length);
  const primary = sizes[sizes.length - 1] ?? 3;
  const secondary = sizes.length >= 3 ? (sizes[sizes.length - 2] ?? primary) : primary;
  return { decimal: mark("decimal", "."), group: mark("group", ","), primary, secondary };
}

/**
 * The text as a keyboard means it.
 *
 * NFKC turns a Japanese IME's full-width digits and marks into ASCII ("１２"
 * is 12) and every no-break space into a plain one, which is what keyboards
 * type for a space group. The typographic apostrophe becomes the plain one
 * for the same reason: a Swiss keyboard types ' where the format shows ’.
 * NFKC leaves other scripts' digits alone, so an Arabic, Persian or Indian
 * keyboard's are read here as the digits they are ("٢٠" is 20), with the
 * Arabic decimal and group marks as "." and ",", the marks the page reads
 * in those languages (it writes 0 to 9: `numberLocale`).
 */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/’/g, "'")
    .replace(/\p{Nd}/gu, (digit) => {
      const code = digit.codePointAt(0)!;
      const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
      return zero === undefined ? digit : String(code - zero);
    })
    .replace(/\u066b/g, ".")
    .replace(/\u066c/g, ",");
}

/**
 * Where "0" is in each script whose digits a keyboard may type: Arabic-Indic,
 * Persian, N'Ko, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil,
 * Telugu, Kannada, Malayalam, Thai, Lao, Tibetan, Myanmar, Khmer, Mongolian.
 * A digit from anywhere else is left as it is, and refused as not a number.
 */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0,
  0x0f20, 0x1040, 0x17e0, 0x1810,
];

/**
 * The field's own sign, before or after the number, removed: "0.5 ETH" in an
 * ETH field is 0.5, and "20 €" in a euro field is 20. One sign at most, the
 * longest that fits first, so "CA$20" loses "CA$" rather than "$".
 */
function withoutSigns(text: string, signs: readonly string[]): string {
  const ordered = signs.map(normalize).filter((sign) => sign !== "").sort((a, b) => b.length - a.length);
  for (const sign of ordered) {
    const escaped = sign.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lead = new RegExp(`^${escaped}\\s*(?=[\\d.,])`, "i");
    if (lead.test(text)) return text.replace(lead, "").trim();
    const trail = new RegExp(`(?<=[\\d.,])\\s*${escaped}$`, "i");
    if (trail.test(text)) return text.replace(trail, "").trim();
  }
  return text;
}

// ── Refusals by shape ─────────────────────────────────────────────────────

/** What is wrong with text that isn't digits and marks at all, by name, or null when it is. */
function shapeProblem(text: string, marks: Marks, unit: FieldUnit): string | null {
  if (/^[-−]\s*[\d.,]/.test(text)) return "An amount can't be negative.";
  if (/^0x/i.test(text)) return "Type the amount as an ordinary number, not a 0x one.";
  if (/^[\d.,]+e[+-]?\d+$/i.test(text)) return 'Type the number out in full, without "e".';
  // Another currency or token beside the number. It is never converted: "$"
  // alone names half a dozen currencies, and this field is in one unit.
  if (/\p{Sc}/u.test(text) || (/\d/.test(text) && /\p{L}/u.test(text))) {
    const beside = text.replace(/[\d.,' ]/g, "");
    // A number word ("1만", "5千"): the amount is right, only its writing isn't.
    if (/^[만억천백십万億千百十]+$/u.test(beside)) return "Type the whole number in digits, without 만, 万 or 千.";
    // Only the field's own signs, twice or in the middle ("₩10,000원"): the unit is right, so nothing to switch.
    if (unit.phrase === undefined || onlySigns(beside, unit.signs)) return "Type the number only.";
    return unit.money
      ? `This field is in ${unit.phrase}. Type the number only, or switch the unit.`
      : `This field is in ${unit.phrase}. Type the number only.`;
  }
  const allowed = (c: string) => /\d/.test(c) || ".,' ".includes(c) || c === marks.decimal || c === marks.group;
  return [...text].every(allowed) ? null : notANumber(marks);
}

/** Whether `text` is made of nothing but `signs`, each any number of times, longest first, ignoring case. */
function onlySigns(text: string, signs: readonly string[]): boolean {
  let rest = text.toLowerCase();
  const ordered = signs.map((sign) => normalize(sign).replace(/[\d.,' ]/g, "").toLowerCase()).filter((sign) => sign !== "");
  for (const sign of ordered.sort((a, b) => b.length - a.length)) rest = rest.split(sign).join("");
  return rest === "";
}

function notANumber(marks: Marks): string {
  return `Type a number, like 0${marks.decimal}5.`;
}

function tooPrecise(maxFraction: number, unit: FieldUnit): string {
  if (maxFraction === 0) {
    // "at most 0" reads as a riddle: the yen, won and rupiah say it plainly.
    return unit.money && unit.name !== undefined
      ? `${capitalised(unit.name)} have no decimal places. Type a whole number.`
      : "Type a whole number.";
  }
  return `Too many decimal places${unit.name === undefined ? "" : ` for ${unit.name}`} (at most ${maxFraction}).`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Reading ───────────────────────────────────────────────────────────────

interface Reading {
  /** Digits before the decimal mark, grouping removed; may be empty (".5"). */
  whole: string;
  /** Digits after it, as typed; may be empty ("5."). */
  fraction: string;
}

/**
 * `text` read with this decimal mark and group mark, or null when it isn't a
 * number written that way: two decimal marks, a group mark after the decimal
 * mark, or groups of the wrong size.
 */
function readAs(
  text: string,
  decimal: string,
  group: string,
  sizes: { primary: number; secondary: number },
): Reading | null {
  const at = text.indexOf(decimal);
  if (at !== text.lastIndexOf(decimal)) return null;
  const whole = at === -1 ? text : text.slice(0, at);
  const fraction = at === -1 ? "" : text.slice(at + 1);
  if (!/^\d*$/.test(fraction) || (whole === "" && fraction === "")) return null;
  const digits = ungroup(whole, group, sizes);
  return digits === null ? null : { whole: digits, fraction };
}

/**
 * The digits of a whole part, when its group marks sit where this format puts
 * them: "1,234,567" and, in Indian grouping, "12,34,567". A first group never
 * starts with 0, since no grouped number does.
 */
function ungroup(whole: string, group: string, sizes: { primary: number; secondary: number }): string | null {
  if (/^\d*$/.test(whole)) return whole;
  const [first = "", ...rest] = whole.split(group);
  if (![first, ...rest].every((g) => /^\d+$/.test(g))) return null;
  if (!new RegExp(`^[1-9]\\d{0,${sizes.secondary - 1}}$`).test(first)) return null;
  const last = rest[rest.length - 1] ?? "";
  if (last.length !== sizes.primary) return null;
  if (!rest.slice(0, -1).every((g) => g.length === sizes.secondary)) return null;
  return first + rest.join("");
}

/** The value of a reading, or the refusal when it has more decimal places than the field holds. */
function accept(reading: Reading, maxFraction: number, unit: FieldUnit): ParsedDecimal {
  // Trailing zeros are not precision: "1.500000000" SPX is exactly 1.5.
  const fraction = reading.fraction.replace(/0+$/, "");
  if (fraction.length > maxFraction) return { ok: false, error: tooPrecise(maxFraction, unit) };
  const scale = 10n ** BigInt(maxFraction);
  return { ok: true, value: BigInt(reading.whole || "0") * scale + BigInt(fraction.padEnd(maxFraction, "0") || "0") };
}

// ── Refusals with a way out ───────────────────────────────────────────────

/** The shape every format but one would read differently: one to three digits, a "." or ",", three digits. */
const AMBIGUOUS = /^([1-9]\d{0,2})[.,](\d{3})$/;

/**
 * "1,500" or "1.500": a thousand and five hundred in one format, one and a
 * half in another. Refused in every format, with both readings to choose from.
 *
 * "0.001" is not one of these. No grouped number starts with 0, so it has one
 * reading, and it is the amount the auto-buy tests type.
 */
function ambiguity(text: string, maxFraction: number, marks: Marks): ParsedDecimal | null {
  const match = AMBIGUOUS.exec(text);
  if (match === null) return null;
  const [, head = "", tail = ""] = match;
  // A field of whole numbers (the yen, the won, the rupiah, a count): nobody
  // writes 10 won as "10.000", so the format's own group mark is grouping,
  // and read as that; any other mark gets only the whole-number reading.
  if (maxFraction === 0) {
    if (text[head.length] === marks.group) return null;
    return { ok: false, error: `Did you mean ${head + tail}? Type it without a thousands separator.`, choices: [head + tail] };
  }
  const decimals = tail.replace(/0+$/, "");
  // "1.5" for 1.500. A reading with three decimal places left ("1.234") would
  // be refused again for the same reason, so it gets a fourth, "1.2340", which
  // no format reads as a thousand.
  const asDecimal = decimals === "" ? head : `${head}${marks.decimal}${decimals.length === 3 ? `${decimals}0` : decimals}`;
  // Only readings the field could hold are offered: a button must type
  // something that is then accepted.
  const choices = decimals.length <= maxFraction ? [head + tail, asDecimal] : [head + tail];
  const question = choices.length === 2 ? `Is that ${choices[0]} or ${choices[1]}?` : `Did you mean ${head + tail}?`;
  return { ok: false, error: `${question} Type it without a thousands separator.`, choices };
}

/**
 * A number written in the other format: "0,5" or "1.234,5" where the decimal
 * mark is ".". The fix is the same number in this format.
 */
function otherFormat(text: string, maxFraction: number, marks: Marks, unit: FieldUnit): ParsedDecimal | null {
  const other = marks.decimal === "." ? "," : ".";
  const reading = readAs(text, other, marks.decimal, { primary: 3, secondary: 3 });
  if (reading === null) return null;
  const fixed = { whole: reading.whole || "0", fraction: reading.fraction };
  return withFix(fixed, `In your number format the decimal mark is "${marks.decimal}". Type ${written(fixed, marks)}.`, maxFraction, marks, unit);
}

/**
 * A number grouped some way this format doesn't: "1 500" or "1'500.5" where
 * groups are ",", or "1,00,000.5" (Indian grouping) where they come in
 * threes. Its meaning is plain, so the fix is the digits without the marks,
 * but only for groups that look like grouping: "1,50,5" gets no fix.
 */
function misgrouped(text: string, maxFraction: number, marks: Marks, unit: FieldUnit): ParsedDecimal | null {
  const at = text.indexOf(marks.decimal);
  if (at !== text.lastIndexOf(marks.decimal)) return null;
  const whole = at === -1 ? text : text.slice(0, at);
  const fraction = at === -1 ? "" : text.slice(at + 1);
  if (!/^\d*$/.test(fraction)) return null;
  // One kind of separator: a mix of them is not a grouping anyone uses.
  if (new Set(whole.replace(/\d/g, "")).size !== 1) return null;
  const [first = "", ...rest] = whole.split(/[.,' ]/);
  if (!/^[1-9]\d{0,2}$/.test(first) || rest.length === 0) return null;
  if (!rest.every((g) => /^\d{2,3}$/.test(g)) || rest[rest.length - 1]?.length !== 3) return null;
  const fixed = { whole: first + rest.join(""), fraction };
  return withFix(fixed, `Type it without thousands separators: ${written(fixed, marks)}.`, maxFraction, marks, unit);
}

/** A reading as this format writes it for a field: no grouping. */
function written(reading: Reading, marks: Marks): string {
  return reading.fraction === "" ? reading.whole : `${reading.whole}${marks.decimal}${reading.fraction}`;
}

/**
 * The refusal offering `fixed`, or, when the field wouldn't take that either
 * (too many decimal places), the reason it wouldn't: a fix must be accepted.
 */
function withFix(
  fixed: Reading,
  error: string,
  maxFraction: number,
  marks: Marks,
  unit: FieldUnit,
): ParsedDecimal {
  const accepted = accept(fixed, maxFraction, unit);
  return accepted.ok ? { ok: false, error, fix: written(fixed, marks) } : accepted;
}
