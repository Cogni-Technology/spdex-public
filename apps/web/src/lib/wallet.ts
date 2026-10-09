/**
 * Wallet access over raw EIP-1193.
 *
 * No wallet-connection library. The app needs four methods and an account; a
 * connector framework would add a large dependency, a second opinion about
 * chain state, and a WalletConnect relay that watches sessions — none of which
 * belong in a bundle meant to be pinned to IPFS and audited by hand.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function detectProvider(): Eip1193Provider | null {
  return window.ethereum ?? null;
}

/**
 * Watch for the wallet moving out from under the app.
 *
 * EIP-1193 wallets change chain and account whenever the user says so, and a
 * page that reads `eth_chainId` once at connect and then trusts it forever is
 * wrong the moment they do. The failure is quiet and expensive: spDEX goes on
 * quoting against the endpoint it was configured with while the wallet signs
 * on a completely different chain, so the price on screen and the transaction
 * being signed describe two different markets. MetaMask switching back to
 * mainnet on reload is enough to trigger it.
 *
 * Returns a cleanup function. A wallet that implements neither `on` nor
 * `removeListener` simply never fires, which is the same as today's behaviour
 * rather than a crash.
 */
export function watchWallet(handlers: {
  onChainChanged?: (chainId: number) => void;
  onAccountsChanged?: (account: `0x${string}` | null) => void;
}): () => void {
  const provider = detectProvider();
  if (!provider?.on) return () => {};

  const chainHandler = (...args: unknown[]) => {
    // Spec says a hex string; some wallets send a number. Both are real.
    const raw = args[0];
    const chainId =
      typeof raw === "string" ? Number.parseInt(raw, 16) : typeof raw === "number" ? raw : NaN;
    if (Number.isFinite(chainId)) handlers.onChainChanged?.(chainId);
  };

  const accountsHandler = (...args: unknown[]) => {
    const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
    const next = accounts[0];
    // An empty array means the user disconnected this site in their wallet.
    handlers.onAccountsChanged?.(next ? (next.toLowerCase() as `0x${string}`) : null);
  };

  provider.on("chainChanged", chainHandler);
  provider.on("accountsChanged", accountsHandler);

  return () => {
    provider.removeListener?.("chainChanged", chainHandler);
    provider.removeListener?.("accountsChanged", accountsHandler);
  };
}

/**
 * An EIP-7702 delegation on an account, if it has one.
 *
 * A delegated account runs somebody else's code whenever it is *called* — which
 * includes being paid. That is a legitimate and increasingly common setup, and
 * it is also how a compromised key gets turned into a sweeper: the delegate
 * forwards any ether that arrives, in the same transaction, before the owner
 * can do anything about it.
 *
 * spDEX cares because receiving ether is now something it does. The Guard
 * already catches the outcome — it measures what the recipient actually keeps,
 * so a swept payout fails `RECIPIENT_MISMATCH` and is refused before signing —
 * but "the recipient receives nothing" is a baffling thing to read about your
 * own address. Naming the cause turns a refusal into an explanation.
 *
 * The designator is `0xef0100` followed by the delegate's 20 bytes.
 */
export async function delegationOf(read: ReadRpc, account: string): Promise<`0x${string}` | null> {
  try {
    const code = (await read("eth_getCode", [account, "latest"])) as string;
    if (typeof code !== "string" || !code.toLowerCase().startsWith("0xef0100")) return null;
    const delegate = `0x${code.slice(8, 48)}`.toLowerCase();
    return delegate.length === 42 ? (delegate as `0x${string}`) : null;
  } catch {
    // An endpoint that will not answer is not evidence of anything.
    return null;
  }
}

/** The chain the wallet is on right now, rather than when it last connected. */
export async function currentChainId(): Promise<number | null> {
  const provider = detectProvider();
  if (!provider) return null;
  try {
    return Number.parseInt((await provider.request({ method: "eth_chainId" })) as string, 16);
  } catch {
    return null;
  }
}

