/**
 * An honest batch of two due buys in strangers' v2 vaults, made from the
 * user's account through the batcher bound to no factory, and the logs a
 * simulation of it shows — laid out as v2's `SpdexVaultBatcher` and vault emit
 * them (see packages/vault/test/integration/batcher.test.ts for the real thing
 * on the fork): each vault pays its fee straight to the account, names the
 * account as `rewardTo` and the batcher as its caller in its `Bought`, and
 * the batcher's `Batch` has no `swept`, since nothing passes through it.
 * `vault-batch.test.ts` pins that these decode with the vault package's own
 * decoders, and changes one thing per case.
 *
 * `V1` and `V2` here are the first and second vault of the batch, both v2's,
 * each where v2's factory puts its owner's first vault on `VAULT_TERMS`, and
 * each with the claim (`CLAIMS`) the host hands over to prove it; a v1 vault,
 * where a case needs one, is named so.
 */

import { SPX, USER, WETH, addressTopic, transferLog, uint256Data } from "@spdex/testing";
import type { Address, Hex } from "@spdex/core";
import type { SimLog } from "@spdex/chain";
import {
  BATCHER_EVENT_TOPICS,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  batchGasLimit,
  buyFee,
  encodeExecuteBatch,
  predictVault,
  termsOfPlan,
  type VaultTerms,
} from "@spdex/vault";
import type { VaultBatchCall, VaultBatchIntent, VaultBatchTxPlan, VaultClaim } from "../../../src/vault.js";

export const BATCHER: Address = MAINNET_BATCHER;
export const PAIR: Address = MAINNET_DEPLOYMENT.markets[0].pair;

/** 0.05 ETH a buy, at the fee spDEX proposes for it. */
export const AMOUNT = 5n * 10n ** 16n;
export const REWARD = buyFee(AMOUNT).reward;

/** Both strangers' plans: 0.05 ETH of SPX an hour, three times, a 15-minute window, no turns. */
export const VAULT_TERMS: VaultTerms = termsOfPlan({
  marketIndex: 0n,
  amountPerBuy: AMOUNT,
  interval: 3_600n,
  maxBuys: 3n,
  startAt: 1_790_000_000n,
  keeperReward: REWARD,
  maxSlippageBps: 300n,
  communityWindow: 900n,
  turnBuckets: 0n,
});

/** Two strangers and their first vaults on v2's factory; neither is the account. */
export const O1: Address = "0x0a010a010a010a010a010a010a010a010a010a01";
export const O2: Address = "0x0a020a020a020a020a020a020a020a020a020a02";
export const V1: Address = predictVault({ factory: MAINNET_FACTORY, owner: O1, nonce: 0n, terms: VAULT_TERMS });
export const V2: Address = predictVault({ factory: MAINNET_FACTORY, owner: O2, nonce: 0n, terms: VAULT_TERMS });

/** The claim the host hands over for a vault: whose, which nonce, which release, on what terms. */
export const claimOf = (vault: Address, owner: Address, overrides: Partial<VaultClaim> = {}): VaultClaim => ({
  address: vault,
  owner,
  nonce: 0n,
  terms: { ...VAULT_TERMS },
  release: "v2",
  ...overrides,
});
/** `V1`'s and `V2`'s claims, in the batch's order. */
export const CLAIMS: readonly VaultClaim[] = [claimOf(V1, O1), claimOf(V2, O2)];
export const OUT = 24_385_489_845n;
export const FLOOR = 24_000_000_000n;
export const EARNED = 2n * REWARD;

/** 0.1 gwei: a price at which one buy's fee pays for the 150,000 gas the test-runs here use. */
export const GAS_PRICE = 100_000_000n;
/** Room for two first buys: what the host signs a two-vault batch with. */
export const GAS_LIMIT = batchGasLimit([{ firstBuy: true }, { firstBuy: true }]);
/** The least the batch may earn: its gas at the signed price, with room, well under what it earns. */
export const MIN_REWARDS = REWARD;

/** Reason codes, by selector; `vault-batch.test.ts` pins each to its name with `reasonName`. */
export const REASONS = {
  /** v1's batcher's only: the factory it is bound to doesn't vouch for the vault. */
  NotFromFactory: "0xb1391cf3",
  NotTried: "0x51d43e40",
  /** The call found no code: a vault not created yet. */
  EmptyReturn: "0x81abc716",
  TooSoon: "0xe86f59ea",
  /** A vault inside its community window, and an account the registry doesn't vouch for. */
  NotEligible: "0x5863fc24",
} as const satisfies Record<string, Hex>;

/** `NothingBought(bytes4[])`'s selector. */
export const NOTHING_BOUGHT = "0x2aae24c2" as Hex;

/** v2's vault `Bought` topic, as vault.test.ts pins it; v1's for a case that needs the old layout. */
export const BOUGHT_TOPIC = "0xa4e7d498bb99e1cbc60382035c43839f92324815f578268f03ea5b8ba4224764" as Hex;
export const V1_BOUGHT_TOPIC = "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6" as Hex;

/** When each buy fell due, chain time: its community window ran from here. */
export const DUE_SINCE = 1_790_000_000n;

const words = (...values: (bigint | Address)[]): Hex =>
  `0x${values.map((v) => (typeof v === "bigint" ? uint256Data(v).slice(2) : addressTopic(v).slice(2))).join("")}` as Hex;

export function batchIntent(overrides: Partial<VaultBatchIntent> = {}): VaultBatchIntent {
  return {
    version: 1,
    action: "batch",
    chainId: 1,
    account: USER,
    vaults: [V1, V2],
    claims: CLAIMS,
    rewardTo: USER,
    minRewards: MIN_REWARDS,
    gasLimit: GAS_LIMIT,
    gasPrice: GAS_PRICE,
    ...overrides,
  };
}

