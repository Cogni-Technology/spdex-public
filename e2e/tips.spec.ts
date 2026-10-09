/**
 * The tip registry: "My tip list", the picker's two lists, and who is
 * actually paid.
 *
 * What these follow is the address, from the moment it is typed to the
 * moment money does or doesn't reach it: the checks before it is saved (a
 * checksum, a contract, a lookalike), that the list stays in this browser,
 * that ENS is read through the person's own service and nothing else, that
 * the first tip to an address spDEX doesn't list waits for the person, that
 * a settings link can't make its own address look listed, and that a share
 * nobody confirmed is not sent — and not handed to anyone else.
 *
 * Every address typed here is made up. The listed ones are spDEX's own
 * donation vault (the real list, on every network) and the dev fixtures
 * (anvil accounts #1–#3), offered because the fork is a local test network.
 * The specs tip only the fixtures.
 */

import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { recommendedConfig, setFeature, shareFragment, TIP_FEATURE_ID } from "../packages/config/src/index.js";
import { checksumAddress } from "../packages/vault/src/index.js";
import {
  test,
  expect,
  fundWeth,
  installWallet,
  revokePermit2,
  seedConfig,
  sentTransactions,
  typedSignatures,
  FORK_CHAIN_ID,
  FORK_URL,
  SPX,
  forkRpc,
  tokenBalance,
  openSection,
  openTile,
  seedDisclaimer,
  skipDisclaimer,
} from "./fixtures.js";

const ONE_WETH = 10n ** 18n;

/** Made up, and checksummed as EIP-55 writes them. */
const MARIA = "0xabCDeF0123456789AbcdEf0123456789aBCDEF01";
const SAM = "0xfEdcBA9876543210FedCBa9876543210fEdCBa98";
/** Maria's address with one letter's case flipped: a typo the checksum catches. */
const MARIA_TYPO = "0xAbCDeF0123456789AbcdEf0123456789aBCDEF01";
/** Starts and ends like Maria's, and isn't: what address poisoning manufactures. */
const MARIA_LOOKALIKE = "0xaBCD00000000000000000000000000000000EF01";

/** The dev fixtures the fork offers: anvil #1, #2 and #3. */
const LISTED = [
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
] as const;
/** A listed recipient that isn't the spec's own account (tipping yourself is refused). */
const listedOtherThan = (account: string) => LISTED.find((address) => address !== account.toLowerCase())!;
/** Two listed recipients that aren't the spec's own account. */
const twoListedOtherThan = (account: string) => LISTED.filter((address) => address !== account.toLowerCase()).slice(0, 2) as [string, string];
/** Starts and ends like the dev fund's (anvil #1), and isn't. */
const DEV_FUND_LOOKALIKE = "0x70990000000000000000000000000000000079c8";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const lower = (address: string) => address.toLowerCase();

async function openTipSettings(page: Page): Promise<void> {
  await openTile(page, "settings");
  await openSection(page, "settings-tips");
  await expect(page.getByTestId("tiplist")).toBeVisible();
}

/** Fill the add form with `prefix` and submit it. */
async function addAddress(page: Page, prefix: string, target: string, name: string): Promise<void> {
  await page.getByTestId(`${prefix}-target`).fill(target);
  await page.getByTestId(`${prefix}-name`).fill(name);
  await page.getByTestId(`${prefix}-submit`).click();
}

const storedList = (page: Page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem("spdex.tiplist.v1") ?? "null") as {
    mine: { address: string; name: string; confirmed?: number }[];
  } | null);
const storedConfig = (page: Page) => page.evaluate(() => window.localStorage.getItem("spdex.config.v1") ?? "");

