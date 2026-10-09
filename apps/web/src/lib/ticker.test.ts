/**
 * The ticker's items: what it may say, and what it must never say.
 *
 * The ticker is decoration with numbers in it, which is exactly where a
 * placeholder figure would slip through unnoticed, so the tests lean on the
 * absences: no "% to flip" without both a supply and a rate, never "0%" for
 * one that is missing, no price for SPX at all, no liquidity for markets that
 * haven't been read, no countdown for a plan that isn't running. The ethos
 * lines are the floor, and they are always there.
 */

import { describe, expect, it } from "vitest";
import { TOKENS } from "@spdex/chain";
import { formatPoolMoney } from "./stats.js";
import type { MoneyView } from "./money/convert.js";
import {
  FLIP_TARGET_USD,
  flipPercentText,
  flipSpokenText,
  liquidityText,
  nextBuyAt,
  TICKER_ETHOS,
  tickerItems,
  vaultBuysText,
  type TickerInput,
} from "./ticker.js";

const SPX = TOKENS.SPX;
const NOW_MS = Date.UTC(2026, 8, 23, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const USD = 10n ** 6n;
/** SPX's total supply as the fork's token answers it: a billion, at 8 decimals. */
const SPX_SUPPLY = 1_000_000_000n * 10n ** 8n;

/** The rate `loadUsdRates` would hold for a token at `micros` millionths of a dollar. */
function rateFor(micros: bigint, decimals: number): bigint {
  return (micros * 10n ** 18n) / 10n ** BigInt(decimals);
}

/** SPX's rate at `micros` millionths of a dollar, keyed as App's rates are. */
const spxRates = (micros: bigint) => new Map([[SPX.address.toLowerCase(), rateFor(micros, SPX.decimals)]]);

function input(overrides: Partial<TickerInput> = {}): TickerInput {
  return {
    rates: new Map(),
    spx: { address: SPX.address, supply: null },
    liquidity: null,
    nextBuyAt: null,
    nowMs: NOW_MS,
    ...overrides,
  };
}

const withSupply = (supply: bigint | null) => ({ address: SPX.address, supply });

const texts = (items: ReturnType<typeof tickerItems>) =>
  items.map((item) =>
    item.label === undefined ? item.text : item.labelAfter ? `${item.text} ${item.label}` : `${item.label} ${item.text}`,
  );

describe("tickerItems", () => {
  it("says only the ethos lines when nothing is known, and no figure at all", () => {
    const items = tickerItems(input());
    expect(texts(items)).toEqual([...TICKER_ETHOS]);
    expect(items.every((item) => item.kind === "ethos")).toBe(true);
    expect(texts(items).join(" ")).not.toMatch(/[$%]/);
  });

  it("carries one ethos line, in sentence case for screen readers", () => {
    expect(TICKER_ETHOS).toEqual(["Flip the stock market"]);
    // "No servers" is said once, in the sticker, the footer and the disclaimer;
    // "community project" under the wordmark; spx6900.com's header line not at all.
    expect(TICKER_ETHOS.join(" ")).not.toMatch(/servers|tracking|official|community project|believe in something/i);
    // Capitals are the stylesheet's job; text that is already upper case gets
    // spelled out letter by letter by some screen readers.
    for (const line of TICKER_ETHOS) expect(line).not.toBe(line.toUpperCase());
  });

  it("leads with '% to flip', worked from SPX's supply and the markets panel's rate for it", () => {
    const items = tickerItems(input({ rates: spxRates(465_800n), spx: withSupply(SPX_SUPPLY) }));
    expect(items[0]).toEqual({
      id: "flip",
      label: "to flip",
      labelAfter: true,
      text: "0.0006751%",
      spoken: "SPX6900 market cap is 0.0006751% of the $69 trillion flip target",
      kind: "figure",
    });
    expect(texts(items)[0]).toBe("0.0006751% to flip");
    expect(items.slice(1).map((item) => item.kind)).toEqual(TICKER_ETHOS.map(() => "ethos"));
  });

  it("finds SPX's rate by lowercase address, however the address was written", () => {
    const items = tickerItems(
      input({ rates: spxRates(465_800n), spx: { address: SPX.address.toUpperCase().replace("0X", "0x"), supply: SPX_SUPPLY } }),
    );
    expect(items[0]?.id).toBe("flip");
  });

  it("never shows SPX's price, whatever it knows", () => {
    // "There is no chart": a rate is used, never displayed.
    const items = tickerItems(
      input({
        rates: spxRates(465_800n),
        spx: withSupply(SPX_SUPPLY),
        liquidity: { pair: "ETH/SPX", pools: [{ tvlUsd: 12_345_678n * USD }] },
      }),
    );
    const all = [...texts(items), ...items.map((item) => item.spoken ?? "")].join(" ");
    expect(all).not.toContain("0.4658");
    expect(items.some((item) => item.id === "price")).toBe(false);
    expect(items.some((item) => item.label === "SPX")).toBe(false);
  });

  it("leaves '% to flip' out, rather than showing 0%, when either half is unknown", () => {
    const flipless = (overrides: Partial<TickerInput>) => {
      const items = tickerItems(input(overrides));
      expect(items.some((item) => item.id === "flip")).toBe(false);
      expect(texts(items).join(" ")).not.toContain("%");
    };
    // A rate but no supply yet: nothing — and in particular no price instead.
    flipless({ rates: spxRates(465_800n), spx: withSupply(null) });
    // A supply but no rate for SPX (another pair's markets on screen, or statistics off).
    flipless({ rates: new Map([[TOKENS.WETH.address.toLowerCase(), rateFor(3_000_000_000n, 18)]]), spx: withSupply(SPX_SUPPLY) });
    flipless({ spx: withSupply(SPX_SUPPLY) });
    // A zero from the chain is not a measurement of SPX.
    flipless({ rates: spxRates(465_800n), spx: withSupply(0n) });
  });

  it("puts the known figures first, in a fixed order, with stable ids", () => {
    const items = tickerItems(
      input({
        rates: spxRates(1_000_000n),
        spx: withSupply(SPX_SUPPLY),
        liquidity: { pair: "ETH/SPX", pools: [{ tvlUsd: 12_345_678n * USD }] },
        nextBuyAt: NOW_S + 3 * 3600 + 12 * 60 + 30,
      }),
    );
    expect(items.map((item) => item.id)).toEqual([
      "flip",
      "liquidity",
      "next-buy",
      ...TICKER_ETHOS.map((_, index) => `ethos-${index}`),
    ]);
    expect(texts(items).slice(0, 3)).toEqual([
      "0.001449% to flip",
      "ETH/SPX liquidity $12.35M",
      "Next auto-buy in 3h 12m",
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    // Only the item whose shorthand needs it carries a sentence.
    expect(items.filter((item) => item.spoken !== undefined).map((item) => item.id)).toEqual(["flip"]);
  });

  it("is a pure function of its input", () => {
    const make = () =>
      tickerItems(
        input({
          rates: spxRates(1_482_000n),
          spx: withSupply(SPX_SUPPLY),
          liquidity: { pair: "ETH/SPX", pools: [{ tvlUsd: 5n * USD }, { tvlUsd: null }] },
          nextBuyAt: NOW_S + 90,
        }),
      );
    expect(make()).toEqual(make());
  });

  it("leaves liquidity out until the markets have been read", () => {
    expect(tickerItems(input({ liquidity: null })).some((item) => item.id === "liquidity")).toBe(false);
    expect(
      tickerItems(input({ liquidity: { pair: "ETH/SPX", pools: [] } })).some((item) => item.id === "liquidity"),
    ).toBe(false);
  });

  it("counts down in lower case, so '12m' can't be read as twelve million beside a dollar figure", () => {
    const item = tickerItems(input({ nextBuyAt: NOW_S + 12 * 60 + 5 })).find((i) => i.id === "next-buy");
    expect(item).toEqual({ id: "next-buy", label: "Next auto-buy", text: "in 12m", kind: "figure" });
    expect(tickerItems(input({ nextBuyAt: NOW_S + 30 })).find((i) => i.id === "next-buy")?.text).toBe("any moment");
    expect(tickerItems(input({ nextBuyAt: NOW_S - 1 })).find((i) => i.id === "next-buy")?.text).toBe("now");
  });
});

describe("flipPercentText", () => {
  it("is market cap over $69 trillion: supply × rate, as a percentage", () => {
    expect(FLIP_TARGET_USD).toBe(69n * 10n ** 12n);
    // A billion SPX at $0.4658 is $465.8M, and 465.8M / 69T = 0.00067507…%.
    expect(flipPercentText(SPX_SUPPLY, rateFor(465_800n, 8))).toBe("0.0006751%");
    // The target itself, and either side of it.
    expect(flipPercentText(SPX_SUPPLY, rateFor(69_000n * USD, 8))).toBe("100%");
    expect(flipPercentText(SPX_SUPPLY, rateFor(34_500n * USD, 8))).toBe("50%");
    expect(flipPercentText(SPX_SUPPLY, rateFor(690_000n * USD, 8))).toBe("1,000%");
  });

  it("gives four significant digits, three when the fourth is a zero", () => {
    // $433.32M is exactly 0.000628% of $69T: the user's own example.
    expect(flipPercentText(SPX_SUPPLY, rateFor(433_320n, 8))).toBe("0.000628%");
    expect(flipPercentText(SPX_SUPPLY, rateFor(1_000_000n, 8))).toBe("0.001449%");
    expect(flipPercentText(SPX_SUPPLY, rateFor(12_345_678n, 8))).toBe("0.01789%");
  });

  it("rounds once, at the end, so a figure exactly on a half rounds as the true value does", () => {
    // $85,180,500 is exactly 0.00012345% of $69T. A rate is raw USDC per raw
    // token × 1e18, so this one prices a billion SPX at exactly that.
    const tie = (85_180_500n * 10n ** 24n) / SPX_SUPPLY;
    expect(SPX_SUPPLY * tie).toBe(85_180_500n * 10n ** 24n);
    expect(flipPercentText(SPX_SUPPLY, tie)).toBe("0.0001235%");
    // One raw unit less, and the true value is just under the half.
    expect(flipPercentText(SPX_SUPPLY, tie - 1n)).toBe("0.0001234%");
  });

  it("doesn't depend on the token's decimals: the raw units cancel", () => {
    const whole = 1_000_000_000n;
    expect(flipPercentText(whole * 10n ** 18n, rateFor(465_800n, 18))).toBe(
      flipPercentText(whole * 10n ** 8n, rateFor(465_800n, 8)),
    );
    expect(flipPercentText(whole * 10n ** 6n, rateFor(465_800n, 6))).toBe("0.0006751%");
  });

  it("keeps even the smallest possible share, rather than rounding it to 0%", () => {
    // One raw unit at the lowest rate there is: 1.4492… × 10⁻³⁶ %.
    expect(flipPercentText(1n, 1n)).toBe(`0.${"0".repeat(35)}1449%`);
  });

  it("has nothing to say when either half is unknown or not positive", () => {
    expect(flipPercentText(null, rateFor(465_800n, 8))).toBeNull();
    expect(flipPercentText(SPX_SUPPLY, undefined)).toBeNull();
    expect(flipPercentText(null, undefined)).toBeNull();
    expect(flipPercentText(0n, rateFor(465_800n, 8))).toBeNull();
    expect(flipPercentText(SPX_SUPPLY, 0n)).toBeNull();
    expect(flipPercentText(-SPX_SUPPLY, rateFor(465_800n, 8))).toBeNull();
    expect(flipPercentText(SPX_SUPPLY, -1n)).toBeNull();
  });
});

describe("flipSpokenText", () => {
  it("says what the figure is, for someone who can't see the rest of the page", () => {
    expect(flipSpokenText("0.000628%")).toBe("SPX6900 market cap is 0.000628% of the $69 trillion flip target");
  });
});

describe("liquidityText", () => {
  it("is the markets panel's total when every market was priced", () => {
    const pools = [{ tvlUsd: 9_000_000n * USD }, { tvlUsd: 250_000n * USD }];
    expect(liquidityText(pools)).toBe(formatPoolMoney(9_250_000n * USD, undefined));
    expect(liquidityText(pools)).toBe("$9.25M");
  });

  it("is in the person's currency when the page has its rate, as the markets panel is", () => {
    // EUR at $1.25: 9.25M dollars are 7.4M euros.
    const money: MoneyView = {
      usd: new Map(),
      fx: { block: 1n, chainTime: NOW_S, rates: { EUR: { answer: 125_000_000n, decimals: 8, updatedAt: NOW_S } }, usdc: null },
      currency: "EUR",
      locale: "en-US",
    };
    expect(liquidityText([{ tvlUsd: 9_250_000n * USD }], money)).toBe("€7.4M");
  });

  it("marks a sum that left an unpriced market out as a floor", () => {
    expect(liquidityText([{ tvlUsd: 9_000_000n * USD }, { tvlUsd: null }])).toBe("≥ $9M");
  });

  it("is unknown, not $0, when no market could be priced", () => {
    expect(liquidityText([{ tvlUsd: null }, { tvlUsd: null }])).toBeNull();
    expect(liquidityText([])).toBeNull();
  });

  it("does show a zero that was measured: empty markets are a fact, not a gap", () => {
    expect(liquidityText([{ tvlUsd: 0n }])).toBe("$0");
  });
});

describe("vaultBuysText", () => {
  it("counts the vault buys the Collective DCA panel read, and says when that is a floor", () => {
    expect(vaultBuysText({ value: 1_186n, atLeast: false })).toBe("1,186");
    expect(vaultBuysText({ value: 186n, atLeast: true })).toBe("≥ 186");
  });

  it("is left out until the panel has read them, never 0", () => {
    expect(vaultBuysText(null)).toBeNull();
    expect(vaultBuysText(undefined)).toBeNull();
    expect(tickerItems(input({ vaultBuys: null })).some((item) => item.id === "vault-buys")).toBe(false);
    expect(tickerItems(input({ vaultBuys: { value: 0n, atLeast: false } })).find((item) => item.id === "vault-buys")?.text).toBe("0");
  });
});

describe("nextBuyAt", () => {
  it("is the soonest time among running plans", () => {
    expect(
      nextBuyAt([
        { running: true, nextAt: NOW_S + 600 },
        { running: true, nextAt: NOW_S + 60 },
        { running: true, nextAt: NOW_S + 3600 },
      ]),
    ).toBe(NOW_S + 60);
  });

  it("ignores plans that aren't running or aren't waiting for a time", () => {
    expect(
      nextBuyAt([
        { running: false, nextAt: NOW_S + 5 },
        { running: true, nextAt: null },
        { running: true, nextAt: NOW_S + 900 },
      ]),
    ).toBe(NOW_S + 900);
    expect(nextBuyAt([{ running: false, nextAt: NOW_S + 5 }])).toBeNull();
    expect(nextBuyAt([{ running: true, nextAt: Number.NaN }])).toBeNull();
    expect(nextBuyAt([])).toBeNull();
  });
});
