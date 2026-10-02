/**
 * "Vaults on chain not in your plans": the connected wallet's vaults that no
 * plan here points at.
 *
 * A vault doesn't need spDEX to remember it. It holds its budget and buys
 * whenever triggered, so a card deleted, settings replaced or lost, or a new
 * browser leaves it exactly as it was, and until now left spDEX with no way to
 * show it or close it. The chain remembers: the factory counts each owner's
 * vaults and names them in its logs, and the hook searches those
 * (`searchAccountVaults`). What it finds is listed here.
 *
 * Each is a compact read of a vault plan's card: its pill, its one line, what
 * it holds and how far it has got, and two things to do. "Add back to my
 * plans" gives it its card again, with the plan its own terms describe, and
 * sends nothing, so it is the prominent one; "Close and withdraw" is the same
 * close a plan's card sends, checked by the same vault Guard, and prominent
 * only where a plan card's is too: a finished vault still holding money. The
 * rest of a card (Trigger now, Fund, the history) comes back with the card.
 *
 * When the factory counts vaults the page doesn't show — a plan's vault counts
 * as shown — the section says how many, that each still holds what it held,
 * and what to do about it. Closed vaults with nothing left in them are set
 * apart in one collapsed line.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Disclosure, Pill, Progress, Row, Term } from "@spdex/ui";
import { strayVaultKey, type AutoBuy, type AutoBuyDeps, type StrayVaultsView } from "../../lib/dca/useAutoBuy.js";
import { shortAddress } from "../../lib/dca/format.js";
import { vaultProgress, type FoundVault, type VaultCardStatus, type VaultSearchNote } from "../../lib/dca/vault.js";
import { amountEvery, cardTitle, explorerAddressUrl } from "../../lib/dca/view.js";
import { GoTo } from "../../lib/places.js";
import { localClock } from "../../lib/steps.js";
import { AddressText, CopyButton, DotAfter, Dotted, NoticeBanner } from "./common.js";
import { CloseConfirm, UnauditedBadge, closeLabel, walletBlock } from "./VaultCard.js";
import { closedVaultText, strayVaultLine, VAULT_TIPS, vaultHoldsText, vaultTermsTail } from "./vaultCopy.js";
import { formatCount } from "../../lib/money/format.js";

export function StrayVaults({ autoBuy, deps }: { autoBuy: AutoBuy; deps: AutoBuyDeps }) {
  const view: StrayVaultsView | null = autoBuy.strayVaults;
  const sectionRef = useRef<HTMLElement>(null);
  // A card's notice dismissed: where focus goes once the card has moved (a
  // closed, empty vault joins "Closed vaults") or stayed, rather than to the
  // page, with the OK button gone.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const closedCount = view?.closed.length ?? 0;
  useEffect(() => {
    if (dismissed === null) return;
    const section = sectionRef.current;
    const card = section?.querySelector<HTMLElement>(`[data-testid="dca-stray-${dismissed}"] .spdex-plan__title`);
    const target = card ?? section?.querySelector<HTMLElement>('[data-testid="dca-strays-closed-summary"]');
    target?.focus();
    setDismissed(null);
  }, [dismissed, closedCount]);

  if (view === null) return null;
  const { listed, closed, note, error, searching, retrying, checked } = view;
  if (listed.length === 0 && closed.length === 0 && note === null && error === null) return null;
  // The last search counted the factory's vaults for this wallet then; a
  // vault a deleted plan left here joins the list without a new search, so
  // the count is never fewer than the vaults shown ("all 0" above one did).
  const counted = checked === null ? 0 : Math.max(checked.expected, listed.length + closed.length);
  // With nothing to list, a heading that says there are vaults would be a
  // claim the section can't back when the search failed.
  const title = listed.length > 0 || closed.length > 0 || note !== null ? "Vaults on chain not in your plans" : "Your vaults on chain";
  return (
    <section className="spdex-dca-strays" data-testid="dca-strays" aria-labelledby="dca-strays-title" ref={sectionRef}>
      <div className="spdex-dca-strays__head">
        <h3 className="spdex-dca-strays__title" id="dca-strays-title" data-testid="dca-strays-title">
          {title}
        </h3>
        <Button variant="ghost" testId="dca-strays-look" disabled={searching} onClick={autoBuy.lookForVaults}>
          {searching ? "Looking…" : "Look again"}
        </Button>
      </div>
      {/* What the last search came to: read out when Look again finishes. */}
      <p className="spdex-dca-hint spdex-dca-strays__checked" data-testid="dca-strays-checked" role="status">
        {checked === null
          ? ""
          : `Checked ${localClock(Math.floor(checked.at / 1000))} · ${
              counted === 1 ? "your one vault is" : `all ${formatCount(counted)} of your vaults are`
            } shown here.`}
      </p>
      {listed.length > 0 ? (
        <p className="spdex-dca-hint spdex-dca-strays__intro">
          Your wallet created these vaults, and none of your plans here shows them. Add one back to see its whole card
          again, or close it to take back what it holds.
        </p>
      ) : null}
      {note !== null ? <SearchNote note={note} deps={deps} retrying={retrying} /> : null}
      {error !== null ? (
        <div className="spdex-dca-strays__note" data-testid="dca-strays-error">
          <p className="spdex-dca-line spdex-dca-line--warn">
            spDEX couldn't reach your network service to look for your vaults on chain, so whether it's missing any is
            unknown.{" "}
            {retrying ? (
              "It tries again by itself over the next few minutes."
            ) : (
              <>
                Look again in a while, or <GoTo place="networkService">change the service</GoTo>.
              </>
            )}
          </p>
          <details className="spdex-dca-detail">
            <summary>Details</summary>
            <code>{error}</code>
          </details>
        </div>
      ) : null}
      {listed.map((found) => (
        <StrayVaultCard
          key={found.vault}
          found={found}
          autoBuy={autoBuy}
          deps={deps}
          onDismissed={() => setDismissed(found.vault)}
        />
      ))}
      {closed.length > 0 ? (
        <Disclosure summary={`Closed vaults (${closed.length})`} testId="dca-strays-closed">
          <p className="spdex-dca-hint">
            Closed, with nothing left in them. There's nothing to do with these; they're listed so that none goes
            unaccounted for.
          </p>
          {closed.map((found) => (
            <Row
              key={found.vault}
              label={closedVaultText(found.state)}
              testId={`dca-strays-closed-${found.vault}`}
              value={
                <span className="spdex-dca-addressrow">
                  <AddressText address={found.vault} />
                  <CopyButton text={found.vault} />
                </span>
              }
            />
          ))}
        </Disclosure>
      ) : null}
    </section>
  );
}

