/**
 * The auto-buy vault, from TypeScript: encode what to send, decode what came
 * back, work out where a vault will be before it exists, read a vault's state
 * in one round trip, find every vault an owner created from the chain alone,
 * and say whether a vault can be offered right now.
 *
 * ## What the vault is, in one paragraph
 *
 * A contract cannot wake itself up, so an auto-buy that runs with no spDEX page
 * open needs *someone* to send each buy's transaction. The vault makes it not
 * matter who: it holds one plan's budget (funded up to 0.5 ETH, as WETH) and
 * enforces the plan itself — which token, how much, how often, to whom, and a
 * price floor from Uniswap v3's own 10-minute average — so whoever calls
 * `execute` chooses only *when*, inside a slot that is due, and who receives
 * the caller's own fee: `execute(rewardTo)`. That fee is the plan's buy fee
 * (`keeperReward`, fixed at creation; `fee.ts` has the app's default) — which
 * makes triggering worth someone's while, but does not make anyone do it: a
 * plan runs while somebody runs a keeper. Nobody, spDEX included, can change
 * the terms or move the funds except the owner, and the only stop is "close
 * and withdraw". The full reasoning, and what the price floor does and does not
 * protect against, is at the top of `contracts/SpdexDcaVault.sol`.
 *
 * ## The community window, and every release
 *
 * For the first minutes after each buy falls due (`dueSince`, for the plan's
 * `communityWindow` seconds), a v2 vault pays its fee only to its owner or to
 * an SPX holder the ownerless registry vouches for (`registry.ts`); after
 * that, to anyone, as v1 did (docs/DESIGN.md). The owner may always be
 * paid, so "Trigger now" (`encodeTrigger`) works inside the window. A plan may
 * also share its window's first half out in turns (`turnBuckets`); every plan
 * the app creates has none until decision 29 calls for them.
 *
 * v1's factory, batcher and vaults stay on mainnet unchanged for good: a v1
 * vault's `execute()` takes no argument and pays its caller. So everything
 * here reads every release (`releases.ts`), and asks what a vault's source can
 * do (`featuresOf`) rather than which release it is: terms and status are
 * decoded with the source's own ABI — by their shape when nothing says which,
 * never with one ABI that would silently drop a later source's trailing fields
 * or refuse an earlier one's — events by their topic, and a vault is believed
 * only when one of the listed factories (`DEPLOYMENTS`) vouches for it. New
 * vaults are only ever created on the latest release.
 *
 * ## Markets and clones, in one paragraph each
 *
 * A vault buys on one of the markets its factory was deployed with — a token,
 * its Uniswap v2 pair and the v3 pool its floor is read from, checked against
 * Uniswap's own factories when the factory was deployed — and a plan names one
 * by index. On mainnet the list is exactly SPX (`MAINNET_DEPLOYMENT`); another
 * list is another factory at another address, so `factoryAddress(deployment)`
 * commits to the markets as well as the code.
 *
 * Each vault is an EIP-1167 clone of one implementation with its terms written
 * into the clone's code, which is why creating one costs about 150,000 gas
 * rather than 2.3 million, and why its address — `predictVault` — commits to
 * its terms.
 *
 * ## What this module is not
 *
 * Nothing here signs, and nothing here decides whether a transaction is safe to
 * sign — that is the Guard's job, in the app. These are the encoders and
 * readers both the app and the keeper (`keeper.ts`) build on, with the buy fee
 * (`fee.ts`), the batcher's (`batcher.ts`) and the SPX holder registry's
 * (`registry.ts`). Reads go through the `JsonRpc`
 * the caller passes, which is always the user's own endpoint, and every figure
 * that cannot be read comes back as `null` — unknown, never zero. The keeper and
 * its report are not exported from here: they are operator tools, behind
 * `@spdex/vault/keeper`, and nothing the app imports reaches them.
 */

import {
  concat,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
} from "viem";
import type { Address, Hex } from "@spdex/core";
import {
  CONTRACTS,
  Multicall3Reader,
  inversePriceX18AtTick,
  meanTick,
  priceX18AtTick,
  sqrtRatioAtTick,
  type JsonRpc,
} from "@spdex/chain";
import {
  CURRENT_SOURCE,
  DEPLOYMENTS,
  DETERMINISTIC_DEPLOYER,
  FACTORY_ABI,
  FACTORY_LIMITS,
  MAINNET_DEPLOYMENT,
  SOURCES,
  V1_FACTORY_ABI,
  V1_MAINNET_DEPLOYMENT,
  V1_VAULT_ABI,
  VAULT_ABI,
  VAULT_LIMITS,
  batcherAddress,
  batcherInitCode,
  factoryAddress,
  factoryInitCode,
  registryAddress,
  registryInitCode,
  v1FactoryAddress,
  v1FactoryInitCode,
  type FactoryDeployment,
  type Market,
  type SourceId,
  type V1FactoryDeployment,
} from "./artifacts.js";
import {
  LATEST_RELEASE,
  SOURCE_IDS_NEWEST_FIRST,
  deploymentOf,
  isListedBatcher,
  latestReleaseOf,
  releaseOfFactory,
  sourceOfRelease,
  type VaultRelease,
} from "./releases.js";

export * from "./artifacts.js";
export * from "./releases.js";
export * from "./batcher.js";
export * from "./fee.js";
export * from "./platform.js";
export * from "./registry.js";
/**
 * The keeper's pure planning, for the app's "Help run the network": which due
 * vaults a batch carries and the gas it is signed with, and when a buy's
 * community window ends. Only these, from the one keeper module that reads
 * nothing and signs nothing (keeper-plan.ts imports types, the artifacts and
 * the fee); the keeper itself stays behind `@spdex/vault/keeper`
 * (boundaries.test.ts).
 */
export {
  COMMUNITY_URGENT_SECONDS,
  COMMUNITY_URGENT_SHORT_BELOW,
  DEFAULT_KEEPER_POLICY,
  MAX_BATCH_GAS_CEILING,
  RATIO_ONE,
  batchGasLimit,
  communityWindowEndsAt,
  deadlineOf,
  dueSinceAt,
  earliestBuyAt,
  inCommunityWindow,
  minGasPerAttempt,
  modelBatchGas,
  selectBatch,
  slotStartAt,
  turnEndsAtOf,
  urgentFrom,
  windowOf,
  type BatchCandidate,
  type BatchSelection,
  type BuyWindow,
  type KeeperPolicy,
  type SelectedVault,
} from "./keeper-plan.js";

// ─── Which source a vault's terms are ──────────────────────────────────────────

/**
 * The source terms of this shape belong to, newest first: the one whose terms
 * carry exactly the fields these do (v1's no window, v2's a window and its
 * turns). By shape, for a vault no listed factory has vouched for yet; once
 * one has, its release's source is the answer (`VaultState.source`).
 */
export function sourceOfTerms(terms: Pick<VaultTerms, "communityWindow" | "turnBuckets">): SourceId {
  for (const id of SOURCE_IDS_NEWEST_FIRST) {
    const f = SOURCES[id].features;
    if (f.communityWindow === (terms.communityWindow !== null) && f.turns === (terms.turnBuckets !== null)) return id;
  }
  throw new RangeError("these terms are no source's shape");
}

/**
 * The newest release built from the source these terms' shape belongs to: the
 * release a vault with them would be, if a listed factory made it. A best
 * guess for a vault no factory has vouched for; the vouching factory's release
 * is the answer once one has (`readVault`).
 */
export function releaseOfTerms(terms: Pick<VaultTerms, "communityWindow" | "turnBuckets">): VaultRelease {
  return latestReleaseOf(sourceOfTerms(terms)) ?? LATEST_RELEASE;
}

// ─── Terms ────────────────────────────────────────────────────────────────────

/**
 * One vault's terms, exactly as the contract holds them (`terms()`) and
 * announces them (`VaultCreated`): its market's addresses and its plan. Every
 * number is a bigint because every number in the contract's `Terms` is a
 * uint256; the factory, not the type, is what bounds them.
 */
export interface VaultTerms {
  tokenOut: Address;
  /** The Uniswap v2 WETH/tokenOut pair every buy trades on. */
  pair: Address;
  /** The Uniswap v3 WETH/tokenOut pool whose 10-minute average sets the floor. */
  oraclePool: Address;
  /** WETH (wei) per buy. */
  amountPerBuy: bigint;
  /** Seconds between buy slots. */
  interval: bigint;
  maxBuys: bigint;
  /** Unix seconds, chain time. */
  startAt: bigint;
  /**
   * WETH (wei) paid for each buy: to the `rewardTo` its trigger names (v2), or
   * to whoever called `execute` (v1).
   */
  keeperReward: bigint;
  /**
   * Basis points a buy may pay above the oracle pool's price: the better, for
   * the owner, of its 10-minute average and its price now.
   */
  maxSlippageBps: bigint;
  /**
   * Seconds after each buy falls due during which its fee may be paid only to
   * the owner or an eligible SPX holder: the community window. `null` for a v1
   * vault, which has none and pays whoever calls.
   */
  communityWindow: bigint | null;
  /**
   * How many turns the window's first half is shared out in: 0 for none, 2 to
   * `MAX_TURN_BUCKETS` for a plan with turns (`bucketOf`, `turnOf`). `null` for
   * a vault whose source has no turns (v1).
   */
  turnBuckets: bigint | null;
}

/**
 * What `createVault` takes: a market, by its index in the factory's list, and
 * the plan. Nobody creating a vault names a pair, a pool or a token. Only the
 * latest release creates vaults, so a plan always has a community window.
 */
export interface VaultPlan {
  marketIndex: bigint;
  amountPerBuy: bigint;
  interval: bigint;
  maxBuys: bigint;
  /** Unix seconds, chain time. */
  startAt: bigint;
  keeperReward: bigint;
  maxSlippageBps: bigint;
  /**
   * Seconds of first claim for SPX holders after each buy falls due: at least
   * `MIN_COMMUNITY_WINDOW` (60), at most a quarter of the interval and
   * `MAX_COMMUNITY_WINDOW` (an hour). `defaultCommunityWindow` is the app's.
   */
  communityWindow: bigint;
  /**
   * Turns in the window's first half: 0 for none, or 2 to `MAX_TURN_BUCKETS`.
   * `DEFAULT_TURN_BUCKETS` is the app's: none, until decision 29 calls for them.
   */
  turnBuckets: bigint;
}

/** What a vault can ever hold: `maxBuys × (amountPerBuy + keeperReward)`. */
export function vaultBudget(terms: Pick<VaultTerms, "maxBuys" | "amountPerBuy" | "keeperReward">): bigint {
  return terms.maxBuys * (terms.amountPerBuy + terms.keeperReward);
}

/** The market a plan names in `deployment`'s list, or null for an index the list does not have. */
export function marketOf(plan: Pick<VaultPlan, "marketIndex">, deployment: FactoryDeployment = MAINNET_DEPLOYMENT): Market | null {
  const index = plan.marketIndex;
  return index >= 0n && index < BigInt(deployment.markets.length) ? deployment.markets[Number(index)]! : null;
}

/**
 * The terms a vault created with this plan will hold and announce — its
 * market's addresses, lowercased, and the plan — for comparing with what a
 * simulation of the creation, or the vault itself, says. Throws for a market
 * index the list does not have: such a plan has no vault.
 */
export function termsOfPlan(plan: VaultPlan, deployment: FactoryDeployment = MAINNET_DEPLOYMENT): VaultTerms {
  const market = marketOf(plan, deployment);
  if (!market) throw new RangeError(`market ${plan.marketIndex} is not on this factory's list of ${deployment.markets.length}`);
  return {
    tokenOut: lower(market.tokenOut),
    pair: lower(market.pair),
    oraclePool: lower(market.oraclePool),
    amountPerBuy: plan.amountPerBuy,
    interval: plan.interval,
    maxBuys: plan.maxBuys,
    startAt: plan.startAt,
    keeperReward: plan.keeperReward,
    maxSlippageBps: plan.maxSlippageBps,
    communityWindow: plan.communityWindow,
    turnBuckets: plan.turnBuckets,
  };
}

/**
 * Every reason the factory would refuse this plan, as the contract words its
 * errors, or `[]` — so a form can say what is wrong before anyone pays gas to
 * find out. The start is judged against `now`, which should be chain time.
 * Whether the market can buy right now is `vaultAvailability`'s question.
 */
