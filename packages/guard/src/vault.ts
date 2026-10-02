/**
 * The Guard, applied to an auto-buy vault.
 *
 * A vault plan's buys are not signed by anyone this app controls: a contract
 * holds the budget and makes each buy itself, whoever triggers it. What the
 * user's wallet does sign are four transactions the host composes around it —
 * create the vault (optionally funding it in the same transaction), fund it,
 * close it and take everything back, and trigger a due buy themselves. Each
 * moves the user's money or decides where it will sit, so each passes through
 * here, for the reason tips and budget transfers do: the host wrote them, and
 * that has never been an exemption. The terms come from a config that may have
 * arrived in a link, and the vault's address and state from reads over the
 * network; a bug in any of them looks, at the moment of signing, exactly like
 * an attack.
 *
 * ## What is proved without the chain
 *
 * Every call is compared byte for byte with a fresh encoding by the same
 * functions the host uses (`@spdex/vault`), and aimed at the one place it may
 * go: a creation at the factory `factoryAddress(deployment)` computes — an
 * address that commits to the factory's code and its list of markets — and
 * everything else at the plan's vault.
 *
 * Whether that vault is a real one, and the account's, is proved the same way,
 * with no read at all. A vault's address is where the factory's CREATE2 puts a
 * clone carrying its owner and its terms (`predictVault`), so an address equal
 * to the prediction for this account, a nonce and these terms can only be
 * the factory's vault for this account on exactly these terms. The host
 * supplies the owner, nonce and terms from its reads; none of it is believed,
 * because a lie changes the prediction. That is what lets the static layer
 * hold funding to what the terms allow and compare the terms with the plan
 * the user wrote.
 *
 * A creation's buy fee (`keeperReward`) is also held to the 0.69% ceiling
 * (`@spdex/vault`'s fee.ts): the whole fee, the network cost included, and
 * the most anyone who triggers a buy is ever paid for it. It is the factory's
 * own `MAX_REWARD_BPS`, so the factory would refuse more as well; the Guard
 * says so first, by name and figure, before anyone pays gas to hear it. Only
 * creations: an existing vault is funded, closed and triggered whatever its
 * terms say, since refusing those would trap its owner's money.
 *
 * ## What only simulation shows
 *
 * That the code is there. The factory and each vault live at addresses fixed
 * before they exist, and ether sent to one that has no code yet succeeds and
 * is lost. So a transaction that sends ether — a creation that funds, or a
 * funding — is never signed unchecked: without a simulation it is refused
 * whatever `requireSimulation` says. One that sends none — closing, triggering,
 * an unfunded creation — can at worst waste its fee, and follows the setting
 * as a swap does. Closing in particular must stay possible on an endpoint
 * that cannot simulate; a Guard that refused it would be keeping the user from
 * their own money.
 *
 * Then the effects, with WETH counted from its `Deposit` and `Withdrawal`
 * events as well as its transfers, because wrapping moves WETH balances
 * without a `Transfer`:
 *
 *   create   the factory announces exactly one vault — for this account, on
 *            these terms, at the predicted address — and it holds, as WETH,
 *            every wei the account sent.
 *   fund     what left the account arrived as the vault's WETH; anything the
 *            vault did not need came back.
 *   close    the account only receives, and receives at least what the vault
 *            gave up.
 *   trigger  one buy, credited to this caller; the owner receives at least the
 *            floor read beforehand, the caller at least the reward, and the
 *            vault parts with no more than one buy and that reward.
 *
 * And for all four: nothing leaves the account beyond the ether it sends, and
 * the account grants no allowance.
 *
 * ## A batch for other people's vaults
 *
 * The fifth transaction ("Help run the network") makes due buys in strangers'
 * vaults through the batcher bound to the factory, and pays the account their
 * buy fees. There is no plan to hold it to; each vault's own rules protect its
 * owner, whoever triggers it. What is checked is the account's side:
 *
 *   static     one call to the computed batcher, no ether, exactly
 *              `executeBatch(vaults, account, minRewards)` with every fee to
 *              the account, 1 to 20 distinct vaults, a least reward of at
 *              least 1 wei, and the exact gas limit and price it is signed
 *              with, the limit room enough for every vault and under the
 *              per-transaction cap.
 *   simulated  at that gas limit: the least reward covers the network fee
 *              of the gas the simulation used, at the signed price; the
 *              batcher's one `Batch` credits the account, earns at least the
 *              least reward and passes on no WETH it held before
 *              (`VAULT_BATCH_UNACCOUNTED`); every listed vault
 *              is tried once, and each that buys follows its own `Bought`,
 *              credited to the batcher, at or above its floor, parting with
 *              exactly its buy and fee; the account receives what was earned,
 *              and nothing of its moves.
 *
 * It is never signed unchecked, whatever `requireSimulation` says: what it
 * earns is known only from its simulation.
 *
 * ## What it cannot catch
 *
 * The vault is unaudited, and this checks the vault's behaviour in one
 * simulation against the rules above, not the contract. A price that moves
 * between the simulation and the block can still refuse a buy on chain; the
 * vault's own floor is what then protects the owner, and the transaction's fee
 * is lost.
 *
 * A batch's gas price is the main service's, and nothing here bounds it: what
 * does is that the batch must earn its fee at that price, from gas used as
 * the simulation reports it. With a second opinion that figure is the larger
 * of two services'; without one, a main service that understates the gas and
 * overstates the price in the same breath can still make a batch cost more
 * than it earns, as it can fake any simulation within one service.
 */

import type { SimLog, SimulationOutcome, SimulationProvider } from "@spdex/chain";
import { NATIVE_TOKEN, SimulationUnavailableError } from "@spdex/chain";
import {
  BaseUnitsSchema,
  rejected,
  unverified,
  verified,
  type Address,
  type Call,
  type DcaPlan,
  type GuardVerdict,
  type GuardViolation,
  type Hex,
} from "@spdex/core";
import {
  BUY_FEE_CEILING_BPS,
  MAINNET_DEPLOYMENT,
  MAX_BATCH_GAS_CEILING,
  batchGasLimit,
  batcherAddress,
  decodeBatchRevert,
  decodeVaultEvent,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeExecuteBatch,
  encodeFund,
  factoryAddress,
  feeCeiling,
  feeShareText,
  joinBatchLogs,
  predictVault,
  termsOfPlan,
  termsProblems,
  vaultBudget,
  vaultsCreatedBy,
  withinFeeCeiling,
  type FactoryDeployment,
  type VaultEvent,
  type VaultPlan,
  type VaultTerms,
} from "@spdex/vault";
import { deltaFor, observeEffects, type ObservedEffects } from "./effects.js";
import { applySecondOpinion } from "./second-opinion.js";

// ─── What the host hands over ─────────────────────────────────────────────────

export type VaultAction = "create" | "fund" | "close" | "trigger";

/**
 * A vault as the host read it. None of it is trusted: it is accepted only when
 * `address` is where the factory puts a vault for `owner` with `nonce` and
 * `terms` (see the header), and then every field is the vault's own.
 */
export interface VaultClaim {
  address: Address;
  owner: Address;
  /** The factory nonce the vault was created with; `findVaultNonce` finds it. */
  nonce: bigint;
  terms: VaultTerms;
}

interface VaultIntentBase {
  version: 1;
  chainId: number;
  /** Who signs and sends: the connected wallet. */
  account: Address;
  /** The plan as this browser's config holds it — never as a vault or a link describes it. */
  plan: DcaPlan;
}

