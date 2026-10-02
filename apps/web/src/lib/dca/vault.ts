/**
 * Auto-buy vaults, as the app uses them: whether one can be offered here, what
 * a vault plan's vault is doing, and the four transactions the owner's wallet
 * signs around it — create (funded in the same transaction), fund, close, and a
 * buy the person triggers themselves.
 *
 * ## Where a vault plan's truth lives
 *
 * On chain. A wallet plan is run by this tab and remembered in this browser's
 * ledger; a vault plan is run by its vault, whoever triggers a due buy, and
 * this browser remembers nothing about it that matters. The
 * config entry points at the vault and describes what the person asked for;
 * the vault says what is actually agreed — its terms are fixed in its code —
 * and what has happened: buys made, what they delivered, what it still holds.
 * So there is no ledger entry and no runner for a vault plan, and every figure
 * below is read from the vault through the user's own endpoint. A figure that
 * cannot be read is unknown (`null`, or a state that says so), never zero: a
 * vault that seems empty because a read failed is still holding someone's
 * money.
 *
 * ## Time is the chain's
 *
 * A vault judges "due" by the timestamp of the block a buy lands in, so a
 * plan's start, its countdowns and whether a buy is due are all worked out in
 * chain time: the latest block's timestamp, carried forward by this device's
 * clock between reads (`chainNow`). Never `Date.now()` alone — a lagging
 * endpoint, and the local fork, can be days away from the wall clock, and a
 * start written in wall-clock time would put the first buy days off.
 *
 * ## Every transaction goes through the Guard
 *
 * The transactions are built here from the plan and fresh reads, and each is
 * checked by the vault Guard (`Engine.checkVault`) before the wallet is asked:
 * the plan may have arrived in a link and the vault's state is a read over the
 * network, and a bug in either looks, at signing, exactly like an attack. The
 * one exception is the factory's one-time deployment, which moves nobody's
 * money; see `deployVaultFactory` for what is checked there instead.
 *
 * Nothing here uses React; the hook (`useAutoBuy.ts`) wires it to the page.
 */

import { NATIVE_TOKEN, isNativeToken, type JsonRpc, type PreparedFees } from "@spdex/chain";
import { DcaPolicySchema, type Address, type DcaPlan, type GuardVerdict, type GuardViolation, type Hex, type SpdexConfig } from "@spdex/core";
import { findVaultNonce, vaultTermsMismatches, type VaultClaim, type VaultTermsMismatch, type VaultTxPlan } from "@spdex/guard";
import {
  DEPLOYMENTS,
  DETERMINISTIC_DEPLOYER,
  KEEPER_MIN_EXECUTE_GAS_LIMIT,
  MAINNET_DEPLOYMENT,
  buyFee,
  decodeVaultError,
  decodeVaultEvent,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  factoryAddress,
  findVaultsByOwner,
  fundingRoom,
  predictVault,
  readVault,
  readVaultNonce,
  simulateFactoryDeployment,
  termsProblems,
  VAULT_LIMITS,
  VAULT_LOGS_FROM_BLOCK,
  vaultAvailability,
  vaultBudget,
  vaultsCreatedBy,
  whyNotNow,
  type BuyFee,
  type FactoryDeployment,
  type OwnerVaults,
  type RawLog,
  type VaultAvailability,
  type VaultPlan,
  type VaultState,
  type VaultTerms,
} from "@spdex/vault";
import type { Engine } from "../engine.js";
import type { TxSender } from "../execute.js";
import { networkLabel } from "../networks.js";
import { confirmTransaction } from "../wallet.js";
import { averagePriceOf, amountText, ethText, formatSignificant, PRICE_DECIMALS, shortAddress, tokenFor } from "./format.js";
import type { StorageLike } from "./ledger.js";
import { cardTitle, compactDuration, dateTime, weekdayClock, type CardStatus } from "./view.js";
import { bpsPercentText, formatCount, formatNumber } from "../money/format.js";
import { formatAmount } from "../tokens.js";

// ── Where vaults are offered ──────────────────────────────────────────────

/**
 * Chains mainnet's factory is offered on: Ethereum, and the local fork of it
 * (690069), which has the same contracts at the same addresses.
 *
 * A list rather than "wherever the deterministic deployer exists", because the
 * factory's markets are addresses on Ethereum: on any other chain its
 * deployment would name contracts that are something else there, or nothing.
 */
export const VAULT_CHAINS: ReadonlySet<number> = new Set([1, 690069]);

/** The factory deployment vaults use on `chainId`, or null where none is offered. */
export function vaultDeployment(chainId: number): FactoryDeployment | null {
  return VAULT_CHAINS.has(chainId) ? MAINNET_DEPLOYMENT : null;
}

/** The one market every vault buys on: WETH → SPX, index 0 in the factory's list. */
export const VAULT_MARKET_INDEX = 0n;

// ── Chain time ────────────────────────────────────────────────────────────

/** The chain's clock as last read. */
export interface ChainClock {
  /** The next block's timestamp as the endpoint expects it, or the latest block's (`readChainClock`), unix seconds. */
  seconds: number;
  /** When that was read, by this device's clock (ms). */
  readAtMs: number;
}

const blockTime = (block: unknown): number | null => {
  const timestamp = (block as { timestamp?: unknown } | null)?.timestamp;
  return typeof timestamp === "string" && /^0x[0-9a-fA-F]+$/.test(timestamp) ? Number(BigInt(timestamp)) : null;
};

/**
 * The chain's time now: the pending block's timestamp, or the latest block's
 * where the endpoint won't give a pending one. Throws when it gives neither:
 * unknown, not zero.
 *
 * Pending first, because the latest block's time runs behind whenever the
 * chain is idle. A block is stamped when it is made, so after a quiet spell
 * the next one carries a time well past the last — six minutes on an idle
 * local fork, about twelve seconds on Ethereum. A start written as "latest +
 * 5 minutes" would then be due the moment its vault was mined, and every
 * countdown would overstate the wait by the idle gap. The pending block is
 * stamped with the time the endpoint would give the next block now; an
 * endpoint that has none answers null or an error, and the latest block is
 * the honest fallback.
 */
export async function readChainClock(rpc: JsonRpc, nowMs: number = Date.now()): Promise<ChainClock> {
  const read = (tag: "pending" | "latest") =>
    Promise.resolve()
      .then(() => rpc("eth_getBlockByNumber", [tag, false]))
      .then(blockTime, () => null);
  const [pending, latest] = await Promise.all([read("pending"), read("latest")]);
  // Never behind the latest block: a pending block older than it is some
  // endpoint's stale view, not the chain's time.
  const seconds = pending !== null && (latest === null || pending >= latest) ? pending : latest;
  if (seconds === null) throw new Error("the endpoint did not report the chain's time");
  return { seconds, readAtMs: nowMs };
}

/**
 * Chain time now, in unix seconds: the clock as read, carried forward by how
 * long ago that was on this device.
 *
 * The device's clock only measures the time since the read, never the time
 * itself, so a device and a chain days apart still agree on "in 3 minutes".
 * It is an estimate between reads — on an idle local fork no block is made
 * until a transaction arrives, and the vault judges by the block a buy lands
 * in — and each read resets it.
 */
export function chainNow(clock: ChainClock, nowMs: number): number {
  return clock.seconds + Math.max(0, Math.floor((nowMs - clock.readAtMs) / 1000));
}

/**
 * A vault plan's `startAt`, in chain time.
 *
 * The form works in this device's time — "now", or a moment the person
 * picked — and the vault in the chain's. What carries over is how far ahead
 * the first buy was asked for; anything not ahead is now.
 */
export function vaultStartAt(requestedSeconds: number, deviceNowSeconds: number, chainNowSeconds: number): number {
  const ahead = requestedSeconds - deviceNowSeconds;
  return ahead > 0 ? chainNowSeconds + ahead : chainNowSeconds;
}

// ── The terms a vault is created with ─────────────────────────────────────

/**
 * How far below the price reference a vault's buy may pay, as the form offers
 * it: 1%, 2% or 3%.
 *
 * The same kind of allowance a scheduled buy's slippage is, and bounded the
 * same way (`MAX_SCHEDULED_SLIPPAGE_BPS` is 3%): it is what a keeper who
 * trades around the buy can take, every buy. The contract allows up to 5%;
 * the form does not offer that, because nobody watches these buys.
 */
export const VAULT_SLIPPAGE_CHOICES = [100, 200, 300] as const;

/**
 * 2%: loose enough that ordinary movement between the pool the floor is read
 * from and the pair the buy trades on does not hold buys up, and still well
 * inside what a scheduled buy may lose.
 */
export const DEFAULT_VAULT_SLIPPAGE_BPS = 200;

/** What a vault holds that a plan has no field for. */
export interface VaultChoices {
  /** Basis points; one of `VAULT_SLIPPAGE_CHOICES` from the form. */
  maxSlippageBps: number;
  /** Wei of WETH paid to whoever triggers each buy. */
  keeperReward: bigint;
}

/** The terms `createVault` takes for a plan: its figures, plus the market and the two choices. */
export function vaultPlanOf(
  plan: Pick<DcaPlan, "amountPerBuy" | "intervalSeconds" | "maxBuys" | "startAt">,
  choices: VaultChoices,
): VaultPlan {
  return {
    marketIndex: VAULT_MARKET_INDEX,
    amountPerBuy: BigInt(plan.amountPerBuy),
    interval: BigInt(plan.intervalSeconds),
    maxBuys: BigInt(plan.maxBuys),
    startAt: BigInt(plan.startAt),
    keeperReward: choices.keeperReward,
    maxSlippageBps: BigInt(choices.maxSlippageBps),
  };
}

/** The most that can go into a vault, `MAX_FUNDING` in VaultLimits.sol: 0.5 ETH. */
export const VAULT_CAP_WEI = 5n * 10n ** 17n;

/** "0.5 ETH" ("0,5 ETH" in German): the vault's cap, in the page's number format. */
export function vaultCapText(): string {
  return `${formatAmount(VAULT_CAP_WEI, 18)} ETH`;
}

/**
 * The factory's refusals of a plan's terms, in words that say what to change.
 * Written when asked for, so their figures follow the page's number format,
 * which is set after this module loads.
 */
function termsProblemText(name: string): string | undefined {
  switch (name) {
    case "UnknownMarket":
      return "spDEX's vault factory has no market for this token.";
    case "AmountOutOfRange":
      return `Each buy must be more than 0 and at most ${vaultCapText()}.`;
    case "IntervalOutOfRange":
      return "A vault buys at most every 5 minutes, and at least once every 366 days.";
    case "BuysOutOfRange":
      return `Choose between 1 and ${formatCount(1_000)} buys.`;
    case "SlippageOutOfRange":
      return "The price allowance must be more than 0% and at most 5%.";
    case "RewardTooLarge":
      return `The buy fee can be at most ${bpsPercentText(Number(VAULT_LIMITS.MAX_REWARD_BPS))}% of the buy.`;
    case "FundingCapExceeded":
      return `You can put at most ${vaultCapText()} into a vault: every buy plus its buy fee. Buy less each time, or fewer times.`;
    case "StartOutOfRange":
      return "The first buy must be within a year of now.";
    case "FundingExceedsNeed":
      return "That's more than the plan's whole budget.";
    default:
      return undefined;
  }
}

/**
 * The least a vault buy may be: 0.000001 ETH. The factory takes any amount
 * above zero, but the buy fee is a share of the buy, and under 60 wei it
 * rounds to nothing: a vault that pays nobody to trigger it. The floor sits
 * well above that, at a figure a person can read, and far below any buy worth
 * making; the form's notes say where buys stop being worth a keeper's while.
 */
export const MIN_VAULT_BUY_WEI = 10n ** 12n;

/**
 * Everything that would stop this plan becoming a vault, as sentences, or
 * `[]`: that it pays with ether and buys the vault's token, that each buy is
 * large enough to pay a buy fee (`MIN_VAULT_BUY_WEI`, spDEX's own floor), and
 * every term the factory checks (`termsProblems`, judged at chain time
 * `chainNowSeconds`). For the form, before anyone pays gas to hear the
 * factory say it, and for a creation from a card, whose plan may have come in
 * a link.
 */
