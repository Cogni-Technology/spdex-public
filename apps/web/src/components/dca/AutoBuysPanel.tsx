/**
 * "Your auto-buys": every plan, and the connected wallet's vaults no plan
 * points at.
 *
 * Conditions that stop many plans at once — Auto-buy switched off, a network
 * service that can't run the safety test, another tab doing the buying, a
 * wallet that is disconnected or on another network — are said once, here,
 * above the cards, each with the one button that fixes it. The cards only
 * reflect them in their pill.
 *
 * "Last checked" is the leading tab's heartbeat: a frozen tab and a working
 * one look identical otherwise, and with no server, a tab that stopped
 * looking is a plan that stopped buying. It is shown only with a plan a tab
 * runs; a vault's buys don't depend on any tab looking.
 *
 * Vault plans are the exception to all of that. A vault buys whenever anyone
 * triggers a due buy, whether or not this tab — or any — is open, and whether
 * or not Auto-buy is switched on here. So the tab-wide banners are about the
 * other plans only, and never tell someone whose plans are all vaults that
 * nothing will be bought.
 *
 * Below the plans, the connected wallet's vaults that no plan points at
 * (`StrayVaults`), found on chain: they hold money and buy, so they bring the
 * panel up even when there is no plan at all.
 *
 * In a tile (`open` defined, the "Auto-buys" tile) it drops its own panel and
 * title, and reports the tile header's summary itself (`autoBuysSummary`): a
 * BUY DUE or NEEDS ATTENTION pill, or the strip's line ("2 running · next in
 * 3h 12m").
 */

import { useEffect, useRef } from "react";
import { Banner, Button, Panel, Term } from "@spdex/ui";
import type { AutoBuy, AutoBuyDeps } from "../../lib/dca/useAutoBuy.js";
import { autoBuysSummary, heartbeatText, otherTabLeads, removalText } from "../../lib/dca/view.js";
import { networkLabel } from "../../lib/networks.js";
import { GoTo } from "../../lib/places.js";
import { useBuyDueNotifications } from "../../lib/reminders/notify.js";
import { localClock } from "../../lib/steps.js";
import { useTiles, type TilePanelProps } from "../../lib/tiles.js";
import { InfoTerm, NotifyWhenDue } from "./common.js";
import { useTileSummary } from "./tilePanel.js";
import { PlanCard } from "./PlanCard.js";
import { StrayVaults } from "./StrayVaults.js";
import { VaultPlanCard } from "./VaultCard.js";
import { VAULT_TIPS } from "./vaultCopy.js";

/**
 * The panel's subtitle: which plans need an open tab, when some don't.
 * `vaults` counts every vault the panel is about — a plan's, one listed apart,
 * one the search knows exists but can't show — so a panel that is there only
 * for vaults found on chain doesn't talk about tabs. A panel with neither is
 * there only for old spending wallets, which buy nothing: it says so.
 */
export function subtitleFor(tabPlans: number, vaults: number): string {
  if (tabPlans === 0 && vaults === 0) return "Nothing here buys. Below: money an older spDEX left in this browser.";
  if (vaults === 0) return "Buys happen only while spDEX is open and awake in a tab.";
  if (tabPlans === 0) return "Vaults buy whenever anyone triggers a due buy, with or without spDEX open.";
  return "Vaults buy when triggered; other plans only while spDEX is open.";
}

/** What running your own keeper takes, behind the one-line offer. */
const OWN_KEEPER_TIP =
  "docs/KEEPER.md in spDEX's source sets one up with Docker. It needs a computer that stays on and ETH for network fees: it pays each buy's network fee and is paid its buy fee. Out of the box it makes only buys whose fee covers that; the guide shows how to have it pay the difference for your own vaults.";

