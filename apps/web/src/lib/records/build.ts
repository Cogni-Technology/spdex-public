/**
 * Your activity's rows: what this browser recorded (swaps, tips, the buys of
 * plans the person confirms) and what the chain says about their vault
 * plans' buys, put together.
 *
 * Pure. Every read happens in store.ts; this only combines the answers, so
 * the rules below are tested without a chain:
 * - **Unknown is blank, never zero.** An amount, a fee, a date or a value
 *   that couldn't be read is null, and every total built from these rows
 *   says what it left out.
 * - **A row belongs to the wallet that sent it:** its first transaction's
 *   receipt `from` (attribution.ts). A vault's buys belong to the vault's
 *   owner, since whoever triggered them sent the transaction.
 * - **A vault buy's fees follow who was paid and who sent it.** Its buy fee
 *   is the owner's cost unless it came back to the owner (v2: paid to the
 *   owner, whoever named them; v1: the owner called), and its network fee is
 *   the owner's only when the owner called `execute` themselves. Who made it
 *   is said by `buyMaker`, the rule a vault card and the keeper's report use,
 *   judged at the buy's block time with the vault's own strict `<`.
 * - **What isn't listed is said.** Buys a plan's record no longer keeps,
 *   swaps past the store's 1,000, vault buys the network service wouldn't
 *   return: each is a sentence in `notes`, never a silent gap.
 */

import type { Address, DcaPlan, Hex } from "@spdex/core";
import { TOKENS } from "@spdex/chain";
import { SOURCES, SOURCE_IDS_NEWEST_FIRST, buyMaker, isListedBatcher, type SourceId } from "@spdex/vault";
import { RUN_CODES, type DcaLedger } from "../dca/ledger.js";
import { cardTitle } from "../dca/view.js";
import type { VaultHistory, VaultHistoryEntry } from "../dca/vault.js";
import { formatCount } from "../money/format.js";
import { accountOf, blockOf, networkFeeOf, type TxFacts } from "./attribution.js";
import type { StoredLeg, StoredReceipt } from "./store.js";
import type { FxSnapshot } from "../money/pricing.js";
import { fxFromStored, valueAtBlock, valueSeen, type StoredRates } from "./values.js";
import type { RecordLeg, RecordRow, VaultBuyFacts } from "./types.js";

/** What is known about one block. */
export interface BlockFacts {
  time: number | null;
  /** Chainlink's answers at this block, once "Fill in values" read them. */
  chainlink: FxSnapshot | null;
}

/** What rows are built from, besides the records themselves: rates, transactions and blocks, by what they're keyed on. */
export interface RecordsLookup {
  seen(hash: string): StoredRates | null;
  tx(hash: string): TxFacts | null;
  block(chainId: number, block: bigint): BlockFacts | null;
}

/** The store as rows need it (store.ts `Receipts`). */
export interface ReceiptsRead extends RecordsLookup {
  receipts: readonly StoredReceipt[];
  dropped: number;
}

/** One of the person's vault plans, with its vault's history as read (or why it couldn't be). */
export interface VaultBuys {
  plan: DcaPlan;
  owner: Address;
  tokenOut: Address;
  maxBuys: number;
  buysDone: number;
  /** The vault's community window, seconds (`VaultTerms.communityWindow`): null for v1, or when it wasn't read. */
  communityWindow?: bigint | null;
  history?: VaultHistory;
  error?: string;
}

export interface BuildInput {
  chainId: number;
  receipts: ReceiptsRead | "unavailable";
  ledger: DcaLedger | "unavailable";
  plans: readonly DcaPlan[];
  vaults: readonly VaultBuys[];
}

export interface Built {
  /** Every row on this network, whoever made it, newest first. */
  rows: RecordRow[];
  notes: string[];
  /** Plans whose earliest buys this browser's record no longer keeps. */
  truncated: { planId: string; planLabel: string; missing: number }[];
}

const none = { valueUsd: null, rates: null, valueSource: null } as const;

