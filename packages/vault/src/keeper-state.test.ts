/**
 * The keeper's state file: what it keeps must come back exactly, and a file
 * that is not this keeper's — another chain, another key, a release it does
 * not know, a newer version, a damaged field — must be refused by name rather
 * than trusted, because a nonce or a trap from someone else's state is worse
 * than none. A version-1 file, written before v2's community window, is
 * migrated with everything it knew kept.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import { MAINNET_DEPLOYMENT, type Deployment } from "./artifacts.js";
import {
  KEEPER_STATE_VERSION,
  KeeperStateError,
  checkKeeperStateIdentity,
  forgetVault,
  migrateKeeperStateV1,
  newKeeperState,
  parseKeeperState,
  resetTraps,
  serializeKeeperState,
  type KeeperState,
} from "./keeper-state.js";

const KEEPER: Address = "0x00000000000000000000000000000000000000c1";
const VAULT: Address = "0x00000000000000000000000000000000000000a1";
const V2_VAULT: Address = "0x00000000000000000000000000000000000000a2";
const REGISTRY: Address = "0x00000000000000000000000000000000000000e7";
const V1: Deployment = {
  id: "v1",
  source: "v1",
  factory: "0x00000000000000000000000000000000000000f1",
  batcher: "0x00000000000000000000000000000000000000b1",
  registry: null,
  markets: MAINNET_DEPLOYMENT.markets,
  factoryBlock: null,
  batcherBlock: null,
  registryBlock: null,
};
const V2: Deployment = {
  id: "v2",
  source: "v2",
  factory: "0x00000000000000000000000000000000000000f2",
  batcher: "0x00000000000000000000000000000000000000b2",
  registry: REGISTRY,
  markets: MAINNET_DEPLOYMENT.markets,
  factoryBlock: 26_100_000n,
  batcherBlock: 26_100_001n,
  registryBlock: 26_099_999n,
};
const HASH: Hex = `0x${"ab".repeat(32)}`;

/** A state with something in every field. */
function busy(): KeeperState {
  const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [V1, V2] });
  state.deployments["v1"]!.scannedCount = 12n;
  state.deployments["v1"]!.vaultCount = 13n;
  state.seq = 41;
  state.maxHeadSeen = 26_000_123n;
  state.discoveredAt = 1_790_000_000n;
  state.accountedAt = 1_790_000_100n;
  state.vaults[VAULT] = {
    deployment: "v1",
    index: 3n,
    owner: "0x00000000000000000000000000000000000000d1",
    terms: {
      tokenOut: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c",
      pair: "0x52c77b0cb827afbad022e6d6caf2c44452edbc39",
      oraclePool: "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3",
      amountPerBuy: 10n ** 16n,
      interval: 86_400n,
      maxBuys: 30n,
      startAt: 1_789_000_000n,
      keeperReward: 87_300_000_000_000n,
      maxSlippageBps: 300n,
      communityWindow: null,
      turnBuckets: null,
    },
    nonce: 2n,
    buysDone: 4n,
    lastBuyAt: 1_789_300_000n,
    closed: false,
    balance: 26n * 10n ** 16n,
    readAt: 1_790_000_100n,
    recheckAt: null,
    restingUntil: 1_790_000_700n,
    paidRefusals: { slot: 11n, count: 1 },
    lastSkip: { code: "below-floor", detail: "the price is outside its floor", since: 1_790_000_050n },
    watchedSlot: 11n,
  };
  state.vaults[V2_VAULT] = {
    ...state.vaults[VAULT]!,
    deployment: "v2",
    index: 0n,
    terms: { ...state.vaults[VAULT]!.terms, communityWindow: 1_800n, turnBuckets: 0n },
    nonce: 0n,
    lastSkip: { code: "holders-first", detail: "SPX holders have first claim until 1790001900 (chain time)", since: 1_790_000_100n },
  };
  state.notVouched["0x00000000000000000000000000000000000000e1"] = { since: 1n, recheckAt: 3_601n };
  state.trapped["0x00000000000000000000000000000000000000e2"] = { since: 5n, txHash: HASH, batcher: V1.batcher, cap: 400_000n, slot: 2n };
  state.retired.push("0x00000000000000000000000000000000000000e3");
  state.feeSamples.push([1_790_000_000n, 63_000_000n]);
  state.lossLedger.push({ at: 1_790_000_000n, lossWei: -0n + 5n, vault: VAULT, owner: null });
  state.spend.push([1_790_000_000n, 12_345n]);
  state.spendSince = 1_789_400_000n;
  state.gasModel = { ratioPpm: 1_042_000n, samples: 3 };
  state.nextNonce = 7;
  state.nonceUses = { "6": 2 };
  state.pending = {
    batchId: `${KEEPER}:7:0`,
    nonce: 7,
    purpose: "batch",
    deployment: "v1",
    vaults: [VAULT],
    urgent: true,
    reason: "deadline",
    gasLimit: 698_000n,
    modelGas: 317_000n,
    expectedGas: 330_314n,
    expectedCostWei: 1n,
    expectedEarnedWei: 2n,
    minRewards: 0n,
    subsidy: [{ vault: VAULT, owner: "0x00000000000000000000000000000000000000d1", wei: 3n }],
    amountWei: null,
    proveBlock: null,
    resends: 1,
    stoppedResending: false,
    receiptBlock: null,
    missedReceiptChecks: 0,
    consumedSeenAt: null,
    attempts: [
      {
        kind: "batch",
        hash: HASH,
        raw: "0x02f8ab",
        sentBlock: 26_000_120n,
        fees: { type: "eip1559", maxFeePerGas: 200n, maxPriorityFeePerGas: 100n },
        vaults: [VAULT],
        subsidy: [{ vault: VAULT, owner: "0x00000000000000000000000000000000000000d1", wei: 3n }],
        modelGas: 317_000n,
      },
      { kind: "cancel", hash: HASH, raw: "0x02f8ac", sentBlock: 26_000_122n, fees: { type: "legacy", gasPrice: 300n }, vaults: [VAULT], subsidy: [], modelGas: 317_000n },
    ],
  };
  state.orphans.push({ batchId: `${KEEPER}:6:1`, nonce: 6, hash: HASH, kind: "batch", deployment: "v1", vaults: [VAULT], subsidy: [], untilBlock: 9n, nextCheckBlock: 8n });
  state.lastBatch = { hash: HASH, at: 1_789_300_000n };
  state.balanceWei = 10n ** 17n;
  state.lastMissedAt = 1_789_999_000n;
  state.lastWait = "not-cheap:1:";
  state.breakerOpen = true;
  state.lowBalance = true;
  state.lowRunway = true;
  state.eligibility["v2"] = { registry: REGISTRY, holder: KEEPER, eligible: true, validUntil: 1_792_273_763n, spx: 121_000_000_000n, isAccount: true, readAt: 1_790_000_100n };
  state.lastEligibility = "v2:true:1792273763:null";
  state.eligibilityLoggedAt = 1_790_000_100n;
  state.proveTriedAt = 1_790_000_000n;
  state.proveSentAt = 1_789_995_000n;
  state.proveRevertedAt = 1_789_990_000n;
  state.lastProveSkip = "v2:unsupported";
  state.lastHeartbeatLogAt = 1_790_000_000n;
  return state;
}

