/**
 * Collective DCA's reader on the local fork, against the deployed contracts:
 * the totals `readPlatform` and `summarisePlatform` give at a pinned block are
 * held to the sum of `readVault` over every listed vault at that block, which
 * reads each vault through a different path (one Multicall3 round trip per
 * vault, with `status()` rather than `balanceOf`).
 *
 * It makes vaults of its own first, so the fork holds at least one that has
 * bought and one that is closed whatever ran before it: the factory is
 * deployed if it isn't there yet, the plans start at the chain's own time so
 * the first buy is due at once, and every address is fresh. Assertions are
 * against reads made here, never against counts from an earlier run. It never
 * triggers or closes a vault it didn't create, and never moves the fork's
 * clock.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, Multicall3Reader, TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import {
  FACTORY_ABI,
  KEEPER_MIN_EXECUTE_GAS_LIMIT,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  VAULT_LIMITS,
  buyFee,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  factoryAddress,
  readPlatform,
  readVault,
  readVaultCount,
  summarisePlatform,
  vaultBudget,
  vaultsCreatedBy,
  type PlatformRead,
  type RawLog,
  type VaultIdentityCache,
  type VaultPlan,
  type VaultState,
} from "../../src/index.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const SPX = TOKENS.SPX.address;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

async function freshAccount(amount?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  if (amount !== undefined) await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

interface Receipt {
  status: string;
  blockNumber: string;
  logs: RawLog[];
}

async function send(key: Hex, to: Address, data: Hex, options: { value?: bigint; gas?: bigint } = {}): Promise<Receipt> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value: options.value ?? 0n, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, options.gas === undefined ? prepared : { ...prepared, gas: options.gas });
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

async function sendOk(key: Hex, to: Address, data: Hex, options: { value?: bigint; gas?: bigint } = {}): Promise<Receipt> {
  const receipt = await send(key, to, data, options);
  expect(BigInt(receipt.status)).toBe(1n);
  return receipt;
}

const hasCode = async (address: Address) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

/** The endpoint, remembering every request, so a test can say what was asked and how. */
function recording(inner: JsonRpc): { rpc: JsonRpc; sent: { method: string; params: unknown[] }[] } {
  const sent: { method: string; params: unknown[] }[] = [];
  return {
    sent,
    rpc: (method, params) => {
      sent.push({ method, params });
      return inner(method, params);
    },
  };
}

/** The panel's figures, worked out again from `readVault` states by the rules the panel states. */
function sumOfReadVault(states: VaultState[]) {
  const spx = SPX.toLowerCase();
  let buys = 0n;
  let spxDelivered = 0n;
  let open = 0n;
  let finished = 0n;
  let closed = 0n;
  let ethSpent = 0n;
  let fees = 0n;
  let committed = 0n;
  let held = 0n;
  const owners = new Set<string>();
  for (const s of states) {
    buys += s.buysDone;
    if (s.terms.tokenOut === spx) spxDelivered += s.totalOut;
    owners.add(s.owner);
    ethSpent += s.buysDone * s.terms.amountPerBuy;
    fees += s.totalRewards;
    if (s.closed) {
      closed += 1n;
      continue;
    }
    held += s.status.wethBalance;
    const left = s.terms.maxBuys - s.buysDone;
    if (left === 0n) {
      finished += 1n;
      continue;
    }
    open += 1n;
    const need = left * (s.terms.amountPerBuy + s.terms.keeperReward);
    committed += s.status.wethBalance < need ? s.status.wethBalance : need;
  }
  return { buys, spxDelivered, open, finished, closed, owners: BigInt(owners.size), ethSpent, fees, committed, held };
}

