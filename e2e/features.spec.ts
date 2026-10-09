/**
 * Features, and the tip split that tests whether they are real.
 *
 * The claim being exercised is that a feature is a module plus config, and that
 * recommended mode can turn one on without dropping the user into an editor.
 * Tipping is set where it happens — the Tip row on the trade card, with exact
 * shares in Expert — and the tipping specs are the ones that matter: they
 * follow money out of the wallet and assert it arrived at addresses the user
 * picked from a registry module. One person is one transfer; two or more are
 * one signature and one transaction through Permit2, with a standing
 * permission for Permit2 between them the first time, and the specs count
 * exactly that, in that order: the signature comes first, so a wallet that
 * can't sign typed data is never asked for the permission.
 */

import type { Page } from "@playwright/test";
import {
  test,
  expect,
  fundWeth,
  grantPermit2,
  installWallet,
  permit2Allowance,
  revokePermit2,
  seedConfig,
  sentTransactions,
  signedTransactions,
  FORK_URL,
  SPX,
  tokenBalance,
  typedSignatures,
  walletPrompts,
  type ProposedTransaction,
  type WalletPrompt,
  openSection,
  openTile,
} from "./fixtures.js";

const ONE_WETH = 10n ** 18n;

/** anvil #1, the first placeholder the dev fixtures (modules/tiplist-dev-fixtures) offer on the fork. */
const PLACEHOLDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/** Every placeholder the dev fixtures offer: anvil #1, #2 and #3. */
const PLACEHOLDERS = [
  PLACEHOLDER,
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
] as const;

/**
 * Two people a spec that sends tips can choose.
 *
 * The placeholders are anvil accounts, and so is the account each spec is
 * handed, in turn. A spec that happened to be handed a placeholder and tipped
 * it would be tipping itself, which the Guard refuses ("pays the sender"),
 * and whether it did would depend on how many specs ran before it. So the
 * recipients are the first two placeholders that are not the account.
 */
function recipientsFor(account: string): [string, string] {
  const others = PLACEHOLDERS.filter((address) => address !== account.toLowerCase());
  return [others[0]!, others[1]!];
}

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/** What a transaction the page proposed is to the tips, by target and calldata; null for the swap's own. */
function tipKind(tx: { to?: string; data?: string }): "permission" | "batch" | "transfer" | null {
  const to = tx.to?.toLowerCase();
  const data = (tx.data ?? "").toLowerCase();
  // approve(Permit2, …) on SPX: the standing permission.
  if (to === SPX && data.startsWith("0x095ea7b3") && data.slice(34, 74) === PERMIT2.slice(2)) return "permission";
  // Permit2's permitTransferFrom: the batch.
  if (to === PERMIT2) return "batch";
  // transfer(to, amount) on SPX: one tip each.
  if (to === SPX && data.startsWith("0xa9059cbb")) return "transfer";
  return null;
}

/** What the tips added to what the page asked the wallet to send, sorted by kind. */
function tipTransactions(sent: ProposedTransaction[]) {
  return {
    permissions: sent.filter((tx) => tipKind(tx) === "permission"),
    batches: sent.filter((tx) => tipKind(tx) === "batch"),
    transfers: sent.filter((tx) => tipKind(tx) === "transfer"),
  };
}

/**
 * What the tips asked of the wallet, in the order it was asked: "signature"
 * for typed data, and each transaction by `tipKind`. The swap's own prompts
 * are left out.
 */
function tipPromptOrder(prompts: WalletPrompt[]): string[] {
  return prompts.flatMap((prompt) => {
    if (prompt.method === "eth_signTypedData_v4") return ["signature"];
    const kind = tipKind(prompt);
    return kind === null ? [] : [kind];
  });
}

