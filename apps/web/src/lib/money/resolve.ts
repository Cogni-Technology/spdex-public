/**
 * What may turn money someone typed into the token amount that is quoted,
 * saved and signed.
 *
 * The rules, each of which a test pins:
 *
 * 1. **Frozen.** A money amount is sized against one set of rates, and that
 *    result is kept with them (`AmountInput.frozen`). A re-render or a
 *    background refresh never sizes it again; only the person does, by
 *    typing or by pressing "Use the price now".
 * 2. **Fresh, or no button.** An amount is signable only while the dollar
 *    price it was sized with is at most five minutes old by this tab's own
 *    clock, and the tab hasn't been hidden since that read. Otherwise it is
 *    refused with a way to read the price again.
 * 3. **Bound to its currency.** Euros need a valid euro rate from the same
 *    read. Without one the amount is refused; it is never sized as dollars.
 *    (A "≈" figure may fall back to dollars. Sizing never does.)
 * 4. **Never nothing for something.** A real amount that comes to less than
 *    one base unit is refused, not rounded to zero or up to one.
 *
 * Every function here is pure: the caller passes `performance.now()`.
 */

import { fxProblem } from "@spdex/chain";
import type { TokenInfo } from "../tokens.js";
import { ratesDisagree, ratesDifferText } from "./agreement.js";
import { fiatToTokenRaw, floorSignificant, fxRate, typedToFiat, usdRateOf } from "./convert.js";
import { CURRENCY_NAMES, currencyDigits, currencyUnitText, MISSING_CURRENCY_CODES } from "./currency.js";
import { clockText, dayText, formatAmountForField, formatFiat, wallClockOf } from "./format.js";
import { parseDecimal, type ParsedDecimal } from "./parse.js";
import { PLACES } from "../places.js";
import {
  CURRENCY_CODES,
  DISPLAY_MAX_AGE_MS,
  SIZING_MAX_AGE_MS,
  type AmountFix,
  type AmountInput,
  type AmountUnit,
  type CurrencyCode,
  type FiatAmount,
  type Pricing,
  type RateSnapshot,
  type RatesFailure,
  type ResolvedAmount,
  type StoredUnit,
} from "./pricing.js";

const USDC_SYMBOL = "USDC";

// ── Units ─────────────────────────────────────────────────────────────────

/** The unit's currency, or null for the token unit. */
export function unitCurrency(unit: AmountUnit): CurrencyCode | null {
  return unit === "token" ? null : unit.currency;
}

/** How a unit is remembered: "token" or its code. */
export function storedUnit(unit: AmountUnit): StoredUnit {
  return unit === "token" ? "token" : unit.currency;
}

export function sameUnit(a: AmountUnit, b: AmountUnit): boolean {
  return storedUnit(a) === storedUnit(b);
}

/**
 * The units a field in `token` offers: the token, dollars, and the chosen
 * currency when it isn't dollars. Paying with USDC offers no dollar unit:
 * USDC already is dollars, as spDEX counts it.
 */
export function unitsFor(token: TokenInfo, currency: CurrencyCode): AmountUnit[] {
  const units: AmountUnit[] = ["token"];
  if (token.symbol !== USDC_SYMBOL) units.push({ currency: "USD" });
  if (currency !== "USD") units.push({ currency });
  return units;
}

/** One entry of an amount field's unit menu: the stored unit, its words, and its full name on hover. */
export interface UnitChoice {
  value: StoredUnit;
  text: string;
  title: string;
}

/**
 * An amount field's unit menu, in three groups:
 *
 * - `units`: the field's own units (`unitsFor`), in that order, by code
 *   alone ("ETH", "USD", "EUR"): where the sign leads, the box shows it
 *   before the number, so "$ 25 USD $" would say it twice. Choosing one sets
 *   only this field's unit.
 * - `others`: every other currency, which the menu offers under "Change
 *   currency", as "GBP £". Choosing one sets the page's currency, then this
 *   field's unit. Dollars stay out of a USDC field, which has no dollar unit.
 * - `missing`: the currencies with no rate to read, listed and never offered.
 *
 * Every currency's full name is its option's title.
 */
