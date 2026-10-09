/**
 * This browser's record of what each auto-buy plan has done.
 *
 * A plan lives in the config; what it has *done* does not. Which wallet it
 * buys for, which address signs, how many buys settled, how much of the budget
 * is spoken for, which buy window was last used: those are facts about this
 * device, like whether the features dialog was shown, and they must never
 * travel in a shared link. They live here, in localStorage, keyed by chain and
 * plan id.
 *
 * ## Fail closed
 *
 * The Guard treats a plan with no record as a plan with no budget left
 * (`SCHEDULE_EXCEEDS_BUDGET`), and this file keeps that promise from its side:
 *
 * - A record that cannot be read — storage throws, the JSON is corrupt, a field
 *   is the wrong shape — makes `read()` answer `"unavailable"`, never an empty
 *   ledger. An empty ledger would look like "nothing bought yet", and a plan
 *   would start its budget again.
 * - Every transition returns a new ledger or throws a named error. None
 *   repairs, clamps or guesses. A claim that does not fit is refused.
 * - `committed` is claimed *before* the first signature and released only when
 *   nothing can have been spent, so a crash mid-buy costs a skipped buy and
 *   never a second one.
 *
 * Only a missing key reads as an empty ledger: that is the first visit, and
 * every plan it would matter for shows as "not started here" until the owner
 * starts it on purpose.
 *
 * ## Validation
 *
 * By hand, field by field, reusing @spdex/core's schemas for the fields core
 * defines (addresses, plan ids, chain ids). apps/web has no direct zod
 * dependency and adding one is a lockfile change; the check is what matters,
 * and it is strict — an unexpected shape anywhere fails the whole read.
 *
 * ## Several tabs
 *
 * Only the tab holding the auto-buy leader lock writes buys (runner.ts), but
 * any tab's UI writes a few things of its own — starting a plan, a resume.
 * localStorage has no transactions across tabs, and
 * each tab reads through its own copy, which the browser brings up to date
 * asynchronously; so a read-modify-write in one tab, made from a copy taken
 * before another tab's claim reached it, would write the claim away — and a
 * buy time whose claim is gone is a buy time that can be bought in again.
 *
 * So every write that matters is made under one cross-tab lock
 * (`LEDGER_LOCK`, Web Locks): the runner holds it across a whole look or
 * button press, claim to settlement (`exclusive`), and the UI's writes queue
 * for it (`updateShared`). A write that changes nothing is not written at
 * all, so an idempotent call cannot write back a stale copy either. And the
 * runner checks, when it settles a buy, that its claim is still there; if it
 * is not, it puts it back and stops the plan (`reinstateClaim`), because
 * something it did not expect wrote over the record.
 *
 * Every tab's store listens for the `storage` event so its UI can refresh when
 * another tab writes.
 */

import {
  AddressSchema,
  ChainIdSchema,
  DcaPlanIdSchema,
  type Address,
  type DcaProgress,
} from "@spdex/core";

export const LEDGER_KEY = "spdex.dca.ledger.v1";
/** The Web Locks name every write of the ledger is made under; see "Several tabs". */
export const LEDGER_LOCK = "spdex.dca.ledger";
/** Newest last; older runs are dropped. Totals that must outlive them are kept on the entry. */
export const MAX_RUNS = 100;
/** Buy windows in a row that ended in failure before a plan stops itself and asks. */
export const HALT_AFTER_FAILURES = 3;

export type RunStatus = "pending" | "confirmed" | "failed" | "declined" | "skipped" | "held" | "unknown";
const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "confirmed",
  "failed",
  "declined",
  "skipped",
  "held",
  "unknown",
];

/**
 * Why a run is what it is, in machine terms, beside any Guard codes.
 *
 * The history chooses its sentence from these (`runLabel` in format.ts); the
 * `reason` on a run is the plain-words backstop.
 */
export const RUN_CODES = {
  /** Buy times that passed while spDEX was not running. One entry per gap; `missed` says how many. */
  MISSED: "MISSED",
  /** A wallet-mode buy nobody confirmed before its buy time ended. Uses the window. */
  NOT_CONFIRMED: "NOT_CONFIRMED",
  /**
   * An autopilot window that ended without a buy (unfunded, needs
   * attention…). Uses the window. Written only before config version 8,
   * which removed autopilot; kept so its history still reads.
   */
  NOT_BOUGHT: "NOT_BOUGHT",
  /** The owner chose to skip this window. Uses it. */
  SKIPPED_BY_USER: "SKIPPED_BY_USER",
  /** A held buy nobody answered before its buy time ended. Uses the window. */
  HELD_EXPIRED: "HELD_EXPIRED",
  /**
   * Network fees above an autopilot plan's ceiling. Written only before
   * config version 8; kept so that history still reads.
   */
  FEE_CEILING: "FEE_CEILING",
  /**
   * An autopilot buy needed more gas than its fee budget allowed, so it was
   * not signed. Written only before config version 8; kept so that history
   * still reads.
   */
  GAS_BUDGET: "GAS_BUDGET",
  /**
   * The paying wallet could not cover the buy: the owner's wallet (the amount
   * sold), or, before config version 8, an autopilot plan's spending wallet
   * (the buy plus its fee).
   */
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  /** Private submission was asked for and the wallet cannot do it; never sent publicly instead. */
  PRIVATE_UNAVAILABLE: "PRIVATE_SUBMISSION_UNAVAILABLE",
  /**
   * The relay (private sending) answered and refused a transaction the
   * owner's wallet signed. It did not go out, no fee was spent, and it is
   * never re-sent publicly instead.
   */
  RELAY_FAILED: "RELAY_FAILED",
  /**
   * The owner's wallet signed a private buy too close to (or after) its
   * deadline, so it was not posted: on chain it could only revert, and still
   * cost its fee. Nothing was sent.
   */
  LATE_SIGNATURE: "LATE_SIGNATURE",
  /** No quote could be produced (no route, the endpoint failed…). */
  QUOTE_FAILED: "QUOTE_FAILED",
  /** The tab closed mid-buy; settled later from the chain. */
  INTERRUPTED: "INTERRUPTED",
  /** Some legs of a split buy went through and some did not. */
  PARTIAL: "PARTIAL",
  /**
   * A wallet-mode buy the owner's wallet may have sent while spDEX lost track
   * of it (the tab closed, or the wallet answered with an error), whose
   * transaction was never found: the owner's account has used the nonce the
   * buy was to use, so something went out in its place. Counted as made —
   * with no amount received — so the plan can never spend past its budget;
   * the owner's wallet activity says what it was.
   */
  ASSUMED_SPENT: "ASSUMED_SPENT",
  /** The buy's transaction was mined and reverted. */
  REVERTED: "REVERTED",
  /** The owner declined in their wallet. */
  DECLINED: "DECLINED",
} as const;