export interface VaultCreateIntent extends VaultIntentBase {
  action: "create";
  /** The terms to create with: the plan's own, plus the market, the keeper's reward and the slippage. */
  terms: VaultPlan;
  /** The factory's `nonces(account)` before this creation (`readVaultNonce`): where the vault will land. */
  nonce: bigint;
  /** Chain time — the latest block's timestamp — which the factory judges `startAt` by. */
  nowSeconds: bigint;
}

export interface VaultFundIntent extends VaultIntentBase {
  action: "fund";
  vault: VaultClaim;
  /**
   * As read from the vault just now. They can only narrow what may be sent:
   * the terms bound it anyway, and the vault returns what it does not need.
   */
  buysDone: bigint;
  wethBalance: bigint;
}

export interface VaultCloseIntent extends VaultIntentBase {
  action: "close";
  vault: VaultClaim;
}

export interface VaultTriggerIntent extends VaultIntentBase {
  action: "trigger";
  /** Anyone's vault may be triggered; the reward is the caller's either way. */
  vault: VaultClaim;
  /** The least the owner may receive: the vault's `quote().floorOut`, read just before. */
  floorOut: bigint;
}

export type VaultIntent = VaultCreateIntent | VaultFundIntent | VaultCloseIntent | VaultTriggerIntent;

/** One vault transaction: exactly one call, from `intent.account`. */
export interface VaultTxPlan {
  version: 1;
  intent: VaultIntent;
  calls: Call[];
}

/**
 * Due buys in other people's vaults, made in one transaction through the
 * batcher ("Help run the network"): the fifth transaction, and the only one
 * about vaults that aren't the account's.
 *
 * Not a `VaultIntentBase`: there is no plan to hold it to, because the vaults
 * are strangers'. What protects their owners is each vault's own rules, which
 * nobody who triggers it can change; what this protects is the account — it
 * pays the network fee, so it must be paid the buy fees, and nothing else of
 * its may move.
 */
export interface VaultBatchIntent {
  version: 1;
  action: "batch";
  chainId: number;
  /** Signs, sends, and is paid. */
  account: Address;
  /** In the order they are encoded, and tried. */
  vaults: readonly Address[];
  /** Where every buy fee goes: always `account`. */
  rewardTo: Address;
  /**
   * The least the batch may earn, or it reverts (`TooLittle`): at least 1,
   * sized by the host to cover the network fee at `gasPrice`.
   */
  minRewards: bigint;
  /** The exact gas the call is signed with; the simulation runs at it. */
  gasLimit: bigint;
  /** The exact price the call is signed with. */
  gasPrice: bigint;
}

/**
 * The most vaults one batch from the app carries. The batcher takes 150; this
 * keeps a batch's gas limit near 3 million, and its list short enough for a
 * person to read.
 */
export const MAX_BATCH_TRIGGER_VAULTS = 20;

/** The batch's one call, with the exact gas limit and price it is signed with. */
export interface VaultBatchCall extends Call {
  gas: bigint;
  gasPrice: bigint;
}

/** A batch of vault buys: exactly one call to the batcher, from `intent.account`. */
export interface VaultBatchTxPlan {
  version: 1;
  intent: VaultBatchIntent;
  calls: VaultBatchCall[];
}

const isBatchPlan = (plan: VaultTxPlan | VaultBatchTxPlan): plan is VaultBatchTxPlan =>
  (plan.intent as { action?: unknown }).action === "batch";

export interface VaultGuardOptions {
  chainId: number;
  requireSimulation: boolean;
  /** Which factory, and so which markets: mainnet's by default, which the local fork shares. */
  deployment?: FactoryDeployment;
}

// ─── Small, careful readers ───────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;

/** An address that could own, sign or receive: well-formed, and not the zero address. */
const isUsableAddress = (value: unknown): value is Address =>
  typeof value === "string" && ADDRESS.test(value) && !ZERO.test(value);

const lower = (value: string): Address => value.toLowerCase() as Address;

/**
 * Address equality that answers "no" instead of throwing on a missing field.
 * A Guard that throws has not refused.
 */
const sameAddress = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const UINT256_MAX = (1n << 256n) - 1n;

/** A whole number a contract could hold: a bigint from zero to 2^256 − 1, so no encoder throws on it. */
const isAmount = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= UINT256_MAX;

const TERM_AMOUNTS = ["amountPerBuy", "interval", "maxBuys", "startAt", "keeperReward", "maxSlippageBps"] as const;

/** Terms whose every field is the right kind of thing, so arithmetic on them cannot throw or coerce. */
function termsAreWellFormed(terms: unknown): terms is VaultTerms {
  if (typeof terms !== "object" || terms === null) return false;
  const t = terms as Record<string, unknown>;
  return (
    isUsableAddress(t["tokenOut"]) &&
    isUsableAddress(t["pair"]) &&
    isUsableAddress(t["oraclePool"]) &&
    TERM_AMOUNTS.every((field) => isAmount(t[field]))
  );
}

function planIsWellFormed(plan: unknown): plan is VaultPlan {
  if (typeof plan !== "object" || plan === null) return false;
  const p = plan as Record<string, unknown>;
  return isAmount(p["marketIndex"]) && TERM_AMOUNTS.every((field) => isAmount(p[field]));
}

// ─── The plan against the vault ───────────────────────────────────────────────

/** One way a vault differs from the plan that points at it. */
export interface VaultTermsMismatch {
  field: "sell" | "buy" | "amountPerBuy" | "intervalSeconds" | "maxBuys" | "startAt";
  plan: string;
  vault: string;
}

/**
 * Where a vault's terms differ from the plan in the config, field by field;
 * empty when they agree on everything the plan says.
 *
 * The keeper's reward and the slippage allowance are the vault's alone — a
 * plan has no field for either — so they cannot differ. A plan field that is
 * not a valid number differs from every vault, rather than being skipped.
 * The app shows a non-empty answer as "the vault's terms differ from this
 * plan"; the Guard refuses to fund a vault, or trigger its buy, on one.
 */
export function vaultTermsMismatches(plan: DcaPlan, terms: VaultTerms): VaultTermsMismatch[] {
  const out: VaultTermsMismatch[] = [];
  const whole = (value: unknown): bigint | null => (Number.isSafeInteger(value) ? BigInt(value as number) : null);
  const compare = (field: VaultTermsMismatch["field"], planValue: bigint | null, raw: unknown, vault: bigint) => {
    if (planValue !== vault) out.push({ field, plan: String(raw), vault: vault.toString() });
  };

  // A vault pays with ether, held as WETH; a plan that sells anything else is
  // not the plan this vault carries out.
  if (!sameAddress(plan.sell, NATIVE_TOKEN)) out.push({ field: "sell", plan: String(plan.sell), vault: NATIVE_TOKEN });
  if (!sameAddress(plan.buy, terms.tokenOut)) out.push({ field: "buy", plan: String(plan.buy), vault: terms.tokenOut });
  const perBuy = BaseUnitsSchema.safeParse(plan.amountPerBuy).success ? BigInt(plan.amountPerBuy) : null;
  compare("amountPerBuy", perBuy, plan.amountPerBuy, terms.amountPerBuy);
  compare("intervalSeconds", whole(plan.intervalSeconds), plan.intervalSeconds, terms.interval);
  compare("maxBuys", whole(plan.maxBuys), plan.maxBuys, terms.maxBuys);
  compare("startAt", whole(plan.startAt), plan.startAt, terms.startAt);
  return out;
}

