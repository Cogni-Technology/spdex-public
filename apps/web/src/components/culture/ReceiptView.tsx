/**
 * The `#receipt=` view: what the chain says one transaction did with SPX,
 * read through the viewer's own network service.
 *
 * It exists so a card can be checked by someone who has no reason to trust
 * it. So it reads the transaction itself and says only what the chain shows
 * (lib/culture/receipt.ts decides what counts as bought), and it says what it
 * can't show: who made the card. The service it reads through learns which
 * transaction was looked up, and the view says that too.
 *
 * In a tile (`open` defined, "Shared transaction") it drops its own panel and
 * title, and the header's summary is the transaction's short hash.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { Banner, Button, Panel } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Address } from "@spdex/core";
import { checksumAddress } from "../../lib/culture/contract.js";
import { cardAmount } from "../../lib/culture/card.js";
import {
  receiptFromUrl,
  sourceText,
  spxPoolsFrom,
  verifyReceipt,
  type PoolFinder,
  type ReceiptOutcome,
  type ReceiptTarget,
  type SpxPool,
} from "../../lib/culture/receipt.js";
import { shortAddress } from "../../lib/dca/format.js";
import { explorerUrl } from "../../lib/dca/view.js";
import type { TilePanelProps } from "../../lib/tiles.js";
import { CopyButton, InfoTerm } from "../dca/common.js";
import { useTileSummary } from "../dca/tilePanel.js";
import { networkName } from "../../lib/networks.js";
import { clearUrlFragment } from "../../lib/store.js";
import { formatAmount } from "../../lib/tokens.js";
import { FinalityBadge } from "../trust/FinalityBadge.js";
import { GroupedHex } from "./ContractBadge.js";
import "./culture.css";

/**
 * A `#receipt=` link: a transaction someone shared ("I bought" card), to be
 * checked against the chain through this person's own network service.
 *
 * Kept in the address bar while its view is open, so a reload shows it
 * again, and read again on `hashchange`: pasting a link into an open tab
 * doesn't reload it. `cameFor` says the visit opened with one, so nothing
 * else (the Features dialog) opens over it.
 */
