/**
 * Find an owner's vaults from the factories' own lists: every listed vault's
 * `owner()`, compared here. Every release's factory (`DEPLOYMENTS`), newest
 * first: a v1 vault holds and buys for good, and is found as a v2 one is.
 *
 * The log search (`searchAccountVaults`) is cheaper, but many network services
 * cap `eth_getLogs` so hard that it stops after the last hour or so of blocks
 * and says `complete: false`. This works on any service that answers
 * `eth_call`, and has no one-year or 40-query bound: it reads the whole list.
 *
 * It costs 2 + Σ⌈Nᵢ/1000⌉ + ⌈N/200⌉ requests for N listed vaults, Nᵢ on each
 * factory's list: 5 at N = 301 on one list, fewer once owners are cached:
 * `owner()` never changes, so it is read once per network service for the
 * session (`vaultIdentities`, shared with the Collective DCA panel). Every
 * read is at one block, through Multicall3; the factories are counted in one.
 *
 * It reads the newest `MAX_PLATFORM_VAULTS` at most across the lists, newest
 * list first, as the Collective DCA panel does, and says how many it searched:
 * the count is the service's answer, and a wrong or hostile one mustn't send
 * this tab into an endless stream of requests.
 *
 * No request names the owner: it never calls `nonces(owner)` or filters logs
 * by owner. That is not a privacy claim. The network service still sees the
 * address in every balance read, and who owns a vault is public on chain.
 */

import type { Address } from "@spdex/core";
import type { JsonRpc } from "@spdex/chain";
import {
  DEPLOYMENTS,
  FACTORY_LIST_PAGE,
  MAX_PLATFORM_VAULTS,
  PLATFORM_CALLS_PER_REQUEST,
  factoryCounts,
  latestBlock,
  readFactoryPages,
  readVaultOwners,
  type OwnerVaults,
  type VaultIdentityCache,
} from "@spdex/vault";

/** A factory-list search's answer: `OwnerVaults`, with what it read. */
export interface FactoryListSearch extends OwnerVaults {
  /** The block every read was made at. */
  block: bigint;
  /** Vaults on the factories' lists at that block, every list that has a factory. */
  listed: number;
  /** The newest of them that were searched: all of them, up to `MAX_PLATFORM_VAULTS`. */
  searched: number;
  /** Listed vaults whose owner couldn't be read: any of them might be the owner's. */
  unreadable: number;
}

/** Every release's factory, newest first: the order a search reads their lists in. */
export function listedFactories(): Address[] {
  return [...DEPLOYMENTS].reverse().map((d) => d.factory.toLowerCase() as Address);
}

/**
 * Every vault on the factories' lists whose `owner()` is `owner`, newest
 * first — the newest release's list first, then each older one's — or null
 * when no factory is deployed on this chain: nothing to search, as
 * `searchAccountVaults` says it. A factory not deployed is skipped; the others
 * are searched.
 *
 * `factories` are every release's by default (`listedFactories`), or the one
 * `factory`.
 *
 * Follows the `OwnerVaults` contract: `vaults` are lowercase and newest
 * first, `expected` is how many were found, and `complete` is true when every
 * listed vault was searched and its owner read. It has no `searchedFrom` (it reads no log);
 * when it isn't complete, the log search's `expected`, the factories' own
 * counts for the owner, is the better figure to say how many are missing.
 *
 * Throws when the block, a count or a list can't be read.
 */
export async function searchVaultsFromFactoryList(
  rpc: JsonRpc,
  owner: Address,
  options: { block?: bigint; factories?: readonly Address[]; factory?: Address; cache?: VaultIdentityCache } = {},
): Promise<FactoryListSearch | null> {
  const factories = (options.factories ?? (options.factory ? [options.factory] : listedFactories())).map(
    (factory) => factory.toLowerCase() as Address,
  );
  const block = options.block ?? (await latestBlock(rpc));
  const counts = await factoryCounts(rpc, factories, block);
  const lists = factories.flatMap((factory, index) => {
    const count = counts[index];
    return count === null || count === undefined ? [] : [{ factory, count }];
  });
  if (lists.length === 0) return null;
  for (const { count } of lists) {
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`the factory's count, ${count}, can't be right`);
  }
  let budget = MAX_PLATFORM_VAULTS;
  let listed = 0;
  let taken = 0;
  const searched: Address[][] = [];
  for (const { factory, count } of lists) {
    const total = Number(count);
    const take = Math.min(total, budget);
    listed += total;
    taken += take;
    budget -= take;
    searched.push(take === 0 ? [] : await readFactoryPages(rpc, factory, { block, from: total - take, count: take }));
  }
  const all = searched.flat();
  const owners = await readVaultOwners(rpc, all, { block, ...(options.cache ? { cache: options.cache } : {}) });
  const who = owner.toLowerCase();
  // Each list is oldest first; the newest list's newest vault leads.
  const vaults = searched.flatMap((list) => list.filter((vault) => owners.get(vault) === who).reverse());
  const unreadable = all.filter((vault) => !owners.has(vault)).length;
  return {
    vaults,
    expected: BigInt(vaults.length),
    complete: unreadable === 0 && taken === listed,
    block,
    listed,
    searched: taken,
    unreadable,
  };
}

/**
 * Requests a search of lists of `listed` vaults makes — one count per
 * factory's list, or one figure for them all — `cached` of whose owners are
 * already known: for the button's hint, before it's pressed.
 */
export function factoryListSearchCost(listed: number | readonly number[], cached = 0): number {
  let budget = MAX_PLATFORM_VAULTS;
  let searched = 0;
  let pages = 0;
  for (const count of typeof listed === "number" ? [listed] : listed) {
    const take = Math.min(count, budget);
    budget -= take;
    searched += take;
    pages += Math.ceil(take / FACTORY_LIST_PAGE);
  }
  return 2 + pages + Math.ceil(Math.max(0, searched - cached) / PLATFORM_CALLS_PER_REQUEST);
}
