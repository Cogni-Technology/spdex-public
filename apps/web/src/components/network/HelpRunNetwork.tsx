/**
 * Help run the network: make other people's due vault buys from this wallet,
 * in one transaction, and be paid their buy fees.
 *
 * A panel of its own, folded to its title (`HelpRunPanel`), for a connected
 * wallet where vaults are offered. Offered only with private sending (a
 * public batch is copied by bots, which take the fees first) and only when
 * the fees cover the network fee at the price that will be signed
 * (lib/network/batch.ts). In plain words: you pay the network fee, you earn
 * their buy fees. v2's buys only; one still inside its community window only
 * to a wallet the SPX holder registry finds eligible. Any other wallet is
 * told when holders' first claim ends and why it isn't one of them, with no
 * button for those buys.
 *
 * At its foot, Community keeping (CommunityKeeping.tsx), closed: whether
 * this wallet is a community keeper, and the proof that makes it one. It
 * shows with or without private sending; a proof needs none. The reminder
 * before a proof lapses is mounted here, with the panel, so it runs whether
 * or not either is opened, from this browser's storage alone.
 *
 * Nothing is read until the panel is opened, and nothing about the person's
 * own address until they ask: the vaults are found through Collective DCA's
 * read (`loadPlatform`, shared with that panel for five minutes), which
 * doesn't name them, and checking a batch test-runs it from their account.
 * Every read goes to their own network service; the transaction goes to
 * their relay.
 *
 * The button appears only for a batch the safety check verified, and the
 * check runs again the moment it is pressed: the call signed is exactly the
 * one checked, at exactly its gas limit and price, and it pays this wallet.
 *
 * In a tile (`open` defined, under Collective DCA) it has a small heading
 * instead of a fold, mounts its insides the first time the tile opens, and
 * adds "1 due" to the header's summary once a check has found due buys.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, FoldedPanel } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Address, GuardVerdict, Hex, SubmitterConfig } from "@spdex/core";
import type { VaultBatchTxPlan, VaultClaim } from "@spdex/guard";
import {
  MAINNET_DEPLOYMENT,
  checksumAddress,
  latestBlock,
  LATEST_RELEASE,
  readDueCandidates,
  readHolderStatus,
  releaseOfFactory,
  type DueCandidate,
  type HolderStatus,
} from "@spdex/vault";
import { guardSentence, uniqueByCode } from "../../lib/errors.js";
import { secondOpinionRefusalText } from "../../lib/simulation.js";
import { ethText, shortAddress } from "../../lib/dca/format.js";
import { deviceTimeOf } from "../../lib/dca/vault.js";
import type { OwnerWalletLock } from "../../lib/execute.js";
import type { Pricing } from "../../lib/money/pricing.js";
import { moneyView, useRatesNeeded } from "../../lib/money/rates.js";
import { loadPlatform } from "../../lib/network/platform.js";
import { networkName } from "../../lib/networks.js";
import {
  CANT_SIGN_PRIVATELY_TEXT,
  COMMUNITY_KEEPING_TEXT,
  IF_FIRST_TEXT,
  KEEPER_TEXT,
  NONE_DUE_TEXT,
  PUBLIC_SENDING_TEXT,
  TERMS_TEXT,
  batchIntent,
  buttonText,
  claimsOf,
  eligibleInNextBlock,
  feesEarnedFromOthers,
  holdersFirstText,
  ifFirstRelayText,
  introText,
  needsBalanceText,
  needsEligibility,
  noneWouldBuyText,
  notCoveredText,
  planHelpRun,
  resultText,
  splitByWindow,
  turnHeldText,
  waitForBatch,
  walletFeeText,
  walletKeeperText,
  youGetText,
  youPayText,
  type BatchResult,
  type HelpRunPlan,
} from "../../lib/network/batch.js";
import { KEEPER_DOCS_LINK_TEXT, keeperDocsUrl } from "../../lib/network/keeping.js";
import { perfNow } from "../../lib/page.js";
import { quantity } from "../../lib/receipts.js";
import { recordBuyFeesEarned } from "../../lib/records/store.js";
import { useProofLapseNotifications } from "../../lib/reminders/lapse.js";
import type { BuyDueNotifications } from "../../lib/reminders/notify.js";
import { walletSender } from "../../lib/senders.js";
import { PrivateSubmissionUnavailable, privateGasPrice } from "../../lib/submit.js";
import { isUserRejection, PRIVATE_CONFIRM_TIMEOUT_MS, type Eip1193Provider } from "../../lib/wallet.js";
import { GoTo } from "../../lib/places.js";
import type { TilePanelProps, TileSummary } from "../../lib/tiles.js";
import { CopyHex, TxRef } from "../dca/common.js";
import { useOpenedOnce, useTileSummary } from "../dca/tilePanel.js";
import { FinalityBadge } from "../trust/FinalityBadge.js";
import { CommunityKeeping, type KeepingEngine } from "./CommunityKeeping.js";
import "./network.css";

/**
 * What a batch needs from the Engine: its network service, its vault Guard's
 * batcher and factory, and the batch check; and for Community keeping, its
 * registry and the proof check.
 */