export function vaultPlanProblems(
  plan: Pick<DcaPlan, "sell" | "buy" | "amountPerBuy" | "intervalSeconds" | "maxBuys" | "startAt">,
  choices: VaultChoices,
  chainNowSeconds: number,
  deployment: FactoryDeployment = MAINNET_DEPLOYMENT,
): string[] {
  const problems: string[] = [];
  if (!isNativeToken(plan.sell)) problems.push("A vault pays with ETH only.");
  if (plan.buy.toLowerCase() !== deployment.markets[0]!.tokenOut.toLowerCase()) problems.push("A vault buys SPX only.");
  let terms: VaultPlan;
  try {
    terms = vaultPlanOf(plan, choices);
  } catch {
    return [...problems, "The plan's figures aren't whole numbers."];
  }
  // Zero is the factory's to refuse, in its own words (`AmountOutOfRange`).
  if (terms.amountPerBuy > 0n && terms.amountPerBuy < MIN_VAULT_BUY_WEI) {
    problems.push("Each buy must be at least 0.000001 ETH so it can pay a buy fee.");
  }
  for (const name of termsProblems(terms, BigInt(chainNowSeconds), deployment)) {
    problems.push(termsProblemText(name) ?? `The vault factory would refuse these terms (${name}).`);
  }
  return problems;
}

// ── What a vault costs ────────────────────────────────────────────────────

/**
 * Gas each of the owner's vault transactions uses, rounded up from real
 * transactions on the fork (`packages/vault`'s integration test and its gas
 * report): creating is 175,446 and creating with the budget about 214,650
 * (187,209 before the factory kept a list of its vaults, plus the 27,440 the
 * list and `VaultCreated`'s `funded` add); funding 54,447; closing 52,484.
 *
 * Trigger now, a buy sent on its own, from @spdex/vault's measurements on a
 * busy oracle pool, the usual case for SPX on mainnet (`EXECUTE_GAS`'s
 * comment): a vault's first buy, which writes the most slots from zero, about
 * 300,300, and a later one about 70,000 less. A quiet pool costs about 53,000
 * less again (248,153 for a first buy on the fork). Not `EXECUTE_GAS`, which
 * sizes a gas limit: quoted as what a buy costs, it overstated a later buy by
 * a third, and said triggering cost more than its buy fee when it didn't.
 *
 * Estimates for a cost line, never a limit: the wallet sets each
 * transaction's own.
 */
export const VAULT_GAS = {
  create: 180_000n,
  createAndFund: 220_000n,
  fund: 55_000n,
  close: 53_000n,
  firstTrigger: 300_000n,
  trigger: 230_000n,
} as const;

/**
 * What a block would charge per gas right now: base fee plus tip.
 * `readWalletFees` (lib/fees.ts) bids `2 × baseFee + tip`, so the base fee is
 * recovered from its figures:
 * what a transaction sent now would pay, which is what the cost lines quote.
 */
export function feePerGasNow(fees: PreparedFees): bigint {
  if (fees.type === "legacy") return fees.gasPrice;
  return (fees.maxFeePerGas - fees.maxPriorityFeePerGas) / 2n + fees.maxPriorityFeePerGas;
}

export interface VaultCosts {
  /**
   * The buy fee each buy pays whoever triggers it (`buyFee`): one batched
   * buy's network cost and a tenth more, never above 0.69% of the buy. It
   * depends only on the amount and this release, so it is known before any
   * fee is read.
   */
  fee: BuyFee;
  /** Every buy fee the plan will pay: `maxBuys × fee.reward`. */
  rewardsTotal: bigint;
  /** What creating and funding the vault sends: every buy and its buy fee, `vaultBudget`. */
  budget: bigint;
  /**
   * About what creating and funding costs in gas at today's fees, wei: an
   * estimate. Null until current fees are read, the only figure here that
   * waits for them.
   */
  createFee: bigint | null;
}

/**
 * The figures the vault choice card shows: each buy's fee, in ETH and as a
 * share of the buy, the budget the creation sends, and roughly what creating
 * costs in gas once fees are read. Null for figures that don't make a plan
 * yet.
 */
export function vaultCosts(input: { amountPerBuy: bigint; maxBuys: number; fees: PreparedFees | null }): VaultCosts | null {
  if (input.amountPerBuy <= 0n || !Number.isSafeInteger(input.maxBuys) || input.maxBuys < 1) return null;
  const fee = buyFee(input.amountPerBuy);
  const maxBuys = BigInt(input.maxBuys);
  return {
    fee,
    rewardsTotal: maxBuys * fee.reward,
    budget: vaultBudget({ maxBuys, amountPerBuy: input.amountPerBuy, keeperReward: fee.reward }),
    createFee: input.fees === null ? null : VAULT_GAS.createAndFund * feePerGasNow(input.fees),
  };
}

// ── Can a vault be offered here? ──────────────────────────────────────────

export type VaultSupport =
  /** Not a chain vaults are offered on. */
  | { kind: "unsupported"; reason: string }
  /** The factory is deployed and its market healthy: a vault can be created, and would buy. */
  | { kind: "available"; factory: Address; availability: VaultAvailability }
  /** The factory isn't deployed yet, and its deployment would succeed: one transaction anyone can send. */
  | { kind: "deployable"; factory: Address; reason: string; availability: VaultAvailability }
  /** Something else is in the way, or couldn't be checked; `reason` says which. */
  | { kind: "unavailable"; factory: Address | null; reason: string; availability: VaultAvailability | null };

const sentence = (text: string): string => {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed.length === 0 ? "" : `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}.`;
};

/** How `vaultAvailability`'s answer reads to the form. */
export function vaultSupportFrom(chainId: number, availability: VaultAvailability): VaultSupport {
  if (vaultDeployment(chainId) === null) return unsupported(chainId);
  const { factory } = availability;
  if (availability.available) return { kind: "available", factory, availability };
  const reason = availability.reasons.map(sentence).join(" ") || "Vaults can't be offered right now.";
  // The deployment's own simulation ran the listing checks, which are the
  // market's health as the factory judges it; a health read that failed
  // besides is not a reason to withhold it.
  if (availability.factoryDeployed === false && availability.factoryDeployable === true) {
    return { kind: "deployable", factory, reason, availability };
  }
  return { kind: "unavailable", factory, reason, availability };
}

const unsupportedReason = (chainId: number): string =>
  `Vaults aren't offered on ${networkLabel(chainId)}: spDEX's vault factory buys on Ethereum's SPX market only.`;

const unsupported = (chainId: number): VaultSupport => ({ kind: "unsupported", reason: unsupportedReason(chainId) });

/** Whether a vault can be offered on `chainId` right now: the factory, and the health of its market. */
export async function readVaultSupport(rpc: JsonRpc, chainId: number): Promise<VaultSupport> {
  const deployment = vaultDeployment(chainId);
  if (deployment === null) return unsupported(chainId);
  try {
    return vaultSupportFrom(chainId, await vaultAvailability(rpc, { deployment, marketIndex: Number(VAULT_MARKET_INDEX) }));
  } catch (error) {
    return {
      kind: "unavailable",
      factory: null,
      reason: `spDEX couldn't check whether a vault can be offered: ${messageOf(error)}`,
      availability: null,
    };
  }
}

// ── A vault plan's vault, as the card shows it ────────────────────────────

/** A vault's figures, all from the chain at one block. */
export interface VaultFigures {
  vault: Address;
  owner: Address;
  /** Whether the connected account owns it; null with no wallet connected. */
  mine: boolean | null;
  /** The vault's own terms: what is actually agreed. */
  terms: VaultTerms;
  closed: boolean;
  buysDone: number;
  maxBuys: number;
  buysLeft: number;
  /** WETH (wei) the buys have spent: exactly `buysDone × amountPerBuy`, every buy being that size. */
  spent: bigint;
  /** What the buys delivered to the owner, raw units of the token, measured at the owner. */
  received: bigint;
  /** WETH (wei) paid to keepers so far. */
  rewardsPaid: bigint;
  /** WETH (wei) the vault holds. */
  balance: bigint;
  /** Whether that covers the next buy and its buy fee. */
  funded: boolean;
  /** The most funding would add right now (`fundingRoom`); 0 when the vault holds what its buys need. */
  fundingRoom: bigint;
  /** Every check a buy makes but the price floor passes now (`status().due`). */
  due: boolean;
  /** When the next buy may happen by the clock alone, chain time; null when none will. */
  nextBuyAt: number | null;
  /** A buy triggered now would go through, as far as a read can tell (`whyNotNow` is null). */
  canTrigger: boolean;
  /** Why it would not, in words, or null. */
  waitingFor: string | null;
  /** What a buy would deliver now and the least it may; null when the price reference can't answer. */
  quote: VaultState["quote"];
  /** The block time these figures describe, with the device time they were read at, for countdowns. */
  clock: ChainClock | null;
  /** Where the vault's terms differ from the plan in the config; empty when they agree. */
  mismatches: VaultTermsMismatch[];
  /** Whether the factory says it made this vault; null when it wasn't asked or didn't answer. */
  fromFactory: boolean | null;
}

export type VaultPlanState =
  /** Not read yet. */
  | { kind: "loading" }
  /**
   * Nothing can be said about the vault: the plan is for another chain, vaults
   * aren't offered on this one, the read failed, the factory didn't say
   * whether it made the vault, or the address holds no vault from spDEX's
   * factory. `reason` is a sentence; `detail` the raw error, for Details.
   */
  | {
      kind: "unavailable";
      code: "chain" | "unsupported" | "unreadable" | "unconfirmed" | "not-a-vault";
      reason: string;
      detail?: string;
    }
  /** The plan has no vault yet: nothing is bought until it is created. `note` says what happened to an earlier attempt. */
  | { kind: "not-created"; note: string | null }
  /**
   * A creation is under way, or was sent (or may have been) and hasn't been
   * seen on chain yet. `vault` is where it will land, once worked out.
   */
  | { kind: "creating"; vault: Address | null; hash: Hex | null }
  /** The vault, owned by the connected account (`mine: true`), or by an account unknown until a wallet connects. */
  | ({ kind: "active" } & VaultFigures)
  /** Someone else's vault, from their link: shown, never funded or closed from here. */
  | ({ kind: "someone-else" } & VaultFigures);

/**
 * What a read of a plan's vault means for its card. Pure: `read` is what
 * `readVault` returned (null: the address doesn't answer like a vault).
 */
export function vaultPlanState(input: {
  plan: DcaPlan;
  account: Address | null;
  read: VaultState | null;
  readAtMs: number;
}): VaultPlanState {
  const { plan, read } = input;
  const vault = (plan.vault ?? "").toLowerCase();
  if (read === null) {
    return {
      kind: "unavailable",
      code: "not-a-vault",
      reason: `There's no vault at ${vault}: nothing there answers like one. spDEX won't send anything to it.`,
    };
  }
  if (read.fromFactory === false) {
    return {
      kind: "unavailable",
      code: "not-a-vault",
      reason: `${vault} isn't a vault spDEX's factory made, so spDEX won't send anything to it or trust what it says.`,
    };
  }
  // Only the factory's yes is trusted. It answers nothing when it has no code
  // (Multicall3 reads a call to an empty address as "0x"), which is every
  // chain it hasn't been deployed on yet — and there any contract that answers
  // a vault's views, with `owner()` naming whoever looks, would otherwise be
  // shown as their funded, due vault. Its figures are that contract's claims,
  // so none is shown until the factory vouches for it.
  if (read.fromFactory !== true) {
    return {
      kind: "unavailable",
      code: "unconfirmed",
      reason: `spDEX can't confirm that its vault factory made ${vault}: the factory didn't answer. Until it does, spDEX shows none of its figures and sends nothing to it.`,
    };
  }
  const owner = read.owner;
  const mine = input.account === null ? null : input.account.toLowerCase() === owner;
  const why = vaultWaitReason(read, input.readAtMs);
  const figures: VaultFigures = {
    vault: read.address,
    owner,
    mine,
    terms: read.terms,
    closed: read.closed,
    buysDone: Number(read.buysDone),
    maxBuys: Number(read.terms.maxBuys),
    buysLeft: Number(read.status.buysLeft),
    spent: read.buysDone * read.terms.amountPerBuy,
    received: read.totalOut,
    rewardsPaid: read.totalRewards,
    balance: read.status.wethBalance,
    funded: read.status.funded,
    fundingRoom: read.closed ? 0n : fundingRoom(read),
    due: read.status.due,
    nextBuyAt: read.status.nextBuyAt === null ? null : Number(read.status.nextBuyAt),
    canTrigger: why === null,
    waitingFor: why,
    quote: read.quote,
    clock: read.chainTime === null ? null : { seconds: Number(read.chainTime), readAtMs: input.readAtMs },
    mismatches: vaultTermsMismatches(plan, read.terms),
    fromFactory: read.fromFactory,
  };
  return mine === false ? { kind: "someone-else", ...figures } : { kind: "active", ...figures };
}

