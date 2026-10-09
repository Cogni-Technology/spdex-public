/**
 * Help run the network: a tab makes other people's due vault buys, in one
 * transaction from its own wallet, sent privately, and is paid their buy fees.
 *
 * ## Only this spec's own vaults
 *
 * The fork is shared, and other vaults on it belong to other runs and other
 * specs; no spec triggers or closes a vault it didn't create. So an owner
 * made here from a fresh key creates the vaults the spec needs, all due at
 * once, and the spec unticks every other vault the panel lists before
 * anything is sent. Each helper is another fresh key, so the buy fees it is
 * paid are measured to the wei with nobody else's transactions in the way.
 *
 * ## Holders first
 *
 * For the first minutes after a v2 buy falls due, its community window, the
 * vault pays only an SPX holder the registry vouches for (or its own owner).
 * So the owner's vaults are of two kinds: one still inside its window, and
 * two whose window closed minutes ago (started in the past, which the factory
 * allows, so nothing waits one out and nothing moves a clock), one whose buy
 * fee covers the network fee and one whose tiny fee can't. A fresh wallet
 * holds no SPX: it is told who has first claim and until when, and how far it
 * is from the bar, and is offered only the buys past their window. A wallet
 * that is a community keeper is offered the buy inside its window too. It is
 * a fresh key that bought its SPX with a real swap on the fork and was then
 * written eligible in the registry, the one write a test may make there
 * (AGENTS.md, packages/testing/src/vaultFork.ts): anvil can't prove its own
 * blocks, and a real holder's key isn't ours to sign with. Help run offers
 * v2's buys only, so a due v1 vault the owner also made is never listed.
 *
 * ## Private sending on the fork
 *
 * As in the expert spec's private swap, the relay is the fork itself: the
 * page asks the wallet to sign without broadcasting (`eth_signTransaction`,
 * signed here with the helper's key, e2e/vaults.ts) and posts the bytes to
 * the relay. That tests the mechanism honestly without pretending to have
 * tested Flashbots; the Guard's side of it — the batch goes to the factory's
 * batcher, pays this wallet and nobody else, and is never sent unchecked —
 * is packages/guard's red-team and fork tests.
 */

import type { Page } from "@playwright/test";
import { CURRENT_SOURCE, DEFAULT_TURN_BUCKETS, decodeVaultEvent, joinBatchLogs, readDueCandidates, readPlatform, termsProblems, type VaultPlan } from "../packages/vault/src/index.js";
import { makeEligibleSigner } from "../packages/testing/src/vaultFork.js";
import { FORK_CHAIN_ID, FORK_URL, SPX, WETH, expect, forkRpc, seedConfig, test, tokenBalance, openTile } from "./fixtures.js";
import {
  BATCHER,
  ETHER,
  chainNow,
  closeLeftoverVaults,
  createV1VaultAs,
  createVaultAs,
  ensureContracts,
  expectClockWithin,
  freshAccount,
  keyWallet,
  receiptOf,
  vaultOnChain,
  type Account,
  type KeyWallet,
} from "./vaults.js";

type Hex = `0x${string}`;

/** A covered vault's buy: 0.2 ETH, the size at which the most a buy fee can be pays for a lone batch at the fork's 1 gwei. */
const COVERED_BUY = 2n * 10n ** 17n;
/** Its buy fee: 0.69% of the buy, the contract's limit. 0.00138 ETH pays for about 1.38 million gas at 1 gwei. */
const REWARD = (COVERED_BUY * 69n) / 10_000n;
/** The in-window vault's community window: a quarter of its hour, the most it may be, and room for the whole spec. */
const WINDOW = 900n;
/** How long ago the past-window vaults' buys fell due: their 60-second windows closed long since, their hour's slot hasn't. */
const DUE_FOR = 600n;

test.describe.configure({ mode: "serial" });

let owner: Account;
/** Due, inside its community window: SPX holders only (and its owner). */
let inWindow: Hex;
/** Due, its window over: anyone's, its fee covering a lone batch's network fee. */
let covered: Hex;
/** Due, its window over, and its fee too small to cover anything. */
let uncovered: Hex;
/** v1's, due: a keeper's or anyone's, never Help run's. */
let v1Due: Hex;

