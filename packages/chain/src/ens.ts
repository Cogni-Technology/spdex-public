/**
 * An ENS name to an address, through the person's own network service and
 * nothing else.
 *
 * Used when someone adds a name to "My tip list". The address is what is
 * saved; the name is shown beside it and never looked up again. A shipped
 * list's `ens` is display only and never resolved here.
 *
 * ## What is followed, and what is not
 *
 * Two reads, both `eth_call`s to the endpoint the person chose (rule 4):
 * `resolver(node)` on the ENS registry, then `addr(node)` on that resolver.
 *
 * - **No CCIP-Read.** A resolver that answers `OffchainLookup` is asking the
 *   caller to fetch the answer from a URL it names. Following that would send
 *   the name, and the fact that this browser is asking about it, to a server
 *   nobody here chose. spDEX says so and asks for the address instead.
 * - **No wildcards.** ENSIP-10 has a caller walk up to a parent's resolver
 *   when a name has none of its own. Only the name's own resolver is read, so
 *   a name that exists only through a wildcard reads as unresolved.
 *
 * Either way the answer is the same: paste the address. Which of the two it
 * was only picks the wording.
 *
 * `normalize` (ENSIP-15) and `namehash` come from viem's ENS module, loaded
 * only when a name is actually looked up: its normalisation tables are the
 * bulk of it, and most visits never need them.
 */

import type { Address } from "@spdex/core";
import type { JsonRpc } from "./reader.js";

/** The ENS registry on Ethereum. Pinned; a fork test reads it at the pinned block. */
export const ENS_REGISTRY: Address = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";

/** `resolver(bytes32)` on the registry. */
const RESOLVER_SELECTOR = "0x0178b8bf";
/** `addr(bytes32)` on a resolver (EIP-137). */
const ADDR_SELECTOR = "0x3b3b57de";
/** `OffchainLookup(address,string[],bytes,bytes4,bytes)`: a CCIP-Read request (EIP-3668). */
export const OFFCHAIN_LOOKUP_SELECTOR = "0x556f1830";

export type EnsFailure = "invalid" | "offchain" | "unresolved" | "no-address" | "unreadable";

export type EnsLookup =
  | { ok: true; name: string; address: Address; resolver: Address }
  | { ok: false; reason: EnsFailure; message: string };

/** What each failure says, in one line each. */
export const ENS_MESSAGES: Record<EnsFailure, string> = {
  invalid: "That isn't a valid ENS name.",
  offchain: "This name's address is kept off chain; spDEX won't ask a third party. Paste the address.",
  unresolved: "This name isn't resolved on chain here; spDEX won't ask a third party. Paste the address.",
  "no-address": "No address set for this name.",
  unreadable: "Couldn't read the name through your network service. Try again, or paste the address.",
};

const fail = (reason: EnsFailure): EnsLookup => ({ ok: false, reason, message: ENS_MESSAGES[reason] });

/** True when a typed recipient should be read as an ENS name rather than an address. */
export function looksLikeEnsName(input: string): boolean {
  const text = input.trim();
  return text.includes(".") && !/^0x[0-9a-fA-F]*$/.test(text);
}

/** The last 20 bytes of a 32-byte word, or null for anything that isn't one. */
function wordAddress(result: unknown): Address | null {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}/.test(result)) return null;
  return `0x${result.slice(26, 66).toLowerCase()}` as Address;
}

const ZERO = /^0x0{40}$/;

/** A call's revert data, from the error `httpRpc` throws, or null. */
function revertData(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null && typeof (data as { data?: unknown }).data === "string") {
    return (data as { data: string }).data;
  }
  return null;
}

/**
 * True when the service answered that the call reverted, as opposed to not
 * answering, or refusing (a rate limit, say): only a revert is an answer
 * about the name.
 */
function isRevert(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 3 || revertData(error) !== null || /revert/i.test(String((error as Error | null)?.message));
}

/**
 * Resolve `input` through `rpc` alone: normalise it (ENSIP-15), read its
 * resolver from the registry, then `addr` from that resolver. Never throws;
 * every way it can fail is an `EnsLookup` with its sentence.
 */
export async function resolveEnsName(rpc: JsonRpc, input: string): Promise<EnsLookup> {
  const { normalize, namehash } = await import("viem/ens");
  let name: string;
  try {
    name = normalize(input.trim());
  } catch {
    return fail("invalid");
  }
  if (!name.includes(".") || name.startsWith(".") || name.endsWith(".")) return fail("invalid");
  const node = namehash(name).slice(2);

  let resolver: Address | null;
  try {
    resolver = wordAddress(await rpc("eth_call", [{ to: ENS_REGISTRY, data: `${RESOLVER_SELECTOR}${node}` }, "latest"]));
  } catch (error) {
    return isRevert(error) ? fail("unresolved") : fail("unreadable");
  }
  // No registry here (another network), or no resolver for this very name:
  // a wildcard parent is not followed.
  if (resolver === null || ZERO.test(resolver)) return fail("unresolved");

  let answer: unknown;
  try {
    answer = await rpc("eth_call", [{ to: resolver, data: `${ADDR_SELECTOR}${node}` }, "latest"]);
  } catch (error) {
    const data = revertData(error);
    if (data !== null && data.toLowerCase().startsWith(OFFCHAIN_LOOKUP_SELECTOR)) return fail("offchain");
    return isRevert(error) ? fail("unresolved") : fail("unreadable");
  }
  const address = wordAddress(answer);
  if (address === null) return fail("unresolved");
  if (ZERO.test(address)) return fail("no-address");
  return { ok: true, name, address, resolver };
}
