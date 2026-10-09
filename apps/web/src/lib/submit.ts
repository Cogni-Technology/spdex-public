/**
 * Getting a signed transaction to the chain.
 *
 * Two routes, and the difference between them is not cosmetic:
 *
 * **wallet** — the wallet broadcasts however it normally does. The transaction
 * sits in the public mempool, where a searcher can see it and trade ahead of
 * it. This is what every ordinary swap does.
 *
 * **private** — spDEX asks the wallet to *sign without broadcasting*, then
 * posts the raw transaction straight to a relay such as Flashbots Protect. It
 * never enters the public mempool, so there is nothing to front-run.
 *
 * The catch, and the reason this file is careful: `eth_signTransaction` is
 * optional and many wallets refuse it outright. When that happens spDEX
 * *stops* and asks, rather than falling back to a public broadcast under a
 * label that promised privacy. A protection that silently does nothing is
 * worse than no protection, because the user sizes their trade believing they
 * have it.
 */

import { DEFAULT_GAS_HEADROOM_BPS, transactionHash, type PreparedFees } from "@spdex/chain";
import type { SubmitterConfig } from "@spdex/core";
import { readWalletFees, suggestedTip } from "./fees.js";
import { readSignedTransaction, signedMismatch } from "./signedTx.js";
import { detectProvider, type Eip1193Provider, type ReadRpc, type SendableCall } from "./wallet.js";

export class PrivateSubmissionUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`private submission unavailable: ${reason}`);
    this.name = "PrivateSubmissionUnavailable";
  }
}

/**
 * The wallet signed a private transaction too late to be worth sending.
 *
 * Only a private submission can be caught: spDEX holds the signed bytes before
 * anyone else does, and can decline to post them. A swap signed after its
 * deadline can only revert on chain — and a reverted transaction still pays
 * its fee — so a caller that knows the deadline (a scheduled buy, whose
 * wallet prompt may sit unanswered) passes `notAfter`, and a signature that
 * comes back later than that is dropped here. Nothing was sent.
 */
export class LateSignature extends Error {
  constructor(
    /** Unix seconds: the latest a signature could come back and still be posted. */
    readonly notAfter: number,
    /** Unix seconds: when it came back. */
    readonly signedAt: number,
  ) {
    super(`the wallet signed at ${signedAt}, after the ${notAfter} this transaction had to be sent by; it was not sent`);
    this.name = "LateSignature";
  }
}

/** Optional limits on a private submission; see `LateSignature`. */
export interface PrivateSubmitOptions {
  /** Unix seconds. A signature returned after this is not posted. */
  notAfter?: number;
  /** Milliseconds since the epoch; the wall clock by default. For tests. */
  now?: () => number;
  /**
   * The hash of the signed bytes, computed here, before they are posted.
   * Awaited: a caller that records it (a scheduled buy's ledger) finishes
   * recording before anything leaves, so a relay answer lost on the way back
   * leaves a hash to look for rather than nothing.
   *
   * Given this, the submission also holds the relay to that hash: the result
   * carries the hash computed from the signed bytes, a relay that reports a
   * different one is refused as describing some other transaction, "already
   * known" is success, and only an answered JSON-RPC error is a refusal
   * (`RawTransactionRejected`) — an HTTP error or a dropped connection is
   * thrown as it is, since the relay may well have taken the transaction.
   * Without it, the relay's answer is returned as it always was.
   */
  onSigned?: (hash: `0x${string}`) => void | Promise<void>;
}

export interface SubmitResult {
  hash: string;
  /** How it actually went out — never how it was configured to go out. */
  via: "wallet" | "private";
}

/**
 * The gas limit a privately sent transaction is signed with: the endpoint's
 * estimate plus `DEFAULT_GAS_HEADROOM_BPS`, rounded up — exactly the margin
 * @spdex/chain's `prepareTransaction` gives the transactions spDEX signs itself.
 *
 * A public send lets the wallet choose its own limit, and wallets pad their
 * estimates. A private one cannot: `eth_signTransaction` signs the figure it
 * is handed, so the margin has to be added here or there is none. And the
 * estimate only measures the state at the moment it was taken. The first
 * swap through a pair in a new block also updates the pair's price record;
 * an estimate taken while that record was already current skips the write,
 * and the transaction, landing a block later, has to make it. A limit even
 * one unit short runs out of gas, reverts, and still pays for every unit it
 * used. Unused gas is refunded, so the margin costs nothing unless it is
 * needed.
 */
