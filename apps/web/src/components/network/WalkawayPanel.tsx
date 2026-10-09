/**
 * Trust and exits: how to check this copy of spDEX, and how to do without it.
 *
 * spDEX asks nobody to trust it, so this panel is the part of the app that
 * says how to leave it: every line is something a person can do with only
 * their wallet, a block explorer or a copy of the source. Folded to its title
 * until opened, like the other panels few need on a given visit, and nothing
 * here reads the chain until "Find my vaults from the factories' lists" is
 * pressed.
 *
 * Vault lines appear only where vaults are offered. The addresses in them are
 * printed in full and checksummed, because a shortened address is useless to
 * someone who no longer has spDEX to expand it.
 *
 * In the Settings tile (`open` defined: "Check this build · exits") it drops
 * its fold and title, which the section's summary says, and its two parts
 * open one at a time (group `trust`). A line that names a place in spDEX ends
 * with the button that goes there (`GoTo`).
 */

import { useEffect, useRef, useState } from "react";
import { Brand, Button, Disclosure, FoldedPanel } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Address, SpdexConfig } from "@spdex/core";
import { DEPLOYMENTS, checksumAddress, type OwnerVaults } from "@spdex/vault";
import { factoryListSearchCost, searchVaultsFromFactoryList, type FactoryListSearch } from "../../lib/dca/factoryListSearch.js";
import { vaultDeployment } from "../../lib/dca/vault.js";
import { cardTitle, explorerAddressUrl } from "../../lib/dca/view.js";
import { networkName } from "../../lib/networks.js";
import { cachedPlatformRead, vaultIdentities } from "../../lib/network/platform.js";
import { formatCount } from "../../lib/money/format.js";
import {
  CLOSE_VAULT_CAUTION,
  CLOSE_VAULT_TEXT,
  CLOSE_VAULT_WAYS,
  EXPORT_PLACES,
  EXPORT_TEXT,
  KEEPER_TEXT,
  WALKAWAY_INTRO,
  listSearchHint,
  walkawayLines,
} from "../../lib/network/walkaway.js";
import { GoTo, type PlaceKey } from "../../lib/places.js";
import type { TilePanelProps } from "../../lib/tiles.js";
import { AddressText, CopyButton } from "../dca/common.js";
import { VerifyBuild } from "./VerifyBuild.js";
import "./network.css";

export interface WalkawayPanelProps extends TilePanelProps {
  config: SpdexConfig;
  /** The network service, as `Engine.rpc`; null before one is chosen. */
  rpc: JsonRpc | null;
  chainId: number;
  account: Address | null;
  /** Each finished factory-list search, for the auto-buy panel to add what it found. */
  onVaultsFound?(result: OwnerVaults): void;
}

export { WALKAWAY_INTRO };

/** The places a line points to, each as a button that goes there. */
function Places({ places }: { places: readonly PlaceKey[] | undefined }) {
  if (places === undefined || places.length === 0) return null;
  return (
    <span className="spdex-network-places">
      {places.map((place, index) => (
        // The dot ends the line it closes, never starts the next one.
        <span key={place} className="spdex-nobr">
          <GoTo place={place} />
          {index < places.length - 1 ? "\u00a0·" : null}
        </span>
      ))}
    </span>
  );
}

