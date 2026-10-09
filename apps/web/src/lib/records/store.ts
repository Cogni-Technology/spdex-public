/**
 * This browser's record of swaps and tips, and what it has learned about
 * them and about plan buys: `spdex.receipts.v1`.
 *
 * A one-time swap otherwise leaves no trace in spDEX. The chain has it, but
 * nothing ties it to this person except their address, and nobody should
 * have to search a block explorer for their own trades at tax time. So each
 * swap and tip made here is written down when it settles, with what it
 * measurably sold and bought, and whatever rates this browser held then.
 *
 * What the store holds:
 * - `receipts`: the swaps and tips, oldest first, at most 1,000. Older ones
 *   are let go, and Your activity says how many. The buys of a plan the
 *   person deleted join them then (`keepPlanBuys`): the plan's own record
 *   goes with it, and its buys must not.
 * - `seen`: the rates held when a trade was seen settling, by transaction
 *   hash (`twap-seen` in values.ts), for swaps, tips and plan buys alike.
 * - `tx`: each transaction's sender, fee, block and outcome, read once from
 *   its receipt and kept forever, since none of them can change.
 * - `blocks` and `fx`: block times, and Chainlink's answers at a block when
 *   the person asked for them. Currency answers are shared by every trade
 *   seen with the same read, rather than copied into each.
 *
 * It holds the person's addresses and hashes, so it never enters the config,
 * an export or a share link, and it is never uploaded: it goes to a file only
 * when the person downloads one.
 *
 * **It never destroys what it can't read.** A receipt, rate or fact in a shape
 * this code doesn't know (one a newer spDEX wrote, on the same site) is kept
 * as it was and written back untouched; only the parts this code knows are
 * read. A whole file it can't read, or one of a later version, is left alone:
 * `read()` says so, and nothing is written over it.
 *
 * **Every write happens under one lock** (`spdex.receipts`, Web Locks), as the
 * ledger's do: two tabs recording at once must not each write back a copy
 * missing the other's swap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Multicall3Reader, NATIVE_TOKEN, isNativeToken, type JsonRpc } from "@spdex/chain";
import type { Address, DcaPlan, Hex } from "@spdex/core";
import type { QuoteResult } from "../engine.js";
import { balanceOf } from "../erc20.js";
import type { ExecuteResult, ExecutionError } from "../execute.js";
import type { FxAnswer, FxSnapshot, Pricing } from "../money/pricing.js";
import { pageEvents, pageStorage, perfNow } from "../page.js";
import type { TipOutcome } from "../tipFlow.js";
import { RUN_CODES, type DcaLedger, type DcaLedgerEntry } from "../dca/ledger.js";
import { cardTitle } from "../dca/view.js";
import { readVaultHistory, type VaultHistory, type VaultPlanState } from "../dca/vault.js";
import { readBlockTime, readReceipt, readTxValue, type ChainReceipt } from "../receipts.js";
import { eachLimited, factsOf, measureSwap, transferRecipients, transferTotal, type TxFacts } from "./attribution.js";
import {
  buildRows,
  pendingReads,
  receiptRow,
  rowsFor,
  unattributedNote,
  type BlockFacts,
  type BuildInput,
  type ReceiptsRead,
  type RecordsLookup,
  type VaultBuys,
} from "./build.js";
import {
  answerFromStored,
  answerToStored,
  fillable,
  fxFromStored,
  fxToStored,
  ratesFromStored,
  ratesSeenNow,
  readChainlinkAt,
  SEEN_RECORD_MAX_AGE_MS,
  type StoredRates,
} from "./values.js";
import type { RecordRow } from "./types.js";

export const RECEIPTS_KEY = "spdex.receipts.v1";
/** The Web Locks name every write of the store is made under. */
export const RECEIPTS_LOCK = "spdex.receipts";
/** Swaps and tips kept, newest last; older ones are let go. */
export const MAX_RECEIPTS = 1_000;

// Each map is capped too, oldest entry first. A person confirming hourly buys
// adds facts for years; the caps keep the whole store well inside what a
// browser gives a site, beside the config and the ledger.
const MAX_SEEN = 2_000;
const MAX_TX = 4_000;
const MAX_BLOCKS = 4_000;
const MAX_FX = 1_500;

// ─── Shapes ───────────────────────────────────────────────────────────────────

/** One side of a recorded trade, as JSON. */
export interface StoredLeg {
  token: Address;
  /** Base units as a decimal string; null when unknown. */
  amount: string | null;
  measured: boolean;
}

/**
 * A swap, a tip, or a batch of other people's due vault buys, made in this
 * browser (`buy-fees-earned`: Help run the network; its `bought` is the WETH
 * its buys paid in buy fees, and its `sold` a known 0 of WETH), or a buy of
 * a plan since deleted (`plan-buy`, kept by `keepPlanBuys`).
 */
export interface StoredReceipt {
  id: string;
  kind: "swap" | "tip" | "buy-fees-earned" | "plan-buy";
  chainId: number;
  /** Unix seconds by this device's clock, when it was recorded. */
  at: number;
  /** Every transaction, in the order sent. */
  hashes: Hex[];
  sold: StoredLeg;
  bought: StoredLeg;
  /** A swap that stopped part-way: some of its legs went through, and the rest didn't. */
  partial?: boolean;
  /** A `plan-buy`'s plan, as it was when it was deleted, and which of its buys this was. */
  plan?: { id: string; label: string; n: number; of: number };
  /** A `tip`'s swap: the id of the swap it was sent with. Tips recorded before this was kept have none. */
  forSwap?: string;
  /** A `tip`'s recipients: how many addresses its receipt shows it paid, when that could be read. */
  recipients?: number;
}