export function gasWithHeadroom(estimate: bigint): bigint {
  return (estimate * BigInt(10_000 + DEFAULT_GAS_HEADROOM_BPS) + 9_999n) / 10_000n;
}

/**
 * The legacy gas price a private transaction is signed at.
 *
 * A relay offers the transaction to block builders, and a builder includes
 * what pays it: a legacy transaction's tip is its price less the block's base
 * fee. The endpoint's `eth_gasPrice` is no guide to that. Alchemy's is the
 * latest base fee plus 1 wei, which tips nothing and can't be included at all
 * once the base fee rises, so a relay may hold the transaction until it drops
 * it. So the price is at least the next block's highest possible base fee —
 * the latest one and an eighth, the most a block can add — plus the tip
 * recent blocks took (`suggestedTip`, lib/fees.ts), and the endpoint's figure
 * when that is higher. A legacy
 * price is paid in full: the eighth, when the base fee doesn't rise, goes to
 * the builder too. On a chain with no base fee, the endpoint's figure.
 *
 * A call that names its price (`SendableCall.gasPrice`) is signed at that
 * price; whoever worked it out reads it here, as Help run the network does.
 */
export async function privateGasPrice(read: ReadRpc): Promise<bigint> {
  const [quoted, block, tip] = await Promise.all([
    read("eth_gasPrice", []),
    read("eth_getBlockByNumber", ["latest", false]),
    suggestedTip(read),
  ]);
  const price = quantity(quoted, "the gas price");
  const baseFee = (block as { baseFeePerGas?: unknown } | null)?.baseFeePerGas;
  if (baseFee === undefined || baseFee === null) return price;
  const base = quantity(baseFee, "the base fee");
  const floor = base + (base + 7n) / 8n + tip;
  return price > floor ? price : floor;
}

/**
 * The wallet is on another chain than the one the transaction was checked
 * for. Nothing was signed or sent.
 */
export class WalletChainChanged extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number | null,
  ) {
    super(
      `your wallet is on ${actual === null ? "an unknown network" : `chain ${actual}`}, not chain ${expected}, which this was checked for. Nothing was sent`,
    );
    this.name = "WalletChainChanged";
  }
}

/** The wallet's chain right now, from the wallet itself; null when it won't say. */
async function walletChain(provider: Eip1193Provider): Promise<number | null> {
  try {
    const answered = await provider.request({ method: "eth_chainId" });
    return typeof answered === "string" && /^0x[0-9a-fA-F]+$/.test(answered) ? Number(BigInt(answered)) : null;
  } catch {
    return null;
  }
}

/** Refuses, before anything is signed, a wallet not on `call.chainId` (when the call names one). */
async function requireCallChain(provider: Eip1193Provider, call: SendableCall): Promise<void> {
  if (call.chainId === undefined) return;
  const actual = await walletChain(provider);
  if (actual !== call.chainId) throw new WalletChainChanged(call.chainId, actual);
}

/**
 * Refuses, before anything is read or signed, a call whose exact gas figures
 * can't be the ones it was checked with: a limit or price that isn't
 * positive, or an exact limit alongside a floor (which of the two would win
 * is exactly the kind of question a signature must not leave open).
 */
function checkExactGas(call: SendableCall): void {
  if (call.gas !== undefined && call.gasFloor !== undefined) {
    throw new Error("a call carries an exact gas limit or a gas floor, not both; nothing was sent");
  }
  if (call.gas !== undefined && call.gas <= 0n) {
    throw new RangeError(`a call's gas limit must be positive, not ${call.gas}; nothing was sent`);
  }
  if (call.gasPrice !== undefined && call.gasPrice <= 0n) {
    throw new RangeError(`a call's gas price must be positive, not ${call.gasPrice}; nothing was sent`);
  }
}

