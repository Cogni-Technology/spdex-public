/**
 * The Tip row's arithmetic: chips, an even split, and the edits it makes.
 *
 * ## One number, shared evenly
 *
 * The row in the Trade card asks one question — "how much of this swap, in
 * total?" — and answers "who?" with a list of people. It never asks for a
 * share per person. So the model it writes is the simplest one that fits: the
 * chip is the total, and the total is divided evenly across whoever is chosen.
 * Adding or removing someone keeps the total and re-divides it; picking a chip
 * re-divides the new total. Uneven shares are still possible, in Expert's Tips
 * panel, and the row shows them as "custom" rather than flattening them until
 * the person asks it to.
 *
 * ## Refused, never clamped
 *
 * Every edit returns either the next config or the reason it was refused, and
 * each one is checked with `TipPolicySchema` — the same schema a saved config
 * is read back through. A number quietly pulled into range would leave the row
 * disagreeing with the config it just wrote, which is the one thing a control
 * that moves money must never do.
 *
 * Pure on purpose: no React, no engine. The row calls these and hands the
 * result to `applyConfig`; the tests call them directly.
 */

import { setFeature, TIP_FEATURE_ID } from "@spdex/config";
import {
  isPlaceholderChain,
  isPublicDevAccount,
  MAX_TIP_RECIPIENTS,
  MAX_TOTAL_TIP_BPS,
  PLACEHOLDER_CHAINS,
  TipPolicySchema,
  type SpdexConfig,
  type TipPolicy,
  type TipRecipient,
} from "@spdex/core";
import { formatNumber } from "./money/format.js";

/**
 * The shares the row offers, in basis points. 0 is Off.
 *
 * Small on purpose, and all well under the 5% ceiling: a thank-you is meant to
 * be a rounding error the person never has to think about again.
 */
export const TIP_CHIPS = [0, 10, 25, 50] as const;
export type TipChip = (typeof TIP_CHIPS)[number];

/**
 * What the chips show for a policy, as the `Toggle` value.
 *
 * - `"0"` — tips are off. A list kept from before is not shown as "on".
 * - `"10"`, `"25"`, `"50"` — on, and the total is exactly that chip.
 * - `"custom"` — on, with a total no chip stands for (set in Expert).
 * - `"unset"` — on, but nobody is chosen yet, so nothing will be sent.
 */
export type ChipValue = `${TipChip}` | "custom" | "unset";

/** Who a candidate is, as far as the row needs to know. */
export interface TipCandidate {
  address: string;
  label: string;
  handle?: string | undefined;
  /** The registry module that named this address, recorded as provenance. */
  registryId: string;
}

export type TipEdit = { ok: true; config: SpdexConfig } | { ok: false; error: string };

/** The registry of test entries (modules/tiplist-dev-fixtures): anvil's public development accounts. */
export const DEV_TIPLIST_ID = "tiplist-dev-fixtures";

/**
 * Registries whose list is test entries, not people: the dev fixtures, which
 * the Engine asks only on a local test network. The real list
 * (`TIPLIST_MODULE_ID`) holds real entries only, so it is not in here.
 */
export const PLACEHOLDER_REGISTRIES: ReadonlySet<string> = new Set([DEV_TIPLIST_ID]);

/** True when any of these names comes from a placeholder registry. */
export function listsPlaceholders(candidates: readonly Pick<TipCandidate, "registryId">[]): boolean {
  return candidates.some((candidate) => PLACEHOLDER_REGISTRIES.has(candidate.registryId));
}

/**
 * The networks test entries and public development accounts are allowed on:
 * the local fork (690069) and a local test network (31337). Defined in
 * `@spdex/core` beside `PUBLIC_DEV_ACCOUNTS`; re-exported here for the row.
 *
 * Nowhere else, because a test entry's address is one of anvil's published
 * development accounts, whose private keys are public: on Ethereum, a tip to
 * one is money anyone can take, and bots sweep those accounts within blocks.
 */
export { PLACEHOLDER_CHAINS };