export interface HelpRunEngine extends KeepingEngine {
  readonly rpc: JsonRpc;
  readonly vaultFactory: Address;
  readonly vaultBatcher: Address;
  checkVaultBatch(intent: ReturnType<typeof batchIntent>): Promise<{ plan: VaultBatchTxPlan; verdict: GuardVerdict }>;
}

export interface HelpRunNetworkProps extends TilePanelProps {
  engine: HelpRunEngine;
  chainId: number;
  account: Address | null;
  walletChainOk: boolean;
  submitter: SubmitterConfig;
  /** For "≈" figures only; they are left out without fresh rates. */
  pricing: Pricing | null;
  /** The wallet is asked for one thing at a time; a swap or a plan's buy holds this while it runs. */
  ownerLock?: OwnerWalletLock;
  /** For tests; the page's wallet otherwise. */
  provider?: Eip1193Provider;
  /** The reminder before a proof lapses, mounted by `HelpRunPanel`; its tick shows in Community keeping. */
  reminder?: BuyDueNotifications;
}

/**
 * What a check read, kept for the person's ticks: every due buy, the
 * wallet's standing when it mattered (null when it didn't, or couldn't be
 * read), and so which buys are held back for SPX holders.
 */
interface CheckedDue {
  /** The due buys whose vault a claim was found for (`claimsOf`): the only ones a batch may carry. */
  all: readonly DueCandidate[];
  /** Each one's claim, by vault: what the batch intent proves it by. */
  claims: ReadonlyMap<Address, VaultClaim>;
  holder: HolderStatus | null;
  /** When it was read, by this device's clock (ms): with the standing's block time, what puts a chain time on this device's clock. */
  readAtMs: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; text: string }
  | {
      kind: "planned";
      plan: HelpRunPlan;
      /** The due buys this wallet may make: the tick list. */
      due: readonly DueCandidate[];
      /**
       * Due buys inside their window that this wallet can't be paid for: how
       * many, when the first opens to it, and how many only because the turn
       * is another group's.
       */
      heldBack: { count: number; until: bigint; byTurn: number } | null;
      checked: CheckedDue;
      verdict: GuardVerdict | null;
      ticked: ReadonlySet<string>;
    }
  | { kind: "sending"; text: string }
  | { kind: "sent"; hash: Hex; result: BatchResult | null; plan: Extract<HelpRunPlan, { kind: "offer" }>; recorded: boolean }
  | { kind: "stopped"; text: string };

type Planned = Extract<Phase, { kind: "planned" }>;

const lower = (value: string) => value.toLowerCase() as Address;

