import { describe, expect, it } from "vitest";
import type { DcaLedgerEntry } from "../../lib/dca/ledger.js";
import { badgeHash } from "./History.js";

const NOW = 1_790_000_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const entry = (at: number): DcaLedgerEntry => ({
  planId: "p",
  chainId: 1,
  owner: "0x1111111111111111111111111111111111111111",
  signer: "0x1111111111111111111111111111111111111111",
  startedAt: 0,
  buysDone: 1,
  committed: "1",
  lastSlot: 0,
  consecutiveFailures: 0,
  measured: { buys: 1, amountIn: "1", amountOut: "1" },
  runs: [{ slot: 0, at, status: "confirmed", amountIn: "1", hashes: [hash(1), hash(2)] }],
});

describe("which buy the history's badge follows", () => {
  it("is the newest row's buy transaction, while that buy is under a day old", () => {
    const newest = { kind: "bought", hashes: [hash(1), hash(2)] };
    expect(badgeHash(entry(NOW - 60_000), newest, NOW)).toBe(hash(2));
    expect(badgeHash(entry(NOW - 86_400_000), newest, NOW)).toBeNull();
  });

  it("is nothing for a row that isn't a buy, or has no transaction", () => {
    expect(badgeHash(entry(NOW), { kind: "skipped", hashes: [hash(2)] }, NOW)).toBeNull();
    expect(badgeHash(entry(NOW), { kind: "bought", hashes: [] }, NOW)).toBeNull();
    expect(badgeHash(null, { kind: "bought", hashes: [hash(2)] }, NOW)).toBeNull();
    expect(badgeHash(entry(NOW), undefined, NOW)).toBeNull();
  });
});
