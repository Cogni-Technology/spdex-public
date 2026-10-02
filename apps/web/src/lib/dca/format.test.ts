/**
 * The words the auto-buy UI uses.
 *
 * Pinned because they are promises: "0.1 ETH in total" is the most a plan can
 * spend, "—" means no average yet (never 0), and a token the list does not know
 * is named without an amount rather than with a guessed one.
 */

import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { DcaPlan } from "@spdex/core";
import {
  PRICE_DECIMALS,
  amountLabel,
  amountText,
  averagePrice,
  baseUnits,
  countdown,
  everyLabel,
  ethText,
  ethUpTo,
  formatSignificant,
  historyOf,
  runKind,
  runLabel,
  transferLabel,
  shortAddress,
  timesLabel,
  tokenLabel,
  averagePriceOf,
  type EntryLike,
  type RunLike,
  type TransferLike,
} from "./format.js";
import { RUN_CODES, type DcaLedgerEntry, type DcaRun, type DcaTransfer } from "./ledger.js";

const UNKNOWN = "0x1234000000000000000000000000000000abcdef" as const;

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "dca-0001",
    paused: false,
    chainId: 690069,
    sell: NATIVE_TOKEN,
    buy: TOKENS.SPX.address,
    amountPerBuy: (10n ** 16n).toString(),
    intervalSeconds: 86_400,
    maxBuys: 10,
    startAt: 1_800_000_000,
    signer: "wallet",
    ...overrides,
  };
}

function run(overrides: Partial<RunLike> = {}): RunLike {
  return { slot: 0, at: 0, status: "confirmed", amountIn: (10n ** 16n).toString(), hashes: ["0x" + "a".repeat(64)], ...overrides };
}

describe("formatSignificant, cut down", () => {
  const ETHER = 10n ** 18n;
  it("cuts to five significant digits without ever rounding up, and never cuts whole units", () => {
    expect(formatSignificant(12_345_678_900_000_000_000n, 18, 5, "down")).toBe("12.345");
    expect(formatSignificant(19_999_999_999_999_999_999n, 18, 5, "down")).toBe("19.999");
    expect(formatSignificant(123_456_780_000_000n, 18, 5, "down")).toBe("0.00012345");
    expect(formatSignificant(123_456n * ETHER + 9n * (ETHER / 10n), 18, 5, "down")).toBe("123,456");
    expect(formatSignificant(ETHER, 18, 5, "down")).toBe("1");
    expect(formatSignificant(0n, 18, 5, "down")).toBe("0");
  });
});

describe("ether figures", () => {
  it("are five digits by default, the card's six on request, and a cost to pay rounded up to four", () => {
    const wei = 123_456_789_000_000n;
    expect(ethText(wei)).toBe("0.00012346");
    expect(ethText(wei, 6)).toBe("0.000123457");
    expect(ethText(wei, 2)).toBe("0.00012");
    expect(ethText(wei, 3, "up")).toBe("0.000124");
    expect(ethUpTo(wei)).toBe("0.0001235");
    expect(ethUpTo(10n ** 18n)).toBe("1");
    expect(ethText(0n)).toBe("0");
  });
});

describe("everyLabel", () => {
  it("names the presets and custom intervals in the largest whole unit", () => {
    expect(everyLabel(3_600)).toBe("every hour");
    expect(everyLabel(86_400)).toBe("every day");
    expect(everyLabel(604_800)).toBe("every week");
    expect(everyLabel(1_209_600)).toBe("every 2 weeks");
    expect(everyLabel(2_592_000)).toBe("every 30 days");
    expect(everyLabel(2_700)).toBe("every 45 minutes");
    expect(everyLabel(300)).toBe("every 5 minutes");
    expect(everyLabel(5_400)).toBe("every 90 minutes");
    expect(everyLabel(7_200)).toBe("every 2 hours");
    expect(everyLabel(301)).toBe("every 301 seconds");
  });

  it("never invents an interval from a bad one", () => {
    expect(everyLabel(0)).toBe("at an unknown interval");
    expect(everyLabel(1.5)).toBe("at an unknown interval");
  });

  it("counts buys plainly", () => {
    expect(timesLabel(1)).toBe("once");
    expect(timesLabel(10)).toBe("10 times");
    expect(timesLabel(1_000)).toBe("1,000 times");
  });
});

