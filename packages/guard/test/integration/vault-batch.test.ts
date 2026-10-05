/**
 * "Help run the network" on the local fork: someone else's due vault buy,
 * chosen and priced the way the app does it, checked by the Guard's batch
 * path with a second opinion, and really sent from a fresh wallet — privately,
 * as the app sends it: signed at the exact gas limit and price the Guard
 * checked, then handed to the relay (here the fork) as a raw transaction.
 *
 * Owner A creates two v2 vaults, due at once: one large enough that its buy
 * fee covers a batch's network fee at the fork's price, and one too small to.
 * B reads what is due (`readDueCandidates`), selects with the keeper's own
 * rule (`selectBatch`, private, no loss) — which leaves the small one out —
 * test-runs the batch at its gas limit to size `minRewards`, has the Guard
 * check it, and sends it. Each vault pays B its fee directly, naming B as
 * `rewardTo` in its `Bought`, and A gets the SPX. A asking for more than the
 * batch earns is refused before anything is signed.
 *
 * B is a fresh key, no SPX holder, so the buys must be past their community
 * windows: each vault's window is the shortest the factory allows (a minute)
 * on a half-hourly plan that started two minutes before the chain's own time,
 * so its first slot's window has closed and most of the slot is left open to
 * anyone. The shared fork's clock is never touched. Only A's own
 * vaults are ever put in a batch or closed, whatever else the factory lists.
 * The registry, the factory and the batcher are deployed first if the fork
 * doesn't have them yet, from a fresh address. Each vault in the batch comes
 * with the claim the app would hand over (owner, nonce, terms, release),
 * which the Guard proves against its address before it simulates anything.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import { EthSimulateV1Provider, TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type PreparedTransaction } from "@spdex/chain";
import {
  DEFAULT_KEEPER_POLICY,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  RATIO_ONE,
  VAULT_LIMITS,
  batchGasLimit,
  buyFee,
  feeCeiling,
  deployReleaseCalls,
  encodeClose,
  encodeCreateVault,
  encodeExecuteBatch,
  joinBatchLogs,
  readDueCandidates,
  readPlatform,
  selectBatch,
  vaultBudget,
  vaultsCreatedBy,
  decodeVaultEvent,
  type RawLog,
  type VaultPlan,
} from "@spdex/vault";
import { VaultGuard, type VaultBatchIntent, type VaultBatchTxPlan, type VaultClaim } from "../../src/vault.js";
import { SecondOpinionPair } from "../../src/second-opinion.js";

/** The environment, read without Node's types, which this package does not carry. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const FORK_URL = env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const SAME_FORK_URL = FORK_URL.includes("127.0.0.1") ? FORK_URL.replace("127.0.0.1", "localhost") : FORK_URL.replace("localhost", "127.0.0.1");
const CHAIN_ID = Number(env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

interface Receipt {
  status: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  logs: (RawLog & { logIndex: string })[];
}

/** A key nobody has used, given a balance. Only fresh addresses are ever given one. */
async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

async function receiptOf(hash: Hex): Promise<Receipt> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

/** Sign locally, send raw, insist it succeeded. */
async function send(key: Hex, to: Address, data: Hex, value = 0n): Promise<Receipt> {
  const tx = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [raw]);
  const receipt = await receiptOf(hash);
  expect(BigInt(receipt.status)).toBe(1n);
  return receipt;
}

const hasCode = async (address: Address) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  const data = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  return BigInt((await rpc("eth_call", [{ to: token, data }, "latest"])) as string);
}