/** The store as read: the parts this code knows, parsed. `dropped` counts swaps and tips let go to keep the latest 1,000. */
export type Receipts = ReceiptsRead;

/** What a write may change. */
export interface ReceiptsDraft {
  /** Adds a receipt, or replaces the one with its id. */
  addReceipt(receipt: StoredReceipt): void;
  setSeen(hash: string, chainId: number, rates: StoredRates): void;
  setTx(hash: string, facts: TxFacts): void;
  setBlockTime(chainId: number, block: bigint, time: number): void;
  setChainlink(chainId: number, read: FxSnapshot): void;
}

/** The file as stored, with every entry kept exactly as found. */
interface RawFile {
  v: 1;
  receipts: unknown[];
  dropped: number;
  seen: Record<string, unknown>;
  tx: Record<string, unknown>;
  blocks: Record<string, unknown>;
  fx: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isDecimal = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,78}$/.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export const blockKey = (chainId: number, block: bigint) => `${chainId}:${block}`;

function emptyFile(): RawFile {
  return { v: 1, receipts: [], dropped: 0, seen: {}, tx: {}, blocks: {}, fx: {} };
}

/** The file, or null when it isn't one this version wrote. Entries are not judged here. */
function parseFile(raw: unknown): RawFile | null {
  if (!isRecord(raw) || raw["v"] !== 1 || !Array.isArray(raw["receipts"])) return null;
  const map = (key: string) => (isRecord(raw[key]) ? { ...(raw[key] as Record<string, unknown>) } : {});
  return {
    ...raw,
    v: 1,
    receipts: [...raw["receipts"]],
    dropped: isCount(raw["dropped"]) ? raw["dropped"] : 0,
    seen: map("seen"),
    tx: map("tx"),
    blocks: map("blocks"),
    fx: map("fx"),
  };
}

function parseLeg(raw: unknown): StoredLeg | null {
  if (!isRecord(raw) || !isAddress(raw["token"]) || typeof raw["measured"] !== "boolean") return null;
  const amount = raw["amount"];
  if (amount !== null && !isDecimal(amount)) return null;
  return { token: raw["token"].toLowerCase() as Address, amount, measured: raw["measured"] };
}

const isStoredKind = (kind: unknown): kind is StoredReceipt["kind"] =>
  kind === "swap" || kind === "tip" || kind === "buy-fees-earned" || kind === "plan-buy";

/** A `plan-buy`'s plan: an id, a label, and "buy n of `of`". */
function parsePlanOfBuy(raw: unknown): StoredReceipt["plan"] | null {
  if (!isRecord(raw)) return null;
  const { id, label, n, of } = raw;
  if (typeof id !== "string" || typeof label !== "string" || !isCount(n) || !isCount(of) || n < 1) return null;
  return { id, label, n, of };
}

export function parseReceipt(raw: unknown): StoredReceipt | null {
  if (!isRecord(raw)) return null;
  const { id, kind, chainId, at, hashes } = raw;
  if (typeof id !== "string" || !isStoredKind(kind) || !Number.isSafeInteger(chainId) || !isCount(at)) {
    return null;
  }
  if (!Array.isArray(hashes) || hashes.length === 0 || !hashes.every(isHash)) return null;
  const sold = parseLeg(raw["sold"]);
  const bought = parseLeg(raw["bought"]);
  if (sold === null || bought === null) return null;
  const plan = kind === "plan-buy" ? parsePlanOfBuy(raw["plan"]) : undefined;
  if (plan === null) return null;
  // A tip's link to its swap is a later addition: one that doesn't parse is
  // left out, and the tip is kept, as it was before tips named their swap.
  const forSwap = kind === "tip" && typeof raw["forSwap"] === "string" && SWAP_ID.test(raw["forSwap"]) ? raw["forSwap"] : undefined;
  const recipients = kind === "tip" && isCount(raw["recipients"]) && raw["recipients"] > 0 ? raw["recipients"] : undefined;
  return {
    id,
    kind,
    chainId: chainId as number,
    at,
    hashes: hashes.map((h) => h.toLowerCase() as Hex),
    sold,
    bought,
    ...(raw["partial"] === true ? { partial: true } : {}),
    ...(plan === undefined ? {} : { plan }),
    ...(forSwap === undefined ? {} : { forSwap }),
    ...(recipients === undefined ? {} : { recipients }),
  };
}

/** A swap's id, as `recordSwap` writes it: `swap:<chain>:<first hash>`. */
const SWAP_ID = /^swap:[0-9]{1,16}:0x[0-9a-f]{64}$/;

function parseTx(raw: unknown): TxFacts | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw["chainId"]) || !isAddress(raw["from"]) || !isDecimal(raw["block"])) return null;
  if (!isHash(raw["blockHash"]) || (raw["status"] !== "success" && raw["status"] !== "reverted")) return null;
  const fee = raw["fee"];
  if (fee !== null && !isDecimal(fee)) return null;
  return {
    chainId: raw["chainId"] as number,
    from: raw["from"].toLowerCase() as Address,
    fee: fee === null ? null : BigInt(fee),
    block: BigInt(raw["block"]),
    blockHash: raw["blockHash"].toLowerCase() as Hex,
    status: raw["status"],
  };
}

