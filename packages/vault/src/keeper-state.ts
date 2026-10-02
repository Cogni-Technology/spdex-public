/**
 * What a keeper remembers between ticks and across restarts, and the file it
 * is kept in.
 *
 * The state is written ahead of every broadcast (`keeper-send.ts`), so a
 * keeper that crashes after sending finds the transaction on restart, signed
 * bytes and all, rather than signing a second one at the next nonce. It names
 * the chain, the keeper and the releases it was written for; a state file
 * that does not match the keeper reading it is refused, naming the field,
 * rather than trusted, because a nonce or a trap from another key or chain is
 * worse than none.
 *
 * JSON, with bigints as decimal strings. Parsing checks every field it reads
 * and names the first one that is wrong. There is only version 1, and a file
 * of any other is refused; the first change of shape brings its migration.
 */

import type { Address, Hex } from "@spdex/core";
import type { PreparedFees } from "@spdex/chain";
import { DEPLOYMENTS, type Deployment } from "./artifacts.js";
import type { VaultTerms } from "./index.js";
import { RATIO_ONE, type SendReason } from "./keeper-plan.js";

export const KEEPER_STATE_VERSION = 1;

export type SkipCode =
  | "not-vouched"
  | "closed"
  | "done"
  | "unfunded"
  | "oracle-unavailable"
  | "oracle-thin"
  | "below-floor"
  | "resting"
  | "trapped"
  | "economics"
  | "public-pair-cap"
  | "zero-reward"
  | "sim-refused";

/** One vault the keeper watches: what its factory's list or the allowlist said, and what it last read. */
export interface VaultEntry {
  /** The `DEPLOYMENTS` id whose factory vouches for it. */
  deployment: string;
  /** Its index in that factory's list; null for an allowlisted vault found some other way. */
  index: bigint | null;
  owner: Address;
  terms: VaultTerms;
  buysDone: bigint;
  /** Chain time of its last buy; 0 before the first. */
  lastBuyAt: bigint;
  closed: boolean;
  /** Its WETH, wei; null until read. */
  balance: bigint | null;
  /** Chain time of the last read; null when nothing has been read yet, so nothing about its progress is known. */
  readAt: bigint | null;
  /** Not tried again before this chain time: it could not pay for its buy. */
  recheckAt: bigint | null;
  /** Not tried again before this chain time: it refused, or failed in a way worth a rest. */
  restingUntil: bigint | null;
  paidRefusals: { slot: bigint; count: number } | null;
  lastSkip: { code: SkipCode; detail: string; since: bigint } | null;
  /** The window the keeper is watching for a buy, so a window that ends without one is noticed. */
  watchedSlot: bigint | null;
}

export interface PendingAttempt {
  kind: "batch" | "cancel" | "unwrap" | "deploy";
  hash: Hex;
  /** The signed transaction: public once broadcast, no key material; it allows an exact resend after a restart. */
  raw: Hex;
  sentBlock: bigint;
  fees: PreparedFees;
  /**
   * What this attempt carried, as its transaction in flight said when it was
   * signed. A rebuild at the same nonce may carry other vaults, and whichever
   * attempt is mined is processed with its own list, subsidy and model.
   */
  vaults: Address[];
  subsidy: Subsidy[];
  modelGas: bigint;
}

/** A planned loss booked to one vault and its owner. */
export interface Subsidy {
  vault: Address;
  owner: Address;
  wei: bigint;
}

/** The one transaction in flight. No other nonce is used while it is. */
export interface PendingTx {
  batchId: string;
  nonce: number;
  purpose: "batch" | "unwrap" | "deploy";
  /** The deployment whose batcher it calls, or deploys; null for an unwrap. */
  deployment: string | null;
  vaults: Address[];
  urgent: boolean;
  reason: SendReason | null;
  gasLimit: bigint;
  modelGas: bigint;
  expectedGas: bigint;
  expectedCostWei: bigint;
  expectedEarnedWei: bigint;
  minRewards: bigint;
  /** The planned loss, per vault and owner: where a realised loss is booked. */
  subsidy: Subsidy[];
  /** For an unwrap, what it unwraps. */
  amountWei: bigint | null;
  resends: number;
  /** A rebuild found nothing worth sending: a private send stops resending and waits to expire. */
  stoppedResending: boolean;
  /** The block a receipt was seen in, before it had its confirmations; null when none has been seen. */
  receiptBlock: bigint | null;
  /** Checks in a row that found no receipt after one was seen: two mean a reorg took it. */
  missedReceiptChecks: number;
  /** The block the nonce was first seen used with no receipt of ours. */
  consumedSeenAt: bigint | null;
  attempts: PendingAttempt[];
}

