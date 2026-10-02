/**
 * Currency rates from Chainlink, read in one request, and the rules for when
 * an answer counts.
 *
 * Two properties matter to everything that uses these:
 *
 * **The request is the same for everyone.** Every feed is read every time,
 * whichever currency the person uses, US dollars included. A network service
 * that saw only the euro feed being read would learn where someone is, and
 * switching currency would need a read of its own. One `aggregate3` of 38
 * calls answers all of it, ETH/USD and USDC/USD included, with the block and
 * its timestamp from Multicall3 in the same call, so every answer is judged
 * against the time of the block it came from. Your records' "Fill in values"
 * sends the same request at a past block.
 *
 * **An answer is kept as read and judged separately.** `readFxRates` leaves
 * out only calls that failed or could not be decoded. Whether an answer may
 * be used (positive, fresh, the decimals the feed is known to have, within
 * its band) is `fxProblem`'s decision, so a stale answer can still say when
 * it last updated ("EUR rate unavailable (last update Sep 12)").
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Hex } from "@spdex/core";
import { CHAINLINK_FEEDS, CONTRACTS, type ChainlinkFeed } from "./constants.js";
import type { Multicall3Reader, ReadBlockTag } from "./reader.js";

/** The sixteen currencies with a Chainlink rate against the US dollar on Ethereum, US dollars aside. */
export const FX_CODES = [
  "EUR",
  "GBP",
  "JPY",
  "KRW",
  "CNY",
  "CHF",
  "CAD",
  "AUD",
  "SGD",
  "NZD",
  "BRL",
  "MXN",
  "TRY",
  "IDR",
  "ARS",
  "PHP",
] as const;

export type FxCode = (typeof FX_CODES)[number];

/** The feed for each currency, from `CHAINLINK_FEEDS`. */
export const FX_FEEDS: Readonly<Record<FxCode, ChainlinkFeed>> = {
  EUR: CHAINLINK_FEEDS.EUR,
  GBP: CHAINLINK_FEEDS.GBP,
  JPY: CHAINLINK_FEEDS.JPY,
  KRW: CHAINLINK_FEEDS.KRW,
  CNY: CHAINLINK_FEEDS.CNY,
  CHF: CHAINLINK_FEEDS.CHF,
  CAD: CHAINLINK_FEEDS.CAD,
  AUD: CHAINLINK_FEEDS.AUD,
  SGD: CHAINLINK_FEEDS.SGD,
  NZD: CHAINLINK_FEEDS.NZD,
  BRL: CHAINLINK_FEEDS.BRL,
  MXN: CHAINLINK_FEEDS.MXN,
  TRY: CHAINLINK_FEEDS.TRY,
  IDR: CHAINLINK_FEEDS.IDR,
  ARS: CHAINLINK_FEEDS.ARS,
  PHP: CHAINLINK_FEEDS.PHP,
};

/** USDC/USD, read with the currencies for the note shown when USDC drifts from $1. */
export const USDC_USD_FEED: ChainlinkFeed = CHAINLINK_FEEDS.USDC;

/**
 * ETH/USD, read with the currencies: it checks the 10-minute average's ether
 * price before typed money is sized from it, and prices a record's ether at
 * its block.
 */
export const ETH_USD_FEED: ChainlinkFeed = CHAINLINK_FEEDS.ETH;

/** A feed judged by `fxProblem`: a currency, USDC or ETH. */
export type FxFeedName = FxCode | "USDC" | "ETH";

const FEEDS: Readonly<Record<FxFeedName, ChainlinkFeed>> = { ...FX_FEEDS, USDC: USDC_USD_FEED, ETH: ETH_USD_FEED };

/**
 * The block the references below were read at: the fork's pinned block,
 * 2026-09-17 21:49:23 UTC.
 */
export const FX_REFERENCE_BLOCK = 26_000_000n;

