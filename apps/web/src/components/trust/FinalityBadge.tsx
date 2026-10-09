/**
 * Included → Final: how settled one transaction is, as the person's
 * network service reports it. The rules are in lib/finality.ts.
 *
 * Carries the test id `finality-badge` unless given another, and `data-state`
 * set to one of `sent | included | final | unknown | replaced | gave-up`, so
 * a test can wait on the state rather than on words that change.
 *
 * Every state has a marker shape of its own as well as a fill, so none
 * depends on colour to be read.
 */

import type { JSX } from "react";
import { Term } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Hex } from "@spdex/core";
import { explorerUrl } from "../../lib/dca/view.js";
import { FINAL_TIP, INCLUDED_TIP, finalityText, useFinality } from "../../lib/finality.js";
import "../records/records.css";

export interface FinalityBadgeProps {
  /** The person's own network service: the badge believes its answer about which block is finalized. */
  rpc: JsonRpc;
  chainId: number;
  hash: Hex;
  testId?: string;
}

export function FinalityBadge({ rpc, chainId, hash, testId }: FinalityBadgeProps): JSX.Element {
  const view = useFinality(rpc, hash);
  const text = finalityText(view);
  // Given up: the one thing left to offer is where to look it up yourself.
  const explorer = view.state === "gave-up" ? explorerUrl(chainId, hash) : null;
  return (
    <span className={`spdex-final spdex-final--${view.state}`} data-testid={testId ?? "finality-badge"} data-state={view.state} role="status">
      <span className="spdex-final__text">
        {view.state === "final" ? (
          <Term tip={FINAL_TIP}>{text}</Term>
        ) : view.state === "included" ? (
          <Term tip={INCLUDED_TIP}>{text}</Term>
        ) : (
          text
        )}
        {explorer !== null ? (
          <>
            {" "}
            <a href={explorer} target="_blank" rel="noreferrer noopener">
              Explorer ↗
            </a>
          </>
        ) : null}
      </span>
    </span>
  );
}
