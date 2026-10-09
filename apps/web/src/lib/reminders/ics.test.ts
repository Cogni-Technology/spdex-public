import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import { slotOpensAt, type DcaPlan } from "@spdex/core";
import {
  calendarForm,
  calendarLinkHint,
  escapeText,
  foldLine,
  icsDate,
  icsFileName,
  nextReminderSlot,
  planToIcs,
  separateEventsHint,
  tooOftenHint,
} from "./ics.js";

const START = 1_790_000_000; // 2026-09-21T14:13:20Z
const NOW = START + 50_000;

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "daily-spx",
    label: "Daily SPX",
    paused: false,
    chainId: 1,
    sell: NATIVE_TOKEN,
    buy: TOKENS.SPX.address,
    amountPerBuy: "10000000000000000",
    intervalSeconds: 86_400,
    maxBuys: 69,
    startAt: START,
    signer: "wallet",
    ...overrides,
  };
}

/** The file's logical lines: unfolded, as a calendar app reads them. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n").filter((line) => line !== "");
const values = (ics: string, name: string) => unfold(ics).filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1));

const GOLDEN_DAILY = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//spDEX//auto-buy reminders//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "BEGIN:VEVENT",
  "UID:daily-spx-1@spdex.invalid",
  "DTSTAMP:20260922T040640Z",
  "SEQUENCE:29834166",
  "DTSTART:20260922T141320Z",
  "DURATION:PT15M",
  "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=60",
  "SUMMARY:spDEX: confirm your SPX buy",
  "DESCRIPTION:Buy SPX with 0.01 ETH. Plan: Daily SPX. Open spDEX and press Co",
  " nfirm buy on the plan's card. You can confirm any time until the next buy ",
  " time. A buy time you miss is skipped and the plan runs one buy time longer",
  " \\, which this calendar doesn't show.",
  "URL:https://example.org/spdex/",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:spDEX: a buy is due",
  "TRIGGER:PT0S",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("the repeating form", () => {
  it("is one daily event for a daily plan, starting at the next buy time: golden", () => {
    expect(planToIcs(plan(), { buysLeft: 60, nowSeconds: NOW, appUrl: "https://example.org/spdex/" })).toBe(GOLDEN_DAILY);
  });

  it("repeats weekly for whole weeks, and daily for other whole days", () => {
    const rule = (seconds: number) =>
      values(planToIcs(plan({ intervalSeconds: seconds }), { buysLeft: 9, nowSeconds: NOW, appUrl: null })!, "RRULE")[0];
    expect(rule(7 * 86_400)).toBe("FREQ=WEEKLY;INTERVAL=1;COUNT=9");
    expect(rule(14 * 86_400)).toBe("FREQ=WEEKLY;INTERVAL=2;COUNT=9");
    expect(rule(30 * 86_400)).toBe("FREQ=DAILY;INTERVAL=30;COUNT=9");
  });

  it("counts the buys the ledger says are left", () => {
    const ics = planToIcs(plan(), { buysLeft: 3, nowSeconds: NOW, appUrl: null })!;
    expect(values(ics, "RRULE")).toEqual(["FREQ=DAILY;INTERVAL=1;COUNT=3"]);
  });

  it("carries no link when the build gives none", () => {
    expect(values(planToIcs(plan(), { buysLeft: 3, nowSeconds: NOW, appUrl: null })!, "URL")).toEqual([]);
    expect(values(planToIcs(plan(), { buysLeft: 3, nowSeconds: NOW, appUrl: "javascript:alert(1)" })!, "URL")).toEqual([]);
    expect(values(planToIcs(plan(), { buysLeft: 3, nowSeconds: NOW, appUrl: "https://a.example/x\r\nATTACH:y" })!, "URL")).toEqual([]);
  });
});

describe("the separate form", () => {
  for (const hours of [1, 36]) {
    it(`holds the next 48 buy times of a plan every ${hours} hours, each its own event`, () => {
      const p = plan({ intervalSeconds: hours * 3_600 });
      const ics = planToIcs(p, { buysLeft: 100, nowSeconds: NOW, appUrl: null })!;
      const first = nextReminderSlot(p, NOW);
      expect(values(ics, "UID")).toHaveLength(48);
      expect(values(ics, "UID")[0]).toBe(`daily-spx-1-${first}@spdex.invalid`);
      expect(values(ics, "DTSTART")[0]).toBe(icsDate(slotOpensAt(p, first)));
      expect(values(ics, "DTSTART")[47]).toBe(icsDate(slotOpensAt(p, first + 47)));
      expect(values(ics, "RRULE")).toEqual([]);
    });
  }

  it("holds fewer when fewer buys are left", () => {
    const ics = planToIcs(plan({ intervalSeconds: 3_600 }), { buysLeft: 5, nowSeconds: NOW, appUrl: null })!;
    expect(values(ics, "UID")).toHaveLength(5);
  });
});

describe("no file", () => {
  it("for a plan every 7 minutes, a vault plan, or a plan with no buys left", () => {
    expect(planToIcs(plan({ intervalSeconds: 420 }), { buysLeft: 5, nowSeconds: NOW, appUrl: null })).toBeNull();
    expect(planToIcs(plan({ signer: "vault", paused: true }), { buysLeft: 5, nowSeconds: NOW, appUrl: null })).toBeNull();
    expect(planToIcs(plan(), { buysLeft: 0, nowSeconds: NOW, appUrl: null })).toBeNull();
    expect(calendarForm(plan({ intervalSeconds: 3_599 }), 1)).toEqual({ kind: "none", why: "too-often" });
    expect(calendarForm(plan({ intervalSeconds: 90_000 }), 1)).toEqual({ kind: "separate" });
  });
});

describe("the next buy time", () => {
  it("is the first to open from now, or the plan's first before it starts", () => {
    const p = plan();
    expect(nextReminderSlot(p, START - 10)).toBe(0);
    expect(nextReminderSlot(p, START)).toBe(0);
    expect(nextReminderSlot(p, START + 1)).toBe(1);
    expect(nextReminderSlot(p, START + 86_400)).toBe(1);
  });
});

describe("injection", () => {
  const hostile = "x\r\nATTACH:https://evil.example/a\r\nEND:VEVENT\r\nBEGIN:VEVENT\nUID:evil";

  it("keeps a hostile plan name inside one line of description", () => {
    for (const intervalSeconds of [86_400, 3_600]) {
      const ics = planToIcs(plan({ label: hostile, intervalSeconds }), { buysLeft: 100, nowSeconds: NOW, appUrl: null })!;
      const lines = unfold(ics);
      const events = intervalSeconds === 86_400 ? 1 : 48;
      expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(events);
      expect(lines.filter((line) => line === "END:VEVENT")).toHaveLength(events);
      expect(lines.some((line) => line.startsWith("ATTACH"))).toBe(false);
      expect(values(ics, "UID").every((uid) => uid.startsWith("daily-spx-1"))).toBe(true);
      // Every physical line is a property, a continuation, or nothing.
      for (const line of ics.split("\r\n")) expect(line === "" || line.startsWith(" ") || /^[A-Z-]+[:;]/.test(line)).toBe(true);
    }
  });

  it("escapes in the RFC's order and drops other control characters", () => {
    expect(escapeText("a\\b;c,d\r\ne\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
    expect(escapeText("tab\there\u0000\u007f\u2028\u2029.")).toBe("tabhere.");
  });

  it("folds at 75 octets without splitting a character", () => {
    const label = `${"é€😀,;\\".repeat(10)}abcd`.slice(0, 64);
    const ics = planToIcs(plan({ label }), { buysLeft: 1, nowSeconds: NOW, appUrl: null })!;
    const encoder = new TextEncoder();
    for (const line of ics.split("\r\n")) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    expect(ics).not.toContain("�");
    const description = values(ics, "DESCRIPTION")[0]!;
    expect(description).toContain(`Plan: ${escapeText(label)}.`);
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
    expect(foldLine("x".repeat(76))).toBe(`${"x".repeat(75)}\r\n x`);
  });

  it("puts no address or transaction hash in the file", () => {
    const ics = planToIcs(plan(), { buysLeft: 60, nowSeconds: NOW, appUrl: "https://example.org/" })!;
    expect(ics).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe("what the button says", () => {
  it("names the link before anything is downloaded, or says there is none", () => {
    expect(calendarLinkHint("https://example.org/spdex/")).toBe("The file links to https://example.org/spdex/.");
    expect(calendarLinkHint(null)).toBe("This build doesn't say where spDEX is published, so the file has no link.");
  });

  it("says how many buy times a file of separate events holds", () => {
    expect(separateEventsHint(100)).toBe(
      "Calendar apps don't repeat hourly reminders reliably, so this file holds the next 48 buy times. Download it again for more.",
    );
    expect(separateEventsHint(5)).toBe(
      "Calendar apps don't repeat hourly reminders reliably, so this file holds all 5 buy times left, each as its own event.",
    );
    expect(tooOftenHint({ intervalSeconds: 420 })).toBe(
      "A reminder every 7 minutes belongs in an open tab: turn on “Notify me when a buy is due”.",
    );
    expect(icsFileName(plan())).toBe("spdex-daily-spx.ics");
  });
});
