/**
 * What is actually in each market (the UI's word for a pool).
 *
 * The question this answers is the one a router answers implicitly and never
 * shows its working for: where is the liquidity, and is this pool deep enough
 * that my trade will not move it. spDEX already refuses to hide *which* pools
 * a route touches; showing how big they are is the same argument one step
 * further.
 *
 * Every figure degrades to "unknown" rather than to zero. A tracker reads only
 * the tokens its manifest declares, an endpoint may refuse a log query, and a
 * pair may have no oracle — all three are ordinary, and all three produce a
 * number that would otherwise be indistinguishable from "this pool is empty",
 * which is a reason not to trade.
 *
 * In a tile (`open` defined, the "Markets" tile) it drops its own panel and
 * title, and reports "ETH/SPX · $12.5M in 3 pools" (or "reading…", "off",
 * "unknown") as the header's summary. The reads are the page's; the panel
 * asks for rates only while it is open.
 */

import { Banner, Disclosure, Panel, Row } from "@spdex/ui";
import { fallsBack } from "../lib/money/convert.js";
import type { Pricing } from "../lib/money/pricing.js";
import { moneyView, useRatesNeeded } from "../lib/money/rates.js";
import { rateUnavailableLead } from "../lib/money/resolve.js";
import { formatFee, formatPoolMoney, shareText, type PricedPool } from "../lib/stats.js";
import { formatNumber } from "../lib/money/format.js";
import { formatCount } from "../lib/money/format.js";
import { SayingLine } from "./culture/SayingLine.js";
import { formatAmount, type TokenInfo } from "../lib/tokens.js";
import { CopyHex } from "./dca/common.js";
import type { TilePanelProps, TileSummary } from "../lib/tiles.js";
import { GoTo } from "../lib/places.js";
import { useTileSummary } from "./dca/tilePanel.js";

export interface PoolStatsView {
  pools: PricedPool[];
  /** Present when volume could not be read at all; one short line. */
  volumeNote?: string;
  /** Blocks the volume column covers. Zero means there is no volume to show. */
  volumeBlocks: number;
  loading: boolean;
}

/**
 * Say what the volume column actually covers.
 *
 * Endpoints cap log queries hard — ten blocks on some free tiers — so the
 * reader steps down until one is accepted. A column simply headed "Volume"
 * would then be quietly claiming a day's trading for two minutes of it, which
 * is the kind of number someone sizes a trade against.
 */
function windowLabel(blocks: number): string {
  if (blocks <= 0) return "Volume";
  // Spelled out: the header is set in capitals, where "20m" beside dollar
  // figures reads as twenty million.
  const minutes = Math.round((blocks * 12) / 60);
  if (minutes >= 90) return `Volume · last ${Math.round(minutes / 60)} hours`;
  if (minutes >= 2) return `Volume · last ${minutes} min`;
  return `Volume · last ${blocks} blocks`;
}

function decimalsFor(address: string, tokens: readonly TokenInfo[]): number | null {
  const token = tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  return token?.decimals ?? null;
}

function symbolFor(address: string, tokens: readonly TokenInfo[]): string {
  const token = tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  return token?.symbol ?? `${address.slice(0, 6)}…`;
}

/**
 * Raw balance rendered with its token's decimals, or a shrug.
 *
 * Two decimals is right for a 12-million-SPX pool and wrong for one holding a
 * hundredth of an ether, where it rounds a real balance to a flat "0" — which
 * reads as "this pool is empty" rather than "this pool is tiny". Anything that
 * truncates away to nothing is shown as a bound instead.
 */
function balance(amount: bigint, address: string, tokens: readonly TokenInfo[]): string {
  const decimals = decimalsFor(address, tokens);
  if (decimals === null) return "—";
  const symbol = symbolFor(address, tokens);
  const text = formatAmount(amount, decimals, { maxFraction: 2 });
  // The bound in the page's number format too: "<0,01" in German.
  if (amount > 0n && text === "0") return `<${formatNumber(0.01)} ${symbol}`;
  return `${text} ${symbol}`;
}

/**
 * Where the panel is in its work, decided by App from what it has asked for:
 * `off` when the tracker isn't switched on, `discovering` while the markets
 * for this pair are being found, `failed` when the network service didn't
 * answer that (the markets are unknown, not absent), `reading` while their
 * balances are read, `ready` after. Without this the panel used to say "check
 * it is enabled under Features" for a moment on every load, to someone who
 * had it enabled.
 */
export type PoolStatsPhase = "off" | "discovering" | "failed" | "reading" | "ready";

/** The clause packages/chain logs.ts gives a free key's cap on log ranges, the commonest reason by far. */
const RANGE_CAPPED = "this endpoint limits how many blocks of logs it will serve at once";

