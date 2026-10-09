/**
 * The transaction in flight, from the moment it is signed until it is
 * settled: its receipt and confirmations, a rebroadcast, its abandonment when
 * its nonce is used or it expires, and the hashes it left behind; then what a
 * mined batch did — each vault's progress, each refusal's consequence, the
 * loss booked against the subsidy it was planned as — and the loss ledger
 * the next batch is planned against.
 *
 * It never plans a batch. When a transaction has waited out its resend
 * interval, `settlePending` says "resend-due" and `keeper.ts`, which plans,
 * rebuilds it; so the dependency runs one way, from the tick down to here.
 * Signing goes through `keeper-send.ts`'s nonce manager, as every
 * transaction's does.
 */

import type { Address, Hex } from "@spdex/core";
import type { PreparedFees, PreparedTransaction } from "@spdex/chain";
import type { Deployment } from "./artifacts.js";
import { provenBy } from "./index.js";
import { RATIO_ONE, earliestBuyAt, resendIntervalBlocks, turnEndsAtOf, windowOf } from "./keeper-plan.js";
import { blockAt, communityWindowOf, holdersFirstUntil, mayBePaidInWindow, retire } from "./keeper-read.js";
import {
  decodeBatchReceipt,
  gasPerVaultOf,
  isConfirmed,
  readReceipt,
  receiptOfAny,
  signRecordSend,
  type RpcReceipt,
} from "./keeper-send.js";
import type { PendingAttempt, PendingTx, Subsidy, VaultEntry } from "./keeper-state.js";
import type { Tick } from "./keeper.js";

/** An abandoned hash is polled for this many blocks (about a day), every `ORPHAN_POLL_BLOCKS`. */
const ORPHAN_BLOCKS = 7_200n;
const ORPHAN_POLL_BLOCKS = 25n;
const RECEIPT_POLL_MS = 1_000;
export const SECONDS_PER_BLOCK = 12n;
const DAY = 86_400n;

/** Sign, record and send one of the keeper's transactions, through the nonce manager. */
export function send(t: Tick, pending: PendingTx, tx: PreparedTransaction, kind: PendingAttempt["kind"]) {
  return signRecordSend({ sendRpc: t.sendRpc, config: t.config, state: t.state, pending, tx, kind, sentBlock: t.block, persist: t.persist });
}

// ─── Following it ─────────────────────────────────────────────────────────────

/**
 * Follow the pending transaction: a confirmed receipt of any
 * attempt settles it; a nonce used by something else, for long enough that a
 * lagging endpoint would have shown our receipt, abandons it; otherwise the
 * latest attempt is broadcast again (a restart, or a pool that dropped it),
 * and once its resend interval has passed, "resend-due": the caller rebuilds
 * it from fresh reads at the same nonce — replaced, cancelled, or left to
 * expire.
 */
export async function settlePending(t: Tick, p: PendingTx): Promise<"resend-due" | null> {
  if ((await checkReceipt(t, t.block)) !== "none") return null;
  const latest = Number(BigInt((await t.rpc("eth_getTransactionCount", [t.keeper, "latest"])) as string));
  if (latest > p.nonce) {
    p.consumedSeenAt ??= t.block;
    if (t.block - p.consumedSeenAt + 1n >= BigInt(t.policy.confirmations + 5)) await abandon(t, p, "nonce-consumed", latest);
    else await t.persist();
    return null;
  }
  p.consumedSeenAt = null;

  const last = p.attempts.at(-1)!;
  try {
    await t.sendRpc("eth_sendRawTransaction", [last.raw]);
  } catch {
    // Already known, or refused for a reason the next check will show.
  }
  if (p.stoppedResending) {
    if (t.block - last.sentBlock >= BigInt(t.policy.privateExpiryBlocks)) await abandon(t, p, "expired", latest);
    return null;
  }
  const interval = resendIntervalBlocks(blocksToEarliestWindowEnd(t, p), t.policy);
  return t.block - last.sentBlock < BigInt(interval) ? null : "resend-due";
}

