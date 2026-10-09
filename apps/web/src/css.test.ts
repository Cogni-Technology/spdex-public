/**
 * Every stylesheet's text sizes are in rem, so the in-page text size (the
 * display dock's A / A+ / A++, `data-text` on the root) and the browser's own
 * default size scale all of them (WCAG 1.4.4). One size in px would stay put
 * while everything around it grew.
 *
 * Found by walking the directories rather than from a list, so a new
 * stylesheet is covered the day it is added. Print rules are exempt: they set
 * sizes for paper, in pt.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRS = ["packages/ui/src", "apps/web/src"];

function stylesheets(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") found.push(...stylesheets(path));
    } else if (entry.name.endsWith(".css")) {
      found.push(path);
    }
  }
  return found;
}

/** The stylesheet without comments or `@media print { … }` blocks, newlines kept so line numbers hold. */
function withoutPrint(css: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  let out = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  for (let at = out.search(/@media\s+print\b/); at !== -1; at = out.search(/@media\s+print\b/)) {
    const open = out.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < out.length; end++) {
      if (out[end] === "{") depth++;
      else if (out[end] === "}" && --depth === 0) break;
    }
    out = out.slice(0, at) + blank(out.slice(at, end + 1)) + out.slice(end + 1);
  }
  return out;
}

const FILES = DIRS.flatMap(stylesheets);

describe("text sizes", () => {
  it("finds the stylesheets", () => {
    // A guard for the walk, not the rule: the theme and the app's own sheets.
    expect(FILES).toContain("packages/ui/src/theme.css");
    expect(FILES).toContain("apps/web/src/fonts.css");
    expect(FILES.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of FILES) {
    it(`${file}: no font size in px outside print rules`, () => {
      const css = withoutPrint(readFileSync(join(ROOT, file), "utf8"));
      const found: string[] = [];
      css.split("\n").forEach((line, i) => {
        // `font-size: 12px` and the `font` shorthand's size (`font: 700 12px/1.2 …`).
        if (/font-size\s*:[^;}]*\d(?:\.\d+)?px\b/.test(line) || /\bfont\s*:[^;}]*\d(?:\.\d+)?px\b/.test(line)) {
          found.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
      expect(found).toEqual([]);
    });
  }

  it("exempts print rules, and only those", () => {
    const sample = "a { font-size: 1rem; }\n@media print {\n  a { font-size: 10pt; }\n  b { font-size: 9px; }\n}\nc { font-size: 12px; }";
    const kept = withoutPrint(sample);
    expect(kept).not.toContain("9px");
    expect(kept).toContain("12px");
    expect(kept.split("\n")).toHaveLength(sample.split("\n").length);
  });
});
