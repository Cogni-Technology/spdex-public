/**
 * What the keeper knows about the chain: which vaults it watches, and what
 * each one's progress, balance and price were when it last looked.
 *
 * Discovery reads the listed factories' own lists (or checks an allowlist
 * against them) and adds each vault they vouch for; the accounting pass reads
 * every watched vault's progress and balance every `accountingSeconds`, and
 * retires what is closed or finished. The reads themselves take an endpoint
 * and the WETH address, never the tick, and a figure one could not get comes
 * back null — unknown, never zero.
 *
 * Nothing here decides whether to send, or signs: `keeper.ts` plans from what
 * this file cached, and `keeper-pending.ts` follows what was sent.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, Multicall3Reader, type JsonRpc } from "@spdex/chain";
import { FACTORY_ABI, MAINNET_DEPLOYMENT, MAINNET_FACTORY, VAULT_ABI, type Deployment } from "./artifacts.js";
import { WETH_ABI, decodeOr, decodeVaultProgress, normaliseTerms, vaultProgressCallCount, vaultProgressCalls, type VaultProgress, type VaultTerms } from "./index.js";
import { earliestBuyAt, windowOf } from "./keeper-plan.js";
import { revertDataOf } from "./keeper-send.js";
import type { VaultEntry } from "./keeper-state.js";
import type { Tick } from "./keeper.js";

/** Vaults read from a factory's list per call. */
const DISCOVERY_PAGE = 500n;
/** Discovery's `eth_call`s per tick, at most: a keeper starting late catches up over several ticks. */
const DISCOVERY_MAX_CALLS = 20;
/** Vaults per Multicall3 call. */
const VAULTS_PER_CALL = 30;
/** Vaults per Multicall3 call when only their WETH is read. */
const BALANCES_PER_CALL = 200;
const MULTICALL_GAS = 30_000_000n;
/** How long an address no listed factory vouches for, or a vault that cannot pay, waits before it is read again. */
export const RECHECK_SECONDS = 3_600n;

const PAIR_ABI = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);

// ─── Blocks ───────────────────────────────────────────────────────────────────

export interface Head {
  number: bigint;
  timestamp: bigint;
  baseFee: bigint | null;
  gasUsed: bigint;
  gasLimit: bigint;
}

export async function readHead(rpc: JsonRpc): Promise<Head> {
  const b = (await rpc("eth_getBlockByNumber", ["latest", false])) as {
    number: string;
    timestamp: string;
    baseFeePerGas?: string | null;
    gasUsed: string;
    gasLimit: string;
  } | null;
  if (!b) throw new Error("the endpoint returned no latest block");
  return {
    number: BigInt(b.number),
    timestamp: BigInt(b.timestamp),
    baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null,
    gasUsed: BigInt(b.gasUsed),
    gasLimit: BigInt(b.gasLimit),
  };
}

export async function blockAt(rpc: JsonRpc, number: bigint): Promise<{ timestamp: bigint; baseFee: bigint | null }> {
  const b = (await rpc("eth_getBlockByNumber", [hex(number), false])) as { timestamp: string; baseFeePerGas?: string | null } | null;
  if (!b) throw new Error(`the endpoint has no block ${number}`);
  return { timestamp: BigInt(b.timestamp), baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null };
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Find vaults: every vault in every release's factory list, or only the
 * allowlist. A listed vault is vouched for by construction — the same call
 * that set `isVault` appended it — so a lagging endpoint can never make one
 * look untrusted. Bounded per tick, so a keeper starting long after the
 * factory catches up over several ticks, saying `syncing` meanwhile.
 */
export async function discover(t: Tick): Promise<"syncing" | "running"> {
  if (t.config.vaults !== null) {
    await discoverAllowlisted(t, t.config.vaults);
    return "running";
  }
  const { state, policy } = t;
  const behind = () => Object.values(state.deployments).some((d) => d.vaultCount !== null && d.scannedCount < d.vaultCount);
  const due = state.discoveredAt === null || t.chainTime >= state.discoveredAt + policy.discoverySeconds || behind();
  if (!due) return behind() ? "syncing" : "running";

  let budget = DISCOVERY_MAX_CALLS;
  for (const deployment of t.config.deployments) {
    const known = state.deployments[deployment.id];
    if (!known || budget <= 0) continue;
    budget -= 1;
    const count = await callOrNull(t.rpc, deployment.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }), (data) =>
      decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", data }),
    );
    // No factory on this chain for this release: nothing to discover there.
    if (count === null) continue;
    known.vaultCount = count;
    while (known.scannedCount < count && budget > 0) {
      budget -= 1;
      const page = await callOrNull(
        t.rpc,
        deployment.factory,
        encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultsPage", args: [known.scannedCount, DISCOVERY_PAGE] }),
        (data) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", data }).map(lower),
      );
      if (page === null || page.length === 0) break;
      let progressed = true;
      for (let i = 0; i < page.length && budget > 0 && progressed; i += VAULTS_PER_CALL) {
        budget -= 1;
        const chunk = page.slice(i, i + VAULTS_PER_CALL);
        const read = await readOwnersAndTerms(t.rpc, chunk, []);
        for (const vault of chunk) {
          const r = read.get(vault);
          if (!r?.owner || !r.terms) {
            progressed = false;
            break;
          }
          if (!state.vaults[vault] && !state.retired.includes(vault)) addVault(t, vault, deployment.id, known.scannedCount, r.owner, r.terms);
          known.scannedCount += 1n;
        }
      }
      t.emit({ type: "sync", deployment: deployment.id, scannedCount: known.scannedCount, vaultCount: count });
      await t.persist();
      if (!progressed) break;
    }
  }
  state.discoveredAt = t.chainTime;
  return behind() ? "syncing" : "running";
}

