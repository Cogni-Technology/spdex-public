import { describe, expect, it } from "vitest";
import { candidatesFromQuotes } from "./assemble.js";

const pool = (poolId: string) => ({ poolId, venueId: "venue-uniswap-v3" });
const quote = (poolId: string, amountIn: string, amountOut: string) => ({
  poolId,
  tokenIn: "0x" + "1".repeat(40),
  tokenOut: "0x" + "2".repeat(40),
  amountIn,
  amountOut,
  gasEstimate: "150000",
});

describe("candidatesFromQuotes", () => {
  it("groups a flat quote list into one ascending curve per pool", () => {
    const candidates = candidatesFromQuotes(
      [
        quote("0xaaa", "200", "190"),
        quote("0xbbb", "100", "99"),
        quote("0xaaa", "100", "98"),
        quote("0xbbb", "200", "195"),
      ],
      [pool("0xaaa"), pool("0xbbb")],
    );

    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.quotes.map((q) => q.amountIn)).toEqual([100n, 200n]);
    }
  });

  it("matches pool ids case-insensitively", () => {
    // Checksummed and lowercase forms of the same address must not become two pools.
    const candidates = candidatesFromQuotes([quote("0xAAA", "100", "99")], [pool("0xaaa")]);
    expect(candidates).toHaveLength(1);
  });

  it("discards quotes for pools the caller did not offer", () => {
    // The candidate set is the user's pool policy. A venue naming an extra pool
    // must not be able to widen it.
    const candidates = candidatesFromQuotes(
      [quote("0xaaa", "100", "99"), quote("0xevil", "100", "99999")],
      [pool("0xaaa")],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.poolId).toBe("0xaaa");
  });

  it("keeps the better of duplicate quotes at the same size", () => {
    const candidates = candidatesFromQuotes(
      [quote("0xaaa", "100", "99"), quote("0xaaa", "100", "101")],
      [pool("0xaaa")],
    );
    expect(candidates[0]!.quotes).toHaveLength(1);
    expect(candidates[0]!.quotes[0]!.amountOut).toBe(101n);
  });

  it("returns nothing when no quote matches a known pool", () => {
    expect(candidatesFromQuotes([], [pool("0xaaa")])).toEqual([]);
  });
});
