#!/usr/bin/env node
/**
 * Boot a mainnet fork pinned to SPDEX_FORK_BLOCK, then prove it is the right one.
 *
 * The proof matters more than the boot. A fork silently seeded from the wrong
 * chain, or from a `latest` that drifted, produces quotes that look plausible
 * and are wrong — the single most expensive failure mode for a repo whose
 * premise is that tests can be trusted without a human reading them. So we
 * assert the forked chain actually produced SPDEX_FORK_BLOCK_HASH at that
 * height, and refuse to serve if it did not.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;

/** Minimal .env reader — no dependency, and dotenv's precedence rules aren't needed here. */
function loadEnv() {
  const env = {};
  for (const file of [".env.defaults", ".env.local"]) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const BLOCK = env.SPDEX_FORK_BLOCK;
const EXPECTED_HASH = env.SPDEX_FORK_BLOCK_HASH?.toLowerCase();
const PORT = env.SPDEX_FORK_PORT ?? "8545";
const UPSTREAM = env.SPDEX_FORK_RPC_URL;

/**
 * The chain id the fork reports.
 *
 * Deliberately not 1, and deliberately not 31337 either. A fork claiming to be
 * mainnet forces MetaMask to treat it — it then prices gas from its own mainnet service rather than from
 * this node, whose base fee sits near zero because the blocks are empty, and
 * warns about the discrepancy on every transaction. Reporting a distinct id
 * makes it an ordinary custom network: gas comes from the node, and there is no
 * way to confuse it with the real chain.
 *
 * The forked *state* is still mainnet, so every contract address is unchanged.
 * Only the id differs, and the block-hash anchor below still proves the history
 * is genuinely mainnet's.
 */
const CHAIN_ID = env.SPDEX_FORK_CHAIN_ID ?? "690069";

if (!BLOCK || !EXPECTED_HASH) {
  console.error("Missing SPDEX_FORK_BLOCK / SPDEX_FORK_BLOCK_HASH in .env.defaults");
  process.exit(1);
}

if (!UPSTREAM) {
  console.error(
    "SPDEX_FORK_RPC_URL is not set.\n\n" +
      "Forking at a pinned block needs an ARCHIVE endpoint — the state is\n" +
      "thousands of blocks back and full nodes have pruned it. Most free public\n" +
      "endpoints reject the request. Alchemy's free tier works.\n\n" +
      "  echo 'SPDEX_FORK_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY' >> .env.local\n",
  );
  process.exit(1);
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const local = `http://127.0.0.1:${PORT}`;

console.log(`▶ forking mainnet @ block ${BLOCK} on ${local}`);
const anvil = spawn(
  "anvil",
  [
    "--fork-url", UPSTREAM,
    "--fork-block-number", String(BLOCK),
    "--chain-id", String(CHAIN_ID),
    "--port", String(PORT),
    "--silent",
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);

anvil.on("error", (err) => {
  console.error(`anvil failed to start: ${err.message}`);
  console.error("Install Foundry — see docs/DEVELOPMENT.md");
  process.exit(127);
});

/** Poll until the fork answers, rather than sleeping a guessed interval. */
async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpc(local, "eth_chainId", []);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

const shutdown = (code) => {
  anvil.kill("SIGTERM");
  process.exit(code);
};

if (!(await waitForReady())) {
  console.error("✗ fork did not become ready within 60s");
  shutdown(1);
}

// ── The integrity anchor ──────────────────────────────────────────────────
const chainId = await rpc(local, "eth_chainId", []);
if (parseInt(chainId, 16) !== Number(CHAIN_ID)) {
  console.error(`✗ wrong chain id: expected ${CHAIN_ID}, got ${parseInt(chainId, 16)}`);
  shutdown(1);
}

const block = await rpc(local, "eth_getBlockByNumber", [
  `0x${Number(BLOCK).toString(16)}`,
  false,
]);
if (!block) {
  console.error(`✗ forked chain has no block ${BLOCK}`);
  shutdown(1);
}
if (block.hash.toLowerCase() !== EXPECTED_HASH) {
  console.error(
    `✗ fork anchor mismatch at block ${BLOCK}\n` +
      `  expected ${EXPECTED_HASH}\n` +
      `  got      ${block.hash.toLowerCase()}\n` +
      `  The upstream RPC is serving a different chain or a reorged history.`,
  );
  shutdown(1);
}

// The id can be anything; the history cannot. This is what proves the state is
// really mainnet's rather than a chain that merely says so.
console.log(`✓ fork verified — mainnet block ${BLOCK} @ ${block.hash.slice(0, 18)}…`);
console.log(`  reporting chain id ${CHAIN_ID} (mainnet state, distinct id)`);
console.log(`  listening on ${local} (ctrl-c to stop)`);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(0));
anvil.on("close", (code) => process.exit(code ?? 0));