const hexQuantity = (value: bigint): `0x${string}` => `0x${value.toString(16)}`;

/** The gas limit for a call with a floor: the estimate with headroom, never under the floor. */
export function gasWithFloor(estimate: bigint | null, floor: bigint): bigint {
  const padded = estimate === null ? 0n : gasWithHeadroom(estimate);
  return padded > floor ? padded : floor;
}

/** A JSON-RPC quantity as a bigint, or an error naming what it was meant to be. */
function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`could not read ${what}: the endpoint returned ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

async function post(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`relay returned HTTP ${response.status}`);
  const json = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/**
 * Sign locally and hand the raw transaction to a relay.
 *
 * Throws `PrivateSubmissionUnavailable` when the wallet will not sign without
 * broadcasting. The caller must decide what to do about that — this function
 * will not decide on the user's behalf.
 */
export async function submitPrivately(
  provider: Eip1193Provider,
  from: `0x${string}`,
  call: SendableCall,
  relayUrl: string,
  /**
   * Where to read nonce, gas price and the gas estimate from.
   *
   * This parameter carries the privacy guarantee, which is easy to miss.
   * `eth_estimateGas` includes the transaction's full calldata — which pool,
   * which direction, how much — so routing it through `provider` hands the
   * trade to the *wallet's* backend node moments before spDEX posts the same
   * transaction to a relay specifically so that nobody sees it early. That
   * closes the public mempool and leaves a private line to Infura open.
   *
   * Reading through the user's own configured endpoint instead does not make
   * the trade invisible — that endpoint operator sees it too, which the
   * disclaimer and the first-run screen say plainly — but it stops handing it to a second party
   * who was never part of the bargain. Falls back to the wallet when no reader
   * is supplied, because a leak is still better than not working.
   */
  reads?: ReadRpc,
  options: PrivateSubmitOptions = {},
): Promise<SubmitResult> {
  checkExactGas(call);
  const read: ReadRpc = reads ?? ((method, params) => provider.request({ method, params }));

  // chainId comes from the wallet regardless: the signature has to be valid for
  // the chain the wallet believes it is on, not the one the reader is pointed
  // at. The app refuses to quote at all while those two disagree, so by the
  // time anything reaches here they have already been reconciled.
  //
  // A call that names its gas price is signed at exactly that price (see
  // `SendableCall.gasPrice`); only a call that doesn't is priced here, with a
  // tip a builder will take (`privateGasPrice`).
  const [nonce, chainId, gasPrice] = (await Promise.all([
    read("eth_getTransactionCount", [from, "pending"]),
    provider.request({ method: "eth_chainId" }),
    call.gasPrice === undefined ? privateGasPrice(read).then(hexQuantity) : hexQuantity(call.gasPrice),
  ])) as [string, string, string];
  // Signed for the chain the wallet reports, so that chain must be the one
  // the call was checked for (see `SendableCall.chainId`).
  if (call.chainId !== undefined) {
    const actual = typeof chainId === "string" && /^0x[0-9a-fA-F]+$/.test(chainId) ? Number(BigInt(chainId)) : null;
    if (actual !== call.chainId) throw new WalletChainChanged(call.chainId, actual);
  }

  // The wallet signs this limit as given; see `gasWithHeadroom`, and
  // `SendableCall.gasFloor` for a call whose estimate is known to run short.
  // A call with an exact limit (`SendableCall.gas`) is signed with it, and no
  // estimate is taken: its limit is the one it was checked at.
  let gas: `0x${string}`;
  if (call.gas !== undefined) {
    gas = hexQuantity(call.gas);
  } else {
    const estimate = quantity(
      await read("eth_estimateGas", [{ from, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` }]),
      "a gas estimate",
    );
    gas = hexQuantity(call.gasFloor === undefined ? gasWithHeadroom(estimate) : gasWithFloor(estimate, call.gasFloor));
  }

  let signed: string;
  try {
    signed = (await provider.request({
      method: "eth_signTransaction",
      params: [
        {
          from,
          to: call.to,
          data: call.data,
          value: `0x${call.value.toString(16)}`,
          nonce,
          chainId,
          gas,
          gasPrice,
        },
      ],
    })) as string;
  } catch (error) {
    // 4200 is "method not supported"; some wallets use -32601, and several
    // simply throw. All of them mean the same thing: no private submission.
    throw new PrivateSubmissionUnavailable(
      error instanceof Error ? error.message : "wallet refused eth_signTransaction",
    );
  }

  if (typeof signed !== "string" || !signed.startsWith("0x")) {
    throw new PrivateSubmissionUnavailable("wallet returned no signed transaction");
  }

  // The bytes are posted as they are, so they must be the call that was
  // checked: a wallet that fills in its own fees or re-estimates the limit
  // signs something else (lib/signedTx.ts). Nothing is posted then.
  const mismatch = signedMismatch(readSignedTransaction(signed), {
    to: call.to,
    data: call.data,
    value: call.value,
    chainId: BigInt(chainId),
    nonce: BigInt(nonce),
    gas: call.gas ?? null,
    gasPrice: call.gasPrice ?? null,
  });
  if (mismatch !== null) {
    throw new PrivateSubmissionUnavailable(`the wallet didn't sign the transaction spDEX checked (${mismatch}), so nothing was sent`);
  }

  if (options.notAfter !== undefined) {
    const signedAt = Math.floor((options.now ?? Date.now)() / 1000);
    if (signedAt > options.notAfter) throw new LateSignature(options.notAfter, signedAt);
  }

  if (options.onSigned) {
    let hash: `0x${string}`;
    try {
      hash = transactionHash(signed);
    } catch {
      // Bytes that do not hash are bytes no relay would take either; nothing
      // was posted, exactly as for a wallet that returned nothing.
      throw new PrivateSubmissionUnavailable("wallet returned a malformed signed transaction");
    }
    await options.onSigned(hash);
    const reported = await relayRawTransaction(relayUrl, signed);
    if (typeof reported === "string" && reported.toLowerCase() !== hash) {
      throw new Error(`the relay reported hash ${reported}, but the transaction signed has hash ${hash}`);
    }
    return { hash, via: "private" };
  }

  const hash = (await post(relayUrl, "eth_sendRawTransaction", [signed])) as string;
  return { hash, via: "private" };
}

