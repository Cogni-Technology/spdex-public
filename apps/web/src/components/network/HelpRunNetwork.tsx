/**
 * Help run the network: make other people's due vault buys from this wallet,
 * in one transaction, and be paid their buy fees.
 *
 * A panel of its own, folded to its title (`HelpRunPanel`), for a connected
 * wallet where vaults are offered. Offered only with private sending (a
 * public batch is copied by bots, which take the fees first) and only when
 * the fees cover the network fee at the price that will be signed
 * (lib/network/batch.ts). In plain words: you pay the network fee, you earn
 * their buy fees.
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
import type { VaultBatchTxPlan } from "@spdex/guard";
import {
  MAINNET_DEPLOYMENT,
  checksumAddress,
  latestBlock,
  readDueCandidates,
  type DueCandidate,
} from "@spdex/vault";
import { guardSentence, uniqueByCode } from "../../lib/errors.js";
import { secondOpinionRefusalText } from "../../lib/simulation.js";
import { ethText, shortAddress } from "../../lib/dca/format.js";
import type { OwnerWalletLock } from "../../lib/execute.js";
import type { Pricing } from "../../lib/money/pricing.js";
import { moneyView, useRatesNeeded } from "../../lib/money/rates.js";
import { loadPlatform } from "../../lib/network/platform.js";
import { networkName } from "../../lib/networks.js";
import {
  CANT_SIGN_PRIVATELY_TEXT,
  IF_FIRST_TEXT,
  KEEPER_TEXT,
  NONE_DUE_TEXT,
  PUBLIC_SENDING_TEXT,
  TERMS_TEXT,
  batchIntent,
  buttonText,
  ifFirstRelayText,
  introText,
  needsBalanceText,
  noneWouldBuyText,
  notCoveredText,
  planHelpRun,
  resultText,
  unaccountedText,
  waitForBatch,
  walletFeeText,
  youGetText,
  youPayText,
  type BatchResult,
  type HelpRunPlan,
} from "../../lib/network/batch.js";
import { perfNow } from "../../lib/page.js";
import { quantity } from "../../lib/receipts.js";
import { recordBuyFeesEarned } from "../../lib/records/store.js";
import { walletSender } from "../../lib/senders.js";
import { PrivateSubmissionUnavailable, privateGasPrice } from "../../lib/submit.js";
import { isUserRejection, PRIVATE_CONFIRM_TIMEOUT_MS, type Eip1193Provider } from "../../lib/wallet.js";
import { GoTo } from "../../lib/places.js";
import type { TilePanelProps, TileSummary } from "../../lib/tiles.js";
import { CopyHex, TxRef } from "../dca/common.js";
import { useOpenedOnce, useTileSummary } from "../dca/tilePanel.js";
import { FinalityBadge } from "../trust/FinalityBadge.js";
import "./network.css";

/** What a batch needs from the Engine: its network service, its vault Guard's batcher and factory, and the batch check. */
export interface HelpRunEngine {
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
}

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; text: string }
  | { kind: "planned"; plan: HelpRunPlan; due: readonly DueCandidate[]; verdict: GuardVerdict | null; ticked: ReadonlySet<string> }
  | { kind: "sending"; text: string }
  | { kind: "sent"; hash: Hex; result: BatchResult | null; plan: Extract<HelpRunPlan, { kind: "offer" }>; recorded: boolean }
  | { kind: "stopped"; text: string };

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
  if (inTile) {
    return (
      <div hidden={hidden}>
        <section className="spdex-subpanel" data-testid="help-run-panel">
          <h3 className="spdex-subpanel__title">Help run the network</h3>
          {opened ? <HelpRunNetwork {...props} onSummary={setDue} /> : null}
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
        {opened ? <HelpRunNetwork {...props} /> : null}
      </FoldedPanel>
    </div>
  );
}

