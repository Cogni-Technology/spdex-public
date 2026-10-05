/**
 * The batcher, from TypeScript: deploy it, encode a batch, and read back what
 * a batch did or would do.
 *
 * `SpdexVaultBatcher` (contracts/SpdexVaultBatcher.sol) calls `execute` on
 * many vaults in one transaction. It has no owner and no fee. From v2 on it is
 * bound to no factory: it calls each vault's `execute(rewardTo)` with the
 * `rewardTo` its own caller names, so each vault pays that address directly
 * and no WETH passes through the batcher at all — which is also what lets a
 * vault check, inside its community window, the address really paid — and it
 * measures what that address earned instead of trusting any vault's answer.
 * So one batcher serves every release whose vaults take `rewardTo`
 * (`BATCHERS`; `MAINNET_BATCHER` is the newest), and a batch may mix them. Its
 * caller gives each vault's `execute` its gas (`gasPerVault`, at least
 * `MIN_EXECUTE_GAS`). v1's (still on mainnet, still serving v1's vaults) is
 * bound to v1's factory, calls `execute()`, is paid itself, and forwards every
 * reward to `rewardTo` in the same transaction, sweeping any stray WETH with
 * it; it takes no gas argument. A keeper uses them, and so does the app's
 * "Help run the network": a person's wallet sends one batch of due buys in
 * other people's vaults, privately, with every buy fee to that wallet, after
 * the Guard's batch path (`VaultGuard`, packages/guard/src/vault.ts) has
 * checked it at the exact gas it is signed with. The app also reads the
 * batchers' addresses to label a buy in a vault's history "triggered in a
 * batch".
 *
 * Every batcher has the same answers and the same refusals, so one decoder
 * serves them all; the encoder goes by the batcher's source. What a batch did
 * comes back in two shapes. A simulation (`eth_call`) either returns —
 * `decodeExecuteBatchResult` — or reverts `NothingBought` or `TooLittle` with
 * one reason per vault — `decodeBatchRevert`. A mined batch says it in logs:
 * one `Triggered` or `NotTriggered` per vault attempted, each `Triggered`
 * right after that vault's own `Bought`, and one `Batch` — `decodeBatcherEvent`,
 * joined to `decodeVaultEvent`'s by log index in `joinBatchLogs`, the one
 * place that join is written: the keeper reads its receipts with it, and the
 * report the chain's history.
 */

import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, keccak256, toBytes } from "viem";
import type { Address, Hex } from "@spdex/core";
import {
  BATCHER_ABI,
  BATCHER_LIMITS,
  CURRENT_SOURCE,
  DEPLOYMENTS,
  DETERMINISTIC_DEPLOYER,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  SOURCES,
  V1_BATCHER_ABI,
  batcherAddress,
  batcherInitCode,
  type SourceId,
} from "./artifacts.js";
import { SOURCE_IDS_NEWEST_FIRST, batcherSourceOf } from "./releases.js";
// index.ts re-exports this file; decodeVaultEvent is only ever called, never used while the modules load.
import { decodeVaultEvent, type RawLog, type VaultEvent } from "./index.js";

/**
 * The one-time, permissionless deployment of a listed batcher, and the address
 * it lands at (`batcher`, by default the newest, `MAINNET_BATCHER`), from its
 * own source: one bound to no factory is built for WETH, and needs nothing
 * deployed before it; v1's is built for v1's factory, whose code its
 * constructor checks. Anyone may send it. Sent where the batcher already
 * exists, it reverts and changes nothing. Throws for a batcher spDEX does not
 * list.
 */
export function deployBatcherCall(batcher: Address = MAINNET_BATCHER): { to: Address; data: Hex; value: 0n; batcher: Address } {
  const at = lower(batcher);
  const source = batcherSourceOf(at);
  if (source === null) throw new RangeError(`${at} is not a batcher spDEX lists`);
  const s = SOURCES[source];
  const argument = s.features.sharedBatcher
    ? lower(MAINNET_DEPLOYMENT.weth)
    : (DEPLOYMENTS.find((d) => d.batcher === at)?.factory as Address);
  const initCode = batcherInitCode(argument, source);
  if (batcherAddress(argument, source) !== at) throw new RangeError(`${at} is not where source ${source} puts a batcher`);
  return {
    to: DETERMINISTIC_DEPLOYER,
    // The deterministic deployer's whole interface: 32 bytes of salt, then init code.
    data: `0x${s.batcherSalt.slice(2)}${initCode.slice(2)}` as Hex,
    value: 0n,
    batcher: at,
  };
}