/** A hash abandoned while it might still land: polled for a while, and processed late if it does. */
export interface Orphan {
  batchId: string;
  nonce: number;
  hash: Hex;
  kind: PendingAttempt["kind"];
  deployment: string | null;
  vaults: Address[];
  subsidy: Subsidy[];
  untilBlock: bigint;
  nextCheckBlock: bigint;
}

export interface KeeperState {
  v: 1;
  chainId: number;
  /** The keeper's address; null for a dry run, which never signs. */
  keeper: Address | null;
  /** By `DEPLOYMENTS` id: how far down its factory's list discovery has read. */
  deployments: Record<string, { factory: Address; batcher: Address; scannedCount: bigint; vaultCount: bigint | null }>;
  /** The last JSONL record's `seq`. */
  seq: number;
  /** The highest block seen: a head below it is stale. */
  maxHeadSeen: bigint | null;
  /** Chain time of the last read of the factories' lists. */
  discoveredAt: bigint | null;
  /** Chain time of the last read of every active vault. */
  accountedAt: bigint | null;
  vaults: Record<Address, VaultEntry>;
  /** Allowlisted addresses no listed factory vouches for, rechecked hourly and never dropped for good. */
  notVouched: Record<Address, { since: bigint; recheckAt: bigint }>;
  /** Vaults whose buy burned its gas on chain: not tried again until the trap expires. */
  trapped: Record<Address, { since: bigint; txHash: Hex; batcher: Address; cap: bigint; slot: bigint }>;
  /** Closed or finished: never read again. */
  retired: Address[];
  /** `[chainTime, baseFee]`, one a tick, for 24 hours. */
  feeSamples: [bigint, bigint][];
  /** Realised losses, for 24 hours, attributed to the vaults and owners whose subsidy was planned. */
  lossLedger: { at: bigint; lossWei: bigint; vault: Address | null; owner: Address | null }[];
  /** `[chainTime, costWei]` of every transaction mined, for 7 days: the runway. */
  spend: [bigint, bigint][];
  /** Gas used against the constants' model, in parts per million: at least `RATIO_ONE`, the constants exactly. */
  gasModel: { ratioPpm: bigint; samples: number };
  nextNonce: number | null;
  /** How many batches each nonce has carried: after an expiry a nonce is reused, and `batchId` says which use. */
  nonceUses: Record<string, number>;
  pending: PendingTx | null;
  orphans: Orphan[];
  lastBatch: { hash: Hex; at: bigint } | null;
  /** The keeper's ether, wei, as last read; null until read. */
  balanceWei: bigint | null;
  lastMissedAt: bigint | null;
  /** The last `wait` said, so the same wait is logged once. */
  lastWait: string | null;
  /** The daily loss breaker is open. */
  breakerOpen: boolean;
  /** A `low_balance` warning has been logged and not yet cleared. */
  lowBalance: boolean;
  /** Wall-clock seconds of the last `heartbeat` record. */
  lastHeartbeatLogAt: bigint | null;
}

