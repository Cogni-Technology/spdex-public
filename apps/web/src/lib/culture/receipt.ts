/**
 * `#receipt=<chainId>:<hash>`: what the chain says a transaction did with SPX.
 *
 * An "I bought" card carries a transaction hash, and this is how anyone checks
 * it: open the fragment in any copy of spDEX, and the transaction is read
 * through the viewer's own network service, never taken from the card. The
 * card can say anything; this reads what happened.
 *
 * What counts, and what it is called, is deliberately narrow:
 * - **Only SPX's own `Transfer` logs,** emitted by the SPX contract itself.
 *   Any contract can emit a log shaped like a transfer, so a log from anywhere
 *   else moved nothing.
 * - **Netted per address,** in minus out, so SPX sent to yourself, or passed
 *   through on the way somewhere else, is not a delivery. A pool spDEX finds
 *   for SPX is never a receiver: SPX paid into one was sold, not delivered.
 * - **"Bought" is only what a market's swap paid out:** SPX a pool spDEX
 *   itself finds for SPX sent the receiver, less what they sent it back, and
 *   no more than that pool's own `Swap` logs say it paid them. So a pool's
 *   payout with no swap behind it (liquidity taken out, fees collected, a
 *   donation skimmed) isn't a purchase, and neither is SPX from anyone else
 *   in the same transaction: a dust swap can't vouch for a large transfer
 *   beside it. When the receiver owns a vault its factory vouches for
 *   (`isVault`) that bought in the transaction, the purchase is named as the
 *   vault's: every release's factory is asked, since a v1 vault's buys go on
 *   after v2's factory makes the new ones. The rest of what they gained is a delivery of its own, named by
 *   where it came from; a transfer between two people is never presented as
 *   a purchase.
 *
 * It reads the receipt, the block (for its time) and, when the transaction
 * holds a vault's `Bought`, one Multicall3 asking each factory about each such
 * vault. Nothing else, and only through the viewer's service.
 */

import { TOKENS, TOPICS, type JsonRpc, type Multicall3Reader } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { decodeVaultEvent, DEPLOYMENTS, readVouchedOwners } from "@spdex/vault";
import { readBlockTime, readReceipt, topicAddress, type ReceiptLog } from "../receipts.js";
import { TOKEN_LIST, type TokenInfo } from "../tokens.js";
import { checksumAddress } from "./contract.js";

// ─── The fragment ─────────────────────────────────────────────────────────────

export interface ReceiptTarget {
  chainId: number;
  /** Lowercase. */
  hash: Hex;
}

/**
 * The transaction a `#receipt=` fragment names, or null for anything else.
 *
 * Exactly `receipt=<chainId>:0x<64 hex>`, or a bare `receipt=0x<64 hex>`,
 * which means Ethereum: the first cards were for Ethereum, and a hash alone
 * is what someone copying from an explorer pastes. The leading "#" is
 * optional, and percent-encoding (a ":" some apps send as "%3A") is read
 * once. Nothing else may ride along: this is a link strangers send, and a
 * parser that skipped what it didn't understand would be a parser that
 * could be steered.
 */
export function receiptFromUrl(fragment: string): ReceiptTarget | null {
  let text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  const match = /^receipt=(?:([1-9][0-9]{0,15}):)?(0x[0-9a-fA-F]{64})$/.exec(text);
  if (!match) return null;
  const chainId = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isSafeInteger(chainId)) return null;
  return { chainId, hash: match[2]!.toLowerCase() as Hex };
}

/** "#receipt=1:0x…", the fragment `receiptFromUrl` reads back. */
export function receiptFragment(target: ReceiptTarget): string {
  return `#receipt=${target.chainId}:${target.hash.toLowerCase()}`;
}

// ─── What the logs say ────────────────────────────────────────────────────────

export interface SpxTransfer {
  from: Address;
  to: Address;
  amount: bigint;
}

const SPX = TOKENS.SPX.address.toLowerCase() as Address;
const lower = (a: string) => a.toLowerCase() as Address;

/**
 * SPX's own `Transfer` logs, in order. A log from any other contract, or one
 * not laid out as an ERC-20 transfer (three topics, one word of data), is
 * left out rather than guessed at.
 */
export function spxTransfers(logs: readonly ReceiptLog[]): SpxTransfer[] {
  const found: SpxTransfer[] = [];
  for (const log of logs) {
    if (lower(log.address) !== SPX) continue;
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TOPICS.transfer) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    found.push({ from: topicAddress(log.topics[1]!), to: topicAddress(log.topics[2]!), amount: BigInt(log.data) });
  }
  return found;
}

