/**
 * Local signing, for a key spDEX code signs with itself rather than asking a
 * wallet: a keeper's.
 *
 * ## Why this exists at all
 *
 * Everywhere else spDEX asks the user's wallet to sign and holds nothing. A
 * keeper (packages/vault) cannot work that way, because a wallet will not
 * sign with nobody watching, which is the point of a wallet: it triggers due
 * vault buys unattended, from a key its operator gives it, in its own
 * process. spDEX never holds that key. (Before config version 8 an autopilot
 * plan's spending wallet in the browser signed here too; no release ever made
 * one, and its withdrawals were removed on 2026-10-02.)
 *
 * This file is only the arithmetic and the signature. No storage, no DOM, no
 * clock: where the key lives between buys, and who may ask for it, is the
 * host's business and the host's to state honestly. Keeping that out of here
 * keeps the code that touches key material small enough to read in one
 * sitting and to test without a browser.
 *
 * ## What the endpoint now decides
 *
 * With a wallet, the RPC endpoint can lie but cannot cause a signature
 * (docs/THREAT-MODEL.md). Here it supplies the nonce, the fees and the gas
 * limit of a transaction that is then signed with nobody looking, so those
 * figures are inputs to a signature and are treated as such:
 *
 * - **The fee is the one that can cost money.** An endpoint that reported an
 *   absurd priority fee would have it paid, from the signing key, to whoever
 *   builds the block. `feeRateCeiling` bounds the price it may bid per unit
 *   of gas and `feeCeiling` what the whole transaction may pay, whatever the
 *   endpoint says, so the most a lying endpoint can burn in fees is bounded
 *   by one transaction's gas at that ceiling. Both, because either alone
 *   can be traded against the other: a tight gas limit at a huge price fits a
 *   per-transaction ceiling, and a huge gas limit fits a per-gas one.
 * - **A wrong nonce costs a stuck or dropped transaction, not money.**
 *   `nonceFloor` covers the one honest way the pending count is wrong: a
 *   private relay's in-flight transaction, which a public endpoint cannot see.
 * - **A wrong gas limit costs a failed buy**, and its fee is bounded by the
 *   same ceiling.
 * - **The chain id is checked before anything else is read**, so a transaction
 *   is never assembled from one chain's nonce and fees and signed for another.
 *
 * Every read goes through the `JsonRpc` the caller passes — the user's own
 * endpoint — and a failed read carries that endpoint's message, prefixed with
 * what was being read, so the reason a buy did not happen can be shown rather
 * than guessed at.
 *
 * ## Why the hash is known before anything is sent
 *
 * A transaction's hash is keccak256 of its signed bytes, and those bytes exist
 * here before any network sees them. So the host can record `{nonce, hash}`
 * first and broadcast second, and a tab that dies mid-buy comes back knowing
 * exactly which transaction to look for. A wallet-signed buy cannot offer
 * that: its hash only exists once the wallet has already sent it.
 */

import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAddress, signTransaction } from "viem/accounts";
import type { Address, Hex } from "@spdex/core";
import type { JsonRpc } from "./reader.js";

/**
 * How a transaction bids for inclusion.
 *
 * EIP-1559 wherever the chain has a base fee, because a type-2 transaction
 * pays the base fee the block actually charges rather than the price it
 * guessed; legacy only where there is no base fee to speak of.
 */
