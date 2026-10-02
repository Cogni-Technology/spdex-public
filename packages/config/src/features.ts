/**
 * Features — the user-facing name for "which modules am I running?".
 *
 * ## Why this layer exists
 *
 * The config is the real state: a list of module ids, a pool policy, a
 * submitter, a tip policy, any auto-buy plans. That is the honest model and
 * the expert editor exposes it directly. But "enable venue-uniswap-v2" is not
 * a decision anybody arrives wanting to make, and a first-run screen that asks
 * it is a first-run screen people click past without reading — which is worse
 * than not asking, because it manufactures the appearance of a choice.
 *
 * A feature is therefore a *named capability with a stated cost*, and the
 * catalogue below is the only place that maps one to the config changes it
 * implies. Recommended mode edits features; expert mode edits the config; both
 * write the same object. There is no feature that cannot be expressed as
 * config, which is the property that keeps this from becoming a second,
 * divergent source of truth.
 *
 * ## Honesty about what is a module
 *
 * `modules` lists the module ids a feature activates, and it is empty for
 * features that are host settings rather than modules. Saying so is the point:
 * the claim "every feature is a module" is not yet true, and a catalogue that
 * quietly implied otherwise would be the kind of overstatement this repo keeps
 * finding in its own docs. Each entry says which it is.
 */

import { MAX_TOTAL_TIP_BPS, type SpdexConfig } from "@spdex/core";

export interface Feature {
  id: string;
  name: string;
  /** One line, shown next to the toggle. */
  tagline: string;
  /** What it actually does, and why you might not want it. */
  detail: string;
  /**
   * Module ids this feature turns on. Empty means it is a host setting — a
   * distinction the UI shows rather than hides.
   */
  modules: readonly string[];
  /** What it costs: gas, latency, privacy, compatibility. Shown in the modal. */
  cost?: string;
  /** On in the shipped preset. */
  recommended: boolean;
  isEnabled(config: SpdexConfig): boolean;
  enable(config: SpdexConfig): SpdexConfig;
  disable(config: SpdexConfig): SpdexConfig;
}

/** Turn a module on or off without disturbing the rest of the list. */
function withModule(config: SpdexConfig, id: string, enabled: boolean): SpdexConfig {
  const existing = config.modules.find((m) => m.id === id);
  const modules = existing
    ? config.modules.map((m) => (m.id === id ? { ...m, enabled } : m))
    : [...config.modules, { id, version: "1.0.0", source: "builtin" as const, enabled }];
  return { ...config, modules };
}

const moduleEnabled = (config: SpdexConfig, id: string) =>
  config.modules.some((m) => m.id === id && m.enabled);

/** A venue feature is exactly one module, on or off. */
function venueFeature(options: {
  id: string;
  moduleId: string;
  name: string;
  tagline: string;
  detail: string;
  cost?: string;
}): Feature {
  return {
    id: options.id,
    name: options.name,
    tagline: options.tagline,
    detail: options.detail,
    modules: [options.moduleId],
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    recommended: true,
    isEnabled: (config) => moduleEnabled(config, options.moduleId),
    enable: (config) => withModule(config, options.moduleId, true),
    disable: (config) => withModule(config, options.moduleId, false),
  };
}

export const TRACKER_FEATURE_ID = "pool-stats";
export const TRACKER_MODULE_ID = "tracker-pool-stats";
export const TIP_FEATURE_ID = "tip-splits";
export const TIPLIST_MODULE_ID = "tiplist-spx-community";
export const DCA_FEATURE_ID = "auto-buy";
export const SCHEDULER_MODULE_ID = "scheduler-dca";

