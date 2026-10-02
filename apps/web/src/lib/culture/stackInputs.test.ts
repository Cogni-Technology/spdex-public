import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address, DcaPlan, Hex } from "@spdex/core";
import type { DcaLedgerEntry } from "../dca/ledger.js";
import type { VaultFigures, VaultPlanState } from "../dca/vault.js";
import type { RecordRow } from "../records/types.js";
import { summariseStack } from "./stack.js";
import { firstSpxBuy, plansBuysLeft, stackVaults, unreadVaults, type PlanReads } from "./stackInputs.js";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const SOMEONE = "0x00000000000000000000000000000000000000bb" as Address;
const CHAIN = 690069;
const SPX = TOKENS.SPX.address as Address;

const plan = (id: string, over: Partial<DcaPlan> = {}): DcaPlan =>
  ({ id, chainId: CHAIN, signer: "wallet", maxBuys: 10, ...over }) as DcaPlan;

const vault = (over: Partial<VaultFigures> = {}): VaultPlanState =>
  ({
    kind: "active",
    vault: "0x00000000000000000000000000000000000000cc",
    owner: ME,
    mine: true,
    terms: { tokenOut: SPX, amountPerBuy: 10n ** 16n, keeperReward: 10n ** 14n },
    closed: false,
    buysDone: 3,
    maxBuys: 10,
    buysLeft: 7,
    received: 5_000n,
    ...over,
  }) as VaultPlanState;

const entry = (over: Partial<DcaLedgerEntry> = {}): DcaLedgerEntry => ({ owner: ME, buysDone: 4, ...over }) as DcaLedgerEntry;

function reads(plans: DcaPlan[], vaults: Record<string, VaultPlanState>, entries: Record<string, DcaLedgerEntry | null | "unavailable">): PlanReads {
  return { plans, chainId: CHAIN, vaultFor: (id) => vaults[id], entryFor: (p) => entries[p.id] ?? null };
}

describe("stackVaults", () => {
  it("takes the account's read vaults on this network, from the vault's own figures", () => {
    const r = reads(
      [plan("a", { signer: "vault" }), plan("b", { signer: "vault" }), plan("c", { signer: "vault", chainId: 1 }), plan("d", { signer: "vault" })],
      { a: vault(), b: vault({ owner: SOMEONE }), c: vault(), d: { kind: "loading" } },
      {},
    );
    expect(stackVaults(r, ME)).toEqual([
      {
        vault: "0x00000000000000000000000000000000000000cc",
        totalOut: 5_000n,
        buysDone: 3n,
        amountPerBuy: 10n ** 16n,
        keeperReward: 10n ** 14n,
        tokenOut: SPX,
      },
    ]);
  });
});

describe("unreadVaults", () => {
  it("counts vault plans here still being read, and those whose read failed; nothing else", () => {
    const failed = (code: "unreadable" | "unconfirmed" | "not-a-vault" | "unsupported"): VaultPlanState => ({ kind: "unavailable", code, reason: "x" });
    const r = reads(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => plan(id, { signer: "vault", ...(id === "i" ? { chainId: 1 } : {}) })),
      {
        b: { kind: "loading" },
        c: failed("unreadable"),
        d: failed("unconfirmed"),
        e: failed("not-a-vault"),
        f: failed("unsupported"),
        g: { kind: "not-created", note: null },
        h: vault(),
        i: { kind: "loading" },
      },
      {},
    );
    expect(unreadVaults(r)).toEqual({ reading: 2, failed: 2 });
  });

  it("makes the stack 'at least', with a note, rather than nothing yet", () => {
    const summary = summariseStack({ account: ME, chainId: CHAIN, rows: [], vaults: [], truncated: [], unreadVaults: 1 });
    expect(summary.stacked).toEqual({ amount: 0n, atLeast: true });
    expect(summary.putIn.atLeast).toBe(true);
    expect(summary.notes).toContain("1 vault couldn't be read just now, so what it bought isn't counted.");
  });
});

describe("plansBuysLeft", () => {
  it("adds the account's wallet plans and vaults", () => {
    const r = reads(
      [plan("w"), plan("v", { signer: "vault" }), plan("x", { signer: "vault" }), plan("other")],
      { v: vault(), x: vault({ closed: true, buysLeft: 7 }) },
      { w: entry(), other: entry({ owner: SOMEONE }) },
    );
    expect(plansBuysLeft(r, ME)).toBe(6 + 7);
  });

  it("is unknown, never 0, while a vault is still being read or the ledger can't be opened", () => {
    expect(plansBuysLeft(reads([plan("v", { signer: "vault" })], { v: { kind: "loading" } }, {}), ME)).toBeNull();
    expect(plansBuysLeft(reads([plan("w")], {}, { w: "unavailable" }), ME)).toBeNull();
  });

  it("says nothing when the account has no plan here", () => {
    expect(plansBuysLeft(reads([plan("w")], {}, { w: null }), ME)).toBeNull();
    expect(plansBuysLeft(reads([], {}, {}), ME)).toBeNull();
  });
});

describe("firstSpxBuy", () => {
  const row = (over: Partial<RecordRow>): RecordRow => ({
    id: String(Math.random()),
    kind: "swap",
    chainId: CHAIN,
    account: ME,
    at: { unix: 1_000, source: "block" },
    block: 1n,
    hashes: [`0x${"1".repeat(64)}` as Hex],
    sold: { token: NATIVE_TOKEN as Address, amount: 1n, measured: true },
    bought: { token: SPX, amount: 100n, measured: true },
    buyFee: 0n,
    networkFee: 0n,
    valueUsd: null,
    rates: null,
    valueSource: null,
    ...over,
  });

  it("is the account's earliest measured SPX buy", () => {
    const early = row({ at: { unix: 500, source: "block" } });
    const rows = [
      row({}),
      early,
      row({ at: { unix: 100, source: "block" }, account: SOMEONE }),
      row({ at: { unix: 100, source: "block" }, bought: { token: SPX, amount: null, measured: false } }),
      row({ at: { unix: 100, source: "block" }, kind: "tip" }),
    ];
    expect(firstSpxBuy(rows, ME)).toBe(early);
  });

  it("is null without a wallet or a buy", () => {
    expect(firstSpxBuy([row({})], null)).toBeNull();
    expect(firstSpxBuy([], ME)).toBeNull();
  });
});
