/**
 * Auto-buy in plain English.
 *
 * Everything a plan card, the recurring form and the history list say about a
 * plan is worded here, once, from the plan and this browser's record of it.
 * Nothing in this file reads a clock, a network or storage: the caller passes
 * `now`, the runs and the token list, so every sentence is a pure function of
 * what it describes and can be pinned by a test.
 *
 * Two rules decide every edge case:
 *
 * - **Unknown is never zero.** A token that is not in the list has no known
 *   decimals, so no amount of it can be written down; it is named as "unknown
 *   token 0x1234…abcd" and the amount is left out rather than guessed. An
 *   average price with nothing measured behind it is `null` (shown as "—"), and
 *   a figure this browser has no record of is `null`, not 0.
 * - **Amounts are exact unless asked otherwise.** A plan's amounts are
 *   figures the user typed, so `amountLabel` shows them to the token's full
 *   precision (trailing zeros trimmed) rather than rounded to six places,
 *   where 0.0000001 ETH would read as "0". The history's sentences take an
 *   `AmountStyle`: `rounded` gives six significant digits, as every other
 *   screen does (a swept balance's eighteen decimals bury the sentence), and
 *   `exact` keeps every digit, for Expert and for a row's tooltip.
 */

import type { DcaPlan } from "@spdex/core";
import { formatAmount, TOKEN_LIST, type TokenInfo } from "../tokens.js";
import { RUN_CODES, type TransferKind } from "./ledger.js";
import { formatCount, formatNumber } from "../money/format.js";
import { PLACES } from "../places.js";

// ── Tokens and amounts ────────────────────────────────────────────────────

/** "0x1234…abcd": enough to recognise an address, short enough for a sentence. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** The listed token at an address, compared lowercase, or undefined. */
export function tokenFor(address: string, tokens: readonly TokenInfo[] = TOKEN_LIST): TokenInfo | undefined {
  const wanted = address.toLowerCase();
  return tokens.find((token) => token.address.toLowerCase() === wanted);
}

/** A token's symbol, or "unknown token 0x1234…abcd" when the list has no entry for it. */
export function tokenLabel(address: string, tokens: readonly TokenInfo[] = TOKEN_LIST): string {
  return tokenFor(address, tokens)?.symbol ?? `unknown token ${shortAddress(address)}`;
}

/**
 * A whole number of base units from a decimal string, or null.
 *
 * Plans and runs carry amounts as decimal strings (bigint does not survive
 * JSON). A string that is not one — a corrupted record, say — is unknown, and
 * `BigInt("")` quietly being 0 is exactly the conversion this refuses.
 */
export function baseUnits(value: string | undefined | null): bigint | null {
  if (typeof value !== "string" || !/^[0-9]{1,78}$/.test(value)) return null;
  return BigInt(value);
}

/**
 * "0.01 ETH", or — for a token the list does not know — "unknown token
 * 0x1234…abcd", with no amount, because without decimals any figure would be
 * made up.
 */
export function amountLabel(
  value: bigint | null,
  address: string,
  tokens: readonly TokenInfo[] = TOKEN_LIST,
): string {
  const token = tokenFor(address, tokens);
  if (!token) return `unknown token ${shortAddress(address)}`;
  if (value === null) return `an unknown amount of ${token.symbol}`;
  return `${formatAmount(value, token.decimals, { maxFraction: token.decimals })} ${token.symbol}`;
}

/** How a history sentence writes an amount: every digit, or six significant ones. */
export type AmountStyle = "exact" | "rounded";

/**
 * An amount in a history sentence. `rounded` is `formatSignificant` to six
 * significant digits — never fewer digits than the value needs to stay
 * nonzero — and falls back to `amountLabel`'s words for an unknown token or
 * amount.
 */
