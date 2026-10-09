/**
 * "My tip list": the addresses a person saved to tip, in this browser only.
 *
 * ## Where it lives, and what travels
 *
 * localStorage `spdex.tiplist.v1`, through `createPrefStore` with the
 * window's storage events, so another tab's additions arrive here and every
 * edit applies to the latest list rather than to a stale copy. Not in the
 * config: a config travels in settings files and share links, and a private
 * list of names does not. Export is the only way the list itself leaves.
 *
 * A *chosen* recipient's address is in the config, as before; for a saved
 * one the config's label is "My tip list", never the private name.
 *
 * When storage can't be written (private mode, a blocked site, a full
 * quota) the list lasts this visit only, and `canSave()` says so for the
 * Settings section to tell the person.
 *
 * ## Shape
 *
 *   { v: 1,
 *     mine: [{ address (EIP-55), name (1–64), ens?, note? (≤160),
 *              added (ms), confirmed? (ms: the first tip confirmed),
 *              keptRetired? (the retirement reason the person chose to keep tipping through),
 *              imported? (true: it came from a file) }], ≤ 50, in the person's order
 *     hiddenDefaults: [listed entry ids the person hid from the picker],
 *     migrated?: ms (recipients chosen before this list existed were stamped confirmed once) }
 *
 * Every read is defensive: an entry storage holds that isn't well formed is
 * dropped, names are cleaned (lib/core's `cleanTipText`), duplicates keep
 * the first. Nothing here throws.
 *
 * A list saved by a newer build (another `v`) is left as it is: this page
 * shows an empty list, doesn't write over it, and says it can't save.
 */

import { useSyncExternalStore } from "react";
import {
  cleanTipText,
  isPublicDevAccount,
  TipEntryIdSchema,
  tipNameProblem,
  type Address,
  type TipRecipient,
} from "@spdex/core";
import { addressInputProblem } from "@spdex/chain";
import { TIPLIST_MODULE_ID } from "@spdex/config";
import { checksumAddress } from "../culture/contract.js";
import { pageEvents, pageStorage } from "../page.js";
import { createPrefStore, type Pref, type PrefStorage, type StorageEvents } from "../prefs.js";
import { DEV_TIPLIST_ID } from "../tipRow.js";
import { knownContract } from "./contracts.js";

export const TIPLIST_KEY = "spdex.tiplist.v1";
/** The most addresses the list keeps. */
export const MAX_MINE = 50;
export const MAX_NOTE = 160;
/** The name of the exported file. */
export const TIPLIST_FILE = "spdex-tip-list.json";
/** The largest file import reads, and the most entries: a tip list is short, and a huge file would stall the page. */
export const MAX_IMPORT_BYTES = 64 * 1024;
export const MAX_IMPORT_ENTRIES = 200;
const MAX_REASON = 120;
/** The name an UNLISTED recipient gets when the person confirms it. */
export const FROM_LOADED_SETTINGS = "From loaded settings";

export interface MineEntry {
  /** EIP-55. The only thing money follows. */
  address: Address;
  /** Private: shown here, never written to the config. */
  name: string;
  /**
   * The ENS name it was added by, normalised and read through the person's
   * own service. Display only: never looked up again. Never taken from a
   * file: a name there was never checked against the address.
   */
  ens?: string;
  note?: string;
  /** When it was added, ms. */
  added: number;
  /** When the person confirmed the first tip to it, ms. Unconfirmed entries are not tipped. */
  confirmed?: number;
  /**
   * A listed entry at this address was retired, and the person chose to keep
   * tipping it anyway: the retirement reason they saw. A retired entry is
   * skipped unless this matches its reason now (and the first tip is
   * confirmed after that choice), so a stamp from before the retirement
   * never keeps it paid.
   */
  keptRetired?: string;
  /** Came from an imported file: someone else's word for the name. */
  imported?: true;
}

export interface TipListState {
  v: 1;
  mine: MineEntry[];
  hiddenDefaults: string[];
  migrated?: number;
}

export const EMPTY_TIPLIST: TipListState = { v: 1, mine: [], hiddenDefaults: [] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** An optional display string, cleaned and cut to `max`, or undefined. */
function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = cleanTipText(value).slice(0, max);
  return clean.length > 0 ? clean : undefined;
}

