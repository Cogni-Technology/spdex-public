import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import type { RecordRow } from "../records/types.js";
import { CURRENCY_CODES } from "../money/pricing.js";
import { CardSvg } from "../../components/culture/IBoughtCard.js";
import {
  CARD_PALETTES,
  MAX_CAPTION,
  cardAmount,
  cardCaption,
  cardDate,
  cardFileName,
  cardHash,
  cardFontCss,
  cardText,
  fittedSize,
  withEmbeddedFonts,
  type CardChoices,
} from "./card.js";
import { checksumAddress } from "./contract.js";
import { receiptFromUrl } from "./receipt.js";

const HASH = "0x1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988" as Hex;
const OWNER = "0x00000000000000000000000000000000000a11ce" as Address;
const AT = 1_789_683_000; // Sep 17, 2026 (UTC)

const ROW: RecordRow = {
  id: "plan-7",
  kind: "plan-buy",
  chainId: 1,
  account: OWNER,
  at: { unix: AT, source: "block" },
  block: 26_001_249n,
  hashes: [HASH],
  sold: { token: NATIVE_TOKEN, amount: 8_158_900_000_000_000n, measured: true },
  bought: { token: TOKENS.SPX.address, amount: 6_912_34567891n, measured: true },
  buyFee: 0n,
  networkFee: 10n ** 14n,
  valueUsd: 20_000_000n,
  rates: null,
  valueSource: "twap-seen",
  planId: "daily",
  planLabel: "Daily SPX",
  buyIndex: { n: 23, of: 69 },
};

const CHOICES: CardChoices = { caption: "Stacked", showAddress: false, showCount: true };

describe("what the card says", () => {
  it("the caption, the measured amount, the date, the network, the count and the hash", () => {
    const text = cardText(ROW, CHOICES, null);
    expect(text).toMatchObject({
      caption: "Stacked",
      amount: "+6,912.34 SPX",
      meta: "Sep 17, 2026 UTC · Ethereum · Buy 23 of 69",
      address: null,
      hashLines: ["0x1f2e 3d4c 5b6a 7988 1f2e 3d4c 5b6a 7988", "1f2e 3d4c 5b6a 7988 1f2e 3d4c 5b6a 7988"],
      check: "Check it: open #receipt=1:0x… in any spDEX",
      explorer: "or on any Ethereum block explorer",
      footer: "made with spDEX · a community project",
    });
    // The hash is on the card whole, once.
    expect(text.hashLines.join(" ").replaceAll(" ", "")).toBe(HASH);
  });

  it("prints the link the build names, and the address only when asked", () => {
    const text = cardText(ROW, { ...CHOICES, showAddress: true, showCount: false }, "https://spdex.example/app/");
    expect(text.check).toBe("Check it: https://spdex.example/app/#receipt=1:0x…");
    expect(text.address).toBe(checksumAddress(OWNER));
    expect(text.meta).toBe("Sep 17, 2026 UTC · Ethereum");
  });

  it("carries the last transaction, the one that delivered, and a fragment the receipt view reads", () => {
    const approval = `0x${"aa".repeat(32)}` as Hex;
    const withApproval = { ...ROW, hashes: [approval, HASH] };
    expect(cardHash(withApproval)).toBe(HASH);
    expect(cardFileName(withApproval)).toBe("spdex-card-0x1f2e3d4c.png");
    expect(receiptFromUrl(`#receipt=1:${cardHash(withApproval)}`)).toEqual({ chainId: 1, hash: HASH });
  });

  it("cuts a caption to 40 characters, and an empty one is Stacked", () => {
    expect(cardCaption("  Persisting  ")).toBe("Persisting");
    expect(cardCaption("")).toBe("Stacked");
    expect([...cardCaption("💹🧲".repeat(30))]).toHaveLength(MAX_CAPTION);
  });

  it("never rounds the amount up", () => {
    expect(cardAmount(99_999999n)).toBe("+0.99999999 SPX");
    expect(cardAmount(6_900_00000000n)).toBe("+6,900 SPX");
    expect(cardAmount(6_900_99999999n)).toBe("+6,900.99 SPX");
    // Below one SPX every digit shows, so SPX that did arrive is never "+0".
    expect(cardAmount(500_000n)).toBe("+0.005 SPX");
  });

  it("dates by UTC, as the chain does", () => {
    expect(cardDate(AT)).toBe("Sep 17, 2026 UTC");
    expect(cardDate(Date.UTC(2026, 0, 1, 23, 59) / 1000)).toBe("Jan 1, 2026 UTC");
  });

  it("sizes long lines down to fit", () => {
    expect(fittedSize("+6,912.34 SPX", 1030, 156, 0.52)).toBe(152);
    expect(fittedSize("+1,234,567,890.12 SPX", 1030, 156, 0.52)).toBe(94);
    expect(fittedSize("", 1030, 22, 0.6)).toBe(22);
  });
});

