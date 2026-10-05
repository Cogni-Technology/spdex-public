/**
 * Collective DCA: what every auto-buy vault has done, read from the chain
 * alone — the figures behind the app's "Collective DCA: auto-buy vaults"
 * panel, the factory-list owner search behind "Find my vaults", which
 * vaults' buys are due for "Help run the network" (`readDueCandidates`), and
 * which vaults in a transaction a listed factory vouches for, with their
 * owners, for the app's `#receipt=` view (`readVouchedOwners`).
 *
 * Every release's factory is read (`DEPLOYMENTS`: v1's, frozen on mainnet, and
 * every later one), and the totals cover them all. A vault's terms are decoded
 * with its release's source's ABI (`decodeTerms`), since v1's and v2's differ
 * by the community window and its turns, and nothing here asks which release
 * a vault is, only what its source can do (`featuresOf`). For the releases
 * whose vaults have a community window (v2 on) the panel also shows the share
 * of buys SPX holders made inside their windows, from each vault's own
 * `windowBuys` counter read with its other figures at the same block — never
 * from log searches, which a service can cap or refuse — and known only when
 * every such vault was read.
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
import { DEPLOYMENTS, FACTORY_ABI, MAINNET_DEPLOYMENT, MAINNET_FACTORY, SOURCES, VAULT_ABI, VAULT_LIMITS, type SourceId } from "./artifacts.js";
import {
  WETH_ABI,
  decodeOr,
  decodeTerms,
  decodeVaultProgress,
  vaultProgressCallCount,
  vaultProgressCalls,
  type VaultTerms,
} from "./index.js";
import { LATEST_RELEASE, deploymentOf, featuresOf, releaseOfFactory, type VaultRelease } from "./releases.js";
import { DEFAULT_KEEPER_POLICY, deadlineOf, dueSinceAt, earliestBuyAt, turnEndsAtOf, windowOf, type BatchCandidate } from "./keeper-plan.js";

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
  /** The release of the factory that listed it. */
  release: VaultRelease;
  owner: Address;
  terms: VaultTerms;
  closed: boolean;
  buysDone: bigint;
  /** Everything delivered to the owner, raw `terms.tokenOut` units. */
  totalOut: bigint;
  /** WETH the vault holds, in wei. Anyone can send a vault WETH, so this can exceed its plan. */
  wethBalance: bigint;
  /**
   * Buys made inside their community window and paid to someone other than the
   * owner: SPX holders' (`windowBuys()`). `null` for a vault whose source has no
   * window (v1); one with a window whose count can't be read is unreadable,
   * never 0.
   */
  windowBuys: bigint | null;
}

