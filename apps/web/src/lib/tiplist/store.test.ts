/**
 * "My tip list" as this browser keeps it: read defensively, edited purely,
 * exported and imported as a file, and saved (or not) through the page's
 * storage. Every address here is made up.
 */

import { describe, expect, it } from "vitest";
import type { TipRecipient } from "@spdex/core";
import { checksumAddress } from "../culture/contract.js";
import {
  addMine,
  confirmMine,
  createTipListStore,
  EMPTY_TIPLIST,
  exportTipList,
  FROM_LOADED_SETTINGS,
  hideDefault,
  keepRetiredMine,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_MINE,
  migrateTipList,
  moveMine,
  parseTipList,
  readTipListFile,
  removeMine,
  restoreMine,
  showHiddenDefaults,
  TIPLIST_KEY,
  type MineEntry,
  type TipListState,
} from "./store.js";

/** A made-up address with these first and last four hex digits, checksummed. */
const fake = (first: string, last: string) => checksumAddress(`0x${first}${"abcdef".repeat(5)}ab${last}`);
const MARIA = fake("a1b2", "c3d4");
const SAM = fake("b1b2", "d3d4");

const entry = (address: string, name: string, extra: Partial<MineEntry> = {}): MineEntry => ({
  address: address as `0x${string}`,
  name,
  added: 1,
  ...extra,
});
const withMine = (...mine: MineEntry[]): TipListState => ({ ...EMPTY_TIPLIST, mine });

describe("parseTipList", () => {
  it("reads nothing, broken JSON or another version as the empty list", () => {
    expect(parseTipList(null)).toEqual(EMPTY_TIPLIST);
    expect(parseTipList("{not json")).toEqual(EMPTY_TIPLIST);
    expect(parseTipList(JSON.stringify({ v: 2, mine: [] }))).toEqual(EMPTY_TIPLIST);
  });

  it("keeps well-formed entries, checksummed and cleaned, and drops the rest", () => {
    const raw = JSON.stringify({
      v: 1,
      mine: [
        { address: MARIA.toLowerCase(), name: "Mar​ia", added: 5, confirmed: 7, ens: "maria.eth" },
        { address: MARIA, name: "Maria again", added: 6 },
        { address: "0x1234", name: "short" },
        { address: SAM, name: "Pay 0xabcd here" },
        { address: SAM, name: "Sam", note: "x".repeat(300), confirmed: "yesterday" },
      ],
      hiddenDefaults: ["example-artist", "Not An Id", "example-artist"],
      migrated: 9,
    });
    const list = parseTipList(raw);
    expect(list.mine).toEqual([
      { address: MARIA, name: "Maria", added: 5, confirmed: 7, ens: "maria.eth" },
      { address: SAM, name: "Sam", added: 0, note: "x".repeat(160) },
    ]);
    expect(list.hiddenDefaults).toEqual(["example-artist"]);
    expect(list.migrated).toBe(9);
  });

  it("keeps at most fifty", () => {
    const mine = Array.from({ length: 60 }, (_, i) => ({ address: fake(i.toString(16).padStart(4, "0"), "eeee"), name: `N${i}` }));
    expect(parseTipList(JSON.stringify({ v: 1, mine })).mine).toHaveLength(MAX_MINE);
  });
});

