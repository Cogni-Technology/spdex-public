/**
 * Releases, as data.
 *
 * A **release** is one deployment of the contracts: a factory, the SPX holder
 * registry its vaults ask (from v2), the market list it was deployed with, and
 * the batcher its vaults' buys go through (`DEPLOYMENTS`, from
 * `deployments.json`). A **source** is the code a release was built from
 * (`SOURCES`): its ABIs, and what its contracts can do (`features`), which the
 * build reads from the ABIs themselves. Two releases can share a source — the
 * same code with another market list, say — and then the second is one more
 * entry in `deployments.json` and nothing else.
 *
 * Everything that handles a vault of any release asks what that release's
 * source can do, never which release it is: `featuresOf(release).communityWindow`,
 * not `release === "v2"`. So a release built from an existing source needs no
 * code here or anywhere else, and a new source's features are the ones its
 * ABIs show.
 *
 * Batchers from v2 on are bound to no factory: one serves every release whose
 * vaults take `execute(rewardTo)` (`BATCHERS`; `MAINNET_BATCHER` is the newest).
 * v1's is bound to v1's factory and serves v1's vaults alone.
 */

import type { Address } from "@spdex/core";
import {
  BATCHERS,
  DEPLOYMENTS,
  SOURCES,
  type Deployment,
  type Source,
  type SourceFeatures,
  type SourceId,
} from "./artifacts.js";

/** Which release a vault, a factory or a plan belongs to: `DEPLOYMENTS`' ids, oldest first. */
export type VaultRelease = Deployment["id"];

/** The release this build creates vaults on: the last of `DEPLOYMENTS`. */
export const LATEST_RELEASE: VaultRelease = DEPLOYMENTS[DEPLOYMENTS.length - 1]!.id;

const lower = (a: string): Address => a.toLowerCase() as Address;

/** Every source id, newest first: the order to try a layout in when nothing else says which. */
export const SOURCE_IDS_NEWEST_FIRST: readonly SourceId[] = (Object.keys(SOURCES) as SourceId[]).reverse();

/** A release's entry in `DEPLOYMENTS`. Throws for an id the record does not have. */
export function deploymentOf(release: VaultRelease): Deployment {
  const found = DEPLOYMENTS.find((d) => d.id === release);
  if (!found) throw new RangeError(`no release ${String(release)} in DEPLOYMENTS`);
  return found;
}

/** The source a release was built from: its ABIs, constructors and limits. */
export function sourceOfRelease(release: VaultRelease): Source {
  return SOURCES[deploymentOf(release).source];
}

/** What a release's vaults, factory and batcher can do. */
export function featuresOf(release: VaultRelease): SourceFeatures {
  return sourceOfRelease(release).features;
}

/**
 * The release a factory belongs to, by its address: one of `DEPLOYMENTS`. Null
 * for any other address: a factory spDEX does not list vouches for nothing here.
 */
export function releaseOfFactory(factory: Address): VaultRelease | null {
  const address = lower(factory);
  return DEPLOYMENTS.find((d) => d.factory === address)?.id ?? null;
}

/** A release's factory. */
export function factoryOfRelease(release: VaultRelease): Address {
  return deploymentOf(release).factory;
}

/** The batcher a release's vaults' buys are sent through now: v1's own, or the newest shared one. */
export function batcherOfRelease(release: VaultRelease): Address {
  return deploymentOf(release).batcher;
}

/** The newest release built from `source`; null when none was. */
export function latestReleaseOf(source: SourceId): VaultRelease | null {
  for (let i = DEPLOYMENTS.length - 1; i >= 0; i--) if (DEPLOYMENTS[i]!.source === source) return DEPLOYMENTS[i]!.id;
  return null;
}

/**
 * Every batcher spDEX lists, lowercase: v1's, and every one bound to no
 * factory, the newest last. What a report reads logs from, and what a keeper
 * may send a batch to.
 */
export const LISTED_BATCHERS: readonly Address[] = [
  ...new Set([...DEPLOYMENTS.map((d) => lower(d.batcher)), ...BATCHERS.map((b) => lower(b.batcher))]),
];

/** Whether `address` is one of spDEX's batchers. */
export function isListedBatcher(address: Address): boolean {
  return LISTED_BATCHERS.includes(lower(address));
}

/**
 * The source a listed batcher was built from, which decides its ABI: v1's for
 * v1's batcher, the entry's for each in `BATCHERS`. Null for any other address.
 */
export function batcherSourceOf(batcher: Address): SourceId | null {
  const address = lower(batcher);
  const shared = BATCHERS.find((b) => b.batcher === address);
  if (shared) return shared.source;
  return DEPLOYMENTS.find((d) => d.batcher === address && !SOURCES[d.source].features.sharedBatcher)?.source ?? null;
}

/**
 * The releases whose vaults a listed batcher can trigger: v1's batcher, v1's
 * alone; one bound to no factory, every release whose vaults take
 * `execute(rewardTo)`. Empty for an address spDEX does not list.
 */
export function releasesServedBy(batcher: Address): VaultRelease[] {
  const source = batcherSourceOf(batcher);
  if (source === null) return [];
  if (!SOURCES[source].features.sharedBatcher) return DEPLOYMENTS.filter((d) => d.batcher === lower(batcher)).map((d) => d.id);
  return DEPLOYMENTS.filter((d) => SOURCES[d.source].features.executeTakesRewardTo).map((d) => d.id);
}
