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
 * every signature it allows exactly five shapes — a batch to a listed batcher
 * paying the configured `rewardTo`, at the configured gas per vault, the
 * deployment of a listed batcher, a zero-value cancel to itself, an unwrap of
 * its own WETH when it is its own `rewardTo`, and, only with
 * `SPDEX_KEEPER_PROVE=1`, a proof of the configured `rewardTo`'s SPX to a
 * listed release's registry — and throws for anything else, whatever the code
 * around it meant to do.
 *
 * Which batcher code a release's batcher is, and so its calldata and its
 * deployment, is the release's data, never its name (`batcherSourceOfDeployment`):
 * v1's is bound to v1's factory and takes three arguments; from v2 on one
 * batcher, bound to no factory, serves every release whose vaults take
 * `rewardTo`, and takes the gas each vault is given as a fourth. A release
 * built from an existing source needs nothing here.
 */

import { decodeFunctionData, encodeFunctionData } from "viem";
import type { Address, Hex } from "@spdex/core";
import { signPrepared, type JsonRpc, type PreparedFees, type PreparedTransaction } from "@spdex/chain";
import {
  BATCHER_ABI,
  DETERMINISTIC_DEPLOYER,
  REGISTRY_ABI,
  SOURCES,
  V1_BATCHER_ABI,
  batcherAddress,
  batcherInitCode,
  type Deployment,
  type SourceId,
} from "./artifacts.js";
import { joinBatchLogs } from "./batcher.js";
import { batcherSourceOf } from "./releases.js";
import type { RawLog } from "./index.js";
import { keeperAddress, rewardToOf, type KeeperConfig } from "./keeper-config.js";
import type { MinedBuy, MinedRefusal } from "./keeper-log.js";
import type { KeeperState, PendingAttempt, PendingTx } from "./keeper-state.js";

export const WETH_WITHDRAW_SELECTOR = "0x2e1a7d4d";
/** The SPX holder registry's `prove(address,bytes,bytes[],bytes[])`. */
export const PROVE_SELECTOR = "0x0c4ce46d";
/** A cancel is a plain transfer. */
export const CANCEL_GAS = 21_000n;
/** WETH's `withdraw`, with room: about 35,000 in practice. */
export const UNWRAP_GAS = 60_000n;

// ─── What may be signed ───────────────────────────────────────────────────────

/** The keeper was asked to sign something outside the five shapes it may. */
export class KeeperSignRefused extends Error {
  constructor(message: string) {
    super(`refusing to sign: ${message}`);
    this.name = "KeeperSignRefused";
  }
}

/**
 * Throw unless `tx` is one of the five transactions a keeper signs: a batch
 * to a listed batcher paying the configured `rewardTo` — and, to a batcher
 * that takes it, giving each vault the configured `gasPerVault`; a listed
 * batcher's deployment through the deterministic deployer, from its own code,
 * landing at the address its release lists;
 * a zero-value, empty cancel to itself; `WETH.withdraw` of its own rewards,
 * only when it is its own `rewardTo`; or `prove` to a listed release's SPX
 * holder registry for the configured `rewardTo` and no one else, only when
 * the operator turned proving on (`config.prove`). Every one carries no ether.
 *
 * The fifth shape is as narrow as it is because a hot key that can be talked
 * into signing anything for a registry is one a bug, or an endpoint that
 * lies, could spend: a proof moves no money, but its gas is the key's. A
 * proof for another holder, a call to a registry that is not listed, or any
 * other function of one, is refused, and so is every proof while proving is
 * off.
 */
export function assertKeeperMaySign(tx: PreparedTransaction, config: KeeperConfig): void {
  const keeper = keeperAddress(config);
  if (keeper === null) throw new KeeperSignRefused("this keeper has no key");
  if (lower(tx.from) !== keeper) throw new KeeperSignRefused("the transaction is not from this keeper");
  if (tx.chainId !== config.chainId) throw new KeeperSignRefused(`the transaction is for chain ${tx.chainId}, not ${config.chainId}`);
  if (tx.value !== 0n) throw new KeeperSignRefused("it would send ether");
  const to = lower(tx.to);
  const data = tx.data.toLowerCase() as Hex;

  const batching = config.deployments.find((d) => lower(d.batcher) === to);
  if (batching) {
    const source = batcherSourceOfDeployment(batching);
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      const call = decodeFunctionData({ abi: SOURCES[source].batcherAbi as typeof BATCHER_ABI, data });
      decoded = { functionName: call.functionName, args: call.args ?? [] };
    } catch {
      throw new KeeperSignRefused("only executeBatch may be sent to a batcher, and the calldata must decode as this batcher's");
    }
    if (decoded.functionName !== "executeBatch") throw new KeeperSignRefused("only executeBatch may be sent to a batcher");
    const args = decoded.args;
    if (lower(String(args[1])) !== rewardToOf(config)) throw new KeeperSignRefused("the batch pays a rewardTo other than the configured one");
    if (SOURCES[source].features.sharedBatcher && args[3] !== config.gasPerVault) {
      throw new KeeperSignRefused(`the batch gives each vault ${String(args[3])} gas, not the configured ${config.gasPerVault}`);
    }
    return;
  }
  if (to === DETERMINISTIC_DEPLOYER) {
    if (config.deployments.some((d) => batcherDeploymentOf(d, config.weth)?.data === data)) return;
    throw new KeeperSignRefused("only a listed batcher's deployment may be sent to the deployer");
  }
  if (config.deployments.some((d) => d.registry !== null && lower(d.registry) === to)) {
    if (!config.prove) throw new KeeperSignRefused("proving is off: SPDEX_KEEPER_PROVE is not 1");
    if (!data.startsWith(PROVE_SELECTOR)) throw new KeeperSignRefused("only prove may be sent to a registry");
    let args: readonly unknown[];
    try {
      args = decodeFunctionData({ abi: REGISTRY_ABI, data }).args ?? [];
    } catch {
      throw new KeeperSignRefused("the proof's calldata does not decode");
    }
    if (lower(String(args[0])) !== rewardToOf(config)) throw new KeeperSignRefused("the proof is for a holder other than the configured rewardTo");
    return;
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
  throw new KeeperSignRefused(`${to} is not a listed batcher or registry, the deployer, WETH or the keeper`);
}

