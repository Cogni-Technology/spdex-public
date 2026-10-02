/**
 * The status widget as the page first draws it: what each row says, the
 * service's address masked, and the safety line the status strip used to
 * carry (same words, same test id). Nothing here reads the chain.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recommendedConfig } from "@spdex/config";
import type { SpdexConfig } from "@spdex/core";
import type { SecondOpinionStatus } from "../../lib/simulation.js";
import { checkText, StatusWidget, type SecondOpinionSource, type StatusWidgetProps } from "./StatusWidget.js";

const KEYED = "https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef";

function config(url: string | null): SpdexConfig {
  const base = recommendedConfig();
  return { ...base, chainId: 1, rpc: { url, source: "user" } };
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
const byTestId = (html: string, id: string) => text(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</(?:dd|span|p|button)>`).exec(html)?.[1] ?? "");

function render(overrides: Partial<StatusWidgetProps> = {}): string {
  const props: StatusWidgetProps = {
    config: config(KEYED),
    rpc: async () => "0x1",
    secondOpinion: null,
    account: null,
    onConnect: () => undefined,
    safety: "available",
    plans: { text: null, buyDue: false, onOpen: () => undefined },
    live: "",
    announce: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(StatusWidget, props));
}

describe("the status widget", () => {
  it("says SERVICE and the state in words, so colour is never the only signal", () => {
    const html = render();
    expect(html).toContain('data-testid="status-widget"');
    expect(text(html)).toContain("Service");
    // Before the first read: reading, not online and not a block of 0.
    expect(byTestId(html, "status-block")).toBe("…");
    expect(html).toContain('data-state="reading"');
    const none = render({ rpc: null, config: config(null) });
    expect(none).toContain('data-state="none"');
    expect(text(none)).toContain("No service");
  });

  it("keeps the strip's test ids and their words", () => {
    const html = render({ account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
    expect(byTestId(html, "chain-name")).toBe("Ethereum");
    expect(byTestId(html, "chain-label")).toBe("1");
    expect(byTestId(html, "account-label")).toBe("0x7099…79C8");
    expect(byTestId(html, "preset-label")).toBe("recommended");
    expect(html).toContain('data-testid="strip-details"');
    expect(html).not.toContain('data-testid="status-connect"');
    expect(byTestId(render(), "account-label")).toBe("not connected");
    expect(render()).toContain('data-testid="status-connect"');
  });

  it("masks the service's address, with SHOW", () => {
    const html = render();
    // Scheme and host only: the key in the path is gone.
    expect(byTestId(html, "rpc-label")).toBe("https://eth-mainnet.g.alchemy.com");
    expect(html).not.toContain("abcdef0123456789");
    expect(html).toContain('data-testid="rpc-show"');
    // Nothing to hide, nothing to show.
    expect(render({ config: config("http://127.0.0.1:8545") })).not.toContain('data-testid="rpc-show"');
  });

  it("says when the service is this copy's built-in one, beside its address", () => {
    const builtIn = render({ config: { ...config(KEYED), rpc: { url: KEYED, source: "bundled" } } });
    expect(byTestId(builtIn, "rpc-label")).toBe("https://eth-mainnet.g.alchemy.com");
    expect(byTestId(builtIn, "rpc-builtin")).toBe(" · built-in");
    expect(render()).not.toContain('data-testid="rpc-builtin"');
    // Not before there is one.
    expect(render({ rpc: null, config: { ...config(null), rpc: { url: null, source: "bundled" } } })).not.toContain('data-testid="rpc-builtin"');
  });

  it("shows PLANS only with plans, and BUY DUE when a buy is due", () => {
    expect(render()).not.toContain('data-testid="strip-dca"');
    expect(byTestId(render({ plans: { text: "2 running", buyDue: false, onOpen: () => undefined } }), "strip-dca")).toContain("2 running");
    expect(byTestId(render({ plans: { text: "2 running", buyDue: true, onOpen: () => undefined } }), "strip-dca")).toContain("Buy due");
  });

  it("has one polite live region", () => {
    const html = render({ live: "Network service offline" });
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(byTestId(html, "status-live")).toBe("Network service offline");
  });
});

describe("the safety line (the status strip's, kept)", () => {
  const source = (status: SecondOpinionStatus): SecondOpinionSource => ({
    secondOpinionStatus: () => status,
    subscribeSecondOpinion: () => () => undefined,
  });
  const line = (status: SecondOpinionStatus | null, safety: "available" | "unavailable" = "available") =>
    byTestId(render({ safety, secondOpinion: status === null ? null : source(status) }), "strip-safety");

  it("adds the second opinion to the safety test", () => {
    expect(line(null)).toBe("available");
    expect(line({ kind: "on", host: "x", last: null, sameOperator: null })).toBe("available · checks on 2 services");
    expect(line({ kind: "on", host: "x", last: "agrees", sameOperator: null })).toBe("available · checked on 2 services");
    expect(line({ kind: "on", host: "x", last: "unavailable", sameOperator: null })).toBe("available · second opinion not answering");
    expect(line({ kind: "same" })).toBe("available · second opinion is your main service, so it doesn't count");
    expect(line({ kind: "on", host: "x", last: "agrees", sameOperator: null }, "unavailable")).toBe("not available on this service");
  });

  it("says CHECK in a word", () => {
    expect(checkText("available", { kind: "off" })).toBe("on");
    expect(checkText("available", { kind: "on", host: "x", last: "agrees", sameOperator: null })).toBe("on ×2");
    expect(checkText("available", { kind: "on", host: "x", last: "unavailable", sameOperator: null })).toBe("on");
    expect(checkText("unavailable", { kind: "off" })).toBe("off");
    expect(checkText("unknown", { kind: "off" })).toBe("unknown");
  });
});
