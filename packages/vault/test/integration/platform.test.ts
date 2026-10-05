/**
 * Collective DCA's reader on the local fork, against the deployed contracts:
 * the totals `readPlatform` and `summarisePlatform` give at a pinned block are
 * held to the sum of `readVault` over every listed vault at that block, which
 * reads each vault through a different path (one Multicall3 round trip per
 * vault, with `status()` rather than `balanceOf`).
 *
 * It makes vaults of its own first, in both releases' factories, so the fork
 * holds at least one that has bought, one bought by an SPX holder inside its
 * community window, one that is closed and one of v1's, whatever ran before
 * it: the contracts are deployed if they aren't there yet, the plans start at
 * the chain's own time so the first buy is due at once (and inside its
 * window), and every address is fresh. The SPX holder paid is the real one the
 * fork tests borrow, proven from its recorded mainnet proof (`fork.ts`).
 * Assertions are against reads made here, never against counts from an
 * earlier run. It never triggers or closes a vault it didn't create, and never
 * moves the fork's clock.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, Multicall3Reader, TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import {
  DEPLOYMENTS,
  FACTORY_ABI,
  KEEPER_MIN_EXECUTE_GAS_LIMIT,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  V1_FACTORY_ABI,
  V1_MAINNET_FACTORY,
  VAULT_LIMITS,
  buyFee,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeExecuteV1,
  factoryAddress,
  featuresOf,
  readPlatform,
  readVault,
  readVaultCount,
  summarisePlatform,
  v1BuyFee,
  vaultBudget,
  vaultsCreatedBy,
  type PlatformRead,
  type RawLog,
  type VaultIdentityCache,
  type VaultPlan,
  type VaultState,
} from "../../src/index.js";
import { HOLDER, ensureHolderProven, ensureRelease } from "./fork.js";

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
  let v2Buys = 0n;
  let communityWindowBuys = 0n;
  const owners = new Set<string>();
  for (const s of states) {
    buys += s.buysDone;
    if (featuresOf(s.release).communityWindow) {
      v2Buys += s.buysDone;
      communityWindowBuys += s.windowBuys!;
    }
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
  return { buys, spxDelivered, open, finished, closed, owners: BigInt(owners.size), ethSpent, fees, committed, held, v2Buys, communityWindowBuys };
}

describe("Collective DCA figures on the fork", () => {
  let owner: { key: Hex; address: Address };
  let plan: VaultPlan;
  const mine: Address[] = [];
  let bought: Address;
  /** Bought inside its community window by a keeper paying the proven SPX holder. */
  let holderBought: Address;
  let closedVault: Address;
  /** A v1 vault, bought once by whoever called it. */
  let v1Vault: Address;
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
    // Another suite may deploy them, or prove the holder, first: the state is the same either way.
    await ensureRelease("v2");
    await ensureRelease("v1");
    await ensureHolderProven();
    expect(await hasCode(MAINNET_FACTORY)).toBe(true);

    owner = await freshAccount(ETHER);
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 200n;
    plan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: 3_600n,
      maxBuys: 3n,
      // Chain time, never the wall clock: the first buy is due in the next block,
      // inside a 15-minute community window.
      startAt: BigInt(latest.timestamp),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      communityWindow: 900n,
      turnBuckets: 0n,
    };

    // Trigger now's buy, paid back to the owner: the window never refuses it, and it isn't the community's.
    bought = await createVault();
    const keeper = await freshAccount(ETHER / 10n);
    await sendOk(keeper.key, bought, encodeExecute(owner.address), { gas: KEEPER_MIN_EXECUTE_GAS_LIMIT });

    // The community's: the same kind of buy, inside the window, paid to the proven holder.
    holderBought = await createVault();
    await sendOk(keeper.key, holderBought, encodeExecute(HOLDER), { gas: KEEPER_MIN_EXECUTE_GAS_LIMIT });

    closedVault = await createVault();
    await sendOk(owner.key, closedVault, encodeClose());

    // A v1 vault, on v1's frozen factory, bought by whoever called.
    const args = [0n, amountPerBuy, VAULT_LIMITS.MIN_INTERVAL, 2n, BigInt(latest.timestamp), v1BuyFee(amountPerBuy).reward, 300n] as const;
    const v1Budget = 2n * (amountPerBuy + v1BuyFee(amountPerBuy).reward);
    const created = await sendOk(owner.key, V1_MAINNET_FACTORY, encodeFunctionData({ abi: V1_FACTORY_ABI, functionName: "createVault", args }), { value: v1Budget });
    v1Vault = vaultsCreatedBy(V1_MAINNET_FACTORY, created.logs)[0]!.vault;
    await sendOk(keeper.key, v1Vault, encodeExecuteV1(), { gas: KEEPER_MIN_EXECUTE_GAS_LIMIT });

    block = BigInt((await rpc("eth_blockNumber", [])) as string);
  });

  afterAll(async () => {
    // The vaults still open go back to their owner; the closed one already did.
    for (const vault of [bought, holderBought, v1Vault]) if (vault) await sendOk(owner.key, vault, encodeClose());
  });

  it("adds up, at one pinned block, exactly what readVault says of every listed vault of every release at that block", async () => {
    const recorded = recording(rpc);
    // Every release there is, by default: v1's factory and this build's.
    first = await readPlatform(recorded.rpc, { block, cache });
    // Every request was a Multicall3 call at the pinned block: no "latest" slipped in.
    for (const { method, params } of recorded.sent) {
      expect(method).toBe("eth_call");
      expect((params[0] as { to: string }).to).toBe(CONTRACTS.multicall3);
      expect(params[1]).toBe(hex(block));
    }
    expect(first.requests).toBe(recorded.sent.length);
    expect(first.deployments.map((d) => [d.id, d.release, d.factory])).toEqual(DEPLOYMENTS.map((d) => [d.id, d.id, d.factory]));

    const pinnedReader = new Multicall3Reader(rpc, { blockTag: hex(block) });
    const states: VaultState[] = [];
    let made = 0n;
    for (const deployment of first.deployments) {
      if (deployment.state !== "read") throw new Error(`${deployment.id}'s factory should be deployed`);
      // The count, asked of the factory directly rather than through Multicall3.
      const countAtBlock = decodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "vaultCount",
        data: (await rpc("eth_call", [{ to: deployment.factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }) }, hex(block)])) as Hex,
      });
      expect(deployment.count).toBe(countAtBlock);
      expect(deployment.unreadable).toEqual([]);
      expect(BigInt(deployment.listed)).toBe(deployment.count);
      made += deployment.count;

      for (const figures of deployment.vaults) {
        const state = await readVault(rpc, figures.vault, { reader: pinnedReader });
        if (state === null) throw new Error(`${figures.vault} didn't read as a vault at block ${block}`);
        expect(state).toMatchObject({ release: deployment.release, fromFactory: true, factory: deployment.factory });
        expect(figures).toEqual({
          vault: state.address,
          release: state.release,
          owner: state.owner,
          terms: state.terms,
          closed: state.closed,
          buysDone: state.buysDone,
          totalOut: state.totalOut,
          wethBalance: state.status.wethBalance,
          windowBuys: state.windowBuys,
        });
        states.push(state);
      }
    }

    const summary = summarisePlatform(first);
    if (summary.state !== "read") throw new Error("expected figures");
    const exact = sumOfReadVault(states);
    expect(summary.made).toBe(made);
    expect(summary.read).toBe(states.length);
    expect(summary.unreadable + Number(summary.unread)).toBe(0);
    for (const [key, value] of Object.entries(exact)) {
      expect(summary[key as keyof typeof exact], key).toEqual({ value, atLeast: false });
    }
  });

  it("counts this test's own vaults as they are: one bought for its owner, one by the community, one closed, one of v1's", () => {
    const byAddress = new Map(first.deployments.flatMap((d) => (d.state === "read" ? d.vaults : [])).map((v) => [v.vault, v]));
    const mine = owner.address.toLowerCase();
    expect(byAddress.get(bought)).toMatchObject({ release: "v2", owner: mine, closed: false, buysDone: 1n, windowBuys: 0n });
    expect(byAddress.get(bought)!.totalOut > 0n).toBe(true);
    expect(byAddress.get(holderBought)).toMatchObject({ release: "v2", owner: mine, closed: false, buysDone: 1n, windowBuys: 1n });
    expect(byAddress.get(closedVault)).toMatchObject({ release: "v2", owner: mine, closed: true, buysDone: 0n, wethBalance: 0n, windowBuys: 0n });
    expect(byAddress.get(v1Vault)).toMatchObject({ release: "v1", owner: mine, closed: false, buysDone: 1n, windowBuys: null });
    expect(byAddress.get(v1Vault)!.terms.communityWindow).toBeNull();
    // The share counts the holder's buy among every v2 buy, and is known: every v2 vault was read.
    const summary = summarisePlatform(first);
    if (summary.state !== "read") throw new Error("expected figures");
    expect(summary.communityWindowBuys.value).toBeGreaterThanOrEqual(1n);
    expect(summary.v2Buys.value).toBeGreaterThanOrEqual(summary.communityWindowBuys.value + 1n);
    expect([summary.v2Buys.atLeast, summary.communityWindowBuys.atLeast]).toEqual([false, false]);
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
    const again = await readPlatform(rpc, { block, cache });
    expect(again.requests).toBeLessThanOrEqual(first.requests);
    expect({ ...summarisePlatform(again), requests: 0 }).toEqual({ ...summarisePlatform(first), requests: 0 });

    // At the latest block the new vault is there; at the pinned one it isn't.
    const latest = summarisePlatform(await readPlatform(rpc, { cache }));
    const pinned = summarisePlatform(first);
    if (latest.state !== "read" || pinned.state !== "read") throw new Error("expected figures");
    expect(latest.made).toBe((await readVaultCount(rpc, V1_MAINNET_FACTORY)) + (await readVaultCount(rpc, MAINNET_FACTORY)));
    expect(latest.made > pinned.made).toBe(true);
  });

  it("reads a factory address with no code as not deployed, through the Multicall3 path, with no figures", async () => {
    // A factory for another market list lands at another address, where nothing is deployed.
    const elsewhere = factoryAddress({ ...MAINNET_DEPLOYMENT, markets: [{ ...MAINNET_DEPLOYMENT.markets[0]!, tokenOut: TOKENS.USDC.address }] });
    expect(await hasCode(elsewhere)).toBe(false);
    const recorded = recording(rpc);
    const read = await readPlatform(recorded.rpc, { block, deployments: [{ id: "elsewhere", factory: elsewhere }] });
    expect(read.deployments).toEqual([{ id: "elsewhere", release: "v2", factory: elsewhere, state: "not-deployed" }]);
    expect(recorded.sent.map((s) => (s.params[0] as { to: string }).to)).toEqual([CONTRACTS.multicall3]);
    expect(summarisePlatform(read)).toEqual({ state: "not-deployed", block, requests: 1 });
  });
});
