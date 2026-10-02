/**
 * The main page's tiles: which exist, which is open, and how anything on the
 * page brings a place into view wherever it lives (`reveal`).
 *
 * The page is a stack of at most eight tiles (TileGroup and Tile in
 * @spdex/ui), at most one open. Which one is open is state held by `App` in
 * memory, never persisted and never in the URL: a `#tile=` would collide
 * with `#receipt=` and settings links, which App reads and then clears, and
 * would add history entries. On load it is the receipt tile when a
 * `#receipt=` link is pending, otherwise Welcome while it is on the page,
 * otherwise `DEFAULT_OPEN`, Buy SPX (`initialOpen`). Never nothing: with
 * every tile closed the page was a thin column of headers, too small to read
 * as a page on a desktop.
 *
 * `reveal` replaces every ad hoc `querySelector(…).scrollIntoView()` that
 * crosses panels. It finds the element, switches to the Expert view if the
 * element lives only there, opens its tile and every closed `<details>`
 * around it, scrolls to it and focuses it. It never focuses a control that
 * asks the wallet or changes money or settings (UI rule R2, docs/ARCHITECTURE.md): such a target
 * gets its nearest `tabIndex={-1}` container instead, and that includes a
 * target whose first focusable is one.
 *
 * With `returnTo`, the tile it opened shows "← Back to …" (the back chip),
 * which reopens the tile `returnTo` is in and focuses it. It returns only
 * when asked: returning on `change` or `blur` would pull focus away from
 * someone tabbing through.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PillStatus, TileBack } from "@spdex/ui";
import { scrollBehavior } from "./a11y.js";
import type { View } from "./prefs.js";

export type TileId = "receipt" | "start" | "trade" | "auto-buys" | "yours" | "markets" | "community" | "settings";

/** The tiles in page order. Eight is the ceiling (docs/ARCHITECTURE.md, "The page"): a new tile needs a row here. */
export const TILE_ORDER: readonly TileId[] = [
  "receipt",
  "start",
  "trade",
  "auto-buys",
  "yours",
  "markets",
  "community",
  "settings",
];

/** Each tile's chip (a boxed label, hidden from assistive technology) and title (its accessible name). */
export const TILES: Readonly<Record<TileId, { chip: string; title: string }>> = {
  receipt: { chip: "RECEIPT", title: "Shared transaction" },
  start: { chip: "NEW", title: "Welcome, new aeon" },
  trade: { chip: "BELIEVE", title: "Buy SPX" },
  "auto-buys": { chip: "PLANS", title: "Auto-buys" },
  yours: { chip: "STACK", title: "Your SPX" },
  markets: { chip: "DATA", title: "Markets" },
  community: { chip: "VAULTS", title: "Collective DCA" },
  settings: { chip: "SETUP", title: "Settings" },
};

/**
 * What is open on load when neither a shared receipt nor Welcome claims the
 * page: Buy SPX, the page's main action. Everything must work with any value
 * here; the e2e specs open what they need (`openTile`, which is a no-op on a
 * tile already open).
 */
export const DEFAULT_OPEN: TileId = "trade";

/** What the page knows before its first render that decides the tile open on load. */
export interface LoadState {
  /** A `#receipt=` link is waiting to be shown: that is what the visit is for. */
  receiptPending: boolean;
  /** Welcome will be on the page: not hidden in this browser, on a chain it serves. */
  welcomeShown: boolean;
}

/** What opens on load: a pending receipt, then Welcome, then `DEFAULT_OPEN`. */
export function initialOpen(load: LoadState): TileId {
  if (load.receiptPending) return "receipt";
  return load.welcomeShown ? "start" : DEFAULT_OPEN;
}

export function isTileId(value: unknown): value is TileId {
  return typeof value === "string" && (TILE_ORDER as readonly string[]).includes(value);
}

/** A tile header's summary: at most about 40 characters, from state the page already holds, and an optional pill. */
export interface TileSummary {
  text: string;
  status?: PillStatus;
}

// ─── Header summaries built from state the page holds ──────────────────────

/*
 * Each at most about 40 characters. None of them reads anything: they are
 * made from what the page already has, and a figure it doesn't have is
 * "unknown" or "not read yet", never 0. A panel that reports its own summary
 * (`onSummary`) replaces these.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** TRADE: the pair, and whether a swap is going through. */
export function tradeSummary(input: { tokenIn: string; tokenOut: string; recurring: boolean; swapping: boolean }): TileSummary {
  if (input.swapping) return { text: "Swapping…", status: "action" };
  return { text: `${input.tokenIn} → ${input.tokenOut}${input.recurring ? " · recurring" : ""}` };
}

