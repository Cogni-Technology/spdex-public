/**
 * The Guard, applied to an auto-buy vault.
 *
 * A vault plan's buys are not signed by anyone this app controls: a contract
 * holds the budget and makes each buy itself, whoever triggers it. What the
 * user's wallet does sign are the transactions the host composes around it:
 * four about the user's own vault — create it (optionally funding it in the
 * same transaction), fund it, close it and take everything back, and trigger
 * a due buy themselves — a batch of due buys in other people's vaults, and a
 * proof that an address held SPX. Each moves the user's money, decides where
 * it will sit, or spends a network fee on what the host says it does, so each
 * passes through here, for the reason tips and budget transfers do: the host
 * wrote them, and that has never been an exemption. The terms come from a
 * config that may have arrived in a link, the vault's address and state and
 * the proof from reads over the network, and an address to prove may have
 * been typed in; a bug in any of them looks, at the moment of signing,
 * exactly like an attack.
 *
 * ## Every release
 *
 * Releases are data (`DEPLOYMENTS`, `@spdex/vault`'s releases.ts), and what
 * a release's vaults can do is its source's (`SOURCES[source].features`),
 * read from the ABIs by the build. Nothing here names a release: it asks
 * whether a release's `execute` takes `rewardTo`, whether its terms carry a
 * community window and turns. v1's factory and every vault it made run
 * unchanged for good: a 112-byte clone of terms, and `execute()`, which pays
 * the buy fee to whoever calls. v2's adds a community window and its turns to
 * each vault's terms (117 bytes) and `execute(rewardTo)`, which pays whoever
 * its caller names and, inside the window, only the owner or an eligible SPX
 * holder. Every release's vault is still funded, closed and triggered here;
 * vaults are created only on the latest release, and a batch carries only
 * vaults that take `rewardTo`, through the batcher bound to no factory.
 *
 * ## What is proved without the chain
 *
 * Every call is compared byte for byte with a fresh encoding by the same
 * functions the host uses (`@spdex/vault`), and aimed at the one place it may
 * go: a creation at the factory `factoryAddress(deployment)` computes — an
 * address that commits to the factory's code, its list of markets and the
 * registry its vaults ask — a batch at the batcher `batcherAddress(weth)`
 * computes, a proof at a listed release's registry, and everything else at
 * the plan's vault.
 *
 * Whether that vault is a real one, and the account's, is proved the same way,
 * with no read at all. A vault's address is where its factory's CREATE2 puts
 * a clone carrying its owner and its terms (`predictVault`), so an address
 * equal to the prediction for this account, a nonce and these terms can only
 * be the factory's vault for this account on exactly these terms. The host
 * supplies the owner, nonce, terms and release from its reads; none of it is
 * believed, because a lie changes the prediction: a claim is predicted from
 * its release's factory, computed from that release's source and recorded
 * arguments, and its source's clone layout, so a vault claimed as another
 * release's is a vault that isn't there. That is
 * what lets the static layer hold funding to what the terms allow, compare
 * the terms with the plan the user wrote, and encode a buy as its release
 * takes it.
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
 *   trigger  one buy, made by this account and paid to the `rewardTo` it
 *            names: a v2 vault's owner, who must be the account (Trigger now
 *            is the owner's own, and its fee comes back to them), or for a
 *            v1 vault the account itself, which v1 pays whoever calls. The
 *            owner receives at least the floor read beforehand, the fee's
 *            recipient at least the fee, and the vault parts with no more
 *            than one buy and that fee.
 *
 * And for all four: nothing leaves the account beyond the ether it sends, and
 * the account grants no allowance.
 *
 * ## A batch for other people's vaults
 *
 * The fifth transaction ("Help run the network") makes due buys in strangers'
 * vaults through the batcher, and each vault pays the account its buy fee
 * directly. There is no plan to hold it to; each vault's own rules protect
 * its owner, whoever triggers it. What is checked is the account's side.
 *
 * The batcher is bound to no factory: it calls whatever it is given and
 * measures what the account earned, so nothing on chain any longer stops a
 * batch from calling a contract that only looks like a vault. Such a contract
 * could behave one way in a test-run and another in the block — burn the
 * account's gas, or move a token the account once approved it for — so the
 * Guard proves every address in the batch statically, as it proves the
 * account's own vault: the host hands over a claim for each (owner, nonce,
 * terms, release), and each must be where its release's factory puts that
 * vault (`predictVault`). Only a factory can have put code there, and a
 * factory puts nothing there but its vault, on a market from its list. A
 * claim of a release whose vaults don't take `rewardTo` (v1's) is refused,
 * since a batch can't pay the account for it.
 *
 *   static     one call to the computed batcher, no ether, exactly
 *              `executeBatch(vaults, account, minRewards, gasPerVault)` as
 *              the host encodes it, with every fee to the account, 1 to 20
 *              distinct vaults, each proved by its claim, a least reward of
 *              at least 1 wei, and the exact gas limit and price it is signed
 *              with, the limit room enough for every vault and under the
 *              per-transaction cap.
 *   simulated  at that gas limit: the least reward covers the network fee
 *              of the gas the simulation used, at the signed price; the
 *              batcher's one `Batch`, laid out as a batcher bound to no
 *              factory lays it out, credits the account, earns at least the
 *              least reward, and earns exactly what its vaults paid; every
 *              listed vault is tried once, and each that buys follows its own
 *              `Bought`, laid out as its release's, made by the batcher and
 *              paid to the account, at or above its floor, parting with
 *              exactly its buy and fee; nothing passes through the batcher,
 *              which is never paid and has no way to pay anyone
 *              (`VAULT_BATCH_UNACCOUNTED` for anything leaving it); the
 *              account receives what was earned, and nothing of its moves.
 *
 * A vault that refuses because the account may not be paid inside its
 * community window (`NotEligible`), or not yet in its turn (`NotYourTurn`),
 * costs only its attempt, as one not yet due does; the batch still has to pay
 * for itself. A vault that answers nothing (`EmptyReturn`: its address holds
 * no code yet) is refused: the claim named a vault that isn't there.
 *
 * It is never signed unchecked, whatever `requireSimulation` says: what it
 * earns is known only from its simulation.
 *
 * ## A proof of SPX held
 *
 * The sixth transaction submits to the SPX holder registry a proof that an
 * address held at least 690 SPX at the end of a recent block: the account's
 * own, or any address typed in, since anyone may prove anyone — it states a
 * fact. It moves no money, and a false proof only reverts at the cost of its
 * network fee, so it may be signed `unverified`, on the static layer and one
 * service's word, as closing may; under `requireSimulation` it is refused
 * without a simulation like anything else. What is checked:
 *
 *   static     one call, no ether, to a listed release's registry (the
 *              latest's, which its factory's address commits to, or one a
 *              listed release recorded), exactly `prove(holder, header,
 *              accountProof, storageProof)`; a header the registry can read,
 *              hashing to the block hash the intent states and carrying its
 *              block number; at most `MAX_PROOF_NODES` nodes in each proof;
 *              and the halves tied to that header — the account proof's
 *              first node hashing to its state root, the storage proof's to
 *              the storage root the account proof's leaf states — so halves
 *              of another block's state, which could only revert, are
 *              refused as the host's own `assembleProof` refuses them.
 *   the block  the Guard's own read of that block's hash from the person's
 *              network service (`eth_getBlockByNumber`, `blockHash` in the
 *              options) is the stated one. A proof built against another
 *              block — another chain's, or a header made up to hash
 *              consistently — is refused here, before it is simulated or
 *              signed, even when everything in it agrees with itself. The
 *              one check in this file that reads.
 *   simulated  exactly one `Proven` from the registry, for this holder and
 *              this block, recording at least 690 SPX and valid for 30 days
 *              from the block's time; nothing leaves the account or the
 *              holder, and neither grants an allowance. A proof that would
 *              change nothing reverts `NotNewer`, which is said in words.
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
 *
 * A proof's block hash is read from the main service alone. A main service
 * that lies about the block and fakes the simulation to match can, without a
 * second opinion to disagree, get a false proof signed; the registry checks
 * the hash against the chain's own history, so that proof reverts and costs
 * only its fee.
 *
 * Two things about a proof are left to others, since neither moves money and
 * a simulation shows both. Whether its block is still one of the 8,191 the
 * registry can check: the host refuses an older one before building or taking
 * a proof (`@spdex/vault`'s `buildHolderProof` and `checkPastedProof`), and
 * signed unchecked anyway it reverts `UnknownBlock` at the cost of its fee.
 * And whether the holder is an account: the registry records a contract's
 * proof but never finds a contract eligible, so such a proof lands and earns
 * nothing; `readHolderStatus` says "contract" before the panel offers one.
 * This file makes no read but the block's hash.
 *
 * And what the registry's eligibility means — that an address held 690 SPX
 * when a recent block closed, and can show 690 at the moment of a buy,
 * borrowed or not — is the registry's to decide, not this file's
 * (docs/DESIGN.md, decision 17).
 */