/**
 * The Volume unavailable banner's text: why, in one short sentence. The
 * commonest reason, a free key's cap on log ranges, is said in a newcomer's
 * words. Any other note is a clause (packages/chain logs.ts), sometimes a
 * service's own words, so it follows a fixed opening rather than being made
 * to start a sentence.
 */
export function volumeNoteText(note: string): string {
  const clause = note.trim().replace(/[.…]+$/, "");
  if (clause === RANGE_CAPPED) return "Your network service limits log reads.";
  const ending = note.trim().endsWith("…") ? "…" : ".";
  return `Couldn't read it: ${clause}${ending}`;
}

/** "ETH/SPX" from the panel's pair ("ETH / SPX (the One-time pair)"). */
export function shortPair(pair: string): string {
  return pair.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\/\s*/g, "/");
}

/**
 * The Markets tile header's summary: the pair, its total liquidity and how
 * many pools hold it; or where the panel is ("reading…", "off"); "unknown"
 * when no pool could be priced. Never a 0 for a figure it doesn't have.
 */
export function marketsSummary(input: {
  pair: string;
  phase: PoolStatsPhase;
  pools: number;
  priced: number;
  discovered: number;
  total: string;
}): TileSummary {
  if (input.phase === "off") return { text: "off" };
  if (input.phase === "discovering" || input.phase === "reading") return { text: "reading…" };
  const pair = shortPair(input.pair);
  if (input.phase === "failed") return { text: `${pair} · unknown` };
  if (input.pools === 0) return { text: input.discovered === 0 ? `${pair} · no markets found` : `${pair} · unknown` };
  if (input.priced === 0) return { text: `${pair} · unknown` };
  return { text: `${pair} · ${input.total} in ${input.pools} ${input.pools === 1 ? "pool" : "pools"}` };
}