export function AutoBuysPanel({ autoBuy, deps, open, onSummary }: { autoBuy: AutoBuy; deps: AutoBuyDeps } & TilePanelProps) {
  const { config, account, walletChainOk } = deps;
  const plans = config.dca.plans;
  const lease = autoBuy.lease;
  const confirmRef = useRef<HTMLDivElement>(null);
  const { reveal } = useTiles();
  // Mounted wherever there is a plan, which is the only time a buy can fall
  // due, so the page's notifications are fed from here.
  const notifications = useBuyDueNotifications(autoBuy.buyDue);

  // A reset, import or shared link that would remove plans asks here, where
  // the plans are; bring the question to the person who just clicked. Focus
  // goes to Cancel, never to the button that removes (UI rule R2,
  // docs/ARCHITECTURE.md).
  const removing = autoBuy.removal !== null;
  useEffect(() => {
    if (!removing) return;
    const prompt = confirmRef.current;
    const target = prompt?.querySelector<HTMLElement>('[data-testid="dca-remove-plans-cancel"]') ?? prompt;
    if (target) void reveal(target);
  }, [removing, reveal]);

  const running = config.dca.enabled;
  // Plans this tab runs. A vault plan is run by its vault, so nothing below
  // about switches, tabs or the safety test stops it buying.
  const tabPlans = plans.filter((plan) => plan.signer !== "vault");
  const vaultPlans = plans.length - tabPlans.length;
  // Vaults on chain no plan points at buy the way a vault plan's vault does,
  // and so may the ones the search knows exist but couldn't show. A panel up
  // with no plan only because the search failed is about vaults too.
  const strays = autoBuy.strayVaults;
  const strayVaults =
    (strays?.listed.length ?? 0) +
    (strays?.closed.length ?? 0) +
    (strays?.note?.missing ?? 0) +
    (plans.length === 0 && strays?.error != null ? 1 : 0);
  const onThisChain = tabPlans.filter((plan) => plan.chainId === config.chainId);
  const walletPlansActive = running && onThisChain.some((plan) => !plan.paused);
  // A vault plan whose vault doesn't exist yet needs the wallet that creates
  // it; one that exists buys whether or not a wallet is connected here.
  const vaultToCreate = plans.some((plan) => plan.chainId === config.chainId && autoBuy.vaultFor(plan.id)?.kind === "not-created");
  const needsWallet = account === null && (walletPlansActive || vaultToCreate);
  const wrongNetwork = account !== null && !walletChainOk && (walletPlansActive || vaultToCreate);
  const noSafety = tabPlans.length > 0 && (autoBuy.safety === "unavailable" || autoBuy.safety === "unknown");
  // A vault of the person's that still has buys to make.
  const openVault = plans.some((plan) => {
    const state = autoBuy.vaultFor(plan.id);
    return state?.kind === "active" && !state.closed && state.buysLeft > 0;
  });
  const leader = autoBuy.snapshot?.leader ?? null;
  useTileSummary(
    onSummary,
    autoBuysSummary({
      plans: plans.length,
      buyDue: autoBuy.buyDue,
      attention: plans.some((plan) => autoBuy.statusFor(plan.id)?.pill === "attention"),
      stripText: autoBuy.stripText,
      strayVaults,
    }),
  );
  const subtitle = subtitleFor(tabPlans.length, vaultPlans + strayVaults);

  const body = (
    <>
      {tabPlans.length > 0 ? (
        <p className="spdex-dca-heartbeat" data-testid="dca-heartbeat">
          {heartbeatText(lease, autoBuy.now)}
        </p>
      ) : null}
      {tabPlans.length > 0 ? <NotifyWhenDue notifications={notifications} /> : null}

      {autoBuy.removal !== null ? (
        <div ref={confirmRef}>
          <Banner
            tone="warn"
            title={autoBuy.removal.count > 0 ? "Remove auto-buys?" : "Your vault plans stay"}
            testId="dca-remove-plans"
          >
            {autoBuy.removal.count > 0 ? <p className="spdex-dca-line">{removalText(autoBuy.removal.count)}</p> : null}
            {autoBuy.removal.kept.map((text) => (
              <p className="spdex-dca-line" key={text} data-testid="dca-remove-plans-vault">
                {text}
              </p>
            ))}
            {autoBuy.removal.error !== null ? (
              <p className="spdex-dca-line spdex-dca-line--warn">{autoBuy.removal.error}</p>
            ) : null}
            <div className="spdex-dca-actions">
              {autoBuy.removal.error === null ? (
                <Button testId="dca-remove-plans-confirm" onClick={() => autoBuy.answerRemoval(true)}>
                  {autoBuy.removal.count > 0 ? "Remove and continue" : "Continue"}
                </Button>
              ) : null}
              <Button variant="ghost" testId="dca-remove-plans-cancel" onClick={() => autoBuy.answerRemoval(false)}>
                Cancel
              </Button>
            </div>
          </Banner>
        </div>
      ) : null}

      {!running && tabPlans.length > 0 ? (
        <Banner tone="warn" title="Auto-buy is switched off" testId="dca-feature-off">
          <p className="spdex-dca-line">
            {vaultPlans > 0
              ? "No plan run from this tab will buy until you switch it back on; vaults keep buying whenever triggered. Your plans are kept."
              : "No plan will buy until you switch it back on. Your plans are kept."}
          </p>
          <div className="spdex-dca-actions">
            <Button testId="dca-enable" onClick={autoBuy.enableAutoBuy}>
              Switch on
            </Button>
          </div>
        </Banner>
      ) : null}
      {noSafety ? (
        <Banner
          tone="warn"
          title={autoBuy.safety === "unavailable" ? "This service can't safety-check" : "Safety check not confirmed"}
          testId="dca-no-safety-test"
        >
          {autoBuy.safety === "unavailable"
            ? "Every buy is skipped."
            : "Buys are skipped until it can. Retrying every minute."}{" "}
          <GoTo place="networkService">Change service</GoTo>
        </Banner>
      ) : null}
      {tabPlans.length > 0 && otherTabLeads(autoBuy.snapshot) ? (
        <Banner tone="ok" title="Running in another tab" testId="dca-other-tab">
          Another spDEX tab is running these plans
          {lease === null ? "" : ` (last checked ${localClock(Math.floor(lease.lastTick / 1000))})`}. Close it to run
          them here.
        </Banner>
      ) : null}
      {leader === "unsupported" && tabPlans.length > 0 ? (
        <Banner tone="warn" title="Auto-buy can't run in this browser" testId="dca-unsupported">
          This browser can't make sure only one spDEX tab buys at a time, so no tab here buys. Open spDEX in a current
          browser.
        </Banner>
      ) : null}
      {needsWallet ? (
        <Banner
          tone="warn"
          // Vaults that exist buy with no wallet here; one still to be
          // created is what needs it, and the title says so.
          title={walletPlansActive ? "Connect your wallet to keep buying" : "Connect your wallet to create your vault"}
          testId="dca-needs-wallet"
        >
          <p className="spdex-dca-line">
            {walletPlansActive
              ? vaultPlans > 0
                ? "Plans you confirm can't buy while your wallet is disconnected. Vaults keep going."
                : "Plans you confirm can't buy while your wallet is disconnected."
              : "Creating a vault needs the wallet that pays for it."}
          </p>
          <div className="spdex-dca-actions">
            <Button testId="dca-panel-connect" onClick={deps.onConnect}>
              Connect wallet
            </Button>
          </div>
        </Banner>
      ) : null}
      {wrongNetwork ? (
        <Banner tone="warn" title="Your wallet is on another network" testId="dca-wrong-network">
          {walletPlansActive
            ? `Plans you confirm can't buy until you switch to ${networkLabel(config.chainId)}.`
            : `A vault can't be created until you switch to ${networkLabel(config.chainId)}.`}
        </Banner>
      ) : null}

      {plans.map((plan) =>
        plan.signer === "vault" ? (
          <VaultPlanCard key={`${plan.chainId}:${plan.id}`} plan={plan} autoBuy={autoBuy} deps={deps} />
        ) : (
          <PlanCard key={`${plan.chainId}:${plan.id}`} plan={plan} autoBuy={autoBuy} deps={deps} />
        ),
      )}
      {openVault ? (
        // Once for the panel, not on every vault card: it is the same line
        // for each. It points at the guide rather than a command, since
        // running a keeper for good takes a computer that stays on. It says
        // what a keeper costs its owner, and that one set up as the guide
        // starts it makes only buys whose fee covers their network fee —
        // which a small buy's doesn't — so it isn't a promise that yours
        // get made.
        <p className="spdex-dca-hint" data-testid="dca-vault-keeper">
          Want your buys made even if nobody else makes them? Run your own <Term tip={VAULT_TIPS.keeper}>keeper</Term>.
          <InfoTerm tip={OWN_KEEPER_TIP} label="How" />
        </p>
      ) : null}
      <StrayVaults autoBuy={autoBuy} deps={deps} />
    </>
  );

  return open !== undefined ? (
    <section className="spdex-dca-tile" data-testid="dca-panel">
      <p className="spdex-panel__subtitle">{subtitle}</p>
      {body}
    </section>
  ) : (
    <Panel title="Your auto-buys" subtitle={subtitle} testId="dca-panel">
      {body}
    </Panel>
  );
}
