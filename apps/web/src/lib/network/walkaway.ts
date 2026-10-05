/**
 * Trust and exits: how to check this copy of spDEX, and how to do without it.
 *
 * Everything here is words and pure checks; the panel is
 * `components/network/WalkawayPanel.tsx`. Two rules shape the words:
 *
 * - **A page can't vouch for itself.** Whatever served this page could have
 *   changed what it says, this sentence included. So "Verify this build"
 *   never says "verified": it says where the page came from, and gives the
 *   commands that let someone check a release without trusting it.
 * - **No address spDEX wasn't given.** The source's address is a build
 *   setting (`sourceUrl()`); when it isn't set, the panel says so instead of
 *   showing a placeholder made to look like a link. No domain is written in.
 */

import { encodeClose } from "@spdex/vault";
import type { PlaceKey } from "../places.js";

/** Where this page was loaded from, as far as the address bar can tell. */
export type BuildOrigin =
  | { kind: "ipfs-path"; cid: string; origin: string }
  | { kind: "ipfs-subdomain"; cid: string; origin: string }
  | { kind: "web"; origin: string }
  | { kind: "unknown" };

// CIDv0 (base58btc "Qm…") or CIDv1 in base32 ("b…"), the two forms gateways use.
const IPFS_PATH = /^\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})\//;
const IPFS_SUBDOMAIN = /^(b[a-z2-7]{58,})\.ipfs\./;

/**
 * Whether this page came from an IPFS gateway, by path (`/ipfs/<CID>/`) or by
 * subdomain (`<CID>.ipfs.<gateway>`), or from an ordinary web server.
 */
export function buildOrigin(where: { origin?: string; host?: string; pathname?: string } | null | undefined): BuildOrigin {
  if (!where?.origin || where.origin === "null") return { kind: "unknown" };
  const path = IPFS_PATH.exec(where.pathname ?? "");
  if (path) return { kind: "ipfs-path", cid: path[1]!, origin: where.origin };
  const sub = IPFS_SUBDOMAIN.exec((where.host ?? "").toLowerCase());
  if (sub) return { kind: "ipfs-subdomain", cid: sub[1]!, origin: where.origin };
  return { kind: "web", origin: where.origin };
}

/**
 * The opening sentence of "Verify this build", by where the page came from.
 * It offers the rebuild, ending on a colon before the commands, only when
 * the panel has commands to show (`canRebuild`: the build names its source).
 */
export function originSentence(origin: BuildOrigin, canRebuild = true): string {
  switch (origin.kind) {
    case "ipfs-path":
    case "ipfs-subdomain":
      return `This page was loaded from the address /ipfs/${origin.cid}. A gateway could have sent other files under that address, and a changed page could say anything here, so this can't prove itself. To be sure, open the CID through your own IPFS node${canRebuild ? ", or rebuild it and compare:" : "."}`;
    case "web":
      return `This copy came from ${origin.origin}. A web server can change what it sends at any time, so this page can't vouch for itself. Open a release's CID through your own IPFS node or a gateway you trust${canRebuild ? ", or rebuild it:" : "."}`;
    case "unknown":
      return `This page can't tell where it was loaded from, and couldn't vouch for itself anyway. Open a release's CID through your own IPFS node or a gateway you trust${canRebuild ? ", or rebuild it:" : "."}`;
  }
}

/**
 * The extra warning for a copy served under a path on a shared gateway: it
 * shares this browser's storage with every other site there. Null for any
 * other copy.
 */
export function sharedGatewayNote(origin: BuildOrigin): string | null {
  if (origin.kind !== "ipfs-path") return null;
  return `This copy is served under a path on a shared gateway, so it shares this browser's storage (settings, records, notification permission) with every other site on that gateway. Any of those sites can change your settings, and an open spDEX tab takes them up as if you had. A subdomain gateway (${origin.cid}.ipfs.<gateway>) keeps them apart. Releases opened on the same gateway share settings: an older release can't read newer settings and starts from the preset, so don't change settings there.`;
}

