/**
 * The agent wallets, and the one way anything they sign leaves.
 *
 * The page gets the repo's headless wallet (packages/testing/src/wallet.ts),
 * and every request it makes of the endpoint is intercepted, as e2e/vaults.ts
 * does on the fork: `eth_sendTransaction` is priced, checked, signed here with
 * the agent's key and sent raw; `eth_signTransaction` (private sending) is
 * checked and signed exactly as asked; and a raw transaction the page posts,
 * to the endpoint or to its relay, goes out only if it is one signed and
 * checked here. Typed data is refused outright (4200), so a tip never asks for
 * a Permit2 signature: the app falls back to plain transfers.
 *
 * Checked means three things, before the key is used:
 *
 * 1. **Where it goes.** A Uniswap router, the factory, a vault the factory
 *    vouches for (`isVault`) and an agent owns, the batcher with only this run's own vaults and
 *    an agent as `rewardTo`, an agent wallet, or SPX or WETH for an
 *    approval to a router, a transfer to an agent, or a wrap. Anything else is
 *    refused: a build that tried to send elsewhere fails the run instead.
 * 2. **What it bids.** At most twice `SPDEX_SMOKE_MAX_BASE_FEE_GWEI` plus the
 *    tip per gas, so nothing is signed while gas is dear. A page's send is
 *    signed at the fees the page suggested, as a wallet's "site suggested"
 *    setting does, and a private one at the price the page asked: both are the
 *    app's own choice, and what is being tested. What the harness prices
 *    itself bids at least `SPDEX_SMOKE_TIP_GWEI`, because an endpoint's
 *    `eth_maxPriorityFeePerGas` may say 1 wei (Alchemy's does), and a
 *    transaction bidding that may wait for a long time.
 * 3. **The budget** (budget.ts): its value and its gas limit at that price must
 *    fit the run's and the day's limits.
 */

import type { BrowserContext, Route } from "@playwright/test";
import {
  addressOfKey,
  prepareTransaction,
  signPrepared,
  transactionHash,
  type PreparedTransaction,
} from "../packages/chain/src/index.js";
import { headlessWalletScript } from "../packages/testing/src/wallet.js";
import { encodeExecuteBatch, readVault, readVaultCount, readVaultOwners, readVaultsPage } from "../packages/vault/src/index.js";
import { reserve, runRecord, settle } from "./budget.js";
import { BATCHER, FACTORY, ROUTERS, SPX, WETH, feeOf, headBlock, isVault, minedReceipt, receiptOf, rpc, settings, type Receipt } from "./chain.js";
import { openKeystore } from "./keys.js";
import { AGENT_NAMES, currentRun, eth, feeRateCap, gwei, type AgentName } from "./settings.js";

type Hex = `0x${string}`;

export interface Agent {
  name: AgentName;
  address: Hex;
  key: Hex;
}

let cached: Record<AgentName, Agent> | null = null;

/** The run's three agents: a fork's throwaway keys, or the keystores' on mainnet. */
export function agents(): Record<AgentName, Agent> {
  if (cached) return cached;
  const run = currentRun();
  const found = {} as Record<AgentName, Agent>;
  for (const name of AGENT_NAMES) {
    const key = run.mode === "fork" ? run.agents[name].key! : openKeystore(settings.home, name);
    const address = addressOfKey(key).toLowerCase() as Hex;
    if (address !== run.agents[name].address) throw new Error(`the ${name} key does not belong to ${run.agents[name].address}`);
    found[name] = { name, address, key };
  }
  return (cached = found);
}

/** The agents' addresses, known without opening a keystore. */
const agentAddresses = () => new Set<string>(Object.values(currentRun().agents).map((a) => a.address));

/**
 * Every vault an agent owns on the factory's list from index `from` on: each
 * listed vault kept when an agent is its `owner()`. Not a log search: a free
 * plan refuses one over more than a few blocks (Alchemy's, ten), and a run
 * spans dozens. An owner that can't be read throws, because a clean-up that
 * skipped one could leave a vault funded.
 */
export async function agentVaults(from = 0n): Promise<Hex[]> {
  const count = await readVaultCount(rpc, FACTORY);
  const listed: Hex[] = [];
  for (let offset = from; offset < count; offset += 1_000n) listed.push(...((await readVaultsPage(rpc, FACTORY, offset, 1_000n)) as Hex[]));
  // Read after the list, so every vault on it exists at this block.
  const owners = await readVaultOwners(rpc, listed, { block: await headBlock() });
  const unread = listed.filter((vault) => !owners.has(vault));
  if (unread.length > 0) throw new Error(`couldn't read the owner of ${unread.join(", ")}`);
  const own = agentAddresses();
  return listed.filter((vault) => own.has(owners.get(vault)!));
}

