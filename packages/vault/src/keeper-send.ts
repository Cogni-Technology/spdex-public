/**
 * The keeper's one nonce manager: every transaction the keeper signs is built
 * here, by hand, checked here, recorded here before it is sent, and followed
 * here until it is mined, replaced, cancelled or abandoned.
 *
 * ## One transaction at a time
 *
 * A new transaction is signed only when none is in flight, at the larger of
 * the chain's `latest` nonce and the next one this keeper knows it used —
 * `latest`, not `pending`, because a private relay's transaction is invisible
 * to a public endpoint's pending pool. Several transactions in flight through
 * a private relay, one of which it drops, is how keepers get stuck behind a
 * nonce gap; a batch that has to wait twelve seconds for the one before is
 * the cheaper failure.
 *
 * ## Write-ahead
 *
 * The signed bytes are put into the state and the state is persisted before
 * they are broadcast. A keeper that dies after sending finds the transaction
 * on restart and follows it, instead of signing another at the next nonce.
 *
 * ## What the keeper will sign
 *
 * `assertKeeperMaySign` is the keeper's version of the Guard: right before
 * every signature it allows exactly four shapes — a batch to a listed batcher
 * paying the configured `rewardTo`, the deployment of a listed batcher, a
 * zero-value cancel to itself, and an unwrap of its own WETH when it is its
 * own `rewardTo` — and throws for anything else, whatever the code around it
 * meant to do.
 */

import { decodeFunctionData } from "viem";
import type { Address, Hex } from "@spdex/core";
import { signPrepared, type JsonRpc, type PreparedFees, type PreparedTransaction } from "@spdex/chain";
import { BATCHER_ABI, DETERMINISTIC_DEPLOYER } from "./artifacts.js";
import { deployBatcherCall, joinBatchLogs } from "./batcher.js";
import type { RawLog } from "./index.js";
import { keeperAddress, rewardToOf, type KeeperConfig } from "./keeper-config.js";
import type { MinedBuy, MinedRefusal } from "./keeper-log.js";
import type { KeeperState, PendingAttempt, PendingTx } from "./keeper-state.js";

export const EXECUTE_BATCH_SELECTOR = "0xf4ccdffc";
export const WETH_WITHDRAW_SELECTOR = "0x2e1a7d4d";
/** A cancel is a plain transfer. */
export const CANCEL_GAS = 21_000n;
/** WETH's `withdraw`, with room: about 35,000 in practice. */
export const UNWRAP_GAS = 60_000n;

// ─── What may be signed ───────────────────────────────────────────────────────

/** The keeper was asked to sign something outside the four shapes it may. */
export class KeeperSignRefused extends Error {
  constructor(message: string) {
    super(`refusing to sign: ${message}`);
    this.name = "KeeperSignRefused";
  }
}

/**
 * Throw unless `tx` is one of the four transactions a keeper signs: a batch
 * to a listed batcher paying the configured `rewardTo`; a listed batcher's
 * deployment through the deterministic deployer; a zero-value, empty cancel
 * to itself; or `WETH.withdraw` of its own rewards, only when it is its own
 * `rewardTo`. Every one carries no ether.
 */