/**
 * Why a buy triggered now would not go through, as a sentence for the card,
 * or null when a read says it would.
 *
 * Whether is `whyNotNow`'s (@spdex/vault) to say, as it is for Trigger now;
 * this only says why in words a person reads. `whyNotNow` words it for a
 * log — an ISO timestamp in chain time,
 * "its oracle pool is too thin" — and those words reached the card as they
 * were. The cases are its own, in its order. A moment is shown in this
 * device's clock (`deviceTimeOf`), as every other time on the card is.
 */
export function vaultWaitReason(read: VaultState, readAtMs: number): string | null {
  if (whyNotNow(read) === null) return null;
  if (read.closed) return "It's closed.";
  if (read.status.buysLeft === 0n) return "Every buy is done.";
  if (!read.status.funded) return "It doesn't hold enough for its next buy and its buy fee.";
  const next = read.status.nextBuyAt;
  if (next === null) return "No buy is due.";
  const waitingForTheClock = read.chainTime === null ? !read.status.due : next > read.chainTime;
  if (waitingForTheClock) {
    return read.chainTime === null
      ? "Its next buy isn't due yet."
      : `Its next buy isn't due until ${dateTime(deviceTimeOf(Number(next), Number(read.chainTime), readAtMs) * 1000)}.`;
  }
  if (read.quote === null) return "The 10-minute average price can't be read right now, so the vault won't buy.";
  if (read.quote.oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH) {
    return "The market the price is checked against is too thin right now, so the vault won't buy.";
  }
  if (read.quote.spotOut < read.quote.floorOut) {
    const shortBps = ((read.quote.floorOut - read.quote.spotOut) * 10_000n) / read.quote.floorOut;
    const percent = formatNumber(Number(shortBps) / 100, { maximumFractionDigits: 2 });
    return `The price is ${percent}% outside this vault's allowance right now, so the buy waits for the market.`;
  }
  return "No buy is due.";
}

/** Read a plan's vault, as its card shows it. Never throws: a failure is a state that says so. */
export async function readVaultPlan(
  rpc: JsonRpc,
  input: { plan: DcaPlan; chainId: number; account: Address | null; factory: Address; nowMs?: number },
): Promise<VaultPlanState> {
  const { plan } = input;
  if (plan.chainId !== input.chainId) {
    return {
      kind: "unavailable",
      code: "chain",
      reason: `This vault is on ${networkLabel(plan.chainId)}; spDEX is on ${networkLabel(input.chainId)} now.`,
    };
  }
  if (vaultDeployment(input.chainId) === null) {
    return { kind: "unavailable", code: "unsupported", reason: unsupportedReason(input.chainId) };
  }
  if (plan.vault === undefined) return { kind: "not-created", note: null };
  try {
    const read = await readVault(rpc, plan.vault.toLowerCase() as Address, { factory: input.factory });
    return vaultPlanState({ plan, account: input.account, read, readAtMs: input.nowMs ?? Date.now() });
  } catch (error) {
    // The endpoint's own words go to Details: a rate-limit page or a proxy's
    // error comes back as a JSON parse error, which says nothing to a person.
    return {
      kind: "unavailable",
      code: "unreadable",
      reason: "spDEX couldn't read this vault from your network service right now. It tries again every 30 seconds; until then, what the vault holds is unknown.",
      detail: messageOf(error),
    };
  }
}

// ── The card's pill and line ──────────────────────────────────────────────

/** Which of its states a vault plan's card is in. */
export type VaultRow =
  | "loading"
  | "unavailable"
  | "not-created"
  | "creating"
  | "mismatch"
  | "closed"
  | "done"
  | "unfunded"
  | "due"
  | "waiting-price"
  | "waiting"
  | "theirs";

/** A vault plan's card status: the tab plans' shape (`row: "vault"`), plus which vault state it is. */
export interface VaultCardStatus extends CardStatus {
  row: "vault";
  vault: VaultRow;
  /** Unix seconds, chain time, of the next buy by the clock; null when there is none to count down to. */
  nextBuyAt: number | null;
}

/** "1 buy", "3 buys". */
const buysText = (n: number): string => `${formatCount(n)} ${n === 1 ? "buy" : "buys"}`;

const vaultStatus = (vault: VaultRow, rest: Omit<VaultCardStatus, "row" | "vault" | "nextBuyAt"> & { nextBuyAt?: number | null }): VaultCardStatus => ({
  row: "vault",
  vault,
  nextBuyAt: null,
  ...rest,
});

/**
 * A vault plan's pill and reason line, first match — the vault's own facts
 * before anything about timing, since a closed or mismatched vault's next buy
 * is not the news. `chainNowSeconds` is `chainNow` of the vault's clock.
 *
 * "Due" is the plan working as agreed: a keeper is expected to trigger it, so
 * it is not the person's turn and the pill stays "running". The line says the
 * person may trigger it, and that its buy fee then comes back to them.
 */
export function vaultCardStatus(state: VaultPlanState, chainNowSeconds: number | null): VaultCardStatus {
  switch (state.kind) {
    case "loading":
      return vaultStatus("loading", { pill: "paused", pillLabel: "Checking", reason: "Reading the vault from the network…" });
    case "unavailable":
      return vaultStatus("unavailable", { pill: "attention", reason: state.reason });
    case "not-created":
      return vaultStatus("not-created", {
        pill: "action",
        pillLabel: "Create vault",
        reason: state.note ?? "The vault hasn't been created yet, so nothing is bought. Create it to start.",
      });
    case "creating":
      return vaultStatus("creating", {
        pill: "running",
        pillLabel: "Creating",
        reason: "Creating the vault — waiting for the network to confirm it.",
      });
    default:
      break;
  }
  const count = (n: number) => formatCount(n);
  if (state.kind === "someone-else") {
    return vaultStatus("theirs", {
      pill: state.closed || state.buysLeft === 0 ? "done" : "running",
      pillLabel: state.closed ? "Closed" : state.buysLeft === 0 ? "Done" : "Not yours",
      reason: `This vault belongs to ${state.owner}. You can watch it here; only its owner can fund or close it.`,
      // Only a buy that can happen has a time: an unfunded or finished vault
      // is not "due now", whatever its clock says.
      nextBuyAt: state.closed || !state.funded || state.buysLeft === 0 ? null : state.nextBuyAt,
    });
  }
  if (state.closed) {
    return vaultStatus("closed", {
      pill: "done",
      pillLabel: "Closed",
      reason: `Closed after ${count(state.buysDone)} of ${buysText(state.maxBuys)}: what it held went back to ${state.mine === true ? "your wallet" : "its owner"}.`,
    });
  }
  if (state.mismatches.length > 0) {
    return vaultStatus("mismatch", {
      pill: "attention",
      reason: `The vault's terms differ from this plan (${state.mismatches.map((m) => MISMATCH_WORDS[m.field]).join(", ")}). The vault's are what it follows; spDEX won't fund it or trigger its buys from this plan.`,
    });
  }
  if (state.buysLeft === 0) {
    return vaultStatus("done", {
      pill: "done",
      reason:
        state.balance > 0n
          ? `Finished: ${count(state.buysDone)} of ${count(state.maxBuys)} bought. It still holds some WETH — close it to take that back.`
          : `Finished: ${count(state.buysDone)} of ${count(state.maxBuys)} bought.`,
    });
  }
  if (!state.funded) {
    return vaultStatus("unfunded", {
      pill: "action",
      pillLabel: "Needs funding",
      reason: "The vault can't cover its next buy and its buy fee. Fund it to go on.",
      nextBuyAt: state.nextBuyAt,
    });
  }
  const clockSaysDue = state.nextBuyAt !== null && chainNowSeconds !== null && chainNowSeconds >= state.nextBuyAt;
  if (state.canTrigger) {
    return vaultStatus("due", {
      pill: "running",
      pillLabel: "Buy due",
      reason: "The next buy is due — waiting for a keeper. You can trigger it yourself; its buy fee comes back to you.",
      nextBuyAt: state.nextBuyAt,
    });
  }
  if (state.due || clockSaysDue) {
    // Due by the clock, and something a moment can change stands in the way
    // (the price, or the price reference's depth); or due by the clock carried
    // forward and not yet by the latest block.
    return vaultStatus("waiting-price", {
      pill: "running",
      reason: state.waitingFor,
      nextBuyAt: state.nextBuyAt,
    });
  }
  return vaultStatus("waiting", { pill: "running", reason: null, nextBuyAt: state.nextBuyAt });
}

const MISMATCH_WORDS: Record<VaultTermsMismatch["field"], string> = {
  sell: "what it pays with",
  buy: "what it buys",
  amountPerBuy: "the amount per buy",
  intervalSeconds: "how often",
  maxBuys: "how many buys",
  startAt: "when it starts",
};

// ── The card's figures ────────────────────────────────────────────────────

/**
 * A moment in chain time as this device's clock would read it: the gap to
 * chain time now, carried over. For showing a time — "Tue 14:05" — to a
 * person whose clock may be days from the chain's (the local fork's is).
 */
export function deviceTimeOf(chainSeconds: number, chainNowSeconds: number, nowMs: number): number {
  return Math.floor(nowMs / 1000) + (chainSeconds - chainNowSeconds);
}

/**
 * The big "Next buy" figure and its hint, as `nextBuyStat` gives a tab plan's:
 * a countdown in chain time, and the moment it names in this device's time.
 * `value: null` reads "unknown"; "—" is no next buy to count down to.
 */
export function vaultNextBuyStat(
  status: VaultCardStatus,
  chainNowSeconds: number | null,
  nowMs: number,
): { value: string | null; hint: string | null } {
  switch (status.vault) {
    case "loading":
    case "unavailable":
      return { value: null, hint: null };
    case "not-created":
      return { value: "Not created", hint: null };
    case "creating":
      return { value: "After creation", hint: null };
    case "closed":
      return { value: "Closed", hint: null };
    case "done":
      return { value: "Done", hint: null };
    case "unfunded":
      return { value: "After funding", hint: null };
    case "due":
      return { value: "Due now", hint: "waiting for a keeper" };
    default:
      break;
  }
  if (status.nextBuyAt === null || chainNowSeconds === null) return { value: status.nextBuyAt === null ? "—" : null, hint: null };
  const left = (status.nextBuyAt - chainNowSeconds) * 1000;
  // A time already past is no news: someone else's due vault waits for a
  // keeper as the owner's does, and one waiting on the price says so in its
  // line.
  if (left <= 0) return { value: "Due now", hint: status.vault === "theirs" ? "waiting for a keeper" : null };
  return { value: compactDuration(left), hint: weekdayClock(deviceTimeOf(status.nextBuyAt, chainNowSeconds, nowMs)) };
}

/**
 * The progress bar's figures: buys made of the most, and what they spent of
 * the budget — exact, every buy being the same size. From the vault, never
 * from this browser.
 */
export function vaultProgress(state: VaultFigures): { value: number; valueText: string } {
  const count = (n: number) => formatCount(n);
  const spent = ethText(state.spent, 6);
  const budget = ethText(state.terms.amountPerBuy * BigInt(state.maxBuys), 6);
  return { value: state.buysDone, valueText: `${count(state.buysDone)} of ${count(state.maxBuys)} buys · ${spent} of ${budget} ETH` };
}

/** "Bought": everything the vault delivered to its owner, measured at the owner; "none yet" before a buy. */
export function vaultBoughtStat(state: VaultFigures): string {
  if (state.buysDone === 0) return "none yet";
  return amountText(state.received, state.terms.tokenOut, undefined, "rounded");
}

/**
 * "Average rate": "1 ETH = 1,307.85 SPX", from the vault's own totals — what
 * the buys spent and what arrived — before buy fees. "—" before the
 * first buy.
 */