/** Where a receiver's SPX came from, as far as the chain shows it. */
export type SpxSource =
  /** A pool spDEX finds for SPX paid it out in a swap: a purchase. */
  | { kind: "pool"; pool: Address; venue: "Uniswap v2" | "Uniswap v3"; pairedWith: string | null }
  /** A vault its factory vouches for bought it for its owner, the receiver. */
  | { kind: "vault"; vault: Address }
  /** A pool spDEX finds for SPX paid it out with no swap of its own behind it: liquidity, fees or a skim. Never a purchase. */
  | { kind: "pool-payout"; pool: Address }
  /**
   * Anyone else: a person, a contract, a router. Never called a purchase.
   * `others` counts the further senders this delivery also came from, when
   * there were any.
   */
  | { kind: "account"; from: Address; others?: number };

export interface SpxDelivery {
  to: Address;
  /**
   * SPX base units, always more than zero. A receiver's deliveries add up to
   * their net gain in the transaction: what a market's swaps paid them first
   * (capped by that gain), then the rest, from wherever else it came.
   */
  amount: bigint;
  source: SpxSource;
}

/** A pool spDEX finds for SPX, and which of its two tokens SPX is (its `Swap` logs name amounts by position). */
export interface SpxPool {
  address: string;
  spxIsToken0: boolean;
}

export interface DeliveryContext {
  /** Pools spDEX discovers for SPX, paired with any token it lists (`spxPoolsOf`), any case. */
  spxPools: readonly SpxPool[];
  /** Vaults that emitted `Bought` in this transaction and that a factory vouches for, each with its owner. */
  vaultOwners: ReadonlyMap<Address, Address>;
}

/** What finds pools for a pair: `Engine.discoverPools`. */
export interface PoolFinder {
  discoverPools(a: TokenInfo, b: TokenInfo): Promise<readonly { poolId: string; token0: string; token1: string }[]>;
}

/**
 * The SPX markets spDEX finds, for the receipt view: only SPX a swap in one
 * of these paid out reads as "bought from" a market. Every token spDEX lists
 * is asked for its SPX pools, since a buy with USDC is paid by a USDC/SPX
 * pool. A pair whose discovery fails adds none, so nothing is credited to a
 * market it can't name.
 */
export async function spxPoolsFrom(finder: PoolFinder): Promise<SpxPool[]> {
  const spx = TOKEN_LIST.find((token) => token.symbol === "SPX")!;
  // ETH trades as WETH, so asking for both would ask for the same pools twice.
  const paired = TOKEN_LIST.filter((token) => token.symbol !== "SPX" && token.symbol !== "WETH");
  const found = await Promise.all(paired.map((token) => finder.discoverPools(token, spx).catch(() => [])));
  return spxPoolsOf(found.flat());
}

/** The SPX pools among discovered pools (`Engine.discoverPools`), each once, with SPX's position in it. */
export function spxPoolsOf(pools: readonly { poolId: string; token0: string; token1: string }[]): SpxPool[] {
  const found = new Map<Address, SpxPool>();
  for (const pool of pools) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool.poolId)) continue;
    const token0 = lower(pool.token0);
    if (token0 !== SPX && lower(pool.token1) !== SPX) continue;
    found.set(lower(pool.poolId), { address: lower(pool.poolId), spxIsToken0: token0 === SPX });
  }
  return [...found.values()];
}

/**
 * Every address other than a known SPX pool that ended the transaction with
 * more SPX than it started, and where that came from, in the order each
 * first received SPX: what it bought first, then anything else.
 */
export function spxDeliveries(logs: readonly ReceiptLog[], context: DeliveryContext): SpxDelivery[] {
  const transfers = spxTransfers(logs);
  const net = new Map<Address, bigint>();
  for (const { from, to, amount } of transfers) {
    net.set(from, (net.get(from) ?? 0n) - amount);
    net.set(to, (net.get(to) ?? 0n) + amount);
  }
  const pools = new Map(context.spxPools.map((pool) => [lower(pool.address), pool.spxIsToken0] as const));
  const receivers = [...new Set(transfers.map((t) => t.to))].filter((to) => !pools.has(to) && (net.get(to) ?? 0n) > 0n);
  return receivers.flatMap((to) => deliveriesTo(to, net.get(to)!, transfers, logs, pools, context.vaultOwners));
}

