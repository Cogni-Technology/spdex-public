/**
 * A plan's buy times as a calendar file (RFC 5545), for "Add to calendar".
 *
 * A plan the person confirms needs them present at each buy time, and a buy
 * time nobody confirms is skipped. spDEX has no server to remind anyone, so
 * the reminder goes where people already keep their appointments: their own
 * calendar, as a file they download. Nothing is sent anywhere.
 *
 * - **Which form.** A plan that buys every whole number of days is one
 *   repeating event. One that buys every hour or more, but not in whole days,
 *   is its next 48 buy times as separate events: calendar apps don't repeat
 *   hourly reminders reliably. Under an hour there is no file, since a
 *   reminder every few minutes belongs in an open tab, and a vault plan gets
 *   none, since a vault needs nobody present.
 * - **What's in it:** the pair, the amount and the plan's name, and a link to
 *   where this build says spDEX is published, if it says. No address, key or
 *   transaction hash: a calendar is often synced to someone else's servers.
 * - **Injection-safe.** A plan's name is anyone's text, up to 64 characters,
 *   and arrives in shared settings links. Every text value is escaped as the
 *   RFC says (backslash, semicolon, comma, line breaks), other control
 *   characters are dropped, and lines are folded at 75 octets without
 *   splitting a character. A name holding a line break and `END:VEVENT`
 *   stays one line of description.
 * - **A download again replaces it.** Each event keeps its UID, and
 *   SEQUENCE rises with time, so a calendar that imports a newer file updates
 *   the events rather than adding a second set.
 */

import { slotAt, slotOpensAt, type DcaPlan } from "@spdex/core";
import { amountLabel, baseUnits, everyLabel, tokenLabel } from "../dca/format.js";
import { cardTitle } from "../dca/view.js";

/** The most buy times a file of separate events holds. */
export const ICS_MAX_EVENTS = 48;
const DAY = 86_400;
const HOUR = 3_600;

/** How a plan's buy times go into a calendar: one repeating event, separate ones, or none. */
export type CalendarForm =
  | { kind: "repeating"; rule: "DAILY" | "WEEKLY"; every: number }
  | { kind: "separate" }
  | { kind: "none"; why: "vault" | "too-often" | "finished" };

export function calendarForm(plan: Pick<DcaPlan, "signer" | "intervalSeconds">, buysLeft: number): CalendarForm {
  if (plan.signer === "vault") return { kind: "none", why: "vault" };
  if (!(buysLeft > 0)) return { kind: "none", why: "finished" };
  const seconds = plan.intervalSeconds;
  if (seconds >= DAY && seconds % DAY === 0) {
    const days = seconds / DAY;
    return days % 7 === 0 ? { kind: "repeating", rule: "WEEKLY", every: days / 7 } : { kind: "repeating", rule: "DAILY", every: days };
  }
  return seconds >= HOUR ? { kind: "separate" } : { kind: "none", why: "too-often" };
}

/**
 * The first buy time the file reminds of: the next one to open. One already
 * open has its reminder in the past, which no calendar would ring.
 */
export function nextReminderSlot(plan: Pick<DcaPlan, "startAt" | "intervalSeconds">, nowSeconds: number): number {
  const now = BigInt(Math.floor(nowSeconds));
  const slot = slotAt(plan, now);
  if (slot === null) return 0;
  return slotOpensAt(plan, slot) >= now ? slot : slot + 1;
}

// ─── Writing the file ─────────────────────────────────────────────────────────

/** A TEXT value, escaped in the RFC's order, with every other control character dropped. */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "");
}

const encoder = new TextEncoder();

/**
 * One content line, folded: at most 75 octets a line, each continuation led
 * by a space, and never inside a character's UTF-8 bytes.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      out.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** "20260917T214923Z". */
