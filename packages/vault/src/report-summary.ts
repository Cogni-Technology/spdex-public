/**
 * The report's summary: its twenty-one questions, each answered from the
 * finished tables and the report's context — and the arithmetic over a
 * table's column (sums, medians, spreads, counts, how concentrated the
 * community windows' buys are) that the daily table does too.
 *
 * `report.ts` builds the tables, calls `summarise`, and puts the answers
 * between the summary's version and provenance and what it cannot know. This
 * file imports nothing of report.ts's but its types, so the two never form a
 * cycle, and like the rest of the report it reads no clock and makes no
 * request: a figure the inputs cannot give is null, never zero.
 */

import type { Address, Hex } from "@spdex/core";
import { SOURCES, type Deployment } from "./artifacts.js";
import { percentile } from "./keeper-plan.js";
import type { Cell, Context, KeeperRecord, Report, Row } from "./report.js";

// ─── The questions ────────────────────────────────────────────────────────────

/** The answers to the report's twenty-one questions, `q1` to `q21`, in order. */
export function summarise(c: Context, t: Report["tables"]): Record<string, unknown> {
  const { buys, batches, windows, vaults, refusals, keeper } = t;
  const input = c.input;
  const q = (question: string, answer: Record<string, unknown>) => ({ question, ...answer });
  const volume = sum(buys, "amount_in_wei");
  const created = vaults.filter((v) => v["created_block"] !== null);
  // A reverted batch is in the table only because the keeper's own log named it.
  const ours = batches.filter((b) => {
    const run = c.runByTx.get(String(b["tx_hash"]) as Hex);
    return run ? c.ours(run) : b["status"] === "reverted";
  });
  const byClass = countBy(windows, "class");
  const gaps = vaults.filter((v) => typeof v["buy_number_gaps"] === "number" && v["buy_number_gaps"] > 0);
  const mismatched = batches.filter((b) => b["earned_matches_rewards"] === false);
  const unjoined = batches.filter((b) => b["status"] === "success" && b["earned_matches_rewards"] === null);
  const records = input.records;
  const hasLogs = c.hasLogs;
  const logCount = (type: string) => (hasLogs ? records.filter((r) => r.type === type).length : null);
  const refusedForDepth = refusals.filter((r) => r["reason_name"] === "OracleTooThin").length;
  const span = c.keeperLog.span;
  const heartbeats = records.filter((r) => r.type === "heartbeat");
  const lastRunway = heartbeats.filter((r) => typeof r["runwayDays"] === "number").at(-1)?.["runwayDays"];
  // Decision 29's figure: the 30 days ending at the report's last block, when the range reaches back that far.
  const { fromTime, toTime } = input.range;
  const concentrationFrom = toTime - CONCENTRATION_SECONDS;
  const covers30Days = fromTime <= concentrationFrom;
  const window = concentration(buys, covers30Days ? concentrationFrom : fromTime, toTime, input.deployments);

  return {
    q1: q("Buys per day, volume, active vaults, unique owners", {
      buys: buys.length,
      volumeWei: volume,
      volumeUsd: buysUsd(c),
      activeVaults: new Set(buys.map((b) => b["vault"])).size,
      uniqueOwners: new Set(buys.map((b) => b["owner"])).size,
      medianBuysPerDay: percentile(t.daily.map((d) => BigInt(Number(d["buys"]))), 50),
    }),
    q2: q("New plans; sizes, intervals, lengths and fees", {
      created: created.length,
      listed: vaults.length,
      amountPerBuyWei: spread(vaults, "amount_per_buy_wei"),
      intervalSeconds: spread(vaults, "interval_s"),
      maxBuys: spread(vaults, "max_buys"),
      feeBps: spread(vaults, "fee_bps"),
    }),
    q3: q("Deposits, withdrawals and value held", balancesAnswer(c)),
    q4: q("Fee revenue per buy, batch, day and operator", {
      feesWei: sum(buys, "fee_wei"),
      medianFeePerBuyWei: median(buys, "fee_wei"),
      batchesEarnedWei: sum(batches, "earned_wei"),
      // v1's sweeps alone: v2's batcher has none, and its batches leave the column empty rather than 0.
      sweptWei: sum(batches, "swept_wei"),
      byRewardTo: groupSum(batches.filter((b) => b["reward_to"] !== null), "reward_to", "earned_wei", "earned_wei"),
      // Every buy's fee by whom it paid, batched or not: a v2 vault pays its `rewardTo` directly, the owner's own trigger included.
      feesByRewardTo: groupSum(buys.filter((b) => b["reward_to"] !== null), "reward_to", "fee_wei", "fee_wei"),
      oursEarnedWei: sum(ours, "earned_wei"),
    }),
    q5: q("Gas per batch and per buy; revenue against cost", {
      batches: batches.length,
      medianGasPerBatch: median(batches, "gas_used"),
      medianGasPerBuy: median(buys, "vault_gas_used"),
      costWei: sumKnown(batches, "cost_wei"),
      netWei: sumKnown(batches, "net_wei"),
      ours: { batches: ours.length, costWei: sumKnown(ours, "cost_wei"), netWei: sumKnown(ours, "net_wei") },
    }),
    q6: q("Subsidy spent against the caps", {
      plannedSubsidyWei: hasLogs ? t.owners.reduce((s, o) => s + (big(o["subsidy_wei"]) ?? 0n), 0n) : null,
      realisedLossWei: hasLogs ? ours.reduce((s, b) => s + negativePart(big(b["net_wei"])), 0n) : null,
      breakerOpened: logCount("subsidy_exhausted"),
      byOwner: hasLogs ? t.owners.filter((o) => (big(o["subsidy_wei"]) ?? 0n) > 0n).map((o) => ({ owner: o["owner"], subsidyWei: o["subsidy_wei"] })) : null,
    }),
    q7: q("Execution against the oracle", {
      medianExecVsFloorBps: median(buys, "exec_vs_floor_bps"),
      medianExecVsFairBps: median(buys, "exec_vs_fair_bps"),
      worstExecVsFairBps: min(buys, "exec_vs_fair_bps"),
    }),
    q8: q("Every elapsed window, classified", {
      windows: windows.length,
      byClass,
      boughtBy: countBy(windows.filter((w) => w["class"] === "bought"), "by"),
      boughtByMadeBy: countBy(windows.filter((w) => w["class"] === "bought"), "made_by"),
    }),
    q9: q("Time into the window when bought; delay after due", {
      medianSecondsIntoWindow: median(buys, "seconds_into_window"),
      medianSecondsAfterDue: median(buys, "seconds_after_due"),
    }),
    q10: q("Failures by reason, and their cost", {
      byReason: Object.entries(countBy(refusals, "reason_name")).map(([reasonName, count]) => ({
        reasonName: reasonName === "" ? null : reasonName,
        count,
        chain: refusals.filter((r) => (r["reason_name"] ?? "") === reasonName && r["source"] === "chain").length,
        gasUsed: sumKnown(refusals.filter((r) => (r["reason_name"] ?? "") === reasonName), "gas_used"),
      })),
      // What the keeper's own checks refused, before any simulation: the windows it skipped, by its last reason.
      windowsSkippedByKeeper: hasLogs ? countBy(windows.filter((w) => w["class"] === "keeper-skipped"), "last_skip") : null,
    }),
    q11: q("Keeper uptime and health", {
      heartbeats: logCount("heartbeat"),
      // One figure over the whole span, so a day-long outage counts in full rather than as one day's median.
      uptimePct: span === null ? null : c.uptime(span[0], span[1]),
      errors: logCount("error"),
      attention: hasLogs ? attentionCounts(records) : null,
      // Days of sends the key's ether covered at the last heartbeat, and how often it fell below the operator's threshold.
      lastRunwayDays: typeof lastRunway === "number" ? lastRunway : null,
      lowRunwayWarnings: logCount("low_runway"),
      proves: logCount("prove_sent"),
    }),
    q12: q("Inclusion, resends, drops and cancels; private against public", {
      sent: logCount("batch_sent"),
      byEndpoint: hasLogs ? countBy(records.filter((r) => r.type === "batch_sent").map((r) => ({ e: stringField(r["endpoint"]) })), "e") : null,
      replaced: logCount("batch_replaced"),
      resendsBlocked: logCount("resend_blocked"),
      abandoned: logCount("batch_abandoned"),
      cancels: logCount("batch_cancel_sent"),
      medianInclusionBlocks: median(batches, "inclusion_blocks"),
    }),
    q13: q("Fee at send against the target; deadline-forced sends", {
      sendsByReason: hasLogs ? countBy(records.filter((r) => r.type === "batch_sent").map((r) => ({ r: stringField(r["reason"]) })), "r") : null,
      urgentSends: hasLogs ? records.filter((r) => r.type === "batch_sent" && r["urgent"] === true).length : null,
      medianNextBaseFeeWei: hasLogs ? percentile(records.filter((r) => r.type === "batch_sent").map((r) => big(r["nextBaseFeeWei"])).filter((v): v is bigint => v !== null), 50) : null,
      waitsNotCheap: hasLogs ? records.filter((r) => r.type === "wait" && r["reason"] === "not-cheap").length : null,
    }),
    q14: q("Who triggers", {
      byTrigger: countBy(buys, "trigger"),
      byMadeBy: countBy(buys, "made_by"),
      callers: groupCount(batches.filter((b) => b["caller"] !== null), "caller"),
      rewardTos: groupCount(batches.filter((b) => b["reward_to"] !== null), "reward_to"),
    }),
    q15: q("Vault lifecycle", lifecycleAnswer(c, vaults, buys)),
    q16: q("Oracle and market health", {
      refusedOracleTooThin: refusedForDepth,
      refusedPriceBelowFloor: refusals.filter((r) => r["reason_name"] === "PriceBelowFloor").length,
      keeperSkips: hasLogs ? countBy(records.filter((r) => r.type === "skip").map((r) => ({ code: stringField(r["code"]) })), "code") : null,
    }),
    q17: q("Is MIN_ORACLE_DEPTH (10 ETH) right?", {
      oracleDepthWei: spread(buys, "oracle_depth_wei"),
      p10OracleDepthWei: percentile(known(buys, "oracle_depth_wei"), 10),
      refusedForDepth,
    }),
    q18: q("Is the data complete?", {
      complete: input.uncovered.length === 0 && gaps.length === 0 && mismatched.length === 0 && unjoined.length === 0 && window.unknownBuys === 0,
      // v2 buys q21 can't tell in or out of its count: their window, owner or time unknown.
      communityWindowUnknownBuys: window.unknownBuys,
      buyNumberGaps: gaps.map((v) => ({ vault: v["vault"], gaps: v["buy_number_gaps"] })),
      batchesWhoseEarnedDisagrees: mismatched.map((b) => b["tx_hash"]),
      batchesNotJoined: unjoined.map((b) => b["tx_hash"]),
      uncovered: input.uncovered,
    }),
    q19: q("Is the cost model right?", {
      medianGasOverModel: hasLogs ? medianText(keeper.map((k) => k["model_gas_ratio"])) : null,
      oursExpectedCostWei: hasLogs ? sumKnown(ours, "expected_cost_wei") : null,
      oursCostWei: hasLogs ? sumKnown(ours, "cost_wei") : null,
    }),
    q20: q("Token tips (an upper bound: anyone can send to those addresses; ether tips leave no log)", {
      transfers: t.tips ? t.tips.length : null,
      byToken: t.tips ? groupSum(t.tips, "token", "amount", "amount") : null,
    }),
    q21: q("How concentrated are v2's community window buys? The top 1 and top 5 rewardTo's share over a rolling 30 days (decision 29)", {
      from: isoOf(covers30Days ? concentrationFrom : fromTime),
      to: isoOf(toTime),
      covers30Days,
      ...window,
      // Top 1 above half for a rolling 30 days formally reopens turns among holders (decision 6). Shorter ranges can't say.
      reopensDecision6: covers30Days && window.top1Above50 !== null ? window.top1Above50 : null,
    }),
  };
}

