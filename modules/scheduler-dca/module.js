/*
 * scheduler-dca — when each auto-buy is due, and how large it is.
 *
 * The whole module is arithmetic on three things the host hands it: the plans
 * the user wrote, a summary of what each has bought so far, and the time. It
 * has no clock (the sandbox deletes `Date`), reads nothing (its manifest
 * declares no capabilities and no contracts), and keeps nothing between calls
 * (each call runs in a fresh VM). So the same request always gets the same
 * bytes back, in either runtime — which is what lets the host, the Guard and
 * anyone reviewing a buy check this module's answer against the same inputs.
 *
 * ## Windows
 *
 * A plan divides time into windows of `intervalSeconds`, starting at
 * `startAt`. Window n opens at `startAt + n * intervalSeconds`. A plan buys at
 * most once per window, `amountPerBuy` each time, `maxBuys` times in all.
 *
 * ## Only the window open now
 *
 * If windows 2 and 3 passed while no tab was open, the answer in window 4 is
 * one buy, for window 4. Never three. Making missed buys up in a burst would
 * defeat the averaging the user asked for — three buys at one moment's price —
 * and a catch-up burst is exactly what someone able to delay the app would
 * want to provoke. The host refuses a bunched answer anyway
 * (`vetScheduleDecision`); this module simply never gives one.
 *
 * ## What this module is not trusted with
 *
 * Everything that matters is checked again downstream: the host vets the
 * answer against the plans, and the Guard checks each buy against the plan
 * when it is signed — pair, size, budget, one per window, delivery to the
 * owner. A wrong answer from here can skip a buy or shrink one. It cannot make
 * the app spend more, more often, or anywhere else. That is also why a smarter
 * strategy (buy less after a run-up, say) could replace this file without
 * being trusted with the envelope.
 *
 * ## Malformed input is refused, not guessed at
 *
 * The host builds the request from a validated config, so a malformed one is
 * a host bug. Two progress records for one plan, or a time that is not a
 * whole number, have no right answer, and guessing one would hide the bug
 * behind a plausible-looking buy. The module throws instead, which fails the
 * whole call loudly.
 */

/** A whole, non-negative decimal string as a BigInt, or a thrown error naming the field. */
function uint(value, what) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(what + " must be a whole number of seconds or base units, as a decimal string");
  }
  return BigInt(value);
}

function count(value, what) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(what + " must be a non-negative whole number");
  }
  return value;
}

/** Code-unit order: the same in every runtime and every locale, unlike localeCompare. */
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Progress by plan id. A plan with no record has bought nothing yet. */
function indexProgress(progress) {
  const byPlan = new Map();
  for (const record of progress) {
    if (byPlan.has(record.planId)) {
      throw new Error("two progress records for plan " + record.planId);
    }
    byPlan.set(record.planId, {
      buysDone: count(record.buysDone, "buysDone"),
      lastSlot: record.lastSlot === null ? null : count(record.lastSlot, "lastSlot"),
    });
  }
  return byPlan;
}

/**
 * One plan's answer: the buy due now, if any, and when the next could be.
 *
 * `next` is the opening of the first window that could still have a buy —
 * the countdown the app shows — or null once the plan has made its last one.
 */
function decide(plan, done, now) {
  const start = uint(plan.startAt, "startAt");
  const interval = uint(plan.intervalSeconds, "intervalSeconds");
  if (interval === 0n) throw new Error("intervalSeconds must be positive");
  const maxBuys = count(plan.maxBuys, "maxBuys");
  const amount = uint(plan.amountPerBuy, "amountPerBuy");
  if (amount === 0n) throw new Error("amountPerBuy must be positive");

  const left = maxBuys - done.buysDone;
  if (left <= 0) return { buy: null, next: null };

  // The first window without a buy claimed in it. Normally the one after the
  // last buy; it only runs ahead of the clock if the clock went backwards.
  const firstUnused = done.lastSlot === null ? 0n : BigInt(done.lastSlot) + 1n;
  const opensAt = (slot) => (start + slot * interval).toString();

  if (now < start) return { buy: null, next: opensAt(firstUnused) };

  const slot = (now - start) / interval;
  if (slot < firstUnused) return { buy: null, next: opensAt(firstUnused) };

  return {
    buy: { planId: plan.id, slot: Number(slot), amountIn: amount.toString() },
    next: left > 1 ? opensAt(slot + 1n) : null,
  };
}

const spdexModule = {
  apiVersion: "1.0.0",

  /**
   * Which buys are due now, and when each plan's next one could be.
   *
   * Plans are answered in id order, whatever order they arrive in, so two
   * hosts listing the same plans differently get byte-identical answers.
   */
  async dueBuys(request) {
    const now = uint(request.now, "now");
    const progress = indexProgress(request.progress);
    const plans = request.plans.slice().sort(byId);

    const due = [];
    const next = [];
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      if (i > 0 && plans[i - 1].id === plan.id) throw new Error("two plans share the id " + plan.id);
      const answer = decide(plan, progress.get(plan.id) || { buysDone: 0, lastSlot: null }, now);
      if (answer.buy !== null) due.push(answer.buy);
      next.push({ planId: plan.id, at: answer.next });
    }
    return { due, next };
  },
};

globalThis.spdexModule = spdexModule;
