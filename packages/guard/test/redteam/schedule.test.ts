/**
 * Red team: scheduled buys.
 *
 * A scheduled buy spends the user's money with nobody looking. What authorises
 * it is a plan the user wrote earlier, so the claim under test is that nothing
 * outside that plan is ever signable — whoever proposed it: a scheduler module,
 * the host's own timer, a second tab, a retry, or a config that arrived in a
 * shared link. Each case starts from `honestBuy()` and changes one thing, so
 * the diff from honest *is* the attack.
 *
 * The swap underneath is still a swap, so the cases at the end check that the
 * ordinary Guard ran on it unchanged: composing the schedule layer on top must
 * only ever add refusals.
 *
 * If any of these goes green-to-red, do not ship.
 */

import { describe, expect, it } from "vitest";
import {
  AMOUNT_IN,
  ATTACKER,
  COLD_WALLET,
  HONEST_OUT,
  NATIVE,
  NATIVE_AMOUNT_IN,
  NATIVE_HONEST_OUT,
  NATIVE_MIN_OUT,
  NOW,
  ROUTER,
  SPX,
  USDC,
  USER,
  WETH,
  honestIntent,
  honestManifest,
  honestPlan,
  nativeIntent,
  nativePlan,
  permit2ApprovalLog,
  transferLog,
  FlakySimulationProvider,
  NoSimulationProvider,
  ScriptedSimulationProvider,
} from "@spdex/testing";
import {
  MIN_DCA_INTERVAL_SECONDS,
  PERMIT2_ADDRESS,
  type DcaPlan,
  type DcaProgress,
  type GuardViolationCode,
  type SwapIntent,
} from "@spdex/core";
import type { SimLog, SimulationOutcome, SimulationProvider, SimulationRequest } from "@spdex/chain";
import { Guard, type GuardInput, type OracleProvider } from "../../src/guard.js";
import { ScheduledBuyGuard, runScheduleChecks, type ScheduledBuyInput } from "../../src/schedule.js";

const OPTIONS = { chainId: 1, requireSimulation: false, oracleDivergenceBps: 200 };

/**
 * A fresh address standing in for a spending wallet: what a record written
 * for an autopilot plan, before config version 8, names as its signer.
 */
const SPENDING = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as const;

const INTERVAL = 3_600;
const MAX_BUYS = 10;
/** Window 3 opened a minute ago. */
const SLOT = 3;
const START = Number(NOW) - SLOT * INTERVAL - 60;
const BUDGET = NATIVE_AMOUNT_IN * BigInt(MAX_BUYS);

/** Ether into SPX once an hour, ten times: the pair the app defaults to. */
function dcaPlan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "eth-to-spx",
    paused: false,
    chainId: 1,
    sell: NATIVE,
    buy: SPX,
    amountPerBuy: NATIVE_AMOUNT_IN.toString(),
    intervalSeconds: INTERVAL,
    maxBuys: MAX_BUYS,
    startAt: START,
    signer: "wallet",
    ...overrides,
  };
}

/** Three buys done, in windows 0–2, each claimed at full size. */
function progress(overrides: Partial<DcaProgress> = {}): DcaProgress {
  return {
    planId: "eth-to-spx",
    chainId: 1,
    owner: USER,
    signer: USER,
    buysDone: 3,
    committed: 3n * NATIVE_AMOUNT_IN,
    lastSlot: 2,
    ...overrides,
  };
}

/**
 * One leg selling `amount` of ether for SPX, with the floor and quote scaled
 * to match, built the way the host builds it: one intent, carried by the plan
 * and expected by the Guard alike.
 */
function nativeLeg(intentOverrides: Partial<SwapIntent> = {}, amount = NATIVE_AMOUNT_IN): GuardInput {
  const intent = nativeIntent({
    maxAmountIn: amount,
    minAmountOut: (NATIVE_MIN_OUT * amount) / NATIVE_AMOUNT_IN,
    ...intentOverrides,
  });
  const plan = nativePlan({
    intent,
    calls: [{ to: ROUTER, data: "0xdeadbeef", value: amount }],
    meta: { ...nativePlan().meta, quotedAmountOut: (NATIVE_HONEST_OUT * amount) / NATIVE_AMOUNT_IN },
  });
  return {
    plan,
    expectedIntent: intent,
    manifest: honestManifest(),
    extraTrustedContracts: [],
    nowSeconds: NOW,
  };
}