/**
 * The factory nonce a vault was created with, found by predicting each one
 * below the owner's count (`findVaultNonce`), with the bound on that work. They
 * live in @spdex/vault beside `predictVault`, since an owner search proves a
 * vault by its nonce the way a claim does; they are exported from here too,
 * for everything that built a `VaultClaim` with them before.
 */
export { findVaultNonce, MAX_VAULT_NONCE_SEARCH } from "@spdex/vault";

// ─── The static layer ─────────────────────────────────────────────────────────

/**
 * Every check decidable without the chain, the chain check included.
 *
 * Pure and complete, like the tip checks: nothing is left for the
 * caller to remember. And like the schedule checks, nothing here assumes the
 * plan or the claim passed a schema — each figure is checked for shape before
 * any arithmetic, and one that fails refuses rather than throws.
 */
export function runVaultChecks(
  plan: VaultTxPlan | VaultBatchTxPlan,
  chainId: number,
  deployment: FactoryDeployment = MAINNET_DEPLOYMENT,
  factory: Address = lower(factoryAddress(deployment)),
  batcher?: Address,
): GuardViolation[] {
  // Before the plan check below: a batch has no plan (see VaultBatchIntent).
  if (isBatchPlan(plan)) return runBatchChecks(plan, chainId, batcher ?? lower(batcherAddress(factory)));
  const { intent } = plan;
  const violations: GuardViolation[] = [];
  const malformed = (message: string, detail?: Record<string, string>) =>
    violations.push({ code: "VAULT_MALFORMED", message, ...(detail === undefined ? {} : { detail }) });

  const action = (intent as { action?: unknown }).action;
  if (action !== "create" && action !== "fund" && action !== "close" && action !== "trigger") {
    malformed(`"${String(action)}" is not something spDEX does with a vault`);
    return violations;
  }
  if (typeof intent.plan !== "object" || intent.plan === null) {
    malformed("the transaction names no plan to hold it to");
    return violations;
  }

  if (intent.chainId !== chainId) {
    violations.push({
      code: "CHAIN_MISMATCH",
      message: `vault transaction targets chain ${intent.chainId}, host is on ${chainId}`,
      detail: { expected: String(chainId), actual: String(intent.chainId) },
    });
  }
  // The factory's address is the same on every chain it is deployed to, so
  // nothing on chain would notice a plan written for another one.
  if (intent.plan.chainId !== chainId) {
    violations.push({
      code: "CHAIN_MISMATCH",
      message: `the plan is for chain ${intent.plan.chainId}, the host is on ${chainId}`,
      detail: { expected: String(chainId), actual: String(intent.plan.chainId) },
    });
  }

  if (!isUsableAddress(intent.account)) {
    malformed("the transaction names no account to send it", { account: String(intent.account) });
    return violations;
  }
  const account = lower(intent.account);

  if (intent.plan.signer !== "vault") {
    malformed(`the plan signs with "${String(intent.plan.signer)}", not a vault`, { planId: String(intent.plan.id) });
  }

  if (plan.calls.length !== 1) {
    malformed(`a vault transaction is one call, not ${plan.calls.length}`);
    return violations;
  }
  const call = plan.calls[0]!;
  const target = String(call.to).toLowerCase();
  const data = String(call.data).toLowerCase();
  if (typeof call.value !== "bigint" || call.value < 0n) {
    malformed(`the call sends ${String(call.value)} wei, which is not an amount`);
    return violations;
  }

  /** The call must be exactly `expected`, sent to `to`: the whole calldata, not just the selector. */
  const expectCall = (to: Address, expected: Hex, what: string) => {
    if (target !== to) malformed(`the ${what} is sent to ${target}, not ${to}`, { expected: to, actual: target });
    if (data !== expected.toLowerCase()) {
      malformed(`the call is not the ${what} its intent describes`, { expected, actual: data });
    }
  };

  if (intent.action === "create") {
    const terms = intent.terms;
    if (intent.plan.vault !== undefined) {
      // A plan has one vault. A second would leave the config pointing at one
      // and the money in two, with nothing in this browser leading to the other.
      malformed(`the plan already has a vault, ${intent.plan.vault}`, { vault: String(intent.plan.vault) });
    }
    if (!planIsWellFormed(terms)) {
      malformed("the vault's terms are not all whole, non-negative numbers");
      return violations;
    }
    if (!isAmount(intent.nonce)) malformed(`${String(intent.nonce)} is not a factory nonce`);

    let expected: VaultTerms | null = null;
    try {
      expected = termsOfPlan(terms, deployment);
    } catch {
      // A market off the factory's list: `termsProblems` names it below.
    }
    if (expected !== null) {
      for (const mismatch of vaultTermsMismatches(intent.plan, expected)) {
        malformed(`the vault would ${mismatchWords(mismatch)}`, { ...mismatch });
      }
    }
    if (typeof intent.nowSeconds !== "bigint") {
      malformed("the creation has no chain time to judge its start by");
    } else {
      // The factory's own refusals, named before anyone pays gas to hear them.
      // Its limit on the buy fee is said once, below, with its figures.
      for (const problem of termsProblems(terms, intent.nowSeconds, deployment)) {
        if (problem === "RewardTooLarge" && terms.amountPerBuy > 0n) continue;
        malformed(`the factory would refuse these terms: ${problem}`, { error: problem });
      }
    }
    // The 0.69% ceiling on the buy fee (see the header): a draft sized under
    // an older rule, or terms from a link, can't ask for a vault that pays
    // more. A zero amount is the factory's refusal above, and has no ceiling
    // to be over.
    if (terms.amountPerBuy > 0n && !withinFeeCeiling(terms.keeperReward, terms.amountPerBuy)) {
      const ceiling = feeCeiling(terms.amountPerBuy);
      const percent = feeShareText(Number(BUY_FEE_CEILING_BPS));
      malformed(`the buy fee is ${terms.keeperReward} wei, above the ${percent}% ceiling (${ceiling} wei)`, {
        reward: terms.keeperReward.toString(),
        ceiling: ceiling.toString(),
      });
    }

    expectCall(factory, encodeCreateVault(terms), "vault creation");
    // Up to the whole budget may be sent along: it arrives in the vault as
    // WETH. More is refused by the factory as well, but only on chain.
    const budget = vaultBudget(terms);
    if (call.value > budget) {
      malformed(`the creation sends ${call.value} wei, more than the plan's whole budget of ${budget}`, {
        value: call.value.toString(),
        budget: budget.toString(),
      });
    }
    return violations;
  }

  // Fund, close and trigger all act on an existing vault, and only the
  // plan's own. The claim is checked against its address before anything
  // else about it is used.
  const claim = intent.vault;
  if (
    typeof claim !== "object" ||
    claim === null ||
    !isUsableAddress(claim.address) ||
    !isUsableAddress(claim.owner) ||
    !isAmount(claim.nonce) ||
    !termsAreWellFormed(claim.terms)
  ) {
    malformed("the transaction does not say which vault, whose, and on what terms");
    return violations;
  }
  const vault = lower(claim.address);
  const owner = lower(claim.owner);

  let predicted: Address | null = null;
  try {
    predicted = lower(predictVault({ factory, owner, nonce: claim.nonce, terms: claim.terms }));
  } catch {
    // Terms too large to pack into a clone: no factory vault has them.
  }
  if (predicted !== vault) {
    malformed(`${vault} is not the factory's vault for ${owner} on these terms`, {
      vault,
      owner,
      ...(predicted === null ? {} : { predicted }),
    });
    // Every check below reads the claim, which is now unproved.
    return violations;
  }

  if (!sameAddress(intent.plan.vault, vault)) {
    malformed(`the plan's vault is ${String(intent.plan.vault)}, not ${vault}`, {
      expected: String(intent.plan.vault),
      actual: vault,
    });
  }

  if (intent.action === "fund" || intent.action === "close") {
    // Only the owner can do either — the vault refuses anyone else — and
    // funding someone else's vault would be a gift, not a plan.
    if (owner !== account) {
      malformed(`the vault belongs to ${owner}, not the account sending this`, { owner, account });
    }
  }

  // Funding and a buy both spend by the plan's terms, so they must be the
  // plan's terms. Closing is not held to that: it only ever returns the
  // owner's money, and a config that disagrees with the vault is no reason to
  // keep someone from their own funds.
  if (intent.action !== "close") {
    for (const mismatch of vaultTermsMismatches(intent.plan, claim.terms)) {
      malformed(`the vault's terms differ from the plan: it would ${mismatchWords(mismatch)}`, { ...mismatch });
    }
  }

  if (intent.action === "fund") {
    expectCall(vault, encodeFund(), "funding");
    const { buysDone, wethBalance } = intent;
    if (!isAmount(buysDone) || buysDone > claim.terms.maxBuys || !isAmount(wethBalance)) {
      // More buys done than the vault has would make the room negative.
      malformed("the vault's progress or balance, as read, cannot be true", {
        buysDone: String(buysDone),
        wethBalance: String(wethBalance),
      });
      return violations;
    }
    // The vault's own arithmetic in `fund` (and `fundingRoom`'s): what the
    // remaining buys and their rewards need, less what it already holds.
    const need = (claim.terms.maxBuys - buysDone) * (claim.terms.amountPerBuy + claim.terms.keeperReward);
    const room = need > wethBalance ? need - wethBalance : 0n;
    if (call.value === 0n) {
      malformed("the funding sends nothing");
    } else if (room === 0n) {
      malformed("the vault already holds what its remaining buys and their buy fees need", {
        wethBalance: wethBalance.toString(),
      });
    } else if (call.value > room) {
      malformed(`the funding sends ${call.value} wei, more than the remaining buys need (${room})`, {
        value: call.value.toString(),
        room: room.toString(),
      });
    }
    return violations;
  }

  if (call.value !== 0n) {
    // Neither closing nor a buy takes ether. Attaching some is how a
    // plain-looking call smuggles value out.
    malformed(`the call attaches ${call.value} wei, and ${intent.action === "close" ? "closing" : "a buy"} takes none`, {
      value: call.value.toString(),
    });
  }

  if (intent.action === "close") {
    expectCall(vault, encodeClose(), "close");
    return violations;
  }

  expectCall(vault, encodeExecute(), "buy");
  // With nobody's price in front of them, a buy with no floor would accept
  // any price. The vault keeps its own, and this is the host's reading of it.
  if (typeof intent.floorOut !== "bigint" || intent.floorOut <= 0n) {
    malformed("the buy has no price floor to hold the owner's receipt to", { floorOut: String(intent.floorOut) });
  }
  return violations;
}

