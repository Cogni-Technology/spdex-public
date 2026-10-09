/**
 * The Guard, applied to tip transfers.
 *
 * A tip moves the user's money to somebody else, which is the shape of every
 * attack this project exists to refuse. It gets a proof of its own rather than
 * an exemption from the swap's.
 *
 * ## What is actually being defended against
 *
 * The host builds these calls itself — no module is involved — so the static
 * layer here is partly the host checking its own arithmetic. That is deliberate
 * and not ceremony. The amounts derive from a registry the user chose, a
 * percentage they typed, and a balance read over the network, and a bug in any
 * of those is indistinguishable from malice at the point where a transaction is
 * signed. The rule in AGENTS.md is that every plan reaches the signer through
 * the Guard; "the host wrote it" has never been an exemption, because the day
 * it becomes one is the day the host is the thing worth compromising.
 *
 * ## The invariants
 *
 *   1. Total tipped is at most MAX_TOTAL_TIP_BPS of what the swap delivered.
 *      A hard ceiling, not a configured one, so a corrupt config cannot lift it.
 *   2. Every call is byte-for-byte the ERC-20 transfer its intent describes —
 *      encoded by the same function the host encoded with, so the check cannot
 *      quietly verify a different copy of the same bug.
 *   3. Nobody receives less than promised, measured at their address.
 *   4. Nothing else leaves the account, and no approval is granted.
 *   5. No tip goes where a token is lost or taken: the token's own contract,
 *      Permit2, the burn address, a public development account off a local
 *      test network, or a contract the host names (`refuseRecipients`).
 *      Whoever picked the address — a list, the person, an imported file or
 *      a settings link — the refusal is the same (`TIP_MALFORMED`, with
 *      `detail.reason`).
 *
 * ## Batched tips, through Permit2
 *
 * Two or more recipients are paid in one transaction through Permit2 (see
 * "Batching" in `@spdex/core` tips.ts). That adds two things to sign besides
 * the transaction, and each goes through here rather than around it:
 *
 *   - **The signature** (`checkSignature`), before the wallet is asked for it.
 *     A signature request is a request to move money. The typed data the
 *     wallet will be handed must be exactly what `permit2BatchTypedDataJson`
 *     builds from the intent: same token, amounts and order, the account as
 *     spender, Permit2 on this chain as the verifying contract, a well-formed
 *     nonce and a deadline no more than thirty minutes away.
 *   - **The standing permission** (`checkPermission`): exactly
 *     `approve(PERMIT2, max)` on the token the tip sends, or `approve(PERMIT2,
 *     0)` to revoke. Never another spender, never another token, and a grant
 *     only for a tip to two or more people, which is the only tip that is
 *     batched. A grant is never signed untested: it is unlimited and it
 *     stands until revoked, so it is held to what a scheduled buy is held to,
 *     whatever `requireSimulation` says. A revoke can only take authority
 *     away, and follows `requireSimulation` like any tip.
 *
 * The batch transaction itself is held to invariants 1, 3 and 4 as above, and
 * to 2 in its own form: one call, to Permit2, byte-for-byte the
 * `permitTransferFrom` a fresh encoding of the intent and the signed permit
 * gives. That one comparison is what pins every recipient, amount and the
 * token, in order, and the account as owner.
 *
 * Anything that rests on Permit2 being Permit2 (a signature for it, a
 * permission for it, a transaction to it) also needs the code at its address
 * to hash to `PERMIT2_CODE_HASH`. An unlimited allowance is acceptable only
 * because of what that code does, so it is checked, not assumed.
 */

import type { SimLog, SimulationOutcome, SimulationProvider } from "@spdex/chain";
import { NATIVE_TOKEN, SimulationUnavailableError } from "@spdex/chain";
import {
  encodePermit2Approval,
  encodePermit2BatchTransfer,
  encodeTipTransfer,
  isAddressEqual,
  isPermit2CodeHash,
  isPlaceholderChain,
  isPublicDevAccount,
  isPermit2Nonce,
  permit2BatchTypedData,
  permit2BatchTypedDataJson,
  permit2PermissionAmount,
  rejected,
  unverified,
  verified,
  MAX_PERMIT2_DEADLINE_SECONDS,
  MAX_TOTAL_TIP_BPS,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  type Address,
  type GuardVerdict,
  type GuardViolation,
  type TipIntent,
  type TipPermissionPlan,
  type TipPlan,
  type TipSignatureRequest,
} from "@spdex/core";
import { deltaFor, observeEffects, unexpectedOutflows } from "./effects.js";
import { applySecondOpinion } from "./second-opinion.js";