/** What that leg does on chain: ether leaves the signer, SPX lands on the recipient. */
function buyLogs(
  { signer = USER, recipient = USER, amount = NATIVE_AMOUNT_IN }: {
    signer?: string;
    recipient?: string;
    amount?: bigint;
  } = {},
): SimLog[] {
  return [
    transferLog(NATIVE, signer as `0x${string}`, ROUTER, amount),
    transferLog(SPX, ROUTER, recipient as `0x${string}`, (NATIVE_HONEST_OUT * amount) / NATIVE_AMOUNT_IN),
  ];
}

function honestBuy(overrides: Partial<ScheduledBuyInput> = {}): ScheduledBuyInput {
  return {
    plan: dcaPlan(),
    progress: progress(),
    slot: SLOT,
    legs: [nativeLeg()],
    chainId: 1,
    nowSeconds: NOW,
    ...overrides,
  };
}

const scheduledWith = (provider: SimulationProvider, options: Partial<typeof OPTIONS> = {}) =>
  new ScheduledBuyGuard(new Guard(provider, { ...OPTIONS, ...options }));

const guardWith = (logs: SimLog[]) => scheduledWith(ScriptedSimulationProvider.succeedingWith(logs));

const codes = (v: { violations: { code: GuardViolationCode }[] }) => v.violations.map((x) => x.code);

/** Answers each simulation with the next outcome in line, so legs can differ. */
class SequencedSimulationProvider implements SimulationProvider {
  readonly kind = "eth_simulateV1" as const;
  readonly requests: SimulationRequest[] = [];
  constructor(private readonly outcomes: SimLog[][]) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    const logs = this.outcomes[this.requests.length] ?? [];
    this.requests.push(request);
    return { status: "success", gasUsed: 150_000n, logs };
  }
}