/**
 * `executeBatch`'s calldata for `batcher` (by default the newest): trigger
 * `vaults` in this order, have every reward paid to `rewardTo`, and revert
 * unless the rewards come to at least `minRewards` (0 accepts any). A batcher
 * from v2 on also takes the gas each vault's `execute` is given: `gasPerVault`,
 * by default its least, `MIN_EXECUTE_GAS` (`MAX_EXECUTE_GAS_LIMIT` in
 * index.ts). v1's takes none, and gives each vault a fixed 400,000.
 */
export function encodeExecuteBatch(
  vaults: readonly Address[],
  rewardTo: Address,
  minRewards: bigint,
  options: { batcher?: Address; gasPerVault?: bigint } = {},
): Hex {
  const source = batcherSourceOf(options.batcher ?? MAINNET_BATCHER) ?? CURRENT_SOURCE;
  if (!SOURCES[source].features.sharedBatcher) {
    return encodeFunctionData({ abi: V1_BATCHER_ABI, functionName: "executeBatch", args: [vaults, rewardTo, minRewards] });
  }
  const gas = options.gasPerVault ?? BATCHER_LIMITS.MIN_EXECUTE_GAS;
  return encodeFunctionData({ abi: BATCHER_ABI, functionName: "executeBatch", args: [vaults, rewardTo, minRewards, gas] });
}

/** bytes4 hex, lowercase; "0x00000000" means bought. */
export type ReasonCode = Hex;

/** What one vault in a batch did. */
export interface BatchOutcome {
  vault: Address;
  bought: boolean;
  /** Why it did not buy; null when it bought. */
  reason: ReasonCode | null;
  /** The reason's name, when it is one this package knows (`reasonName`). */
  reasonName: string | null;
}

/** What a batch would do, from a simulation of it. */
export interface BatchSimulation {
  /** It would go through; or it would revert because nothing, or too little, was bought. */
  kind: "ok" | "NothingBought" | "TooLittle";
  bought: bigint;
  /** The WETH the vaults would pay; null for `NothingBought`, which reports none. */
  earned: bigint | null;
  /** The caller's minimum that `TooLittle` refused; null otherwise. */
  minRewards: bigint | null;
  /** Aligned with the vaults passed in. */
  outcomes: readonly BatchOutcome[];
}

const BOUGHT: ReasonCode = "0x00000000";

/**
 * A simulated batch that went through: `eth_call`'s answer. Throws when the
 * answer does not decode, or does not have one reason per vault in `vaults`:
 * then it is not an answer about this list.
 */
export function decodeExecuteBatchResult(vaults: readonly Address[], data: Hex): BatchSimulation {
  const [bought, earned, reasons] = decodeFunctionResult({ abi: BATCHER_ABI, functionName: "executeBatch", data });
  const outcomes = outcomesOf(vaults, reasons);
  if (outcomes === null) throw new RangeError(`the batch answered ${reasons.length} reasons for ${vaults.length} vaults`);
  return { kind: "ok", bought, earned, minRewards: null, outcomes };
}

/**
 * A simulated batch that reverted because nothing bought (`NothingBought`) or
 * the rewards fell short of the caller's minimum (`TooLittle`), with each
 * vault's reason. Null for any other revert — a bad `rewardTo`, too many
 * vaults, reentrancy, or data this batcher never returns — and for reasons
 * that do not line up with `vaults`.
 */
export function decodeBatchRevert(vaults: readonly Address[], revertData: Hex): BatchSimulation | null {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: BATCHER_ABI, data: revertData });
  } catch {
    return null;
  }
  if (decoded.errorName === "NothingBought") {
    const [reasons] = decoded.args;
    const outcomes = outcomesOf(vaults, reasons);
    return outcomes === null ? null : { kind: "NothingBought", bought: 0n, earned: null, minRewards: null, outcomes };
  }
  if (decoded.errorName === "TooLittle") {
    const [earned, minRewards, reasons] = decoded.args;
    const outcomes = outcomesOf(vaults, reasons);
    if (outcomes === null) return null;
    const bought = BigInt(outcomes.filter((outcome) => outcome.bought).length);
    return { kind: "TooLittle", bought, earned, minRewards, outcomes };
  }
  return null;
}

function outcomesOf(vaults: readonly Address[], reasons: readonly Hex[]): BatchOutcome[] | null {
  if (reasons.length !== vaults.length) return null;
  return vaults.map((vault, i) => {
    const code = reasons[i]!.toLowerCase() as ReasonCode;
    const bought = code === BOUGHT;
    return {
      vault: lower(vault),
      bought,
      reason: bought ? null : code,
      reasonName: bought ? null : reasonName(code),
    };
  });
}

