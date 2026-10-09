import { describe, expect, it } from "vitest";
import { SpdexConfigSchema, type DcaPlan, type SpdexConfig } from "@spdex/core";
import { recommendedConfig } from "./presets.js";
import { ConfigMigrationError, migrateConfig } from "./migrate.js";
import {
  ConfigParseError,
  arrivePaused,
  exportJson,
  exportToml,
  importConfig,
  readShareFragment,
  shareFragment,
} from "./io.js";
import { diffConfig, diffFromPreset, isPreset } from "./diff.js";
import {
  DCA_FEATURE_ID,
  FEATURE_CATALOG,
  SCHEDULER_MODULE_ID,
  TIP_FEATURE_ID,
  featureById,
  setFeature,
} from "./features.js";
import { updateDcaPlan } from "./dca.js";

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
/** A vault's address, as a plan records it once the vault exists. */
const VAULT = "0x6de035555360a81c068559954bd7ee97cde8e201";

/**
 * A plan as the UI would write one. Paused by default, because that is how
 * every plan comes back from an import — a fixture built active would make
 * each round-trip test about the pause rule rather than about the round trip.
 */
function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "dca-0a1b2c3d",
    paused: true,
    chainId: 1,
    sell: ETH,
    buy: SPX,
    amountPerBuy: "10000000000000000",
    intervalSeconds: 86_400,
    maxBuys: 30,
    startAt: 1_790_000_000,
    signer: "wallet",
    ...overrides,
  };
}

/** Auto-buy switched on through the feature, holding exactly these plans. */
function withPlans(...plans: DcaPlan[]): SpdexConfig {
  const on = setFeature(recommendedConfig(), DCA_FEATURE_ID, true);
  return { ...on, dca: { ...on.dca, plans } };
}

/**
 * Two plans that between them touch every field a tab plan has: a label and
 * none, ether and a token, and amounts past 2^53 — which TOML would turn into
 * a float if they were numbers rather than decimal strings. (A vault plan's
 * own round trip is tested on its own below.)
 */
function twoPlans(): SpdexConfig {
  return withPlans(
    plan({
      id: "dca-eth-spx",
      label: "Stack SPX, daily",
      amountPerBuy: "123456789012345678901234567890",
    }),
    plan({
      id: "dca-usdc-spx",
      sell: USDC,
      amountPerBuy: "25000000",
      intervalSeconds: 7 * 86_400,
      maxBuys: 12,
      startAt: 1_800_000_000,
    }),
  );
}

/** The same config with every plan running, as this browser would hold it. */
function running(config: SpdexConfig): SpdexConfig {
  const plans = config.dca.plans.map((p) => ({ ...p, paused: false }));
  return { ...config, dca: { ...config.dca, plans } };
}

