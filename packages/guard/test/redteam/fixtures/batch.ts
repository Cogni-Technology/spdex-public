/**
 * An honest batch of two due buys in strangers' vaults, made from the user's
 * account through the batcher, and the logs a simulation of it shows — laid
 * out as `SpdexVaultBatcher` and the vault emit them (see
 * packages/vault/test/integration/batcher.test.ts for the real thing on the
 * fork). `vault-batch.test.ts` pins that these decode with the vault
 * package's own decoders, and changes one thing per case.
 */

import { SPX, USER, WETH, addressTopic, transferLog, uint256Data } from "@spdex/testing";
import type { Address, Hex } from "@spdex/core";
import type { SimLog } from "@spdex/chain";
import {
  BATCHER_EVENT_TOPICS,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  batchGasLimit,
  buyFee,
  encodeExecuteBatch,
} from "@spdex/vault";
import type { VaultBatchCall, VaultBatchIntent, VaultBatchTxPlan } from "../../../src/vault.js";

export const BATCHER: Address = MAINNET_BATCHER;
export const PAIR: Address = MAINNET_DEPLOYMENT.markets[0].pair;

/** Two strangers' vaults and their owners; neither is the account. */
export const V1: Address = "0x7a017a017a017a017a017a017a017a017a017a01";
export const V2: Address = "0x7a027a027a027a027a027a027a027a027a027a02";
export const O1: Address = "0x0a010a010a010a010a010a010a010a010a010a01";
export const O2: Address = "0x0a020a020a020a020a020a020a020a020a020a02";

/** 0.05 ETH a buy, at the fee spDEX proposes for it. */
export const AMOUNT = 5n * 10n ** 16n;
export const REWARD = buyFee(AMOUNT).reward;
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
  NotFromFactory: "0xb1391cf3",
  NotTried: "0x51d43e40",
  TooSoon: "0xe86f59ea",
} as const satisfies Record<string, Hex>;

/** `NothingBought(bytes4[])`'s selector. */
export const NOTHING_BOUGHT = "0x2aae24c2" as Hex;

/** The vault's `Bought` topic, as vault.test.ts pins it. */
const BOUGHT_TOPIC = "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6" as Hex;

const words = (...values: (bigint | Address)[]): Hex =>
  `0x${values.map((v) => (typeof v === "bigint" ? uint256Data(v).slice(2) : addressTopic(v).slice(2))).join("")}` as Hex;

export function batchIntent(overrides: Partial<VaultBatchIntent> = {}): VaultBatchIntent {
  return {
    version: 1,
    action: "batch",
    chainId: 1,
    account: USER,
    vaults: [V1, V2],
    rewardTo: USER,
    minRewards: MIN_REWARDS,
    gasLimit: GAS_LIMIT,
    gasPrice: GAS_PRICE,
    ...overrides,
  };
}

/** The call the host builds for `intent`, exactly. */
export function batchCall(intent: VaultBatchIntent): VaultBatchCall {
  return {
    to: BATCHER,
    data: encodeExecuteBatch(intent.vaults, intent.rewardTo, intent.minRewards),
    value: 0n,
    gas: intent.gasLimit,
    gasPrice: intent.gasPrice,
  };
}

export function batchPlan(overrides: Partial<VaultBatchIntent> = {}): VaultBatchTxPlan {
  const intent = batchIntent(overrides);
  return { version: 1, intent, calls: [batchCall(intent)] };
}

/** `Bought(slot indexed, keeper indexed, amountIn, amountOut, reward, floorOut, buyNumber, oracleDepth)`. */
export const boughtLog = (vault: Address, keeper: Address, out = OUT, amountIn = AMOUNT, reward = REWARD, floor = FLOOR): SimLog => ({
  address: vault,
  topics: [BOUGHT_TOPIC, uint256Data(0n), addressTopic(keeper)],
  data: words(amountIn, out, reward, floor, 1n, 20n * 10n ** 18n),
});

/** `Triggered(vault indexed, received, gasUsed)`. */
export const triggeredLog = (vault: Address, received = OUT, emitter: Address = BATCHER): SimLog => ({
  address: emitter,
  topics: [BATCHER_EVENT_TOPICS.Triggered, addressTopic(vault)],
  data: words(received, 150_000n),
});

/** `NotTriggered(vault indexed, reason indexed, gasUsed)`: a bytes4 topic is left-aligned. */
export const notTriggeredLog = (vault: Address, reason: Hex, emitter: Address = BATCHER): SimLog => ({
  address: emitter,
  topics: [BATCHER_EVENT_TOPICS.NotTriggered, addressTopic(vault), `${reason}${"0".repeat(56)}` as Hex],
  data: words(30_000n),
});

export interface BatchFigures {
  caller: Address;
  rewardTo: Address;
  listed: bigint;
  tried: bigint;
  bought: bigint;
  earned: bigint;
  swept: bigint;
}

/** `Batch(caller indexed, rewardTo indexed, listed, tried, bought, earned, swept)`. */
export const batchLog = (figures: Partial<BatchFigures> = {}, emitter: Address = BATCHER): SimLog => {
  const f: BatchFigures = { caller: USER, rewardTo: USER, listed: 2n, tried: 2n, bought: 2n, earned: EARNED, swept: 0n, ...figures };
  return {
    address: emitter,
    topics: [BATCHER_EVENT_TOPICS.Batch, addressTopic(f.caller), addressTopic(f.rewardTo)],
    data: words(f.listed, f.tried, f.bought, f.earned, f.swept),
  };
};

/** One vault's buy inside the batch: its WETH to the pair, SPX to its owner, its fee to the batcher, `Bought`, `Triggered`. */
export const vaultBuy = (vault: Address, owner: Address, keeper: Address = BATCHER): SimLog[] => [
  transferLog(WETH, vault, PAIR, AMOUNT),
  transferLog(SPX, PAIR, owner, OUT),
  transferLog(WETH, vault, BATCHER, REWARD),
  boughtLog(vault, keeper),
  triggeredLog(vault),
];

/** Both vaults buy, and the batcher passes both fees to the account. */
export const honestBatchLogs = (): SimLog[] => [
  ...vaultBuy(V1, O1),
  ...vaultBuy(V2, O2),
  transferLog(WETH, BATCHER, USER, EARNED),
  batchLog(),
];

/** `NothingBought(reasons)`'s revert data, one bytes4 per vault. */
export function nothingBoughtData(reasons: readonly Hex[]): Hex {
  const head = uint256Data(32n).slice(2) + uint256Data(BigInt(reasons.length)).slice(2);
  return `${NOTHING_BOUGHT}${head}${reasons.map((r) => r.slice(2).padEnd(64, "0")).join("")}` as Hex;
}
