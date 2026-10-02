/**
 * What Your stack and Welcome are given, worked out from what the page
 * already holds: the auto-buy panel's vault reads and ledger, and Your
 * activity's rows. Nothing here reads the chain.
 *
 * Pure, so the rules are pinned by tests rather than by App's wiring:
 * - only the connected account's vaults and plans count;
 * - a vault is counted from the figures its own contract keeps (`readVault`),
 *   never from its logs, which a network service may cut short;
 * - a count that can't be known yet is null, never zero.
 */

import type { Address, DcaPlan } from "@spdex/core";
import type { DcaLedgerEntry } from "../dca/ledger.js";
import type { VaultPlanState } from "../dca/vault.js";
import type { RecordRow } from "../records/types.js";
import { canCard, type StackVault } from "./stack.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The auto-buy panel's reads of the plans in the config, as `useAutoBuy` gives them. */
export interface PlanReads {
  plans: readonly DcaPlan[];
  /** The network the page is on: plans for any other are left out. */
  chainId: number;
  vaultFor(planId: string): VaultPlanState | undefined;
  entryFor(plan: Pick<DcaPlan, "id" | "chainId">): DcaLedgerEntry | null | "unavailable";
}

/**
 * The account's vaults on this network, with the figures the auto-buy panel
 * last read from each: what it delivered, how many buys it made, and what
 * each buy spends and pays its caller. A vault not read yet, or someone
 * else's, is left out.
 */
export function stackVaults(reads: PlanReads, account: Address): StackVault[] {
  return reads.plans.flatMap((plan) => {
    if (plan.signer !== "vault" || plan.chainId !== reads.chainId) return [];
    const state = reads.vaultFor(plan.id);
    if (state?.kind !== "active" || !same(state.owner, account)) return [];
    return [
      {
        vault: state.vault,
        totalOut: state.received,
        buysDone: BigInt(state.buysDone),
        amountPerBuy: state.terms.amountPerBuy,
        keeperReward: state.terms.keeperReward,
        tokenOut: state.terms.tokenOut,
      },
    ];
  });
}

/** Vault plans whose vault hasn't been read yet, or couldn't be: their buys are nowhere in `stackVaults`. */
export interface UnreadVaults {
  /** Still being read. */
  reading: number;
  /** The read failed, or the factory didn't answer whether it made the vault. */
  failed: number;
}

/**
 * The vault plans on this network whose vault isn't in `stackVaults` because
 * it hasn't been read, or couldn't be. Whose they are is unknown until they
 * are read, so each may be the account's: Your stack says "reading…" or "at
 * least" for them rather than counting them as nothing bought. A vault not
 * created yet has bought nothing, and one that reads as not spDEX's, or as
 * someone else's, was never the account's to count.
 */
export function unreadVaults(reads: PlanReads): UnreadVaults {
  const unread: UnreadVaults = { reading: 0, failed: 0 };
  for (const plan of reads.plans) {
    if (plan.signer !== "vault" || plan.chainId !== reads.chainId) continue;
    const state = reads.vaultFor(plan.id);
    if (state === undefined || state.kind === "loading") unread.reading += 1;
    else if (state.kind === "unavailable" && (state.code === "unreadable" || state.code === "unconfirmed")) unread.failed += 1;
  }
  return unread;
}

/**
 * The buys the account's plans on this network have left, together, or null
 * when that can't be said: a vault still being read, a ledger this browser
 * can't open, or no plan of the account's at all (then there is nothing to
 * say, and Your stack says nothing).
 *
 * A wallet plan counts once this browser has started it for the account
 * (its ledger entry names the account); a vault plan once its vault reads as
 * the account's. A closed vault has no buys left.
 */
export function plansBuysLeft(reads: PlanReads, account: Address): number | null {
  let left = 0;
  let counted = 0;
  for (const plan of reads.plans) {
    if (plan.chainId !== reads.chainId) continue;
    if (plan.signer === "vault") {
      const state = reads.vaultFor(plan.id);
      if (state === undefined || state.kind === "loading" || state.kind === "creating") return null;
      if (state.kind !== "active" || !same(state.owner, account)) continue;
      left += state.closed ? 0 : state.buysLeft;
      counted += 1;
      continue;
    }
    const entry = reads.entryFor(plan);
    if (entry === "unavailable") return null;
    if (entry === null || !same(entry.owner, account)) continue;
    left += Math.max(0, plan.maxBuys - entry.buysDone);
    counted += 1;
  }
  return counted === 0 ? null : left;
}

/**
 * The account's first SPX buy recorded here that a card can be made of (SPX
 * a market or a vault delivered, measured on chain), or null before there is
 * one. Welcome turns into "Your first SPX is in" once it exists.
 */
export function firstSpxBuy(rows: readonly RecordRow[], account: Address | null): RecordRow | null {
  if (account === null) return null;
  let first: RecordRow | null = null;
  for (const row of rows) {
    if (row.account === null || !same(row.account, account) || !canCard(row)) continue;
    if (first === null || row.at.unix < first.at.unix) first = row;
  }
  return first;
}
