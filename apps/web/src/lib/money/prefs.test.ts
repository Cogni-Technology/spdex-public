/**
 * This browser's money preferences: read field by field, written only where
 * the person chose, and kept in step across tabs.
 */

import { describe, expect, it } from "vitest";
import { createMoneyStore, parseStoredPrefs, readMoneyPrefs, rememberUnit } from "./prefs.js";
import { MONEY_PREFS_KEY } from "./pricing.js";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function events() {
  const listeners = new Set<(event: { key: string | null; newValue: string | null; storageArea: unknown }) => void>();
  return {
    addEventListener: (_: "storage", l: (event: { key: string | null; newValue: string | null; storageArea: unknown }) => void) =>
      void listeners.add(l),
    removeEventListener: (_: "storage", l: (event: { key: string | null; newValue: string | null; storageArea: unknown }) => void) =>
      void listeners.delete(l),
    fire: (event: { key: string | null; newValue: string | null; storageArea: unknown }) => listeners.forEach((l) => l(event)),
  };
}

describe("reading", () => {
  it("defaults every field: the region's currency, the browser's numbers, no unit chosen", () => {
    expect(readMoneyPrefs(memory(), ["de-DE"])).toEqual({ currency: "EUR", numbers: "auto", units: { once: null, recurring: null } });
    expect(readMoneyPrefs(null, [])).toEqual({ currency: "USD", numbers: "auto", units: { once: null, recurring: null } });
  });

  it("reads what the e2e fixtures write, units and nothing else", () => {
    const storage = memory({ [MONEY_PREFS_KEY]: JSON.stringify({ units: { once: "token", recurring: "token" } }) });
    expect(readMoneyPrefs(storage, ["ja-JP"])).toEqual({ currency: "JPY", numbers: "auto", units: { once: "token", recurring: "token" } });
  });

  it("falls back field by field, never throwing", () => {
    expect(parseStoredPrefs("not json")).toEqual({});
    expect(parseStoredPrefs("[1,2]")).toEqual({});
    expect(parseStoredPrefs(JSON.stringify({ currency: "INR", numbers: "de-DE", units: { once: "local", recurring: "EUR" } }))).toEqual({
      numbers: "de-DE",
      units: { recurring: "EUR" },
    });
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(readMoneyPrefs(throwing, []).currency).toBe("USD");
  });
});

describe("the store", () => {
  it("writes only what the person changed, so a default keeps following the browser", () => {
    const storage = memory();
    const store = createMoneyStore({ storage, languages: ["en-US"] });
    rememberUnit("once", "token", store);
    expect(JSON.parse(storage.data.get(MONEY_PREFS_KEY)!)).toEqual({ units: { once: "token" } });
    store.set({ ...store.get(), currency: "EUR" });
    expect(JSON.parse(storage.data.get(MONEY_PREFS_KEY)!)).toEqual({ currency: "EUR", units: { once: "token" } });
    expect(store.get()).toEqual({ currency: "EUR", numbers: "auto", units: { once: "token", recurring: null } });
  });

  it("tells subscribers once per change, and keeps get() stable between changes", () => {
    const store = createMoneyStore({ storage: memory(), languages: [] });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    const before = store.get();
    expect(store.get()).toBe(before);
    store.set({ ...before, numbers: "de-DE" });
    store.set({ ...store.get(), numbers: "de-DE" });
    expect(calls).toBe(1);
  });

  it("sets the page's number format when made and when the style changes", () => {
    const locales: string[] = [];
    const store = createMoneyStore({ storage: memory(), languages: [], onLocale: (l) => locales.push(l) });
    store.set({ ...store.get(), numbers: "fr-FR" });
    expect(locales.at(-1)).toBe("fr-FR");
    expect(locales).toHaveLength(2);
  });

  it("follows a change made in another tab", () => {
    const storage = memory();
    const bus = events();
    const store = createMoneyStore({ storage, events: bus, languages: [] });
    bus.fire({ key: MONEY_PREFS_KEY, newValue: JSON.stringify({ currency: "GBP" }), storageArea: storage });
    expect(store.get().currency).toBe("GBP");
    // Another storage area (sessionStorage in a frame) is not this one.
    bus.fire({ key: MONEY_PREFS_KEY, newValue: JSON.stringify({ currency: "JPY" }), storageArea: {} });
    expect(store.get().currency).toBe("GBP");
    // Cleared elsewhere: back to the defaults.
    bus.fire({ key: null, newValue: null, storageArea: storage });
    expect(store.get().currency).toBe("USD");
  });

  it("keeps working when storage refuses writes", () => {
    const store = createMoneyStore({ storage: { getItem: () => null, setItem: () => { throw new Error("full"); } }, languages: [] });
    store.set({ ...store.get(), currency: "CHF" });
    expect(store.get().currency).toBe("CHF");
  });
});