/**
 * The commands that rebuild a release and print its CID, from
 * docs/IPFS-RELEASE.md. The clone names its folder, so `cd` is right whatever
 * the repository is called.
 *
 * The build step carries the release's build settings as a shell comment.
 * Vite writes every `VITE_SPDEX_*` value into the bundle, and a release that
 * shows these commands was built with at least one (the source address
 * itself), so a fresh clone built without them makes a different CID, and
 * the mismatch would look like tampering.
 */
export function verifyCommands(source: string): string[] {
  return [
    `git clone ${source} spdex && cd spdex`,
    "git checkout <release tag>",
    "pnpm install --frozen-lockfile",
    "pnpm build:release    # with the VITE_SPDEX_* values the release published",
    "pnpm ipfs:cid",
  ];
}

export const NO_SOURCE_TEXT = "This build doesn't say where its source is published.";

/** What a matching CID does and doesn't prove, in one place so no copy overstates it. */
export const MATCH_PROVES =
  "Replace <release tag> with the release's tag, and build with the VITE_SPDEX_* settings the release published: they're part of what's built, so without them the CID won't match. If the CID printed at the end matches the release's, that CID holds exactly what this source builds with those settings. It doesn't make the source safe, and it can't show that this tab is running those files: only opening the CID yourself does.";

/** `close()`'s calldata, computed rather than typed: what a wallet sends to close a vault. */
export const CLOSE_CALLDATA = encodeClose();

/** The panel's opening line. */
export const WALKAWAY_INTRO = "Check this build, or leave with your vaults.";

/**
 * One "If spDEX disappeared" line: a sentence, and the place in spDEX it
 * points to (`PLACES`), which the panel renders as a `GoTo` after it.
 */
export interface WalkawayLine {
  id: string;
  text: string;
  places?: readonly PlaceKey[];
}

/** The "If spDEX disappeared" lines that don't depend on vaults. Each at most 20 words. */
export function walkawayLines(input: { rpcSource: "bundled" | "user" | "fallback" }): WalkawayLine[] {
  const service =
    input.rpcSource === "bundled"
      ? "You're on the built-in service: it works only where its publisher hosts it. Elsewhere, use any Ethereum RPC."
      : "The built-in service works only where its publisher hosts it. Elsewhere, use any Ethereum RPC or your own node.";
  return [
    { id: "static", text: "spDEX is a folder of static files: save or pin a release, and serve it from anywhere." },
    { id: "service", text: service, places: ["networkService"] },
    { id: "relays", text: "Private sending uses other people's relays (Flashbots Protect, MEV Blocker). Any relay works.", places: ["sending"] },
  ];
}

/** How to close a vault without spDEX: the lead, then the two ways (`CLOSE_VAULT_WAYS`). */
export const CLOSE_VAULT_TEXT = "To stop a vault and take everything back, call close() from its owner's wallet:";

export const CLOSE_VAULT_WAYS: readonly string[] = [
  "on a block explorer: Contract → Write (as Proxy) → close;",
  `in any wallet that adds data: send 0 ETH to the vault with data ${CLOSE_CALLDATA} (that is close()).`,
];

export const CLOSE_VAULT_CAUTION = "spDEX never asks you to do this. Do it only for a vault whose owner() is your address.";

/**
 * Who may make a due buy: anyone, after SPX holders' first claim on a v2
 * vault's (its community window). How to make one by hand, `execute(owner)`,
 * is docs/WALKAWAY.md's: a vault keeps buying without its owner either way.
 */
export const KEEPER_TEXT =
  "Anyone can make a due vault buy; on a v2 vault, SPX holders have first claim for a while. Run a keeper (docs/KEEPER.md in spDEX's source) to keep yours buying.";

export const EXPORT_TEXT = "This browser's storage can be cleared: export your settings and records.";

/** Where `EXPORT_TEXT` points: the settings file, and the records' CSV. */
export const EXPORT_PLACES: readonly PlaceKey[] = ["settingsFile", "activityCsv"];

/** The hint on "Find my vaults from the factories' lists", with its cost when the lists' length is known. */
export function listSearchHint(reads: number | null): string {
  const cost = reads === null ? "one read for every 200 vaults on the list, plus a few" : `about ${reads} reads`;
  return `For services that limit log searches: reads every vault's owner instead (${cost}). Your service still sees your address.`;
}
