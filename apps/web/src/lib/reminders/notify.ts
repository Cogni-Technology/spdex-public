/**
 * "Notify me when a buy is due": a notification from the open spDEX tab when
 * a plan's buy falls due while the person is looking at something else. The
 * same path, with its own words and its own tick, reminds a community keeper
 * that its SPX proof lapses soon (`PROOF_LAPSE_MESSAGE`, lib/reminders/lapse.ts).
 *
 * Only while spDEX is open in a tab. A reminder that reaches a closed browser
 * needs Web Push, and Web Push needs an application server and a push
 * service in between, which is a backend (AGENTS.md rule 5) and a third
 * party told when someone's buys are due. For a closed tab there is the
 * calendar file instead.
 *
 * - **It makes no request.** The notification has a title, a line and a tag,
 *   and nothing the browser would fetch to show it: no picture of any kind.
 * - **Permission is asked once, when the box is ticked,** and at no other
 *   moment. Nothing asks on load.
 * - **It fires once per buy that falls due, and only unseen:** when the page's
 *   "buy due" turns true while the tab is hidden. A buy that fell due in
 *   front of the person needs no notification; the page already shows it, as
 *   the tab title's "● Buy due" does.
 * - **Checking support shows nothing.** Some browsers have a `Notification`
 *   that throws when one is made from a page (Chrome on Android wants a
 *   service worker). Support is judged without making one, and a browser
 *   whose first notification throws is then treated as having none.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPrefStore, usePref, type Pref } from "../prefs.js";

export const NOTIFY_KEY = "spdex.notify.v1";

export const BUY_DUE_TITLE = "spDEX: a buy is due";
export const BUY_DUE_BODY = "Confirm it in the open spDEX tab.";
/** One notification at a time: a second due buy replaces the first rather than stacking. */
export const BUY_DUE_TAG = "spdex-buy-due";

/** What one kind of notification says: a title, a line, and the tag that keeps one of its kind at a time. Nothing to fetch. */
export interface NotifyMessage {
  title: string;
  body: string;
  tag: string;
}

export const BUY_DUE_MESSAGE: NotifyMessage = { title: BUY_DUE_TITLE, body: BUY_DUE_BODY, tag: BUY_DUE_TAG };

/** A community keeper's proof lapses within five days (decision 25 of docs/DESIGN.md). Its own tag: it never replaces a due buy's. */
export const PROOF_LAPSE_MESSAGE: NotifyMessage = {
  title: "spDEX: your SPX proof lapses soon",
  body: "Prove it again in Community keeping, under Help run the network.",
  tag: "spdex-proof-lapse",
};

export const NOTIFY_LABEL = "Notify me when a buy is due (while spDEX is open in a tab)";
export const NOTIFY_UNSUPPORTED = "This browser can't show notifications from a web page. The tab title still shows ● Buy due.";
export const NOTIFY_BLOCKED =
  "Your browser is blocking notifications from spDEX. To use this, allow them in the site's settings, then tick it again.";

export type NotifyPermission = "default" | "granted" | "denied";

/** One notification, as the page holds it. */
interface ShownNotification {
  close(): void;
  onclick: ((this: unknown, event: unknown) => unknown) | null;
}

/** The part of the `Notification` API this uses, injected so tests run without a browser. */
export interface NotificationApi {
  new (title: string, options: { body: string; tag: string }): ShownNotification;
  readonly permission: NotifyPermission;
  requestPermission(): Promise<NotifyPermission>;
}

export interface NotifierEnv {
  Notification?: NotificationApi;
  document: { readonly visibilityState: string };
  /** Brings the tab forward when the notification is clicked. */
  focus?: () => void;
  /** Then shows what it is about: on the page, the Auto-buys tile opened at the due buy (`onBuyDueClick`). */
  show?: () => void;
}

export interface BuyDueNotifier {
  /** Whether this browser can show one, judged without showing one. */
  supported(): boolean;
  permission(): NotifyPermission | "unsupported";
  /** Asks the browser for permission. The one place spDEX ever asks. */
  request(): Promise<NotifyPermission | "unsupported">;
  /** Shows the notification now, if permitted and the tab is hidden. True when it was shown. */
  notify(): boolean;
  /** The page's "buy due", each time it may have changed: fires on false → true, and closes on true → false. */
  update(due: boolean): void;
}

/**
 * A notifier for the page's "buy due", or for any other moment that turns
 * true while the tab is hidden, saying `message` (a due buy's, by default).
 * Every notification spDEX shows is made here, by one constructor, so one
 * check covers what each can ask the browser to fetch: nothing.
 */
