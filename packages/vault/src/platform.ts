/**
 * Collective DCA: what every auto-buy vault has done, read from the chain
 * alone — the figures behind the app's "Collective DCA: auto-buy vaults"
 * panel, the factory-list owner search behind "Find my vaults", which
 * vaults' buys are due for "Help run the network" (`readDueCandidates`), and
 * which vaults in a transaction the factory vouches for, with their owners,
 * for the app's `#receipt=` view (`readVouchedOwners`).
 *
 * ## What it counts, and what it can't
 *
 * Only vaults made by spDEX's vault factory, from any app. A one-time swap or
 * a buy someone confirms in their own wallet is an ordinary Uniswap trade that
 * carries no spDEX marker, and none may be added: a marker would publicly
 * label every address that ever used spDEX. So these figures are vault
 * activity, and the panel says so. Owners are addresses, not people.
 *
 * ## Why host code, not a tracker module
 *
 * A module may call only the contracts its manifest declares, and a vault's
 * address exists only once someone creates it, so no manifest can name one.
 * The tracker's `balanceOf`-on-a-declared-token trick reaches a vault's WETH,
 * but not its owner, progress or terms. The tracker rules hold here anyway:
 * display only, never read by a routing or signing decision, and every figure
 * unknown rather than zero.
 *
 * ## One block, through Multicall3 only
 *
 * The totals add up hundreds of calls, so every call names the same block:
 * a vault bought or closed between two batches would otherwise be counted in
 * one state for one figure and in another for the next. And every call goes
 * through Multicall3, never to the factory or a vault directly: a network
 * service key restricted to a list of contracts can list Multicall3, but it
 * can never list a vault made after the key was set up.
 *
 * A factory with no code answers a Multicall3 call with empty data, which is
 * how "not deployed on this network" is told apart from "no vaults yet": the
 * first yields no figures at all, never a zero.
 *
 * ## Unknown is never zero
 *
 * A vault whose calls fail is listed as unreadable and left out of every
 * total, and the totals say "at least". So do they when a read stops at its
 * cap. A factory list that can't be read fails the whole read: nothing is
 * shown rather than a guess.
 *
 * Nothing here signs, and no request names the person's address: the owner
 * search reads every listed vault's owner and compares them here.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, Multicall3Reader, TOKENS, type JsonRpc } from "@spdex/chain";
import { DEPLOYMENTS, FACTORY_ABI, MAINNET_DEPLOYMENT, MAINNET_FACTORY, VAULT_ABI, VAULT_LIMITS, type Deployment } from "./artifacts.js";
import { WETH_ABI, decodeOr, decodeVaultProgress, normaliseTerms, vaultProgressCallCount, vaultProgressCalls, type VaultTerms } from "./index.js";
import { DEFAULT_KEEPER_POLICY, deadlineOf, earliestBuyAt, windowOf, type BatchCandidate } from "./keeper-plan.js";

/**
 * Calls per `eth_call`. These are cheap views, about 10,000 gas each, so a
 * batch of 200 stays far under the gas ceiling below while keeping a read of
 * hundreds of vaults to a handful of requests. The reader's own default of 40
 * is sized for gas-heavy quoter calls.
 */
export const PLATFORM_CALLS_PER_REQUEST = 200;

/** The gas ceiling for each `eth_call`, as the keeper uses for the same kind of read. */
export const PLATFORM_REQUEST_GAS = 30_000_000n;

/** Vaults per `vaultsPage` call: the most the factory answers at once. */
export const FACTORY_LIST_PAGE = 1_000;

/**
 * The most vaults one panel read covers. Past it the panel offers to read the
 * rest, and the totals say "at least" until then: at 5,000 vaults a first read
 * is already about 150 requests.
 */
export const MAX_PLATFORM_VAULTS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What never changes about a vault: its owner and its terms. A vault's
 * address commits to both (`predictVault`), so a cached answer can't go
 * stale, even across a restarted fork. The owner search reads only the
 * owner, so `terms` may be missing.
 */
