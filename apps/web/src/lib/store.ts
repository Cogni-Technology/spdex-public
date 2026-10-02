/**
 * Config persistence.
 *
 * Local storage only — there is no account, no sync and no server that could
 * hold this. A config shared between machines travels as a file or a URL
 * fragment, both of which the user moves deliberately.
 *
 * A config arriving in the URL fragment is *staged*, never applied silently. A
 * link that reconfigured someone's DEX on click would be an attack, not a
 * feature, so the app shows the diff and asks.
 */

import {
  ConfigParseError,
  migrateConfig,
  readShareFragment,
  recommendedConfig,
} from "@spdex/config";
import { CONFIG_SCHEMA_VERSION, type SpdexConfig } from "@spdex/core";

const STORAGE_KEY = "spdex.config.v1";

/**
 * The newest settings this browser has saved, with their version, under a key
 * no older spDEX reads or writes. An older release that saves (a stale tab
 * with no newer one open to answer it, an older copy on the same gateway)
 * writes its own version under `STORAGE_KEY`, without what the newer version
 * added; this copy is how the next newer load notices, and has something to
 * restore (`olderSaveOnLoad`).
 */
const NEWEST_KEY = "spdex.config.newest.v1";

/**
 * The config this tab last loaded, saved or adopted: what it writes back
 * when a tab running an older spDEX saves over it (`watchConfigFromOtherTabs`).
 * Kept here rather than asked of the page, so that protection holds whether
 * or not the page remembers to pass its config in.
 */
let known: SpdexConfig | null = null;

/** Settings an older spDEX saved over this version's: its version, and the copy this version saved last. */
export interface OlderSave {
  version: number;
  kept: SpdexConfig;
}

/**
 * What the last `loadConfig` found under `STORAGE_KEY` below the version in
 * `NEWEST_KEY`, until the person answers it (`settleOlderSave`). While it is
 * unanswered no save touches the kept copy, so whatever the page saves
 * meanwhile can't overwrite what there is to restore.
 */
let olderSave: OlderSave | null = null;

type ConfigStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadConfig(storage: ConfigStorage | null = safeStorage()): SpdexConfig {
  olderSave = null;
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (!stored) return (known = recommendedConfig());
    const raw: unknown = JSON.parse(stored);
    olderSave = olderSaveOver(raw, storage!);
    // Migrate on read: a config written by an older build must still open.
    return (known = migrateConfig(raw));
  } catch {
    // A corrupt or unmigratable config should not brick the app. Falling back
    // to the preset is recoverable; a blank screen is not.
    return (known = recommendedConfig());
  }
}

/** `raw`'s version, when it is below the newest this browser saved, with the copy saved then; otherwise null. */
function olderSaveOver(raw: unknown, storage: Pick<Storage, "getItem">): OlderSave | null {
  const version = versionOf(raw) ?? 0;
  try {
    const newest = JSON.parse(storage.getItem(NEWEST_KEY) ?? "null") as { schemaVersion?: unknown; config?: unknown } | null;
    const newestVersion = versionOf(newest);
    // A copy from a newer build than this one can't be read here: it isn't offered.
    if (newestVersion === null || newestVersion > CONFIG_SCHEMA_VERSION || version >= newestVersion) return null;
    return { version, kept: migrateConfig(newest!.config) };
  } catch {
    return null;
  }
}

function versionOf(value: unknown): number | null {
  const version = typeof value === "object" && value !== null ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  return typeof version === "number" && Number.isSafeInteger(version) ? version : null;
}

/** Settings an older spDEX saved over this version's, found by the last `loadConfig`, until answered. */
export function olderSaveOnLoad(): OlderSave | null {
  return olderSave;
}

/** The person has answered `olderSaveOnLoad` (restored the kept copy, or kept what loaded): saves update the kept copy again. */
export function settleOlderSave(): void {
  olderSave = null;
}

/** What the page says when `olderSaveOnLoad` finds one. */
export const OLDER_SAVE_TEXT =
  "An older spDEX saved settings in this browser since this version last did. It can't keep settings it doesn't know, such as a second opinion, so those may have gone. Restore the settings this version saved (whatever the older one changed is dropped), or keep these.";

export function saveConfig(config: SpdexConfig, storage: ConfigStorage | null = safeStorage()): void {
  known = config;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(config));
    if (olderSave === null) storage?.setItem(NEWEST_KEY, JSON.stringify({ schemaVersion: config.schemaVersion, config }));
  } catch {
    // Private browsing and full quotas both land here. The app keeps working
    // for this session; only persistence is lost.
  }
}

export function clearConfig(storage: ConfigStorage | null = safeStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
    storage?.removeItem(NEWEST_KEY);
  } catch {
    /* see saveConfig */
  }
}

