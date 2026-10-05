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
 * 1. **Where it goes.** A Uniswap router (from the owner agent only), v2's
 *    factory, a vault a factory of any release vouches for (`isVault`) and
 *    an agent owns (triggered only to pay an agent), the batcher (bound to no
 *    factory, so the check of what it may trigger is here) with only this
 *    run's own vaults, an agent as `rewardTo` and the least gas a vault is
 *    given (`MIN_EXECUTE_GAS`, what the app and the keeper send), the SPX holder
 *    registry with a proof of the holder agent that would move its
 *    `validUntil`, an agent wallet, WETH for an approval to a router, a
 *    transfer to an agent, or a wrap, and SPX only for the owner agent's
 *    approval of a router for the SPX it holds, before `1-swap` sells what it
 *    bought. No SPX leaves an agent any other way (decision 33). Anything
 *    else is refused: a build that tried to send elsewhere fails the run
 *    instead.
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
  parseHeaderRlp,
  prepareTransaction,
  signPrepared,
  transactionHash,
  type PreparedTransaction,
} from "../packages/chain/src/index.js";
import { headlessWalletScript } from "../packages/testing/src/wallet.js";
import {
  BATCHER_LIMITS,
  PROOF_TTL,
  encodeExecuteBatch,
  encodeProve,
  readVault,
  readVaultCount,
  readVaultOwners,
  readVaultsPage,
} from "../packages/vault/src/index.js";
import { reserve, runRecord, settle } from "./budget.js";
import {
  BATCHER,
  FACTORIES,
  FACTORY,
  PERMIT2,
  REGISTRY,
  ROUTERS,
  SPX,
  WETH,
  feeOf,
  hasCode,
  headBlock,
  holderStatus,
  minedReceipt,
  receiptOf,
  rpc,
  settings,
  tokenBalance,
  validUntilOf,
  vaultFactoryOf,
  type Receipt,
} from "./chain.js";
import { openKeystore } from "./keys.js";
import { AGENT_NAMES, HOLDER, currentRun, eth, feeRateCap, gwei, type AgentName } from "./settings.js";

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

/** The holder agent's address (settings.ts, `HOLDER`), known without opening a keystore. */
export const holderAddress = (): Hex => currentRun().agents[HOLDER].address.toLowerCase() as Hex;

/**
 * Throws, saying what to do, unless the registry finds the holder agent
 * eligible now, with a proof that lasts at least the next hour: a spec that
 * pays it inside a community window would otherwise wait the window out, or
 * be held back, for a reason that is no fault of the app.
 */
export async function requireHolderEligible(): Promise<void> {
  const status = await holderStatus(holderAddress());
  if (status.eligible === true && status.validUntil !== null && status.chainTime !== null && status.validUntil >= status.chainTime + 3_600n) return;
  throw new Error(
    `the holder agent (${HOLDER} ${status.holder}) isn't a community keeper for the next hour ` +
      `(eligible ${status.eligible}, validUntil ${status.validUntil}, SPX ${status.balance}): run 3-prove first (docs/MAINNET-SMOKE.md)`,
  );
}

/**
 * Every vault an agent owns on each release's factory list, from the index
 * `from` gives for that factory on (0 for one it doesn't name): each listed
 * vault kept when an agent is its `owner()`. Not a log search: a free plan
 * refuses one over more than a few blocks (Alchemy's, ten), and a run spans
 * dozens. A factory with no code on this chain lists nothing. An owner that
 * can't be read throws, because a clean-up that skipped one could leave a
 * vault funded.
 */
export async function agentVaults(from: Readonly<Record<string, string>> = {}): Promise<Hex[]> {
  const listed: Hex[] = [];
  for (const factory of FACTORIES) {
    if (!(await hasCode(factory))) continue;
    const count = await readVaultCount(rpc, factory);
    for (let offset = BigInt(from[factory] ?? "0"); offset < count; offset += 1_000n) {
      listed.push(...((await readVaultsPage(rpc, factory, offset, 1_000n)) as Hex[]).map((vault) => vault.toLowerCase() as Hex));
    }
  }
  // Read after the lists, so every vault on them exists at this block.
  const owners = await readVaultOwners(rpc, listed, { block: await headBlock() });
  const unread = listed.filter((vault) => !owners.has(vault));
  if (unread.length > 0) throw new Error(`couldn't read the owner of ${unread.join(", ")}`);
  const own = agentAddresses();
  return listed.filter((vault) => own.has(owners.get(vault)!.toLowerCase()));
}

/** Every vault an agent created since the run started: listed after where each factory's list stood then. */
export const runVaults = (): Promise<Hex[]> => agentVaults(currentRun().startVaultCounts);

// ── Where it goes ────────────────────────────────────────────────────────

const SELECTOR = {
  approve: "0x095ea7b3",
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  deposit: "0xd0e30db0",
  withdraw: "0x2e1a7d4d",
  /** v2's `execute(address rewardTo)`; v1's `execute()` is 0x61461954. */
  execute: "0x4b64e492",
  /** The registry's `prove(address holder, bytes header, bytes[] accountProof, bytes[] storageProof)`. */
  prove: "0x0c4ce46d",
} as const;

