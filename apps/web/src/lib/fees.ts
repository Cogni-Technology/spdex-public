/**
 * What spDEX bids for gas, and what its fee lines say.
 *
 * A transaction pays the block's base fee, which the protocol sets, and a
 * tip, which the sender chooses and the block builder keeps. Nobody else
 * chooses the tip well for a person: an endpoint's `eth_maxPriorityFeePerGas`
 * may say 1 wei (Alchemy's does), which a builder may leave waiting, and a
 * wallet's own fee service may say far more than blocks are taking. On
 * 2026-10-01 MetaMask's "Market" bid 1.7 gwei over a 0.1 gwei base fee, for a
 * $6.90 swap that blocks were including for 0.05 gwei: $0.87 instead of
 * $0.07, against the $0.04 the quote had said.
 *
 * So the tip is what recent blocks took: the median, over the last
 * `TIP_BLOCKS` blocks, of the tip paid by each block's middle transaction,
 * kept between `MIN_TIP` and `MAX_TIP`. The ceiling is there because the
 * figure comes from the endpoint, and a tip is paid in full: an endpoint that
 * lies can delay a transaction by saying too little, but can't make a person
 * pay more than the ceiling by saying too much. Every wallet send suggests it
 * (lib/submit.ts), private sends sign with it, and every fee line on the page
 * is worked out from it, so what the page says is what the wallet asks.
 */

import type { PreparedFees } from "@spdex/chain";
import type { ReadRpc } from "./wallet.js";

/** The least tip spDEX bids, wei per gas: 0.05 gwei. */
export const MIN_TIP = 50_000_000n;

/** The most: 0.5 gwei, the keeper's own ceiling (`DEFAULT_KEEPER_POLICY.maxTip`). */
export const MAX_TIP = 500_000_000n;

/** How many recent blocks the tip is read from. */
export const TIP_BLOCKS = 10;

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`could not read ${what}: the endpoint returned ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/**
 * The tip to bid: the median of the last `TIP_BLOCKS` blocks' middle tips,
 * between `MIN_TIP` and `MAX_TIP`. `MIN_TIP` when the endpoint can't say
 * (no `eth_feeHistory`, or no rewards in its answer).
 */
export async function suggestedTip(read: ReadRpc): Promise<bigint> {
  let tips: bigint[];
  try {
    const history = (await read("eth_feeHistory", [`0x${TIP_BLOCKS.toString(16)}`, "latest", [50]])) as { reward?: unknown } | null;
    const rewards = Array.isArray(history?.reward) ? history.reward : [];
    tips = rewards.map((row) => quantity(Array.isArray(row) ? row[0] : undefined, "a block's tip"));
  } catch {
    return MIN_TIP;
  }
  if (tips.length === 0) return MIN_TIP;
  tips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = tips[Math.floor(tips.length / 2)]!;
  return median < MIN_TIP ? MIN_TIP : median > MAX_TIP ? MAX_TIP : median;
}

/**
 * The fees a wallet is asked to bid: twice the latest base fee and the
 * suggested tip as the most per gas (room for the base fee to rise for
 * several blocks; what isn't used is never charged), and the tip. On a chain
 * with no base fee, the endpoint's gas price. `feePerGasNow` (lib/dca/vault.ts)
 * turns either into what a block would charge now.
 */
export async function readWalletFees(read: ReadRpc): Promise<PreparedFees> {
  const [block, tip] = await Promise.all([read("eth_getBlockByNumber", ["latest", false]), suggestedTip(read)]);
  const baseFee = (block as { baseFeePerGas?: unknown } | null)?.baseFeePerGas;
  if (baseFee === undefined || baseFee === null) {
    return { type: "legacy", gasPrice: quantity(await read("eth_gasPrice", []), "the gas price") };
  }
  const base = quantity(baseFee, "the base fee");
  return { type: "eip1559", maxFeePerGas: 2n * base + tip, maxPriorityFeePerGas: tip };
}

/** How many recent blocks "the last few hours" means for the fee level: 1,024, about 3.4 hours. */
export const FEE_LEVEL_BLOCKS = 1024;

/**
 * The base fee the next block charges, and its median over the last
 * `FEE_LEVEL_BLOCKS` blocks: what "high right now" is measured against
 * (`highFeeNote`, lib/summary.ts). Null when the endpoint can't say, so a
 * comparison nobody can make is never shown.
 */
export async function readFeeLevel(read: ReadRpc): Promise<{ base: bigint; usual: bigint } | null> {
  try {
    const history = (await read("eth_feeHistory", [`0x${FEE_LEVEL_BLOCKS.toString(16)}`, "latest", []])) as {
      baseFeePerGas?: unknown;
    } | null;
    const fees = Array.isArray(history?.baseFeePerGas) ? history.baseFeePerGas.map((fee) => quantity(fee, "a base fee")) : [];
    // One more than the blocks asked for: the last is the next block's.
    if (fees.length < 2) return null;
    const base = fees[fees.length - 1]!;
    const past = fees.slice(0, -1).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { base, usual: past[Math.floor(past.length / 2)]! };
  } catch {
    return null;
  }
}