export function termsProblems(plan: VaultPlan, now: bigint, deployment: FactoryDeployment = MAINNET_DEPLOYMENT): string[] {
  const L = VAULT_LIMITS;
  const problems: string[] = [];
  if (marketOf(plan, deployment) === null) problems.push("UnknownMarket");
  if (plan.amountPerBuy <= 0n || plan.amountPerBuy > L.MAX_FUNDING) problems.push("AmountOutOfRange");
  if (plan.interval < L.MIN_INTERVAL || plan.interval > L.MAX_INTERVAL) problems.push("IntervalOutOfRange");
  if (plan.maxBuys <= 0n || plan.maxBuys > L.MAX_BUYS) problems.push("BuysOutOfRange");
  if (plan.maxSlippageBps <= 0n || plan.maxSlippageBps > L.MAX_SLIPPAGE_BPS) problems.push("SlippageOutOfRange");
  if (plan.keeperReward < 0n || plan.keeperReward * 10_000n > plan.amountPerBuy * L.MAX_REWARD_BPS) {
    problems.push("RewardTooLarge");
  }
  if (vaultBudget(plan) > L.MAX_FUNDING) problems.push("FundingCapExceeded");
  if (plan.startAt > now + L.MAX_START_DRIFT || plan.startAt + L.MAX_START_DRIFT < now) problems.push("StartOutOfRange");
  if (plan.communityWindow < L.MIN_COMMUNITY_WINDOW || plan.communityWindow > maxCommunityWindow(plan.interval)) {
    problems.push("CommunityWindowOutOfRange");
  }
  if (plan.turnBuckets < 0n || plan.turnBuckets === 1n || plan.turnBuckets > L.MAX_TURN_BUCKETS) problems.push("TurnsOutOfRange");
  return problems;
}

// ─── The community window's length ────────────────────────────────────────────

/**
 * The longest community window a plan with this interval may have, as the
 * factory holds it: a quarter of the interval, rounded down, and never more
 * than `MAX_COMMUNITY_WINDOW` (an hour). A window that long ends inside its
 * slot and leaves the rest of it open to anyone (decisions 4 and 12 of
 * docs/DESIGN.md). Every interval the factory accepts allows at least 75
 * seconds, above `MIN_COMMUNITY_WINDOW`.
 */
export function maxCommunityWindow(interval: bigint): bigint {
  const quarter = interval / 4n;
  return quarter < VAULT_LIMITS.MAX_COMMUNITY_WINDOW ? quarter : VAULT_LIMITS.MAX_COMMUNITY_WINDOW;
}

/**
 * The window the app gives a new plan (decision 3): 30 minutes, or a quarter
 * of the interval when that is shorter — 75 seconds for a 5-minute plan, 15
 * minutes for an hourly one, 30 for a daily one. Never below the minute the
 * factory requires.
 */
export function defaultCommunityWindow(interval: bigint): bigint {
  const quarter = interval / 4n;
  const window = quarter < 1_800n ? quarter : 1_800n;
  return window < VAULT_LIMITS.MIN_COMMUNITY_WINDOW ? VAULT_LIMITS.MIN_COMMUNITY_WINDOW : window;
}

/**
 * The windows Expert may choose from (decision 26): 1, 5, 15, 30 and 60
 * minutes, beside "a quarter of the interval" (`maxCommunityWindow`). A preset
 * above `maxCommunityWindow(interval)` is one the factory would refuse, and the
 * app offers it disabled.
 */
export const COMMUNITY_WINDOW_PRESETS: readonly bigint[] = [60n, 300n, 900n, 1_800n, 3_600n];

// ─── Turns ────────────────────────────────────────────────────────────────────

/**
 * The turns the app gives a new plan: none. The vault can share each window's
 * first half out in turns among buckets of addresses (`turnBuckets`, 2 to
 * `MAX_TURN_BUCKETS`), so that a bot needs a proven address in every bucket to
 * have first claim on every buy (one 690 SPX, moved into each at its buy, can
 * serve them all: docs/DESIGN.md, "Risks and failure modes"); it ships
 * unused, and the app turns it on for new plans, with no contract deployed,
 * if decision 29 of docs/DESIGN.md trips: one `rewardTo` winning more
 * than half the window buys for 30 days.
 */
export const DEFAULT_TURN_BUCKETS = 0n;

/**
 * The bucket `holder` is in on a plan with `turnBuckets` turns: the vault's
 * own `bucketOf`, keccak256 of the address, ABI-encoded, modulo the buckets.
 * 0 for a plan without turns, where every address is in the one bucket.
 */
export function bucketOf(holder: Address, turnBuckets: bigint): bigint {
  if (turnBuckets === 0n) return 0n;
  return BigInt(keccak256(encodeAbiParameters([{ type: "address" }], [holder]))) % turnBuckets;
}

/**
 * The bucket whose eligible holders have first claim on `vault`'s buy in slot
 * `slot` (counted from its start, as `Bought` counts it), for the first half of
 * its window: the vault's own `turnOf`, keccak256 of the vault and the slot,
 * ABI-encoded, modulo the buckets. 0 for a plan without turns.
 */
export function turnOf(vault: Address, slot: bigint, turnBuckets: bigint): bigint {
  if (turnBuckets === 0n) return 0n;
  return BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [vault, slot]))) % turnBuckets;
}

/**
 * Whether `rewardTo` may be paid for `vault`'s buy that fell due at `dueSince`,
 * at `now`, as far as turns go: always for a plan without turns, for the
 * owner, and from the turn's end (`dueSince + communityWindow / 2`); inside
 * the turn, only for an address in the slot's bucket. Says nothing about
 * eligibility, which is the registry's, nor about the window, which is
 * `inCommunityWindow`'s.
 */
export function onTurn(input: {
  vault: Address;
  owner: Address;
  rewardTo: Address;
  terms: Pick<VaultTerms, "startAt" | "interval" | "communityWindow" | "turnBuckets">;
  dueSince: bigint;
  now: bigint;
}): boolean {
  const k = input.terms.turnBuckets ?? 0n;
  const window = input.terms.communityWindow ?? 0n;
  if (k === 0n || input.now >= input.dueSince + window / 2n || lower(input.rewardTo) === lower(input.owner)) return true;
  const slot = (input.dueSince - input.terms.startAt) / input.terms.interval;
  return bucketOf(lower(input.rewardTo), k) === turnOf(lower(input.vault), slot, k);
}

// ─── Encoding ─────────────────────────────────────────────────────────────────

/**
 * `createVault`'s calldata. Ether sent with it — up to the plan's whole budget,
 * `vaultBudget(plan)` — arrives in the new vault as WETH in the same
 * transaction; more is refused (`FundingExceedsNeed`).
 */
export const encodeCreateVault = (plan: VaultPlan): Hex =>
  encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "createVault",
    args: [
      plan.marketIndex,
      plan.amountPerBuy,
      plan.interval,
      plan.maxBuys,
      plan.startAt,
      plan.keeperReward,
      plan.maxSlippageBps,
      plan.communityWindow,
      plan.turnBuckets,
    ],
  });

/** The ether to fund with travels as the transaction's value; the calldata is only the selector. Both releases. */
export const encodeFund = (): Hex => encodeFunctionData({ abi: VAULT_ABI, functionName: "fund" });

/**
 * A v2 vault's `execute(rewardTo)`: make the buy that is due, and pay its fee
 * to `rewardTo`. Inside the buy's community window the vault refuses any
 * `rewardTo` but its owner and an eligible SPX holder (`NotEligible`); after
 * it, any address but zero and the vault itself. The one argument says who
 * receives the caller's fee and nothing about the buy (decision 11).
 */
export const encodeExecute = (rewardTo: Address): Hex => encodeFunctionData({ abi: VAULT_ABI, functionName: "execute", args: [rewardTo] });

/** A v1 vault's `execute()`, selector 0x61461954: make the buy that is due, and pay its fee to the caller. */
export const encodeExecuteV1 = (): Hex => encodeFunctionData({ abi: V1_VAULT_ABI, functionName: "execute" });

/**
 * "Trigger now"'s calldata for a vault of any release: `execute(owner)` where
 * its source takes `rewardTo` — the community window never refuses it, and it
 * pays the fee back to the owner — or v1's `execute()`, which pays it to
 * whoever sends it: the owner, when the owner triggers.
 */
export function encodeTrigger(vault: { release: VaultRelease; owner: Address }): Hex {
  return sourceOfRelease(vault.release).features.executeTakesRewardTo ? encodeExecute(lower(vault.owner)) : encodeExecuteV1();
}

/** Every release. */
export const encodeClose = (): Hex => encodeFunctionData({ abi: VAULT_ABI, functionName: "close" });
/** Every release. */
export const encodeRescue = (token: Address): Hex =>
  encodeFunctionData({ abi: VAULT_ABI, functionName: "rescue", args: [token] });

/**
 * The one-time, permissionless deployment of the factory for `deployment`, and
 * the address it will land at. Anyone may send it, and whoever does, the list
 * is the same. It succeeds while every listed market passes the factory's
 * listing checks and the registry it names has code (`deployRegistryCall`
 * first); sent where the factory already exists, or while a check fails, it
 * reverts and changes nothing — and says nothing about why, because the
 * deterministic deployer reverts with no reason of its own.
 * `simulateFactoryDeployment` asks first and names the check;
 * `vaultAvailability` offers this only when that passes.
 */
export function deployFactoryCall(deployment: FactoryDeployment = MAINNET_DEPLOYMENT): {
  to: Address;
  data: Hex;
  value: bigint;
  factory: Address;
} {
  return {
    to: DETERMINISTIC_DEPLOYER,
    // The deterministic deployer's whole interface: 32 bytes of salt, then init code.
    data: `0x${SOURCES[CURRENT_SOURCE].factorySalt.slice(2)}${factoryInitCode(deployment).slice(2)}` as Hex,
    value: 0n,
    factory: factoryAddress(deployment),
  };
}

/**
 * The one-time, permissionless deployment of the SPX holder registry, and the
 * address it lands at (`MAINNET_REGISTRY` on any chain with the deterministic
 * deployer: it takes no constructor arguments). It goes first: a v2 factory's
 * constructor refuses a registry with no code (`NotARegistry`). Sent where the
 * registry already exists, it reverts and changes nothing.
 */
export function deployRegistryCall(): { to: Address; data: Hex; value: bigint; registry: Address } {
  return {
    to: DETERMINISTIC_DEPLOYER,
    data: `0x${SOURCES[CURRENT_SOURCE].registrySalt!.slice(2)}${registryInitCode().slice(2)}` as Hex,
    value: 0n,
    registry: registryAddress(),
  };
}

/**
 * v1's factory, from its frozen source: deployed on mainnet at block
 * 26,100,366, and deployable again only where it isn't — a fork of an earlier
 * block, as the tests use. It lands at `V1_MAINNET_FACTORY` for v1's mainnet
 * list, which is what proves the frozen source is v1's.
 */
export function deployV1FactoryCall(deployment: V1FactoryDeployment = V1_MAINNET_DEPLOYMENT): {
  to: Address;
  data: Hex;
  value: bigint;
  factory: Address;
} {
  return {
    to: DETERMINISTIC_DEPLOYER,
    data: `0x${SOURCES.v1.factorySalt.slice(2)}${v1FactoryInitCode(deployment).slice(2)}` as Hex,
    value: 0n,
    factory: v1FactoryAddress(deployment),
  };
}

/** One transaction of a release's deployment, to the deterministic deployer. */
export interface ReleaseDeploymentCall {
  name: "registry" | "factory" | "batcher";
  to: Address;
  data: Hex;
  value: bigint;
  /** Where the contract lands. Deployed already when it has code there: skip the call. */
  address: Address;
}

/**
 * Every transaction that deploys a release, in the order they must be sent,
 * from the release's own source and arguments (`DEPLOYMENTS`): its registry
 * when it is its source's own, its factory (whose constructor checks the
 * registry has code), and its batcher — v1's bound to its factory, or, from v2
 * on, the one bound to no factory, which every such release shares and which
 * needs nothing deployed before it. Anyone may send them; one whose contract
 * is already there reverts and changes nothing, so a deployer skips each whose
 * `address` has code. `deployment` replaces the release's own arguments (a
 * fork's own market list, say); a registry other than the source's is left
 * out, since deploying that one is its author's business.
 */