describe("amounts in a history sentence", () => {
  it("rounds to six significant digits when asked, and keeps every digit by default", () => {
    const swept = 3_070_419_018_563_352n;
    expect(amountText(swept, NATIVE_TOKEN)).toBe("0.003070419018563352 ETH");
    expect(amountText(swept, NATIVE_TOKEN, undefined, "rounded")).toBe("0.00307042 ETH");
    expect(transferLabel({ kind: "withdrawn", at: 0, amounts: [{ token: NATIVE_TOKEN, amount: swept.toString() }], hashes: [] }, undefined, "rounded")).toBe(
      "Withdrew 0.00307042 ETH to your wallet.",
    );
    // Nothing to round is not invented: an unknown token keeps its words.
    expect(amountText(5n, UNKNOWN, undefined, "rounded")).toBe("unknown token 0x1234…cdef");
  });
});

describe("tokens and amounts", () => {
  it("formats known tokens and refuses to guess unknown ones", () => {
    expect(amountLabel(1_307_000_000n, TOKENS.SPX.address)).toBe("13.07 SPX");
    expect(amountLabel(1_307_000_000n, TOKENS.SPX.address.toUpperCase().replace("0X", "0x"))).toBe("13.07 SPX");
    expect(amountLabel(5n, UNKNOWN)).toBe("unknown token 0x1234…cdef");
    expect(amountLabel(null, TOKENS.USDC.address)).toBe("an unknown amount of USDC");
    expect(tokenLabel(UNKNOWN)).toBe("unknown token 0x1234…cdef");
    expect(shortAddress(TOKENS.USDC.address)).toBe("0xa0b8…eb48");
  });

  it("reads only whole decimal strings as amounts", () => {
    expect(baseUnits("123")).toBe(123n);
    expect(baseUnits("0")).toBe(0n);
    expect(baseUnits("")).toBeNull();
    expect(baseUnits("1e18")).toBeNull();
    expect(baseUnits("-1")).toBeNull();
    expect(baseUnits(undefined)).toBeNull();
  });
});

describe("countdown", () => {
  const now = 1_800_000_000_000;
  const at = (seconds: number) => now / 1_000 + seconds;

  it("counts down in days, hours and minutes", () => {
    expect(countdown(at(3 * 3_600 + 12 * 60 + 40), now)).toBe("in 3h 12m");
    expect(countdown(at(2 * 86_400 + 4 * 3_600 + 5), now)).toBe("in 2d 4h");
    expect(countdown(at(86_400), now)).toBe("in 1d");
    expect(countdown(at(3_600), now)).toBe("in 1h");
    expect(countdown(at(45 * 60), now)).toBe("in 45m");
    expect(countdown(BigInt(at(60)), now)).toBe("in 1m");
  });

  it("says any moment in the last minute, and now once the buy time has opened", () => {
    expect(countdown(at(59), now)).toBe("any moment");
    expect(countdown(at(0), now)).toBe("now");
    expect(countdown(at(-600), now)).toBe("now");
  });
});