export interface VaultIdentity {
  owner: Address;
  terms?: VaultTerms;
}

/** Vault identities by lowercase address, kept by the caller, one map per chain. */
export type VaultIdentityCache = Map<Address, VaultIdentity>;

/** One vault's figures, all read at the same block. */
export interface PlatformVault {
  vault: Address;
  owner: Address;
  terms: VaultTerms;
  closed: boolean;
  buysDone: bigint;
  /** Everything delivered to the owner, raw `terms.tokenOut` units. */
  totalOut: bigint;
  /** WETH the vault holds, in wei. Anyone can send a vault WETH, so this can exceed its plan. */
  wethBalance: bigint;
}

/** What one release's factory showed at the block. */
export type PlatformDeployment =
  | { id: string; factory: Address; state: "not-deployed" }
  | {
      id: string;
      factory: Address;
      state: "read";
      /** `vaultCount()`: every vault the factory has made. Exact. */
      count: bigint;
      /** The listed vaults whose every figure was read. */
      vaults: PlatformVault[];
      /** Listed vaults with a call that failed or didn't decode: left out of every total. */
      unreadable: Address[];
      /** How far down its list the read got: the vaults from here to `count` weren't read (the cap). */
      listed: number;
    };

export interface PlatformRead {
  /** The block every figure was read at. */
  block: bigint;
  deployments: PlatformDeployment[];
  /** Requests this read made to the network service, `eth_blockNumber` included. */
  requests: number;
}

