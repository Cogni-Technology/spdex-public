/**
 * Who gets paid, and what the page says about an address before anyone is.
 *
 * `tippableRecipients` is the only source of who a swap tips, so its cases
 * are the ones that move money: a skipped share is not sent and not given to
 * anyone else; a tag comes from the address, never from what a config calls
 * itself. Every address here is made up, or a public development account, or
 * a contract spDEX already names.
 */

import { describe, expect, it } from "vitest";
import { PERMIT2_ADDRESS, type TipPolicy, type TipRecipient } from "@spdex/core";
import { MAINNET_FACTORY } from "@spdex/vault";
import type { DiscoveredRecipient } from "../engine.js";
import { checksumAddress } from "../culture/contract.js";
import {
  addWarnings,
  awaitingConfirmation,
  codeKind,
  describeRecipient,
  confirmedName,
  lookalikeOf,
  mergeImported,
  nameWarnings,
  NOT_CONFIRMED,
  NOT_IN_MY_TIP_LIST,
  OWN_ACCOUNT,
  payablePolicy,
  PUBLIC_TEST_ACCOUNT,
  refusalFor,
  tippableRecipients,
  type AddressContext,
} from "./checks.js";
import { EMPTY_TIPLIST, type MineEntry, type TipListState } from "./store.js";

const fake = (first: string, last: string) => checksumAddress(`0x${first}${"abcdef".repeat(5)}ab${last}`);
const ARTIST = fake("a1b2", "c3d4");
const CAUSE = fake("b1b2", "d3d4");
const MARIA = fake("c1c2", "e3e4");
const STRANGER = fake("d1d2", "f3f4");
const DEV_1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";

const listed = (address: string, label: string, extra: Partial<DiscoveredRecipient> = {}): DiscoveredRecipient => ({
  address,
  label,
  registryId: "tiplist-spx-community",
  ...extra,
});
const DEFAULTS: DiscoveredRecipient[] = [
  listed(ARTIST, "Example Artist", { id: "example-artist", handle: "@example_artist" }),
  listed(CAUSE, "Example Cause", { id: "example-cause", retired: "Moved to a new address", replacedBy: "example-artist" }),
];
const mine = (address: string, name: string, extra: Partial<MineEntry> = {}): MineEntry => ({
  address: address as `0x${string}`,
  name,
  added: 1,
  ...extra,
});
const withMine = (...entries: MineEntry[]): TipListState => ({ ...EMPTY_TIPLIST, mine: entries });
const chosen = (address: string, bps: number, label = "from settings", source?: string): TipRecipient => ({
  address: address.toLowerCase() as `0x${string}`,
  label,
  bps,
  ...(source === undefined ? {} : { source }),
});
const policy = (...recipients: TipRecipient[]): TipPolicy => ({ enabled: true, recipients });

describe("describeRecipient: the tag comes from the address", () => {
  it("names a current listed entry LISTED, even when also saved", () => {
    expect(describeRecipient(ARTIST.toLowerCase(), withMine(mine(ARTIST, "My name")), DEFAULTS)).toMatchObject({
      tag: "LISTED",
      name: "Example Artist",
      handle: "@example_artist",
      address: ARTIST,
    });
  });

  it("names a saved address MINE with the person's own name", () => {
    expect(describeRecipient(MARIA, withMine(mine(MARIA, "Maria", { ens: "maria.eth" })), DEFAULTS)).toMatchObject({
      tag: "MINE",
      name: "Maria",
      ens: "maria.eth",
    });
  });

  it("names a retired entry RETIRED, saved or not, and MINE once the person kept it after this retirement", () => {
    expect(describeRecipient(CAUSE, EMPTY_TIPLIST, DEFAULTS).tag).toBe("RETIRED");
    // Saved (and confirmed) before the retirement: still RETIRED, so the reason is shown.
    expect(describeRecipient(CAUSE, withMine(mine(CAUSE, "Example Cause", { confirmed: 9 })), DEFAULTS).tag).toBe("RETIRED");
    // Kept through another reason: this one hasn't been seen.
    expect(describeRecipient(CAUSE, withMine(mine(CAUSE, "Example Cause", { keptRetired: "Old reason" })), DEFAULTS).tag).toBe("RETIRED");
    expect(describeRecipient(CAUSE, withMine(mine(CAUSE, "Example Cause", { keptRetired: "Moved to a new address" })), DEFAULTS).tag).toBe("MINE");
  });

  it("says a recipient chosen from My tip list is no longer in it, without quoting the placeholder label", () => {
    const removed = chosen(MARIA, 25, "My tip list", "my-tip-list");
    const view = describeRecipient(removed.address, EMPTY_TIPLIST, DEFAULTS, removed);
    expect(view).toMatchObject({ tag: "UNLISTED", name: NOT_IN_MY_TIP_LIST, notSaved: true });
    expect(view.fromSettings).toBeUndefined();
    expect(confirmedName(view)).toBe("Chosen in the Tip row");
    const linked = chosen(STRANGER, 25, "Someone");
    expect(confirmedName(describeRecipient(linked.address, EMPTY_TIPLIST, DEFAULTS, linked))).toBe("From loaded settings");
  });

  it("shows a config's own name only on an UNLISTED address, and ignores what source it claims", () => {
    // A settings link that labels its own address as the shipped list's.
    const forged = chosen(STRANGER, 25, "Example Artist", "tiplist-spx-community");
    expect(describeRecipient(forged.address, EMPTY_TIPLIST, DEFAULTS, forged)).toMatchObject({
      tag: "UNLISTED",
      name: "Example Artist",
      fromSettings: true,
    });
  });
});