export function vaultAverageStat(state: VaultFigures): string {
  const buy = tokenFor(state.terms.tokenOut);
  if (buy === undefined || state.buysDone === 0) return "—";
  const average = averagePriceOf(
    {
      buysDone: state.buysDone,
      committed: state.spent.toString(),
      measured: { buys: state.buysDone, amountIn: state.spent.toString(), amountOut: state.received.toString() },
      runs: [],
    },
    18,
    buy.decimals,
  );
  if (average === null || average.buyPerSell === null) return "—";
  return `1 ETH = ${formatSignificant(average.buyPerSell, PRICE_DECIMALS, 6)} ${buy.symbol}`;
}

/**
 * Every release's batcher, lowercase: the contract a keeper calls to make
 * many vaults' buys in one transaction, which is then the `keeper` a vault's
 * `Bought` names. The one bound to the factory this app uses,
 * `MAINNET_BATCHER`, is `DEPLOYMENTS`' last entry: `build-artifacts --check`
 * refuses a registry that doesn't end with this build, and the vault
 * package's tests hold the two equal.
 */
const BATCHERS: ReadonlySet<string> = new Set(DEPLOYMENTS.map((d) => d.batcher.toLowerCase()));

/**
 * A history row's sentence. `account` is the connected wallet, so a buy it
 * triggered says "you"; one a batcher triggered says "in a batch", since its
 * address would name a contract rather than whoever sent it; and the buy fee
 * is paid as WETH, and says so.
 */
export function vaultHistorySentence(entry: VaultHistoryEntry, terms: Pick<VaultTerms, "tokenOut">, account: Address | null): string {
  const weth = MAINNET_DEPLOYMENT.weth;
  switch (entry.kind) {
    case "bought": {
      const keeper = entry.keeper?.toLowerCase();
      const batch = keeper !== undefined && BATCHERS.has(keeper);
      const you = keeper !== undefined && account !== null && keeper === account.toLowerCase();
      const by = keeper === undefined ? "" : batch ? " · triggered in a batch" : ` · triggered by ${you ? "you" : shortAddress(keeper)}`;
      // The fee says whom the vault paid: a bare "paid 0.0004 WETH" read as
      // money received beside "by you", and as money spent beside "in a
      // batch", though it is the same payment either way.
      const payee = keeper === undefined ? "" : batch ? " the keeper" : you ? " you" : " them";
      const paid =
        entry.reward === undefined || entry.reward === 0n
          ? ""
          : `, paid${payee} its ${amountText(entry.reward, weth, undefined, "rounded")} buy fee`;
      return `Bought ${amountText(entry.amountOut ?? null, terms.tokenOut, undefined, "rounded")} for ${amountText(entry.amountIn ?? null, weth, undefined, "rounded").replace(/ WETH$/, " ETH")}${by}${paid}`;
    }
    case "funded":
      return `Funded with ${ethText(entry.amount ?? 0n, 6)} ETH`;
    case "closed":
      return `Closed: ${ethText(entry.amount ?? 0n, 6)} ETH sent back to its owner`;
  }
}

/**
 * What to say before a vault plan is deleted from this browser's list, or
 * null when nothing is at stake. Deleting the plan only forgets it: the vault
 * keeps what it holds and goes on buying whenever triggered. A vault the
 * connected wallet owns moves to "Vaults on chain not in your plans" at once
 * (`foundFromPlan`), and the warning says so, since otherwise it seems to
 * vanish. After this page, though, the only way back to it from spDEX is a
 * search of the chain for the owner's vaults (`searchAccountVaults`), which
 * reaches only as far back as the network service lets it, so the warning
 * says that rather than promising it.
 */
export function vaultRemovalWarning(state: VaultPlanState | undefined): string | null {
  if (state === undefined || state.kind === "loading" || state.kind === "unavailable") {
    return "spDEX can't read this vault right now, so it can't tell whether it still holds money. Deleting the plan only forgets it here: the vault stays on chain, and spDEX can find it again only by searching the chain for your vaults, as far back as your network service allows.";
  }
  if (state.kind === "creating") {
    return "The vault's creation hasn't confirmed yet. Deleting the plan now leaves a vault spDEX can find only by searching the chain for your vaults.";
  }
  if (state.kind !== "active") return null;
  if (state.closed || (state.balance === 0n && state.buysLeft === 0)) return null;
  const after =
    state.mine === true
      ? "It moves to \"Vaults on chain not in your plans\" below, where you can still close it; after you leave this page, spDEX finds it again only by searching the chain for your vaults, as far back as your network service allows."
      : "Once the plan is gone, spDEX can find the vault only by searching the chain for your vaults, as far back as your network service allows.";
  return state.balance > 0n
    ? `This vault still holds WETH and will go on buying whenever anyone triggers it. Deleting the plan only forgets it here — close it first to take its money back. ${after}`
    : `This vault isn't closed. Deleting the plan only forgets it here: it stays on chain. ${after}`;
}

// ── Vaults on chain no plan points at ─────────────────────────────────────

/**
 * The id a vault gets when it is added back to the plans: from its address,
 * so the same vault can't be added twice. A second click, or a second tab,
 * is refused as a plan that already exists rather than making two cards that
 * point at one vault.
 */
export function vaultPlanId(vault: Address): string {
  return `vault-${vault.toLowerCase().slice(2, 12)}`;
}

/**
 * The plan a vault on chain describes: what "Add back to my plans" writes, and
 * what closing it is checked against, since the vault Guard holds every vault
 * transaction to a plan that points at its vault.
 *
 * Every figure is the vault's own. Its terms are fixed in its code, so a plan
 * rebuilt from them agrees with the vault by construction, and its card shows
 * no difference. It is paused, as every vault plan is, because its vault runs
 * it rather than this tab. Two things a vault holds have no field in a plan
 * (the price allowance and the buy fee); the card reads both from the
 * vault, as it does for any vault plan.
 */
export function planFromVault(input: { vault: Address; terms: VaultTerms; chainId: number }): DcaPlan {
  return {
    id: vaultPlanId(input.vault),
    paused: true,
    chainId: input.chainId,
    sell: NATIVE_TOKEN,
    buy: lower(input.terms.tokenOut),
    amountPerBuy: input.terms.amountPerBuy.toString(),
    intervalSeconds: Number(input.terms.interval),
    maxBuys: Number(input.terms.maxBuys),
    startAt: Number(input.terms.startAt),
    signer: "vault",
    vault: lower(input.vault),
  };
}

/** A vault of the connected account's that no plan here points at, as last read. */
export interface FoundVault {
  vault: Address;
  /** The plan it would be added back as (`planFromVault`); null until its terms have been read. */
  plan: DcaPlan | null;
  /** What its card shows: the same states a vault plan's card has, `loading` until read. */
  state: VaultPlanState;
}

/** Read a found vault, as its card shows it. Never throws: a failure is a state that says so. */
export async function readFoundVault(
  rpc: JsonRpc,
  input: { vault: Address; chainId: number; account: Address; factory: Address; nowMs?: number },
): Promise<FoundVault> {
  const vault = lower(input.vault);
  try {
    const read = await readVault(rpc, vault, { factory: input.factory });
    if (read === null) {
      return {
        vault,
        plan: null,
        state: { kind: "unavailable", code: "not-a-vault", reason: `There's no vault at ${vault}: nothing there answers like one.` },
      };
    }
    const plan = planFromVault({ vault, terms: read.terms, chainId: input.chainId });
    return { vault, plan, state: vaultPlanState({ plan, account: input.account, read, readAtMs: input.nowMs ?? Date.now() }) };
  } catch (error) {
    return {
      vault,
      plan: null,
      state: {
        kind: "unavailable",
        code: "unreadable",
        reason: "spDEX couldn't read this vault from your network service right now, so what it holds is unknown. It tries again every 30 seconds.",
        detail: messageOf(error),
      },
    };
  }
}

/**
 * A deleted vault plan's vault as a found vault, from the plan's last read,
 * so that a vault whose card was deleted here stays in sight at once rather
 * than after a search. Null when there is nothing to carry over: no vault, a
 * read that couldn't say whose it is, or a vault `account` doesn't own.
 */
export function foundFromPlan(plan: DcaPlan, state: VaultPlanState | undefined, account: Address): FoundVault | null {
  if (plan.vault === undefined || state === undefined || (state.kind !== "active" && state.kind !== "someone-else")) return null;
  if (state.owner !== lower(account)) return null;
  const rebuilt = planFromVault({ vault: state.vault, terms: state.terms, chainId: plan.chainId });
  // The rebuilt plan is the vault's own terms, so nothing differs from it.
  return { vault: state.vault, plan: rebuilt, state: { ...state, kind: "active", mine: true, mismatches: [] } };
}

/**
 * Every vault `account` created on this chain's factory, from the chain
 * (`findVaultsByOwner`). Null where there is nothing to search: a chain
 * vaults aren't offered on, or one the factory isn't deployed on yet. Throws
 * when the search can't start: the endpoint didn't answer.
 *
 * `known` are the account's vaults the page has already read (a plan's vault,
 * one carried over from a deleted card), with their terms. Each counts toward
 * the factory's count once its address proves it one of the account's
 * (`provenVaults`), so a search the plans already cover reads no log at all.
 *
 * Never further back than `VAULT_LOGS_FROM_BLOCK`, before which no factory of
 * spDEX's can have made a vault. The chains vaults are offered on share
 * mainnet's factory, so they share its first block. On the local fork that
 * floor is what keeps the search off the endpoint the fork was seeded from.
 */
export async function searchAccountVaults(
  rpc: JsonRpc,
  input: { chainId: number; account: Address; factory: Address; known?: readonly ShownVault[] },
): Promise<OwnerVaults | null> {
  if (vaultDeployment(input.chainId) === null) return null;
  if (((await rpc("eth_getCode", [input.factory, "latest"])) as string) === "0x") return null;
  return findVaultsByOwner(rpc, input.factory, lower(input.account), {
    oldestBlock: VAULT_LOGS_FROM_BLOCK,
    ...(input.known === undefined ? {} : { known: input.known }),
  });
}

/** A vault on the page, with the terms a read of it gave: what a search's count is checked against. */
export interface ShownVault {
  vault: Address;
  terms: VaultTerms;
}

/**
 * The vaults in `shown` that are among the `expected` the factory counted for
 * `account`: each whose address is the one `account`'s vault with that nonce
 * and those terms would have (`findVaultNonce` below the count).
 *
 * This, not "the read says it's the account's", is what lets a vault on the
 * page count toward a search's count. A vault created after the count was
 * read — made on this page after the search, say — is the account's too, but
 * not one of those counted, and counting it would hide an older one the
 * search didn't reach. Its nonce is at or above the count, so it fails here.
 * Pure: one hash per nonce below the count, no read.
 */
export function provenVaults(input: {
  shown: readonly ShownVault[];
  expected: bigint;
  factory: Address;
  account: Address;
}): Address[] {
  const owner = lower(input.account);
  const proven = new Set<Address>();
  for (const { vault, terms } of input.shown) {
    const address = lower(vault);
    if (proven.has(address)) continue;
    if (findVaultNonce({ factory: input.factory, owner, terms, vault: address, below: input.expected }) !== null) proven.add(address);
  }
  return [...proven];
}

/**
 * The vaults the panel lists apart from the plans, in the order known: every
 * one no plan on this chain points at. Those closed with nothing left in them
 * are set apart, since there is nothing to do with them, unless `inHand` says
 * the person is in the middle of something on its card: the one just closed
 * from there stays, with the line that says what came back, until that line
 * is dismissed. Someone else's is never listed: the search is by owner, and a
 * vault read as another's belongs to an account no longer connected.
 */
export function strayVaultList(input: {
  known: readonly Address[];
  reads: Readonly<Record<string, FoundVault>>;
  plans: readonly DcaPlan[];
  chainId: number;
  inHand?: (vault: Address) => boolean;
}): { listed: FoundVault[]; closed: FoundVault[] } {
  const referenced = new Set(
    input.plans.filter((plan) => plan.chainId === input.chainId && plan.vault !== undefined).map((plan) => plan.vault!.toLowerCase()),
  );
  const listed: FoundVault[] = [];
  const closed: FoundVault[] = [];
  const seen = new Set<string>();
  for (const address of input.known) {
    const vault = lower(address);
    if (seen.has(vault) || referenced.has(vault)) continue;
    seen.add(vault);
    const found = input.reads[vault] ?? { vault, plan: null, state: { kind: "loading" } };
    if (found.state.kind === "someone-else") continue;
    if (closedAndEmpty(found) && input.inHand?.(vault) !== true) closed.push(found);
    else listed.push(found);
  }
  return { listed, closed };
}

