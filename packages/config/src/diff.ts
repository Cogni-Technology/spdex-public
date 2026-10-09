/**
 * Showing how a config departs from a baseline.
 *
 * Handing someone a full configuration file and calling it control is only
 * half the job — they also need to see, at a glance, what they have changed
 * from the default. It is what makes an imported config from a stranger
 * reviewable rather than a leap of faith, and it is what lets a user undo one
 * decision without resetting everything.
 */

import type { SpdexConfig } from "@spdex/core";

export interface ConfigChange {
  /** Dotted path, e.g. `router.maxSplits` or `pools.allow[0].poolId`. */
  path: string;
  from: unknown;
  to: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(from: unknown, to: unknown, path: string, out: ConfigChange[]): void {
  if (Array.isArray(from) || Array.isArray(to)) {
    const fromArray = Array.isArray(from) ? from : [];
    const toArray = Array.isArray(to) ? to : [];
    const length = Math.max(fromArray.length, toArray.length);
    for (let i = 0; i < length; i++) {
      walk(fromArray[i], toArray[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (isPlainObject(from) && isPlainObject(to)) {
    // Union of keys: a field added or removed is a change, not an absence.
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      walk(from[key], to[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }

  if (from !== to) out.push({ path, from, to });
}

/**
 * Full comparison between two configs.
 *
 * Use this to answer "what would change if I accepted that one" — including the
 * RPC endpoint, which is exactly the field a hostile shared config would target.
 */
export function diffConfig(baseline: SpdexConfig, candidate: SpdexConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  walk(baseline, candidate, "", changes);
  // `preset` flips to "custom" the moment anything else changes, so reporting it
  // would add a line to every diff that says nothing the diff does not already.
  return changes.filter((change) => change.path !== "preset");
}

/**
 * Comparison against the shipped preset, for "have I customised anything?".
 *
 * The endpoint and the chain id are excluded here and only here, because
 * neither is chosen — both are adopted from whichever node the user pointed at.
 * The preset deliberately ships without an endpoint address, since the
 * built-in service's key is each copy's own and only works on its canonical
 * origins, and the chain id simply follows it. Listing
 * either would put a line in every single user's diff and make "identical to
 * recommended" a state nobody could reach, which drains the signal out of the
 * comparison.
 *
 * They are emphatically *not* excluded from `diffConfig`. When someone hands
 * you a config, the endpoint and the chain it points at are the first two
 * things you need to look at.
 */
const ADOPTED_FROM_ENDPOINT = ["rpc", "chainId"];

export function diffFromPreset(preset: SpdexConfig, candidate: SpdexConfig): ConfigChange[] {
  return diffConfig(preset, candidate).filter(
    (change) =>
      !ADOPTED_FROM_ENDPOINT.some(
        (field) => change.path === field || change.path.startsWith(`${field}.`),
      ),
  );
}

/** True when a config is materially the shipped preset, endpoint aside. */
export function isPreset(baseline: SpdexConfig, candidate: SpdexConfig): boolean {
  return diffFromPreset(baseline, candidate).length === 0;
}