/** A Solidity error's signature, as its selector is computed: tuples spelled out as their components. */
function signatureOf(item: { name: string; inputs: readonly AbiParameter[] }): string {
  return `${item.name}(${item.inputs.map(typeOf).join(",")})`;
}
type AbiParameter = { type: string; components?: readonly AbiParameter[] };
const typeOf = (parameter: AbiParameter): string =>
  parameter.type.startsWith("tuple")
    ? `(${(parameter.components ?? []).map(typeOf).join(",")})${parameter.type.slice("tuple".length)}`
    : parameter.type;

/**
 * Every refusal a keeper will see from a batch, by selector: every source's
 * vault errors (v2's `NotEligible`, `NotYourTurn` and `BadRewardTo` among
 * them), every batcher's reason codes and errors (v1's `NotFromFactory` and
 * `RewardTransferFailed` too), the SPX holder registry's, and the two Solidity
 * raises. The vault's and the batcher's `Reentrancy` share a selector and a
 * name, and so do errors of the same name in different sources.
 */
const REASON_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ...SOURCE_IDS_NEWEST_FIRST.flatMap((id) => {
    const { vaultAbi, batcherAbi, registryAbi } = SOURCES[id];
    return [...vaultAbi, ...batcherAbi, ...(registryAbi ?? [])] as readonly { type: string; name?: string; inputs?: readonly AbiParameter[] }[];
  }).flatMap((item) =>
    item.type === "error" ? [[keccak256(toBytes(signatureOf(item as { name: string; inputs: readonly AbiParameter[] }))).slice(0, 10), item.name!] as const] : [],
  ),
  ["0x08c379a0", "Error"],
  ["0x4e487b71", "Panic"],
]);

/**
 * A reason code's name: "TooSoon", "PriceBelowFloor", "NotEligible",
 * "NotYourTurn", "NotFromFactory" (v1's batcher), "EmptyRevert", "EmptyReturn",
 * "NotTried", "Error", "Panic" and the rest; null for a selector this package
 * does not know, which says nothing about why.
 */
export function reasonName(code: ReasonCode): string | null {
  return REASON_NAMES.get(code.toLowerCase()) ?? null;
}

/** One of the batcher's logs, decoded. `emitter` is the batcher that wrote it. */
export type BatcherEvent =
  | {
      name: "Batch";
      emitter: Address;
      /** Which source's batcher `Batch` is laid out as: v1's carries `swept`. */
      source: SourceId;
      logIndex: number;
      caller: Address;
      rewardTo: Address;
      listed: bigint;
      tried: bigint;
      bought: bigint;
      earned: bigint;
      /**
       * Stray WETH v1's batcher swept to `rewardTo` beside the rewards. Always 0
       * from v2 on, and not as an unknown: its vaults pay `rewardTo` directly and
       * it has no way to move WETH at all, so there is nothing it could sweep.
       */
      swept: bigint;
    }
  | { name: "Triggered"; emitter: Address; logIndex: number; vault: Address; received: bigint; gasUsed: bigint }
  | {
      name: "NotTriggered";
      emitter: Address;
      logIndex: number;
      vault: Address;
      reason: ReasonCode;
      reasonName: string | null;
      gasUsed: bigint;
    };

const batcherTopic = (abi: readonly unknown[], eventName: string): Hex => encodeEventTopics({ abi: abi as never, eventName } as never)[0] as Hex;

/**
 * Each source's batcher events by topic, so nothing that filters logs copies
 * one by hand. `Batch` differs (v1's carries `swept`); `Triggered` and
 * `NotTriggered` are the same in every one.
 */
export const BATCHER_EVENT_TOPICS = Object.fromEntries(
  SOURCE_IDS_NEWEST_FIRST.map((id) => {
    const abi = SOURCES[id].batcherAbi;
    return [id, { Batch: batcherTopic(abi, "Batch"), Triggered: batcherTopic(abi, "Triggered"), NotTriggered: batcherTopic(abi, "NotTriggered") }];
  }),
) as Record<SourceId, { Batch: Hex; Triggered: Hex; NotTriggered: Hex }>;

/** Any source's batcher ABI items; a new source's batcher ABI joins this union. */
type AnyBatcherAbi = readonly ((typeof BATCHER_ABI)[number] | (typeof V1_BATCHER_ABI)[number])[];
const BATCHER_EVENTS_ABI = Object.fromEntries(
  SOURCE_IDS_NEWEST_FIRST.map((id) => [id, (SOURCES[id].batcherAbi as AnyBatcherAbi).filter((item) => item.type === "event")]),
) as unknown as Record<SourceId, AnyBatcherAbi>;

