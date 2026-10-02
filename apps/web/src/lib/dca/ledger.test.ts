/**
 * The ledger's promises: every transition is exact or refused, and a record
 * that cannot be read is "unavailable" — never an empty ledger, which would
 * restart a plan's budget.
 */

import { describe, expect, it } from "vitest";
import {
  ClaimRefusedError,
  HALT_AFTER_FAILURES,
  LEDGER_KEY,
  LEDGER_LOCK,
  LedgerBusyError,
  LedgerRebindError,
  LedgerStore,
  LedgerUnavailableError,
  MAX_RUNS,
  RUN_CODES,
  RunStateError,
  bindToOwner,
  canMoveStart,
  claimBuy,
  closeWindow,
  emptyLedger,
  entryOf,
  markSeen,
  markUnknown,
  parseLedger,
  progressOf,
  recordAttempt,
  recordMissed,
  recordSent,
  replaceSent,
  reinstateClaim,
  releaseBuy,
  removeEntry,
  resolveHeld,
  resume,
  settleBuy,
  entryKey,
  startEntry,
  type DcaLedger,
  type LedgerLocks,
  type StorageLike,
} from "./ledger.js";

const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const SPENDER = "0x3f2a00000000000000000000000000000000091b" as const;
const REF = { planId: "plan-a", chainId: 690069 };
const HASH_1 = `0x${"11".repeat(32)}`;
const HASH_2 = `0x${"22".repeat(32)}`;
const T = 1_700_000_000_000;

function started(signer: string = OWNER): DcaLedger {
  return startEntry(emptyLedger(), { ...REF, owner: OWNER.toUpperCase().replace("0X", "0x"), signer, at: T });
}

