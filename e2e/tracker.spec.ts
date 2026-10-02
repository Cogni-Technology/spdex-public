/**
 * Pool statistics, against real balances on the fork.
 *
 * The claim is that a sandboxed module with `chain:read` on three token
 * contracts can report what every pool actually holds — without the pool's own
 * address ever being allowlisted, because `balanceOf` targets the token and
 * merely names the pool.
 *
 * Asserted as relationships rather than figures. The fork is long-lived and
 * the suite trades against it, so pinning a dollar amount would be asserting a
 * price; what must hold is that v2 dominates this pair, that the shares sum to
 * a whole, and that nothing unreadable is reported as empty.
 */

import { test, expect, installWallet, seedConfig, openTile } from "./fixtures.js";

const V2_PAIR = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";

test.describe("pool statistics", () => {
  test("are on by default and list every pool for the pair", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // No quote, no wallet, no amount typed. "Where is the liquidity" is a
    // question people ask instead of quoting, not after it.
    await openTile(page, "markets");
    await expect(page.getByTestId("pool-stats-list")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`pool-stat-${V2_PAIR}`)).toBeVisible();
    await expect(page.getByTestId("pool-stats-total")).not.toContainText("unknown");
    // Told apart by venue, not only by the pair every row shares; the address
    // short in Simple, whole on hover.
    await expect(page.getByTestId(`pool-venue-${V2_PAIR}`)).toHaveText(" · Uniswap v2");
    const id = page.getByTestId(`pool-id-${V2_PAIR}`);
    await expect(id).toHaveText(`${V2_PAIR.slice(0, 6)}…${V2_PAIR.slice(-4)}`);
    await expect(id).toHaveAttribute("title", V2_PAIR);
    // Tapped, it copies the whole address, and says so.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId(`pool-id-${V2_PAIR}-copy`).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(V2_PAIR);
    await expect(page.getByTestId(`pool-stat-${V2_PAIR}`).locator(".spdex-copyhex [role=status]")).toHaveText("Copied.");
  });

  test("report the v2 pair as holding most of the pair's liquidity", async ({ page, account }) => {
    // The repo's own routing rationale rests on this being true, so the number
    // that justifies it is now on screen rather than in a comment.
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await openTile(page, "markets");
    await expect(page.getByTestId(`pool-share-${V2_PAIR}`)).toBeVisible({ timeout: 60_000 });
    const share = await page.getByTestId(`pool-share-${V2_PAIR}`).innerText();
    expect(Number.parseFloat(share)).toBeGreaterThan(50);

    // And a real fee tier, not the opaque depth proxy it replaced.
    await expect(page.getByTestId(`pool-fee-${V2_PAIR}`)).toHaveText(/^\d+\.\d{2}%$/);
  });

  test("price TVL in dollars rather than in a venue-local proxy", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await openTile(page, "markets");
    await expect(page.getByTestId(`pool-tvl-${V2_PAIR}`)).toBeVisible({ timeout: 60_000 });
    // $12.26M, $192.6K, $1.6K — a magnitude, not nine significant figures.
    await expect(page.getByTestId(`pool-tvl-${V2_PAIR}`)).toHaveText(/^\$[\d.]+[KMB]?$/);
  });

  test("say so when volume cannot be read, rather than showing zero", async ({ page, account }) => {
    /*
     * The endpoint here caps eth_getLogs hard, so this is the realistic path.
     * Either a window was accepted — in which case the column says which — or
     * it was not, in which case there is one short line explaining it. A bare
     * "0" would be indistinguishable from "nobody traded", which is a reason
     * to avoid a pool.
     */
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "markets");
    await expect(page.getByTestId("pool-stats-list")).toBeVisible({ timeout: 60_000 });

    const noted = await page.getByTestId("volume-note").count();
    if (noted > 0) {
      const text = await page.getByTestId("volume-note").innerText();
      // Short and actionable, not a wrapped provider stack trace.
      expect(text.length).toBeLessThan(400);
      // A fixed opening, never a service's own words made to start the sentence.
      expect(text).toContain("spDEX couldn't read volume: ");
      expect(text).toContain("Value held and fees still show");
    } else {
      // Volume was served: the column must say what period it covers.
      await expect(page.getByTestId("pool-stats-list")).toContainText(/Volume ·/);
    }
  });

  test("disappear when the tracker is switched off", async ({ page, account }) => {
    // The feature is the module. Turning it off must actually unload it, not
    // merely hide a panel that is still doing the work.
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "markets");
    await expect(page.getByTestId("pool-stats-list")).toBeVisible({ timeout: 60_000 });

    await openTile(page, "settings");
    await page.getByTestId("open-features").click();
    await page.getByTestId("feature-toggle-pool-stats").uncheck();
    await page.getByTestId("close-features").click();

    await openTile(page, "markets");
    await expect(page.getByTestId("pool-stats-empty")).toBeVisible();
    await expect(page.getByTestId("pool-stats-list")).toHaveCount(0);
  });

  test("replace the opaque depth figure in the expert picker", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "markets");
    await expect(page.getByTestId("pool-stats-list")).toBeVisible({ timeout: 60_000 });

    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await expect(page.getByTestId("expert-pools")).toBeVisible();

    // `depth` was a venue-defined proxy, comparable only within a venue — so a
    // v2 pair and a v3 pool showed two numbers that could not be ranked
    // against each other and looked as though they could.
    await expect(page.getByTestId(`picker-tvl-${V2_PAIR}`)).toContainText("$");
    await expect(page.getByTestId("expert-pools")).not.toContainText("depth ");
  });
});
