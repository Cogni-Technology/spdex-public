/**
 * Trust and exits' words: where a copy came from, what rebuilding it proves,
 * and the exits, none of which may name a domain spDEX wasn't given.
 */

import { describe, expect, it } from "vitest";
import { encodeClose } from "@spdex/vault";
import {
  CLOSE_CALLDATA,
  CLOSE_VAULT_CAUTION,
  CLOSE_VAULT_TEXT,
  CLOSE_VAULT_WAYS,
  EXPORT_TEXT,
  KEEPER_TEXT,
  MATCH_PROVES,
  NO_SOURCE_TEXT,
  buildOrigin,
  listSearchHint,
  originSentence,
  sharedGatewayNote,
  verifyCommands,
  walkawayLines,
} from "./walkaway.js";

const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

describe("where this copy came from", () => {
  it("finds a CID in a gateway path", () => {
    expect(buildOrigin({ origin: "https://ipfs.io", host: "ipfs.io", pathname: `/ipfs/${CID_V1}/` })).toEqual({
      kind: "ipfs-path",
      cid: CID_V1,
      origin: "https://ipfs.io",
    });
    expect(buildOrigin({ origin: "https://ipfs.io", host: "ipfs.io", pathname: `/ipfs/${CID_V0}/index.html` })).toMatchObject({ kind: "ipfs-path", cid: CID_V0 });
  });

  it("finds a CID in a subdomain gateway's host", () => {
    expect(buildOrigin({ origin: `https://${CID_V1}.ipfs.dweb.link`, host: `${CID_V1}.ipfs.dweb.link`, pathname: "/" })).toEqual({
      kind: "ipfs-subdomain",
      cid: CID_V1,
      origin: `https://${CID_V1}.ipfs.dweb.link`,
    });
  });

  it("takes anything else for a web server, a CID-looking name included", () => {
    expect(buildOrigin({ origin: "http://localhost:5199", host: "localhost:5199", pathname: "/" })).toEqual({ kind: "web", origin: "http://localhost:5199" });
    // Too short to be a CID, and a path that only mentions ipfs.
    expect(buildOrigin({ origin: "https://example.org", host: "example.org", pathname: "/ipfs/bafy/" }).kind).toBe("web");
    expect(buildOrigin({ origin: "https://example.org", host: "example.org", pathname: `/docs/ipfs/${CID_V1}/` }).kind).toBe("web");
    expect(buildOrigin(undefined)).toEqual({ kind: "unknown" });
    expect(buildOrigin({ origin: "null" })).toEqual({ kind: "unknown" });
  });

  it("never says verified, and says a page can't prove itself", () => {
    const web = originSentence({ kind: "web", origin: "http://localhost:5199" });
    expect(web).toMatch(/^This copy came from http:\/\/localhost:5199\. A web server can change what it sends at any time, so this page can't vouch for itself\./);
    const ipfs = originSentence({ kind: "ipfs-path", cid: CID_V1, origin: "https://ipfs.io" });
    expect(ipfs).toContain(`/ipfs/${CID_V1}`);
    expect(ipfs).toContain("this can't prove itself");
    for (const text of [web, ipfs, originSentence({ kind: "unknown" }), MATCH_PROVES]) expect(text).not.toMatch(/\bverified\b/i);
  });

  it("warns about shared storage only on the path form of a gateway", () => {
    const note = sharedGatewayNote({ kind: "ipfs-path", cid: CID_V1, origin: "https://ipfs.io" });
    expect(note).toContain("shares this browser's storage (settings, records, notification permission) with every other site on that gateway");
    expect(note).toContain(`(${CID_V1}.ipfs.<gateway>)`);
    expect(sharedGatewayNote({ kind: "ipfs-subdomain", cid: CID_V1, origin: "x" })).toBeNull();
    expect(sharedGatewayNote({ kind: "web", origin: "x" })).toBeNull();
  });
});

describe("rebuilding a release", () => {
  it("clones the configured source into a folder it names, then builds and prints the CID", () => {
    expect(verifyCommands("https://example.org/someone/spdex-fork.git")).toEqual([
      "git clone https://example.org/someone/spdex-fork.git spdex && cd spdex",
      "git checkout <release tag>",
      "pnpm install --frozen-lockfile",
      "pnpm build:release    # with the VITE_SPDEX_* values the release published",
      "pnpm ipfs:cid",
    ]);
  });

  it("says the release's build settings are needed, since without them the CID can't match", () => {
    expect(MATCH_PROVES).toContain("build with the VITE_SPDEX_* settings the release published");
    expect(MATCH_PROVES).toContain("without them the CID won't match");
  });

  it("offers the rebuild only when there are commands to show, and never ends on a bare colon", () => {
    const origins = [
      { kind: "web", origin: "http://localhost:5199" },
      { kind: "ipfs-path", cid: CID_V1, origin: "https://ipfs.io" },
      { kind: "unknown" },
    ] as const;
    for (const origin of origins) {
      expect(originSentence(origin)).toMatch(/:$/);
      const alone = originSentence(origin, false);
      expect(alone).toMatch(/\.$/);
      expect(alone).not.toMatch(/rebuild/);
    }
  });

  it("says plainly when the build names no source, and what a match does and doesn't prove", () => {
    expect(NO_SOURCE_TEXT).toBe("This build doesn't say where its source is published.");
    expect(MATCH_PROVES).toContain("It doesn't make the source safe");
    expect(MATCH_PROVES).toContain("can't show that this tab is running those files");
  });
});

describe("the exits", () => {
  const every = [
    ...walkawayLines({ rpcSource: "bundled" }).map((l) => l.text),
    ...walkawayLines({ rpcSource: "user" }).map((l) => l.text),
    CLOSE_VAULT_TEXT,
    ...CLOSE_VAULT_WAYS,
    CLOSE_VAULT_CAUTION,
    KEEPER_TEXT,
    EXPORT_TEXT,
    listSearchHint(4),
    listSearchHint(null),
  ];

  it("name no domain spDEX wasn't given", () => {
    for (const text of every) expect(text).not.toMatch(/spdex\.io|https?:\/\/|www\./);
  });

  it("give close()'s calldata as computed, which is 0x43d726d6", () => {
    expect(CLOSE_CALLDATA).toBe(encodeClose());
    expect(CLOSE_CALLDATA).toBe("0x43d726d6");
    expect(CLOSE_VAULT_WAYS.join(" ")).toContain("send 0 ETH to the vault with data 0x43d726d6 (that is close())");
  });

  it("say when the built-in network service is the one in use", () => {
    const service = (source: "bundled" | "user" | "fallback") => walkawayLines({ rpcSource: source }).find((l) => l.id === "service")!.text;
    expect(service("bundled")).toMatch(/^You're on the built-in service/);
    expect(service("user")).not.toContain("You're on the built-in");
    // The place is a button after the line, not words in it.
    expect(walkawayLines({ rpcSource: "user" }).find((l) => l.id === "service")!.places).toEqual(["networkService"]);
    for (const text of every) expect(text).not.toMatch(/Expert →|\bin Expert\b/);
  });

  it("keep each line to twenty words", () => {
    for (const text of [...walkawayLines({ rpcSource: "bundled" }), ...walkawayLines({ rpcSource: "user" })].map((l) => l.text)) {
      expect(text.split(/\s+/).length, text).toBeLessThanOrEqual(20);
    }
  });

  it("say a v2 vault's buy is anyone's only after SPX holders' first claim", () => {
    // v1's "anyone can make a due buy" is true of a v2 vault only after its community window.
    expect(KEEPER_TEXT).toBe(
      "Anyone can make a due vault buy; SPX holders have first claim for a while. Run a keeper (docs/KEEPER.md in spDEX's source) to keep yours buying.",
    );
    for (const text of every) expect(text).not.toMatch(/\bAPR\b|\bAPY\b|yield|reward/i);
  });

  it("state the list search's cost when the list's length is known, and make no privacy claim", () => {
    expect(listSearchHint(4)).toContain("(about 4 reads)");
    expect(listSearchHint(null)).toContain("(one read for every 200 vaults on the list, plus a few)");
    expect(listSearchHint(4)).toContain("Your service still sees your address.");
    expect(listSearchHint(4)).not.toMatch(/\bprivate\b|\bprivacy\b/i);
  });
});
