/**
 * Getting a call signed and sent by the user's wallet, behind the interface
 * the rest of the app executes through (`TxSender`).
 *
 * **walletSender** asks the user's wallet, exactly as the swap button always
 * has: `submit()`, with its refusal to broadcast publicly after privacy was
 * asked for unless the caller's `onPublicFallback` says yes. A scheduled buy
 * passes one that always says no — the fallback prompt is for a person at a
 * swap button, not for anything that runs on a timer.
 *
 * It is the only sender the app has. Until config version 8 there was a
 * second, which signed locally with an autopilot plan's spending wallet; no
 * release ever made one, and nothing signs with one any more.
 */

import type { SubmitterConfig } from "@spdex/core";
import type { TxSender } from "./execute.js";
import { submit } from "./submit.js";
import {
  PRIVATE_CONFIRM_TIMEOUT_MS,
  PUBLIC_CONFIRM_TIMEOUT_MS,
  type Eip1193Provider,
  type ReadRpc,
  type SendableCall,
} from "./wallet.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function confirmFor(submitter: SubmitterConfig, reads: ReadRpc) {
  // A relay offers a transaction to builders block by block rather than
  // publishing it, so it gets the longer wait — see PRIVATE_CONFIRM_TIMEOUT_MS.
  return {
    rpc: reads,
    timeoutMs: submitter.mode === "private" ? PRIVATE_CONFIRM_TIMEOUT_MS : PUBLIC_CONFIRM_TIMEOUT_MS,
  };
}

export interface WalletSenderOptions {
  submitter: SubmitterConfig;
  account: `0x${string}`;
  /**
   * Consent to broadcast publicly after private submission proved impossible.
   * Required rather than defaulted, as it is on `submit()`: forgetting it must
   * not be a way to get a public broadcast. A scheduled buy passes
   * `() => false`.
   */
  onPublicFallback: (reason: string) => Promise<boolean> | boolean;
  /** The user's endpoint: gas estimates, nonces and receipts are read here, not from the wallet. */
  reads: ReadRpc;
  /**
   * Unix seconds. With private submission, a signature the wallet returns
   * after this is not posted (`LateSignature`): the swap could only revert.
   * A scheduled buy passes its quote's deadline, less a margin; a public
   * broadcast is the wallet's own and cannot be stopped, so it is unaffected.
   */
  notAfter?: number;
  /**
   * With private submission: the hash of what the wallet signed, computed
   * from the bytes and handed over before they are posted (see
   * `PrivateSubmitOptions.onSigned`). A scheduled buy records it here, so an
   * answer lost on the way back from the relay leaves a transaction to look
   * for, not a buy that seems never to have been sent. A public broadcast is
   * the wallet's own; its hash only exists once the wallet has sent it.
   */
  onSigned?: (hash: `0x${string}`) => void | Promise<void>;
  /** For tests; the page's wallet otherwise. */
  provider?: Eip1193Provider;
  /** Milliseconds since the epoch, for `notAfter`; for tests, the wall clock otherwise. */
  now?: () => number;
}

/** The user's wallet, through `submit()`. */
export function walletSender(options: WalletSenderOptions): TxSender {
  const account = options.account.toLowerCase() as `0x${string}`;
  return {
    account,
    kind: "wallet",
    confirm: confirmFor(options.submitter, options.reads),
    async send(call) {
      const result = await submit(
        options.submitter,
        account,
        call,
        options.onPublicFallback,
        options.provider,
        options.reads,
        options.notAfter === undefined && options.onSigned === undefined
          ? undefined
          : {
              ...(options.notAfter === undefined ? {} : { notAfter: options.notAfter }),
              ...(options.onSigned === undefined ? {} : { onSigned: options.onSigned }),
              ...(options.now === undefined ? {} : { now: options.now }),
            },
      );
      if (typeof result.hash !== "string" || !HASH_RE.test(result.hash)) {
        throw new Error("the wallet reported the transaction as sent but returned no transaction hash");
      }
      return { hash: result.hash.toLowerCase() as `0x${string}`, via: result.via };
    },
  };
}
