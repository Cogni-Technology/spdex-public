/**
 * How `httpRpc` reports an error the endpoint answered: the method and the
 * message, the JSON-RPC code, and the error's data as the endpoint sent it.
 *
 * The data is what callers decode a revert from. The fork suite checks what
 * a real node sends; this checks that nothing is lost or invented on the way.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi, type Hex } from "viem";
import { Multicall3Reader, RATE_LIMIT_RETRY_MS, httpRpc, type JsonRpc } from "./reader.js";

/** `Error("OLD")`, as a v3 pool reverts when its history does not reach back far enough. */
const OLD =
  "0x08c379a0" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "4f4c440000000000000000000000000000000000000000000000000000000000";

/** A fetch that answers every request with `body`, and remembers what it was asked. */
function answering(body: unknown) {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return { json: async () => body };
  });
  return requests;
}

async function thrown(promise: Promise<unknown>): Promise<Error & { code?: unknown; data?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: unknown; data?: unknown };
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpRpc", () => {
  it("returns the result of an answered request", async () => {
    const requests = answering({ jsonrpc: "2.0", id: 1, result: "0x2a" });
    await expect(httpRpc("http://node.invalid")("eth_chainId", [])).resolves.toBe("0x2a");
    expect(requests).toEqual([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }]);
  });

  it("attaches the revert data an endpoint sends, exactly as it sent it", async () => {
    answering({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: OLD", data: OLD } });
    const error = await thrown(httpRpc("http://node.invalid")("eth_call", [{}, "latest"]));
    expect(error.message).toBe("eth_call: execution reverted: OLD");
    expect(error.code).toBe(3);
    expect(error.data).toBe(OLD);
  });

  it("passes data that is not a hex string through untouched", async () => {
    // Endpoints disagree about what goes in `data`; some send prose. Deciding
    // what it means is the caller's business, so it arrives as sent.
    answering({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "reverted", data: { reason: "OLD" } } });
    const error = await thrown(httpRpc("http://node.invalid")("eth_call", [{}, "latest"]));
    expect(error.data).toEqual({ reason: "OLD" });
  });

  it("adds no data, and no code, that the endpoint did not send", async () => {
    answering({ jsonrpc: "2.0", id: 1, error: { message: "rate limit exceeded" } });
    const error = await thrown(httpRpc("http://node.invalid")("eth_call", [{}, "latest"]));
    expect(error.message).toBe("eth_call: rate limit exceeded");
    expect("data" in error).toBe(false);
    expect("code" in error).toBe(false);
  });

  it("throws what fetch threw when no answer came back", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = await thrown(httpRpc("http://node.invalid")("eth_chainId", []));
    expect(error).toBeInstanceOf(TypeError);
    expect("data" in error).toBe(false);
  });
});

