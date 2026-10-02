/**
 * One plan you confirm: what it does, how far it has got, what happens next,
 * and the few things that can be done about it. (A vault plan has its own
 * card, VaultCard.tsx.)
 *
 * The card never decides anything. Its pill and its one reason line come from
 * `cardStatus` (lib/dca/view.ts), which checks the plan's states in a fixed
 * order, and its buttons call the hook, which calls the runner. Conditions
 * that affect every plan at once (Auto-buy off, no safety test, wallet
 * disconnected, another tab leading) are said once on the panel, not repeated
 * here.
 *
 * Every id inside is fixed and card-scoped: tests reach them through the
 * card, `dca-plan-{id}`, so two cards never collide.
 */

import { useState } from "react";
import { Banner, Button, Disclosure, Pill, Progress, Row, Stat, Term } from "@spdex/ui";
import { slotAt, type DcaPlan } from "@spdex/core";
import { TOKENS, isNativeToken } from "@spdex/chain";
import { MAX_SCHEDULED_SLIPPAGE_BPS } from "../../lib/engine.js";
import { bpsAsPercent } from "../../lib/errors.js";
import { tokenLabel } from "../../lib/dca/format.js";
import type { DcaLedgerEntry } from "../../lib/dca/ledger.js";
import { consentFor, type AutoBuy, type AutoBuyDeps } from "../../lib/dca/useAutoBuy.js";
import {
  averageStat,
  boughtStat,
  buyingStep,
  cardTitle,
  compactDuration,
  lastOutcome,
  nextBuyStat,
  progressFigures,
  termsLine,
  weekdayClock,
  type CardStatus,
} from "../../lib/dca/view.js";
import { GLOSSARY } from "../../lib/names.js";
import { networkLabel } from "../../lib/networks.js";
import { calendarForm, tooOftenHint } from "../../lib/reminders/ics.js";
import { localClock, stepText } from "../../lib/steps.js";
import { CalendarPanel, NoticeBanner } from "./common.js";
import { History } from "./History.js";
import { ResumeTerms } from "./ResumeTerms.js";
import { formatCount } from "../../lib/money/format.js";
import { highFeeNote } from "../../lib/summary.js";
import { walletBuyGasCost } from "./vaultCopy.js";

const FALLBACK: CardStatus = { row: "running", pill: "running", reason: null };

/** "14:05" today, "Tue 14:05" on another day: when a buy time ends. */
function endClock(unixSeconds: number, nowMs: number): string {
  const end = new Date(unixSeconds * 1000);
  return end.toDateString() === new Date(nowMs).toDateString() ? localClock(unixSeconds) : weekdayClock(unixSeconds);
}

