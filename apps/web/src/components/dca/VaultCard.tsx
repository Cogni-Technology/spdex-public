/**
 * A vault plan's card, and the one-time step that sets vaults up on a network.
 *
 * A vault plan is run by its vault, on chain, not by this tab: whoever sends a
 * due buy triggers it, and the vault checks every term itself. So this card is
 * a window onto the chain rather than onto this browser's record. Its progress,
 * totals and history are the vault's own, read through the person's network
 * service; its countdown is in chain time (`autoBuy.chainNow`), since the vault
 * judges "due" by the block a buy lands in; and a figure that can't be read is
 * "unknown", never zero — a vault that looks empty because a read failed is
 * still holding someone's money.
 *
 * What the card offers follows from what a vault is:
 *
 * - **No Pause.** A vault's terms are fixed in its code, and a pause would be a
 *   switch someone has to be trusted with. "Close and withdraw" is the only
 *   stop, and the card says so in one line where Pause would be.
 * - **Trigger now.** A due buy waits for a keeper; the person may be theirs,
 *   paying the network fee and collecting the buy fee (as WETH) like anyone
 *   else would. The button is there only while a read says the buy would go
 *   through, which is what the Guard's simulation will see.
 * - **Someone else's vault is read-only.** A plan that arrived in a link can
 *   point at a vault another wallet owns: it is shown, never funded, closed or
 *   triggered from here.
 *
 * Each button calls the hook, which builds the transaction, runs it past the
 * vault Guard and asks the wallet; none of that lives here. Ids inside are
 * fixed and card-scoped, reached through `dca-plan-{id}` as on every plan card.
 */

import { useId, useState } from "react";
import { Banner, Brand, Button, Disclosure, Pill, Progress, Row, Stat, Term, Toggle } from "@spdex/ui";
import { NATIVE_TOKEN } from "@spdex/chain";
import type { DcaPlan } from "@spdex/core";
import { ethText, tokenLabel } from "../../lib/dca/format.js";
import { VAULT_FACTORY_ACTIVITY, type AutoBuy, type AutoBuyDeps } from "../../lib/dca/useAutoBuy.js";
import {
  describeMarketGap,
  FACTORY_LIMITS,
  type VaultRetryTerms,
  vaultAverageStat,
  vaultBoughtStat,
  vaultCapText,
  vaultNextBuyStat,
  vaultProgress,
  vaultRemovalWarning,
  type VaultCardStatus,
  type VaultFigures,
  type VaultPlanState,
} from "../../lib/dca/vault.js";
import { amountEvery, cardTitle } from "../../lib/dca/view.js";
import type { MoneyView } from "../../lib/money/convert.js";
import { moneyView, useRatesNeeded } from "../../lib/money/rates.js";
import { networkLabel } from "../../lib/networks.js";
import { AddressText, CopyButton, Dotted, InfoTerm, NoticeBanner, TxRef } from "./common.js";
import {
  allowanceText,
  closeConfirmText,
  deployFee,
  dueText,
  factoryDeployMillions,
  ownerText,
  retryFeeNote,
  retryPayeeText,
  retryRewardText,
  retryRulesText,
  triggerCostText,
  triggerGasCost,
  VAULT_SLIPPAGE_OPTIONS,
  VAULT_TIPS,
  vaultHistoryRows,
  vaultHoldsText,
  vaultLine,
  vaultRewardText,
  vaultTermsTail,
  createSendsText,
} from "./vaultCopy.js";
import { formatCount } from "../../lib/money/format.js";

const LOADING: VaultCardStatus = {
  row: "vault",
  vault: "loading",
  pill: "paused",
  pillLabel: "Checking",
  reason: "Reading the vault from the network…",
  nextBuyAt: null,
};

/** The vault's own figures, when it has been read; null before, or when it couldn't be. */
function figuresOf(state: VaultPlanState): (VaultFigures & { kind: "active" | "someone-else" }) | null {
  return state.kind === "active" || state.kind === "someone-else" ? state : null;
}

/**
 * A sentence with its first "keeper" (or "Keepers") explained on hover, as
 * every vault note's is: the word a newcomer won't know, where it first
 * appears. A sentence without one is shown as it is.
 */
export function WithKeeperTerm({ text }: { text: string }) {
  const match = /\b[Kk]eepers?\b/.exec(text);
  if (match === null) return <>{text}</>;
  return (
    <>
      {text.slice(0, match.index)}
      <Term tip={VAULT_TIPS.keeper}>{match[0]}</Term>
      {text.slice(match.index + match[0].length)}
    </>
  );
}

