/**
 * Your stack: the SPX a wallet holds, what spDEX has stacked for it, and what
 * went in, worked out from this browser's records and the vaults' own state.
 *
 * What it will not show is as deliberate as what it shows:
 * - **No current value, gain or loss, and no price.** "What is my SPX worth"
 *   is a price chart with one point on it, and "THERE IS NO CHART". The one
 *   money figure is what went in, valued when it went in, as each record kept
 *   it: a fact about the past, never re-priced.
 * - **No average cost.** A cost per SPX is a price per SPX kept forever.
 * - **No projections,** which would need a price forecast.
 *
 * Every figure follows the app's rule, unknown is never zero: an amount that
 * couldn't be read is left out and the total says "at least", a buy with no
 * value at the time is counted as unpriced, and nothing becomes 0 by default.
 *
 * Vault figures come from each vault's own counters (`totalOut`, `buysDone`),
 * which are exact, rather than from its logs, which a network service may
 * serve only in part. A vault's history rows supply dates, and values where
 * a row has one, but never amounts, so no buy is counted twice.
 */

import { TOKENS } from "@spdex/chain";
import type { Address } from "@spdex/core";
import type { CurrencyCode, FiatAmount } from "../money/pricing.js";
import type { RecordRow } from "../records/types.js";
import { formatAmount, NATIVE_ETH, TOKEN_LIST } from "../tokens.js";
import type { Pref } from "../prefs.js";
import { formatCount, formatFiat } from "../money/format.js";
import { rowValueIn } from "../records/values.js";

const SPX = TOKENS.SPX.address.toLowerCase();
const WETH = TOKENS.WETH.address.toLowerCase();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One vault plan of the account's, as the auto-buy panel reads it (`readVault`). */
export interface StackVault {
  vault: Address;
  totalOut: bigint;
  buysDone: bigint;
  amountPerBuy: bigint;
  keeperReward: bigint;
  tokenOut: Address;
}

/** A plan whose oldest buys this browser no longer lists (the ledger keeps the latest 100). */
export interface TruncatedPlan {
  planLabel: string;
  missing: number;
}

export interface StackInput {
  account: Address;
  chainId: number;
  rows: readonly RecordRow[];
  vaults: readonly StackVault[];
  truncated: readonly TruncatedPlan[];
  /**
   * Vault plans whose vault couldn't be read (`unreadVaults`), so aren't in
   * `vaults`: what they bought isn't counted, and the totals say "at least".
   */
  unreadVaults?: number;
}

/** An amount, and whether some of it couldn't be counted. */
export interface Counted {
  amount: bigint;
  atLeast: boolean;
}

/** What went in, in one token. Native ETH and WETH are one entry: WETH is ETH as a token, one for one. */
export interface PutInToken {
  symbol: string;
  decimals: number;
  amount: bigint;
}

export interface StackSummary {
  /** SPX delivered to the wallet: every buy recorded here, and every vault's `totalOut`. Gross of anything sold. */
  stacked: Counted;
  buys: { total: number; swaps: number; planBuys: number; vaultBuys: number };
  /** SPX sold in One-time swaps recorded here; null when none was. */
  soldSpx: Counted | null;
  putIn: { tokens: PutInToken[]; atLeast: boolean };
  /** The value at the time of what went in, summed over the buys that have one, in USD millionths, with the rows that carry it. */
  priced: { rows: RecordRow[]; count: number };
  /** Buy fees the vaults paid, in wei (Σ buysDone × keeperReward); 0n with no vaults. */
  vaultFees: bigint;
  /** The earliest buy recorded here, unix seconds; null when no dated buy is. */
  firstBuyAt: number | null;
  /** The newest buy a card can be made of; null when there's none. */
  latest: RecordRow | null;
  /** Sentences on what was left out and why. */
  notes: string[];
}

/** A buy of SPX, made by this account on this chain: the rows Your stack counts. */
function isSpxBuy(row: RecordRow, input: StackInput): boolean {
  return (
    (row.kind === "swap" || row.kind === "plan-buy" || row.kind === "vault-buy") &&
    row.chainId === input.chainId &&
    row.account !== null &&
    same(row.account, input.account) &&
    same(row.bought.token, SPX)
  );
}

