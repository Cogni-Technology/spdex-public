/**
 * A vault at the shortest interval there is, five minutes, run to its end by
 * the keeper: the owner agent creates it through the app (Expert view, How
 * often → Custom… → 5 minutes, three buys), and the keeper agent's
 * `keeperTick` makes every buy as it falls due, paying each buy fee to the
 * holder agent. Nobody clicks Trigger now. This is a set-and-forget plan
 * watched from start to finish in about twelve minutes.
 *
 * A v2 vault, with the app's default community window for it: a quarter of
 * the interval, 75 seconds. The app holds a five-minute plan's first buy back
 * by 105 seconds (`vaultStartLead`), so that a creation slow to land still
 * finds a minute of the first buy's window; the vault is created first and
 * its first buy falls due after. The keeper's `rewardTo` is the holder agent,
 * a community keeper (`3-prove`), so it makes each buy as soon as it is due,
 * inside its window.
 *
 * On mainnet, after a window ends anyone may make the buy, and a bot may beat
 * a keeper that is late. Such a buy is reported, not failed: it is v2 working
 * as designed. What fails is a buy inside its window paid to anyone but the
 * holder agent, the owner, or an address the registry found eligible: the
 * vault must never pay one. Because a buy taken by someone else can make the
 * keeper's batch in flight revert, the keeper may send one batch more than
 * there are buys.
 *
 * What it checks besides: the vault keeps its spacing (no buy before its slot
 * opens, none sooner than half an interval after the last), the keeper sends
 * a five-minute plan as soon as it is due rather than waiting for cheap gas
 * (`shortIntervalSeconds`), and the owner's card ends at "3 of 3 buys", Done,
 * with nothing left in the vault.
 */

import {
  CURRENT_SOURCE,
  DEFAULT_TURN_BUCKETS,
  VAULT_EVENT_TOPICS,
  decodeVaultEvent,
  defaultCommunityWindow,
  vaultBudget,
  type VaultEvent,
} from "../packages/vault/src/index.js";
import { expect, openTile, seedConfig, test } from "../e2e/fixtures.js";
import { planCard } from "../e2e/vaults.js";
import { BATCHER, FACTORY, REGISTRY, SPX, WETH, ethBalance, feeOf, headBlock, minedReceipt, rpc, settings, tokenBalance } from "./chain.js";
import { runKeeper } from "./keeper.js";
import { HOLDER, eth } from "./settings.js";
import { closeOpenVaults, eventIn, fillExpertVaultForm, vaultOnChain } from "./vaults.js";
import { MINED_WITHIN_MS, agents, pageWallet, requireHolderEligible, settleMined } from "./wallet.js";

type Hex = `0x${string}`;
type Bought = Extract<VaultEvent, { name: "Bought" }>;

test.afterAll(async () => {
  await closeOpenVaults();
  await settleMined();
});

const BUYS = 3;
const INTERVAL = 300n;
const UI_WAIT = () => MINED_WITHIN_MS() + 60_000;

/**
 * Every `Bought` the vault emitted from block `from` on, with who sent each
 * and when: read ten blocks a request, the most a free plan's log search
 * allows (Alchemy's), since an outside caller's buy is in no receipt of ours.
 */
async function boughtLogs(vault: Hex, from: bigint): Promise<{ bought: Bought; at: bigint; from: Hex; to: Hex | null; hash: Hex }[]> {
  const head = await headBlock();
  const found = [];
  for (let first = from; first <= head; first += 10n) {
    const last = first + 9n < head ? first + 9n : head;
    const logs = (await rpc("eth_getLogs", [
      { fromBlock: `0x${first.toString(16)}`, toBlock: `0x${last.toString(16)}`, address: vault, topics: [VAULT_EVENT_TOPICS[CURRENT_SOURCE].Bought] },
    ])) as { address: Hex; topics: Hex[]; data: Hex; blockNumber: string; transactionHash: Hex }[];
    for (const log of logs) {
      const bought = decodeVaultEvent(log);
      if (bought?.name !== "Bought" || bought.emitter !== vault) continue;
      const [block, tx] = (await Promise.all([
        rpc("eth_getBlockByNumber", [log.blockNumber, false]),
        rpc("eth_getTransactionByHash", [log.transactionHash]),
      ])) as [{ timestamp: string }, { from: string; to: string | null }];
      found.push({ bought, at: BigInt(block.timestamp), from: tx.from.toLowerCase() as Hex, to: (tx.to?.toLowerCase() ?? null) as Hex | null, hash: log.transactionHash });
    }
  }
  return found.sort((a, b) => Number(a.bought.buyNumber - b.bought.buyNumber));
}

