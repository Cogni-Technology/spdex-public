/**
 * The two halves of the panel contract (lib/tiles.ts, `TilePanelProps`) that
 * every panel able to sit in a tile needs: reporting its header summary, and
 * knowing when it was first opened.
 *
 * Kept beside the auto-buy components because most of the panels are theirs;
 * Welcome, Your SPX, Markets and the network panels use it too.
 */

import { useEffect, useRef, useState } from "react";
import type { TileSummary } from "../../lib/tiles.js";

/**
 * Hands `summary` to `onSummary` from an effect, on mount and whenever its
 * words or pill change. An empty `text` says "nothing to add", so a part that
 * had something to say (a due buy) can take it back. The callback may be a
 * new function on every render; only the summary itself triggers a report.
 */
export function useTileSummary(onSummary: ((summary: TileSummary) => void) | undefined, summary: TileSummary): void {
  const report = useRef(onSummary);
  report.current = onSummary;
  const { text, status } = summary;
  useEffect(() => {
    report.current?.(status === undefined ? { text } : { text, status });
  }, [text, status]);
}

/**
 * True from the first render where `open` is true, and ever after: a panel in
 * a tile starts its reads then, and keeps what it read when the tile closes.
 * Undefined (a panel outside the tiles) is never "opened" here; such a panel
 * keeps its own fold.
 */
export function useOpenedOnce(open: boolean | undefined): boolean {
  const [opened, setOpened] = useState(open === true);
  if (open === true && !opened) setOpened(true);
  return opened || open === true;
}
