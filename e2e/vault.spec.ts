/**
 * Vault plans: auto-buys that run with no spDEX page open, followed with real
 * money on the fork.
 *
 * A vault is the one kind of plan whose truth is on chain rather than in this
 * browser, so every claim here is checked twice: against what the page asked
 * the wallet for (`window.ethereum._sent`, recorded before anything is sent)
 * and against the chain afterwards. The claims are the ones the product
 * makes out loud — "1 confirmation creates and funds it", "no spDEX tab
 * needed" (it buys when triggered, with or without spDEX open), "only you
 * can withdraw", and a card that shows the vault's own figures rather than a
 * record kept here.
 *
 * Accounts are fresh random keys, funded for the test and signed for outside
 * the page (e2e/vaults.ts says why). The keeper is one too: one tick of the
 * package's own `keeperTick`, run from the test while no page is open, as
 * `pnpm keeper` runs it — through the batcher, paying its fees to a separate
 * `rewardTo`, and limited to the test's own vault. Nothing moves the chain's
 * clock, or the page's. A vault judges time by blocks, and the fork's blocks
 * carry its own time, days behind the wall clock; a plan started from the form
 * is due at once in that time, so its first buy needs no clock moved at all.
 *
 * What this cannot reach is a *later* buy. The vault spaces buys at least half
 * an interval apart (`_nextBuyAt`), and the shortest interval it accepts is
 * five minutes, so a second window is at least 150 real seconds after the first
 * buy — and on an idle fork no block shows it until a transaction arrives.
 * Rather than tripling the suite's running time with a wait, or touching the
 * shared fork's clock, "Trigger now" on a later window is pinned by a unit
 * test (apps/web/src/components/dca/VaultCard.laterWindow.test.ts); here it is
 * exercised on a first window, the whole way through a real browser, the
 * Guard and the chain.
 *
 * The last test is about a vault spDEX lost track of: that the app finds the
 * owner's vaults on chain again, lists those no plan points at, and closes or
 * adds them back through the same checks a card uses.
 *
 * Every vault a test makes is closed before the next test starts — by the
 * test itself where closing is the point, and otherwise, or when a test stops
 * half way, by `closeLeftoverVaults` after it — so no funded vault is left on
 * the shared fork for a keeper to find.
 */

import {
  decodeBatcherEvent,
  decodeVaultEvent,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  vaultBudget,
  vaultsCreatedBy,
  type VaultEvent,
  type VaultPlan,
} from "../packages/vault/src/index.js";
import { keeperConfig, keeperTick, newKeeperState } from "../packages/vault/src/keeper.js";
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  ethBalance,
  feePaid,
  FORK_CHAIN_ID,
  FORK_URL,
  forkRpc,
  NATIVE_ETH,
  seedConfig,
  sentTransactions,
  signedTransactions,
  SPX,
  tokenBalance,
  WETH,
  openSection,
  openTile,
} from "./fixtures.js";
import {
  BATCHER,
  ETHER,
  FACTORY,
  closeLeftoverVaults,
  ensureBatcher,
  expectRoundedUp,
  expectSixDigits,
  fillVaultForm,
  freshAccount,
  history,
  keyWallet,
  parseEther,
  planCard,
  receiptOf,
  sendAs,
  vaultOnChain,
} from "./vaults.js";

/** 0.01 ETH a buy: large enough that its buy fee (a fixed amount for network fees plus 10% of that) is not held down by the 0.69% ceiling. */
const BUY = ETHER / 100n;
const BUYS = 3;
/** A vault transaction is a Guard simulation, a signature and a receipt on a forked mainnet. */
const TX_TIMEOUT = 120_000;
/** What the app keeps in this browser that a vault card may use: the config (which points at the vault) and a dismissed dialog. */
const CONFIG_KEYS = ["spdex.config.v1", "spdex.features.seen.v1"];

/** "13,070.5 SPX" → base units, for a figure shown to six significant digits. */
function parseUnits(text: string, decimals: number): bigint {
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals) || "0");
}

/** The one event of a kind that `vault` emitted in a mined transaction. */
async function eventIn<N extends VaultEvent["name"]>(hash: string, vault: string, name: N): Promise<Extract<VaultEvent, { name: N }>> {
  const events = (await receiptOf(hash)).logs
    .map(decodeVaultEvent)
    .filter((event): event is Extract<VaultEvent, { name: N }> => event?.name === name && event.emitter === vault);
  expect(events, `${name} events from ${vault} in ${hash}`).toHaveLength(1);
  return events[0]!;
}

// The factory the app offers, and the batcher the keeper here sends through.
test.beforeAll(async () => {
  await ensureBatcher();
});

test.afterEach(async () => {
  await closeLeftoverVaults();
});

