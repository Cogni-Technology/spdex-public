/**
 * The ticker: spx6900.com's marquee, directly under the masthead's hazard band.
 *
 * What it says is decided in lib/ticker.ts, from state App already holds for
 * other panels; this file only lays it out and scrolls it. It makes no request
 * of its own and runs no timer of its own: the countdown advances on the
 * auto-buy runner's clock, the same one the plan cards read.
 *
 * How it scrolls, and why this way:
 *
 * - The items are rendered twice, side by side, and both copies slide left by
 *   their own width, so the second copy arrives exactly where the first began
 *   and the loop has no seam. Each copy is at least as wide as the strip, so
 *   a short list (the ethos lines alone, on a wide screen) spreads out rather
 *   than leaving a gap at the end of every lap.
 * - The duration is measured, not fixed: a copy's width over a constant speed.
 *   A fixed duration would scroll a strip full of figures half again as fast
 *   as an ethos-only one, and the speed is what makes a marquee readable.
 * - It pauses under the pointer and while it has keyboard focus, which is why
 *   it is a tab stop: a strip that moves on its own has to be stoppable by
 *   someone who doesn't use a mouse.
 * - Under prefers-reduced-motion nothing moves. The stylesheet hides the
 *   second copy and wraps the first inside a strip one line tall, so the items
 *   that fit are shown whole and the rest fall onto a line that is clipped
 *   away, never cut mid-word.
 *
 * For assistive technology there is one copy: the second is aria-hidden, and
 * the separators are drawn by the stylesheet with no text in them. The strip
 * is a `marquee`, the ARIA role for exactly this — changing, non-essential,
 * and never announced as it changes. An item whose shorthand needs spelling
 * out ("0.0006751% to flip") hides it from screen readers and hands them a
 * sentence instead, in visually hidden text rather than an `aria-label`:
 * not every screen reader announces a label on a list item, and those that
 * don't would be left the shorthand after all.
 */

import { useLayoutEffect, useRef } from "react";
import type { DcaPlan } from "@spdex/core";
import type { Known } from "@spdex/vault";
import type { AutoBuy } from "../lib/dca/useAutoBuy.js";
import type { Pricing } from "../lib/money/pricing.js";
import { moneyView } from "../lib/money/rates.js";
import { perfNow } from "../lib/page.js";
import type { PricedPool } from "../lib/stats.js";
import { tickerItems, type TickerItem } from "../lib/ticker.js";
import { TOKEN_LIST } from "../lib/tokens.js";

/** Pixels a second: spx6900.com's own marquee runs at 55, a touch quick for figures. */
const SPEED = 45;

const SPX = TOKEN_LIST.find((token) => token.symbol === "SPX")!;

/** A label and its figure, in the item's order, and its sentence when it has one. */
function Figure({ item }: { item: TickerItem }) {
  const label = <span className="spdex-ticker__label">{item.label}</span>;
  const value = <span className="spdex-ticker__value">{item.text}</span>;
  // The space is its own text node on purpose: without it a screen reader,
  // and a copy-paste, gets "liquidity$12.46M".
  const shown = item.labelAfter ? (
    <>
      {value} {label}
    </>
  ) : (
    <>
      {label} {value}
    </>
  );
  if (item.spoken === undefined) return shown;
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="spdex-ticker__spoken">{item.spoken}</span>
    </>
  );
}

function Items({ items, hidden }: { items: readonly TickerItem[]; hidden?: boolean }) {
  return (
    <ul className="spdex-ticker__seg" aria-hidden={hidden ? true : undefined}>
      {items.map((item) => (
        <li
          key={item.id}
          className={`spdex-ticker__item spdex-ticker__item--${item.kind}`}
          data-testid={hidden ? undefined : `ticker-${item.id}`}
        >
          {item.label === undefined ? item.text : <Figure item={item} />}
        </li>
      ))}
    </ul>
  );
}

export function Ticker({
  statsRates,
  pricing,
  spxSupply,
  pools,
  pair,
  plans,
  autoBuy,
  vaultBuys = null,
}: {
  /**
   * The markets panel's dollar rates, from the Guard's TWAP feed: "% to flip",
   * which stays in dollars, reads them until the page's own rates (`pricing`)
   * have been read.
   */
  statsRates: ReadonlyMap<string, bigint>;
  /**
   * The page's rates and currency, for the liquidity figure. Only read, never
   * asked for: an always-visible strip that asked would make every page read
   * prices, so it uses them once something else on screen has.
   */
  pricing: Pricing | null;
  /** SPX's total supply in raw units, as App last read it for this network service, or null. */
  spxSupply: bigint | null;
  /** The markets panel's pools once read for `pair`, or null until they are. */
  pools: readonly PricedPool[] | null;
  /** "ETH/SPX": the pair the markets panel is showing. */
  pair: string;
  plans: readonly DcaPlan[];
  autoBuy: Pick<AutoBuy, "now" | "nextBuyAt">;
  /** Every vault's buys, as the Collective DCA panel last read them; null until it has. */
  vaultBuys?: Known<bigint> | null;
}) {
  // The status strip's own figure, vault plans included: a vault's next buy
  // is in chain time, which the hook carries into this device's clock, and a
  // vault never shows in the runner's state (it reports every one paused).
  const next = plans.length === 0 ? null : autoBuy.nextBuyAt;

  const items = tickerItems({
    rates: pricing?.snapshot?.usd ?? statsRates,
    spx: { address: SPX.address, supply: spxSupply },
    liquidity: pools === null ? null : { pair, pools },
    money: moneyView(pricing, perfNow()),
    nextBuyAt: next,
    vaultBuys,
    nowMs: autoBuy.now,
  });

  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // Written straight to the element rather than through state: a width that
  // changes (a figure arriving, the window resized) would otherwise cost a
  // second render for a value only the stylesheet reads. Until it is measured
  // the stylesheet's default applies.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const seg = trackRef.current?.firstElementChild;
    if (!strip || !(seg instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const seconds = Math.max(8, Math.round(seg.offsetWidth / SPEED));
      strip.style.setProperty("--ticker-duration", `${seconds}s`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(seg);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={stripRef}
      className="spdex-ticker"
      role="marquee"
      aria-label="Ticker"
      tabIndex={0}
      data-testid="ticker"
    >
      <div ref={trackRef} className="spdex-ticker__track">
        <Items items={items} />
        <Items items={items} hidden />
      </div>
    </div>
  );
}