export const FEATURE_CATALOG: readonly Feature[] = [
  venueFeature({
    id: "venue-uniswap-v2",
    moduleId: "venue-uniswap-v2",
    name: "Uniswap v2",
    tagline: "Swap on Uniswap v2 markets.",
    detail:
      "Where most SPX liquidity is: the v2 pair holds far more WETH than any v3 pool. " +
      "Turned off, SPX is quoted against a sliver of its market, and nothing looks wrong.",
    cost: "One more market to quote per route.",
  }),
  venueFeature({
    id: "venue-uniswap-v3",
    moduleId: "venue-uniswap-v3",
    name: "Uniswap v3",
    tagline: "Swap on Uniswap v3 markets.",
    detail:
      "Concentrated liquidity across four fee tiers. Often best for WETH and USDC pairs, and " +
      "worth quoting even when v2 takes the whole route.",
    cost: "One more market to quote per route.",
  }),
  {
    id: TRACKER_FEATURE_ID,
    name: "Pool statistics",
    tagline: "See what each market holds before you swap.",
    detail:
      "A tracker reads each pool's real balances, priced with the Guard's 10-minute average: " +
      "value held, fee tier, recent volume and share of the pair. It reads only the tokens it " +
      "declares.",
    cost:
      "Two reads per pool, one log query for volume, one supply read an hour for the ticker. " +
      "Display only, never part of a transaction.",
    modules: [TRACKER_MODULE_ID],
    // On by default. Routing without knowing where the liquidity is was the
    // status quo, not a considered choice, and the opaque `depth` figure the
    // pool picker used to show is strictly worse than a real number.
    recommended: true,
    isEnabled: (config) => moduleEnabled(config, TRACKER_MODULE_ID),
    enable: (config) => withModule(config, TRACKER_MODULE_ID, true),
    disable: (config) => withModule(config, TRACKER_MODULE_ID, false),
  },
  {
    id: TIP_FEATURE_ID,
    name: "Tip splits",
    tagline: "Send a small share of each swap to people you choose.",
    detail:
      "After a swap settles, a share of what you received goes to the people you picked — " +
      "from the delivered amount, not the quote. The Guard checks every tip transaction and " +
      `signature before your wallet sees it. The total is capped at ${MAX_TOTAL_TIP_BPS / 100}%.`,
    // spDEX has no contract of its own that tips (its one contract is the
    // auto-buy vault), so two or more people are batched through Uniswap's
    // Permit2, and what that costs is a standing permission, said here in full.
    cost:
      "One transaction for one person. For two or more: one signature and one transaction " +
      "through Uniswap's Permit2, and the first time a standing Permit2 permission for that " +
      "token. It's unlimited until you revoke it in Settings → Tips. While it stands, read " +
      "any Permit2 signature for that token as closely as a transaction.",
    modules: [TIPLIST_MODULE_ID],
    recommended: false,
    isEnabled: (config) => config.tips.enabled,
    enable: (config) => ({
      ...withModule(config, TIPLIST_MODULE_ID, true),
      tips: { ...config.tips, enabled: true },
    }),
    // The recipient list is kept, not cleared. Turning the feature off should
    // stop the tipping, not silently discard a list the user assembled — and
    // `enabled: false` already means nothing is sent.
    disable: (config) => ({
      ...withModule(config, TIPLIST_MODULE_ID, false),
      tips: { ...config.tips, enabled: false },
    }),
  },
  {
    id: DCA_FEATURE_ID,
    name: "Auto-buy",
    // Not "dollar-cost averaging" here: the default plan pays in ETH, not
    // dollars, and the term is explained where it is used (the detail and the
    // recurring form), with its meaning a hover away.
    tagline: "Buy a little at a time, on a schedule.",
    // The limits are in the description rather than the small print because
    // they are the ones a newcomer would not guess: an app with no server
    // cannot act while it is closed, a plan the wallet signs cannot act while
    // nobody is there to confirm, and a vault is the one kind this switch
    // cannot stop. The Guard sentence states what the Guard enforces, not
    // what we intend; the vault's, what its contract does. The fee figures
    // are the vault's constants (`BUY_FEE_MARKUP_BPS`, `BUY_FEE_CEILING_BPS` in
    // @spdex/vault), which config does not depend on, so they are written out.
    detail:
      "Buys on a schedule, two ways. Confirm each buy: your wallet asks each time, so buys " +
      "happen only while spDEX is open in a tab and you're there, and the Guard checks each " +
      "one. Or a vault: a contract you create that holds the budget and buys SPX with ETH " +
      "when anyone triggers a due buy. No one is guaranteed to trigger it. It's unaudited, you " +
      "can put at most 0.5 ETH into one, and closing it is the only way to stop it: switching " +
      "Auto-buy off here doesn't. Either way, a missed time is skipped, never doubled up. " +
      "Scheduled buys never tip.",
    cost:
      "Confirm each buy: one network fee a buy, plus a permission when paying with a token. A " +
      "vault: the network fee to create and close it, and a buy fee from its budget — a fixed " +
      "amount for network fees plus 10% of that, never more than 0.69% of the buy — to whoever " +
      "triggers each buy.",
    modules: [SCHEDULER_MODULE_ID],
    // Off by default, and it has to be: it spends money on a timer. The
    // preset carries no plans either, so turning this on alone buys nothing.
    recommended: false,
    isEnabled: (config) => config.dca.enabled,
    enable: (config) => ({
      ...withModule(config, SCHEDULER_MODULE_ID, true),
      dca: { ...config.dca, enabled: true },
    }),
    // The plans are kept, as the tip list is. This is the switch that stops
    // every plan at once, and a stop that also deleted what the user set up
    // would make people reluctant to reach for it.
    disable: (config) => ({
      ...withModule(config, SCHEDULER_MODULE_ID, false),
      dca: { ...config.dca, enabled: false },
    }),
  },
  {
    id: "private-submission",
    name: "Private sending",
    tagline: "Send swaps through a private relay, out of sight of bots watching the public queue.",
    detail:
      "Your wallet signs without broadcasting, and spDEX posts the signed transaction to a relay " +
      "such as Flashbots Protect, so it can't be seen and front-run in the public mempool. Most " +
      "wallets can't; when yours can't, spDEX stops and asks.",
    cost: "Slower inclusion: the relay offers it block by block. A host setting, not a module.",
    modules: [],
    recommended: false,
    isEnabled: (config) => config.submitter.mode === "private",
    enable: (config) => ({
      ...config,
      submitter: {
        ...config.submitter,
        mode: "private",
        url: config.submitter.url ?? "https://rpc.flashbots.net/fast",
      },
    }),
    disable: (config) => ({ ...config, submitter: { ...config.submitter, mode: "wallet" } }),
  },
  {
    id: "strict-sandbox",
    name: "Extra isolation",
    tagline: "Run even spDEX's own plug-ins in a locked box. Slower, same results.",
    detail:
      "Built-in modules normally run natively: faster, and no more trusted. Both runtimes get " +
      "the same capabilities and their plans pass the same Guard. Turn this on to run " +
      "everything in the sandbox and see that the fast path was never load-bearing.",
    cost: "Noticeably slower quotes. A host setting, not a module.",
    modules: [],
    recommended: false,
    isEnabled: (config) => config.strictSandbox,
    enable: (config) => ({ ...config, strictSandbox: true }),
    disable: (config) => ({ ...config, strictSandbox: false }),
  },
];

export function featureById(id: string): Feature | undefined {
  return FEATURE_CATALOG.find((feature) => feature.id === id);
}

/**
 * Apply a feature toggle, marking the config as no longer the shipped preset.
 *
 * Going through here rather than calling `enable`/`disable` directly is what
 * keeps the diff view truthful: a config that departs from the preset has to
 * say so, or "difference from recommended" quietly under-reports.
 */
export function setFeature(config: SpdexConfig, id: string, enabled: boolean): SpdexConfig {
  const feature = featureById(id);
  if (!feature) return config;
  const next = enabled ? feature.enable(config) : feature.disable(config);
  return { ...next, preset: "custom" };
}

/** Features currently on, for a one-line summary. */
export function enabledFeatures(config: SpdexConfig): Feature[] {
  return FEATURE_CATALOG.filter((feature) => feature.isEnabled(config));
}