describe("a batch of someone else's due buys, from a fresh wallet", () => {
  let owner: { key: Hex; address: Address };
  let helper: { key: Hex; address: Address };
  let large: Address;
  let small: Address;
  const vaults: Address[] = [];
  /** What the app reads about each vault and hands the Guard to prove it: owner, nonce, terms, release. */
  const claims = new Map<Address, VaultClaim>();
  const claimsOf = (list: readonly Address[]): VaultClaim[] => list.map((v) => claims.get(v)!);

  async function createVault(amountPerBuy: bigint, startAt: bigint, keeperReward = buyFee(amountPerBuy).reward): Promise<Address> {
    const plan: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy,
      // Half-hourly: under the hour the keeper's rule asks of a vault whose fee
      // others' fees may carry (`subsidyMinInterval`), so each pays its own way.
      interval: 1_800n,
      maxBuys: 2n,
      startAt,
      keeperReward,
      maxSlippageBps: 300n,
      communityWindow: VAULT_LIMITS.MIN_COMMUNITY_WINDOW,
      turnBuckets: 0n,
    };
    const receipt = await send(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), vaultBudget(plan));
    const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
    if (!created) throw new Error("no VaultCreated from the factory");
    // A fresh owner's vaults take nonces 0, 1, … in the order they are made.
    claims.set(created.vault, { address: created.vault, owner: created.owner, nonce: BigInt(vaults.length), terms: created.terms, release: "v2" });
    vaults.push(created.vault);
    return created.vault;
  }

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    // Whichever fork test runs first deploys them, registry first; a
    // deployment that loses the race reverts, and the code is there.
    let deployer: { key: Hex; address: Address } | null = null;
    for (const call of deployReleaseCalls("v2")) {
      if (await hasCode(call.address)) continue;
      deployer ??= await freshAccount(ETHER);
      const tx = await prepareTransaction(rpc, { from: deployer.address, to: call.to, data: call.data, value: 0n, chainId: CHAIN_ID }).catch(() => null);
      if (tx === null) continue;
      const { raw, hash } = await signPrepared(deployer.key, tx);
      await rpc("eth_sendRawTransaction", [raw]);
      await receiptOf(hash);
    }
    expect(await hasCode(MAINNET_FACTORY)).toBe(true);
    expect(await hasCode(MAINNET_BATCHER)).toBe(true);

    owner = await freshAccount(2n * ETHER);
    helper = await freshAccount(ETHER / 10n);
    // Chain time, never the wall clock, as the next block will have it: the fork mines only when
    // sent a transaction, and its idle head lags the time it keeps (anvil's pending block carries
    // the next one's). Two minutes before it, so the first buy is due and its one-minute community
    // window over, and the rest of the half-hour's slot open to anyone.
    const latest = (await rpc("eth_getBlockByNumber", ["pending", false])) as { timestamp: string };
    // The fork charges about 1 gwei, several times what the fee spDEX proposes is priced for, so no
    // buy at that fee pays for a batch of one here. The large vault's owner set the most a fee can be,
    // 0.69% of a 0.2 ETH buy (0.00138 ETH), which does; the small one's fee for 0.001 ETH does not.
    const startAt = BigInt(latest.timestamp) - 120n;
    large = await createVault(ETHER / 5n, startAt, feeCeiling(ETHER / 5n));
    small = await createVault(ETHER / 1_000n, startAt);
  });

  afterAll(async () => {
    // Every vault this file made goes back to its owner.
    for (const vault of vaults) await send(owner.key, vault, encodeClose());
  });

  it("reads both as due, chooses only the one whose fee covers the network fee, and the Guard verifies it with a second opinion; the wallet sends it and is paid", async () => {
    // 1. What is due, read at one block, as the app does.
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    const read = await readPlatform(rpc, { block: head, deployments: [{ id: "v2", factory: MAINNET_FACTORY }] });
    const due = await readDueCandidates(rpc, read, { block: head });
    // Other vaults on the shared fork are read, never batched: only this file's own go further.
    const mine = due.filter((c) => c.vault === large || c.vault === small);
    expect(mine.map((c) => c.vault).sort()).toEqual([large, small].sort());
    expect(mine.every((c) => c.owner === owner.address.toLowerCase() && c.firstBuy && c.spotOut >= c.floorOut)).toBe(true);
    // Past their community windows: a wallet that isn't an SPX holder may be paid for them.
    expect(mine.every((c) => !c.inWindow)).toBe(true);

    // 2. One price, read once: the one signed.
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) as string);

    // 3. The keeper's own selection, private and planning no loss: the small vault's fee doesn't cover its gas.
    const selection = selectBatch({
      candidates: mine,
      feePerGas: gasPrice,
      ratioPpm: RATIO_ONE,
      privateSend: true,
      pairReserves: new Map(),
      ownerSubsidised24h: new Map(),
      dailyLossLeft: 0n,
      policy: { ...DEFAULT_KEEPER_POLICY, maxVaultsPerBatch: 20, maxLossPerBuy: 0n },
    });
    expect(selection.vaults.map((v) => v.vault)).toEqual([large]);
    expect(selection.skipped.map((s) => s.vault)).toContain(small);
    const list = selection.vaults.map((v) => v.vault);
    const gasLimit = batchGasLimit(selection.vaults);

    // 4. A test-run from the wallet at that gas limit, to size the least reward.
    const preflight = await new EthSimulateV1Provider(rpc).simulate({
      chainId: CHAIN_ID,
      account: helper.address,
      calls: [{ to: MAINNET_BATCHER, data: encodeExecuteBatch(list, helper.address, 0n), value: 0n }],
      gas: gasLimit,
    });
    expect(preflight.status).toBe("success");
    const indexed = preflight.logs.filter((l) => l.address !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee").map((l, logIndex) => ({ ...l, logIndex }));
    const [run] = joinBatchLogs(indexed, (a) => a === MAINNET_BATCHER);
    const earned = run!.batch!.earned;
    const minRewards = (preflight.gasUsed * 11n * gasPrice + 9n) / 10n;
    expect(earned).toBeGreaterThanOrEqual(minRewards);

    // 5. The Guard, with a second opinion from the same fork under another host name.
    const intent: VaultBatchIntent = {
      version: 1,
      action: "batch",
      chainId: CHAIN_ID,
      account: helper.address,
      vaults: list,
      claims: claimsOf(list),
      rewardTo: helper.address,
      minRewards,
      gasLimit,
      gasPrice,
    };
    const plan: VaultBatchTxPlan = {
      version: 1,
      intent,
      calls: [{ to: MAINNET_BATCHER, data: encodeExecuteBatch(list, helper.address, minRewards), value: 0n, gas: gasLimit, gasPrice }],
    };
    const pair = new SecondOpinionPair({ primaryRpc: rpc, secondRpc: httpRpc(SAME_FORK_URL), host: "localhost" });
    const guard = new VaultGuard(pair.provider(new EthSimulateV1Provider(rpc)), { chainId: CHAIN_ID, requireSimulation: false });
    const verdict = await guard.check(plan);
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings).toEqual([]);
    expect(verdict.level).toBe("verified");

    // 6. Sent as the private path sends it: signed at exactly the checked gas and price, then sent raw.
    const wethBefore = await balanceOf(TOKENS.WETH.address, helper.address);
    const batcherWethBefore = await balanceOf(TOKENS.WETH.address, MAINNET_BATCHER);
    const spxBefore = await balanceOf(TOKENS.SPX.address, owner.address);
    const nonce = Number(BigInt((await rpc("eth_getTransactionCount", [helper.address, "pending"])) as string));
    const tx: PreparedTransaction = {
      from: helper.address,
      chainId: CHAIN_ID,
      nonce,
      to: plan.calls[0]!.to,
      data: plan.calls[0]!.data,
      value: 0n,
      gas: plan.calls[0]!.gas,
      fees: { type: "legacy", gasPrice: plan.calls[0]!.gasPrice },
    };
    const { raw, hash } = await signPrepared(helper.key, tx);
    await rpc("eth_sendRawTransaction", [raw]);
    const receipt = await receiptOf(hash);
    expect(BigInt(receipt.status)).toBe(1n);

    const [mined] = joinBatchLogs(receipt.logs, (a) => a === MAINNET_BATCHER);
    expect(mined!.batch).toMatchObject({ source: "v2", caller: helper.address.toLowerCase(), rewardTo: helper.address.toLowerCase(), bought: 1n });
    expect(mined!.batch!.earned).toBeGreaterThanOrEqual(minRewards);
    // Paid by the vault directly, every wei of it: nothing passed through the batcher.
    expect((await balanceOf(TOKENS.WETH.address, helper.address)) - wethBefore).toBe(mined!.batch!.earned);
    expect(await balanceOf(TOKENS.WETH.address, MAINNET_BATCHER)).toBe(batcherWethBefore);
    const bought = receipt.logs.map((l) => decodeVaultEvent(l)).find((e) => e?.name === "Bought");
    expect(bought?.name === "Bought" && bought.emitter === large).toBe(true);
    expect(bought).toMatchObject({ source: "v2", keeper: MAINNET_BATCHER, rewardTo: helper.address.toLowerCase() });
    const out = bought?.name === "Bought" ? bought.amountOut : 0n;
    expect(out).toBeGreaterThan(0n);
    expect((await balanceOf(TOKENS.SPX.address, owner.address)) - spxBefore).toBe(out);
  });

  it("refuses a batch asking more than it earns, before anything is signed: the batcher's TooLittle, by name", async () => {
    // The large vault has bought and is no longer due; the small one still is.
    const gasPrice = BigInt((await rpc("eth_gasPrice", [])) as string);
    const list = [small];
    const gasLimit = batchGasLimit([{ firstBuy: true }]);
    const minRewards = buyFee(ETHER / 1_000n).reward + 1n;
    const intent: VaultBatchIntent = {
      version: 1,
      action: "batch",
      chainId: CHAIN_ID,
      account: helper.address,
      vaults: list,
      claims: claimsOf(list),
      rewardTo: helper.address,
      minRewards,
      gasLimit,
      gasPrice,
    };
    const plan: VaultBatchTxPlan = {
      version: 1,
      intent,
      calls: [{ to: MAINNET_BATCHER, data: encodeExecuteBatch(list, helper.address, minRewards), value: 0n, gas: gasLimit, gasPrice }],
    };
    const verdict = await new VaultGuard(new EthSimulateV1Provider(rpc), { chainId: CHAIN_ID, requireSimulation: false }).check(plan);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toContain("TooLittle");
  });
});
