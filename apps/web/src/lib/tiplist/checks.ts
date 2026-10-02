/**
 * Who gets paid, and what the page says about an address before anyone does.
 *
 * ## One function decides who is tipped
 *
 * `tippableRecipients` is the only source of who a swap tips. The transfers
 * (lib/tips.ts), the delivery and prompt counts (lib/tipRow.ts), the summary
 * card and the Tip row all take its `pay`, never `config.tips.recipients`,
 * so a recipient it skips gets no transfer and no counted step. A skipped
 * share is not sent and not spread over the others: the total goes down.
 *
 * ## Tags come from the address, never from the config
 *
 * LISTED, MINE, UNLISTED or RETIRED is worked out by matching the address
 * against the shipped list and this browser's "My tip list". A config's own
 * `label`, `handle` and `source` are shown only on an UNLISTED recipient, as
 * what the loaded settings called it: a settings link that writes
 * `source: "tiplist-spx-community"` next to its own address is still UNLISTED,
 * and still needs the person to confirm it. (One exception to quoting the
 * config: a recipient it says came from "My tip list", which the list no
 * longer has, reads "Not in My tip list", never the placeholder label.)
 *
 * A retired listed entry is RETIRED, and skipped, even when the address is
 * also in "My tip list" with a confirmed first tip: only the person choosing
 * "Keep tipping" after seeing that retirement (`keptRetired`), and then
 * confirming, pays it again.
 *
 * ## Checks on a new address
 *
 * Refused outright: the zero and burn addresses, the person's own account,
 * public development accounts off a test network, and every contract in
 * `KNOWN_CONTRACTS` (tokens sent to a token contract are lost). Warned, each
 * needing "Add anyway": a lookalike (same first or last four hex digits as a
 * listed, saved or chosen address, and not the same address — the shape of
 * address poisoning), a name that reads like a listed one with another
 * address (homoglyphs included), a name that mixes alphabets, code at the
 * address, and a duplicate of a listed entry.
 *
 * Pure: no storage, no network. The code at an address is read by the caller
 * through the person's own service and handed in.
 */

import {
  cleanTipText,
  isPlaceholderChain,
  isPublicDevAccount,
  mixesAlphabets,
  tipNameSkeleton,
  type Address,
  type TipPolicy,
  type TipRecipient,
} from "@spdex/core";
import { addressEnds } from "@spdex/chain";
import type { DiscoveredRecipient } from "../engine.js";
import { checksumAddress } from "../culture/contract.js";
import { knownContract } from "./contracts.js";
import type { MineEntry, TipListState } from "./store.js";

export type TipTag = "LISTED" | "MINE" | "UNLISTED" | "RETIRED";

/** A MINE recipient's `source` in the config. */
export const MY_TIP_LIST_SOURCE = "my-tip-list";
/** A MINE recipient's `label` in the config: never the private name, which stays in this browser. */
export const MY_TIP_LIST_LABEL = "My tip list";
/** The name an UNLISTED recipient gets in "My tip list" when the person confirms it. */
export const FROM_LOADED_SETTINGS = "From loaded settings";
/** What a recipient chosen from "My tip list" reads once the list no longer has it. */
export const NOT_IN_MY_TIP_LIST = "Not in My tip list";
/** The name such a recipient gets in "My tip list" when the person confirms it again. */
export const CHOSEN_IN_TIP_ROW = "Chosen in the Tip row";
/** Names spDEX gives, not the person: two entries sharing one is not an imitation. */
const GIVEN_NAMES: ReadonlySet<string> = new Set([FROM_LOADED_SETTINGS, NOT_IN_MY_TIP_LIST, CHOSEN_IN_TIP_ROW, MY_TIP_LIST_LABEL]);

const lower = (address: string) => address.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

/** What the page knows about one address. */
export interface RecipientView {
  /** EIP-55. */
  address: Address;
  tag: TipTag;
  /** The name to show: the listed label, the private name, or what loaded settings called it. */
  name: string;
  handle?: string | undefined;
  ens?: string | undefined;
  /** The shipped entry at this address, retired or not. */
  listed?: DiscoveredRecipient | undefined;
  /** The "My tip list" entry at this address. */
  mine?: MineEntry | undefined;
  /** UNLISTED only: the config said so, nothing else did. */
  fromSettings?: boolean;
  /** UNLISTED only: the config says it was chosen from "My tip list", which no longer has it. */
  notSaved?: boolean;
}