/** Look for a receipt of any attempt; process it once confirmed. "done" when settled, "seen" when waiting for confirmations. */
async function checkReceipt(t: Tick, headNumber: bigint): Promise<"done" | "seen" | "none"> {
  const p = t.state.pending!;
  const found = await receiptOfAny(t.rpc, p.attempts);
  if (found) {
    p.missedReceiptChecks = 0;
    if (isConfirmed(headNumber, found.receipt.blockNumber, t.policy.confirmations)) {
      await finishPending(t, p, found.attempt, found.receipt);
      return "done";
    }
    if (p.receiptBlock !== found.receipt.blockNumber) {
      p.receiptBlock = found.receipt.blockNumber;
      await t.persist();
    }
    return "seen";
  }
  if (p.receiptBlock !== null) {
    // Seen once, gone now: a reorg, or an endpoint behind. Two misses in a row put it back in flight.
    p.missedReceiptChecks += 1;
    if (p.missedReceiptChecks < 2) return "seen";
    p.receiptBlock = null;
    p.missedReceiptChecks = 0;
    await t.persist();
  }
  return "none";
}

/** Wait within this tick for the transaction just sent (`--once`, tests). */
export async function awaitReceipt(t: Tick): Promise<void> {
  for (let waited = 0; waited <= t.waitForReceiptMs && t.state.pending; waited += RECEIPT_POLL_MS) {
    const head = BigInt((await t.rpc("eth_blockNumber", [])) as string);
    if ((await checkReceipt(t, head)) === "done") return;
    await t.sleep(RECEIPT_POLL_MS);
  }
}

/** The receipt of `hash`, waiting up to `waitForReceiptMs` for it; null when it is not mined by then. */
export async function pollReceipt(t: Tick, hash: Hex): Promise<RpcReceipt | null> {
  for (let waited = 0; waited <= t.waitForReceiptMs; waited += RECEIPT_POLL_MS) {
    const receipt = await readReceipt(t.rpc, hash);
    if (receipt) return receipt;
    await t.sleep(RECEIPT_POLL_MS);
  }
  return null;
}

/** Send `tx` as the next attempt of `p`, and say so. */
export async function replaceWith(t: Tick, p: PendingTx, last: PendingAttempt, tx: PreparedTransaction, kind: PendingAttempt["kind"]): Promise<void> {
  const { attempt, refused } = await send(t, p, tx, kind);
  p.resends += 1;
  t.emit({
    type: "batch_replaced",
    batchId: p.batchId,
    nonce: p.nonce,
    oldHash: last.hash,
    newHash: attempt.hash,
    attempt: p.attempts.length,
    why: "not-included",
    maxFeePerGas: maxFeePerGasOf(tx.fees),
    maxPriorityFeePerGas: tipOf(tx.fees),
  });
  if (refused) t.emit({ type: "error", where: "resend", message: `${refused.kind}: ${refused.message}` });
}

/** Give up on the transaction in flight; its hashes are polled for a day in case one lands late. */
async function abandon(t: Tick, p: PendingTx, why: "expired" | "nonce-consumed", latestNonce: number): Promise<void> {
  t.emit({ type: "batch_abandoned", batchId: p.batchId, nonce: p.nonce, hashes: p.attempts.map((a) => a.hash), why });
  for (const a of p.attempts) {
    t.state.orphans.push({
      batchId: p.batchId,
      nonce: p.nonce,
      hash: a.hash,
      kind: a.kind,
      deployment: p.deployment,
      vaults: a.vaults,
      subsidy: a.subsidy,
      untilBlock: t.block + ORPHAN_BLOCKS,
      nextCheckBlock: t.block + ORPHAN_POLL_BLOCKS,
    });
  }
  for (const vault of new Set(p.attempts.flatMap((a) => a.vaults))) if (t.state.vaults[vault]) t.state.vaults[vault]!.readAt = null;
  t.state.pending = null;
  // An expired nonce is used again; a consumed one is past.
  t.state.nextNonce = why === "expired" ? p.nonce : latestNonce;
  await t.persist();
}

/** The hashes an abandoned transaction left: a batch that lands late is processed then. */
export async function pollOrphans(t: Tick): Promise<void> {
  const keep: typeof t.state.orphans = [];
  for (const orphan of t.state.orphans) {
    if (t.block > orphan.untilBlock) continue;
    if (t.block < orphan.nextCheckBlock) {
      keep.push(orphan);
      continue;
    }
    const receipt = await readReceipt(t.rpc, orphan.hash);
    if (receipt && orphan.kind === "batch" && orphan.deployment) {
      const deployment = t.config.deployments.find((d) => d.id === orphan.deployment);
      if (deployment) {
        await processBatchReceipt(t, { batchId: orphan.batchId, nonce: orphan.nonce, vaults: orphan.vaults, subsidy: orphan.subsidy, modelGas: null, attempts: 1, sentBlock: null }, deployment, receipt, true);
      }
      continue;
    }
    if (receipt) continue;
    keep.push({ ...orphan, nextCheckBlock: t.block + ORPHAN_POLL_BLOCKS });
  }
  t.state.orphans = keep;
}

