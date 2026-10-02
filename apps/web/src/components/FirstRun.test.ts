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

/** The test ids of the buttons with the solid style, in order. */
const solid = (html: string) =>
  [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*data-testid="([^"]+)"/g)]
    .filter(([, cls]) => !/ghost/.test(cls!))
    .map(([, , id]) => id);

describe("FirstRun", () => {
  it("leads with the built-in service where it works", () => {
    const html = render();
    expect(html).toContain('data-testid="rpc-use-bundled"');
    expect(solid(html)[0]).toBe("rpc-use-bundled");
    expect(html).not.toContain("rpc-bundled-refused-note");
  });

  it("after the built-in service refused, leaves it out and says why; the public service leads", () => {
    const html = render({ bundledRefused: true });
    expect(html).not.toContain('data-testid="rpc-use-bundled"');
    expect(html).toContain('data-testid="rpc-bundled-refused-note"');
    expect(html).toContain("turned this page away");
    expect(html).not.toContain("rpc-no-bundled-note");
    expect(solid(html)[0]).toBe("rpc-use-fallback");
  });

  it("with no public service either, makes \"Use this\" the solid option", () => {
    const html = render({ bundledRefused: true, fallbackUrl: null });
    expect(html).not.toContain('data-testid="rpc-use-bundled"');
    expect(solid(html)).toEqual(["rpc-save"]);
  });

  it("where there is no built-in service, says so as before", () => {
    const html = render({ bundledUrl: null });
    expect(html).toContain('data-testid="rpc-no-bundled-note"');
    expect(html).not.toContain("rpc-bundled-refused-note");
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