/**
 * Each feed's raw answer at `FX_REFERENCE_BLOCK`, with the feed's own decimals.
 *
 * An answer outside a fifth to five times its reference is unknown. That
 * catches a proxy pointed somewhere broken, or at another pair, which would
 * otherwise size an amount a thousandfold wrong; no currency here has moved
 * that far in a release's life. They are read again for each release, and a
 * currency that drifts out of its band before then (ARS is the likeliest)
 * reads as unavailable until it is, which is the safe way to be wrong.
 */
export const FX_REFERENCE: Readonly<Record<FxFeedName, bigint>> = {
  EUR: 114_810_000n,
  GBP: 133_580_000n,
  JPY: 640_947n,
  KRW: 72_449n,
  CNY: 14_909_100n,
  CHF: 121_348_178n,
  CAD: 71_476_051n,
  AUD: 71_132_500n,
  SGD: 78_416_611n,
  NZD: 57_260_400n,
  BRL: 19_422_755n,
  MXN: 5_827_811n,
  TRY: 2_054_500n,
  IDR: 5_633n,
  ARS: 66_104n,
  PHP: 15_927_000_000_000_000n,
  USDC: 99_985_499n,
  ETH: 245_131_000_000n,
};

/** How far from its reference an answer may be, as a factor either way: 0.2× to 5×. */
export const FX_BAND_FACTOR = 5n;

/**
 * The oldest an answer may be, in seconds of chain time: five days.
 *
 * Currency markets close from Friday 17:00 to Sunday 18:00 New York time,
 * 49 hours, and the feeds stop with them. Add a feed's 24-hour heartbeat and
 * a one-day holiday and an honest answer can be 97 hours old; four days did
 * not cover that. Chain time rather than the device's clock, as the vault
 * code measures, so a wrong clock on the device can't make a rate usable.
 */
export const FX_MAX_AGE_SECONDS = 432_000;

/**
 * The oldest an ETH/USD answer may be: three hours.
 *
 * The feed updates at least hourly and on every half-percent move, so an
 * answer three heartbeats old means the feed was not working at that block,
 * and a price from it would be a guess.
 */
export const ETH_USD_MAX_AGE_SECONDS = 3 * 3_600;

/** One feed's answer, as read. */
export interface FxAnswer {
  /** US dollars per unit, times 10^decimals. */
  answer: bigint;
  /** What the feed reported in the same read. */
  decimals: number;
  /** When the feed last updated, in unix seconds. */
  updatedAt: number;
}

/** Every feed, read at one block. */
export interface FxRead {
  block: bigint;
  /** That block's timestamp, in unix seconds. */
  chainTime: number;
  /** Absent when the feed's call failed. */
  rates: Partial<Record<FxCode, FxAnswer>>;
  usdc: FxAnswer | null;
  eth: FxAnswer | null;
}

/** Why an answer can't be used. */
export type FxProblem =
  | "missing"
  | "not-positive"
  | "wrong-decimals"
  | "never-updated"
  | "from-the-future"
  | "stale"
  | "out-of-band";

/**
 * Why `answer` can't be used for `feed` at `chainTime`, or null when it can.
 *
 * An update after the block that answered is impossible for a real feed, so
 * it is refused rather than read as fresh.
 */
export function fxProblem(feed: FxFeedName, answer: FxAnswer | null | undefined, chainTime: number): FxProblem | null {
  if (answer === null || answer === undefined) return "missing";
  if (answer.answer <= 0n) return "not-positive";
  if (answer.decimals !== FEEDS[feed].decimals) return "wrong-decimals";
  if (answer.updatedAt <= 0) return "never-updated";
  if (answer.updatedAt > chainTime) return "from-the-future";
  if (chainTime - answer.updatedAt > (feed === "ETH" ? ETH_USD_MAX_AGE_SECONDS : FX_MAX_AGE_SECONDS)) return "stale";
  const reference = FX_REFERENCE[feed];
  if (answer.answer * FX_BAND_FACTOR < reference || answer.answer > reference * FX_BAND_FACTOR) return "out-of-band";
  return null;
}

