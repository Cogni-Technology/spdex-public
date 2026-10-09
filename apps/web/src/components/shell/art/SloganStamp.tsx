/**
 * A rectangular rubber stamp, its ink edge broken where the stamp didn't
 * touch. "6900 > 500" is a community slogan (the disclaimer's point 8); the
 * small line under it is true of the slogan and claims nothing else.
 */

import { Sticker, Tab } from "./Sticker.js";

export function SloganStamp() {
  return (
    <Sticker id="stamp" viewBox="0 0 164 116">
      {/* Bare ink in NEON; in PASTEL, whose pink is too pale to read on the backdrop's grey, a ground of its own. */}
      <rect className="spdex-art__stamp-ground" x={6} y={6} width={150} height={86} />
      <rect className="spdex-art__stamp" x={6} y={6} width={150} height={86} strokeWidth={4} strokeDasharray="46 3 24 2 61 4 33 3 70 2" />
      <rect className="spdex-art__stamp" x={13} y={13} width={136} height={72} strokeWidth={1.5} strokeDasharray="58 2 19 3 90 2" />
      <text className="spdex-art__stat spdex-art__stamp-text" x={81} y={60} fontSize={40} textAnchor="middle" textLength={118} lengthAdjust="spacingAndGlyphs">
        6900 &gt; 500
      </text>
      <text className="spdex-art__data spdex-art__stamp-text" x={81} y={77} fontSize={9} fontWeight={700} textAnchor="middle" textLength={96} lengthAdjust="spacingAndGlyphs">
        IT&apos;S JUST MATH
      </text>
      <Tab x={44} y={94} />
    </Sticker>
  );
}
