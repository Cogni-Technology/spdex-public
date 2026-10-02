/**
 * SERVICE: the status widget. What the page is connected to and how that is
 * going, built from real reads only.
 *
 * - The title bar says the link's state as a word and a glyph (● ONLINE,
 *   ▲ SLOW, ✕ OFFLINE, ○ NO SERVICE), so colour is never the only signal.
 * - NET, BLOCK, WALLET and, with plans, PLANS; the rest under DETAILS.
 * - The block is read once on load, on a service change, when the browser
 *   comes back online and on ↻ (lib/chainHead.ts). No poll and no clock: the
 *   time shown is when the block was read, and nothing here updates itself
 *   for display's sake.
 * - The service's address is masked (lib/rpcDisplay.ts): API keys ride in
 *   endpoint URLs, and screenshots of a status panel travel. SHOW reveals it
 *   until DETAILS closes.
 *
 * On a phone it is one bar (`status-bar`) that expands the same list under
 * it: the list is rendered once, and the stylesheet decides where it shows.
 *
 * It holds the page's one polite live region (`status-live`), which says
 * only a few things: the service going offline and coming back, a buy
 * falling due, and the view switching to Expert to show something.
 *
 * Test ids kept from the status strip it replaces: `account-label`,
 * `chain-name`, `chain-label`, `rpc-label`, `strip-safety`, `preset-label`,
 * `strip-details`, `strip-dca`.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Disclosure, Term } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { SpdexConfig } from "@spdex/core";
import { blockText, finalText, LINK_WORDS, useChainHead, type LinkState } from "../../lib/chainHead.js";
import { formatCount } from "../../lib/money/format.js";
import { GLOSSARY } from "../../lib/names.js";
import { networkName } from "../../lib/networks.js";
import { maskRpcUrl, rpcUrlMasked } from "../../lib/rpcDisplay.js";
import type { SecondOpinionStatus } from "../../lib/simulation.js";
import { safetyTestText, secondOpinionStripText, type SafetyTest } from "../../lib/summary.js";
import { CopyHex } from "../dca/common.js";

/** Where the widget hears about the second opinion: the Engine. */
export interface SecondOpinionSource {
  secondOpinionStatus(): SecondOpinionStatus;
  subscribeSecondOpinion(listener: () => void): () => void;
}

const OFF: SecondOpinionStatus = { kind: "off" };

/** The second opinion's status, kept current; "off" without a source. */
function useSecondOpinion(source: SecondOpinionSource | null | undefined): SecondOpinionStatus {
  const subscribe = useCallback((listener: () => void) => source?.subscribeSecondOpinion(listener) ?? (() => {}), [source]);
  const read = useCallback(() => source?.secondOpinionStatus() ?? OFF, [source]);
  return useSyncExternalStore(subscribe, read, read);
}

/** CHECK: whether swaps are test-run before signing, and on how many services. */
export function checkText(safety: SafetyTest, second: SecondOpinionStatus): string {
  switch (safety) {
    case "checking":
      return "…";
    case "unknown":
      return "unknown";
    case "unavailable":
      return "off";
    case "available":
      return second.kind === "on" && second.last !== "unavailable" ? "on ×2" : "on";
  }
}

/** "0x7099…79C8", as the strip always wrote it. */
export function shortAccount(account: string): string {
  return `${account.slice(0, 6)}…${account.slice(-4)}`;
}

export interface StatusWidgetProps {
  config: SpdexConfig;
  /** The engine's RPC, or null before a service is chosen. */
  rpc: JsonRpc | null;
  secondOpinion: SecondOpinionSource | null;
  account: `0x${string}` | null;
  onConnect: () => void;
  safety: SafetyTest;
  /** The auto-buy line, or null with no plans; `buyDue` makes it BUY DUE; `onOpen` goes to the plans. */
  plans: { text: string | null; buyDue: boolean; onOpen: () => void };
  /** What the live region says now. */
  live: string;
  announce: (message: string) => void;
  locale?: string;
}