/** A retired entry's reason as "My tip list" keeps it in `keptRetired`. */
export function retiredReason(entry: Pick<DiscoveredRecipient, "retired">): string {
  return cleanTipText(entry.retired ?? "").slice(0, 120);
}

/** The name confirming a recipient saves in "My tip list", when it isn't saved there yet. */
export function confirmedName(view: RecipientView): string {
  if (view.notSaved) return CHOSEN_IN_TIP_ROW;
  if (view.tag === "UNLISTED") return FROM_LOADED_SETTINGS;
  return view.name;
}

/** The shipped entry at `address`, retired or not. */
export function listedEntry(address: string, defaults: readonly DiscoveredRecipient[] | null): DiscoveredRecipient | undefined {
  return (defaults ?? []).find((entry) => same(entry.address, address));
}

/** The "My tip list" entry at `address`. */
export function mineEntry(address: string, list: TipListState): MineEntry | undefined {
  return list.mine.find((entry) => same(entry.address, address));
}

/**
 * The tag and name for `address`, from the shipped list and "My tip list"
 * only. A listed entry that is current is LISTED even if also saved. A
 * retired one is RETIRED, saved or not, until the person keeps it after
 * seeing this retirement (`keptRetired` equal to its reason): then MINE.
 * `loaded` is what the config calls it, used only when nothing else names it.
 */
export function describeRecipient(
  address: string,
  list: TipListState,
  defaults: readonly DiscoveredRecipient[] | null,
  loaded?: Pick<TipRecipient, "label" | "handle" | "source">,
): RecipientView {
  const checksummed = checksumAddress(address);
  const listed = listedEntry(address, defaults);
  const mine = mineEntry(address, list);
  if (listed !== undefined && listed.retired === undefined) {
    return { address: checksummed, tag: "LISTED", name: cleanTipText(listed.label), handle: listed.handle, ens: listed.ens, listed, mine };
  }
  if (listed !== undefined && (mine === undefined || mine.keptRetired !== retiredReason(listed))) {
    return { address: checksummed, tag: "RETIRED", name: cleanTipText(listed.label), handle: listed.handle, ens: listed.ens, listed, mine };
  }
  if (mine !== undefined) {
    return { address: checksummed, tag: "MINE", name: mine.name, ens: mine.ens, listed, mine };
  }
  if (loaded?.source === MY_TIP_LIST_SOURCE) {
    // Chosen from "My tip list" and since removed from it (here or in
    // another tab): the config's label is only the placeholder, so it is
    // not quoted as a name, and nothing claims settings were loaded.
    return { address: checksummed, tag: "UNLISTED", name: NOT_IN_MY_TIP_LIST, notSaved: true };
  }
  return {
    address: checksummed,
    tag: "UNLISTED",
    name: cleanTipText(loaded?.label ?? "") || "Unnamed",
    handle: loaded?.handle === undefined ? undefined : cleanTipText(loaded.handle) || undefined,
    fromSettings: true,
  };
}

/** A chosen recipient that won't be tipped, and why, in words for the pill. */
export interface Skipped {
  address: Address;
  reason: string;
}

export interface Tippable {
  /** Who is tipped, with the shares they were given: the only list transfers are built from. */
  pay: TipRecipient[];
  skipped: Skipped[];
}

/** The reason a pill gives for an unconfirmed recipient. */
export const NOT_CONFIRMED = "not confirmed";
export const PUBLIC_TEST_ACCOUNT = "public test account";
export const OWN_ACCOUNT = "your own account";

/**
 * Who is tipped, and who is skipped and why.
 *
 * Skipped: a recipient that is not LISTED and has no `confirmed` stamp in
 * "My tip list" (`not confirmed`); one whose listed entry is retired and that
 * the person hasn't kept since (`retired: …`), whatever older stamp it has;
 * a public development account off a test network (`public test account`);
 * a contract nobody means to tip (`… — tokens sent there are lost`); and the
 * connected account (`your own account`), which TipGuard would refuse for
 * the whole tip, the others' included. Nothing is tipped while tips are
 * off. A skipped share is not handed to anyone else.
 *
 * `defaults` null means the shipped list hasn't been read yet: nobody counts
 * as LISTED until it has, so nothing is paid on a guess.
 */