export function amountText(
  value: bigint | null,
  address: string,
  tokens: readonly TokenInfo[] = TOKEN_LIST,
  style: AmountStyle = "exact",
): string {
  const token = tokenFor(address, tokens);
  if (style === "exact" || value === null || !token) return amountLabel(value, address, tokens);
  return `${formatSignificant(value, token.decimals, 6)} ${token.symbol}`;
}

// ── Frequencies ───────────────────────────────────────────────────────────

const UNITS: readonly (readonly [seconds: number, name: string])[] = [
  [604_800, "week"],
  [86_400, "day"],
  [3_600, "hour"],
  [60, "minute"],
  [1, "second"],
];

/**
 * "every day", "every 2 weeks", "every 45 minutes".
 *
 * The largest unit the interval is a whole number of, so 14 days reads as
 * "every 2 weeks" and 30 days stays "every 30 days" (it is not a whole number
 * of weeks, and "every 4.3 weeks" helps nobody).
 */
export function everyLabel(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "at an unknown interval";
  for (const [size, name] of UNITS) {
    if (seconds % size !== 0) continue;
    const count = seconds / size;
    return count === 1 ? `every ${name}` : `every ${formatCount(count)} ${name}s`;
  }
  // Unreachable: every integer is a whole number of seconds.
  return `every ${seconds} seconds`;
}

/** "once", "10 times", "1,000 times". */
export function timesLabel(count: number): string {
  return count === 1 ? "once" : `${formatCount(count)} times`;
}

// ── Time ──────────────────────────────────────────────────────────────────

/**
 * "in 3h 12m", "in 2d 4h", "in 45m", "any moment", "now".
 *
 * From the wall clock every time it is called, never by counting ticks: a
 * background tab's timers are throttled to about once a minute, and a count
 * of ticks would drift exactly when nobody is looking. "any moment" covers the
 * last minute, when the next tick — not the clock — decides when the buy
 * starts; "now" means the buy time has already opened.
 */
export function countdown(nextAtSeconds: number | bigint, nowMs: number): string {
  const at = Number(nextAtSeconds);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return "at an unknown time";
  const remainingMs = at * 1_000 - nowMs;
  if (remainingMs <= 0) return "now";
  const total = Math.floor(remainingMs / 1_000);
  if (total < 60) return "any moment";

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours > 0) return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  return `in ${minutes}m`;
}

// ── Runs and totals ───────────────────────────────────────────────────────

/**
 * One entry of this browser's history of a plan, as the ledger stores it.
 *
 * Declared structurally, with every optional field also accepting
 * `undefined`, so the ledger's `DcaRun` fits and so does a fixture; `status`
 * is a plain string so a status added later is shown (by its reason) rather
 * than failing to compile here. What a run *means* beyond its status is in
 * `codes` (`RUN_CODES` in ledger.ts, and Guard codes).
 */
export interface RunLike {
  slot: number;
  /** Milliseconds since the epoch. */
  at: number;
  status: string;
  /** Base units of the sell token claimed for the buy. */
  amountIn: string;
  /** Base units of the buy token measured arriving at the owner. Absent when it could not be measured. */
  amountOut?: string | undefined;
  hashes: readonly string[];
  via?: string | undefined;
  reason?: string | undefined;
  codes?: readonly string[] | undefined;
  /** Held for a price warning: the divergence shown, in basis points. */
  divergenceBps?: number | undefined;
  /** A `MISSED` entry: how many buy times passed. */
  missed?: number | undefined;
}

/** What this browser has recorded about a plan, structurally (the ledger's `DcaLedgerEntry` fits). */
export interface EntryLike {
  buysDone: number;
  /** Decimal string of base units. */
  committed: string;
  /** Running totals over every settled buy whose delivery was measured, however old. */
  measured?: { buys: number; amountIn: string; amountOut: string } | undefined;
  runs: readonly RunLike[];
}

/** Fixed-point scale for prices: 18 decimals, as the oracle and stats use. */
export const PRICE_DECIMALS = 18;
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

