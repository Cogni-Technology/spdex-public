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
 * reward paid to whoever triggered, or ether at the close.
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
import { MAINNET_DEPLOYMENT, factoryAddress, readVaultNonce, vaultBudget } from "@spdex/vault";
import { Engine } from "../../src/lib/engine.js";
import { balanceOf } from "../../src/lib/erc20.js";
import type { TxSender } from "../../src/lib/execute.js";
import {
  closeVault,
  createVault,
  deployVaultFactory,
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

describe("a vault plan's life on the fork, through the app", () => {
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
    readVaultPlan(rpc, { plan, chainId: CHAIN_ID, account, factory });

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
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

  it("creates the plan's vault with one buy's budget, in chain time, where the Guard predicted", async () => {
    // Chain time, not the wall clock: the fork lags it by days, and a start in
    // wall-clock time would put the first buy there.
    const clock = await readChainClock(rpc);
    const costs = vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 3, fees: await readFees(rpc) });
    expect(costs).not.toBeNull();
    choices = { maxSlippageBps: 300, keeperReward: costs!.fee.reward };
    plan = {
      id: "dca-vault-fork",
      paused: true,
      chainId: CHAIN_ID,
      sell: NATIVE_TOKEN,
      buy: SPX,
      amountPerBuy: AMOUNT.toString(),
      intervalSeconds: 300,
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
      creation: { owner: owner.address, vault, nonce: nonce.toString(), hash: creationHash, at: Date.now() },
      factory,
      nowMs: Date.now(),
    });
    expect(settled).toEqual({ kind: "created", vault });
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
    });
    expect(state.terms).toMatchObject({ amountPerBuy: AMOUNT, startAt: BigInt(plan.startAt), keeperReward: choices.keeperReward });
    expect(state.canTrigger).toBe(true);
    expect(state.clock).not.toBeNull();
    expect(vaultCardStatus(state, state.clock!.seconds)).toMatchObject({ vault: "due", pillLabel: "Buy due" });
    // A stranger's view of the same vault is read-only.
    expect((await read(stranger.address)).kind).toBe("someone-else");
  });

  it("makes the due buy from the owner's wallet: SPX at the owner at or above the floor, the reward back to them", async () => {
    const before = await read();
    if (before.kind !== "active" || before.quote === null) throw new Error("the vault could not be read");
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
    // Not due again: the app refuses before asking the wallet anything.
    await expect(triggerVault(deps, { plan })).rejects.toThrow(/won't buy right now/);
  });

  it("finds the buy in the vault's logs, and nothing missing", async () => {
    const history = await readVaultHistory(rpc, { vault, buysDone: 1, startAt: plan.startAt, chainId: CHAIN_ID });
    expect(history.missingBuys).toBe(0);
    expect(history.note).toBeNull();
    const buys = history.entries.filter((entry) => entry.kind === "bought");
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({ amountIn: AMOUNT, keeper: owner.address, reward: choices.keeperReward });
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
    // Every wei the budget came to is accounted for: one buy, its reward, the rest back.
    expect(vaultBudget(vaultPlanOf(plan, choices))).toBe(3n * perBuy());
  });
});
