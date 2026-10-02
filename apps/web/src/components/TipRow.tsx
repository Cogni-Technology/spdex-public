/**
 * The Tip row, in the One-time tab: a share, and who gets it.
 *
 * ## Why here and not in a settings dialog
 *
 * A tip is a standing instruction to send part of every swap to somebody. Kept
 * behind a Features checkbox and an editor in a dialog, it was a setting people
 * would switch on once and then forget they had — which is backwards for the
 * one setting that moves their money to someone else. On the Buy SPX card it is
 * in front of them on every swap, costs one tap to change, and says what it
 * will send before the swap button does.
 *
 * ## What it can and cannot do
 *
 * The row writes the same `config.tips` the Features switch and Settings →
 * Tips write, through the pure edits in lib/tipRow.ts: the chip is the total,
 * shared evenly, and anything the schema would refuse is refused here too,
 * with the reason. A tip is sent after the swap settles, from what actually
 * arrived: one transfer for one person, one Permit2 transaction for two or
 * more, and everything the wallet is asked to sign checked by the Guard first.
 *
 * ## Who is actually tipped
 *
 * Not everyone chosen: `tippableRecipients` (lib/tiplist/checks.ts) decides,
 * and each pill carries the tag it computes from the address — LISTED, MINE,
 * UNLISTED, RETIRED — never one a config claims. A recipient it skips shows
 * "not tipped", and its share is not sent or handed to the others. The first
 * tip to an address spDEX doesn't list waits for the person to check it here
 * (TipConfirm); a retired listed entry waits for them to choose again.
 * Cancelling that question, or stopping a retired entry, takes the address
 * out like the pill's × (the chip is the total, shared by whoever is left),
 * and the row says what the others now get: the skipped share wasn't being
 * sent, so handing it to them is a change it states rather than makes quietly.
 *
 * ## Focus
 *
 * A control that goes away takes focus with it, so after the picker closes,
 * a question is answered or a pill's × is pressed, focus comes back to "+"
 * (tip-pick), which only opens the picker (UI rule R2, docs/ARCHITECTURE.md),
 * unless a new question just took it. The add form puts it in its address
 * field.
 *
 * Scheduled buys never tip, and this row is on the One-time tab only.
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Banner, Brand, Button, Term, Toggle } from "@spdex/ui";
import { cleanTipText, isPlaceholderChain, isPublicDevAccount, isSpdexOwnTipAddress, type SpdexConfig } from "@spdex/core";
import type { DiscoveredRecipient, QuoteResult } from "../lib/engine.js";
import { formatAmount, isNative, type TokenInfo } from "../lib/tokens.js";
import { GoTo } from "../lib/places.js";
import {
  confirmedName,
  describeRecipient,
  listedEntry,
  MY_TIP_LIST_LABEL,
  MY_TIP_LIST_SOURCE,
  NOT_CONFIRMED,
  payablePolicy,
  refusalFor,
  retiredReason,
  type RecipientView,
  type Skipped,
} from "../lib/tiplist/checks.js";
import { knownContract } from "../lib/tiplist/contracts.js";
import { confirmMine, FROM_LOADED_SETTINGS, keepRetiredMine, type MineEntry } from "../lib/tiplist/store.js";
import {
  addTipRecipient,
  applyTipChip,
  bpsText,
  chipValue,
  isEvenSplit,
  labelAsMine,
  listsPlaceholders,
  NO_LISTED_YET,
  NO_VERIFIED_LIST,
  offeredCandidates,
  pillName,
  recipientsTotal,
  removeTipRecipient,
  replaceTipRecipient,
  TIP_CHIPS,
  tipCostText,
  tipShareOf,
  type TipCandidate,
  type TipChip,
  type TipDelivery,
  type TipEdit,
} from "../lib/tipRow.js";
import { GroupedHex } from "./culture/ContractBadge.js";
import { AddTipAddress } from "./tips/AddTipAddress.js";
import { useTips } from "./tips/context.js";
import { MigratedBanner } from "./tips/MigratedBanner.js";
import { RetiredChoice, TipConfirm } from "./tips/TipConfirm.js";
import { TipTagChip } from "./tips/TipTagChip.js";
import "./tips/tips.css";

/**
 * The share given to the first person chosen when no chip has been picked —
 * tips switched on from the Features dialog, say. The middle chip, and shown
 * as pressed the moment it applies, so it is never a number nobody saw.
 */
