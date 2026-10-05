/**
 * Collective DCA's reader and totals, against a chain made of plain objects
 * behind a real Multicall3 encoding: every request is decoded here the way
 * the contract would read it, and answered the way it would answer.
 *
 * The fork test (`test/integration/platform.test.ts`) holds the same reader to
 * the deployed contracts; this pins what that one can't reach on demand: a
 * vault that won't answer, a second market, the cap, both releases in one
 * read, the community window's share, and the exact request budget.
 */

import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  toFunctionSelector,
  type Abi,
} from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, TOKENS, type JsonRpc } from "@spdex/chain";
import { FACTORY_ABI, MAINNET_FACTORY, V1_MAINNET_FACTORY, V1_VAULT_ABI, VAULT_ABI, VAULT_LIMITS } from "./artifacts.js";
import { bucketOf, onTurn, turnOf, type VaultRelease, type VaultTerms } from "./index.js";
import {
  MAX_PLATFORM_VAULTS,
  PLATFORM_CALLS_PER_REQUEST,
  PLATFORM_REQUEST_GAS,
  platformReadCost,
  readDueCandidates,
  readPlatform,
  readVaultOwners,
  readVouchedOwners,
  summarisePlatform,
  type PlatformRead,
  type VaultIdentityCache,
} from "./platform.js";

const ETHER = 10n ** 18n;
const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;
const OTHER_TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const BLOCK = 26_001_248n;

const AGGREGATE3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const WETH_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

interface FakeVault {
  owner: Address;
  /** v2's terms carry a community window; v1's don't, and such a vault has no `windowBuys` at all. */
  terms: VaultTerms;
  closed: boolean;
  buysDone: bigint;
  totalOut: bigint;
  weth: bigint;
  /** v2's count of buys made inside their window for someone other than the owner. */
  windowBuys?: bigint;
  /** Views that revert, as a vault on a failing endpoint or a broken one might. */
  broken?: string[];
}

const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

function terms(overrides: Partial<VaultTerms> = {}): VaultTerms {
  return {
    tokenOut: SPX,
    pair: "0x52c77b0cb827afbad022e6d6caf2c44452edbc39",
    oraclePool: "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3",
    amountPerBuy: ETHER / 100n,
    interval: 86_400n,
    maxBuys: 10n,
    startAt: 1_700_000_000n,
    keeperReward: ETHER / 10_000n,
    maxSlippageBps: 200n,
    communityWindow: 1_800n,
    turnBuckets: 0n,
    ...overrides,
  };
}

/** The same terms as a v1 vault holds them: no window, no turns. */
const v1Terms = (overrides: Partial<VaultTerms> = {}): VaultTerms => terms({ communityWindow: null, turnBuckets: null, ...overrides });

interface Sent {
  method: string;
  blockTag?: unknown;
  gas?: unknown;
  calls: { target: Address; callData: Hex }[];
}

/**
 * A chain of factories and vaults. `factories` maps a factory to its list;
 * any other address that isn't a vault or WETH has no code, and a call to it
 * through Multicall3 succeeds with nothing, as on a real chain.
 */