export type PreparedFees =
  | { type: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { type: "legacy"; gasPrice: bigint };

/**
 * Everything a signature commits to, and who it was prepared for.
 *
 * `from` is not part of the signed bytes — the signature is what names the
 * sender — but the nonce and the gas estimate were read *for* that address,
 * and signing them with a different key would produce a transaction from an
 * account whose nonce it does not know. Carrying `from` lets `signPrepared`
 * refuse that mistake instead of broadcasting it.
 */
export interface PreparedTransaction {
  from: Address;
  chainId: number;
  nonce: number;
  to: Address;
  data: Hex;
  value: bigint;
  /** The gas limit. Unused gas is refunded, so headroom here costs nothing unless it is needed. */
  gas: bigint;
  fees: PreparedFees;
}

/** The default margin on a gas estimate: 20%. See `prepareTransaction`. */
export const DEFAULT_GAS_HEADROOM_BPS = 2_000;
/** More than doubling an estimate is no longer headroom; it is a different number. */
const MAX_GAS_HEADROOM_BPS = 10_000;

/**
 * The endpoint asked for more in fees than the caller allowed.
 *
 * A distinct type because it is not an error in the ordinary sense: fees spike,
 * and an unattended buy that declines to pay a spike is doing its job. The host
 * can say "skipped: network fees were above this plan's limit" with the figures
 * rather than surfacing it as a failure.
 */
export class FeeCeilingError extends Error {
  /**
   * Which limit was broken. `"total"`: the transaction's gas limit at its
   * price could pay more than `ceiling`, per transaction. `"rate"`: the price
   * it bids per unit of gas is above `ceilingPerGas`, whatever its gas.
   */
  readonly kind: "total" | "rate";
  /** The price per gas the prepared transaction bid: `maxFeePerGas`, or `gasPrice`. */
  readonly feePerGas: bigint;
  /** The per-gas limit the caller gave, or null when it gave none. */
  readonly ceilingPerGas: bigint | null;

  constructor(
    /** What the prepared transaction could pay at most, in wei. */
    readonly maxFee: bigint,
    /** What the caller allowed, in wei (for a `"rate"` refusal with no per-transaction limit, the rate over the gas). */
    readonly ceiling: bigint,
    detail: { kind?: "total" | "rate"; feePerGas?: bigint; ceilingPerGas?: bigint | null } = {},
  ) {
    const kind = detail.kind ?? "total";
    const feePerGas = detail.feePerGas ?? 0n;
    const ceilingPerGas = detail.ceilingPerGas ?? null;
    super(
      kind === "rate"
        ? `this transaction would bid ${feePerGas} wei per gas for network fees, above the ${ceilingPerGas} wei per gas allowed; not prepared`
        : `network fees for this transaction could reach ${maxFee} wei, above the ${ceiling} wei allowed; not prepared`,
    );
    this.name = "FeeCeilingError";
    this.kind = kind;
    this.feePerGas = feePerGas;
    this.ceilingPerGas = ceilingPerGas;
  }
}

// ── Keys ──────────────────────────────────────────────────────────────────

/** secp256k1's group order. A private key is a scalar in [1, n). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Refuse anything that is not a usable key, without ever repeating it.
 *
 * The libraries underneath would refuse too, but some of their messages quote
 * the offending value, and a message is exactly the thing that ends up in a
 * status line, a console or a bug report. So the check happens here first,
 * with a message that says what is wrong and nothing about what the key was.
 */
function checkedKey(privateKey: string): Hex {
  if (typeof privateKey !== "string" || !PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("not a private key: expected 0x followed by 64 hex digits");
  }
  const scalar = BigInt(privateKey);
  if (scalar === 0n || scalar >= SECP256K1_N) {
    throw new Error("not a private key: outside the range secp256k1 accepts");
  }
  return privateKey.toLowerCase() as Hex;
}

/**
 * A new private key, from the platform's CSPRNG: a test's fresh account, or a
 * keeper operator's.
 *
 * viem's `generatePrivateKey` draws 48 bytes from `crypto.getRandomValues` and
 * reduces them into [1, n) (noble's `randomPrivateKey`), which leaves a bias
 * far below anything measurable and can never yield zero. Nothing falls back
 * to a weaker source: without a CSPRNG this throws rather than producing a key
 * someone else could guess.
 */
export function generateSpendingKey(): Hex {
  return checkedKey(generatePrivateKey());
}

/** The address a key signs as, lowercase like every address spDEX compares. */
export function addressOfKey(privateKey: Hex): Address {
  return privateKeyToAddress(checkedKey(privateKey)).toLowerCase() as Address;
}

// ── Reading from the endpoint ─────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One read, with what it was for prepended to whatever the endpoint said. */
async function read(rpc: JsonRpc, what: string, method: string, params: unknown[]): Promise<unknown> {
  try {
    return await rpc(method, params);
  } catch (error) {
    throw new Error(`could not read ${what}: ${messageOf(error)}`, { cause: error });
  }
}

/**
 * A JSON-RPC quantity, or a refusal.
 *
 * Never a default. An endpoint that answers a gas estimate with `null` has
 * not said "zero gas", and a figure that is about to be signed must not
 * quietly become one.
 */
function quantity(value: unknown, what: string): bigint {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  const answered = JSON.stringify(value) ?? String(value);
  const shown = answered.length > 80 ? `${answered.slice(0, 80)}…` : answered;
  throw new Error(`could not read ${what}: the endpoint answered ${shown}, which is not a hex quantity`);
}

async function readQuantity(rpc: JsonRpc, what: string, method: string, params: unknown[]): Promise<bigint> {
  return quantity(await read(rpc, what, method, params), what);
}

const toQuantity = (v: bigint | number): Hex => `0x${v.toString(16)}`;

async function assertChain(rpc: JsonRpc, chainId: number): Promise<void> {
  const actual = await readQuantity(rpc, "the endpoint's chain id", "eth_chainId", []);
  if (actual !== BigInt(chainId)) {
    throw new Error(
      `the endpoint is on chain ${actual}, not chain ${chainId}; refusing to prepare a transaction for the wrong chain`,
    );
  }
}

async function pendingNonce(rpc: JsonRpc, from: Address): Promise<number> {
  const nonce = await readQuantity(rpc, "the pending nonce", "eth_getTransactionCount", [from, "pending"]);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`could not read the pending nonce: ${nonce} is not a usable nonce`);
  }
  return Number(nonce);
}

