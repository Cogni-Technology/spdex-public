/**
 * Every request spDEX makes goes to the network service in use (the built-in
 * one the disclaimer names, or one the person chose) or the relay the person
 * chose (AGENTS.md rule 4: no telemetry, analytics or error reporting). Nothing
 * else checks that mechanically: the `lint` stage runs nothing, and the CSP
 * leaves `connect-src` open so people can choose any endpoint. This is the
 * partial check.
 *
 * It reads the app's source, the host packages', the module SDK's and the
 * first-party modules' (the `index.mjs` the app runs natively and the
 * `module.js` the sandbox runs; tests aside), parsed, and fails on each way
 * the code could make a request: any reference to `fetch`, `XMLHttpRequest`,
 * `WebSocket`, `EventSource` or `sendBeacon` (a call, or a reference kept to
 * call later: `const f = fetch`, `fetch.call(…)`, `globalThis["fetch"]`),
 * and `new Image(`. The few that are meant to be there are allowed by count
 * per file, because line numbers move with every edit. A new one in an
 * allowed file fails as well, and so does an allowance nobody uses any more,
 * so the list can't keep room for a call that was taken out.
 *
 * It also fails on an `icon`, `image` or `badge` key in a file that shows a
 * notification: each of those is an address the browser would fetch.
 *
 * Stylesheets are read too: every address in them (a `url()`, an
 * `@import`, a bare string in an `image-set()`) is a data: URL, a
 * `#fragment`, or a file of this repository's that the build bundles (the
 * fonts, the backdrop's picture), never another origin. An `@supports`
 * condition is skipped: testing whether a browser understands an address
 * fetches nothing. The picture is named only where there are three columns
 * (85em), so no phone loads it, whichever way it is held. So is the page
 * itself, index.html, and the art's components (components/shell/art):
 * inline SVG only, with no link, image or `<use>` that could name an address.
 *
 * What it can't see is a request made some other way: a remote `src` on an
 * element React renders, a name built at run time (`globalThis[name]`). The
 * CSP's `img-src 'self' data:` covers images, and `default-src 'self'` fonts
 * and styles; the rest is review. Links are fine everywhere: a navigation the
 * person clicks is not a fetch.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCANNED_DIRS = [
  "apps/web/src",
  ...["chain", "core", "config", "guard", "host", "router", "ui", "vault", "module-sdk"].map((p) => `packages/${p}/src`),
];

/**
 * The first-party modules' code, as the app runs it: `index.mjs` natively
 * (engine.ts imports it), `module.js` in the sandbox. Conformance runs them
 * in QuickJS, which has no `fetch`, so a guarded `globalThis.fetch?.(…)` would
 * pass it and still make a request natively.
 */