import type { JsonRpc, SimLog, SimulationOutcome, SimulationProvider } from "@spdex/chain";
import { NATIVE_TOKEN, SimulationUnavailableError, TOPICS, accountProofStorageRoot, parseHeaderRlp, proofRoot } from "@spdex/chain";
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
  BATCHERS,
  BUY_FEE_CEILING_BPS,
  DEPLOYMENTS,
  LATEST_RELEASE,
  MAINNET_DEPLOYMENT,
  MAX_BATCH_GAS_CEILING,
  MIN_SPX,
  PROOF_TTL,
  SOURCES,
  V1_MAINNET_DEPLOYMENT,
  batchGasLimit,
  batcherAddress,
  deploymentOf,
  decodeBatchRevert,
  decodeVaultError,
  decodeVaultEvent,
  describeRegistryError,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeExecuteBatch,
  encodeExecuteV1,
  encodeFund,
  encodeProve,
  factoryAddress,
  feeCeiling,
  feeShareText,
  joinBatchLogs,
  predictVault,
  provenBy,
  termsOfPlan,
  termsProblems,
  vaultBudget,
  vaultsCreatedBy,
  withinFeeCeiling,
  type FactoryDeployment,
  type SourceFeatures,
  type V1FactoryDeployment,
  type VaultEvent,
  type VaultPlan,
  type VaultRelease,
  type VaultTerms,
} from "@spdex/vault";
import { deltaFor, observeEffects, type ObservedEffects } from "./effects.js";
import { applySecondOpinion } from "./second-opinion.js";

// ─── What the host hands over ─────────────────────────────────────────────────

/**
 * What the host does with the account's own vault. The static layer admits
 * these and no other, and `VaultGuard`'s effects check has a case for each and
 * a `never` for anything else, so an action added here without its checks
 * fails to compile rather than coming back verified.
 */
export const VAULT_ACTIONS = ["create", "fund", "close", "trigger"] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];

/** Every kind of plan `VaultGuard.check` takes: the four above, a batch, and a proof. */
export const VAULT_PLAN_ACTIONS = [...VAULT_ACTIONS, "batch", "prove"] as const;

/**
 * A vault as the host read it. None of it is trusted: it is accepted only when
 * `address` is where `release`'s factory puts a vault for `owner` with `nonce`
 * and `terms` (see the header), and then every field is the vault's own.
 */