export interface ReadPlatformOptions {
  /** The releases to read, oldest first. Every one there is, by default. */
  deployments?: readonly Pick<Deployment, "id" | "factory">[];
  /** The block to read at. The latest, by default, asked for once. */
  block?: bigint;
  /** Owners and terms already read on this chain; filled in as they are read. */
  cache?: VaultIdentityCache;
  /** The most vaults this read covers, across releases (`MAX_PLATFORM_VAULTS`). */
  maxVaults?: number;
  /**
   * A read that stopped at its cap: this one reads the vaults it left, at its
   * block, and returns both as one. Its releases and counts are kept, not
   * read again: at the same block they can't have changed.
   */
  previous?: PlatformRead;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * Every vault's figures at one block: whether each release's factory is
 * there, its list, and per vault its owner and terms (once per chain, from
 * `cache` after that), progress, whether it's closed, what it delivered and
 * the WETH it holds.
 *
 * Requests: 2 + ⌈N/1000⌉ + ⌈6N/200⌉ the first time, and 2 + ⌈N/1000⌉ +
 * ⌈4N/200⌉ once owners and terms are cached: 13 then 10 at N = 301.
 *
 * Throws when the block, the factories or a list can't be read. A vault that
 * can't be read goes in `unreadable`; it never counts as zero.
 */
export async function readPlatform(rpc: JsonRpc, options: ReadPlatformOptions = {}): Promise<PlatformRead> {
  const counted = countRequests(rpc);
  const previous = options.previous;
  const block = previous?.block ?? options.block ?? (await latestBlock(counted.rpc));
  let budget = checkedMax(options.maxVaults ?? MAX_PLATFORM_VAULTS);

  const deployments: PlatformDeployment[] =
    previous?.deployments.map((d) => (d.state === "read" ? { ...d, vaults: [...d.vaults], unreadable: [...d.unreadable] } : d)) ??
    (await readDeployments(counted.rpc, options.deployments ?? DEPLOYMENTS, block));

  for (const deployment of deployments) {
    if (deployment.state !== "read") continue;
    const left = deployment.count - BigInt(deployment.listed);
    const take = left < BigInt(budget) ? Number(left) : budget;
    if (take <= 0) continue;
    const listed = await readFactoryPages(counted.rpc, deployment.factory, { block, from: deployment.listed, count: take });
    const figures = await readVaultFigures(counted.rpc, listed, { block, ...(options.cache ? { cache: options.cache } : {}) });
    for (const vault of listed) {
      const read = figures.get(vault);
      if (read) deployment.vaults.push(read);
      else deployment.unreadable.push(vault);
    }
    deployment.listed += listed.length;
    budget -= listed.length;
  }
  return { block, deployments, requests: (previous?.requests ?? 0) + counted.requests() };
}

/**
 * Which of `deployments` have a factory at `block`, and how many vaults each
 * has made: one Multicall3 call for all of them.
 */
async function readDeployments(
  rpc: JsonRpc,
  deployments: readonly Pick<Deployment, "id" | "factory">[],
  block: bigint,
): Promise<PlatformDeployment[]> {
  const counts = await factoryCounts(rpc, deployments.map((d) => lower(d.factory)), block);
  return deployments.map((d, index) => {
    const factory = lower(d.factory);
    const count = counts[index]!;
    return count === null
      ? { id: d.id, factory, state: "not-deployed" }
      : { id: d.id, factory, state: "read", count, vaults: [], unreadable: [], listed: 0 };
  });
}

/**
 * Each factory's `vaultCount()` at `block`, or null for one with no code
 * there. Through Multicall3, a call to an address with no code succeeds and
 * returns nothing, which is what "not deployed" looks like; a deployed factory
 * always answers this view. The request failing throws: then nothing is known.
 */
export async function factoryCounts(rpc: JsonRpc, factories: readonly Address[], block: bigint): Promise<(bigint | null)[]> {
  if (factories.length === 0) return [];
  const results = await pinned(rpc).multicall(
    factories.map((factory) => ({ to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }) })),
    pinnedOptions(block),
  );
  return results.map((data) => decodeOr(data, (d) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", data: d })));
}

/**
 * `count` vaults from `factory`'s list starting at index `from`, oldest first
 * and lowercase, one request per `FACTORY_LIST_PAGE`. Every one is a vault the
 * factory vouches for: the call that set `isVault` also appended it.
 *
 * Throws when a page can't be read or comes back short: a list with a hole in
 * it would drop vaults from every total without saying so.
 */
export async function readFactoryPages(
  rpc: JsonRpc,
  factory: Address,
  options: { block: bigint; from: number; count: number },
): Promise<Address[]> {
  const reader = pinned(rpc);
  const vaults: Address[] = [];
  for (let offset = options.from; offset < options.from + options.count; offset += FACTORY_LIST_PAGE) {
    const want = Math.min(FACTORY_LIST_PAGE, options.from + options.count - offset);
    const [data] = await reader.multicall(
      [{ to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultsPage", args: [BigInt(offset), BigInt(want)] }) }],
      pinnedOptions(options.block),
    );
    const page = decodeOr(data, (d) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", data: d }));
    if (page === null || page.length !== want) {
      throw new Error(`the factory's list didn't answer for vaults ${offset + 1} to ${offset + want} at block ${options.block}`);
    }
    vaults.push(...page.map(lower));
  }
  return vaults;
}

/**
 * Each vault's owner, from `cache` where it's there: the only call the owner
 * search makes per vault, and never one that names whose vaults it wants. A
 * vault whose owner can't be read is missing from the result.
 */
export async function readVaultOwners(
  rpc: JsonRpc,
  vaults: readonly Address[],
  options: { block: bigint; cache?: VaultIdentityCache },
): Promise<Map<Address, Address>> {
  const owners = new Map<Address, Address>();
  const unknown: Address[] = [];
  for (const vault of vaults) {
    const cached = options.cache?.get(vault);
    if (cached) owners.set(vault, cached.owner);
    else unknown.push(vault);
  }
  const results = await pinned(rpc).multicall(
    unknown.map((vault) => ({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) })),
    pinnedOptions(options.block),
  );
  unknown.forEach((vault, index) => {
    const owner = decodeOr(results[index], (d) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data: d }));
    if (owner === null) return;
    owners.set(vault, lower(owner));
    options.cache?.set(vault, { owner: lower(owner) });
  });
  return owners;
}

/**
 * Each of `vaults` that `factory` vouches for (`isVault`), with its owner, in
 * one Multicall3 at the reader's block (the newest unless it says otherwise).
 * A vault the factory doesn't vouch for, or whose answers don't decode, is
 * left out: only the factory's word makes a contract a vault. The request
 * failing throws.
 */
export async function readVouchedOwners(
  rpc: JsonRpc,
  factory: Address,
  vaults: readonly Address[],
  options: { reader?: Pick<Multicall3Reader, "multicall"> } = {},
): Promise<Map<Address, Address>> {
  const calls = vaults.flatMap((vault) => [
    { to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [vault] }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) },
  ]);
  const results = await (options.reader ?? new Multicall3Reader(rpc)).multicall(calls);
  const owners = new Map<Address, Address>();
  vaults.forEach((vault, i) => {
    const vouched = decodeOr(results[2 * i], (d) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", data: d }));
    const owner = decodeOwner(results[2 * i + 1]);
    if (vouched === true && owner !== null) owners.set(lower(vault), owner);
  });
  return owners;
}

