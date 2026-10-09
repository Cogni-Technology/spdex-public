/**
 * The amount field as the page first draws it: one row, one unit menu, the
 * balance on the label row, and one line under the box that is either the
 * one-tap amounts or the hint. What was stacked beside the label before
 * (the ETH | $ switch, "Other…", the currency menu and the missing-currency
 * note) must not come back.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TOKENS } from "@spdex/chain";
import { NATIVE_ETH } from "../../lib/tokens.js";
import type { AmountInput, Pricing } from "../../lib/money/pricing.js";
import { AmountField, RATE_SOURCES_TIP } from "./AmountField.js";
import { MISSING_CURRENCIES_HINT } from "../../lib/money/currency.js";

function pricing(patch: Partial<Pricing> = {}): Pricing {
  return {
    snapshot: {
      usd: new Map([
        [TOKENS.WETH.address, 2_451_310_000n],
        [NATIVE_ETH.address, 2_451_310_000n],
      ]),
      // Read just now, by the clock the field reads.
      usdReadAt: performance.now(),
      fx: null,
      fxReadAt: null,
    },
    state: "ready",
    currency: "USD",
    locale: "en-US",
    lastHiddenAt: null,
    request: () => undefined,
    reread: async () => null,
    ...patch,
  };
}

const empty: AmountInput = { text: "", unit: { currency: "USD" }, frozen: null };

const render = (props: Partial<Parameters<typeof AmountField>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AmountField, {
      value: empty,
      onChange: () => undefined,
      token: NATIVE_ETH,
      pricing: pricing(),
      testIdPrefix: "amount",
      inputTestId: "amount-input",
      ...props,
    }),
  );

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

describe("AmountField", () => {
  it("has one unit menu in the box, and none of the old controls beside the label", () => {
    const html = render();
    expect(html.match(/data-testid="amount-unit"/g)).toHaveLength(1);
    expect(html).toMatch(/<select[^>]*data-testid="amount-unit"[^>]*aria-label="Amount unit"|<select[^>]*aria-label="Amount unit"[^>]*data-testid="amount-unit"/);
    for (const gone of ["amount-unit-USD", "amount-unit-token", "amount-other-currency", "amount-currency-select"]) {
      expect(html).not.toContain(`data-testid="${gone}"`);
    }
    expect(text(html)).not.toContain(MISSING_CURRENCIES_HINT);
    // The menu's groups: the field's own units, then the rest, then the ones with no rate.
    expect(html).toContain('<optgroup label="Change currency">');
    expect(html).toContain('label="No rate: INR HKD SEK NOK PLN ZAR" disabled=""');
    // The chosen unit by code alone: the sign is already in the box, before the number.
    expect(html).toMatch(/<option value="USD" title="US dollars" selected="">USD<\/option>/);
    // The sign leads the number where the locale writes it first; the placeholder names the unit briefly.
    expect(html).toMatch(/spdex-amount__affix--lead[^>]*>\$<\/span>/);
    expect(html).toContain('placeholder="Amount in USD"');
  });

  it("offers the token alone, as a fixed unit, without a price to convert with", () => {
    const html = render({ pricing: null, value: { text: "", unit: "token", frozen: null } });
    expect(html).toMatch(/<span[^>]*data-testid="amount-unit"[^>]*>ETH<\/span>/);
    expect(html).not.toContain("<select");
  });

  it("puts the balance on the label row, and nothing there without one", () => {
    const balance = createElement("span", { "data-testid": "balance-in" }, "Balance 1.2 ETH");
    const html = render({ balance });
    expect(html).toMatch(/spdex-amount__head.*Amount.*spdex-amount__balance.*balance-in.*spdex-amount__box/s);
    expect(render({ balance: null })).not.toContain("spdex-amount__balance");
  });

  it("shows the one-tap amounts while empty, and the hint instead once something is typed", () => {
    const chips = createElement("div", { "data-testid": "amount-presets" });
    expect(render({ chips })).toContain('data-testid="amount-presets"');
    const typed = render({ chips, value: { text: "1", unit: "token", frozen: null } });
    expect(typed).not.toContain('data-testid="amount-presets"');
    // A token amount's worth, with where it comes from.
    expect(typed).toContain('data-testid="amount-conversion"');
    expect(typed).toContain('data-testid="amount-sources"');
  });

  it("explains the missing currencies where the rates are explained", () => {
    expect(RATE_SOURCES_TIP).toContain(MISSING_CURRENCIES_HINT);
    expect(MISSING_CURRENCIES_HINT).toBe(
      "INR, HKD, SEK, NOK, PLN and ZAR aren't offered: no rate for them on Ethereum can be read without asking a third party.",
    );
  });

  it("moves nothing into focus by itself", () => {
    expect(render()).not.toMatch(/autofocus/i);
  });

  it("says the network service is why no dollar price could be read, with Try again rather than Switch to ETH", () => {
    const typed: AmountInput = { text: "0.01", unit: { currency: "USD" }, frozen: null };
    const busy = render({ value: typed, pricing: pricing({ snapshot: null, state: "unavailable", failure: "busy" }) });
    expect(text(busy)).toContain("The network service is busy, so spDEX can't read a dollar price right now.");
    expect(busy).toContain('data-testid="amount-retry-price"');
    expect(text(busy)).toContain("Try again");
    expect(busy).not.toContain('data-testid="amount-switch-token"');
    expect(text(busy)).not.toContain("Type ETH instead");

    // Turned away: no button that can't help; the sentence names the place.
    const refused = render({ value: typed, pricing: pricing({ snapshot: null, state: "unavailable", failure: "refused" }) });
    expect(text(refused)).toContain("Choose another service in Settings → Network service.");
    expect(refused).not.toContain('data-testid="amount-retry-price"');
    expect(refused).not.toContain('data-testid="amount-switch-token"');

    // A price that couldn't be read with the service answering: as before.
    const noPrice = render({ value: typed, pricing: pricing({ snapshot: null, state: "unavailable" }) });
    expect(text(noPrice)).toContain("spDEX couldn't read a current dollar price. Type ETH instead.");
    expect(noPrice).toContain('data-testid="amount-switch-token"');
    expect(noPrice).not.toContain('data-testid="amount-retry-price"');
  });
});