export interface TipGuardOptions {
  chainId: number;
  requireSimulation: boolean;
  /**
   * Unix seconds now, for a permit's deadline. The page's clock by default:
   * the deadline is set by that clock (`PERMIT2_TIP_DEADLINE_SECONDS`), and
   * held to the thirty-minute line by the same one.
   */
  now?: () => number;
  /**
   * keccak256 of the code at `PERMIT2_ADDRESS` on this chain, or null when it
   * could not be read. Without it nothing that rests on Permit2 can pass: a
   * batch, its signature and a grant are refused, and only plain transfers
   * and a revoke remain possible.
   */
  permit2CodeHash?: () => Promise<string | null>;
  /**
   * The ERC-20 allowance the account has given Permit2 on a token, as it
   * stands before the batch; throws when it cannot be read. A token may log
   * that allowance going down as Permit2 spends it, and this is what "down"
   * is measured from. Without it, any such log is refused: a change that
   * cannot be told from a raise is treated as one.
   */
  permit2Allowance?: (account: Address, token: Address) => Promise<bigint>;
  /**
   * More addresses no tip may go to, handed in by the host: the tokens it
   * lists, the vault factory, the venues' routers — contracts a token sent to
   * is lost in. Refusal only, so it can narrow what passes and never widen
   * it. Raised as `TIP_MALFORMED` with `detail.reason: "known-contract"`.
   */
  refuseRecipients?: readonly Address[];
}

const nowSeconds = (options: TipGuardOptions): bigint =>
  BigInt(Math.floor(options.now ? options.now() : Date.now() / 1000));

const malformed = (message: string, detail?: Record<string, string>): GuardViolation => ({
  code: "TIP_MALFORMED",
  message,
  ...(detail === undefined ? {} : { detail }),
});

/** The burn address people send tokens to on purpose: a tip there is a tip to nobody. */
const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

/**
 * Why a tip may not go to `recipient`, whoever chose it, as a `detail.reason`,
 * or null. Each is an address a token sent to is lost at, or taken from:
 *
 * - `token-contract`: the token being tipped (a token sent to its own
 *   contract is stuck there);
 * - `permit2`: Permit2, which holds nothing for anyone;
 * - `burn`: `0x…dEaD`;
 * - `public-dev-account`: a public development account (`PUBLIC_DEV_ACCOUNTS`)
 *   on a network that is not a local test one, whose key anyone has;
 * - `known-contract`: one the host passed in `refuseRecipients`.
 *
 * Always a refusal (`TIP_MALFORMED`), never a warning, and the same list
 * whether the address was picked, saved, imported or arrived in a settings
 * link.
 */
function refusedRecipient(intent: TipIntent, recipient: string, refuse: ReadonlySet<string>): string | null {
  const address = recipient.toLowerCase();
  if (address === intent.token.toLowerCase()) return "token-contract";
  if (address === PERMIT2_ADDRESS) return "permit2";
  if (address === BURN_ADDRESS) return "burn";
  if (isPublicDevAccount(address) && !isPlaceholderChain(intent.chainId)) return "public-dev-account";
  if (refuse.has(address)) return "known-contract";
  return null;
}

const REFUSED_WORDS: Record<string, string> = {
  "token-contract": "the token's own contract, where it would be lost",
  permit2: "Permit2, a contract that holds nothing for anyone",
  burn: "a burn address",
  "public-dev-account": "a public development account, whose key anyone has",
  "known-contract": "a contract, where the token would be lost",
};

/**
 * What is wrong with a tip's intent on its own, whichever way it is paid: the
 * ceiling, and each transfer's amount and recipient. `refuse` is the host's
 * `refuseRecipients`.
 */