export interface AveragePrice {
  /** Σ amountIn of the buys counted, in sell-token base units. */
  spent: bigint;
  /** Σ measured amountOut of the buys counted, in buy-token base units. */
  bought: bigint;
  /** Settled buys with a measured delivery — the ones the average is over. */
  counted: number;
  /** Every settled buy, measured or not; `counted < confirmed` means "from k of n buys". */
  confirmed: number;
  /** Sell token paid per one whole buy token, scaled by 10^18. Null when nothing was delivered. */
  sellPerBuy: bigint | null;
  /** Buy token received per one whole sell token, scaled by 10^18. Null when nothing was spent. */
  buyPerSell: bigint | null;
}

function priceFrom(
  spent: bigint,
  bought: bigint,
  counted: number,
  confirmed: number,
  sellDecimals: number,
  buyDecimals: number,
): AveragePrice | null {
  if (counted === 0) return null;
  const sellUnit = 10n ** BigInt(sellDecimals);
  const buyUnit = 10n ** BigInt(buyDecimals);
  return {
    spent,
    bought,
    counted,
    confirmed,
    sellPerBuy: bought === 0n ? null : (spent * buyUnit * PRICE_SCALE) / (bought * sellUnit),
    buyPerSell: spent === 0n ? null : (bought * sellUnit * PRICE_SCALE) / (spent * buyUnit),
  };
}

/**
 * The average price paid: Σ in / Σ out over confirmed buys.
 *
 * Only buys whose delivery was *measured* count. A buy whose amount received
 * could not be read is left out of both sums — including its spend alone would
 * make the average worse by an amount nobody knows — and `counted` against
 * `confirmed` lets the card say "from 3 of 4 buys". No confirmed, measured buy
 * at all is `null`: there is no average yet, and "0" would be a price.
 *
 * Before network fees: they are paid in ether by whoever signed, and folding
 * them into a token price would need a rate this layer does not have.
 */
export function averagePrice(
  runs: readonly RunLike[],
  sellDecimals: number,
  buyDecimals: number,
): AveragePrice | null {
  let spent = 0n;
  let bought = 0n;
  let counted = 0;
  let confirmed = 0;
  for (const run of runs) {
    if (run.status !== "confirmed") continue;
    confirmed += 1;
    const amountIn = baseUnits(run.amountIn);
    const amountOut = baseUnits(run.amountOut);
    if (amountIn === null || amountOut === null) continue;
    spent += amountIn;
    bought += amountOut;
    counted += 1;
  }
  return priceFrom(spent, bought, counted, confirmed, sellDecimals, buyDecimals);
}

/**
 * The average price over a plan's whole life, from the ledger's running
 * totals — the runs list keeps only the newest hundred, and a long plan
 * outlives them. Falls back to the runs for a record without totals, and to
 * `null` for a totals record it cannot read.
 */
export function averagePriceOf(
  entry: EntryLike | null | undefined,
  sellDecimals: number,
  buyDecimals: number,
): AveragePrice | null {
  if (!entry) return null;
  if (entry.measured === undefined) return averagePrice(entry.runs, sellDecimals, buyDecimals);
  const spent = baseUnits(entry.measured.amountIn);
  const bought = baseUnits(entry.measured.amountOut);
  const counted = entry.measured.buys;
  if (spent === null || bought === null || !Number.isSafeInteger(counted) || counted < 0) return null;
  return priceFrom(spent, bought, counted, Math.max(counted, entry.buysDone), sellDecimals, buyDecimals);
}

/**
 * A figure to `significant` significant digits, grouped for display in the
 * page's number format ("1,234.57", "1.234,57": `formatAmount` writes it).
 *
 * Whole digits are never dropped (1,307,221 stays that, not 1,307,000); the
 * fraction is cut to what the significant digits leave. `up` rounds up
 * instead of to nearest, for a figure the user will be asked to send — a fee
 * reserve shown a hair low is one that runs out a hair early; `down` cuts,
 * for a total that must never read higher than it is.
 */