/**
 * The allowlist: each address not yet known is read once, with every listed
 * factory asked whether it vouches for it. One none vouches for is rechecked
 * hourly and never dropped for good: vouching can't be taken back, but an
 * endpoint can be wrong for a while.
 */
async function discoverAllowlisted(t: Tick, allowlist: readonly Address[]): Promise<void> {
  const { state } = t;
  const toCheck = allowlist.filter((vault) => {
    if (state.vaults[vault] || state.retired.includes(vault)) return false;
    const notVouched = state.notVouched[vault];
    return !notVouched || t.chainTime >= notVouched.recheckAt;
  });
  for (let i = 0; i < toCheck.length; i += VAULTS_PER_CALL) {
    const chunk = toCheck.slice(i, i + VAULTS_PER_CALL);
    const read = await readOwnersAndTerms(t.rpc, chunk, t.config.deployments);
    for (const vault of chunk) {
      const r = read.get(vault);
      const deployment = r?.vouchedBy ?? null;
      if (r?.owner && r.terms && deployment) {
        delete state.notVouched[vault];
        addVault(t, vault, deployment, null, r.owner, r.terms);
        continue;
      }
      const detail = !r?.terms ? "not a vault" : "no listed factory vouches for it";
      if (!state.notVouched[vault]) {
        t.emit({ type: "skip", vault, slot: null, code: "not-vouched", detail });
      }
      state.notVouched[vault] = { since: state.notVouched[vault]?.since ?? t.chainTime, recheckAt: t.chainTime + RECHECK_SECONDS };
      t.result.skipped.push({ vault, code: "not-vouched", detail });
    }
  }
}

function addVault(t: Tick, vault: Address, deployment: string, index: bigint | null, owner: Address, terms: VaultTerms): void {
  t.state.vaults[vault] = {
    deployment,
    index,
    owner,
    terms,
    buysDone: 0n,
    lastBuyAt: 0n,
    closed: false,
    balance: null,
    readAt: null,
    recheckAt: null,
    restingUntil: null,
    paidRefusals: null,
    lastSkip: null,
    watchedSlot: null,
  };
  // Only this build's factory was made with MAINNET_DEPLOYMENT's markets. Another release's list may differ, so
  // there the index is left unknown rather than guessed; the report takes it from `VaultCreated` in any case.
  const factory = t.config.deployments.find((d) => d.id === deployment)?.factory;
  const marketIndex =
    factory !== undefined && lower(factory) === lower(MAINNET_FACTORY)
      ? MAINNET_DEPLOYMENT.markets.findIndex((m) => m.tokenOut === terms.tokenOut && m.pair === terms.pair && m.oraclePool === terms.oraclePool)
      : -1;
  t.emit({
    type: "vault_found",
    vault,
    deployment,
    index,
    owner,
    marketIndex: marketIndex === -1 ? null : marketIndex,
    tokenOut: terms.tokenOut,
    amountPerBuy: terms.amountPerBuy,
    interval: terms.interval,
    maxBuys: terms.maxBuys,
    startAt: terms.startAt,
    keeperReward: terms.keeperReward,
    maxSlippageBps: terms.maxSlippageBps,
  });
}