describe("the recommended preset", () => {
  it("satisfies the schema", () => {
    expect(() => SpdexConfigSchema.parse(recommendedConfig())).not.toThrow();
  });

  it("leaves the RPC unset so first-run has to ask", () => {
    // The bundled key only works on the canonical origin, so assuming one would
    // silently break every IPFS and self-hosted copy.
    expect(recommendedConfig().rpc.url).toBeNull();
  });

  it("does not force the sandbox, and enables both venues", () => {
    // v2 matters: it holds roughly 98% of SPX's WETH-side liquidity, so a
    // preset with only v3 would quote SPX against a sliver of the market.
    const config = recommendedConfig();
    expect(config.strictSandbox).toBe(false);

    const enabled = config.modules.filter((m) => m.enabled).map((m) => m.id);
    expect(enabled).toContain("venue-uniswap-v2");
    expect(enabled).toContain("venue-uniswap-v3");
  });

  it("migrates an older config onto the new venue without discarding its choices", () => {
    // The user never had an opinion about v2 — it did not exist — so enabling
    // it is filling a gap rather than overriding a decision. Everything they
    // did choose must survive untouched.
    const v2Era = { ...recommendedConfig(), schemaVersion: 2, slippageBps: 17, modules: [
      { id: "venue-uniswap-v3", version: "1.0.0", source: "builtin", enabled: false },
    ] } as unknown;

    const migrated = migrateConfig(v2Era);
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.slippageBps).toBe(17);
    // Their explicit decision to disable v3 is preserved.
    expect(migrated.modules.find((m) => m.id === "venue-uniswap-v3")?.enabled).toBe(false);
    expect(migrated.modules.find((m) => m.id === "venue-uniswap-v2")?.enabled).toBe(true);
  });

  it("has auto-buy off, with no plans and no scheduler module", () => {
    // A preset that could spend on a timer would be spDEX deciding to spend.
    const config = recommendedConfig();
    expect(config.dca).toEqual({ enabled: false, plans: [] });
    expect(config.modules.map((m) => m.id)).not.toContain(SCHEDULER_MODULE_ID);
  });

  it("agrees with the feature catalogue about what is on", () => {
    // `recommended` is what the modal says ships on. If it disagreed with the
    // preset, the dialog a newcomer sees first would misdescribe their config.
    const config = recommendedConfig();
    for (const feature of FEATURE_CATALOG) {
      expect(feature.isEnabled(config), feature.id).toBe(feature.recommended);
    }
  });
});

describe("round-tripping", () => {
  it("survives TOML export and import unchanged", () => {
    const config = recommendedConfig();
    expect(importConfig(exportToml(config))).toEqual(config);
  });

  it("survives JSON export and import unchanged", () => {
    const config = recommendedConfig();
    expect(importConfig(exportJson(config))).toEqual(config);
  });

  it("round-trips a heavily customised config", () => {
    const config = {
      ...recommendedConfig(),
      preset: "custom" as const,
      strictSandbox: true,
      slippageBps: 125,
      pools: {
        mode: "allowlist" as const,
        allow: [{ venueId: "venue-uniswap-v3", poolId: "0xabc", label: "SPX/WETH 1%" }],
        deny: [{ venueId: "venue-uniswap-v3", poolId: "0xdef" }],
      },
      rpc: { url: "https://example.invalid/rpc", source: "user" as const },
    };
    expect(importConfig(exportToml(config))).toEqual(config);
  });

  it("survives a URL fragment", () => {
    const config = recommendedConfig();
    expect(readShareFragment(`#config=${shareFragment(config)}`)).toEqual(config);
  });

  it("accepts a bare fragment without the prefix", () => {
    const config = recommendedConfig();
    expect(readShareFragment(shareFragment(config))).toEqual(config);
  });

  it("treats an omitted RPC url as null, since TOML has no null", () => {
    // Exporting a config with no RPC set drops the key entirely. If import did
    // not accept that, export would be a one-way door for exactly the config a
    // first-run user has.
    const exported = exportToml(recommendedConfig());
    // Check the parsed structure, not the raw text — the file's header comment
    // legitimately mentions URLs.
    expect(exported).not.toMatch(/^\s*url\s*=/m);
    expect(importConfig(exported).rpc.url).toBeNull();
  });

  it("rejects malformed input at the boundary", () => {
    expect(() => importConfig("")).toThrow(ConfigParseError);
    expect(() => importConfig("{not json")).toThrow(ConfigParseError);
    expect(() => readShareFragment("#config=!!!not-base64!!!")).toThrow(ConfigParseError);
  });

  it("rejects a structurally valid config with impossible values", () => {
    // Round-tripping must not become a way to smuggle past validation.
    const bad = { ...recommendedConfig(), slippageBps: 99_999 };
    expect(() => importConfig(JSON.stringify(bad))).toThrow();
  });

  it("round-trips vault plans exactly, before and after their vault exists", () => {
    // Already paused — a vault plan always is — so unlike a running tab plan
    // nothing about it changes on the way back in, the vault's address included.
    const config = withPlans(
      plan({ id: "dca-vault-new", signer: "vault" }),
      plan({ id: "dca-vault-made", signer: "vault", label: "In the vault", vault: VAULT }),
    );
    expect(importConfig(exportToml(config))).toEqual(config);
    expect(importConfig(exportJson(config))).toEqual(config);
    expect(readShareFragment(`#config=${shareFragment(config)}`)).toEqual(config);
  });

  it("round-trips auto-buy plans through TOML, JSON and a link unchanged", () => {
    const config = twoPlans();
    expect(importConfig(exportToml(config))).toEqual(config);
    expect(importConfig(exportJson(config))).toEqual(config);
    expect(readShareFragment(`#config=${shareFragment(config)}`)).toEqual(config);
  });

  it("refuses an imported plan the schema rejects, rather than dropping it", () => {
    // Below the interval floor. Dropping the plan and importing the rest would
    // leave the user believing they had accepted something they had not.
    const bad = withPlans(plan({ intervalSeconds: 60 }));
    expect(() => importConfig(exportJson(bad))).toThrow();
  });
});

