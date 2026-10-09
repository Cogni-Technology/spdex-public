/**
 * The colour mode: what is stored, what lands on the root element, and in
 * what order.
 *
 * The order is the part worth pinning. spx6900.com's switch works because the
 * new colours are computed while transitions are suppressed; set the attribute
 * after the reflow, or drop the class before it, and every lime fill on the
 * page visibly fades into pastel. None of that shows up as a wrong colour, so
 * only a test of the sequence catches it.
 *
 * Node has no DOM, so the root element, storage, the frame clock and the
 * window's `storage` events are all fakes that record what was done to them.
 */

import { describe, expect, it } from "vitest";
import {
  applyTheme,
  createThemeStore,
  DEFAULT_THEME,
  readTheme,
  saveTheme,
  THEME_KEY,
  type StorageChange,
  type StorageEvents,
  type Theme,
  type ThemeRoot,
  type ThemeStorage,
} from "./theme.js";

class FakeStorage implements ThemeStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("SecurityError: storage is blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.writes += 1;
    this.values.set(key, value);
  }
}

class FakeRoot implements ThemeRoot {
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  /** Every operation, in order, as a short string. */
  readonly log: string[] = [];

  readonly classList = {
    add: (...tokens: string[]): void => {
      for (const token of tokens) {
        this.log.push(`+class ${token}`);
        this.classes.add(token);
      }
    },
    remove: (...tokens: string[]): void => {
      for (const token of tokens) {
        this.log.push(`-class ${token}`);
        this.classes.delete(token);
      }
    },
  };

  setAttribute(name: string, value: string): void {
    this.log.push(`set ${name}=${value}`);
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.log.push(`remove ${name}`);
    this.attributes.delete(name);
  }

  get offsetHeight(): number {
    this.log.push("reflow");
    return 0;
  }
}

class FakeWindow implements StorageEvents {
  readonly listeners = new Set<(event: StorageChange) => void>();

  addEventListener(_type: "storage", listener: (event: StorageChange) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "storage", listener: (event: StorageChange) => void): void {
    this.listeners.delete(listener);
  }