export function tipIntentViolations(intent: TipIntent, refuse: readonly string[] = []): GuardViolation[] {
  const refused = new Set(refuse.map((address) => address.toLowerCase()));
  const violations: GuardViolation[] = [];
  const total = intent.transfers.reduce((sum, t) => sum + t.amount, 0n);

  // The ceiling is checked against the delivered amount rather than the quote,
  // so a swap that underdelivered shrinks the tip with it instead of handing
  // the user's slippage to the recipient.
  if (intent.deliveredAmount <= 0n) {
    violations.push({
      code: "TIP_EXCEEDS_LIMIT",
      message: "cannot tip a share of nothing — the swap delivered no output",
    });
  } else if (total * 10_000n > intent.deliveredAmount * BigInt(MAX_TOTAL_TIP_BPS)) {
    violations.push({
      code: "TIP_EXCEEDS_LIMIT",
      message: `tips total more than the ${MAX_TOTAL_TIP_BPS} bps ceiling`,
      detail: {
        total: total.toString(),
        delivered: intent.deliveredAmount.toString(),
        ceilingBps: String(MAX_TOTAL_TIP_BPS),
      },
    });
  }

  const seen = new Set<string>();
  for (const [index, transfer] of intent.transfers.entries()) {
    if (transfer.amount <= 0n) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `transfer ${index} is for zero`,
        detail: { index: String(index), recipient: transfer.recipient },
      });
    }

    // Tipping yourself is not an attack, but it is a transaction that costs gas
    // and does nothing, which usually means a bug upstream.
    if (isAddressEqual(transfer.recipient, intent.account)) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `transfer ${index} pays the sender`,
        detail: { index: String(index) },
      });
    }

    if (/^0x0{40}$/i.test(transfer.recipient)) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `transfer ${index} would burn the tip`,
        detail: { index: String(index) },
      });
    }

    const reason = refusedRecipient(intent, transfer.recipient, refused);
    if (reason !== null) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `transfer ${index} pays ${REFUSED_WORDS[reason]}`,
        detail: { index: String(index), recipient: transfer.recipient, reason },
      });
    }

    const key = transfer.recipient.toLowerCase();
    if (seen.has(key)) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `${transfer.recipient} appears twice`,
        detail: { index: String(index), recipient: transfer.recipient },
      });
    }
    seen.add(key);
  }

  return violations;
}

/**
 * The static layer for a tip plan, in either mode. `now` (unix seconds) is
 * only read for a batch, whose permit has a deadline.
 */
export function runTipStaticChecks(
  plan: TipPlan,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
  refuse: readonly string[] = [],
): GuardViolation[] {
  const mode = plan.mode ?? "transfers";
  if (mode === "permit2-batch") return runBatchStaticChecks(plan, now, refuse);
  if (mode !== "transfers") return [malformed(`tip mode "${String(mode)}" is not one spDEX knows`)];

  const { intent } = plan;
  const violations: GuardViolation[] = [];

  if (plan.calls.length !== intent.transfers.length) {
    violations.push({
      code: "TIP_MALFORMED",
      message: `plan has ${plan.calls.length} calls for ${intent.transfers.length} transfers`,
    });
    // Positional comparison below is meaningless once the lengths disagree.
    return violations;
  }

  // A permit on a plan of plain transfers is a plan built for one mode and
  // labelled as the other; whichever was meant, this is not it.
  if (plan.permit !== undefined) {
    violations.push(malformed("a plan of separate transfers carries a Permit2 signature"));
  }

  violations.push(...tipIntentViolations(intent, refuse));

  for (const [index, transfer] of intent.transfers.entries()) {
    const call = plan.calls[index]!;

    if (!isAddressEqual(call.to, intent.token)) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `call ${index} targets ${call.to}, not the token being tipped`,
        detail: { index: String(index), target: call.to, token: intent.token },
      });
    }

    // A tip is an ERC-20 transfer. Attaching ether to one is never meaningful
    // and is how a plain-looking call smuggles value out.
    if (call.value !== 0n) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `call ${index} attaches ${call.value} wei to a token transfer`,
        detail: { index: String(index), value: call.value.toString() },
      });
    }

    // The whole calldata, not just the selector: comparing against a fresh
    // encoding of the intent means a call cannot agree about the function and
    // disagree about the recipient or the amount.
    const expected = encodeTipTransfer(transfer.recipient, transfer.amount);
    if (call.data.toLowerCase() !== expected.toLowerCase()) {
      violations.push({
        code: "TIP_MALFORMED",
        message: `call ${index} is not the transfer its intent describes`,
        detail: { index: String(index), expected, actual: call.data },
      });
    }
  }

  return violations;
}

