/**
 * This browser's view and One-time pair.
 *
 * Both default toward the newcomer (Simple, ETH → SPX) whenever storage is
 * missing, throws, or holds anything but what this code writes. The e2e
 * fixture seeds `spdex.swap.pair.v1` as `{"in":"WETH","out":"SPX"}`, so that
 * exact shape is pinned here too.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAIR,
  createPrefStore,
  isUsablePair,
  loadPair,
  pairAfterPick,
  loadView,
  PAIR_KEY,
  readPref,
  savePair,
  saveView,
  VIEW_KEY,
  writePref,
  type Pref,
  type PrefStorage,
  type StorageChange,
  type StorageEvents,
} from "./prefs.js";

function memory(initial: Record<string, string> = {}): PrefStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const throwing: PrefStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("view", () => {
  it("is Simple unless Expert was saved", () => {
    expect(loadView(memory())).toBe("recommended");
    expect(loadView(memory({ [VIEW_KEY]: "expert" }))).toBe("expert");
    expect(loadView(memory({ [VIEW_KEY]: "EXPERT" }))).toBe("recommended");
    expect(loadView(null)).toBe("recommended");
    expect(loadView(throwing)).toBe("recommended");
  });

  it("round-trips, and a failing store is not an error", () => {
    const storage = memory();
    saveView("expert", storage);
    expect(loadView(storage)).toBe("expert");
    expect(() => saveView("expert", throwing)).not.toThrow();
  });
});

describe("pair", () => {
  it("starts newcomers on ETH → SPX", () => {
    expect(DEFAULT_PAIR).toEqual({ in: "ETH", out: "SPX" });
    expect(loadPair(memory())).toEqual({ in: "ETH", out: "SPX" });
    expect(loadPair(null)).toEqual({ in: "ETH", out: "SPX" });
    expect(loadPair(throwing)).toEqual({ in: "ETH", out: "SPX" });
  });

  it("reads the fixture's WETH → SPX pin", () => {
    expect(loadPair(memory({ [PAIR_KEY]: '{"in":"WETH","out":"SPX"}' }))).toEqual({ in: "WETH", out: "SPX" });
  });

  it("falls back on anything it did not write", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '"ETH"',
      '{"in":"ETH"}',
      '{"in":1,"out":2}',
      '{"in":"DOGE","out":"SPX"}',
      '{"in":"SPX","out":"SPX"}',
      '{"in":"ETH","out":"WETH"}',
      '{"in":"WETH","out":"ETH"}',
    ]) {
      expect(loadPair(memory({ [PAIR_KEY]: raw })), raw).toEqual(DEFAULT_PAIR);
    }
  });

  it("saves only a usable pair", () => {
    const storage = memory();
    savePair({ in: "USDC", out: "SPX" }, storage);
    expect(storage.data.get(PAIR_KEY)).toBe('{"in":"USDC","out":"SPX"}');
    savePair({ in: "SPX", out: "SPX" }, storage);
    expect(storage.data.get(PAIR_KEY)).toBe('{"in":"USDC","out":"SPX"}');
    expect(() => savePair({ in: "ETH", out: "SPX" }, throwing)).not.toThrow();
  });

  it("swaps the two sides when a pick names the token already on the other one", () => {
    const pair = { in: "ETH", out: "SPX" };
    expect(pairAfterPick(pair, "in", "SPX")).toEqual({ in: "SPX", out: "ETH" });
    expect(pairAfterPick(pair, "out", "ETH")).toEqual({ in: "SPX", out: "ETH" });
    expect(pairAfterPick(pair, "in", "USDC")).toEqual({ in: "USDC", out: "SPX" });
    expect(pairAfterPick(pair, "out", "USDC")).toEqual({ in: "ETH", out: "USDC" });
    expect(pairAfterPick(pair, "in", "ETH")).toEqual(pair);
  });

  it("knows a wrap is not a pair", () => {
    expect(isUsablePair({ in: "ETH", out: "SPX" })).toBe(true);
    expect(isUsablePair({ in: "ETH", out: "WETH" })).toBe(false);
    expect(isUsablePair({ in: "ETH", out: "ETH" })).toBe(false);
  });
});

describe("a preference store", () => {
  const COUNT: Pref<number> = {
    key: "spdex.test.count.v1",
    parse: (raw) => (raw === null ? 0 : (JSON.parse(raw) as { n: number }).n),
    format: (n) => (n === 0 ? null : JSON.stringify({ n })),
  };
  const removable = () => {
    const storage = memory();
    return Object.assign(storage, { removeItem: (key: string) => void storage.data.delete(key) });
  };

  it("reads once, writes each change back, tells subscribers, and removes the key for a cleared value", () => {
    const storage = removable();
    storage.data.set(COUNT.key, '{"n":2}');
    const store = createPrefStore(COUNT, storage);
    const told: number[] = [];
    store.subscribe(() => told.push(store.get()));
    expect(store.get()).toBe(2);
    store.set(2);
    store.set(3);
    expect(storage.data.get(COUNT.key)).toBe('{"n":3}');
    store.set(0);
    expect(storage.data.has(COUNT.key)).toBe(false);
    expect(told).toEqual([3, 0]);
  });

  it("reads JSON that doesn't parse, and storage that throws, as the default, and keeps a change for the visit", () => {
    expect(readPref(COUNT, memory({ [COUNT.key]: "{" }))).toBe(0);
    const store = createPrefStore(COUNT, throwing);
    expect(store.get()).toBe(0);
    store.set(5);
    expect(store.get()).toBe(5);
    expect(() => writePref(COUNT, 1, throwing)).not.toThrow();
  });

  it("takes up another tab's write to its key, and a cleared storage, until disposed", () => {
    const storage = removable();
    const listeners = new Set<(event: StorageChange) => void>();
    const events: StorageEvents = {
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
    };
    const fire = (key: string | null, newValue: string | null, storageArea: unknown = storage) => {
      for (const listener of listeners) listener({ key, newValue, storageArea });
    };
    const store = createPrefStore(COUNT, storage, events);
    fire(COUNT.key, '{"n":7}');
    expect(store.get()).toBe(7);
    fire("spdex.other.v1", '{"n":8}');
    fire(COUNT.key, '{"n":9}', {});
    expect(store.get()).toBe(7);
    fire(null, null);
    expect(store.get()).toBe(0);
    store.dispose();
    expect(listeners.size).toBe(0);
  });
});