/**
 * What to bid for gas, as the endpoint sees the market now.
 *
 * On a chain with a base fee: `maxFeePerGas = 2 × baseFee + tip`. The block
 * charges only its own base fee plus the tip, so the doubling is not paid; it
 * is room for the base fee to rise (it can climb 12.5% a block) before the
 * transaction would stop being includable, and it is what the balance check
 * and `feeCeiling` reserve against. The tip is the endpoint's
 * `eth_maxPriorityFeePerGas`, or, for an endpoint without that method, what
 * its `eth_gasPrice` asks above the base fee — which is the endpoint's own
 * figure, so a gas price at or below the base fee is read as "no tip needed"
 * rather than invented upwards. If neither answers, this throws: a fee that
 * cannot be read is unknown, never zero.
 *
 * A chain whose latest block has no base fee gets a legacy `gasPrice`.
 */
export async function readFees(rpc: JsonRpc): Promise<PreparedFees> {
  const block = await read(rpc, "the latest block", "eth_getBlockByNumber", ["latest", false]);
  if (block === null || typeof block !== "object") {
    throw new Error("could not read the latest block: the endpoint returned none");
  }

  const baseFeeField = (block as { baseFeePerGas?: unknown }).baseFeePerGas;
  if (baseFeeField === undefined || baseFeeField === null) {
    const gasPrice = await readQuantity(rpc, "the gas price", "eth_gasPrice", []);
    return { type: "legacy", gasPrice };
  }

  const baseFee = quantity(baseFeeField, "the base fee");
  let tip: bigint;
  try {
    tip = quantity(await rpc("eth_maxPriorityFeePerGas", []), "the priority fee");
  } catch (tipError) {
    let gasPrice: bigint;
    try {
      gasPrice = quantity(await rpc("eth_gasPrice", []), "the gas price");
    } catch (priceError) {
      throw new Error(
        `could not read a fee to offer. Asked for a priority fee: ${messageOf(tipError)}. ` +
          `Asked for a gas price to derive one from: ${messageOf(priceError)}`,
        { cause: priceError },
      );
    }
    tip = gasPrice > baseFee ? gasPrice - baseFee : 0n;
  }

  return { type: "eip1559", maxFeePerGas: 2n * baseFee + tip, maxPriorityFeePerGas: tip };
}

// ── Preparing ─────────────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_RE = /^0x([0-9a-fA-F]{2})*$/;

function checkedAddress(value: string, what: string): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new Error(`${what} is not an address`);
  return value.toLowerCase() as Address;
}

function checkedChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`chain id ${chainId} is not a chain id`);
  return chainId;
}

/**
 * The most a transaction can pay in network fees: its gas limit at its highest
 * price.
 *
 * An upper bound, not a forecast — a type-2 transaction pays the block's base
 * fee, which is usually well under `maxFeePerGas`, and unused gas is refunded.
 * It is the figure a balance has to cover for the transaction to be accepted,
 * which is why the fee ceiling and the reserve are measured against it.
 */
export function maxFeeOf(tx: Pick<PreparedTransaction, "gas" | "fees">): bigint {
  return tx.gas * (tx.fees.type === "eip1559" ? tx.fees.maxFeePerGas : tx.fees.gasPrice);
}

