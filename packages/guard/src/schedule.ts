/**
 * The Guard, applied to scheduled buys.
 *
 * A manual swap is authorised by a person looking at it. A scheduled buy is
 * authorised by an instruction the user wrote earlier — "buy this much of that,
 * this often, this many times" — and by nobody at the moment it happens. So a
 * scheduled buy needs one proof a manual swap does not: that it is *inside the
 * plan*. That is the automation analogue of `INTENT_MISMATCH`, which is vacuous
 * in-app for a manual swap because the host builds both sides of it.
 *
 * ## The invariants
 *
 *   1. The mandate. Every leg sells the plan's token for the plan's token, on
 *      the plan's chain, from the signer this browser recorded for the plan,
 *      delivering to the owner and nobody else — not even another wallet the
 *      owner controls, which a manual swap may name. Every leg has a price
 *      floor, since nobody is watching the price. A paused plan buys nothing.
 *   2. One buy's worth. The legs together spend at most `amountPerBuy`,
 *      summed rather than per leg, so splitting a route cannot evade it.
 *   3. The budget. What the plan has already committed plus this buy stays
 *      within `amountPerBuy × maxBuys`, and a finished plan buys nothing. A
 *      record of past spending that is missing or does not belong to this plan
 *      counts as exhausted, never as zero: a wiped record must stop a plan, not
 *      restart its budget.
 *   4. The clock. The buy is for the window open now, that window has not had
 *      its buy, and the interval is at least `MIN_DCA_INTERVAL_SECONDS` —
 *      a constant, checked here as well as by the schema so a bad import
 *      cannot rely on either having run.
 *   5. The swap itself. Each leg then goes through the ordinary `Guard`,
 *      unchanged, and must come back `verified`. `unverified` is signable for
 *      a manual swap because a person reads the banner; nobody reads it here,
 *      and without simulation there is no proof of where the output lands.
 *
 * ## Why composed, not configured
 *
 * The schedule layer wraps a `Guard` rather than adding an option to it, for
 * the reason tips got a guard of their own: an option on the swap check is one
 * edit away from an exemption in it. Composed, the schedule layer can only add
 * refusals. The swap Guard runs byte-for-byte as it does for a manual swap, so
 * nothing a scheduled buy needs can loosen what a manual swap is held to.
 *
 * ## Who this defends against
 *
 * Whatever proposes the buy — a scheduler module, the host's own timer, a
 * second tab, a retry loop — and whatever wrote the plan into the config,
 * including a shared link. A scheduler that lies can make the app skip a buy or
 * ask for a smaller one. It cannot make it spend more, more often, or anywhere
 * but the owner's wallet.
 */

import {
  BaseUnitsSchema,
  MAX_DCA_BUYS,
  MIN_DCA_INTERVAL_SECONDS,
  planBudget,
  rejected,
  slotAt,
  slotOpensAt,
  verified,
  type DcaPlan,
  type DcaProgress,
  type GuardVerdict,
  type GuardViolation,
  type SwapIntent,
} from "@spdex/core";
import type { Guard, GuardInput } from "./guard.js";

export interface ScheduleCheckInput {
  /** The plan as the user wrote it — read from the config, never from a scheduler's answer. */
  plan: DcaPlan;
  /**
   * This browser's record of the plan *before* this buy is claimed, or null
   * when it cannot be read. The host claims the buy only after a signable
   * verdict, and before signing, so a crash in between costs a skipped buy
   * rather than a double one.
   */
  progress: DcaProgress | null;
  /** The window this buy is for. */
  slot: number;
  /** One per leg of the route, as the host built them. */
  intents: readonly SwapIntent[];
  /** The chain the host is connected to. */
  chainId: number;
  /** The host's clock, in unix seconds. The Guard has none of its own. */
  nowSeconds: bigint;
}

export interface ScheduledBuyInput {
  plan: DcaPlan;
  progress: DcaProgress | null;
  slot: number;
  /** Each leg exactly as it would go to `Guard.check` for a manual swap. */
  legs: readonly GuardInput[];
  chainId: number;
  nowSeconds: bigint;
}

/** An address that could receive or sign: well-formed, and not the zero address. */
const isUsableAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);

/** A non-negative whole number that arithmetic on it will not silently round. */
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Address equality that answers "no" instead of throwing on a missing field.
 * `isAddressEqual` would throw, and a Guard that throws has not refused.
 */
