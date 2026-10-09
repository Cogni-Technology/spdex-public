/**
 * Swapping native ether in a browser.
 *
 * spDEX could not do this at all until now: the token list was WETH, SPX and
 * USDC, and there was no wrap button, so anyone arriving with ether was stuck
 * before they started. There are no new pools behind this — v2 and v3 pools are
 * always ERC-20 pairs — only the router's wrapping entry points.
 *
 * The shared `account` fixture strips an EIP-7702 delegation before handing the
 * account over. anvil's published keys all carry one on real mainnet, inherited
 * by the fork, and it forwards any ether the account receives — which is fatal
 * specifically for the paths here. See `clearDelegation`.
 */

import { test, expect, fundSpxWithEth, installWallet, seedConfig, sentTransactions, setDelegation, openTile } from "./fixtures.js";

/** `approve(address,uint256)`: the call an allowance step would send. */
const APPROVE_SELECTOR = "0x095ea7b3";

test.describe("native ETH", () => {
  test("is offered in the token list and shows a real balance", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // ETH is first, because it is what someone arrives holding.
    await expect(page.getByTestId("token-in")).toContainText("ETH");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();

    // Read with eth_getBalance rather than balanceOf — ether has no contract.
    await expect(page.getByTestId("balance-in")).toContainText("ETH", { timeout: 30_000 });
    // anvil funds its accounts with 10,000 ETH.
    await expect(page.getByTestId("balance-in")).toContainText(/Balance [\d,]{4,}/);
  });

  test("keeps something back for gas on 'use all'", async ({ page, account }) => {
    // Selling every last wei leaves nothing to sign the swap with, and the
    // failure would arrive after the user had committed.
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("balance-in")).toContainText("ETH", { timeout: 30_000 });

    await page.getByTestId("use-max").click();
    const shown = await page.getByTestId("balance-in").innerText();
    const balance = Number.parseFloat(shown.replace(/[^\d.]/g, ""));
    const filled = Number.parseFloat(await page.getByTestId("amount-input").inputValue());
    expect(filled).toBeLessThan(balance);
    expect(filled).toBeGreaterThan(balance - 1);
  });

  test("quotes and swaps ETH for SPX, verified, with no approval step", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.5");
    await page.getByTestId("quote-button").click();

    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
    // Simulated, not merely statically checked: the Guard sees native movement
    // because eth_simulateV1 reports it as a Transfer from 0xeeee…eeee.
    await expect(page.getByTestId("guard-level")).toHaveText("verified");
    // One transaction per market the route uses, and nothing else.
    const legs = await page.getByTestId("route-legs").locator(':scope > [data-testid^="route-leg-"]').count();
    expect(legs).toBeGreaterThan(0);
    const before = (await sentTransactions(page)).length;

    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 90_000 });

    // Nobody needs an allowance to spend their own ether: what the wallet was
    // asked to send is the swap itself, ether attached, and no approval.
    const sent = (await sentTransactions(page)).slice(before);
    expect(sent).toHaveLength(legs);
    expect(sent.every((tx) => BigInt(tx.value ?? "0x0") > 0n)).toBe(true);
    expect(sent.some((tx) => (tx.data ?? "").toLowerCase().startsWith(APPROVE_SELECTOR))).toBe(false);
    await expect(page.getByTestId("balance-out")).toContainText("SPX");
  });

  test("swaps SPX back to ETH", async ({ page, account }) => {
    // SPX is arranged over RPC rather than by swapping through the UI first.
    // That second UI swap was a real mainnet-fork transaction whose only
    // purpose was setting up this one, and it doubled the chance of the
    // upstream archive endpoint rate-limiting mid-test.
    await installWallet(page, { address: account });
    await fundSpxWithEth(10n ** 18n, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("SPX");
    await page.getByTestId("token-out").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("balance-in")).toContainText("SPX", { timeout: 30_000 });

    await page.getByTestId("amount-input").fill("100");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
    // The Guard sees ether arrive because eth_simulateV1 reports the router's
    // internal unwrap-and-forward as a Transfer from 0xeeee…eeee.
    await expect(page.getByTestId("guard-level")).toHaveText("verified");

    await page.getByTestId("swap-button").click();
    // This one does approve first: selling a token needs an allowance even
    // when the proceeds come back as ether.
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 90_000 });
  });

  test("warns when the connected account would not keep ether paid to it", async ({ page }) => {
    /*
     * anvil's published keys all carry an EIP-7702 delegation on real mainnet,
     * installed by a sweeper, and a fork inherits it. The Guard already refuses
     * such a swap — it measures what the recipient keeps — but "the recipient
     * receives nothing" reads as a bug in spDEX rather than a fact about the
     * user's wallet, so the cause is named before they get that far.
     *
     * The delegation is installed here rather than borrowed from a real anvil
     * account: the `account` fixture strips them from every account it hands
     * out, so relying on one would make this pass or fail depending on which
     * other specs had run first.
     */
    const delegated = "0x5d3ec0de00000000000000000000000000000077";
    await setDelegation(delegated, "0x8a67b5020ee254ef48e3b6a04927f39baf7e408a");
    await installWallet(page, { address: delegated });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("delegation-warning")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("delegation-warning")).toContainText("EIP-7702");
  });

  test("refuses ETH for WETH, which is a wrap rather than a swap", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("token-out").selectOption("WETH");
    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();

    // Named plainly: "no pools available" would send someone hunting for a
    // liquidity problem that does not exist.
    await expect(page.getByTestId("error-banner")).toContainText("does not wrap");
  });
});