/** What one release's factory showed at the block. */
export type PlatformDeployment =
  | { id: string; release: VaultRelease; factory: Address; state: "not-deployed" }
  | {
      id: string;
      release: VaultRelease;
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

/**
 * A factory to read, and which release it is: by default the release
 * `releaseOfFactory` knows it as, else the listed release with its id, else
 * the latest.
 */
export interface PlatformFactory {
  id: string;
  factory: Address;
  release?: VaultRelease;
}

export interface ReadPlatformOptions {
  /** The releases to read, oldest first. Every one there is (`DEPLOYMENTS`), by default. */
  deployments?: readonly PlatformFactory[];
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
 * `cache` after that), progress, whether it's closed, what it delivered, the
 * WETH it holds and, for a v2 vault, its community-window buys.
 *
 * Requests: 2, then per release ⌈N/1000⌉ list pages and ⌈cN/200⌉ figure
 * batches for its N vaults, where c is 6 calls a vault for v1 and 7 for v2 the
 * first time, and 4 and 5 once owners and terms are cached
 * (`platformReadCost`): 13 then 10 for 301 v1 vaults, 14 then 11 for 301 v2.
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
    const figures = await readVaultFigures(counted.rpc, listed, {
      block,
      release: deployment.release,
      ...(options.cache ? { cache: options.cache } : {}),
    });
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
async function readDeployments(rpc: JsonRpc, deployments: readonly PlatformFactory[], block: bigint): Promise<PlatformDeployment[]> {
  const counts = await factoryCounts(rpc, deployments.map((d) => lower(d.factory)), block);
  return deployments.map((d, index) => {
    const factory = lower(d.factory);
    const release = releaseOfPlatformFactory(d);
    const count = counts[index]!;
    return count === null
      ? { id: d.id, release, factory, state: "not-deployed" }
      : { id: d.id, release, factory, state: "read", count, vaults: [], unreadable: [], listed: 0 };
  });
}

/** Which release a factory to read is: as it says, or as spDEX lists it, or the listed release with its id, or the latest. */
function releaseOfPlatformFactory(d: PlatformFactory): VaultRelease {
  return d.release ?? releaseOfFactory(d.factory) ?? DEPLOYMENTS.find((listed) => listed.id === d.id)?.id ?? LATEST_RELEASE;
}

/** Whether terms are the shape `source`'s vaults hold: a window, and turns, exactly when its terms carry them. */
function fitsSource(terms: VaultTerms, source: SourceId): boolean {
  const f = SOURCES[source].features;
  return (terms.communityWindow !== null) === f.communityWindow && (terms.turnBuckets !== null) === f.turns;
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
 * Each of `vaults` that one of `factories` vouches for (`isVault`), with its
 * owner, in one Multicall3 at the reader's block (the newest unless it says
 * otherwise): one factory, or several, as the `#receipt=` view asks every
 * release's, since a buy may be any release's vault's. A vault no factory
 * asked vouches for, or whose answers don't decode, is left out: only a
 * factory's word makes a contract a vault. The request failing throws.
 */
export async function readVouchedOwners(
  rpc: JsonRpc,
  factories: Address | readonly Address[],
  vaults: readonly Address[],
  options: { reader?: Pick<Multicall3Reader, "multicall"> } = {},
): Promise<Map<Address, Address>> {
  const asked = (typeof factories === "string" ? [factories] : [...factories]).map(lower);
  const per = asked.length + 1;
  const calls = vaults.flatMap((vault) => [
    ...asked.map((factory) => ({ to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [vault] }) })),
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) },
  ]);
  const results = await (options.reader ?? new Multicall3Reader(rpc)).multicall(calls);
  const owners = new Map<Address, Address>();
  vaults.forEach((vault, i) => {
    const vouched = asked.some(
      (_, k) => decodeOr(results[per * i + k], (d) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", data: d })) === true,
    );
    const owner = decodeOwner(results[per * i + asked.length]);
    if (vouched && owner !== null) owners.set(lower(vault), owner);
  });
  return owners;
}

type FigureView = "owner" | "terms" | "buysDone" | "closed" | "totalOut" | "weth" | "windowBuys";

/** Calls a vault's figures take: owner and terms until cached, four always, and the window count where its source has one. */
const figureCalls = (release: VaultRelease, cached: boolean): number =>
  (cached ? 4 : 6) + (featuresOf(release).communityWindow ? 1 : 0);

/**
 * Every listed vault's figures, `figureCalls` each: for a v1 vault 4 once its
 * owner and terms are cached and 6 before, for a vault with a community window
 * (v2 on) one more, its `windowBuys`. Terms are decoded with the release's
 * source's ABI, and must be the shape that source's vaults hold. A vault with
 * any call that fails is missing from the result: a total that silently took
 * it as zero would be wrong.
 */