function entry(ledger: DcaLedger) {
  const found = entryOf(ledger, REF);
  if (!found) throw new Error("no entry");
  return found;
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("startEntry", () => {
  it("binds owner and signer, lowercased, with nothing spent", () => {
    const e = entry(started());
    expect(e.owner).toBe(OWNER);
    expect(e.signer).toBe(OWNER);
    expect(progressOf(e)).toEqual({
      planId: "plan-a",
      chainId: 690069,
      owner: OWNER,
      signer: OWNER,
      buysDone: 0,
      committed: 0n,
      lastSlot: null,
    });
  });

  it("is idempotent for the same pair and refuses to rebind to another owner or signer", () => {
    const ledger = started();
    expect(entry(startEntry(ledger, { ...REF, owner: OWNER, signer: OWNER, at: T + 5 }))).toEqual(entry(ledger));
    // The very same ledger, so a store writes nothing for a repeated start.
    expect(startEntry(ledger, { ...REF, owner: OWNER, signer: OWNER, at: T + 5 })).toBe(ledger);
    expect(() => startEntry(ledger, { ...REF, owner: SPENDER, signer: SPENDER, at: T })).toThrow(LedgerRebindError);
    expect(() => startEntry(ledger, { ...REF, owner: OWNER, signer: SPENDER, at: T })).toThrow(LedgerRebindError);
  });

  it("refuses the zero address as owner", () => {
    expect(() =>
      startEntry(emptyLedger(), { ...REF, owner: `0x${"0".repeat(40)}`, signer: OWNER, at: T }),
    ).toThrow(/not an address/);
  });

});

describe("an old autopilot plan's record", () => {
  // Written before config version 8: the spending wallet signs, the owner
  // receives, and a fee ceiling rides along.
  function autopilotRecord(): DcaLedger {
    let l = started(SPENDER);
    l = claimBuy(l, REF, { slot: 0, amountIn: 1000n, at: T });
    l = settleBuy(l, REF, { slot: 0, amountOut: 7n, at: T + 1 });
    const raw = JSON.parse(JSON.stringify(l));
    raw.entries[`${REF.chainId}:${REF.planId}`].feeCeiling = "30";
    return raw as DcaLedger;
  }

  it("still reads, its fee ceiling dropped since nothing uses it", () => {
    const read = parseLedger(autopilotRecord());
    expect(read).not.toBeNull();
    expect(entry(read!)).toMatchObject({ owner: OWNER, signer: SPENDER, buysDone: 1, committed: "1000" });
    expect(entry(read!)).not.toHaveProperty("feeCeiling");
    // A damaged one still fails the whole read, as any damaged field does.
    const raw = JSON.parse(JSON.stringify(autopilotRecord()));
    raw.entries[`${REF.chainId}:${REF.planId}`].feeCeiling = "-1";
    expect(parseLedger(raw)).toBeNull();
  });

  it("is bound to its owner when resumed, keeping everything it counted", () => {
    const old = parseLedger(autopilotRecord())!;
    const bound = bindToOwner(old, REF);
    expect(entry(bound)).toEqual({ ...entry(old), signer: OWNER });
    // Only the signer: the owner, the budget spent and the windows used stay.
    expect(entry(bound)).toMatchObject({ owner: OWNER, buysDone: 1, committed: "1000", lastSlot: 0 });
    // A record already bound comes back as it was.
    expect(bindToOwner(bound, REF)).toBe(bound);
    expect(bindToOwner(started(), REF)).toEqual(started());
  });

  it("is not rebound while a buy its spending wallet signed hasn't settled", () => {
    const pending = claimBuy(started(SPENDER), REF, { slot: 2, amountIn: 5n, at: T });
    expect(() => bindToOwner(pending, REF)).toThrow(LedgerRebindError);
    expect(() => bindToOwner(markUnknown(pending, REF, { slot: 2, at: T + 1 }), REF)).toThrow(/hasn't settled/);
    expect(() => bindToOwner(emptyLedger(), REF)).toThrow(/no record/);
  });
});

describe("claim → settle", () => {
  it("claims before signing: window used, committed raised, a pending run", () => {
    const ledger = claimBuy(started(), REF, { slot: 3, amountIn: 1000n, at: T, calls: 1, deadline: 99 });
    const e = entry(ledger);
    expect(e.lastSlot).toBe(3);
    expect(e.committed).toBe("1000");
    expect(e.runs).toEqual([
      { slot: 3, at: T, status: "pending", amountIn: "1000", hashes: [], steps: [], calls: 1, deadline: 99, lastSlotBefore: null },
    ]);
  });

  it("refuses a used or earlier window, a second unsettled buy, and a stopped plan", () => {
    const claimed = claimBuy(started(), REF, { slot: 3, amountIn: 1000n, at: T });
    expect(() => claimBuy(claimed, REF, { slot: 3, amountIn: 1n, at: T })).toThrow(ClaimRefusedError);
    expect(() => claimBuy(claimed, REF, { slot: 2, amountIn: 1n, at: T })).toThrow(ClaimRefusedError);
    // Pending in window 3 blocks window 4.
    expect(() => claimBuy(claimed, REF, { slot: 4, amountIn: 1n, at: T })).toThrow(/has not settled/);
    const unknown = markUnknown(claimed, REF, { slot: 3, hashes: [HASH_1], at: T });
    expect(() => claimBuy(unknown, REF, { slot: 4, amountIn: 1n, at: T })).toThrow(/has not settled/);
  });

  it("records each hash once, with its step, as soon as it exists", () => {
    let ledger = claimBuy(started(), REF, { slot: 0, amountIn: 5n, at: T });
    ledger = recordSent(ledger, REF, 0, HASH_1, "approve");
    ledger = recordSent(ledger, REF, 0, HASH_1.toUpperCase().replace("0X", "0x"), "approve");
    ledger = recordSent(ledger, REF, 0, HASH_2, "swap");
    expect(entry(ledger).runs[0]).toMatchObject({ hashes: [HASH_1, HASH_2], steps: ["approve", "swap"] });
  });

  it("puts a wallet's faster copy in the original's place, step and all, and nothing else", () => {
    let ledger = claimBuy(started(), REF, { slot: 0, amountIn: 5n, at: T });
    ledger = recordSent(ledger, REF, 0, HASH_1, "approve");
    ledger = recordSent(ledger, REF, 0, HASH_2, "swap");
    const HASH_3 = `0x${"33".repeat(32)}`;
    ledger = replaceSent(ledger, REF, 0, HASH_2, HASH_3);
    expect(entry(ledger).runs[0]).toMatchObject({ hashes: [HASH_1, HASH_3], steps: ["approve", "swap"] });
    // An original the run doesn't hold leaves it as it was.
    expect(replaceSent(ledger, REF, 0, `0x${"44".repeat(32)}`, `0x${"55".repeat(32)}`)).toEqual(ledger);
  });

  it("settles: one more buy, failures reset, committed kept, measured totals grown", () => {
    let ledger = claimBuy(started(), REF, { slot: 0, amountIn: 5n, at: T });
    ledger = settleBuy(ledger, REF, { slot: 0, amountOut: 42n, hashes: [HASH_1], via: "wallet", at: T + 1 });
    const e = entry(ledger);
    expect(e.buysDone).toBe(1);
    expect(e.committed).toBe("5");
    expect(e.consecutiveFailures).toBe(0);
    expect(e.measured).toEqual({ buys: 1, amountIn: "5", amountOut: "42" });
    expect(e.runs[0]).toMatchObject({ status: "confirmed", amountOut: "42", hashes: [HASH_1], via: "wallet" });
  });

  it("settles an unmeasured buy without inventing an amount", () => {
    let ledger = claimBuy(started(), REF, { slot: 0, amountIn: 5n, at: T });
    ledger = settleBuy(ledger, REF, { slot: 0, at: T });
    expect(entry(ledger).runs[0]!.amountOut).toBeUndefined();
    expect(entry(ledger).measured.buys).toBe(0);
  });
});

describe("release, unknown, attempts", () => {
  it("releases a failed buy: committed returned, window stays used, failure counted", () => {
    let ledger = claimBuy(started(), REF, { slot: 2, amountIn: 7n, at: T });
    ledger = releaseBuy(ledger, REF, { slot: 2, status: "failed", reason: "reverted", at: T });
    const e = entry(ledger);
    expect(e.committed).toBe("0");
    expect(e.lastSlot).toBe(2);
    expect(e.consecutiveFailures).toBe(1);
    expect(e.runs[0]).toMatchObject({ status: "failed", reason: "reverted" });
  });

  it("a decline releases without counting as a failure", () => {
    let ledger = claimBuy(started(), REF, { slot: 2, amountIn: 7n, at: T });
    ledger = releaseBuy(ledger, REF, { slot: 2, status: "declined", reason: "no", at: T });
    expect(entry(ledger).consecutiveFailures).toBe(0);
    expect(entry(ledger).committed).toBe("0");
  });

  it("a decline gives its window back, so the owner can confirm the buy after all; the decline stays in the history", () => {
    // Window 1 bought, window 2 claimed and declined: the plan is back where window 1 left it.
    let ledger = claimBuy(started(), REF, { slot: 1, amountIn: 7n, at: T });
    ledger = settleBuy(ledger, REF, { slot: 1, amountOut: 5n, hashes: [HASH_1], at: T });
    ledger = claimBuy(ledger, REF, { slot: 2, amountIn: 7n, at: T });
    expect(entry(ledger).runs.at(-1)).toMatchObject({ lastSlotBefore: 1 });
    ledger = releaseBuy(ledger, REF, { slot: 2, status: "declined", reason: "no", at: T });
    expect(entry(ledger).lastSlot).toBe(1);
    // Confirmed after all, in the same window.
    ledger = claimBuy(ledger, REF, { slot: 2, amountIn: 7n, at: T + 1 });
    ledger = settleBuy(ledger, REF, { slot: 2, amountOut: 5n, hashes: [HASH_2], at: T + 1 });
    const e = entry(ledger);
    expect(e.lastSlot).toBe(2);
    expect(e.buysDone).toBe(2);
    expect(e.runs.map((r) => [r.slot, r.status])).toEqual([
      [1, "confirmed"],
      [2, "declined"],
      [2, "confirmed"],
    ]);
  });

  it("a failed buy, and a decline recorded before declines gave windows back, keep the window used", () => {
    let failed = claimBuy(started(), REF, { slot: 2, amountIn: 7n, at: T });
    failed = releaseBuy(failed, REF, { slot: 2, status: "failed", reason: "reverted", at: T });
    expect(entry(failed).lastSlot).toBe(2);
    // An older record's claim says nothing about what came before it.
    let old = claimBuy(started(), REF, { slot: 2, amountIn: 7n, at: T });
    const { lastSlotBefore: _dropped, ...run } = entry(old).runs[0]!;
    old = { ...old, entries: { [entryKey(REF.chainId, REF.planId)]: { ...entry(old), runs: [run] } } };
    old = releaseBuy(old, REF, { slot: 2, status: "declined", reason: "no", at: T });
    expect(entry(old).lastSlot).toBe(2);
    expect(() => claimBuy(old, REF, { slot: 2, amountIn: 7n, at: T })).toThrow(ClaimRefusedError);
  });

  it("unknown keeps the claim and blocks the next buy", () => {
    let ledger = claimBuy(started(), REF, { slot: 2, amountIn: 7n, at: T });
    ledger = markUnknown(ledger, REF, { slot: 2, hashes: [HASH_1], at: T });
    expect(entry(ledger).committed).toBe("7");
    expect(entry(ledger).runs[0]).toMatchObject({ status: "unknown", hashes: [HASH_1] });
    expect(() => releaseBuy(ledger, REF, { slot: 3, status: "failed", reason: "x", at: T })).toThrow(RunStateError);
  });

  it("a skip does not use the window; retries update one record; three windows in a row halt", () => {
    let ledger = started();
    const skip = (slot: number, at: number) =>
      (ledger = recordAttempt(ledger, REF, { slot, status: "skipped", reason: `no ${slot}`, codes: ["MIN_OUT_NOT_MET"], amountIn: 5n, at }));
    skip(0, T);
    skip(0, T + 1);
    skip(0, T + 2);
    expect(entry(ledger).lastSlot).toBeNull();
    expect(entry(ledger).runs).toHaveLength(1);
    expect(entry(ledger).runs[0]!.retries).toBe(2);
    expect(entry(ledger).consecutiveFailures).toBe(1);
    skip(1, T + 3);
    expect(entry(ledger).halted).toBeUndefined();
    skip(2, T + 4);
    expect(entry(ledger).consecutiveFailures).toBe(HALT_AFTER_FAILURES);
    expect(entry(ledger).halted).toBe("no 2");
    expect(() => claimBuy(ledger, REF, { slot: 3, amountIn: 1n, at: T })).toThrow(/stopped/);
    ledger = resume(ledger, REF);
    expect(entry(ledger).halted).toBeUndefined();
    expect(entry(ledger).consecutiveFailures).toBe(0);
  });

  it("a window counts once however its skipped and held records alternate", () => {
    // A fee hold is rechecked every few minutes; a refused quote in between
    // must not make one buy time count as three failures and stop the plan.
    let ledger = started();
    const attempt = (status: "skipped" | "held", at: number) =>
      (ledger = recordAttempt(ledger, REF, { slot: 0, status, reason: status, codes: [], amountIn: 1n, at }));
    attempt("skipped", T);
    attempt("held", T + 1);
    attempt("skipped", T + 2);
    attempt("held", T + 3);
    attempt("skipped", T + 4);
    expect(entry(ledger)).toMatchObject({ consecutiveFailures: 1 });
    expect(entry(ledger).halted).toBeUndefined();
    expect(entry(ledger).runs).toHaveLength(1);
    expect(entry(ledger).runs[0]).toMatchObject({ counted: true, retries: 4 });

    // Held first, then skipped: the skip is the window's first, so it counts.
    let other = started();
    other = recordAttempt(other, REF, { slot: 0, status: "held", reason: "h", codes: [], amountIn: 1n, at: T });
    other = recordAttempt(other, REF, { slot: 0, status: "skipped", reason: "s", codes: [], amountIn: 1n, at: T + 1 });
    other = recordAttempt(other, REF, { slot: 0, status: "held", reason: "h", codes: [], amountIn: 1n, at: T + 2 });
    other = recordAttempt(other, REF, { slot: 0, status: "skipped", reason: "s", codes: [], amountIn: 1n, at: T + 3 });
    expect(entry(other).consecutiveFailures).toBe(1);
  });

  it("a held run is replaced by the claim for its window", () => {
    let ledger = recordAttempt(started(), REF, {
      slot: 4, status: "held", reason: "price", codes: ["ORACLE_DIVERGENCE"], amountIn: 5n, at: T, divergenceBps: 720,
    });
    expect(entry(ledger).runs[0]).toMatchObject({ status: "held", divergenceBps: 720 });
    ledger = claimBuy(ledger, REF, { slot: 4, amountIn: 5n, at: T });
    expect(entry(ledger).runs.map((r) => r.status)).toEqual(["pending"]);
  });

  it("skipping a held buy uses the window and keeps what it was held for", () => {
    let ledger = recordAttempt(started(), REF, {
      slot: 4, status: "held", reason: "price", codes: ["ORACLE_DIVERGENCE"], amountIn: 5n, at: T, divergenceBps: 720,
    });
    ledger = resolveHeld(ledger, REF, { slot: 4, outcome: "skip", at: T + 1 });
    const e = entry(ledger);
    expect(e.lastSlot).toBe(4);
    expect(e.consecutiveFailures).toBe(0);
    expect(e.runs).toHaveLength(1);
    expect(e.runs[0]).toMatchObject({ status: "skipped", codes: [RUN_CODES.SKIPPED_BY_USER, "ORACLE_DIVERGENCE"] });
    expect(() => resolveHeld(ledger, REF, { slot: 4, outcome: "skip", at: T })).toThrow(RunStateError);
  });

  it("closes an unconfirmed window once, and records missed windows as one entry", () => {
    let ledger = closeWindow(started(), REF, { slot: 1, code: RUN_CODES.NOT_CONFIRMED, reason: "late", amountIn: 5n, at: T });
    expect(entry(ledger).lastSlot).toBe(1);
    expect(() => closeWindow(ledger, REF, { slot: 1, code: "X", reason: "x", amountIn: 5n, at: T })).toThrow(RunStateError);
    ledger = recordMissed(ledger, REF, { fromSlot: 2, toSlot: 6, at: T });
    expect(entry(ledger).runs[1]).toMatchObject({ slot: 6, missed: 5, codes: [RUN_CODES.MISSED], status: "skipped" });
    expect(entry(ledger).lastSlot).toBe(1);
    ledger = markSeen(ledger, REF, { slot: 7, active: true });
    expect(entry(ledger).lastSeen).toEqual({ slot: 7, active: true });
  });

  it("keeps the newest runs only", () => {
    let ledger = started();
    for (let slot = 0; slot < MAX_RUNS + 5; slot++) {
      ledger = closeWindow(ledger, REF, { slot, code: "X", reason: "x", amountIn: 1n, at: T });
    }
    expect(entry(ledger).runs).toHaveLength(MAX_RUNS);
    expect(entry(ledger).runs[0]!.slot).toBe(5);
  });

  it("removes an entry", () => {
    expect(entryOf(removeEntry(started(), REF), REF)).toBeUndefined();
  });
});

describe("a claim the record lost", () => {
  it("is put back — window used, spending committed — and the plan stopped", () => {
    const claimed = claimBuy(started(), REF, { slot: 4, amountIn: 7n, at: T, calls: 1, deadline: 100, ownerNonce: 12 });
    const run = entry(recordSent(claimed, REF, 4, HASH_1, "swap")).runs.at(-1)!;
    // Another tab wrote back the record as it stood before the claim.
    const lost = started();
    const restored = reinstateClaim(lost, REF, run, "the record changed under a buy");
    expect(entry(restored)).toMatchObject({ lastSlot: 4, committed: "7", halted: "the record changed under a buy" });
    expect(entry(restored).runs.at(-1)).toEqual(run);
    // And the settlement the runner came to record now fits.
    const settled = settleBuy(restored, REF, { slot: 4, amountOut: 9n, at: T + 1 });
    expect(entry(settled)).toMatchObject({ buysDone: 1, committed: "7", lastSlot: 4 });
    expect(() => claimBuy(settled, REF, { slot: 4, amountIn: 7n, at: T })).toThrow(ClaimRefusedError);
  });

  it("changes nothing when the claim is still there, and refuses what it cannot put back", () => {
    const claimed = claimBuy(started(), REF, { slot: 4, amountIn: 7n, at: T });
    const run = entry(claimed).runs.at(-1)!;
    expect(entry(reinstateClaim(claimed, REF, run, "x"))).toEqual(entry(claimed));
    const other = claimBuy(started(), REF, { slot: 5, amountIn: 1n, at: T });
    expect(() => reinstateClaim(other, REF, run, "x")).toThrow(RunStateError);
    expect(() => reinstateClaim(started(), REF, { ...run, status: "confirmed" }, "x")).toThrow(RunStateError);
    expect(() => reinstateClaim(removeEntry(claimed, REF), REF, run, "x")).toThrow(/no record/);
  });
});

describe("transfers and the start time", () => {
  const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  /** A record with the transfers an autopilot plan recorded before config version 8: nothing adds them now. */
  function withTransfers(): Record<string, unknown> {
    const raw = JSON.parse(JSON.stringify(started(SPENDER)));
    raw.entries[`${REF.chainId}:${REF.planId}`].transfers = [
      { kind: "funded", at: T, amounts: [{ token: USDC, amount: "10" }, { token: ETH, amount: "3" }], hashes: [HASH_1, HASH_2] },
      { kind: "topped-up", at: T + 1, amounts: [{ token: ETH, amount: "1" }], hashes: [HASH_1] },
      { kind: "withdrawn", at: T + 2, amounts: [{ token: USDC, amount: "4" }], hashes: [HASH_1, HASH_2], reason: "the ether sweep was not confirmed" },
    ];
    return raw;
  }

  it("keeps an old plan's transfers as its history, through the store's round trip", () => {
    const l = parseLedger(withTransfers())!;
    const transfers = entry(l).transfers!;
    expect(transfers.map((t) => t.kind)).toEqual(["funded", "topped-up", "withdrawn"]);
    expect(transfers[2]).toMatchObject({ reason: "the ether sweep was not confirmed", hashes: [HASH_1, HASH_2] });
    const storage = memoryStorage();
    const store = new LedgerStore(storage, { events: null });
    store.update(() => l);
    expect(entry(store.read() as DcaLedger).transfers).toEqual(transfers);
  });

  it("a malformed transfer fails the whole read", () => {
    const raw = withTransfers() as { entries: Record<string, { transfers: { amounts: { amount: string }[] }[] }> };
    raw.entries[`${REF.chainId}:${REF.planId}`]!.transfers[0]!.amounts[0]!.amount = "-1";
    expect(parseLedger(raw)).toBeNull();
    const gift = withTransfers() as { entries: Record<string, { transfers: unknown[] }> };
    gift.entries[`${REF.chainId}:${REF.planId}`]!.transfers[0] = { kind: "gift", at: T, amounts: [], hashes: [] };
    expect(parseLedger(gift)).toBeNull();
  });

  it("the start time may move only while no window has been used", () => {
    expect(canMoveStart(undefined)).toBe(true);
    expect(canMoveStart(entry(started()))).toBe(true);
    const claimed = claimBuy(started(), REF, { slot: 0, amountIn: 5n, at: T });
    expect(canMoveStart(entry(claimed))).toBe(false);
    const skipped = closeWindow(started(), REF, { slot: 0, code: RUN_CODES.SKIPPED_BY_USER, reason: "x", amountIn: 5n, at: T });
    expect(canMoveStart(entry(skipped))).toBe(false);
  });
});

describe("LedgerStore — fail closed", () => {
  it("a missing key is an empty ledger; a write round-trips through JSON", () => {
    const storage = memoryStorage();
    const store = new LedgerStore(storage, { events: null });
    expect(store.read()).toEqual(emptyLedger());
    store.update((l) => claimBuy(startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }), REF, { slot: 0, amountIn: 5n, at: T }));
    expect(JSON.parse(storage.data[LEDGER_KEY]!)).toMatchObject({ version: 1 });
    const back = store.read();
    expect(back).not.toBe("unavailable");
    expect(entry(back as DcaLedger).committed).toBe("5");
  });

  it("corrupt JSON, a wrong shape, a throwing storage or no storage all read as unavailable", () => {
    expect(new LedgerStore(memoryStorage({ [LEDGER_KEY]: "{not json" }), { events: null }).read()).toBe("unavailable");
    expect(new LedgerStore(memoryStorage({ [LEDGER_KEY]: '{"version":2,"entries":{}}' }), { events: null }).read()).toBe(
      "unavailable",
    );
    const good = JSON.parse(JSON.stringify(claimBuy(started(), REF, { slot: 0, amountIn: 5n, at: T })));
    good.entries["690069:plan-a"].committed = -5;
    expect(new LedgerStore(memoryStorage({ [LEDGER_KEY]: JSON.stringify(good) }), { events: null }).read()).toBe(
      "unavailable",
    );
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(new LedgerStore(throwing, { events: null }).read()).toBe("unavailable");
    expect(new LedgerStore(null, { events: null }).read()).toBe("unavailable");
  });

  it("an entry filed under another plan's key is refused", () => {
    const moved = JSON.parse(JSON.stringify(started()));
    moved.entries = { "690069:plan-b": moved.entries["690069:plan-a"] };
    expect(parseLedger(moved)).toBeNull();
  });

  it("refuses to write over what it cannot read", () => {
    const storage = memoryStorage({ [LEDGER_KEY]: "garbage" });
    const store = new LedgerStore(storage, { events: null });
    expect(() => store.update((l) => l)).toThrow(LedgerUnavailableError);
    expect(storage.data[LEDGER_KEY]).toBe("garbage");
  });

  it("a storage that refuses writes throws rather than pretending", () => {
    const storage: StorageLike = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    const store = new LedgerStore(storage, { events: null });
    expect(() => store.update((l) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }))).toThrow(/Quota/);
  });

  it("writes nothing when a change changes nothing, so a stale copy is never written back", () => {
    const storage = memoryStorage();
    let writes = 0;
    const counting: StorageLike = { getItem: storage.getItem, setItem: (k, v) => (writes++, storage.setItem(k, v)) };
    const store = new LedgerStore(counting, { events: null });
    const start = (l: DcaLedger) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T });
    store.update(start);
    expect(writes).toBe(1);
    store.update(start);
    store.update((l) => ({ version: 1, entries: { ...l.entries } })); // a copy with the same content
    expect(writes).toBe(1);
  });

  it("round-trips the fields a buy carries for later: its nonce, its count, an unanswered wallet", () => {
    const store = new LedgerStore(memoryStorage(), { events: null });
    store.update((l) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }));
    store.update((l) => claimBuy(l, REF, { slot: 0, amountIn: 1n, at: T, ownerNonce: 41 }));
    store.update((l) => markUnknown(l, REF, { slot: 0, reason: "timed out", at: T, walletUnanswered: true }));
    store.update((l) => recordAttempt(l, REF, { slot: 1, status: "skipped", reason: "r", codes: [], amountIn: 1n, at: T }));
    const read = store.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(entry(read).runs[0]).toMatchObject({ ownerNonce: 41, walletUnanswered: true, status: "unknown" });
    expect(entry(read).runs[1]).toMatchObject({ counted: true });
    expect(() => claimBuy(started(), REF, { slot: 0, amountIn: 1n, at: T, ownerNonce: -1 })).toThrow(ClaimRefusedError);
  });

  it("notifies on its own writes and on other tabs' storage events for its key", () => {
    const listeners: ((event: { key: string | null }) => void)[] = [];
    const events = {
      addEventListener: (_: "storage", l: (event: { key: string | null }) => void) => listeners.push(l),
      removeEventListener: () => {},
    };
    const store = new LedgerStore(memoryStorage(), { events });
    let calls = 0;
    store.subscribe(() => calls++);
    store.update((l) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }));
    listeners.forEach((l) => l({ key: LEDGER_KEY }));
    listeners.forEach((l) => l({ key: "something.else" }));
    expect(calls).toBe(2);
  });
});