const known = (leg: RecordRow["bought"]): bigint | null => (leg.measured && leg.amount !== null ? leg.amount : null);

export function summariseStack(input: StackInput): StackSummary {
  const buys = input.rows.filter((row) => isSpxBuy(row, input));
  // Vault buys are counted from the vaults' own counters, never from their rows.
  const walletBuys = buys.filter((row) => row.kind !== "vault-buy");
  const vaults = input.vaults.filter((v) => same(v.tokenOut, SPX));
  const notes: string[] = [];

  let stacked = 0n;
  let unknownOut = 0;
  for (const row of walletBuys) {
    const amount = known(row.bought);
    if (amount === null) unknownOut++;
    else stacked += amount;
  }
  for (const v of vaults) stacked += v.totalOut;
  if (unknownOut > 0) notes.push(`${plural(unknownOut, "buy's", "buys'")} SPX couldn't be read, so ${unknownOut === 1 ? "it isn't" : "they aren't"} counted.`);

  const putIn = new Map<string, PutInToken>();
  const add = (token: string, amount: bigint) => {
    const info = putInToken(token);
    const entry = putIn.get(info.symbol) ?? { ...info, amount: 0n };
    entry.amount += amount;
    putIn.set(info.symbol, entry);
  };
  let unknownIn = 0;
  for (const row of walletBuys) {
    if (row.sold.amount === null) unknownIn++;
    else add(row.sold.token, row.sold.amount);
  }
  for (const v of vaults) if (v.buysDone > 0n) add(WETH, v.buysDone * v.amountPerBuy);
  if (unknownIn > 0) notes.push(`What ${plural(unknownIn, "buy", "buys")} spent couldn't be read, so it isn't counted in Put in.`);

  for (const plan of input.truncated) {
    if (plan.missing > 0) {
      const first = plan.missing === 1 ? "The first buy" : `The first ${formatCount(plan.missing)} buys`;
      notes.push(`${first} of “${plan.planLabel}” ${plan.missing === 1 ? "isn't" : "aren't"} listed in this browser any more, so ${plan.missing === 1 ? "it isn't" : "they aren't"} counted here.`);
    }
  }
  const truncated = input.truncated.some((p) => p.missing > 0);
  // Unknown is never zero: a vault that couldn't be read may have bought for months.
  const unread = input.unreadVaults ?? 0;
  if (unread > 0) {
    notes.push(`${plural(unread, "vault", "vaults")} couldn't be read just now, so what ${unread === 1 ? "it" : "they"} bought isn't counted.`);
  }

  const sold = input.rows.filter(
    (row) =>
      row.kind === "swap" &&
      row.chainId === input.chainId &&
      row.account !== null &&
      same(row.account, input.account) &&
      same(row.sold.token, SPX),
  );
  let soldSpx: Counted | null = null;
  if (sold.length > 0) {
    soldSpx = { amount: 0n, atLeast: false };
    for (const row of sold) {
      if (row.sold.amount === null) soldSpx.atLeast = true;
      else soldSpx.amount += row.sold.amount;
    }
  }

  const vaultBuys = vaults.reduce((n, v) => n + Number(v.buysDone), 0);
  const swaps = walletBuys.filter((r) => r.kind === "swap").length;
  const planBuys = walletBuys.filter((r) => r.kind === "plan-buy").length;
  const total = swaps + planBuys + vaultBuys;

  const priced = buys.filter((row) => row.valueUsd !== null);
  const dated = buys.map((row) => row.at.unix).filter((t) => Number.isFinite(t) && t > 0);
  const cardable = buys.filter(canCard).sort((a, b) => b.at.unix - a.at.unix);

  return {
    stacked: { amount: stacked, atLeast: unknownOut > 0 || truncated || unread > 0 },
    buys: { total, swaps, planBuys, vaultBuys },
    soldSpx,
    putIn: {
      tokens: [...putIn.values()].sort((a, b) => order(a.symbol) - order(b.symbol)),
      atLeast: unknownIn > 0 || truncated || unread > 0,
    },
    // A vault's rows can't outnumber its buys; if a history ever lists more, the extra can't be counted.
    priced: { rows: priced, count: Math.min(priced.length, total) },
    vaultFees: vaults.reduce((sum, v) => sum + v.buysDone * v.keeperReward, 0n),
    firstBuyAt: dated.length > 0 ? Math.min(...dated) : null,
    latest: cardable[0] ?? null,
    notes,
  };
}

