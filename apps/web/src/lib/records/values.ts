/**
 * What a record's sold side was worth when it happened.
 *
 * There are two honest sources, and a row takes the first that applies:
 *
 * 1. **`twap-seen`.** The rates this browser held when it saw the trade
 *    settle: spDEX's 10-minute average in dollars, and every Chainlink
 *    currency answer with it. Only if they were read at most 10 minutes before
 *    it was seen, and the trade was recorded at most 15 minutes before that:
 *    an older price describes a different moment.
 * 2. **`chainlink-at-block`.** Chainlink's ETH/USD and USDC/USD answers, and
 *    every currency answer, read at the trade's own block when the person asks
 *    ("Fill in values from the chain"). A trade that sold SPX stays blank:
 *    nothing on chain says what SPX was worth at a past block short of
 *    replaying the 10-minute average there.
 *
 * Otherwise the value is unknown, and blank. Never 0: a zero in a record kept
 * for taxes is a claim, and a wrong one.
 *
 * Both sources keep every currency answer, not only the one chosen now, so a
 * later change of currency leaves nothing blank that was known.
 *
 * Nothing here is ever an average cost, a price per SPX or a price history:
 * each row carries only what its own sold side was worth, which is what a tax
 * tool needs to work out a cost basis itself.
 */

import { FX_CODES, fxProblem, readFxRates, type FxCode, type Multicall3Reader } from "@spdex/chain";
import { usdRateOf, usdShown, usdToFiat, type ShownFiat } from "../money/convert.js";
import type { CurrencyCode, FiatAmount, FxAnswer, FxSnapshot, RateSnapshot } from "../money/pricing.js";
import { tokenFor } from "../dca/format.js";
import type { RecordLeg, RecordRow } from "./types.js";

const WAD = 10n ** 18n;
const MICRO = 1_000_000n;

/** The oldest a rate read may be, when the trade is seen, and still say what the trade was worth. */
export const SEEN_READ_MAX_AGE_MS = 10 * 60_000;

/**
 * The longest between a trade being recorded (a plan's buy settling in the
 * ledger) and this browser seeing it with rates in hand. Past that, the rates
 * held describe some later moment.
 */
export const SEEN_RECORD_MAX_AGE_MS = 15 * 60_000;

// ─── The stored forms ─────────────────────────────────────────────────────────

/** An `FxAnswer` as JSON: the bigint as a decimal string. */
export interface StoredAnswer {
  answer: string;
  decimals: number;
  updatedAt: number;
}

/** An `FxSnapshot` as JSON. */
export interface StoredFx {
  block: string;
  chainTime: number;
  rates: Partial<Record<FxCode, StoredAnswer>>;
  usdc: StoredAnswer | null;
}

/**
 * The JSON form of the rates a trade was seen with.
 *
 * `at` is wall-clock unix seconds, where a `RateSnapshot` holds
 * `performance.now()`: that clock restarts with the page, so after a reload it
 * would say nothing about when the rates were read.
 */
export interface StoredRates {
  at: number;
  /** Raw USDC per raw token, times 1e18, by lowercase address, as decimal strings. */
  usd: Record<string, string>;
  fx: StoredFx | null;
}

const isDecimal = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,78}$/.test(v);
const isSeconds = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function answerToStored(answer: FxAnswer): StoredAnswer {
  return { answer: answer.answer.toString(), decimals: answer.decimals, updatedAt: answer.updatedAt };
}

/** A stored answer, or null for anything this code didn't write. A negative answer never comes back. */
export function answerFromStored(raw: unknown): FxAnswer | null {
  if (!isRecord(raw) || !isDecimal(raw["answer"]) || !isSeconds(raw["updatedAt"])) return null;
  const decimals = raw["decimals"];
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 36) return null;
  return { answer: BigInt(raw["answer"]), decimals: decimals as number, updatedAt: raw["updatedAt"] };
}

/** Only positive answers are kept: nothing else could ever price a figure. */
export function fxToStored(fx: FxSnapshot): StoredFx {
  const rates: Partial<Record<FxCode, StoredAnswer>> = {};
  for (const code of FX_CODES) {
    const answer = fx.rates[code];
    if (answer !== undefined && answer.answer > 0n) rates[code] = answerToStored(answer);
  }
  return {
    block: fx.block.toString(),
    chainTime: fx.chainTime,
    rates,
    usdc: fx.usdc !== null && fx.usdc.answer > 0n ? answerToStored(fx.usdc) : null,
  };
}

export function fxFromStored(raw: unknown): FxSnapshot | null {
  if (!isRecord(raw) || !isDecimal(raw["block"]) || !isSeconds(raw["chainTime"]) || !isRecord(raw["rates"])) return null;
  const stored = raw["rates"];
  const rates: Partial<Record<FxCode, FxAnswer>> = {};
  for (const code of FX_CODES) {
    const answer = answerFromStored(stored[code]);
    if (answer !== null) rates[code] = answer;
  }
  return { block: BigInt(raw["block"]), chainTime: raw["chainTime"], rates, usdc: answerFromStored(raw["usdc"]) };
}

