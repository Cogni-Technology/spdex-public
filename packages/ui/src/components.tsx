/**
 * The small set of primitives the app composes from.
 *
 * Kept deliberately thin — these carry the theme and nothing else. No state, no
 * data fetching, no opinions about swaps. A component library that knows about
 * routing would make the app harder to read, not easier.
 *
 * None of them holds React state: what each shows comes from its props, and
 * what the user does goes back out through a callback. Two leave a detail to
 * the browser on purpose. A `Disclosure` is open or closed as the user left it
 * until its `open` prop changes, and a `Term` marks its own element when Escape
 * hides its tooltip. Both are presentation, and React never reads either back.
 */

import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";

export function Panel({
  title,
  subtitle,
  children,
  testId,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="spdex-panel" data-testid={testId}>
      {title ? <h2 className="spdex-panel__title">{title}</h2> : null}
      {subtitle ? <p className="spdex-panel__subtitle">{subtitle}</p> : null}
      {children}
    </section>
  );
}

/**
 * A panel for something few people need on a given visit: only its title
 * shows until it is opened, so it costs the page one line. The title is a
 * heading inside the summary of a `<details>`, and `onToggle` says when it
 * opens, for a panel that reads nothing until then. As with a `Disclosure`,
 * `foldTestId` names the `<details>` and `${foldTestId}-summary` its title;
 * `attributes` are extra `data-` attributes on the panel itself.
 */
export function FoldedPanel({
  title,
  subtitle,
  children,
  testId,
  foldTestId,
  onToggle,
  attributes,
  group,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testId?: string;
  foldTestId?: string;
  onToggle?: (open: boolean) => void;
  attributes?: Record<`data-${string}`, string>;
  /** Folds sharing a group open one at a time (see `Disclosure`). */
  group?: string;
}) {
  return (
    <section className="spdex-panel spdex-panel--folded" data-testid={testId} {...attributes}>
      <details
        className="spdex-fold"
        name={group}
        data-testid={foldTestId}
        onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      >
        <summary className="spdex-fold__summary" data-testid={foldTestId === undefined ? undefined : `${foldTestId}-summary`}>
          <h2 className="spdex-panel__title">{title}</h2>
        </summary>
        {subtitle ? <p className="spdex-panel__subtitle">{subtitle}</p> : null}
        {children}
      </details>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="spdex-field">
      <span className="spdex-field__label">{label}</span>
      {children}
      {hint ? <span className="spdex-field__hint">{hint}</span> : null}
    </label>
  );
}

/**
 * A label and its value on one line. `label` takes a node rather than a
 * string so a glossary `Term` can sit in it; `testId` goes on the value.
 */
/**
 * spDEX, in its own case wherever it sits: inside a label the stylesheet
 * capitalises, the name still reads "spDEX", never "SPDEX".
 */
export function Brand() {
  return <span className="spdex-brand">spDEX</span>;
}

