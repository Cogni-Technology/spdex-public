/**
 * The keeper's log: one JSON object a line, for its operator and for
 * `pnpm keeper:report`.
 *
 * ## What may appear in it
 *
 * Nothing the operator would not publish. The key is never passed here, and
 * the endpoints' URLs — which carry API keys — must never leak through an
 * error message that quotes one. So the log keeps two kinds of field apart:
 *
 * - **Typed fields** — hashes, addresses, amounts, counts, names from a fixed
 *   set — are checked against their shape and written as they are, never
 *   redacted: a report joins on them, and a redaction that ate a transaction
 *   hash would break the join silently. A value that fails its check is
 *   written as null, and the caller logs an `error` saying which field.
 * - **Free text** — an error's message, a skip's detail — goes through
 *   `makeRedactor`, which removes the key and every configured URL (and the
 *   parts of one an error might quote without its `https://`), then anything
 *   still shaped like a URL or a 64-digit hex string.
 *
 * `(keeper, seq)` identifies a record across rotated files and several
 * keepers; `seq` is persisted in the state.
 */

import type { Address, Hex } from "@spdex/core";

export const KEEPER_LOG_VERSION = 1;

export type WaitReason = "not-cheap" | "fees-above-max" | "economics" | "pending-tx" | "dry-run" | "stale-head" | "low-balance" | "holders-first";
export type WarnCode = "public-mempool" | "deployment-missing" | "key-permissions" | "unknown-setting" | "registry-missing" | "prove-dry-run";

/**
 * Why the keeper did not prove `rewardTo` when its proof was due for renewal:
 * the endpoint won't answer `eth_getProof`; `rewardTo` held less than 690 SPX
 * at the finalized block; the block's header didn't hash to its hash; it is a
 * contract, which the registry never pays; a proof already as new is there;
 * the registry would refuse it (its test-run reverted); or the proof's
 * test-run asked for more gas than a proof is ever sent with. Or why a proof
 * already in flight is not sent again: a proof as new landed first
 * (`not-newer`), proving was turned off (`off`), or `rewardTo` is another
 * address since it was sent (`other-holder`).
 */
export type ProveSkipReason =
  | "unsupported"
  | "below-min-spx"
  | "header-mismatch"
  | "contract"
  | "not-newer"
  | "refused"
  | "gas"
  | "fees-above-max"
  | "low-balance"
  | "off"
  | "other-holder";

/** A vault in a batch as `batch_sent` reports it. */
export interface SentVault {
  vault: Address;
  reward: bigint;
  marginWei: bigint;
  subsidyWei: bigint;
  urgent: boolean;
  firstBuy: boolean;
  spotOut: bigint | null;
  floorOut: bigint | null;
  depth: bigint | null;
  secondsToDeadline: bigint;
  /**
   * A v2 buy sent inside its community window (this keeper's `rewardTo` may
   * be paid there): the first second it is open to anyone. Null for v1, and
   * for a buy sent after its window.
   */
  communityWindowEndsAt: bigint | null;
}

export interface MinedBuy {
  vault: Address;
  slot: bigint;
  buyNumber: bigint;
  amountIn: bigint;
  amountOut: bigint;
  floorOut: bigint;
  oracleDepth: bigint;
  reward: bigint;
  gasUsed: bigint;
  secondsIntoWindow: bigint;
  /** Who the vault paid: `Bought.rewardTo` (v1: the caller, the batcher). */
  rewardTo: Address | null;
  /** When the buy fell due, from `Bought`; null for v1. */
  dueSince: bigint | null;
  /** Made inside its community window; null for v1, or when its terms are not known here. */
  inCommunityWindow: boolean | null;
}

export interface MinedRefusal {
  vault: Address;
  reason: Hex;
  reasonName: string | null;
  gasUsed: bigint;
}

