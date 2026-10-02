/**
 * Screenshots for reviewing the theme by eye, in both colour modes.
 *
 * Not part of `pnpm verify`. Only playwright.theme.config.ts has a project
 * whose testMatch selects this file, and verify never runs that config. A
 * colour scheme is not a thing to assert in a test; pinning hex values would
 * fail on every deliberate change and prove nothing about whether the result
 * looks right. This spec exists to *produce* the images a human looks at. The
 * stylesheet's checkable promises (PASTEL swaps only the accents, every text
 * colour clears AA in both modes) are unit tests: packages/ui/src/theme.test.ts.
 *
 *   pnpm shots        # needs a fork running: pnpm anvil:fork
 *
 * Every screen is shot twice: NEON as `NN-name.png` and PASTEL as
 * `NN-name-pastel.png`. Pastel is chosen the way a returning visitor's browser
 * has it, with `spx-theme` already in localStorage when the page loads, so the
 * shots also show that the saved mode is applied before anything renders.
 *
 * The images land in playwright-report/theme/, and any local run with the
 * HTML reporter (`pnpm test:e2e`, `pnpm verify`) deletes that folder. Copy
 * them somewhere else before running anything else.
 */

import type { Page } from "@playwright/test";
import { test, expect, FORK_URL, forkRpc, fundWeth, installWallet, seedConfig, watchRpc, openSection, openTile } from "./fixtures.js";
import { encodeClose, encodeCreateVault, vaultBudget, vaultsCreatedBy, type VaultPlan } from "../packages/vault/src/index.js";
import { ETHER, FACTORY, closeLeftoverVaults, fillVaultForm, freshAccount, history, keyWallet, planCard, sendAs } from "./vaults.js";

const ONE_WETH = 10n ** 18n;
const SHOTS = "playwright-report/theme";
const THEME_KEY = "spx-theme";

/**
 * Park the pointer in the corner. After a click it rests on whatever the
 * layout has since moved under it, and a review shot would show that in its
 * hover colour as if it were the design.
 */
async function restPointer(page: Page) {
  await page.mouse.move(0, 0);
}

const MODES = [
  { mode: "neon", suffix: "" },
  { mode: "pastel", suffix: "-pastel" },
] as const;

// The vault shots leave no funded vault on the shared fork, even when one
// stops half way (e2e/vaults.ts).
test.afterEach(async () => {
  await closeLeftoverVaults();
});

