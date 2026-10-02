/**
 * The host's chain reader.
 *
 * Modules ask for reads in batches; this is what actually performs them. Two
 * properties matter to everything above it:
 *
 * **Failures are positional, not fatal.** A quoter call against a pool with no
 * liquidity reverts, and that is ordinary — it means "no route here", not "the
 * batch failed". `aggregate3` with `allowFailure` lets one call revert without
 * destroying its siblings, and a failed entry comes back as "0x" so results
 * stay index-aligned with the calls that produced them. A module that assumed
 * alignment while entries silently dropped would misattribute quotes to pools.
 *
 * **Batching is the host's business.** Modules never see Multicall3; they hand
 * over a list and get a list back. That keeps the boundary to one primitive and
 * leaves the host free to change how batching works without touching a single
 * signed module.
 */

import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS } from "./constants.js";

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export type JsonRpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * The block a read is answered at: a block number as a JSON-RPC quantity
 * ("0x18cba80"), or "latest".
 */
export type ReadBlockTag = Hex | "latest";

export interface Multicall3ReaderOptions {
  /** Calls per batch. Quoter calls are gas-heavy, so this stays modest. */
  batchSize?: number;
  multicall3?: Address;
  /** Gas ceiling for the eth_call carrying a batch. */
  gasLimit?: bigint;
  /** The block every read is answered at, unless a read names its own. "latest" when unset. */
  blockTag?: ReadBlockTag;
}

/**
 * One read's own settings, each overriding the reader's.
 *
 * Per read rather than per reader, because the readers that need them share
 * one reader with everything else. Figures that are added up across many
 * batches (the vault totals, a trade's value at its block) must all describe
 * one state of the chain, so every batch of that read carries the same block;
 * and a read of hundreds of cheap view calls can take far bigger batches than
 * the gas-heavy quoter calls the defaults are sized for.
 */
export interface MulticallOptions {
  blockTag?: ReadBlockTag;
  batchSize?: number;
  /** Gas ceiling for each eth_call carrying a batch of this read. */
  gas?: bigint;
}

export class Multicall3Reader {
  readonly #batchSize: number;
  readonly #multicall3: Address;
  readonly #gasLimit: bigint;
  readonly #blockTag: ReadBlockTag;

  constructor(
    private readonly rpc: JsonRpc,
    options: Multicall3ReaderOptions = {},
  ) {
    this.#batchSize = checkedBatchSize(options.batchSize ?? 40);
    this.#multicall3 = options.multicall3 ?? CONTRACTS.multicall3;
    this.#gasLimit = options.gasLimit ?? 200_000_000n;
    this.#blockTag = checkedBlockTag(options.blockTag ?? "latest");
  }

  async multicall(calls: { to: Address; data: Hex }[], options: MulticallOptions = {}): Promise<string[]> {
    const batchSize = checkedBatchSize(options.batchSize ?? this.#batchSize);
    const blockTag = checkedBlockTag(options.blockTag ?? this.#blockTag);
    const gas = options.gas ?? this.#gasLimit;
    if (calls.length === 0) return [];

    const results: string[] = [];
    for (let i = 0; i < calls.length; i += batchSize) {
      const chunk = calls.slice(i, i + batchSize);
      results.push(...(await this.#aggregate(chunk, blockTag, gas)));
    }
    return results;
  }

  async #aggregate(calls: { to: Address; data: Hex }[], blockTag: ReadBlockTag, gas: bigint): Promise<string[]> {
    const data = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      args: [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))],
    });

    // Unpinned reads still send the literal "latest": the keeper's report
    // pins its reads by rewriting exactly that parameter on the way out.
    const raw = (await this.rpc("eth_call", [
      { to: this.#multicall3, data, gas: `0x${gas.toString(16)}` },
      blockTag,
    ])) as Hex;

    const decoded = decodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      data: raw,
    });

    // "0x" for a reverted call keeps the array index-aligned with the request.
    return decoded.map((r) => (r.success ? r.returnData : "0x"));
  }
}

