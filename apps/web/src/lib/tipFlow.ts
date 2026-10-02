/**
 * Sending a swap's tips, after the swap settled: the order of the steps, and
 * what each refusal or failure turns into.
 *
 * One recipient is one ERC-20 transfer, as it always was. Two or more are
 * batched through Permit2 (see "Batching" in `@spdex/core` tips.ts):
 *
 *   1. Is Permit2 on this chain the contract spDEX knows? If not, or if that
 *      can't be told, the tips go as separate transfers. So do they when a
 *      batch already failed for this wallet earlier in the session.
 *   2. Does Permit2 already have the standing permission on this token? Only
 *      read here. When it hasn't, the permission is built as a plan of its own
 *      and the Guard checks and test-runs it now (never on the static checks
 *      alone: it is unlimited), before anything is asked of the wallet. A
 *      refusal sends the tips as separate transfers, and no signature is
 *      asked for that nothing could use.
 *   3. Pick an unused Permit2 nonce and a deadline twenty minutes out.
 *   4. The Guard checks the exact typed data the wallet is about to be handed.
 *   5. `eth_signTypedData_v4`. A wallet that can't sign typed data gets
 *      separate transfers instead; a person who declines gets no tips.
 *   6. The standing permission, when step 2 found it short: the wallet asks.
 *      Declined, the tips for this swap go as separate transfers, and the
 *      note says why, and that the signature just given goes unused.
 *   7. Build the one call, and the Guard checks it, simulated. A batch that
 *      would only revert (an account whose own code answers for its
 *      signatures, say) gets separate transfers instead, and so does one
 *      whose signature expired while the permission was confirmed; any other
 *      refusal stands.
 *   8. Send it through the ordinary submitter (private sending included: it
 *      is the user's own transaction) and wait for it to succeed.
 *
 * The signature comes before the permission. It costs no fee, it does not
 * depend on the allowance, and it shows whether the wallet can sign typed
 * data at all before any standing permission is asked for, so a wallet that
 * can't is never asked for a permission it could not use. A permission
 * nothing used can still be left behind, but only after a signature: when
 * the batch then reverts for the account, the Guard refuses it, or the person
 * declines it. The note says so, with where to revoke it. The other way
 * round costs little: a signature that a declined permission leaves unused
 * moves nothing by itself, only a transaction the user sends could spend it,
 * and it expires within twenty minutes. The note says that too.
 *
 * A wallet that can't sign, or an account the batch reverts for, is
 * remembered: the outcome says the batch is unusable for this wallet, so the
 * page sends transfers for the rest of the session instead of asking for the
 * same failure again.
 *
 * Every wallet prompt is numbered, continuing the swap's own count: the
 * counter was sized before the swap from what the page knew, and is settled
 * here each time the number of prompts left becomes known.
 *
 * Deliberately never throws. The swap has already happened by the time this
 * runs, and an exception here used to reach the swap's own error handling,
 * which reported a completed swap as cancelled or failed. Every outcome is a
 * sentence appended to "Swap complete".
 *
 * Nothing here talks to the network or the wallet directly: every read, check,
 * signature and send is a dependency, so the order and the fallbacks are
 * tested without a chain (tipFlow.test.ts) and exercised with one in e2e.
 */

import {
  permit2BatchTypedDataJson,
  PERMIT2_TIP_DEADLINE_SECONDS,
  type Address,
  type GuardVerdict,
  type Hex,
  type TipIntent,
  type TipPermissionPlan,
  type TipPlan,
  type TipSignatureRequest,
  type TipTransfer,
} from "@spdex/core";
import { StepCounter, type Step } from "./steps.js";
import { formatAmount, formatAmountExact } from "./tokens.js";
import {
  buildBatchTipPlan,
  buildPermit2Permission,
  buildTipIntent,
  choosePermit2Nonce,
  tipDeadline,
  totalTipped,
  transferPlanFor,
} from "./tips.js";
import { isUserRejection } from "./wallet.js";
import { PLACES } from "./places.js";

/** What the flow needs from the Engine: the Guard's three tip checks, and the Permit2 question. */
export interface TipChecks {
  checkTips(plan: TipPlan): Promise<GuardVerdict>;
  checkTipSignature(request: TipSignatureRequest): Promise<GuardVerdict>;
  checkTipPermission(plan: TipPermissionPlan): Promise<GuardVerdict>;
  permit2Available(): Promise<boolean | "unknown">;
}