/** What `watchConfigFromOtherTabs` does when a tab running an older spDEX saves. */
export interface OtherTabOptions {
  /**
   * This tab's config, written back over the older one. By default the one
   * this tab last loaded, saved or adopted, which is the same thing in the app.
   */
  current?: () => SpdexConfig;
  /** Told after the write-back, to say so (`OLDER_TAB_TEXT`). */
  onOlderTab?: () => void;
  /** For tests: the storage read and written back to. The page's by default. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

/** Where `storage` events arrive from: `window`, in the app. */
export interface ConfigEventSource {
  addEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
}

/**
 * What another tab just saved, as this tab should adopt it: the config,
 * migrated; the preset when the config was removed (storage cleared, as a
 * reload here would find it); or null when what was saved can't be read.
 *
 * Null is not the preset. `loadConfig` falls back to the preset so that a
 * damaged config can never keep the app from opening; adopting that fallback
 * here would instead reset every open tab the moment one of them saved
 * something unreadable — dropping their plans from the config the runner
 * reads, and handing the next edit in any of them a preset to save over the
 * real config.
 */
export function readConfigForAdoption(storage: Pick<Storage, "getItem"> | null = safeStorage()): SpdexConfig | null {
  const read = readOtherTabConfig(storage);
  return read.kind === "adopt" ? read.config : null;
}

/**
 * What another tab saved, and what this tab should do about it:
 * - `adopt`: a config this version reads, migrated (or the preset, when the
 *   config was removed);
 * - `older`: one written by an older spDEX (its `schemaVersion` is below
 *   this build's). Never adopted: migrating it would quietly drop whatever
 *   the newer version added, such as a second opinion the person switched
 *   on, and a reload would then open with the weaker settings;
 * - `unreadable`: anything else (see `readConfigForAdoption`).
 */
export type OtherTabConfig =
  | { kind: "adopt"; config: SpdexConfig }
  | { kind: "older"; version: number }
  | { kind: "unreadable" };

export function readOtherTabConfig(storage: Pick<Storage, "getItem"> | null = safeStorage()): OtherTabConfig {
  if (storage === null) return { kind: "unreadable" };
  let stored: string | null;
  try {
    stored = storage.getItem(STORAGE_KEY);
  } catch {
    return { kind: "unreadable" };
  }
  if (!stored) return { kind: "adopt", config: recommendedConfig() };
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return { kind: "unreadable" };
  }
  const version = typeof raw === "object" && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version === "number" && Number.isSafeInteger(version) && version < CONFIG_SCHEMA_VERSION) {
    return { kind: "older", version };
  }
  try {
    return { kind: "adopt", config: migrateConfig(raw) };
  } catch {
    return { kind: "unreadable" };
  }
}

/** What this tab says after putting its settings back over an older tab's. */
export const OLDER_TAB_TEXT =
  "Another spDEX tab running an older version just saved settings. Close or reload it; this tab kept yours.";

function safeStorage(): ConfigStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Hear about a config another tab saved, already migrated.
 *
 * Every tab holds the config in memory and saves the whole of it on any edit,
 * so a tab that never re-reads it will one day write its stale copy back. For
 * most settings that is an annoyance; for auto-buy it is money: a plan paused
 * in one tab would be un-paused by the next unrelated edit in another, and
 * the tab that actually runs the buys would never hear about the pause at
 * all. So the app adopts what another tab saved — as its config, without
 * saving it again — the moment it is saved. `storage` events never fire in the
 * tab that wrote, so this only ever reports other tabs' writes. A write that
 * can't be read is ignored (see `readConfigForAdoption`), and this tab keeps
 * the config it has.
 *
 * One save is never adopted: an older spDEX's (`readOtherTabConfig`'s
 * `older`). Its config lacks what the newer version added, a second opinion
 * among them, so adopting it would switch a check off without anyone asking.
 * This tab keeps its own and writes it back once, so the older one doesn't
 * stay in storage for the next reload to open, and `options.onOlderTab`
 * hears about it, for `OLDER_TAB_TEXT`.
 *
 * Returns the unsubscribe function. No event source (tests, no DOM): a no-op.
 */
export function watchConfigFromOtherTabs(
  onChange: (config: SpdexConfig) => void,
  events: ConfigEventSource | null = typeof window === "undefined" ? null : window,
  read: () => SpdexConfig | null = readConfigForAdoption,
  options: OtherTabOptions = {},
): () => void {
  if (!events) return () => {};
  const listener = (event: { key: string | null }) => {
    // null: another tab cleared this origin's storage, config included.
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const storage = options.storage === undefined ? safeStorage() : options.storage;
    const other = readOtherTabConfig(storage);
    if (other.kind === "older") {
      // Put this tab's settings back, once per such save, so storage never
      // keeps the older version's and a reload can't weaken the Guard. An
      // older build can't read what is written back (its version is newer),
      // so it ignores it rather than answering with another write.
      const mine = options.current?.() ?? known;
      if (mine !== null && storage !== null) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(mine));
        } catch {
          // Nothing more this tab can do; it still hasn't adopted the older one.
        }
      }
      try {
        options.onOlderTab?.();
      } catch {
        // Saying so must not undo keeping this tab's settings.
      }
      return;
    }
    const next = read();
    if (next !== null) {
      known = next;
      onChange(next);
    }
  };
  events.addEventListener("storage", listener);
  return () => events.removeEventListener("storage", listener);
}