export function tippableRecipients(
  tips: TipPolicy,
  list: TipListState,
  defaults: readonly DiscoveredRecipient[] | null,
  chainId: number,
  account: string | null = null,
): Tippable {
  const pay: TipRecipient[] = [];
  const skipped: Skipped[] = [];
  for (const recipient of tips.recipients) {
    const address = checksumAddress(recipient.address);
    const skip = (reason: string) => skipped.push({ address, reason });
    if (isPublicDevAccount(recipient.address) && !isPlaceholderChain(chainId)) {
      skip(PUBLIC_TEST_ACCOUNT);
      continue;
    }
    const contract = knownContract(recipient.address);
    if (contract !== null) {
      skip(`${contract} — tokens sent there are lost`);
      continue;
    }
    if (account !== null && same(recipient.address, account)) {
      skip(OWN_ACCOUNT);
      continue;
    }
    const view = describeRecipient(recipient.address, list, defaults);
    if (view.tag === "LISTED") pay.push(recipient);
    else if (view.tag === "RETIRED") skip(`retired: ${retiredReason(view.listed ?? {})}`);
    else if (view.mine?.confirmed !== undefined) pay.push(recipient);
    else skip(NOT_CONFIRMED);
  }
  return { pay: tips.enabled ? pay : [], skipped };
}

/** The policy the swap actually pays: the chosen shares of whoever `tippableRecipients` let through. */
export function payablePolicy(tips: TipPolicy, tippable: Tippable): TipPolicy {
  return { enabled: tips.enabled, recipients: tippable.pay };
}

/** The first chosen recipient waiting on the person's confirmation, if any. */
export function awaitingConfirmation(tips: TipPolicy, tippable: Tippable): Skipped | null {
  if (!tips.enabled) return null;
  return tippable.skipped.find((skip) => skip.reason === NOT_CONFIRMED) ?? null;
}

// ── Checks on a new address ─────────────────────────────────────────────────

/** What refusing or warning about an address compares it with. */
export interface AddressContext {
  chainId: number;
  /** The connected account, which can't be tipped. */
  account: string | null;
  defaults: readonly DiscoveredRecipient[] | null;
  list: TipListState;
  /** The recipients in the config. */
  chosen: readonly TipRecipient[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = "0x000000000000000000000000000000000000dead";

/** Why `address` can't be added at all, or null. */
export function refusalFor(address: string, context: Pick<AddressContext, "chainId" | "account">): string | null {
  if (same(address, ZERO)) return "That's the zero address — tokens sent there are lost.";
  if (same(address, BURN)) return "That's a burn address — tokens sent there are lost.";
  if (context.account !== null && same(address, context.account)) return "That's your own account.";
  if (isPublicDevAccount(address) && !isPlaceholderChain(context.chainId)) {
    return "That's a public test account: anyone has its key, and bots take what arrives.";
  }
  const contract = knownContract(address);
  if (contract !== null) return `That's ${contract} — tokens sent there are lost.`;
  return null;
}

export interface Lookalike {
  /** Which ends match: the first four hex digits, the last four, or both. */
  match: "first" | "last" | "both";
  name: string;
  address: Address;
}

/** Everyone an address might be confused with: listed, saved and chosen. */
function known(context: AddressContext): { address: string; name: string }[] {
  const all: { address: string; name: string }[] = [];
  for (const entry of context.defaults ?? []) all.push({ address: entry.address, name: cleanTipText(entry.label) });
  for (const entry of context.list.mine) all.push({ address: entry.address, name: entry.name });
  for (const recipient of context.chosen) {
    const view = describeRecipient(recipient.address, context.list, context.defaults, recipient);
    all.push({ address: recipient.address, name: view.name });
  }
  return all;
}

/**
 * The strongest lookalike of `address` among everyone known: the same first
 * or last four hex digits, a different address. Both ends matching is what
 * address poisoning manufactures, and is shown as a danger.
 */
export function lookalikeOf(address: string, context: AddressContext): Lookalike | null {
  const ends = addressEnds(address);
  let best: Lookalike | null = null;
  for (const other of known(context)) {
    if (same(other.address, address)) continue;
    const theirs = addressEnds(other.address);
    const first = theirs.first === ends.first;
    const last = theirs.last === ends.last;
    if (!first && !last) continue;
    const match = first && last ? "both" : first ? "first" : "last";
    if (best === null || (match === "both" && best.match !== "both")) {
      best = { match, name: other.name, address: checksumAddress(other.address) };
    }
  }
  return best;
}

/**
 * What the code at an address says about it: nothing, an EIP-7702
 * delegation, a contract, unread, or read differently by the person's two
 * services (`disputed`).
 */
export type CodeKind = "none" | "delegated" | "contract" | "unknown" | "disputed";

/** Read an `eth_getCode` answer. Anything that isn't hex is unknown, never "none". */
export function codeKind(code: unknown): CodeKind {
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code)) return "unknown";
  if (code === "0x") return "none";
  if (code.toLowerCase().startsWith("0xef0100")) return "delegated";
  return "contract";
}

