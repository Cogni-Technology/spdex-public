/**
 * The report's aggregation, on logs written by hand: which buy a batch made
 * (joined by log index, never by amount), what each window's fate was, what
 * counts as complete, what is left unknown rather than zero, and that the
 * same inputs — in any order, with duplicates — give the same tables.
 *
 * The logs are encoded from the contracts' own ABIs, so a change to an event
 * breaks these tests rather than the report.
 */

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type AbiEvent } from "viem";
import type { Address, Hex } from "@spdex/core";
import { BATCHER_ABI, FACTORY_ABI, VAULT_ABI, type Deployment } from "./artifacts.js";
import type { VaultTerms } from "./index.js";
import {
  LOG_WINDOW_MAX,
  LOG_WINDOW_START,
  REPORT_COLUMNS,
  alignedChunks,
  buildReport,
  csvField,
  dailyPrices,
  dedupeKeeperRecords,
  dedupeLogs,
  nextLogWindow,
  parseKeeperLog,
  priceText,
  toCsv,
  usdText,
  type ChainBlock,
  type ChainLog,
  type KeeperRecord,
  type ReportInput,
  type Row,
} from "./report.js";

// ─── Encoding logs the way the contracts do ───────────────────────────────────

const events = [...FACTORY_ABI, ...VAULT_ABI, ...BATCHER_ABI].filter((item): item is AbiEvent & (typeof FACTORY_ABI)[number] => item.type === "event");

function logOf(address: Address, name: string, args: Record<string, unknown>, at: { block: bigint; tx: Hex; logIndex: number }): ChainLog {
  const event = events.find((e) => e.name === name) as AbiEvent | undefined;
  if (!event) throw new Error(`no event ${name}`);
  const indexed = Object.fromEntries(event.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]));
  const rest = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: [event], eventName: name, args: indexed } as never) as Hex[],
    data: encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never),
    blockNumber: at.block,
    transactionHash: at.tx,
    logIndex: at.logIndex,
  };
}

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const txh = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

// ─── The scenario ─────────────────────────────────────────────────────────────

const FACTORY = addr(0xf00);
const BATCHER = addr(0xba7);
const DEPLOYMENT: Deployment = { id: "v1", factory: FACTORY, batcher: BATCHER, factoryBlock: null, batcherBlock: null };
const [O1, O2, O3] = [addr(0x01), addr(0x02), addr(0x03)];
const [V1, V2, V3] = [addr(0xa1), addr(0xa2), addr(0xa3)];
/** The operator's keeper and cold reward address; another keeper's. */
const [K, R, X, Y] = [addr(0x4b), addr(0x4c), addr(0x5b), addr(0x5c)];

const S = 1_800_000_000n; // 2027-01-15T08:00:00Z
const HOUR = 3_600n;
const AMOUNT = 10n ** 16n;
const FEE = 10n ** 14n;
const terms: VaultTerms = {
  tokenOut: addr(0x70),
  pair: addr(0x71),
  oraclePool: addr(0x72),
  amountPerBuy: AMOUNT,
  interval: HOUR,
  maxBuys: 5n,
  startAt: S,
  keeperReward: FEE,
  maxSlippageBps: 300n,
};
/** Two minutes a block, so block 110 is the start and block 200 three windows later. */
const timeOf = (block: bigint): bigint => S + (block - 110n) * 120n;
const [T1, T2, T3, T4] = [txh(1), txh(2), txh(3), txh(4)];

const bought = (vault: Address, slot: bigint, buyNumber: bigint, keeper: Address, at: { block: bigint; tx: Hex; logIndex: number }) =>
  logOf(vault, "Bought", { slot, amountIn: AMOUNT, amountOut: 1_000n, keeper, reward: FEE, floorOut: 970n, buyNumber, oracleDepth: 50n * 10n ** 18n }, at);

