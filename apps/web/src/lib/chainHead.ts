/**
 * The status widget's one live fact: the latest block, as the person's
 * network service reports it, and how the last read went (SERVICE ● ONLINE).
 *
 * There is no poll. The head is read once when the page loads with a service
 * chosen and the tab in front (or when it first comes to the front), again
 * when the service changes, when the browser comes back online, and when the
 * person presses ↻. A 30-second poll would spend the publisher's bundled key
 * about 120 times an hour per open tab and tell the endpoint which tabs are
 * open, for a number nobody needs refreshed. The read's local time is shown
 * beside the block, so a stale figure says how stale it is.
 *
 * - `navigator.onLine === false` is OFFLINE at once, with no request.
 * - A failed read is tried once more after 5 seconds; two in a row is OFFLINE.
 * - A rate limit (code 429 or -32005) is BUSY, and not retried.
 * - A read that took 3 seconds or more is SLOW.
 * - A block that couldn't be read is unknown, never 0.
 *
 * The link state comes from these reads alone: nothing wraps `engine.rpc`
 * to watch other readers. The finalized block (the DETAILS row) is read only
 * when DETAILS opens or ↻ is pressed, through the page's shared
 * `finalizedHead`, and never while OFFLINE.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { JsonRpc } from "@spdex/chain";
import { finalizedHead } from "./finality.js";
import { formatCount } from "./money/format.js";
import { perfNow, whenVisible } from "./page.js";

export type LinkState = "none" | "reading" | "online" | "slow" | "busy" | "offline";

export interface HeadView {
  state: LinkState;
  /** The block of the last good read, or null when there is none or the last read failed. */
  block: bigint | null;
  /** When that read finished, in the device's time (for "14:02"), or null. */
  readAt: number | null;
  /** A read is in flight. */
  reading: boolean;
}

/** A read that took this long or longer is SLOW. */
export const SLOW_MS = 3_000;
/** A failed read is tried once more after this long. */
export const RETRY_MS = 5_000;
/** Answers that mean "ask later": a rate limit. */
const BUSY_CODES = new Set([429, -32005]);

/** Time, the network's state and a way to wait, injected so tests can script them. */
export interface HeadEnv {
  /** A monotonic clock, for how long a read took. */
  now(): number;
  /** The device's clock, for the time a read is shown with. */
  wallClock(): number;
  sleep(ms: number): Promise<void>;
  /** False when the browser knows it is offline. */
  online(): boolean;
}

function pageEnv(): HeadEnv {
  return {
    now: perfNow,
    wallClock: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  };
}

function busy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && BUSY_CODES.has(code);
}

function parseBlock(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw)) return null;
  return BigInt(raw);
}

const NONE: HeadView = { state: "none", block: null, readAt: null, reading: false };

/**
 * One network service's head, read only when asked. Listeners hear every
 * change. `cancel` drops a read in flight and a retry that is waiting (the
 * service changed, or the page let go of it): what they would have found is
 * never shown, and the retry is never sent.
 */
export class ChainHead {
  readonly #rpc: JsonRpc | null;
  readonly #env: HeadEnv;
  #view: HeadView;
  #listeners = new Set<() => void>();
  #inFlight: Promise<void> | null = null;
  #generation = 0;

  constructor(rpc: JsonRpc | null, env: HeadEnv = pageEnv()) {
    this.#rpc = rpc;
    this.#env = env;
    this.#view = rpc === null ? NONE : { state: "reading", block: null, readAt: null, reading: false };
  }