function mismatchWords(mismatch: VaultTermsMismatch): string {
  switch (mismatch.field) {
    case "sell":
      return `sell ${mismatch.vault}, not the plan's ${mismatch.plan}`;
    case "buy":
      return `buy ${mismatch.vault}, not the plan's ${mismatch.plan}`;
    case "amountPerBuy":
      return `spend ${mismatch.vault} a buy, not the plan's ${mismatch.plan}`;
    case "intervalSeconds":
      return `buy every ${mismatch.vault}s, not the plan's ${mismatch.plan}s`;
    case "maxBuys":
      return `make ${mismatch.vault} buys, not the plan's ${mismatch.plan}`;
    case "startAt":
      return `start at ${mismatch.vault}, not the plan's ${mismatch.plan}`;
  }
}

/**
 * A batch's static checks: one call to the batcher `factory` is bound to —
 * computed, never read from a registry — carrying no ether and exactly the
 * `executeBatch` its intent describes, every buy fee to the account, and the
 * exact gas limit and price the simulation runs at and the wallet signs.
 */
function runBatchChecks(plan: VaultBatchTxPlan, chainId: number, batcher: Address): GuardViolation[] {
  const { intent } = plan;
  const violations: GuardViolation[] = [];
  const malformed = (message: string, detail?: Record<string, string>) =>
    violations.push({ code: "VAULT_MALFORMED", message, ...(detail === undefined ? {} : { detail }) });

  if (intent.chainId !== chainId) {
    violations.push({
      code: "CHAIN_MISMATCH",
      message: `the batch targets chain ${String(intent.chainId)}, the host is on ${chainId}`,
      detail: { expected: String(chainId), actual: String(intent.chainId) },
    });
  }
  if (!isUsableAddress(intent.account)) {
    malformed("the batch names no account to send it", { account: String(intent.account) });
    return violations;
  }
  const account = lower(intent.account);

  // Anyone may name any `rewardTo`. The app names the account, always: it is
  // the account that pays the network fee.
  if (!sameAddress(intent.rewardTo, account)) {
    malformed(`the buy fees would go to ${String(intent.rewardTo)}, not the account paying for the batch`, {
      rewardTo: String(intent.rewardTo),
      account,
    });
  }

  const vaults = intent.vaults as unknown;
  let listOk = Array.isArray(vaults);
  if (!Array.isArray(vaults) || vaults.length === 0 || vaults.length > MAX_BATCH_TRIGGER_VAULTS) {
    malformed(`a batch carries 1 to ${MAX_BATCH_TRIGGER_VAULTS} vaults, not ${Array.isArray(vaults) ? vaults.length : "none"}`);
    listOk = false;
  }
  if (Array.isArray(vaults)) {
    const seen = new Set<string>();
    for (const [index, vault] of vaults.entries()) {
      if (!isUsableAddress(vault)) {
        malformed(`vault ${index} is not an address`, { index: String(index), vault: String(vault) });
        listOk = false;
        continue;
      }
      if (seen.has(vault.toLowerCase())) {
        // A vault can buy once per window, so the second attempt only burns gas.
        malformed(`vault ${index} is listed twice`, { index: String(index), vault: lower(vault) });
      }
      seen.add(vault.toLowerCase());
    }
  }
  const minRewardsOk = isAmount(intent.minRewards) && intent.minRewards >= 1n;
  if (!minRewardsOk) {
    // Zero accepts a batch that earns nothing — one someone else's copy got
    // to first — and still costs its network fee.
    malformed(`the batch's least reward is ${String(intent.minRewards)}, not at least 1 wei`, { minRewards: String(intent.minRewards) });
  }

  const gasLimit = intent.gasLimit;
  const gasPrice = intent.gasPrice;
  if (!isAmount(gasLimit) || !isAmount(gasPrice) || gasPrice === 0n) {
    malformed("the batch's gas limit or price is not a positive whole number", { gasLimit: String(gasLimit), gasPrice: String(gasPrice) });
  } else if (listOk && Array.isArray(vaults)) {
    // Room for every vault to be tried as a later buy, the cheaper kind, and
    // no more than a transaction may carry. The batcher gives each vault a
    // fixed cap only while enough gas is left, so a limit below this leaves
    // the last vaults `NotTried`.
    const least = batchGasLimit(vaults.map(() => ({ firstBuy: false })));
    if (gasLimit < least || gasLimit > MAX_BATCH_GAS_CEILING) {
      malformed(`the batch's gas limit of ${gasLimit} is outside ${least} to ${MAX_BATCH_GAS_CEILING} for ${vaults.length} vaults`, {
        gasLimit: gasLimit.toString(),
        least: least.toString(),
        most: MAX_BATCH_GAS_CEILING.toString(),
      });
    }
  }

  if (plan.calls.length !== 1) {
    malformed(`a batch is one call, not ${plan.calls.length}`);
    return violations;
  }
  const call = plan.calls[0]!;
  const target = String(call.to).toLowerCase();
  if (target !== batcher) malformed(`the batch is sent to ${target}, not the batcher ${batcher}`, { expected: batcher, actual: target });
  if (call.value !== 0n) {
    malformed(`the batch attaches ${String(call.value)} wei, and a batch takes none`, { value: String(call.value) });
  }
  // What the simulation runs at is what is signed, and both are the intent's.
  if (call.gas !== gasLimit || call.gasPrice !== gasPrice) {
    malformed("the call's gas limit or price is not the batch's", {
      gas: String(call.gas),
      gasLimit: String(gasLimit),
      gasPrice: String(call.gasPrice),
      intentGasPrice: String(gasPrice),
    });
  }
  if (listOk && minRewardsOk && isUsableAddress(intent.rewardTo)) {
    let expected: Hex | null = null;
    try {
      // Lowercased: the encoder checks a mixed-case address's checksum, and
      // the bytes are the same either way.
      expected = encodeExecuteBatch(intent.vaults.map(lower), lower(intent.rewardTo), intent.minRewards);
    } catch {
      // Left null: nothing equals it.
    }
    if (expected === null || String(call.data).toLowerCase() !== expected.toLowerCase()) {
      malformed("the call is not the batch its intent describes", { ...(expected === null ? {} : { expected }), actual: String(call.data).toLowerCase() });
    }
  }
  return violations;
}