export async function connect(): Promise<{ address: `0x${string}`; chainId: number }> {
  const provider = detectProvider();
  if (!provider) throw new Error("no EIP-1193 wallet found in this browser");

  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts[0];
  if (!address) throw new Error("wallet returned no accounts");

  const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
  return { address: address.toLowerCase() as `0x${string}`, chainId: Number.parseInt(chainIdHex, 16) };
}

export interface SendableCall {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  /**
   * The chain the call was checked for. Given, the wallet is asked which chain
   * it is on at the moment it is asked to send, and a wallet on another is
   * refused before it signs; the id also goes with the transaction, so a
   * wallet that checks it refuses a switch made in the instant between.
   * The chain check before the safety check is seconds older than the
   * signature — reads, a nonce search, a simulation — and a wallet switched
   * in those seconds would otherwise sign for whatever network it is on by
   * then, where the addresses checked may hold no code and ether sent to
   * them is lost.
   */
  chainId?: number;
  /**
   * The least gas limit to sign with, when an estimate is known to run short:
   * the estimate describes the state when it was taken, and some calls take a
   * dearer path in the block they land in (a vault's buy after a trade on its
   * pool). The limit is the larger of this and the estimate with headroom.
   */
  gasFloor?: bigint;
  /**
   * The exact gas limit to sign with. No estimate is taken.
   *
   * For a call whose behaviour depends on its gas: the vault batcher reads
   * `gasleft()` before each vault and skips those it can't afford, so an
   * estimate settles on the least gas at which *some* vault buys, and the
   * Guard simulated the call at this limit and no other. A call carries
   * either this or `gasFloor`, never both.
   */
  gas?: bigint;
  /**
   * The exact legacy gas price to sign with, in wei. No price is read at
   * signing time: a caller that worked out whether a transaction pays for
   * itself did so at one price, and the one signed must be that one. Help run
   * the network reads it with `privateGasPrice` (lib/submit.ts).
   */
  gasPrice?: bigint;
}

/**
 * Send a transaction and wait for it to actually succeed.
 *
 * Returning as soon as the wallet hands back a hash is the obvious
 * implementation and it is wrong: a transaction that reverts on chain still
 * produces a hash, so the app would report "Swap complete" for a swap that did
 * nothing. An e2e test caught exactly that — it passed against a fork that
 * happened to be funded, and reported success against one that was not.
 *
 * Confirmation is deliberately part of sending rather than an optional extra,
 * so no call site can forget it.
 */
export async function sendTransaction(from: `0x${string}`, call: SendableCall): Promise<string> {
  const provider = detectProvider();
  if (!provider) throw new Error("no EIP-1193 wallet available");

  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: call.to,
        data: call.data,
        value: `0x${call.value.toString(16)}`,
      },
    ],
  })) as string;

  // The hash that was mined: a wallet's "Speed up" replaces it.
  return confirmTransaction(hash);
}

interface Receipt {
  status?: string;
}

/** A read-only JSON-RPC call, as `@spdex/chain`'s `httpRpc` returns. */
export type ReadRpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface ConfirmOptions {
  /**
   * Where to look for the receipt. Defaults to the wallet.
   *
   * Private submission needs this. A transaction posted to Flashbots never
   * enters the public mempool, so the wallet's own node has no knowledge of it
   * until it is mined — and some wallets answer `eth_getTransactionReceipt`
   * from a cache that never learns about it at all. Polling the endpoint the
   * user configured is both more likely to see it and the one they chose to
   * trust with their reads anyway.
   */
  rpc?: ReadRpc;
  /** How long to wait before giving up. */
  timeoutMs?: number;
  /**
   * Told when the wallet replaced the transaction with a faster copy of the
   * same call ("Speed up"), with the copy's hash: the one that is confirmed,
   * returned and recorded from then on.
   */
  onReplaced?: (replacement: `0x${string}`) => void;
  /** Milliseconds between receipt reads; for tests. */
  pollMs?: number;
  /** Milliseconds between looks for a replacement; for tests. */
  replacementCheckMs?: number;
}

/**
 * The wallet replaced the transaction with a different one at the same
 * nonce: "Cancel" in MetaMask, or another app's send. The original can never
 * be mined now, so nothing it would have done happened. Only the
 * replacement's network fee was spent.
 */