const legOf = (leg: StoredLeg): RecordLeg => ({
  token: leg.token,
  amount: leg.amount === null ? null : BigInt(leg.amount),
  measured: leg.measured,
});

/** "1 buy", "3 buys". */
const count = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

/**
 * A row's value at the time, from the first source that applies: the rates
 * seen with its last transaction, then Chainlink at its block.
 */
function valued(
  sold: RecordLeg,
  lastHash: string | undefined,
  chainId: number,
  block: bigint | null,
  lookup: RecordsLookup,
): Pick<RecordRow, "valueUsd" | "rates" | "valueSource"> {
  const seen = lastHash === undefined ? null : lookup.seen(lastHash);
  if (seen !== null) {
    const value = valueSeen(sold, seen);
    if (value !== null) return { valueUsd: value, rates: seen.fx === null ? null : fxFromStored(seen.fx), valueSource: "twap-seen" };
  }
  const chainlink = block === null ? null : (lookup.block(chainId, block)?.chainlink ?? null);
  if (chainlink !== null) {
    const value = valueAtBlock(sold, chainlink);
    if (value !== null) return { valueUsd: value, rates: chainlink, valueSource: "chainlink-at-block" };
  }
  return none;
}

/** When a row happened: its block's time once read, else this device's time when it was recorded. */
function whenOf(chainId: number, block: bigint | null, deviceUnix: number, lookup: RecordsLookup): RecordRow["at"] {
  const time = block === null ? null : (lookup.block(chainId, block)?.time ?? null);
  return time === null ? { unix: deviceUnix, source: "device" } : { unix: time, source: "block" };
}

/** A swap, a tip, buy fees earned, or a deleted plan's buy that this browser recorded, as a row. */
export function receiptRow(receipt: StoredReceipt, lookup: RecordsLookup): RecordRow {
  const facts = (hash: string) => lookup.tx(hash);
  const block = blockOf(receipt.hashes, facts);
  const sold = legOf(receipt.sold);
  return {
    id: receipt.id,
    kind: receipt.kind,
    chainId: receipt.chainId,
    account: accountOf(receipt.hashes, facts),
    at: whenOf(receipt.chainId, block, receipt.at, lookup),
    block,
    hashes: [...receipt.hashes],
    sold,
    bought: legOf(receipt.bought),
    buyFee: 0n,
    networkFee: networkFeeOf(receipt.hashes, facts),
    ...(receipt.plan === undefined
      ? {}
      : { planId: receipt.plan.id, planLabel: receipt.plan.label, buyIndex: { n: receipt.plan.n, of: receipt.plan.of } }),
    // Buy fees received sold nothing, so there is no "value then": valuing
    // their known-zero sold side would put a $0 in a record kept for taxes,
    // a false known zero. Every consumer (screen, statement, CSV) gets blank.
    ...(receipt.kind === "buy-fees-earned" ? none : valued(sold, receipt.hashes.at(-1), receipt.chainId, block, lookup)),
  };
}

