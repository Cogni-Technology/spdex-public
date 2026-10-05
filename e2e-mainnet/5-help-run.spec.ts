/**
 * Help run the network: the holder agent's page (the helper, proven by
 * `3-prove`) makes a due buy of a v2 vault the owner agent created, inside
 * its community window, in one batch, sent privately, and is paid its buy fee.
 *
 * Inside the window only a community keeper can be paid, so an outside
 * caller must lose to the holder agent. That is checked before the batch,
 * with `eth_call`s and nothing spent: a fresh address that names itself as
 * `rewardTo`, calling the vault directly or through the batcher, is refused
 * `NotEligible` until the window's end. (On 2026-10-02 a v1 run's Help run
 * vault was triggered by an outside account three blocks after it was
 * created; this is what v2 changes.)
 *
 * Only this run's vault, ever. The panel lists every due vault it finds, and
 * on mainnet those are other people's; the spec unticks all but its own
 * (as e2e/help-run.spec.ts does on the shared fork), and the harness's wallet
 * refuses to sign a batch that names any vault this run didn't create.
 *
 * The panel offers a batch only when its buy fees cover its network fee, and
 * a fee is at most 0.69% of a buy, so the vault made here is the smallest
 * whose 0.69% covers a one-vault batch at the price the page will sign it at
 * (the app's own `privateGasPrice`), with half again for the price to move.
 * Above `SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH` the spec is skipped and says the
 * figure: at a 0.15 gwei base fee that buy is about 0.015 ETH, at 1 gwei about
 * 0.08. On mainnet it also needs a private relay (`SPDEX_SMOKE_RELAY_URL`); on
 * a fork the relay is the fork itself.
 */

import type { Page } from "@playwright/test";
import { addressOfKey, generateSpendingKey } from "../packages/chain/src/index.js";
import {
  CURRENT_SOURCE,
  DEFAULT_TURN_BUCKETS,
  decodeBatchRevert,
  decodeVaultError,
  defaultCommunityWindow,
  encodeCreateVault,
  encodeExecute,
  encodeExecuteBatch,
  joinBatchLogs,
  modelBatchGas,
  termsProblems,
  vaultBudget,
  vaultsCreatedBy,
  withinFeeCeiling,
  type RawLog,
  type VaultPlan,
} from "../packages/vault/src/index.js";
import { privateGasPrice } from "../apps/web/src/lib/submit.js";
import { expect, openTile, seedConfig, test } from "../e2e/fixtures.js";
import { BATCHER, FACTORY, SPX, WETH, chainTime, minedReceipt, rpc, settings, tokenBalance } from "./chain.js";
import { HOLDER, currentRun, eth, gwei } from "./settings.js";
import { closeOpenVaults, eventIn, vaultOnChain } from "./vaults.js";
import { MINED_WITHIN_MS, agents, pageWallet, requireHolderEligible, sendAs, settleMined } from "./wallet.js";

type Hex = `0x${string}`;

test.afterAll(async () => {
  await closeOpenVaults();
  await settleMined();
});

/**
 * Tick exactly the vaults in `keep`, one checkbox at a time, waiting for the
 * panel to check each new choice: e2e/help-run.spec.ts's `tickOnly`.
 */