export function deployReleaseCalls(release: VaultRelease, deployment?: FactoryDeployment | V1FactoryDeployment): ReleaseDeploymentCall[] {
  const recorded = deploymentOf(release);
  const source = SOURCES[recorded.source];
  const chain = {
    weth: MAINNET_DEPLOYMENT.weth as Address,
    uniswapV2Factory: MAINNET_DEPLOYMENT.uniswapV2Factory as Address,
    uniswapV3Factory: MAINNET_DEPLOYMENT.uniswapV3Factory as Address,
    markets: recorded.markets,
  };
  const args: FactoryDeployment | V1FactoryDeployment =
    deployment ?? (recorded.registry === null ? chain : { ...chain, registry: recorded.registry });
  const named: Address | null = "registry" in args ? lower((args as FactoryDeployment).registry) : null;
  if (source.features.registry && named === null) throw new RangeError(`a ${recorded.source} deployment names its registry`);
  const viaDeployer = (salt: Hex, initCode: Hex): Hex => `0x${salt.slice(2)}${initCode.slice(2)}` as Hex;
  const calls: ReleaseDeploymentCall[] = [];
  if (source.registrySalt !== null && named !== null) {
    const registry = registryAddress(recorded.source);
    if (named === registry) {
      calls.push({ name: "registry", to: DETERMINISTIC_DEPLOYER, data: viaDeployer(source.registrySalt, registryInitCode(recorded.source)), value: 0n, address: registry });
    }
  }
  const factory = factoryAddress(args, recorded.source);
  calls.push({ name: "factory", to: DETERMINISTIC_DEPLOYER, data: viaDeployer(source.factorySalt, factoryInitCode(args, recorded.source)), value: 0n, address: factory });
  // A batcher bound to no factory is built for WETH; v1's, for its factory.
  const batcherArgument = source.features.sharedBatcher ? lower(args.weth) : factory;
  calls.push({
    name: "batcher",
    to: DETERMINISTIC_DEPLOYER,
    data: viaDeployer(source.batcherSalt, batcherInitCode(batcherArgument, recorded.source)),
    value: 0n,
    address: batcherAddress(batcherArgument, recorded.source),
  });
  return calls;
}

/** Whether the factory's deployment would succeed right now, and if not, why. */
export type FactoryDeploymentCheck =
  | { deployable: true }
  | {
      deployable: false;
      /** The constructor's own error, when it named one. */
      error: { name: string; args: readonly unknown[] } | null;
      /** One line for the UI. */
      reason: string;
    };

/**
 * Run the factory's deployment as a plain creation — an `eth_call` with its
 * creation code and no recipient — which runs every listing check the
 * constructor makes, at this block, and returns the constructor's own error
 * when one fails. Through the deterministic deployer the same failure comes
 * back empty (the deployer reverts with no reason), so this is how to learn
 * which market failed and how.
 *
 * Says nothing about whether the factory already exists: a plain creation
 * lands somewhere else, so it succeeds either way. `vaultAvailability` asks
 * that first. Throws when the endpoint would not run the call at all.
 */
export async function simulateFactoryDeployment(
  rpc: JsonRpc,
  deployment: FactoryDeployment = MAINNET_DEPLOYMENT,
): Promise<FactoryDeploymentCheck> {
  try {
    await rpc("eth_call", [{ data: factoryInitCode(deployment) }, "latest"]);
    return { deployable: true };
  } catch (thrown) {
    const data = revertDataOf(thrown);
    if (data === null) throw thrown;
    const error = decodeVaultError(data);
    return { deployable: false, error, reason: describeListingRefusal(error) };
  }
}

/**
 * The factory constructor's refusal, in words: which market failed which
 * check, with its figures.
 */
export function describeListingRefusal(error: { name: string; args: readonly unknown[] } | null): string {
  if (error === null) return "its creation code reverts without a reason";
  const [index, a, b] = error.args as bigint[];
  const market = `market ${index}`;
  switch (error.name) {
    case "NoMarkets":
      return "its market list is empty";
    case "NotAUniswapFactory":
      return "Uniswap's factories have no code on this chain";
    case "NotARegistry":
      return "the SPX holder registry it names has no code on this chain yet; it is deployed first";
    case "InvalidToken":
      return `${market} names WETH or no token at all`;
    case "DuplicateMarket":
      return `${market} repeats an earlier market's token`;
    case "PairNotFromUniswap":
      return `${market}'s pair is not the one Uniswap v2 lists on this chain`;
    case "PoolNotFromUniswap":
      return `${market}'s pool is not one Uniswap v3 lists on this chain`;
    case "OracleUnavailable":
      return `${market}'s pool cannot answer a 10-minute average right now`;
    case "OracleHistoryTooShort":
      return `${market}'s pool keeps too short a history (${a} observations; the factory needs ${b})`;
    case "OracleTooThin":
      return `${market}'s pool is too thin right now (${formatWeth(a!)} WETH of depth over ten minutes; the factory needs ${formatWeth(b!)})`;
    case "MarketsDisagree": {
      const gap = a! > b! ? a! - b! : b! - a!;
      return `${market}'s pool and pair disagree by ${b! === 0n ? "an unknown amount" : formatBps((gap * 10_000n) / b!)} right now (the factory allows ${formatBps(FACTORY_LIMITS.MAX_MARKET_GAP_BPS)})`;
    }
    default:
      return `its creation reverts with ${error.name}`;
  }
}

/**
 * The revert data an endpoint attached to a failed call: `@spdex/chain`'s
 * `httpRpc` puts it on the error as `data`; some endpoints only print it in the
 * message. `null` when there is none, which means the call was not run.
 */
function revertDataOf(thrown: unknown): string | null {
  const data = (thrown as { data?: unknown } | null)?.data;
  if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data)) return data;
  if (typeof data === "object" && data !== null && typeof (data as { data?: unknown }).data === "string") {
    return (data as { data: string }).data;
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (/revert/i.test(message)) return /0x[0-9a-fA-F]{8,}/.exec(message)?.[0] ?? "0x";
  return null;
}

// ─── Where a vault lives ──────────────────────────────────────────────────────

/** The implementation every vault of `factory` is a clone of: its constructor's one creation, at nonce 1. */
export function implementationAddress(factory: Address): Address {
  return lower(getContractAddress({ opcode: "CREATE", from: factory, nonce: 1n }));
}

/** How many bytes of terms a vault of the current source carries after its 45-byte proxy (117 for v2's). */
export const VAULT_ARGS_LENGTH = SOURCES[CURRENT_SOURCE].vaultArgsLength;

/** How many a v1 vault's carries: v2's without the community window and its turns. */
export const V1_VAULT_ARGS_LENGTH = SOURCES.v1.vaultArgsLength;

/**
 * A vault's terms as its clone carries them, packed: owner, tokenOut, pair,
 * oraclePool (20 bytes each), amountPerBuy, keeperReward, startAt (8 each),
 * interval (4), maxBuys, maxSlippageBps (2 each) — v1's 112 bytes — and for a
 * v2 vault then its community window (4) and its turns (1), 117 in all. Which
 * layout follows from the terms: v1's have neither. `contracts/libraries/VaultArgs.sol` is
 * the source of this layout, and `releases/v1`'s copy of it of v1's; the forge
 * tests and the integration tests hold the three to agreement.
 */
export function encodeVaultArgs(owner: Address, terms: VaultTerms): Hex {
  const v1 = encodePacked(
    ["address", "address", "address", "address", "uint64", "uint64", "uint64", "uint32", "uint16", "uint16"],
    [
      owner,
      terms.tokenOut,
      terms.pair,
      terms.oraclePool,
      terms.amountPerBuy,
      terms.keeperReward,
      terms.startAt,
      Number(terms.interval),
      Number(terms.maxBuys),
      Number(terms.maxSlippageBps),
    ],
  );
  const window = terms.communityWindow === null ? [] : [encodePacked(["uint32"], [Number(terms.communityWindow)])];
  const turns = terms.turnBuckets === null ? [] : [encodePacked(["uint8"], [Number(terms.turnBuckets)])];
  return concat([v1, ...window, ...turns]);
}

/** EIP-1167's runtime around the implementation's address. */
const PROXY_HEAD = "0x363d3d373d3d3d363d73";
const PROXY_TAIL = "0x5af43d82803e903d91602b57fd5bf3";

/**
 * The code a vault with these terms has: the 45-byte EIP-1167 proxy for
 * `implementation`, then its terms. What `eth_getCode` returns for it.
 */
export function vaultRuntimeCode(implementation: Address, owner: Address, terms: VaultTerms): Hex {
  return concat([PROXY_HEAD, implementation, PROXY_TAIL, encodeVaultArgs(owner, terms)]);
}

/**
 * Where `factory` will put `owner`'s vault with this nonce and these terms —
 * the factory's `predictVault`, computed here without a round trip. `nonce` is
 * the factory's `nonces(owner)` before the creation (see `readVaultNonce`).
 * The address commits to every term, the community window included, so a vault
 * found there holds exactly these. For either release: the implementation is
 * the factory's own (`implementationAddress`), and the clone's layout follows
 * from the terms, so v1 terms with v1's factory give a v1 vault's address
 * (a v2 clone is 162 bytes, init code `0x6100a2…`; a v1 clone 157, `0x61009d…`).
 */
export function predictVault(input: { factory: Address; owner: Address; nonce: bigint; terms: VaultTerms }): Address {
  const runtime = vaultRuntimeCode(implementationAddress(input.factory), input.owner, input.terms);
  const runtimeLength = (runtime.length - 2) / 2;
  // PUSH2 len, RETURNDATASIZE, DUP2, PUSH1 0x0a, RETURNDATASIZE, CODECOPY, RETURN: copy the rest out and return it.
  const initCode = concat([`0x61${runtimeLength.toString(16).padStart(4, "0")}3d81600a3d39f3`, runtime]);
  return lower(
    getContractAddress({
      opcode: "CREATE2",
      from: input.factory,
      salt: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input.owner, input.nonce])),
      bytecode: initCode,
    }),
  );
}

/** The most nonces `findVaultNonce` tries: far more vaults than anyone holds, and a bound on the work. */
export const MAX_VAULT_NONCE_SEARCH = 4_096n;

/**
 * The factory nonce a vault was created with, found by trying each one below
 * `below` — the factory's `nonces(owner)`, from `readVaultNonce` — or null when
 * none puts a vault with these terms at `vault`: then it is not `owner`'s vault
 * from this factory on these terms, and the Guard would refuse it anyway.
 *
 * A nonce found is also proof of when the vault was made, relative to a
 * count: it is one of the first `below` vaults `owner` created. An owner
 * search leans on that (`findVaultsByOwner`'s `known`).
 *
 * For the host, which has the vault's address from the config and its owner
 * and terms from `readVault`, and needs the nonce to make a `VaultClaim`. Pure,
 * and never believed: the Guard recomputes the address from what it returns.
 */
export function findVaultNonce(input: {
  factory: Address;
  owner: Address;
  terms: VaultTerms;
  vault: Address;
  below: bigint;
}): bigint | null {
  const limit = input.below < MAX_VAULT_NONCE_SEARCH ? input.below : MAX_VAULT_NONCE_SEARCH;
  const vault = lower(input.vault);
  for (let nonce = 0n; nonce < limit; nonce++) {
    let predicted: Address;
    try {
      predicted = predictVault({ factory: input.factory, owner: input.owner, nonce, terms: input.terms });
    } catch {
      // Terms that cannot be packed into a clone have no vault anywhere.
      return null;
    }
    if (predicted === vault) return nonce;
  }
  return null;
}

/**
 * The nonce `owner`'s next vault on `factory` will use: `nonces(owner)`. It is
 * also how many vaults `owner` has ever created there, since the factory
 * counts one per creation and a vault's owner is always whoever created it.
 * At the latest block unless `block` names another.
 */
export async function readVaultNonce(rpc: JsonRpc, factory: Address, owner: Address, block?: bigint): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "nonces", args: [owner] }) },
    block === undefined ? "latest" : hexBlock(block),
  ])) as Hex;
  return decodeFunctionResult({ abi: FACTORY_ABI, functionName: "nonces", data });
}

/**
 * How many vaults `factory` has created: the length of its list. Throws when
 * it cannot be read; a count nobody could read is unknown, not zero.
 */
export async function readVaultCount(rpc: JsonRpc, factory: Address): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }) },
    "latest",
  ])) as Hex;
  return decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", data });
}

/**
 * The vaults `factory` created, oldest first: up to `limit` (the factory
 * answers at most 1,000 at a time) from index `offset`, lowercased; fewer at
 * the end of its list and none past it. Every one is a vault the factory
 * vouches for, written in the same call as `isVault`. Throws when it cannot be
 * read.
 */