export async function submitViaWallet(
  provider: Eip1193Provider,
  from: `0x${string}`,
  call: SendableCall,
  /** Where a floored call's gas is estimated; the wallet when absent. See `submitPrivately`'s `reads`. */
  reads?: ReadRpc,
): Promise<SubmitResult> {
  checkExactGas(call);
  await requireCallChain(provider, call);
  const value = `0x${call.value.toString(16)}`;
  const read: ReadRpc = reads ?? ((method, params) => provider.request({ method, params }));
  // An exact limit and price go to the wallet as they are, so that what it
  // is asked to send is what was checked; a wallet may still let its user
  // change them, which no page can prevent.
  let gas: bigint | undefined = call.gas;
  if (call.gasFloor !== undefined) {
    // A wallet sets its own limit from its own estimate, which runs as short
    // as any other; a call with a floor carries its limit instead. An
    // estimate that fails leaves the floor.
    const estimate = await Promise.resolve()
      .then(() => read("eth_estimateGas", [{ from, to: call.to, data: call.data, value }]))
      .then((answer) => quantity(answer, "a gas estimate"))
      .catch(() => null);
    gas = gasWithFloor(estimate, call.gasFloor);
  }
  // Unless the call names its price, the wallet is told what to bid
  // (`readWalletFees`, lib/fees.ts): the tip blocks are taking, rather than
  // its own fee service's guess, so the fee the page quoted is the fee the
  // wallet asks. A wallet shows it as the site's suggestion, and its user can
  // still change it. A read that fails leaves the choice to the wallet.
  let fees: PreparedFees | null = null;
  if (call.gasPrice === undefined) fees = await readWalletFees(read).catch(() => null);
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: call.to,
        data: call.data,
        value,
        ...(call.chainId === undefined ? {} : { chainId: `0x${call.chainId.toString(16)}` }),
        ...(gas === undefined ? {} : { gas: `0x${gas.toString(16)}` }),
        ...(call.gasPrice === undefined ? {} : { gasPrice: hexQuantity(call.gasPrice) }),
        ...(fees?.type === "eip1559"
          ? { maxFeePerGas: hexQuantity(fees.maxFeePerGas), maxPriorityFeePerGas: hexQuantity(fees.maxPriorityFeePerGas) }
          : {}),
      },
    ],
  })) as string;
  return { hash, via: "wallet" };
}

