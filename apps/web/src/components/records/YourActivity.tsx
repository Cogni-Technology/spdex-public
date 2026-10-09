/**
 * Your activity: the connected wallet's swaps, tips and buys on this
 * network, newest first, with a spreadsheet file and a printable statement.
 *
 * What it lists comes from `useRecords` (lib/records/store.ts), which App
 * runs once and hands to this panel and to Your stack alike: this browser's
 * record of swaps, tips and plan buys, and the person's vault plans' buys
 * read from the chain. The panel is folded to its title, and nothing is read
 * until it is opened (or Your stack is on screen), and then only from the
 * person's own network service.
 *
 * Every figure a row can't know is left blank, never 0, and what the list
 * leaves out is said under it. There is no average cost anywhere: each row
 * carries only what its sold side was worth then.
 *
 * In a tile (`open` defined, the "Your SPX" tile, under Your stack) the tile
 * is its fold: no title of its own but a small "Activity" heading, the tile's
 * open state in place of the fold's, and "3 records" as its part of the
 * header's summary.
 */

import { useEffect, useRef, useState } from "react";
import { Button, FoldedPanel } from "@spdex/ui";
import { TOKENS, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { explorerUrl } from "../../lib/dca/view.js";
import { downloadText } from "../../lib/download.js";
import type { CurrencyCode, Pricing } from "../../lib/money/pricing.js";
import { csvFileName, recordsCsv } from "../../lib/records/csv.js";
import {
  dateSourceText,
  isBuyFeesRow,
  kindLabel,
  legAmount,
  legSymbol,
  makerText,
  ACTIVITY_FOOTNOTE,
  rowDay,
  statementOf,
  valueThen,
  type StatementData,
} from "../../lib/records/statement.js";
import { FILL_MAX_BLOCKS, type FillResult, type Records } from "../../lib/records/store.js";
import type { RecordRow } from "../../lib/records/types.js";
import type { TilePanelProps, TileSummary } from "../../lib/tiles.js";
import { CopyHex, InfoTerm } from "../dca/common.js";
import { useTileSummary } from "../dca/tilePanel.js";
import { FinalityBadge } from "../trust/FinalityBadge.js";
import { Statement } from "./Statement.js";
import "./records.css";

export const ACTIVITY_EMPTY = "Nothing recorded in this browser yet.";
/** What the empty list leaves out, one tap away. */
export const ACTIVITY_EMPTY_WHY =
  "One-time swaps and tips are recorded from this version on; earlier ones weren't. Your vaults' buys are read from the chain.";
export const CSV_WARNING = "The CSV names your address and transactions: whoever gets it can look up everything that address has done.";
export const FILL_HINT = `About one read per row, up to ${FILL_MAX_BLOCKS} a press. Needs a service that keeps old state; otherwise the cell stays blank.`;

/** Rows younger than a day show how settled they are; an older one has long been final. */
const BADGE_MAX_AGE_SECONDS = 86_400;

const SPX = TOKENS.SPX.address.toLowerCase();

export interface YourActivityProps extends TilePanelProps {
  records: Records;
  account: Address | null;
  chainId: number;
  rpc: JsonRpc | null;
  /** The page's currency and number format; dollars and en-US without them. */
  pricing: Pick<Pricing, "currency" | "locale"> | null;
  /**
   * The panel was opened or closed: records are read only while it is open,
   * or Your stack is on screen. In a tile, called whenever `open` changes.
   */
  onOpen?(open: boolean): void;
  /** "Make a card", on rows that measurably bought SPX; no button without it. */
  onMakeCard?(row: RecordRow): void;
}

/** What a press of "Fill in values" came to, in a sentence or two. */
export function fillResultText(result: FillResult): string {
  const blocks = (n: number) => `${n} block${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (result.read > 0) parts.push(`Filled in values from Chainlink at ${blocks(result.read)}.`);
  if (result.failed > 0) {
    parts.push(
      `${blocks(result.failed)} couldn't be read: your network service may not keep state that old, so those cells stay blank.`,
    );
  }
  if (result.left > 0) parts.push(`${blocks(result.left)} still to read: press again.`);
  return parts.length === 0 ? "Nothing left to fill in." : parts.join(" ");
}

/** The "Your SPX" tile header's part from the records: "3 records", or nothing to add. */
export function activitySummary(input: { account: Address | null; records: Pick<Records, "rows" | "state"> }): TileSummary {
  if (input.account === null) return { text: "" };
  const count = input.records.rows.length;
  if (count > 0) return { text: `${count} ${count === 1 ? "record" : "records"}` };
  return { text: "" };
}

