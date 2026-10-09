/**
 * Amount formatting.
 *
 * Reading amounts back is `parseDecimal`'s job, and the round trip between
 * the two ("use all" writes the field, the quote reads it) is pinned in
 * lib/money/parse.test.ts.
 */

import { describe, expect, it } from "vitest";
import { formatAmount, formatAmountExact, tokenBySymbol } from "./tokens.js";

describe("formatAmount", () => {
  it("groups by default and trims trailing zeros", () => {
    expect(formatAmount(10_000n * 10n ** 18n, 18)).toBe("10,000");
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("still accepts a bare maxFraction, as its older callers pass", () => {
    expect(formatAmount(123456789n, 8, 2)).toBe("1.23");
  });
});

describe("formatAmountExact", () => {
  it("writes every digit, ungrouped, past the display cutoff of 6", () => {
    const balance = 12_345n * 10n ** 18n + 123_456_789_012_345_678n;
    expect(formatAmountExact(balance, 18)).toBe("12345.123456789012345678");
  });
});

describe("tokenBySymbol", () => {
  it("throws on an unknown symbol rather than returning a stand-in", () => {
    expect(() => tokenBySymbol("NOPE")).toThrow(/unknown token/);
  });
});