export interface AddWarning {
  kind: "lookalike" | "same-name" | "mixed-alphabets" | "code" | "duplicate" | "unread-code" | "unchecked";
  tone: "warn" | "danger";
  /** A few words, for a banner's title. */
  title: string;
  /** The sentence. */
  text: string;
  /** A lookalike's own address, shown under this one to compare. */
  other?: { name: string; address: Address };
}

/** Someone known by the same name (homoglyphs, case and spacing aside) at another address. */
export interface Namesake {
  name: string;
  address: Address;
  where: "listed" | "saved";
}

/**
 * A listed entry, else a saved one, whose name reads the same as `name` but
 * whose address isn't `address`: how an imitation presents itself. Names
 * spDEX gives ("From loaded settings") don't count.
 */
export function namesakeOf(
  address: string,
  name: string,
  context: Pick<AddressContext, "defaults" | "list">,
): Namesake | null {
  const skeleton = tipNameSkeleton(name);
  if (skeleton.length === 0 || GIVEN_NAMES.has(cleanTipText(name))) return null;
  const listed = (context.defaults ?? []).find(
    (entry) => tipNameSkeleton(entry.label) === skeleton && !same(entry.address, address),
  );
  if (listed !== undefined) return { name: cleanTipText(listed.label), address: checksumAddress(listed.address), where: "listed" };
  const saved = context.list.mine.find(
    (entry) => !GIVEN_NAMES.has(entry.name) && tipNameSkeleton(entry.name) === skeleton && !same(entry.address, address),
  );
  if (saved !== undefined) return { name: saved.name, address: saved.address, where: "saved" };
  return null;
}

/**
 * What a name says about who it may be imitating: a listed or saved name at
 * another address (a danger), and a name that mixes alphabets. Asked of a
 * typed name before it is saved, and again of every name a settings link or
 * a file brought, before the first tip to it.
 */
export function nameWarnings(address: string, name: string, context: Pick<AddressContext, "defaults" | "list">): AddWarning[] {
  const warnings: AddWarning[] = [];
  const namesake = namesakeOf(address, name, context);
  if (namesake !== null) {
    warnings.push({
      kind: "same-name",
      tone: "danger",
      title: "Same name, other address",
      text:
        namesake.where === "listed"
          ? `${namesake.name} is listed with a different address.`
          : `${namesake.name} is in My tip list with a different address.`,
      other: { name: namesake.name, address: namesake.address },
    });
  }
  if (mixesAlphabets(name)) {
    warnings.push({
      kind: "mixed-alphabets",
      tone: "warn",
      title: "Mixed alphabets",
      text: "The name mixes alphabets, as names that imitate others do.",
    });
  }
  return warnings;
}

/** A lookalike as a warning: a danger when both ends match. */
export function lookalikeWarning(lookalike: Lookalike): AddWarning {
  const other = { name: lookalike.name, address: lookalike.address };
  return lookalike.match === "both"
    ? {
        kind: "lookalike",
        tone: "danger",
        title: "Lookalike address",
        text: `Looks like ${lookalike.name}'s address but isn't. Address-poisoning scams do this.`,
        other,
      }
    : {
        kind: "lookalike",
        tone: "warn",
        title: "Similar address",
        text: `${lookalike.match === "first" ? "Starts" : "Ends"} like ${lookalike.name}'s address, which is a different one.`,
        other,
      };
}