function deliveriesTo(
  to: Address,
  gain: bigint,
  transfers: readonly SpxTransfer[],
  logs: readonly ReceiptLog[],
  pools: ReadonlyMap<Address, boolean>,
  vaultOwners: ReadonlyMap<Address, Address>,
): SpxDelivery[] {
  // What each sender paid `to`, net of what `to` paid that sender back.
  const paid = new Map<Address, bigint>();
  for (const t of transfers) if (t.to === to && t.from !== to) paid.set(t.from, (paid.get(t.from) ?? 0n) + t.amount);
  for (const t of transfers) if (t.from === to && paid.has(t.to)) paid.set(t.to, paid.get(t.to)! - t.amount);

  // The market part: from each known pool, what its own swaps paid `to`.
  let bought = 0n;
  let biggest: { pool: Address; amount: bigint } | null = null;
  const rest = new Map<Address, bigint>();
  for (const [sender, amount] of paid) {
    if (amount <= 0n) continue;
    const spxIsToken0 = pools.get(sender);
    const market = spxIsToken0 === undefined ? 0n : min(amount, swapPaidOut(sender, to, spxIsToken0, logs));
    if (market > 0n) {
      bought += market;
      if (biggest === null || market > biggest.amount) biggest = { pool: sender, amount: market };
    }
    if (amount > market) rest.set(sender, amount - market);
  }

  const out: SpxDelivery[] = [];
  const credited = min(bought, gain);
  if (credited > 0n && biggest !== null) {
    // A vault has the pair pay its owner directly, so a vault's buy is also a
    // pool's swap; the vault is named, since it is what the owner set up.
    const vault = [...vaultOwners].find(([, owner]) => owner === to)?.[0];
    const venue = venueOf(biggest.pool, logs)!;
    out.push({
      to,
      amount: credited,
      source: vault !== undefined ? { kind: "vault", vault } : { kind: "pool", pool: biggest.pool, venue, pairedWith: pairedWith(biggest.pool, logs) },
    });
  }
  const other = gain - credited;
  if (other > 0n) {
    const senders = [...rest].sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0));
    const [largest] = senders;
    const from = largest?.[0] ?? to;
    out.push({
      to,
      amount: other,
      source: pools.has(from)
        ? { kind: "pool-payout", pool: from }
        : { kind: "account", from, ...(senders.length > 1 ? { others: senders.length - 1 } : {}) },
    });
  }
  return out;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The SPX `pool`'s own `Swap` logs say it paid out to `to` in this
 * transaction: a v2 pair's `amountOut` on SPX's side, or a v3 pool's
 * negative amount on SPX's side, for each swap whose recipient is `to`.
 */
function swapPaidOut(pool: Address, to: Address, spxIsToken0: boolean, logs: readonly ReceiptLog[]): bigint {
  let total = 0n;
  for (const log of logs) {
    if (lower(log.address) !== pool || log.topics.length !== 3 || topicAddress(log.topics[2]!) !== to) continue;
    const body = log.data.replace(/^0x/, "");
    const topic = log.topics[0]?.toLowerCase();
    if (topic === TOPICS.uniV2Swap && body.length >= 256) {
      // amount0In, amount1In, amount0Out, amount1Out.
      total += uintWord(body, spxIsToken0 ? 2 : 3);
    } else if (topic === TOPICS.uniV3Swap && body.length >= 128) {
      // amount0, amount1, signed from the pool's side: negative left it.
      const amount = intWord(body, spxIsToken0 ? 0 : 1);
      if (amount < 0n) total += -amount;
    }
  }
  return total;
}

