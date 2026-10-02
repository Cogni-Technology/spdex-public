/**
 * Small pieces every auto-buy card uses: a result banner, a copy button, a
 * hash that copies itself, a transaction reference and an address.
 *
 * Kept here rather than in packages/ui because each knows something about
 * auto-buy (which explorer to trust, what a result line looks like), and the
 * primitives there carry the theme and nothing else.
 */

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Banner, Button, Term } from "@spdex/ui";
import type { DcaPlan } from "@spdex/core";
import type { Notice } from "../../lib/dca/useAutoBuy.js";
import { explorerUrl } from "../../lib/dca/view.js";
import { shortAddress } from "../../lib/dca/format.js";
import { copyText } from "../../lib/clipboard.js";
import { downloadText } from "../../lib/download.js";
import { shareableAppUrl } from "../../lib/links.js";
import { useTiles } from "../../lib/tiles.js";
import {
  CALENDAR_HINT,
  calendarForm,
  calendarLinkHint,
  icsFileName,
  planToIcs,
  separateEventsHint,
  tooOftenHint,
} from "../../lib/reminders/ics.js";
import {
  NOTIFY_BLOCKED,
  NOTIFY_LABEL,
  NOTIFY_UNSUPPORTED,
  type BuyDueNotifications,
} from "../../lib/reminders/notify.js";
import "../records/records.css";
import "./dca.css";

/**
 * A card's result line, with the Guard codes beside the sentence and the raw
 * message folded away. One that answers a click made elsewhere (`arrive`) is
 * brought into view and given focus when it appears, so that its answer is
 * not off screen with focus left on nothing.
 */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const arrive = notice.arrive === true;
  const { reveal } = useTiles();
  useEffect(() => {
    // Opens the tile it is in, when that is closed, and focuses the banner's
    // own container: never a button inside it (UI rule R2, docs/ARCHITECTURE.md).
    if (arrive && ref.current !== null) void reveal(ref.current);
  }, [arrive, notice, reveal]);
  const banner = (
    <Banner tone={notice.tone} title={notice.title}>
      <p className="spdex-dca-line">
        {notice.text}
        {notice.codes?.map((code) => (
          <code key={code} className="spdex-dca-code">
            {code}
          </code>
        ))}
      </p>
      {notice.detail !== undefined && notice.detail !== notice.text ? (
        <details className="spdex-dca-detail">
          <summary>Details</summary>
          <code>{notice.detail}</code>
        </details>
      ) : null}
      {onDismiss ? (
        <div className="spdex-dca-actions">
          <Button variant="ghost" onClick={onDismiss}>
            OK
          </Button>
        </div>
      ) : null}
    </Banner>
  );
  return arrive ? (
    <div ref={ref} tabIndex={-1} className="spdex-dca-arrive" data-testid="dca-notice-arrived">
      {banner}
    </div>
  ) : (
    banner
  );
}

/**
 * "ⓘ": the longer explanation of the sentence it ends, one hover, tap or Tab
 * away (a `Term`). The visible text stays one short sentence; the reason,
 * the rule or the breakdown behind it lives here. `label` is what a screen
 * reader hears for the mark ("Why?", "Breakdown"), before the explanation
 * itself. Put it after anything a test parses: the tip is text in the DOM.
 */
export function InfoTerm({ tip, label = "More", testId }: { tip: string; label?: string; testId?: string }) {
  return (
    <>
      {" "}
      <Term tip={tip} {...(testId === undefined ? {} : { testId })}>
        <span className="spdex-info" aria-hidden="true">
          ⓘ
        </span>
        <span className="spdex-visually-hidden">{label}</span>
      </Term>
    </>
  );
}

/**
 * Copies text, and says so. A browser that refuses the clipboard (an insecure
 * page, a denied permission) leaves the text to be selected by hand instead,
 * which the caller makes easy by showing it in full.
 */
