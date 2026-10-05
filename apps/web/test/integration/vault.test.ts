/**
 * Vault plans on the fork, through the app's own layer (lib/dca/vault.ts) and
 * the real Engine: whether a vault can be offered, the chain's clock, and the
 * four transactions — created with one buy's budget, a buy triggered from the
 * owner's wallet, funded with the rest, closed — each built by the app,
 * checked by the vault Guard with a real simulation (`requireSimulation` on,
 * so a check that didn't simulate cannot pass as one that did), sent, and
 * then read back the way a card reads it. A stranger's view of the same vault
 * is read too, and the history's logs are checked against the vault's count.
 *
 * `packages/vault` proves the contracts and its own encoders; this proves the
 * app builds what they accept, reads them the way the card needs, and leaves
 * nothing but gas behind: every wei put in comes back as SPX bought, the
 * buy fee paid back to the owner who triggered, or ether at the close.
 *
 * Both releases. The app creates v2 vaults alone, with the plan's community
 * window, and its owner's Trigger now sends `execute(owner)`, which the window
 * never refuses: the buy is made inside it. A v1 vault, made on v1's frozen
 * factory (deployed on the fork from its own source, `deployReleaseCalls`),
 * is still read, funded, triggered with v1's `execute()` and closed by the
 * same app, through the same Engine: no move to v2 (decision 27).
 *
 * The fork's clock is never moved: the plan starts at the chain's own time,
 * so the first buy is due as soon as the vault exists, and a second is not
 * tried (it would mean waiting out half an interval in real time). Every
 * address is fresh; see packages/chain/test/integration/local-key.test.ts
 * for why never a dev account. Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  NATIVE_TOKEN,
  TOKENS,
  addressOfKey,
  generateSpendingKey,
  httpRpc,
  prepareTransaction,
  readFees,
  signPrepared,
} from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, DcaPlan, Hex, SpdexConfig } from "@spdex/core";
import {
  MAINNET_DEPLOYMENT,
  V1_MAINNET_FACTORY,
  deployReleaseCalls,
  factoryAddress,
  readVaultNonce,
  simulateFactoryDeployment,
  v1BuyFee,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultRelease,
} from "@spdex/vault";
import { Engine } from "../../src/lib/engine.js";
import { communityWindowLiveText } from "../../src/components/dca/vaultCopy.js";
import { balanceOf } from "../../src/lib/erc20.js";
import type { TxSender } from "../../src/lib/execute.js";
import {
  closeVault,
  createVault,
  defaultVaultWindow,
  deployVaultFactory,
  factoryRefusalBeforeRegistry,
  fundVault,
  readChainClock,
  readVaultHistory,
  readVaultPlan,
  readVaultSupport,
  settleCreation,
  triggerVault,
  vaultCardStatus,
  vaultCosts,
  vaultPlanOf,
  type VaultChoices,
  type VaultOpDeps,
  type VaultPlanState,
} from "../../src/lib/dca/vault.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const AMOUNT = ETHER / 100n;
const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** A key nobody has used, given `amount` of ether. Only fresh addresses are ever given a balance. */
async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

