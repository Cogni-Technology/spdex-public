/**
 * The disclaimer, before anything else on a first visit and again whenever
 * its text changes (`DISCLAIMER_VERSION`), and on demand from the footer.
 *
 * A modal: `useModal` traps focus and puts it back after, and the app behind
 * is `inert` while it shows. Its text box takes focus first, so ↓, PageDown
 * and Space scroll the text rather than continuing.
 *
 * Continuing stores the version and closes, and happens only once the gate
 * has been up for 400 ms (so a key or a tap meant for the page that was
 * loading doesn't dismiss it unread), on:
 *   - the Continue button;
 *   - a click outside the text box that also started outside it, with no
 *     text selected (a drag to select a sentence is not a dismissal). A
 *     click, never a pointerup: the mouse events after a pointerup would
 *     land on the page behind;
 *   - a key pressed on purpose (`keyContinues`): not Tab, a modifier, a
 *     shortcut, a held key, or a key that scrolls the text. The key is kept
 *     from the page, and so is its keyup.
 *
 * In review (the footer's Disclaimer), the same dialog closes on Esc, the
 * button or a click outside, and nothing is stored. Nothing here ever
 * focuses or presses a control on the page behind.
 */

import { useCallback, useEffect, useId, useRef } from "react";
import { DISCLAIMER_CHANGES, DISCLAIMER_SECTIONS, keyContinues } from "../../lib/disclaimer.js";
import { useModal } from "../useModal.js";

/** How long the gate must have been up before anything continues past it. */
export const ARM_MS = 400;

/** Keeps the keyup of a key that continued from reaching the page, once, then forgets it. */
function swallowKeyup(key: string): void {
  const swallow = (event: KeyboardEvent) => {
    if (event.key !== key) return;
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("keyup", swallow, true);
  };
  window.addEventListener("keyup", swallow, true);
  setTimeout(() => window.removeEventListener("keyup", swallow, true), 2_000);
}

export function DisclaimerGate({ review, onDone }: { review: boolean; onDone: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const armed = useRef(false);
  const pressStartedOutside = useRef(false);
  const titleId = useId();
  const chipId = useId();
  const hintId = useId();

  const done = useRef(onDone);
  done.current = onDone;
  const finish = useCallback(() => {
    if (armed.current) done.current();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      armed.current = true;
    }, ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  // Esc, through the modal's own handling: continue (first visit) or close (review).
  useModal(dialogRef, finish, { initialFocus: textRef });

  // Any key, from anywhere while the gate is up: the page behind is inert, so
  // nothing else can be listening for it.
  useEffect(() => {
    if (review) return;
    const onKey = (event: KeyboardEvent) => {
      if (!keyContinues(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!armed.current) return;
      swallowKeyup(event.key);
      done.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [review]);

  const outsideText = (target: EventTarget | null) => !(target instanceof Node && textRef.current?.contains(target));

  return (
    <div
      className="spdex-modal__backdrop spdex-gate__backdrop"
      data-testid="disclaimer-backdrop"
      onPointerDown={(event) => {
        pressStartedOutside.current = outsideText(event.target);
      }}
      onClick={(event) => {
        if (!pressStartedOutside.current || !outsideText(event.target)) return;
        if (event.target instanceof Element && event.target.closest("button")) return;
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        finish();
      }}
    >
      <div
        className="spdex-modal spdex-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={chipId}
        data-testid="disclaimer"
        data-review={review ? "true" : "false"}
        tabIndex={-1}
        ref={dialogRef}
      >
        {/* The brackets hold to their words, so a narrow phone breaks it only at the dot. */}
        <p className="spdex-gate__chip" id={chipId}>
          {"[\u00a0Community\u00a0project · read\u00a0first\u00a0]"}
        </p>
        <h2 className="spdex-gate__title" id={titleId}>
          Before you swap
        </h2>
        <div
          className="spdex-gate__text"
          ref={textRef}
          tabIndex={0}
          role="document"
          aria-label="Disclaimer text"
          data-testid="disclaimer-text"
        >
          <ol className="spdex-gate__points">
            {DISCLAIMER_SECTIONS.map((section) => (
              <li key={section.label}>
                <strong>{section.label}</strong> {section.text}
              </li>
            ))}
          </ol>
          <p className="spdex-gate__changes">
            <em>{DISCLAIMER_CHANGES}</em>
          </p>
        </div>
        <button
          type="button"
          className="spdex-button spdex-gate__continue"
          data-testid="disclaimer-continue"
          aria-describedby={hintId}
          onClick={finish}
        >
          {review ? "Close" : "Continue"} <span aria-hidden="true">↵</span>
        </button>
        <p className="spdex-gate__hint" id={hintId}>
          <span className="spdex-gate__hint--pointer">
            {review ? "or press Esc · click outside the text" : "or press any key · click outside the text"}
          </span>
          <span className="spdex-gate__hint--touch">or tap outside the text</span>
        </p>
      </div>
    </div>
  );
}
