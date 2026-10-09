/**
 * Recurring buys — dollar-cost averaging as a standing instruction.
 *
 * ## Why a plan lives in the config
 *
 * A plan is an instruction to spend the user's money on a timer, with nobody
 * clicking anything at the moment it happens. Everything of that kind in spDEX
 * is a value the user can read, export, diff and hand to someone else, so a
 * plan sits in `SpdexConfig` next to the tip policy — and a hostile shared
 * config that tried to smuggle one in would have to do it visibly, in the
 * diff, where it arrives paused (see `arrivePaused` in @spdex/config).
 *
 * What a plan does *not* hold is equally deliberate: no account address (a
 * shared link would leak it, and the owner is bound on this device when the
 * plan is first started), no key material, no history. Those are facts about
 * one browser, not settings, and they live outside the config — see
 * `DcaProgress` below.
 *
 * ## Why every plan ends
 *
 * There is no "forever" setting. A plan buys `amountPerBuy` at most once per
 * `intervalSeconds`, at most `maxBuys` times, so the most it can ever spend is
 * their product and that figure is known before it starts. The Guard refuses
 * any buy that would take a plan past it, whatever proposed the buy.
 *
 * ## Windows, not timers
 *
 * Time is divided into windows of `intervalSeconds` starting at `startAt`. A
 * plan buys at most once per window. A window missed while no tab was open is
 * skipped rather than made up later: bunching three missed buys into one
 * moment would defeat the averaging the user asked for, and a catch-up burst is
 * exactly what an attacker who could delay the app would want to provoke.
 */

import { z } from "zod";
import { AddressSchema, BigIntSchema, ChainIdSchema, HexSchema, type Address } from "./primitives.js";

/**
 * The shortest interval a plan may have.
 *
 * A constant, not a setting, and checked by the Guard as well as the schema so
 * a bad import cannot rely on one of them having run. Five minutes is already
 * absurd for real money; it exists so the feature can be watched working on a
 * fork. The budget bounds what a short interval can do in any case — it only
 * changes how quickly an accepted budget is spent.
 */
export const MIN_DCA_INTERVAL_SECONDS = 300;
export const MAX_DCA_INTERVAL_SECONDS = 366 * 86_400;
/** Every plan ends; this is the most buys one may schedule. */
export const MAX_DCA_BUYS = 1_000;
/** A list of standing instructions too long to read is one nobody supervises. */
export const MAX_DCA_PLANS = 8;

/**
 * Who signs a plan's buys.
 *
 * `wallet` asks the connected wallet each time — spDEX holds nothing, and the
 * user confirms every buy, so someone has to be there when one is due.
 *
 * `vault` hands the plan to a contract: an immutable vault the owner creates
 * and funds from their own wallet, which holds the budget and makes each buy
 * itself whenever anyone triggers a due one — so, unlike a wallet plan, it
 * keeps buying while no spDEX tab is open. Nothing in this browser signs a
 * vault plan's buys. The owner's wallet signs only what the owner clicks:
 * creating the vault, funding it, closing it, and, if they choose, triggering
 * a due buy themselves.
 *
 * There were three until config version 8. The third, `autopilot`, signed
 * with a key this browser generated and the owner funded, and bought without
 * asking — but only while a spDEX tab was open. That is neither of the two
 * things people want from a recurring buy: to be asked each time, or to set
 * it and forget it. A vault does the second without spDEX holding a key, so
 * autopilot was removed, and the migration to version 8 turns every
 * autopilot plan into a paused wallet plan (`MIGRATIONS[7]` in
 * @spdex/config). Its spending wallet is not config and is not migrated; no
 * release ever made one, and the app no longer reads them (2026-10-02).
 */
export const DCA_SIGNERS = ["wallet", "vault"] as const;
export const DcaSignerSchema = z.enum(DCA_SIGNERS);
export type DcaSigner = z.infer<typeof DcaSignerSchema>;

/**
 * Native ether's pseudo-address, as a plan spells it: `NATIVE_TOKEN` in
 * @spdex/chain, which core does not depend on. A vault pays with ether and
 * nothing else, so a vault plan must sell this.
 */
const NATIVE_ETHER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * A positive whole amount in a token's base units, as a decimal string.
 *
 * Not a bigint, because `JSON.stringify` throws on one and the config is
 * stored and shared as JSON; not a number, because 1e18 exports to TOML as a
 * float and comes back different.
 */
export const BaseUnitsSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/, "must be a positive whole number of base units");

export const DcaPlanIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase id");