/** One saved entry from anything, or null when it can't be one. */
export function readEntry(raw: unknown): MineEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.address !== "string" || addressInputProblem(record.address) !== null) return null;
  if (typeof record.name !== "string" || tipNameProblem(record.name) !== null) return null;
  const entry: MineEntry = {
    address: checksumAddress(record.address.trim()),
    name: cleanTipText(record.name),
    added: isTime(record.added) ? record.added : 0,
  };
  const ens = optionalText(record.ens, 64);
  if (ens !== undefined) entry.ens = ens;
  const note = optionalText(record.note, MAX_NOTE);
  if (note !== undefined) entry.note = note;
  if (isTime(record.confirmed)) entry.confirmed = record.confirmed;
  const kept = optionalText(record.keptRetired, MAX_REASON);
  if (kept !== undefined) entry.keptRetired = kept;
  if (record.imported === true) entry.imported = true;
  return entry;
}

/** How storage holds the list: not at all, as a v1 list, as something unreadable, or as another build's version. */
export type StoredShape = "absent" | "v1" | "unreadable" | "other-version";

export function storedShape(raw: string | null): StoredShape {
  if (raw === null) return "absent";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unreadable";
  const v = (value as Record<string, unknown>).v;
  if (v === 1) return "v1";
  return typeof v === "number" ? "other-version" : "unreadable";
}

/** The list storage holds, or the empty one. Never throws. */
export function parseTipList(raw: string | null): TipListState {
  if (raw === null) return EMPTY_TIPLIST;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_TIPLIST;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_TIPLIST;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return EMPTY_TIPLIST;
  const mine: MineEntry[] = [];
  for (const raw of Array.isArray(record.mine) ? record.mine : []) {
    const entry = readEntry(raw);
    if (entry === null || mine.some((kept) => same(kept.address, entry.address))) continue;
    mine.push(entry);
    if (mine.length === MAX_MINE) break;
  }
  const hiddenDefaults = [
    ...new Set(
      (Array.isArray(record.hiddenDefaults) ? record.hiddenDefaults : []).filter(
        (id): id is string => TipEntryIdSchema.safeParse(id).success,
      ),
    ),
  ];
  return { v: 1, mine, hiddenDefaults, ...(isTime(record.migrated) ? { migrated: record.migrated } : {}) };
}

export const TIPLIST_PREF: Pref<TipListState> = {
  key: TIPLIST_KEY,
  parse: parseTipList,
  format: (state) => JSON.stringify(state),
};

// ── Edits: pure, each from the list as it is now ────────────────────────────

export type TipListEdit = { ok: true; state: TipListState } | { ok: false; error: string };

/** Add an entry at the end. Refused when the address is already saved, or the list is full. */
export function addMine(state: TipListState, entry: MineEntry): TipListEdit {
  const existing = state.mine.find((kept) => same(kept.address, entry.address));
  if (existing !== undefined) return { ok: false, error: `Already in your list as ${existing.name}.` };
  if (state.mine.length >= MAX_MINE) return { ok: false, error: `Your list holds up to ${MAX_MINE} addresses.` };
  return { ok: true, state: { ...state, mine: [...state.mine, entry] } };
}

/** Where a removed entry was, for Undo. */
export interface Removed {
  entry: MineEntry;
  index: number;
}

export function removeMine(state: TipListState, address: string): { state: TipListState; removed: Removed | null } {
  const index = state.mine.findIndex((entry) => same(entry.address, address));
  if (index < 0) return { state, removed: null };
  return {
    state: { ...state, mine: state.mine.filter((_, i) => i !== index) },
    removed: { entry: state.mine[index]!, index },
  };
}

/** Put a removed entry back where it was, unless the address was saved again meanwhile. */
export function restoreMine(state: TipListState, removed: Removed): TipListState {
  if (state.mine.some((entry) => same(entry.address, removed.entry.address))) return state;
  if (state.mine.length >= MAX_MINE) return state;
  const mine = [...state.mine];
  mine.splice(Math.min(removed.index, mine.length), 0, removed.entry);
  return { ...state, mine };
}

/** Move an entry one place up (-1) or down (+1). */
export function moveMine(state: TipListState, address: string, delta: -1 | 1): TipListState {
  const index = state.mine.findIndex((entry) => same(entry.address, address));
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.mine.length) return state;
  const mine = [...state.mine];
  [mine[index], mine[target]] = [mine[target]!, mine[index]!];
  return { ...state, mine };
}