export function WalkawayPanel({ config, rpc, chainId, account, onVaultsFound, open }: WalkawayPanelProps) {
  const vaultsOffered = vaultDeployment(chainId) !== null;
  const inTile = open !== undefined;
  const parts = (
    <>
      <Disclosure summary="Verify this build" testId="walkaway-verify" group="trust">
        <VerifyBuild />
      </Disclosure>
      <Disclosure summary={<>If <Brand /> disappeared</>} testId="walkaway-exits" group="trust">
        <ul className="spdex-network-list" data-testid="walkaway-list">
          {walkawayLines({ rpcSource: config.rpc.source }).map((line) => (
            <li key={line.id} data-testid={`walkaway-${line.id}`}>
              {line.text} <Places places={line.places} />
            </li>
          ))}
          {vaultsOffered ? (
            <>
              <li data-testid="walkaway-close">
                <p className="spdex-network-line">{CLOSE_VAULT_TEXT}</p>
                <ul className="spdex-network-ways">
                  {CLOSE_VAULT_WAYS.map((way) => (
                    <li key={way}>{way}</li>
                  ))}
                </ul>
                <p className="spdex-network-line spdex-network-line--strong">{CLOSE_VAULT_CAUTION}</p>
                <ConfigVaults config={config} chainId={chainId} />
              </li>
              <li data-testid="walkaway-factory">
                <FactoryLine />
                <VaultSearch rpc={rpc} chainId={chainId} account={account} {...(onVaultsFound ? { onVaultsFound } : {})} />
              </li>
              <li data-testid="walkaway-keeper">{KEEPER_TEXT}</li>
            </>
          ) : (
            <li data-testid="walkaway-no-vaults">Vaults aren't offered on {networkName(chainId)}, so there are none to close or find here.</li>
          )}
          <li data-testid="walkaway-export">
            {EXPORT_TEXT} <Places places={EXPORT_PLACES} />
          </li>
        </ul>
      </Disclosure>
    </>
  );
  return inTile ? (
    <div className="spdex-walkaway" data-testid="walkaway-panel">
      <p className="spdex-panel__subtitle">{WALKAWAY_INTRO}</p>
      {parts}
    </div>
  ) : (
    <FoldedPanel title="Trust and exits" subtitle={WALKAWAY_INTRO} testId="walkaway-panel" foldTestId="walkaway-open">
      {parts}
    </FoldedPanel>
  );
}