const sameAddress = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Every check a scheduled buy must pass before anything is simulated.
 *
 * Pure, and complete on its own: all of the schedule's rules live here rather
 * than some here and some in `ScheduledBuyGuard.check`, so a caller that runs
 * only this function cannot skip one. (TipGuard's chain check lives in its
 * `check`, which is the asymmetry this avoids.)
 *
 * Nothing below assumes the plan passed `DcaPlanSchema` or that the record was
 * written by this code. Each figure the arithmetic depends on is checked for
 * shape first, and one that fails refuses the buy rather than throwing — or,
 * worse, being coerced: `"5" + 3n` is the string `"53"`, and a comparison
 * against that string still produces a boolean.
 */
export function runScheduleChecks(input: ScheduleCheckInput): GuardViolation[] {
  const { plan, progress, slot, intents, chainId, nowSeconds } = input;
  const violations: GuardViolation[] = [];
  const push = (
    code: GuardViolation["code"],
    message: string,
    detail?: Record<string, string>,
  ) => violations.push({ code, message, ...(detail === undefined ? {} : { detail }) });
  const legDetail = (index: number) => (intents.length > 1 ? { leg: String(index) } : {});

  // Decided once, up front: every section below needs to know whether the
  // record can be believed.
  const problem = recordProblem(plan, progress);
  const record = problem === null ? progress : null;

  // ── The mandate ──

  // Anything but an explicit `false` is paused. A plan missing the field did
  // not pass the schema, and the safe reading of "unknown" is "not running".
  if (plan.paused !== false) {
    push("SCHEDULE_MISMATCH", "the plan is paused", { planId: String(plan.id) });
  }

  // Token addresses mean something on one chain only. A plan written against a
  // fork must not start spending on mainnet because the endpoint changed.
  if (plan.chainId !== chainId) {
    push("SCHEDULE_MISMATCH", `the plan is for chain ${plan.chainId}, the host is on ${chainId}`, {
      expected: String(plan.chainId),
      actual: String(chainId),
    });
  }

  if (intents.length === 0) {
    push("SCHEDULE_MISMATCH", "the buy has no legs, so there is nothing to check it against");
  }

  // The record is trusted for identity (who signs, who receives) only when it
  // is this plan's own. A foreign or unreadable record is refused below, as
  // exhausted, and comparing addresses against it would only add noise.
  const owner = record !== null && isUsableAddress(record.owner) ? record.owner : null;
  const signer = record !== null && isUsableAddress(record.signer) ? record.signer : null;
  if (record !== null && owner === null) {
    // The preview account is the zero address; a plan bound to it would
    // deliver every buy to nobody.
    push("SCHEDULE_MISMATCH", "the plan's record names no owner to deliver to", {
      owner: String(record.owner),
    });
  }
  if (record !== null && signer === null) {
    push("SCHEDULE_MISMATCH", "the plan's record names no signer", { signer: String(record.signer) });
  }

  // The plan's `signer` is what the user chose and was shown: their wallet
  // asking each time. The record must agree, or buys would be signed by
  // something other than what the plan says signs them. That includes a
  // record written for an autopilot plan before config version 8, which
  // names the plan's spending wallet: the migration made the plan a wallet
  // plan, and nothing in this tab signs with a spending wallet any more, so
  // its buys are refused here until the record is bound to its owner.
  if (plan.signer === "vault") {
    // Its vault makes its buys on chain, with its own floor and budget, and
    // nothing in this tab may buy for it as well: that would be every buy
    // twice, the second out of the owner's wallet. The plan is also always
    // paused, which refuses it above; this says why.
    push("SCHEDULE_MISMATCH", "a vault plan's buys are made by its vault, never by this tab", {
      planId: String(plan.id),
    });
  } else if (plan.signer !== "wallet") {
    // `autopilot` among them: the schema no longer admits it, and this does
    // not rely on the schema having run.
    push("SCHEDULE_MISMATCH", `the plan's signing mode "${String(plan.signer)}" is not one spDEX knows`);
  } else if (owner !== null && signer !== null && !sameAddress(owner, signer)) {
    push("SCHEDULE_MISMATCH", "the plan asks the owner's wallet to sign, but the record names another signer", {
      owner,
      signer,
    });
  }

  let total = 0n;
  let totalKnown = true;
  for (const [index, intent] of intents.entries()) {
    if (!sameAddress(intent.tokenIn, plan.sell)) {
      push("SCHEDULE_MISMATCH", `leg ${index} sells ${intent.tokenIn}, not the plan's ${plan.sell}`, {
        ...legDetail(index),
        expected: String(plan.sell),
        actual: intent.tokenIn,
      });
    }
    if (!sameAddress(intent.tokenOut, plan.buy)) {
      push("SCHEDULE_MISMATCH", `leg ${index} buys ${intent.tokenOut}, not the plan's ${plan.buy}`, {
        ...legDetail(index),
        expected: String(plan.buy),
        actual: intent.tokenOut,
      });
    }
    if (intent.chainId !== plan.chainId) {
      push("SCHEDULE_MISMATCH", `leg ${index} is for chain ${intent.chainId}, the plan for ${plan.chainId}`, {
        ...legDetail(index),
        expected: String(plan.chainId),
        actual: String(intent.chainId),
      });
    }
    if (signer !== null && !sameAddress(intent.account, signer)) {
      push("SCHEDULE_MISMATCH", `leg ${index} is signed by ${intent.account}, not the plan's signer`, {
        ...legDetail(index),
        expected: signer,
        actual: intent.account,
      });
    }
    // Stricter than a manual swap on purpose. A person may send a swap's output
    // to their cold wallet; a plan may not, because a plan that can deliver
    // anywhere but the owner is a plan an edited config can point at anyone.
    if (owner !== null && !sameAddress(intent.recipient, owner)) {
      push("SCHEDULE_MISMATCH", `leg ${index} delivers to ${intent.recipient}, not the plan's owner`, {
        ...legDetail(index),
        expected: owner,
        actual: intent.recipient,
      });
    }
    // Nobody is watching the price when a scheduled buy runs, so a leg with no
    // floor would accept any price at all.
    if (typeof intent.minAmountOut !== "bigint" || intent.minAmountOut <= 0n) {
      push("SCHEDULE_MISMATCH", `leg ${index} has no price floor`, {
        ...legDetail(index),
        minAmountOut: String(intent.minAmountOut),
      });
    }
    if (typeof intent.maxAmountIn !== "bigint" || intent.maxAmountIn <= 0n) {
      push("SCHEDULE_MISMATCH", `leg ${index} has no spending limit above zero`, {
        ...legDetail(index),
        maxAmountIn: String(intent.maxAmountIn),
      });
      // A negative leg would otherwise shrink the sum and let another leg
      // through oversized. This one is already refused; the sum below counts
      // only what could actually leave.
      if (typeof intent.maxAmountIn !== "bigint") totalKnown = false;
    } else {
      total += intent.maxAmountIn;
    }
  }

  // ── One buy's worth ──

  // `maxAmountIn` is the most each leg may take, so the sum is the most the
  // buy may take, whatever the route turns out to use.
  const perBuy = BaseUnitsSchema.safeParse(plan.amountPerBuy).success
    ? BigInt(plan.amountPerBuy)
    : null;
  if (perBuy === null) {
    // An unknown limit allows nothing, rather than anything.
    push("SCHEDULE_EXCEEDS_BUY", "the plan's amount per buy is not a whole number, so no buy fits in it", {
      amountPerBuy: String(plan.amountPerBuy),
    });
  } else if (!totalKnown || total > perBuy) {
    push(
      "SCHEDULE_EXCEEDS_BUY",
      `the buy may spend ${totalKnown ? total : "an unknown amount"}, more than the plan's ${perBuy} per buy`,
      { spend: totalKnown ? total.toString() : "unknown", amountPerBuy: perBuy.toString() },
    );
  }

  // ── The budget ──

  const maxBuysValid =
    Number.isSafeInteger(plan.maxBuys) && plan.maxBuys >= 1 && plan.maxBuys <= MAX_DCA_BUYS;
  if (problem !== null) {
    push("SCHEDULE_EXCEEDS_BUDGET", problem, { planId: String(plan.id) });
  } else if (!maxBuysValid) {
    // Every plan ends. One whose length is outside the bound has a budget
    // nobody agreed to, so none of it is spendable.
    push("SCHEDULE_EXCEEDS_BUDGET", `the plan asks for ${String(plan.maxBuys)} buys, outside 1–${MAX_DCA_BUYS}`, {
      maxBuys: String(plan.maxBuys),
    });
  } else if (record !== null) {
    if (record.buysDone >= plan.maxBuys) {
      push("SCHEDULE_EXCEEDS_BUDGET", `the plan has finished: ${record.buysDone} of ${plan.maxBuys} buys done`, {
        buysDone: String(record.buysDone),
        maxBuys: String(plan.maxBuys),
      });
    }
    // Checked against what has been *committed* — every claimed buy at its
    // full `maxAmountIn` — rather than what was measured afterwards, so a buy
    // still in flight counts against the budget before it settles.
    if (perBuy !== null && totalKnown) {
      const budget = planBudget({ amountPerBuy: plan.amountPerBuy, maxBuys: plan.maxBuys });
      if (record.committed + total > budget) {
        push(
          "SCHEDULE_EXCEEDS_BUDGET",
          `the buy would take the plan to ${record.committed + total}, past its budget of ${budget}`,
          {
            committed: record.committed.toString(),
            spend: total.toString(),
            budget: budget.toString(),
          },
        );
      }
    }
  }

  // ── The clock ──

  const intervalValid =
    Number.isSafeInteger(plan.intervalSeconds) && plan.intervalSeconds >= MIN_DCA_INTERVAL_SECONDS;
  if (!intervalValid) {
    // A constant, not a setting. A config asking for a buy every second —
    // through a bug, a bad import, or a hostile shared link — is refused here
    // rather than honoured, whatever the schema was or was not asked.
    push(
      "SCHEDULE_NOT_DUE",
      `the plan's interval of ${String(plan.intervalSeconds)}s is below the ${MIN_DCA_INTERVAL_SECONDS}s floor`,
      { intervalSeconds: String(plan.intervalSeconds), floor: String(MIN_DCA_INTERVAL_SECONDS) },
    );
  }
  if (!isCount(plan.startAt)) {
    push("SCHEDULE_NOT_DUE", "the plan has no valid start time", { startAt: String(plan.startAt) });
  }
  if (!isCount(slot)) {
    push("SCHEDULE_NOT_DUE", `window ${String(slot)} is not a window`, { slot: String(slot) });
  }

  if (intervalValid && isCount(plan.startAt) && isCount(slot)) {
    const current = slotAt(plan, nowSeconds);
    if (current === null) {
      push("SCHEDULE_NOT_DUE", `the plan's first window opens at ${plan.startAt}`, {
        startAt: String(plan.startAt),
        now: nowSeconds.toString(),
      });
    } else if (slot !== current) {
      // Only the window open now. An earlier one was missed and stays missed —
      // making it up later is the catch-up burst the plan promises never to
      // do — and a later one has not opened.
      push("SCHEDULE_NOT_DUE", `the buy is for window ${slot}, but window ${current} is open`, {
        slot: String(slot),
        current: String(current),
        opensAt: slotOpensAt(plan, current).toString(),
      });
    }
  }

  if (record !== null && record.lastSlot !== null && isCount(slot) && slot <= record.lastSlot) {
    // Two tabs, a re-render, a retry after a timeout: every one of them asks
    // for the same window twice. Only the first claim counts.
    push("SCHEDULE_NOT_DUE", `window ${slot} already had its buy`, {
      slot: String(slot),
      lastSlot: String(record.lastSlot),
    });
  }

  return violations;
}