/** A vault read as closed, holding nothing: nothing left to do with it. */
export function closedAndEmpty(found: FoundVault | undefined): boolean {
  return found?.state.kind === "active" && found.state.closed && found.state.balance === 0n;
}

/** What the page can't show of the factory's count, and why (`vaultSearchNote`). */
export interface VaultSearchNote {
  /** How many of the account's vaults aren't on the page. */
  missing: number;
  /** How many the factory counts. */
  expected: number;
  /** One sentence: how many, and why. */
  text: string;
  /** What the network service said when it refused, for Details; null when it refused nothing. */
  refusal: string | null;
}

/**
 * What the last search leaves unshown, in words, or null when the page shows
 * every vault the factory counts. `accounted` is how many of those the page
 * accounts for: every vault a search named, and every other one on the page
 * proved one of them (`provenVaults`), a plan's vault included. The count is
 * the factory's own, so the missing vaults are known to exist even when they
 * can't be found: the sentence says how many and why, rather than implying
 * there are none, and the panel adds what to do.
 *
 * Why is one of two. The search read logs and stopped short: then every vault
 * it didn't reach was created before the oldest block it read, since the count
 * and the logs are read at one block. Or it read none: the service refused,
 * or wouldn't say which block is newest.
 */
export function vaultSearchNote(result: OwnerVaults, accounted: number): VaultSearchNote | null {
  const expected = Number(result.expected);
  const missing = expected - accounted;
  if (missing <= 0) return null;
  const count = (n: number) => formatCount(n);
  const one = missing === 1;
  const which =
    missing === expected
      ? expected === 1
        ? "Your vault isn't shown here"
        : `None of your ${count(expected)} vaults are shown here`
      : `${count(missing)} of your ${count(expected)} vaults ${one ? "isn't" : "aren't"} shown here`;
  const why =
    result.searchedFrom !== undefined
      ? `${one ? "it was" : "they were"} created before the oldest block this network service let spDEX search`
      : result.refusal !== undefined
        ? "this network service wouldn't let spDEX search the vault factory's records"
        : "spDEX couldn't search the vault factory's records on this network service";
  return { missing, expected, text: `${which}: ${why}.`, refusal: result.refusal ?? null };
}

/**
 * How long to wait before searching again, after `failures` searches in a row
 * that failed or read nothing (`vaultSearchFailed`): 30 seconds, then twice as
 * long each time, five times. Null once they are spent.
 *
 * A search runs once per account on a network service, and a hiccup at page
 * load used to leave its answer missing for the whole visit: no vault listed,
 * which looks exactly like having none. Retrying covers the hiccup; the limit
 * keeps a service that is down from being asked forever, and after it the
 * panel says the search failed rather than staying silent.
 */
export const VAULT_SEARCH_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 480_000];

export function vaultSearchRetryAt(failures: number, nowMs: number): number | null {
  const delay = failures < 1 ? undefined : VAULT_SEARCH_RETRY_MS[failures - 1];
  return delay === undefined ? null : nowMs + delay;
}

/**
 * Whether a search's answer is worth asking for again: it read no log, and
 * there are vaults the page can't account for. The count arrived, but the
 * newest block or the logs didn't — a service that refuses the logs for good
 * is asked again a few times too, which costs a handful of queries. A search
 * that read logs and stopped short is not: it would stop at the same place.
 */
export function vaultSearchFailed(result: OwnerVaults, accounted: number): boolean {
  return result.searchedFrom === undefined && Number(result.expected) > accounted;
}

/**
 * A search's answer with an earlier one's folded in: every vault either found,
 * the later's first. A vault once created is on chain for good, so a later
 * search that an endpoint cut short, or refused outright, doesn't unfind what
 * an earlier one found; the count, the bound and the refusal are the later's.
 */
export function mergeVaultSearches(earlier: OwnerVaults | null, later: OwnerVaults): OwnerVaults {
  const vaults = [...new Set([...later.vaults, ...(earlier?.vaults ?? [])].map(lower))];
  return { ...later, vaults, complete: later.complete || BigInt(vaults.length) >= later.expected };
}

/**
 * The log search's answer with a factory-list search's folded in, for when
 * the log search came back incomplete (`searchVaultsFromFactoryList`, used as
 * its fallback): every vault either found, the list's first.
 *
 * The count stays the log search's, which is the factory's own count for the
 * owner (`nonces`): the list search's `expected` is only what it found, and
 * taking it would silence the note when some listed owners couldn't be read.
 * It is complete when either search was, or when it found every one counted.
 */
export function withListSearch(log: OwnerVaults, list: OwnerVaults): OwnerVaults {
  const vaults = [...new Set([...list.vaults, ...log.vaults].map(lower))];
  const expected = log.expected > BigInt(vaults.length) ? log.expected : BigInt(vaults.length);
  return { ...log, vaults, expected, complete: log.complete || list.complete || BigInt(vaults.length) >= log.expected };
}

// ── A reset, an import or a shared link ───────────────────────────────────

/** Why a vault plan came through a config replacement as it was here. */
export type KeptVaultReason =
  /** The new settings leave the plan out. */
  | "dropped"
  /** The new settings have the plan without its vault: a copy from before the vault was made. */
  | "without-vault"
  /** The new settings point the plan at another vault. */
  | "other-vault";

export interface KeptVaultPlan {
  plan: DcaPlan;
  reason: KeptVaultReason;
  /** One sentence for the confirm: what stays, and why. */
  text: string;
}

/**
 * A config about to replace this one wholesale — Reset, an imported file, a
 * shared link — with each vault plan whose vault may still hold money or buy
 * kept exactly as it is here. `kept` says which and why; `error` is set, and
 * `config` is `next` untouched, when the plans can't be kept alongside it.
 *
 * Why keep rather than warn and drop: a vault plan's config entry is the one
 * sure way back to its vault from spDEX. The app does search the chain for the
 * connected account's vaults (`searchAccountVaults`), but only as far back as
 * the network service lets it, and only for the wallet connected at the time;
 * a plan in the config needs neither. A replacement that dropped the entry, or
 * pointed it somewhere else, used to leave a vault holding up to 0.5 ETH,
 * buying whenever triggered, with no "Close and withdraw" left anywhere in the
 * app, and an older copy of the same plan, without its `vault`, came back
 * offering "Create and fund vault": a second budget. It is the same rule
 * `updateDcaPlan` holds one plan to (a plan's vault is written once), applied
 * to the path that replaces them all. An old spending wallet stays listed
 * until it is withdrawn for the same reason.
 *
 * Nothing is kept that has nothing at stake (`vaultRemovalWarning` is null):
 * a closed vault, a finished and empty one, someone else's, or a plan whose
 * vault was never made. A vault that couldn't be read is kept: unknown is
 * never "nothing".
 */
export function keepVaultPlans(
  current: SpdexConfig,
  next: SpdexConfig,
  stateOf: (plan: DcaPlan) => VaultPlanState | undefined,
): { config: SpdexConfig; kept: KeptVaultPlan[]; error: string | null } {
  const plans = [...next.dca.plans];
  const kept: KeptVaultPlan[] = [];
  for (const mine of current.dca.plans) {
    if (mine.signer !== "vault") continue;
    const state = stateOf(mine);
    if (mine.vault === undefined && state?.kind !== "creating") continue;
    if (vaultRemovalWarning(state) === null) continue;
    const at = plans.findIndex((plan) => plan.id === mine.id && plan.chainId === mine.chainId);
    const theirs = at === -1 ? undefined : plans[at]!;
    if (theirs !== undefined && theirs.signer === "vault" && sameAddress(theirs.vault, mine.vault)) continue;
    // A creation still under way records its vault in whichever copy of the
    // plan is there when it lands (`recordVault`).
    if (theirs !== undefined && theirs.signer === "vault" && mine.vault === undefined && theirs.vault === undefined) continue;
    const reason: KeptVaultReason = theirs === undefined ? "dropped" : theirs.vault === undefined ? "without-vault" : "other-vault";
    if (at === -1) plans.push(mine);
    else plans[at] = mine;
    kept.push({ plan: mine, reason, text: keptVaultText(mine, state, reason, theirs?.vault) });
  }
  if (kept.length === 0) return { config: next, kept, error: null };
  const checked = DcaPolicySchema.safeParse({ ...next.dca, plans });
  if (!checked.success) {
    const why = checked.error.issues[0]?.message ?? "the plans don't fit";
    return {
      config: next,
      kept,
      error: `spDEX can't keep your vault plans alongside these settings (${why}). Close those vaults first, or cancel.`,
    };
  }
  return { config: { ...next, preset: "custom", dca: checked.data }, kept, error: null };
}

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * The retry of a vault plan's creation, from its card: the terms the vault
 * would be created with, worked out once, so that the card shows exactly what
 * the click sends.
 *
 * A plan has no field for the price allowance or the buy fee (they are the
 * vault's, and the vault doesn't exist yet), so a retry used to take them from
 * wherever it could — the allowance from this browser's draft, or a silent 2%
 * when there was none (a plan from a link, another browser, cleared storage)
 * — and the card said only "sends about …", worked out from today's default
 * rather than the fee it would send. Both are fixed in the vault for good. So
 * here the card and the click share one answer:
 *
 * - `maxSlippageBps`: the person's pick (`chosen`), else the draft's when it is
 *   one the form offers, else null — the card asks, and Create waits for it.
 * - `keeperReward`: the draft's buy fee when it is no more than this release's
 *   (`buyFee`), else this release's. A draft sized under an older, dearer
 *   rule is dropped rather than signed: the Guard and the factory would both
 *   refuse one above 0.69%, and nobody chose to pay it under the rule the app
 *   now states. Null only for an amount that isn't a buy.
 * - `fund`: the whole budget at that fee: every buy and its buy fee.
 */
export interface VaultRetryTerms {
  maxSlippageBps: number | null;
  keeperReward: bigint | null;
  /** Whether the buy fee is the one this browser kept from the first attempt. */
  keptReward: boolean;
  fund: bigint | null;
}

export function vaultRetryTerms(input: {
  plan: Pick<DcaPlan, "amountPerBuy" | "maxBuys">;
  draft: Pick<VaultDraft, "maxSlippageBps" | "keeperReward"> | null;
  /** An allowance picked on the card, overriding the draft's. */
  chosen?: number | null;
}): VaultRetryTerms {
  const offered = (bps: number | null | undefined): number | null =>
    bps !== null && bps !== undefined && (VAULT_SLIPPAGE_CHOICES as readonly number[]).includes(bps) ? bps : null;
  const maxSlippageBps = offered(input.chosen) ?? offered(input.draft?.maxSlippageBps);
  let amountPerBuy: bigint;
  try {
    amountPerBuy = BigInt(input.plan.amountPerBuy);
  } catch {
    amountPerBuy = 0n;
  }
  if (amountPerBuy <= 0n) return { maxSlippageBps, keeperReward: null, keptReward: false, fund: null };
  const today = buyFee(amountPerBuy).reward;
  const kept = input.draft === null || !/^\d+$/.test(input.draft.keeperReward) ? null : BigInt(input.draft.keeperReward);
  // No more than today's fee is within the ceiling too: `buyFee` never
  // proposes a fee above it.
  const keptFits = kept !== null && kept <= today;
  const keeperReward = keptFits ? kept : today;
  const fund = BigInt(input.plan.maxBuys) * (amountPerBuy + keeperReward);
  return { maxSlippageBps, keeperReward, keptReward: keptFits, fund };
}

function keptVaultText(plan: DcaPlan, state: VaultPlanState | undefined, reason: KeptVaultReason, incoming: Address | undefined): string {
  const title = `"${cardTitle(plan)}"`;
  const where = plan.vault === undefined ? "its vault" : `its vault (${shortAddress(plan.vault)})`;
  if (reason === "without-vault") {
    return `${title} keeps ${where}: the new settings have this plan without it, and a plan's vault can't be removed.`;
  }
  if (reason === "other-vault") {
    return `${title} keeps ${where}: the new settings point it at another vault (${shortAddress(incoming ?? "")}), and a plan's vault can't change.`;
  }
  const standing =
    state?.kind === "active"
      ? state.balance > 0n
        ? `still holds ${ethText(state.balance, 6)} WETH and goes on buying whenever anyone triggers it`
        : "isn't closed"
      : state?.kind === "creating"
        ? "is still being created"
        : "couldn't be read, so spDEX can't tell whether it still holds money";
  return `${title} stays: ${where} ${standing}, and only closing it stops it. Close it, then delete the plan.`;
}

