/**
 * The keeper's log: what a report joins on — hashes, addresses, amounts — is
 * written exactly and checked; free text is scrubbed of the key and of every
 * configured URL, including the pieces of one an error might quote without
 * its scheme; and every record type is one line of JSON.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import { makeRedactor, stampRecord, toJsonLine, type KeeperLogBody, type KeeperLogRecord, type KeeperLogType } from "./keeper-log.js";

const KEY: Hex = `0x${"a1b2c3d4".repeat(8)}`;
const RPC = "https://eth-mainnet.g.alchemy.com/v2/Zx9Kq3LmN7pR2sT5vW8yB1cD4eF6gH0j";
const SEND = "https://rpc.example.org/fast?apikey=0123456789abcdefghij&chain=1";
const VAULT: Address = "0x00000000000000000000000000000000000000a1";
const KEEPER: Address = "0x00000000000000000000000000000000000000c1";
const REGISTRY: Address = "0x2c7f732a453fe0a4a65f36ac564ff16007b5610d";
const HASH: Hex = `0x${"ab".repeat(32)}`;

const redact = makeRedactor({ key: KEY, urls: [RPC, SEND] });

describe("makeRedactor", () => {
  it("removes the key with and without 0x, in either case", () => {
    for (const form of [KEY, KEY.slice(2), KEY.toUpperCase(), KEY.slice(2).toUpperCase()]) {
      const out = redact(`the key is ${form}.`);
      expect(out.toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());
    }
  });

  it("removes each URL whole, as host and path, as path, as query, and each long segment", () => {
    const leaks = [
      `fetch failed: ${RPC}`,
      "connect to eth-mainnet.g.alchemy.com/v2/Zx9Kq3LmN7pR2sT5vW8yB1cD4eF6gH0j refused",
      "POST /v2/Zx9Kq3LmN7pR2sT5vW8yB1cD4eF6gH0j 401",
      "bad key Zx9Kq3LmN7pR2sT5vW8yB1cD4eF6gH0j",
      "query apikey=0123456789abcdefghij&chain=1 rejected",
      "token 0123456789abcdefghij expired",
    ];
    for (const leak of leaks) {
      const out = redact(leak);
      expect(out).not.toContain("Zx9Kq3LmN7pR2sT5vW8yB1cD4eF6gH0j");
      expect(out).not.toContain("0123456789abcdefghij");
    }
  });

  it("replaces any URL, and any 64-digit hex string, even ones it was never told about", () => {
    expect(redact("upstream https://archive.example/v2/unknown-key failed")).toBe("upstream <url> failed");
    expect(redact(`something ${"f".repeat(64)} leaked`)).toBe("something <hex64> leaked");
    expect(redact("nothing to hide here")).toBe("nothing to hide here");
  });
});

/** One of every record type. */
const BODIES = {
  start: {
    type: "start",
    rewardTo: KEEPER,
    chainId: 1,
    dryRun: false,
    deployments: [
      { id: "v1", factory: VAULT, batcher: VAULT, registry: null },
      { id: "v2", factory: VAULT, batcher: VAULT, registry: REGISTRY },
    ],
    sendMode: "private",
    prove: true,
    sendWhen: "cheap",
    policy: { tip: 20_000_000n, sendWhen: "cheap", cheapBaseFee: null, includeZeroReward: false, maxVaultsPerBatch: 100 },
    version: "0.0.0",
    gitSha: null,
  },
  warn: { type: "warn", code: "public-mempool", text: `sends go public via ${RPC}` },
  heartbeat: {
    type: "heartbeat",
    phase: "running",
    ok: false,
    lastError: `eth_call: fetch failed ${RPC}`,
    pending: { batchId: `${KEEPER}:3:0`, nonce: 3, hash: HASH, sentBlock: 5n },
    active: 2,
    due: 1,
    lastBatchHash: HASH,
    balanceWei: 10n ** 17n,
    runwayDays: 12.5,
    attention: ["rpc_errors", "public_mempool", "low_runway", "proof_lapsing"],
    eligible: true,
    proofValidUntil: 1_792_273_763n,
    proofDaysLeft: 3.4,
  },
  tick: { type: "tick", nextBaseFeeWei: 63_000_000n, lowestTargetWei: null, active: 2, clockDue: 1, candidates: 1 },
  sync: { type: "sync", deployment: "v1", scannedCount: 500n, vaultCount: 1_200n },
  vault_found: {
    type: "vault_found",
    vault: VAULT,
    deployment: "v1",
    index: 3n,
    owner: KEEPER,
    marketIndex: 0,
    tokenOut: VAULT,
    amountPerBuy: 10n ** 16n,
    interval: 86_400n,
    maxBuys: 30n,
    startAt: 1n,
    keeperReward: 87_300_000_000_000n,
    maxSlippageBps: 300n,
    communityWindow: 1_800n,
    turnBuckets: null,
  },
  vault_retired: { type: "vault_retired", vault: VAULT, reason: "done" },
  wait: { type: "wait", reason: "not-cheap", nextBaseFeeWei: 1n, targetWei: 0n, candidates: 2, nextDeadline: 99n },
  skip: { type: "skip", vault: VAULT, slot: 4n, code: "below-floor", detail: `quote from ${SEND}`, spotOut: 1n, floorOut: 2n, depth: 3n },
  skip_cleared: { type: "skip_cleared", vault: VAULT, slot: null, code: "below-floor", seconds: 600n },
  batch_sent: {
    type: "batch_sent",
    batchId: `${KEEPER}:3:0`,
    nonce: 3,
    attempt: 1,
    hash: HASH,
    deployment: "v1",
    batcher: VAULT,
    endpoint: "public",
    reason: "cheap",
    urgent: false,
    gasLimit: 698_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    nextBaseFeeWei: 1n,
    expectedGas: 1n,
    expectedCostWei: 1n,
    expectedEarnedWei: 1n,
    allowedLossWei: 0n,
    minRewardsWei: 0n,
    vaults: [
      { vault: VAULT, reward: 1n, marginWei: -5n, subsidyWei: 5n, urgent: false, firstBuy: true, spotOut: null, floorOut: null, depth: null, secondsToDeadline: 100n, communityWindowEndsAt: null },
      { vault: VAULT, reward: 1n, marginWei: 5n, subsidyWei: 0n, urgent: true, firstBuy: false, spotOut: 2n, floorOut: 1n, depth: 3n, secondsToDeadline: 90n, communityWindowEndsAt: 1_790_000_090n },
    ],
  },
  batch_replaced: { type: "batch_replaced", batchId: "b", nonce: 3, oldHash: HASH, newHash: HASH, attempt: 2, why: "not-included", maxFeePerGas: 2n, maxPriorityFeePerGas: 2n },
  resend_blocked: { type: "resend_blocked", batchId: "b", nonce: 3, why: "fee-cap" },
  batch_cancel_sent: { type: "batch_cancel_sent", batchId: "b", nonce: 3, hash: HASH },
  batch_cancelled: { type: "batch_cancelled", batchId: "b", nonce: 3, hash: HASH, costWei: 21_000n },
  batch_abandoned: { type: "batch_abandoned", batchId: "b", nonce: 3, hashes: [HASH, HASH], why: "expired" },
  batch_mined: {
    type: "batch_mined",
    batchId: "b",
    hash: HASH,
    nonce: 3,
    block: 9n,
    status: "success",
    late: false,
    gasUsed: 300_000n,
    effectiveGasPrice: 2n,
    priorityFeeWei: null,
    costWei: 600_000n,
    earnedWei: 1n,
    sweptWei: null,
    netWei: -599_999n,
    sentBlock: 8n,
    inclusionBlocks: 1n,
    attempts: 1,
    listed: 2n,
    tried: 2n,
    bought: [
      { vault: VAULT, slot: 1n, buyNumber: 2n, amountIn: 1n, amountOut: 2n, floorOut: 1n, oracleDepth: 3n, reward: 1n, gasUsed: 90_000n, secondsIntoWindow: 60n, rewardTo: KEEPER, dueSince: 1n, inCommunityWindow: true },
      { vault: VAULT, slot: 1n, buyNumber: 3n, amountIn: 1n, amountOut: 2n, floorOut: 1n, oracleDepth: 3n, reward: 1n, gasUsed: 90_000n, secondsIntoWindow: 60n, rewardTo: VAULT, dueSince: null, inCommunityWindow: null },
    ],
    refused: [{ vault: VAULT, reason: "0xe86f59ea", reasonName: "TooSoon", gasUsed: 20_000n }],
    notTried: [VAULT],
  },
  overtaken: { type: "overtaken", vault: VAULT, slot: 1n },
  window_missed: { type: "window_missed", vault: VAULT, slot: 1n, windowStart: 1n, windowEnd: 2n, class: "keeper-skipped", lastSkip: "economics", lastDetail: `see ${RPC}` },
  trapped: { type: "trapped", vault: VAULT, txHash: HASH, gasUsed: 400_000n },
  untrapped: { type: "untrapped", vault: VAULT, why: "expired" },
  subsidy_exhausted: { type: "subsidy_exhausted", lossWei24h: 2n, capWei: 2n },
  low_balance: { type: "low_balance", etherWei: 1n, thresholdWei: 2n, neededWei: null },
  unwrap_sent: { type: "unwrap_sent", batchId: "b", hash: HASH, amountWei: 5n },
  unwrap_mined: { type: "unwrap_mined", batchId: "b", hash: HASH, amountWei: 5n, status: "success" },
  batcher_deployed: { type: "batcher_deployed", deployment: "v1", hash: HASH, address: VAULT },
  eligibility: {
    type: "eligibility",
    deployment: "v2",
    registry: REGISTRY,
    rewardTo: KEEPER,
    eligible: false,
    validUntil: 1_792_273_763n,
    daysLeft: -0.5,
    spxWei: 59_880_169_405n,
    minSpxWei: 69_000_000_000n,
    isAccount: true,
    reason: "below-minimum",
  },
  prove_sent: {
    type: "prove_sent",
    batchId: `${KEEPER}:4:0`,
    hash: HASH,
    deployment: "v2",
    registry: REGISTRY,
    holder: KEEPER,
    provenBlock: 25_999_900n,
    gasLimit: 750_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    validUntil: 1_792_272_563n,
  },
  prove_mined: { type: "prove_mined", batchId: `${KEEPER}:4:0`, hash: HASH, deployment: "v2", status: "success", costWei: 1n, validUntil: 1_792_272_563n },
  prove_skipped: { type: "prove_skipped", deployment: "v2", holder: KEEPER, reason: "unsupported", detail: `eth_getProof refused by ${RPC}` },
  low_runway: { type: "low_runway", runwayDays: 4.2, thresholdDays: 7, etherWei: 10n ** 16n, spentWeekWei: 10n ** 16n },
  error: { type: "error", where: "tick", message: `eth_call: ${RPC} said no with key ${KEY}` },
  stop: { type: "stop", reason: "signal", detail: "stopped" },
} satisfies { [T in KeeperLogType]: Extract<KeeperLogBody, { type: T }> };

