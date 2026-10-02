/**
 * Settings → Tips: "My tip list", and the entries spDEX lists.
 *
 * The person's own addresses to tip, kept in this browser only
 * (lib/tiplist/store.ts): add by address or ENS name, name each, reorder with
 * buttons (no drag-only control), remove with a five-second Undo, export to a
 * file and import one back. The listed entries can be hidden from the picker
 * and shown again. Nothing here picks anyone or moves money: that is the Tip
 * row, and its first tip to a new address still asks.
 *
 * Removing someone who is chosen in the Tip row takes them out of it too
 * (the Tip row's chip is then shared by the rest, as its × does), and Undo
 * puts both back as they were: an address left chosen but gone from the list
 * would only say "Not in My tip list".
 *
 * Keyboard and screen reader: every control is a button or a field with a
 * visible label; the move buttons say whose place they change, stay focused
 * while their entry moves, and are `aria-disabled` rather than removed at the
 * ends so focus never drops to the page. What changed is said in a polite
 * live region. The two secondary parts are disclosures in one group, so one
 * is open at a time, as the Settings sections are.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Brand, Button, Disclosure, Term } from "@spdex/ui";
import { cleanTipText, type SpdexConfig, type TipPolicy, type TipRecipient } from "@spdex/core";
import { downloadText } from "../../lib/download.js";
import { mergeImported, type ImportSkip } from "../../lib/tiplist/checks.js";
import {
  exportTipList,
  hideDefault,
  MAX_IMPORT_BYTES,
  MAX_MINE,
  moveMine,
  readTipListFile,
  removeMine,
  restoreMine,
  showHiddenDefaults,
  TIPLIST_FILE,
  type Removed,
} from "../../lib/tiplist/store.js";
import { NO_LISTED_YET, offeredCandidates, removeTipRecipient, restoreTipRecipient } from "../../lib/tipRow.js";
import { GoTo } from "../../lib/places.js";
import { GroupedHex } from "../culture/ContractBadge.js";
import { AddTipAddress } from "./AddTipAddress.js";
import { useTips } from "./context.js";
import { MigratedBanner } from "./MigratedBanner.js";
import "./tips.css";

/** How long "Removed · Undo" stays. */
export const UNDO_MS = 5_000;

const WHERE_IT_LIVES =
  "Nobody else sees it: it isn't in your settings file or share links, and export is the only way it leaves. A chosen address is in your settings, labelled “My tip list”, never with your name for it.";

/** A removal, for Undo: the entry, and, if it was chosen in the Tip row, the tips before and after. */
interface RemovedHere extends Removed {
  chosen: { recipient: TipRecipient; index: number; before: TipPolicy; after: TipPolicy } | null;
}