/**
 * The names a picker may offer on `chainId`, and how many it held back: off
 * a local test network, every entry from a placeholder registry and every
 * public development account, whichever list names it. Retired entries are
 * never offered (the picker leaves them out itself).
 */
export function offeredCandidates<T extends Pick<TipCandidate, "registryId" | "address">>(
  candidates: readonly T[],
  chainId: number,
): { offered: T[]; withheld: number } {
  if (isPlaceholderChain(chainId)) return { offered: [...candidates], withheld: 0 };
  const offered = candidates.filter(
    (candidate) => !PLACEHOLDER_REGISTRIES.has(candidate.registryId) && !isPublicDevAccount(candidate.address),
  );
  return { offered, withheld: candidates.length - offered.length };
}

/** What a picker says in place of test entries it held back. */
export const NO_VERIFIED_LIST =
  "Test addresses are held back here: their keys are public, so they're offered only on a local test network.";

/** What a picker says while spDEX lists nobody. */
export const NO_LISTED_YET = "No listed people yet — add your own.";

/** A basis-point figure as a percentage, to two places at most: 25 → "0.25%". */
export function bpsText(bps: number): string {
  return `${formatNumber(bps / 100, { maximumFractionDigits: 2 })}%`;
}

/** Sum of every recipient's share, whether or not tipping is on. */
export function recipientsTotal(recipients: readonly TipRecipient[]): number {
  return recipients.reduce((sum, recipient) => sum + recipient.bps, 0);
}

/**
 * Divide `totalBps` evenly across `count` people, in whole basis points.
 *
 * The remainder goes to the first person, so the shares always add back up to
 * exactly the total — "0.25% to three people" sends 0.25%, not 0.24%. Null when
 * the total cannot give everyone at least one basis point (the schema's
 * smallest share), rather than a list with a zero in it.
 */
export function splitEvenly(totalBps: number, count: number): number[] | null {
  if (!Number.isInteger(totalBps) || !Number.isInteger(count) || count < 0) return null;
  if (count === 0) return [];
  if (totalBps < count) return null;
  const each = Math.floor(totalBps / count);
  const remainder = totalBps - each * count;
  return Array.from({ length: count }, (_, index) => (index === 0 ? each + remainder : each));
}

/** True when the shares are exactly what `splitEvenly` would have made of their total. */
export function isEvenSplit(recipients: readonly TipRecipient[]): boolean {
  const even = splitEvenly(recipientsTotal(recipients), recipients.length);
  return even !== null && even.every((bps, index) => recipients[index]?.bps === bps);
}

/** Which chip a policy shows; see `ChipValue`. */
export function chipValue(policy: TipPolicy): ChipValue {
  if (!policy.enabled) return "0";
  if (policy.recipients.length === 0) return "unset";
  const total = recipientsTotal(policy.recipients);
  return (TIP_CHIPS as readonly number[]).includes(total) ? (`${total}` as ChipValue) : "custom";
}

/**
 * How many tip transfers a swap will make: one per person while tipping is on
 * and something is being given, otherwise none.
 *
 * The count `tipDelivery` starts from, which decides between one transfer
 * each and a batch.
 */
export function tipTransferCount(policy: TipPolicy): number {
  if (!policy.enabled || recipientsTotal(policy.recipients) <= 0) return 0;
  return policy.recipients.length;
}

/**
 * Whether Permit2's standing permission on the token is already in place for
 * a tip: `"given"`, `"needed"`, or `"unknown"` while there is no wallet to ask.
 */
export type Permit2Permission = "given" | "needed" | "unknown";

/**
 * How a swap's tips will go out, as far as it can be known before the swap:
 *
 * - `none` — nothing is sent (tips off, nobody chosen, or ether out).
 * - `transfers` — one ERC-20 transfer each: always for one person, and for
 *   more when Permit2 on this network is not the one spDEX knows, or when a
 *   batch already failed for this wallet in this session.
 * - `batch` — two or more people, one signature and one transaction through
 *   Permit2, with a standing permission for Permit2 between them the first
 *   time.
 *
 * The one description the Tip row, the summary card, the safety banner and
 * the swap's step count all read, so they cannot disagree about what the
 * wallet will ask.
 */
