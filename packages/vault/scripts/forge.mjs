#!/usr/bin/env node
/**
 * Run forge in this package with the repository's environment.
 *
 * The fork tests read SPDEX_FORK_RPC_URL, which lives in the repo's
 * `.env.local` (gitignored — it is usually a personal archive key). forge only
 * reads a `.env` beside its own foundry.toml, so without this wrapper
 * `forge test` would work in CI, where the variable is exported, and fail on a
 * laptop, where it sits in a file forge does not look at. Same loader as the
 * fork script and the vitest configs: `.env.defaults`, then `.env.local`, and
 * the real environment wins over both. It also picks the compiler: see
 * `solc.mjs`.
 *
 *   node packages/vault/scripts/forge.mjs test -vv
 *   pnpm --filter @spdex/vault test:forge
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvedEnv } from "../../../scripts/env.mjs";
import { solcArgs } from "./solc.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = resolvedEnv();
const args = process.argv.slice(2);
// Compiler selection applies to the commands that compile; `forge --version`
// and the like are passed through untouched.
const compiles = ["build", "test", "coverage", "snapshot"].includes(args[0] ?? "");

const child = spawn("forge", compiles ? [...args, ...solcArgs(env)] : args, {
  cwd: PACKAGE_ROOT,
  env,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`forge could not start: ${error.message} (is Foundry installed? see docs/DEVELOPMENT.md)`);
  process.exit(127);
});
child.on("close", (code) => process.exit(code ?? 1));
