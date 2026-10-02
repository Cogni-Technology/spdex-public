/**
 * Which contract is SPX6900: the address in full, checksummed, in groups of
 * four to compare against the listings people already trust, with a Copy
 * button and links to those listings (lib/culture/contract.ts).
 *
 * The groups are for reading only. They are spaced apart by the stylesheet,
 * not by typed spaces, so Copy, a selection and the page's text all hold the
 * address itself, which is the only form a wallet or an explorer takes.
 */

import { Fragment, type JSX } from "react";
import { CopyButton } from "../dca/common.js";
import { shortAddress } from "../../lib/dca/format.js";
import { SPX_CONTRACT, SPX_CONTRACT_SOURCES, SPX_CONTRACT_TEXT, hexGroups } from "../../lib/culture/contract.js";
import "./culture.css";

/** The contract line's test id, which Welcome's "Show me the contract" opens. */
export const CONTRACT_LINE_ID = "spx-contract-line";

/**
 * The contract check in one line, under the trade card's To whenever SPX is
 * one side of the swap: "SPX6900 · 0xE0f6…c56c · check", with the whole
 * badge folded under it. It is where the check lives, so hiding Welcome,
 * whose third step points here, never takes it off the page.
 */
export function ContractLine(): JSX.Element {
  return (
    <details className="spdex-contract-line" data-testid={CONTRACT_LINE_ID}>
      <summary>
        SPX6900 · <code title={SPX_CONTRACT}>{shortAddress(SPX_CONTRACT)}</code> · <span className="spdex-contract-line__check">check</span>
      </summary>
      <ContractBadge />
    </details>
  );
}

export function ContractBadge({ testId = "spx-contract-badge" }: { testId?: string }): JSX.Element {
  return (
    <div className="spdex-contract" data-testid={testId}>
      <p className="spdex-contract__lead">{SPX_CONTRACT_TEXT.lead}</p>
      <div className="spdex-contract__row">
        <GroupedHex value={SPX_CONTRACT} testId="spx-contract-address" />
        <CopyButton text={SPX_CONTRACT} testId="spx-contract-copy" />
      </div>
      <p className="spdex-contract__text">
        {SPX_CONTRACT_TEXT.listed} <strong>{SPX_CONTRACT_TEXT.warning}</strong>
      </p>
      <ul className="spdex-contract__links" aria-label="Where the address is listed">
        {SPX_CONTRACT_SOURCES.map((source) => (
          <li key={source.name}>
            <a href={source.url} target="_blank" rel="noreferrer noopener">
              {source.name} ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * An address or a hash in mono, in groups of four spaced by CSS, with a
 * line break allowed between groups and never inside one. The text is the
 * value exactly, so selecting it copies it whole.
 */
export function GroupedHex({ value, testId }: { value: string; testId?: string }): JSX.Element {
  return (
    <code className="spdex-hex" data-testid={testId} title={value}>
      {hexGroups(value).map((group, i) => (
        <Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          <span className="spdex-hex__group">{group}</span>
        </Fragment>
      ))}
    </code>
  );
}