function scenarioLogs(): ChainLog[] {
  const created = (vault: Address, owner: Address, funded: bigint, logIndex: number) =>
    logOf(FACTORY, "VaultCreated", { owner, vault, marketIndex: 0n, terms, funded }, { block: 101n, tx: txh(100 + logIndex), logIndex });
  return [
    created(V1, O1, 5n * (AMOUNT + FEE), 0),
    created(V2, O2, AMOUNT + FEE, 1),
    created(V3, O3, 5n * (AMOUNT + FEE), 2),
    // T1: the operator's batch buys V1 and V2 in their first window.
    bought(V1, 0n, 1n, BATCHER, { block: 110n, tx: T1, logIndex: 0 }),
    logOf(BATCHER, "Triggered", { vault: V1, received: 1_000n, gasUsed: 150_000n }, { block: 110n, tx: T1, logIndex: 1 }),
    bought(V2, 0n, 1n, BATCHER, { block: 110n, tx: T1, logIndex: 2 }),
    logOf(BATCHER, "Triggered", { vault: V2, received: 1_000n, gasUsed: 100_000n }, { block: 110n, tx: T1, logIndex: 3 }),
    logOf(BATCHER, "Batch", { caller: K, rewardTo: R, listed: 2n, tried: 2n, bought: 2n, earned: 2n * FEE, swept: 0n }, { block: 110n, tx: T1, logIndex: 4 }),
    // T2: V1's owner triggers its second window's buy.
    bought(V1, 1n, 2n, O1, { block: 140n, tx: T2, logIndex: 0 }),
    // T3: someone else's batch buys V3 in its third window; V1 is refused.
    bought(V3, 2n, 1n, BATCHER, { block: 170n, tx: T3, logIndex: 7 }),
    logOf(BATCHER, "Triggered", { vault: V3, received: 1_000n, gasUsed: 120_000n }, { block: 170n, tx: T3, logIndex: 8 }),
    logOf(BATCHER, "NotTriggered", { vault: V1, reason: "0xd6e7da92", gasUsed: 40_000n }, { block: 170n, tx: T3, logIndex: 9 }),
    logOf(BATCHER, "Batch", { caller: X, rewardTo: Y, listed: 2n, tried: 2n, bought: 1n, earned: FEE, swept: 5n }, { block: 170n, tx: T3, logIndex: 10 }),
    // Look-alikes from contracts nobody vouches for: never a buy, never a batch.
    bought(addr(0xbad), 0n, 1n, BATCHER, { block: 150n, tx: txh(9), logIndex: 0 }),
    logOf(addr(0xbad), "Batch", { caller: K, rewardTo: R, listed: 1n, tried: 1n, bought: 1n, earned: 10n ** 18n, swept: 0n }, { block: 150n, tx: txh(9), logIndex: 1 }),
  ];
}

const at = (ts: bigint) => new Date(Number(ts) * 1000).toISOString();
/** A record the keeper wrote at `chainTime`; one a tick wrote carries its block and chain time too. */
const rec = (seq: number, chainTime: bigint, body: Record<string, unknown>, tick = true): KeeperRecord =>
  ({ v: 1, ts: at(chainTime), seq, keeper: K, ...(tick ? { chainTime: chainTime.toString(), block: String(110n + (chainTime - S) / 120n) } : {}), ...body }) as KeeperRecord;

function scenarioRecords(): KeeperRecord[] {
  const records: KeeperRecord[] = [
    rec(1, S - 100n, { type: "start", rewardTo: R, chainId: 1 }, false),
    rec(2, S, {
      type: "batch_sent",
      batchId: `${K}:0:1`,
      nonce: 0,
      hash: T1,
      endpoint: "private",
      reason: "cheap",
      urgent: false,
      nextBaseFeeWei: "1000",
      expectedGas: "300000",
      expectedCostWei: "30000000",
      vaults: [
        { vault: V1, subsidyWei: "0" },
        { vault: V2, subsidyWei: "7" },
      ],
    }),
    rec(3, S, { type: "batch_mined", batchId: `${K}:0:1`, hash: T1, nonce: 0, block: "110", status: "success", gasUsed: "250000", inclusionBlocks: "1", attempts: 1 }),
    // A public batch that reverted: it left no events, only these records.
    rec(4, S + 60n, { type: "batch_sent", batchId: `${K}:1:1`, nonce: 1, hash: T4, endpoint: "public", reason: "deadline", urgent: true, nextBaseFeeWei: "2000", expectedGas: "200000", expectedCostWei: "400000", vaults: [{ vault: V2, subsidyWei: "0" }] }),
    rec(5, S + 60n, { type: "batch_mined", batchId: `${K}:1:1`, hash: T4, nonce: 1, block: "111", status: "reverted", gasUsed: "50000", effectiveGasPrice: "2", costWei: "100000", inclusionBlocks: "0", attempts: 1 }),
    rec(6, S + 7_300n, { type: "skip", vault: V1, slot: "2", code: "economics", detail: "not-subsidised" }),
    rec(7, S + 7_400n, { type: "skip", vault: V2, slot: "2", code: "sim-refused", detail: "PriceBelowFloor" }),
    rec(8, S + 7_500n, { type: "window_missed", vault: V3, slot: "1", class: "keeper-skipped", lastSkip: "below-floor", lastDetail: "spot under floor" }),
    rec(9, S + 7_600n, { type: "error", where: "tick", message: "rate limited" }),
  ];
  // Heartbeats every five minutes from the second window on: the keeper was down for the first.
  let seq = 100;
  for (let t = S + HOUR; t <= S + 3n * HOUR; t += 300n) records.push(rec(seq++, t, { type: "heartbeat", ok: true, attention: [] }, false));
  return records;
}

