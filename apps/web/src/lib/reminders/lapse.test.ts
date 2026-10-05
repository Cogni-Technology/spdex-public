/**
 * The proof-lapse reminder's timing and memory: when, in chain time, it is
 * due; how that moves to this device's clock; that a wait never overflows a
 * browser timer; and what is kept in this browser, read defensively. The
 * notification itself is the buy-due one's (notify.test.ts).
 */

import { describe, expect, it } from "vitest";
import type { Address } from "@spdex/core";
import { PROOF_LAPSE_WARNING_SECONDS } from "@spdex/vault";
import { createPrefStore, readPref, writePref, type PrefStorage } from "../prefs.js";
import {
  MAX_TIMER_MS,
  PROOF_LAPSE_KIND,
  PROOF_NOTIFY_KEY,
  PROOF_NOTIFY_PREF,
  PROOF_RECORDS_KEY,
  PROOF_RECORDS_PREF,
  proofLapseState,
  proofRecordOf,
  rememberProof,
  timerDelay,
} from "./lapse.js";
import { NOTIFY_KEY, PROOF_LAPSE_MESSAGE } from "./notify.js";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
const DAY = 86_400;
/** A proof valid until this chain time, inclusive. */
const UNTIL = 1_792_273_763n;

function memory(): PrefStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** This device's clock, in ms, when the chain's time is `chain` and the chain runs `skew` seconds ahead. */
const deviceAt = (chain: bigint | number, skew = 0) => (Number(chain) - skew) * 1000;

describe("when the reminder is due", () => {
  const record = { validUntil: UNTIL, skew: 0 };
  const warnFrom = UNTIL - PROOF_LAPSE_WARNING_SECONDS;

  it("from five days before the proof lapses to its last valid second, in chain time", () => {
    expect(PROOF_LAPSE_WARNING_SECONDS).toBe(BigInt(5 * DAY));
    expect(proofLapseState(record, deviceAt(warnFrom - 1n))).toEqual({ due: false, nextChangeMs: deviceAt(warnFrom) });
    expect(proofLapseState(record, deviceAt(warnFrom))).toEqual({ due: true, nextChangeMs: deviceAt(UNTIL + 1n) });
    // Valid through its last second, as the registry has it.
    expect(proofLapseState(record, deviceAt(UNTIL)).due).toBe(true);
    // Lapsed: nothing more to remind of, and no timer.
    expect(proofLapseState(record, deviceAt(UNTIL + 1n))).toEqual({ due: false, nextChangeMs: null });
    expect(proofLapseState(null, 0)).toEqual({ due: false, nextChangeMs: null });
  });

  it("judges by the chain's clock, moved to this device's by the difference seen at the read", () => {
    // A fork whose chain runs three days behind this device.
    const behind = { validUntil: UNTIL, skew: -3 * DAY };
    expect(proofLapseState(behind, deviceAt(warnFrom, -3 * DAY)).due).toBe(true);
    expect(proofLapseState(behind, deviceAt(warnFrom - 1n, -3 * DAY)).due).toBe(false);
    // By this device's clock alone, it would have said so three days early.
    expect(proofLapseState(behind, deviceAt(warnFrom)).due).toBe(false);
  });

  it("never waits longer than a browser timer keeps, nor less than nothing", () => {
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    // A proof 30 days off: about 25 days to its warning, past the limit; cut there and armed again.
    const now = deviceAt(UNTIL - BigInt(30 * DAY));
    const { nextChangeMs } = proofLapseState(record, now);
    expect(nextChangeMs! - now).toBeGreaterThan(MAX_TIMER_MS);
    expect(timerDelay(nextChangeMs!, now)).toBe(MAX_TIMER_MS);
    expect(timerDelay(now + 5_000, now)).toBe(5_000);
    expect(timerDelay(now - 5_000, now)).toBe(0);
  });
});

describe("what is kept", () => {
  it("keeps each wallet's last-read proof per chain, with the chain's clock against this device's, and forgets a wallet with none", () => {
    const storage = memory();
    const store = createPrefStore(PROOF_RECORDS_PREF, storage);
    rememberProof({ chainId: 1, holder: ME, validUntil: UNTIL, chainTime: 1_790_000_100n, nowMs: 1_790_000_000_000 }, store);
    expect(proofRecordOf(store.get(), 1, ME)).toEqual({ validUntil: UNTIL, skew: 100 });
    expect(proofRecordOf(store.get(), 690069, ME)).toBeNull();
    expect(proofRecordOf(store.get(), 1, OTHER)).toBeNull();
    expect(proofRecordOf(store.get(), 1, null)).toBeNull();
    // The holder is matched whatever its case.
    expect(proofRecordOf(store.get(), 1, ME.toUpperCase().replace("0X", "0x") as Address)).not.toBeNull();
    // Written so a reload reads it back.
    expect(readPref(PROOF_RECORDS_PREF, storage)).toEqual(store.get());
    expect(storage.map.get(PROOF_RECORDS_KEY)).toBe(`{"1:${ME}":{"validUntil":"${UNTIL}","skew":100}}`);

    rememberProof({ chainId: 1, holder: ME, validUntil: 0n, chainTime: 1n, nowMs: 0 }, store);
    expect(store.get()).toEqual({});
    expect(storage.map.has(PROOF_RECORDS_KEY)).toBe(false);
  });

  it("keeps a few wallets, the newest", () => {
    const store = createPrefStore(PROOF_RECORDS_PREF, memory());
    for (let n = 1; n <= 10; n++) {
      rememberProof({ chainId: 1, holder: `0x${n.toString(16).padStart(40, "0")}` as Address, validUntil: UNTIL, chainTime: 0n, nowMs: 0 }, store);
    }
    expect(Object.keys(store.get())).toHaveLength(8);
    expect(proofRecordOf(store.get(), 1, `0x${"a".padStart(40, "0")}` as Address)).not.toBeNull();
    expect(proofRecordOf(store.get(), 1, `0x${"1".padStart(40, "0")}` as Address)).toBeNull();
  });

  it("reads anything it didn't write as nothing, and never throws", () => {
    const at = (raw: string | null) => readPref(PROOF_RECORDS_PREF, { getItem: () => raw, setItem: () => undefined });
    expect(at(null)).toEqual({});
    expect(at("not json")).toEqual({});
    expect(at("[1,2]")).toEqual({});
    expect(at(`{"1:${ME}":{"validUntil":"12x","skew":0},"x":{"validUntil":"1","skew":0},"1:${OTHER}":{"validUntil":"5","skew":1.5}}`)).toEqual({});
    expect(at(`{"1:${ME}":{"validUntil":"5","skew":-3}}`)).toEqual({ [`1:${ME}`]: { validUntil: 5n, skew: -3 } });
  });

  it("has its own tick, apart from a due buy's, on only when this browser said so", () => {
    const storage = memory();
    expect(PROOF_NOTIFY_KEY).not.toBe(NOTIFY_KEY);
    expect(readPref(PROOF_NOTIFY_PREF, storage)).toBe(false);
    writePref(PROOF_NOTIFY_PREF, true, storage);
    expect(storage.map.get(PROOF_NOTIFY_KEY)).toBe("on");
    expect(storage.map.has(NOTIFY_KEY)).toBe(false);
    writePref(PROOF_NOTIFY_PREF, false, storage);
    expect(storage.map.has(PROOF_NOTIFY_KEY)).toBe(false);
    expect(PROOF_LAPSE_KIND.message).toBe(PROOF_LAPSE_MESSAGE);
    expect(PROOF_LAPSE_KIND.pref).toBe(PROOF_NOTIFY_PREF);
  });
});
