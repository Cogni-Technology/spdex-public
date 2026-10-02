/**
 * Your records: what a swap leaves behind in this browser, and a plan's
 * reminders.
 *
 * The claim is that every record is the chain's account of what happened,
 * not the quote's. So the swap specs here each make one real ETH → SPX swap
 * and hold what the page then shows — the after-swap block, Your stack, Your
 * activity and its spreadsheet file — to what the fork says arrived, to the
 * last unit, and to the transactions the fork says the account sent. None of
 * it asserts a price: the fork is long-lived and traded against.
 *
 * Unknown is never zero. A figure spDEX can't know here is a blank cell,
 * and the one money figure Your stack has sits inside `stack-put-in`, so a
 * spec can hold every other figure on that card to having none.
 *
 * The calendar file is checked from its text: one repeating event whose
 * first reminder is the plan's first buy time, with no address in it, and no
 * link, since the dev server's build names no published address
 * (`VITE_SPDEX_APP_URL`) and spDEX never takes one from the address bar.
 */

import { readFileSync } from "node:fs";
import { checksumAddress } from "../packages/vault/src/index.js";
import {
  test,
  expect,
  feePaid,
  installWallet,
  seedConfig,
  sentTransactions,
  spxFigure,
  swapEthForSpx,
  openTile,
  seedDisclaimer,
} from "./fixtures.js";

/** 0.01 ETH: one swap, small enough that a reused account never notices. */
const SWAP = "0.01";

