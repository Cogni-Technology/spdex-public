/**
 * The stylesheet's promises, checked against the stylesheet itself.
 *
 * theme.css makes claims in its header that nothing else would catch if they
 * stopped being true: that PASTEL swaps only the accents, that no rule
 * reaches past the swappable tokens to a fixed brand colour (which would leave
 * a neon patch on a pastel page), and that every text colour it sets clears
 * WCAG AA on the fill it sits on, in both modes. A wrong colour is invisible
 * to every other test in the repo, so these read the real file.
 *
 * The parser is deliberately small. It understands exactly the CSS this file
 * is written in: flat rules, optionally inside one level of `@media`, no
 * nesting. If the file outgrows it, the first assertion to fail will say so.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read from disk: vitest replaces a CSS import, `?raw` included, with an
// empty string unless CSS processing is switched on for the whole project.
const RAW = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  declarations: [property: string, value: string][];
}

/** Every innermost `selectors { declarations }` block, in source order. */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = splitTopLevel(match[1]!.trim(), ",").map((s) => s.replace(/\s+/g, " ").trim());
    const declarations = match[2]!
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d): [string, string] => {
        const colon = d.indexOf(":");
        return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
      });
    rules.push({ selectors, declarations });
  }
  return rules;
}

/** Splits on `separator` where it is not inside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

const RULES = parseRules(CSS);
const ROOT = RULES.filter((r) => r.selectors.length === 1 && r.selectors[0] === ":root");
const PASTEL = RULES.filter((r) => r.selectors.length === 1 && r.selectors[0] === ':root[data-theme="pastel"]');

type Mode = "neon" | "pastel";

function tokens(mode: Mode): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of mode === "neon" ? ROOT : [...ROOT, ...PASTEL]) {
    for (const [property, value] of rule.declarations) if (property.startsWith("--")) map.set(property, value);
  }
  return map;
}

/** Substitutes every `var(--x)` until none is left. */
function resolve(value: string, mode: Mode): string {
  const map = tokens(mode);
  let out = value;
  for (let depth = 0; out.includes("var(--"); depth++) {
    if (depth > 10) throw new Error(`var() cycle in ${value}`);
    out = out.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const found = map.get(name);
      if (found === undefined) throw new Error(`undefined token ${name}`);
      return found;
    });
  }
  return out;
}

type Rgb = [number, number, number];