const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

const MULTICALL3_CLOCK_ABI = parseAbi([
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function getBlockNumber() view returns (uint256)",
]);

const LATEST_ROUND = encodeFunctionData({ abi: FEED_ABI, functionName: "latestRoundData" });
const DECIMALS = encodeFunctionData({ abi: FEED_ABI, functionName: "decimals" });

/** Every feed in the order they are read: the sixteen currencies, then USDC, then ETH. */
const READ_ORDER: readonly FxFeedName[] = [...FX_CODES, "USDC", "ETH"];

export interface ReadFxOptions {
  /** The block to read at; the reader's own when unset. */
  blockTag?: ReadBlockTag;
  /** The call's gas ceiling; the reader's own when unset. */
  gas?: bigint;
}

/**
 * Read every currency feed, USDC/USD and ETH/USD, with the block and its
 * time, in one `eth_call`.
 *
 * Throws when the block or its time can't be read, since no answer can be
 * judged without them, or when the request itself fails. A single feed that
 * fails is only absent.
 */
export async function readFxRates(
  reader: Pick<Multicall3Reader, "multicall">,
  options: ReadFxOptions = {},
): Promise<FxRead> {
  const calls: { to: `0x${string}`; data: Hex }[] = READ_ORDER.flatMap((name) => [
    { to: FEEDS[name].address, data: LATEST_ROUND },
    { to: FEEDS[name].address, data: DECIMALS },
  ]);
  calls.push(
    { to: CONTRACTS.multicall3, data: encodeFunctionData({ abi: MULTICALL3_CLOCK_ABI, functionName: "getCurrentBlockTimestamp" }) },
    { to: CONTRACTS.multicall3, data: encodeFunctionData({ abi: MULTICALL3_CLOCK_ABI, functionName: "getBlockNumber" }) },
  );

  // One batch, whatever the reader's default size: the point is one request.
  const results = await reader.multicall(calls, {
    batchSize: calls.length,
    ...(options.blockTag === undefined ? {} : { blockTag: options.blockTag }),
    ...(options.gas === undefined ? {} : { gas: options.gas }),
  });

  const clock = results.slice(-2);
  const chainTime = decodeUint(clock[0], "getCurrentBlockTimestamp");
  const block = decodeUint(clock[1], "getBlockNumber");
  if (chainTime === null || block === null) throw new Error("the block and its time could not be read");

  const answers = READ_ORDER.map((_, i) => decodeAnswer(results[2 * i], results[2 * i + 1]));
  const rates: Partial<Record<FxCode, FxAnswer>> = {};
  FX_CODES.forEach((code, i) => {
    const answer = answers[i];
    if (answer !== null && answer !== undefined) rates[code] = answer;
  });

  return {
    block,
    chainTime: Number(chainTime),
    rates,
    usdc: answers[FX_CODES.length] ?? null,
    eth: answers[FX_CODES.length + 1] ?? null,
  };
}

/** A feed's answer from its two results, or null when either call failed or can't be decoded. */
function decodeAnswer(round: string | undefined, decimals: string | undefined): FxAnswer | null {
  if (round === undefined || decimals === undefined || round === "0x" || decimals === "0x") return null;
  try {
    const [, answer, , updatedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", data: round as Hex });
    const places = decodeFunctionResult({ abi: FEED_ABI, functionName: "decimals", data: decimals as Hex });
    // A timestamp past 2^53 is no timestamp; it is refused as never updated.
    const at = updatedAt <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(updatedAt) : 0;
    return { answer, decimals: places, updatedAt: at };
  } catch {
    return null;
  }
}

function decodeUint(data: string | undefined, functionName: "getCurrentBlockTimestamp" | "getBlockNumber"): bigint | null {
  if (data === undefined || data === "0x") return null;
  try {
    return decodeFunctionResult({ abi: MULTICALL3_CLOCK_ABI, functionName, data: data as Hex });
  } catch {
    return null;
  }
}
