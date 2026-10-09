/**
 * The small pure pieces of the Permit2 batch that the Guard leans on: the code
 * hash comparison, the nonce layout, and the approval encoding's fixed spender.
 * The calldata and typed data are held to viem and to Permit2's own digest in
 * `packages/chain/src/permit2.test.ts`, where a codec is available.
 */

import { describe, expect, it } from "vitest";
import {
  cleanTipText,
  hasHiddenCharacters,
  mixesAlphabets,
  tipClaimMessage,
  tipNameProblem,
  tipNameSkeleton,
  WireTipCandidateSchema,
  encodePermit2Approval,
  isPermit2CodeHash,
  isPermit2Nonce,
  permit2Nonce,
  permit2NoncePosition,
  permit2PermissionAmount,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  PERMIT2_CODE_HASH,
} from "./tips.js";

describe("the Permit2 code hash", () => {
  it("matches only the known hash, in either case", () => {
    expect(isPermit2CodeHash(PERMIT2_CODE_HASH)).toBe(true);
    expect(isPermit2CodeHash(PERMIT2_CODE_HASH.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isPermit2CodeHash(`0x${"00".repeat(32)}`)).toBe(false);
  });

  it("never treats an unknown hash as the known one", () => {
    expect(isPermit2CodeHash(null)).toBe(false);
    expect(isPermit2CodeHash(undefined)).toBe(false);
    expect(isPermit2CodeHash("")).toBe(false);
  });
});

describe("Permit2 nonces", () => {
  it("puts the word in the high 248 bits and the bit in the low 8", () => {
    const nonce = permit2Nonce(0x1234n, 200);
    expect(nonce).toBe((0x1234n << 8n) | 200n);
    expect(permit2NoncePosition(nonce)).toEqual({ word: 0x1234n, bit: 200 });
  });

  it("covers the whole uint256 range and nothing past it", () => {
    const top = permit2Nonce((1n << 248n) - 1n, 255);
    expect(top).toBe(MAX_UINT256);
    expect(isPermit2Nonce(top)).toBe(true);
    expect(isPermit2Nonce(MAX_UINT256 + 1n)).toBe(false);
    expect(isPermit2Nonce(-1n)).toBe(false);
    expect(() => permit2Nonce(1n << 248n, 0)).toThrow(RangeError);
    expect(() => permit2Nonce(0n, 256)).toThrow(RangeError);
    expect(() => permit2NoncePosition(-1n)).toThrow(RangeError);
  });
});

describe("the standing permission", () => {
  it("always names Permit2 as the spender, for the maximum or for zero", () => {
    const spender = PERMIT2_ADDRESS.slice(2).padStart(64, "0");
    expect(encodePermit2Approval("grant")).toBe(`0x095ea7b3${spender}${"f".repeat(64)}`);
    expect(encodePermit2Approval("revoke")).toBe(`0x095ea7b3${spender}${"0".repeat(64)}`);
    expect(permit2PermissionAmount("grant")).toBe(MAX_UINT256);
    expect(permit2PermissionAmount("revoke")).toBe(0n);
  });
});

describe("the tip-list wire shape", () => {
  const base = { address: "0x4444444444444444444444444444444444444444", label: "Example Artist" };

  it("still takes a v1 entry, and strips keys it doesn't know", () => {
    expect(WireTipCandidateSchema.parse({ ...base, extra: "ignored" })).toEqual(base);
  });

  it("takes the added fields, each checked", () => {
    const full = {
      ...base,
      handle: "@example_artist",
      id: "example-artist",
      ens: "example.eth",
      proof: "https://example.com/example_artist/status/1",
      claim: { message: tipClaimMessage("0x4444444444444444444444444444444444444444", "@example_artist", "2026-10"), signature: `0x${"ab".repeat(65)}` },
      kind: "creator",
      listed: "2026-10",
      retired: "Moved to a new address",
      replacedBy: "example-artist-2",
      test: false,
    };
    expect(WireTipCandidateSchema.parse(full)).toEqual(full);
    expect(WireTipCandidateSchema.safeParse({ ...base, proof: "http://example.com" }).success).toBe(false);
    expect(WireTipCandidateSchema.safeParse({ ...base, proof: "javascript:alert(1)" }).success).toBe(false);
    expect(WireTipCandidateSchema.safeParse({ ...base, id: "Example Artist" }).success).toBe(false);
    expect(WireTipCandidateSchema.safeParse({ ...base, listed: "2026-13" }).success).toBe(false);
    expect(WireTipCandidateSchema.safeParse({ ...base, kind: "sponsor" }).success).toBe(false);
    expect(WireTipCandidateSchema.safeParse({ ...base, claim: { message: "x", signature: "0x1234" } }).success).toBe(false);
  });

  it("builds the claim message a listed person signs", () => {
    expect(tipClaimMessage("0xAbC", "@example_artist", "2026-10")).toBe("spDEX tip list: 0xAbC is @example_artist, 2026-10");
  });
});

describe("tip names", () => {
  it("drops invisible and reordering characters, keeping word breaks", () => {
    expect(cleanTipText("Ma​ria‮ ⁦Lopez⁩")).toBe("Maria Lopez");
    expect(cleanTipText("Maria\tLopez\n")).toBe("Maria Lopez");
    expect(cleanTipText("ㅤ")).toBe("");
    expect(hasHiddenCharacters("Maria")).toBe(false);
    expect(hasHiddenCharacters("Mar‍ia")).toBe(true);
  });

  it("refuses an empty name, a long one and one that reads like an address", () => {
    expect(tipNameProblem("​")).toBe("Give it a name.");
    expect(tipNameProblem("x".repeat(65))).toMatch(/64/);
    expect(tipNameProblem("send to 0xAbCd")).toBe("A name can't look like an address.");
    expect(tipNameProblem("Maria")).toBeNull();
  });

  it("sees an address-like name through its disguises, and leaves ordinary words alone", () => {
    for (const disguised of [
      "０ｘ１２３４", // full-width
      "0х1234abcd", // Cyrillic х
      "Ox1234", // a letter O for the zero
      "0x 1234 5678", // spaced out
      "0×ab cd", // a multiplication sign
      "pay ο x ｃａｆｅ", // Greek omicron, full-width hex
      "0xаbcd", // Cyrillic а among the hex
    ]) {
      expect(tipNameProblem(disguised), disguised).toBe("A name can't look like an address.");
    }
    for (const ordinary of ["Fox Face", "Box 1234", "Max Deface", "Oxford", "Studio x"]) {
      expect(tipNameProblem(ordinary), ordinary).toBeNull();
    }
  });

  it("drops the marks that draw nothing on their own", () => {
    // VS16, a supplementary variation selector, the Khmer inherent vowels, a Mongolian selector.
    for (const hidden of ["Mar\uFE0Fia", "Mar\u{E0100}ia", "Mar\u17B4ia", "Mar\u17B5ia", "Mar\u180Bia"]) {
      expect(hasHiddenCharacters(hidden)).toBe(true);
      expect(cleanTipText(hidden)).toBe("Maria");
    }
  });

  it("reads two names the same when they look the same", () => {
    // Cyrillic а and е, full-width letters, a zero-width space, other spacing and case.
    expect(tipNameSkeleton("Exаmplе Artist")).toBe(tipNameSkeleton("Example Artist"));
    expect(tipNameSkeleton("ＥＸＡＭＰＬＥ artist")).toBe("exampleartist");
    expect(tipNameSkeleton("Exam​ple-Artist")).toBe("exampleartist");
    expect(tipNameSkeleton("Someone Else")).not.toBe(tipNameSkeleton("Example Artist"));
  });

  it("notices a name that mixes Latin with Cyrillic or Greek", () => {
    expect(mixesAlphabets("Exаmple")).toBe(true);
    expect(mixesAlphabets("Example")).toBe(false);
    expect(mixesAlphabets("Пример")).toBe(false);
  });
});