/**
 * The file a version-1 keeper wrote for `busy()`'s v1 half, field for field
 * as it wrote it: no registries, no community windows, no eligibility.
 */
function versionOneFile(): Record<string, any> {
  const raw = JSON.parse(serializeKeeperState(busy())) as Record<string, any>;
  raw["v"] = 1;
  delete raw["deployments"]["v2"];
  delete raw["deployments"]["v1"]["registry"];
  delete raw["vaults"][V2_VAULT];
  delete raw["vaults"][VAULT]["terms"]["communityWindow"];
  delete raw["vaults"][VAULT]["terms"]["turnBuckets"];
  delete raw["vaults"][VAULT]["nonce"];
  delete raw["pending"]["proveBlock"];
  for (const field of ["spendSince", "lowRunway", "eligibility", "lastEligibility", "eligibilityLoggedAt", "proveTriedAt", "proveSentAt", "proveRevertedAt", "lastProveSkip"]) {
    delete raw[field];
  }
  return raw;
}

describe("the state file", () => {
  it("round-trips every field, bigints as decimal strings", () => {
    const state = busy();
    const text = serializeKeeperState(state);
    expect(text).toContain('"scannedCount": "12"');
    expect(text).toContain('"v": 2');
    expect(parseKeeperState(text)).toEqual(state);
    expect(parseKeeperState(serializeKeeperState(newKeeperState({ chainId: 690069, keeper: null })))).toEqual(
      newKeeperState({ chainId: 690069, keeper: null }),
    );
  });

  it("names the first field that is wrong", () => {
    const damaged = (edit: (raw: Record<string, any>) => void) => {
      const raw = JSON.parse(serializeKeeperState(busy())) as Record<string, any>;
      edit(raw);
      try {
        parseKeeperState(JSON.stringify(raw));
      } catch (error) {
        expect(error).toBeInstanceOf(KeeperStateError);
        return (error as KeeperStateError).field;
      }
      throw new Error("accepted");
    };
    expect(damaged((raw) => (raw["seq"] = "41"))).toBe("seq");
    expect(damaged((raw) => (raw["vaults"][VAULT]["buysDone"] = 4))).toBe(`vaults.${VAULT}.buysDone`);
    expect(damaged((raw) => (raw["pending"]["attempts"][0]["hash"] = "0x1234"))).toBe("pending.attempts[0].hash");
    expect(damaged((raw) => (raw["keeper"] = KEEPER.toUpperCase()))).toBe("keeper");
    expect(damaged((raw) => (raw["gasModel"]["ratioPpm"] = "fast"))).toBe("gasModel.ratioPpm");
    expect(() => parseKeeperState("{not json")).toThrow(KeeperStateError);
  });

  it("refuses a newer version, and one it does not know", () => {
    const raw = JSON.parse(serializeKeeperState(busy())) as Record<string, unknown>;
    expect(KEEPER_STATE_VERSION).toBe(2);
    expect(() => parseKeeperState(JSON.stringify({ ...raw, v: 3 }))).toThrow(/version 3, newer than this keeper's 2/);
    expect(() => parseKeeperState(JSON.stringify({ ...raw, v: "1" }))).toThrow(KeeperStateError);
    expect(() => parseKeeperState(JSON.stringify({ ...raw, v: 0 }))).toThrow(/no version this keeper knows/);
  });

  it("migrates a version-1 file, keeping everything it knew and starting what it could not know empty", () => {
    const migrated = parseKeeperState(JSON.stringify(versionOneFile()));
    const expected = busy();
    // What version 1 never had: v2's release, its vault, and anything read of a registry; nor did it prove its
    // vaults the factory's clones, so each is proven again before it is next sent.
    delete expected.deployments["v2"];
    delete expected.vaults[V2_VAULT];
    expected.vaults[VAULT]!.nonce = null;
    Object.assign(expected, {
      lowRunway: false,
      eligibility: {},
      lastEligibility: null,
      eligibilityLoggedAt: null,
      proveTriedAt: null,
      proveSentAt: null,
      proveRevertedAt: null,
      lastProveSkip: null,
      // Version 1 kept its spend without saying since when: its oldest entry is the most it can vouch for.
      spendSince: 1_790_000_000n,
    });
    expect(migrated).toEqual(expected);
    expect(migrated.v).toBe(2);
    expect(migrated.deployments["v1"]!.registry).toBeNull();
    expect(migrated.vaults[VAULT]!.terms.communityWindow).toBeNull();
    expect(migrated.vaults[VAULT]!.terms.turnBuckets).toBeNull();
    // The transaction in flight survives whole: its nonce and signed bytes are what a restart follows.
    expect(migrated.pending).toMatchObject({ nonce: 7, proveBlock: null, attempts: [{ raw: "0x02f8ab" }, { raw: "0x02f8ac" }] });
    // Written back, it is a version-2 file, which reads back as itself.
    expect(parseKeeperState(serializeKeeperState(migrated))).toEqual(migrated);
    // And the keeper that reads it takes on v2, from scratch, beside v1's progress.
    checkKeeperStateIdentity(migrated, { chainId: 1, keeper: KEEPER, deployments: [V1, V2] });
    expect(migrated.deployments["v2"]).toEqual({ factory: V2.factory, batcher: V2.batcher, registry: REGISTRY, scannedCount: 0n, vaultCount: null });
    expect(migrated.deployments["v1"]!.scannedCount).toBe(12n);
  });

  it("counts a version-1 keeper's spend as known from its oldest entry, or from its first tick when it kept none", () => {
    const raw = versionOneFile();
    raw["spend"] = [
      ["1790000500", "1"],
      ["1789990000", "2"],
    ];
    expect(parseKeeperState(JSON.stringify(raw)).spendSince).toBe(1_789_990_000n);
    raw["spend"] = [];
    expect(parseKeeperState(JSON.stringify(raw)).spendSince).toBeNull();
  });

  it("migrates without changing the file it was given, and still names a damaged field", () => {
    const raw = versionOneFile();
    const before = JSON.stringify(raw);
    migrateKeeperStateV1(raw);
    expect(JSON.stringify(raw)).toBe(before);
    raw["vaults"][VAULT]["buysDone"] = 4;
    expect(() => parseKeeperState(JSON.stringify(raw))).toThrow(expect.objectContaining({ field: `vaults.${VAULT}.buysDone` }));
  });
});

describe("identity", () => {
  const expected = { chainId: 1, keeper: KEEPER, deployments: [V1, V2] };

  it("accepts its own state", () => {
    expect(() => checkKeeperStateIdentity(busy(), expected)).not.toThrow();
  });

  it("refuses another chain or another key, naming the field", () => {
    const field = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        return (error as KeeperStateError).field;
      }
      return null;
    };
    expect(field(() => checkKeeperStateIdentity(busy(), { ...expected, chainId: 690069 }))).toBe("chainId");
    expect(field(() => checkKeeperStateIdentity(busy(), { ...expected, keeper: "0x00000000000000000000000000000000000000c2" }))).toBe("keeper");
    expect(field(() => checkKeeperStateIdentity(busy(), { ...expected, keeper: null }))).toBe("keeper");
  });

  it("accepts a release list that has grown, adding the new release; refuses one that lost or moved a release", () => {
    const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [V1] });
    state.deployments["v1"]!.scannedCount = 12n;
    checkKeeperStateIdentity(state, { ...expected, deployments: [V1, V2] });
    expect(state.deployments["v2"]).toEqual({ factory: V2.factory, batcher: V2.batcher, registry: REGISTRY, scannedCount: 0n, vaultCount: null });
    expect(state.deployments["v1"]!.scannedCount).toBe(12n);

    expect(() => checkKeeperStateIdentity(busy(), { ...expected, deployments: [V2] })).toThrow(expect.objectContaining({ field: "deployments.v1" }));
    const moved = { ...V1, batcher: V2.batcher };
    expect(() => checkKeeperStateIdentity(busy(), { ...expected, deployments: [moved, V2] })).toThrow(expect.objectContaining({ field: "deployments.v1" }));
  });

  it("takes up a newer shared batcher for a release that shares one, unless a transaction to the old one is in flight", () => {
    // v2's source has a batcher bound to no factory: deployments.json may list a newer one, which serves v2 instead.
    const newer = { ...V2, batcher: "0x00000000000000000000000000000000000000b3" as Address };
    const state = busy();
    checkKeeperStateIdentity(state, { ...expected, deployments: [V1, newer] });
    expect(state.deployments["v2"]!.batcher).toBe(newer.batcher);
    // A batch to v2's old batcher still in flight would be read at the wrong address: refused until it settles.
    const inFlight = busy();
    inFlight.pending!.deployment = "v2";
    expect(() => checkKeeperStateIdentity(inFlight, { ...expected, deployments: [V1, newer] })).toThrow(/in flight/);
    const orphaned = busy();
    orphaned.orphans[0]!.deployment = "v2";
    expect(() => checkKeeperStateIdentity(orphaned, { ...expected, deployments: [V1, newer] })).toThrow(expect.objectContaining({ field: "deployments.v2" }));
  });

  it("refuses a release whose SPX holder registry is another, since its eligibility was read where its vaults never ask", () => {
    const elsewhere = { ...V2, registry: "0x00000000000000000000000000000000000000e8" as Address };
    expect(() => checkKeeperStateIdentity(busy(), { ...expected, deployments: [V1, elsewhere] })).toThrow(expect.objectContaining({ field: "deployments.v2" }));
    expect(() => checkKeeperStateIdentity(busy(), { ...expected, deployments: [V1, { ...V2, registry: null }] })).toThrow(expect.objectContaining({ field: "deployments.v2" }));
  });
});

describe("operator overrides", () => {
  it("--reset-trapped clears every trap", () => {
    const state = busy();
    expect(resetTraps(state)).toEqual(["0x00000000000000000000000000000000000000e2"]);
    expect(state.trapped).toEqual({});
  });

  it("--forget clears a listed vault's progress but keeps its place, and drops what else is known", () => {
    const state = busy();
    expect(forgetVault(state, VAULT.toUpperCase().replace("0X", "0x") as Address)).toBe(true);
    expect(state.vaults[VAULT]).toMatchObject({ index: 3n, readAt: null, restingUntil: null, lastSkip: null, paidRefusals: null });
    expect(forgetVault(state, "0x00000000000000000000000000000000000000e2")).toBe(true);
    expect(state.trapped).toEqual({});
    expect(forgetVault(state, "0x00000000000000000000000000000000000000e3")).toBe(true);
    expect(state.retired).toEqual([]);
    expect(forgetVault(state, "0x0000000000000000000000000000000000000fff")).toBe(false);
  });
});
