/**
 * Typed money and the second opinion: an amount typed in money is sized only
 * from rates both of the person's network services agree on, to within 1%,
 * whenever the second service answers. When it doesn't, the amount is sized
 * from the main service alone, and the second-opinion setting says so.
 *
 * Money typed into a field becomes the token amount that is quoted and
 * signed, and the rates that do it (the 10-minute average and Chainlink's
 * currency answers) come from the main service. With a second opinion set,
 * the same rates are read through the second service too
 * (`Engine.secondOpinionRates`), and a rate the two put more than 1% apart
 * can't size an amount: the field says so, and offers the token instead.
 *
 * The token amount on screen stays the check, as it always is. This only
 * stops a lying main service from quietly sizing "$20" as much more.
 *
 * A second service that couldn't read a rate has failed on its own account,
 * which never counts as a disagreement: that rate is simply not compared.
 */

import { validFx, pricedAs } from "./convert.js";
import { CURRENCY_CODES, type CurrencyCode, type FxCurrencyCode, type FxSnapshot, type RateSnapshot } from "./pricing.js";

/** How far apart two services' rates may be and still size money: 1%. */
export const RATES_AGREE_WITHIN_BPS = 100n;

/** What the second service's reads of the same rates came to: each part null when it couldn't be read. */
export interface SecondRates {
  usd: ReadonlyMap<string, bigint> | null;
  fx: FxSnapshot | null;
}

/** The rates two services put more than 1% apart: tokens by lowercase address, and currencies. */
export interface RatesAgreement {
  tokens: readonly string[];
  currencies: readonly FxCurrencyCode[];
}

/** A rate snapshot as the second opinion left it: `secondOpinion` is absent without one. */
export type CheckedRateSnapshot = RateSnapshot & { secondOpinion?: RatesAgreement };

/** Whether `a` and `b` are more than 1% apart, measured from `a` (the main service's). */
function apart(a: bigint, b: bigint): boolean {
  if (a <= 0n || b <= 0n) return a !== b;
  const gap = a > b ? a - b : b - a;
  return gap * 10_000n > a * RATES_AGREE_WITHIN_BPS;
}

/**
 * Which of the main service's rates the second service's reads put more than
 * 1% away: every token both priced, and every currency both have a valid
 * answer for, compared at each answer's own decimals.
 */
export function compareRates(main: Pick<RateSnapshot, "usd" | "fx">, second: SecondRates): RatesAgreement {
  const tokens: string[] = [];
  if (second.usd !== null) {
    for (const [token, rate] of main.usd) {
      const theirs = second.usd.get(token);
      if (theirs !== undefined && apart(rate, theirs)) tokens.push(token.toLowerCase());
    }
  }
  const currencies: FxCurrencyCode[] = [];
  if (second.fx !== null && main.fx !== null) {
    for (const code of CURRENCY_CODES) {
      if (code === "USD") continue;
      const ours = validFx(main.fx, code);
      const theirs = validFx(second.fx, code);
      if (ours === null || theirs === null) continue;
      // Both as dollars per unit, scaled to the same decimals.
      const a = ours.answer * 10n ** BigInt(theirs.decimals);
      const b = theirs.answer * 10n ** BigInt(ours.decimals);
      if (apart(a, b)) currencies.push(code);
    }
  }
  return { tokens, currencies };
}

/** Whether the two services disagree about a rate sizing `token` in `currency` would use. */
export function ratesDisagree(snapshot: CheckedRateSnapshot | null, token: string, currency: CurrencyCode): boolean {
  const agreement = snapshot?.secondOpinion;
  if (agreement === undefined) return false;
  if (agreement.tokens.includes(pricedAs(token))) return true;
  return currency !== "USD" && agreement.currencies.includes(currency);
}

/** Why typed money can't be sized right now, naming the unit that still can. */
export function ratesDifferText(symbol: string): string {
  return (
    "Your two network services' prices differ by more than 1%, so spDEX won't size an amount from them. " +
    `Type ${symbol} instead.`
  );
}