/** Every digit, "." for the mark, no grouping: how the CSV writes an amount. */
function machine(amount: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (amount % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${amount / unit}${fraction === "" ? "" : `.${fraction}`}`;
}

/** A CSV line's cells. The file quotes only cells that need it, and these don't. */
function cells(line: string): string[] {
  expect(line, "an unquoted line").not.toContain('"');
  return line.split(",");
}

test.describe("records", () => {
  test("after a swap: the badge says included, You received is what arrived, and Your stack rises by it", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));

    // Your stack reads this browser's records once it has been on screen. A
    // fresh browser has recorded nothing, and the suite's config has no vault
    // plans, so it starts from nothing, and says so, rather than from unknown.
    const stack = page.getByTestId("stack-card");
    await openTile(page, "yours");
    await stack.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("stack-stacked")).toHaveText("0 SPX", { timeout: 60_000 });

    const { delivered } = await swapEthForSpx(page, account, SWAP);

    // The badge's state, not its words: included now, and final only 64
    // blocks later, which nothing in this spec mines.
    const after = page.getByTestId("after-swap");
    await expect(after.getByTestId("finality-badge")).toHaveAttribute("data-state", "included", { timeout: 60_000 });
    // Measured from the receipts, never the quote's expectation.
    await expect(after.getByTestId("after-swap-received")).toHaveText(`You received ${spxFigure(delivered, 6)} SPX.`, {
      timeout: 60_000,
    });

    await openTile(page, "yours");
    await stack.scrollIntoViewIfNeeded();
    const places = delivered >= 10n ** 8n ? 2 : 8;
    await expect(page.getByTestId("stack-stacked")).toHaveText(`${spxFigure(delivered, places)} SPX`, { timeout: 60_000 });
    await expect(stack).toContainText("1 buy: 1 swap");
    await expect(page.getByTestId("stack-put-in-value")).toHaveText(`${SWAP} ETH`);

    // No money figure anywhere on the card but Put in's value at the time.
    const elsewhere = await stack.evaluate((card) => {
      const copy = card.cloneNode(true) as HTMLElement;
      copy.querySelector('[data-testid="stack-put-in"]')?.remove();
      return copy.textContent ?? "";
    });
    expect(elsewhere).not.toMatch(/[$€£¥₩₺₱₽₹]|\b(USD|EUR|GBP|JPY|KRW|CNY|CHF|CAD|AUD|SGD|NZD|BRL|MXN|TRY|IDR|ARS|PHP)\b/);
  });

  test("a swap is listed in Your activity with its transaction, and its CSV row is the chain's", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));

    const { delivered, hashes } = await swapEthForSpx(page, account, SWAP);
    const last = hashes.at(-1)!;
    // Before the tile is opened, its header says the SPX held, from the
    // trade card's own read, not "not read yet" under "You received".
    await expect(page.getByTestId("tile-yours-summary")).toContainText(/[\d,.]+ SPX/, { timeout: 60_000 });

    await openTile(page, "yours");
    const row = page.locator(`[data-testid="activity-row"][data-hash="${last}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute("data-kind", "swap");
    await expect(row).toContainText(`${last.slice(0, 6)}…${last.slice(-4)}`);
    // Six significant digits on screen; the file below carries every one.
    await expect(row).toContainText(/Bought [\d,.]+ SPX/);
    await expect(row).toContainText(`${SWAP} ETH`);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("activity-csv").click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^spdex-activity-\\d+-${account.slice(2, 8)}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    const lines = readFileSync((await download.path())!, "utf8").split("\r\n");
    const header = cells(lines[0]!);
    expect(header.slice(0, 3)).toEqual(["date_utc", "date_source", "kind"]);
    const at = (line: string[], column: string) => line[header.indexOf(column)];
    const rows = lines.slice(1).filter((line) => line !== "").map(cells);
    const mine = rows.filter((line) => at(line, "tx_hash") === hashes.join(" "));
    expect(mine).toHaveLength(1);
    const line = mine[0]!;

    expect(at(line, "kind")).toBe("swap");
    expect(at(line, "account")).toBe(checksumAddress(account));
    expect(at(line, "sold_token")).toBe("ETH");
    expect(at(line, "sold_amount")).toBe(SWAP);
    expect(at(line, "bought_token")).toBe("SPX");
    expect(at(line, "bought_amount")).toBe(machine(delivered, 8));
    expect(at(line, "bought_measured")).toBe("true");
    let fees = 0n;
    for (const hash of hashes) fees += await feePaid(hash);
    expect(at(line, "network_fee_eth")).toBe(machine(fees, 18));
    // Dollars are the value column itself, so the local one stays empty,
    // rather than repeating it or reading 0.
    expect(at(line, "value_local_at_time")).toBe("");
    expect(at(line, "local_currency")).toBe("");
  });

  test("Add to calendar downloads a reminder whose first event is the plan's first buy time", async ({ browser, account }) => {
    // The page's time zone is UTC, so the time typed is the time the file names.
    const context = await browser.newContext({ timezoneId: "UTC" });
    await seedDisclaimer(context);
    const page = await context.newPage();
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();

    // Expert, for "First buy: at a time I choose": tomorrow at noon, so the
    // plan is saved and nothing is sent.
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openTile(page, "trade");
    await page.getByTestId("buy-mode-recurring").click();
    await page.getByTestId("dca-form-amount").fill("0.001");
    await page.getByTestId("dca-form-count").fill("3");
    await page.getByTestId("dca-form-first-buy").selectOption("later");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await page.getByTestId("dca-form-start-at").fill(`${tomorrow}T12:00`);
    const start = page.getByTestId("dca-form-start");
    await expect(start).toBeEnabled({ timeout: 30_000 });
    await start.click();

    // Offered where someone has just started a plan, and on the plan's card.
    // Trade stays open after Start: the banner's calendar first, then the card's, in Auto-buys.
    const started = page.getByTestId("dca-form-started");
    await expect(started).toBeVisible({ timeout: 30_000 });
    await started.getByTestId("dca-calendar").click();
    const panel = started.getByTestId("dca-calendar-panel");
    // The dev server sets no VITE_SPDEX_APP_URL, and spDEX never fills one in.
    await expect(panel.getByTestId("dca-calendar-link")).toHaveText(
      "This build doesn't say where spDEX is published, so the file has no link.",
    );
    const [download] = await Promise.all([page.waitForEvent("download"), panel.getByTestId("dca-calendar-download").click()]);
    expect(download.suggestedFilename()).toMatch(/^spdex-.+\.ics$/);
    const ics = readFileSync((await download.path())!, "utf8");

    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
    expect(ics.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1);
    expect(ics).toContain(`\r\nDTSTART:${tomorrow.replace(/-/g, "")}T120000Z\r\n`);
    expect(ics).toContain("\r\nRRULE:FREQ=DAILY;INTERVAL=1;COUNT=3\r\n");
    expect(ics).not.toMatch(/^URL:/m);
    expect(ics, "no address, key or hash").not.toMatch(/0x[0-9a-f]{40}/i);
    await openTile(page, "auto-buys");
    await expect(page.locator('[data-testid^="dca-plan-"]').getByTestId("dca-calendar")).toBeVisible();
    expect(await sentTransactions(page)).toEqual([]);
    await context.close();
  });
});