// ─── The simulated layer ──────────────────────────────────────────────────────

/** WETH9's `Deposit(address indexed dst, uint256 wad)` and `Withdrawal(address indexed src, uint256 wad)`. */
const WETH_DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WETH_WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

/**
 * What a simulation moved, with WETH counted in full.
 *
 * `observeEffects` reads `Transfer`s, and wrapping or unwrapping changes a
 * WETH balance with a `Deposit` or `Withdrawal` instead — which is how a
 * vault's budget arrives and leaves. WETH9 changes a balance in no other way,
 * so transfers plus these two are the whole of it. Ether moved by value
 * arrives as `Transfer`s from `NATIVE_TOKEN`, courtesy of `traceTransfers`.
 */
interface Movements {
  effects: ObservedEffects;
  /** Net WETH wrapped for (positive) or unwrapped by (negative) each account. */
  wrapped: Map<Address, bigint>;
  undecodable: number;
}

function readMovements(logs: SimLog[], weth: Address): Movements {
  const effects = observeEffects(logs);
  const wrapped = new Map<Address, bigint>();
  let undecodable = effects.undecodable;
  for (const log of logs) {
    if (!sameAddress(log.address, weth)) continue;
    const topic = log.topics[0]?.toLowerCase();
    const sign = topic === WETH_DEPOSIT ? 1n : topic === WETH_WITHDRAWAL ? -1n : 0n;
    if (sign === 0n) continue;
    const who = log.topics[1];
    // A wrap we cannot read is counted, not ignored, as a transfer is.
    if (!who || who.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      undecodable += 1;
      continue;
    }
    const account = lower(`0x${who.slice(26)}`);
    wrapped.set(account, (wrapped.get(account) ?? 0n) + sign * BigInt(log.data));
  }
  return { effects, wrapped, undecodable };
}

const etherOf = (moved: Movements, account: Address): bigint => deltaFor(moved.effects, NATIVE_TOKEN, account);
const wethOf = (moved: Movements, weth: Address, account: Address): bigint =>
  deltaFor(moved.effects, weth, account) + (moved.wrapped.get(account) ?? 0n);

/**
 * Check a vault transaction: static, then simulated from the account.
 *
 * Its own class rather than an option on the Guard, for the reason every path
 * here has one: an option on a check is one edit away from an exemption in it.
 * The swap Guard does not run: a vault transaction is not a swap, and a buy
 * the vault makes is judged by the vault's own floor and by the effects below.
 */
export class VaultGuard {
  readonly #deployment: FactoryDeployment;
  readonly #factory: Address;
  readonly #weth: Address;
  #batcher: Address | null = null;

  constructor(
    private readonly simulation: SimulationProvider,
    private readonly options: VaultGuardOptions,
  ) {
    this.#deployment = options.deployment ?? MAINNET_DEPLOYMENT;
    // Computed once: it hashes the factory's whole creation code.
    this.#factory = lower(factoryAddress(this.#deployment));
    this.#weth = lower(this.#deployment.weth);
  }

  /** The factory this Guard holds creations to. */
  get factory(): Address {
    return this.#factory;
  }

  /** The batcher bound to that factory: the only place a batch may go. Computed, never read. */
  get batcher(): Address {
    this.#batcher ??= lower(batcherAddress(this.#factory));
    return this.#batcher;
  }