export function createBuyDueNotifier(env: NotifierEnv, message: NotifyMessage = BUY_DUE_MESSAGE): BuyDueNotifier {
  let broken = false;
  let wasDue = false;
  let shown: ShownNotification | null = null;
  const api = () => (broken ? undefined : env.Notification);
  const supported = () => {
    const N = api();
    return typeof N === "function" && typeof N.requestPermission === "function";
  };
  const permission = (): NotifyPermission | "unsupported" => (supported() ? api()!.permission : "unsupported");

  const notify = (): boolean => {
    if (env.Notification === undefined || !supported() || env.Notification.permission !== "granted") return false;
    if (env.document.visibilityState === "visible") return false;
    try {
      // Constructed under its own name, so the no-requests scan
      // (no-requests.test.ts) sees a notification here and checks its options.
      const notification = new env.Notification(message.title, { body: message.body, tag: message.tag });
      notification.onclick = () => {
        env.focus?.();
        env.show?.();
        notification.close();
      };
      shown = notification;
      return true;
    } catch {
      broken = true;
      return false;
    }
  };

  return {
    supported,
    permission,
    async request() {
      if (!supported()) return "unsupported";
      try {
        return await api()!.requestPermission();
      } catch {
        return api()!.permission;
      }
    },
    notify,
    update(due) {
      if (due && !wasDue) notify();
      if (!due && wasDue) {
        shown?.close();
        shown = null;
      }
      wasDue = due;
    },
  };
}

// ─── The preference ───────────────────────────────────────────────────────────

/** On only when this browser said so; anything else, or storage that can't be read, is off. Off removes the key. */
export const NOTIFY_PREF: Pref<boolean> = {
  key: NOTIFY_KEY,
  parse: (raw) => raw === "on",
  format: (on) => (on ? "on" : null),
};

/**
 * What a click on the notification shows once the tab is in front: set by
 * the page (App opens the Auto-buys tile at the due buy), since the panel
 * that mounts the notifications knows nothing of the page's layout. One
 * handler for the page; setting another replaces it, and the returned
 * function removes it if it is still the one set.
 */
let buyDueClick: (() => void) | null = null;

export function onBuyDueClick(handler: () => void): () => void {
  buyDueClick = handler;
  return () => {
    if (buyDueClick === handler) buyDueClick = null;
  };
}

/** Runs the page's handler, if one is set: what a click on the notification does after focusing the tab. */
export function showBuyDue(): void {
  buyDueClick?.();
}

/**
 * The same for a proof-lapse reminder: the page opens Community keeping, or
 * with no handler set, the tab only comes forward.
 */
let proofLapseClick: (() => void) | null = null;

export function onProofLapseClick(handler: () => void): () => void {
  proofLapseClick = handler;
  return () => {
    if (proofLapseClick === handler) proofLapseClick = null;
  };
}

export function showProofLapse(): void {
  proofLapseClick?.();
}

function pageEnv(show: () => void): NotifierEnv {
  const N = (globalThis as { Notification?: NotificationApi }).Notification;
  return {
    ...(N === undefined ? {} : { Notification: N }),
    document: typeof document === "undefined" ? { visibilityState: "visible" } : document,
    focus: () => globalThis.focus?.(),
    show,
  };
}

/** One kind of notification the page offers: its words, the tick that turns it on, and what a click shows. */
export interface NotificationKind {
  message: NotifyMessage;
  pref: Pref<boolean>;
  show: () => void;
}

export const BUY_DUE_KIND: NotificationKind = { message: BUY_DUE_MESSAGE, pref: NOTIFY_PREF, show: showBuyDue };

export interface BuyDueNotifications {
  supported: boolean;
  /** Ticked: the person asked for them and the browser allows them. */
  enabled: boolean;
  /** The browser refuses them for this site. */
  blocked: boolean;
  /** Ticking asks for permission; unticking only stops them. */
  setEnabled(on: boolean): Promise<void>;
}

/**
 * The notifications for this page: fed the page's "buy due", and the state
 * the checkbox shows. Mounted once, where the plans are listed.
 */
export function useBuyDueNotifications(buyDue: boolean, env?: NotifierEnv): BuyDueNotifications {
  return useNotifications(buyDue, BUY_DUE_KIND, env);
}

/**
 * Notifications of one `kind`, fed whether its moment has come (`due`), and
 * the state its checkbox shows. Each kind has its own tick; the browser's
 * permission is the page's, asked when a box is ticked. `kind` is a module
 * constant: a new one makes a new notifier.
 */
export function useNotifications(due: boolean, kind: NotificationKind, env?: NotifierEnv): BuyDueNotifications {
  const notifier = useMemo(() => createBuyDueNotifier(env ?? pageEnv(kind.show), kind.message), [env, kind]);
  const [store] = useState(() => createPrefStore(kind.pref));
  const pref = usePref(store);
  const [permission, setPermission] = useState(() => notifier.permission());
  const enabled = pref && permission === "granted";
  const feed = useRef(notifier);
  feed.current = notifier;

  useEffect(() => {
    feed.current.update(enabled && due);
    // A notification that failed to show says the browser can't, after all.
    if (!notifier.supported()) setPermission("unsupported");
  }, [enabled, due, notifier]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      if (!on) {
        store.set(false);
        return;
      }
      const answer = await notifier.request();
      setPermission(answer);
      store.set(answer === "granted");
    },
    [notifier, store],
  );

  return { supported: permission !== "unsupported", enabled, blocked: permission === "denied", setEnabled };
}