export interface VaultClaim {
  address: Address;
  owner: Address;
  /** The factory nonce the vault was created with; `findVaultNonce` finds it. */
  nonce: bigint;
  /** Its release's source's shape: v1's have `communityWindow` and `turnBuckets` null, v2's both. */
  terms: VaultTerms;
  /**
   * Which release's factory made it, as `readVault` reports it (the factory
   * that vouches for it): one of `DEPLOYMENTS`. Never inferred here from the
   * terms' shape: it says which factory and which clone layout the address is
   * predicted with, so a claim that names the wrong one names no vault at all.
   */
  release: VaultRelease;
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

/**
 * "Trigger now": the owner makes their own vault's due buy.
 *
 * For a vault whose `execute` takes `rewardTo` (v2 on) the call is
 * `execute(owner)`, which the community window never refuses and which pays
 * the buy fee back to the owner; only the owner may send it here, since anyone
 * else would pay the network fee for a fee that isn't theirs. For a v1 vault
 * it is `execute()`, which pays whoever calls, and may still be sent by
 * anyone, as a keeper would.
 */
export interface VaultTriggerIntent extends VaultIntentBase {
  action: "trigger";
  vault: VaultClaim;
  /** The least the owner may receive: the vault's `quote().floorOut`, read just before. */
  floorOut: bigint;
  /**
   * Who the buy fee is paid to, as the host states it: the vault's owner for
   * a vault that takes `rewardTo` (the `execute(owner)` it sends), the account
   * for a v1 vault (which pays whoever calls). Anything else is refused: it
   * would describe a payment the call does not make, or one the account
   * shouldn't.
   */
  rewardTo: Address;
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
  /**
   * What the host read about each vault, in the order of `vaults`: its owner,
   * factory nonce, terms and release, as for the account's own vault. None of
   * it is believed: each must be where its release's factory puts that vault
   * (`predictVault`), which is what proves the address is a vault at all, now
   * that the batcher calls whatever it is given.
   */
  claims: readonly VaultClaim[];
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

/**
 * A proof that `holder` held at least 690 SPX at the end of block
 * `blockNumber`, sent to the SPX holder registry: the sixth transaction, and
 * the only one that moves no money at all.
 *
 * Not a `VaultIntentBase`: it belongs to no plan and to no vault. The host
 * builds it from the person's own network service (`buildHolderProof`) or
 * from a pasted proof it checked against that service (`checkPastedProof`),
 * and nothing in it is believed: the call must be exactly this proof, the
 * header must hash to `blockHash` and carry `blockNumber`, and the Guard asks
 * the service for that block's hash itself.
 */
export interface VaultProveIntent {
  version: 1;
  action: "prove";
  chainId: number;
  /** Signs, sends and pays the network fee: the connected wallet. */
  account: Address;
  /** Whose holding is proven: the account, or any address the person typed in. */
  holder: Address;
  /** The block proven: `finalized`, as the person's own service named it. */
  blockNumber: bigint;
  /** That block's hash, as the person's own service reported it. */
  blockHash: Hex;
  /** The block's header, RLP-encoded: rebuilt by the app, or pasted. */
  header: Hex;
  /** From the block's state root to SPX's account. */
  accountProof: readonly Hex[];
  /** From SPX's storage root to the holder's balance. */
  storageProof: readonly Hex[];
}

/** A proof sent to the registry: exactly one call, from `intent.account`. */
export interface VaultProveTxPlan {
  version: 1;
  intent: VaultProveIntent;
  calls: Call[];
}

/**
 * The most nodes either half of a proof may have. A mainnet proof of SPX's
 * account is nine nodes deep and of a balance six; a trie sixteen deep would
 * hold more accounts than there are atoms to spare. A paste with more is not a
 * proof of Ethereum's state, and would only make calldata someone pays for.
 */
export const MAX_PROOF_NODES = 16;

/** Every plan VaultGuard checks. */
export type AnyVaultTxPlan = VaultTxPlan | VaultBatchTxPlan | VaultProveTxPlan;

const actionOf = (plan: AnyVaultTxPlan): unknown => (plan.intent as { action?: unknown } | undefined)?.action;
const isBatchPlan = (plan: AnyVaultTxPlan): plan is VaultBatchTxPlan => actionOf(plan) === "batch";
const isProvePlan = (plan: AnyVaultTxPlan): plan is VaultProveTxPlan => actionOf(plan) === "prove";

export interface VaultGuardOptions {
  chainId: number;
  requireSimulation: boolean;
  /**
   * The latest release's factory's arguments, and so its markets, its registry
   * and the WETH the batcher is built for: mainnet's by default, which the
   * local fork shares. Every vault created is created on it, every batch goes
   * to the batcher built for its WETH, and a proof to its registry or another
   * listed release's. Earlier releases are proved against their recorded
   * arguments, on the same chain.
   */
  deployment?: FactoryDeployment;
  /** The arguments releases without a registry (v1's) are proved against: mainnet's by default. */
  v1Deployment?: V1FactoryDeployment;
  /**
   * The hash the person's own network service gives block `blockNumber`
   * (`eth_getBlockByNumber`), or null when it gives none; may throw.
   * `readBlockHash` reads it. Read by the Guard itself, never handed over by
   * the flow that built the proof: it is what tells a proof of the chain's
   * block from one that only agrees with itself. Without it, or without an
   * answer, every proof is refused; nothing else here needs it.
   */
  blockHash?: (blockNumber: bigint) => Promise<Hex | null>;
}

/**
 * Block `blockNumber`'s hash as `rpc` gives it, for `VaultGuardOptions.blockHash`;
 * null when the service has no such block, or answers with another block or
 * something that isn't a hash. Errors propagate: the Guard refuses on them.
 */
export async function readBlockHash(rpc: JsonRpc, blockNumber: bigint): Promise<Hex | null> {
  const block = (await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as { hash?: unknown; number?: unknown } | null;
  if (typeof block !== "object" || block === null) return null;
  const { hash, number } = block;
  if (typeof number !== "string" || !/^0x[0-9a-fA-F]+$/.test(number) || BigInt(number) !== blockNumber) return null;
  return typeof hash === "string" && BYTES32.test(hash) ? (hash.toLowerCase() as Hex) : null;
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

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** Bytes, at least one: a header, or one node of a proof. */
const SOME_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;

const TERM_AMOUNTS = ["amountPerBuy", "interval", "maxBuys", "startAt", "keeperReward", "maxSlippageBps"] as const;

/** A release `DEPLOYMENTS` lists; anything else is no release, and fails closed. */
const isListedRelease = (value: unknown): value is VaultRelease => typeof value === "string" && DEPLOYMENTS.some((d) => d.id === value);

/** What a listed release's vaults can do: its source's features. */
const featuresOfRelease = (release: VaultRelease): SourceFeatures => SOURCES[deploymentOf(release).source].features;

/**
 * Terms whose every field is the right kind of thing for `release`'s source,
 * so arithmetic on them cannot throw or coerce: a community window and turns
 * where the source's terms carry them, `null` where they don't. Terms of
 * another source's shape are no vault of this release's, whatever the claim
 * says.
 */
function termsAreWellFormed(terms: unknown, release: VaultRelease): terms is VaultTerms {
  if (typeof terms !== "object" || terms === null) return false;
  const t = terms as Record<string, unknown>;
  const features = featuresOfRelease(release);
  return (
    isUsableAddress(t["tokenOut"]) &&
    isUsableAddress(t["pair"]) &&
    isUsableAddress(t["oraclePool"]) &&
    TERM_AMOUNTS.every((field) => isAmount(t[field])) &&
    (features.communityWindow ? isAmount(t["communityWindow"]) : t["communityWindow"] === null) &&
    (features.turns ? isAmount(t["turnBuckets"]) : t["turnBuckets"] === null)
  );
}

/** A creation's plan: the latest release's, so with a community window and turns, every figure whole and non-negative. */
function planIsWellFormed(plan: unknown): plan is VaultPlan {
  if (typeof plan !== "object" || plan === null) return false;
  const p = plan as Record<string, unknown>;
  return (
    isAmount(p["marketIndex"]) && isAmount(p["communityWindow"]) && isAmount(p["turnBuckets"]) && TERM_AMOUNTS.every((field) => isAmount(p[field]))
  );
}

/**
 * Where each contract a vault transaction may go is, for one Guard: every
 * listed release's factory, the batcher, and the registries proofs may go to.
 * Computed from each release's source and arguments, never read, and each
 * only when first needed: each hashes a creation code.
 */
class ReleaseContracts {
  readonly #factories = new Map<VaultRelease, Address>();
  #batcher: Address | null = null;

  constructor(
    readonly deployment: FactoryDeployment,
    readonly v1Deployment: V1FactoryDeployment,
  ) {}

  /**
   * A listed release's factory: the latest's from `deployment`, the only one
   * vaults are created on; a release without a registry (v1's) from
   * `v1Deployment`; any other from its recorded markets and registry, on
   * `deployment`'s chain.
   */
  factoryOf(release: VaultRelease): Address {
    let address = this.#factories.get(release);
    if (address === undefined) {
      const recorded = deploymentOf(release);
      const { weth, uniswapV2Factory, uniswapV3Factory } = this.deployment;
      const args: FactoryDeployment | V1FactoryDeployment =
        release === LATEST_RELEASE
          ? this.deployment
          : recorded.registry === null
            ? this.v1Deployment
            : { weth, uniswapV2Factory, uniswapV3Factory, registry: recorded.registry, markets: recorded.markets };
      address = lower(factoryAddress(args, recorded.source));
      this.#factories.set(release, address);
    }
    return address;
  }

  /** The latest release's factory, which commits to its markets and its registry: the only one vaults are created on. */
  get factory(): Address {
    return this.factoryOf(LATEST_RELEASE);
  }

  /** v1's factory, from its frozen source: `DEPLOYMENTS`' first, which v1 claims are proved against. */
  get v1Factory(): Address {
    return this.factoryOf(DEPLOYMENTS[0]!.id);
  }

  /**
   * The batcher every batch goes to: the newest (`BATCHERS`' last, which the
   * host's `encodeExecuteBatch` targets), built for `deployment`'s WETH and
   * bound to no factory, so it serves every release whose vaults take
   * `rewardTo`.
   */
  get batcher(): Address {
    this.#batcher ??= lower(batcherAddress(lower(this.deployment.weth), BATCHERS[BATCHERS.length - 1]!.source));
    return this.#batcher;
  }

  /**
   * The SPX holder registry the latest release's vaults ask: the one its
   * factory's address commits to. For mainnet's deployment it is
   * `registryAddress()`, where the registry's own code lands
   * (`MAINNET_REGISTRY`).
   */
  get registry(): Address {
    return lower(this.deployment.registry);
  }

  /** Every registry a proof may go to: the latest release's, and each one a listed release records. */
  get registries(): Address[] {
    return [...new Set([this.registry, ...DEPLOYMENTS.flatMap((d) => (d.registry === null ? [] : [lower(d.registry)]))])];
  }

  /** The listed release whose factory `address` is, or null. */
  releaseOfFactory(address: Address): VaultRelease | null {
    return DEPLOYMENTS.find((d) => this.factoryOf(d.id) === lower(address))?.id ?? null;
  }
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
 * The keeper's reward, the slippage allowance and a v2 vault's community
 * window are the vault's alone — a plan has no field for any of them — so they
 * cannot differ. A plan field that is
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
 *
 * All but one check on a proof: whether its block is the chain's, which takes
 * a read (`VaultGuardOptions.blockHash`), and which `VaultGuard` makes after
 * these pass.
 */
export function runVaultChecks(
  plan: AnyVaultTxPlan,
  chainId: number,
  deployment: FactoryDeployment = MAINNET_DEPLOYMENT,
  v1Deployment: V1FactoryDeployment = V1_MAINNET_DEPLOYMENT,
): GuardViolation[] {
  return staticChecks(plan, chainId, new ReleaseContracts(deployment, v1Deployment));
}

function staticChecks(plan: AnyVaultTxPlan, chainId: number, contracts: ReleaseContracts): GuardViolation[] {
  // Before the plan check below: neither a batch nor a proof has a plan (see
  // VaultBatchIntent and VaultProveIntent).
  if (isBatchPlan(plan)) return runBatchChecks(plan, chainId, contracts);
  if (isProvePlan(plan)) return runProveChecks(plan, chainId, contracts.registries);
  const { deployment } = contracts;
  const factory = contracts.factory;
  const { intent } = plan;
  const violations: GuardViolation[] = [];
  const malformed = (message: string, detail?: Record<string, string>) =>
    violations.push({ code: "VAULT_MALFORMED", message, ...(detail === undefined ? {} : { detail }) });

  if (typeof intent !== "object" || intent === null) {
    malformed("the transaction has no intent to hold it to");
    return violations;
  }
  const action = (intent as { action?: unknown }).action;
  if (!(VAULT_ACTIONS as readonly unknown[]).includes(action)) {
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
    if (target !== to) {
      const older = intent.action === "create" ? contracts.releaseOfFactory(target as Address) : null;
      if (older !== null) {
        // An earlier release's factory still makes vaults for anyone who asks
        // it — v1's with no community window and a fee paid to whoever calls —
        // but spDEX creates vaults only on the latest.
        malformed(`the vault creation is sent to ${older}'s factory, ${target}: vaults are created only on ${LATEST_RELEASE}'s, ${to}`, {
          expected: to,
          actual: target,
          release: older,
        });
      } else {
        malformed(`the ${what} is sent to ${target}, not ${to}`, { expected: to, actual: target });
      }
    }
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
    !isListedRelease(claim.release)
  ) {
    malformed("the transaction does not say which vault, whose, from which release and on what terms");
    return violations;
  }
  const release = claim.release;
  const features = featuresOfRelease(release);
  if (!termsAreWellFormed(claim.terms, release)) {
    // A v1 vault has no community window and a v2 vault always has one, and
    // its turns: terms of another shape are another source's, or none at all.
    malformed(`the vault's terms are not a ${release} vault's`, { release });
    return violations;
  }
  const vault = lower(claim.address);
  const owner = lower(claim.owner);

  let predicted: Address | null = null;
  try {
    predicted = lower(predictVault({ factory: contracts.factoryOf(release), owner, nonce: claim.nonce, terms: claim.terms }));
  } catch {
    // Terms too large to pack into a clone: no factory vault has them.
  }
  if (predicted !== vault) {
    malformed(`${vault} is not ${release}'s factory's vault for ${owner} on these terms`, {
      vault,
      owner,
      release,
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

  // Who the buy fee goes to, which the release's source decides. A vault
  // whose `execute` takes `rewardTo` pays the address its call names, and
  // Trigger now names the owner: the one `rewardTo` its community window
  // never refuses, and one that gains the sender nothing — so only the owner
  // sends it, as only the owner funds. A v1 vault pays whoever calls, so its
  // fee is the account's.
  const takesRewardTo = features.executeTakesRewardTo;
  const rewardTo = intent.rewardTo;
  if (!isUsableAddress(rewardTo)) {
    malformed("the buy names nobody to pay its fee to", { rewardTo: String(rewardTo) });
  } else if (takesRewardTo && lower(rewardTo) !== owner) {
    malformed(`the buy fee would go to ${lower(rewardTo)}, not the vault's owner`, { rewardTo: lower(rewardTo), owner });
  } else if (!takesRewardTo && lower(rewardTo) !== account) {
    malformed(`a ${release} vault pays its buy fee to whoever sends the buy, the account, not ${lower(rewardTo)}`, {
      rewardTo: lower(rewardTo),
      account,
    });
  }
  if (takesRewardTo && owner !== account) {
    malformed(`the vault belongs to ${owner}: only its owner triggers a buy whose fee goes back to the owner`, { owner, account });
  }
  expectCall(vault, takesRewardTo ? encodeExecute(owner) : encodeExecuteV1(), "buy");
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
 * A batch's static checks: one call to the batcher — computed, never read
 * from a registry — carrying no ether and exactly the `executeBatch` its
 * intent describes as the host encodes it, every buy fee to the account, every
 * vault proved by its claim to be one a listed factory made and one that takes
 * `rewardTo`, and the exact gas limit and price the simulation runs at and the
 * wallet signs.
 */
function runBatchChecks(plan: VaultBatchTxPlan, chainId: number, contracts: ReleaseContracts): GuardViolation[] {
  const batcher = contracts.batcher;
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

  // Each vault proved, as the account's own vault is (see the header): the
  // batcher calls whatever it is given, so nothing on chain would refuse a
  // contract that only looks like a vault.
  const claims = intent.claims as unknown;
  if (!Array.isArray(claims) || !Array.isArray(vaults) || claims.length !== vaults.length) {
    malformed("the batch does not say whose each vault is, from which release and on what terms", {
      claims: Array.isArray(claims) ? String(claims.length) : "none",
      vaults: Array.isArray(vaults) ? String(vaults.length) : "none",
    });
    listOk = false;
  } else {
    for (const [index, claim] of (claims as unknown[]).entries()) {
      const at = { index: String(index), vault: String(vaults[index]) };
      const c = claim as Partial<VaultClaim> | null;
      if (
        typeof c !== "object" ||
        c === null ||
        !isUsableAddress(c.address) ||
        !isUsableAddress(c.owner) ||
        !isAmount(c.nonce) ||
        !isListedRelease(c.release) ||
        !termsAreWellFormed(c.terms, c.release)
      ) {
        malformed(`vault ${index} is not described as a listed release's vault: whose, which nonce, which release, on what terms`, at);
        listOk = false;
        continue;
      }
      if (!sameAddress(c.address, vaults[index])) {
        malformed(`vault ${index}'s claim is for ${lower(c.address)}, not ${String(vaults[index])}`, { ...at, claimed: lower(c.address) });
        listOk = false;
        continue;
      }
      const features = featuresOfRelease(c.release);
      if (!features.executeTakesRewardTo || !features.communityWindow) {
        // A v1 vault pays whoever calls it: through a batcher that takes a
        // `rewardTo`, the call isn't even its `execute()`.
        malformed(`vault ${index} is a ${c.release} vault, which a batch can't pay the account for`, { ...at, release: c.release });
        listOk = false;
        continue;
      }
      let predicted: Address | null = null;
      try {
        predicted = lower(predictVault({ factory: contracts.factoryOf(c.release), owner: lower(c.owner), nonce: c.nonce, terms: c.terms }));
      } catch {
        // Terms too large to pack into a clone: no factory vault has them.
      }
      if (predicted !== lower(c.address)) {
        malformed(`vault ${index}, ${lower(c.address)}, is not ${c.release}'s factory's vault for ${lower(c.owner)} on the terms claimed`, {
          ...at,
          release: c.release,
          ...(predicted === null ? {} : { predicted }),
        });
        listOk = false;
      }
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
      // the bytes are the same either way. As the host encodes it for this
      // batcher, the gas each vault is given included: a batch that gives a
      // vault more is one that lets it burn more of the account's gas.
      expected = encodeExecuteBatch(intent.vaults.map(lower), lower(intent.rewardTo), intent.minRewards, { batcher });
    } catch {
      // Left null: nothing equals it.
    }
    if (expected === null || String(call.data).toLowerCase() !== expected.toLowerCase()) {
      malformed("the call is not the batch its intent describes", { ...(expected === null ? {} : { expected }), actual: String(call.data).toLowerCase() });
    }
  }
  return violations;
}

/**
 * A proof's static checks: one call to one of `registries` — the latest
 * release's first, the one its factory's vaults ask, then any a listed
 * release records — carrying no ether and exactly the `prove` its intent
 * describes, with a header that is the block the intent names. Whether that
 * block is the chain's is the one thing left, and `VaultGuard` reads it.
 */
function runProveChecks(plan: VaultProveTxPlan, chainId: number, registries: readonly Address[]): GuardViolation[] {
  const { intent } = plan;
  const violations: GuardViolation[] = [];
  const malformed = (message: string, detail?: Record<string, string>) =>
    violations.push({ code: "VAULT_MALFORMED", message, ...(detail === undefined ? {} : { detail }) });

  if (intent.chainId !== chainId) {
    violations.push({
      code: "CHAIN_MISMATCH",
      message: `the proof targets chain ${String(intent.chainId)}, the host is on ${chainId}`,
      detail: { expected: String(chainId), actual: String(intent.chainId) },
    });
  }
  if (!isUsableAddress(intent.account)) {
    malformed("the proof names no account to send it", { account: String(intent.account) });
    return violations;
  }
  // The registry refuses the zero address too, but only after the fee is paid.
  const holderOk = isUsableAddress(intent.holder);
  if (!holderOk) malformed("the proof names no holder", { holder: String(intent.holder) });

  // ── The block ──

  const blockNumber = intent.blockNumber;
  const blockHash = typeof intent.blockHash === "string" ? intent.blockHash.toLowerCase() : null;
  const blockOk = isAmount(blockNumber) && blockHash !== null && BYTES32.test(blockHash);
  if (!blockOk) {
    malformed("the proof does not say which block it is of", { blockNumber: String(blockNumber), blockHash: String(intent.blockHash) });
  }
  const header = typeof intent.header === "string" ? parseHeaderRlp(intent.header) : null;
  if (header === null) {
    // What the registry would refuse as `BadHeader`, said before anyone pays to hear it.
    malformed("the proof's header can't be read as a block's");
  } else if (blockOk) {
    // A proof built against another block than the one the intent names:
    // the hash it would be checked against on chain is not this header's.
    if (header.hash !== blockHash) {
      malformed(`the proof's header hashes to ${header.hash}, not block ${blockNumber}'s ${blockHash} it is sent with`, {
        blockNumber: blockNumber.toString(),
        expected: blockHash!,
        actual: header.hash,
      });
    }
    if (header.number !== blockNumber) {
      malformed(`the proof's header is block ${header.number}'s, not block ${blockNumber}'s`, {
        expected: blockNumber.toString(),
        actual: header.number.toString(),
      });
    }
  }

  // ── The proof's two halves ──

  const nodesOk = (nodes: unknown, what: string): nodes is readonly Hex[] => {
    if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_PROOF_NODES || !nodes.every((n) => typeof n === "string" && SOME_BYTES.test(n))) {
      malformed(`the ${what} proof is not 1 to ${MAX_PROOF_NODES} nodes of bytes`, {
        nodes: Array.isArray(nodes) ? String(nodes.length) : "none",
      });
      return false;
    }
    return true;
  };
  const accountProofOk = nodesOk(intent.accountProof, "account");
  const storageProofOk = nodesOk(intent.storageProof, "storage");

  // Each half starts where the one before it says: the account proof from the header's state root, the balance proof
  // from the storage root the account's leaf states. Halves of another block's state agree with themselves and with
  // the calldata, and can only revert, at about 650,000 gas; the host's own `assembleProof` refuses them, and is not
  // believed here either.
  if (header !== null && accountProofOk) {
    const accountRoot = proofRoot(intent.accountProof);
    if (accountRoot !== header.stateRoot) {
      malformed(`the proof does not start from block ${header.number}'s state root: it is a proof of another state`, {
        expected: header.stateRoot,
        actual: String(accountRoot),
      });
    } else if (storageProofOk) {
      const storageRoot = accountProofStorageRoot(intent.accountProof);
      const balanceRoot = proofRoot(intent.storageProof);
      if (storageRoot === null || balanceRoot !== storageRoot) {
        malformed("the balance proof does not start from the storage root its account proof states", {
          expected: storageRoot ?? "none",
          actual: String(balanceRoot),
        });
      }
    }
  }

  // ── The call ──

  if (plan.calls.length !== 1) {
    malformed(`a proof is one call, not ${plan.calls.length}`);
    return violations;
  }
  const call = plan.calls[0]!;
  const target = String(call.to).toLowerCase() as Address;
  if (!registries.includes(target)) {
    malformed(`the proof is sent to ${target}, not the SPX holder registry ${registries[0]}`, { expected: registries[0]!, actual: target });
  }
  if (call.value !== 0n) {
    malformed(`the proof attaches ${String(call.value)} wei, and a proof takes none`, { value: String(call.value) });
  }
  if (holderOk && header !== null && accountProofOk && storageProofOk) {
    let expected: Hex | null = null;
    try {
      expected = encodeProve({
        holder: lower(intent.holder),
        header: intent.header,
        accountProof: [...intent.accountProof],
        storageProof: [...intent.storageProof],
      });
    } catch {
      // Left null: nothing equals it.
    }
    if (expected === null || String(call.data).toLowerCase() !== expected.toLowerCase()) {
      malformed("the call is not the proof its intent describes", { ...(expected === null ? {} : { expected }), actual: String(call.data).toLowerCase() });
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

/** What arrived at an address, and what left it, of one token: counted apart, never netted. */
interface GrossFlow {
  token: Address;
  received: bigint;
  sent: bigint;
}

/**
 * Every token that moved in or out of `who`, gross: a balance that rose and
 * fell again by the same amount nets to nothing in `observeEffects`, and
 * "nothing passes through" is a claim about each movement, not the sum. WETH
 * wrapped for `who` counts as arriving, unwrapped as leaving; ether by value
 * arrives as `traceTransfers`' pseudo-logs, which are `Transfer`s too. A log
 * that can't be read is left to `readMovements`, which counts it undecodable.
 */
function grossFlows(logs: SimLog[], who: Address, weth: Address): GrossFlow[] {
  const flows = new Map<Address, GrossFlow>();
  const add = (token: Address, received: bigint, sent: bigint) => {
    const flow = flows.get(token) ?? { token, received: 0n, sent: 0n };
    flow.received += received;
    flow.sent += sent;
    flows.set(token, flow);
  };
  const addressIn = (topic: string | undefined): Address | null =>
    topic !== undefined && BYTES32.test(topic) ? lower(`0x${topic.slice(26)}`) : null;
  const amountIn = (data: string): bigint | null => (BYTES32.test(data.slice(0, 66)) ? BigInt(data.slice(0, 66)) : null);
  for (const log of logs) {
    const topic = log.topics[0]?.toLowerCase();
    const token = lower(log.address);
    if (topic === TOPICS.transfer) {
      const from = addressIn(log.topics[1]);
      const to = addressIn(log.topics[2]);
      const amount = amountIn(log.data);
      if (amount === null) continue;
      if (to === who) add(token, amount, 0n);
      if (from === who) add(token, 0n, amount);
    } else if (token === weth && (topic === WETH_DEPOSIT || topic === WETH_WITHDRAWAL) && addressIn(log.topics[1]) === who) {
      const amount = amountIn(log.data);
      if (amount === null) continue;
      if (topic === WETH_DEPOSIT) add(weth, amount, 0n);
      else add(weth, 0n, amount);
    }
  }
  return [...flows.values()];
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
  readonly #contracts: ReleaseContracts;
  readonly #factory: Address;
  readonly #weth: Address;

  constructor(
    private readonly simulation: SimulationProvider,
    private readonly options: VaultGuardOptions,
  ) {
    this.#deployment = options.deployment ?? MAINNET_DEPLOYMENT;
    this.#contracts = new ReleaseContracts(this.#deployment, options.v1Deployment ?? V1_MAINNET_DEPLOYMENT);
    // Computed once: it hashes the factory's whole creation code.
    this.#factory = this.#contracts.factory;
    this.#weth = lower(this.#deployment.weth);
  }

  /** The factory this Guard holds creations to: the latest release's, the only one vaults are created on. */
  get factory(): Address {
    return this.#factory;
  }

  /** v1's factory, frozen: the one v1 claims are proved against. Computed, never read. */
  get v1Factory(): Address {
    return this.#contracts.v1Factory;
  }

  /**
   * The batcher, bound to no factory, built for this Guard's WETH: the only
   * place a batch may go, and where the host sends one. Computed, never read.
   */
  get batcher(): Address {
    return this.#contracts.batcher;
  }

  /** The SPX holder registry the latest release's vaults ask: where the host sends a proof. */
  get registry(): Address {
    return this.#contracts.registry;
  }

  async check(plan: AnyVaultTxPlan): Promise<GuardVerdict> {
    if (isBatchPlan(plan)) return this.#checkBatch(plan);
    if (isProvePlan(plan)) return this.#checkProof(plan);
    const staticViolations = staticChecks(plan, this.options.chainId, this.#contracts);
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
    const staticViolations = staticChecks(plan, this.options.chainId, this.#contracts);
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
   * A proof of SPX held: static, then the block's hash from the person's own
   * service, then simulated. It moves no money, so it follows
   * `requireSimulation` as closing does: without a simulation, or on one
   * service's when a second was set and didn't answer, it is `unverified`
   * unless the setting says otherwise. A wrong proof costs its fee and nothing
   * else; a Guard that refused it outright would keep a holder from proving
   * on a service that can't test-run.
   */
  async #checkProof(plan: VaultProveTxPlan): Promise<GuardVerdict> {
    const staticViolations = staticChecks(plan, this.options.chainId, this.#contracts);
    if (staticViolations.length > 0) return rejected(staticViolations);
    const { intent } = plan;

    const wrongBlock = await this.#checkProofBlock(intent.blockNumber, intent.blockHash.toLowerCase() as Hex);
    if (wrongBlock !== null) return rejected([wrongBlock]);

    const neverUnchecked = this.options.requireSimulation;
    const unchecked = (violation: GuardViolation): GuardVerdict => (neverUnchecked ? rejected([violation]) : unverified([violation]));
    if (!(await this.simulation.isAvailable())) {
      return unchecked({
        code: "SIMULATION_UNAVAILABLE",
        message: "this RPC cannot simulate transactions, so the proof has not been verified",
        detail: { provider: this.simulation.kind },
      });
    }
    let outcome: SimulationOutcome;
    try {
      outcome = await this.simulation.simulate({ chainId: this.options.chainId, account: intent.account, calls: plan.calls });
    } catch (error) {
      return unchecked({
        code: "SIMULATION_UNAVAILABLE",
        message:
          error instanceof SimulationUnavailableError
            ? error.message
            : `simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    let judged: GuardVerdict;
    if (outcome.status === "reverted") {
      // The registry's own refusal in words — `NotNewer` above all, which
      // a proof that would change nothing meets — when the service reported
      // the revert data; the verifier's errors as "does not match".
      const error = outcome.returnData === undefined ? null : decodeVaultError(outcome.returnData);
      const words = describeRegistryError(error);
      judged = rejected([
        {
          code: "SIMULATION_REVERTED",
          message: words === null ? (outcome.revertReason ?? "the proof reverts") : `the proof would revert: ${words}`,
          ...(error === null || words === null ? {} : { detail: { reason: error.name } }),
        },
      ]);
    } else {
      // The registry the static layer held the call to: the latest's, or a listed release's.
      judged = this.#checkProofEffects(intent, lower(plan.calls[0]!.to), outcome.logs);
    }
    // Last, after this service's own checks (see second-opinion.ts).
    return applySecondOpinion(judged, outcome, { neverUnchecked });
  }

  /**
   * Is `blockHash` block `blockNumber`'s hash on the person's own service?
   * Null when it is; the refusal otherwise. A proof's header hashing to the
   * hash it is sent with shows only that the two agree with each other: this
   * is what ties them to the chain.
   */
  async #checkProofBlock(blockNumber: bigint, blockHash: Hex): Promise<GuardViolation | null> {
    let actual: Hex | null = null;
    let failure: string | null = null;
    try {
      actual = this.options.blockHash === undefined ? null : await this.options.blockHash(blockNumber);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (actual === null) {
      return {
        code: "VAULT_MALFORMED",
        message: `block ${blockNumber}'s hash could not be read from your network service, so the proof is not known to be of the chain's block`,
        detail: { blockNumber: blockNumber.toString(), blockHash, ...(failure === null ? {} : { failure }) },
      };
    }
    if (typeof actual !== "string" || actual.toLowerCase() !== blockHash) {
      return {
        code: "VAULT_MALFORMED",
        message: `your network service says block ${blockNumber} is ${String(actual).toLowerCase()}, not ${blockHash}: the proof is built against another block`,
        detail: { blockNumber: blockNumber.toString(), expected: String(actual).toLowerCase(), actual: blockHash },
      };
    }
    return null;
  }

  /**
   * What a proof did, from its simulated logs: the registry's one `Proven`,
   * for this holder and this block, and nothing else of anyone's moving.
   */
  #checkProofEffects(intent: VaultProveIntent, registry: Address, logs: SimLog[]): GuardVerdict {
    const account = lower(intent.account);
    const holder = lower(intent.holder);
    const moved = readMovements(logs, this.#weth);
    const violations: GuardViolation[] = [];
    const push = (code: GuardViolation["code"], message: string, detail?: Record<string, string>) =>
      violations.push({ code, message, ...(detail === undefined ? {} : { detail }) });

    if (moved.undecodable > 0) {
      push("UNDECODABLE_EFFECTS", `${moved.undecodable} transfer, approval or wrap events could not be decoded`, {
        count: String(moved.undecodable),
      });
    }

    // ── Nothing of the account's or the holder's moves ──

    // A proof reads a past block's state and writes one timestamp: no token,
    // no ether, no allowance, the holder's SPX least of all.
    for (const [who, party] of [
      ["the account", account],
      ["the holder", holder],
    ] as const) {
      if (who === "the holder" && holder === account) continue;
      const etherLost = -etherOf(moved, party);
      if (etherLost > 0n) push("UNEXPECTED_ETH_TRANSFER", `${etherLost} wei leaves ${who}, and a proof sends none`, { account: party, amount: etherLost.toString() });
      const wethLost = -wethOf(moved, this.#weth, party);
      if (wethLost > 0n) push("UNEXPECTED_TOKEN_TRANSFER", `${wethLost} of WETH leaves ${who}`, { account: party, token: this.#weth, amount: wethLost.toString() });
      for (const delta of moved.effects.deltas.values()) {
        if (delta.account !== party || delta.delta >= 0n || delta.token === NATIVE_TOKEN || delta.token === this.#weth) continue;
        push("UNEXPECTED_TOKEN_TRANSFER", `${-delta.delta} of ${delta.token} leaves ${who}`, {
          account: party,
          token: delta.token,
          amount: (-delta.delta).toString(),
        });
      }
      for (const granted of moved.effects.approvals) {
        if (granted.owner !== party || granted.amount === 0n) continue;
        push("UNEXPECTED_APPROVAL", `the proof has ${who} grant ${granted.spender} an allowance of ${granted.token}`, {
          token: granted.token,
          spender: granted.spender,
        });
      }
    }

    // ── The registry's record ──

    // Only the registry's own logs say what the registry did: anyone can
    // emit a log shaped like `Proven`.
    const proven = provenBy(registry, logs);
    if (proven.length === 0) {
      push("VAULT_NOT_DELIVERED", "the registry records no proof", { registry });
    } else if (proven.length > 1) {
      push("VAULT_MALFORMED", `the registry records ${proven.length} proofs, not one`, { registry, count: String(proven.length) });
    } else {
      const record = proven[0]!;
      // Non-null: the static layer refused a header it couldn't read.
      const header = parseHeaderRlp(intent.header)!;
      const validUntil = header.timestamp + PROOF_TTL;
      if (record.holder !== holder) {
        push("VAULT_MALFORMED", `the registry records a proof for ${record.holder}, not ${holder}`, { expected: holder, actual: record.holder });
      }
      if (record.blockNumber !== intent.blockNumber) {
        push("VAULT_MALFORMED", `the registry records a proof of block ${record.blockNumber}, not ${intent.blockNumber}`, {
          expected: intent.blockNumber.toString(),
          actual: record.blockNumber.toString(),
        });
      }
      if (record.balance < MIN_SPX) {
        // The registry refuses a holding below the minimum (`BelowMinimum`):
        // a record of one is not the registry's code at work.
        push("VAULT_MALFORMED", `the registry records ${record.balance} SPX held, below the ${MIN_SPX} a proof needs`, {
          balance: record.balance.toString(),
          minimum: MIN_SPX.toString(),
        });
      }
      if (record.validUntil !== validUntil) {
        push("VAULT_MALFORMED", `the registry records the proof valid until ${record.validUntil}, not ${validUntil}, 30 days from the block's time`, {
          expected: validUntil.toString(),
          actual: record.validUntil.toString(),
        });
      }
    }

    return violations.length > 0 ? rejected(violations) : verified();
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
    // The static layer proved each claim, in the order of `vaults`: what each
    // vault's `Bought` must be laid out as is its release's source's.
    const sourceOf = new Map(intent.claims.map((c) => [lower(c.address), deploymentOf(c.release).source] as const));
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
      if (!SOURCES[batch.source].features.sharedBatcher) {
        // v1's layout, with its `swept`, from the address of a batcher bound to
        // no factory: not what that code emits, so not a batch it ran.
        push("VAULT_MALFORMED", `the batcher reports a ${batch.source} batch, and it is a batcher bound to no factory`, { batcher, source: batch.source });
      }
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
    }

    // ── Nothing passes through the batcher ──

    // The batcher is never paid by a batch it runs, and has no way to pay
    // anyone: each vault pays the account directly. Counted gross, in and
    // out, since a fee that arrived and left again nets to nothing: anything
    // arriving at it is a fee paid elsewhere than the `Bought` says, and
    // anything leaving it is money nobody can say whose it is
    // (`VAULT_BATCH_UNACCOUNTED`), which the account is never made the
    // receiver of.
    for (const flow of grossFlows(logs, batcher, weth)) {
      const what = flow.token === weth ? "WETH" : flow.token === NATIVE_TOKEN ? "ether" : flow.token;
      if (flow.received > 0n) {
        push("VAULT_MALFORMED", `${flow.received} of ${what} is paid to the batcher, which a batch never pays`, {
          token: flow.token,
          amount: flow.received.toString(),
        });
      }
      if (flow.sent > 0n) {
        push("VAULT_BATCH_UNACCOUNTED", `${flow.sent} of ${what} leaves the batcher, which passes on nothing`, {
          token: flow.token,
          amount: flow.sent.toString(),
          // In wei, read by the app as what the batch would pass on (lib/errors.ts).
          ...(flow.token === weth ? { swept: flow.sent.toString() } : {}),
        });
      }
    }

    // ── Each vault: tried once, bought by its own rules, or refused for a reason of its own ──

    const seen = new Map<Address, "triggered" | "not">();
    let triggered = 0n;
    let paid = 0n;
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
      paid += bought.reward;
      const expectedSource = sourceOf.get(vault);
      if (bought.source !== expectedSource) {
        // The claim proved which release's vault this is, and so which code
        // logs its buy: a buy laid out otherwise is not that code's.
        push("VAULT_MALFORMED", `${vault}'s buy is laid out as a ${bought.source} vault's, and it is a ${String(expectedSource)} vault`, {
          vault,
          expected: String(expectedSource),
          actual: bought.source,
        });
      }
      if (bought.keeper !== batcher) {
        push("VAULT_MALFORMED", `${vault}'s buy is made by ${bought.keeper}, not the batcher`, { vault, keeper: bought.keeper });
      }
      if (bought.rewardTo !== account) {
        push("VAULT_MALFORMED", `${vault}'s buy fee is paid to ${bought.rewardTo}, not the account`, { vault, rewardTo: bought.rewardTo, account });
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
      // `NotTried`: the gas ran out, which the limit exists to rule out.
      // `EmptyReturn`: the call found no code, so the claim named a vault that
      // isn't there. `NotFromFactory` is only v1's batcher's, and never this
      // one's.
      if (event.reasonName === "NotFromFactory" || event.reasonName === "NotTried" || event.reasonName === "EmptyReturn") {
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
    // `earned` is how much the account's WETH rose while the batch ran, as
    // the batcher measured it. Every vault in it is proved, and pays only its
    // fee to the account, so that is exactly the fees their `Bought`s
    // report: a figure that differs is money from somewhere else, or not that
    // batcher's figure at all.
    if (batch !== null && batch.earned !== paid) {
      push("VAULT_MALFORMED", `the batch reports earning ${batch.earned} wei, and its vaults pay ${paid}`, {
        earned: batch.earned.toString(),
        paid: paid.toString(),
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
      default: {
        // An action the static layer admitted with no effects check of its own
        // here: never verified on the generic checks above alone. Adding one
        // to `VaultIntent` without a case here fails to compile.
        const unhandled: never = intent;
        push("VAULT_MALFORMED", `nothing here checks what "${String((unhandled as { action?: unknown }).action)}" does`);
      }
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

  /**
   * One buy, made by this account, delivering at least the floor to the owner
   * and the fee to whoever the release pays: the owner of a vault that takes
   * `rewardTo`, named by the call, or a v1 vault's caller.
   */
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
    const { terms, release } = intent.vault;
    const source = deploymentOf(release).source;
    const takesRewardTo = SOURCES[source].features.executeTakesRewardTo;
    // Who the fee goes to: the owner, whom Trigger now names on a vault that
    // takes `rewardTo` (the static layer held `rewardTo` to that), or v1's
    // caller.
    const paidTo = takesRewardTo ? owner : account;

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
    } else {
      const bought = buys[0]!;
      if (bought.source !== source) {
        // A v1 vault cannot log v2's `Bought`, nor the reverse: the buy is
        // not the one this vault's code makes.
        push("VAULT_MALFORMED", `the vault's buy is laid out as a ${bought.source} vault's, and the vault is ${release}'s`, {
          vault,
          expected: source,
          actual: bought.source,
        });
      }
      if (bought.keeper !== account) {
        push("VAULT_MALFORMED", `the buy is made by ${bought.keeper}, not the account triggering it`, { keeper: bought.keeper, account });
      }
      if (bought.rewardTo !== paidTo) {
        push("VAULT_MALFORMED", `the buy's fee is paid to ${bought.rewardTo}, not ${takesRewardTo ? "the vault's owner" : "the account triggering it"}`, {
          rewardTo: bought.rewardTo,
          expected: paidTo,
        });
      }
    }

    const received = deltaFor(moved.effects, lower(terms.tokenOut), owner);
    if (received < intent.floorOut) {
      push("VAULT_NOT_DELIVERED", `the owner receives ${received} of ${terms.tokenOut}, below the floor of ${intent.floorOut}`, {
        owner,
        received: received.toString(),
        floorOut: intent.floorOut.toString(),
      });
    }
    // Measured where the fee goes. For Trigger now on a v2 vault that is the
    // owner, who is the account; the balance is the check on the `Bought`.
    const rewarded = wethOf(moved, weth, paidTo);
    if (rewarded < terms.keeperReward) {
      push(
        "VAULT_NOT_DELIVERED",
        `${takesRewardTo ? "the vault's owner" : "the caller"} receives ${rewarded} of WETH, not the buy fee of ${terms.keeperReward}`,
        { account: paidTo, received: rewarded.toString(), reward: terms.keeperReward.toString() },
      );
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
