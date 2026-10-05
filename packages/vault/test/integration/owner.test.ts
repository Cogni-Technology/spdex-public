/**
 * Finding an owner's vaults from the chain alone, on the local fork: what the
 * app does when a card was deleted, a config lost, or the browser is new.
 *
 * The unit tests script the endpoint's refusals and bounds. This proves the
 * other half: that the factory's count is what `nonces(owner)` really says,
 * that the owner topic the search filters on is the one the factory really
 * indexes, and that what comes back is exactly the vaults the owner created,
 * at the addresses the factory put them — on this build's factory and on
 * v1's, each searched with its own release's `VaultCreated`. Every address is
 * fresh, the fork's clock is never touched, and the vaults are created empty:
 * nothing is left funded for a keeper to find.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import { addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import { encodeFunctionData } from "viem";
import {
  MAINNET_DEPLOYMENT,
  V1_FACTORY_ABI,
  V1_MAINNET_FACTORY,
  VAULT_EVENT_TOPICS,
  VAULT_LIMITS,
  VAULT_LOGS_FROM_BLOCK,
  encodeCreateVault,
  factoryAddress,
  findVaultsByOwner,
  predictVault,
  termsOfPlan,
  vaultsCreatedBy,
  type VaultPlan,
} from "../../src/index.js";
import { ensureRelease } from "./fork.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const ETHER = 10n ** 18n;
const rpc = httpRpc(FORK_URL);
const factory = factoryAddress(MAINNET_DEPLOYMENT);

/** A key nobody has used, funded with `amount` if asked. Only fresh addresses are ever given a balance. */
async function freshAccount(amount?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  expect(BigInt((await rpc("eth_getTransactionCount", [address, "latest"])) as string)).toBe(0n);
  if (amount !== undefined) await rpc("anvil_setBalance", [address, `0x${amount.toString(16)}`]);
  return { key, address };
}

interface Receipt {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string }[];
}

