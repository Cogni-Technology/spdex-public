/**
 * The "I bought" card: what it says, in which colours, and turning it into a
 * PNG, all in this tab.
 *
 * The card is a meme people post, so it carries only what can be checked and
 * nothing that makes its owner a target or turns it into a price chart:
 * - **What it says:** a caption, the SPX the buy delivered as measured on
 *   chain, the date, the network, the transaction hash, and how to check it
 *   (`#receipt=`, or any block explorer). The address only if its owner
 *   ticks the box; the hash leads to it anyway, and the dialog says so.
 * - **What it never says:** a price, a value in any currency, a gain or loss,
 *   or the SPX6900 logo and site art. spDEX's own name is set as text. Nor
 *   who made a vault buy (a community keeper, the owner, anyone after the
 *   window): `#receipt=` doesn't check it, and Your activity says it.
 * - **Only real buys:** a card can be made only of SPX a pool or a vault
 *   delivered and the chain measured (`canCard` in stack.ts). A transfer
 *   from a friend can't become a "Bought" card.
 *
 * The picture is the dialog's own mounted `<svg>`, written out with
 * `XMLSerializer` and drawn onto a canvas through a `data:` URL, so the PNG is
 * exactly the preview and React escapes every caption on the way. No
 * `foreignObject`, which would let HTML in, and no server renderer in the
 * bundle.
 *
 * The display faces are embedded in the PNG only. The mounted preview uses
 * the fonts the page ships (fonts.css: Orbitron, Space Mono, Bebas Neue), but
 * an SVG drawn as an image can't reach the page's fonts: it would fall back
 * to the system's, and the PNG would stop matching the preview. So when the
 * PNG is made, the same files are read back from this copy's own origin
 * (they are the build's assets, already in the browser's cache), turned into
 * `data:` URLs and written into the serialised SVG as `@font-face` rules
 * (`cardFontCss`, `withEmbeddedFonts`). No other origin is asked, and the
 * mounted SVG itself stays self-contained. If a file can't be read, the PNG
 * is made without the faces, as before.
 */

import type { RecordRow } from "../records/types.js";
import type { Theme } from "../theme.js";
import { networkName } from "../networks.js";
import { spxText } from "./stack.js";
import { checksumAddress, hexGroups } from "./contract.js";
import { receiptFragment } from "./receipt.js";

/** The picture's size, in pixels: 16:9, the shape every feed shows whole. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 675;

/** Longer captions are cut. As the community says, MAKE IT MEMORABLE: a few words of your own, not a paragraph. */
export const MAX_CAPTION = 40;

export const CAPTION_PRESETS = ["Stacked", "Bought", "Persisting"] as const;

/**
 * The card's colours, as literal values: an SVG drawn as an image can't read
 * the page's CSS variables. Theme.css's brand tokens, mode for mode.
 */
export interface CardPalette {
  ink: string;
  paper: string;
  surface: string;
  lime: string;
  magenta: string;
  cyan: string;
}

export const CARD_PALETTES: Readonly<Record<Theme, CardPalette>> = {
  neon: { ink: "#0a0a0a", paper: "#f5f5f5", surface: "#ffffff", lime: "#e5ff1a", magenta: "#ff1a66", cyan: "#00e5ff" },
  pastel: { ink: "#0a0a0a", paper: "#f5f5f5", surface: "#ffffff", lime: "#efe770", magenta: "#f4a6c8", cyan: "#a4e5de" },
};

/** The font stacks theme.css names, for the SVG, which can't read its variables either. */
export const CARD_FONTS = {
  display: '"Orbitron", "Eurostile", "Michroma", ui-sans-serif, system-ui, sans-serif',
  data: '"Space Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  stat: '"Bebas Neue", "Barlow Condensed", "Oswald", "Haettenschweiler", Impact, sans-serif',
} as const;

export interface CardChoices {
  caption: string;
  /** Print the buyer's address. Off unless they tick it. */
  showAddress: boolean;
  /** "Buy 23 of 69", for plan and vault buys. */
  showCount: boolean;
}