/**
 * The source a release's batcher was built from, which decides its ABI and its
 * code: the listed batcher's own (`batcherSourceOf`: v1's frozen code for v1's,
 * the batcher's entry for each shared one), or, for a batcher spDEX does not
 * list — a test's, or a fork's — its release's own source. Throws for a release
 * whose source this build has no row for, which only a hand-edited config can
 * name: no batcher code is ever guessed for it.
 */
export function batcherSourceOfDeployment(d: Pick<Deployment, "id" | "batcher" | "source">): SourceId {
  const source = batcherSourceOf(lower(d.batcher)) ?? d.source;
  if (!(source in SOURCES)) throw new Error(`deployment ${d.id} names source ${String(source)}, which this keeper has no code for`);
  return source;
}

/**
 * The gas a batch to `d`'s batcher gives each vault: the keeper's `gasPerVault`
 * for a batcher bound to no factory, which takes it as an argument; for v1's,
 * which takes none, the fixed cap it was built with.
 */
export function gasPerVaultOf(config: Pick<KeeperConfig, "gasPerVault">, d: Pick<Deployment, "id" | "batcher" | "source">): bigint {
  const source = SOURCES[batcherSourceOfDeployment(d)];
  if (source.features.sharedBatcher) return config.gasPerVault;
  return (source.batcherLimits as Partial<Record<string, bigint>>)["EXECUTE_GAS_CAP"] ?? config.gasPerVault;
}

/**
 * `executeBatch`'s calldata for `d`'s batcher, in its own source's shape: with
 * `gasPerVault` as a fourth argument for a batcher bound to no factory, without
 * it for v1's.
 */
export function encodeBatchFor(
  d: Pick<Deployment, "id" | "batcher" | "source">,
  vaults: readonly Address[],
  rewardTo: Address,
  minRewards: bigint,
  gasPerVault: bigint,
): Hex {
  const source = SOURCES[batcherSourceOfDeployment(d)];
  return source.features.sharedBatcher
    ? encodeFunctionData({ abi: source.batcherAbi as typeof BATCHER_ABI, functionName: "executeBatch", args: [vaults, rewardTo, minRewards, gasPerVault] })
    : encodeFunctionData({ abi: source.batcherAbi as typeof V1_BATCHER_ABI, functionName: "executeBatch", args: [vaults, rewardTo, minRewards] });
}

/**
 * The deterministic deployer's call that deploys `d`'s batcher from its own
 * code — built for WETH when it is bound to no factory, for its factory when it
 * is v1's — and where it lands; null when that code does not land at
 * `d.batcher`, which would put a batcher where no release lists one. Lowercase.
 */
export function batcherDeploymentOf(
  d: Pick<Deployment, "id" | "batcher" | "factory" | "source">,
  weth: Address,
): { to: Address; data: Hex; batcher: Address } | null {
  const source = batcherSourceOfDeployment(d);
  const s = SOURCES[source];
  const argument = s.features.sharedBatcher ? lower(weth) : lower(d.factory);
  if (batcherAddress(argument, source) !== lower(d.batcher)) return null;
  return {
    to: DETERMINISTIC_DEPLOYER,
    // The deterministic deployer's whole interface: 32 bytes of salt, then init code.
    data: `0x${s.batcherSalt.slice(2)}${batcherInitCode(argument, source).slice(2)}`.toLowerCase() as Hex,
    batcher: lower(d.batcher),
  };
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
    proveBlock: null,
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
  /** WETH the batch earned: `Batch.earned`. Stray WETH v1's batcher swept is never revenue. */
  earnedWei: bigint;
  /** v1's sweep, beside the rewards; null for a batcher bound to no factory, which holds and moves no WETH. */
  sweptWei: bigint | null;
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
 *
 * A buy from a source with a community window says who it paid and when it
 * fell due; with its terms' window (`clockOf`), whether it was made inside it.
 */
export function decodeBatchReceipt(input: {
  receipt: RpcReceipt;
  batcher: Address;
  vaults: readonly Address[];
  clockOf: (vault: Address) => { startAt: bigint; interval: bigint; communityWindow?: bigint | null } | null;
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
    return { ...base, status: "reverted", earnedWei: 0n, sweptWei: null, netWei: -costWei, listed: BigInt(input.vaults.length), tried: 0n, bought: [], refused: [], notTried: [] };
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
      const communityWindow = clock?.communityWindow ?? null;
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
        rewardTo: b.rewardTo,
        dueSince: b.dueSince,
        inCommunityWindow: b.dueSince === null || communityWindow === null ? null : input.blockTime < b.dueSince + communityWindow,
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
    // A batcher bound to no factory has no sweep at all: its 0 is structural, so it is "none", not a figure of 0.
    sweptWei: batch === null || SOURCES[batch.source].features.sharedBatcher ? null : batch.swept,
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