test.beforeAll(async () => {
  await ensureContracts();
  owner = await freshAccount(ETHER, { owner: true });
  // The fork's time as the creations' blocks will carry it, not the idle head's.
  const now = await chainNow();
  const checked = (plan: VaultPlan): VaultPlan => {
    const problems = termsProblems(plan, now);
    if (problems.length > 0) throw new Error(`the spec's own vault plan is refused: ${problems.join(", ")}`);
    return plan;
  };
  // Hourly, one buy each: nothing is left to buy once it is made.
  const base = { marketIndex: 0n, interval: 3_600n, maxBuys: 1n, maxSlippageBps: 300n };
  const turns = { turnBuckets: DEFAULT_TURN_BUCKETS };
  inWindow = await createVaultAs(owner, checked({ ...base, ...turns, startAt: now, communityWindow: WINDOW, amountPerBuy: COVERED_BUY, keeperReward: REWARD }));
  const past = { ...base, ...turns, startAt: now - DUE_FOR, communityWindow: 60n };
  covered = await createVaultAs(owner, checked({ ...past, amountPerBuy: COVERED_BUY, keeperReward: REWARD }));
  // A buy fee of a millionth of an ether pays for about a thousand gas: never enough.
  uncovered = await createVaultAs(owner, checked({ ...past, amountPerBuy: 10n ** 15n, keeperReward: 10n ** 12n }));
  v1Due = await createV1VaultAs(owner, { ...base, startAt: now - DUE_FOR, amountPerBuy: COVERED_BUY, keeperReward: REWARD });

  // As the vaults themselves say it, at the block that made the last of them.
  const [a, b, c, d] = await Promise.all([inWindow, covered, uncovered, v1Due].map(vaultOnChain));
  expect(a!.status).toMatchObject({ due: true, dueSince: now });
  expect(a!.chainTime! < a!.status.windowEndsAt!, "the first vault's buy is inside its community window").toBe(true);
  for (const past of [b!, c!]) {
    expect(past.status).toMatchObject({ due: true, dueSince: now - DUE_FOR, windowEndsAt: now - DUE_FOR + 60n });
    expect(past.chainTime! >= past.status.windowEndsAt!, "the other two vaults' buys are past their community window").toBe(true);
  }
  expect(d).toMatchObject({ release: "v1", status: { due: true } });
});

test.afterAll(async () => {
  // Every one of the owner's vaults, bought or not, v1's included: nothing funded is left behind.
  await closeLeftoverVaults();
});

/** Connect, and open Help run the network, a panel folded to its title at the foot of the page. */
async function openHelpRun(page: Page) {
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await openTile(page, "community");
  await expect(page.getByTestId("help-run")).toBeVisible({ timeout: 60_000 });
}

/**
 * Tick exactly the vaults in `keep`, one checkbox at a time, and return once
 * the panel has checked the batch that leaves.
 *
 * Every change asks again which of the ticked vaults pay for themselves, and
 * the list is drawn anew when the answer comes; so each box is changed only
 * after the last change's list has gone and the new one is up.
 */
