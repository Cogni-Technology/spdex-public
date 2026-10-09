/**
 * Turning simulation logs into "what actually moved".
 *
 * The Guard's assertions are all about observable effects on real accounts, so
 * this module reduces a log stream to balance deltas and granted approvals.
 *
 * ## Fail-closed by construction
 *
 * Deltas are derived from ERC-20 `Transfer` events. A token that moves balances
 * without emitting them produces a delta of zero here — which fails
 * `MIN_OUT_NOT_MET` and rejects the swap. Unknown therefore reads as unsafe,
 * never as safe, which is the only acceptable default when the code proposing
 * the transaction is untrusted.
 *
 * The converse is a real and documented limitation: a *token contract* that
 * drains a balance without logging it would go unseen. That is a malicious-token
 * problem rather than a malicious-module one — the threat this layer addresses —
 * and it is why the token list is itself a user-controlled module.
 * See docs/THREAT-MODEL.md.
 *
 * ## Allowances that live outside the token
 *
 * An ERC-20 `Approval` is not the only way to leave a spender able to take a
 * balance later. Permit2 keeps allowances of its own, set by `approve` (from
 * the owner's own transaction, no signature) or by `permit` (from a
 * signature), and a spender holding one can pull the owner's tokens through
 * Permit2 for as long as Permit2 holds the ERC-20 permission. spDEX asks for
 * exactly that permission, unlimited, for batched tips. So Permit2's two
 * events are read here as approvals too, marked `via: "permit2"`, and every
 * Guard path that refuses an undeclared approval refuses these.
 *
 * Only Permit2's, and only from Permit2's own address: an event is evidence
 * of the contract that logged it. Other contracts with private allowance
 * books exist, and one the user already gave an ERC-20 permission to could
 * be armed the same way; this layer cannot recognise every such book, which
 * is why it reads the one spDEX itself arms. See docs/THREAT-MODEL.md.
 */

import { TOPICS } from "@spdex/chain";
import type { SimLog } from "@spdex/chain";
import { PERMIT2_ADDRESS, type Address, type Hex } from "@spdex/core";

export interface TokenDelta {
  token: Address;
  account: Address;
  /** Negative means the account lost tokens. */
  delta: bigint;
}

export interface GrantedApproval {
  token: Address;
  owner: Address;
  spender: Address;
  amount: bigint;
  /**
   * Absent for the token's own ERC-20 allowance. `"permit2"` for an
   * allowance inside Permit2 on `token`, which no plan ever declares: a
   * declared ERC-20 approval for the same token and spender is a different,
   * bounded permission, and must never be read as covering this one.
   */
  via?: "permit2";
}

export interface ObservedEffects {
  /** Keyed `${token}:${account}`. */
  deltas: Map<string, TokenDelta>;
  approvals: GrantedApproval[];
  /** Logs with a Transfer/Approval topic we could not decode. */
  undecodable: number;
}

const deltaKey = (token: Address, account: Address) => `${token}:${account}`;

/** A 32-byte topic holds a left-padded address in its low 20 bytes. */
function topicToAddress(topic: Hex): Address | null {
  if (topic.length !== 66) return null;
  return `0x${topic.slice(26)}`.toLowerCase() as Address;
}

function dataToBigInt(data: Hex): bigint | null {
  if (data === "0x" || data.length < 3) return null;
  try {
    return BigInt(data.length > 66 ? `0x${data.slice(2, 66)}` : data);
  } catch {
    return null;
  }
}

export function observeEffects(logs: SimLog[]): ObservedEffects {
  const deltas = new Map<string, TokenDelta>();
  const approvals: GrantedApproval[] = [];
  let undecodable = 0;

  const credit = (token: Address, account: Address, amount: bigint) => {
    const key = deltaKey(token, account);
    const existing = deltas.get(key);
    if (existing) existing.delta += amount;
    else deltas.set(key, { token, account, delta: amount });
  };

  for (const log of logs) {
    const topic0 = log.topics[0];
    if (!topic0) continue;

    if (topic0 === TOPICS.transfer) {
      const from = log.topics[1] ? topicToAddress(log.topics[1]) : null;
      const to = log.topics[2] ? topicToAddress(log.topics[2]) : null;
      const amount = dataToBigInt(log.data);
      // A Transfer we cannot decode is counted, not ignored: the Guard treats a
      // nonzero count as a reason to refuse rather than to shrug.
      if (from === null || to === null || amount === null) {
        undecodable += 1;
        continue;
      }
      credit(log.address, from, -amount);
      credit(log.address, to, amount);
      continue;
    }

    if (topic0 === TOPICS.approval) {
      const owner = log.topics[1] ? topicToAddress(log.topics[1]) : null;
      const spender = log.topics[2] ? topicToAddress(log.topics[2]) : null;
      const amount = dataToBigInt(log.data);
      if (owner === null || spender === null || amount === null) {
        undecodable += 1;
        continue;
      }
      approvals.push({ token: log.address, owner, spender, amount });
      continue;
    }

    // Permit2's own allowance book: owner, token and spender are all
    // indexed, and the data starts with the amount (a uint160 in a word).
    if (
      (topic0 === TOPICS.permit2Approval || topic0 === TOPICS.permit2Permit) &&
      log.address.toLowerCase() === PERMIT2_ADDRESS
    ) {
      const owner = log.topics[1] ? topicToAddress(log.topics[1]) : null;
      const token = log.topics[2] ? topicToAddress(log.topics[2]) : null;
      const spender = log.topics[3] ? topicToAddress(log.topics[3]) : null;
      const amount = dataToBigInt(log.data);
      if (owner === null || token === null || spender === null || amount === null) {
        undecodable += 1;
        continue;
      }
      approvals.push({ token, owner, spender, amount, via: "permit2" });
    }
  }

  return { deltas, approvals, undecodable };
}

export function deltaFor(
  effects: ObservedEffects,
  token: Address,
  account: Address,
): bigint {
  return effects.deltas.get(deltaKey(token, account))?.delta ?? 0n;
}

/** Every token the account lost, other than the one it agreed to spend. */
export function unexpectedOutflows(
  effects: ObservedEffects,
  account: Address,
  allowedToken: Address,
): TokenDelta[] {
  return [...effects.deltas.values()].filter(
    (d) => d.account === account && d.delta < 0n && d.token !== allowedToken,
  );
}
