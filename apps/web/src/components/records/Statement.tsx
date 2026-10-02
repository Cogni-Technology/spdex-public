/**
 * The printable statement: Your activity on paper, for one wallet on one
 * network.
 *
 * Rendered into a container of its own at the end of the page, hidden on
 * screen. While it prints, the page is hidden and only it is shown
 * (records.css), then the browser's own print dialog opens; there it can be
 * printed or saved as a PDF. Nothing leaves the browser either way.
 *
 * Every amount is written with every digit, dates are in UTC so two readers
 * see the same day, and there is no average cost: totals are per token,
 * sold, bought and tipped, with how many amounts they couldn't include. Buy
 * fees received for other people's vault buys are a column of their own,
 * never counted as bought.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { formatFiat } from "../../lib/money/format.js";
import type { CurrencyCode } from "../../lib/money/pricing.js";
import {
  isBuyFeesRow,
  kindLabel,
  legExact,
  legSymbol,
  sideTotalText,
  utcMinute,
  type StatementData,
} from "../../lib/records/statement.js";
import type { RecordRow } from "../../lib/records/types.js";
import { rowValueIn } from "../../lib/records/values.js";
import "./records.css";

export function Statement({
  data,
  currency,
  locale,
  onDone,
}: {
  data: StatementData;
  currency: CurrencyCode;
  locale: string;
  /** Printing finished or was cancelled. */
  onDone(): void;
}) {
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    document.body.classList.add("spdex-printing");
    const after = () => done.current();
    window.addEventListener("afterprint", after);
    // After the statement is on the page, so the dialog prints it.
    const frame = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("afterprint", after);
      document.body.classList.remove("spdex-printing");
    };
  }, [data]);

  const local = currency !== "USD";
  const money = (row: RecordRow, code: CurrencyCode) => {
    const value = rowValueIn(row, code);
    return value === null ? "" : formatFiat(value, locale);
  };
  const amount = (leg: RecordRow["sold"]) => legExact(leg) ?? `${legSymbol(leg)}: unknown`;
  const fees = data.totals.some((total) => total.feesReceived.rows > 0);

  return createPortal(
    <div className="spdex-statement" data-testid="activity-statement">
      <h1>{data.title}</h1>
      <dl>
        <dt>Wallet</dt>
        <dd className="spdex-statement__mono">{data.account}</dd>
        <dt>Network</dt>
        <dd>{data.network}</dd>
        <dt>Covers</dt>
        <dd>{data.first === null || data.last === null ? "Nothing recorded" : `${utcMinute(data.first)} to ${utcMinute(data.last)}`}</dd>
        <dt>Generated</dt>
        <dd>{utcMinute(data.generatedAt)}</dd>
      </dl>

      <h2>Totals</h2>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th className="spdex-statement__num">Sold</th>
            <th className="spdex-statement__num">Bought</th>
            <th className="spdex-statement__num">Tipped</th>
            {fees ? <th className="spdex-statement__num">Buy fees received</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.totals.map((total) => (
            <tr key={total.token}>
              <td>{total.info?.symbol ?? total.token}</td>
              <td className="spdex-statement__num">{sideTotalText(total.sold, total.info) ?? ""}</td>
              <td className="spdex-statement__num">{sideTotalText(total.bought, total.info) ?? ""}</td>
              <td className="spdex-statement__num">{sideTotalText(total.tipped, total.info) ?? ""}</td>
              {fees ? <td className="spdex-statement__num">{sideTotalText(total.feesReceived, total.info) ?? ""}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Activity</h2>
      <table>
        <thead>
          <tr>
            <th>Date (UTC)</th>
            <th>What</th>
            <th className="spdex-statement__num">Sold</th>
            <th className="spdex-statement__num">Bought</th>
            <th className="spdex-statement__num">Value then (USD)</th>
            {local ? <th className="spdex-statement__num">Value then ({currency})</th> : null}
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.id}>
              <td>
                {utcMinute(row.at.unix).replace(" UTC", "")}
                {row.at.source === "device" ? " *" : ""}
              </td>
              <td>
                {kindLabel(row.kind)}
                {row.planLabel === undefined ? "" : ` · ${row.planLabel}`}
              </td>
              <td className="spdex-statement__num">{isBuyFeesRow(row) ? "" : amount(row.sold)}</td>
              <td className="spdex-statement__num">
                {row.kind === "tip" ? "" : isBuyFeesRow(row) ? `${amount(row.bought)} received in buy fees` : amount(row.bought)}
              </td>
              <td className="spdex-statement__num">{isBuyFeesRow(row) ? "" : money(row, "USD")}</td>
              {local ? <td className="spdex-statement__num">{isBuyFeesRow(row) ? "" : money(row, currency)}</td> : null}
              <td className="spdex-statement__hash">{row.hashes.join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.some((row) => row.at.source === "device") ? (
        <p>* This device's time when it was recorded: the block's time couldn't be read.</p>
      ) : null}

      {data.notes.length > 0 ? (
        <ul>
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <p>{data.valuesLine}</p>
      <p>{data.footnote}</p>
      <p>Made with spDEX, an open-source community project for SPX6900 holders.</p>
    </div>,
    document.body,
  );
}