/** What the Collective DCA tile header adds from here: "1 due" after a check found due buys, or nothing. */
function helpRunSummary(phase: Phase): TileSummary {
  if (phase.kind !== "planned" || phase.due.length === 0) return { text: "" };
  return { text: `${phase.due.length} due` };
}

/**
 * Help run the network, folded to its title, and shown only while a wallet
 * is connected on this network. What is inside mounts the first time it is
 * opened and stays: closing the panel, or a wallet that disconnects or
 * switches network for a moment, never loses a batch on its way.
 */
export function HelpRunPanel(props: HelpRunNetworkProps) {
  const [folded, setOpened] = useState(false);
  const inTile = props.open !== undefined;
  const openedInTile = useOpenedOnce(props.open);
  const opened = inTile ? openedInTile : folded;
  const hidden = props.account === null || !props.walletChainOk;
  // What the header adds comes from the inside once it has checked; until
  // then, and with no wallet on this network, nothing.
  const [due, setDue] = useState<TileSummary>({ text: "" });
  useTileSummary(props.onSummary, hidden ? { text: "" } : due);
  // Here rather than inside: it reminds while spDEX is open, folded or not.
  const reminder = useProofLapseNotifications(props.chainId, props.account);
  if (inTile) {
    return (
      <div hidden={hidden}>
        <section className="spdex-subpanel" data-testid="help-run-panel">
          <h3 className="spdex-subpanel__title">Help run the network</h3>
          {opened ? <HelpRunNetwork {...props} onSummary={setDue} reminder={reminder} /> : null}
        </section>
      </div>
    );
  }
  return (
    <div hidden={hidden}>
      <FoldedPanel
        title="Help run the network"
        testId="help-run-panel"
        foldTestId="help-run-open"
        onToggle={(open) => {
          if (open) setOpened(true);
        }}
      >
        {opened ? <HelpRunNetwork {...props} reminder={reminder} /> : null}
      </FoldedPanel>
    </div>
  );
}