export function HelpRunNetwork(props: HelpRunNetworkProps) {
  const { engine, chainId, account, walletChainOk, submitter, pricing, ownerLock, provider } = props;
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

  // The panel is open, so it says why it offers nothing rather than showing only its title.
  if (batcherThere !== true) {
    return batcherThere === null ? (
      <p className="spdex-field__hint" data-testid="help-run-looking">
        Looking for the vault batcher on {networkName(chainId)}…
      </p>
    ) : (
      <p className="spdex-network-line" data-testid="help-run-no-batcher">
        spDEX can't find the vault batcher on {networkName(chainId)}, so there are no vault buys to make from here.
      </p>
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
      </div>
    );
  }

  const check = async (only: ReadonlySet<string> | null, known: readonly DueCandidate[] | null) => {
    const ticket = ++asked.current;
    setPhase({ kind: "checking" });
    try {
      const block = await latestBlock(engine.rpc);
      const due =
        known ?? (await readDueCandidates(engine.rpc, await loadPlatform(engine.rpc, chainId), { block, factory: engine.vaultFactory }));
      // The price the batch is signed at, with a tip a builder will take: the
      // fees it must cover are worked out at this price and no other.
      const [gasPrice, balanceRaw] = await Promise.all([
        privateGasPrice(engine.rpc),
        engine.rpc("eth_getBalance", [account, "latest"]),
      ]);
      const balance = quantity(balanceRaw);
      if (balance === null) throw new Error("the network service didn't give your balance");
      const plan = await planHelpRun({ rpc: engine.rpc, account, batcher: engine.vaultBatcher, due, gasPrice, balance, only });
      let verdict: GuardVerdict | null = null;
      if (plan.kind === "offer") verdict = (await engine.checkVaultBatch(batchIntent(plan, account, chainId))).verdict;
      if (ticket !== asked.current) return;
      const ticked = new Set(plan.kind === "offer" ? plan.vaults.map((v) => lower(v.vault)) : (only ?? []));
      setPhase({ kind: "planned", plan, due, verdict, ticked });
    } catch (error) {
      if (ticket !== asked.current) return;
      setPhase({ kind: "failed", text: `Couldn't check the due buys (${error instanceof Error ? error.message : String(error)}).` });
    }
  };

  const send = async (offer: Extract<HelpRunPlan, { kind: "offer" }>, due: readonly DueCandidate[]) => {
    if (ownerLock !== undefined && !ownerLock.tryAcquire()) {
      setPhase({ kind: "stopped", text: "Your wallet is busy with another request. Try again when it finishes." });
      return;
    }
    const intent = batchIntent(offer, account, chainId);
    const vaults = intent.vaults;
    try {
      setPhase({ kind: "sending", text: "Running the safety check again…" });
      // Again, now: the offer was checked a moment ago, and the chain moves.
      const { plan, verdict } = await engine.checkVaultBatch(intent);
      if (!verdict.signable || verdict.level !== "verified") {
        setPhase({ kind: "planned", plan: offer, due, verdict, ticked: new Set(vaults) });
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
      const settled = await waitForBatch(engine.rpc, { hash: sent.hash, batcher: engine.vaultBatcher, vaults }, { timeoutMs: PRIVATE_CONFIRM_TIMEOUT_MS });
      const result = settled?.result ?? null;
      let recorded = false;
      if (settled !== null) {
        const row = await recordBuyFeesEarned({
          rpc: engine.rpc,
          chainId,
          account,
          receipt: settled.receipt,
          earned: settled.result.earned,
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
        onTicks={(ticked, due) => void check(ticked, due)}
        onSend={(offer, due) => void send(offer, due)}
      />
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
  onTicks: (ticked: ReadonlySet<string>, due: readonly DueCandidate[]) => void;
  onSend: (offer: Extract<HelpRunPlan, { kind: "offer" }>, due: readonly DueCandidate[]) => void;
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
  onTicks: (ticked: ReadonlySet<string>, due: readonly DueCandidate[]) => void;
  onSend: (offer: Extract<HelpRunPlan, { kind: "offer" }>, due: readonly DueCandidate[]) => void;
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
      <VaultList due={due} ticked={ticked} onChange={(next) => onTicks(next, due)} />
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
        </>
      );
    case "unaccounted":
      return (
        <>
          <p className="spdex-network-warn" data-testid="help-run-unaccounted">
            {unaccountedText(plan.swept)}
          </p>
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
        </>
      );
    case "failed":
      return (
        <>
          <p className="spdex-network-warn" data-testid="help-run-note">
            Couldn't test-run the batch ({plan.reason}).
          </p>
          {again}
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
              <Button testId="help-run-send" onClick={() => onSend(plan, due)}>
                {buttonText(plan.vaults.length)}
              </Button>
            ) : null}
            <Button variant="ghost" testId="help-run-check" onClick={onCheck}>
              Check again
            </Button>
          </div>
        </>
      );
    }
  }
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