export type RunStep = "approve" | "swap";

export interface DcaRun {
  /** The buy window this run is about. */
  slot: number;
  /** When it was recorded or last updated, ms since the epoch. */
  at: number;
  status: RunStatus;
  /**
   * Base units of the plan's sell token. For a claimed buy, what was claimed
   * (the legs' summed `maxAmountIn`); for a skipped or held one, what it would
   * have spent.
   */
  amountIn: string;
  /** What arrived at the owner, measured on chain. Absent when it could not be measured — never 0 for unknown. */
  amountOut?: string;
  /** Every transaction of the buy, in the order sent. */
  hashes: string[];
  /** Parallel to `hashes`: which were permissions and which were swaps. */
  steps?: RunStep[];
  /** How many swap transactions the buy needed in all; fewer confirmed means partial. */
  calls?: number;
  /** Unix seconds after which none of the buy's swaps can execute (the quote's deadline). */
  deadline?: number;
  via?: string;
  reason?: string;
  codes?: string[];
  /** Held for a price warning: the divergence the owner is shown, in basis points. */
  divergenceBps?: number;
  /** Held for fees: the fee rate the owner is shown, wei per gas. */
  feeRate?: string;
  /** A `MISSED` entry: how many buy times passed. */
  missed?: number;
  /** Retries of a skipped attempt within its window, after the first. */
  retries?: number;
  /**
   * This window has already counted toward stopping the plan. Carried across
   * the skipped and held records that replace one another within a window, so
   * a window counts once however its attempts alternate.
   */
  counted?: boolean;
  /**
   * A wallet-mode buy: the owner's pending nonce when the buy was claimed —
   * the nonce its first transaction was to use. The wallet reports a hash only
   * after it has sent, so a buy with no hash is settled by this: once the
   * owner's account has used it, something went out.
   */
  ownerNonce?: number;
  /**
   * A wallet-mode buy whose wallet was asked to send one of its transactions
   * and answered with an error that was not a refusal (a timeout, a dropped
   * connection) rather than a hash. The wallet may still have sent it, so
   * the buy is settled by the owner's nonce, or given back only once its
   * deadline has passed.
   */
  walletUnanswered?: boolean;
  /**
   * A claimed buy: the plan's `lastSlot` before this claim used the window,
   * so that a buy the owner declines can give its window back
   * (`releaseBuy`). Absent on records written before it existed, whose
   * declines keep the window used, as they always did.
   */
  lastSlotBefore?: number | null;
}

export interface DcaLedgerEntry {
  planId: string;
  chainId: number;
  /** Where every buy is delivered: the wallet that started the plan here. */
  owner: Address;
  /**
   * Who signs: the owner. A record written for an autopilot plan before
   * config version 8 names its spending wallet, until the plan is resumed as
   * one its owner confirms (`bindToOwner`).
   */
  signer: Address;
  /** When the plan was started in this browser, ms. */
  startedAt: number;
  buysDone: number;
  /** Σ maxAmountIn of every claimed buy, less what failed buys released. Decimal base units. */
  committed: string;
  lastSlot: number | null;
  /** Buy windows in a row that ended in failure. */
  consecutiveFailures: number;
  /** Set when the plan stopped itself; the reason. Cleared by `resume`. */
  halted?: string;
  lastAttemptAt?: number;
  /** The last window the runner looked at this plan in, and whether the plan could buy then. */
  lastSeen?: { slot: number; active: boolean };
  /**
   * Running totals over every settled buy whose delivery was measured. Kept
   * here rather than summed from `runs`, which only keeps the last 100.
   */
  measured: { buys: number; amountIn: string; amountOut: string };
  runs: DcaRun[];
  /**
   * Money moved between the owner and an autopilot plan's spending wallet,
   * newest last, as recorded before config version 8. Nothing adds to it
   * now; it is kept because it is the plan's history, which the migration
   * promised to keep. Beside `runs` rather than in it, because a transfer is
   * not about a buy window and every rule about runs is. The history shows
   * both, merged by time (`historyOf` in format.ts).
   */
  transfers?: DcaTransfer[];
}

/**
 * Funding, a top-up or a withdrawal, as the history shows it: recorded before
 * config version 8, from what was confirmed (`amounts`) and every hash sent
 * (`hashes`).
 */
export interface DcaTransfer {
  kind: TransferKind;
  /** ms since the epoch. */
  at: number;
  /** What moved, in the order sent: base units, the native pseudo-address for ether. */
  amounts: { token: Address; amount: string }[];
  /** Every transaction sent, in order, confirmed or not. */
  hashes: string[];
  /** Why it stopped part-way, when it did. */
  reason?: string;
}

/** The first funding, a later one, and money sent back. */
export type TransferKind = "funded" | "topped-up" | "withdrawn";
const TRANSFER_KINDS: readonly TransferKind[] = ["funded", "topped-up", "withdrawn"];

export interface DcaLedger {
  version: 1;
  entries: Record<string, DcaLedgerEntry>;
}

export interface EntryRef {
  planId: string;
  chainId: number;
}

export function entryKey(chainId: number, planId: string): string {
  return `${chainId}:${planId}`;
}

export function emptyLedger(): DcaLedger {
  return { version: 1, entries: {} };
}

// ── Errors ────────────────────────────────────────────────────────────────

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** The plan has no record in this browser. */
export class LedgerEntryMissingError extends LedgerError {
  constructor(ref: EntryRef) {
    super(`there is no record of plan "${ref.planId}" on chain ${ref.chainId} in this browser`);
    this.name = "LedgerEntryMissingError";
  }
}

/** Starting a plan again for a different owner or signer than it was started for. */
export class LedgerRebindError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRebindError";
  }
}

/** A buy that cannot be claimed: its window is used, another buy is unsettled, or the plan stopped. */
export class ClaimRefusedError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimRefusedError";
  }
}

/** A transition about a run that is not there, or not in the state it needs. */
export class RunStateError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "RunStateError";
  }
}

