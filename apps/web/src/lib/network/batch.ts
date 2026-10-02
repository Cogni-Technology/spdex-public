/**
 * Help run the network: make other people's due vault buys, in one
 * transaction from this wallet, and be paid their buy fees.
 *
 * A vault buys only when someone triggers it, and whoever does is paid the
 * vault's buy fee. A keeper does it for a living; a tab can too, now and
 * then, when the fees cover the network fee. This file decides which buys
 * such a batch makes and what it may cost, and reads back what it did. It
 * never signs: the batch is a `VaultBatchIntent` the Engine's vault Guard
 * checks (`Engine.checkVaultBatch`), and only what the Guard verified is
 * sent, through `submit`, privately, with no public fallback.
 *
 * ## Private sending only, and only when it pays
 *
 * Anyone can copy `executeBatch(vaults, rewardTo, minRewards)` with their own
 * `rewardTo`, and bots copy exactly the batches worth copying, which are the
 * only ones spDEX offers. Sent publicly, a batch is taken first and the copy
 * fails, still paying its network fee. So the panel offers this only with
 * private sending, and only when the buy fees cover the network fee at the
 * very price that will be signed: `minRewards` makes the batch revert, rather
 * than pay less, if the fees fall short on chain.
 *
 * ## How a batch is chosen
 *
 * 1. Candidates: vaults of the Guard's factory that aren't closed, have buys
 *    left, hold a buy and its fee, and are due now at or above their floor
 *    (`readDueCandidates`, @spdex/vault, from Collective DCA's read).
 * 2. The gas price, read once (`privateGasPrice`: the next block's highest
 *    possible base fee and a tip). It is the price signed, so the economics
 *    below are exact, not a guess about a later price.
 * 3. The keeper's own selection (`selectBatch`), as a private send that plans
 *    no loss: small buys first, at most 20.
 * 4. A test-run of that batch from this wallet (`preflight`), at the gas limit
 *    it will be signed with (`batchGasLimit`), since the batcher decides by
 *    the gas left whether to try each vault. Only the vaults that bought are
 *    kept, and the test-run is repeated on them until every one buys.
 * 5. `minRewards` = the test-run's gas × 1.1 × the price, rounded up. Offered
 *    only when the fees earned in the test-run reach it.
 * 6. The most of the batch this wallet can put up the maximum network fee
 *    for, keeping `GAS_RESERVE_WEI` back; the test-run is repeated on a batch
 *    cut short, so its figures are always the batch's own.
 *
 * Every read goes to the person's own network service. Nothing here counts as
 * a money figure unless the page's rates are fresh (`moneyView`), and an
 * unknown figure is left out, never shown as zero.
 */

import type { Address, Hex } from "@spdex/core";
import type { JsonRpc } from "@spdex/chain";
import {
  DEFAULT_KEEPER_POLICY,
  MAX_BATCH_GAS_CEILING,
  RATIO_ONE,
  batchGasLimit,
  decodeBatchRevert,
  decodeExecuteBatchResult,
  encodeExecuteBatch,
  joinBatchLogs,
  modelBatchGas,
  reasonName,
  selectBatch,
  type BatchCandidate,
  type BatchOutcome,
  type RawLog,
  type SelectedVault,
} from "@spdex/vault";
import { MAX_BATCH_TRIGGER_VAULTS, type VaultBatchIntent } from "@spdex/guard";
import { ethText } from "../dca/format.js";
import { fiatCostText, type MoneyView } from "../money/convert.js";
import { formatCount } from "../money/format.js";
import { quantity, readReceipt, type ChainReceipt } from "../receipts.js";
import { GAS_RESERVE_WEI } from "../tokens.js";

const lower = (value: string): Address => value.toLowerCase() as Address;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ── Selection ─────────────────────────────────────────────────────────────────

/** How many vault buys one batch from a tab makes at most: the Guard's own limit. */
export const MAX_HELP_RUN_VAULTS = MAX_BATCH_TRIGGER_VAULTS;