export interface TipCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface TipFlowDeps {
  checks: TipChecks;
  chainId: number;
  account: Address;
  token: { address: Address; symbol: string; decimals: number };
  /** What the swap delivered, measured; the transfers are shares of it. */
  delivered: bigint;
  transfers: TipTransfer[];
  /** Permit2's allowance from the account on the token. Throws when it can't be read. */
  readAllowance: () => Promise<bigint>;
  /** One word of the account's Permit2 nonce bitmap. Throws when it can't be read. */
  readNonceBitmap: (word: bigint) => Promise<bigint>;
  /** `eth_signTypedData_v4` for the account, with exactly this string. */
  signTypedData: (typedData: string) => Promise<unknown>;
  /**
   * Send one call and wait until it has succeeded on chain; throws otherwise.
   * Resolves to the transaction's hash when the sender knows it, which is
   * what lets the tips be kept in this browser's record (`TipOutcome.sent`);
   * a sender that resolves to nothing still tips, unrecorded.
   */
  send: (call: TipCall) => Promise<Hex | void>;
  onStep: (step: Step) => void;
  /**
   * Numbers each wallet prompt, continuing the swap's count ("step 3 of 5").
   * A fresh one when absent.
   */
  counter?: StepCounter;
  /**
   * Why a batch is known not to work for this wallet, found earlier in the
   * session (`TipOutcome.batchUnusable`), or null. Then two or more tips go
   * straight to separate transfers, and the note says why.
   */
  batchUnusable?: string | null;
  /** Milliseconds since the epoch; the page's clock by default. */
  now?: () => number;
  /** Random bytes for the nonce; the platform's CSPRNG by default. */
  random?: (length: number) => Uint8Array;
}

/** How the tips went: the sentence for the status line, and the shape they went in. */
export interface TipOutcome {
  note: string;
  mode: "none" | "transfers" | "permit2-batch";
  /**
   * Set when this run found that a batch can't work for this wallet (it
   * can't sign typed data, or the batch reverts for its account): a clause
   * for the next swap's note, which the page keeps for the session.
   */
  batchUnusable?: string;
  /**
   * Each tip transaction that succeeded, in the order sent, for this
   * browser's record (Your activity). Absent when none did, or when the
   * sender gave no hashes.
   */
  sent?: TipSent[];
}

/** One tip transaction that succeeded: a transfer to one person, or one Permit2 batch paying several. */
export interface TipSent {
  token: Address;
  /**
   * Its transactions in the order sent: the standing permission for Permit2
   * when this run gave it for this batch, then the tip itself. The
   * permission is a cost of tipping, so its fee is counted with the tip's.
   */
  hashes: Hex[];
  /** What it paid, in the token's base units: one transfer's amount, or a batch's total. */
  amount: bigint;
  /** How many people it paid. */
  recipients: number;
}

/** `outcome` with `sent` added, when there is anything to add. */
const withSent = (outcome: TipOutcome, sent: readonly TipSent[]): TipOutcome =>
  sent.length === 0 ? outcome : { ...outcome, sent: [...(outcome.sent ?? []), ...sent] };

/** A hash a sender resolved to, or null for anything else. */
const hashOf = (value: unknown): Hex | null =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value.toLowerCase() as Hex) : null;

const codesOf = (verdict: GuardVerdict) => verdict.violations.map((v) => v.code).join(", ");

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "1 person", "2 people". */
const peopleText = (count: number) => (count === 1 ? "1 person" : `${count} people`);

/**
 * Why the tips go one by one when the second opinion didn't answer about
 * the Permit2 permission: a standing permission is never granted on one
 * service's test-run alone (the Guard refuses it), so the batch waits for
 * both and the tips go as plain transfers, each checked on its own.
 */
export const SECOND_OPINION_PERMISSION_WAITS =
  "your second network service didn't answer, and a permission for Permit2 waits until both services agree";

/** Said after anything but a batch, when this run gave Permit2 the permission: it stays. */
const PERMISSION_STAYS = ` The Permit2 permission you gave stays until you revoke it in ${PLACES.tips.label}.`;

/**
 * Said when the permission after a signature was declined or failed. Only a
 * transaction from the signer can spend the permit (Permit2 hashes the
 * sender in as its spender), and it has a short deadline, so this is the
 * whole of what an unused one means.
 */
const SIGNATURE_UNUSED =
  ` The signature you gave goes unused and expires within ${PERMIT2_TIP_DEADLINE_SECONDS / 60} minutes; ` +
  "only a transaction you send could spend it.";