describe("tippableRecipients: who is actually tipped", () => {
  it("pays listed and confirmed saved recipients, with the shares they were given", () => {
    const tips = policy(chosen(ARTIST, 13), chosen(MARIA, 12));
    const result = tippableRecipients(tips, withMine(mine(MARIA, "Maria", { confirmed: 5 })), DEFAULTS, 1);
    expect(result.pay.map((r) => [r.address, r.bps])).toEqual([
      [ARTIST.toLowerCase(), 13],
      [MARIA.toLowerCase(), 12],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("skips an address not confirmed yet, and never hands its share to the others", () => {
    const tips = policy(chosen(ARTIST, 13), chosen(MARIA, 12), chosen(STRANGER, 12));
    const result = tippableRecipients(tips, withMine(mine(MARIA, "Maria")), DEFAULTS, 1);
    expect(result.pay).toEqual([chosen(ARTIST, 13)]);
    expect(result.skipped).toEqual([
      { address: MARIA, reason: NOT_CONFIRMED },
      { address: STRANGER, reason: NOT_CONFIRMED },
    ]);
    // 13 bps are paid, not 37: the skipped 24 stay with the person.
    expect(payablePolicy(tips, result).recipients.reduce((sum, r) => sum + r.bps, 0)).toBe(13);
    expect(awaitingConfirmation(tips, result)).toEqual({ address: MARIA, reason: NOT_CONFIRMED });
  });

  it("skips a retired entry with its reason until the person keeps it and confirms again", () => {
    const tips = policy(chosen(CAUSE, 25));
    const retired = { address: CAUSE, reason: "retired: Moved to a new address" };
    expect(tippableRecipients(tips, EMPTY_TIPLIST, DEFAULTS, 1).skipped).toEqual([retired]);
    // Kept, not confirmed yet: the first-tip check asks.
    const kept = withMine(mine(CAUSE, "Example Cause", { keptRetired: "Moved to a new address" }));
    expect(tippableRecipients(tips, kept, DEFAULTS, 1).skipped).toEqual([{ address: CAUSE, reason: NOT_CONFIRMED }]);
    const confirmed = withMine(mine(CAUSE, "Example Cause", { keptRetired: "Moved to a new address", confirmed: 9 }));
    expect(tippableRecipients(tips, confirmed, DEFAULTS, 1).pay).toHaveLength(1);
  });

  it("never lets a stamp from before the retirement keep a retired entry paid", () => {
    // Saved and tipped before it was listed, or stamped by the migration:
    // then listed, then retired ("key compromised"). Skipped, with the reason.
    const tips = policy(chosen(CAUSE, 25));
    const earlier = withMine(mine(CAUSE, "Maria", { confirmed: 5 }));
    const result = tippableRecipients(tips, earlier, DEFAULTS, 1);
    expect(result.pay).toEqual([]);
    expect(result.skipped).toEqual([{ address: CAUSE, reason: "retired: Moved to a new address" }]);
  });

  it("skips the connected account, so the others are still tipped", () => {
    const tips = policy(chosen(ARTIST, 13), chosen(MARIA, 12));
    const result = tippableRecipients(tips, withMine(mine(MARIA, "Me", { confirmed: 1 })), DEFAULTS, 1, MARIA.toLowerCase());
    expect(result.pay).toEqual([chosen(ARTIST, 13)]);
    expect(result.skipped).toEqual([{ address: MARIA, reason: OWN_ACCOUNT }]);
  });

  it("skips a public test account on Ethereum, and lets the fork's test list tip it", () => {
    const tips = policy(chosen(DEV_1, 25));
    expect(tippableRecipients(tips, EMPTY_TIPLIST, [], 1).skipped).toEqual([
      { address: checksumAddress(DEV_1), reason: PUBLIC_TEST_ACCOUNT },
    ]);
    // Even saved and confirmed: the key is public.
    expect(tippableRecipients(tips, withMine(mine(DEV_1, "Dev", { confirmed: 1 })), [], 1).pay).toEqual([]);
    const fixtures = [listed(DEV_1, "Placeholder: dev fund", { registryId: "tiplist-dev-fixtures", test: true })];
    expect(tippableRecipients(tips, EMPTY_TIPLIST, fixtures, 690069).pay).toHaveLength(1);
  });

  it("skips a contract a token is lost in, whatever list or file named it", () => {
    const tips = policy(chosen(SPX, 25));
    const result = tippableRecipients(tips, withMine(mine(SPX, "SPX", { confirmed: 1 })), [listed(SPX, "SPX")], 1);
    expect(result.pay).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/SPX token contract — tokens sent there are lost/);
  });

  it("counts nobody as listed until the shipped list has been read", () => {
    expect(tippableRecipients(policy(chosen(ARTIST, 25)), EMPTY_TIPLIST, null, 1).skipped).toEqual([
      { address: ARTIST, reason: NOT_CONFIRMED },
    ]);
  });

  it("pays nobody while tips are off, and still says who would be skipped", () => {
    const off = { enabled: false, recipients: [chosen(ARTIST, 25), chosen(STRANGER, 25)] };
    const result = tippableRecipients(off, EMPTY_TIPLIST, DEFAULTS, 1);
    expect(result.pay).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(awaitingConfirmation(off, result)).toBeNull();
  });
});

describe("refusalFor", () => {
  const on = (chainId: number) => ({ chainId, account: MARIA as string | null });
  it("refuses addresses a token is lost at, the person's own, and public test accounts on Ethereum", () => {
    expect(refusalFor("0x0000000000000000000000000000000000000000", on(1))).toMatch(/zero address/);
    expect(refusalFor("0x000000000000000000000000000000000000dEaD", on(1))).toMatch(/burn address/);
    expect(refusalFor(MARIA.toLowerCase(), on(1))).toBe("That's your own account.");
    expect(refusalFor(DEV_1, on(1))).toMatch(/public test account/);
    expect(refusalFor(DEV_1, on(690069))).toBeNull();
    expect(refusalFor(SPX, on(1))).toBe("That's the SPX token contract — tokens sent there are lost.");
    expect(refusalFor(PERMIT2_ADDRESS, on(1))).toMatch(/^That's Permit2/);
    expect(refusalFor(MAINNET_FACTORY, on(1))).toMatch(/vault factory/);
    expect(refusalFor("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", on(1))).toMatch(/Uniswap router/);
    expect(refusalFor(STRANGER, on(1))).toBeNull();
  });
});

describe("lookalikes and warnings", () => {
  const context = (list: TipListState = EMPTY_TIPLIST, picked: TipRecipient[] = []): AddressContext => ({
    chainId: 1,
    account: null,
    defaults: DEFAULTS,
    list,
    chosen: picked,
  });

  it("finds an address that starts or ends like a listed, saved or chosen one", () => {
    expect(lookalikeOf(fake("a1b2", "9999"), context())).toMatchObject({ match: "first", name: "Example Artist" });
    expect(lookalikeOf(fake("9999", "e3e4"), context(withMine(mine(MARIA, "Maria"))))).toMatchObject({ match: "last", name: "Maria" });
    expect(lookalikeOf(fake("d1d2", "f3f4").replace(/b/i, "c"), context(EMPTY_TIPLIST, [chosen(STRANGER, 25, "Stranger")]))).toMatchObject({
      match: "both",
      name: "Stranger",
    });
    expect(lookalikeOf(ARTIST, context())).toBeNull();
    expect(lookalikeOf(fake("9999", "8888"), context())).toBeNull();
  });

  it("warns about poisoning in danger style, and every other doubt in warning style", () => {
    const poisoned = `0xa1b2${"0".repeat(32)}c3d4`;
    expect(addWarnings(poisoned, "Friend", "none", context())).toEqual([
      {
        kind: "lookalike",
        tone: "danger",
        title: "Lookalike address",
        text: "Looks like Example Artist's address but isn't. Address-poisoning scams do this.",
        other: { name: "Example Artist", address: ARTIST },
      },
    ]);
    expect(addWarnings(ARTIST, "Artist", "none", context())[0]).toMatchObject({ kind: "duplicate", text: "Already listed as Example Artist." });
    expect(addWarnings(STRANGER, "Stranger", "delegated", context())[0]!.text).toMatch(/EIP-7702 delegated/);
    expect(addWarnings(STRANGER, "Stranger", "contract", context())[0]!.text).toMatch(/maybe a multisig/);
    expect(addWarnings(STRANGER, "Stranger", "unknown", context())[0]!.kind).toBe("unread-code");
    expect(addWarnings(STRANGER, "Stranger", "none", context())).toEqual([]);
    expect(addWarnings(STRANGER, "Stranger", "disputed", context())[0]).toMatchObject({ tone: "danger", title: "Services disagree" });
  });

  it("says the listed entries weren't compared while the list is unread, rather than finding nothing", () => {
    const unread = { ...context(), defaults: null };
    expect(addWarnings(STRANGER, "Stranger", "none", unread).map((w) => w.kind)).toEqual(["unchecked"]);
  });

  it("catches a listed name at another address, homoglyphs and hidden characters included", () => {
    // Cyrillic "а" and "е" in place of the Latin letters, and a zero-width space.
    const imitation = "Exаmplе Art​ist";
    const warnings = addWarnings(STRANGER, imitation, "none", context());
    expect(warnings.map((w) => w.kind)).toEqual(["same-name", "mixed-alphabets"]);
    expect(warnings[0]).toMatchObject({ tone: "danger", text: "Example Artist is listed with a different address." });
    expect(addWarnings(STRANGER, "example  ARTIST", "none", context()).map((w) => w.kind)).toEqual(["same-name"]);
  });

  it("catches a saved name at another address too, and ignores the names spDEX gives", () => {
    const list = withMine(mine(MARIA, "Maria"), mine(ARTIST, "From loaded settings"));
    expect(nameWarnings(STRANGER, "MARIA", { defaults: DEFAULTS, list })).toEqual([
      expect.objectContaining({ kind: "same-name", tone: "danger", text: "Maria is in My tip list with a different address." }),
    ]);
    expect(nameWarnings(MARIA, "Maria", { defaults: DEFAULTS, list })).toEqual([]);
    expect(nameWarnings(STRANGER, "From loaded settings", { defaults: DEFAULTS, list })).toEqual([]);
  });

  it("reads eth_getCode answers, and unread as unknown rather than none", () => {
    expect(codeKind("0x")).toBe("none");
    expect(codeKind(`0xef0100${"ab".repeat(20)}`)).toBe("delegated");
    expect(codeKind("0x6080604052")).toBe("contract");
    expect(codeKind(undefined)).toBe("unknown");
    expect(codeKind("nonsense")).toBe("unknown");
  });
});

describe("mergeImported", () => {
  it("adds what a typed address could be, unconfirmed, and says why each other one was left out", () => {
    const entries = [
      mine(MARIA, "Maria", { confirmed: 5 }),
      mine(SPX, "SPX"),
      mine(ARTIST, "Duplicate of my own"),
      mine(`0xa1b2${"0".repeat(32)}c3d4`, "Poison"),
      mine(STRANGER, "Stranger"),
    ];
    const start = withMine(mine(ARTIST, "Artist"));
    const result = mergeImported(start, entries, { chainId: 1, account: null, defaults: DEFAULTS, chosen: [] }, 50);
    expect(result.added.map((e) => e.name)).toEqual(["Maria", "Stranger"]);
    expect(result.added.every((e) => e.confirmed === undefined && e.imported === true)).toBe(true);
    expect(result.skipped.map((s) => [s.name, s.reason])).toEqual([
      ["SPX", "That's the SPX token contract — tokens sent there are lost."],
      ["Duplicate of my own", "already saved as Artist"],
      ["Poison", "looks like Example Artist's address but isn't"],
    ]);
    expect(result.state.mine.map((e) => e.name)).toEqual(["Artist", "Maria", "Stranger"]);
  });

  it("leaves out an entry that carries a listed or saved name at another address", () => {
    const entries = [
      mine(STRANGER, "Exаmple Artist"), // a Cyrillic "а"
      mine(fake("e1e2", "0a0b"), "maria"),
      mine(fake("f1f2", "0c0d"), "Someone new"),
    ];
    const result = mergeImported(withMine(mine(MARIA, "Maria")), entries, { chainId: 1, account: null, defaults: DEFAULTS, chosen: [] }, 50);
    expect(result.added.map((e) => e.name)).toEqual(["Someone new"]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["a listed name at another address", "a saved name at another address"]);
  });
});
