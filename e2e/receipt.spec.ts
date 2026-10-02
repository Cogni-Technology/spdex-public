/**
 * The "I bought" card, and the `#receipt=` link that lets anyone check it.
 *
 * The claim is that a card is a picture of what the chain says and nothing
 * more, and that the check doesn't trust the card. So one real ETH → SPX
 * swap is made, its card is saved as a PNG, and the transaction is then
 * opened as `#receipt=<chain>:<hash>` in a separate browser that has never
 * seen spDEX: no records, no settings, no wallet. That browser has to choose
 * a network service before anything is read, and what it then shows comes
 * from its own reads, so the same SPX amount on both sides is the chain
 * agreeing with the card, not the page agreeing with itself.
 */

import { readFileSync } from "node:fs";
import { checksumAddress } from "../packages/vault/src/index.js";
import {
  test,
  expect,
  FORK_CHAIN_ID,
  FORK_URL,
  installWallet,
  seedConfig,
  spxFigure,
  swapEthForSpx,
  openTile,
  seedDisclaimer,
  skipDisclaimer,
} from "./fixtures.js";

/** The PNG signature, and where its header says how wide and tall the image is. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test.describe("receipt", () => {
  test("a swap's card saves as a PNG or copies, and its #receipt= link shows the same SPX in a browser that never saw it", async ({
    page,
    account,
    browser,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));

    const { delivered, hashes } = await swapEthForSpx(page, account, "0.01");
    // The card carries the transaction that delivered the SPX: the last one.
    const hash = hashes.at(-1)!;
    const amount = `+${spxFigure(delivered, 2)} SPX`;

    const after = page.getByTestId("after-swap");
    await expect(after.getByTestId("make-card")).toBeVisible({ timeout: 60_000 });
    // The swap's transaction, beside its badge, short, and copied whole when tapped.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await expect(after.getByTestId("after-swap-tx")).toHaveText(`${hash.slice(0, 6)}…${hash.slice(-4)}`);
    await after.getByTestId("after-swap-tx-copy").click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).toLowerCase()).toBe(hash.toLowerCase());
    await expect(after.locator(".spdex-copyhex [role=status]")).toHaveText("Copied.");
    await after.getByTestId("make-card").click();
    const dialog = page.getByTestId("card-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("card-amount")).toHaveText(amount);
    // The hash in full, once, in groups: the only way to check the card
    // without spDEX, on any explorer.
    const printed = (await dialog.getByTestId("card-preview").innerText()).replace(/\s/g, "");
    expect(printed).toContain(hash.toLowerCase());
    // No money anywhere on it, and a dev server's address isn't printed as a link.
    expect(printed).not.toMatch(/[$€£¥]/);
    await expect(dialog.getByTestId("card-preview")).toContainText(`Check it: open #receipt=${FORK_CHAIN_ID}:0x… in any spDEX`);

    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("card-download").click()]);
    expect(download.suggestedFilename()).toBe(`spdex-card-${hash.slice(0, 10).toLowerCase()}.png`);
    const png = readFileSync((await download.path())!);
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 675]);

    // Copied instead, it is the same picture, to paste straight into a post.
    await dialog.getByTestId("card-copy").click();
    await expect(dialog.getByTestId("card-copied")).toHaveText("Copied. Paste it into your post.");
    const pasted = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      if (item === undefined || !item.types.includes("image/png")) return null;
      return [...new Uint8Array(await (await item.getType("image/png")).arrayBuffer()).subarray(0, 24)];
    });
    expect(pasted).not.toBeNull();
    const head = Buffer.from(pasted!);
    expect([...head.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect([head.readUInt32BE(16), head.readUInt32BE(20)]).toEqual([1200, 675]);
    // A card changed after copying isn't the one on the clipboard.
    await dialog.getByTestId("card-caption-bought").click();
    await expect(dialog.getByTestId("card-copied")).toHaveText("");
    await dialog.getByTestId("card-close").click();

    // Someone else, sent the link: a fresh browser with no settings at all.
    const other = await browser.newContext();
    await seedDisclaimer(other);
    const viewer = await other.newPage();
    await viewer.goto(`/#receipt=${FORK_CHAIN_ID}:${hash}`);
    await skipDisclaimer(viewer);
    await openTile(viewer, "trade");
    // Nothing is read before a network service is chosen, and the first-run
    // screen says why this visit is waiting.
    await expect(viewer.getByTestId("first-run-receipt")).toHaveText(
      "Someone shared a transaction. Choose a network service and spDEX will show what the chain says about it.",
    );
    await viewer.getByTestId("rpc-url-input").fill(FORK_URL);
    await viewer.getByTestId("rpc-save").click();

    const view = viewer.getByTestId("receipt-view");
    await openTile(viewer, "receipt");
    await expect(view).toBeVisible({ timeout: 60_000 });
    // The shared transaction is what this visit is for: no Features dialog over it.
    await expect(viewer.getByTestId("features-modal")).toHaveCount(0);
    await openTile(viewer, "receipt");
    await expect(view.getByTestId("receipt-outcome")).toHaveAttribute("data-outcome", "delivered", { timeout: 60_000 });
    const delivery = view.getByTestId("receipt-delivery");
    await expect(delivery).toHaveCount(1);
    await expect(delivery.getByTestId("receipt-amount")).toHaveText(amount);
    await expect(delivery).toContainText(`to ${checksumAddress(account)}`);
    // Bought, because the SPX came from a pool spDEX itself finds for SPX.
    await expect(delivery).toHaveAttribute("data-source", "pool");
    await expect(delivery.getByTestId("receipt-source")).toContainText(/^Bought from the Uniswap v[23] SPX\/WETH pool 0x/);
    await other.close();
  });
});