/**
 * Submit according to config, without ever silently downgrading.
 *
 * `onPublicFallback` is how a caller grants explicit consent to broadcast
 * publicly after private submission turned out to be impossible. Returning
 * false aborts. There is deliberately no default — a caller that forgets to
 * pass it gets an abort, not a public broadcast.
 */
export async function submit(
  submitter: SubmitterConfig,
  from: `0x${string}`,
  call: SendableCall,
  onPublicFallback?: (reason: string) => Promise<boolean> | boolean,
  injectedProvider?: Eip1193Provider,
  /** Passed through to `submitPrivately`; see the note on its `reads` parameter. */
  reads?: ReadRpc,
  /** Passed through to `submitPrivately`. A public broadcast cannot be stopped once asked for, so has none. */
  privateOptions?: PrivateSubmitOptions,
): Promise<SubmitResult> {
  const provider = injectedProvider ?? detectProvider();
  if (!provider) throw new Error("no EIP-1193 wallet available");

  if (submitter.mode !== "private") return submitViaWallet(provider, from, call, reads);

  if (!submitter.url) {
    throw new Error("private submission is selected but no relay endpoint is configured");
  }

  try {
    return await submitPrivately(provider, from, call, submitter.url, reads, privateOptions);
  } catch (error) {
    if (!(error instanceof PrivateSubmissionUnavailable)) throw error;

    const consented = (await onPublicFallback?.(error.reason)) ?? false;
    if (!consented) throw error;

    return submitViaWallet(provider, from, call, reads);
  }
}

/**
 * The relay or endpoint answered, and said no.
 *
 * Distinct from every other way a broadcast can fail, because it is the one
 * that settles the question "did this transaction go out?". A JSON-RPC error
 * is a node refusing the transaction — underpriced, nonce too low, a bad
 * signature — and a refused transaction will not land. A dropped connection
 * or an HTTP error settles nothing: the relay may well have taken it before
 * the answer was lost. A caller that has already recorded the hash treats the
 * first as "not sent" and the second as "unknown", and those must never be
 * confused, since "unknown" is what stops an unattended buy being made twice.
 */
export class RawTransactionRejected extends Error {
  constructor(readonly reason: string) {
    super(`the transaction was refused: ${reason}`);
    this.name = "RawTransactionRejected";
  }
}

/**
 * Post signed bytes and classify the answer: the relay's `result` as it came,
 * null for "already known", `RawTransactionRejected` for an answered
 * JSON-RPC error, and anything else — an HTTP error, a page that is not JSON,
 * a dropped connection — thrown as a plain error, because none of those says
 * whether the transaction arrived.
 */
async function relayRawTransaction(url: string, raw: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
  });
  if (!response.ok) throw new Error(`relay returned HTTP ${response.status}`);
  const json = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
  if (json.error) {
    const message = typeof json.error.message === "string" ? json.error.message : "no reason given";
    if (isAlreadyKnown(message)) return null;
    throw new RawTransactionRejected(message);
  }
  return json.result;
}

/**
 * geth says "already known", others "known transaction"; both mean the node
 * holds it. Whole words only: "unknown transaction type" is a refusal, and
 * reading it as success would leave a transaction that never went out
 * waiting for a receipt that will never come.
 */
export function isAlreadyKnown(message: string): boolean {
  return /\balready known\b|\bknown transaction\b/i.test(message);
}

/** Relays worth offering. Users can type any URL instead. */
export const KNOWN_RELAYS = [
  { label: "Flashbots Protect", url: "https://rpc.flashbots.net/fast" },
  { label: "MEV Blocker", url: "https://rpc.mevblocker.io" },
] as const;
