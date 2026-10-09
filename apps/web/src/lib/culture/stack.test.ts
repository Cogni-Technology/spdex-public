import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import type { FxSnapshot, Pricing } from "../money/pricing.js";
import type { RecordRow } from "../records/types.js";
import { readPref, writePref } from "../prefs.js";
import { YourStack, stackSummary } from "../../components/culture/YourStack.js";
import {
  STACK_GOAL_KEY,
  buysText,
  canCard,
  feesText,
  goalProgress,
  putInText,
  putInValue,
  putInValueText,
  STACK_GOAL,
  spxText,
  summariseStack,
  valueAtTheTime,
  type StackInput,
  type StackVault,
} from "./stack.js";

const ME = "0x00000000000000000000000000000000000a11ce" as Address;
const SOMEONE = "0x0000000000000000000000000000000000000b0b" as Address;
const SPX = TOKENS.SPX.address;
const USDC = TOKENS.USDC.address;
const CHAIN = 1;
const SPX_UNIT = 10n ** 8n;
const ETHER = 10n ** 18n;
const T0 = 1_780_000_000;

/** A rate snapshot as a record keeps it: EUR at $1.148, updated an hour before the block. */
const RATES: FxSnapshot = {
  block: 26_000_000n,
  chainTime: T0,
  rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: T0 - 3_600 } },
  usdc: null,
};

let n = 0;
function row(over: Partial<RecordRow> = {}): RecordRow {
  n += 1;
  return {
    id: `row-${n}`,
    kind: "swap",
    chainId: CHAIN,
    account: ME,
    at: { unix: T0 + n * 60, source: "block" },
    block: 26_000_000n + BigInt(n),
    hashes: [`0x${n.toString(16).padStart(64, "0")}` as Hex],
    sold: { token: NATIVE_TOKEN, amount: ETHER / 100n, measured: true },
    bought: { token: SPX, amount: 100n * SPX_UNIT, measured: true },
    buyFee: 0n,
    networkFee: 10n ** 14n,
    valueUsd: 25_000_000n,
    rates: RATES,
    valueSource: "twap-seen",
    ...over,
  };
}

const vault = (over: Partial<StackVault> = {}): StackVault => ({
  vault: "0x00000000000000000000000000000000000fa017" as Address,
  totalOut: 800n * SPX_UNIT,
  buysDone: 8n,
  amountPerBuy: ETHER / 100n,
  keeperReward: 15n * 10n ** 13n,
  tokenOut: SPX,
  ...over,
});

const input = (over: Partial<StackInput> = {}): StackInput => ({ account: ME, chainId: CHAIN, rows: [], vaults: [], truncated: [], ...over });

