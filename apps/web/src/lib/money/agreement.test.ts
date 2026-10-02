/**
 * Typed money with a second opinion: sized only from rates both services
 * agree on to within 1%, and a second service that couldn't read a rate is
 * never taken as disagreeing.
 */

import { describe, expect, it } from "vitest";
import { FX_REFERENCE, TOKENS } from "@spdex/chain";
import { NATIVE_ETH } from "../tokens.js";
import { compareRates, ratesDifferText, ratesDisagree, type CheckedRateSnapshot } from "./agreement.js";
import type { AmountInput, FxSnapshot, Pricing, RateSnapshot } from "./pricing.js";
import { withSecondOpinion } from "./rates.js";
import { resolveAmount, resolveField, withFrozen } from "./resolve.js";

const NOW = 1_789_700_000;
const WETH = TOKENS.WETH.address.toLowerCase();
const SPX = TOKENS.SPX.address.toLowerCase();
const ETH_USD = 2_451_310_000n;

const fx = (eur: bigint, decimals = 8): FxSnapshot => ({
  block: 1n,
  chainTime: NOW,
  rates: { EUR: { answer: eur, decimals, updatedAt: NOW - 60 }, GBP: { answer: FX_REFERENCE.GBP, decimals: 8, updatedAt: NOW - 60 } },
  usdc: null,
});

const snapshot = (eth = ETH_USD, eur = FX_REFERENCE.EUR): RateSnapshot => ({
  usd: new Map([
    [WETH, eth],
    [SPX, 1_000n],
  ]),
  usdReadAt: 100_000,
  fx: fx(eur),
  fxReadAt: 100_000,
});

describe("compareRates", () => {
  it("finds nothing apart when both services agree to within 1%", () => {
    const main = snapshot();
    const within = { usd: new Map([[WETH, (ETH_USD * 1_009n) / 1_000n], [SPX, 1_000n]]), fx: fx((FX_REFERENCE.EUR * 995n) / 1_000n) };
    expect(compareRates(main, within)).toEqual({ tokens: [], currencies: [] });
  });

  it("names each token and currency more than 1% apart", () => {
    const main = snapshot();
    const second = { usd: new Map([[WETH, (ETH_USD * 1_011n) / 1_000n], [SPX, 1_000n]]), fx: fx((FX_REFERENCE.EUR * 98n) / 100n) };
    expect(compareRates(main, second)).toEqual({ tokens: [WETH], currencies: ["EUR"] });
  });

  it("compares currency answers at their own decimals", () => {
    const main = snapshot();
    // The same rate with 18 decimals is the same rate.
    expect(compareRates(main, { usd: null, fx: fx(FX_REFERENCE.EUR * 10n ** 10n, 18) }).currencies).toEqual([]);
  });

  it("never takes what the second service couldn't read as a disagreement", () => {
    const main = snapshot();
    expect(compareRates(main, { usd: null, fx: null })).toEqual({ tokens: [], currencies: [] });
    expect(compareRates(main, { usd: new Map([[SPX, 1_000n]]), fx: { ...fx(1n), rates: {} } })).toEqual({ tokens: [], currencies: [] });
  });
});

describe("ratesDisagree", () => {
  const checked = (tokens: string[], currencies: ("EUR" | "GBP")[]): CheckedRateSnapshot => ({ ...snapshot(), secondOpinion: { tokens, currencies } });

  it("refuses sizing only by the rates it would use: the token's, and the currency's unless dollars", () => {
    expect(ratesDisagree(checked([WETH], []), NATIVE_ETH.address, "USD")).toBe(true); // ether is priced as WETH
    expect(ratesDisagree(checked([], ["EUR"]), NATIVE_ETH.address, "USD")).toBe(false);
    expect(ratesDisagree(checked([], ["EUR"]), NATIVE_ETH.address, "EUR")).toBe(true);
    expect(ratesDisagree(checked([SPX], ["GBP"]), NATIVE_ETH.address, "EUR")).toBe(false);
    expect(ratesDisagree(snapshot(), NATIVE_ETH.address, "EUR")).toBe(false);
    expect(ratesDisagree(null, NATIVE_ETH.address, "EUR")).toBe(false);
  });
});

describe("withSecondOpinion", () => {
  it("attaches the comparison, and drops an old one when the second service couldn't be read this time", () => {
    const main = snapshot();
    const apart = withSecondOpinion(main, { usd: new Map([[WETH, ETH_USD * 2n]]), fx: null });
    expect(apart?.secondOpinion).toEqual({ tokens: [WETH], currencies: [] });
    const failed = withSecondOpinion(apart, null);
    expect(failed).not.toHaveProperty("secondOpinion");
    expect(failed?.usd).toBe(main.usd);
    expect(withSecondOpinion(null, { usd: null, fx: null })).toBeNull();
  });
});

describe("typed money, when the services disagree", () => {
  const pricing = (snap: RateSnapshot): Pricing => ({
    snapshot: snap,
    state: "ready",
    currency: "USD",
    locale: "en-US",
    lastHiddenAt: null,
    request: () => undefined,
    reread: async () => null,
  });
  const dollars = (text: string): AmountInput => ({ text, unit: { currency: "USD" }, frozen: null });

  it("sizes nothing, and says to type the token instead", () => {
    const apart = withSecondOpinion(snapshot(), { usd: new Map([[WETH, ETH_USD * 2n]]), fx: null })!;
    const field = resolveField(dollars("20"), NATIVE_ETH, pricing(apart), 100_000);
    expect(field).toEqual({ resolved: { ok: false, error: ratesDifferText("ETH") }, ratesProblem: true });
    expect(ratesDifferText("ETH")).toBe(
      "Your two network services' prices differ by more than 1%, so spDEX won't size an amount from them. Type ETH instead.",
    );
    expect(withFrozen(dollars("20"), NATIVE_ETH, pricing(apart), 100_000).frozen).toBeNull();
  });

  it("refuses an amount sized earlier once they disagree, and sizes as usual while they agree", () => {
    const agreeing = withSecondOpinion(snapshot(), { usd: new Map([[WETH, ETH_USD]]), fx: null })!;
    const frozen = withFrozen(dollars("20"), NATIVE_ETH, pricing(agreeing), 100_000);
    expect(frozen.frozen).not.toBeNull();
    expect(resolveAmount(frozen, NATIVE_ETH, pricing(agreeing), 100_000)).toMatchObject({ ok: true });
    const apart = withSecondOpinion(snapshot(), { usd: new Map([[WETH, ETH_USD * 2n]]), fx: null })!;
    expect(resolveAmount(frozen, NATIVE_ETH, pricing(apart), 100_000)).toEqual({ ok: false, error: ratesDifferText("ETH") });
    // The token itself is typed as always.
    expect(resolveAmount({ text: "0.5", unit: "token", frozen: null }, NATIVE_ETH, pricing(apart), 100_000)).toMatchObject({
      ok: true,
      raw: 5n * 10n ** 17n,
    });
  });
});