describe("plans arriving from outside this browser", () => {
  it("arrive paused from a pasted file, TOML or JSON, with nothing else changed", () => {
    // Paste-import applies at once, with no review step — which is why the
    // rule lives in importConfig rather than in the UI's staging prompt.
    const theirs = running(twoPlans());
    expect(importConfig(exportToml(theirs))).toEqual(twoPlans());
    expect(importConfig(exportJson(theirs))).toEqual(twoPlans());
  });

  it("arrive paused from a shared link", () => {
    const theirs = running(twoPlans());
    const staged = readShareFragment(`#config=${shareFragment(theirs)}`);
    expect(staged.dca.plans.map((p) => p.paused)).toEqual([true, true]);
    // The master switch passes through: with every plan paused it starts
    // nothing, and the staged diff shows it.
    expect(staged.dca.enabled).toBe(true);
  });

  it("stay running in the config this browser reads back for itself", () => {
    // Storage is read through migrateConfig, not importConfig: the user's own
    // plans must survive a reload, or every refresh would stop them.
    const mine = running(twoPlans());
    expect(migrateConfig(JSON.parse(exportJson(mine)))).toEqual(mine);
  });

  it("leave a vault plan exactly as it was, since it is already paused", () => {
    // Nothing in the config can stop a vault; arriving paused changes nothing
    // about one, and must not fail on one either.
    const vaultPlan = plan({ id: "dca-vault", signer: "vault", vault: VAULT });
    const theirs = withPlans(plan({ id: "dca-tab", paused: false }), vaultPlan);

    const arrived = importConfig(exportJson(theirs));
    expect(arrived.dca.plans).toEqual([plan({ id: "dca-tab" }), vaultPlan]);
    expect(arrivePaused(withPlans(vaultPlan))).toEqual(withPlans(vaultPlan));
  });

  it("are paused by arrivePaused, which leaves everything else untouched", () => {
    const config = withPlans(
      plan({ id: "dca-a", paused: false }),
      plan({ id: "dca-b", label: "held" }),
    );
    const snapshot = structuredClone(config);

    const arrived = arrivePaused(config);
    expect(arrived).toEqual({
      ...config,
      dca: {
        enabled: true,
        plans: [plan({ id: "dca-a", paused: true }), plan({ id: "dca-b", label: "held" })],
      },
    });
    // A pure function: the config it was handed is not modified.
    expect(config).toEqual(snapshot);
    expect(arrivePaused(recommendedConfig())).toEqual(recommendedConfig());
  });
});