describe("averagePrice", () => {
  const confirmed = (inWei: bigint, outSpx: bigint) =>
    run({ amountIn: inWei.toString(), amountOut: outSpx.toString() });

  it("is null before any buy has been measured — shown as —, never 0", () => {
    expect(averagePrice([], 18, 8)).toBeNull();
    expect(averagePrice([run({ status: "failed" }), run({ status: "pending" })], 18, 8)).toBeNull();
    expect(averagePrice([run({ status: "confirmed" })], 18, 8)).toBeNull();
  });

  it("is Σ in / Σ out over confirmed buys, both ways round", () => {
    const runs = [
      confirmed(10n ** 16n, 1_307_000_000n),
      confirmed(10n ** 16n, 1_307_000_000n),
      confirmed(10n ** 16n, 1_307_000_000n),
      run({ status: "failed", amountIn: (10n ** 18n).toString() }),
    ];
    const average = averagePrice(runs, 18, 8)!;
    expect(average).toMatchObject({ spent: 3n * 10n ** 16n, bought: 3_921_000_000n, counted: 3, confirmed: 3 });
    expect(formatSignificant(average.buyPerSell!, PRICE_DECIMALS)).toBe("1,307");
    expect(formatSignificant(average.sellPerBuy!, PRICE_DECIMALS)).toBe("0.0007651");
  });

  it("leaves out a buy whose delivery was not measured, and says how many it is from", () => {
    const average = averagePrice(
      [confirmed(10n ** 16n, 1_307_000_000n), run({ status: "confirmed", amountIn: (10n ** 16n).toString() })],
      18,
      8,
    )!;
    expect(average.counted).toBe(1);
    expect(average.confirmed).toBe(2);
    expect(average.spent).toBe(10n ** 16n);
  });

  it("averages over the plan's whole life from the ledger's running totals", () => {
    const entry = {
      buysDone: 150,
      committed: "0",
      measured: { buys: 149, amountIn: (149n * 10n ** 16n).toString(), amountOut: (149n * 1_307_000_000n).toString() },
      runs: [],
    };
    const average = averagePriceOf(entry, 18, 8)!;
    expect(average).toMatchObject({ counted: 149, confirmed: 150 });
    expect(formatSignificant(average.buyPerSell!, PRICE_DECIMALS)).toBe("1,307");
    expect(averagePriceOf({ ...entry, measured: { buys: 0, amountIn: "0", amountOut: "0" } }, 18, 8)).toBeNull();
    expect(averagePriceOf({ ...entry, measured: { buys: 1, amountIn: "x", amountOut: "1" } }, 18, 8)).toBeNull();
    expect(averagePriceOf(null, 18, 8)).toBeNull();
    // A record without totals falls back to its runs.
    expect(averagePriceOf({ buysDone: 1, committed: "1", runs: [confirmed(10n ** 16n, 1_307_000_000n)] }, 18, 8)).toMatchObject({
      counted: 1,
    });
  });

  it("prices a dollar plan in dollars per token", () => {
    const average = averagePrice([run({ amountIn: "25000000", amountOut: "1000000000" })], 6, 8)!;
    expect(formatSignificant(average.sellPerBuy!, PRICE_DECIMALS)).toBe("2.5");
  });
});

describe("formatSignificant", () => {
  it("keeps four significant digits and every whole digit", () => {
    expect(formatSignificant(1_234_560_000_000_000_000n, 18)).toBe("1.235");
    expect(formatSignificant(12_345_600_000_000_000_000_000n, 18)).toBe("12,346");
    expect(formatSignificant(123_456_000_000_000n, 18)).toBe("0.0001235");
    expect(formatSignificant(0n, 18)).toBe("0");
  });

  it("rounds up when asked, for a figure someone will be asked to send", () => {
    expect(formatSignificant(4_200_001_000_000_000n, 18, 4, "up")).toBe("0.004201");
    expect(formatSignificant(4_200_000_000_000_000n, 18, 4, "up")).toBe("0.0042");
  });
});

describe("the ledger's own records", () => {
  it("fit these helpers without conversion", () => {
    // Compile-time: a change to the ledger's shapes that these helpers cannot
    // read fails the typecheck here rather than rendering "unknown" quietly.
    const asEntry = (entry: DcaLedgerEntry): EntryLike => entry;
    const asRun = (run: DcaRun): RunLike => run;
    const asTransfer = (transfer: DcaTransfer): TransferLike => transfer;
    const asHistory = (entry: DcaLedgerEntry, plan: DcaPlan) => historyOf(entry, plan);
    expect(typeof asEntry).toBe("function");
    expect(typeof asRun).toBe("function");
    expect(typeof asTransfer).toBe("function");
    expect(typeof asHistory).toBe("function");
  });
});