/**
 * The keeper's choice of vaults for a private batch that plans no loss, at
 * the price that will be signed: small buys first, each paying its own gas and
 * together the batch's. `only`, when given, is the person's own ticks: the
 * choice is made again among those alone.
 */
export function chooseVaults(
  candidates: readonly BatchCandidate[],
  gasPrice: bigint,
  only: ReadonlySet<string> | null = null,
): SelectedVault[] {
  const pool = only === null ? candidates : candidates.filter((c) => only.has(lower(c.vault)));
  return selectBatch({
    candidates: pool,
    feePerGas: gasPrice,
    ratioPpm: RATIO_ONE,
    privateSend: true,
    pairReserves: new Map(),
    ownerSubsidised24h: new Map(),
    dailyLossLeft: 0n,
    policy: { ...DEFAULT_KEEPER_POLICY, maxVaultsPerBatch: MAX_HELP_RUN_VAULTS, maxLossPerBuy: 0n },
  }).vaults.slice(0, MAX_HELP_RUN_VAULTS);
}

/**
 * The network fee the keeper's gas figures put on `vaults` at `gasPrice`: the
 * batch's fixed gas and each buy's. For "don't cover the network fee (about
 * …)", before any test-run has said more exactly.
 */
export function modelledFee(vaults: readonly { firstBuy: boolean }[], gasPrice: bigint): bigint {
  return modelBatchGas(vaults) * gasPrice;
}

/** `minRewards`: the test-run's gas, 10% more for the difference the final calldata makes, at the price signed; rounded up. */
export function minRewardsFor(gasUsed: bigint, gasPrice: bigint): bigint {
  return (gasUsed * 11n * gasPrice + 9n) / 10n;
}

/**
 * The longest start of `vaults` whose maximum network fee this wallet can put
 * up while keeping `GAS_RESERVE_WEI` back. The limit is what the wallet must
 * hold to send at all, though only the gas used is spent.
 */
export function affordablePrefix<T extends { firstBuy: boolean }>(vaults: readonly T[], gasPrice: bigint, balance: bigint): T[] {
  const room = balance - GAS_RESERVE_WEI;
  let count = 0;
  for (let n = 1; n <= vaults.length; n++) {
    if (batchGasLimit(vaults.slice(0, n)) * gasPrice > room) break;
    count = n;
  }
  return vaults.slice(0, count);
}

// ── The test-run ──────────────────────────────────────────────────────────────

/** What a test-run of a batch said. */
export type Preflight =
  | {
      kind: "ran";
      /** Everything the transaction used, the first WETH credit to an empty account included. */
      gasUsed: bigint;
      /** In the order the vaults were listed. */
      outcomes: readonly BatchOutcome[];
      /** WETH the batch paid the account; null when nothing bought (`NothingBought`). */
      earned: bigint | null;
      bought: bigint;
      /** WETH someone had sent the batcher, which this batch would have passed on. 0 when none. */
      swept: bigint;
    }
  | { kind: "failed"; reason: string };

interface RawSimCall {
  status?: string;
  gasUsed?: string;
  returnData?: string;
  error?: { message?: string; data?: string };
  logs?: { address?: string; topics?: string[]; data?: string; logIndex?: string }[];
}

/**
 * Test-run `executeBatch(vaults, account, 0)` from `account`, at `gasLimit`.
 *
 * `eth_simulateV1`, not `eth_call`: the gas used is what the economics rest
 * on, and a call doesn't report it. Without `traceTransfers`, so the log just
 * before each `Triggered` is its vault's own `Bought`, as `joinBatchLogs`
 * requires. Through the person's own network service. A test-run only
 * chooses what to offer; the Guard runs its own before anything is signed.
 */