async function readVaultFigures(
  rpc: JsonRpc,
  vaults: readonly Address[],
  options: { block: bigint; release: VaultRelease; cache?: VaultIdentityCache },
): Promise<Map<Address, PlatformVault>> {
  const { release } = options;
  const source = deploymentOf(release).source;
  const hasWindow = SOURCES[source].features.communityWindow;
  const plan: { vault: Address; view: FigureView }[] = [];
  for (const vault of vaults) {
    const cached = options.cache?.get(vault);
    if (!cached) plan.push({ vault, view: "owner" });
    if (!cached?.terms) plan.push({ vault, view: "terms" });
    for (const view of ["buysDone", "closed", "totalOut", "weth"] as const) plan.push({ vault, view });
    if (hasWindow) plan.push({ vault, view: "windowBuys" });
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
    const decoded = cached?.terms ?? decodeTerms(raw.terms, source);
    // A listed vault is its factory's release; terms of another shape are not what that factory makes.
    const terms = decoded !== null && fitsSource(decoded, source) ? decoded : null;
    if (owner !== null && terms !== null) options.cache?.set(vault, { owner, terms });
    const buysDone = decodeOr(raw.buysDone, (d) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data: d })));
    const closed = decodeOr(raw.closed, (d) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "closed", data: d }));
    const totalOut = decodeOr(raw.totalOut, (d) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "totalOut", data: d }));
    const wethBalance = decodeOr(raw.weth, (d) => decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data: d }));
    const windowBuys = hasWindow
      ? decodeOr(raw.windowBuys, (d) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "windowBuys", data: d })))
      : null;
    if (owner === null || terms === null || buysDone === null || closed === null || totalOut === null || wethBalance === null) continue;
    if (hasWindow && windowBuys === null) continue;
    figures.set(vault, { vault, release, owner, terms, closed, buysDone, totalOut, wethBalance, windowBuys });
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
      /**
       * Σ buysDone × keeperReward, wei: the buy fees paid, to whoever each buy
       * named (v2: owners included, when Trigger now paid the owner back) or
       * to whoever called (v1).
       */
      fees: Known<bigint>;
      /** Over open vaults, Σ min(WETH held, buys left × (amountPerBuy + keeperReward)), wei. */
      committed: Known<bigint>;
      /** Σ WETH held by vaults that aren't closed, wei. */
      held: Known<bigint>;
      /**
       * Σ buysDone of vaults with a community window (v2 on, whatever
       * release): the buys a window applied to. "At least" while any such
       * vault is unreadable or unread.
       */
      v2Buys: Known<bigint>;
      /**
       * Σ windowBuys of vaults with a community window: the buys SPX holders
       * made inside their windows. With `v2Buys`, the share the panel shows —
       * known only while neither is "at least": a share of a partial read is
       * not a lower bound of anything. And there is no share at all while
       * `v2Buys` is 0, as it is before v2's factory is deployed or any of its
       * vaults has bought: 0 of 0 is not 0%, nor 100%.
       */
      communityWindowBuys: Known<bigint>;
    };

/**
 * The panel's figures from a read, every release's vaults together. Pure.
 * Where no release's factory is deployed there are no figures at all, never
 * zeros. Every total is "at least" while any listed vault is unreadable or
 * unread; the two window figures while any vault with a window is, or its
 * window count is unknown. Where only v1's factory is deployed, both are a
 * true 0: no buy with a window has been made, and there is no share to show.
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
  let v2Buys = 0n;
  let communityWindowBuys = 0n;
  const owners = new Set<Address>();
  const windowed = deployed.filter((d) => featuresOf(d.release).communityWindow);
  // `readVaultFigures` never yields a windowed vault without its window count, but a read built any other way might:
  // its count is then unknown, never 0, and both window figures say "at least" as for a vault left unread.
  const windowUnknown = vaults.some((v) => featuresOf(v.release).communityWindow && v.windowBuys === null);
  const v2AtLeast = windowUnknown || windowed.some((d) => d.unreadable.length > 0 || d.count > BigInt(d.listed));

  for (const v of vaults) {
    const { terms } = v;
    buys += v.buysDone;
    if (featuresOf(v.release).communityWindow) {
      v2Buys += v.buysDone;
      if (v.windowBuys !== null) communityWindowBuys += v.windowBuys;
    }
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
    v2Buys: { value: v2Buys, atLeast: v2AtLeast },
    communityWindowBuys: { value: communityWindowBuys, atLeast: v2AtLeast },
  };
}

/**
 * Requests a read costs, release by release: for each, its `vaults` more
 * vaults, `cached` of them with owner and terms already known, take ⌈N/1000⌉
 * list pages and ⌈calls/200⌉ figure batches (6 calls a fresh v1 vault and 4 a
 * cached one; 7 and 5 for one with a window, which adds `windowBuys`), plus `fixed` for the
 * block and the factory counts (none when reading on from an earlier read).
 * For a button that says what it costs before it's pressed.
 */