describe("a scheduled buy — the honest baseline", () => {
  it("permits an on-schedule buy", async () => {
    // If this fails, every refusal below is meaningless: a guard that refuses
    // every scheduled buy is trivially safe and makes the feature a lie.
    const verdict = await guardWith(buyLogs()).check(honestBuy());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
    expect(verdict.signable).toBe(true);
  });

  it("passes the schedule checks with nothing to say", () => {
    const input = honestBuy();
    expect(
      runScheduleChecks({ ...input, intents: input.legs.map((leg) => leg.plan.intent) }),
    ).toEqual([]);
  });

  it("permits the first buy of a plan that has just started", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({
        plan: dcaPlan({ startAt: Number(NOW) - 60 }),
        progress: progress({ buysDone: 0, committed: 0n, lastSlot: null }),
        slot: 0,
      }),
    );
    expect(verdict.level).toBe("verified");
  });

  it("permits the final buy, landing exactly on the budget", async () => {
    // The boundary itself is legal; an off-by-one here would make the last buy
    // of every plan impossible.
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({
        progress: progress({ buysDone: MAX_BUYS - 1, committed: BUDGET - NATIVE_AMOUNT_IN, lastSlot: 8 }),
        plan: dcaPlan({ startAt: Number(NOW) - 9 * INTERVAL - 60 }),
        slot: 9,
      }),
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("permits a split route whose legs together make one buy", async () => {
    const half = NATIVE_AMOUNT_IN / 2n;
    const verdict = await guardWith(buyLogs({ amount: half })).check(
      honestBuy({ legs: [nativeLeg({ nonce: "0x01" }, half), nativeLeg({ nonce: "0x02" }, half)] }),
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("permits an honest token sale, whose one approval covers one buy", async () => {
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(WETH, ROUTER, USER, HONEST_OUT),
    ]).check(
      honestBuy({
        plan: dcaPlan({ sell: SPX, buy: WETH, amountPerBuy: AMOUNT_IN.toString() }),
        progress: progress({ committed: 3n * AMOUNT_IN }),
        legs: [
          {
            plan: honestPlan(),
            expectedIntent: honestIntent(),
            manifest: honestManifest(),
            extraTrustedContracts: [],
            nowSeconds: NOW,
          },
        ],
      }),
    );
    expect(verdict.level).toBe("verified");
  });
});

describe("Red team — a buy outside the plan", () => {
  it("refuses buying a different token", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ legs: [nativeLeg({ tokenOut: USDC })] }));
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses spending a different token", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ legs: [nativeLeg({ tokenIn: WETH })] }));
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a leg aimed at another chain", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ legs: [nativeLeg({ chainId: 8453 })] }));
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a plan written for another chain, even with a record to match", async () => {
    // Token addresses mean something on one chain. A plan set up against a
    // fork must not start spending on mainnet because the endpoint changed.
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({
        plan: dcaPlan({ chainId: 690069 }),
        progress: progress({ chainId: 690069 }),
        legs: [nativeLeg({ chainId: 690069 })],
      }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses delivery to the owner's own cold wallet — which a manual swap allows", async () => {
    // The difference is the point. A person may send a swap's output anywhere
    // they name; a plan delivers to its owner and nowhere else, because a plan
    // that can deliver elsewhere is one an edited config can point at anyone.
    const cold = nativeLeg({ recipient: COLD_WALLET });
    const logs = buyLogs({ recipient: COLD_WALLET });

    const manual = await new Guard(ScriptedSimulationProvider.succeedingWith(logs), OPTIONS).check(cold);
    expect(manual.level).toBe("verified");

    const scheduled = await guardWith(logs).check(honestBuy({ legs: [cold] }));
    expect(scheduled.signable).toBe(false);
    expect(codes(scheduled)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a buy signed by an account that is not the plan's signer", async () => {
    // Another wallet connected in the same browser, or a plan copied from
    // somebody else's config: either way, not who this plan was bound to.
    const verdict = await guardWith(buyLogs({ signer: COLD_WALLET })).check(
      honestBuy({ legs: [nativeLeg({ account: COLD_WALLET })] }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a wallet-mode plan whose record names some other signer", async () => {
    // The user chose "my wallet asks each time". Something else signing, even
    // something that delivers to them, is not the plan they were shown.
    const verdict = await guardWith(buyLogs({ signer: SPENDING })).check(
      honestBuy({ progress: progress({ signer: SPENDING }), legs: [nativeLeg({ account: SPENDING })] }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a buy from an old spending wallet for a plan migrated to confirm-each-buy", async () => {
    // What a v7 autopilot plan becomes: a wallet plan, whose record still
    // names its spending wallet until it is resumed. Nothing signs with that
    // wallet any more, delivering to the owner or not; the record has to be
    // bound to the owner first.
    const verdict = await guardWith(buyLogs({ signer: SPENDING })).check(
      honestBuy({
        progress: progress({ signer: SPENDING }),
        legs: [nativeLeg({ account: SPENDING, recipient: USER })],
      }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses the autopilot signing mode, which no longer exists, whatever the record says", async () => {
    // A plan that still says it (a config the schema never saw) is not one
    // anybody was shown under today's two modes. Signed by the spending
    // wallet or by the owner, it is refused either way.
    const autopilot = dcaPlan({ signer: "autopilot" as DcaPlan["signer"] });
    const bySpending = await guardWith(buyLogs({ signer: SPENDING })).check(
      honestBuy({
        plan: autopilot,
        progress: progress({ signer: SPENDING }),
        legs: [nativeLeg({ account: SPENDING, recipient: USER })],
      }),
    );
    expect(codes(bySpending)).toEqual(["SCHEDULE_MISMATCH"]);
    const byOwner = await guardWith(buyLogs()).check(honestBuy({ plan: autopilot }));
    expect(codes(byOwner)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a signing mode spDEX does not know", async () => {
    // Anything but "wallet" (and "vault", which this tab never buys for) means
    // nobody was shown who signs.
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ plan: dcaPlan({ signer: "delegate" as DcaPlan["signer"] }) }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a record bound to the zero address, which would burn every buy", async () => {
    // The preview account — what the app uses before a wallet connects — is
    // the zero address. A plan bound to it delivers to nobody.
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ progress: progress({ owner: zero, signer: zero }), legs: [nativeLeg({ account: zero, recipient: zero })] }),
    );
    // One for the owner, one for the signer.
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH", "SCHEDULE_MISMATCH"]);
  });

  it("refuses a leg with no price floor", async () => {
    // Nobody is watching the price when this runs. A zero floor accepts any.
    const verdict = await guardWith(buyLogs()).check(honestBuy({ legs: [nativeLeg({ minAmountOut: 0n })] }));
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a paused plan", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ plan: dcaPlan({ paused: true }) }));
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("treats a plan with no pause flag at all as paused", async () => {
    // A plan missing the field never passed the schema. Unknown means stopped.
    const { paused: _paused, ...rest } = dcaPlan();
    const verdict = await guardWith(buyLogs()).check(honestBuy({ plan: rest as DcaPlan }));
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });

  it("refuses a buy with no legs, rather than verifying nothing", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ legs: [] }));
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH"]);
  });
});

