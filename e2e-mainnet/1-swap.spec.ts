/**
 * A one-time swap, both ways, from the owner agent: ETH → SPX (no approval,
 * ether attached) and the same SPX back to ETH (an approval to the router
 * first, unless an earlier run left one). Checked three ways: what the page
 * says, what the wallet was asked to send, and what the chain shows.
 *
 * Small on purpose (`SPDEX_SMOKE_SWAP_ETH`, 0.001 ETH by default), sent
 * publicly as a newcomer's would be: too small to be worth a bot's time.
 */

import { expect, openTile, seedConfig, spxFigure, test } from "../e2e/fixtures.js";
import { ROUTERS, SPX, ethBalance, feeOf, minedReceipt, settings, tokenBalance } from "./chain.js";
import { eth } from "./settings.js";
import { MINED_WITHIN_MS, agents, pageWallet, settleMined } from "./wallet.js";

test.describe.configure({ mode: "serial" });
test.afterEach(async () => {
  await settleMined();
});

/** The page's own waits: a block, its receipt poll, and its reads after. */
const UI_WAIT = () => MINED_WITHIN_MS() + 60_000;

/** SPX base units as the amount field takes them: plain digits, no grouping. */
function spxInput(units: bigint): string {
  const fraction = (units % 10n ** 8n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${units / 10n ** 8n}${fraction ? `.${fraction}` : ""}`;
}

let bought = 0n;

test("buys SPX with ETH: checked, sent once, delivered, and recorded", async ({ page, context }) => {
  const { owner } = agents();
  const wallet = await pageWallet(context, owner, "swap: buy SPX with ETH");
  await seedConfig(page);
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await page.getByTestId("token-in").selectOption("ETH");
  await page.getByTestId("token-out").selectOption("SPX");
  await page.getByTestId("amount-input").fill(eth(settings.swapWei));
  await page.getByTestId("quote-button").click();
  await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 120_000 });

  const [eth0, spx0] = await Promise.all([ethBalance(owner.address), tokenBalance(SPX, owner.address)]);
  await page.getByTestId("swap-button").click();
  await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: UI_WAIT() });

  // One transaction: ether needs no approval, and tips are off.
  expect(wallet.hashes).toHaveLength(1);
  const receipt = await minedReceipt(wallet.hashes[0]!, MINED_WITHIN_MS());
  expect(ROUTERS).toContain(receipt.to?.toLowerCase());
  const [eth1, spx1] = await Promise.all([ethBalance(owner.address), tokenBalance(SPX, owner.address)]);
  bought = spx1 - spx0;
  expect(bought).toBeGreaterThan(0n);
  // The swap's ether and its network fee, and nothing else, left the wallet.
  expect(eth0 - eth1).toBe(settings.swapWei + feeOf(receipt));

  // What the page says it did is what the chain says.
  const after = page.getByTestId("after-swap");
  await expect(after.getByTestId("finality-badge")).toHaveAttribute("data-state", /included|final/, { timeout: 120_000 });
  await expect(after.getByTestId("after-swap-received")).toHaveText(`You received ${spxFigure(bought, 6)} SPX.`, { timeout: 60_000 });
  await openTile(page, "yours");
  const row = page.locator(`[data-testid="activity-row"][data-hash="${wallet.hashes[0]}"]`);
  await expect(row).toHaveAttribute("data-kind", "swap", { timeout: 60_000 });
  await expect(row).toContainText(`${eth(settings.swapWei)} ETH`);
});

test("sells that SPX back for ETH, approving the router first if it must", async ({ page, context }) => {
  test.skip(bought === 0n, "the buy before it didn't complete");
  const { owner } = agents();
  const wallet = await pageWallet(context, owner, "swap: sell SPX for ETH");
  await seedConfig(page);
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("token-in").selectOption("SPX");
  await page.getByTestId("token-out").selectOption("ETH");
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("balance-in")).toContainText("SPX", { timeout: 60_000 });
  await page.getByTestId("amount-input").fill(spxInput(bought));
  await page.getByTestId("quote-button").click();
  await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 120_000 });

  const [eth0, spx0] = await Promise.all([ethBalance(owner.address), tokenBalance(SPX, owner.address)]);
  await page.getByTestId("swap-button").click();
  await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 2 * UI_WAIT() });

  // An approval and the swap, or the swap alone where an earlier run's approval stands.
  expect(wallet.hashes.length).toBeGreaterThanOrEqual(1);
  expect(wallet.hashes.length).toBeLessThanOrEqual(2);
  const receipts = await Promise.all(wallet.hashes.map((hash) => minedReceipt(hash, MINED_WITHIN_MS())));
  expect(ROUTERS).toContain(receipts.at(-1)!.to?.toLowerCase());
  if (receipts.length === 2) expect(receipts[0]!.to?.toLowerCase()).toBe(SPX);
  const fees = receipts.reduce((sum, r) => sum + feeOf(r), 0n);

  const [eth1, spx1] = await Promise.all([ethBalance(owner.address), tokenBalance(SPX, owner.address)]);
  // Exactly the SPX bought went; ether came back for it, whatever the network fees took.
  expect(spx0 - spx1).toBe(bought);
  expect(eth1 - eth0 + fees).toBeGreaterThan(0n);
});