  view = (): HeadView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  cancel(): void {
    this.#generation += 1;
    this.#inFlight = null;
    if (this.#view.reading) this.#set({ ...this.#view, reading: false });
  }

  /** The browser says it is offline: OFFLINE at once, no request. */
  wentOffline(): void {
    if (this.#rpc === null) return;
    this.#set({ ...this.#view, state: "offline", reading: false });
  }

  /** Reads the head once (with its one retry). A read already in flight is shared, not repeated. */
  read(): Promise<void> {
    if (this.#rpc === null) return Promise.resolve();
    if (!this.#env.online()) {
      this.wentOffline();
      return Promise.resolve();
    }
    if (this.#inFlight !== null) return this.#inFlight;
    const reading: Promise<void> = this.#readWithRetry(this.#rpc).finally(() => {
      // Only this read's own slot: a cancelled one mustn't clear a newer one.
      if (this.#inFlight === reading) this.#inFlight = null;
    });
    this.#inFlight = reading;
    return reading;
  }

  async #readWithRetry(rpc: JsonRpc): Promise<void> {
    const generation = this.#generation;
    const dropped = () => generation !== this.#generation;
    this.#set({ ...this.#view, reading: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = this.#env.now();
      try {
        const block = parseBlock(await rpc("eth_blockNumber", []));
        if (dropped()) return;
        if (block === null) throw new Error("eth_blockNumber: not a block number");
        const took = this.#env.now() - started;
        this.#set({ state: took >= SLOW_MS ? "slow" : "online", block, readAt: this.#env.wallClock(), reading: false });
        return;
      } catch (error) {
        if (dropped()) return;
        if (busy(error)) {
          this.#set({ state: "busy", block: null, readAt: null, reading: false });
          return;
        }
        if (attempt === 0) {
          await this.#env.sleep(RETRY_MS);
          if (dropped()) return;
          if (!this.#env.online()) {
            this.wentOffline();
            return;
          }
        }
      }
    }
    if (dropped()) return;
    this.#set({ state: "offline", block: null, readAt: null, reading: false });
  }

  #set(view: HeadView): void {
    this.#view = view;
    for (const listener of [...this.#listeners]) listener();
  }
}

// ─── Words ────────────────────────────────────────────────────────────────────

/** The state as the widget writes it: always a word, so colour is never the only signal. */
export const LINK_WORDS: Record<LinkState, { glyph: string; word: string }> = {
  none: { glyph: "○", word: "No service" },
  reading: { glyph: "…", word: "Reading" },
  online: { glyph: "●", word: "Online" },
  slow: { glyph: "▲", word: "Slow" },
  busy: { glyph: "▲", word: "Busy" },
  offline: { glyph: "✕", word: "Offline" },
};

/**
 * "14:02", the device's local time. Kept on one line: a narrow status
 * widget may wrap the BLOCK row, but at its " · ", never leaving "AM" alone.
 */
export function clockText(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }).replace(/\s/g, "\u00a0");
}

/** The BLOCK row: "#26,000,359 · 14:02", "…" while the first read runs, "unknown" when it failed. */
export function blockText(view: HeadView, locale?: string): string {
  if (view.block !== null && view.readAt !== null) return `#${formatCount(view.block)} · ${clockText(view.readAt, locale)}`;
  if (view.reading || view.state === "reading") return "…";
  return "unknown";
}

/** Seconds a block takes on Ethereum, for turning a gap in blocks into minutes. */
const SECONDS_PER_BLOCK = 12;

/**
 * The FINAL row: how far the finalized block trails the head, "−64 BLK · ~13 MIN".
 * "unknown" when either is unknown or the service doesn't report finalized
 * blocks; "…" while it is being read.
 */
export function finalText(head: bigint | null, finalized: bigint | "unsupported" | "reading" | null): string {
  if (finalized === "reading") return "…";
  if (head === null || finalized === null || finalized === "unsupported") return "unknown";
  const behind = head > finalized ? head - finalized : 0n;
  const minutes = Math.round((Number(behind) * SECONDS_PER_BLOCK) / 60);
  return `−${formatCount(behind)} blk · ~${formatCount(minutes)} min`;
}

// ─── On the page ──────────────────────────────────────────────────────────────

export interface ChainHeadOnPage {
  view: HeadView;
  /** The finalized block: read when `wantFinalized` turns true and on each refresh, never while offline. */
  finalized: bigint | "unsupported" | "reading" | null;
  /** ↻: reads the head again, and the finalized block if it is wanted. */
  refresh(): void;
}

/**
 * The page's chain head for `rpc` (the engine's; null before a service is
 * chosen). `wantFinalized` is DETAILS being open.
 */
export function useChainHead(rpc: JsonRpc | null, wantFinalized: boolean, env?: HeadEnv): ChainHeadOnPage {
  const head = useMemo(() => new ChainHead(rpc, env), [rpc, env]);
  const view = useSyncExternalStore(head.subscribe, head.view, head.view);

  // Once per service: when the tab is (or first comes) in front.
  useEffect(() => {
    if (rpc === null) return;
    let cancelled = false;
    void whenVisible().then(() => {
      if (!cancelled) void head.read();
    });
    return () => {
      cancelled = true;
      head.cancel();
    };
  }, [head, rpc]);

  // The browser's own word on the network: offline at once, and a read when it returns.
  useEffect(() => {
    if (rpc === null || typeof window === "undefined") return;
    const offline = () => head.wentOffline();
    const online = () => void head.read();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [head, rpc]);

  const [finalized, setFinalized] = useState<{ rpc: JsonRpc; value: bigint | "unsupported" | "reading" | null } | null>(null);
  const [asked, setAsked] = useState(0);
  const offline = view.state === "offline";

  useEffect(() => {
    if (rpc === null || !wantFinalized || offline) return;
    let cancelled = false;
    setFinalized({ rpc, value: "reading" });
    void finalizedHead(rpc)
      .get()
      .then((value) => {
        if (!cancelled) setFinalized({ rpc, value });
      });
    return () => {
      cancelled = true;
    };
    // `offline` only gates it: coming back online doesn't read again by itself (the head read does).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, wantFinalized, asked]);

  const refresh = useCallback(() => {
    void head.read();
    setAsked((n) => n + 1);
  }, [head]);

  return {
    view,
    finalized: finalized !== null && finalized.rpc === rpc ? finalized.value : null,
    refresh,
  };
}
