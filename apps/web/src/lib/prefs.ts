/**
 * Small facts about this browser, and how each is kept: `readPref`,
 * `writePref` and `createPrefStore`, which every per-browser preference uses
 * (the view and the One-time pair here; Welcome, the stack goal, buy-due
 * notifications and the money preferences beside their features).
 *
 * Kept out of the config for the reason `spdex.features.seen.v1` is: they are
 * not settings. A config carries them into exports, diffs and shared links,
 * where "this person last looked at Expert" would be a line of noise in the
 * one view that has to stay worth reading — and would mark an untouched
 * config as customised.
 *
 * Every read is defensive and falls back to the newcomer's default. Storage
 * can throw (private browsing, a blocked site), hold something an older build
 * wrote, or hold something a person typed into devtools; none of that may
 * stop the page from rendering.
 */

import { useSyncExternalStore } from "react";
import { pageStorage } from "./page.js";
import { TOKEN_LIST } from "./tokens.js";

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Used when a preference is cleared rather than set (`Pref.format` returns null). */
  removeItem?(key: string): void;
}

/** One preference: the versioned key it is kept under, and how it is read and written. */
export interface Pref<T> {
  /** "spdex.<name>.v<N>": a new shape gets a new key, so no build misreads another's value. */
  key: string;
  /**
   * What storage holds (null for nothing) as a value, falling back to the
   * default for anything this code didn't write. It may throw, on JSON that
   * doesn't parse say: that reads as `parse(null)`.
   */
  parse(raw: string | null): T;
  /** What to keep for `value`; null removes the key. */
  format(value: T): string | null;
}

/** `pref` as this browser holds it, or its default when storage is missing, throws or holds anything else. */
export function readPref<T>(pref: Pref<T>, storage: PrefStorage | null = pageStorage()): T {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(pref.key) ?? null;
  } catch {
    raw = null;
  }
  try {
    return pref.parse(raw);
  } catch {
    return pref.parse(null);
  }
}

/** Keeps `value`; a full quota or private mode leaves it for this visit only, and never throws. */
export function writePref<T>(pref: Pref<T>, value: T, storage: PrefStorage | null = pageStorage()): void {
  if (!storage) return;
  try {
    const text = pref.format(value);
    if (text === null) storage.removeItem?.(pref.key);
    else storage.setItem(pref.key, text);
  } catch {
    // A full quota or private mode: the preference lasts this visit only.
  }
}

/** The fields of a `StorageEvent` a store reads. */
export interface StorageChange {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: unknown;
}

/** Where another tab's writes are heard: the window, on the page. */
export interface StorageEvents {
  addEventListener(type: "storage", listener: (event: StorageChange) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageChange) => void): void;
}

/** One preference, held once for the page and shared by everything that shows or changes it. */
export interface PrefStore<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
  /** Stops following other tabs. */
  dispose(): void;
}

/**
 * `pref`, read once and held here: `get` returns the same value until it
 * changes, as `useSyncExternalStore` requires, and `set` writes it back
 * (`writePref`) and tells every subscriber. With `events`, another tab's
 * write to the same key is taken up too. Storage that is missing or throws
 * reads as the default and keeps a change for this visit only: a preference
 * never stops the page.
 */
export function createPrefStore<T>(
  pref: Pref<T>,
  storage: PrefStorage | null = pageStorage(),
  events: StorageEvents | null = null,
): PrefStore<T> {
  let value = readPref(pref, storage);
  const listeners = new Set<() => void>();
  const adopt = (next: T) => {
    value = next;
    for (const listener of [...listeners]) listener();
  };
  const onStorage = (event: StorageChange): void => {
    if (storage && event.storageArea !== storage) return;
    // A null key is another tab clearing storage: every preference is back to its default.
    if (event.key === null) adopt(readPref(pref, null));
    else if (event.key === pref.key) adopt(readPref(pref, { getItem: () => event.newValue, setItem: () => undefined }));
  };
  events?.addEventListener("storage", onStorage);
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      writePref(pref, next, storage);
      adopt(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      events?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

/** A preference store's value, re-rendering whenever it changes. */
export function usePref<T>(store: PrefStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ─── The view and the One-time pair ───────────────────────────────────────────

export const VIEW_KEY = "spdex.view.v1";
export const PAIR_KEY = "spdex.swap.pair.v1";

export type View = "recommended" | "expert";

/** Simple unless this browser last chose Expert. */
const VIEW: Pref<View> = {
  key: VIEW_KEY,
  parse: (raw) => (raw === "expert" ? "expert" : "recommended"),
  format: (view) => view,
};

export function loadView(storage: PrefStorage | null = pageStorage()): View {
  return readPref(VIEW, storage);
}

export function saveView(view: View, storage: PrefStorage | null = pageStorage()): void {
  writePref(VIEW, view, storage);
}

export interface SwapPair {
  /** Token symbols, as the One-time selects' option values. */
  in: string;
  out: string;
}

/**
 * ETH → SPX: what a newcomer arrives holding, and what spDEX is for.
 *
 * The e2e suite pins WETH → SPX instead (e2e/fixtures.ts), so its default path
 * keeps exercising the permission step, which ETH-in never has.
 */
export const DEFAULT_PAIR: SwapPair = { in: "ETH", out: "SPX" };

const WRAP = new Set(["ETH", "WETH"]);

/**
 * True when both symbols are listed and form a trade.
 *
 * ETH ↔ WETH is refused as well as a token against itself: it is a wrap, which
 * spDEX does not do, and remembering it would greet a returning visitor with
 * an error before they had touched anything.
 */
export function isUsablePair(pair: SwapPair, symbols: readonly string[] = TOKEN_LIST.map((t) => t.symbol)): boolean {
  if (!symbols.includes(pair.in) || !symbols.includes(pair.out)) return false;
  if (pair.in === pair.out) return false;
  return !(WRAP.has(pair.in) && WRAP.has(pair.out));
}

/**
 * The pair after picking `symbol` on one side of it. Picking the token already
 * on the other side swaps the two, as the ⇅ button does, so the selects never
 * show one token on both sides ("SPX → SPX", with no market and a Get price
 * that can only refuse).
 */
export function pairAfterPick(pair: SwapPair, side: "in" | "out", symbol: string): SwapPair {
  if (side === "in") return symbol === pair.out ? { in: symbol, out: pair.in } : { in: symbol, out: pair.out };
  return symbol === pair.in ? { in: pair.out, out: symbol } : { in: pair.in, out: symbol };
}

/** The pair this browser last used, if it is still a usable one; otherwise ETH → SPX. */
const PAIR: Pref<SwapPair> = {
  key: PAIR_KEY,
  parse(raw) {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_PAIR };
    const { in: tokenIn, out: tokenOut } = parsed as Record<string, unknown>;
    if (typeof tokenIn !== "string" || typeof tokenOut !== "string") return { ...DEFAULT_PAIR };
    const pair = { in: tokenIn, out: tokenOut };
    return isUsablePair(pair) ? pair : { ...DEFAULT_PAIR };
  },
  format: (pair) => JSON.stringify({ in: pair.in, out: pair.out }),
};

export function loadPair(storage: PrefStorage | null = pageStorage()): SwapPair {
  return readPref(PAIR, storage);
}

/** Remembers a pair, but only a usable one: a half-picked pair is not a preference. */
export function savePair(pair: SwapPair, storage: PrefStorage | null = pageStorage()): void {
  if (isUsablePair(pair)) writePref(PAIR, pair, storage);
}