export function PlanCard({ plan, autoBuy, deps }: { plan: DcaPlan; autoBuy: AutoBuy; deps: AutoBuyDeps }) {
  const expert = deps.mode === "expert";
  const read = autoBuy.entryFor(plan);
  const entry: DcaLedgerEntry | null = read === "unavailable" ? null : read;
  const state = autoBuy.stateFor(plan.id);
  const status = autoBuy.statusFor(plan.id) ?? FALLBACK;
  // A plan migrated from autopilot (config version 8) whose record still
  // names its old spending wallet: it is bound to its owner when resumed.
  const wasAutopilot = entry !== null && entry.signer !== entry.owner;
  const activity = autoBuy.activity[plan.id];
  const busy = activity?.busy ?? null;
  const [panel, setPanel] = useState<"none" | "resume" | "delete" | "calendar">("none");
  const [pressing, setPressing] = useState(false);

  const press = async (action: () => Promise<void>) => {
    setPressing(true);
    try {
      await action();
    } finally {
      setPressing(false);
    }
  };

  // The one reason line: an action under way, then a buy's live step, then
  // the row's reason, then what the plan did last.
  const step = buyingStep(state, plan, entry);
  let line: string;
  if (busy !== null) line = busy;
  else if (step !== null) line = stepText(step);
  else if (status.row === "due" && status.due) line = `Buy ${status.due.buyNumber} is due.`;
  else if (status.reason !== null) line = status.reason;
  else line = lastOutcome(entry, plan, autoBuy.now);
  // "Buy 2 is due." directly above a banner titled "Buy 2 is due" said the
  // same thing twice in a row. The line stays for screen readers, as the
  // card's live region, and is hidden from sight while the banner says it.
  const echoesBanner = busy === null && step === null && status.row === "due" && status.due !== undefined;

  const progress = progressFigures(plan, read === "unavailable" ? null : entry);
  const next = nextBuyStat(status, state, autoBuy.now);
  const bought = boughtStat(plan, entry);
  const average = averageStat(plan, entry);

  // One button per action, in one place: which ones this row has. An
  // unreadable record can be paused too — it may only be unreadable for a
  // moment, and "Set up again" beside a plan that could come back and buy
  // would make two plans buy.
  const canPause = !plan.paused && ["unreadable", "no-safety", "due", "attention", "running", "buying"].includes(status.row);
  const canResume = status.row === "paused" || status.row === "halted" || status.row === "not-started";
  const canDelete = status.row !== "buying";
  // Reminders for a plan that is running here and has buys to make: one
  // paused or not started here has no buy times anyone should be called to.
  const buysLeft = plan.maxBuys - (entry?.buysDone ?? 0);
  const reminders = !plan.paused && entry !== null && buysLeft > 0 ? calendarForm(plan, buysLeft) : null;
  const canRemind = reminders !== null && reminders.kind !== "none";

  return (
    <div
      className={`spdex-plan${status.pill === "attention" ? " spdex-plan--attention" : ""}`}
      data-testid={`dca-plan-${plan.id}`}
    >
      <div className="spdex-plan__head">
        <h3 className="spdex-plan__title">{cardTitle(plan)}</h3>
        <Pill status={status.pill} testId="dca-pill">
          {status.pillLabel}
        </Pill>
      </div>
      <p className="spdex-plan__terms" data-testid="dca-terms">
        {termsLine(plan)}
      </p>
      {wasAutopilot ? (
        <p className="spdex-dca-hint" data-testid="dca-was-autopilot">
          This plan used a spending wallet, which spDEX no longer does. Resume it to confirm each buy yourself.
        </p>
      ) : null}
      <Progress
        value={progress.value}
        max={plan.maxBuys}
        label="Buys made"
        testId="dca-progress"
        {...(progress.valueText === undefined ? {} : { valueText: progress.valueText })}
      />
      <div className="spdex-statgrid">
        <Stat label="Next buy" value={next.value} hint={next.hint} testId="dca-next" />
        <Stat label="Bought" value={bought.value} hint={bought.hint} testId="dca-bought" />
        <Stat label="Average rate" value={average.value} hint={average.hint} testId="dca-avg" />
      </div>
      <p
        className={`spdex-plan__status${echoesBanner ? " spdex-plan__status--echo" : ""}`}
        data-testid="dca-status"
        aria-live="polite"
      >
        {line}
      </p>
      {activity?.notice ? <NoticeBanner notice={activity.notice} onDismiss={() => autoBuy.clearNotice(plan.id)} /> : null}

      {status.due ? (
        <DueBanner
          plan={plan}
          status={status}
          consent={consentFor(activity, state)}
          autoBuy={autoBuy}
          pressing={pressing || busy !== null}
          onConfirm={() => press(() => autoBuy.confirmDue(plan.id))}
          onSkip={() => press(() => autoBuy.skipDue(plan.id))}
        />
      ) : null}

      <div className="spdex-dca-actions">
        {status.row === "unreadable" ? (
          <Button testId="dca-recreate" onClick={() => autoBuy.recreate(plan.id)}>
            Set up again
          </Button>
        ) : null}
        {canPause ? (
          <Button variant="ghost" testId="dca-pause" disabled={busy !== null} onClick={() => autoBuy.pause(plan.id)}>
            Pause
          </Button>
        ) : null}
        {canResume ? (
          <Button testId="dca-resume" disabled={busy !== null} onClick={() => setPanel(panel === "resume" ? "none" : "resume")}>
            {status.row === "not-started" ? "Start here" : "Resume"}
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="ghost"
            testId="dca-delete"
            disabled={busy !== null}
            onClick={() => setPanel(panel === "delete" ? "none" : "delete")}
          >
            Delete
          </Button>
        ) : null}
        {canRemind ? (
          <Button
            variant="ghost"
            testId="dca-calendar"
            expanded={panel === "calendar"}
            onClick={() => setPanel(panel === "calendar" ? "none" : "calendar")}
          >
            Add to calendar
          </Button>
        ) : null}
      </div>
      {status.row === "buying" ? <p className="spdex-dca-hint">Pausing takes effect after this buy.</p> : null}
      {reminders?.kind === "none" && reminders.why === "too-often" ? (
        <p className="spdex-dca-hint" data-testid="dca-calendar-hint">
          {tooOftenHint(plan)}
        </p>
      ) : null}

      {panel === "resume" && canResume ? (
        <ResumeTerms
          plan={plan}
          entry={entry}
          autoBuy={autoBuy}
          deps={deps}
          notStartedHere={status.row === "not-started"}
          onClose={() => setPanel("none")}
        />
      ) : null}
      {panel === "delete" && canDelete ? (
        <DeleteConfirm plan={plan} autoBuy={autoBuy} onClose={() => setPanel("none")} />
      ) : null}
      {panel === "calendar" && canRemind ? (
        <CalendarPanel plan={plan} buysLeft={buysLeft} onClose={() => setPanel("none")} />
      ) : null}

      <History plan={plan} entry={entry} expert={expert} rpc={deps.engine?.rpc ?? null} />
      <PlanDetails plan={plan} entry={read} autoBuy={autoBuy} deps={deps} />
    </div>
  );
}