const MODULE_FILES = readdirSync(join(ROOT, "modules"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => ["index.mjs", "module.js"].map((file) => `modules/${entry.name}/${file}`))
  .filter((file) => existsSync(join(ROOT, file)));

/** The browser's ways to make a request, by the name code reaches them under. */
const REQUEST_NAMES = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon"] as const;

type RequestCall = (typeof REQUEST_NAMES)[number] | "new Image(";

interface Allowance {
  file: string;
  call: RequestCall;
  count: number;
  /** Where each of these requests goes, and why that is the person's choice. */
  why: string;
  /**
   * Set while the file is still being written in a parallel phase: `count` is
   * then a ceiling, and the file may not exist yet. The integration owner
   * removes it once the file lands, and the count is exact again.
   */
  pending?: string;
}

const ALLOWED: readonly Allowance[] = [
  {
    file: "packages/chain/src/reader.ts",
    call: "fetch",
    count: 1,
    why:
      "httpRpc: every JSON-RPC read, to the network service in use: the built-in one the disclaimer names (used " +
      "without asking only at its publisher's origin) or the one the person chose. A request answered HTTP 429 is " +
      "sent once more, to the same service.",
  },
  {
    file: "apps/web/src/lib/submit.ts",
    call: "fetch",
    count: 2,
    why: "Private sending: a JSON-RPC post and a signed transaction, both to the relay the person chose.",
  },
  {
    file: "apps/web/src/components/FirstRun.tsx",
    call: "fetch",
    count: 1,
    why:
      "Asking the service the person just typed, or just picked by its button (on the first-run screen or the " +
      "built-in service's notice), which chain it serves.",
  },
  {
    file: "apps/web/src/lib/culture/card.ts",
    call: "new Image(",
    count: 1,
    why: 'The "I bought" card\'s PNG: the card\'s own SVG, as a data: URL, drawn onto a canvas. A data: URL makes no request.',
  },
  {
    file: "apps/web/src/lib/culture/card.ts",
    call: "fetch",
    count: 1,
    why:
      'The "I bought" card\'s PNG embeds the display faces fonts.css already loads: the four font files are read back ' +
      "from this copy's own origin (the build's assets, by the URLs the build gives them), never another. Nothing is sent.",
  },
];

/** A file that shows a notification: it constructs one, calls showNotification, or builds its options. */
const SHOWS_NOTIFICATION = /\bnew\s+(?:[\w$]+\s*\.\s*)*Notification\s*\(|\.showNotification\s*\(|\bNotificationOptions\b/;

/** An `icon`, `image` or `badge` key, written as a property, a shorthand, a quoted key or an assignment. */
const NOTIFICATION_IMAGE_KEY = /[{,]\s*["']?(icon|image|badge)["']?\s*[:,}]|\.\s*(icon|image|badge)\s*=(?!=)/g;

// ─── Reading the source ───────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") found.push(...sourceFiles(path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The source with every comment blanked out, newlines kept so line numbers
 * still point at the right place.
 *
 * Comments come from a real parser rather than a pattern: a pattern would
 * take the `//` in "https://" for a comment and hide the rest of the line, or
 * the apostrophe in `<p>Don't</p>` for a string and hide everything after it.
 */
function withoutComments(name: string, source: string): string {
  const parsed = parseSync(name, source);
  if (parsed.errors.length > 0) {
    throw new Error(`couldn't parse ${name}: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  let out = source;
  for (const { start, end } of parsed.comments) {
    out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, " ") + out.slice(end);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

interface Node {
  type: string;
  start: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/**
 * Every request the code could make, by line: each reference to a request
 * name (a string naming one counts where it picks a property, as in
 * `globalThis["fetch"]`), and each `new Image(`. Read from the parsed code,
 * so a word in a string or a comment ("Failed to fetch") is not one, and an
 * object's own key named `fetch` isn't either.
 */
function requestsIn(name: string, source: string): Map<RequestCall, number[]> {
  const parsed = parseSync(name, source);
  if (parsed.errors.length > 0) throw new Error(`couldn't parse ${name}: ${parsed.errors.map((e) => e.message).join("; ")}`);
  const found = new Map<RequestCall, number[]>();
  const add = (call: RequestCall, at: number) => found.set(call, [...(found.get(call) ?? []), lineOf(source, at)]);
  const names = new Set<string>(REQUEST_NAMES);
  const visit = (node: Node, parent: Node | null, key: string) => {
    const ownKey = parent !== null && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key" && parent["computed"] !== true;
    if (node.type === "Identifier" && names.has(node["name"] as string) && !ownKey) add(node["name"] as RequestCall, node.start);
    if (node.type === "Literal" && typeof node["value"] === "string" && names.has(node["value"]) && parent?.type === "MemberExpression" && key === "property") {
      add(node["value"] as RequestCall, node.start);
    }
    if (node.type === "NewExpression") {
      const callee = node["callee"] as Node;
      const calleeName = callee.type === "Identifier" ? callee["name"] : callee.type === "MemberExpression" ? (callee["property"] as Node)["name"] : null;
      if (calleeName === "Image") add("new Image(", node.start);
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (Array.isArray(child)) for (const item of child) isNode(item) && visit(item, node, childKey);
      else if (isNode(child)) visit(child, node, childKey);
    }
  };
  visit(parsed.program as unknown as Node, null, "");
  for (const lines of found.values()) lines.sort((a, b) => a - b);
  return found;
}

function notificationImageKeys(code: string): number[] {
  if (!SHOWS_NOTIFICATION.test(code)) return [];
  return [...code.matchAll(NOTIFICATION_IMAGE_KEY)].map((m) => lineOf(code, m.index));
}

const FILES = [...SCANNED_DIRS.flatMap(sourceFiles), ...MODULE_FILES];
const SOURCE = new Map(FILES.map((file) => [file, readFileSync(join(ROOT, file), "utf8")]));
const CODE = new Map([...SOURCE].map(([file, source]) => [file, withoutComments(file, source)]));

// ─── The checks ───────────────────────────────────────────────────────────────

describe("requests", () => {
  it("reads the source it claims to", () => {
    // A scan that found nothing would pass everything.
    expect(FILES.length).toBeGreaterThan(100);
    for (const allowance of ALLOWED.filter((a) => !a.pending)) expect(FILES).toContain(allowance.file);
    // Every first-party module, in both forms.
    expect(MODULE_FILES.filter((f) => f.endsWith("/index.mjs")).length).toBeGreaterThanOrEqual(5);
    expect(FILES).toContain("packages/module-sdk/src/index.ts");
  });

  it("go only where the person chose: every request call is an allowed one", () => {
    const problems: string[] = [];
    for (const [file, source] of SOURCE) {
      for (const [call, lines] of requestsIn(file, source)) {
        const allowance = ALLOWED.find((a) => a.file === file && a.call === call);
        if (!allowance) {
          problems.push(`${file}:${lines.join(",")}: ${call} — a request not on the allowed list`);
        } else if (lines.length > allowance.count) {
          problems.push(`${file}:${lines.join(",")}: ${lines.length} × ${call}, but ${allowance.count} allowed`);
        }
      }
    }
    expect(
      problems,
      "Every request goes to the network service in use (the built-in one the disclaimer names, or one the person chose) or the relay the person chose (AGENTS.md rule 4). If this one does, add it to ALLOWED with where it goes; if not, it has to go.",
    ).toEqual([]);
  });

  it("allow nothing that isn't used, so the list can't keep room for a request that was taken out", () => {
    const unused = ALLOWED.filter((a) => !a.pending)
      .map((a) => ({ ...a, found: SOURCE.has(a.file) ? (requestsIn(a.file, SOURCE.get(a.file)!).get(a.call)?.length ?? 0) : 0 }))
      .filter((a) => a.found !== a.count)
      .map((a) => `${a.file}: ${a.found} × ${a.call}, but ${a.count} allowed`);
    expect(unused).toEqual([]);
  });

  it("include no notification that fetches an icon, image or badge", () => {
    const problems = [...CODE].flatMap(([file, code]) => {
      const lines = notificationImageKeys(code);
      return lines.length > 0 ? [`${file}:${lines.join(",")}`] : [];
    });
    expect(problems).toEqual([]);
  });
});

describe("the scan itself", () => {
  const scan = (source: string, name = "sample.tsx") => requestsIn(name, source);

  it("ignores comments and strings, and only those", () => {
    expect(scan("// fetch(url)\n/* new WebSocket(url) */ const a = 1;").size).toBe(0);
    expect(scan('const url = "https://example.org"; fetch(url);').get("fetch")).toEqual([1]);
    expect(scan("const s = `// not a comment ${fetch(u)}`;").get("fetch")).toEqual([1]);
    expect(scan('const e = /Failed to fetch/; const m = "fetch it";', "sample.ts").size).toBe(0);
  });

  it("isn't thrown by an apostrophe in JSX text", () => {
    const source = "const a = <p>Don't</p>;\nconst go = () => fetch(u);\nconst b = <p>It's</p>;";
    expect(scan(source).get("fetch")).toEqual([2]);
  });

  it("isn't thrown by a regular expression that looks like a comment or a string", () => {
    const source = "const r = /['\"/]/g;\nconst s = /\\/\\//;\nnew EventSource(u);";
    expect(scan(source, "sample.ts").get("EventSource")).toEqual([3]);
  });

  it("finds every kind of request, and nothing named like one", () => {
    const source = [
      "window.fetch(u)",
      "new XMLHttpRequest()",
      "new WebSocket(u)",
      "navigator.sendBeacon(u, b)",
      "const img = new Image()",
      "prefetch(u); refetch(); fetchRates;",
    ].join("\n");
    expect(Object.fromEntries(scan(source, "sample.ts"))).toEqual({
      fetch: [1],
      XMLHttpRequest: [2],
      WebSocket: [3],
      sendBeacon: [4],
      "new Image(": [5],
    });
  });

  it("finds a request kept to make later, not only a call", () => {
    const source = ["const f = fetch;", "f(u);", "fetch.call(null, u);", 'globalThis["fetch"](u);', "globalThis.fetch?.(u);"].join("\n");
    expect(scan(source, "sample.ts").get("fetch")).toEqual([1, 3, 4, 5]);
    // An object's own key of that name is no reference to it.
    expect(scan("const o = { fetch: 1, sendBeacon() {} };", "sample.ts").size).toBe(0);
  });

  it("catches an image key in a notification, however it is written", () => {
    const keys = (source: string) => notificationImageKeys(withoutComments("sample.ts", source));
    expect(keys('new Notification("t", { body: "b", tag: "x" })')).toEqual([]);
    expect(keys('new env.Notification("t", { body: "b", icon: "/i.png" })')).toEqual([1]);
    expect(keys('const o: NotificationOptions = { body };\no.badge = "/b.png";')).toEqual([2]);
    expect(keys('const image = "x";\nnew Notification("t", { body, image });')).toEqual([2]);
    expect(keys('registration.showNotification("t", { "icon": u })')).toEqual([1]);
    // A file that shows no notification may use these words freely.
    expect(keys('const card = { image: "data:", badge: 1 };')).toEqual([]);
  });
});

// ─── Stylesheets and the page ─────────────────────────────────────────────────

function stylesheetFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") found.push(...stylesheetFiles(path));
    } else if (entry.name.endsWith(".css")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every address a stylesheet names, with where: each `url()`, however it is
 * quoted; each `@import "…"`; and each bare string an `image-set()` or
 * `-webkit-image-set()` takes as an image (not one inside its `type()` or
 * `url()`, which the rest covers). Comments and `@supports` conditions are
 * blanked first, keeping every offset: neither fetches anything.
 */
function stylesheetReferences(css: string): { at: number; address: string }[] {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/@supports[^{]*/g, blank);
  const references = [
    ...[...code.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)].map((m) => ({ at: m.index, address: m[2]!.trim() })),
    ...[...code.matchAll(/@import\s+(["'])([^"']*)\1/g)].map((m) => ({ at: m.index, address: m[2]!.trim() })),
  ];
  for (const set of code.matchAll(/(?:-webkit-)?image-set\(/gi)) {
    let depth = 0;
    for (let i = set.index + set[0].length; i < code.length && depth >= 0; i++) {
      const c = code[i]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === '"' || c === "'") {
        const end = code.indexOf(c, i + 1);
        if (end < 0) break;
        if (depth === 0) references.push({ at: i, address: code.slice(i + 1, end).trim() });
        i = end;
      }
    }
  }
  return references.sort((a, b) => a.at - b.at);
}

/**
 * Every address a stylesheet names that isn't a data: URL or a fragment, with
 * its line. A relative one is kept only when the file it names exists beside
 * the stylesheet in this repository: the build then bundles it, same origin.
 */
function stylesheetAddresses(file: string, css: string): string[] {
  const problems: string[] = [];
  for (const { at, address } of stylesheetReferences(css)) {
    if (address.startsWith("data:") || address.startsWith("#")) continue;
    const local = !/^[a-z][a-z\d+.-]*:|^\/\//i.test(address) && !address.startsWith("/");
    const bundled = local && existsSync(join(ROOT, dirname(file), address.split(/[?#]/)[0]!));
    if (!bundled) problems.push(`${file}:${lineOf(css, at)}: ${address}`);
  }
  return problems;
}

const STYLESHEETS = ["packages/ui/src", "apps/web/src"].flatMap(stylesheetFiles);

/** The preludes of the blocks around `index` (`@media …`, `@supports …`, selectors), outermost first. */
function enclosingAtRules(css: string, index: number): string[] {
  const open: string[] = [];
  let since = 0;
  for (let i = 0; i < index; i++) {
    if (css[i] === "{") open.push(css.slice(since, i).trim());
    else if (css[i] === "}") open.pop();
    if (css[i] === "{" || css[i] === "}" || css[i] === ";") since = i + 1;
  }
  return open;
}

describe("stylesheets and the page", () => {
  it("reads the stylesheets it claims to", () => {
    expect(STYLESHEETS).toContain("packages/ui/src/theme.css");
    expect(STYLESHEETS).toContain("apps/web/src/fonts.css");
  });

  it("name no other origin: every url() and @import is data:, a fragment, or a file the build bundles", () => {
    const problems = STYLESHEETS.flatMap((file) => stylesheetAddresses(file, readFileSync(join(ROOT, file), "utf8")));
    expect(problems).toEqual([]);
  });

  it("load the bundled fonts from this repository, each beside its licence", () => {
    const fonts = readFileSync(join(ROOT, "apps/web/src/fonts.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const files = [...fonts.matchAll(/url\("(\.\/assets\/fonts\/[^"]+)"\)/g)].map((m) => m[1]!);
    expect(files.length).toBe(4);
    for (const file of files) {
      expect(existsSync(join(ROOT, "apps/web/src", file)), file).toBe(true);
      expect(existsSync(join(ROOT, "apps/web/src", dirname(file), "OFL.txt")), `${file}: OFL.txt beside it`).toBe(true);
    }
    // No face may ask the system for an installed copy either: every browser draws the same.
    expect(fonts).not.toMatch(/local\(/);
    expect([...fonts.matchAll(/font-display:\s*swap/g)]).toHaveLength(4);
  });

  it("load the backdrop's picture from this repository, beside its README, and only where there are three columns", () => {
    const css = readFileSync(join(ROOT, "apps/web/src/backdrop.css"), "utf8");
    // Every address, however it is written (url() in any quotes, or a bare
    // image-set() string), counts toward the set and the checks below.
    const found = stylesheetReferences(css);
    const code = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    expect(new Set(found.map((r) => r.address))).toEqual(new Set(["./assets/backdrop/backdrop.avif", "./assets/backdrop/backdrop.webp"]));
    for (const file of ["backdrop.avif", "backdrop.webp"]) {
      // A picture every visitor on a wide screen downloads: kept small.
      expect(statSync(join(ROOT, "apps/web/src/assets/backdrop", file)).size, file).toBeLessThan(160_000);
    }
    expect(existsSync(join(ROOT, "apps/web/src/assets/backdrop/README.md"))).toBe(true);
    // Each name sits inside `@media (min-width: 85em)`, where the layer shows
    // (no phone is that wide, held either way), and never where Safari on an
    // iPhone or iPad would read it.
    for (const { at, address } of found) {
      const around = enclosingAtRules(code, at);
      expect(around, address).toContain("@media (min-width: 85em)");
      expect(around, address).toContain("@supports not (-webkit-touch-callout: none)");
    }
    // The AVIF only where the browser can choose by type, the WebP everywhere else.
    expect(css).toMatch(/--bgart-image: url\("\.\/assets\/backdrop\/backdrop\.webp"\);/);
    expect(css).toContain(
      'image-set(url("./assets/backdrop/backdrop.avif") type("image/avif"), url("./assets/backdrop/backdrop.webp") type("image/webp"))',
    );
  });

  it("catches an address from another origin, however it is written", () => {
    const check = (css: string) => stylesheetAddresses("apps/web/src/sample.css", css);
    expect(check('a { background: url("data:image/svg+xml,%3Csvg%3E"); } b { fill: url(#g); }')).toEqual([]);
    expect(check("@font-face { src: url(https://fonts.gstatic.com/x.woff2); }")).toHaveLength(1);
    expect(check('@font-face { src: url("//cdn.example/x.woff2"); }')).toHaveLength(1);
    expect(check("a { background: url('/x.png'); }")).toHaveLength(1);
    expect(check('@import "https://fonts.googleapis.com/css2?family=Inter";')).toHaveLength(1);
    expect(check("@import url(https://example.org/a.css);")).toHaveLength(1);
    // A relative file that isn't there would be a broken build, or a request for nothing.
    expect(check('a { src: url("./assets/fonts/missing.ttf"); }')).toHaveLength(1);
    expect(check('a { src: url("./assets/fonts/orbitron/Orbitron-VariableFont_wght.ttf"); }')).toEqual([]);
    // An image-set() takes a bare string as an image, as well as a url().
    expect(check('a { background: image-set("https://cdn.example/a.avif" type("image/avif"), "./x.png" 2x); }')).toHaveLength(2);
    expect(check("a { background: -webkit-image-set('//cdn.example/a.png' 1x); }")).toHaveLength(1);
    expect(check('a { background: image-set(url("https://cdn.example/a.png") 1x); }')).toHaveLength(1);
    // Its type() names a type, not a file; an @supports condition fetches nothing.
    expect(check('a { background: image-set("./assets/backdrop/backdrop.webp" type("image/webp")); }')).toEqual([]);
    expect(check('@supports (background-image: image-set("a.avif" type("image/avif"))) { a { color: red; } }')).toEqual([]);
  });

  it("the art's components name no address: no image, no remote link, nothing but inline SVG", () => {
    const dir = "apps/web/src/components/shell/art";
    const files = sourceFiles(dir);
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const code = withoutComments(file, readFileSync(join(ROOT, file), "utf8"));
      expect(code, file).not.toMatch(/\b(?:href|xlinkHref|src|srcSet)\s*=\s*\{?\s*["'`](?:[a-z][a-z\d+.-]*:)?\/\//i);
      expect(code, file).not.toMatch(/<(?:img|image|foreignObject|use)\b/);
      // Decoration only: hidden from assistive technology, never focusable.
      if (/<svg\b/.test(code)) {
        expect(code, file).toContain('aria-hidden="true"');
        expect(code, file).toContain('focusable="false"');
      }
      // Small: each piece of art stays under 3 KB of source.
      expect(readFileSync(join(ROOT, file)).byteLength, file).toBeLessThan(3_072);
    }
  });

  it("the page loads nothing from another origin: no remote script, stylesheet or preload", () => {
    const html = readFileSync(join(ROOT, "apps/web/index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const remote = [...html.matchAll(/\b(?:src|href)\s*=\s*["']((?:[a-z][a-z\d+.-]*:)?\/\/[^"']*)["']/gi)].map((m) => m[1]);
    expect(remote).toEqual([]);
    // The CSP still allows only this origin for everything but connections.
    expect(html).toMatch(/default-src 'self'/);
    expect(html).not.toMatch(/font-src|style-src [^;"]*https?:/);
  });
});