describe("migrations", () => {
  it("upgrades an older config to the current schema", () => {
    // The v0 shape is synthetic — no v0 was ever released — but exercising the
    // chain now is what makes the first real migration safe.
    const legacy = {
      schemaVersion: 0,
      chainId: 1,
      rpc: { url: null, source: "bundled" },
      slippageBps: 50,
      deadlineSeconds: 600,
      strictSandbox: false,
      modules: [{ id: "venue-uniswap-v3", version: "1.0.0", source: "builtin", enabled: true }],
      pools: { mode: "recommended", allow: [], deny: [] },
    };

    const migrated = migrateConfig(legacy);
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.router.chunkCount).toBe(10);
    expect(migrated.extraTrustedContracts).toEqual([]);
    // Nor does any old file arrive with a second service seeing its transactions.
    expect(migrated.guard.secondOpinion).toEqual({ url: null });
    // Every standing instruction to move money arrives off and empty, however
    // far back the file started.
    expect(migrated.tips).toEqual({ enabled: false, recipients: [] });
    expect(migrated.dca).toEqual({ enabled: false, plans: [] });
    expect(migrated.modules.map((m) => m.id)).not.toContain(SCHEDULER_MODULE_ID);
  });

  it("moves a v6 config to v9 and changes nothing else when it has no autopilot plan", () => {
    // Version 7 only admits new values; a v6 config holds none of them. (The
    // fixture already carries v9's second opinion, so 8 -> 9 adds nothing.)
    const v6 = { ...running(twoPlans()), schemaVersion: 6 };
    expect(migrateConfig(v6)).toEqual({ ...v6, schemaVersion: 9 });
    expect(isPreset(recommendedConfig(), migrateConfig({ ...recommendedConfig(), schemaVersion: 6 }))).toBe(true);
  });

  it("judges a vault plan in a hand-edited v6 file by the v7 schema", () => {
    // Only a hand edit could put one there. It is kept when it is a valid v7
    // plan and refused when it is not — here, a vault plan claiming to run.
    const vaultPlan = plan({ id: "dca-vault", signer: "vault", vault: VAULT });
    const handEdited = { ...withPlans(vaultPlan), schemaVersion: 6 };
    expect(migrateConfig(handEdited).dca.plans).toEqual([vaultPlan]);

    const claimsToRun = { ...withPlans({ ...vaultPlan, paused: false }), schemaVersion: 6 };
    expect(() => migrateConfig(claimsToRun)).toThrow(/always paused/);
  });

  it("turns an autopilot plan into a paused wallet plan with the same terms, leaving every other plan alone", () => {
    // What a v7 config holds for someone who used autopilot. The plan keeps
    // its id — this browser's record of its buys is filed under it — and every
    // term, and waits for its owner to resume it as a plan they confirm.
    const autopilot = { ...plan({ id: "dca-auto", label: "Stack SPX", paused: false }), signer: "autopilot" };
    const wallet = plan({ id: "dca-tab", paused: false });
    const vaultPlan = plan({ id: "dca-vault", signer: "vault", vault: VAULT });
    const on = setFeature(recommendedConfig(), DCA_FEATURE_ID, true);
    const v7 = { ...on, schemaVersion: 7, dca: { enabled: true, plans: [autopilot, wallet, vaultPlan] } };

    const migrated = migrateConfig(v7);
    expect(migrated).toEqual({
      ...on,
      schemaVersion: 9,
      dca: {
        enabled: true,
        plans: [plan({ id: "dca-auto", label: "Stack SPX", paused: true, signer: "wallet" }), wallet, vaultPlan],
      },
    });
    // A paused autopilot plan arrives the same way.
    const pausedAuto = { ...v7, dca: { enabled: true, plans: [{ ...autopilot, paused: true }] } };
    expect(migrateConfig(pausedAuto).dca.plans).toEqual([
      plan({ id: "dca-auto", label: "Stack SPX", paused: true, signer: "wallet" }),
    ]);
  });

  it("opens an old file or link with an autopilot plan in it, through every step since", () => {
    // Exported by a v7 build (TOML, JSON or a link), or by a v6 one before
    // vaults existed: each still opens, its autopilot plan a paused wallet plan.
    const autopilot = { ...plan({ id: "dca-auto", sell: USDC, amountPerBuy: "25000000", paused: false }), signer: "autopilot" };
    const expected = [plan({ id: "dca-auto", sell: USDC, amountPerBuy: "25000000", signer: "wallet" })];
    for (const schemaVersion of [6, 7]) {
      const old = { ...withPlans(), schemaVersion, dca: { enabled: true, plans: [autopilot] } };
      const toml = exportToml(old as unknown as SpdexConfig);
      expect(importConfig(toml).dca.plans).toEqual(expected);
      expect(importConfig(JSON.stringify(old)).dca.plans).toEqual(expected);
      // shareFragment only encodes: the old config goes into the link as it was.
      const link = shareFragment(old as unknown as SpdexConfig);
      expect(readShareFragment(`#config=${link}`).dca.plans).toEqual(expected);
    }
  });

  it("refuses an autopilot plan in a file that claims to be v9, rather than guessing what it meant", () => {
    // Only a hand edit could put one there: no build since v8 writes it.
    const handEdited = { ...withPlans(), dca: { enabled: true, plans: [{ ...plan(), signer: "autopilot" }] } };
    expect(() => migrateConfig(handEdited)).toThrow();
  });

  it("refuses a config newer than v9 by its version, before looking at its plans", () => {
    // What a v7 build does with a v8 file, a v8 build with a v9, and this
    // one with a v10: says it is newer, rather than calling a value it has
    // never heard of a broken file.
    const next = { ...withPlans(plan({ signer: "vault" })), schemaVersion: 10 };
    expect(() => migrateConfig(next)).toThrow(/version 10, this build understands up to 9/);
  });

  it("adds auto-buy to a v5 config switched off, and changes nothing else", () => {
    // A v5 config was buying nothing on a timer, so neither may a v6 one. No
    // module is added either: an untouched config must still match the preset.
    const { dca: _, ...rest } = recommendedConfig();
    const v5 = { ...rest, schemaVersion: 5, slippageBps: 17 };

    const migrated = migrateConfig(v5);
    expect(migrated).toEqual({ ...v5, schemaVersion: 9, dca: { enabled: false, plans: [] } });
    expect(isPreset(recommendedConfig(), migrateConfig({ ...rest, schemaVersion: 5 }))).toBe(true);
  });

  it("keeps a dca section a hand-edited v5 file already carries, paused if imported", () => {
    // Only a hand-edited file could have one. It is kept and judged by the
    // schema like any other field; the pause rule is the import path's, not
    // the migration's, so it applies however old the file is.
    const { dca: _, ...rest } = recommendedConfig();
    const dca = { enabled: true, plans: [plan({ paused: false })] };
    const handEdited = { ...rest, schemaVersion: 5, dca };

    expect(migrateConfig(handEdited).dca).toEqual(dca);
    expect(importConfig(JSON.stringify(handEdited)).dca).toEqual({
      enabled: true,
      plans: [plan({ paused: true })],
    });
  });

  it("preserves settings the user chose, rather than resetting them", () => {
    const legacy = {
      schemaVersion: 0,
      chainId: 1,
      rpc: { url: "https://mine.invalid/rpc", source: "user" },
      slippageBps: 12,
      deadlineSeconds: 1200,
      strictSandbox: true,
      modules: [],
      pools: { mode: "allowlist", allow: [{ venueId: "v", poolId: "0xabc" }], deny: [] },
    };

    const migrated = migrateConfig(legacy);
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.slippageBps).toBe(12);
    expect(migrated.strictSandbox).toBe(true);
    expect(migrated.pools.allow).toHaveLength(1);
    expect(migrated.rpc.url).toBe("https://mine.invalid/rpc");
  });

  it("refuses a config from a newer build instead of guessing", () => {
    // Downgrading best-effort would silently drop settings the user chose, and
    // they would not find out until a swap behaved oddly.
    expect(() => migrateConfig({ ...recommendedConfig(), schemaVersion: 99 })).toThrow(
      ConfigMigrationError,
    );
  });

  it("rejects input with no usable version", () => {
    expect(() => migrateConfig({ nope: true })).toThrow(ConfigMigrationError);
    expect(() => migrateConfig(null)).toThrow(ConfigMigrationError);
  });
});