/** The registry's `isEligible(who)` at the state before block `block`: whether a buy in that block could pay it inside its window. */
async function wasEligible(who: string, block: bigint): Promise<boolean> {
  const raw = (await rpc("eth_call", [{ to: REGISTRY, data: `0x66e305fd${who.replace(/^0x/, "").padStart(64, "0")}` }, `0x${(block - 1n).toString(16)}`])) as string;
  return /^0x0*1$/.test(raw);
}

test("a five-minute v2 vault is run to its end by the keeper, each buy inside its community window", async ({ page, context }) => {
  // The held-back first buy, two intervals, a buy's mining each, and the page either side.
  test.setTimeout(40 * 60_000);
  const { owner, keeper } = agents();
  const holder = agents()[HOLDER];
  await requireHolderEligible();
  const wallet = await pageWallet(context, owner, "every 5 minutes: create and fund");
  await seedConfig(page);
  // The custom interval is in the Expert view only.
  await page.addInitScript(() => window.localStorage.setItem("spdex.view.v1", "expert"));
  await page.goto("/");
  await openTile(page, "trade");

  // ── Created through the app, every five minutes ──
  const { start, forBuys } = await fillExpertVaultForm(page, eth(settings.buyWei), BUYS, 5);
  expect(forBuys).toBe(BigInt(BUYS) * settings.buyWei);
  const ether0 = await ethBalance(owner.address);
  await start.click();
  const card = planCard(page);
  await openTile(page, "auto-buys");

  // Created and funded in one confirmation. Its first buy is held back, so the card waits for it, not "Buy due".
  await expect.poll(() => wallet.hashes.length, { timeout: UI_WAIT() }).toBe(1);
  const creation = await minedReceipt(wallet.hashes[0]!, MINED_WITHIN_MS());
  const created = eventIn(creation, FACTORY, "VaultCreated");
  const vault = created.vault.toLowerCase() as Hex;
  expect(created.owner).toBe(owner.address);
  await expect(card.getByTestId("dca-vault-address")).toHaveText(vault, { timeout: UI_WAIT() });
  const { terms } = created;
  expect(terms).toMatchObject({
    tokenOut: SPX,
    amountPerBuy: settings.buyWei,
    interval: INTERVAL,
    maxBuys: BigInt(BUYS),
    communityWindow: defaultCommunityWindow(INTERVAL),
    turnBuckets: DEFAULT_TURN_BUCKETS,
  });
  expect(terms.communityWindow).toBe(75n);
  const communityWindow = terms.communityWindow!;
  const createdAt = BigInt(((await rpc("eth_getBlockByNumber", [creation.blockNumber, false])) as { timestamp: string }).timestamp);
  test.info().annotations.push({ type: "first buy held back", description: `${terms.startAt - createdAt} s after the creation's block` });
  const budget = vaultBudget(terms);
  expect(created.funded).toBe(budget);
  expect(ether0 - (await ethBalance(owner.address))).toBe(budget + feeOf(creation));

  // ── The keeper, paying the holder agent, from here to the end ──
  const [spx0, weth0] = await Promise.all([tokenBalance(SPX, owner.address), tokenBalance(WETH, holder.address)]);
  const run = await runKeeper({
    vaults: [vault],
    rewardTo: holder.address,
    // One more than the buys: a buy taken by someone else after its window can revert the batch in flight.
    maxSends: BUYS + 1,
    what: "every 5 minutes: one keeper batch",
    timeoutMs: 30 * 60_000,
    done: async () => (await vaultOnChain(vault)).buysDone >= BigInt(BUYS),
  });

  // Every buy, the keeper's and anyone else's, from the vault's own logs.
  const buys = await boughtLogs(vault, BigInt(creation.blockNumber));
  expect(buys.map(({ bought }) => bought.buyNumber)).toEqual(Array.from({ length: BUYS }, (_, i) => BigInt(i + 1)));
  const ours = new Set(run.mined.filter((batch) => batch.status === "success").map((batch) => batch.hash.toLowerCase()));
  const outside: string[] = [];
  const late: string[] = [];
  let ourBuys = 0n;
  for (const [i, { bought, at, from, to, hash }] of buys.entries()) {
    expect(bought).toMatchObject({ source: CURRENT_SOURCE, amountIn: settings.buyWei, reward: terms.keeperReward });
    expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
    // Never before its slot opens, never sooner than half an interval after the last.
    expect(at).toBeGreaterThanOrEqual(terms.startAt + BigInt(i) * INTERVAL);
    if (i > 0) expect(at - buys[i - 1]!.at).toBeGreaterThanOrEqual(INTERVAL / 2n);
    const inWindow = at < bought.dueSince! + communityWindow;
    const keepers = ours.has(hash.toLowerCase()) && from === keeper.address && to === BATCHER;
    if (keepers) {
      ourBuys += 1n;
      expect(bought).toMatchObject({ keeper: BATCHER, rewardTo: holder.address });
      if (!inWindow) late.push(`buy ${i + 1}: the keeper's, ${at - bought.dueSince!} s after it was due, past its ${communityWindow} s window`);
      continue;
    }
    if (inWindow) {
      // Inside a window the vault pays only its owner or a community keeper: anything else is a bug in the vault.
      const allowed = bought.rewardTo === owner.address || bought.rewardTo === holder.address || (await wasEligible(bought.rewardTo, BigInt(await txBlock(hash))));
      expect(allowed, `buy ${i + 1} (${hash}) paid ${bought.rewardTo} inside its community window`).toBe(true);
    }
    outside.push(`buy ${i + 1}: by ${from} in ${hash}, paid to ${bought.rewardTo}, ${at - bought.dueSince!} s after it was due (${inWindow ? "inside" : "after"} its window)`);
  }
  // Reported, not failed: after its window anyone may make a buy, and a late keeper may lose it.
  for (const line of [...outside, ...late]) console.log(`  ${line}`);
  test.info().annotations.push({ type: "buys made by others", description: outside.length === 0 ? "none" : outside.join("; ") });
  if (late.length > 0) test.info().annotations.push({ type: "keeper buys after their window", description: late.join("; ") });
  const lateness = buys.map(({ at, bought }) => Number(at - bought.dueSince!));
  test.info().annotations.push({ type: "seconds after each buy fell due", description: lateness.join(", ") });

  expect(ourBuys).toBeGreaterThan(0n);
  expect((await tokenBalance(SPX, owner.address)) - spx0).toBe(buys.reduce((sum, { bought }) => sum + bought.amountOut, 0n));
  // The holder agent is paid for the keeper's buys, and only those.
  expect((await tokenBalance(WETH, holder.address)) - weth0).toBe(ourBuys * terms.keeperReward);
  expect(await vaultOnChain(vault)).toMatchObject({ closed: false, buysDone: BigInt(BUYS), status: { wethBalance: 0n } });

  // ── What the owner sees ──
  await openTile(page, "auto-buys");
  await expect(card.getByTestId("dca-progress")).toContainText(`${BUYS} of ${BUYS} buys`, { timeout: 120_000 });
  await expect(card.getByTestId("dca-pill")).toHaveText("Done");
  await expect(card.getByTestId("dca-status")).toContainText(`Finished: ${BUYS} of ${BUYS} bought.`);
  expect(wallet.hashes).toHaveLength(1);
});

/** The block a mined transaction is in. */
async function txBlock(hash: string): Promise<string> {
  const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { blockNumber: string };
  return receipt.blockNumber;
}