// ─── The community window's concentration ─────────────────────────────────────

/** Decision 29's period: a rolling 30 days. */
export const CONCENTRATION_SECONDS = 30n * 86_400n;

/**
 * How concentrated the buys made inside community windows were over
 * `[from, to]`, by the `rewardTo` they paid: the buys decision 29 counts are
 * buys of a release whose source has a community window (`deployments` says
 * which source each release is), made inside their window and paid to someone
 * other than the vault's owner — community keepers', this operator's own and
 * the developers' among them, alike. Every share is null when there were none:
 * unknown, not 0%. Ties fall to the lower address, so the same buys always
 * give the same top.
 *
 * Such a buy that may be one of them but can't be told — its window unknown
 * (the vault's terms or the block's time unread), its owner unknown while it
 * was inside its window, or its time unknown, so not placed in or out of the
 * period — is counted in `unknownBuys`, never left out: while any is, the
 * counts are lower bounds and every share and `top1Above50` is null, since a
 * share of a subset is a share of nothing decision 29 names.
 */
export function concentration(
  buys: readonly Row[],
  from: bigint,
  to: bigint,
  deployments: readonly Pick<Deployment, "id" | "source">[],
): {
  windowBuys: number;
  unknownBuys: number;
  rewardTos: number;
  top1: { rewardTo: string; buys: number; sharePct: string | null } | null;
  top5: { rewardTos: string[]; buys: number; sharePct: string | null } | null;
  top1Above50: boolean | null;
} {
  const windowed = new Set(deployments.filter((d) => SOURCES[d.source]?.features.communityWindow).map((d) => d.id as string));
  const counts = new Map<string, number>();
  let unknownBuys = 0;
  for (const row of buys) {
    if (!windowed.has(String(row["release"])) || row["in_community_window"] === false) continue;
    const at = secondsOf(row["time"]);
    if (at !== null && (at < from || at > to)) continue;
    const inWindow = row["in_community_window"] === true;
    if (at === null || !inWindow || row["reward_to"] === null || row["owner"] === null) {
      unknownBuys += 1;
      continue;
    }
    if (row["reward_to"] === row["owner"]) continue;
    counts.set(String(row["reward_to"]), (counts.get(String(row["reward_to"])) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(([a, x], [b, y]) => y - x || cmp(a, b));
  const total = ranked.reduce((n, [, k]) => n + k, 0);
  if (total === 0) return { windowBuys: 0, unknownBuys, rewardTos: 0, top1: null, top5: null, top1Above50: null };
  const top5 = ranked.slice(0, 5);
  const top5Buys = top5.reduce((n, [, k]) => n + k, 0);
  const known = unknownBuys === 0;
  return {
    windowBuys: total,
    unknownBuys,
    rewardTos: ranked.length,
    top1: { rewardTo: ranked[0]![0], buys: ranked[0]![1], sharePct: known ? shareText(ranked[0]![1], total) : null },
    top5: { rewardTos: top5.map(([a]) => a), buys: top5Buys, sharePct: known ? shareText(top5Buys, total) : null },
    top1Above50: known ? ranked[0]![1] * 2 > total : null,
  };
}

/** `part` of `whole` as a percentage to a tenth, rounded down: 2 of 3 → "66.6". */
function shareText(part: number, whole: number): string {
  const permille = (BigInt(part) * 1000n) / BigInt(whole);
  return `${permille / 10n}.${permille % 10n}`;
}

/** An ISO time cell back as chain seconds; null for anything else. */
function secondsOf(cell: Cell | undefined): bigint | null {
  if (typeof cell !== "string") return null;
  const ms = Date.parse(cell);
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

const isoOf = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z");

function balancesAnswer(c: Context): Record<string, unknown> {
  let deposits = 0n;
  let withdrawals = 0n;
  let spent = 0n;
  let held: bigint | null = 0n;
  const unexplained: { vault: Address; wei: bigint }[] = [];
  for (const [vault, t] of c.timelines) {
    if (!c.isSelected(vault)) continue;
    const inflow = (t.created?.funded ?? 0n) + t.funded.reduce((s, f) => s + f.amount, 0n);
    const outflow = t.buys.reduce((s, b) => s + b.event.amountIn + b.event.reward, 0n) + (t.closed?.amount ?? 0n);
    deposits += inflow;
    withdrawals += t.closed?.amount ?? 0n;
    spent += outflow - (t.closed?.amount ?? 0n);
    held = held === null || t.at.balance === null ? null : held + t.at.balance;
    // For a vault whose whole life is in the range, the logs account for every wei it should hold; any
    // difference arrived some other way, most likely WETH sent to it directly. Reported, never guessed at.
    if (t.created && t.at.balance !== null && t.at.balance !== inflow - outflow) unexplained.push({ vault, wei: t.at.balance - (inflow - outflow) });
  }
  return { depositsWei: deposits, withdrawalsWei: withdrawals, spentOnBuysAndFeesWei: spent, heldAtEndWei: held, unexplained };
}

function lifecycleAnswer(c: Context, vaults: readonly Row[], buys: readonly Row[]): Record<string, unknown> {
  const toFirst: bigint[] = [];
  for (const [vault, t] of c.timelines) {
    if (!c.isSelected(vault) || !t.created) continue;
    const first = t.buys.find((b) => b.event.buyNumber === 1n);
    const from = c.timeOf(t.created.block);
    const to = first ? c.timeOf(first.block) : null;
    if (from !== null && to !== null) toFirst.push(to - from);
  }
  const owners = countBy(vaults.filter((v) => v["owner"] !== null), "owner");
  return {
    created: vaults.filter((v) => v["created_block"] !== null).length,
    firstBuys: buys.filter((b) => b["buy_number"] === 1n).length,
    medianSecondsToFirstBuy: percentile(toFirst, 50),
    completed: vaults.filter((v) => v["buys_done"] !== null && v["buys_done"] === v["max_buys"]).length,
    closedEarly: vaults.filter((v) => v["closed"] === true && v["buys_done"] !== null && big(v["buys_done"])! < (big(v["max_buys"]) ?? 0n)).length,
    repeatOwners: Object.values(owners).filter((n) => n > 1).length,
  };
}

function attentionCounts(records: readonly KeeperRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    if (r.type !== "heartbeat" || !Array.isArray(r["attention"])) continue;
    for (const a of r["attention"] as unknown[]) out[String(a)] = (out[String(a)] ?? 0) + 1;
  }
  return out;
}

/** The volume of the selected buys in dollars, each at its own day's price; null if any day has none. */
function buysUsd(c: Context): string | null {
  let product = 0n;
  for (const buy of c.buys) {
    if (!c.isSelected(buy.vault)) continue;
    const price = c.priceAt(buy.block);
    if (price === null) return null;
    product += buy.event.amountIn * price;
  }
  return usdOfProduct(product);
}

// ─── Column arithmetic ────────────────────────────────────────────────────────

/** A cell or a log field as a bigint, when it is a whole number of any kind: a bigint, a number or decimal text. */
export function big(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function known(rows: readonly Row[], column: string): bigint[] {
  return rows.map((r) => big(r[column])).filter((v): v is bigint => v !== null);
}

export const sum = (rows: readonly Row[], column: string): bigint => known(rows, column).reduce((a, b) => a + b, 0n);

/** A sum over a column, or null when any of its cells is unknown: a partial sum would pass for the whole. */
export function sumKnown(rows: readonly Row[], column: string): bigint | null {
  return rows.some((r) => r[column] === null) ? null : sum(rows, column);
}

export const median = (rows: readonly Row[], column: string): bigint | null => percentile(known(rows, column), 50);

function min(rows: readonly Row[], column: string): bigint | null {
  const values = known(rows, column);
  return values.length === 0 ? null : values.reduce((a, b) => (b < a ? b : a));
}

function spread(rows: readonly Row[], column: string): { min: bigint | null; median: bigint | null; max: bigint | null } {
  const values = known(rows, column);
  return { min: percentile(values, 0), median: percentile(values, 50), max: percentile(values, 100) };
}

/** The median of decimal texts ("99.3"), compared as numbers; null when there are none. */
function medianText(cells: readonly (Cell | undefined)[]): string | null {
  const values = cells.filter((v): v is string => typeof v === "string").sort((a, b) => Number(a) - Number(b));
  return values.length === 0 ? null : values[Math.ceil(values.length / 2) - 1]!;
}

function countBy(rows: readonly Record<string, unknown>[], column: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = r[column] === null || r[column] === undefined ? "" : String(r[column]);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => cmp(a, b)));
}

/** Σ `column` by `key`, as `[{ [key]: value, [as]: sum }]` in key order. */
function groupSum(rows: readonly Row[], key: string, column: string, as: string): Record<string, unknown>[] {
  const out = new Map<string, bigint>();
  for (const r of rows) out.set(String(r[key]), (out.get(String(r[key])) ?? 0n) + (big(r[column]) ?? 0n));
  return [...out.entries()].sort(([a], [b]) => cmp(a, b)).map(([k, total]) => ({ [key]: k, [as]: total }));
}

function groupCount(rows: readonly Row[], key: string): Record<string, unknown>[] {
  return Object.entries(countBy(rows, key)).map(([k, count]) => ({ [key]: k, count }));
}

const WEI = 10n ** 18n;
const PRICE_DECIMALS = 10n ** 8n;

/** Dollars from Σ wei × answer, so that a sum over days at different prices is rounded once. */
export function usdOfProduct(product: bigint): string {
  const negative = product < 0n;
  const cents = (negative ? -product : product) / (WEI * (PRICE_DECIMALS / 100n));
  const text = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return negative && cents !== 0n ? `-${text}` : text;
}

export const stringField = (value: unknown): string | null => (typeof value === "string" ? value : null);
const negativePart = (v: bigint | null): bigint => (v !== null && v < 0n ? -v : 0n);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