export function useReceiptLink(): { target: ReceiptTarget | null; cameFor: boolean; close(): void } {
  const [target, setTarget] = useState<ReceiptTarget | null>(() => receiptFromUrl(window.location.hash));
  const [cameFor] = useState(target !== null);
  useEffect(() => {
    const check = () => {
      const shared = receiptFromUrl(window.location.hash);
      if (shared !== null) setTarget(shared);
    };
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  const close = useCallback(() => {
    setTarget(null);
    if (receiptFromUrl(window.location.hash) !== null) clearUrlFragment();
  }, []);
  return { target, cameFor, close };
}

export interface ReceiptViewProps extends TilePanelProps {
  target: ReceiptTarget;
  /** The viewer's own network service: the only source this view believes. */
  rpc: JsonRpc;
  configChainId: number;
  /**
   * What finds the pools spDEX trades SPX on (the Engine): the only senders
   * whose SPX, paid out in their own swaps, counts as bought from a market.
   */
  finder: PoolFinder;
  /** The vault factory on this chain, or null where there is none; only its word makes a sender a vault. */
  factory: Address | null;
  onClose(): void;
}

type ViewState = { kind: "reading" } | { kind: "read"; outcome: ReceiptOutcome } | { kind: "error"; reason: string };

export function ReceiptView({ target, rpc, configChainId, finder, factory, onClose, open, onSummary }: ReceiptViewProps): JSX.Element {
  useTileSummary(onSummary, { text: shortAddress(target.hash) });
  const otherChain = target.chainId !== configChainId;
  const [state, setState] = useState<ViewState>({ kind: "reading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // Found once per finder (discovery is cached per pair on the Engine), and
  // found again for another network service's.
  const [spxPools, setSpxPools] = useState<{ finder: PoolFinder; pools: SpxPool[] } | null>(null);
  useEffect(() => {
    if (otherChain) return;
    let live = true;
    void spxPoolsFrom(finder).then((pools) => live && setSpxPools({ finder, pools }));
    return () => {
      live = false;
    };
  }, [finder, otherChain]);
  const pools = spxPools !== null && spxPools.finder === finder ? spxPools.pools : null;

  useEffect(() => {
    if (otherChain || pools === null) return;
    let live = true;
    setState({ kind: "reading" });
    verifyReceipt(rpc, { hash: target.hash, spxPools: pools, factory }).then(
      (outcome) => live && setState({ kind: "read", outcome }),
      (error: unknown) => live && setState({ kind: "error", reason: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, target.hash, pools, factory, otherChain, attempt]);

  const explorer = explorerUrl(target.chainId, target.hash);
  const body = (
    <>
      <p className="spdex-receipt__lede">
        What the chain says, read through your network service, not from the card. It can&apos;t show who made the card.
        <InfoTerm tip="Your network service sees which transaction you looked up." label="Privacy" />
      </p>

      <div className="spdex-receipt__tx">
        <span className="spdex-field__label">Transaction on {networkName(target.chainId)}</span>
        <div className="spdex-receipt__hashrow">
          <GroupedHex value={target.hash} testId="receipt-hash" />
          <CopyButton text={target.hash} testId="receipt-copy" />
        </div>
      </div>

      {otherChain ? (
        <Banner tone="warn" title="Another network" testId="receipt-other-chain">
          <p className="spdex-banner__text">
            This link is for {networkName(target.chainId)}; your network service is on {networkName(configChainId)}.
          </p>
        </Banner>
      ) : state.kind === "reading" ? (
        <p className="spdex-receipt__status" data-testid="receipt-reading">
          Reading the transaction through your network service…
        </p>
      ) : state.kind === "error" ? (
        <Banner tone="warn" title="Couldn't read it" testId="receipt-error">
          <p className="spdex-banner__text">Your network service didn&apos;t answer: {state.reason}</p>
          <div className="spdex-actions">
            <Button variant="ghost" testId="receipt-retry" onClick={retry}>
              Try again
            </Button>
          </div>
        </Banner>
      ) : (
        <Outcome outcome={state.outcome} rpc={rpc} target={target} />
      )}

      <div className="spdex-actions spdex-receipt__actions">
        <Button variant="ghost" testId="receipt-close" onClick={onClose}>
          Close
        </Button>
        {explorer !== null ? (
          <a href={explorer} target="_blank" rel="noreferrer noopener" data-testid="receipt-explorer">
            Look it up on Etherscan ↗
          </a>
        ) : null}
      </div>
    </>
  );
  return open !== undefined ? (
    <section className="spdex-receipt" data-testid="receipt-view">
      {body}
    </section>
  ) : (
    <Panel title="What the chain says about this transaction" testId="receipt-view">
      {body}
    </Panel>
  );
}

function Outcome({ outcome, rpc, target }: { outcome: ReceiptOutcome; rpc: JsonRpc; target: ReceiptTarget }) {
  if (outcome.kind === "unknown") {
    return (
      <p className="spdex-receipt__status" data-testid="receipt-outcome" data-outcome="unknown">
        Your network service doesn&apos;t know this transaction.
      </p>
    );
  }
  if (outcome.kind === "failed") {
    return (
      <div data-testid="receipt-outcome" data-outcome="failed">
        <p className="spdex-receipt__status">This transaction failed, so it delivered nothing.</p>
        <BlockLine verb="Failed" block={outcome.block} time={outcome.time} />
      </div>
    );
  }
  if (outcome.kind === "no-spx") {
    return (
      <div data-testid="receipt-outcome" data-outcome="no-spx">
        <p className="spdex-receipt__status">This transaction delivered no SPX.</p>
        <BlockLine verb="Succeeded" block={outcome.block} time={outcome.time} />
      </div>
    );
  }
  return (
    <div data-testid="receipt-outcome" data-outcome="delivered">
      <ul className="spdex-receipt__deliveries">
        {outcome.deliveries.map((delivery) => (
          <li key={`${delivery.to}:${delivery.source.kind}`} className="spdex-receipt__delivery" data-testid="receipt-delivery" data-source={delivery.source.kind}>
            <span className="spdex-receipt__amount" data-testid="receipt-amount">
              {cardAmount(delivery.amount)}
            </span>
            <span className="spdex-receipt__exact">exactly {formatAmount(delivery.amount, 8, { maxFraction: 8 })} SPX</span>
            <span className="spdex-receipt__to">
              to <code>{checksumAddress(delivery.to)}</code>
            </span>
            <span className="spdex-receipt__source" data-testid="receipt-source">
              {capitalised(sourceText(delivery.source))}.
            </span>
          </li>
        ))}
      </ul>
      {outcome.vaults === "unavailable" ? (
        <p className="spdex-field__hint" data-testid="receipt-vaults-unread">
          spDEX couldn&apos;t ask the vault factory about this transaction just now, so no delivery is credited to a vault.
        </p>
      ) : null}
      <BlockLine verb="Succeeded" block={outcome.block} time={outcome.time} />
      <FinalityBadge rpc={rpc} chainId={target.chainId} hash={target.hash} />
    </div>
  );
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function BlockLine({ verb, block, time }: { verb: "Succeeded" | "Failed"; block: bigint; time: number | null }) {
  return (
    <p className="spdex-receipt__block" data-testid="receipt-block">
      {verb} in block {formatAmount(block, 0)}
      {time === null ? null : <> · {blockTime(time)}</>}
    </p>
  );
}

/** "Sep 17, 2026, 21:49 UTC": the block's own time, in UTC, as the card prints its date. */
function blockTime(unix: number): string {
  const text = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(unix * 1000));
  return `${text} UTC`;
}