describe("Collective DCA figures on the fork", () => {
  let owner: { key: Hex; address: Address };
  let plan: VaultPlan;
  const mine: Address[] = [];
  let bought: Address;
  let closedVault: Address;
  let block: bigint;
  const cache: VaultIdentityCache = new Map();
  let first: PlatformRead;

  async function createVault(): Promise<Address> {
    const receipt = await sendOk(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), { value: vaultBudget(plan) });
    const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
    if (!created) throw new Error("no VaultCreated from the factory in the receipt");
    mine.push(created.vault);
    return created.vault;
  }

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    const deployer = await freshAccount(ETHER);
    const call = deployFactoryCall();
    // Another suite may deploy it between the check and the send; the code is there either way.
    if (!(await hasCode(MAINNET_FACTORY))) await send(deployer.key, call.to, call.data);
    expect(await hasCode(MAINNET_FACTORY)).toBe(true);

    owner = await freshAccount(ETHER);
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 200n;
    plan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: VAULT_LIMITS.MIN_INTERVAL,
      maxBuys: 3n,
      // Chain time, never the wall clock: the first buy is due in the next block.
      startAt: BigInt(latest.timestamp),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
    };

    bought = await createVault();
    const keeper = await freshAccount(ETHER / 10n);
    await sendOk(keeper.key, bought, encodeExecute(), { gas: KEEPER_MIN_EXECUTE_GAS_LIMIT });

    closedVault = await createVault();
    await sendOk(owner.key, closedVault, encodeClose());

    block = BigInt((await rpc("eth_blockNumber", [])) as string);
  });

  afterAll(async () => {
    // The vault still open goes back to its owner; the closed one already did.
    if (bought) await sendOk(owner.key, bought, encodeClose());
  });

  it("adds up, at one pinned block, exactly what readVault says of every listed vault at that block", async () => {
    const recorded = recording(rpc);
    first = await readPlatform(recorded.rpc, { block, cache, deployments: [{ id: "v1", factory: MAINNET_FACTORY }] });
    // Every request was a Multicall3 call at the pinned block: no "latest" slipped in.
    for (const { method, params } of recorded.sent) {
      expect(method).toBe("eth_call");
      expect((params[0] as { to: string }).to).toBe(CONTRACTS.multicall3);
      expect(params[1]).toBe(hex(block));
    }
    expect(first.requests).toBe(recorded.sent.length);

    const [deployment] = first.deployments;
    if (deployment?.state !== "read") throw new Error("the factory should be deployed");
    // The count, asked of the factory directly rather than through Multicall3.
    const countAtBlock = decodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "vaultCount",
      data: (await rpc("eth_call", [{ to: MAINNET_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }) }, hex(block)])) as Hex,
    });
    expect(deployment.count).toBe(countAtBlock);
    expect(deployment.unreadable).toEqual([]);
    expect(BigInt(deployment.listed)).toBe(deployment.count);

    const pinnedReader = new Multicall3Reader(rpc, { blockTag: hex(block) });
    const states: VaultState[] = [];
    for (const figures of deployment.vaults) {
      const state = await readVault(rpc, figures.vault, { reader: pinnedReader });
      if (state === null) throw new Error(`${figures.vault} didn't read as a vault at block ${block}`);
      expect(figures).toEqual({
        vault: state.address,
        owner: state.owner,
        terms: state.terms,
        closed: state.closed,
        buysDone: state.buysDone,
        totalOut: state.totalOut,
        wethBalance: state.status.wethBalance,
      });
      states.push(state);
    }

    const summary = summarisePlatform(first);
    if (summary.state !== "read") throw new Error("expected figures");
    const exact = sumOfReadVault(states);
    expect(summary.made).toBe(deployment.count);
    expect(summary.read).toBe(states.length);
    expect(summary.unreadable + Number(summary.unread)).toBe(0);
    for (const [key, value] of Object.entries(exact)) {
      expect(summary[key as keyof typeof exact], key).toEqual({ value, atLeast: false });
    }
  });

  it("counts this test's own vaults as they are: one bought once, one closed", () => {
    const [deployment] = first.deployments;
    if (deployment?.state !== "read") throw new Error("the factory should be deployed");
    const byAddress = new Map(deployment.vaults.map((v) => [v.vault, v]));
    expect(byAddress.get(bought)).toMatchObject({ owner: owner.address.toLowerCase(), closed: false, buysDone: 1n });
    expect(byAddress.get(bought)!.totalOut > 0n).toBe(true);
    expect(byAddress.get(closedVault)).toMatchObject({ owner: owner.address.toLowerCase(), closed: true, buysDone: 0n, wethBalance: 0n });
  });

  it("reads the same figures again from the cache, never with more requests, and ignores a vault made after the block", async () => {
    await createVault();
    // The cache saves each vault's owner and terms calls, 6 calls down to 4,
    // but calls go 200 to a request: on a fork with few vaults both reads fit
    // in one, and only past about 33 vaults does the count of requests drop.
    // So what is pinned is that every vault read is cached, and that the
    // second read never costs more.
    for (const vault of first.deployments.flatMap((d) => (d.state === "read" ? d.vaults : []))) {
      expect(cache.get(vault.vault), vault.vault).toMatchObject({ owner: vault.owner, terms: vault.terms });
    }
    const again = await readPlatform(rpc, { block, cache, deployments: [{ id: "v1", factory: MAINNET_FACTORY }] });
    expect(again.requests).toBeLessThanOrEqual(first.requests);
    expect({ ...summarisePlatform(again), requests: 0 }).toEqual({ ...summarisePlatform(first), requests: 0 });

    // At the latest block the new vault is there; at the pinned one it isn't.
    const latest = summarisePlatform(await readPlatform(rpc, { cache, deployments: [{ id: "v1", factory: MAINNET_FACTORY }] }));
    const pinned = summarisePlatform(first);
    if (latest.state !== "read" || pinned.state !== "read") throw new Error("expected figures");
    expect(latest.made).toBe(await readVaultCount(rpc, MAINNET_FACTORY));
    expect(latest.made > pinned.made).toBe(true);
  });

  it("reads a factory address with no code as not deployed, through the Multicall3 path, with no figures", async () => {
    // A factory for another market list lands at another address, where nothing is deployed.
    const elsewhere = factoryAddress({ ...MAINNET_DEPLOYMENT, markets: [{ ...MAINNET_DEPLOYMENT.markets[0]!, tokenOut: TOKENS.USDC.address }] });
    expect(await hasCode(elsewhere)).toBe(false);
    const recorded = recording(rpc);
    const read = await readPlatform(recorded.rpc, { block, deployments: [{ id: "elsewhere", factory: elsewhere }] });
    expect(read.deployments).toEqual([{ id: "elsewhere", factory: elsewhere, state: "not-deployed" }]);
    expect(recorded.sent.map((s) => (s.params[0] as { to: string }).to)).toEqual([CONTRACTS.multicall3]);
    expect(summarisePlatform(read)).toEqual({ state: "not-deployed", block, requests: 1 });
  });
});
