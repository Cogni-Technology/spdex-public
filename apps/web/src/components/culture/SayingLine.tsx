/**
 * One line quoting one of the SPX6900 community's sayings, with a link to it
 * on spx6900.com (lib/culture/sayings.ts says which, and why only the saying
 * is quoted).
 *
 * The saying keeps the community's capitals and is set in quotation marks,
 * and the link says whose words they are, so the line never reads as spDEX
 * speaking for SPX6900. The test id is `saying-<id>`.
 */

import type { JSX } from "react";
import { SAYINGS, SAYING_LEADS, sayingUrl, type SayingId } from "../../lib/culture/sayings.js";
import "./culture.css";

export interface SayingLineProps {
  id: SayingId;
  /** Words before the quote, in place of the line's own ("No price chart here."); "" for none. */
  lead?: string;
}

export function SayingLine({ id, lead }: SayingLineProps): JSX.Element {
  const before = lead ?? SAYING_LEADS[id];
  return (
    <p className="spdex-saying" data-testid={`saying-${id}`}>
      {before ? <>{before} </> : null}
      <q className="spdex-saying__text">{SAYINGS[id]}</q>{" "}
      <span className="spdex-nobr">—</span>{" "}
      <a href={sayingUrl(id)} target="_blank" rel="noreferrer noopener" title="Where the saying is from, on spx6900.com">
        the SPX6900 community ↗
      </a>
    </p>
  );
}
