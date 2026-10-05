/**
 * The Recurring form's words and rules, pinned against the
 * functions the component renders from.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { PreparedFees } from "@spdex/chain";
import {
  balanceWarning,
  buildPlan,
  buyChoices,
  datetimeLocalToUnix,
  feeEstimate,
  feesBreakdown,
  feesText,
  feeWarningTitle,
  initialFields,
  NO_AMOUNT_SUMMARY,
  parseForm,
  planIdFrom,
  planPreview,
  startLabel,
  summaryText,
  fiatText,
  fixedAmountNote,
  fixedAmountWhy,
  validationError,
  vaultBalanceWarning,
  vaultFormError,
  walletCostText,
  withSell,
  type RecurringFields,
} from "./form.js";
import { buyFee } from "@spdex/vault";
import { DEFAULT_VAULT_SLIPPAGE_BPS, MIN_VAULT_BUY_WEI, VAULT_GAS, vaultCosts } from "./vault.js";
import { NATIVE_ETH } from "../tokens.js";
import type { MoneyView } from "../money/convert.js";

/** Dollar prices alone, in dollars and en-US. */
const dollarView = (usd: ReadonlyMap<string, bigint>): MoneyView => ({ usd, fx: null, currency: "USD", locale: "en-US" });
import type { FxSnapshot, Pricing, RateSnapshot } from "../money/pricing.js";

const GWEI = 10n ** 9n;
/** 1 gwei fee cap: the wireframe's figures. */
const FEES: PreparedFees = { type: "eip1559", maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 10n };
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const date = (unix: number, withTime: boolean) =>
  new Date(unix * 1000).toISOString().slice(0, withTime ? 16 : 10).replace("T", " ");

function fields(overrides: Partial<RecurringFields> = {}): RecurringFields {
  return { ...initialFields(), amount: "0.01", ...overrides };
}

describe("the fields", () => {
  it("start on ETH → SPX, every day, ten times, confirmed in the wallet", () => {
    expect(initialFields()).toMatchObject({ sell: "ETH", buy: "SPX", frequency: "1d", count: "10", signer: "wallet" });
  });

  it("never offer a buy of the token paid with, or its wrapped twin", () => {
    expect(buyChoices("ETH").map((t) => t.symbol)).toEqual(["SPX", "USDC"]);
    expect(buyChoices("WETH").map((t) => t.symbol)).toEqual(["SPX", "USDC"]);
    expect(buyChoices("SPX").map((t) => t.symbol)).toEqual(["ETH", "WETH", "USDC"]);
  });

  it("move Buy off a pair the select no longer offers, and keep it otherwise", () => {
    expect(withSell(fields({ buy: "SPX" }), "USDC").buy).toBe("SPX");
    expect(withSell(fields({ sell: "USDC", buy: "SPX" }), "SPX").buy).toBe("ETH");
    expect(withSell(fields({ sell: "SPX", buy: "ETH" }), "WETH").buy).toBe("SPX");
  });

  it("reads a datetime-local value in this device's time zone, and nothing else", () => {
    const unix = datetimeLocalToUnix("2026-10-01T09:30");
    expect(unix).toBe(Math.floor(new Date(2026, 9, 1, 9, 30).getTime() / 1000));
    expect(datetimeLocalToUnix("tomorrow")).toBeNull();
    expect(datetimeLocalToUnix("")).toBeNull();
  });
});

