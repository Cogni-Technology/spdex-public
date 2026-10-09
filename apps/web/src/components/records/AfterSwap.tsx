/**
 * What a One-time swap leaves under "Swap complete": its last transaction's
 * finality badge and hash (which copies it), "You received …" once its
 * receipts say what arrived, and a card when that was SPX.
 *
 * `useAfterSwap` holds it for the page, keeps each swap that moved money in
 * this browser's record (`recordSwap`), and counts them (`settled`), so the
 * balances the page shows are read again.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import { Button } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Hex } from "@spdex/core";
import { canCard } from "../../lib/culture/stack.js";
import { recordSwap, type RecordSwapInput } from "../../lib/records/store.js";
import type { RecordRow } from "../../lib/records/types.js";
import { formatAmount, TOKEN_LIST } from "../../lib/tokens.js";
import { TxRef } from "../dca/common.js";
import { FinalityBadge } from "../trust/FinalityBadge.js";

/** The last swap's transaction, and once its receipt is read, what it measurably delivered (`recordSwap`). */
export interface SwapLeft {
  hash: Hex;
  row: RecordRow | null;
}

export interface AfterSwapState {
  shown: SwapLeft | null;
  /** How many swaps moved money this visit, whole or in part. */
  settled: number;
  /** A new quote or swap began: what the last one left goes. */
  clear(): void;
  /**
   * A swap moved money, whole or stopped part-way: it goes into this
   * browser's record, with what its receipts say arrived, without holding up
   * the status line. A whole one's last transaction is shown at once, and
   * what it delivered once its record comes back, if it is still the swap on
   * screen.
   */
  moved(swap: RecordSwapInput): void;
}

export function useAfterSwap(): AfterSwapState {
  const [shown, setShown] = useState<SwapLeft | null>(null);
  const [settled, setSettled] = useState(0);
  const clear = useCallback(() => setShown(null), []);
  const moved = useCallback((swap: RecordSwapInput) => {
    const hashes = "partial" in swap.result ? [] : swap.result.hashes;
    const last = hashes[hashes.length - 1];
    if (last !== undefined) setShown({ hash: last, row: null });
    setSettled((n) => n + 1);
    void recordSwap(swap).then((recorded) => {
      if (recorded === null || last === undefined) return;
      setShown((current) => (current?.hash === last ? { hash: last, row: recorded.row } : current));
    });
  }, []);
  return useMemo(() => ({ shown, settled, clear, moved }), [shown, settled, clear, moved]);
}

/** What the receipts say arrived, when they measured it in a token spDEX lists. */
function receivedOf(left: SwapLeft | null): { amount: bigint; decimals: number; symbol: string } | null {
  const bought = left?.row?.bought ?? null;
  if (bought === null || !bought.measured || bought.amount === null) return null;
  const token = TOKEN_LIST.find((t) => t.address.toLowerCase() === bought.token.toLowerCase());
  return token === undefined ? null : { amount: bought.amount, decimals: token.decimals, symbol: token.symbol };
}

/**
 * The status line as shown: once "You received …" is read from the receipts,
 * the quote's "… expected" in the line above it says the same thing less
 * exactly, so it goes.
 */
export function statusAfterSwap(status: string | null, left: SwapLeft | null): string | null {
  return status !== null && receivedOf(left) !== null ? status.replace(/^Swap complete — .*? expected/, "Swap complete") : status;
}

/** "You received …" from what the receipts measured, never the quote's expectation, and a card when it was SPX. */
export function AfterSwap({
  left,
  rpc,
  chainId,
  onMakeCard,
}: {
  left: SwapLeft;
  rpc: JsonRpc;
  chainId: number;
  onMakeCard(row: RecordRow): void;
}): JSX.Element {
  const received = receivedOf(left);
  const row = left.row;
  return (
    <div className="spdex-after-swap" data-testid="after-swap">
      <div className="spdex-after-swap__tx">
        <FinalityBadge rpc={rpc} chainId={chainId} hash={left.hash} />
        <TxRef chainId={chainId} hash={left.hash} testId="after-swap-tx" />
      </div>
      {received !== null ? (
        <p className="spdex-status" data-testid="after-swap-received">
          You received {formatAmount(received.amount, received.decimals)} {received.symbol}.
        </p>
      ) : null}
      {row !== null && canCard(row) ? (
        <div className="spdex-actions">
          <Button variant="ghost" testId="make-card" onClick={() => onMakeCard(row)}>
            Make a card
          </Button>
        </div>
      ) : null}
    </div>
  );
}