describe("runLabel", () => {
  const p = plan();

  it("describes a bought run from what was measured", () => {
    expect(runLabel(run({ amountOut: "1307000000" }), p)).toBe("Bought 13.07 SPX for 0.01 ETH.");
    expect(runLabel(run(), p)).toBe("Bought SPX for 0.01 ETH — the amount received couldn't be measured.");
    expect(runLabel(run({ amountOut: "1307000000", reason: "Only 1 of 2 parts went through." }), p)).toBe(
      "Bought 13.07 SPX for 0.01 ETH — only 1 of 2 parts went through.",
    );
  });

  it("never claims a fee was spent when nothing was sent", () => {
    expect(runLabel(run({ status: "failed" }), p)).toBe(
      "Failed on the network — nothing was bought; the network fee was spent.",
    );
    expect(runLabel(run({ status: "failed", hashes: [], reason: "RPC endpoint unreachable" }), p)).toBe(
      "Failed before anything was sent — RPC endpoint unreachable.",
    );
    expect(runLabel(run({ status: "failed", hashes: [] }), p)).toBe("Failed before anything was sent.");
  });

  it("words each skip by its cause", () => {
    expect(runLabel(run({ status: "declined" }), p)).toBe("Declined in your wallet.");
    expect(runLabel(run({ status: "skipped", reason: "Network fees are unusually high." }), p)).toBe(
      "Skipped — network fees are unusually high.",
    );
    expect(runLabel(run({ status: "skipped" }), p)).toBe("Skipped.");
    const skipped = (code: string, extra: Partial<RunLike> = {}) =>
      runLabel(run({ status: "skipped", hashes: [], codes: [code], reason: "backstop", ...extra }), p);
    expect(skipped(RUN_CODES.SKIPPED_BY_USER)).toBe("Skipped — you chose to skip this buy.");
    expect(skipped(RUN_CODES.NOT_CONFIRMED)).toBe("Skipped — not confirmed before its buy time ended.");
    expect(skipped(RUN_CODES.HELD_EXPIRED, { divergenceBps: 720 })).toBe(
      "Skipped — held for a price check and not approved before its buy time ended.",
    );
    expect(runLabel(run({ status: "skipped", codes: [RUN_CODES.HELD_EXPIRED, RUN_CODES.FEE_CEILING] }), p)).toBe(
      "Skipped — held for high network fees and not approved before its buy time ended.",
    );
    // Whose balance was short is the run's own reason: the owner's wallet, or
    // an old autopilot plan's spending wallet, whose plan is a wallet plan now.
    expect(skipped(RUN_CODES.INSUFFICIENT_FUNDS, { reason: "not enough ETH in your wallet for this buy" })).toBe(
      "Skipped — not enough ETH in your wallet for this buy.",
    );
    expect(
      skipped(RUN_CODES.INSUFFICIENT_FUNDS, { reason: "the spending wallet couldn't cover the buy and its network fee" }),
    ).toBe("Skipped — the spending wallet couldn't cover the buy and its network fee.");
    expect(runLabel(run({ status: "skipped", hashes: [], codes: [RUN_CODES.INSUFFICIENT_FUNDS] }), p)).toBe(
      "Skipped — not enough ETH in your wallet.",
    );
    expect(skipped(RUN_CODES.FEE_CEILING)).toBe("Skipped — network fees were above this plan's limit.");
    expect(skipped(RUN_CODES.PRIVATE_UNAVAILABLE)).toMatch(/can't send privately, and spDEX won't send a scheduled buy publicly/);
    expect(skipped(RUN_CODES.NOT_BOUGHT, { reason: "The spending wallet wasn't funded yet" })).toBe(
      "Skipped — the spending wallet wasn't funded yet.",
    );
  });

  it("says what a held buy is waiting for", () => {
    expect(runLabel(run({ status: "held", divergenceBps: 720 }), p)).toBe(
      "On hold — the price is 7.2% away from the 10-minute average.",
    );
    expect(runLabel(run({ status: "held", codes: [RUN_CODES.FEE_CEILING] }), p)).toBe(
      "On hold — network fees are above this plan's limit.",
    );
    expect(runLabel(run({ status: "held" }), p)).toBe("On hold for a check.");
    expect(runLabel(run({ status: "held", reason: "waiting for you" }), p)).toBe("On hold — waiting for you.");
  });

  it("describes buys in flight and unknown outcomes without guessing", () => {
    expect(runLabel(run({ status: "pending" }), p)).toBe("Buying SPX with 0.01 ETH…");
    expect(runLabel(run({ status: "unknown", hashes: ["0xabcdef0000000000000000000000000000000000000000000000000000001234"] }), p)).toBe(
      "Unknown — sent as 0xabcd…1234, but no receipt has arrived yet. Check it before buying again.",
    );
    expect(runLabel(run({ status: "unknown", hashes: [] }), p)).toMatch(/^Unknown — sent, but no receipt/);
  });

  it("records missed buy times as skipped, not made up", () => {
    const missed = (count: number) =>
      runLabel(run({ status: "skipped", amountIn: "0", hashes: [], codes: [RUN_CODES.MISSED], missed: count }), p);
    expect(missed(3)).toBe("3 buy times passed while spDEX wasn't running — skipped, not made up.");
    expect(missed(1)).toBe("1 buy time passed while spDEX wasn't running — skipped, not made up.");
  });

  it("says an interrupted buy is being checked, and a private-only failure why", () => {
    expect(runLabel(run({ status: "pending", codes: [RUN_CODES.INTERRUPTED] }), p)).toBe(
      "Interrupted — spDEX closed mid-buy. Checking the network…",
    );
    expect(runLabel(run({ status: "failed", hashes: [], codes: [RUN_CODES.PRIVATE_UNAVAILABLE] }), p)).toMatch(
      /^Skipped — your wallet can't send privately/,
    );
  });

  it("names unknown tokens without amounts, and shows an unfamiliar status by its reason", () => {
    expect(runLabel(run({ amountOut: "5" }), plan({ sell: UNKNOWN }))).toBe(
      "Bought 0.00000005 SPX for unknown token 0x1234…cdef.",
    );
    expect(runLabel(run({ status: "reorged", reason: "the block was replaced" }), p)).toBe(
      "Status: reorged — the block was replaced.",
    );
  });
});