describe("Red team — more than one buy's worth", () => {
  it("refuses a leg larger than one buy", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ legs: [nativeLeg({}, NATIVE_AMOUNT_IN + 1n)] }),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUY"]);
  });

  it("counts legs together, not one at a time", async () => {
    // Each leg under the per-buy amount, the route over it. Checking per leg
    // would let any limit be evaded by splitting the route.
    const most = (NATIVE_AMOUNT_IN * 3n) / 4n;
    const verdict = await guardWith(buyLogs({ amount: most })).check(
      honestBuy({ legs: [nativeLeg({ nonce: "0x01" }, most), nativeLeg({ nonce: "0x02" }, most)] }),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUY"]);
  });

  it("does not let a negative leg make room for an oversized one", async () => {
    // Summing signed amounts would net 2x and −1x to 1x and pass. The negative
    // leg is refused on its own, and the sum counts only what could leave.
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({
        legs: [
          nativeLeg({ nonce: "0x01" }, NATIVE_AMOUNT_IN * 2n),
          nativeLeg({ nonce: "0x02", minAmountOut: NATIVE_MIN_OUT }, -NATIVE_AMOUNT_IN),
        ],
      }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_MISMATCH", "SCHEDULE_EXCEEDS_BUY"]);
  });

  it("refuses when the plan's per-buy amount is unreadable, rather than allowing any", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ plan: dcaPlan({ amountPerBuy: "one ether" }) }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUY"]);
  });

  it("refuses an approval for the whole budget, even on an on-schedule buy", async () => {
    // Approving the budget once would make every later buy a spend nobody
    // checked. The swap Guard bounds each approval by its own leg, and the
    // schedule layer inherits that rather than relaxing it.
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(WETH, ROUTER, USER, HONEST_OUT),
    ]).check(
      honestBuy({
        plan: dcaPlan({ sell: SPX, buy: WETH, amountPerBuy: AMOUNT_IN.toString() }),
        progress: progress({ committed: 3n * AMOUNT_IN }),
        legs: [
          {
            plan: honestPlan({
              approvals: [{ token: SPX, spender: ROUTER, amount: AMOUNT_IN * BigInt(MAX_BUYS) }],
            }),
            expectedIntent: honestIntent(),
            manifest: honestManifest(),
            extraTrustedContracts: [],
            nowSeconds: NOW,
          },
        ],
      }),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["APPROVAL_EXCEEDS_INTENT"]);
  });
});

describe("Red team — past the budget", () => {
  it("refuses a buy that would take the plan one unit past its budget", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ progress: progress({ committed: BUDGET - NATIVE_AMOUNT_IN + 1n }) }),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
  });

  it("refuses any buy once the plan has made all of its buys", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ progress: progress({ buysDone: MAX_BUYS }) }));
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
  });

  it("refuses when the record of past spending is missing — exhausted, never zero", async () => {
    // Cleared site data, a private window, a storage error. A missing record
    // read as zero would restart the budget; read as exhausted, it stops the
    // plan until the user looks.
    const provider = ScriptedSimulationProvider.succeedingWith(buyLogs());
    const verdict = await scheduledWith(provider).check(honestBuy({ progress: null }));
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses a record that belongs to another plan", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ progress: progress({ planId: "someone-elses", committed: 0n }) }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
  });

  it("refuses a record kept for another chain", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ progress: progress({ chainId: 690069, committed: 0n }) }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
  });

  it("refuses a record whose figures cannot be read, rather than coercing them", async () => {
    // A record deserialised carelessly holds strings. `"0" + 1n` is "01", and
    // a comparison against it still answers — so shape is checked first.
    for (const committed of ["0" as unknown as bigint, -BUDGET]) {
      const verdict = await guardWith(buyLogs()).check(honestBuy({ progress: progress({ committed }) }));
      expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
    }
    const fractional = await guardWith(buyLogs()).check(honestBuy({ progress: progress({ buysDone: 2.5 }) }));
    expect(codes(fractional)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
  });

  it("refuses a plan longer than any plan may be", async () => {
    // Every plan ends, and the bound on how long is a constant.
    const verdict = await guardWith(buyLogs()).check(honestBuy({ plan: dcaPlan({ maxBuys: 1_000_000 }) }));
    expect(codes(verdict)).toEqual(["SCHEDULE_EXCEEDS_BUDGET"]);
  });
});