/** What each record type carries, besides the envelope. */
export type KeeperLogBody =
  | {
      type: "start";
      /** Null for a dry run without a key or a configured `rewardTo`. */
      rewardTo: Address | null;
      chainId: number;
      dryRun: boolean;
      deployments: { id: string; factory: Address; batcher: Address; registry: Address | null }[];
      sendMode: "public" | "private";
      /** `SPDEX_KEEPER_PROVE`: whether this keeper may prove `rewardTo`. */
      prove: boolean;
      sendWhen: string;
      policy: Record<string, bigint | number | string | boolean | null>;
      version: string;
      gitSha: string | null;
    }
  | { type: "warn"; code: WarnCode; text: string }
  | {
      type: "heartbeat";
      phase: "syncing" | "running";
      ok: boolean;
      lastError: string | null;
      pending: { batchId: string; nonce: number; hash: Hex; sentBlock: bigint } | null;
      active: number;
      /** Null when the tick failed: how many were due is unknown, not zero. */
      due: number | null;
      lastBatchHash: Hex | null;
      balanceWei: bigint | null;
      runwayDays: number | null;
      attention: string[];
      /** Whether `rewardTo` may be paid inside the latest release's community windows; null when unknown. */
      eligible: boolean | null;
      /** Until when its proof is valid, chain time (0: never proved); null when unknown. */
      proofValidUntil: bigint | null;
      /** Days until the proof lapses, to a tenth; negative once lapsed; null when unknown or never proved. */
      proofDaysLeft: number | null;
    }
  | { type: "tick"; nextBaseFeeWei: bigint | null; lowestTargetWei: bigint | null; active: number; clockDue: number; candidates: number }
  | { type: "sync"; deployment: string; scannedCount: bigint; vaultCount: bigint }
  | {
      type: "vault_found";
      vault: Address;
      deployment: string;
      index: bigint | null;
      owner: Address;
      marketIndex: number | null;
      tokenOut: Address;
      amountPerBuy: bigint;
      interval: bigint;
      maxBuys: bigint;
      startAt: bigint;
      keeperReward: bigint;
      maxSlippageBps: bigint;
      /** Seconds of first claim for SPX holders after each buy falls due; null for a v1 vault. */
      communityWindow: bigint | null;
      /** Turns in the window's first half: 0 for none; null for a source without turns (v1). */
      turnBuckets: bigint | null;
    }
  | { type: "vault_retired"; vault: Address; reason: "closed" | "done" }
  | { type: "wait"; reason: WaitReason; nextBaseFeeWei: bigint | null; targetWei: bigint | null; candidates: number; nextDeadline: bigint | null }
  | {
      type: "skip";
      vault: Address;
      slot: bigint | null;
      code: string;
      detail: string;
      spotOut?: bigint | null;
      floorOut?: bigint | null;
      depth?: bigint | null;
    }
  | { type: "skip_cleared"; vault: Address; slot: bigint | null; code: string; seconds: bigint }
  | {
      type: "batch_sent";
      batchId: string;
      nonce: number;
      attempt: number;
      hash: Hex;
      deployment: string;
      batcher: Address;
      endpoint: "public" | "private";
      reason: string;
      urgent: boolean;
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nextBaseFeeWei: bigint;
      expectedGas: bigint;
      expectedCostWei: bigint;
      expectedEarnedWei: bigint;
      allowedLossWei: bigint;
      minRewardsWei: bigint;
      vaults: SentVault[];
    }
  | {
      type: "batch_replaced";
      batchId: string;
      nonce: number;
      oldHash: Hex;
      newHash: Hex;
      attempt: number;
      why: "not-included";
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    }
  | { type: "resend_blocked"; batchId: string; nonce: number; why: "fee-cap" }
  | { type: "batch_cancel_sent"; batchId: string; nonce: number; hash: Hex }
  | { type: "batch_cancelled"; batchId: string; nonce: number; hash: Hex; costWei: bigint }
  | { type: "batch_abandoned"; batchId: string; nonce: number; hashes: Hex[]; why: "expired" | "nonce-consumed" }
  | {
      type: "batch_mined";
      batchId: string;
      hash: Hex;
      nonce: number;
      block: bigint;
      status: "success" | "reverted";
      late: boolean;
      gasUsed: bigint;
      effectiveGasPrice: bigint;
      priorityFeeWei: bigint | null;
      costWei: bigint;
      earnedWei: bigint;
      /** Stray WETH v1's batcher swept to `rewardTo`; null for v2's, which moves no WETH at all. */
      sweptWei: bigint | null;
      netWei: bigint;
      sentBlock: bigint | null;
      inclusionBlocks: bigint | null;
      attempts: number;
      listed: bigint;
      tried: bigint;
      bought: MinedBuy[];
      refused: MinedRefusal[];
      notTried: Address[];
    }
  | { type: "overtaken"; vault: Address; slot: bigint }
  | {
      type: "window_missed";
      vault: Address;
      slot: bigint;
      windowStart: bigint;
      windowEnd: bigint;
      class: "unfunded" | "closed" | "keeper-skipped" | "keeper-down" | "unknown";
      lastSkip: string | null;
      lastDetail: string | null;
    }
  | { type: "trapped"; vault: Address; txHash: Hex; gasUsed: bigint }
  | { type: "untrapped"; vault: Address; why: "expired" | "reset" | "new-batcher" }
  | { type: "subsidy_exhausted"; lossWei24h: bigint; capWei: bigint }
  | { type: "low_balance"; etherWei: bigint; thresholdWei: bigint; neededWei: bigint | null }
  | { type: "unwrap_sent"; batchId: string; hash: Hex; amountWei: bigint }
  | { type: "unwrap_mined"; batchId: string; hash: Hex; amountWei: bigint; status: "success" | "reverted" }
  | { type: "batcher_deployed"; deployment: string; hash: Hex; address: Address }
  | {
      /**
       * What the keeper read of its `rewardTo` in a release's SPX holder
       * registry: logged when it changes, and once a day besides, so the day
       * its proof lapses is in the log whether or not this keeper proves.
       */
      type: "eligibility";
      deployment: string;
      registry: Address;
      rewardTo: Address;
      eligible: boolean | null;
      validUntil: bigint | null;
      /** Days until the proof lapses, to a tenth; negative once lapsed; null when unknown or never proved. */
      daysLeft: number | null;
      spxWei: bigint | null;
      minSpxWei: bigint;
      isAccount: boolean | null;
      /** Why it isn't eligible, in the registry's order: not-proven, lapsed, contract, below-minimum; null when it is, or unknown. */
      reason: string | null;
    }
  | {
      type: "prove_sent";
      batchId: string;
      hash: Hex;
      deployment: string;
      registry: Address;
      holder: Address;
      /** The finalized block whose state it proves. */
      provenBlock: bigint;
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      /** Until when the proof makes `holder` eligible once mined: the block's time and 30 days. */
      validUntil: bigint;
    }
  | {
      type: "prove_mined";
      batchId: string;
      hash: Hex;
      deployment: string | null;
      status: "success" | "reverted";
      costWei: bigint;
      /** From the registry's own `Proven`; null when it reverted, or the log is not there. */
      validUntil: bigint | null;
    }
  | { type: "prove_skipped"; deployment: string; holder: Address; reason: ProveSkipReason; detail: string }
  | {
      /** The key's ether covers fewer days of sends than `minRunwayDays`, at its last week's spend: top it up. */
      type: "low_runway";
      runwayDays: number;
      thresholdDays: number;
      etherWei: bigint;
      spentWeekWei: bigint;
    }
  | { type: "error"; where: string; message: string }
  | { type: "stop"; reason: "signal" | "watchdog" | "fatal"; detail: string };

