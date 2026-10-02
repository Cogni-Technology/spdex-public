/**
 * Config migrations.
 *
 * A user's config is their property: they export it, share it, pin it to IPFS.
 * A file written by v0 has to open in v2, or "your configuration is a file you
 * own" is marketing rather than a promise.
 *
 * The machinery was there from the first commit, before a second schema
 * version existed, because retrofitting migrations is what forces the first
 * breaking change to be silently lossy. It has carried every bump since
 * (`CONFIG_SCHEMA_VERSION`). Adding a version means writing one function and
 * one test.
 */

import { CONFIG_SCHEMA_VERSION, SpdexConfigSchema, type SpdexConfig } from "@spdex/core";

export class ConfigMigrationError extends Error {
  constructor(message: string, readonly fromVersion: number) {
    super(message);
    this.name = "ConfigMigrationError";
  }
}

/**
 * One step per version bump: `MIGRATIONS[n]` upgrades a version-`n` config to
 * `n + 1`. Steps run over plain objects, never parsed values, because an old
 * config by definition does not satisfy the current schema.
 */
export const MIGRATIONS: Record<number, (config: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1 is the shape of every future step, and is exercised by tests even
  // though no v0 config was ever released: the machinery has to be known-good
  // before the first real migration depends on it.
  0: (config) => ({
    ...config,
    schemaVersion: 1,
    preset: config["preset"] ?? "custom",
    router: config["router"] ?? { chunkCount: 10, maxSplits: 4, minSplitGainBps: 5 },
    guard: config["guard"] ?? { requireSimulation: false, oracleDivergenceBps: 200 },
    extraTrustedContracts: config["extraTrustedContracts"] ?? [],
  }),

  // 1 -> 2 adds the submitter. The default is `wallet`, which is what a v1
  // config was already doing — a migration must never change behaviour the
  // user did not ask to change, and silently opting an existing config into
  // private submission would do exactly that.
  1: (config) => ({
    ...config,
    schemaVersion: 2,
    submitter: config["submitter"] ?? { mode: "wallet", url: null },
  }),

  // 2 -> 3 enables the Uniswap v2 venue.
  //
  // Enabling a venue does change routing, which a migration normally must not
  // do. It is right here because the user never expressed an opinion about v2 —
  // it did not exist when their config was written — and because leaving it off
  // means quoting SPX against roughly 2% of its liquidity. The v2 pair holds
  // about 55x the WETH of the deepest v3 pool. A config that explicitly lists
  // v2 already, in any state, is left exactly as it is.
  2: (config) => {
    const modules = Array.isArray(config["modules"]) ? [...(config["modules"] as unknown[])] : [];
    const names = new Set(
      modules
        .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
        .map((m) => m["id"]),
    );
    if (!names.has("venue-uniswap-v2")) {
      modules.push({
        id: "venue-uniswap-v2",
        version: "1.0.0",
        source: "builtin",
        enabled: true,
      });
    }
    return { ...config, schemaVersion: 3, modules };
  },

  // 3 -> 4 adds tip splits, switched off and with nobody in the list.
  //
  // The one setting in this file where the default is not a judgement call.
  // Every other migration asks "what was this config already doing?"; here the
  // answer is unambiguous — a config written before tips existed was tipping
  // nobody, and a migration that opted anyone into sending a share of their
  // swaps to a stranger would be indefensible regardless of how small the
  // share was or how good the cause.
  3: (config) => ({
    ...config,
    schemaVersion: 4,
    tips: config["tips"] ?? { enabled: false, recipients: [] },
  }),

  // 4 -> 5 enables the pool-statistics tracker.
  //
  // Turning a module on in a migration needs justifying, and the reasoning is
  // the one used for v2 in 2 -> 3: the user never expressed an opinion, because
  // it did not exist when their config was written. This one is easier still —
  // a tracker reads three token contracts, appears nowhere near a signature,
  // and replaces a liquidity proxy nobody could act on. A config that already
  // lists it, in any state, is left exactly as it is.
  4: (config) => {
    const modules = Array.isArray(config["modules"]) ? [...(config["modules"] as unknown[])] : [];
    const names = new Set(
      modules
        .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
        .map((m) => m["id"]),
    );
    if (!names.has("tracker-pool-stats")) {
      modules.push({
        id: "tracker-pool-stats",
        version: "1.0.0",
        source: "builtin",
        enabled: true,
      });
    }
    return { ...config, schemaVersion: 5, modules };
  },

  // 5 -> 6 adds auto-buy, switched off and with no plans.
  //
  // No judgement call, for the reason given for tips in 3 -> 4: a config
  // written before plans existed was buying nothing on a timer, and a
  // migration that started spending the user's money on one would be
  // indefensible however sensible the plan. Unlike 4 -> 5, no module is
  // added, not even switched off: the scheduler arrives with the feature, when
  // the user turns auto-buy on, and the preset leaves it out for the same
  // reason, so an untouched config still compares equal to the preset. A file
  // that already carries a `dca` section — only a hand-edited one could — keeps
  // it and is judged by the schema at the end, and if it came in through
  // `importConfig` its plans arrive paused.
  5: (config) => ({
    ...config,
    schemaVersion: 6,
    dca: config["dca"] ?? { enabled: false, plans: [] },
  }),

  // 6 -> 7 changes nothing. Version 7 lets a plan name a third signer,
  // `"vault"`, and hold the address of the vault it created; a v6 config uses
  // neither, so every v6 config is already a valid v7 one, and a step that
  // added anything would be changing behaviour nobody asked to change.
  //
  // The version moves anyway, for the builds that came before it. A v6 build
  // handed a v7 config now refuses it as newer than it understands — "update
  // spDEX" — rather than rejecting a signer it has never heard of as a broken
  // file. That error would invite the wrong repair: edit the plan into a
  // wallet or autopilot plan and it opens, and resumed, it would buy from the
  // tab, out of the wallet, while its vault goes on buying on chain — every
  // buy made twice. What an older build does after refusing is its own: the
  // web app's `loadConfig` falls back to the preset for a newer config and a
  // broken one alike, so the bump buys an honest reason, not a kept config.
  6: (config) => ({ ...config, schemaVersion: 7 }),

  // 7 -> 8 removes the autopilot signer. Every plan that named it becomes a
  // wallet plan — same id, pair, amount, interval, number of buys and start —
  // and is paused, whatever it was.
  //
  // A wallet plan, not a vault plan, because it is the one an edit can make:
  // a vault plan pays with ether only and is a contract that has to be created
  // and funded on chain, which a migration cannot do and should not decide
  // to. And because the id is kept, so is everything this browser recorded
  // under it — buys made, budget committed, history — and a resumed plan goes
  // on from where it stopped instead of starting its budget again.
  //
  // Paused, because running it would change behaviour nobody asked to change,
  // which is the one thing a migration must never do (see 1 -> 2). An
  // autopilot plan bought without asking, from money the owner had already
  // moved into its spending wallet; a running wallet plan asks the owner's
  // wallet to pay for each buy. That is a new instruction, so it waits for the
  // owner to give it: Resume states the terms again before anything is bought.
  //
  // The spending wallet is not config, and nothing here can reach it. No
  // release ever made one, and since 2026-10-02 the app no longer reads them
  // either: the withdrawal it kept for them was removed.
  7: (config) => {
    const dca = config["dca"];
    if (typeof dca !== "object" || dca === null || !Array.isArray((dca as Record<string, unknown>)["plans"])) {
      // Nothing to convert. The schema judges whatever this is at the end.
      return { ...config, schemaVersion: 8 };
    }
    const plans = ((dca as Record<string, unknown>)["plans"] as unknown[]).map((plan) =>
      typeof plan === "object" && plan !== null && (plan as Record<string, unknown>)["signer"] === "autopilot"
        ? { ...(plan as Record<string, unknown>), signer: "wallet", paused: true }
        : plan,
    );
    return { ...config, schemaVersion: 8, dca: { ...(dca as Record<string, unknown>), plans } };
  },

  // 8 -> 9 adds the second opinion, with no service set: a v8 config was
  // test-running every transaction on one service, and so does this one. A
  // migration choosing a second service would be spDEX choosing who sees
  // what the user is about to sign, which only the user may do.
  //
  // `guard.secondOpinion` is added only where it is absent. A `guard` that
  // is missing or not an object is left exactly as it is, for the schema to
  // judge at the end: filling one in would turn a broken file into a
  // working one with settings nobody chose.
  //
  // The version moves because a v8 build must refuse a v9 file ("update
  // spDEX") rather than open it: zod drops keys it doesn't know, so a v8
  // build would quietly lose a second opinion the user switched on, and
  // with it a check the user believes is running.
  8: (config) => {
    const guard = config["guard"];
    if (typeof guard !== "object" || guard === null || Array.isArray(guard)) {
      return { ...config, schemaVersion: 9 };
    }
    if ("secondOpinion" in guard) return { ...config, schemaVersion: 9 };
    return { ...config, schemaVersion: 9, guard: { ...guard, secondOpinion: { url: null } } };
  },
};