describe("validation, in the table's order", () => {
  const check = (f: RecurringFields, planCount = 0, expert = false) =>
    validationError(parseForm(f, { expert }), { nowMs: NOW, planCount });

  it("accepts the wireframe's plan", () => {
    expect(check(fields())).toBeNull();
  });

  it("refuses an amount of zero, or none", () => {
    expect(check(fields({ amount: "" }))).toBe("Enter an amount greater than zero.");
    expect(check(fields({ amount: "0.000" }))).toBe("Enter an amount greater than zero.");
  });

  it("refuses an amount it can't read one way, saying what to type", () => {
    // A comma-decimal keypad types "0,5" for half an ether. It used to be
    // read as 5; now it is the form's amount error.
    expect(check(fields({ amount: "0,5" }))).toBe('In your number format the decimal mark is ".". Type 0.5.');
    expect(check(fields({ amount: "1,500" }))).toBe("Is that 1500 or 1.5? Type it without a thousands separator.");
    expect(check(fields({ amount: "abc" }))).toBe("Type a number, like 0.5.");
    expect(check(fields({ sell: "SPX", buy: "ETH", amount: "1.000000001" }))).toBe(
      "Too many decimal places for SPX (at most 8).",
    );
  });

  it("reads a refused amount as no amount, so no figure is shown for it", () => {
    expect(parseForm(fields({ amount: "0,5" }), { expert: false })).toMatchObject({
      amountPerBuy: 0n,
      amountError: 'In your number format the decimal mark is ".". Type 0.5.',
    });
  });

  it("still reads a grouped balance pasted in", () => {
    const parsed = parseForm(fields({ amount: "1,234.5", sell: "USDC", buy: "SPX" }), { expert: false });
    expect(parsed).toMatchObject({ amountPerBuy: 1_234_500_000n, amountError: null });
    expect(check(fields({ amount: "1,234.5", sell: "USDC", buy: "SPX" }))).toBeNull();
  });

  it("refuses the same token, and ETH ↔ WETH as a wrap", () => {
    expect(check(fields({ buy: "ETH" }))).toBe("Choose two different tokens.");
    expect(check(fields({ buy: "WETH" }))).toBe("ETH and WETH are the same asset, so that's a wrap, not a buy.");
  });

  it("refuses a count outside 1 to 1,000 rather than clamping it", () => {
    expect(check(fields({ count: "0" }))).toBe("Choose between 1 and 1,000 buys.");
    expect(check(fields({ count: "1001" }))).toBe("Choose between 1 and 1,000 buys.");
    expect(check(fields({ count: "2.5" }))).toBe("Type a whole number.");
    expect(check(fields({ count: "1,000" }))).toBeNull();
    // Never read with its comma deleted: "2,5" was 25 buys.
    expect(check(fields({ count: "2,5" }))).toBe("Type a whole number.");
    expect(parseForm(fields({ count: "2,5" }), { expert: false }).maxBuys).toBeNull();
  });

  it("refuses a custom interval under five minutes, in Expert", () => {
    expect(check(fields({ frequency: "custom", customMinutes: "4" }), 0, true)).toBe("The shortest interval is 5 minutes.");
    expect(check(fields({ frequency: "custom", customMinutes: "5" }), 0, true)).toBeNull();
    expect(check(fields({ frequency: "custom", customMinutes: "600000" }), 0, true)).toBe("The longest interval is 366 days.");
  });

  it("ignores Expert-only fields left behind in Simple", () => {
    const parsed = parseForm(fields({ frequency: "custom", customMinutes: "1", firstBuy: "later", label: "x" }), {
      expert: false,
    });
    expect(parsed.intervalSeconds).toBe(86_400);
    expect(parsed.startAt).toBeNull();
    expect(parsed.label).toBeUndefined();
  });

  it("refuses a first buy that is not in the future", () => {
    const past = new Date(NOW - 60_000);
    const local = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(check(fields({ firstBuy: "later", startAt: local(past) }), 0, true)).toBe("Choose a first-buy time in the future.");
    expect(check(fields({ firstBuy: "later", startAt: "" }), 0, true)).toBe("Choose a first-buy time in the future.");
    expect(check(fields({ firstBuy: "later", startAt: local(new Date(NOW + 3_600_000)) }), 0, true)).toBeNull();
  });

  it("refuses a ninth plan", () => {
    expect(check(fields(), 8)).toBe("You already have 8 auto-buys, the most spDEX allows. Delete one to add another.");
  });
});

