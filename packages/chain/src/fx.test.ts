/**
 * The currency feeds: one request for all of them, and the rules for when an
 * answer may be used.
 *
 * A scripted endpoint answers the reader's `aggregate3` here; the fork suite
 * (test/integration/fx.test.ts) reads the real feeds at the pinned block.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { CHAINLINK_FEEDS, CONTRACTS } from "./constants.js";
import {
  ETH_USD_FEED,
  ETH_USD_MAX_AGE_SECONDS,
  FX_CODES,
  FX_FEEDS,
  FX_MAX_AGE_SECONDS,
  FX_REFERENCE,
  fxProblem,
  readFxRates,
  USDC_USD_FEED,
  type FxAnswer,
} from "./fx.js";
import { Multicall3Reader, type JsonRpc } from "./reader.js";

const AGGREGATE3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const FEED = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
const CLOCK = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)", "function getBlockNumber() view returns (uint256)"]);

const NOW = 1_789_700_000;
const BLOCK = 26_001_234n;

type Answerer = (target: string, selector: string) => Hex | null;

/** An endpoint that answers `aggregate3` call by call, and counts what it was sent. */
function scripted(answer: Answerer) {
  const sent: { method: string; params: unknown[]; calls: number }[] = [];
  const rpc: JsonRpc = async (method, params) => {
    const tx = params[0] as { data: Hex };
    const { args } = decodeFunctionData({ abi: AGGREGATE3, data: tx.data });
    const calls = args[0];
    sent.push({ method, params, calls: calls.length });
    const results = calls.map((call) => {
      const data = answer(call.target.toLowerCase(), call.callData.slice(0, 10));
      return data === null ? { success: false, returnData: "0x" as Hex } : { success: true, returnData: data };
    });
    return encodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", result: results });
  };
  return { rpc, sent };
}

const round = (answer: bigint, updatedAt: number): Hex =>
  encodeFunctionResult({ abi: FEED, functionName: "latestRoundData", result: [1n, answer, BigInt(updatedAt), BigInt(updatedAt), 1n] });
const decimals = (d: number): Hex => encodeFunctionResult({ abi: FEED, functionName: "decimals", result: d });

const LATEST_ROUND_SELECTOR = "0xfeaf968c";
const DECIMALS_SELECTOR = "0x313ce567";
const TIMESTAMP_SELECTOR = "0x0f28c97d";
const BLOCK_NUMBER_SELECTOR = "0x42cbb15c";

/** Every feed answering its reference, updated an hour ago; `override` changes one target's answers. */
function healthy(override: Partial<Record<string, Answerer>> = {}): Answerer {
  const byAddress = new Map<string, string>(
    Object.entries(CHAINLINK_FEEDS).map(([name, feed]) => [feed.address.toLowerCase(), name]),
  );
  return (target, selector) => {
    const custom = override[target];
    if (custom !== undefined) return custom(target, selector);
    if (target === CONTRACTS.multicall3) {
      if (selector === TIMESTAMP_SELECTOR) return encodeFunctionResult({ abi: CLOCK, functionName: "getCurrentBlockTimestamp", result: BigInt(NOW) });
      if (selector === BLOCK_NUMBER_SELECTOR) return encodeFunctionResult({ abi: CLOCK, functionName: "getBlockNumber", result: BLOCK });
      return null;
    }
    const name = byAddress.get(target) as keyof typeof FX_REFERENCE | undefined;
    if (name === undefined) return null;
    const feed = CHAINLINK_FEEDS[name];
    if (selector === LATEST_ROUND_SELECTOR) return round(FX_REFERENCE[name], NOW - 3_600);
    if (selector === DECIMALS_SELECTOR) return decimals(feed.decimals);
    return null;
  };
}

