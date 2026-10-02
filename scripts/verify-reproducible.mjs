#!/usr/bin/env node
/**
 * Build twice, into different directories, and require the same CID.
 *
 * This is the test behind the release claim. If two builds of one commit
 * disagree, the published address cannot be checked against the source by
 * anyone, and the only remaining reason to trust a pin is that we said so.
 *
 * Building into *different output paths* is deliberate: it catches the most
 * common cause of irreproducibility, which is a build that embeds its own
 * absolute path somewhere.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { buildRelease } from "./build-release.mjs";
import { computeCid } from "./ipfs-cid.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

const first = join(ROOT, ".repro/build-a");
const second = join(ROOT, ".repro/build-b");

try {
  console.log("▶ build 1 of 2");
  await buildRelease(first);
  console.log("▶ build 2 of 2");
  await buildRelease(second);

  const a = await computeCid(first);
  const b = await computeCid(second);

  console.log(`\n  build A  ${a.cid}`);
  console.log(`  build B  ${b.cid}`);

  if (a.cid === b.cid) {
    console.log(`\n\x1b[32mREPRODUCIBLE\x1b[0m — ${a.files.length} files, identical address\n`);
    process.exit(0);
  }

  // Name the files that differ; "the CIDs differ" alone sends you reading the
  // whole bundle.
  const byPath = new Map(b.files.map((file) => [file.path, file.cid]));
  const differing = a.files.filter((file) => byPath.get(file.path) !== file.cid);

  console.error(`\n\x1b[31mNOT REPRODUCIBLE\x1b[0m — ${differing.length} of ${a.files.length} files differ:\n`);
  for (const file of differing.slice(0, 20)) {
    console.error(`  ${file.path}`);
    console.error(`    A ${file.cid}`);
    console.error(`    B ${byPath.get(file.path) ?? "<missing>"}`);
  }
  process.exit(1);
} finally {
  await rm(join(ROOT, ".repro"), { recursive: true, force: true });
}