function txToStored(facts: TxFacts): Record<string, unknown> {
  return {
    chainId: facts.chainId,
    from: facts.from.toLowerCase(),
    fee: facts.fee === null ? null : facts.fee.toString(),
    block: facts.block.toString(),
    blockHash: facts.blockHash.toLowerCase(),
    status: facts.status,
  };
}

/** The store's parts this code knows, from a raw file. */
function view(file: RawFile): Receipts {
  const receipts = file.receipts.flatMap((raw) => {
    const parsed = parseReceipt(raw);
    return parsed === null ? [] : [parsed];
  });
  const fxAt = (key: unknown) => (typeof key === "string" ? fxFromStored(file.fx[key]) : null);
  return {
    receipts,
    dropped: file.dropped,
    seen(hash) {
      const raw = file.seen[hash.toLowerCase()];
      if (!isRecord(raw)) return null;
      // The currency answers live in `fx`, shared; the rest is a StoredRates.
      const fx = fxAt(raw["fx"]);
      return ratesFromStored({ ...raw, fx: fx === null ? null : fxToStored(fx) });
    },
    tx(hash) {
      return parseTx(file.tx[hash.toLowerCase()]);
    },
    block(chainId, block): BlockFacts | null {
      const key = blockKey(chainId, block);
      const raw = file.blocks[key];
      if (!isRecord(raw)) return null;
      const time = isCount(raw["time"]) ? raw["time"] : null;
      const stored = raw["chainlink"];
      const fx = fxAt(key);
      const chainlink =
        isRecord(stored) && fx !== null ? { ...fx, eth: answerFromStored(stored["eth"]), usdc: answerFromStored(stored["usdc"]) } : null;
      return { time, chainlink };
    },
  };
}

function draftOf(file: RawFile): ReceiptsDraft {
  const blockEntry = (key: string): Record<string, unknown> => {
    const current = file.blocks[key];
    const entry = isRecord(current) ? { ...current } : {};
    file.blocks[key] = entry;
    return entry;
  };
  return {
    addReceipt(receipt) {
      const index = file.receipts.findIndex((raw) => isRecord(raw) && raw["id"] === receipt.id);
      const stored = JSON.parse(JSON.stringify(receipt)) as unknown;
      if (index === -1) file.receipts.push(stored);
      else file.receipts[index] = stored;
    },
    setSeen(hash, chainId, rates) {
      let fx: string | null = null;
      if (rates.fx !== null) {
        fx = blockKey(chainId, BigInt(rates.fx.block));
        file.fx[fx] = rates.fx;
      }
      file.seen[hash.toLowerCase()] = { at: rates.at, usd: rates.usd, fx };
    },
    setTx(hash, facts) {
      file.tx[hash.toLowerCase()] = txToStored(facts);
    },
    setBlockTime(chainId, block, time) {
      blockEntry(blockKey(chainId, block))["time"] = time;
    },
    setChainlink(chainId, read) {
      const key = blockKey(chainId, read.block);
      const stored = (answer: FxAnswer | null | undefined) => (answer === null || answer === undefined ? null : answerToStored(answer));
      blockEntry(key)["chainlink"] = { eth: stored(read.eth), usdc: stored(read.usdc) };
      file.fx[key] = fxToStored(read);
    },
  };
}

/** Keeps the oldest-first order and drops from the front: JSON objects keep their keys in insertion order. */
function capMap(map: Record<string, unknown>, max: number): void {
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete map[key];
}

function prune(file: RawFile): void {
  if (file.receipts.length > MAX_RECEIPTS) {
    const excess = file.receipts.length - MAX_RECEIPTS;
    file.receipts = file.receipts.slice(excess);
    file.dropped += excess;
  }
  capMap(file.seen, MAX_SEEN);
  capMap(file.tx, MAX_TX);
  capMap(file.blocks, MAX_BLOCKS);
  // Currency answers nothing points at any more go first.
  const used = new Set<string>();
  for (const raw of Object.values(file.seen)) if (isRecord(raw) && typeof raw["fx"] === "string") used.add(raw["fx"]);
  for (const [key, raw] of Object.entries(file.blocks)) if (isRecord(raw) && raw["chainlink"] !== undefined) used.add(key);
  for (const key of Object.keys(file.fx)) if (!used.has(key)) delete file.fx[key];
  capMap(file.fx, MAX_FX);
}

// ─── The store ────────────────────────────────────────────────────────────────

/** The part of `Storage` this needs; injected so tests run without a DOM. */
export interface ReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The part of the Web Locks API the store uses: `navigator.locks` in the app. */
export interface ReceiptLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
}

/** Where `storage` events arrive from: `window`, in the app. */
export interface ReceiptEvents {
  addEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
}

export class ReceiptStore {
  readonly #storage: ReceiptStorage | null;
  readonly #key: string;
  readonly #locks: ReceiptLocks | null;
  readonly #events: ReceiptEvents | null;
  readonly #listeners = new Set<() => void>();
  readonly #onStorage = (event: { key: string | null }) => {
    if (event.key === this.#key || event.key === null) this.#notify();
  };

  constructor(
    storage: ReceiptStorage | null,
    options: { key?: string; locks?: ReceiptLocks | null; events?: ReceiptEvents | null } = {},
  ) {
    this.#storage = storage;
    this.#key = options.key ?? RECEIPTS_KEY;
    this.#locks = options.locks === undefined ? pageLocks() : options.locks;
    this.#events = options.events === undefined ? pageEvents() : options.events;
    this.#events?.addEventListener("storage", this.#onStorage);
  }