describe("summariseStack", () => {
  it("adds this account's swaps and plan buys to its vaults' own counters", () => {
    const s = summariseStack(input({ rows: [row(), row({ kind: "plan-buy" })], vaults: [vault()] }));
    expect(s.stacked).toEqual({ amount: 1_000n * SPX_UNIT, atLeast: false });
    expect(s.buys).toEqual({ total: 10, swaps: 1, planBuys: 1, vaultBuys: 8 });
    expect(buysText(s.buys)).toBe("10 buys: 1 swap, 1 plan buy you confirmed, 8 vault buys");
    // ETH and a vault's WETH are one entry: 0.01 + 0.01 + 8 × 0.01.
    expect(putInText(s.putIn.tokens)).toBe("0.1 ETH");
    expect(s.vaultFees).toBe(8n * 15n * 10n ** 13n);
    expect(feesText(s.vaultFees)).toBe("Before fees: 0.0012 ETH in vault buy fees, and network fees");
    expect(feesText(0n)).toBe("Before fees");
    // One kind of buy needs no breakdown.
    expect(buysText({ total: 3, swaps: 3, planBuys: 0, vaultBuys: 0 })).toBe("3 buys");
  });

  it("takes vault figures from the vault, never from its rows, even when the rows are incomplete", () => {
    // Two of eight buys made it into the history; the vault's counters say eight.
    const history = [row({ kind: "vault-buy", bought: { token: SPX, amount: 100n * SPX_UNIT, measured: true } }), row({ kind: "vault-buy" })];
    const s = summariseStack(input({ rows: history, vaults: [vault()] }));
    expect(s.stacked.amount).toBe(800n * SPX_UNIT);
    expect(s.buys.vaultBuys).toBe(8);
    expect(putInText(s.putIn.tokens)).toBe("0.08 ETH");
    // …but they do date the first buy.
    expect(s.firstBuyAt).toBe(history[0]!.at.unix);
  });

  it("leaves out rows of another account, another chain, a wallet it couldn't tell, and tips", () => {
    const rows = [row({ account: SOMEONE }), row({ chainId: 690069 }), row({ account: null }), row({ kind: "tip" as RecordRow["kind"] })];
    const s = summariseStack(input({ rows }));
    expect(s.stacked).toEqual({ amount: 0n, atLeast: false });
    expect(s.buys.total).toBe(0);
    expect(buysText(s.buys)).toBe("None recorded in this browser yet");
    expect(putInText(s.putIn.tokens)).toBe("nothing yet");
    expect(s.latest).toBeNull();
  });

  it("counts an unknown amount as nothing and says \"at least\", never 0", () => {
    const s = summariseStack(input({ rows: [row(), row({ bought: { token: SPX, amount: null, measured: false } }), row({ sold: { token: USDC, amount: null, measured: false } })] }));
    expect(s.stacked).toEqual({ amount: 200n * SPX_UNIT, atLeast: true });
    expect(s.putIn.atLeast).toBe(true);
    expect(s.notes).toEqual([
      "1 buy's SPX couldn't be read, so it isn't counted.",
      "What 1 buy spent couldn't be read, so it isn't counted in Put in.",
    ]);
  });

  it("says \"at least\" when this browser no longer lists a plan's first buys", () => {
    const s = summariseStack(input({ rows: [row({ kind: "plan-buy" })], truncated: [{ planLabel: "Daily SPX", missing: 3 }] }));
    expect(s.stacked.atLeast).toBe(true);
    expect(s.putIn.atLeast).toBe(true);
    expect(s.notes).toContain("The first 3 buys of “Daily SPX” aren't listed in this browser any more, so they aren't counted here.");
  });

  it("notes SPX sold with spDEX, and keeps Stacked gross", () => {
    const sale = row({ sold: { token: SPX, amount: 30n * SPX_UNIT, measured: true }, bought: { token: NATIVE_TOKEN, amount: ETHER / 1000n, measured: true } });
    const s = summariseStack(input({ rows: [row(), sale] }));
    expect(s.stacked.amount).toBe(100n * SPX_UNIT);
    expect(s.soldSpx).toEqual({ amount: 30n * SPX_UNIT, atLeast: false });
    expect(s.buys.total).toBe(1);
  });

  it("offers a card only of measured SPX a pool or vault delivered, newest first", () => {
    const older = row();
    const unmeasured = row({ bought: { token: SPX, amount: 5n, measured: false } });
    const newer = row({ kind: "plan-buy" });
    expect(canCard(unmeasured)).toBe(false);
    expect(canCard(row({ kind: "tip" as RecordRow["kind"] }))).toBe(false);
    expect(canCard(row({ hashes: [] }))).toBe(false);
    expect(summariseStack(input({ rows: [older, unmeasured, newer] })).latest).toBe(newer);
  });
});