/** The vaults this browser's settings name on this chain, each in full, with a way to look it up. */
function ConfigVaults({ config, chainId }: { config: SpdexConfig; chainId: number }) {
  const plans = config.dca.plans.filter((plan) => plan.signer === "vault" && plan.vault !== undefined && plan.chainId === chainId);
  if (plans.length === 0) {
    return <p className="spdex-field__hint">This browser's settings name no vault on {networkName(chainId)}.</p>;
  }
  return (
    <>
      <p className="spdex-network-line">The vaults in this browser's settings:</p>
      <ul className="spdex-network-addresses" data-testid="walkaway-vaults">
        {plans.map((plan) => (
          <li key={plan.id}>
            <span className="spdex-network-addresses__label">{cardTitle(plan)}</span>
            <AddressLine address={plan.vault!} chainId={chainId} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** An address in full, a link to it on an explorer where spDEX can vouch for one, and Copy. */
function AddressLine({ address, chainId, testId }: { address: string; chainId: number; testId?: string }) {
  const shown = checksumAddress(address);
  const page = explorerAddressUrl(chainId, shown);
  return (
    <span className="spdex-network-addressline">
      <AddressText address={shown} {...(testId === undefined ? {} : { testId })} />
      {page !== null ? (
        <a href={page} target="_blank" rel="noreferrer noopener">
          Explorer ↗
        </a>
      ) : null}
      <CopyButton text={shown} />
    </span>
  );
}

function FactoryLine() {
  const factories = DEPLOYMENTS.map((d) => checksumAddress(d.factory));
  return (
    <>
      <p className="spdex-network-line">
        Without spDEX: {factories.length === 1 ? "this factory lists" : "these factories list"} every vault (vaultsPage); each
        vault&apos;s owner() says whose it is.
      </p>
      {factories.map((factory) => (
        <p className="spdex-network-line" key={factory}>
          <span className="spdex-network-addressline">
            <AddressText address={factory} testId="walkaway-factory-address" />
            <CopyButton text={factory} />
          </span>
        </p>
      ))}
    </>
  );
}

type Search =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; result: FactoryListSearch }
  | { kind: "not-deployed" }
  | { kind: "failed"; text: string };

/**
 * "Find my vaults from the factories' lists": every listed vault's owner, v1's
 * and v2's, read and compared here. For network services that cap log
 * searches, where the auto-buy panel's own search stops short.
 */
function VaultSearch({
  rpc,
  chainId,
  account,
  onVaultsFound,
}: {
  rpc: JsonRpc | null;
  chainId: number;
  account: Address | null;
  onVaultsFound?: (result: OwnerVaults) => void;
}) {
  const [search, setSearch] = useState<Search>({ kind: "idle" });
  const current = useRef({ rpc, chainId, account });
  current.current = { rpc, chainId, account };

  // Another account, service or chain: an earlier answer is about someone or somewhere else.
  useEffect(() => setSearch({ kind: "idle" }), [rpc, chainId, account]);

  const known = rpc === null ? null : cachedPlatformRead(rpc);
  // Each factory's list, newest release first, as the search reads them: a page per list.
  const lists = known === null ? null : [...known.deployments].reverse().map((d) => (d.state === "read" ? Number(d.count) : 0));
  const listed = lists === null ? null : lists.reduce((sum, count) => sum + count, 0);
  const cost =
    lists === null || listed === null || rpc === null ? null : factoryListSearchCost(lists, Math.min(listed, vaultIdentities(rpc, chainId).size));
  const blocked = rpc === null ? "Choose a network service first." : account === null ? "Connect a wallet to look for its vaults." : null;

  const run = () => {
    if (rpc === null || account === null) return;
    const asked = { rpc, chainId, account };
    setSearch({ kind: "searching" });
    searchVaultsFromFactoryList(rpc, account, { cache: vaultIdentities(rpc, chainId) }).then(
      (result) => {
        const now = current.current;
        if (now.rpc !== asked.rpc || now.chainId !== asked.chainId || now.account !== asked.account) return;
        if (result === null) {
          setSearch({ kind: "not-deployed" });
          return;
        }
        setSearch({ kind: "done", result });
        onVaultsFound?.(result);
      },
      (error: unknown) => {
        const now = current.current;
        if (now.rpc !== asked.rpc || now.chainId !== asked.chainId || now.account !== asked.account) return;
        const said = error instanceof Error ? error.message : String(error);
        setSearch({ kind: "failed", text: `Couldn't read a factory's list (${said.slice(0, 160).replace(/\.$/, "")}).` });
      },
    );
  };

  return (
    <div className="spdex-network-search" data-testid="vault-search-list">
      <div className="spdex-actions">
        <Button variant="ghost" testId="vault-search-list-run" disabled={blocked !== null || search.kind === "searching"} onClick={run}>
          {search.kind === "searching" ? "Reading the factories' lists…" : "Find my vaults from the factories' lists"}
        </Button>
      </div>
      <p className="spdex-field__hint" data-testid="vault-search-list-hint">
        {blocked ?? listSearchHint(cost)}
      </p>
      <SearchResult search={search} chainId={chainId} />
    </div>
  );
}

function SearchResult({ search, chainId }: { search: Search; chainId: number }) {
  if (search.kind === "not-deployed") {
    return (
      <p className="spdex-network-line" data-testid="vault-search-list-result">
        spDEX&apos;s vault factories aren&apos;t deployed on {networkName(chainId)}, so there are no vaults to find here.
      </p>
    );
  }
  if (search.kind === "failed") {
    return (
      <p className="spdex-network-warn" data-testid="vault-search-list-result">
        {search.text} Nothing is listed rather than a guess.
      </p>
    );
  }
  if (search.kind !== "done") return null;
  const { result } = search;
  const found = result.vaults.length;
  return (
    <div data-testid="vault-search-list-result" data-found={found} data-complete={String(result.complete)}>
      <p className="spdex-network-line">
        {found === 0
          ? `None of the ${formatCount(BigInt(result.searched))} vaults searched on the factories' lists ${result.unreadable === 0 ? "is" : "that could be read is"} owned by the connected wallet.`
          : `${found === 1 ? "1 vault" : `${formatCount(BigInt(found))} vaults`} on the factories' lists ${found === 1 ? "is" : "are"} owned by the connected wallet${found === 1 ? ":" : ", newest first:"}`}
      </p>
      {found > 0 ? (
        <ul className="spdex-network-addresses">
          {result.vaults.map((vault) => (
            <li key={vault}>
              <AddressLine address={vault} chainId={chainId} />
            </li>
          ))}
        </ul>
      ) : null}
      {result.searched < result.listed ? (
        <p className="spdex-network-warn" data-testid="vault-search-list-newest">
          Searched the newest {formatCount(BigInt(result.searched))} of the {formatCount(BigInt(result.listed))} vaults on the
          factories&apos; lists, so an older vault of yours may not be here.
        </p>
      ) : null}
      {result.unreadable > 0 ? (
        <p className="spdex-network-warn" data-testid="vault-search-list-partial">
          {formatCount(BigInt(result.unreadable))} of {formatCount(BigInt(result.searched))} vaults' owners couldn't be read just now, so this may not be all of
          them. Press the button again to retry.
        </p>
      ) : null}
      <p className="spdex-field__hint">Read at block {formatCount(result.block)} through your network service.</p>
    </div>
  );
}
