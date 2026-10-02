/**
 * A plan's history: every buy time this browser saw, and every transfer to or
 * from its spending wallet, newest first.
 *
 * The sentences come from lib/dca/view.ts, which knows every code the runner
 * and the Guard can write. Rows are numbered only when something was bought,
 * and each keeps a test id that doesn't shift as newer rows arrive
 * (`dca-run-{seq}`, counted from the oldest kept).
 *
 * Simple shows the newest five, the transaction that did the buying, and
 * amounts to six significant digits like every other screen (each row's
 * exact figures are its tooltip); Expert shows every row with every digit,
 * every transaction (the permission, then the buy) and every Guard code
 * behind a skip.
 */

import { useState } from "react";
import { Disclosure } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { DcaPlan, Hex } from "@spdex/core";
import type { DcaLedgerEntry } from "../../lib/dca/ledger.js";
import { historyRows } from "../../lib/dca/view.js";
import { FinalityBadge } from "../trust/FinalityBadge.js";
import { TxRef } from "./common.js";

const SIMPLE_ROWS = 5;
/** A buy younger than a day shows how settled it is; an older one has long been final. */
const BADGE_MAX_AGE_MS = 86_400_000;

/**
 * The newest row's buy transaction, when that row is a buy made within the
 * last day: the one the finality badge follows. Null otherwise.
 */
export function badgeHash(entry: DcaLedgerEntry | null, newest: { kind: string; hashes: readonly string[] } | undefined, nowMs: number): Hex | null {
  if (entry === null || newest === undefined || newest.kind !== "bought") return null;
  const hash = newest.hashes[newest.hashes.length - 1];
  if (hash === undefined) return null;
  const run = entry.runs.find((r) => r.hashes.includes(hash));
  return run !== undefined && nowMs - run.at < BADGE_MAX_AGE_MS ? (hash as Hex) : null;
}

export function History({
  plan,
  entry,
  expert,
  rpc = null,
}: {
  plan: DcaPlan;
  entry: DcaLedgerEntry | null;
  expert: boolean;
  /** The person's network service, for the newest buy's finality badge; no badge without it. */
  rpc?: JsonRpc | null;
}) {
  const [all, setAll] = useState(false);
  // The badge reads the chain, so it is shown only while the history is open.
  const [open, setOpen] = useState(false);
  const rows = entry === null ? [] : historyRows(entry, plan, { amounts: expert ? "exact" : "rounded" });
  const shown = expert || all ? rows : rows.slice(0, SIMPLE_ROWS);
  const badge = open && rpc !== null ? badgeHash(entry, rows[0], Date.now()) : null;

  return (
    <Disclosure summary={`History (${rows.length})`} testId="dca-history" onToggle={setOpen}>
      {rows.length === 0 ? (
        <p className="spdex-dca-hint">
          {entry === null ? "This browser has no record of this plan." : "Nothing yet."}
        </p>
      ) : (
        <ol className="spdex-history">
          {shown.map((row) => {
            const primary = row.hashes[row.hashes.length - 1];
            const others = expert ? row.hashes.slice(0, -1) : [];
            const codes = expert ? row.codes : row.codes.slice(0, 1);
            return (
              <li key={row.seq} className="spdex-history__row" data-testid={`dca-run-${row.seq}`} data-kind={row.kind}>
                <span className="spdex-history__text" {...(row.exactText === undefined ? {} : { title: row.exactText })}>
                  {row.text}
                </span>
                {codes.map((code) => (
                  <code key={code} className="spdex-dca-code">
                    {code}
                  </code>
                ))}
                {others.map((hash) => (
                  <TxRef key={hash} chainId={plan.chainId} hash={hash} />
                ))}
                {primary !== undefined ? <TxRef chainId={plan.chainId} hash={primary} testId={`dca-tx-${row.seq}`} /> : null}
                {badge !== null && rpc !== null && primary === badge ? (
                  <span className="spdex-history__final">
                    <FinalityBadge rpc={rpc} chainId={plan.chainId} hash={badge} testId="dca-history-finality" />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {!expert && !all && rows.length > SIMPLE_ROWS ? (
        <button type="button" className="spdex-dca-link" onClick={() => setAll(true)}>
          Show all
        </button>
      ) : null}
    </Disclosure>
  );
}