export function unitChoices(
  token: TokenInfo,
  currency: CurrencyCode,
  locale: string,
): { units: UnitChoice[]; others: UnitChoice[]; missing: readonly string[] } {
  const own = unitsFor(token, currency);
  const choice = (unit: AmountUnit, text: (code: CurrencyCode) => string): UnitChoice =>
    unit === "token"
      ? { value: "token", text: token.symbol, title: token.symbol }
      : { value: unit.currency, text: text(unit.currency), title: sentenceCase(CURRENCY_NAMES[unit.currency]) };
  const others = CURRENCY_CODES.filter(
    (code) => !own.some((unit) => unitCurrency(unit) === code) && !(code === "USD" && token.symbol === USDC_SYMBOL),
  );
  return {
    units: own.map((unit) => choice(unit, (code) => code)),
    others: others.map((code) => choice({ currency: code }, (other) => currencyUnitText(other, locale))),
    missing: MISSING_CURRENCY_CODES,
  };
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The unit a field starts in. Remembered when the person switched it before
 * and that unit is still offered; otherwise the chosen currency, since money
 * is what a newcomer thinks in. Paying with USDC starts in USDC.
 */
export function startingUnit(stored: StoredUnit | null, token: TokenInfo, currency: CurrencyCode): AmountUnit {
  const offered = unitsFor(token, currency);
  if (stored !== null) {
    const match = offered.find((unit) => storedUnit(unit) === stored);
    if (match !== undefined) return match;
    if (stored === "token") return "token";
  }
  if (token.symbol === USDC_SYMBOL) return "token";
  return offered.find((unit) => unitCurrency(unit) === currency) ?? "token";
}

/** A field prefilled from a saved plan: always in the token, the unit the plan was saved in. */
export function prefilledInput(raw: bigint, token: TokenInfo, locale: string): AmountInput {
  return { text: formatAmountForField(raw, token.decimals, locale), unit: "token", frozen: null };
}

/**
 * The field after the chosen currency changed. An amount typed in a currency
 * the field no longer offers is cleared, with the reason, rather than read
 * again in another currency: "20" euros must never become 20 pounds.
 *
 * An empty field whose unit the person never chose (`remembered` is null)
 * follows the currency, as a fresh one would start in it: choosing euros
 * shouldn't leave the next amount in dollars.
 */
export function afterCurrencyChange(
  input: AmountInput,
  token: TokenInfo,
  currency: CurrencyCode,
  remembered: StoredUnit | null = null,
): { input: AmountInput; note: string | null } {
  if (input.text.trim() === "" && remembered === null && unitCurrency(input.unit) !== null) {
    const unit = startingUnit(null, token, currency);
    return { input: sameUnit(unit, input.unit) ? input : { text: "", unit, frozen: null }, note: null };
  }
  if (unitsFor(token, currency).some((unit) => sameUnit(unit, input.unit))) return { input, note: null };
  const cleared: AmountInput = { text: "", unit: startingUnit(null, token, currency), frozen: null };
  return { input: cleared, note: input.text.trim() === "" ? null : "Currency changed. Type the amount again." };
}

/** The field after the token changed: a money amount has to be sized again for the new token, and dollars go when it is USDC. */
export function afterTokenChange(input: AmountInput, token: TokenInfo, currency: CurrencyCode): AmountInput {
  const offered = unitsFor(token, currency).some((unit) => sameUnit(unit, input.unit));
  // USDC has no dollar unit, and a dollar amount in a USDC field is that many USDC.
  return { text: input.text, unit: offered ? input.unit : "token", frozen: null };
}

// ── Freshness ─────────────────────────────────────────────────────────────

/** Whether rates read at `at` may still size an amount: at most 5 minutes old, and not read before the tab was last hidden. */
export function isFreshForSizing(at: RateSnapshot, lastHiddenAt: number | null, nowMs: number): boolean {
  if (nowMs - at.usdReadAt > SIZING_MAX_AGE_MS) return false;
  return lastHiddenAt === null || lastHiddenAt < at.usdReadAt;
}

/** Whether rates read at `at` may still be shown: at most 30 minutes old. */
export function isFreshForDisplay(at: RateSnapshot, nowMs: number): boolean {
  return nowMs - at.usdReadAt <= DISPLAY_MAX_AGE_MS;
}

/** "14:02": when a snapshot's dollar prices were read. */
export function readTime(at: RateSnapshot): string {
  return clockText(wallClockOf(at.usdReadAt));
}

// ── Sizing ────────────────────────────────────────────────────────────────

/** What sizing a money amount came to: the token amount and what it was sized from, or why it can't be. */
export type Sizing =
  | { ok: true; raw: bigint; typed: FiatAmount; at: RateSnapshot }
  | { ok: false; error: string; ratesProblem: boolean; fix?: AmountFix };

/**
 * Why no dollar price could be read, when the network service is why: the
 * read failed on the service, not on the price. Typing the token instead is
 * no way on, since a swap in it can't be priced either while the service is
 * failing, so the fix is to try again ("Try again", `{ kind: "retry" }`), or,
 * when it turned the page away, another service.
 */
export function serviceRatesText(failure: RatesFailure): string {
  switch (failure) {
    case "busy":
      return "The network service is busy, so spDEX can't read a dollar price right now.";
    case "unreachable":
      return "The network service didn't answer, so spDEX can't read a dollar price right now.";
    case "refused":
      return `The network service turned this page away, so spDEX can't read a dollar price. Choose another service in ${PLACES.networkService.label}.`;
  }
}

/**
 * `text` in `currency` as base units of `token`, against `snapshot`, however
 * old it is: freshness is `resolveAmount`'s rule, not this one's.
 *
 * `typed` must be what `text` parses to; it is passed in so the text is read
 * once. Zero is left to the caller, which refuses it in its own words.
 */
export function sizeMoney(
  typed: bigint,
  currency: CurrencyCode,
  token: TokenInfo,
  snapshot: RateSnapshot | null,
  state: Pricing["state"],
  nowMs: number,
  failure: RatesFailure | null = null,
): Sizing {
  if (snapshot === null) {
    if (state !== "unavailable") return { ok: false, error: "Reading the price…", ratesProblem: true };
    if (failure !== null) {
      return {
        ok: false,
        error: serviceRatesText(failure),
        ratesProblem: true,
        ...(failure === "refused" ? {} : { fix: { kind: "retry" } as const }),
      };
    }
    return { ok: false, error: `spDEX couldn't read a current dollar price. Type ${token.symbol} instead.`, ratesProblem: true };
  }
  const usdRate = usdRateOf(token.address, snapshot.usd, snapshot.fx);
  if (usdRate === null) {
    return {
      ok: false,
      error: `spDEX couldn't read a current dollar price for ${token.symbol} (last read ${readTime(snapshot)}). Type ${token.symbol} instead.`,
      ratesProblem: true,
    };
  }
  const fx = fxRate(snapshot.fx, currency);
  const fxFresh = currency === "USD" || (snapshot.fxReadAt !== null && nowMs - snapshot.fxReadAt <= DISPLAY_MAX_AGE_MS);
  if (fx === null || !fxFresh) {
    return { ok: false, error: rateUnavailableText(currency, snapshot, token), ratesProblem: true };
  }
  // With a second opinion set, never from a rate the two services put more
  // than 1% apart (agreement.ts); a rate the second didn't read isn't compared.
  if (ratesDisagree(snapshot, token.address, currency)) return { ok: false, error: ratesDifferText(token.symbol), ratesProblem: true };
  const raw = floorSignificant(fiatToTokenRaw(typed, fx, usdRate));
  if (raw === 0n) {
    return { ok: false, error: `That's less than the smallest amount of ${token.symbol} spDEX can send.`, ratesProblem: false };
  }
  return { ok: true, raw, typed: typedToFiat(typed, currency), at: snapshot };
}

/**
 * "EUR rate unavailable (last update Sep 12)": the update is the feed's own,
 * when there is an answer to date; with none there is nothing to say when.
 */
export function rateUnavailableLead(currency: CurrencyCode, snapshot: RateSnapshot | null): string {
  const answer = snapshot?.fx?.rates[currency as Exclude<CurrencyCode, "USD">];
  const when = answer !== undefined && answer.updatedAt > 0 ? ` (last update ${dayText(answer.updatedAt)})` : "";
  return `${currency} rate unavailable${when}`;
}

/** "EUR rate unavailable (last update Sep 12). Type ETH or dollars.": why a money amount can't be sized. */
export function rateUnavailableText(currency: CurrencyCode, snapshot: RateSnapshot | null, token: TokenInfo): string {
  const instead = token.symbol === USDC_SYMBOL ? "USDC" : `${token.symbol} or dollars`;
  return `${rateUnavailableLead(currency, snapshot)}. Type ${instead}.`;
}

/** The amount a money field's text holds, times 10^18, or the refusal. */
function typedMoney(text: string, currency: CurrencyCode, locale: string): ParsedDecimal {
  const digits = currencyDigits(currency);
  const parsed = parseDecimal(text, locale, digits, { unit: currency });
  return parsed.ok ? { ok: true, value: parsed.value * 10n ** BigInt(18 - digits) } : parsed;
}

/** A parse refusal as a resolved one: its choices, or its one fix, become buttons that type them. */
function refusal(parsed: Extract<ParsedDecimal, { ok: false }>): ResolvedAmount {
  const options = parsed.choices ?? (parsed.fix === undefined ? undefined : [parsed.fix]);
  return options === undefined
    ? { ok: false, error: parsed.error }
    : { ok: false, error: parsed.error, fix: { kind: "choose", options } };
}

/**
 * The field with its money amount sized against the page's current rates
 * and kept (`frozen`), or with nothing frozen when it can't be sized yet.
 * Called when the person types, switches unit, or presses "Use it": the only
 * moments an amount may be sized again.
 */
export function withFrozen(input: AmountInput, token: TokenInfo, p: Pricing, nowMs: number): AmountInput {
  const currency = unitCurrency(input.unit);
  if (currency === null) return { ...input, frozen: null };
  const typed = typedMoney(input.text, currency, p.locale);
  if (!typed.ok || typed.value === 0n) return { ...input, frozen: null };
  const sized = sizeMoney(typed.value, currency, token, p.snapshot, p.state, nowMs, p.failure ?? null);
  return { ...input, frozen: sized.ok ? { raw: sized.raw, typed: sized.typed, at: sized.at } : null };
}

/**
 * Turn what a field holds into the token amount that is quoted, saved and
 * signed. Empty or zero is `raw: 0n`, which every caller refuses as "Enter
 * an amount greater than zero."
 */
export function resolveAmount(input: AmountInput, token: TokenInfo, p: Pricing, nowMs: number): ResolvedAmount {
  return resolveField(input, token, p, nowMs).resolved;
}

/**
 * `resolveAmount`, and whether a refusal is about the rates (still reading,
 * too old, a currency without a rate) rather than about what was typed: the
 * field offers "Switch to ETH" for the first kind, and a fix for the second.
 */
export function resolveField(
  input: AmountInput,
  token: TokenInfo,
  p: Pricing,
  nowMs: number,
): { resolved: ResolvedAmount; ratesProblem: boolean } {
  const currency = unitCurrency(input.unit);
  if (currency === null) {
    const parsed = parseDecimal(input.text, p.locale, token.decimals, { symbol: token.symbol });
    return { resolved: parsed.ok ? { ok: true, raw: parsed.value, typed: null, at: null } : refusal(parsed), ratesProblem: false };
  }

  const typed = typedMoney(input.text, currency, p.locale);
  if (!typed.ok) return { resolved: refusal(typed), ratesProblem: false };
  if (typed.value === 0n) return { resolved: { ok: true, raw: 0n, typed: null, at: null }, ratesProblem: false };
  // An amount sized earlier is refused too while the services' current rates
  // disagree: a price one of them now calls wrong isn't one to sign by.
  if (ratesDisagree(p.snapshot, token.address, currency)) {
    return { resolved: { ok: false, error: ratesDifferText(token.symbol) }, ratesProblem: true };
  }

  // What was frozen, when it is this amount in this currency; otherwise the
  // amount was edited since, and is sized now, against the rates on hand.
  const typedFiat = typedToFiat(typed.value, currency);
  const frozen = input.frozen;
  const sized: Sizing =
    frozen !== null && frozen.typed.currency === currency && frozen.typed.minor6 === typedFiat.minor6
      ? { ok: true, raw: frozen.raw, typed: frozen.typed, at: frozen.at }
      : sizeMoney(typed.value, currency, token, p.snapshot, p.state, nowMs, p.failure ?? null);
  if (!sized.ok) {
    const resolved: ResolvedAmount = sized.fix === undefined ? { ok: false, error: sized.error } : { ok: false, error: sized.error, fix: sized.fix };
    return { resolved, ratesProblem: sized.ratesProblem };
  }

  if (!isFreshForSizing(sized.at, p.lastHiddenAt, nowMs)) {
    const amount = formatAmountForField(sized.raw, token.decimals, p.locale);
    // Say which rule it was: "more than 5 minutes" would be untrue of a
    // price read ten seconds before the person switched tabs.
    const why = nowMs - sized.at.usdReadAt > SIZING_MAX_AGE_MS ? "more than 5 minutes ago" : "before you last left this tab";
    return {
      resolved: {
        ok: false,
        error: `${amount} ${token.symbol} at the price from ${readTime(sized.at)}, ${why}.`,
        fix: { kind: "reread" },
      },
      ratesProblem: true,
    };
  }
  return { resolved: { ok: true, raw: sized.raw, typed: sized.typed, at: sized.at }, ratesProblem: false };
}

/**
 * "USDC is at $0.97 right now; dollar figures here assume $1." — when
 * Chainlink's USDC/USD answer is valid and more than 1% from a dollar, or
 * null. A note only: it never refuses anything.
 */
export function usdcPegNote(snapshot: RateSnapshot | null, locale: string): string | null {
  const usdc = snapshot?.fx?.usdc ?? null;
  if (snapshot?.fx === null || snapshot?.fx === undefined || fxProblem("USDC", usdc, snapshot.fx.chainTime) !== null) return null;
  const scale = 10n ** BigInt(usdc!.decimals);
  const off = usdc!.answer > scale ? usdc!.answer - scale : scale - usdc!.answer;
  if (off * 100n <= scale) return null;
  const minor6 = (usdc!.answer * 1_000_000n) / scale;
  return `USDC is at ${formatFiat({ minor6, currency: "USD" }, locale)} right now; dollar figures here assume $1.`;
}

// ── One-tap amounts ───────────────────────────────────────────────────────

/**
 * Why the dollar presets can't be used, or null when they can: no dollar
 * price could be read, or the wallet holds less than the smallest of them.
 * While the first price is still being read they stay usable: a preset only
 * fills the field, and the field says when it has a price.
 */
export function presetsBlocked(
  pricing: Pricing,
  token: TokenInfo,
  balance: bigint | null | undefined,
  smallestCents: number,
): string | null {
  const s = pricing.snapshot;
  if (s === null) return pricing.state === "unavailable" ? "spDEX couldn't read a dollar price, so these can't be used right now." : null;
  const rate = usdRateOf(token.address, s.usd, s.fx);
  if (rate === null) return `spDEX has no dollar price for ${token.symbol} right now.`;
  if (balance === null || balance === undefined) return null;
  const smallest = BigInt(smallestCents) * 10_000n;
  if ((balance * rate) / 10n ** 18n >= smallest) return null;
  return `Your wallet holds less than ${formatFiat({ minor6: smallest, currency: "USD" }, pricing.locale)} in ${token.symbol}.`;
}

/** What a preset puts in the field: that many dollars, or that many USDC when paying with USDC, which is dollars already. */
export function presetInput(text: string, token: TokenInfo): AmountInput {
  return { text, unit: token.symbol === USDC_SYMBOL ? "token" : { currency: "USD" }, frozen: null };
}