/**
 * What the sender must hold for the transaction to be accepted at all:
 * `value + gas × (maxFeePerGas | gasPrice)`.
 *
 * Checking this before signing is what turns an exhausted budget into "this
 * buy was skipped: the account cannot cover it" instead of the
 * endpoint's "insufficient funds for gas * price + value".
 */
export function maxCostOf(tx: PreparedTransaction): bigint {
  return tx.value + maxFeeOf(tx);
}

/** The price per gas a transaction bids at most: `maxFeePerGas`, or `gasPrice`. */
function bidPerGas(tx: Pick<PreparedTransaction, "fees">): bigint {
  return tx.fees.type === "eip1559" ? tx.fees.maxFeePerGas : tx.fees.gasPrice;
}

/**
 * Both limits, per gas first.
 *
 * The per-transaction ceiling alone bounds `gas × price`, which an endpoint
 * can rebalance: report a tight gas limit and a price near the whole
 * allowance, and every transaction pays the most it is allowed to however
 * little it needed. The per-gas limit is the one that fixes the price; the
 * per-transaction one then bounds the gas. For EIP-1559 the priority fee is
 * checked as well as the max fee — it is the part paid away to the block
 * builder — though a well-formed transaction never bids a tip above its max.
 */
function enforceCeiling(
  tx: PreparedTransaction,
  feeCeiling: bigint | undefined,
  feeRateCeiling: bigint | undefined,
): PreparedTransaction {
  const rate = bidPerGas(tx);
  if (feeRateCeiling !== undefined) {
    if (feeRateCeiling < 0n) throw new Error("a fee ceiling cannot be negative");
    const tip = tx.fees.type === "eip1559" ? tx.fees.maxPriorityFeePerGas : 0n;
    if (rate > feeRateCeiling || tip > feeRateCeiling) {
      throw new FeeCeilingError(maxFeeOf(tx), feeCeiling ?? feeRateCeiling * tx.gas, {
        kind: "rate",
        feePerGas: rate > tip ? rate : tip,
        ceilingPerGas: feeRateCeiling,
      });
    }
  }
  if (feeCeiling === undefined) return tx;
  if (feeCeiling < 0n) throw new Error("a fee ceiling cannot be negative");
  const fee = maxFeeOf(tx);
  if (fee > feeCeiling) {
    throw new FeeCeilingError(fee, feeCeiling, { kind: "total", feePerGas: rate, ceilingPerGas: feeRateCeiling ?? null });
  }
  return tx;
}

export interface PrepareTransactionInput {
  /** The account that signs. */
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  /** The chain the transaction is for. The endpoint must agree. */
  chainId: number;
  /**
   * Margin added to the gas estimate, in basis points. Default 2000 (20%).
   *
   * An estimate is a measurement against the state of the moment it was made;
   * a swap that lands a block later may cross one more tick or touch one more
   * cold slot, and a transaction that runs out of gas still pays for all of
   * it. Unused gas is refunded, so the margin costs nothing when it is not
   * needed — only the balance check and the fee ceiling see it.
   */
  headroomBps?: number;
  /**
   * The lowest nonce the host will accept, when it knows of a transaction the
   * endpoint does not: one posted to a private relay and not yet mined is
   * invisible to the public pending count, and reusing its nonce would replace
   * it. The host should pass the nonce after the last one it signed that it has
   * not yet seen mined or dropped — a stale floor leaves a gap that nothing
   * fills, and the transaction waits behind it.
   */
  nonceFloor?: number;
  /**
   * The most this transaction may pay in fees, in wei (checked against
   * `maxFeeOf`). Omit only when a person is about to look at the fee before
   * it is signed; an unattended buy should always pass one. See the file
   * comment for why.
   */
  feeCeiling?: bigint;
  /**
   * The most this transaction may bid per unit of gas, in wei: its
   * `maxFeePerGas` (and priority fee), or its `gasPrice`. Passed with
   * `feeCeiling` by every unattended signature, because the endpoint answers
   * the fee read made here — after whatever the caller checked — and the
   * per-transaction figure alone would let it trade gas for price.
   */
  feeRateCeiling?: bigint;
}

/**
 * Everything but the signature, read from the user's endpoint.
 *
 * The chain id is checked first; then nonce (pending, raised to `nonceFloor`),
 * fees (`readFees`) and gas (`eth_estimateGas` plus `headroomBps`) are read
 * together. An estimate that fails — the swap would revert right now — throws
 * with the endpoint's reason, which is the most useful thing to show.
 */
