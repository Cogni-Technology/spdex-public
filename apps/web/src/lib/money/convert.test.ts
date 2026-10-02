/**
 * Money to a token amount and back: the arithmetic that decides what is
 * signed when someone types dollars or euros.
 */

import { describe, expect, it } from "vitest";
import { FX_REFERENCE, TOKENS } from "@spdex/chain";
import { NATIVE_ETH, type TokenInfo } from "../tokens.js";
import {
  fiatOf,
  fiatToTokenRaw,
  floorSignificant,
  ETH_USD_REFERENCE,
  fiatCostText,
  fxRate,
  usdRateOf,
  usdShown,
  usdToFiat,
  validFx,
  type MoneyView,
} from "./convert.js";
import type { FxSnapshot, RateSnapshot } from "./pricing.js";

/** 2,451.31 USDC per ETH: raw USDC per raw WETH, times 1e18. */
const ETH_USD = 2_451_310_000n;
/** 0.69 USDC per SPX: raw USDC (6) per raw SPX (8), times 1e18. */
const SPX_USD = 6_900_000_000_000_000n;
const NOW = 1_789_700_000;

const FX: FxSnapshot = {
  block: 26_000_000n,
  chainTime: NOW,
  rates: {
    EUR: { answer: FX_REFERENCE.EUR, decimals: 8, updatedAt: NOW - 3_600 },
    JPY: { answer: FX_REFERENCE.JPY, decimals: 8, updatedAt: NOW - 3_600 },
    PHP: { answer: FX_REFERENCE.PHP, decimals: 18, updatedAt: NOW - 3_600 },
    // Stale: a week old.
    KRW: { answer: FX_REFERENCE.KRW, decimals: 8, updatedAt: NOW - 7 * 86_400 },
  },
  usdc: null,
};

function snapshot(fx: FxSnapshot | null = FX): RateSnapshot {
  return {
    usd: new Map([
      [TOKENS.WETH.address, ETH_USD],
      [TOKENS.SPX.address, SPX_USD],
      [TOKENS.USDC.address, 10n ** 18n],
    ]),
    usdReadAt: 1_000,
    fx,
    fxReadAt: fx === null ? null : 1_000,
  };
}

const E18 = 10n ** 18n;

describe("fiatToTokenRaw and floorSignificant: the worked check", () => {
  it("sizes $20 at 2,451.31 to 0.0081589 ETH, rounding down once", () => {
    const raw = fiatToTokenRaw(20n * E18, { answer: 1n, decimals: 0 }, ETH_USD);
    expect(raw).toBe(8_158_902_790_752_699n);
    expect(floorSignificant(raw)).toBe(8_158_900_000_000_000n);
  });

  it("keeps an amount under a million base units whole", () => {
    expect(floorSignificant(999_999n)).toBe(999_999n);
    expect(floorSignificant(1_234_567n)).toBe(1_234_560n);
    expect(floorSignificant(1n)).toBe(1n);
    expect(floorSignificant(0n)).toBe(0n);
  });

  it("sizes SPX, with its 8 decimals: $6.90 at $0.69 is 10 SPX", () => {
    const raw = fiatToTokenRaw(690n * 10n ** 16n, { answer: 1n, decimals: 0 }, SPX_USD);
    expect(raw).toBe(10n * 10n ** 8n);
  });

  it("goes through the currency's own rate: €20 is more ETH than $20", () => {
    const eur = fxRate(FX, "EUR")!;
    const raw = floorSignificant(fiatToTokenRaw(20n * E18, eur, ETH_USD));
    // 20 × 1.1481 / 2451.31 = 0.00936723… ETH
    expect(raw).toBe(9_367_230_000_000_000n);
  });

  it("reads PHP's 18-decimal feed at its own scale", () => {
    const php = fxRate(FX, "PHP")!;
    expect(php.decimals).toBe(18);
    // ₱1,000 at 0.015927 is $15.927.
    const raw = fiatToTokenRaw(1_000n * E18, php, 10n ** 18n);
    expect(raw).toBe(15_927_000n);
  });

  it("never spends more than was typed, over 10,000 random amounts at 18, 8 and 6 decimals", () => {
    // A small deterministic generator, so a failure names its input.
    let seed = 0x5eed_c0den;
    const next = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed;
    };
    const tokens: { decimals: number; rate: bigint }[] = [
      { decimals: 18, rate: ETH_USD },
      { decimals: 8, rate: SPX_USD },
      { decimals: 6, rate: 10n ** 18n },
    ];
    for (let i = 0; i < 10_000; i += 1) {
      const token = tokens[i % 3]!;
      // Up to a million units of money, in cents.
      const typed = (next() % 100_000_000n) * 10n ** 16n + 10n ** 16n;
      const fx = i % 2 === 0 ? { answer: 1n, decimals: 0 } : { answer: FX_REFERENCE.EUR, decimals: 8 };
      const raw = floorSignificant(fiatToTokenRaw(typed, fx, token.rate));
      // What the token amount is worth back in the currency, exactly: never above what was typed.
      const back = (raw * token.rate * 10n ** BigInt(fx.decimals) * 10n ** 12n) / (E18 * fx.answer);
      expect(back <= typed, `typed ${typed} → ${raw}`).toBe(true);
    }
  });
});