function scenario(overrides: Partial<ReportInput> = {}): ReportInput {
  const logs = scenarioLogs();
  const blockNumbers = new Set([100n, 200n, 111n, ...logs.map((l) => l.blockNumber)]);
  const blocks: ChainBlock[] = [...blockNumbers].map((number) => ({ number, timestamp: timeOf(number), baseFee: 10n }));
  return {
    chainId: 1,
    deployments: [DEPLOYMENT],
    range: { fromBlock: 100n, toBlock: 200n, fromTime: timeOf(100n), toTime: timeOf(200n), fromHash: txh(0xf1), toHash: txh(0xf2) },
    vaults: [
      { vault: V1, deployment: "v1", index: 0n, owner: O1, terms, buysDone: 2n, closed: false, balance: 3n * (AMOUNT + FEE) },
      { vault: V2, deployment: "v1", index: 1n, owner: O2, terms, buysDone: 1n, closed: false, balance: 0n },
      { vault: V3, deployment: "v1", index: 2n, owner: O3, terms, buysDone: 1n, closed: false, balance: 4n * (AMOUNT + FEE) },
    ],
    selected: null,
    logs,
    receipts: [
      { transactionHash: T1, blockNumber: 110n, from: K, status: "success", gasUsed: 250_000n, effectiveGasPrice: 12n },
      { transactionHash: T3, blockNumber: 170n, from: X, status: "success", gasUsed: 200_000n, effectiveGasPrice: 11n },
    ],
    blocks,
    records: dedupeKeeperRecords(scenarioRecords()),
    state: { trapped: [V3], notVouched: [] },
    rewardTo: [],
    prices: { kind: "feed", points: [{ at: S - 1_800n, answer: 264_394_000_000n }] },
    tips: null,
    uncovered: [],
    provenance: { endpointHost: "example.invalid" },
    ...overrides,
  };
}

const pick = (rows: readonly Row[], ...columns: string[]) => rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));

// ─── The tests ────────────────────────────────────────────────────────────────

