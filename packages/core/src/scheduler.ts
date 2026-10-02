/**
 * Scheduler modules — deciding *when* a recurring buy is due.
 *
 * The fourth module kind, and the smallest in reach. A scheduler declares no
 * capabilities and no contracts: it is given the plans, what has already been
 * bought, and the time — by the host, since modules have no clock — and it
 * answers which buys are due now and how large each should be. Identical
 * inputs give byte-identical output, which the parity and conformance suites
 * check the same way they check a venue.
 *
 * ## Proposing, not deciding
 *
 * A scheduler is to *when* what a venue is to *how*: it proposes, and the host
 * performs. Whatever it answers, a buy is then quoted by the host, checked by
 * the Guard against the plan the user wrote — pair, per-buy amount, total
 * budget, one buy per window, delivery to the owner — and signed only if every
 * check passes. A scheduler that lies can make the app skip a buy or ask for a
 * smaller one. It cannot make it spend more, more often, or anywhere else.
 *
 * That split is what leaves room for strategies other than a fixed amount on a
 * fixed beat — buying less when the price has run up, say — without any of
 * them being trusted with the envelope.
 */

import { z } from "zod";
import { slotAt, type DcaPlan, type DcaProgress } from "./dca.js";

/** Decimal, unsigned. bigint does not survive the sandbox boundary. */
const AmountSchema = z.string().regex(/^\d+$/, "decimal string");
const AddressLikeSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const PlanIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/** A plan as a scheduler sees it: the arithmetic, and nothing about who owns it. */
export const WireSchedulePlanSchema = z.object({
  id: PlanIdSchema,
  sell: AddressLikeSchema,
  buy: AddressLikeSchema,
  amountPerBuy: AmountSchema,
  intervalSeconds: AmountSchema,
  startAt: AmountSchema,
  maxBuys: z.number().int().positive(),
});
export type WireSchedulePlan = z.infer<typeof WireSchedulePlanSchema>;

/**
 * What has happened so far, summarised rather than listed.
 *
 * A summary stays the same size however many months a plan has run, which
 * matters because the sandbox re-embeds its arguments as JSON every round.
 */
export const WirePlanProgressSchema = z.object({
  planId: PlanIdSchema,
  buysDone: z.number().int().nonnegative(),
  lastSlot: z.number().int().nonnegative().nullable(),
});
export type WirePlanProgress = z.infer<typeof WirePlanProgressSchema>;

export const WireScheduleRequestSchema = z.object({
  /** Unix seconds, from the host's clock. */
  now: AmountSchema,
  plans: z.array(WireSchedulePlanSchema),
  progress: z.array(WirePlanProgressSchema),
});
export type WireScheduleRequest = z.infer<typeof WireScheduleRequestSchema>;

export const WireDueBuySchema = z.object({
  planId: PlanIdSchema,
  /** The window this buy is for. Only the current one is ever acceptable. */
  slot: z.number().int().nonnegative(),
  amountIn: AmountSchema,
});
export type WireDueBuy = z.infer<typeof WireDueBuySchema>;

export const WirePlanNextSchema = z.object({
  planId: PlanIdSchema,
  /** When the next buy could happen, or null when the plan has finished. */
  at: AmountSchema.nullable(),
});
export type WirePlanNext = z.infer<typeof WirePlanNextSchema>;

export const WireScheduleDecisionSchema = z.object({
  due: z.array(WireDueBuySchema),
  next: z.array(WirePlanNextSchema),
});
export type WireScheduleDecision = z.infer<typeof WireScheduleDecisionSchema>;

/** The scheduler interface: one method, batch-shaped like every other kind. */
export interface SchedulerModule {
  readonly apiVersion: string;
  dueBuys(request: unknown, ctx: unknown): Promise<WireScheduleDecision>;
}

/** Build what a scheduler is asked, from the config's plans and this browser's progress. */
export function scheduleRequest(
  plans: readonly DcaPlan[],
  progress: readonly Pick<DcaProgress, "planId" | "buysDone" | "lastSlot">[],
  nowSeconds: bigint,
): WireScheduleRequest {
  return {
    now: nowSeconds.toString(),
    plans: plans.map((plan) => ({
      id: plan.id,
      sell: plan.sell,
      buy: plan.buy,
      amountPerBuy: plan.amountPerBuy,
      intervalSeconds: String(plan.intervalSeconds),
      startAt: String(plan.startAt),
      maxBuys: plan.maxBuys,
    })),
    progress: progress.map((p) => ({ planId: p.planId, buysDone: p.buysDone, lastSlot: p.lastSlot })),
  };
}

/** A proposed buy the host will not act on, and why. */
export interface RefusedDueBuy {
  buy: WireDueBuy;
  reason: string;
}

/**
 * Sort a scheduler's answer into what the host may act on and what it refuses.
 *
 * The cheap envelope, applied before anything is quoted: the plan exists, it
 * is one buy per plan per answer, the buy is for the window open right now and
 * one not already used, it is no larger than the plan's per-buy amount, and
 * the plan has buys left. The Guard checks the same envelope again against the
 * plans themselves when the buy is signed — it does not assume this ran.
 */
export function vetScheduleDecision(
  request: WireScheduleRequest,
  decision: WireScheduleDecision,
): { accepted: WireDueBuy[]; refused: RefusedDueBuy[] } {
  const plans = new Map(request.plans.map((plan) => [plan.id, plan]));
  const progress = new Map(request.progress.map((p) => [p.planId, p]));
  const now = BigInt(request.now);
  const seen = new Set<string>();
  const accepted: WireDueBuy[] = [];
  const refused: RefusedDueBuy[] = [];

  for (const buy of decision.due) {
    const refuse = (reason: string) => refused.push({ buy, reason });
    const plan = plans.get(buy.planId);
    if (!plan) {
      refuse("no such plan");
      continue;
    }
    if (seen.has(buy.planId)) {
      refuse("more than one buy for a plan in one answer");
      continue;
    }
    seen.add(buy.planId);

    const current = slotAt(
      { startAt: Number(plan.startAt), intervalSeconds: Number(plan.intervalSeconds) },
      now,
    );
    const done = progress.get(buy.planId);
    if (current === null || buy.slot !== current) {
      refuse("not for the window open now");
      continue;
    }
    if (done && done.lastSlot !== null && buy.slot <= done.lastSlot) {
      refuse("that window already had its buy");
      continue;
    }
    if (done && done.buysDone >= plan.maxBuys) {
      refuse("the plan has no buys left");
      continue;
    }
    const amount = BigInt(buy.amountIn);
    if (amount === 0n || amount > BigInt(plan.amountPerBuy)) {
      refuse("larger than one buy, or empty");
      continue;
    }
    accepted.push(buy);
  }

  return { accepted, refused };
}