  /** The store, or "unavailable" when it can't be read: storage refuses, or it holds something this version didn't write. */
  read(): Receipts | "unavailable" {
    const file = this.#readRaw();
    return file === "unavailable" ? "unavailable" : view(file);
  }

  /**
   * Apply `change` and write the result, under the lock. Resolves to false,
   * having written nothing, when the store can't be read or storage refuses
   * the write. Never throws: a record that couldn't be kept must not turn a
   * finished swap into an error.
   */
  async write(change: (draft: ReceiptsDraft) => void): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const file = this.#readRaw();
      if (file === "unavailable" || this.#storage === null) return false;
      try {
        change(draftOf(file));
        prune(file);
        this.#storage.setItem(this.#key, JSON.stringify(file));
      } catch {
        return false;
      }
      this.#notify();
      return true;
    };
    try {
      if (this.#locks === null) return await run();
      let written = false;
      await this.#locks.request(RECEIPTS_LOCK, async () => {
        written = await run();
      });
      return written;
    } catch {
      return false;
    }
  }

  /** Called after this store writes and when another tab does. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#events?.removeEventListener("storage", this.#onStorage);
    this.#listeners.clear();
  }

  #readRaw(): RawFile | "unavailable" {
    if (this.#storage === null) return "unavailable";
    let text: string | null;
    try {
      text = this.#storage.getItem(this.#key);
    } catch {
      return "unavailable";
    }
    if (text === null) return emptyFile();
    try {
      return parseFile(JSON.parse(text)) ?? "unavailable";
    } catch {
      return "unavailable";
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // One listener failing must not stop the others hearing about a write.
      }
    }
  }
}

function pageLocks(): ReceiptLocks | null {
  const locks = (globalThis as { navigator?: { locks?: ReceiptLocks } }).navigator?.locks;
  return locks ?? null;
}

let page: ReceiptStore | null = null;

/** The page's one store. */
export function receiptStore(): ReceiptStore {
  page ??= new ReceiptStore(pageStorage());
  return page;
}

// ─── Recording a swap ─────────────────────────────────────────────────────────

/** The clocks a record is written with, injected so tests can fix them. */
export interface RecordClock {
  /** Wall-clock unix seconds. */
  nowUnix(): number;
  /** `performance.now()`, the clock rates are read on. */
  nowPerf(): number;
}

const pageClock: RecordClock = {
  nowUnix: () => Math.floor(Date.now() / 1000),
  nowPerf: perfNow,
};

export interface RecordSwapInput {
  /** The person's network service: the receipts are read from it. */
  rpc: JsonRpc;
  chainId: number;
  account: Address;
  quote: Pick<QuoteResult, "legs" | "route">;
  /** What `executeQuote` returned, or the error it stopped with part-way. */
  result: ExecuteResult | { partial: ExecutionError };
  pricing: Pick<Pricing, "snapshot"> | null;
  /** How the swap's tips went, when it had any. */
  tips?: TipOutcome;
  /**
   * The account's ETH balance before the swap's first transaction. Needed
   * only when the swap bought ETH, which arrives with no log to measure:
   * without it, that amount stays unmeasured.
   */
  ethBefore?: bigint | null;
  store?: ReceiptStore;
  clock?: RecordClock;
}

export interface RecordedSwap {
  /** The swap as Your activity lists it, with what it measurably delivered. */
  row: RecordRow;
  /** Its tips, one row per tip transaction. */
  tips: RecordRow[];
  /** False when this browser's storage wouldn't keep it; the row is still right. */
  saved: boolean;
}

const lower = (hash: string) => hash.toLowerCase() as Hex;
const legOf = (leg: { token: Address; amount: bigint | null; measured: boolean }): StoredLeg => ({
  token: leg.token.toLowerCase() as Address,
  amount: leg.amount === null ? null : leg.amount.toString(),
  measured: leg.measured,
});

/**
 * Write down a swap that settled, and its tips, and say what it delivered.
 *
 * Called after `executeQuote`, including when it stopped part-way with money
 * moved (`ExecutionError.legsDone > 0`): a partial swap is still a trade the
 * person made. Returns null when nothing was swapped.
 *
 * Reads each transaction's receipt once, now, through the person's own
 * network service: that is where the amounts are measured and the sender
 * named. Never throws. A swap is finished before this runs, and a record that
 * couldn't be read or kept must not make it look otherwise.
 */
export async function recordSwap(input: RecordSwapInput): Promise<RecordedSwap | null> {
  try {
    return await recordSwapOrThrow(input);
  } catch {
    return null;
  }
}

