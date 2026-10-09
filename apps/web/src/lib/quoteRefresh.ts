/**
 * A price on screen, asked again while someone is looking at it.
 *
 * Mainstream swap pages keep their price current, and so does this one, but
 * every price is about eight requests to the person's network service (the
 * markets, the test-run, the fee), and spDEX has no server to absorb them: on
 * the built-in key every visitor shares one month's budget, and on a free key
 * of one's own a tab left open would spend it. So it is bounded three ways:
 *
 * - every `QUOTE_REFRESH_MS`, and only while the tab is visible: a hidden
 *   tab waits, and asks once when it is shown again;
 * - at most `QUOTE_REFRESH_LIMIT` times after a price was asked for (five
 *   minutes), and not again after a refresh that brought no price;
 * - only while the price is the page's whole state: never while one is being
 *   asked for or a swap is under way, and never over a swap's result or an
 *   error (the page says when, `active`).
 *
 * Refresh price is offered only once the refreshes have stopped: before
 * that it would only ask early, as one more button beside Swap.
 *
 * A refresh asks for the same token amount: an amount typed in money is
 * never sized again by it (ARCHITECTURE.md, "Frozen"), and once its price is
 * too old to quote, the refresh asks nothing, which stops them.
 */

import { useEffect, useState } from "react";

/** How often a price on screen is asked again: 30 seconds. */
export const QUOTE_REFRESH_MS = 30_000;

/** How many times after a price was asked for: five minutes' worth. */
export const QUOTE_REFRESH_LIMIT = 10;

/** What the scheduler needs from the page, passed in so tests can stand in for it. */
export interface RefreshEnv {
  visible(): boolean;
  /** Calls `listener` whenever the tab's visibility changes; returns how to stop. */
  onVisibility(listener: () => void): () => void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function pageEnv(): RefreshEnv {
  return {
    visible: () => document.visibilityState === "visible",
    onVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * Waits `QUOTE_REFRESH_MS`, then calls `refresh` once the tab is visible (at
 * once if it is). Returns how to cancel: the page cancels when the price on
 * screen changes and schedules the next.
 */
export function scheduleRefresh(refresh: () => void, env: RefreshEnv = pageEnv()): () => void {
  let due = false;
  let done = false;
  const fire = () => {
    if (done || !due || !env.visible()) return;
    done = true;
    stop();
    refresh();
  };
  const stop = env.onVisibility(fire);
  const timer = env.setTimeout(() => {
    due = true;
    fire();
  }, QUOTE_REFRESH_MS);
  return () => {
    done = true;
    env.clearTimeout(timer);
    stop();
  };
}

/** Where the refreshes of one asked-for price stand. */
export interface RefreshRun {
  /** The price they refresh: changes when someone asks for one. */
  asked: number;
  refreshes: number;
  /** No more: the last was the limit, or it brought no price. */
  stopped: boolean;
}

export const startRun = (asked: number): RefreshRun => ({ asked, refreshes: 0, stopped: false });

/**
 * The run once a refresh of the price `asked` for has finished, `landed` when
 * it put a new price on screen. A refresh of a price since replaced changes
 * nothing.
 */
export function afterRefresh(run: RefreshRun, asked: number, landed: boolean): RefreshRun {
  if (run.asked !== asked) return run;
  const refreshes = run.refreshes + 1;
  return { asked, refreshes, stopped: !landed || refreshes >= QUOTE_REFRESH_LIMIT };
}

/**
 * Keeps a price on screen current, as above. `asked` changes when someone asks
 * for a price (Get price, Refresh price, connecting), which starts the count
 * again; `refresh` resolves true when it put a new price on screen. Returns
 * whether the refreshes have stopped, which is when the page offers Refresh
 * price.
 */
export function useQuoteRefresh(input: { active: boolean; asked: number; refresh: () => Promise<boolean> }): boolean {
  const { active, asked, refresh } = input;
  const [run, setRun] = useState(() => startRun(asked));
  // A new price asked for: set before any refresh of it is scheduled, so a
  // late one of the price before can't count against it.
  if (run.asked !== asked) setRun(startRun(asked));
  const { stopped, refreshes } = run;
  useEffect(() => {
    if (!active || stopped) return;
    return scheduleRefresh(() => {
      void refresh().then((landed) => setRun((was) => afterRefresh(was, asked, landed)));
    });
  }, [active, asked, stopped, refreshes, refresh]);
  return stopped;
}
