/**
 * Before any spec runs: decide what kind of run this is, refuse one that
 * isn't safe to start, and hand the specs its agents.
 *
 * - The endpoint must be chain 1. anvil (`web3_clientVersion`) makes it a
 *   **fork run**: three fresh keys funded with `anvil_setBalance`, each
 *   release's contracts deployed if the fork lacks them (v2's registry,
 *   factory and the batcher bound to no factory: today's chain has only
 *   v1's), and the fork itself as
 *   the private relay. Anything else is a **mainnet run**, refused unless
 *   `SPDEX_SMOKE_MAINNET=yes`: the agents are the keystores, v2's contracts
 *   must already be deployed, the holder agent must hold its 690 SPX, and the
 *   ledger's last 24 hours must leave room.
 * - The holder agent (`HOLDER`, the helper) is paid inside v2's community
 *   windows, so it holds 690 SPX and is proven in the registry. On mainnet the
 *   wallets' owner sends it the SPX once, by hand, and `3-prove` proves it. On
 *   a fork neither can happen for real: a fresh key never held SPX at a block
 *   anyone can prove, and anvil can't prove the blocks it mines. So a fork run
 *   writes both, and nothing else, with `anvil_setStorageAt`: its SPX balance
 *   (690 SPX) and its registry record (`validUntil`, as if it had just
 *   proven), then checks the registry finds it eligible. To still rehearse the
 *   registry's real transaction, a fork run finds a real account that held 690
 *   SPX at the fork's `finalized` block (`rehearsalHolder`), which `3-prove`
 *   proves through the page.
 * - A fork never uses the keystores or a public relay. A chain-1 transaction
 *   signed on a fork is a valid Ethereum transaction: signed by a funded key
 *   and posted anywhere real, it would run there.
 * - Nothing starts while the base fee is above `SPDEX_SMOKE_MAX_BASE_FEE_GWEI`.
 */

import { mkdirSync } from "node:fs";
import { addressOfKey, generateSpendingKey, prepareTransaction, signPrepared } from "../packages/chain/src/index.js";
import { DEPLOYMENTS, MIN_SPX, PROOF_TTL, deployReleaseCalls, readVaultCount, spxBalanceSlot } from "../packages/vault/src/index.js";
import { lastDaySpent } from "./budget.js";
import {
  BATCHER,
  FACTORIES,
  FACTORY,
  REGISTRY,
  SPX,
  baseFee,
  chainTime,
  ethBalance,
  hasCode,
  holderStatus,
  isFork,
  minedReceipt,
  rpc,
  settings,
  tokenBalance,
} from "./chain.js";
import { openKeystore } from "./keys.js";
import { AGENT_NAMES, ETHER, HOLDER, RUNS_DIR, RUN_ENV, eth, gwei, type SmokeRun } from "./settings.js";

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

/**
 * Deploy whatever each release's contracts the fork lacks, every release in
 * `DEPLOYMENTS`, oldest first, in the order their constructors need
 * (`deployReleaseCalls`: v1's factory and its own batcher; v2's registry,
 * factory and the batcher bound to no factory, built for WETH, which later
 * releases share), as docs/RELEASE.md's runbook does on Ethereum. Today's
 * chain has v1's; v2's are deployed here until it reaches mainnet.
 */
async function deployOnFork(from: { address: Hex; key: Hex }): Promise<void> {
  for (const { id: release } of DEPLOYMENTS) {
    for (const call of deployReleaseCalls(release)) {
      if (await hasCode(call.address)) continue;
      const prepared = await prepareTransaction(rpc, { from: from.address, to: call.to, data: call.data, value: call.value, chainId: 1 });
      const signed = await signPrepared(from.key, prepared);
      await rpc("eth_sendRawTransaction", [signed.raw]);
      await minedReceipt(signed.hash, 60_000);
      if (!(await hasCode(call.address))) throw new Error(`nothing at ${call.address} after deploying ${release}'s ${call.name} on the fork`);
    }
  }
}

const word = (value: bigint | string) => (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "").toLowerCase()).padStart(64, "0");

/**
 * Fork only: give the holder agent 690 SPX and a registry record, the two
 * storage writes a fork run makes (the file comment says why), and check
 * that the registry then finds it eligible. Refuses an address that already
 * holds SPX or has a record: only a fresh key is ever written.
 */
