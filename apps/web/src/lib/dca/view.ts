/**
 * What a plan card, the auto-buys panel and the status strip say, as pure
 * functions of the plan, this browser's record of it and the runner's view.
 *
 * The runner (runner.ts) decides what a plan is doing; this file decides how
 * that reads to a person. It is kept apart from the components because the
 * mapping has an order that matters — `cardStatus` checks the plan's states
 * one after another and the first that matches wins (a record that can't be
 * read before anything else, because skipping is safer than buying twice) —
 * and an order is exactly the kind of rule that quietly breaks in JSX and is
 * easy to pin in a test.
 *
 * The rules format.ts keeps hold here too: a figure this browser can't read is
 * `null` (shown "unknown"), never 0, and a sentence never names a figure it
 * does not have.
 */

import { slotAt, slotOpensAt, type DcaPlan, type SpdexConfig } from "@spdex/core";
import type { PillStatus } from "@spdex/ui";
import { guardSentence } from "../errors.js";
import { networkLabel, networkName } from "../networks.js";
import type { Step } from "../steps.js";
import { formatAmount, tradedAs, type TokenInfo } from "../tokens.js";
import {
  amountLabel,
  averagePriceOf,
  baseUnits,
  everyLabel,
  formatSignificant,
  historyOf,
  PRICE_DECIMALS,
  shortAddress,
  tokenFor,
  tokenLabel,
  type AmountStyle,
  type HistoryEntry,
  type HistoryKind,
} from "./format.js";
import { canMoveStart, RUN_CODES, unsettledRun, type DcaLedgerEntry } from "./ledger.js";
import { LEASE_STALE_MS, type PlanState, type RunnerLease, type RunnerSnapshot } from "./runner.js";
import { formatCount } from "../money/format.js";

/** Below this an ether balance is dust: what a sweep can leave behind (0.000001 ETH). */

// ── The safety-test probe ─────────────────────────────────────────────────

/**
 * Whether the network service can run the safety test, as the UI tells it.
 * Starting a plan waits for a yes: every scheduled buy is checked first, and
 * on a service that can't run the check every buy would be skipped.
 * `unknown` is "couldn't tell" and is never treated as yes.
 */
export type SafetyState = "checking" | "available" | "unavailable" | "unknown";

// ── Time ──────────────────────────────────────────────────────────────────

