/**
 * Adding an address to "My tip list": by address or by ENS name, with a
 * name, and every check said before it is saved.
 *
 * - An address must be 40 hex digits, and mixed case must be its EIP-55
 *   checksum: one wrong character in a pasted address is what a checksum
 *   catches.
 * - An ENS name is read through the person's own network service and nothing
 *   else (packages/chain/src/ens.ts): no CCIP-Read, no wildcard parents. The
 *   address it points at is shown in full and is what is saved. With a
 *   second opinion set, the name and the code at the address are read
 *   through it too, and a name the two disagree about is refused
 *   (lib/tiplist/lookup.ts).
 * - Refused outright: the zero and burn addresses, the person's own account,
 *   public test accounts off a test network, and contracts a token is lost in.
 * - Warned, each needing "Add anyway": lookalikes, a listed or saved name at
 *   another address, a name mixing alphabets, code at the address, a
 *   duplicate of a listed entry, and the shipped list not read yet
 *   (lib/tiplist/checks.ts). Each warning is a short title and its sentence;
 *   a lookalike shows the other address under this one.
 *
 * Nothing here moves money or picks anyone: saving is all it does. The first
 * tip to a saved address still asks (TipConfirm).
 *
 * Focus: the address field when the form opens from a button (a field, not a
 * control that changes anything: UI rule R2, docs/ARCHITECTURE.md); back to
 * it after Back, and after an add that leaves the form on screen.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Banner, Button, Term } from "@spdex/ui";
import { cleanTipText, tipNameProblem, type TipRecipient } from "@spdex/core";
import { addressInputProblem, looksLikeEnsName } from "@spdex/chain";
import { checksumAddress } from "../../lib/culture/contract.js";
import { addWarnings, refusalFor, type AddWarning, type CodeKind } from "../../lib/tiplist/checks.js";
import { readTipCode, resolveTipName } from "../../lib/tiplist/lookup.js";
import { addMine, MAX_NOTE, type MineEntry } from "../../lib/tiplist/store.js";
import { GroupedHex } from "../culture/ContractBadge.js";
import { useTips } from "./context.js";

/** Why an address is checked this way, one Tab away. */
const ADD_MEANING =
  "spDEX saves the address, never re-reads a name, and checks every transfer before you sign. An ENS name is read through your own network service only; a name kept off chain isn't followed.";

interface Review {
  address: `0x${string}`;
  ens?: string;
  /** The name was read through both services and they agreed. */
  checkedByBoth?: boolean;
  name: string;
  note?: string;
  warnings: AddWarning[];
}