export async function preflight(
  rpc: JsonRpc,
  input: { account: Address; batcher: Address; vaults: readonly Address[]; gasLimit: bigint },
): Promise<Preflight> {
  const { account, batcher, vaults, gasLimit } = input;
  let answer: unknown;
  try {
    answer = await rpc("eth_simulateV1", [
      {
        blockStateCalls: [
          {
            calls: [
              {
                from: account,
                to: batcher,
                data: encodeExecuteBatch(vaults, account, 0n),
                value: "0x0",
                gas: `0x${gasLimit.toString(16)}`,
              },
            ],
          },
        ],
        traceTransfers: false,
        validation: false,
      },
      "latest",
    ]);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const call = (answer as { calls?: RawSimCall[] }[] | null)?.[0]?.calls?.[0];
  if (call === undefined) return { kind: "failed", reason: "the network service's test-run answered nothing" };
  const gasUsed = quantity(call.gasUsed);
  if (gasUsed === null) return { kind: "failed", reason: "the network service's test-run reported no gas" };

  if (call.status !== undefined && BigInt(call.status) === 0n) {
    // anvil puts the revert in returnData, geth in error.data too.
    const data = (call.returnData && call.returnData !== "0x" ? call.returnData : call.error?.data) as Hex | undefined;
    const reverted = data === undefined ? null : decodeBatchRevert(vaults, data);
    if (reverted === null) {
      return { kind: "failed", reason: `the batch reverts (${call.error?.message ?? "no reason given"})` };
    }
    return { kind: "ran", gasUsed, outcomes: reverted.outcomes, earned: reverted.earned, bought: reverted.bought, swept: 0n };
  }

  let result;
  try {
    result = decodeExecuteBatchResult(vaults, (call.returnData ?? "0x") as Hex);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const logs: RawLog[] = (call.logs ?? []).map((log, index) => ({
    address: log.address ?? "0x",
    topics: log.topics ?? [],
    data: log.data ?? "0x",
    // A client that leaves the index out still lists the logs in order.
    logIndex: log.logIndex ?? `0x${index.toString(16)}`,
  }));
  const batch = joinBatchLogs(logs, (address) => same(address, batcher)).find((run) => run.batch !== null)?.batch ?? null;
  return { kind: "ran", gasUsed, outcomes: result.outcomes, earned: result.earned, bought: result.bought, swept: batch?.swept ?? 0n };
}

// ── The plan ──────────────────────────────────────────────────────────────────

/** What the panel can offer right now. */
export type HelpRunPlan =
  | { kind: "none-due" }
  /** Due buys whose fees don't cover the network fee: `fees` earned against about `cost`. */
  | { kind: "not-covered"; due: number; fees: bigint; cost: bigint }
  /** None of the chosen buys would go through; the vaults' own reasons ("TooSoon"). */
  | { kind: "none-would-buy"; reasons: string[] }
  /** The batcher holds WETH someone sent it, which this batch would pass on. */
  | { kind: "unaccounted"; swept: bigint }
  /** Not even one buy's maximum network fee fits this wallet's balance. */
  | { kind: "needs-balance"; need: bigint; fee: bigint; balance: bigint }
  | { kind: "failed"; reason: string }
  | {
      kind: "offer";
      /** Every due candidate, for the list the person ticks. */
      due: readonly BatchCandidate[];
      /** In the order they will be triggered. */
      vaults: readonly SelectedVault[];
      gasLimit: bigint;
      gasPrice: bigint;
      minRewards: bigint;
      /** The test-run's buy fees and gas, for this exact list. */
      earned: bigint;
      gasUsed: bigint;
    };

export interface PlanInput {
  rpc: JsonRpc;
  account: Address;
  batcher: Address;
  /** The due candidates (`readDueCandidates`). */
  due: readonly BatchCandidate[];
  gasPrice: bigint;
  /** The account's ETH, in wei. */
  balance: bigint;
  /** The person's ticks, when they changed the choice. */
  only?: ReadonlySet<string> | null;
}

/** How many times the test-run is repeated on a shorter list before giving up. */
const MAX_PREFLIGHTS = 4;

/**
 * Choose the batch to offer, test-run it, and say what it would earn and
 * cost; or say why there is nothing to offer. See the header for the steps.
 */
export async function planHelpRun(input: PlanInput): Promise<HelpRunPlan> {
  const { rpc, account, batcher, due, gasPrice, balance } = input;
  if (due.length === 0) return { kind: "none-due" };
  if (gasPrice <= 0n) return { kind: "failed", reason: "the network service reported no gas price" };

  let list: SelectedVault[] = chooseVaults(due, gasPrice, input.only ?? null);
  if (list.length === 0) {
    const pool = input.only ? due.filter((c) => input.only!.has(lower(c.vault))) : due;
    return {
      kind: "not-covered",
      due: pool.length,
      fees: pool.reduce((sum, c) => sum + c.reward, 0n),
      cost: modelledFee(pool, gasPrice),
    };
  }

  for (let round = 0; round < MAX_PREFLIGHTS; round++) {
    const fitting = affordablePrefix(list, gasPrice, balance);
    if (fitting.length === 0) {
      const one = list.slice(0, 1);
      return { kind: "needs-balance", need: batchGasLimit(one) * gasPrice + GAS_RESERVE_WEI, fee: modelledFee(one, gasPrice), balance };
    }
    list = fitting;
    const gasLimit = batchGasLimit(list);
    if (gasLimit > MAX_BATCH_GAS_CEILING) return { kind: "failed", reason: "the batch would need more gas than one transaction may use" };

    const run = await preflight(rpc, { account, batcher, vaults: list.map((v) => lower(v.vault)), gasLimit });
    if (run.kind === "failed") return run;
    if (run.swept > 0n) return { kind: "unaccounted", swept: run.swept };

    const bought = new Set(run.outcomes.filter((o) => o.bought).map((o) => lower(o.vault)));
    if (bought.size === 0) {
      const reasons = [...new Set(run.outcomes.map((o) => o.reasonName ?? (o.reason === null ? "unknown" : reasonName(o.reason) ?? o.reason)))];
      return { kind: "none-would-buy", reasons };
    }
    if (bought.size < list.length) {
      list = list.filter((v) => bought.has(lower(v.vault)));
      continue;
    }

    const earned = run.earned ?? 0n;
    const minRewards = minRewardsFor(run.gasUsed, gasPrice);
    if (earned < minRewards || minRewards < 1n) {
      return { kind: "not-covered", due: list.length, fees: earned, cost: run.gasUsed * gasPrice };
    }
    return { kind: "offer", due, vaults: list, gasLimit, gasPrice, minRewards, earned, gasUsed: run.gasUsed };
  }
  return { kind: "failed", reason: "the vaults' answers kept changing between test-runs" };
}

/** The intent the Guard checks and the wallet signs, for an offer. `rewardTo` is always the account. */
export function batchIntent(offer: Extract<HelpRunPlan, { kind: "offer" }>, account: Address, chainId: number): VaultBatchIntent {
  return {
    version: 1,
    action: "batch",
    chainId,
    account: lower(account),
    vaults: offer.vaults.map((v) => lower(v.vault)),
    rewardTo: lower(account),
    minRewards: offer.minRewards,
    gasLimit: offer.gasLimit,
    gasPrice: offer.gasPrice,
  };
}

// ── What it did ───────────────────────────────────────────────────────────────

/** A settled batch, from its receipt: never from the test-run. */
export interface BatchResult {
  status: "success" | "reverted";
  /** Vault buys made, from the `Batch` event; 0 for a reverted batch. */
  made: number;
  /** Vaults listed. */
  of: number;
  /** WETH received, from the `Batch` event; 0n for a reverted batch; null when a successful one has no `Batch` from the batcher. */
  earned: bigint | null;
  /** Gas used × the price paid; null when the receipt doesn't say. */
  fee: bigint | null;
  /** Each listed vault that didn't buy, with its reason's name when known. */
  untriggered: { vault: Address; reason: string }[];
}

/**
 * What a settled batch did, from its receipt. Only the batcher's own `Batch`
 * says what was earned: anyone can emit a log shaped like it.
 */
export function batchResultOf(receipt: ChainReceipt, input: { batcher: Address; vaults: readonly Address[] }): BatchResult {
  const listed = input.vaults.map(lower);
  const fee = receipt.fee;
  if (receipt.status === "reverted") {
    return { status: "reverted", made: 0, of: listed.length, earned: 0n, fee, untriggered: listed.map((vault) => ({ vault, reason: "reverted" })) };
  }
  const run = joinBatchLogs(receipt.logs, (address) => same(address, input.batcher)).find((r) => r.batch !== null) ?? null;
  const batch = run?.batch ?? null;
  const triggered = new Set((run?.triggered ?? []).map((t) => lower(t.event.vault)));
  const reasons = new Map((run?.notTriggered ?? []).map((n) => [lower(n.vault), n.reasonName ?? n.reason] as const));
  return {
    status: "success",
    made: batch === null ? triggered.size : Number(batch.bought),
    of: listed.length,
    earned: batch === null ? null : batch.earned,
    fee,
    untriggered: listed.filter((v) => !triggered.has(v)).map((vault) => ({ vault, reason: reasons.get(vault) ?? "NotTried" })),
  };
}

/**
 * Wait for a sent batch to settle, and read its receipt and what it did
 * (`batchResultOf`): the receipt is asked for every `everyMs` until it
 * arrives or `timeoutMs` passes (then null: not "failed", since it may still
 * land). A batch that reverted settles too: nothing was bought, and its
 * network fee was spent.
 */
export async function waitForBatch(
  rpc: JsonRpc,
  input: { hash: Hex; batcher: Address; vaults: readonly Address[] },
  options: { timeoutMs: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ receipt: ChainReceipt; result: BatchResult } | null> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  for (;;) {
    // A receipt that can't be read or whose batcher logs can't be joined is
    // not settled yet: the batch was sent, whatever this read says.
    const settled = await readReceipt(rpc, input.hash)
      .then((receipt) => (receipt === null ? null : { receipt, result: batchResultOf(receipt, input) }))
      .catch(() => null);
    if (settled !== null) return settled;
    if (now() >= deadline) return null;
    await sleep(options.everyMs ?? 1_000);
  }
}

// ── Relays ────────────────────────────────────────────────────────────────────

/**
 * Whether the relay is known not to include a transaction that would fail:
 * Flashbots Protect's plain endpoints (rpc.flashbots.net and its `/fast`)
 * and MEV Blocker's `/noreverts`, each exactly, with nothing after it.
 * Options in a query or another path can change that (Protect can be told to
 * fall back to the public mempool, say), so any other form is treated as
 * one that may include it, and then it costs its network fee. Only by
 * address: a relay's own claims can't be read from here.
 */
export function revertProtected(url: string | null): boolean {
  if (url === null) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.port !== "") return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  if (host === "rpc.flashbots.net") return path === "" || path === "/fast";
  return host === "rpc.mevblocker.io" && path === "/noreverts";
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** An estimate, "about 0.00027": two digits. */
const about = (wei: bigint) => ethText(wei, 2);
/** A maximum: three digits, rounded up so it is never shown below itself. */
const atMost = (wei: bigint) => ethText(wei, 3, "up");

/** " (≈ €0.46)", or nothing when the page has no fresh rate: unknown, never zero. ETH and WETH are priced alike. */
function approx(wei: bigint, money: MoneyView | undefined, tail = ""): string {
  const worth = fiatCostText(wei, money);
  return worth === null ? "" : ` (${worth}${tail})`;
}

const buysText = (n: number) => `${formatCount(n)} vault ${n === 1 ? "buy is" : "buys are"}`;

/**
 * The offer's first sentence: the buys offered, and, when that is fewer than
 * were considered (the list below counts every due one), that these are the
 * ones that pay for themselves. `considered` is how many were ticked, and
 * `allTicked` whether that is every due one, which names them "due" rather
 * than "ticked".
 */
export function introText(offered: number, considered = offered, allTicked = true): string {
  const which = allTicked ? "due" : "ticked";
  const lead =
    offered >= considered
      ? `${buysText(offered)} due right now.`
      : `${formatCount(offered)} vault ${offered === 1 ? "buy pays for itself" : "buys pay for themselves"} right now, of the ${formatCount(considered)} ${which}.`;
  return (
    `${lead} Any wallet can make a due buy and is paid its buy fee — ` +
    `that's how vaults keep buying with spDEX closed. You'd make ${offered === 1 ? "it" : "them"} in one transaction.`
  );
}

export function youPayText(fee: bigint, money?: MoneyView): string {
  return `about ${about(fee)} ETH network fee${approx(fee, money, " at today's fees")}`;
}

export function youGetText(earned: bigint, money?: MoneyView): string {
  return (
    `${ethText(earned)} WETH in buy fees${approx(earned, money)}. ` +
    "WETH is ETH as a token; turning it back into ETH costs a network fee too."
  );
}

export const IF_FIRST_TEXT = "Nothing is bought and you get nothing.";

export function ifFirstRelayText(relayUrl: string | null): string {
  return revertProtected(relayUrl)
    ? "Your relay doesn't include a transaction that would fail, so then it costs nothing."
    : "Your relay may still include it, and then it costs its network fee.";
}

export function walletFeeText(maxFee: bigint): string {
  return (
    `Your wallet will show a maximum network fee of up to ${atMost(maxFee)} ETH: each vault is given room to run. ` +
    "You pay only for what's used."
  );
}

export const TERMS_TEXT =
  "Each vault decides the amount, the price floor and who gets the SPX; you only choose when. " +
  "Your address becomes public as the one who made these buys.";

export function buttonText(n: number): string {
  return `Make ${formatCount(n)} ${n === 1 ? "buy" : "buys"} for ${n === 1 ? "this vault" : "these vaults"}`;
}

/** "1 buy due · its buy fee (0.00002 WETH) is below the network fee (≈ 0.0003 ETH). Not offered." */
export function notCoveredText(due: number, fees: bigint, cost: bigint): string {
  return (
    `${formatCount(due)} ${due === 1 ? "buy" : "buys"} due · ${due === 1 ? "its buy fee" : "their buy fees"} ` +
    `(${ethText(fees)} WETH) ${due === 1 ? "is" : "are"} below the network fee (≈ ${about(cost)} ETH). Not offered.`
  );
}

export const NONE_DUE_TEXT = "No vault buy is due right now.";
export const KEEPER_TEXT = "Keep vaults buying while you're away: run a keeper (docs/KEEPER.md in spDEX's source).";

export function noneWouldBuyText(reasons: readonly string[]): string {
  return `No vault buy would go through right now (${reasons.join(", ")}).`;
}

export function needsBalanceText(need: bigint, fee: bigint, balance: bigint): string {
  return (
    `Your wallet needs at least ${atMost(need)} ETH on hand to send this, though only about ${about(fee)} ETH is spent. ` +
    `It holds ${ethText(balance)} ETH.`
  );
}

export function unaccountedText(swept: bigint): string {
  return (
    `The batcher holds ${ethText(swept, 6)} WETH someone sent it, and this batch would pass it to you. ` +
    "spDEX won't make you the receiver of money it can't account for."
  );
}

/**
 * Why a batch needs private sending, in one line; the way to switch it on
 * (a `GoTo` to Settings → Sending) follows it on the panel.
 */
export const PUBLIC_SENDING_TEXT =
  "Needs private sending: sent publicly, bots take these fees first — yours fails and still pays its network fee.";

export const CANT_SIGN_PRIVATELY_TEXT =
  "Your wallet can't sign for private sending, so it can't help run the network. Nothing was sent.";

/** "Made 3 of 3 buys. You received 0.00038 WETH in buy fees. Network fee paid: 0.00021 ETH." */
export function resultText(result: BatchResult): string {
  if (result.status === "reverted") {
    // The receipt says only that it reverted, not why: a vault bought first by
    // someone else is one cause, a price below a floor or a closed vault others.
    return `Nothing was bought, so you received nothing. Someone may have made these buys first.${
      result.fee === null ? "" : ` Network fee paid: ${ethText(result.fee)} ETH.`
    }`;
  }
  const parts = [`Made ${formatCount(result.made)} of ${formatCount(result.of)} ${result.of === 1 ? "buy" : "buys"}.`];
  if (result.earned !== null) parts.push(`You received ${ethText(result.earned)} WETH in buy fees.`);
  if (result.fee !== null) parts.push(`Network fee paid: ${ethText(result.fee)} ETH.`);
  return parts.join(" ");
}