describe("the summary sentence", () => {
  const summary = (f: RecurringFields, signer: "wallet" | "vault" = "wallet", expert = false) =>
    summaryText(parseForm(f, { expert }), { signer, nowMs: NOW, formatDate: date });

  it("reads as one plain sentence", () => {
    expect(summary(fields())).toBe(
      "Buy SPX with 0.01 ETH every day, 10 times · 0.1 ETH total · ends 2026-10-01 at the earliest.",
    );
  });

  it("shows a field that does not parse as a dash, never a zero", () => {
    expect(summary(fields({ count: "0" }))).toBe(
      "Buy SPX with 0.01 ETH every day, — times · — ETH total · ends — at the earliest.",
    );
  });

  it("asks for an amount rather than describing a plan of dashes", () => {
    for (const amount of ["", "0", "0.000"]) {
      expect(summary(fields({ amount }))).toBe("Enter an amount to see your plan.");
      expect(summary(fields({ amount, count: "1" }))).toBe(NO_AMOUNT_SUMMARY);
    }
  });

  it("says what to type for an amount it can't read one way, and never prices it", () => {
    // Before, "0,5" was summarised as a plan buying with 5 ETH.
    expect(summary(fields({ amount: "0,5" }))).toBe('In your number format the decimal mark is ".". Type 0.5.');
    expect(summary(fields({ amount: "abc", count: "1" }))).toBe("Type a number, like 0.5.");
  });

  it("gives the total in dollars when the rate is known, and says nothing when it isn't", () => {
    const rates = dollarView(new Map([[TOKENS.WETH.address.toLowerCase(), 2_600n * 10n ** 6n]]));
    const priced = (f: RecurringFields, money?: MoneyView) =>
      summaryText(parseForm(f, { expert: false }), {
        signer: "wallet",
        nowMs: NOW,
        formatDate: date,
        ...(money === undefined ? {} : { money }),
      });
    expect(priced(fields(), rates)).toBe(
      "Buy SPX with 0.01 ETH every day, 10 times · 0.1 ETH total ≈\u00a0$260.00 · ends 2026-10-01 at the earliest.",
    );
    // No rate for what the plan pays with, or no rates at all: no figure, never "$0".
    expect(priced(fields({ sell: "SPX", buy: "ETH", amount: "1000" }), rates)).not.toContain("$");
    expect(priced(fields())).toBe(summary(fields()));
    // No total, no dollar total.
    expect(priced(fields({ count: "0" }), rates)).not.toContain("$");
  });

  it("says a one-buy plan once", () => {
    expect(summary(fields({ count: "1" }))).toBe("Buy SPX with 0.01 ETH once, now.");
  });

  it("counts a day's confirmations for a wallet plan under a day", () => {
    expect(summary(fields({ frequency: "1h", count: "3" }))).toContain(" You'd confirm 24 times a day.");
    expect(summary(fields({ sell: "USDC", frequency: "1h", count: "3" }))).toContain(" You'd confirm 48 times a day.");
    // A vault buys by itself: nothing to confirm.
    expect(summary(fields({ frequency: "1h", count: "3" }), "vault")).not.toContain("confirm");
  });

  it("names a custom interval in hours when it is whole hours", () => {
    expect(summary(fields({ frequency: "custom", customMinutes: "120" }), "wallet", true)).toContain("every 2 hours");
    expect(summary(fields({ frequency: "custom", customMinutes: "90" }), "wallet", true)).toContain("every 90 minutes");
  });
});

describe("money figures", () => {
  // Rates are raw USDC per raw token, scaled by 1e18 (stats.ts): at 2,600 USDC
  // per ETH, one wei is 2,600e6 / 1e18 raw USDC, so the rate is 2,600e6.
  const usd = new Map([
    [TOKENS.WETH.address.toLowerCase(), 2_600n * 10n ** 6n],
    [TOKENS.USDC.address.toLowerCase(), 10n ** 18n],
  ]);
  const rates = dollarView(usd);
  const ETH = NATIVE_ETH;

  it("prices an amount from the page's rates, ether as WETH", () => {
    expect(fiatText(10n ** 16n, TOKENS.WETH, rates)).toBe("≈\u00a0$26.00");
    expect(fiatText(10n ** 16n, ETH, rates)).toBe("≈\u00a0$26.00");
    expect(fiatText(10n * 10n ** 6n, TOKENS.USDC, rates)).toBe("≈\u00a0$10.00");
    expect(fiatText(100n * 10n ** 18n, ETH, rates)).toBe("≈\u00a0$260,000.00");
  });

  it("is in the chosen currency, in its number format", () => {
    const fx: FxSnapshot = {
      block: 1n,
      chainTime: 1_000_000,
      rates: { EUR: { answer: 130_000_000n, decimals: 8, updatedAt: 1_000_000 - 60 } },
      usdc: null,
    };
    // $26 at $1.30 a euro.
    expect(fiatText(10n ** 16n, ETH, { usd, fx, currency: "EUR", locale: "de-DE" })).toBe(
      `≈\u00a0${new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(20)}`,
    );
  });

  it("is absent, never $0, when the rate or the amount is missing", () => {
    expect(fiatText(10n ** 18n, TOKENS.SPX, rates)).toBeNull();
    expect(fiatText(10n ** 18n, ETH, undefined)).toBeNull();
    expect(fiatText(10n ** 18n, ETH, dollarView(new Map()))).toBeNull();
    expect(fiatText(0n, ETH, rates)).toBeNull();
    expect(fiatText(10n ** 18n, null, rates)).toBeNull();
  });

  it("says a real amount under a cent is under a cent, not $0.00", () => {
    expect(fiatText(10n ** 9n, ETH, rates)).toBe("<\u00a0$0.01");
    expect(fiatText(1n, TOKENS.USDC, rates)).toBe("<\u00a0$0.01");
    expect(fiatText(10_000n, TOKENS.USDC, rates)).toBe("≈\u00a0$0.01");
  });
});