export function PoolStatsPanel({
  view,
  tokens,
  pair,
  phase,
  discovered,
  mode,
  pricing,
  labels,
  open,
  onSummary,
}: TilePanelProps & {
  view: PoolStatsView;
  tokens: readonly TokenInfo[];
  /** "WETH / SPX": the pair on the One-time tab. */
  pair: string;
  phase: PoolStatsPhase;
  /** How many markets discovery found for the pair, whatever the tracker read. */
  discovered: number;
  /** Each market's name as its venue gave it, by lowercase pool id: the rows' pair alone doesn't tell them apart. */
  labels?: ReadonlyMap<string, string>;
  mode: "recommended" | "expert";
  /** The page's rates and currency: figures in the person's currency. Without it they are in dollars. */
  pricing?: Pricing | null;
}) {
  const priced = view.pools.filter((pool) => pool.tvlUsd !== null);
  const total = priced.reduce((sum, pool) => sum + (pool.tvlUsd ?? 0n), 0n);
  const showList = phase !== "off" && view.pools.length > 0;
  // The pools are priced in dollars already; another currency needs its
  // rate, asked for while there are figures to show.
  const tick = useRatesNeeded(pricing, showList && priced.length > 0 && open !== false);
  const money = moneyView(pricing, tick);
  const poolMoney = (usd: bigint | null) => formatPoolMoney(usd, money);
  const fxNote =
    pricing && money !== undefined && fallsBack(money)
      ? `${rateUnavailableLead(pricing.currency, pricing.snapshot)}; showing dollars.`
      : null;
  // The column heading, and on a phone (where the heading row is hidden) the
  // label each volume figure carries instead.
  const volumeLabel = windowLabel(view.volumeBlocks);
  useTileSummary(
    onSummary,
    marketsSummary({ pair, phase, pools: view.pools.length, priced: priced.length, discovered, total: poolMoney(total) }),
  );

  const body = (
    <>
      {phase === "discovering" || phase === "reading" ? (
        <p className="spdex-field__hint" data-testid="pool-stats-loading">
          {phase === "discovering" ? "Looking for markets…" : "Reading balances…"}
        </p>
      ) : null}

      {phase === "off" ? (
        <p className="spdex-field__hint" data-testid="pool-stats-empty">
          Pool statistics are off. <GoTo place="features">Turn them on</GoTo>
        </p>
      ) : phase === "failed" ? (
        <p className="spdex-field__hint" data-testid="pool-stats-failed">
          spDEX couldn&apos;t read this pair&apos;s markets from the network service, so they&apos;re unknown for
          now. It asks again in a minute, and when you get a price.
        </p>
      ) : phase === "ready" && view.pools.length === 0 ? (
        <p className="spdex-field__hint" data-testid="pool-stats-empty">
          {/* Found and unread is not the same as not found: say which. */}
          {discovered === 0
            ? "No markets found for this pair."
            : `spDEX found ${discovered === 1 ? "1 market" : `${discovered} markets`} for this pair but couldn't read what they hold.`}
        </p>
      ) : null}

      {showList ? (
        <>
          <Row
            label="Total liquidity"
            value={priced.length === 0 ? "unknown" : poolMoney(total)}
            testId="pool-stats-total"
          />

          <div className="spdex-stats" data-testid="pool-stats-list">
            <div className="spdex-stats__head" aria-hidden="true">
              <span>Market</span>
              <span>Fee</span>
              <span>Value held</span>
              <span>{volumeLabel}</span>
              <span>Share</span>
            </div>

            {view.pools.map((pool) => (
              <div className="spdex-stats__row" key={pool.poolId} data-testid={`pool-stat-${pool.poolId}`}>
                <div className="spdex-stats__who">
                  <div className="spdex-stats__pair">
                    {symbolFor(pool.token0, tokens)} / {symbolFor(pool.token1, tokens)}
                    {labels?.get(pool.poolId.toLowerCase()) === undefined ? null : (
                      <span className="spdex-stats__venue" data-testid={`pool-venue-${pool.poolId}`}>
                        {" · "}
                        {labels.get(pool.poolId.toLowerCase())}
                      </span>
                    )}
                  </div>
                  {/* Short in Simple, where 42 characters broke over two lines
                      with one or two left on the second; whole in Expert, and
                      on hover, for checking it anywhere else. Either copies
                      the whole address. */}
                  <div className="spdex-pool__meta">
                    <CopyHex value={pool.poolId} what="market's address" full={mode === "expert"} testId={`pool-id-${pool.poolId}`} />
                  </div>
                  {pool.supported ? (
                    <div className="spdex-pool__meta">
                      {balance(pool.balance0, pool.token0, tokens)} ·{" "}
                      {balance(pool.balance1, pool.token1, tokens)}
                    </div>
                  ) : (
                    // Not a footnote. A market the tracker cannot read is one
                    // whose numbers are absent rather than small.
                    <div className="spdex-pool__meta" data-testid={`pool-unsupported-${pool.poolId}`}>
                      holds a token this tracker does not declare — not read
                    </div>
                  )}
                </div>
                <span className="spdex-num" data-testid={`pool-fee-${pool.poolId}`} data-label="Fee">
                  {formatFee(pool.fee)}
                </span>
                <span className="spdex-num" data-testid={`pool-tvl-${pool.poolId}`} data-label="Value held">
                  {poolMoney(pool.tvlUsd)}
                </span>
                <span className="spdex-num" data-testid={`pool-volume-${pool.poolId}`} data-label={volumeLabel}>
                  {pool.volumeUsd === null ? "—" : poolMoney(pool.volumeUsd)}
                  {/* Its own line under the figure (theme.css), so no "·" to join them. */}
                  {pool.swaps !== null && pool.swaps > 0 ? (
                    <span className="spdex-pool__meta spdex-stats__swaps">
                      {formatCount(pool.swaps)} {pool.swaps === 1 ? "swap" : "swaps"}
                    </span>
                  ) : null}
                </span>
                <span className="spdex-num" data-testid={`pool-share-${pool.poolId}`} data-label="Share">
                  {pool.shareBps === null ? "—" : shareText(pool.shareBps)}
                </span>
              </div>
            ))}
          </div>

          {fxNote !== null ? (
            <p className="spdex-field__hint" data-testid="pool-stats-fx-note">
              {fxNote}
            </p>
          ) : null}

          {view.volumeNote ? (
            <Banner tone="warn" title="Volume unavailable" testId="volume-note">
              {volumeNoteText(view.volumeNote)}
            </Banner>
          ) : null}

          <Disclosure testId="pool-stats-how" summary="How these numbers are measured" open={mode === "expert"}>
            <p className="spdex-field__hint" data-testid="pool-stats-provenance">
              Balances are read from each pool&apos;s two tokens, volume from its swap logs, and prices
              from the same 10-minute average the safety check uses.
              {view.volumeBlocks > 0 ? (
                <>
                  {" "}
                  {/* The header's minutes assume twelve-second blocks, which is true
                      of mainnet and not of a development fork. The block count is
                      exact everywhere, so it is stated alongside rather than
                      instead — one is readable, the other is correct. */}
                  Volume covers the last <strong>{formatCount(view.volumeBlocks)}</strong>{" "}
                  blocks; the heading converts that at mainnet block times.
                </>
              ) : null}
            </p>
          </Disclosure>
        </>
      ) : null}

      {/* Where someone looks for a chart, the answer: there isn't one, and
          the community's saying behind it, one link away. */}
      <SayingLine id="no-chart" />
    </>
  );

  return open !== undefined ? (
    <section className="spdex-tilepanel" data-testid="pool-stats">
      {pair.includes("(") ? <p className="spdex-panel__subtitle">Markets for {pair}.</p> : null}
      {body}
    </section>
  ) : (
    <Panel
      title={`Markets for ${pair}`}
      subtitle="Every market spDEX can see for this pair, and how much it holds."
      testId="pool-stats"
    >
      {body}
    </Panel>
  );
}