/** A fetch that answers each request with the next of `answers` (a status and a body, raw text or JSON), and counts them. */
function statuses(answers: { status: number; body: unknown }[]) {
  let asked = 0;
  vi.stubGlobal("fetch", async () => {
    const { status, body } = answers[Math.min(asked, answers.length - 1)]!;
    asked += 1;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return () => asked;
}

describe("httpRpc, when the HTTP status says no", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says which status, not a JSON parse error, when the body isn't JSON", async () => {
    statuses([{ status: 403, body: "<html>Forbidden</html>" }]);
    const error = await thrown(httpRpc("http://node.invalid")("eth_chainId", []));
    expect(error.message).toBe("eth_chainId: HTTP 403");
    expect((error as { status?: unknown }).status).toBe(403);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it("throws a body that isn't a JSON-RPC answer, with its message, rather than returning nothing", async () => {
    // Alchemy's monthly cap, as it answers it: HTTP 429 with its own JSON.
    const capped = { code: 429, message: "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service." };
    statuses([{ status: 429, body: capped }]);
    const error = await thrown(httpRpc("http://node.invalid", { retryAfterMs: 0 })("eth_blockNumber", []));
    expect(error.message).toBe(`eth_blockNumber: HTTP 429: ${capped.message}`);
    expect((error as { status?: unknown }).status).toBe(429);
    expect("code" in error).toBe(false);
  });

  it("keeps a JSON-RPC error's own message and code, and adds the status", async () => {
    statuses([{ status: 403, body: { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Origin not on whitelist." } } }]);
    const error = await thrown(httpRpc("http://node.invalid")("eth_chainId", []));
    expect(error.message).toBe("eth_chainId: Origin not on whitelist.");
    expect(error.code).toBe(-32600);
    expect((error as { status?: unknown }).status).toBe(403);
  });

  it("still returns a result sent with a failing status", async () => {
    statuses([{ status: 500, body: { jsonrpc: "2.0", id: 1, result: "0x1" } }]);
    await expect(httpRpc("http://node.invalid")("eth_chainId", [])).resolves.toBe("0x1");
  });

  it("asks once more, after a pause, when the service is busy (HTTP 429)", async () => {
    vi.useFakeTimers();
    const asked = statuses([
      { status: 429, body: { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Your app has exceeded its compute units per second capacity." } } },
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0x2a" } },
    ]);
    const answer = httpRpc("http://node.invalid")("eth_blockNumber", []);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe("0x2a");
    expect(asked()).toBe(2);
  });

  it("asks only once more: a second 429 is thrown, with its code and status", async () => {
    vi.useFakeTimers();
    const busy = { status: 429, body: { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Your app has exceeded its compute units per second capacity." } } };
    const asked = statuses([busy, busy, busy]);
    const answer = thrown(httpRpc("http://node.invalid")("eth_blockNumber", []));
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS * 5);
    const error = await answer;
    expect(error.message).toBe("eth_blockNumber: Your app has exceeded its compute units per second capacity.");
    expect(error.code).toBe(429);
    expect((error as { status?: unknown }).status).toBe(429);
    expect(asked()).toBe(2);
  });

  it("doesn't retry any other status, or when told not to", async () => {
    const asked = statuses([{ status: 503, body: "Service Unavailable" }]);
    await expect(httpRpc("http://node.invalid")("eth_chainId", [])).rejects.toThrow("eth_chainId: HTTP 503");
    expect(asked()).toBe(1);
    const once = statuses([{ status: 429, body: "Too Many Requests" }]);
    await expect(httpRpc("http://node.invalid", { retryAfterMs: 0 })("eth_chainId", [])).rejects.toThrow("eth_chainId: HTTP 429");
    expect(once()).toBe(1);
  });
});

const AGGREGATE3 = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/**
 * An endpoint that answers every aggregate3 with one successful word per call,
 * and remembers the block and gas each eth_call asked for.
 */
function multicallEndpoint() {
  const asked: { block: unknown; gas: unknown; calls: number }[] = [];
  const rpc: JsonRpc = async (method, params) => {
    expect(method).toBe("eth_call");
    const [call, block] = params as [{ data: Hex; gas: string }, unknown];
    // After the selector, aggregate3's calldata is the array's offset, then its length.
    const calls = Number.parseInt(call.data.slice(10 + 64, 10 + 128), 16);
    asked.push({ block, gas: call.gas, calls });
    const answers = Array.from({ length: calls }, () => ({ success: true, returnData: "0x01" as Hex }));
    return encodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", result: answers });
  };
  return { rpc, asked };
}

const calls = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ to: `0x${(i + 1).toString(16).padStart(40, "0")}` as const, data: "0x12345678" as const }));

describe("Multicall3Reader", () => {
  it("reads at latest, 40 calls a batch, under a 200M gas ceiling, when nothing says otherwise", async () => {
    const { rpc, asked } = multicallEndpoint();
    const answers = await new Multicall3Reader(rpc).multicall(calls(41));
    expect(answers).toHaveLength(41);
    expect(asked).toEqual([
      { block: "latest", gas: "0xbebc200", calls: 40 },
      { block: "latest", gas: "0xbebc200", calls: 1 },
    ]);
  });

  it("pins every batch of one read to the block that read names", async () => {
    // A total summed over many batches has to describe one state of the chain.
    const { rpc, asked } = multicallEndpoint();
    await new Multicall3Reader(rpc, { batchSize: 2 }).multicall(calls(5), { blockTag: "0x18cba80" });
    expect(asked.map((a) => a.block)).toEqual(["0x18cba80", "0x18cba80", "0x18cba80"]);
  });

  it("uses the reader's own block unless a read names another", async () => {
    const { rpc, asked } = multicallEndpoint();
    const reader = new Multicall3Reader(rpc, { blockTag: "0x10" });
    await reader.multicall(calls(1));
    await reader.multicall(calls(1), { blockTag: "latest" });
    await reader.multicall(calls(1), { blockTag: "0x0" });
    expect(asked.map((a) => a.block)).toEqual(["0x10", "latest", "0x0"]);
  });

  it("takes a read's own batch size and gas ceiling over the reader's", async () => {
    const { rpc, asked } = multicallEndpoint();
    const reader = new Multicall3Reader(rpc, { batchSize: 40, gasLimit: 1_000_000n });
    await reader.multicall(calls(450), { batchSize: 200, gas: 30_000_000n });
    await reader.multicall(calls(3));
    expect(asked).toEqual([
      { block: "latest", gas: "0x1c9c380", calls: 200 },
      { block: "latest", gas: "0x1c9c380", calls: 200 },
      { block: "latest", gas: "0x1c9c380", calls: 50 },
      { block: "latest", gas: "0xf4240", calls: 3 },
    ]);
  });

  it("refuses a block that isn't latest or a block number, before asking the endpoint anything", async () => {
    const { rpc, asked } = multicallEndpoint();
    const reader = new Multicall3Reader(rpc);
    for (const blockTag of ["0x01", "0X10", "26000000", "0x", "pending", "0x1g"]) {
      await expect(reader.multicall(calls(1), { blockTag: blockTag as Hex })).rejects.toThrow(RangeError);
    }
    expect(() => new Multicall3Reader(rpc, { blockTag: "finalized" as Hex })).toThrow(RangeError);
    expect(asked).toEqual([]);
  });

  it("refuses a batch size that would never finish or would slice oddly", async () => {
    const { rpc, asked } = multicallEndpoint();
    const reader = new Multicall3Reader(rpc);
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      await expect(reader.multicall(calls(3), { batchSize })).rejects.toThrow(RangeError);
    }
    expect(() => new Multicall3Reader(rpc, { batchSize: 0 })).toThrow(RangeError);
    expect(asked).toEqual([]);
  });

  it("still answers an empty read without a request", async () => {
    const { rpc, asked } = multicallEndpoint();
    await expect(new Multicall3Reader(rpc).multicall([], { blockTag: "0x1" })).resolves.toEqual([]);
    expect(asked).toEqual([]);
  });
});