/** "2d 4h", "3h 12m", "45m", "< 1m": a countdown for the big Next-buy figure. */
export function compactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "< 1m";
  const total = Math.floor(ms / 60_000);
  const days = Math.floor(total / 1_440);
  const hours = Math.floor((total % 1_440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function relativeTime(atMs: number, nowMs: number): string {
  const ago = Math.max(0, nowMs - atMs);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return plural(Math.floor(ago / 60_000), "minute");
  if (ago < 86_400_000) return plural(Math.floor(ago / 3_600_000), "hour");
  return plural(Math.floor(ago / 86_400_000), "day");
}

/** "Tue 14:05" in this device's time zone: when a buy is next due. */
export function weekdayClock(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(unixSeconds * 1000));
}

/** "Sep 22, 14:05": a history row's time. */
export function dateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

// ── Describing a plan ─────────────────────────────────────────────────────

/** The card's title: the plan's name, or "Buying SPX" (an unlisted token is named by address). */
export function cardTitle(plan: Pick<DcaPlan, "label" | "buy">): string {
  return plan.label ?? `Buying ${tokenLabel(plan.buy)}`;
}

/** "0.01 ETH every day", or "0.01 ETH once" for a one-buy plan. */
export function amountEvery(plan: Pick<DcaPlan, "sell" | "amountPerBuy" | "intervalSeconds" | "maxBuys">): string {
  const each = amountLabel(baseUnits(plan.amountPerBuy), plan.sell);
  return plan.maxBuys === 1 ? `${each} once` : `${each} ${everyLabel(plan.intervalSeconds)}`;
}

/**
 * Who approves each buy, as the terms line and the resume terms say it: the
 * owner, for every plan this tab runs (a vault plan's card says its own).
 */
export const SIGNER_PHRASE = "you approve each buy";

/** `dca-terms`: "0.01 ETH every day · you approve each buy". */
export function termsLine(plan: DcaPlan): string {
  return `${amountEvery(plan)} · ${SIGNER_PHRASE}`;
}

/** An amount of a token in its units, without the symbol ("0.03"), or null for an unlisted token. */
function bare(value: bigint, token: string): string | null {
  const info = tokenFor(token);
  return info ? formatAmount(value, info.decimals, { maxFraction: info.decimals }) : null;
}

/**
 * The progress bar's figures: buys made of the most, and what they spent of
 * the budget. Every buy is exact-input and a failed one isn't counted, so
 * spent is exactly buys × amount. With no record this browser can read, the
 * bar is empty and says "Buys made: unknown".
 */
export function progressFigures(
  plan: DcaPlan,
  entry: DcaLedgerEntry | null,
): { value: number | null; valueText: string | undefined } {
  // Labelled: the bar's own label is for screen readers, and a bare
  // "unknown" beside an empty bar said nothing about what was unknown.
  if (entry === null) return { value: null, valueText: "Buys made: unknown" };
  const perBuy = baseUnits(plan.amountPerBuy);
  const done = entry.buysDone;
  const base = `${formatCount(done)} of ${formatCount(plan.maxBuys)} buys`;
  if (perBuy === null) return { value: done, valueText: base };
  const spent = bare(perBuy * BigInt(done), plan.sell);
  const budget = bare(perBuy * BigInt(plan.maxBuys), plan.sell);
  return {
    value: done,
    valueText: spent === null || budget === null ? base : `${base} · ${spent} of ${budget} ${tokenLabel(plan.sell)}`,
  };
}

/**
 * "Bought": everything measured arriving, with "from 3 of 4 buys" when some
 * deliveries couldn't be read. `null` (shown "unknown") without a record.
 */
export function boughtStat(plan: DcaPlan, entry: DcaLedgerEntry | null): { value: string | null; hint: string | null } {
  if (entry === null) return { value: null, hint: null };
  if (entry.buysDone === 0) return { value: "none yet", hint: null };
  const measured = baseUnits(entry.measured.amountOut);
  const from = entry.measured.buys;
  if (measured === null || from === 0) return { value: null, hint: null };
  // Six significant digits for the big figure: eight decimals of SPX break
  // across lines at stat size, and the history keeps every buy's exact amount.
  const token = tokenFor(plan.buy);
  return {
    value: token ? `${formatSignificant(measured, token.decimals, 6)} ${token.symbol}` : amountLabel(measured, plan.buy),
    hint: from < entry.buysDone ? `from ${from} of ${entry.buysDone} buys` : null,
  };
}

/**
 * "Average rate": "1 ETH = 1,307.85 SPX", the One-time Rate format, so the
 * direction never flips between pairs. "—" before the first measured buy.
 */
export function averageStat(plan: DcaPlan, entry: DcaLedgerEntry | null): { value: string | null; hint: string | null } {
  const sell = tokenFor(plan.sell);
  const buy = tokenFor(plan.buy);
  if (entry === null) return { value: null, hint: null };
  if (!sell || !buy) return { value: "—", hint: null };
  const average = averagePriceOf(entry, sell.decimals, buy.decimals);
  if (average === null || average.buyPerSell === null) return { value: "—", hint: null };
  const hint =
    average.counted < average.confirmed
      ? `before network fees · from ${average.counted} of ${average.confirmed} buys`
      : "before network fees";
  return { value: `1 ${sell.symbol} = ${formatSignificant(average.buyPerSell, PRICE_DECIMALS, 6)} ${buy.symbol}`, hint };
}

// ── The card's state ──────────────────────────────────────────────────────

export type CardRow =
  | "unreadable"
  | "chain"
  | "token"
  | "done"
  | "feature-off"
  | "paused"
  | "no-safety"
  | "owner"
  | "due"
  | "halted"
  | "attention"
  | "not-started"
  | "buying"
  | "running"
  /** A vault plan: run by its vault on chain, not by this tab (`vaultCardStatus` in vault.ts says which state). */
  | "vault";

export interface CardStatus {
  row: CardRow;
  pill: PillStatus;
  /** The pill's word when the default one would say less ("Buy due" rather than "Your turn"). */
  pillLabel?: string;
  /** The `dca-status` line, or null when the card shows the last outcome there. */
  reason: string | null;
  /** A buy that waits for Confirm; `blocked` when the wallet can't make it now. */
  due?: { slot: number; endsAt: number; buyNumber: number; blocked: boolean };
}

export interface CardInput {
  plan: DcaPlan;
  config: Pick<SpdexConfig, "chainId"> & { dca: Pick<SpdexConfig["dca"], "enabled"> };
  /** This browser's record: the entry, null for none, or "unavailable" when the ledger can't be read. */
  entry: DcaLedgerEntry | null | "unavailable";
  /** The runner's state for the plan; undefined when no runner is running (Auto-buy off). */
  state: PlanState | undefined;
  account: `0x${string}` | null;
  safety: SafetyState;
  nowMs: number;
}

const attention = (row: CardRow, reason: string | null, extra: Partial<CardStatus> = {}): CardStatus => ({
  row,
  pill: "attention",
  reason,
  ...extra,
});

/**
 * Which state a plan's card is in, first match: its pill, and the one reason line.
 *
 * Panel-wide conditions (Auto-buy off, no safety test, wallet disconnected,
 * another tab leading) are said once on the panel, so here they only set the
 * pill and leave the last outcome on the line.
 */
export function cardStatus(input: CardInput): CardStatus {
  const { plan, config, state, account } = input;
  const entry = input.entry === "unavailable" ? null : input.entry;
  const unreadable =
    input.entry === "unavailable" ||
    (state?.kind === "attention" && (state.code === "ledger-unavailable" || state.code === "ledger-write"));
  if (unreadable) {
    return attention(
      "unreadable",
      "spDEX can't read this browser's record of this plan, so it won't buy. Skipping is safer than buying twice.",
    );
  }
  if (plan.chainId !== config.chainId) {
    return attention(
      "chain",
      `This plan is for ${networkLabel(plan.chainId)}; spDEX is on ${networkLabel(config.chainId)} now, so it won't buy here.`,
    );
  }
  const sell = tokenFor(plan.sell);
  const buy = tokenFor(plan.buy);
  if (!sell || !buy) {
    return attention("token", `Uses a token spDEX doesn't list (${!sell ? plan.sell : plan.buy}), so it won't buy.`);
  }
  if (tradedAs(sell).address === tradedAs(buy).address) {
    return attention("token", `${sell.symbol} and ${buy.symbol} are the same asset, so this plan won't buy: that's a wrap, not a buy.`);
  }
  if (state?.kind === "done" || (entry !== null && entry.buysDone >= plan.maxBuys && !unsettledRun(entry))) {
    return {
      row: "done",
      pill: "done",
      reason: `Finished: ${formatCount(plan.maxBuys)} of ${formatCount(plan.maxBuys)} bought.`,
    };
  }
  if (!config.dca.enabled) return { row: "feature-off", pill: "paused", reason: null };
  if (plan.paused) {
    return { row: "paused", pill: "paused", reason: "Paused. Nothing will be bought until you resume." };
  }
  if (input.safety === "unavailable" || input.safety === "unknown") return attention("no-safety", null);
  if (account !== null && entry !== null && entry.owner !== account.toLowerCase()) {
    return attention("owner", `This plan buys for ${shortAddress(entry.owner)}. Connect that wallet to continue.`);
  }
  if (state === undefined) return { row: "running", pill: "running", reason: null };

  switch (state.kind) {
    case "due":
      // A wallet plan's buy waiting for its owner is the plan working as
      // agreed (the wallet never opens by itself), so it is the person's
      // turn, not a fault.
      return {
        row: "due",
        pill: "action",
        pillLabel: "Buy due",
        reason: null,
        due: { slot: state.slot, endsAt: state.endsAt, buyNumber: (entry?.buysDone ?? 0) + 1, blocked: false },
      };
    case "not-started-here":
      return attention(
        "not-started",
        "This browser has no record of this plan, so it won't buy here. Start it here to count its buys from this browser.",
      );
    case "attention": {
      if (state.code === "halted") return attention("halted", state.reason);
      if (state.code === "owner-mismatch" && entry !== null) {
        return attention("owner", `This plan buys for ${shortAddress(entry.owner)}. Connect that wallet to continue.`);
      }
      if (state.code === "wallet-disconnected" || state.code === "wrong-network") {
        // Raised only while a buy is due: it still is, the wallet just can't
        // make it right now. The panel says why, once.
        const now = BigInt(Math.floor(input.nowMs / 1000));
        const slot = slotAt(plan, now) ?? 0;
        return {
          row: "due",
          pill: "action",
          pillLabel: "Buy due",
          reason: null,
          due: {
            slot,
            endsAt: Number(slotOpensAt(plan, slot + 1)),
            buyNumber: (entry?.buysDone ?? 0) + 1,
            blocked: true,
          },
        };
      }
      return attention("attention", state.reason);
    }
    case "buying":
      return { row: "buying", pill: "running", reason: null };
    case "paused":
      // The runner reports a plan whose config it hasn't caught up with as paused.
      return { row: "paused", pill: "paused", reason: "Paused. Nothing will be bought until you resume." };
    case "waiting":
    default:
      return { row: "running", pill: "running", reason: null };
  }
}

/**
 * The big "Next buy" figure and its hint. `value: null` reads "unknown" (the
 * record can't be read); "—" means there is no next buy to count down to.
 */
export function nextBuyStat(
  status: CardStatus,
  state: PlanState | undefined,
  nowMs: number,
): { value: string | null; hint: string | null } {
  switch (status.row) {
    case "unreadable":
      return { value: null, hint: null };
    case "done":
      return { value: "Done", hint: null };
    case "feature-off":
    case "paused":
      return { value: "Paused", hint: null };
    case "due":
      return { value: "Due now", hint: null };
    case "halted":
      return { value: "Stopped", hint: null };
    case "buying":
      return { value: "Buying…", hint: null };
    default:
      break;
  }
  if (state?.kind === "waiting") {
    const ms = state.nextAt * 1000 - nowMs;
    return ms <= 0
      ? { value: "< 1m", hint: weekdayClock(state.nextAt) }
      : { value: compactDuration(ms), hint: weekdayClock(state.nextAt) };
  }
  return { value: "—", hint: null };
}

/**
 * What the plan did last, for the reason line of a running plan:
 * "Bought 13.07 SPX for 0.01 ETH · 2 minutes ago", or "Waiting for the first
 * buy." when there is nothing yet.
 */
export function lastOutcome(entry: DcaLedgerEntry | null, plan: DcaPlan, nowMs: number): string {
  if (entry === null) return "Waiting for the first buy.";
  const latest = historyOf(entry, plan, undefined, 1, "rounded")[0];
  if (latest === undefined) return "Waiting for the first buy.";
  return `${historySentence(latest)} · ${relativeTime(latest.at, nowMs)}`;
}

// ── A buy in progress ─────────────────────────────────────────────────────

/**
 * The step a buy in progress is at, for `stepText` (steps.ts), which words it
 * exactly as a manual swap's.
 *
 * The deadline and whether a permission came first are read from the claimed
 * run in this browser's record: the claim is written before the first
 * signature, so by the time the wallet asks, the run is there. A scheduled buy
 * uses one market, which makes "(step i of n)" exact: a token buy is a permission
 * then the buy, or the buy alone when the allowance already covered it.
 */
export function buyingStep(
  state: PlanState | undefined,
  plan: DcaPlan,
  entry: DcaLedgerEntry | null,
): Step | null {
  if (state?.kind !== "buying") return null;
  const run = entry ? unsettledRun(entry) : undefined;
  switch (state.step) {
    case "quoting":
      return { kind: "quote" };
    case "checking":
      return { kind: "check" };
    case "approving":
      return { kind: "permission", symbol: tokenLabel(plan.sell), step: 1, of: 2 };
    case "swapping": {
      const approved = run?.steps?.includes("approve") ?? false;
      return { kind: "buy", deadline: run?.deadline ?? null, step: approved ? 2 : 1, of: approved ? 2 : 1 };
    }
    case "confirming":
    case "measuring":
      return { kind: "wait" };
    default:
      return { kind: "quote" };
  }
}

// ── The status strip and the page title ───────────────────────────────────

export interface StripCard {
  pill: PillStatus;
  due: boolean;
  /** Unix seconds of the next buy, when one is scheduled. */
  nextAt: number | null;
  /**
   * A vault whose buy is already due, waiting for whoever triggers it. It is
   * the plan working (its pill stays "running"), and not the person's turn,
   * so it is counted apart rather than as "due — confirm it below".
   */
  keeper?: boolean;
}

/**
 * The strip's auto-buy summary (`strip-dca`). Null with no plans.
 *
 * What asks for the person comes first, alone: a due buy, then plans that
 * need attention, then plans waiting to be funded. Otherwise it counts each
 * state — "2 running · next in 1h 12m · 1 paused" — so one finished plan
 * beside a paused one reads "1 paused · 1 done", not "all paused". A vault
 * whose buy is due is "waiting for a keeper", with no countdown: its time
 * has passed, and "next in < 1m" said otherwise for as long as nobody came.
 */
export function stripText(cards: readonly StripCard[], nowMs: number): string | null {
  if (cards.length === 0) return null;
  if (cards.some((card) => card.due)) return "buy due — confirm it below";
  const count = (pill: PillStatus) => cards.filter((card) => card.pill === pill).length;
  const attention = count("attention");
  if (attention > 0) return `${attention} need${attention === 1 ? "s" : ""} attention`;
  const funding = count("action");
  if (funding > 0) return `${funding} waiting for funding`;
  if (count("paused") === cards.length) return "all paused";
  if (count("done") === cards.length) return "all done";

  const parts: string[] = [];
  const running = cards.filter((card) => card.pill === "running" && card.keeper !== true);
  const keeper = cards.filter((card) => card.pill === "running" && card.keeper === true).length;
  if (running.length > 0) {
    const next = running
      .map((card) => card.nextAt)
      .filter((at): at is number => at !== null)
      .sort((a, b) => a - b)[0];
    parts.push(`${running.length} running`);
    if (next !== undefined) parts.push(`next in ${compactDuration(next * 1000 - nowMs)}`);
  }
  if (keeper > 0) parts.push(`${keeper} waiting for a keeper`);
  if (count("paused") > 0) parts.push(`${count("paused")} paused`);
  if (count("done") > 0) parts.push(`${count("done")} done`);
  return parts.join(" · ");
}

/**
 * The "Auto-buys" tile header's summary, from what the panel already holds:
 * a pill when something asks for the person (BUY DUE, then NEEDS ATTENTION),
 * otherwise the strip's line ("2 running · next in 3h 12m"). A panel up only
 * for money outside any plan says what that money is.
 */
export function autoBuysSummary(input: {
  plans: number;
  buyDue: boolean;
  attention: boolean;
  stripText: string | null;
  /** Vaults on chain no plan points at, known or missing. */
  strayVaults: number;
}): { text: string; status?: PillStatus } {
  if (input.buyDue) return { text: "Buy due", status: "action" };
  if (input.attention) return { text: "Needs attention", status: "attention" };
  if (input.plans > 0 && input.stripText !== null) return { text: input.stripText };
  if (input.strayVaults > 0) return { text: input.strayVaults === 1 ? "vault not in your plans" : "vaults not in your plans" };
  return { text: "" };
}

// ── History ───────────────────────────────────────────────────────────────

/** Host codes are ours; anything else on a run is a Guard code, which the history explains. */
const HOST_CODES: ReadonlySet<string> = new Set(Object.values(RUN_CODES));

/** The Guard's codes on a run, in order, once each. */
export function guardCodes(entry: HistoryEntry): string[] {
  if (entry.source !== "run") return [];
  return [...new Set((entry.run.codes ?? []).filter((code) => !HOST_CODES.has(code)))];
}

/** Turn format.ts's "Skipped — why." into the history's "Skipped: why." */
function colon(text: string): string {
  return text.replace(/^(Skipped|Failed before anything was sent|On hold|Unknown|Interrupted) — /, "$1: ");
}

function withoutStop(text: string): string {
  return text.replace(/\.$/, "");
}

/**
 * One history row's sentence, without its date or number: the short "Skipped:
 * why" form the card uses for the common cases, and format.ts's (which knows
 * every code) for the rest.
 */
export function historySentence(entry: HistoryEntry): string {
  const kind: HistoryKind = entry.kind;
  switch (kind) {
    case "bought":
      return withoutStop(entry.text);
    case "missed": {
      const k = entry.source === "run" ? entry.run.missed : undefined;
      return k !== undefined && k > 0
        ? `${formatCount(k)} buy ${k === 1 ? "time" : "times"} passed while spDEX wasn't running: skipped, not made up.`
        : "Buy times passed while spDEX wasn't running: skipped, not made up.";
    }
    case "not-confirmed":
      return "Skipped: not confirmed in time.";
    case "skipped-by-user":
      return "Skipped by you.";
    case "declined":
      return "Declined in your wallet.";
    case "refused": {
      const code = guardCodes(entry)[0];
      return code === undefined ? colon(entry.text) : `Skipped: ${guardSentence(code)}`;
    }
    case "unverified":
      return "Skipped: the network service couldn't run the safety test, and an auto-buy is never made unchecked.";
    case "held-expired": {
      const fees = entry.source === "run" && entry.run.codes?.includes(RUN_CODES.FEE_CEILING);
      return `Skipped: held for ${fees ? "high network fees" : "a price check"} and not approved in time.`;
    }
    case "no-funds":
      // The run's own reason says whose balance was short (see `runLabel`).
      return colon(entry.text);
    case "private-unavailable":
      return "Skipped: your wallet can't send privately, and spDEX never sends an auto-buy publicly without asking. Turn Private sending off in Settings → Features.";
    case "relay-failed":
      return "Skipped: the private relay didn't take it, and spDEX never sends an auto-buy publicly without asking.";
    case "late-signature":
      return "Skipped: signed after its deadline, so spDEX didn't send it. No fee was spent.";
    case "failed":
      return entry.hashes.length > 0 ? "Failed on the network: nothing was bought; the network fee was spent." : colon(entry.text);
    case "interrupted":
      return "Interrupted: spDEX closed mid-buy. Checking the network…";
    case "funded":
    case "topped-up":
    case "withdrawn":
      return withoutStop(entry.text);
    default:
      return colon(entry.text);
  }
}

export interface HistoryRow {
  /** Stable while the list grows: counted from the oldest row kept. */
  seq: number;
  kind: HistoryKind;
  /** "#3 · Sep 22, 14:05 · Bought 13.07 SPX for 0.01 ETH", without the link. */
  text: string;
  /** The same row with every digit of every amount, when `text` rounded one. */
  exactText?: string;
  /** The Guard's codes behind a refusal, shown beside the sentence. */
  codes: string[];
  /** Every transaction of the row, in the order sent (the buy last). */
  hashes: readonly string[];
}

/**
 * The card's history, newest first. Only bought rows are numbered, counting
 * down from the plan's total so a trimmed record still numbers its newest buy
 * right. "Missed" has no date: it covers a stretch of time, not a moment.
 */
export function historyRows(
  entry: DcaLedgerEntry,
  plan: DcaPlan,
  options: { limit?: number; formatWhen?: (ms: number) => string; amounts?: AmountStyle } = {},
): HistoryRow[] {
  const when = options.formatWhen ?? dateTime;
  const style = options.amounts ?? "exact";
  const all = historyOf(entry, plan, undefined, Number.MAX_SAFE_INTEGER, style);
  const exact = style === "exact" ? all : historyOf(entry, plan, undefined, Number.MAX_SAFE_INTEGER, "exact");
  let number = entry.buysDone;
  const rows = all.map((row, index): HistoryRow => {
    const seq = all.length - index;
    let prefix: string;
    if (row.kind === "bought") {
      prefix = `#${Math.max(1, number)} · ${when(row.at)} · `;
      number -= 1;
    } else if (row.kind === "missed") {
      prefix = "";
    } else {
      if (row.source === "run" && row.run.status === "confirmed") number -= 1;
      prefix = `${when(row.at)} · `;
    }
    const text = `${prefix}${historySentence(row)}`;
    const precise = `${prefix}${historySentence(exact[index]!)}`;
    return {
      seq,
      kind: row.kind,
      text,
      ...(precise === text ? {} : { exactText: precise }),
      codes: guardCodes(row),
      hashes: row.hashes,
    };
  });
  return rows.slice(0, Math.max(0, options.limit ?? 50));
}

/**
 * A transaction's page on a block explorer — on Ethereum only. A fork or a
 * test network has no explorer spDEX can vouch for, and a link to the wrong
 * one would show nothing, or someone else's transaction.
 */
export function explorerUrl(chainId: number, hash: string): string | null {
  return chainId === 1 && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://etherscan.io/tx/${hash}` : null;
}

/**
 * An address's page on a block explorer — on Ethereum only, for the reason
 * `explorerUrl` is. A link the person follows, never a request the app makes.
 */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  return chainId === 1 && /^0x[0-9a-fA-F]{40}$/.test(address) ? `https://etherscan.io/address/${address.toLowerCase()}` : null;
}

