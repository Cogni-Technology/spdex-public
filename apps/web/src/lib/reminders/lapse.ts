/**
 * "Remind me before my proof lapses": a community keeper's SPX proof lasts 30
 * days from its block's time, and this reminds, from five days before, while
 * spDEX is open in a tab (decision 25 of docs/V2_UPGRADE.md).
 *
 * It is the buy-due notification's path (lib/reminders/notify.ts), with its
 * own words, its own tick and the same rules: no request, nothing fetched to
 * show it, permission asked only when the box is ticked, shown only while the
 * tab is hidden, once per lapse.
 *
 * - **No read of its own.** What it knows is the last proof Community keeping
 *   read for this wallet on this chain (`rememberProof`): until when it is
 *   valid, and how far the chain's clock was from this device's at that read.
 *   It never asks the network service; a proof made elsewhere since is learnt
 *   the next time the panel reads.
 * - **Chain time.** A proof is valid while the chain's time is at most
 *   `validUntil`, and the chain's clock is not this device's: on a fork it
 *   runs days behind. So the moment is the chain's, moved to this device's
 *   clock by the difference seen at the read.
 * - **One timer, never too long.** A browser fires a timer set more than
 *   2^31 − 1 ms (about 24.8 days) ahead at once; a proof 30 days off is
 *   further than that, so the wait is cut there and armed again.
 */

import { useEffect, useMemo, useState } from "react";
import type { Address } from "@spdex/core";
import { PROOF_LAPSE_WARNING_SECONDS } from "@spdex/vault";
import { createPrefStore, usePref, type Pref, type PrefStorage, type PrefStore } from "../prefs.js";
import {
  PROOF_LAPSE_MESSAGE,
  showProofLapse,
  useNotifications,
  type BuyDueNotifications,
  type NotificationKind,
  type NotifierEnv,
} from "./notify.js";

export const PROOF_NOTIFY_KEY = "spdex.notify.proof.v1";
export const PROOF_RECORDS_KEY = "spdex.keeper.proofs.v1";

export const PROOF_NOTIFY_LABEL = "Remind me 5 days before my proof lapses (while spDEX is open in a tab)";

/** The longest wait a browser timer keeps: 2^31 − 1 ms. Longer ones fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** How many wallets' proofs are kept: a few, the newest. */
const MAX_RECORDS = 8;

/** The last proof read for one wallet on one chain. */
export interface ProofRecord {
  /** Until when, chain time, inclusive, the proof is valid. */
  validUntil: bigint;
  /** The chain's time minus this device's, in seconds, at the read. */
  skew: number;
}

/** By `${chainId}:${holder}`, holder lowercase. */
export type ProofRecords = Readonly<Record<string, ProofRecord>>;

const recordKey = (chainId: number, holder: string) => `${chainId}:${holder.toLowerCase()}`;

/** On only when this browser said so; anything else, or storage that can't be read, is off. Off removes the key. */
export const PROOF_NOTIFY_PREF: Pref<boolean> = {
  key: PROOF_NOTIFY_KEY,
  parse: (raw) => raw === "on",
  format: (on) => (on ? "on" : null),
};

/** The records, read defensively: anything this code didn't write is left out. */
export const PROOF_RECORDS_PREF: Pref<ProofRecords> = {
  key: PROOF_RECORDS_KEY,
  parse(raw) {
    if (raw === null) return {};
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const records: Record<string, ProofRecord> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!/^\d+:0x[0-9a-f]{40}$/.test(key) || typeof entry !== "object" || entry === null) continue;
      const { validUntil, skew } = entry as { validUntil?: unknown; skew?: unknown };
      if (typeof validUntil !== "string" || !/^\d{1,20}$/.test(validUntil) || typeof skew !== "number" || !Number.isSafeInteger(skew)) continue;
      records[key] = { validUntil: BigInt(validUntil), skew };
    }
    return records;
  },
  format(records) {
    const entries = Object.entries(records);
    if (entries.length === 0) return null;
    return JSON.stringify(Object.fromEntries(entries.map(([key, r]) => [key, { validUntil: r.validUntil.toString(), skew: r.skew }])));
  },
};

let shared: PrefStore<ProofRecords> | null = null;

