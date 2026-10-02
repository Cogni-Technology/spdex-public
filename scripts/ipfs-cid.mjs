#!/usr/bin/env node
/**
 * Compute the IPFS CID of a built directory, without a daemon.
 *
 * A release is only verifiable if anyone can rebuild the source and arrive at
 * the same content address. Telling users "this is the real spDEX" is worth
 * nothing if the only way to check is to trust whoever did the pinning — so the
 * CID is derived here, from the build output, by the same UnixFS rules `ipfs
 * add` uses.
 *
 * Parameters are pinned explicitly rather than left to defaults, because the
 * CID depends on every one of them. A different chunk size or leaf encoding
 * produces a different address for byte-identical content, which would look
 * exactly like a tampered build.
 *
 * `--car <file>` also writes the build as a CAR file: the blocks behind that
 * address, for a pinning service that imports a CAR as it is. Uploading the
 * files themselves lets the service chunk them its own way, and the address it
 * pins may then not be this one.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { MemoryBlockstore } from "blockstore-core";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { varint } from "multiformats";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * `ipfs add --cid-version=1 --raw-leaves` defaults, stated so they cannot drift.
 *
 * Every one of these changes the resulting address. A build with a different
 * chunk size is byte-identical content at a different CID, which to anyone
 * checking a pin is indistinguishable from a tampered build — so they are
 * written out rather than inherited from whatever the library defaults to this
 * major version.
 */
const CHUNK_SIZE = 262_144;
const UNIXFS_OPTIONS = {
  cidVersion: 1,
  rawLeaves: true,
  chunker: fixedSize({ chunkSize: CHUNK_SIZE }),
  // The build's files sit side by side (index.html beside assets/), so the
  // root is a directory made to hold them, as `ipfs add -r dist` makes `dist`.
  // Without it the importer yields each top-level entry as a root of its own.
  wrapWithDirectory: true,
};

/**
 * A memory blockstore that remembers each block's CID as the importer gave it.
 * The store keys blocks by their hash alone and hands every one back as a raw
 * block's CID, a directory's included; a CAR must name each by its own.
 */
class RecordingBlockstore extends MemoryBlockstore {
  cids = new Map();

  put(cid, bytes, options) {
    this.cids.set(hashKey(cid), cid);
    return super.put(cid, bytes, options);
  }

  /** The CID a block was stored under, from any CID with the same hash. */
  cidOf(cid) {
    const stored = this.cids.get(hashKey(cid));
    if (!stored) throw new Error(`no block was stored under ${cid}`);
    return stored;
  }
}

const hashKey = (cid) => Buffer.from(cid.multihash.bytes).toString("hex");

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

export async function computeCid(distDir) {
  const { root, files } = await importBuild(distDir);
  return { cid: root.toString(), files };
}

/** The build imported by the parameters above: its root CID, each file's, and every block. */
async function importBuild(distDir) {
  const files = await walk(distDir);
  if (files.length === 0) throw new Error(`no files found in ${distDir}`);

  // Sorted by path: the importer builds the directory DAG in insertion order,
  // so an unsorted walk would produce a different CID for identical content
  // depending on how the filesystem happened to enumerate it.
  files.sort();

  const entries = [];
  for (const path of files) {
    entries.push({
      path: relative(distDir, path).split(sep).join("/"),
      content: await readFile(path),
    });
  }

  const blockstore = new RecordingBlockstore();
  let root = null;
  const perFile = [];

  for await (const entry of importer(entries, blockstore, UNIXFS_OPTIONS)) {
    perFile.push({ path: entry.path ?? "", cid: entry.cid.toString(), size: Number(entry.size) });
    // The wrapping directory is the one entry with no path.
    if (!entry.path) {
      if (root) throw new Error("importer produced two roots");
      root = entry;
    }
  }

  if (!root) throw new Error("importer produced no root");

  return {
    root: root.cid,
    files: perFile.filter((f) => f.path !== "").sort((a, b) => (a.path < b.path ? -1 : 1)),
    blockstore,
  };
}

/**
 * Write the imported build as a CARv1 file: a header naming `root`, then every
 * block as its CID and bytes. Root first, the rest in CID order, so the same
 * build always writes the same file.
 */
async function writeCar(path, root, blockstore) {
  const blocks = [];
  for await (const pair of blockstore.getAll()) {
    const chunks = [];
    for await (const chunk of pair.bytes) chunks.push(chunk);
    const cid = blockstore.cidOf(pair.cid);
    blocks.push({ cid, bytes: Buffer.concat(chunks), key: cid.equals(root) ? "" : cid.toString() });
  }
  blocks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sections = [carHeader(root), ...blocks.map((block) => Buffer.concat([block.cid.bytes, block.bytes]))];
  await writeFile(path, Buffer.concat(sections.flatMap((section) => [lengthPrefix(section.length), section])));
}

const lengthPrefix = (n) => varint.encodeTo(n, new Uint8Array(varint.encodingLength(n)));

/**
 * `{roots: [root], version: 1}` in DAG-CBOR, written out: keys shortest first,
 * and the CID as tag 42 over a byte string of 0x00 and the CID's bytes.
 */
function carHeader(root) {
  const link = Buffer.concat([Buffer.from([0x00]), root.bytes]);
  if (link.length >= 256) throw new Error("root CID too long for a one-byte CBOR length");
  const linkLength = link.length < 24 ? [0x40 + link.length] : [0x58, link.length];
  return Buffer.concat([
    Buffer.from([0xa2, 0x65]), Buffer.from("roots"),
    Buffer.from([0x81, 0xd8, 0x2a, ...linkLength]), link,
    Buffer.from([0x67]), Buffer.from("version"), Buffer.from([0x01]),
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  const carAt = args.indexOf("--car");
  const carPath = carAt === -1 ? null : args[carAt + 1];
  if (carAt !== -1 && (!carPath || carPath.startsWith("--"))) {
    console.error("--car needs the file to write, e.g. --car spdex.car");
    process.exit(1);
  }
  const target = args.find((arg, i) => !arg.startsWith("--") && !(carAt !== -1 && i === carAt + 1)) ?? join(ROOT, "apps/web/dist");
  try {
    await stat(target);
  } catch {
    console.error(`No build found at ${target}. Run \`pnpm build:release\` first.`);
    process.exit(1);
  }

  const { root, files, blockstore } = await importBuild(target);
  const result = { cid: root.toString(), files };
  if (carPath) await writeCar(carPath, root, blockstore);

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\nroot CID  ${result.cid}\n`);
  for (const file of result.files) {
    console.log(`  ${file.cid}  ${String(file.size).padStart(9)}  ${file.path}`);
  }
  console.log(`\n${result.files.length} files`);
  console.log(`\nVerify a pin with:  ipfs add -rn --cid-version=1 ${relative(process.cwd(), target)}`);
  if (carPath) console.log(`CAR file written: ${carPath} (root ${result.cid})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
