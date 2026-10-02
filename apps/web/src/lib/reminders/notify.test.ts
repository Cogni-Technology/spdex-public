import { describe, expect, it } from "vitest";
import {
  onBuyDueClick,
  showBuyDue,
  BUY_DUE_BODY,
  BUY_DUE_TAG,
  BUY_DUE_TITLE,
  createBuyDueNotifier,
  NOTIFY_KEY,
  NOTIFY_PREF,
  type NotificationApi,
  type NotifyPermission,
} from "./notify.js";
import { readPref, writePref } from "../prefs.js";

/** A `Notification` that records what it was asked to show, and can be told to throw like Chrome on Android. */
function fakeApi(options: { permission?: NotifyPermission; answer?: NotifyPermission; throws?: boolean } = {}) {
  const shown: { title: string; options: Record<string, unknown>; closed: boolean }[] = [];
  let permission: NotifyPermission = options.permission ?? "granted";
  let asked = 0;
  class Fake {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      asked += 1;
      permission = options.answer ?? "granted";
      return permission;
    }
    onclick: ((this: unknown, event: unknown) => unknown) | null = null;
    readonly record: { title: string; options: Record<string, unknown>; closed: boolean };
    constructor(title: string, opts: Record<string, unknown>) {
      if (options.throws) throw new TypeError("Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
      this.record = { title, options: opts, closed: false };
      shown.push(this.record);
    }
    close() {
      this.record.closed = true;
    }
  }
  return { api: Fake as unknown as NotificationApi, shown, asked: () => asked };
}

const hidden = { visibilityState: "hidden" };
const visible = { visibilityState: "visible" };

describe("the buy-due notification", () => {
  it("fires once when a buy falls due while the tab is hidden, and says only what it must", () => {
    const { api, shown } = fakeApi();
    const notifier = createBuyDueNotifier({ Notification: api, document: hidden });
    notifier.update(false);
    notifier.update(true);
    notifier.update(true);
    notifier.update(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe(BUY_DUE_TITLE);
    // Nothing the browser would fetch: a title, a line and a tag.
    expect(shown[0]!.options).toEqual({ body: BUY_DUE_BODY, tag: BUY_DUE_TAG });
  });

  it("fires again for the next buy that falls due, and closes when the buy is no longer due", () => {
    const { api, shown } = fakeApi();
    const notifier = createBuyDueNotifier({ Notification: api, document: hidden });
    notifier.update(true);
    notifier.update(false);
    expect(shown[0]!.closed).toBe(true);
    notifier.update(true);
    expect(shown).toHaveLength(2);
  });

  it("never fires while the tab is visible, even for a buy that falls due then", () => {
    const { api, shown } = fakeApi();
    const doc = { visibilityState: "visible" };
    const notifier = createBuyDueNotifier({ Notification: api, document: doc });
    notifier.update(true);
    doc.visibilityState = "hidden";
    notifier.update(true);
    expect(shown).toHaveLength(0);
    expect(notifier.notify()).toBe(true);
    expect(createBuyDueNotifier({ Notification: api, document: visible }).notify()).toBe(false);
  });

  it("never fires without permission, and asks only when asked to", () => {
    const { api, shown, asked } = fakeApi({ permission: "default", answer: "denied" });
    const notifier = createBuyDueNotifier({ Notification: api, document: hidden });
    notifier.update(true);
    expect(shown).toHaveLength(0);
    expect(asked()).toBe(0);
    return notifier.request().then((answer) => {
      expect(answer).toBe("denied");
      expect(asked()).toBe(1);
    });
  });

  it("judges support without showing anything, and gives up on a browser whose notifications throw", () => {
    const { api, shown } = fakeApi({ throws: true });
    const notifier = createBuyDueNotifier({ Notification: api, document: hidden });
    expect(notifier.supported()).toBe(true);
    expect(shown).toHaveLength(0);
    notifier.update(true);
    expect(notifier.supported()).toBe(false);
    expect(notifier.permission()).toBe("unsupported");
    expect(createBuyDueNotifier({ document: hidden }).supported()).toBe(false);
  });

  it("brings the tab forward when clicked", () => {
    const { api } = fakeApi();
    let focused = 0;
    let made: { onclick: (() => void) | null } | null = null;
    const Capturing = new Proxy(api, {
      construct(target, args) {
        made = Reflect.construct(target, args) as { onclick: (() => void) | null };
        return made as object;
      },
    });
    const order: string[] = [];
    createBuyDueNotifier({
      Notification: Capturing,
      document: hidden,
      focus: () => {
        focused += 1;
        order.push("focus");
      },
      show: () => order.push("show"),
    }).update(true);
    made!.onclick!();
    expect(focused).toBe(1);
    // The tab comes forward first, then the page shows the due buy.
    expect(order).toEqual(["focus", "show"]);
  });

  it("lets the page say what a click shows, one handler at a time", () => {
    const calls: string[] = [];
    showBuyDue();
    const first = onBuyDueClick(() => calls.push("first"));
    showBuyDue();
    const second = onBuyDueClick(() => calls.push("second"));
    // Removing a handler that was already replaced leaves the current one.
    first();
    showBuyDue();
    second();
    showBuyDue();
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("the preference", () => {
  it("is on only when this browser said so, and never throws", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    expect(readPref(NOTIFY_PREF, storage)).toBe(false);
    writePref(NOTIFY_PREF, true, storage);
    expect(map.get(NOTIFY_KEY)).toBe("on");
    expect(readPref(NOTIFY_PREF, storage)).toBe(true);
    writePref(NOTIFY_PREF, false, storage);
    expect(map.has(NOTIFY_KEY)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    expect(readPref(NOTIFY_PREF, broken)).toBe(false);
    expect(() => writePref(NOTIFY_PREF, true, broken)).not.toThrow();
    expect(readPref(NOTIFY_PREF, null)).toBe(false);
  });
});