async function recordSwapOrThrow(input: RecordSwapInput): Promise<RecordedSwap | null> {
  const { rpc, chainId, account } = input;
  const store = input.store ?? receiptStore();
  const clock = input.clock ?? pageClock;
  const partial = "partial" in input.result;
  const hashes = ("partial" in input.result ? input.result.partial.hashes : input.result.hashes).map(lower);
  const legsDone = "partial" in input.result ? input.result.partial.legsDone : input.result.legsDone;
  const intent = input.quote.legs[0]?.plan.intent;
  if (legsDone === 0 || hashes.length === 0 || intent === undefined) return null;

  const nowUnix = clock.nowUnix();
  const rates = ratesSeenNow(input.pricing?.snapshot ?? null, clock.nowPerf(), nowUnix);
  const tokenIn = intent.tokenIn.toLowerCase() as Address;
  const tokenOut = intent.tokenOut.toLowerCase() as Address;

  const receipts = await Promise.all(hashes.map((hash) => readReceipt(rpc, hash).catch(() => null)));
  const values = isNativeToken(tokenIn)
    ? await Promise.all(hashes.map((hash) => readTxValue(rpc, hash).catch(() => null)))
    : undefined;
  let ethBalance: { before: bigint; after: bigint } | null = null;
  if (isNativeToken(tokenOut) && input.ethBefore !== undefined && input.ethBefore !== null) {
    const after = await balanceOf(rpc, NATIVE_TOKEN, account).catch(() => null);
    if (after !== null) ethBalance = { before: input.ethBefore, after };
  }
  const measured = measureSwap({
    account,
    tokenIn,
    tokenOut,
    receipts,
    ...(values === undefined ? {} : { values }),
    ethBalance,
  });
  // An exact-input swap that went through whole sold exactly what was
  // quoted, so that figure stands when the logs can't be read; it is marked
  // unmeasured. A partial one sold some unknown part of it.
  const sold =
    measured.sold.amount === null && !partial
      ? { token: tokenIn, amount: input.quote.route.amountIn, measured: false }
      : measured.sold;

  const swap: StoredReceipt = {
    id: `swap:${chainId}:${hashes[0]}`,
    kind: "swap",
    chainId,
    at: nowUnix,
    hashes,
    sold: legOf(sold),
    bought: legOf(measured.bought),
    ...(partial ? { partial: true } : {}),
  };

  const tipped = await recordTips(input, nowUnix, swap.id);
  const read = [...receipts, ...tipped.receipts].filter((r): r is ChainReceipt => r !== null);
  const blocks = [...new Set(read.map((r) => r.blockNumber))];
  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (block) => {
      const time = await readBlockTime(rpc, block).catch(() => null);
      if (time !== null) times.set(block, time);
    }),
  );

  const saved = await store.write((draft) => {
    draft.addReceipt(swap);
    for (const tip of tipped.stored) draft.addReceipt(tip);
    for (const receipt of read) draft.setTx(receipt.hash, factsOf(chainId, receipt));
    for (const [block, time] of times) draft.setBlockTime(chainId, block, time);
    if (rates !== null) {
      for (const receipt of [swap, ...tipped.stored]) draft.setSeen(receipt.hashes[receipt.hashes.length - 1]!, chainId, rates);
    }
  });

  // Built from what was read just now, not from the store, so the answer is
  // right even when storage refused it.
  const lookup: RecordsLookup = {
    seen: (hash) => (rates !== null && [swap, ...tipped.stored].some((r) => r.hashes.at(-1) === hash.toLowerCase()) ? rates : null),
    tx: (hash) => {
      const receipt = read.find((r) => r.hash === hash.toLowerCase());
      return receipt === undefined ? null : factsOf(chainId, receipt);
    },
    block: (_chainId, block) => ({ time: times.get(block) ?? null, chainlink: null }),
  };
  return {
    row: receiptRow(swap, lookup, tipped.stored),
    tips: tipped.stored.map((tip) => receiptRow(tip, lookup)),
    saved,
  };
}

/**
 * The tips' own records: one per tip transaction, naming the swap they went
 * with (`forSwap`), with the amount, and how many it paid, measured from its
 * logs when they can be read.
 */
async function recordTips(
  input: RecordSwapInput,
  nowUnix: number,
  forSwap: string,
): Promise<{ stored: StoredReceipt[]; receipts: (ChainReceipt | null)[] }> {
  const stored: StoredReceipt[] = [];
  const all: (ChainReceipt | null)[] = [];
  for (const payment of input.tips?.sent ?? []) {
    const hashes = payment.hashes.map(lower);
    if (hashes.length === 0) continue;
    const receipts = await Promise.all(hashes.map((hash) => readReceipt(input.rpc, hash).catch(() => null)));
    all.push(...receipts);
    const measured = transferTotal(receipts, payment.token, { from: input.account });
    const recipients = transferRecipients(receipts, payment.token, input.account);
    const token = payment.token.toLowerCase() as Address;
    stored.push({
      id: `tip:${input.chainId}:${hashes[hashes.length - 1]}`,
      kind: "tip",
      chainId: input.chainId,
      at: nowUnix,
      hashes,
      sold:
        measured === null || measured === 0n
          ? { token, amount: payment.amount.toString(), measured: false }
          : { token, amount: measured.toString(), measured: true },
      // A tip buys nothing, and that is known: zero, in the tipped token.
      bought: { token, amount: "0", measured: true },
      forSwap,
      ...(recipients === null || recipients === 0 ? {} : { recipients }),
    });
  }
  return { stored, receipts: all };
}

// ─── A deleted plan's buys ────────────────────────────────────────────────────

/**
 * A plan's confirmed buys, from this browser's record of it (the ledger), as
 * receipts: what Your activity lists for them, with the plan's name and each
 * buy's number, so they stay listed once the plan and its record are gone.
 * The ids are the rows' own (`plan-buy:<chain>:<plan>:<window>`), so a buy is
 * never listed twice.
 */