export async function readVaultsPage(rpc: JsonRpc, factory: Address, offset: bigint, limit: bigint): Promise<Address[]> {
  const data = (await rpc("eth_call", [
    { to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultsPage", args: [offset, limit] }) },
    "latest",
  ])) as Hex;
  return decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", data }).map(lower);
}

/**
 * The block a contract was deployed in, by binary search on `eth_getCode` —
 * about 25 reads. It needs historical state, which only an archive endpoint
 * keeps. The keeper report's last resort for a start block; the keeper itself
 * reads the factories' lists and needs none.
 */
export async function deploymentBlock(rpc: JsonRpc, address: Address): Promise<bigint> {
  const head = BigInt((await rpc("eth_blockNumber", [])) as string);
  const hasCode = async (block: bigint) => ((await rpc("eth_getCode", [address, hexBlock(block)])) as string) !== "0x";
  if (!(await hasCode(head))) throw new Error(`${address} has no code at the latest block`);
  let low = 0n;
  let high = head;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (await hasCode(middle)) high = middle;
    else low = middle + 1n;
  }
  return low;
}

// ─── Finding an owner's vaults ────────────────────────────────────────────────

/**
 * The first block that can hold a log from any factory built from this
 * repository, on Ethereum and on a fork of it: the one after block 26,000,000.
 *
 * Every test here pins that block (`SPDEX_FORK_BLOCK` in `.env.defaults`,
 * `FORK_BLOCK` in `test/forge/utils/Fork.sol`), and the vault contracts were
 * written against forks of it, after it had been mined. A factory's address
 * commits to its code, so no factory at an address this package computes can
 * have been deployed in that block or before it, and no vault can have been
 * created there. A search for an owner's vaults need look no further back.
 * On the local fork that also keeps a search off the upstream endpoint the fork
 * was seeded from, which answers for every block up to the pinned one and caps
 * how many blocks one log query may span.
 */
export const VAULT_LOGS_FROM_BLOCK = 26_000_001n;

/**
 * How far back `findVaultsByOwner` looks by default: 2,628,000 blocks, about a
 * year of Ethereum at 7,200 blocks a day. A bound on the work rather than a
 * claim about vaults. The factory's first block (`VAULT_LOGS_FROM_BLOCK`) is
 * the tighter bound for the next year or so.
 */
export const OWNER_SEARCH_RANGE = 2_628_000n;

/**
 * The first log window an owner search asks for: 100,000 blocks. An endpoint
 * that caps nothing, such as a node of one's own or the local fork, answers a
 * whole search in a query or two. One that caps ranges refuses at once, and the
 * search narrows (`OWNER_SEARCH_WINDOWS`).
 */
export const OWNER_SEARCH_CHUNK = 100_000n;

/**
 * The narrower windows an owner search falls back to, widest first, when an
 * endpoint refuses one. Hosted endpoints cap `eth_getLogs` ranges, some at ten
 * blocks, so the search steps down on a refusal rather than giving up, as the
 * app's history reader does. (The keeper reads the factory's own vault list
 * instead, `readVaultsPage`, and needs no logs to find vaults.)
 */
const OWNER_SEARCH_WINDOWS = [10_000n, 2_000n, 500n, 100n, 10n];

/**
 * The most log queries one owner search makes, refused ones included. It keeps
 * a search on an endpoint that answers only ten blocks at a time down to a few
 * seconds, which means such an endpoint lets it search only about the last
 * hour of Ethereum. The result says so (`complete: false`), rather than letting
 * the search run for minutes.
 */
export const OWNER_SEARCH_MAX_QUERIES = 40;

/** What `findVaultsByOwner` found, and how far it got. */
export interface OwnerVaults {
  /** Every vault the logs named, each once, newest first. Only vaults the factory's own logs name. */
  vaults: Address[];
  /**
   * How many vaults the owner had created on this factory by the block the
   * logs were searched from: `nonces(owner)` at that block. When the search
   * couldn't get as far as reading that block, the count at the latest one.
   */
  expected: bigint;
  /**
   * Whether every one of them is accounted for: named by the logs, or handed
   * in as `known` and proved one of them. False means the search stopped at
   * its bound (`maxRange`, `oldestBlock` or `maxQueries`) or at an endpoint
   * that refused to go further, and the ones it didn't reach were all created
   * before `searchedFrom`.
   */
  complete: boolean;
  /**
   * The oldest block the logs were read from. Absent when no log was read:
   * the owner has created no vault, the `known` vaults were all of them, or
   * the endpoint answered no log query.
   */
  searchedFrom?: bigint;
  /**
   * What the endpoint said when it refused even the narrowest window, or
   * wouldn't say which block is newest, which stopped the search; absent when
   * nothing did.
   */
  refusal?: string;
}

/**
 * Every vault `owner` has created on `factory`, from the chain alone: the
 * factory's count (`nonces(owner)`), then its `VaultCreated` logs, which carry
 * the owner as an indexed topic, read backwards from the newest block until
 * every vault the factory counts is accounted for. One factory a search: an
 * owner's vaults on v1's and v2's are two searches, each with its release's
 * topic.
 *
 * This is how an owner gets back to a vault the app lost track of, because a
 * card was deleted, a config was replaced or wiped, or this is another
 * browser. The vault itself never depended on the app remembering it: it holds
 * its budget and goes on buying.
 *
 * - **Counted first.** An owner who has created nothing costs one `eth_call`
 *   and no log query at all.
 * - **Counted and searched at one block.** Otherwise the count is read again
 *   at the newest block the logs are read to. A count read at a later block
 *   than the logs includes a vault the logs can't show yet, and one read at an
 *   earlier block misses a vault the logs do show; either way a newer vault
 *   stands in for an older one the search never reached, and the result says
 *   "complete" with a vault missing. That costs one more `eth_call`, only for
 *   an owner who has created a vault.
 * - **What the caller knows counts.** `known` are vaults the caller has read
 *   itself, with their terms. Each counts toward the factory's count once its
 *   address proves it one of the owner's first `expected` vaults
 *   (`findVaultNonce` below the count, for `owner`), so a search whose count
 *   they cover makes no log query, and one they partly cover stops sooner. A
 *   vault created after the count was read has a nonce at or above it and
 *   doesn't count: it could otherwise stand in for an older one. They are not
 *   listed in `vaults` unless the logs name them too.
 * - **Newest first, and stops when done.** Vaults are usually recent, so the
 *   usual search is one or two queries however long the chain.
 * - **Narrows on refusal.** It starts at `chunk` blocks per query and steps
 *   down through narrower windows each time the endpoint refuses one, never
 *   widening again.
 * - **Bounded.** It never reads more than `maxRange` blocks back from
 *   `newestBlock`, never below `oldestBlock`, and makes at most `maxQueries`
 *   queries. What it could not reach is reported, never guessed:
 *   `complete: false`, with the count found.
 * - **Only the factory's own logs.** Any contract can emit an event with
 *   `VaultCreated`'s signature (`vaultsCreatedBy` says why that matters), and
 *   an endpoint can ignore a topic filter, so each log is checked for its
 *   emitter and its owner rather than trusted for matching the query.
 *
 * `newestBlock` defaults to the latest block. Pass an older one and the result
 * describes the chain as it was then: vaults created since are neither
 * counted nor looked for.
 *
 * Throws when the first count cannot be read: nothing is known. Once it says
 * the owner has vaults, nothing throws: a newest block or a count that can't
 * be read, or a log query refused at every window, stops the search there,
 * with `refusal`, and the count the search had.
 */