type FigureView = "owner" | "terms" | "buysDone" | "closed" | "totalOut" | "weth";

/**
 * Every listed vault's figures, 4 calls each once its owner and terms are
 * cached and 6 before. A vault with any call that fails is missing from the
 * result: a total that silently took it as zero would be wrong.
 */
async function readVaultFigures(
  rpc: JsonRpc,
  vaults: readonly Address[],
  options: { block: bigint; cache?: VaultIdentityCache },
): Promise<Map<Address, PlatformVault>> {
  const plan: { vault: Address; view: FigureView }[] = [];
  for (const vault of vaults) {
    const cached = options.cache?.get(vault);
    if (!cached) plan.push({ vault, view: "owner" });
    if (!cached?.terms) plan.push({ vault, view: "terms" });
    for (const view of ["buysDone", "closed", "totalOut", "weth"] as const) plan.push({ vault, view });
  }
  const results = await pinned(rpc).multicall(
    plan.map(({ vault, view }) =>
      view === "weth"
        ? { to: lower(MAINNET_DEPLOYMENT.weth), data: encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [vault] }) }
        : { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: view }) },
    ),
    pinnedOptions(options.block),
  );

  const answers = new Map<Address, Partial<Record<FigureView, string>>>();
  plan.forEach(({ vault, view }, index) => {
    const entry = answers.get(vault) ?? {};
    entry[view] = results[index] ?? "0x";
    answers.set(vault, entry);
  });

  const figures = new Map<Address, PlatformVault>();
  for (const vault of vaults) {
    const raw = answers.get(vault) ?? {};
    const cached = options.cache?.get(vault);
    const owner = cached?.owner ?? decodeOwner(raw.owner);
    const terms = cached?.terms ?? decodeOr(raw.terms, (d) => normaliseTerms(decodeFunctionResult({ abi: VAULT_ABI, functionName: "terms", data: d })));
    if (owner !== null && terms !== null) options.cache?.set(vault, { owner, terms });
    const buysDone = decodeOr(raw.buysDone, (d) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data: d })));
    const closed = decodeOr(raw.closed, (d) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "closed", data: d }));
    const totalOut = decodeOr(raw.totalOut, (d) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "totalOut", data: d }));
    const wethBalance = decodeOr(raw.weth, (d) => decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data: d }));
    if (owner === null || terms === null || buysDone === null || closed === null || totalOut === null || wethBalance === null) continue;
    figures.set(vault, { vault, owner, terms, closed, buysDone, totalOut, wethBalance });
  }
  return figures;
}