// ── Where a vault came from ───────────────────────────────────────────────

/**
 * The claim the vault Guard proves a vault by: its address, owner and terms
 * as read, and the factory nonce it was created with, found by predicting
 * each one below the owner's count (`findVaultNonce`). Null when none puts a
 * vault with those terms at that address: it is not the factory's vault for
 * that owner, and the Guard would refuse it anyway.
 */
export async function vaultClaim(
  rpc: JsonRpc,
  factory: Address,
  state: Pick<VaultState, "address" | "owner" | "terms">,
): Promise<VaultClaim | null> {
  const below = await readVaultNonce(rpc, factory, state.owner);
  const nonce = findVaultNonce({ factory, owner: state.owner, terms: state.terms, vault: state.address, below });
  return nonce === null ? null : { address: state.address, owner: state.owner, nonce, terms: state.terms };
}

// ── The four transactions ─────────────────────────────────────────────────

const lower = (address: string): Address => address.toLowerCase() as Address;

/**
 * Creating the plan's vault, funded with `value` wei in the same transaction
 * (up to `vaultBudget`; 0 creates it empty), and the address it will land at.
 * `nonce` is the factory's count for the account (`readVaultNonce`) and
 * `nowSeconds` chain time: the Guard predicts the address from the one and
 * judges the start by the other.
 */
export function createVaultTx(input: {
  chainId: number;
  account: Address;
  plan: DcaPlan;
  terms: VaultPlan;
  nonce: bigint;
  nowSeconds: bigint;
  value: bigint;
  factory: Address;
  deployment?: FactoryDeployment;
}): { tx: VaultTxPlan; vault: Address } {
  const account = lower(input.account);
  const deployment = input.deployment ?? MAINNET_DEPLOYMENT;
  const market = deployment.markets[Number(input.terms.marketIndex)];
  if (!market) throw new Error(`the vault factory has no market ${input.terms.marketIndex}`);
  const vault = predictVault({
    factory: input.factory,
    owner: account,
    nonce: input.nonce,
    terms: {
      tokenOut: lower(market.tokenOut),
      pair: lower(market.pair),
      oraclePool: lower(market.oraclePool),
      amountPerBuy: input.terms.amountPerBuy,
      interval: input.terms.interval,
      maxBuys: input.terms.maxBuys,
      startAt: input.terms.startAt,
      keeperReward: input.terms.keeperReward,
      maxSlippageBps: input.terms.maxSlippageBps,
    },
  });
  return {
    vault,
    tx: {
      version: 1,
      intent: {
        version: 1,
        action: "create",
        chainId: input.chainId,
        account,
        plan: input.plan,
        terms: input.terms,
        nonce: input.nonce,
        nowSeconds: input.nowSeconds,
      },
      calls: [{ to: lower(input.factory), data: encodeCreateVault(input.terms), value: input.value }],
    },
  };
}

/** Funding a vault with `value` wei: at most `fundingRoom`, which the Guard recomputes. */
export function fundVaultTx(input: {
  chainId: number;
  account: Address;
  plan: DcaPlan;
  claim: VaultClaim;
  buysDone: bigint;
  wethBalance: bigint;
  value: bigint;
}): VaultTxPlan {
  return {
    version: 1,
    intent: {
      version: 1,
      action: "fund",
      chainId: input.chainId,
      account: lower(input.account),
      plan: input.plan,
      vault: input.claim,
      buysDone: input.buysDone,
      wethBalance: input.wethBalance,
    },
    calls: [{ to: input.claim.address, data: encodeFund(), value: input.value }],
  };
}

/** Closing a vault: everything it holds goes back to its owner, as ether. */
export function closeVaultTx(input: { chainId: number; account: Address; plan: DcaPlan; claim: VaultClaim }): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "close", chainId: input.chainId, account: lower(input.account), plan: input.plan, vault: input.claim },
    calls: [{ to: input.claim.address, data: encodeClose(), value: 0n }],
  };
}

/** Triggering a due buy: the owner is held to receive at least `floorOut`, and the caller the buy fee. */
export function triggerVaultTx(input: {
  chainId: number;
  account: Address;
  plan: DcaPlan;
  claim: VaultClaim;
  floorOut: bigint;
}): VaultTxPlan {
  return {
    version: 1,
    intent: {
      version: 1,
      action: "trigger",
      chainId: input.chainId,
      account: lower(input.account),
      plan: input.plan,
      vault: input.claim,
      floorOut: input.floorOut,
    },
    calls: [{ to: input.claim.address, data: encodeExecute(), value: 0n }],
  };
}

// ── Sending ───────────────────────────────────────────────────────────────

/** The part of the Engine the transactions need. */
export type VaultEngine = Pick<Engine, "checkVault" | "vaultFactory" | "rpc">;

/** The Guard refused a vault transaction. Nothing was sent. */
export class VaultTxRefused extends Error {
  readonly codes: string[];
  readonly violations: GuardViolation[];
  /** The vault's own refusal, in words, when a simulation reverted with one. */
  readonly vaultReason: string | null;
  constructor(readonly verdict: GuardVerdict) {
    const all = [...verdict.violations, ...verdict.warnings];
    const codes = [...new Set(all.map((v) => v.code))];
    const first = all[0]?.message;
    const reverted = all.find((v) => v.code === "SIMULATION_REVERTED");
    const vaultReason = reverted === undefined ? null : revertText(reverted.message);
    super(
      `the safety check refused this vault transaction (${codes.join(", ") || "no reason given"})` +
        (first ? `: ${first}` : "") +
        ". Nothing was sent.",
    );
    this.name = "VaultTxRefused";
    this.codes = codes;
    this.violations = all;
    this.vaultReason = vaultReason;
  }
}

/**
 * A vault transaction was sent and then did not succeed: it reverted, or was
 * not seen confirming in time (and may still land). The hash is what to look
 * for; the message is the confirmation's own.
 */
export class VaultTxFailed extends Error {
  readonly code?: number;
  constructor(
    readonly hash: Hex,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "VaultTxFailed";
  }
}

/** A step of a vault transaction, for the card's status line. */
export interface VaultStep {
  phase: "check" | "send" | "confirm";
  label: string;
}

export interface VaultHooks {
  onStep?(step: VaultStep): void;
  /** The hash as soon as the wallet gives it, before its confirmation is awaited. */
  onSent?(hash: Hex): void | Promise<void>;
}

interface Receipt {
  status?: string;
  logs?: RawLog[];
}

/**
 * What the card says about a vault transaction the Guard let through
 * `unverified`, or null for a verified one.
 *
 * Only a close or a buy gets here: they send no ether, so, like a swap,
 * they are signable on one service's test-run when the second opinion is
 * silent, or on none when the service can't test-run. A swap's banner says
 * so before the wallet asks, and the card says the same thing, in the same
 * words, where the swap's banner would be.
 */
export function vaultCheckNote(verdict: GuardVerdict): string | null {
  if (verdict.level !== "unverified") return null;
  if (verdict.warnings.some((w) => w.code === "SIMULATION_UNAVAILABLE")) return "Not checked: this wasn't test-run in advance.";
  const silent = verdict.warnings.find((w) => w.code === "SECOND_OPINION_UNAVAILABLE");
  if (silent === undefined) return null;
  const host = silent.detail?.["host"]?.trim() ?? "";
  const who = host === "" ? "your second opinion" : `your second opinion, ${host},`;
  return `Checked on one service: ${who} didn't answer.`;
}

/**
 * Check a vault transaction, send it from the owner's wallet, and wait for
 * it: its hash and the logs it emitted.
 *
 * Signed only on a signable verdict for exactly the account that sends. One
 * that sends ether must also be `verified`: the Guard already refuses it
 * otherwise, and saying it twice costs nothing where a mistake would cost the
 * ether (see packages/guard/src/vault.ts).
 */