// ── Balances ──────────────────────────────────────────────────────────────

/**
 * A balance for display: "0.0412 ETH", "less than 0.000001 ETH", "0 ETH", or
 * "unknown" when it couldn't be read.
 */
export function balanceText(value: bigint | null | undefined, token: TokenInfo | undefined): string {
  if (value === null || value === undefined || token === undefined) return "unknown";
  if (value === 0n) return `0 ${token.symbol}`;
  const smallest = token.decimals > 6 ? 10n ** BigInt(token.decimals - 6) : 1n;
  if (value < smallest) return `less than 0.000001 ${token.symbol}`;
  return `${formatAmount(value, token.decimals, { maxFraction: 6 })} ${token.symbol}`;
}

/** How many plans `next` would remove from `current`: the confirm before a reset, import or shared link. */
export function removedPlanCount(current: Pick<SpdexConfig, "dca">, next: Pick<SpdexConfig, "dca">): number {
  const kept = new Set(next.dca.plans.map((plan) => `${plan.chainId}:${plan.id}`));
  return current.dca.plans.filter((plan) => !kept.has(`${plan.chainId}:${plan.id}`)).length;
}

/** "This removes 2 auto-buys.": the confirm's sentence. */
export function removalText(count: number): string {
  return `This removes ${count} auto-buy${count === 1 ? "" : "s"}.`;
}