describe("an amount typed in money", () => {
  // $2,451.31 a ether, read at t = 1,000 ms.
  const at: RateSnapshot = {
    usd: new Map([
      [TOKENS.WETH.address.toLowerCase(), 2_451_310_000n],
      [TOKENS.USDC.address.toLowerCase(), 10n ** 18n],
    ]),
    usdReadAt: 1_000,
    fx: null,
    fxReadAt: null,
  };
  const pricing: Pricing = {
    snapshot: at,
    state: "ready",
    currency: "USD",
    locale: "en-US",
    lastHiddenAt: null,
    request: () => undefined,
    reread: async () => null,
  };
  const inDollars = (text: string, nowMs = 2_000) =>
    parseForm(fields({ amount: text }), {
      expert: false,
      money: { input: { unit: { currency: "USD" }, frozen: null }, pricing, nowMs },
    });

  it("saves the token amount the money came to, and the plan stores exactly that", () => {
    const parsed = inDollars("20");
    expect(parsed.amountPerBuy).toBe(8_158_900_000_000_000n);
    expect(parsed.conversion?.typed).toEqual({ minor6: 20_000_000n, currency: "USD" });
    const plan = buildPlan(parsed, { id: "dca-00000001", chainId: 1, signer: "wallet", nowSeconds: 1 });
    expect(plan.amountPerBuy).toBe("8158900000000000");
  });

  it("leads the summary with the token amount, then what was typed and when", () => {
    const summary = summaryText(inDollars("20"), { signer: "wallet", nowMs: NOW, formatDate: date, money: dollarView(at.usd) });
    expect(summary).toMatch(
      /^Buy SPX with 0\.0081589 ETH \(\$20\.00 at the price from \d\d:\d\d\) every day, 10 times · 0\.081589 ETH total · ends/,
    );
    // No "≈" total: it would be the typed amount again, through the same price.
    expect(summary).not.toContain("≈");
  });

  it("says the amount saved is fixed in the token, and what that means for a vault", () => {
    expect(fixedAmountNote(inDollars("20"), "wallet")).toBe("Saved as 0.0081589 ETH a buy: $20.00 at today's price.");
    expect(fixedAmountNote(inDollars("20"), "vault")).toBe("Fixed in ETH: 0.0081589 ETH a buy.");
    expect(fixedAmountNote(parseForm(fields(), { expert: false }), "wallet")).toBeNull();
    // Why, one tap away.
    expect(fixedAmountWhy(inDollars("20"), "wallet")).toBe(
      "Each buy spends exactly that much in ETH, so what a buy is worth in US dollars will go up and down.",
    );
    expect(fixedAmountWhy(inDollars("20"), "vault")).toBe(
      "It's written into the vault in ETH, so what a buy is worth in US dollars will go up and down.",
    );
    expect(fixedAmountWhy(parseForm(fields(), { expert: false }), "wallet")).toBeNull();
  });

  it("refuses a price more than 5 minutes old, and Start waits for a new one", () => {
    const stale = inDollars("20", 1_000 + 300_001);
    expect(stale.amountPerBuy).toBe(0n);
    expect(stale.amountWaitsOnRates).toBe(true);
    expect(validationError(stale, { nowMs: NOW, planCount: 0 })).toMatch(/more than 5 minutes ago\.$/);
  });

  it("is refused, not guessed, while there is no price", () => {
    const parsed = parseForm(fields({ amount: "20" }), {
      expert: false,
      money: { input: { unit: { currency: "USD" }, frozen: null }, pricing: { ...pricing, snapshot: null, state: "reading" }, nowMs: 2_000 },
    });
    expect(parsed.amountPerBuy).toBe(0n);
    expect(parsed.amountWaitsOnRates).toBe(true);
  });

  it("states the vault's 0.5 ETH limit in money too, and still refuses", () => {
    const parsed = inDollars("400");
    const at5 = { ...parsed, maxBuys: 5 };
    expect(vaultFormError(at5, undefined, dollarView(at.usd))).toMatch(
      /^You can put at most 0\.5 ETH \(≈\u00a0\$1,225\.66\) into a vault/,
    );
  });
});