export async function sendVaultTx(
  tx: VaultTxPlan,
  deps: { engine: Pick<Engine, "checkVault">; sender: TxSender; rpc: JsonRpc; sendLabel: string } & VaultHooks,
): Promise<{ hash: Hex; logs: RawLog[]; verdict: GuardVerdict }> {
  const call = tx.calls[0];
  if (tx.calls.length !== 1 || call === undefined) throw new Error("a vault transaction is exactly one call");
  if (deps.sender.kind !== "wallet") throw new Error("vault transactions are sent from the owner's own wallet");
  if (deps.sender.account.toLowerCase() !== tx.intent.account.toLowerCase()) {
    throw new Error(`the connected wallet is ${deps.sender.account}, not ${tx.intent.account}, which this was checked for`);
  }
  deps.onStep?.({ phase: "check", label: "Running the safety check…" });
  const verdict = await deps.engine.checkVault(tx);
  if (!verdict.signable) throw new VaultTxRefused(verdict);
  if (call.value > 0n && verdict.level !== "verified") throw new VaultTxRefused({ ...verdict, level: "rejected", signable: false });

  const note = vaultCheckNote(verdict);
  deps.onStep?.({ phase: "send", label: note === null ? deps.sendLabel : `${note} ${deps.sendLabel}` });
  // The chain goes with the call, so a wallet switched to another network
  // while the check ran is refused before it signs (`SendableCall.chainId`).
  // A buy carries Trigger now's gas floor: its estimate describes the pool as
  // it is now, and a trade landing on the pool first puts the buy on a path
  // about 57,000 gas dearer, more than an estimate's 20% covers — it would
  // run out of gas and still cost its fee (`KEEPER_MIN_EXECUTE_GAS_LIMIT`).
  const sent = await deps.sender.send({
    to: call.to,
    data: call.data,
    value: call.value,
    chainId: tx.intent.chainId,
    ...(tx.intent.action === "trigger" ? { gasFloor: KEEPER_MIN_EXECUTE_GAS_LIMIT } : {}),
  });
  const sentHash = sent.hash.toLowerCase() as Hex;
  await deps.onSent?.(sentHash);
  deps.onStep?.({ phase: "confirm", label: "Waiting for the network…" });
  // The hash that was mined: a wallet's "Speed up" replaces the one sent.
  let hash: Hex;
  try {
    hash = (await confirmTransaction(sentHash, deps.sender.confirm)).toLowerCase() as Hex;
  } catch (error) {
    throw new VaultTxFailed(sentHash, error);
  }
  let logs: RawLog[] = [];
  try {
    const receipt = (await deps.rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    logs = receipt?.logs ?? [];
  } catch {
    // Confirmed, and its logs unreadable for a moment: the caller reads the
    // vault itself, which is where its figures come from anyway.
  }
  return { hash, logs, verdict };
}

export interface VaultOpDeps extends VaultHooks {
  engine: VaultEngine;
  /** The owner's wallet (`walletSender`): a person confirms each transaction. */
  sender: TxSender;
  chainId: number;
}

/**
 * Create the plan's vault and fund it in one transaction.
 *
 * Reads chain time and the account's factory nonce, predicts where the vault
 * will land, hands that to `onPrepared` — the caller records it before
 * anything is sent, so a tab closed mid-creation leaves an address to look
 * for — then checks, sends and confirms. The address returned is the one the
 * factory announced in the receipt: record that one, since a plan's vault can
 * be written only once.
 *
 * `vault` is null when the receipt's logs couldn't be read, or named no vault
 * for this owner. The prediction is not a stand-in for it: it was made from a
 * nonce read before the wallet was asked, and the same account creating a
 * vault from another tab or device in between moves this one to the next
 * nonce's address. Recorded, a guess would point the plan for good at an
 * address with no code and leave the real vault untracked. The caller keeps
 * the creation (with its hash) instead, and `settleCreation` confirms it from
 * the code at the address or the receipt, as it does for a tab that closed.
 */
export async function createVault(
  deps: VaultOpDeps & {
    onPrepared?(prepared: { vault: Address; nonce: bigint }): void | Promise<void>;
  },
  input: { plan: DcaPlan; choices: VaultChoices; fund: bigint },
): Promise<{ vault: Address | null; hash: Hex; verdict: GuardVerdict }> {
  const rpc = deps.engine.rpc;
  const factory = deps.engine.vaultFactory;
  const account = lower(deps.sender.account);
  const deployment = vaultDeployment(deps.chainId);
  if (deployment === null) throw new Error(`vaults aren't offered on ${networkLabel(deps.chainId)}`);
  if (factory !== lower(factoryAddress(deployment))) throw new Error("the engine's vault factory isn't this chain's");
  const [clock, nonce] = await Promise.all([readChainClock(rpc), readVaultNonce(rpc, factory, account)]);
  const terms = vaultPlanOf(input.plan, input.choices);
  const { tx, vault } = createVaultTx({
    chainId: deps.chainId,
    account,
    plan: input.plan,
    terms,
    nonce,
    nowSeconds: BigInt(clock.seconds),
    value: input.fund,
    factory,
    deployment,
  });
  await deps.onPrepared?.({ vault, nonce });
  const sent = await sendVaultTx(tx, {
    ...deps,
    rpc,
    sendLabel:
      input.fund > 0n ? "Confirm creating and funding the vault in your wallet…" : "Confirm creating the vault in your wallet…",
  });
  const created = vaultsCreatedBy(factory, sent.logs).filter((event) => event.owner === account);
  return { vault: created.length === 1 ? created[0]!.vault : null, hash: sent.hash, verdict: sent.verdict };
}

/**
 * Read a plan's vault fresh and prove where it came from, for a transaction
 * about to be built on it. Throws a sentence when there is nothing to build
 * on.
 */
async function freshVault(engine: VaultEngine, plan: DcaPlan): Promise<{ state: VaultState; claim: VaultClaim }> {
  if (plan.vault === undefined) throw new Error("This plan has no vault yet.");
  const state = await readVault(engine.rpc, lower(plan.vault), { factory: engine.vaultFactory });
  if (state === null) throw new Error(`There's no vault at ${plan.vault}. Nothing was sent.`);
  const claim = await vaultClaim(engine.rpc, engine.vaultFactory, state);
  if (claim === null) {
    throw new Error(`${plan.vault} isn't a vault spDEX's factory made for its owner on these terms. Nothing was sent.`);
  }
  return { state, claim };
}

/**
 * Fund the plan's vault with `amount` wei, or with everything its remaining
 * buys and their buy fees still need when `amount` is left out.
 */
export async function fundVault(deps: VaultOpDeps, input: { plan: DcaPlan; amount?: bigint }): Promise<{ hash: Hex; amount: bigint }> {
  const account = lower(deps.sender.account);
  const { state, claim } = await freshVault(deps.engine, input.plan);
  if (state.owner !== account) throw new Error(`Only the vault's owner, ${state.owner}, can fund it. Nothing was sent.`);
  if (state.closed) throw new Error("The vault is closed; a closed vault can't be funded. Nothing was sent.");
  const room = fundingRoom(state);
  if (room === 0n) throw new Error("The vault already holds what its remaining buys and their buy fees need. Nothing was sent.");
  const amount = input.amount ?? room;
  if (amount <= 0n || amount > room) {
    throw new Error(`The vault can take at most ${ethText(room, 6)} ETH more right now. Nothing was sent.`);
  }
  const tx = fundVaultTx({
    chainId: deps.chainId,
    account,
    plan: input.plan,
    claim,
    buysDone: state.buysDone,
    wethBalance: state.status.wethBalance,
    value: amount,
  });
  const sent = await sendVaultTx(tx, { ...deps, rpc: deps.engine.rpc, sendLabel: "Confirm funding the vault in your wallet…" });
  return { hash: sent.hash, amount };
}

/**
 * Close the plan's vault: everything it holds comes back to the owner, as
 * ether (or as WETH when the owner can't take ether). The only stop a vault
 * has. `returned` is what the vault announced it sent, or null when its
 * receipt couldn't be read.
 */
export async function closeVault(
  deps: VaultOpDeps,
  input: { plan: DcaPlan },
): Promise<{ hash: Hex; returned: bigint | null; note: string | null }> {
  const account = lower(deps.sender.account);
  const { state, claim } = await freshVault(deps.engine, input.plan);
  if (state.owner !== account) throw new Error(`Only the vault's owner, ${state.owner}, can close it. Nothing was sent.`);
  if (state.closed) throw new Error("The vault is already closed. Nothing was sent.");
  const tx = closeVaultTx({ chainId: deps.chainId, account, plan: input.plan, claim });
  const sent = await sendVaultTx(tx, { ...deps, rpc: deps.engine.rpc, sendLabel: "Confirm closing the vault in your wallet…" });
  const closed = sent.logs.map(decodeVaultEvent).find((event) => event?.name === "Closed" && event.emitter === state.address);
  return { hash: sent.hash, returned: closed?.name === "Closed" ? closed.amount : null, note: vaultCheckNote(sent.verdict) };
}

/**
 * Trigger the plan's due buy from the connected wallet, which is paid the
 * buy fee as any keeper is. Refused, with the vault's own reason, unless a
 * read says it would go through now. `received` and `reward` are what the
 * vault announced, or null when its receipt couldn't be read.
 */
export async function triggerVault(
  deps: VaultOpDeps,
  input: { plan: DcaPlan },
): Promise<{ hash: Hex; received: bigint | null; reward: bigint | null; note: string | null }> {
  const account = lower(deps.sender.account);
  const { state, claim } = await freshVault(deps.engine, input.plan);
  const why = vaultWaitReason(state, Date.now());
  if (why !== null) throw new Error(`The vault won't buy right now. ${why} Nothing was sent.`);
  if (state.quote === null) throw new Error("The vault's price reference can't answer right now. Nothing was sent.");
  const tx = triggerVaultTx({ chainId: deps.chainId, account, plan: input.plan, claim, floorOut: state.quote.floorOut });
  const sent = await sendVaultTx(tx, { ...deps, rpc: deps.engine.rpc, sendLabel: "Confirm the buy in your wallet…" });
  const bought = sent.logs.map(decodeVaultEvent).find((event) => event?.name === "Bought" && event.emitter === state.address);
  return {
    hash: sent.hash,
    received: bought?.name === "Bought" ? bought.amountOut : null,
    reward: bought?.name === "Bought" ? bought.reward : null,
    note: vaultCheckNote(sent.verdict),
  };
}

/**
 * The vault factory's one-time deployment, sent from the connected wallet
 * through the standard deterministic deployer.
 *
 * Not a Guard path, and why that is acceptable: it moves nobody's money — it
 * sends no ether, grants nothing and touches no balance — and anyone may send
 * it, with the same result whoever does. What it can cost is its gas, about
 * 3.6 million. So what is checked is that it does what it says: the chain is
 * one vaults are offered on, the factory is not there yet, the constructor's
 * listing checks pass right now (`simulateFactoryDeployment`), and a call of
 * exactly this transaction from this account returns the address the app
 * trusts — the deployer answers with where it put the contract. After the
 * receipt, the factory's code must be there.
 */
export async function deployVaultFactory(
  deps: { rpc: JsonRpc; sender: TxSender; chainId: number } & VaultHooks,
): Promise<{ hash: Hex; factory: Address }> {
  const deployment = vaultDeployment(deps.chainId);
  if (deployment === null) throw new Error(`Vaults aren't offered on ${networkLabel(deps.chainId)}.`);
  const call = deployFactoryCall(deployment);
  const account = lower(deps.sender.account);
  deps.onStep?.({ phase: "check", label: "Checking the deployment…" });
  if (((await deps.rpc("eth_getCode", [call.factory, "latest"])) as string) !== "0x") {
    throw new Error("The vault factory is already deployed on this chain. Nothing was sent.");
  }
  const check = await simulateFactoryDeployment(deps.rpc, deployment);
  if (!check.deployable) throw new Error(`Deploying the vault factory would be refused right now: ${check.reason}. Nothing was sent.`);
  const answered = (await deps.rpc("eth_call", [{ from: account, to: call.to, data: call.data, value: "0x0" }, "latest"])) as string;
  // The deterministic deployer returns the new contract's address as 20 bytes.
  if (typeof answered !== "string" || `0x${answered.slice(-40)}`.toLowerCase() !== call.factory || call.to !== DETERMINISTIC_DEPLOYER) {
    throw new Error(`The deployment would not land at the factory's address, ${call.factory}. Nothing was sent.`);
  }
  // Checked once more right before the wallet opens: someone else's
  // deployment landing since the first check turns this one into a creation
  // that collides with the factory already there, which reverts having used
  // nearly all of its gas limit — about 3.6 million, a real sum. The check
  // narrows that window; it can't close it, and the button says so.
  if (((await deps.rpc("eth_getCode", [call.factory, "latest"])) as string) !== "0x") {
    throw new Error("The vault factory has just been deployed on this chain by someone else. Nothing was sent.");
  }
  deps.onStep?.({ phase: "send", label: "Confirm deploying the vault factory in your wallet…" });
  const sent = await deps.sender.send({ to: call.to, data: call.data, value: 0n, chainId: deps.chainId });
  const sentHash = sent.hash.toLowerCase() as Hex;
  await deps.onSent?.(sentHash);
  deps.onStep?.({ phase: "confirm", label: "Waiting for the network…" });
  let hash: Hex;
  try {
    hash = (await confirmTransaction(sentHash, deps.sender.confirm)).toLowerCase() as Hex;
  } catch (error) {
    throw new VaultTxFailed(sentHash, error);
  }
  if (((await deps.rpc("eth_getCode", [call.factory, "latest"])) as string) === "0x") {
    throw new VaultTxFailed(hash, new Error(`the deployment confirmed, and there is still no code at ${call.factory}`));
  }
  return { hash, factory: call.factory };
}

// ── A vault's refusals, in words ──────────────────────────────────────────

/**
 * A vault or factory error, as a sentence, or null for one that is neither's
 * (an out-of-gas, a pool's own revert) — the caller shows the raw message then.
 */
export function vaultErrorText(error: { name: string; args: readonly unknown[] } | null): string | null {
  if (error === null) return null;
  const terms = termsProblemText(error.name);
  if (terms !== undefined) return terms;
  switch (error.name) {
    case "TooSoon":
    case "NotStarted":
      return "The vault's next buy isn't due yet.";
    case "NoBuysLeft":
      return "Every buy this vault was set up for is done.";
    case "VaultClosed":
      return "The vault is closed.";
    case "InsufficientBalance":
      return "The vault doesn't hold enough for its next buy and its buy fee.";
    case "OracleTooThin":
      return "The market the price is checked against is too thin right now, so the vault won't buy.";
    case "PriceBelowFloor":
      return "The price is outside this vault's allowance right now, so it won't buy. It waits for the market.";
    case "DeliveredShort":
      return "The token delivered less than the market sent, so the vault refused the buy.";
    case "Unauthorized":
      return "Only the vault's owner can do that.";
    case "FullyFunded":
      return "The vault already holds what its remaining buys need.";
    case "NothingToFund":
      return "Nothing was sent to fund the vault.";
    case "UnknownMarket":
      return termsProblemText("UnknownMarket")!;
    default:
      return null;
  }
}

/** The vault's reason inside a revert message, when the message carries its data. */
export function revertText(message: string): string | null {
  const data = /0x[0-9a-fA-F]{8,}/.exec(message)?.[0];
  return data === undefined ? null : vaultErrorText(decodeVaultError(data));
}

// ── History ───────────────────────────────────────────────────────────────

export interface VaultHistoryEntry {
  kind: "bought" | "funded" | "closed";
  hash: Hex;
  blockNumber: bigint;
  logIndex: number;
  /** Unix seconds (chain time) of its block; null when that couldn't be read. */
  at: number | null;
  /** A buy: WETH in, tokens delivered to the owner, who triggered it and what they were paid. */
  amountIn?: bigint;
  amountOut?: bigint;
  keeper?: Address;
  reward?: bigint;
  /** A funding or a closing: the amount, wei. */
  amount?: bigint;
}

export interface VaultHistory {
  /** Newest first. */
  entries: VaultHistoryEntry[];
  /** The blocks the logs were read over. */
  fromBlock: bigint;
  toBlock: bigint;
  /** Buys the vault counts that these logs don't show: 0 when every buy is here. */
  missingBuys: number;
  /** Why the history is partial, as a sentence; null when it isn't. */
  note: string | null;
}

/**
 * The vault's `Bought`, `Funded` and `Closed` topics: keccak256 of each
 * event's signature. Written out because this package does not depend on an
 * ABI encoder; a unit test holds each to the vault's ABI by decoding a log
 * that carries it.
 */
export const VAULT_EVENT_TOPICS = {
  Bought: "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6",
  Funded: "0xc4c14883ae9fd8e26d5d59e3485ed29fd126d781d7e498a4ca5c54c8268e4936",
  Closed: "0x6cc09e7b5c3e49861ebe8f6867e1618fbfc14c8d0e968fde37c4243ca02a6f83",
} as const;
const EVENT_TOPICS = Object.values(VAULT_EVENT_TOPICS);

/**
 * Log windows to try, widest first. Hosted endpoints cap `eth_getLogs`
 * ranges — some at ten blocks — so the reader steps down on a refusal, as
 * the pool statistics' volume reader does.
 */
const HISTORY_WINDOWS = [10_000n, 2_000n, 500n, 100n, 10n];

/** The most log queries one history read makes; past that, earlier buys are "not shown". */
export const MAX_HISTORY_QUERIES = 20;

/** Blocks whose times are looked up for the newest entries; older ones show no date. */
const MAX_TIMED_BLOCKS = 20;

/**
 * A vault's history from its own `Bought`, `Funded` and `Closed` logs, best
 * effort, newest first.
 *
 * Read backwards from the latest block in windows the endpoint accepts, and
 * stopped as soon as every buy the vault counts (`buysDone`) has been found —
 * so the usual read is one query — or at the vault's start, before which no
 * buy can be, or after `MAX_HISTORY_QUERIES`. Buys still not found are
 * reported as missing ("earlier buys not shown"), never guessed at: the vault's
 * own totals stay the figures to trust.
 *
 * The start is turned into a block only on Ethereum, which makes at most one
 * block a 12-second slot, so a block counted back that way is never later
 * than the first one after the start. Nowhere else is there such a bound: a
 * local fork mines a block per transaction and stamps several with the same
 * second, so a bound worked out from time (one block a second, as this once
 * assumed) can land above the buy it was meant to reach, and the card then
 * said a buy it holds was "not shown". There the walk is bounded by
 * `MAX_HISTORY_QUERIES` alone.
 */
export async function readVaultHistory(
  rpc: JsonRpc,
  input: { vault: Address; buysDone: number; startAt: number; chainId: number; maxQueries?: number },
): Promise<VaultHistory> {
  const vault = lower(input.vault);
  const head = BigInt((await rpc("eth_blockNumber", [])) as string);
  let lowest = 0n;
  if (input.chainId === 1) {
    const headBlock = (await rpc("eth_getBlockByNumber", [`0x${head.toString(16)}`, false])) as { timestamp?: string } | null;
    const headTime = headBlock?.timestamp ? Number(BigInt(headBlock.timestamp)) : null;
    const sinceStart = headTime === null ? null : BigInt(Math.max(0, Math.ceil((headTime - input.startAt) / 12)) + 1);
    lowest = sinceStart === null ? 0n : head > sinceStart ? head - sinceStart : 0n;
  }

  const entries: VaultHistoryEntry[] = [];
  let bought = 0;
  let to = head;
  let from = head + 1n;
  let windowIndex = 0;
  let queries = 0;
  let answered = 0;
  let refusal: string | null = null;
  const maxQueries = input.maxQueries ?? MAX_HISTORY_QUERIES;

  // At least one answered query, for a funding or a closing since the start;
  // then on only while buys are missing.
  while ((answered === 0 || bought < input.buysDone) && to >= lowest && queries < maxQueries) {
    const window = HISTORY_WINDOWS[windowIndex]!;
    const start = to + 1n > window ? to + 1n - window : 0n;
    const low = start < lowest ? lowest : start;
    queries += 1;
    let logs: (RawLog & { blockNumber?: string; transactionHash?: string; logIndex?: string })[];
    try {
      logs = (await rpc("eth_getLogs", [
        { address: vault, fromBlock: `0x${low.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [EVENT_TOPICS] },
      ])) as typeof logs;
    } catch (error) {
      if (windowIndex + 1 < HISTORY_WINDOWS.length) {
        windowIndex += 1;
        continue;
      }
      refusal = messageOf(error);
      break;
    }
    answered += 1;
    for (const log of logs) {
      const event = decodeVaultEvent(log);
      if (event === null || event.emitter !== vault || !log.blockNumber || !log.transactionHash) continue;
      const base = {
        hash: log.transactionHash.toLowerCase() as Hex,
        blockNumber: BigInt(log.blockNumber),
        logIndex: log.logIndex ? Number(BigInt(log.logIndex)) : 0,
        at: null,
      };
      if (event.name === "Bought") {
        bought += 1;
        entries.push({ ...base, kind: "bought", amountIn: event.amountIn, amountOut: event.amountOut, keeper: event.keeper, reward: event.reward });
      } else if (event.name === "Funded") {
        entries.push({ ...base, kind: "funded", amount: event.amount });
      } else if (event.name === "Closed") {
        entries.push({ ...base, kind: "closed", amount: event.amount });
      }
    }
    from = low;
    if (low === 0n) break;
    to = low - 1n;
  }

  entries.sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1));
  const blocks = [...new Set(entries.map((e) => e.blockNumber))].slice(0, MAX_TIMED_BLOCKS);
  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (block) => {
      try {
        const read = (await rpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, false])) as { timestamp?: string } | null;
        if (read?.timestamp) times.set(block, Number(BigInt(read.timestamp)));
      } catch {
        // Its row shows no date: unknown, not a guess.
      }
    }),
  );
  for (const entry of entries) entry.at = times.get(entry.blockNumber) ?? null;

  const missingBuys = Math.max(0, input.buysDone - bought);
  let note: string | null = null;
  if (missingBuys > 0) {
    const shown = `${formatCount(bought)} of its ${formatCount(input.buysDone)} buys`;
    note =
      refusal !== null
        ? `Earlier buys not shown: your network service wouldn't serve the vault's older logs (${refusal}). This shows ${shown}; the totals above count every buy.`
        : `Earlier buys not shown: spDEX read the vault's logs back to block ${from.toString()}, which holds ${shown}. The totals above count every buy.`;
  }
  return { entries, fromBlock: from > head ? head : from, toBlock: head, missingBuys, note };
}

// ── Remembering a creation ────────────────────────────────────────────────

/**
 * A vault creation this browser started: where the vault will land and the
 * transaction that makes it, recorded before anything is sent. A plan's vault
 * can be written into the config only once and only from what the chain
 * shows, so this is how a tab closed mid-creation — or a wallet whose answer
 * was lost — still finds the vault afterwards instead of offering to create a
 * second one.
 */
export interface VaultCreation {
  owner: Address;
  /** The predicted address: where the factory puts this owner's vault for this nonce and these terms. */
  vault: Address;
  nonce: string;
  /** The creation's hash, once the wallet gave one. */
  hash: Hex | null;
  /** Device time it was recorded, ms. */
  at: number;
}

/** The choices a vault plan was set up with, kept for a retry of its creation, and a creation under way. */
export interface VaultDraft {
  maxSlippageBps: number;
  /** Wei, decimal. */
  keeperReward: string;
  /** Wei, decimal: what the creation sends along. */
  fund: string;
  creation?: VaultCreation;
}

export const VAULT_DRAFTS_KEY = "spdex.vault.drafts.v1";

/**
 * Drafts and creations under way, in this browser's storage, keyed by chain and
 * plan. A convenience, not a record anything relies on: the chain is the
 * truth, and losing this costs a retry's choices and, at worst, a creation
 * noticed only when its vault is looked up by hand. Every read and write is
 * guarded; storage can be missing or refuse.
 */
export class VaultDrafts {
  constructor(
    private readonly storage: StorageLike | null,
    private readonly key: string = VAULT_DRAFTS_KEY,
  ) {}

  #readAll(): Record<string, VaultDraft> {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, VaultDraft>) : {};
    } catch {
      return {};
    }
  }

  get(chainId: number, planId: string): VaultDraft | null {
    const draft = this.#readAll()[`${chainId}:${planId}`];
    return isDraft(draft) ? draft : null;
  }

  set(chainId: number, planId: string, draft: VaultDraft | null): void {
    try {
      const all = this.#readAll();
      const key = `${chainId}:${planId}`;
      if (draft === null) delete all[key];
      else all[key] = draft;
      this.storage?.setItem(this.key, JSON.stringify(all));
    } catch {
      // A draft is a convenience; see the class comment.
    }
  }
}

function isDraft(value: unknown): value is VaultDraft {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d["maxSlippageBps"] !== "number" || typeof d["keeperReward"] !== "string" || typeof d["fund"] !== "string") return false;
  if (!/^\d+$/.test(d["keeperReward"]) || !/^\d+$/.test(d["fund"])) return false;
  const c = d["creation"];
  if (c === undefined) return true;
  if (typeof c !== "object" || c === null) return false;
  const creation = c as Record<string, unknown>;
  return (
    typeof creation["owner"] === "string" &&
    typeof creation["vault"] === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(creation["vault"]) &&
    typeof creation["nonce"] === "string" &&
    (creation["hash"] === null || (typeof creation["hash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(creation["hash"]))) &&
    typeof creation["at"] === "number"
  );
}

/**
 * How long a creation nobody can find is still treated as on its way: a
 * wallet may broadcast through a node of its own, and the transaction reach
 * this endpoint's view only later.
 */
export const CREATION_GRACE_MS = 30 * 60_000;

export type CreationOutcome =
  /** The vault is there, the factory's, the owner's and on the plan's terms: record it. */
  | { kind: "created"; vault: Address }
  /** Not seen yet, and may still land. */
  | { kind: "pending" }
  /** It will not land: reverted, or gone past the grace with no trace. `note` says which. */
  | { kind: "failed"; note: string };

/**
 * What became of a creation this browser started. The vault's code at the
 * predicted address settles it — the address commits to the factory, the
 * owner and every term, so a vault there is this creation's — then the
 * transaction's receipt, then time.
 */
export async function settleCreation(
  rpc: JsonRpc,
  input: { plan: DcaPlan; creation: VaultCreation; factory: Address; nowMs: number },
): Promise<CreationOutcome> {
  const { creation, plan } = input;
  const vault = lower(creation.vault);
  if (((await rpc("eth_getCode", [vault, "latest"])) as string) !== "0x") {
    const state = await readVault(rpc, vault, { factory: input.factory });
    if (state !== null && state.fromFactory === true && state.owner === lower(creation.owner) && vaultTermsMismatches(plan, state.terms).length === 0) {
      return { kind: "created", vault };
    }
    return { kind: "failed", note: `Something other than this plan's vault is at ${vault}, so spDEX didn't record it.` };
  }
  if (creation.hash !== null) {
    const receipt = (await rpc("eth_getTransactionReceipt", [creation.hash])) as Receipt | null;
    if (receipt?.status !== undefined) {
      if (BigInt(receipt.status) === 0n) {
        return { kind: "failed", note: "The last attempt to create the vault failed on chain; only its network fee was spent. Create it again." };
      }
      const made = vaultsCreatedBy(input.factory, receipt.logs ?? []).find((event) => event.owner === lower(creation.owner));
      if (made !== undefined) return { kind: "created", vault: made.vault };
    }
    const known = await Promise.resolve(rpc("eth_getTransactionByHash", [creation.hash])).catch(() => null);
    if (known != null) return { kind: "pending" };
  }
  if (input.nowMs - creation.at < CREATION_GRACE_MS) return { kind: "pending" };
  // Not "it never reached the network": a transaction sent through a wallet's
  // own private service, or stuck unseen in a queue, can land after this —
  // and a retry then makes a second funded vault. What is known is what
  // this endpoint shows, and that is what the note says.
  return {
    kind: "failed",
    note:
      "spDEX hasn't seen the last attempt to create this vault in 30 minutes, and your network service doesn't know its transaction. " +
      "It most likely never went out. If your wallet shows it as sent or pending, wait for it rather than creating a second vault.",
  };
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

// Re-exported so the UI has one import for a vault's figures.
export { FACTORY_LIMITS, KEEPER_MIN_EXECUTE_GAS_LIMIT, VAULT_LIMITS, describeMarketGap } from "@spdex/vault";
export type { OwnerVaults, VaultAvailability, VaultState, VaultTerms } from "@spdex/vault";
export type { VaultTermsMismatch } from "@spdex/guard";