export function formatSignificant(
  value: bigint,
  decimals: number,
  significant = 4,
  rounding: "nearest" | "up" | "down" = "nearest",
): string {
  if (value === 0n) return "0";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;

  let fractionDigits: number;
  if (whole > 0n) {
    fractionDigits = Math.max(0, significant - whole.toString().length);
  } else {
    const fraction = (abs % unit).toString().padStart(decimals, "0");
    fractionDigits = Math.min(decimals, fraction.search(/[1-9]/) + significant);
  }

  const step = 10n ** BigInt(decimals - fractionDigits);
  const remainder = abs % step;
  let rounded = abs - remainder;
  if (rounding === "up" ? remainder > 0n : rounding === "nearest" && remainder * 2n >= step) rounded += step;

  const text = formatAmount(rounded, decimals, { maxFraction: fractionDigits });
  return negative ? `-${text}` : text;
}

/**
 * ETH or WETH (18 decimals) for a person to read, to `significant` digits:
 * the one way ether figures are written. What was paid or received is five
 * digits, the default; a vault card's figures six; an estimate two; a cost
 * someone is asked to pay is rounded up (`ethUpTo`), so it is never shown
 * below itself.
 */
export function ethText(wei: bigint, significant = 5, rounding: "nearest" | "up" = "nearest"): string {
  return formatSignificant(wei, 18, significant, rounding);
}

/** An amount of ether rounded up to four significant digits: a figure someone will be asked to send. */
export function ethUpTo(wei: bigint): string {
  return ethText(wei, 4, "up");
}

// ── History rows ──────────────────────────────────────────────────────────

/** Capitalise, and end with a full stop unless it already ends in punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * A reason as the second half of a sentence: first letter lowered unless it
 * starts an acronym ("RPC …"), trailing full stop dropped.
 */
function clause(reason: string): string {
  const trimmed = reason.trim().replace(/\.$/, "");
  if (trimmed.length > 1 && trimmed[1] === trimmed[1]!.toUpperCase() && /[A-Z]/.test(trimmed[1]!)) return trimmed;
  return trimmed.length > 0 ? trimmed[0]!.toLowerCase() + trimmed.slice(1) : trimmed;
}

function withReason(headline: string, reason: string | undefined, fallback?: string): string {
  if (reason !== undefined && reason.trim() !== "") return sentence(`${headline} — ${clause(reason)}`);
  return sentence(fallback ?? headline);
}

/** "7.2%" from basis points, to one decimal place. */
function percent(bps: number): string {
  return `${formatNumber(Math.round(bps / 10) / 10)}%`;
}

const PRIVATE_UNAVAILABLE_SENTENCE =
  "Skipped — your wallet can't send privately, and spDEX won't send a scheduled buy publicly without asking. " +
  `Switch sending to public in ${PLACES.sending.label}.`;
const RELAY_FAILED_SENTENCE =
  "Skipped — the private relay didn't take it, and spDEX never sends an auto-buy publicly without asking.";
const LATE_SIGNATURE_SENTENCE = "Skipped — signed too close to its deadline, so spDEX didn't send it. No fee was spent.";
const UNVERIFIED_SENTENCE =
  "Skipped — the network service couldn't run the safety test, and an auto-buy is never made unchecked.";
/**
 * The scheduled-buy Guard refuses a buy the second opinion couldn't check
 * with both codes, SIMULATION_UNAVAILABLE and SECOND_OPINION_UNAVAILABLE; the
 * second is the one that says why, so it is looked for first.
 */
const SECOND_OPINION_SENTENCE =
  "Skipped — your second network service didn't answer, and an auto-buy is only made when both services agree.";

/** What a held buy was waiting on, from its codes. */
function heldFor(run: RunLike): string {
  if (run.codes?.includes(RUN_CODES.FEE_CEILING)) return "high network fees";
  if (run.divergenceBps !== undefined || run.codes?.includes("ORACLE_DIVERGENCE")) return "a price check";
  return "a check";
}