export async function findVaultsByOwner(
  rpc: JsonRpc,
  factory: Address,
  owner: Address,
  options: {
    newestBlock?: bigint;
    maxRange?: bigint;
    chunk?: bigint;
    oldestBlock?: bigint;
    maxQueries?: number;
    known?: readonly { vault: Address; terms: VaultTerms }[];
    /**
     * The release `factory` belongs to, whose source decides the `VaultCreated`
     * topic searched for: v1's and v2's differ, since v2's terms carry a window
     * and its turns. By default `releaseOfFactory(factory)`, and the latest
     * release for a factory spDEX doesn't list.
     */
    release?: VaultRelease;
  } = {},
): Promise<OwnerVaults> {
  const maxRange = options.maxRange ?? OWNER_SEARCH_RANGE;
  const chunk = options.chunk ?? OWNER_SEARCH_CHUNK;
  const maxQueries = options.maxQueries ?? OWNER_SEARCH_MAX_QUERIES;
  if (maxRange <= 0n || chunk <= 0n || !Number.isSafeInteger(maxQueries) || maxQueries < 1) {
    throw new RangeError("maxRange, chunk and maxQueries must be positive");
  }
  const who = lower(owner);
  // The count only grows, so none now means none at any earlier block: the
  // one read an owner with no vault costs.
  const latest = await readVaultNonce(rpc, factory, who);
  if (latest === 0n) return { vaults: [], expected: 0n, complete: true };

  let newest: bigint;
  let expected: bigint;
  try {
    newest = options.newestBlock ?? BigInt((await rpc("eth_blockNumber", [])) as string);
    expected = await readVaultNonce(rpc, factory, who, newest);
  } catch (error) {
    // The owner has vaults, and saying so is worth more than an error that
    // drops the count along with the search.
    return { vaults: [], expected: latest, complete: false, refusal: messageOf(error) };
  }
  if (expected === 0n) return { vaults: [], expected, complete: true };

  const proven = new Set<Address>();
  for (const { vault, terms } of options.known ?? []) {
    if (findVaultNonce({ factory, owner: who, terms, vault, below: expected }) !== null) proven.add(lower(vault));
  }
  const vaults: Address[] = [];
  const accountedFor = () => BigInt(new Set([...proven, ...vaults]).size);

  const byRange = newest + 1n > maxRange ? newest + 1n - maxRange : 0n;
  const floor = options.oldestBlock !== undefined && options.oldestBlock > byRange ? options.oldestBlock : byRange;
  const windows = [chunk, ...OWNER_SEARCH_WINDOWS.filter((window) => window < chunk)];
  const release = options.release ?? releaseOfFactory(factory) ?? LATEST_RELEASE;
  const topics = [VAULT_EVENT_TOPICS[sourceOfRelease(release).id].VaultCreated, encodeAbiParameters([{ type: "address" }], [who])];

  let to = newest;
  let windowIndex = 0;
  let queries = 0;
  let searchedFrom: bigint | undefined;
  let refusal: string | undefined;
  while (accountedFor() < expected && to >= floor && queries < maxQueries) {
    const window = windows[windowIndex]!;
    const start = to + 1n > window ? to + 1n - window : 0n;
    const from = start < floor ? floor : start;
    queries += 1;
    let logs: (RawLog & { blockNumber?: string; logIndex?: string })[];
    try {
      logs = (await rpc("eth_getLogs", [{ address: factory, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics }])) as typeof logs;
    } catch (error) {
      if (windowIndex + 1 < windows.length) {
        windowIndex += 1;
        continue;
      }
      refusal = messageOf(error);
      break;
    }
    for (const created of vaultsCreatedBy(factory, newestFirst(logs))) {
      if (created.owner === who && !vaults.includes(created.vault)) vaults.push(created.vault);
    }
    searchedFrom = from;
    to = from - 1n;
  }
  return {
    vaults,
    expected,
    complete: accountedFor() >= expected,
    ...(searchedFrom === undefined ? {} : { searchedFrom }),
    ...(refusal === undefined ? {} : { refusal }),
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const hexBlock = (block: bigint): Hex => `0x${block.toString(16)}`;

/**
 * Logs in the order they were emitted, newest first. Endpoints return them
 * oldest first, but that is not something to depend on when the order is what
 * "newest first" means: sorted by block and position where both are given.
 */
function newestFirst<T extends { blockNumber?: string; logIndex?: string }>(logs: readonly T[]): T[] {
  if (!logs.every((log) => log.blockNumber && log.logIndex)) return [...logs].reverse();
  const position = (log: T) => (BigInt(log.blockNumber!) << 32n) + BigInt(log.logIndex!);
  return [...logs].sort((a, b) => {
    const [pa, pb] = [position(a), position(b)];
    return pa === pb ? 0 : pa > pb ? -1 : 1;
  });
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

/**
 * Any source's factory and vault ABI items. A new source's ABIs join this
 * union, so that its events decode with their own field names.
 */
type AnyVaultAbi = readonly (
  | (typeof FACTORY_ABI)[number]
  | (typeof VAULT_ABI)[number]
  | (typeof V1_FACTORY_ABI)[number]
  | (typeof V1_VAULT_ABI)[number]
)[];

/** Each source's factory and vault events. `Funded`, `Closed` and `Rescued` are the same in every one. */
const EVENTS_ABI = Object.fromEntries(
  SOURCE_IDS_NEWEST_FIRST.map((id) => [
    id,
    ([...SOURCES[id].factoryAbi, ...SOURCES[id].vaultAbi] as AnyVaultAbi).filter((item) => item.type === "event"),
  ]),
) as unknown as Record<SourceId, AnyVaultAbi>;

const topicOf = (abi: readonly unknown[], eventName: string): Hex => encodeEventTopics({ abi: abi as never, eventName } as never)[0] as Hex;

/**
 * Every factory and vault event's topic, per source, so that nothing that
 * filters logs by topic copies one by hand: `Bought` and `VaultCreated` differ
 * between v1 and v2 (v2's carry `rewardTo` and `dueSince`, and the community
 * window and its turns); `Funded`, `Closed` and `Rescued` are the same in both.
 * A history reader that wants every buy asks for every source's `Bought` topic
 * (`vaultTopicsOf`); a release's are its source's (`sourceOfRelease`).
 */
export const VAULT_EVENT_TOPICS = Object.fromEntries(
  SOURCE_IDS_NEWEST_FIRST.map((id) => {
    const { factoryAbi, vaultAbi } = SOURCES[id];
    return [
      id,
      {
        VaultCreated: topicOf(factoryAbi, "VaultCreated"),
        Bought: topicOf(vaultAbi, "Bought"),
        Funded: topicOf(vaultAbi, "Funded"),
        Closed: topicOf(vaultAbi, "Closed"),
        Rescued: topicOf(vaultAbi, "Rescued"),
      },
    ];
  }),
) as Record<SourceId, { VaultCreated: Hex; Bought: Hex; Funded: Hex; Closed: Hex; Rescued: Hex }>;

/** Every source's topics for one event, each once: what a log filter for it, across releases, asks for. */
export function vaultTopicsOf(name: "VaultCreated" | "Bought" | "Funded" | "Closed" | "Rescued"): Hex[] {
  return [...new Set(SOURCE_IDS_NEWEST_FIRST.map((id) => VAULT_EVENT_TOPICS[id][name]))];
}

export type VaultEvent =
  | {
      name: "VaultCreated";
      emitter: Address;
      /** Which source's factory event it is laid out as: v2's terms carry the community window and its turns. */
      source: SourceId;
      owner: Address;
      vault: Address;
      marketIndex: bigint;
      terms: VaultTerms;
      /** The ether sent with the creation, which the vault received as WETH. */
      funded: bigint;
    }
  | { name: "Funded"; emitter: Address; amount: bigint }
  | {
      name: "Bought";
      emitter: Address;
      /** Which source's vault event it is laid out as: v2's carries `rewardTo` and `dueSince`. */
      source: SourceId;
      slot: bigint;
      amountIn: bigint;
      amountOut: bigint;
      /** Whoever called `execute`: a keeper's account, an owner, or a batcher. */
      keeper: Address;
      /**
       * Who was paid the fee: the `rewardTo` the trigger named (v2), or the
       * caller (v1, which paid `msg.sender`: the same as `keeper`).
       */
      rewardTo: Address;
      reward: bigint;
      /** The least this buy was allowed to deliver: `quote()`'s floor at that moment. */
      floorOut: bigint;
      /** This vault's buys so far, this one included: 1, 2, 3… A gap is a missing log. */
      buyNumber: bigint;
      /** The oracle pool's depth this buy was checked against, wei of WETH. */
      oracleDepth: bigint;
      /**
       * When the buy fell due, chain time: its community window ran from here
       * for the plan's `communityWindow` seconds. `null` for v1, which has no
       * window and never logged it.
       */
      dueSince: bigint | null;
    }
  | { name: "Closed"; emitter: Address; amount: bigint }
  | { name: "Rescued"; emitter: Address; token: Address; amount: bigint };

export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  /** Its position in its block, as a receipt or a log query gives it; the batcher's events are joined by it. */
  logIndex?: string | number;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

/**
 * An address in its checksummed form (EIP-55), for showing and copying. The
 * app has no direct way to viem, and an address typed out by hand is how a
 * wrong one gets shown.
 */
export function checksumAddress(address: string): Address {
  return getAddress(address) as Address;
}

/**
 * One factory or vault log of any release, decoded, with which source's
 * layout it is (`VaultCreated` and `Bought` say so); `null` for anything else.
 *
 * Returns null rather than guessing: an unrelated event with a colliding
 * signature from some other contract is not a buy. Which contract emitted it is
 * reported as `emitter`, and a caller that cares — the Guard does — must check
 * it is a listed factory or a vault one vouches for.
 */
export function decodeVaultEvent(log: RawLog): VaultEvent | null {
  const emitter = lower(log.address);
  // The newest source's layouts first; an older `Bought` or `VaultCreated` has
  // another topic, and only its own source's layout decodes it. The events all
  // share decode as the newest's.
  for (const source of SOURCE_IDS_NEWEST_FIRST) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: EVENTS_ABI[source], topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
    } catch {
      continue;
    }
    switch (decoded.eventName) {
      case "VaultCreated": {
        const { owner, vault, marketIndex, terms, funded } = decoded.args;
        return {
          name: "VaultCreated",
          emitter,
          source,
          owner: lower(owner),
          vault: lower(vault),
          marketIndex,
          terms: termsFromAbi(terms),
          funded,
        };
      }
      case "Funded":
        return { name: "Funded", emitter, amount: decoded.args.amount };
      case "Bought": {
        const { slot, amountIn, amountOut, keeper, reward, floorOut, buyNumber, oracleDepth } = decoded.args;
        const v2 = "rewardTo" in decoded.args ? decoded.args : null;
        return {
          name: "Bought",
          emitter,
          source,
          slot,
          amountIn,
          amountOut,
          keeper: lower(keeper),
          rewardTo: lower(v2 ? v2.rewardTo : keeper),
          reward,
          floorOut,
          buyNumber,
          oracleDepth,
          dueSince: v2 ? v2.dueSince : null,
        };
      }
      case "Closed":
        return { name: "Closed", emitter, amount: decoded.args.amount };
      case "Rescued":
        return { name: "Rescued", emitter, token: lower(decoded.args.token), amount: decoded.args.amount };
      default:
        return null;
    }
  }
  return null;
}

/**
 * Errors of the vendored proof verifier (Optimism's RLP reader), which the
 * registry's ABI carries: each means the proof's bytes are not a proof of
 * that block's state, however they were made.
 */
const PROOF_DECODING_ERRORS = new Set(["EmptyItem", "UnexpectedString", "InvalidDataRemainder", "UnexpectedList", "ContentLengthMismatch", "InvalidHeader"]);

/** Solidity's panic for an index out of bounds, which the RLP reader raises on a list of more than 32 items. */
const PANIC_INDEX_OUT_OF_BOUNDS = 0x32n;

/**
 * A vault, factory or SPX holder registry revert, by the contract's own error
 * name and arguments, for v1 and v2 alike; `null` when the data is none of
 * them (an out-of-gas, an empty revert). Named errors are what lets a keeper
 * print "not due until …" and the app "the price is outside your floor"
 * instead of a hex blob. A plan's terms are refused by the factory, a buy by
 * the vault, a proof by the registry; all are tried. A revert string or a
 * panic from elsewhere comes back as Solidity names it, `Error` or `Panic`.
 *
 * A proof the registry's vendored verifier cannot follow reverts with the
 * verifier's own words — an `Error("MerkleTrie: …")`, one of its RLP errors,
 * or `Panic(0x32)` — and all of those come back as one name,
 * `ProofMismatch`, with what the verifier said as its argument: they mean one
 * thing to anyone who sent the proof, that it does not match the block's
 * state (`describeRegistryError` words it).
 */
export function decodeVaultError(data: string): { name: string; args: readonly unknown[] } | null {
  const abis: (readonly unknown[])[] = [];
  for (const id of SOURCE_IDS_NEWEST_FIRST) {
    const { vaultAbi, factoryAbi, registryAbi } = SOURCES[id];
    abis.push(vaultAbi, factoryAbi, ...(registryAbi === null ? [] : [registryAbi]));
  }
  for (const abi of abis) {
    let decoded;
    try {
      decoded = decodeErrorResult({ abi: abi as typeof VAULT_ABI, data: data as Hex });
    } catch {
      // Not this contract's; try the next.
      continue;
    }
    const name = decoded.errorName as string;
    const args = (decoded.args ?? []) as readonly unknown[];
    if (PROOF_DECODING_ERRORS.has(name)) return { name: "ProofMismatch", args: [name] };
    if (name === "Error" && typeof args[0] === "string" && args[0].startsWith("MerkleTrie:")) return { name: "ProofMismatch", args };
    if (name === "Panic" && args[0] === PANIC_INDEX_OUT_OF_BOUNDS) return { name: "ProofMismatch", args: ["Panic(0x32)"] };
    return { name, args };
  }
  return null;
}

/**
 * The vaults `factory` created in these logs — a receipt's, or a simulation's —
 * with the terms it announced for each; look-alikes from any other emitter are
 * left out.
 *
 * Any contract can emit an event with `VaultCreated`'s exact signature, and one
 * laid out like the factory can even run the factory's own code with
 * `delegatecall` to make a genuine-looking clone on a market the factory never
 * listed (`test_r5b_runningTheFactoryCodeElsewhereNeverYieldsAVouchedVault`).
 * Only the factory's own logs say what the factory did, so this is the way to
 * read a creation, and `factory` should be one computed with `factoryAddress`
 * (or `v1FactoryAddress`, for v1's).
 */
export function vaultsCreatedBy(factory: Address, logs: readonly RawLog[]): Extract<VaultEvent, { name: "VaultCreated" }>[] {
  const expected = lower(factory);
  const created: Extract<VaultEvent, { name: "VaultCreated" }>[] = [];
  for (const log of logs) {
    const event = decodeVaultEvent(log);
    if (event?.name === "VaultCreated" && event.emitter === expected) created.push(event);
  }
  return created;
}

/**
 * Who made a buy, as Your activity, a vault card's history and the keeper's
 * report all say it:
 *
 * - `"owner"`: the owner's own trigger. In v2, paid back to the owner and sent
 *   by the owner; in v1, called by the owner.
 * - `"returned"`: v2, paid back to the owner by someone else. Anyone may make
 *   a buy inside its window by naming the owner (the exception is for whoever
 *   is paid, not whoever sends): the owner's fee came back, but it was not the
 *   owner's doing, and is never shown as "you".
 * - `"community"`: v2, paid to someone else inside its community window: an
 *   SPX holder the registry vouched for at that moment.
 * - `"open"`: v2, paid to someone else after its window, when anyone may be.
 * - `"caller"`: v1, called by someone other than the owner: a keeper, a
 *   batcher, anyone.
 *
 * `sender` is the transaction's sender when it is known; without it, `keeper`
 * (the caller of `execute`) stands in, unless that is one of spDEX's batchers,
 * which send for whoever calls them. `at` is the block's time. `source` is the
 * source of the vault's layout (`Bought.source`), which says whether it paid
 * `rewardTo` or its caller. `null` when anything this needs is unknown —
 * never a guess.
 */
export type BuyMaker = "owner" | "returned" | "community" | "open" | "caller";

export function buyMaker(input: {
  source: SourceId;
  owner: Address | null;
  rewardTo: Address | null;
  keeper: Address | null;
  sender?: Address | null;
  at: bigint | null;
  dueSince: bigint | null;
  communityWindow: bigint | null;
}): BuyMaker | null {
  const owner = input.owner === null ? null : lower(input.owner);
  if (owner === null) return null;
  if (!SOURCES[input.source].features.executeTakesRewardTo) {
    if (input.keeper === null) return null;
    return lower(input.keeper) === owner ? "owner" : "caller";
  }
  if (input.rewardTo === null) return null;
  if (lower(input.rewardTo) === owner) {
    const keeper = input.keeper === null ? null : lower(input.keeper);
    const sender = input.sender ? lower(input.sender) : keeper !== null && !isListedBatcher(keeper) ? keeper : null;
    if (sender === null) return null;
    return sender === owner ? "owner" : "returned";
  }
  if (input.at === null || input.dueSince === null || input.communityWindow === null) return null;
  return input.at < input.dueSince + input.communityWindow ? "community" : "open";
}

/** Terms with their addresses lowercased, as every reader here returns them. */
export function normaliseTerms(terms: VaultTerms): VaultTerms {
  return { ...terms, tokenOut: lower(terms.tokenOut), pair: lower(terms.pair), oraclePool: lower(terms.oraclePool) };
}

/** Terms as an ABI decodes them, v1's without a window or turns, as `VaultTerms`. */
function termsFromAbi(terms: Omit<VaultTerms, "communityWindow" | "turnBuckets"> & { communityWindow?: bigint; turnBuckets?: bigint }): VaultTerms {
  return normaliseTerms({ ...terms, communityWindow: terms.communityWindow ?? null, turnBuckets: terms.turnBuckets ?? null });
}

/** How many words a source's view answers with: every output is a static word, the terms' tuple one per field. */
function wordsOfOutput(id: SourceId, functionName: "terms" | "status"): number {
  const abi = SOURCES[id].vaultAbi as readonly { type: string; name?: string; outputs?: readonly { components?: readonly unknown[] }[] }[];
  const item = abi.find((i) => i.type === "function" && i.name === functionName) as
    | { outputs: readonly { components?: readonly unknown[] }[] }
    | undefined;
  if (!item) return -1;
  return item.outputs.reduce((sum, output) => sum + (output.components ? output.components.length : 1), 0);
}

/**
 * The source whose `functionName` answers with this many words, newest first:
 * how an answer is told apart when no factory says which source a vault is.
 */
function sourceByWords(functionName: "terms" | "status", words: number | null): SourceId | null {
  if (words === null) return null;
  return SOURCE_IDS_NEWEST_FIRST.find((id) => wordsOfOutput(id, functionName) === words) ?? null;
}

/**
 * A vault's `terms()` answer, decoded with `source`'s ABI, or by its shape
 * when `source` is not given: nine words are v1's terms (`communityWindow` and
 * `turnBuckets` null), eleven v2's. `null` for anything else, "0x" included:
 * not a vault's answer.
 *
 * By shape, because no one ABI reads every source: a later answer decoded with
 * an earlier ABI silently loses its trailing fields, and an earlier one with a
 * later ABI throws. Every read of an unknown vault's terms goes through here.
 */
export function decodeTerms(data: string | undefined, source?: SourceId): VaultTerms | null {
  const id = source ?? sourceByWords("terms", wordsOf(data));
  if (id === null || wordsOf(data) !== wordsOfOutput(id, "terms")) return null;
  const abi = SOURCES[id].vaultAbi as typeof VAULT_ABI;
  return decodeOr(data, (d) => termsFromAbi(decodeFunctionResult({ abi, functionName: "terms", data: d })));
}

/**
 * A vault's `status()` answer, decoded with `source`'s ABI or by its shape, as
 * `decodeTerms`: five words are v1's (no window: `dueSince`, `windowEndsAt`
 * and the turn null), nine v2's. Zero for "no next buy", "no buy left" is
 * reported as null, never as a time. `null` for anything else.
 */
export function decodeStatus(data: string | undefined, source?: SourceId): { source: SourceId; status: VaultStatus } | null {
  const id = source ?? sourceByWords("status", wordsOf(data));
  if (id === null || wordsOf(data) !== wordsOfOutput(id, "status")) return null;
  const features = SOURCES[id].features;
  return decodeOr(data, (d) => {
    const answer = decodeFunctionResult({
      abi: SOURCES[id].vaultAbi as typeof VAULT_ABI,
      functionName: "status",
      data: d,
    }) as readonly [boolean, bigint, bigint, bigint, boolean, bigint?, bigint?, bigint?, bigint?];
    const [due, nextBuyAt, buysLeft, wethBalance, funded, dueSince, windowEndsAt, turnEndsAt, turn] = answer;
    const known = (t: bigint | undefined) => (t === undefined || t === 0n ? null : t);
    const noneLeft = buysLeft === 0n;
    return {
      source: id,
      status: {
        due,
        nextBuyAt: known(nextBuyAt),
        buysLeft,
        wethBalance,
        funded,
        dueSince: known(dueSince),
        windowEndsAt: known(windowEndsAt),
        turnEndsAt: features.turns && !noneLeft ? known(turnEndsAt) : null,
        turn: features.turns && !noneLeft && turn !== undefined ? turn : null,
      },
    };
  });
}

/** How many 32-byte words an answer is; null for one that isn't whole words. */
function wordsOf(data: string | undefined): number | null {
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{64})*$/.test(data)) return null;
  return (data.length - 2) / 64;
}

