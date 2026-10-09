/**
 * The one receipt reader: what it keeps of a node's answer, what it refuses,
 * and exactly which quantities it reads.
 */

import { describe, expect, it } from "vitest";
import { TOKENS, TOPICS } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { quantity, readBlockTime, readReceipt, readTxValue, topicAddress } from "./receipts.js";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const SPX = TOKENS.SPX.address.toLowerCase() as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

describe("quantity", () => {
  it("reads 0x and 1 to 64 hex digits, either case", () => {
    expect(quantity("0x0")).toBe(0n);
    expect(quantity("0x3B9aCa00")).toBe(1_000_000_000n);
    expect(quantity(`0x${"f".repeat(64)}`)).toBe(2n ** 256n - 1n);
    expect(quantity("0x0000000000000000000000000000000000000000000000000000000000000001")).toBe(1n);
  });

  it("refuses anything else, so the caller decides what an unreadable figure means", () => {
    for (const value of ["0x", "", "12", "0x12g", ` 0x1`, `0x${"f".repeat(65)}`, 12, 12n, null, undefined, {}]) {
      expect(quantity(value), String(value)).toBeNull();
    }
  });
});

describe("topicAddress", () => {
  it("is a topic's last 20 bytes, lowercase", () => {
    expect(topicAddress(`0x${"0".repeat(24)}${SPX.slice(2).toUpperCase()}`)).toBe(SPX);
  });
});

describe("reading a receipt", () => {
  const raw = {
    from: ME,
    status: "0x0",
    blockNumber: "0x64",
    blockHash: `0x${"AB".repeat(32)}`,
    gasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca00",
    logs: [
      { address: SPX.toUpperCase().replace("0X", "0x"), topics: [TOPICS.transfer.toUpperCase().replace("0X", "0x")], data: "0x01" },
      "junk",
      { address: SPX, topics: [], data: "0x", logIndex: "0x7" },
    ],
  };

  it("names the sender, the block, the fee and the outcome, lowercase, and keeps a log's index when given", async () => {
    const read = await readReceipt(async () => raw, hash(1));
    expect(read).toEqual({
      hash: hash(1),
      from: ME,
      status: "reverted",
      blockNumber: 100n,
      blockHash: `0x${"ab".repeat(32)}`,
      fee: 21_000n * 10n ** 9n,
      logs: [
        { address: SPX, topics: [TOPICS.transfer], data: "0x01" },
        { address: SPX, topics: [], data: "0x", logIndex: "0x7" },
      ],
    });
    expect((await readReceipt(async () => ({ ...raw, status: "0x1" }), hash(1)))?.status).toBe("success");
    // No status field predates Byzantium: read as success.
    expect((await readReceipt(async () => ({ ...raw, status: undefined }), hash(1)))?.status).toBe("success");
  });

  it("is null for a transaction the service doesn't know, and a refusal for a receipt it can't be", async () => {
    expect(await readReceipt(async () => null, hash(1))).toBeNull();
    await expect(readReceipt(async () => ({ ...raw, from: "nobody" }), hash(1))).rejects.toThrow("isn't one");
    await expect(readReceipt(async () => ({ ...raw, blockNumber: 100 }), hash(1))).rejects.toThrow("isn't one");
    await expect(readReceipt(async () => ({ ...raw, blockHash: null }), hash(1))).rejects.toThrow("names no block");
  });

  it("leaves the fee unknown when the receipt doesn't give it", async () => {
    expect((await readReceipt(async () => ({ ...raw, effectiveGasPrice: undefined }), hash(1)))?.fee).toBeNull();
  });

  it("reads a block's time and a transaction's value, or null", async () => {
    expect(await readBlockTime(async () => ({ timestamp: "0x68cb2d63" }), 1n)).toBe(0x68cb2d63);
    expect(await readBlockTime(async () => null, 1n)).toBeNull();
    expect(await readTxValue(async () => ({ value: "0x2386f26fc10000" }), hash(1))).toBe(10n ** 16n);
    expect(await readTxValue(async () => null, hash(1))).toBeNull();
  });
});
