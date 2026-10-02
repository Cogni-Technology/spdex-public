/**
 * Contracts nobody means to tip: sending a token to one of these loses it.
 *
 * The tokens spDEX lists, Permit2, the vault factory and its batcher, the
 * Uniswap contracts the markets use, and every contract a shipped venue
 * declares. "My tip list" refuses each (with its name), `tippableRecipients`
 * skips one that arrives some other way, and the Engine hands the same list
 * to TipGuard as `refuseRecipients`, so a transfer to one is refused there
 * too, whatever the config says.
 */

import { CONTRACTS } from "@spdex/chain";
import { PERMIT2_ADDRESS, type Address } from "@spdex/core";
import { MAINNET_BATCHER, MAINNET_FACTORY, MAINNET_IMPLEMENTATION } from "@spdex/vault";
import v2Manifest from "../../../../../modules/venue-uniswap-v2/manifest.json";
import v3Manifest from "../../../../../modules/venue-uniswap-v3/manifest.json";
import { isNative, TOKEN_LIST } from "../tokens.js";

/** What each known contract is called, in "That's {name}". */
function build(): ReadonlyMap<string, string> {
  const known = new Map<string, string>();
  const add = (address: string, name: string) => {
    const key = address.toLowerCase();
    if (!known.has(key)) known.set(key, name);
  };
  for (const token of TOKEN_LIST) if (!isNative(token)) add(token.address, `the ${token.symbol} token contract`);
  add(PERMIT2_ADDRESS, "Permit2, a contract");
  add(MAINNET_FACTORY, "the vault factory");
  add(MAINNET_BATCHER, "the vault batcher");
  add(MAINNET_IMPLEMENTATION, "the vault contract");
  for (const [key, address] of Object.entries(CONTRACTS)) {
    add(address, /router/i.test(key) ? "a Uniswap router" : "a contract spDEX reads");
  }
  for (const manifest of [v2Manifest, v3Manifest]) {
    for (const address of manifest.contracts) add(address, "a Uniswap contract");
  }
  return known;
}

/** Every known contract, lowercase address → what to call it. */
export const KNOWN_CONTRACTS: ReadonlyMap<string, string> = build();

/** What a known contract is called, or null for anything else. */
export function knownContract(address: string): string | null {
  return KNOWN_CONTRACTS.get(address.toLowerCase()) ?? null;
}

/** The known contracts as addresses, for TipGuard's `refuseRecipients`. */
export const REFUSED_TIP_RECIPIENTS: readonly Address[] = [...KNOWN_CONTRACTS.keys()] as Address[];