/** Said when the tips went out checked but not test-run. */
const UNTESTED = " spDEX checked the tips but couldn't test-run them: your network service can't.";

/**
 * A wallet refusing a method it doesn't have (EIP-1193's 4200, or JSON-RPC's
 * "method not found"), as opposed to failing at it.
 */
const isUnsupported = (error: unknown) =>
  typeof error === "object" && error !== null && [4200, -32601].includes((error as { code?: number }).code ?? 0);

/** A 64- or 65-byte signature as hex, or null for anything a wallet should not have returned. */
function asSignature(value: unknown): Hex | null {
  return typeof value === "string" && /^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

export async function sendTips(deps: TipFlowDeps): Promise<TipOutcome> {
  const { token } = deps;
  if (deps.transfers.length === 0) return { note: "", mode: "none" };
  const counter = deps.counter ?? new StepCounter(0);

  const intent = buildTipIntent({
    chainId: deps.chainId,
    account: deps.account,
    token: token.address,
    delivered: deps.delivered,
    transfers: deps.transfers,
  });
  const total = `${formatAmount(totalTipped(deps.transfers), token.decimals)} ${token.symbol}`;
  const people = deps.transfers.length;

  // One recipient is one transfer: nothing to batch, and no signature or
  // permission worth asking for.
  if (people === 1) return sendAsTransfers(deps, counter, intent, total, null);
  if (deps.batchUnusable) {
    return sendAsTransfers(deps, counter, intent, total, `${deps.batchUnusable} earlier in this session`);
  }

  // 1. Permit2 has to be the contract spDEX knows before anything rests on it.
  let available: boolean | "unknown";
  try {
    available = await deps.checks.permit2Available();
  } catch {
    available = "unknown";
  }
  if (available !== true) {
    return sendAsTransfers(
      deps,
      counter,
      intent,
      total,
      available === false
        ? "Permit2 on this network isn't the contract spDEX knows"
        : "spDEX couldn't confirm Permit2 on this network",
    );
  }

  // 2. Whether the standing permission will be needed, read now so the
  // count of prompts is known before the first one. An allowance that can't
  // be read counts as short, as the swap's own do: asking again costs a
  // prompt, assuming costs a revert.
  let allowance: bigint | null = null;
  try {
    allowance = await deps.readAllowance();
  } catch {
    allowance = null;
  }
  const permission =
    allowance === null || allowance < totalTipped(deps.transfers)
      ? buildPermit2Permission("grant", {
          chainId: deps.chainId,
          account: deps.account,
          token: token.address,
          tip: intent,
        })
      : null;

  // The permission is checked here, although the wallet is asked for it only
  // after the signature: a grant the Guard would refuse, or can't test-run,
  // means no batch, and a signature asked for before that was known would be
  // one nothing could use.
  if (permission !== null) {
    const verdict = await safely(() => deps.checks.checkTipPermission(permission));
    // Test-run or not asked for at all: the Guard refuses an untested grant
    // itself, and this says the same thing in the flow's own terms.
    if (verdict instanceof Error || verdict.level !== "verified") {
      const untestable =
        !(verdict instanceof Error) && verdict.violations.every((violation) => violation.code === "SIMULATION_UNAVAILABLE");
      // The second opinion didn't answer: a grant waits until both services
      // agree, and says so rather than naming a refusal code.
      const waitsForBoth =
        !(verdict instanceof Error) &&
        [...verdict.violations, ...verdict.warnings].some((item) => item.code === "SECOND_OPINION_UNAVAILABLE") &&
        verdict.violations.every((violation) => violation.code === "SECOND_OPINION_UNAVAILABLE");
      return sendAsTransfers(
        deps,
        counter,
        intent,
        total,
        verdict instanceof Error
          ? `spDEX couldn't check the permission for Permit2 (${reason(verdict)})`
          : waitsForBoth
            ? SECOND_OPINION_PERMISSION_WAITS
            : untestable
              ? "your network service can't test-run the permission for Permit2, and spDEX never asks for it untested"
              : `spDEX refused the permission for Permit2 (${codesOf(verdict)})`,
      );
    }
  }

  // 3. A nonce nobody has used, and a deadline close at hand.
  let nonce: bigint;
  try {
    nonce = await choosePermit2Nonce(deps.readNonceBitmap, deps.random);
  } catch (error) {
    return sendAsTransfers(deps, counter, intent, total, `spDEX couldn't read Permit2's nonce record (${reason(error)})`);
  }
  const deadline = tipDeadline(deps.now?.());
  const typedData = permit2BatchTypedDataJson(intent, nonce, deadline);

  // 4. The Guard sees the exact string the wallet will be handed.
  const signatureVerdict = await safely(() =>
    deps.checks.checkTipSignature({ version: 1, intent, signer: deps.account, typedData }),
  );
  if (signatureVerdict instanceof Error) {
    return { note: ` Tips not sent: spDEX couldn't check them (${reason(signatureVerdict)}).`, mode: "none" };
  }
  if (!signatureVerdict.signable) {
    return { note: ` Tips not sent — spDEX refused them: ${codesOf(signatureVerdict)}.`, mode: "none" };
  }

  // 5. The signature, described as the wallet will show it. Declining it is
  // an answer; a wallet unable to give one is not, and gets the transfers
  // instead, for the rest of the session too. Either way no permission has
  // been asked for yet, so none is left behind. The prompts from here: the
  // signature, the permission when it is needed, and the batch.
  counter.expectMore(permission === null ? 2 : 3);
  deps.onStep({
    kind: "tip-sign",
    symbol: token.symbol,
    amounts: deps.transfers.map((transfer) => ({
      shown: formatAmountExact(transfer.amount, token.decimals),
      raw: transfer.amount.toString(),
    })),
    minutes: PERMIT2_TIP_DEADLINE_SECONDS / 60,
    permissionNext: permission !== null,
    ...counter.next(),
  });
  let signed: unknown;
  try {
    signed = await deps.signTypedData(typedData);
  } catch (error) {
    if (isUserRejection(error)) return { note: " Tips not sent: you declined the signature.", mode: "none" };
    const outcome = await sendAsTransfers(
      deps,
      counter,
      intent,
      total,
      isUnsupported(error)
        ? "your wallet can't sign one permit for all of them"
        : `your wallet can't sign one permit for all of them (${reason(error)})`,
    );
    return { ...outcome, batchUnusable: "your wallet couldn't sign one permit for all of them" };
  }
  const signature = asSignature(signed);
  if (signature === null) {
    return sendAsTransfers(deps, counter, intent, total, "your wallet returned no usable signature");
  }

  // 6. The standing permission, now that the signature is in hand. Declined
  // or failed, the signature goes unused, and the note says what that means.
  let granted = false;
  let permissionHash: Hex | null = null;
  if (permission !== null) {
    deps.onStep({ kind: "tip-permission", symbol: token.symbol, ...counter.next() });
    try {
      permissionHash = hashOf(await deps.send(permission.call));
    } catch (error) {
      if (isUserRejection(error)) {
        const outcome = await sendAsTransfers(deps, counter, intent, total, "you declined the permission for Permit2");
        return { ...outcome, note: `${outcome.note}${SIGNATURE_UNUSED}` };
      }
      return {
        note: ` Tips not sent: the permission for Permit2 failed (${reason(error)}).${SIGNATURE_UNUSED}`,
        mode: "none",
      };
    }
    granted = true;
  }
  // From here, anything but a batch leaves a permission given in this run
  // unused, and the note says so. Its fee was still spent on tipping, so the
  // record counts it with the first tip that went out.
  const after = (outcome: TipOutcome): TipOutcome => {
    if (!granted || outcome.mode === "permit2-batch") return outcome;
    const [first, ...rest] = outcome.sent ?? [];
    const sent =
      first !== undefined && permissionHash !== null ? [{ ...first, hashes: [permissionHash, ...first.hashes] }, ...rest] : outcome.sent;
    return { ...outcome, note: `${outcome.note}${PERMISSION_STAYS}`, ...(sent === undefined ? {} : { sent }) };
  };

  // 7. The one call, checked and simulated like any tip.
  const plan = buildBatchTipPlan(intent, { nonce, deadline, signature });
  const verdict = await safely(() => deps.checks.checkTips(plan));
  if (verdict instanceof Error) {
    return after({ note: ` Tips not sent: spDEX couldn't check them (${reason(verdict)}).`, mode: "none" });
  }
  if (!verdict.signable) {
    const only = (code: string) => verdict.violations.every((violation) => violation.code === code);
    // The permission's confirmation can outlast the signature's twenty
    // minutes, as the batch's own prompt never could. The permit is then
    // dead, not wrong, and asking for another would be a prompt more:
    // separate transfers need none, and this wallet can still batch next time.
    if (only("DEADLINE_EXPIRED")) {
      return after(
        await sendAsTransfers(deps, counter, intent, total, "the signature expired before the one transaction could use it"),
      );
    }
    // A batch that would only revert is a batch Permit2 won't take, not one
    // that was wrong: most often an account that runs code of its own (an
    // EIP-7702 delegation, a contract wallet), whose signature Permit2 checks
    // through that code, which may not answer. Separate transfers need no
    // signature and get their own check. Any other refusal stands.
    if (only("SIMULATION_REVERTED")) {
      const message = verdict.violations[0]?.message ?? "it reverts";
      const outcome = await sendAsTransfers(
        deps,
        counter,
        intent,
        total,
        `the one transaction would fail on chain (${message})`,
      );
      return after({ ...outcome, batchUnusable: "one transaction for all of them would fail for this wallet" });
    }
    return after({ note: ` Tips not sent — spDEX refused them: ${codesOf(verdict)}.`, mode: "none" });
  }

  // 8. Sent by the user, like the swap. The wallet shows a call to Permit2,
  // so the status says who it pays.
  deps.onStep({
    kind: "tip-batch",
    symbol: token.symbol,
    payments: deps.transfers.map((transfer) => ({
      name: transfer.label || transfer.recipient,
      shown: formatAmountExact(transfer.amount, token.decimals),
    })),
    tested: verdict.level === "verified",
    ...counter.next(),
  });
  let batchHash: Hex | null;
  try {
    batchHash = hashOf(await deps.send(plan.calls[0]!));
  } catch (error) {
    if (isUserRejection(error)) return after({ note: " Tips not sent: you declined in your wallet.", mode: "none" });
    return after({ note: ` Tips not sent: ${reason(error)}.`, mode: "none" });
  }
  const outcome: TipOutcome = {
    note: ` Tipped ${total} to ${peopleText(people)} in one transaction.${verdict.level === "verified" ? "" : UNTESTED}`,
    mode: "permit2-batch",
  };
  return batchHash === null
    ? outcome
    : withSent(outcome, [
        {
          token: token.address,
          hashes: permissionHash === null ? [batchHash] : [permissionHash, batchHash],
          amount: totalTipped(deps.transfers),
          recipients: people,
        },
      ]);
}

/**
 * The tips as one transfer each: always for one recipient, and for more when
 * a batch could not be made. `why` says which, so a fallback is never silent,
 * in the status while the wallet asks as well as in the note after.
 */
async function sendAsTransfers(
  deps: TipFlowDeps,
  counter: StepCounter,
  intent: TipIntent,
  total: string,
  why: string | null,
): Promise<TipOutcome> {
  const plan = transferPlanFor(intent);
  const people = plan.calls.length;
  const verdict = await safely(() => deps.checks.checkTips(plan));
  if (verdict instanceof Error) {
    return { note: ` Tips not sent: spDEX couldn't check them (${reason(verdict)}).`, mode: "none" };
  }
  if (!verdict.signable) {
    // Named, not summarised. A refused tip is the Guard working, and the user
    // should be able to see which invariant it was.
    return { note: ` Tips not sent — spDEX refused them: ${codesOf(verdict)}.`, mode: "none" };
  }

  counter.expectMore(people);
  const sent: TipSent[] = [];
  for (const [index, call] of plan.calls.entries()) {
    deps.onStep({ kind: "tip", index: index + 1, count: people, why: people === 1 ? null : why, ...counter.next() });
    let hash: Hex | null;
    try {
      hash = hashOf(await deps.send(call));
    } catch (error) {
      const stopped = index === 0 ? "Tips not sent" : `Tips stopped after ${index} of ${people}`;
      return withSent(
        {
          note: isUserRejection(error) ? ` ${stopped}: you declined in your wallet.` : ` ${stopped}: ${reason(error)}.`,
          mode: index === 0 ? "none" : "transfers",
        },
        sent,
      );
    }
    const transfer = intent.transfers[index];
    if (hash !== null && transfer !== undefined) {
      sent.push({ token: intent.token, hashes: [hash], amount: transfer.amount, recipients: 1 });
    }
  }

  const how = people === 1 ? "" : why === null ? "" : `, in ${people} separate transfers: ${why}`;
  return withSent(
    {
      note: ` Tipped ${total} to ${peopleText(people)}${how}.${verdict.level === "verified" ? "" : UNTESTED}`,
      mode: "transfers",
    },
    sent,
  );
}

/** A check that threw, as a value: the flow reports it rather than letting it escape. */
async function safely<T>(run: () => Promise<T>): Promise<T | Error> {
  try {
    return await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