test.describe("features", () => {
  test("opens from recommended mode and lists what each feature costs", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // Reachable without touching the mode switch — that is the whole point of
    // putting it here rather than in the expert editor.
    await expect(page.getByTestId("features-modal")).toHaveCount(0);
    await openTile(page, "settings");
    await page.getByTestId("open-features").click();
    await expect(page.getByTestId("features-modal")).toBeVisible();

    await expect(page.getByTestId("feature-venue-uniswap-v2")).toBeVisible();
    await expect(page.getByTestId("feature-tip-splits")).toBeVisible();
    // In Simple, a feature is named for what it does; no module ids.
    await expect(page.getByTestId("feature-venue-uniswap-v2")).not.toContainText("venue-uniswap-v2");
    await expect(page.getByTestId("feature-badge-venue-uniswap-v2")).toHaveCount(0);

    await page.getByTestId("close-features").click();
    await expect(page.getByTestId("features-modal")).toHaveCount(0);

    // In Expert, features name the module they activate, or say they are a host setting.
    await page.getByTestId("mode-toggle-expert").click();
    await page.getByTestId("open-features").click();
    await expect(page.getByTestId("feature-badge-venue-uniswap-v2")).toHaveText("venue-uniswap-v2");
    await expect(page.getByTestId("feature-badge-strict-sandbox")).toHaveText("host setting");
    await page.getByTestId("close-features").click();
  });

  test("opens by itself the first time, and only the first time", async ({ page, account }) => {
    // "Opt in during selection" only means something if the choice is actually
    // put in front of someone. A dialog that lives solely behind a button is a
    // default wearing a costume.
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showFeatures: true });
    await page.goto("/");
    await openTile(page, "trade");
    await expect(page.getByTestId("features-modal")).toBeVisible();

    await page.getByTestId("features-done").click();
    await expect(page.getByTestId("features-modal")).toHaveCount(0);

    // Second visit: behind the button, because a prompt that reappears forever
    // gets dismissed reflexively, which is worse than never asking.
    await page.goto("/");
    await openTile(page, "trade");
    await expect(page.getByTestId("features-modal")).toHaveCount(0);
    await openTile(page, "settings");
    await expect(page.getByTestId("open-features")).toBeVisible();
  });

  test("closes on Escape", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("open-features").click();
    await expect(page.getByTestId("features-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("features-modal")).toHaveCount(0);
  });

  test("turning a venue off changes the config, not just the checkbox", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await openTile(page, "settings");
    await page.getByTestId("open-features").click();
    await page.getByTestId("feature-toggle-venue-uniswap-v3").uncheck();
    await page.getByTestId("close-features").click();

    // The modal edits the same object expert mode does; the diff proves it.
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await expect(page.getByTestId("preset-label")).toContainText("customised");
    await expect(page.getByTestId("config-panel")).toBeVisible();
    await openSection(page, "config-panel");
    await page.getByTestId("export-toml").click();
    await expect(page.getByTestId("config-text")).toContainText("venue-uniswap-v3");

    // And it was persisted rather than held in component state. Asserted by
    // reading storage rather than by reloading: `seedConfig` installs an init
    // script, which re-runs on every navigation and would put the original
    // config straight back — the reload would be testing the fixture.
    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("spdex.config.v1") ?? "{}"),
    );
    const v3 = (stored.modules as { id: string; enabled: boolean }[]).find(
      (m) => m.id === "venue-uniswap-v3",
    );
    expect(v3?.enabled).toBe(false);
  });

  test("tips are off until a share is picked, and nobody is chosen by default", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // Nobody is opted into sending a share of their swaps to a stranger: the
    // Tip row on the trade card starts on Off, and the Features switch agrees.
    await expect(page.getByTestId("tip-row")).toBeVisible();
    await expect(page.getByTestId("tip-chips-0")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid^="tip-recipient-pill-"]')).toHaveCount(0);
    await expect(page.getByTestId("tip-picker")).toHaveCount(0);
    await openTile(page, "settings");
    await page.getByTestId("open-features").click();
    await expect(page.getByTestId("feature-toggle-tip-splits")).not.toBeChecked();
    // The dialog no longer holds an editor; it points at where tipping lives.
    await expect(page.getByTestId("feature-tip-splits")).toContainText("Pick who and how much on the Tip row when you swap");
    await openTile(page, "settings");
    await expect(page.getByTestId("tip-recipients")).toHaveCount(0);
    await page.getByTestId("close-features").click();

    // A share with nobody to give it to asks who, straight away.
    await openTile(page, "trade");
    await page.getByTestId("tip-chips-25").click();
    await expect(page.getByTestId("tip-picker")).toBeVisible();
    // On the fork the list is spDEX's donation vault plus placeholders, and the
    // placeholders say so where it cannot be missed.
    await expect(page.getByTestId("tip-placeholder-notice")).toBeVisible();
    await expect(page.getByTestId("tip-placeholder-notice")).toContainText("test addresses, not real people");
    // Still nothing chosen, so still nothing sent.
    await expect(page.getByTestId("tip-row-hint")).toContainText("nothing is sent");
  });

  test("the registry module supplies candidates, with their addresses shown", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("tip-chips-25").click();

    // Loaded by the host from a module that declares no capabilities at all:
    // the dev fixtures, offered because the fork is a local test network.
    await expect(page.getByTestId(`candidate-${PLACEHOLDER}`)).toBeVisible();
    // The address is shown next to the name, checksummed: a registry maps one
    // to the other and is not trusted to be honest about it.
    await expect(page.getByTestId(`candidate-${PLACEHOLDER}`)).toContainText(PLACEHOLDER, { ignoreCase: true });

    // Chosen, the person becomes a pill on the row, and the address — not the
    // name — is what the config holds.
    await page.getByTestId(`tip-add-${PLACEHOLDER}`).click();
    await expect(page.getByTestId(`tip-recipient-pill-${PLACEHOLDER}`)).toBeVisible();
    await expect(page.getByTestId("tip-picker")).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("spdex.config.v1") ?? "{}"));
    expect(stored.tips).toMatchObject({ enabled: true, recipients: [{ address: PLACEHOLDER, bps: 25 }] });

    // Off stops the tipping and keeps the person, as the feature's switch does.
    await page.getByTestId("tip-chips-0").click();
    await expect(page.locator('[data-testid^="tip-recipient-pill-"]')).toHaveCount(0);
    const off = await page.evaluate(() => JSON.parse(window.localStorage.getItem("spdex.config.v1") ?? "{}"));
    expect(off.tips).toMatchObject({ enabled: false, recipients: [{ address: PLACEHOLDER, bps: 25 }] });
  });

  test("refuses to exceed the hard tip ceiling", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("tip-chips-25").click();
    await page.getByTestId(`tip-add-${PLACEHOLDER}`).click();

    // Exact shares are Expert's Tips panel.
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "settings-tips");
    await expect(page.getByTestId("expert-tips")).toBeVisible();

    // 5% is the host's ceiling; 60% is not clamped to it, it is refused, so the
    // number on screen never disagrees with the number in the config.
    await page.getByTestId(`tip-bps-${PLACEHOLDER}`).fill("6000");
    await expect(page.getByTestId("tip-error")).toBeVisible();
    await expect(page.getByTestId(`tip-bps-${PLACEHOLDER}`)).toHaveValue("25");
  });

  test("discloses the tip on the route before anything is signed", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("tip-chips-25").click();
    await page.getByTestId(`tip-add-${PLACEHOLDER}`).click();

    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.05");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });

    // A standing instruction to send a share of every swap is restated on the
    // swap it applies to, as an amount rather than only a percentage.
    await expect(page.getByTestId("tip-preview")).toBeVisible();
    await expect(page.getByTestId("tip-preview-total")).toContainText("0.25%");
    await expect(page.getByTestId("tip-row-hint")).toContainText("of this swap");
    await expect(page.getByTestId("tip-row-hint")).toContainText("1 extra confirmation");

    // The summary card counts the tip's confirmation too: switching tips off
    // takes exactly one away. And the price stays on screen while the share
    // changes, because no quote depends on it.
    // Simple says the count only when it is more than one: no row is once.
    const prompts = async () => {
      await openTile(page, "trade");
      if ((await page.getByTestId("confirm-count").count()) === 0) return 1;
      const text = (await page.getByTestId("confirm-count").textContent()) ?? "";
      return text.includes("once") ? 1 : Number(/up to (\d+)/.exec(text)?.[1]);
    };
    const withTip = await prompts();
    await openTile(page, "trade");
    await page.getByTestId("tip-chips-0").click();
    await expect(page.getByTestId("tip-preview")).toHaveCount(0);
    await expect(page.getByTestId("route-view")).toBeVisible();
    await expect.poll(prompts).toBe(withTip - 1);

    // Back on, the person chosen before is still chosen.
    await page.getByTestId("tip-chips-50").click();
    await expect(page.getByTestId(`tip-recipient-pill-${PLACEHOLDER}`)).toBeVisible();
    await expect(page.getByTestId("tip-preview-total")).toContainText("0.5%");
    await expect.poll(prompts).toBe(withTip);
  });

  test("actually delivers the tip to the address that was chosen", async ({ page, account }) => {
    /*
     * The end-to-end claim, followed with real balances on the fork: a user
     * opts in, picks somebody from a registry module, swaps, and that address
     * is measurably better off afterwards.
     *
     * Asserted as an increase rather than an exact figure — the tip is a share
     * of what the swap *delivered*, which depends on live pool state, and a
     * pinned number would be asserting the price rather than the feature.
     */
    const [recipient] = recipientsFor(account);
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const before = await tokenBalance(SPX, recipient);

    await page.getByTestId("tip-chips-25").click();
    await page.getByTestId(`tip-add-${recipient}`).click();

    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.2");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", {
      timeout: 120_000,
    });
    // The swap reports the tip alongside itself rather than silently.
    await expect(page.getByTestId("swap-status")).toContainText("Tipped", { timeout: 120_000 });

    const after = await tokenBalance(SPX, recipient);
    expect(after).toBeGreaterThan(before);
  });

  test("two people: one signature and one transaction pay both", async ({ page, account }) => {
    /*
     * The batch, followed with real balances: two people chosen, one swap,
     * and afterwards exactly one typed-data signature and one tip transaction
     * (plus, the first time, the standing permission for Permit2, asked for
     * after the signature), and both addresses measurably better off. The
     * account starts without that permission, whatever an earlier run left,
     * so the first-time path is the one taken.
     */
    const [first, second] = recipientsFor(account);
    await revokePermit2(SPX, account);
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const before = { first: await tokenBalance(SPX, first), second: await tokenBalance(SPX, second) };

    await chooseTwo(page, first, second);
    await quoteSwap(page);

    // Said before the swap, in both places, the same way, in the order the
    // wallet asks, and in the safety banner too.
    const firstTime = "1 signature, a standing Permit2 permission, then 1 confirmation";
    await expect(page.getByTestId("tip-row-hint")).toContainText("sent in one transaction");
    await expect(page.getByTestId("tip-row-hint")).toContainText(firstTime);
    await expect(page.getByTestId("confirm-count-tips")).toHaveText(firstTime);
    await expect(page.getByTestId("guard-banner")).toContainText(
      "in one transaction through Permit2, after a signature and a standing permission for Permit2 on SPX",
    );

    const sentBefore = (await sentTransactions(page)).length;
    const promptsBefore = (await walletPrompts(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("Tipped", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("to 2 people in one transaction");

    // In the order the wallet was asked: the signature, which needs no
    // permission and shows the wallet can sign, then the permission, then
    // the batch that uses both.
    expect(tipPromptOrder((await walletPrompts(page)).slice(promptsBefore))).toEqual(["signature", "permission", "batch"]);

    // Exactly one signature, for Permit2's batch, spendable only by this account.
    const typed = await typedSignatures(page);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.primaryType).toBe("PermitBatchTransferFrom");
    expect(typed[0]?.domain?.verifyingContract).toBe(PERMIT2);
    expect(typed[0]?.message?.spender).toBe(account);
    expect(typed[0]?.message?.permitted).toHaveLength(2);

    // After the swap: the standing permission and one batch, and no transfer each.
    const tips = tipTransactions((await sentTransactions(page)).slice(sentBefore));
    expect(tips.permissions).toHaveLength(1);
    expect(tips.batches).toHaveLength(1);
    expect(tips.transfers).toHaveLength(0);
    expect(await permit2Allowance(SPX, account)).toBeGreaterThan(0n);

    expect(await tokenBalance(SPX, first)).toBeGreaterThan(before.first);
    expect(await tokenBalance(SPX, second)).toBeGreaterThan(before.second);

    // The next swap's tips ask for no permission: the row now says so.
    await quoteSwap(page);
    await expect(page.getByTestId("tip-row-hint")).toContainText("1 signature + 1 confirmation");
    await expect(page.getByTestId("tip-row-hint")).not.toContainText("Permit2 permission");
    await expect(page.getByTestId("confirm-count-tips")).toHaveText("1 signature + 1 confirmation");
  });

  test("a declined permission for Permit2 sends two transfers instead, and says so", async ({ page, account }) => {
    // The person says no to Permit2's permission and yes to everything else,
    // the signature before it included.
    const [first, second] = recipientsFor(account);
    await revokePermit2(SPX, account);
    await installWallet(page, { address: account, rejectApprovalsTo: PERMIT2 });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const before = { first: await tokenBalance(SPX, first), second: await tokenBalance(SPX, second) };

    await chooseTwo(page, first, second);
    await quoteSwap(page);

    const sentBefore = (await sentTransactions(page)).length;
    const promptsBefore = (await walletPrompts(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText(
      "in 2 separate transfers: you declined the permission for Permit2",
      { timeout: 120_000 },
    );
    // The signature it gave first goes unused, and the note says what that means.
    await expect(page.getByTestId("swap-status")).toContainText(
      "The signature you gave goes unused and expires within 20 minutes; only a transaction you send could spend it.",
    );

    // Signed, the permission asked once and declined, and each person got a
    // transfer of their own.
    expect(await typedSignatures(page)).toHaveLength(1);
    expect(tipPromptOrder((await walletPrompts(page)).slice(promptsBefore))).toEqual([
      "signature",
      "permission",
      "transfer",
      "transfer",
    ]);
    const tips = tipTransactions((await sentTransactions(page)).slice(sentBefore));
    expect(tips.permissions).toHaveLength(1);
    expect(tips.batches).toHaveLength(0);
    expect(tips.transfers).toHaveLength(2);
    expect(await permit2Allowance(SPX, account)).toBe(0n);

    expect(await tokenBalance(SPX, first)).toBeGreaterThan(before.first);
    expect(await tokenBalance(SPX, second)).toBeGreaterThan(before.second);
  });

  test("a wallet that can't sign typed data sends two transfers instead, and is never asked for the permission", async ({
    page,
    account,
  }) => {
    /*
     * A wallet refusing eth_signTypedData_v4 as unsupported (4200), which is
     * not a person saying no: the tips still go, one transfer each. The
     * signature comes first in the flow, so the wallet shows it can't sign
     * before any standing permission is asked for, and is never asked for
     * one it could not use. For the rest of the session this wallet's tips
     * go as transfers, with no signature asked for again.
     */
    const [first, second] = recipientsFor(account);
    await revokePermit2(SPX, account);
    await installWallet(page, { address: account, refuseSignTypedData: true });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const before = { first: await tokenBalance(SPX, first), second: await tokenBalance(SPX, second) };

    await chooseTwo(page, first, second);
    await quoteSwap(page);

    const sentBefore = (await sentTransactions(page)).length;
    const promptsBefore = (await walletPrompts(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText(
      "in 2 separate transfers: your wallet can't sign one permit for all of them",
      { timeout: 120_000 },
    );
    // No permission was given, so none is said to stay.
    await expect(page.getByTestId("swap-status")).not.toContainText("Permit2 permission you gave");

    // The signature asked once and refused, then a transfer each: never the
    // permission, and never a batch.
    expect(await typedSignatures(page)).toHaveLength(1);
    expect(tipPromptOrder((await walletPrompts(page)).slice(promptsBefore))).toEqual(["signature", "transfer", "transfer"]);
    const tips = tipTransactions((await sentTransactions(page)).slice(sentBefore));
    expect(tips.permissions).toHaveLength(0);
    expect(tips.batches).toHaveLength(0);
    expect(tips.transfers).toHaveLength(2);
    expect(await permit2Allowance(SPX, account)).toBe(0n);

    expect(await tokenBalance(SPX, first)).toBeGreaterThan(before.first);
    expect(await tokenBalance(SPX, second)).toBeGreaterThan(before.second);

    // The next swap knows: a transfer each, said before it, and no signature
    // asked for again.
    await quoteSwap(page);
    await expect(page.getByTestId("tip-row-hint")).toContainText("2 extra confirmations");
    await expect(page.getByTestId("confirm-count-tips")).toHaveCount(0);
    const sentAgain = (await sentTransactions(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("earlier in this session", { timeout: 120_000 });
    expect(await typedSignatures(page)).toHaveLength(1);
    const again = tipTransactions((await sentTransactions(page)).slice(sentAgain));
    expect(again.permissions).toHaveLength(0);
    expect(again.batches).toHaveLength(0);
    expect(again.transfers).toHaveLength(2);
  });

  test("Expert → Tips shows the standing permission, and Revoke takes it back", async ({ page, account }) => {
    // Given the way the first batched tip gives it: approve(Permit2, max).
    await grantPermit2(SPX, account);
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "settings-tips");
    await expect(page.getByTestId("permit2-allowance-SPX")).toHaveText("unlimited", { timeout: 30_000 });

    const sentBefore = (await sentTransactions(page)).length;
    await page.getByTestId("permit2-revoke-SPX").click();
    await expect(page.getByTestId("permit2-note")).toContainText("Revoked: Permit2 can no longer move your SPX", {
      timeout: 60_000,
    });
    // Read again from the chain, not assumed.
    await expect(page.getByTestId("permit2-allowance-SPX")).toHaveText("none", { timeout: 30_000 });
    await expect(page.getByTestId("permit2-revoke-SPX")).toHaveCount(0);
    expect(await permit2Allowance(SPX, account)).toBe(0n);

    // One transaction, and it was exactly approve(Permit2, 0) on SPX.
    const sent = (await sentTransactions(page)).slice(sentBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to?.toLowerCase()).toBe(SPX);
    expect(sent[0]?.data?.toLowerCase()).toBe(`0x095ea7b3${PERMIT2.slice(2).padStart(64, "0")}${"0".repeat(64)}`);
  });

  test("sending privately, the batch and its permission go the same way", async ({ page, account }) => {
    /*
     * The batch is the user's own transaction, so it takes whichever way the
     * user chose to send: here, signed by the wallet without broadcasting and
     * posted to a relay. The relay is the fork itself, as in expert.spec's
     * private swap: the mechanism, honestly, without pretending to be a real
     * relay.
     */
    const [first, second] = recipientsFor(account);
    await revokePermit2(SPX, account);
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    await page.goto("/");
    await openTile(page, "trade");

    const before = { first: await tokenBalance(SPX, first), second: await tokenBalance(SPX, second) };

    await chooseTwo(page, first, second);
    await quoteSwap(page);

    const signedBefore = (await signedTransactions(page)).length;
    const sentBefore = (await sentTransactions(page)).length;
    const promptsBefore = (await walletPrompts(page)).length;
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("submitted privately", { timeout: 120_000 });
    await expect(page.getByTestId("swap-status")).toContainText("to 2 people in one transaction", { timeout: 120_000 });
    await expect(page.getByTestId("fallback-prompt")).toBeHidden();
    // The same order as sent publicly: the signature, the permission, the batch.
    expect(tipPromptOrder((await walletPrompts(page)).slice(promptsBefore))).toEqual(["signature", "permission", "batch"]);

    // Signed, not broadcast by the wallet: the permission and the batch.
    const signed = tipTransactions((await signedTransactions(page)).slice(signedBefore));
    expect(signed.permissions).toHaveLength(1);
    expect(signed.batches).toHaveLength(1);
    expect(signed.transfers).toHaveLength(0);
    expect((await sentTransactions(page)).slice(sentBefore)).toHaveLength(0);
    expect(await typedSignatures(page)).toHaveLength(1);

    expect(await tokenBalance(SPX, first)).toBeGreaterThan(before.first);
    expect(await tokenBalance(SPX, second)).toBeGreaterThan(before.second);
  });
});

/** Tip 0.5% to two people from the registry, through the Tip row. */
async function chooseTwo(page: Page, first: string, second: string): Promise<void> {
  await openTile(page, "trade");
  await page.getByTestId("tip-chips-50").click();
  await page.getByTestId(`tip-add-${first}`).click();
  await page.getByTestId("tip-pick").click();
  await page.getByTestId(`tip-add-${second}`).click();
  await expect(page.getByTestId(`tip-recipient-pill-${first}`)).toBeVisible();
  await expect(page.getByTestId(`tip-recipient-pill-${second}`)).toBeVisible();
}

/** Connect if not yet connected, and price 0.2 WETH for SPX. */
async function quoteSwap(page: Page): Promise<void> {
  const connect = page.getByTestId("connect-button");
  await openTile(page, "trade");
  if (await connect.isVisible()) await connect.click();
  await openTile(page, "trade");
  await page.getByTestId("amount-input").fill("0.2");
  await page.getByTestId("quote-button").click();
  await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
}
