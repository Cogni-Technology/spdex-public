/**
 * A hash or an address that copies itself (`CopyHex`), and a transaction
 * (`TxRef`), as first drawn: what is shown, what the tooltip and a screen
 * reader get, and where the test ids go. Copying itself is e2e's
 * (receipt.spec.ts), where there is a clipboard.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyHex, TxRef } from "./common.js";

const HASH = `0x${"ab".repeat(30)}cdef`;
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("CopyHex", () => {
  it("shows the value short, keeps it whole in the tooltip, and names what the button copies", () => {
    const html = renderToStaticMarkup(createElement(CopyHex, { value: ADDRESS, what: "wallet's address", testId: "who" }));
    expect(html).toContain(`<code class="spdex-copyhex__text" title="${ADDRESS}" data-testid="who">0x7099…79C8</code>`);
    expect(html).toMatch(/<button type="button" class="spdex-copyhex__button" data-testid="who-copy">/);
    // The button's name: the words a screen reader hears, then what is shown.
    const button = /<button[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "";
    expect(text(button)).toBe("Copy the wallet's address 0x7099…79C8");
    // Nothing said until something is copied; the mark is drawn, and hidden.
    expect(html).toContain('<span class="spdex-visually-hidden" role="status"></span>');
    expect(html).toMatch(/<svg class="spdex-copyhex__mark"[^>]*aria-hidden="true"/);
  });

  it("shows the whole value when asked to", () => {
    const html = renderToStaticMarkup(createElement(CopyHex, { value: ADDRESS, what: "market's address", full: true }));
    expect(html).toContain(`>${ADDRESS}</code>`);
    expect(html).toContain('class="spdex-copyhex spdex-copyhex--full"');
    expect(html).not.toContain("data-testid");
  });
});

describe("TxRef", () => {
  it("is the short hash that copies it, with Etherscan beside it on Ethereum", () => {
    const html = renderToStaticMarkup(createElement(TxRef, { chainId: 1, hash: HASH, testId: "tx" }));
    expect(html).toContain('data-testid="tx">0xabab…cdef</code>');
    expect(html).toContain(`href="https://etherscan.io/tx/${HASH}"`);
    expect(html).toContain("View ↗");
  });

  it("names no explorer for a network spDEX can't vouch for", () => {
    const html = renderToStaticMarkup(createElement(TxRef, { chainId: 690069, hash: HASH }));
    expect(html).toContain(">0xabab…cdef</code>");
    expect(html).not.toContain("<a ");
  });
});
