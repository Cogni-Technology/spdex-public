/**
 * Help run the network: a tab makes other people's due vault buys, in one
 * transaction from its own wallet, sent privately, and is paid their buy fees.
 *
 * ## Only this spec's own vaults
 *
 * The fork is shared, and other vaults on it belong to other runs and other
 * specs; no spec triggers or closes a vault it didn't create. So an owner
 * made here from a fresh key creates two vaults that are due at once — one
 * whose buy fee covers the network fee, one whose tiny fee can't — and the
 * spec unticks every other vault the panel lists before anything is sent.
 * The helper is a second fresh key, so the buy fees it is paid are measured
 * to the wei with nobody else's transactions in the way.
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
import {
  encodeCreateVault,
  joinBatchLogs,
  termsProblems,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultPlan,
} from "../packages/vault/src/index.js";
import { FORK_URL, SPX, WETH, expect, forkRpc, seedConfig, test, tokenBalance, openTile } from "./fixtures.js";
import {
  BATCHER,
  ETHER,
  FACTORY,
  closeLeftoverVaults,
  ensureBatcher,
  freshAccount,
  keyWallet,
  receiptOf,
  sendAs,
  vaultOnChain,
  type Account,
} from "./vaults.js";

type Hex = `0x${string}`;

/** The covered vault's buy: 0.2 ETH, the size at which the most a buy fee can be pays for a lone batch at the fork's 1 gwei. */
const COVERED_BUY = 2n * 10n ** 17n;
/** Its buy fee: 0.69% of the buy, the contract's limit. 0.00138 ETH pays for about 1.38 million gas at 1 gwei. */
const REWARD = (COVERED_BUY * 69n) / 10_000n;

test.describe.configure({ mode: "serial" });

let owner: Account;
let covered: Hex;
let uncovered: Hex;

test.beforeAll(async () => {
  await ensureBatcher();
  owner = await freshAccount(ETHER / 4n, { owner: true });
  const head = (await forkRpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  const now = BigInt(head.timestamp);
  const make = async (plan: VaultPlan): Promise<Hex> => {
    const problems = termsProblems(plan, now);
    if (problems.length > 0) throw new Error(`the spec's own vault plan is refused: ${problems.join(", ")}`);
    const receipt = await sendAs(owner, { to: FACTORY, data: encodeCreateVault(plan), value: vaultBudget(plan) });
    const created = vaultsCreatedBy(FACTORY, receipt.logs as RawLog[]).filter((event) => event.owner === owner.address);
    expect(created).toHaveLength(1);
    return created[0]!.vault.toLowerCase() as Hex;
  };
  // Due from now, one buy each: nothing is left to buy once it is made.
  const base = { marketIndex: 0n, interval: 3_600n, maxBuys: 1n, startAt: now, maxSlippageBps: 300n };
  covered = await make({ ...base, amountPerBuy: COVERED_BUY, keeperReward: REWARD });
  // A buy fee of a millionth of an ether pays for about a thousand gas: never enough.
  uncovered = await make({ ...base, amountPerBuy: 10n ** 15n, keeperReward: 10n ** 12n });
});

test.afterAll(async () => {
  // Both of the owner's vaults, bought or not: nothing funded is left behind.
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

  test("makes only its own vault's due buy, privately, and is paid exactly its buy fee", async ({ page, context }) => {
    const helper = await freshAccount(ETHER / 20n);
    const wallet = await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    await openHelpRun(page);

    await page.getByTestId("help-run-check").click();
    await expect(page.getByTestId("help-run-vaults")).toBeVisible({ timeout: 120_000 });
    // Both of this spec's vaults are listed as due.
    await expect(page.getByTestId(`help-run-vault-${covered}`)).toHaveCount(1);
    await expect(page.getByTestId(`help-run-vault-${uncovered}`)).toHaveCount(1);

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

    // The covered vault alone: offered, and checked by the Guard before the button shows.
    await tickOnly(page, new Set([covered]));
    const send = page.getByTestId("help-run-send");
    await expect(send).toHaveText("Make 1 buy for this vault", { timeout: 120_000 });
    await expect(page.getByTestId("help-run-intro")).toContainText("1 vault buy");
    await expect(page.getByTestId("help-run-get")).toContainText("WETH in buy fees");
    await expect(page.getByTestId("help-run-pay")).toContainText("ETH network fee");
    await expect(page.getByTestId("help-run-wallet-fee")).toContainText("Your wallet will show a maximum network fee of up to");
    const ticked = await page
      .locator('[data-testid^="help-run-vault-"]:checked')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
    expect(ticked).toEqual([`help-run-vault-${covered}`]);

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

    // What it did, from the chain: this spec's covered vault bought, and nothing else was tried.
    const receipt = await receiptOf(signed!.hash);
    const runs = joinBatchLogs(receipt.logs, (address) => address === BATCHER);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggered.map((t) => t.event.vault)).toEqual([covered]);
    expect(runs[0]!.notTriggered).toEqual([]);
    expect(runs[0]!.batch).toMatchObject({ caller: helper.address, rewardTo: helper.address, bought: 1n, earned: REWARD, swept: 0n });
    // The helper is paid the buy fee, to the wei; the owner gets the SPX.
    expect((await tokenBalance(WETH, helper.address)) - wethBefore).toBe(REWARD);
    expect(await tokenBalance(SPX, owner.address)).toBeGreaterThan(spxBefore);
    expect((await vaultOnChain(covered)).buysDone).toBe(1n);
    expect((await vaultOnChain(uncovered)).buysDone).toBe(0n);

    await expect(page.getByTestId("help-run-finality")).toHaveAttribute("data-state", /included|final/, { timeout: 60_000 });

    // Your activity records it as buy fees received: never as a buy.
    await openTile(page, "yours");
    const row = page.locator(`[data-testid="activity-row"][data-hash="${signed!.hash}"]`);
    await expect(row).toHaveAttribute("data-kind", "buy-fees-earned", { timeout: 60_000 });
    await expect(row.getByTestId("activity-fees-received")).toContainText("0.00138 WETH");
    await expect(row).not.toContainText("Bought");
  });
});
