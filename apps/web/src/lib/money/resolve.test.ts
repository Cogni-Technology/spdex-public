/**
 * The rules that decide what a typed money amount signs: frozen, fresh,
 * bound to its currency, and never nothing for something.
 */

import { describe, expect, it } from "vitest";
import { FX_REFERENCE, TOKENS } from "@spdex/chain";
import { NATIVE_ETH } from "../tokens.js";
import {
  afterCurrencyChange,
  afterTokenChange,
  isFreshForSizing,
  prefilledInput,
  resolveAmount,
  resolveField,
  startingUnit,
  unitChoices,
  unitsFor,
  usdcPegNote,
  presetsBlocked,
  withFrozen,
} from "./resolve.js";
import { CURRENCY_CODES, type AmountInput, type FxSnapshot, type Pricing, type RateSnapshot } from "./pricing.js";

const ETH = NATIVE_ETH;
const USDC = TOKENS.USDC;
const SPX = TOKENS.SPX;
const NOW = 1_789_700_000;
const READ_AT = 100_000;

const FX: FxSnapshot = {
  block: 1n,
  chainTime: NOW,
  rates: {
    EUR: { answer: FX_REFERENCE.EUR, decimals: 8, updatedAt: NOW - 60 },
    // Stale by a week of chain time.
    KRW: { answer: FX_REFERENCE.KRW, decimals: 8, updatedAt: NOW - 7 * 86_400 },
  },
  usdc: null,
};

function snap(readAt = READ_AT, ethUsd = 2_451_310_000n): RateSnapshot {
  return {
    usd: new Map([
      [TOKENS.WETH.address, ethUsd],
      [TOKENS.USDC.address, 10n ** 18n],
    ]),
    usdReadAt: readAt,
    fx: FX,
    fxReadAt: readAt,
  };
}

function pricing(patch: Partial<Pricing> = {}): Pricing {
  return {
    snapshot: snap(),
    state: "ready",
    currency: "USD",
    locale: "en-US",
    lastHiddenAt: null,
    request: () => undefined,
    reread: async () => null,
    ...patch,
  };
}

const dollars = (text: string): AmountInput => ({ text, unit: { currency: "USD" }, frozen: null });