async function tickOnly(page: Page, keep: ReadonlySet<string>): Promise<void> {
  const list = page.getByTestId("help-run-vaults");
  for (let round = 0; round < 200; round++) {
    await openTile(page, "community");
    await expect(list).toBeVisible({ timeout: 120_000 });
    const boxes = await page
      .locator('[data-testid^="help-run-vault-"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({ id: element.getAttribute("data-testid")!, checked: (element as HTMLInputElement).checked })),
      );
    const wanted = (box: { id: string }) => keep.has(box.id.slice("help-run-vault-".length));
    const wrong = boxes.find((box) => box.checked && !wanted(box)) ?? boxes.find((box) => !box.checked && wanted(box));
    if (wrong === undefined) return;
    await openTile(page, "community");
    if (!(await list.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await page.getByTestId("help-run-vaults-summary").click();
    }
    const box = page.getByTestId(wrong.id);
    const handle = await box.elementHandle();
    await box.click();
    await handle!.waitForElementState("hidden", { timeout: 60_000 });
    await openTile(page, "community");
    await expect(page.getByTestId("help-run-checking")).toBeHidden({ timeout: 120_000 });
  }
  throw new Error("the ticks never settled on this run's own vault");
}

/**
 * What an outside caller gets for calling `to` with `data`, as an `eth_call`
 * from `from`: its revert data, or a failure if it would go through.
 */
async function revertOf(from: Hex, to: Hex, data: Hex): Promise<Hex> {
  try {
    await rpc("eth_call", [{ from, to, data }, "latest"]);
  } catch (error) {
    const revert = (error as { data?: unknown }).data;
    if (typeof revert === "string" && /^0x[0-9a-f]*$/i.test(revert)) return revert.toLowerCase() as Hex;
    throw error;
  }
  throw new Error(`an outside caller's call to ${to} would go through`);
}

test("makes this run's due vault buy inside its community window, privately, and is paid exactly its buy fee", async ({ page, context }) => {
  const run = currentRun();
  // Said on the console too: the list reporter shows a skip, not its reason.
  const skip = (reason: string) => {
    console.log(`  skipped: ${reason}`);
    test.skip(true, reason);
  };
  if (run.relayUrl === null) skip("no private relay on this mainnet run: set SPDEX_SMOKE_RELAY_URL (docs/MAINNET-SMOKE.md)");
  const gasPrice = await privateGasPrice(rpc);
  const reward = (modelBatchGas([{ firstBuy: true }]) * gasPrice * 3n) / 2n;
  const amountPerBuy = (reward * 10_000n + 68n) / 69n;
  if (amountPerBuy > settings.helpRunMaxBuyWei) {
    skip(
      `at ${gwei(gasPrice)} gwei a buy whose fee covers a batch is ${eth(amountPerBuy)} ETH, above SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH (${eth(settings.helpRunMaxBuyWei)})`,
    );
  }
  expect(withinFeeCeiling(reward, amountPerBuy)).toBe(true);

  const { owner } = agents();
  const helper = agents()[HOLDER];
  await requireHolderEligible();
  const now = await chainTime();
  // The app's default window for an hourly plan, 15 minutes: room for the page's whole round, inside it.
  const plan: VaultPlan = {
    marketIndex: 0n,
    amountPerBuy,
    interval: 3_600n,
    maxBuys: 1n,
    startAt: now,
    keeperReward: reward,
    maxSlippageBps: 300n,
    communityWindow: defaultCommunityWindow(3_600n),
    turnBuckets: DEFAULT_TURN_BUCKETS,
  };
  expect(termsProblems(plan, now)).toEqual([]);
  const creation = await sendAs(owner, { to: FACTORY, data: encodeCreateVault(plan), value: vaultBudget(plan) }, "help run: create a vault due now");
  const vault = vaultsCreatedBy(FACTORY, creation.logs as RawLog[]).find((event) => event.owner === owner.address)!.vault.toLowerCase() as Hex;
  const windowEndsAt = plan.startAt + plan.communityWindow;

  // ── An outside caller loses: refused inside the window, directly or through the batcher ──
  const outsider = addressOfKey(generateSpendingKey()).toLowerCase() as Hex;
  const direct = decodeVaultError(await revertOf(outsider, vault, encodeExecute(outsider)));
  expect(direct, "an outside caller's direct execute").toMatchObject({ name: "NotEligible" });
  expect((direct!.args[0] as string).toLowerCase()).toBe(outsider);
  expect(direct!.args[1]).toBe(windowEndsAt);
  const batched = decodeBatchRevert([vault], await revertOf(outsider, BATCHER, encodeExecuteBatch([vault], outsider, 0n)));
  expect(batched, "an outside caller's batch").toMatchObject({ kind: "NothingBought", bought: 0n });
  expect(batched!.outcomes.map((o) => o.reasonName)).toEqual(["NotEligible"]);

  const wallet = await pageWallet(context, helper, "help run: batch of this run's vault", run.relayUrl);
  await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: run.relayUrl } });
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await openTile(page, "community");
  await expect(page.getByTestId("help-run")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("help-run-check").click();
  await expect(page.getByTestId("help-run-vaults")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId(`help-run-vault-${vault}`)).toHaveCount(1, { timeout: 60_000 });
  await tickOnly(page, new Set([vault]));
  const send = page.getByTestId("help-run-send");
  await expect(send).toHaveText("Make 1 buy for this vault", { timeout: 120_000 });

  const [weth0, spx0] = await Promise.all([tokenBalance(WETH, helper.address), tokenBalance(SPX, owner.address)]);
  await send.click();
  await expect(page.getByTestId("help-run-result-text")).toContainText("Made 1 of 1 buy.", { timeout: MINED_WITHIN_MS() + 60_000 });

  // Signed once, for the relay, and never handed to anything to broadcast.
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.hashes).toHaveLength(0);
  const receipt = await minedReceipt(wallet.signed[0]!.hash, MINED_WITHIN_MS());
  expect(receipt.to?.toLowerCase()).toBe(BATCHER);
  const runs = joinBatchLogs(receipt.logs, (address) => address === BATCHER);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.triggered.map((t) => t.event.vault)).toEqual([vault]);
  expect(runs[0]!.batch).toMatchObject({ caller: helper.address, rewardTo: helper.address, bought: 1n, earned: reward });
  // The vault paid the holder agent, inside the window: a community keeper's buy.
  const bought = eventIn(receipt, vault, "Bought");
  expect(bought).toMatchObject({ source: CURRENT_SOURCE, keeper: BATCHER, rewardTo: helper.address, reward, dueSince: plan.startAt });
  const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };
  expect(BigInt(block.timestamp)).toBeLessThan(windowEndsAt);
  expect((await tokenBalance(WETH, helper.address)) - weth0).toBe(reward);
  expect(await tokenBalance(SPX, owner.address)).toBeGreaterThan(spx0);
  expect(await vaultOnChain(vault)).toMatchObject({ buysDone: 1n, windowBuys: 1n });
  test.info().annotations.push({ type: "inside the community window", description: `${windowEndsAt - BigInt(block.timestamp)} s before it ended` });
});