async function finishPending(t: Tick, p: PendingTx, attempt: PendingAttempt, receipt: RpcReceipt): Promise<void> {
  const block = await blockAt(t.rpc, receipt.blockNumber);
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  if (attempt.kind === "batch") {
    const deployment = t.config.deployments.find((d) => d.id === p.deployment);
    if (deployment) {
      // The attempt that was mined, with what it carried: a later rebuild may have carried other vaults.
      await processBatchReceipt(
        t,
        { batchId: p.batchId, nonce: p.nonce, vaults: attempt.vaults, subsidy: attempt.subsidy, modelGas: attempt.modelGas, attempts: p.attempts.length, sentBlock: p.attempts[0]!.sentBlock },
        deployment,
        receipt,
        false,
      );
    }
  } else {
    t.state.spend.push([block.timestamp, costWei]);
    if (attempt.kind === "cancel") {
      bookLoss(t, costWei, []);
      for (const vault of p.vaults) if (t.state.vaults[vault]) t.state.vaults[vault]!.readAt = null;
      t.emit({ type: "batch_cancelled", batchId: p.batchId, nonce: p.nonce, hash: receipt.transactionHash, costWei });
    } else if (attempt.kind === "unwrap") {
      t.emit({ type: "unwrap_mined", batchId: p.batchId, hash: receipt.transactionHash, amountWei: p.amountWei ?? 0n, status: receipt.status === 1n ? "success" : "reverted" });
    } else if (attempt.kind === "deploy") {
      const deployment = t.config.deployments.find((d) => d.id === p.deployment);
      if (deployment && receipt.status === 1n) t.emit({ type: "batcher_deployed", deployment: deployment.id, hash: receipt.transactionHash, address: lower(deployment.batcher) });
    } else if (attempt.kind === "prove") {
      // The registry's own `Proven` says until when; anyone can emit a log shaped like it, so only the registry's counts.
      const registry = t.config.deployments.find((d) => d.id === p.deployment)?.registry ?? null;
      const proven = registry === null ? [] : provenBy(registry, receipt.logs).filter((e) => e.holder === t.rewardTo);
      t.emit({
        type: "prove_mined",
        batchId: p.batchId,
        hash: receipt.transactionHash,
        deployment: p.deployment,
        status: receipt.status === 1n ? "success" : "reverted",
        costWei,
        validUntil: receipt.status === 1n ? (proven.at(-1)?.validUntil ?? null) : null,
      });
      // A proof that passed its own test-run and reverted anyway: no other for a day of this machine's clock, which the
      // endpoint that reported it can't move (`maybeProve`).
      if (receipt.status !== 1n) t.state.proveRevertedAt = BigInt(Math.floor(t.wallClockMs() / 1000));
    }
  }
  t.state.pending = null;
  t.state.nextNonce = p.nonce + 1;
  await t.persist();
}

/**
 * Blocks left before the soonest moment a vault in `p` needs it sent again:
 * its slot's end, or — for a buy this keeper may take inside its community
 * window — the window's urgent point, where it stops waiting patiently. So a
 * patient batch's resend falls due as the window's tail begins (decision 19).
 */
function blocksToEarliestWindowEnd(t: Tick, p: PendingTx): bigint {
  const ends = p.vaults
    .map((vault) => t.state.vaults[vault])
    .filter((e): e is VaultEntry => e !== undefined)
    .map((e) => {
      const slotEnd = windowOf(e.terms, t.chainTime).windowEnd;
      const community = communityWindowOf(e, t.chainTime);
      const patient = community !== null && t.chainTime < community.urgentAt && mayBePaidInWindow(t, e);
      return patient && community.urgentAt < slotEnd ? community.urgentAt : slotEnd;
    });
  if (ends.length === 0) return BigInt(t.policy.resendAfterBlocks) * 3n;
  const soonest = ends.reduce((a, b) => (b < a ? b : a));
  return soonest > t.chainTime ? (soonest - t.chainTime) / SECONDS_PER_BLOCK : 0n;
}

// ─── What a mined batch did ───────────────────────────────────────────────────

/**
 * A mined batch: each bought vault's progress, each refusal's
 * consequence, the fee earned (never the stray WETH swept), the cost, the loss
 * booked against the subsidy it was planned as, and the gas model calibrated.
 */