export function MyTipList({ config, onChange }: { config: SpdexConfig; onChange: (next: SpdexConfig) => void }) {
  const tips = useTips();
  const { list, store } = tips;
  const chosen = config.tips.recipients;
  const [removed, setRemoved] = useState<RemovedHere | null>(null);
  const [live, setLive] = useState("");
  const [imported, setImported] = useState<{ added: number; skipped: ImportSkip[]; error?: string; unchecked?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  // Where focus goes once a removal, an undo or a hide has drawn: the
  // button pressed is gone, and focus left on nothing falls to the page. A
  // container (tabIndex -1), never a button that changes the list
  // (UI rule R2, docs/ARCHITECTURE.md).
  const [focusNext, setFocusNext] = useState<string | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    setFocusNext(null);
    rootRef.current?.querySelector<HTMLElement>(`[data-testid="${focusNext}"]`)?.focus();
  }, [focusNext]);

  // Undo lasts five seconds, then the removal stands.
  useEffect(() => {
    if (removed === null) return;
    const timer = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed]);

  const remove = (address: string, name: string) => {
    const result = removeMine(store.get(), address);
    if (result.removed === null) return;
    // Chosen in the Tip row: taken out there too, as its × would.
    const index = chosen.findIndex((recipient) => recipient.address.toLowerCase() === address.toLowerCase());
    let wasChosen: RemovedHere["chosen"] = null;
    if (index >= 0) {
      const dropped = removeTipRecipient(config, address);
      if (dropped.ok) {
        onChange(dropped.config);
        wasChosen = { recipient: chosen[index]!, index, before: config.tips, after: dropped.config.tips };
      }
    }
    store.set(result.state);
    setRemoved({ ...result.removed, chosen: wasChosen });
    setLive(wasChosen ? `Removed ${name}, and stopped tipping them.` : `Removed ${name}.`);
    setFocusNext("tiplist-undo");
  };
  const undo = () => {
    if (removed === null) return;
    store.set(restoreMine(store.get(), removed));
    if (removed.chosen !== null) {
      // Nothing else changed the tips since: exactly as they were. Otherwise
      // the person goes back in their place, with their old share if it fits.
      if (JSON.stringify(config.tips) === JSON.stringify(removed.chosen.after)) {
        onChange({ ...config, tips: removed.chosen.before });
      } else {
        const restored = restoreTipRecipient(config, removed.chosen.recipient, removed.chosen.index);
        if (restored.ok) onChange(restored.config);
      }
    }
    setLive(`${removed.entry.name} is back.`);
    setRemoved(null);
    setFocusNext(`tiplist-entry-${removed.entry.address.toLowerCase()}`);
  };
  const move = (address: string, name: string, delta: -1 | 1, index: number) => {
    const target = index + delta;
    if (target < 0 || target >= list.mine.length) return;
    store.set(moveMine(store.get(), address, delta));
    setLive(`${name} moved to ${target + 1} of ${list.mine.length}.`);
  };

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    // Checked before reading: a tip list is a few kilobytes.
    if (file.size > MAX_IMPORT_BYTES) {
      setImported({ added: 0, skipped: [], error: "That file is too big for a tip list." });
      return;
    }
    const read = readTipListFile(await file.text(), Date.now());
    if (!read.ok) {
      setImported({ added: 0, skipped: [], error: read.error });
      return;
    }
    const merged = mergeImported(
      store.get(),
      read.entries,
      { chainId: tips.chainId, account: tips.account, defaults: tips.defaults, chosen },
      MAX_MINE,
    );
    store.set(merged.state);
    // Before the shipped list is read, what came in wasn't compared with it:
    // said, and each is checked again before its first tip.
    setImported({ added: merged.added.length, skipped: merged.skipped, unchecked: tips.defaults === null });
    setLive(`Imported ${merged.added.length}.`);
  };

  const listed = offeredCandidates(tips.defaults ?? [], tips.chainId).offered.filter((entry) => entry.retired === undefined);
  const shown = listed.filter((entry) => entry.id === undefined || !list.hiddenDefaults.includes(entry.id));
  const hidden = listed.length - shown.length;

  return (
    <div className="spdex-tiplist" data-testid="tiplist" ref={rootRef}>
      <MigratedBanner />
      <div className="spdex-tiplist__head">
        <h4 className="spdex-tiplist__title" id={headingId}>
          My tip list ({list.mine.length})
        </h4>
        <span className="spdex-field__hint">
          <Term tip={WHERE_IT_LIVES}>This browser only</Term>
        </span>
      </div>
      {!store.canSave() ? (
        <p className="spdex-tiprow__error" data-testid="tiplist-unsaved">
          Can&apos;t save in this browser: the list lasts this visit. Export it to keep it.
        </p>
      ) : null}

      {list.mine.length === 0 ? (
        <p className="spdex-field__hint" data-testid="tiplist-empty">
          Nobody saved yet.
        </p>
      ) : (
        <ol className="spdex-tiplist__entries" aria-labelledby={headingId} data-testid="tiplist-mine">
          {list.mine.map((entry, index) => {
            const key = entry.address.toLowerCase();
            return (
              <li className="spdex-tiplist__entry" key={key} data-testid={`tiplist-entry-${key}`} tabIndex={-1}>
                <div className="spdex-tiplist__who">
                  <span className="spdex-tiplist__name">{entry.name}</span>
                  {entry.ens !== undefined ? <span className="spdex-tiplist__meta"> · {entry.ens}</span> : null}
                  {entry.imported ? <span className="spdex-tiplist__meta"> · imported</span> : null}
                  <span
                    className={`spdex-tiplist__state${entry.confirmed === undefined ? "" : " spdex-tiplist__state--ok"}`}
                    data-testid={`tiplist-state-${key}`}
                  >
                    {entry.confirmed === undefined ? "needs a check" : "checked"}
                  </span>
                  <GroupedHex value={entry.address} />
                  {entry.note !== undefined ? <span className="spdex-tiplist__note">{entry.note}</span> : null}
                </div>
                <div className="spdex-tiplist__actions">
                  <button
                    type="button"
                    className="spdex-tiplist__btn"
                    data-testid={`tiplist-up-${key}`}
                    aria-label={`Move ${entry.name} up`}
                    aria-disabled={index === 0 ? true : undefined}
                    onClick={() => move(entry.address, entry.name, -1, index)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="spdex-tiplist__btn"
                    data-testid={`tiplist-down-${key}`}
                    aria-label={`Move ${entry.name} down`}
                    aria-disabled={index === list.mine.length - 1 ? true : undefined}
                    onClick={() => move(entry.address, entry.name, 1, index)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="spdex-tiplist__btn spdex-tiplist__btn--remove"
                    data-testid={`tiplist-remove-${key}`}
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => remove(entry.address, entry.name)}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {removed !== null ? (
        <p className="spdex-tiplist__undo" data-testid="tiplist-undo" tabIndex={-1}>
          Removed {removed.entry.name}
          {removed.chosen !== null ? ", and no longer tipped" : ""} ·{" "}
          <button type="button" className="spdex-inline-action" data-testid="tiplist-undo-button" onClick={undo}>
            Undo
          </button>
        </p>
      ) : null}
      <p className="spdex-visually-hidden" role="status" aria-live="polite">
        {live}
      </p>

      <AddTipAddress testId="tiplist-add" chosen={chosen} onAdded={(entry) => setLive(`Added ${entry.name}.`)} />

      {/* No count until the list is read: unread is not zero. */}
      <Disclosure
        group="tips"
        testId="tiplist-listed"
        summary={tips.defaults === null ? <>Listed in <Brand /></> : <>Listed in <Brand /> ({shown.length})</>}
      >
        {tips.defaults === null ? (
          <p className="spdex-field__hint" data-testid="tiplist-listed-pending">
            {tips.rpc === null ? (
              <>
                Not read yet: spDEX reads it once you choose a <GoTo place="networkService">network service</GoTo>.
              </>
            ) : (
              "Reading the list…"
            )}
          </p>
        ) : null}
        {tips.defaults !== null && listed.length === 0 ? (
          <p className="spdex-field__hint" data-testid="tiplist-listed-empty">
            {NO_LISTED_YET}
          </p>
        ) : null}
        {shown.length > 0 ? (
          <ul className="spdex-tiplist__entries" data-testid="tiplist-listed-entries" tabIndex={-1} aria-label="Listed in spDEX">
            {shown.map((entry) => {
              const key = entry.address.toLowerCase();
              const name = cleanTipText(entry.label);
              return (
                <li className="spdex-tiplist__entry" key={key} data-testid={`tiplist-listed-${key}`}>
                  <div className="spdex-tiplist__who">
                    <span className="spdex-tiplist__name">{name}</span>
                    {entry.handle !== undefined ? <span className="spdex-tiplist__meta"> {cleanTipText(entry.handle)}</span> : null}
                    <GroupedHex value={entry.address} />
                  </div>
                  {entry.id !== undefined ? (
                    <div className="spdex-tiplist__actions">
                      <button
                        type="button"
                        className="spdex-tiplist__btn spdex-tiplist__btn--remove"
                        data-testid={`tiplist-hide-${key}`}
                        aria-label={`Hide ${name} from the picker`}
                        onClick={() => {
                          store.set(hideDefault(store.get(), entry.id!));
                          setLive(`${name} hidden.`);
                          setFocusNext(shown.length > 1 ? "tiplist-listed-entries" : "tiplist-listed-summary");
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {hidden > 0 ? (
          <Button
            variant="ghost"
            testId="tiplist-show-hidden"
            onClick={() => {
              store.set(showHiddenDefaults(store.get()));
              setLive("Hidden entries shown again.");
            }}
          >
            Show hidden ({hidden})
          </Button>
        ) : null}
      </Disclosure>

      <Disclosure group="tips" testId="tiplist-io" summary="Export or import">
        <p className="spdex-field__hint">A file of your addresses and names. Imported ones ask before their first tip.</p>
        <div className="spdex-actions">
          <Button
            variant="ghost"
            testId="tiplist-export"
            ariaDisabled={list.mine.length === 0}
            onClick={() => downloadText(TIPLIST_FILE, "application/json;charset=utf-8", exportTipList(store.get()))}
          >
            Export
          </Button>
          <Button variant="ghost" testId="tiplist-import" onClick={() => fileRef.current?.click()}>
            Import…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="spdex-visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="tiplist-import-file"
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
        {imported !== null ? (
          imported.error !== undefined ? (
            <p className="spdex-tiprow__error" role="alert" data-testid="tiplist-import-result">
              {imported.error}
            </p>
          ) : (
            <div data-testid="tiplist-import-result">
              <p className="spdex-field__hint">
                Added {imported.added}
                {imported.skipped.length > 0 ? ` · skipped ${imported.skipped.length}` : ""}.
                {imported.unchecked && imported.added > 0 ? " Not compared with the listed entries yet: each is checked before its first tip." : ""}
              </p>
              {imported.skipped.length > 0 ? (
                <ul className="spdex-tiplist__skipped">
                  {imported.skipped.map((skip) => (
                    <li key={skip.address}>
                      {skip.name}: {skip.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        ) : null}
      </Disclosure>
    </div>
  );
}