describe("network fees", () => {
  it("sizes a wallet plan at every buy's gas budget, as a share of an ETH plan", () => {
    const estimate = feeEstimate(parseForm(fields(), { expert: false }), "wallet", FEES);
    expect(estimate).toEqual({ upTo: 10n * 350_000n * GWEI, sharePercent: 3.5, priced: true });
    expect(feesText({ kind: "ok", fees: FEES }, estimate)).toBe(
      "Network fees: up to 0.0035 ETH over the plan, up to 3.5% of it, at today's fees.",
    );
    // In money too, when a rate is known: still a bound.
    const usd = new Map([[TOKENS.WETH.address.toLowerCase(), 2_451_310_000n]]);
    expect(feesText({ kind: "ok", fees: FEES }, estimate, dollarView(usd))).toMatch(
      /^Network fees: up to 0\.0035 ETH \(≈\u00a0\$[\d.]+\) over the plan, up to 3\.5% of it, at today's fees\.$/,
    );
    expect(feesBreakdown(estimate)).toBeNull();
    expect(feeWarningTitle(estimate)).toBeNull();
  });

  it("doesn't guess a share for a token with no price in ETH", () => {
    const estimate = feeEstimate(parseForm(fields({ sell: "USDC", amount: "10" }), { expert: false }), "wallet", FEES);
    expect(estimate!.sharePercent).toBeNull();
    expect(feesText({ kind: "ok", fees: FEES }, estimate)).toContain("(share unknown)");
  });

  it("leaves the share out while there is no amount, rather than calling it unknown", () => {
    const estimate = feeEstimate(parseForm(fields({ amount: "" }), { expert: false }), "wallet", FEES);
    expect(feesText({ kind: "ok", fees: FEES }, estimate)).toBe("Network fees: up to 0.0035 ETH over the plan, at today's fees.");
  });

  it("values WETH at one ETH", () => {
    expect(feeEstimate(parseForm(fields({ sell: "WETH" }), { expert: false }), "wallet", FEES)!.sharePercent).toBe(4.2);
  });

  it("warns above 5% and never shows a figure it didn't read", () => {
    const tiny = feeEstimate(parseForm(fields({ amount: "0.0001" }), { expert: false }), "wallet", FEES);
    // A bound, not a forecast.
    expect(feeWarningTitle(tiny)).toBe("Fees could reach 350% of this plan");
    // The line under it leaves that share to the title.
    expect(feesText({ kind: "ok", fees: FEES }, tiny, undefined, { share: false })).toBe(
      "Network fees: up to 0.0035 ETH over the plan, at today's fees.",
    );
    expect(feesText({ kind: "reading" }, null)).toBe("Network fees: shown once current fees are read.");
    expect(feesText({ kind: "error", message: "x" }, null)).toBe("Network fees: unknown — spDEX couldn't read current fees.");
  });

  it("states a wallet plan's confirmations per buy", () => {
    expect(walletCostText(null)).toBe("1 confirmation and 1 network fee per buy.");
    expect(walletCostText(TOKENS.USDC)).toBe("2 confirmations and 2 network fees per buy: a permission, then the buy.");
    // With one ETH buy's network fee, as the vault card beside it gives its buy fee.
    expect(walletCostText(null, "≈ $0.05 (0.0000198 ETH), 1.05% of the buy")).toBe(
      "1 confirmation and 1 network fee per buy: ≈ $0.05 (0.0000198 ETH), 1.05% of the buy, at today's fees.",
    );
    // Not for a token plan, whose permission and buy the figure isn't for.
    expect(walletCostText(TOKENS.USDC, "≈ $0.05 (0.0000198 ETH), 1.05% of the buy")).toBe(
      "2 confirmations and 2 network fees per buy: a permission, then the buy.",
    );
  });
});

