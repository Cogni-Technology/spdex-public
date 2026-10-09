/**
 * Included → Final: how settled one transaction is, as the person's network
 * service reports it.
 *
 * "Included" means a block holds it, and a block can still be replaced.
 * "Final" means Ethereum's validators have finalized that block: undoing it
 * would need a third of all staked ETH to be destroyed. The difference is
 * about 13 to 19 minutes, and it is the difference between a receipt and a
 * settled trade, so the badge shows both.
 *
 * - **The service's word.** Which block is finalized comes from the person's
 *   own network service (`eth_getBlockByNumber("finalized")`), and the badge
 *   says so. A service that doesn't report one makes finality unknown, never
 *   assumed.
 * - **A replaced block is noticed.** When the finalized block reaches the
 *   transaction's, the block at that height is read once and its hash
 *   compared with the receipt's. A different one means the block was
 *   replaced, and the receipt is read again to see where it landed.
 * - **It gives up, and says so.** After 45 minutes without inclusion (a
 *   private relay may have dropped it, and then nothing was spent) or without
 *   finality, the badge stops and points to an explorer.
 * - **It reads little.** The receipt every 12 seconds while waiting for
 *   inclusion, one finalized-block read every 30 seconds for the whole page
 *   however many badges wait, one block read at the end. Nothing while the
 *   tab is hidden.
 */

import { useEffect, useState } from "react";
import type { JsonRpc } from "@spdex/chain";
import type { Hex } from "@spdex/core";
import { formatCount } from "./money/format.js";
import { perfNow, whenVisible } from "./page.js";
import { quantity, readReceipt } from "./receipts.js";

export const RECEIPT_POLL_MS = 12_000;
export const FINALIZED_POLL_MS = 30_000;
export const GIVE_UP_MS = 45 * 60_000;
const SECONDS_PER_BLOCK = 12;
/** Finality moves a checkpoint at a time: 32 blocks. */
const BLOCKS_PER_EPOCH = 32n;
/** Past this, finality isn't following the chain as it should, and the badge gives no estimate. */
const MAX_ESTIMATE_MINUTES = 30;

export type FinalityState = "sent" | "included" | "final" | "unknown" | "replaced" | "gave-up";

export type FinalityView =
  | { state: "sent" }
  | { state: "included"; block: bigint; finalized: bigint | null }
  | { state: "final"; block: bigint }
  | { state: "unknown"; block: bigint }
  | { state: "replaced" }
  | { state: "gave-up"; stage: "sent" | "included"; block: bigint | null };

export const INCLUDED_TIP =
  "A block on the chain holds this transaction. Until that block is final, usually 13 to 19 minutes, the network could still replace it; spDEX would notice, and say so here.";

export const FINAL_TIP =
  "Ethereum's validators have finalized the block this transaction is in: undoing it would need a third of all staked ETH to be destroyed. It usually takes 13 to 19 minutes. spDEX takes your network service's word for which block is finalized.";

/**
 * Minutes until `block` is likely final, from where finality is now: the
 * blocks still to go, rounded up to a whole checkpoint, at 12 seconds each.
 * Fifteen when finality hasn't been read yet.
 */
export function minutesToFinal(block: bigint, finalized: bigint | null): number {
  if (finalized === null) return 15;
  const behind = block > finalized ? block - finalized : 0n;
  const blocks = ((behind + BLOCKS_PER_EPOCH - 1n) / BLOCKS_PER_EPOCH) * BLOCKS_PER_EPOCH;
  return Math.max(1, Math.round((Number(blocks) * SECONDS_PER_BLOCK) / 60));
}

/** The badge's words. */
export function finalityText(view: FinalityView): string {
  switch (view.state) {
    case "sent":
      return "Sent: waiting to be included";
    case "included": {
      // Finality far behind is a service that lags or a fork that mines no
      // blocks: no estimate is worth giving then.
      const minutes = minutesToFinal(view.block, view.finalized);
      return `Included in block ${formatCount(view.block)} · ${minutes > MAX_ESTIMATE_MINUTES ? "not final yet" : `final in about ${minutes} min`}`;
    }
    case "final":
      return "Final ✓: your network service reports this block as finalized";
    case "unknown":
      return "Finality unknown: your network service doesn't report finalized blocks.";
    case "replaced":
      return "The block it was in was replaced; checking where it landed…";
    case "gave-up":
      return view.stage === "sent"
        ? "Not included after 45 minutes. If it was sent privately, the relay may have dropped it, and then nothing was spent. Look it up on an explorer."
        : "Not reported final after 45 minutes. Look it up on an explorer.";
  }
}

// ─── The finalized block, one read for the page ───────────────────────────────

/**
 * JSON-RPC errors that mean "ask again later" rather than "I can't": a rate
 * limit. Any other error the service answered with, with a code, means it
 * doesn't serve the finalized block.
 */
const TRANSIENT_CODES = new Set([-32005, 429]);

/** The finalized block as a network service reports it, read at most once every 30 seconds however many ask. */
export class FinalizedHead {
  readonly #rpc: JsonRpc;
  readonly #now: () => number;
  #value: bigint | null = null;
  #readAt = Number.NEGATIVE_INFINITY;
  #unsupported = false;
  #inFlight: Promise<bigint | "unsupported" | null> | null = null;

  constructor(rpc: JsonRpc, now: () => number = perfNow) {
    this.#rpc = rpc;
    this.#now = now;
  }