  async check(plan: VaultTxPlan | VaultBatchTxPlan): Promise<GuardVerdict> {
    if (isBatchPlan(plan)) return this.#checkBatch(plan);
    const staticViolations = runVaultChecks(plan, this.options.chainId, this.#deployment, this.#factory);
    if (staticViolations.length > 0) return rejected(staticViolations);

    // Non-null: the static layer refuses anything but exactly one call.
    const sendsEther = plan.calls[0]!.value > 0n;
    // Never signed on the static layer alone, and never on one service's
    // test-run when a second was set and didn't answer.
    const neverUnchecked = sendsEther || this.options.requireSimulation;
    const unchecked = (violation: GuardViolation): GuardVerdict => {
      if (sendsEther) {
        return rejected([
          {
            ...violation,
            // See the header: the code at a fixed address is the one thing the
            // static layer cannot establish, and ether sent where there is none
            // is gone.
            message: `${violation.message}; a vault transaction that sends ether is never signed unchecked`,
          },
        ]);
      }
      return this.options.requireSimulation ? rejected([violation]) : unverified([violation]);
    };

    if (!(await this.simulation.isAvailable())) {
      return unchecked({
        code: "SIMULATION_UNAVAILABLE",
        message: "this RPC cannot simulate transactions, so the vault transaction has not been verified",
        detail: { provider: this.simulation.kind },
      });
    }

    let outcome;
    try {
      outcome = await this.simulation.simulate({
        chainId: this.options.chainId,
        account: plan.intent.account,
        calls: plan.calls,
      });
    } catch (error) {
      return unchecked({
        code: "SIMULATION_UNAVAILABLE",
        message:
          error instanceof SimulationUnavailableError
            ? error.message
            : `simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const judged =
      outcome.status === "reverted"
        ? rejected([{ code: "SIMULATION_REVERTED", message: outcome.revertReason ?? "the vault transaction reverts" }])
        : this.#checkEffects(plan, outcome.logs);
    // Last, after this service's own checks (see second-opinion.ts).
    return applySecondOpinion(judged, outcome, { neverUnchecked });
  }

  /**
   * A batch of buys in other people's vaults: static, then simulated at the
   * exact gas it is signed with, and never signed unchecked — not without a
   * simulation, and not on one service's when a second was set and didn't
   * answer. A batch for strangers has no reason to go unchecked, and what it
   * earns is known only from its simulation.
   */
  async #checkBatch(plan: VaultBatchTxPlan): Promise<GuardVerdict> {
    const staticViolations = runVaultChecks(plan, this.options.chainId, this.#deployment, this.#factory, this.batcher);
    if (staticViolations.length > 0) return rejected(staticViolations);
    const never = (message: string, detail?: Record<string, string>): GuardVerdict =>
      rejected([
        {
          code: "SIMULATION_UNAVAILABLE",
          message: `${message}; a batch of vault buys is never signed unchecked`,
          ...(detail === undefined ? {} : { detail }),
        },
      ]);

    if (!(await this.simulation.isAvailable())) {
      return never("this RPC cannot simulate transactions", { provider: this.simulation.kind });
    }
    let outcome: SimulationOutcome;
    try {
      outcome = await this.simulation.simulate({
        chainId: this.options.chainId,
        account: plan.intent.account,
        calls: plan.calls.map(({ to, data, value }) => ({ to, data, value })),
        // The batcher reads `gasleft()` before every vault: at another limit
        // this would be a simulation of another transaction.
        gas: plan.intent.gasLimit,
      });
    } catch (error) {
      return never(
        error instanceof SimulationUnavailableError
          ? error.message
          : `simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let judged: GuardVerdict;
    if (outcome.status === "reverted") {
      // `NothingBought` or `TooLittle`, with each vault's reason, when the
      // service reported the revert data.
      const why = outcome.returnData === undefined ? null : decodeBatchRevert(plan.intent.vaults.map(lower), outcome.returnData);
      const reasons = why?.outcomes.filter((o) => !o.bought).map((o) => o.reasonName ?? o.reason ?? "unknown") ?? [];
      judged = rejected([
        {
          code: "SIMULATION_REVERTED",
          message:
            why === null
              ? (outcome.revertReason ?? "the batch reverts")
              : `the batch reverts: ${why.kind}${reasons.length > 0 ? ` (${[...new Set(reasons)].join(", ")})` : ""}`,
          ...(why === null ? {} : { detail: { reason: why.kind, ...(reasons.length > 0 ? { vaults: [...new Set(reasons)].join(",") } : {}) } }),
        },
      ]);
    } else {
      judged = this.#checkBatchEffects(plan, outcome.logs, outcome.gasUsed);
    }
    return applySecondOpinion(judged, outcome, { neverUnchecked: true });
  }

  /**
   * What a batch did, from its simulated logs: the batcher's own `Batch`, each
   * vault's `Bought` joined to the batcher's `Triggered` by position, and the
   * balances they moved.
   */
  #checkBatchEffects(plan: VaultBatchTxPlan, logs: SimLog[], gasUsed: bigint): GuardVerdict {
    const { intent } = plan;
    const account = lower(intent.account);
    const batcher = this.batcher;
    const weth = this.#weth;
    const listed = intent.vaults.map(lower);
    const moved = readMovements(logs, weth);
    const violations: GuardViolation[] = [];
    const push = (code: GuardViolation["code"], message: string, detail?: Record<string, string>) =>
      violations.push({ code, message, ...(detail === undefined ? {} : { detail }) });

    if (moved.undecodable > 0) {
      push("UNDECODABLE_EFFECTS", `${moved.undecodable} transfer, approval or wrap events could not be decoded`, {
        count: String(moved.undecodable),
      });
    }

    // ── It pays for itself ──

    // The least it may earn, which the batcher enforces on chain, covers the
    // network fee of the gas this very test-run used, at the price it's
    // signed with. The host sizes `minRewards` from a test-run of its own,
    // made earlier through the main service alone; without this, "offered
    // only when the fees cover it" would rest on that one answer. With a
    // second opinion, the gas is the larger of the two services' figures.
    // No margin is added: the host already adds 10% to its own figure, and
    // this run is of the final call itself, so an honest offer clears it.
    const fee = gasUsed * intent.gasPrice;
    if (intent.minRewards < fee) {
      push(
        "VAULT_NOT_DELIVERED",
        `the batch's least reward of ${intent.minRewards} wei doesn't cover its network fee of ${fee} wei (${gasUsed} gas at ${intent.gasPrice} wei)`,
        { minRewards: intent.minRewards.toString(), fee: fee.toString(), gasUsed: gasUsed.toString(), gasPrice: intent.gasPrice.toString() },
      );
    }

    // ── The batcher's account of it ──

    // Positions as the chain would give them. The `traceTransfers`
    // pseudo-logs are not logs on chain, so they are left out of the count:
    // a `Triggered` is joined to the log right before it.
    const indexed = logs.filter((log) => !sameAddress(log.address, NATIVE_TOKEN)).map((log, logIndex) => ({ ...log, logIndex }));
    const runs = joinBatchLogs(indexed, (address) => address === batcher);
    const run = runs.length === 1 ? runs[0]! : null;
    const batch = run?.batch ?? null;
    if (run === null || batch === null) {
      // Only the batcher's own `Batch` says what the batch did: anyone can
      // emit one shaped like it.
      push("VAULT_MALFORMED", `the batcher reports ${runs.filter((r) => r.batch !== null).length} batches, not one`, { batcher });
    }
    let earned: bigint | null = null;
    if (batch !== null) {
      earned = batch.earned;
      if (batch.caller !== account || batch.rewardTo !== account) {
        push("VAULT_MALFORMED", `the batch is credited to ${batch.rewardTo}, called by ${batch.caller}, not the account sending it`, {
          caller: batch.caller,
          rewardTo: batch.rewardTo,
          account,
        });
      }
      if (batch.listed !== BigInt(listed.length) || batch.tried !== BigInt(listed.length)) {
        // `tried` below `listed`: the gas ran out, and the rest were never
        // attempted (`NotTried`), which the limit exists to rule out.
        push("VAULT_MALFORMED", `the batch tries ${batch.tried} of ${batch.listed} vaults, and lists ${listed.length}`, {
          listed: batch.listed.toString(),
          tried: batch.tried.toString(),
        });
      }
      if (batch.bought < 1n) push("VAULT_NOT_DELIVERED", "the batch makes no buy", { bought: batch.bought.toString() });
      if (batch.earned < intent.minRewards) {
        push("VAULT_NOT_DELIVERED", `the batch earns ${batch.earned} wei of WETH, less than its least of ${intent.minRewards}`, {
          earned: batch.earned.toString(),
          minRewards: intent.minRewards.toString(),
        });
      }
      if (batch.swept !== 0n) {
        push(
          "VAULT_BATCH_UNACCOUNTED",
          `the batcher holds ${batch.swept} wei of WETH someone sent it, and the batch would pass it to the account`,
          { swept: batch.swept.toString() },
        );
      }
    }

    // ── Each vault: tried once, bought by its own rules, or refused for a reason of its own ──

    const seen = new Map<Address, "triggered" | "not">();
    let triggered = 0n;
    for (const { event, bought } of run?.triggered ?? []) {
      triggered += 1n;
      const vault = event.vault;
      if (!listed.includes(vault)) {
        push("VAULT_MALFORMED", `the batch triggers ${vault}, which it does not list`, { vault });
        continue;
      }
      if (seen.has(vault)) push("VAULT_MALFORMED", `the batch tries ${vault} twice`, { vault });
      seen.set(vault, "triggered");
      if (bought === null) {
        push("VAULT_MALFORMED", `${vault} is reported bought with no buy of its own right before`, { vault });
        continue;
      }
      if (bought.keeper !== batcher) {
        push("VAULT_MALFORMED", `${vault}'s buy is credited to ${bought.keeper}, not the batcher`, { vault, keeper: bought.keeper });
      }
      if (bought.amountOut < bought.floorOut) {
        push("VAULT_NOT_DELIVERED", `${vault} delivers ${bought.amountOut}, below its floor of ${bought.floorOut}`, {
          vault,
          amountOut: bought.amountOut.toString(),
          floorOut: bought.floorOut.toString(),
        });
      }
      // The vault parts with its buy and its fee, exactly, and nothing else.
      const spent = -wethOf(moved, weth, vault);
      const allowed = bought.amountIn + bought.reward;
      if (spent !== allowed) {
        push("UNEXPECTED_TOKEN_TRANSFER", `${spent} of WETH leaves ${vault}, not its buy and buy fee (${allowed})`, {
          account: vault,
          token: weth,
          amount: spent.toString(),
          allowed: allowed.toString(),
        });
      }
      this.#nothingElseLeaves(moved, vault, push);
    }
    for (const event of run?.notTriggered ?? []) {
      const vault = event.vault;
      if (!listed.includes(vault)) {
        push("VAULT_MALFORMED", `the batch reports ${vault}, which it does not list`, { vault });
        continue;
      }
      if (seen.has(vault)) push("VAULT_MALFORMED", `the batch tries ${vault} twice`, { vault });
      seen.set(vault, "not");
      if (event.reasonName === "NotFromFactory" || event.reasonName === "NotTried") {
        push("VAULT_MALFORMED", `the batcher reports ${vault} as ${event.reasonName}`, { vault, reason: event.reasonName });
      }
      // A vault that didn't buy parts with nothing.
      if (wethOf(moved, weth, vault) < 0n) push("UNEXPECTED_TOKEN_TRANSFER", `WETH leaves ${vault}, which made no buy`, { account: vault, token: weth });
      this.#nothingElseLeaves(moved, vault, push);
    }
    for (const vault of listed) {
      if (!seen.has(vault)) {
        // No event at all: never attempted, because the gas ran out first.
        push("VAULT_MALFORMED", `${vault} is left untried`, { vault, reason: "NotTried" });
      }
    }
    if (batch !== null && triggered !== batch.bought) {
      push("VAULT_MALFORMED", `the batch reports ${batch.bought} buys and ${triggered} are triggered`, {
        bought: batch.bought.toString(),
        triggered: triggered.toString(),
      });
    }

    // ── The account: paid the buy fees, and nothing of its moves ──

    const received = wethOf(moved, weth, account);
    if (earned !== null && received < earned) {
      push("VAULT_NOT_DELIVERED", `the account receives ${received} wei of WETH, and the batch earns ${earned}`, {
        received: received.toString(),
        earned: earned.toString(),
      });
    }
    const etherLost = -etherOf(moved, account);
    if (etherLost > 0n) {
      push("UNEXPECTED_ETH_TRANSFER", `${etherLost} wei leaves the account, and a batch sends none`, { amount: etherLost.toString() });
    }
    for (const delta of moved.effects.deltas.values()) {
      if (delta.account !== account || delta.delta >= 0n || delta.token === NATIVE_TOKEN) continue;
      push("UNEXPECTED_TOKEN_TRANSFER", `${-delta.delta} of ${delta.token} leaves the account`, {
        token: delta.token,
        amount: (-delta.delta).toString(),
      });
    }
    for (const granted of moved.effects.approvals) {
      if (granted.owner !== account || granted.amount === 0n) continue;
      push("UNEXPECTED_APPROVAL", `the batch grants ${granted.spender} an allowance of ${granted.token}`, {
        token: granted.token,
        spender: granted.spender,
      });
    }

    return violations.length > 0 ? rejected(violations) : verified();
  }

  /** Nothing but WETH leaves `vault`: not ether, not any other token. */
  #nothingElseLeaves(
    moved: Movements,
    vault: Address,
    push: (code: GuardViolation["code"], message: string, detail?: Record<string, string>) => void,
  ): void {
    for (const delta of moved.effects.deltas.values()) {
      if (delta.account !== vault || delta.delta >= 0n || delta.token === this.#weth) continue;
      push("UNEXPECTED_TOKEN_TRANSFER", `${-delta.delta} of ${delta.token} leaves ${vault}`, {
        account: vault,
        token: delta.token,
        amount: (-delta.delta).toString(),
      });
    }
  }

  #checkEffects(plan: VaultTxPlan, logs: SimLog[]): GuardVerdict {
    const { intent } = plan;
    const account = lower(intent.account);
    const value = plan.calls[0]!.value;
    const weth = this.#weth;
    const moved = readMovements(logs, weth);
    const violations: GuardViolation[] = [];
    const push = (code: GuardViolation["code"], message: string, detail?: Record<string, string>) =>
      violations.push({ code, message, ...(detail === undefined ? {} : { detail }) });

    if (moved.undecodable > 0) {
      push("UNDECODABLE_EFFECTS", `${moved.undecodable} transfer, approval or wrap events could not be decoded`, {
        count: String(moved.undecodable),
      });
    }

    // ── Nothing leaves the account but the ether it sends ──

    const etherLost = -etherOf(moved, account);
    if (etherLost > value) {
      push("UNEXPECTED_ETH_TRANSFER", `${etherLost} wei leaves the account, and the transaction sends ${value}`, {
        amount: etherLost.toString(),
        declared: value.toString(),
      });
    }
    const wethLost = -wethOf(moved, weth, account);
    if (wethLost > 0n) {
      push("UNEXPECTED_TOKEN_TRANSFER", `${wethLost} of WETH leaves the account`, {
        token: weth,
        amount: wethLost.toString(),
      });
    }
    for (const delta of moved.effects.deltas.values()) {
      if (delta.account !== account || delta.delta >= 0n) continue;
      if (delta.token === NATIVE_TOKEN || delta.token === weth) continue;
      push("UNEXPECTED_TOKEN_TRANSFER", `${-delta.delta} of ${delta.token} leaves the account`, {
        token: delta.token,
        amount: (-delta.delta).toString(),
      });
    }
    // None of the four needs an allowance. One appearing means the call was
    // not what it claimed to be. Revocations only reduce authority.
    for (const granted of moved.effects.approvals) {
      if (granted.owner !== account || granted.amount === 0n) continue;
      push("UNEXPECTED_APPROVAL", `the transaction grants ${granted.spender} an allowance of ${granted.token}`, {
        token: granted.token,
        spender: granted.spender,
      });
    }

    switch (intent.action) {
      case "create":
        this.#checkCreation(intent, value, logs, moved, push);
        break;
      case "fund": {
        // What the vault kept is what left the account: it may send some
        // back, but none of what it keeps may land anywhere but its WETH.
        // Anything past the value is refused above, so it is not counted here.
        const vault = lower(intent.vault.address);
        const kept = wethOf(moved, weth, vault);
        const paid = etherLost <= 0n ? 0n : etherLost < value ? etherLost : value;
        if (paid === 0n || kept < paid) {
          push("VAULT_NOT_DELIVERED", `the vault's WETH rises by ${kept}, and ${paid} wei left the account for it`, {
            vault,
            received: kept.toString(),
            paid: paid.toString(),
          });
        }
        break;
      }
      case "close":
        this.#checkClose(lower(intent.vault.address), account, moved, push);
        break;
      case "trigger":
        this.#checkBuy(intent, account, logs, moved, push);
        break;
    }

    return violations.length > 0 ? rejected(violations) : verified();
  }

  /** The factory announces one vault — this account's, on these terms, where predicted — holding every wei sent. */
  #checkCreation(
    intent: VaultCreateIntent,
    value: bigint,
    logs: SimLog[],
    moved: Movements,
    push: (code: GuardViolation["code"], message: string, detail?: Record<string, string>) => void,
  ): void {
    // Only the factory's own logs say what the factory did: any contract can
    // emit an event with `VaultCreated`'s signature (see `vaultsCreatedBy`).
    const created = vaultsCreatedBy(this.#factory, logs);
    if (created.length !== 1) {
      push("VAULT_MALFORMED", `the factory announces ${created.length} vaults, not one`, { count: String(created.length) });
      return;
    }
    const event = created[0]!;
    const account = lower(intent.account);
    // Both computable: the static layer refused a market off the list and
    // terms the factory would refuse, which are the terms too large to pack.
    const expected = termsOfPlan(intent.terms, this.#deployment);
    let where: Address | null = null;
    try {
      where = lower(predictVault({ factory: this.#factory, owner: account, nonce: intent.nonce, terms: expected }));
    } catch {
      // Left null, which no vault's address equals.
    }

    if (event.owner !== account) {
      push("VAULT_MALFORMED", `the vault is created for ${event.owner}, not the account creating it`, {
        owner: event.owner,
        account,
      });
    }
    if (event.marketIndex !== intent.terms.marketIndex) {
      push("VAULT_MALFORMED", `the vault is created on market ${event.marketIndex}, not ${intent.terms.marketIndex}`);
    }
    const differing = (Object.keys(expected) as (keyof VaultTerms)[]).filter(
      (field) => String(event.terms[field]).toLowerCase() !== String(expected[field]).toLowerCase(),
    );
    if (differing.length > 0) {
      push("VAULT_MALFORMED", `the vault is created with other terms (${differing.join(", ")})`, {
        fields: differing.join(","),
      });
    }
    // The address the host will record in the plan, known before signing. A
    // vault anywhere else would leave the config pointing at nothing.
    if (event.vault !== where) {
      push("VAULT_MALFORMED", `the vault is created at ${event.vault}, not the predicted ${String(where)}`, {
        vault: event.vault,
        predicted: String(where),
      });
    }

    const held = wethOf(moved, this.#weth, event.vault);
    if (held < value) {
      push("VAULT_NOT_DELIVERED", `the new vault holds ${held} of WETH, and the creation sent ${value}`, {
        vault: event.vault,
        received: held.toString(),
        paid: value.toString(),
      });
    }
  }

  /**
   * The account only receives, and receives at least what the vault gave up.
   *
   * Counted per token, with ether and WETH as one: the vault holds WETH and
   * returns ether, or WETH when the owner cannot take ether.
   */
  #checkClose(
    vault: Address,
    account: Address,
    moved: Movements,
    push: (code: GuardViolation["code"], message: string, detail?: Record<string, string>) => void,
  ): void {
    const weth = this.#weth;
    const gaveUp = -(wethOf(moved, weth, vault) + etherOf(moved, vault));
    const received = wethOf(moved, weth, account) + etherOf(moved, account);
    if (received < gaveUp) {
      push("VAULT_NOT_DELIVERED", `the vault gives up ${gaveUp} wei of ether and WETH, and the owner receives ${received}`, {
        vault,
        gaveUp: gaveUp.toString(),
        received: received.toString(),
      });
    }
    for (const delta of moved.effects.deltas.values()) {
      if (delta.account !== vault || delta.delta >= 0n || delta.token === NATIVE_TOKEN || delta.token === weth) continue;
      const got = deltaFor(moved.effects, delta.token, account);
      if (got < -delta.delta) {
        push("VAULT_NOT_DELIVERED", `the vault gives up ${-delta.delta} of ${delta.token}, and the owner receives ${got}`, {
          vault,
          token: delta.token,
          gaveUp: (-delta.delta).toString(),
          received: got.toString(),
        });
      }
    }
  }

  /** One buy, credited to this caller, delivering at least the floor to the owner and the reward to the caller. */
  #checkBuy(
    intent: VaultTriggerIntent,
    account: Address,
    logs: SimLog[],
    moved: Movements,
    push: (code: GuardViolation["code"], message: string, detail?: Record<string, string>) => void,
  ): void {
    const weth = this.#weth;
    const vault = lower(intent.vault.address);
    const owner = lower(intent.vault.owner);
    const { terms } = intent.vault;

    // The vault is proved genuine, so its own `Bought` is its word on what it
    // did; the balances below are the check on that word.
    const buys: Extract<VaultEvent, { name: "Bought" }>[] = [];
    for (const log of logs) {
      const event = decodeVaultEvent(log);
      if (event?.name === "Bought" && event.emitter === vault) buys.push(event);
    }
    if (buys.length === 0) {
      push("VAULT_NOT_DELIVERED", "the vault makes no buy", { vault });
    } else if (buys.length > 1) {
      push("VAULT_MALFORMED", `the vault makes ${buys.length} buys in one transaction`, { vault });
    } else if (buys[0]!.keeper !== account) {
      push("VAULT_MALFORMED", `the buy's fee is credited to ${buys[0]!.keeper}, not the account triggering it`, {
        keeper: buys[0]!.keeper,
        account,
      });
    }

    const received = deltaFor(moved.effects, lower(terms.tokenOut), owner);
    if (received < intent.floorOut) {
      push("VAULT_NOT_DELIVERED", `the owner receives ${received} of ${terms.tokenOut}, below the floor of ${intent.floorOut}`, {
        owner,
        received: received.toString(),
        floorOut: intent.floorOut.toString(),
      });
    }
    const rewarded = wethOf(moved, weth, account);
    if (rewarded < terms.keeperReward) {
      push("VAULT_NOT_DELIVERED", `the caller receives ${rewarded} of WETH, not the buy fee of ${terms.keeperReward}`, {
        received: rewarded.toString(),
        reward: terms.keeperReward.toString(),
      });
    }

    // The vault parts with one buy and its reward, and nothing else.
    const spent = -wethOf(moved, weth, vault);
    const allowed = terms.amountPerBuy + terms.keeperReward;
    if (spent > allowed) {
      push("UNEXPECTED_TOKEN_TRANSFER", `${spent} of WETH leaves the vault, more than one buy and its buy fee (${allowed})`, {
        account: vault,
        token: weth,
        amount: spent.toString(),
        allowed: allowed.toString(),
      });
    }
    for (const delta of moved.effects.deltas.values()) {
      if (delta.delta >= 0n || delta.token === weth) continue;
      // A buy takes nothing from the vault but WETH, and nothing at all from
      // the owner, whoever triggers it.
      if (delta.account !== vault && (delta.account !== owner || owner === account)) continue;
      push("UNEXPECTED_TOKEN_TRANSFER", `${-delta.delta} of ${delta.token} leaves ${delta.account === vault ? "the vault" : "the owner"}`, {
        account: delta.account,
        token: delta.token,
        amount: (-delta.delta).toString(),
      });
    }
    if (owner !== account && wethOf(moved, weth, owner) < 0n) {
      push("UNEXPECTED_TOKEN_TRANSFER", "WETH leaves the owner", { account: owner, token: weth });
    }
  }
}