export function AddTipAddress({
  testId,
  chosen,
  autoFocus = false,
  onAdded,
  onCancel,
}: {
  /** Prefix for every test id in the form. */
  testId: string;
  /** The recipients in the config, for the lookalike check. */
  chosen: readonly TipRecipient[];
  /** Focus the address field on mount: when a button just opened the form. */
  autoFocus?: boolean;
  /** After the entry is saved. */
  onAdded?: (entry: MineEntry) => void;
  onCancel?: () => void;
}) {
  const tips = useTips();
  const ids = { target: useId(), name: useId(), note: useId(), error: useId() };
  const targetRef = useRef<HTMLInputElement>(null);
  // Focus returns to the address field once the review it replaced is gone.
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (autoFocus) targetRef.current?.focus();
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    targetRef.current?.focus();
  }, [refocus]);
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);

  const reset = () => {
    setTarget("");
    setName("");
    setNote("");
    setError(null);
    setReview(null);
  };

  const save = (entry: Review) => {
    const added: MineEntry = {
      address: entry.address,
      name: entry.name,
      added: Date.now(),
      ...(entry.ens === undefined ? {} : { ens: entry.ens }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    };
    // Against the list as it is now: another tab may have added to it.
    const edit = addMine(tips.store.get(), added);
    if (!edit.ok) {
      setReview(null);
      setError(edit.error);
      return;
    }
    tips.store.set(edit.state);
    reset();
    // If the form stays (Settings), the next address starts where this one did.
    setRefocus(true);
    onAdded?.(added);
  };

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setReview(null);
    const typed = target.trim();
    if (typed === "") {
      setError("Paste an address or an ENS name.");
      return;
    }
    let address: `0x${string}`;
    let ens: string | undefined;
    let checkedByBoth = false;
    setBusy(true);
    try {
      if (looksLikeEnsName(typed)) {
        if (tips.rpc === null) {
          setError("Choose a network service first: spDEX reads ENS names only through yours.");
          return;
        }
        const found = await resolveTipName({ main: tips.rpc, second: tips.second }, typed);
        if (!found.ok) {
          setError(found.message);
          return;
        }
        address = checksumAddress(found.address);
        ens = found.name;
        checkedByBoth = found.checkedByBoth;
      } else {
        const problem = addressInputProblem(typed);
        if (problem === "checksum") {
          setError("Checksum doesn't match — likely a typo.");
          return;
        }
        if (problem !== null) {
          setError("That isn't an address or an ENS name.");
          return;
        }
        address = checksumAddress(typed);
      }

      const chosenName = cleanTipText(name) || (ens ?? "");
      const nameProblem = tipNameProblem(chosenName);
      if (nameProblem !== null) {
        setError(nameProblem);
        return;
      }
      const refusal = refusalFor(address, { chainId: tips.chainId, account: tips.account });
      if (refusal !== null) {
        setError(refusal);
        return;
      }
      const saved = tips.list.mine.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
      if (saved !== undefined) {
        setError(`Already in your list as ${saved.name}.`);
        return;
      }

      // Through the person's services, as everything else is. Unread is
      // said as unread, never as "no code".
      const code: CodeKind = tips.rpc === null ? "unknown" : await readTipCode({ main: tips.rpc, second: tips.second }, address);
      const cleanNote = cleanTipText(note).slice(0, MAX_NOTE);
      const entry: Review = {
        address,
        name: chosenName,
        warnings: addWarnings(address, chosenName, code, {
          chainId: tips.chainId,
          account: tips.account,
          defaults: tips.defaults,
          list: tips.list,
          chosen,
        }),
        ...(ens === undefined ? {} : { ens, checkedByBoth }),
        ...(cleanNote === "" ? {} : { note: cleanNote }),
      };
      // A name read through ENS is always shown before it is saved: the
      // address it points at is what money would follow.
      if (entry.warnings.length === 0 && ens === undefined) save(entry);
      else setReview(entry);
    } finally {
      setBusy(false);
    }
  };

  const danger = review?.warnings.some((warning) => warning.tone === "danger") ?? false;

  return (
    <form className="spdex-tipadd" data-testid={testId} onSubmit={(event) => void check(event)} noValidate>
      <div className="spdex-tipadd__fields">
        <label className="spdex-field spdex-tipadd__target">
          <span className="spdex-field__label">
            <Term tip={ADD_MEANING}>Address or ENS name</Term>
          </span>
          <input
            ref={targetRef}
            id={ids.target}
            className="spdex-input spdex-tipadd__mono"
            data-testid={`${testId}-target`}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setReview(null);
            }}
            placeholder="0x… or name.eth"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null ? true : undefined}
            aria-describedby={error !== null ? ids.error : undefined}
          />
        </label>
        <label className="spdex-field">
          <span className="spdex-field__label">Name</span>
          <input
            id={ids.name}
            className="spdex-input"
            data-testid={`${testId}-name`}
            value={name}
            maxLength={64}
            onChange={(event) => {
              setName(event.target.value);
              setReview(null);
            }}
            autoComplete="off"
          />
        </label>
        <label className="spdex-field">
          <span className="spdex-field__label">Note (optional)</span>
          <input
            id={ids.note}
            className="spdex-input"
            data-testid={`${testId}-note`}
            value={note}
            maxLength={MAX_NOTE}
            onChange={(event) => setNote(event.target.value)}
            autoComplete="off"
          />
        </label>
      </div>

      {error !== null ? (
        <p className="spdex-tiprow__error" role="alert" id={ids.error} data-testid={`${testId}-error`}>
          {error}
        </p>
      ) : null}

      {review !== null ? (
        <div className="spdex-tipadd__review" data-testid={`${testId}-review`}>
          <p className="spdex-tipadd__resolved" data-testid={`${testId}-resolved`}>
            {review.ens !== undefined ? `${review.ens} → ` : null}
            <GroupedHex value={review.address} />
            {review.ens !== undefined ? (review.checkedByBoth ? " (read via both your services)" : " (read via your service)") : null}
          </p>
          {review.warnings.map((warning) => (
            <Banner key={warning.kind} tone={warning.tone} title={warning.title} testId={`${testId}-warning-${warning.kind}`}>
              {warning.text}
              {warning.other !== undefined ? (
                <span className="spdex-tipadd__compare">
                  <span>{warning.other.name}:</span> <GroupedHex value={warning.other.address} />
                  <span>This one:</span> <GroupedHex value={review.address} />
                </span>
              ) : null}
            </Banner>
          ))}
          <div className="spdex-actions">
            {/* Changes a setting (UI rule R2): marked so no shortcut or reveal focuses it. */}
            <button
              type="button"
              className="spdex-button spdex-button--ghost"
              data-testid={`${testId}-accept`}
              data-money-control=""
              onClick={() => save(review)}
            >
              {review.warnings.length === 0 ? "Add" : danger ? "Add anyway — I checked" : "Add anyway"}
            </button>
            <Button
              variant="ghost"
              testId={`${testId}-back`}
              onClick={() => {
                setReview(null);
                setRefocus(true);
              }}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="spdex-actions">
          <button
            type="submit"
            className="spdex-button spdex-button--ghost"
            data-testid={`${testId}-submit`}
            data-money-control=""
            aria-disabled={busy ? true : undefined}
          >
            {busy ? "Checking…" : "Add to my list"}
          </button>
          {onCancel !== undefined ? (
            <Button variant="ghost" testId={`${testId}-cancel`} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      )}
    </form>
  );
}
