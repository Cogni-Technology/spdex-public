/**
 * The questions the Tip row asks before money follows a new address.
 *
 * `TipConfirm`: the first tip to an address spDEX doesn't list (saved by the
 * person, imported, or arriving in loaded settings) waits for this. It shows
 * the name, the ENS name and the whole checksummed address in groups of
 * four, whether it looks like anyone else's, and whether its name reads like
 * a listed or saved name at another address, because this is the last moment
 * a poisoned or mistyped address, or an imitation, can still be caught. The
 * name checks run here whatever path the name came by: a settings link or a
 * file names an address as it likes. Until it is answered the recipient is
 * skipped (`tippableRecipients`), and its share is not sent.
 *
 * `RetiredChoice`: a listed entry the person tips was retired in an update.
 * It is skipped until they choose: keep tipping the same address (saved to
 * their list, and confirmed like any new one), switch to the replacement
 * (both addresses shown in full), or stop. Nothing switches on its own.
 *
 * Neither ever takes focus on a button that moves money (UI rule R2,
 * docs/ARCHITECTURE.md): when one opens because the person just added
 * someone, focus goes to its container.
 */

import { useEffect, useId, useRef, type RefObject } from "react";
import { Button } from "@spdex/ui";
import type { TipRecipient } from "@spdex/core";
import type { DiscoveredRecipient } from "../../lib/engine.js";
import { describeRecipient, lookalikeOf, nameWarnings, type AddWarning, type RecipientView } from "../../lib/tiplist/checks.js";
import { GroupedHex } from "../culture/ContractBadge.js";
import { useTips } from "./context.js";
import { TipTagChip } from "./TipTagChip.js";

/** What the confirm says about lookalikes, in one line. Before the shipped list is read, that is said, not "no lookalike". */
export function lookalikeLine(
  address: string,
  tips: ReturnType<typeof useTips>,
  chosen: readonly TipRecipient[],
): { text: string; danger: boolean } {
  const found = lookalikeOf(address, {
    chainId: tips.chainId,
    account: tips.account,
    defaults: tips.defaults,
    list: tips.list,
    chosen,
  });
  if (found === null && tips.defaults === null) {
    return { text: "Looks like no saved or chosen address. Listed entries not checked yet.", danger: false };
  }
  if (found === null) return { text: "Looks like no other listed, saved or chosen address.", danger: false };
  if (found.match === "both") {
    return { text: `Looks like ${found.name}'s address but isn't. Address-poisoning scams do this.`, danger: true };
  }
  return { text: `${found.match === "first" ? "Starts" : "Ends"} like ${found.name}'s address, which is a different one.`, danger: false };
}

/**
 * What the name a recipient carries says about who it may imitate: a listed
 * or saved name at another address, or mixed alphabets. Only for a name that
 * came from outside (the person's own, a file's, a link's); not for a listed
 * entry's own, nor the "Not in My tip list" spDEX writes.
 */
export function nameLines(view: RecipientView, tips: ReturnType<typeof useTips>): AddWarning[] {
  if (view.tag === "LISTED" || view.tag === "RETIRED" || view.notSaved) return [];
  return nameWarnings(view.address, view.name, { defaults: tips.defaults, list: tips.list });
}

/** The name lines under a recipient, danger in the lookalike's style. */
export function NameLines({ warnings, testId }: { warnings: readonly AddWarning[]; testId: string }) {
  return (
    <>
      {warnings.map((warning) => (
        <span
          key={warning.kind}
          className={`spdex-tipconfirm__look${warning.tone === "danger" ? " spdex-tipconfirm__look--danger" : ""}`}
          data-testid={`${testId}-${warning.kind}`}
          role={warning.tone === "danger" ? "alert" : undefined}
        >
          {warning.text}
        </span>
      ))}
    </>
  );
}