function decodeOwner(data: string | undefined): Address | null {
  const owner = decodeOr(data, (d) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data: d }));
  return owner === null ? null : lower(owner);
}

// ─── Adding up ────────────────────────────────────────────────────────────────

/** A total, and whether it is only a lower bound because some vaults weren't read. */
export interface Known<T> {
  value: T;
  atLeast: boolean;
}

/** What vaults buying some other market's token delivered, raw units of that token. */
export interface OtherMarketDelivered {
  tokenOut: Address;
  delivered: Known<bigint>;
}

export type PlatformSummary =
  | { state: "not-deployed"; block: bigint; requests: number }
  | {
      state: "read";
      block: bigint;
      requests: number;
      /** Every vault the factories have made (`vaultCount`): exact, read or not. */
      made: bigint;
      /** Vaults whose figures were read. */
      read: number;
      /** Listed vaults a call failed for, left out of the totals. */
      unreadable: number;
      /** Vaults past the read's cap, not read yet. */
      unread: bigint;
      /** Σ buysDone. */
      buys: Known<bigint>;
      /** Σ totalOut of vaults buying SPX, raw SPX units (8 decimals). */
      spxDelivered: Known<bigint>;
      /** The same for any other market, one entry per token, first seen first. */
      otherDelivered: OtherMarketDelivered[];
      /** Not closed, with buys left. */
      open: Known<bigint>;
      /** Not closed, every buy made. */
      finished: Known<bigint>;
      closed: Known<bigint>;
      /** Distinct owner addresses. Addresses, not people. */
      owners: Known<bigint>;
      /** Σ buysDone × amountPerBuy, wei: every buy spends exactly its amount. */
      ethSpent: Known<bigint>;
      /** Σ buysDone × keeperReward, wei: what callers of `execute` were paid. */
      fees: Known<bigint>;
      /** Over open vaults, Σ min(WETH held, buys left × (amountPerBuy + keeperReward)), wei. */
      committed: Known<bigint>;
      /** Σ WETH held by vaults that aren't closed, wei. */
      held: Known<bigint>;
    };

/**
 * The panel's figures from a read. Pure. Where no release's factory is
 * deployed there are no figures at all, never zeros. Every total is "at
 * least" while any listed vault is unreadable or unread.
 */
export function summarisePlatform(read: PlatformRead): PlatformSummary {
  const deployed = read.deployments.filter((d): d is Extract<PlatformDeployment, { state: "read" }> => d.state === "read");
  if (deployed.length === 0) return { state: "not-deployed", block: read.block, requests: read.requests };

  const vaults = deployed.flatMap((d) => d.vaults);
  const unreadable = deployed.reduce((sum, d) => sum + d.unreadable.length, 0);
  const made = deployed.reduce((sum, d) => sum + d.count, 0n);
  const unread = deployed.reduce((sum, d) => sum + (d.count - BigInt(d.listed)), 0n);
  const atLeast = unreadable > 0 || unread > 0n;
  const known = (value: bigint): Known<bigint> => ({ value, atLeast });
  const spx = lower(TOKENS.SPX.address);

  let buys = 0n;
  let spxDelivered = 0n;
  const other = new Map<Address, bigint>();
  let open = 0n;
  let finished = 0n;
  let closed = 0n;
  let ethSpent = 0n;
  let fees = 0n;
  let committed = 0n;
  let held = 0n;
  const owners = new Set<Address>();

  for (const v of vaults) {
    const { terms } = v;
    buys += v.buysDone;
    if (terms.tokenOut === spx) spxDelivered += v.totalOut;
    else other.set(terms.tokenOut, (other.get(terms.tokenOut) ?? 0n) + v.totalOut);
    owners.add(v.owner);
    ethSpent += v.buysDone * terms.amountPerBuy;
    fees += v.buysDone * terms.keeperReward;
    if (v.closed) {
      closed += 1n;
      continue;
    }
    held += v.wethBalance;
    const buysLeft = terms.maxBuys > v.buysDone ? terms.maxBuys - v.buysDone : 0n;
    if (buysLeft === 0n) {
      finished += 1n;
      continue;
    }
    open += 1n;
    const needed = buysLeft * (terms.amountPerBuy + terms.keeperReward);
    committed += v.wethBalance < needed ? v.wethBalance : needed;
  }

  return {
    state: "read",
    block: read.block,
    requests: read.requests,
    made,
    read: vaults.length,
    unreadable,
    unread,
    buys: known(buys),
    spxDelivered: known(spxDelivered),
    otherDelivered: [...other].map(([tokenOut, delivered]) => ({ tokenOut, delivered: known(delivered) })),
    open: known(open),
    finished: known(finished),
    closed: known(closed),
    owners: known(BigInt(owners.size)),
    ethSpent: known(ethSpent),
    fees: known(fees),
    committed: known(committed),
    held: known(held),
  };
}