/**
 * The text of one history row, without its date (the UI adds that in the
 * viewer's locale).
 *
 * Worded from what is known about the run and nothing more, choosing the
 * sentence by the run's codes (`RUN_CODES`) and falling back to its `reason`.
 * A failure with no transaction hash never claims a network fee was spent; a
 * buy whose delivery was not measured says so rather than showing the quote.
 */
export function runLabel(
  run: RunLike,
  plan: Pick<DcaPlan, "sell" | "buy">,
  tokens: readonly TokenInfo[] = TOKEN_LIST,
  style: AmountStyle = "exact",
): string {
  const spent = amountText(baseUnits(run.amountIn), plan.sell, tokens, style);
  const buy = tokenLabel(plan.buy, tokens);
  const has = (code: string) => run.codes?.includes(code) === true;
  if (has(RUN_CODES.RELAY_FAILED)) return withReason("Skipped", run.reason, RELAY_FAILED_SENTENCE);
  if (has(RUN_CODES.LATE_SIGNATURE)) return LATE_SIGNATURE_SENTENCE;

  switch (run.status) {
    case "confirmed": {
      if (has(RUN_CODES.ASSUMED_SPENT)) {
        return "Counted as bought — your wallet sent a transaction in this buy's place, and spDEX couldn't find the buy itself on chain. Check your wallet's activity.";
      }
      const out = baseUnits(run.amountOut);
      const headline =
        out === null
          ? `Bought ${buy} for ${spent} — the amount received couldn't be measured`
          : `Bought ${amountText(out, plan.buy, tokens, style)} for ${spent}`;
      return withReason(headline, run.reason);
    }
    case "pending":
      return has(RUN_CODES.INTERRUPTED)
        ? "Interrupted — spDEX closed mid-buy. Checking the network…"
        : `Buying ${buy} with ${spent}…`;
    case "unknown": {
      const hash = run.hashes[run.hashes.length - 1];
      return hash === undefined
        ? "Unknown — sent, but no receipt has arrived yet. Check your wallet's activity before buying again."
        : `Unknown — sent as ${shortAddress(hash)}, but no receipt has arrived yet. Check it before buying again.`;
    }
    case "failed":
      if (has(RUN_CODES.PRIVATE_UNAVAILABLE)) return PRIVATE_UNAVAILABLE_SENTENCE;
      return run.hashes.length > 0
        ? "Failed on the network — nothing was bought; the network fee was spent."
        : withReason("Failed before anything was sent", run.reason);
    case "declined":
      return "Declined in your wallet.";
    case "held":
      if (has(RUN_CODES.FEE_CEILING)) return "On hold — network fees are above this plan's limit.";
      if (run.divergenceBps !== undefined) {
        return `On hold — the price is ${percent(run.divergenceBps)} away from the 10-minute average.`;
      }
      return withReason("On hold", run.reason, "On hold for a check");
    case "skipped": {
      if (has(RUN_CODES.MISSED)) {
        const count = run.missed;
        return count !== undefined && Number.isSafeInteger(count) && count > 0
          ? `${formatCount(count)} buy ${count === 1 ? "time" : "times"} passed while spDEX wasn't running — skipped, not made up.`
          : "Buy times passed while spDEX wasn't running — skipped, not made up.";
      }
      if (has(RUN_CODES.SKIPPED_BY_USER)) return "Skipped — you chose to skip this buy.";
      if (has(RUN_CODES.NOT_CONFIRMED)) return "Skipped — not confirmed before its buy time ended.";
      if (has(RUN_CODES.HELD_EXPIRED)) {
        return `Skipped — held for ${heldFor(run)} and not approved before its buy time ended.`;
      }
      if (has(RUN_CODES.PRIVATE_UNAVAILABLE)) return PRIVATE_UNAVAILABLE_SENTENCE;
      if (has(RUN_CODES.INSUFFICIENT_FUNDS)) {
        // The run's own reason says whose balance was short: the owner's
        // wallet, or, in a record from before config version 8, an autopilot
        // plan's spending wallet. The plan can't say — a migrated plan is a
        // wallet plan now, with its spending wallet's history.
        return withReason("Skipped", run.reason, `Skipped — not enough ${tokenLabel(plan.sell, tokens)} in your wallet.`);
      }
      if (has(RUN_CODES.FEE_CEILING)) return "Skipped — network fees were above this plan's limit.";
      if (has(RUN_CODES.GAS_BUDGET)) {
        return "Skipped — this buy needed more gas than its network-fee budget allows. Nothing was sent for it.";
      }
      if (has("SECOND_OPINION_UNAVAILABLE")) return SECOND_OPINION_SENTENCE;
      if (has("SIMULATION_UNAVAILABLE")) return UNVERIFIED_SENTENCE;
      return withReason("Skipped", run.reason);
    }
    default:
      return withReason(`Status: ${run.status}`, run.reason);
  }
}