async function tickOnly(page: Page, keep: ReadonlySet<string>): Promise<void> {
  const list = page.getByTestId("help-run-vaults");
  for (let round = 0; round < 60; round++) {
    await openTile(page, "community");
    await expect(list).toBeVisible({ timeout: 120_000 });
    const boxes = await page
      .locator('[data-testid^="help-run-vault-"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({ id: element.getAttribute("data-testid")!, checked: (element as HTMLInputElement).checked })),
      );
    const wanted = (box: { id: string }) => keep.has(box.id.slice("help-run-vault-".length));
    // Unticking first: a vault ticked beside one that pays better can be
    // left out of the batch again by the check, which never plans a loss.
    const wrong = boxes.find((box) => box.checked && !wanted(box)) ?? boxes.find((box) => !box.checked && wanted(box));
    if (wrong === undefined) return;
    await openTile(page, "community");
    if (!(await list.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await page.getByTestId("help-run-vaults-summary").click();
    }
    const box = page.getByTestId(wrong.id);
    const handle = await box.elementHandle();
    await box.click();
    // The list this box was in goes while the batch is checked again.
    await handle!.waitForElementState("hidden", { timeout: 60_000 });
    await openTile(page, "community");
    await expect(page.getByTestId("help-run-checking")).toBeHidden({ timeout: 120_000 });
  }
  throw new Error("the ticks never settled on this spec's own vaults");
}

/**
 * Tick only `vault`, make its buy from the page and check what happened, from
 * the page and from the chain: one transaction, signed for private sending and
 * never handed to the wallet to broadcast, to the batcher, carrying no ether,
 * at the gas limit and price the Guard checked; that vault bought, paying its
 * fee to `helper` straight from the vault, and nothing else tried. Returns
 * the transaction's hash and its block's time.
 */
async function makeOneBuy(page: Page, wallet: KeyWallet, helper: Account, vault: Hex): Promise<{ hash: Hex; at: bigint }> {
  const { terms, status } = await vaultOnChain(vault);
  await tickOnly(page, new Set([vault]));
  const send = page.getByTestId("help-run-send");
  await expect(send).toHaveText("Make 1 buy for this vault", { timeout: 120_000 });
  await expect(page.getByTestId("help-run-intro")).toContainText("1 vault buy is due right now.");
  await expect(page.getByTestId("help-run-get")).toContainText("WETH in buy fees");
  await expect(page.getByTestId("help-run-pay")).toContainText("ETH network fee");
  await expect(page.getByTestId("help-run-wallet-fee")).toContainText("Your wallet will show a maximum network fee of up to");
  await expect(page.getByTestId("help-run-terms")).toContainText("you choose only when, and its fee is paid to you.");
  const ticked = await page
    .locator('[data-testid^="help-run-vault-"]:checked')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  expect(ticked).toEqual([`help-run-vault-${vault}`]);

  const wethBefore = await tokenBalance(WETH, helper.address);
  const spxBefore = await tokenBalance(SPX, owner.address);
  await send.click();
  await expect(page.getByTestId("help-run-result-text")).toContainText("Made 1 of 1 buy.", { timeout: 120_000 });
  await expect(page.getByTestId("help-run-result-text")).toContainText("You received 0.00138 WETH in buy fees.");

  // Signed once, privately, and never handed to the wallet to broadcast.
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.hashes).toHaveLength(0);
  const [signed] = wallet.signed;
  const tx = (await forkRpc("eth_getTransactionByHash", [signed!.hash])) as { from: string; to: string; value: string; gas: string; gasPrice: string };
  expect(tx.from.toLowerCase()).toBe(helper.address);
  expect(tx.to.toLowerCase()).toBe(BATCHER);
  expect(BigInt(tx.value)).toBe(0n);
  // At exactly the gas limit and price the Guard checked it at.
  expect(BigInt(tx.gas)).toBe(signed!.gas);
  expect(BigInt(tx.gasPrice)).toBe(signed!.gasPrice);

  // What it did, from the chain: this one vault bought, and nothing else was tried.
  const receipt = await receiptOf(signed!.hash);
  const runs = joinBatchLogs(receipt.logs, (address) => address === BATCHER);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.triggered.map((t) => t.event.vault)).toEqual([vault]);
  expect(runs[0]!.notTriggered).toEqual([]);
  expect(runs[0]!.batch).toMatchObject({ source: CURRENT_SOURCE, caller: helper.address, rewardTo: helper.address, bought: 1n, earned: REWARD });
  // The vault paid the helper itself, to the wei, for the buy due since the
  // vault's start; the owner gets the SPX.
  const bought = receipt.logs.map(decodeVaultEvent).filter((event) => event?.name === "Bought" && event.emitter === vault);
  expect(bought).toEqual([
    expect.objectContaining({ source: CURRENT_SOURCE, keeper: BATCHER, rewardTo: helper.address, reward: terms.keeperReward, dueSince: status.dueSince }),
  ]);
  expect((await tokenBalance(WETH, helper.address)) - wethBefore).toBe(REWARD);
  expect(await tokenBalance(WETH, BATCHER)).toBe(0n);
  expect(await tokenBalance(SPX, owner.address)).toBeGreaterThan(spxBefore);
  expect((await vaultOnChain(vault)).buysDone).toBe(1n);
  const block = (await forkRpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };

  await expect(page.getByTestId("help-run-finality")).toHaveAttribute("data-state", /included|final/, { timeout: 60_000 });
  return { hash: signed!.hash, at: BigInt(block.timestamp) };
}

