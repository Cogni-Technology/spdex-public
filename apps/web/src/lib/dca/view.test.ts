/**
 * The plan card's words: which state wins, the stats, the
 * strip, the history and the resume terms.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { DcaPlan } from "@spdex/core";
import { NATIVE_ETH } from "../tokens.js";
import { RUN_CODES, type DcaLedgerEntry, type DcaRun } from "./ledger.js";
import type { PlanState } from "./runner.js";
import {
  autoBuysSummary,
  averageStat,
  balanceText,
  boughtStat,
  buyingStep,
  cardStatus,
  compactDuration,
  explorerAddressUrl,
  explorerUrl,
  historyRows,
  lastOutcome,
  nextBuyStat,
  progressFigures,
  relativeTime,
  removedPlanCount,
  removalText,
  resumeTerms,
  stripText,
  heartbeatText,
  dateTime,
  termsLine,
  type CardInput,
} from "./view.js";

const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "dca-00000001",
    paused: false,
    chainId: 690069,
    sell: NATIVE_TOKEN,
    buy: TOKENS.SPX.address,
    amountPerBuy: (10n ** 16n).toString(),
    intervalSeconds: 86_400,
    maxBuys: 10,
    startAt: NOW_S - 3_600,
    signer: "wallet",
    ...overrides,
  };
}

function entry(overrides: Partial<DcaLedgerEntry> = {}): DcaLedgerEntry {
  return {
    planId: "dca-00000001",
    chainId: 690069,
    owner: OWNER,
    signer: OWNER,
    startedAt: NOW - 3_600_000,
    buysDone: 0,
    committed: "0",
    lastSlot: null,
    consecutiveFailures: 0,
    measured: { buys: 0, amountIn: "0", amountOut: "0" },
    runs: [],
    ...overrides,
  };
}

const bought = (slot: number, at: number, out = 1_307_000_000n): DcaRun => ({
  slot,
  at,
  status: "confirmed",
  amountIn: (10n ** 16n).toString(),
  amountOut: out.toString(),
  hashes: [`0x${String(slot).padStart(64, "a")}`],
});

function input(overrides: Partial<CardInput> = {}): CardInput {
  return {
    plan: plan(),
    config: { chainId: 690069, dca: { enabled: true } },
    entry: entry(),
    state: { kind: "waiting", nextAt: NOW_S + 3_600 },
    account: OWNER,
    safety: "available",
    nowMs: NOW,
    ...overrides,
  };
}

describe("which state a card is in", () => {
  it("is running with the last outcome by default", () => {
    expect(cardStatus(input())).toEqual({ row: "running", pill: "running", reason: null });
  });

  it("puts an unreadable record first: skipping is safer than buying twice", () => {
    const status = cardStatus(input({ entry: "unavailable", plan: plan({ chainId: 1 }) }));
    expect(status.row).toBe("unreadable");
    expect(status.pill).toBe("attention");
    expect(status.reason).toContain("Skipping is safer than buying twice.");
  });

  it("names both networks for a plan on another chain", () => {
    expect(cardStatus(input({ plan: plan({ chainId: 1 }) })).reason).toBe(
      "This plan is for Ethereum (chain 1); spDEX is on Local fork (chain 690069) now, so it won't buy here.",
    );
  });

  it("refuses an unlisted token and an ETH ↔ WETH plan", () => {
    const unlisted = "0x1111111111111111111111111111111111111111";
    expect(cardStatus(input({ plan: plan({ buy: unlisted }) })).reason).toBe(
      `Uses a token spDEX doesn't list (${unlisted}), so it won't buy.`,
    );
    expect(cardStatus(input({ plan: plan({ buy: TOKENS.WETH.address }) })).row).toBe("token");
  });

  it("says a finished plan is done before anything about pausing", () => {
    const status = cardStatus(input({ plan: plan({ paused: true }), entry: entry({ buysDone: 10 }) }));
    expect(status).toMatchObject({ row: "done", pill: "done", reason: "Finished: 10 of 10 bought." });
  });

  it("leaves Auto-buy off to the panel, and says paused plainly", () => {
    expect(cardStatus(input({ config: { chainId: 690069, dca: { enabled: false } }, state: undefined }))).toEqual({
      row: "feature-off",
      pill: "paused",
      reason: null,
    });
    expect(cardStatus(input({ plan: plan({ paused: true }), state: { kind: "paused" } })).reason).toBe(
      "Paused. Nothing will be bought until you resume.",
    );
  });

  it("marks every running card when the safety test can't run, and never counts 'couldn't tell' as yes", () => {
    expect(cardStatus(input({ safety: "unavailable" })).row).toBe("no-safety");
    expect(cardStatus(input({ safety: "unknown" })).pill).toBe("attention");
    expect(cardStatus(input({ safety: "checking" })).row).toBe("running");
  });

  it("asks for the plan's own wallet", () => {
    expect(cardStatus(input({ account: OTHER })).reason).toBe(
      "This plan buys for 0x7099…79c8. Connect that wallet to continue.",
    );
  });

  it("shows a due buy with its number, and keeps it due while the wallet is away", () => {
    const due = cardStatus(input({ entry: entry({ buysDone: 3 }), state: { kind: "due", slot: 0, endsAt: NOW_S + 60 } }));
    // The owner's turn in the normal flow, not a fault.
    expect(due).toMatchObject({ row: "due", pill: "action", pillLabel: "Buy due", due: { buyNumber: 4, blocked: false } });
    const away = cardStatus(
      input({ account: null, state: { kind: "attention", code: "wallet-disconnected", reason: "x" } }),
    );
    expect(away).toMatchObject({ row: "due", pill: "action", due: { blocked: true } });
  });

  it("maps halted, not-started-here, and a record an old autopilot plan left", () => {
    expect(cardStatus(input({ state: { kind: "attention", code: "halted", reason: "Stopped after 3 buys." } })).reason).toBe(
      "Stopped after 3 buys.",
    );
    expect(cardStatus(input({ entry: null, state: { kind: "not-started-here" } })).row).toBe("not-started");
    // Set running by hand while its record still names the spending wallet.
    const old: PlanState = { kind: "attention", code: "old-signer", reason: "This plan used to buy with a spending wallet." };
    expect(cardStatus(input({ state: old }))).toMatchObject({ row: "attention", pill: "attention", reason: old.reason });
  });
});

describe("the stats", () => {
  it("counts down to the next buy from the wall clock", () => {
    const status = cardStatus(input());
    expect(nextBuyStat(status, { kind: "waiting", nextAt: NOW_S + 3 * 3_600 + 12 * 60 }, NOW).value).toBe("3h 12m");
    expect(compactDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
    expect(compactDuration(45 * 60_000)).toBe("45m");
    expect(compactDuration(30_000)).toBe("< 1m");
  });

  it("says unknown for an unreadable record, never a countdown", () => {
    const status = cardStatus(input({ entry: "unavailable" }));
    expect(nextBuyStat(status, { kind: "waiting", nextAt: NOW_S + 60 }, NOW).value).toBeNull();
  });

  it("shows progress as buys and spend, or unknown without a record", () => {
    expect(progressFigures(plan(), entry({ buysDone: 3 }))).toEqual({
      value: 3,
      valueText: "3 of 10 buys · 0.03 of 0.1 ETH",
    });
    expect(progressFigures(plan(), null)).toEqual({ value: null, valueText: "Buys made: unknown" });
  });

  it("shows what was bought, measured, and says so when some couldn't be", () => {
    expect(boughtStat(plan(), entry())).toEqual({ value: "none yet", hint: null });
    const measured = entry({ buysDone: 3, measured: { buys: 2, amountIn: "20000000000000000", amountOut: "2614000000" } });
    expect(boughtStat(plan(), measured)).toEqual({ value: "26.14 SPX", hint: "from 2 of 3 buys" });
    const long = entry({ buysDone: 2, measured: { buys: 2, amountIn: "20000000000000000", amountOut: "1017517405" } });
    expect(boughtStat(plan(), long).value).toBe("10.1752 SPX");
    expect(boughtStat(plan(), null).value).toBeNull();
  });

  it("gives the average as 1 SELL = x BUY, and a dash before any buy", () => {
    expect(averageStat(plan(), entry()).value).toBe("—");
    const one = entry({ buysDone: 1, measured: { buys: 1, amountIn: "10000000000000000", amountOut: "1307000000" } });
    expect(averageStat(plan(), one)).toEqual({ value: "1 ETH = 1,307 SPX", hint: "before network fees" });
  });
});

describe("the status strip", () => {
  it("puts a due buy first, then attention, then the soonest next buy", () => {
    expect(stripText([], NOW)).toBeNull();
    expect(stripText([{ pill: "attention", due: true, nextAt: null }], NOW)).toBe("buy due — confirm it below");
    expect(
      stripText(
        [
          { pill: "attention", due: false, nextAt: null },
          { pill: "running", due: false, nextAt: NOW_S + 60 },
        ],
        NOW,
      ),
    ).toBe("1 needs attention");
    expect(
      stripText(
        [
          { pill: "running", due: false, nextAt: NOW_S + 7_200 },
          { pill: "running", due: false, nextAt: NOW_S + 3_600 + 60 * 12 },
        ],
        NOW,
      ),
    ).toBe("2 running · next in 1h 12m");
    // Every state is counted: one finished and one paused is not "all paused".
    expect(stripText([{ pill: "paused", due: false, nextAt: null }, { pill: "done", due: false, nextAt: null }], NOW)).toBe(
      "1 paused · 1 done",
    );
    expect(
      stripText(
        [
          { pill: "running", due: false, nextAt: NOW_S + 7_200 },
          { pill: "paused", due: false, nextAt: null },
        ],
        NOW,
      ),
    ).toBe("1 running · next in 2h 0m · 1 paused");
    expect(stripText([{ pill: "paused", due: false, nextAt: null }], NOW)).toBe("all paused");
    expect(stripText([{ pill: "done", due: false, nextAt: null }], NOW)).toBe("all done");
    // A vault whose buy is due waits for whoever triggers it: no countdown,
    // which read "next in < 1m" for as long as nobody came.
    expect(stripText([{ pill: "running", due: false, nextAt: null, keeper: true }], NOW)).toBe("1 waiting for a keeper");
    expect(
      stripText(
        [
          { pill: "running", due: false, nextAt: NOW_S + 240, keeper: false },
          { pill: "running", due: false, nextAt: null, keeper: true },
        ],
        NOW,
      ),
    ).toBe("1 running · next in 4m · 1 waiting for a keeper");
    // A plan waiting to be funded is the next step, not a fault.
    expect(stripText([{ pill: "action", due: false, nextAt: null }, { pill: "running", due: false, nextAt: null }], NOW)).toBe(
      "1 waiting for funding",
    );
  });
});

describe("the Auto-buys tile's summary", () => {
  const base = { plans: 2, buyDue: false, attention: false, stripText: "2 running · next in 3h 12m", strayVaults: 0 };

  it("puts what asks for the person first, as a pill, and the strip's line otherwise", () => {
    expect(autoBuysSummary({ ...base, buyDue: true, attention: true })).toEqual({ text: "Buy due", status: "action" });
    expect(autoBuysSummary({ ...base, attention: true })).toEqual({ text: "Needs attention", status: "attention" });
    expect(autoBuysSummary(base)).toEqual({ text: "2 running · next in 3h 12m" });
  });

  it("says what money outside any plan is there for", () => {
    const none = { ...base, plans: 0, stripText: null };
    expect(autoBuysSummary({ ...none, strayVaults: 1 })).toEqual({ text: "vault not in your plans" });
    expect(autoBuysSummary({ ...none, strayVaults: 2 })).toEqual({ text: "vaults not in your plans" });
    expect(autoBuysSummary(none)).toEqual({ text: "" });
  });
});

describe("the heartbeat", () => {
  it("gives the time while a tab is looking, and the date once the looking stopped on another day", () => {
    expect(heartbeatText(null, NOW)).toBe("Not checked yet");
    expect(heartbeatText({ lastTick: NOW - 10_000 }, NOW)).toMatch(/^Last checked \d\d:\d\d$/);
    // Stopped a week ago: not "Last checked 20:34", which reads as today.
    const lastWeek = heartbeatText({ lastTick: NOW - 7 * 86_400_000 }, NOW);
    expect(lastWeek).toMatch(/^Not running now · last checked /);
    expect(lastWeek).toContain(dateTime(NOW - 7 * 86_400_000));
  });
});

describe("the history", () => {
  const when = (ms: number) => `t${(ms - NOW) / 1000}`;

  it("numbers bought rows only, newest first, and words each kind in the card's short form", () => {
    const runs: DcaRun[] = [
      bought(0, NOW),
      { slot: 1, at: NOW + 10_000, status: "skipped", amountIn: "0", hashes: [], codes: [RUN_CODES.MISSED], missed: 2 },
      bought(3, NOW + 20_000),
      { slot: 4, at: NOW + 30_000, status: "declined", amountIn: "1", hashes: [], codes: [RUN_CODES.DECLINED] },
      { slot: 5, at: NOW + 40_000, status: "skipped", amountIn: "1", hashes: [], codes: [RUN_CODES.SKIPPED_BY_USER] },
      { slot: 6, at: NOW + 50_000, status: "skipped", amountIn: "1", hashes: [], codes: ["SIMULATION_REVERTED"] },
      { slot: 7, at: NOW + 60_000, status: "skipped", amountIn: "1", hashes: [], codes: [RUN_CODES.NOT_CONFIRMED] },
    ];
    const rows = historyRows(entry({ buysDone: 2, runs }), plan(), { formatWhen: when });
    expect(rows.map((r) => [r.seq, r.kind, r.text])).toEqual([
      [7, "not-confirmed", "t60 · Skipped: not confirmed in time."],
      [6, "refused", "t50 · Skipped: The test run failed: this transaction wouldn't go through right now."],
      [5, "skipped-by-user", "t40 · Skipped by you."],
      [4, "declined", "t30 · Declined in your wallet."],
      [3, "bought", "#2 · t20 · Bought 13.07 SPX for 0.01 ETH"],
      [2, "missed", "2 buy times passed while spDEX wasn't running: skipped, not made up."],
      [1, "bought", "#1 · t0 · Bought 13.07 SPX for 0.01 ETH"],
    ]);
    expect(rows[1]!.codes).toEqual(["SIMULATION_REVERTED"]);
  });

  it("merges an old autopilot plan's transfers, and shows five in Simple when asked", () => {
    const rows = historyRows(
      entry({
        runs: [bought(0, NOW + 1)],
        buysDone: 1,
        transfers: [{ kind: "funded", at: NOW, amounts: [{ token: NATIVE_TOKEN, amount: "103521000000000000" }], hashes: [] }],
      }),
      plan(),
      { formatWhen: when, limit: 5 },
    );
    expect(rows.map((r) => r.text)).toEqual([
      "#1 · t0.001 · Bought 13.07 SPX for 0.01 ETH",
      "t0 · Funded the spending wallet with 0.103521 ETH",
    ]);
  });

  it("links a transaction only on Ethereum", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(explorerUrl(1, hash)).toBe(`https://etherscan.io/tx/${hash}`);
    expect(explorerUrl(690069, hash)).toBeNull();
  });

  it("links an address only on Ethereum, and only a whole one", () => {
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    expect(explorerAddressUrl(1, address)).toBe(`https://etherscan.io/address/${address.toLowerCase()}`);
    expect(explorerAddressUrl(690069, address)).toBeNull();
    expect(explorerAddressUrl(1, address.slice(0, 20))).toBeNull();
  });

  it("gives the last outcome with how long ago", () => {
    expect(lastOutcome(entry(), plan(), NOW)).toBe("Waiting for the first buy.");
    expect(lastOutcome(entry({ runs: [bought(0, NOW - 120_000)], buysDone: 1 }), plan(), NOW)).toBe(
      "Bought 13.07 SPX for 0.01 ETH · 2 minutes ago",
    );
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
  });
});

describe("a buy in progress", () => {
  const buying = (step: "approving" | "swapping" | "confirming"): PlanState => ({ kind: "buying", step });

  it("numbers a token buy's two prompts exactly, and states the deadline", () => {
    const usdc = plan({ sell: TOKENS.USDC.address });
    expect(buyingStep(buying("approving"), usdc, entry())).toEqual({ kind: "permission", symbol: "USDC", step: 1, of: 2 });
    const pending = entry({
      runs: [{ slot: 0, at: NOW, status: "pending", amountIn: "1", hashes: ["0x01"], steps: ["approve"], deadline: NOW_S + 600 }],
    });
    expect(buyingStep(buying("swapping"), usdc, pending)).toEqual({ kind: "buy", deadline: NOW_S + 600, step: 2, of: 2 });
    expect(buyingStep(buying("swapping"), plan(), entry())).toEqual({ kind: "buy", deadline: null, step: 1, of: 1 });
    expect(buyingStep(buying("confirming"), plan(), entry())).toEqual({ kind: "wait" });
    expect(buyingStep({ kind: "waiting", nextAt: 0 }, plan(), entry())).toBeNull();
  });
});

describe("balances and removals", () => {
  it("never shows an unread balance as zero", () => {
    expect(balanceText(null, NATIVE_ETH)).toBe("unknown");
    expect(balanceText(0n, NATIVE_ETH)).toBe("0 ETH");
    expect(balanceText(5n * 10n ** 11n, NATIVE_ETH)).toBe("less than 0.000001 ETH");
    expect(balanceText(412n * 10n ** 14n, NATIVE_ETH)).toBe("0.0412 ETH");
  });

  it("counts the plans a new config would remove", () => {
    const current = { dca: { enabled: true, plans: [plan(), plan({ id: "dca-2" })] } };
    expect(removedPlanCount(current, { dca: { enabled: true, plans: [plan()] } })).toBe(1);
    expect(removedPlanCount(current, current)).toBe(0);
    expect(removalText(2)).toBe("This removes 2 auto-buys.");
    expect(removalText(1)).toBe("This removes 1 auto-buy.");
  });

  it("says who approves in the terms line", () => {
    expect(termsLine(plan())).toBe("0.01 ETH every day · you approve each buy");
  });
});

describe("resume terms", () => {
  it("states what is left, where it goes and when the next buy is", () => {
    const terms = resumeTerms({
      plan: plan({ paused: true }),
      entry: entry({ buysDone: 3, committed: (3n * 10n ** 16n).toString(), lastSlot: 0 }),
      owner: OWNER,
      expert: false,
      nowMs: NOW + 86_400_000,
      formatWhen: () => "WHEN",
    });
    expect(terms).toEqual({
      terms: "Buy SPX with 0.01 ETH every day, up to 10 times (7 left).",
      limit: "At most 0.07 ETH more, plus network fees · delivered to 0x7099…79c8 · on Local fork · you approve each buy.",
      next: "Next buy: now — confirm it on this card.",
    });
  });

  it("counts a plan with no record here from zero, and names the chain in Expert", () => {
    const terms = resumeTerms({
      plan: plan({ paused: true }),
      entry: null,
      owner: OWNER,
      expert: true,
      nowMs: NOW,
    });
    expect(terms.terms).toContain("(10 left)");
    expect(terms.limit).toContain("At most 0.1 ETH more");
    expect(terms.limit).toContain("on Local fork (chain 690069)");
    expect(terms.next).toBe("Next buy: now — confirm it on this card.");
  });

  it("gives the next buy time once this buy time is used", () => {
    const terms = resumeTerms({
      plan: plan({ paused: true }),
      entry: entry({ buysDone: 1, committed: (10n ** 16n).toString(), lastSlot: 0 }),
      owner: OWNER,
      expert: false,
      nowMs: NOW,
      formatWhen: (ms) => `at ${(ms / 1000 - NOW_S) / 3600}h`,
    });
    expect(terms.next).toBe("Next buy: at 23h.");
  });
});
