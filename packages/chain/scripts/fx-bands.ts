/**
 * `pnpm fx:bands`: is every currency still well inside its band?
 *
 * The app reads every rate live from Chainlink, and counts an answer as
 * unknown when it is outside 0.2× to 5× of its reference (`FX_REFERENCE`,
 * src/fx.ts). The references are the feeds' answers at the fork's pinned
 * block, and move only with it (docs/IPFS-RELEASE.md, "Read the currency
 * feeds"), so what can go wrong is slow: a currency drifting toward the edge
 * of its band (the Argentine peso is the likeliest), until amounts typed in
 * it read as unavailable.
 *
 * This reads every feed now, judges each as the app does (`fxProblem`), and
 * fails when any is unusable or has drifted past `WARN_FACTOR` either way:
 * well before the band's edge, so there is time to move the pinned block and
 * the references with it. `.github/workflows/fx-bands.yml` runs it every
 * week. It reads through SPDEX_FORK_RPC_URL (the repo's `.env` files, or the
 * environment), and only reads.
 */

import { FX_BAND_FACTOR, FX_CODES, FX_REFERENCE, fxProblem, readFxRates, type FxAnswer, type FxFeedName } from "../src/fx.js";
import { Multicall3Reader, httpRpc } from "../src/reader.js";
import { resolvedEnv } from "../../../scripts/env.mjs";

/** Past this factor from its reference, either way, a currency is flagged: 3×, against the band's 5×. */
export const WARN_FACTOR = 3;

const url = resolvedEnv()["SPDEX_FORK_RPC_URL"];
if (url === undefined || url === "") {
  console.error("SPDEX_FORK_RPC_URL is not set: put a mainnet endpoint in .env.local, or in the environment.");
  process.exit(2);
}

const read = await readFxRates(new Multicall3Reader(httpRpc(url)));
const feeds: [FxFeedName, FxAnswer | null | undefined][] = [
  ...FX_CODES.map((code): [FxFeedName, FxAnswer | undefined] => [code, read.rates[code]]),
  ["USDC", read.usdc],
  ["ETH", read.eth],
];

let flagged = 0;
for (const [feed, answer] of feeds) {
  const problem = fxProblem(feed, answer, read.chainTime);
  const ratio = answer === null || answer === undefined ? null : Number(answer.answer) / Number(FX_REFERENCE[feed]);
  const drifting = ratio !== null && (ratio > WARN_FACTOR || ratio < 1 / WARN_FACTOR);
  if (problem !== null || drifting) flagged += 1;
  const shown = ratio === null ? "—" : `${ratio.toFixed(3)}×`;
  const verdict = problem ?? (drifting ? `past ${WARN_FACTOR}×: move the pinned block before it reaches ${FX_BAND_FACTOR}×` : "ok");
  console.log(`${feed.padEnd(5)} ${shown.padStart(9)} its reference  ${verdict}`);
}
console.log(`block ${read.block}: ${feeds.length - flagged} of ${feeds.length} well inside their bands`);
process.exit(flagged === 0 ? 0 : 1);
