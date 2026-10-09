/**
 * The display preferences: text size, motion and contrast (the display dock's
 * TEXT, MOTION and CONTRAST rows), and the page's one answer to "should this
 * move?".
 *
 * Kept like the colour mode (theme.ts), not in the config: a fact about this
 * browser, one localStorage key (`spdex.a11y.v2`, holding only what differs
 * from the default; `spdex.a11y.v1` is read once by `migrateA11y`), following other tabs
 * through `storage` events, and applied before the first paint by
 * theme-boot.ts, the first import of main.tsx (the CSP forbids an inline
 * script in the page head, which is where a site would usually do this).
 *
 * Each is an attribute on the root element, which theme.css reads:
 *   - `data-text="100" | "130"`, absent at the default, A+ (115%): the
 *     root font size, which every rem in the stylesheets scales from. The
 *     page lays out the same at every size (theme.css, Page layout), so a
 *     size changes how big things are, never where they are;
 *   - `data-motion="reduce"`: nothing animates or transitions, and scrolling
 *     jumps rather than glides;
 *   - `data-contrast="more"`: dim text becomes ink, hairlines solid, the
 *     paper plain, decoration hidden.
 *
 * "AUTO" is the absence of the attribute, and the stylesheet follows the
 * system's `prefers-reduced-motion` and `prefers-contrast` on its own. So a
 * setting here can only add accessibility, never take away what the system
 * asked for: AUTO under a system that reduces motion is reduced.
 */

import { createPrefStore, type Pref, type PrefStorage, type PrefStore, type StorageEvents } from "./prefs.js";
import { pageEvents, pageStorage } from "./page.js";

export const A11Y_KEY = "spdex.a11y.v2";

/**
 * Where builds before A+ became the default kept these. They wrote every
 * field on any change, so a `text` there may be a size nobody chose (a
 * change of motion wrote `text: 100` too): motion and contrast carry over
 * (`migrateA11y`), the size does not.
 */
export const A11Y_KEY_V1 = "spdex.a11y.v1";

export const TEXT_SIZES = [100, 115, 130] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export type MotionPref = "auto" | "reduce";
export type ContrastPref = "auto" | "more";

export interface A11yPrefs {
  /** Percent of the browser's default text size. */
  text: TextSize;
  motion: MotionPref;
  contrast: ContrastPref;
}

/** A+ by default: at 100% the page read as too small on a desktop. */
export const DEFAULT_A11Y: A11yPrefs = { text: 115, motion: "auto", contrast: "auto" };

/**
 * What storage holds, field by field: a field this code didn't write falls
 * back to its own default without taking the others with it, so a value an
 * older or newer build wrote costs at most that one setting.
 */
export const A11Y_PREF: Pref<A11yPrefs> = {
  key: A11Y_KEY,
  parse(raw) {
    const stored: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return { ...DEFAULT_A11Y };
    const { text, motion, contrast } = stored as Record<string, unknown>;
    return {
      text: TEXT_SIZES.includes(text as TextSize) ? (text as TextSize) : DEFAULT_A11Y.text,
      motion: motion === "reduce" ? "reduce" : "auto",
      contrast: contrast === "more" ? "more" : "auto",
    };
  },
  /**
   * Only what differs from the default, so what is stored is what the person
   * chose, and a later change of default reaches everyone who never chose.
   * Nothing chosen removes the key.
   */
  format(prefs) {
    const chosen: Partial<A11yPrefs> = {};
    if (prefs.text !== DEFAULT_A11Y.text) chosen.text = prefs.text;
    if (prefs.motion !== DEFAULT_A11Y.motion) chosen.motion = prefs.motion;
    if (prefs.contrast !== DEFAULT_A11Y.contrast) chosen.contrast = prefs.contrast;
    return Object.keys(chosen).length === 0 ? null : JSON.stringify(chosen);
  },
};

/**
 * Carries motion and contrast over from `spdex.a11y.v1`, once: only while
 * v2 holds nothing. The size starts at the default. Storage that refuses
 * leaves the defaults for this visit.
 */
export function migrateA11y(storage: PrefStorage | null): void {
  if (!storage) return;
  try {
    if (storage.getItem(A11Y_KEY) !== null) return;
    const old = storage.getItem(A11Y_KEY_V1);
    if (old === null) return;
    const { motion, contrast } = A11Y_PREF.parse(old);
    const carried = A11Y_PREF.format({ ...DEFAULT_A11Y, motion, contrast });
    if (carried !== null) storage.setItem(A11Y_KEY, carried);
  } catch {
    // Unreadable or refused: the defaults, for this visit.
  }
}

/** The parts of the root element written here. */
export interface A11yRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Puts `prefs` on the root: an attribute for each setting that adds something, none for a default. */
export function applyA11y(prefs: A11yPrefs, root: A11yRoot | null = browserRoot()): void {
  if (!root) return;
  if (prefs.text === DEFAULT_A11Y.text) root.removeAttribute("data-text");
  else root.setAttribute("data-text", String(prefs.text));
  if (prefs.motion === "reduce") root.setAttribute("data-motion", "reduce");
  else root.removeAttribute("data-motion");
  if (prefs.contrast === "more") root.setAttribute("data-contrast", "more");
  else root.removeAttribute("data-contrast");
}

export interface A11yEnvironment {
  storage: PrefStorage | null;
  root: A11yRoot | null;
  events?: StorageEvents | null;
}

/**
 * One store for the page's display preferences: read and applied once when
 * created (the boot step), applied again on every change, from here or from
 * another tab.
 */
export function createA11yStore(env: A11yEnvironment): PrefStore<A11yPrefs> {
  migrateA11y(env.storage);
  const store = createPrefStore(A11Y_PREF, env.storage, env.events ?? null);
  applyA11y(store.get(), env.root);
  store.subscribe(() => applyA11y(store.get(), env.root));
  return store;
}

let pageStore: PrefStore<A11yPrefs> | undefined;

/** The page's store, created on first use against the real document; theme-boot.ts calls it before anything renders. */
export function a11yStore(): PrefStore<A11yPrefs> {
  pageStore ??= createA11yStore({ storage: pageStorage(), root: browserRoot(), events: pageEvents() });
  return pageStore;
}

/** Changes some of the display preferences, keeping the rest. */
export function setA11y(patch: Partial<A11yPrefs>, store: PrefStore<A11yPrefs> = a11yStore()): void {
  store.set({ ...store.get(), ...patch });
}

// ─── Should this move? ──────────────────────────────────────────────────────

/** What `reducedMotion` reads: the root's attribute and the system's setting. */
export interface MotionEnvironment {
  root: { getAttribute(name: string): string | null } | null;
  matchMedia: ((query: string) => { matches: boolean }) | null;
}

function browserMotion(): MotionEnvironment {
  return {
    root: browserRoot(),
    matchMedia: typeof globalThis.matchMedia === "function" ? (query) => globalThis.matchMedia(query) : null,
  };
}

/**
 * True when nothing should animate: the in-page LESS setting, or the system's
 * reduced motion. Either is enough.
 */
export function reducedMotion(env: MotionEnvironment = browserMotion()): boolean {
  if (env.root?.getAttribute("data-motion") === "reduce") return true;
  return env.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** How to scroll something into view: a jump under reduced motion, a glide otherwise. */
export function scrollBehavior(env: MotionEnvironment = browserMotion()): ScrollBehavior {
  return reducedMotion(env) ? "auto" : "smooth";
}

function browserRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}
