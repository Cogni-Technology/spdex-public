/**
 * Checks on tip addresses and tip lists that need a hash: EIP-55 checksums,
 * a shipped list's own rules, and a listed person's signed claim.
 *
 * Here rather than in `@spdex/core` because this package has viem; the host
 * (apps/web/src/lib/tiplist) and the list's own tests
 * (modules/tiplist-spx-community/test/unit) call the same functions, so the
 * rules a shipped list is held to and the rules the page applies cannot drift.
 *
 * Everything is offline: nothing here makes a request. A claim is verified by
 * recovering its signer, which is arithmetic, never a lookup.
 */

import { getAddress, recoverMessageAddress } from "viem";
import {
  hasHiddenCharacters,
  isPublicDevAccount,
  looksLikeAddress,
  PERMIT2_ADDRESS,
  tipClaimMessage,
  tipNameProblem,
  tipNameSkeleton,
  WireTipCandidateSchema,
  type Address,
  type WireTipCandidate,
} from "@spdex/core";
import { CONTRACTS, TOKENS, ZERO_ADDRESS } from "./constants.js";

/** 0x and 40 hex digits, any casing. */
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * `address` as EIP-55 writes it. Throws on anything that isn't 20 bytes of
 * hex. Internal: the app's one checksum for display is
 * apps/web/src/lib/culture/contract.ts, through @spdex/vault.
 */
function eip55(address: string): Address {
  if (!HEX_ADDRESS.test(address)) throw new Error(`not an address: ${address}`);
  return getAddress(address.toLowerCase()) as Address;
}

/**
 * Whether typed or pasted hex is an address, and if its casing is a checksum,
 * whether it matches. All-lowercase and all-uppercase carry no checksum and
 * pass; mixed case must be exactly EIP-55, because a single wrong character
 * in a pasted address is what a checksum exists to catch.
 */
export function addressInputProblem(input: string): "not-an-address" | "checksum" | null {
  const text = input.trim();
  if (!HEX_ADDRESS.test(text)) return "not-an-address";
  const hex = text.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return null;
  return getAddress(text.toLowerCase()) === text ? null : "checksum";
}

/** True when `address` is written exactly as EIP-55 checksums it. */
export function isChecksummed(address: string): boolean {
  return HEX_ADDRESS.test(address) && eip55(address) === address;
}

/** The first and last four hex digits, lowercase: what a glance at an address takes in. */
export function addressEnds(address: string): { first: string; last: string } {
  const hex = address.slice(2).toLowerCase();
  return { first: hex.slice(0, 4), last: hex.slice(-4) };
}

/** The burn address, where anything sent is gone. */
const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

/**
 * Addresses no list entry may be, lowercase → what to call each: the zero and
 * burn addresses, Permit2, the tokens and the contracts this package knows.
 * A tip sent to any of them is lost (or, for zero and burn, refused by
 * TipGuard for the whole plan). The web app knows a few more (the vault
 * factory, each venue's contracts) and a list's tests pass those as
 * `TipListRules.refuse`.
 */
function builtinRefusals(): Map<string, string> {
  const refused = new Map<string, string>([
    [ZERO_ADDRESS, "the zero address"],
    [BURN_ADDRESS, "a burn address"],
    [PERMIT2_ADDRESS, "Permit2"],
  ]);
  for (const token of Object.values(TOKENS)) refused.set(token.address.toLowerCase(), `the ${token.symbol} token contract`);
  for (const [name, address] of Object.entries(CONTRACTS)) {
    if (!refused.has(address.toLowerCase())) refused.set(address.toLowerCase(), `a contract (${name})`);
  }
  return refused;
}

export interface TipListRules {
  /**
   * Allow `PUBLIC_DEV_ACCOUNTS` in the list: only the dev-fixtures list,
   * which is loaded on a local test network and nowhere else.
   */
  allowDevAccounts?: boolean;
  /**
   * More addresses no entry may be, lowercase or not → what to call each:
   * the contracts the web app knows and this package doesn't (its
   * `KNOWN_CONTRACTS`).
   */
  refuse?: ReadonlyMap<string, string>;
  /**
   * The real list, `modules/tiplist-spx-community`: every entry also says
   * why it is listed (`note`) and links the person's own post (`proof`), and
   * none is marked `test`.
   */
  real?: boolean;
  /**
   * spDEX's own donation address (`SPDEX_DONATION_ADDRESS` in @spdex/core):
   * with `real`, the one entry that may go without a `proof`, because its
   * evidence is spDEX's own source, and it must say it is a "builder" entry.
   * Named by the caller, never by the list.
   */
  own?: string;
}

