/**
 * The tiles: the list, what opens on load, and where `reveal` may put focus.
 *
 * Node has no DOM, so the focus rule is checked on a small fake element tree
 * whose `matches` understands the selectors the rule uses; shell.spec checks
 * the same rule on the real page.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPEN,
  initialOpen,
  isTileId,
  marketsSummary,
  MONEY_CONTROLS,
  receiptSummary,
  safeFocusTarget,
  settingsSummary,
  startSummary,
  TILE_ORDER,
  TILES,
  tradeSummary,
  yoursSummary,
  type FocusCandidate,
} from "./tiles.js";

describe("the tile list", () => {
  it("has at most eight tiles, each with a chip and a title", () => {
    expect(TILE_ORDER.length).toBeLessThanOrEqual(8);
    expect(new Set(TILE_ORDER).size).toBe(TILE_ORDER.length);
    expect(Object.keys(TILES).sort()).toEqual([...TILE_ORDER].sort());
    for (const id of TILE_ORDER) {
      expect(TILES[id].chip, id).toMatch(/^[A-Z]{2,8}$/);
      // Titles are at most four words, in sentence case (CSS shows them in capitals).
      expect(TILES[id].title.split(" ").length, id).toBeLessThanOrEqual(4);
      expect(TILES[id].title, id).not.toBe(TILES[id].title.toUpperCase());
    }
  });

  it("puts Trade first after the tiles that come and go, and Settings last", () => {
    expect(TILE_ORDER.indexOf("trade")).toBe(2);
    expect(TILE_ORDER.at(-1)).toBe("settings");
  });

  it("opens a pending receipt on load, else Welcome while it shows, else Buy SPX: never nothing", () => {
    expect(DEFAULT_OPEN).toBe("trade");
    expect(initialOpen({ receiptPending: true, welcomeShown: true })).toBe("receipt");
    expect(initialOpen({ receiptPending: true, welcomeShown: false })).toBe("receipt");
    expect(initialOpen({ receiptPending: false, welcomeShown: true })).toBe("start");
    expect(initialOpen({ receiptPending: false, welcomeShown: false })).toBe(DEFAULT_OPEN);
  });

  it("knows its own ids", () => {
    expect(isTileId("trade")).toBe(true);
    expect(isTileId("expert")).toBe(false);
    expect(isTileId(undefined)).toBe(false);
  });
});

// ─── A fake element tree for the focus rule ──────────────────────────────────

class El implements FocusCandidate {
  parentElement: El | null = null;
  readonly children: El[] = [];
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string> = {},
  ) {}
  add(...children: El[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  /** One compound selector: a tag, then attribute tests and `:not(...)`. */
  private matchesOne(selector: string): boolean {
    let rest = selector.trim();
    const tag = /^[a-z]+/.exec(rest)?.[0];
    if (tag !== undefined) {
      if (tag !== this.tag) return false;
      rest = rest.slice(tag.length);
    }
    while (rest.length > 0) {
      const not = /^:not\((.+?\])\)/.exec(rest);
      if (not) {
        if (this.matchesOne(not[1]!)) return false;
        rest = rest.slice(not[0].length);
        continue;
      }
      const attr = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/.exec(rest);
      if (!attr) throw new Error(`the fake can't read ${selector}`);
      const value = this.attrs[attr[1]!];
      if (value === undefined) return false;
      if (attr[2] === "=" && value !== attr[3]) return false;
      if (attr[2] === "^=" && !value.startsWith(attr[3]!)) return false;
      rest = rest.slice(attr[0].length);
    }
    return true;
  }
  matches(selector: string): boolean {
    return selector.split(/,\s*/).some((s) => this.matchesOne(s));
  }
  querySelector(selector: string): El | null {
    const scoped = selector.replace(/^:scope\s*>\s*/, "");
    for (const child of this.children) {
      if (child.matches(scoped)) return child;
      if (scoped === selector) {
        const deeper = child.querySelector(selector);
        if (deeper) return deeper;
      }
    }
    return null;
  }
  closest(selector: string): El | null {
    for (let el: El | null = this; el !== null; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }
}