// ── History kinds, transfers, and the merged history ─────────────────────

/**
 * What a history entry is, as the UI names it, so a row can
 * pick its sentence, its icon and whether it gets a transaction link without
 * re-deriving the rules below.
 *
 * - `bought` — settled; `amountOut` absent means the delivery was not measured.
 * - `unknown` — sent with no receipt yet; or a wallet-mode buy counted as made
 *   without being seen (`ASSUMED_SPENT`), which the owner should check.
 * - `interrupted` — a buy the tab closed on, still being checked; it settles
 *   to `bought`, `failed` or `unknown` (the codes keep `INTERRUPTED`).
 * - `refused` — the Guard said no (its codes are on the run); `unverified` is
 *   the one refusal that means "the network service can't run the safety test",
 *   and `second-opinion-unavailable` the one that means "the second service
 *   didn't answer", so no auto-buy was made on one service's word.
 * - `skipped` — a window the host could not use for a reason of its own
 *   (fees above the limit, no price found, the plan could not buy all window).
 */
export type HistoryKind =
  | "bought"
  | "buying"
  | "interrupted"
  | "unknown"
  | "held"
  | "failed"
  | "declined"
  | "missed"
  | "not-confirmed"
  | "skipped-by-user"
  | "held-expired"
  | "refused"
  | "unverified"
  | "second-opinion-unavailable"
  | "no-funds"
  | "private-unavailable"
  | "relay-failed"
  | "late-signature"
  | "skipped"
  | TransferKind;

/** Codes the host writes; any other code on a skipped run is the Guard's. */
const HOST_CODES: ReadonlySet<string> = new Set(Object.values(RUN_CODES));

/** The history kind of one run, from its status and codes. */
export function runKind(run: Pick<RunLike, "status" | "codes">): HistoryKind {
  const codes = run.codes ?? [];
  const has = (code: string) => codes.includes(code);
  if (has(RUN_CODES.RELAY_FAILED)) return "relay-failed";
  if (has(RUN_CODES.LATE_SIGNATURE)) return "late-signature";
  switch (run.status) {
    case "confirmed":
      // Counted so the budget holds, but never seen: the owner should look.
      return has(RUN_CODES.ASSUMED_SPENT) ? "unknown" : "bought";
    case "pending":
      return has(RUN_CODES.INTERRUPTED) ? "interrupted" : "buying";
    case "unknown":
      return "unknown";
    case "held":
      return "held";
    case "declined":
      return "declined";
    case "failed":
      return has(RUN_CODES.PRIVATE_UNAVAILABLE) ? "private-unavailable" : "failed";
    case "skipped":
      if (has(RUN_CODES.MISSED)) return "missed";
      if (has(RUN_CODES.SKIPPED_BY_USER)) return "skipped-by-user";
      if (has(RUN_CODES.NOT_CONFIRMED)) return "not-confirmed";
      if (has(RUN_CODES.HELD_EXPIRED)) return "held-expired";
      if (has(RUN_CODES.PRIVATE_UNAVAILABLE)) return "private-unavailable";
      if (has(RUN_CODES.INSUFFICIENT_FUNDS)) return "no-funds";
      if (has("SECOND_OPINION_UNAVAILABLE")) return "second-opinion-unavailable";
      if (has("SIMULATION_UNAVAILABLE")) return "unverified";
      return codes.some((code) => !HOST_CODES.has(code)) ? "refused" : "skipped";
    default:
      return "skipped";
  }
}