for (const { mode, suffix } of MODES) {
  const shot = (name: string) => `${SHOTS}/${name}${suffix}.png`;

  test.describe(`theme: ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      if (mode === "pastel") {
        await page.addInitScript((key) => localStorage.setItem(key, "pastel"), THEME_KEY);
      }
    });

    /** Fails the shot rather than photographing the wrong mode. */
    async function expectMode(page: Page) {
      const root = page.locator("html");
      if (mode === "pastel") await expect(root).toHaveAttribute("data-theme", "pastel");
      else await expect(root).not.toHaveAttribute("data-theme");
    }

    test("first run", async ({ page, account }) => {
      await installWallet(page, { address: account });
      await page.goto("/");
      await openTile(page, "trade");
      await expect(page.getByTestId("first-run")).toBeVisible();
      await expectMode(page);
      await page.screenshot({ path: shot("01-first-run"), fullPage: true });
    });

    test("recommended mode with a route", async ({ page, account }) => {
      await installWallet(page, { address: account });
      await fundWeth(ONE_WETH, account);
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");

      await page.getByTestId("connect-button").click();
      await expect(page.getByTestId("balance-in")).toContainText("WETH", { timeout: 30_000 });
      await expectMode(page);
      await page.screenshot({ path: shot("02-connected"), fullPage: true });

      await page.getByTestId("amount-input").fill("0.25");
      await page.getByTestId("quote-button").click();
      await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: shot("03-route"), fullPage: true });

      // Inspect transaction sits under Advanced, closed in Simple.
      await page.getByTestId("swap-advanced-summary").click();
      await page.getByTestId("toggle-raw-plan").click();
      await expect(page.getByTestId("raw-plan")).toBeVisible();
      await page.screenshot({ path: shot("04-raw-plan"), fullPage: true });
    });

    test("features modal", async ({ page, account }) => {
      // Taller than the default so a review screenshot shows the whole dialog.
      // The dialog itself scrolls inside its backdrop at any height; that is
      // covered by the features spec, which clicks a control below the fold.
      await page.setViewportSize({ width: 1280, height: 1600 });
      await installWallet(page, { address: account });
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");

      await openTile(page, "settings");
      await page.getByTestId("open-features").click();
      await expect(page.getByTestId("features-modal")).toBeVisible();
      await expectMode(page);
      await page.screenshot({ path: shot("07-features"), fullPage: true });
    });

    test("the Tip row: choosing who, then a route with a tip", async ({ page, account }) => {
      await installWallet(page, { address: account });
      await fundWeth(ONE_WETH, account);
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");

      // A share with nobody chosen opens the picker in place.
      await page.getByTestId("tip-chips-25").click();
      await expect(page.getByTestId("tip-placeholder-notice")).toBeVisible();
      await expectMode(page);
      await restPointer(page);
      await page.getByTestId("swap-panel").screenshot({ path: shot("08-tip-picker") });

      await page.getByTestId("tip-add-0x70997970c51812dc3a010c7d01b50e0d17dc79c8").click();
      await page.getByTestId("connect-button").click();
      await page.getByTestId("amount-input").fill("0.25");
      await page.getByTestId("quote-button").click();
      await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("tip-preview")).toBeVisible();
      await restPointer(page);
      await page.screenshot({ path: shot("09-route-with-tip"), fullPage: true });

      // Exact shares, in Expert.
      await openTile(page, "settings");
      await page.getByTestId("mode-toggle-expert").click();
      await openSection(page, "settings-tips");
      await expect(page.getByTestId("tip-recipients")).toBeVisible();
      await restPointer(page);
      await page.getByTestId("expert-tips").screenshot({ path: shot("09b-expert-tips") });
    });

    test("pool statistics", async ({ page, account }) => {
      await installWallet(page, { address: account });
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");
      await openTile(page, "markets");
      await expect(page.getByTestId("pool-stats-list")).toBeVisible({ timeout: 60_000 });
      await expectMode(page);
      await page.screenshot({ path: shot("10-pool-stats"), fullPage: true });
    });

    test("expert mode", async ({ page, account }) => {
      await installWallet(page, { address: account });
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");

      await openTile(page, "settings");
      await page.getByTestId("mode-toggle-expert").click();
      await expect(page.getByTestId("expert-pools")).toBeVisible();
      await expectMode(page);
      await page.screenshot({ path: shot("05-expert"), fullPage: true });

      await openSection(page, "config-panel");
      await page.getByTestId("export-toml").click();
      await page.screenshot({ path: shot("06-config"), fullPage: true });
    });

    test("auto-buy confirming each buy: the form with its two choices, a running plan, a due buy", async ({ page, account }) => {
      // The form shows both ways a plan can run, "Confirm each buy myself"
      // (chosen, the default) and "Set and forget"; the plan made is the first.
      // A real buy, then a day on the page clock so the next one falls due:
      // the dca project's budget, not the default one. The clock is installed
      // at real now before the app loads and moved only while the app is idle
      // on the network, for the reasons dca.spec.ts gives.
      test.setTimeout(240_000);
      await page.clock.install();
      await installWallet(page, { address: account });
      await seedConfig(page);
      const network = watchRpc(page);
      await page.goto("/");
      await openTile(page, "trade");

      await page.getByTestId("connect-button").click();
      await page.getByTestId("buy-mode-recurring").click();
      await page.getByTestId("dca-form-amount").fill("0.001");
      await page.getByTestId("dca-form-count").fill("3");
      const start = page.getByTestId("dca-form-start");
      await expect(start).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByTestId("dca-form-fees")).toContainText("up to", { timeout: 30_000 });
      await expectMode(page);
      await restPointer(page);
      await page.screenshot({ path: shot("13-recurring-form"), fullPage: true });

      await start.click();
      const card = page.locator('[data-testid^="dca-plan-"]');
      await openTile(page, "auto-buys");
      await card.getByTestId("dca-history-summary").click();
      await expect(card.locator('[data-kind="bought"]')).toHaveCount(1, { timeout: 120_000 });
      await network.quiet();
      await restPointer(page);
      await page.screenshot({ path: shot("14-auto-buy-running"), fullPage: true });

      await page.clock.fastForward("24:00:00");
      await expect(card.getByTestId("dca-due")).toBeVisible({ timeout: 60_000 });
      await network.quiet();
      await page.screenshot({ path: shot("15-auto-buy-due"), fullPage: true });
    });

    test("auto-buy vault: the choice, a buy due, triggered, and closed", async ({ page, context }) => {
      // Real transactions from a fresh key — create and fund, a buy, a close —
      // so the vault spec's budget rather than the default one. See
      // e2e/vault.spec.ts for what each step proves; here they only set the
      // scene.
      test.setTimeout(240_000);
      const owner = await freshAccount(ETHER, { owner: true });
      await keyWallet(context, owner);
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");

      const { start } = await fillVaultForm(page, "0.01", 3);
      await expect(page.getByTestId("dca-form-fees")).toContainText("in buy fees");
      await expectMode(page);
      await restPointer(page);
      await page.screenshot({ path: shot("16-vault-form"), fullPage: true });

      await start.click();
      const card = planCard(page);
      await openTile(page, "auto-buys");
      await expect(card.getByTestId("dca-vault-trigger")).toBeEnabled({ timeout: 120_000 });
      await restPointer(page);
      await card.screenshot({ path: shot("17-vault-due") });

      await card.getByTestId("dca-vault-trigger").click();
      await expect(card.getByTestId("dca-progress")).toContainText("1 of 3 buys", { timeout: 120_000 });
      await card.getByTestId("dca-history-summary").click();
      await expect(history(card, "bought")).toHaveCount(1, { timeout: 60_000 });
      await restPointer(page);
      await card.screenshot({ path: shot("18-vault-bought") });

      // The card at its narrowest, where the address and its copy button
      // have the least room.
      await page.setViewportSize({ width: 390, height: 844 });
      await restPointer(page);
      await card.screenshot({ path: shot("19-phone-vault") });
      await page.setViewportSize({ width: 1280, height: 720 });

      await card.getByTestId("dca-vault-close").click();
      await expect(card.getByTestId("dca-vault-close-ask")).toBeVisible();
      await restPointer(page);
      await card.screenshot({ path: shot("20-vault-close-ask") });
      await card.getByTestId("dca-vault-close-confirm").click();
      await expect(card.getByTestId("dca-pill")).toHaveText("Closed", { timeout: 120_000 });
      await restPointer(page);
      await card.screenshot({ path: shot("21-vault-closed") });
    });

    test("vaults on chain not in your plans", async ({ page, context }) => {
      // Three vaults of one fresh owner that no plan points at: one whose card
      // is deleted on the page, one made elsewhere and found by the search,
      // and one closed and empty, collapsed. See e2e/vault.spec.ts for what
      // each proves.
      test.setTimeout(240_000);
      const owner = await freshAccount(ETHER, { owner: true });
      await keyWallet(context, owner);
      const latest = (await forkRpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
      const made = async (plan: VaultPlan, fund: boolean) => {
        const receipt = await sendAs(owner, { to: FACTORY, data: encodeCreateVault(plan), value: fund ? vaultBudget(plan) : 0n });
        return vaultsCreatedBy(FACTORY, receipt.logs)[0]!.vault;
      };
      const plan = (maxBuys: bigint): VaultPlan => ({
        marketIndex: 0n,
        amountPerBuy: ETHER / 100n,
        interval: 86_400n,
        maxBuys,
        startAt: BigInt(latest.timestamp),
        keeperReward: (ETHER * 69n) / 1_000_000n,
        maxSlippageBps: 200n,
      });
      await made(plan(2n), true);
      const closed = await made(plan(1n), false);
      await sendAs(owner, { to: closed, data: encodeClose() });

      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");
      const { start } = await fillVaultForm(page, "0.01", 3);
      await start.click();
      const card = planCard(page);
      await openTile(page, "auto-buys");
      await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "running", { timeout: 120_000 });
      await card.getByTestId("dca-delete").click();
      await expect(card.getByTestId("dca-delete-confirm")).toHaveText("Delete anyway");
      await restPointer(page);
      await card.screenshot({ path: shot("21b-vault-delete-warning") });
      await card.getByTestId("dca-delete-confirm").click();
      await expect(planCard(page)).toHaveCount(0);

      const strays = page.getByTestId("dca-strays");
      await expect(strays.locator('[data-testid^="dca-stray-0x"]')).toHaveCount(2, { timeout: 60_000 });
      await expect(page.getByTestId("dca-strays-closed-summary")).toHaveText("Closed vaults (1)");
      await expectMode(page);
      await restPointer(page);
      await page.getByTestId("dca-panel").screenshot({ path: shot("22-vault-strays") });

      await page.getByTestId("dca-strays-closed-summary").click();
      await strays.locator('[data-testid^="dca-stray-0x"]').first().getByTestId("dca-vault-close").click();
      await restPointer(page);
      await page.getByTestId("dca-panel").screenshot({ path: shot("23-vault-strays-close-ask") });

      await page.setViewportSize({ width: 390, height: 844 });
      await restPointer(page);
      await page.getByTestId("dca-panel").screenshot({ path: shot("24-phone-vault-strays") });
      await page.setViewportSize({ width: 1280, height: 720 });

      // A fourth vault, and a network service that won't serve the factory's
      // logs: the search says how many of the factory's count the page can't
      // show — the fourth; the deleted card's vault is shown, and counts.
      await made(plan(1n), false);
      await page.route(
        (url) => url.href.startsWith(FORK_URL),
        async (route) => {
          const body = JSON.parse(route.request().postData() ?? "null") as { id?: unknown; method?: unknown } | null;
          if (body?.method !== "eth_getLogs") return route.fallback();
          return route.fulfill({
            status: 200,
            headers: { "access-control-allow-origin": "*" },
            contentType: "application/json",
            body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "query exceeds max block range" } }),
          });
        },
      );
      await page.getByTestId("dca-vault-close-cancel").click();
      await page.getByTestId("dca-strays-look").click();
      await expect(page.getByTestId("dca-strays-note")).toContainText("1 of your 4 vaults isn't shown here", { timeout: 60_000 });
      await restPointer(page);
      await page.getByTestId("dca-strays").screenshot({ path: shot("25-vault-strays-note") });

      // One added back: a vault plan's card again, the rest still listed apart.
      await strays.locator('[data-testid^="dca-stray-0x"]').first().getByTestId("dca-stray-add").click();
      await expect(planCard(page)).toHaveCount(1);
      await expect(planCard(page).getByTestId("dca-vault-close")).toBeVisible({ timeout: 60_000 });
      await restPointer(page);
      await page.getByTestId("dca-panel").screenshot({ path: shot("26-vault-added-back") });
    });

    test("phone width", async ({ page, account }) => {
      // Where the MODE chip leaves the corner and joins the flow, and where
      // the masthead, the stats table and the diff have the least room.
      await page.setViewportSize({ width: 390, height: 844 });
      await installWallet(page, { address: account });
      await seedConfig(page);
      await page.goto("/");
      await openTile(page, "trade");
      await openTile(page, "markets");
      await expect(page.getByTestId("pool-stats-list")).toBeVisible({ timeout: 60_000 });
      await expectMode(page);
      await page.screenshot({ path: shot("12-phone"), fullPage: true });

      // The Tip row at its narrowest: the chips take the width, the people
      // wrap under them.
      await openTile(page, "trade");
      await page.getByTestId("tip-chips-25").click();
      await page.getByTestId("tip-add-0x70997970c51812dc3a010c7d01b50e0d17dc79c8").click();
      await expect(page.getByTestId("tip-recipient-pill-0x70997970c51812dc3a010c7d01b50e0d17dc79c8")).toBeVisible();
      await restPointer(page);
      await page.getByTestId("swap-panel").screenshot({ path: shot("12b-phone-tip-row") });
    });
  });
}

test.describe("theme: the display dock", () => {
  test("switches, remembers, and stays out of the column", async ({ page, account }) => {
    // 1440px is the narrowest viewport at which the dock is pinned open in
    // the corner (theme.css, Page layout), so the tightest fit there is.
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const dock = page.getByTestId("display-dock");
    const root = page.locator("html");
    await expect(dock).toBeVisible();
    await expect(page.getByTestId("display-open")).toBeHidden();
    await expect(root).not.toHaveAttribute("data-theme");
    await expect(page.getByTestId("theme-toggle-neon")).toHaveAttribute("aria-pressed", "true");

    // Pinned, and wholly inside the gutter: its right edge plus its 4px shadow
    // stops short of the tiles.
    const dockBox = (await dock.boundingBox())!;
    const tilesBox = (await page.getByTestId("tiles").boundingBox())!;
    expect(dockBox.x + dockBox.width + 4).toBeLessThan(tilesBox.x);
    await dock.screenshot({ path: `${SHOTS}/11-display-dock.png` });
    await page.screenshot({ path: `${SHOTS}/11-display-dock-corner.png` });

    await page.getByTestId("theme-toggle-pastel").click();
    await expect(root).toHaveAttribute("data-theme", "pastel");
    await expect(page.getByTestId("theme-toggle-pastel")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("pastel");
    // The switching class lives for one frame only.
    await expect(root).not.toHaveClass(/theme-switching/);
    await dock.screenshot({ path: `${SHOTS}/11-display-dock-pastel.png` });
    await page.screenshot({ path: `${SHOTS}/11-display-dock-corner-pastel.png` });

    // Neon removes the attribute rather than writing "neon" into it.
    await page.getByTestId("theme-toggle-neon").click();
    await expect(root).not.toHaveAttribute("data-theme");
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("neon");

    // Below the breakpoint, including the e2e suite's 1280px, it is in the
    // flow, shown by Aa DISPLAY, and cannot sit over anything.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(dock).toBeHidden();
    await page.getByTestId("display-open").click();
    await expect(dock).toBeVisible();
    expect(await dock.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    await page.getByTestId("status-widget").screenshot({ path: `${SHOTS}/11-status-widget.png` });
  });
});
