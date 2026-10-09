/**
 * What every sticker shares: an inline SVG that is decoration only (hidden
 * from assistive technology, never focusable, never under the pointer), and
 * the small "spDEX · community" tab that says whose it is.
 *
 * Colours are classes (theme.css, "Art"), each a token, so PASTEL recolours
 * every sticker for free. Text is stretched to its box (`textLength`), so a
 * fallback face that is wider than the display face still fits.
 */

import type { ReactNode } from "react";

export function Sticker({ id, viewBox, children }: { id: string; viewBox: string; children: ReactNode }) {
  return (
    <svg
      className={`spdex-art spdex-sticker spdex-sticker--${id}`}
      data-art={id}
      viewBox={viewBox}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * The "spDEX · community" tab, a small ink label on one edge. ("community
 * project" in full would be squeezed to 62% and unreadable; the masthead
 * says it.)
 *
 * Big enough to read: 11 units in stickers drawn at 0.88 to 0.97 of their
 * viewBox, so about 10px on screen (a 7-unit tab came out at 6px, a dash).
 * The text is stretched to fill the tab, less a margin, so any fallback face
 * fits it.
 */
export const TAB_WIDTH = 112;
export const TAB_HEIGHT = 15;

export function Tab({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect className="spdex-art__ink" x={x} y={y} width={TAB_WIDTH} height={TAB_HEIGHT} />
      <text
        className="spdex-art__data spdex-art__on-ink"
        x={x + TAB_WIDTH / 2}
        y={y + 11}
        fontSize={11}
        fontWeight={700}
        textAnchor="middle"
        textLength={TAB_WIDTH - 10}
        lengthAdjust="spacingAndGlyphs"
      >
        spDEX · community
      </text>
    </g>
  );
}

/** A slightly irregular outline, drawn twice: a hard ink shadow 4px down and right, then the sticker. */
export function Outline({ d, fill }: { d: string; fill: string }) {
  return (
    <>
      <path className="spdex-art__ink" d={d} transform="translate(4 4)" />
      <path className={`${fill} spdex-art__edge`} d={d} />
    </>
  );
}