/** The owner's wallet, as the app sees one: a sender that signs, here with a local key. */
function walletOf(key: Hex): TxSender {
  const account = addressOfKey(key);
  return {
    account,
    kind: "wallet",
    confirm: { rpc, timeoutMs: 60_000 },
    async send(call) {
      const tx = await prepareTransaction(rpc, { from: account, to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
      const { raw, hash } = await signPrepared(key, tx);
      await rpc("eth_sendRawTransaction", [raw]);
      return { hash, via: "endpoint" };
    },
  };
}

const etherOf = async (address: Address) => BigInt((await rpc("eth_getBalance", [address, "latest"])) as string);

/** Send from a local key and wait for its receipt, which must succeed. */
async function sendOk(key: Hex, to: Address, data: Hex, value = 0n): Promise<{ logs: RawLog[] }> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, prepared);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string; logs: RawLog[] } | null;
    if (receipt) {
      expect(BigInt(receipt.status)).toBe(1n);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

/**
 * A release's contracts on the fork, deployed the way anyone would
 * (`deployReleaseCalls`, in the order their constructors need) where they
 * aren't yet. Another suite may deploy one first, even between the check and
 * the send; the code is there either way, and that is what is checked.
 */
async function ensureRelease(release: VaultRelease): Promise<void> {
  for (const call of deployReleaseCalls(release)) {
    if (((await rpc("eth_getCode", [call.address, "latest"])) as string) !== "0x") continue;
    const deployer = await freshAccount(ETHER);
    await sendOk(deployer.key, call.to, call.data).catch(() => undefined);
    expect((await rpc("eth_getCode", [call.address, "latest"])) as string, `${release}'s ${call.name}`).not.toBe("0x");
  }
}

describe("a v2 vault plan's life on the fork, through the app", () => {
  const config: SpdexConfig = {
    ...recommendedConfig(),
    chainId: CHAIN_ID,
    rpc: { url: FORK_URL, source: "user" },
    guard: { ...recommendedConfig().guard, requireSimulation: true },
  };
  const engine = new Engine(config);
  const factory = factoryAddress(MAINNET_DEPLOYMENT);

  let owner: { key: Hex; address: Address };
  let stranger: { key: Hex; address: Address };
  let plan: DcaPlan;
  let choices: VaultChoices;
  let deps: VaultOpDeps;
  let creationHash: Hex;
  let vault: Address;
  const perBuy = () => AMOUNT + choices.keeperReward;

  const read = async (account: Address | null = owner.address): Promise<VaultPlanState> =>
    readVaultPlan(rpc, { plan, chainId: CHAIN_ID, account });

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureRelease("v2");
    owner = await freshAccount(ETHER);
    stranger = await freshAccount(ETHER / 10n);
    deps = { engine, sender: walletOf(owner.key), chainId: CHAIN_ID };
  });

  it("offers a vault here: the factory the Guard holds creations to is deployed, and its market healthy", async () => {
    expect(engine.vaultFactory).toBe(factory);
    const support = await readVaultSupport(rpc, CHAIN_ID);
    expect(support).toMatchObject({ kind: "available", factory });
    // Its deployment is offered only where it is absent: here it is refused before anything is sent.
    await expect(deployVaultFactory({ rpc, sender: walletOf(stranger.key), chainId: CHAIN_ID })).rejects.toThrow(/already deployed/);
  });

  /**
   * Where neither the registry nor the factory is deployed, the factory's
   * market checks are test-run as if the registry were there (a state
   * override), so a refused market is found before the registry is paid for.
   * Read-only: eth_calls against the fork, nothing sent.
   */
  it("test-runs a factory's markets as if its registry were already there, before anything is paid for", async () => {
    const nowhere = addressOfKey(generateSpendingKey());
    expect(await rpc("eth_getCode", [nowhere, "latest"])).toBe("0x");
    const market = MAINNET_DEPLOYMENT.markets[0]!;
    const broken = { ...MAINNET_DEPLOYMENT, registry: nowhere, markets: [{ ...market, pair: nowhere }] };
    // As it is, the constructor stops at the missing registry, and says nothing of the market.
    expect(await simulateFactoryDeployment(rpc, broken)).toMatchObject({ deployable: false, error: { name: "NotARegistry" } });
    // As if the registry were there, it reaches the market and refuses it.
    expect(await factoryRefusalBeforeRegistry(rpc, broken, nowhere)).toBe("market 0's pair is not the one Uniswap v2 lists on this chain");
    // The real market passes.
    expect(await factoryRefusalBeforeRegistry(rpc, { ...MAINNET_DEPLOYMENT, registry: nowhere }, nowhere)).toBeNull();
  });

  it("creates the plan's vault with one buy's budget and its community window, in chain time, where the Guard predicted", async () => {
    // Chain time, not the wall clock: the fork lags it by days, and a start in
    // wall-clock time would put the first buy there.
    const clock = await readChainClock(rpc);
    const costs = vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 3, fees: await readFees(rpc) });
    expect(costs).not.toBeNull();
    // An hourly plan's default window: a quarter of the interval, 15 minutes,
    // long enough that the owner's buy below is surely made inside it.
    const communityWindow = defaultVaultWindow(3_600)!;
    expect(communityWindow).toBe(900);
    choices = { maxSlippageBps: 300, keeperReward: costs!.fee.reward, communityWindow };
    plan = {
      id: "dca-vault-fork",
      paused: true,
      chainId: CHAIN_ID,
      sell: NATIVE_TOKEN,
      buy: SPX,
      amountPerBuy: AMOUNT.toString(),
      intervalSeconds: 3_600,
      maxBuys: 3,
      startAt: clock.seconds,
      signer: "vault",
    };
    const nonce = await readVaultNonce(rpc, factory, owner.address);
    let prepared: { vault: Address; nonce: bigint } | null = null;
    const created = await createVault(
      { ...deps, onPrepared: (p) => void (prepared = p), onSent: (hash) => void (creationHash = hash) },
      { plan, choices, fund: perBuy() },
    );
    expect(created.verdict).toMatchObject({ level: "verified", violations: [] });
    expect(prepared).toEqual({ vault: created.vault, nonce });
    expect(created.hash).toBe(creationHash);
    // The receipt's own word: `createVault` records no guessed address.
    expect(created.vault).not.toBeNull();
    vault = created.vault!;
    // What the app records, and how it would find it again had the tab closed.
    plan = { ...plan, vault };
    const settled = await settleCreation(rpc, {
      plan,
      creation: { owner: owner.address, vault, factory, nonce: nonce.toString(), hash: creationHash, at: Date.now() },
      nowMs: Date.now(),
    });
    expect(settled).toEqual({ kind: "created", vault });
    // One recorded before releases were told apart, without its factory, settles too.
    const older = await settleCreation(rpc, {
      plan,
      creation: { owner: owner.address, vault, nonce: nonce.toString(), hash: creationHash, at: Date.now() },
      nowMs: Date.now(),
    });
    expect(older).toEqual({ kind: "created", vault });
  });

  it("reads the new vault as its card needs it: the owner's, one buy funded, due now", async () => {
    const state = await read();
    expect(state.kind).toBe("active");
    if (state.kind !== "active") return;
    expect(state).toMatchObject({
      mine: true,
      owner: owner.address,
      closed: false,
      buysDone: 0,
      maxBuys: 3,
      buysLeft: 3,
      spent: 0n,
      received: 0n,
      balance: perBuy(),
      funded: true,
      fundingRoom: 2n * perBuy(),
      mismatches: [],
      fromFactory: true,
      release: "v2",
      factory,
      communityWindow: 900,
      windowBuys: 0,
    });
    expect(state.terms).toMatchObject({
      amountPerBuy: AMOUNT,
      startAt: BigInt(plan.startAt),
      keeperReward: choices.keeperReward,
      communityWindow: 900n,
    });
    // Due since its start, the window running fifteen minutes from there.
    expect(state.dueSince).toBe(plan.startAt);
    expect(state.windowEndsAt).toBe(plan.startAt + 900);
    expect(state.canTrigger).toBe(true);
    expect(state.clock).not.toBeNull();
    expect(vaultCardStatus(state, state.clock!.seconds)).toMatchObject({ vault: "due", pillLabel: "Buy due" });
    // The card's line while the buy is inside its window.
    expect(communityWindowLiveText(state, state.clock!.seconds, Date.now())).toMatch(/^Community window until \d\d:\d\d, then open to anyone\.$/);
    // A stranger's view of the same vault is read-only.
    expect((await read(stranger.address)).kind).toBe("someone-else");
  });

  it("makes the due buy from the owner's wallet inside its window: SPX at the owner at or above the floor, the buy fee back to them", async () => {
    const before = await read();
    if (before.kind !== "active" || before.quote === null) throw new Error("the vault could not be read");
    // Trigger now inside the community window: execute(owner), which the window never refuses.
    expect(before.clock!.seconds).toBeLessThan(before.windowEndsAt!);
    const spxBefore = await balanceOf(rpc, SPX, owner.address);
    const wethBefore = await balanceOf(rpc, WETH, owner.address);
    const bought = await triggerVault(deps, { plan });
    expect(bought.received).not.toBeNull();
    expect(bought.received!).toBeGreaterThanOrEqual(before.quote.floorOut);
    expect(bought.reward).toBe(choices.keeperReward);
    expect((await balanceOf(rpc, SPX, owner.address)) - spxBefore).toBe(bought.received);
    expect((await balanceOf(rpc, WETH, owner.address)) - wethBefore).toBe(choices.keeperReward);

    const after = await read();
    expect(after).toMatchObject({ kind: "active", buysDone: 1, spent: AMOUNT, received: bought.received, rewardsPaid: choices.keeperReward, balance: 0n, funded: false });
    // Paid back to its owner: no community keeper's buy, so the window count stays where it was.
    expect(after).toMatchObject({ windowBuys: 0 });
    // Not due again: the app refuses before asking the wallet anything.
    await expect(triggerVault(deps, { plan })).rejects.toThrow(/won't buy right now/);
  });

  it("finds the buy in the vault's logs, says its owner made it, and misses nothing", async () => {
    const history = await readVaultHistory(rpc, {
      vault,
      buysDone: 1,
      startAt: plan.startAt,
      chainId: CHAIN_ID,
      owner: owner.address,
      communityWindow: 900n,
    });
    expect(history.missingBuys).toBe(0);
    expect(history.note).toBeNull();
    const buys = history.entries.filter((entry) => entry.kind === "bought");
    expect(buys).toHaveLength(1);
    const owned = owner.address.toLowerCase();
    expect(buys[0]).toMatchObject({
      amountIn: AMOUNT,
      keeper: owned,
      reward: choices.keeperReward,
      source: "v2",
      rewardTo: owned,
      dueSince: plan.startAt,
      communityWindow: 900,
      maker: "owner",
    });
    expect(buys[0]!.at).not.toBeNull();
  });

  it("funds what the remaining buys need, and no more", async () => {
    const funded = await fundVault(deps, { plan });
    expect(funded.amount).toBe(2n * perBuy());
    expect(await read()).toMatchObject({ kind: "active", balance: 2n * perBuy(), funded: true, fundingRoom: 0n });
    await expect(fundVault(deps, { plan })).rejects.toThrow(/already holds what its remaining buys/);
    // Only the owner funds or closes; a stranger is stopped before any wallet is asked.
    const theirs = { ...deps, sender: walletOf(stranger.key) };
    await expect(fundVault(theirs, { plan, amount: 1n })).rejects.toThrow(/Only the vault's owner/);
    await expect(closeVault(theirs, { plan })).rejects.toThrow(/Only the vault's owner/);
  });

  it("closes it: everything it held comes back to the owner as ether, and the card says so", async () => {
    const etherBefore = await etherOf(owner.address);
    const closed = await closeVault(deps, { plan });
    expect(closed.returned).toBe(2n * perBuy());
    const etherAfter = await etherOf(owner.address);
    // Back as ether, less the close's own gas.
    expect(etherAfter - etherBefore).toBeGreaterThan(2n * perBuy() - ETHER / 1_000n);
    expect(etherAfter - etherBefore).toBeLessThanOrEqual(2n * perBuy());
    const state = await read();
    expect(state).toMatchObject({ kind: "active", closed: true, balance: 0n, fundingRoom: 0n, canTrigger: false });
    expect(vaultCardStatus(state, null)).toMatchObject({ vault: "closed", pill: "done" });
    // Every wei the budget came to is accounted for: one buy, its buy fee, the rest back.
    expect(vaultBudget(vaultPlanOf(plan, choices))).toBe(3n * perBuy());
  });
});

/**
 * A v1 vault, made on v1's frozen factory before the app moved to v2, is the
 * app's to show, fund, trigger and close as it always was: read from the
 * factory that vouches for it, claimed as v1, its buy v1's `execute()`,
 * which pays whoever sends it — the owner, here.
 */
describe("a v1 vault plan on the fork, through the app that creates v2", () => {
  const config: SpdexConfig = {
    ...recommendedConfig(),
    chainId: CHAIN_ID,
    rpc: { url: FORK_URL, source: "user" },
    guard: { ...recommendedConfig().guard, requireSimulation: true },
  };
  const engine = new Engine(config);
  const keeperReward = v1BuyFee(AMOUNT).reward;
  const perBuy = AMOUNT + keeperReward;

  let owner: { key: Hex; address: Address };
  let deps: VaultOpDeps;
  let plan: DcaPlan;

  const read = async (): Promise<VaultPlanState> => readVaultPlan(rpc, { plan, chainId: CHAIN_ID, account: owner.address });

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureRelease("v1");
    owner = await freshAccount(ETHER);
    deps = { engine, sender: walletOf(owner.key), chainId: CHAIN_ID };
    const clock = await readChainClock(rpc);
    // v1's `createVault(uint256 × 7)`, hand-encoded: the app has no way to
    // make one, and shouldn't. The factory's own `VaultCreated`, read as v1's,
    // is what pins it. Funded for one buy.
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const create = `0x3f8f7b79${[0n, AMOUNT, 3_600n, 3n, BigInt(clock.seconds), keeperReward, 300n].map(word).join("")}` as Hex;
    const receipt = await sendOk(owner.key, V1_MAINNET_FACTORY, create, perBuy);
    const [created] = vaultsCreatedBy(V1_MAINNET_FACTORY, receipt.logs);
    expect(created).toMatchObject({ source: "v1", owner: owner.address.toLowerCase(), terms: { communityWindow: null, turnBuckets: null } });
    plan = {
      id: "dca-vault-fork-v1",
      paused: true,
      chainId: CHAIN_ID,
      sell: NATIVE_TOKEN,
      buy: SPX,
      amountPerBuy: AMOUNT.toString(),
      intervalSeconds: 3_600,
      maxBuys: 3,
      startAt: clock.seconds,
      signer: "vault",
      vault: created!.vault,
    };
  });

  it("shows it as v1's: vouched for by v1's factory, no community window, due now", async () => {
    const state = await read();
    expect(state).toMatchObject({
      kind: "active",
      mine: true,
      release: "v1",
      factory: V1_MAINNET_FACTORY,
      fromFactory: true,
      communityWindow: null,
      dueSince: null,
      windowEndsAt: null,
      windowBuys: null,
      balance: perBuy,
      mismatches: [],
      canTrigger: true,
    });
    if (state.kind !== "active") return;
    // Its card is unchanged: no window line.
    expect(communityWindowLiveText(state, state.clock!.seconds, Date.now())).toBeNull();
  });

  it("triggers its due buy with v1's execute(), the buy fee to the owner who sent it", async () => {
    const wethBefore = await balanceOf(rpc, WETH, owner.address);
    const bought = await triggerVault(deps, { plan });
    expect(bought.reward).toBe(keeperReward);
    expect((await balanceOf(rpc, WETH, owner.address)) - wethBefore).toBe(keeperReward);
    expect(await read()).toMatchObject({ kind: "active", buysDone: 1, balance: 0n, funded: false });
    const history = await readVaultHistory(rpc, {
      vault: plan.vault!,
      buysDone: 1,
      startAt: plan.startAt,
      chainId: CHAIN_ID,
      owner: owner.address,
      communityWindow: null,
    });
    expect(history.entries.find((entry) => entry.kind === "bought")).toMatchObject({ source: "v1", dueSince: null, maker: "owner" });
  });

  it("funds what its remaining buys need, then closes it, everything back to the owner", async () => {
    const funded = await fundVault(deps, { plan });
    expect(funded.amount).toBe(2n * perBuy);
    const closed = await closeVault(deps, { plan });
    expect(closed.returned).toBe(2n * perBuy);
    expect(await read()).toMatchObject({ kind: "active", release: "v1", closed: true, balance: 0n });
  });
});
