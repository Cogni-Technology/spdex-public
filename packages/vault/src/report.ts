/**
 * The keeper report: what vault plans, buys, batches and keepers did over a
 * range of blocks, as CSV tables and one `summary.json`.
 *
 * ## Where the figures come from
 *
 * Only two places, both the operator's to choose: the chain — the factories'
 * `VaultCreated`, the vaults' `Funded`, `Bought` and `Closed`, the batchers'
 * `Batch`, `Triggered` and `NotTriggered`, the batch transactions' receipts,
 * the vaults as they stood at the last block, and optionally Chainlink's
 * ETH/USD feed — read through an endpoint the operator names; and the
 * operator's own keeper logs (`keeper-log.ts`). The app records nothing about
 * its users, and nothing here asks it to: some things are deliberately
 * unknowable (`UNKNOWABLE`).
 *
 * `scripts/keeper-report.ts` gathers those inputs; this file only aggregates
 * them into the tables, and `report-summary.ts` answers the summary's
 * questions from those, so the same inputs always give byte-identical files.
 * Neither uses a Node API or makes a request.
 *
 * ## What it is careful about
 *
 * - **Only the contracts' own logs.** Any contract can emit a log shaped like
 *   `Bought` or `Batch`, so a vault event counts only from a vault a listed
 *   factory vouches for, and a batcher event only from a listed batcher.
 * - **Joined by log index.** A batcher's `Triggered` is the log right after
 *   its vault's `Bought`, and its `Batch` closes the run of attempts since the
 *   previous one (`batcher.ts`). Nothing is matched by amount or by guess.
 * - **Unknown is never zero.** A figure the inputs cannot give — a price on a
 *   day the feed was silent, a subsidy without keeper logs, a balance that
 *   could not be read — is empty in a CSV and null in the summary.
 * - **Complete, or says where not.** Every vault's `buyNumber` must run
 *   without gaps and every batch's `earned` must equal the fees of the buys it
 *   triggered; block ranges the endpoint would not serve are listed.
 */

import type { Address, Hex } from "@spdex/core";
import { TOPICS } from "@spdex/chain";
import type { Deployment } from "./artifacts.js";
import { joinBatchLogs, type BatchRun, type BatcherEvent } from "./batcher.js";
import { feeShareBps } from "./fee.js";
import { decodeVaultEvent, type VaultEvent, type VaultTerms } from "./index.js";
import { earliestBuyAt, percentile } from "./keeper-plan.js";
import { big, median, stringField, sum, sumKnown, summarise, usdOfProduct } from "./report-summary.js";

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** A log as `eth_getLogs` or a receipt gives it, with its position. */
export interface ChainLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface ChainReceipt {
  transactionHash: Hex;
  blockNumber: bigint;
  from: Address;
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface ChainBlock {
  number: bigint;
  timestamp: bigint;
  /** Null on a chain without EIP-1559. */
  baseFee: bigint | null;
}

/** A vault a listed factory vouches for, as the chain showed it at the report's last block; null where a read failed. */
export interface VaultAtEnd {
  vault: Address;
  deployment: string;
  /** Its place in its factory's list. */
  index: bigint | null;
  owner: Address | null;
  terms: VaultTerms | null;
  buysDone: bigint | null;
  closed: boolean | null;
  /** Its WETH, wei. */
  balance: bigint | null;
}

/** One ETH/USD reading: when it was made, and the answer with Chainlink's 8 decimals. */
export interface PricePoint {
  at: bigint;
  answer: bigint;
}

export type Prices = { kind: "fixed"; answer: bigint } | { kind: "feed"; points: readonly PricePoint[] } | { kind: "none" };

/** A keeper log record as it is read back from JSONL: bigints are decimal strings. */
export interface KeeperRecord {
  v: number;
  ts: string;
  seq: number;
  keeper: string | null;
  type: string;
  block?: string;
  chainTime?: string;
  [field: string]: unknown;
}

export interface ReportInput {
  chainId: number;
  deployments: readonly Deployment[];
  range: { fromBlock: bigint; toBlock: bigint; fromTime: bigint; toTime: bigint; fromHash: Hex; toHash: Hex };
  /** Every vault a listed factory vouches for (its list, and `VaultCreated` in range). */
  vaults: readonly VaultAtEnd[];
  /** `--vault`: every table is limited to these; null for all. */
  selected: readonly Address[] | null;
  /** Everything gathered: factory, vault and batcher logs, and the batch receipts' logs. Duplicates are fine. */
  logs: readonly ChainLog[];
  receipts: readonly ChainReceipt[];
  /** At least every block a log, a receipt or the range names. */
  blocks: readonly ChainBlock[];
  /** The operator's keeper logs, already deduplicated (`dedupeKeeperRecords`). */
  records: readonly KeeperRecord[];
  /** From `--keeper-state`; null without one. */
  state: { trapped: readonly Address[]; notVouched: readonly Address[] } | null;
  /** `--reward-to`: the operator's own reward addresses, besides those its keeper logs name. */
  rewardTo: readonly Address[];
  prices: Prices;
  /** ERC-20 `Transfer` logs to the `--tip-recipient` addresses; null when none were asked for. */
  tips: readonly ChainLog[] | null;
  /** Block ranges the endpoint would not serve: every figure that needed them is incomplete. */
  uncovered: readonly { fromBlock: bigint; toBlock: bigint; what: string }[];
  /** What the summary says it was made from; nothing here is secret (the endpoint is its host only). */
  provenance: Record<string, unknown>;
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

export type Cell = string | number | bigint | boolean | null;
export type Row = Record<string, Cell>;

/** Every table and its columns, in order. */
export const REPORT_COLUMNS = {
  vaults: [
    "deployment", "vault", "owner", "list_index", "created_block", "created_at", "market_index", "amount_per_buy_wei",
    "interval_s", "max_buys", "start_at", "fee_wei", "fee_bps", "max_slippage_bps", "funded_at_creation_wei",
    "funded_later_wei", "buys_done", "windows_elapsed", "windows_missed_funded", "windows_missed_unfunded",
    "buy_number_gaps", "closed", "closed_at", "closed_amount_wei", "total_out", "subsidy_wei", "trapped", "not_vouched",
  ],
  buys: [
    "tx_hash", "log_index", "block", "time", "vault", "owner", "slot", "buy_number", "window_start",
    "seconds_into_window", "seconds_after_due", "amount_in_wei", "amount_out", "floor_out", "fair_out",
    "exec_vs_floor_bps", "exec_vs_fair_bps", "oracle_depth_wei", "fee_wei", "fee_bps", "subsidy_wei", "trigger", "via_batcher",
    "batch_caller", "reward_to", "vault_gas_used", "eth_usd",
  ],
  batches: [
    "tx_hash", "batch_id", "status", "nonce", "block", "time", "endpoint", "caller", "reward_to", "listed", "tried",
    "bought", "refused", "not_tried", "earned_wei", "swept_wei", "earned_matches_rewards", "gas_used",
    "effective_gas_price", "priority_fee_wei", "base_fee", "cost_wei", "net_wei", "net_usd", "expected_gas",
    "expected_cost_wei", "keeper_reason", "urgent", "inclusion_blocks", "attempts", "eth_usd",
  ],
  refusals: ["source", "tx_hash", "block", "time", "vault", "reason", "reason_name", "gas_used"],
  windows: ["vault", "slot", "window_start", "window_end", "class", "by", "last_skip"],
  owners: ["owner", "vaults", "buys", "volume_wei", "fees_wei", "subsidy_wei"],
  daily: [
    "date", "buys", "active_vaults", "owners", "volume_wei", "volume_usd", "fees_wei", "batches", "gas_cost_wei",
    "net_wei", "subsidy_wei", "vaults_created", "vaults_closed", "deposits_wei", "withdrawals_wei",
    "windows_missed_funded", "windows_missed_unfunded", "median_seconds_into_window", "median_exec_vs_fair_bps",
    "median_oracle_depth_wei", "keeper_uptime_pct", "eth_usd",
  ],
  keeper: [
    "date", "heartbeats", "uptime_pct", "errors", "waits_not_cheap", "sends_cheap", "sends_deadline",
    "sends_short_interval", "resends", "resends_blocked", "abandoned", "cancels", "median_inclusion_blocks",
    "model_gas_ratio",
  ],
  tips: ["tx_hash", "block", "time", "token", "from", "to", "amount"],
} as const;

export type ReportTable = keyof typeof REPORT_COLUMNS;

export interface Report {
  /** `tips` only when tip recipients were asked for. */
  tables: Partial<Record<ReportTable, Row[]>> & Omit<Record<ReportTable, Row[]>, "tips">;
  summary: Record<string, unknown>;
}

/** What the report cannot say, on purpose: rule 4 keeps the app from recording it. */
export const UNKNOWABLE = [
  "swaps made in the app, as such",
  "forms started and abandoned",
  "errors people saw in the app",
  "which frontend created a vault (no attribution marker is put on chain: it would fingerprint users)",
  "who uses the app",
  "ether tips (they leave no log), and whether a token transfer to a tip address was a tip",
];

/** How a window ended. */
export type WindowClass = "bought" | "closed" | "unfunded" | "keeper-skipped" | "keeper-down" | "unknown";
/** Who made a buy: its owner, the operator's own batch, someone else's batch, or anyone else. */
export type Trigger = "owner" | "our-batch" | "batch" | "other";

// ─── Keeper logs ──────────────────────────────────────────────────────────────

/**
 * One JSONL file's records. A last line cut short — the keeper was writing
 * when the file was copied — is skipped and reported, not fatal; any other
 * line that is not a record is counted as bad.
 */
export function parseKeeperLog(text: string): { records: KeeperRecord[]; truncated: boolean; bad: number } {
  const lines = text.split("\n");
  const records: KeeperRecord[] = [];
  let truncated = false;
  let bad = 0;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only the last line can be cut short: a line with a newline after it was written whole.
      if (i === lines.length - 1) truncated = true;
      else bad += 1;
      return;
    }
    if (isRecord(parsed)) records.push(parsed);
    else bad += 1;
  });
  return { records, truncated, bad };
}