// ── A due buy ─────────────────────────────────────────────────────────────

/**
 * A buy that waits for its owner: the wallet never opens on a timer. The
 * click re-quotes and re-checks, and only then asks.
 *
 * `consent` is a price warning the last press came back with, for this buy
 * time only (`consentFor`); "Buy anyway" accepts that figure and no larger.
 */
function DueBanner({
  plan,
  status,
  consent,
  autoBuy,
  pressing,
  onConfirm,
  onSkip,
}: {
  plan: DcaPlan;
  status: CardStatus;
  consent: number | null;
  autoBuy: AutoBuy;
  pressing: boolean;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const due = status.due!;
  const left = compactDuration(due.endsAt * 1000 - autoBuy.now);
  const waiting = autoBuy.ownerLockBusy && !pressing;
  // Said before the click, as the swap card says it (`highFeeNote`): this
  // buy's typical network fee against what it spends, when that is ether.
  const gas = walletBuyGasCost(autoBuy.fees);
  const sellsEther = isNativeToken(plan.sell) || plan.sell.toLowerCase() === TOKENS.WETH.address.toLowerCase();
  const feeNote =
    gas === null ? null : highFeeNote({ feeWei: gas, swapWei: sellsEther ? BigInt(plan.amountPerBuy) : null, level: autoBuy.feeLevel, of: "buy" });
  return (
    <Banner tone="warn" title={`Buy ${due.buyNumber} is due`} testId="dca-due">
      <p className="spdex-dca-line">
        Confirm it before {endClock(due.endsAt, autoBuy.now)} ({left} left). spDEX gets a fresh price and runs the
        safety check first.
      </p>
      {feeNote === null ? null : (
        <p className="spdex-dca-line spdex-dca-line--warn" data-testid="dca-due-fee-high" role="note">
          {feeNote}
        </p>
      )}
      {consent !== null ? (
        <p className="spdex-dca-line">
          {/* "Away from", not "worse than": the check measures the distance
              either way, and a price better than the average draws it too. */}
          The price is {bpsAsPercent(consent) ?? "far"}% away from the{" "}
          <Term tip={GLOSSARY.tenMinuteAverage}>
            <span className="spdex-dca-nobreak">10-minute</span> average price
          </Term>
          .
        </p>
      ) : null}
      <div className="spdex-dca-actions">
        <Button testId="dca-confirm-buy" disabled={due.blocked || pressing || waiting} onClick={onConfirm}>
          {consent !== null ? "Buy anyway" : "Confirm buy"}
        </Button>
        <Button variant="ghost" testId="dca-skip-buy" disabled={pressing} onClick={onSkip}>
          Skip this buy
        </Button>
      </div>
      {due.blocked ? <p className="spdex-dca-hint">Connect your wallet first (see above).</p> : null}
      {!due.blocked && waiting ? <p className="spdex-dca-hint">Waiting for your swap to finish…</p> : null}
    </Banner>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────

/** Delete, confirmed inline. */
function DeleteConfirm({ plan, autoBuy, onClose }: { plan: DcaPlan; autoBuy: AutoBuy; onClose: () => void }) {
  const busy = autoBuy.activity[plan.id]?.busy ?? null;
  return (
    <div className="spdex-dca-inline">
      <p className="spdex-dca-line">
        Delete "{cardTitle(plan)}"? Nothing more will be bought. What you've bought stays in your wallet.
      </p>
      <div className="spdex-dca-actions">
        <Button testId="dca-delete-confirm" disabled={busy !== null} onClick={() => void autoBuy.deletePlan(plan.id)}>
          Delete plan
        </Button>
        <Button variant="ghost" testId="dca-delete-cancel" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Plan details ──────────────────────────────────────────────────────────

/**
 * Everything the plan is and everything this browser recorded about it, in
 * the raw. Open in Expert. "Window" is Expert's word for a buy time.
 *
 * The Simple view keeps the rows a person can check (network, tokens and
 * their addresses, tolerance, price check, where buys go); base units,
 * seconds, unix times and internal names are the Expert view's.
 */
function PlanDetails({
  plan,
  entry,
  autoBuy,
  deps,
}: {
  plan: DcaPlan;
  entry: DcaLedgerEntry | null | "unavailable";
  autoBuy: AutoBuy;
  deps: AutoBuyDeps;
}) {
  const expert = deps.mode === "expert";
  const priceCheck = autoBuy.priceCheck[plan.id];
  const window = slotAt(plan, BigInt(Math.floor(autoBuy.now / 1000)));
  const tolerance = Math.min(deps.config.slippageBps, MAX_SCHEDULED_SLIPPAGE_BPS) / 100;
  const runtime = deps.config.strictSandbox ? "quickjs" : "native";
  return (
    <Disclosure summary="Plan details" testId="dca-details" open={expert}>
      {expert ? <Row label="Plan id" value={plan.id} /> : null}
      <Row label="Network" value={networkLabel(plan.chainId)} />
      <Row label="Pays with" value={`${tokenLabel(plan.sell)} · ${plan.sell}`} />
      <Row label="Buys" value={`${tokenLabel(plan.buy)} · ${plan.buy}`} />
      {expert ? (
        <>
          <Row label="Amount per buy" value={`${plan.amountPerBuy} (base units)`} />
          <Row label="Interval" value={`${formatCount(plan.intervalSeconds)} s`} />
          <Row label="Max buys" value={formatCount(plan.maxBuys)} />
          <Row
            label="First window"
            value={`${plan.startAt} · ${new Date(plan.startAt * 1000).toLocaleString(undefined, { hourCycle: "h23" })}`}
          />
          <Row label="Signer" value={plan.signer} />
        </>
      ) : null}
      <Row
        label="Price tolerance"
        value={`${tolerance}% (yours, capped at ${MAX_SCHEDULED_SLIPPAGE_BPS / 100}% for auto-buys)`}
      />
      <Row
        label={
          <Term tip="When Uniswap v3 has a 10-minute average price for the pair, a buy far from it waits for you. Not every pair has one; then the safety check and your tolerance are the protection.">
            Price check vs 10-minute average
          </Term>
        }
        testId="dca-price-check"
        value={priceCheck === undefined || priceCheck === "checking" ? "checking…" : priceCheck ? "on" : "not available for this pair right now"}
      />
      {entry === "unavailable" ? (
        <Row label="This browser's record" value="unreadable" />
      ) : entry === null ? (
        <Row label="This browser's record" value="none" />
      ) : (
        <>
          <Row label="Delivers to" value={entry.owner} />
          {expert ? (
            <>
              <Row label="Signing address" value={entry.signer} />
              <Row label="Buys done" value={String(entry.buysDone)} />
              <Row label="Committed" value={`${entry.committed} (base units)`} />
              <Row label="Last window" value={entry.lastSlot === null ? "none" : String(entry.lastSlot)} />
            </>
          ) : null}
        </>
      )}
      {expert ? (
        <>
          <Row label="Current window" value={window === null ? "not open yet" : String(window)} />
          <Row label="Scheduler" value={`scheduler-dca · ${runtime}`} />
        </>
      ) : null}
    </Disclosure>
  );
}
