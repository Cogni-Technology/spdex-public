/**
 * Finding an owner's vaults from the factories' own lists, on the fork,
 * through a network service that refuses every log search — the kind the list
 * search exists for.
 *
 * A fresh owner makes two v2 vaults and a v1 one (each release is deployed
 * first, `deployReleaseCalls`, if the fork doesn't have it yet). Through an
 * in-process proxy that refuses `eth_getLogs`, the app's log search can't
 * find them and says so (`complete: false`, with both factories' counts), and
 * the list search finds all three, v2's list first, each newest first, and
 * says it read every owner (`complete: true`). No request it makes names the
 * owner: it compares owners here.
 *
 * The test closes every vault at the end and touches no vault it didn't make.
 * The fork's clock is never moved. Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import {
  MAINNET_FACTORY,
  V1_MAINNET_FACTORY,
  VAULT_LIMITS,
  buyFee,
  defaultCommunityWindow,
  deployReleaseCalls,
  encodeClose,
  encodeCreateVault,
  readVaultCount,
  v1BuyFee,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultIdentityCache,
  type VaultPlan,
  type VaultRelease,
} from "@spdex/vault";
import { factoryListSearchCost, searchVaultsFromFactoryList } from "../../src/lib/dca/factoryListSearch.js";
import { searchAccountVaults } from "../../src/lib/dca/vault.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** A key nobody has used, given `amount` of ether. Only fresh addresses are ever given a balance. */
async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

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
 * A release's contracts on the fork, deployed the way anyone would where they
 * aren't yet; another suite may deploy one first, and the code is there
 * either way.
 */
async function ensureRelease(release: VaultRelease): Promise<void> {
  for (const call of deployReleaseCalls(release)) {
    if (((await rpc("eth_getCode", [call.address, "latest"])) as string) !== "0x") continue;
    const deployer = await freshAccount(ETHER);
    await sendOk(deployer.key, call.to, call.data).catch(() => undefined);
    expect((await rpc("eth_getCode", [call.address, "latest"])) as string, `${release}'s ${call.name}`).not.toBe("0x");
  }
}

/**
 * The fork, as a network service that caps log searches to nothing: every
 * `eth_getLogs` is refused, as some free tiers do past ten blocks. Every other
 * request goes through, and each is remembered.
 */
function refusingLogs(inner: JsonRpc): { rpc: JsonRpc; sent: { method: string; params: unknown[] }[] } {
  const sent: { method: string; params: unknown[] }[] = [];
  return {
    sent,
    rpc: async (method, params) => {
      sent.push({ method, params });
      if (method === "eth_getLogs") throw new Error("eth_getLogs: block range is too wide");
      return inner(method, params);
    },
  };
}

describe("finding an owner's vaults from the factories' lists", () => {
  let owner: { key: Hex; address: Address };
  /** v2's two, oldest first, then v1's one. */
  const made: Address[] = [];

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureRelease("v2");
    await ensureRelease("v1");

    owner = await freshAccount(ETHER);
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 1_000n;
    const plan: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: VAULT_LIMITS.MIN_INTERVAL,
      maxBuys: 2n,
      startAt: BigInt(latest.timestamp),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      communityWindow: defaultCommunityWindow(VAULT_LIMITS.MIN_INTERVAL),
      turnBuckets: 0n,
    };
    for (let i = 0; i < 2; i++) {
      const receipt = await sendOk(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), vaultBudget(plan));
      const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
      if (!created) throw new Error("no VaultCreated from the factory in the receipt");
      made.push(created.vault);
    }
    // And one on v1's factory, from before the app created on v2: v1's
    // `createVault(uint256 × 7)`, hand-encoded, with v1's fee and no window.
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const v1Fee = v1BuyFee(amountPerBuy).reward;
    const create = `0x3f8f7b79${[0n, amountPerBuy, VAULT_LIMITS.MIN_INTERVAL, 2n, BigInt(latest.timestamp), v1Fee, 300n].map(word).join("")}` as Hex;
    const receipt = await sendOk(owner.key, V1_MAINNET_FACTORY, create, 2n * (amountPerBuy + v1Fee));
    const [created] = vaultsCreatedBy(V1_MAINNET_FACTORY, receipt.logs);
    if (!created) throw new Error("no VaultCreated from v1's factory in the receipt");
    expect(created.source).toBe("v1");
    made.push(created.vault);
  });

  afterAll(async () => {
    for (const vault of made) await sendOk(owner.key, vault, encodeClose());
  });

  it("finds all three where the log search can't, both releases' lists, reading every owner and naming none", async () => {
    const service = refusingLogs(rpc);

    const logs = await searchAccountVaults(service.rpc, { chainId: CHAIN_ID, account: owner.address });
    // Each factory's own count, and none found: the logs were refused.
    expect(logs).toMatchObject({
      vaults: [],
      expected: 3n,
      complete: false,
      counts: [
        { factory: MAINNET_FACTORY, expected: 2n },
        { factory: V1_MAINNET_FACTORY, expected: 1n },
      ],
    });

    const before = service.sent.length;
    const cache: VaultIdentityCache = new Map();
    const found = await searchVaultsFromFactoryList(service.rpc, owner.address, { cache });
    if (found === null) throw new Error("the factories are deployed");
    // v2's list first, newest first; then v1's.
    expect(found.vaults).toEqual([made[1], made[0], made[2]]);
    expect(found).toMatchObject({ expected: 3n, complete: true, unreadable: 0 });
    const listed = (await readVaultCount(rpc, MAINNET_FACTORY)) + (await readVaultCount(rpc, V1_MAINNET_FACTORY));
    expect(BigInt(found.listed)).toBeLessThanOrEqual(listed);

    const asked = service.sent.slice(before);
    expect(asked.map((r) => r.method)).not.toContain("eth_getLogs");
    const who = owner.address.slice(2).toLowerCase();
    for (const request of asked) expect(JSON.stringify(request.params).toLowerCase()).not.toContain(who);
    // Every eth_call at the block the search reports.
    for (const request of asked.filter((r) => r.method === "eth_call")) expect(request.params[1]).toBe(hex(found.block));
  });

  it("agrees with the log search where logs are served, and asks no owner twice", async () => {
    const service = refusingLogs(rpc);
    const cache: VaultIdentityCache = new Map();
    const first = await searchVaultsFromFactoryList(service.rpc, owner.address, { cache });
    if (first === null) throw new Error("the factories are deployed");
    const calls = service.sent.length;
    const second = await searchVaultsFromFactoryList(service.rpc, owner.address, { cache });
    // The block, the counts and each list again; no owner() at all.
    const counts = [await readVaultCount(rpc, MAINNET_FACTORY), await readVaultCount(rpc, V1_MAINNET_FACTORY)].map(Number);
    expect(service.sent.length - calls).toBe(factoryListSearchCost(counts, first.searched));
    expect(second?.vaults).toEqual(first.vaults);

    const logs = await searchAccountVaults(rpc, { chainId: CHAIN_ID, account: owner.address });
    expect(logs?.complete).toBe(true);
    expect(new Set(logs?.vaults)).toEqual(new Set(first.vaults));
  });
});
