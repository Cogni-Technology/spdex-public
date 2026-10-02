/**
 * Shipped presets.
 *
 * "Recommended mode" is not a different application — it is this object written
 * into the same `SpdexConfig` the expert editor exposes. A beginner and a
 * cypherpunk run identical code with different values, so there is no simplified
 * path that quietly behaves differently from the real one.
 */

import { CONFIG_SCHEMA_VERSION, type SpdexConfig } from "@spdex/core";

/**
 * Sensible defaults for someone who has not asked for an opinion.
 *
 * Every value here is one the expert editor can change; none of it is
 * privileged. The point of the preset is to be a good starting position, not a
 * separate mode of operation.
 */
export function recommendedConfig(): SpdexConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    preset: "recommended",
    chainId: 1,

    // No address on purpose: "bundled" is this copy's built-in service, which
    // the app fills in where its key works (the canonical origins), after the
    // first visit's disclaimer. Anywhere else (an IPFS copy, a self-hosted one)
    // the first-run screen asks, because the key only works where it is
    // allowlisted.
    rpc: { url: null, source: "bundled" },

    slippageBps: 50,
    deadlineSeconds: 600,

    // Off by default: first-party modules run natively for speed. A user who
    // wants to check that the fast path was never load-bearing turns this on
    // and everything routes through the sandbox instead.
    strictSandbox: false,

    // Both venues on by default. v2 holds the overwhelming majority of SPX
    // liquidity — about 55x the WETH of the deepest v3 pool at the pinned
    // block — so a preset without it would quote SPX against a sliver of the
    // market while looking perfectly reasonable.
    modules: [
      { id: "venue-uniswap-v2", version: "1.0.0", source: "builtin", enabled: true },
      { id: "venue-uniswap-v3", version: "1.0.0", source: "builtin", enabled: true },
      // On by default. It reads three token contracts and never touches a
      // transaction, and the alternative is the pool picker's opaque `depth`
      // proxy — which is a number nobody can act on.
      { id: "tracker-pool-stats", version: "1.0.0", source: "builtin", enabled: true },
    ],

    // `recommended` routes across whatever the enabled venues discover.
    // Switching to `allowlist` is what makes "use this pool and nothing else"
    // literally true.
    // Public broadcast by default. Private submission needs a wallet that will
    // sign without broadcasting, which most will not, so defaulting to it would
    // mean most users hit a failure on their first swap.
    submitter: { mode: "wallet", url: null },

    pools: { mode: "recommended", allow: [], deny: [] },

    router: { chunkCount: 10, maxSplits: 4, minSplitGainBps: 5 },

    // `requireSimulation` is off by default so a user on a limited endpoint can
    // still swap — but the UI shows UNVERIFIED in bold when it is unavailable,
    // and this flag turns that warning into a refusal.
    //
    // The divergence tolerance is 500 rather than something tighter because of
    // what the check actually compares: an executed price net of pool fee and
    // price impact, against an oracle mid price. A 1% pool accounts for 100 bps
    // of that before the trade has moved anything. Set too tight, it warns on
    // every healthy swap and teaches people to scroll past it.
    //
    // No second opinion: which second service sees what the user is about
    // to sign is theirs to choose, and a preset that chose one would be
    // spDEX handing every transaction to a party the user never picked.
    guard: { requireSimulation: false, oracleDivergenceBps: 500, secondOpinion: { url: null } },

    // Off, and empty. Tipping is opt-in from the features modal: a preset that
    // arrived with recipients already in it would be spDEX choosing who gets
    // the user's money, which is the one thing a preset must never do.
    tips: { enabled: false, recipients: [] },

    // Off, and no plans. An auto-buy spends the user's money on a timer with
    // nobody clicking anything when it happens; a preset that arrived with a
    // plan in it would be spDEX deciding to spend, which is the one thing a
    // preset must never do. The scheduler module is absent too, not merely
    // off: it arrives with the feature, when the user turns auto-buy on, and
    // the 5 -> 6 migration adds nothing to `modules` either, so a migrated
    // config the user never touched still compares equal to this one.
    dca: { enabled: false, plans: [] },

    extraTrustedContracts: [],
  };
}