describe("Red team — a buy that is not due", () => {
  it("refuses a buy before the plan's first window opens", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({
        plan: dcaPlan({ startAt: Number(NOW) + 60 }),
        progress: progress({ buysDone: 0, committed: 0n, lastSlot: null }),
        slot: 0,
      }),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
  });

  it("refuses a replayed window", async () => {
    // Two tabs, a re-render, a retry after a timeout — each asks for the same
    // window again. Only the first claim may buy.
    const verdict = await guardWith(buyLogs()).check(honestBuy({ progress: progress({ lastSlot: SLOT }) }));
    expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
  });

  it("refuses making up a missed window later", async () => {
    // Window 2 was missed while no tab was open. Buying it now, alongside
    // window 3, is the catch-up burst a plan promises never to do.
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ progress: progress({ buysDone: 2, committed: 2n * NATIVE_AMOUNT_IN, lastSlot: 1 }), slot: 2 }),
    );
    expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
  });

  it("refuses a window that has not opened yet", async () => {
    const verdict = await guardWith(buyLogs()).check(honestBuy({ slot: SLOT + 1 }));
    expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
  });

  it("refuses an interval below the floor, whatever the config said", async () => {
    // The floor is a constant, not a setting. A config asking for a buy every
    // minute — a bug, a bad import, a hostile shared link — is refused here
    // whether or not the schema was ever asked.
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({ plan: dcaPlan({ intervalSeconds: MIN_DCA_INTERVAL_SECONDS - 1 }) }),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
  });

  it("allows exactly the floor", async () => {
    const verdict = await guardWith(buyLogs()).check(
      honestBuy({
        plan: dcaPlan({
          intervalSeconds: MIN_DCA_INTERVAL_SECONDS,
          startAt: Number(NOW) - SLOT * MIN_DCA_INTERVAL_SECONDS - 10,
        }),
      }),
    );
    expect(verdict.level).toBe("verified");
  });

  it("refuses a window number that is not a window", async () => {
    // The window arithmetic cannot run on these, and skipping it must not
    // read as passing it.
    for (const slot of [-1, 2.5, Number.NaN]) {
      const verdict = await guardWith(buyLogs()).check(honestBuy({ slot }));
      expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
    }
  });

  it("refuses a plan whose start is not a moment in time", async () => {
    for (const startAt of [-1, START + 0.5]) {
      const verdict = await guardWith(buyLogs()).check(honestBuy({ plan: dcaPlan({ startAt }) }));
      expect(codes(verdict)).toEqual(["SCHEDULE_NOT_DUE"]);
    }
  });

  it("judges every leg by the same clock as the window", async () => {
    // The host stamps legs as it builds them. A leg carrying an older clock
    // must not get its deadline judged at a moment the window check never saw.
    const stale = { ...nativeLeg({ deadline: NOW - 1n }), nowSeconds: NOW - 120n };
    const verdict = await guardWith(buyLogs()).check(honestBuy({ legs: [stale] }));
    expect(codes(verdict)).toEqual(["DEADLINE_EXPIRED"]);
  });
});