/** A resolved colour, composited over `under` when it has an alpha. */
function parseColor(value: string, under: Rgb = [255, 255, 255]): Rgb {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgba) {
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return [1, 2, 3].map((i, k) => Number(rgba[i]) * alpha + under[k]! * (1 - alpha)) as Rgb;
  }
  throw new Error(`not a colour this test understands: ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The last value `selector` is given for `property`, as the cascade would pick. */
function declared(selector: string, property: string): string {
  let found: string | undefined;
  for (const rule of RULES) {
    if (!rule.selectors.includes(selector)) continue;
    for (const [p, v] of rule.declarations) if (p === property) found = v;
  }
  if (found === undefined) throw new Error(`${selector} sets no ${property}`);
  return found;
}

/** The colour a rule paints behind its content: the bottom background layer. */
function backgroundOf(selector: string, mode: Mode): Rgb {
  const layers = splitTopLevel(resolve(declared(selector, "background"), mode), ",");
  return parseColor(layers[layers.length - 1]!);
}

function colorOf(selector: string, mode: Mode, under: Rgb): Rgb {
  return parseColor(resolve(declared(selector, "color"), mode), under);
}

const token = (name: string, mode: Mode, under?: Rgb): Rgb => parseColor(resolve(`var(${name})`, mode), under);

describe("theme.css tokens", () => {
  it("parses as the flat CSS this test understands", () => {
    // A guard for the parser, not the theme: if these fail, fix the parser
    // before believing anything below.
    expect(ROOT).toHaveLength(1);
    expect(PASTEL).toHaveLength(1);
    expect(RULES.length).toBeGreaterThan(100);
  });

  it("keeps the spx6900.com brand constants verbatim, declared once and never overridden", () => {
    const brand: Record<string, string> = {
      "--spx-lime": "#e5ff1a",
      "--spx-yellow": "#ffe500",
      "--spx-magenta": "#ff1a66",
      "--spx-cyan": "#00e5ff",
      "--spx-black": "#0a0a0a",
      "--spx-paper": "#f5f5f5",
    };
    for (const [name, value] of Object.entries(brand)) {
      const declarations = RULES.flatMap((r) => r.declarations.filter(([p]) => p === name));
      expect(declarations, name).toEqual([[name, value]]);
    }
  });

  it("makes PASTEL swap exactly the accents: the source site's three, and a softer warning", () => {
    expect(PASTEL[0]!.declarations).toEqual([
      ["--c-lime", "#efe770"],
      ["--c-magenta", "#f4a6c8"],
      ["--c-cyan", "#a4e5de"],
      ["--c-yellow", "#f6c77a"],
      ["--highlight", "var(--c-cyan)"],
    ]);
    expect(resolve("var(--c-lime) var(--c-magenta) var(--c-cyan) var(--c-yellow)", "neon")).toBe(
      "#e5ff1a #ff1a66 #00e5ff #ffe500",
    );
  });

  it("leaves NEON's warning and hover on the source site's yellow", () => {
    expect(resolve("var(--warn) var(--highlight)", "neon")).toBe("#ffe500 #ffe500");
    // PASTEL's warning is the amber, its hover the pastel cyan: neither clashes
    // with pastel lime, which the saturated yellow did.
    expect(resolve("var(--warn) var(--highlight)", "pastel")).toBe("#f6c77a #a4e5de");
  });

  it("routes every rule outside the token block through tokens, never a fixed brand colour", () => {
    // A rule that said var(--spx-lime) would stay neon on a pastel page.
    // Literal colours are the same leak by another route.
    const leaks: string[] = [];
    for (const rule of RULES) {
      if (rule === ROOT[0] || rule === PASTEL[0]) continue;
      for (const [property, value] of rule.declarations) {
        // An alpha colour has to take its channels from a triple token.
        const literalRgba = /rgba?\((?!\s*var\(--(?:ink|surface)-rgb\))/.test(value);
        if (/var\(--spx-/.test(value) || /#[0-9a-f]{3,8}\b/i.test(value) || literalRgba) {
          leaks.push(`${rule.selectors.join(", ")} { ${property}: ${value} }`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("keeps the channel triples equal to the colours they stand for", () => {
    for (const mode of ["neon", "pastel"] as const) {
      expect(parseColor(`rgb(${resolve("var(--ink-rgb)", mode)})`)).toEqual(token("--ink", mode));
      expect(parseColor(`rgb(${resolve("var(--surface-rgb)", mode)})`)).toEqual(token("--surface", mode));
    }
  });

  it("suppresses transitions for the switching frame, pseudo-elements included", () => {
    for (const selector of [
      ":root.theme-switching",
      ":root.theme-switching *",
      ":root.theme-switching *::before",
      ":root.theme-switching *::after",
    ]) {
      expect(declared(selector, "transition"), selector).toBe("none !important");
    }
  });

  it("declares itself light-only and has no dark mode", () => {
    expect(declared(":root", "color-scheme")).toBe("light only");
    expect(CSS).not.toMatch(/prefers-color-scheme/);
  });

  it("paints the halftone as the page background, and keeps the pinned chrome below the dialog", () => {
    // As a background it cannot cover text or take a click; nothing is laid
    // over the page any more.
    expect(declared("body", "background-image")).toBe("var(--halftone)");
    expect(resolve("var(--halftone)", "neon")).toMatch(/^radial-gradient\(circle, rgba\(10, 10, 10, 0\.07\)/);
    expect(CSS).not.toMatch(/body::(before|after)/);
    const dialog = Number(declared(".spdex-modal__backdrop", "z-index"));
    for (const pinned of [
      ".spdex-dock",
      ".spdex-widget",
      ".spdex-footer .spdex-keyhints",
    ]) {
      expect(Number(declared(pinned, "z-index")), pinned).toBeLessThan(dialog);
    }
    expect(Number(declared(".spdex-term__tip", "z-index"))).toBeLessThan(dialog);
    // The line drawing sits in flow at the end of the page, under the footer:
    // not fixed behind the page, where its labels ran through the footer and
    // the tiles. The stickers lie under the centre column.
    const linkmapPlacement = RULES.filter((r) => r.selectors.includes(".spdex-linkmap")).flatMap((r) =>
      r.declarations.filter(([p]) => p === "position" || p === "z-index"),
    );
    expect(linkmapPlacement).toEqual([]);
    expect(Number(declared(".spdex-stickers", "z-index"))).toBeLessThan(Number(declared(".spdex-shell__centre", "z-index")));
  });

  it("fixes the backdrop's picture behind the page from 85em, and lays the same under what the stickers scroll beneath", () => {
    // Hidden by default (phones and the one-column layout, where the app never
    // names the picture either: apps/web/src/backdrop.css); where there are
    // three columns, fixed behind everything, under the stickers, which lie
    // under the centre column.
    expect(CSS).toMatch(/(^|\n)\.spdex-bgart \{ display: none; \}/);
    expect(CSS).toMatch(/@media \(min-width: 85em\) \{\s*\.spdex-bgart \{[^}]*display: block;[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: -1;/);
    expect(declared(".spdex-bgart", "position")).toBe("fixed");
    expect(Number(declared(".spdex-bgart", "z-index"))).toBe(-1);
    expect(Number(declared(".spdex-bgart", "z-index"))).toBeLessThan(Number(declared(".spdex-stickers", "z-index")));
    // The picture is the app's, named by one property; the paper's halftone
    // lies over it, and until it loads (or with none) the layer is the paper.
    expect(declared(".spdex-bgart", "background-color")).toBe("var(--paper)");
    expect(declared(".spdex-bgart", "background-image")).toBe("var(--halftone), var(--bgart-image, none)");
    expect(declared(".spdex-bgart", "background-size")).toBe("13px 13px, var(--bgart-size, cover)");
    expect(declared(".spdex-bgart", "background-position")).toBe("0 0, var(--bgart-position, center bottom)");
    // The sticky masthead and the gap above the pinned widget hide the
    // stickers scrolling under them with the same backdrop, fixed to the
    // window as the layer is, never a paper box or band over the picture.
    for (const piece of [".spdex-shell__head", ".spdex-widget::before"]) {
      for (const property of ["background-color", "background-image", "background-size", "background-position", "background-repeat"]) {
        expect(declared(piece, property), `${piece} ${property}`).toBe(declared(".spdex-bgart", property));
      }
      expect(declared(piece, "background-attachment"), piece).toBe("fixed");
    }
    const paperShadows = RULES.filter((r) => r.selectors.includes(".spdex-widget")).flatMap((r) =>
      r.declarations.filter(([p, v]) => p === "box-shadow" && v.includes("var(--paper)")),
    );
    expect(paperShadows).toEqual([]);
    // Still, and quiet: nothing on it moves.
    const moving = RULES.filter((r) => r.selectors.some((s) => s.includes("spdex-bgart"))).flatMap((r) =>
      r.declarations.filter(([p]) => p.startsWith("animation") || p.startsWith("transition")),
    );
    expect(moving).toEqual([]);
  });

  it("leaves the picture's banner and coin to the rails: stickers on each rail's right-hand side, no link map over it", () => {
    // The banner's print sits at the window's left edge and the crystal's
    // coin just right of the centre column (apps/web/src/backdrop.css), so a
    // sticker keeps to its rail's right-hand side, a little in so a rotated
    // corner stays inside the rail's clip, and is only turned, never slid.
    expect(declared(".spdex-sticker", "right")).toBe("12px");
    for (const id of ["no-chart", "tape", "keys", "stamp", "receipt"]) {
      const base = RULES.find((r) => r.selectors.length === 1 && r.selectors[0] === `.spdex-sticker--${id}` && r.declarations.some(([p]) => p === "top"));
      const transform = base?.declarations.find(([p]) => p === "transform")?.[1];
      expect(transform, id).toMatch(/^rotate\(-?\d+deg\)$/);
    }
    // The line map under the footer goes where the picture shows; its line
    // art would lie across the picture's.
    expect(CSS).toMatch(/@media \(min-width: 85em\) \{\s*@supports not \(-webkit-touch-callout: none\) \{\s*\.spdex-linkmap \{ display: none; \}\s*\}\s*\}/);
    // PASTEL's pale pink stamp prints on a white ground of its own; NEON's is bare ink.
    expect(declared(".spdex-art__stamp-ground", "fill")).toBe("none");
    expect(declared(':root[data-theme="pastel"] .spdex-art__stamp-ground', "fill")).toBe("var(--surface)");
  });

  it("gives a danger banner a near-black outline, with the magenta as a shadow", () => {
    // A pastel-pink outline on white is 1.89:1, under the 3:1 a boundary needs.
    const outline = RULES.filter((r) => r.selectors.includes(".spdex-banner--danger")).flatMap((r) =>
      r.declarations.filter(([p]) => p.startsWith("border")),
    );
    expect(outline).toEqual([]);
    expect(declared(".spdex-banner--danger", "box-shadow")).toContain("var(--danger)");
  });
});

/**
 * Every text colour the theme sets, on the fill it sits on.
 *
 * `fg`/`bg` name a selector whose `color`/`background` the stylesheet
 * declares, or a token for text that inherits the body colour or sits on a
 * panel's surface.
 */
const TEXT_PAIRS: { what: string; fg: string; bg: string }[] = [
  { what: "body text on paper", fg: "--text", bg: "--paper" },
  { what: "body text on a panel", fg: "--text", bg: "--surface" },
  { what: "dim text on a panel", fg: "--text-dim", bg: "--surface" },
  { what: "dim text on paper", fg: "--text-dim", bg: "--paper" },
  { what: "faint text on a panel", fg: "--text-faint", bg: "--surface" },
  { what: "faint text on paper", fg: "--text-faint", bg: "--paper" },
  { what: "button", fg: ".spdex-button", bg: ".spdex-button" },
  { what: "button, hovered", fg: ".spdex-button", bg: ".spdex-button:hover:not(:disabled)" },
  { what: "ghost button, hovered", fg: ".spdex-button--ghost", bg: ".spdex-button--ghost:hover:not(:disabled)" },
  { what: "pressed toggle option", fg: '.spdex-toggle__option[aria-pressed="true"]', bg: '.spdex-toggle__option[aria-pressed="true"]' },
  { what: "focused field", fg: ".spdex-input", bg: ".spdex-input:focus" },
  { what: "placeholder", fg: ".spdex-input::placeholder", bg: ".spdex-input" },
  { what: "placeholder, focused field", fg: ".spdex-input::placeholder", bg: ".spdex-input:focus" },
  { what: "hovered link", fg: ".spdex-app a", bg: ".spdex-app a:hover" },
  { what: "ok banner title", fg: ".spdex-banner__title", bg: ".spdex-banner--ok .spdex-banner__title" },
  { what: "warn banner title", fg: ".spdex-banner__title", bg: ".spdex-banner--warn .spdex-banner__title" },
  { what: "danger banner title", fg: ".spdex-banner--danger .spdex-banner__title", bg: ".spdex-banner--danger .spdex-banner__title" },
  { what: "route share badge", fg: ".spdex-leg__share", bg: ".spdex-leg__share" },
  { what: "raw plan", fg: ".spdex-code", bg: ".spdex-code" },
  { what: "config diff path", fg: "--text", bg: ".spdex-diff__path" },
  { what: "masthead", fg: ".spdex-masthead__title", bg: ".spdex-masthead__title" },
  { what: "dialog title", fg: ".spdex-modal__title", bg: ".spdex-modal__head" },
  { what: "dialog close, hovered", fg: ".spdex-modal__close:hover", bg: ".spdex-modal__close:hover" },
  { what: "MODE label", fg: ".spdex-mode__label", bg: ".spdex-mode" },
  { what: "MODE option, unselected", fg: ".spdex-mode__opt", bg: ".spdex-mode__opt" },
  { what: "MODE option, selected", fg: '.spdex-mode__opt[aria-pressed="true"]', bg: '.spdex-mode__opt[aria-pressed="true"]' },
  { what: "term tip", fg: ".spdex-term__tip", bg: ".spdex-term__tip" },
  { what: "running pill", fg: ".spdex-pill", bg: ".spdex-pill--running" },
  { what: "paused pill", fg: ".spdex-pill", bg: ".spdex-pill--paused" },
  { what: "done pill", fg: ".spdex-pill--done", bg: ".spdex-pill--done" },
  { what: "action pill", fg: ".spdex-pill", bg: ".spdex-pill--action" },
  { what: "attention pill", fg: ".spdex-pill", bg: ".spdex-pill--attention" },
  { what: "stat label", fg: ".spdex-stat__label", bg: "--surface" },
  { what: "unknown stat", fg: ".spdex-stat__value--unknown", bg: "--surface" },
  { what: "progress count", fg: "--text", bg: "--surface" },
  { what: "choice title, chosen", fg: ".spdex-choice__title", bg: ".spdex-choice--checked" },
  { what: "choice description, chosen", fg: ".spdex-choice__description", bg: ".spdex-choice--checked" },
  { what: "choice cost, chosen", fg: ".spdex-choice__cost", bg: ".spdex-choice--checked" },
  { what: "choice cost", fg: ".spdex-choice__cost", bg: ".spdex-choice" },
  { what: "disclosure summary", fg: ".spdex-disclosure__summary", bg: ".spdex-disclosure" },
  { what: "disclosure summary, hovered", fg: ".spdex-disclosure__summary", bg: ".spdex-disclosure__summary:hover" },
  { what: "status widget link, hovered", fg: ".spdex-widget__link", bg: ".spdex-widget__link:hover" },
  { what: "status widget BUY DUE", fg: ".spdex-widget__link", bg: ".spdex-widget__link--due" },
  { what: "status widget title, online", fg: ".spdex-widget__title", bg: ".spdex-widget__title" },
  { what: "status widget title, no service", fg: ".spdex-widget__title", bg: '.spdex-widget[data-state="none"] .spdex-widget__title' },
  { what: "status widget title, slow", fg: ".spdex-widget__title", bg: '.spdex-widget[data-state="slow"] .spdex-widget__title' },
  { what: "status widget title, offline", fg: ".spdex-widget__title", bg: '.spdex-widget[data-state="offline"] .spdex-widget__title' },
  { what: "status widget label", fg: ".spdex-widget__label", bg: ".spdex-widget" },
  { what: "status widget value", fg: ".spdex-widget__value", bg: ".spdex-widget" },
  { what: "status widget button, hovered", fg: ".spdex-widget__action", bg: ".spdex-widget__action:hover" },
  { what: "status widget button, on", fg: ".spdex-widget__action", bg: '.spdex-widget__action[aria-pressed="true"]' },
  { what: "read-now button, hovered", fg: ".spdex-widget__refresh", bg: ".spdex-widget__refresh:hover" },
  { what: "Aa DISPLAY", fg: ".spdex-masthead__display", bg: ".spdex-masthead__display" },
  { what: "Aa DISPLAY, open", fg: '.spdex-masthead__display[aria-expanded="true"]', bg: '.spdex-masthead__display[aria-expanded="true"]' },
  { what: "COMMUNITY PROJECT", fg: ".spdex-masthead__community", bg: "--paper" },
  { what: "tagline", fg: ".spdex-masthead__tagline", bg: "--paper" },
  { what: "footer", fg: ".spdex-footer", bg: "--paper" },
  { what: "footer link, hovered", fg: ".spdex-footer__link", bg: ".spdex-footer__link:hover" },
  { what: "skip link", fg: ".spdex-skip__link", bg: ".spdex-skip__link" },
  { what: "disclaimer chip", fg: ".spdex-gate__chip", bg: "--surface" },
  { what: "disclaimer text", fg: ".spdex-gate__text", bg: ".spdex-gate__text" },
  { what: "disclaimer hint", fg: ".spdex-gate__hint", bg: "--surface" },
  { what: "settings label", fg: ".spdex-settings__label", bg: "--surface" },
  // No fill of its own any more (it read as a second button): it sits on the Trade panel.
  { what: "keyboard hint", fg: ".spdex-keyhint", bg: ".spdex-panel" },
  { what: "verdict tag, checked", fg: ".spdex-guard-level", bg: ".spdex-banner--ok .spdex-banner__title" },
  { what: "verdict tag, not checked", fg: ".spdex-guard-level", bg: ".spdex-banner--warn .spdex-banner__title" },
  { what: "verdict tag, blocked", fg: ".spdex-guard-level", bg: ".spdex-banner--danger .spdex-banner__title" },
  { what: "Guard code", fg: ".spdex-code-tag", bg: "--surface" },
  { what: "summary aside", fg: ".spdex-summary__aside", bg: ".spdex-summary" },
  { what: "tile header", fg: ".spdex-tile__head", bg: ".spdex-tile__head" },
  { what: "tile header, hovered", fg: ".spdex-tile__head", bg: ".spdex-tile__head:hover" },
  { what: "tile summary", fg: ".spdex-tile__summary", bg: ".spdex-tile__head" },
  { what: "tile header, open", fg: '.spdex-tile[data-open="true"] > .spdex-tile__head', bg: '.spdex-tile[data-open="true"] > .spdex-tile__head' },
  { what: "tile summary, open", fg: '.spdex-tile[data-open="true"] > .spdex-tile__head .spdex-tile__summary', bg: '.spdex-tile[data-open="true"] > .spdex-tile__head' },
  { what: "tile header, focused", fg: ".spdex-tile__head:has(.spdex-tile__button:focus-visible)", bg: ".spdex-tile__head:has(.spdex-tile__button:focus-visible)" },
  { what: "tile summary, focused", fg: ".spdex-tile__head:has(.spdex-tile__button:focus-visible) .spdex-tile__summary", bg: ".spdex-tile__head:has(.spdex-tile__button:focus-visible)" },
  { what: "key hint", fg: ".spdex-keyhints__chip > kbd", bg: ".spdex-keyhints__chip > kbd" },
  { what: "back chip", fg: ".spdex-goto-back", bg: ".spdex-goto-back" },
  { what: "back chip, hovered", fg: ".spdex-goto-back", bg: ".spdex-goto-back:hover" },
  { what: "place link, hovered", fg: ".spdex-goto", bg: ".spdex-goto:hover" },
];

describe("text contrast, WCAG AA (4.5:1)", () => {
  for (const mode of ["neon", "pastel"] as const) {
    for (const { what, fg, bg } of TEXT_PAIRS) {
      it(`${mode}: ${what}`, () => {
        const under = bg.startsWith("--") ? token(bg, mode) : backgroundOf(bg, mode);
        const over = fg.startsWith("--") ? token(fg, mode, under) : colorOf(fg, mode, under);
        expect(contrast(over, under)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/**
 * The display preferences (apps/web/src/lib/a11y.ts) work through tokens and
 * attributes on the root, so the promises are about those.
 */
describe("display preferences", () => {
  /** The declarations of the one rule whose selector list is exactly `selector`. */
  const block = (selector: string) => {
    const found = RULES.filter((r) => r.selectors.length === 1 && r.selectors[0] === selector);
    expect(found, selector).toHaveLength(1);
    return new Map(found[0]!.declarations);
  };

  it("sizes every font in rem, so the root's size scales them all", () => {
    const px = RULES.flatMap((r) => r.declarations.filter(([p, v]) => p === "font-size" && /\dpx\b/.test(v)));
    expect(px).toEqual([]);
    expect(declared("html", "font-size")).toBe("calc(100% * var(--spdex-text-scale, 1))");
    // A+ is the default: no attribute. A and A++ are the attribute.
    expect(declared(":root", "--spdex-text-scale")).toBe("1.15");
    expect(declared(':root[data-text="100"]', "--spdex-text-scale")).toBe("1");
    expect(declared(':root[data-text="130"]', "--spdex-text-scale")).toBe("1.3");
  });

  it("lays the page out the same at every text size: no layout rule reads the size", () => {
    // Switching A / A+ / A++ must never move the dock, the widget or the key
    // hints (the breakpoints are viewport em; the columns are rem). Only the
    // root's scale and the header-row sticker (A and A+ only) may key off it.
    const keyed = RULES.flatMap((r) => r.selectors).filter((s) => s.includes("data-text"));
    expect(keyed.filter((s) => !/^:root\[data-text="(100|130)"\]$/.test(s) && !s.includes(".spdex-stickers--left"))).toEqual([]);
  });

  it("makes dim and faint text ink under more contrast, by the setting or the system's", () => {
    for (const selector of [':root[data-contrast="more"]', "html:root"]) {
      const tokens = block(selector);
      expect(tokens.get("--text-dim"), selector).toBe("var(--ink)");
      expect(tokens.get("--text-faint"), selector).toBe("var(--ink)");
      expect(tokens.get("--hairline-boost"), selector).toBe("1");
      expect(tokens.get("--halftone"), selector).toBe("none");
      expect(tokens.get("--bgart-image"), selector).toBe("none");
      expect(tokens.get("--focus-ring"), selector).toBe("4px");
      expect(tokens.get("--placeholder-alpha"), selector).toBe("0.85");
    }
    // The two blocks say the same thing: one isn't a stale copy of the other.
    expect([...block(':root[data-contrast="more"]')]).toEqual([...block("html:root")]);
    expect(RAW).toMatch(/@media \(prefers-contrast: more\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?html:root \{/);
  });

  it("draws every translucent ink line with the hairline boost, so more contrast makes it solid", () => {
    const lines = RULES.flatMap((r) =>
      r.declarations.filter(([p, v]) => /^(border|outline)/.test(p) && v.includes("rgba(var(--ink-rgb)")),
    );
    expect(lines.length).toBeGreaterThan(10);
    for (const [property, value] of lines) {
      expect(`${property}: ${value}`).toMatch(/rgba\(var\(--ink-rgb\), calc\([\d.]+ \+ var\(--hairline-boost\)\)\)/);
    }
  });

  it("stops every animation and transition under the in-page LESS setting as well as the system's", () => {
    const blocks = [...CSS.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/g)];
    expect(blocks.length).toBeGreaterThan(5);
    for (const [, body] of blocks) {
      for (const rule of parseRules(body!)) {
        for (const selector of rule.selectors) expect(selector).toMatch(/^:root:not\(\[data-motion="reduce"\]\) /);
      }
    }
    // Nothing animates or transitions outside those blocks, except the one
    // frame that turns transitions off.
    const outside = CSS.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    const moving = parseRules(outside).flatMap((r) =>
      r.declarations
        .filter(([p, v]) => (p === "animation" || p === "transition") && v !== "none !important")
        .map(([p, v]) => `${r.selectors.join(", ")} { ${p}: ${v} }`),
    );
    expect(moving).toEqual([]);
    // The still ticker applies under the setting too.
    expect(declared(':root[data-motion="reduce"] .spdex-ticker__seg[aria-hidden="true"]', "display")).toBe("none");
  });

  it("keeps a closed tile's until-found body out of the display: none rule", () => {
    expect(declared('[hidden]:not([hidden="until-found" i])', "display")).toBe("none !important");
    expect(CSS).not.toMatch(/^\s*\[hidden\]\s*\{/m);
    for (const property of ["padding", "border", "margin"]) expect(declared(".spdex-tile__body", property)).toBe("0");
  });

  it("hides decoration under more contrast, forced colours and print", () => {
    expect(declared(':root[data-contrast="more"] .spdex-art', "display")).toBe("none !important");
    expect(CSS).toMatch(/@media \(forced-colors: active\) \{[^}]*\}[^}]*\.spdex-art \{ display: none !important; \}/);
    // The backdrop's picture, under the masthead and the widget's gap as
    // well (more contrast: the token block, checked above).
    expect(CSS).toMatch(/@media \(forced-colors: active\) \{[^}]*\}[^}]*\.spdex-art \{ display: none !important; \}\s*html \{ --bgart-image: none !important; \}\s*\}/);
    expect(CSS).toMatch(/@media print \{\s*\.spdex-art \{ display: none !important; \}\s*html \{ --bgart-image: none !important; \}\s*\}/);
  });
});

describe("the wordmark", () => {
  it("keeps spDEX's own case: the stylesheet never capitalises the masthead or the footer's label", () => {
    expect(declared(".spdex-masthead__title", "text-transform")).toBe("none");
    expect(declared(".spdex-footer__rule", "text-transform")).toBe("none");
    // And inside a capitalised label, through Brand.
    expect(declared(".spdex-brand", "text-transform")).toBe("none");
  });
});