export function hideDefault(state: TipListState, id: string): TipListState {
  if (state.hiddenDefaults.includes(id)) return state;
  return { ...state, hiddenDefaults: [...state.hiddenDefaults, id] };
}

export function showHiddenDefaults(state: TipListState): TipListState {
  return state.hiddenDefaults.length === 0 ? state : { ...state, hiddenDefaults: [] };
}

/**
 * The person confirmed the first tip to `address`: stamp it. An address not
 * saved yet (an UNLISTED recipient from loaded settings, one no longer in
 * the list) is saved, confirmed, under `name`.
 */
export function confirmMine(state: TipListState, address: string, now: number, name = FROM_LOADED_SETTINGS): TipListEdit {
  const index = state.mine.findIndex((entry) => same(entry.address, address));
  if (index >= 0) {
    if (state.mine[index]!.confirmed !== undefined) return { ok: true, state };
    const mine = state.mine.map((entry, i) => (i === index ? { ...entry, confirmed: now } : entry));
    return { ok: true, state: { ...state, mine } };
  }
  const clean = cleanTipText(name);
  return addMine(state, {
    address: checksumAddress(address),
    name: tipNameProblem(clean) === null ? clean : FROM_LOADED_SETTINGS,
    added: now,
    confirmed: now,
  });
}

/**
 * "Keep tipping" a retired listed entry: saved (or kept) under `name`, with
 * the retirement reason the person saw, and unconfirmed, so the first-tip
 * check shows the whole address before anything more is sent to it.
 */
export function keepRetiredMine(state: TipListState, address: string, name: string, reason: string, now: number): TipListEdit {
  const keptRetired = cleanTipText(reason).slice(0, MAX_REASON);
  const index = state.mine.findIndex((entry) => same(entry.address, address));
  if (index >= 0) {
    const mine = state.mine.map((entry, i) => {
      if (i !== index) return entry;
      const { confirmed: _confirmed, ...rest } = entry;
      return { ...rest, keptRetired };
    });
    return { ok: true, state: { ...state, mine } };
  }
  const clean = cleanTipText(name);
  return addMine(state, {
    address: checksumAddress(address),
    name: tipNameProblem(clean) === null ? clean : FROM_LOADED_SETTINGS,
    added: now,
    keptRetired,
  });
}

/** Registries whose recipients need no stamp: while listed they are paid, and once retired a stamp wouldn't count. */
const REGISTRY_SOURCES: ReadonlySet<string> = new Set([TIPLIST_MODULE_ID, DEV_TIPLIST_ID]);

/**
 * Once, on the first load of a build with this list: the recipients already
 * in the config were chosen before the first-tip confirmation existed, so
 * they are saved as confirmed rather than stopped. Left out: public test
 * accounts and known contracts (skipped anyway), and recipients picked from
 * a shipped list, which need no stamp. Returns how many were stamped, for a
 * banner that says so once.
 */
export function migrateTipList(state: TipListState, recipients: readonly TipRecipient[], now: number): { state: TipListState; count: number } {
  if (state.migrated !== undefined) return { state, count: 0 };
  let next: TipListState = { ...state, migrated: now };
  let count = 0;
  for (const recipient of recipients) {
    if (isPublicDevAccount(recipient.address) || knownContract(recipient.address) !== null) continue;
    if (recipient.source !== undefined && REGISTRY_SOURCES.has(recipient.source)) continue;
    const edit = confirmMine(next, recipient.address, now, recipient.label);
    if (edit.ok && edit.state !== next) {
      next = edit.state;
      count += 1;
    }
  }
  return { state: next, count };
}

// ── Export and import ───────────────────────────────────────────────────────

/**
 * The file's text: the saved addresses, names and notes. Not the dates or
 * confirmations, and not ENS names: an import can't know a name was ever
 * checked against the address, so it wouldn't keep one.
 */
export function exportTipList(state: TipListState): string {
  const entries = state.mine.map((entry) => ({
    address: entry.address,
    name: entry.name,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  }));
  return `${JSON.stringify({ spdex: "tip-list", v: 1, entries }, null, 2)}\n`;
}

/** What a file offers, each entry cleaned and unconfirmed, and what it held that couldn't be read. */
export type TipListFile =
  | { ok: true; entries: MineEntry[]; unreadable: number }
  | { ok: false; error: string };