export function newKeeperState(input: { chainId: number; keeper: Address | null; deployments?: readonly Deployment[] }): KeeperState {
  const deployments: KeeperState["deployments"] = {};
  for (const d of input.deployments ?? DEPLOYMENTS) {
    deployments[d.id] = { factory: lower(d.factory), batcher: lower(d.batcher), scannedCount: 0n, vaultCount: null };
  }
  return {
    v: 1,
    chainId: input.chainId,
    keeper: input.keeper === null ? null : lower(input.keeper),
    deployments,
    seq: 0,
    maxHeadSeen: null,
    discoveredAt: null,
    accountedAt: null,
    vaults: {},
    notVouched: {},
    trapped: {},
    retired: [],
    feeSamples: [],
    lossLedger: [],
    spend: [],
    gasModel: { ratioPpm: RATIO_ONE, samples: 0 },
    nextNonce: null,
    nonceUses: {},
    pending: null,
    orphans: [],
    lastBatch: null,
    balanceWei: null,
    lastMissedAt: null,
    lastWait: null,
    breakerOpen: false,
    lowBalance: false,
    lastHeartbeatLogAt: null,
  };
}

// ─── Identity ─────────────────────────────────────────────────────────────────

/** A state file that is not this keeper's, or not readable as one. `field` names what is wrong. */
export class KeeperStateError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "KeeperStateError";
  }
}

/**
 * Refuse a state written for another chain, key or release list, naming the
 * field. A release list that has grown is accepted, and the new releases are
 * added: the registry only ever grows. One the state knows and the keeper
 * does not — or knows at another address — is refused, since its vaults would
 * be orphaned or, worse, trusted at the wrong factory.
 */
export function checkKeeperStateIdentity(
  state: KeeperState,
  expected: { chainId: number; keeper: Address | null; deployments: readonly Deployment[] },
): void {
  if (state.chainId !== expected.chainId) {
    throw new KeeperStateError("chainId", `the state is for chain ${state.chainId}, not chain ${expected.chainId}`);
  }
  const keeper = expected.keeper === null ? null : lower(expected.keeper);
  if (state.keeper !== keeper) {
    throw new KeeperStateError("keeper", `the state is for keeper ${state.keeper ?? "(none)"}, not ${keeper ?? "(none)"}`);
  }
  const byId = new Map(expected.deployments.map((d) => [d.id, d]));
  for (const [id, known] of Object.entries(state.deployments)) {
    const d = byId.get(id);
    if (!d) throw new KeeperStateError(`deployments.${id}`, `the state knows release ${id}, which this keeper does not`);
    if (lower(d.factory) !== known.factory || lower(d.batcher) !== known.batcher) {
      throw new KeeperStateError(`deployments.${id}`, `the state has release ${id} at other addresses than this keeper`);
    }
  }
  for (const d of expected.deployments) {
    state.deployments[d.id] ??= { factory: lower(d.factory), batcher: lower(d.batcher), scannedCount: 0n, vaultCount: null };
  }
}

// ─── Operator overrides ───────────────────────────────────────────────────────

/** `--reset-trapped`: clear every trap. Returns the vaults that were trapped. */
export function resetTraps(state: KeeperState): Address[] {
  const vaults = Object.keys(state.trapped) as Address[];
  state.trapped = {};
  return vaults;
}

/**
 * `--forget 0x…`: forget what the keeper learned about one vault — its reads,
 * rests, trap and skips — so the next tick treats it as new. A listed vault
 * keeps its place in its factory's list (discovery will not pass it again), so
 * only its progress is forgotten; an allowlisted one is dropped and found anew.
 */
export function forgetVault(state: KeeperState, vault: Address): boolean {
  const v = lower(vault);
  let known = false;
  const entry = state.vaults[v];
  if (entry) {
    known = true;
    if (entry.index === null) delete state.vaults[v];
    else {
      Object.assign(entry, { balance: null, readAt: null, recheckAt: null, restingUntil: null, paidRefusals: null, lastSkip: null, watchedSlot: null });
    }
  }
  for (const map of [state.trapped, state.notVouched]) {
    if (map[v]) {
      known = true;
      delete map[v];
    }
  }
  if (state.retired.includes(v)) {
    known = true;
    state.retired = state.retired.filter((r) => r !== v);
  }
  return known;
}

// ─── The file ─────────────────────────────────────────────────────────────────

/** The state as its file holds it: JSON, bigints as decimal strings. */
export function serializeKeeperState(state: KeeperState): string {
  return JSON.stringify(state, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2);
}

