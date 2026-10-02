/**
 * Waiting for a transaction, and following it when a wallet replaces it:
 * "Speed up" sends the same call again at the same nonce under a new hash,
 * "Cancel" sends something else there. Either way the first hash can never be
 * mined, so a wait that watched only it would say "not mined" about a swap
 * that went through.
 */

import { describe, expect, it } from "vitest";
import { TransactionReplaced, confirmTransaction } from "./wallet.js";

const FROM = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const SWAP = { to: ROUTER, input: "0x7ff36ab5", value: "0x2386f26fc10000" };
const ORIGINAL = `0x${"aa".repeat(32)}`;
const COPY = `0x${"bb".repeat(32)}`;
const FAST = { pollMs: 1, replacementCheckMs: 1, timeoutMs: 2_000 };

/**
 * A chain where `ORIGINAL` (nonce 5) is pending until `minedAfter` reads, and
 * then nonce 5 is mined in block 101 as `mined` (the original itself, or a
 * replacement with its own call).
 */
function chain(options: { visible?: boolean; mined?: { hash: string; to: string; input: string; value: string; status?: string } | null; minedAfter?: number }) {
  let reads = 0;
  const minedAfter = options.minedAfter ?? 3;
  const mined = options.mined === undefined ? { hash: ORIGINAL, ...SWAP } : options.mined;
  const done = () => reads > minedAfter && mined !== null;
  return async (method: string, params: unknown[]): Promise<unknown> => {
    reads += 1;
    switch (method) {
      case "eth_getTransactionReceipt":
        return done() && params[0] === mined!.hash ? { status: mined!.status ?? "0x1" } : null;
      case "eth_getTransactionByHash":
        return options.visible === false || params[0] !== ORIGINAL ? null : { from: FROM, nonce: "0x5", ...SWAP };
      case "eth_blockNumber":
        return done() ? "0x65" : "0x64";
      case "eth_getTransactionCount":
        return done() ? "0x6" : "0x5";
      case "eth_getBlockByNumber":
        return params[0] === "0x65" && done()
          ? { transactions: [{ hash: mined!.hash, from: FROM, nonce: "0x5", to: mined!.to, input: mined!.input, value: mined!.value }] }
          : { transactions: [] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
}

describe("confirmTransaction", () => {
  it("returns the hash it was given once that is mined", async () => {
    expect(await confirmTransaction(ORIGINAL, { rpc: chain({}), ...FAST })).toBe(ORIGINAL);
  });

  it("throws for a revert", async () => {
    await expect(confirmTransaction(ORIGINAL, { rpc: chain({ mined: { hash: ORIGINAL, ...SWAP, status: "0x0" } }), ...FAST })).rejects.toThrow(
      /reverted on chain/,
    );
  });

  it("follows a wallet's faster copy of the same call, and says so", async () => {
    const replaced: string[] = [];
    const mined = await confirmTransaction(ORIGINAL, {
      rpc: chain({ mined: { hash: COPY, ...SWAP }, minedAfter: 6 }),
      ...FAST,
      onReplaced: (hash) => replaced.push(hash),
    });
    expect(mined).toBe(COPY);
    expect(replaced).toEqual([COPY]);
  });

  it("refuses a replacement that makes some other call: the wallet cancelled it", async () => {
    const cancel = { hash: COPY, to: FROM, input: "0x", value: "0x0" };
    const error = await confirmTransaction(ORIGINAL, { rpc: chain({ mined: cancel, minedAfter: 6 }), ...FAST }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionReplaced);
    expect((error as TransactionReplaced).replacement).toBe(COPY);
  });

  it("waits for the receipt alone when the service never shows the transaction, as a private one", async () => {
    await expect(
      confirmTransaction(ORIGINAL, { rpc: chain({ visible: false, mined: null }), ...FAST, timeoutMs: 50 }),
    ).rejects.toThrow(/has not been mined after/);
  });
});