const uintWord = (body: string, i: number): bigint => BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`);
const intWord = (body: string, i: number): bigint => BigInt.asIntN(256, uintWord(body, i));

/** Which Uniswap a pool is, from the `Swap` it logged in this same transaction. */
function venueOf(pool: Address, logs: readonly ReceiptLog[]): "Uniswap v2" | "Uniswap v3" | null {
  for (const log of logs) {
    if (lower(log.address) !== pool) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (topic === TOPICS.uniV2Swap) return "Uniswap v2";
    if (topic === TOPICS.uniV3Swap) return "Uniswap v3";
  }
  return null;
}

/** The token the pool was paid in, when it is one spDEX names; null otherwise. */
function pairedWith(pool: Address, logs: readonly ReceiptLog[]): string | null {
  const paid = new Set<string>();
  for (const log of logs) {
    const token = lower(log.address);
    if (token === SPX || log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TOPICS.transfer) continue;
    if (topicAddress(log.topics[2]!) === pool) paid.add(token);
  }
  if (paid.size !== 1) return null;
  const [token] = paid;
  return TOKEN_LIST.find((t) => t.address.toLowerCase() === token)?.symbol ?? null;
}

/**
 * Every release's vault factory, oldest first (`DEPLOYMENTS`): the ones the
 * receipt view asks. A v1 vault keeps buying for good, and only v1's factory
 * vouches for it.
 */
export const VAULT_FACTORIES: readonly Address[] = DEPLOYMENTS.map((deployment) => lower(deployment.factory));

/** The vaults whose `Bought` is in these logs, of either release, by the address that emitted it. */
export function boughtEmitters(logs: readonly ReceiptLog[]): Address[] {
  const emitters = new Set<Address>();
  for (const log of logs) {
    const event = decodeVaultEvent({ address: log.address, topics: log.topics, data: log.data });
    if (event?.name === "Bought") emitters.add(event.emitter);
  }
  return [...emitters];
}

// ─── Reading it ───────────────────────────────────────────────────────────────

export type ReceiptOutcome =
  /** The service has no receipt for this hash: not mined, not on this chain, or never sent. */
  | { kind: "unknown" }
  | { kind: "failed"; block: bigint; time: number | null }
  | { kind: "no-spx"; block: bigint; time: number | null }
  | {
      kind: "delivered";
      block: bigint;
      /** The block's time, unix seconds; null when it couldn't be read. */
      time: number | null;
      deliveries: SpxDelivery[];
      /**
       * Whether the vaults in it were asked about. "unavailable" when that
       * read failed: then no delivery is credited to a vault, and a vault's
       * buy reads as the pool's payout it also is.
       */
      vaults: "none" | "checked" | "unavailable";
    };

/**
 * What the chain says `hash` did with SPX, read through `rpc`.
 *
 * Throws only when the receipt can't be read (the service can't be asked,
 * or answers with something that isn't a receipt), so the view can offer to
 * try again; every other answer the service gives becomes an outcome.
 */
export async function verifyReceipt(
  rpc: JsonRpc,
  input: {
    hash: Hex;
    spxPools: readonly SpxPool[];
    /** The factories whose word makes a sender a vault (`VAULT_FACTORIES`); none where there are no vaults. */
    factories: readonly Address[];
    /** Batches the vault questions (`readVouchedOwners`); a Multicall3 reader over `rpc` unless a test stands in for it. */
    reader?: Pick<Multicall3Reader, "multicall">;
  },
): Promise<ReceiptOutcome> {
  const receipt = await readReceipt(rpc, input.hash);
  if (receipt === null) return { kind: "unknown" };
  const block = receipt.blockNumber;
  const time = await readBlockTime(rpc, block).catch(() => null);
  if (receipt.status === "reverted") return { kind: "failed", block, time };

  const emitters = input.factories.length === 0 ? [] : boughtEmitters(receipt.logs);
  let vaultOwners = new Map<Address, Address>();
  let vaults: "none" | "checked" | "unavailable" = "none";
  if (input.factories.length > 0 && emitters.length > 0) {
    try {
      vaultOwners = await readVouchedOwners(rpc, input.factories, emitters, input);
      vaults = "checked";
    } catch {
      vaults = "unavailable";
    }
  }

  const deliveries = spxDeliveries(receipt.logs, { spxPools: input.spxPools, vaultOwners });
  if (deliveries.length === 0) return { kind: "no-spx", block, time };
  return { kind: "delivered", block, time, deliveries, vaults };
}

// ─── Words ────────────────────────────────────────────────────────────────────

/**
 * Where a delivery came from, in the words the receipt view prints. Only a
 * pool's swap or a vault "bought"; anyone else's SPX was "received".
 */
export function sourceText(source: SpxSource): string {
  switch (source.kind) {
    case "pool": {
      const pair = source.pairedWith === null ? "SPX" : `SPX/${source.pairedWith}`;
      return `bought from the ${source.venue} ${pair} pool ${checksumAddress(source.pool)}`;
    }
    case "vault":
      return `delivered by a vault the factory vouches for (${checksumAddress(source.vault)})`;
    case "pool-payout":
      return `received from the SPX pool ${checksumAddress(source.pool)} without a swap: liquidity or fees taken out, not a purchase`;
    case "account": {
      const more = source.others === undefined ? "" : ` and ${source.others} other ${source.others === 1 ? "sender" : "senders"}`;
      return `received from ${checksumAddress(source.from)} (an account)${more}`;
    }
  }
}