describe("buildReport", () => {
  const report = buildReport(scenario());
  const { buys, batches, windows, vaults, refusals, owners, daily, keeper } = report.tables;

  it("lists each buy once, joined by log index to the batch that made it, and ignores look-alikes", () => {
    expect(pick(buys, "tx_hash", "vault", "buy_number", "trigger", "via_batcher", "batch_caller", "reward_to", "vault_gas_used")).toEqual([
      { tx_hash: T1, vault: V1, buy_number: 1n, trigger: "our-batch", via_batcher: BATCHER, batch_caller: K, reward_to: R, vault_gas_used: 150_000n },
      { tx_hash: T1, vault: V2, buy_number: 1n, trigger: "our-batch", via_batcher: BATCHER, batch_caller: K, reward_to: R, vault_gas_used: 100_000n },
      { tx_hash: T2, vault: V1, buy_number: 2n, trigger: "owner", via_batcher: null, batch_caller: null, reward_to: null, vault_gas_used: null },
      { tx_hash: T3, vault: V3, buy_number: 1n, trigger: "batch", via_batcher: BATCHER, batch_caller: X, reward_to: Y, vault_gas_used: 120_000n },
    ]);
  });

  it("measures each buy against its window, its due time and the oracle", () => {
    const second = buys.find((b) => b["tx_hash"] === T2)!;
    // Block 140 is an hour after the start: the first moment of the second window, and exactly when it was due.
    expect(second).toMatchObject({ slot: 1n, window_start: S + HOUR, seconds_into_window: 0n, seconds_after_due: 0n });
    // fair = 970 × 10⁴ / (10⁴ − 300) = 1000: the buy got the oracle's price, 3.09% above its floor.
    expect(second).toMatchObject({ floor_out: 970n, fair_out: 1_000n, exec_vs_floor_bps: 309n, exec_vs_fair_bps: 0n, fee_bps: 100, eth_usd: "2643.94" });
    expect(second["time"]).toBe("2027-01-15T09:00:00Z");
  });

  it("counts a first buy's delay from its creation when the vault was created after its start", () => {
    // Created at block 101, 18 minutes before S, with a start two hours before S: due from its creation, not its start.
    const early = { ...terms, startAt: S - 2n * HOUR };
    const report = buildReport(scenario({ vaults: scenario().vaults.map((v) => (v.vault === V1 ? { ...v, terms: early } : v)) }));
    expect(report.tables.buys.find((b) => b["tx_hash"] === T1 && b["vault"] === V1)).toMatchObject({ seconds_after_due: 1_080n });
  });

  it("puts every batch's chain figures beside the keeper's own, and keeps a reverted one only its log knows", () => {
    expect(pick(batches, "tx_hash", "batch_id", "status", "endpoint", "caller", "refused", "earned_wei", "swept_wei", "earned_matches_rewards", "cost_wei", "net_wei", "keeper_reason", "urgent")).toEqual([
      { tx_hash: T1, batch_id: `${K}:0:1`, status: "success", endpoint: "private", caller: K, refused: 0, earned_wei: 2n * FEE, swept_wei: 0n, earned_matches_rewards: true, cost_wei: 3_000_000n, net_wei: 2n * FEE - 3_000_000n, keeper_reason: "cheap", urgent: false },
      { tx_hash: T4, batch_id: `${K}:1:1`, status: "reverted", endpoint: "public", caller: K, refused: null, earned_wei: 0n, swept_wei: 0n, earned_matches_rewards: null, cost_wei: 100_000n, net_wei: -100_000n, keeper_reason: "deadline", urgent: true },
      { tx_hash: T3, batch_id: null, status: "success", endpoint: null, caller: X, refused: 1, earned_wei: FEE, swept_wei: 5n, earned_matches_rewards: true, cost_wei: 2_200_000n, net_wei: FEE - 2_200_000n, keeper_reason: null, urgent: null },
    ]);
    // Priority fee: gas × (effective price − base fee), from the receipt and the block.
    expect(batches[0]).toMatchObject({ priority_fee_wei: 250_000n * 2n, base_fee: 10n, expected_gas: 300_000n, inclusion_blocks: 1n });
  });

  it("classifies every window: bought and by whom, unfunded, the keeper down, or the keeper skipping and why", () => {
    expect(pick(windows, "vault", "slot", "class", "by", "last_skip")).toEqual([
      { vault: V1, slot: 0n, class: "bought", by: "our-batch", last_skip: null },
      { vault: V1, slot: 1n, class: "bought", by: "owner", last_skip: null },
      { vault: V1, slot: 2n, class: "keeper-skipped", by: null, last_skip: "economics" },
      { vault: V2, slot: 0n, class: "bought", by: "our-batch", last_skip: null },
      // It held exactly one buy and its fee, and spent it.
      { vault: V2, slot: 1n, class: "unfunded", by: null, last_skip: null },
      { vault: V2, slot: 2n, class: "unfunded", by: null, last_skip: null },
      // No heartbeat in its first window; the keeper's own record for its second.
      { vault: V3, slot: 0n, class: "keeper-down", by: null, last_skip: null },
      { vault: V3, slot: 1n, class: "keeper-skipped", by: null, last_skip: "below-floor" },
      { vault: V3, slot: 2n, class: "bought", by: "batch", last_skip: null },
    ]);
  });

  it("sums each vault's life and checks its buy numbers", () => {
    expect(pick(vaults, "vault", "list_index", "funded_at_creation_wei", "buys_done", "windows_elapsed", "windows_missed_funded", "windows_missed_unfunded", "buy_number_gaps", "trapped", "not_vouched")).toEqual([
      { vault: V1, list_index: 0n, funded_at_creation_wei: 5n * (AMOUNT + FEE), buys_done: 2n, windows_elapsed: 3, windows_missed_funded: 1, windows_missed_unfunded: 0, buy_number_gaps: 0, trapped: false, not_vouched: false },
      { vault: V2, list_index: 1n, funded_at_creation_wei: AMOUNT + FEE, buys_done: 1n, windows_elapsed: 3, windows_missed_funded: 0, windows_missed_unfunded: 2, buy_number_gaps: 0, trapped: false, not_vouched: false },
      { vault: V3, list_index: 2n, funded_at_creation_wei: 5n * (AMOUNT + FEE), buys_done: 1n, windows_elapsed: 3, windows_missed_funded: 2, windows_missed_unfunded: 0, buy_number_gaps: 0, trapped: true, not_vouched: false },
    ]);
  });

  it("lists refusals from the chain and from the keeper's simulations, for factory vaults only", () => {
    expect(pick(refusals, "source", "tx_hash", "vault", "reason", "reason_name", "gas_used")).toEqual([
      { source: "chain", tx_hash: T3, vault: V1, reason: "0xd6e7da92", reason_name: "PriceBelowFloor", gas_used: 40_000n },
      { source: "simulation", tx_hash: null, vault: V2, reason: null, reason_name: "PriceBelowFloor", gas_used: null },
    ]);
  });

  it("books planned subsidy against owners, and the keeper's day against its heartbeats", () => {
    expect(pick(owners, "owner", "buys", "subsidy_wei")).toEqual([
      { owner: O1, buys: 2, subsidy_wei: 0n },
      { owner: O2, buys: 1, subsidy_wei: 7n },
      { owner: O3, buys: 1, subsidy_wei: 0n },
    ]);
    // Per buy and per vault too, so a day's subsidy per vault or owner follows from buys.csv.
    expect(buys.find((b) => b["tx_hash"] === T1 && b["vault"] === V2)).toMatchObject({ subsidy_wei: 7n });
    expect(pick(vaults, "vault", "subsidy_wei")).toEqual([
      { vault: V1, subsidy_wei: 0n },
      { vault: V2, subsidy_wei: 7n },
      { vault: V3, subsidy_wei: 0n },
    ]);
    // Up from S+1h until the last heartbeat's five minutes end, of a span from S−100 s to then: 7,500 of 11,200 seconds.
    expect(keeper).toEqual([
      expect.objectContaining({ date: "2027-01-15", heartbeats: 25, uptime_pct: "66.9", errors: 1, sends_cheap: 1, sends_deadline: 1, median_inclusion_blocks: 0n, model_gas_ratio: "0.833" }),
    ]);
    expect(daily).toEqual([
      expect.objectContaining({ date: "2027-01-15", buys: 4, active_vaults: 3, owners: 3, batches: 3, vaults_created: 3, windows_missed_funded: 3, windows_missed_unfunded: 2, keeper_uptime_pct: "66.9", eth_usd: "2643.94", subsidy_wei: 7n }),
    ]);
  });

  it("answers the questions in the summary, and says the data is complete", () => {
    const s = report.summary as Record<string, Record<string, unknown>>;
    expect(s["q1"]).toMatchObject({ buys: 4, volumeWei: 4n * AMOUNT, volumeUsd: "105.75", activeVaults: 3, uniqueOwners: 3 });
    expect(s["q8"]!["byClass"]).toEqual({ bought: 4, "keeper-down": 1, "keeper-skipped": 2, unfunded: 2 });
    // The keeper's own refusals count as failures too, by the windows they cost.
    expect(s["q10"]!["windowsSkippedByKeeper"]).toEqual({ "below-floor": 1, economics: 1 });
    expect(s["q11"]).toMatchObject({ heartbeats: 25, uptimePct: "66.9", errors: 1 });
    expect(s["q14"]!["byTrigger"]).toEqual({ batch: 1, "our-batch": 2, owner: 1 });
    expect(s["q18"]).toMatchObject({ complete: true, buyNumberGaps: [], batchesWhoseEarnedDisagrees: [], uncovered: [] });
    expect(s["q3"]).toMatchObject({ unexplained: [] });
    expect(s["provenance"]).toMatchObject({ endpointHost: "example.invalid", fromBlock: 100n, toBlock: 200n });
  });
});