test.describe("vaults", () => {
  test("a vault created and funded in one confirmation buys while spDEX is closed, reads back from the chain, and returns its ETH on close", async ({
    context,
  }) => {
    const owner = await freshAccount(ETHER, { owner: true });
    const wallet = await keyWallet(context, owner);
    // Seeded on this page only: a page opened later finds what this one saved.
    const page = await context.newPage();
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    // ── Created and funded: one confirmation, sending what the form said ──
    const { start, quote } = await fillVaultForm(page, "0.01", BUYS);
    expect(quote.forBuys).toBe(BigInt(BUYS) * BUY);
    const ether0 = await ethBalance(owner.address);
    await start.click();

    const card = planCard(page);
    // Due at once: its start is the chain's now, not this machine's.
    await openTile(page, "auto-buys");
    await expect(card.getByTestId("dca-pill")).toHaveText("Buy due", { timeout: TX_TIMEOUT });
    await expect(card.getByTestId("dca-vault-due")).toContainText("Buy 1 is due — waiting for a keeper");

    const sent = await sentTransactions(page);
    expect(sent).toHaveLength(1);
    expect(await signedTransactions(page)).toHaveLength(0);
    expect(wallet.hashes).toHaveLength(1);
    const creationHash = wallet.hashes[0]!;
    const created = await eventIn(creationHash, FACTORY, "VaultCreated");
    const vault = created.vault;
    expect(created.owner).toBe(owner.address);
    await expect(card.getByTestId("dca-vault-address")).toHaveText(vault);

    // The terms are the plan's and the form's: this amount, daily, three
    // times, a 2% allowance, and the buy fee the form quoted.
    const { terms } = created;
    expect(created.marketIndex).toBe(0n);
    expect(terms).toMatchObject({ tokenOut: SPX, amountPerBuy: BUY, interval: 86_400n, maxBuys: BigInt(BUYS), maxSlippageBps: 200n });
    expectRoundedUp(quote.feeEach, terms.keeperReward);
    expectRoundedUp(quote.forFees, BigInt(BUYS) * terms.keeperReward);
    // Chain time: at or before the block that created it, and minutes from
    // it at most. Wall-clock time would put the start days after that block
    // on this fork, and the first buy days away.
    const block = (await forkRpc("eth_getBlockByNumber", [(await receiptOf(creationHash)).blockNumber, false])) as { timestamp: string };
    expect(terms.startAt).toBeLessThanOrEqual(BigInt(block.timestamp));
    expect(BigInt(block.timestamp) - terms.startAt).toBeLessThan(3_600n);

    // The one transaction: to the factory, creating exactly these terms,
    // carrying every buy and every buy's fee.
    const budget = quote.forBuys + BigInt(BUYS) * terms.keeperReward;
    const creation = sent[0]!;
    expect(creation.to?.toLowerCase()).toBe(FACTORY);
    expect(BigInt(creation.value ?? "0x0")).toBe(budget);
    expectRoundedUp(quote.sends, budget);
    expect(creation.data?.toLowerCase()).toBe(
      encodeCreateVault({
        marketIndex: 0n,
        amountPerBuy: terms.amountPerBuy,
        interval: terms.interval,
        maxBuys: terms.maxBuys,
        startAt: terms.startAt,
        keeperReward: terms.keeperReward,
        maxSlippageBps: terms.maxSlippageBps,
      }),
    );
    // On chain: the vault holds all of it, as WETH, and the owner paid that
    // and the network fee, nothing more.
    expect(await tokenBalance(WETH, vault)).toBe(budget);
    expect(await ethBalance(vault)).toBe(0n);
    expect(ether0 - (await ethBalance(owner.address))).toBe(budget + (await feePaid(creationHash)));
    // And the factory's own event says what came with the creation.
    expect(created.funded).toBe(budget);

    // ── A buy with spDEX closed ──
    // The plan's pointer to its vault is saved before the page goes.
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("spdex.config.v1") ?? "")).toContain(vault);
    await page.close();
    expect(context.pages()).toHaveLength(0);

    const spx0 = await tokenBalance(SPX, owner.address);
    // A keeper's hot key pays the network fee; the buy fees go to an address of
    // its operator's, as `SPDEX_KEEPER_REWARD_TO` sends them.
    const keeper = await freshAccount(ETHER / 20n);
    const rewardTo = await freshAccount(0n);
    const tick = await keeperTick(forkRpc, {
      config: keeperConfig({
        chainId: FORK_CHAIN_ID,
        keeperKey: keeper.key,
        rewardTo: rewardTo.address,
        vaults: [vault],
        // Now rather than at a cheap block; one confirmation and no head-lag
        // check, since the idle fork's head is days behind the wall clock.
        policy: { sendWhen: "now", confirmations: 1, maxHeadLagSeconds: 0n },
      }),
      state: newKeeperState({ chainId: FORK_CHAIN_ID, keeper: keeper.address }),
      waitForReceiptMs: 120_000,
    });
    expect(tick.sent.map((batch) => batch.vaults)).toEqual([[vault]]);
    expect(tick.mined).toHaveLength(1);
    expect(tick.mined[0]!).toMatchObject({ status: "success", refused: [], notTried: [], earnedWei: terms.keeperReward });
    expect(tick.mined[0]!.bought.map((b) => b.vault)).toEqual([vault]);
    const keeperHash = tick.mined[0]!.hash;
    // The vault's caller was the batcher, which passed its fee straight on.
    const bought = await eventIn(keeperHash, vault, "Bought");
    expect(bought).toMatchObject({ keeper: BATCHER, amountIn: BUY, reward: terms.keeperReward, buyNumber: 1n });
    const batch = (await receiptOf(keeperHash)).logs.map((log) => decodeBatcherEvent(BATCHER, log)).find((event) => event?.name === "Batch");
    expect(batch).toMatchObject({ caller: keeper.address, rewardTo: rewardTo.address, bought: 1n, earned: terms.keeperReward, swept: 0n });
    const spx1 = await tokenBalance(SPX, owner.address);
    expect(spx1 - spx0).toBe(bought.amountOut);
    expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
    expect(bought.amountOut).toBeGreaterThan(0n);
    // The fee landed at rewardTo, in WETH; nothing stayed with the keeper's key
    // or the batcher; the vault holds the two buys left.
    expect(await tokenBalance(WETH, rewardTo.address)).toBe(terms.keeperReward);
    expect(await tokenBalance(WETH, keeper.address)).toBe(0n);
    expect(await tokenBalance(WETH, BATCHER)).toBe(0n);
    expect(await tokenBalance(WETH, vault)).toBe(budget - BUY - terms.keeperReward);

    // Back on spDEX: the buy it never saw is there, from the vault.
    const back = await context.newPage();
    await back.goto("/");
    await openTile(back, "trade");
    await back.getByTestId("connect-button").click();
    const again = planCard(back);
    await openTile(back, "auto-buys");
    await expect(again.getByTestId("dca-progress")).toContainText("1 of 3 buys", { timeout: 60_000 });
    await expect(again.getByTestId("dca-pill")).toHaveAttribute("data-status", "running");
    await expect(again.getByTestId("dca-vault-due")).toHaveCount(0);
    await again.getByTestId("dca-history-summary").click();
    await expect(history(again, "bought")).toHaveCount(1, { timeout: 60_000 });
    // Made by a batch, so the history says so rather than naming the batcher.
    await expect(history(again, "bought")).toContainText("triggered in a batch, paid");
    expect(await sentTransactions(back)).toHaveLength(0);

    // ── After a reload with nothing kept but the config: all of it from the chain ──
    // Everything else this browser stored goes: drafts, ledgers, leases. What
    // the card shows after that can only have come from the vault.
    await back.evaluate((keep) => {
      for (const key of Object.keys(window.localStorage)) if (!keep.includes(key)) window.localStorage.removeItem(key);
      window.sessionStorage.clear();
    }, CONFIG_KEYS);
    await back.reload();
    await openTile(back, "trade");
    await back.getByTestId("connect-button").click();
    const onChain = await vaultOnChain(vault);
    expect(onChain).toMatchObject({ owner: owner.address, closed: false, buysDone: 1n, totalOut: bought.amountOut, totalRewards: terms.keeperReward });

    await openTile(back, "auto-buys");
    await expect(again.getByTestId("dca-progress")).toContainText("1 of 3 buys · 0.01 of 0.03 ETH", { timeout: 60_000 });
    await expect(again.getByTestId("dca-vault-address")).toHaveText(vault);
    const shownBought = /^([\d,.]+) SPX$/.exec(((await again.getByTestId("dca-bought").textContent()) ?? "").trim());
    expect(shownBought).not.toBeNull();
    expectSixDigits(parseUnits(shownBought![1]!, 8), onChain.totalOut);
    const holds = /^([\d.]+) WETH · covers every buy left$/.exec(((await again.getByTestId("dca-vault-balance").textContent()) ?? "").trim());
    expect(holds).not.toBeNull();
    expectSixDigits(parseEther(holds![1]!), onChain.status.wethBalance);
    // The fee is followed, in brackets, by its dollars when a rate is known and its share of each buy.
    const reward = /^([\d.]+) WETH a buy(?: \([^)]*\))? · ([\d.]+) WETH paid so far$/.exec(
      ((await again.getByTestId("dca-vault-reward").textContent()) ?? "").trim(),
    );
    expect(reward).not.toBeNull();
    expectSixDigits(parseEther(reward![1]!), onChain.terms.keeperReward);
    expectSixDigits(parseEther(reward![2]!), onChain.totalRewards);
    // (The tip behind "10-minute average" is in the same element, hence the anchor at the start only.)
    await expect(again.getByTestId("dca-vault-allowance")).toHaveText(/^2% below the 10-minute average/);
    // Counted down in chain time to the next day's window.
    await expect(again.getByTestId("dca-next")).toHaveText(/^\d+h \d+m$/);
    await again.getByTestId("dca-history-summary").click();
    await expect(history(again, "bought")).toHaveCount(1, { timeout: 60_000 });
    await expect(history(again, "bought")).toContainText("triggered in a batch, paid");

    // ── Close and withdraw: everything it holds comes back as ETH ──
    const held = onChain.status.wethBalance;
    const ether1 = await ethBalance(owner.address);
    await again.getByTestId("dca-vault-close").click();
    const ask = ((await again.getByTestId("dca-vault-close-ask").textContent()) ?? "").replace(/\s+/g, " ");
    const said = /Everything it holds — ([\d.]+) WETH — comes back to your wallet as ETH/.exec(ask);
    expect(said, ask).not.toBeNull();
    expectSixDigits(parseEther(said![1]!), held);
    await again.getByTestId("dca-vault-close-confirm").click();
    await expect(again.getByTestId("dca-pill")).toHaveText("Closed", { timeout: TX_TIMEOUT });

    const closing = await sentTransactions(back);
    expect(closing).toHaveLength(1);
    expect(closing[0]!.to?.toLowerCase()).toBe(vault);
    expect(closing[0]!.data?.toLowerCase()).toBe(encodeClose());
    expect(BigInt(closing[0]!.value ?? "0x0")).toBe(0n);
    expect(wallet.hashes).toHaveLength(2);
    const closeHash = wallet.hashes[1]!;
    expect((await eventIn(closeHash, vault, "Closed")).amount).toBe(held);
    expect((await ethBalance(owner.address)) - ether1).toBe(held - (await feePaid(closeHash)));
    expect(await tokenBalance(WETH, vault)).toBe(0n);
    expect(await ethBalance(vault)).toBe(0n);
    expect(await vaultOnChain(vault)).toMatchObject({ closed: true, buysDone: 1n });

    // Closed is final, and the card offers nothing that would act on it.
    await expect(again.getByTestId("dca-vault-balance")).toHaveText("Nothing — it's closed", { timeout: 60_000 });
    await expect(again.getByTestId("dca-vault-close")).toHaveCount(0);
    await expect(again.getByTestId("dca-vault-fund")).toHaveCount(0);
    await expect(again.getByTestId("dca-vault-trigger")).toHaveCount(0);
  });

  test("Trigger now makes a due buy from the owner's wallet: SPX to the owner, the buy fee back as WETH", async ({ context }) => {
    /*
     * Anyone may trigger a due buy and be paid its buy fee; "Trigger now" makes
     * the owner that keeper. One wallet transaction, to the vault, sending no
     * ether: the owner pays its network fee and nothing else, the tokens land
     * at the owner, and the buy fee comes back to them as WETH.
     */
    const owner = await freshAccount(ETHER, { owner: true });
    const wallet = await keyWallet(context, owner);
    const page = await context.newPage();
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const { start } = await fillVaultForm(page, "0.01", BUYS);
    await start.click();
    const card = planCard(page);
    const due = card.getByTestId("dca-vault-due");
    await expect(due).toContainText("Buy 1 is due — waiting for a keeper", { timeout: TX_TIMEOUT });
    await openTile(page, "auto-buys");
    const vault = (((await card.getByTestId("dca-vault-address").textContent()) ?? "").trim()).toLowerCase();
    const { terms } = await vaultOnChain(vault);

    const trigger = due.getByTestId("dca-vault-trigger");
    await expect(trigger).toBeEnabled({ timeout: 60_000 });
    const [spx0, weth0, ether0] = await Promise.all([
      tokenBalance(SPX, owner.address),
      tokenBalance(WETH, owner.address),
      ethBalance(owner.address),
    ]);
    const sent0 = (await sentTransactions(page)).length;
    await trigger.click();

    await expect(card.getByTestId("dca-progress")).toContainText("1 of 3 buys", { timeout: TX_TIMEOUT });
    await expect(card.getByTestId("dca-vault-due")).toHaveCount(0);
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "running");

    const sent = await sentTransactions(page);
    expect(sent).toHaveLength(sent0 + 1);
    expect(sent.at(-1)!.to?.toLowerCase()).toBe(vault);
    expect(sent.at(-1)!.data?.toLowerCase()).toBe(encodeExecute());
    expect(BigInt(sent.at(-1)!.value ?? "0x0")).toBe(0n);
    expect(wallet.hashes).toHaveLength(2);
    const hash = wallet.hashes[1]!;
    const bought = await eventIn(hash, vault, "Bought");
    expect(bought).toMatchObject({ keeper: owner.address, amountIn: BUY, reward: terms.keeperReward });

    expect((await tokenBalance(SPX, owner.address)) - spx0).toBe(bought.amountOut);
    expect(bought.amountOut).toBeGreaterThan(0n);
    expect((await tokenBalance(WETH, owner.address)) - weth0).toBe(terms.keeperReward);
    expect(ether0 - (await ethBalance(owner.address))).toBe(await feePaid(hash));

    await card.getByTestId("dca-history-summary").click();
    await expect(history(card, "bought")).toHaveCount(1, { timeout: 60_000 });
    await expect(history(card, "bought")).toContainText("triggered by you, paid");

    // "Reset to recommended" can't take the plan with it: the vault still
    // holds two buys' worth, and its plan is spDEX's only way back to it —
    // the one place "Close and withdraw" is. It stays, and the question says
    // why.
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "config-panel");
    await page.getByTestId("reset-config").click();
    const ask = page.getByTestId("dca-remove-plans");
    await openTile(page, "auto-buys");
    await expect(ask.getByTestId("dca-remove-plans-vault")).toContainText("stays: its vault");
    await expect(ask.getByTestId("dca-remove-plans-vault")).toContainText("goes on buying whenever anyone triggers it");
    await ask.getByTestId("dca-remove-plans-confirm").click();
    await expect(ask).toHaveCount(0);
    await expect(card.getByTestId("dca-vault-address")).toHaveText(vault, { timeout: 60_000 });
    await expect(card.getByTestId("dca-vault-close")).toBeVisible();
  });

  test("a vault spDEX lost track of is found on chain: listed apart, closed from there, or added back as a plan", async ({ context }) => {
    /*
     * A vault doesn't need spDEX to remember it: deleting its card, losing
     * the settings or opening another browser leaves it holding its budget
     * and buying. The chain remembers — the factory counts each owner's
     * vaults and names them in its logs — and spDEX looks there. Checked here
     * three ways: a card deleted on this page, the same vault after a reload
     * with no plan left in the config (found by the search alone), and a
     * vault this page never saw, created from the owner's key elsewhere.
     */
    const owner = await freshAccount(ETHER, { owner: true });
    const wallet = await keyWallet(context, owner);
    const page = await context.newPage();
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    const { start } = await fillVaultForm(page, "0.01", BUYS);
    await start.click();
    const card = planCard(page);
    await expect(card.getByTestId("dca-pill")).toHaveText("Buy due", { timeout: TX_TIMEOUT });
    await openTile(page, "auto-buys");
    const first = (((await card.getByTestId("dca-vault-address").textContent()) ?? "").trim()).toLowerCase();
    const held = (await vaultOnChain(first)).status.wethBalance;
    expect(held).toBeGreaterThan(0n);

    // ── Its card deleted: the warning first, then confirmed ──
    await card.getByTestId("dca-delete").click();
    await expect(card).toContainText("This vault still holds WETH and will go on buying whenever anyone triggers it.");
    // Where it goes: listed apart at once, and after this page only a search finds it.
    await expect(card).toContainText('It moves to "Vaults on chain not in your plans" below, where you can still close it');
    await expect(card).toContainText("spDEX finds it again only by searching the chain for your vaults");
    await card.getByTestId("dca-delete-confirm").click();
    await expect(planCard(page)).toHaveCount(0);

    // ── Listed apart at once, the plan gone from the config ──
    const strays = page.getByTestId("dca-strays");
    await expect(strays.getByTestId("dca-strays-title")).toHaveText("Vaults on chain not in your plans");
    const stray = page.getByTestId(`dca-stray-${first}`);
    await expect(stray.getByTestId("dca-vault-address")).toHaveText(first);
    await expect(stray.getByTestId("dca-pill")).toHaveText("Buy due");
    await expect(stray.getByTestId("dca-progress")).toContainText("0 of 3 buys");
    expect(await page.evaluate(() => window.localStorage.getItem("spdex.config.v1") ?? "")).not.toContain(first);

    // ── After a reload, with no plan pointing at it: found by the search alone ──
    await page.reload();
    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    // The Auto-buys tile appears once the search finds the vault.
    await expect(page.getByTestId("dca-panel")).toHaveCount(1, { timeout: 60_000 });
    await openTile(page, "auto-buys");
    await expect(page.getByTestId("dca-panel")).toBeVisible();
    await expect(strays.getByTestId("dca-strays-title")).toHaveText("Vaults on chain not in your plans", { timeout: 60_000 });
    await expect(stray.getByTestId("dca-vault-address")).toHaveText(first, { timeout: 60_000 });
    await expect(stray.getByTestId("dca-pill")).toHaveAttribute("data-status", "running", { timeout: 60_000 });
    await expect(stray.getByTestId("dca-progress")).toContainText("0 of 3 buys");
    const holds = /^([\d.]+) WETH · covers every buy left$/.exec(((await stray.getByTestId("dca-vault-balance").textContent()) ?? "").trim());
    expect(holds).not.toBeNull();
    expectSixDigits(parseEther(holds![1]!), held);
    // The factory counts one vault, and one was found: nothing to say about the rest.
    await expect(page.getByTestId("dca-strays-note")).toHaveCount(0);
    await expect(page.getByTestId("dca-strays-checked")).toContainText("your one vault is shown here");

    // ── Close and withdraw, from there: everything comes back as ETH ──
    const ether0 = await ethBalance(owner.address);
    await stray.getByTestId("dca-vault-close").click();
    await expect(stray.getByTestId("dca-vault-close-ask")).toContainText("comes back to your wallet as ETH");
    await stray.getByTestId("dca-vault-close-confirm").click();
    await expect(stray.getByTestId("dca-pill")).toHaveText("Closed", { timeout: TX_TIMEOUT });
    await expect(stray).toContainText("The vault is closed and sent");

    const closing = await sentTransactions(page);
    expect(closing).toHaveLength(1);
    expect(closing[0]!.to?.toLowerCase()).toBe(first);
    expect(closing[0]!.data?.toLowerCase()).toBe(encodeClose());
    expect(BigInt(closing[0]!.value ?? "0x0")).toBe(0n);
    expect(wallet.hashes).toHaveLength(2);
    const closeHash = wallet.hashes[1]!;
    expect((await eventIn(closeHash, first, "Closed")).amount).toBe(held);
    expect((await ethBalance(owner.address)) - ether0).toBe(held - (await feePaid(closeHash)));
    expect(await tokenBalance(WETH, first)).toBe(0n);
    expect(await vaultOnChain(first)).toMatchObject({ closed: true });

    // ── A vault this page never saw, from the owner's key: Look again finds it ──
    const latest = (await forkRpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const elsewhere: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy: BUY,
      interval: 86_400n,
      maxBuys: 2n,
      startAt: BigInt(latest.timestamp),
      keeperReward: (BUY * 69n) / 10_000n,
      maxSlippageBps: 300n,
    };
    const receipt = await sendAs(owner, { to: FACTORY, data: encodeCreateVault(elsewhere), value: vaultBudget(elsewhere) });
    const second = vaultsCreatedBy(FACTORY, receipt.logs)[0]!.vault;
    await page.getByTestId("dca-strays-look").click();
    const found = page.getByTestId(`dca-stray-${second}`);
    await expect(found.getByTestId("dca-vault-address")).toHaveText(second, { timeout: 60_000 });
    await expect(found.getByTestId("dca-progress")).toContainText("0 of 2 buys");

    // Once the closed vault's line is read, it goes to the one collapsed line,
    // and focus follows it there rather than falling to the page.
    await stray.getByRole("button", { name: "OK" }).click();
    await expect(stray).toHaveCount(0);
    await expect(page.getByTestId("dca-strays-closed-summary")).toHaveText("Closed vaults (1)");
    await expect(page.getByTestId("dca-strays-closed-summary")).toBeFocused();

    // ── Added back: a plan of the vault's own terms, with a normal vault card ──
    await found.getByTestId("dca-stray-add").click();
    await expect(found).toHaveCount(0);
    const back = planCard(page);
    await expect(back).toHaveCount(1);
    // The card lands among the plans, above; its notice comes into view with focus.
    await expect(back.getByTestId("dca-notice-arrived")).toBeFocused();
    await expect(back.getByTestId("dca-notice-arrived")).toContainText("Added to your plans");
    await expect(back.getByTestId("dca-notice-arrived")).toBeInViewport();
    await expect(back.getByTestId("dca-vault-address")).toHaveText(second, { timeout: 60_000 });
    await expect(back.getByTestId("dca-pill")).toHaveAttribute("data-status", "running", { timeout: 60_000 });
    await expect(back.getByTestId("dca-vault-allowance")).toHaveText(/^3% below the 10-minute average/);
    await expect(back.getByTestId("dca-vault-close")).toBeVisible();
    await expect(back.getByTestId("dca-vault-no-pause")).toBeVisible();
    // The closed one stays accounted for, collapsed, under the plans.
    await expect(page.getByTestId("dca-strays-closed-summary")).toHaveText("Closed vaults (1)");
    // Written to the config as a vault plan: paused, pointing at it, on its terms.
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("spdex.config.v1") ?? "")).toContain(second);
    const saved = JSON.parse((await page.evaluate(() => window.localStorage.getItem("spdex.config.v1"))) ?? "{}") as {
      dca: { plans: Record<string, unknown>[] };
    };
    expect(saved.dca.plans).toEqual([
      expect.objectContaining({
        signer: "vault",
        paused: true,
        vault: second,
        amountPerBuy: BUY.toString(),
        intervalSeconds: 86_400,
        maxBuys: 2,
        startAt: Number(elsewhere.startAt),
      }),
    ]);
    // Adding it back sent nothing: only the close went through the wallet.
    expect(await sentTransactions(page)).toHaveLength(1);
  });

  test("found vaults stay found through Add back, and a vault in the plans counts as shown, not as missing", async ({ context }) => {
    /*
     * Two vaults made from the owner's key, neither in the plans, and
     * Auto-buy off, as the default settings have it. Adding one back switches
     * Auto-buy on, which rebuilds the Engine: that used to wipe what the
     * search had found, the other vault included. And a vault in the plans
     * is on the page, so it counts toward the factory's count: with the
     * plans covering it, a search reads no log at all, and a service that
     * refuses logs is said to hide only what the page really doesn't show.
     */
    const owner = await freshAccount(ETHER, { owner: true });
    await keyWallet(context, owner);
    const latest = (await forkRpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const terms: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy: BUY,
      interval: 86_400n,
      maxBuys: 2n,
      startAt: BigInt(latest.timestamp),
      keeperReward: (BUY * 69n) / 10_000n,
      maxSlippageBps: 200n,
    };
    const made = async () =>
      vaultsCreatedBy(FACTORY, (await sendAs(owner, { to: FACTORY, data: encodeCreateVault(terms), value: vaultBudget(terms) })).logs)[0]!
        .vault;
    const first = await made();
    const second = await made();

    const page = await context.newPage();
    await seedConfig(page);
    const factoryLogQueries = watchFactoryLogQueries(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    const firstStray = page.getByTestId(`dca-stray-${first}`);
    const secondStray = page.getByTestId(`dca-stray-${second}`);
    await expect(firstStray.getByTestId("dca-pill")).toHaveAttribute("data-status", "running", { timeout: 60_000 });
    await expect(secondStray.getByTestId("dca-pill")).toHaveAttribute("data-status", "running", { timeout: 60_000 });
    await openTile(page, "auto-buys");
    await expect(page.getByTestId("dca-strays-checked")).toContainText("all 2 of your vaults are shown here");
    expect((await savedConfig(page)).dca.enabled).toBe(false);
    expect(factoryLogQueries.length).toBeGreaterThan(0);
    const searched = factoryLogQueries.length;

    // ── Add back, with Auto-buy off: the other vault stays listed throughout ──
    await page.evaluate((testId) => {
      const flags = window as unknown as { strayGone?: boolean };
      flags.strayGone = false;
      new MutationObserver(() => {
        if (document.querySelector(`[data-testid="${testId}"]`) === null) flags.strayGone = true;
      }).observe(document.body, { childList: true, subtree: true });
    }, `dca-stray-${second}`);
    await firstStray.getByTestId("dca-stray-add").click();
    const card = planCard(page);
    await expect(card.getByTestId("dca-vault-address")).toHaveText(first, { timeout: 60_000 });
    await expect(card.getByTestId("dca-notice-arrived")).toBeFocused();
    await expect(card.getByTestId("dca-pill")).toHaveAttribute("data-status", "running", { timeout: 60_000 });
    // Auto-buy was switched on: the Engine was rebuilt.
    await expect.poll(async () => (await savedConfig(page)).dca.enabled).toBe(true);
    await expect(secondStray.getByTestId("dca-pill")).toHaveAttribute("data-status", "running");
    expect(await page.evaluate(() => (window as unknown as { strayGone?: boolean }).strayGone)).toBe(false);

    // ── Look again: the plan's vault and the listed one are both of them, so no log is read ──
    await refuseFactoryLogs(page);
    // The count read at the block the search would read logs to: after it,
    // a search either reads logs or has none to read.
    const counted = page.waitForResponse((response) => {
      const body = rpcBody(response.request().postData());
      return body?.method === "eth_call" && firstParam(body)?.to === FACTORY && body.params?.[1] !== "latest";
    });
    await openTile(page, "auto-buys");
    await page.getByTestId("dca-strays-look").click();
    await counted;
    await expect(page.getByTestId("dca-strays-look")).toHaveText("Look again");
    await expect(page.getByTestId("dca-strays-checked")).toContainText("all 2 of your vaults are shown here");
    await expect(page.getByTestId("dca-strays-note")).toHaveCount(0);
    expect(factoryLogQueries.length).toBe(searched);
    await page.close();

    // ── A fresh page with the plan and a service that refuses the factory's logs ──
    // The log search stops short, and its fallback, the factory's own list
    // (each listed vault's owner, read through Multicall3), finds the other
    // vault: both are shown, and nothing is said to be missing.
    const plan = {
      id: `vault-${first.slice(2, 12)}`,
      paused: true,
      chainId: FORK_CHAIN_ID,
      sell: NATIVE_ETH,
      buy: SPX,
      amountPerBuy: BUY.toString(),
      intervalSeconds: 86_400,
      maxBuys: 2,
      startAt: Number(terms.startAt),
      signer: "vault",
      vault: first,
    };
    const listed = await context.newPage();
    await seedConfig(listed, { dca: { enabled: false, plans: [plan] }, preset: "custom" });
    await refuseFactoryLogs(listed);
    await listed.goto("/");
    await openTile(listed, "trade");
    await listed.getByTestId("connect-button").click();
    await openTile(listed, "auto-buys");
    await expect(planCard(listed).getByTestId("dca-vault-address")).toHaveText(first, { timeout: 60_000 });
    await expect(listed.getByTestId(`dca-stray-${second}`).getByTestId("dca-pill")).toHaveAttribute("data-status", "running", {
      timeout: 60_000,
    });
    await expect(listed.getByTestId("dca-strays-checked")).toContainText("all 2 of your vaults are shown here");
    await expect(listed.getByTestId("dca-strays-note")).toHaveCount(0);
    await listed.close();

    // ── And a service that refuses the list as well ──
    // The plan's vault is on the page; only the other one is missing, and the
    // note says so, with what to do and the service's own words in Details.
    const again = await context.newPage();
    await seedConfig(again, { dca: { enabled: false, plans: [plan] }, preset: "custom" });
    await refuseFactoryLogs(again);
    await refuseFactoryList(again);
    await again.goto("/");
    await openTile(again, "trade");
    await again.getByTestId("connect-button").click();
    await openTile(again, "auto-buys");
    await expect(planCard(again).getByTestId("dca-vault-address")).toHaveText(first, { timeout: 60_000 });
    const note = again.getByTestId("dca-strays-note");
    await expect(note.getByTestId("dca-strays-note-text")).toHaveText(
      /^1 of your 2 vaults isn't shown here: this network service wouldn't let spDEX search the vault factory's records\./,
      { timeout: 60_000 },
    );
    await expect(note).toContainText("A vault keeps what it holds whether spDEX shows it or not");
    await expect(note.getByTestId("goto-networkService")).toHaveText("Change service");
    await expect(note.getByTestId("dca-strays-factory")).toHaveText(FACTORY);
    await expect(note.locator("details code")).toContainText("query exceeds max block range");
    // Not a tab plan in sight: no tab's heartbeat, and the vaults' subtitle.
    await expect(again.getByTestId("dca-heartbeat")).toHaveCount(0);
    await expect(again.getByTestId("dca-panel")).toContainText("Vaults buy whenever anyone triggers a due buy");
    await again.close();
  });
});