export function YourActivity(props: YourActivityProps) {
  const { records, account, chainId, rpc, pricing, onOpen, onMakeCard } = props;
  const inTile = props.open !== undefined;
  const [folded, setFolded] = useState(false);
  const open = inTile ? props.open === true : folded;
  const [statement, setStatement] = useState<StatementData | null>(null);
  const [filled, setFilled] = useState<string | null>(null);
  const currency: CurrencyCode = pricing?.currency ?? "USD";
  const locale = pricing?.locale ?? "en-US";
  const nowMs = Date.now();
  const { rows } = records;

  const toggle = (next: boolean) => {
    setFolded(next);
    onOpen?.(next);
  };
  // In a tile, the tile's open state is the fold's.
  const onOpenRef = useLatest(onOpen);
  useEffect(() => {
    if (inTile) onOpenRef.current?.(open);
  }, [inTile, open, onOpenRef]);
  useTileSummary(props.onSummary, activitySummary({ account, records }));

  const downloadCsv = () => {
    if (account === null) return;
    downloadText(csvFileName(chainId, account, new Date()), "text/csv;charset=utf-8", recordsCsv(rows, currency));
  };

  const print = () => {
    if (account === null) return;
    setStatement(
      statementOf({ rows, account, chainId, currency, generatedAt: Math.floor(Date.now() / 1000), notes: records.notes }),
    );
  };

  const fill = async () => {
    setFilled(null);
    setFilled(fillResultText(await records.fill()));
  };

  // Nothing to show yet (no wallet, or nothing recorded or found for it, and
  // nothing to say about what couldn't be read): no panel, rather than an
  // empty one on every newcomer's page. The records are read once Your stack,
  // just above, has been on screen, so a first row brings this in.
  if (account === null || (rows.length === 0 && records.notes.length === 0)) return null;

  let body;
  if (rows.length === 0) {
    body = (
      <p className="spdex-activity__empty" data-testid="activity-empty">
        {records.state === "loading" ? (
          "Reading your activity through your network service…"
        ) : (
          <>
            {ACTIVITY_EMPTY}
            <InfoTerm tip={ACTIVITY_EMPTY_WHY} label="Why?" />
          </>
        )}
      </p>
    );
  } else {
    body = (
      <div className="spdex-activity">
        <div className="spdex-activity__head" aria-hidden="true">
          <span>Date</span>
          <span>What</span>
          <span>Sold</span>
          <span>Bought</span>
          <span>Value then</span>
          <span>Transaction</span>
        </div>
        <ol className="spdex-activity__list" data-testid="activity-list">
          {rows.map((row) => (
            <ActivityRow
              key={row.id}
              row={row}
              currency={currency}
              locale={locale}
              nowMs={nowMs}
              rpc={open ? rpc : null}
              {...(onMakeCard === undefined ? {} : { onMakeCard })}
            />
          ))}
        </ol>
      </div>
    );
  }

  const content = (
    <>
      {records.state === "loading" && rows.length > 0 ? (
        <p className="spdex-activity__state" data-testid="activity-reading">
          Reading receipts and vault buys through your network service…
        </p>
      ) : null}
      {body}
      {records.notes.length > 0 && account !== null ? (
        <ul className="spdex-activity__notes" data-testid="activity-notes">
          {records.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {account !== null && rows.length > 0 ? (
        <>
          <div className="spdex-activity__actions">
            <Button variant="ghost" testId="activity-csv" onClick={downloadCsv}>
              Download CSV
            </Button>
            <Button variant="ghost" testId="activity-print" onClick={print}>
              Print statement
            </Button>
            {records.fillable > 0 && rpc !== null ? (
              <Button variant="ghost" testId="activity-fill" disabled={records.filling} onClick={() => void fill()}>
                {records.filling ? "Filling in…" : "Fill in values from the chain"}
              </Button>
            ) : null}
          </div>
          <p className="spdex-activity__hint">{CSV_WARNING}</p>
          {records.fillable > 0 && rpc !== null ? <p className="spdex-activity__hint">{FILL_HINT}</p> : null}
          {filled !== null ? (
            <p className="spdex-activity__result" data-testid="activity-fill-result" role="status">
              {filled}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="spdex-activity__foot">{ACTIVITY_FOOTNOTE}</p>
      {statement !== null ? <Statement data={statement} currency={currency} locale={locale} onDone={() => setStatement(null)} /> : null}
    </>
  );

  return inTile ? (
    <section className="spdex-subpanel" data-testid="activity-panel">
      <h3 className="spdex-subpanel__title">Activity</h3>
      {content}
    </section>
  ) : (
    <FoldedPanel
      title="Your activity"
      subtitle="What you did with spDEX: from this browser's record, and from the chain for your vaults."
      testId="activity-panel"
      foldTestId="activity-details"
      onToggle={toggle}
    >
      {content}
    </FoldedPanel>
  );
}

/** A ref that always holds the latest `value`: for a callback an effect calls without re-running on it. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A transaction as its short hash, which copies it, and on Ethereum a link to Etherscan beside it. */
function TxLink({ chainId, hashes }: { chainId: number; hashes: readonly Hex[] }) {
  const last = hashes[hashes.length - 1];
  if (last === undefined) return <span className="spdex-activity__unknown">none recorded</span>;
  const url = explorerUrl(chainId, last);
  return (
    <>
      <CopyHex value={last} what="transaction hash" />
      {url !== null ? (
        <>
          {" "}
          <a href={url} target="_blank" rel="noreferrer noopener" title={hashes.join("\n")}>
            View ↗
          </a>
        </>
      ) : null}
    </>
  );
}

/** An amount as a cell shows it, or its token with "amount unknown". */
function Amount({ leg }: { leg: RecordRow["sold"] }) {
  const text = legAmount(leg);
  return text !== null ? (
    <>{text}</>
  ) : (
    <>
      {legSymbol(leg)}, <span className="spdex-activity__unknown">amount unknown</span>
    </>
  );
}

function ActivityRow({
  row,
  currency,
  locale,
  nowMs,
  rpc,
  onMakeCard,
}: {
  row: RecordRow;
  currency: CurrencyCode;
  locale: string;
  nowMs: number;
  /** Null while the panel is closed, so no badge reads anything then. */
  rpc: JsonRpc | null;
  onMakeCard?: (row: RecordRow) => void;
}) {
  const tip = row.kind === "tip";
  // Fees received for making other people's vault buys: never a buy, and
  // nothing was sold, so no "for" side and no value then.
  const fees = isBuyFeesRow(row);
  const value = fees ? null : valueThen(row, currency, locale);
  const last = row.hashes[row.hashes.length - 1];
  const recent = nowMs / 1000 - row.at.unix < BADGE_MAX_AGE_SECONDS;
  const cardable =
    onMakeCard !== undefined && !tip && row.bought.measured && row.bought.amount !== null && row.bought.token.toLowerCase() === SPX;
  const when = new Date(row.at.unix * 1000).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const plan = row.planLabel === undefined ? "" : ` · “${row.planLabel}”${row.buyIndex ? `, buy ${row.buyIndex.n} of ${row.buyIndex.of}` : ""}`;
  // A vault buy's maker: one quiet line under the figures, said only when known.
  const maker = makerText(row);

  return (
    <li className="spdex-activity__row" data-testid="activity-row" data-kind={row.kind} data-hash={last}>
      <span className="spdex-activity__line">
        <span className="spdex-activity__date" title={`${when}. ${dateSourceText(row)}`}>
          {rowDay(row.at.unix, nowMs, locale)}
        </span>
        <span className="spdex-activity__what" title={`${kindLabel(row.kind)}${plan}${maker === null ? "" : `. ${maker}.`}`}>
          {kindLabel(row.kind)}
        </span>
        <span className="spdex-activity__bought">
          {tip ? (
            <>
              <span className="spdex-activity__desk" aria-label="nothing">
                —
              </span>
              <span className="spdex-activity__word">
                Tipped <Amount leg={row.sold} />
              </span>
            </>
          ) : fees ? (
            // The amount in the Bought column at desktop width, whose
            // heading the "What" column's "Buy fees earned" qualifies; in
            // words on a phone.
            <span data-testid="activity-fees-received">
              <span className="spdex-activity__word">Received </span>
              <Amount leg={row.bought} />
              <span className="spdex-activity__word"> in buy fees</span>
            </span>
          ) : (
            <>
              <span className="spdex-activity__word">Bought </span>
              <Amount leg={row.bought} />
            </>
          )}
        </span>
      </span>
      <span className="spdex-activity__line spdex-activity__line--second">
        {fees ? (
          <span className="spdex-activity__sold spdex-activity__desk" aria-label="nothing sold">
            —
          </span>
        ) : (
          <span className={`spdex-activity__sold${tip ? " spdex-activity__desk" : ""}`}>
            {tip ? null : <span className="spdex-activity__word">for </span>}
            <Amount leg={row.sold} />
          </span>
        )}
        {value !== null ? (
          <span className="spdex-activity__value" title={value.fellBack ? `In US dollars: spDEX held no ${currency} rate for then.` : undefined}>
            {value.text}
            <span className="spdex-activity__word"> then</span>
          </span>
        ) : null}
        <span className="spdex-activity__tx">
          <TxLink chainId={row.chainId} hashes={row.hashes} />
        </span>
        {cardable ? (
          <span className="spdex-activity__act">
            <button type="button" className="spdex-dca-link spdex-activity__card" data-testid="make-card" onClick={() => onMakeCard!(row)}>
              Make a card
            </button>
          </span>
        ) : null}
      </span>
      <span className="spdex-activity__extra">
        {maker !== null ? (
          <span className="spdex-activity__maker" data-testid="activity-maker" data-maker={row.vaultBuy?.maker ?? undefined}>
            {maker}
          </span>
        ) : null}
        {row.account === null ? (
          <span className="spdex-activity__nowallet" data-testid="activity-no-wallet">
            Wallet unknown: left out of totals
          </span>
        ) : null}
        {recent && rpc !== null && last !== undefined ? <FinalityBadge rpc={rpc} chainId={row.chainId} hash={last} /> : null}
      </span>
    </li>
  );
}