/** The call the host builds for `intent`, exactly: to the newest batcher, with its least gas per vault. */
export function batchCall(intent: VaultBatchIntent): VaultBatchCall {
  return {
    to: BATCHER,
    data: encodeExecuteBatch(intent.vaults, intent.rewardTo, intent.minRewards, { batcher: BATCHER }),
    value: 0n,
    gas: intent.gasLimit,
    gasPrice: intent.gasPrice,
  };
}

export function batchPlan(overrides: Partial<VaultBatchIntent> = {}): VaultBatchTxPlan {
  const intent = batchIntent(overrides);
  return { version: 1, intent, calls: [batchCall(intent)] };
}

/**
 * v2's `Bought(slot indexed, amountIn, amountOut, keeper indexed, reward,
 * floorOut, buyNumber, oracleDepth, rewardTo indexed, dueSince)`: the
 * batcher calls, the account is paid.
 */
export const boughtLog = (
  vault: Address,
  keeper: Address = BATCHER,
  out = OUT,
  amountIn = AMOUNT,
  reward = REWARD,
  floor = FLOOR,
  rewardTo: Address = USER,
): SimLog => ({
  address: vault,
  topics: [BOUGHT_TOPIC, uint256Data(0n), addressTopic(keeper), addressTopic(rewardTo)],
  data: words(amountIn, out, reward, floor, 1n, 20n * 10n ** 18n, DUE_SINCE),
});

/** v1's `Bought`, with no `rewardTo` or `dueSince`: what a v1 vault logs, the fee paid to its caller. */
export const v1BoughtLog = (vault: Address, keeper: Address = BATCHER, out = OUT, amountIn = AMOUNT, reward = REWARD, floor = FLOOR): SimLog => ({
  address: vault,
  topics: [V1_BOUGHT_TOPIC, uint256Data(0n), addressTopic(keeper)],
  data: words(amountIn, out, reward, floor, 1n, 20n * 10n ** 18n),
});

/** `Triggered(vault indexed, received, gasUsed)`: the same in both releases. */
export const triggeredLog = (vault: Address, received = OUT, emitter: Address = BATCHER): SimLog => ({
  address: emitter,
  topics: [BATCHER_EVENT_TOPICS.v2.Triggered, addressTopic(vault)],
  data: words(received, 150_000n),
});

/** `NotTriggered(vault indexed, reason indexed, gasUsed)`: a bytes4 topic is left-aligned. */
export const notTriggeredLog = (vault: Address, reason: Hex, emitter: Address = BATCHER): SimLog => ({
  address: emitter,
  topics: [BATCHER_EVENT_TOPICS.v2.NotTriggered, addressTopic(vault), `${reason}${"0".repeat(56)}` as Hex],
  data: words(30_000n),
});

export interface BatchFigures {
  caller: Address;
  rewardTo: Address;
  listed: bigint;
  tried: bigint;
  bought: bigint;
  earned: bigint;
}

/** v2's `Batch(caller indexed, rewardTo indexed, listed, tried, bought, earned)`. */
export const batchLog = (figures: Partial<BatchFigures> = {}, emitter: Address = BATCHER): SimLog => {
  const f: BatchFigures = { caller: USER, rewardTo: USER, listed: 2n, tried: 2n, bought: 2n, earned: EARNED, ...figures };
  return {
    address: emitter,
    topics: [BATCHER_EVENT_TOPICS.v2.Batch, addressTopic(f.caller), addressTopic(f.rewardTo)],
    data: words(f.listed, f.tried, f.bought, f.earned),
  };
};

/** v1's `Batch`, which also says what stray WETH it swept: the layout v1's batcher logs. */
export const v1BatchLog = (figures: Partial<BatchFigures & { swept: bigint }> = {}, emitter: Address = BATCHER): SimLog => {
  const f = { caller: USER, rewardTo: USER, listed: 2n, tried: 2n, bought: 2n, earned: EARNED, swept: 0n, ...figures };
  return {
    address: emitter,
    topics: [BATCHER_EVENT_TOPICS.v1.Batch, addressTopic(f.caller), addressTopic(f.rewardTo)],
    data: words(f.listed, f.tried, f.bought, f.earned, f.swept),
  };
};

/** One vault's buy inside the batch: its WETH to the pair, SPX to its owner, its fee to the account, `Bought`, `Triggered`. */
export const vaultBuy = (vault: Address, owner: Address, keeper: Address = BATCHER, rewardTo: Address = USER): SimLog[] => [
  transferLog(WETH, vault, PAIR, AMOUNT),
  transferLog(SPX, PAIR, owner, OUT),
  transferLog(WETH, vault, rewardTo, REWARD),
  boughtLog(vault, keeper, OUT, AMOUNT, REWARD, FLOOR, rewardTo),
  triggeredLog(vault),
];

/** Both vaults buy, each paying the account directly, and the batcher says so. */
export const honestBatchLogs = (): SimLog[] => [...vaultBuy(V1, O1), ...vaultBuy(V2, O2), batchLog()];

/** `NothingBought(reasons)`'s revert data, one bytes4 per vault. */
export function nothingBoughtData(reasons: readonly Hex[]): Hex {
  const head = uint256Data(32n).slice(2) + uint256Data(BigInt(reasons.length)).slice(2);
  return `${NOTHING_BOUGHT}${head}${reasons.map((r) => r.slice(2).padEnd(64, "0")).join("")}` as Hex;
}