/** Whether a row can be made into an "I bought" card: SPX a pool or a vault delivered, measured on chain. */
export function canCard(row: RecordRow): boolean {
  return (
    (row.kind === "swap" || row.kind === "plan-buy" || row.kind === "vault-buy") &&
    same(row.bought.token, SPX) &&
    row.bought.measured &&
    row.bought.amount !== null &&
    row.bought.amount > 0n &&
    row.hashes.length > 0
  );
}

function putInToken(token: string): Omit<PutInToken, "amount"> {
  if (same(token, NATIVE_ETH.address) || same(token, WETH)) return { symbol: "ETH", decimals: 18 };
  const info = TOKEN_LIST.find((t) => same(t.address, token));
  return info ? { symbol: info.symbol, decimals: info.decimals } : { symbol: `${token.slice(0, 6)}…`, decimals: 18 };
}

const ORDER = ["ETH", "USDC"];
const order = (symbol: string) => (ORDER.includes(symbol) ? ORDER.indexOf(symbol) : ORDER.length);

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

// ─── Words ────────────────────────────────────────────────────────────────────

/**
 * An SPX amount for display: two decimals from 1 SPX up, all eight below.
 * Cut, never rounded, so a figure never claims more than the wallet got.
 */
export function spxText(amount: bigint): string {
  const places = amount >= 10n ** 8n ? 2 : 8;
  return `${formatAmount(amount, 8, { maxFraction: places })} SPX`;
}

/** "0.84 ETH · 120 USDC", or "nothing yet". */
export function putInText(tokens: readonly PutInToken[]): string {
  const parts = tokens.filter((t) => t.amount > 0n).map((t) => `${formatAmount(t.amount, t.decimals, { maxFraction: 6 })} ${t.symbol}`);
  return parts.length > 0 ? parts.join(" · ") : "nothing yet";
}

/**
 * "23 buys: 3 swaps, 12 plan buys you confirmed, 8 vault buys"; parts with
 * none are left out, and so is the breakdown when every buy is of one kind
 * ("3 buys").
 */
export function buysText(buys: StackSummary["buys"]): string {
  if (buys.total === 0) return "None recorded in this browser yet";
  const parts = [
    buys.swaps > 0 ? plural(buys.swaps, "swap", "swaps") : null,
    buys.planBuys > 0 ? `${plural(buys.planBuys, "plan buy", "plan buys")} you confirmed` : null,
    buys.vaultBuys > 0 ? plural(buys.vaultBuys, "vault buy", "vault buys") : null,
  ].filter((p): p is string => p !== null);
  const total = plural(buys.total, "buy", "buys");
  return parts.length > 1 ? `${total}: ${parts.join(", ")}` : total;
}

// ─── Value at the time ────────────────────────────────────────────────────────

/**
 * A row's value at the time in `currency`, from the rates the row itself
 * kept. Null when the row has no value, or when it didn't hold a usable rate
 * for that currency then: a rate is never borrowed from another time.
 */
export function valueAtTheTime(row: Pick<RecordRow, "valueUsd" | "rates">, currency: CurrencyCode): FiatAmount | null {
  return rowValueIn(row, currency);
}

export interface PutInValue {
  /** The sum, in `currency`, or in USD when some priced buy held no rate for it. */
  value: FiatAmount;
  /** Buys with a value at the time, and every buy counted. */
  priced: number;
  of: number;
  /** True when the sum fell back to dollars (the chosen currency's rate wasn't held for every priced buy). */
  inDollars: boolean;
}