describe("Composition — the swap Guard still runs, unchanged", () => {
  it("still refuses proceeds redirected to an attacker", async () => {
    // Inside the plan in every respect the schedule layer can see; the swap
    // itself delivers elsewhere. Only simulation can tell, and it must still run.
    const verdict = await guardWith(buyLogs({ recipient: ATTACKER })).check(honestBuy());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["RECIPIENT_MISMATCH"]);
  });

  it("refuses a buy outside the plan without simulating it", async () => {
    // Simulating would tell the endpoint what the user is about to buy, for
    // nothing: the answer is already no.
    const provider = ScriptedSimulationProvider.succeedingWith(buyLogs());
    const verdict = await scheduledWith(provider).check(honestBuy({ plan: dcaPlan({ paused: true }) }));
    expect(verdict.signable).toBe(false);
    expect(provider.lastRequest).toBeNull();
  });

  it("checks every leg, and one bad leg is not outvoted by a good one", async () => {
    const half = NATIVE_AMOUNT_IN / 2n;
    const provider = new SequencedSimulationProvider([
      buyLogs({ amount: half }),
      buyLogs({ amount: half, recipient: ATTACKER }),
    ]);
    const verdict = await scheduledWith(provider).check(
      honestBuy({ legs: [nativeLeg({ nonce: "0x01" }, half), nativeLeg({ nonce: "0x02" }, half)] }),
    );
    expect(provider.requests).toHaveLength(2);
    expect(verdict.signable).toBe(false);
    const redirected = verdict.violations.find((v) => v.code === "RECIPIENT_MISMATCH");
    expect(redirected?.detail?.leg).toBe("1");
  });

  it("never reads a rejection that gives no reason as a pass", async () => {
    // The Guard always names what it refused. If it ever did not, an empty
    // violation list must still not fall through to `verified`.
    const silent = {
      check: async () => ({ level: "rejected", signable: false, violations: [], warnings: [] }),
    } as unknown as Guard;
    const verdict = await new ScheduledBuyGuard(silent).check(honestBuy());
    expect(verdict.level).toBe("rejected");
    expect(verdict.signable).toBe(false);
    expect(verdict.violations).not.toEqual([]);
  });

  it("refuses a reverting buy", async () => {
    const verdict = await scheduledWith(ScriptedSimulationProvider.reverting("STF")).check(honestBuy());
    expect(codes(verdict)).toEqual(["SIMULATION_REVERTED"]);
  });

  it("refuses a buy that leaves an allowance inside Permit2 for someone else", async () => {
    // A wallet-mode buy is signed by the owner's own wallet, so a venue that
    // slips in Permit2.approve(SPX, attacker, max) arms the permission a
    // batched tip gave Permit2. Permit2 logs its own event for it, not the
    // token's; the swap Guard underneath must still see it.
    const verdict = await guardWith([...buyLogs(), permit2ApprovalLog(USER, SPX, ATTACKER, (1n << 160n) - 1n)]).check(
      honestBuy(),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("refuses a buy with a call to Permit2 in it, before simulating", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith(buyLogs());
    const leg = nativeLeg();
    leg.manifest = honestManifest({ contracts: [...honestManifest().contracts, PERMIT2_ADDRESS] });
    leg.plan = { ...leg.plan, calls: [...leg.plan.calls, { to: PERMIT2_ADDRESS, data: "0x87517c45", value: 0n }] };
    const verdict = await scheduledWith(provider).check(honestBuy({ legs: [leg] }));
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("PERMIT2_TARGET");
    expect(provider.lastRequest).toBeNull();
  });
});

describe("Red team — degraded states never sign unattended", () => {
  it("refuses rather than signs unverified, even when the config allows unverified swaps", async () => {
    // A manual swap may be signed unverified because a person reads the banner
    // that says so. Nobody reads it here, and without simulation nothing shows
    // where the output lands.
    const manual = await new Guard(new NoSimulationProvider(), OPTIONS).check(nativeLeg());
    expect(manual.level).toBe("unverified");
    expect(manual.signable).toBe(true);

    const verdict = await scheduledWith(new NoSimulationProvider()).check(honestBuy());
    expect(verdict.level).toBe("rejected");
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
  });

  it("refuses when a simulation fails mid-flight", async () => {
    const verdict = await scheduledWith(new FlakySimulationProvider()).check(honestBuy());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
  });

  it("refuses when the config demands simulation and none is available", async () => {
    const verdict = await scheduledWith(new NoSimulationProvider(), { requireSimulation: true }).check(honestBuy());
    expect(verdict.level).toBe("rejected");
  });
});

describe("The oracle — a warning, never a refusal", () => {
  it("passes a price warning through as a warning, and the buy stays signable", async () => {
    // AGENTS.md rule 2 holds on this path too: an oracle that can refuse is an
    // oracle worth attacking into refusing. What to do with a warned buy —
    // hold it for the owner rather than sign unattended — is host policy.
    const executedX18 = (NATIVE_HONEST_OUT * 10n ** 18n) / NATIVE_AMOUNT_IN;
    const oracle: OracleProvider = { priceRatio: async () => executedX18 * 2n };
    const guard = new ScheduledBuyGuard(
      new Guard(ScriptedSimulationProvider.succeedingWith(buyLogs()), { ...OPTIONS, oracle }),
    );
    const verdict = await guard.check(honestBuy());
    expect(verdict.level).toBe("verified");
    expect(verdict.signable).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings.map((w) => w.code)).toEqual(["ORACLE_DIVERGENCE"]);
  });
});
