/**
 * The one path from a checked quote to the chain.
 *
 * A manual swap and a scheduled buy differ in who presses the button — the
 * user at the swap card, or the user confirming a due buy — and in nothing
 * else that matters here. So both come through this function with a
 * `TxSender`, and the rules below are written once:
 *
 * - **Executed exactly as checked.** Every leg must carry a signable verdict,
 *   and every call of every leg is sent, in order. The old swap loop sent
 *   `calls[0]` only, which is correct for today's venues and silently wrong
 *   for the first one that needs two calls: the Guard would have simulated
 *   both and the chain would have seen one.
 * - **Checked for the account that sends.** A verdict is a statement about one
 *   account's balances. A quote simulated for one address and sent from
 *   another executes something nobody checked, so that is refused before
 *   anything is signed.
 * - **Exact permissions, only when short.** An approval is sent only when the
 *   current allowance is below what the leg needs, and for exactly that amount
 *   (the Guard refuses more — `APPROVAL_EXCEEDS_INTENT`).
 * - **Confirmed before moving on.** Each transaction is waited for, and a
 *   revert stops the sequence: a swap after a failed approval would only
 *   revert too, and pay for it.
 * - **Partial is reported, not hidden.** A split route is several
 *   transactions. When one fails after others succeeded, money has moved; the
 *   error says how many legs completed and every hash that was sent, so the
 *   caller can tell "nothing happened" from "some of it happened".
 *
 * Nothing here knows about tips, schedules or the ledger. Those are the
 * callers' business, before and after.
 */

import type { QuoteResult } from "./engine.js";
import { allowance, encodeApprove } from "./erc20.js";
import { confirmTransaction, type ConfirmOptions, type ReadRpc, type SendableCall } from "./wallet.js";

/**
 * How a transaction actually went out — never how it was configured to go
 * out. "endpoint" is only ever read back, from a record an autopilot plan's
 * spending wallet left before config version 8.
 */
export type SentVia = "wallet" | "private" | "endpoint";

/**
 * Something that can get one call to the chain for one account: the user's
 * wallet (senders.ts `walletSender`). `kind` is kept, and has one value, so
 * that anything which ever signs otherwise has to say so here first — until
 * config version 8 an autopilot plan's spending wallet did.
 */
export interface TxSender {
  readonly account: `0x${string}`;
  readonly kind: "wallet";
  send(call: SendableCall): Promise<{ hash: `0x${string}`; via: SentVia }>;
  /** Always carries `rpc`: receipts are read from the user's endpoint, never the wallet's. */
  readonly confirm: ConfirmOptions;
}

/**
 * What is about to happen, for a status line.
 *
 * `leg` is 1-based, as people count: "leg 1 of 2". `approve` fires only when an
 * approval is actually going to be sent; `swap` fires once per leg, before its
 * first call.
 */
export type ExecuteStep = { kind: "approve" | "swap"; leg: number; legs: number; label: string };

export interface ExecuteResult {
  /** How the last swap call went out; null if none was sent. */
  via: SentVia | null;
  /** Every transaction sent, approvals included, in order. */
  hashes: `0x${string}`[];
  legsDone: number;
}

export interface ExecuteHooks {
  onStep?(step: ExecuteStep): void;
  /**
   * Each hash as soon as it exists, before its confirmation is awaited. The
   * scheduler persists it here, so a tab that dies mid-buy comes back knowing
   * which transaction to look for.
   */
  onSent?(hash: `0x${string}`, kind: ExecuteStep["kind"], via: SentVia): void | Promise<void>;
  /**
   * The wallet replaced a sent transaction with a faster copy of the same
   * call ("Speed up"): the copy's hash, which is the one confirmed, returned
   * in `hashes` and recorded from then on.
   */
  onReplaced?(hash: `0x${string}`, kind: ExecuteStep["kind"], original: `0x${string}`): void | Promise<void>;
}

/**
 * Execution stopped part-way, or before it started.
 *
 * The message is the underlying error's message unchanged, so a status line
 * that printed the error before still prints the same words; `cause` is that
 * error, for callers that branch on its type (a wallet rejection, private
 * submission being impossible).
 */