function fakeChain(input: { factories: Record<string, Address[]>; vaults: Record<string, FakeVault>; block?: bigint; failEthCall?: boolean }) {
  const sent: Sent[] = [];
  const block = input.block ?? BLOCK;

  const answer = (target: Address, callData: Hex): { success: boolean; returnData: Hex } => {
    const to = target.toLowerCase();
    const list = input.factories[to];
    if (list) {
      const call = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
      if (call.functionName === "vaultCount") {
        return { success: true, returnData: encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", result: BigInt(list.length) }) };
      }
      if (call.functionName === "vaultsPage") {
        const [offset, limit] = call.args as [bigint, bigint];
        const page = list.slice(Number(offset), Number(offset) + Math.min(Number(limit), 1_000));
        return { success: true, returnData: encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", result: page }) };
      }
      if (call.functionName === "isVault") {
        const vouched = list.includes((call.args[0] as Address).toLowerCase() as Address);
        return { success: true, returnData: encodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", result: vouched }) };
      }
      throw new Error(`unexpected factory call ${call.functionName}`);
    }
    if (to === WETH) {
      const call = decodeFunctionData({ abi: WETH_ABI, data: callData });
      const vault = input.vaults[(call.args[0] as string).toLowerCase()];
      if (vault?.broken?.includes("weth")) return { success: false, returnData: "0x" };
      return { success: true, returnData: encodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", result: vault?.weth ?? 0n }) };
    }
    const vault = input.vaults[to];
    if (!vault) return { success: true, returnData: "0x" };
    const call = decodeFunctionData({ abi: VAULT_ABI, data: callData });
    if (vault.broken?.includes(call.functionName)) return { success: false, returnData: "0x" };
    const v1 = vault.terms.communityWindow === null;
    // A v1 vault has no windowBuys(): its fallback reverts, as any unknown selector does.
    if (call.functionName === "windowBuys" && v1) return { success: false, returnData: "0x" };
    const { communityWindow, turnBuckets: _turns, ...v1Shape } = vault.terms;
    const result = {
      owner: vault.owner,
      terms: v1 ? v1Shape : vault.terms,
      closed: vault.closed,
      buysDone: Number(vault.buysDone),
      totalOut: vault.totalOut,
      windowBuys: Number(vault.windowBuys ?? 0n),
    }[call.functionName as "owner"];
    if (result === undefined) throw new Error(`unexpected vault call ${call.functionName} (window ${communityWindow})`);
    const abi = (v1 ? V1_VAULT_ABI : VAULT_ABI) as Abi;
    return { success: true, returnData: encodeFunctionResult({ abi, functionName: call.functionName, result } as never) };
  };

  const rpc: JsonRpc = async (method, params) => {
    if (method === "eth_blockNumber") {
      sent.push({ method, calls: [] });
      return `0x${block.toString(16)}`;
    }
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const [tx, blockTag] = params as [{ to: string; data: Hex; gas?: string }, unknown];
    expect(tx.to).toBe(CONTRACTS.multicall3);
    const { args } = decodeFunctionData({ abi: AGGREGATE3, data: tx.data });
    const calls = (args[0] as readonly { target: Address; callData: Hex }[]).map(({ target, callData }) => ({ target, callData }));
    sent.push({ method, blockTag, gas: tx.gas, calls });
    if (input.failEthCall) throw new Error("eth_call: header not found");
    return encodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", result: calls.map((c) => answer(c.target, c.callData)) });
  };
  return { rpc, sent };
}

/** `n` open SPX vaults of `release`, each bought once (v2's inside its window), owned by `owners` in turn. */
function manyVaults(n: number, owners = 3, release: VaultRelease = "v2", from = 0x10_0000): { list: Address[]; vaults: Record<string, FakeVault> } {
  const list: Address[] = [];
  const vaults: Record<string, FakeVault> = {};
  for (let i = 0; i < n; i++) {
    const vault = address(from + i);
    list.push(vault);
    vaults[vault] = {
      owner: address(0xa0 + (i % owners)),
      terms: release === "v1" ? v1Terms() : terms(),
      closed: false,
      buysDone: 1n,
      totalOut: 100n * 10n ** 8n,
      weth: ETHER / 10n,
      ...(release === "v2" ? { windowBuys: 1n } : {}),
    };
  }
  return { list, vaults };
}

/** This build's factory, v2's, and v1's frozen one. */
const factory = MAINNET_FACTORY as Address;
const v1Factory = V1_MAINNET_FACTORY as Address;

describe("readPlatform", () => {
  it("reads every figure at one pinned block, through Multicall3 only, 200 calls a request at 30M gas", async () => {
    const { list, vaults } = manyVaults(301);
    const { rpc, sent } = fakeChain({ factories: { [factory]: list }, vaults });
    const read = await readPlatform(rpc, { deployments: [{ id: "v2", factory }] });

    expect(read.block).toBe(BLOCK);
    const calls = sent.filter((s) => s.method === "eth_call");
    for (const call of calls) {
      expect(call.blockTag).toBe(`0x${BLOCK.toString(16)}`);
      expect(BigInt(call.gas as string)).toBe(PLATFORM_REQUEST_GAS);
      expect(call.calls.length).toBeLessThanOrEqual(PLATFORM_CALLS_PER_REQUEST);
    }
    const [deployment] = read.deployments;
    expect(deployment).toMatchObject({ state: "read", release: "v2", count: 301n, listed: 301, unreadable: [] });
    expect(deployment?.state === "read" && deployment.vaults.length).toBe(301);
    expect(deployment?.state === "read" && deployment.vaults[0]).toMatchObject({ release: "v2", windowBuys: 1n, terms: terms() });
  });

  it("costs 13 requests for 301 v1 vaults the first time and 10 once owners and terms are cached, as the budget formula says", async () => {
    const { list, vaults } = manyVaults(301, 3, "v1");
    const { rpc, sent } = fakeChain({ factories: { [v1Factory]: list }, vaults });
    const cache: VaultIdentityCache = new Map();

    const first = await readPlatform(rpc, { deployments: [{ id: "v1", factory: v1Factory }], cache });
    expect(first.requests).toBe(13);
    expect(sent).toHaveLength(13);
    expect(platformReadCost([{ release: "v1", vaults: 301 }])).toBe(13);
    expect(cache.size).toBe(301);
    // v1's vaults have no window, and are never asked for one.
    expect(sent.flatMap((s) => s.calls).some((c) => c.callData.startsWith(toFunctionSelector("windowBuys()")))).toBe(false);

    const second = await readPlatform(rpc, { deployments: [{ id: "v1", factory: v1Factory }], cache });
    // 2 + ⌈301/1000⌉ + ⌈4 × 301/200⌉ = 2 + 1 + 7: ⌈6.02⌉ is 7, not 6.
    expect(second.requests).toBe(10);
    expect(platformReadCost([{ release: "v1", vaults: 301, cached: 301 }])).toBe(10);
    // Cached reads never ask again for what can't change.
    const selectors = new Set(sent.slice(13).flatMap((s) => s.calls.map((c) => c.callData.slice(0, 10))));
    expect(selectors.has(toFunctionSelector("owner()"))).toBe(false);
    expect(selectors.has(toFunctionSelector("terms()"))).toBe(false);
    expect({ ...summarisePlatform(second), requests: 0 }).toEqual({ ...summarisePlatform(first), requests: 0 });
  });

  it("costs one more call a vault for v2, its window buys: 14 requests for 301 the first time, 11 once cached", async () => {
    const { list, vaults } = manyVaults(301);
    const { rpc } = fakeChain({ factories: { [factory]: list }, vaults });
    const cache: VaultIdentityCache = new Map();
    // 2 + 1 + ⌈7 × 301/200⌉ = 14, then 2 + 1 + ⌈5 × 301/200⌉ = 11.
    expect((await readPlatform(rpc, { deployments: [{ id: "v2", factory }], cache })).requests).toBe(14);
    expect(platformReadCost([{ release: "v2", vaults: 301 }])).toBe(14);
    expect((await readPlatform(rpc, { deployments: [{ id: "v2", factory }], cache })).requests).toBe(11);
    expect(platformReadCost([{ release: "v2", vaults: 301, cached: 301 }])).toBe(11);
  });

  it("reads both releases in one read, every release's own way, and the totals cover both", async () => {
    const old = manyVaults(5, 2, "v1", 0x30_0000);
    const current = manyVaults(7, 3, "v2", 0x40_0000);
    current.vaults[current.list[0]!]!.windowBuys = 0n;
    const { rpc, sent } = fakeChain({ factories: { [v1Factory]: old.list, [factory]: current.list }, vaults: { ...old.vaults, ...current.vaults } });
    // By default, every release there is.
    const read = await readPlatform(rpc);
    expect(read.deployments.map((d) => [d.id, d.release, d.factory, d.state])).toEqual([
      ["v1", "v1", v1Factory, "read"],
      ["v2", "v2", factory, "read"],
    ]);
    // The block, the counts, and per release one page and one figures batch.
    expect(read.requests).toBe(2 + 2 + 2);
    expect(read.requests).toBe(platformReadCost([{ release: "v1", vaults: 5 }, { release: "v2", vaults: 7 }]));
    expect(sent.length).toBe(read.requests);
    const summary = summarisePlatform(read);
    if (summary.state !== "read") throw new Error("expected figures");
    expect(summary).toMatchObject({
      made: 12n,
      read: 12,
      buys: { value: 12n, atLeast: false },
      v2Buys: { value: 7n, atLeast: false },
      communityWindowBuys: { value: 6n, atLeast: false },
      owners: { value: 3n, atLeast: false },
    });
  });

  it("puts a v2 vault whose window count can't be read in unreadable, and a vault of the other release's shape too", async () => {
    const { list, vaults } = manyVaults(3);
    vaults[list[0]!]!.broken = ["windowBuys"];
    vaults[list[1]!]!.terms = v1Terms();
    const { rpc } = fakeChain({ factories: { [factory]: list }, vaults });
    const read = await readPlatform(rpc, { deployments: [{ id: "v2", factory }] });
    expect(read.deployments[0]).toMatchObject({ state: "read", unreadable: [list[0], list[1]] });
    const summary = summarisePlatform(read);
    if (summary.state !== "read") throw new Error("expected figures");
    // A share of a partial read is no lower bound of anything: both v2 figures say so.
    expect(summary).toMatchObject({ v2Buys: { value: 1n, atLeast: true }, communityWindowBuys: { value: 1n, atLeast: true } });
  });

  it("reads a factory with no code as not deployed, through the same Multicall3 call, and yields no figures", async () => {
    const nowhere = address(0xdead);
    const { rpc, sent } = fakeChain({ factories: {}, vaults: {} });
    const read = await readPlatform(rpc, { deployments: [{ id: "v2", factory: nowhere }] });
    expect(read.deployments).toEqual([{ id: "v2", release: "v2", factory: nowhere, state: "not-deployed" }]);
    expect(sent.filter((s) => s.method === "eth_call")).toHaveLength(1);
    const summary = summarisePlatform(read);
    expect(summary).toEqual({ state: "not-deployed", block: BLOCK, requests: 2 });
    expect(Object.keys(summary)).not.toContain("buys");
  });

  it("tells a factory with no vaults yet (0) from one with no code (not deployed)", async () => {
    const { rpc } = fakeChain({ factories: { [factory]: [] }, vaults: {} });
    const summary = summarisePlatform(await readPlatform(rpc, { deployments: [{ id: "v2", factory }] }));
    expect(summary).toMatchObject({ state: "read", made: 0n, buys: { value: 0n, atLeast: false } });
  });

  it("puts a vault whose calls fail in unreadable, never at zero, and every total says at least", async () => {
    const { list, vaults } = manyVaults(3);
    vaults[list[1]!]!.broken = ["totalOut"];
    const { rpc } = fakeChain({ factories: { [factory]: list }, vaults });
    const read = await readPlatform(rpc, { deployments: [{ id: "v2", factory }] });
    expect(read.deployments[0]).toMatchObject({ state: "read", unreadable: [list[1]] });
    const summary = summarisePlatform(read);
    if (summary.state !== "read") throw new Error("expected figures");
    expect(summary.unreadable).toBe(1);
    expect(summary.buys).toEqual({ value: 2n, atLeast: true });
    expect(summary.owners.atLeast).toBe(true);
    expect(summary.spxDelivered).toEqual({ value: 200n * 10n ** 8n, atLeast: true });
  });

  it("doesn't cache an identity it couldn't read", async () => {
    const { list, vaults } = manyVaults(2);
    vaults[list[0]!]!.broken = ["terms"];
    const { rpc } = fakeChain({ factories: { [factory]: list }, vaults });
    const cache: VaultIdentityCache = new Map();
    await readPlatform(rpc, { deployments: [{ id: "v2", factory }], cache });
    expect(cache.has(list[0]!)).toBe(false);
    expect(cache.get(list[1]!)).toMatchObject({ owner: vaults[list[1]!]!.owner });
  });

  it("fails the whole read when the factory's list can't be read, rather than show a guess", async () => {
    const { list, vaults } = manyVaults(2);
    const { rpc } = fakeChain({ factories: { [factory]: list }, vaults, failEthCall: true });
    await expect(readPlatform(rpc, { deployments: [{ id: "v2", factory }] })).rejects.toThrow(/header not found/);
  });

  it("stops at its cap, says at least, and reads the rest at the same block when asked", async () => {
    const { list, vaults } = manyVaults(7);
    const { rpc, sent } = fakeChain({ factories: { [factory]: list }, vaults });
    const cache: VaultIdentityCache = new Map();
    const first = await readPlatform(rpc, { deployments: [{ id: "v2", factory }], maxVaults: 5, cache });
    const partial = summarisePlatform(first);
    if (partial.state !== "read") throw new Error("expected figures");
    expect(partial).toMatchObject({ made: 7n, read: 5, unread: 2n, buys: { value: 5n, atLeast: true } });

    const before = sent.length;
    const rest = await readPlatform(rpc, { previous: first, cache });
    // Neither the block nor the count is asked again: at one block they can't change.
    expect(sent.slice(before).map((s) => s.method)).toEqual(["eth_call", "eth_call"]);
    for (const call of sent.slice(before)) expect(call.blockTag).toBe(`0x${BLOCK.toString(16)}`);
    expect(rest.requests).toBe(first.requests + 2);
    const whole = summarisePlatform(rest);
    expect(whole).toMatchObject({ made: 7n, read: 7, unread: 0n, buys: { value: 7n, atLeast: false } });
    // The earlier read is left as it was.
    expect(summarisePlatform(first)).toEqual(partial);
    expect(MAX_PLATFORM_VAULTS).toBe(5_000);
  });

  it("refuses a nonsense cap", async () => {
    const { rpc } = fakeChain({ factories: {}, vaults: {} });
    await expect(readPlatform(rpc, { maxVaults: -1 })).rejects.toThrow(RangeError);
  });
});

describe("summarisePlatform", () => {
  const read = (vaults: FakeVault[], extra: Partial<Extract<PlatformRead["deployments"][number], { state: "read" }>> = {}): PlatformRead => ({
    block: BLOCK,
    requests: 13,
    deployments: [
      {
        id: "v2",
        release: "v2",
        factory,
        state: "read",
        count: BigInt(vaults.length),
        listed: vaults.length,
        unreadable: [],
        vaults: vaults.map((v, i) => ({
          vault: address(0x5000 + i),
          release: "v2" as const,
          owner: v.owner,
          terms: v.terms,
          closed: v.closed,
          buysDone: v.buysDone,
          totalOut: v.totalOut,
          wethBalance: v.weth,
          windowBuys: v.windowBuys ?? 0n,
        })),
        ...extra,
      },
    ],
  });

  const alice = address(0xa11ce);
  const bob = address(0xb0b);

  it("adds up closed, finished and open vaults the way the panel labels them", () => {
    const amount = ETHER / 100n;
    const reward = ETHER / 10_000n;
    const summary = summarisePlatform(
      read([
        // Open: 3 of 10 bought, holding enough for the other 7.
        { owner: alice, terms: terms(), closed: false, buysDone: 3n, totalOut: 300n * 10n ** 8n, weth: 7n * (amount + reward) },
        // Finished: all 10 bought, not closed, holding someone's stray WETH.
        { owner: alice, terms: terms(), closed: false, buysDone: 10n, totalOut: 1_000n * 10n ** 8n, weth: 5n },
        // Closed after 2 buys: holds nothing, spent what it spent.
        { owner: bob, terms: terms(), closed: true, buysDone: 2n, totalOut: 200n * 10n ** 8n, weth: 0n },
      ]),
    );
    if (summary.state !== "read") throw new Error("expected figures");
    const exact = (value: bigint) => ({ value, atLeast: false });
    expect(summary).toMatchObject({
      made: 3n,
      read: 3,
      unreadable: 0,
      unread: 0n,
      buys: exact(15n),
      spxDelivered: exact(1_500n * 10n ** 8n),
      otherDelivered: [],
      open: exact(1n),
      finished: exact(1n),
      closed: exact(1n),
      owners: exact(2n),
      ethSpent: exact(15n * amount),
      fees: exact(15n * reward),
      committed: exact(7n * (amount + reward)),
      held: exact(7n * (amount + reward) + 5n),
    });
  });

  it("caps a vault's committed budget at the WETH it actually holds", () => {
    const summary = summarisePlatform(
      read([{ owner: alice, terms: terms({ maxBuys: 10n }), closed: false, buysDone: 0n, totalOut: 0n, weth: ETHER / 1_000n }]),
    );
    expect(summary.state === "read" && summary.committed.value).toBe(ETHER / 1_000n);
  });

  it("keeps each other market's deliveries apart from SPX", () => {
    const summary = summarisePlatform(
      read([
        { owner: alice, terms: terms(), closed: false, buysDone: 1n, totalOut: 7n, weth: 0n },
        { owner: bob, terms: terms({ tokenOut: OTHER_TOKEN }), closed: false, buysDone: 1n, totalOut: 11n, weth: 0n },
        { owner: bob, terms: terms({ tokenOut: OTHER_TOKEN }), closed: true, buysDone: 2n, totalOut: 13n, weth: 0n },
      ]),
    );
    if (summary.state !== "read") throw new Error("expected figures");
    expect(summary.spxDelivered.value).toBe(7n);
    expect(summary.otherDelivered).toEqual([{ tokenOut: OTHER_TOKEN, delivered: { value: 24n, atLeast: false } }]);
    expect(summary.buys.value).toBe(4n);
  });

  it("marks every total at least when some listed vaults weren't read", () => {
    const summary = summarisePlatform(read([{ owner: alice, terms: terms(), closed: false, buysDone: 1n, totalOut: 1n, weth: 0n }], { count: 4n, listed: 1 }));
    if (summary.state !== "read") throw new Error("expected figures");
    expect(summary.unread).toBe(3n);
    for (const key of ["buys", "spxDelivered", "open", "finished", "closed", "owners", "ethSpent", "fees", "committed", "held", "v2Buys", "communityWindowBuys"] as const) {
      expect(summary[key].atLeast, key).toBe(true);
    }
  });

  it("counts the buys SPX holders made inside their community windows against every v2 buy", () => {
    const summary = summarisePlatform(
      read([
        { owner: alice, terms: terms(), closed: false, buysDone: 3n, totalOut: 3n, weth: 0n, windowBuys: 2n },
        { owner: bob, terms: terms(), closed: true, buysDone: 5n, totalOut: 5n, weth: 0n, windowBuys: 1n },
        // None of its buys made by the community: the owner's, or after the window.
        { owner: bob, terms: terms(), closed: false, buysDone: 4n, totalOut: 4n, weth: 0n, windowBuys: 0n },
      ]),
    );
    expect(summary).toMatchObject({ v2Buys: { value: 12n, atLeast: false }, communityWindowBuys: { value: 3n, atLeast: false } });
  });

  it("knows the v2 share even while only v1's vaults were left unread, and only then", () => {
    const both: PlatformRead = {
      ...read([{ owner: alice, terms: terms(), closed: false, buysDone: 2n, totalOut: 1n, weth: 0n, windowBuys: 1n }]),
    };
    both.deployments.unshift({ id: "v1", release: "v1", factory: v1Factory, state: "read", count: 3n, listed: 0, unreadable: [], vaults: [] });
    const summary = summarisePlatform(both);
    expect(summary).toMatchObject({
      buys: { value: 2n, atLeast: true },
      v2Buys: { value: 2n, atLeast: false },
      communityWindowBuys: { value: 1n, atLeast: false },
    });
  });

  it("gives no figures while no release's factory is deployed", () => {
    const summary = summarisePlatform({ block: BLOCK, requests: 2, deployments: [{ id: "v1", release: "v1", factory, state: "not-deployed" }] });
    expect(summary).toEqual({ state: "not-deployed", block: BLOCK, requests: 2 });
  });

  it("counts a v2 vault whose window count is unknown as unknown, never as none: both v2 figures at least", () => {
    const built = read([
      { owner: alice, terms: terms(), closed: false, buysDone: 3n, totalOut: 3n, weth: 0n, windowBuys: 2n },
      { owner: bob, terms: terms(), closed: false, buysDone: 4n, totalOut: 4n, weth: 0n, windowBuys: 1n },
    ]);
    // A read made some other way than readPlatform, which leaves such a vault out as unreadable.
    const deployment = built.deployments[0] as Extract<PlatformRead["deployments"][number], { state: "read" }>;
    deployment.vaults[1] = { ...deployment.vaults[1]!, windowBuys: null };
    const summary = summarisePlatform(built);
    expect(summary).toMatchObject({ v2Buys: { value: 7n, atLeast: true }, communityWindowBuys: { value: 2n, atLeast: true } });
  });

  it("says a true 0 of v2 buys when only v1's factory is deployed: no share to show, and nothing hidden", () => {
    const summary = summarisePlatform({
      block: BLOCK,
      requests: 4,
      deployments: [
        { id: "v1", release: "v1", factory: v1Factory, state: "read", count: 0n, listed: 0, unreadable: [], vaults: [] },
        { id: "v2", release: "v2", factory, state: "not-deployed" },
      ],
    });
    expect(summary).toMatchObject({ v2Buys: { value: 0n, atLeast: false }, communityWindowBuys: { value: 0n, atLeast: false } });
  });
});

describe("readVaultOwners", () => {
  it("asks each vault only for its owner, never naming anyone, and uses the cache", async () => {
    const { list, vaults } = manyVaults(3);
    const { rpc, sent } = fakeChain({ factories: {}, vaults });
    const cache: VaultIdentityCache = new Map([[list[0]!, { owner: vaults[list[0]!]!.owner }]]);
    const owners = await readVaultOwners(rpc, list, { block: BLOCK, cache });
    expect([...owners.values()]).toEqual(list.map((v) => vaults[v]!.owner));
    const calls = sent.flatMap((s) => s.calls);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.callData).toBe(encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }));
  });
});

describe("readVouchedOwners", () => {
  it("asks the factory about each vault and the vault for its owner, in one request, and believes only the factory's yes", async () => {
    const factory = address(0xfac);
    const { list, vaults } = manyVaults(3);
    const stranger = address(0x5eed);
    vaults[stranger] = { ...vaults[list[0]!]!, owner: address(0xbad) };
    vaults[list[2]!] = { ...vaults[list[2]!]!, broken: ["owner"] };
    const { rpc, sent } = fakeChain({ factories: { [factory]: list }, vaults });

    const owners = await readVouchedOwners(rpc, factory, [list[0]!, stranger, list[2]!, list[1]!]);
    expect(owners).toEqual(new Map([[list[0]!, vaults[list[0]!]!.owner], [list[1]!, vaults[list[1]!]!.owner]]));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.calls.map((c) => c.target.toLowerCase())).toEqual([factory, list[0], factory, stranger, factory, list[2], factory, list[1]]);
    expect(sent[0]!.calls[0]!.callData).toBe(encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [list[0]!] }));
  });

  it("asks every release's factory, and believes any one's yes: a receipt's buy may be either's vault", async () => {
    const old = manyVaults(2, 1, "v1", 0x50_0000);
    const current = manyVaults(2, 2, "v2", 0x60_0000);
    const stranger = address(0x5eed);
    const vaults = { ...old.vaults, ...current.vaults, [stranger]: { ...current.vaults[current.list[0]!]!, owner: address(0xbad) } };
    const { rpc, sent } = fakeChain({ factories: { [v1Factory]: old.list, [factory]: current.list }, vaults });
    const owners = await readVouchedOwners(rpc, [v1Factory, factory], [old.list[0]!, stranger, current.list[1]!]);
    expect(owners).toEqual(
      new Map([
        [old.list[0]!, vaults[old.list[0]!]!.owner],
        [current.list[1]!, vaults[current.list[1]!]!.owner],
      ]),
    );
    // One request: each factory asked about each vault, then the vault's owner.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.calls.map((c) => c.target.toLowerCase())).toEqual([v1Factory, factory, old.list[0], v1Factory, factory, stranger, v1Factory, factory, current.list[1]]);
  });

  it("throws when the request fails, rather than calling every vault unvouched", async () => {
    const { rpc } = fakeChain({ factories: {}, vaults: {}, failEthCall: true });
    await expect(readVouchedOwners(rpc, address(0xfac), [address(1)])).rejects.toThrow("header not found");
  });
});

