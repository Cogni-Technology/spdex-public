/**
 * Releases as data: what every reader of a vault of any release goes by
 * instead of a release's name. No node, no network.
 *
 * What these pin: the release this build creates vaults on is the record's
 * last; a factory or a batcher is spDEX's only when the record lists it; each
 * source's features are the ones its ABIs show (v1's none, v2's all); and the
 * batcher bound to no factory serves every release whose vaults take
 * `rewardTo`, while v1's serves v1's alone.
 */

import { describe, expect, it } from "vitest";
import type { Address } from "@spdex/core";
import {
  BATCHERS,
  CURRENT_SOURCE,
  DEPLOYMENTS,
  LATEST_RELEASE,
  LISTED_BATCHERS,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  SOURCES,
  SOURCE_IDS_NEWEST_FIRST,
  V1_MAINNET_BATCHER,
  V1_MAINNET_FACTORY,
  batcherOfRelease,
  batcherSourceOf,
  deploymentOf,
  factoryOfRelease,
  featuresOf,
  isListedBatcher,
  latestReleaseOf,
  releaseOfFactory,
  releasesServedBy,
  sourceOfRelease,
} from "./index.js";

const ELSEWHERE: Address = "0x00000000000000000000000000000000000000f5";
const upper = (a: Address) => a.toUpperCase().replace("0X", "0x") as Address;

describe("releases", () => {
  it("creates vaults on the record's last release, which is the current source's", () => {
    expect(LATEST_RELEASE).toBe(DEPLOYMENTS.at(-1)!.id);
    expect(deploymentOf(LATEST_RELEASE).source).toBe(CURRENT_SOURCE);
    expect(latestReleaseOf(CURRENT_SOURCE)).toBe(LATEST_RELEASE);
    expect(latestReleaseOf("v1")).toBe("v1");
  });

  it("knows a factory only by the record", () => {
    for (const d of DEPLOYMENTS) {
      expect(releaseOfFactory(d.factory)).toBe(d.id);
      expect(releaseOfFactory(upper(d.factory))).toBe(d.id);
      expect(factoryOfRelease(d.id)).toBe(d.factory);
      expect(batcherOfRelease(d.id)).toBe(d.batcher);
    }
    expect(releaseOfFactory(ELSEWHERE)).toBeNull();
    expect(releaseOfFactory(MAINNET_BATCHER)).toBeNull();
    expect(() => deploymentOf("v9" as never)).toThrow(RangeError);
  });

  it("reads each source's features from its ABIs: v1's none, v2's all", () => {
    expect(featuresOf("v1")).toEqual({ executeTakesRewardTo: false, communityWindow: false, turns: false, registry: false, sharedBatcher: false });
    expect(featuresOf("v2")).toEqual({ executeTakesRewardTo: true, communityWindow: true, turns: true, registry: true, sharedBatcher: true });
    expect(sourceOfRelease("v2")).toBe(SOURCES.v2);
    expect(SOURCES.v1.vaultArgsLength).toBe(112);
    expect(SOURCES.v2.vaultArgsLength).toBe(117);
    expect(SOURCE_IDS_NEWEST_FIRST).toEqual(["v2", "v1"]);
    // Only the current source is not frozen.
    for (const id of SOURCE_IDS_NEWEST_FIRST) expect(SOURCES[id].frozen).toBe(id !== CURRENT_SOURCE);
  });
});

describe("batchers", () => {
  it("lists v1's, bound to v1's factory, and every one bound to no factory, each once", () => {
    expect(LISTED_BATCHERS).toEqual([V1_MAINNET_BATCHER, ...new Set(BATCHERS.map((b) => b.batcher).filter((b) => b !== V1_MAINNET_BATCHER))]);
    expect(LISTED_BATCHERS).toContain(MAINNET_BATCHER);
    expect(new Set(LISTED_BATCHERS).size).toBe(LISTED_BATCHERS.length);
    expect(isListedBatcher(upper(MAINNET_BATCHER))).toBe(true);
    expect(isListedBatcher(V1_MAINNET_BATCHER)).toBe(true);
    expect(isListedBatcher(MAINNET_FACTORY)).toBe(false);
    expect(isListedBatcher(ELSEWHERE)).toBe(false);
  });

  it("says which source each listed batcher was built from", () => {
    expect(batcherSourceOf(V1_MAINNET_BATCHER)).toBe("v1");
    expect(batcherSourceOf(upper(MAINNET_BATCHER))).toBe(BATCHERS.at(-1)!.source);
    expect(batcherSourceOf(MAINNET_FACTORY)).toBeNull();
    expect(batcherSourceOf(V1_MAINNET_FACTORY)).toBeNull();
    expect(batcherSourceOf(ELSEWHERE)).toBeNull();
  });

  it("serves v1's vaults through v1's batcher alone, and every release whose vaults take rewardTo through the shared one", () => {
    expect(releasesServedBy(V1_MAINNET_BATCHER)).toEqual(["v1"]);
    const takingRewardTo = DEPLOYMENTS.filter((d) => SOURCES[d.source].features.executeTakesRewardTo).map((d) => d.id);
    expect(takingRewardTo).toContain("v2");
    expect(releasesServedBy(MAINNET_BATCHER)).toEqual(takingRewardTo);
    expect(releasesServedBy(ELSEWHERE)).toEqual([]);
    // Every release from v2 on sends through the newest shared batcher.
    for (const id of takingRewardTo) expect(batcherOfRelease(id)).toBe(MAINNET_BATCHER);
  });
});
