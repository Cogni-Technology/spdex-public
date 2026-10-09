/**
 * Builders for simulation logs.
 *
 * Red-team tests need to express "the transaction moves SPX from the user to
 * an attacker" precisely and without a chain. Constructing the log stream
 * directly is both exact and fast — and it lets an attack that would be
 * awkward to stage on a fork be written in one line.
 */

import { TOPICS } from "@spdex/chain";
import type { SimLog } from "@spdex/chain";
import { PERMIT2_ADDRESS, type Address, type Hex } from "@spdex/core";

/** Left-pad an address into a 32-byte topic. */
export function addressTopic(address: Address): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

/** Encode a uint256 into 32 bytes of log data. */
export function uint256Data(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export function transferLog(
  token: Address,
  from: Address,
  to: Address,
  amount: bigint,
): SimLog {
  return {
    address: token.toLowerCase() as Address,
    topics: [TOPICS.transfer, addressTopic(from), addressTopic(to)],
    data: uint256Data(amount),
  };
}

export function approvalLog(
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
): SimLog {
  return {
    address: token.toLowerCase() as Address,
    topics: [TOPICS.approval, addressTopic(owner), addressTopic(spender)],
    data: uint256Data(amount),
  };
}

/** A uint48 word for an expiration or a nonce; the largest by default, as a drainer would ask. */
const uint48 = (value: bigint) => value.toString(16).padStart(64, "0");

/**
 * Permit2's own `Approval(owner, token, spender, amount, expiration)`: what
 * `Permit2.approve` logs when it sets an allowance inside Permit2. The layout
 * is the one a real Permit2 logs on the fork (see
 * packages/guard/test/integration/permit2-effects.test.ts).
 */
export function permit2ApprovalLog(
  owner: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  expiration: bigint = (1n << 48n) - 1n,
): SimLog {
  return {
    address: PERMIT2_ADDRESS,
    topics: [TOPICS.permit2Approval, addressTopic(owner), addressTopic(token), addressTopic(spender)],
    data: `${uint256Data(amount)}${uint48(expiration)}` as Hex,
  };
}

/** Permit2's `Permit(owner, token, spender, amount, expiration, nonce)`: an allowance set from a signature. */
export function permit2PermitLog(
  owner: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  expiration: bigint = (1n << 48n) - 1n,
  nonce = 0n,
): SimLog {
  return {
    address: PERMIT2_ADDRESS,
    topics: [TOPICS.permit2Permit, addressTopic(owner), addressTopic(token), addressTopic(spender)],
    data: `${uint256Data(amount)}${uint48(expiration)}${uint48(nonce)}` as Hex,
  };
}

/** A Transfer log the Guard cannot decode — used to prove it fails closed. */
export function malformedTransferLog(token: Address): SimLog {
  return {
    address: token.toLowerCase() as Address,
    topics: [TOPICS.transfer],
    data: "0x",
  };
}