describe("edits", () => {
  it("adds at the end, refusing an address already saved", () => {
    const one = addMine(EMPTY_TIPLIST, entry(MARIA, "Maria"));
    expect(one.ok && one.state.mine.map((e) => e.name)).toEqual(["Maria"]);
    const again = addMine(withMine(entry(MARIA, "Maria")), entry(MARIA.toLowerCase(), "Other"));
    expect(again).toEqual({ ok: false, error: "Already in your list as Maria." });
  });

  it("refuses a fifty-first address", () => {
    const full = withMine(...Array.from({ length: MAX_MINE }, (_, i) => entry(fake(i.toString(16).padStart(4, "0"), "eeee"), `N${i}`)));
    expect(addMine(full, entry(MARIA, "Maria"))).toMatchObject({ ok: false });
  });

  it("removes with an undo that puts the entry back where it was", () => {
    const list = withMine(entry(MARIA, "Maria"), entry(SAM, "Sam"));
    const { state, removed } = removeMine(list, MARIA.toLowerCase());
    expect(state.mine.map((e) => e.name)).toEqual(["Sam"]);
    expect(removed).toEqual({ entry: list.mine[0], index: 0 });
    expect(restoreMine(state, removed!).mine.map((e) => e.name)).toEqual(["Maria", "Sam"]);
    // Saved again meanwhile: the undo leaves the new one alone.
    const readded = withMine(entry(SAM, "Sam"), entry(MARIA, "Maria (new)"));
    expect(restoreMine(readded, removed!)).toBe(readded);
    expect(removeMine(list, fake("0000", "0000")).removed).toBeNull();
  });

  it("moves one place at a time and stops at the ends", () => {
    const list = withMine(entry(MARIA, "Maria"), entry(SAM, "Sam"));
    expect(moveMine(list, SAM, -1).mine.map((e) => e.name)).toEqual(["Sam", "Maria"]);
    expect(moveMine(list, MARIA, -1)).toBe(list);
    expect(moveMine(list, SAM, 1)).toBe(list);
  });

  it("hides a listed entry by id and shows every hidden one again", () => {
    const hidden = hideDefault(hideDefault(EMPTY_TIPLIST, "example-artist"), "example-artist");
    expect(hidden.hiddenDefaults).toEqual(["example-artist"]);
    expect(showHiddenDefaults(hidden).hiddenDefaults).toEqual([]);
  });

  it("stamps the first tip confirmed, once, and saves an unlisted address as From loaded settings", () => {
    const stamped = confirmMine(withMine(entry(MARIA, "Maria")), MARIA, 100);
    expect(stamped.ok && stamped.state.mine[0]!.confirmed).toBe(100);
    const again = stamped.ok ? confirmMine(stamped.state, MARIA, 200) : stamped;
    expect(again.ok && again.state.mine[0]!.confirmed).toBe(100);
    const unlisted = confirmMine(EMPTY_TIPLIST, SAM.toLowerCase(), 300);
    expect(unlisted.ok && unlisted.state.mine).toEqual([{ address: SAM, name: FROM_LOADED_SETTINGS, added: 300, confirmed: 300 }]);
  });

  it("keeps a retired entry with the reason the person saw, and asks for the first tip again", () => {
    // Saved and confirmed long before the entry was listed, then retired.
    const before = withMine(entry(MARIA, "Maria", { confirmed: 5 }));
    const kept = keepRetiredMine(before, MARIA.toLowerCase(), "Example Cause", "Key\u200b compromised", 50);
    expect(kept.ok && kept.state.mine).toEqual([{ address: MARIA, name: "Maria", added: 1, keptRetired: "Key compromised" }]);
    const added = keepRetiredMine(EMPTY_TIPLIST, SAM.toLowerCase(), "Example Cause", "Moved", 60);
    expect(added.ok && added.state.mine).toEqual([{ address: SAM, name: "Example Cause", added: 60, keptRetired: "Moved" }]);
  });
});