function readVersion(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigMigrationError("config is not an object", -1);
  }
  const version = (raw as Record<string, unknown>)["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new ConfigMigrationError("config has no usable schemaVersion", -1);
  }
  return version;
}

/**
 * Bring any supported config up to the current schema, then validate it.
 *
 * Validation happens once, at the end: intermediate shapes are not expected to
 * satisfy today's schema, and checking them would make every migration step
 * responsible for a schema it predates.
 */
export function migrateConfig(raw: unknown): SpdexConfig {
  let version = readVersion(raw);

  if (version > CONFIG_SCHEMA_VERSION) {
    // Newer than this build understands. Refusing is the honest outcome: a
    // best-effort downgrade would silently drop settings the user set
    // deliberately, and they would not find out until a swap behaved oddly.
    throw new ConfigMigrationError(
      `config is version ${version}, this build understands up to ${CONFIG_SCHEMA_VERSION} — update spDEX`,
      version,
    );
  }

  let working = { ...(raw as Record<string, unknown>) };
  while (version < CONFIG_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new ConfigMigrationError(`no migration from version ${version}`, version);
    }
    working = step(working);
    const next = readVersion(working);
    if (next <= version) {
      // A step that fails to advance would loop forever; fail loudly instead.
      throw new ConfigMigrationError(`migration from ${version} did not advance the version`, version);
    }
    version = next;
  }

  return SpdexConfigSchema.parse(working);
}