describe("the second opinion (v9)", () => {
  /** A v8 config as a v8 build wrote it: no `guard.secondOpinion`. */
  function v8(config: SpdexConfig = recommendedConfig()): Record<string, unknown> {
    const { secondOpinion: _, ...guard } = config.guard;
    return { ...config, schemaVersion: 8, guard };
  }

  it("is off in the preset: no second service is chosen for anyone", () => {
    expect(recommendedConfig().guard.secondOpinion).toEqual({ url: null });
  });

  it("adds none to a v8 config and changes nothing else", () => {
    const custom = { ...running(twoPlans()), slippageBps: 17 };
    expect(migrateConfig(v8(custom))).toEqual({ ...custom, guard: { ...custom.guard, secondOpinion: { url: null } } });
    // An untouched v8 preset is still the preset.
    expect(isPreset(recommendedConfig(), migrateConfig(v8()))).toBe(true);
    expect(migrateConfig(v8())).toEqual(recommendedConfig());
  });

  it("keeps the requireSimulation and tolerance a v8 file chose", () => {
    const strict = migrateConfig({
      ...v8(),
      guard: { requireSimulation: true, oracleDivergenceBps: 42 },
    });
    expect(strict.guard).toEqual({ requireSimulation: true, oracleDivergenceBps: 42, secondOpinion: { url: null } });
  });

  it("keeps a second opinion a hand-edited v8 file already carries", () => {
    const handEdited = { ...v8(), guard: { ...recommendedConfig().guard, secondOpinion: { url: "https://second.invalid/rpc" } } };
    expect(migrateConfig(handEdited).guard.secondOpinion).toEqual({ url: "https://second.invalid/rpc" });
  });

  it("leaves a missing or broken guard for the schema to refuse, rather than filling one in", () => {
    const { guard: _, ...noGuard } = v8();
    for (const broken of [noGuard, { ...v8(), guard: null }, { ...v8(), guard: "strict" }, { ...v8(), guard: [] }]) {
      expect(() => migrateConfig(broken)).toThrow();
    }
  });

  it("round-trips through TOML, JSON and a link, with and without a service", () => {
    const none = recommendedConfig();
    const set = { ...none, guard: { ...none.guard, secondOpinion: { url: "https://second.invalid/rpc" } } };
    for (const config of [none, set]) {
      expect(importConfig(exportToml(config))).toEqual(config);
      expect(importConfig(exportJson(config))).toEqual(config);
      expect(readShareFragment(`#config=${shareFragment(config)}`)).toEqual(config);
    }
  });

  it("reads an omitted url as none, since TOML has no null", () => {
    const withoutUrl = { ...recommendedConfig(), guard: { ...recommendedConfig().guard, secondOpinion: {} } };
    expect(SpdexConfigSchema.parse(withoutUrl).guard.secondOpinion).toEqual({ url: null });
  });

  it("refuses a v9 config without the setting, and a url that isn't one", () => {
    const { secondOpinion: _, ...guard } = recommendedConfig().guard;
    expect(() => SpdexConfigSchema.parse({ ...recommendedConfig(), guard })).toThrow();
    const bad = { ...recommendedConfig(), guard: { ...recommendedConfig().guard, secondOpinion: { url: "not a url" } } };
    expect(() => SpdexConfigSchema.parse(bad)).toThrow();
  });

  it("is named in the diff when set", () => {
    const set = { ...recommendedConfig(), guard: { ...recommendedConfig().guard, secondOpinion: { url: "https://second.invalid/rpc" } } };
    expect(diffConfig(recommendedConfig(), set)).toEqual([
      { path: "guard.secondOpinion.url", from: null, to: "https://second.invalid/rpc" },
    ]);
  });
});