export function planBuyReceipts(plan: DcaPlan, entry: DcaLedgerEntry): StoredReceipt[] {
  const label = cardTitle(plan);
  const confirmed = entry.runs.filter((run) => run.status === "confirmed");
  let n = entry.buysDone;
  const out: StoredReceipt[] = [];
  for (const run of [...confirmed].reverse()) {
    const hashes = run.hashes.map((h) => h.toLowerCase()).filter(isHash);
    if (hashes.length === 0) continue;
    const partial = run.codes?.includes(RUN_CODES.PARTIAL) ?? false;
    out.push({
      id: `plan-buy:${entry.chainId}:${plan.id}:${run.slot}`,
      kind: "plan-buy",
      chainId: entry.chainId,
      at: Math.floor(run.at / 1000),
      hashes,
      // As the ledger's rows say it: what a buy claimed is what it sold, unless only part went through.
      sold: { token: plan.sell.toLowerCase() as Address, amount: partial ? null : run.amountIn, measured: false },
      bought: {
        token: plan.buy.toLowerCase() as Address,
        amount: run.amountOut === undefined ? null : run.amountOut,
        measured: run.amountOut !== undefined,
      },
      ...(partial ? { partial: true } : {}),
      plan: { id: plan.id, label, n: Math.max(1, n), of: plan.maxBuys },
    });
    n -= 1;
  }
  return out.reverse();
}

/**
 * Keep a plan's buys before its record is deleted: they join the swaps and
 * tips. True when there were none, or they are kept; false when the store
 * couldn't be written, and then the record must stay.
 */
export async function keepPlanBuys(plan: DcaPlan, entry: DcaLedgerEntry, store: ReceiptStore = receiptStore()): Promise<boolean> {
  const receipts = planBuyReceipts(plan, entry);
  if (receipts.length === 0) return true;
  return store.write((draft) => {
    for (const receipt of receipts) draft.addReceipt(receipt);
  });
}

// ─── Buy fees earned ──────────────────────────────────────────────────────────

export interface RecordBuyFeesInput {
  /** The person's network service: the block's time is read from it. */
  rpc: JsonRpc;
  chainId: number;
  /** The wallet that sent the batch, and was paid. */
  account: Address;
  /** The batch's receipt, as `waitForBatch` read it. */
  receipt: ChainReceipt;
  /**
   * The WETH other people's vaults paid `account`, from the receipt (never
   * from the preview): the `Batch` event's `earned`, less the fees the
   * account's own vaults paid back to it (`feesEarnedFromOthers`), which
   * their own buy rows count as paid back. Null when it couldn't be read.
   * Ignored for a batch that reverted, which paid nothing.
   */
  earned: bigint | null;
  /** The WETH the buy fees are paid in (the factory's). */
  weth: Address;
  pricing: Pick<Pricing, "snapshot"> | null;
  store?: ReceiptStore;
  clock?: RecordClock;
}

/**
 * Write down a batch of due vault buys this wallet made for other people
 * (Help run the network), once it settled, and return its row.
 *
 * One row per batch: the WETH it was paid in buy fees and what it cost in
 * network fee. A batch that reverted (nothing was bought, perhaps because
 * someone made the buys first) is kept too, with nothing received, because
 * its network fee was still spent.
 * It is never a buy: nothing that counts buys or what was put in counts it.
 *
 * Never throws, and returns null when the record couldn't be kept: that must
 * not turn a finished transaction into an error.
 */
export async function recordBuyFeesEarned(input: RecordBuyFeesInput): Promise<RecordedSwap | null> {
  try {
    return await recordBuyFeesOrThrow(input);
  } catch {
    return null;
  }
}

async function recordBuyFeesOrThrow(input: RecordBuyFeesInput): Promise<RecordedSwap> {
  const { rpc, chainId, receipt } = input;
  const store = input.store ?? receiptStore();
  const clock = input.clock ?? pageClock;
  const hash = lower(receipt.hash);
  const nowUnix = clock.nowUnix();
  const weth = input.weth.toLowerCase() as Address;
  const earned = receipt.status === "reverted" ? 0n : input.earned;
  const stored: StoredReceipt = {
    id: `buy-fees-earned:${chainId}:${hash}`,
    kind: "buy-fees-earned",
    chainId,
    at: nowUnix,
    hashes: [hash],
    // Nothing was sold: a known zero, so no total counts it as money put in.
    sold: { token: weth, amount: "0", measured: true },
    bought: { token: weth, amount: earned === null ? null : earned.toString(), measured: earned !== null },
  };
  const time = await readBlockTime(rpc, receipt.blockNumber).catch(() => null);
  const rates = ratesSeenNow(input.pricing?.snapshot ?? null, clock.nowPerf(), nowUnix);
  const saved = await store.write((draft) => {
    draft.addReceipt(stored);
    draft.setTx(hash, factsOf(chainId, receipt));
    if (time !== null) draft.setBlockTime(chainId, receipt.blockNumber, time);
    if (rates !== null) draft.setSeen(hash, chainId, rates);
  });
  const lookup: RecordsLookup = {
    seen: (h) => (rates !== null && h.toLowerCase() === hash ? rates : null),
    tx: (h) => (h.toLowerCase() === hash ? factsOf(chainId, receipt) : null),
    block: (_chainId, block) => ({ time: block === receipt.blockNumber ? time : null, chainlink: null }),
  };
  return { row: receiptRow(stored, lookup), tips: [], saved };
}

// ─── Plan buys' rates ─────────────────────────────────────────────────────────

/**
 * Keep the rates this page holds with each plan buy it sees settle (the
 * `twap-seen` value of a plan buy).
 *
 * A buy counts as seen when its run was recorded at most 15 minutes ago; one
 * settled while no spDEX tab was open is left for "Fill in values". When such
 * a buy has no rates kept yet and the page's are older than 10 minutes, it
 * asks for a read, and keeps the rates once they arrive: the person has just
 * confirmed a buy, so one read of prices is expected, and it goes to their
 * own network service.
 */
