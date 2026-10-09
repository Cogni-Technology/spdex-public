/**
 * What a real node sends with a reverted call, and that `httpRpc` keeps it.
 *
 * The unit tests script the endpoint's answer. This asks the fork for a
 * revert with a known reason and checks the reason arrives in `data`, ready
 * to decode, rather than only inside the message.
 *
 * Requires a running fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { decodeErrorResult, encodeFunctionData, parseAbi } from "viem";
import { httpRpc } from "../../src/reader.js";

const FORK_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const rpc = httpRpc(FORK_URL);

/** SPX's 0.3% Uniswap v3 pool. */
const POOL = "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3";

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

describe("httpRpc against a real node", () => {
  it("keeps a revert's own data, which decodes to the contract's reason", async () => {
    // Asked for an average reaching back further than its history, a v3 pool
    // reverts with "OLD".
    const data = encodeFunctionData({
      abi: parseAbi(["function observe(uint32[] secondsAgos) view returns (int56[], uint160[])"]),
      functionName: "observe",
      args: [[0xffff_ffff, 0]],
    });

    let caught: unknown;
    try {
      await rpc("eth_call", [{ to: POOL, data }, "latest"]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const { data: revert } = caught as { data?: unknown };
    expect(typeof revert).toBe("string");
    const decoded = decodeErrorResult({ abi: [], data: revert as `0x${string}` });
    expect(decoded.errorName).toBe("Error");
    expect(decoded.args).toEqual(["OLD"]);
  });
});