describe("where reveal puts focus (UI rule R2, docs/ARCHITECTURE.md)", () => {
  it("focuses an ordinary control, or a section's summary", () => {
    const link = new El("a", { href: "#x", "data-testid": "activity-csv" });
    expect(safeFocusTarget(link)).toEqual({ target: link, makeFocusable: false });
    const summary = new El("summary");
    const section = new El("details", { "data-testid": "settings-network" }).add(summary);
    expect(safeFocusTarget(section)).toEqual({ target: summary, makeFocusable: false });
  });

  it("makes a plain container focusable rather than jump to its first control", () => {
    const swap = new El("button", { "data-testid": "swap-button" });
    const panel = new El("section", { "data-testid": "swap-panel" }).add(swap);
    expect(safeFocusTarget(panel)).toEqual({ target: panel, makeFocusable: true });
  });

  it("never focuses a money control: its tabIndex=-1 container instead, or nothing", () => {
    for (const testId of ["swap-button", "fallback-accept", "accept-staged", "dca-remove-plans-confirm", "dca-vault-trigger", "permit2-revoke-WETH"]) {
      const control = new El("button", { "data-testid": testId });
      const prompt = new El("div", { tabindex: "-1", role: "group" }).add(new El("div").add(control));
      expect(safeFocusTarget(control), testId).toEqual({ target: prompt, makeFocusable: false });
      expect(safeFocusTarget(new El("button", { "data-testid": testId })), `${testId}, alone`).toBeNull();
    }
    const marked = new El("button", { "data-money-control": "" });
    expect(safeFocusTarget(marked)).toBeNull();
  });

  it("names every control UI rule R2 lists", () => {
    for (const testId of [
      "swap-button",
      "dca-form-start",
      "dca-vault-create",
      "dca-vault-fund",
      "dca-vault-close",
      "dca-vault-trigger",
      "dca-confirm-buy",
      "fallback-accept",
      "accept-staged",
      "dca-remove-plans-confirm",
      "tip-add-0x5FbDB2315678afecb367f032d93F642f64180aa3",
      "expert-tip-add-0x5FbDB2315678afecb367f032d93F642f64180aa3",
      "dca-enable",
      "rpc-use-bundled",
      "rpc-use-fallback",
      "builtin-use-fallback",
      "builtin-choose",
      "connect-button",
      "connect-to-swap",
      "status-connect",
      "yours-connect",
      "welcome-connect",
      "dca-form-connect",
      "dca-panel-connect",
      "add-network",
    ]) {
      expect(new El("button", { "data-testid": testId }).matches(MONEY_CONTROLS), testId).toBe(true);
    }
    expect(new El("button", { "data-testid": "fallback-cancel" }).matches(MONEY_CONTROLS)).toBe(false);
    expect(new El("button", { "data-testid": "dca-remove-plans-cancel" }).matches(MONEY_CONTROLS)).toBe(false);
  });
});

describe("header summaries", () => {
  it("say the pair, or that a swap is going through", () => {
    expect(tradeSummary({ tokenIn: "ETH", tokenOut: "SPX", recurring: false, swapping: false })).toEqual({ text: "ETH → SPX" });
    expect(tradeSummary({ tokenIn: "ETH", tokenOut: "SPX", recurring: true, swapping: false }).text).toBe("ETH → SPX · recurring");
    expect(tradeSummary({ tokenIn: "ETH", tokenOut: "SPX", recurring: false, swapping: true })).toEqual({ text: "Swapping…", status: "action" });
  });

  it("never show 0 for something unknown", () => {
    expect(yoursSummary({ account: false, holding: null, seen: false, records: null }).text).toBe("connect a wallet");
    expect(yoursSummary({ account: true, holding: null, seen: false, records: null }).text).toBe("not read yet");
    expect(yoursSummary({ account: true, holding: null, seen: true, records: 3 }).text).toBe("unknown · 3 records");
    expect(yoursSummary({ account: true, holding: "4,267.12", seen: true, records: 1 }).text).toBe("4,267.12 SPX · 1 record");
    expect(marketsSummary({ phase: "ready", pair: "ETH/SPX", pools: 3, total: null }).text).toBe("ETH/SPX · 3 pools · unknown");
    expect(marketsSummary({ phase: "ready", pair: "ETH/SPX", pools: 3, total: "$12.5M" }).text).toBe("ETH/SPX · $12.5M in 3 pools");
    expect(marketsSummary({ phase: "reading", pair: "ETH/SPX", pools: 3, total: null }).text).toBe("reading…");
    expect(marketsSummary({ phase: "off", pair: "ETH/SPX", pools: 0, total: null }).text).toBe("off");
    // Discovery failed (the service busy, capped or refusing): unknown, not "no markets found".
    expect(marketsSummary({ phase: "failed", pair: "ETH/SPX", pools: 0, total: null }).text).toBe("ETH/SPX · unknown");
  });

  it("count Welcome's steps, and name the rest short", () => {
    expect(startSummary(["done", "done", "current", "current"], false).text).toBe("2 of 4 done");
    expect(startSummary(["done", "done", "current", "current"], true).text).toBe("make a card");
    expect(receiptSummary(`0xab12${"0".repeat(56)}ef90`).text).toBe("0xab12…ef90");
    expect(settingsSummary({ view: "recommended", features: 3, currency: "USD" }).text).toBe("Simple · 3 features · USD");
  });

  it("stay short enough for a header", () => {
    const longest = [
      marketsSummary({ phase: "ready", pair: "WETH/USDC", pools: 12, total: "$123.45M" }).text,
      yoursSummary({ account: true, holding: "1,234,567.12", seen: true, records: 120 }).text,
      settingsSummary({ view: "expert", features: 10, currency: "EUR" }).text,
    ];
    for (const text of longest) expect(text.length, text).toBeLessThanOrEqual(42);
  });
});