export function ratesFromStored(raw: unknown): StoredRates | null {
  if (!isRecord(raw) || !isSeconds(raw["at"]) || !isRecord(raw["usd"])) return null;
  const usd: Record<string, string> = {};
  for (const [token, rate] of Object.entries(raw["usd"])) {
    if (/^0x[0-9a-f]{40}$/.test(token) && isDecimal(rate) && rate !== "0") usd[token] = rate;
  }
  const fxRaw = raw["fx"];
  const fx = fxRaw === null || fxRaw === undefined ? null : fxFromStored(fxRaw);
  return { at: raw["at"], usd, fx: fx === null ? null : fxToStored(fx) };
}

// ─── twap-seen ────────────────────────────────────────────────────────────────

/**
 * The page's rates as they may be kept with a trade seen now, or null when
 * they were read more than 10 minutes ago (or never).
 *
 * `nowPerfMs` is `performance.now()`, the clock `RateSnapshot` is read on;
 * `nowUnix` is the wall clock the stored form is written in.
 */
export function ratesSeenNow(snapshot: RateSnapshot | null, nowPerfMs: number, nowUnix: number): StoredRates | null {
  if (snapshot === null) return null;
  const age = nowPerfMs - snapshot.usdReadAt;
  if (!(age >= 0 && age <= SEEN_READ_MAX_AGE_MS)) return null;
  const usd: Record<string, string> = {};
  for (const [token, rate] of snapshot.usd) {
    if (rate > 0n) usd[token.toLowerCase()] = rate.toString();
  }
  return { at: Math.floor(nowUnix - age / 1000), usd, fx: snapshot.fx === null ? null : fxToStored(snapshot.fx) };
}

/** What `leg` was worth in dollar millionths by the rates it was seen with, or null. */
export function valueSeen(leg: RecordLeg, rates: StoredRates): bigint | null {
  if (leg.amount === null) return null;
  const usd = new Map(Object.entries(rates.usd).map(([token, rate]) => [token, BigInt(rate)]));
  const rate = usdRateOf(leg.token, usd);
  return rate === null ? null : (leg.amount * rate) / WAD;
}

// ─── chainlink-at-block ───────────────────────────────────────────────────────

/** The gas the read may use: a node's eth_call cap is often 50 million, and this read needs a fraction of it. */
const AT_BLOCK_GAS = 30_000_000n;

/**
 * Chainlink's answers at `block`, ETH/USD, USDC/USD and every currency, in
 * one `eth_call`: the page's own currency read (`readFxRates`), at a past block.
 *
 * Throws when the request fails or the block's time can't be read: an
 * endpoint that keeps no old state refuses the call outright, and then the
 * rows of that block stay blank. A single feed that fails is only absent.
 */
export function readChainlinkAt(reader: Pick<Multicall3Reader, "multicall">, block: bigint): Promise<FxSnapshot> {
  return readFxRates(reader, { blockTag: `0x${block.toString(16)}`, gas: AT_BLOCK_GAS });
}

/**
 * What `leg` was worth in dollar millionths at the block `read` describes, or
 * null: ETH and WETH by ETH/USD, USDC by USDC/USD, anything else unknown.
 * An answer is used by the page's own rules (`fxProblem`): ETH/USD at most
 * three hours old, and every answer inside its band.
 */
export function valueAtBlock(leg: RecordLeg, read: FxSnapshot): bigint | null {
  if (leg.amount === null) return null;
  const token = tokenFor(leg.token);
  const feed = token?.symbol === "ETH" || token?.symbol === "WETH" ? "ETH" : token?.symbol === "USDC" ? "USDC" : null;
  if (token === undefined || feed === null) return null;
  const answer = feed === "ETH" ? (read.eth ?? null) : read.usdc;
  if (answer === null || fxProblem(feed, answer, read.chainTime) !== null) return null;
  return (leg.amount * answer.answer * MICRO) / (10n ** BigInt(token.decimals) * 10n ** BigInt(answer.decimals));
}

/** Whether "Fill in values" could ever price this leg: only ETH, WETH and USDC have a feed. */
export function fillable(leg: RecordLeg): boolean {
  const symbol = tokenFor(leg.token)?.symbol;
  return leg.amount !== null && (symbol === "ETH" || symbol === "WETH" || symbol === "USDC");
}

// ─── In the person's currency ─────────────────────────────────────────────────

/**
 * A row's value at the time in `currency`, by the currency answers held at
 * the time; null when the value or that currency's answer then is unknown.
 */
export function rowValueIn(row: Pick<RecordRow, "valueUsd" | "rates">, currency: CurrencyCode): FiatAmount | null {
  return row.valueUsd === null ? null : usdToFiat(row.valueUsd, row.rates, currency);
}

/**
 * A row's value at the time for display: in `currency` when its answer then
 * is known, otherwise in dollars (`fellBack`), otherwise null.
 */
export function rowValueShown(row: Pick<RecordRow, "valueUsd" | "rates">, currency: CurrencyCode): ShownFiat | null {
  return row.valueUsd === null ? null : usdShown(row.valueUsd, row.rates, currency);
}