/**
 * Requests a read of `vaults` more vaults costs, `cached` of them with owner
 * and terms already known: ⌈N/1000⌉ list pages and ⌈calls/200⌉ figure
 * batches, plus `fixed` for the block and the factory count (none when
 * reading on from an earlier read). For a button that says what it costs
 * before it's pressed.
 */
export function platformReadCost(vaults: number, cached = 0, fixed = 2): number {
  const fresh = Math.max(0, vaults - cached);
  const calls = 6 * fresh + 4 * (vaults - fresh);
  return fixed + Math.ceil(vaults / FACTORY_LIST_PAGE) + Math.ceil(calls / PLATFORM_CALLS_PER_REQUEST);
}

// ─── Due buys, for "Help run the network" ─────────────────────────────────────

/** Vaults per request when reading due buys: five calls each, and the block's time once. */
export const DUE_VAULTS_PER_REQUEST = 30;

const MULTICALL3_TIME_ABI = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);

/**
 * One vault whose buy is due and would go through at the block read: a
 * `BatchCandidate` for `selectBatch`, with what the read found.
 */
export interface DueCandidate extends BatchCandidate {
  buysDone: bigint;
  /** WETH the vault held. */
  weth: bigint;
  /** `quote()` at the block: what the buy would deliver now, and the least it may. */
  spotOut: bigint;
  floorOut: bigint;
}

/**
 * The vaults of `read` whose next buy is due at `block` and would go through
 * there: for the app's offer to make them from the person's wallet.
 *
 * Candidates are `read`'s own: not closed, buys left, and WETH for a buy and
 * its fee. Only `factory`'s (the batcher is bound to one factory, and would
 * skip any other's as `NotFromFactory`). Each is read again at `block` with
 * the calls the keeper reads a vault with (`vaultProgressCalls`, five with
 * `quote()`), and the block's time from Multicall3 in the same request. Due is
 * worked out here with `earliestBuyAt`, at the block's own time, which a later
 * block only passes.
 *
 * Kept: due, funded, open, an oracle deep enough to price the buy, and a
 * price at or above the floor — the vault's own checks, computed ahead. A
 * vault any of whose calls fails is left out: not known to be due is not due.
 * Nothing here decides what is worth sending (`selectBatch` does), and the
 * batch's own simulation is what the Guard judges.
 *
 * Requests: ⌈(5N + 1) / 151⌉ for N candidates, one for every 30.
 */