describe("keeper uptime", () => {
  it("counts a day with no record, and the time after the logs stop, as the keeper down", () => {
    const DAY = 86_400n;
    const midnight = S - 8n * HOUR; // 2027-01-15T00:00:00Z
    const heartbeats = (from: bigint, n: number, seq: number) =>
      Array.from({ length: n }, (_, i) => rec(seq + i, from + BigInt(i) * 300n, { type: "heartbeat", ok: true, attention: [] }, false));
    // Up all of the 15th, silent all of the 16th, up the first half of the 17th, and silent until the report's end on the 18th.
    const records = dedupeKeeperRecords([...heartbeats(midnight, 287, 1), ...heartbeats(midnight + 2n * DAY, 144, 1_000)]);
    const report = buildReport(scenario({ records, range: { ...scenario().range, toTime: midnight + 4n * DAY - 1n } }));
    expect(pick(report.tables.keeper, "date", "uptime_pct")).toEqual([
      { date: "2027-01-15", uptime_pct: "100.0" },
      { date: "2027-01-16", uptime_pct: "0.0" },
      { date: "2027-01-17", uptime_pct: "50.0" },
      { date: "2027-01-18", uptime_pct: "0.0" },
    ]);
    expect(report.tables.daily.map((d) => d["keeper_uptime_pct"])).toEqual(["100.0", "0.0", "50.0", "0.0"]);
    // One figure over the whole span, not a median of days: a day and a half of the four.
    expect(report.summary["q11"]).toMatchObject({ uptimePct: "37.5" });
  });
});