describe("history kinds, transfers and the merged history", () => {
  const p = plan();
  const skipped = (codes: string[]) => runKind({ status: "skipped", codes });

  it("names every kind of history entry the panel shows", () => {
    expect(runKind({ status: "confirmed" })).toBe("bought");
    expect(runKind({ status: "confirmed", codes: [RUN_CODES.INTERRUPTED] })).toBe("bought");
    expect(runKind({ status: "pending" })).toBe("buying");
    expect(runKind({ status: "pending", codes: [RUN_CODES.INTERRUPTED] })).toBe("interrupted");
    expect(runKind({ status: "unknown" })).toBe("unknown");
    expect(runKind({ status: "held", codes: ["ORACLE_DIVERGENCE"] })).toBe("held");
    expect(runKind({ status: "declined", codes: [RUN_CODES.DECLINED] })).toBe("declined");
    expect(runKind({ status: "failed", codes: [RUN_CODES.REVERTED] })).toBe("failed");
    expect(skipped([RUN_CODES.MISSED])).toBe("missed");
    expect(skipped([RUN_CODES.NOT_CONFIRMED])).toBe("not-confirmed");
    expect(skipped([RUN_CODES.SKIPPED_BY_USER, "ORACLE_DIVERGENCE"])).toBe("skipped-by-user");
    expect(skipped([RUN_CODES.HELD_EXPIRED])).toBe("held-expired");
    expect(skipped([RUN_CODES.INSUFFICIENT_FUNDS])).toBe("no-funds");
    expect(skipped([RUN_CODES.PRIVATE_UNAVAILABLE])).toBe("private-unavailable");
    expect(skipped([RUN_CODES.RELAY_FAILED])).toBe("relay-failed");
    expect(skipped([RUN_CODES.LATE_SIGNATURE])).toBe("late-signature");
    expect(skipped(["SIMULATION_UNAVAILABLE"])).toBe("unverified");
    // The scheduled-buy Guard gives both codes when the second opinion didn't answer; the second says why.
    expect(skipped(["SIMULATION_UNAVAILABLE", "SECOND_OPINION_UNAVAILABLE"])).toBe("second-opinion-unavailable");
    expect(skipped(["SECOND_OPINION_UNAVAILABLE", "SIMULATION_UNAVAILABLE"])).toBe("second-opinion-unavailable");
    expect(skipped(["MIN_OUT_NOT_MET"])).toBe("refused");
    expect(skipped([RUN_CODES.FEE_CEILING])).toBe("skipped");
    expect(skipped([RUN_CODES.QUOTE_FAILED])).toBe("skipped");
  });

  it("words the new skips without claiming a fee was spent", () => {
    const hashes = ["0x" + "b".repeat(64)];
    expect(runLabel(run({ status: "skipped", hashes, codes: [RUN_CODES.RELAY_FAILED] }), p)).toBe(
      "Skipped — the private relay didn't take it, and spDEX never sends an auto-buy publicly without asking.",
    );
    expect(runLabel(run({ status: "skipped", hashes: [], codes: [RUN_CODES.LATE_SIGNATURE] }), p)).toBe(
      "Skipped — signed too close to its deadline, so spDEX didn't send it. No fee was spent.",
    );
    expect(runLabel(run({ status: "skipped", hashes: [], codes: ["SIMULATION_UNAVAILABLE"] }), p)).toMatch(
      /couldn't run the safety test, and an auto-buy is never made unchecked/,
    );
    expect(
      runLabel(run({ status: "skipped", hashes: [], codes: ["SIMULATION_UNAVAILABLE", "SECOND_OPINION_UNAVAILABLE"] }), p),
    ).toBe("Skipped — your second network service didn't answer, and an auto-buy is only made when both services agree.");
  });

  it("says what a transfer moved, and what stopped one part-way", () => {
    const eth = (amount: bigint) => ({ token: NATIVE_TOKEN, amount: amount.toString() });
    const usdc = (amount: bigint) => ({ token: TOKENS.USDC.address, amount: amount.toString() });
    expect(transferLabel({ kind: "funded", at: 0, amounts: [eth(103_521n * 10n ** 12n)], hashes: [] })).toBe(
      "Funded the spending wallet with 0.103521 ETH.",
    );
    expect(transferLabel({ kind: "topped-up", at: 0, amounts: [usdc(10_000_000n), eth(4n * 10n ** 15n)], hashes: [] })).toBe(
      "Topped up the spending wallet with 10 USDC and 0.004 ETH.",
    );
    expect(
      transferLabel({ kind: "withdrawn", at: 0, amounts: [usdc(1_500_000n)], hashes: [], reason: "The ether sweep was not confirmed" }),
    ).toBe("Withdrew 1.5 USDC to your wallet — the ether sweep was not confirmed.");
    expect(transferLabel({ kind: "funded", at: 0, amounts: [], hashes: ["0x" + "c".repeat(64)] })).toBe(
      "Funding sent, not confirmed.",
    );
  });

  it("merges runs and transfers, newest first, with each row's kind and sentence", () => {
    const entry = {
      runs: [
        run({ at: 10, amountOut: "1307000000" }),
        run({ at: 30, status: "skipped", hashes: [], codes: [RUN_CODES.MISSED], missed: 2 }),
      ],
      transfers: [{ kind: "funded" as const, at: 5, amounts: [{ token: NATIVE_TOKEN, amount: "1" }], hashes: ["0x" + "d".repeat(64)] }],
    };
    const rows = historyOf(entry, p);
    expect(rows.map((r) => [r.source, r.kind, r.at])).toEqual([
      ["run", "missed", 30],
      ["run", "bought", 10],
      ["transfer", "funded", 5],
    ]);
    expect(rows[1]!.text).toBe("Bought 13.07 SPX for 0.01 ETH.");
    expect(historyOf(entry, p, undefined, 1)).toHaveLength(1);
    expect(historyOf({ runs: [] }, p)).toEqual([]);
  });
});
