/**
 * The auto-buy scheduler, through both runtimes.
 *
 * The arithmetic is small; the assertions that matter are about what it may
 * never do. It buys at most once per window and only in the window open now,
 * so windows missed while no tab was open are skipped rather than bunched. It
 * stops at the plan's last buy. It reads nothing, not even the clock. And
 * every answer it gives is one the host's own vetting accepts, so nothing it
 * proposes is refused downstream for being outside the plan.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ModuleManifestSchema,
  planBudget,
  scheduleRequest,
  vetScheduleDecision,
  type DcaPlan,
  type DcaProgress,
  type WireScheduleRequest,
} from "@spdex/core";
import {
  BrokerSession,
  CapabilityBroker,
  NativeRuntime,
  QuickJSRuntime,
  assertLoadable,
} from "@spdex/host";
import { runConformance } from "@spdex/module-sdk";
import schedulerModule from "../../index.mjs";

const rawManifest: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), "utf8"),
);
const manifest = ModuleManifestSchema.parse(rawManifest);
const source = readFileSync(fileURLToPath(new URL("../../module.js", import.meta.url)), "utf8");

/** No chain access is granted, and the module asks for none. */
const NO_CHAIN = {
  multicall: (): Promise<string[]> => {
    throw new Error("a scheduler must never reach the chain");
  },
};
const broker = () => new CapabilityBroker({ manifest, chain: NO_CHAIN });

const loadNative = () =>
  new NativeRuntime().loadKind("scheduler", { kind: "object", module: schedulerModule }, broker());
const loadSandboxed = () =>
  new QuickJSRuntime().loadKind("scheduler", { kind: "code", code: source }, broker());

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const HOUR = 3_600;
const DAY = 86_400;
const START = 1_790_000_000;

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "dca-daily",
    paused: false,
    chainId: 1,
    sell: ETH,
    buy: SPX,
    amountPerBuy: "10000000000000000",
    intervalSeconds: DAY,
    maxBuys: 5,
    startAt: START,
    signer: "wallet",
    ...overrides,
  };
}

type Done = Pick<DcaProgress, "planId" | "buysDone" | "lastSlot">;

/** Five seconds into window `slot` of a daily plan starting at START. */
const inWindow = (slot: number) => BigInt(START + slot * DAY + 5);

/** The request exactly as the host builds it. */
const ask = (plans: DcaPlan[], progress: Done[], now: bigint) => scheduleRequest(plans, progress, now);

/** Ask the natively loaded module once. */
async function decide(request: WireScheduleRequest) {
  const scheduler = await loadNative();
  try {
    return await scheduler.dueBuys(request, new BrokerSession());
  } finally {
    scheduler.dispose();
  }
}