// ─── Reading a vault ──────────────────────────────────────────────────────────

export interface VaultStatus {
  /**
   * Every check `execute` makes except the price floor passes right now: not
   * closed, a buy left, the slot open and the last buy far enough back, the
   * budget there, and the oracle pool answering with `MIN_ORACLE_DEPTH` behind
   * it. Whether the price is inside the floor is the quote's question, and a
   * moment's; `whyNotNow` puts the two together. Says nothing about who may be
   * paid: inside the community window that is the registry's question.
   */
  due: boolean;
  /**
   * When the next buy may happen by the clock alone, chain time; `null` when
   * none will. At or before `chainTime` while not due means something other
   * than the clock is in the way: the budget or the oracle pool.
   */
  nextBuyAt: bigint | null;
  buysLeft: bigint;
  /**
   * The WETH held, in wei. Anyone can send a vault WETH, even before it exists,
   * so this can exceed what the plan needs and even `MAX_FUNDING`; the cap
   * bounds what the owner can put in, and `close` returns all of it.
   */
  wethBalance: bigint;
  /** Whether that covers the next buy and its reward. */
  funded: boolean;
  /**
   * When the next buy falls (or fell) due, chain time, the moment its community
   * window is measured from: `nextBuyAt` until then, and from then on the later
   * of that and the start of the slot the chain's clock is in. `null` for a v1
   * vault, which has no window, and when no buy is left.
   */
  dueSince: bigint | null;
  /**
   * `dueSince + communityWindow`: until this moment the fee can be paid only to
   * the owner or an eligible SPX holder; from it, to anyone. `null` as
   * `dueSince`.
   */
  windowEndsAt: bigint | null;
  /**
   * Until this moment, inside the window, a `rewardTo` other than the owner
   * must also be in the bucket `turn`: `dueSince + communityWindow / 2` for a
   * plan with turns, `dueSince` (no turn) for one without. `null` for a vault
   * whose source has no turns, and when no buy is left.
   */
  turnEndsAt: bigint | null;
  /** The bucket with first claim on the next buy until `turnEndsAt`; 0 without turns; `null` as `turnEndsAt`. */
  turn: bigint | null;
}

export interface VaultState {
  address: Address;
  /**
   * Which release the vault is: the vouching factory's, when one does; else
   * the newest release built from the source its answers are shaped as.
   */
  release: VaultRelease;
  /** The source its answers are shaped as, which says what it can do (`SOURCES[source].features`). */
  source: SourceId;
  owner: Address;
  terms: VaultTerms;
  closed: boolean;
  buysDone: bigint;
  /** Everything delivered to the owner, raw `tokenOut` units, measured at the owner. */
  totalOut: bigint;
  totalRewards: bigint;
  /**
   * Buys made inside their community window and paid to someone other than
   * the owner: the community's. `null` for a v1 vault, which has no window, and
   * when it could not be read.
   */
  windowBuys: bigint | null;
  status: VaultStatus;
  /**
   * What a buy would deliver now, the least it may, and the depth (wei of
   * WETH) of the pool the floor is read from; a buy is refused while that is
   * below `VAULT_LIMITS.MIN_ORACLE_DEPTH`. `null` when the pool cannot answer a
   * 10-minute average at this moment — which means a buy would revert now too,
   * not that the floor is zero.
   */
  quote: { spotOut: bigint; floorOut: bigint; oracleDepth: bigint } | null;
  /**
   * Whether a factory asked vouches for this vault (`isVault`): true when one
   * does, false when every one asked answered no, `null` when none was asked
   * or one could not be read and none said yes.
   */
  fromFactory: boolean | null;
  /** The factory that vouches for it, lowercase; `null` when none asked does, or it is unknown. */
  factory: Address | null;
  /**
   * The timestamp of the block every figure here was read at: the vault's own
   * clock, which is what `nextBuyAt` and any countdown must be compared with —
   * never the wall clock, which a fork, or a lagging endpoint, can be days
   * from. `null` when the endpoint would not say.
   */
  chainTime: bigint | null;
}

type Reader = Pick<Multicall3Reader, "multicall">;

/**
 * A vault's terms, progress, status and price, whether a factory created it,
 * and the chain's time — one Multicall3 round trip at the latest block, so
 * every figure describes the same moment. For a vault of either release: its
 * terms and status are decoded by their shape (`decodeTerms`, `decodeStatus`),
 * and `windowBuys`, which v1 has not, is asked anyway and read as unknown
 * there.
 *
 * Which factories are asked whether they made it: `factories`, or the one
 * `factory`, or by default every release's (`DEPLOYMENTS`), so a v1 vault read
 * by an app that creates v2 vaults is still recognised as spDEX's — one more
 * call each. A vault the factories vouch for is decoded with its release's
 * source's ABI, and must answer in that shape.
 *
 * Returns `null` when the address does not answer `terms()` and `status()`
 * the way a vault of one release does: no code, something else's, or answers
 * of two different releases. A vault whose oracle is momentarily unable to
 * answer still reads, with `quote: null`.
 */
export async function readVault(
  rpc: JsonRpc,
  vault: Address,
  options: { factories?: readonly Address[]; factory?: Address; reader?: Reader } = {},
): Promise<VaultState | null> {
  const reader = options.reader ?? new Multicall3Reader(rpc);
  const factories = (options.factories ?? (options.factory ? [options.factory] : DEPLOYMENTS.map((d) => d.factory))).map(lower);
  const call = (functionName: VaultView) => ({
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName }),
  });
  const calls = VAULT_VIEWS.map(call);
  // Multicall3's own view of the block it runs in: the time `status()` judged by.
  calls.push({ to: CONTRACTS.multicall3, data: encodeFunctionData({ abi: MULTICALL3_CLOCK_ABI, functionName: "getCurrentBlockTimestamp" }) });
  for (const factory of factories) {
    calls.push({ to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [vault] }) });
  }
  const results = await reader.multicall(calls);
  // A failed call comes back as "0x" (see Multicall3Reader), and so does a
  // reply that does not decode as a vault's: both mean "not known", never zero.
  const raw = (name: VaultView): string | undefined => results[VAULT_VIEWS.indexOf(name)];
  const known = <T>(name: VaultView, decode: (data: Hex) => T): T | null => decodeOr(raw(name), decode);

  const answers = factories.map((factory, i) => ({
    factory,
    vouched: decodeOr(results[VAULT_VIEWS.length + 1 + i], (data) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", data })),
  }));
  const vouching = answers.find((answer) => answer.vouched === true) ?? null;
  const fromFactory = vouching ? true : answers.length > 0 && answers.every((answer) => answer.vouched === false) ? false : null;
  const vouchingRelease = vouching ? releaseOfFactory(vouching.factory) : null;
  // The vouching factory's source, when it is a listed one; else whatever shape the answers have.
  const expectedSource = vouchingRelease === null ? undefined : deploymentOf(vouchingRelease).source;

  const terms = decodeTerms(raw("terms"), expectedSource);
  const status = decodeStatus(raw("status"), expectedSource);
  const owner = known("owner", (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data }));
  const closed = known("closed", (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "closed", data }));
  const buysDone = known("buysDone", (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data }));
  const totalOut = known("totalOut", (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "totalOut", data }));
  const totalRewards = known("totalRewards", (data) =>
    decodeFunctionResult({ abi: VAULT_ABI, functionName: "totalRewards", data }),
  );
  if (
    terms === null ||
    status === null ||
    owner === null ||
    closed === null ||
    buysDone === null ||
    totalOut === null ||
    totalRewards === null
  ) {
    return null;
  }
  const source = sourceOfTerms(terms);
  // A vault answers both in its own source's shape; anything else is not one.
  if (status.source !== source) return null;
  const release = vouchingRelease ?? latestReleaseOf(source) ?? LATEST_RELEASE;
  const quote = known("quote", (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "quote", data }));
  const windowBuys = SOURCES[source].features.communityWindow
    ? known("windowBuys", (data) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "windowBuys", data })))
    : null;

  const chainTime = decodeOr(results[VAULT_VIEWS.length], (data) =>
    decodeFunctionResult({ abi: MULTICALL3_CLOCK_ABI, functionName: "getCurrentBlockTimestamp", data }),
  );

  return {
    address: lower(vault),
    release,
    source,
    owner: lower(owner),
    terms,
    closed,
    buysDone: BigInt(buysDone),
    totalOut,
    totalRewards,
    windowBuys,
    status: status.status,
    quote: quote === null ? null : { spotOut: quote[0], floorOut: quote[1], oracleDepth: quote[2] },
    fromFactory,
    factory: vouching?.factory ?? null,
    chainTime,
  };
}