export function assertKeeperMaySign(tx: PreparedTransaction, config: KeeperConfig): void {
  const keeper = keeperAddress(config);
  if (keeper === null) throw new KeeperSignRefused("this keeper has no key");
  if (lower(tx.from) !== keeper) throw new KeeperSignRefused("the transaction is not from this keeper");
  if (tx.chainId !== config.chainId) throw new KeeperSignRefused(`the transaction is for chain ${tx.chainId}, not ${config.chainId}`);
  if (tx.value !== 0n) throw new KeeperSignRefused("it would send ether");
  const to = lower(tx.to);
  const data = tx.data.toLowerCase() as Hex;

  if (config.deployments.some((d) => lower(d.batcher) === to)) {
    if (!data.startsWith(EXECUTE_BATCH_SELECTOR)) throw new KeeperSignRefused("only executeBatch may be sent to a batcher");
    let args: readonly unknown[];
    try {
      args = decodeFunctionData({ abi: BATCHER_ABI, data }).args ?? [];
    } catch {
      throw new KeeperSignRefused("the batch's calldata does not decode");
    }
    if (lower(String(args[1])) !== rewardToOf(config)) throw new KeeperSignRefused("the batch pays a rewardTo other than the configured one");
    return;
  }
  if (to === DETERMINISTIC_DEPLOYER) {
    if (config.deployments.some((d) => deployBatcherCall(lower(d.factory)).data.toLowerCase() === data)) return;
    throw new KeeperSignRefused("only a listed batcher's deployment may be sent to the deployer");
  }
  if (to === keeper) {
    if (data === "0x") return;
    throw new KeeperSignRefused("a transaction to itself must be an empty cancel");
  }
  if (to === lower(config.weth)) {
    if (!data.startsWith(WETH_WITHDRAW_SELECTOR) || data.length !== 2 + 8 + 64) throw new KeeperSignRefused("only withdraw may be sent to WETH");
    if (rewardToOf(config) !== keeper) throw new KeeperSignRefused("rewards go elsewhere, so there is nothing of the keeper's to unwrap");
    return;
  }
  throw new KeeperSignRefused(`${to} is not a listed batcher, the deployer, WETH or the keeper`);
}

// ─── Building and sending ─────────────────────────────────────────────────────

/** A transaction, by hand: the keeper's own gas limit and fees, never an endpoint's estimate. */
export function buildTransaction(input: { from: Address; chainId: number; nonce: number; to: Address; data: Hex; gas: bigint; fees: PreparedFees }): PreparedTransaction {
  return { from: lower(input.from), chainId: input.chainId, nonce: input.nonce, to: lower(input.to), data: input.data, value: 0n, gas: input.gas, fees: input.fees };
}

/** The nonce for a new transaction: the chain's `latest` count, or the next one this keeper used, whichever is later. */
export async function nextNonceFor(rpc: JsonRpc, keeper: Address, state: Pick<KeeperState, "nextNonce">): Promise<number> {
  const latest = Number(BigInt((await rpc("eth_getTransactionCount", [keeper, "latest"])) as string));
  return state.nextNonce !== null && state.nextNonce > latest ? state.nextNonce : latest;
}

/** `<keeper>:<nonce>:<n>`, where `n` counts the batches that nonce has carried (an expired batch's nonce is reused). */
export function newBatchId(state: Pick<KeeperState, "nonceUses">, keeper: Address, nonce: number): string {
  const uses = state.nonceUses[String(nonce)] ?? 0;
  state.nonceUses[String(nonce)] = uses + 1;
  return `${keeper}:${nonce}:${uses}`;
}

/** A new transaction in flight, nothing sent yet: `fields` says what it is, and everything else starts empty. */
export function newPendingTx(
  state: Pick<KeeperState, "nonceUses">,
  keeper: Address,
  nonce: number,
  purpose: PendingTx["purpose"],
  fields: Partial<Omit<PendingTx, "batchId" | "nonce" | "purpose">> = {},
): PendingTx {
  return {
    batchId: newBatchId(state, keeper, nonce),
    nonce,
    purpose,
    deployment: null,
    vaults: [],
    urgent: false,
    reason: null,
    gasLimit: 0n,
    modelGas: 0n,
    expectedGas: 0n,
    expectedCostWei: 0n,
    expectedEarnedWei: 0n,
    minRewards: 0n,
    subsidy: [],
    amountWei: null,
    resends: 0,
    stoppedResending: false,
    receiptBlock: null,
    missedReceiptChecks: 0,
    consumedSeenAt: null,
    attempts: [],
    ...fields,
  };
}

export type SendErrorKind = "known" | "nonce-too-low" | "underpriced" | "other";

/**
 * What an endpoint's refusal of `eth_sendRawTransaction` means. "Already
 * known" is a success: the transaction is in its pool. "Nonce too low" may be
 * this very transaction, mined; the receipts will say. "Underpriced" is a
 * replacement that did not bid enough; the next resend bids more.
 */