describe("validFx", () => {
  it("is the dollar itself for USD, with or without a read", () => {
    expect(validFx(null, "USD")).toMatchObject({ answer: 1n, decimals: 0 });
    expect(fxRate(null, "USD")).toEqual({ answer: 1n, decimals: 0 });
  });

  it("is null for a currency whose answer is stale, missing or never read", () => {
    expect(validFx(FX, "KRW")).toBeNull();
    expect(validFx(FX, "GBP")).toBeNull();
    expect(validFx(null, "EUR")).toBeNull();
    expect(validFx(FX, "EUR")?.answer).toBe(FX_REFERENCE.EUR);
  });

  it("is null for an answer outside its band", () => {
    const repointed: FxSnapshot = { ...FX, rates: { EUR: { answer: FX_REFERENCE.EUR * 6n, decimals: 8, updatedAt: NOW } } };
    expect(validFx(repointed, "EUR")).toBeNull();
  });
});

describe("a token amount in money (fiatOf)", () => {
  const ETH: TokenInfo = NATIVE_ETH;
  const inView = (currency: MoneyView["currency"]): MoneyView => ({ usd: snapshot().usd, fx: snapshot().fx, currency, locale: "en-US" });

  it("prices native ether as WETH", () => {
    expect(fiatOf(E18, ETH.address, inView("USD"))?.value).toEqual({ minor6: 2_451_310_000n, currency: "USD" });
  });

  it("prices in a currency through its rate", () => {
    // 1 ETH = $2,451.31 = €2,135.101471…
    expect(fiatOf(E18, ETH.address, inView("EUR"))?.value.minor6).toBe(2_135_101_471n);
  });

  it("is null, never zero, without a price for the token", () => {
    expect(fiatOf(E18, "0x1111111111111111111111111111111111111111", inView("USD"))).toBeNull();
  });

  it("converts pool figures, already in dollars, and leaves them unknown without a rate", () => {
    expect(usdToFiat(1_148_100n, FX, "EUR")).toEqual({ minor6: 1_000_000n, currency: "EUR" });
    expect(usdToFiat(1_000_000n, FX, "USD")).toEqual({ minor6: 1_000_000n, currency: "USD" });
    expect(usdToFiat(1_000_000n, FX, "KRW")).toBeNull();
  });
});

describe("usdShown: every money figure's fallback", () => {
  it("is in the chosen currency when its rate is known, else in dollars and says so", () => {
    expect(usdShown(1_148_100n, FX, "EUR")).toEqual({ value: { minor6: 1_000_000n, currency: "EUR" }, fellBack: false });
    expect(usdShown(1_000_000n, FX, "KRW")).toEqual({ value: { minor6: 1_000_000n, currency: "USD" }, fellBack: true });
    expect(usdShown(1_000_000n, null, "USD")).toEqual({ value: { minor6: 1_000_000n, currency: "USD" }, fellBack: false });
  });
});

describe("fiatCostText: what some ether costs, for a sentence", () => {
  const view: MoneyView = { usd: snapshot().usd, fx: FX, currency: "USD", locale: "en-US" };
  it("leads with ≈, reads a tiny cost as below a cent, and is nothing without a rate or an amount", () => {
    expect(fiatCostText(E18 / 100n, view)).toBe("≈\u00a0$24.51");
    expect(fiatCostText(10n ** 12n, view)).toBe("<\u00a0$0.01");
    expect(fiatCostText(0n, view)).toBeNull();
    expect(fiatCostText(E18, undefined)).toBeNull();
    expect(fiatCostText(E18, { ...view, usd: new Map() })).toBeNull();
  });
});

describe("fiatOf: a figure for display", () => {
  const view = (currency: MoneyView["currency"]): MoneyView => ({ usd: snapshot().usd, fx: FX, currency, locale: "en-US" });

  it("is in the chosen currency when its rate is known", () => {
    expect(fiatOf(E18, NATIVE_ETH.address, view("EUR"))).toEqual({
      value: { minor6: 2_135_101_471n, currency: "EUR" },
      fellBack: false,
    });
  });

  it("falls back to dollars, and says so, when the currency's rate is unknown", () => {
    expect(fiatOf(E18, NATIVE_ETH.address, view("KRW"))).toEqual({
      value: { minor6: 2_451_310_000n, currency: "USD" },
      fellBack: true,
    });
  });

  it("is null for a token with no price", () => {
    expect(fiatOf(E18, "0x1111111111111111111111111111111111111111", view("USD"))).toBeNull();
  });

  it("drops ether's figure, never shows it, while the rate is more than 10% from a usable ETH/USD answer", () => {
    // Chainlink's $2,451.31 against a 10-minute average 20% higher.
    const eth = { answer: FX_REFERENCE.ETH, decimals: 8, updatedAt: NOW - 60 };
    const usd = new Map([[TOKENS.WETH.address.toLowerCase(), (ETH_USD * 12n) / 10n]]);
    expect(fiatOf(E18, NATIVE_ETH.address, { usd, fx: { ...FX, eth }, currency: "USD", locale: "en-US" })).toBeNull();
    expect(usdRateOf(TOKENS.WETH.address, usd, { ...FX, eth })).toBeNull();
    expect(usdRateOf(TOKENS.WETH.address, usd, FX)).toBe((ETH_USD * 12n) / 10n);
    expect(ETH_USD_REFERENCE).toBe(2_451_310_000n);
  });
});