export function Row({ label, value, testId }: { label: ReactNode; value: ReactNode; testId?: string }) {
  return (
    <div className="spdex-row">
      <span className="spdex-row__label">{label}</span>
      <span className="spdex-row__value" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export type BannerTone = "ok" | "warn" | "danger";

/**
 * A titled notice.
 *
 * A danger banner is an `alert`, so a screen reader interrupts to announce it.
 * That is right for what the app puts in one: a Guard refusal, an error, an
 * account that forwards what it receives. The quieter tones stay `status`,
 * which waits its turn. Nothing but the role differs between tones here.
 */
export function Banner({
  tone,
  title,
  children,
  testId,
}: {
  tone: BannerTone;
  /** Usually a string; a node when the title carries a `Term` or a tag. */
  title: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={`spdex-banner spdex-banner--${tone}`}
      data-testid={testId}
      role={tone === "danger" ? "alert" : "status"}
    >
      <div className="spdex-banner__title">{title}</div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Toggle<T extends string>({
  options,
  value,
  onChange,
  testId,
  labelledBy,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  testId?: string;
  /**
   * The id of the visible label that names the choice ("View"). The buttons
   * then form a group with that name, so a screen reader hears "View,
   * Simple, pressed" rather than two unnamed pressed buttons.
   */
  labelledBy?: string;
}) {
  return (
    <div
      className="spdex-toggle"
      data-testid={testId}
      role={labelledBy === undefined ? undefined : "group"}
      aria-labelledby={labelledBy}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="spdex-toggle__option"
          aria-pressed={option.value === value}
          data-testid={`${testId ?? "toggle"}-${option.value}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "solid",
  testId,
  type = "button",
  label,
  expanded,
  ariaDisabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "solid" | "ghost";
  testId?: string;
  type?: "button" | "submit";
  /**
   * The name assistive technology reads, where the visible words are the same
   * on several buttons ("Add back to my plans" on each of three vault cards)
   * and only this says which one it is.
   */
  label?: string;
  /** For a button that opens a question under it: whether that is open now. */
  expanded?: boolean;
  /**
   * Unavailable for now but still focusable: `aria-disabled` rather than
   * `disabled`, so a keyboard user who pressed it keeps their place while it
   * is busy (a native disabled button drops focus to the page). A click does
   * nothing while it is set.
   */
  ariaDisabled?: boolean;
}) {
  return (
    <button
      type={type}
      className={variant === "ghost" ? "spdex-button spdex-button--ghost" : "spdex-button"}
      onClick={ariaDisabled ? undefined : onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={label}
      aria-expanded={expanded}
      aria-disabled={ariaDisabled ? true : undefined}
    >
      {children}
    </button>
  );
}

/**
 * The MODE chip: a visible label beside a black segmented switch.
 *
 * spx6900.com's colour-mode control, rebuilt as a general primitive. It is a
 * Toggle in a different coat on purpose: the same `${testId}-${value}` ids and
 * the same `aria-pressed` buttons, so anything that knows how to drive a
 * Toggle drives this. What differs is its job. A Toggle sits in the page and
 * changes what the page shows; a ModeSwitch is a small piece of chrome that
 * changes how everything looks, so it gets the source site's compact inverted
 * style rather than the Toggle's full-size one.
 *
 * `groupLabel` names the group for assistive technology when the visible label
 * is too terse to stand alone ("Mode" of what?). The visible label is hidden
 * from assistive technology either way, because the group's name already
 * carries it and a screen reader would otherwise say it twice.
 */
export function ModeSwitch<T extends string>({
  label,
  groupLabel,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  groupLabel?: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  testId?: string;
}) {
  return (
    <div className="spdex-mode" data-testid={testId}>
      <span className="spdex-mode__label" aria-hidden="true">
        {label}
      </span>
      <div className="spdex-mode__switch" role="group" aria-label={groupLabel ?? label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="spdex-mode__opt"
            aria-pressed={option.value === value}
            data-testid={`${testId ?? "mode"}-${option.value}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A section that can be folded away: a styled `<details>` and `<summary>`.
 *
 * Native rather than scripted, so it opens from the keyboard and announces
 * whether it is expanded with no code here, and in Chromium find-in-page opens
 * a closed one to show a match.
 *
 * `open` is applied when it *changes*, and the browser owns the state in
 * between: React writes the attribute only when the prop differs from the last
 * render, so it leaves a user's own click alone. That is exactly "open by
 * default in expert mode, but let me close it": pass `open={mode === "expert"}`.
 * A caller that needs to know the state (to remember it, say) passes
 * `onToggle`, which reports every change: the user's, and the prop's own, since
 * the browser fires `toggle` for both.
 *
 * Content inside a closed `<details>` is in the DOM but not rendered, so a test
 * that expects it to be visible has to open the disclosure first. The summary
 * gets `${testId}-summary` for that.
 *
 * `group` makes siblings of a kind an exclusive accordion: disclosures that
 * share it open one at a time. It is the browser's own `<details name>`, so it
 * needs no script, and a browser without it lets several open, which is
 * harmless. Opening one closes the other in the same group, and the browser
 * fires `toggle` on both.
 */
export function Disclosure({
  summary,
  children,
  open,
  onToggle,
  testId,
  group,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  testId?: string;
  group?: string;
}) {
  return (
    <details
      className="spdex-disclosure"
      open={open}
      name={group}
      data-testid={testId}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
    >
      <summary
        className="spdex-disclosure__summary"
        data-testid={testId === undefined ? undefined : `${testId}-summary`}
      >
        {summary}
      </summary>
      <div className="spdex-disclosure__body">{children}</div>
    </details>
  );
}

/**
 * A word with its plain-English meaning one hover, tap or Tab away.
 *
 * For the jargon the app cannot avoid (slippage, allowance, TWAP), explained
 * where the word is used rather than in a glossary nobody opens. The meaning is
 * a real element the word points at with `aria-describedby`, so a screen
 * reader reads the word and then the explanation. Showing and hiding it is CSS
 * alone: hover, or focus, which also covers a tap on a touch screen. Escape
 * hides it without moving focus, as WCAG 1.4.13 asks of anything that appears
 * on hover or focus. The first Escape is kept from bubbling, so inside the
 * features dialog it hides the tip rather than closing the dialog; the next one
 * closes the dialog as usual.
 *
 * Know one thing before putting a Term inside an element a test reads: the
 * meaning is text in the DOM, so it counts toward the parent's `textContent`
 * even while hidden. Playwright's `toContainText` reads `textContent`. A tip
 * mentioning "Refused" inside `guard-banner`, for instance, would break the
 * preview spec's `not.toContainText("Refused")`.
 */
export function Term({ children, tip, testId }: { children: ReactNode; tip: string; testId?: string }) {
  const tipId = useId();
  return (
    <span
      className="spdex-term"
      tabIndex={0}
      aria-describedby={tipId}
      data-testid={testId}
      onKeyDown={dismissTipOnEscape}
      onBlur={rearmTip}
    >
      {children}
      <span className="spdex-term__tip" role="tooltip" id={tipId}>
        {tip}
      </span>
    </span>
  );
}

function dismissTipOnEscape(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Escape") return;
  const term = event.currentTarget;
  if (term.dataset["dismissed"] !== undefined) return;
  term.dataset["dismissed"] = "";
  event.stopPropagation();
}

// Escape only reaches a focused term, so leaving it is what ends the dismissal:
// Tab back to the word and its meaning shows again.
function rearmTip(event: { currentTarget: HTMLElement }): void {
  delete event.currentTarget.dataset["dismissed"];
}

/**
 * How far along something is: a bar with a hazard-stripe fill, and the count
 * beside it.
 *
 * `value: null` means the count is not known, and the bar says "unknown". An
 * empty bar would claim "none yet", which is a different statement and possibly
 * a false one. The bar's width is clamped to the track; the text is not, so a
 * count that somehow ran past `max` shows as exactly that rather than as a
 * reassuring full bar.
 *
 * The `progressbar` role is on the track and the visible count is hidden from
 * assistive technology, because `aria-valuetext` already says the same thing
 * ("3 of 10" where the screen shows "3 / 10").
 */
export function Progress({
  value,
  max,
  label,
  valueText,
  testId,
}: {
  value: number | null;
  max: number;
  label: string;
  valueText?: string;
  testId?: string;
}) {
  const known = value !== null && Number.isFinite(value) && Number.isFinite(max) && max > 0;
  const clamped = known ? Math.min(Math.max(value, 0), max) : 0;
  // Compact on screen, words for a screen reader, which would say "slash".
  const shown = valueText ?? (known ? `${value} / ${max}` : "unknown");
  const spoken = valueText ?? (known ? `${value} of ${max}` : "unknown");
  return (
    <div className="spdex-progress" data-testid={testId}>
      <div
        className={`spdex-progress__track${known ? "" : " spdex-progress__track--unknown"}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Number.isFinite(max) && max > 0 ? max : undefined}
        aria-valuenow={known ? clamped : undefined}
        aria-valuetext={spoken}
      >
        {known && clamped > 0 ? (
          <div className="spdex-progress__fill" style={{ width: `${(clamped / max) * 100}%` }} />
        ) : null}
      </div>
      <span className="spdex-progress__value" aria-hidden="true">
        {shown}
      </span>
    </div>
  );
}

/**
 * `action` is the person's move in a normal flow — fund a new plan, confirm a
 * buy that is due — and `attention` is something wrong. Kept apart so the
 * alarm colour means a fault, not "your turn".
 */
export type PillStatus = "running" | "paused" | "done" | "action" | "attention";

const PILL_LABELS: Record<PillStatus, string> = {
  running: "Running",
  paused: "Paused",
  done: "Done",
  action: "Your turn",
  attention: "Needs attention",
};

/**
 * A status in one word, on a fill that matches it.
 *
 * Colour is never the only signal: every pill carries its word and a marker
 * shape of its own (stripes, bars, a solid square, a play arrow, a diamond),
 * so the five read apart in greyscale too. `data-status` gives tests a hook that does not
 * depend on the wording, which is uppercased by CSS and may change.
 */
export function Pill({ status, children, testId }: { status: PillStatus; children?: ReactNode; testId?: string }) {
  return (
    <span className={`spdex-pill spdex-pill--${status}`} data-status={status} data-testid={testId}>
      {children ?? PILL_LABELS[status]}
    </span>
  );
}

/**
 * One figure, big, with a small label above it.
 *
 * A `null` or `undefined` value renders the word "unknown" rather than a zero
 * or a dash, because that is what the app knows. As with `Row`, `testId` goes
 * on the value, so a test reads the figure without the label. Several stats
 * side by side go in a `<div className="spdex-statgrid">`.
 */
export function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  testId?: string;
}) {
  const unknown = value === null || value === undefined;
  return (
    <div className="spdex-stat">
      <span className="spdex-stat__label">{label}</span>
      <span className={`spdex-stat__value${unknown ? " spdex-stat__value--unknown" : ""}`} data-testid={testId}>
        {unknown ? "unknown" : value}
      </span>
      {hint ? <span className="spdex-stat__hint">{hint}</span> : null}
    </div>
  );
}

/**
 * One answer to a question that deserves more than a word: a card with a title,
 * a line saying what it does, and a line saying what it costs, around a real
 * radio button.
 *
 * The radio is the control and the card is its label. So the whole card is
 * clickable, the arrow keys move between cards that share a `name`, and a
 * screen reader announces "radio button, 1 of 2, checked". Wrap a set in
 * `<fieldset className="spdex-choices">` with a `<legend>` asking the
 * question; the legend is what names the group.
 *
 * The cost is required, not decoration. Every choice in this app that spends
 * something says what, on the card, before anyone picks it.
 *
 * `testId` goes on the card. Playwright's `check()` and `toBeChecked()` follow
 * a label to its control, so a test can treat the card as the radio.
 */
export function ChoiceCard<T extends string>({
  name,
  value,
  checked,
  onChange,
  title,
  description,
  cost,
  disabled,
  testId,
}: {
  name: string;
  value: T;
  checked: boolean;
  onChange: (value: T) => void;
  title: string;
  description: ReactNode;
  cost: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const className = `spdex-choice${checked ? " spdex-choice--checked" : ""}${disabled ? " spdex-choice--disabled" : ""}`;
  return (
    <label className={className} data-testid={testId}>
      <input
        type="radio"
        className="spdex-choice__input"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span className="spdex-choice__title">{title}</span>
      <span className="spdex-choice__description">{description}</span>
      <span className="spdex-choice__cost">{cost}</span>
    </label>
  );
}

/**
 * One section of the Settings tile: a `Disclosure` in the `settings` group,
 * so the sections open one at a time. Closed by default; the summary gets
 * `${testId}-summary`, as every disclosure's does.
 */
export function SettingsSection({
  testId,
  summary,
  children,
  onToggle,
}: {
  testId: string;
  summary: ReactNode;
  children: ReactNode;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <div className="spdex-settings-section">
      <Disclosure group="settings" testId={testId} summary={summary} {...(onToggle ? { onToggle } : {})}>
        {children}
      </Disclosure>
    </div>
  );
}

// ─── Tiles ─────────────────────────────────────────────────────────────────

/**
 * Where the arrow, Home and End keys move focus from the header of tile
 * `current`: the next or previous header (stepping over an open body, since
 * only headers are in `ids`), the first or the last. No wrap: at either end,
 * and for any other key, null, and the key does what it would anyway.
 */
export function tileKeyTarget(ids: readonly string[], current: string | null, key: string): string | null {
  if (ids.length === 0) return null;
  if (key === "Home") return ids[0]!;
  if (key === "End") return ids[ids.length - 1]!;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return null;
  if (key === "ArrowDown") return at + 1 < ids.length ? ids[at + 1]! : null;
  if (key === "ArrowUp") return at > 0 ? ids[at - 1]! : null;
  return null;
}

/** A tile header's summary: a few words built from state the page holds, and an optional pill. */
export interface TileSummaryView {
  text: string;
  status?: PillStatus;
}

/** "← Back to …" in the tile a link opened, for going back to where it was followed. */
export interface TileBack {
  /** The tile it shows in: the one the link opened. */
  tileId: string;
  /** What it goes back to: "Trade", "steps (2 of 4)". */
  label: string;
  onBack: () => void;
}

interface TileGroupState {
  openId: string | null;
  firstId: string | null;
  helpId: string;
  back: TileBack | null;
  onOpenChange: (id: string | null) => void;
  /** Set by a header click just before the change: where that header was, to keep it there. */
  anchor: MutableRefObject<{ id: string; top: number } | null>;
  /** Set by a tile that unmounted with focus inside it, so the group can put focus on a header. */
  lostFocus: MutableRefObject<string | null>;
}

const TileGroupContext = createContext<TileGroupState | null>(null);

const headerId = (id: string) => `tile-${id}-h`;

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

/**
 * The main page's tiles: a WAI-ARIA accordion, at most one open.
 *
 * Which one is open is the caller's state (`openId`, `onOpenChange`), never
 * this component's, so the page can open one from anywhere (`reveal`) and a
 * test can read it back. `ids` lists the tiles rendered, in order, for the
 * keyboard; the children are `Tile`s with those ids.
 *
 * Keys, all as React handlers so a child that stops a key (a `Term`'s first
 * Escape, a picker's) keeps it:
 *   - ↑ ↓ Home End on a header move between headers (`tileKeyTarget`);
 *     ↵ and Space are the button's own and toggle it;
 *   - Escape on an open tile's header closes it. Inside an open body it goes
 *     back one step, innermost first: it closes the open `<details>` around
 *     focus and focuses its summary; otherwise it follows the back chip if
 *     one shows; otherwise it closes the tile and focuses its header.
 *     Ignored in a field, when something else took the key, or while a modal
 *     dialog is open.
 *
 * No key here activates anything inside a body: a key can open or close a
 * tile and move focus between headers and summaries, never press a button
 * that asks the wallet or changes a setting.
 *
 * A tile that goes away with focus inside it (Welcome's Hide, a shared
 * receipt's Dismiss) hands focus to the header now in its place, or to the
 * one before it when it was last, rather than letting it fall to the page.
 */
export function TileGroup({
  ids,
  openId,
  onOpenChange,
  back = null,
  children,
  testId = "tiles",
  help = "Sections. Up and down arrows move between section headings; Enter opens one; Escape closes it.",
}: {
  ids: readonly string[];
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  back?: TileBack | null;
  children: ReactNode;
  testId?: string;
  help?: string;
}) {
  const helpId = `${useId()}tiles-help`;
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const lostFocus = useRef<string | null>(null);
  const lastIds = useRef(ids);
  const state: TileGroupState = { openId, firstId: ids[0] ?? null, helpId, back, onOpenChange, anchor, lostFocus };

  // After a commit that removed the tile focus was in: the header at its
  // index, or the last one. Never anything inside a body, so never a money
  // control (UI rule R2, docs/ARCHITECTURE.md).
  useLayoutEffect(() => {
    const gone = lostFocus.current;
    lostFocus.current = null;
    const before = lastIds.current;
    lastIds.current = ids;
    if (gone === null || ids.includes(gone)) return;
    const at = before.indexOf(gone);
    const next = at === -1 ? undefined : ids[Math.min(at, ids.length - 1)];
    if (next !== undefined) document.getElementById(headerId(next))?.focus();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target === null) return;
    const tile = target.closest<HTMLElement>(".spdex-tile");
    const id = tile?.dataset["tile"];
    if (!tile || id === undefined) return;
    const onHeader = target.classList.contains("spdex-tile__button");

    if (onHeader && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const next = tileKeyTarget(ids, id, event.key);
      if (next === null) return;
      event.preventDefault();
      document.getElementById(headerId(next))?.focus();
      return;
    }

    if (event.key !== "Escape") return;
    if (isEditable(target)) return;
    if (document.querySelector('[aria-modal="true"]') !== null) return;
    if (id !== openId) return;
    const header = document.getElementById(headerId(id));
    if (onHeader) {
      event.preventDefault();
      onOpenChange(null);
      return;
    }
    const body = tile.querySelector<HTMLElement>(":scope > .spdex-tile__body");
    const details = target.closest<HTMLDetailsElement>("details[open]");
    if (details && body?.contains(details)) {
      event.preventDefault();
      details.open = false;
      details.querySelector<HTMLElement>(":scope > summary")?.focus();
      return;
    }
    event.preventDefault();
    if (back !== null && back.tileId === id) {
      back.onBack();
      return;
    }
    onOpenChange(null);
    header?.focus();
  };

  return (
    <TileGroupContext.Provider value={state}>
      <div className="spdex-tiles" data-testid={testId} onKeyDown={onKeyDown}>
        <p id={helpId} className="spdex-visually-hidden">
          {help}
        </p>
        {children}
      </div>
    </TileGroupContext.Provider>
  );
}

/** Whether this browser supports `hidden="until-found"` (find-in-page opens the tile). */
const SUPPORTS_UNTIL_FOUND = typeof HTMLElement !== "undefined" && "onbeforematch" in HTMLElement.prototype;

/**
 * One row of a `TileGroup`: a header (chip, title, summary, +/×) and a body.
 *
 * The body stays mounted while closed, so what it runs (the auto-buy runner,
 * balances, a quote, an open wallet prompt) carries on, and its text stays in
 * the DOM. It is hidden with the `hidden` attribute, set here rather than as
 * a prop because React writes every truthy `hidden` as `hidden=""`: where the
 * browser supports it the value is "until-found", so find-in-page searches a
 * closed tile and opens it on a match (`beforematch`).
 *
 * Opening a tile closes the open one above it, which would pull the clicked
 * header up the page; the header is put back where it was, so the page does
 * not move under the pointer (if it would end up above the top, it goes to
 * the top instead). Instant, never smooth.
 */
export function Tile({
  id,
  chip,
  title,
  summary = null,
  children,
}: {
  id: string;
  chip: string;
  title: string;
  summary?: TileSummaryView | null;
  children: ReactNode;
}) {
  const group = useContext(TileGroupContext);
  if (group === null) throw new Error("Tile must be inside a TileGroup");
  const open = group.openId === id;
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const lostFocus = group.lostFocus;

  // Going away with focus inside (runs before the section leaves the DOM):
  // tell the group, which focuses a header once the commit is done.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    return () => {
      if (section !== null && section.contains(document.activeElement)) lostFocus.current = id;
    };
  }, [id, lostFocus]);
  const openRef = useRef(group.onOpenChange);
  openRef.current = group.onOpenChange;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (open) body.removeAttribute("hidden");
    else body.setAttribute("hidden", SUPPORTS_UNTIL_FOUND ? "until-found" : "");
  }, [open]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onBeforeMatch = () => openRef.current(id);
    body.addEventListener("beforematch", onBeforeMatch);
    return () => body.removeEventListener("beforematch", onBeforeMatch);
  }, [id]);

  const anchor = group.anchor;
  useLayoutEffect(() => {
    const pending = anchor.current;
    if (pending === null || pending.id !== id) return;
    anchor.current = null;
    const head = headRef.current;
    if (!head || typeof window === "undefined") return;
    const after = head.getBoundingClientRect().top;
    // Put back where it was, unless that was partly above the viewport: then
    // at the top, a little clear of the edge.
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const goal = pending.top < 0 ? 0.75 * rootSize : pending.top;
    if (after !== goal) window.scrollBy({ top: after - goal, behavior: "instant" });
  }, [open, id, anchor]);

  const summaryId = `tile-${id}-sum`;
  const describedBy = [summary?.text ? summaryId : null, group.firstId === id ? group.helpId : null]
    .filter(Boolean)
    .join(" ");
  const back = group.back !== null && group.back.tileId === id ? group.back : null;

  return (
    <section className="spdex-tile" data-tile={id} data-open={open ? "true" : "false"} ref={sectionRef}>
      <div className="spdex-tile__head" ref={headRef}>
        <h2 className="spdex-tile__heading">
          <button
            type="button"
            id={headerId(id)}
            className="spdex-tile__button"
            data-testid={`tile-${id}`}
            aria-expanded={open}
            aria-controls={`tile-${id}`}
            aria-describedby={describedBy === "" ? undefined : describedBy}
            onClick={() => {
              const top = headRef.current?.getBoundingClientRect().top;
              anchor.current = top === undefined ? null : { id, top };
              group.onOpenChange(open ? null : id);
            }}
          >
            <span className="spdex-tile__chip" aria-hidden="true">
              {chip}
            </span>
            <span className="spdex-tile__title">{title}</span>
          </button>
        </h2>
        <span className="spdex-tile__summary" id={summaryId} data-testid={`tile-${id}-summary`}>
          {summary?.text ? summary.status ? <Pill status={summary.status}>{summary.text}</Pill> : summary.text : null}
        </span>
        <span className="spdex-tile__toggle" aria-hidden="true">
          {open ? "×" : "+"}
        </span>
      </div>
      <div
        className="spdex-tile__body"
        id={`tile-${id}`}
        ref={bodyRef}
        role={open ? "region" : undefined}
        aria-labelledby={open ? headerId(id) : undefined}
      >
        <div className="spdex-tile__inner">
          {back ? (
            <button type="button" className="spdex-goto-back" data-testid="goto-back" onClick={back.onBack}>
              ← Back to {back.label}
            </button>
          ) : null}
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * The keyboard hints: `↑↓ TILES`, `↵ OPEN`, `ESC CLOSE`, stacked. Hidden from
 * assistive technology, which gets the same instruction from the tile group's
 * help text; shown only to a fine pointer that hovers (theme.css). Render it
 * once: the layout moves it, never a second copy.
 */
export function KeyHints({ testId = "key-hints" }: { testId?: string }) {
  return (
    <div className="spdex-keyhints" data-testid={testId} aria-hidden="true">
      <span className="spdex-keyhints__chip">
        <kbd>↑↓</kbd> Tiles
      </span>
      <span className="spdex-keyhints__chip">
        <kbd>↵</kbd> Open
      </span>
      <span className="spdex-keyhints__chip">
        <kbd>Esc</kbd> Close
      </span>
    </div>
  );
}