/** A funding, top-up or withdrawal as the ledger stores it (`DcaTransfer` fits). */
export interface TransferLike {
  kind: TransferKind;
  at: number;
  amounts: readonly { token: string; amount: string }[];
  hashes: readonly string[];
  reason?: string | undefined;
}

/** "0.1 ETH", "10 USDC and 0.004 ETH"; an unknown token is named without an amount. */
function amountsLabel(amounts: TransferLike["amounts"], tokens: readonly TokenInfo[], style: AmountStyle): string {
  const parts = amounts.map((a) => amountText(baseUnits(a.amount), a.token, tokens, style));
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "Funded the spending wallet with 0.103 ETH." / "Withdrew 0.002 ETH to your
 * wallet." A transfer that stopped part-way says what went through and why
 * the rest did not.
 */
export function transferLabel(
  transfer: TransferLike,
  tokens: readonly TokenInfo[] = TOKEN_LIST,
  style: AmountStyle = "exact",
): string {
  const what = amountsLabel(transfer.amounts, tokens, style);
  const headline =
    transfer.amounts.length === 0
      ? transfer.kind === "withdrawn"
        ? "Withdrawal sent, not confirmed"
        : "Funding sent, not confirmed"
      : transfer.kind === "withdrawn"
        ? `Withdrew ${what} to your wallet`
        : transfer.kind === "topped-up"
          ? `Topped up the spending wallet with ${what}`
          : `Funded the spending wallet with ${what}`;
  return withReason(headline, transfer.reason);
}

/** One row of a plan's history: a buy window's run, or a transfer. */
export type HistoryEntry =
  | { source: "run"; kind: HistoryKind; at: number; text: string; hashes: readonly string[]; run: RunLike }
  | { source: "transfer"; kind: TransferKind; at: number; text: string; hashes: readonly string[]; transfer: TransferLike };

/**
 * A plan's history, newest first: its runs and its transfers merged by time,
 * each with its kind and its sentence (`runLabel` / `transferLabel`).
 *
 * `runs` and `transfers` each keep only their newest hundred in the ledger;
 * `limit` cuts the merged list (the card shows 50).
 */
export function historyOf(
  entry: { runs: readonly RunLike[]; transfers?: readonly TransferLike[] | undefined },
  plan: Pick<DcaPlan, "sell" | "buy">,
  tokens: readonly TokenInfo[] = TOKEN_LIST,
  limit = 50,
  style: AmountStyle = "exact",
): HistoryEntry[] {
  const rows: HistoryEntry[] = [
    ...entry.runs.map(
      (run): HistoryEntry => ({
        source: "run",
        kind: runKind(run),
        at: run.at,
        text: runLabel(run, plan, tokens, style),
        hashes: run.hashes,
        run,
      }),
    ),
    ...(entry.transfers ?? []).map(
      (transfer): HistoryEntry => ({
        source: "transfer",
        kind: transfer.kind,
        at: transfer.at,
        text: transferLabel(transfer, tokens, style),
        hashes: transfer.hashes,
        transfer,
      }),
    ),
  ];
  // Stable: equal times keep ledger order, newest last, before the reverse.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.at - a.row.at || b.index - a.index)
    .slice(0, Math.max(0, limit))
    .map(({ row }) => row);
}