/**
 * Everything wrong with a shipped tip list, one sentence each; empty when it
 * may ship. The rules for `modules/tiplist-spx-community`, which its tests
 * run on every entry before a release. The page itself doesn't run them: it
 * refuses a list only for a repeated id (`hasDuplicateIds`), and checks each
 * address it would tip on its own (`tippableRecipients`, TipGuard).
 *
 * - every entry is what `WireTipCandidateSchema` accepts, with an `id`;
 * - every address is EIP-55 checksummed, and appears once;
 * - no two entries share their first four or last four hex digits, so no
 *   entry can pass at a glance for another, and no two current entries'
 *   names read the same (`tipNameSkeleton`: homoglyphs, case and spacing
 *   aside);
 * - none is a public development account (their keys are public), the zero
 *   or burn address, Permit2, a token contract or another contract a tip
 *   would be lost in (this package's and `rules.refuse`);
 * - ids are unique, retired entries included, and every `replacedBy` names
 *   another entry's id, on a retired entry;
 * - every `proof` is https (the schema's check), and with `rules.real`
 *   every entry has one, except spDEX's own (`rules.own`), whose evidence
 *   is spDEX's source and which must be a "builder" entry;
 * - names, handles and notes carry no hidden or reordering characters, and no
 *   name reads like an address;
 * - a `claim`'s message is the one `tipClaimMessage` builds for the entry.
 *   Whether its signature recovers the address is `tipClaimSigned`, which is
 *   async.
 */