export type KeeperLogType = KeeperLogBody["type"];

/** Every record: the envelope, then its body. */
export type KeeperLogRecord = {
  v: 1;
  /** Wall-clock time, ISO-8601. */
  ts: string;
  seq: number;
  keeper: Address | null;
  block?: bigint;
  chainTime?: bigint;
} & KeeperLogBody;

/**
 * A record, stamped with the next `seq` (kept in the state, so it survives a
 * restart), the keeper and the wall clock — and the block it describes, when
 * there is one.
 */
export function stampRecord(
  counter: { seq: number },
  keeper: Address | null,
  wallClockMs: number,
  body: KeeperLogBody,
  at?: { block: bigint; chainTime: bigint },
): KeeperLogRecord {
  counter.seq += 1;
  return { v: KEEPER_LOG_VERSION, ts: new Date(wallClockMs).toISOString(), seq: counter.seq, keeper, ...(at ?? {}), ...body } as KeeperLogRecord;
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * A function that scrubs free text of the key and the configured URLs.
 *
 * Exact values first, case-insensitively: the key with and without `0x`; each
 * URL whole; its host and path, its path and its query (an error may quote a
 * URL without its scheme); and every path or query segment of 16 characters or
 * more, where API keys live. Then, whatever it was, anything shaped like a URL
 * — anvil can echo an upstream URL the keeper never knew — and any 64-digit
 * hex string, which is what a key looks like.
 */
export function makeRedactor(secrets: { key?: string | null; urls?: readonly string[] }): (text: string) => string {
  const literals = new Set<string>();
  const key = secrets.key?.trim();
  if (key) {
    literals.add(key);
    literals.add(key.replace(/^0x/i, ""));
  }
  for (const raw of secrets.urls ?? []) {
    const url = raw.trim();
    if (!url) continue;
    literals.add(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    const query = parsed.search.replace(/^\?/, "");
    if (path) literals.add(`${parsed.host}${path}`);
    for (const part of [path, query, parsed.username, parsed.password]) if (part.length >= 6) literals.add(part);
    for (const segment of [...path.split("/"), ...query.split(/[&=]/)]) {
      const decoded = safeDecode(segment);
      if (segment.length >= 16) literals.add(segment);
      if (decoded.length >= 16) literals.add(decoded);
    }
  }
  const exact = [...literals].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const exactRe = exact.length === 0 ? null : new RegExp(exact.map(escapeRegExp).join("|"), "gi");
  return (text: string) => {
    let out = exactRe === null ? text : text.replace(exactRe, "<redacted>");
    out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
    out = out.replace(/(0x)?[0-9a-fA-F]{64}/g, "<hex64>");
    return out;
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── One line ─────────────────────────────────────────────────────────────────

const HASH_FIELDS = new Set(["hash", "oldHash", "newHash", "txHash", "lastBatchHash", "hashes"]);
const ADDRESS_FIELDS = new Set(["keeper", "vault", "rewardTo", "factory", "batcher", "owner", "address", "tokenOut", "notTried", "registry", "holder"]);
const TEXT_FIELDS = new Set(["message", "lastError", "detail", "lastDetail", "text"]);
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** Names from a fixed set, ids and timestamps: nothing a secret could hide in. */
const TOKEN_RE = /^[A-Za-z0-9_.:+-]{0,120}$/;

/**
 * A record as one JSON line: bigints as decimal strings, typed fields checked
 * and written as they are, free text redacted. `invalid` lists the fields
 * written as null because they failed their check; the caller logs an `error`
 * for them.
 */
export function toJsonLine(record: KeeperLogRecord, redact: (text: string) => string): { line: string; invalid: string[] } {
  const invalid: string[] = [];
  const encode = (value: unknown, key: string, path: string): unknown => {
    if (value === undefined || value === null) return null;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      invalid.push(path);
      return null;
    }
    if (typeof value === "string") {
      if (TEXT_FIELDS.has(key)) return redact(value);
      const ok = HASH_FIELDS.has(key) ? HASH_RE.test(value) : ADDRESS_FIELDS.has(key) ? ADDRESS_RE.test(value) : TOKEN_RE.test(value);
      if (ok) return value;
      invalid.push(path);
      return null;
    }
    if (Array.isArray(value)) return value.map((item, i) => encode(item, key, `${path}[${i}]`));
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined) out[k] = encode(v, k, path ? `${path}.${k}` : k);
      }
      return out;
    }
    invalid.push(path);
    return null;
  };
  return { line: JSON.stringify(encode(record, "", "")), invalid };
}
