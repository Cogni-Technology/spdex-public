/**
 * The currency feeds, USDC/USD and ETH/USD against the pinned fork: every one
 * answers at the pinned block, in one request, with the decimals the build
 * expects and inside its band.
 *
 * Read at the pinned block and never at the head. The fork's clock follows
 * the wall clock, so a fork left running for about a hundred hours reads
 * every feed as stale at the head, which is the app behaving correctly and no
 * reason for this suite to fail. At the pinned block the answers are fixed,
 * so they must equal `FX_REFERENCE` exactly: that is what the references are.
 *
 * Requires a running fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { CHAINLINK_FEEDS } from "../../src/constants.js";
import { FX_CODES, FX_FEEDS, FX_REFERENCE, FX_REFERENCE_BLOCK, fxProblem, readFxRates } from "../../src/fx.js";
import { Multicall3Reader, httpRpc, type JsonRpc } from "../../src/reader.js";

const FORK_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const PINNED = BigInt(process.env.SPDEX_FORK_BLOCK ?? "26000000");
const PINNED_TAG = `0x${PINNED.toString(16)}` as const;

const rpc = httpRpc(FORK_URL);

/** The endpoint, counting what it is asked. */
function counted(inner: JsonRpc) {
  const methods: string[] = [];
  const wrapped: JsonRpc = (method, params) => {
    methods.push(method);
    return inner(method, params);
  };
  return { rpc: wrapped, methods };
}

beforeAll(async () => {
  try {
    await rpc("eth_chainId", []);
  } catch (error) {
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

describe("the currency feeds at the pinned block", () => {
  it("are the block the references were taken at", () => {
    // The references are this block's answers. If the fork is ever pinned
    // elsewhere, they have to be read again, not this test relaxed.
    expect(PINNED).toBe(FX_REFERENCE_BLOCK);
  });

  it("all answer in one eth_call, inside their bands, with the decimals the build expects", async () => {
    const endpoint = counted(rpc);
    const read = await readFxRates(new Multicall3Reader(endpoint.rpc), { blockTag: PINNED_TAG });

    expect(endpoint.methods).toEqual(["eth_call"]);
    expect(read.block).toBe(PINNED);

    const header = (await rpc("eth_getBlockByNumber", [PINNED_TAG, false])) as { timestamp: string };
    expect(read.chainTime).toBe(Number(BigInt(header.timestamp)));

    for (const code of FX_CODES) {
      const answer = read.rates[code];
      expect(answer, code).toBeDefined();
      expect(answer!.decimals, code).toBe(FX_FEEDS[code].decimals);
      expect(answer!.answer, code).toBe(FX_REFERENCE[code]);
      expect(fxProblem(code, answer, read.chainTime), code).toBeNull();
    }
    expect(read.usdc).not.toBeNull();
    expect(read.usdc!.answer).toBe(FX_REFERENCE.USDC);
    expect(fxProblem("USDC", read.usdc, read.chainTime)).toBeNull();
    expect(read.eth).not.toBeNull();
    expect(read.eth!.answer).toBe(FX_REFERENCE.ETH);
    expect(fxProblem("ETH", read.eth, read.chainTime)).toBeNull();
  });

  it("each read feed is the pair its name says", async () => {
    // description() through the same Multicall3 path, so a proxy repointed at
    // another pair fails here by name rather than as a number in a band.
    const reader = new Multicall3Reader(rpc);
    const names = [...FX_CODES, "USDC", "ETH"] as const;
    const results = await reader.multicall(
      names.map((name) => ({ to: CHAINLINK_FEEDS[name].address, data: "0x7284e416" as const })),
      { blockTag: PINNED_TAG, batchSize: names.length },
    );
    names.forEach((name, i) => expect(decodeString(results[i]!), name).toBe(`${name} / USD`));
  });
});

/** An ABI-encoded `string` return value. */
function decodeString(hex: string): string {
  const body = hex.slice(2);
  const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
  const length = Number.parseInt(body.slice(offset, offset + 64), 16) * 2;
  const bytes = (body.slice(offset + 64, offset + 64 + length).match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
