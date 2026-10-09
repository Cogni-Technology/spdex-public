/**
 * Swap-log decoding.
 *
 * Volume is the one pool statistic a user compares venues with, so a decoder
 * that quietly double-counts or drops a side produces a number that looks
 * plausible and ranks pools wrongly. These cases are built from the event
 * layouts by hand rather than from a fixture, so the test states the ABI it
 * believes in.
 */

import { describe, expect, it } from "vitest";
import { TOPICS } from "./constants.js";
import { decodeSwapAmounts, summariseLogError } from "./logs.js";

const w = (value: bigint) => value.toString(16).padStart(64, "0");
/** Two's-complement, for v3's signed amounts. */
const signed = (value: bigint) => w(value < 0n ? (1n << 256n) + value : value);

describe("decodeSwapAmounts", () => {
  it("sums both sides of a Uniswap v2 Swap", () => {
    // amount0In, amount1In, amount0Out, amount1Out
    const log = {
      topics: [TOPICS.uniV2Swap],
      data: `0x${w(100n)}${w(0n)}${w(0n)}${w(250n)}`,
    };
    expect(decodeSwapAmounts(log)).toEqual({ amount0: 100n, amount1: 250n });
  });

  it("handles a v2 swap in the other direction", () => {
    const log = {
      topics: [TOPICS.uniV2Swap],
      data: `0x${w(0n)}${w(250n)}${w(100n)}${w(0n)}`,
    };
    expect(decodeSwapAmounts(log)).toEqual({ amount0: 100n, amount1: 250n });
  });

  it("takes magnitudes for a Uniswap v3 Swap", () => {
    // amount0 positive (into the pool), amount1 negative (out of it).
    const log = {
      topics: [TOPICS.uniV3Swap],
      data: `0x${signed(100n)}${signed(-250n)}${w(0n)}${w(0n)}${w(0n)}`,
    };
    expect(decodeSwapAmounts(log)).toEqual({ amount0: 100n, amount1: 250n });
  });

  it("takes magnitudes in the other direction too", () => {
    const log = {
      topics: [TOPICS.uniV3Swap],
      data: `0x${signed(-100n)}${signed(250n)}${w(0n)}${w(0n)}${w(0n)}`,
    };
    expect(decodeSwapAmounts(log)).toEqual({ amount0: 100n, amount1: 250n });
  });

  it("ignores an event it does not recognise", () => {
    // Guessing would inflate the very number pools are ranked by.
    expect(decodeSwapAmounts({ topics: [TOPICS.transfer], data: `0x${w(1n)}` })).toBeNull();
    expect(decodeSwapAmounts({ topics: [], data: "0x" })).toBeNull();
    expect(decodeSwapAmounts({})).toBeNull();
  });

  it("ignores a truncated payload rather than reading past it", () => {
    expect(decodeSwapAmounts({ topics: [TOPICS.uniV2Swap], data: `0x${w(1n)}` })).toBeNull();
    expect(decodeSwapAmounts({ topics: [TOPICS.uniV3Swap], data: `0x${w(1n)}` })).toBeNull();
  });

  it("uses distinct topics for the two venues", () => {
    // One eth_getLogs covers both only because these differ.
    expect(TOPICS.uniV2Swap).not.toBe(TOPICS.uniV3Swap);
  });
});

describe("summariseLogError", () => {
  it("recognises a block-range limit behind layers of wrapping", () => {
    // What a hosted endpoint actually returns, via anvil's fork transport:
    // several hundred characters of nested JSON. Pasting that into a panel is
    // not honesty, it is refusing to decide what matters.
    const real =
      'Fork Error: Transport(HttpError(HttpError { status: 400, body: "{\\"jsonrpc\\":\\"2.0\\",' +
      '\\"error\\":{\\"code\\":-32600,\\"message\\":\\"Under the Free tier plan, you can make ' +
      'eth_getLogs requests with up to a 10 block range. Based on your parameters, this block ' +
      'range should work: [0x18c9f88, 0x18c9f91]\\"}}" }))';
    expect(summariseLogError(new Error(real))).toBe(
      "this endpoint limits how many blocks of logs it will serve at once",
    );
  });

  it("recognises an endpoint that has no eth_getLogs at all", () => {
    expect(summariseLogError(new Error("the method eth_getLogs is not supported"))).toBe(
      "this endpoint does not support eth_getLogs",
    );
  });

  it("recognises a timeout", () => {
    expect(summariseLogError(new Error("request timed out"))).toBe("the log query timed out");
  });

  it("says a rate limit or a used-up allowance plainly, ahead of the block-range rule", () => {
    const busy = "the network service is turning requests away for now";
    // Alchemy's throughput 429, as httpRpc throws it: the code and status attached.
    const throughput = Object.assign(
      new Error(
        "eth_getLogs: Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out https://docs.alchemy.com/reference/throughput",
      ),
      { code: 429, status: 429 },
    );
    expect(summariseLogError(throughput)).toBe(busy);
    // "limit exceeded" is in it, and it is still no block-range limit.
    expect(summariseLogError(new Error("eth_getLogs: HTTP 429: Monthly capacity limit exceeded."))).toBe(busy);
    expect(summariseLogError(new Error("eth_getLogs: HTTP 429"))).toBe(busy);
    expect(summariseLogError(new Error("eth_getLogs: daily request count exceeded, request rate limited"))).toBe(busy);
    expect(summariseLogError(Object.assign(new Error("eth_getLogs: HTTP 429"), { status: 429 }))).toBe(busy);
    // A range limit that says "limit exceeded" is still one.
    expect(summariseLogError(new Error("eth_getLogs: query limit exceeded"))).toBe(
      "this endpoint limits how many blocks of logs it will serve at once",
    );
  });

  it("says a request that got no answer plainly, not in the browser's words", () => {
    const none = "the network service didn't answer";
    // What fetch rejects with, with no method in front: Chrome, Firefox, Safari.
    expect(summariseLogError(new TypeError("Failed to fetch"))).toBe(none);
    expect(summariseLogError(new TypeError("NetworkError when attempting to fetch resource."))).toBe(none);
    expect(summariseLogError(new TypeError("Load failed"))).toBe(none);
    // A gateway's error page in place of a JSON-RPC answer.
    expect(summariseLogError(Object.assign(new Error("eth_getLogs: HTTP 502"), { status: 502 }))).toBe(none);
    expect(summariseLogError(new Error("eth_getLogs: HTTP 504"))).toBe(none);
    // A 5xx that says what it is keeps the more specific clause.
    expect(summariseLogError(new Error("eth_getLogs: HTTP 500: query returned more than 10000 results"))).toBe(
      "this endpoint limits how many blocks of logs it will serve at once",
    );
  });

  it("drops the method the transport puts in front of an unrecognised message", () => {
    expect(summariseLogError(new Error("eth_getLogs: header not found"))).toBe("header not found");
    expect(summariseLogError(new Error("header not found"))).toBe("header not found");
  });

  it("keeps an unrecognised message, but keeps it short", () => {
    const long = "x".repeat(500);
    const summary = summariseLogError(new Error(long));
    expect(summary.length).toBeLessThanOrEqual(121);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("survives a non-Error", () => {
    expect(summariseLogError("plain string")).toBe("plain string");
    expect(summariseLogError(undefined)).toBe("undefined");
  });
});
