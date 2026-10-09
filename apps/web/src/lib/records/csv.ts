/**
 * Your activity as a spreadsheet file: `spdex-activity-v1`.
 *
 * - **Machine format, whatever the page's number style:** "." as the decimal
 *   mark, no grouping, every digit of every amount, dates in UTC. A file is
 *   read by software (a spreadsheet, a tax tool) that doesn't know which
 *   number style the page was in.
 * - **Blank means unknown.** A missing amount, fee or value is an empty cell,
 *   never 0, and `*_measured` says whether an amount was read from the chain
 *   or taken from what was signed.
 * - **Values at the time are per row.** There is no average cost, no price
 *   per SPX, anywhere: a tax tool works those out from the rows, and spDEX
 *   keeps no price history.
 * - **Who made a vault buy** is in the last four columns, added after the
 *   first twenty so a reader of those reads them as before: `made_by` (`you`,
 *   `fee-returned-to-you`, `community-keeper`, `anyone-after-window`, or
 *   `keeper` for a v1 vault), `caller` (the address that called `execute`:
 *   the owner, a keeper, or a batcher calling for whoever sent it the batch),
 *   `fee_paid_to` and `due_since_utc` (v2 vaults only; blank for v1, whose
 *   log doesn't say them).
 * - **Safe to open.** Plan names are anyone's text, and arrive in shared
 *   settings links, so a cell a spreadsheet would run as a formula (one
 *   starting with `=`, `+`, `-`, `@`, a tab or a line break) is written with
 *   a leading `'`, and every cell is quoted as RFC 4180 says.
 *
 * No row is a note: what the file doesn't list is said on screen and on the
 * printed statement, since a trailing line of prose breaks the parsers the
 * file is for.
 */

import type { Address } from "@spdex/core";
import type { BuyMaker } from "@spdex/vault";
import { checksumAddress } from "../culture/contract.js";
import { tokenFor } from "../dca/format.js";
import type { CurrencyCode } from "../money/pricing.js";
import { TOKEN_LIST, type TokenInfo } from "../tokens.js";
import type { RecordRow } from "./types.js";
import { rowValueIn } from "./values.js";

export const CSV_FORMAT = "spdex-activity-v1";

export const CSV_COLUMNS = [
  "date_utc",
  "date_source",
  "kind",
  "network",
  "account",
  "sold_token",
  "sold_amount",
  "sold_measured",
  "bought_token",
  "bought_amount",
  "bought_measured",
  "buy_fee_eth",
  "network_fee_eth",
  "value_usd_at_time",
  "value_local_at_time",
  "local_currency",
  "value_source",
  "plan",
  "tx_hash",
  "block",
  "made_by",
  "caller",
  "fee_paid_to",
  "due_since_utc",
] as const;

/** `made_by`, for software: the words Your activity says, as fixed values. */
const MADE_BY: Readonly<Record<BuyMaker, string>> = {
  owner: "you",
  returned: "fee-returned-to-you",
  community: "community-keeper",
  open: "anyone-after-window",
  caller: "keeper",
};

/** Every digit, "." for the mark, no grouping, trailing zeros dropped: "0.0081589", "6912.3", "20". */
export function machineAmount(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = fraction === "" ? (abs / scale).toString() : `${abs / scale}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** "2026-09-17T21:49:23Z". */
export function utcDate(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Characters a spreadsheet takes as the start of a formula, and the line breaks some treat alike. */
const FORMULA_LEAD = /^[=+\-@\t\r\n]/;

/** One cell: neutralised if a spreadsheet would run it, then quoted when it needs to be. */
export function csvCell(text: string): string {
  const safe = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function tokenCells(token: Address, amount: bigint | null, measured: boolean, tokens: readonly TokenInfo[]): string[] {
  const info = tokenFor(token, tokens);
  // An unlisted token is named by its address, and without its decimals no amount can be written.
  return [
    info?.symbol ?? token,
    info === undefined || amount === null ? "" : machineAmount(amount, info.decimals),
    String(measured),
  ];
}

function rowCells(row: RecordRow, currency: CurrencyCode, tokens: readonly TokenInfo[]): string[] {
  const local = currency === "USD" ? null : rowValueIn(row, currency);
  const eth = (wei: bigint | null) => (wei === null ? "" : machineAmount(wei, 18));
  return [
    utcDate(row.at.unix),
    row.at.source,
    row.kind,
    String(row.chainId),
    row.account === null ? "" : checksumAddress(row.account),
    // Buy fees received sold nothing: blank, as the statement shows them,
    // rather than "sold 0 WETH", which reads as a trade.
    ...(row.kind === "buy-fees-earned" ? ["", "", ""] : tokenCells(row.sold.token, row.sold.amount, row.sold.measured, tokens)),
    // A tip bought nothing, and "bought 0 SPX" would read as a trade.
    ...(row.kind === "tip" ? ["", "", ""] : tokenCells(row.bought.token, row.bought.amount, row.bought.measured, tokens)),
    eth(row.buyFee),
    eth(row.networkFee),
    row.valueUsd === null ? "" : machineAmount(row.valueUsd, 6),
    local === null ? "" : machineAmount(local.minor6, 6),
    currency === "USD" ? "" : currency,
    row.valueSource ?? "",
    row.planLabel ?? "",
    row.hashes.join(" "),
    row.block === null ? "" : row.block.toString(),
    ...vaultBuyCells(row),
  ];
}

/** A vault buy's `made_by`, `caller`, `fee_paid_to` and `due_since_utc`; blank for any other row, and for what isn't known. */
function vaultBuyCells(row: RecordRow): string[] {
  const buy = row.vaultBuy;
  if (buy === undefined) return ["", "", "", ""];
  return [
    buy.maker === null ? "" : MADE_BY[buy.maker],
    buy.caller === null ? "" : checksumAddress(buy.caller),
    buy.rewardTo === null ? "" : checksumAddress(buy.rewardTo),
    buy.dueSince === null ? "" : utcDate(buy.dueSince),
  ];
}

/**
 * The file's text: the header, then one line per row, CRLF-ended.
 * `currency` is the one chosen at export; its column is empty for dollars,
 * which already have theirs.
 */
export function recordsCsv(rows: readonly RecordRow[], currency: CurrencyCode, tokens: readonly TokenInfo[] = TOKEN_LIST): string {
  const lines = [CSV_COLUMNS.join(","), ...rows.map((row) => rowCells(row, currency, tokens).map(csvCell).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/** "spdex-activity-1-ab12cd-2026-09-27.csv": the network, the address's first six characters, and today's date here. */
export function csvFileName(chainId: number, account: string, today: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return `spdex-activity-${chainId}-${account.slice(2, 8).toLowerCase()}-${date}.csv`;
}
