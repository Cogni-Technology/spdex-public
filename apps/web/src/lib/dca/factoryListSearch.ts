/**
 * Find an owner's vaults from the factory's own list: every listed vault's
 * `owner()`, compared here.
 *
 * The log search (`searchAccountVaults`) is cheaper, but many network services
 * cap `eth_getLogs` so hard that it stops after the last hour or so of blocks
 * and says `complete: false`. This works on any service that answers
 * `eth_call`, and has no one-year or 40-query bound: it reads the whole list.
 *
 * It costs 2 + ⌈N/1000⌉ + ⌈N/200⌉ requests for N listed vaults, 5 at N = 301,
 * fewer once owners are cached: `owner()` never changes, so it is read once
 * per network service for the session (`vaultIdentities`, shared with the
 * Collective DCA panel). Every read is at one block, through Multicall3.
 *
 * It reads the newest `MAX_PLATFORM_VAULTS` at most, as the Collective DCA
 * panel does, and says how many it searched: the count is the service's
 * answer, and a wrong or hostile one mustn't send this tab into an endless
 * stream of requests.
 *
 * No request names the owner: it never calls `nonces(owner)` or filters logs
 * by owner. That is not a privacy claim. The network service still sees the
 * address in every balance read, and who owns a vault is public on chain.
 */

import type { Address } from "@spdex/core";
import type { JsonRpc } from "@spdex/chain";
import {
  FACTORY_LIST_PAGE,
  MAINNET_FACTORY,
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
  /** Vaults on the factory's list at that block. */
  listed: number;
  /** The newest of them that were searched: all of them, up to `MAX_PLATFORM_VAULTS`. */
  searched: number;
  /** Listed vaults whose owner couldn't be read: any of them might be the owner's. */
  unreadable: number;
}

/**
 * Every vault on `factory`'s list whose `owner()` is `owner`, newest first,
 * or null when the factory isn't deployed on this chain: nothing to search,
 * as `searchAccountVaults` says it.
 *
 * Follows the `OwnerVaults` contract: `vaults` are lowercase and newest
 * first, `expected` is how many were found, and `complete` is true when every
 * listed vault was searched and its owner read. It has no `searchedFrom` (it reads no log);
 * when it isn't complete, the log search's `expected`, the factory's own count
 * for the owner, is the better figure to say how many are missing.
 *
 * Throws when the block, the count or the list can't be read.
 */
export async function searchVaultsFromFactoryList(
  rpc: JsonRpc,
  owner: Address,
  options: { block?: bigint; factory?: Address; cache?: VaultIdentityCache } = {},
): Promise<FactoryListSearch | null> {
  const factory = (options.factory ?? MAINNET_FACTORY).toLowerCase() as Address;
  const block = options.block ?? (await latestBlock(rpc));
  const [count] = await factoryCounts(rpc, [factory], block);
  if (count === null || count === undefined) return null;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`the factory's count, ${count}, can't be right`);
  const total = Number(count);
  const take = Math.min(total, MAX_PLATFORM_VAULTS);
  const searched = await readFactoryPages(rpc, factory, { block, from: total - take, count: take });
  const owners = await readVaultOwners(rpc, searched, { block, ...(options.cache ? { cache: options.cache } : {}) });
  const who = owner.toLowerCase();
  const vaults = searched.filter((vault) => owners.get(vault) === who).reverse();
  const unreadable = searched.length - owners.size;
  return {
    vaults,
    expected: BigInt(vaults.length),
    complete: unreadable === 0 && take === total,
    block,
    listed: total,
    searched: take,
    unreadable,
  };
}

/**
 * Requests a search of a list of `listed` vaults makes, `cached` of whose
 * owners are already known: for the button's hint, before it's pressed.
 */
export function factoryListSearchCost(listed: number, cached = 0): number {
  const searched = Math.min(listed, MAX_PLATFORM_VAULTS);
  return 2 + Math.ceil(searched / FACTORY_LIST_PAGE) + Math.ceil(Math.max(0, searched - cached) / PLATFORM_CALLS_PER_REQUEST);
}