describe("the card's SVG", () => {
  const svgOf = (text = cardText(ROW, CHOICES, "https://spdex.example/"), mode: "neon" | "pastel" = "neon") =>
    renderToStaticMarkup(createElement(CardSvg, { text, palette: CARD_PALETTES[mode] }));
  const textOf = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);

  it("holds no currency symbol or code", () => {
    const words = textOf(svgOf()).join(" ");
    expect(words).not.toMatch(/[$€£¥₩₹₺₱]/);
    for (const code of CURRENCY_CODES) expect(words).not.toMatch(new RegExp(`\\b${code}\\b`));
    expect(words).not.toMatch(/price|value|worth|profit|gain|official/i);
  });

  it("refers to nothing outside itself: no link, image, script, foreign object or fetched font", () => {
    const svg = svgOf();
    expect(svg).not.toMatch(/\b(href|src)=/i);
    expect(svg).not.toMatch(/<(image|script|foreignObject|use|style|a)\b/i);
    expect(svg).not.toMatch(/@import|@font-face/i);
    const urls = [...svg.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    for (const url of urls) expect(url).toMatch(/^#spdex-card-/);
  });

  it("holds no figure but the amount, the date, the network's, the count and the hash", () => {
    const allowed = new Set<string>();
    const add = (s: string) => {
      for (const digits of s.match(/\d+/g) ?? []) allowed.add(digits);
    };
    const text = cardText(ROW, CHOICES, "https://spdex.example/");
    [text.amount, text.meta, ...text.hashLines, "#receipt=1:0x"].forEach(add);
    for (const line of textOf(svgOf(text))) {
      for (const digits of line.match(/\d+/g) ?? []) expect(allowed.has(digits), `${digits} in "${line}"`).toBe(true);
    }
  });

  it("sets a hostile caption as text", () => {
    const text = cardText(ROW, { ...CHOICES, caption: "</text><script>alert(1)</script>" }, null);
    const svg = svgOf(text);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).toContain("&lt;/TEXT&gt;&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;");
  });

  it("uses each mode's own colours, and never lime as the colour of text on paper or white", () => {
    for (const mode of ["neon", "pastel"] as const) {
      const svg = svgOf(undefined, mode);
      expect(svg).toContain(`fill="${CARD_PALETTES[mode].lime}"`);
      expect(svg).toContain(`fill="${CARD_PALETTES[mode].magenta}"`);
      const limeText = [...svg.matchAll(/<text[^>]*fill="([^"]+)"/g)].filter((m) => m[1] === CARD_PALETTES[mode].lime);
      // The only lime text is the wordmark, which sits on its own ink tile.
      expect(limeText).toHaveLength(1);
      expect(svg).toMatch(/<rect[^>]*fill="#0a0a0a"[^>]*><\/rect><text[^>]*>spDEX<\/text>/);
    }
  });

  it("is 1200 × 675", () => {
    expect(svgOf()).toMatch(/^<svg[^>]*viewBox="0 0 1200 675"[^>]*width="1200"[^>]*height="675"/);
  });
});

describe("the PNG's faces", () => {
  const files = [
    { family: "Orbitron", weight: "400 900", url: "/assets/orbitron.ttf" },
    { family: "Space Mono", weight: "700", url: "/assets/spacemono-bold.ttf" },
  ];

  it("embeds each face as a data: URL, read from the URL the build gave it", async () => {
    const asked: string[] = [];
    const css = await cardFontCss(async (url) => {
      asked.push(url);
      return new TextEncoder().encode("ttf").buffer as ArrayBuffer;
    }, files);
    expect(asked).toEqual(["/assets/orbitron.ttf", "/assets/spacemono-bold.ttf"]);
    expect(css).toContain('@font-face{font-family:"Orbitron";font-style:normal;font-weight:400 900;src:url(data:font/ttf;base64,dHRm) format("truetype");}');
    expect(css).toContain('font-family:"Space Mono";font-style:normal;font-weight:700;');
    // Nothing but data: URLs.
    for (const [, url] of css.matchAll(/url\(([^)]*)\)/g)) expect(url).toMatch(/^data:font\/ttf;base64,/);
  });

  it("leaves out a face whose file can't be read, and the rest still come", async () => {
    const css = await cardFontCss(async (url) => {
      if (url.includes("orbitron")) throw new Error("HTTP 404");
      return new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;
    }, files);
    expect(css).not.toContain("Orbitron");
    expect(css).toContain("Space Mono");
  });

  it("puts the rules first in the serialised card, and changes nothing without them", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200"><text>x</text></svg>';
    expect(withEmbeddedFonts(svg, "")).toBe(svg);
    expect(withEmbeddedFonts(svg, "@font-face{}")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200"><style><![CDATA[@font-face{}]]></style><text>x</text></svg>',
    );
  });
});