/** A state file's contents, checked field by field; throws `KeeperStateError` naming the first that is wrong. */
export function parseKeeperState(text: string): KeeperState {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new KeeperStateError("(root)", "the state is not valid JSON");
  }
  const o = obj(json, "(root)");
  const v = o["v"];
  if (v !== KEEPER_STATE_VERSION) {
    const newer = typeof v === "number" && v > KEEPER_STATE_VERSION;
    throw new KeeperStateError("v", newer ? `the state is version ${v}, newer than this keeper's ${KEEPER_STATE_VERSION}` : "the state has no version this keeper knows");
  }
  return {
    v: 1,
    chainId: int(o["chainId"], "chainId"),
    keeper: nullable(o["keeper"], "keeper", address),
    deployments: record(o["deployments"], "deployments", (d, path) => {
      const e = obj(d, path);
      return {
        factory: address(e["factory"], `${path}.factory`),
        batcher: address(e["batcher"], `${path}.batcher`),
        scannedCount: big(e["scannedCount"], `${path}.scannedCount`),
        vaultCount: nullable(e["vaultCount"], `${path}.vaultCount`, big),
      };
    }),
    seq: int(o["seq"], "seq"),
    maxHeadSeen: nullable(o["maxHeadSeen"], "maxHeadSeen", big),
    discoveredAt: nullable(o["discoveredAt"], "discoveredAt", big),
    accountedAt: nullable(o["accountedAt"], "accountedAt", big),
    vaults: record(o["vaults"], "vaults", vaultEntry, address),
    notVouched: record(
      o["notVouched"],
      "notVouched",
      (n, path) => ({ since: big(obj(n, path)["since"], `${path}.since`), recheckAt: big(obj(n, path)["recheckAt"], `${path}.recheckAt`) }),
      address,
    ),
    trapped: record(
      o["trapped"],
      "trapped",
      (t, path) => {
        const e = obj(t, path);
        return {
          since: big(e["since"], `${path}.since`),
          txHash: hash(e["txHash"], `${path}.txHash`),
          batcher: address(e["batcher"], `${path}.batcher`),
          cap: big(e["cap"], `${path}.cap`),
          slot: big(e["slot"], `${path}.slot`),
        };
      },
      address,
    ),
    retired: list(o["retired"], "retired", address),
    feeSamples: list(o["feeSamples"], "feeSamples", pair),
    lossLedger: list(o["lossLedger"], "lossLedger", (l, path) => {
      const e = obj(l, path);
      return {
        at: big(e["at"], `${path}.at`),
        lossWei: big(e["lossWei"], `${path}.lossWei`),
        vault: nullable(e["vault"], `${path}.vault`, address),
        owner: nullable(e["owner"], `${path}.owner`, address),
      };
    }),
    spend: list(o["spend"], "spend", pair),
    gasModel: {
      ratioPpm: big(obj(o["gasModel"], "gasModel")["ratioPpm"], "gasModel.ratioPpm"),
      samples: int(obj(o["gasModel"], "gasModel")["samples"], "gasModel.samples"),
    },
    nextNonce: nullable(o["nextNonce"], "nextNonce", int),
    nonceUses: record(o["nonceUses"], "nonceUses", int),
    pending: nullable(o["pending"], "pending", pendingTx),
    orphans: list(o["orphans"], "orphans", (x, path) => {
      const e = obj(x, path);
      return {
        batchId: str(e["batchId"], `${path}.batchId`),
        nonce: int(e["nonce"], `${path}.nonce`),
        hash: hash(e["hash"], `${path}.hash`),
        kind: oneOf(e["kind"], `${path}.kind`, ["batch", "cancel", "unwrap", "deploy"] as const),
        deployment: nullable(e["deployment"], `${path}.deployment`, str),
        vaults: list(e["vaults"], `${path}.vaults`, address),
        subsidy: list(e["subsidy"], `${path}.subsidy`, subsidy),
        untilBlock: big(e["untilBlock"], `${path}.untilBlock`),
        nextCheckBlock: big(e["nextCheckBlock"], `${path}.nextCheckBlock`),
      };
    }),
    lastBatch: nullable(o["lastBatch"], "lastBatch", (b, path) => ({
      hash: hash(obj(b, path)["hash"], `${path}.hash`),
      at: big(obj(b, path)["at"], `${path}.at`),
    })),
    balanceWei: nullable(o["balanceWei"], "balanceWei", big),
    lastMissedAt: nullable(o["lastMissedAt"], "lastMissedAt", big),
    lastWait: nullable(o["lastWait"], "lastWait", str),
    breakerOpen: bool(o["breakerOpen"], "breakerOpen"),
    lowBalance: bool(o["lowBalance"], "lowBalance"),
    lastHeartbeatLogAt: nullable(o["lastHeartbeatLogAt"], "lastHeartbeatLogAt", big),
  };
}