export function platformReadCost(reads: readonly { release: VaultRelease; vaults: number; cached?: number }[], fixed = 2): number {
  let requests = fixed;
  for (const { release, vaults, cached = 0 } of reads) {
    if (vaults <= 0) continue;
    const fresh = Math.max(0, vaults - cached);
    const calls = fresh * figureCalls(release, false) + (vaults - fresh) * figureCalls(release, true);
    requests += Math.ceil(vaults / FACTORY_LIST_PAGE) + Math.ceil(calls / PLATFORM_CALLS_PER_REQUEST);
  }
  return requests;
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
  /**
   * The release of the factory that listed it: with `owner`, `terms` and the
   * factory nonce the app finds itself (`findVaultNonce`), what the Guard's
   * claim for a vault in a batch names.
   */
  release: VaultRelease;
  buysDone: bigint;
  /** WETH the vault held. */
  weth: bigint;
  /** `quote()` at the block: what the buy would deliver now, and the least it may. */
  spotOut: bigint;
  floorOut: bigint;
  /** When the buy fell due, chain time: its community window runs from here (`dueSinceAt`). */
  dueSince: bigint;
  /** The first second its fee may be paid to anyone: `dueSince + communityWindow`. */
  windowEndsAt: bigint;
  /**
   * Whether the block's time is inside the community window: then only an
   * eligible SPX holder, or the vault's owner, may be paid for this buy, and
   * a batch paying anyone else is refused it (`NotEligible`).
   */
  inWindow: boolean;
  /**
   * Its terms, every field as the vault holds them (`turnBuckets` included), as
   * the read found them: what `onTurn` needs, with `dueSince`, and what a claim
   * on the vault names.
   */
  terms: VaultTerms;
  /** Its plan's turns: 0 for none, the plan every vault the app creates has. */
  turnBuckets: bigint;
  /**
   * When the buy's turn ends (`turnEndsAtOf`): until then, inside the window,
   * only an eligible holder in the slot's bucket may be paid (`onTurn` says
   * whether an address is; a batch paying another is refused `NotYourTurn`).
   * Null for a plan without turns.
   */
  turnEndsAt: bigint | null;
  /** Whether the block's time is inside the turn. False for a plan without turns. */
  inTurn: boolean;
}

/**
 * The vaults of `read` whose next buy is due at `block` and would go through
 * there: for the app's offer to make them from the person's wallet. Only a
 * release whose vaults take `execute(rewardTo)`, which the batcher sends
 * (decision 27): Help run offers no v1 buys, so a v1 factory has none.
 *
 * Candidates are `read`'s own: not closed, buys left, and WETH for a buy and
 * its fee. Only `factory`'s, the latest release's by default: the batcher is
 * bound to no factory, but a batch the app offers is one release's. Each is
 * read again at `block` with
 * the calls the keeper reads a vault with (`vaultProgressCalls`, five with
 * `quote()`), and the block's time from Multicall3 in the same request. Due is
 * worked out here with `earliestBuyAt`, at the block's own time, which a later
 * block only passes.
 *
 * Kept: due, funded, open, an oracle deep enough to price the buy, and a
 * price at or above the floor — the vault's own checks, computed ahead. A
 * vault any of whose calls fails is left out: not known to be due is not due.
 * Each says when its community window ends and whether the block is inside
 * it, and for a plan with turns when its turn ends; whether the person's
 * wallet may be paid inside either is not a question of this read, which
 * names nobody: the app filters, offering in-window buys only to an eligible
 * wallet, and in-turn ones only to one in the slot's bucket (`onTurn`).
 * Nothing here decides what is worth sending
 * (`selectBatch` does), and the batch's own simulation is what the Guard
 * judges. An in-window buy's deadline is its window's end, after which anyone
 * may take it; a buy past its window keeps its slot's.
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
  if (deployment === undefined || deployment.state !== "read" || !featuresOf(deployment.release).executeTakesRewardTo) return [];
  const candidates = deployment.vaults
    .map((vault, order) => ({ vault, order }))
    .filter(({ vault }) => {
      const t = vault.terms;
      return t.communityWindow !== null && !vault.closed && vault.buysDone < t.maxBuys && vault.wethBalance >= t.amountPerBuy + t.keeperReward;
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
    const dueSince = dueSinceAt(t, buysDone, lastBuyAt, time);
    if (earliest === null || earliest > time || dueSince === null || t.communityWindow === null) return;
    const { spotOut, floorOut, oracleDepth } = quote;
    if (oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH || spotOut < floorOut) return;
    const windowEndsAt = dueSince + t.communityWindow;
    const inWindow = time < windowEndsAt;
    const turnEndsAt = turnEndsAtOf(t, buysDone, lastBuyAt, time);
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
      deadline: inWindow ? windowEndsAt : deadlineOf(t, windowOf(t, time), DEFAULT_KEEPER_POLICY),
      subsidised24h: 0n,
      release: deployment.release,
      buysDone,
      weth,
      spotOut,
      floorOut,
      dueSince,
      windowEndsAt,
      inWindow,
      terms: t,
      turnBuckets: t.turnBuckets ?? 0n,
      turnEndsAt,
      inTurn: turnEndsAt !== null && time < turnEndsAt,
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