describe("readFxRates", () => {
  it("reads all sixteen currencies, USDC, ETH and the block's time in one eth_call", async () => {
    const endpoint = scripted(healthy());
    const read = await readFxRates(new Multicall3Reader(endpoint.rpc));

    // The reader's default batch is 40 calls; this read never depends on it.
    expect(endpoint.sent).toHaveLength(1);
    expect(endpoint.sent[0]!.method).toBe("eth_call");
    expect(endpoint.sent[0]!.calls).toBe(2 * 18 + 2);
    expect(endpoint.sent[0]!.params[1]).toBe("latest");
    expect(read.block).toBe(BLOCK);
    expect(read.chainTime).toBe(NOW);
    expect(Object.keys(read.rates).sort()).toEqual([...FX_CODES].sort());
    expect(read.rates.PHP).toEqual({ answer: FX_REFERENCE.PHP, decimals: 18, updatedAt: NOW - 3_600 });
    expect(read.usdc).toEqual({ answer: FX_REFERENCE.USDC, decimals: 8, updatedAt: NOW - 3_600 });
    expect(read.eth).toEqual({ answer: FX_REFERENCE.ETH, decimals: 8, updatedAt: NOW - 3_600 });
  });

  it("is the same request whatever currency anyone uses", async () => {
    // Nothing about a currency is an argument, so there is nothing to vary:
    // two reads send byte-identical requests.
    const first = scripted(healthy());
    const second = scripted(healthy());
    await readFxRates(new Multicall3Reader(first.rpc));
    await readFxRates(new Multicall3Reader(second.rpc));
    expect(JSON.stringify(first.sent[0]!.params)).toBe(JSON.stringify(second.sent[0]!.params));
  });

  it("reads at the block it is given, with the gas ceiling it is given", async () => {
    const endpoint = scripted(healthy());
    await readFxRates(new Multicall3Reader(endpoint.rpc), { blockTag: "0x18cba80", gas: 30_000_000n });
    expect(endpoint.sent[0]!.params[1]).toBe("0x18cba80");
    expect((endpoint.sent[0]!.params[0] as { gas: string }).gas).toBe("0x1c9c380");
  });

  it("leaves out a feed whose call failed, and keeps the rest", async () => {
    const endpoint = scripted(
      healthy({ [FX_FEEDS.EUR.address]: () => null, [USDC_USD_FEED.address]: () => "0x1234", [ETH_USD_FEED.address]: () => null }),
    );
    const read = await readFxRates(new Multicall3Reader(endpoint.rpc));
    expect(read.rates.EUR).toBeUndefined();
    expect(read.usdc).toBeNull();
    expect(read.eth).toBeNull();
    expect(read.rates.GBP?.answer).toBe(FX_REFERENCE.GBP);
  });

  it("keeps an answer as read, stale or not: judging it is fxProblem's job", async () => {
    // A stale answer still says when it last updated, which the refusal names.
    const old = NOW - FX_MAX_AGE_SECONDS - 86_400;
    const endpoint = scripted(
      healthy({
        [FX_FEEDS.JPY.address]: (_t, selector) => (selector === LATEST_ROUND_SELECTOR ? round(FX_REFERENCE.JPY, old) : decimals(8)),
      }),
    );
    const read = await readFxRates(new Multicall3Reader(endpoint.rpc));
    expect(read.rates.JPY?.updatedAt).toBe(old);
    expect(fxProblem("JPY", read.rates.JPY, read.chainTime)).toBe("stale");
  });

  it("throws when the block's time can't be read, since nothing could be judged", async () => {
    const endpoint = scripted(healthy({ [CONTRACTS.multicall3]: () => null }));
    await expect(readFxRates(new Multicall3Reader(endpoint.rpc))).rejects.toThrow(/block and its time/);
  });
});