export async function prepareTransaction(
  rpc: JsonRpc,
  input: PrepareTransactionInput,
): Promise<PreparedTransaction> {
  const from = checkedAddress(input.from, "the sender");
  const to = checkedAddress(input.to, "the recipient");
  if (typeof input.data !== "string" || !DATA_RE.test(input.data)) throw new Error("the calldata is not hex bytes");
  const data = input.data.toLowerCase() as Hex;
  if (typeof input.value !== "bigint" || input.value < 0n) throw new Error("the value must be a non-negative bigint");
  const chainId = checkedChainId(input.chainId);

  const headroomBps = input.headroomBps ?? DEFAULT_GAS_HEADROOM_BPS;
  if (!Number.isInteger(headroomBps) || headroomBps < 0 || headroomBps > MAX_GAS_HEADROOM_BPS) {
    throw new Error(`gas headroom must be a whole number of basis points from 0 to ${MAX_GAS_HEADROOM_BPS}`);
  }
  const nonceFloor = input.nonceFloor ?? 0;
  if (!Number.isSafeInteger(nonceFloor) || nonceFloor < 0) throw new Error("the nonce floor must be a whole number");

  await assertChain(rpc, chainId);

  const [pending, fees, estimate] = await Promise.all([
    pendingNonce(rpc, from),
    readFees(rpc),
    readQuantity(rpc, "a gas estimate", "eth_estimateGas", [{ from, to, data, value: toQuantity(input.value) }]),
  ]);
  if (estimate === 0n) throw new Error("could not read a gas estimate: the endpoint estimated zero gas");

  // Rounded up: a limit one unit short of what was needed is a failed buy
  // that still pays for everything it used.
  const gas = (estimate * BigInt(10_000 + headroomBps) + 9_999n) / 10_000n;

  return enforceCeiling(
    { from, chainId, nonce: Math.max(pending, nonceFloor), to, data, value: input.value, gas, fees },
    input.feeCeiling,
    input.feeRateCeiling,
  );
}

// ── Signing ───────────────────────────────────────────────────────────────

/**
 * Sign a prepared transaction: `{ raw, hash }`, with `hash = keccak256(raw)`.
 *
 * Refuses a key that is not the one the transaction was prepared for (see
 * `PreparedTransaction.from`), and a type-2 fee pair no node would accept,
 * rather than producing bytes that fail only once broadcast. Nothing here
 * touches the network: sending is the host's step, after it has recorded the
 * hash.
 *
 * Signatures are deterministic (RFC 6979; viem signs without added entropy
 * unless something calls its `setSignEntropy`, which nothing in spDEX does),
 * so identical inputs give identical bytes — which is what lets the unit tests
 * pin them.
 */
export async function signPrepared(privateKey: Hex, tx: PreparedTransaction): Promise<{ raw: Hex; hash: Hex }> {
  const key = checkedKey(privateKey);
  const from = checkedAddress(tx.from, "the prepared sender");
  if (privateKeyToAddress(key).toLowerCase() !== from) {
    throw new Error(`this transaction was prepared for ${from}, which is not the address of this key`);
  }
  const chainId = checkedChainId(tx.chainId);
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) throw new Error(`nonce ${tx.nonce} is not a nonce`);
  if (typeof tx.gas !== "bigint" || tx.gas <= 0n) throw new Error("the gas limit must be positive");
  if (typeof tx.value !== "bigint" || tx.value < 0n) throw new Error("the value must be a non-negative bigint");
  if (typeof tx.data !== "string" || !DATA_RE.test(tx.data)) throw new Error("the calldata is not hex bytes");

  const base = {
    chainId,
    nonce: tx.nonce,
    to: checkedAddress(tx.to, "the recipient"),
    data: tx.data.toLowerCase() as Hex,
    value: tx.value,
    gas: tx.gas,
  };

  let raw: Hex;
  if (tx.fees.type === "eip1559") {
    const { maxFeePerGas, maxPriorityFeePerGas } = tx.fees;
    if (maxFeePerGas < 0n || maxPriorityFeePerGas < 0n) throw new Error("fees cannot be negative");
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new Error("the priority fee exceeds the max fee; no node would accept this transaction");
    }
    raw = await signTransaction({
      privateKey: key,
      transaction: { type: "eip1559", ...base, maxFeePerGas, maxPriorityFeePerGas },
    });
  } else {
    if (tx.fees.gasPrice < 0n) throw new Error("fees cannot be negative");
    raw = await signTransaction({
      privateKey: key,
      transaction: { type: "legacy", ...base, gasPrice: tx.fees.gasPrice },
    });
  }

  return { raw, hash: keccak256(raw) };
}

