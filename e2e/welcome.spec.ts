/**
 * "Welcome, new aeon": the four steps a newcomer sees above the Trade card.
 *
 * Every other spec starts with Welcome hidden, as it starts with the Features
 * dialog seen; these opt in with `showWelcome: true`. The claims are that
 * Welcome is the one thing a newcomer is shown (the Features dialog waits
 * while it is up), that a step's tick comes from the page's own state rather
 * than a click, that its last two steps point at the Trade card's own
 * contract line and dollar chips rather than repeating them, that a chip only
 * fills in the One-time swap, and that hiding it is remembered in this
 * browser.
 */

import { checksumAddress } from "../packages/vault/src/index.js";
import { test, expect, installWallet, seedConfig, sentTransactions, SPX, openSection, openTile } from "./fixtures.js";

test.describe("welcome", () => {
  test("is open on load while it shows, and Buy SPX is open in its place once it is hidden", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    // A newcomer's page starts with the four steps open, not a column of headers.
    await expect(page.getByTestId("tile-start")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    await expect(page.locator('[data-tile][data-open="true"]')).toHaveCount(1);
    // Hidden: Buy SPX takes its place, open, and focus is on its header.
    await page.getByTestId("welcome-hide").click();
    await expect(page.getByTestId("tile-start")).toHaveCount(0);
    await expect(page.getByTestId("tile-trade")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("tile-trade")).toBeFocused();
    // And on the next visit too.
    await page.reload();
    await expect(page.getByTestId("tile-trade")).toHaveAttribute("aria-expanded", "true");
  });

  test("shows instead of the Features dialog, and says it's a community project", async ({ page, account }) => {
    await installWallet(page, { address: account });
    // The Features dialog is unseen too: it would open by itself on this
    // visit, and must not while Welcome is showing.
    await seedConfig(page, {}, { showWelcome: true, showFeatures: true });
    await page.goto("/");
    await openTile(page, "trade");

    const welcome = page.getByTestId("welcome-panel");
    await openTile(page, "start");
    await expect(welcome).toBeVisible();
    await expect(page.getByTestId("tile-start")).toContainText("Welcome, new aeon");
    await expect(page.getByTestId("footer")).toContainText("Community project.");
    await expect(page.getByTestId("features-modal")).toHaveCount(0);

    // Step 3 points at the Trade card's contract line and opens it. The
    // contract is the one the listings name, checksummed and in full: the
    // groups of four are spaced by the stylesheet, so the text is the address
    // exactly, as a selection or Copy takes it.
    await openTile(page, "start");
    await page.getByTestId("welcome-show-contract").click();
    await openTile(page, "trade");
    await expect(page.getByTestId("spx-contract-line")).toHaveAttribute("open", "");
    await expect(page.getByTestId("spx-contract-address")).toBeVisible();
    await expect(page.getByTestId("spx-contract-address")).toHaveText(checksumAddress(SPX));

    // Welcome carries the way to Features instead.
    await openTile(page, "start");
    await page.getByTestId("welcome-features").click();
    await expect(page.getByTestId("features-modal")).toBeVisible();
  });

  test("ticks a step from the page's state: connecting finishes step 1 and reads the ETH for step 2", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await openTile(page, "trade");

    await openTile(page, "start");
    await expect(page.getByTestId("welcome-step-1")).toHaveAttribute("data-state", "current");
    await page.getByTestId("welcome-connect").click();
    await expect(page.getByTestId("welcome-step-1")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("welcome-connected")).toContainText(`${checksumAddress(account).slice(0, 6)}…`);
    // anvil's accounts hold ether, so step 2 is done too, and says how much from the chain.
    await expect(page.getByTestId("welcome-balance")).toContainText("Your wallet holds", { timeout: 30_000 });
    await expect(page.getByTestId("welcome-step-2")).toHaveAttribute("data-state", "done");
  });

  test("Pick an amount leads to the card's chips, and the $69 chip fills the One-time ETH → SPX amount in dollars, sending nothing", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await openTile(page, "trade");

    // Welcome has no chips of its own: the page never offers the same ones twice.
    await openTile(page, "start");
    await expect(page.getByTestId("welcome-presets")).toHaveCount(0);
    // The suite's seeded pair is WETH → SPX; Pick an amount moves it to ETH → SPX.
    await openTile(page, "trade");
    await expect(page.getByTestId("token-in")).toHaveValue("WETH");
    await openTile(page, "start");
    await page.getByTestId("welcome-to-amount").click();
    await openTile(page, "trade");
    await expect(page.getByTestId("token-in")).toHaveValue("ETH");
    await expect(page.getByTestId("token-out")).toHaveValue("SPX");
    await page.getByTestId("amount-preset-6900").click();
    await expect(page.getByTestId("amount-unit")).toHaveValue("USD");
    await expect(page.getByTestId("amount-input")).toHaveValue("69");
    await expect(page.getByTestId("amount-conversion")).toContainText(/^= [\d.]+ ETH/, { timeout: 60_000 });
    await expect(page.getByTestId("route-view")).toHaveCount(0);
    expect(await sentTransactions(page)).toEqual([]);
  });

  test("Hide this is remembered across a reload, and Getting started brings it back", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await openTile(page, "trade");

    await openTile(page, "start");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    await page.getByTestId("welcome-hide").click();
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);

    await page.reload();
    await openTile(page, "trade");
    await expect(page.getByTestId("swap-panel")).toBeVisible();
    await openTile(page, "start");
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);

    await openTile(page, "settings");
    await openSection(page, "settings-start");
    await page.getByTestId("strip-getting-started").click();
    // It opens the steps' tile itself.
    await expect(page.getByTestId("tile-start")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
  });
});