export function icsDate(unixSeconds: number | bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Only an http(s) address with no space or control character in it goes into the file; anything else is left out. */
export function safeUrl(url: string | null): string | null {
  return url !== null && /^https?:\/\/[^\s\u0000-\u001f\u007f\u2028\u2029]+$/.test(url) ? url : null;
}

export interface IcsOptions {
  /** Buys the plan still has to make: its most, less what this browser's record says it made. */
  buysLeft: number;
  /** Unix seconds, now. */
  nowSeconds: number;
  /** Where this build says spDEX is published (`shareableAppUrl`), or null. */
  appUrl: string | null;
}

/**
 * The calendar file for a plan the person confirms, or null when it gets
 * none: a vault plan, one with no buys left, or one buying more often than
 * hourly.
 */
export function planToIcs(plan: DcaPlan, options: IcsOptions): string | null {
  const form = calendarForm(plan, options.buysLeft);
  if (form.kind === "none") return null;
  const now = Math.floor(options.nowSeconds);
  const first = nextReminderSlot(plan, now);
  const buy = tokenLabel(plan.buy);
  const amount = amountLabel(baseUnits(plan.amountPerBuy), plan.sell);
  const url = safeUrl(options.appUrl);
  const description =
    `Buy ${buy} with ${amount}. Plan: ${cardTitle(plan)}. Open spDEX and press Confirm buy on the plan's card. ` +
    "You can confirm any time until the next buy time. A buy time you miss is skipped and the plan runs one buy time " +
    "longer, which this calendar doesn't show.";

  const event = (uid: string, slot: number, rule: string | null): string[] => [
    "BEGIN:VEVENT",
    `UID:${uid}@spdex.invalid`,
    `DTSTAMP:${icsDate(now)}`,
    `SEQUENCE:${Math.floor(now / 60)}`,
    `DTSTART:${icsDate(slotOpensAt(plan, slot))}`,
    "DURATION:PT15M",
    ...(rule === null ? [] : [rule]),
    `SUMMARY:${escapeText(`spDEX: confirm your ${buy} buy`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    ...(url === null ? [] : [`URL:${url}`]),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText("spDEX: a buy is due")}`,
    "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT",
  ];

  const events =
    form.kind === "repeating"
      ? event(`${plan.id}-${plan.chainId}`, first, `RRULE:FREQ=${form.rule};INTERVAL=${form.every};COUNT=${options.buysLeft}`)
      : Array.from({ length: Math.min(options.buysLeft, ICS_MAX_EVENTS) }, (_, i) =>
          event(`${plan.id}-${plan.chainId}-${first + i}`, first + i, null),
        ).flat();

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//spDEX//auto-buy reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** "spdex-daily-spx.ics". */
export function icsFileName(plan: Pick<DcaPlan, "id">): string {
  return `spdex-${plan.id}.ics`;
}

// ─── What the button says ─────────────────────────────────────────────────────

export const CALENDAR_HINT =
  "Downloads a calendar file with a reminder at each buy time. Your calendar app will see the pair, the amount and the plan's name; no address is in it. If you pause or delete the plan, delete the calendar event too.";

/** Which link the file will carry, said before anything is downloaded. */
export function calendarLinkHint(appUrl: string | null): string {
  const url = safeUrl(appUrl);
  return url === null ? "This build doesn't say where spDEX is published, so the file has no link." : `The file links to ${url}.`;
}

/** What the file holds when its buy times are separate events. */
export function separateEventsHint(buysLeft: number): string {
  const count = Math.min(buysLeft, ICS_MAX_EVENTS);
  return buysLeft > ICS_MAX_EVENTS
    ? `Calendar apps don't repeat hourly reminders reliably, so this file holds the next ${count} buy times. Download it again for more.`
    : `Calendar apps don't repeat hourly reminders reliably, so this file holds ${count === 1 ? "the one buy time left" : `all ${count} buy times left`}, each as its own event.`;
}

/** Said in place of the button for a plan that buys more often than hourly. */
export function tooOftenHint(plan: Pick<DcaPlan, "intervalSeconds">): string {
  return `A reminder ${everyLabel(plan.intervalSeconds)} belongs in an open tab: turn on “Notify me when a buy is due”.`;
}