/**
 * The static layer for a batch: one call, to Permit2, that is exactly the
 * `permitTransferFrom` the intent and the signed permit encode to.
 */
function runBatchStaticChecks(plan: TipPlan, now: bigint, refuse: readonly string[]): GuardViolation[] {
  const { intent } = plan;
  const violations: GuardViolation[] = [...tipIntentViolations(intent, refuse)];

  if (plan.calls.length !== 1) {
    violations.push(malformed(`a batch is one call, and this plan has ${plan.calls.length}`));
    return violations;
  }
  const call = plan.calls[0]!;
  if (!isAddressEqual(call.to, PERMIT2_ADDRESS)) {
    violations.push(malformed(`the batch targets ${call.to}, not Permit2`, { target: call.to }));
  }
  // Permit2 takes no ether, and ether on a call that moves tokens is how a
  // plain-looking call smuggles value out.
  if (call.value !== 0n) {
    violations.push(malformed(`the batch attaches ${call.value} wei`, { value: call.value.toString() }));
  }

  const permit = plan.permit;
  if (permit === undefined) {
    violations.push(malformed("a batch without the permit it was signed for cannot be checked"));
    return violations;
  }
  violations.push(...permitTermViolations(permit.nonce, permit.deadline, now));
  if (!/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(permit.signature)) {
    violations.push(malformed("the permit's signature is not 64 or 65 bytes"));
  }

  // The whole calldata, against a fresh encoding of the intent and the permit.
  // Equal bytes mean the same token in every entry, the same recipients and
  // amounts in the same order, nothing added, and the account as owner. The
  // spender is not in the calldata at all: Permit2 hashes msg.sender in as the
  // spender, so a permit signed for anyone but the account that sends this
  // fails its own signature check.
  let expected: string;
  try {
    expected = encodePermit2BatchTransfer(intent, permit);
  } catch (error) {
    violations.push(malformed(`the permit cannot be encoded: ${error instanceof Error ? error.message : String(error)}`));
    return violations;
  }
  if (call.data.toLowerCase() !== expected.toLowerCase()) {
    violations.push(malformed("the batch is not the transfer its intent describes", { expected, actual: call.data }));
  }
  return violations;
}

/** A permit's nonce is a uint256, and its deadline in the future and no more than thirty minutes away. */
function permitTermViolations(nonce: bigint, deadline: bigint, now: bigint): GuardViolation[] {
  const violations: GuardViolation[] = [];
  if (!isPermit2Nonce(nonce)) {
    violations.push(malformed("the permit's nonce is not a uint256", { nonce: nonce.toString() }));
  }
  if (deadline <= now) {
    violations.push({
      code: "DEADLINE_EXPIRED",
      message: `the permit's deadline ${deadline} has passed`,
      detail: { deadline: deadline.toString(), now: now.toString() },
    });
  } else if (deadline > now + BigInt(MAX_PERMIT2_DEADLINE_SECONDS)) {
    // A signature is a standing promise until its deadline. One that outlived
    // the moment it was asked for is one nobody remembers giving.
    violations.push(
      malformed(`the permit stays valid for ${deadline - now} seconds, past the ${MAX_PERMIT2_DEADLINE_SECONDS}-second limit`, {
        deadline: deadline.toString(),
        now: now.toString(),
      }),
    );
  }
  return violations;
}

/** A decimal uint256 as the typed data writes it, or null for anything else. */
function decimalUint(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : null;
}

/**
 * Which part of a typed-data object differs from the one the intent builds:
 * named, so a refusal says what it refused.
 */
function typedDataDifference(actual: unknown, expected: ReturnType<typeof permit2BatchTypedData>): string {
  if (typeof actual !== "object" || actual === null) return "it is not an object";
  const a = actual as Record<string, unknown>;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(a["domain"], expected.domain)) return "its domain is not Permit2 on this chain";
  if (a["primaryType"] !== expected.primaryType) return "it is not a PermitBatchTransferFrom";
  if (!same(a["types"], expected.types)) return "its types are not Permit2's";
  const message = a["message"];
  if (typeof message !== "object" || message === null) return "it has no message";
  const m = message as Record<string, unknown>;
  if (typeof m["spender"] !== "string" || m["spender"].toLowerCase() !== expected.message.spender) {
    return "its spender is not the account that pays";
  }
  if (!same(m["permitted"], expected.message.permitted)) {
    return "its tokens or amounts are not the tips, in order";
  }
  return "it is not byte for byte what spDEX builds from the tips";
}

