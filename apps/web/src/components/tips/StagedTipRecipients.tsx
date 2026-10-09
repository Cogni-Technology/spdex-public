/**
 * In the "settings shared with you" prompt: every tip recipient the link
 * would add, before "Apply these settings".
 *
 * Each with its tag from the address (so a link that claims the shipped
 * list's name for its own address still reads UNLISTED), the whole address in
 * groups of four, the lookalike check, and whether the name the link gives
 * reads like a listed or saved name at another address: a settings link is
 * exactly how a poisoned address, or an imitation, would arrive. Before the
 * shipped list is read the row says so, rather than "no lookalike". Applying
 * still tips nobody new on its own: an address spDEX doesn't list waits for
 * the first-tip check on the Tip row, and the prompt says that too.
 */

import type { TipRecipient } from "@spdex/core";
import { describeRecipient } from "../../lib/tiplist/checks.js";
import { GroupedHex } from "../culture/ContractBadge.js";
import { useTips } from "./context.js";
import { lookalikeLine, NameLines, nameLines } from "./TipConfirm.js";
import { TipTagChip } from "./TipTagChip.js";
import "./tips.css";

export function StagedTipRecipients({
  staged,
  current,
}: {
  staged: readonly TipRecipient[];
  current: readonly TipRecipient[];
}) {
  const tips = useTips();
  const known = new Set(current.map((recipient) => recipient.address.toLowerCase()));
  const arriving = staged.filter((recipient) => !known.has(recipient.address.toLowerCase()));
  if (arriving.length === 0) return null;
  return (
    <div className="spdex-staged-tips" data-testid="staged-tips">
      <p className="spdex-tiplist__title">New tip addresses ({arriving.length})</p>
      <ul className="spdex-tiplist__entries">
        {arriving.map((recipient) => {
          const key = recipient.address.toLowerCase();
          const view = describeRecipient(recipient.address, tips.list, tips.defaults, recipient);
          const lookalike = lookalikeLine(recipient.address, tips, current);
          const names = nameLines(view, tips);
          return (
            <li className="spdex-tiplist__entry" key={key} data-testid={`staged-tip-${key}`}>
              <div className="spdex-tiplist__who">
                {tips.defaults !== null ? <TipTagChip tag={view.tag} testId={`staged-tip-tag-${key}`} /> : null}{" "}
                <span className="spdex-tiplist__name">
                  {view.fromSettings ? `named “${view.name}” by these settings` : view.name}
                </span>
                <GroupedHex value={view.address} />
                <span
                  className={`spdex-tipconfirm__look${lookalike.danger ? " spdex-tipconfirm__look--danger" : ""}`}
                  data-testid={`staged-tip-lookalike-${key}`}
                >
                  {lookalike.text}
                </span>
                <NameLines warnings={names} testId={`staged-tip-name-${key}`} />
              </div>
            </li>
          );
        })}
      </ul>
      {arriving.some((recipient) => describeRecipient(recipient.address, tips.list, tips.defaults, recipient).tag !== "LISTED") ? (
        <p className="spdex-field__hint" data-testid="staged-tips-ask">
          Unlisted addresses ask before their first tip.
        </p>
      ) : null}
    </div>
  );
}
