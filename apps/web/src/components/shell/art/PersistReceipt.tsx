/** A thermal till receipt with a torn end. "PERSIST FOREVER" is a community saying. */

import { Outline, Sticker, Tab } from "./Sticker.js";

const TORN =
  "M6 16 L114 14 L115 176 L108 183 L101 176 L94 183 L87 176 L80 183 L73 176 L66 183 L59 176 L52 183 L45 176 L38 183 L31 176 L24 183 L17 176 L10 183 L6 177 Z";

export function PersistReceipt() {
  return (
    <Sticker id="receipt" viewBox="0 0 124 192">
      <Outline d={TORN} fill="spdex-art__surface" />
      {/* After the body, so its top edge can't cut the descenders ("community"'s y). */}
      <Tab x={6} y={1} />
      <text className="spdex-art__data spdex-art__ink" x={60} y={40} fontSize={12} fontWeight={700} textAnchor="middle" textLength={70} lengthAdjust="spacingAndGlyphs">
        RECEIPT
      </text>
      <path className="spdex-art__line" strokeWidth={1.5} strokeDasharray="3 3" d="M16 52 H104 M16 88 H104" />
      <text className="spdex-art__data spdex-art__ink" x={16} y={74} fontSize={10}>
        QTY
      </text>
      <text className="spdex-art__data spdex-art__ink" x={104} y={74} fontSize={10} textAnchor="end">
        1 BLOCK
      </text>
      <rect className="spdex-art__cyan spdex-art__edge" x={12} y={106} width={96} height={38} />
      <text className="spdex-art__stat spdex-art__ink" x={60} y={122} fontSize={15} textAnchor="middle" textLength={50} lengthAdjust="spacingAndGlyphs">
        PERSIST
      </text>
      <text className="spdex-art__stat spdex-art__ink" x={60} y={138} fontSize={15} textAnchor="middle" textLength={50} lengthAdjust="spacingAndGlyphs">
        FOREVER
      </text>
      <path className="spdex-art__line" strokeWidth={2} d="M20 154 V166 M24 154 V166 M29 154 V166 M31 154 V166 M36 154 V166 M42 154 V166 M45 154 V166 M50 154 V166 M53 154 V166 M59 154 V166 M64 154 V166 M66 154 V166 M71 154 V166 M77 154 V166 M80 154 V166 M86 154 V166 M90 154 V166 M95 154 V166 M100 154 V166" />
    </Sticker>
  );
}