export const DcaPlanSchema = z
  .object({
    /** Host-generated and stable; it keys this browser's record of the plan. */
    id: DcaPlanIdSchema,
    /** Display only. */
    label: z.string().min(1).max(64).optional(),
    /**
     * A paused plan is one this tab does not run: it buys nothing from here.
     * Every plan that arrives from outside this browser arrives paused, so
     * starting one is always a deliberate act.
     *
     * A vault plan is always paused, and the schema holds it there, because
     * this tab never runs one: its vault does, whenever anyone triggers a due
     * buy. `false` would claim a runner that does not exist, and a switch
     * between the two would claim to stop buys it cannot stop — the only stop
     * a vault has is "Close and withdraw", on chain, which is why the app
     * offers no Pause for one. Pinned to `true` rather than `false` so that
     * the import rule (`arrivePaused` in @spdex/config) holds for a vault plan
     * without an exception, a vault plan survives export and import exactly,
     * and anything that runs plans in this tab passes over a vault plan
     * without having to know what one is. What it must not be read as is
     * "not buying": for a vault plan, the vault's own state says that.
     */
    paused: z.boolean(),
    /**
     * Token addresses mean something on one chain only. A plan written against
     * a fork must never start spending on mainnet because the endpoint changed.
     */
    chainId: ChainIdSchema,
    /** What each buy spends. 0xeeee…eeee is native ether. */
    sell: AddressSchema,
    /** What each buy acquires. */
    buy: AddressSchema,
    amountPerBuy: BaseUnitsSchema,
    intervalSeconds: z.number().int().min(MIN_DCA_INTERVAL_SECONDS).max(MAX_DCA_INTERVAL_SECONDS),
    maxBuys: z.number().int().min(1).max(MAX_DCA_BUYS),
    /**
     * Unix seconds at which the first window opens. Supplied by the host —
     * for a vault plan from the chain's clock, not this computer's, because
     * the vault judges time by blocks.
     */
    startAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    signer: DcaSignerSchema,
    /**
     * The vault a `vault` plan created, once it exists: absent until then,
     * and on every other plan.
     *
     * The one address in a plan besides its tokens, and the one that leads to
     * its money: the vault holds the budget, and this is how this browser
     * finds it again. It is written once and never changed (`updateDcaPlan`
     * in @spdex/config refuses). For a vault plan the chain, not this entry,
     * is the source of truth — the vault's terms, progress and history are
     * read from it, and a vault whose terms differ from the plan here is shown
     * as differing, never believed on the config's word.
     *
     * A plan still holds no account address, but this comes close: anyone can
     * ask the vault who owns it, so a config shared with a vault plan in it
     * says whose vault that is. That is also how a plan from someone else's
     * link is recognised as theirs and shown read-only.
     */
    vault: AddressSchema.optional(),
  })
  .refine((plan) => plan.sell !== plan.buy, { message: "a plan cannot buy the token it sells" })
  .refine((plan) => plan.signer !== "vault" || plan.paused, {
    message: "a vault plan is always paused here: its vault runs it, not this tab, and only closing it stops it",
    path: ["paused"],
  })
  .refine((plan) => plan.signer !== "vault" || plan.sell === NATIVE_ETHER, {
    message: "a vault plan sells ether: a vault pays with nothing else",
    path: ["sell"],
  })
  .refine((plan) => plan.vault === undefined || plan.signer === "vault", {
    message: "only a vault plan has a vault",
    path: ["vault"],
  })
  .refine((plan) => plan.vault === undefined || !/^0x0{40}$/.test(plan.vault), {
    message: "the zero address is not a vault",
    path: ["vault"],
  });
export type DcaPlan = z.infer<typeof DcaPlanSchema>;

export const DcaPolicySchema = z
  .object({
    /**
     * The master switch, and what the Features toggle writes. Off stops every
     * plan this tab runs, at once; the plans themselves are kept, as the tip
     * list is. A vault plan is not one of them: nothing in the config can stop
     * a vault, only closing it can.
     */
    enabled: z.boolean(),
    plans: z.array(DcaPlanSchema).max(MAX_DCA_PLANS),
  })
  .refine((policy) => new Set(policy.plans.map((p) => p.id)).size === policy.plans.length, {
    message: "two plans share an id",
  });
export type DcaPolicy = z.infer<typeof DcaPolicySchema>;

/** The most a plan can ever spend: every buy, at full size. */
export function planBudget(plan: Pick<DcaPlan, "amountPerBuy" | "maxBuys">): bigint {
  return BigInt(plan.amountPerBuy) * BigInt(plan.maxBuys);
}

/** The window a moment falls in, or null before the plan's first window opens. */
export function slotAt(
  plan: Pick<DcaPlan, "startAt" | "intervalSeconds">,
  nowSeconds: bigint,
): number | null {
  const start = BigInt(plan.startAt);
  if (nowSeconds < start) return null;
  return Number((nowSeconds - start) / BigInt(plan.intervalSeconds));
}

/** When a window opens, in unix seconds. */
export function slotOpensAt(plan: Pick<DcaPlan, "startAt" | "intervalSeconds">, slot: number): bigint {
  return BigInt(plan.startAt) + BigInt(slot) * BigInt(plan.intervalSeconds);
}

/**
 * What this browser has recorded about one plan's execution.
 *
 * Not config, and never exported: it is a fact about this device, like
 * whether the features dialog has been shown. Two properties matter more than
 * the rest. `committed` is the upper bound on what has left for this plan — the
 * sum of every claimed buy's `maxAmountIn`, claimed *before* signing — so a
 * crash mid-buy can cost a skipped buy but never an overspend. And a record
 * that cannot be read is `null`, not zero: a wiped record must stop a plan,
 * not restart its budget.
 */
export interface DcaProgress {
  planId: string;
  chainId: number;
  /** Where every buy is delivered: the wallet that started the plan. */
  owner: Address;
  /**
   * Who signs each buy: the owner. A record written before config version 8
   * for an autopilot plan names that plan's spending wallet instead, until
   * the plan is resumed as a wallet plan and the record is bound to its
   * owner; until then the Guard refuses its buys, since the plan says the
   * owner signs and the record says otherwise.
   */
  signer: Address;
  /** Buys that settled on chain. */
  buysDone: number;
  /** Σ maxAmountIn of every buy claimed, less anything a failed buy returned. */
  committed: bigint;
  /** The last window a buy was claimed in, or null if none has been. */
  lastSlot: number | null;
}


/**
 * ERC-20 `transfer`, from the one encoder the host and the Guard share.
 *
 * The same function the tip path uses, re-exported under a name that says what
 * it is. Two encoders would eventually disagree, and a check would then be
 * verifying its own copy of the bug rather than the call being signed.
 */
export { encodeTipTransfer as encodeErc20Transfer } from "./tips.js";