const record = (body: KeeperLogBody): KeeperLogRecord => stampRecord({ seq: 0 }, KEEPER, Date.UTC(2026, 8, 27), body, { block: 26_000_000n, chainTime: 1_790_000_000n });

describe("toJsonLine", () => {
  it("writes every record type as one line of JSON, bigints as decimal strings", () => {
    for (const body of Object.values(BODIES) as KeeperLogBody[]) {
      const { line, invalid } = toJsonLine(record(body), redact);
      expect(invalid).toEqual([]);
      expect(line).not.toContain("\n");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // A mined batch's own `block` is where it was mined, not the head the tick read.
      const block = body.type === "batch_mined" ? "9" : "26000000";
      expect(parsed).toMatchObject({ v: 1, ts: "2026-09-27T00:00:00.000Z", seq: 1, keeper: KEEPER, type: body.type, block, chainTime: "1790000000" });
    }
    const mined = JSON.parse(toJsonLine(record(BODIES.batch_mined), redact).line) as Record<string, unknown>;
    expect(mined["netWei"]).toBe("-599999");
    expect(mined["hash"]).toBe(HASH);
  });

  it("writes a hash in full, never redacted, though it is 64 hex digits", () => {
    const { line } = toJsonLine(record(BODIES.batch_mined), redact);
    expect((JSON.parse(line) as { hash: string }).hash).toBe(HASH);
    expect((JSON.parse(line) as { refused: { reason: string }[] }).refused[0]!.reason).toBe("0xe86f59ea");
  });

  it("redacts the free text, and only the free text", () => {
    for (const body of Object.values(BODIES) as KeeperLogBody[]) {
      const { line } = toJsonLine(record(body), redact);
      expect(line).not.toContain(RPC);
      expect(line).not.toContain("Zx9Kq3LmN7pR2sT5vW8yB1cD4eF6gH0j");
      expect(line).not.toContain("0123456789abcdefghij");
      expect(line.toLowerCase()).not.toContain(KEY.slice(2));
    }
    const error = JSON.parse(toJsonLine(record(BODIES.error), redact).line) as { message: string };
    expect(error.message).toBe("eth_call: <redacted> said no with key <redacted>");
  });

  it("writes a malformed typed field as null, and says which", () => {
    const bad = record({ ...BODIES.batch_cancelled, hash: "0xABCD" as Hex });
    const { line, invalid } = toJsonLine(bad, redact);
    expect(invalid).toEqual(["hash"]);
    expect((JSON.parse(line) as { hash: unknown }).hash).toBeNull();
    const upper = toJsonLine(record({ ...BODIES.overtaken, vault: VAULT.toUpperCase() as Address }), redact);
    expect(upper.invalid).toEqual(["vault"]);
    // A secret smuggled into a field that is not free text is refused, not written.
    const smuggled = toJsonLine(record({ ...BODIES.sync, deployment: RPC }), redact);
    expect(smuggled.invalid).toEqual(["deployment"]);
    expect(smuggled.line).not.toContain("alchemy");
    const nested = toJsonLine(record({ ...BODIES.batch_abandoned, hashes: [HASH, "0x12" as Hex] }), redact);
    expect(nested.invalid).toEqual(["hashes[1]"]);
  });

  it("stamps records with a sequence that continues from the state's", () => {
    const counter = { seq: 41 };
    const a = stampRecord(counter, KEEPER, 0, BODIES.overtaken);
    const b = stampRecord(counter, null, 0, BODIES.overtaken);
    expect([a.seq, b.seq, counter.seq]).toEqual([42, 43, 43]);
    expect(b.keeper).toBeNull();
    expect("block" in a).toBe(false);
  });
});
