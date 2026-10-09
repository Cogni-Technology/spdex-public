/**
 * Reading and writing configs.
 *
 * Export is TOML because a config is meant to be read, diffed and edited by
 * hand — that is the whole point of handing it to the user. Import accepts TOML
 * or JSON, since anything that round-trips through a tool tends to come back as
 * JSON and rejecting it would be pedantry.
 *
 * Every path runs through `migrateConfig`, so an old file opens rather than
 * erroring, and a malformed one fails at the boundary rather than deeper in.
 */

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { SpdexConfig } from "@spdex/core";
import { migrateConfig } from "./migrate.js";

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

export function exportToml(config: SpdexConfig): string {
  const header = [
    "# spDEX configuration",
    "#",
    "# This file is yours. Edit it, share it, pin it to IPFS.",
    "# Import it back with Settings -> Import, or append it to a URL as",
    "#   #config=<base64url>   (see shareFragment).",
    "",
  ].join("\n");
  return `${header}${stringifyToml(config as unknown as Record<string, unknown>)}\n`;
}

export function exportJson(config: SpdexConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Pause every auto-buy plan in a config that came from outside this browser.
 *
 * A plan spends on a timer with nobody clicking anything, so one that started
 * the moment a link was opened or a file pasted would be spending the user's
 * money on a stranger's say-so. Paused, it sits in the list and in the diff
 * doing nothing, and starting it is one deliberate act by the person whose
 * money it is.
 *
 * It is applied in `importConfig` rather than left to the UI because that
 * function is the one funnel both outside paths share: a URL fragment is staged
 * and reviewed before it is applied, but a pasted file is applied immediately,
 * so a rule that lived in the review step would miss it entirely. Applying it
 * before anyone sees the config also keeps the staged diff honest — it shows
 * the plans as they would actually arrive, paused.
 *
 * This is the one field an export–import round trip deliberately does not
 * preserve, including for the user's own file. The config read back from this
 * browser's storage does not come through here, so plans the user started
 * here keep running across reloads. `dca.enabled` passes through unchanged:
 * with every plan paused it starts nothing, and the diff still shows it.
 *
 * A vault plan is already paused — the schema holds it there, because this
 * tab never runs one — so it passes through unchanged and round-trips
 * exactly. Nothing here can stop its vault, which buys on chain whoever holds
 * the config; what arriving from outside means for a vault plan is the host's
 * to show, and a vault the connected account does not own is shown as
 * someone else's, read-only.
 */
export function arrivePaused(config: SpdexConfig): SpdexConfig {
  if (config.dca.plans.every((plan) => plan.paused)) return config;
  return {
    ...config,
    dca: { ...config.dca, plans: config.dca.plans.map((plan) => ({ ...plan, paused: true })) },
  };
}

/**
 * Accepts TOML or JSON, migrating older schema versions on the way in.
 *
 * Everything returned has come from outside this browser, so its auto-buy plans
 * are paused (see `arrivePaused`).
 */
export function importConfig(text: string): SpdexConfig {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ConfigParseError("config is empty");

  let raw: unknown;
  if (trimmed.startsWith("{")) {
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      throw new ConfigParseError(`invalid JSON: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    try {
      raw = parseToml(trimmed);
    } catch (error) {
      throw new ConfigParseError(`invalid TOML: ${error instanceof Error ? error.message : error}`);
    }
  }

  return arrivePaused(migrateConfig(raw));
}

/** base64url, so a config survives a URL fragment without escaping. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Encode a config for a URL fragment.
 *
 * A fragment rather than a query parameter deliberately: fragments are not sent
 * to the server, so sharing a config does not leak it to whoever is hosting the
 * page.
 */
export function shareFragment(config: SpdexConfig): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(config)));
}

export function readShareFragment(fragment: string): SpdexConfig {
  const value = fragment.replace(/^#?(?:config=)?/, "");
  if (value.length === 0) throw new ConfigParseError("no config in fragment");
  let json: string;
  try {
    json = new TextDecoder().decode(fromBase64Url(value));
  } catch {
    throw new ConfigParseError("fragment is not valid base64url");
  }
  return importConfig(json);
}