/** Everything the card prints, as text; the SVG only places it. */
export interface CardText {
  caption: string;
  amount: string;
  /** "Sep 17, 2026 · Ethereum · Buy 23 of 69" */
  meta: string;
  /** Null unless the owner chose to print it. */
  address: string | null;
  /** The hash in groups of four, over two lines. */
  hashLines: [string, string];
  /** "Check it: …" and its second line. */
  check: string;
  explorer: string;
  footer: string;
}

/** The transaction a card carries: the last of the row's, the one that delivered the SPX. */
export function cardHash(row: RecordRow): `0x${string}` {
  return row.hashes[row.hashes.length - 1]!;
}

/** A caption as the card prints it: trimmed, and cut to `MAX_CAPTION`. An empty one reads "Stacked". */
export function cardCaption(text: string): string {
  const trimmed = [...text.trim()].slice(0, MAX_CAPTION).join("");
  return trimmed === "" ? CAPTION_PRESETS[0] : trimmed;
}

/**
 * "+6,912.34 SPX", or "+0.005 SPX" below one SPX (`spxText`): cut, never
 * rounded up, so the card never claims more than the chain shows, and a
 * small delivery is never shown as "+0 SPX".
 */
export function cardAmount(amount: bigint): string {
  return `+${spxText(amount)}`;
}

/**
 * The date in UTC, "Sep 17, 2026 UTC": the chain's clock, so the card and the
 * receipt view agree wherever each is opened. It says UTC because a buy made
 * early in the morning east of Greenwich is the day before here.
 */
export function cardDate(unix: number): string {
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(unix * 1000),
  );
  return `${day} UTC`;
}

export function cardText(row: RecordRow, choices: CardChoices, appUrl: string | null): CardText {
  const hash = cardHash(row).toLowerCase();
  const groups = hexGroups(hash);
  const meta = [cardDate(row.at.unix), networkName(row.chainId)];
  if (choices.showCount && row.buyIndex) meta.push(`Buy ${row.buyIndex.n} of ${row.buyIndex.of}`);
  // The hash is printed once, in full, above the link, which stands for it
  // with "0x…": printed twice, one copy would be too small to read.
  const fragment = `${receiptFragment({ chainId: row.chainId, hash: hash as `0x${string}` }).split(":")[0]}:0x…`;
  return {
    caption: cardCaption(choices.caption),
    amount: row.bought.amount === null ? "" : cardAmount(row.bought.amount),
    meta: meta.join(" · "),
    address: choices.showAddress && row.account !== null ? checksumAddress(row.account) : null,
    hashLines: [groups.slice(0, 8).join(" "), groups.slice(8).join(" ")],
    check: appUrl === null ? `Check it: open ${fragment} in any spDEX` : `Check it: ${appUrl}${fragment}`,
    explorer: "or on any Ethereum block explorer",
    footer: "made with spDEX · a community project",
  };
}

/** "spdex-card-0x1234abcd.png" */
export function cardFileName(row: RecordRow): string {
  return `spdex-card-${cardHash(row).slice(0, 10).toLowerCase()}.png`;
}

/**
 * A font size at which `text` fits `width` pixels, from `max` down: the
 * amount and the check line vary in length, and SVG text doesn't wrap.
 * `perChar` is a generous average glyph width, as a share of the size, for
 * the widest face in the stack, so it errs toward smaller.
 */
export function fittedSize(text: string, width: number, max: number, perChar: number): number {
  const length = Math.max(1, [...text].length);
  return Math.max(8, Math.min(max, Math.floor(width / (length * perChar))));
}

// ─── The PNG ──────────────────────────────────────────────────────────────────

