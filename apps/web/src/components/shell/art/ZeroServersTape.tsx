/** A strip of hazard tape with a label on it. Both halves are true of the code: AGENTS.md rules 4 and 5. */

import { Outline, Sticker, Tab } from "./Sticker.js";

export function ZeroServersTape() {
  return (
    <Sticker id="tape" viewBox="0 0 206 74">
      <defs>
        <pattern id="spdex-art-hazard" patternUnits="userSpaceOnUse" width={14} height={14} patternTransform="rotate(45)">
          <rect className="spdex-art__yellow" width={14} height={14} />
          <rect className="spdex-art__ink" width={6} height={14} />
        </pattern>
      </defs>
      <Outline d="M4 10 L198 4 L200 48 L6 55 Z" fill="spdex-art__hazard" />
      <rect className="spdex-art__surface spdex-art__edge" x={30} y={17} width={146} height={26} />
      <text className="spdex-art__data spdex-art__ink" x={103} y={34.5} fontSize={11} fontWeight={700} textAnchor="middle" textLength={130} lengthAdjust="spacingAndGlyphs">
        0 SERVERS · 0 TRACKERS
      </text>
      <Tab x={88} y={56} />
    </Sticker>
  );
}