test.describe("help run the network", () => {
  test("with public sending it says why not, and offers nothing", async ({ page, context }) => {
    const helper = await freshAccount(ETHER / 20n);
    await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "wallet", url: null } });
    await openHelpRun(page);
    await expect(page.getByTestId("help-run-public")).toHaveText(
      "Needs private sending: sent publicly, bots take these fees first — yours fails and still pays its network fee.",
    );
    await expect(page.getByTestId("help-run-check")).toHaveCount(0);
  });

  test("a wallet that holds no SPX is told who has first claim and until when, and makes only a buy past its window", async ({
    page,
    context,
  }) => {
    const helper = await freshAccount(ETHER / 20n);
    const wallet = await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    await openHelpRun(page);

    await page.getByTestId("help-run-check").click();
    await expect(page.getByTestId("help-run-vaults")).toBeVisible({ timeout: 120_000 });
    // The two past their window are listed as due; the one inside it is not
    // offered to this wallet at all, and v1's never is.
    await expect(page.getByTestId(`help-run-vault-${covered}`)).toHaveCount(1);
    await expect(page.getByTestId(`help-run-vault-${uncovered}`)).toHaveCount(1);
    await expect(page.getByTestId(`help-run-vault-${inWindow}`)).toHaveCount(0);
    await expect(page.getByTestId(`help-run-vault-${v1Due}`)).toHaveCount(0);

    // What it's told instead, with no button of its own: until when SPX
    // holders have first claim (the earliest held-back window's end, as the
    // chain's due buys say it, on this device's clock), how far this wallet
    // is from the bar, and what community keeping is. The build names no
    // source (playwright.config.ts), so there is no docs link to follow.
    const held = page.getByTestId("help-run-holders-first");
    const claim = held.getByTestId("help-run-first-claim");
    await expect(claim).toHaveText(/^(?:\d+ more buys? (?:is|are) due; )?SPX holders have first claim until \d{2}:\d{2}\.$/);
    const read = await readPlatform(forkRpc);
    const due = await readDueCandidates(forkRpc, read, { block: read.block });
    expect(due.find((c) => c.vault === inWindow)).toMatchObject({ inWindow: true, windowEndsAt: (await vaultOnChain(inWindow)).status.windowEndsAt });
    const until = due.filter((c) => c.inWindow).reduce((first, c) => (c.windowEndsAt < first ? c.windowEndsAt : first), 2n ** 64n);
    const untilOnDevice = Math.floor(Date.now() / 1000) + Number(until - (await chainNow()));
    expectClockWithin(/until (\d{2}:\d{2})\.$/.exec((await claim.textContent()) ?? "")![1]!, untilOnDevice - 120, untilOnDevice + 300);
    await expect(held.getByTestId("help-run-standing")).toHaveText("You hold 0 of the 690 SPX.");
    await expect(held.getByTestId("help-run-keeping")).toHaveText(
      "Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar.",
    );
    await expect(held.getByTestId("help-run-keeping-docs")).toHaveCount(0);
    await expect(held.getByRole("button")).toHaveCount(0);

    // Nothing ticked: nothing to cost, and nothing offered.
    await tickOnly(page, new Set());
    await expect(page.getByTestId("help-run-none-ticked")).toBeVisible();
    await expect(page.getByTestId("help-run-send")).toHaveCount(0);

    // Alone, the tiny fee doesn't cover the network fee: nothing is offered.
    await tickOnly(page, new Set([uncovered]));
    await expect(page.getByTestId("help-run-not-covered")).toContainText("1 buy due · its buy fee (");
    await expect(page.getByTestId("help-run-not-covered")).toContainText("is below the network fee (≈ ");
    await expect(page.getByTestId("help-run-not-covered")).toContainText("Not offered.");
    await expect(page.getByTestId("help-run-send")).toHaveCount(0);

    // The covered vault past its window alone: offered, checked by the Guard
    // before the button shows, made, and paid for, to a wallet that holds no SPX.
    const { hash, at } = await makeOneBuy(page, wallet, helper, covered);
    const after = await vaultOnChain(covered);
    expect(at).toBeGreaterThanOrEqual(after.terms.startAt + after.terms.communityWindow!);
    // Made after its window: not one the vault counts as a community keeper's.
    expect(after.windowBuys).toBe(0n);
    expect((await vaultOnChain(inWindow)).buysDone).toBe(0n);
    expect((await vaultOnChain(uncovered)).buysDone).toBe(0n);

    // Your activity records it as buy fees received: never as a buy.
    await openTile(page, "yours");
    const row = page.locator(`[data-testid="activity-row"][data-hash="${hash}"]`);
    await expect(row).toHaveAttribute("data-kind", "buy-fees-earned", { timeout: 60_000 });
    await expect(row.getByTestId("activity-fees-received")).toContainText("0.00138 WETH");
    await expect(row).not.toContainText("Bought");
  });

  test("a community keeper's wallet is offered a buy inside its window, and makes it, privately", async ({ page, context }) => {
    // Fresh, then made eligible the one way a test may: a real swap for its
    // SPX, and its registry record written (see the file comment).
    const helper = await freshAccount(ETHER / 4n);
    await makeEligibleSigner(forkRpc, FORK_CHAIN_ID, helper);
    const wallet = await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    await openHelpRun(page);

    await page.getByTestId("help-run-check").click();
    await expect(page.getByTestId("help-run-vaults")).toBeVisible({ timeout: 120_000 });
    // Nothing is held back from a community keeper: the buy inside its
    // window is offered beside the rest; v1's still isn't.
    await expect(page.getByTestId(`help-run-vault-${inWindow}`)).toHaveCount(1);
    await expect(page.getByTestId(`help-run-vault-${v1Due}`)).toHaveCount(0);
    await expect(page.getByTestId("help-run-holders-first")).toHaveCount(0);

    const { at } = await makeOneBuy(page, wallet, helper, inWindow);
    const after = await vaultOnChain(inWindow);
    // Made inside its window, paid to the keeper, and counted by the vault as
    // a buy a community keeper made there.
    expect(at).toBeLessThan(after.terms.startAt + WINDOW);
    expect(after.windowBuys).toBe(1n);
  });
});