/**
 * Check a tip plan: static, then simulated.
 *
 * Mirrors `Guard.check` deliberately, including the parts that look like
 * duplication. Sharing a single generic path would mean one set of invariants
 * describing two different actions, and the first time they needed to differ
 * the shared version would grow a flag — which is how an exemption gets added
 * to a swap check by someone editing a tip check.
 */
export class TipGuard {
  constructor(
    private readonly simulation: SimulationProvider,
    private readonly options: TipGuardOptions,
  ) {}

  async check(plan: TipPlan): Promise<GuardVerdict> {
    const batch = plan.mode === "permit2-batch";
    const staticViolations = runTipStaticChecks(plan, nowSeconds(this.options), this.options.refuseRecipients);
    if (plan.intent.chainId !== this.options.chainId) {
      staticViolations.push({
        code: "CHAIN_MISMATCH",
        message: `tip intent targets chain ${plan.intent.chainId}, host is on ${this.options.chainId}`,
      });
    }
    if (batch) staticViolations.push(...(await this.#permit2Violations()));
    if (staticViolations.length > 0) return rejected(staticViolations);

    if (!(await this.simulation.isAvailable())) {
      const warning: GuardViolation = {
        code: "SIMULATION_UNAVAILABLE",
        message: "this RPC cannot simulate transactions, so the tips have not been verified",
        detail: { provider: this.simulation.kind },
      };
      return this.options.requireSimulation ? rejected([warning]) : unverified([warning]);
    }

    const outcome = await this.#simulate(plan.intent.account, plan.calls);
    if ("verdict" in outcome) return outcome.verdict;
    const judged =
      outcome.status === "reverted"
        ? rejected([
            {
              code: "SIMULATION_REVERTED",
              message: outcome.revertReason ?? (batch ? "the batched tip reverts" : "tip transfer reverts"),
            },
          ])
        : await this.#checkEffects(plan, outcome.logs);
    // Last, after this service's own checks (see second-opinion.ts).
    return applySecondOpinion(judged, outcome, { neverUnchecked: this.options.requireSimulation });
  }

  /**
   * Check a request to sign a batch of tips, before the wallet is asked.
   *
   * Nothing is simulated here, because nothing exists to simulate yet: the
   * signature moves nothing by itself, and the transaction that will carry it
   * goes through `check`, simulated, before it is sent. What this pins is the
   * promise the user is about to make: the typed data is exactly what the
   * intent builds, byte for byte, for this chain's Permit2, with the account
   * as the only address that can spend it, and a deadline close at hand.
   */
  async checkSignature(request: TipSignatureRequest): Promise<GuardVerdict> {
    const { intent } = request;
    const violations: GuardViolation[] = [...tipIntentViolations(intent, this.options.refuseRecipients)];
    if (intent.chainId !== this.options.chainId) {
      violations.push({
        code: "CHAIN_MISMATCH",
        message: `tip intent targets chain ${intent.chainId}, host is on ${this.options.chainId}`,
      });
    }
    if (!isAddressEqual(request.signer, intent.account)) {
      violations.push(malformed(`the signature is asked of ${request.signer}, not the account that pays`));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.typedData);
    } catch {
      violations.push(malformed("the typed data is not JSON"));
      return rejected(violations);
    }
    const message = (parsed as { message?: Record<string, unknown> } | null)?.message;
    const nonce = decimalUint(message?.["nonce"]);
    const deadline = decimalUint(message?.["deadline"]);
    if (nonce === null) violations.push(malformed("the permit's nonce is not a decimal uint256"));
    if (deadline === null) violations.push(malformed("the permit's deadline is not a decimal uint256"));
    if (nonce !== null && deadline !== null) {
      violations.push(...permitTermViolations(nonce, deadline, nowSeconds(this.options)));
      // Byte for byte: the string the wallet will be handed, against the
      // string the intent builds. Nothing the wallet shows can differ from
      // what was checked, and nothing the check skipped can be in it.
      const expected = permit2BatchTypedDataJson(intent, nonce, deadline);
      if (request.typedData !== expected) {
        violations.push(
          malformed(`the typed data is not the tips' permit: ${typedDataDifference(parsed, permit2BatchTypedData(intent, nonce, deadline))}`),
        );
      }
    }

    violations.push(...(await this.#permit2Violations()));
    return violations.length > 0 ? rejected(violations) : verified();
  }

  /**
   * Check the standing permission for Permit2, or its revocation.
   *
   * Statically, the call is exactly `approve(PERMIT2, max)` (or `0`) on the
   * plan's token, with no ether; a grant is on the token its tip sends, from
   * the account that sends it, and only while Permit2 is the contract spDEX
   * knows. Simulated, the only effect is that one allowance: nothing leaves
   * the account, and no other spender is approved for anything.
   */
  async checkPermission(plan: TipPermissionPlan): Promise<GuardVerdict> {
    const violations: GuardViolation[] = [];
    if (plan.chainId !== this.options.chainId) {
      violations.push({
        code: "CHAIN_MISMATCH",
        message: `the permission targets chain ${plan.chainId}, host is on ${this.options.chainId}`,
      });
    }
    if (plan.kind !== "grant" && plan.kind !== "revoke") {
      violations.push(malformed(`permission kind "${String(plan.kind)}" is not one spDEX knows`));
      return rejected(violations);
    }
    if (isAddressEqual(plan.token, NATIVE_TOKEN) || /^0x0{40}$/i.test(plan.token)) {
      violations.push(malformed("ether has no allowance to grant", { token: plan.token }));
    }
    if (!isAddressEqual(plan.call.to, plan.token)) {
      violations.push(malformed(`the permission is asked on ${plan.call.to}, not the tip token`, { target: plan.call.to, token: plan.token }));
    }
    if (plan.call.value !== 0n) {
      violations.push(malformed(`the permission attaches ${plan.call.value} wei`, { value: plan.call.value.toString() }));
    }
    // The spender and the amount are both in these bytes; the encoder fixes
    // the spender to Permit2, so no other spender can match.
    const expected = encodePermit2Approval(plan.kind);
    if (plan.call.data.toLowerCase() !== expected.toLowerCase()) {
      violations.push(malformed(`the permission is not approve(Permit2, ${plan.kind === "grant" ? "max" : "0"})`, { expected, actual: plan.call.data }));
    }

    if (plan.kind === "grant") {
      const tip = plan.tip;
      if (tip === undefined) {
        violations.push(malformed("a permission for Permit2 is granted only for a tip, and names none"));
      } else {
        // One recipient is one plain transfer and never batched, so a grant
        // "for" it would be a standing permission nothing uses.
        if (tip.transfers.length < 2) {
          violations.push(malformed(`a permission for Permit2 is granted only to pay two or more people, and this tip pays ${tip.transfers.length}`));
        }
        if (!isAddressEqual(tip.token, plan.token)) {
          violations.push(malformed(`the permission is for ${plan.token}, but the tip sends ${tip.token}`));
        }
        if (!isAddressEqual(tip.account, plan.account)) {
          violations.push(malformed(`the permission is from ${plan.account}, but the tip is from ${tip.account}`));
        }
        if (tip.chainId !== plan.chainId) {
          violations.push(malformed(`the permission is for chain ${plan.chainId}, but the tip is for chain ${tip.chainId}`));
        }
        violations.push(...tipIntentViolations(tip, this.options.refuseRecipients));
      }
      violations.push(...(await this.#permit2Violations()));
    }
    if (violations.length > 0) return rejected(violations);

    // A grant is unlimited and stands until revoked, so it is never signed on
    // the static checks alone, whatever requireSimulation says; a revoke only
    // takes authority away and follows the setting.
    const mustSimulate = plan.kind === "grant" || this.options.requireSimulation;
    if (!(await this.simulation.isAvailable())) {
      const warning: GuardViolation = {
        code: "SIMULATION_UNAVAILABLE",
        message:
          plan.kind === "grant"
            ? "this RPC cannot simulate transactions, and a standing permission for Permit2 is never asked for untested"
            : "this RPC cannot simulate transactions, so the permission has not been verified",
        detail: { provider: this.simulation.kind },
      };
      return mustSimulate ? rejected([warning]) : unverified([warning]);
    }

    const outcome = await this.#simulate(plan.account, [plan.call], mustSimulate);
    if ("verdict" in outcome) return outcome.verdict;
    // A grant is never asked for on one service's word when a second was
    // set and didn't answer, as it is never asked for untested.
    return applySecondOpinion(this.#judgePermission(plan, outcome), outcome, { neverUnchecked: mustSimulate });
  }

  /** This service's test-run of a permission, judged. */
  #judgePermission(plan: TipPermissionPlan, outcome: SimulationOutcome): GuardVerdict {
    if (outcome.status === "reverted") {
      return rejected([{ code: "SIMULATION_REVERTED", message: outcome.revertReason ?? "the permission reverts" }]);
    }

    const effects = observeEffects(outcome.logs);
    const account = plan.account.toLowerCase() as Address;
    const token = plan.token.toLowerCase() as Address;
    const amount = permit2PermissionAmount(plan.kind);
    const found: GuardViolation[] = [];
    if (effects.undecodable > 0) {
      found.push({
        code: "UNDECODABLE_EFFECTS",
        message: `${effects.undecodable} transfer/approval events could not be decoded`,
        detail: { count: String(effects.undecodable) },
      });
    }
    // An approval moves nothing. Anything leaving the account means the call
    // was not the approval it claimed to be.
    for (const delta of effects.deltas.values()) {
      if (delta.account !== account || delta.delta >= 0n) continue;
      found.push({
        code: "UNEXPECTED_TOKEN_TRANSFER",
        message: `${(-delta.delta).toString()} of ${delta.token} leaves the account`,
        detail: { token: delta.token, amount: (-delta.delta).toString() },
      });
    }
    let granted = false;
    for (const approval of effects.approvals) {
      if (approval.owner !== account) continue;
      if (
        approval.via === undefined &&
        approval.token === token &&
        isAddressEqual(approval.spender, PERMIT2_ADDRESS) &&
        approval.amount === amount
      ) {
        granted = true;
        continue;
      }
      found.push({
        code: "UNEXPECTED_APPROVAL",
        message:
          approval.via === "permit2"
            ? `the permission also sets an allowance inside Permit2 on ${approval.token} for ${approval.spender}`
            : `the permission also approves ${approval.spender} for ${approval.token}`,
        detail: { token: approval.token, spender: approval.spender, ...(approval.via === undefined ? {} : { via: approval.via }) },
      });
    }
    // Fail closed on a token that does not log its approval: the Guard judges
    // what it can see, and it cannot see this one land.
    if (!granted) found.push(malformed("the simulation shows no approval for Permit2 of the amount asked"));
    return found.length > 0 ? rejected(found) : verified();
  }

  /** Nothing that rests on Permit2 passes unless the code at its address is the Permit2 spDEX knows. */
  async #permit2Violations(): Promise<GuardViolation[]> {
    let hash: string | null = null;
    try {
      hash = (await this.options.permit2CodeHash?.()) ?? null;
    } catch {
      hash = null;
    }
    if (isPermit2CodeHash(hash)) return [];
    return [
      malformed(
        hash === null
          ? "the code at Permit2's address could not be read, so it is not known to be Permit2"
          : "the contract at Permit2's address is not the Permit2 spDEX knows",
        { address: PERMIT2_ADDRESS, ...(hash === null ? {} : { codeHash: hash }) },
      ),
    ];
  }

  async #simulate(
    account: Address,
    calls: TipPlan["calls"],
    mustSimulate: boolean = this.options.requireSimulation,
  ): Promise<{ verdict: GuardVerdict } | SimulationOutcome> {
    try {
      // The outcome as the provider gave it, `secondOpinion` included.
      return await this.simulation.simulate({ chainId: this.options.chainId, account, calls });
    } catch (error) {
      const violation: GuardViolation = {
        code: "SIMULATION_UNAVAILABLE",
        message:
          error instanceof SimulationUnavailableError
            ? error.message
            : `simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      return { verdict: mustSimulate ? rejected([violation]) : unverified([violation]) };
    }
  }

  /** The ERC-20 allowance the account gave Permit2 on the token, before; null when it can't be read. */
  async #permit2AllowanceBefore(account: Address, token: Address): Promise<bigint | null> {
    try {
      const read = this.options.permit2Allowance;
      return read === undefined ? null : await read(account, token);
    } catch {
      return null;
    }
  }

  async #checkEffects(plan: TipPlan, logs: SimLog[]): Promise<GuardVerdict> {
    const { intent } = plan;
    const effects = observeEffects(logs);
    const violations: GuardViolation[] = [];
    const token = intent.token.toLowerCase() as Address;
    const account = intent.account.toLowerCase() as Address;

    if (effects.undecodable > 0) {
      violations.push({
        code: "UNDECODABLE_EFFECTS",
        message: `${effects.undecodable} transfer/approval events could not be decoded`,
        detail: { count: String(effects.undecodable) },
      });
    }

    let intendedTotal = 0n;
    for (const transfer of intent.transfers) {
      intendedTotal += transfer.amount;
      const received = deltaFor(effects, token, transfer.recipient.toLowerCase() as Address);
      if (received < transfer.amount) {
        violations.push({
          code: "TIP_NOT_DELIVERED",
          message: `${transfer.label || transfer.recipient} receives ${received}, not the ${transfer.amount} promised`,
          detail: {
            recipient: transfer.recipient,
            received: received.toString(),
            promised: transfer.amount.toString(),
          },
        });
      }
    }

    // Spending more than the sum of the transfers means something else moved,
    // whatever the individual recipients received.
    const spent = -deltaFor(effects, token, account);
    if (spent > intendedTotal) {
      violations.push({
        code: "TIP_EXCEEDS_LIMIT",
        message: `${spent} leaves the account for tips totalling ${intendedTotal}`,
        detail: { spent: spent.toString(), intended: intendedTotal.toString() },
      });
    }

    // Any *other* token leaving is theft dressed as a tip.
    for (const outflow of unexpectedOutflows(effects, account, token)) {
      violations.push({
        code: "UNEXPECTED_TOKEN_TRANSFER",
        message: `${(-outflow.delta).toString()} of ${outflow.token} leaves the account`,
        detail: { token: outflow.token, amount: (-outflow.delta).toString() },
      });
    }

    // A tip never needs a new allowance. One appearing here means the call was
    // not the transfer it claimed to be. The single exception is a batch's own
    // spend: a token may log Permit2's ERC-20 allowance going down as Permit2
    // moves the tips (OpenZeppelin's ERC-20 does, for any allowance short of
    // the maximum; SPX does even from the maximum). That is the permission
    // being used, not granted, so it passes only at or below what the
    // allowance was before, read afresh; a figure above it, or one that can't
    // be compared, is a raise. An allowance inside Permit2 itself (`via`) never
    // passes: `permitTransferFrom` sets none.
    const batch = plan.mode === "permit2-batch";
    let before: bigint | null | undefined;
    for (const granted of effects.approvals) {
      if (granted.owner !== account || granted.amount === 0n) continue;
      if (batch && granted.via === undefined && granted.token === token && isAddressEqual(granted.spender, PERMIT2_ADDRESS)) {
        if (before === undefined) before = await this.#permit2AllowanceBefore(account, token);
        if (before !== null && granted.amount <= before) continue;
        violations.push({
          code: "UNEXPECTED_APPROVAL",
          message:
            before === null
              ? `the batch moves Permit2's allowance of ${granted.token} to ${granted.amount}, and what it was before could not be read`
              : `the batch raises Permit2's allowance of ${granted.token} from ${before} to ${granted.amount}`,
          detail: {
            token: granted.token,
            spender: granted.spender,
            amount: granted.amount.toString(),
            ...(before === null ? {} : { before: before.toString() }),
          },
        });
        continue;
      }
      violations.push({
        code: "UNEXPECTED_APPROVAL",
        message:
          granted.via === "permit2"
            ? `tip sets an allowance inside Permit2 on ${granted.token} for ${granted.spender}`
            : `tip grants ${granted.spender} an allowance of ${granted.token}`,
        detail: { token: granted.token, spender: granted.spender, ...(granted.via === undefined ? {} : { via: granted.via }) },
      });
    }

    return violations.length > 0 ? rejected(violations) : verified();
  }
}
