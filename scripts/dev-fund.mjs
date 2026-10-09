#!/usr/bin/env node
/**
 * Fund an address on the local fork so you can actually trade.
 *
 * ETH is all you need to start: spDEX trades it directly. The fork gives
 * anvil's own accounts 10,000 ETH each; this gives any address — including a
 * MetaMask account anvil has never heard of — ether by setting its balance,
 * and WETH by impersonating it to wrap, for trying the ERC-20 side (a token
 * sale's permission step) without a swap first.
 *
 * Fork-only by construction: every method it uses (anvil_setBalance,
 * anvil_impersonateAccount) exists solely on a development node. Pointed at a
 * real endpoint it fails immediately rather than doing anything.
 *
 *   node scripts/dev-fund.mjs                      # anvil account 0
 *   node scripts/dev-fund.mjs 0xYourMetaMaskAddr   # your own wallet
 *   node scripts/dev-fund.mjs 0xYou --eth 50 --weth 10
 *
 * Amounts are *added* to whatever the address already holds.
 */

import process from "node:process";
import { resolvedEnv } from "./env.mjs";

const env = resolvedEnv();
const RPC = env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const DEPOSIT = "0xd0e30db0"; // deposit()
const BALANCE_OF = "0x70a08231"; // balanceOf(address)

let id = 0;
async function rpc(method, params = []) {
  let response;
  try {
    response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
  } catch {
    throw new Error(`No node reachable at ${RPC}. Start one with \`pnpm anvil:fork\`.`);
  }
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const hex = (v) => `0x${v.toString(16)}`;
const pad = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const ether = (n) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function waitForReceipt(hash, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`${label} reverted`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} was not mined`);
}

const target = (process.argv[2]?.startsWith("0x") ? process.argv[2] : null) ??
  (await rpc("eth_accounts"))[0];
/** Added to the current balance, not substituted for it. */
const ethAmount = ether(flag("eth", "100"));
const wethAmount = ether(flag("weth", "10"));

if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
  console.error(`Not an address: ${target}`);
  process.exit(1);
}

const chainId = Number.parseInt(await rpc("eth_chainId"), 16);
const block = Number.parseInt(await rpc("eth_blockNumber"), 16);
console.log(`node      ${RPC}  (chain ${chainId}, block ${block})`);
console.log(`funding   ${target}`);

// Additive, never destructive.
//
// anvil_setBalance *sets* rather than adds, so passing the requested amount
// directly can silently reduce a balance. It did: running this against anvil's
// first account cut it from 10,000 ETH to 110 and broke a test that wraps
// 1,000 WETH. A funding tool that can leave you poorer is a trap.
const existing = BigInt(await rpc("eth_getBalance", [target, "latest"]));
await rpc("anvil_setBalance", [target, hex(existing + ethAmount + wethAmount)]);

// Impersonation is what lets this work for a wallet anvil did not create —
// your MetaMask account has no key here, but the node will act as it anyway.
await rpc("anvil_impersonateAccount", [target]);
try {
  const hash = await rpc("eth_sendTransaction", [
    { from: target, to: WETH, value: hex(wethAmount), data: DEPOSIT, gas: hex(120_000n) },
  ]);
  await waitForReceipt(hash, "wrapping ETH");
} finally {
  await rpc("anvil_stopImpersonatingAccount", [target]);
}

const ethBalance = BigInt(await rpc("eth_getBalance", [target, "latest"]));
const wethBalance = BigInt(
  await rpc("eth_call", [{ to: WETH, data: BALANCE_OF + pad(target) }, "latest"]),
);

const show = (v) => (Number(v) / 1e18).toFixed(4);
console.log(`\n  ETH   ${show(ethBalance)}`);
console.log(`  WETH  ${show(wethBalance)}`);
console.log(`\nReady. Open the app, connect this address, and swap WETH for SPX.`);