describe("what the report will not claim", () => {
  it("flags a missing buy number and a batch it cannot check", () => {
    // Drop V1's first Bought: its Triggered is still there, so the batch can't be checked either.
    const logs = scenarioLogs().filter((l) => !(l.transactionHash === T1 && l.logIndex === 0));
    const report = buildReport(scenario({ logs }));
    expect(report.tables.vaults.find((v) => v["vault"] === V1)).toMatchObject({ buy_number_gaps: 1 });
    expect(report.tables.batches.find((b) => b["tx_hash"] === T1)).toMatchObject({ earned_matches_rewards: null });
    expect(report.summary["q18"]).toMatchObject({ complete: false, buyNumberGaps: [{ vault: V1, gaps: 1 }], batchesNotJoined: [T1] });
  });

  it("flags a batch whose earned is not the sum of its buys' fees", () => {
    const logs = scenarioLogs().map((l) =>
      l.transactionHash === T1 && l.logIndex === 4
        ? logOf(BATCHER, "Batch", { caller: K, rewardTo: R, listed: 2n, tried: 2n, bought: 2n, earned: 2n * FEE + 1n, swept: 0n }, { block: 110n, tx: T1, logIndex: 4 })
        : l,
    );
    const report = buildReport(scenario({ logs }));
    expect(report.tables.batches.find((b) => b["tx_hash"] === T1)).toMatchObject({ earned_matches_rewards: false });
    expect(report.summary["q18"]).toMatchObject({ complete: false, batchesWhoseEarnedDisagrees: [T1] });
  });

  it("leaves unknown what it was not given: no prices, no keeper logs, no state", () => {
    const report = buildReport(scenario({ prices: { kind: "none" }, records: [], state: null }));
    const { buys, batches, owners, daily, windows, vaults } = report.tables;
    expect(buys.every((b) => b["eth_usd"] === null)).toBe(true);
    expect(batches.every((b) => b["net_usd"] === null && b["batch_id"] === null)).toBe(true);
    expect(owners.every((o) => o["subsidy_wei"] === null)).toBe(true);
    expect(daily[0]).toMatchObject({ volume_usd: null, subsidy_wei: null, keeper_uptime_pct: null });
    expect(vaults[0]).toMatchObject({ trapped: null, not_vouched: null });
    // Without the keeper's logs nobody can say why a funded window was missed.
    expect(windows.filter((w) => w["class"] === "keeper-down" || w["class"] === "keeper-skipped")).toEqual([]);
    expect(report.summary["q1"]).toMatchObject({ volumeUsd: null });
    expect(report.summary["q6"]).toMatchObject({ plannedSubsidyWei: null, realisedLossWei: null });
  });

  it("counts a figure it could not read as unknown in a sum, not as zero", () => {
    const receipts = scenario().receipts.filter((r) => r.transactionHash !== T3);
    const report = buildReport(scenario({ receipts }));
    expect(report.tables.batches.find((b) => b["tx_hash"] === T3)).toMatchObject({ gas_used: null, cost_wei: null, net_wei: null });
    expect(report.tables.daily[0]).toMatchObject({ gas_cost_wei: null, net_wei: null });
  });
});