/** A JSON-RPC request's body, or null for anything else. */
function rpcBody(text: string | null): { id?: unknown; method?: string; params?: ({ address?: string; to?: string } | string)[] } | null {
  try {
    const body = JSON.parse(text ?? "null") as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as ReturnType<typeof rpcBody>) : null;
  } catch {
    return null;
  }
}

/** The first param of a JSON-RPC request, when it is an object: a call, or a log filter, with its addresses lowercase. */
const firstParam = (body: ReturnType<typeof rpcBody>): { address: string | undefined; to: string | undefined } | undefined => {
  const first = body?.params?.[0];
  if (first === null || typeof first !== "object") return undefined;
  // A log filter may name several addresses; the vault factory's are always one.
  const text = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : undefined);
  return { address: text(first.address), to: text(first.to) };
};

/** Every `eth_getLogs` the page asks of the vault factory, as it asks it. */
function watchFactoryLogQueries(page: Page): unknown[] {
  const queries: unknown[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(FORK_URL)) return;
    const body = rpcBody(request.postData());
    if (body?.method === "eth_getLogs" && firstParam(body)?.address === FACTORY) queries.push(firstParam(body));
  });
  return queries;
}

/** A network service that refuses every log query of the vault factory, as a hosted one capping ranges does. */
async function refuseFactoryLogs(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.startsWith(FORK_URL),
    async (route) => {
      const body = rpcBody(route.request().postData());
      if (body?.method !== "eth_getLogs" || firstParam(body)?.address !== FACTORY) return route.fallback();
      return route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "query exceeds max block range" } }),
      });
    },
  );
}

/**
 * `vaultsPage(uint256,uint256)`'s selector: the factory's list, which the
 * vault search reads through Multicall3 when the log search stops short.
 */
const VAULTS_PAGE_SELECTOR = "ab7ec471";

/** A network service that also refuses every read of the factory's list, so the log search's gap stays a gap. */
async function refuseFactoryList(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.startsWith(FORK_URL),
    async (route) => {
      const body = rpcBody(route.request().postData());
      const call = body?.params?.[0];
      const data = call !== null && typeof call === "object" ? (call as { data?: string }).data : undefined;
      if (body?.method !== "eth_call" || data === undefined || !data.toLowerCase().includes(VAULTS_PAGE_SELECTOR)) return route.fallback();
      return route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "rate limited" } }),
      });
    },
  );
}

/** The config the page saved. */
async function savedConfig(page: Page): Promise<{ dca: { enabled: boolean } }> {
  return JSON.parse((await page.evaluate(() => window.localStorage.getItem("spdex.config.v1"))) ?? "{}") as { dca: { enabled: boolean } };
}