export class ExecutionError extends Error {
  constructor(
    override readonly cause: unknown,
    /** Legs whose every call confirmed. More than zero means money moved. */
    readonly legsDone: number,
    /** Every hash sent before it stopped, in order. */
    readonly hashes: `0x${string}`[],
    /**
     * How far this step got. `check`: refused or failed before the sender was
     * asked for anything, so nothing of this step left. `send`: the sender
     * threw — which, for a wallet, may be after it broadcast. `confirm`: sent,
     * and then not confirmed.
     */
    readonly stage: "check" | "send" | "confirm",
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ExecutionError";
  }
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Execute a checked quote, leg by leg.
 *
 * Everything that can be refused without the chain is refused before the first
 * transaction, so an unsignable leg two of three can never leave leg one
 * executed on its own.
 */
export async function executeQuote(
  quote: QuoteResult,
  sender: TxSender,
  reads: ReadRpc,
  hooks: ExecuteHooks = {},
): Promise<ExecuteResult> {
  const hashes: `0x${string}`[] = [];
  let legsDone = 0;
  let via: SentVia | null = null;
  const legs = quote.legs.length;

  const refuse = (message: string) => new ExecutionError(new Error(message), 0, [], "check");

  if (legs === 0) throw refuse("this quote has no legs to execute");
  if (!quote.verdict.signable) throw refuse("spDEX refused this plan; there is nothing to sign");
  for (const [index, leg] of quote.legs.entries()) {
    if (!leg.verdict.signable) throw refuse(`leg ${index + 1} of ${legs} was refused by the Guard`);
    if (!sameAddress(leg.plan.intent.account, sender.account)) {
      throw refuse(
        `leg ${index + 1} of ${legs} was checked for ${leg.plan.intent.account}, not for ${sender.account}; quote again`,
      );
    }
    if (leg.plan.calls.length === 0) throw refuse(`leg ${index + 1} of ${legs} has no call to execute`);
  }

  // One transaction: send, report, confirm. Split so the error can say which
  // of the two failed — "the wallet said no" and "it was sent and then
  // reverted or never showed up" mean very different things to a caller that
  // keeps a ledger.
  const run = async (call: SendableCall, kind: ExecuteStep["kind"]): Promise<SentVia> => {
    let sent: { hash: `0x${string}`; via: SentVia };
    try {
      sent = await sender.send(call);
    } catch (error) {
      throw new ExecutionError(error, legsDone, [...hashes], "send");
    }
    hashes.push(sent.hash);
    const at = hashes.length - 1;
    try {
      await hooks.onSent?.(sent.hash, kind, sent.via);
      const mined = (await confirmTransaction(sent.hash, {
        ...sender.confirm,
        onReplaced: (copy) => {
          hashes[at] = copy;
          void hooks.onReplaced?.(copy, kind, sent.hash);
        },
      })) as `0x${string}`;
      hashes[at] = mined;
    } catch (error) {
      throw new ExecutionError(error, legsDone, [...hashes], "confirm");
    }
    return sent.via;
  };

  for (const [index, leg] of quote.legs.entries()) {
    const label = leg.label ?? leg.poolId.slice(0, 10);
    const step = { leg: index + 1, legs, label };

    for (const approval of leg.plan.approvals) {
      let current: bigint;
      try {
        current = await allowance(reads, approval.token, sender.account, approval.spender);
      } catch (error) {
        // A read, before this step's transaction was asked for: nothing of
        // this step left, which is what "check" says (earlier steps' hashes
        // are still carried).
        throw new ExecutionError(error, legsDone, [...hashes], "check");
      }
      if (current < approval.amount) {
        hooks.onStep?.({ kind: "approve", ...step });
        await run(
          { to: approval.token, data: encodeApprove(approval.spender, approval.amount), value: 0n },
          "approve",
        );
      }
    }

    hooks.onStep?.({ kind: "swap", ...step });
    for (const call of leg.plan.calls) via = await run(call, "swap");
    legsDone += 1;
  }

  return { via, hashes, legsDone };
}

/**
 * "The owner's wallet is busy": one prompt at a time.
 *
 * A manual swap and a scheduled wallet-mode buy both ask the same wallet to
 * sign, and two sequences interleaving would mean prompts the user cannot tell
 * apart — and a delivered-amount measurement that counted the other one's
 * output. Whichever starts first holds this; the other waits or says so.
 *
 * In-tab only, and deliberately tiny. Other tabs do not run wallet-mode buys
 * (only the tab holding the auto-buy leader lock does).
 */
export class OwnerWalletLock {
  #busy = false;
  readonly #listeners = new Set<() => void>();

  /** True if it was free and is now held by the caller. */
  tryAcquire(): boolean {
    if (this.#busy) return false;
    this.#busy = true;
    this.#notify();
    return true;
  }

  release(): void {
    if (!this.#busy) return;
    this.#busy = false;
    this.#notify();
  }

  isBusy(): boolean {
    return this.#busy;
  }

  /** Called on every acquire and release. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
