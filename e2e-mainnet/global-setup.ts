/**
 * Before any spec runs: decide what kind of run this is, refuse one that
 * isn't safe to start, and hand the specs its agents.
 *
 * - The endpoint must be chain 1. anvil (`web3_clientVersion`) makes it a
 *   **fork run**: three fresh keys funded with `anvil_setBalance`, the factory
 *   and batcher deployed if the fork lacks them, and the fork itself as the
 *   private relay. Anything else is a **mainnet run**, refused unless
 *   `SPDEX_SMOKE_MAINNET=yes`: the agents are the keystores, the contracts must
 *   already be deployed, and the ledger's last 24 hours must leave room.
 * - A fork never uses the keystores or a public relay. A chain-1 transaction
 *   signed on a fork is a valid Ethereum transaction: signed by a funded key
 *   and posted anywhere real, it would run there.
 * - Nothing starts while the base fee is above `SPDEX_SMOKE_MAX_BASE_FEE_GWEI`.
 */

import { mkdirSync } from "node:fs";
import { addressOfKey, generateSpendingKey, prepareTransaction, signPrepared } from "../packages/chain/src/index.js";
import { deployBatcherCall, deployFactoryCall, readVaultCount } from "../packages/vault/src/index.js";
import { lastDaySpent } from "./budget.js";
import { BATCHER, FACTORY, baseFee, ethBalance, hasCode, isFork, minedReceipt, rpc, settings } from "./chain.js";
import { openKeystore } from "./keys.js";
import { AGENT_NAMES, ETHER, RUNS_DIR, RUN_ENV, eth, gwei, type SmokeRun } from "./settings.js";

type Hex = `0x${string}`;

/** What each fork agent starts with: far more than a run spends, and nothing real. */
const FORK_FUNDING = ETHER;

async function freshForkKey(): Promise<{ address: Hex; key: Hex }> {
  const key = generateSpendingKey() as Hex;
  const address = addressOfKey(key).toLowerCase() as Hex;
  const [nonce, code, balance] = (await Promise.all([
    rpc("eth_getTransactionCount", [address, "latest"]),
    rpc("eth_getCode", [address, "latest"]),
    rpc("eth_getBalance", [address, "latest"]),
  ])) as string[];
  if (BigInt(nonce!) !== 0n || code !== "0x" || BigInt(balance!) !== 0n) throw new Error(`${address} is not a fresh address; refusing to set its balance`);
  await rpc("anvil_setBalance", [address, `0x${FORK_FUNDING.toString(16)}`]);
  return { address, key };
}

/** Deploy the factory and the batcher on a fork that has neither, as docs/RELEASE.md's runbook does on Ethereum. */
async function deployOnFork(from: { address: Hex; key: Hex }): Promise<void> {
  for (const [call, at] of [
    [deployFactoryCall(), FACTORY],
    [deployBatcherCall(FACTORY), BATCHER],
  ] as const) {
    if (await hasCode(at)) continue;
    const prepared = await prepareTransaction(rpc, { from: from.address, to: call.to, data: call.data, value: call.value, chainId: 1 });
    const signed = await signPrepared(from.key, prepared);
    await rpc("eth_sendRawTransaction", [signed.raw]);
    await minedReceipt(signed.hash, 60_000);
    if (!(await hasCode(at))) throw new Error(`nothing at ${at} after deploying it on the fork`);
  }
}

export default async function globalSetup(): Promise<void> {
  const chainId = Number(BigInt((await rpc("eth_chainId", [])) as string));
  if (chainId !== 1) throw new Error(`SPDEX_SMOKE_RPC_URL is chain ${chainId}: this suite runs on Ethereum, or on a fork of it that keeps chain id 1`);
  const fork = await isFork();
  if (!fork && !settings.mainnetAllowed) {
    throw new Error(
      "SPDEX_SMOKE_RPC_URL is not a fork, so this run would spend real ether. Set SPDEX_SMOKE_MAINNET=yes to allow it (docs/MAINNET-SMOKE.md).",
    );
  }
  if (fork && settings.relayUrl !== null && settings.relayUrl !== settings.rpcUrl) {
    throw new Error(
      "SPDEX_SMOKE_RELAY_URL is set on a fork run. A fork's relay is the fork: a transaction signed here is valid on Ethereum, and a real relay would try it there.",
    );
  }

  const fee = await baseFee();
  if (fee > settings.maxBaseFeeWei) {
    throw new Error(`the base fee is ${gwei(fee)} gwei, above SPDEX_SMOKE_MAX_BASE_FEE_GWEI (${gwei(settings.maxBaseFeeWei)}): run again when it is lower`);
  }

  const agents = {} as SmokeRun["agents"];
  if (fork) {
    for (const name of AGENT_NAMES) agents[name] = await freshForkKey();
    if (!(await hasCode(FACTORY)) || !(await hasCode(BATCHER))) await deployOnFork(agents.keeper as { address: Hex; key: Hex });
  } else {
    if (!(await hasCode(FACTORY)) || !(await hasCode(BATCHER))) {
      throw new Error(`the factory (${FACTORY}) or the batcher (${BATCHER}) has no code on this chain: deploy them first (docs/RELEASE.md)`);
    }
    for (const name of AGENT_NAMES) agents[name] = { address: addressOfKey(openKeystore(settings.home, name)).toLowerCase() as Hex };
    const spent = lastDaySpent(settings);
    if (spent >= settings.maxDayWei) {
      throw new Error(`the last 24 hours' runs spent ${eth(spent)} ETH, SPDEX_SMOKE_MAX_DAY_ETH (${eth(settings.maxDayWei)}): nothing more today`);
    }
  }

  const startBalances = {} as SmokeRun["startBalances"];
  for (const name of AGENT_NAMES) startBalances[name] = (await ethBalance(agents[name].address)).toString();
  if (!fork) {
    const empty = AGENT_NAMES.filter((name) => BigInt(startBalances[name]) === 0n);
    if (empty.length > 0) throw new Error(`these agents hold no ether: ${empty.map((n) => `${n} ${agents[n].address}`).join(", ")}`);
  }

  const run: SmokeRun = {
    id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${fork ? "fork" : "mainnet"}`,
    mode: fork ? "fork" : "mainnet",
    relayUrl: fork ? settings.rpcUrl : settings.relayUrl,
    startVaultCount: (await readVaultCount(rpc, FACTORY)).toString(),
    agents,
    startBalances,
  };
  mkdirSync(RUNS_DIR, { recursive: true });
  process.env[RUN_ENV] = JSON.stringify(run);

  const lines = [
    `spDEX mainnet smoke: ${run.mode === "fork" ? "FORK run (nothing real)" : "MAINNET run (real ether)"} ${run.id}`,
    `  app        ${settings.baseUrl}`,
    `  base fee   ${gwei(fee)} gwei (limit ${gwei(settings.maxBaseFeeWei)}), tip ${gwei(settings.tipWei)} gwei`,
    `  budget     ${eth(settings.maxRunWei)} ETH this run${fork ? "" : `, ${eth(settings.maxDayWei - lastDaySpent(settings))} ETH left today`}`,
    `  relay      ${run.mode === "fork" ? "the fork itself" : (run.relayUrl === null ? "none: Help run the network is skipped" : new URL(run.relayUrl).host)}`,
    ...AGENT_NAMES.map((name) => `  ${name.padEnd(10)} ${agents[name].address}  ${eth(BigInt(startBalances[name]))} ETH`),
  ];
  console.log(lines.join("\n"));
}
