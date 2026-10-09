/**
 * The spending limit, enforced where a transaction leaves: nothing the
 * harness signs is sent, or handed back to the page to send, until it fits.
 *
 * "Spent" is every wei a transaction can take out of an agent wallet: its
 * value, and its gas limit at the highest price it bids. Ether that comes back
 * later (a vault closed, a token sold, a buy fee earned) is not credited, so
 * the figure is never below what really left. Once a transaction is mined,
 * its real cost replaces that ceiling.
 *
 * Two files, both append-only JSON lines. The run's file
 * (`.mainnet-smoke/runs/<id>.jsonl`, in the repo, gitignored) holds this run
 * and its summary. On mainnet, the ledger in `SPDEX_SMOKE_HOME` holds every
 * run, and its last 24 hours are held to `SPDEX_SMOKE_MAX_DAY_ETH`. A fork's
 * ether is not real, so a fork run writes only its own file.
 *
 * Both are read again at every check, so the limit holds across Playwright's
 * worker processes, and across a worker restarted after a failure.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNS_DIR, currentRun, eth, type SmokeRun, type SmokeSettings } from "./settings.js";

export interface Signed {
  kind: "signed";
  at: string;
  run: string;
  /** Which test, and which step of it. */
  what: string;
  wallet: string;
  hash: string;
  to: string;
  value: string;
  /** value + gas limit × the highest price per gas it bids. */
  maxCost: string;
}

export interface Settled {
  kind: "settled";
  at: string;
  hash: string;
  status: "success" | "reverted";
  gasUsed: string;
  /** value + gas used × the price paid: what really left. */
  cost: string;
}

type Line = Signed | Settled;

export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
}

export const runFile = (run: Pick<SmokeRun, "id">) => join(RUNS_DIR, `${run.id}.jsonl`);
export const ledgerFile = (home: string) => join(home, "ledger.jsonl");

function read(path: string): Line[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
}

function append(path: string, line: Line): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Each signed transaction, with what it cost if it settled, else its ceiling. */
export function spentIn(lines: Line[], since?: number): { total: bigint; signed: (Signed & { settled?: Settled })[] } {
  const settled = new Map(lines.filter((l): l is Settled => l.kind === "settled").map((l) => [l.hash, l]));
  const signed = lines
    .filter((l): l is Signed => l.kind === "signed")
    .filter((l) => since === undefined || Date.parse(l.at) >= since)
    .map((l) => ({ ...l, ...(settled.has(l.hash) ? { settled: settled.get(l.hash)! } : {}) }));
  const total = signed.reduce((sum, l) => sum + BigInt(l.settled ? l.settled.cost : l.maxCost), 0n);
  return { total, signed };
}

export interface BudgetView {
  run: bigint;
  /** Mainnet only; null on a fork. */
  day: bigint | null;
}

export function budgetView(settings: SmokeSettings, run: SmokeRun): BudgetView {
  return {
    run: spentIn(read(runFile(run))).total,
    day: run.mode === "mainnet" ? spentIn(read(ledgerFile(settings.home)), Date.now() - 24 * 3_600_000).total : null,
  };
}

/**
 * Throws `BudgetExceeded` unless `cost` more fits the run's and the last 24
 * hours' limits. For a send the harness doesn't sign itself (the keeper's),
 * checked against its worst case before it can happen.
 */
export function assertRoom(settings: SmokeSettings, cost: bigint, what: string): void {
  const spent = budgetView(settings, currentRun());
  if (spent.run + cost > settings.maxRunWei) {
    throw new BudgetExceeded(
      `${what}: up to ${eth(cost)} ETH would take this run to ${eth(spent.run + cost)} ETH, past SPDEX_SMOKE_MAX_RUN_ETH (${eth(settings.maxRunWei)})`,
    );
  }
  if (spent.day !== null && spent.day + cost > settings.maxDayWei) {
    throw new BudgetExceeded(
      `${what}: up to ${eth(cost)} ETH would take the last 24 hours to ${eth(spent.day + cost)} ETH, past SPDEX_SMOKE_MAX_DAY_ETH (${eth(settings.maxDayWei)})`,
    );
  }
}

/**
 * Record a signed transaction before it is sent, or refuse it: throws
 * `BudgetExceeded`, and nothing is recorded, when its ceiling would take
 * the run or the last 24 hours past their limit.
 */
export function reserve(settings: SmokeSettings, entry: Omit<Signed, "kind" | "at" | "run">): void {
  const run = currentRun();
  assertRoom(settings, BigInt(entry.maxCost), entry.what);
  const line: Signed = { kind: "signed", at: new Date().toISOString(), run: run.id, ...entry };
  append(runFile(run), line);
  if (run.mode === "mainnet") append(ledgerFile(settings.home), line);
}

/** Replace a transaction's ceiling with what it cost, once it is mined. */
export function settle(settings: SmokeSettings, entry: Omit<Settled, "kind" | "at">): void {
  const run = currentRun();
  if (read(runFile(run)).some((l) => l.kind === "settled" && l.hash === entry.hash)) return;
  const line: Settled = { kind: "settled", at: new Date().toISOString(), ...entry };
  append(runFile(run), line);
  if (run.mode === "mainnet") append(ledgerFile(settings.home), line);
}

/** This run's signed transactions, with what each cost where it settled. */
export function runRecord(run: Pick<SmokeRun, "id">): (Signed & { settled?: Settled })[] {
  return spentIn(read(runFile(run))).signed;
}

/** The ledger's last 24 hours, for the global setup's check before anything runs. */
export function lastDaySpent(settings: SmokeSettings): bigint {
  return spentIn(read(ledgerFile(settings.home)), Date.now() - 24 * 3_600_000).total;
}