/** Every vault an agent created since the run started: listed after where the factory's list stood then. */
export const runVaults = (): Promise<Hex[]> => agentVaults(BigInt(currentRun().startVaultCount));

// ── Where it goes ────────────────────────────────────────────────────────

const SELECTOR = { approve: "0x095ea7b3", transfer: "0xa9059cbb", deposit: "0xd0e30db0", withdraw: "0x2e1a7d4d" } as const;

/** `executeBatch(address[] vaults, address rewardTo, uint256 minRewards)`'s arguments, or null for anything else. */
function readExecuteBatch(data: string): { vaults: Hex[]; rewardTo: Hex; minRewards: bigint } | null {
  try {
    const body = data.slice(10);
    const word = (i: number) => body.slice(i * 64, (i + 1) * 64);
    const at = Number(BigInt(`0x${word(0)}`) / 32n);
    const count = Number(BigInt(`0x${word(at)}`));
    if (count > 1_000) return null;
    const vaults = Array.from({ length: count }, (_, i) => `0x${word(at + 1 + i).slice(24)}` as Hex);
    const rewardTo = `0x${word(1).slice(24)}` as Hex;
    const minRewards = BigInt(`0x${word(2)}`);
    // Read back only if it encodes to exactly these bytes.
    return encodeExecuteBatch(vaults, rewardTo, minRewards).toLowerCase() === data ? { vaults, rewardTo, minRewards } : null;
  } catch {
    return null;
  }
}

/** Why the agents must not send `call`, or null when it is one this suite makes. */
export async function refusal(call: { to: string; data: string; value: bigint }): Promise<string | null> {
  const to = call.to.toLowerCase();
  const data = call.data.toLowerCase();
  const own = agentAddresses();
  if (ROUTERS.includes(to as Hex)) return null;
  if (to === FACTORY) return null;
  if (to === BATCHER) {
    const batch = readExecuteBatch(data);
    if (batch === null) return "a call to the batcher that is not an executeBatch";
    if (!own.has(batch.rewardTo)) return `a batch that pays its fees to ${batch.rewardTo}, not an agent`;
    const mine = new Set(await runVaults());
    const others = batch.vaults.filter((vault) => !mine.has(vault));
    return others.length === 0 ? null : `a batch that triggers vaults this run didn't create: ${others.join(", ")}`;
  }
  if (own.has(to)) return data === "0x" ? null : "a call, not a payment, to an agent wallet";
  if (to === SPX || to === WETH) {
    const selector = data.slice(0, 10);
    const argument = `0x${data.slice(34, 74)}`;
    if (selector === SELECTOR.approve) return ROUTERS.includes(argument as Hex) ? null : `an approval for ${argument}, not a router`;
    if (selector === SELECTOR.transfer) return own.has(argument) ? null : `a transfer to ${argument}, not an agent`;
    if (to === WETH && (selector === SELECTOR.deposit || selector === SELECTOR.withdraw)) return null;
    return `a token call this suite doesn't make (${selector})`;
  }
  if (await isVault(to)) {
    // Funding, triggering or closing: only a vault an agent owns.
    const state = await readVault(rpc, to as Hex, { factory: FACTORY });
    return state !== null && own.has(state.owner.toLowerCase()) ? null : `${to} is a vault no agent owns`;
  }
  return `${to} is not a contract this suite uses`;
}

// ── What it bids ─────────────────────────────────────────────────────────

/** At least the settings' tip, the doubled base fee kept as the room above it; and never above the rate cap. */
function priced(prepared: PreparedTransaction, what: string): PreparedTransaction {
  let tx = prepared;
  if (tx.fees.type === "eip1559" && tx.fees.maxPriorityFeePerGas < settings.tipWei) {
    const doubledBase = tx.fees.maxFeePerGas - tx.fees.maxPriorityFeePerGas;
    tx = { ...tx, fees: { type: "eip1559", maxFeePerGas: doubledBase + settings.tipWei, maxPriorityFeePerGas: settings.tipWei } };
  }
  const rate = tx.fees.type === "eip1559" ? tx.fees.maxFeePerGas : tx.fees.gasPrice;
  if (rate > feeRateCap(settings)) {
    throw new Error(`${what}: bids ${gwei(rate)} gwei a gas, above the ${gwei(feeRateCap(settings))} SPDEX_SMOKE_MAX_BASE_FEE_GWEI allows`);
  }
  return tx;
}