  /** Another tab wrote to storage. */
  emit(event: StorageChange): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** A frame clock that runs only when told to. */
function frames() {
  const queue: (() => void)[] = [];
  return {
    nextFrame: (callback: () => void): void => {
      queue.push(callback);
    },
    pending: () => queue.length,
    flush: () => {
      for (const callback of queue.splice(0)) callback();
    },
  };
}

function setup(stored?: string) {
  const storage = new FakeStorage();
  if (stored !== undefined) storage.values.set(THEME_KEY, stored);
  const root = new FakeRoot();
  const events = new FakeWindow();
  const clock = frames();
  const store = createThemeStore({ storage, root, events, nextFrame: clock.nextFrame });
  return { storage, root, events, clock, store };
}

describe("the stored choice", () => {
  it("uses spx6900.com's key", () => {
    // Renaming the key would silently forget every saved choice, so it is
    // pinned. It is also the source site's own key and value format.
    expect(THEME_KEY).toBe("spx-theme");
  });

  it("is neon when nothing has been stored", () => {
    expect(readTheme(new FakeStorage())).toBe("neon");
    expect(DEFAULT_THEME).toBe("neon");
  });

  it("is pastel only for the exact string, and neon for anything else", () => {
    const storage = new FakeStorage();
    const cases: [string, Theme][] = [
      ["pastel", "pastel"],
      ["neon", "neon"],
      ["PASTEL", "neon"],
      [" pastel", "neon"],
      ["dark", "neon"],
      ["", "neon"],
    ];
    for (const [stored, expected] of cases) {
      storage.values.set(THEME_KEY, stored);
      expect(readTheme(storage), JSON.stringify(stored)).toBe(expected);
    }
  });

  it("falls back to neon when storage is blocked or absent, instead of throwing", () => {
    const storage = new FakeStorage();
    storage.values.set(THEME_KEY, "pastel");
    storage.failReads = true;
    expect(readTheme(storage)).toBe("neon");
    expect(readTheme(null)).toBe("neon");
  });

  it("is written as the plain mode name", () => {
    const storage = new FakeStorage();
    expect(saveTheme("pastel", storage)).toBe(true);
    expect(storage.values.get(THEME_KEY)).toBe("pastel");
    expect(saveTheme("neon", storage)).toBe(true);
    expect(storage.values.get(THEME_KEY)).toBe("neon");
  });

  it("reports a refused write rather than throwing", () => {
    // Private browsing and full quotas: the page must keep working.
    const storage = new FakeStorage();
    storage.failWrites = true;
    expect(saveTheme("pastel", storage)).toBe(false);
    expect(saveTheme("pastel", null)).toBe(false);
  });
});

describe("applyTheme", () => {
  it("sets data-theme for pastel and removes it for neon, never writing \"neon\"", () => {
    // The stylesheet's plain :root is neon. An attribute of "neon" would be a
    // third state that no selector styles and nothing expects.
    const root = new FakeRoot();
    applyTheme("pastel", root);
    expect(root.attributes.get("data-theme")).toBe("pastel");
    applyTheme("neon", root);
    expect(root.attributes.has("data-theme")).toBe(false);
    expect(root.log).toEqual(["set data-theme=pastel", "remove data-theme"]);
  });

  it("touches nothing else when not animating", () => {
    // Boot: nothing has been painted, so there is nothing to suppress, and a
    // forced reflow would be wasted work on the critical path.
    const root = new FakeRoot();
    applyTheme("pastel", root);
    expect(root.log).toEqual(["set data-theme=pastel"]);
    expect(root.classes.size).toBe(0);
  });

  it("switches inside one suppressed frame, in the source site's order", () => {
    const root = new FakeRoot();
    const clock = frames();
    applyTheme("pastel", root, { animate: true, nextFrame: clock.nextFrame });

    // Class first, then the attribute, then the reflow that computes the new
    // colours while transitions are off.
    expect(root.log).toEqual(["+class theme-switching", "set data-theme=pastel", "reflow"]);
    // Still suppressed until the frame comes round.
    expect(root.classes.has("theme-switching")).toBe(true);
    expect(clock.pending()).toBe(1);

    clock.flush();
    expect(root.classes.has("theme-switching")).toBe(false);
    expect(root.log.at(-1)).toBe("-class theme-switching");
  });

  it("does the same dance for neon", () => {
    const root = new FakeRoot();
    root.setAttribute("data-theme", "pastel");
    root.log.length = 0;
    const clock = frames();
    applyTheme("neon", root, { animate: true, nextFrame: clock.nextFrame });
    clock.flush();
    expect(root.log).toEqual(["+class theme-switching", "remove data-theme", "reflow", "-class theme-switching"]);
  });

  it("is a no-op without a root element", () => {
    expect(() => applyTheme("pastel", null, { animate: true })).not.toThrow();
  });
});

describe("the theme store", () => {
  it("applies the saved choice on creation, without the switching class", () => {
    const { root, store, clock } = setup("pastel");
    expect(store.get()).toBe("pastel");
    expect(root.log).toEqual(["set data-theme=pastel"]);
    expect(clock.pending()).toBe(0);
  });

  it("leaves the root bare for neon on creation", () => {
    const { root, store } = setup();
    expect(store.get()).toBe("neon");
    expect(root.log).toEqual(["remove data-theme"]);
  });

  it("switches, persists and tells every subscribed chip", () => {
    const { storage, root, clock, store } = setup();
    const heard: string[] = [];
    store.subscribe(() => heard.push(`first:${store.get()}`));
    store.subscribe(() => heard.push(`second:${store.get()}`));

    store.set("pastel");

    expect(store.get()).toBe("pastel");
    expect(storage.values.get(THEME_KEY)).toBe("pastel");
    expect(root.attributes.get("data-theme")).toBe("pastel");
    expect(root.classes.has("theme-switching")).toBe(true);
    expect(heard).toEqual(["first:pastel", "second:pastel"]);

    clock.flush();
    expect(root.classes.has("theme-switching")).toBe(false);
  });

  it("tells no one when the chosen mode is already on screen", () => {
    const { root, store } = setup("pastel");
    let calls = 0;
    store.subscribe(() => (calls += 1));
    root.log.length = 0;
    store.set("pastel");
    expect(calls).toBe(0);
    expect(root.log).toEqual([]);
  });

  it("stops telling a chip that unsubscribed", () => {
    const { store } = setup();
    let calls = 0;
    const unsubscribe = store.subscribe(() => (calls += 1));
    store.set("pastel");
    unsubscribe();
    store.set("neon");
    expect(calls).toBe(1);
  });

  it("refuses a value that is not a mode", () => {
    // Typed callers cannot do this; a value that came out of the DOM can.
    const { storage, store } = setup();
    store.set("dark" as Theme);
    expect(store.get()).toBe("neon");
    expect(storage.writes).toBe(0);
  });

  it("still switches this page when storage refuses the write", () => {
    const { storage, root, store } = setup();
    storage.failWrites = true;
    store.set("pastel");
    expect(store.get()).toBe("pastel");
    expect(root.attributes.get("data-theme")).toBe("pastel");
  });

  it("works in memory when storage is unavailable altogether", () => {
    const root = new FakeRoot();
    const store = createThemeStore({ storage: null, root, events: null, nextFrame: () => {} });
    expect(store.get()).toBe("neon");
    store.set("pastel");
    expect(store.get()).toBe("pastel");
    expect(root.attributes.get("data-theme")).toBe("pastel");
  });
});

describe("another tab", () => {
  it("is followed when it changes the mode, without writing the value back", () => {
    const { storage, root, events, clock, store } = setup();
    let calls = 0;
    store.subscribe(() => (calls += 1));

    // What the other tab's setItem left behind, then the event it caused here.
    storage.values.set(THEME_KEY, "pastel");
    events.emit({ key: THEME_KEY, newValue: "pastel", storageArea: storage });

    expect(store.get()).toBe("pastel");
    expect(root.attributes.get("data-theme")).toBe("pastel");
    expect(calls).toBe(1);
    // Suppressed like a local switch: the page recolours in one frame.
    expect(root.classes.has("theme-switching")).toBe(true);
    clock.flush();
    expect(root.classes.has("theme-switching")).toBe(false);
    // Writing it back would fire the same event in the other tab: a ping-pong.
    expect(storage.writes).toBe(0);
  });

  it("is ignored when it changes some other key", () => {
    const { storage, events, store } = setup();
    events.emit({ key: "spdex.config.v1", newValue: "pastel", storageArea: storage });
    expect(store.get()).toBe("neon");
  });

  it("is ignored when the change was to a different storage area", () => {
    // sessionStorage changes in same-origin frames raise the same event.
    const { events, store } = setup();
    events.emit({ key: THEME_KEY, newValue: "pastel", storageArea: new FakeStorage() });
    expect(store.get()).toBe("neon");
  });

  it("reads anything but \"pastel\" as neon, as a local read would", () => {
    const { storage, events, store } = setup("pastel");
    events.emit({ key: THEME_KEY, newValue: "sepia", storageArea: storage });
    expect(store.get()).toBe("neon");
  });

  it("clearing storage there reverts to the default here", () => {
    // localStorage.clear() in another tab arrives with a null key.
    const { storage, root, events, store } = setup("pastel");
    storage.values.clear();
    events.emit({ key: null, newValue: null, storageArea: storage });
    expect(store.get()).toBe("neon");
    expect(root.attributes.has("data-theme")).toBe(false);
  });

  it("is no longer followed once the store is disposed", () => {
    const { storage, events, store } = setup();
    store.dispose();
    expect(events.listeners.size).toBe(0);
    events.emit({ key: THEME_KEY, newValue: "pastel", storageArea: storage });
    expect(store.get()).toBe("neon");
  });
});
