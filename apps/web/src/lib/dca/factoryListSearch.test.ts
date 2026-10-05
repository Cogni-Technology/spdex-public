/**
 * The factory-list owner search, over a list served by stand-ins for
 * `@spdex/vault`'s pinned readers (which are pinned themselves in
 * `packages/vault/src/platform.test.ts`, and together with this on the fork in
 * `apps/web/test/integration/factory-list-search.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpc } from "@spdex/chain";
import type { Address } from "@spdex/core";

const readers = vi.hoisted(() => ({
  latestBlock: vi.fn(),
  factoryCounts: vi.fn(),
  readFactoryPages: vi.fn(),
  readVaultOwners: vi.fn(),
}));
vi.mock("@spdex/vault", async (importOriginal) => ({ ...(await importOriginal<typeof import("@spdex/vault")>()), ...readers }));

const { MAINNET_FACTORY, V1_MAINNET_FACTORY } = await import("@spdex/vault");
const { factoryListSearchCost, listedFactories, searchVaultsFromFactoryList } = await import("./factoryListSearch.js");

const rpc: JsonRpc = async () => null;
const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ME = "0x00000000000000000000000000000000000000Ab" as Address;
const SOMEONE = address(0xcd);

/** v2's list (`list`) and v1's (`v1`, none by default), served at one block. */
function serve(list: Address[], owners: Map<Address, Address>, v1: Address[] | null = []) {
  readers.latestBlock.mockResolvedValue(26_001_300n);
  readers.factoryCounts.mockResolvedValue([BigInt(list.length), v1 === null ? null : BigInt(v1.length)]);
  readers.readFactoryPages.mockImplementation(async (_rpc: JsonRpc, factory: Address) => (factory === MAINNET_FACTORY ? list : (v1 ?? [])));
  readers.readVaultOwners.mockResolvedValue(owners);
}