export type TipDelivery =
  | { kind: "none" }
  | { kind: "transfers"; count: number }
  | { kind: "batch"; people: number; permission: Permit2Permission };

export function tipDelivery(
  policy: TipPolicy,
  options: {
    /** The swap pays out ether, which a tip cannot send yet. */
    native: boolean;
    /** Permit2 is the one spDEX knows here: true, false, or null while unknown. */
    permit2: boolean | null;
    permission: Permit2Permission;
    /**
     * False once a batch has failed for this wallet in this session (it
     * could not sign typed data, or the batch would revert for its account):
     * asking again would only repeat the failure, and the prompts before it.
     */
    batchable?: boolean;
  },
): TipDelivery {
  const count = options.native ? 0 : tipTransferCount(policy);
  if (count === 0) return { kind: "none" };
  // Unknown is shown as the batch, which it will be on Ethereum; if Permit2
  // turns out not to be known, the tips go as transfers and the status says so.
  if (count === 1 || options.permit2 === false || options.batchable === false) return { kind: "transfers", count };
  return { kind: "batch", people: count, permission: options.permission };
}

/**
 * `tipDelivery` for a swap on screen, from what the page has read: whether
 * Permit2 is known here, its allowance on the token, and the output the
 * swap is expected to deliver (for whether that allowance covers the tip).
 */
export function tipDeliveryFor(
  policy: TipPolicy,
  options: {
    native: boolean;
    permit2: boolean | null;
    allowance: bigint | null;
    amountOut: bigint | null;
    batchable?: boolean;
  },
): TipDelivery {
  return tipDelivery(policy, {
    native: options.native,
    permit2: options.permit2,
    permission: permit2Permission(
      options.allowance,
      options.amountOut === null ? null : tipShareOf(options.amountOut, recipientsTotal(policy.recipients)),
    ),
    ...(options.batchable === undefined ? {} : { batchable: options.batchable }),
  });
}

/**
 * Whether the permission is in place, from Permit2's allowance on the token:
 * unknown without a reading, given when it covers the tip (or, with no
 * estimate yet, when it is the unlimited one spDEX asks for).
 */
export function permit2Permission(allowance: bigint | null, estimatedTip: bigint | null): Permit2Permission {
  if (allowance === null) return "unknown";
  if (allowance >= 1n << 255n) return "given";
  if (estimatedTip !== null) return allowance >= estimatedTip && estimatedTip > 0n ? "given" : "needed";
  return allowance === 0n ? "needed" : "unknown";
}

/** Wallet prompts the tips add that are transactions: one per transfer, or the batch plus any permission. */
export function tipConfirmations(delivery: TipDelivery): number {
  switch (delivery.kind) {
    case "none":
      return 0;
    case "transfers":
      return delivery.count;
    case "batch":
      return delivery.permission === "given" ? 1 : 2;
  }
}

/**
 * Every wallet prompt the tips add, transactions and signatures alike: one
 * per transfer, or for a batch the signature and the transaction, plus the
 * permission unless it is known to be given. For the swap's "(step i of n)",
 * which counts prompts, not fees; the tip flow settles it once it knows.
 */
export function tipPrompts(delivery: TipDelivery): number {
  switch (delivery.kind) {
    case "none":
      return 0;
    case "transfers":
      return delivery.count;
    case "batch":
      return delivery.permission === "given" ? 2 : 3;
  }
}

/**
 * What the tips ask of the wallet, in words and in the order the wallet
 * asks: "1 extra confirmation", "2 extra confirmations", or for a batch "1
 * signature + 1 confirmation", with "a standing Permit2 permission" between
 * the two when it will be (or may be) asked for. The signature comes first
 * (lib/tipFlow.ts says why), so a wallet that can't sign typed data is never
 * asked for the permission. "Standing" rather than "one-time": it is asked
 * for once and then stays, unlimited, until revoked, and "one-time" read as
 * single-use.
 */
