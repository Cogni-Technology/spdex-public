/**
 * One line of someone's activity: a swap, a tip, or a buy made by one of
 * their plans. Your activity lists these, the CSV and the printable statement
 * are made from them, and Your stack and the "I bought" card read them.
 *
 * Fixed first, so those could be built while the records themselves were;
 * from here the shape only grows. A fifth kind, "buy-fees-earned", came
 * later, and code that branches on `kind` still gives a kind it
 * doesn't know a neutral treatment rather than assuming these are all there is.
 *
 * Every figure follows the rule the whole app does: null is unknown, never
 * zero. A blank cell is honest, and a 0 in a record someone keeps for their
 * taxes is not. Zero appears only where zero is known, as the network fee of
 * a vault buy a keeper triggered, which the owner didn't pay.
 */

import type { Address, Hex } from "@spdex/core";
import type { FxSnapshot } from "../money/pricing.js";

/**
 * - `swap`: a One-time swap made in this browser.
 * - `tip`: a tip sent with a swap.
 * - `plan-buy`: a buy of a plan the person confirms themselves (this browser's ledger).
 * - `vault-buy`: a buy made by one of their vaults, read from the chain.
 * - `buy-fees-earned`: a batch of due buys this wallet made for other
 *   people's vaults (Help run the network), once settled. `bought` is the
 *   WETH the batch paid it in buy fees, from the receipt's `Batch` event;
 *   `sold` is WETH, a known 0, since nothing was sold; `networkFee` is what
 *   the batch cost; `buyFee` is 0n. It is not a buy of SPX: nothing that
 *   counts buys or totals what was put in counts it.
 */
export type RecordKind = "swap" | "tip" | "plan-buy" | "vault-buy" | "buy-fees-earned";

/**
 * Where a row's value at the time came from:
 * - `twap-seen`: the 10-minute average this browser held when it saw the trade settle;
 * - `chainlink-at-block`: Chainlink's answers at the trade's block, read when the person asked.
 */
export type RecordValueSource = "twap-seen" | "chainlink-at-block";

/** One side of a trade. */
export interface RecordLeg {
  token: Address;
  /** In the token's base units; null when unknown. */
  amount: bigint | null;
  /** True when the amount was read from the chain (Transfer logs, or the transaction's value), not taken from a quote. */
  measured: boolean;
}

export interface RecordRow {
  /** Unique in a list and the same after a reload, so it can key a React list and a card. */
  id: string;
  kind: RecordKind;
  chainId: number;
  /**
   * The wallet that made it: the first transaction's receipt `from`. Null
   * when that couldn't be read, and such a row is left out of every total
   * rather than credited to whichever wallet is connected.
   */
  account: Address | null;
  /** Block time once read, or this device's time when it was recorded; `source` says which. */
  at: { unix: number; source: "block" | "device" };
  /** Null until read. */
  block: bigint | null;
  /** The transactions, in the order they were sent. */
  hashes: Hex[];
  sold: RecordLeg;
  bought: RecordLeg;
  /**
   * A vault buy's fee (`Bought.reward`), in wei. 0n for kinds that pay none,
   * and for a vault buy the owner triggered themselves, since the fee came
   * back to them; null when it couldn't be read.
   */
  buyFee: bigint | null;
  /**
   * Gas used times the price paid, summed over `hashes`, in wei. 0n for a
   * vault buy a keeper triggered, since the owner paid none; null when a
   * receipt couldn't be read.
   */
  networkFee: bigint | null;
  /** What the sold side was worth at the time, in millionths of a US dollar; null when unknown. */
  valueUsd: bigint | null;
  /**
   * Every FX answer held at the time, so the value in any currency can be
   * shown later, whichever currency is chosen by then. Null when none was held.
   */
  rates: FxSnapshot | null;
  /** Null exactly when `valueUsd` is. */
  valueSource: RecordValueSource | null;
  /** For plan and vault buys. */
  planId?: string;
  planLabel?: string;
  /** "Buy 23 of 69". */
  buyIndex?: { n: number; of: number };
}
