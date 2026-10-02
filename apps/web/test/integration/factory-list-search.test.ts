/**
 * Finding an owner's vaults from the factory's own list, on the fork, through
 * a network service that refuses every log search — the kind the list search
 * exists for.
 *
 * A fresh owner makes two vaults (the factory is deployed first if the fork
 * doesn't have it yet). Through an in-process proxy that refuses
 * `eth_getLogs`, the app's log search can't find them and says so
 * (`complete: false`), and the list search finds both, newest first, and says
 * it read every owner (`complete: true`). No request it makes names the
 * owner: it compares owners here.
 *
 * The test closes both vaults at the end and touches no vault it didn't make.
 * The fork's clock is never moved. Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import {
  MAINNET_FACTORY,
  VAULT_LIMITS,
  buyFee,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  readVaultCount,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultIdentityCache,
  type VaultPlan,
} from "@spdex/vault";
import { searchVaultsFromFactoryList } from "../../src/lib/dca/factoryListSearch.js";
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

describe("finding an owner's vaults from the factory's list", () => {
  let owner: { key: Hex; address: Address };
  const made: Address[] = [];

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    if (((await rpc("eth_getCode", [MAINNET_FACTORY, "latest"])) as string) === "0x") {
      const deployer = await freshAccount(ETHER);
      const call = deployFactoryCall();
      // Another suite may deploy it first; the code is there either way.
      await sendOk(deployer.key, call.to, call.data).catch(() => undefined);
    }
    expect((await rpc("eth_getCode", [MAINNET_FACTORY, "latest"])) as string).not.toBe("0x");

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
    };
    for (let i = 0; i < 2; i++) {
      const receipt = await sendOk(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), vaultBudget(plan));
      const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
      if (!created) throw new Error("no VaultCreated from the factory in the receipt");
      made.push(created.vault);
    }
  });

  afterAll(async () => {
    for (const vault of made) await sendOk(owner.key, vault, encodeClose());
  });

  it("finds both where the log search can't, reading every owner and naming none", async () => {
    const service = refusingLogs(rpc);

    const logs = await searchAccountVaults(service.rpc, { chainId: CHAIN_ID, account: owner.address, factory: MAINNET_FACTORY });
    expect(logs).toMatchObject({ vaults: [], expected: 2n, complete: false });

    const before = service.sent.length;
    const cache: VaultIdentityCache = new Map();
    const found = await searchVaultsFromFactoryList(service.rpc, owner.address, { cache });
    if (found === null) throw new Error("the factory is deployed");
    expect(found.vaults).toEqual([made[1], made[0]]);
    expect(found).toMatchObject({ expected: 2n, complete: true, unreadable: 0 });
    expect(BigInt(found.listed)).toBeLessThanOrEqual(await readVaultCount(rpc, MAINNET_FACTORY));

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
    const calls = service.sent.length;
    const second = await searchVaultsFromFactoryList(service.rpc, owner.address, { cache });
    // The block, the count and the list again; no owner() at all.
    expect(service.sent.length - calls).toBe(2 + Math.ceil((first?.listed ?? 0) / 1_000));
    expect(second?.vaults).toEqual(first?.vaults);

    const logs = await searchAccountVaults(rpc, { chainId: CHAIN_ID, account: owner.address, factory: MAINNET_FACTORY });
    expect(logs?.complete).toBe(true);
    expect(new Set(logs?.vaults)).toEqual(new Set(first?.vaults));
  });
});