describe("migrateTipList", () => {
  const recipient = (address: string, label: string): TipRecipient => ({ address: address.toLowerCase() as `0x${string}`, label, bps: 25 });

  it("stamps the recipients already chosen, once, leaving out test accounts, contracts and shipped-list picks", () => {
    const chosen = [
      recipient(MARIA, "Maria"),
      recipient("0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "Placeholder: dev fund"),
      recipient("0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c", "SPX itself"),
      recipient(SAM, "Pay 0xabcd"),
      // Picked from the shipped list: paid while listed, and a stamp would
      // only keep it paid past a retirement.
      { ...recipient(fake("cccc", "eeee"), "Example Artist"), source: "tiplist-spx-community" },
    ];
    const first = migrateTipList(EMPTY_TIPLIST, chosen, 50);
    expect(first.count).toBe(2);
    expect(first.state.migrated).toBe(50);
    expect(first.state.mine).toEqual([
      { address: MARIA, name: "Maria", added: 50, confirmed: 50 },
      // A name that reads like an address is not kept.
      { address: SAM, name: FROM_LOADED_SETTINGS, added: 50, confirmed: 50 },
    ]);
    const second = migrateTipList(first.state, [recipient(fake("cccc", "dddd"), "Later")], 60);
    expect(second).toEqual({ state: first.state, count: 0 });
  });

  it("marks an empty config migrated too, so nothing chosen later is stamped", () => {
    expect(migrateTipList(EMPTY_TIPLIST, [], 5)).toEqual({ state: { ...EMPTY_TIPLIST, migrated: 5 }, count: 0 });
  });
});

describe("export and import", () => {
  it("round-trips names and notes, and imports everything unconfirmed and marked imported", () => {
    const list = withMine(entry(MARIA, "Maria", { ens: "maria.eth", confirmed: 9 }), entry(SAM, "Sam", { note: "Runs the meme vault" }));
    const text = exportTipList(list);
    expect(JSON.parse(text)).toEqual({
      spdex: "tip-list",
      v: 1,
      entries: [
        { address: MARIA, name: "Maria" },
        { address: SAM, name: "Sam", note: "Runs the meme vault" },
      ],
    });
    const read = readTipListFile(text, 77);
    expect(read).toEqual({
      ok: true,
      unreadable: 0,
      entries: [
        { address: MARIA, name: "Maria", added: 77, imported: true },
        { address: SAM, name: "Sam", note: "Runs the meme vault", added: 77, imported: true },
      ],
    });
  });

  it("drops an ENS name, a confirmation and a kept retirement a file claims", () => {
    // A shared file pairing a real-looking name with some other address: the
    // name is never shown as if it had been read.
    const file = JSON.stringify({
      spdex: "tip-list",
      v: 1,
      entries: [{ address: MARIA, name: "Maria", ens: "maria.eth", confirmed: 5, keptRetired: "Moved", imported: false }],
    });
    expect(readTipListFile(file, 3)).toEqual({ ok: true, unreadable: 0, entries: [{ address: MARIA, name: "Maria", added: 3, imported: true }] });
  });

  it("refuses a file too big to be a tip list, before reading it", () => {
    expect(readTipListFile(" ".repeat(MAX_IMPORT_BYTES + 1), 1)).toMatchObject({ ok: false, error: "That file is too big for a tip list." });
    const many = Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, (_, i) => ({ address: fake(i.toString(16).padStart(4, "0"), "eeee"), name: "N" }));
    expect(readTipListFile(JSON.stringify({ spdex: "tip-list", v: 1, entries: many }), 1)).toMatchObject({ ok: false });
  });

  it("refuses a file that isn't a tip list, and counts entries it can't read", () => {
    expect(readTipListFile("nope", 1)).toMatchObject({ ok: false });
    expect(readTipListFile(JSON.stringify({ entries: [] }), 1)).toMatchObject({ ok: false });
    const mixed = JSON.stringify({
      spdex: "tip-list",
      v: 1,
      entries: [{ address: MARIA, name: "Maria", confirmed: 5 }, { address: "0x12", name: "x" }, "junk", { address: MARIA, name: "twice" }],
    });
    const read = readTipListFile(mixed, 3);
    expect(read).toEqual({ ok: true, unreadable: 2, entries: [{ address: MARIA, name: "Maria", added: 3, imported: true }] });
  });
});