describe("diffing against the preset", () => {
  it("reports nothing for an untouched preset", () => {
    expect(diffConfig(recommendedConfig(), recommendedConfig())).toEqual([]);
    expect(isPreset(recommendedConfig(), recommendedConfig())).toBe(true);
  });

  it("names the exact path that changed", () => {
    const changed = { ...recommendedConfig(), router: { ...recommendedConfig().router, maxSplits: 2 } };
    const diff = diffConfig(recommendedConfig(), changed);

    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({ path: "router.maxSplits", from: 4, to: 2 });
  });

  it("reports added and removed array entries", () => {
    const pinned = {
      ...recommendedConfig(),
      pools: {
        mode: "allowlist" as const,
        allow: [{ venueId: "venue-uniswap-v3", poolId: "0xabc" }],
        deny: [],
      },
    };
    const diff = diffConfig(recommendedConfig(), pinned);
    const paths = diff.map((c) => c.path);

    expect(paths).toContain("pools.mode");
    // A whole added entry is reported at its index rather than field by field:
    // "you added this pool" reads better than four lines saying the same. Only
    // entries present on both sides are compared leaf by leaf.
    expect(paths).toContain("pools.allow[0]");
  });

  it("excludes the endpoint from the preset comparison, but not from a config comparison", () => {
    // Every user must supply an endpoint — the preset ships without one — so
    // listing it would put a line in everybody's diff and make "identical to
    // recommended" unreachable. It must still appear when comparing two configs,
    // because it is the first field a hostile shared config would rewrite.
    const withRpc = {
      ...recommendedConfig(),
      rpc: { url: "https://mine.invalid/rpc", source: "user" as const },
    };

    expect(diffFromPreset(recommendedConfig(), withRpc)).toEqual([]);
    expect(isPreset(recommendedConfig(), withRpc)).toBe(true);

    const paths = diffConfig(recommendedConfig(), withRpc).map((c) => c.path);
    expect(paths).toContain("rpc.url");
  });

  it("treats the chain id the same way, since it follows the endpoint", () => {
    // Pointing at a fork that runs under its own id is normal, and the id is
    // adopted rather than chosen — so it is not a customisation. It must still
    // show when comparing two configs: a shared config quietly moving you to
    // another chain is exactly what a reviewer needs to see.
    const onFork = { ...recommendedConfig(), chainId: 31337 };

    expect(diffFromPreset(recommendedConfig(), onFork)).toEqual([]);
    expect(diffConfig(recommendedConfig(), onFork).map((c) => c.path)).toContain("chainId");
  });

  it("ignores the preset marker itself", () => {
    // It flips to "custom" whenever anything else changes, so listing it would
    // add a line to every diff that says nothing new.
    const custom = { ...recommendedConfig(), preset: "custom" as const };
    expect(diffConfig(recommendedConfig(), custom)).toEqual([]);
  });

  it("reports an added plan as one entry, the whole plan at its index", () => {
    // What a reviewer of a shared link sees: one line per plan, holding every
    // term of it, rather than ten lines that each say part of the same thing.
    const added = plan();
    const diff = diffConfig(recommendedConfig(), withPlans(added));
    expect(diff).toContainEqual({ path: "dca.plans[0]", from: undefined, to: added });
    expect(diff.map((c) => c.path)).toContain("dca.enabled");
  });

  it("reports resuming a plan as exactly the one field that changed", () => {
    const paused = withPlans(plan());
    const resumed = updateDcaPlan(paused, "dca-0a1b2c3d", { paused: false });
    if (!resumed.ok) throw new Error(resumed.error);
    expect(diffConfig(paused, resumed.config)).toEqual([
      { path: "dca.plans[0].paused", from: true, to: false },
    ]);
  });

  it("reports recording a plan's vault as exactly the one field that changed", () => {
    // The address that leads to the plan's money: a reviewer must see it arrive.
    const before = withPlans(plan({ signer: "vault" }));
    const after = updateDcaPlan(before, "dca-0a1b2c3d", { vault: VAULT });
    if (!after.ok) throw new Error(after.error);
    expect(diffConfig(before, after.config)).toEqual([
      { path: "dca.plans[0].vault", from: undefined, to: VAULT },
    ]);
  });

  it("reports a plan moved to another chain, even against the preset", () => {
    // Only the top-level chain id follows the endpoint. A plan's chain id is
    // a decision about where money is spent, and must always show.
    const onMainnet = withPlans(plan());
    const onFork = withPlans(plan({ chainId: 690069 }));
    expect(diffFromPreset(onMainnet, onFork)).toEqual([
      { path: "dca.plans[0].chainId", from: 1, to: 690069 },
    ]);
  });
});

