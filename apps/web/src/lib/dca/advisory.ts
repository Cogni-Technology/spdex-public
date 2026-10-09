/**
 * Decision 31 of docs/DESIGN.md, prepared before it is needed: what the
 * app says if a bug is found in the SPX holder registry after v2 is deployed.
 *
 * The registry can't be patched, and every v2 vault names it for life. The
 * worst such bug lets addresses that never held SPX be paid inside community
 * windows, which is how every v1 buy works; no vault's money is at risk. So
 * the response is decided in advance: the app keeps creating vaults, says so
 * on every vault's card that uses this registry, above the form that creates
 * one and in Community keeping, and a fixed registry, vault, factory and
 * batcher ship as a new contract release (docs/THREAT-MODEL.md, "A bug in the
 * registry after it is deployed";
 * docs/SECURITY.md).
 *
 * `REGISTRY_ADVISORY` is that notice's text, and null in every build until
 * then: a build that needs it sets it here, in words the publisher has
 * checked, and nothing else changes. It ships in the bundle, like every word
 * the app says; nothing is fetched to learn of it (AGENTS.md rules 4 and 5).
 */

import { DEPLOYMENTS, MAINNET_REGISTRY, type VaultRelease } from "@spdex/vault";

/** The notice, word for word; null while there is nothing to warn of. */
export const REGISTRY_ADVISORY: string | null = null;

/**
 * The registry the notice is about: this build's, which v2's vaults ask. A
 * vault is warned when its release's factory names this registry, whatever
 * that release is called, so a later release that shares it is warned too and
 * one with a fixed registry is not.
 */
export const ADVISORY_REGISTRY: string = MAINNET_REGISTRY;

/** The notice's heading, wherever it is shown. */
export const REGISTRY_ADVISORY_TITLE = "A known problem with community windows";

/**
 * The notice for a vault of `release` (or for one about to be created, which
 * is the latest release's), or null: only vaults whose factory names the
 * registry it is about are warned (v1's name none), and a blank notice is none.
 */
export function registryAdvisoryFor(release: VaultRelease | null | undefined, advisory: string | null): string | null {
  const registry = release == null ? null : (DEPLOYMENTS.find((d) => d.id === release)?.registry ?? null);
  if (registry === null || registry !== ADVISORY_REGISTRY.toLowerCase() || advisory === null) return null;
  const text = advisory.trim();
  return text === "" ? null : text;
}