export async function readDueCandidates(
  rpc: JsonRpc,
  read: PlatformRead,
  options: { block: bigint; factory?: Address },
): Promise<DueCandidate[]> {
  const factory = lower(options.factory ?? MAINNET_FACTORY);
  const deployment = read.deployments.find((d) => d.state === "read" && d.factory === factory);
  if (deployment === undefined || deployment.state !== "read") return [];
  const candidates = deployment.vaults
    .map((vault, order) => ({ vault, order }))
    .filter(({ vault }) => {
      const t = vault.terms;
      return !vault.closed && vault.buysDone < t.maxBuys && vault.wethBalance >= t.amountPerBuy + t.keeperReward;
    });
  if (candidates.length === 0) return [];

  const per = vaultProgressCallCount(true);
  // The block's time goes in the same batch as the vaults' calls, so N candidates still take ⌈(5N + 1) / 151⌉ requests.
  const calls = [
    { to: lower(CONTRACTS.multicall3), data: encodeFunctionData({ abi: MULTICALL3_TIME_ABI, functionName: "getCurrentBlockTimestamp" }) },
    ...candidates.flatMap(({ vault: { vault } }) => vaultProgressCalls(vault, MAINNET_DEPLOYMENT.weth, true)),
  ];
  const results = await pinned(rpc).multicall(calls, {
    ...pinnedOptions(options.block),
    batchSize: 1 + per * DUE_VAULTS_PER_REQUEST,
  });
  const time = decodeOr(results[0], (d) => decodeFunctionResult({ abi: MULTICALL3_TIME_ABI, functionName: "getCurrentBlockTimestamp", data: d }));
  // Without the block's time nothing can be judged due.
  if (time === null) throw new Error(`the time of block ${options.block} couldn't be read`);

  const due: DueCandidate[] = [];
  candidates.forEach(({ vault: v, order }, i) => {
    const { buysDone, lastBuyAt, closed, balance: weth, quote } = decodeVaultProgress(results, 1 + i * per, true);
    if (buysDone === null || lastBuyAt === null || closed === null || weth === null || quote === null) return;
    const t = v.terms;
    if (closed || weth < t.amountPerBuy + t.keeperReward) return;
    const earliest = earliestBuyAt(t, buysDone, lastBuyAt);
    if (earliest === null || earliest > time) return;
    const { spotOut, floorOut, oracleDepth } = quote;
    if (oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH || spotOut < floorOut) return;
    due.push({
      vault: v.vault,
      owner: v.owner,
      // Its place among the vaults read, which keeps the factory's list order.
      order: BigInt(order),
      pair: t.pair,
      amountPerBuy: t.amountPerBuy,
      interval: t.interval,
      reward: t.keeperReward,
      firstBuy: buysDone === 0n,
      urgent: false,
      deadline: deadlineOf(t, windowOf(t, time), DEFAULT_KEEPER_POLICY),
      subsidised24h: 0n,
      buysDone,
      weth,
      spotOut,
      floorOut,
    });
  });
  return due;
}

// ─── Plumbing ─────────────────────────────────────────────────────────────────

const lower = (a: string): Address => a.toLowerCase() as Address;

const hexBlock = (block: bigint): Hex => `0x${block.toString(16)}`;

function pinned(rpc: JsonRpc): Multicall3Reader {
  return new Multicall3Reader(rpc);
}

function pinnedOptions(block: bigint) {
  return { blockTag: hexBlock(block), batchSize: PLATFORM_CALLS_PER_REQUEST, gas: PLATFORM_REQUEST_GAS };
}

/** The newest block number, for pinning every read after it. */
export async function latestBlock(rpc: JsonRpc): Promise<bigint> {
  const answer = await rpc("eth_blockNumber", []);
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer)) throw new Error("the network service didn't say which block is newest");
  return BigInt(answer);
}

function checkedMax(max: number): number {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError(`maxVaults must be a whole number, at least 0 (got ${max})`);
  return max;
}

/** The same endpoint, counting what is sent through it, for the panel's "(13 reads)". */
function countRequests(rpc: JsonRpc): { rpc: JsonRpc; requests: () => number } {
  let requests = 0;
  return {
    rpc: (method, params) => {
      requests += 1;
      return rpc(method, params);
    },
    requests: () => requests,
  };
}