describe("fxProblem", () => {
  const fresh = (patch: Partial<FxAnswer> = {}): FxAnswer => ({
    answer: FX_REFERENCE.EUR,
    decimals: 8,
    updatedAt: NOW - 60,
    ...patch,
  });

  it("accepts a fresh answer inside its band", () => {
    expect(fxProblem("EUR", fresh(), NOW)).toBeNull();
  });

  it("ages out at exactly five days of chain time, not a second later", () => {
    expect(fxProblem("EUR", fresh({ updatedAt: NOW - FX_MAX_AGE_SECONDS }), NOW)).toBeNull();
    expect(fxProblem("EUR", fresh({ updatedAt: NOW - FX_MAX_AGE_SECONDS - 1 }), NOW)).toBe("stale");
    expect(FX_MAX_AGE_SECONDS).toBe(432_000);
  });

  it("refuses an answer that is missing, not positive, never updated or from after its block", () => {
    expect(fxProblem("EUR", null, NOW)).toBe("missing");
    expect(fxProblem("EUR", undefined, NOW)).toBe("missing");
    expect(fxProblem("EUR", fresh({ answer: 0n }), NOW)).toBe("not-positive");
    expect(fxProblem("EUR", fresh({ answer: -1n }), NOW)).toBe("not-positive");
    expect(fxProblem("EUR", fresh({ updatedAt: 0 }), NOW)).toBe("never-updated");
    expect(fxProblem("EUR", fresh({ updatedAt: NOW + 1 }), NOW)).toBe("from-the-future");
  });

  it("refuses decimals other than the feed's own, so a repointed proxy can't rescale amounts", () => {
    expect(fxProblem("EUR", fresh({ decimals: 18 }), NOW)).toBe("wrong-decimals");
    expect(fxProblem("PHP", { answer: FX_REFERENCE.PHP, decimals: 8, updatedAt: NOW }, NOW)).toBe("wrong-decimals");
    expect(fxProblem("PHP", { answer: FX_REFERENCE.PHP, decimals: 18, updatedAt: NOW }, NOW)).toBeNull();
  });

  it("keeps each answer within a fifth to five times its reference, edges included", () => {
    const ref = FX_REFERENCE.EUR;
    expect(fxProblem("EUR", fresh({ answer: ref * 5n }), NOW)).toBeNull();
    expect(fxProblem("EUR", fresh({ answer: ref * 5n + 1n }), NOW)).toBe("out-of-band");
    expect(fxProblem("EUR", fresh({ answer: ref / 5n + 1n }), NOW)).toBeNull();
    expect(fxProblem("EUR", fresh({ answer: ref / 5n - 1n }), NOW)).toBe("out-of-band");
    // A proxy repointed at another currency: yen where euros should be.
    expect(fxProblem("EUR", fresh({ answer: FX_REFERENCE.JPY }), NOW)).toBe("out-of-band");
  });

  it("judges USDC by its own decimals and reference", () => {
    expect(fxProblem("USDC", { answer: 97_000_000n, decimals: 8, updatedAt: NOW }, NOW)).toBeNull();
    expect(fxProblem("USDC", { answer: 97_000_000n, decimals: 6, updatedAt: NOW }, NOW)).toBe("wrong-decimals");
  });

  it("judges ETH by its own reference, and ages it out after three hours, not five days", () => {
    const eth = (updatedAt: number, answer = FX_REFERENCE.ETH): FxAnswer => ({ answer, decimals: 8, updatedAt });
    expect(fxProblem("ETH", eth(NOW - ETH_USD_MAX_AGE_SECONDS), NOW)).toBeNull();
    expect(fxProblem("ETH", eth(NOW - ETH_USD_MAX_AGE_SECONDS - 1), NOW)).toBe("stale");
    expect(fxProblem("ETH", eth(NOW, FX_REFERENCE.ETH * 5n + 1n), NOW)).toBe("out-of-band");
    expect(fxProblem("ETH", { ...eth(NOW), decimals: 18 }, NOW)).toBe("wrong-decimals");
    expect(ETH_USD_MAX_AGE_SECONDS).toBe(10_800);
  });

  it("has a reference and a feed for every currency", () => {
    for (const code of FX_CODES) {
      expect(FX_FEEDS[code]).toBe(CHAINLINK_FEEDS[code]);
      expect(FX_REFERENCE[code]).toBeGreaterThan(0n);
    }
  });
});
