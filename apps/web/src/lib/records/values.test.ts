import { describe, expect, it } from "vitest";
import { ETH_USD_MAX_AGE_SECONDS, NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { FxSnapshot, RateSnapshot } from "../money/pricing.js";
import {
  fillable,
  fxFromStored,
  fxToStored,
  ratesFromStored,
  ratesSeenNow,
  rowValueIn,
  rowValueShown,
  SEEN_READ_MAX_AGE_MS,
  valueAtBlock,
  valueSeen,
} from "./values.js";

const WETH = TOKENS.WETH.address.toLowerCase() as `0x${string}`;
const SPX = TOKENS.SPX.address.toLowerCase() as `0x${string}`;
const USDC = TOKENS.USDC.address.toLowerCase() as `0x${string}`;
const ETHER = 10n ** 18n;
const CHAIN_TIME = 1_758_145_763;

/** 2,451.31 USDC per ETH, as `loadUsdRates` gives it: raw USDC per raw WETH, times 1e18. */
const ETH_RATE = 2_451_310_000n;

function fx(overrides: Partial<FxSnapshot> = {}): FxSnapshot {
  return {
    block: 26_000_000n,
    chainTime: CHAIN_TIME,
    rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: CHAIN_TIME - 54_000 } },
    usdc: { answer: 99_985_499n, decimals: 8, updatedAt: CHAIN_TIME - 49_000 },
    ...overrides,
  };
}

function snapshot(readAt: number): RateSnapshot {
  return { usd: new Map([[WETH, ETH_RATE], [USDC, ETHER]]), usdReadAt: readAt, fx: fx(), fxReadAt: readAt };
}

describe("twap-seen", () => {
  it("keeps rates read at most 10 minutes before the trade was seen, dated by the wall clock", () => {
    const now = 1_000_000;
    const rates = ratesSeenNow(snapshot(now - 60_000), now, 1_790_000_000);
    expect(rates?.at).toBe(1_790_000_000 - 60);
    expect(rates?.usd[WETH]).toBe(ETH_RATE.toString());
    expect(rates?.fx?.rates.EUR?.answer).toBe("114810000");
    expect(ratesSeenNow(snapshot(now - SEEN_READ_MAX_AGE_MS), now, 1_790_000_000)).not.toBeNull();
    expect(ratesSeenNow(snapshot(now - SEEN_READ_MAX_AGE_MS - 1), now, 1_790_000_000)).toBeNull();
    expect(ratesSeenNow(null, now, 1_790_000_000)).toBeNull();
  });

  it("values the sold side by the 10-minute average, native ETH as WETH", () => {
    const rates = ratesSeenNow(snapshot(0), 0, 1_790_000_000)!;
    // 0.0081589 ETH at 2,451.31: $20.00, less a rounding.
    expect(valueSeen({ token: NATIVE_TOKEN, amount: 8_158_900_000_000_000n, measured: true }, rates)).toBe(19_999_993n);
    expect(valueSeen({ token: WETH, amount: ETHER, measured: true }, rates)).toBe(2_451_310_000n);
    expect(valueSeen({ token: USDC, amount: 20_000_000n, measured: true }, rates)).toBe(20_000_000n);
  });

  it("leaves unpriced tokens and unknown amounts blank, never zero", () => {
    const rates = ratesSeenNow(snapshot(0), 0, 1_790_000_000)!;
    expect(valueSeen({ token: SPX, amount: 10n ** 8n, measured: true }, rates)).toBeNull();
    expect(valueSeen({ token: WETH, amount: null, measured: false }, rates)).toBeNull();
  });

  it("reads back only what it wrote", () => {
    const rates = ratesSeenNow(snapshot(0), 0, 1_790_000_000)!;
    expect(ratesFromStored(JSON.parse(JSON.stringify(rates)))).toEqual(rates);
    expect(ratesFromStored({ at: -1, usd: {} })).toBeNull();
    expect(ratesFromStored({ at: 1, usd: { [WETH]: "0", notAToken: "5" } })).toEqual({ at: 1, usd: {}, fx: null });
    expect(fxFromStored(fxToStored(fx()))).toEqual(fx());
  });
});

// ─── chainlink-at-block ───────────────────────────────────────────────────────

