/**
 * The keeper and its report are an operator's tools, and the app must never
 * reach them (AGENTS.md rules 4 and 5): they sign with a hot key, read logs
 * from endpoints an operator chose, and write files. The app is a static
 * bundle that records nothing about its users.
 *
 * So `@spdex/vault`'s root export — the one the app imports — leaves them
 * out, and they sit behind `@spdex/vault/keeper`, which nothing under
 * apps/web/src may import. And none of them makes a request of its own: every
 * `fetch` is in `scripts/`, to an endpoint the operator configured.
 *
 * One keeper module is the exception: `keeper-plan.ts`, the keeper's pure
 * arithmetic (which due vaults a batch carries, and its gas limit), which the
 * app's "Help run the network" uses too. It reads nothing, signs nothing and
 * holds no key, and this file pins that it imports only types, the artifacts
 * and the fee, so it can never become the way the rest of the keeper leaks
 * into the app.
 *
 * Sources are read through Vite's `import.meta.glob`, because `src` gets no
 * Node types (tsconfig.json) and this file is type-checked with it.
 */

import { describe, expect, it } from "vitest";
import * as root from "./index.js";
import * as keeper from "./keeper.js";
import * as plan from "./keeper-plan.js";
import * as report from "./report.js";

declare global {
  interface ImportMeta {
    glob(pattern: string | string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

const vaultSources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true });
const appSources = import.meta.glob(["../../../apps/web/src/**/*.ts", "../../../apps/web/src/**/*.tsx"], { query: "?raw", import: "default", eager: true });

/** Every module specifier a source imports or re-exports, statically or dynamically. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) found.push(match[1]!);
  return found;
}

/** Every keeper module but the pure planning (see the header). */
const operatorModules = (path: string) => /(^|\/)(keeper|report)[^/]*\.(ts|js)$/.test(path) && !/(^|\/)keeper-plan\.(ts|js)$/.test(path);

describe("the keeper and the report stay out of the app", () => {
  it("finds the sources it checks", () => {
    expect(Object.keys(vaultSources)).toEqual(expect.arrayContaining(["./index.ts", "./keeper.ts", "./report.ts"]));
    expect(Object.keys(appSources).length).toBeGreaterThan(20);
  });

  it("index.ts neither imports nor re-exports a keeper module or the report", () => {
    const imported = specifiers(vaultSources["./index.ts"]!);
    expect(imported.filter(operatorModules)).toEqual([]);
    // Nor does anything index.ts imports from this package.
    for (const spec of imported.filter((s) => s.startsWith("./"))) {
      const source = vaultSources[spec.replace(/\.js$/, ".ts")];
      expect(source, spec).toBeDefined();
      expect(specifiers(source!).filter(operatorModules), spec).toEqual([]);
    }
  });

  it("no export of the keeper's or the report's reaches the root export, but the pure planning", () => {
    const leaked = [...Object.keys(keeper), ...Object.keys(report)].filter((name) => name in root && !(name in plan));
    expect(leaked).toEqual([]);
  });

  it("keeper-plan.ts, the one keeper module the root re-exports, imports only types, the artifacts and the fee", () => {
    const source = vaultSources["./keeper-plan.ts"]!;
    const runtime = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(runtime.sort()).toEqual(["./artifacts.js", "./fee.js"]);
    expect(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bnavigator\.sendBeacon\b/.test(source)).toBe(false);
  });

  it("no file under apps/web/src imports @spdex/vault/keeper, or reaches the keeper or the report by path", () => {
    const offenders = Object.entries(appSources).flatMap(([path, source]) =>
      specifiers(source)
        .filter((spec) => spec.startsWith("@spdex/vault/") || (spec.includes("packages/vault") && operatorModules(spec)))
        .map((spec) => `${path}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("no module under src makes a request: the operator's scripts do, to the endpoints they configured", () => {
    const requesting = Object.entries(vaultSources)
      .filter(([path]) => !path.endsWith(".test.ts"))
      .filter(([, source]) => /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bnavigator\.sendBeacon\b/.test(source))
      .map(([path]) => path);
    expect(requesting).toEqual([]);
  });
});