/**
 * What went in, valued at the time of each buy, over the buys that were
 * priced then. Null when none was. When a priced buy didn't hold the chosen
 * currency's rate, the whole sum is given in dollars instead: two currencies
 * can't be added, and a buy dropped for a missing rate would shrink the sum
 * without saying so.
 */
export function putInValue(summary: StackSummary, currency: CurrencyCode): PutInValue | null {
  const { rows, count } = summary.priced;
  if (rows.length === 0) return null;
  const local = rows.map((row) => valueAtTheTime(row, currency));
  const inDollars = local.some((v) => v === null);
  const target: CurrencyCode = inDollars ? "USD" : currency;
  const minor6 = inDollars
    ? rows.reduce((sum, row) => sum + (row.valueUsd ?? 0n), 0n)
    : local.reduce((sum, v) => sum + (v?.minor6 ?? 0n), 0n);
  return { value: { minor6, currency: target }, priced: count, of: summary.buys.total, inDollars };
}

/** The Put in hint: "≈ €1,820 at the time of each buy", or for only some. Null when no buy was priced. */
export function putInValueText(value: PutInValue | null, locale: string, chosen: CurrencyCode): string | null {
  if (value === null) return null;
  // The one place Your stack shows money, written as every money figure in spDEX is.
  const money = formatFiat(value.value, locale);
  const unpriced = value.of - value.priced;
  const base =
    unpriced <= 0
      ? `≈ ${money} at the time of each buy`
      : `≈ ${money} for ${formatCount(value.priced)} of ${plural(value.of, "buy", "buys")}; the other ${formatCount(unpriced)} ${unpriced === 1 ? "wasn't" : "weren't"} priced at the time`;
  return value.inDollars && chosen !== "USD" ? `${base} (in dollars: a ${chosen} rate wasn't kept for every buy)` : base;
}

/** "Before fees", or "Before fees: 0.0012 ETH in vault buy fees, and network fees" when a vault paid some. */
export function feesText(vaultFees: bigint): string {
  return vaultFees > 0n ? `Before fees: ${formatAmount(vaultFees, 18, { maxFraction: 6 })} ETH in vault buy fees, and network fees` : "Before fees";
}

// ─── The goal ─────────────────────────────────────────────────────────────────

/**
 * This browser's stack goal: `{"spx": "6900"}`, whole or decimal SPX in
 * machine format.
 *
 * A browser preference, like the theme, never part of the config: a goal is
 * not an instruction to move money, and it would put a number about someone's
 * holdings into every file they export or link they share.
 */
export const STACK_GOAL_KEY = "spdex.stack.goal.v1";

const GOAL_TEXT = /^(\d{1,12})(?:\.(\d{1,8}))?$/;

/**
 * The goal in SPX base units, or null when none is set or what's stored
 * isn't one. Cleared, it is stored as "null".
 */
export const STACK_GOAL: Pref<bigint | null> = {
  key: STACK_GOAL_KEY,
  parse(raw) {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const spx = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["spx"] : undefined;
    const match = typeof spx === "string" ? GOAL_TEXT.exec(spx) : null;
    if (!match) return null;
    const value = BigInt(match[1]!) * 10n ** 8n + BigInt((match[2] ?? "").padEnd(8, "0"));
    return value > 0n ? value : null;
  },
  format: (goal) =>
    goal === null || goal <= 0n ? "null" : JSON.stringify({ spx: formatAmount(goal, 8, { maxFraction: 8, group: false }) }),
};

export interface GoalProgress {
  /** Whole percent, cut rather than rounded, so 99.9% never reads as 100%; null when the holding is unknown. */
  percent: number | null;
  reached: boolean | null;
}

/** How far the wallet's holding is toward the goal. The goal counts SPX in the wallet, however it got there. */
export function goalProgress(holding: bigint | null, goal: bigint): GoalProgress {
  if (holding === null) return { percent: null, reached: null };
  const reached = holding >= goal;
  return { percent: reached ? 100 : Number((holding * 100n) / goal), reached };
}