describe("the store", () => {
  /** A storage that can be told to fail, with the window's storage events simulated. */
  function memory(failing = false) {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failing) throw new Error("QuotaExceededError");
        items.set(key, value);
      },
      removeItem: (key: string) => void items.delete(key),
    };
  }
  function events() {
    const listeners = new Set<(event: { key: string | null; newValue: string | null; storageArea: unknown }) => void>();
    return {
      addEventListener: (_: "storage", listener: never) => void listeners.add(listener),
      removeEventListener: (_: "storage", listener: never) => void listeners.delete(listener),
      fire: (event: { key: string | null; newValue: string | null; storageArea: unknown }) => listeners.forEach((l) => l(event)),
    };
  }

  it("saves each edit, and reports it can", () => {
    const storage = memory();
    const store = createTipListStore(storage, null);
    expect(store.update((state) => addMine(state, entry(MARIA, "Maria")))).toBeNull();
    expect(parseTipList(storage.items.get(TIPLIST_KEY) ?? null).mine.map((e) => e.name)).toEqual(["Maria"]);
    expect(store.canSave()).toBe(true);
    expect(store.update((state) => addMine(state, entry(MARIA, "Again")))).toBe("Already in your list as Maria.");
  });

  it("keeps the list for this visit when storage refuses, and says it can't save", () => {
    const store = createTipListStore(memory(true), null);
    store.update((state) => addMine(state, entry(MARIA, "Maria")));
    expect(store.get().mine).toHaveLength(1);
    expect(store.canSave()).toBe(false);
    expect(createTipListStore(null, null).canSave()).toBe(false);
  });

  it("takes up another tab's additions, so an edit here applies to the latest list", () => {
    const storage = memory();
    const window = events();
    const store = createTipListStore(storage, window as never);
    const elsewhere = JSON.stringify(withMine(entry(SAM, "Sam")));
    storage.items.set(TIPLIST_KEY, elsewhere);
    window.fire({ key: TIPLIST_KEY, newValue: elsewhere, storageArea: storage });
    store.update((state) => addMine(state, entry(MARIA, "Maria")));
    expect(store.get().mine.map((e) => e.name)).toEqual(["Sam", "Maria"]);
  });

  it("migrates once and remembers how many for the banner", () => {
    const storage = memory();
    const store = createTipListStore(storage, null);
    store.migrate([{ address: MARIA.toLowerCase() as `0x${string}`, label: "Maria", bps: 25 }], 10);
    expect(store.migratedNow()).toBe(1);
    const later = createTipListStore(storage, null);
    later.migrate([{ address: SAM.toLowerCase() as `0x${string}`, label: "Sam", bps: 25 }], 20);
    expect(later.migratedNow()).toBe(0);
    expect(later.get().mine.map((e) => e.name)).toEqual(["Maria"]);
  });

  const sam = [{ address: SAM.toLowerCase() as `0x${string}`, label: "Sam", bps: 25 }];

  it("doesn't migrate over a list it can't read, and leaves another version's list alone", () => {
    // Broken: nothing is stamped (a link's unconfirmed recipient would be).
    const broken = memory();
    broken.items.set(TIPLIST_KEY, "{not json");
    const store = createTipListStore(broken, null);
    store.migrate(sam, 10);
    expect(store.migratedNow()).toBe(0);
    expect(store.get().mine).toEqual([]);

    // A newer build's list: read as empty, never written over, and said.
    const newer = memory();
    const saved = JSON.stringify({ v: 2, people: ["whatever v2 holds"] });
    newer.items.set(TIPLIST_KEY, saved);
    const older = createTipListStore(newer, null);
    older.migrate(sam, 10);
    expect(older.update((state) => addMine(state, entry(MARIA, "Maria")))).toBeNull();
    expect(older.get().mine).toHaveLength(1);
    expect(newer.items.get(TIPLIST_KEY)).toBe(saved);
    expect(older.canSave()).toBe(false);
  });

  it("doesn't stamp anyone when the stamp can't be saved, so no later load stamps again", () => {
    const store = createTipListStore(memory(true), null);
    store.migrate(sam, 10);
    expect(store.migratedNow()).toBe(0);
    expect(store.get().mine).toEqual([]);
  });
});
