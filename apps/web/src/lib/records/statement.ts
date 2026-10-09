/**
 * The printable statement: what Your activity lists, on paper, for one
 * wallet on one network.
 *
 * Totals are per token, what was sold, bought and tipped, and the buy fees
 * received for making other people's vault buys (Help run the network), kept
 * apart because they are neither a buy nor a sale. Nothing is divided by
 * anything: no average cost, no price per SPX. A total that
 * leaves amounts out says how many ("at least", "3 not known"), and rows
 * whose wallet couldn't be told stay out of every total, as they do on screen.
 *
 * Pure: `Statement.tsx` lays it out, and the page prints it.
 */

import type { Address } from "@spdex/core";
import { checksumAddress } from "../culture/contract.js";
import { formatSignificant, shortAddress, tokenFor } from "../dca/format.js";
import { formatFiat } from "../money/format.js";
import type { CurrencyCode } from "../money/pricing.js";
import { networkLabel } from "../networks.js";
import { formatAmount, TOKEN_LIST, type TokenInfo } from "../tokens.js";
import type { RecordRow } from "./types.js";
import { rowValueShown } from "./values.js";

export const STATEMENT_TITLE = "spDEX activity statement";

/** Said on the statement. */
export const RECORDS_FOOTNOTE =
  "This browser's record, plus what the chain shows for your vaults. The chain is the source of truth. Nothing was uploaded. Not tax advice.";

/** Said under Your activity: the statement's footnote, as short as a screen wants it. */
export const ACTIVITY_FOOTNOTE = "Kept in this browser; nothing uploaded. Not tax advice.";

/** One token's total on one side: what is known, and how many amounts couldn't be. */
export interface SideTotal {
  amount: bigint;
  /** Amounts left out because they are unknown; the total is then "at least". */
  unknown: number;
  /** Rows counted, known or not. */
  rows: number;
}

export interface TokenTotals {
  token: Address;
  /** Null for a token spDEX doesn't list: its amounts can't be written without its decimals. */
  info: TokenInfo | null;
  sold: SideTotal;
  bought: SideTotal;
  tipped: SideTotal;
  /** Buy fees received for making other people's due vault buys: never counted as bought. */
  feesReceived: SideTotal;
}

export interface StatementData {
  title: string;
  /** Checksummed. */
  account: Address;
  network: string;
  /** Unix seconds of the first and last rows counted; null with none. */
  first: number | null;
  last: number | null;
  /** Unix seconds. */
  generatedAt: number;
  totals: TokenTotals[];
  /** The rows counted, newest first. */
  rows: RecordRow[];
  /** What isn't listed or counted, as Your activity says it. */
  notes: string[];
  footnote: string;
  valuesLine: string;
}

const emptySide = (): SideTotal => ({ amount: 0n, unknown: 0, rows: 0 });

function add(side: SideTotal, amount: bigint | null): void {
  side.rows += 1;
  if (amount === null) side.unknown += 1;
  else side.amount += amount;
}

/** "Values at the time are in USD and EUR where known, …". */
export function valuesLine(currency: CurrencyCode): string {
  const which = currency === "USD" ? "USD" : `USD and ${currency}`;
  return `Values at the time are in ${which} where known, from spDEX's 10-minute average price or Chainlink; blank where unknown.`;
}

export function statementOf(input: {
  rows: readonly RecordRow[];
  account: string;
  chainId: number;
  currency: CurrencyCode;
  generatedAt: number;
  notes: readonly string[];
  tokens?: readonly TokenInfo[];
}): StatementData {
  const tokens = input.tokens ?? TOKEN_LIST;
  const mine = input.account.toLowerCase();
  const rows = input.rows.filter((row) => row.chainId === input.chainId && row.account !== null && row.account.toLowerCase() === mine);
  const byToken = new Map<string, TokenTotals>();
  const totalsOf = (token: Address) => {
    const key = token.toLowerCase();
    let totals = byToken.get(key);
    if (!totals) {
      totals = {
        token,
        info: tokenFor(token, tokens) ?? null,
        sold: emptySide(),
        bought: emptySide(),
        tipped: emptySide(),
        feesReceived: emptySide(),
      };
      byToken.set(key, totals);
    }
    return totals;
  };
  for (const row of rows) {
    if (row.kind === "tip") {
      add(totalsOf(row.sold.token).tipped, row.sold.amount);
      continue;
    }
    if (isBuyFeesRow(row)) {
      // Nothing was sold and nothing bought: other people's vaults bought,
      // and this wallet was paid their fees.
      add(totalsOf(row.bought.token).feesReceived, row.bought.amount);
      continue;
    }
    add(totalsOf(row.sold.token).sold, row.sold.amount);
    add(totalsOf(row.bought.token).bought, row.bought.amount);
  }
  const times = rows.map((row) => row.at.unix);
  const unattributed = input.rows.filter((row) => row.account === null).length;
  // The screen's sentence about these rows says "of these", and on paper
  // they aren't listed at all: it is said again, as paper needs it.
  const notes = input.notes.filter((note) => !note.startsWith("Couldn't tell which wallet"));
  if (unattributed > 0) {
    notes.push(
      `Your activity also lists ${unattributed} ${unattributed === 1 ? "row" : "rows"} whose wallet couldn't be told; ${unattributed === 1 ? "it's" : "they're"} left out of this statement.`,
    );
  }
  return {
    title: STATEMENT_TITLE,
    account: checksumAddress(input.account),
    network: networkLabel(input.chainId),
    first: times.length === 0 ? null : Math.min(...times),
    last: times.length === 0 ? null : Math.max(...times),
    generatedAt: input.generatedAt,
    totals: [...byToken.values()],
    rows,
    notes,
    footnote: RECORDS_FOOTNOTE,
    valuesLine: valuesLine(input.currency),
  };
}

