/*
 * The tip list spDEX ships: names, and the addresses they point at.
 *
 * The smallest useful module in the repo, and a deliberate demonstration that
 * the module boundary is not venue-shaped. It requests no capabilities at all —
 * a registry is data, and one asking to read the chain would be worth a hard
 * look — so it runs with literally nothing reachable: no fetch, no storage, no
 * signer, no clock, not even `ctx.multicall`.
 *
 * ## What this list is, and is not
 *
 * It is NOT an endorsement, and a name on it is not a recommendation. The host
 * treats every address here as untrusted, because a list is exactly the thing
 * that would be attacked to redirect a tip: change one character of an
 * address and the money goes somewhere else. What makes that survivable:
 *
 *   1. The app shows the full address next to the name when the person picks,
 *      and writes the *address* into their config. A list that changes its
 *      mind later cannot move money the person already agreed to.
 *   2. An entry that is later retired is skipped, not silently swapped for
 *      its replacement: the person confirms again or it is not tipped.
 *   3. Every resulting transfer is checked by the Guard against an intent the
 *      host authored, and simulated before signing. TipGuard refuses token
 *      contracts, Permit2 and public development accounts whatever this says.
 *
 * Test entries are not here. Anvil's development accounts, which the fork
 * specs tip, live in `modules/tiplist-dev-fixtures`, loaded only on a local
 * test network. This file holds real entries only.
 *
 * ## Who adds an entry
 *
 * The maintainer, from what the person themselves published, with their
 * agreement. Never an automated tool, never a guess: an address shipped in a
 * bundle is an instruction about where money goes, and inventing or "finding"
 * one for somebody would be wrong regardless of intent.
 *
 * Listing checklist, for every entry:
 *   - the maintainer named this entry and the person agreed to be listed;
 *   - a public post by the person, at `proof`, shows this exact address (and a
 *     signed `claim` if they will give one);
 *   - no amounts and no ranking; nobody is pre-selected (tips stay off until a
 *     person picks a share and who gets it).
 *
 * ## The data format
 *
 * `ENTRIES` below, one object per person or cause, in the order the picker
 * lists them. `pnpm verify --only=unit` checks every entry
 * (modules/tiplist-spx-community/test/unit/registry.test.ts), with the rules in
 * `tipListProblems` (packages/chain/src/tipList.ts).
 *
 * Every id also goes in `shipped-ids.json`, beside this file, with its
 * address, in the same change: that file is append-only, and the test refuses
 * an entry missing from it or holding an address other than the one its id
 * shipped with.
 *
 *   id        required. a–z, 0–9 and "-", up to 40, starting with a letter or
 *             digit. Unique, and never reused: a retired entry keeps its id.
 *   label     required. The name shown, 1–64 characters. Nothing that looks
 *             like an address ("0x" and four hex digits), no invisible or
 *             right-to-left characters.
 *   handle    Their public handle, e.g. "@example_artist". Needed for a claim.
 *   address   required. EIP-55 checksummed ("0xAbC…", as a block explorer or
 *             viem's getAddress writes it). If the person gave only an ENS
 *             name, resolve it yourself, check the address with them, and put
 *             the address here.
 *   ens       Their ENS name, shown beside the address. Display only: spDEX
 *             never resolves a listed entry's name.
 *   note      required. Why they are listed, one line, up to 160 characters.
 *   proof     required. https link to the person's own public post showing
 *             this exact address. Shown as a link; spDEX never fetches it.
 *             The one exception is spDEX's own donation vault, whose address
 *             the host also holds (`SPDEX_DONATION_ADDRESS`): the picker
 *             calls it spDEX's own rather than showing a post.
 *   kind      "creator" | "cause" | "builder" | "other". A maintainer listing
 *             themselves is "builder", with a note that says so.
 *   listed    The month listed, "yyyy-mm".
 *   claim     Optional: { message, signature }, the person's EIP-191
 *             signature over exactly
 *             "spDEX tip list: <checksummed address> is <handle>, <yyyy-mm>".
 *             The app checks it offline and shows SIGNED only when it
 *             recovers this address; otherwise PROOF LINK ONLY.
 *
 * No two entries may share their first four or last four hex digits, no two
 * current entries' names may read alike, and no entry may be a public
 * development account, a token contract, Permit2 or another contract a tip
 * would be lost in; the tests refuse each.
 *
 * ## Removing or replacing an entry
 *
 * An app update, never a silent change for anyone who already picked it:
 *   - Remove: keep the entry for one release with `retired: "why"`, then delete it.
 *   - Replace: the old entry keeps its id and gains `retired` and
 *     `replacedBy: "<new id>"`; the new entry gets a new id.
 * A person tipping a retired entry is skipped until they confirm again, and is
 * shown both addresses before switching.
 *
 * A template, fictional, never to be shipped:
 *
 *   {
 *     id: "example-artist",
 *     label: "Example Artist",
 *     handle: "@example_artist",
 *     address: "0x…",
 *     note: "Draws a weekly SPX comic",
 *     proof: "https://…/example_artist/status/…",
 *     kind: "creator",
 *     listed: "2026-10",
 *   },
 */

/**
 * The list, in the order the picker shows it. Every entry by the checklist
 * above, except that spDEX's own donation vault has no `proof`: its evidence
 * is this source, and the host names it from `SPDEX_DONATION_ADDRESS`
 * (@spdex/core), never from what a list says. Like every entry, never chosen
 * for a person.
 */
const ENTRIES = [
  {
    id: "spdex-donation-vault",
    label: "spDEX donation vault",
    address: "0x201A4f5c79f5796dF045e82b1057d074E8b85EC1",
    note: "Donations to spDEX's development. Never chosen for you.",
    kind: "builder",
    listed: "2026-09",
  },
];

const spdexModule = {
  apiVersion: "1.0.0",

  /**
   * No arguments, no reads, no state.
   *
   * Determinism is the contract every module signs: identical inputs produce
   * byte-identical output, and the conformance suite enforces it. For a
   * registry that is trivially satisfied, which is the point — there is
   * nothing here that could behave one way under simulation and another when
   * signed. A copy is returned, so no caller can edit the list for the next.
   */
  async listRecipients() {
    return JSON.parse(JSON.stringify(ENTRIES));
  },
};

globalThis.spdexModule = spdexModule;