async function processBatchReceipt(
  t: Tick,
  sent: { batchId: string; nonce: number; vaults: Address[]; subsidy: Subsidy[]; modelGas: bigint | null; attempts: number; sentBlock: bigint | null },
  deployment: Deployment,
  receipt: RpcReceipt,
  late: boolean,
): Promise<void> {
  const { state } = t;
  const block = await blockAt(t.rpc, receipt.blockNumber);
  const mined = decodeBatchReceipt({
    receipt,
    batcher: lower(deployment.batcher),
    vaults: sent.vaults,
    clockOf: (vault) => state.vaults[vault]?.terms ?? null,
    blockTime: block.timestamp,
    batchId: sent.batchId,
    nonce: sent.nonce,
    late,
  });
  state.spend.push([block.timestamp, mined.costWei]);

  for (const b of mined.bought) {
    const e = state.vaults[b.vault];
    if (!e) continue;
    e.buysDone = b.buyNumber > e.buysDone ? b.buyNumber : e.buysDone;
    e.lastBuyAt = block.timestamp;
    if (e.balance !== null) e.balance = e.balance > b.amountIn + b.reward ? e.balance - b.amountIn - b.reward : 0n;
    e.paidRefusals = null;
    if (e.lastSkip) {
      t.emit({ type: "skip_cleared", vault: b.vault, slot: b.slot, code: e.lastSkip.code, seconds: block.timestamp - e.lastSkip.since });
      e.lastSkip = null;
    }
    if (earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt) === null) retire(t, b.vault, "done");
  }
  const cap = gasPerVaultOf(t.config, deployment);
  for (const r of mined.refused) onChainRefusal(t, r.vault, r.reasonName, r.gasUsed, receipt.transactionHash, lower(deployment.batcher), cap);
  if (mined.status === "reverted") for (const vault of sent.vaults) if (state.vaults[vault]) state.vaults[vault]!.readAt = null;
  if (mined.notTried.length > 0) t.emit({ type: "error", where: "batch", message: `${mined.notTried.length} vault(s) were not tried: the gas limit was too low` });

  if (mined.netWei < 0n) bookLoss(t, -mined.netWei, sent.subsidy);
  if (mined.status === "success" && sent.modelGas !== null && sent.modelGas > 0n) {
    // ratio = max(1, 0.8·ratio + 0.2·used/model), in parts per million; never below the constants.
    const observed = (receipt.gasUsed * RATIO_ONE) / sent.modelGas;
    const ratioPpm = (8n * state.gasModel.ratioPpm + 2n * observed) / 10n;
    state.gasModel = { ratioPpm: ratioPpm > RATIO_ONE ? ratioPpm : RATIO_ONE, samples: state.gasModel.samples + 1 };
  }
  if (mined.status === "success") state.lastBatch = { hash: receipt.transactionHash, at: block.timestamp };

  t.emit({
    type: "batch_mined",
    batchId: mined.batchId,
    hash: mined.hash,
    nonce: mined.nonce,
    block: mined.block,
    status: mined.status,
    late,
    gasUsed: mined.gasUsed,
    effectiveGasPrice: mined.effectiveGasPrice,
    priorityFeeWei: block.baseFee === null ? null : mined.gasUsed * (mined.effectiveGasPrice > block.baseFee ? mined.effectiveGasPrice - block.baseFee : 0n),
    costWei: mined.costWei,
    earnedWei: mined.earnedWei,
    sweptWei: mined.sweptWei,
    netWei: mined.netWei,
    sentBlock: sent.sentBlock,
    inclusionBlocks: sent.sentBlock === null ? null : mined.block - sent.sentBlock,
    attempts: sent.attempts,
    listed: mined.listed,
    tried: mined.tried,
    bought: mined.bought,
    refused: mined.refused,
    notTried: mined.notTried,
  });
  t.result.mined.push(mined);
}

/**
 * What a refusal inside a mined batch means. Someone else got
 * there: read it again. The price or the oracle: a paid refusal, rested for
 * `refusalRetrySeconds`, and for the rest of the window after
 * `maxPaidRefusalsPerWindow`. A revert with no reason that burned at least
 * half the gas the batch gave it (`cap`): what a trap does, so trapped for a
 * week, on the chain's evidence only. `NotEligible`: this keeper's `rewardTo`
 * was not eligible when the buy landed, after all (its SPX moved, its proof
 * lapsed, or the buy landed in the next slot's window), so rested until that
 * community window ends, when anyone may make it; `NotYourTurn`: eligible, but
 * the buy landed inside another bucket's turn, so rested until the turn ends;
 * neither is ever a trap or a paid refusal. Anything else: rested until the
 * next window.
 */
