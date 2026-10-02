/**
 * What the chain says about a recorded transaction: who sent it, what it
 * cost, which block it is in, and what moved.
 *
 * **Which wallet a row belongs to.** A plan's buy records no account (a
 * `DcaRun` has none), and a swap made in this browser could have been made by
 * any wallet connected to it at the time. So every row's account is its first
 * transaction's receipt `from`, read once and kept forever with the fee. A
 * row whose receipt can't be read belongs to no one: it is never credited to
 * whichever wallet happens to be connected, and it stays out of every total.
 *
 * **What moved** is measured, never taken from the quote:
 * - a token sold: its `Transfer` logs from the account;
 * - native ETH sold: the transactions' `value`;
 * - a token bought: its `Transfer` logs to the account;
 * - native ETH bought: the account's balance after, less before, plus the
 *   network fees it paid meanwhile, since ETH arriving from a router leaves
 *   no log.
 * A transaction that reverted moved nothing but its fee, so a partial swap's
 * failed legs count toward the fee and toward nothing else.
 *
 * The receipts are read by lib/receipts.ts, through the person's own network
 * service and nowhere else.
 */

import { TOPICS, isNativeToken } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { quantity, topicAddress, type ChainReceipt } from "../receipts.js";
import type { RecordLeg } from "./types.js";

/** What is kept of a receipt, forever: everything a row needs, and none of the logs. */
export interface TxFacts {
  chainId: number;
  from: Address;
  fee: bigint | null;
  block: bigint;
  blockHash: Hex;
  status: "success" | "reverted";
}

export function factsOf(chainId: number, receipt: ChainReceipt): TxFacts {
  return {
    chainId,
    from: receipt.from,
    fee: receipt.fee,
    block: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status: receipt.status,
  };
}

// ─── Attribution ──────────────────────────────────────────────────────────────

type FactsOf = (hash: string) => TxFacts | null;

/** The wallet that sent a row's first transaction, or null when its receipt hasn't been read. */
export function accountOf(hashes: readonly string[], facts: FactsOf): Address | null {
  const first = hashes[0];
  return first === undefined ? null : (facts(first)?.from ?? null);
}

/** Every transaction's fee, summed; null when any is unknown, since part of a fee is not the fee. */
export function networkFeeOf(hashes: readonly string[], facts: FactsOf): bigint | null {
  if (hashes.length === 0) return null;
  let total = 0n;
  for (const hash of hashes) {
    const fee = facts(hash)?.fee;
    if (fee === null || fee === undefined) return null;
    total += fee;
  }
  return total;
}

/** The block of a row's last transaction (the one that did the trading), or null until read. */
export function blockOf(hashes: readonly string[], facts: FactsOf): bigint | null {
  const last = hashes[hashes.length - 1];
  return last === undefined ? null : (facts(last)?.block ?? null);
}

// ─── Measuring ────────────────────────────────────────────────────────────────

/**
 * Σ `Transfer` of `token` from `from`, or to `to`, over the receipts that
 * succeeded. Null when a receipt is missing: a total over part of a trade is
 * not its total.
 */
export function transferTotal(
  receipts: readonly (ChainReceipt | null)[],
  token: string,
  side: { from: string } | { to: string },
): bigint | null {
  const want = token.toLowerCase();
  const who = ("from" in side ? side.from : side.to).toLowerCase();
  const topicIndex = "from" in side ? 1 : 2;
  let total = 0n;
  for (const receipt of receipts) {
    if (receipt === null) return null;
    if (receipt.status !== "success") continue;
    for (const log of receipt.logs) {
      const topic = log.topics[topicIndex];
      if (log.address !== want || log.topics[0] !== TOPICS.transfer || topic === undefined || topicAddress(topic) !== who) continue;
      const amount = quantity(log.data === "0x" ? "0x0" : log.data);
      if (amount === null) return null;
      total += amount;
    }
  }
  return total;
}

export interface SwapMeasureInput {
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** One per transaction of the swap, approvals included; null where the receipt couldn't be read. */
  receipts: readonly (ChainReceipt | null)[];
  /** Each transaction's `value`, parallel to `receipts`: needed when native ETH was sold. */
  values?: readonly (bigint | null)[];
  /** The account's ETH before the swap and after it: needed when native ETH was bought. */
  ethBalance?: { before: bigint; after: bigint } | null;
}

/** What a swap sold and bought, measured; an amount that can't be measured is null, never a quote. */
export function measureSwap(input: SwapMeasureInput): { sold: RecordLeg; bought: RecordLeg } {
  const { receipts, account } = input;
  const unread = receipts.some((r) => r === null);

  let sold: bigint | null = null;
  if (!unread) {
    if (isNativeToken(input.tokenIn)) {
      const values = input.values ?? [];
      let total = 0n;
      let known = values.length === receipts.length;
      receipts.forEach((receipt, i) => {
        const value = values[i];
        if (value === null || value === undefined) known = false;
        else if (receipt!.status === "success") total += value;
      });
      sold = known ? total : null;
    } else {
      sold = transferTotal(receipts, input.tokenIn, { from: account });
    }
  }

  let bought: bigint | null = null;
  if (!unread) {
    if (isNativeToken(input.tokenOut)) {
      const balance = input.ethBalance ?? null;
      let fees: bigint | null = 0n;
      for (const receipt of receipts) fees = fees === null || receipt!.fee === null ? null : fees + receipt!.fee;
      const delivered = balance === null || fees === null ? null : balance.after - balance.before + fees;
      bought = delivered !== null && delivered > 0n ? delivered : null;
    } else {
      bought = transferTotal(receipts, input.tokenOut, { to: account });
    }
  }

  // A swap that moved nothing measurable has nothing measured to say: zero
  // from logs that did get read is still zero, but only if they were read.
  return {
    sold: { token: input.tokenIn, amount: sold, measured: sold !== null },
    bought: { token: input.tokenOut, amount: bought, measured: bought !== null },
  };
}

// ─── Reading many ─────────────────────────────────────────────────────────────

/**
 * `run` over `items`, at most `limit` at a time, in order of starting.
 *
 * The first read of a long record can be hundreds of receipts, and firing
 * them all at once is how a network service's rate limit is met.
 */
export async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