test.describe("tip registry", () => {
  test("My tip list: every check before saving, reorder, remove with undo, kept in this browser only", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTipSettings(page);
    await expect(page.getByTestId("tiplist-empty")).toBeVisible();

    // A typo the checksum catches, a token contract, a name like an address.
    await addAddress(page, "tiplist-add", MARIA_TYPO, "Maria");
    await expect(page.getByTestId("tiplist-add-error")).toHaveText("Checksum doesn't match — likely a typo.");
    await addAddress(page, "tiplist-add", SPX, "SPX");
    await expect(page.getByTestId("tiplist-add-error")).toHaveText("That's the SPX token contract — tokens sent there are lost.");
    await addAddress(page, "tiplist-add", MARIA, "Pay 0xabcd");
    await expect(page.getByTestId("tiplist-add-error")).toHaveText("A name can't look like an address.");

    // Saved, checksummed, and not yet tipped. Lowercase is accepted as is.
    await addAddress(page, "tiplist-add", MARIA, "Maria");
    const maria = page.getByTestId(`tiplist-entry-${lower(MARIA)}`);
    await expect(maria).toContainText("Maria");
    await expect(maria).toContainText(MARIA);
    await expect(page.getByTestId(`tiplist-state-${lower(MARIA)}`)).toHaveText("needs a check");
    await addAddress(page, "tiplist-add", lower(SAM), "Sam");
    await expect(page.getByTestId(`tiplist-entry-${lower(SAM)}`)).toContainText(SAM);

    // Starts and ends like Maria's: a danger, and nothing is saved without "Add anyway".
    await addAddress(page, "tiplist-add", MARIA_LOOKALIKE, "Maria (new)");
    // A short title, the sentence, and Maria's address above this one to compare.
    const lookalike = page.getByTestId("tiplist-add-warning-lookalike");
    await expect(lookalike.locator(".spdex-banner__title")).toHaveText("Lookalike address");
    await expect(lookalike).toContainText("Looks like Maria's address but isn't. Address-poisoning scams do this.");
    await expect(lookalike.locator("code").first()).toHaveText(MARIA);
    await expect(lookalike.locator("code").last()).toHaveText(MARIA_LOOKALIKE);
    await expect(page.getByTestId("tiplist-add-accept")).toHaveText("Add anyway — I checked");
    await page.getByTestId("tiplist-add-back").click();
    await expect(page.locator('[data-testid^="tiplist-entry-"]')).toHaveCount(2);
    // Back puts the keyboard back in the address field, not on the page.
    await expect(page.getByTestId("tiplist-add-target")).toBeFocused();

    // Reordered from the keyboard: the button keeps focus while its entry moves.
    const up = page.getByTestId(`tiplist-up-${lower(SAM)}`);
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid^="tiplist-entry-"]').first()).toHaveAttribute("data-testid", `tiplist-entry-${lower(SAM)}`);
    await expect(up).toBeFocused();
    await expect(up).toHaveAttribute("aria-disabled", "true");

    // Removed, then put back where it was. Focus follows, so a keyboard
    // never lands on the page: to the undo line, then to the entry.
    await page.getByTestId(`tiplist-remove-${lower(MARIA)}`).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tiplist-undo")).toContainText("Removed Maria");
    await expect(page.getByTestId("tiplist-undo")).toBeFocused();
    await expect(page.locator('[data-testid^="tiplist-entry-"]')).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("tiplist-undo-button")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid^="tiplist-entry-"]')).toHaveCount(2);
    await expect(page.getByTestId(`tiplist-entry-${lower(MARIA)}`)).toBeFocused();
    await expect(page.locator('[data-testid^="tiplist-entry-"]').last()).toHaveAttribute("data-testid", `tiplist-entry-${lower(MARIA)}`);

    // Kept across a reload, under its own key, and nowhere in the config.
    await page.reload();
    await openTipSettings(page);
    await expect(page.locator('[data-testid^="tiplist-entry-"]')).toHaveCount(2);
    expect((await storedList(page))?.mine.map((entry) => [entry.address, entry.name])).toEqual([
      [SAM, "Sam"],
      [MARIA, "Maria"],
    ]);
    const config = await storedConfig(page);
    expect(config).not.toContain("Maria");
    expect(config.toLowerCase()).not.toContain(lower(MARIA));
  });

  test("the Tip row: listed and saved addresses apart, and the first tip to a new one waits for the person", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("tip-chips-25").click();
    await expect(page.getByTestId("tip-picker")).toBeVisible();
    await expect(page.getByTestId("tip-listed-label")).toHaveText("Listed in spDEX (4)");
    await expect(page.getByTestId("tip-placeholder-notice")).toContainText("test addresses, not real people");
    await expect(page.getByTestId("tip-mine-label")).toHaveText("My tip list (0)");

    // Added from the picker: saved to the list and chosen at once. Opening
    // the form puts the keyboard in its address field.
    await page.getByTestId("tip-new-open").click();
    await expect(page.getByTestId("tip-new-target")).toBeFocused();
    await addAddress(page, "tip-new", MARIA, "Maria");

    // The picker closes and the first-tip check opens, focused on its
    // container rather than on "Tip this address" (UI rule R2,
    // docs/ARCHITECTURE.md).
    const confirm = page.getByTestId("tip-confirm");
    await expect(page.getByTestId("tip-picker")).toHaveCount(0);
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeFocused();
    await expect(page.getByTestId("tip-confirm-name")).toHaveText("Maria");
    await expect(page.getByTestId("tip-confirm-address")).toHaveText(MARIA);
    await expect(page.getByTestId("tip-confirm-lookalike")).toHaveText("Looks like no other listed, saved or chosen address.");
    await expect(confirm).toContainText("Check it with the person — a wrong address can't be undone.");

    // Until then it is chosen but not tipped, and nothing is sent.
    const pill = page.getByTestId(`tip-recipient-pill-${lower(MARIA)}`);
    await expect(pill).toHaveAttribute("data-tag", "MINE");
    await expect(page.getByTestId(`tip-pill-skipped-${lower(MARIA)}`)).toContainText("needs a check");
    await expect(page.getByTestId("tip-row-hint")).toHaveText("Nothing is sent until you check the address below.");

    // The config holds the address, labelled "My tip list": the private name stays here.
    const chosen = JSON.parse(await storedConfig(page)).tips.recipients;
    expect(chosen).toEqual([{ address: lower(MARIA), label: "My tip list", source: "my-tip-list", bps: 25 }]);

    // Answered from the keyboard: focus comes back to the row's "+", not the page.
    await page.getByTestId("tip-confirm-accept").focus();
    await page.keyboard.press("Enter");
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("tip-pick")).toBeFocused();
    await expect(page.getByTestId(`tip-pill-skipped-${lower(MARIA)}`)).toHaveCount(0);
    await expect(page.getByTestId("tip-row-hint")).toContainText("of what this swap delivers");
    const saved = (await storedList(page))?.mine.find((entry) => entry.address === MARIA);
    expect(saved?.confirmed).toEqual(expect.any(Number));

    // Escape closes the picker, from inside it or from "+", and focus comes
    // back to "+" (the tile stays open).
    await page.getByTestId("tip-pick").click();
    await page.getByTestId("tip-pick-close").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tip-picker")).toHaveCount(0);
    await expect(page.getByTestId("tip-pick")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tip-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tip-picker")).toHaveCount(0);
    await expect(page.getByTestId("tip-pick")).toBeFocused();
    await expect(page.getByTestId("tip-row")).toBeVisible();

    // Cancel is "don't tip this address": it leaves the row, and the row says
    // that the chip's 0.25% now goes to Maria alone, rather than doing it quietly.
    await page.getByTestId("tip-pick").click();
    await page.getByTestId("tip-new-open").click();
    await addAddress(page, "tip-new", SAM, "Sam");
    await expect(confirm).toBeVisible();
    const shares = async () =>
      (JSON.parse(await storedConfig(page)).tips.recipients as { address: string; bps: number }[]).map((r) => [r.address, r.bps]);
    expect(await shares()).toEqual([
      [lower(MARIA), 13],
      [lower(SAM), 12],
    ]);
    await page.getByTestId("tip-confirm-cancel").click();
    await expect(page.getByTestId(`tip-recipient-pill-${lower(SAM)}`)).toHaveCount(0);
    await expect(page.getByTestId(`tip-recipient-pill-${lower(MARIA)}`)).toBeVisible();
    expect(await shares()).toEqual([[lower(MARIA), 25]]);
    await expect(page.getByTestId("tip-row-notice")).toHaveText(
      "Not tipping that address. 0.25% now goes to the other person — pick a share to change it.",
    );
    await expect(page.getByTestId("tip-pick")).toBeFocused();
  });

  test("a settings link that claims the shipped list's name for its own address is still UNLISTED, and asks", async ({
    page,
    account,
  }) => {
    // Tips on, so the lists are read; nobody chosen yet.
    const on = setFeature({ ...recommendedConfig(), rpc: { url: FORK_URL, source: "user" } }, TIP_FEATURE_ID, true);
    const seeded = await seedConfig(page, { modules: on.modules, tips: on.tips });
    await installWallet(page, { address: account });
    await page.goto("/");
    await openTile(page, "trade");

    const forged = {
      ...seeded,
      tips: {
        enabled: true,
        recipients: [
          { address: lower(SAM), label: "Placeholder: dev fund", handle: "@spx_placeholder_1", source: "tiplist-spx-community", bps: 25 },
        ],
      },
    };
    await page.goto(`/#config=${shareFragment(forged as never)}`);

    // Listed before anything is applied: the tag from the address, the whole
    // address, and the lookalike check.
    const row = page.getByTestId(`staged-tip-${lower(SAM)}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`staged-tip-tag-${lower(SAM)}`)).toHaveAttribute("data-tag", "UNLISTED", { timeout: 30_000 });
    await expect(row).toContainText("named “Placeholder: dev fund” by these settings");
    await expect(row).toContainText(SAM);
    await expect(page.getByTestId(`staged-tip-lookalike-${lower(SAM)}`)).toHaveText("Looks like no other listed, saved or chosen address.");
    // The link's name for SAM is the listed dev fund's own: said, as a danger.
    await expect(page.getByTestId(`staged-tip-name-${lower(SAM)}-same-name`)).toHaveText(
      "Placeholder: dev fund is listed with a different address.",
    );
    await expect(page.getByTestId("staged-tips-ask")).toHaveText("Unlisted addresses ask before their first tip.");

    await page.getByTestId("accept-staged").click();
    await expect(page.getByTestId("staged-config")).toHaveCount(0);
    await openTile(page, "trade");

    // Applied, it is chosen, UNLISTED and not tipped until the person checks it.
    await expect(page.getByTestId(`tip-recipient-pill-${lower(SAM)}`)).toHaveAttribute("data-tag", "UNLISTED");
    await expect(page.getByTestId(`tip-pill-skipped-${lower(SAM)}`)).toBeVisible();
    const confirm = page.getByTestId("tip-confirm");
    await expect(confirm).toBeVisible();
    // Nobody here asked for it: it doesn't take focus.
    await expect(confirm).not.toBeFocused();
    await expect(page.getByTestId("tip-confirm-name")).toHaveText("named “Placeholder: dev fund” by loaded settings");
    await expect(page.getByTestId("tip-confirm-name-warning-same-name")).toHaveText("Placeholder: dev fund is listed with a different address.");

    await page.getByTestId("tip-confirm-accept").click();
    await expect(page.getByTestId(`tip-recipient-pill-${lower(SAM)}`)).toHaveAttribute("data-tag", "MINE");
    const saved = (await storedList(page))?.mine.find((entry) => entry.address === SAM);
    expect(saved).toMatchObject({ name: "From loaded settings", confirmed: expect.any(Number) });
    expect(JSON.parse(await storedConfig(page)).tips.recipients[0]).toMatchObject({ label: "My tip list", source: "my-tip-list" });
  });

  test("an ENS name is read through your own service, and nothing else is asked", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    await openTipSettings(page);

    await addAddress(page, "tiplist-add", "spdex-no-such-name-4c1e9a.eth", "Nobody");
    await expect(page.getByTestId("tiplist-add-error")).toHaveText(
      "This name isn't resolved on chain here; spDEX won't ask a third party. Paste the address.",
    );

    // A registered name: its address shown in full before anything is saved.
    await addAddress(page, "tiplist-add", "ENS.eth", "");
    const resolved = page.getByTestId("tiplist-add-resolved");
    await expect(resolved).toContainText("ens.eth →", { timeout: 30_000 });
    await expect(resolved).toContainText("(read via your service)");
    const shown = ((await resolved.locator("code").textContent()) ?? "").trim();
    expect(shown).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await page.getByTestId("tiplist-add-accept").click();
    const entry = page.getByTestId(`tiplist-entry-${lower(shown)}`);
    await expect(entry).toContainText("ens.eth");

    // Every request went to the page itself or the network service it was given.
    const elsewhere = requests.filter(
      (url) => !url.startsWith(origin) && !url.startsWith(FORK_URL) && !url.startsWith("data:") && !url.startsWith("blob:"),
    );
    expect(elsewhere).toEqual([]);
  });

  test("the list goes out and comes back as a file, and what comes back asks before its first tip", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTipSettings(page);
    await addAddress(page, "tiplist-add", MARIA, "Maria");
    await expect(page.getByTestId(`tiplist-entry-${lower(MARIA)}`)).toBeVisible();

    await page.getByTestId("tiplist-io-summary").click();
    const saving = page.waitForEvent("download");
    await page.getByTestId("tiplist-export").click();
    const file = await saving;
    expect(file.suggestedFilename()).toBe("spdex-tip-list.json");
    const text = readFileSync((await file.path())!, "utf8");
    expect(JSON.parse(text)).toEqual({ spdex: "tip-list", v: 1, entries: [{ address: MARIA, name: "Maria" }] });

    await page.getByTestId(`tiplist-remove-${lower(MARIA)}`).click();
    await expect(page.getByTestId("tiplist-empty")).toBeVisible();
    await page.getByTestId("tiplist-import-file").setInputFiles({
      name: "spdex-tip-list.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
    await expect(page.getByTestId("tiplist-import-result")).toHaveText("Added 1.");
    await expect(page.getByTestId(`tiplist-state-${lower(MARIA)}`)).toHaveText("needs a check");
  });

  test("a share nobody confirmed is not sent, and not given to the others", async ({ page, account }) => {
    /*
     * Two people chosen at 0.5%: one listed, one saved but never confirmed.
     * The swap tips the listed one their 0.25% in one transfer, and the
     * unconfirmed address receives nothing — the share it would have had
     * stays with the person.
     */
    const listed = listedOtherThan(account);
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("tip-chips-50").click();
    await page.getByTestId(`tip-add-${listed}`).click();
    await page.getByTestId("tip-pick").click();
    await page.getByTestId("tip-new-open").click();
    await addAddress(page, "tip-new", MARIA, "Maria");
    await expect(page.getByTestId("tip-confirm")).toBeVisible();
    await expect(page.getByTestId(`tip-recipient-pill-${listed}`)).toHaveAttribute("data-tag", "LISTED");

    const before = { listed: await tokenBalance(SPX, listed), maria: await tokenBalance(SPX, MARIA) };

    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.2");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
    // Stated before the swap: half the chip, one person, one transfer.
    await expect(page.getByTestId("tip-preview-total")).toContainText("0.25% to 1 person");
    await expect(page.getByTestId("tip-row-hint")).toContainText("1 not tipped");
    await expect(page.getByTestId("tip-row-hint")).toContainText("1 extra confirmation");

    const sentBefore = (await sentTransactions(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("Tipped", { timeout: 120_000 });

    // One transfer, to the listed address; none to the unconfirmed one.
    const transfers = (await sentTransactions(page))
      .slice(sentBefore)
      .filter((tx) => tx.to?.toLowerCase() === SPX && (tx.data ?? "").startsWith("0xa9059cbb"))
      .map((tx) => `0x${(tx.data ?? "").slice(34, 74)}`);
    expect(transfers).toEqual([listed]);
    expect(await tokenBalance(SPX, listed)).toBeGreaterThan(before.listed);
    expect(await tokenBalance(SPX, MARIA)).toBe(before.maria);
  });

  test("with tips off, a new address is still compared with the listed entries", async ({ page, account }) => {
    // Tips stay off: the shipped lists are read anyway, so a lookalike of a
    // listed address is caught, and the count is a count, not an unread zero.
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTipSettings(page);
    await expect(page.getByTestId("tiplist-listed-summary")).toHaveText(/Listed in spDEX \(4\)/, { timeout: 30_000 });

    await addAddress(page, "tiplist-add", DEV_FUND_LOOKALIKE, "Dev fund");
    const warning = page.getByTestId("tiplist-add-warning-lookalike");
    await expect(warning).toContainText("Looks like Placeholder: dev fund's address but isn't.");
    await expect(page.getByTestId("tiplist-add-warning-same-name")).toHaveCount(0);
    await page.getByTestId("tiplist-add-back").click();
    expect((await storedList(page))?.mine ?? []).toEqual([]);
  });

  test("hiding a listed entry keeps it out of the picker until it is shown again", async ({ page, account }) => {
    const listed = listedOtherThan(account);
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTipSettings(page);
    await page.getByTestId("tiplist-listed-summary").click();
    await page.getByTestId(`tiplist-hide-${listed}`).click();
    await expect(page.getByTestId(`tiplist-listed-${listed}`)).toHaveCount(0);
    await expect(page.getByTestId("tiplist-show-hidden")).toHaveText("Show hidden (1)");

    await openTile(page, "trade");
    await page.getByTestId("tip-chips-25").click();
    await expect(page.getByTestId("tip-picker")).toBeVisible();
    await expect(page.getByTestId(`candidate-${listed}`)).toHaveCount(0);
    await expect(page.getByTestId("tip-listed-label")).toHaveText("Listed in spDEX (3)");

    await openTipSettings(page);
    // The section keeps its disclosure as it was left, open.
    if (!(await page.getByTestId("tiplist-show-hidden").isVisible())) await page.getByTestId("tiplist-listed-summary").click();
    await page.getByTestId("tiplist-show-hidden").click();
    await expect(page.getByTestId(`tiplist-listed-${listed}`)).toBeVisible();
  });

  test("removing a chosen address from My tip list takes it out of the Tip row, and Undo puts both back", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("tip-chips-25").click();
    await page.getByTestId("tip-new-open").click();
    await addAddress(page, "tip-new", MARIA, "Maria");
    await page.getByTestId("tip-confirm-accept").click();
    await expect(page.getByTestId(`tip-recipient-pill-${lower(MARIA)}`)).toHaveAttribute("data-tag", "MINE");

    await openTipSettings(page);
    await page.getByTestId(`tiplist-remove-${lower(MARIA)}`).click();
    await expect(page.getByTestId("tiplist-undo")).toContainText("Removed Maria, and no longer tipped");
    expect(JSON.parse(await storedConfig(page)).tips.recipients).toEqual([]);

    // Undo: saved again, confirmed as before, and chosen with the same share.
    await page.getByTestId("tiplist-undo-button").click();
    expect((await storedList(page))?.mine.map((entry) => [entry.address, entry.confirmed !== undefined])).toEqual([[MARIA, true]]);
    expect(JSON.parse(await storedConfig(page)).tips.recipients).toEqual([
      { address: lower(MARIA), label: "My tip list", source: "my-tip-list", bps: 25 },
    ]);

    // Removed for good: the Tip row doesn't claim settings were loaded.
    await page.getByTestId(`tiplist-remove-${lower(MARIA)}`).click();
    await openTile(page, "trade");
    await expect(page.getByTestId(`tip-recipient-pill-${lower(MARIA)}`)).toHaveCount(0);
    await expect(page.getByTestId("tip-row")).not.toContainText("loaded settings");
  });

  test("addresses chosen before the list existed are kept once, and a link applied later still asks", async ({ page, account }) => {
    // A config from an earlier build: tips on, an address nobody lists, and
    // no "My tip list" in storage yet.
    const on = setFeature({ ...recommendedConfig(), rpc: { url: FORK_URL, source: "user" } }, TIP_FEATURE_ID, true);
    const seeded = await seedConfig(page, {
      modules: on.modules,
      tips: { enabled: true, recipients: [{ address: lower(MARIA), label: "Maria", bps: 25 }] },
    });
    await installWallet(page, { address: account });
    await page.goto("/");
    await openTile(page, "trade");

    // Said once, and Maria is tipped without a question.
    const row = page.getByTestId("tip-row");
    await expect(row.getByTestId("tip-migrated")).toContainText("The address you chose before is now in My tip list.");
    await expect(page.getByTestId(`tip-recipient-pill-${lower(MARIA)}`)).toHaveAttribute("data-tag", "MINE");
    await expect(page.getByTestId(`tip-pill-skipped-${lower(MARIA)}`)).toHaveCount(0);
    await expect(page.getByTestId("tip-confirm")).toHaveCount(0);
    expect((await storedList(page))?.mine).toEqual([expect.objectContaining({ address: MARIA, name: "Maria", confirmed: expect.any(Number) })]);

    // A settings link applied afterwards is not "chosen before": it asks.
    const linked = {
      ...seeded,
      tips: {
        enabled: true,
        recipients: [
          { address: lower(MARIA), label: "Maria", bps: 13 },
          { address: lower(SAM), label: "Sam", bps: 12 },
        ],
      },
    };
    await page.goto(`/#config=${shareFragment(linked as never)}`);
    await expect(page.getByTestId(`staged-tip-${lower(SAM)}`)).toBeVisible();
    await page.getByTestId("accept-staged").click();
    await openTile(page, "trade");
    await expect(page.getByTestId(`tip-pill-skipped-${lower(SAM)}`)).toContainText("needs a check");
    await expect(page.getByTestId("tip-confirm")).toHaveAttribute("data-address", lower(SAM));
    await expect(page.getByTestId(`tip-pill-skipped-${lower(MARIA)}`)).toHaveCount(0);

    // And a reload doesn't stamp it: the list exists now.
    await page.reload();
    await openTile(page, "trade");
    await expect(page.getByTestId("tip-row")).toBeVisible();
    await expect(page.getByTestId("tip-migrated")).toHaveCount(0);
  });

  test("a batch through Permit2 pays exactly the confirmed recipients, and its card says how many, as its link shows", async ({
    page,
    account,
    browser,
  }) => {
    /*
     * Three chosen at 0.5%: two listed, one saved and never confirmed. One
     * signature and one Permit2 transaction pay the two listed their shares;
     * the unconfirmed address receives nothing, in the batch or outside it.
     */
    const [first, second] = twoListedOtherThan(account);
    await revokePermit2(SPX, account);
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("tip-chips-50").click();
    await page.getByTestId(`tip-add-${first}`).click();
    await page.getByTestId("tip-pick").click();
    await page.getByTestId(`tip-add-${second}`).click();
    await page.getByTestId("tip-pick").click();
    await page.getByTestId("tip-new-open").click();
    await addAddress(page, "tip-new", MARIA, "Maria");
    await expect(page.getByTestId("tip-confirm")).toBeVisible();

    const before = {
      first: await tokenBalance(SPX, first),
      second: await tokenBalance(SPX, second),
      maria: await tokenBalance(SPX, MARIA),
    };

    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.2");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("tip-row-hint")).toContainText("1 not tipped");
    await expect(page.getByTestId("tip-row-hint")).toContainText("sent in one transaction");

    const sentBefore = (await sentTransactions(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("Tipped", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("to 2 people in one transaction");

    // One signature, for two amounts; one batch; no transfer of its own to anyone.
    const typed = await typedSignatures(page);
    expect(typed.at(-1)?.message?.permitted).toHaveLength(2);
    const sent = (await sentTransactions(page)).slice(sentBefore);
    const batches = sent.filter((tx) => tx.to?.toLowerCase() === PERMIT2);
    expect(batches).toHaveLength(1);
    // The batch's calldata names the two listed addresses, and not Maria's.
    const data = (batches[0]!.data ?? "").toLowerCase();
    expect(data).toContain(first.slice(2));
    expect(data).toContain(second.slice(2));
    expect(data).not.toContain(lower(MARIA).slice(2));
    expect(sent.filter((tx) => tx.to?.toLowerCase() === SPX && (tx.data ?? "").startsWith("0xa9059cbb"))).toHaveLength(0);

    expect(await tokenBalance(SPX, first)).toBeGreaterThan(before.first);
    expect(await tokenBalance(SPX, second)).toBeGreaterThan(before.second);
    expect(await tokenBalance(SPX, MARIA)).toBe(before.maria);

    // The card says how many were tipped, and carries the batch's hash in full beside the buy's.
    const after = page.getByTestId("after-swap");
    await expect(after.getByTestId("make-card")).toBeVisible({ timeout: 60_000 });
    await after.getByTestId("make-card").click();
    const dialog = page.getByTestId("card-dialog");
    await expect(dialog.getByTestId("card-tips")).toBeChecked();
    await expect(dialog.getByTestId("card-preview")).toContainText("Tipped 2 people");
    await expect(dialog.getByTestId("card-preview")).toContainText(`#receipt=${FORK_CHAIN_ID}:0x…+0x…`);
    const printed = (await dialog.getByTestId("card-preview").innerText()).replace(/\s/g, "");
    const [, buy, tips] = /TRANSACTION(0x[0-9a-f]{64})TIPS(0x[0-9a-f]{64})/.exec(printed) ?? [];
    expect(buy, printed).toBeDefined();
    const batch = (await forkRpc("eth_getTransactionByHash", [tips])) as { to: string } | null;
    expect(batch?.to.toLowerCase()).toBe(PERMIT2);
    // Unticked, the card is as it was: no count, no second hash.
    await dialog.getByTestId("card-tips").uncheck();
    await expect(dialog.getByTestId("card-preview")).not.toContainText("Tipped");
    await expect(dialog.getByTestId("card-tips-hash")).toHaveCount(0);
    await dialog.getByTestId("card-close").click();

    // Someone sent the link, in a browser that never saw spDEX: it counts the
    // addresses the buyer sent SPX to in the batch, from its own reads.
    const other = await browser.newContext();
    await seedDisclaimer(other);
    const viewer = await other.newPage();
    await viewer.goto(`/#receipt=${FORK_CHAIN_ID}:${buy}+${tips}`);
    await skipDisclaimer(viewer);
    await openTile(viewer, "trade");
    await viewer.getByTestId("rpc-url-input").fill(FORK_URL);
    await viewer.getByTestId("rpc-save").click();
    await openTile(viewer, "receipt");
    const view = viewer.getByTestId("receipt-view");
    await expect(view.getByTestId("receipt-outcome")).toHaveAttribute("data-outcome", "delivered", { timeout: 60_000 });
    await expect(view.getByTestId("receipt-tips")).toHaveAttribute("data-outcome", "tipped");
    await expect(view.getByTestId("receipt-tips-count")).toContainText("Tipped 2 addresses");
    await expect(view.getByTestId("receipt-tips")).toContainText(checksumAddress(first));
    await expect(view.getByTestId("receipt-tips")).toContainText(checksumAddress(second));
    await other.close();
  });
});