export function tipCostText(delivery: TipDelivery): string {
  switch (delivery.kind) {
    case "none":
      return "";
    case "transfers":
      return delivery.count === 1 ? "1 extra confirmation" : `${delivery.count} extra confirmations`;
    case "batch":
      return delivery.permission === "needed"
        ? "1 signature, a standing Permit2 permission, then 1 confirmation"
        : delivery.permission === "unknown"
          ? "1 signature, a standing Permit2 permission the first time, then 1 confirmation"
          : "1 signature + 1 confirmation";
  }
}

/** A person's share of an amount: rounded down, as the transfer itself is. */
export function tipShareOf(amount: bigint, bps: number): bigint {
  if (amount <= 0n || bps <= 0) return 0n;
  return (amount * BigInt(bps)) / 10_000n;
}

/** The short name on a recipient's pill: the handle when there is one. */
export function pillName(recipient: Pick<TipRecipient, "label" | "handle">): string {
  return recipient.handle && recipient.handle.length > 0 ? recipient.handle : recipient.label;
}

/** Give each recipient their even share of `totalBps`, in order. */
function reshare(recipients: readonly TipRecipient[], totalBps: number): TipRecipient[] | null {
  const shares = splitEvenly(totalBps, recipients.length);
  if (shares === null) return null;
  return recipients.map((recipient, index) => ({ ...recipient, bps: shares[index]! }));
}

/**
 * Check a proposed policy and, if it passes, put it in the config.
 *
 * Through `TipPolicySchema`, the same schema a saved config is read back with,
 * so nothing the row writes can make the config unreadable on the next load.
 * The sentences say what to do about each refusal rather than quoting zod.
 */
function commit(config: SpdexConfig, tips: TipPolicy): TipEdit {
  const total = recipientsTotal(tips.recipients);
  if (total > MAX_TOTAL_TIP_BPS) {
    return { ok: false, error: `Tips cannot total more than ${bpsText(MAX_TOTAL_TIP_BPS)} of a swap.` };
  }
  if (tips.recipients.length > MAX_TIP_RECIPIENTS) {
    return { ok: false, error: `At most ${MAX_TIP_RECIPIENTS} people.` };
  }
  const parsed = TipPolicySchema.safeParse(tips);
  if (!parsed.success) {
    return { ok: false, error: `Not applied: ${parsed.error.issues[0]?.message ?? "the tip list is not valid"}.` };
  }
  return { ok: true, config: { ...config, tips: parsed.data, preset: "custom" } };
}

/**
 * Pick a chip.
 *
 * Off goes through the feature's own switch, which stops the tipping and keeps
 * the list — turning tips off should not silently discard people somebody
 * chose. A share turns the feature on the same way (the registry module with
 * it) and re-divides the new total across whoever is already chosen. With
 * nobody chosen yet the result is "on, nobody": nothing is sent until someone
 * is, and the row opens its picker to say so.
 */
export function applyTipChip(config: SpdexConfig, bps: TipChip): TipEdit {
  if (bps === 0) return { ok: true, config: setFeature(config, TIP_FEATURE_ID, false) };
  const on = setFeature(config, TIP_FEATURE_ID, true);
  const recipients = reshare(on.tips.recipients, bps);
  if (recipients === null) {
    return { ok: false, error: `${bpsText(bps)} cannot be shared among ${on.tips.recipients.length} people.` };
  }
  return commit(on, { enabled: true, recipients });
}

/**
 * Add someone from a registry, keeping the total and re-dividing it evenly.
 *
 * `totalBps` is the share the row is showing: the current total, or the chip
 * just picked when nobody was chosen yet. The *address* is what is saved — a
 * registry maps a name to an address and is not trusted to keep doing so — and
 * it is saved lowercase so the duplicate check cannot be fooled by casing.
 */
