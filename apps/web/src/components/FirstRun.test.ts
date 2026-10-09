/**
 * The network-service chooser's one-click options: the first is the solid
 * one, so it must be one that can work. After the built-in service turned
 * the page away, it isn't offered again in this visit.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILT_IN_REFUSED_TITLE } from "../lib/errors.js";
import { BuiltInServiceNotice, FirstRun } from "./FirstRun.js";

const BUILT_IN = "https://eth-mainnet.example/v2/key";
const PUBLIC = "https://public.example/rpc";

const render = (props: Partial<Parameters<typeof FirstRun>[0]> = {}) =>
  renderToStaticMarkup(createElement(FirstRun, { bundledUrl: BUILT_IN, fallbackUrl: PUBLIC, onChoose: () => undefined, ...props }));

/** The test ids of the buttons with the solid style, in order: `spdex-button` without `--ghost`. */
const solid = (html: string) =>
  [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*data-testid="([^"]+)"/g)]
    .filter(([, cls]) => /\bspdex-button\b/.test(cls!) && !/ghost/.test(cls!))
    .map(([, , id]) => id);

/** Where a test id first appears in the markup: the order a person reads the options in. */
const at = (html: string, testId: string) => html.indexOf(`data-testid="${testId}"`);

describe("FirstRun", () => {
  it("recommends a key of the person's own first, then the public service, then the built-in one, last and quiet", () => {
    const html = render();
    expect(html).toContain('data-testid="rpc-recommended"');
    expect(at(html, "first-run-own")).toBeGreaterThan(-1);
    expect(at(html, "first-run-own")).toBeLessThan(at(html, "rpc-fallback-row"));
    expect(at(html, "rpc-fallback-row")).toBeLessThan(at(html, "rpc-use-bundled"));
    // Use this is the one solid button; the public service is ghost, and the
    // built-in service a text link that doesn't compete.
    expect(solid(html)).toEqual(["rpc-save"]);
    expect(html).toMatch(/class="spdex-first-run__subtle"[^>]*data-testid="rpc-use-bundled"/);
    expect(html).not.toContain("rpc-bundled-refused-note");
  });

  it("says what the public service can't do", () => {
    const html = render();
    const row = html.slice(at(html, "rpc-fallback-row"), at(html, "rpc-use-bundled"));
    expect(row).toMatch(/Limited/);
    expect(row).toMatch(/swaps aren&#x27;t safety-checked/);
    expect(row).toMatch(/auto-buy won/);
  });

  it("after the built-in service refused, leaves it out and says why", () => {
    const html = render({ bundledRefused: true });
    expect(html).not.toContain('data-testid="rpc-use-bundled"');
    expect(html).toContain('data-testid="rpc-bundled-refused-note"');
    expect(html).toContain("turned this page away");
    expect(html).not.toContain("rpc-no-bundled-note");
    expect(solid(html)).toEqual(["rpc-save"]);
  });

  it("with no public service, leaves its row out", () => {
    const html = render({ bundledRefused: true, fallbackUrl: null });
    expect(html).not.toContain('data-testid="rpc-use-bundled"');
    expect(html).not.toContain('data-testid="rpc-fallback-row"');
    expect(solid(html)).toEqual(["rpc-save"]);
  });

  it("where there is no built-in service, leaves it out without a word", () => {
    const html = render({ bundledUrl: null });
    expect(html).not.toContain('data-testid="rpc-use-bundled"');
    expect(html).not.toContain("rpc-bundled-refused-note");
    expect(html).not.toMatch(/built-in service/);
  });
});

describe("FreeKeyGuide", () => {
  it("walks through Alchemy in the open, with Infura folded beside it", () => {
    const html = render();
    expect(html).toContain('data-testid="rpc-free-key-guide"');
    expect(html).toContain("https://eth-mainnet.g.alchemy.com/v2/");
    expect(html).toContain('data-testid="rpc-infura-guide"');
    expect(html).toContain("https://mainnet.infura.io/v3/");
    // Infura is folded: a newcomer sees one set of steps.
    expect(html).not.toMatch(/<details[^>]*data-testid="rpc-infura-guide"[^>]*\sopen/);
    // And it says plainly what hasn't been checked about it.
    expect(html).toMatch(/Its safety check and SPX proofs haven.{0,10}t been tested yet/);
    // Alchemy's own guide is a step away.
    expect(html).toContain('href="https://www.alchemy.com/docs/create-an-api-key"');
  });

  it("only links out: each link opens a new tab with no referrer, and nothing is loaded from those sites", () => {
    const html = render();
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]).filter((tag) => /alchemy|infura/.test(tag));
    expect(links).toHaveLength(3);
    for (const tag of links) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noreferrer noopener"');
    }
    expect(html).not.toMatch(/<(img|iframe|script|link)[^>]*(alchemy|infura)/);
  });
});

describe("BuiltInServiceNotice", () => {
  it("is titled as the line under Get price names it", () => {
    const html = renderToStaticMarkup(
      createElement(BuiltInServiceNotice, { answer: "eth_chainId: Monthly capacity limit exceeded.", fallbackUrl: PUBLIC, onChoose: () => undefined, onChooseAnother: () => undefined }),
    );
    expect(html.replace(/&#x27;/g, "'")).toContain(BUILT_IN_REFUSED_TITLE);
  });
});