export function HelpRunNetwork(props: HelpRunNetworkProps) {
  const { engine, chainId, account, walletChainOk, submitter, pricing, ownerLock, provider, reminder } = props;
  const [batcherThere, setBatcherThere] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const asked = useRef(0);
  // The "≈" beside the fees needs rates only while a batch is on offer.
  useRatesNeeded(pricing, phase.kind === "planned" && phase.plan.kind === "offer");

  // Whether the batcher exists on this network: one request, naming nobody.
  useEffect(() => {
    let cancelled = false;
    setBatcherThere(null);
    engine
      .rpc("eth_getCode", [engine.vaultBatcher, "latest"])
      .then((code) => {
        if (!cancelled) setBatcherThere(typeof code === "string" && code !== "0x" && code.length > 2);
      })
      .catch(() => {
        if (!cancelled) setBatcherThere(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  // A new account, chain or service starts again: what was checked was someone else's.
  useEffect(() => {
    asked.current += 1;
    setPhase((current) => (current.kind === "sending" || current.kind === "sent" ? current : { kind: "idle" }));
  }, [account, chainId, engine]);
  useTileSummary(props.onSummary, helpRunSummary(phase));

  if (account === null || !walletChainOk) return null;

  // A proof needs neither the batcher nor private sending: Community keeping
  // shows whatever Help run itself can offer, closed, reading nothing.
  const keeping = (
    <CommunityKeeping
      engine={engine}
      chainId={chainId}
      account={account}
      submitter={submitter}
      {...(ownerLock === undefined ? {} : { ownerLock })}
      {...(reminder === undefined ? {} : { reminder })}
      {...(provider === undefined ? {} : { provider })}
    />
  );

  // The panel is open, so it says why it offers nothing rather than showing only its title.
  if (batcherThere !== true) {
    return (
      <>
        {batcherThere === null ? (
          <p className="spdex-field__hint" data-testid="help-run-looking">
            Looking for the vault batcher on {networkName(chainId)}…
          </p>
        ) : (
          <p className="spdex-network-line" data-testid="help-run-no-batcher">
            spDEX can't find the vault batcher on {networkName(chainId)}, so there are no vault buys to make from here.
          </p>
        )}
        {keeping}
      </>
    );
  }

  if (submitter.mode !== "private") {
    return (
      <div className="spdex-helprun" data-testid="help-run">
        <p className="spdex-network-line" data-testid="help-run-public">
          {PUBLIC_SENDING_TEXT}
        </p>
        <p className="spdex-field__hint" data-testid="help-run-public-where">
          <GoTo place="sending">Turn it on</GoTo>
        </p>
        {keeping}
      </div>
    );
  }

  const check = async (only: ReadonlySet<string> | null, known: CheckedDue | null) => {
    const ticket = ++asked.current;
    setPhase({ kind: "checking" });
    try {
      const block = await latestBlock(engine.rpc);
      const read =
        known?.all ?? (await readDueCandidates(engine.rpc, await loadPlatform(engine.rpc, chainId), { block, factory: engine.vaultFactory }));
      // Each vault's claim, which the Guard proves it by: a vault none is found
      // for is never offered, since the batch would be refused for it.
      const claims =
        known?.claims ?? (await claimsOf(engine.rpc, read, { release: releaseOfFactory(engine.vaultFactory) ?? LATEST_RELEASE, block }));
      const all = read.filter((c) => claims.has(lower(c.vault)));
      // Whether this wallet may be paid inside a window, at the same block as
      // the buys: read only when a buy is inside its window.
      const holder =
        known !== null
          ? known.holder
          : needsEligibility(all)
            ? await readHolderStatus(engine.rpc, account, { registry: engine.vaultRegistry, block }).catch(() => null)
            : null;
      const readAtMs = known?.readAtMs ?? Date.now();
      const split = splitByWindow(all, eligibleInNextBlock(holder), account);
      const heldBack = split.until === null ? null : { count: split.heldBack.length, until: split.until, byTurn: split.byTurn };
      // The price the batch is signed at, with a tip a builder will take: the
      // fees it must cover are worked out at this price and no other.
      const [gasPrice, balanceRaw] = await Promise.all([
        privateGasPrice(engine.rpc),
        engine.rpc("eth_getBalance", [account, "latest"]),
      ]);
      const balance = quantity(balanceRaw);
      if (balance === null) throw new Error("the network service didn't give your balance");
      const due = split.offered;
      const plan = await planHelpRun({ rpc: engine.rpc, account, batcher: engine.vaultBatcher, due, gasPrice, balance, only, heldBack });
      let verdict: GuardVerdict | null = null;
      if (plan.kind === "offer") verdict = (await engine.checkVaultBatch(batchIntent(plan, account, chainId, claims))).verdict;
      if (ticket !== asked.current) return;
      const ticked = new Set(plan.kind === "offer" ? plan.vaults.map((v) => lower(v.vault)) : (only ?? []));
      setPhase({ kind: "planned", plan, due, heldBack, checked: { all, claims, holder, readAtMs }, verdict, ticked });
    } catch (error) {
      if (ticket !== asked.current) return;
      setPhase({ kind: "failed", text: `Couldn't check the due buys (${error instanceof Error ? error.message : String(error)}).` });
    }
  };

  const send = async (offer: Extract<HelpRunPlan, { kind: "offer" }>, planned: Planned) => {
    if (ownerLock !== undefined && !ownerLock.tryAcquire()) {
      setPhase({ kind: "stopped", text: "Your wallet is busy with another request. Try again when it finishes." });
      return;
    }
    const intent = batchIntent(offer, account, chainId, planned.checked.claims);
    const vaults = intent.vaults;
    try {
      setPhase({ kind: "sending", text: "Running the safety check again…" });
      // Again, now: the offer was checked a moment ago, and the chain moves.
      const { plan, verdict } = await engine.checkVaultBatch(intent);
      if (!verdict.signable || verdict.level !== "verified") {
        setPhase({ ...planned, plan: offer, verdict, ticked: new Set(vaults) });
        return;
      }
      const call = plan.calls[0]!;
      setPhase({ kind: "sending", text: "Confirm in your wallet…" });
      const sender = walletSender({
        submitter,
        account,
        // Never public: a batch sent publicly is copied and taken first.
        onPublicFallback: () => false,
        reads: engine.rpc,
        ...(provider === undefined ? {} : { provider }),
      });
      const sent = await sender.send({ to: call.to, data: call.data, value: call.value, chainId, gas: call.gas, gasPrice: call.gasPrice });
      setPhase({ kind: "sent", hash: sent.hash, result: null, plan: offer, recorded: false });
      // This wallet's own vaults in the batch (a buy past its window is
      // anyone's, its owner's too): their fees come back to it, not as earnings.
      const owned = planned.due.filter((c) => lower(c.owner) === lower(account)).map((c) => lower(c.vault));
      const settled = await waitForBatch(
        engine.rpc,
        { hash: sent.hash, batcher: engine.vaultBatcher, vaults, owned },
        { timeoutMs: PRIVATE_CONFIRM_TIMEOUT_MS },
      );
      const result = settled?.result ?? null;
      let recorded = false;
      if (settled !== null) {
        const row = await recordBuyFeesEarned({
          rpc: engine.rpc,
          chainId,
          account,
          receipt: settled.receipt,
          // Other people's fees only: an own vault's buy row counts its fee as paid back.
          earned: feesEarnedFromOthers(settled.result),
          // The buy fees are paid in the vaults' own WETH, the factory's.
          weth: lower(MAINNET_DEPLOYMENT.weth),
          pricing,
        });
        recorded = row?.saved === true;
      }
      setPhase({ kind: "sent", hash: sent.hash, result, plan: offer, recorded });
    } catch (error) {
      if (error instanceof PrivateSubmissionUnavailable) setPhase({ kind: "stopped", text: CANT_SIGN_PRIVATELY_TEXT });
      else if (isUserRejection(error)) setPhase({ kind: "stopped", text: "Cancelled in your wallet. Nothing was sent." });
      else setPhase({ kind: "stopped", text: `It didn't go out (${error instanceof Error ? error.message : String(error)}).` });
    } finally {
      ownerLock?.release();
    }
  };

  return (
    <div className="spdex-helprun" data-testid="help-run">
      <Body
        phase={phase}
        chainId={chainId}
        rpc={engine.rpc}
        relayUrl={submitter.url}
        pricing={pricing}
        onCheck={() => void check(null, null)}
        onTicks={(ticked, checked) => void check(ticked, checked)}
        onSend={(offer, planned) => void send(offer, planned)}
      />
      {keeping}
    </div>
  );
}

function Body({
  phase,
  chainId,
  rpc,
  relayUrl,
  pricing,
  onCheck,
  onTicks,
  onSend,
}: {
  phase: Phase;
  chainId: number;
  rpc: JsonRpc;
  relayUrl: string | null;
  pricing: Pricing | null;
  onCheck: () => void;
  onTicks: (ticked: ReadonlySet<string>, checked: CheckedDue) => void;
  onSend: (offer: Extract<HelpRunPlan, { kind: "offer" }>, planned: Planned) => void;
}) {
  const money = moneyView(pricing, perfNow());
  switch (phase.kind) {
    case "idle":
    case "failed":
    case "stopped":
      return (
        <>
          <p className="spdex-network-line">
            Make other vaults&apos; due buys in one transaction: you pay the network fee, you earn their buy fees.
          </p>
          {phase.kind === "failed" || phase.kind === "stopped" ? (
            <p className="spdex-network-warn" data-testid="help-run-note">
              {phase.text}
            </p>
          ) : null}
          <div className="spdex-actions">
            <Button variant="ghost" testId="help-run-check" onClick={onCheck}>
              See which buys are due
            </Button>
          </div>
          <p className="spdex-field__hint">Checking only test-runs it, through your network service. Nothing is sent.</p>
        </>
      );
    case "checking":
      return (
        <p className="spdex-field__hint" data-testid="help-run-checking">
          Looking for due vault buys, and test-running them…
        </p>
      );
    case "planned":
      return <Planned phase={phase} money={money} relayUrl={relayUrl} onCheck={onCheck} onTicks={onTicks} onSend={onSend} />;
    case "sending":
      return (
        <p className="spdex-field__hint" data-testid="help-run-sending" role="status">
          {phase.text}
        </p>
      );
    case "sent":
      return <Sent phase={phase} chainId={chainId} rpc={rpc} onCheck={onCheck} />;
  }
}

function Planned({
  phase,
  money,
  relayUrl,
  onCheck,
  onTicks,
  onSend,
}: {
  phase: Extract<Phase, { kind: "planned" }>;
  money: ReturnType<typeof moneyView>;
  relayUrl: string | null;
  onCheck: () => void;
  onTicks: (ticked: ReadonlySet<string>, checked: CheckedDue) => void;
  onSend: (offer: Extract<HelpRunPlan, { kind: "offer" }>, planned: Planned) => void;
}) {
  const { plan, due, verdict, ticked } = phase;
  const again = (
    <div className="spdex-actions">
      <Button variant="ghost" testId="help-run-check" onClick={onCheck}>
        Check again
      </Button>
    </div>
  );
  const list =
    due.length > 0 ? (
      <VaultList due={due} ticked={ticked} onChange={(next) => onTicks(next, phase.checked)} />
    ) : null;
  // Due buys this wallet can't be paid for yet, beside the ones it can: said,
  // never offered, and after the offer, its terms and its button, which read
  // as one unit.
  const held =
    phase.heldBack !== null && plan.kind !== "holders-first" ? (
      <HoldersFirst
        until={phase.heldBack.until}
        alongside={phase.heldBack.count}
        byTurn={phase.heldBack.byTurn}
        holder={phase.checked.holder}
        readAtMs={phase.checked.readAtMs}
      />
    ) : null;

  switch (plan.kind) {
    case "none-due":
      return (
        <>
          <p className="spdex-network-line" data-testid="help-run-none">
            {NONE_DUE_TEXT}
          </p>
          <p className="spdex-network-line spdex-network-line--quiet">{KEEPER_TEXT}</p>
          {again}
        </>
      );
    case "not-covered":
      return (
        <>
          {plan.due === 0 ? (
            // Every box unticked: there is no batch to cost, not a batch that costs too much.
            <p className="spdex-network-line" data-testid="help-run-none-ticked">
              No vault is ticked. Tick one to see whether its buy fee covers the network fee.
            </p>
          ) : (
            <p className="spdex-network-line" data-testid="help-run-not-covered">
              {notCoveredText(plan.due, plan.fees, plan.cost)}
            </p>
          )}
          {list}
          {again}
          {held}
        </>
      );
    case "none-would-buy":
      return (
        <>
          <p className="spdex-network-line" data-testid="help-run-none">
            {noneWouldBuyText(plan.reasons)}
          </p>
          {list}
          {again}
          {held}
        </>
      );
    case "holders-first":
      // Every due buy is inside its window, and this wallet can't be paid there: no batch, and no button.
      return (
        <>
          <HoldersFirst
            until={plan.until}
            alongside={null}
            byTurn={phase.heldBack?.byTurn ?? 0}
            holder={phase.checked.holder}
            readAtMs={phase.checked.readAtMs}
          />
          {again}
        </>
      );
    case "needs-balance":
      return (
        <>
          <p className="spdex-network-warn" data-testid="help-run-balance">
            {needsBalanceText(plan.need, plan.fee, plan.balance)}
          </p>
          {list}
          {again}
          {held}
        </>
      );
    case "failed":
      return (
        <>
          <p className="spdex-network-warn" data-testid="help-run-note">
            Couldn't test-run the batch ({plan.reason}).
          </p>
          {again}
          {held}
        </>
      );
    case "offer": {
      const fee = plan.gasUsed * plan.gasPrice;
      const signable = verdict !== null && verdict.signable && verdict.level === "verified";
      return (
        <>
          <p className="spdex-network-line" data-testid="help-run-intro">
            {introText(plan.vaults.length, ticked.size, ticked.size === due.length)}
          </p>
          <div className="spdex-helprun__pair">
            <div className="spdex-helprun__side">
              <span className="spdex-helprun__label">You pay</span>
              <span className="spdex-helprun__value" data-testid="help-run-pay">
                {youPayText(fee, money)}
              </span>
            </div>
            <div className="spdex-helprun__side">
              <span className="spdex-helprun__label">You get</span>
              <span className="spdex-helprun__value" data-testid="help-run-get">
                {youGetText(plan.earned, money)}
              </span>
            </div>
          </div>
          <div className="spdex-helprun__side spdex-helprun__side--wide">
            <span className="spdex-helprun__label">If someone makes them first</span>
            <span className="spdex-helprun__value" data-testid="help-run-first">
              {IF_FIRST_TEXT} {ifFirstRelayText(relayUrl)}
            </span>
          </div>
          {list}
          <p className="spdex-field__hint" data-testid="help-run-wallet-fee">
            {walletFeeText(plan.gasLimit * plan.gasPrice)}
          </p>
          <p className="spdex-field__hint" data-testid="help-run-terms">
            {TERMS_TEXT}
          </p>
          {verdict !== null && !signable ? <Refusal verdict={verdict} /> : null}
          <div className="spdex-actions">
            {signable ? (
              <Button testId="help-run-send" onClick={() => onSend(plan, phase)}>
                {buttonText(plan.vaults.length)}
              </Button>
            ) : null}
            <Button variant="ghost" testId="help-run-check" onClick={onCheck}>
              Check again
            </Button>
          </div>
          {held}
        </>
      );
    }
  }
}

/**
 * Due buys inside their community window that this wallet can't be paid
 * for: when SPX holders' first claim ends (on its own, or after how many are
 * held back beside an offer), why this wallet isn't one of them — or, for an
 * eligible wallet, that those buys are another group's turn (`byTurn`) — and
 * what community keeping is, with a link where the build names its source.
 * No button: those buys are not offered (decision 23).
 *
 * `until` is chain time. It is shown on this device's clock, as the vault
 * card shows a window's end (`deviceTimeOf`): moved by the gap between the
 * standing's block time and `readAtMs`, when both are known. A local fork's
 * clock runs days behind.
 */
export function HoldersFirst({
  until,
  alongside,
  byTurn = 0,
  holder,
  readAtMs,
}: {
  until: bigint;
  alongside: number | null;
  byTurn?: number;
  holder: HolderStatus | null;
  readAtMs?: number;
}) {
  const turns = turnHeldText(byTurn);
  const docs = keeperDocsUrl();
  const chainNow = holder?.chainTime ?? null;
  const shown = chainNow === null || readAtMs === undefined ? until : BigInt(deviceTimeOf(Number(until), Number(chainNow), readAtMs));
  return (
    <div data-testid="help-run-holders-first">
      <p className="spdex-network-line" data-testid="help-run-first-claim">
        {holdersFirstText(shown, alongside)}
      </p>
      <p className="spdex-network-line" data-testid="help-run-standing">
        {walletKeeperText(holder)}
      </p>
      {turns !== null ? (
        <p className="spdex-network-line" data-testid="help-run-turns">
          {turns}
        </p>
      ) : null}
      <p className="spdex-network-line spdex-network-line--quiet" data-testid="help-run-keeping">
        {COMMUNITY_KEEPING_TEXT}{" "}
        {docs !== null ? (
          <a href={docs} target="_blank" rel="noreferrer noopener" data-testid="help-run-keeping-docs">
            {KEEPER_DOCS_LINK_TEXT}
          </a>
        ) : null}
      </p>
    </div>
  );
}

/** The safety check's refusal, sentence by sentence, with each code for anyone who wants it. */
function Refusal({ verdict }: { verdict: GuardVerdict }) {
  const items = uniqueByCode([...verdict.violations, ...verdict.warnings]);
  return (
    <div className="spdex-network-warn" data-testid="help-run-refused" role="alert">
      The safety check won&apos;t let this batch be sent:
      <ul className="spdex-helprun__reasons">
        {items.map((item) => (
          <li key={item.code} data-testid={`violation-${item.code}`}>
            {item.code === "SECOND_OPINION_UNAVAILABLE" ? secondOpinionRefusalText("batch") : guardSentence(item.code, item.detail)}{" "}
            <code className="spdex-code-tag">{item.code}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every due buy with its fee, and no owner: ticked, the ones the batch makes. */
function VaultList({
  due,
  ticked,
  onChange,
}: {
  due: readonly DueCandidate[];
  ticked: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const sorted = useMemo(() => [...due].sort((a, b) => (a.amountPerBuy === b.amountPerBuy ? 0 : a.amountPerBuy < b.amountPerBuy ? -1 : 1)), [due]);
  return (
    <details className="spdex-disclosure spdex-helprun__vaults" data-testid="help-run-vaults">
      <summary className="spdex-disclosure__summary" data-testid="help-run-vaults-summary">
        Which vaults ({ticked.size} of {due.length} due)
      </summary>
      <div className="spdex-disclosure__body">
        <ul className="spdex-helprun__list">
          {sorted.map((c) => {
            const key = lower(c.vault);
            const shown = checksumAddress(c.vault);
            return (
              <li key={key}>
                <label className="spdex-helprun__vault">
                  <input
                    type="checkbox"
                    data-testid={`help-run-vault-${key}`}
                    checked={ticked.has(key)}
                    aria-label={`Make the buy for vault ${shown}`}
                    onChange={() => {
                      const next = new Set(ticked);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      onChange(next);
                    }}
                  />
                  <code title={shown}>{shortAddress(shown)}</code>
                  <span className="spdex-helprun__fee">{ethText(c.reward)} WETH buy fee</span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="spdex-field__hint">Unticking one asks again which of the rest pay for themselves.</p>
      </div>
    </details>
  );
}

function Sent({
  phase,
  chainId,
  rpc,
  onCheck,
}: {
  phase: Extract<Phase, { kind: "sent" }>;
  chainId: number;
  rpc: JsonRpc;
  onCheck: () => void;
}) {
  const { hash, result } = phase;
  return (
    <div data-testid="help-run-result">
      <p className="spdex-network-line spdex-network-line--strong" data-testid="help-run-result-text" role="status">
        {result === null ? "Sent. Waiting for it to be included…" : resultText(result)}
      </p>
      <p className="spdex-network-line">
        {/* Started afresh once the result is read, so it reads the receipt now
            rather than on its next 12-second look, and never says "waiting to
            be included" beside a result that was read from that receipt. */}
        <FinalityBadge key={result === null ? "sent" : "settled"} rpc={rpc} chainId={chainId} hash={hash} testId="help-run-finality" />{" "}
        <TxRef chainId={chainId} hash={hash} testId="help-run-tx" />
      </p>
      {result !== null && result.untriggered.length > 0 ? (
        <ul className="spdex-helprun__reasons" data-testid="help-run-untriggered">
          {result.untriggered.map((u) => (
            <li key={u.vault}>
              <CopyHex value={checksumAddress(u.vault)} what="vault's address" />: not made ({u.reason})
            </li>
          ))}
        </ul>
      ) : null}
      <div className="spdex-actions">
        <Button variant="ghost" testId="help-run-check" onClick={onCheck}>
          See which buys are due now
        </Button>
      </div>
    </div>
  );
}