// ─── How a row reads, on screen and on paper ──────────────────────────────────

/**
 * A row of buy fees received for making other people's due vault buys (Help
 * run the network). It reads as fees received, never as a buy, a sale or
 * income: its sold side is a known nothing, so it has no "value then".
 */
export function isBuyFeesRow(row: Pick<RecordRow, "kind">): boolean {
  return row.kind === "buy-fees-earned";
}

/** "Swap", "Plan buy", "Vault buy", "Tip", "Buy fees earned". */
export function kindLabel(kind: RecordRow["kind"] | string): string {
  switch (kind) {
    case "swap":
      return "Swap";
    case "tip":
      return "Tip";
    case "plan-buy":
      return "Plan buy";
    case "vault-buy":
      return "Vault buy";
    case "buy-fees-earned":
      // Not a buy: other people's vaults bought, and this wallet was paid their fees.
      return "Buy fees earned";
    default:
      // A kind a later version records reads as itself.
      return String(kind).replace(/-/g, " ");
  }
}

/**
 * Who made a v2 vault buy, in a few words, on screen and on paper: "Made by
 * you", "Made by a community keeper". Null for any other row, and when who
 * made it can't be told, which then goes unsaid rather than guessed.
 *
 * A v1 vault buy (no `rewardTo`) reads as it always has, with no such line:
 * v2 is what asks who made each buy (docs/DESIGN.md, Your activity), and
 * a v1 log tells only who called, which for the owner's own Help run batch is
 * the batcher, not a keeper. The CSV's `made_by` still says it.
 */
export function makerText(row: Pick<RecordRow, "vaultBuy">): string | null {
  if (row.vaultBuy === undefined || row.vaultBuy.rewardTo === null) return null;
  switch (row.vaultBuy.maker) {
    case "owner":
      return "Made by you";
    case "returned":
      // Anyone may name the owner as the one paid: the fee came back, but it wasn't the owner's doing.
      return "Made by someone else; the fee came back to you";
    case "community":
      return "Made by a community keeper";
    case "open":
      return "Made after the community window, when anyone could";
    default:
      return null;
  }
}

/** A statement row's "What": "Vault buy · Daily SPX · made by a community keeper". */
export function statementWhat(row: Pick<RecordRow, "kind" | "planLabel" | "vaultBuy">): string {
  const maker = makerText(row);
  return [kindLabel(row.kind), row.planLabel, maker === null ? undefined : maker.replace(/^Made/, "made")]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** "6,912.3 SPX" to six significant digits, or null when the amount is unknown or the token unlisted. */
export function legAmount(leg: Pick<RecordRow["sold"], "token" | "amount">, tokens: readonly TokenInfo[] = TOKEN_LIST): string | null {
  const info = tokenFor(leg.token, tokens);
  if (info === undefined || leg.amount === null) return null;
  return `${formatSignificant(leg.amount, info.decimals, 6)} ${info.symbol}`;
}

/** "6,912.30000001 SPX", every digit, for paper; null when unknown or unlisted. */
export function legExact(leg: Pick<RecordRow["sold"], "token" | "amount">, tokens: readonly TokenInfo[] = TOKEN_LIST): string | null {
  const info = tokenFor(leg.token, tokens);
  if (info === undefined || leg.amount === null) return null;
  return `${formatAmount(leg.amount, info.decimals, { maxFraction: info.decimals })} ${info.symbol}`;
}

/** A leg's token symbol, or a shortened address for one spDEX doesn't list. */
export function legSymbol(leg: Pick<RecordRow["sold"], "token">, tokens: readonly TokenInfo[] = TOKEN_LIST): string {
  return tokenFor(leg.token, tokens)?.symbol ?? shortAddress(leg.token);
}

/** "Sep 17", with the year when it isn't this one: when a row happened, in this device's time zone. */
export function rowDay(unix: number, nowMs: number, locale?: string): string {
  const date = new Date(unix * 1000);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

/** "2026-09-17 21:49 UTC": a statement's dates, in one time zone for every reader. */
export function utcMinute(unix: number): string {
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Where a row's date came from, for its tooltip. */
export function dateSourceText(row: Pick<RecordRow, "at">): string {
  return row.at.source === "block" ? "The block's time." : "This device's time when it was recorded; the block's time couldn't be read yet.";
}

/** A row's value then, as written: "≈ $20.00", or null when unknown. `fellBack` when shown in dollars for want of the currency's rate then. */
export function valueThen(
  row: Pick<RecordRow, "valueUsd" | "rates">,
  currency: CurrencyCode,
  locale: string,
): { text: string; fellBack: boolean } | null {
  const shown = rowValueShown(row, currency);
  return shown === null ? null : { text: formatFiat(shown.value, locale, { approx: true }), fellBack: shown.fellBack };
}

/** "1,234.5 SPX", with "at least" and the count left out when some amounts are unknown; null when nothing is known. */
export function sideTotalText(side: SideTotal, info: TokenInfo | null): string | null {
  if (side.rows === 0) return null;
  if (info === null) return `${side.rows} row${side.rows === 1 ? "" : "s"}, amounts unknown`;
  if (side.unknown === side.rows) return "unknown";
  const amount = `${formatAmount(side.amount, info.decimals, { maxFraction: info.decimals })} ${info.symbol}`;
  return side.unknown === 0 ? amount : `at least ${amount} (${side.unknown} not known)`;
}