async function makeHolderOnFork(holder: Hex): Promise<void> {
  if ((await tokenBalance(SPX, holder)) !== 0n) throw new Error(`${holder} already holds SPX: only a fresh key is ever written a balance`);
  // SPX's balances are its mapping at slot 1 (the registry's BALANCE_SLOT).
  await rpc("anvil_setStorageAt", [SPX, spxBalanceSlot(holder), `0x${word(MIN_SPX)}`]);
  // The registry's validUntil is its mapping at slot 0: keccak256(abi.encode(holder, 0)), hashed by anvil itself.
  const slot = (await rpc("web3_sha3", [`0x${word(holder)}${word(0n)}`])) as Hex;
  const before = await holderStatus(holder);
  if (before.validUntil !== 0n) throw new Error(`${holder} already has a registry record: only a fresh key is ever written one`);
  const validUntil = (await chainTime()) + PROOF_TTL;
  await rpc("anvil_setStorageAt", [REGISTRY, slot, `0x${word(validUntil)}`]);
  const after = await holderStatus(holder);
  if (after.eligible !== true || after.validUntil !== validUntil || after.balance !== MIN_SPX) {
    throw new Error(`the holder agent ${holder} isn't eligible on the fork after its SPX and record were written (eligible ${after.eligible}, validUntil ${after.validUntil}, SPX ${after.balance})`);
  }
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Fork only: a real account (no code) that held at least 690 SPX at the
 * fork's `finalized` block and holds it now, for `3-prove` to prove through
 * the page. Looked for among the accounts in SPX's transfers in the 600
 * blocks up to `finalized`, newest first, ten blocks a request (a free plan's
 * limit on log searches). One an earlier rehearsal on this fork proved will
 * do: a proof of a later block moves its `validUntil`. Null when none
 * qualifies: `3-prove` then says what it couldn't rehearse.
 */
async function findRehearsalHolder(): Promise<Hex | null> {
  const finalized = BigInt(((await rpc("eth_getBlockByNumber", ["finalized", false])) as { number: string }).number);
  const tried = new Set<string>();
  for (let last = finalized; last > finalized - 600n; last -= 10n) {
    const logs = (await rpc("eth_getLogs", [
      { fromBlock: `0x${(last - 9n).toString(16)}`, toBlock: `0x${last.toString(16)}`, address: SPX, topics: [TRANSFER_TOPIC] },
    ])) as { topics: string[] }[];
    for (const log of logs.reverse()) {
      for (const topic of [log.topics[2], log.topics[1]]) {
        const who = `0x${(topic ?? "").slice(26)}`.toLowerCase() as Hex;
        if (who.length !== 42 || tried.has(who)) continue;
        tried.add(who);
        const status = await holderStatus(who);
        if (status.isAccount !== true || status.balance === null || status.balance < MIN_SPX) continue;
        const raw = (await rpc("eth_call", [{ to: SPX, data: `0x70a08231${word(who)}` }, `0x${finalized.toString(16)}`])) as string;
        if (/^0x[0-9a-f]{64}$/i.test(raw) && BigInt(raw) >= MIN_SPX) return who;
      }
    }
  }
  return null;
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
  let rehearsalHolder: Hex | null = null;
  if (fork) {
    for (const name of AGENT_NAMES) agents[name] = await freshForkKey();
    await deployOnFork(agents.keeper as { address: Hex; key: Hex });
    await makeHolderOnFork(agents[HOLDER].address);
    rehearsalHolder = await findRehearsalHolder();
  } else {
    for (const [what, at] of [
      ["SPX holder registry", REGISTRY],
      ["factory", FACTORY],
      ["batcher", BATCHER],
    ] as const) {
      if (!(await hasCode(at))) throw new Error(`v2's ${what} (${at}) has no code on this chain: deploy it first (docs/RELEASE.md)`);
    }
    for (const name of AGENT_NAMES) agents[name] = { address: addressOfKey(openKeystore(settings.home, name)).toLowerCase() as Hex };
    const spent = lastDaySpent(settings);
    if (spent >= settings.maxDayWei) {
      throw new Error(`the last 24 hours' runs spent ${eth(spent)} ETH, SPDEX_SMOKE_MAX_DAY_ETH (${eth(settings.maxDayWei)}): nothing more today`);
    }
  }

  // The holder agent, before anything is signed: an ordinary account with its
  // 690 SPX. The suite never buys it SPX; on mainnet the wallets' owner sends it.
  const holder = await holderStatus(agents[HOLDER].address);
  if (holder.isAccount !== true) throw new Error(`the holder agent (${HOLDER} ${holder.holder}) is not an ordinary account, so it can never be paid as a community keeper`);
  if (holder.balance === null || holder.balance < MIN_SPX) {
    throw new Error(
      `the holder agent (${HOLDER} ${holder.holder}) holds ${holder.balance === null ? "an unreadable amount of" : `${holder.balance / 10n ** 8n}`} SPX, under the 690 a community keeper holds: ` +
        "send it 690 SPX once, from your own wallet (docs/MAINNET-SMOKE.md, Setting up)",
    );
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
    startVaultCounts: Object.fromEntries(
      await Promise.all(FACTORIES.map(async (factory) => [factory, (await hasCode(factory)) ? (await readVaultCount(rpc, factory)).toString() : "0"])),
    ),
    agents,
    startBalances,
    rehearsalHolder,
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
    `  holder     ${HOLDER}: ${holder.balance / 10n ** 8n} SPX, ${
      holder.validUntil === null ? "its proof unread" : holder.validUntil === 0n ? "not proven yet (3-prove proves it)" : `proven until ${new Date(Number(holder.validUntil) * 1000).toISOString()}`
    }${fork ? ", both written on the fork" : ""}`,
    ...(fork ? [`  rehearsal  ${rehearsalHolder === null ? "no real holder found: 3-prove can't rehearse the registry's transaction" : `3-prove proves ${rehearsalHolder}, a real holder`}`] : []),
  ];
  console.log(lines.join("\n"));
}