describe("value at the time", () => {
  it("is each row's own dollars, or its own rate for another currency; never a rate from another time", () => {
    const r = row({ valueUsd: 114_810_000n });
    expect(valueAtTheTime(r, "USD")).toEqual({ minor6: 114_810_000n, currency: "USD" });
    expect(valueAtTheTime(r, "EUR")).toEqual({ minor6: 100_000_000n, currency: "EUR" });
    expect(valueAtTheTime(r, "GBP")).toBeNull();
    expect(valueAtTheTime(row({ valueUsd: null }), "USD")).toBeNull();
    const stale = { ...RATES, rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: T0 - 432_001 } } };
    expect(valueAtTheTime(row({ rates: stale }), "EUR")).toBeNull();
    const wrongDecimals = { ...RATES, rates: { EUR: { answer: 114_810_000n, decimals: 18, updatedAt: T0 } } };
    expect(valueAtTheTime(row({ rates: wrongDecimals }), "EUR")).toBeNull();
  });

  it("sums the priced buys, and says how many of all the buys that is", () => {
    const s = summariseStack(input({ rows: [row(), row(), row({ valueUsd: null, valueSource: null })], vaults: [vault()] }));
    const value = putInValue(s, "USD");
    expect(value).toEqual({ value: { minor6: 50_000_000n, currency: "USD" }, priced: 2, of: 11, inDollars: false });
    expect(putInValueText(value, "en-US", "USD")).toBe("≈ $50.00 for 2 of 11 buys; the other 9 weren't priced at the time");
    const all = putInValue(summariseStack(input({ rows: [row(), row()] })), "EUR");
    expect(putInValueText(all, "de-DE", "EUR")).toBe("≈ 43,55\u00a0€ at the time of each buy");
  });

  it("falls back to dollars, and says so, when a priced buy kept no rate for the chosen currency", () => {
    const s = summariseStack(input({ rows: [row(), row({ rates: null })] }));
    const value = putInValue(s, "EUR");
    expect(value).toMatchObject({ value: { currency: "USD", minor6: 50_000_000n }, inDollars: true });
    expect(putInValueText(value, "en-US", "EUR")).toBe("≈ $50.00 at the time of each buy (in dollars: a EUR rate wasn't kept for every buy)");
  });

  it("gives no figure at all when nothing was priced: never €0", () => {
    const s = summariseStack(input({ rows: [row({ valueUsd: null, valueSource: null })] }));
    expect(putInValue(s, "EUR")).toBeNull();
    expect(putInValueText(null, "en-US", "EUR")).toBeNull();
  });
});

describe("the goal", () => {
  class Store {
    map = new Map<string, string>();
    getItem = (k: string) => this.map.get(k) ?? null;
    setItem = (k: string, v: string) => void this.map.set(k, v);
  }

  it("measures the wallet's holding, however the SPX got there", () => {
    expect(goalProgress(4_120n * SPX_UNIT, 6_900n * SPX_UNIT)).toEqual({ percent: 59, reached: false });
    expect(goalProgress(null, 6_900n * SPX_UNIT)).toEqual({ percent: null, reached: null });
  });

  it("is reached at 100% or more, and never reads 100% before", () => {
    expect(goalProgress(6_900n * SPX_UNIT - 1n, 6_900n * SPX_UNIT)).toEqual({ percent: 99, reached: false });
    expect(goalProgress(6_900n * SPX_UNIT, 6_900n * SPX_UNIT)).toEqual({ percent: 100, reached: true });
    expect(goalProgress(70_000n * SPX_UNIT, 6_900n * SPX_UNIT)).toEqual({ percent: 100, reached: true });
  });

  it("is kept in this browser as {spx}, and anything else stored reads as no goal", () => {
    const store = new Store();
    expect(readPref(STACK_GOAL, store)).toBeNull();
    writePref(STACK_GOAL, 6_900n * SPX_UNIT, store);
    expect(store.map.get(STACK_GOAL_KEY)).toBe('{"spx":"6900"}');
    expect(readPref(STACK_GOAL, store)).toBe(6_900n * SPX_UNIT);
    writePref(STACK_GOAL, 1_234_50000000n, store);
    expect(store.map.get(STACK_GOAL_KEY)).toBe('{"spx":"1234.5"}');
    writePref(STACK_GOAL, null, store);
    expect(store.map.get(STACK_GOAL_KEY)).toBe("null");
    expect(readPref(STACK_GOAL, store)).toBeNull();
    for (const junk of ["{", '{"spx":6900}', '{"spx":"-1"}', '{"spx":"0"}', '{"spx":"1e9"}', '{"spx":"1,000"}', "[]"]) {
      store.map.set(STACK_GOAL_KEY, junk);
      expect(readPref(STACK_GOAL, store)).toBeNull();
    }
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readPref(STACK_GOAL, throwing)).toBeNull();
    expect(() => writePref(STACK_GOAL, 1n, throwing)).not.toThrow();
  });
});