export function useRecordPriceSnapshots(
  ledger: DcaLedger | "unavailable",
  pricing: Pricing | null,
  options: { chainId: number; store?: ReceiptStore },
): void {
  const store = options.store ?? receiptStore();
  const request = useRef<() => void>(() => undefined);
  request.current = pricing?.request ?? (() => undefined);
  const snapshot = pricing?.snapshot ?? null;
  const chainId = options.chainId;

  useEffect(() => {
    if (ledger === "unavailable") return;
    const known = store.read();
    if (known === "unavailable") return;
    const nowMs = Date.now();
    const recent = Object.values(ledger.entries)
      .filter((entry) => entry.chainId === chainId)
      .flatMap((entry) => entry.runs)
      .filter((run) => run.status === "confirmed" && run.hashes.length > 0 && nowMs - run.at <= SEEN_RECORD_MAX_AGE_MS && run.at <= nowMs)
      .map((run) => run.hashes[run.hashes.length - 1]!)
      .filter((hash) => known.seen(hash) === null);
    if (recent.length === 0) return;
    const rates = ratesSeenNow(snapshot, performance.now(), nowMs / 1000);
    if (rates === null) {
      request.current();
      return;
    }
    void store.write((draft) => {
      for (const hash of recent) draft.setSeen(hash, chainId, rates);
    });
  }, [ledger, snapshot, chainId, store]);
}

// ─── Your activity's rows ─────────────────────────────────────────────────────

export interface UseRecordsDeps {
  /**
   * Reads happen only while this is true: Your activity is open, or Your
   * stack is on screen. Until then the page spends nothing on records.
   */
  active: boolean;
  account: Address | null;
  chainId: number;
  plans: readonly DcaPlan[];
  ledger: DcaLedger | "unavailable";
  vaultFor(planId: string): VaultPlanState | undefined;
  rpc: JsonRpc | null;
  store?: ReceiptStore;
}

/** How a press of "Fill in values from the chain" went. */
export interface FillResult {
  /** Blocks read. */
  read: number;
  /** Blocks the network service wouldn't answer for (it keeps no state that old, or failed). */
  failed: number;
  /** Rows still fillable after this press: past the 200-a-press limit. */
  left: number;
}

export interface Records {
  /** The connected account's rows on this network, newest first, and rows no wallet could be told for. */
  rows: RecordRow[];
  state: "idle" | "loading" | "ready" | "unavailable";
  /** What isn't listed, and why, in sentences. */
  notes: string[];
  /** Plans whose earliest buys this browser no longer lists: totals built from rows are "at least". */
  truncated: { planId: string; planLabel: string; missing: number }[];
  /** Rows whose wallet couldn't be told: listed, and left out of every total. */
  unattributed: number;
  /** Rows "Fill in values" could still price. */
  fillable: number;
  filling: boolean;
  fill(): Promise<FillResult>;
}

/** Blocks read per press of "Fill in values": the hint promises at most this many reads. */
export const FILL_MAX_BLOCKS = 200;
/** Reads in flight at once, so a long first read doesn't meet the network service's rate limit. */
const READS_AT_ONCE = 4;

type HistoryRead = { key: string; history: VaultHistory } | { key: string; error: string };

/** Vault histories, per network service, so a panel opened twice reads each vault once per buy count. */
const historyCache = new WeakMap<JsonRpc, Map<string, Promise<VaultHistory>>>();

function vaultHistoryOnce(rpc: JsonRpc, input: Parameters<typeof readVaultHistory>[1]): Promise<VaultHistory> {
  let cache = historyCache.get(rpc);
  if (!cache) historyCache.set(rpc, (cache = new Map()));
  const key = `${input.chainId}:${input.vault.toLowerCase()}:${input.buysDone}`;
  let read = cache.get(key);
  if (!read) {
    read = readVaultHistory(rpc, input);
    cache.set(key, read);
    // A failure is not kept: the next opening tries again.
    read.catch(() => cache!.delete(key));
  }
  return read;
}

const sameAccount = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Your activity's rows: this browser's swaps, tips and plan buys, and the
 * person's vault plans' buys from the chain, for the connected account on
 * this network.
 *
 * Reads, only while `active`: a receipt per recorded transaction not yet
 * known (kept forever), a block's time per block not yet known, and each
 * vault plan's history (at most 20 log queries each). All through the
 * person's own network service.
 */
