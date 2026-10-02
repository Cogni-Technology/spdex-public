#!/usr/bin/env node
/**
 * `pnpm mainnet:smoke:fork`: a fork of Ethereum's latest block on port 8547
 * (SPDEX_SMOKE_FORK_PORT), for rehearsing the mainnet smoke suite with
 * nothing real at stake. Not the pinned fork (`pnpm anvil:fork`, :8545): that
 * one is the gate's, frozen at SPDEX_FORK_BLOCK; this one is today's chain,
 * as the published app will meet it.
 *
 * It keeps chain id 1, so the app and the suite treat it as Ethereum, and
 * the suite's global setup knows it from `web3_clientVersion` and uses fresh
 * keys and the fork as its own relay. Never point anything holding a real
 * key at it: a transaction signed for chain 1 here is valid on Ethereum.
 *
 * The base fee is today's. To rehearse a quiet hour (Help run the network is
 * skipped when gas is dear), lower it on this fork alone, before a run:
 *
 *   cast rpc anvil_setNextBlockBaseFeePerGas 100000000 --rpc-url http://127.0.0.1:8547
 */

import { spawn } from "node:child_process";
import { resolvedEnv } from "../scripts/env.mjs";

const env = resolvedEnv();
const upstream = env.SPDEX_FORK_RPC_URL;
if (!upstream) {
  console.error("SPDEX_FORK_RPC_URL is not set: the fork needs an Ethereum endpoint to fork from (.env.local).");
  process.exit(2);
}
const port = env.SPDEX_SMOKE_FORK_PORT ?? "8547";
console.log(`Forking Ethereum's latest block on http://127.0.0.1:${port} (chain id 1).`);
console.log(`For the suite: SPDEX_SMOKE_RPC_URL=http://127.0.0.1:${port}`);
const anvil = spawn("anvil", ["--fork-url", upstream, "--port", port, "--silent"], { stdio: "inherit" });
anvil.on("error", (error) => {
  console.error(`anvil failed to start: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => anvil.kill("SIGTERM"));
anvil.on("close", (code) => process.exit(code ?? 0));