/** RECEIPT: the shared transaction's hash, short. */
export function receiptSummary(hash: string): TileSummary {
  return { text: `${hash.slice(0, 6)}…${hash.slice(-4)}` };
}

/** NEW: how many of Welcome's four steps are done, or the card offer after a first buy. */
export function startSummary(steps: readonly string[], firstBuy: boolean): TileSummary {
  if (firstBuy) return { text: "make a card" };
  return { text: `${steps.filter((step) => step === "done").length} of ${steps.length} done` };
}

/** STACK: the SPX in the wallet and the records kept, each unknown on its own. */
export function yoursSummary(input: { account: boolean; holding: string | null; seen: boolean; records: number | null }): TileSummary {
  if (!input.account) return { text: "connect a wallet" };
  const holding = input.holding !== null ? `${input.holding} SPX` : input.seen ? "unknown" : "not read yet";
  return { text: input.records === null ? holding : `${holding} · ${plural(input.records, "record", "records")}` };
}

/** DATA: the pair's markets and the liquidity in them. */
export function marketsSummary(input: {
  phase: "off" | "discovering" | "failed" | "reading" | "ready";
  pair: string;
  pools: number;
  /** The pools' total, formatted; null when any pool couldn't be priced. */
  total: string | null;
}): TileSummary {
  if (input.phase === "off") return { text: "off" };
  // The service didn't answer: the markets are unknown, never "none found".
  if (input.phase === "failed") return { text: `${input.pair} · unknown` };
  if (input.phase !== "ready") return { text: "reading…" };
  if (input.pools === 0) return { text: `${input.pair} · no markets found` };
  const pools = plural(input.pools, "pool", "pools");
  return { text: input.total === null ? `${input.pair} · ${pools} · unknown` : `${input.pair} · ${input.total} in ${pools}` };
}

/** SETUP: the view, how many features are on, and the page's currency. */
export function settingsSummary(input: { view: View; features: number; currency: string }): TileSummary {
  return {
    text: `${input.view === "expert" ? "Expert" : "Simple"} · ${plural(input.features, "feature", "features")} · ${input.currency}`,
  };
}

/**
 * The panel contract: what a panel that can sit in a tile accepts.
 *
 * With `open` undefined, the panel behaves exactly as before tiles: its own
 * `Panel` or `FoldedPanel` and title, its own reads. With `open` defined it
 * drops its outer panel and title (the tile header says it), keeps its root
 * `data-testid`, and starts its reads on the first `open === true`. It
 * reports its summary through `onSummary`, from an effect, whenever the
 * summary changes. A summary never triggers a read and never shows 0 for
 * something unknown.
 */
export interface TilePanelProps {
  open?: boolean;
  onSummary?: (summary: TileSummary) => void;
}

export interface RevealOptions {
  /** Where the element lands in the viewport; "center" by default. */
  block?: ScrollLogicalPosition;
  /** Focus it (the default), or only bring it into view. */
  focus?: boolean;
  /** Where "← Back to …" returns: the element focused again, in its tile. */
  returnTo?: HTMLElement | null;
  /** The back chip's words after "Back to", when the origin tile's title isn't the right name ("steps (2 of 4)"). */
  backLabel?: string;
}

export interface TilesApi {
  openId: TileId | null;
  isOpen(id: TileId): boolean;
  /** Opens `id`, closing the open one; clears a back chip. */
  open(id: TileId): void;
  /** Closes the open tile; clears a back chip. */
  close(): void;
  /**
   * Brings a place into view wherever it lives (see the top of this file).
   * `target` is a `data-testid` or an element. Resolves false when there is
   * no such element, even in the Expert view.
   */
  reveal(target: string | HTMLElement, opts?: RevealOptions): Promise<boolean>;
  /** The back chip, when one shows: TileGroup's `back`. */
  back: TileBack | null;
}

// ─── Focus that never lands on money (UI rule R2) ────────────────────────────

/**
 * Controls that ask the wallet or change money or settings. A key, a
 * shortcut or `reveal` never focuses one of these. `[data-money-control]`
 * marks any other; prefer it to growing this list.
 */
