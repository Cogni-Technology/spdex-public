/**
 * The ERC-20 reads, against a scripted endpoint.
 *
 * Only `totalSupply` is here so far: it feeds the ticker's "% to flip", and
 * the thing worth pinning is the absence — an answer that isn't a number must
 * be a refusal, because read as zero it would put "0% to flip" on screen as a
 * measurement.
 */

import { describe, expect, it } from "vitest";
import { TOKENS, type JsonRpc } from "@spdex/chain";
import { totalSupply } from "./erc20.js";

/** An endpoint that answers every call with `answer`, and remembers what it was asked. */
function endpoint(answer: unknown): { rpc: JsonRpc; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: JsonRpc = async (method, params) => {
    calls.push({ method, params });
    return answer;
  };
  return { rpc, calls };
}

describe("totalSupply", () => {
  it("asks the token for totalSupply() at the latest block and reads the word it returns", async () => {
    // What the fork's SPX answers: a billion tokens at 8 decimals.
    const { rpc, calls } = endpoint(`0x${(10n ** 17n).toString(16).padStart(64, "0")}`);
    await expect(totalSupply(rpc, TOKENS.SPX.address)).resolves.toBe(10n ** 17n);
    expect(calls).toEqual([
      { method: "eth_call", params: [{ to: TOKENS.SPX.address, data: "0x18160ddd" }, "latest"] },
    ]);
  });

  it("refuses an empty answer rather than calling it zero", async () => {
    // "0x" is what a call to an address with no code returns, as SPX's
    // address would on a chain where SPX doesn't exist.
    await expect(totalSupply(endpoint("0x").rpc, TOKENS.SPX.address)).rejects.toThrow(/total supply/);
    await expect(totalSupply(endpoint(null).rpc, TOKENS.SPX.address)).rejects.toThrow(/total supply/);
    await expect(totalSupply(endpoint("0xnot-hex").rpc, TOKENS.SPX.address)).rejects.toThrow(/total supply/);
  });

  it("passes a failed request on as a failure", async () => {
    const rpc: JsonRpc = async () => {
      throw new Error("rate limited");
    };
    await expect(totalSupply(rpc, TOKENS.SPX.address)).rejects.toThrow("rate limited");
  });
});