/** The page's one store of proof records: Community keeping writes it, the reminder reads it. */
export function proofRecordsStore(storage?: PrefStorage | null): PrefStore<ProofRecords> {
  if (storage !== undefined) return createPrefStore(PROOF_RECORDS_PREF, storage);
  shared ??= createPrefStore(PROOF_RECORDS_PREF);
  return shared;
}

/**
 * Keep what a read said about `holder`'s proof on `chainId`: valid until
 * `validUntil` (0 when it never proved), read when the chain's time was
 * `chainTime` and this device's `nowMs`. A wallet that never proved is
 * forgotten: it has nothing to lapse.
 */
export function rememberProof(
  input: { chainId: number; holder: Address; validUntil: bigint; chainTime: bigint; nowMs?: number },
  store: PrefStore<ProofRecords> = proofRecordsStore(),
): void {
  const key = recordKey(input.chainId, input.holder);
  const rest = Object.entries(store.get()).filter(([k]) => k !== key);
  if (input.validUntil === 0n) {
    if (rest.length !== Object.keys(store.get()).length) store.set(Object.fromEntries(rest));
    return;
  }
  const skew = Number(input.chainTime) - Math.floor((input.nowMs ?? Date.now()) / 1000);
  const kept = rest.slice(-(MAX_RECORDS - 1));
  store.set(Object.fromEntries([...kept, [key, { validUntil: input.validUntil, skew }]]));
}

/** The record kept for `holder` on `chainId`, or null. */
export function proofRecordOf(records: ProofRecords, chainId: number, holder: Address | null): ProofRecord | null {
  return holder === null ? null : (records[recordKey(chainId, holder)] ?? null);
}

/**
 * Whether the reminder's moment has come at `nowMs` (this device's clock):
 * from five days before the proof lapses to the last second it is valid,
 * both in chain time. And when that next changes, on this device's clock:
 * when the five days begin, or when the proof lapses; null when it never will.
 */
export function proofLapseState(record: ProofRecord | null, nowMs: number): { due: boolean; nextChangeMs: number | null } {
  if (record === null) return { due: false, nextChangeMs: null };
  const chainNow = Math.floor(nowMs / 1000) + record.skew;
  const lapsesAt = Number(record.validUntil) + 1; // the first second it is no longer valid
  const warnFrom = Number(record.validUntil - PROOF_LAPSE_WARNING_SECONDS);
  const toDevice = (chainSeconds: number) => (chainSeconds - record.skew) * 1000;
  if (chainNow >= lapsesAt) return { due: false, nextChangeMs: null };
  if (chainNow >= warnFrom) return { due: true, nextChangeMs: toDevice(lapsesAt) };
  return { due: false, nextChangeMs: toDevice(warnFrom) };
}

/** How long to wait for `nextChangeMs` from `nowMs`: never below 0, never above what a browser timer keeps. */
export function timerDelay(nextChangeMs: number, nowMs: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, nextChangeMs - nowMs));
}

export const PROOF_LAPSE_KIND: NotificationKind = { message: PROOF_LAPSE_MESSAGE, pref: PROOF_NOTIFY_PREF, show: showProofLapse };

/**
 * The proof-lapse reminder for `holder` on `chainId`, and the state its
 * checkbox shows. Mounted where Help run the network is, so it runs while
 * spDEX is open whether or not the panel is; it reads nothing but this
 * browser's storage.
 */
export function useProofLapseNotifications(
  chainId: number,
  holder: Address | null,
  options: { env?: NotifierEnv; store?: PrefStore<ProofRecords>; now?: () => number } = {},
): BuyDueNotifications {
  const store = useMemo(() => options.store ?? proofRecordsStore(), [options.store]);
  const records = usePref(store);
  const record = proofRecordOf(records, chainId, holder);
  const now = options.now ?? Date.now;
  // Re-rendered when the moment changes, or when a wait cut short at the
  // timer's limit ends: the state is worked out afresh, and a timer armed again.
  const [tick, setTick] = useState(0);
  const { due, nextChangeMs } = proofLapseState(record, now());

  useEffect(() => {
    if (nextChangeMs === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), timerDelay(nextChangeMs, now()));
    return () => clearTimeout(timer);
  }, [nextChangeMs, now, tick]);

  return useNotifications(due, PROOF_LAPSE_KIND, options.env);
}
