import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CID, varint } from "multiformats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCid } from "./ipfs-cid.mjs";

// A build in miniature: index.html beside assets/, and a script big enough to
// be split into two 262,144-byte chunks.
const INDEX = '<!doctype html><title>spDEX</title><script src="./assets/app.js"></script>\n';
const APP = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));

// What kubo 0.43.1 prints for these two files, `ipfs add -rn --cid-version=1 build`
// (checked 2026-10-02): the address a third party gets, so the one this script must.
const KUBO = {
  root: "bafybeifpsgrajg37su7vfb32bzl5mglqagwlvfmxjmj6plgqvx7je6zoha",
  assets: "bafybeifpa75ijnlegstj5dzgiutcctkfzgcco42kxckdkhnmkdk4gcqvm4",
  app: "bafybeihyyabtpcz56rofowvdag7mkapuwyfrzzoqnwivf3nf2l2istuwcu",
  index: "bafkreifsspzreqaz2oexmmdtgp2cuehzjmdpmh4kjz6xi2yksuojojp6n4",
};

let dir = "";
let build = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "spdex-cid-"));
  build = join(dir, "build");
  mkdirSync(join(build, "assets"), { recursive: true });
  writeFileSync(join(build, "index.html"), INDEX);
  writeFileSync(join(build, "assets", "app.js"), APP);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("computeCid", () => {
  it("gives the whole build the address `ipfs add -r` gives it, index.html included", async () => {
    const { cid, files } = await computeCid(build);
    expect(cid).toBe(KUBO.root);
    expect(files).toEqual([
      { path: "assets", cid: KUBO.assets, size: expect.any(Number) },
      { path: "assets/app.js", cid: KUBO.app, size: expect.any(Number) },
      { path: "index.html", cid: KUBO.index, size: expect.any(Number) },
    ]);
  });
});

describe("--car", () => {
  it("writes a CAR whose one root is the build's address, and whose blocks hold its files", () => {
    const car = join(dir, "build.car");
    const printed = JSON.parse(execFileSync("node", [new URL("./ipfs-cid.mjs", import.meta.url).pathname, build, "--car", car, "--json"], { encoding: "utf8" }));
    expect(printed.cid).toBe(KUBO.root);

    const bytes = readFileSync(car);
    const [headerLength, at] = varint.decode(bytes);
    const header = bytes.subarray(at, at + headerLength);
    const root = CID.parse(KUBO.root).bytes;
    // {roots: [root], version: 1} in DAG-CBOR.
    expect(Buffer.from(header).toString("hex")).toBe(
      `a265726f6f747381d82a58${(root.length + 1).toString(16)}00${Buffer.from(root).toString("hex")}6776657273696f6e01`,
    );

    // The root block comes first, then every block in CID order; each section is a CID and its bytes.
    const cids: string[] = [];
    for (let offset = at + headerLength; offset < bytes.length; ) {
      const [length, prefix] = varint.decode(bytes, offset);
      const section = bytes.subarray(offset + prefix, offset + prefix + length);
      const cid = CID.decodeFirst(section)[0];
      cids.push(cid.toString());
      offset += prefix + length;
    }
    expect(cids[0]).toBe(KUBO.root);
    expect(cids).toContain(KUBO.index);
    expect(cids.slice(1)).toEqual([...cids.slice(1)].sort());
    expect(bytes.includes(Buffer.from(INDEX))).toBe(true);
  });
});
