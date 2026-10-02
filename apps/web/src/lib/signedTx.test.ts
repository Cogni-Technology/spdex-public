import { describe, expect, it } from "vitest";
import { addressOfKey, generateSpendingKey, signPrepared } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { readSignedTransaction, signedMismatch } from "./signedTx.js";

const TO = "0x2222222222222222222222222222222222222222" as Address;

async function signed(fees: { type: "legacy"; gasPrice: bigint } | { type: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  const key = generateSpendingKey();
  const { raw } = await signPrepared(key, {
    from: addressOfKey(key),
    chainId: 690069,
    nonce: 7,
    to: TO,
    data: "0xdeadbeef" as Hex,
    value: 12_345n,
    gas: 400_000n,
    fees,
  });
  return raw;
}

describe("reading what a wallet signed", () => {
  it("reads a real legacy transaction's every field, its chain from EIP-155", async () => {
    expect(readSignedTransaction(await signed({ type: "legacy", gasPrice: 2_000_000_000n }))).toEqual({
      type: "legacy",
      chainId: 690069n,
      nonce: 7n,
      gasPrice: 2_000_000_000n,
      gas: 400_000n,
      to: TO,
      value: 12_345n,
      data: "0xdeadbeef",
    });
  });

  it("reads no EIP-1559 transaction: a request with an exact price never comes back as one", async () => {
    expect(readSignedTransaction(await signed({ type: "eip1559", maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }))).toBeNull();
  });

  it("reads nothing from bytes that aren't a whole transaction", () => {
    for (const raw of ["0x", "0xf86b0180", "0xzz", "nothex", "0xc0", "0xc10000"]) expect(readSignedTransaction(raw)).toBeNull();
  });

  it("says what differs, and nothing when it doesn't", async () => {
    const read = readSignedTransaction(await signed({ type: "legacy", gasPrice: 2_000_000_000n }));
    const asked = { to: TO, data: "0xDEADBEEF", value: 12_345n, chainId: 690069n, nonce: 7n, gas: 400_000n, gasPrice: 2_000_000_000n };
    expect(signedMismatch(read, asked)).toBeNull();
    expect(signedMismatch(read, { ...asked, gas: 400_001n })).toBe("it signed a different gas limit");
    expect(signedMismatch(read, { ...asked, gas: null, gasPrice: null, nonce: 8n })).toBe("it signed a different nonce");
    expect(signedMismatch(null, asked)).toBe("its signed transaction couldn't be read");
  });
});