export const MONEY_CONTROLS = [
  "[data-money-control]",
  '[data-testid="swap-button"]',
  '[data-testid="dca-form-start"]',
  '[data-testid="dca-vault-create"]',
  '[data-testid="dca-vault-fund"]',
  '[data-testid="dca-vault-close"]',
  '[data-testid="dca-vault-close-confirm"]',
  '[data-testid="dca-vault-trigger"]',
  '[data-testid="dca-confirm-buy"]',
  '[data-testid="dca-resume-confirm"]',
  '[data-testid="dca-delete-confirm"]',
  '[data-testid="dca-remove-plans-confirm"]',
  '[data-testid="dca-recreate"]',
  '[data-testid="help-run-send"]',
  '[data-testid="fallback-accept"]',
  '[data-testid="accept-staged"]',
  '[data-testid="reset-config"]',
  '[data-testid="change-rpc"]',
  '[data-testid="rpc-save"]',
  '[data-testid="second-opinion-save"]',
  '[data-testid="older-save-restore"]',
  '[data-testid^="permit2-revoke-"]',
  // Tip this address (UI rule R2), in the tip row and in Expert's tip editor.
  '[data-testid^="tip-add-"]',
  '[data-testid^="expert-tip-add-"]',
  // Switches auto-buy on for this browser.
  '[data-testid="dca-enable"]',
  // First run: choosing a service changes settings and sends it this
  // visitor's IP address.
  '[data-testid="rpc-use-bundled"]',
  '[data-testid="rpc-use-fallback"]',
  // The built-in service's notice: the same two choices.
  '[data-testid="builtin-use-fallback"]',
  '[data-testid="builtin-choose"]',
  // Every button that opens the wallet.
  '[data-testid="connect-button"]',
  '[data-testid="connect-to-swap"]',
  '[data-testid="status-connect"]',
  '[data-testid="yours-connect"]',
  '[data-testid="welcome-connect"]',
  '[data-testid="dca-form-connect"]',
  '[data-testid="dca-panel-connect"]',
  '[data-testid="add-network"]',
].join(", ");

/**
 * How long a money control that has just come within reach ignores a press.
 * A double click or tap is two presses 100 to 500 ms apart: when the first
 * closes the disclaimer, or brings a prompt under the pointer, the second
 * must not press what is now there (UI rule R2). The OS default for a double click
 * is 500 ms.
 */
export const ARM_AFTER_MS = 500;

/**
 * Arms a money control: false until the control has been interactive for
 * `ms`, then true. Give the control `ariaDisabled={!armed}`: it stays
 * focusable and in place, looks unavailable for that moment, and a press
 * does nothing. `interactive` false (the page inert behind the disclaimer)
 * holds it unarmed, so the time starts when the page takes input again, not
 * when the control was first rendered behind the gate.
 */
export function useArmed(interactive = true, ms = ARM_AFTER_MS): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!interactive) return;
    const timer = setTimeout(() => setArmed(true), ms);
    return () => clearTimeout(timer);
  }, [interactive, ms]);
  return armed;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** The parts of an element `safeFocusTarget` reads, so the rule can be checked without a DOM. */
export interface FocusCandidate {
  matches(selector: string): boolean;
  querySelector(selector: string): FocusCandidate | null;
  closest(selector: string): FocusCandidate | null;
  readonly parentElement: FocusCandidate | null;
}

/**
 * Where focus goes when `el` is the place to show: `el` itself (a
 * `<details>`: its summary), unless that is a money control or starts with
 * one, when it is the nearest `tabIndex={-1}` container around it, or
 * nowhere if there is none. `el` itself counts as a container when it isn't
 * focusable: `reveal` makes it one.
 */
export function safeFocusTarget<T extends FocusCandidate>(el: T): { target: T; makeFocusable: boolean } | null {
  const own = (el.matches("details") ? el.querySelector(":scope > summary") : el) as T | null;
  if (own === null) return null;
  const containerAround = (from: T) => (from.parentElement?.closest('[tabindex="-1"]') ?? null) as T | null;
  if (own.matches(MONEY_CONTROLS)) {
    const container = containerAround(own);
    return container === null ? null : { target: container, makeFocusable: false };
  }
  if (own.matches(FOCUSABLE) || own.matches('[tabindex="-1"]')) return { target: own, makeFocusable: false };
  // Not focusable itself: it becomes the container, so what it starts with doesn't matter.
  return { target: own, makeFocusable: true };
}

function focusSafely(el: HTMLElement): void {
  const found = safeFocusTarget(el);
  if (found === null) return;
  if (found.makeFocusable && !found.target.hasAttribute("tabindex")) found.target.setAttribute("tabindex", "-1");
  found.target.focus({ preventScroll: true });
}

// ─── Waiting for React to put something on the page ─────────────────────────

/** Resolves with `probe()`'s first non-null answer, checked once a frame; null after `frames` frames. */
function until<T>(probe: () => T | null, frames = 30): Promise<T | null> {
  return new Promise((resolve) => {
    let left = frames;
    const step = () => {
      const found = probe();
      if (found !== null || left-- <= 0) resolve(found);
      else requestAnimationFrame(step);
    };
    step();
  });
}

function byTestId(target: string | HTMLElement): HTMLElement | null {
  if (typeof target !== "string") return target.isConnected ? target : null;
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(target)}"]`);
}