/**
 * `executeBatch(address[] vaults, address rewardTo, uint256 minRewards, uint256 gasPerVault)`'s
 * arguments, as the batcher (`BATCHER`, bound to no factory) takes them, or null for anything
 * else: v1's batcher's three-argument form included, which no run sends.
 */
function readExecuteBatch(data: string): { vaults: Hex[]; rewardTo: Hex; minRewards: bigint; gasPerVault: bigint } | null {
  try {
    const body = data.slice(10);
    const word = (i: number) => body.slice(i * 64, (i + 1) * 64);
    const at = Number(BigInt(`0x${word(0)}`) / 32n);
    const count = Number(BigInt(`0x${word(at)}`));
    if (count > 1_000) return null;
    const vaults = Array.from({ length: count }, (_, i) => `0x${word(at + 1 + i).slice(24)}` as Hex);
    const rewardTo = `0x${word(1).slice(24)}` as Hex;
    const minRewards = BigInt(`0x${word(2)}`);
    const gasPerVault = BigInt(`0x${word(3)}`);
    // Read back only if it encodes to exactly these bytes, for this batcher.
    const again = encodeExecuteBatch(vaults, rewardTo, minRewards, { batcher: BATCHER, gasPerVault });
    return again.toLowerCase() === data ? { vaults, rewardTo, minRewards, gasPerVault } : null;
  } catch {
    return null;
  }
}

/**
 * `prove(holder, header, accountProof, storageProof)`'s arguments, or null for
 * anything else. Read by hand (the harness has no ABI decoder of its own),
 * and kept only if `encodeProve` gives back exactly these bytes, so a
 * misreading can only refuse.
 */
export function readProve(data: string): { holder: Hex; header: Hex; accountProof: Hex[]; storageProof: Hex[] } | null {
  try {
    const hex = data.toLowerCase();
    if (!hex.startsWith(SELECTOR.prove)) return null;
    const body = hex.slice(10);
    const slice = (byte: number, length: number) => {
      const part = body.slice(byte * 2, (byte + length) * 2);
      if (part.length !== length * 2) throw new Error("past the end");
      return part;
    };
    const uint = (byte: number) => {
      const value = BigInt(`0x${slice(byte, 32)}`);
      if (value > 1_000_000n) throw new Error("too large");
      return Number(value);
    };
    const bytesAt = (byte: number): Hex => `0x${slice(byte + 32, uint(byte))}`;
    const listAt = (byte: number): Hex[] => {
      const count = uint(byte);
      if (count > 64) throw new Error("too many nodes");
      return Array.from({ length: count }, (_, i) => bytesAt(byte + 32 + uint(byte + 32 + 32 * i)));
    };
    const proof = {
      holder: `0x${slice(0, 32).slice(24)}` as Hex,
      header: bytesAt(uint(32)),
      accountProof: listAt(uint(64)),
      storageProof: listAt(uint(96)),
    };
    return encodeProve(proof).toLowerCase() === hex ? proof : null;
  } catch {
    return null;
  }
}

/**
 * Why a `prove` must not be sent, or null when it may: it must carry no
 * ether, prove the holder agent (or, on a fork run only, the real holder
 * global-setup.ts found for the rehearsal), and move that holder's
 * `validUntil`. The registry reverts `NotNewer` on a proof that would not, so
 * `validUntil` is read first and such a proof is never signed: it could only
 * spend its network fee to change nothing.
 */
async function proveRefusal(call: { data: string; value: bigint }): Promise<string | null> {
  if (call.value !== 0n) return "a call to the SPX holder registry that carries ether";
  const proof = readProve(call.data);
  if (proof === null) return "a call to the SPX holder registry that is not a prove";
  const run = currentRun();
  const rehearsal = run.mode === "fork" ? run.rehearsalHolder : null;
  if (proof.holder !== holderAddress() && proof.holder !== rehearsal) return `a proof of ${proof.holder}, not of the holder agent`;
  const header = parseHeaderRlp(proof.header);
  if (header === null) return "a proof whose block header can't be read";
  const proposed = header.timestamp + PROOF_TTL;
  const stored = await validUntilOf(proof.holder);
  if (proposed <= stored) {
    return `a proof that would revert NotNewer: ${proof.holder} is proven until ${stored}, and a proof of block ${header.number} makes it valid only until ${proposed}`;
  }
  return null;
}

/**
 * Why `call` could move SPX out of an agent, or null when it couldn't
 * (decision 33: the suite refuses any SPX leaving an agent).
 *
 * - The holder agent's SPX is sent to it once, by hand, by the wallets'
 *   owner, and stays: nothing from the holder agent goes to SPX at all (a
 *   transfer, an approval, a permit), to Permit2, or to a router (a swap
 *   could sell it).
 * - No agent calls SPX but for the one exception below: no transfer (to an
 *   agent or anyone), no `transferFrom`, no permit, and no other approval.
 * - Only the owner agent swaps. Its `1-swap` round trip buys a little SPX and
 *   sells exactly that back, approving a router first, so the one SPX call
 *   allowed is the owner agent's `approve` of a router for no more than the
 *   SPX it holds: the spec's own purchase, never the holder's, which no
 *   allowance of the owner agent's can reach. That sale is the only SPX that
 *   leaves an agent, and docs/MAINNET-SMOKE.md says so.
 */