export function CopyButton({ text, label = "Copy", testId }: { text: string; label?: string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => void copyText(text).then((copied) => setState(copied ? "copied" : "failed"));
  return (
    <span className="spdex-dca-copy">
      <Button variant="ghost" onClick={copy} {...(testId === undefined ? {} : { testId })}>
        {label}
      </Button>
      {state === "copied" ? <span className="spdex-dca-hint">Copied.</span> : null}
      {state === "failed" ? <span className="spdex-dca-hint">Couldn't copy; select it and copy it yourself.</span> : null}
    </span>
  );
}

/**
 * A line of parts joined by " · " ("0.0033 WETH · covers every buy left")
 * that wraps between its parts, each dot on the line it closes. Wrapping as
 * plain text on a phone, such a line broke inside a part or just before a
 * dot, and the next line began with it. Each part is its own inline block,
 * so a part that doesn't fit moves down whole and only a part wider than the
 * line wraps inside itself. The text is unchanged, character for character.
 */
export function Dotted({ text }: { text: string }) {
  const parts = text.split(" · ");
  return (
    <>
      {parts.map((part, index) =>
        index < parts.length - 1 ? (
          <Fragment key={index}>
            <span className="spdex-dotted">{`${part} ·`}</span>{" "}
          </Fragment>
        ) : (
          <span key={index} className="spdex-dotted">
            {part}
          </span>
        ),
      )}
    </>
  );
}

/**
 * `text`, then " ·", with the dot unable to start a line. The last word goes
 * in the unbreakable span with it: a span holding only " ·" still let Chrome
 * break at its start, before the space, and the dot led the next line.
 */
export function DotAfter({ text }: { text: string }) {
  const cut = text.lastIndexOf(" ") + 1;
  return (
    <>
      {text.slice(0, cut)}
      <span className="spdex-nobr">{`${text.slice(cut)} ·`}</span>
    </>
  );
}

/** A full address, set in mono so it can be read and compared character by character. */
export function AddressText({ address, testId }: { address: string; testId?: string }) {
  return (
    <span className="spdex-dca-address" data-testid={testId} title={address}>
      {address}
    </span>
  );
}

/** How long a copied hash shows its tick. */
const COPIED_MS = 1_600;

/**
 * A hash or an address that copies itself, whole, when clicked or tapped:
 * "0x1234…abcd" and a copy mark, or all of it (`full`) where it is there to
 * be read. The whole value is its tooltip; `what` ("transaction hash",
 * "address") is what a screen reader hears it copies.
 *
 * A tick and a lime fill say it was copied, and a screen reader hears
 * "Copied." A browser that refuses the clipboard gets the whole value shown
 * under it instead, to select by hand, as `CopyButton` leaves it.
 *
 * `testId` names the text, so a test reads what is shown; the button is
 * `${testId}-copy`. On a phone the button is a 44px target that keeps its
 * line's height (theme.css, `.spdex-copyhex`).
 */
export function CopyHex({ value, what, full = false, testId }: { value: string; what: string; full?: boolean; testId?: string }) {
  // Counted, so a second copy restarts the tick.
  const [said, setSaid] = useState<{ copied: boolean; n: number } | null>(null);
  useEffect(() => {
    if (said?.copied !== true) return;
    const timer = setTimeout(() => setSaid(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [said]);
  const copy = () => void copyText(value).then((copied) => setSaid((last) => ({ copied, n: (last?.n ?? 0) + 1 })));
  const copied = said?.copied === true;
  return (
    <span className={`spdex-copyhex${full ? " spdex-copyhex--full" : ""}`} data-copied={copied ? "true" : undefined}>
      <button type="button" className="spdex-copyhex__button" data-testid={testId === undefined ? undefined : `${testId}-copy`} onClick={copy}>
        <span className="spdex-visually-hidden">Copy the {what} </span>
        <span className="spdex-copyhex__face">
          <code className="spdex-copyhex__text" title={value} data-testid={testId}>
            {full ? value : shortAddress(value)}
          </code>
          <CopyMark done={copied} />
        </span>
      </button>
      <span className="spdex-visually-hidden" role="status">
        {copied ? "Copied." : ""}
      </span>
      {said?.copied === false ? (
        <span className="spdex-copyhex__fallback" role="status">
          Couldn&apos;t copy; select it and copy it yourself: <code>{value}</code>
        </span>
      ) : null}
    </span>
  );
}

/** Two sheets, one over the other; a tick once copied. Drawn, not a character a font may not have. */
function CopyMark({ done }: { done: boolean }) {
  return (
    <svg className="spdex-copyhex__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {done ? (
        <path d="M1.5 6.5 4.75 9.75 10.5 2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <>
          <rect x="3.75" y="0.75" width="7.5" height="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8.25 11.25h-7.5v-7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

/**
 * A transaction: its short hash, which copies it (`CopyHex`), and on
 * Ethereum a link to look it up ("View ↗"). spDEX doesn't invent an
 * explorer for a network it can't vouch for.
 */
export function TxRef({ chainId, hash, testId }: { chainId: number; hash: string; testId?: string }) {
  const url = explorerUrl(chainId, hash);
  return (
    <span className="spdex-dca-tx">
      <CopyHex value={hash} what="transaction hash" {...(testId === undefined ? {} : { testId })} />
      {url !== null ? (
        <a href={url} target="_blank" rel="noreferrer noopener" title={hash}>
          View ↗
        </a>
      ) : null}
    </span>
  );
}

// ── Reminders ─────────────────────────────────────────────────────────────

/**
 * "Add to calendar", opened: what the file holds and where it links, said
 * before anything is downloaded, and the one button that downloads it.
 * The file itself is lib/reminders/ics.ts.
 */
export function CalendarPanel({
  plan,
  buysLeft,
  onClose,
  appUrl = shareableAppUrl(),
}: {
  plan: DcaPlan;
  /** Buys the plan still has to make, by this browser's record. */
  buysLeft: number;
  onClose: () => void;
  appUrl?: string | null;
}) {
  const form = calendarForm(plan, buysLeft);
  const download = () => {
    const ics = planToIcs(plan, { buysLeft, nowSeconds: Math.floor(Date.now() / 1000), appUrl });
    if (ics !== null) downloadText(icsFileName(plan), "text/calendar;charset=utf-8", ics);
    onClose();
  };
  return (
    <div className="spdex-dca-inline" data-testid="dca-calendar-panel">
      <p className="spdex-dca-inline__title">Add the buy times to your calendar</p>
      <p className="spdex-dca-line">{CALENDAR_HINT}</p>
      {form.kind === "separate" ? <p className="spdex-dca-line">{separateEventsHint(buysLeft)}</p> : null}
      <p className="spdex-dca-line" data-testid="dca-calendar-link">
        {calendarLinkHint(appUrl)}
      </p>
      <div className="spdex-dca-actions">
        <Button testId="dca-calendar-download" disabled={form.kind === "none"} onClick={download}>
          Download calendar file
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The button and its panel together, for anywhere but a plan's card (whose
 * action row keeps its buttons in one line and its questions under them):
 * the "Auto-buy started" banner, say. A plan buying more often than hourly
 * gets the sentence that says why there is no file instead.
 */
export function AddToCalendar({
  plan,
  buysLeft,
  label = "Add to calendar",
  testId = "dca-calendar",
  onOpenChange,
}: {
  plan: DcaPlan;
  buysLeft: number;
  label?: string;
  testId?: string;
  /** The panel opened or closed: a banner holding the button stays while it is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const form = calendarForm(plan, buysLeft);
  if (form.kind === "none") {
    return form.why === "too-often" ? (
      <p className="spdex-dca-hint" data-testid={`${testId}-hint`}>
        {tooOftenHint(plan)}
      </p>
    ) : null;
  }
  return (
    <>
      <div className="spdex-dca-actions">
        <Button variant="ghost" testId={testId} expanded={open} onClick={() => setOpen(!open)}>
          {label}
        </Button>
      </div>
      {open ? <CalendarPanel plan={plan} buysLeft={buysLeft} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * "Notify me when a buy is due", with what stands in its way when something
 * does: a browser that can't, or one that blocks it for this site.
 */
export function NotifyWhenDue({ notifications }: { notifications: BuyDueNotifications }) {
  // The box shows the choice while the browser is asked, rather than
  // seeming to ignore the click until the answer comes back.
  const [asking, setAsking] = useState<boolean | null>(null);
  const hintId = useId();
  if (!notifications.supported) {
    return (
      <p className="spdex-dca-hint" data-testid="dca-notify-unsupported">
        {NOTIFY_UNSUPPORTED}
      </p>
    );
  }
  const change = (on: boolean) => {
    setAsking(on);
    void notifications.setEnabled(on).finally(() => setAsking(null));
  };
  return (
    <>
      <label className="spdex-dca-check spdex-dca-notify">
        <input
          type="checkbox"
          data-testid="dca-notify"
          checked={asking ?? notifications.enabled}
          disabled={asking !== null}
          aria-describedby={notifications.blocked ? hintId : undefined}
          onChange={(event) => change(event.currentTarget.checked)}
        />
        {NOTIFY_LABEL}
      </label>
      {notifications.blocked ? (
        <p className="spdex-dca-hint" id={hintId} data-testid="dca-notify-blocked">
          {NOTIFY_BLOCKED}
        </p>
      ) : null}
    </>
  );
}