function onChainRefusal(t: Tick, vault: Address, name: string | null, gasUsed: bigint, txHash: Hex, batcher: Address, cap: bigint): void {
  const e = t.state.vaults[vault];
  if (!e) return;
  const window = windowOf(e.terms, t.chainTime);
  switch (name) {
    case "TooSoon":
    case "VaultClosed":
    case "NoBuysLeft":
      e.readAt = null;
      t.emit({ type: "overtaken", vault, slot: window.slot });
      return;
    case "PriceBelowFloor":
    case "OracleTooThin": {
      const count = e.paidRefusals?.slot === window.slot ? e.paidRefusals.count + 1 : 1;
      e.paidRefusals = { slot: window.slot, count };
      e.restingUntil = count >= t.policy.maxPaidRefusalsPerWindow ? window.windowEnd : t.chainTime + t.policy.refusalRetrySeconds;
      return;
    }
    case "NotEligible":
      e.restingUntil = holdersFirstUntil(e, t.chainTime) ?? communityWindowOf(e, t.chainTime)?.endsAt ?? window.windowEnd;
      return;
    case "NotYourTurn": {
      const turnEnds = turnEndsAtOf(e.terms, e.buysDone, e.lastBuyAt, t.chainTime);
      e.restingUntil = turnEnds !== null && turnEnds > t.chainTime ? turnEnds : (communityWindowOf(e, t.chainTime)?.endsAt ?? window.windowEnd);
      return;
    }
    case "EmptyRevert":
      if (gasUsed * 2n >= cap) {
        t.state.trapped[vault] = { since: t.chainTime, txHash, batcher, cap, slot: window.slot };
        t.emit({ type: "trapped", vault, txHash, gasUsed });
        return;
      }
      e.restingUntil = window.windowEnd;
      return;
    default:
      e.restingUntil = window.windowEnd;
  }
}

// ─── Losses ───────────────────────────────────────────────────────────────────

/**
 * A realised loss, for the daily breaker and the subsidy caps: booked against
 * the vaults and owners whose subsidy was planned, in proportion, or against
 * nobody when none was (the model was wrong).
 */
function bookLoss(t: Tick, lossWei: bigint, subsidy: readonly Subsidy[]): void {
  const total = subsidy.reduce((sum, s) => sum + s.wei, 0n);
  if (total === 0n) {
    t.state.lossLedger.push({ at: t.chainTime, lossWei, vault: null, owner: null });
    return;
  }
  for (const s of subsidy) t.state.lossLedger.push({ at: t.chainTime, lossWei: (lossWei * s.wei) / total, vault: s.vault, owner: s.owner });
}

/** The last 24 hours' losses booked to each vault, or to each owner. */
export function subsidisedBy(t: Tick, key: "vault" | "owner"): Map<Address, bigint> {
  const out = new Map<Address, bigint>();
  for (const l of t.state.lossLedger) {
    const who = l[key];
    if (who && l.at > t.chainTime - DAY) out.set(who, (out.get(who) ?? 0n) + l.lossWei);
  }
  return out;
}

/**
 * What is left of the day's loss budget. At the cap the breaker opens: no
 * subsidy, and a doubled fee margin, until the day's losses age out — whatever
 * the policy, since losses beyond the plan are the model being wrong.
 */
export function dailyLossLeft(t: Tick): bigint {
  const { state, policy } = t;
  state.lossLedger = state.lossLedger.filter((l) => l.at > t.chainTime - DAY);
  const lost = state.lossLedger.reduce((sum, l) => sum + l.lossWei, 0n);
  if (lost >= policy.maxLossPerDay) {
    if (!state.breakerOpen) {
      state.breakerOpen = true;
      t.emit({ type: "subsidy_exhausted", lossWei24h: lost, capWei: policy.maxLossPerDay });
    }
    return 0n;
  }
  state.breakerOpen = false;
  return policy.maxLossPerDay - lost;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

export const maxFeePerGasOf = (fees: PreparedFees): bigint => (fees.type === "legacy" ? fees.gasPrice : fees.maxFeePerGas);
export const tipOf = (fees: PreparedFees): bigint => (fees.type === "legacy" ? fees.gasPrice : fees.maxPriorityFeePerGas);

const lower = (a: string): Address => a.toLowerCase() as Address;