function vaultEntry(value: unknown, path: string): VaultEntry {
  const e = obj(value, path);
  const t = obj(e["terms"], `${path}.terms`);
  const term = (name: keyof VaultTerms) => big(t[name], `${path}.terms.${name}`);
  const skip = nullable(e["lastSkip"], `${path}.lastSkip`, (s, p) => {
    const x = obj(s, p);
    return { code: str(x["code"], `${p}.code`) as SkipCode, detail: str(x["detail"], `${p}.detail`), since: big(x["since"], `${p}.since`) };
  });
  return {
    deployment: str(e["deployment"], `${path}.deployment`),
    index: nullable(e["index"], `${path}.index`, big),
    owner: address(e["owner"], `${path}.owner`),
    terms: {
      tokenOut: address(t["tokenOut"], `${path}.terms.tokenOut`),
      pair: address(t["pair"], `${path}.terms.pair`),
      oraclePool: address(t["oraclePool"], `${path}.terms.oraclePool`),
      amountPerBuy: term("amountPerBuy"),
      interval: term("interval"),
      maxBuys: term("maxBuys"),
      startAt: term("startAt"),
      keeperReward: term("keeperReward"),
      maxSlippageBps: term("maxSlippageBps"),
    },
    buysDone: big(e["buysDone"], `${path}.buysDone`),
    lastBuyAt: big(e["lastBuyAt"], `${path}.lastBuyAt`),
    closed: bool(e["closed"], `${path}.closed`),
    balance: nullable(e["balance"], `${path}.balance`, big),
    readAt: nullable(e["readAt"], `${path}.readAt`, big),
    recheckAt: nullable(e["recheckAt"], `${path}.recheckAt`, big),
    restingUntil: nullable(e["restingUntil"], `${path}.restingUntil`, big),
    paidRefusals: nullable(e["paidRefusals"], `${path}.paidRefusals`, (r, p) => ({
      slot: big(obj(r, p)["slot"], `${p}.slot`),
      count: int(obj(r, p)["count"], `${p}.count`),
    })),
    lastSkip: skip,
    watchedSlot: nullable(e["watchedSlot"], `${path}.watchedSlot`, big),
  };
}