/** One request per situation a plan can be in, and one with several plans out of id order. */
const SCENARIOS: Record<string, WireScheduleRequest> = {
  "first window": ask([plan()], [], inWindow(0)),
  "missed windows": ask([plan()], [{ planId: "dca-daily", buysDone: 1, lastSlot: 0 }], inWindow(3)),
  "already bought": ask([plan()], [{ planId: "dca-daily", buysDone: 2, lastSlot: 1 }], inWindow(1)),
  "before start": ask([plan()], [], BigInt(START - 1)),
  "last buy": ask([plan()], [{ planId: "dca-daily", buysDone: 4, lastSlot: 6 }], inWindow(9)),
  finished: ask([plan()], [{ planId: "dca-daily", buysDone: 5, lastSlot: 9 }], inWindow(20)),
  "several plans": ask(
    [
      plan({ id: "dca-z", intervalSeconds: HOUR, maxBuys: 100 }),
      plan({ id: "dca-a", sell: WETH, amountPerBuy: "7" }),
      plan({ id: "dca-m", startAt: START + 10 * DAY }),
    ],
    [{ planId: "dca-z", buysDone: 3, lastSlot: 40 }],
    inWindow(2),
  ),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler-dca", () => {
  it("declares no capabilities, no contracts and no call budget", () => {
    // The strongest declaration a module can make: not that it behaves, but
    // that it was handed nothing to misbehave with.
    expect(manifest.kind).toBe("scheduler");
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.contracts).toEqual([]);
    expect(manifest.limits.maxCallsPerQuote).toBe(0);
  });

  it("loads natively through loadKind and answers with a schema-valid decision", async () => {
    const decision = await decide(SCENARIOS["first window"]!);
    expect(decision).toEqual({
      due: [{ planId: "dca-daily", slot: 0, amountIn: "10000000000000000" }],
      next: [{ planId: "dca-daily", at: String(START + DAY) }],
    });
  });

  it("produces byte-identical output in the sandbox, in every situation", async () => {
    // The parity claim for a scheduler. This is the module a user running
    // with strictSandbox gets, so the sandbox answer is not a second opinion:
    // it is the same answer, or the fast path is load-bearing.
    const native = await loadNative();
    const sandboxed = await loadSandboxed();
    try {
      for (const [name, request] of Object.entries(SCENARIOS)) {
        const a = await native.dueBuys(request, new BrokerSession());
        const b = await sandboxed.dueBuys(request, new BrokerSession());
        expect(JSON.stringify(b), name).toBe(JSON.stringify(a));
      }
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("buys once, for the window open now, however many were missed", async () => {
    // Windows 1 and 2 passed with no tab open. The answer in window 3 is one
    // buy for window 3 — never three buys at one moment's price.
    const decision = await decide(SCENARIOS["missed windows"]!);
    expect(decision.due).toEqual([{ planId: "dca-daily", slot: 3, amountIn: "10000000000000000" }]);
    expect(decision.next).toEqual([{ planId: "dca-daily", at: String(START + 4 * DAY) }]);
  });

  it("does not buy twice in one window", async () => {
    const decision = await decide(SCENARIOS["already bought"]!);
    expect(decision.due).toEqual([]);
    expect(decision.next).toEqual([{ planId: "dca-daily", at: String(START + 2 * DAY) }]);
  });

  it("waits for the first window, and counts down to it", async () => {
    const decision = await decide(SCENARIOS["before start"]!);
    expect(decision.due).toEqual([]);
    expect(decision.next).toEqual([{ planId: "dca-daily", at: String(START) }]);
  });

  it("ends a plan at its last buy", async () => {
    // The last buy is proposed, and the countdown stops with it.
    const last = await decide(SCENARIOS["last buy"]!);
    expect(last.due).toEqual([{ planId: "dca-daily", slot: 9, amountIn: "10000000000000000" }]);
    expect(last.next).toEqual([{ planId: "dca-daily", at: null }]);
    // After it, nothing — however much later it is.
    const after = await decide(SCENARIOS.finished!);
    expect(after).toEqual({ due: [], next: [{ planId: "dca-daily", at: null }] });
  });

  it("does not run ahead of a clock that went backwards", async () => {
    // A record from window 6 and a clock back in window 4: nothing is due until
    // window 7, and the countdown says so rather than pointing at the past.
    const decision = await decide(ask([plan()], [{ planId: "dca-daily", buysDone: 2, lastSlot: 6 }], inWindow(4)));
    expect(decision.due).toEqual([]);
    expect(decision.next).toEqual([{ planId: "dca-daily", at: String(START + 7 * DAY) }]);
  });

  it("answers in id order, so the order plans arrive in cannot change a byte", async () => {
    const plans = [plan({ id: "dca-b" }), plan({ id: "dca-a", buy: WETH }), plan({ id: "dca-c", maxBuys: 1 })];
    const forward = await decide(ask(plans, [], inWindow(1)));
    const reverse = await decide(ask([...plans].reverse(), [], inWindow(1)));
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    expect(forward.next.map((n) => n.planId)).toEqual(["dca-a", "dca-b", "dca-c"]);
    expect(forward.due.map((d) => d.planId)).toEqual(["dca-a", "dca-b", "dca-c"]);
  });

  it("gives the same answer whatever the host's clock says", async () => {
    // The sandbox has no `Date`, so there the module could not read the clock
    // if it tried. Natively it could; this is the check that it does not.
    const request = SCENARIOS["several plans"]!;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
    const early = await decide(request);
    vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));
    const late = await decide(request);
    expect(JSON.stringify(late)).toBe(JSON.stringify(early));
  });

  it("never proposes a buy the host would refuse, over a plan's whole life", async () => {
    // A host ticking every ten minutes for twelve hours, with the tab closed
    // from hour 2 to hour 5. It records a buy the way the real one will: only
    // what vetting accepts, claiming the window as it goes.
    const hourly = plan({ id: "dca-hourly", intervalSeconds: HOUR, maxBuys: 6 });
    const record: Done = { planId: hourly.id, buysDone: 0, lastSlot: null };
    const bought: number[] = [];
    let spent = 0n;
    const scheduler = await loadNative();
    try {
      for (let t = START - 1_800; t < START + 12 * HOUR; t += 600) {
        if (t >= START + 2 * HOUR && t < START + 5 * HOUR) continue; // tab closed
        const now = BigInt(t);
        const request = ask([hourly], [record], now);
        const decision = await scheduler.dueBuys(request, new BrokerSession());
        const { accepted, refused } = vetScheduleDecision(request, decision);
        expect(refused).toEqual([]);
        for (const buy of accepted) {
          bought.push(buy.slot);
          spent += BigInt(buy.amountIn);
          record.buysDone += 1;
          record.lastSlot = buy.slot;
        }
        // A countdown never points into the past, and always at a window.
        const at = decision.next[0]!.at;
        if (at !== null) {
          expect(BigInt(at)).toBeGreaterThan(now);
          expect((BigInt(at) - BigInt(START)) % BigInt(HOUR)).toBe(0n);
        }
      }
    } finally {
      scheduler.dispose();
    }
    // Windows 2, 3 and 4 were missed and stay missed; the plan then runs to
    // its sixth buy and stops.
    expect(bought).toEqual([0, 1, 5, 6, 7, 8]);
    expect(spent).toBe(planBudget(hourly));
  });

  it("refuses a malformed request loudly, the same way in both runtimes", async () => {
    // The host builds the request from a validated config, so these are host
    // bugs. Each has no right answer, and a plausible-looking guess would hide
    // the bug behind a buy.
    const cases: [WireScheduleRequest, RegExp][] = [
      [
        ask([plan()], [
          { planId: "dca-daily", buysDone: 0, lastSlot: null },
          { planId: "dca-daily", buysDone: 3, lastSlot: 2 },
        ], inWindow(3)),
        /two progress records for plan dca-daily/,
      ],
      [ask([plan(), plan()], [], inWindow(0)), /two plans share the id dca-daily/],
      [{ ...ask([plan()], [], inWindow(0)), now: "" }, /now must be a whole number/],
      [{ ...ask([plan()], [], inWindow(0)), now: "1e9" }, /now must be a whole number/],
      [
        ask([plan()], [{ planId: "dca-daily", buysDone: -1, lastSlot: null }], inWindow(0)),
        /buysDone must be a non-negative whole number/,
      ],
    ];
    const native = await loadNative();
    const sandboxed = await loadSandboxed();
    try {
      for (const [request, message] of cases) {
        await expect(native.dueBuys(request, new BrokerSession())).rejects.toThrow(message);
        await expect(sandboxed.dueBuys(request, new BrokerSession())).rejects.toThrow(message);
      }
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("is refused by every other kind's loader", async () => {
    // Kinds are not interchangeable: asking a scheduler to quote fails at load
    // with a readable message, not at the first call with a TypeError.
    await expect(
      new NativeRuntime().load({ kind: "object", module: schedulerModule }, broker()),
    ).rejects.toThrow(/VenueModule/);
    await expect(
      new NativeRuntime().loadRegistry({ kind: "object", module: schedulerModule }, broker()),
    ).rejects.toThrow(/RegistryModule/);
    await expect(
      new NativeRuntime().loadTracker({ kind: "object", module: schedulerModule }, broker()),
    ).rejects.toThrow(/TrackerModule/);
    await expect(
      new QuickJSRuntime().load({ kind: "code", code: source }, broker()),
    ).rejects.toThrow(/discoverPools, quoteBatch, buildCalls/);
  });

  it("passes the conformance kit", async () => {
    const report = await runConformance({ manifest: rawManifest, code: source, chain: NO_CHAIN });
    const failures = report.checks.filter((c) => !c.passed);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(["interface.dueBuys", "scheduler.withinPlan", "scheduler.noChainRead"]),
    );
  }, 30_000);

  it("is admitted by the load gate as a scheduler, and as nothing else", () => {
    expect(() => assertLoadable(manifest, "scheduler")).not.toThrow();
    expect(() => assertLoadable(manifest, "venue")).toThrow(/cannot be loaded as a venue module/);
    expect(() => assertLoadable(manifest, "tiplist")).toThrow(/cannot be loaded as a tiplist module/);
  });
});