async function spxRefusal(call: { from: string; to: string; data: string }): Promise<string | null> {
  const holder = holderAddress();
  const owner = currentRun().agents.owner.address.toLowerCase();
  const from = call.from.toLowerCase();
  const to = call.to.toLowerCase();
  const data = call.data.toLowerCase();
  if (from === holder) {
    if (to === SPX) return `a call to SPX from the holder agent (${data.slice(0, 10)}): its SPX never leaves it (decision 33)`;
    if (to === PERMIT2) return "a call to Permit2 from the holder agent: a Permit2 approval could move its SPX (decision 33)";
    if (ROUTERS.includes(to as Hex)) return "a swap from the holder agent: a swap could sell its SPX (decision 33)";
  }
  if (to === SPX) {
    if (from !== owner || !data.startsWith(SELECTOR.approve)) {
      return `an SPX call (${data.slice(0, 10)}) from an agent: SPX leaves an agent only in 1-swap's sale, after the owner agent's approval of a router (decision 33)`;
    }
    const spender = `0x${data.slice(34, 74)}`;
    if (data.length !== 138 || !/^0x0{24}/.test(`0x${data.slice(10, 34)}`)) return "an SPX approval that isn't one spender and one amount";
    if (!ROUTERS.includes(spender as Hex)) return `an SPX approval for ${spender}, not a router (decision 33)`;
    const amount = BigInt(`0x${data.slice(74, 138)}`);
    const held = await tokenBalance(SPX, owner);
    if (amount > held) return `an SPX approval for ${amount} units, more than the ${held} the owner agent holds: it may sell only what it bought (decision 33)`;
    return null;
  }
  if (ROUTERS.includes(to as Hex) && from !== owner) return "a swap from an agent other than the owner agent: only 1-swap swaps (decision 33)";
  return null;
}

/** Why the agents must not send `call`, or null when it is one this suite makes. */
export async function refusal(call: { from: string; to: string; data: string; value: bigint }): Promise<string | null> {
  const to = call.to.toLowerCase();
  const data = call.data.toLowerCase();
  const own = agentAddresses();
  const spx = await spxRefusal(call);
  if (spx !== null) return spx;
  // The one SPX call spxRefusal lets through: the owner agent's approval of a router, for the SPX it holds.
  if (to === SPX) return null;
  if (ROUTERS.includes(to as Hex)) return null;
  if (to === FACTORY) return null;
  if (to === REGISTRY) return proveRefusal(call);
  if (to === PERMIT2) return "a call to Permit2, which this suite never uses";
  if (to === BATCHER) {
    const batch = readExecuteBatch(data);
    if (batch === null) return "a call to the batcher that is not an executeBatch";
    if (!own.has(batch.rewardTo)) return `a batch that pays its fees to ${batch.rewardTo}, not an agent`;
    if (batch.gasPerVault !== BATCHER_LIMITS.MIN_EXECUTE_GAS) {
      return `a batch that gives each vault ${batch.gasPerVault} gas, not the ${BATCHER_LIMITS.MIN_EXECUTE_GAS} the app and the keeper send`;
    }
    const mine = new Set(await runVaults());
    const others = batch.vaults.filter((vault) => !mine.has(vault));
    return others.length === 0 ? null : `a batch that triggers vaults this run didn't create: ${others.join(", ")}`;
  }
  if (own.has(to)) return data === "0x" ? null : "a call, not a payment, to an agent wallet";
  if (to === WETH) {
    const selector = data.slice(0, 10);
    const argument = `0x${data.slice(34, 74)}`;
    if (selector === SELECTOR.approve) return ROUTERS.includes(argument as Hex) ? null : `an approval for ${argument}, not a router`;
    if (selector === SELECTOR.transfer) return own.has(argument) ? null : `a transfer to ${argument}, not an agent`;
    if (selector === SELECTOR.deposit || selector === SELECTOR.withdraw) return null;
    return `a token call this suite doesn't make (${selector})`;
  }
  const factory = await vaultFactoryOf(to);
  if (factory !== null) {
    // Funding, triggering or closing: only a vault an agent owns.
    const state = await readVault(rpc, to as Hex, { factory });
    if (state === null || !own.has(state.owner.toLowerCase())) return `${to} is a vault no agent owns`;
    // A v2 trigger names who is paid its fee: only an agent (Trigger now names the owner).
    if (data.startsWith(SELECTOR.execute)) {
      const rewardTo = `0x${data.slice(34, 74)}`;
      if (data.length !== 74 || !own.has(rewardTo)) return `a trigger that pays its fee to ${rewardTo}, not an agent`;
    }
    return null;
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
  const reason = await refusal({ from: agent.address, ...call });
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
        const reason = await refusal({ from: agent.address, ...call });
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