function pendingTx(value: unknown, path: string): PendingTx {
  const e = obj(value, path);
  const n = (name: string) => big(e[name], `${path}.${name}`);
  return {
    batchId: str(e["batchId"], `${path}.batchId`),
    nonce: int(e["nonce"], `${path}.nonce`),
    purpose: oneOf(e["purpose"], `${path}.purpose`, ["batch", "unwrap", "deploy"] as const),
    deployment: nullable(e["deployment"], `${path}.deployment`, str),
    vaults: list(e["vaults"], `${path}.vaults`, address),
    urgent: bool(e["urgent"], `${path}.urgent`),
    reason: nullable(e["reason"], `${path}.reason`, (r, p) => oneOf(r, p, ["cheap", "deadline", "short-interval", "now"] as const)),
    gasLimit: n("gasLimit"),
    modelGas: n("modelGas"),
    expectedGas: n("expectedGas"),
    expectedCostWei: n("expectedCostWei"),
    expectedEarnedWei: n("expectedEarnedWei"),
    minRewards: n("minRewards"),
    subsidy: list(e["subsidy"], `${path}.subsidy`, subsidy),
    amountWei: nullable(e["amountWei"], `${path}.amountWei`, big),
    resends: int(e["resends"], `${path}.resends`),
    stoppedResending: bool(e["stoppedResending"], `${path}.stoppedResending`),
    receiptBlock: nullable(e["receiptBlock"], `${path}.receiptBlock`, big),
    missedReceiptChecks: int(e["missedReceiptChecks"], `${path}.missedReceiptChecks`),
    consumedSeenAt: nullable(e["consumedSeenAt"], `${path}.consumedSeenAt`, big),
    attempts: list(e["attempts"], `${path}.attempts`, (a, p) => {
      const x = obj(a, p);
      const f = obj(x["fees"], `${p}.fees`);
      const fees: PreparedFees =
        f["type"] === "legacy"
          ? { type: "legacy", gasPrice: big(f["gasPrice"], `${p}.fees.gasPrice`) }
          : {
              type: oneOf(f["type"], `${p}.fees.type`, ["eip1559"] as const),
              maxFeePerGas: big(f["maxFeePerGas"], `${p}.fees.maxFeePerGas`),
              maxPriorityFeePerGas: big(f["maxPriorityFeePerGas"], `${p}.fees.maxPriorityFeePerGas`),
            };
      return {
        kind: oneOf(x["kind"], `${p}.kind`, ["batch", "cancel", "unwrap", "deploy"] as const),
        hash: hash(x["hash"], `${p}.hash`),
        raw: hexBytes(x["raw"], `${p}.raw`),
        sentBlock: big(x["sentBlock"], `${p}.sentBlock`),
        fees,
        vaults: list(x["vaults"], `${p}.vaults`, address),
        subsidy: list(x["subsidy"], `${p}.subsidy`, subsidy),
        modelGas: big(x["modelGas"], `${p}.modelGas`),
      };
    }),
  };
}

function subsidy(value: unknown, path: string): Subsidy {
  const s = obj(value, path);
  return { vault: address(s["vault"], `${path}.vault`), owner: address(s["owner"], `${path}.owner`), wei: big(s["wei"], `${path}.wei`) };
}

// ─── Field readers: each names its field when it refuses ──────────────────────

const bad = (path: string, what: string): never => {
  throw new KeeperStateError(path, `the state's ${path} is not ${what}`);
};

function obj(value: unknown, path: string): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : bad(path, "an object");
}
function str(value: unknown, path: string): string {
  return typeof value === "string" ? value : bad(path, "a string");
}
function bool(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : bad(path, "true or false");
}
function int(value: unknown, path: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : bad(path, "a whole number");
}
function big(value: unknown, path: string): bigint {
  return typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : bad(path, "a decimal integer");
}
function address(value: unknown, path: string): Address {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) ? (value as Address) : bad(path, "a lowercase address");
}
function hash(value: unknown, path: string): Hex {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) ? (value as Hex) : bad(path, "a transaction hash");
}
function hexBytes(value: unknown, path: string): Hex {
  return typeof value === "string" && /^0x([0-9a-f]{2})+$/.test(value) ? (value as Hex) : bad(path, "hex bytes");
}
function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : bad(path, `one of ${options.join(", ")}`);
}
function nullable<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): T | null {
  return value === null || value === undefined ? null : read(value, path);
}
function list<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): T[] {
  return Array.isArray(value) ? value.map((item, i) => read(item, `${path}[${i}]`)) : bad(path, "a list");
}
function record<K extends string, T>(
  value: unknown,
  path: string,
  read: (value: unknown, path: string) => T,
  key: (value: unknown, path: string) => K = (k) => k as K,
): Record<K, T> {
  const out = {} as Record<K, T>;
  for (const [k, v] of Object.entries(obj(value, path))) out[key(k, `${path}.${k}`)] = read(v, `${path}.${k}`);
  return out;
}
function pair(value: unknown, path: string): [bigint, bigint] {
  if (!Array.isArray(value) || value.length !== 2) return bad(path, "a pair");
  return [big(value[0], `${path}[0]`), big(value[1], `${path}[1]`)];
}

const lower = (a: string): Address => a.toLowerCase() as Address;