/** Moves focus to `ref` once, when `focus` is set: never onto a button (UI rule R2). */
function useFocusOnOpen(ref: RefObject<HTMLElement | null>, focus: boolean) {
  useEffect(() => {
    if (focus) ref.current?.focus({ preventScroll: false });
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function TipConfirm({
  recipient,
  chosen,
  focus,
  onConfirm,
  onCancel,
}: {
  recipient: TipRecipient;
  chosen: readonly TipRecipient[];
  /** Take focus when shown: only when the person's own action opened it. */
  focus: boolean;
  onConfirm: (view: RecipientView) => void;
  onCancel: () => void;
}) {
  const tips = useTips();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useFocusOnOpen(ref, focus);
  const view = describeRecipient(recipient.address, tips.list, tips.defaults, recipient);
  const lookalike = lookalikeLine(recipient.address, tips, chosen);
  const names = nameLines(view, tips);
  const lower = recipient.address.toLowerCase();

  return (
    <div
      ref={ref}
      className="spdex-tipconfirm"
      role="group"
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="tip-confirm"
      data-address={lower}
    >
      <p className="spdex-tipconfirm__title" id={titleId}>
        First tip to this address
      </p>
      <p className="spdex-tipconfirm__who">
        <TipTagChip tag={view.tag} />{" "}
        <span data-testid="tip-confirm-name">
          {view.fromSettings ? `named “${view.name}” by loaded settings` : view.name}
        </span>
        {view.ens !== undefined ? <span className="spdex-tipconfirm__ens"> · {view.ens}</span> : null}
        {view.mine?.imported ? <span className="spdex-tipconfirm__ens"> · imported</span> : null}
      </p>
      <GroupedHex value={view.address} testId="tip-confirm-address" />
      <p
        className={`spdex-tipconfirm__look${lookalike.danger ? " spdex-tipconfirm__look--danger" : ""}`}
        data-testid="tip-confirm-lookalike"
        role={lookalike.danger ? "alert" : undefined}
      >
        {lookalike.text}
      </p>
      {names.length > 0 ? (
        <p className="spdex-tipconfirm__names">
          <NameLines warnings={names} testId="tip-confirm-name-warning" />
        </p>
      ) : null}
      <p className="spdex-field__hint">Check it with the person — a wrong address can&apos;t be undone.</p>
      <div className="spdex-actions">
        {/* A money control (UI rule R2): marked so no shortcut or reveal focuses it. */}
        <button type="button" className="spdex-button" data-testid="tip-confirm-accept" data-money-control="" onClick={() => onConfirm(view)}>
          Tip this address
        </button>
        <Button variant="ghost" testId="tip-confirm-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function RetiredChoice({
  recipient,
  replacement,
  reason,
  focus,
  onKeep,
  onReplace,
  onStop,
}: {
  recipient: TipRecipient;
  /** The entry `replacedBy` names, when it is listed and current. */
  replacement: DiscoveredRecipient | null;
  reason: string;
  focus: boolean;
  onKeep: () => void;
  onReplace: (replacement: DiscoveredRecipient) => void;
  onStop: () => void;
}) {
  const tips = useTips();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useFocusOnOpen(ref, focus);
  const view = describeRecipient(recipient.address, tips.list, tips.defaults, recipient);

  return (
    <div
      ref={ref}
      className="spdex-tipconfirm"
      role="group"
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="tip-retired"
      data-address={recipient.address.toLowerCase()}
    >
      <p className="spdex-tipconfirm__title" id={titleId}>
        {view.name} was retired from the list
      </p>
      <p className="spdex-field__hint" data-testid="tip-retired-reason">
        {reason}. Not tipped until you choose.
      </p>
      <p className="spdex-tipconfirm__who">Tipped until now:</p>
      <GroupedHex value={view.address} testId="tip-retired-old" />
      {replacement !== null ? (
        <>
          <p className="spdex-tipconfirm__who">Listed instead: {replacement.label}</p>
          <GroupedHex value={replacement.address} testId="tip-retired-new" />
        </>
      ) : null}
      <div className="spdex-actions">
        {replacement !== null ? (
          <button
            type="button"
            className="spdex-button"
            data-testid="tip-retired-replace"
            data-money-control=""
            onClick={() => onReplace(replacement)}
          >
            Use the new address
          </button>
        ) : null}
        <button
          type="button"
          className="spdex-button spdex-button--ghost"
          data-testid="tip-retired-keep"
          data-money-control=""
          onClick={onKeep}
        >
          Keep tipping
        </button>
        <Button variant="ghost" testId="tip-retired-stop" onClick={onStop}>
          Stop tipping
        </Button>
      </div>
    </div>
  );
}