export class TransactionReplaced extends Error {
  constructor(
    readonly original: string,
    readonly replacement: string,
  ) {
    super(
      `transaction ${original.slice(0, 10)}… was replaced in your wallet by ${replacement.slice(0, 10)}…, which doesn't make it; ` +
        "nothing it would have done happened",
    );
    this.name = "TransactionReplaced";
  }
}

/**
 * Wait for a transaction to be mined and check it did not revert, and return
 * the hash that was mined: the one given, or the faster copy a wallet's
 * "Speed up" replaced it with (see `waitForSuccess`).
 *
 * Exported separately because private submission sends through a relay rather
 * than the wallet, but still has to be confirmed — and a confirmation step that
 * only some paths perform is a confirmation step that will eventually be
 * skipped.
 */
export async function confirmTransaction(hash: string, options: ConfirmOptions = {}): Promise<string> {
  const read: ReadRpc =
    options.rpc ??
    ((method, params) => {
      const provider = detectProvider();
      if (!provider) throw new Error("no EIP-1193 wallet available");
      return provider.request({ method, params });
    });

  return waitForSuccess(read, hash, options.timeoutMs ?? PUBLIC_CONFIRM_TIMEOUT_MS, options);
}

/**
 * A public broadcast that has not been mined in two minutes is stuck, and
 * saying so is more useful than waiting.
 */
export const PUBLIC_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Private submission gets five.
 *
 * A relay does not publish to the mempool; it offers the bundle to builders
 * block by block, and a transaction that misses several blocks in a row is
 * ordinary rather than broken. Sharing the public timeout would report healthy
 * private swaps as failures, which is the worst possible advertisement for the
 * feature — the user concludes privacy does not work and turns it off.
 */
export const PRIVATE_CONFIRM_TIMEOUT_MS = 300_000;

/** What a pending transaction is, as far as its replacement is concerned. */
interface Sent {
  from: string;
  nonce: bigint;
  to: string | null;
  input: string;
  value: bigint;
  /** A block at or before the one any replacement can be in. */
  since: bigint;
}

const sameCall = (a: Pick<Sent, "to" | "input" | "value">, b: Pick<Sent, "to" | "input" | "value">) =>
  (a.to ?? "").toLowerCase() === (b.to ?? "").toLowerCase() && a.input.toLowerCase() === b.input.toLowerCase() && a.value === b.value;

/** The mined transaction from `sent.from` at `sent.nonce`, looked for in the blocks since `sent.since`; null if not found. */
async function minedAtNonce(read: ReadRpc, sent: Sent): Promise<(Pick<Sent, "to" | "input" | "value"> & { hash: string }) | null> {
  const head = BigInt((await read("eth_blockNumber", [])) as string);
  // Newest first: a replacement is usually in the last block or two.
  for (let n = head; n >= sent.since && head - n < 64n; n--) {
    const block = (await read("eth_getBlockByNumber", [`0x${n.toString(16)}`, true])) as {
      transactions?: { hash: string; from: string; nonce: string; to: string | null; input: string; value: string }[];
    } | null;
    const tx = block?.transactions?.find((t) => t.from.toLowerCase() === sent.from.toLowerCase() && BigInt(t.nonce) === sent.nonce);
    if (tx) return { hash: tx.hash, to: tx.to, input: tx.input, value: BigInt(tx.value) };
  }
  return null;
}

/**
 * Poll for the receipt; and, every few seconds, look for a replacement.
 *
 * A wallet's "Speed up" sends the same call again at the same nonce with a
 * higher fee, under a new hash, and the first can then never be mined: a page
 * that waited only for the first would say "not mined" about a swap that went
 * through. So once the endpoint has shown the transaction (its sender and
 * nonce), a nonce of the sender's used by something else is looked up in the
 * blocks since: the same call is followed and its hash returned; anything
 * else (MetaMask's "Cancel") is `TransactionReplaced`. An endpoint that never
 * shows the transaction (a private one, before it is mined) leaves only the
 * receipt to wait for, as before.
 */