/**
 * Why a record of past spending cannot be used for this plan, or null if it can.
 *
 * Unknown reads as exhausted: this is the one place where a missing number
 * would otherwise quietly become zero, and zero committed is a full budget.
 */
function recordProblem(plan: DcaPlan, progress: DcaProgress | null): string | null {
  if (progress === null) {
    return "there is no record of what this plan has spent, so it is treated as spent rather than as new";
  }
  if (progress.planId !== plan.id) {
    return `the record is for plan "${progress.planId}", not "${plan.id}"`;
  }
  if (progress.chainId !== plan.chainId) {
    return `the record is for chain ${progress.chainId}, the plan for ${plan.chainId}`;
  }
  if (
    !isCount(progress.buysDone) ||
    typeof progress.committed !== "bigint" ||
    progress.committed < 0n ||
    !(progress.lastSlot === null || isCount(progress.lastSlot))
  ) {
    return "the record of what this plan has spent is unreadable";
  }
  return null;
}

/**
 * Check a scheduled buy: the plan first, then every leg as a swap.
 *
 * `rejected` unless every schedule check passes *and* every leg is
 * `verified`. Warnings from the legs — an oracle divergence, say — pass
 * through as warnings and never change the level; what the host does with a
 * signable buy that carries one (hold it for the owner rather than sign it
 * unattended) is host policy, because the oracle may never refuse a plan.
 */