// ── Resuming ──────────────────────────────────────────────────────────────

export interface ResumeTermsInput {
  plan: DcaPlan;
  entry: DcaLedgerEntry | null;
  /** Who the buys go to: the record's owner, or the connected wallet for a plan this browser has no record of. */
  owner: string | null;
  expert: boolean;
  nowMs: number;
  formatWhen?: (ms: number) => string;
}

/**
 * The plan's terms in plain words, shown before a resume writes
 * `paused: false`: a standing order is agreed to again, not just unpaused. A
 * plan with no record here counts from zero, and says so in its own banner.
 */
export function resumeTerms(input: ResumeTermsInput): { terms: string; limit: string; next: string } {
  const { plan, entry } = input;
  const when = input.formatWhen ?? dateTime;
  const done = entry?.buysDone ?? 0;
  const left = Math.max(0, plan.maxBuys - done);
  const perBuy = baseUnits(plan.amountPerBuy);
  const every = plan.maxBuys === 1 ? "once" : everyLabel(plan.intervalSeconds);
  const terms =
    plan.maxBuys === 1
      ? `Buy ${tokenLabel(plan.buy)} with ${amountLabel(perBuy, plan.sell)} once.`
      : `Buy ${tokenLabel(plan.buy)} with ${amountLabel(perBuy, plan.sell)} ${every}, up to ${formatCount(plan.maxBuys)} times (${formatCount(left)} left).`;

  const committed = entry === null ? 0n : (baseUnits(entry.committed) ?? null);
  const budget = perBuy === null ? null : perBuy * BigInt(plan.maxBuys);
  const remaining = budget === null || committed === null ? null : budget > committed ? budget - committed : 0n;
  const network = input.expert ? networkLabel(plan.chainId) : networkName(plan.chainId);
  const to = input.owner === null ? "your wallet" : shortAddress(input.owner);
  const limit = `At most ${amountLabel(remaining, plan.sell)} more, plus network fees · delivered to ${to} · on ${network} · ${SIGNER_PHRASE}.`;

  const nowSeconds = Math.floor(input.nowMs / 1000);
  const slot = slotAt(plan, BigInt(nowSeconds));
  const unused = canMoveStart(entry ?? undefined) || (slot !== null && (entry?.lastSlot ?? -1) < slot);
  let next: string;
  if (plan.startAt > nowSeconds) next = `Next buy: ${when(plan.startAt * 1000)}.`;
  else if (unused) next = "Next buy: now — confirm it on this card.";
  else next = `Next buy: ${when(Number(slotOpensAt(plan, (slot ?? 0) + 1)) * 1000)}.`;
  return { terms, limit, next };
}

// ── The panel ─────────────────────────────────────────────────────────────

/**
 * The panel's heartbeat line. "Last checked 14:05" while a tab is looking; a
 * heartbeat older than a looking tab ever leaves is from a tab that stopped,
 * and says so, with its date when that wasn't today — a bare "20:34" from last
 * week reads as this evening.
 */
export function heartbeatText(lease: Pick<RunnerLease, "lastTick"> | null, nowMs: number): string {
  if (lease === null) return "Not checked yet";
  const at = new Date(lease.lastTick);
  const today = at.toDateString() === new Date(nowMs).toDateString();
  const when = today
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)
    : dateTime(lease.lastTick);
  return nowMs - lease.lastTick > LEASE_STALE_MS ? `Not running now · last checked ${when}` : `Last checked ${when}`;
}

/** Whether another tab (not a runner this page is replacing) is the one buying. */
export function otherTabLeads(snapshot: RunnerSnapshot | null): boolean {
  return snapshot !== null && snapshot.leader === "other-tab" && snapshot.lease?.thisTab !== true;
}