const FEATURES_SEEN_KEY = "spdex.features.seen.v1";

/**
 * Whether the user has been shown the features dialog.
 *
 * Kept separate from the config rather than added to it, because it is not a
 * setting — it is a fact about this browser. Putting it in the config would
 * mean exporting it, diffing it, and having it travel in a shared link, where
 * it would read as a meaningless line of noise in the one view that has to
 * stay worth reading.
 */
export function featuresSeen(): boolean {
  try {
    return localStorage.getItem(FEATURES_SEEN_KEY) === "1";
  } catch {
    // Private browsing: show the dialog. Offering the choice twice is a far
    // smaller failure than never offering it.
    return false;
  }
}

export function markFeaturesSeen(): void {
  try {
    localStorage.setItem(FEATURES_SEEN_KEY, "1");
  } catch {
    /* see saveConfig */
  }
}

/** A config offered by the URL, awaiting the user's explicit acceptance. */
export type StagedConfig =
  | { kind: "config"; config: SpdexConfig }
  | { kind: "error"; error: string };

export function stagedConfigFromUrl(): StagedConfig | null {
  const fragment = window.location.hash;
  if (!fragment || !fragment.includes("config=")) return null;
  try {
    return { kind: "config", config: readShareFragment(fragment) };
  } catch (error) {
    return {
      kind: "error",
      error:
        error instanceof ConfigParseError
          ? error.message
          : `could not read the shared config: ${error instanceof Error ? error.message : error}`,
    };
  }
}