// ─── Due buys, for "Help run the network" ─────────────────────────────────────

describe("readDueCandidates", () => {
  const NOW = 1_790_000_000n;
  const MULTICALL3_TIME = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);
  const DEPTH = 20n * ETHER;

  interface DueVault {
    owner: Address;
    terms: VaultTerms;
    closed: boolean;
    buysDone: bigint;
    lastBuyAt: bigint;
    weth: bigint;
    quote: [bigint, bigint, bigint] | null;
  }

  /**
   * A vault whose next buy the clock has allowed for an hour, funded, priced
   * inside its floor: its last buy was in slot 1, slot 2 went unbought, and the
   * block is the first second of slot 3, so the buy is due from slot 3's start
   * and its 15-minute community window has just begun.
   */
  const due = (overrides: Partial<DueVault> = {}): DueVault => ({
    owner: address(0xa0),
    terms: terms({ interval: 3_600n, startAt: NOW - 3n * 3_600n, communityWindow: 900n }),
    closed: false,
    buysDone: 1n,
    lastBuyAt: NOW - 2n * 3_600n,
    weth: ETHER,
    quote: [5_000n, 4_900n, DEPTH],
    ...overrides,
  });

  function dueChain(vaults: Record<string, DueVault>, options: { time?: bigint | null } = {}) {
    const sent: Sent[] = [];
    const answer = (target: Address, callData: Hex): { success: boolean; returnData: Hex } => {
      const to = target.toLowerCase();
      if (to === CONTRACTS.multicall3) {
        if (options.time === null) return { success: false, returnData: "0x" };
        return { success: true, returnData: encodeFunctionResult({ abi: MULTICALL3_TIME, functionName: "getCurrentBlockTimestamp", result: options.time ?? NOW }) };
      }
      if (to === WETH) {
        const call = decodeFunctionData({ abi: WETH_ABI, data: callData });
        return { success: true, returnData: encodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", result: vaults[(call.args[0] as string).toLowerCase()]?.weth ?? 0n }) };
      }
      const vault = vaults[to];
      if (!vault) return { success: true, returnData: "0x" };
      const call = decodeFunctionData({ abi: VAULT_ABI, data: callData });
      if (call.functionName === "quote") {
        if (vault.quote === null) return { success: false, returnData: "0x" };
        return { success: true, returnData: encodeFunctionResult({ abi: VAULT_ABI as Abi, functionName: "quote", result: vault.quote } as never) };
      }
      const result = { buysDone: Number(vault.buysDone), lastBuyAt: Number(vault.lastBuyAt), closed: vault.closed }[call.functionName as "closed"];
      if (result === undefined) throw new Error(`unexpected vault call ${call.functionName}`);
      return { success: true, returnData: encodeFunctionResult({ abi: VAULT_ABI as Abi, functionName: call.functionName, result } as never) };
    };
    const rpc: JsonRpc = async (method, params) => {
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const [tx, blockTag] = params as [{ to: string; data: Hex; gas?: string }, unknown];
      expect(tx.to).toBe(CONTRACTS.multicall3);
      const { args } = decodeFunctionData({ abi: AGGREGATE3, data: tx.data });
      const calls = (args[0] as readonly { target: Address; callData: Hex }[]).map(({ target, callData }) => ({ target, callData }));
      sent.push({ method, blockTag, gas: tx.gas, calls });
      return encodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", result: calls.map((c) => answer(c.target, c.callData)) });
    };
    return { rpc, sent };
  }

  /** A read of `vaults` as the panel's reader returns it, with each vault as that read saw it. */
  function readOf(
    vaults: Record<string, DueVault>,
    seen: Partial<Record<string, Partial<{ closed: boolean; buysDone: bigint; weth: bigint }>>> = {},
    at: Address = factory,
    release: VaultRelease = "v2",
  ): PlatformRead {
    return {
      block: BLOCK,
      requests: 0,
      deployments: [
        {
          id: release,
          release,
          factory: at.toLowerCase() as Address,
          state: "read",
          count: BigInt(Object.keys(vaults).length),
          listed: Object.keys(vaults).length,
          unreadable: [],
          vaults: Object.entries(vaults).map(([vault, v]) => ({
            vault: vault as Address,
            release,
            owner: v.owner,
            terms: v.terms,
            closed: seen[vault]?.closed ?? v.closed,
            buysDone: seen[vault]?.buysDone ?? v.buysDone,
            totalOut: 0n,
            wethBalance: seen[vault]?.weth ?? v.weth,
            windowBuys: release === "v1" ? null : 0n,
          })),
        },
      ],
    };
  }

  it("keeps each vault due at the block and priced inside its floor, as a batch candidate", async () => {
    const first = address(0x20_0001);
    const later = address(0x20_0002);
    const vaults = { [first]: due({ buysDone: 0n, lastBuyAt: 0n }), [later]: due() };
    const { rpc, sent } = dueChain(vaults);
    const found = await readDueCandidates(rpc, readOf(vaults), { block: BLOCK });
    expect(found.map((c) => c.vault)).toEqual([first, later]);
    expect(found[0]).toMatchObject({
      owner: address(0xa0),
      order: 0n,
      amountPerBuy: ETHER / 100n,
      reward: ETHER / 10_000n,
      firstBuy: true,
      urgent: false,
      subsidised24h: 0n,
      spotOut: 5_000n,
      floorOut: 4_900n,
    });
    expect(found[1]!.firstBuy).toBe(false);
    // What a claim on each vault names, beside the nonce the app finds: its release, its owner and its whole terms.
    for (const [i, vault] of [first, later].entries()) {
      expect(found[i]).toMatchObject({ release: "v2", owner: vaults[vault]!.owner, terms: vaults[vault]!.terms });
      expect(found[i]!.terms.turnBuckets).toBe(0n);
    }
    // One request at the block: the block's time and five calls a vault.
    expect(sent.length).toBe(1);
    expect(sent[0]!.blockTag).toBe(`0x${BLOCK.toString(16)}`);
    expect(sent[0]!.calls.length).toBe(1 + 5 * 2);
  });

  it("leaves out what the block shows isn't due, open, funded or priced, and a vault any of whose calls fails", async () => {
    const vaults = {
      [address(0x21_0001)]: due({ lastBuyAt: NOW - 60n }),
      [address(0x21_0002)]: due({ closed: true }),
      [address(0x21_0003)]: due({ weth: 1n }),
      [address(0x21_0004)]: due({ quote: [4_000n, 4_900n, DEPTH] }),
      [address(0x21_0005)]: due({ quote: [5_000n, 4_900n, VAULT_LIMITS.MIN_ORACLE_DEPTH - 1n] }),
      [address(0x21_0006)]: due({ quote: null }),
      [address(0x21_0007)]: due({ terms: terms({ interval: 3_600n, startAt: NOW + 60n }), buysDone: 0n, lastBuyAt: 0n }),
      [address(0x21_0008)]: due(),
    };
    // The read saw them all as open and funded: the block is what decides.
    const { rpc } = dueChain(vaults);
    const found = await readDueCandidates(rpc, readOf(vaults, { [address(0x21_0002)]: { closed: false }, [address(0x21_0003)]: { weth: ETHER } }), { block: BLOCK });
    expect(found.map((c) => c.vault)).toEqual([address(0x21_0008)]);
  });

  it("asks nothing about a vault the read found closed, finished or underfunded, nor about another factory's", async () => {
    const vaults = {
      [address(0x22_0001)]: due({ closed: true }),
      [address(0x22_0002)]: due({ buysDone: 10n }),
      [address(0x22_0003)]: due({ weth: ETHER / 100n }),
    };
    const { rpc, sent } = dueChain(vaults);
    expect(await readDueCandidates(rpc, readOf(vaults), { block: BLOCK })).toEqual([]);
    expect(sent).toEqual([]);
    const elsewhere = { [address(0x22_0004)]: due() };
    expect(await readDueCandidates(dueChain(elsewhere).rpc, readOf(elsewhere, {}, address(0xfac7)), { block: BLOCK })).toEqual([]);
    expect(await readDueCandidates(dueChain(elsewhere).rpc, readOf(elsewhere, {}, address(0xfac7)), { block: BLOCK, factory: address(0xfac7) })).toHaveLength(1);
  });

  it("reads 30 vaults a request", async () => {
    const vaults: Record<string, DueVault> = {};
    for (let i = 0; i < 61; i++) vaults[address(0x23_0000 + i)] = due();
    const { rpc, sent } = dueChain(vaults);
    expect(await readDueCandidates(rpc, readOf(vaults), { block: BLOCK })).toHaveLength(61);
    expect(sent.length).toBe(Math.ceil((5 * 61 + 1) / 151));
  });

  it("says when each buy fell due and its community window ends: after a missed slot, from that slot's start", async () => {
    const vault = address(0x25_0001);
    const vaults = { [vault]: due() };
    const [candidate] = await readDueCandidates(dueChain(vaults).rpc, readOf(vaults), { block: BLOCK });
    // The clock allowed it from NOW − 1 h (slot 2), but slot 2 passed unbought: due from slot 3's start.
    expect(candidate).toMatchObject({ dueSince: NOW, windowEndsAt: NOW + 900n, inWindow: true, deadline: NOW + 900n });
    // The window's last second, and the first after it, when anyone may be paid and the slot's deadline is back.
    const last = await readDueCandidates(dueChain(vaults, { time: NOW + 899n }).rpc, readOf(vaults), { block: BLOCK });
    expect(last[0]).toMatchObject({ dueSince: NOW, windowEndsAt: NOW + 900n, inWindow: true });
    const open = await readDueCandidates(dueChain(vaults, { time: NOW + 900n }).rpc, readOf(vaults), { block: BLOCK });
    expect(open[0]).toMatchObject({ dueSince: NOW, windowEndsAt: NOW + 900n, inWindow: false, deadline: NOW + 3_600n - 720n });
  });

  it("measures a buy held back by the spacing rule from half an interval after the last, not from its slot's start", async () => {
    // Bought in slot 2's last second: the next falls due 30 minutes later, inside slot 3.
    const vault = address(0x26_0001);
    const vaults = { [vault]: due({ buysDone: 2n, lastBuyAt: NOW - 1n }) };
    const spaced = NOW - 1n + 1_800n;
    expect(await readDueCandidates(dueChain(vaults, { time: spaced - 1n }).rpc, readOf(vaults), { block: BLOCK })).toEqual([]);
    const [candidate] = await readDueCandidates(dueChain(vaults, { time: spaced + 10n }).rpc, readOf(vaults), { block: BLOCK });
    expect(candidate).toMatchObject({ dueSince: spaced, windowEndsAt: spaced + 900n, inWindow: true });
  });

  it("says when a plan's turn ends and whether the block is in it, with what onTurn needs; nothing for a plan without turns", async () => {
    const vault = address(0x28_0001);
    const turned = { [vault]: due({ terms: terms({ interval: 3_600n, startAt: NOW - 3n * 3_600n, communityWindow: 900n, turnBuckets: 4n }) }) };
    const [inTurn] = await readDueCandidates(dueChain(turned).rpc, readOf(turned), { block: BLOCK });
    expect(inTurn).toMatchObject({ release: "v2", turnBuckets: 4n, turnEndsAt: NOW + 450n, inTurn: true, inWindow: true, terms: turned[vault]!.terms });
    // Whoever the app would pay is on its turn or not by the vault's own hashes; the owner always is.
    const slot = (inTurn!.dueSince - inTurn!.terms.startAt) / inTurn!.terms.interval;
    const asked = (rewardTo: Address) => onTurn({ vault, owner: inTurn!.owner, rewardTo, terms: inTurn!.terms, dueSince: inTurn!.dueSince, now: NOW });
    expect(asked(inTurn!.owner)).toBe(true);
    for (let i = 1; i < 12; i++) expect(asked(address(i))).toBe(bucketOf(address(i), 4n) === turnOf(vault, slot, 4n));
    // From the turn's end, any eligible holder, inside the window still.
    const after = await readDueCandidates(dueChain(turned, { time: NOW + 450n }).rpc, readOf(turned), { block: BLOCK });
    expect(after[0]).toMatchObject({ turnEndsAt: NOW + 450n, inTurn: false, inWindow: true });

    const plain = { [vault]: due() };
    const [without] = await readDueCandidates(dueChain(plain).rpc, readOf(plain), { block: BLOCK });
    expect(without).toMatchObject({ turnBuckets: 0n, turnEndsAt: null, inTurn: false });
  });

  it("finds none in a v1 factory's vaults, and asks nothing: Help run makes v2 buys only", async () => {
    const vaults = { [address(0x27_0001)]: due({ terms: terms({ interval: 3_600n, startAt: NOW - 3n * 3_600n, communityWindow: null }) }) };
    const { rpc, sent } = dueChain(vaults);
    expect(await readDueCandidates(rpc, readOf(vaults, {}, v1Factory, "v1"), { block: BLOCK, factory: v1Factory })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("throws without the block's time: nothing can be judged due", async () => {
    const vaults = { [address(0x24_0001)]: due() };
    await expect(readDueCandidates(dueChain(vaults, { time: null }).rpc, readOf(vaults), { block: BLOCK })).rejects.toThrow(/time of block/);
  });
});
