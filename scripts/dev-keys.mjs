#!/usr/bin/env node
/**
 * Print the local fork's test accounts and their private keys.
 *
 * `pnpm anvil:fork` runs anvil with --silent, so the account list it normally
 * prints at startup is hidden. This brings it back on demand.
 *
 * These keys are not secret and were never meant to be: anvil derives them from
 * a published mnemonic, so they are identical on every machine running it and
 * are freely available online. That is fine for a fork and catastrophic
 * anywhere else — anything sent to these addresses on a real network is gone
 * immediately, because thousands of bots watch them.
 *
 * Each key is checked against the address the node actually reports, so a fork
 * started with a different mnemonic prints a warning rather than a wrong key.
 */

import process from "node:process";
import { resolvedEnv } from "./env.mjs";

const RPC = resolvedEnv()["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";

/** anvil's default mnemonic: "test test test test test test test test test test test junk". */
const KNOWN = [
  ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
  ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"],
  ["0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"],
  ["0x90f79bf6eb2c4f870365e785982e1f101e93b906", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"],
  ["0x15d34aaf54267db7d7c367839aaf71a00a2c6a65", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"],
];

async function rpc(method, params = []) {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  } catch {
    throw new Error(`No node reachable at ${RPC}. Start one with \`pnpm anvil:fork\`.`);
  }
}

const accounts = await rpc("eth_accounts");
const chainId = Number.parseInt(await rpc("eth_chainId"), 16);

console.log(`\nFork at ${RPC}  (chain ${chainId})\n`);
console.log("\x1b[33mThese keys are PUBLIC.\x1b[0m anvil derives them from a published mnemonic, so");
console.log("they are the same for everyone. Never send real funds to these addresses.\n");

for (const [index, address] of accounts.slice(0, KNOWN.length).entries()) {
  const known = KNOWN[index];
  const balance = BigInt(await rpc("eth_getBalance", [address, "latest"]));
  const eth = (Number(balance) / 1e18).toFixed(2);

  if (!known || known[0] !== address.toLowerCase()) {
    // A fork started with a custom mnemonic: printing the default key here
    // would hand over a key that does not control this account.
    console.log(`[${index}] ${address}  ${eth} ETH`);
    console.log(`     key unknown — this fork uses a non-default mnemonic\n`);
    continue;
  }

  console.log(`[${index}] ${address}  ${eth} ETH`);
  console.log(`     ${known[1]}\n`);
}

console.log(`Import one into MetaMask, or skip the import entirely:`);
console.log(`  pnpm dev:fund 0xYourOwnAddress\n`);
