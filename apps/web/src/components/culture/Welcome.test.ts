import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import type { RecordRow } from "../../lib/records/types.js";
import { SAYINGS, sayingUrl } from "../../lib/culture/sayings.js";
import { checksumAddress } from "../../lib/culture/contract.js";
import { SayingLine } from "./SayingLine.js";
import {
  WELCOME_KEY,
  Welcome,
  createWelcomeStore,
  stepsDone,
  welcomeBackLabel,
  welcomeBalanceText,
  welcomeSteps,
  welcomeSummary,
  type WelcomeProps,
} from "./Welcome.js";

const ME = "0x00000000000000000000000000000000000a11ce" as Address;

class Store {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
}

function render(over: Partial<WelcomeProps> = {}): string {
  return renderToStaticMarkup(
    createElement(Welcome, {
      account: null,
      chainId: 1,
      ethBalance: null,
      walletAvailable: true,
      onConnect: () => {},
      onShowContract: () => {},
      onGoToAmount: () => {},
      onGoToRecurring: () => {},
      onOpenFeatures: () => {},
      firstBuy: null,
      onMakeCard: () => {},
      store: createWelcomeStore(new Store()),
      ...over,
    }),
  );
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");

describe("welcomeSteps", () => {
  it("ticks a step from the page's state, never from a click", () => {
    expect(welcomeSteps(null, null)).toEqual(["current", "later", "later"]);
    expect(welcomeSteps(ME, null)).toEqual(["done", "current", "later"]);
    expect(welcomeSteps(ME, "unreadable")).toEqual(["done", "current", "later"]);
    expect(welcomeSteps(ME, 0n)).toEqual(["done", "current", "later"]);
    expect(welcomeSteps(ME, 1n)).toEqual(["done", "done", "current"]);
    // ETH in a wallet nobody connected is nothing the page can see.
    expect(welcomeSteps(null, 10n ** 18n)).toEqual(["current", "later", "later"]);
  });

  it("has no step the page can't tick: the contract check is the buy step's first line", () => {
    const html = render({ account: ME, ethBalance: 1n });
    expect(html.match(/data-testid="welcome-step-\d"/g)).toEqual([
      'data-testid="welcome-step-1"',
      'data-testid="welcome-step-2"',
      'data-testid="welcome-step-3"',
    ]);
    const buy = html.slice(html.indexOf('data-testid="welcome-step-3"'));
    expect(textOf(buy)).toContain("Make a first buy");
    expect(buy.indexOf('data-testid="welcome-show-contract"')).toBeGreaterThan(-1);
    expect(buy.indexOf('data-testid="welcome-show-contract"')).toBeLessThan(buy.indexOf('data-testid="welcome-to-amount"'));
  });
});

describe("the balance line", () => {
  it("has three answers, and an unread balance is never \"no ETH\"", () => {
    expect(welcomeBalanceText(12n * 10n ** 16n, 1)).toBe("Your wallet holds 0.12 ETH on Ethereum.");
    expect(welcomeBalanceText(0n, 1)).toBe("No ETH in this wallet yet.");
    expect(welcomeBalanceText("unreadable", 1)).toBe("spDEX couldn't read this wallet's ETH balance.");
    expect(welcomeBalanceText(null, 1)).toBe("Reading this wallet's ETH balance…");
    expect(welcomeBalanceText(10n, 690069)).toBe("Your wallet holds less than 0.000001 ETH on Local fork.");
  });
});

describe("Welcome", () => {
  it("is short, Ethereum-first, and never calls anything official", () => {
    const text = textOf(render());
    expect(text).toContain("Welcome, new aeon");
    // No lede: the header says how far along the three steps are.
    expect(text).not.toContain("Three steps");
    expect(text).toContain("Withdraw ETH to your wallet on Ethereum — not Base, Arbitrum, BNB or Solana.");
    expect(text).toContain("Check the address first: same name, other address = not SPX.");
    // The masthead, the disclaimer and the footer say it's a community project; nothing here says "official".
    expect(text).not.toMatch(/official/i);
    expect(text).not.toMatch(/\b(invest|returns|profit)\b/i);
    expect(text).not.toMatch(/\btrad(e|es|ed|ing)\b/i);
  });

  it("keeps what a step needs to say one tap away", () => {
    const html = render();
    expect(textOf(html)).toContain("QR-code and passkey wallets can't connect yet.");
    expect(textOf(html)).toContain("Keep a little extra for fees. spDEX vouches for no exchange.");
    expect(html).toMatch(/class="spdex-term"[^>]*>Which wallets\?/);
  });

  it("offers Connect only where there is a wallet, and never under the header's test id", () => {
    expect(render()).toContain('data-testid="welcome-connect"');
    const none = render({ walletAvailable: false });
    expect(none).not.toContain("welcome-connect");
    expect(none).toContain("No wallet found in this browser.");
    expect(render()).not.toContain('data-testid="connect-button"');
  });

  it("shows the connected address checksummed, with the whole address to copy, once", () => {
    const html = render({ account: ME, ethBalance: 0n });
    expect(html.match(/data-testid="welcome-connected"/g)).toHaveLength(1);
    expect(html.match(/data-testid="welcome-balance"/g)).toHaveLength(1);
    expect(html).toContain(`title="${checksumAddress(ME)}"`);
  });

  it("links one neutral place to buy ETH and names no company", () => {
    const html = render();
    expect(html).toContain('href="https://ethereum.org/get-eth/"');
    expect(textOf(html)).not.toMatch(/Coinbase|Binance|Kraken|MoonPay|Revolut|Ramp/);
  });

  it("points at the trade card's chips and contract line rather than repeating them", () => {
    const html = render({ account: ME, ethBalance: 1n });
    expect(html).not.toMatch(/-preset-\d+/);
    expect(html).not.toContain("spx-contract-address");
    expect(html).toContain('data-testid="welcome-to-amount"');
    expect(html).toContain('data-testid="welcome-show-contract"');
    expect(textOf(html)).toContain("Nothing is sent until you press Swap.");
  });

  it("gives someone with no wallet a neutral place to find one, and a next step", () => {
    const html = render({ walletAvailable: false });
    expect(html).toContain('href="https://ethereum.org/wallets/find-wallet/"');
    expect(textOf(html)).toContain("Find a wallet ↗ , then reload this page.");
    expect(textOf(html)).not.toMatch(/MetaMask|Rabby|Coinbase|Rainbow|Phantom/);
  });

  it("vouches for no exchange, once", () => {
    expect(textOf(render()).match(/vouches for no exchange/g)).toHaveLength(1);
  });

  it("shows only on Ethereum and the local fork, and not once hidden", () => {
    expect(render({ chainId: 8453 })).toBe("");
    const store = createWelcomeStore(new Store());
    store.set(true);
    expect(render({ store })).toBe("");
  });

  it("after a first buy, offers a card and a way to hide", () => {
    const firstBuy: RecordRow = {
      id: "r1",
      kind: "swap",
      chainId: 1,
      account: ME,
      at: { unix: 1_789_683_000, source: "block" },
      block: 1n,
      hashes: [`0x${"12".repeat(32)}` as Hex],
      sold: { token: NATIVE_TOKEN, amount: 1n, measured: true },
      bought: { token: TOKENS.SPX.address, amount: 5n, measured: true },
      buyFee: 0n,
      networkFee: 1n,
      valueUsd: null,
      rates: null,
      valueSource: null,
    };
    const html = render({ firstBuy });
    expect(textOf(html)).toContain("Your first SPX is in.");
    expect(html).toContain('data-testid="make-card"');
    expect(html).toContain('data-testid="welcome-hide"');
    const unmeasured = render({ firstBuy: { ...firstBuy, bought: { ...firstBuy.bought, measured: false } } });
    expect(unmeasured).not.toContain("make-card");
    // The tile header says what's next.
    expect(welcomeSummary(welcomeSteps(ME, 1n), firstBuy)).toEqual({ text: "make a card" });
    expect(welcomeSummary(welcomeSteps(ME, 1n), { ...firstBuy, bought: { ...firstBuy.bought, measured: false } })).toEqual({
      text: "first SPX in",
    });
  });
});

describe("Welcome in a tile", () => {
  it("drops its panel and title, keeps its test id, and reports how many steps are done", () => {
    const told: { text: string }[] = [];
    const html = render({ open: true, onSummary: (s) => told.push(s) });
    expect(html).toContain('data-testid="welcome-panel"');
    expect(html).not.toContain("spdex-panel");
    expect(textOf(html)).not.toContain("Welcome, new aeon");
    // Effects don't run in a static render; the summary itself is a pure function.
    expect(welcomeSummary(welcomeSteps(ME, 1n), null)).toEqual({ text: "2 of 3 done" });
    expect(welcomeSummary(welcomeSteps(null, null), null)).toEqual({ text: "0 of 3 done" });
    expect(told).toEqual([]);
  });

  it("names the steps for the back chip, with how far along they are", () => {
    expect(stepsDone(welcomeSteps(ME, 0n))).toBe(1);
    expect(welcomeBackLabel(ME, 1n)).toBe("steps (2 of 3)");
    expect(welcomeBackLabel(null, null)).toBe("steps (0 of 3)");
  });
});

describe("the welcome store", () => {
  it("remembers a hide as \"hidden\", brings it back, and tells its subscribers", () => {
    const storage = new Store();
    const store = createWelcomeStore(storage);
    let told = 0;
    store.subscribe(() => told++);
    expect(store.get()).toBe(false);
    store.set(true);
    expect(storage.map.get(WELCOME_KEY)).toBe("hidden");
    expect(createWelcomeStore(storage).get()).toBe(true);
    store.set(true);
    store.set(false);
    expect(store.get()).toBe(false);
    expect(createWelcomeStore(storage).get()).toBe(false);
    expect(told).toBe(2);
  });

  it("shows Welcome when storage is blocked, and keeps a hide for the visit", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const store = createWelcomeStore(blocked);
    expect(store.get()).toBe(false);
    store.set(true);
    expect(store.get()).toBe(true);
    expect(createWelcomeStore(null).get()).toBe(false);
  });
});