describe("resolveAmount", () => {
  it("reads a token amount as typed, in the number format", () => {
    expect(resolveAmount({ text: "0,5", unit: "token", frozen: null }, ETH, pricing({ locale: "de-DE" }), READ_AT)).toEqual({
      ok: true,
      raw: 5n * 10n ** 17n,
      typed: null,
      at: null,
    });
  });

  it("offers the fix for a token amount in the other format, as a button's text", () => {
    expect(resolveAmount({ text: "1.5", unit: "token", frozen: null }, ETH, pricing({ locale: "de-DE" }), READ_AT)).toMatchObject({
      ok: false,
      fix: { kind: "choose", options: ["1,5"] },
    });
  });

  it("sizes $20 to the shown 0.0081589 ETH, and says what was typed and when", () => {
    const resolved = resolveAmount(dollars("20"), ETH, pricing(), READ_AT + 1_000);
    expect(resolved).toEqual({
      ok: true,
      raw: 8_158_900_000_000_000n,
      typed: { minor6: 20_000_000n, currency: "USD" },
      at: snap(),
    });
  });

  it("reads the field's own sign, and refuses another currency's", () => {
    expect(resolveAmount(dollars("$20"), ETH, pricing(), READ_AT)).toMatchObject({ ok: true, raw: 8_158_900_000_000_000n });
    const euros: AmountInput = { text: "$20", unit: { currency: "EUR" }, frozen: null };
    expect(resolveAmount(euros, ETH, pricing({ currency: "EUR" }), READ_AT)).toEqual({
      ok: false,
      error: "This field is in euros (€). Type the number only, or switch the unit.",
    });
  });

  it("refuses KRW with no valid rate, and never prices it as dollars", () => {
    const won: AmountInput = { text: "20000", unit: { currency: "KRW" }, frozen: null };
    const resolved = resolveAmount(won, ETH, pricing({ currency: "KRW" }), READ_AT);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toMatch(/^KRW rate unavailable \(last update .+\)\. Type ETH or dollars\.$/);
  });

  it("refuses a snapshot more than 5 minutes old, with a way to read the price again", () => {
    const input = withFrozen(dollars("20"), ETH, pricing(), READ_AT);
    expect(resolveAmount(input, ETH, pricing(), READ_AT + 300_000).ok).toBe(true);
    const stale = resolveAmount(input, ETH, pricing(), READ_AT + 300_001);
    expect(stale).toMatchObject({ ok: false, fix: { kind: "reread" } });
    expect(!stale.ok && stale.error).toMatch(/^0\.0081589 ETH at the price from \d\d:\d\d, more than 5 minutes ago\.$/);
  });

  it("refuses rates read before the tab was last hidden, however young", () => {
    const input = withFrozen(dollars("20"), ETH, pricing(), READ_AT);
    expect(resolveAmount(input, ETH, pricing({ lastHiddenAt: READ_AT + 10 }), READ_AT + 20)).toMatchObject({
      ok: false,
      fix: { kind: "reread" },
    });
    expect(isFreshForSizing(snap(), READ_AT - 1, READ_AT + 20)).toBe(true);
  });

  it("keeps a frozen amount when newer rates arrive: only the person sizes it again", () => {
    const frozen = withFrozen(dollars("20"), ETH, pricing(), READ_AT);
    // ETH doubles in the next read; the frozen amount doesn't move.
    const newer = pricing({ snapshot: snap(READ_AT + 60_000, 4_902_620_000n) });
    expect(resolveAmount(frozen, ETH, newer, READ_AT + 60_000)).toMatchObject({ ok: true, raw: 8_158_900_000_000_000n });
    // Pressing "Use it" sizes it against the newer rates.
    expect(withFrozen(frozen, ETH, newer, READ_AT + 60_000).frozen?.raw).toBe(4_079_450_000_000_000n);
  });

  it("sizes an edited amount against the rates on hand, not the frozen ones", () => {
    const frozen = withFrozen(dollars("20"), ETH, pricing(), READ_AT);
    const edited = { ...frozen, text: "40" };
    expect(resolveAmount(edited, ETH, pricing(), READ_AT)).toMatchObject({ ok: true, raw: 16_317_800_000_000_000n });
  });

  it("refuses a real amount worth less than one base unit, and reads nothing typed as zero", () => {
    const cheap = pricing({ snapshot: { ...snap(), usd: new Map([[USDC.address, 10n ** 18n]]) } });
    expect(resolveAmount({ text: "0.000001", unit: "token", frozen: null }, USDC, cheap, READ_AT)).toMatchObject({ ok: true, raw: 1n });
    // SPX, since ether's rate is held to a band (see the next test) and no ether rate could be this.
    const hugeRate = pricing({ snapshot: { ...snap(), usd: new Map([[SPX.address.toLowerCase(), 10n ** 40n]]) } });
    expect(resolveAmount(dollars("0.01"), SPX, hugeRate, READ_AT)).toEqual({
      ok: false,
      error: "That's less than the smallest amount of SPX spDEX can send.",
    });
    expect(resolveAmount(dollars(""), ETH, pricing(), READ_AT)).toEqual({ ok: true, raw: 0n, typed: null, at: null });
    expect(resolveAmount(dollars("0"), ETH, pricing(), READ_AT)).toMatchObject({ ok: true, raw: 0n });
  });

  it("never sizes money from an ether rate far from any ether has had: a lying service's $1 ether is unknown", () => {
    for (const lie of [2_451_310n, 10n ** 13n]) {
      const resolved = resolveAmount(dollars("20"), ETH, pricing({ snapshot: snap(READ_AT, lie) }), READ_AT);
      expect(resolved).toMatchObject({ ok: false });
      expect(resolved.ok ? "" : resolved.error).toMatch(/Type ETH instead\.$/);
    }
    // A fifth to five times its reference, $2,451.31, is still sized.
    expect(resolveAmount(dollars("20"), ETH, pricing({ snapshot: snap(READ_AT, 600_000_000n) }), READ_AT)).toMatchObject({ ok: true });
    expect(resolveAmount(dollars("20"), ETH, pricing({ snapshot: snap(READ_AT, 12_000_000_000n) }), READ_AT)).toMatchObject({ ok: true });
  });

  it("never sizes money from an ether rate more than 10% from Chainlink's ETH/USD, when that answer is usable", () => {
    // Chainlink says $2,451.31, a minute old.
    const withEth = (ethUsd: bigint, updatedAt = NOW - 60): Pricing => {
      const s = snap(READ_AT, ethUsd);
      return pricing({ snapshot: { ...s, fx: { ...FX, eth: { answer: FX_REFERENCE.ETH, decimals: 8, updatedAt } } } });
    };
    expect(resolveAmount(dollars("20"), ETH, withEth(2_451_310_000n), READ_AT)).toMatchObject({ ok: true });
    expect(resolveAmount(dollars("20"), ETH, withEth(2_696_441_000n), READ_AT)).toMatchObject({ ok: true });
    expect(resolveAmount(dollars("20"), ETH, withEth(2_206_179_000n), READ_AT)).toMatchObject({ ok: true });
    for (const off of [2_696_442_000n, 2_206_178_000n, 4_902_620_000n]) {
      const resolved = resolveAmount(dollars("20"), ETH, withEth(off), READ_AT);
      expect(resolved.ok ? "" : resolved.error).toMatch(/couldn't read a current dollar price for ETH .*Type ETH instead\.$/);
      expect(presetsBlocked(withEth(off), ETH, null, 690)).toBe("spDEX has no dollar price for ETH right now.");
    }
    // An ETH/USD answer past its three hours checks nothing: the band alone holds.
    expect(resolveAmount(dollars("20"), ETH, withEth(4_902_620_000n, NOW - 3 * 3_600 - 1), READ_AT)).toMatchObject({ ok: true });
  });

  it("waits while the first price is read, and says so when none could be", () => {
    expect(resolveField(dollars("20"), ETH, pricing({ snapshot: null, state: "reading" }), READ_AT)).toEqual({
      resolved: { ok: false, error: "Reading the price…" },
      ratesProblem: true,
    });
    expect(resolveField(dollars("20"), ETH, pricing({ snapshot: null, state: "unavailable" }), READ_AT)).toEqual({
      resolved: { ok: false, error: "spDEX couldn't read a current dollar price. Type ETH instead." },
      ratesProblem: true,
    });
    // A typing mistake is not a rates problem: it gets a fix, not "Switch to ETH".
    expect(resolveField(dollars("1,500"), ETH, pricing(), READ_AT).ratesProblem).toBe(false);
  });

  it("says the network service is why when it failed the read, and offers to try again, not to type ETH", () => {
    for (const [failure, lead] of [
      ["busy", "The network service is busy"],
      ["unreachable", "The network service didn't answer"],
    ] as const) {
      const field = resolveField(dollars("20"), ETH, pricing({ snapshot: null, state: "unavailable", failure }), READ_AT);
      expect(field.ratesProblem).toBe(true);
      expect(field.resolved).toEqual({
        ok: false,
        error: `${lead}, so spDEX can't read a dollar price right now.`,
        fix: { kind: "retry" },
      });
      expect(field.resolved.ok ? "" : field.resolved.error).not.toContain("Type ETH");
      // Nothing is sized, so nothing is kept to sign later.
      expect(withFrozen(dollars("20"), ETH, pricing({ snapshot: null, state: "unavailable", failure }), READ_AT).frozen).toBeNull();
    }
    // Turned away: waiting won't help, so no retry; the place to go instead.
    const refused = resolveField(dollars("20"), ETH, pricing({ snapshot: null, state: "unavailable", failure: "refused" }), READ_AT);
    expect(refused.resolved).toEqual({
      ok: false,
      error: "The network service turned this page away, so spDEX can't read a dollar price. Choose another service in Settings → Network service.",
    });
    // The service answered and there was no price: today's words, unchanged.
    expect(resolveField(dollars("20"), ETH, pricing({ snapshot: null, state: "unavailable", failure: null }), READ_AT).resolved).toEqual({
      ok: false,
      error: "spDEX couldn't read a current dollar price. Type ETH instead.",
    });
    // Still reading is still a wait, whatever the last read's failure.
    expect(resolveField(dollars("20"), ETH, pricing({ snapshot: null, state: "reading", failure: "busy" }), READ_AT).resolved).toEqual({
      ok: false,
      error: "Reading the price…",
    });
  });

  it("refuses more decimal places than the currency has", () => {
    expect(resolveAmount(dollars("20.0001"), ETH, pricing(), READ_AT)).toEqual({
      ok: false,
      error: "Too many decimal places for US dollars (at most 2).",
    });
    const yen: AmountInput = { text: "20.5", unit: { currency: "JPY" }, frozen: null };
    expect(resolveAmount(yen, ETH, pricing({ currency: "JPY" }), READ_AT)).toEqual({
      ok: false,
      error: "Japanese yen have no decimal places. Type a whole number.",
    });
  });
});

describe("units", () => {
  it("offers the token, dollars and the chosen currency", () => {
    expect(unitsFor(ETH, "EUR")).toEqual(["token", { currency: "USD" }, { currency: "EUR" }]);
    expect(unitsFor(SPX, "USD")).toEqual(["token", { currency: "USD" }]);
  });

  it("hides dollars when paying with USDC, which already is dollars", () => {
    expect(unitsFor(USDC, "USD")).toEqual(["token"]);
    expect(unitsFor(USDC, "EUR")).toEqual(["token", { currency: "EUR" }]);
    expect(afterTokenChange(dollars("20"), USDC, "USD")).toEqual({ text: "20", unit: "token", frozen: null });
  });

  it("starts in the chosen currency until the person switches, then remembers", () => {
    expect(startingUnit(null, ETH, "USD")).toEqual({ currency: "USD" });
    expect(startingUnit(null, ETH, "EUR")).toEqual({ currency: "EUR" });
    expect(startingUnit("token", ETH, "EUR")).toBe("token");
    expect(startingUnit("USD", ETH, "EUR")).toEqual({ currency: "USD" });
    // A remembered currency no longer offered: the chosen one.
    expect(startingUnit("GBP", ETH, "EUR")).toEqual({ currency: "EUR" });
    expect(startingUnit(null, USDC, "USD")).toBe("token");
  });

  it("clears an amount in a currency the field no longer offers, and says why", () => {
    const euros: AmountInput = { text: "20", unit: { currency: "EUR" }, frozen: null };
    expect(afterCurrencyChange(euros, ETH, "GBP")).toEqual({
      input: { text: "", unit: { currency: "GBP" }, frozen: null },
      note: "Currency changed. Type the amount again.",
    });
    // Dollars stay offered whatever the currency, so a dollar amount stays.
    expect(afterCurrencyChange(dollars("20"), ETH, "GBP")).toEqual({ input: dollars("20"), note: null });
  });

  it("moves an empty field whose unit was never chosen to the new currency, and nothing else", () => {
    const empty: AmountInput = { text: "", unit: { currency: "USD" }, frozen: null };
    expect(afterCurrencyChange(empty, ETH, "EUR", null)).toEqual({ input: { text: "", unit: { currency: "EUR" }, frozen: null }, note: null });
    // Chosen before, typed in, or in the token: it stays.
    expect(afterCurrencyChange(empty, ETH, "EUR", "USD").input).toBe(empty);
    expect(afterCurrencyChange(dollars("20"), ETH, "EUR", null).input).toEqual(dollars("20"));
    const token: AmountInput = { text: "", unit: "token", frozen: null };
    expect(afterCurrencyChange(token, ETH, "EUR", null).input).toBe(token);
    // Paying with USDC, the new currency's own unit.
    expect(afterCurrencyChange(empty, USDC, "EUR", null).input.unit).toBe("token");
  });

  it("builds the unit menu: the field's own units first, then every other currency, then the ones with no rate", () => {
    const menu = unitChoices(ETH, "USD", "en-US");
    expect(menu.units).toEqual([
      { value: "token", text: "ETH", title: "ETH" },
      { value: "USD", text: "USD", title: "US dollars" },
    ]);
    // Every other currency, once, and none of the field's own.
    expect(menu.others.map((c) => c.value)).toEqual(CURRENCY_CODES.filter((code) => code !== "USD"));
    expect(menu.others.find((c) => c.value === "EUR")).toEqual({ value: "EUR", text: "EUR €", title: "Euros" });
    // A sign that is only the code is said once.
    expect(menu.others.find((c) => c.value === "CHF")?.text).toBe("CHF");
    expect(menu.missing).toEqual(["INR", "HKD", "SEK", "NOK", "PLN", "ZAR"]);
  });

  it("puts the chosen currency among the field's own units when it isn't dollars", () => {
    const menu = unitChoices(ETH, "EUR", "en-US");
    expect(menu.units.map((c) => c.value)).toEqual(["token", "USD", "EUR"]);
    // By code alone: the box's sign and the closed menu would otherwise say "€" twice.
    expect(menu.units.map((c) => c.text)).toEqual(["ETH", "USD", "EUR"]);
    expect(menu.units.find((c) => c.value === "EUR")?.title).toBe("Euros");
    expect(menu.others.find((c) => c.value === "GBP")?.text).toBe("GBP £");
    expect(menu.others.map((c) => c.value)).not.toContain("EUR");
    expect(menu.others.map((c) => c.value)).not.toContain("USD");
    expect(menu.units.length + menu.others.length).toBe(CURRENCY_CODES.length + 1);
  });

  it("leaves dollars out of a USDC field's menu altogether, as unitsFor does", () => {
    expect(unitChoices(USDC, "USD", "en-US").units.map((c) => c.value)).toEqual(["token"]);
    expect(unitChoices(USDC, "USD", "en-US").others.map((c) => c.value)).not.toContain("USD");
    const euros = unitChoices(USDC, "EUR", "en-US");
    expect(euros.units.map((c) => c.value)).toEqual(["token", "EUR"]);
    expect([...euros.units, ...euros.others].map((c) => c.value)).not.toContain("USD");
  });

  it("writes each sign as the number format does", () => {
    expect(unitChoices(ETH, "USD", "de-DE").others.find((c) => c.value === "EUR")?.text).toBe("EUR €");
    expect(unitChoices(ETH, "USD", "en-US").others.find((c) => c.value === "CAD")?.text).toBe("CAD CA$");
  });

  it("prefills a saved plan's amount in the token, in the number format", () => {
    expect(prefilledInput(5n * 10n ** 17n, ETH, "de-DE")).toEqual({ text: "0,5", unit: "token", frozen: null });
  });
});

describe("notes and presets", () => {
  it("notes USDC more than 1% off its dollar, and says nothing within 1% or without a valid answer", () => {
    const at = (answer: bigint, updatedAt = NOW - 60) => ({ ...snap(), fx: { ...FX, usdc: { answer, decimals: 8, updatedAt } } });
    expect(usdcPegNote(at(96_800_000n), "en-US")).toBe("USDC is at $0.97 right now; dollar figures here assume $1.");
    expect(usdcPegNote(at(99_000_000n), "en-US")).toBeNull();
    expect(usdcPegNote(at(96_800_000n, NOW - 7 * 86_400), "en-US")).toBeNull();
    expect(usdcPegNote(snap(), "en-US")).toBeNull();
    expect(usdcPegNote(null, "en-US")).toBeNull();
  });

  it("blocks the dollar presets without a price or when the wallet holds less than the smallest", () => {
    expect(presetsBlocked(pricing({ snapshot: null, state: "reading" }), ETH, null, 690)).toBeNull();
    expect(presetsBlocked(pricing({ snapshot: null, state: "unavailable" }), ETH, null, 690)).toMatch(/couldn't read a dollar price/);
    expect(presetsBlocked(pricing(), SPX, null, 690)).toBe("spDEX has no dollar price for SPX right now.");
    // $6.90 at $2,451.31 is 0.0028148 ETH.
    expect(presetsBlocked(pricing(), ETH, 2_814_000_000_000_000n, 690)).toBe("Your wallet holds less than $6.90 in ETH.");
    expect(presetsBlocked(pricing(), ETH, 2_815_000_000_000_000n, 690)).toBeNull();
    expect(presetsBlocked(pricing(), ETH, null, 690)).toBeNull();
  });
});
