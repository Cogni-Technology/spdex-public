/**
 * The page's rates: read when something on screen needs them, kept fresh
 * while it still does, and never read otherwise.
 *
 * - **On demand.** Nothing is read until a figure or a field asks
 *   (`request`): the default page makes no background reads for money.
 * - **Refreshed while needed.** Dollar prices every 5 minutes and currency
 *   rates every 15, while the tab is visible and something still asks. The
 *   currency read is the same request whatever currency is chosen, and runs
 *   on the same schedule for everyone (packages/chain/src/fx.ts).
 * - **A failed refresh keeps the last answer** for display, up to 30
 *   minutes, and tries again after a minute. A refresh that prices fewer
 *   tokens than the last one counts as failed, so a flaky read can't replace
 *   good prices with none. When the network service failed it (busy, no
 *   answer, turned away), `failure` says so, so a field can say the service
 *   is why rather than send someone to type the token instead.
 * - **One network service.** Rates belong to the service that answered: when
 *   the source changes, everything read through the old one is dropped.
 * - **And a second opinion, when one is set.** The same rates are read through
 *   the second service at the same moment (`Engine.secondOpinionRates`), and
 *   the snapshot carries which of them the two put more than 1% apart
 *   (agreement.ts). Typed money is never sized from those. The comparison
 *   rides on every read, so it is as fresh as the rates themselves.
 *
 * Every time is `performance.now()`, never the device clock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TOKENS } from "@spdex/chain";
import { compareRates, type CheckedRateSnapshot, type SecondRates } from "./agreement.js";
import type { MoneyView } from "./convert.js";
import { numberLocale } from "./currency.js";
import type { FxSnapshot, MoneyPrefs, Pricing, RateSnapshot, RateSource, RatesFailure } from "./pricing.js";
import { isFreshForDisplay } from "./resolve.js";
import { friendlyError } from "../errors.js";
import { perfNow, tabVisible } from "../page.js";

/**
 * Where rates come from, and, when a second opinion is set, the same rates
 * read through the second service: null without one (the Engine's
 * `secondOpinionRates`).
 */
export type CheckedRateSource = RateSource & {
  secondOpinionRates?(tokens: readonly string[]): Promise<SecondRates | null>;
};

/**
 * `snapshot` with what the second service's reads say of it: which rates the
 * two put more than 1% apart. Without a second opinion, or when its read
 * failed (its own failure, never a disagreement), the snapshot has no such
 * field and sizes money as it always has.
 */
export function withSecondOpinion(snapshot: RateSnapshot | null, second: SecondRates | null): CheckedRateSnapshot | null {
  if (snapshot === null) return null;
  const { secondOpinion: _previous, ...plain } = snapshot as CheckedRateSnapshot;
  return second === null ? plain : { ...plain, secondOpinion: compareRates(plain, second) };
}

/** How often dollar prices are read again while something needs them. */
export const USD_REFRESH_MS = 300_000;
/** How often currency rates are: they move slowly, and pause at weekends. */
export const FX_REFRESH_MS = 900_000;
/** How long after a failed read the next one waits. */
export const RETRY_MS = 60_000;
/** How often a field or figure that needs rates says so again, and re-checks their age. */
export const NEED_TICK_MS = 15_000;

/** The tokens priced: every listed token trades as one of these, and USDC is a dollar by definition. */
const PRICED_TOKENS: readonly string[] = [TOKENS.WETH.address, TOKENS.SPX.address];

/** What a read needs to know about the last one. */
export interface ReadState {
  snapshot: RateSnapshot | null;
  /** `performance.now()` of the last failed read, or null. */
  failedAt: number | null;
}

/** Which parts are due: dollars when absent or 5 minutes old (or forced), currencies when absent or 15 minutes old. */
export function readsDue(last: ReadState, nowMs: number, force: boolean, secondOpinion = false): { usd: boolean; fx: boolean } {
  const s = last.snapshot;
  const usd = force || s === null || nowMs - s.usdReadAt >= USD_REFRESH_MS;
  const fx = s === null || s.fx === null || s.fxReadAt === null || nowMs - s.fxReadAt >= FX_REFRESH_MS;
  if (!force && last.failedAt !== null && nowMs - last.failedAt < RETRY_MS) return { usd: false, fx: false };
  // The second service's rates are read on every pass, so with a second
  // opinion both of the main service's parts are read then too. A part kept
  // from an earlier pass (dollar rates up to five minutes old, once "Use the
  // price now" put the two out of step) compared with a fresh second read
  // would mark a real move in the 10-minute average as the two disagreeing.
  if (secondOpinion && (usd || fx)) return { usd: true, fx: true };
  return { usd, fx };
}

/**
 * The snapshot after a read that started at `startedAt`. `usd` and `fx` are
 * what came back (null for a part that wasn't read or failed). A dollar read
 * that prices fewer tokens than the last one is a failure: the old prices
 * stay, with their old time, rather than fresh-looking gaps.
 */
export function nextSnapshot(
  last: RateSnapshot | null,
  startedAt: number,
  usd: Map<string, bigint> | null,
  fx: FxSnapshot | null,
): { snapshot: RateSnapshot | null; usdFailed: boolean } {
  const covers = usd !== null && (last === null || [...last.usd.keys()].every((token) => usd.has(token)));
  const priced = usd !== null && [...usd.keys()].some((token) => PRICED_TOKENS.some((p) => p.toLowerCase() === token));
  const usdOk = covers && (last !== null || priced);
  const base = usdOk ? { usd, usdReadAt: startedAt } : last === null ? null : { usd: last.usd, usdReadAt: last.usdReadAt };
  if (base === null) return { snapshot: null, usdFailed: true };
  const fxPart = fx !== null ? { fx, fxReadAt: startedAt } : { fx: last?.fx ?? null, fxReadAt: last?.fxReadAt ?? null };
  return { snapshot: { ...base, ...fxPart }, usdFailed: !usdOk };
}