function planBuyRows(input: BuildInput, lookup: RecordsLookup, built: Built): void {
  if (input.ledger === "unavailable") {
    built.notes.push("This browser's record of your plans' buys couldn't be read, so they aren't listed.");
    return;
  }
  let orphaned = 0;
  for (const entry of Object.values(input.ledger.entries)) {
    if (entry.chainId !== input.chainId) continue;
    const confirmed = entry.runs.filter((run) => run.status === "confirmed");
    const plan = input.plans.find((p) => p.id === entry.planId && p.chainId === entry.chainId);
    if (plan === undefined) {
      // A record whose plan is gone from the settings says what it spent and
      // bought, but not in which tokens: it can't be a row.
      orphaned += confirmed.length;
      continue;
    }
    const label = cardTitle(plan);
    const missing = entry.buysDone - confirmed.length;
    if (missing > 0) {
      built.truncated.push({ planId: plan.id, planLabel: label, missing });
      built.notes.push(
        `The first ${count(missing, "buy", "buys")} of plan “${label}” aren't listed: this browser keeps the latest 100.`,
      );
    }
    let n = entry.buysDone;
    for (const run of [...confirmed].reverse()) {
      // Kept as a receipt already (a delete whose record outlived it): listed once.
      if (built.rows.some((row) => row.id === `plan-buy:${entry.chainId}:${plan.id}:${run.slot}`)) {
        n -= 1;
        continue;
      }
      const hashes = run.hashes.map((h) => h.toLowerCase() as Hex);
      const facts = (hash: string) => lookup.tx(hash);
      const block = blockOf(hashes, facts);
      // What a buy claimed is exactly what it sold, every buy being
      // exact-input, unless only some of its legs went through.
      const partial = run.codes?.includes(RUN_CODES.PARTIAL) ?? false;
      const sold: RecordLeg = { token: plan.sell, amount: partial ? null : BigInt(run.amountIn), measured: false };
      built.rows.push({
        id: `plan-buy:${entry.chainId}:${plan.id}:${run.slot}`,
        kind: "plan-buy",
        chainId: entry.chainId,
        account: accountOf(hashes, facts),
        at: whenOf(entry.chainId, block, Math.floor(run.at / 1000), lookup),
        block,
        hashes,
        sold,
        bought:
          run.amountOut === undefined
            ? { token: plan.buy, amount: null, measured: false }
            : { token: plan.buy, amount: BigInt(run.amountOut), measured: true },
        buyFee: 0n,
        networkFee: networkFeeOf(hashes, facts),
        ...valued(sold, hashes.at(-1), entry.chainId, block, lookup),
        planId: plan.id,
        planLabel: label,
        buyIndex: { n: Math.max(1, n), of: plan.maxBuys },
      });
      n -= 1;
    }
  }
  if (orphaned > 0) {
    built.notes.push(`${count(orphaned, "buy", "buys")} of plans no longer in your settings aren't listed.`);
  }
}

function vaultBuyRows(input: BuildInput, lookup: RecordsLookup, built: Built): void {
  let undated = 0;
  for (const vault of input.vaults) {
    const label = cardTitle(vault.plan);
    if (vault.history === undefined) {
      built.notes.push(`“${label}”: spDEX couldn't read the vault's buys (${vault.error ?? "no answer"}).`);
      continue;
    }
    const { history } = vault;
    if (history.missingBuys > 0) {
      built.notes.push(
        `“${label}”: the vault's first ${count(history.missingBuys, "buy isn't", "buys aren't")} listed: your network service didn't return its older history.`,
      );
    }
    let n = vault.buysDone;
    for (const entry of history.entries) {
      if (entry.kind !== "bought") continue;
      const index = n;
      n -= 1;
      const time = entry.at ?? lookup.block(input.chainId, entry.blockNumber)?.time ?? null;
      if (time === null) {
        undated += 1;
        continue;
      }
      const sold: RecordLeg = { token: TOKENS.WETH.address, amount: entry.amountIn ?? null, measured: entry.amountIn !== undefined };
      const sentByOwner = same(entry.keeper, vault.owner);
      // Who was paid the buy fee: from v2 on the address the call named, in
      // v1 the caller. Null when such a log's payee wasn't read.
      const paidBack = paysRewardTo(entry)
        ? entry.rewardTo === undefined
          ? null
          : same(entry.rewardTo, vault.owner)
        : sentByOwner;
      built.rows.push({
        id: `vault-buy:${input.chainId}:${entry.hash}:${entry.logIndex}`,
        kind: "vault-buy",
        chainId: input.chainId,
        account: vault.owner.toLowerCase() as Address,
        at: { unix: time, source: "block" },
        block: entry.blockNumber,
        hashes: [entry.hash],
        sold,
        bought: {
          token: vault.tokenOut.toLowerCase() as Address,
          amount: entry.amountOut ?? null,
          measured: entry.amountOut !== undefined,
        },
        // Usually a keeper made the buy, so the owner paid its buy fee and no
        // gas. A fee paid back to the owner (Trigger now, or in v2 any call
        // that named the owner: their own Help run batch, or someone else's
        // courtesy) cost the owner nothing on net. An owner who called
        // `execute` themselves paid the gas, known once the receipt is read;
        // one whose own batch made it paid the batch's gas, which that
        // batch's "Buy fees earned" row carries, so it isn't counted twice —
        // and that row leaves this fee out (`feesEarnedFromOthers`), so it
        // isn't counted as earned either.
        buyFee: paidBack === null ? null : paidBack ? 0n : (entry.reward ?? null),
        networkFee: sentByOwner ? networkFeeOf([entry.hash], (hash) => lookup.tx(hash)) : 0n,
        ...valued(sold, undefined, input.chainId, entry.blockNumber, lookup),
        planId: vault.plan.id,
        planLabel: label,
        buyIndex: { n: Math.max(1, index), of: vault.maxBuys },
        vaultBuy: vaultBuyFacts(entry, vault, time, lookup),
      });
    }
  }
  if (undated > 0) {
    built.notes.push(
      `${count(undated, "vault buy isn't", "vault buys aren't")} listed because spDEX couldn't read when ${undated === 1 ? "it" : "they"} happened. Opening this again tries again.`,
    );
  }
}