/** Sign locally, send raw, wait for the receipt, insist it succeeded. */
async function send(key: Hex, to: Address, data: Hex, value = 0n): Promise<Receipt> {
  const tx = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) {
      expect(BigInt(receipt.status)).toBe(1n);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

/** The endpoint, with a note of every method asked of it and every log window. */
function watched(): { rpc: JsonRpc; methods: string[]; windows: { from: bigint; to: bigint }[] } {
  const methods: string[] = [];
  const windows: { from: bigint; to: bigint }[] = [];
  const through: JsonRpc = async (method, params) => {
    methods.push(method);
    if (method === "eth_getLogs") {
      const filter = (params as { fromBlock: string; toBlock: string }[])[0]!;
      windows.push({ from: BigInt(filter.fromBlock), to: BigInt(filter.toBlock) });
    }
    return rpc(method, params);
  };
  return { rpc: through, methods, windows };
}

describe("finding an owner's vaults on the fork", () => {
  let owner: { key: Hex; address: Address };
  /** The owner's two vaults, oldest first, with the block each was created in. */
  const made: { vault: Address; block: bigint }[] = [];

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    // The other suites deploy them too; whichever runs first does.
    await ensureRelease("v2");
    await ensureRelease("v1");
    owner = await freshAccount(ETHER / 10n);
  });

  it("starts no later than the block after the one every test pins", () => {
    expect(VAULT_LOGS_FROM_BLOCK).toBe(BigInt(process.env["SPDEX_FORK_BLOCK"]!) + 1n);
  });

  it("an owner who has created nothing costs one call, and no log query", async () => {
    const endpoint = watched();
    expect(await findVaultsByOwner(endpoint.rpc, factory, owner.address)).toEqual({ vaults: [], expected: 0n, complete: true });
    expect(endpoint.methods).toEqual(["eth_call"]);
  });

  it("finds every vault the owner created, newest first, where the factory put them", async () => {
    // Two empty vaults in two transactions, so two blocks: the fork mines one per transaction.
    for (const nonce of [0n, 1n]) {
      const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
      const plan: VaultPlan = {
        marketIndex: 0n,
        amountPerBuy: ETHER / 1_000n,
        interval: VAULT_LIMITS.MIN_INTERVAL,
        maxBuys: 1n + nonce,
        startAt: BigInt(latest.timestamp),
        keeperReward: 0n,
        maxSlippageBps: 100n,
        communityWindow: 75n,
        turnBuckets: 0n,
      };
      const receipt = await send(owner.key, factory, encodeCreateVault(plan));
      const [created] = vaultsCreatedBy(factory, receipt.logs);
      expect(created?.vault).toBe(predictVault({ factory, owner: owner.address, nonce, terms: termsOfPlan(plan) }));
      made.push({ vault: created!.vault, block: BigInt(receipt.blockNumber) });
    }
    expect(made[1]!.block).toBeGreaterThan(made[0]!.block);

    // As the app asks: from the latest block, never below the factory's first possible one.
    const endpoint = watched();
    const found = await findVaultsByOwner(endpoint.rpc, factory, owner.address, { oldestBlock: VAULT_LOGS_FROM_BLOCK });
    expect(found).toMatchObject({ vaults: [made[1]!.vault, made[0]!.vault], expected: 2n, complete: true });
    expect(found.searchedFrom).toBeLessThanOrEqual(made[0]!.block);
    expect(found.searchedFrom).toBeGreaterThanOrEqual(VAULT_LOGS_FROM_BLOCK);
    // The fork answers the whole range at once, and nothing before the fork's
    // own blocks is asked of the endpoint it was seeded from.
    expect(endpoint.windows.length).toBeGreaterThan(0);
    for (const window of endpoint.windows) expect(window.from).toBeGreaterThanOrEqual(VAULT_LOGS_FROM_BLOCK);
  });

  it("in ten-block windows, the way a capped endpoint makes it search, it finds the same", async () => {
    const found = await findVaultsByOwner(rpc, factory, owner.address, { chunk: 10n, oldestBlock: VAULT_LOGS_FROM_BLOCK, maxQueries: 1_000 });
    expect(found).toMatchObject({ vaults: [made[1]!.vault, made[0]!.vault], expected: 2n, complete: true });
  });

  it("says it found one of two when its range reaches back only to the newer", async () => {
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    const found = await findVaultsByOwner(rpc, factory, owner.address, { newestBlock: head, maxRange: head - made[1]!.block + 1n });
    expect(found).toEqual({ vaults: [made[1]!.vault], expected: 2n, complete: false, searchedFrom: made[1]!.block });
  });

  it("finds the same owner's v1 vault on v1's factory, by v1's topic, and none of its v2 vaults there", async () => {
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const args = [0n, ETHER / 1_000n, VAULT_LIMITS.MIN_INTERVAL, 1n, BigInt(latest.timestamp), 0n, 100n] as const;
    const receipt = await send(owner.key, V1_MAINNET_FACTORY, encodeFunctionData({ abi: V1_FACTORY_ABI, functionName: "createVault", args }));
    const [created] = vaultsCreatedBy(V1_MAINNET_FACTORY, receipt.logs);
    expect(created).toMatchObject({ source: "v1", owner: owner.address.toLowerCase() });
    expect(receipt.logs.find((log) => log.address.toLowerCase() === V1_MAINNET_FACTORY)!.topics[0]).toBe(VAULT_EVENT_TOPICS.v1.VaultCreated);

    const endpoint = watched();
    const onV1 = await findVaultsByOwner(endpoint.rpc, V1_MAINNET_FACTORY, owner.address, { oldestBlock: VAULT_LOGS_FROM_BLOCK });
    expect(onV1).toMatchObject({ vaults: [created!.vault], expected: 1n, complete: true });
    // This build's factory still has the owner's two, and they are not v1's.
    expect(await findVaultsByOwner(rpc, factory, owner.address, { oldestBlock: VAULT_LOGS_FROM_BLOCK })).toMatchObject({
      vaults: [made[1]!.vault, made[0]!.vault],
      expected: 2n,
      complete: true,
    });
  });

  it("another owner's search finds none of them", async () => {
    const stranger = await freshAccount();
    expect(await findVaultsByOwner(rpc, factory, stranger.address)).toEqual({ vaults: [], expected: 0n, complete: true });
  });
});
