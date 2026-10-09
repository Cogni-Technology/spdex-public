/**
 * The background: a faint line drawing of how spDEX is wired. Your wallet,
 * your network service and the chain, joined by dotted lines, and in the gap
 * where a server would usually be, an empty dashed circle: NO SERVER. True
 * of the code (AGENTS.md rule 5), and drawn rather than said.
 *
 * At the very end of the column, under the footer, in flow: nothing is
 * drawn over it and it is drawn over nothing (fixed behind the page, its
 * labels ran through the footer and the tiles, and the rails showed them as
 * clipped fragments). Wide screens only, hidden under more contrast, forced
 * colours and print (theme.css, "Art"). No motion.
 */

export function LinkMap() {
  return (
    <svg
      className="spdex-art spdex-linkmap"
      data-art="link-map"
      viewBox="0 0 1200 300"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      <g className="spdex-art__line" strokeWidth={4}>
        <rect x={80} y={150} width={190} height={118} />
        <path d="M80 182 H270 M104 236 H164 M104 252 H200" />
        <circle cx={410} cy={120} r={62} strokeDasharray="14 12" />
        <rect x={560} y={128} width={120} height={40} />
        <rect x={560} y={172} width={120} height={40} />
        <rect x={560} y={216} width={120} height={40} />
        <path d="M580 148 H600 M580 192 H600 M580 236 H600" />
        <path d="M830 196 L866 178 L902 196 L866 214 Z M830 196 V240 L866 258 V214 M902 196 V240 L866 258" />
        <path d="M940 196 L976 178 L1012 196 L976 214 Z M940 196 V240 L976 258 V214 M1012 196 V240 L976 258" />
        <path d="M1050 196 L1086 178 L1122 196 L1086 214 Z M1050 196 V240 L1086 258 V214 M1122 196 V240 L1086 258" />
        <path d="M902 218 H940 M1012 218 H1050" />
        <path d="M270 210 H560 M680 192 H830" strokeDasharray="4 12" strokeLinecap="round" />
      </g>
      <g className="spdex-art__data spdex-art__ink" fontSize={22} fontWeight={700} textAnchor="middle">
        <text x={175} y={132} textLength={160} lengthAdjust="spacingAndGlyphs">YOUR WALLET</text>
        <text x={410} y={128} textLength={92} lengthAdjust="spacingAndGlyphs">NO SERVER</text>
        <text x={620} y={112} textLength={170} lengthAdjust="spacingAndGlyphs">YOUR SERVICE</text>
        <text x={976} y={160} textLength={150} lengthAdjust="spacingAndGlyphs">THE CHAIN</text>
      </g>
    </svg>
  );
}