/** Whether two addresses are the same, either unknown being no. */
const same = (a: string | undefined | null, b: string): boolean => a != null && a.toLowerCase() === b.toLowerCase();

/** The oldest source, which every vault was built from when a log read carried no source. */
const OLDEST_SOURCE: SourceId = SOURCE_IDS_NEWEST_FIRST[SOURCE_IDS_NEWEST_FIRST.length - 1]!;

/** A buy's source, the layout its `Bought` was read as. Every log read now says which; one without was read when v1 was the only one. */
const sourceOf = (entry: VaultHistoryEntry): SourceId => entry.source ?? OLDEST_SOURCE;

/** Whether a buy paid the `rewardTo` its trigger named (v2 on), rather than its caller (v1). */
const paysRewardTo = (entry: VaultHistoryEntry): boolean => SOURCES[sourceOf(entry)].features.executeTakesRewardTo;

/** Whether one of spDEX's batchers called `execute`, for whoever sent it the batch. */
const viaBatcher = (entry: VaultHistoryEntry) => entry.keeper !== undefined && isListedBatcher(entry.keeper);

/**
 * What a vault buy's log says about who made it, judged as the vault judged
 * it: at the buy's block time `at`, inside the community window while
 * `at < dueSince + communityWindow`, exactly the vault's own check. The
 * transaction's sender, which tells the owner's own batch from someone
 * else's courtesy, comes from the history read or from a receipt read here.
 */
export function vaultBuyFacts(
  entry: VaultHistoryEntry,
  vault: Pick<VaultBuys, "owner" | "communityWindow">,
  at: number,
  lookup: Pick<RecordsLookup, "tx">,
): VaultBuyFacts {
  const source = sourceOf(entry);
  const { executeTakesRewardTo, communityWindow } = SOURCES[source].features;
  const window = entry.communityWindow ?? (vault.communityWindow == null ? null : Number(vault.communityWindow));
  return {
    caller: entry.keeper === undefined ? null : (entry.keeper.toLowerCase() as Address),
    rewardTo: executeTakesRewardTo && entry.rewardTo !== undefined ? (entry.rewardTo.toLowerCase() as Address) : null,
    dueSince: communityWindow ? (entry.dueSince ?? null) : null,
    maker: buyMaker({
      source,
      owner: vault.owner,
      rewardTo: entry.rewardTo ?? null,
      keeper: entry.keeper ?? null,
      sender: entry.sender ?? lookup.tx(entry.hash)?.from ?? null,
      at: BigInt(at),
      dueSince: entry.dueSince == null ? null : BigInt(entry.dueSince),
      communityWindow: window === null ? null : BigInt(window),
    }),
  };
}

const newestFirst = (a: RecordRow, b: RecordRow) =>
  b.at.unix - a.at.unix || (a.block !== null && b.block !== null && a.block !== b.block ? (b.block > a.block ? 1 : -1) : 0) || a.id.localeCompare(b.id);

