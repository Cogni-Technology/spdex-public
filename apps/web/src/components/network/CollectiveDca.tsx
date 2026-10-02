/**
 * Collective DCA: what every auto-buy vault has done, from the chain alone.
 *
 * Folded to its title until opened, and nothing is read before then:
 * opening it is what asks the network service, through
 * `lib/network/platform.ts`, which keeps a read for five minutes. Every
 * figure is a count of vaults, ETH or SPX at one block, with no money value
 * anywhere, and the caveat under them says what can't be counted and why. A factory that isn't deployed shows a sentence,
 * never a grid of zeros; a vault that couldn't be read turns every total into
 * "at least".
 *
 * The figures are display only: nothing here decides a route or a
 * signature. Help run the network, which does sign, is a panel of its own
 * (HelpRunNetwork.tsx), and no figure here feeds it.
 *
 * In a tile (`open` defined, the "Collective DCA" tile) the tile is its fold:
 * opening the tile is what reads, and "35 vault buys" (or "read on open") is
 * its part of the header's summary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Disclosure, FoldedPanel, Stat } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import { summarisePlatform, type Known, type PlatformRead, type PlatformSummary } from "@spdex/vault";
import { vaultDeployment } from "../../lib/dca/vault.js";
import {
  COLLECTIVE_CAVEAT,
  COLLECTIVE_SUBTITLE,
  COLLECTIVE_TITLE,
  cachedPlatformRead,
  collectiveSummary,
  collectiveFooter,
  collectiveRows,
  collectiveTiles,
  loadMorePlatform,
  loadPlatform,
  notDeployedText,
  notOfferedText,
  openHint,
  partialNotes,
  readFailedText,
  readMoreLabel,
  type FigureText,
} from "../../lib/network/platform.js";
import type { TilePanelProps } from "../../lib/tiles.js";
import { useTileSummary } from "../dca/tilePanel.js";
import "./network.css";

export interface CollectiveDcaProps extends TilePanelProps {
  /** The network service, as `Engine.rpc`; null before one is chosen. */
  rpc: JsonRpc | null;
  chainId: number;
  /** Each successful read's figures, for the ticker. */
  onRead?(summary: PlatformSummary): void;
}

/**
 * Every vault's buys, as this panel last read them, for the ticker: kept
 * with the network service (`source`, the Engine) that answered, and
 * dropped for any other. Null until a read.
 */
export function useCollectiveBuys(source: object | null): { buys: Known<bigint> | null; onRead(summary: PlatformSummary): void } {
  const [last, setLast] = useState<{ source: object; summary: PlatformSummary } | null>(null);
  const onRead = useCallback((summary: PlatformSummary) => {
    if (source !== null) setLast({ source, summary });
  }, [source]);
  const buys = last !== null && last.source === source && last.summary.state === "read" ? last.summary.buys : null;
  return { buys, onRead };
}

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "ready"; read: PlatformRead }
  | { kind: "failed"; text: string };

