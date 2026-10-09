/**
 * When the page reads rates, and what it keeps when a read fails.
 */

import { describe, expect, it } from "vitest";
import { TOKENS } from "@spdex/chain";
import { FX_REFRESH_MS, moneyView, nextSnapshot, readsDue, RETRY_MS, serviceFailure, USD_REFRESH_MS } from "./rates.js";
import type { FxSnapshot, Pricing, RateSnapshot } from "./pricing.js";

const WETH = TOKENS.WETH.address;
const SPX = TOKENS.SPX.address;
const USDC = TOKENS.USDC.address;
const FX: FxSnapshot = { block: 1n, chainTime: 1, rates: {}, usdc: null };

function snap(usdReadAt: number, fxReadAt: number | null = usdReadAt): RateSnapshot {
  return { usd: new Map([[WETH, 1n], [SPX, 2n], [USDC, 3n]]), usdReadAt, fx: fxReadAt === null ? null : FX, fxReadAt };
}

describe("readsDue", () => {
  it("reads everything the first time", () => {
    expect(readsDue({ snapshot: null, failedAt: null }, 0, false)).toEqual({ usd: true, fx: true });
  });

  it("reads dollars every 5 minutes and currencies every 15", () => {
    const last = { snapshot: snap(0), failedAt: null };
    expect(readsDue(last, USD_REFRESH_MS - 1, false)).toEqual({ usd: false, fx: false });
    expect(readsDue(last, USD_REFRESH_MS, false)).toEqual({ usd: true, fx: false });
    expect(readsDue(last, FX_REFRESH_MS, false)).toEqual({ usd: true, fx: true });
  });

  it("reads dollars at once when forced, before sizing, but not currencies read lately", () => {
    expect(readsDue({ snapshot: snap(0), failedAt: null }, 1, true)).toEqual({ usd: true, fx: false });
  });

  it("with a second opinion, reads both parts whenever either is due, so the two services are compared on reads from one pass", () => {
    const last = { snapshot: snap(0), failedAt: null };
    // A forced read of the dollars reads the currencies again too; and the reverse.
    expect(readsDue(last, 1, true, true)).toEqual({ usd: true, fx: true });
    expect(readsDue({ snapshot: { ...snap(0), usdReadAt: FX_REFRESH_MS - 1 }, failedAt: null }, FX_REFRESH_MS, false, true)).toEqual({ usd: true, fx: true });
    // Nothing due stays nothing due.
    expect(readsDue(last, USD_REFRESH_MS - 1, false, true)).toEqual({ usd: false, fx: false });
  });

  it("waits a minute after a failure unless forced", () => {
    const last = { snapshot: null, failedAt: 1_000 };
    expect(readsDue(last, 1_000 + RETRY_MS - 1, false)).toEqual({ usd: false, fx: false });
    expect(readsDue(last, 1_000 + RETRY_MS, false)).toEqual({ usd: true, fx: true });
    expect(readsDue(last, 1_001, true)).toEqual({ usd: true, fx: true });
  });
});

describe("nextSnapshot", () => {
  const fresh = new Map([[WETH, 10n], [SPX, 20n], [USDC, 3n]]);

  it("takes a successful read, with the time it started", () => {
    expect(nextSnapshot(null, 500, fresh, FX)).toEqual({
      snapshot: { usd: fresh, usdReadAt: 500, fx: FX, fxReadAt: 500 },
      usdFailed: false,
    });
  });

  it("keeps the last prices, with their old time, when a refresh prices fewer tokens", () => {
    const last = snap(0);
    const result = nextSnapshot(last, 500, new Map([[USDC, 3n]]), null);
    expect(result.usdFailed).toBe(true);
    expect(result.snapshot).toEqual(last);
  });

  it("counts a first read that priced nothing but USDC as failed", () => {
    expect(nextSnapshot(null, 500, new Map([[USDC, 3n]]), FX)).toEqual({ snapshot: null, usdFailed: true });
  });

  it("keeps the last currency rates when their read fails", () => {
    const last = snap(0, 0);
    expect(nextSnapshot(last, 500, fresh, null).snapshot).toEqual({ usd: fresh, usdReadAt: 500, fx: FX, fxReadAt: 0 });
  });
});

describe("moneyView", () => {
  const pricing = (snapshot: RateSnapshot | null): Pricing => ({
    snapshot,
    state: "ready",
    currency: "EUR",
    locale: "de-DE",
    lastHiddenAt: null,
    request: () => undefined,
    reread: async () => null,
  });

  it("shows figures from rates up to 30 minutes old, in the chosen currency", () => {
    expect(moneyView(pricing(snap(0)), 1_800_000)).toMatchObject({ currency: "EUR", locale: "de-DE", fx: FX });
    expect(moneyView(pricing(snap(0)), 1_800_001)).toBeUndefined();
    expect(moneyView(pricing(null), 0)).toBeUndefined();
  });

  it("shows nothing without Pricing", () => {
    expect(moneyView(undefined, 0)).toBeUndefined();
    expect(moneyView(null, 0)).toBeUndefined();
  });
});

describe("serviceFailure", () => {
  it("says the network service is why a dollar read failed, as the error banner reads it", () => {
    expect(serviceFailure(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(serviceFailure(Object.assign(new Error("eth_call: HTTP 503"), { status: 503 }))).toBe("unreachable");
    expect(serviceFailure(new Error("eth_call: Your app has exceeded its compute units per second capacity."))).toBe("busy");
    expect(serviceFailure(new Error("eth_call: HTTP 429"))).toBe("busy");
    expect(serviceFailure(new Error("eth_call: Monthly capacity limit exceeded."))).toBe("refused");
  });

  it("is null when nothing was thrown, or when what was thrown isn't the service's", () => {
    expect(serviceFailure(null)).toBeNull();
    expect(serviceFailure(undefined)).toBeNull();
    expect(serviceFailure(new Error("tick out of range"))).toBeNull();
  });
});