async function waitForSuccess(read: ReadRpc, original: string, timeoutMs: number, options: ConfirmOptions): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = options.pollMs ?? 250;
  const checkMs = options.replacementCheckMs ?? 3_000;
  let hash = original;
  let sent: Sent | null = null;
  let nextCheck = Date.now() + checkMs;

  while (Date.now() < deadline) {
    const receipt = (await read("eth_getTransactionReceipt", [hash])) as Receipt | null;

    if (receipt) {
      // status "0x0" is a revert. The transaction was mined and the gas was
      // spent, but nothing the user wanted happened.
      if (receipt.status !== undefined && BigInt(receipt.status) === 0n) {
        throw new Error(`transaction ${hash.slice(0, 10)}… reverted on chain`);
      }
      return hash;
    }

    if (hash === original && Date.now() >= nextCheck) {
      nextCheck = Date.now() + checkMs;
      try {
        if (sent === null) {
          const tx = (await read("eth_getTransactionByHash", [hash])) as {
            from: string;
            nonce: string;
            to: string | null;
            input: string;
            value: string;
          } | null;
          if (tx) {
            const head = BigInt((await read("eth_blockNumber", [])) as string);
            sent = { from: tx.from, nonce: BigInt(tx.nonce), to: tx.to, input: tx.input, value: BigInt(tx.value), since: head > 0n ? head - 1n : 0n };
          }
        } else {
          const used = BigInt((await read("eth_getTransactionCount", [sent.from, "latest"])) as string);
          if (used > sent.nonce) {
            // The nonce is spent. The receipt read above may simply have been
            // a moment early, so the original's own is asked once more first.
            const own = (await read("eth_getTransactionReceipt", [hash])) as Receipt | null;
            if (own === null) {
              const mined = await minedAtNonce(read, sent);
              if (mined !== null && mined.hash.toLowerCase() !== original.toLowerCase()) {
                if (!sameCall(mined, sent)) throw new TransactionReplaced(original, mined.hash);
                hash = mined.hash;
                options.onReplaced?.(mined.hash as `0x${string}`);
              }
            }
            continue;
          }
        }
      } catch (error) {
        if (error instanceof TransactionReplaced) throw error;
        // A failed look is no news: the receipt is still waited for.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  // Worded as "not yet", because it is. The transaction is signed, broadcast
  // and still perfectly capable of landing; spDEX has merely stopped watching.
  // Calling this a failure would invite the user to retry and send it twice.
  throw new Error(
    `transaction ${hash.slice(0, 10)}… has not been mined after ${Math.round(timeoutMs / 1000)}s. ` +
      `It may still land — check the hash before sending it again.`,
  );
}

/**
 * Offer the wallet a network it does not have, then switch to it.
 *
 * Adding a network by hand is where people get stuck: a chain id that collides
 * with an entry in the public registry makes wallets warn about the mismatch,
 * and some refuse to save it at all. Handing over the parameters programmatically
 * avoids the typing and the guesswork.
 *
 * Returns false if the user declines, which is an ordinary answer rather than
 * an error.
 */
export async function addAndSwitchChain(options: {
  chainId: number;
  rpcUrl: string;
  chainName: string;
}): Promise<boolean> {
  const provider = detectProvider();
  if (!provider) throw new Error("no EIP-1193 wallet available");
  const chainIdHex = `0x${options.chainId.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: options.chainName,
          rpcUrls: [options.rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    return true;
  } catch (error) {
    if (isUserRejection(error)) return false;
    throw error;
  }
}

/**
 * Ask the wallet to switch to a network it already knows (Ethereum, say),
 * which spDEX may not redefine (`addAndSwitchChain` is for the others).
 * Returns false if the person declines, which is an ordinary answer.
 */
export async function switchChain(chainId: number): Promise<boolean> {
  const provider = detectProvider();
  if (!provider) throw new Error("no EIP-1193 wallet available");
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
    return true;
  } catch (error) {
    if (isUserRejection(error)) return false;
    throw error;
  }
}

/** True when the user declined in their wallet, which is not an error to report as a failure. */
export function isUserRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 4001;
}
