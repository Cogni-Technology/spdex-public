/**
 * Config written by another tab reaches this one.
 *
 * The case that matters is auto-buy: a plan paused in one tab has to stop in
 * the tab running the buys, and must not be un-paused by that tab saving its
 * stale copy later.
 */

import { describe, expect, it } from "vitest";
import { recommendedConfig } from "@spdex/config";
import type { SpdexConfig } from "@spdex/core";
import {
  OLDER_TAB_TEXT,
  autoBundledRpc,
  builtInServiceInUse,
  builtInServiceToSave,
  bundledRpcAvailable,
  canonicalOrigins,
  forSharing,
  loadConfig,
  publicFallbackRpc,
  olderSaveOnLoad,
  settleOlderSave,
  readConfigForAdoption,
  readOtherTabConfig,
  saveConfig,
  watchConfigFromOtherTabs,
  withOwnService,
  type BuiltInService,
  type ConfigEventSource,
  type RpcBuild,
} from "./store.js";

function events(): ConfigEventSource & { fire(key: string | null): void; count(): number } {
  const listeners = new Set<(event: { key: string | null }) => void>();
  return {
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    fire: (key) => listeners.forEach((listener) => listener({ key })),
    count: () => listeners.size,
  };
}

describe("watchConfigFromOtherTabs", () => {
  it("reports the config another tab saved, and nothing for other keys", () => {
    const source = events();
    const saved: SpdexConfig = { ...recommendedConfig(), slippageBps: 123 };
    const seen: SpdexConfig[] = [];
    watchConfigFromOtherTabs((config) => seen.push(config), source, () => saved);

    source.fire("spdex.dca.ledger.v1");
    source.fire("spx-theme");
    expect(seen).toEqual([]);

    source.fire("spdex.config.v1");
    expect(seen).toEqual([saved]);

    // Storage cleared by another tab: re-read, which falls back like a reload.
    source.fire(null);
    expect(seen).toHaveLength(2);
  });

  it("ignores a config another tab saved that can't be read, rather than resetting this tab to the preset", () => {
    // Maximum parts 9 is outside the schema: read back, it would open as the
    // preset — with no network service and none of the plans.
    const mine: SpdexConfig = { ...recommendedConfig(), slippageBps: 77 };
    const unreadable = JSON.stringify({ ...mine, router: { ...mine.router, maxSplits: 9 } });
    const storage = { getItem: () => unreadable };
    expect(readConfigForAdoption(storage)).toBeNull();
    const source = events();
    const seen: SpdexConfig[] = [];
    watchConfigFromOtherTabs((config) => seen.push(config), source, () => readConfigForAdoption(storage));
    source.fire("spdex.config.v1");
    expect(seen).toEqual([]);

    // A readable one is adopted, migrated; a removed one reads as a reload would.
    expect(readConfigForAdoption({ getItem: () => JSON.stringify(mine) })).toEqual(mine);
    expect(readConfigForAdoption({ getItem: () => null })).toEqual(recommendedConfig());
    expect(readConfigForAdoption({ getItem: () => "{not json" })).toBeNull();
    expect(
      readConfigForAdoption({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBeNull();
  });

  it("stops listening when unsubscribed, and is a no-op without an event source", () => {
    const source = events();
    const stop = watchConfigFromOtherTabs(() => {}, source, recommendedConfig);
    expect(source.count()).toBe(1);
    stop();
    expect(source.count()).toBe(0);
    expect(() => watchConfigFromOtherTabs(() => {}, null)()).not.toThrow();
  });
});

describe("a tab running an older spDEX", () => {
  /** A storage that remembers what was written, as a second tab sees it. */
  function memory(initial: string | null) {
    let value = initial;
    const writes: string[] = [];
    return {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
        writes.push(next);
      },
      writes,
      set: (next: string | null) => {
        value = next;
      },
    };
  }

  const mine: SpdexConfig = {
    ...recommendedConfig(),
    guard: { ...recommendedConfig().guard, secondOpinion: { url: "https://second.example/rpc" } },
  };
  // What a v8 build saves: no second opinion, and its own version number.
  const { secondOpinion: _dropped, ...v8Guard } = mine.guard;
  const older = JSON.stringify({ ...mine, schemaVersion: 8, guard: v8Guard });

  it("is read as older, not adopted", () => {
    expect(readOtherTabConfig({ getItem: () => older })).toEqual({ kind: "older", version: 8 });
    expect(readConfigForAdoption({ getItem: () => older })).toBeNull();
    // This version's own saves are still adopted.
    expect(readOtherTabConfig({ getItem: () => JSON.stringify(mine) })).toEqual({ kind: "adopt", config: mine });
  });

  it("keeps this tab's config, writes it back once, and says so", () => {
    const storage = memory(older);
    const source = events();
    const adopted: SpdexConfig[] = [];
    let told = 0;
    watchConfigFromOtherTabs((config) => adopted.push(config), source, () => readConfigForAdoption(storage), {
      current: () => mine,
      onOlderTab: () => (told += 1),
      storage,
    });

    source.fire("spdex.config.v1");
    expect(adopted).toEqual([]);
    expect(storage.writes).toHaveLength(1);
    expect(JSON.parse(storage.writes[0]!)).toEqual(JSON.parse(JSON.stringify(mine)));
    expect(told).toBe(1);
    // What storage holds now opens with the second opinion still on.
    expect(readConfigForAdoption(storage)?.guard.secondOpinion.url).toBe("https://second.example/rpc");

    // Its own write-back arrives in the other tabs, not this one; a later
    // save from the older tab is answered the same way, once.
    storage.set(older);
    source.fire("spdex.config.v1");
    expect(storage.writes).toHaveLength(2);
    expect(told).toBe(2);
    expect(adopted).toEqual([]);
  });

  it("writes back the config this tab last saved when the page passes none", () => {
    // No localStorage under node: saveConfig keeps nothing but still records it.
    saveConfig(mine);
    const storage = memory(older);
    const source = events();
    watchConfigFromOtherTabs(() => {}, source, () => readConfigForAdoption(storage), { storage });
    source.fire("spdex.config.v1");
    expect(storage.writes.map((w) => JSON.parse(w))).toEqual([JSON.parse(JSON.stringify(mine))]);
  });

  it("names what happened in the sentence the tab shows", () => {
    expect(OLDER_TAB_TEXT).toBe(
      "Another spDEX tab running an older version just saved settings. Close or reload it; this tab kept yours.",
    );
  });
});

describe("an older spDEX's save found on load, with no newer tab open to answer it", () => {
  function store(entries: Record<string, string> = {}) {
    const map = new Map(Object.entries(entries));
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  }
  const withSecond: SpdexConfig = { ...recommendedConfig(), guard: { ...recommendedConfig().guard, secondOpinion: { url: "https://second.example" } } };
  /** What a version-8 tab writes: this config, without the field it has no idea of. */
  const asVersion8 = (config: SpdexConfig) => {
    const { secondOpinion: _dropped, ...guard } = config.guard;
    return JSON.stringify({ ...config, schemaVersion: 8, guard, slippageBps: 42 });
  };

  it("is offered, not migrated silently: the copy this version saved is kept to restore", () => {
    const storage = store();
    saveConfig(withSecond, storage);
    // The newer tab is closed; an older one saves an edit.
    storage.setItem("spdex.config.v1", asVersion8(withSecond));

    const loaded = loadConfig(storage);
    expect(loaded.guard.secondOpinion?.url ?? null).toBeNull();
    const offer = olderSaveOnLoad();
    expect(offer?.version).toBe(8);
    expect(offer?.kept.guard.secondOpinion?.url).toBe("https://second.example");

    // Saves while the offer is open leave the kept copy alone ...
    saveConfig(loaded, storage);
    expect(JSON.parse(storage.map.get("spdex.config.newest.v1")!).config.guard.secondOpinion.url).toBe("https://second.example");
    // ... and once it is answered, saves keep it current again.
    settleOlderSave();
    saveConfig(loaded, storage);
    expect(JSON.parse(storage.map.get("spdex.config.newest.v1")!).config.guard.secondOpinion?.url ?? null).toBeNull();
    expect(loadConfig(storage) && olderSaveOnLoad()).toBeNull();
  });

  it("offers nothing when this version saved last, or never saved, or the kept copy is from a newer build", () => {
    const storage = store();
    saveConfig(withSecond, storage);
    loadConfig(storage);
    expect(olderSaveOnLoad()).toBeNull();

    const fresh = store({ "spdex.config.v1": asVersion8(withSecond) });
    loadConfig(fresh);
    expect(olderSaveOnLoad()).toBeNull();

    const newer = store({
      "spdex.config.v1": JSON.stringify(withSecond),
      "spdex.config.newest.v1": JSON.stringify({ schemaVersion: 99, config: {} }),
    });
    loadConfig(newer);
    expect(olderSaveOnLoad()).toBeNull();
  });
});

/**
 * The built-in network service: used without a screen only where a key is
 * built in and the page is at an origin it is allowlisted to; offered by a
 * button where it works; and source "bundled" always meaning this copy's key.
 */
describe("the built-in network service", () => {
  const KEY = "https://eth-mainnet.g.alchemy.com/v2/built-in-key";
  const SITE = "https://spdex.example";
  const build = (canonical?: string, extra: Partial<RpcBuild> = {}): RpcBuild => ({ url: KEY, canonical, ...extra });

  it("reads the canonical origins as a list, each as the browser writes an origin", () => {
    expect(canonicalOrigins(build(`${SITE}/`))).toEqual([SITE]);
    expect(canonicalOrigins(build(`${SITE}, https://spdex.eth.limo`))).toEqual([SITE, "https://spdex.eth.limo"]);
    expect(canonicalOrigins(build(`${SITE}  https://spdex.eth.limo/app/`))).toEqual([SITE, "https://spdex.eth.limo"]);
    expect(canonicalOrigins(build(`${SITE}, ${SITE}`))).toEqual([SITE]);
    expect(canonicalOrigins(build(undefined))).toEqual([]);
    expect(canonicalOrigins(build(" , "))).toEqual([]);
  });

  it("fails closed on a canonical setting it can't read: the built-in service is neither used nor offered", () => {
    // A bare host (how Alchemy's Domains list writes it), a typo beside a good
    // origin, a scheme with no web origin: none may read as "no origin named".
    for (const canonical of ["spdex.example", `${SITE}, bad`, `not a url, ${SITE}`, "file:///home/x/index.html", "localhost:5299"]) {
      expect(canonicalOrigins(build(canonical)), canonical).toBeNull();
      expect(bundledRpcAvailable(build(canonical), "https://ipfs.io"), canonical).toBeNull();
      expect(bundledRpcAvailable(build(canonical), SITE), canonical).toBeNull();
    }
    // Written as an origin, the same site works.
    expect(bundledRpcAvailable(build("https://spdex.example"), "https://spdex.example")).toBe(KEY);
    expect(bundledRpcAvailable(build("https://spdex.example"), "https://ipfs.io")).toBeNull();
  });

  it("is never used without asking: every new visitor chooses, even at the release's own origin", () => {
    expect(autoBundledRpc(build(SITE), SITE)).toBeNull();
    expect(autoBundledRpc(build(`${SITE}, https://spdex.eth.limo`), "https://spdex.eth.limo")).toBeNull();
    expect(autoBundledRpc(build(SITE), "https://bafy.ipfs.dweb.link")).toBeNull();
    // It is still offered there, as FirstRun's last option.
    expect(bundledRpcAvailable(build(SITE), SITE)).toBe(KEY);
  });

  it("is offered by a button where it works, and wherever a build names no origin", () => {
    expect(bundledRpcAvailable(build(SITE), SITE)).toBe(KEY);
    expect(bundledRpcAvailable(build(`${SITE}/`), SITE)).toBe(KEY);
    expect(bundledRpcAvailable(build(SITE), "https://elsewhere.example")).toBeNull();
    expect(bundledRpcAvailable(build(undefined), "https://elsewhere.example")).toBe(KEY);
    expect(bundledRpcAvailable({}, SITE)).toBeNull();
  });

  it("offers the public service only when one is built in", () => {
    expect(publicFallbackRpc({ fallback: "https://ethereum-rpc.publicnode.com" })).toBe("https://ethereum-rpc.publicnode.com");
    expect(publicFallbackRpc({ fallback: "" })).toBeNull();
    expect(publicFallbackRpc({})).toBeNull();
  });

  describe("source \"bundled\" is this copy's key", () => {
    const at = (rpc: SpdexConfig["rpc"]): SpdexConfig => ({ ...recommendedConfig(), rpc });
    const here: BuiltInService = { usable: KEY, automatic: KEY };
    const OLD = "https://eth-mainnet.g.alchemy.com/v2/rotated-away";

    it("saves the built-in service into a config with none yet, only where it is automatic", () => {
      const fresh = recommendedConfig();
      expect(fresh.rpc).toEqual({ url: null, source: "bundled" });
      expect(builtInServiceToSave(fresh, here).rpc).toEqual({ url: KEY, source: "bundled" });
      // Usable by a button but not automatic: the person is asked.
      expect(builtInServiceToSave(fresh, { usable: KEY, automatic: null })).toBe(fresh);
      // Nothing to fill in memory: that is the save's job.
      expect(builtInServiceInUse(fresh, here)).toBe(fresh);
    });

    it("reads another build's key as this build's, and never saves over it", () => {
      const old = at({ url: OLD, source: "bundled" });
      expect(builtInServiceInUse(old, here).rpc).toEqual({ url: KEY, source: "bundled" });
      expect(builtInServiceInUse(old, { usable: KEY, automatic: null }).rpc).toEqual({ url: KEY, source: "bundled" });
      // Where this build's key doesn't work, the saved one is left as it is.
      expect(builtInServiceInUse(old, { usable: null, automatic: null })).toBe(old);
      // Nothing to save: a tab that saved in answer to another build's key
      // would start the two answering each other's saves without end.
      expect(builtInServiceToSave(old, here)).toBe(old);
    });

    it("never touches a service the person chose, or Change service's empty choice", () => {
      for (const rpc of [
        { url: "http://127.0.0.1:8545", source: "user" },
        { url: "https://ethereum-rpc.publicnode.com", source: "fallback" },
        { url: null, source: "user" },
        { url: null, source: "fallback" },
      ] as const) {
        const config = at(rpc);
        expect(builtInServiceInUse(config, here), JSON.stringify(rpc)).toBe(config);
        expect(builtInServiceToSave(config, here), JSON.stringify(rpc)).toBe(config);
      }
    });

    it("returns the same object when the built-in service is already in use", () => {
      const current = at({ url: KEY, source: "bundled" });
      expect(builtInServiceInUse(current, here)).toBe(current);
      expect(builtInServiceToSave(current, here)).toBe(current);
    });

    /**
     * Two tabs on the same origin, running builds whose keys differ: a tab
     * left open across a release. Each does what App.tsx does: loads and
     * adopts with `builtInServiceInUse`, and after every change saves only
     * what `builtInServiceToSave` fills. Storage events arrive later, as in a
     * browser, never in the tab that wrote.
     */
    it("lets two builds with different keys share one browser without saving over each other", () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      };
      const pending: (() => void)[] = [];
      const tabs = [KEY, OLD].map((key) => ({
        service: { usable: key, automatic: key } as BuiltInService,
        source: events(),
        config: recommendedConfig(),
        writes: 0,
      }));
      type Tab = (typeof tabs)[number];
      const save = (tab: Tab, config: SpdexConfig) => {
        tab.config = config;
        tab.writes += 1;
        saveConfig(config, storage);
        for (const other of tabs) if (other !== tab) pending.push(() => other.source.fire("spdex.config.v1"));
      };
      // The page's effect, after the disclaimer: fill a missing service, and save that alone.
      const settle = (tab: Tab) => {
        const next = builtInServiceToSave(tab.config, tab.service);
        if (next !== tab.config) save(tab, next);
      };
      const stops = tabs.map((tab) =>
        watchConfigFromOtherTabs(
          (saved) => {
            tab.config = builtInServiceInUse(saved, tab.service);
            settle(tab);
          },
          tab.source,
          () => readConfigForAdoption(storage),
          { storage },
        ),
      );
      const drain = () => {
        let steps = 0;
        while (pending.length > 0) {
          steps += 1;
          if (steps > 50) throw new Error("the two tabs keep answering each other's saves");
          pending.shift()!();
        }
      };

      // Both open on a fresh browser and continue past the disclaimer.
      for (const tab of tabs) {
        tab.config = builtInServiceInUse(loadConfig(storage), tab.service);
        settle(tab);
      }
      drain();
      // Then the older tab's person changes a setting, which saves the whole config.
      const [newer, older] = tabs as [Tab, Tab];
      save(older, { ...older.config, slippageBps: 51 });
      drain();

      expect(newer.writes + older.writes).toBeLessThanOrEqual(3);
      // Each reads with its own build's key, and the newer one took the edit.
      expect(newer.config.rpc).toEqual({ url: KEY, source: "bundled" });
      expect(older.config.rpc).toEqual({ url: OLD, source: "bundled" });
      expect(newer.config.slippageBps).toBe(51);
      stops.forEach((stop) => stop());
    });
  });

  it("keeps the recipient's own service when a shared or imported config carries no address", () => {
    const shared: SpdexConfig = { ...recommendedConfig(), slippageBps: 75, rpc: { url: null, source: "bundled" } };
    const mine: SpdexConfig = { ...recommendedConfig(), chainId: 690069, rpc: { url: "http://localhost:8545", source: "user" } };
    const applied = withOwnService(shared, mine);
    expect(applied.rpc).toBe(mine.rpc);
    expect(applied.chainId).toBe(690069);
    expect(applied.slippageBps).toBe(75);
    // From the "choose a service" screen, likewise: the sender had no address to give.
    expect(withOwnService({ ...shared, rpc: { url: null, source: "user" } }, mine).rpc).toBe(mine.rpc);
    // The public fallback someone chose stays too.
    const onFallback: SpdexConfig = { ...recommendedConfig(), rpc: { url: "https://ethereum-rpc.publicnode.com", source: "fallback" } };
    expect(withOwnService(shared, onFallback).rpc).toBe(onFallback.rpc);
    // A config that names an address goes as it is, so the review shows that change.
    const named: SpdexConfig = { ...shared, rpc: { url: "https://their.node.example", source: "user" } };
    expect(withOwnService(named, mine)).toBe(named);
    // What a share from the built-in service makes of it, end to end.
    const sender: SpdexConfig = { ...recommendedConfig(), slippageBps: 75, rpc: { url: KEY, source: "bundled" } };
    expect(withOwnService(forSharing(sender), mine).rpc).toEqual({ url: "http://localhost:8545", source: "user" });
  });

  it("leaves the built-in key out of a file or link, and any other service in", () => {
    const builtIn: SpdexConfig = { ...recommendedConfig(), chainId: 1, rpc: { url: KEY, source: "bundled" } };
    expect(forSharing(builtIn).rpc).toEqual({ url: null, source: "bundled" });
    expect(forSharing(builtIn).chainId).toBe(1);
    const own: SpdexConfig = { ...recommendedConfig(), rpc: { url: "https://my.node.example/k", source: "user" } };
    expect(forSharing(own)).toBe(own);
    const fresh = recommendedConfig();
    expect(forSharing(fresh)).toBe(fresh);
  });
});