/** Chainlink's answers at a block, as `readChainlinkAt` returns them, each updated 10 minutes before it. */
function at(answers: { ETH?: bigint; USDC?: bigint }, time = CHAIN_TIME): FxSnapshot {
  const answer = (value: bigint | undefined) => (value === undefined ? null : { answer: value, decimals: 8, updatedAt: time - 600 });
  return { block: 26_000_000n, chainTime: time, rates: {}, usdc: answer(answers.USDC), eth: answer(answers.ETH) };
}

describe("chainlink-at-block", () => {
  it("values ETH and WETH by ETH/USD and USDC by USDC/USD, and SPX not at all", () => {
    const read = at({ ETH: 245_131_000_000n, USDC: 99_985_499n });
    expect(valueAtBlock({ token: NATIVE_TOKEN, amount: ETHER, measured: true }, read)).toBe(2_451_310_000n);
    expect(valueAtBlock({ token: WETH, amount: ETHER / 2n, measured: true }, read)).toBe(1_225_655_000n);
    expect(valueAtBlock({ token: USDC, amount: 20_000_000n, measured: true }, read)).toBe(19_997_099n);
    expect(valueAtBlock({ token: SPX, amount: 10n ** 8n, measured: true }, read)).toBeNull();
    expect(fillable({ token: SPX, amount: 1n, measured: true })).toBe(false);
    expect(fillable({ token: WETH, amount: null, measured: false })).toBe(false);
    expect(fillable({ token: NATIVE_TOKEN, amount: 1n, measured: true })).toBe(true);
  });

  it("prices nothing from a negative or missing answer", () => {
    expect(valueAtBlock({ token: WETH, amount: ETHER, measured: true }, at({ ETH: -5n }))).toBeNull();
    expect(valueAtBlock({ token: WETH, amount: ETHER, measured: true }, at({ USDC: 99_985_499n }))).toBeNull();
    expect(valueAtBlock({ token: WETH, amount: ETHER, measured: true }, { block: 1n, chainTime: CHAIN_TIME, rates: {}, usdc: null })).toBeNull();
  });

  it("refuses an ETH/USD answer too old to describe the block", () => {
    const read = at({ ETH: 245_131_000_000n });
    const fresh = { ...read, eth: { ...read.eth!, updatedAt: CHAIN_TIME - ETH_USD_MAX_AGE_SECONDS } };
    const old = { ...read, eth: { ...read.eth!, updatedAt: CHAIN_TIME - ETH_USD_MAX_AGE_SECONDS - 1 } };
    expect(valueAtBlock({ token: WETH, amount: ETHER, measured: true }, fresh)).toBe(2_451_310_000n);
    expect(valueAtBlock({ token: WETH, amount: ETHER, measured: true }, old)).toBeNull();
  });
});

describe("in the person's currency", () => {
  it("converts through the answer held at the time, and passes dollars through", () => {
    // $20 at 1.14810 dollars per euro: €17.42.
    expect(rowValueIn({ valueUsd: 20_000_000n, rates: fx() }, "EUR")).toEqual({ minor6: 17_420_085n, currency: "EUR" });
    expect(rowValueIn({ valueUsd: 20_000_000n, rates: null }, "USD")).toEqual({ minor6: 20_000_000n, currency: "USD" });
    expect(rowValueIn({ valueUsd: null, rates: fx() }, "USD")).toBeNull();
    expect(rowValueShown({ valueUsd: 20_000_000n, rates: null }, "USD")).toEqual({ value: { minor6: 20_000_000n, currency: "USD" }, fellBack: false });
  });

  it("leaves a currency blank when its answer then was stale or missing, and shows dollars instead", () => {
    const stale = fx({ rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: CHAIN_TIME - 432_001 } } });
    const row = { valueUsd: 20_000_000n, rates: stale };
    expect(rowValueIn(row, "EUR")).toBeNull();
    expect(rowValueIn(row, "GBP")).toBeNull();
    expect(rowValueShown(row, "EUR")).toEqual({ value: { minor6: 20_000_000n, currency: "USD" }, fellBack: true });
    expect(rowValueShown({ valueUsd: null, rates: stale }, "EUR")).toBeNull();
  });
});