/** The face files fonts.css ships, as the build names them: this copy's own assets, never another origin. */
const FONT_FILES: readonly { family: string; weight: string; url: string }[] = [
  { family: "Orbitron", weight: "400 900", url: new URL("../../assets/fonts/orbitron/Orbitron-VariableFont_wght.ttf", import.meta.url).href },
  { family: "Space Mono", weight: "400", url: new URL("../../assets/fonts/spacemono/SpaceMono-Regular.ttf", import.meta.url).href },
  { family: "Space Mono", weight: "700", url: new URL("../../assets/fonts/spacemono/SpaceMono-Bold.ttf", import.meta.url).href },
  { family: "Bebas Neue", weight: "400", url: new URL("../../assets/fonts/bebasneue/BebasNeue-Regular.ttf", import.meta.url).href },
];

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * `@font-face` rules for the card's faces, each file as a `data:` URL, read
 * with `load` (the files' bytes, from this copy's origin). A face whose file
 * can't be read is left out, and the PNG falls back for it.
 */
export async function cardFontCss(
  load: (url: string) => Promise<ArrayBuffer>,
  files: readonly { family: string; weight: string; url: string }[] = FONT_FILES,
): Promise<string> {
  const rules = await Promise.all(
    files.map(async ({ family, weight, url }) => {
      try {
        const data = base64(new Uint8Array(await load(url)));
        return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};src:url(data:font/ttf;base64,${data}) format("truetype");}`;
      } catch {
        return "";
      }
    }),
  );
  return rules.join("");
}

/** The serialised card with `css` in a `<style>` as its first child, for the PNG only. */
export function withEmbeddedFonts(source: string, css: string): string {
  if (css === "") return source;
  const open = /<svg\b[^>]*>/.exec(source);
  if (open === null) return source;
  const at = open.index + open[0].length;
  return `${source.slice(0, at)}<style><![CDATA[${css}]]></style>${source.slice(at)}`;
}

let pageFonts: Promise<string> | null = null;

/**
 * The page's faces as `@font-face` rules, read once per page. The dialog asks
 * as it opens, so the PNG isn't kept waiting and a phone's share sheet still
 * counts the tap that asked for it.
 */
export function loadCardFonts(): Promise<string> {
  pageFonts ??= cardFontCss(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  });
  return pageFonts;
}

/** What drawing the card needs from the page, passed in so tests can stand in for it. */
export interface PngEnv {
  document: Pick<Document, "createElement">;
  serialize(svg: SVGSVGElement): string;
  /** `@font-face` rules to embed; none when absent. */
  fonts?: () => Promise<string>;
}

function pageEnv(): PngEnv {
  return { document, serialize: (svg) => new XMLSerializer().serializeToString(svg), fonts: loadCardFonts };
}

/**
 * The mounted card, as a PNG at `CARD_WIDTH` × `CARD_HEIGHT`.
 *
 * The SVG becomes a `data:` URL, with the display faces written into it
 * (`loadCardFonts`), which the CSP's `img-src 'self' data:` allows and which
 * makes no request; the image it loads is drawn onto a canvas and saved from
 * there. Rejects when the browser can't draw it.
 */
export async function cardPng(svg: SVGSVGElement, env: PngEnv = pageEnv()): Promise<Blob> {
  const css = env.fonts ? await env.fonts().catch(() => "") : "";
  const source = withEmbeddedFonts(env.serialize(svg), css);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  return new Promise((resolve, reject) => {
    const image = new Image(CARD_WIDTH, CARD_HEIGHT);
    image.onload = () => {
      const canvas = env.document.createElement("canvas");
      canvas.width = CARD_WIDTH;
      canvas.height = CARD_HEIGHT;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("This browser can't draw the card."));
        return;
      }
      context.drawImage(image, 0, 0, CARD_WIDTH, CARD_HEIGHT);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("This browser couldn't make the PNG."))), "image/png");
    };
    image.onerror = () => reject(new Error("This browser couldn't draw the card."));
    image.src = url;
  });
}

/**
 * Whether this browser can hand a PNG to the system's share sheet (phones,
 * mostly). The file goes from this tab to the app the person picks; spDEX
 * makes no request.
 */
export function canShareFiles(nav: Partial<Pick<Navigator, "canShare" | "share">> | undefined = globalThis.navigator): boolean {
  if (!nav || typeof nav.canShare !== "function" || typeof nav.share !== "function") return false;
  try {
    return nav.canShare({ files: [new File([], "card.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}