const DEFAULT_TIP_BPS = 25;

/** The label's meaning, a hover or a focus away. No "Refused" and no "depth " (see GLOSSARY). */
const TIP_MEANING =
  "An optional thank-you: a share of what you receive, sent to whoever you pick among people who build for the SPX community, spDEX included. Off by default. spDEX adds no fee to a swap.";

/** Why the listed people are there, and what listing is not. */
const WHY_LISTED =
  "People and causes are listed with their agreement and a public post of their address: SIGNED means they also signed it, PROOF LINK ONLY means the post is the evidence. spDEX's own donation vault is written into spDEX's source instead. Not an endorsement: check the address with the person.";

/** What a pill waiting for the first-tip check says, a hover or a focus away. */
const WAITING_MEANING = "Waiting for your check below: nothing is sent to it until then, and its share isn't given to anyone else.";

/**
 * The chips, labelled on each render: `bpsText` writes the page's number
 * format, which is only known once the money settings are read, after this
 * module loads ("0,1 %" in German, not the default's "0.1%").
 */
const chipOptions = () =>
  TIP_CHIPS.map((bps) => ({
    value: `${bps}` as `${TipChip}`,
    label: bps === 0 ? "Off" : bpsText(bps),
  }));

/** A saved entry as the row's picker offers it: the config gets "My tip list", never the private name. */
const mineCandidate = (entry: MineEntry): TipCandidate => ({
  address: entry.address,
  label: MY_TIP_LIST_LABEL,
  registryId: MY_TIP_LIST_SOURCE,
});

