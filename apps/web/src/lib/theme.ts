/**
 * The colour mode: NEON (the default) or PASTEL, the two spx6900.com offers.
 *
 * Behaviour is copied from that site's own toggle, step for step, so the two
 * feel like the same control:
 *
 *   - the choice persists in localStorage under `spx-theme`, as "neon" or
 *     "pastel", and only the exact string "pastel" selects pastel;
 *   - pastel is `data-theme="pastel"` on the root element, and neon *removes*
 *     the attribute rather than setting it to "neon", so the stylesheet's plain
 *     `:root` is neon by construction and nothing can select a third state;
 *   - a switch adds `theme-switching` to the root, changes the attribute,
 *     forces a style recalculation by reading `offsetHeight`, and removes the
 *     class on the next animation frame. The recalculation is the point: the
 *     new colours are computed while transitions are off, so nothing eases from
 *     lime to pastel, and removing the class afterwards changes no colour and
 *     so starts no transition either.
 *
 * Two things spDEX adds. Every mounted MODE chip subscribes to one store, so
 * they stay in agreement. And a change made in another tab arrives here as a
 * `storage` event and is applied too, so two open tabs never disagree about a
 * setting that is shared between them anyway.
 *
 * The mode is deliberately **not** part of `SpdexConfig`. The config is the
 * standing instructions for moving money: it is exported, diffed and shared in
 * links. A colour preference is a fact about this browser, like having seen
 * the features dialog (store.ts), and putting it in the config would mark the
 * preset customised and add a line of noise to the one view that must stay
 * worth reading.
 *
 * Everything that touches the DOM or storage takes it as an argument, with the
 * browser's own as the default, so the unit tests (node, no DOM) drive this
 * with fakes.
 */

export const THEME_KEY = "spx-theme";

export const THEMES = ["neon", "pastel"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "neon";

export const THEME_ATTRIBUTE = "data-theme";
export const SWITCHING_CLASS = "theme-switching";

export function isTheme(value: unknown): value is Theme {
  return value === "neon" || value === "pastel";
}

/** The parts of `Storage` read and written here. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** The parts of the root element touched here. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  readonly classList: Pick<DOMTokenList, "add" | "remove">;
  readonly offsetHeight: number;
}

/** The fields of a `StorageEvent` read here. */
export interface StorageChange {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: unknown;
}

/** Where `storage` events arrive: `window` in the browser. */
export interface StorageEvents {
  addEventListener(type: "storage", listener: (event: StorageChange) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageChange) => void): void;
}

export type FrameScheduler = (callback: () => void) => void;

/**
 * Only the exact string "pastel" is pastel. Anything else stored under the key
 * (a stale value, a typo, another app's idea of a theme) falls back to the
 * default, as the source site's own check does.
 */
function parseTheme(stored: string | null): Theme {
  return stored === "pastel" ? "pastel" : DEFAULT_THEME;
}

export function readTheme(storage: Pick<Storage, "getItem"> | null = browserStorage()): Theme {
  if (!storage) return DEFAULT_THEME;
  try {
    return parseTheme(storage.getItem(THEME_KEY));
  } catch {
    // Storage that throws on read (blocked cookies, some private modes) means
    // the default, not a broken page.
    return DEFAULT_THEME;
  }
}

/** Persists the choice. Returns false when storage refused it. */
export function saveTheme(theme: Theme, storage: Pick<Storage, "setItem"> | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    // Private browsing and full quotas land here. The mode still changes for
    // this page; it just will not be remembered.
    return false;
  }
}

/**
 * Puts `theme` on the root element.
 *
 * Without `animate` it only sets or removes the attribute, which is right at
 * boot, before anything has been painted. With it, it follows the source
 * site's sequence (see the top of this file) so the switch lands in one frame.
 */
export function applyTheme(
  theme: Theme,
  root: ThemeRoot | null = browserRoot(),
  options: { animate?: boolean; nextFrame?: FrameScheduler } = {},
): void {
  if (!root) return;
  if (options.animate) root.classList.add(SWITCHING_CLASS);
  if (theme === "pastel") root.setAttribute(THEME_ATTRIBUTE, "pastel");
  else root.removeAttribute(THEME_ATTRIBUTE);
  if (!options.animate) return;
  // Reading layout forces the recalculation now, while transitions are off.
  void root.offsetHeight;
  (options.nextFrame ?? browserNextFrame)(() => root.classList.remove(SWITCHING_CLASS));
}

export interface ThemeStore {
  /** The mode on screen now. */
  get(): Theme;
  /** Switch, persist, and tell every subscriber. */
  set(theme: Theme): void;
  /** Called after every change, from here or from another tab. */
  subscribe(listener: () => void): () => void;
  /** Stops following other tabs and drops every subscriber. */
  dispose(): void;
}

export interface ThemeEnvironment {
  storage: ThemeStorage | null;
  root: ThemeRoot | null;
  events?: StorageEvents | null;
  nextFrame?: FrameScheduler;
}

/**
 * One source of truth for the mode, shared by every chip on the page.
 *
 * It reads the stored choice and applies it once, without the switching dance,
 * when created. That is the boot step, and it has to happen before React paints
 * anything, which is what theme-boot.ts is for.
 *
 * `get` returns the value held here rather than re-reading storage, so it is
 * stable between changes, as `useSyncExternalStore` requires.
 */
export function createThemeStore(env: ThemeEnvironment): ThemeStore {
  let current = readTheme(env.storage);
  applyTheme(current, env.root);

  const listeners = new Set<() => void>();
  const frameOptions = env.nextFrame ? { animate: true, nextFrame: env.nextFrame } : { animate: true };

  const adopt = (next: Theme): void => {
    if (next === current) return;
    current = next;
    applyTheme(next, env.root, frameOptions);
    // A copy, so a listener that unsubscribes while being told does not skip
    // the one after it.
    for (const listener of [...listeners]) listener();
  };

  const onStorage = (event: StorageChange): void => {
    // The same event fires for sessionStorage changes in same-origin frames;
    // only the store this mode lives in counts.
    if (env.storage && event.storageArea !== env.storage) return;
    // A null key is another tab calling `localStorage.clear()`: the stored
    // choice is gone, which reads as the default everywhere else, so here too.
    if (event.key === null) return adopt(DEFAULT_THEME);
    if (event.key === THEME_KEY) adopt(parseTheme(event.newValue));
  };
  env.events?.addEventListener("storage", onStorage);

  return {
    get: () => current,
    set(theme) {
      // Callers are typed, but this is the one entry point a stray value from
      // the DOM could reach, so it refuses rather than storing garbage.
      if (!isTheme(theme)) return;
      saveTheme(theme, env.storage);
      adopt(theme);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      env.events?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

let pageStore: ThemeStore | undefined;

/**
 * The page's store, created on first use against the real document, storage
 * and window. theme-boot.ts calls this before anything renders.
 */
export function themeStore(): ThemeStore {
  pageStore ??= createThemeStore({
    storage: browserStorage(),
    root: browserRoot(),
    events: typeof window === "undefined" ? null : window,
  });
  return pageStore;
}

function browserStorage(): ThemeStorage | null {
  try {
    // Merely touching `localStorage` throws a SecurityError where storage is
    // blocked, so even the lookup is inside the try.
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function browserRoot(): ThemeRoot | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

function browserNextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
  else setTimeout(callback, 0);
}