export function tipListProblems(entries: readonly unknown[], rules: TipListRules = {}): string[] {
  const problems: string[] = [];
  const parsed: WireTipCandidate[] = [];
  entries.forEach((raw, index) => {
    const result = WireTipCandidateSchema.safeParse(raw);
    if (!result.success) {
      problems.push(`entry ${index}: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return;
    }
    parsed.push(result.data);
  });

  const ids = new Map<string, number>();
  const addresses = new Map<string, string>();
  const firsts = new Map<string, string>();
  const lasts = new Map<string, string>();
  const names = new Map<string, string>();
  const refused = builtinRefusals();
  for (const [address, name] of rules.refuse ?? []) refused.set(address.toLowerCase(), name);
  for (const entry of parsed) {
    const who = entry.id ?? entry.address;
    if (entry.id === undefined) problems.push(`${entry.address}: no id`);
    else ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1);

    if (!isChecksummed(entry.address)) problems.push(`${who}: the address is not EIP-55 checksummed`);
    const lower = entry.address.toLowerCase();
    if (addresses.has(lower)) problems.push(`${who}: the same address as ${addresses.get(lower)}`);
    addresses.set(lower, who);

    const { first, last } = addressEnds(entry.address);
    if (firsts.has(first)) problems.push(`${who}: starts like ${firsts.get(first)} (${first})`);
    if (lasts.has(last)) problems.push(`${who}: ends like ${lasts.get(last)} (${last})`);
    firsts.set(first, who);
    lasts.set(last, who);

    if (!rules.allowDevAccounts && isPublicDevAccount(entry.address)) {
      problems.push(`${who}: a public development account, whose key anyone has`);
    }
    const contract = refused.get(lower);
    if (contract !== undefined) problems.push(`${who}: ${contract}, where a tip would be lost`);

    // Among current entries only: a replacement usually keeps the name of
    // the entry it replaces, which is retired.
    const skeleton = entry.retired === undefined ? tipNameSkeleton(entry.label) : "";
    if (skeleton !== "" && names.has(skeleton)) problems.push(`${who}: the name reads like ${names.get(skeleton)}'s`);
    if (skeleton !== "") names.set(skeleton, who);

    for (const [field, text] of [
      ["label", entry.label],
      ["handle", entry.handle],
      ["note", entry.note],
      ["ens", entry.ens],
      ["retired reason", entry.retired],
    ] as const) {
      if (text !== undefined && hasHiddenCharacters(text)) problems.push(`${who}: the ${field} has hidden characters`);
    }
    const nameProblem = tipNameProblem(entry.label);
    if (nameProblem !== null) problems.push(`${who}: label: ${nameProblem}`);
    if (entry.handle !== undefined && looksLikeAddress(entry.handle)) {
      problems.push(`${who}: the handle looks like an address`);
    }

    if (rules.real) {
      const own = rules.own !== undefined && lower === rules.own.toLowerCase();
      if (entry.note === undefined || entry.note.trim() === "") problems.push(`${who}: no note saying why it is listed`);
      if (entry.proof === undefined && !own) problems.push(`${who}: no proof link to the person's own post`);
      if (own && entry.kind !== "builder") problems.push(`${who}: spDEX's own entry must be kind "builder"`);
      if (entry.test === true) problems.push(`${who}: a test entry in the real list`);
    }

    if (entry.replacedBy !== undefined && entry.retired === undefined) {
      problems.push(`${who}: replacedBy on an entry that is not retired`);
    }
    if (entry.claim !== undefined) {
      if (entry.handle === undefined) problems.push(`${who}: a claim needs a handle`);
      else if (!claimMessageFits(entry)) problems.push(`${who}: the claim's message is not the one for this entry`);
    }
  }
  for (const [id, count] of ids) if (count > 1) problems.push(`${id}: the id is used ${count} times`);
  for (const entry of parsed) {
    if (entry.replacedBy !== undefined && !ids.has(entry.replacedBy)) {
      problems.push(`${entry.id ?? entry.address}: replacedBy names no entry (${entry.replacedBy})`);
    }
    if (entry.replacedBy !== undefined && entry.replacedBy === entry.id) {
      problems.push(`${entry.id}: replaced by itself`);
    }
  }
  return problems;
}

/**
 * What's wrong with a list against the ids it already shipped with
 * (`shipped`: id → address, append-only, committed beside the list): an
 * entry whose id isn't recorded yet, or whose address is not the one its id
 * shipped with. An id is a promise about one address: a person who already
 * picked it has that address in their settings, so a new address needs a new
 * id (and the old entry `retired` with `replacedBy`), never an edit in place.
 */
export function shippedIdProblems(entries: readonly Pick<WireTipCandidate, "id" | "address">[], shipped: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.id === undefined) continue;
    const before = shipped[entry.id];
    if (before === undefined) problems.push(`${entry.id}: not recorded in shipped-ids.json yet`);
    else if (before.toLowerCase() !== entry.address.toLowerCase()) {
      problems.push(`${entry.id}: shipped with ${before}, now ${entry.address}; a new address needs a new id`);
    }
  }
  return problems;
}

/** True when a list names one id twice: the host refuses such a list whole. */
export function hasDuplicateIds(entries: readonly Pick<WireTipCandidate, "id">[]): boolean {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.id === undefined) continue;
    if (seen.has(entry.id)) return true;
    seen.add(entry.id);
  }
  return false;
}

/** The claim's message is `tipClaimMessage` for this entry's address and handle, in some month. */
function claimMessageFits(entry: WireTipCandidate): boolean {
  const claim = entry.claim;
  if (claim === undefined || entry.handle === undefined) return false;
  const month = /, (\d{4}-(0[1-9]|1[0-2]))$/.exec(claim.message)?.[1];
  if (month === undefined) return false;
  return claim.message === tipClaimMessage(eip55(entry.address), entry.handle, month);
}

/**
 * True only when the entry's `claim` is the claim message for its own
 * address and handle, and its signature recovers exactly that address
 * (EIP-191). Offline: recovering a signer is arithmetic. Anything else —
 * no claim, a different message, a signature that doesn't parse or recovers
 * someone else — is false, and the page says "proof link only".
 */
export async function tipClaimSigned(entry: WireTipCandidate): Promise<boolean> {
  if (!claimMessageFits(entry)) return false;
  try {
    const signer = await recoverMessageAddress({
      message: entry.claim!.message,
      signature: entry.claim!.signature as `0x${string}`,
    });
    return signer.toLowerCase() === entry.address.toLowerCase();
  } catch {
    return false;
  }
}
