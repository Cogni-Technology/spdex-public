#!/usr/bin/env node
/**
 * Produce a release build that is byte-identical across machines.
 *
 * Reproducibility is the whole basis of the claim that a pinned CID is the
 * source you can read. Anything that varies between builds — a timestamp, an
 * absolute path, a locale-dependent sort — breaks that link and turns "verify
 * the build yourself" into "trust whoever pinned it".
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "apps/web");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: WEB, stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

export async function buildRelease(outDir = join(WEB, "dist")) {
  await rm(outDir, { recursive: true, force: true });

  await run("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    ...process.env,
    SPDEX_RELEASE: "1",
    // Fixed locale and timezone: both can reach output through date and string
    // formatting, and a build that differs by machine locale is not reproducible.
    LC_ALL: "C",
    TZ: "UTC",
  });

  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(WEB, "dist");
  await buildRelease(outDir);
  console.log(`\nRelease build at ${outDir}`);
  console.log("Compute its address with: pnpm ipfs:cid");
}