describe("the balance warning", () => {
  const parsed = parseForm(fields(), { expert: false });

  it("says how many buys a read balance covers", () => {
    expect(balanceWarning(parsed, "wallet", 35n * 10n ** 15n)).toBe(
      "Your wallet holds 0.035 ETH: enough for 3 of 10 buys. A buy your wallet can't pay for is skipped.",
    );
    expect(balanceWarning(parsed, "wallet", 10n ** 18n)).toBeNull();
  });

  it("says nothing from a balance it couldn't read, or for a vault, which has its own", () => {
    expect(balanceWarning(parsed, "wallet", null)).toBeNull();
    expect(balanceWarning(parsed, "wallet", undefined)).toBeNull();
    expect(balanceWarning(parsed, "vault", 0n)).toBeNull();
  });
});

describe("the plan Start writes", () => {
  it("makes lowercase host ids the schema accepts", () => {
    expect(planIdFrom(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("dca-deadbeef");
  });

  it("writes a wallet plan running, with no empty label", () => {
    const parsed = parseForm(fields(), { expert: false });
    const options = { id: "dca-00000001", chainId: 690069, nowSeconds: 1_000 };
    const wallet = buildPlan(parsed, { ...options, signer: "wallet" });
    expect(wallet).toEqual({
      id: "dca-00000001",
      paused: false,
      chainId: 690069,
      sell: NATIVE_TOKEN,
      buy: TOKENS.SPX.address,
      amountPerBuy: (10n ** 16n).toString(),
      intervalSeconds: 86_400,
      maxBuys: 10,
      startAt: 1_000,
      signer: "wallet",
    });
    expect(JSON.parse(planPreview(parsed, { ...options, signer: "wallet" }))).toEqual(wallet);
  });

  it("writes a vault plan paused, as it always stays, with no vault until one exists", () => {
    const parsed = parseForm(fields(), { expert: false });
    const vault = buildPlan(parsed, { id: "dca-00000002", chainId: 690069, nowSeconds: 2_000, signer: "vault" });
    expect(vault).toMatchObject({ paused: true, signer: "vault", startAt: 2_000 });
    expect("vault" in vault).toBe(false);
  });

  it("labels Start with when the first buy happens", () => {
    expect(startLabel("wallet", null)).toBe("Start auto-buy — first buy now");
    expect(startLabel("wallet", 86_400, date)).toBe("Start auto-buy — first buy 1970-01-02 00:00");
    expect(startLabel("vault", null)).toBe("Create and fund vault");
  });
});

describe("a vault plan in the form", () => {
  // 3 gwei base fee and a 1 gwei tip: a block charges 4 gwei.
  const fees: PreparedFees = { type: "eip1559", maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: GWEI };

  it("costs the buy fees and creating the vault, not a fee reserve", () => {
    const parsed = parseForm(fields({ amount: "0.05", count: "5" }), { expert: false });
    const estimate = feeEstimate(parsed, "vault", fees)!;
    const costs = vaultCosts({ amountPerBuy: 5n * 10n ** 16n, maxBuys: 5, fees })!;
    expect(estimate.vault).toEqual(costs);
    expect(estimate.upTo).toBe(costs.rewardsTotal + VAULT_GAS.createAndFund * 4n * GWEI);
    // The share is of the whole cost, buy fees and creation together, so it
    // leads, before the parts: after the creation fee it read as that fee's.
    // 126,000 gas at 0.15 gwei is 0.0000189 ETH, and 0.25% of 0.05 ETH
    // 0.000125 ETH: 0.0001439 ETH a buy. No "tenth" any more.
    expect(feesText({ kind: "ok", fees }, estimate)).toBe("Fees ≈ 0.0016 ETH over the plan, 0.64% of it, at today's fees.");
    // With the fee warning shown, its title gives the share: said once.
    expect(feesText({ kind: "ok", fees }, estimate, undefined, { share: false })).toBe("Fees ≈ 0.0016 ETH over the plan, at today's fees.");
    // Its parts, one tap away.
    expect(feesBreakdown(estimate)).toBe(
      "0.0007195 ETH in buy fees (0.0001439 ETH a buy, 0.29% of each) and about 0.00088 ETH in network fees to create the vault.",
    );
  });

  it("says when the buy fee is held at the most it can be", () => {
    const parsed = parseForm(fields({ amount: "0.001", count: "5" }), { expert: false });
    expect(feesBreakdown(feeEstimate(parsed, "vault", fees))).toMatch(
      /in buy fees \(0\.0000069 ETH a buy, 0\.69% of each, the most it can be\)/,
    );
  });

  it("refuses what a vault can't do, one thing at a time, and leaves the rest to the form's own checks", () => {
    const at = (overrides: Partial<RecurringFields>) => parseForm(fields(overrides), { expert: false });
    expect(vaultFormError(at({}))).toBeNull();
    expect(vaultFormError(at({ sell: "WETH" }))).toBe("A vault pays with ETH only.");
    expect(vaultFormError(at({ buy: "USDC" }))).toBe("A vault buys SPX only.");
    // The 0.5 ETH you can put in counts each buy's fee: five buys of 0.1 ETH
    // fit on their own, and not with their fees.
    expect(vaultFormError(at({ amount: "0.1", count: "5" }))).toMatch(/^You can put at most 0\.5 ETH into a vault/);
    expect(vaultFormError(at({ amount: "0.098", count: "5" }))).toBeNull();
    expect(vaultFormError(at({ amount: "" }))).toBeNull();
  });

  /**
   * The community window is Expert's to choose, and refused rather than
   * clamped when the frequency changed under a choice: a quarter of the
   * interval at most, an hour at most, a minute at least. Simple, and Expert
   * left at its default, get the plan's default, which always fits.
   */
  it("refuses a community window the factory wouldn't take, and takes the plan's default when none is chosen", () => {
    const at = (overrides: Partial<RecurringFields>) => parseForm(fields(overrides), { expert: true });
    const hourly = at({ frequency: "1h" });
    expect(hourly.intervalSeconds).toBe(3_600);
    expect(vaultFormError(hourly, DEFAULT_VAULT_SLIPPAGE_BPS, undefined, 900)).toBeNull();
    expect(vaultFormError(hourly, DEFAULT_VAULT_SLIPPAGE_BPS, undefined, 1_800)).toBe(
      "The community window must be 1 minute to an hour, and no more than a quarter of the time between buys.",
    );
    expect(vaultFormError(hourly, DEFAULT_VAULT_SLIPPAGE_BPS, undefined, 59)).toMatch(/^The community window must be/);
    expect(vaultFormError(hourly, DEFAULT_VAULT_SLIPPAGE_BPS, undefined, null)).toBeNull();
    expect(vaultFormError(hourly)).toBeNull();
    // A daily plan: up to an hour, never more.
    expect(vaultFormError(at({ frequency: "1d" }), DEFAULT_VAULT_SLIPPAGE_BPS, undefined, 3_600)).toBeNull();
    expect(vaultFormError(at({ frequency: "1d" }), DEFAULT_VAULT_SLIPPAGE_BPS, undefined, 3_601)).toMatch(/^The community window must be/);
  });

  /** Under 145 wei the buy fee is nothing at all; the floor is a round figure well above that. */
  it("refuses a buy too small to pay a buy fee", () => {
    const at = (amount: string) => parseForm(fields({ amount }), { expert: false });
    expect(vaultFormError(at("0.0000009"))).toBe("Each buy must be at least 0.000001 ETH so it can pay a buy fee.");
    expect(vaultFormError(at("0.000001"))).toBeNull();
    expect(MIN_VAULT_BUY_WEI).toBe(10n ** 12n);
    expect(buyFee(144n).reward).toBe(0n);
  });

  it("warns when the wallet can't cover what creating the vault sends, only from a balance that was read", () => {
    const costs = vaultCosts({ amountPerBuy: 10n ** 16n, maxBuys: 10, fees })!;
    expect(vaultBalanceWarning(costs, 10n ** 17n)).toBe(
      "Your wallet holds 0.1 ETH. Creating this vault sends 0.1005 ETH — every buy and its buy fee — plus about 0.00088 ETH in network fees.",
    );
    expect(vaultBalanceWarning(costs, 10n ** 18n)).toBeNull();
    expect(vaultBalanceWarning(costs, null)).toBeNull();
    expect(vaultBalanceWarning(null, 0n)).toBeNull();
    // Before fees are read, the budget alone is weighed, and the network fee named without a figure.
    const unread = vaultCosts({ amountPerBuy: 10n ** 16n, maxBuys: 10, fees: null })!;
    expect(vaultBalanceWarning(unread, 10n ** 17n)).toBe(
      "Your wallet holds 0.1 ETH. Creating this vault sends 0.1005 ETH — every buy and its buy fee — plus its network fee.",
    );
    expect(vaultBalanceWarning(unread, costs.budget)).toBeNull();
  });
});