/**
 * The hash of a signed transaction: keccak256 of its bytes, lowercase.
 *
 * The same figure `signPrepared` returns, for bytes something else signed —
 * a wallet answering `eth_signTransaction`. Computed here rather than taken
 * from whoever the bytes are posted to, because a relay that reports a hash is
 * describing what it says it received; the hash of what was signed is known
 * before anything is sent, which is what lets a host record it first.
 */
export function transactionHash(raw: string): Hex {
  if (typeof raw !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(raw)) {
    throw new Error("not a signed transaction: expected 0x followed by an even number of hex digits");
  }
  return keccak256(raw.toLowerCase() as Hex).toLowerCase() as Hex;
}

// ── What a buy's gas can cost ─────────────────────────────────────────────

/** A swap's gas limit, budgeted; see `estimateBuyGas`. */
const SWAP_GAS = 350_000n;
/** An exact-amount approval's gas limit, budgeted; see `estimateBuyGas`. */
const APPROVE_GAS = 70_000n;
const NATIVE_BUY_GAS = SWAP_GAS;
const TOKEN_BUY_GAS = SWAP_GAS + APPROVE_GAS;

/**
 * Gas budgeted for one buy, for stating what a plan's network fees can come
 * to before it starts (the Recurring form's "up to" figure).
 *
 * A bound on the *gas limits* one single-leg buy's transactions carry (the
 * estimate plus the default 20% headroom), because the limit — not the gas
 * actually used — is what the paying wallet must be able to cover for the buy
 * to be accepted at all. `buys × estimateBuyGas(kind) × maxFeePerGas` is
 * therefore the most a plan's buys can cost in fees for as long as fees stay
 * at or under that `maxFeePerGas`, which already allows the base fee to
 * double.
 *
 * The figures are measurements, not guesses. Measured with `eth_estimateGas`
 * against the pinned fork, from a fresh spending wallet paying a recipient
 * that held none of the token bought (the dearer case — its balance slot goes
 * from zero to non-zero), at buy sizes from 0.01 to 1 ETH or its worth in the
 * token sold:
 *
 * - **native** (one swap, value attached): ETH→SPX and ETH→USDC through
 *   Uniswap v2, v3 0.3% and v3 1% estimated 155,881–267,786 gas, the top of
 *   that being 1 ETH through the thin v3 1% SPX pool, crossing ticks. With
 *   20% headroom, rounded up as `prepareTransaction` rounds, the worst is
 *   321,344; budgeted at **350,000**.
 * - **token** (an exact-amount approval, then the swap): approvals estimated
 *   46,052 (WETH), 46,886 (SPX) and 55,949 (USDC, whose proxy makes it the
 *   dearest), so 67,139 with headroom; token-in swaps (SPX→ETH, SPX→USDC,
 *   USDC→SPX, USDC→ETH, WETH→SPX) estimated 150,554–213,802, inside the native
 *   figure. Budgeted at 350,000 + 70,000 = **420,000**. Every token buy needs
 *   its own approval because the Guard caps each one at the amount being sold.
 *
 * `packages/chain/test/integration/local-key.test.ts` holds a native
 * and a token buy's prepared limits under these on the fork, so a change that
 * made buys dearer fails there rather than in a stalled plan.
 *
 * What it does not cover, stated so nobody has to find out:
 * - **A split buy.** Each leg is its own transaction, so a buy the router
 *   splits into k legs costs about k times this.
 * - **A buy large against its pool.** Crossing many ticks is what makes a v3
 *   swap dear: 10 ETH through the v3 0.3% SPX pool estimated 333,800, and a
 *   sale that emptied most of the thin v3 1% pool's ether side estimated over
 *   800,000.
 *
 * Neither can overspend: every buy is still prepared against the real chain,
 * and the wallet that pays shows its own fee before anything is signed. The
 * figure is a statement made in advance, not a limit.
 */
export function estimateBuyGas(kind: "native" | "token"): bigint {
  if (kind === "native") return NATIVE_BUY_GAS;
  if (kind === "token") return TOKEN_BUY_GAS;
  throw new Error(`no gas budget for a buy of kind ${String(kind)}`);
}

