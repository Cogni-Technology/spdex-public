import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalDigest, canonicalize } from "./canonical.js";

describe("canonicalize", () => {
  it("is independent of key insertion order", () => {
    // The whole parity gate rests on this: two runtimes building the same plan
    // through different code paths must produce the same bytes.
    const a = { b: 2, a: 1, c: { z: 26, y: 25 } };
    const b = { c: { y: 25, z: 26 }, a: 1, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array order, because order is meaning", () => {
    // Call sequence is semantic — approve-then-swap is not swap-then-approve.
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("keeps a bigint distinct from its decimal string", () => {
    // Without the `#` sentinel a module could substitute a string for a numeric
    // amount and produce an identical digest.
    expect(canonicalize({ v: 1n })).not.toBe(canonicalize({ v: "1" }));
  });

  it("encodes bigints beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const wei = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    expect(canonicalize({ v: wei })).toBe(`{"v":"#${wei.toString(10)}"}`);
  });

  it("throws on undefined rather than dropping it", () => {
    // JSON.stringify silently omits undefined, which would let a missing
    // safety-relevant field hash identically to a present one.
    expect(() => canonicalize({ minOut: undefined })).toThrow(CanonicalizationError);
  });

  it("names the path of the offending value", () => {
    expect(() => canonicalize({ intent: { calls: [{ value: undefined }] } })).toThrow(
      /intent\.calls\[0\]\.value/,
    );
  });

  it("rejects non-integer numbers and points at bigint", () => {
    expect(() => canonicalize({ v: 1.5 })).toThrow(/use bigint/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalize({ v: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ v: Infinity })).toThrow(CanonicalizationError);
  });

  it("rejects class instances, which do not round-trip", () => {
    class Amount {
      constructor(readonly v: number) {}
    }
    expect(() => canonicalize({ v: new Amount(1) })).toThrow(/plain objects/);
  });

  it("encodes null and booleans", () => {
    expect(canonicalize({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}');
  });

  it("escapes keys and strings", () => {
    expect(canonicalize({ 'a"b': 'c"d' })).toBe('{"a\\"b":"c\\"d"}');
  });
});

describe("canonicalDigest", () => {
  it("is stable across calls", async () => {
    const plan = { intent: { minAmountOut: 42n }, calls: [] };
    expect(await canonicalDigest(plan)).toBe(await canonicalDigest(plan));
  });

  it("differs when any value differs", async () => {
    const a = await canonicalDigest({ minAmountOut: 1000n });
    const b = await canonicalDigest({ minAmountOut: 999n });
    expect(a).not.toBe(b);
  });

  it("matches for reordered but equal structures", async () => {
    const a = await canonicalDigest({ to: "0xabc", value: 1n });
    const b = await canonicalDigest({ value: 1n, to: "0xabc" });
    expect(a).toBe(b);
  });

  it("returns 64 hex characters", async () => {
    expect(await canonicalDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