/**
 * The factory counts vaults the page doesn't show: how many and why
 * (`vaultSearchNote`), then that nothing is lost, then where to look — a
 * network service that serves older records, or a block explorer, with what
 * to look for there. The service's own words are in Details.
 */
function SearchNote({ note, deps, retrying }: { note: VaultSearchNote; deps: AutoBuyDeps; retrying: boolean }) {
  const them = note.missing === 1 ? "it" : "them";
  const account = deps.account;
  const accountPage = account === null ? null : explorerAddressUrl(deps.config.chainId, account);
  const factory = deps.engine?.vaultFactory ?? null;
  return (
    <div className="spdex-dca-strays__note" data-testid="dca-strays-note">
      <p className="spdex-dca-line spdex-dca-line--warn" data-testid="dca-strays-note-text">
        {note.text}
        {retrying ? " spDEX asks again by itself over the next few minutes." : ""}
      </p>
      <p className="spdex-dca-hint">
        A vault keeps what it holds whether spDEX shows it or not, and only your wallet can close it and take that
        back. If you've closed {them} already, there's nothing to do.
      </p>
      <p className="spdex-dca-hint">
        To see {them} here, use a service that serves older records (your own node does):{" "}
        <GoTo place="networkService">Change service</GoTo>. Or look on a block explorer:{" "}
        {accountPage === null ? (
          "your wallet's transactions"
        ) : (
          <a href={accountPage} target="_blank" rel="noreferrer noopener" data-testid="dca-strays-explorer">
            your wallet's transactions ↗
          </a>
        )}{" "}
        include each vault's creation, sent to the vault factory
        {factory === null ? "." : ":"}
      </p>
      {factory !== null ? (
        <div className="spdex-dca-strays__factory">
          <AddressText address={factory} testId="dca-strays-factory" />
          <CopyButton text={factory} />
        </div>
      ) : null}
      {note.refusal !== null ? (
        <details className="spdex-dca-detail">
          <summary>Details</summary>
          <code>{note.refusal}</code>
        </details>
      ) : null}
    </div>
  );
}

/**
 * One vault no plan points at, as a compact vault card. Its buttons act on
 * the vault itself, under its own activity key (`strayVaultKey`), since there
 * is no plan id to key them by. Its title carries its short address, since
 * two vaults on the same terms would otherwise read alike, and so do its
 * buttons' names for a screen reader.
 */
