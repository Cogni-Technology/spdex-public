/**
 * Amounts typed in money, the currency menu and number styles.
 *
 * The claim is that money is only how an amount is typed. What is quoted,
 * saved and signed is the token amount the field shows under it, sized once
 * from one price and never again behind the person's back. So the specs here
 * read that token amount off the page and hold the quote and the saved plan
 * to it exactly, to the wei, rather than to a price: the fork is long-lived
 * and traded against, and a dollar figure pinned here would be asserting one.
 *
 * Typing is the part that moves money. "0,5" is half an ether where the
 * decimal mark is a comma, and a mark that doesn't fit the person's number
 * style is refused with a one-tap fix, never read as something else. The
 * de-DE specs run a browser whose language says so, as a phone keypad in
 * Germany would type.
 *
 * Nothing here sends a transaction: quotes are previews or verified quotes
 * that are never signed, and the one plan saved starts tomorrow.
 */

import type { Page } from "@playwright/test";
import { FX_FEEDS, FX_MAX_AGE_SECONDS } from "../packages/chain/src/index.js";
import { test, expect, forkRpc, installWallet, seedConfig, sentTransactions, openTile, openSection } from "./fixtures.js";

const CONFIG_KEY = "spdex.config.v1";

/**
 * A figure the page wrote in en-US ("0.0081589") as base units, exactly.
 * Refuses anything with grouping: an amount this small never has any, and
 * a figure that did would be one this spec misread.
 */
function toBaseUnits(text: string, decimals = 18): bigint {
  expect(text, `a plain decimal: ${text}`).toMatch(/^\d+(\.\d+)?$/);
  const [whole, fraction = ""] = text.split(".");
  expect(fraction.length).toBeLessThanOrEqual(decimals);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** The token amount a money amount came to, from the field's hint line: "= 0.0081589 ETH · avg 14:02 · …". */
async function sizedTo(page: Page, prefix: string, symbol: string): Promise<string> {
  const conversion = page.getByTestId(`${prefix}-conversion`);
  await openTile(page, "trade");
  await expect(conversion).toContainText(new RegExp(`^= [\\d.]+ ${symbol} · avg `), { timeout: 60_000 });
  const match = /^= ([\d.]+) /.exec(await conversion.innerText());
  return match![1]!;
}

/**
 * The fork's EUR rate is still fresh by the chain's own clock.
 *
 * The fork's clock runs with the wall clock from the moment anvil started,
 * and a Chainlink answer counts as unknown once it is `FX_MAX_AGE_SECONDS`
 * old. A fork left up for about four days therefore shows every currency but
 * dollars as unavailable, which is the app being right. Said here as what it
 * is, rather than as a euro sign that never appeared.
 */
async function expectEuroRateFresh(): Promise<void> {
  const head = (await forkRpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  const raw = (await forkRpc("eth_call", [{ to: FX_FEEDS.EUR.address, data: "0xfeaf968c" }, "latest"])) as string;
  // latestRoundData(): (roundId, answer, startedAt, updatedAt, answeredInRound)
  const updatedAt = Number(BigInt(`0x${raw.slice(2 + 64 * 3, 2 + 64 * 4)}`));
  const age = Number(BigInt(head.timestamp)) - updatedAt;
  expect(
    age,
    `the fork's EUR answer is ${Math.round(age / 3600)} hours old by its own clock, past the ${FX_MAX_AGE_SECONDS / 3600} hours ` +
      "spDEX accepts, so every currency but dollars reads as unavailable: restart pnpm anvil:fork",
  ).toBeLessThanOrEqual(FX_MAX_AGE_SECONDS);
}

/**
 * How many text nodes on the page say "≈" and then `symbol`. The two are
 * joined by a no-break space, so a narrow line never strands the "≈".
 */
async function approxFigures(page: Page, symbol: string): Promise<number> {
  return page.evaluate((sign) => {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").replace(/\s/g, " ").includes(`≈ ${sign}`)) count += 1;
    }
    return count;
  }, symbol);
}

test.describe("money", () => {
  test("a fresh browser starts the amount in dollars, and the token stays one tap away", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { moneyUnits: null });
    await page.goto("/");
    await openTile(page, "trade");

    // A newcomer thinks in money: with no unit remembered, the field is in the
    // chosen currency, which a browser in en-US starts at dollars.
    await openTile(page, "settings");
    await expect(page.getByTestId("currency-select")).toHaveValue("USD");
    await openTile(page, "trade");
    await expect(page.getByTestId("amount-unit")).toHaveValue("USD");
    await expect(page.getByTestId("amount-input")).toHaveAttribute("placeholder", "Amount in USD");
  });

  test("$20 in One-time: the quote pays exactly the ETH the field showed, and You pay names the $20.00 typed", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("amount-unit").selectOption("USD");
    await page.getByTestId("amount-input").fill("20");
    const shown = await sizedTo(page, "amount", "ETH");
    // Sized to six significant digits, so the amount signed is one a person can read back.
    expect(shown.replace(/^0\.0*/, "").replace(".", "").length).toBeLessThanOrEqual(6);

    await page.getByTestId("quote-button").click();
    const youPay = page.getByTestId("you-pay");
    await expect(youPay).toBeVisible({ timeout: 60_000 });
    // Token first, and the money named as what was typed, never echoed back
    // through the same price as though that confirmed anything.
    await expect(youPay).toContainText(`${shown} ETH: the $20.00 you typed, at the price from `);
    const paid = /^([\d.]+) ETH/.exec(await youPay.innerText());
    expect(toBaseUnits(paid![1]!)).toBe(toBaseUnits(shown));
  });

  test("$20 in Recurring: the saved plan's amount per buy is exactly the ETH the field showed", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    // Expert, for "First buy: at a time I choose": the plan is saved and its
    // first buy is tomorrow, so nothing is sent.
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openTile(page, "trade");
    await page.getByTestId("buy-mode-recurring").click();
    await expect(page.getByTestId("dca-form-sell")).toHaveValue("ETH");
    await page.getByTestId("dca-form-amount-unit").selectOption("USD");
    await page.getByTestId("dca-form-amount").fill("20");
    const shown = await sizedTo(page, "dca-form-amount", "ETH");
    await page.getByTestId("dca-form-count").fill("3");
    await page.getByTestId("dca-form-first-buy").selectOption("later");
    const tomorrow = new Date(Date.now() + 86_400_000);
    const local = (n: number) => String(n).padStart(2, "0");
    await page
      .getByTestId("dca-form-start-at")
      .fill(`${tomorrow.getFullYear()}-${local(tomorrow.getMonth() + 1)}-${local(tomorrow.getDate())}T12:00`);

    // The summary leads with the token amount and says the money was only
    // how it was typed; the note under it says what "fixed" means.
    await expect(page.getByTestId("dca-form-summary")).toContainText(`Buy SPX with ${shown} ETH ($20.00 at the price from `);
    await expect(page.getByTestId("dca-form-fiat-fixed")).toContainText(`Saved as ${shown} ETH a buy: $20.00 at today's price.`);

    const start = page.getByTestId("dca-form-start");
    await expect(start).toBeEnabled({ timeout: 30_000 });
    await start.click();
    await expect(page.getByTestId("dca-form-started")).toBeVisible({ timeout: 30_000 });

    // Read from what the page stored, not from what it says.
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), CONFIG_KEY);
    const plans = (JSON.parse(stored!) as { dca: { plans: { amountPerBuy: string; sell: string }[] } }).dca.plans;
    expect(plans).toHaveLength(1);
    expect(BigInt(plans[0]!.amountPerBuy)).toBe(toBaseUnits(shown));
    expect(await sentTransactions(page)).toEqual([]);
  });

  test("choosing EUR turns every ≈ figure on the page from dollars to euros", async ({ page, account }) => {
    await expectEuroRateFresh();
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // Figures that need a price: a token amount's worth under the field, and
    // You pay's once a quote is on screen.
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("amount-input").fill("1");
    await expect(page.getByTestId("amount-conversion")).toContainText("≈ $", { timeout: 60_000 });
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("you-pay")).toContainText("≈ $", { timeout: 60_000 });
    const inDollars = await approxFigures(page, "$");
    expect(inDollars).toBeGreaterThanOrEqual(2);

    // The unit menu's "Change currency" group sets the page's currency and
    // puts the field in it. The 1 typed in ETH is never read as 1 euro: the
    // field is cleared, and focus stays on the menu.
    await page.getByTestId("amount-unit").focus();
    await page.getByTestId("amount-unit").selectOption("EUR");
    await expect(page.getByTestId("amount-unit")).toHaveValue("EUR");
    await expect(page.getByTestId("amount-unit")).toBeFocused();
    await expect(page.getByTestId("amount-input")).toHaveValue("");
    await openTile(page, "settings");
    await openSection(page, "settings-money");
    await expect(page.getByTestId("currency-select")).toHaveValue("EUR");
    await openTile(page, "trade");
    // The same 1 ETH, priced again: every figure is now in euros.
    await page.getByTestId("amount-unit").selectOption("token");
    await page.getByTestId("amount-input").fill("1");
    await expect(page.getByTestId("amount-conversion")).toContainText("≈ €", { timeout: 60_000 });
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("you-pay")).toContainText("≈ €", { timeout: 60_000 });
    expect(await approxFigures(page, "$")).toBe(0);
    expect(await approxFigures(page, "€")).toBe(inDollars);
    // The rate was there, so nothing fell back to dollars with a note.
    await expect(page.getByTestId("money-fx-note")).toHaveCount(0);
  });
});