/** A vault that is closed or has made its last buy: never read again. */
export function retire(t: Tick, vault: Address, reason: "closed" | "done"): void {
  delete t.state.vaults[vault];
  delete t.state.trapped[vault];
  if (!t.state.retired.includes(vault)) t.state.retired.push(vault);
  t.outcomes.delete(vault);
  t.emit({ type: "vault_retired", vault, reason });
}

// ─── Accounting ───────────────────────────────────────────────────────────────

/**
 * Every active vault's progress and balance, and the keeper's own ether (and
 * WETH, when its rewards come to it), every `accountingSeconds` whether or not
 * anything is due: what retires finished vaults, notices other keepers' buys,
 * and keeps the heartbeat's figures true. No prices: the oracle's `observe`
 * is the dear part of a read, and only vaults about to be sent need it.
 */
export async function accountingRead(t: Tick): Promise<void> {
  const { state } = t;
  // A vault that could not pay for its next buy when last read can neither buy nor be bought until it is
  // topped up, so between hourly full reads only its WETH is read, many to a call: vaults made and never
  // funded cost little to create, and must not cost every keeper four reads each, every pass, for good.
  const idle = new Set(
    entries(state.vaults)
      .filter(([, e]) => e.readAt !== null && t.chainTime < e.readAt + RECHECK_SECONDS && e.balance !== null && e.balance < e.terms.amountPerBuy + e.terms.keeperReward)
      .map(([vault]) => vault),
  );
  const vaults = (Object.keys(state.vaults) as Address[]).filter((vault) => !idle.has(vault));
  const reads = await readVaults(t.rpc, t.config.weth, vaults, false);
  for (const vault of vaults) {
    const read = reads.get(vault);
    if (read && applyRead(t, vault, read)) t.outcomes.set(vault, t.outcomes.get(vault) ?? "ok");
  }
  // A top-up shows here, and the vault is read in full when it is next due.
  for (const [vault, balance] of await readBalances(t.rpc, t.config.weth, [...idle])) if (balance !== null) state.vaults[vault]!.balance = balance;
  if (t.keeper !== null) {
    const balance = BigInt((await t.rpc("eth_getBalance", [t.keeper, "latest"])) as string);
    state.balanceWei = balance;
    if (balance < t.policy.minEth && !state.lowBalance) {
      state.lowBalance = true;
      t.emit({ type: "low_balance", etherWei: balance, thresholdWei: t.policy.minEth, neededWei: null });
    } else if (balance >= t.policy.minEth) {
      state.lowBalance = false;
    }
    if (t.rewardTo === t.keeper) {
      t.keeperWeth = await callOrNull(t.rpc, t.config.weth, encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [t.keeper] }), (data) =>
        decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data }),
      );
    }
  }
  state.accountedAt = t.chainTime;
}

/** Record a read in the cache: someone else's buy is `overtaken`, a closed or finished vault retires. False when it cannot be used. */
export function applyRead(t: Tick, vault: Address, read: VaultProgress): boolean {
  const e = t.state.vaults[vault];
  if (!e || read.buysDone === null || read.lastBuyAt === null || read.closed === null) return false;
  if (e.readAt !== null && read.buysDone > e.buysDone) {
    t.emit({ type: "overtaken", vault, slot: windowOf(e.terms, read.lastBuyAt).slot });
  }
  e.buysDone = read.buysDone;
  e.lastBuyAt = read.lastBuyAt;
  e.closed = read.closed;
  if (read.balance !== null) e.balance = read.balance;
  e.readAt = t.chainTime;
  if (e.closed) {
    retire(t, vault, "closed");
    return false;
  }
  const slot = currentSlot(t, e);
  if (slot === null) {
    retire(t, vault, "done");
    return false;
  }
  e.watchedSlot ??= slot;
  return true;
}

