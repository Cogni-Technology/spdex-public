/**
 * The terms, in plain words, before a plan starts spending again. Inline
 * under the card's actions, not a dialog: nothing here may open by itself,
 * and the card it is about stays in view.
 *
 * A plan this browser has no record of — shared by link, imported from a file,
 * or started on another computer — gets a warning first: it counts from zero
 * here, it spends from whichever wallet is connected now, and if it also runs
 * somewhere else, both places will buy.
 *
 * A plan that was an autopilot plan (config version 8 made it a paused
 * wallet plan) says what changes: it bought on its own from money already in
 * its spending wallet, and from here on the owner's wallet asks and pays.
 */

import { Banner, Button } from "@spdex/ui";
import type { DcaPlan } from "@spdex/core";
import type { DcaLedgerEntry } from "../../lib/dca/ledger.js";
import type { AutoBuy, AutoBuyDeps } from "../../lib/dca/useAutoBuy.js";
import { resumeTerms } from "../../lib/dca/view.js";

export function ResumeTerms({
  plan,
  entry,
  autoBuy,
  deps,
  notStartedHere,
  onClose,
}: {
  plan: DcaPlan;
  entry: DcaLedgerEntry | null;
  autoBuy: AutoBuy;
  deps: AutoBuyDeps;
  notStartedHere: boolean;
  onClose: () => void;
}) {
  const foreign = entry === null;
  const account = deps.account;
  const owner = entry?.owner ?? account;
  const lines = resumeTerms({
    plan,
    entry,
    owner,
    expert: deps.mode === "expert",
    nowMs: autoBuy.now,
  });
  const busy = autoBuy.activity[plan.id]?.busy ?? null;
  const othersRunning = deps.config.dca.plans.some((p) => p.id !== plan.id && !p.paused);
  const wasAutopilot = entry !== null && entry.signer !== entry.owner;

  return (
    <div className="spdex-dca-inline" data-testid="dca-resume-terms">
      <h4 className="spdex-dca-inline__title">{notStartedHere ? "Start this plan here?" : "Resume this plan?"}</h4>
      {foreign ? (
        <Banner tone="warn" title="This plan came from outside this browser" testId="dca-resume-foreign">
          <p className="spdex-dca-line">
            {notStartedHere
              ? "It was started somewhere else, or arrived from a link or a file. Check every line: starting it here spends from the wallet connected now."
              : "It arrived paused from a link or a file. Check every line: resuming spends from the wallet connected now."}
          </p>
          <p className="spdex-dca-line">
            This browser has no record of earlier buys, so it counts from zero. If this plan also runs on another
            computer, both will buy.
          </p>
        </Banner>
      ) : null}
      {wasAutopilot ? (
        <p className="spdex-dca-line" data-testid="dca-resume-was-autopilot">
          This plan used to buy on its own, with money already in its spending wallet. From now on your wallet asks you to
          confirm each buy, and pays for it.
        </p>
      ) : null}
      <p className="spdex-dca-line">{lines.terms}</p>
      <p className="spdex-dca-line">{lines.limit}</p>
      <p className="spdex-dca-line">{lines.next}</p>
      {entry?.halted !== undefined ? (
        <p className="spdex-dca-line">It stopped itself after buys failed; resuming starts counting failures from zero.</p>
      ) : null}
      {!deps.config.dca.enabled ? (
        <p className="spdex-dca-line">
          This also switches Auto-buy back on.
          {othersRunning ? " Your other plans stay paused until you resume each one." : ""}
        </p>
      ) : null}
      <div className="spdex-dca-actions">
        <Button
          testId="dca-resume-confirm"
          disabled={busy !== null || (foreign && account === null)}
          onClick={async () => {
            await autoBuy.resumePlan(plan.id);
            onClose();
          }}
        >
          {notStartedHere ? "Start here" : "Resume"}
        </Button>
        <Button variant="ghost" testId="dca-resume-cancel" onClick={onClose}>
          {notStartedHere ? "Not now" : "Keep paused"}
        </Button>
      </div>
      {foreign && account === null ? <p className="spdex-dca-hint">Connect your wallet first (see above).</p> : null}
    </div>
  );
}