export function clearUrlFragment(): void {
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

// ─── The built-in network service ────────────────────────────────────────────

/** This build's network-service settings (`.env.defaults`, docs/RPC-RUNBOOK.md). */
export interface RpcBuild {
  /** The built-in service's URL, key included: `VITE_SPDEX_DEFAULT_RPC_URL`. */
  url?: string | undefined;
  /**
   * Where the key is allowlisted: `VITE_SPDEX_CANONICAL_ORIGIN`, one origin
   * or several separated by commas or spaces (the release's domain, and its
   * `.eth.limo` name, say).
   */
  canonical?: string | undefined;
  /** A free public service, offered by a button: `VITE_SPDEX_PUBLIC_FALLBACK_RPC_URL`. */
  fallback?: string | undefined;
}

// Read by name, one property each, so the build puts in each value on its own.
const RPC_BUILD: RpcBuild = {
  url: import.meta.env.VITE_SPDEX_DEFAULT_RPC_URL as string | undefined,
  canonical: import.meta.env.VITE_SPDEX_CANONICAL_ORIGIN as string | undefined,
  fallback: import.meta.env.VITE_SPDEX_PUBLIC_FALLBACK_RPC_URL as string | undefined,
};

/** This page's origin, or null where there is no page (unit tests run in node). */
function pageOrigin(): string | null {
  try {
    return window.location.origin;
  } catch {
    return null;
  }
}

/**
 * The canonical origins, each as `new URL(…).origin` gives it, so
 * "https://spdex.example/" and "https://spdex.example" are the same one; or
 * null when the setting names something that isn't an http(s) origin.
 *
 * Null fails closed: a bare host ("spdex.example", which is how Alchemy's
 * Domains list writes it) or any other typo means the built-in service is
 * neither used without asking nor offered anywhere, rather than offered at
 * every origin as if none had been named. The build refuses such a setting
 * (vite.config.ts), so a release can't ship with it.
 */
export function canonicalOrigins(build: RpcBuild = RPC_BUILD): string[] | null {
  const origins: string[] = [];
  for (const part of (build.canonical ?? "").split(/[\s,]+/)) {
    if (part === "") continue;
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      return null;
    }
    // Anything but a web page's origin (a file: page reads as "null") can't be matched.
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * Whether the built-in service is usable here, for FirstRun's one-click
 * button: its URL, or null.
 *
 * The key is allowlisted to the canonical origins, so on an IPFS gateway or a
 * self-hosted copy it simply will not work, and offering it there would
 * produce a confusing failure rather than an honest question. A build with a
 * key and no canonical origin offers it everywhere (a local build, say); one
 * whose canonical setting can't be read offers it nowhere.
 */
export function bundledRpcAvailable(build: RpcBuild = RPC_BUILD, origin: string | null = pageOrigin()): string | null {
  if (!build.url) return null;
  const canonical = canonicalOrigins(build);
  if (canonical === null) return null;
  if (canonical.length > 0 && (origin === null || !canonical.includes(origin))) return null;
  return build.url;
}

/**
 * The built-in service to use without asking: its URL where a key is built in
 * *and* this page is at one of the origins it is allowlisted to, else null.
 *
 * That is the release as its publisher hosts it, where the key works. Anywhere
 * else (a gateway, a self-hosted copy, a build with no canonical origin, or
 * one whose canonical setting can't be read) the person is asked instead
 * (FirstRun). The disclaimer names the service before anything is sent to it
 * (App.tsx waits for the first visit's Continue).
 */
export function autoBundledRpc(build: RpcBuild = RPC_BUILD, origin: string | null = pageOrigin()): string | null {
  if (!build.url || origin === null) return null;
  return canonicalOrigins(build)?.includes(origin) ? build.url : null;
}

/** This copy's built-in service: where it works (`bundledRpcAvailable`), and where it is used without asking (`autoBundledRpc`). */
export interface BuiltInService {
  usable: string | null;
  automatic: string | null;
}

/**
 * The built-in service as this tab *uses* it, never saved: source "bundled"
 * is this copy's built-in service, so a config that saved another build's key
 * reads with this build's (`usable`). A rotated key isn't kept on by every
 * browser that chose it.
 *
 * Never saved, because another build may be open beside this one: a tab left
 * open across a release, on the same origin, holds the other key. If either
 * saved its key over the other's, the other would adopt that save
 * (`watchConfigFromOtherTabs`), put its own back, and so on, forever, each
 * step a fresh round of reads on the shared key. So the swap happens on load
 * and on adopting another tab's save, in memory only; what is saved carries
 * whichever build's key saved it, and every build reads it as its own.
 *
 * A service the person chose ("user", "fallback") is never touched, and a
 * config with no service yet is left for `builtInServiceToSave`. Returns the
 * same object when nothing changes.
 */
export function builtInServiceInUse(config: SpdexConfig, service: BuiltInService): SpdexConfig {
  const { url, source } = config.rpc;
  if (source !== "bundled" || url === null || url === "" || service.usable === null || url === service.usable) return config;
  return { ...config, rpc: { url: service.usable, source: "bundled" } };
}

/**
 * The one change to the built-in service a tab saves: a config on it with no
 * address yet gets this copy's, where it is used without asking (`automatic`,
 * from `autoBundledRpc`). Only an empty address is filled, so no tab ever
 * saves in answer to another build's key (see `builtInServiceInUse`).
 *
 * "user" with no service is Settings' Change service, which must not snap
 * back to the built-in one, and is never touched; nor is any service the
 * person chose. Returns the same object when nothing changes.
 */
export function builtInServiceToSave(config: SpdexConfig, service: BuiltInService): SpdexConfig {
  const { url, source } = config.rpc;
  if (source !== "bundled" || (url !== null && url !== "") || service.automatic === null) return config;
  return { ...config, rpc: { url: service.automatic, source: "bundled" } };
}

/**
 * A config from someone else (a share link, an imported file) as it applies
 * here: one with no network-service address keeps this browser's service,
 * and the chain that service is on.
 *
 * A config sent from the built-in service carries no address (`forSharing`),
 * nor does one sent from the "choose a service" screen: the sender had none
 * to give. Taking its empty service would move the recipient off the one they
 * chose — onto this copy's built-in service, whose operator then sees their
 * IP address, with nothing in the review saying so. A config that names an
 * address is left as it is, so the review shows that change.
 */
export function withOwnService(incoming: SpdexConfig, current: SpdexConfig): SpdexConfig {
  if (incoming.rpc.url !== null && incoming.rpc.url !== "") return incoming;
  if (incoming.rpc === current.rpc && incoming.chainId === current.chainId) return incoming;
  return { ...incoming, chainId: current.chainId, rpc: current.rpc };
}

/** The free public service FirstRun and the built-in-service notice offer, or null. */
export function publicFallbackRpc(build: RpcBuild = RPC_BUILD): string | null {
  return build.fallback ? build.fallback : null;
}

/**
 * A config as it leaves this browser (an exported file, a share link).
 *
 * On the built-in service it carries no address: the key is this copy's
 * publisher's, and whoever opens the file gets their own copy's built-in
 * service (or is asked, where there is none). Any other service goes as it is.
 */
export function forSharing(config: SpdexConfig): SpdexConfig {
  if (config.rpc.source !== "bundled" || config.rpc.url === null) return config;
  return { ...config, rpc: { url: null, source: "bundled" } };
}