const maxFeePerGasOf = (tx: PreparedTransaction) => (tx.fees.type === "eip1559" ? tx.fees.maxFeePerGas : tx.fees.gasPrice);

/**
 * Check, price, sign, reserve and send one transaction from `agent`.
 * Returns its hash once the endpoint has it; nothing waits for the block.
 */
export async function sendFrom(
  agent: Agent,
  call: { to: Hex; data: Hex; value: bigint; gas?: bigint; fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } },
  what: string,
): Promise<Hex> {
  const reason = await refusal(call);
  if (reason !== null) throw new Error(`${what}: refused, ${reason}`);
  let tx = await prepareTransaction(rpc, {
    from: agent.address,
    to: call.to,
    data: call.data,
    value: call.value,
    chainId: 1,
    feeRateCeiling: feeRateCap(settings),
  });
  if (call.gas !== undefined) tx = { ...tx, gas: call.gas };
  if (call.fees !== undefined) tx = { ...tx, fees: { type: "eip1559", ...call.fees } };
  tx = priced(tx, what);
  const signed = await signPrepared(agent.key, tx);
  const hash = signed.hash.toLowerCase() as Hex;
  reserve(settings, {
    what,
    wallet: agent.name,
    hash,
    to: call.to.toLowerCase(),
    value: call.value.toString(),
    maxCost: (call.value + tx.gas * maxFeePerGasOf(tx)).toString(),
  });
  await rpc("eth_sendRawTransaction", [signed.raw]);
  return hash;
}

/** How long to wait for a block: a fork mines at once; mainnet may take a few. */
export const MINED_WITHIN_MS = () => (currentRun().mode === "fork" ? 60_000 : 600_000);

/** `sendFrom`, then wait for it to be mined, record what it cost, and return its receipt. Throws if it reverts. */
export async function sendAs(agent: Agent, call: { to: Hex; data: Hex; value?: bigint }, what: string): Promise<Receipt> {
  const value = call.value ?? 0n;
  const hash = await sendFrom(agent, { ...call, value }, what);
  return settled(hash, value);
}

async function settled(hash: Hex, value: bigint): Promise<Receipt> {
  let receipt: Receipt;
  try {
    receipt = await minedReceipt(hash, MINED_WITHIN_MS());
  } catch (error) {
    const mined = await receiptOf(hash);
    // A reverted transaction's value stays with the sender; its gas doesn't.
    if (mined !== null) settle(settings, { hash, status: "reverted", gasUsed: BigInt(mined.gasUsed).toString(), cost: feeOf(mined).toString() });
    throw error;
  }
  settle(settings, { hash, status: "success", gasUsed: BigInt(receipt.gasUsed).toString(), cost: (value + feeOf(receipt)).toString() });
  return receipt;
}

/**
 * Record what every transaction of this run that has been mined cost, waiting
 * up to `waitMs` for those that haven't. Called after each test, and once more
 * at the end of the run.
 */
export async function settleMined(waitMs = 0): Promise<{ unmined: string[] }> {
  const unmined: string[] = [];
  for (const entry of runRecord(currentRun())) {
    if (entry.settled) continue;
    const until = Date.now() + waitMs;
    let receipt = await receiptOf(entry.hash);
    while (receipt === null && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      receipt = await receiptOf(entry.hash);
    }
    if (receipt === null) {
      unmined.push(entry.hash);
      continue;
    }
    const ok = BigInt(receipt.status) === 1n;
    settle(settings, {
      hash: entry.hash,
      status: ok ? "success" : "reverted",
      gasUsed: BigInt(receipt.gasUsed).toString(),
      // A reverted transaction's value stays with the sender.
      cost: ((ok ? BigInt(entry.value) : 0n) + feeOf(receipt)).toString(),
    });
  }
  return { unmined };
}

// ── The page's wallet ────────────────────────────────────────────────────

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

const SENDS = new Set(["eth_sendTransaction", "eth_signTransaction", "eth_sendRawTransaction"]);

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown[];
}

export interface PageWallet {
  agent: Agent;
  /** What the page is doing, for the budget's record ("swap: buy SPX"). Set it before each step. */
  doing: string;
  /** Every transaction sent for the page, in order. */
  hashes: Hex[];
  /** Every transaction signed for the page and handed back unsent (private sending), in order. */
  signed: { hash: Hex; gas: bigint; gasPrice: bigint }[];
}

/**
 * Give every page in `context` a headless wallet for `agent`, whose requests
 * are checked and signed as the file comment says.
 */
