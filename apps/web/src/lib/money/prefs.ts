/**
 * This browser's money preferences: the currency, the number style, and the
 * unit each amount field was last switched to.
 *
 * Kept out of the config for the reason the colour mode is (theme.ts): they
 * are facts about the person, not instructions to move money. A currency in a
 * shared config would mark the preset customised and add noise to the one
 * diff that has to stay worth reading.
 *
 * Read field by field. Storage may hold only some of them (the e2e fixtures
 * write only `units`), something an older build wrote, or something typed
 * into devtools; each field that can't be read falls back on its own, and
 * nothing here throws. Only fields the person set are written back, so a
 * currency picked from the browser's region follows the browser until the
 * person chooses one.
 *
 * The page's number format follows the store: creating it, and every change
 * to it, sets the display locale that `formatAmount` and `formatSignificant`
 * write in (format.ts).
 */

import { useSyncExternalStore } from "react";
import { pageEvents, pageStorage } from "../page.js";
import { createPrefStore, readPref, type Pref, type PrefStorage, type StorageEvents } from "../prefs.js";
import { browserLanguages, defaultCurrency, isCurrencyCode, numberLocale } from "./currency.js";
import { setDisplayLocale } from "./format.js";
import {
  MONEY_PREFS_KEY,
  NUMBER_STYLES,
  type AmountUnit,
  type MoneyPrefs,
  type MoneyStore,
  type NumberStyle,
  type StoredUnit,
} from "./pricing.js";
import { storedUnit } from "./resolve.js";

/** The fields that were stored and could be read; anything else is a default. */
type StoredPrefs = { currency?: MoneyPrefs["currency"]; numbers?: NumberStyle; units?: Partial<MoneyPrefs["units"]> };

function isNumberStyle(value: unknown): value is NumberStyle {
  return typeof value === "string" && (NUMBER_STYLES as readonly string[]).includes(value);
}

function isStoredUnit(value: unknown): value is StoredUnit {
  return value === "token" || isCurrencyCode(value);
}

/** What storage holds, each field kept only when it is valid. Never throws. */
export function parseStoredPrefs(raw: string | null): StoredPrefs {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const stored: StoredPrefs = {};
  if (isCurrencyCode(record.currency)) stored.currency = record.currency;
  if (isNumberStyle(record.numbers)) stored.numbers = record.numbers;
  if (typeof record.units === "object" && record.units !== null && !Array.isArray(record.units)) {
    const units = record.units as Record<string, unknown>;
    const kept: Partial<MoneyPrefs["units"]> = {};
    if (isStoredUnit(units.once)) kept.once = units.once;
    if (isStoredUnit(units.recurring)) kept.recurring = units.recurring;
    stored.units = kept;
  }
  return stored;
}

/** The preferences, with every field storage didn't supply filled from the defaults. */
export function withDefaults(stored: StoredPrefs, languages: readonly string[]): MoneyPrefs {
  return {
    currency: stored.currency ?? defaultCurrency(languages),
    numbers: stored.numbers ?? "auto",
    units: { once: stored.units?.once ?? null, recurring: stored.units?.recurring ?? null },
  };
}

/** The fields the person set, as stored: only those are ever written back. */
const MONEY_PREFS: Pref<StoredPrefs> = { key: MONEY_PREFS_KEY, parse: parseStoredPrefs, format: (stored) => JSON.stringify(stored) };

/** This browser's preferences, or the defaults for its languages. */
export function readMoneyPrefs(storage: PrefStorage | null, languages: readonly string[]): MoneyPrefs {
  return withDefaults(readPref(MONEY_PREFS, storage), languages);
}

export interface MoneyEnvironment {
  storage: PrefStorage | null;
  events?: StorageEvents | null;
  languages: readonly string[];
  /** Called with the number format after every change; the page sets its display locale. */
  onLocale?: (locale: string) => void;
}

/** A money store that can also stop following other tabs. */
export interface DisposableMoneyStore extends MoneyStore {
  dispose(): void;
}

/**
 * One source of truth for the preferences, shared by every field and menu on
 * the page and kept in step with other tabs. `get` returns the object held
 * here, stable between changes, as `useSyncExternalStore` requires.
 */
export function createMoneyStore(env: MoneyEnvironment): DisposableMoneyStore {
  const stored = createPrefStore(MONEY_PREFS, env.storage, env.events ?? null);
  let current = withDefaults(stored.get(), env.languages);
  const listeners = new Set<() => void>();
  env.onLocale?.(numberLocale(current.numbers));

  // What is stored changed, here or in another tab: tell subscribers only when what's shown changes.
  stored.subscribe(() => {
    const next = withDefaults(stored.get(), env.languages);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const localeChanged = next.numbers !== current.numbers;
    current = next;
    if (localeChanged) env.onLocale?.(numberLocale(current.numbers));
    for (const listener of [...listeners]) listener();
  });

  return {
    get: () => current,
    set(prefs) {
      // Only what differs from what is on screen becomes a stored choice.
      const before = stored.get();
      const next: StoredPrefs = { ...before, units: { ...before.units } };
      if (isCurrencyCode(prefs.currency) && prefs.currency !== current.currency) next.currency = prefs.currency;
      if (isNumberStyle(prefs.numbers) && prefs.numbers !== current.numbers) next.numbers = prefs.numbers;
      for (const field of ["once", "recurring"] as const) {
        const unit = prefs.units[field];
        if (unit !== current.units[field] && (unit === null || isStoredUnit(unit))) {
          if (unit === null) delete next.units![field];
          else next.units![field] = unit;
        }
      }
      stored.set(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      stored.dispose();
      listeners.clear();
    },
  };
}

let pageStore: DisposableMoneyStore | undefined;

/** The page's store, created on first use against the real storage and languages. */
export function moneyStore(): MoneyStore {
  pageStore ??= createMoneyStore({
    storage: pageStorage(),
    events: pageEvents(),
    languages: browserLanguages(),
    onLocale: setDisplayLocale,
  });
  return pageStore;
}

/**
 * The page's money preferences, re-rendering on every change from here or
 * another tab. App reads it once and passes it on, and calling it also puts
 * the page's number format in place before anything below renders.
 */
export function useMoneyPrefs(): MoneyPrefs {
  const store = moneyStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Remember the unit a field was switched to. */
export function rememberUnit(field: keyof MoneyPrefs["units"], unit: AmountUnit, store: MoneyStore = moneyStore()): void {
  const prefs = store.get();
  store.set({ ...prefs, units: { ...prefs.units, [field]: storedUnit(unit) } });
}
