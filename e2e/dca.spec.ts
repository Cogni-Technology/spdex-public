/**
 * Auto-buy: standing orders that spend on a schedule, followed with real money
 * on the fork.
 *
 * The claim is that a plan does what it says and nothing it doesn't. A plan
 * whose owner confirms each buy ("Confirm each buy myself") buys when it is
 * started and after that only when its owner confirms — the wallet never opens
 * on a timer. Every path that should stop spending — a decline, a plan that
 * came from someone else's link, a pause — does, across exactly the passage of
 * time that would otherwise have made it buy. The other way a plan runs, a
 * vault that buys with nobody there, is vault.spec.ts's.
 *
 * Time is the page's, never the chain's. The page clock is installed at real
 * now before the app loads and only ever moved forward, and only while the app
 * is idle on the network. Swap deadlines are set from the page clock and
 * enforced by the fork's, which already lags wall time by days, so a page that
 * runs ahead keeps every deadline valid; but receipts are polled on the page's
 * timers, so a jump mid-buy would report a false timeout. anvil's clock is never
 * touched: it is shared by every spec and every later run.
 *
 * Money is counted in two places that can't be confused: what the page asked
 * the wallet for (`window.ethereum._sent` and `_signed`, which the headless
 * wallet records before relaying) and what the chain holds afterwards. Amounts
 * are asserted as relationships — "rose", "exactly one transaction of exactly
 * the buy", "everything that left arrived" — never as prices.
 *
 * Every buy sells ETH for SPX: it needs no permission step, so each buy is one
 * wallet transaction and "exactly one" means something.
 */

import type { Locator, Page } from "@playwright/test";
import { addDcaPlan, recommendedConfig, shareFragment } from "../packages/config/src/index.js";
import {
  test,
  expect,
  FORK_CHAIN_ID,
  FORK_URL,
  forkRpc,
  installWallet,
  NATIVE_ETH,
  runnerLooks,
  seedConfig,
  sentTransactions,
  signedTransactions,
  SPX,
  tokenBalance,
  watchRpc,
  openSection,
  openTile,
} from "./fixtures.js";

/** 0.001 ETH: each buy, small enough that a reused account never notices. */
const BUY = 10n ** 15n;
const DAY = "24:00:00";
/** A real buy is a quote, a simulation, a transaction and its receipt on a forked mainnet. */
const BUY_TIMEOUT = 120_000;

/** The one plan card on the page. Plan ids are random, so it is found by its prefix. */
function planCard(page: Page): Locator {
  return page.locator('[data-testid^="dca-plan-"]');
}

/** A card's history entries of one kind ("bought", "declined", "skipped-by-user", …). */
function history(card: Locator, kind: string): Locator {
  return card.locator(`[data-testid^="dca-run-"][data-kind="${kind}"]`);
}

/**
 * Connect, open Recurring, and fill in 0.001 ETH → SPX, every day, three
 * times, confirmed in the wallet: the form's default of its two choices.
 */
async function fillPlan(page: Page): Promise<Locator> {
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await page.getByTestId("buy-mode-recurring").click();
  // The newcomer defaults this spec relies on: pay with ETH, buy SPX, every
  // day, and confirm each buy in the wallet.
  await expect(page.getByTestId("dca-form-sell")).toHaveValue("ETH");
  await expect(page.getByTestId("dca-form-buy")).toHaveValue("SPX");
  await expect(page.getByTestId("dca-form-frequency")).toHaveValue("1d");
  await expect(page.getByTestId("dca-form-signer-wallet").getByRole("radio")).toBeChecked();
  await page.getByTestId("dca-form-amount").fill("0.001");
  await page.getByTestId("dca-form-count").fill("3");
  await expect(page.getByTestId("dca-form-summary")).toContainText("Buy SPX with 0.001 ETH every day, 3 times");
  const start = page.getByTestId("dca-form-start");
  // Start waits for the network service's safety test: a plan that could
  // never pass the check is not started.
  await expect(start).toBeEnabled({ timeout: 30_000 });
  return start;
}