/** Web Locks, in memory: one holder per name, the rest queued in order; `signal` withdraws a queued request. */
class Locks implements LedgerLocks {
  #held = new Set<string>();
  #queue = new Map<string, (() => void)[]>();
  names: string[] = [];

  request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | void) {
    this.names.push(name);
    const run = async () => {
      this.#held.add(name);
      try {
        return await callback({ name });
      } finally {
        this.#held.delete(name);
        this.#queue.get(name)?.shift()?.();
      }
    };
    if (!this.#held.has(name)) return run();
    return new Promise<unknown>((resolve, reject) => {
      const waiting = () => void run().then(resolve, reject);
      this.#queue.set(name, [...(this.#queue.get(name) ?? []), waiting]);
      options.signal?.addEventListener("abort", () => {
        const queue = this.#queue.get(name) ?? [];
        const index = queue.indexOf(waiting);
        if (index >= 0) queue.splice(index, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
}

describe("LedgerStore — several tabs", () => {
  it("a UI write waits for the runner's buy to be recorded, and is made from the record as it then stands", async () => {
    // Two tabs: one storage, one lock manager, a store each.
    const storage = memoryStorage();
    const locks = new Locks();
    const runnerTab = new LedgerStore(storage, { events: null, locks });
    const otherTab = new LedgerStore(storage, { events: null, locks });
    runnerTab.update((l) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }));

    const order: string[] = [];
    let finishBuy!: () => void;
    const buyDone = new Promise<void>((resolve) => (finishBuy = resolve));
    const buy = runnerTab.exclusive(async () => {
      runnerTab.update((l) => claimBuy(l, REF, { slot: 0, amountIn: 5n, at: T }));
      order.push("claimed");
      await buyDone; // the swap is out, waiting for its receipt
      runnerTab.update((l) => settleBuy(l, REF, { slot: 0, amountOut: 1n, at: T + 1 }));
      order.push("settled");
    });
    // The other tab presses Resume in the middle of the buy.
    const resumed = otherTab.updateShared((l) => {
      order.push("resume sees " + JSON.stringify({ lastSlot: entry(l).lastSlot, buysDone: entry(l).buysDone }));
      return resume(l, REF);
    });
    await Promise.resolve();
    expect(order).toEqual(["claimed"]);
    finishBuy();
    await Promise.all([buy, resumed]);
    expect(order).toEqual(["claimed", "settled", 'resume sees {"lastSlot":0,"buysDone":1}']);
    const read = runnerTab.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(entry(read)).toMatchObject({ lastSlot: 0, buysDone: 1, committed: "5" });
    expect(locks.names.every((name) => name === LEDGER_LOCK)).toBe(true);
  });

  it("a UI write that cannot get the lock in time writes nothing and says so", async () => {
    const storage = memoryStorage();
    const locks = new Locks();
    const runnerTab = new LedgerStore(storage, { events: null, locks });
    const otherTab = new LedgerStore(storage, { events: null, locks });
    runnerTab.update((l) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }));
    let release!: () => void;
    const holding = runnerTab.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    const before = storage.data[LEDGER_KEY];
    await expect(otherTab.updateShared((l) => removeEntry(l, REF), { timeoutMs: 20 })).rejects.toBeInstanceOf(LedgerBusyError);
    expect(storage.data[LEDGER_KEY]).toBe(before);
    release();
    await holding;
    // Once free, it goes through.
    await otherTab.updateShared((l) => removeEntry(l, REF), { timeoutMs: 20 });
    expect(JSON.parse(storage.data[LEDGER_KEY]!)).toEqual(emptyLedger());
  });

  it("without Web Locks, writes directly: that browser runs no auto-buys", async () => {
    const store = new LedgerStore(memoryStorage(), { events: null, locks: null });
    await store.updateShared((l) => startEntry(l, { ...REF, owner: OWNER, signer: OWNER, at: T }));
    expect(await store.exclusive(async () => 7)).toBe(7);
  });
});