test.describe("money, typed in a de-DE browser", () => {
  test.use({ locale: "de-DE" });

  test("0,5 in ETH quotes half an ether", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("amount-input").fill("0,5");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("you-pay")).toContainText(/^0,5 ETH/, { timeout: 60_000 });
    await expect(page.getByTestId("amount-problem")).toHaveCount(0);
  });

  test("1.5 is refused, and Use 1,5 types the fix", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    const field = page.getByTestId("amount-input");
    await field.fill("1.5");
    await field.press("Enter");
    const problem = page.getByTestId("amount-problem");
    await expect(problem).toContainText('In your number format the decimal mark is ",".');
    // Nothing was quoted from a number spDEX would have had to guess at.
    await expect(page.getByTestId("route-view")).toHaveCount(0);

    await expect(page.getByTestId("amount-choice-0")).toHaveText("Use 1,5");
    await expect(page.getByTestId("amount-number-style")).toBeVisible();
    await page.getByTestId("amount-choice-0").click();
    await expect(field).toHaveValue("1,5");
    await expect(problem).toHaveCount(0);

    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("you-pay")).toContainText(/^1,5 ETH/, { timeout: 60_000 });
  });

  test("1.500 is refused with a choice of 1500 or 1,5, and never read as either", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    const field = page.getByTestId("amount-input");
    await field.fill("1.500");
    await field.press("Enter");
    await expect(page.getByTestId("amount-problem")).toContainText("Is that 1500 or 1,5?");
    await expect(page.getByTestId("amount-choice-0")).toHaveText("1500");
    await expect(page.getByTestId("amount-choice-1")).toHaveText("1,5");
    await expect(page.getByTestId("route-view")).toHaveCount(0);

    await page.getByTestId("amount-choice-1").click();
    await expect(field).toHaveValue("1,5");
    await expect(page.getByTestId("amount-problem")).toHaveCount(0);
  });
});