/** The one transaction `from` sent since block `since`, found on the chain: the page shows no hash for it. */
async function sentSince(from: string, since: bigint): Promise<string> {
  const head = BigInt((await forkRpc("eth_blockNumber", [])) as string);
  const found: string[] = [];
  for (let n = since + 1n; n <= head; n++) {
    const block = (await forkRpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, true])) as { transactions: { from: string; hash: string }[] };
    for (const tx of block.transactions) if (tx.from.toLowerCase() === from.toLowerCase()) found.push(tx.hash);
  }
  expect(found, `transactions from ${from} since block ${since}`).toHaveLength(1);
  return found[0]!;
}

test.describe("auto-buy", () => {
  test("a wallet plan buys when started, then only when its owner confirms", async ({ page, account }) => {
    /*
     * The wallet never opens on a timer, end to end. The Start click is the
     * first confirmation, so the first buy is made at once. After that a buy
     * falling due is shown and waited on:
     * a day passes, the card says a buy is due, and the wallet is not asked —
     * not then, and not on the next look either. Confirming makes the buy;
     * skipping uses up the buy time and sends nothing.
     */
    await page.clock.install();
    await installWallet(page, { address: account });
    await seedConfig(page);
    const network = watchRpc(page);
    await page.goto("/");
    await openTile(page, "trade");

    const start = await fillPlan(page);
    await expect(start).toHaveText("Start auto-buy — first buy now");
    const spx0 = await tokenBalance(SPX, account);
    const sent0 = (await sentTransactions(page)).length;
    await start.click();

    const card = planCard(page);
    // The Auto-buys tile appears with the plan: open it once the card exists.
    await expect(card).toHaveCount(1);
    await openTile(page, "auto-buys");
    await card.getByTestId("dca-history-summary").click();
    await expect(history(card, "bought")).toHaveCount(1, { timeout: BUY_TIMEOUT });

    // Exactly one wallet transaction, spending exactly one buy's worth.
    const afterFirst = await sentTransactions(page);
    expect(afterFirst).toHaveLength(sent0 + 1);
    expect(BigInt(afterFirst.at(-1)!.value ?? "0x0")).toBe(BUY);
    const spx1 = await tokenBalance(SPX, account);
    expect(spx1).toBeGreaterThan(spx0);
    await expect(card.getByTestId("dca-progress")).toContainText("1 of 3 buys");
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "running");
    // The manual swap's status line is the One-time tab's; an auto-buy never writes to it.
    await openTile(page, "trade");
    await expect(page.getByTestId("swap-status")).toHaveCount(0);

    // A day later the second buy is due, and it waits.
    await network.quiet();
    await page.clock.fastForward(DAY);
    const due = card.getByTestId("dca-due");
    await openTile(page, "auto-buys");
    await expect(due).toContainText("Buy 2 is due", { timeout: 60_000 });
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "action");
    await expect(page).toHaveTitle(/^● Buy due — /);
    await runnerLooks(page);
    expect(await sentTransactions(page)).toHaveLength(sent0 + 1);
    expect(await tokenBalance(SPX, account)).toBe(spx1);
    await expect(due).toBeVisible();

    // Confirming is what makes it.
    await due.getByTestId("dca-confirm-buy").click();
    await expect(history(card, "bought")).toHaveCount(2, { timeout: BUY_TIMEOUT });
    const afterSecond = await sentTransactions(page);
    expect(afterSecond).toHaveLength(sent0 + 2);
    expect(BigInt(afterSecond.at(-1)!.value ?? "0x0")).toBe(BUY);
    const spx2 = await tokenBalance(SPX, account);
    expect(spx2).toBeGreaterThan(spx1);
    await expect(card.getByTestId("dca-due")).toHaveCount(0);
    await expect(card.getByTestId("dca-progress")).toContainText("2 of 3 buys");

    // Another day: the third is due, and skipping it records a skip, sends
    // nothing, and uses the buy time up rather than asking again.
    await network.quiet();
    await page.clock.fastForward(DAY);
    await expect(card.getByTestId("dca-due")).toContainText("Buy 3 is due", { timeout: 60_000 });
    await card.getByTestId("dca-skip-buy").click();
    await expect(history(card, "skipped-by-user")).toHaveCount(1);
    await runnerLooks(page);
    await expect(card.getByTestId("dca-due")).toHaveCount(0);
    expect(await sentTransactions(page)).toHaveLength(sent0 + 2);
    expect(await tokenBalance(SPX, account)).toBe(spx2);
    // A skipped buy time is not a buy: the plan still has one to make.
    await expect(card.getByTestId("dca-progress")).toContainText("2 of 3 buys");
    await expect(history(card, "bought")).toHaveCount(2);
  });

  test("a reset that would remove plans asks first: cancel keeps them, confirm removes them, nothing is sent", async ({
    page,
    account,
  }) => {
    /*
     * Plans are part of the config, so "Reset to recommended" would delete
     * them with every other setting. It asks where the plans are, and does
     * nothing until answered: no is no, and yes removes the plan and moves no
     * money.
     */
    const withPlan = addDcaPlan(
      { ...recommendedConfig(), chainId: FORK_CHAIN_ID, rpc: { url: FORK_URL, source: "user" as const } },
      {
        id: "kept-until-asked",
        paused: true,
        chainId: FORK_CHAIN_ID,
        sell: NATIVE_ETH,
        buy: SPX,
        amountPerBuy: BUY.toString(),
        intervalSeconds: 86_400,
        maxBuys: 3,
        startAt: Math.floor(Date.now() / 1000),
        signer: "wallet",
      },
    );
    if (!withPlan.ok) throw new Error(withPlan.error);
    await installWallet(page, { address: account });
    await seedConfig(page, { dca: withPlan.config.dca, modules: withPlan.config.modules, preset: "custom" });
    await page.goto("/");
    await openTile(page, "trade");

    const card = page.getByTestId("dca-plan-kept-until-asked");
    await openTile(page, "auto-buys");
    await expect(card).toBeVisible();
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "config-panel");

    await page.getByTestId("reset-config").click();
    const ask = page.getByTestId("dca-remove-plans");
    await openTile(page, "auto-buys");
    await expect(ask).toContainText("This removes 1 auto-buy.");
    await page.getByTestId("dca-remove-plans-cancel").click();
    await expect(ask).toHaveCount(0);
    await expect(card).toBeVisible();

    await openTile(page, "settings");
    await page.getByTestId("reset-config").click();
    await openTile(page, "auto-buys");
    await page.getByTestId("dca-remove-plans-confirm").click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("dca-panel")).toHaveCount(0);
    expect(await sentTransactions(page)).toHaveLength(0);
    expect(await signedTransactions(page)).toHaveLength(0);
  });

  test("a buy declined in the wallet is recorded as declined and not counted, and stays due", async ({ page, account }) => {
    /*
     * A decline is the owner's answer, not a failure. The history says what
     * happened in those words, and the plan's count and budget are untouched:
     * a plan that counted a buy nobody made would end one buy early. Nothing
     * was sent, so the buy time isn't used up either: the buy is still due,
     * for the owner to confirm after all or skip, and the wallet isn't asked
     * again by itself. The form's banner says so instead of still asking for
     * the confirmation that was just refused.
     */
    await installWallet(page, { address: account, rejectTransactions: true });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const start = await fillPlan(page);
    const spx0 = await tokenBalance(SPX, account);
    await start.click();
    await expect(page.getByTestId("dca-form-started")).toContainText(
      "You declined the first buy in your wallet. It's still due: confirm it or skip it in Auto-buys.",
      { timeout: BUY_TIMEOUT },
    );

    const card = planCard(page);
    await expect(card).toHaveCount(1);
    await openTile(page, "auto-buys");
    await card.getByTestId("dca-history-summary").click();
    await expect(history(card, "declined")).toHaveCount(1, { timeout: BUY_TIMEOUT });
    await expect(history(card, "declined")).toContainText("Declined in your wallet");
    await expect(history(card, "bought")).toHaveCount(0);
    await expect(card.getByTestId("dca-progress")).toContainText("0 of 3 buys");
    await expect(card.getByTestId("dca-bought")).toHaveText("none yet");
    // Still due, with its Confirm and its Skip, and nothing asked by itself.
    const due = card.getByTestId("dca-due");
    await expect(due).toContainText("Buy 1 is due", { timeout: 60_000 });
    await expect(due.getByTestId("dca-confirm-buy")).toBeVisible();
    await expect(due.getByTestId("dca-skip-buy")).toBeVisible();
    await runnerLooks(page);
    // Asked once — the Start click — and told no.
    expect(await sentTransactions(page)).toHaveLength(1);
    expect(await tokenBalance(SPX, account)).toBe(spx0);
  });

  test("an amount that isn't a number keeps Start off, and says why beside it", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await fillPlan(page);
    await page.getByTestId("dca-form-amount").fill("abc");
    await expect(page.getByTestId("dca-form-start")).toBeDisabled();
    await expect(page.getByTestId("dca-form-blocked")).toHaveText("Type a number, like 0.5.");
  });

  test("a deleted plan's buys stay in Your activity and Your stack", async ({ page, account }) => {
    /*
     * Deleting a plan deletes this browser's record of it, and that record
     * was where its buys were listed from. They are kept with the swaps and
     * tips first, so the history someone needs at tax time doesn't go with
     * a plan they have stopped.
     */
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const start = await fillPlan(page);
    await start.click();
    const card = planCard(page);
    await expect(card).toHaveCount(1);
    await openTile(page, "auto-buys");
    await card.getByTestId("dca-history-summary").click();
    await expect(history(card, "bought")).toHaveCount(1, { timeout: BUY_TIMEOUT });

    const bought = page.locator('[data-testid="activity-row"][data-kind="plan-buy"]');
    await openTile(page, "yours");
    await expect(bought).toHaveCount(1, { timeout: 60_000 });
    const hash = await bought.getAttribute("data-hash");
    const got = /Bought [\d,.]+ SPX/.exec((await bought.textContent()) ?? "")![0];

    await openTile(page, "auto-buys");
    await card.getByTestId("dca-delete").click();
    await card.getByTestId("dca-delete-confirm").click();
    await expect(card).toHaveCount(0);

    await openTile(page, "yours");
    await expect(bought).toHaveCount(1, { timeout: 60_000 });
    await expect(bought).toHaveAttribute("data-hash", hash!);
    await expect(bought).toContainText(got);
    await expect(bought).toContainText("for 0.001 ETH");
    await expect(page.getByTestId("activity-panel")).not.toContainText("no longer in your settings");
    await expect(page.getByTestId("stack-card")).toContainText("1 plan buy");
  });

  test("a plan in a shared link arrives paused and stays paused as time passes", async ({ page, account }) => {
    /*
     * A link that started spending the moment it was opened would be a way to
     * spend a stranger's money. So the link here is the hostile case: it
     * carries a plan that is *not* paused and whose buy time has long come.
     * It is staged like any shared config, the summary says plainly that the
     * plan arrives paused, and once applied it buys nothing — through a whole
     * day of looks. Then, as the control, resuming it shows the from-outside
     * warning and makes its buy due at once: the plan was live, and the pause
     * was the only thing holding it.
     */
    const theirs = addDcaPlan(
      { ...recommendedConfig(), chainId: FORK_CHAIN_ID, rpc: { url: FORK_URL, source: "user" as const } },
      {
        id: "from-a-link",
        paused: false,
        chainId: FORK_CHAIN_ID,
        sell: NATIVE_ETH,
        buy: SPX,
        amountPerBuy: BUY.toString(),
        intervalSeconds: 86_400,
        maxBuys: 3,
        startAt: Math.floor(Date.now() / 1000) - 3 * 86_400,
        signer: "wallet",
      },
    );
    if (!theirs.ok) throw new Error(theirs.error);
    expect(theirs.config.dca.plans[0]!.paused).toBe(false);

    await page.clock.install();
    await installWallet(page, { address: account });
    await seedConfig(page);
    const network = watchRpc(page);
    await page.goto(`/#config=${shareFragment(theirs.config)}`);
    await openTile(page, "trade");

    await expect(page.getByTestId("staged-config")).toBeVisible();
    await expect(page.getByTestId("staged-summary")).toContainText("Adds 1 auto-buy. They arrive paused");
    await page.getByTestId("accept-staged").click();
    await expect(page.getByTestId("staged-config")).toBeHidden();
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));

    const card = page.getByTestId("dca-plan-from-a-link");
    await openTile(page, "auto-buys");
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "paused");
    await expect(card.getByTestId("dca-status")).toHaveText("Paused. Nothing will be bought until you resume.");
    const spx0 = await tokenBalance(SPX, account);

    await network.quiet();
    await page.clock.fastForward(DAY);
    await runnerLooks(page);
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "paused");
    await expect(card.getByTestId("dca-due")).toHaveCount(0);
    expect(await sentTransactions(page)).toHaveLength(0);
    expect(await tokenBalance(SPX, account)).toBe(spx0);

    await card.getByTestId("dca-resume").click();
    await expect(card.getByTestId("dca-resume-foreign")).toContainText("It arrived paused from a link or a file.");
    await expect(card.getByTestId("dca-resume-terms")).toContainText("Next buy: now — confirm it on this card.");
    await card.getByTestId("dca-resume-confirm").click();
    await expect(card.getByTestId("dca-due")).toContainText("Buy 1 is due", { timeout: 60_000 });
    // Even resumed, a wallet plan waits for its owner's click.
    expect(await sentTransactions(page)).toHaveLength(0);
  });

  test("pausing a plan stops it asking however much time passes", async ({ page, account }) => {
    /*
     * A paused plan must stay quiet through exactly the time that would
     * otherwise have made a buy due. After the first buy it is paused and a
     * day passes — a day in which it would have asked for the second — and
     * nothing moves: no buy due, no new history at all, no wallet request, no
     * SPX. Resuming is the control: the day did open a buy time, and the plan
     * shows it due at once — and still waits for its owner's click.
     */
    await page.clock.install();
    await installWallet(page, { address: account });
    await seedConfig(page);
    const network = watchRpc(page);
    await page.goto("/");
    await openTile(page, "trade");

    const start = await fillPlan(page);
    const sent0 = (await sentTransactions(page)).length;
    await start.click();
    const card = planCard(page);
    await expect(card).toHaveCount(1);
    await openTile(page, "auto-buys");
    await card.getByTestId("dca-history-summary").click();
    await expect(history(card, "bought")).toHaveCount(1, { timeout: BUY_TIMEOUT });
    expect(await sentTransactions(page)).toHaveLength(sent0 + 1);

    await card.getByTestId("dca-pause").click();
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "paused");
    const entries = await card.locator('[data-testid^="dca-run-"]').count();
    await network.quiet();
    const spx1 = await tokenBalance(SPX, account);

    await page.clock.fastForward(DAY);
    await runnerLooks(page);
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "paused");
    await expect(card.getByTestId("dca-due")).toHaveCount(0);
    await expect(card.locator('[data-testid^="dca-run-"]')).toHaveCount(entries);
    await expect(history(card, "bought")).toHaveCount(1);
    expect(await sentTransactions(page)).toHaveLength(sent0 + 1);
    expect(await tokenBalance(SPX, account)).toBe(spx1);

    await card.getByTestId("dca-resume").click();
    await expect(card.getByTestId("dca-resume-terms")).toContainText("Next buy: now — confirm it on this card.");
    await card.getByTestId("dca-resume-confirm").click();
    await expect(card.getByTestId("dca-due")).toContainText("Buy 2 is due", { timeout: 60_000 });
    await runnerLooks(page);
    expect(await sentTransactions(page)).toHaveLength(sent0 + 1);
    expect(await tokenBalance(SPX, account)).toBe(spx1);
  });
});