describe("words", () => {
  it("cuts SPX to two places from 1 SPX, and shows all eight below", () => {
    expect(spxText(3_610_34567891n)).toBe("3,610.34 SPX");
    expect(spxText(12_345n)).toBe("0.00012345 SPX");
    expect(spxText(0n)).toBe("0 SPX");
  });
});

describe("the Your SPX tile's summary", () => {
  const at = (over: Partial<Parameters<typeof stackSummary>[0]>) =>
    stackSummary({ account: ME, chainId: CHAIN, holding: 4_267_12n * 10n ** 6n, holdingState: "read", ...over }).text;

  it("is the SPX in this wallet, and never 0 for a figure it doesn't have", () => {
    expect(at({})).toBe("4,267.12 SPX");
    expect(at({ account: null })).toBe("connect a wallet");
    expect(at({ chainId: 8453 })).toBe("Ethereum only");
    expect(at({ holding: null, holdingState: "idle" })).toBe("not read yet");
    expect(at({ holding: null, holdingState: "reading" })).toBe("reading…");
    expect(at({ holding: null, holdingState: "unreadable" })).toBe("unknown");
    // With no state given, a missing figure is unknown, not zero.
    expect(stackSummary({ account: ME, chainId: CHAIN, holding: null }).text).toBe("unknown");
    expect(at({ holding: 0n })).toBe("0 SPX");
  });
});

describe("Your stack, rendered", () => {
  const pricing = { currency: "EUR", locale: "en-US" } as Pricing;
  const render = (over: Partial<Parameters<typeof YourStack>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(YourStack, {
        account: ME,
        chainId: CHAIN,
        holding: 4_120n * SPX_UNIT,
        rows: [row(), row()],
        vaults: [vault()],
        truncated: [],
        buysLeft: 14,
        pricing,
        onMakeCard: () => {},
        storage: null,
        ...over,
      }),
    );

  it("shows money only inside Put in", () => {
    const html = render();
    const putIn = /<div class="spdex-stat spdex-stack__putin" data-testid="stack-put-in">.*?<\/div>/.exec(html)![0];
    expect(putIn).toMatch(/≈ €/);
    const rest = html.replace(putIn, "").replace(/<[^>]+>/g, " ");
    expect(rest).not.toMatch(/[$€£¥₩]|\b(USD|EUR)\b/);
    // The saying's link stays; the line that restated it went.
    expect(rest).not.toContain("No price, no chart");
    expect(rest).toContain("PERSIST FOREVER");
  });

  it("renders nothing without a wallet, or off Ethereum and the fork", () => {
    expect(render({ account: null })).toBe("");
    expect(render({ chainId: 8453 })).toBe("");
  });

  it("in a tile, says what connecting shows instead of nothing, and drops its panel", () => {
    const empty = render({ account: null, open: true, onConnect: () => {} });
    expect(empty).toContain('data-testid="yours-empty"');
    expect(empty).toContain('data-testid="yours-connect"');
    expect(empty.replace(/<[^>]+>/g, " ")).toContain("Connect a wallet to see your SPX and records.");
    expect(render({ chainId: 8453, open: true })).toContain("Your SPX shows on Ethereum only.");
    const card = render({ open: true });
    expect(card).toContain('data-testid="stack-card"');
    expect(card).not.toContain("spdex-panel__title");
  });

  it("says reading, not 0, while the records load, and unknown when they can't be read", () => {
    expect(render({ recordsState: "loading", rows: [] })).toContain("reading…");
    const unread = render({ recordsState: "unavailable", rows: [] });
    expect(unread).toMatch(/data-testid="stack-stacked">unknown/);
    expect(unread).not.toMatch(/data-testid="stack-stacked">0/);
  });
});
