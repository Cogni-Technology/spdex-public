/**
 * The display preferences: what is stored, what lands on the root element,
 * and when something may move. Node has no DOM, so the root, storage and
 * the window's `storage` events are fakes.
 */

import { describe, expect, it } from "vitest";
import {
  A11Y_KEY,
  A11Y_KEY_V1,
  A11Y_PREF,
  applyA11y,
  createA11yStore,
  DEFAULT_A11Y,
  reducedMotion,
  scrollBehavior,
  setA11y,
  type A11yRoot,
} from "./a11y.js";
import type { StorageChange, StorageEvents } from "./prefs.js";

class FakeRoot implements A11yRoot {
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeStorage {
  readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

class FakeWindow implements StorageEvents {
  readonly listeners = new Set<(event: StorageChange) => void>();
  addEventListener(_: "storage", listener: (event: StorageChange) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_: "storage", listener: (event: StorageChange) => void) {
    this.listeners.delete(listener);
  }
  emit(event: StorageChange) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

describe("stored display preferences", () => {
  it("start at A+ (115%), motion and contrast following the system", () => {
    expect(A11Y_PREF.parse(null)).toEqual({ text: 115, motion: "auto", contrast: "auto" });
    expect(DEFAULT_A11Y).toEqual({ text: 115, motion: "auto", contrast: "auto" });
  });

  it("read back what they wrote", () => {
    const prefs = { text: 130, motion: "reduce", contrast: "more" } as const;
    expect(A11Y_PREF.parse(A11Y_PREF.format(prefs))).toEqual(prefs);
    expect(JSON.parse(A11Y_PREF.format(prefs)!)).toEqual({ text: 130, motion: "reduce", contrast: "more" });
    expect(A11Y_KEY).toBe("spdex.a11y.v2");
  });

  it("keep only what differs from the default, and nothing at all for the defaults", () => {
    expect(A11Y_PREF.format({ ...DEFAULT_A11Y, motion: "reduce" })).toBe('{"motion":"reduce"}');
    expect(A11Y_PREF.format({ ...DEFAULT_A11Y, text: 100 })).toBe('{"text":100}');
    expect(A11Y_PREF.format(DEFAULT_A11Y)).toBeNull();
  });

  it("carry motion and contrast over from v1 once, never its text size", () => {
    const storage = new FakeStorage();
    storage.values.set(A11Y_KEY_V1, JSON.stringify({ text: 100, motion: "reduce", contrast: "more" }));
    const root = new FakeRoot();
    const store = createA11yStore({ storage, root });
    expect(store.get()).toEqual({ text: 115, motion: "reduce", contrast: "more" });
    expect(JSON.parse(storage.values.get(A11Y_KEY)!)).toEqual({ motion: "reduce", contrast: "more" });
    expect(Object.fromEntries(root.attributes)).toEqual({ "data-motion": "reduce", "data-contrast": "more" });
    // v2 already there: v1 is not read again.
    storage.values.set(A11Y_KEY, JSON.stringify({ text: 130 }));
    expect(createA11yStore({ storage, root: new FakeRoot() }).get()).toEqual({ text: 130, motion: "auto", contrast: "auto" });
  });

  it("drop a field this build didn't write without losing the others", () => {
    expect(A11Y_PREF.parse('{"text":120,"motion":"reduce","contrast":"less"}')).toEqual({
      text: 115,
      motion: "reduce",
      contrast: "auto",
    });
    expect(A11Y_PREF.parse('{"text":"115"}')).toEqual(DEFAULT_A11Y);
    expect(A11Y_PREF.parse("[130]")).toEqual(DEFAULT_A11Y);
    expect(A11Y_PREF.parse("null")).toEqual(DEFAULT_A11Y);
  });
});

describe("the root element", () => {
  it("carries an attribute only for a setting that adds something", () => {
    const root = new FakeRoot();
    applyA11y({ text: 100, motion: "reduce", contrast: "more" }, root);
    expect(Object.fromEntries(root.attributes)).toEqual({
      "data-text": "100",
      "data-motion": "reduce",
      "data-contrast": "more",
    });
    applyA11y(DEFAULT_A11Y, root);
    expect(root.attributes.size).toBe(0);
  });

  it("gets the stored choice when the store is created, before anything renders", () => {
    const storage = new FakeStorage();
    storage.values.set(A11Y_KEY, JSON.stringify({ text: 130, motion: "auto", contrast: "more" }));
    const root = new FakeRoot();
    createA11yStore({ storage, root });
    expect(Object.fromEntries(root.attributes)).toEqual({ "data-text": "130", "data-contrast": "more" });
  });

  it("follows a change here and one made in another tab", () => {
    const storage = new FakeStorage();
    const root = new FakeRoot();
    const events = new FakeWindow();
    const store = createA11yStore({ storage, root, events });
    setA11y({ motion: "reduce" }, store);
    expect(root.getAttribute("data-motion")).toBe("reduce");
    expect(JSON.parse(storage.values.get(A11Y_KEY)!)).toEqual({ motion: "reduce" });

    events.emit({ key: A11Y_KEY, newValue: JSON.stringify({ text: 100 }), storageArea: storage });
    expect(Object.fromEntries(root.attributes)).toEqual({ "data-text": "100" });
    // Another tab clearing storage: back to the defaults.
    events.emit({ key: null, newValue: null, storageArea: storage });
    expect(root.attributes.size).toBe(0);
  });

  it("keeps a change for the visit when storage refuses it", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const root = new FakeRoot();
    const store = createA11yStore({ storage, root });
    setA11y({ contrast: "more" }, store);
    expect(store.get().contrast).toBe("more");
    expect(root.getAttribute("data-contrast")).toBe("more");
  });

  it("works with no storage at all", () => {
    const root = new FakeRoot();
    const store = createA11yStore({ storage: null, root });
    expect(store.get()).toEqual(DEFAULT_A11Y);
    setA11y({ text: 130 }, store);
    expect(root.getAttribute("data-text")).toBe("130");
  });
});

describe("should this move?", () => {
  const env = (attribute: string | null, systemReduces: boolean | null) => ({
    root: { getAttribute: () => attribute },
    matchMedia: systemReduces === null ? null : () => ({ matches: systemReduces }),
  });

  it("moves only when neither the page setting nor the system says less", () => {
    expect(reducedMotion(env(null, false))).toBe(false);
    expect(scrollBehavior(env(null, false))).toBe("smooth");
  });

  it("stays still under either one: the setting can only add, never take away", () => {
    expect(reducedMotion(env("reduce", false))).toBe(true);
    expect(reducedMotion(env(null, true))).toBe(true);
    expect(reducedMotion(env("reduce", true))).toBe(true);
    expect(scrollBehavior(env(null, true))).toBe("auto");
    expect(scrollBehavior(env("reduce", null))).toBe("auto");
  });

  it("moves where there is no way to ask, as the browser would", () => {
    expect(reducedMotion({ root: null, matchMedia: null })).toBe(false);
  });
});