export function CollectiveDca({ rpc, chainId, onRead, open: tileOpen, onSummary }: CollectiveDcaProps) {
  const offered = vaultDeployment(chainId) !== null;
  const [phase, setPhase] = useState<Phase>(() => {
    const cached = rpc === null ? null : cachedPlatformRead(rpc);
    return cached === null ? { kind: "idle" } : { kind: "ready", read: cached };
  });
  const [folded, setOpen] = useState(false);
  const inTile = tileOpen !== undefined;
  // In a tile, the tile is the fold.
  const open = inTile ? tileOpen : folded;
  // Which endpoint and chain the phase describes: an answer that arrives after
  // either changed is someone else's figures, and is dropped.
  const current = useRef({ rpc, chainId });
  current.current = { rpc, chainId };
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const run = useCallback(
    (read: (rpc: JsonRpc) => Promise<PlatformRead>) => {
      if (rpc === null || !offered) return;
      const asked = { rpc, chainId };
      setPhase({ kind: "reading" });
      read(rpc).then(
        (result) => {
          if (current.current.rpc !== asked.rpc || current.current.chainId !== asked.chainId) return;
          setPhase({ kind: "ready", read: result });
          onReadRef.current?.(summarisePlatform(result));
        },
        (error: unknown) => {
          if (current.current.rpc !== asked.rpc || current.current.chainId !== asked.chainId) return;
          setPhase({ kind: "failed", text: readFailedText(error) });
        },
      );
    },
    [rpc, chainId, offered],
  );

  // A new network service or chain starts from what is cached for it, or from nothing.
  useEffect(() => {
    const cached = rpc === null ? null : cachedPlatformRead(rpc);
    setPhase(cached === null ? { kind: "idle" } : { kind: "ready", read: cached });
  }, [rpc, chainId]);

  // Opening the panel is the one thing that reads: the first time, and again
  // when what it shows is more than five minutes old.
  useEffect(() => {
    if (!open || rpc === null) return;
    const stale = phase.kind === "ready" && cachedPlatformRead(rpc) === null;
    if (phase.kind === "idle" || stale) run((endpoint) => loadPlatform(endpoint, chainId));
  }, [open, phase.kind, run, rpc, chainId]);

  const shown = phase.kind === "ready" ? phase.read : null;
  const summary = useMemo(() => (shown === null ? null : summarisePlatform(shown)), [shown]);
  const readAgain = () => run((endpoint) => loadPlatform(endpoint, chainId, { force: true }));
  useTileSummary(onSummary, {
    text: collectiveSummary(
      !offered
        ? { kind: "not-offered" }
        : rpc === null
          ? { kind: "no-service" }
          : phase.kind === "ready"
            ? { kind: "ready", summary: summary ?? summarisePlatform(phase.read) }
            : phase.kind === "idle" && open
              ? { kind: "reading" }
              : { kind: phase.kind },
    ),
  });

  const content = (
    <>
      {!offered ? (
        <p className="spdex-network-line" data-testid="collective-not-offered">
          {notOfferedText(chainId)}
        </p>
      ) : rpc === null ? (
        <p className="spdex-network-line" data-testid="collective-no-service">
          Choose a network service first: the figures are read through it.
        </p>
      ) : (
        <>
          <p className="spdex-panel__subtitle">{COLLECTIVE_SUBTITLE}</p>
          {phase.kind === "reading" || (phase.kind === "idle" && open) ? (
            <p className="spdex-field__hint" data-testid="collective-loading">
              Reading every vault's figures at one block…
            </p>
          ) : null}
          {phase.kind === "failed" ? (
            <div data-testid="collective-error">
              <p className="spdex-network-warn">{phase.text}</p>
              <div className="spdex-actions">
                <Button variant="ghost" testId="collective-retry" onClick={readAgain}>
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
          {summary?.state === "not-deployed" ? (
            <>
              <p className="spdex-network-line" data-testid="collective-not-deployed">
                {notDeployedText(chainId)}
              </p>
              <div className="spdex-actions">
                <Button variant="ghost" testId="collective-read-again" onClick={readAgain}>
                  Read again
                </Button>
              </div>
            </>
          ) : null}
          {summary?.state === "read" && phase.kind === "ready" ? (
            <Figures
              summary={summary}
              onReadAgain={readAgain}
              onReadMore={() => run((endpoint) => loadMorePlatform(endpoint, chainId, phase.read))}
            />
          ) : null}
          {summary !== null ? (
            <p className="spdex-field__hint" data-testid="collective-footer">
              {collectiveFooter(summary)}
            </p>
          ) : null}
          <Disclosure summary="What's counted?" testId="collective-counted">
            <p className="spdex-network-caveat" data-testid="collective-caveat">
              {COLLECTIVE_CAVEAT}
            </p>
          </Disclosure>
        </>
      )}
    </>
  );
  const block = phase.kind === "ready" ? { "data-block": phase.read.block.toString() } : {};

  return inTile ? (
    <section className="spdex-subpanel spdex-collective" data-testid="collective-panel" {...block}>
      {content}
    </section>
  ) : (
    <FoldedPanel
      title={COLLECTIVE_TITLE}
      testId="collective-panel"
      foldTestId="collective-open"
      onToggle={setOpen}
      {...(phase.kind === "ready" ? { attributes: block } : {})}
    >
      {content}
    </FoldedPanel>
  );
}

function Figures({
  summary,
  onReadAgain,
  onReadMore,
}: {
  summary: Extract<PlatformSummary, { state: "read" }>;
  onReadAgain: () => void;
  onReadMore: () => void;
}) {
  const hint = openHint(summary);
  const more = readMoreLabel(summary);
  return (
    <>
      <div className="spdex-statgrid spdex-network-grid">
        {collectiveTiles(summary).map((tile) => (
          <Stat
            key={tile.id}
            label={tile.label}
            testId={`collective-${tile.id}`}
            value={<Figure figure={tile.figure} />}
            hint={
              tile.id === "open" ? (
                <>
                  <span data-testid="collective-made" data-value={summary.made.toString()}>
                    {hint.made}
                  </span>{" "}
                  made · {hint.rest}
                </>
              ) : (
                tile.hint
              )
            }
          />
        ))}
      </div>
      <dl className="spdex-network-rows">
        {collectiveRows(summary).map((row) => (
          <div className="spdex-network-row" key={row.id}>
            <dt className="spdex-network-row__label">{row.label}</dt>
            <dd className="spdex-network-row__value" data-testid={`collective-${row.id}`}>
              <Figure figure={row.figure} />
            </dd>
            <dd className="spdex-network-row__hint">{row.hint}</dd>
          </div>
        ))}
      </dl>
      {partialNotes(summary).map((note) => (
        <p className="spdex-network-warn" data-testid="collective-partial" key={note}>
          {note}
        </p>
      ))}
      <div className="spdex-actions">
        <Button variant="ghost" testId="collective-read-again" onClick={onReadAgain}>
          Read again
        </Button>
        {more !== null ? (
          <Button variant="ghost" testId="collective-read-more" onClick={onReadMore}>
            {more}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/**
 * A figure, short, with "at least" above it when some vaults weren't counted.
 * Where the short form drops digits, the exact figure is in its title and a
 * tap shows it in place: a phone has no hover.
 */
function Figure({ figure }: { figure: FigureText }) {
  const [exact, setExact] = useState(false);
  const atLeast = figure.atLeast ? <span className="spdex-network-atleast">at least </span> : null;
  if (figure.exact === null) {
    return (
      <>
        {atLeast}
        {figure.short}
      </>
    );
  }
  return (
    <>
      {atLeast}
      <button
        type="button"
        className={exact ? "spdex-network-figure spdex-network-figure--exact" : "spdex-network-figure"}
        title={figure.exact}
        aria-label={exact ? figure.exact : `${figure.short}, rounded down. Show every digit`}
        onClick={() => setExact((shown) => !shown)}
      >
        {exact ? figure.exact : figure.short}
      </button>
    </>
  );
}