export function classifySendError(error: unknown): SendErrorKind {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/already known|known transaction|already imported|already in (the )?(pool|mempool)/.test(message)) return "known";
  if (/nonce too low|nonce is too low|oldnonce|nonce has already been used/.test(message)) return "nonce-too-low";
  if (/underpriced|fee too low|replacement/.test(message)) return "underpriced";
  return "other";
}

/**
 * Sign `tx`, record it as an attempt of `pending` (which becomes the state's
 * pending transaction), with what `pending` says it carries, persist, and
 * only then broadcast it to `sendRpc`.
 * Returns the attempt, and how the endpoint refused it, if it did; a refused
 * attempt stays recorded, and the next tick decides what it meant. Never falls
 * back from a private endpoint to a public one.
 */
export async function signRecordSend(input: {
  sendRpc: JsonRpc;
  config: KeeperConfig;
  state: KeeperState;
  pending: PendingTx;
  tx: PreparedTransaction;
  kind: PendingAttempt["kind"];
  sentBlock: bigint;
  persist: () => Promise<void>;
}): Promise<{ attempt: PendingAttempt; refused: { kind: SendErrorKind; message: string } | null }> {
  const { config, tx } = input;
  assertKeeperMaySign(tx, config);
  if (!config.keeperKey) throw new KeeperSignRefused("this keeper has no key");
  const { raw, hash } = await signPrepared(config.keeperKey, tx);
  const { vaults, subsidy, modelGas } = input.pending;
  const attempt: PendingAttempt = {
    kind: input.kind,
    hash: hash.toLowerCase() as Hex,
    raw: raw.toLowerCase() as Hex,
    sentBlock: input.sentBlock,
    fees: tx.fees,
    vaults,
    subsidy,
    modelGas,
  };
  input.pending.attempts.push(attempt);
  input.state.pending = input.pending;
  await input.persist();
  try {
    await input.sendRpc("eth_sendRawTransaction", [attempt.raw]);
    return { attempt, refused: null };
  } catch (error) {
    const kind = classifySendError(error);
    return { attempt, refused: kind === "known" ? null : { kind, message: error instanceof Error ? error.message : String(error) } };
  }
}

// ─── Receipts ─────────────────────────────────────────────────────────────────

export interface RpcReceipt {
  transactionHash: Hex;
  status: bigint;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: (RawLog & { logIndex: string | number })[];
}

/** A receipt, or null when there is none yet. */
export async function readReceipt(rpc: JsonRpc, hash: Hex): Promise<RpcReceipt | null> {
  const r = (await rpc("eth_getTransactionReceipt", [hash])) as {
    transactionHash: string;
    status: string;
    blockNumber: string;
    gasUsed: string;
    effectiveGasPrice?: string;
    logs: (RawLog & { logIndex: string })[];
  } | null;
  if (!r || !r.blockNumber) return null;
  return {
    transactionHash: r.transactionHash.toLowerCase() as Hex,
    status: BigInt(r.status),
    blockNumber: BigInt(r.blockNumber),
    gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice ?? "0x0"),
    logs: r.logs,
  };
}

/** The receipt of whichever attempt was mined — every attempt's hash is looked up, since any of them may be. */
export async function receiptOfAny(rpc: JsonRpc, attempts: readonly PendingAttempt[]): Promise<{ attempt: PendingAttempt; receipt: RpcReceipt } | null> {
  for (const attempt of [...attempts].reverse()) {
    const receipt = await readReceipt(rpc, attempt.hash);
    if (receipt) return { attempt, receipt };
  }
  return null;
}

/** Confirmed when the head is at least `confirmations − 1` blocks past the receipt's: its own block counts, so 1 needs no further block. */
export const isConfirmed = (head: bigint, receiptBlock: bigint, confirmations: number): boolean =>
  head - receiptBlock + 1n >= BigInt(confirmations);

