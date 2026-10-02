/**
 * Display names for listed tokens.
 *
 * native.spec selects `token-in` with `selectOption("ETH")`, which matches an
 * option's value or its label. The value stays the bare symbol; these tests
 * pin that the label still starts with it, so a select by symbol keeps working
 * whichever the browser matches on.
 */

import { describe, expect, it } from "vitest";
import { TOKEN_LIST } from "./tokens.js";
import { GLOSSARY, TOKEN_NAMES, tokenOptionText } from "./names.js";

describe("TOKEN_NAMES", () => {
  it("names every listed token", () => {
    for (const token of TOKEN_LIST) expect(TOKEN_NAMES[token.symbol], token.symbol).toBeTruthy();
  });
});

describe("tokenOptionText", () => {
  it("is the symbol, then the name", () => {
    expect(tokenOptionText("ETH")).toBe("ETH — Ether");
    expect(tokenOptionText("SPX")).toBe("SPX — SPX6900");
    expect(tokenOptionText("WETH")).toBe("WETH — Wrapped Ether");
    expect(tokenOptionText("USDC")).toBe("USDC — USD Coin");
  });

  it("starts with the symbol, so selecting by symbol still finds it", () => {
    for (const token of TOKEN_LIST) expect(tokenOptionText(token.symbol).startsWith(token.symbol)).toBe(true);
  });

  it("falls back to the bare symbol", () => {
    expect(tokenOptionText("DAI")).toBe("DAI");
  });
});

describe("GLOSSARY", () => {
  it("never says what an asserted container must not contain", () => {
    // A tip is DOM text: inside the preview banner "Refused" would fail
    // recommended.spec, and inside the pool picker "depth " would fail
    // tracker.spec.
    for (const [word, tip] of Object.entries(GLOSSARY)) {
      expect(tip, word).not.toMatch(/refused/i);
      expect(tip, word).not.toMatch(/depth /i);
    }
  });

  it("keeps each tip to a few sentences", () => {
    for (const [word, tip] of Object.entries(GLOSSARY)) {
      expect(tip.split(/(?<=\.)\s/).length, word).toBeLessThanOrEqual(3);
    }
  });
});