describe("searchVaultsFromFactoryList", () => {
  beforeEach(() => Object.values(readers).forEach((reader) => reader.mockReset()));

  it("searches every release's factory, newest first: v2's list, then v1's", () => {
    expect(listedFactories()).toEqual([MAINNET_FACTORY, V1_MAINNET_FACTORY]);
  });

  it("lists the vaults whose owner is the account, newest first, lowercase, all read at one block", async () => {
    const list = [address(1), address(2), address(3), address(4)];
    const me = ME.toLowerCase() as Address;
    serve(list, new Map([[list[0]!, me], [list[1]!, SOMEONE], [list[2]!, me], [list[3]!, SOMEONE]]));

    const result = await searchVaultsFromFactoryList(rpc, ME);
    expect(result).toEqual({ vaults: [list[2], list[0]], expected: 2n, complete: true, block: 26_001_300n, listed: 4, searched: 4, unreadable: 0 });

    expect(readers.factoryCounts).toHaveBeenCalledWith(rpc, [MAINNET_FACTORY, V1_MAINNET_FACTORY], 26_001_300n);
    expect(readers.readFactoryPages).toHaveBeenCalledWith(rpc, MAINNET_FACTORY, { block: 26_001_300n, from: 0, count: 4 });
    expect(readers.readVaultOwners.mock.calls[0]![2]).toEqual({ block: 26_001_300n });
  });

  it("finds the account's vaults on both releases' lists, v2's first, each newest first, with one read of owners", async () => {
    const v2 = [address(0x21), address(0x22)];
    const v1 = [address(0x11), address(0x12), address(0x13)];
    const me = ME.toLowerCase() as Address;
    serve(v2, new Map([[v2[0]!, me], [v2[1]!, me], [v1[0]!, me], [v1[1]!, SOMEONE], [v1[2]!, me]]), v1);

    const result = await searchVaultsFromFactoryList(rpc, ME);
    expect(result).toEqual({
      vaults: [v2[1], v2[0], v1[2], v1[0]],
      expected: 4n,
      complete: true,
      block: 26_001_300n,
      listed: 5,
      searched: 5,
      unreadable: 0,
    });
    expect(readers.readFactoryPages).toHaveBeenCalledWith(rpc, V1_MAINNET_FACTORY, { block: 26_001_300n, from: 0, count: 3 });
    expect(readers.readVaultOwners).toHaveBeenCalledTimes(1);
    expect(readers.readVaultOwners.mock.calls[0]![1]).toEqual([...v2, ...v1]);
  });

  it("searches the factories that are deployed, and says nothing of one that isn't", async () => {
    const v1 = [address(0x11)];
    readers.latestBlock.mockResolvedValue(5n);
    readers.factoryCounts.mockResolvedValue([null, 1n]);
    readers.readFactoryPages.mockResolvedValue(v1);
    readers.readVaultOwners.mockResolvedValue(new Map([[v1[0]!, ME.toLowerCase() as Address]]));
    const result = await searchVaultsFromFactoryList(rpc, ME);
    expect(result).toMatchObject({ vaults: v1, expected: 1n, complete: true, listed: 1, searched: 1 });
    expect(readers.readFactoryPages).toHaveBeenCalledTimes(1);
    expect(readers.readFactoryPages).toHaveBeenCalledWith(rpc, V1_MAINNET_FACTORY, { block: 5n, from: 0, count: 1 });
  });

  it("spends MAX_PLATFORM_VAULTS across the lists, newest list first, and isn't complete when one is cut short", async () => {
    readers.latestBlock.mockResolvedValue(9n);
    readers.factoryCounts.mockResolvedValue([4_000n, 3_000n]);
    readers.readFactoryPages.mockResolvedValue([]);
    readers.readVaultOwners.mockResolvedValue(new Map());
    const result = await searchVaultsFromFactoryList(rpc, ME);
    expect(readers.readFactoryPages).toHaveBeenCalledWith(rpc, MAINNET_FACTORY, { block: 9n, from: 0, count: 4_000 });
    expect(readers.readFactoryPages).toHaveBeenCalledWith(rpc, V1_MAINNET_FACTORY, { block: 9n, from: 2_000, count: 1_000 });
    expect(result).toMatchObject({ listed: 7_000, complete: false });
  });

  it("is incomplete, never empty-handed and sure, when an owner couldn't be read", async () => {
    const list = [address(1), address(2)];
    serve(list, new Map([[list[0]!, SOMEONE]]));
    const result = await searchVaultsFromFactoryList(rpc, ME);
    expect(result).toMatchObject({ vaults: [], expected: 0n, complete: false, listed: 2, unreadable: 1 });
  });

  it("searches the newest MAX_PLATFORM_VAULTS at most, and isn't complete then", async () => {
    const newest = [address(1), address(2)];
    readers.latestBlock.mockResolvedValue(9n);
    readers.factoryCounts.mockResolvedValue([10n ** 15n, null]);
    readers.readFactoryPages.mockResolvedValue(newest);
    readers.readVaultOwners.mockResolvedValue(new Map([[newest[0]!, ME.toLowerCase() as Address], [newest[1]!, SOMEONE]]));
    // The page reader is stood in for, so it answers two; the request is what matters.
    const result = await searchVaultsFromFactoryList(rpc, ME);
    expect(readers.readFactoryPages).toHaveBeenCalledWith(rpc, MAINNET_FACTORY, { block: 9n, from: 10 ** 15 - 5_000, count: 5_000 });
    expect(result).toMatchObject({ listed: 10 ** 15, searched: 5_000, complete: false });
    expect(factoryListSearchCost(10 ** 15)).toBe(factoryListSearchCost(5_000));
  });

  it("refuses a count no factory could have, rather than page through it", async () => {
    readers.latestBlock.mockResolvedValue(9n);
    readers.factoryCounts.mockResolvedValue([2n ** 200n, 0n]);
    await expect(searchVaultsFromFactoryList(rpc, ME)).rejects.toThrow("can't be right");
    expect(readers.readFactoryPages).not.toHaveBeenCalled();
  });

  it("returns null where no factory is deployed: there is nothing to search", async () => {
    readers.latestBlock.mockResolvedValue(5n);
    readers.factoryCounts.mockResolvedValue([null, null]);
    expect(await searchVaultsFromFactoryList(rpc, ME)).toBeNull();
    expect(readers.readFactoryPages).not.toHaveBeenCalled();
  });

  it("reads at a block it is given, from a factory it is given, with the owners cache it is given", async () => {
    const other = address(0xfac);
    const cache = new Map();
    serve([], new Map());
    readers.factoryCounts.mockResolvedValue([0n]);
    await searchVaultsFromFactoryList(rpc, ME, { block: 7n, factory: other, cache });
    expect(readers.latestBlock).not.toHaveBeenCalled();
    expect(readers.factoryCounts).toHaveBeenCalledWith(rpc, [other], 7n);
    expect(readers.readVaultOwners.mock.calls[0]![2]).toEqual({ block: 7n, cache });
  });

  it("throws when the list can't be read, rather than say there's nothing", async () => {
    readers.latestBlock.mockResolvedValue(5n);
    readers.factoryCounts.mockRejectedValue(new Error("eth_call: rate limited"));
    await expect(searchVaultsFromFactoryList(rpc, ME)).rejects.toThrow("rate limited");
  });
});

describe("factoryListSearchCost", () => {
  it("is 2 + ⌈N/1000⌉ + ⌈N/200⌉, and fewer with owners cached", () => {
    // 2 + 1 + ⌈1.505⌉: ⌈1.505⌉ is 2, not 1.
    expect(factoryListSearchCost(301)).toBe(5);
    expect(factoryListSearchCost(301, 301)).toBe(3);
    expect(factoryListSearchCost(0)).toBe(2);
    expect(factoryListSearchCost(5_000)).toBe(2 + 5 + 25);
  });

  it("counts a page per list when given each factory's count", () => {
    // Two lists of 301: a page each, and ⌈602/200⌉ owner batches.
    expect(factoryListSearchCost([301, 301])).toBe(2 + 2 + 4);
    expect(factoryListSearchCost([0, 301])).toBe(2 + 1 + 2);
    // The cap is spent across the lists, newest first.
    expect(factoryListSearchCost([4_000, 3_000])).toBe(2 + 4 + 1 + 25);
  });
});
