/**
 * A luggage tag on a key ring. "YOUR KEYS: NEVER OURS" is true whatever
 * the wallet: spDEX's authors never hold a key (the disclaimer's point 4).
 */

import { Outline, Sticker, Tab } from "./Sticker.js";

export function KeysTag() {
  return (
    <Sticker id="keys" viewBox="0 0 170 124">
      <circle className="spdex-art__line" strokeWidth={2.5} cx={30} cy={36} r={17} />
      <Outline d="M56 14 L160 10 L163 98 L58 103 L28 58 Z" fill="spdex-art__cyan" />
      <circle className="spdex-art__paper spdex-art__edge" cx={46} cy={58} r={6.5} />
      <path className="spdex-art__line" strokeWidth={2.5} d="M44 52 C40 44 36 40 30 36" />
      <circle className="spdex-art__line" strokeWidth={2.5} cx={14} cy={20} r={8} />
      <path className="spdex-art__line" strokeWidth={2.5} d="M8 26 L2 32 M5 29 L8 32 M2 32 L5 35" />
      <text className="spdex-art__stat spdex-art__ink" x={110} y={50} fontSize={24} textAnchor="middle" textLength={82} lengthAdjust="spacingAndGlyphs">
        YOUR KEYS:
      </text>
      <text className="spdex-art__stat spdex-art__ink" x={110} y={78} fontSize={24} textAnchor="middle" textLength={82} lengthAdjust="spacingAndGlyphs">
        NEVER OURS
      </text>
      <Tab x={50} y={108} />
    </Sticker>
  );
}
