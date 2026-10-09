/** Empty chart axes, no line, a heart at the origin. "THERE IS NO CHART": a community saying. */

import { Outline, Sticker, Tab } from "./Sticker.js";

export function NoChartSticker() {
  return (
    <Sticker id="no-chart" viewBox="0 0 164 186">
      <Outline d="M8 9 L151 5 L155 150 L149 153 L11 157 L6 149 Z" fill="spdex-art__lime" />
      <path className="spdex-art__line" strokeWidth={3} d="M36 22 V112 H140" />
      <path className="spdex-art__line" strokeWidth={2} d="M31 40 H36 M31 58 H36 M31 76 H36 M31 94 H36 M56 112 V117 M76 112 V117 M96 112 V117 M116 112 V117" />
      <path className="spdex-art__ink" d="M36 121 C25 113 27 104 32 104.5 C34 104.7 35.6 106 36 107.6 C36.4 106 38 104.7 40 104.5 C45 104 47 113 36 121 Z" />
      <text className="spdex-art__stat spdex-art__ink" x={80} y={144} fontSize={23} textAnchor="middle" textLength={124} lengthAdjust="spacingAndGlyphs">
        THERE IS NO CHART
      </text>
      <Tab x={26} y={156} />
    </Sticker>
  );
}
