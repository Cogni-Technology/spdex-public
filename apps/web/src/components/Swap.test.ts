/**
 * A failed Get price says so under the button, in the status line, and not
 * only in the banner at the top of the page: on a phone that banner is a
 * screen or more above the button (and the banner it adds pushes the button
 * down). The line is short and says where the rest is.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recommendedConfig } from "@spdex/config";
import { TOKENS } from "@spdex/chain";
import type { Pricing } from "../lib/money/pricing.js";
import { errorPlacement, friendlyError, quoteProblemLine } from "../lib/errors.js";
import { NATIVE_ETH, TOKEN_LIST } from "../lib/tokens.js";
import { OneTimeSwap } from "./Swap.js";

const SPX = TOKEN_LIST.find((token) => token.symbol === "SPX")!;

const pricing: Pricing = {
  snapshot: { usd: new Map([[TOKENS.WETH.address, 2_451_310_000n]]), usdReadAt: performance.now(), fx: null, fxReadAt: null },
  state: "ready",
  currency: "USD",
  locale: "en-US",
  lastHiddenAt: null,
  request: () => undefined,
  reread: async () => null,
};

const render = (props: Partial<Parameters<typeof OneTimeSwap>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(OneTimeSwap, {
      config: recommendedConfig(),
      mode: "recommended",
      tokenIn: NATIVE_ETH,
      tokenOut: SPX,
      amountInput: { text: "0.001", unit: "token", frozen: null },
      onAmountInput: () => undefined,
      pricing,
      quote: null,
      quoteId: 0,
      quoting: false,
      swapping: false,
      status: null,
      account: null,
      balanceIn: null,
      balanceOut: null,
      autoBuyHoldsWallet: false,
      tipCandidates: null,
      tipsToPay: { enabled: false, recipients: [] },
      tipPermit2: { available: null, allowance: null, batchable: false },
      onTokenIn: () => undefined,
      onTokenOut: () => undefined,
      onReverse: () => undefined,
      onQuote: () => undefined,
      onSwap: () => undefined,
      onConnect: () => undefined,
      onConfig: () => undefined,
      ...props,
    }),
  );

const line = quoteProblemLine(friendlyError("eth_call: HTTP 429", { builtIn: true }).title);

describe("a failed Get price", () => {
  it("is said under the button, in the status line a screen reader hears", () => {
    const html = render({ quoteProblem: line });
    const status = /<p[^>]*data-testid="swap-status"[^>]*>([^<]*)<\/p>/.exec(html);
    expect(status).not.toBeNull();
    expect(status![0]).toContain('aria-live="polite"');
    expect(status![0]).toContain('data-problem="quote"');
    expect(status![1]).toBe("Couldn&#x27;t get a price: the network service is busy. More at the top of the page.");
    // Under Get price, not above it.
    expect(html.indexOf('data-testid="swap-status"')).toBeGreaterThan(html.indexOf('data-testid="quote-button"'));
  });

  it("says an amount of 0 in full, beside the field it is about", () => {
    const zero = errorPlacement(friendlyError("Enter an amount greater than zero."), {
      refusedNoticeShown: false,
      fromQuote: true,
    }).quoteLine;
    const html = render({ quoteProblem: zero });
    const status = /<p[^>]*data-testid="swap-status"[^>]*>([^<]*)<\/p>/.exec(html);
    expect(status![1]).toBe("Couldn&#x27;t get a price: enter an amount above zero.");
    expect(status![1]).not.toContain("top of the page");
  });

  it("is not said when there is nothing wrong", () => {
    expect(render()).not.toContain('data-testid="swap-status"');
    expect(render({ quoteProblem: null })).not.toContain('data-testid="swap-status"');
  });

  it("gives way to a status of its own: the wallet's step, or a swap's result", () => {
    const html = render({ quoteProblem: line, status: "Cancelled in your wallet." });
    expect(html).toContain("Cancelled in your wallet.");
    expect(html).not.toContain("Couldn&#x27;t get a price");
  });
});