/** What a mined batch did, from its receipt. */
export interface BatchMined {
  batchId: string;
  hash: Hex;
  nonce: number;
  block: bigint;
  status: "success" | "reverted";
  late: boolean;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  costWei: bigint;
  /** WETH the batch earned: `Batch.earned`. Stray WETH it swept is never revenue. */
  earnedWei: bigint;
  sweptWei: bigint;
  netWei: bigint;
  listed: bigint;
  tried: bigint;
  bought: MinedBuy[];
  refused: MinedRefusal[];
  notTried: Address[];
}

/**
 * Decode a batch's receipt: the batcher's `Batch`, each vault's `Bought`
 * joined to the batcher's `Triggered` right after it (`joinBatchLogs`), and
 * each `NotTriggered`. Only logs from `batcher` count as the batcher's, and
 * only a `Bought` from the vault its `Triggered` names counts as that vault's.
 * A vault listed but in neither was not tried.
 */
export function decodeBatchReceipt(input: {
  receipt: RpcReceipt;
  batcher: Address;
  vaults: readonly Address[];
  clockOf: (vault: Address) => { startAt: bigint; interval: bigint } | null;
  blockTime: bigint;
  batchId: string;
  nonce: number;
  late: boolean;
}): BatchMined {
  const { receipt } = input;
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const base = {
    batchId: input.batchId,
    hash: receipt.transactionHash,
    nonce: input.nonce,
    block: receipt.blockNumber,
    late: input.late,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    costWei,
  };
  if (receipt.status !== 1n) {
    return { ...base, status: "reverted", earnedWei: 0n, sweptWei: 0n, netWei: -costWei, listed: BigInt(input.vaults.length), tried: 0n, bought: [], refused: [], notTried: [] };
  }
  const batcher = lower(input.batcher);
  const runs = joinBatchLogs(receipt.logs, (address) => address === batcher);
  const batch = runs.find((run) => run.batch !== null)?.batch ?? null;
  const bought: MinedBuy[] = [];
  const refused: MinedRefusal[] = [];
  for (const run of runs) {
    for (const { event, bought: b } of run.triggered) {
      if (b === null) continue;
      const clock = input.clockOf(event.vault);
      const windowStart = clock ? clock.startAt + b.slot * clock.interval : null;
      bought.push({
        vault: event.vault,
        slot: b.slot,
        buyNumber: b.buyNumber,
        amountIn: b.amountIn,
        amountOut: b.amountOut,
        floorOut: b.floorOut,
        oracleDepth: b.oracleDepth,
        reward: b.reward,
        gasUsed: event.gasUsed,
        secondsIntoWindow: windowStart === null ? 0n : input.blockTime - windowStart,
      });
    }
    for (const event of run.notTriggered) refused.push({ vault: event.vault, reason: event.reason, reasonName: event.reasonName, gasUsed: event.gasUsed });
  }
  const seen = new Set<Address>([...bought.map((b) => b.vault), ...refused.map((r) => r.vault)]);
  const earnedWei = batch?.earned ?? 0n;
  return {
    ...base,
    status: "success",
    earnedWei,
    sweptWei: batch?.swept ?? 0n,
    netWei: earnedWei - costWei,
    listed: batch?.listed ?? BigInt(input.vaults.length),
    tried: batch?.tried ?? BigInt(seen.size),
    bought,
    refused,
    notTried: input.vaults.map(lower).filter((v) => !seen.has(v)),
  };
}

// ─── Replies that carry a revert ──────────────────────────────────────────────

/** The revert data an endpoint attached to a failed call, or null when it attached none. */
export function revertDataOf(thrown: unknown): Hex | null {
  const data = (thrown as { data?: unknown } | null)?.data;
  if (typeof data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(data)) return data.toLowerCase() as Hex;
  if (typeof data === "object" && data !== null) {
    const inner = (data as { data?: unknown }).data;
    if (typeof inner === "string" && /^0x([0-9a-fA-F]{2})*$/.test(inner)) return inner.toLowerCase() as Hex;
  }
  return null;
}

const lower = (a: string): Address => a.toLowerCase() as Address;
