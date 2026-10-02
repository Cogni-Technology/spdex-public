/**
 * Sitewide copy rules that a reader can't check one panel at a time.
 *
 * No user-facing string says "Expert → …" or "in Expert": a place is named
 * with its label from lib/places.tsx ("Settings → Network service"), and a
 * line that sends someone there ends with a `GoTo`, which switches views on
 * its own when the place is only in the Expert view (UI rule R5,
 * docs/ARCHITECTURE.md).
 *
 * No user-facing string calls spDEX a trading tool (UI rule R7): the
 * SPX motto is "STOP TRADING AND BELIEVE IN SOMETHING", so the page says
 * "buy", "swap" and "Buy SPX" instead. The one exception is the motto itself,
 * quoted and attributed to the community as a saying. This is the source-side
 * half; the rendered page is checked in e2e/shell.spec.ts.
 *
 * No user-facing string says "official" or "unofficial" (SPX6900 has no
 * official team, so neither word measures anything), or "commandment": the
 * community's lines are sayings. spx6900.com's own addresses are links, not
 * copy, and are the one place the word appears.
 *
 * What counts as user-facing is every string literal, template literal and
 * piece of JSX text under apps/web/src, read with the parser Vite itself uses
 * (oxc), so comments are never mistaken for copy. Tests are left out: they
 * quote old wording on purpose.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";
import { OFFICIAL_RELEASE } from "./lib/disclaimer.js";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every .ts and .tsx file under `dir`, tests left out. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

interface AstNode {
  type: string;
  start: number;
  value?: unknown;
  source?: AstNode | null;
  [key: string]: unknown;
}

const MODULE_NODES = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]);

/**
 * The copy in one file: its string literals, template pieces and JSX text,
 * each with its line. Read with the parser Vite itself uses (oxc), so a
 * comment is never mistaken for copy and a regular expression never for a
 * string. Module specifiers are paths, not copy.
 */
export function copyIn(path: string, text = readFileSync(path, "utf8")): { line: number; text: string }[] {
  const parsed = parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" });
  if (parsed.errors.length > 0) throw new Error(`${path}: ${parsed.errors[0]!.message}`);
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  const found: { line: number; text: string }[] = [];
  const visit = (node: unknown, parent: AstNode | null): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const current = node as AstNode;
    if (typeof current.type === "string") {
      const isSpecifier = parent !== null && MODULE_NODES.has(parent.type) && parent.source === current;
      if (current.type === "Literal" && typeof current.value === "string" && !isSpecifier) {
        found.push({ line: lineAt(current.start), text: current.value });
      } else if (current.type === "TemplateElement") {
        const value = current.value as { cooked?: string | null; raw: string };
        found.push({ line: lineAt(current.start), text: value.cooked ?? value.raw });
      } else if (current.type === "JSXText" && typeof current.value === "string") {
        found.push({ line: lineAt(current.start), text: current.value });
      }
    }
    for (const [key, child] of Object.entries(current)) {
      if (key !== "type" && child !== null && typeof child === "object") visit(child, typeof current.type === "string" ? current : parent);
    }
  };
  visit(parsed.program, null);
  return found;
}

const EXPERT_PLACE = /\bin Expert\b|Expert →/;

/** UI rule R7: "trade", "trades", "traded" or "trading", in any case. */
const TRADE_WORD = /\btrad(e|es|ed|ing)\b/i;

/**
 * Prose, as opposed to identifiers: a test id ("tile-trade"), a tile id
 * ("trade") or a list of class names ("spdex-field__hint spdex-trade-hints")
 * never reaches the page as words.
 */
const isProse = (text: string) => {
  const words = text.trim().split(/\s+/);
  return words.length > 1 && !words.every((word) => /^[\w-]+$/.test(word) && /[-_]/.test(word));
};

/** Other packages whose strings reach the page: the Features dialog's texts, the UI kit, the Guard's messages. */
const OTHER_ROOTS = ["../../../packages/config/src", "../../../packages/ui/src", "../../../packages/guard/src"].map((dir) =>
  fileURLToPath(new URL(dir, import.meta.url)),
);

/** The SPX motto, shown only as a quoted saying, attributed to the community. */
const MOTTO = "STOP TRADING AND BELIEVE IN SOMETHING";

describe("sitewide copy", () => {
  it("finds copy in strings, templates and JSX, and never in comments", () => {
    const sample = [
      "// Expert → Tips, in a comment",
      "/* in Expert */",
      'const a = "one";',
      "const b = `two ${a} three`;",
      "const c = <p>four {a} five</p>;",
      'import x from "./in Expert.js";',
    ].join("\n");
    const texts = copyIn("sample.tsx", sample).map((c) => c.text.trim());
    expect(texts).toEqual(expect.arrayContaining(["one", "two", "three", "four", "five"]));
    expect(texts.join(" ")).not.toMatch(EXPERT_PLACE);
  });

  it('never sends anyone to "Expert → …" or "in Expert": places go by their label and a GoTo', () => {
    const offenders: string[] = [];
    for (const path of sources(SRC)) {
      for (const { line, text } of copyIn(path)) {
        if (EXPERT_PLACE.test(text)) offenders.push(`${relative(SRC, path)}:${line}: ${text.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never says "trade" or "trading" in prose, except the motto quoted as a saying', () => {
    const offenders: string[] = [];
    for (const path of [...sources(SRC), ...OTHER_ROOTS.flatMap((root) => sources(root))]) {
      for (const { line, text } of copyIn(path)) {
        if (!isProse(text) || !TRADE_WORD.test(text) || text.trim() === MOTTO) continue;
        offenders.push(`${relative(SRC, path)}:${line}: ${text.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
    // The one exception is where the motto is attributed.
    expect(readFileSync(join(SRC, "lib/culture/sayings.ts"), "utf8")).toContain(`believe: "${MOTTO}"`);
  });

  it('never says "official", "unofficial" or "commandment"', () => {
    const offenders: string[] = [];
    for (const path of [...sources(SRC), ...OTHER_ROOTS.flatMap((root) => sources(root))]) {
      for (const { line, text } of copyIn(path)) {
        // The disclaimer's one "On an official release" (UI rule R8) is its
        // constant's own literal, and nowhere else.
        const words = text.replace(/https:\/\/www\.spx6900\.com\/commandment\//g, "").replace(OFFICIAL_RELEASE, "");
        if (/official|commandment/i.test(words)) offenders.push(`${relative(SRC, path)}:${line}: ${text.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
