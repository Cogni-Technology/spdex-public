/**
 * Expert mode: the claim that a user really can pin a route to one pool, and
 * that the configuration is a file they own.
 *
 * The pinning test is the important one. "Full control over which pools" is
 * easy to put on a landing page and hard to actually mean — so here the route
 * is checked to use the pinned pool *and nothing else*, after a real quote
 * against real liquidity.
 */

import { test, expect, fundWeth, installWallet, seedConfig, FORK_URL, openSection, openTile } from "./fixtures.js";

const ONE_WETH = 10n ** 18n;

async function quote(page: import("@playwright/test").Page, amount = "1") {
  await openTile(page, "trade");
  await page.getByTestId("amount-input").fill(amount);
  await page.getByTestId("quote-button").click();
  await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
}

test.describe("expert mode", () => {
  test("exposes the same config recommended mode writes into", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();

    await expect(page.getByTestId("expert-pools")).toBeVisible();
    await expect(page.getByTestId("expert-router")).toBeVisible();
    await expect(page.getByTestId("config-panel")).toBeVisible();

    // Untouched, it is exactly the shipped preset — there is no hidden
    // difference between what a beginner runs and what an expert edits.
    await openSection(page, "config-panel");
    await expect(page.getByTestId("config-diff-none")).toBeVisible();
  });

  test("pins a route to a single pool", async ({ page, account }) => {
    // Get price refuses more than the connected wallet holds, so it holds what is quoted.
    await fundWeth(ONE_WETH, account);
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // Quote first so the pool picker is populated with real discovered pools.
    await page.getByTestId("connect-button").click();
    await quote(page, "1");

    const legsBefore = await page.getByTestId("route-legs").locator("> div").count();
    expect(legsBefore).toBeGreaterThan(0);

    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "expert-pools");
    await expect(page.getByTestId("pool-list")).toBeVisible();

    // Pin whichever pool the router actually used, so the assertion does not
    // depend on which tiers hold liquidity at the pinned block.
    await openTile(page, "trade");
    const pinnedPool = await page
      .getByTestId("route-legs")
      .locator("> div")
      .first()
      .getAttribute("data-testid");
    const poolId = pinnedPool!.replace("route-leg-", "");

    await openTile(page, "settings");
    await page.getByTestId(`pin-pool-${poolId}`).click();
    await expect(page.getByTestId("preset-label")).toContainText("customised");

    await quote(page, "1");

    // One leg, and it is the pinned pool. The router cannot reach outside the
    // candidate set the policy hands it.
    await expect(page.getByTestId("leg-count")).toHaveText("1");
    await expect(page.getByTestId(`route-leg-${poolId}`)).toBeVisible();
  });

  test("refuses to route when the policy excludes every pool", async ({ page, account }) => {
    // Allowlist mode with nothing allowed is a coherent thing to ask for, and
    // the honest answer is a refusal rather than quietly falling back to
    // routing through everything.
    await installWallet(page, { address: account });
    await seedConfig(page, {
      preset: "custom",
      pools: { mode: "allowlist", allow: [], deny: [] },
    });
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();

    await expect(page.getByTestId("error-banner")).toContainText("pool policy", {
      timeout: 60_000,
    });
  });

  test("exports a config, and re-imports it unchanged", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();

    await openSection(page, "expert-router");
    await page.getByTestId("router-max-splits").fill("2");
    await openSection(page, "config-panel");
    await expect(page.getByTestId("diff-router.maxSplits")).toBeVisible();

    await page.getByTestId("export-toml").click();
    const exported = await page.getByTestId("config-text").inputValue();
    expect(exported).toContain("[router]");
    expect(exported).toContain("maxSplits = 2");

    // Round-trip: a file you own is only yours if it opens again.
    await page.getByTestId("reset-config").click();
    await expect(page.getByTestId("config-diff-none")).toBeVisible();

    await page.getByTestId("config-text").fill(exported);
    await page.getByTestId("import-config").click();
    await expect(page.getByTestId("diff-router.maxSplits")).toBeVisible();
    await expect(page.getByTestId("router-max-splits")).toHaveValue("2");
  });

  test("reports a bad import instead of silently ignoring it", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();

    await openSection(page, "config-panel");
    await page.getByTestId("config-text").fill("this is not a config");
    await page.getByTestId("import-config").click();

    await expect(page.getByTestId("config-error")).toBeVisible();
    await expect(page.getByTestId("config-diff-none")).toBeVisible();
  });

  test("stages a shared config for review rather than applying it", async ({ page, account }) => {
    // A link that reconfigured someone's DEX on click would be an attack. The
    // diff is shown, and nothing changes until the user says so.
    await installWallet(page, { address: account });
    const seeded = await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "config-panel");
    await page.getByTestId("export-link").click();
    const link = await page.getByTestId("config-text").inputValue();
    const fragment = link.slice(link.indexOf("#"));

    await openSection(page, "expert-router");
    await page.getByTestId("router-min-gain").fill("999");
    await page.goto(`/${fragment}`);
    await openTile(page, "trade");

    await expect(page.getByTestId("staged-config")).toBeVisible();
    await expect(page.getByTestId("dismiss-staged")).toBeVisible();

    await page.getByTestId("accept-staged").click();
    await expect(page.getByTestId("staged-config")).toBeHidden();
    await expect(page.getByTestId("rpc-label")).toContainText(seeded.rpc.url!);
  });

  test("submits privately when the wallet can sign without broadcasting", async ({ page, account }) => {
    // The relay is the fork itself. That tests the mechanism honestly — sign
    // locally, post the raw transaction to an endpoint that is not the wallet's
    // own broadcast path — without pretending to have tested Flashbots.
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page, {
      preset: "custom",
      submitter: { mode: "private", url: FORK_URL },
    });
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await quote(page, "0.1");
    await page.getByTestId("swap-button").click();

    await expect(page.getByTestId("swap-status")).toContainText("submitted privately", {
      timeout: 120_000,
    });
    await expect(page.getByTestId("fallback-prompt")).toBeHidden();
  });

  test("asks before broadcasting publicly when the wallet cannot sign", async ({ page, account }) => {
    // The case that matters. A wallet that refuses eth_signTransaction must not
    // result in a quiet public broadcast: the user chose privacy and would size
    // their trade accordingly.
    await installWallet(page, { address: account, refuseSignTransaction: true });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page, {
      preset: "custom",
      submitter: { mode: "private", url: FORK_URL },
    });
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await quote(page, "0.1");
    await page.getByTestId("swap-button").click();

    await expect(page.getByTestId("fallback-prompt")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("fallback-prompt")).toContainText("front-run");

    // Declining aborts rather than sending.
    await page.getByTestId("fallback-cancel").click();
    await expect(page.getByTestId("swap-status")).toContainText("cannot submit privately", {
      timeout: 60_000,
    });
  });

  test("broadcasts publicly only after explicit consent", async ({ page, account }) => {
    await installWallet(page, { address: account, refuseSignTransaction: true });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page, {
      preset: "custom",
      submitter: { mode: "private", url: FORK_URL },
    });
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await quote(page, "0.1");
    await page.getByTestId("swap-button").click();

    await expect(page.getByTestId("fallback-prompt")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("fallback-accept").click();

    // It completes, and the status does not claim privacy it did not deliver.
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", {
      timeout: 120_000,
    });
    await expect(page.getByTestId("swap-status")).not.toContainText("privately");
  });

  test("offers the submitter control in expert mode", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();

    await expect(page.getByTestId("expert-submitter")).toBeVisible();
    await openSection(page, "expert-submitter");
    await page.getByTestId("submitter-mode-private").click();

    // Choosing private mode fills in a relay rather than leaving it blank,
    // which would fail at swap time.
    await expect(page.getByTestId("submitter-url")).not.toHaveValue("");
    await openSection(page, "config-panel");
    await expect(page.getByTestId("diff-submitter.mode")).toBeVisible();
  });

  test("runs the venue in the sandbox when strict mode is on", async ({ page, account }) => {
    // The point of the flag: a user can verify for themselves that the native
    // fast path was never load-bearing, by making everything take the slow one.
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page, { preset: "custom", strictSandbox: true });
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();

    await expect(page.getByTestId("runtime-kind")).toContainText("quickjs");

    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    await quote(page, "1");

    // Same answer, same verdict — just executed inside the jail.
    await expect(page.getByTestId("guard-level")).toHaveText("verified");
  });
});