  /** The finalized block's number; "unsupported" when the service doesn't report one; null when it can't be told right now. */
  get(): Promise<bigint | "unsupported" | null> {
    if (this.#unsupported) return Promise.resolve("unsupported");
    if (this.#value !== null && this.#now() - this.#readAt < FINALIZED_POLL_MS) return Promise.resolve(this.#value);
    this.#inFlight ??= this.#read().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #read(): Promise<bigint | "unsupported" | null> {
    try {
      const block = (await this.#rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: unknown } | null;
      const number = quantity(block?.number);
      if (number === null) return this.#give("unsupported");
      this.#value = number;
      this.#readAt = this.#now();
      return number;
    } catch (error) {
      // Only the service's own answer, with a code that isn't a rate limit,
      // says it doesn't serve finalized blocks. A rate limit, and a request
      // that got no answer at all (Wi-Fi gone, a laptop asleep), say nothing
      // about the service: unknown for now, asked again next time. Counting
      // them used to switch finality off for the session after a sleep.
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "number" && !TRANSIENT_CODES.has(code)) return this.#give("unsupported");
      return null;
    }
  }

  #give(answer: "unsupported"): "unsupported" {
    this.#unsupported = true;
    return answer;
  }
}

const heads = new WeakMap<JsonRpc, FinalizedHead>();

/** The page's one reader of `rpc`'s finalized block. */
export function finalizedHead(rpc: JsonRpc): FinalizedHead {
  let head = heads.get(rpc);
  if (!head) heads.set(rpc, (head = new FinalizedHead(rpc)));
  return head;
}

// ─── Watching one transaction ─────────────────────────────────────────────────

/** Time and visibility, injected so tests can script them. */
export interface WatchEnv {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Resolves once the tab is visible: at once when it already is. */
  whenVisible(): Promise<void>;
}

function pageEnv(): WatchEnv {
  return { now: perfNow, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), whenVisible };
}

/** Transactions seen final this session: a remounted badge shows it at once, with no read. */
const finalHashes = new Map<string, bigint>();

/** What is already known about `hash` without a read: final, or nothing. */
export function knownFinality(hash: string): FinalityView | null {
  const block = finalHashes.get(hash.toLowerCase());
  return block === undefined ? null : { state: "final", block };
}

/**
 * Follow `hash` until it is final, finality turns out unknown, or 45 minutes
 * pass, calling `onView` with each change. Returns a function that stops it.
 */
export function watchFinality(
  rpc: JsonRpc,
  hash: Hex,
  onView: (view: FinalityView) => void,
  options: { env?: WatchEnv; head?: FinalizedHead } = {},
): () => void {
  const env = options.env ?? pageEnv();
  const head = options.head ?? finalizedHead(rpc);
  let stopped = false;
  let last = "";
  const emit = (view: FinalityView) => {
    const key = JSON.stringify(view, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    if (stopped || key === last) return;
    last = key;
    onView(view);
  };

  const known = knownFinality(hash);
  if (known !== null) {
    emit(known);
    return () => undefined;
  }

  void (async () => {
    const started = env.now();
    let included: { block: bigint; blockHash: Hex } | null = null;
    emit({ state: "sent" });
    while (!stopped) {
      await env.whenVisible();
      if (stopped) return;
      if (included === null) {
        const receipt = await readReceipt(rpc, hash).catch(() => null);
        if (receipt !== null) {
          included = { block: receipt.blockNumber, blockHash: receipt.blockHash };
          emit({ state: "included", block: included.block, finalized: null });
        }
      }
      if (included !== null) {
        const finalized = await head.get();
        if (finalized === "unsupported") {
          emit({ state: "unknown", block: included.block });
          return;
        }
        if (finalized !== null && finalized >= included.block) {
          const found = await blockHashAt(rpc, included.block);
          if (found === included.blockHash) {
            finalHashes.set(hash.toLowerCase(), included.block);
            emit({ state: "final", block: included.block });
            return;
          }
          if (found !== undefined) {
            // Another block now stands at that height: the receipt is read
            // again, on the next look, to see where the transaction went.
            included = null;
            emit({ state: "replaced" });
          }
        } else if (finalized !== null) {
          emit({ state: "included", block: included.block, finalized });
        }
      }
      if (env.now() - started >= GIVE_UP_MS) {
        emit({ state: "gave-up", stage: included === null ? "sent" : "included", block: included?.block ?? null });
        return;
      }
      await env.sleep(RECEIPT_POLL_MS);
    }
  })();

  return () => {
    stopped = true;
  };
}

/** The hash of the block at `number`, null when there is none, undefined when it couldn't be read. */
async function blockHashAt(rpc: JsonRpc, number: bigint): Promise<Hex | null | undefined> {
  try {
    const block = (await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false])) as { hash?: unknown } | null;
    if (block === null) return null;
    return typeof block.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(block.hash) ? (block.hash.toLowerCase() as Hex) : undefined;
  } catch {
    return undefined;
  }
}

/** A transaction's finality, kept current while the component is mounted. */
export function useFinality(rpc: JsonRpc, hash: Hex): FinalityView {
  const [view, setView] = useState<FinalityView>(() => knownFinality(hash) ?? { state: "sent" });
  useEffect(() => watchFinality(rpc, hash, setView), [rpc, hash]);
  return view;
}