function Item({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="spdex-widget__row">
      <dt className="spdex-widget__label">{label}</dt>
      <dd className="spdex-widget__value" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

export function StatusWidget({
  config,
  rpc,
  secondOpinion,
  account,
  onConnect,
  safety,
  plans,
  live,
  announce,
  locale,
}: StatusWidgetProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const head = useChainHead(rpc, detailsOpen);
  const second = useSecondOpinion(secondOpinion);
  const state: LinkState = rpc === null ? "none" : head.view.state;
  const words = LINK_WORDS[state];

  // The live region: offline, and back. Only transitions, never the first state.
  const lastState = useRef<LinkState | null>(null);
  useEffect(() => {
    const was = lastState.current;
    lastState.current = state;
    if (was === null || was === state) return;
    if (state === "offline") announce("Network service offline");
    else if (was === "offline" && state === "online") announce("Network service back online");
  }, [state, announce]);
  const lastDue = useRef(plans.buyDue);
  useEffect(() => {
    if (plans.buyDue && !lastDue.current) announce("Buy due");
    lastDue.current = plans.buyDue;
  }, [plans.buyDue, announce]);

  const url = config.rpc.url;
  const secondText = secondOpinionStripText(second, safety);
  const block = rpc === null ? "—" : blockText(head.view, locale);
  const wallet = account ? shortAccount(account) : "not connected";

  // The state's glyph is drawn, not read: the button's name starts with the
  // word ("Online · Local fork · No wallet"), as the title bar's does.
  const bar: { key: string; text: string; glyph?: string; address?: boolean }[] = [
    { key: "state", glyph: plans.buyDue ? "●" : words.glyph, text: plans.buyDue ? "Buy due" : words.word },
    { key: "net", text: networkName(config.chainId) },
    ...(plans.buyDue || rpc === null
      ? []
      : [{ key: "block", text: head.view.block === null ? block : `#${formatCount(head.view.block)}` }]),
    { key: "wallet", text: account ? shortAccount(account) : "No wallet", address: account !== null },
  ];

  return (
    <aside className="spdex-widget" data-testid="status-widget" data-state={state} aria-label="Status">
      <button
        type="button"
        className="spdex-widget__bar"
        data-testid="status-bar"
        aria-expanded={expanded}
        aria-controls="status-widget-body"
        onClick={() => setExpanded((open) => !open)}
      >
        {bar.map((part) => (
          <span
            key={part.key}
            className={`spdex-widget__bar-part spdex-widget__bar-part--${part.key}${part.address ? " spdex-widget__bar-part--address" : ""}`}
          >
            {part.glyph !== undefined ? (
              <>
                <span aria-hidden="true">{part.glyph}</span>{" "}
              </>
            ) : null}
            {part.text}
          </span>
        ))}
        <span className="spdex-widget__bar-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="spdex-widget__title">
        <span className="spdex-widget__name">Service</span>
        <span className="spdex-widget__state" data-testid="status-state">
          <span aria-hidden="true">{words.glyph}</span> {words.word}
        </span>
      </div>
      <div className="spdex-widget__body" id="status-widget-body" data-expanded={expanded ? "true" : "false"}>
        <dl className="spdex-widget__list">
          <Item label={<Term tip={GLOSSARY.network}>Net</Term>} testId="chain-name">
            {networkName(config.chainId)}
          </Item>
          <Item label="Block" testId="status-block">
            {block}
          </Item>
          <div className="spdex-widget__row">
            <dt className="spdex-widget__label">Wallet</dt>
            <dd className="spdex-widget__value">
              {account !== null ? (
                <CopyHex value={account} what="wallet's address" testId="account-label" />
              ) : (
                <span data-testid="account-label">{wallet}</span>
              )}
              {account === null && rpc !== null ? (
                <button type="button" className="spdex-widget__action" data-testid="status-connect" onClick={onConnect}>
                  Connect
                </button>
              ) : null}
            </dd>
          </div>
          {plans.text !== null ? (
            <div className="spdex-widget__row">
              <dt className="spdex-widget__label">Plans</dt>
              <dd className="spdex-widget__value">
                <button
                  type="button"
                  className={`spdex-widget__link${plans.buyDue ? " spdex-widget__link--due" : ""}`}
                  data-testid="strip-dca"
                  onClick={plans.onOpen}
                >
                  {plans.buyDue ? "Buy due" : plans.text} ›
                </button>
              </dd>
            </div>
          ) : null}
        </dl>
        <Disclosure
          testId="strip-details"
          summary="Details"
          onToggle={(open) => {
            setDetailsOpen(open);
            if (!open) setShowUrl(false);
          }}
        >
          <dl className="spdex-widget__list">
            <Item label="Final" testId="status-final">
              {rpc === null ? "—" : finalText(head.view.block, head.finalized)}
            </Item>
            <Item label="Check" testId="status-safety">
              {checkText(safety, second)}
            </Item>
            <div className="spdex-widget__row">
              <dt className="spdex-widget__label">
                <Term tip={GLOSSARY.networkService}>Service</Term>
              </dt>
              <dd className="spdex-widget__value spdex-widget__value--url">
                <span data-testid="rpc-label">{url === null ? "none" : showUrl ? url : maskRpcUrl(url)}</span>
                {/* Beside the address, not in it: e2e reads rpc-label as the address alone. */}
                {url !== null && config.rpc.source === "bundled" ? <span data-testid="rpc-builtin"> · built-in</span> : null}
                {url !== null && rpcUrlMasked(url) ? (
                  <button
                    type="button"
                    className="spdex-widget__action"
                    data-testid="rpc-show"
                    aria-pressed={showUrl}
                    onClick={() => setShowUrl((shown) => !shown)}
                  >
                    {showUrl ? "Hide" : "Show"}
                  </button>
                ) : null}
              </dd>
            </div>
            {/* The bare number: "my wallet says 1 but spDEX says 690069"
                diagnoses itself. */}
            <Item label="Chain ID" testId="chain-label">
              {config.chainId}
            </Item>
            <Item label="Safety" testId="strip-safety">
              {secondText === null ? safetyTestText(safety) : `${safetyTestText(safety)} · ${secondText}`}
            </Item>
            <Item label="Settings" testId="preset-label">
              {config.preset === "recommended" ? "recommended" : "customised"}
            </Item>
          </dl>
          {rpc !== null ? (
            <button type="button" className="spdex-widget__refresh" data-testid="status-refresh" onClick={head.refresh}>
              <span aria-hidden="true">↻</span> Read now
            </button>
          ) : null}
        </Disclosure>
      </div>
      <p className="spdex-visually-hidden" data-testid="status-live" aria-live="polite">
        {live}
      </p>
    </aside>
  );
}