function isRecord(value: unknown): value is KeeperRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return r["v"] === 1 && typeof r["ts"] === "string" && typeof r["seq"] === "number" && typeof r["type"] === "string" && (r["keeper"] === null || typeof r["keeper"] === "string");
}

/**
 * Records from every file, each once, in the order they were written.
 *
 * `(keeper, seq)` identifies a record across rotated files and several
 * keepers. The wall-clock `ts` is part of the key too, because `--reset-state`
 * starts `seq` again from 1: two records sharing all three are the same line,
 * read twice.
 */
export function dedupeKeeperRecords(records: readonly KeeperRecord[]): KeeperRecord[] {
  const seen = new Map<string, KeeperRecord>();
  for (const r of records) {
    const key = `${r.keeper ?? "-"}|${r.seq}|${r.ts}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()].sort((a, b) => cmp(a.ts, b.ts) || cmp(a.keeper ?? "", b.keeper ?? "") || a.seq - b.seq);
}

// ─── Reading logs politely ────────────────────────────────────────────────────

/** Each log once: an endpoint can repeat one across overlapping queries, and a receipt repeats a log query's. */
export function dedupeLogs(logs: readonly ChainLog[]): ChainLog[] {
  const seen = new Map<string, ChainLog>();
  for (const log of logs) {
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (!seen.has(key)) seen.set(key, log);
  }
  return [...seen.values()].sort((a, b) => cmpBig(a.blockNumber, b.blockNumber) || a.logIndex - b.logIndex);
}

/** The block span one `eth_getLogs` asks for, and how many in a row have been answered. */
export interface LogWindow {
  blocks: bigint;
  successes: number;
}

export const LOG_WINDOW_START = 10_000n;
export const LOG_WINDOW_MAX = 100_000n;
/** Answers in a row before the window is tried twice as wide again. */
export const LOG_WINDOW_WIDEN_AFTER = 10;

/**
 * The next window after an answer or a refusal. Endpoints cap `eth_getLogs`
 * ranges — Alchemy's free tier at ten blocks — so a refused window is halved,
 * down to one block, and after ten answers in a row it is doubled again in
 * case the refusal was about that range's volume, not a cap. A rate limit is
 * neither: the caller waits and asks again, and the window stays.
 */
export function nextLogWindow(window: LogWindow, outcome: "answered" | "refused"): LogWindow {
  if (outcome === "refused") return { blocks: window.blocks > 1n ? window.blocks / 2n : 1n, successes: 0 };
  const successes = window.successes + 1;
  if (successes < LOG_WINDOW_WIDEN_AFTER) return { blocks: window.blocks, successes };
  const wider = window.blocks * 2n;
  return { blocks: wider > LOG_WINDOW_MAX ? LOG_WINDOW_MAX : wider, successes: 0 };
}

/**
 * `[from, to]` cut at multiples of `size`, so that a cached chunk has the same
 * bounds whatever range a later run asks for.
 */
export function alignedChunks(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  const chunks: [bigint, bigint][] = [];
  for (let start = from; start <= to; ) {
    const end = (start / size + 1n) * size - 1n;
    chunks.push([start, end < to ? end : to]);
    start = end + 1n;
  }
  return chunks;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180: a field with a comma, a quote or a line break is quoted, and its quotes doubled. Null is empty. */
export function csvField(cell: Cell): string {
  if (cell === null) return "";
  const text = typeof cell === "string" ? cell : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: readonly Row[]): string {
  const lines = [columns.join(","), ...rows.map((row) => columns.map((c) => csvField(row[c] ?? null)).join(","))];
  return `${lines.join("\n")}\n`;
}

/** A table as JSON: bigints as decimal strings, as in the keeper's logs. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
}

// ─── Money ────────────────────────────────────────────────────────────────────

const DAY = 86_400n;
/** Chainlink's ETH/USD feed updates at least hourly; a day's price must be that fresh. */
const PRICE_FRESHNESS = 3_600n;

/** A Chainlink answer as dollars: 264394000000 → "2643.94". */
export function priceText(answer: bigint): string {
  const cents = answer.toString().padStart(9, "0");
  const whole = cents.slice(0, -8);
  const fraction = cents.slice(-8).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Wei at a price, in dollars to the cent, rounded toward zero: 10^18 at 2643.94 → "2643.94". */
export function usdText(wei: bigint, answer: bigint): string {
  return usdOfProduct(wei * answer);
}

/**
 * The ETH/USD price for each UTC day: the last reading at or before the day's
 * end (or the report's, for its last day), provided the feed had updated
 * within that day or the hour before it. A day the feed was silent has no
 * price, rather than a stale one.
 */
export function dailyPrices(prices: Prices, dates: readonly string[], toTime: bigint): Map<string, bigint | null> {
  const out = new Map<string, bigint | null>();
  const points = prices.kind === "feed" ? [...prices.points].sort((a, b) => cmpBig(a.at, b.at)) : [];
  for (const date of dates) {
    if (prices.kind !== "feed") {
      out.set(date, prices.kind === "fixed" ? prices.answer : null);
      continue;
    }
    const start = dayStart(date);
    const end = start + DAY - 1n < toTime ? start + DAY - 1n : toTime;
    const last = points.filter((p) => p.at <= end).at(-1);
    out.set(date, last && last.answer > 0n && last.at >= start - PRICE_FRESHNESS ? last.answer : null);
  }
  return out;
}

// ─── The report ───────────────────────────────────────────────────────────────

interface Buy {
  vault: Address;
  tx: Hex;
  logIndex: number;
  block: bigint;
  event: Extract<VaultEvent, { name: "Bought" }>;
  /** The batcher's `Triggered` right after it, when a batch made it. */
  triggered: Extract<BatcherEvent, { name: "Triggered" }> | null;
  run: Run | null;
}

/** A batch as the chain tells it: the attempts a `Batch` closes (`joinBatchLogs`), and the buys they made. */
interface Run extends BatchRun {
  tx: Hex;
  block: bigint;
  batch: NonNullable<BatchRun["batch"]>;
  buys: Buy[];
}

/** One vault's story: its creation, deposits, buys and close, as far as the range shows it. */
interface Timeline {
  at: VaultAtEnd;
  owner: Address | null;
  terms: VaultTerms | null;
  created: { block: bigint; logIndex: number; marketIndex: bigint; funded: bigint } | null;
  funded: { block: bigint; amount: bigint }[];
  buys: Buy[];
  closed: { block: bigint; amount: bigint } | null;
}

export function buildReport(input: ReportInput): Report {
  const c = context(input);
  const buys = buyRows(c);
  const batches = batchRows(c);
  const windows = windowRows(c);
  const vaults = vaultRows(c, windows);
  const refusals = refusalRows(c);
  const keeper = keeperRows(c);
  const tables: Report["tables"] = {
    vaults,
    buys,
    batches,
    refusals,
    windows,
    owners: ownerRows(c),
    daily: dailyRows(c, { buys, batches, windows, keeper }),
    keeper,
    ...(input.tips === null ? {} : { tips: tipRows(c) }),
  };
  const { range } = input;
  const summary = {
    v: 1,
    provenance: {
      chainId: input.chainId,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      fromHash: range.fromHash,
      toHash: range.toHash,
      fromTime: iso(range.fromTime),
      toTime: iso(range.toTime),
      deployments: input.deployments.map((d) => ({ id: d.id, factory: lower(d.factory), batcher: lower(d.batcher) })),
      vaultFilter: input.selected === null ? null : [...input.selected].map(lower).sort(),
      ...input.provenance,
      uncovered: input.uncovered,
    },
    ...summarise(c, tables),
    unknowable: UNKNOWABLE,
  };
  return { tables, summary };
}

// ─── Indexing the inputs ──────────────────────────────────────────────────────

/** The inputs, indexed for the tables and the summary (`report-summary.ts`). */
export type Context = ReturnType<typeof context>;

function context(input: ReportInput) {
  const blocks = new Map(input.blocks.map((b) => [b.number, b]));
  const receipts = new Map(input.receipts.map((r) => [r.transactionHash.toLowerCase() as Hex, r]));
  const factories = new Set(input.deployments.map((d) => lower(d.factory)));
  const batchers = new Map(input.deployments.map((d) => [lower(d.batcher), d.id]));
  const selected = input.selected === null ? null : new Set(input.selected.map(lower));
  const isSelected = (vault: Address) => selected === null || selected.has(vault);

  const timelines = new Map<Address, Timeline>();
  for (const at of input.vaults) {
    const vault = lower(at.vault);
    timelines.set(vault, { at, owner: at.owner, terms: at.terms, created: null, funded: [], buys: [], closed: null });
  }

  // Each transaction's logs in order: its batches, and the `Bought` each `Triggered` follows.
  const byTx = new Map<Hex, ChainLog[]>();
  for (const log of dedupeLogs(input.logs)) {
    const tx = log.transactionHash.toLowerCase() as Hex;
    if (!byTx.has(tx)) byTx.set(tx, []);
    byTx.get(tx)!.push(log);
  }
  const runs: Run[] = [];
  const allBuys: Buy[] = [];
  for (const [tx, logs] of byTx) {
    const block = logs[0]!.blockNumber;
    // By the log index of the `Bought`: the `Triggered` right after it, and the batch that closed, if one did.
    const joined = new Map<number, { triggered: Extract<BatcherEvent, { name: "Triggered" }>; run: Run | null }>();
    for (const batchRun of joinBatchLogs(logs, (address) => batchers.has(address))) {
      const run: Run | null = batchRun.batch === null ? null : { ...batchRun, batch: batchRun.batch, tx, block, buys: [] };
      if (run) runs.push(run);
      for (const { event, bought } of batchRun.triggered) if (bought) joined.set(event.logIndex - 1, { triggered: event, run });
    }
    for (const log of logs) {
      const emitter = lower(log.address);
      if (batchers.has(emitter)) continue;
      const event = decodeVaultEvent(log);
      if (event === null) continue;
      if (event.name === "VaultCreated") {
        const t = timelines.get(event.vault);
        if (!factories.has(emitter) || !t) continue;
        t.owner ??= event.owner;
        t.terms ??= event.terms;
        t.created = { block: log.blockNumber, logIndex: log.logIndex, marketIndex: event.marketIndex, funded: event.funded };
        continue;
      }
      const t = timelines.get(emitter);
      if (!t) continue;
      if (event.name === "Funded") t.funded.push({ block: log.blockNumber, amount: event.amount });
      else if (event.name === "Closed") t.closed = { block: log.blockNumber, amount: event.amount };
      else if (event.name === "Bought") {
        const join = joined.get(log.logIndex);
        const buy: Buy = { vault: emitter, tx, logIndex: log.logIndex, block: log.blockNumber, event, triggered: join?.triggered ?? null, run: join?.run ?? null };
        join?.run?.buys.push(buy);
        t.buys.push(buy);
        allBuys.push(buy);
      }
    }
  }
  runs.sort((a, b) => cmpBig(a.block, b.block) || a.batch.logIndex - b.batch.logIndex);
  const runByTx = new Map(runs.map((run) => [run.tx, run]));

  const records = input.records;
  const ours = oursOf(input, records);
  const keeperLog = indexRecords(records, input.range.toTime);
  const dates = datesBetween(input.range.fromTime, input.range.toTime);
  const prices = dailyPrices(input.prices, [...new Set([...dates, ...keeperLog.dates])], input.range.toTime);

  const timeOf = (block: bigint): bigint | null => blocks.get(block)?.timestamp ?? null;
  return {
    input,
    blocks,
    receipts,
    batchers,
    isSelected,
    timelines,
    runs,
    runByTx,
    buys: allBuys,
    ours,
    keeperLog,
    hasLogs: records.length > 0,
    dates,
    timeOf,
    priceAt: (block: bigint): bigint | null => {
      const time = timeOf(block);
      return time === null ? null : (prices.get(dateOf(time)) ?? null);
    },
    priceOn: (date: string): bigint | null => prices.get(date) ?? null,
    /** The share of `[from, to)`, within the span the logs cover, that the keeper was up; one decimal, as text. */
    uptime: (from: bigint, to: bigint): string | null => uptimeOver(keeperLog, from, to),
  };
}

/** The operator's own batches: sent by a keeper whose logs these are, or paid to a reward address it names. */
function oursOf(input: ReportInput, records: readonly KeeperRecord[]) {
  const callers = new Set<Address>();
  const rewardTos = new Set<Address>(input.rewardTo.map(lower));
  const hashes = new Set<string>();
  for (const r of records) {
    if (r.keeper) callers.add(lower(r.keeper));
    if (r.type === "start" && typeof r["rewardTo"] === "string") rewardTos.add(lower(r["rewardTo"]));
    if (r.type === "batch_mined" || r.type === "batch_sent") hashes.add(String(r["hash"]));
  }
  return (run: Run) => callers.has(run.batch.caller) || rewardTos.has(run.batch.rewardTo) || hashes.has(run.tx);
}

/**
 * The keeper logs, indexed by what the tables join on, each record placed in
 * chain time.
 *
 * A record's `ts` is the keeper's wall clock, and windows are chain time. A
 * record a tick wrote carries both, so their typical difference maps one onto
 * the other: a few seconds on Ethereum, days on an idle fork, whose head is
 * only as new as its last transaction. Heartbeats, which a tick does not
 * write, are placed with it.
 */
function indexRecords(records: readonly KeeperRecord[], toTime: bigint) {
  const offsets = records.flatMap((r) => {
    const wall = wallSeconds(r.ts);
    return wall !== null && r.chainTime !== undefined ? [BigInt(r.chainTime) - wall] : [];
  });
  const offset = percentile(offsets, 50) ?? 0n;
  const chainTimeOf = (r: KeeperRecord): bigint | null => {
    if (r.chainTime !== undefined) return BigInt(r.chainTime);
    const wall = wallSeconds(r.ts);
    return wall === null ? null : wall + offset;
  };
  const sentById = new Map<string, KeeperRecord>();
  const minedByHash = new Map<string, KeeperRecord>();
  const batchIdByHash = new Map<string, string>();
  const windowMissed = new Map<string, KeeperRecord>();
  const skips = new Map<Address, { code: string; from: bigint; to: bigint | null }[]>();
  const heartbeats: { at: bigint; ok: boolean }[] = [];
  const byDate = new Map<string, KeeperRecord[]>();
  let first: bigint | null = null;
  let last: bigint | null = null;
  for (const r of records) {
    const at = chainTimeOf(r);
    if (at !== null) {
      first = first === null || at < first ? at : first;
      last = last === null || at > last ? at : last;
      const date = dateOf(at);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(r);
    }
    const id = typeof r["batchId"] === "string" ? r["batchId"] : null;
    if (r.type === "batch_sent" && id) {
      if (!sentById.has(id)) sentById.set(id, r);
      batchIdByHash.set(String(r["hash"]), id);
    } else if (r.type === "batch_replaced" && id) batchIdByHash.set(String(r["newHash"]), id);
    else if (r.type === "batch_mined") {
      minedByHash.set(String(r["hash"]), r);
      if (id) batchIdByHash.set(String(r["hash"]), id);
    } else if (r.type === "window_missed") windowMissed.set(`${String(r["vault"])}:${String(r["slot"])}`, r);
    else if (r.type === "heartbeat" && at !== null) heartbeats.push({ at, ok: r["ok"] === true });
    else if ((r.type === "skip" || r.type === "skip_cleared") && typeof r["vault"] === "string" && r.chainTime !== undefined) {
      const vault = lower(r["vault"]);
      const list = skips.get(vault) ?? [];
      const open = list.at(-1);
      const chainTime = BigInt(r.chainTime);
      if (open && open.to === null) open.to = chainTime;
      if (r.type === "skip") list.push({ code: String(r["code"]), from: chainTime, to: null });
      skips.set(vault, list);
    }
  }
  const up = upIntervals(heartbeats);
  // The logs tell of the keeper from their first record on, and are taken to
  // reach the report's last block: the keeper's own data directory does, so a
  // keeper that stopped writing before then was down, not unknown — a keeper
  // that died must never read as healthy. Past the last block they reach as
  // far as their last record, or the last heartbeat's period, which vouches.
  const upTo = up.at(-1)?.[1] ?? null;
  const end = last === null ? null : [last, upTo ?? last, toTime].reduce((a, b) => (b > a ? b : a));
  return {
    sentById,
    minedByHash,
    batchIdByHash,
    windowMissed,
    skips,
    up,
    span: first === null || end === null ? null : ([first, end] as const),
    byDate,
    dates: [...byDate.keys()].sort(),
  };
}

/**
 * When the keeper was up, from its `heartbeat` records: each ok one covers
 * the time until the next, or two heartbeat periods if the next is later —
 * a gap longer than that is downtime. The period is the records' own typical
 * spacing (five minutes by default), so an operator's setting is respected.
 */
function upIntervals(heartbeats: readonly { at: bigint; ok: boolean }[]): [bigint, bigint][] {
  const sorted = [...heartbeats].sort((a, b) => cmpBig(a.at, b.at));
  const gaps = sorted.slice(1).map((h, i) => h.at - sorted[i]!.at).filter((g) => g > 0n);
  const period = percentile(gaps, 50) ?? 300n;
  const out: [bigint, bigint][] = [];
  sorted.forEach((h, i) => {
    if (!h.ok) return;
    const cap = h.at + 2n * period;
    const next = sorted[i + 1]?.at ?? h.at + period;
    out.push([h.at, next < cap ? next : cap]);
  });
  return out;
}

/** The share of `[from, to)`, within the span the logs cover, that the keeper was up; one decimal, as text. */
function uptimeOver(log: { span: readonly [bigint, bigint] | null; up: readonly [bigint, bigint][] }, from: bigint, to: bigint): string | null {
  if (log.span === null) return null;
  const a = log.span[0] > from ? log.span[0] : from;
  const b = log.span[1] < to ? log.span[1] : to;
  if (b <= a) return null;
  const permille = (covered(log.up, a, b) * 1000n) / (b - a);
  return `${permille / 10n}.${permille % 10n}`;
}

function covered(intervals: readonly (readonly [bigint, bigint])[], from: bigint, to: bigint): bigint {
  let sum = 0n;
  let reached = from;
  for (const [a, b] of intervals) {
    const start = a > reached ? a : reached;
    const end = b < to ? b : to;
    if (end > start) {
      sum += end - start;
      reached = end;
    }
  }
  return sum;
}

// ─── Buys ─────────────────────────────────────────────────────────────────────

function triggerOf(c: Context, buy: Buy, owner: Address | null): Trigger {
  if (owner !== null && buy.event.keeper === owner) return "owner";
  if (c.batchers.has(buy.event.keeper)) return buy.run && c.ours(buy.run) ? "our-batch" : "batch";
  return "other";
}

/** The planned subsidy a buy's batch carried for it, from the keeper's `batch_sent`; null without keeper logs. */
function subsidyOf(c: Context, buy: Buy): bigint | null {
  if (!c.hasLogs) return null;
  const id = c.keeperLog.batchIdByHash.get(buy.tx);
  const sent = id ? c.keeperLog.sentById.get(id) : undefined;
  const entry = (sent?.["vaults"] as { vault?: string; subsidyWei?: string }[] | undefined)?.find((v) => v.vault === buy.vault);
  return entry?.subsidyWei ? BigInt(entry.subsidyWei) : 0n;
}

function buyRows(c: Context): Row[] {
  const rows: Row[] = [];
  for (const [vault, t] of c.timelines) {
    if (!c.isSelected(vault)) continue;
    const byNumber = new Map(t.buys.map((b) => [b.event.buyNumber, b]));
    for (const buy of t.buys) {
      const e = buy.event;
      const time = c.timeOf(buy.block);
      const terms = t.terms;
      const windowStart = terms ? terms.startAt + e.slot * terms.interval : null;
      const previous = byNumber.get(e.buyNumber - 1n);
      const previousAt = previous ? c.timeOf(previous.block) : null;
      const due = !terms ? null : e.buyNumber === 1n ? firstDue(c, t, terms.startAt) : previousAt === null ? null : earliestBuyAt(terms, e.buyNumber - 1n, previousAt);
      const fair = terms ? fairOut(e.floorOut, terms.maxSlippageBps) : null;
      const price = c.priceAt(buy.block);
      rows.push({
        tx_hash: buy.tx,
        log_index: buy.logIndex,
        block: buy.block,
        time: iso(time),
        vault,
        owner: t.owner,
        slot: e.slot,
        buy_number: e.buyNumber,
        window_start: windowStart,
        seconds_into_window: time !== null && windowStart !== null ? time - windowStart : null,
        seconds_after_due: time !== null && due !== null ? time - due : null,
        amount_in_wei: e.amountIn,
        amount_out: e.amountOut,
        floor_out: e.floorOut,
        fair_out: fair,
        exec_vs_floor_bps: bpsAbove(e.amountOut, e.floorOut),
        exec_vs_fair_bps: fair === null ? null : bpsAbove(e.amountOut, fair),
        oracle_depth_wei: e.oracleDepth,
        fee_wei: e.reward,
        fee_bps: e.amountIn > 0n ? feeShareBps(e.reward, e.amountIn) : null,
        subsidy_wei: subsidyOf(c, buy),
        trigger: triggerOf(c, buy, t.owner),
        via_batcher: c.batchers.has(e.keeper) ? e.keeper : null,
        batch_caller: buy.run?.batch.caller ?? null,
        reward_to: buy.run?.batch.rewardTo ?? null,
        vault_gas_used: buy.triggered?.gasUsed ?? null,
        eth_usd: price === null ? null : priceText(price),
      });
    }
  }
  return rows.sort(byChainPosition);
}

/**
 * When a vault's first buy became possible: its start, or its creation when it
 * was created after its start (the factory takes a start up to a year back).
 * Null for a vault created before the range with a start before it too, whose
 * creation this range does not show.
 */
function firstDue(c: Context, t: Timeline, startAt: bigint): bigint | null {
  if (!t.created) return startAt >= c.input.range.fromTime ? startAt : null;
  const createdAt = c.timeOf(t.created.block);
  return createdAt === null ? null : createdAt > startAt ? createdAt : startAt;
}

/** What the oracle's own price would have delivered: the floor is that less the vault's allowance. */
const fairOut = (floorOut: bigint, maxSlippageBps: bigint): bigint | null =>
  maxSlippageBps < 10_000n ? (floorOut * 10_000n) / (10_000n - maxSlippageBps) : null;

/** How far `value` is above `reference`, in basis points (negative below); null against nothing. */
const bpsAbove = (value: bigint, reference: bigint): bigint | null => (reference > 0n ? ((value - reference) * 10_000n) / reference : null);

// ─── Batches ──────────────────────────────────────────────────────────────────

function batchRows(c: Context): Row[] {
  const rows: Row[] = [];
  for (const run of c.runs) {
    const touched = [...run.triggered.map((t) => t.event.vault), ...run.notTriggered.map((e) => e.vault)];
    if (!touched.some(c.isSelected)) continue;
    const receipt = c.receipts.get(run.tx) ?? null;
    const block = c.blocks.get(run.block) ?? null;
    const cost = receipt ? receipt.gasUsed * receipt.effectiveGasPrice : null;
    // Every buy the batch triggered must be here to check its fees against `earned`.
    const joined = run.triggered.length === run.buys.length;
    rows.push({
      tx_hash: run.tx,
      status: receipt?.status ?? "success",
      block: run.block,
      time: iso(block?.timestamp ?? null),
      caller: run.batch.caller,
      reward_to: run.batch.rewardTo,
      listed: run.batch.listed,
      tried: run.batch.tried,
      bought: run.batch.bought,
      refused: run.notTriggered.length,
      not_tried: run.batch.listed - run.batch.tried,
      earned_wei: run.batch.earned,
      swept_wei: run.batch.swept,
      earned_matches_rewards: joined ? run.buys.reduce((sum, b) => sum + b.event.reward, 0n) === run.batch.earned : null,
      gas_used: receipt?.gasUsed ?? null,
      effective_gas_price: receipt?.effectiveGasPrice ?? null,
      priority_fee_wei: receipt && block?.baseFee != null ? receipt.gasUsed * positive(receipt.effectiveGasPrice - block.baseFee) : null,
      base_fee: block?.baseFee ?? null,
      cost_wei: cost,
      net_wei: cost === null ? null : run.batch.earned - cost,
      ...keeperSide(c, run.tx),
    });
  }
  // A public batch that reverted left no events: the keeper's own log is the only record of it.
  for (const [hash, mined] of c.keeperLog.minedByHash) {
    if (mined["status"] !== "reverted" || c.runByTx.has(hash as Hex)) continue;
    const id = stringField(mined["batchId"]);
    const sent = id ? c.keeperLog.sentById.get(id) : undefined;
    const vaults = ((sent?.["vaults"] as { vault?: string }[] | undefined) ?? []).map((v) => lower(String(v.vault)));
    if (!vaults.some(c.isSelected)) continue;
    const blockNumber = big(mined["block"]);
    const block = blockNumber === null ? null : (c.blocks.get(blockNumber) ?? null);
    const cost = big(mined["costWei"]);
    rows.push({
      tx_hash: hash,
      status: "reverted",
      block: blockNumber,
      time: iso(block?.timestamp ?? null),
      caller: mined.keeper,
      reward_to: null,
      listed: BigInt(vaults.length),
      tried: null,
      bought: 0n,
      refused: null,
      not_tried: null,
      earned_wei: 0n,
      swept_wei: 0n,
      earned_matches_rewards: null,
      gas_used: big(mined["gasUsed"]),
      effective_gas_price: big(mined["effectiveGasPrice"]),
      priority_fee_wei: big(mined["priorityFeeWei"]),
      base_fee: block?.baseFee ?? null,
      cost_wei: cost,
      net_wei: cost === null ? null : -cost,
      ...keeperSide(c, hash),
    });
  }
  // Dollars at the day's price; then the columns in order.
  return rows
    .map((row): Row => {
      const price = typeof row["block"] === "bigint" ? c.priceAt(row["block"]) : null;
      const net = big(row["net_wei"]);
      return { ...row, net_usd: net === null || price === null ? null : usdText(net, price), eth_usd: price === null ? null : priceText(price) };
    })
    .sort((a, b) => cmpBig(big(a["block"]), big(b["block"])) || cmp(String(a["tx_hash"]), String(b["tx_hash"])));
}

/** What the operator's keeper logged about a batch it sent; null for someone else's batch, or without logs. */
function keeperSide(c: Context, hash: string): Row {
  const id = c.keeperLog.batchIdByHash.get(hash) ?? null;
  const sent = id ? c.keeperLog.sentById.get(id) : undefined;
  const mined = c.keeperLog.minedByHash.get(hash);
  return {
    batch_id: id,
    nonce: numberField(mined?.["nonce"] ?? sent?.["nonce"]),
    endpoint: stringField(sent?.["endpoint"]),
    expected_gas: big(sent?.["expectedGas"]),
    expected_cost_wei: big(sent?.["expectedCostWei"]),
    keeper_reason: stringField(sent?.["reason"]),
    urgent: typeof sent?.["urgent"] === "boolean" ? sent["urgent"] : null,
    inclusion_blocks: big(mined?.["inclusionBlocks"]),
    attempts: numberField(mined?.["attempts"]),
  };
}

// ─── Refusals ─────────────────────────────────────────────────────────────────

function refusalRows(c: Context): Row[] {
  const rows: Row[] = [];
  for (const run of c.runs) {
    for (const e of run.notTriggered) {
      // Factory vaults only: an address the batcher skipped as not vouched for is nobody's plan.
      if (!c.timelines.has(e.vault) || !c.isSelected(e.vault)) continue;
      rows.push({
        source: "chain",
        tx_hash: run.tx,
        block: run.block,
        time: iso(c.timeOf(run.block)),
        vault: e.vault,
        reason: e.reason,
        reason_name: e.reasonName,
        gas_used: e.gasUsed,
      });
    }
  }
  for (const r of c.input.records) {
    if (r.type !== "skip" || r["code"] !== "sim-refused" || typeof r["vault"] !== "string") continue;
    const vault = lower(r["vault"]);
    if (!c.timelines.has(vault) || !c.isSelected(vault)) continue;
    // The keeper logs the reason's name, or its selector when the name is unknown.
    const detail = String(r["detail"] ?? "");
    const selector = /^0x[0-9a-f]{8}$/.test(detail);
    rows.push({
      source: "simulation",
      tx_hash: null,
      block: big(r.block),
      time: iso(big(r.chainTime)),
      vault,
      reason: selector ? detail : null,
      reason_name: selector || detail === "" ? null : detail,
      gas_used: null,
    });
  }
  return rows.sort((a, b) => cmpBig(big(a["block"]), big(b["block"])) || cmp(String(a["source"]), String(b["source"])) || cmp(String(a["vault"]), String(b["vault"])));
}

// ─── Windows ──────────────────────────────────────────────────────────────────

/**
 * Every window of every plan that ended in the range, or was bought in it,
 * and how it ended: bought (and by whom), the vault closed, it could not pay,
 * the keeper skipped it or was down, or unknown.
 *
 * A vault created before the range is judged only on windows that began
 * inside it, since a window that began earlier may have been bought earlier.
 * Whether a vault could pay is worked back from its balance at the last
 * block: every buy, fee and close since a moment added back, every deposit
 * taken off. WETH sent to a vault directly is visible only in that balance,
 * so it counts as there all along — which can call a window funded that was
 * not, never the reverse.
 */
function windowRows(c: Context): Row[] {
  const rows: Row[] = [];
  const { fromTime, toTime } = c.input.range;
  for (const [vault, t] of c.timelines) {
    const terms = t.terms;
    if (!c.isSelected(vault) || !terms || terms.interval <= 0n) continue;
    const createdAt = t.created ? c.timeOf(t.created.block) : null;
    const closedAt = t.closed ? c.timeOf(t.closed.block) : null;
    // Closed or finished before the range, with nothing in it: no window of its is the range's to judge.
    if (!t.created && t.buys.length === 0 && (t.at.closed === true || (t.at.buysDone !== null && t.at.buysDone >= terms.maxBuys))) continue;
    // From the window it was created in; for an older vault, from the first window that began in the range.
    const after = (time: bigint, roundUp: boolean) =>
      time <= terms.startAt ? 0n : (time - terms.startAt + (roundUp ? terms.interval - 1n : 0n)) / terms.interval;
    let slot = createdAt !== null ? after(createdAt, false) : after(fromTime, true);
    const bySlot = new Map(t.buys.map((b) => [b.event.slot, b]));
    const last = t.buys.find((b) => b.event.buyNumber === terms.maxBuys);
    const finishedAt = last ? c.timeOf(last.block) : null;
    for (; ; slot += 1n) {
      const start = terms.startAt + slot * terms.interval;
      const end = start + terms.interval;
      if (start >= toTime) break;
      if (closedAt !== null && start >= closedAt) break;
      if (finishedAt !== null && start > finishedAt) break;
      const buy = bySlot.get(slot);
      if (buy) {
        rows.push({ vault, slot, window_start: start, window_end: end, class: "bought", by: triggerOf(c, buy, t.owner), last_skip: null });
        continue;
      }
      if (end > toTime) break;
      const judged = missedClass(c, vault, t, slot, start, end, closedAt);
      rows.push({ vault, slot, window_start: start, window_end: end, class: judged.cls, by: null, last_skip: judged.lastSkip });
      if (judged.cls === "closed") break;
    }
  }
  return rows.sort((a, b) => cmp(String(a["vault"]), String(b["vault"])) || cmpBig(big(a["slot"]), big(b["slot"])));
}

function missedClass(
  c: Context,
  vault: Address,
  t: Timeline,
  slot: bigint,
  start: bigint,
  end: bigint,
  closedAt: bigint | null,
): { cls: WindowClass; lastSkip: string | null } {
  if (closedAt !== null && closedAt < end) return { cls: "closed", lastSkip: null };
  const balance = balanceBefore(c, t, end);
  if (balance !== null && t.terms && balance < t.terms.amountPerBuy + t.terms.keeperReward) return { cls: "unfunded", lastSkip: null };
  const logged = c.keeperLog.windowMissed.get(`${vault}:${slot}`);
  const loggedClass = logged ? String(logged["class"]) : null;
  const loggedSkip = logged && typeof logged["lastSkip"] === "string" ? logged["lastSkip"] : null;
  if (loggedClass === "keeper-skipped" || loggedClass === "keeper-down") return { cls: loggedClass, lastSkip: loggedSkip };
  const span = c.keeperLog.span;
  if (span === null || end <= span[0] || start >= span[1]) return { cls: "unknown", lastSkip: loggedSkip };
  if (covered(c.keeperLog.up, start, end) === 0n) return { cls: "keeper-down", lastSkip: null };
  const skip = (c.keeperLog.skips.get(vault) ?? []).filter((s) => s.from < end && (s.to === null || s.to >= start)).at(-1);
  return skip ? { cls: "keeper-skipped", lastSkip: skip.code } : { cls: "unknown", lastSkip: loggedSkip };
}

/** A vault's WETH just before `time`, worked back from its balance at the last block; null when that is unknown. */
function balanceBefore(c: Context, t: Timeline, time: bigint): bigint | null {
  if (t.at.balance === null) return null;
  // What each event did to the balance: buys and the close took WETH out, deposits and creation put it in.
  const changes: [bigint, bigint][] = [
    ...t.buys.map((b): [bigint, bigint] => [b.block, -(b.event.amountIn + b.event.reward)]),
    ...(t.closed ? [[t.closed.block, -t.closed.amount] as [bigint, bigint]] : []),
    ...t.funded.map((f): [bigint, bigint] => [f.block, f.amount]),
    ...(t.created ? [[t.created.block, t.created.funded] as [bigint, bigint]] : []),
  ];
  let balance = t.at.balance;
  for (const [block, delta] of changes) {
    const at = c.timeOf(block);
    if (at === null) return null;
    if (at >= time) balance -= delta;
  }
  return balance;
}

// ─── Vaults and owners ────────────────────────────────────────────────────────

function vaultRows(c: Context, windows: readonly Row[]): Row[] {
  const rows: Row[] = [];
  const trapped = c.input.state ? new Set(c.input.state.trapped.map(lower)) : null;
  const notVouched = c.input.state ? new Set(c.input.state.notVouched.map(lower)) : null;
  const order = new Map(c.input.deployments.map((d, i) => [d.id, i]));
  for (const [vault, t] of c.timelines) {
    if (!c.isSelected(vault)) continue;
    const terms = t.terms;
    const mine = windows.filter((w) => w["vault"] === vault);
    const missed = mine.filter((w) => w["class"] !== "bought" && w["class"] !== "closed");
    rows.push({
      deployment: t.at.deployment,
      vault,
      owner: t.owner,
      list_index: t.at.index,
      created_block: t.created?.block ?? null,
      created_at: iso(t.created ? c.timeOf(t.created.block) : null),
      market_index: t.created?.marketIndex ?? null,
      amount_per_buy_wei: terms?.amountPerBuy ?? null,
      interval_s: terms?.interval ?? null,
      max_buys: terms?.maxBuys ?? null,
      start_at: terms?.startAt ?? null,
      fee_wei: terms?.keeperReward ?? null,
      fee_bps: terms && terms.amountPerBuy > 0n ? feeShareBps(terms.keeperReward, terms.amountPerBuy) : null,
      max_slippage_bps: terms?.maxSlippageBps ?? null,
      funded_at_creation_wei: t.created?.funded ?? null,
      funded_later_wei: t.funded.reduce((sum, f) => sum + f.amount, 0n),
      buys_done: t.at.buysDone,
      windows_elapsed: mine.length,
      windows_missed_funded: missed.filter((w) => w["class"] !== "unfunded").length,
      windows_missed_unfunded: missed.filter((w) => w["class"] === "unfunded").length,
      buy_number_gaps: buyNumberGaps(t),
      closed: t.at.closed ?? (t.closed ? true : null),
      closed_at: iso(t.closed ? c.timeOf(t.closed.block) : null),
      closed_amount_wei: t.closed?.amount ?? null,
      total_out: t.buys.reduce((sum, b) => sum + b.event.amountOut, 0n),
      subsidy_wei: c.hasLogs ? t.buys.reduce((sum, b) => sum + (subsidyOf(c, b) ?? 0n), 0n) : null,
      trapped: trapped === null ? null : trapped.has(vault),
      not_vouched: notVouched === null ? null : notVouched.has(vault),
    });
  }
  return rows.sort(
    (a, b) =>
      (order.get(String(a["deployment"])) ?? 0) - (order.get(String(b["deployment"])) ?? 0) ||
      cmpBig(big(a["list_index"]), big(b["list_index"])) ||
      cmp(String(a["vault"]), String(b["vault"])),
  );
}

/**
 * Buy numbers the logs should show and don't: `buyNumber` counts every buy a
 * vault makes, so a missing one is a log the endpoint dropped. For a vault
 * created in the range the run starts at 1; for an older one, at the first
 * buy seen. It ends at the vault's own count at the last block. Null for an
 * older vault with no buy in the range, whose run cannot be placed.
 */
function buyNumberGaps(t: Timeline): number | null {
  const seen = new Set(t.buys.map((b) => b.event.buyNumber));
  const numbers = [...seen].sort(cmpBig);
  const low = t.created ? 1n : (numbers[0] ?? null);
  if (low === null) return null;
  const high = t.at.buysDone ?? numbers.at(-1) ?? 0n;
  let gaps = 0;
  for (let n = low; n <= high; n += 1n) if (!seen.has(n)) gaps += 1;
  return gaps;
}

function ownerRows(c: Context): Row[] {
  const owners = new Map<string, { vaults: number; buys: number; volume: bigint; fees: bigint; subsidy: bigint | null }>();
  for (const [vault, t] of c.timelines) {
    if (!c.isSelected(vault) || t.owner === null) continue;
    const o = owners.get(t.owner) ?? { vaults: 0, buys: 0, volume: 0n, fees: 0n, subsidy: c.hasLogs ? 0n : null };
    o.vaults += 1;
    for (const buy of t.buys) {
      o.buys += 1;
      o.volume += buy.event.amountIn;
      o.fees += buy.event.reward;
      const s = subsidyOf(c, buy);
      if (o.subsidy !== null && s !== null) o.subsidy += s;
    }
    owners.set(t.owner, o);
  }
  return [...owners.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([owner, o]) => ({ owner, vaults: o.vaults, buys: o.buys, volume_wei: o.volume, fees_wei: o.fees, subsidy_wei: o.subsidy }));
}

// ─── Days ─────────────────────────────────────────────────────────────────────

function dailyRows(c: Context, t: { buys: Row[]; batches: Row[]; windows: Row[]; keeper: Row[] }): Row[] {
  const uptime = new Map(t.keeper.map((k) => [String(k["date"]), k["uptime_pct"] ?? null]));
  return c.dates.map((date) => {
    const buys = t.buys.filter((b) => dateOfIso(b["time"]) === date);
    const batches = t.batches.filter((b) => dateOfIso(b["time"]) === date);
    const missed = t.windows.filter((w) => w["class"] !== "bought" && w["class"] !== "closed" && dateOf(big(w["window_end"])!) === date);
    const events = { created: 0, closed: 0, deposits: 0n, withdrawals: 0n };
    for (const [vault, tl] of c.timelines) {
      if (!c.isSelected(vault)) continue;
      if (tl.created && dateAt(c, tl.created.block) === date) {
        events.created += 1;
        events.deposits += tl.created.funded;
      }
      for (const f of tl.funded) if (dateAt(c, f.block) === date) events.deposits += f.amount;
      if (tl.closed && dateAt(c, tl.closed.block) === date) {
        events.closed += 1;
        events.withdrawals += tl.closed.amount;
      }
    }
    const volume = sum(buys, "amount_in_wei");
    const price = c.priceOn(date);
    const subsidies = c.hasLogs ? c.buys.filter((b) => c.isSelected(b.vault) && dateAt(c, b.block) === date).map((b) => subsidyOf(c, b) ?? 0n) : null;
    return {
      date,
      buys: buys.length,
      active_vaults: new Set(buys.map((b) => b["vault"])).size,
      owners: new Set(buys.map((b) => b["owner"])).size,
      volume_wei: volume,
      volume_usd: price === null ? null : usdText(volume, price),
      fees_wei: sum(buys, "fee_wei"),
      batches: batches.length,
      gas_cost_wei: sumKnown(batches, "cost_wei"),
      net_wei: sumKnown(batches, "net_wei"),
      subsidy_wei: subsidies === null ? null : subsidies.reduce((a, b) => a + b, 0n),
      vaults_created: events.created,
      vaults_closed: events.closed,
      deposits_wei: events.deposits,
      withdrawals_wei: events.withdrawals,
      windows_missed_funded: missed.filter((w) => w["class"] !== "unfunded").length,
      windows_missed_unfunded: missed.filter((w) => w["class"] === "unfunded").length,
      median_seconds_into_window: median(buys, "seconds_into_window"),
      median_exec_vs_fair_bps: median(buys, "exec_vs_fair_bps"),
      median_oracle_depth_wei: median(buys, "oracle_depth_wei"),
      keeper_uptime_pct: uptime.get(date) ?? null,
      eth_usd: price === null ? null : priceText(price),
    };
  });
}

/**
 * Per UTC day (of chain time, like every other table), from the keeper's logs
 * alone: every day the logs' span covers, so a day with no record at all shows
 * as a day the keeper was down rather than as a missing row.
 */
function keeperRows(c: Context): Row[] {
  const log = c.keeperLog;
  const dates = log.span === null ? [] : datesBetween(log.span[0], log.span[1]);
  return dates.map((date) => {
    const on = log.byDate.get(date) ?? [];
    const count = (type: string, field?: string, value?: string) => on.filter((r) => r.type === type && (field === undefined || r[field] === value)).length;
    const mined = on.filter((r) => r.type === "batch_mined");
    const ratios = mined.flatMap((m) => {
      const id = stringField(m["batchId"]);
      const expected = big((id ? log.sentById.get(id) : undefined)?.["expectedGas"]);
      const used = big(m["gasUsed"]);
      return expected && used !== null && m["status"] === "success" ? [(used * 1000n) / expected] : [];
    });
    const ratio = percentile(ratios, 50);
    return {
      date,
      heartbeats: count("heartbeat"),
      uptime_pct: c.uptime(dayStart(date), dayStart(date) + DAY),
      errors: count("error"),
      waits_not_cheap: count("wait", "reason", "not-cheap"),
      sends_cheap: count("batch_sent", "reason", "cheap"),
      sends_deadline: count("batch_sent", "reason", "deadline"),
      sends_short_interval: count("batch_sent", "reason", "short-interval"),
      resends: count("batch_replaced"),
      resends_blocked: count("resend_blocked"),
      abandoned: count("batch_abandoned"),
      cancels: count("batch_cancel_sent"),
      median_inclusion_blocks: percentile(mined.map((m) => big(m["inclusionBlocks"])).filter((v): v is bigint => v !== null), 50),
      model_gas_ratio: ratio === null ? null : thousandths(ratio),
    };
  });
}

// ─── Tips ─────────────────────────────────────────────────────────────────────

/** Token transfers to the tip addresses: an upper bound on token tips, since anyone can send to them. */
function tipRows(c: Context): Row[] {
  return dedupeLogs(c.input.tips ?? [])
    .filter((log) => log.topics[0]?.toLowerCase() === TOPICS.transfer && log.topics.length === 3 && log.data.length === 66)
    .map((log) => ({
      tx_hash: log.transactionHash.toLowerCase(),
      block: log.blockNumber,
      time: iso(c.timeOf(log.blockNumber)),
      token: lower(log.address),
      from: topicAddress(log.topics[1]!),
      to: topicAddress(log.topics[2]!),
      amount: BigInt(log.data),
    }));
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const lower = (a: string): Address => a.toLowerCase() as Address;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Smaller first; an unknown (null) after every known value. */
const cmpBig = (a: bigint | null, b: bigint | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
const positive = (v: bigint): bigint => (v > 0n ? v : 0n);
const topicAddress = (topic: Hex): Address => lower(`0x${topic.slice(-40)}`);

function byChainPosition(a: Row, b: Row): number {
  return cmpBig(big(a["block"]), big(b["block"])) || Number(a["log_index"]) - Number(b["log_index"]);
}

const thousandths = (v: bigint): string => `${v / 1000n}.${(v % 1000n).toString().padStart(3, "0")}`;

const numberField = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
// ─── Time ─────────────────────────────────────────────────────────────────────

/** Chain or wall time as ISO-8601 UTC, to the second; null stays null. */
function iso(seconds: bigint | null): string | null {
  return seconds === null ? null : new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

const dateOf = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
const dateOfIso = (cell: Cell | undefined): string | null => (typeof cell === "string" ? cell.slice(0, 10) : null);
const dayStart = (date: string): bigint => BigInt(Date.parse(`${date}T00:00:00Z`) / 1000);

function dateAt(c: Context, block: bigint): string | null {
  const time = c.timeOf(block);
  return time === null ? null : dateOf(time);
}

function wallSeconds(ts: string): bigint | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

/** Every UTC date from one time to another, both included. */
function datesBetween(from: bigint, to: bigint): string[] {
  const dates: string[] = [];
  for (let day = dayStart(dateOf(from)); day <= to; day += DAY) dates.push(dateOf(day));
  return dates;
}