/** "Unaudited", beside every place a vault is offered or shown. */
export function UnauditedBadge({ testId }: { testId?: string }) {
  return (
    <span className="spdex-dca-badge" data-testid={testId} title="Nobody independent has reviewed this contract's code yet.">
      Unaudited
    </span>
  );
}

/**
 * Why the owner's buttons on a vault card can't be pressed right now, or null.
 * One sentence under the buttons, rather than one per button.
 */
export function walletBlock(deps: AutoBuyDeps, autoBuy: AutoBuy): string | null {
  if (deps.account === null) return "Connect your wallet to create, fund, trigger or close a vault.";
  if (!deps.walletChainOk) return `Switch your wallet to ${networkLabel(deps.config.chainId)} first.`;
  if (autoBuy.ownerLockBusy) return "Waiting for your swap to finish…";
  return null;
}

export function VaultPlanCard({ plan, autoBuy, deps }: { plan: DcaPlan; autoBuy: AutoBuy; deps: AutoBuyDeps }) {
  const expert = deps.mode === "expert";
  const state: VaultPlanState = autoBuy.vaultFor(plan.id) ?? { kind: "loading" };
  const status = autoBuy.vaultStatusFor(plan.id) ?? LOADING;
  const chainNow = autoBuy.chainNow(plan.id);
  const activity = autoBuy.activity[plan.id];
  const busy = activity?.busy ?? null;
  const figures = figuresOf(state);
  const theirs = state.kind === "someone-else";
  // The card shows its buy fee in money, so it asks for rates while it is on
  // screen; the figure is left off until they arrive, never shown as zero.
  const tick = useRatesNeeded(deps.pricing, true);
  const money = moneyView(deps.pricing, tick);
  // Fund, close and trigger are the owner's, and offered only once the
  // connected wallet is known to be it: with none connected, whose vault this
  // is can't be told, and a button that then fails is worse than a sentence.
  const mine = figures !== null && figures.mine === true;
  const [panel, setPanel] = useState<"none" | "close" | "delete">("none");
  const block = walletBlock(deps, autoBuy);
  const pressable = block === null && busy === null;

  // The one reason line: an action under way first, then the vault's state.
  const line = busy ?? vaultLine(status, state);
  const due = status.vault === "due" && figures !== null && !theirs;
  const next = vaultNextBuyStat(status, chainNow, autoBuy.now);
  const bought =
    figures !== null ? vaultBoughtStat(figures) : state.kind === "not-created" || state.kind === "creating" ? "none yet" : null;
  const average =
    figures !== null ? vaultAverageStat(figures) : state.kind === "not-created" || state.kind === "creating" ? "—" : null;
  const progress =
    figures !== null
      ? vaultProgress(figures)
      : state.kind === "not-created" || state.kind === "creating"
        ? { value: 0, valueText: `0 of ${formatCount(plan.maxBuys)} buys · nothing spent yet` }
        : { value: null, valueText: "Buys made: unknown" };

  // The terms the vault itself holds, once read: they are what it follows,
  // whatever the plan in the config says.
  const described =
    figures === null
      ? plan
      : {
          sell: NATIVE_TOKEN,
          amountPerBuy: figures.terms.amountPerBuy.toString(),
          intervalSeconds: Number(figures.terms.interval),
          maxBuys: Number(figures.terms.maxBuys),
        };
  const open = figures !== null && !figures.closed;
  const canFund = mine && open && figures.mismatches.length === 0 && figures.fundingRoom > 0n;
  const canClose = mine && open;
  // The one action left on a finished vault — when there is something to take
  // back. Closing an empty one costs a fee and returns nothing.
  const closeFirst = canClose && status.vault === "done" && figures.balance > 0n;
  const tail = vaultTermsTail(state);
  const support = autoBuy.vaultSupport;
  // A plan whose vault doesn't exist yet: what stands in the way of creating
  // it, and what creating it would send.
  const creatable = state.kind === "not-created";
  const createBlock = !creatable
    ? null
    : support.kind === "checking"
      ? "Checking whether a vault can be created here…"
      : support.kind === "deployable"
        ? "Set up vaults on this network first (above)."
        : support.kind === "unsupported" || support.kind === "unavailable"
          ? support.reason
          : block;
  // What "Create and fund vault" would create the vault with, shown before
  // the click and sent by it: an allowance picked here, else the one this
  // browser kept from the form, else none — the card asks. The buy fee and
  // the budget follow from the same function the hook uses.
  const [chosen, setChosen] = useState<number | null>(null);
  const retry = creatable ? autoBuy.vaultRetryFor(plan.id, chosen) : null;
  const costs = creatable ? autoBuy.vaultCostsFor(BigInt(plan.amountPerBuy), plan.maxBuys) : null;
  const retryReady = retry !== null && retry.maxSlippageBps !== null && retry.keeperReward !== null && retry.fund !== null;
  const createSends = creatable ? createSendsText(retry, costs) : null;
  const gap = support.kind === "available" ? support.availability.marketGapBps : null;
  const gapWide =
    gap !== null && figures !== null && open && (gap < 0n ? -gap : gap) > FACTORY_LIMITS.MAX_MARKET_GAP_BPS;

  return (
    <div
      className={`spdex-plan spdex-plan--vault${status.pill === "attention" ? " spdex-plan--attention" : ""}`}
      data-testid={`dca-plan-${plan.id}`}
    >
      <div className="spdex-plan__head">
        <span className="spdex-plan__titlegroup">
          <h3 className="spdex-plan__title">{cardTitle(plan)}</h3>
          <UnauditedBadge testId="dca-vault-badge" />
        </span>
        <Pill status={status.pill} testId="dca-pill">
          {status.pillLabel}
        </Pill>
      </div>
      <p className="spdex-plan__terms" data-testid="dca-terms">
        {amountEvery(described)} · {tail[0]}
        <Term tip={VAULT_TIPS.vault}>vault</Term>
        {tail[1]}
      </p>
      <Progress
        value={progress.value}
        max={figures?.maxBuys ?? plan.maxBuys}
        label="Buys made"
        testId="dca-progress"
        {...(progress.valueText === undefined ? {} : { valueText: progress.valueText })}
      />
      <div className="spdex-statgrid">
        <Stat label="Next buy" value={next.value} hint={next.hint} testId="dca-next" />
        <Stat label="Bought" value={bought} testId="dca-bought" />
        <Stat
          label="Average rate"
          value={average}
          hint={figures !== null && figures.buysDone > 0 ? "before buy fees" : null}
          testId="dca-avg"
        />
      </div>
      <p
        className={`spdex-plan__status${due && busy === null ? " spdex-plan__status--echo" : ""}`}
        data-testid="dca-status"
        aria-live="polite"
      >
        {line}
      </p>
      {activity?.notice ? <NoticeBanner notice={activity.notice} onDismiss={() => autoBuy.clearNotice(plan.id)} /> : null}

      {due ? (
        <DueBanner
          figures={figures}
          autoBuy={autoBuy}
          money={money}
          mine={mine}
          block={figures.mine === null ? "Connect the wallet that owns this vault to trigger it from here." : block}
          busy={busy !== null}
          onTrigger={() => void autoBuy.triggerVault(plan.id)}
        />
      ) : null}
      {gapWide && gap !== null ? (
        <p className="spdex-dca-hint spdex-dca-hint--warn" data-testid="dca-vault-gap">
          {sentence(describeMarketGap(gap, figures.terms.maxSlippageBps))}
        </p>
      ) : null}
      {creatable && support.kind === "deployable" ? (
        <VaultFactorySetup autoBuy={autoBuy} deps={deps} testId="dca-vault-setup" />
      ) : null}

      <VaultFacts plan={plan} state={state} money={money} />
      {creatable && retry !== null ? (
        <RetryTerms plan={plan} retry={retry} onChoose={setChosen} />
      ) : null}

      <div className="spdex-dca-actions">
        {creatable ? (
          <Button
            testId="dca-vault-create"
            disabled={support.kind !== "available" || createBlock !== null || busy !== null || !retryReady}
            onClick={() => {
              if (retry === null || retry.maxSlippageBps === null || retry.keeperReward === null || retry.fund === null) return;
              void autoBuy.createVault(plan.id, {
                maxSlippageBps: retry.maxSlippageBps,
                keeperReward: retry.keeperReward,
                fund: retry.fund,
              });
            }}
          >
            Create and fund vault
          </Button>
        ) : null}
        {canFund ? (
          <Button
            testId="dca-vault-fund"
            variant={status.vault === "unfunded" ? "solid" : "ghost"}
            disabled={!pressable}
            onClick={() => void autoBuy.fundVault(plan.id)}
          >
            {status.vault === "unfunded" ? `Fund ${ethText(figures.fundingRoom, 6)} ETH` : `Add ${ethText(figures.fundingRoom, 6)} ETH`}
          </Button>
        ) : null}
        {canClose ? (
          <Button
            testId="dca-vault-close"
            variant={closeFirst ? "solid" : "ghost"}
            disabled={!pressable}
            expanded={panel === "close"}
            onClick={() => setPanel(panel === "close" ? "none" : "close")}
          >
            {closeLabel(figures)}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          testId="dca-delete"
          disabled={busy !== null}
          onClick={() => setPanel(panel === "delete" ? "none" : "delete")}
        >
          {theirs ? "Remove" : "Delete"}
        </Button>
      </div>
      {creatable && createBlock !== null ? <p className="spdex-dca-hint">{createBlock}</p> : null}
      {creatable && createBlock === null && createSends !== null ? (
        <p className="spdex-dca-hint" data-testid="dca-vault-create-cost">
          {createSends}
        </p>
      ) : null}
      {(canFund || canClose) && block !== null ? <p className="spdex-dca-hint">{block}</p> : null}
      {figures !== null && figures.mine === null && open ? (
        <p className="spdex-dca-hint">Connect the wallet that owns this vault to fund or close it.</p>
      ) : null}
      {open && !theirs && figures.buysLeft > 0 ? (
        <p className="spdex-dca-hint" data-testid="dca-vault-no-pause">
          No pause: only closing it stops it.
          <InfoTerm tip="A vault's terms are fixed in its code, so nobody, not you and not spDEX, can pause it." label="Why?" />
        </p>
      ) : null}

      {panel === "close" && canClose ? (
        <CloseConfirm
          figures={figures}
          disabled={!pressable}
          onConfirm={() => {
            setPanel("none");
            void autoBuy.closeVault(plan.id);
          }}
          onClose={() => setPanel("none")}
        />
      ) : null}
      {panel === "delete" ? (
        <DeleteConfirm plan={plan} state={state} autoBuy={autoBuy} busy={busy !== null} onClose={() => setPanel("none")} />
      ) : null}

      {figures !== null ? <VaultHistory plan={plan} figures={figures} autoBuy={autoBuy} deps={deps} /> : null}
      <VaultDetails plan={plan} state={state} status={status} chainNow={chainNow} expert={expert} autoBuy={autoBuy} />
    </div>
  );
}

/** A reason from @spdex/vault ("the market's oracle pool quotes …") as a sentence. */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed.length === 0 ? "" : `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}.`;
}

// ── A due buy ─────────────────────────────────────────────────────────────

/**
 * A due buy waits for a keeper — that is the plan working, not a fault, so the
 * banner is calm. The person may trigger it themselves: their wallet pays the
 * network fee, as any keeper's does, and the vault pays them the buy fee. Both
 * figures are given the way the form gave the fee, dollars first, so they can
 * be weighed. When the fee is less than the network fee, it says so — "comes
 * back to you" would otherwise read as money back on what is a net cost — and
 * Trigger now steps back to a plain button, so that waiting reads as the
 * default.
 */
function DueBanner({
  figures,
  autoBuy,
  money,
  mine,
  block,
  busy,
  onTrigger,
}: {
  figures: VaultFigures;
  autoBuy: AutoBuy;
  money: MoneyView | undefined;
  mine: boolean;
  block: string | null;
  busy: boolean;
  onTrigger: () => void;
}) {
  const firstBuy = figures.buysDone === 0;
  const gas = triggerGasCost(autoBuy.fees, firstBuy);
  const buyFee = figures.terms.keeperReward;
  const costsMore = triggerCostText(autoBuy.fees, buyFee, firstBuy);
  return (
    <Banner
      tone="ok"
      title={
        <>
          Buy {formatCount(figures.buysDone + 1)} is due — waiting for a{" "}
          <Term tip={VAULT_TIPS.keeper}>keeper</Term>
        </>
      }
      testId="dca-vault-due"
    >
      <p className="spdex-dca-line">{dueText(buyFee, gas, money)}</p>
      {costsMore !== null ? (
        <p className="spdex-dca-hint" data-testid="dca-vault-trigger-cost">
          {costsMore}
        </p>
      ) : null}
      {mine ? (
        <div className="spdex-dca-actions">
          <Button
            testId="dca-vault-trigger"
            variant={costsMore === null ? "solid" : "ghost"}
            disabled={!figures.canTrigger || block !== null || busy}
            onClick={onTrigger}
          >
            Trigger now
          </Button>
        </div>
      ) : null}
      {block !== null ? <p className="spdex-dca-hint">{block}</p> : null}
    </Banner>
  );
}

// ── Setting vaults up on a network ────────────────────────────────────────

/**
 * "Set up vaults on this network": the factory every vault is cloned from
 * isn't on this chain yet. Deploying it is one transaction anyone can send,
 * and it lands at the same address whoever sends it — nobody owns what it
 * creates, so there is nothing to trust in who pressed the button. It costs
 * gas, about 3.6 million, and that is said before the wallet opens.
 */
export function VaultFactorySetup({ autoBuy, deps, testId }: { autoBuy: AutoBuy; deps: AutoBuyDeps; testId: string }) {
  const support = autoBuy.vaultSupport;
  const activity = autoBuy.activity[VAULT_FACTORY_ACTIVITY];
  const busy = activity?.busy ?? null;
  const fee = deployFee(autoBuy.fees.kind === "ok" ? autoBuy.fees.fees : null);
  const block = walletBlock(deps, autoBuy);
  if (support.kind !== "deployable") return null;
  return (
    <Banner tone="warn" title="Vaults aren't set up on this network yet" testId={testId}>
      <p className="spdex-dca-line">
        Vaults are copies of one shared factory, not yet on {networkLabel(deps.config.chainId)}. Anyone can deploy it
        once: about {factoryDeployMillions()} million gas{fee === null ? "" : `, ${ethText(fee, 6)} ETH at today's fees`}.
      </p>
      <p className="spdex-dca-line">
        <AddressText address={support.factory} />
      </p>
      <p className="spdex-dca-hint">
        Nobody owns or can change it; it lands at this address whoever sends it.
        <InfoTerm
          tip="If someone else's deployment lands first, yours fails and still costs most of that gas. spDEX checks once more just before your wallet opens, which narrows that window but can't close it."
          label="If someone else deploys it first"
        />
      </p>
      <div className="spdex-dca-actions">
        <Button testId={`${testId}-deploy`} disabled={block !== null || busy !== null} onClick={() => void autoBuy.deployVaultFactory()}>
          Set up vaults on this network
        </Button>
      </div>
      {busy !== null ? (
        <p className="spdex-dca-hint" aria-live="polite">
          {busy}
        </p>
      ) : block !== null ? (
        <p className="spdex-dca-hint">{block}</p>
      ) : null}
    </Banner>
  );
}

// ── The vault's facts ─────────────────────────────────────────────────────

/**
 * The few rows a vault's owner checks at a glance: where it is (with copy),
 * what it still holds and how far that goes, its buy fee and what it has paid,
 * and the price allowance every buy is held to. Someone else's vault adds its
 * owner.
 */
function VaultFacts({ plan, state, money }: { plan: DcaPlan; state: VaultPlanState; money: MoneyView | undefined }) {
  const figures = figuresOf(state);
  if (state.kind === "creating") {
    return (
      <div className="spdex-dca-facts">
        <Row
          label="Vault"
          testId="dca-vault-address"
          value={
            state.vault === null ? (
              "being created"
            ) : (
              <span className="spdex-dca-addressrow">
                <AddressText address={state.vault} />
                <CopyButton text={state.vault} />
              </span>
            )
          }
        />
        {state.hash !== null ? <Row label="Creation" value={<TxRef chainId={plan.chainId} hash={state.hash} />} /> : null}
      </div>
    );
  }
  if (figures === null) return null;
  return (
    <div className="spdex-dca-facts">
      <Row
        label={<Term tip={VAULT_TIPS.vault}>Vault</Term>}
        value={
          <span className="spdex-dca-addressrow">
            <AddressText address={figures.vault} testId="dca-vault-address" />
            <CopyButton text={figures.vault} testId="dca-vault-copy" />
          </span>
        }
      />
      {figures.mine !== true ? (
        <Row
          label="Owner"
          value={
            <span className="spdex-dca-addressrow">
              <AddressText address={figures.owner} />
              <CopyButton text={figures.owner} testId="dca-vault-owner-copy" />
            </span>
          }
          testId="dca-vault-owner"
        />
      ) : null}
      <Row label={<Term tip={VAULT_TIPS.weth}>Holds</Term>} value={<Dotted text={vaultHoldsText(figures)} />} testId="dca-vault-balance" />
      <Row label={<Term tip={VAULT_TIPS.fee}>Buy fee</Term>} value={<Dotted text={vaultRewardText(figures, money)} />} testId="dca-vault-reward" />
      <Row
        label="Price allowance"
        testId="dca-vault-allowance"
        value={
          <>
            {allowanceText(figures.terms.maxSlippageBps)} below the{" "}
            <Term tip={VAULT_TIPS.tenMinuteAverage}>
              <span className="spdex-dca-nobreak">10-minute average</span>
            </Term>
          </>
        }
      />
    </div>
  );
}

// ── Creating it again ─────────────────────────────────────────────────────

/**
 * The two terms a plan has no field for, on a card whose vault doesn't exist
 * yet: the price allowance (the chips the form has) and the buy fee, with the
 * form's note when buys this small depend on keepers that batch, or may not be
 * made at all. Both are fixed in the vault for good, so neither is left for
 * the click to decide: what is shown here is what "Create and fund vault"
 * sends.
 */
function RetryTerms({ plan, retry, onChoose }: { plan: DcaPlan; retry: VaultRetryTerms; onChoose: (bps: number) => void }) {
  const labelId = useId();
  const amountPerBuy = BigInt(plan.amountPerBuy);
  const note = retry.keeperReward === null ? null : retryFeeNote(retry.keeperReward, amountPerBuy);
  return (
    <div className="spdex-dca-facts" data-testid="dca-vault-retry">
      <div className="spdex-dca-chips" role="group" aria-labelledby={labelId}>
        <span className="spdex-field__label" id={labelId}>
          Price allowance
        </span>
        <Toggle
          testId="dca-vault-retry-slippage"
          value={retry.maxSlippageBps === null ? "" : String(retry.maxSlippageBps)}
          onChange={(value) => onChoose(Number(value))}
          options={VAULT_SLIPPAGE_OPTIONS}
        />
        <AllowanceHint allowance={retry.maxSlippageBps === null ? null : allowanceText(retry.maxSlippageBps)} />
      </div>
      <Row
        label={<Term tip={VAULT_TIPS.fee}>Buy fee</Term>}
        value={<Dotted text={retryRewardText(retry, amountPerBuy)} />}
        testId="dca-vault-retry-reward"
      />
      <p className="spdex-dca-hint" data-testid="dca-vault-retry-payee">
        {retryPayeeText()}
      </p>
      {note !== null ? (
        <p className={`spdex-dca-hint${note.testId === "dca-vault-retry-small" ? " spdex-dca-hint--warn" : ""}`} data-testid={note.testId}>
          <WithKeeperTerm text={note.text} />
        </p>
      ) : null}
      <p className="spdex-dca-hint" data-testid="dca-vault-retry-rules">
        {retryRulesText(vaultCapText())}
      </p>
    </div>
  );
}

/**
 * The price allowance's one line, the Recurring form's and a not-yet-created
 * vault card's alike, so both say it the same way: "Refused if > 2% below the
 * 10-min average. Fixed at creation." With none chosen yet, it asks for one.
 */
export function AllowanceHint({ allowance }: { allowance: string | null }) {
  const average = (
    <Term tip={VAULT_TIPS.tenMinuteAverage}>
      <span className="spdex-dca-nobreak">10-min average</span>
    </Term>
  );
  return (
    <span className="spdex-field__hint">
      {allowance === null ? (
        <>Pick one: buys more than that below the {average} are refused. Fixed at creation.</>
      ) : (
        <>
          Refused if &gt; {allowance} below the {average}. Fixed at creation.
        </>
      )}
      <InfoTerm tip="Tighter protects more; looser waits less." label="Which to pick?" />
    </span>
  );
}

// ── Close and delete ──────────────────────────────────────────────────────

/** What closing a vault does, as its button says it: an empty one has nothing to withdraw. */
export function closeLabel(figures: Pick<VaultFigures, "balance">): string {
  return figures.balance > 0n ? "Close and withdraw" : "Close vault";
}

export function CloseConfirm({
  figures,
  disabled,
  onConfirm,
  onClose,
}: {
  figures: VaultFigures;
  disabled: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="spdex-dca-inline" data-testid="dca-vault-close-ask">
      <p className="spdex-dca-inline__title">Close this vault?</p>
      <p className="spdex-dca-line">{closeConfirmText(figures)}</p>
      <div className="spdex-dca-actions">
        <Button testId="dca-vault-close-confirm" disabled={disabled} onClick={onConfirm}>
          {closeLabel(figures)}
        </Button>
        <Button variant="ghost" testId="dca-vault-close-cancel" onClick={onClose}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * Deleting a vault plan only forgets it in this browser: the vault is on
 * chain and goes on buying whenever triggered. So the question says what is
 * at stake — money still in it, a creation not yet confirmed — and the button
 * says what it does.
 */
function DeleteConfirm({
  plan,
  state,
  autoBuy,
  busy,
  onClose,
}: {
  plan: DcaPlan;
  state: VaultPlanState;
  autoBuy: AutoBuy;
  busy: boolean;
  onClose: () => void;
}) {
  const warning = vaultRemovalWarning(state);
  const theirs = state.kind === "someone-else";
  const title = cardTitle(plan);
  const text =
    state.kind === "not-created"
      ? `Delete "${title}"? It has no vault, so nothing was bought or put in.`
      : theirs
        ? `Remove "${title}" from your list? The vault is someone else's and stays on chain; this only stops showing it here.`
        : `Delete "${title}" from this list? This doesn't touch the vault.`;
  // With something at stake the safe answer is the prominent one: "Delete
  // anyway" forgets a vault that may still hold money, and spDEX finds it
  // again only by searching the chain, which a network service may cut short.
  const atStake = warning !== null && !theirs;
  return (
    <div className="spdex-dca-inline">
      <p className="spdex-dca-line">{text}</p>
      {atStake ? <p className="spdex-dca-line spdex-dca-line--warn">{warning}</p> : null}
      <div className="spdex-dca-actions">
        <Button
          testId="dca-delete-confirm"
          variant={atStake ? "ghost" : "solid"}
          disabled={busy}
          onClick={() => void autoBuy.deletePlan(plan.id)}
        >
          {theirs ? "Remove from list" : atStake ? "Delete anyway" : "Delete plan"}
        </Button>
        <Button variant={atStake ? "solid" : "ghost"} testId="dca-delete-cancel" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── History ───────────────────────────────────────────────────────────────

/**
 * The vault's history from its own logs, read when opened. Best effort: a
 * network service that won't serve old logs leaves earlier buys out and says
 * so, and the totals above — the vault's own counters — stay the figures to
 * trust.
 */
function VaultHistory({
  plan,
  figures,
  autoBuy,
  deps,
}: {
  plan: DcaPlan;
  figures: VaultFigures;
  autoBuy: AutoBuy;
  deps: AutoBuyDeps;
}) {
  const [all, setAll] = useState(false);
  const read = autoBuy.vaultHistory[plan.id];
  const expert = deps.mode === "expert";
  const rows =
    read?.kind === "ok"
      ? vaultHistoryRows({
          entries: read.history.entries,
          missingBuys: read.history.missingBuys,
          terms: figures.terms,
          account: deps.account,
          chainNow: autoBuy.chainNow(plan.id),
          nowMs: autoBuy.now,
        })
      : [];
  const shown = expert || all ? rows : rows.slice(0, 5);
  return (
    <Disclosure
      summary={read?.kind === "ok" ? `History (${rows.length})` : "History"}
      testId="dca-history"
      onToggle={(isOpen) => {
        // Read on first opening, and again after a read that failed: an
        // endpoint that refused logs a minute ago may serve them now.
        if (isOpen && (read === undefined || read.kind === "error")) void autoBuy.loadVaultHistory(plan.id);
      }}
    >
      {read === undefined || read.kind === "loading" ? (
        <p className="spdex-dca-hint">Reading the vault's history…</p>
      ) : read.kind === "error" ? (
        <p className="spdex-dca-hint">
          spDEX couldn't read this vault's history ({read.message}). The totals above are the vault's own and count every
          buy.
        </p>
      ) : rows.length === 0 ? (
        read.history.missingBuys > 0 ? null : <p className="spdex-dca-hint">Nothing yet: no buy has been triggered.</p>
      ) : (
        <ol className="spdex-history">
          {shown.map((row) => (
            <li key={row.seq} className="spdex-history__row" data-testid={`dca-run-${row.seq}`} data-kind={row.kind}>
              <span className="spdex-history__text">{row.text}</span>
              <TxRef chainId={plan.chainId} hash={row.hash} testId={`dca-tx-${row.seq}`} />
            </li>
          ))}
        </ol>
      )}
      {read?.kind === "ok" && read.history.note !== null ? <p className="spdex-dca-hint">{read.history.note}</p> : null}
      {!expert && !all && rows.length > 5 ? (
        <button type="button" className="spdex-dca-link" onClick={() => setAll(true)}>
          Show all
        </button>
      ) : null}
    </Disclosure>
  );
}

// ── Details ───────────────────────────────────────────────────────────────

/**
 * Everything the vault is, in the raw, as read from the chain; the plan's own
 * figures before it exists. Open in Expert. Times are chain time, with this
 * device's clock beside them.
 *
 * The Simple view keeps the rows a person can check: which network, which
 * contracts and addresses, whether a buy would go through, why a figure is
 * unknown. The raw ones — wei, seconds, basis points, unix times, internal
 * state names — are the Expert view's; the card above says each in words.
 */
function VaultDetails({
  plan,
  state,
  status,
  chainNow,
  expert,
  autoBuy,
}: {
  plan: DcaPlan;
  state: VaultPlanState;
  status: VaultCardStatus;
  chainNow: number | null;
  expert: boolean;
  autoBuy: AutoBuy;
}) {
  const figures = figuresOf(state);
  const at = (seconds: number) =>
    chainNow === null
      ? `${seconds} (chain time)`
      : `${seconds} · ${new Date((Math.floor(autoBuy.now / 1000) + seconds - chainNow) * 1000).toLocaleString(undefined, { hourCycle: "h23" })} on this device's clock`;
  const buy = figures?.terms.tokenOut ?? plan.buy;
  return (
    <Disclosure summary="Vault details" testId="dca-details" open={expert}>
      {expert ? <Row label="Plan id" value={plan.id} /> : null}
      <Row label="Network" value={networkLabel(plan.chainId)} />
      {expert ? <Row label="State" value={status.vault} /> : null}
      {figures === null ? (
        <>
          <Row label="Buys" value={`${tokenLabel(plan.buy)} · ${plan.buy}`} />
          {expert ? (
            <>
              <Row label="Amount per buy" value={`${plan.amountPerBuy} wei`} />
              <Row label="Interval" value={`${formatCount(plan.intervalSeconds)} s`} />
              <Row label="Max buys" value={formatCount(plan.maxBuys)} />
              <Row label="First window" value={at(plan.startAt)} />
            </>
          ) : null}
          {state.kind === "unavailable" ? <Row label="Why unknown" value={state.code} /> : null}
          {state.kind === "unavailable" && state.detail !== undefined ? <Row label="What the service said" value={state.detail} /> : null}
          {plan.vault !== undefined ? <Row label="Vault" value={plan.vault} /> : null}
        </>
      ) : (
        <>
          <Row label="Vault" value={figures.vault} />
          <Row label="Owner" value={ownerText(figures.owner, figures.mine)} />
          <Row
            label={<>Made by <Brand />&apos;s factory</>}
            value={figures.fromFactory === null ? "unknown" : figures.fromFactory ? "yes" : "no"}
          />
          <Row label="Buys" value={`${tokenLabel(buy)} · ${buy}`} />
          <Row label="Market (Uniswap v2)" value={figures.terms.pair} />
          <Row label="Price from (Uniswap v3)" value={figures.terms.oraclePool} />
          {expert ? (
            <>
              <Row label="Amount per buy" value={`${figures.terms.amountPerBuy} wei of WETH`} />
              <Row label="Interval" value={`${formatCount(figures.terms.interval)} s`} />
              <Row label="Max buys" value={formatCount(figures.terms.maxBuys)} />
              <Row label="First window" value={at(Number(figures.terms.startAt))} />
              <Row label="Buy fee (keeperReward)" value={`${figures.terms.keeperReward} wei of WETH`} />
              <Row label="Price allowance" value={`${figures.terms.maxSlippageBps} bps`} />
              <Row label="Buys done" value={formatCount(figures.buysDone)} />
              <Row label="Closed" value={figures.closed ? "yes" : "no"} />
              <Row label="Holds" value={`${figures.balance} wei of WETH`} />
              <Row label="Room to fund" value={`${figures.fundingRoom} wei`} />
              <Row label="Next buy by the clock" value={figures.nextBuyAt === null ? "none" : at(figures.nextBuyAt)} />
              <Row
                label="A buy now"
                testId="dca-price-check"
                value={
                  figures.quote === null
                    ? "can't be priced: the 10-minute average can't answer right now"
                    : `would deliver ${figures.quote.spotOut} base units; the vault accepts no less than ${figures.quote.floorOut}`
                }
              />
            </>
          ) : null}
          <Row
            label="Price pool depth"
            value={figures.quote === null ? "unknown" : `${ethText(figures.quote.oracleDepth, 6)} WETH over 10 minutes`}
          />
          <Row label="Would go through now" value={figures.canTrigger ? "yes" : (figures.waitingFor ?? "no")} />
          {figures.mismatches.length > 0 ? (
            <Row
              label="Differs from the plan"
              value={figures.mismatches.map((m) => `${m.field}: plan ${String(m.plan)}, vault ${String(m.vault)}`).join("; ")}
            />
          ) : null}
        </>
      )}
      {expert ? <Row label="Chain time now" value={chainNow === null ? "unknown" : String(chainNow)} /> : null}
    </Disclosure>
  );
}
