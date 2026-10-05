/**
 * Collective DCA and Trust and exits: the two panels at the bottom that read
 * or say things about spDEX as a whole rather than about one person.
 *
 * Collective DCA counts what every auto-buy vault has done, from the
 * factories' lists alone, v1's and v2's together. The claim is that its
 * "made" figure is the two factories' own counts at the block it read. Those
 * counts are read here too, before and after the panel opens, and the panel's
 * must lie between the two: vaults are only ever added, and another test or a
 * developer's tab on the shared fork can add one in between. The spec never
 * compares with a number written down, which would be a fact about this fork
 * on the day it was written. Its one v2 figure, the share of v2 buys paid to
 * community keepers inside their window, is held against the same sums read
 * vault by vault at the panel's own block.
 *
 * Trust and exits must not claim what a page can't know. On the dev server,
 * "Verify this build" can only say where the page came from, and no source
 * address is configured, so it says that instead of showing one.
 *
 * Both are folded to their titles until opened. Neither sends anything, and
 * Collective DCA reads nothing until it is opened.
 */

import { DEPLOYMENTS, checksumAddress, readVaultCount } from "../packages/vault/src/index.js";
import { v2BuysAt } from "../packages/testing/src/vaultFork.js";
import { test, expect, FORK_URL, forkRpc, installWallet, seedConfig, watchRpc, openSection, openTile } from "./fixtures.js";
import { ensureContracts } from "./vaults.js";

/** Every release's factory, oldest first, as the release record lists them. */
const FACTORIES = DEPLOYMENTS.map((d) => d.factory.toLowerCase());

const COUNTS_ONLY_VAULTS =
  "Only vaults from spDEX's factories. Swaps and confirm-each-buy plans carry no spDEX marker — one would label " +
  "every user. Addresses aren't people.";

/** Every factory's count, summed: every vault spDEX has made on this chain. */
async function vaultsMade(): Promise<bigint> {
  const counts = await Promise.all(FACTORIES.map((factory) => readVaultCount(forkRpc, factory as `0x${string}`)));
  return counts.reduce((sum, count) => sum + count, 0n);
}

test.describe("collective DCA", () => {
  test("counts every vault every factory lists, at the block it read, and says what it can't count", async ({ page, account }) => {
    // The factories exist on the fork only because tests deploy them; this one
    // does when no earlier one has.
    await ensureContracts();
    await installWallet(page, { address: account });
    await seedConfig(page);

    // Every request the page makes of the fork, to see what asks about a factory.
    const bodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(FORK_URL)) bodies.push(request.postData() ?? "");
    });
    const askedAbout = (factory: string) => bodies.some((body) => body.toLowerCase().includes(factory.slice(2)));
    const traffic = watchRpc(page);
    await page.goto("/");
    await openTile(page, "trade");

    const panel = page.getByTestId("collective-panel");
    await expect(page.getByTestId("tile-community")).toBeVisible();
    // Closed, it asks nothing: once the page has gone quiet, no request has named any factory.
    await traffic.quiet();
    await expect(panel).not.toHaveAttribute("data-block");
    expect(FACTORIES.some(askedAbout)).toBe(false);

    const before = await vaultsMade();
    await openTile(page, "community");
    const made = page.getByTestId("collective-made");
    await expect(made).toBeVisible({ timeout: 60_000 });
    const after = await vaultsMade();
    for (const factory of FACTORIES) expect(askedAbout(factory), factory).toBe(true);
    const shown = BigInt((await made.getAttribute("data-value"))!);
    expect(shown).toBeGreaterThanOrEqual(before);
    expect(shown).toBeLessThanOrEqual(after);

    // One block for every figure, named in the footer as the panel says it read.
    const block = BigInt((await panel.getAttribute("data-block"))!);

    // The share of v2 buys paid to community keepers inside their window,
    // read as each vault counts them (`windowBuys`): "none yet" while no v2
    // buy has been made, else a whole percentage rounded down, every digit a
    // tap away. The fork's other runs make v2 buys of every kind, so which
    // one this is, is the chain's to say, at the panel's block.
    const counted = await v2BuysAt(forkRpc, block);
    const share = page.getByTestId("collective-window");
    if (counted.buys === 0n) {
      await expect(share).toHaveText("none yet");
    } else {
      const percent = (counted.windowBuys * 100n) / counted.buys;
      await expect(share).toHaveText(percent === 0n && counted.windowBuys > 0n ? "less than 1%" : `${percent}%`);
      await share.getByRole("button").click();
      await expect(share).toHaveText(`${counted.windowBuys.toLocaleString("en-US")} of ${counted.buys.toLocaleString("en-US")} v2 buys`);
    }
    await expect(page.getByTestId("collective-footer")).toContainText(
      `Read at block ${block.toLocaleString("en-US")} through your network service (`,
    );
    await expect(page.getByTestId("collective-footer")).toContainText("These reads don't name your address.");
    await expect(page.getByTestId("collective-caveat")).toHaveText(COUNTS_ONLY_VAULTS);

    // Counts, never money: no currency anywhere in the panel.
    expect(await panel.innerText()).not.toMatch(/[$€£¥]/);
  });
});

test.describe("trust and exits", () => {
  test("says where this copy came from, and that this build names no source, rather than vouching for itself", async ({
    page,
    account,
    baseURL,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const panel = page.getByTestId("walkaway-panel");
    await openTile(page, "settings");
    await expect(panel).toContainText("Check this build, or leave with your vaults.");
    await openSection(page, "settings-trust");
    await page.getByTestId("walkaway-verify-summary").click();
    await expect(page.getByTestId("verify-build-origin")).toHaveText(
      `This copy came from ${new URL(baseURL!).origin}. A web server can change what it sends at any time, so this page ` +
        // No ", or rebuild it:": this build names no source, so there are no
        // commands to follow the colon.
        "can't vouch for itself. Open a release's CID through your own IPFS node or a gateway you trust.",
    );
    await expect(page.getByTestId("verify-build-no-source")).toHaveText("This build doesn't say where its source is published.");
    await expect(page.getByTestId("verify-build-shared-gateway")).toHaveCount(0);
    await expect(panel).not.toContainText("verified");

    // The way out of a vault without spDEX: the raw call, and each release's
    // factory in full, v1's first, as the release record lists them.
    await page.getByTestId("walkaway-exits-summary").click();
    await expect(page.getByTestId("walkaway-close")).toContainText("send 0 ETH to the vault with data 0x43d726d6 (that is close())");
    await expect(page.getByTestId("walkaway-factory")).toContainText("Without spDEX: these factories list every vault (vaultsPage)");
    // In full and checksummed: a shortened address is no use to someone without spDEX to expand it.
    await expect(page.getByTestId("walkaway-factory-address")).toHaveText(FACTORIES.map((factory) => checksumAddress(factory)));
  });
});