/** A batch size of zero would never advance, and a fraction would slice oddly. */
function checkedBatchSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`batch size must be a whole number of calls, at least 1 (got ${size})`);
  return size;
}

/**
 * A malformed tag is refused here rather than sent. Endpoints disagree about
 * what they do with "0x01" or a bare decimal, and a read quietly answered at
 * some other block is worse than one that fails.
 */
function checkedBlockTag(tag: ReadBlockTag): ReadBlockTag {
  if (tag === "latest" || /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(tag)) return tag;
  throw new RangeError(`a block to read at must be "latest" or a block number such as 0x18cba80 (got ${JSON.stringify(tag)})`);
}

/** How long `httpRpc` waits before its one retry of a request answered HTTP 429. */
export const RATE_LIMIT_RETRY_MS = 1_200;

/**
 * Minimal JSON-RPC over fetch. No dependency on a wallet or provider object.
 *
 * An error the endpoint *answered* is thrown as `${method}: ${message}`, with
 * the JSON-RPC `code` attached when there is one, so a caller can tell "the
 * endpoint said no" (and which no: -32601 is "no such method") from a request
 * that never got an answer, which throws whatever `fetch` threw.
 *
 * The error's `data` is attached as well, as the endpoint sent it, when it sent
 * one. For a reverted `eth_call` or `eth_estimateGas` that is the revert itself,
 * ABI-encoded: `Error(string)`, a panic, or a contract's custom error. A caller
 * that can decode it (the keeper names a vault's errors this way) should not
 * have to dig a hex string out of the message. Endpoints word messages
 * differently, and some leave the data out of the message altogether.
 *
 * An answer with a failing HTTP status carries that `status` too. When its body
 * isn't a JSON-RPC answer (a gateway's HTML page, or Alchemy's
 * `{"code":429,"message":"Monthly capacity limit exceeded…"}`), it is thrown as
 * `${method}: HTTP ${status}`, with the body's `message` after it when it has
 * one, rather than as a JSON parse error or an undefined result.
 *
 * A request answered HTTP 429 (too many requests) is sent once more after
 * `retryAfterMs` (`RATE_LIMIT_RETRY_MS`), as Alchemy asks of its clients: a
 * shared service's burst limit is usually over by then. A 429 is a request
 * the service turned away without doing it, so sending it again is safe,
 * `eth_sendRawTransaction` included. One retry, not a loop: a service out of
 * capacity for the month answers the second time as it did the first.
 */
export function httpRpc(url: string, options: { retryAfterMs?: number } = {}): JsonRpc {
  const retryAfterMs = options.retryAfterMs ?? RATE_LIMIT_RETRY_MS;
  let id = 0;
  const post = (body: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  return async (method, params) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    let response = await post(body);
    if (response.status === 429 && retryAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      response = await post(body);
    }
    // Only a status the response actually reports: a stand-in without one reads as OK.
    const failed = response.ok === false;
    let json: { result?: unknown; error?: { message: string; code?: unknown; data?: unknown }; message?: unknown };
    try {
      json = (await response.json()) as typeof json;
    } catch (parseError) {
      if (failed) throw httpError(method, response.status);
      throw parseError;
    }
    if (json.error) {
      const error = new Error(`${method}: ${json.error.message}`);
      if (typeof json.error.code === "number") Object.assign(error, { code: json.error.code });
      if (json.error.data !== undefined) Object.assign(error, { data: json.error.data });
      if (failed) Object.assign(error, { status: response.status });
      throw error;
    }
    if (failed && !("result" in json)) {
      throw httpError(method, response.status, typeof json.message === "string" ? json.message : undefined);
    }
    return json.result;
  };
}

/** `${method}: HTTP ${status}`, and the body's own message when it had one, with the status attached. */
function httpError(method: string, status: number, message?: string): Error {
  return Object.assign(new Error(`${method}: HTTP ${status}${message ? `: ${message}` : ""}`), { status });
}