export class ScheduledBuyGuard {
  constructor(private readonly guard: Guard) {}

  async check(input: ScheduledBuyInput): Promise<GuardVerdict> {
    const mandate = runScheduleChecks({
      plan: input.plan,
      progress: input.progress,
      slot: input.slot,
      intents: input.legs.map((leg) => leg.plan.intent),
      chainId: input.chainId,
      nowSeconds: input.nowSeconds,
    });

    // A buy outside the plan is refused before any of it reaches the RPC. The
    // same reasoning as the swap Guard's static layer: simulating it would tell
    // the endpoint what the user is about to buy, for nothing.
    if (mandate.length > 0) return rejected(mandate);

    const tagged = input.legs.length > 1;
    const tag = (violation: GuardViolation, index: number): GuardViolation =>
      tagged ? { ...violation, detail: { ...violation.detail, leg: String(index) } } : violation;

    const violations: GuardViolation[] = [];
    const warnings: GuardViolation[] = [];
    const unchecked: { index: number; reason: GuardViolation | undefined; secondOpinion: GuardViolation | undefined }[] = [];

    for (const [index, leg] of input.legs.entries()) {
      // One clock for the whole decision. The host stamps each leg as it
      // builds it, a moment apart, and a deadline judged at one instant while
      // the window is judged at another is two decisions, not one.
      const verdict = await this.guard.check({ ...leg, nowSeconds: input.nowSeconds });

      if (verdict.level === "verified" && verdict.signable) {
        warnings.push(...verdict.warnings.map((w) => tag(w, index)));
      } else if (verdict.level === "unverified") {
        unchecked.push({
          index,
          reason: verdict.warnings.find((w) => w.code === "SIMULATION_UNAVAILABLE"),
          // Checked on the main service only, because the second one the
          // user set didn't answer: an auto-buy is only made when both agree.
          secondOpinion: verdict.warnings.find((w) => w.code === "SECOND_OPINION_UNAVAILABLE"),
        });
      } else {
        violations.push(...verdict.violations.map((v) => tag(v, index)));
        // A rejection with nothing in it would be a Guard bug. It still must
        // not read as a pass, so it gets a violation of its own.
        if (verdict.violations.length === 0) {
          violations.push(
            tag({ code: "SIMULATION_UNAVAILABLE", message: "the swap check refused this leg without naming why" }, index),
          );
        }
      }
    }

    if (unchecked.length > 0) {
      const first = unchecked.find((u) => u.reason !== undefined)?.reason;
      const secondOpinion = unchecked.find((u) => u.secondOpinion !== undefined)?.secondOpinion;
      const detail = {
        ...(tagged ? { legs: unchecked.map((u) => String(u.index)).join(",") } : {}),
        ...first?.detail,
      };
      violations.push({
        code: "SIMULATION_UNAVAILABLE",
        // `unverified` is signable for a manual swap because a person reads the
        // banner that says so. Nobody reads it here, and without simulation
        // nothing shows where the output lands or what else leaves.
        message:
          first === undefined && secondOpinion !== undefined
            ? `a scheduled buy is never signed on one service's test-run alone: ${secondOpinion.message}`
            : "a scheduled buy is never signed unchecked, and this endpoint could not simulate it" + (first ? `: ${first.message}` : ""),
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      });
      // Said as well, by its own code, so the plan's history can say the
      // second service didn't answer rather than that the main one can't
      // test-run.
      if (secondOpinion !== undefined) {
        violations.push(tagged ? tag(secondOpinion, unchecked.find((u) => u.secondOpinion !== undefined)!.index) : secondOpinion);
      }
    }

    return violations.length > 0 ? rejected(violations) : verified(warnings);
  }
}
