/**
 * Reading Permit2: whether the contract at its address is the one spDEX knows,
 * and which of an owner's nonces are spent.
 *
 * Here rather than in core because both need the network, and the first needs
 * keccak256, which core does without. What they are compared against — the
 * address, the code hash, the nonce layout — is core's (`@spdex/core` tips.ts),
 * so the reader and the Guard agree on it by construction.
 */

import { keccak256 } from "viem";
import { isPermit2CodeHash, PERMIT2_ADDRESS, type Address, type Hex } from "@spdex/core";
import type { JsonRpc } from "./reader.js";

/**
 * keccak256 of the code at `address`, as the endpoint reports it at the latest
 * block. An address with no code hashes the empty string. Throws when the
 * endpoint gives no answer that is code, so "couldn't read" never passes for
 * "nothing there".
 */
export async function codeHashAt(rpc: JsonRpc, address: Address): Promise<Hex> {
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) {
    throw new Error(`could not read the code at ${address}: the endpoint answered ${JSON.stringify(code)}`);
  }
  return keccak256(code.toLowerCase() as Hex);
}

/**
 * Whether Permit2 is the contract spDEX knows on this endpoint's chain: true,
 * false (other code, or none), or `"unknown"` when the code could not be read.
 * Unknown is never treated as yes: a caller that gets it sends tips the old
 * way, one transfer each.
 */
export async function permit2Status(rpc: JsonRpc): Promise<boolean | "unknown"> {
  try {
    return isPermit2CodeHash(await codeHashAt(rpc, PERMIT2_ADDRESS));
  } catch {
    return "unknown";
  }
}

/** `nonceBitmap(address,uint256)`. */
export const PERMIT2_NONCE_BITMAP_SELECTOR = "0x4fe02b44";

/**
 * One word of an owner's unordered-nonce bitmap: bit `b` set means nonce
 * `(word << 8) | b` is spent. Throws on an answer that is not a word, because
 * a bitmap read as zero would call every nonce in it unused.
 */
export async function permit2NonceBitmap(rpc: JsonRpc, owner: Address, word: bigint): Promise<bigint> {
  const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const data = `${PERMIT2_NONCE_BITMAP_SELECTOR}${pad(owner)}${pad(word.toString(16))}`;
  const raw = await rpc("eth_call", [{ to: PERMIT2_ADDRESS, data }, "latest"]);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`could not read Permit2's nonce record: the endpoint answered ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}