function StrayVaultCard({
  found,
  autoBuy,
  deps,
  onDismissed,
}: {
  found: FoundVault & { status: VaultCardStatus };
  autoBuy: AutoBuy;
  deps: AutoBuyDeps;
  onDismissed: () => void;
}) {
  const key = strayVaultKey(found.vault);
  const activity = autoBuy.activity[key];
  const busy = activity?.busy ?? null;
  const { state, status, plan } = found;
  const figures = state.kind === "active" ? state : null;
  const [asking, setAsking] = useState(false);
  const block = walletBlock(deps, autoBuy);
  const canClose = figures !== null && figures.mine === true && !figures.closed;
  // A closed vault has nothing a card could do with it: no Add back either.
  const closedVault = figures !== null && figures.closed;
  const canAdd = plan !== null && figures !== null && figures.mine === true && !figures.closed;
  // As on a plan's card: closing is the prominent action only for a finished
  // vault that still holds money, where it is the one thing left to do.
  // Otherwise the prominent one is Add back, which sends nothing and can be
  // undone, rather than the close, which can't.
  const closeFirst = canClose && status.vault === "done" && figures.balance > 0n;
  const tail = vaultTermsTail(state);
  const progress = figures !== null ? vaultProgress(figures) : null;
  const short = shortAddress(found.vault);
  const closing = figures === null ? "Close vault" : closeLabel(figures);

  return (
    <div
      className={`spdex-plan spdex-plan--vault spdex-plan--stray${status.pill === "attention" ? " spdex-plan--attention" : ""}`}
      data-testid={`dca-stray-${found.vault}`}
    >
      <div className="spdex-plan__head">
        <span className="spdex-plan__titlegroup">
          <h4 className="spdex-plan__title" tabIndex={-1} data-testid="dca-stray-title">
            {/* The dot stays with the name, so a title that wraps never
                starts its second line with it. */}
            <DotAfter text={plan === null ? "A vault" : cardTitle(plan)} />{" "}
            <span className="spdex-plan__titleaddress">{short}</span>
          </h4>
          <UnauditedBadge />
        </span>
        <Pill status={status.pill} testId="dca-pill">
          {status.pillLabel}
        </Pill>
      </div>
      {plan !== null ? (
        <p className="spdex-plan__terms" data-testid="dca-terms">
          {amountEvery(plan)} · {tail[0]}
          <Term tip={VAULT_TIPS.vault}>vault</Term>
          {tail[1]}
        </p>
      ) : null}
      <Progress
        value={progress?.value ?? null}
        max={figures?.maxBuys ?? 1}
        label="Buys made"
        testId="dca-progress"
        valueText={progress === null ? "Buys made: unknown" : progress.valueText}
      />
      <div className="spdex-dca-facts">
        <Row
          label={<Term tip={VAULT_TIPS.vault}>Vault</Term>}
          value={
            <span className="spdex-dca-addressrow">
              <AddressText address={found.vault} testId="dca-vault-address" />
              <CopyButton text={found.vault} testId="dca-vault-copy" />
            </span>
          }
        />
        <Row
          label={<Term tip={VAULT_TIPS.weth}>Holds</Term>}
          value={figures === null ? "unknown" : <Dotted text={vaultHoldsText(figures)} />}
          testId="dca-vault-balance"
        />
      </div>
      <p className="spdex-plan__status" data-testid="dca-status" aria-live="polite">
        {busy ?? strayVaultLine(status, state)}
      </p>
      {activity?.notice ? (
        <NoticeBanner
          notice={activity.notice}
          onDismiss={() => {
            autoBuy.clearNotice(key);
            onDismissed();
          }}
        />
      ) : null}
      {closedVault ? null : (
        <div className="spdex-dca-actions">
          <Button
            testId="dca-stray-add"
            variant={closeFirst ? "ghost" : "solid"}
            disabled={!canAdd || busy !== null}
            label={`Add back to my plans: vault ${short}`}
            onClick={() => void autoBuy.addStrayVault(found.vault)}
          >
            Add back to my plans
          </Button>
          {canClose ? (
            <Button
              testId="dca-vault-close"
              variant={closeFirst ? "solid" : "ghost"}
              disabled={block !== null || busy !== null}
              label={`${closing}: vault ${short}`}
              expanded={asking}
              onClick={() => setAsking(!asking)}
            >
              {closing}
            </Button>
          ) : null}
        </div>
      )}
      {canClose && block !== null ? <p className="spdex-dca-hint">{block}</p> : null}
      {asking && canClose ? (
        <CloseConfirm
          figures={figures}
          disabled={block !== null || busy !== null}
          onConfirm={() => {
            setAsking(false);
            void autoBuy.closeStrayVault(found.vault);
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  );
}