describe("the same inputs, the same report", () => {
  it("is unchanged by the order of the inputs and by duplicates", () => {
    const base = scenario();
    const shuffled = scenario({
      logs: [...base.logs].reverse().concat(base.logs.slice(0, 5)),
      blocks: [...base.blocks].reverse(),
      records: dedupeKeeperRecords([...scenarioRecords()].reverse().concat(scenarioRecords())),
    });
    const csv = (input: ReportInput) => {
      const { tables } = buildReport(input);
      return Object.entries(tables).map(([name, rows]) => toCsv(REPORT_COLUMNS[name as keyof typeof REPORT_COLUMNS], rows!)).join("\n");
    };
    expect(csv(shuffled)).toBe(csv(base));
    expect(JSON.stringify(buildReport(shuffled).summary, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(buildReport(base).summary, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });

  it("limits every table to the vaults asked for", () => {
    const { tables } = buildReport(scenario({ selected: [V1] }));
    expect(new Set(tables.buys.map((b) => b["vault"]))).toEqual(new Set([V1]));
    expect(new Set(tables.windows.map((w) => w["vault"]))).toEqual(new Set([V1]));
    expect(tables.vaults.map((v) => v["vault"])).toEqual([V1]);
    // T1 and T3 both touched V1; the reverted T4 named only V2.
    expect(tables.batches.map((b) => b["tx_hash"])).toEqual([T1, T3]);
    expect(tables.owners.map((o) => o["owner"])).toEqual([O1]);
  });

  it("lists token transfers to tip addresses, ERC-20 only", () => {
    const transfer = (to: Address, amount: bigint, logIndex: number): ChainLog => ({
      address: addr(0x70),
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${"0".repeat(24)}${O1.slice(2)}`, `0x${"0".repeat(24)}${to.slice(2)}`],
      data: `0x${amount.toString(16).padStart(64, "0")}`,
      blockNumber: 120n,
      transactionHash: txh(0x77),
      logIndex,
    });
    // An ERC-721 transfer indexes its token id as a fourth topic, and is not a tip.
    const nft = { ...transfer(R, 0n, 2), topics: [...transfer(R, 0n, 2).topics, txh(5)], data: "0x" as Hex };
    const { tables } = buildReport(scenario({ tips: [transfer(R, 5n, 1), nft], blocks: [...scenario().blocks, { number: 120n, timestamp: timeOf(120n), baseFee: 10n }] }));
    expect(tables.tips).toEqual([{ tx_hash: txh(0x77), block: 120n, time: "2027-01-15T08:20:00Z", token: addr(0x70), from: O1, to: R, amount: 5n }]);
  });
});

// ─── The pieces ───────────────────────────────────────────────────────────────

describe("keeper logs", () => {
  it("skips a last line cut short, and counts any other bad line", () => {
    const good = JSON.stringify({ v: 1, ts: "2027-01-15T08:00:00.000Z", seq: 1, keeper: K, type: "start" });
    expect(parseKeeperLog(`${good}\n${good.replace('"seq":1', '"seq":2')}\n{"v":1,"ts":"2027-01-15T08:0`)).toMatchObject({ truncated: true, bad: 0, records: [{ seq: 1 }, { seq: 2 }] });
    expect(parseKeeperLog(`not json\n${good}\n{"v":2}\n`)).toMatchObject({ truncated: false, bad: 2, records: [{ seq: 1 }] });
    expect(parseKeeperLog("")).toEqual({ records: [], truncated: false, bad: 0 });
  });

  it("keeps each record once, across files, in the order it was written", () => {
    const a = rec(1, S, { type: "start" });
    const b = rec(2, S + 1n, { type: "wait" });
    // After --reset-state the sequence starts again: the same seq at another time is another record.
    const again = rec(1, S + 99n, { type: "start" });
    expect(dedupeKeeperRecords([b, a, again, b, a]).map((r) => [r.seq, r.ts])).toEqual([
      [1, a.ts],
      [2, b.ts],
      [1, again.ts],
    ]);
  });
});

describe("reading logs politely", () => {
  it("keeps each log once, in chain order", () => {
    const [x, y] = [bought(V1, 0n, 1n, BATCHER, { block: 5n, tx: T1, logIndex: 3 }), bought(V1, 0n, 1n, BATCHER, { block: 4n, tx: T2, logIndex: 9 })];
    expect(dedupeLogs([x, y, { ...x, transactionHash: x.transactionHash.toUpperCase() as Hex }])).toEqual([y, x]);
  });

  it("halves a refused window down to one block, and widens it again after ten answers", () => {
    let w = { blocks: LOG_WINDOW_START, successes: 0 };
    for (let i = 0; i < 20; i++) w = nextLogWindow(w, "refused");
    expect(w).toEqual({ blocks: 1n, successes: 0 });
    for (let i = 0; i < 9; i++) w = nextLogWindow(w, "answered");
    expect(w).toEqual({ blocks: 1n, successes: 9 });
    expect(nextLogWindow(w, "answered")).toEqual({ blocks: 2n, successes: 0 });
    expect(nextLogWindow({ blocks: LOG_WINDOW_MAX, successes: 9 }, "answered")).toEqual({ blocks: LOG_WINDOW_MAX, successes: 0 });
  });

  it("cuts a range at multiples of the chunk size, so a cached chunk is found again", () => {
    expect(alignedChunks(25n, 61n, 20n)).toEqual([
      [25n, 39n],
      [40n, 59n],
      [60n, 61n],
    ]);
    expect(alignedChunks(40n, 40n, 20n)).toEqual([[40n, 40n]]);
  });
});

describe("CSV", () => {
  it("quotes what needs quoting, doubles quotes, and writes unknown as empty", () => {
    expect(csvField('say "hi", then\nleave')).toBe('"say ""hi"", then\nleave"');
    expect(csvField(null)).toBe("");
    expect(csvField(-12n)).toBe("-12");
    expect(csvField(false)).toBe("false");
    expect(toCsv(["a", "b"], [{ a: 1, b: null }, { a: "x,y" }])).toBe('a,b\n1,\n"x,y",\n');
  });
});

describe("money", () => {
  it("prints a Chainlink answer and a dollar amount exactly, rounding toward zero", () => {
    expect(priceText(264_394_000_000n)).toBe("2643.94");
    expect(priceText(5n)).toBe("0.00000005");
    expect(usdText(10n ** 18n, 264_394_000_000n)).toBe("2643.94");
    expect(usdText(-(10n ** 16n), 264_394_000_000n)).toBe("-26.43");
    expect(usdText(1n, 264_394_000_000n)).toBe("0.00");
  });

  it("gives a day a price only when the feed spoke that day, or the hour before", () => {
    const day = "2027-01-15";
    const start = S - 8n * HOUR;
    const feed = (at: bigint) => ({ kind: "feed" as const, points: [{ at, answer: 100n * 10n ** 8n }] });
    expect(dailyPrices(feed(start - HOUR), [day], S).get(day)).toBe(100n * 10n ** 8n);
    expect(dailyPrices(feed(start - HOUR - 1n), [day], S).get(day)).toBeNull();
    // A reading after the report's end is not one it could have used.
    expect(dailyPrices(feed(S + 1n), [day], S).get(day)).toBeNull();
    expect(dailyPrices({ kind: "fixed", answer: 7n }, [day], S).get(day)).toBe(7n);
    expect(dailyPrices({ kind: "none" }, [day], S).get(day)).toBeNull();
  });
});
