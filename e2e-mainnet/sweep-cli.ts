/**
 * `pnpm mainnet:smoke:sweep <your address> [--send]`: give back everything
 * the agent wallets hold, but the holder agent's SPX. It closes any vault an
 * agent owns that still holds something, on every release's factory (its
 * WETH comes back to that agent as ETH), sends each agent's SPX and WETH to
 * the address, then its ether, all but the last transfer's network fee.
 *
 * The holder agent's SPX stays where it is, and the sweep says so: it is the
 * 690 SPX the wallets' owner sent it to be a community keeper, and nothing in
 * this suite moves it (decision 33). Sending it back is the owner's own
 * transaction, by hand (docs/MAINNET-SMOKE.md, "Giving the ether back").
 *
 * Without `--send` it only says what it would do. It refuses a fork unless
 * told `--fork`, which is for rehearsing it with throwaway keystores (a
 * `SPDEX_SMOKE_HOME` of their own): nothing in a sweep pays anyone but the
 * address given, so a fork's copy of it is harmless, but on a fork it moves
 * nothing real either.
 */

import { encodeErc20Transfer } from "../packages/core/src/index.js";
import {
  addressOfKey,
  prepareTransaction,
  signPrepared,
  type JsonRpc,
  type PreparedTransaction,
} from "../packages/chain/src/index.js";
import {
  DEPLOYMENTS,
  MAINNET_DEPLOYMENT,
  SPX_TOKEN,
  encodeClose,
  readVault,
  readVaultCount,
  readVaultsPage,
} from "../packages/vault/src/index.js";
import { resolvedEnv } from "../scripts/env.mjs";
import { openKeystore } from "./keys.js";
import { smokeRpc } from "./rpc.js";
import { AGENT_NAMES, GWEI, HOLDER, eth, smokeHome } from "./settings.js";

type Hex = `0x${string}`;

const SPX = SPX_TOKEN.toLowerCase() as Hex;
const WETH = MAINNET_DEPLOYMENT.weth.toLowerCase() as Hex;
/** Every release's factory, oldest first: a v1 vault an earlier run left open is closed too. */
const FACTORIES = DEPLOYMENTS.map((d) => d.factory.toLowerCase() as Hex);
const TIP = GWEI / 20n;

const args = process.argv.slice(2);
const to = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase() as Hex | undefined;
const send = args.includes("--send");
const forkAllowed = args.includes("--fork");
if (!to) {
  console.error("usage: pnpm mainnet:smoke:sweep <your address> [--send] [--fork]");
  process.exit(2);
}
const env = resolvedEnv();
if (!env["SPDEX_SMOKE_RPC_URL"]) {
  console.error("SPDEX_SMOKE_RPC_URL is not set (docs/MAINNET-SMOKE.md)");
  process.exit(2);
}
const rpc: JsonRpc = smokeRpc(env["SPDEX_SMOKE_RPC_URL"]);

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const balanceOf = async (token: Hex, owner: Hex) =>
  BigInt((await rpc("eth_call", [{ to: token, data: `0x70a08231${word(owner)}` }, "latest"])) as string);

if (Number(BigInt((await rpc("eth_chainId", [])) as string)) !== 1) throw new Error("not Ethereum (chain 1)");
if (/^anvil\//i.test((await rpc("web3_clientVersion", [])) as string) && !forkAllowed) {
  throw new Error("this is a fork: the sweep is for the real wallets, on Ethereum (--fork rehearses it with throwaway ones)");
}

const home = smokeHome(env);
const agents = AGENT_NAMES.map((name) => ({ name, key: openKeystore(home, name) }));
const byAddress = new Map(agents.map((a) => [addressOfKey(a.key).toLowerCase() as Hex, a]));
if (byAddress.has(to)) throw new Error(`${to} is an agent wallet: sweep to your own address`);