export function addTipRecipient(config: SpdexConfig, candidate: TipCandidate, totalBps: number): TipEdit {
  const address = candidate.address.toLowerCase() as `0x${string}`;
  const chosen = config.tips.recipients;
  if (chosen.some((recipient) => recipient.address.toLowerCase() === address)) {
    return { ok: false, error: `${candidate.label} is already chosen.` };
  }
  if (chosen.length >= MAX_TIP_RECIPIENTS) {
    return { ok: false, error: `At most ${MAX_TIP_RECIPIENTS} people.` };
  }
  const added: TipRecipient = {
    address,
    label: candidate.label,
    ...(candidate.handle === undefined ? {} : { handle: candidate.handle }),
    source: candidate.registryId,
    bps: 1,
  };
  const recipients = reshare([...chosen, added], totalBps);
  if (recipients === null) {
    return { ok: false, error: `${bpsText(totalBps)} cannot be shared among ${chosen.length + 1} people.` };
  }
  const on = setFeature(config, TIP_FEATURE_ID, true);
  return commit(on, { enabled: true, recipients });
}

/**
 * Remove someone, keeping the total and re-dividing it among the rest.
 *
 * The chip on screen is the total, so it stays what it was; the person who is
 * left gets the whole of it. Removing the last person leaves tipping on with
 * nobody chosen, which sends nothing and says so.
 */
export function removeTipRecipient(config: SpdexConfig, address: string): TipEdit {
  const chosen = config.tips.recipients;
  const remaining = chosen.filter((recipient) => recipient.address.toLowerCase() !== address.toLowerCase());
  if (remaining.length === chosen.length) return { ok: true, config };
  const recipients = reshare(remaining, recipientsTotal(chosen));
  if (recipients === null) {
    // Only reachable with a hand-edited total smaller than the list; the
    // person asked for this one to go, so they go, and the others keep theirs.
    return commit(config, { ...config.tips, recipients: remaining });
  }
  return commit(config, { ...config.tips, recipients });
}

/**
 * Put back someone who was taken out, at their old place with their old
 * share (Undo, when the tips changed meanwhile). Refused, with the reason,
 * if that no longer fits: the list full, or the total over the ceiling.
 * Already chosen again: nothing changes.
 */
export function restoreTipRecipient(config: SpdexConfig, recipient: TipRecipient, index: number): TipEdit {
  const chosen = config.tips.recipients;
  if (chosen.some((r) => r.address.toLowerCase() === recipient.address.toLowerCase())) return { ok: true, config };
  const recipients = [...chosen];
  recipients.splice(Math.min(index, recipients.length), 0, recipient);
  return commit(config, { ...config.tips, recipients });
}

/**
 * Switch a chosen recipient to another address, keeping their share: a
 * retired listed entry to the entry that replaces it, once the person has
 * seen both addresses and said so. Never done on its own. If the new address
 * is already chosen, the old one simply goes and the total is kept.
 */
export function replaceTipRecipient(config: SpdexConfig, oldAddress: string, candidate: TipCandidate): TipEdit {
  const chosen = config.tips.recipients;
  const index = chosen.findIndex((recipient) => recipient.address.toLowerCase() === oldAddress.toLowerCase());
  if (index < 0) return { ok: true, config };
  const address = candidate.address.toLowerCase() as `0x${string}`;
  if (chosen.some((recipient) => recipient.address.toLowerCase() === address)) return removeTipRecipient(config, oldAddress);
  const replaced: TipRecipient = {
    address,
    label: candidate.label,
    ...(candidate.handle === undefined ? {} : { handle: candidate.handle }),
    source: candidate.registryId,
    bps: chosen[index]!.bps,
  };
  return commit(config, { ...config.tips, recipients: chosen.map((recipient, i) => (i === index ? replaced : recipient)) });
}

/**
 * Rewrite a chosen recipient's label as "My tip list" once it is saved there:
 * the config travels in settings files and links, and the person's own name
 * for someone stays in this browser.
 */
export function labelAsMine(config: SpdexConfig, address: string, label: string, source: string): SpdexConfig {
  const recipients = config.tips.recipients.map((recipient) => {
    if (recipient.address.toLowerCase() !== address.toLowerCase()) return recipient;
    const { handle: _handle, ...rest } = recipient;
    return { ...rest, label, source };
  });
  return { ...config, tips: { ...config.tips, recipients } };
}
