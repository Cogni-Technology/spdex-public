/**
 * Building the tip transfers, host-side.
 *
 * No module composes these. A venue proposes a swap and the Guard checks it
 * because a venue is untrusted; a tip is not proposed by anyone — the user
 * named the recipients, the host does the arithmetic, and the Guard checks the
 * result anyway. The registry module's only role was answering "which address
 * does this name point at", and by the time execution happens that answer is a
 * plain address sitting in the user's config.
 *
 * Two shapes, built from one intent: a transfer per recipient, or (for two or
 * more) one Permit2 batch the user signs and then sends. The bytes of both
 * come from `@spdex/core`, the same functions the Guard re-encodes with.
 */

import {
  cleanTipText,
  encodePermit2Approval,
  encodePermit2BatchTransfer,
  encodeTipTransfer,
  permit2Nonce,
  PERMIT2_ADDRESS,
  PERMIT2_TIP_DEADLINE_SECONDS,
  type Address,
  type Permit2BatchPermit,
  type Permit2PermissionKind,
  type TipIntent,
  type TipPermissionPlan,
  type TipPlan,
  type TipPolicy,
  type TipTransfer,
} from "@spdex/core";

/** Host-generated, as for a swap: modules have no randomness and must not pick. */
function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Work out what each recipient gets from what the swap actually delivered.
 *
 * `tips` is what `tippableRecipients` let through (lib/tiplist/checks.ts,
 * `payablePolicy`), never `config.tips` itself: a recipient it skipped — not
 * confirmed, retired, a public test account — gets no transfer, and its share
 * stays with the user rather than going to the others.
 *
 * Rounding is down, per recipient, by integer division. The remainder stays
 * with the user, which is the only defensible direction: the alternative
 * distributes dust the user never agreed to part with, and "it was only a
 * rounding error" is not a sentence this project wants to be making about
 * somebody else's money.
 *
 * A recipient whose share rounds to zero is dropped rather than sent an empty
 * transfer — paying gas to move nothing helps nobody.
 */
export function tipTransfersFor(tips: TipPolicy, delivered: bigint): TipTransfer[] {
  if (!tips.enabled || delivered <= 0n) return [];

  const transfers: TipTransfer[] = [];
  for (const recipient of tips.recipients) {
    const amount = (delivered * BigInt(recipient.bps)) / 10_000n;
    if (amount <= 0n) continue;
    // The label only names the payment in the status line; cleaned of
    // anything invisible or reordering, as every tip name is when shown.
    transfers.push({ recipient: recipient.address, amount, label: cleanTipText(recipient.label) });
  }
  return transfers;
}

/**
 * Assemble the plan the Guard will judge.
 *
 * Calls are encoded through `encodeTipTransfer` from core — the same function
 * the Guard re-encodes with when it compares calldata. Keeping one encoder
 * means the check cannot end up verifying a second implementation of the same
 * mistake.
 */
export function buildTipPlan(options: {
  chainId: number;
  account: Address;
  token: Address;
  delivered: bigint;
  transfers: TipTransfer[];
}): TipPlan {
  return transferPlanFor(buildTipIntent(options));
}

/** The promise every shape of a tip is judged against. */
export function buildTipIntent(options: {
  chainId: number;
  account: Address;
  token: Address;
  delivered: bigint;
  transfers: TipTransfer[];
}): TipIntent {
  return {
    version: 1,
    chainId: options.chainId,
    account: options.account,
    token: options.token,
    deliveredAmount: options.delivered,
    transfers: options.transfers,
    nonce: randomNonce(),
  };
}

/** One ERC-20 transfer per recipient, as every tip was before batching. */
export function transferPlanFor(intent: TipIntent): TipPlan {
  return {
    version: 1,
    intent,
    calls: intent.transfers.map((transfer) => ({
      to: intent.token,
      data: encodeTipTransfer(transfer.recipient, transfer.amount),
      value: 0n,
    })),
  };
}

/**
 * The one transaction that pays everyone: Permit2's `permitTransferFrom`,
 * carrying the signature the user gave over the same intent.
 */
export function buildBatchTipPlan(intent: TipIntent, permit: Permit2BatchPermit): TipPlan {
  return {
    version: 1,
    intent,
    mode: "permit2-batch",
    permit,
    calls: [{ to: PERMIT2_ADDRESS, data: encodePermit2BatchTransfer(intent, permit), value: 0n }],
  };
}

/**
 * The standing permission (`grant`, for `tip`) or taking it back (`revoke`,
 * from Expert → Tips). The spender is Permit2 and nothing else: the encoder
 * takes no spender to get wrong.
 */
export function buildPermit2Permission(
  kind: Permit2PermissionKind,
  options: { chainId: number; account: Address; token: Address; tip?: TipIntent },
): TipPermissionPlan {
  return {
    version: 1,
    kind,
    chainId: options.chainId,
    account: options.account,
    token: options.token,
    ...(options.tip === undefined ? {} : { tip: options.tip }),
    call: { to: options.token, data: encodePermit2Approval(kind), value: 0n },
  };
}

/**
 * A permit's deadline: twenty minutes from now by the page's clock, in unix
 * seconds. Permit2 compares it with the block's time; see
 * `PERMIT2_TIP_DEADLINE_SECONDS` for why the page's clock is good enough.
 */
export function tipDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + PERMIT2_TIP_DEADLINE_SECONDS);
}

/** Random bytes from the platform's CSPRNG, as the plan nonce above uses. */
function cryptoBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Pick a Permit2 nonce the account has not used.
 *
 * Permit2's nonces are unordered: any unused bit in any word of the owner's
 * bitmap will do, and each can be used once. A random word (248 bits) and bit
 * makes a clash with a nonce some other app used vanishingly unlikely, and
 * reading the word first makes it impossible rather than unlikely, at the
 * cost of one read. A used bit is picked again; after a few tries this gives
 * up rather than loop, which only a broken endpoint (every bit reading set)
 * could cause.
 *
 * Throws when the bitmap cannot be read: an unread word is not an empty one.
 */
export async function choosePermit2Nonce(
  readBitmap: (word: bigint) => Promise<bigint>,
  random: (length: number) => Uint8Array = cryptoBytes,
): Promise<bigint> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = random(32);
    const word = BigInt(`0x${[...bytes.slice(0, 31)].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
    const bit = bytes[31]!;
    const bitmap = await readBitmap(word);
    if ((bitmap & (1n << BigInt(bit))) === 0n) return permit2Nonce(word, bit);
  }
  throw new Error("every Permit2 nonce spDEX picked reads as used; the endpoint's answers look wrong");
}

/** Total about to be tipped, for display before signing. */
export function totalTipped(transfers: readonly TipTransfer[]): bigint {
  return transfers.reduce((sum, transfer) => sum + transfer.amount, 0n);
}