/** The ledger cannot be read, so it cannot be changed. */
export class LedgerUnavailableError extends LedgerError {
  constructor() {
    super("this browser's record of auto-buys cannot be read, so nothing can be recorded");
    this.name = "LedgerUnavailableError";
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is number => isCount(v);
const isUnits = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isHash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Invalid extends Error {}
function need(ok: boolean, what: string): void {
  if (!ok) throw new Invalid(what);
}

/** Copy an optional field across only if present; present-but-wrong fails the read. */
function optional<T>(source: Record<string, unknown>, key: string, check: (v: unknown) => v is T): T | undefined {
  if (!(key in source) || source[key] === undefined) return undefined;
  const value = source[key];
  need(check(value), key);
  return value as T;
}

function parseRun(raw: unknown): DcaRun {
  need(isRecord(raw), "run");
  const r = raw as Record<string, unknown>;
  need(isCount(r["slot"]), "run.slot");
  need(isTime(r["at"]), "run.at");
  need(RUN_STATUSES.includes(r["status"] as RunStatus), "run.status");
  need(isUnits(r["amountIn"]), "run.amountIn");
  need(Array.isArray(r["hashes"]) && (r["hashes"] as unknown[]).every(isHash), "run.hashes");
  const hashes = (r["hashes"] as string[]).map((h) => h.toLowerCase());

  const steps = optional(r, "steps", (v): v is RunStep[] =>
    Array.isArray(v) && v.every((s) => s === "approve" || s === "swap"),
  );
  if (steps !== undefined) need(steps.length === hashes.length, "run.steps");
  const codes = optional(r, "codes", (v): v is string[] => Array.isArray(v) && v.every(isString));

  const run: DcaRun = {
    slot: r["slot"] as number,
    at: r["at"] as number,
    status: r["status"] as RunStatus,
    amountIn: r["amountIn"] as string,
    hashes,
  };
  const amountOut = optional(r, "amountOut", isUnits);
  const calls = optional(r, "calls", isCount);
  const deadline = optional(r, "deadline", isCount);
  const via = optional(r, "via", isString);
  const reason = optional(r, "reason", isString);
  const divergenceBps = optional(r, "divergenceBps", isCount);
  const feeRate = optional(r, "feeRate", isUnits);
  const missed = optional(r, "missed", isCount);
  const retries = optional(r, "retries", isCount);
  const counted = optional(r, "counted", (v): v is boolean => typeof v === "boolean");
  const walletUnanswered = optional(r, "walletUnanswered", (v): v is boolean => typeof v === "boolean");
  const ownerNonce = optional(r, "ownerNonce", isCount);
  const lastSlotBefore = optional(r, "lastSlotBefore", (v): v is number | null => v === null || isCount(v));
  return {
    ...run,
    ...(amountOut === undefined ? {} : { amountOut }),
    ...(steps === undefined ? {} : { steps: [...steps] }),
    ...(calls === undefined ? {} : { calls }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(via === undefined ? {} : { via }),
    ...(reason === undefined ? {} : { reason }),
    ...(codes === undefined ? {} : { codes: [...codes] }),
    ...(divergenceBps === undefined ? {} : { divergenceBps }),
    ...(feeRate === undefined ? {} : { feeRate }),
    ...(missed === undefined ? {} : { missed }),
    ...(retries === undefined ? {} : { retries }),
    ...(counted === undefined ? {} : { counted }),
    ...(ownerNonce === undefined ? {} : { ownerNonce }),
    ...(walletUnanswered === undefined ? {} : { walletUnanswered }),
    ...(lastSlotBefore === undefined ? {} : { lastSlotBefore }),
  };
}

function parseAddress(v: unknown, what: string): Address {
  const parsed = AddressSchema.safeParse(v);
  need(parsed.success, what);
  return parsed.data as Address;
}

function parseTransfer(raw: unknown): DcaTransfer {
  need(isRecord(raw), "transfer");
  const t = raw as Record<string, unknown>;
  need(TRANSFER_KINDS.includes(t["kind"] as TransferKind), "transfer.kind");
  need(isTime(t["at"]), "transfer.at");
  need(Array.isArray(t["amounts"]), "transfer.amounts");
  const amounts = (t["amounts"] as unknown[]).map((a) => {
    need(isRecord(a), "transfer.amount");
    const r = a as Record<string, unknown>;
    need(isUnits(r["amount"]), "transfer.amount");
    return { token: parseAddress(r["token"], "transfer.token"), amount: r["amount"] as string };
  });
  need(Array.isArray(t["hashes"]) && (t["hashes"] as unknown[]).every(isHash), "transfer.hashes");
  const reason = optional(t, "reason", isString);
  return {
    kind: t["kind"] as TransferKind,
    at: t["at"] as number,
    amounts,
    hashes: (t["hashes"] as string[]).map((h) => h.toLowerCase()),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseEntry(key: string, raw: unknown): DcaLedgerEntry {
  need(isRecord(raw), "entry");
  const e = raw as Record<string, unknown>;
  need(DcaPlanIdSchema.safeParse(e["planId"]).success, "planId");
  need(ChainIdSchema.safeParse(e["chainId"]).success, "chainId");
  const planId = e["planId"] as string;
  const chainId = e["chainId"] as number;
  // An entry filed under another plan's key would lend that plan its record.
  need(key === entryKey(chainId, planId), "key");
  const owner = parseAddress(e["owner"], "owner");
  const signer = parseAddress(e["signer"], "signer");
  need(isTime(e["startedAt"]), "startedAt");
  need(isCount(e["buysDone"]), "buysDone");
  need(isUnits(e["committed"]), "committed");
  need(e["lastSlot"] === null || isCount(e["lastSlot"]), "lastSlot");
  need(isCount(e["consecutiveFailures"]), "consecutiveFailures");
  need(Array.isArray(e["runs"]), "runs");
  const runs = (e["runs"] as unknown[]).map(parseRun);

  const measuredRaw = e["measured"];
  need(isRecord(measuredRaw), "measured");
  const m = measuredRaw as Record<string, unknown>;
  need(isCount(m["buys"]) && isUnits(m["amountIn"]) && isUnits(m["amountOut"]), "measured");

  const halted = optional(e, "halted", isString);
  const lastAttemptAt = optional(e, "lastAttemptAt", isTime);
  // `feeCeiling`, an autopilot plan's fee limit before config version 8, is
  // still checked when present, so a damaged record reads as damaged, and is
  // then dropped: nothing reads it now.
  optional(e, "feeCeiling", isUnits);
  const lastSeen = optional(e, "lastSeen", (v): v is { slot: number; active: boolean } =>
    isRecord(v) && isCount(v["slot"]) && typeof v["active"] === "boolean",
  );
  const transfersRaw = optional(e, "transfers", (v): v is unknown[] => Array.isArray(v));
  const transfers = transfersRaw?.map(parseTransfer);

  return {
    planId,
    chainId,
    owner,
    signer,
    startedAt: e["startedAt"] as number,
    buysDone: e["buysDone"] as number,
    committed: e["committed"] as string,
    lastSlot: e["lastSlot"] as number | null,
    consecutiveFailures: e["consecutiveFailures"] as number,
    measured: { buys: m["buys"] as number, amountIn: m["amountIn"] as string, amountOut: m["amountOut"] as string },
    runs,
    ...(halted === undefined ? {} : { halted }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    ...(lastSeen === undefined ? {} : { lastSeen: { slot: lastSeen.slot, active: lastSeen.active } }),
    ...(transfers === undefined ? {} : { transfers }),
  };
}

/** The ledger, or null if anything about it is not what this code writes. */
export function parseLedger(raw: unknown): DcaLedger | null {
  try {
    need(isRecord(raw), "ledger");
    const l = raw as Record<string, unknown>;
    need(l["version"] === 1, "version");
    need(isRecord(l["entries"]), "entries");
    const entries: Record<string, DcaLedgerEntry> = {};
    for (const [key, value] of Object.entries(l["entries"] as Record<string, unknown>)) {
      entries[key] = parseEntry(key, value);
    }
    return { version: 1, entries };
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}

// ── Reading an entry ──────────────────────────────────────────────────────

export function entryOf(ledger: DcaLedger, ref: EntryRef): DcaLedgerEntry | undefined {
  return ledger.entries[entryKey(ref.chainId, ref.planId)];
}

/** What the Guard is given about a plan: its record before the buy being checked is claimed. */
export function progressOf(entry: DcaLedgerEntry): DcaProgress {
  return {
    planId: entry.planId,
    chainId: entry.chainId,
    owner: entry.owner,
    signer: entry.signer,
    buysDone: entry.buysDone,
    committed: BigInt(entry.committed),
    lastSlot: entry.lastSlot,
  };
}

/** A run that has not settled: money may have moved, and no new buy starts until it is known. */
export function unsettledRun(entry: DcaLedgerEntry): DcaRun | undefined {
  return entry.runs.find((run) => run.status === "pending" || run.status === "unknown");
}

/** The held run for a window, if the window has one waiting on the owner. */
export function heldRun(entry: DcaLedgerEntry, slot: number): DcaRun | undefined {
  return entry.runs.find((run) => run.status === "held" && run.slot === slot);
}

// ── Transitions ───────────────────────────────────────────────────────────

function lower(address: string, what: string): Address {
  const parsed = AddressSchema.safeParse(address);
  if (!parsed.success || /^0x0{40}$/i.test(parsed.data)) {
    throw new LedgerError(`${what} ${address} is not an address a plan can use`);
  }
  return parsed.data as Address;
}

function withEntry(ledger: DcaLedger, ref: EntryRef, change: (entry: DcaLedgerEntry) => DcaLedgerEntry): DcaLedger {
  const key = entryKey(ref.chainId, ref.planId);
  const entry = ledger.entries[key];
  if (!entry) throw new LedgerEntryMissingError(ref);
  return { version: 1, entries: { ...ledger.entries, [key]: change(entry) } };
}

function trim(runs: DcaRun[]): DcaRun[] {
  return runs.length > MAX_RUNS ? runs.slice(runs.length - MAX_RUNS) : runs;
}

/** Replace the run matching `match` (the last one, if several). */
function replaceRun(runs: DcaRun[], match: (run: DcaRun) => boolean, next: DcaRun): DcaRun[] | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (match(runs[i]!)) return [...runs.slice(0, i), next, ...runs.slice(i + 1)];
  }
  return null;
}

function failed(entry: DcaLedgerEntry, reason: string): Pick<DcaLedgerEntry, "consecutiveFailures"> & { halted?: string } {
  const consecutiveFailures = entry.consecutiveFailures + 1;
  const halted = consecutiveFailures >= HALT_AFTER_FAILURES ? reason : entry.halted;
  return { consecutiveFailures, ...(halted === undefined ? {} : { halted }) };
}

function unsettledFor(entry: DcaLedgerEntry, slot: number): DcaRun {
  const run = entry.runs.find((r) => r.slot === slot && (r.status === "pending" || r.status === "unknown"));
  if (!run) throw new RunStateError(`plan "${entry.planId}" has no unsettled buy for window ${slot}`);
  return run;
}

export interface StartEntryInput extends EntryRef {
  owner: string;
  signer: string;
  at: number;
}

/**
 * Start a plan in this browser: bind its owner and signer.
 *
 * Starting again with the same pair changes nothing (a double click, a second
 * render). Starting again for a different owner or signer is refused: the
 * record counts what was bought *for that owner*, and the Guard checks every
 * buy against it, so rebinding it would hand one wallet's spent budget to
 * another — or, reversed, a fresh budget to a plan that has already spent its
 * own. A plan for a different wallet is a new plan. (The one signer that may
 * change is an old autopilot plan's spending wallet, to its own owner:
 * `bindToOwner`.)
 */
export function startEntry(ledger: DcaLedger, input: StartEntryInput): DcaLedger {
  if (!DcaPlanIdSchema.safeParse(input.planId).success) throw new LedgerError(`"${input.planId}" is not a plan id`);
  if (!ChainIdSchema.safeParse(input.chainId).success) throw new LedgerError(`${input.chainId} is not a chain id`);
  const owner = lower(input.owner, "owner");
  const signer = lower(input.signer, "signer");
  const key = entryKey(input.chainId, input.planId);
  const existing = ledger.entries[key];

  if (existing) {
    if (existing.owner !== owner) {
      throw new LedgerRebindError(
        `plan "${input.planId}" buys for ${existing.owner}; it cannot be started again for ${owner}`,
      );
    }
    if (existing.signer !== signer) {
      throw new LedgerRebindError(
        `plan "${input.planId}" is signed by ${existing.signer}; it cannot be started again with ${signer}`,
      );
    }
    // The same ledger, not a copy, when nothing changes: a store writes
    // nothing for it, so a repeated start cannot write back a stale record.
    return ledger;
  }

  const entry: DcaLedgerEntry = {
    planId: input.planId,
    chainId: input.chainId,
    owner,
    signer,
    startedAt: input.at,
    buysDone: 0,
    committed: "0",
    lastSlot: null,
    consecutiveFailures: 0,
    measured: { buys: 0, amountIn: "0", amountOut: "0" },
    runs: [],
  };
  return { version: 1, entries: { ...ledger.entries, [key]: entry } };
}

/**
 * Bind a plan's record to its owner as its signer: for a plan that was an
 * autopilot plan before config version 8, as it is resumed as a plan its
 * owner confirms.
 *
 * Its record names the old spending wallet as the signer, and the Guard
 * refuses a wallet plan's buy whose record names anyone but the owner. Only
 * the signer changes. The owner stays — the record counts what was bought for
 * that owner, and the rule `startEntry` keeps against handing it to another
 * wallet holds here too — and so does everything counted: buys made, budget
 * committed, the last window used, the history. So the plan goes on from
 * where it stopped, and never spends more in all than its budget, whoever
 * signed which buy.
 *
 * Refused while a buy is unsettled: the spending wallet signed that one, and
 * it is settled as the spending wallet's (runner.ts reads who signed from
 * this record). A record already bound to its owner comes back unchanged.
 */
export function bindToOwner(ledger: DcaLedger, ref: EntryRef): DcaLedger {
  const entry = entryOf(ledger, ref);
  if (!entry) throw new LedgerEntryMissingError(ref);
  if (entry.signer === entry.owner) return ledger;
  const open = unsettledRun(entry);
  if (open) {
    throw new LedgerRebindError(
      `plan "${ref.planId}" has a buy from its spending wallet (window ${open.slot}) that hasn't settled; ` +
        "its owner can sign for it once that has",
    );
  }
  return withEntry(ledger, ref, (current) => ({ ...current, signer: current.owner }));
}

/** Forget a plan's record. For when the plan itself is deleted — never to "reset" a budget. */
export function removeEntry(ledger: DcaLedger, ref: EntryRef): DcaLedger {
  const key = entryKey(ref.chainId, ref.planId);
  if (!ledger.entries[key]) return ledger;
  const { [key]: _removed, ...rest } = ledger.entries;
  return { version: 1, entries: rest };
}

export interface ClaimInput {
  slot: number;
  /** The legs' summed `maxAmountIn`: the most this buy can take. */
  amountIn: bigint;
  at: number;
  /** Swap transactions the buy will send. */
  calls?: number;
  /** The quote's deadline, unix seconds. */
  deadline?: number;
  /** A wallet-mode buy: the owner's pending nonce now. See `DcaRun.ownerNonce`. */
  ownerNonce?: number;
}

/**
 * Claim a window and its spending, after a signable verdict and before the
 * first signature.
 *
 * Refused if the window (or a later one) was already used, if another buy has
 * not settled, or if the plan has stopped itself. Replaces a held run for the
 * same window: the hold was the question, this is the answer.
 */
export function claimBuy(ledger: DcaLedger, ref: EntryRef, input: ClaimInput): DcaLedger {
  if (!isCount(input.slot)) throw new ClaimRefusedError(`window ${input.slot} is not a window`);
  if (input.amountIn <= 0n) throw new ClaimRefusedError("a buy must spend something");
  if (input.ownerNonce !== undefined && !isCount(input.ownerNonce)) {
    throw new ClaimRefusedError(`${input.ownerNonce} is not a nonce`);
  }
  return withEntry(ledger, ref, (entry) => {
    if (entry.halted !== undefined) throw new ClaimRefusedError(`plan "${entry.planId}" has stopped: ${entry.halted}`);
    if (entry.lastSlot !== null && entry.lastSlot >= input.slot) {
      throw new ClaimRefusedError(`window ${input.slot} of plan "${entry.planId}" already had its buy`);
    }
    const open = unsettledRun(entry);
    if (open) {
      throw new ClaimRefusedError(
        `plan "${entry.planId}" has a buy from window ${open.slot} that has not settled; no new buy until it has`,
      );
    }
    const run: DcaRun = {
      slot: input.slot,
      at: input.at,
      status: "pending",
      amountIn: input.amountIn.toString(),
      hashes: [],
      steps: [],
      ...(input.calls === undefined ? {} : { calls: input.calls }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.ownerNonce === undefined ? {} : { ownerNonce: input.ownerNonce }),
      lastSlotBefore: entry.lastSlot,
    };
    const withoutHeld = entry.runs.filter((r) => !(r.status === "held" && r.slot === input.slot));
    return {
      ...entry,
      lastSlot: input.slot,
      committed: (BigInt(entry.committed) + input.amountIn).toString(),
      lastAttemptAt: input.at,
      runs: trim([...withoutHeld, run]),
    };
  });
}

/**
 * Add a transaction hash to an unsettled buy, as soon as it exists.
 *
 * Idempotent, because a buy sent privately reports each hash twice: once when
 * the wallet has signed it, before it is posted, and once when the send
 * returns.
 */
export function recordSent(ledger: DcaLedger, ref: EntryRef, slot: number, hash: string, step: RunStep): DcaLedger {
  if (!isHash(hash)) throw new RunStateError(`${hash} is not a transaction hash`);
  const h = hash.toLowerCase();
  return withEntry(ledger, ref, (entry) => {
    const run = unsettledFor(entry, slot);
    if (run.hashes.includes(h)) return entry;
    const steps = run.steps ?? run.hashes.map((): RunStep => "swap");
    const next: DcaRun = { ...run, hashes: [...run.hashes, h], steps: [...steps, step] };
    return { ...entry, runs: replaceRun(entry.runs, (r) => r === run, next)! };
  });
}

/**
 * A sent transaction replaced in the wallet by a faster copy of the same call
 * ("Speed up"): the copy takes the original's place in the run, step and all,
 * since the original can never be mined and a run that kept it would wait for
 * it. A run that doesn't hold the original is left as it is.
 */
export function replaceSent(ledger: DcaLedger, ref: EntryRef, slot: number, original: string, replacement: string): DcaLedger {
  if (!isHash(replacement)) throw new RunStateError(`${replacement} is not a transaction hash`);
  const from = original.toLowerCase();
  const to = replacement.toLowerCase();
  return withEntry(ledger, ref, (entry) => {
    const run = unsettledFor(entry, slot);
    const at = run.hashes.indexOf(from);
    if (at === -1 || run.hashes.includes(to)) return entry;
    const hashes = run.hashes.map((h, i) => (i === at ? to : h));
    return { ...entry, runs: replaceRun(entry.runs, (r) => r === run, { ...run, hashes })! };
  });
}

export interface SettleInput {
  slot: number;
  /** Measured delivery; omit when it could not be measured. */
  amountOut?: bigint;
  hashes?: readonly string[];
  via?: string;
  /** Said when only part of a split buy went through. */
  note?: string;
  codes?: readonly string[];
  at: number;
}

/**
 * A buy happened. It counts as one of the plan's buys and ends any run of
 * failures. `committed` keeps the full claim: what the buy was allowed to
 * spend is what the budget has lost.
 */
export function settleBuy(ledger: DcaLedger, ref: EntryRef, input: SettleInput): DcaLedger {
  return withEntry(ledger, ref, (entry) => {
    const run = unsettledFor(entry, input.slot);
    const hashes = mergeHashes(run, input.hashes);
    const next: DcaRun = {
      ...run,
      at: input.at,
      status: "confirmed",
      hashes: hashes.hashes,
      steps: hashes.steps,
      ...(input.amountOut === undefined ? {} : { amountOut: input.amountOut.toString() }),
      ...(input.via === undefined ? {} : { via: input.via }),
      ...(input.note === undefined ? {} : { reason: input.note }),
      ...(input.codes === undefined || input.codes.length === 0 ? {} : { codes: [...input.codes] }),
    };
    const measured =
      input.amountOut === undefined
        ? entry.measured
        : {
            buys: entry.measured.buys + 1,
            amountIn: (BigInt(entry.measured.amountIn) + BigInt(run.amountIn)).toString(),
            amountOut: (BigInt(entry.measured.amountOut) + input.amountOut).toString(),
          };
    return {
      ...entry,
      buysDone: entry.buysDone + 1,
      consecutiveFailures: 0,
      measured,
      runs: replaceRun(entry.runs, (r) => r === run, next)!,
    };
  });
}

function mergeHashes(run: DcaRun, extra: readonly string[] | undefined): { hashes: string[]; steps: RunStep[] } {
  const hashes = [...run.hashes];
  const steps = [...(run.steps ?? run.hashes.map((): RunStep => "swap"))];
  for (const hash of extra ?? []) {
    const h = hash.toLowerCase();
    if (!isHash(h) || hashes.includes(h)) continue;
    hashes.push(h);
    steps.push("swap");
  }
  return { hashes, steps };
}

export interface ReleaseInput {
  slot: number;
  status: "failed" | "declined" | "skipped";
  reason: string;
  codes?: readonly string[];
  hashes?: readonly string[];
  at: number;
  /**
   * Whether this counts toward stopping the plan. Defaults to true for
   * `failed` — a transaction that reverted still paid its fee, and a plan that
   * keeps doing that should stop and ask — and false otherwise: a decline is
   * the owner's decision, and a buy refused before signing spent nothing.
   */
  countsAsFailure?: boolean;
}

/**
 * Nothing was bought: give the claim back. The window stays used — a failed
 * buy is not retried in the same window, so a buy that reverts cannot keep
 * paying fees to revert again.
 *
 * A buy the owner declined in their wallet is the exception. Nothing was
 * sent, so nothing can be paid twice, and a decline is often a slip: its
 * window opens again, and until it ends the buy is due as before, for the
 * owner to confirm after all or skip. Nothing asks the wallet again by
 * itself. The declined record stays in the history.
 */
export function releaseBuy(ledger: DcaLedger, ref: EntryRef, input: ReleaseInput): DcaLedger {
  return withEntry(ledger, ref, (entry) => {
    const run = unsettledFor(entry, input.slot);
    const committed = BigInt(entry.committed) - BigInt(run.amountIn);
    if (committed < 0n) throw new RunStateError(`releasing window ${input.slot} would take the plan's record below zero`);
    const hashes = mergeHashes(run, input.hashes);
    const next: DcaRun = {
      ...run,
      at: input.at,
      status: input.status,
      hashes: hashes.hashes,
      steps: hashes.steps,
      reason: input.reason,
      ...(input.codes === undefined || input.codes.length === 0 ? {} : { codes: [...input.codes] }),
    };
    const counts = input.countsAsFailure ?? input.status === "failed";
    // Only while this claim is still the last thing that used a window, and
    // only when the record says what came before it.
    const reopen = input.status === "declined" && run.lastSlotBefore !== undefined && entry.lastSlot === run.slot;
    return {
      ...entry,
      committed: committed.toString(),
      ...(counts ? failed(entry, input.reason) : {}),
      ...(reopen ? { lastSlot: run.lastSlotBefore ?? null } : {}),
      runs: replaceRun(entry.runs, (r) => r === run, next)!,
    };
  });
}

/**
 * The buy was sent and its outcome is not known yet — a confirmation that
 * timed out, a connection that dropped mid-broadcast. The claim stays, and no
 * new buy starts until the chain says what happened.
 */
export function markUnknown(
  ledger: DcaLedger,
  ref: EntryRef,
  input: {
    slot: number;
    hashes?: readonly string[];
    reason?: string;
    at: number;
    /** See `DcaRun.walletUnanswered`. Once set, it stays set. */
    walletUnanswered?: boolean;
  },
): DcaLedger {
  return withEntry(ledger, ref, (entry) => {
    const run = unsettledFor(entry, input.slot);
    const hashes = mergeHashes(run, input.hashes);
    const next: DcaRun = {
      ...run,
      at: input.at,
      status: "unknown",
      hashes: hashes.hashes,
      steps: hashes.steps,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.walletUnanswered === true ? { walletUnanswered: true } : {}),
    };
    return { ...entry, runs: replaceRun(entry.runs, (r) => r === run, next)! };
  });
}

export interface AttemptInput {
  slot: number;
  status: "skipped" | "held";
  reason: string;
  codes: readonly string[];
  /** What the buy would have spent. */
  amountIn: bigint;
  at: number;
  divergenceBps?: number;
  feeRate?: bigint;
}

/**
 * A buy that did not get as far as a claim: refused, or held for the owner.
 *
 * Does not use the window — a skipped buy may be retried later in it, and a
 * held one is waiting for an answer. One record per window: a retry updates
 * it rather than adding another, and only the first skip in a window counts
 * toward stopping the plan, so "three in a row" means three buy windows, not
 * three attempts ten minutes apart after a short outage. The record says
 * whether its window has counted (`counted`), and a held record that replaces
 * a skipped one keeps that — so skipped, held, skipped in one window is still
 * one window, not two.
 */
export function recordAttempt(ledger: DcaLedger, ref: EntryRef, input: AttemptInput): DcaLedger {
  if (!isCount(input.slot)) throw new RunStateError(`window ${input.slot} is not a window`);
  return withEntry(ledger, ref, (entry) => {
    if (entry.lastSlot !== null && entry.lastSlot >= input.slot) {
      throw new RunStateError(`window ${input.slot} of plan "${entry.planId}" is already used`);
    }
    const previous = [...entry.runs]
      .reverse()
      .find((r) => r.slot === input.slot && (r.status === "skipped" || r.status === "held"));
    // A record written before `counted` existed counted if it was a skip.
    const alreadyCounted = previous?.counted === true || previous?.status === "skipped";
    const counts = input.status === "skipped" && !alreadyCounted;
    const run: DcaRun = {
      slot: input.slot,
      at: input.at,
      status: input.status,
      amountIn: input.amountIn.toString(),
      hashes: [],
      reason: input.reason,
      codes: [...input.codes],
      ...(input.divergenceBps === undefined ? {} : { divergenceBps: input.divergenceBps }),
      ...(input.feeRate === undefined ? {} : { feeRate: input.feeRate.toString() }),
      ...(previous ? { retries: (previous.retries ?? 0) + 1 } : {}),
      ...(alreadyCounted || counts ? { counted: true } : {}),
    };
    const runs = previous ? replaceRun(entry.runs, (r) => r === previous, run)! : trim([...entry.runs, run]);
    return {
      ...entry,
      lastAttemptAt: input.at,
      ...(counts ? failed(entry, input.reason) : {}),
      runs,
    };
  });
}

/**
 * Close a window that had no buy, and use it: the owner skipped it, nobody
 * confirmed it in time, or it ended with the plan unable to buy.
 *
 * A held run for the window becomes this record (keeping its codes, so the
 * history still says what it was held for). Does not count toward stopping
 * the plan: none of these is the plan failing.
 */
export function closeWindow(
  ledger: DcaLedger,
  ref: EntryRef,
  input: { slot: number; code: string; reason: string; amountIn: bigint; at: number },
): DcaLedger {
  if (!isCount(input.slot)) throw new RunStateError(`window ${input.slot} is not a window`);
  return withEntry(ledger, ref, (entry) => {
    if (entry.lastSlot !== null && entry.lastSlot >= input.slot) {
      throw new RunStateError(`window ${input.slot} of plan "${entry.planId}" is already used`);
    }
    if (unsettledRun(entry)?.slot === input.slot) {
      throw new RunStateError(`window ${input.slot} of plan "${entry.planId}" has a buy in flight`);
    }
    const held = heldRun(entry, input.slot);
    const run: DcaRun = {
      slot: input.slot,
      at: input.at,
      status: "skipped",
      amountIn: held?.amountIn ?? input.amountIn.toString(),
      hashes: [],
      reason: input.reason,
      codes: [input.code, ...(held?.codes ?? []).filter((c) => c !== input.code)],
      ...(held?.divergenceBps === undefined ? {} : { divergenceBps: held.divergenceBps }),
      ...(held?.feeRate === undefined ? {} : { feeRate: held.feeRate }),
    };
    const runs = held ? replaceRun(entry.runs, (r) => r === held, run)! : trim([...entry.runs, run]);
    return { ...entry, lastSlot: input.slot, lastAttemptAt: input.at, runs };
  });
}

/**
 * Answer a held buy with "skip" (the owner chose), or "expire" (nobody
 * answered before the window ended). Either way the window is used.
 */
export function resolveHeld(
  ledger: DcaLedger,
  ref: EntryRef,
  input: { slot: number; outcome: "skip" | "expire"; at: number },
): DcaLedger {
  const entry = entryOf(ledger, ref);
  if (!entry) throw new LedgerEntryMissingError(ref);
  const held = heldRun(entry, input.slot);
  if (!held) throw new RunStateError(`plan "${ref.planId}" has no held buy for window ${input.slot}`);
  return closeWindow(ledger, ref, {
    slot: input.slot,
    code: input.outcome === "skip" ? RUN_CODES.SKIPPED_BY_USER : RUN_CODES.HELD_EXPIRED,
    reason:
      input.outcome === "skip"
        ? "skipped by you after it was held"
        : "held for a check and not approved before its buy time ended",
    amountIn: BigInt(held.amountIn),
    at: input.at,
  });
}

/**
 * One history entry for buy times that passed unseen — spDEX was closed — so
 * the history says so instead of silently jumping. Does not touch `lastSlot`
 * (nothing was claimed); the windows are in the past and cannot be bought in.
 */
export function recordMissed(
  ledger: DcaLedger,
  ref: EntryRef,
  input: { fromSlot: number; toSlot: number; at: number },
): DcaLedger {
  if (!isCount(input.fromSlot) || !isCount(input.toSlot) || input.toSlot < input.fromSlot) {
    throw new RunStateError(`windows ${input.fromSlot}–${input.toSlot} are not a range`);
  }
  const missed = input.toSlot - input.fromSlot + 1;
  return withEntry(ledger, ref, (entry) => ({
    ...entry,
    runs: trim([
      ...entry.runs,
      {
        slot: input.toSlot,
        at: input.at,
        status: "skipped",
        amountIn: "0",
        hashes: [],
        reason: `${missed} buy time${missed === 1 ? "" : "s"} passed while spDEX wasn't running — skipped, not made up`,
        codes: [RUN_CODES.MISSED],
        missed,
      },
    ]),
  }));
}

/** Note which window the runner last looked at the plan in, and whether it could buy then. */
export function markSeen(ledger: DcaLedger, ref: EntryRef, seen: { slot: number; active: boolean }): DcaLedger {
  return withEntry(ledger, ref, (entry) => ({ ...entry, lastSeen: { slot: seen.slot, active: seen.active } }));
}

/**
 * Whether a plan's `startAt` may still be moved — the first buy happens when a
 * plan actually starts, not when it was written down.
 *
 * Only while no window has been used. Windows are numbered from `startAt` and
 * `lastSlot` counts in that numbering, so moving it after a claim, a skip or an
 * unconfirmed window would renumber what the record says was used — and could
 * open again a window that already had its buy.
 */
export function canMoveStart(entry: DcaLedgerEntry | undefined): boolean {
  return entry === undefined || entry.lastSlot === null;
}

/**
 * Put back a claim the record lost, and stop the plan.
 *
 * For the runner only, when it goes to record what became of a buy it
 * claimed and the claim is not there: something wrote over the record in
 * between (another tab writing from an out-of-date copy is the one way this
 * code knows of). Money may have moved for that buy, so its window and its
 * spending go back in — the window used, `committed` raised by the claim —
 * before anything else is recorded. The plan is then stopped with `reason`,
 * because a record that changed under a buy is one a person should look at
 * before the next.
 *
 * Changes nothing when the claim is still there. A plan whose record is gone
 * altogether (deleted) cannot be given it back; that throws.
 */
export function reinstateClaim(ledger: DcaLedger, ref: EntryRef, run: DcaRun, reason: string): DcaLedger {
  if (run.status !== "pending" && run.status !== "unknown") {
    throw new RunStateError(`only an unsettled buy can be put back, not a ${run.status} one`);
  }
  return withEntry(ledger, ref, (entry) => {
    const present = entry.runs.find(
      (r) => r.slot === run.slot && (r.status === "pending" || r.status === "unknown"),
    );
    if (present) return entry;
    const other = unsettledRun(entry);
    if (other) {
      throw new RunStateError(
        `plan "${entry.planId}" has another unsettled buy (window ${other.slot}); window ${run.slot}'s cannot be put back beside it`,
      );
    }
    const withoutWindow = entry.runs.filter((r) => !(r.slot === run.slot && r.status === "held"));
    return {
      ...entry,
      lastSlot: entry.lastSlot === null || entry.lastSlot < run.slot ? run.slot : entry.lastSlot,
      committed: (BigInt(entry.committed) + BigInt(run.amountIn)).toString(),
      halted: reason,
      runs: trim([...withoutWindow, { ...run, hashes: [...run.hashes], ...(run.steps ? { steps: [...run.steps] } : {}) }]),
    };
  });
}

/** Clear a stop and start counting failures again. The owner's decision, from the Resume button. */
export function resume(ledger: DcaLedger, ref: EntryRef): DcaLedger {
  return withEntry(ledger, ref, (entry) => {
    const { halted: _halted, ...rest } = entry;
    return { ...rest, consecutiveFailures: 0 };
  });
}

// ── Storage ───────────────────────────────────────────────────────────────

/** The part of `Storage` this needs; injected so tests run without a DOM. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where `storage` events arrive from: `window`, in the app. */
export interface StorageEventSource {
  addEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
}

/**
 * The part of the Web Locks API the store uses: `navigator.locks` in the app.
 * (runner.ts's `LockManagerLike` is the same API; a real `LockManager` is both.)
 */
export interface LedgerLocks {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

/** The ledger lock was not granted in time: the leading tab is in the middle of a buy. Nothing was written. */
export class LedgerBusyError extends LedgerError {
  constructor() {
    super("spDEX is in the middle of an auto-buy; nothing was changed. Try again once it has finished");
    this.name = "LedgerBusyError";
  }
}

/** How long a UI write waits for the ledger lock by default. */
export const LEDGER_WAIT_MS = 15_000;

/**
 * Read-modify-write over one localStorage key.
 *
 * `read()` never throws and never invents: it answers the ledger, or
 * `"unavailable"`. `update()` throws rather than writing over something it
 * could not read — the thing it cannot read might be a claim — and writes
 * nothing when the change changes nothing.
 *
 * `update()` itself takes no lock; it is what the runner calls while it holds
 * the ledger lock through `exclusive()`. Everything else — the UI's
 * `startEntry`, `bindToOwner`, `resume`, `removeEntry` — goes through
 * `updateShared()`, which waits for that lock, so it is never made from a copy
 * of the record taken while a buy was being recorded.
 */
export class LedgerStore {
  readonly #storage: StorageLike | null;
  readonly #key: string;
  readonly #listeners = new Set<() => void>();
  readonly #events: StorageEventSource | null;
  readonly #locks: LedgerLocks | null;
  readonly #onStorage = (event: { key: string | null }) => {
    // null key: the whole of storage was cleared.
    if (event.key === this.#key || event.key === null) this.#notify();
  };

  constructor(
    storage: StorageLike | null,
    options: { key?: string; events?: StorageEventSource | null; locks?: LedgerLocks | null } = {},
  ) {
    this.#storage = storage;
    this.#key = options.key ?? LEDGER_KEY;
    this.#events = options.events === undefined ? defaultEvents() : options.events;
    this.#events?.addEventListener("storage", this.#onStorage);
    this.#locks = options.locks === undefined ? defaultLocks() : options.locks;
  }

  read(): DcaLedger | "unavailable" {
    if (!this.#storage) return "unavailable";
    let raw: string | null;
    try {
      raw = this.#storage.getItem(this.#key);
    } catch {
      return "unavailable";
    }
    if (raw === null) return emptyLedger();
    try {
      return parseLedger(JSON.parse(raw)) ?? "unavailable";
    } catch {
      return "unavailable";
    }
  }

  /** Apply a transition and write the result. Throws the transition's error, or if storage fails. */
  update(change: (ledger: DcaLedger) => DcaLedger): DcaLedger {
    const current = this.read();
    if (current === "unavailable") throw new LedgerUnavailableError();
    const next = change(current);
    if (next === current) return current;
    const serialised = JSON.stringify(next);
    // A new object with the same content is no change either, and not
    // writing it is what keeps an idempotent call from writing back a copy.
    if (serialised === JSON.stringify(current)) return current;
    // Throws if storage refuses (quota, disabled): the caller must not act on
    // a claim that was never written.
    this.#storage!.setItem(this.#key, serialised);
    this.#notify();
    return next;
  }

  /**
   * `update()` under the ledger lock: every write the UI makes.
   *
   * Waits for the lock — held by the leading tab's runner across a whole look
   * or buy — for up to `timeoutMs`, then throws `LedgerBusyError` having
   * written nothing. Without Web Locks it writes directly: that browser runs
   * no auto-buys, so there is no claim to lose.
   */
  async updateShared(
    change: (ledger: DcaLedger) => DcaLedger,
    options: { timeoutMs?: number } = {},
  ): Promise<DcaLedger> {
    const locks = this.#locks;
    if (!locks) return this.update(change);
    const abort = new AbortController();
    let granted = false;
    const timer = setTimeout(() => {
      if (!granted) abort.abort();
    }, options.timeoutMs ?? LEDGER_WAIT_MS);
    let result: DcaLedger | undefined;
    try {
      await locks.request(LEDGER_LOCK, { signal: abort.signal }, () => {
        granted = true;
        clearTimeout(timer);
        result = this.update(change);
      });
    } catch (error) {
      if (!granted) throw new LedgerBusyError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return result!;
  }

  /**
   * Run `task` holding the ledger lock, for the runner: a look or a button
   * press, claim to settlement, with no other tab's write in between.
   * Without Web Locks it just runs (and the runner runs nothing there).
   */
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const locks = this.#locks;
    if (!locks) return task();
    let result: { value: T } | undefined;
    await locks.request(LEDGER_LOCK, {}, async () => {
      result = { value: await task() };
    });
    if (!result) throw new LedgerError("the ledger lock was released before its task finished");
    return result.value;
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

function defaultLocks(): LedgerLocks | null {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const locks: LedgerLocks | undefined = nav?.locks;
  return locks ?? null;
}

function defaultEvents(): StorageEventSource | null {
  const target = globalThis as unknown as Partial<StorageEventSource>;
  return typeof target.addEventListener === "function" && typeof target.removeEventListener === "function"
    ? (target as StorageEventSource)
    : null;
}

/** The page's localStorage, or null where there is none (or touching it throws). */
export function browserStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}