/**
 * Why a dollar read failed, when the network service failed it: what
 * `usdRates` threw, as lib/errors.ts reads it. Null for anything else,
 * nothing thrown included (the service answered, and there was no price).
 */
export function serviceFailure(error: unknown): RatesFailure | null {
  if (error === null || error === undefined) return null;
  return friendlyError(error instanceof Error ? error.message : String(error)).service ?? null;
}

/**
 * The page's `Pricing`, reading through `source` (the Engine) when asked.
 * `prefs` supplies the currency and the number format.
 */
export function usePricing(source: CheckedRateSource | null, prefs: MoneyPrefs): Pricing {
  const [snapshot, setSnapshot] = useState<RateSnapshot | null>(null);
  const [state, setState] = useState<Pricing["state"]>("idle");
  const [failure, setFailure] = useState<RatesFailure | null>(null);
  const [lastHiddenAt, setLastHiddenAt] = useState<number | null>(null);
  const last = useRef<ReadState>({ snapshot: null, failedAt: null });
  const inFlight = useRef<Promise<RateSnapshot | null> | null>(null);
  const sourceRef = useRef(source);

  // Rates from one network service are that service's answers. A new source
  // (a new endpoint, so a new Engine) starts from nothing.
  useEffect(() => {
    sourceRef.current = source;
    last.current = { snapshot: null, failedAt: null };
    inFlight.current = null;
    setSnapshot(null);
    setState("idle");
    setFailure(null);
  }, [source]);

  // A read from before the tab was hidden can't size an amount (resolve.ts),
  // however young it is: the person may come back to a different market.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") setLastHiddenAt(performance.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const read = useCallback(async (force: boolean): Promise<RateSnapshot | null> => {
    const from = sourceRef.current;
    if (from === null) return null;
    if (inFlight.current !== null) return inFlight.current;
    const startedAt = performance.now();
    const due = readsDue(last.current, startedAt, force, from.secondOpinionRates !== undefined);
    if (!due.usd && !due.fx) return last.current.snapshot;

    setState("reading");
    const run = (async () => {
      let usdError: unknown = null;
      const [usd, fx, second] = await Promise.all([
        due.usd
          ? from.usdRates(PRICED_TOKENS).catch((error: unknown) => {
              usdError = error;
              return null;
            })
          : Promise.resolve(null),
        due.fx ? from.fxRates().catch(() => null) : Promise.resolve(null),
        from.secondOpinionRates === undefined ? Promise.resolve(null) : from.secondOpinionRates(PRICED_TOKENS).catch(() => null),
      ]);
      // An answer from a service that has since been replaced is not this page's.
      if (sourceRef.current !== from) return null;
      const read = nextSnapshot(last.current.snapshot, startedAt, due.usd ? usd : null, fx);
      const next = { ...read, snapshot: withSecondOpinion(read.snapshot, second) };
      const failed = (due.usd && next.usdFailed) || (due.fx && fx === null);
      last.current = { snapshot: next.snapshot, failedAt: failed ? performance.now() : null };
      setSnapshot(next.snapshot);
      // Why the dollar read failed, when it was read: kept until the next one.
      if (due.usd) setFailure(next.usdFailed ? serviceFailure(usdError) : null);
      const usable = next.snapshot !== null && isFreshForDisplay(next.snapshot, performance.now());
      setState(usable ? "ready" : "unavailable");
      return due.usd && next.usdFailed ? null : next.snapshot;
    })();
    inFlight.current = run;
    try {
      return await run;
    } finally {
      if (inFlight.current === run) inFlight.current = null;
    }
  }, []);

  const request = useCallback(() => {
    void read(false);
  }, [read]);

  const reread = useCallback(() => read(true), [read]);

  const locale = numberLocale(prefs.numbers);
  return useMemo(
    () => ({ snapshot, state, failure, currency: prefs.currency, locale, lastHiddenAt, request, reread }),
    [snapshot, state, failure, prefs.currency, locale, lastHiddenAt, request, reread],
  );
}

/**
 * For a field or figure that needs rates while `active`: asks once now, and
 * again every 15 seconds and whenever the tab comes back (a read happens
 * only when one is due). Returns `performance.now()` as of the last tick, so
 * the caller re-renders when an amount's rates grow too old to use.
 *
 * A decision that moves money reads `performance.now()` itself at that
 * moment; this tick is for what the screen shows.
 */
export function useRatesNeeded(pricing: Pricing | null | undefined, active: boolean): number {
  const [now, setNow] = useState(perfNow);
  const request = pricing?.request;
  useEffect(() => {
    if (request === undefined || !active) return;
    const tick = () => {
      setNow(perfNow());
      if (tabVisible()) request();
    };
    tick();
    const timer = setInterval(tick, NEED_TICK_MS);
    const onVisibility = () => {
      if (tabVisible()) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [request, active]);
  return now;
}

/**
 * What "≈" figures are shown from: the page's rates while they are at most
 * 30 minutes old, in the chosen currency and number format, or nothing, and
 * the figure is left off: unknown, never zero.
 */
export function moneyView(pricing: Pricing | null | undefined, nowMs: number): MoneyView | undefined {
  if (pricing === null || pricing === undefined) return undefined;
  const s = pricing.snapshot;
  if (s === null || !isFreshForDisplay(s, nowMs)) return undefined;
  return { usd: s.usd, fx: s.fx, currency: pricing.currency, locale: pricing.locale };
}