const VAULT_VIEWS = ["terms", "owner", "closed", "buysDone", "totalOut", "totalRewards", "status", "quote", "windowBuys"] as const;
type VaultView = (typeof VAULT_VIEWS)[number];

/**
 * A v2 vault's next buy's community window at the moment it was read: when the
 * buy fell (or falls) due, when the window ends, and whether the chain's clock
 * is inside it — due, and before its end — which is when a vault card says
 * "Community window until 14:32, then open to anyone". `null` for a v1 vault,
 * one with no buy left, and an unknown chain time.
 */
export function vaultCommunityWindow(state: Pick<VaultState, "status" | "chainTime">): { dueSince: bigint; endsAt: bigint; inWindow: boolean } | null {
  const { dueSince, windowEndsAt, nextBuyAt } = state.status;
  if (dueSince === null || windowEndsAt === null || state.chainTime === null) return null;
  const due = nextBuyAt !== null && state.chainTime >= nextBuyAt;
  return { dueSince, endsAt: windowEndsAt, inWindow: due && state.chainTime < windowEndsAt };
}

const MULTICALL3_CLOCK_ABI = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);

// ─── Many vaults' progress ────────────────────────────────────────────────────

/** The two WETH functions vault code calls: `balanceOf` for what a vault or a keeper holds, `withdraw` for a keeper unwrapping its fees. */
export const WETH_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)"]);

/** A vault's progress, its WETH and, when asked, its price; null for each figure that could not be read. */
export interface VaultProgress {
  buysDone: bigint | null;
  lastBuyAt: bigint | null;
  closed: boolean | null;
  balance: bigint | null;
  quote: { spotOut: bigint; floorOut: bigint; oracleDepth: bigint } | null;
}

/** How many calls `vaultProgressCalls` makes for one vault. */
export function vaultProgressCallCount(withQuote: boolean): number {
  return withQuote ? 5 : 4;
}

/**
 * One vault's calls in a Multicall3 batch of many: `buysDone`, `lastBuyAt`,
 * `closed`, the vault's WETH and, when asked, `quote()`. Never `status()`,
 * which runs the oracle's `observe` again: whether a buy is due is worked out
 * from these with `earliestBuyAt`. The keeper reads vaults this way, and so
 * does the app's "Help run the network" (`readDueCandidates`); one list keeps
 * the two reading the same figures the same way.
 */
export function vaultProgressCalls(vault: Address, weth: Address, withQuote: boolean): { to: Address; data: Hex }[] {
  return [
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "buysDone" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "lastBuyAt" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "closed" }) },
    { to: lower(weth), data: encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [vault] }) },
    ...(withQuote ? [{ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "quote" }) }] : []),
  ];
}

/** The answers to one vault's `vaultProgressCalls`, which start at `offset` in a batch's results. */
export function decodeVaultProgress(results: readonly string[], offset: number, withQuote: boolean): VaultProgress {
  const at = (k: number) => results[offset + k];
  const quote = withQuote ? decodeOr(at(4), (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "quote", data })) : null;
  return {
    buysDone: decodeOr(at(0), (data) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data }))),
    lastBuyAt: decodeOr(at(1), (data) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "lastBuyAt", data }))),
    closed: decodeOr(at(2), (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "closed", data })),
    balance: decodeOr(at(3), (data) => decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data })),
    quote: quote === null ? null : { spotOut: quote[0], floorOut: quote[1], oracleDepth: quote[2] },
  };
}

/**
 * Why this vault's buy cannot happen right now, in the order the vault itself
 * would refuse it; `null` when a trigger sent now would buy, as far as a read
 * can tell. This is what an app's "Trigger now" goes by; a keeper plans from
 * its own state, and the batcher tries each vault.
 *
 * Chain time throughout (`chainTime`): the vault judges time by blocks. Without
 * it, a buy that is not due is put down to the clock, which is the usual reason.
 */
export function whyNotNow(state: VaultState): string | null {
  if (state.closed) return "closed by its owner";
  if (state.status.buysLeft === 0n) return "every buy is done";
  if (!state.status.funded) return "not funded for its next buy";
  const next = state.status.nextBuyAt;
  const waitingForTheClock =
    next === null || (state.chainTime === null ? !state.status.due : next > state.chainTime);
  if (waitingForTheClock) {
    return next === null ? "not due" : `next buy due at ${new Date(Number(next) * 1000).toISOString()} (chain time)`;
  }
  if (state.quote === null) return "its price oracle cannot answer a 10-minute average right now";
  if (state.quote.oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH) {
    return `its oracle pool is too thin to price a buy right now (${formatEth(state.quote.oracleDepth)} WETH of depth over ten minutes; the vault needs ${formatEth(VAULT_LIMITS.MIN_ORACLE_DEPTH)})`;
  }
  if (state.quote.spotOut < state.quote.floorOut) {
    const shortBps = ((state.quote.floorOut - state.quote.spotOut) * 10_000n) / state.quote.floorOut;
    return `the price is ${formatBps(shortBps)} outside its floor; the buy waits for the market`;
  }
  // The status and the quote are one block's, so they agree; this is for an
  // endpoint that answered one and not the other.
  if (!state.status.due) return "not due";
  return null;
}

/**
 * The most `fund` will keep right now: what the remaining buys and their
 * rewards need, less what the vault already holds. The contract computes the
 * same figure, keeps at most that and sends the rest straight back — so an
 * owner can send this amount without it failing because someone sent the vault
 * a wei of WETH in between, and refuses outright (`FullyFunded`) only at zero.
 */
export function fundingRoom(state: Pick<VaultState, "terms" | "status">): bigint {
  const need = state.status.buysLeft * (state.terms.amountPerBuy + state.terms.keeperReward);
  return need > state.status.wethBalance ? need - state.status.wethBalance : 0n;
}

// ─── Gas for one buy ──────────────────────────────────────────────────────────

/**
 * Gas one `execute` transaction uses, all in (the 21,000 base included), for a
 * buy of SPX made on its own, at its dearest (a v2 vault's first buy on a busy
 * pool, inside its community window and paid to an eligible holder, so the
 * registry is asked from cold): what "Trigger now"'s gas limit is sized from
 * (`KEEPER_MIN_EXECUTE_GAS_LIMIT`), not what a buy costs. A keeper sends buys
 * only in batches, where a buy costs less; the buy fee is priced from that
 * (`fee.ts`). It covers v1's buys too, which cost less.
 *
 * Pinned twice, each failing if a real buy needs more: the quiet-pool path by
 * `test/integration/vault.test.ts`, a real transaction on the local fork, and
 * the busy-pool path — the dear one — by `test/forge/Gas.t.sol`, which trades
 * on the pool first and measures from cold: 312,751 for v2 (v1's was
 * 301,163). Five things move it:
 *
 * - **Whether slots are written from zero.** A vault's first buy pays an owner
 *   who may never have held SPX and a `rewardTo` who may never have held
 *   WETH, and writes the vault's own counters for the first time. A later buy
 *   writes fewer slots from zero and costs about 70,000 less.
 * - **The clone.** Every call goes through the vault's 45-byte proxy to the
 *   shared implementation and reads the terms back from the clone's code: about
 *   5,000 more than a full contract per vault, which is what creating a vault
 *   for about 177,000 rather than 2.3 million costs at each buy.
 * - **How busy the oracle pool has been.** When the pool traded within the last
 *   ten minutes, `observe` binary-searches the 1,800 observations it keeps,
 *   about 68,000 gas on its own; when it has not, the answer extends its latest
 *   observation, about 11,000. That is the spread between the quiet and busy
 *   figures, and the busy case is the usual one for SPX on mainnet.
 * - **The community window.** Inside it, a `rewardTo` other than the owner
 *   costs the registry's check: about 9,500 cold, 12,000 for an address whose
 *   account is cold too. Trigger now pays the owner, so the registry is never
 *   asked; after the window nobody is.
 * - **The pool's price now**, read beside the average so the floor can follow a
 *   market that has just moved in the owner's favour: a few thousand.
 *
 * SPX's own transfer is about 64,000 into a new holder. A token with a heavier
 * transfer costs more; this sizes a gas limit, it does not promise one.
 */
export const EXECUTE_GAS = 330_000n;

/**
 * The gas limit a wallet signs an `execute` sent on its own with, as a share
 * of its estimate: +20%, `prepareTransaction`'s default. Only the floor below
 * is sized from it: a keeper sends buys in batches, and the batcher gives each
 * vault a fixed `MAX_EXECUTE_GAS_LIMIT` instead.
 */
export const KEEPER_GAS_HEADROOM_BPS = 12_000n;

/**
 * The gas a keeper's batch gives each vault's `execute`: the batcher's least,
 * `MIN_EXECUTE_GAS` (`BATCHER_LIMITS`, held equal by a unit test), which v1's
 * batcher gave as its fixed `EXECUTE_GAS_CAP`. The batcher from v2 on takes it
 * as an argument, so a fork that reprices a buy past it needs a new figure
 * here, not a new batcher. Well above an honest buy of SPX (the dearest, a first buy
 * on a busy pool, estimates at about 319,200), and far below what a hostile
 * vault would like a keeper to burn. A vault can be built to look cheap and
 * successful in a simulation and then spend every unit of gas it is given in a
 * real transaction; this is what bounds that loss.
 */
export const MAX_EXECUTE_GAS_LIMIT = 400_000n;

/**
 * The least gas limit an `execute` sent on its own — the owner's "Trigger now"
 * — is signed with: `EXECUTE_GAS` plus a wallet's headroom, 396,000.
 *
 * An estimate describes the pool as it was when it was made. A buy estimated
 * on a quiet pool, with a trade landing on the pool first, takes the busy path
 * in the block: about 57,000 more, which a quiet estimate's 20% does not cover
 * (a first buy estimates at about 265,000 quiet and needs about 319,000 busy).
 * It would run out of gas, having used all of it, and the owner would still
 * pay for the gas. Unused gas is refunded, so the floor costs nothing when it
 * is not needed.
 */
export const KEEPER_MIN_EXECUTE_GAS_LIMIT = (EXECUTE_GAS * KEEPER_GAS_HEADROOM_BPS) / 10_000n;

// ─── The oracle pool ──────────────────────────────────────────────────────────

/**
 * The vault's own oracle arithmetic, from `observe([window, 0])`'s answers:
 * the mean tick, and the pool's harmonic-mean liquidity over the window as a
 * virtual WETH reserve — `OracleQuote.means` and `wethDepth` in the contract,
 * transcribed, so that an app or keeper can tell whether a pool would pass the
 * vault's `MIN_ORACLE_DEPTH` before anyone pays to find out.
 */
export function oracleReading(input: {
  tickCumulatives: readonly [bigint, bigint];
  secondsPerLiquidity: readonly [bigint, bigint];
  wethIsToken0: boolean;
  window?: bigint;
}): { meanTick: number; depth: bigint } {
  const window = input.window ?? VAULT_LIMITS.TWAP_WINDOW;
  const tick = meanTick(input.tickCumulatives[0], input.tickCumulatives[1], Number(window));
  // The accumulator is a uint160 that wraps; so does the difference.
  const perLiquidity = (input.secondsPerLiquidity[1] - input.secondsPerLiquidity[0]) & UINT160_MAX;
  const liquidity = perLiquidity === 0n ? 0n : (window * UINT160_MAX) / (perLiquidity << 32n);
  const sqrtPriceX96 = sqrtRatioAtTick(tick);
  const depth = input.wethIsToken0 ? (liquidity << 96n) / sqrtPriceX96 : (liquidity * sqrtPriceX96) >> 96n;
  return { meanTick: tick, depth };
}

const UINT160_MAX = (1n << 160n) - 1n;

// ─── Can a vault be offered right now? ────────────────────────────────────────

const V2_PAIR_ABI = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