/** The window a vault's next buy falls in: the one open now once it is due, else the one it comes due in; null when it has no buy left. */
export function currentSlot(t: Pick<Tick, "chainTime">, e: VaultEntry): bigint | null {
  const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
  return earliest === null ? null : windowOf(e.terms, earliest > t.chainTime ? earliest : t.chainTime).slot;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** `owner()` and `terms()` of each vault, and, when `vouching` names releases, which of their factories vouches for it. */
async function readOwnersAndTerms(
  rpc: JsonRpc,
  vaults: readonly Address[],
  vouching: readonly Deployment[],
): Promise<Map<Address, { owner: Address | null; terms: VaultTerms | null; vouchedBy: string | null }>> {
  const per = 2 + vouching.length;
  const calls = vaults.flatMap((vault) => [
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "terms" }) },
    ...vouching.map((d) => ({ to: lower(d.factory), data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [vault] }) })),
  ]);
  const results = await reader(rpc, per * VAULTS_PER_CALL).multicall(calls);
  const out = new Map<Address, { owner: Address | null; terms: VaultTerms | null; vouchedBy: string | null }>();
  vaults.forEach((vault, i) => {
    const at = (k: number) => results[i * per + k];
    const owner = decodeOr(at(0), (data) => lower(decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data })));
    const terms = decodeOr(at(1), (data) => normaliseTerms(decodeFunctionResult({ abi: VAULT_ABI, functionName: "terms", data })));
    const vouchedBy = vouching.find((_, k) => decodeOr(at(2 + k), (data) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", data })) === true)?.id ?? null;
    out.set(vault, { owner, terms, vouchedBy });
  });
  return out;
}

/** Each vault's progress (`vaultProgressCalls`), with `quote()` when asked: one Multicall3 call per 30 vaults. */
export async function readVaults(rpc: JsonRpc, weth: Address, vaults: readonly Address[], withQuote: boolean): Promise<Map<Address, VaultProgress>> {
  const per = vaultProgressCallCount(withQuote);
  const calls = vaults.flatMap((vault) => vaultProgressCalls(vault, weth, withQuote));
  const results = vaults.length === 0 ? [] : await reader(rpc, per * VAULTS_PER_CALL).multicall(calls);
  return new Map(vaults.map((vault, i) => [vault, decodeVaultProgress(results, i * per, withQuote)]));
}

/** Each vault's WETH alone; null where it could not be read. */
async function readBalances(rpc: JsonRpc, weth: Address, vaults: readonly Address[]): Promise<Map<Address, bigint | null>> {
  if (vaults.length === 0) return new Map();
  const token = lower(weth);
  const results = await reader(rpc, BALANCES_PER_CALL).multicall(
    vaults.map((vault) => ({ to: token, data: encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [vault] }) })),
  );
  return new Map(vaults.map((vault, i) => [vault, decodeOr(results[i], (data) => decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data }))]));
}

/** Each distinct pair's WETH reserve, for the public pair cap; null where it could not be read. */
export async function readReserves(rpc: JsonRpc, weth: Address, terms: readonly VaultTerms[]): Promise<Map<Address, bigint | null>> {
  const pairs = [...new Map(terms.map((x) => [x.pair, x])).values()];
  const results = await reader(rpc, VAULTS_PER_CALL).multicall(pairs.map((x) => ({ to: x.pair, data: encodeFunctionData({ abi: PAIR_ABI, functionName: "getReserves" }) })));
  const token = lower(weth);
  return new Map(
    pairs.map((x, i) => {
      const reserves = decodeOr(results[i], (data) => decodeFunctionResult({ abi: PAIR_ABI, functionName: "getReserves", data }));
      // Uniswap v2 orders a pair's tokens by address.
      return [x.pair, reserves === null ? null : BigInt(token < x.tokenOut ? reserves[0] : reserves[1])];
    }),
  );
}

/** An `eth_call`'s answer decoded; null for a call that failed, or returned nothing (no code there). */
async function callOrNull<T>(rpc: JsonRpc, to: Address, data: Hex, decode: (data: Hex) => T): Promise<T | null> {
  let answer: Hex;
  try {
    answer = (await rpc("eth_call", [{ to, data }, "latest"])) as Hex;
  } catch (error) {
    if (revertDataOf(error) !== null) return null;
    throw error;
  }
  return decodeOr(answer, decode);
}

function reader(rpc: JsonRpc, batchSize: number): Multicall3Reader {
  return new Multicall3Reader(rpc, { batchSize, gasLimit: MULTICALL_GAS, multicall3: CONTRACTS.multicall3 });
}

const entries = (vaults: Record<Address, VaultEntry>): [Address, VaultEntry][] => Object.entries(vaults) as [Address, VaultEntry][];
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const lower = (a: string): Address => a.toLowerCase() as Address;