/** At least TIP over the base fee; mined when the network has room. */
function tipped(tx: PreparedTransaction): PreparedTransaction {
  if (tx.fees.type !== "eip1559" || tx.fees.maxPriorityFeePerGas >= TIP) return tx;
  return { ...tx, fees: { type: "eip1559", maxFeePerGas: tx.fees.maxFeePerGas - tx.fees.maxPriorityFeePerGas + TIP, maxPriorityFeePerGas: TIP } };
}

async function sendAndWait(key: Hex, tx: PreparedTransaction, what: string): Promise<void> {
  if (!send) {
    console.log(`  would ${what}`);
    return;
  }
  const signed = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [signed.raw]);
  process.stdout.write(`  ${what}: ${signed.hash} `);
  for (;;) {
    const receipt = (await rpc("eth_getTransactionReceipt", [signed.hash])) as { status: string } | null;
    if (receipt) {
      console.log(BigInt(receipt.status) === 1n ? "mined" : "REVERTED");
      return;
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
}

// Vaults first: closing one sends its WETH to its owner, as ETH, for the steps after.
for (const factory of FACTORIES) {
  const factoryDeployed = ((await rpc("eth_getCode", [factory, "latest"])) as string) !== "0x";
  const count = factoryDeployed ? await readVaultCount(rpc, factory) : 0n;
  for (let offset = 0n; offset < count; offset += 1_000n) {
    for (const vault of await readVaultsPage(rpc, factory, offset, 1_000n)) {
      const state = await readVault(rpc, vault, { factory });
      const owner = state === null ? undefined : byAddress.get(state.owner.toLowerCase() as Hex);
      if (!state || !owner || state.closed || state.status.wethBalance === 0n) continue;
      const from = addressOfKey(owner.key) as Hex;
      const tx = tipped(await prepareTransaction(rpc, { from, to: vault.toLowerCase() as Hex, data: encodeClose(), value: 0n, chainId: 1 }));
      await sendAndWait(owner.key, tx, `close ${owner.name}'s vault ${vault} (${eth(state.status.wethBalance)} WETH back as ETH)`);
    }
  }
}

for (const agent of agents) {
  const from = addressOfKey(agent.key).toLowerCase() as Hex;
  console.log(`${agent.name} ${from}`);
  for (const [token, name] of [
    [SPX, "SPX"],
    [WETH, "WETH"],
  ] as const) {
    const amount = await balanceOf(token, from);
    if (amount === 0n) continue;
    if (agent.name === HOLDER && token === SPX) {
      console.log(
        `  leaves its ${amount} base units of SPX where they are: the holder agent's SPX never leaves it in this suite. ` +
          "Send it back yourself if you are retiring the agents (docs/MAINNET-SMOKE.md).",
      );
      continue;
    }
    const tx = tipped(await prepareTransaction(rpc, { from, to: token, data: encodeErc20Transfer(to, amount), value: 0n, chainId: 1 }));
    await sendAndWait(agent.key, tx, `send ${amount} base units of ${name} to ${to}`);
  }
  // The ether last, as one legacy transfer that pays exactly its fee: a type-2
  // one would leave its unused fee ceiling behind as a refund.
  const balance = BigInt((await rpc("eth_getBalance", [from, "pending"])) as string);
  if (balance === 0n) {
    console.log("  holds no ETH");
    continue;
  }
  const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas: string };
  const gasPrice = (BigInt(block.baseFeePerGas) * 5n) / 4n + TIP;
  const gas = BigInt((await rpc("eth_estimateGas", [{ from, to, value: "0x1" }])) as string);
  if (balance <= gas * gasPrice) {
    console.log(`  ${eth(balance)} ETH: less than sending it would cost`);
    continue;
  }
  const nonce = Number(BigInt((await rpc("eth_getTransactionCount", [from, "pending"])) as string));
  const tx: PreparedTransaction = { from, chainId: 1, nonce, to, data: "0x", value: balance - gas * gasPrice, gas, fees: { type: "legacy", gasPrice } };
  await sendAndWait(agent.key, tx, `send ${eth(tx.value)} ETH to ${to}`);
}
if (!send) console.log("\nNothing was sent. Run again with --send to do it.");
