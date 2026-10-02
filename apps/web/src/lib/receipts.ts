/**
 * A transaction's receipt, its value and its block's time, read through the
 * person's own network service, and the JSON-RPC quantities they are written
 * in. One reader for everything that asks: Your activity, the `#receipt=`
 * view, Help run's batch result and the finality badge.
 */

import type { JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";

/**
 * A JSON-RPC quantity as a number: exactly "0x" and 1 to 64 hex digits, as
 * nodes write block numbers, fees, balances and 32-byte words. Anything else,
 * a number, a decimal string, a bare "0x" or more than 256 bits, is null, and
 * the caller says what an unreadable figure means.
 */
export function quantity(value: unknown): bigint | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value) ? BigInt(value) : null;
}

/** The address in a log topic's last 20 bytes, lowercase. */
export const topicAddress = (topic: string): Address => `0x${topic.slice(-40)}`.toLowerCase() as Address;

/** A log as a receipt gives it: address and topics lowercase. */
export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
  /** Its position in its block, when the receipt says; the batcher's events are joined by it. */
  logIndex?: string;
}

/** A transaction as its receipt describes it. */
export interface ChainReceipt {
  hash: Hex;
  from: Address;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  /** Gas used times the price paid, in wei; null when the receipt doesn't say. */
  fee: bigint | null;
  logs: readonly ReceiptLog[];
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A transaction's receipt, or null when the network service doesn't know it
 * (not mined, or dropped). Throws when the read itself fails, and on an answer
 * that isn't a receipt: that is an endpoint to distrust, not a transaction
 * that never happened.
 */
export async function readReceipt(rpc: JsonRpc, hash: Hex): Promise<ChainReceipt | null> {
  const raw = (await rpc("eth_getTransactionReceipt", [hash])) as Record<string, unknown> | null;
  if (raw === null || raw === undefined) return null;
  const from = raw["from"];
  const blockNumber = quantity(raw["blockNumber"]);
  const blockHash = raw["blockHash"];
  if (typeof from !== "string" || !ADDRESS.test(from) || blockNumber === null) {
    throw new Error(`the receipt for ${hash} isn't one spDEX can read`);
  }
  if (typeof blockHash !== "string" || !HASH.test(blockHash)) throw new Error(`the receipt for ${hash} names no block`);
  const gasUsed = quantity(raw["gasUsed"]);
  const price = quantity(raw["effectiveGasPrice"]);
  const status = quantity(raw["status"]);
  const logs = Array.isArray(raw["logs"]) ? (raw["logs"] as unknown[]) : [];
  return {
    hash: hash.toLowerCase() as Hex,
    from: from.toLowerCase() as Address,
    // No status field predates Byzantium; read as success, as confirmTransaction does.
    status: status === 0n ? "reverted" : "success",
    blockNumber,
    blockHash: blockHash.toLowerCase() as Hex,
    fee: gasUsed === null || price === null ? null : gasUsed * price,
    logs: logs.flatMap((log) => {
      if (typeof log !== "object" || log === null) return [];
      const { address, topics, data, logIndex } = log as Record<string, unknown>;
      if (typeof address !== "string" || !Array.isArray(topics) || typeof data !== "string") return [];
      return [
        {
          address: address.toLowerCase(),
          topics: topics.map((t) => String(t).toLowerCase()),
          data,
          ...(typeof logIndex === "string" ? { logIndex } : {}),
        },
      ];
    }),
  };
}

/** A transaction's `value`, in wei, or null when the network service doesn't know it. */
export async function readTxValue(rpc: JsonRpc, hash: Hex): Promise<bigint | null> {
  const raw = (await rpc("eth_getTransactionByHash", [hash])) as Record<string, unknown> | null;
  if (raw === null || raw === undefined) return null;
  return quantity(raw["value"]);
}

/** A block's timestamp, in unix seconds, or null when the network service doesn't have the block. */
export async function readBlockTime(rpc: JsonRpc, block: bigint): Promise<number | null> {
  const raw = (await rpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, false])) as Record<string, unknown> | null;
  const time = quantity(raw?.["timestamp"]);
  return time === null || time > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(time);
}