/**
 * Read an exported file. Entries arrive unconfirmed and marked imported,
 * whatever the file says: a file is someone's word, and the first tip to
 * each still asks. An `ens` in the file is dropped: nothing checked that the
 * name points at the address beside it, and shown next to it, it would read
 * as if something had.
 */
export function readTipListFile(text: string, now: number): TipListFile {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: "That file is too big for a tip list." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a tip list: it isn't JSON." };
  }
  const record = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (record.spdex !== "tip-list" || record.v !== 1 || !Array.isArray(record.entries)) {
    return { ok: false, error: "That file isn't an spDEX tip list." };
  }
  if (record.entries.length > MAX_IMPORT_ENTRIES) {
    return { ok: false, error: `That file holds more than ${MAX_IMPORT_ENTRIES} addresses; a tip list holds ${MAX_MINE}.` };
  }
  const entries: MineEntry[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const raw of record.entries) {
    const fields = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const { ens: _ens, confirmed: _confirmed, keptRetired: _kept, ...rest } = fields;
    const entry = readEntry({ ...rest, added: now, imported: true });
    if (entry === null) {
      unreadable += 1;
      continue;
    }
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return { ok: true, entries, unreadable };
}

// ── The page's store ────────────────────────────────────────────────────────

export interface TipListStore {
  get(): TipListState;
  set(next: TipListState): void;
  /** Apply an edit to the list as it is now; returns the refusal, or null. */
  update(edit: (state: TipListState) => TipListEdit | TipListState): string | null;
  subscribe(listener: () => void): () => void;
  /** False once the list couldn't be written (or there is no storage): it lasts this visit only. */
  canSave(): boolean;
  /** How many recipients this page load stamped confirmed on first use (0 afterwards). */
  migratedNow(): number;
  /** Run the one-time migration against the config the page loaded with. */
  migrate(recipients: readonly TipRecipient[], now: number): void;
  dispose(): void;
}

export function createTipListStore(storage: PrefStorage | null, events: StorageEvents | null): TipListStore {
  // What storage holds before anything is written. A list another build
  // saved in a version this one can't read is left alone: this page works
  // on an empty list for the visit and never writes over it.
  let shape: StoredShape = "absent";
  if (storage !== null) {
    try {
      shape = storedShape(storage.getItem(TIPLIST_KEY));
    } catch {
      shape = "unreadable";
    }
  }
  const readOnly = shape === "other-version";
  // Given the page's own storage, so another tab's storage events (which
  // name that storage) are taken up.
  const store = readOnly ? createPrefStore(TIPLIST_PREF, null, null) : createPrefStore(TIPLIST_PREF, storage, events);
  let writable = storage !== null && !readOnly;
  let migrated = 0;
  let migrationTried = false;
  // writePref swallows a failed write (the preference lasts this visit), so
  // whether it went through is read back: that is how the section learns it
  // has to say "Can't save in this browser".
  const set = (next: TipListState) => {
    if (next === store.get()) return;
    store.set(next);
    if (storage === null || readOnly) return;
    try {
      writable = storage.getItem(TIPLIST_KEY) === TIPLIST_PREF.format(next);
    } catch {
      writable = false;
    }
  };
  return {
    get: store.get,
    set,
    update(edit) {
      const result = edit(store.get());
      if ("ok" in result) {
        if (!result.ok) return result.error;
        set(result.state);
        return null;
      }
      set(result);
      return null;
    },
    subscribe: store.subscribe,
    canSave: () => writable,
    migratedNow: () => migrated,
    migrate(recipients, now) {
      // Only on a first load: when storage held no list at all. Not over a
      // list it couldn't read (that would stamp every recipient again, a
      // settings link's unconfirmed one included), and never when the stamp
      // can't be saved, or the next load would stamp the config again.
      if (migrationTried || shape !== "absent" || !writable) return;
      migrationTried = true;
      const before = store.get();
      const result = migrateTipList(before, recipients, now);
      if (result.state === before) return;
      set(result.state);
      if (!writable) {
        store.set(before);
        return;
      }
      migrated += result.count;
    },
    dispose: store.dispose,
  };
}

let pageStore: TipListStore | undefined;

/** The page's store, created on first use against the real storage and the window's events. */
export function tipListStore(): TipListStore {
  pageStore ??= createTipListStore(pageStorage(), pageEvents());
  return pageStore;
}

/** The list, re-rendering whenever it changes, here or in another tab. */
export function useTipList(store: TipListStore = tipListStore()): TipListState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