describe("the auto-buy feature", () => {
  const feature = featureById(DCA_FEATURE_ID);
  if (!feature) throw new Error("auto-buy is missing from the catalogue");

  it("follows tip splits in the catalogue, off by default, naming its module", () => {
    const ids = FEATURE_CATALOG.map((f) => f.id);
    expect(ids.indexOf(DCA_FEATURE_ID)).toBe(ids.indexOf(TIP_FEATURE_ID) + 1);
    expect(feature.name).toBe("Auto-buy");
    expect(feature.modules).toEqual([SCHEDULER_MODULE_ID]);
    expect(feature.recommended).toBe(false);
  });

  it("states the limits a newcomer would not guess", () => {
    // Stated, not buried: these are the sentences that stop someone assuming
    // it runs in the background or tops up missed buys.
    expect(feature.detail).toMatch(/only while spDEX is open in a tab/);
    expect(feature.detail).toMatch(/skipped, never doubled up/);
    expect(feature.detail).toMatch(/never tip/);
    expect(feature.cost).toMatch(/network fee/);
  });

  it("names the vault, its limits, and that this switch doesn't stop one", () => {
    // Someone who switches Auto-buy off to stop everything must read here
    // that a vault goes on buying: only closing it stops it.
    expect(feature.detail).toMatch(/two ways/);
    expect(feature.detail).not.toMatch(/autopilot|spending wallet/i);
    expect(feature.detail).toMatch(/unaudited/);
    expect(feature.detail).toMatch(/at most 0\.5 ETH/);
    expect(feature.detail).toMatch(/closing it is the only way to stop it: switching Auto-buy off here doesn't/);
    expect(feature.detail).toMatch(/No one is guaranteed to trigger it/);
    expect(feature.detail).toMatch(/when anyone triggers a due buy, SPX holders first\./);
    expect(feature.cost).toMatch(/buy fee from its budget — a fixed amount for network fees plus 0\.25% of the buy, never more than 0\.69% of the buy/);
    expect(feature.cost).toMatch(/to the keeper that makes each buy\.$/);
    expect(feature.cost).not.toMatch(/10% of that/);
  });

  it("switches on the master switch and the scheduler module together", () => {
    const on = setFeature(recommendedConfig(), DCA_FEATURE_ID, true);
    expect(feature.isEnabled(on)).toBe(true);
    expect(on.dca).toEqual({ enabled: true, plans: [] });
    expect(on.modules).toContainEqual({
      id: SCHEDULER_MODULE_ID,
      version: "1.0.0",
      source: "builtin",
      enabled: true,
    });
    expect(on.preset).toBe("custom");
    expect(() => SpdexConfigSchema.parse(on)).not.toThrow();
  });

  it("stops every plan when switched off, and keeps them for when it is back on", () => {
    const config = running(twoPlans());

    const off = setFeature(config, DCA_FEATURE_ID, false);
    expect(feature.isEnabled(off)).toBe(false);
    expect(off.modules.find((m) => m.id === SCHEDULER_MODULE_ID)?.enabled).toBe(false);
    expect(off.dca.plans).toEqual(config.dca.plans);

    const on = setFeature(off, DCA_FEATURE_ID, true);
    expect(on.dca).toEqual(config.dca);
    expect(on.modules).toEqual(config.modules);
  });
});

describe("tips in the recommended preset", () => {
  it("chooses nobody to tip: spDEX's own donation vault is listed, never pre-selected", () => {
    expect(recommendedConfig().tips).toEqual({ enabled: false, recipients: [] });
  });
});
