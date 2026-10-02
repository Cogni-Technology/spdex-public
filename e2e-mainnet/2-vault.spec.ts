/**
 * A vault's life through the app, from the owner agent: Recurring → Set and
 * forget → Create and fund vault (one confirmation), Trigger now on its first
 * buy, then Close and withdraw. Each step is read back from the vault's own
 * events and balances, as e2e/vault.spec.ts does on the pinned fork.
 *
 * Two buys of `SPDEX_SMOKE_BUY_ETH` (0.001 ETH by default), daily: the first
 * is due at once in chain time, and the second never comes, because the
 * vault is closed straight after the first, which returns the second buy's
 * ether and fee. The buy fee is the app's own default for that size, so it
 * may sit at the 0.69% ceiling: that is the case a small saver meets.
 */

import { encodeClose, encodeExecute, vaultBudget } from "../packages/vault/src/index.js";
import { expect, openTile, seedConfig, sentTransactions, test } from "../e2e/fixtures.js";
import { fillVaultForm, history, planCard } from "../e2e/vaults.js";
import { FACTORY, SPX, WETH, ethBalance, feeOf, minedReceipt, settings, tokenBalance } from "./chain.js";
import { eth } from "./settings.js";
import { closeOpenVaults, eventIn, vaultOnChain } from "./vaults.js";
import { MINED_WITHIN_MS, agents, pageWallet, settleMined } from "./wallet.js";

test.describe.configure({ mode: "serial" });
test.afterEach(async () => {
  await settleMined();
});
test.afterAll(async () => {
  await closeOpenVaults();
  await settleMined();
});

const UI_WAIT = () => MINED_WITHIN_MS() + 60_000;
const BUYS = 2;

test("creates and funds a vault in one confirmation, triggers its first buy, and closes it", async ({ page, context }) => {
  const { owner } = agents();
  const wallet = await pageWallet(context, owner, "vault: create and fund");
  await seedConfig(page);
  await page.goto("/");
  await openTile(page, "trade");

  // ── Created and funded ──
  const { start, quote } = await fillVaultForm(page, eth(settings.buyWei), BUYS);
  expect(quote.forBuys).toBe(BigInt(BUYS) * settings.buyWei);
  const ether0 = await ethBalance(owner.address);
  await start.click();
  const card = planCard(page);
  await openTile(page, "auto-buys");
  await expect(card.getByTestId("dca-pill")).toHaveText("Buy due", { timeout: UI_WAIT() });
  await expect(card.getByTestId("dca-vault-due")).toContainText("Buy 1 is due");

  expect(wallet.hashes).toHaveLength(1);
  const creation = await minedReceipt(wallet.hashes[0]!, MINED_WITHIN_MS());
  const created = eventIn(creation, FACTORY, "VaultCreated");
  const vault = created.vault.toLowerCase();
  expect(created.owner).toBe(owner.address);
  await expect(card.getByTestId("dca-vault-address")).toHaveText(vault);
  const { terms } = created;
  expect(terms).toMatchObject({ tokenOut: SPX, amountPerBuy: settings.buyWei, interval: 86_400n, maxBuys: BigInt(BUYS) });
  const budget = vaultBudget(terms);
  expect(created.funded).toBe(budget);
  expect(await tokenBalance(WETH, vault)).toBe(budget);
  expect(ether0 - (await ethBalance(owner.address))).toBe(budget + feeOf(creation));

  // ── Trigger now: the owner makes buy 1 and is paid its fee ──
  wallet.doing = "vault: trigger buy 1";
  // One tile is open at a time, and the page may have opened another since.
  await openTile(page, "auto-buys");
  const trigger = card.getByTestId("dca-vault-due").getByTestId("dca-vault-trigger");
  await expect(trigger).toBeEnabled({ timeout: 120_000 });
  const [spx0, weth0] = await Promise.all([tokenBalance(SPX, owner.address), tokenBalance(WETH, owner.address)]);
  await trigger.click();
  await expect(card.getByTestId("dca-progress")).toContainText(`1 of ${BUYS} buys`, { timeout: UI_WAIT() });

  const asked = await sentTransactions(page);
  expect(asked.at(-1)!.to?.toLowerCase()).toBe(vault);
  expect(asked.at(-1)!.data?.toLowerCase()).toBe(encodeExecute());
  expect(wallet.hashes).toHaveLength(2);
  const triggered = await minedReceipt(wallet.hashes[1]!, MINED_WITHIN_MS());
  const bought = eventIn(triggered, vault, "Bought");
  expect(bought).toMatchObject({ keeper: owner.address, amountIn: settings.buyWei, reward: terms.keeperReward, buyNumber: 1n });
  expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
  expect((await tokenBalance(SPX, owner.address)) - spx0).toBe(bought.amountOut);
  expect((await tokenBalance(WETH, owner.address)) - weth0).toBe(terms.keeperReward);
  await openTile(page, "auto-buys");
  await card.getByTestId("dca-history-summary").click();
  await expect(history(card, "bought")).toHaveCount(1, { timeout: 60_000 });

  // ── Close and withdraw: the second buy's ether and fee come back as ETH ──
  wallet.doing = "vault: close and withdraw";
  const held = (await vaultOnChain(vault)).status.wethBalance;
  expect(held).toBe(budget - settings.buyWei - terms.keeperReward);
  const ether1 = await ethBalance(owner.address);
  await openTile(page, "auto-buys");
  await card.getByTestId("dca-vault-close").click();
  await expect(card.getByTestId("dca-vault-close-ask")).toContainText("comes back to your wallet as ETH");
  await card.getByTestId("dca-vault-close-confirm").click();
  await expect(card.getByTestId("dca-pill")).toHaveText("Closed", { timeout: UI_WAIT() });

  expect(asked.length + 1).toBe((await sentTransactions(page)).length);
  expect((await sentTransactions(page)).at(-1)!.data?.toLowerCase()).toBe(encodeClose());
  expect(wallet.hashes).toHaveLength(3);
  const closing = await minedReceipt(wallet.hashes[2]!, MINED_WITHIN_MS());
  expect(eventIn(closing, vault, "Closed").amount).toBe(held);
  expect((await ethBalance(owner.address)) - ether1).toBe(held - feeOf(closing));
  expect(await tokenBalance(WETH, vault)).toBe(0n);
  expect(await vaultOnChain(vault)).toMatchObject({ closed: true, buysDone: 1n });
});