function tileOf(el: Element | null | undefined): TileId | null {
  const id = el?.closest<HTMLElement>("[data-tile]")?.dataset["tile"];
  return isTileId(id) ? id : null;
}

/** Everything after the tile is open: the `<details>` around it opened, scrolled to, focused. */
function show(el: HTMLElement, opts: RevealOptions): void {
  for (let d = el.closest("details"); d !== null; d = d.parentElement?.closest("details") ?? null) {
    if (!d.open) d.open = true;
  }
  el.scrollIntoView({ block: opts.block ?? "center", behavior: scrollBehavior() });
  if (opts.focus !== false) focusSafely(el);
}

// ─── The page's tiles ───────────────────────────────────────────────────────

export interface TilesEnvironment {
  /** The view on screen, and how to switch it. */
  view: View;
  setView: (view: View) => void;
  /** Whether a test id is rendered only in the Expert view (places.ts: `isExpertOnly`). */
  expertOnly?: (testId: string) => boolean;
  /** Says something politely to assistive technology (the status widget's live region). */
  announce?: (message: string) => void;
  /** What is open on load; `initialOpen(…)` by default. */
  initial?: TileId | null;
}

interface BackState {
  /** The tile the chip shows in. */
  tileId: TileId;
  /** The tile it returns to. */
  origin: TileId;
  returnTo: HTMLElement;
  label: string;
}

/** The tiles' state, for `App` to hold and hand down through `TilesContext`. */
export function useTilesState(env: TilesEnvironment): TilesApi {
  const [openId, setOpenId] = useState<TileId | null>(env.initial === undefined ? DEFAULT_OPEN : env.initial);
  const [back, setBack] = useState<BackState | null>(null);
  const envRef = useRef(env);
  envRef.current = env;
  const openRef = useRef(openId);
  openRef.current = openId;

  const open = useCallback((id: TileId) => {
    setOpenId(id);
    setBack(null);
  }, []);
  const close = useCallback(() => {
    setOpenId(null);
    setBack(null);
  }, []);

  const reveal = useCallback(async (target: string | HTMLElement, opts: RevealOptions = {}): Promise<boolean> => {
    let el = byTestId(target);
    const { view, setView, expertOnly, announce } = envRef.current;
    if (el === null && typeof target === "string" && view !== "expert" && expertOnly?.(target) === true) {
      setView("expert");
      announce?.("Switched to Expert view");
      el = await until(() => byTestId(target));
    }
    if (el === null) return false;
    const tile = tileOf(el);
    if (tile !== null && openRef.current !== tile) {
      const origin = tileOf(opts.returnTo);
      setOpenId(tile);
      setBack(
        opts.returnTo && origin !== null && origin !== tile
          ? { tileId: tile, origin, returnTo: opts.returnTo, label: opts.backLabel ?? TILES[origin].title }
          : null,
      );
      const shown = el;
      await until(() => (shown.closest("[data-tile]")?.getAttribute("data-open") === "true" ? true : null));
      if (!el.isConnected) return false;
    }
    show(el, opts);
    return true;
  }, []);

  const backRef = useRef(back);
  backRef.current = back;
  const goBack = useCallback(() => {
    const current = backRef.current;
    if (current === null) return;
    setBack(null);
    setOpenId(current.origin);
    const { returnTo } = current;
    void until(() => (returnTo.closest("[data-tile]")?.getAttribute("data-open") === "true" ? true : null)).then(() => {
      if (!returnTo.isConnected) return;
      returnTo.scrollIntoView({ block: "center", behavior: scrollBehavior() });
      focusSafely(returnTo);
    });
  }, []);

  return useMemo<TilesApi>(
    () => ({
      openId,
      isOpen: (id) => openId === id,
      open,
      close,
      reveal,
      back: back === null ? null : { tileId: back.tileId, label: back.label, onBack: goBack },
    }),
    [openId, back, open, close, reveal, goBack],
  );
}

/**
 * Before the page is laid out as tiles (and wherever no provider is above):
 * nothing is ever open, and `reveal` finds, unfolds, scrolls and focuses
 * without switching views, so a place only the Expert view renders resolves
 * false while the view is Simple.
 */
const LAYOUTLESS: TilesApi = {
  openId: null,
  isOpen: () => false,
  open: () => undefined,
  close: () => undefined,
  async reveal(target, opts = {}) {
    const el = byTestId(target);
    if (el === null) return false;
    show(el, opts);
    return true;
  },
  back: null,
};

export const TilesContext = createContext<TilesApi | null>(null);

/** The page's tiles, from the nearest `TilesContext` (App provides it). */
export function useTiles(): TilesApi {
  return useContext(TilesContext) ?? LAYOUTLESS;
}
