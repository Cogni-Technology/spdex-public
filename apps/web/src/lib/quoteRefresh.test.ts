import { describe, expect, it } from "vitest";
import { QUOTE_REFRESH_LIMIT, QUOTE_REFRESH_MS, afterRefresh, scheduleRefresh, startRun, type RefreshEnv } from "./quoteRefresh.js";

/** A page whose clock and visibility the test moves by hand. */
function fakePage(visible = true) {
  let shown = visible;
  let timer: { run: () => void; ms: number } | null = null;
  const listeners = new Set<() => void>();
  const env: RefreshEnv = {
    visible: () => shown,
    onVisibility: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTimeout: (run, ms) => (timer = { run, ms }),
    clearTimeout: () => (timer = null),
  };
  return {
    env,
    elapse: () => timer?.run(),
    show: (now: boolean) => {
      shown = now;
      for (const listener of [...listeners]) listener();
    },
    timer: () => timer,
    listening: () => listeners.size,
  };
}

describe("the price on screen", () => {
  it("is asked again after 30 seconds, for five minutes at most", () => {
    expect(QUOTE_REFRESH_MS).toBe(30_000);
    expect(QUOTE_REFRESH_LIMIT * QUOTE_REFRESH_MS).toBe(5 * 60_000);
  });

  it("asks once, when the time comes, in a visible tab", () => {
    const page = fakePage();
    let asked = 0;
    scheduleRefresh(() => (asked += 1), page.env);
    expect(page.timer()?.ms).toBe(QUOTE_REFRESH_MS);
    expect(asked).toBe(0);
    page.elapse();
    expect(asked).toBe(1);
    // Once: being shown again later asks nothing more.
    page.show(false);
    page.show(true);
    expect(asked).toBe(1);
    expect(page.listening()).toBe(0);
  });

  it("waits while the tab is hidden, and asks when it is shown", () => {
    const page = fakePage(false);
    let asked = 0;
    scheduleRefresh(() => (asked += 1), page.env);
    page.elapse();
    expect(asked).toBe(0);
    page.show(true);
    expect(asked).toBe(1);
  });

  it("asks nothing when shown again before its time", () => {
    const page = fakePage(false);
    let asked = 0;
    scheduleRefresh(() => (asked += 1), page.env);
    page.show(true);
    expect(asked).toBe(0);
    page.elapse();
    expect(asked).toBe(1);
  });

  it("asks nothing once cancelled: a new price, a swap, or the page leaving", () => {
    const page = fakePage();
    let asked = 0;
    const cancel = scheduleRefresh(() => (asked += 1), page.env);
    cancel();
    expect(page.timer()).toBeNull();
    expect(page.listening()).toBe(0);
    page.show(true);
    expect(asked).toBe(0);
  });
});

describe("the refreshes of one price", () => {
  it("stop after the tenth, which is when Refresh price comes back", () => {
    let run = startRun(7);
    for (let i = 1; i < QUOTE_REFRESH_LIMIT; i += 1) {
      run = afterRefresh(run, 7, true);
      expect(run.stopped).toBe(false);
    }
    run = afterRefresh(run, 7, true);
    expect(run).toEqual({ asked: 7, refreshes: QUOTE_REFRESH_LIMIT, stopped: true });
  });

  it("stop after one that brought no price: it failed, or asked nothing", () => {
    const run = afterRefresh(afterRefresh(startRun(7), 7, true), 7, false);
    expect(run).toEqual({ asked: 7, refreshes: 2, stopped: true });
  });

  it("don't count one of a price since replaced", () => {
    const run = startRun(8);
    expect(afterRefresh(run, 7, false)).toBe(run);
  });
});