/**
 * A log `batcher` wrote, decoded, for any source's batcher; null for any
 * log another contract wrote (compared case-insensitively) or that is not one
 * of its events. Anyone can emit a log shaped like `Batch`, so only the
 * batcher's own say what a batch did, as `vaultsCreatedBy` does for the
 * factory.
 *
 * A batcher's logs are read to be joined with the vaults' by log index, so one
 * without its `logIndex` — which every receipt and log query carries — is a
 * mistake to surface, and throws.
 */
export function decodeBatcherEvent(batcher: Address, log: RawLog): BatcherEvent | null {
  const emitter = lower(log.address);
  if (emitter !== lower(batcher)) return null;
  for (const source of SOURCE_IDS_NEWEST_FIRST) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: BATCHER_EVENTS_ABI[source], topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
    } catch {
      continue;
    }
    const logIndex = logIndexOf(log);
    switch (decoded.eventName) {
      case "Batch": {
        const { caller, rewardTo, listed, tried, bought, earned } = decoded.args;
        const swept = "swept" in decoded.args ? decoded.args.swept : 0n;
        return { name: "Batch", emitter, source, logIndex, caller: lower(caller), rewardTo: lower(rewardTo), listed, tried, bought, earned, swept };
      }
      case "Triggered": {
        const { vault, received, gasUsed } = decoded.args;
        return { name: "Triggered", emitter, logIndex, vault: lower(vault), received, gasUsed };
      }
      case "NotTriggered": {
        const { vault, reason, gasUsed } = decoded.args;
        const code = reason.toLowerCase() as ReasonCode;
        return { name: "NotTriggered", emitter, logIndex, vault: lower(vault), reason: code, reasonName: reasonName(code), gasUsed };
      }
      default:
        return null;
    }
  }
  return null;
}

/** One `executeBatch` as its logs tell it: each vault it tried, in order, and the `Batch` that closed the run. */
export interface BatchRun {
  batcher: Address;
  /** Null when the logs end before the batcher's `Batch` does. */
  batch: Extract<BatcherEvent, { name: "Batch" }> | null;
  /** Each `Triggered`, with the `Bought` its vault logged right before it; null when that log is not the vault's own `Bought`. */
  triggered: { event: Extract<BatcherEvent, { name: "Triggered" }>; bought: Extract<VaultEvent, { name: "Bought" }> | null }[];
  notTriggered: Extract<BatcherEvent, { name: "NotTriggered" }>[];
}

/**
 * One transaction's logs, in the order the chain wrote them, as the batches
 * they record: per batcher `isBatcher` accepts, a run of attempts closed by
 * each `Batch`. A `Triggered` is joined to the log right before it by log
 * index, and only a `Bought` emitted by the vault the `Triggered` names
 * counts: anyone can emit a log shaped like either. From v2 on the vault's
 * `Bought` names the batcher as `keeper` and the batch's `rewardTo` as its
 * `rewardTo`; in a v1 batch, the batcher as both. A batcher bound to no factory
 * calls whatever its caller lists, so a `Triggered` says only that something
 * answered like a buy: a reader counts a buy from a vault a listed factory
 * vouches for, never from the `Triggered` alone.
 */
export function joinBatchLogs(logs: readonly RawLog[], isBatcher: (address: Address) => boolean): BatchRun[] {
  const byIndex = new Map(logs.flatMap((log) => (log.logIndex === undefined ? [] : [[Number(BigInt(log.logIndex)), log] as const])));
  const runs: BatchRun[] = [];
  const open = new Map<Address, BatchRun>();
  for (const log of logs) {
    const emitter = lower(log.address);
    const event = isBatcher(emitter) ? decodeBatcherEvent(emitter, log) : null;
    if (event === null) continue;
    let run = open.get(emitter);
    if (!run) {
      run = { batcher: emitter, batch: null, triggered: [], notTriggered: [] };
      open.set(emitter, run);
      runs.push(run);
    }
    if (event.name === "Batch") {
      run.batch = event;
      open.delete(emitter);
    } else if (event.name === "NotTriggered") {
      run.notTriggered.push(event);
    } else {
      const before = byIndex.get(event.logIndex - 1);
      const vaultEvent = before ? decodeVaultEvent(before) : null;
      run.triggered.push({ event, bought: vaultEvent?.name === "Bought" && vaultEvent.emitter === event.vault ? vaultEvent : null });
    }
  }
  return runs;
}

function logIndexOf(log: RawLog): number {
  const raw = log.logIndex;
  const index = typeof raw === "number" ? raw : typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw) ? Number(BigInt(raw)) : null;
  if (index === null || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("a batcher log must carry its logIndex: it is what joins it to the vault's Bought");
  }
  return index;
}

const lower = (a: string): Address => a.toLowerCase() as Address;
