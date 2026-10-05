/**
 * The keeper: one tick of the package's own `keeperTick`, what `pnpm keeper`
 * runs, from the keeper agent's key, makes a vault's due buy through the
 * batcher and has the vault pay the buy fee to the holder agent (`rewardTo`,
 * as `SPDEX_KEEPER_REWARD_TO` does: a hot key that pays gas, a cold wallet
 * that holds the SPX and is paid). This is docs/RELEASE.md's "a small vault
 * gets its first buy from the keeper and not from you", without Docker.
 *
 * The vault is created here, outside the page: one buy of
 * `SPDEX_SMOKE_BUY_ETH`, due now, at the app's default fee for that size,
 * with the app's default community window for an hourly plan (15 minutes).
 * Its buy is made inside that window, which only a community keeper may be
 * paid for: the holder agent, proven by `3-prove`. A keeper whose `rewardTo`
 * isn't one would wait the window out instead, so that is checked first.
 * That fee rarely covers one buy's network cost, so the tick is allowed to
 * lose up to `SPDEX_SMOKE_KEEPER_SUBSIDY_ETH` on it, as a keeper's operator
 * subsidy would (docs/KEEPER.md, "How it earns, and what it costs").
 *
 * The keeper is bounded as every keeper run in this suite is (keeper.ts):
 * here it may send one transaction.
 */

import {
  CURRENT_SOURCE,
  DEFAULT_TURN_BUCKETS,
  buyFee,
  defaultCommunityWindow,
  encodeCreateVault,
  termsProblems,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultPlan,
} from "../packages/vault/src/index.js";
import { expect, test } from "../e2e/fixtures.js";
import { BATCHER, FACTORY, SPX, WETH, chainTime, minedReceipt, rpc, settings, tokenBalance } from "./chain.js";
import { runKeeper } from "./keeper.js";
import { HOLDER } from "./settings.js";
import { closeOpenVaults, eventIn, vaultOnChain } from "./vaults.js";
import { MINED_WITHIN_MS, agents, requireHolderEligible, sendAs, settleMined } from "./wallet.js";

type Hex = `0x${string}`;

test.afterAll(async () => {
  await closeOpenVaults();
  await settleMined();
});

const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

test("one keeper tick makes a due vault's buy through the batcher, inside its community window, and pays its fee to rewardTo", async () => {
  const { owner, keeper } = agents();
  const holder = agents()[HOLDER];
  await requireHolderEligible();
  const now = await chainTime();
  const plan: VaultPlan = {
    marketIndex: 0n,
    amountPerBuy: settings.buyWei,
    interval: 3_600n,
    maxBuys: 1n,
    startAt: now,
    keeperReward: buyFee(settings.buyWei).reward,
    maxSlippageBps: 300n,
    communityWindow: defaultCommunityWindow(3_600n),
    turnBuckets: DEFAULT_TURN_BUCKETS,
  };
  expect(termsProblems(plan, now)).toEqual([]);
  const creation = await sendAs(owner, { to: FACTORY, data: encodeCreateVault(plan), value: vaultBudget(plan) }, "keeper: create a vault due now");
  const created = vaultsCreatedBy(FACTORY, creation.logs as RawLog[]).filter((event) => event.owner === owner.address);
  expect(created).toHaveLength(1);
  const vault = created[0]!.vault.toLowerCase() as Hex;

  const [spx0, weth0] = await Promise.all([tokenBalance(SPX, owner.address), tokenBalance(WETH, holder.address)]);
  const run = await runKeeper({
    vaults: [vault],
    rewardTo: holder.address,
    maxSends: 1,
    what: "keeper: one batch",
    timeoutMs: 5 * 60_000,
    done: async (sofar) => sofar.mined.length > 0,
  });
  const tick = run.ticks.find((t) => t.sent.length > 0)!;

  expect(tick.sent.map((batch) => batch.vaults), `skipped: ${json(tick.skipped)}; waiting: ${json(tick.waiting)}`).toEqual([[vault]]);
  expect(run.mined).toHaveLength(1);
  expect(run.mined[0]!).toMatchObject({ status: "success", earnedWei: plan.keeperReward });
  const receipt = await minedReceipt(run.mined[0]!.hash, MINED_WITHIN_MS());
  expect(receipt.to?.toLowerCase()).toBe(BATCHER);
  // The vault's caller was the batcher, which named the holder agent: the vault paid it directly.
  const bought = eventIn(receipt, vault, "Bought");
  expect(bought).toMatchObject({
    source: CURRENT_SOURCE,
    keeper: BATCHER,
    rewardTo: holder.address,
    amountIn: settings.buyWei,
    reward: plan.keeperReward,
    buyNumber: 1n,
  });
  expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
  // Inside its community window, so it counts as a community keeper's buy.
  const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };
  expect(BigInt(block.timestamp)).toBeLessThan(bought.dueSince! + plan.communityWindow);
  expect(run.mined[0]!.bought[0]).toMatchObject({ rewardTo: holder.address, inCommunityWindow: true });
  expect((await vaultOnChain(vault)).windowBuys).toBe(1n);
  expect((await tokenBalance(SPX, owner.address)) - spx0).toBe(bought.amountOut);
  expect((await tokenBalance(WETH, holder.address)) - weth0).toBe(plan.keeperReward);
  expect(await tokenBalance(WETH, keeper.address)).toBe(0n);
});