/** Every row on `input.chainId`, whoever made it, newest first. */
export function buildRows(input: BuildInput): Built {
  const built: Built = { rows: [], notes: [], truncated: [] };
  const lookup: RecordsLookup =
    input.receipts === "unavailable" ? { seen: () => null, tx: () => null, block: () => null } : input.receipts;

  if (input.receipts === "unavailable") {
    built.notes.push("This browser's record of your swaps and tips couldn't be read, so they aren't listed. spDEX left it as it was.");
  } else {
    for (const receipt of input.receipts.receipts) {
      if (receipt.chainId === input.chainId) built.rows.push(receiptRow(receipt, lookup));
    }
    if (input.receipts.dropped > 0) {
      built.notes.push(
        `The oldest ${count(input.receipts.dropped, "swap or tip", "swaps and tips")} recorded here aren't listed: this browser keeps the latest 1,000.`,
      );
    }
  }
  planBuyRows(input, lookup, built);
  vaultBuyRows(input, lookup, built);
  built.rows.sort(newestFirst);
  return built;
}

/** The connected account's rows, and rows whose wallet couldn't be told; none without a wallet. */
export function rowsFor(built: Pick<Built, "rows">, account: string | null): RecordRow[] {
  if (account === null) return [];
  const mine = account.toLowerCase();
  return built.rows.filter((row) => row.account === null || row.account.toLowerCase() === mine);
}

/** The sentence under a list with rows no wallet could be told for. */
export function unattributedNote(rows: readonly RecordRow[]): string | null {
  const k = rows.filter((row) => row.account === null).length;
  return k === 0 ? null : `Couldn't tell which wallet made ${formatCount(k)} of these; they're left out of the totals.`;
}

/**
 * What the chain still has to be asked for these rows: receipts not yet
 * read, newest first, and blocks whose time isn't known yet.
 */
export function pendingReads(input: BuildInput): { hashes: Hex[]; blocks: bigint[] } {
  if (input.receipts === "unavailable") return { hashes: [], blocks: [] };
  const lookup = input.receipts;
  const hashes = new Set<Hex>();
  const blocks = new Set<bigint>();
  const need = (rowHashes: readonly string[]) => {
    for (const hash of rowHashes) if (lookup.tx(hash) === null) hashes.add(hash.toLowerCase() as Hex);
    const block = blockOf(rowHashes, (hash) => lookup.tx(hash));
    if (block !== null && lookup.block(input.chainId, block)?.time == null) blocks.add(block);
  };
  for (const receipt of [...lookup.receipts].reverse()) if (receipt.chainId === input.chainId) need(receipt.hashes);
  if (input.ledger !== "unavailable") {
    for (const entry of Object.values(input.ledger.entries)) {
      if (entry.chainId !== input.chainId || !input.plans.some((p) => p.id === entry.planId && p.chainId === entry.chainId)) continue;
      for (const run of [...entry.runs].reverse()) if (run.status === "confirmed") need(run.hashes);
    }
  }
  for (const vault of input.vaults) {
    for (const entry of vault.history?.entries ?? []) {
      if (entry.kind !== "bought") continue;
      if (entry.at === null && lookup.block(input.chainId, entry.blockNumber)?.time == null) blocks.add(entry.blockNumber);
      if (lookup.tx(entry.hash) !== null) continue;
      // A buy the owner triggered themselves: its receipt gives the network fee they paid.
      if (same(entry.keeper, vault.owner)) hashes.add(entry.hash.toLowerCase() as Hex);
      // A v2 buy paid back to the owner through a batcher, whose sender the
      // history didn't read: its receipt's `from` tells the owner's own batch
      // from someone else's.
      else if (paysRewardTo(entry) && same(entry.rewardTo, vault.owner) && entry.sender == null && viaBatcher(entry)) {
        hashes.add(entry.hash.toLowerCase() as Hex);
      }
    }
  }
  return { hashes: [...hashes], blocks: [...blocks] };
}