export function useRecords(deps: UseRecordsDeps): Records {
  const store = deps.store ?? receiptStore();
  const { active, account, chainId, rpc } = deps;
  const [version, setVersion] = useState(0);
  useEffect(() => store.subscribe(() => setVersion((n) => n + 1)), [store]);
  const receipts = useMemo(() => store.read(), [store, version]);

  // The vault plans whose vault is the connected account's, as last read.
  const vaultPlans = deps.plans
    .filter((plan) => plan.signer === "vault" && plan.chainId === chainId)
    .flatMap((plan) => {
      const state = deps.vaultFor(plan.id);
      return state?.kind === "active" && sameAccount(state.owner, account) ? [{ plan, state }] : [];
    });
  const vaultKey = vaultPlans.map(({ state }) => `${state.vault}:${state.buysDone}`).join(",");

  const [histories, setHistories] = useState<Record<string, HistoryRead>>({});
  const [reading, setReading] = useState(0);
  const failed = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());

  const vaults: VaultBuys[] = vaultPlans.flatMap(({ plan, state }) => {
    const read = histories[plan.id];
    if (read === undefined || read.key !== `${state.vault}:${state.buysDone}`) return [];
    const base = {
      plan,
      owner: state.owner,
      tokenOut: state.terms.tokenOut,
      maxBuys: state.maxBuys,
      buysDone: state.buysDone,
      communityWindow: state.terms.communityWindow,
    };
    return [{ ...base, ...("history" in read ? { history: read.history } : { error: read.error }) }];
  });

  const input: BuildInput = { chainId, receipts, ledger: deps.ledger, plans: deps.plans, vaults };
  const built = buildRows(input);
  const pending = pendingReads(input);
  const pendingKey = [...pending.hashes, ...pending.blocks.map(String)].filter((k) => !failed.current.has(k)).join(",");

  // Receipts and block times not yet known.
  useEffect(() => {
    if (!active || rpc === null || account === null || pendingKey === "") return;
    const hashes = pending.hashes.filter((h) => !failed.current.has(h) && !inFlight.current.has(h));
    const blocks = pending.blocks.filter((b) => !failed.current.has(String(b)) && !inFlight.current.has(String(b)));
    if (hashes.length === 0 && blocks.length === 0) return;
    for (const key of [...hashes, ...blocks.map(String)]) inFlight.current.add(key);
    setReading((n) => n + 1);
    void (async () => {
      const facts: ChainReceipt[] = [];
      await eachLimited(hashes, READS_AT_ONCE, async (hash) => {
        const receipt = await readReceipt(rpc, hash as Hex).catch(() => null);
        if (receipt === null) failed.current.add(hash);
        else facts.push(receipt);
      });
      const times: [bigint, number][] = [];
      const moreBlocks = [...new Set([...blocks, ...facts.map((r) => r.blockNumber)])];
      await eachLimited(moreBlocks, READS_AT_ONCE, async (block) => {
        const time = await readBlockTime(rpc, block).catch(() => null);
        if (time === null) failed.current.add(String(block));
        else times.push([block, time]);
      });
      await store.write((draft) => {
        for (const receipt of facts) draft.setTx(receipt.hash, factsOf(chainId, receipt));
        for (const [block, time] of times) draft.setBlockTime(chainId, block, time);
      });
      for (const key of [...hashes, ...blocks.map(String)]) inFlight.current.delete(key);
      setReading((n) => n - 1);
    })();
    // `pending` itself is new on every render; `pendingKey` says what it holds.
  }, [active, rpc, account, chainId, pendingKey, store]);

  // Each vault plan's buys.
  useEffect(() => {
    if (!active || rpc === null || vaultPlans.length === 0) return;
    let cancelled = false;
    setReading((n) => n + 1);
    void Promise.all(
      vaultPlans.map(async ({ plan, state }) => {
        const key = `${state.vault}:${state.buysDone}`;
        try {
          const history = await vaultHistoryOnce(rpc, {
            vault: state.vault,
            buysDone: state.buysDone,
            startAt: Number(state.terms.startAt),
            chainId,
            // Who made each buy is said against these, which never change for a vault.
            owner: state.owner,
            communityWindow: state.terms.communityWindow,
          });
          return [plan.id, { key, history }] as const;
        } catch (error) {
          return [plan.id, { key, error: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
    ).then((reads) => {
      setReading((n) => n - 1);
      if (!cancelled) setHistories(Object.fromEntries(reads));
    });
    return () => {
      cancelled = true;
    };
    // `vaultPlans` itself is new on every render; `vaultKey` says what it holds.
  }, [active, rpc, chainId, vaultKey]);

  const [filling, setFilling] = useState(false);
  const fillFailed = useRef(new Set<string>());
  const rows = rowsFor(built, account);
  // Buy fees received have no value to fill in (build.ts `receiptRow`), so no read is spent on their blocks.
  const toFill = rows.filter((row) => row.valueUsd === null && row.block !== null && row.kind !== "buy-fees-earned" && fillable(row.sold));
  const fillBlocks = [...new Set(toFill.map((row) => row.block!))].filter((b) => !fillFailed.current.has(String(b)));

  const fill = useCallback(async (): Promise<FillResult> => {
    if (rpc === null) return { read: 0, failed: 0, left: fillBlocks.length };
    setFilling(true);
    const reader = new Multicall3Reader(rpc);
    const batch = fillBlocks.slice(0, FILL_MAX_BLOCKS);
    const reads: FxSnapshot[] = [];
    let failures = 0;
    await eachLimited(batch, READS_AT_ONCE, async (block) => {
      try {
        reads.push(await readChainlinkAt(reader, block));
      } catch {
        // No old state at this node, or a failed read: the cells stay blank,
        // and the next press moves on to other blocks.
        fillFailed.current.add(String(block));
        failures += 1;
      }
    });
    await store.write((draft) => {
      for (const read of reads) draft.setChainlink(chainId, read);
    });
    setFilling(false);
    return { read: reads.length, failed: failures, left: Math.max(0, fillBlocks.length - batch.length) };
  }, [rpc, chainId, store, fillBlocks.join(",")]);

  const loading = active && (reading > 0 || (vaultPlans.length > 0 && vaults.length < vaultPlans.length));
  let state: Records["state"];
  if (!active || account === null) state = "idle";
  else if (receipts === "unavailable" && deps.ledger === "unavailable") state = "unavailable";
  else state = loading ? "loading" : "ready";

  const unattributed = state === "ready" ? unattributedNote(rows) : null;
  return {
    rows,
    state,
    notes: unattributed === null ? built.notes : [...built.notes, unattributed],
    truncated: built.truncated,
    unattributed: rows.filter((row) => row.account === null).length,
    fillable: toFill.length,
    filling,
    fill,
  };
}