describe("saying lines", () => {
  it("quote the community's sayings exactly, in its capitals, attribute them, and link each to its own page", () => {
    expect(SAYINGS).toEqual({ "no-chart": "THERE IS NO CHART", believe: "STOP TRADING AND BELIEVE IN SOMETHING", persist: "PERSIST FOREVER" });
    const pages = { "no-chart": 1, believe: 2, persist: 10 } as const;
    for (const id of ["no-chart", "believe", "persist"] as const) {
      const html = renderToStaticMarkup(createElement(SayingLine, { id }));
      expect(html).toContain(`data-testid="saying-${id}"`);
      expect(html).toContain(`<q class="spdex-saying__text">${SAYINGS[id]}</q>`);
      expect(html).toContain(`href="${sayingUrl(id)}"`);
      expect(sayingUrl(id)).toBe(`https://www.spx6900.com/commandment/${pages[id]}`);
      expect(textOf(html)).toContain("— the SPX6900 community ↗");
      // A saying, never a "commandment": the word stays in spx6900.com's address only.
      expect(textOf(html)).not.toMatch(/commandment/i);
    }
  });

  it("answers the chart question beside the no-chart saying, and a lead can replace its own", () => {
    const chart = textOf(renderToStaticMarkup(createElement(SayingLine, { id: "no-chart" })));
    expect(chart.trim().startsWith("No price chart here.")).toBe(true);
    const led = textOf(renderToStaticMarkup(createElement(SayingLine, { id: "believe", lead: "As the community puts it:" })));
    expect(led.trim().startsWith("As the community puts it:")).toBe(true);
  });
});
