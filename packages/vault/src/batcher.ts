/**
 * The batcher, from TypeScript: deploy it, encode a batch, and read back what
 * a batch did or would do.
 *
 * `SpdexVaultBatcher` (contracts/SpdexVaultBatcher.sol) calls `execute` on
 * many vaults in one transaction and passes every reward on to the address its
 * caller names. It has no owner and no fee, and it is bound to one factory,
 * whose vaults alone it triggers. A keeper uses it, and so does the app's
 * "Help run the network": a person's wallet sends one batch of due buys in
 * other people's vaults, privately, with every buy fee to that wallet, after
 * the Guard's batch path (`VaultGuard`, packages/guard/src/vault.ts) has
 * checked it at the exact gas it is signed with. The app also reads the
 * registry's batcher addresses to label a buy in a vault's history
 * "triggered in a batch".
 *
 * What a batch did comes back in two shapes. A simulation (`eth_call`) either
 * returns — `decodeExecuteBatchResult` — or reverts `NothingBought` or
 * `TooLittle` with one reason per vault — `decodeBatchRevert`. A mined batch
 * says it in logs: one `Triggered` or `NotTriggered` per vault attempted, each
 * `Triggered` right after that vault's own `Bought`, and one `Batch` —
 * `decodeBatcherEvent`, joined to `decodeVaultEvent`'s by log index in
 * `joinBatchLogs`, the one place that join is written: the keeper reads its
 * receipts with it, and the report the chain's history.
 */

import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, keccak256, toBytes } from "viem";
import type { Address, Hex } from "@spdex/core";
import { BATCHER_ABI, BATCHER_SALT, DETERMINISTIC_DEPLOYER, VAULT_ABI, batcherAddress, batcherInitCode } from "./artifacts.js";
// index.ts re-exports this file; decodeVaultEvent is only ever called, never used while the modules load.
import { decodeVaultEvent, type RawLog, type VaultEvent } from "./index.js";

/**
 * The one-time, permissionless deployment of the batcher bound to `factory`,
 * and the address it will land at. Anyone may send it, once the factory
 * exists: the batcher's constructor reads the factory's WETH, and refuses an
 * address with no code. Sent where the batcher already exists, it reverts and
 * changes nothing.
 */
export function deployBatcherCall(factory: Address): { to: Address; data: Hex; value: 0n; batcher: Address } {
  return {
    to: DETERMINISTIC_DEPLOYER,
    // The deterministic deployer's whole interface: 32 bytes of salt, then init code.
    data: `0x${BATCHER_SALT.slice(2)}${batcherInitCode(factory).slice(2)}` as Hex,
    value: 0n,
    batcher: batcherAddress(factory),
  };
}

/**
 * `executeBatch`'s calldata: trigger `vaults` in this order, send every reward
 * to `rewardTo`, and revert unless the rewards come to at least `minRewards`
 * (0 accepts any).
 */
export function encodeExecuteBatch(vaults: readonly Address[], rewardTo: Address, minRewards: bigint): Hex {
  return encodeFunctionData({ abi: BATCHER_ABI, functionName: "executeBatch", args: [vaults, rewardTo, minRewards] });
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
 * Every refusal a keeper will see from a batch, by selector: the vault's own
 * errors, the batcher's reason codes and errors, and the two Solidity raises.
 * The vault's and the batcher's `Reentrancy` share a selector and a name.
 */
const REASON_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ...[...VAULT_ABI, ...BATCHER_ABI].flatMap((item) =>
    item.type === "error" ? [[keccak256(toBytes(signatureOf(item))).slice(0, 10), item.name] as const] : [],
  ),
  ["0x08c379a0", "Error"],
  ["0x4e487b71", "Panic"],
]);

/**
 * A reason code's name: "TooSoon", "PriceBelowFloor", "NotFromFactory",
 * "EmptyRevert", "EmptyReturn", "NotTried", "Error", "Panic" and the rest; null
 * for a selector this package does not know, which says nothing about why.
 */
export function reasonName(code: ReasonCode): string | null {
  return REASON_NAMES.get(code.toLowerCase()) ?? null;
}

/** One of the batcher's logs, decoded. `emitter` is the batcher that wrote it. */
export type BatcherEvent =
  | {
      name: "Batch";
      emitter: Address;
      logIndex: number;
      caller: Address;
      rewardTo: Address;
      listed: bigint;
      tried: bigint;
      bought: bigint;
      earned: bigint;
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

export const BATCHER_EVENT_TOPICS: { Batch: Hex; Triggered: Hex; NotTriggered: Hex } = {
  Batch: encodeEventTopics({ abi: BATCHER_ABI, eventName: "Batch" })[0] as Hex,
  Triggered: encodeEventTopics({ abi: BATCHER_ABI, eventName: "Triggered" })[0] as Hex,
  NotTriggered: encodeEventTopics({ abi: BATCHER_ABI, eventName: "NotTriggered" })[0] as Hex,
};

const BATCHER_EVENTS_ABI = BATCHER_ABI.filter((item) => item.type === "event");

/**
 * A log `batcher` wrote, decoded; null for any log another contract wrote
 * (compared case-insensitively) or that is not one of its events. Anyone can
 * emit a log shaped like `Batch`, so only the batcher's own say what a batch
 * did, as `vaultsCreatedBy` does for the factory.
 *
 * A batcher's logs are read to be joined with the vaults' by log index, so one
 * without its `logIndex` — which every receipt and log query carries — is a
 * mistake to surface, and throws.
 */
export function decodeBatcherEvent(batcher: Address, log: RawLog): BatcherEvent | null {
  const emitter = lower(log.address);
  if (emitter !== lower(batcher)) return null;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: BATCHER_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
  } catch {
    return null;
  }
  const logIndex = logIndexOf(log);
  switch (decoded.eventName) {
    case "Batch": {
      const { caller, rewardTo, listed, tried, bought, earned, swept } = decoded.args;
      return { name: "Batch", emitter, logIndex, caller: lower(caller), rewardTo: lower(rewardTo), listed, tried, bought, earned, swept };
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
 * counts: anyone can emit a log shaped like either.
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