export async function pageWallet(context: BrowserContext, agent: Agent, doing: string, relayUrl: string | null = null): Promise<PageWallet> {
  const wallet: PageWallet = { agent, doing, hashes: [], signed: [] };
  const checked = new Set<string>();
  await context.addInitScript(
    headlessWalletScript({ rpcUrl: settings.rpcUrl, address: agent.address, chainId: 1, refuseSignTypedData: true }),
  );

  const handle = async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    let body: JsonRpcRequest | JsonRpcRequest[] | null = null;
    try {
      body = JSON.parse(request.postData() ?? "null") as JsonRpcRequest | JsonRpcRequest[] | null;
    } catch {
      // Not JSON: not a request this wallet answers.
    }
    const reply = (id: unknown, payload: object) =>
      route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, ...payload }) });
    if (Array.isArray(body)) {
      // The headless wallet and the app's sender post one request at a time;
      // a batch that carries a send is something else, and goes nowhere.
      if (body.some((item) => SENDS.has(String(item?.method)))) return route.abort("blockedbyclient");
      return route.continue();
    }
    if (body === null || typeof body !== "object" || !SENDS.has(String(body.method))) return route.continue();
    const fail = (message: string) => reply(body.id, { error: { code: -32000, message } });

    if (body.method === "eth_sendRawTransaction") {
      // Only bytes signed and checked here leave, to the endpoint or the relay.
      const raw = String(body.params?.[0] ?? "");
      const hash = /^0x([0-9a-fA-F]{2})+$/.test(raw) ? transactionHash(raw).toLowerCase() : "";
      return checked.has(hash) ? route.continue() : fail("this test wallet sends only what it signed");
    }

    const tx = (body.params?.[0] ?? {}) as Record<string, string | undefined>;
    if ((tx["from"] ?? "").toLowerCase() !== agent.address || !tx["to"]) {
      return reply(body.id, { error: { code: 4100, message: `this test wallet signs only for ${agent.address}, to an address` } });
    }
    const call = {
      to: tx["to"].toLowerCase() as Hex,
      data: (tx["data"] ?? "0x").toLowerCase() as Hex,
      value: BigInt(tx["value"] ?? "0x0"),
    };
    try {
      if (body.method === "eth_signTransaction") {
        // Private sending: signed exactly as the page asked, and handed back.
        const reason = await refusal(call);
        if (reason !== null) throw new Error(`${wallet.doing}: refused, ${reason}`);
        if (Number(BigInt(tx["chainId"] ?? "0x1")) !== 1) throw new Error("asked to sign for a chain other than Ethereum");
        const gas = BigInt(tx["gas"]!);
        const gasPrice = BigInt(tx["gasPrice"]!);
        const prepared: PreparedTransaction = {
          from: agent.address,
          chainId: 1,
          nonce: Number(BigInt(tx["nonce"]!)),
          ...call,
          gas,
          fees: { type: "legacy", gasPrice },
        };
        priced(prepared, wallet.doing);
        const signed = await signPrepared(agent.key, prepared);
        const hash = signed.hash.toLowerCase() as Hex;
        reserve(settings, { what: wallet.doing, wallet: agent.name, hash, to: call.to, value: call.value.toString(), maxCost: (call.value + gas * gasPrice).toString() });
        checked.add(hash);
        wallet.signed.push({ hash, gas, gasPrice });
        return reply(body.id, { result: signed.raw });
      }
      // The headless wallet has already set a gas limit with a real wallet's
      // headroom; it is kept, and so are the fees the page suggested.
      const suggested =
        tx["maxFeePerGas"] && tx["maxPriorityFeePerGas"]
          ? { fees: { maxFeePerGas: BigInt(tx["maxFeePerGas"]), maxPriorityFeePerGas: BigInt(tx["maxPriorityFeePerGas"]) } }
          : {};
      const hash = await sendFrom(agent, { ...call, ...(tx["gas"] ? { gas: BigInt(tx["gas"]) } : {}), ...suggested }, wallet.doing);
      wallet.hashes.push(hash);
      return reply(body.id, { result: hash });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  await context.route((url) => url.href.startsWith(settings.rpcUrl), handle);
  if (relayUrl !== null && relayUrl !== settings.rpcUrl) await context.route((url) => url.href.startsWith(relayUrl), handle);
  return wallet;
}

/** A one-line account of what an agent holds, for messages. */
export async function describeBalance(agent: Agent): Promise<string> {
  const wei = BigInt((await rpc("eth_getBalance", [agent.address, "latest"])) as string);
  return `${agent.name} ${agent.address} holds ${eth(wei)} ETH`;
}
