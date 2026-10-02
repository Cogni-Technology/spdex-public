/**
 * A vault at the shortest interval there is, five minutes, run to its end by
 * the keeper: the owner agent creates it through the app (Expert view, How
 * often → Custom… → 5 minutes, three buys), and the keeper agent's
 * `keeperTick` makes every buy as it falls due, paying each buy fee to the
 * helper agent. Nobody clicks Trigger now. This is a set-and-forget plan
 * watched from start to finish in about ten minutes.
 *
 * What it checks besides the buys themselves: the vault keeps its spacing (no
 * buy before its window opens, none sooner than half an interval after the
 * last), the keeper sends a five-minute plan as soon as it is due rather than
 * waiting for cheap gas (`shortIntervalSeconds`), and the owner's card ends
 * at "3 of 3 buys", Done, with nothing left in the vault.
 */

import { vaultBudget } from "../packages/vault/src/index.js";
import { expect, openTile, seedConfig, test } from "../e2e/fixtures.js";
import { fillVaultForm, planCard } from "../e2e/vaults.js";
import { BATCHER, FACTORY, SPX, WETH, ethBalance, feeOf, minedReceipt, rpc, settings, tokenBalance } from "./chain.js";
import { runKeeper } from "./keeper.js";
import { eth } from "./settings.js";
import { closeOpenVaults, eventIn, vaultOnChain } from "./vaults.js";
import { MINED_WITHIN_MS, agents, pageWallet, settleMined } from "./wallet.js";

type Hex = `0x${string}`;

test.afterAll(async () => {
  await closeOpenVaults();
  await settleMined();
});

const BUYS = 3;
const INTERVAL = 300n;
const UI_WAIT = () => MINED_WITHIN_MS() + 60_000;

test("a five-minute vault is run to its end by the keeper, one buy per window", async ({ page, context }) => {
  // Two intervals, a buy's mining each, and the page either side.
  test.setTimeout(40 * 60_000);
  const { owner, helper } = agents();
  const wallet = await pageWallet(context, owner, "every 5 minutes: create and fund");
  await seedConfig(page);
  // The custom interval is in the Expert view only.
  await page.addInitScript(() => window.localStorage.setItem("spdex.view.v1", "expert"));
  await page.goto("/");
  await openTile(page, "trade");

  // ── Created through the app, every five minutes ──
  const { start, quote } = await fillVaultForm(page, eth(settings.buyWei), BUYS);
  expect(quote.forBuys).toBe(BigInt(BUYS) * settings.buyWei);
  await page.getByTestId("dca-form-frequency").selectOption("custom");
  await page.getByTestId("dca-form-custom-minutes").fill("5");
  await expect(start).toBeEnabled({ timeout: 60_000 });
  const ether0 = await ethBalance(owner.address);
  await start.click();
  const card = planCard(page);
  await openTile(page, "auto-buys");
  await expect(card.getByTestId("dca-pill")).toHaveText("Buy due", { timeout: UI_WAIT() });

  expect(wallet.hashes).toHaveLength(1);
  const creation = await minedReceipt(wallet.hashes[0]!, MINED_WITHIN_MS());
  const created = eventIn(creation, FACTORY, "VaultCreated");
  const vault = created.vault.toLowerCase() as Hex;
  expect(created.owner).toBe(owner.address);
  const { terms } = created;
  expect(terms).toMatchObject({ tokenOut: SPX, amountPerBuy: settings.buyWei, interval: INTERVAL, maxBuys: BigInt(BUYS) });
  const budget = vaultBudget(terms);
  expect(created.funded).toBe(budget);
  expect(ether0 - (await ethBalance(owner.address))).toBe(budget + feeOf(creation));

  // ── The keeper, and nobody else, from here to the end ──
  const [spx0, weth0] = await Promise.all([tokenBalance(SPX, owner.address), tokenBalance(WETH, helper.address)]);
  const run = await runKeeper({
    vaults: [vault],
    rewardTo: helper.address,
    maxSends: BUYS,
    what: "every 5 minutes: one keeper batch",
    timeoutMs: 30 * 60_000,
    done: async () => (await vaultOnChain(vault)).buysDone >= BigInt(BUYS),
  });

  expect(run.mined.map((batch) => batch.status)).toEqual(Array(BUYS).fill("success"));
  const buys = [];
  for (const batch of run.mined) {
    const receipt = await minedReceipt(batch.hash, MINED_WITHIN_MS());
    expect(receipt.to?.toLowerCase()).toBe(BATCHER);
    const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };
    buys.push({ at: BigInt(block.timestamp), bought: eventIn(receipt, vault, "Bought") });
  }
  for (const [i, { at, bought }] of buys.entries()) {
    expect(bought).toMatchObject({ keeper: BATCHER, amountIn: settings.buyWei, reward: terms.keeperReward, buyNumber: BigInt(i + 1) });
    expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
    // Never before its window opens, never sooner than half an interval after the last.
    expect(at).toBeGreaterThanOrEqual(terms.startAt + BigInt(i) * INTERVAL);
    if (i > 0) expect(at - buys[i - 1]!.at).toBeGreaterThanOrEqual(INTERVAL / 2n);
  }
  const lateness = buys.map(({ at }, i) => Number(at - (terms.startAt + BigInt(i) * INTERVAL)));
  test.info().annotations.push({ type: "seconds after each window opened", description: lateness.join(", ") });

  expect((await tokenBalance(SPX, owner.address)) - spx0).toBe(buys.reduce((sum, { bought }) => sum + bought.amountOut, 0n));
  expect((await tokenBalance(WETH, helper.address)) - weth0).toBe(BigInt(BUYS) * terms.keeperReward);
  expect(await vaultOnChain(vault)).toMatchObject({ closed: false, buysDone: BigInt(BUYS), status: { wethBalance: 0n } });

  // ── What the owner sees ──
  await openTile(page, "auto-buys");
  await expect(card.getByTestId("dca-progress")).toContainText(`${BUYS} of ${BUYS} buys`, { timeout: 120_000 });
  await expect(card.getByTestId("dca-pill")).toHaveText("Done");
  await expect(card.getByTestId("dca-status")).toContainText(`Finished: ${BUYS} of ${BUYS} bought.`);
  expect(wallet.hashes).toHaveLength(1);
});