/** What the page says while the shipped list hasn't been read: unknown, never "none". */
export const LISTED_NOT_CHECKED = "Not compared with the listed entries yet: the first tip checks again.";

/**
 * Everything to say before an address is added, each needing "Add anyway".
 * `name` is the name the person typed; `code` what the service said is at
 * the address (null while not read). Before the shipped list is read, that
 * is said too: its checks haven't run, which is not the same as passing.
 */
export function addWarnings(address: string, name: string, code: CodeKind | null, context: AddressContext): AddWarning[] {
  const warnings: AddWarning[] = [];
  if (context.defaults === null) {
    warnings.push({ kind: "unchecked", tone: "warn", title: "List not read yet", text: LISTED_NOT_CHECKED });
  }
  const duplicate = listedEntry(address, context.defaults);
  if (duplicate !== undefined && duplicate.retired === undefined) {
    warnings.push({ kind: "duplicate", tone: "warn", title: "Already listed", text: `Already listed as ${cleanTipText(duplicate.label)}.` });
  }
  const lookalike = lookalikeOf(address, context);
  if (lookalike !== null) warnings.push(lookalikeWarning(lookalike));
  warnings.push(...nameWarnings(address, name, context));
  if (code === "delegated") {
    warnings.push({
      kind: "code",
      tone: "warn",
      title: "Delegated account",
      text: "An EIP-7702 delegated account: its code decides what happens to a tip.",
    });
  } else if (code === "contract") {
    warnings.push({ kind: "code", tone: "warn", title: "Contract address", text: "A contract (maybe a multisig). Make sure it can hold tokens." });
  } else if (code === "unknown") {
    warnings.push({ kind: "unread-code", tone: "warn", title: "Code not read", text: "Couldn't read whether this is a contract." });
  } else if (code === "disputed") {
    warnings.push({
      kind: "unread-code",
      tone: "danger",
      title: "Services disagree",
      text: "Your main network service and your second opinion disagree about the code at this address.",
    });
  }
  return warnings;
}

/** An imported entry that wasn't added, and why. */
export interface ImportSkip {
  name: string;
  address: Address;
  reason: string;
}

/**
 * Merge entries read from a file into the list: each is refused as a typed
 * address would be, one already saved is left as it is, and one that looks
 * like someone else's at both ends, or carries a listed or saved name at
 * another address, is left out (a file can't answer "Add anyway").
 * Everything added arrives unconfirmed: the first tip to it asks, and checks
 * again. Checked one by one against the list as it grows, so a file can't
 * smuggle in two addresses that imitate each other.
 */
export function mergeImported(
  state: TipListState,
  entries: readonly MineEntry[],
  context: Omit<AddressContext, "list">,
  limit: number,
): { state: TipListState; added: MineEntry[]; skipped: ImportSkip[] } {
  let next = state;
  const added: MineEntry[] = [];
  const skipped: ImportSkip[] = [];
  for (const entry of entries) {
    const skip = (reason: string) => skipped.push({ name: entry.name, address: entry.address, reason });
    const refusal = refusalFor(entry.address, context);
    if (refusal !== null) {
      skip(refusal);
      continue;
    }
    const saved = mineEntry(entry.address, next);
    if (saved !== undefined) {
      skip(`already saved as ${saved.name}`);
      continue;
    }
    const lookalike = lookalikeOf(entry.address, { ...context, list: next });
    if (lookalike !== null && lookalike.match === "both") {
      skip(`looks like ${lookalike.name}'s address but isn't`);
      continue;
    }
    const namesake = namesakeOf(entry.address, entry.name, { defaults: context.defaults, list: next });
    if (namesake !== null) {
      skip(`${namesake.where === "listed" ? "a listed" : "a saved"} name at another address`);
      continue;
    }
    if (next.mine.length >= limit) {
      skip("your list is full");
      continue;
    }
    const { confirmed: _confirmed, keptRetired: _kept, ens: _ens, ...rest } = entry;
    const unconfirmed: MineEntry = { ...rest, imported: true };
    next = { ...next, mine: [...next.mine, unconfirmed] };
    added.push(unconfirmed);
  }
  return { state: next, added, skipped };
}
