/**
 * The page's own environment, for code that has to touch it: its storage,
 * its window's events, the tab's clock and whether the tab is visible.
 *
 * Each is null or a safe answer where there is no page (unit tests, server
 * rendering) or where touching it throws (storage a browser blocks), so no
 * caller has to guard it again. Code that takes these as arguments keeps its
 * own seam for tests; these are what it is given on the real page.
 */

/** The page's localStorage, or null where there is none or it can't be touched. */
export function pageStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some browsers throw on the property access itself when storage is blocked.
    return null;
  }
}

/** The window, for its `storage` events (another tab's writes), or null without one. */
export function pageEvents(): Pick<Window, "addEventListener" | "removeEventListener"> | null {
  return typeof window === "undefined" ? null : window;
}

/** `performance.now()`: the tab's own clock, which a change of the device's time can't move. 0 without one. */
export function perfNow(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

/** Whether the tab is in front of the person; true without a document. */
export function tabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Resolves once the tab is visible: at once when it is. */
export function whenVisible(): Promise<void> {
  return new Promise((resolve) => {
    if (tabVisible()) {
      resolve();
      return;
    }
    const listener = () => {
      if (!tabVisible()) return;
      document.removeEventListener("visibilitychange", listener);
      resolve();
    };
    document.addEventListener("visibilitychange", listener);
  });
}