export interface VaultAvailability {
  /** The factory is deployed and the market is healthy right now: a vault can be created, and would buy. */
  available: boolean;
  /** Where the factory for this deployment lives, deployed or not. */
  factory: Address;
  /** Whether it is deployed on this chain; `null` when the endpoint would not say. */
  factoryDeployed: boolean | null;
  /**
   * Whether the SPX holder registry the factory names is deployed: `true`
   * whenever the factory is, whose constructor refused a registry without
   * code; asked only while the factory isn't. `null` when the endpoint would
   * not say.
   */
  registryDeployed: boolean | null;
  /**
   * Whether its one-time deployment (`deployFactoryCall`) would succeed right
   * now, from `simulateFactoryDeployment`: offer it only when this is `true`.
   * `null` when the factory is already deployed, or the endpoint would not
   * run the simulation.
   */
  factoryDeployable: boolean | null;
  /** The market asked about, with its index; `null` for an index the list does not have. */
  market: (Market & { index: number }) | null;
  /**
   * Whether the market passes, right now, what the factory checked when it
   * listed it and what the vault checks at every buy; `null` when it could not
   * be read.
   */
  marketHealthy: boolean | null;
  /** The pool's depth over the last ten minutes, wei of WETH, as the vault measures it. */
  oracleDepth: bigint | null;
  /**
   * How far the pool's ten-minute average sits from the pair's mid price, in
   * basis points of the pair's, signed: positive when the pool quotes more
   * tokens per WETH than the pair, which makes every buy's floor that much
   * stricter against the pair; negative when it quotes fewer, which makes every
   * floor that much looser. The factory allowed `MAX_MARKET_GAP_BPS` either way
   * when it listed the market, and no vault checks it again. `null` when either
   * side could not be read.
   */
  marketGapBps: bigint | null;
  /** One short line per thing in the way, for the UI to show as-is. */
  reasons: string[];
}

/**
 * Whether spDEX can offer a vault right now: is the factory for `deployment`
 * (default mainnet's) deployed on this chain, and is market `marketIndex`
 * (default 0, SPX) healthy at this moment?
 *
 * Nothing here chooses a market — the factory's list did that once, and its
 * address commits to it. Healthy means the market still passes what the factory
 * checked when it listed it: the pair holds liquidity, the pool keeps at least
 * `MIN_OBSERVATIONS` of history, answers a ten-minute average with at least
 * `MIN_ORACLE_DEPTH` of depth behind it, and that average is within
 * `MAX_MARKET_GAP_BPS` of the pair's mid price.
 *
 * What an unhealthy market means for vaults that already exist differs by
 * check, and each reason says which. Every buy re-checks the depth and the
 * pool's answer, so while those fail, buys wait. The history cannot shrink
 * once listed. The gap is never re-checked: while the pool quotes more tokens
 * than the pair, a buy waits only if its own allowance is smaller than the gap
 * (less the pair's fee); while it quotes fewer, buys go ahead with a floor
 * that much looser against the pair (`marketGapBps` has the figure).
 *
 * An undeployed factory makes `available` false. Its deployment is one
 * permissionless transaction (`deployFactoryCall`), which succeeds only while
 * every listed market passes the listing checks and the SPX holder registry it
 * names has code, so it is simulated first and the reason says whether it can
 * be sent and, if not, which check refuses it. While the registry is missing
 * too, that is the reason given: its deployment (`deployRegistryCall`) comes
 * first, and the factory's can't be judged until it is there.
 */
export async function vaultAvailability(
  rpc: JsonRpc,
  options: { deployment?: FactoryDeployment; marketIndex?: number; reader?: Reader } = {},
): Promise<VaultAvailability> {
  const deployment = options.deployment ?? MAINNET_DEPLOYMENT;
  const index = options.marketIndex ?? 0;
  const factory = factoryAddress(deployment);
  const reasons: string[] = [];

  let factoryDeployed: boolean | null;
  try {
    factoryDeployed = ((await rpc("eth_getCode", [factory, "latest"])) as string) !== "0x";
  } catch {
    factoryDeployed = null;
  }
  let factoryDeployable: boolean | null = null;
  let registryDeployed: boolean | null = factoryDeployed === true ? true : null;
  if (factoryDeployed === false) {
    try {
      registryDeployed = ((await rpc("eth_getCode", [lower(deployment.registry), "latest"])) as string) !== "0x";
    } catch {
      registryDeployed = null;
    }
  }
  if (factoryDeployed === false && registryDeployed === false) {
    reasons.push(
      "the vault factory is not deployed on this chain yet, nor the SPX holder registry it needs first; deploying the registry, then the factory, is two transactions anyone can send",
    );
  } else if (factoryDeployed === false) {
    let check: FactoryDeploymentCheck | null;
    try {
      check = await simulateFactoryDeployment(rpc, deployment);
    } catch {
      check = null;
    }
    factoryDeployable = check === null ? null : check.deployable;
    reasons.push(
      check === null
        ? "the vault factory is not deployed on this chain yet, and the endpoint would not say whether deploying it would succeed"
        : check.deployable
          ? "the vault factory is not deployed on this chain yet; deploying it is one transaction anyone can send"
          : `the vault factory is not deployed on this chain yet, and deploying it would be refused right now: ${check.reason}`,
    );
  } else if (factoryDeployed === null) {
    reasons.push("could not check whether the vault factory is deployed on this chain");
  }

  const listed = Number.isSafeInteger(index) && index >= 0 ? deployment.markets[index] : undefined;
  if (!listed) {
    reasons.push(`market ${index} is not on this factory's list`);
    return {
      available: false,
      factory,
      factoryDeployed,
      registryDeployed,
      factoryDeployable,
      market: null,
      marketHealthy: null,
      oracleDepth: null,
      marketGapBps: null,
      reasons,
    };
  }
  const market = { index, tokenOut: lower(listed.tokenOut), pair: lower(listed.pair), oraclePool: lower(listed.oraclePool) };
  const { healthy, depth, gapBps, problems } = await marketHealth(
    options.reader ?? new Multicall3Reader(rpc),
    deployment.weth,
    market,
  );
  reasons.push(...problems);
  return {
    available: factoryDeployed === true && healthy === true,
    factory,
    factoryDeployed,
    registryDeployed,
    factoryDeployable,
    market,
    marketHealthy: healthy,
    oracleDepth: depth,
    marketGapBps: gapBps,
    reasons,
  };
}

/** One round trip: the pair's reserves, and the pool's history, average and depth. */
async function marketHealth(
  reader: Reader,
  weth: Address,
  market: Market,
): Promise<{ healthy: boolean | null; depth: bigint | null; gapBps: bigint | null; problems: string[] }> {
  let results: string[];
  try {
    results = await reader.multicall([
      { to: market.pair, data: encodeFunctionData({ abi: V2_PAIR_ABI, functionName: "getReserves" }) },
      { to: market.oraclePool, data: encodeFunctionData({ abi: V3_POOL_ABI, functionName: "slot0" }) },
      {
        to: market.oraclePool,
        data: encodeFunctionData({ abi: V3_POOL_ABI, functionName: "observe", args: [[Number(VAULT_LIMITS.TWAP_WINDOW), 0]] }),
      },
    ]);
  } catch {
    return { healthy: null, depth: null, gapBps: null, problems: ["could not read the market"] };
  }
  const reserves = decodeOr(results[0], (data) => decodeFunctionResult({ abi: V2_PAIR_ABI, functionName: "getReserves", data }));
  const slot0 = decodeOr(results[1], (data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "slot0", data }));
  const observed = decodeOr(results[2], (data) => decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "observe", data }));
  // The pair and the pool are Uniswap's own, so a read that fails is the endpoint's doing, not the market's.
  if (reserves === null || slot0 === null) {
    return { healthy: null, depth: null, gapBps: null, problems: ["could not read the market"] };
  }

  const problems: string[] = [];
  const wethIsToken0 = lower(weth) < lower(market.tokenOut);
  const [reserveWeth, reserveToken] = wethIsToken0 ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];
  if (reserveWeth === 0n || reserveToken === 0n) problems.push("the market's v2 pair holds no liquidity");

  if (BigInt(slot0[3]) < VAULT_LIMITS.MIN_OBSERVATIONS) {
    problems.push(`the market's oracle pool keeps too short a history (${slot0[3]} observations; the vault needs ${VAULT_LIMITS.MIN_OBSERVATIONS})`);
  }

  // "OLD" — the pool's history does not reach back ten minutes — comes back as a failed call.
  let depth: bigint | null = null;
  let gapBps: bigint | null = null;
  const [ticks, perLiquidity] = observed ?? [[], []];
  if (ticks.length < 2 || perLiquidity.length < 2) {
    problems.push("the market's oracle pool cannot answer a 10-minute average right now");
  } else {
    const reading = oracleReading({
      tickCumulatives: [ticks[0]!, ticks[1]!],
      secondsPerLiquidity: [perLiquidity[0]!, perLiquidity[1]!],
      wethIsToken0,
    });
    depth = reading.depth;
    if (reading.depth < VAULT_LIMITS.MIN_ORACLE_DEPTH) {
      problems.push(
        `the market's oracle pool is too thin to price a buy right now (${formatWeth(reading.depth)} WETH of depth over ten minutes; the vault needs ${formatWeth(VAULT_LIMITS.MIN_ORACLE_DEPTH)})`,
      );
    }
    // Token per WETH at the pool's average, scaled by 1e18, against the pair's mid.
    const poolOut = wethIsToken0 ? priceX18AtTick(reading.meanTick) : inversePriceX18AtTick(reading.meanTick);
    if (reserveWeth > 0n && reserveToken > 0n) {
      const pairOut = (reserveToken * 10n ** 18n) / reserveWeth;
      const gap = poolOut > pairOut ? poolOut - pairOut : pairOut - poolOut;
      gapBps = ((poolOut > pairOut ? 1n : -1n) * gap * 10_000n) / pairOut;
      if (gap * 10_000n > FACTORY_LIMITS.MAX_MARKET_GAP_BPS * pairOut) problems.push(describeMarketGap(gapBps));
    }
  }
  return { healthy: problems.length === 0, depth, gapBps, problems };
}

/**
 * A pool/pair gap beyond the listing's allowance, in words that are true for
 * a new vault and an existing one alike. The gap is checked when the factory
 * lists a market and never by a vault, so what it does to a buy depends on its
 * direction — and, one way, on the plan's own allowance: pass `maxSlippageBps`
 * to word it for one plan, as a vault's card should.
 */
export function describeMarketGap(gapBps: bigint, maxSlippageBps?: bigint): string {
  const size = gapBps < 0n ? -gapBps : gapBps;
  const allowed = `the listing allowed ${formatBps(FACTORY_LIMITS.MAX_MARKET_GAP_BPS)}`;
  if (gapBps < 0n) {
    const floor =
      maxSlippageBps === undefined
        ? `each buy's floor sits ${formatBps(size)} further below the pair's price than its plan's allowance`
        : `this plan's floor sits about ${formatBps(size + maxSlippageBps)} below the pair's price rather than ${formatBps(maxSlippageBps)}`;
    return `the market's oracle pool quotes ${formatBps(size)} fewer tokens per WETH than its pair right now (${allowed}): buys still go ahead, and ${floor} until the pool catches up`;
  }
  // Refused when the pair's output, after its 0.3% fee, is below the pool's
  // less the allowance: roughly when the gap exceeds the allowance less 0.3%.
  const waits =
    maxSlippageBps === undefined
      ? "a buy waits while the gap is more than its plan's allowance less the pair's 0.3% fee"
      : size + PAIR_FEE_BPS > maxSlippageBps
        ? `this plan's buys wait until the gap is under about ${formatBps(maxSlippageBps > PAIR_FEE_BPS ? maxSlippageBps - PAIR_FEE_BPS : 0n)}`
        : "this plan's buys still go ahead, its allowance being wider than the gap";
  return `the market's oracle pool quotes ${formatBps(size)} more tokens per WETH than its pair right now (${allowed}): ${waits}`;
}

/** Uniswap v2's fee, which every buy on the pair pays: 0.3%. */
const PAIR_FEE_BPS = 30n;

/**
 * A call's answer decoded, or null when there is none — a missing answer, or
 * "0x", which is how Multicall3 reports a failed call — or it does not decode:
 * a figure that could not be read is unknown, never zero.
 */
export function decodeOr<T>(data: string | undefined, decode: (data: Hex) => T): T | null {
  if (!data || data === "0x") return null;
  try {
    return decode(data as Hex);
  } catch {
    return null;
  }
}

function formatWeth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const tenths = (wei % 10n ** 18n) / 10n ** 17n;
  return `${whole}.${tenths}`;
}

function formatBps(bps: bigint): string {
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
}

/** Wei as ether, trailing zeros dropped, at most eight decimals: "9", "0.0006". */
function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 8)}` : `${whole}`;
}