export function TipRow({
  config,
  candidates,
  quote,
  tokenOut,
  delivery,
  disabled,
  onChange,
}: {
  config: SpdexConfig;
  /** Who the registries name; null while they are asked. */
  candidates: readonly DiscoveredRecipient[] | null;
  quote: QuoteResult | null;
  tokenOut: TokenInfo;
  /** How the tips will go out, as the summary card counts them (from who is actually tipped). */
  delivery: TipDelivery;
  /** A swap is in flight; its tips were fixed when it started. */
  disabled: boolean;
  onChange: (next: SpdexConfig) => void;
}) {
  const tips = useTips();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The chip picked while nobody is chosen yet. Held here rather than in the
  // config, because the config's shares belong to people and there are none;
  // it becomes the first person's share when they are added.
  const [pending, setPending] = useState<TipChip | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last "don't tip this address" did to the others' shares.
  const [notice, setNotice] = useState<string | null>(null);
  // The address the person just picked here: its question, if it has one,
  // takes focus when it appears (on its container, never a button: UI rule R2).
  const [justPicked, setJustPicked] = useState<string | null>(null);
  // Something the person pressed has gone (the picker, a question, a pill):
  // focus comes back to "+" unless a question that just opened took it.
  const [refocus, setRefocus] = useState(0);
  const rowRef = useRef<HTMLFieldSetElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (refocus === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && rowRef.current?.contains(active)) return;
    pickRef.current?.focus();
  }, [refocus]);
  const returnFocus = () => setRefocus((n) => n + 1);

  const policy = config.tips;
  const on = policy.enabled;
  const chosen = policy.recipients;
  const total = recipientsTotal(chosen);
  const shown = chipValue(policy);
  const pressed = shown === "unset" && pending !== null ? (`${pending}` as const) : shown;
  const even = isEvenSplit(chosen);
  const skippedOf = (address: string): Skipped | undefined =>
    tips.tippable.skipped.find((skip) => skip.address.toLowerCase() === address.toLowerCase());

  const apply = (edit: TipEdit): boolean => {
    if (!edit.ok) {
      setError(edit.error);
      return false;
    }
    setError(null);
    setNotice(null);
    onChange(edit.config);
    return true;
  };

  const pickChip = (value: string) => {
    const bps = Number(value) as TipChip;
    if (!apply(applyTipChip(config, bps))) return;
    if (bps === 0) {
      setPending(null);
      setPickerOpen(false);
      return;
    }
    // A share with nobody to give it to does nothing yet, so the question
    // that comes next is asked straight away.
    if (chosen.length === 0) {
      setPending(bps);
      setPickerOpen(true);
    } else {
      setPending(null);
    }
  };

  const add = (candidate: TipCandidate) => {
    const share = chosen.length > 0 ? total : (pending ?? DEFAULT_TIP_BPS);
    if (!apply(addTipRecipient(config, candidate, share))) return;
    setPending(null);
    setPickerOpen(false);
    setJustPicked(candidate.address.toLowerCase());
    returnFocus();
  };

  /** Take someone out, re-dividing the chip (the total) among the rest. */
  const remove = (address: string): boolean => {
    // The last person out leaves the share on the chip, so putting someone
    // back gives them what the row still says.
    const last = chosen.length === 1;
    if (!apply(removeTipRecipient(config, address))) return false;
    if (last && total > 0 && (TIP_CHIPS as readonly number[]).includes(total)) setPending(total as TipChip);
    returnFocus();
    return true;
  };

  /**
   * "Don't tip this address" (Cancel, Stop tipping): out like the pill's ×,
   * and, since its share wasn't being sent, the row says who gets it now.
   */
  const decline = (address: string) => {
    const others = chosen.length - 1;
    if (!remove(address)) return;
    if (others > 0 && total > 0) {
      setNotice(
        `Not tipping that address. ${bpsText(total)} now goes to ${others === 1 ? "the other person" : `the ${others} others`} — pick a share to change it.`,
      );
    }
  };

  /** The person checked the address: stamp it, and the config names it "My tip list". */
  const confirm = (view: RecipientView) => {
    // Checked again here as a typed address would be: a settings link can
    // name the person's own account, which no confirmation makes tippable.
    const refusal = refusalFor(view.address, { chainId: tips.chainId, account: tips.account });
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    const refused = tips.store.update((state) => confirmMine(state, view.address, Date.now(), confirmedName(view)));
    if (refused !== null) {
      setError(refused);
      return;
    }
    setError(null);
    onChange(labelAsMine(config, view.address, MY_TIP_LIST_LABEL, MY_TIP_LIST_SOURCE));
    setJustPicked(null);
    returnFocus();
  };

  /**
   * A retired entry, kept: saved to the list with the retirement the person
   * saw, and unconfirmed, so the first-tip check asks next (with the whole
   * address) before anything more is sent to it.
   */
  const keepRetired = (address: string, name: string, reason: string) => {
    const refused = tips.store.update((state) => keepRetiredMine(state, address, name, reason, Date.now()));
    if (refused !== null) setError(refused);
    else {
      setError(null);
      setJustPicked(address.toLowerCase());
      returnFocus();
    }
  };

  const isChosen = (address: string) => chosen.some((r) => r.address.toLowerCase() === address.toLowerCase());
  const open = on && pickerOpen;

  // The one question the row asks now, if any: the first chosen recipient
  // waiting on the person, in the order they were chosen.
  const question = on
    ? chosen
        .map((recipient) => ({ recipient, skip: skippedOf(recipient.address) }))
        .find(({ skip }) => skip !== undefined && (skip.reason === NOT_CONFIRMED || skip.reason.startsWith("retired")))
    : undefined;

  return (
    <fieldset className="spdex-tiprow" data-testid="tip-row" disabled={disabled} ref={rowRef}>
      <legend className="spdex-field__label spdex-tiprow__legend">
        <Term tip={TIP_MEANING}>Tip</Term>
      </legend>

      <div className="spdex-tiprow__line">
        <div className="spdex-tiprow__chips">
          <Toggle testId="tip-chips" value={pressed} onChange={pickChip} options={chipOptions()} />
        </div>

        {on ? (
          <div className="spdex-tiprow__who">
            <span className="spdex-tiprow__to">to</span>
            {chosen.map((recipient) => {
              const key = recipient.address.toLowerCase();
              const view = describeRecipient(recipient.address, tips.list, tips.defaults, recipient);
              const skip = skippedOf(recipient.address);
              // An UNLISTED name is only what the loaded settings call it,
              // so it is shown as a quote, never as a name spDEX vouches for.
              // "Not in My tip list" is spDEX's own words, so it isn't quoted.
              const name =
                view.tag === "LISTED" || view.tag === "RETIRED"
                  ? pillName({ label: view.name, handle: view.handle })
                  : view.fromSettings
                    ? `“${view.name}”`
                    : view.name;
              // Waiting for the person's check is not a refusal: dashed, not struck through.
              const waiting = skip?.reason === NOT_CONFIRMED;
              return (
                <span
                  key={key}
                  className={`spdex-tippill${skip ? (waiting ? " spdex-tippill--waiting" : " spdex-tippill--skipped") : ""}`}
                  data-testid={`tip-recipient-pill-${key}`}
                  data-tag={view.tag}
                  title={`${view.name} · ${view.address}`}
                >
                  {tips.defaults !== null ? <TipTagChip tag={view.tag} testId={`tip-pill-tag-${key}`} /> : null}
                  <span className="spdex-tippill__name">{name}</span>
                  {/* Only when the shares differ: an even split says nothing
                      the chip has not already said. */}
                  {even ? null : <span className="spdex-tippill__share">{bpsText(recipient.bps)}</span>}
                  {skip !== undefined && tips.defaults !== null ? (
                    <span className="spdex-tippill__skip" data-testid={`tip-pill-skipped-${key}`} data-reason={skip.reason}>
                      {waiting ? (
                        <Term tip={WAITING_MEANING}>needs a check</Term>
                      ) : (
                        <Term tip={`Not tipped: ${skip.reason}. Its share isn't sent, or given to anyone else.`}>not tipped</Term>
                      )}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="spdex-tippill__remove"
                    data-testid={`tip-remove-${key}`}
                    aria-label={`Stop tipping ${view.name}`}
                    onClick={() => remove(recipient.address)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
            <button
              ref={pickRef}
              type="button"
              className="spdex-tippill spdex-tippill--add"
              data-testid="tip-pick"
              aria-expanded={open}
              {...(open ? { "aria-controls": "tip-picker" } : {})}
              {...(chosen.length === 0 ? {} : { "aria-label": "Tip someone else too" })}
              onClick={() => setPickerOpen((was) => !was)}
              onKeyDown={(event) => {
                // Escape on the button that opened the picker closes the
                // picker, not the whole tile.
                if (event.key === "Escape" && open) {
                  event.stopPropagation();
                  setPickerOpen(false);
                }
              }}
            >
              {chosen.length === 0 ? "+ Choose who" : "+"}
            </button>
          </div>
        ) : null}
      </div>

      {on ? <MigratedBanner /> : null}

      {error ? (
        <p className="spdex-tiprow__error" role="alert" data-testid="tip-row-error">
          {error}
        </p>
      ) : null}
      {notice !== null && on ? (
        <p className="spdex-field__hint" role="status" data-testid="tip-row-notice">
          {notice}
        </p>
      ) : null}

      {question !== undefined && tips.defaults !== null && !open ? (
        question.skip!.reason === NOT_CONFIRMED ? (
          <TipConfirm
            key={`confirm-${question.recipient.address}`}
            recipient={question.recipient}
            chosen={chosen}
            focus={justPicked === question.recipient.address.toLowerCase()}
            onConfirm={confirm}
            onCancel={() => {
              setJustPicked(null);
              decline(question.recipient.address);
            }}
          />
        ) : (
          <RetiredQuestion
            key={`retired-${question.recipient.address}`}
            recipient={question.recipient}
            reason={question.skip!.reason}
            focus={justPicked === question.recipient.address.toLowerCase()}
            onKeep={(name, reason) => keepRetired(question.recipient.address, name, reason)}
            onReplace={(replacement) => {
              if (
                apply(
                  replaceTipRecipient(config, question.recipient.address, {
                    address: replacement.address,
                    label: replacement.label,
                    handle: replacement.handle,
                    registryId: replacement.registryId,
                  }),
                )
              ) {
                returnFocus();
              }
            }}
            onStop={() => decline(question.recipient.address)}
          />
        )
      ) : null}

      {open ? (
        <TipPicker
          candidates={candidates}
          chainId={config.chainId}
          chosen={chosen}
          isChosen={isChosen}
          onAdd={add}
          onClose={() => {
            setPickerOpen(false);
            returnFocus();
          }}
        />
      ) : null}

      {on ? (
        <p className="spdex-field__hint spdex-tiprow__hint" data-testid="tip-row-hint">
          {rowHint({
            config,
            quote,
            tokenOut,
            delivery,
            skipped: tips.tippable.skipped.length,
            waiting: tips.tippable.skipped.some((skip) => skip.reason === NOT_CONFIRMED),
            payable: payablePolicy(policy, tips.tippable),
            listsRead: tips.defaults !== null,
          })}
        </p>
      ) : null}
    </fieldset>
  );
}

/** A retired entry's question, with the replacement its entry names, when that is listed and current. */
function RetiredQuestion({
  recipient,
  reason,
  focus,
  onKeep,
  onReplace,
  onStop,
}: {
  recipient: SpdexConfig["tips"]["recipients"][number];
  reason: string;
  focus: boolean;
  /** Keep tipping: the name to save it under, and the retirement reason the person saw. */
  onKeep: (name: string, reason: string) => void;
  onReplace: (replacement: DiscoveredRecipient) => void;
  onStop: () => void;
}) {
  const tips = useTips();
  const old = listedEntry(recipient.address, tips.defaults);
  const next =
    old?.replacedBy === undefined ? undefined : (tips.defaults ?? []).find((entry) => entry.id === old.replacedBy && entry.retired === undefined);
  return (
    <RetiredChoice
      recipient={recipient}
      replacement={next ?? null}
      reason={reason.replace(/^retired: /, "Retired: ")}
      focus={focus}
      onKeep={() => onKeep(cleanTipText(old?.label ?? "") || FROM_LOADED_SETTINGS, retiredReason(old ?? {}))}
      onReplace={onReplace}
      onStop={onStop}
    />
  );
}

/**
 * The line under the row while tipping is on: what it will send, when, and
 * what it costs in confirmations — or why it will send nothing. Figures come
 * from who is actually tipped (`payable`), so a skipped share is not counted.
 * A total or shares the chips can't show were set in Settings → Tips, and the
 * line says so with the way there.
 */
function rowHint({
  config,
  quote,
  tokenOut,
  delivery,
  skipped,
  waiting,
  payable,
  listsRead,
}: {
  config: SpdexConfig;
  quote: QuoteResult | null;
  tokenOut: TokenInfo;
  delivery: TipDelivery;
  skipped: number;
  /** Someone chosen is waiting for the first-tip check. */
  waiting: boolean;
  payable: SpdexConfig["tips"];
  /** Whether the shipped list has been read: until it has, nobody counts as listed. */
  listsRead: boolean;
}): ReactNode {
  const chosen = config.tips.recipients;
  if (chosen.length === 0) return "Choose who gets it — nothing is sent until you do.";
  // Who is listed isn't known yet, so neither is who will be paid.
  if (!listsRead) return "Reading the tip list…";
  // Stated before the swap rather than discovered after it: a tip is an
  // ERC-20 transfer of what arrived, and ether is not one.
  if (isNative(tokenOut)) {
    return "Not on this swap: tips go out in the token you receive, and tipping in ETH isn't built yet.";
  }
  if (payable.recipients.length === 0) {
    return waiting ? "Nothing is sent until you check the address below." : "Nothing is sent yet: nobody chosen can be tipped.";
  }

  const total = recipientsTotal(payable.recipients);
  const parts: ReactNode[] = [
    // From the expected output, as the summary card's figure is. Execution
    // works it out again from what actually arrived, so a swap that delivers
    // less sends a smaller tip, never a bigger one.
    quote
      ? `≈ ${formatAmount(tipShareOf(quote.route.amountOut, total), tokenOut.decimals)} ${tokenOut.symbol} of this swap`
      : `${bpsText(total)} of what this swap delivers`,
  ];
  if (skipped > 0) parts.push(`${skipped} not tipped`);
  // No chip is pressed for a total set elsewhere, so the row says what it is
  // rather than leaving the chips blank.
  if (chipValue(config.tips) === "custom") {
    parts.push(
      <>
        {bpsText(recipientsTotal(chosen))} in total, set in <GoTo place="tips" />
      </>,
    );
  } else if (!isEvenSplit(chosen)) {
    parts.push(
      <>
        shares set in <GoTo place="tips" />
      </>,
    );
  }
  parts.push(delivery.kind === "batch" ? "sent in one transaction after it settles" : "sent separately after it settles");
  const cost = tipCostText(delivery);
  if (cost) parts.push(cost);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? " · " : null}
      {part}
    </Fragment>
  ));
}

/** "creator", "SIGNED" …: what a listed entry says about itself, in one line. */
function listedFacts(entry: DiscoveredRecipient, signed: boolean): string[] {
  const facts: string[] = [];
  if (entry.kind !== undefined) facts.push(entry.kind);
  // From the host's own constant, never from what a list says about itself.
  if (isSpdexOwnTipAddress(entry.address)) facts.push("spDEX's own");
  if (signed) facts.push("SIGNED");
  else if (entry.proof !== undefined) facts.push("PROOF LINK ONLY");
  return facts;
}

/**
 * Choosing who, inline under the row rather than in a dialog: the decision is
 * small, and a modal over the swap would hide the numbers it is about.
 *
 * Two lists, told apart: the people spDEX lists, and the person's own. The
 * full address is shown next to every name, grouped by four: a list maps a
 * name to an address and is not trusted to be honest about it, so the moment
 * of choosing is the moment to look, and the address is what is saved.
 */
function TipPicker({
  candidates,
  chainId,
  chosen,
  isChosen,
  onAdd,
  onClose,
}: {
  candidates: readonly DiscoveredRecipient[] | null;
  /** The network tips would be sent on: test entries are offered only on a local test network. */
  chainId: number;
  chosen: SpdexConfig["tips"]["recipients"];
  isChosen: (address: string) => boolean;
  onAdd: (candidate: TipCandidate) => void;
  onClose: () => void;
}) {
  const tips = useTips();
  const [adding, setAdding] = useState(false);
  const { offered, withheld } = offeredCandidates(candidates ?? [], chainId);
  const current = offered.filter((candidate) => candidate.retired === undefined);
  const visible = current.filter((candidate) => candidate.id === undefined || !tips.list.hiddenDefaults.includes(candidate.id));
  const available = visible.filter((candidate) => !isChosen(candidate.address));
  const listedAddress = (address: string) => current.some((entry) => entry.address.toLowerCase() === address.toLowerCase());
  // My tip list isn't tied to a network: an entry saved on the fork may be a
  // public test account, and nothing may be a contract a tip is lost in or
  // the connected account. Those are never offered here.
  const offerable = (address: string) =>
    !(isPublicDevAccount(address) && !isPlaceholderChain(chainId)) &&
    knownContract(address) === null &&
    (tips.account === null || tips.account.toLowerCase() !== address.toLowerCase());
  const mine = tips.list.mine.filter((entry) => !listedAddress(entry.address) && offerable(entry.address));
  const mineAvailable = mine.filter((entry) => !isChosen(entry.address));
  const placeholders = listsPlaceholders(offered);

  return (
    <div
      className="spdex-tippick"
      id="tip-picker"
      data-testid="tip-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="spdex-tippick__head">
        <span className="spdex-tippick__title">Who to tip</span>
        <button
          type="button"
          className="spdex-modal__close spdex-tippick__close"
          data-testid="tip-pick-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {placeholders ? (
        <Banner tone="warn" title="Test addresses" testId="tip-placeholder-notice">
          Entries named “Placeholder” are test addresses, not real people.
        </Banner>
      ) : null}

      <div className="spdex-tippick__section">
        {/* No count until the list is read: unread is not zero. */}
        <span className="spdex-tippick__label" data-testid="tip-listed-label">
          {candidates === null ? <>Listed in <Brand /></> : <>Listed in <Brand /> ({visible.length})</>}
        </span>
        {current.length > 0 ? (
          <span className="spdex-field__hint">
            <Term tip={WHY_LISTED}>Why these?</Term>
          </span>
        ) : null}
      </div>
      <div className="spdex-tippick__list" data-testid="tip-candidates">
        {candidates === null ? <p className="spdex-field__hint">Reading the list…</p> : null}
        {candidates !== null && current.length === 0 && withheld > 0 ? (
          <p className="spdex-field__hint" data-testid="tip-no-verified-list">
            {NO_VERIFIED_LIST}
          </p>
        ) : null}
        {candidates !== null && current.length === 0 && withheld === 0 ? (
          <p className="spdex-field__hint" data-testid="tip-no-listed">
            {NO_LISTED_YET}
          </p>
        ) : null}
        {visible.length > 0 && available.length === 0 ? (
          <p className="spdex-field__hint">Everyone listed is already chosen.</p>
        ) : null}
        {current.length > 0 && visible.length === 0 ? (
          <p className="spdex-field__hint" data-testid="tip-listed-hidden">
            You hid everyone listed. Manage, below, shows them again.
          </p>
        ) : null}
        {available.map((candidate) => {
          const key = candidate.address.toLowerCase();
          const facts = listedFacts(candidate, tips.signed.has(key));
          return (
            <div className="spdex-tippick__row" key={key} data-testid={`candidate-${key}`}>
              <div className="spdex-tippick__who">
                <div className="spdex-tippick__name">
                  {cleanTipText(candidate.label)}
                  {candidate.handle ? <span className="spdex-tippick__handle"> {cleanTipText(candidate.handle)}</span> : null}
                  {facts.length > 0 ? <span className="spdex-tippick__facts"> · {facts.join(" · ")}</span> : null}
                </div>
                <div className="spdex-tippick__address">
                  <GroupedHex value={candidate.address} />
                </div>
                {candidate.note || candidate.proof ? (
                  <div className="spdex-tippick__note">
                    {candidate.note ? cleanTipText(candidate.note) : null}
                    {candidate.note && candidate.proof ? " · " : null}
                    {candidate.proof ? (
                      <a href={candidate.proof} target="_blank" rel="noreferrer noopener" data-testid={`candidate-proof-${key}`}>
                        proof ↗
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Button variant="ghost" testId={`tip-add-${key}`} label={`Add ${cleanTipText(candidate.label)}`} onClick={() => onAdd(candidate)}>
                Add
              </Button>
            </div>
          );
        })}
      </div>

      <div className="spdex-tippick__section">
        <span className="spdex-tippick__label" data-testid="tip-mine-label">
          My tip list ({mine.length})
        </span>
        <GoTo place="tips" returnTo="here">
          Manage
        </GoTo>
      </div>
      <div className="spdex-tippick__list" data-testid="tip-mine">
        {mine.length === 0 ? <p className="spdex-field__hint">Nobody saved yet.</p> : null}
        {mine.length > 0 && mineAvailable.length === 0 ? <p className="spdex-field__hint">Everyone saved is already chosen.</p> : null}
        {mineAvailable.map((entry) => {
          const key = entry.address.toLowerCase();
          return (
            <div className="spdex-tippick__row" key={key} data-testid={`candidate-${key}`}>
              <div className="spdex-tippick__who">
                <div className="spdex-tippick__name">
                  {entry.name}
                  {entry.ens !== undefined ? <span className="spdex-tippick__facts"> · {entry.ens}</span> : null}
                  {entry.imported ? <span className="spdex-tippick__facts"> · imported</span> : null}
                </div>
                <div className="spdex-tippick__address">
                  <GroupedHex value={entry.address} />
                </div>
              </div>
              <Button variant="ghost" testId={`tip-add-${key}`} label={`Add ${entry.name}`} onClick={() => onAdd(mineCandidate(entry))}>
                Add
              </Button>
            </div>
          );
        })}
      </div>

      {adding ? (
        <AddTipAddress
          testId="tip-new"
          chosen={chosen}
          autoFocus
          onAdded={(entry) => {
            setAdding(false);
            onAdd(mineCandidate(entry));
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="spdex-inline-action spdex-tippick__new" data-testid="tip-new-open" onClick={() => setAdding(true)}>
          + Add an address or ENS name
        </button>
      )}

      <p className="spdex-field__hint spdex-tippick__foot">spDEX saves the address and checks every transfer before you sign.</p>
    </div>
  );
}
