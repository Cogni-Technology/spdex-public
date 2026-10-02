/**
 * Static checks — everything decidable without touching the chain.
 *
 * Cheap, deterministic, and always run. Their job is to bound what a plan may
 * reference so simulation has a smaller space to police, and to catch the
 * outright-malformed before spending an RPC round-trip on it.
 *
 * These checks are necessary but nowhere near sufficient. A plan can pass every
 * one of them and still drain a wallet through a contract the module legitimately
 * declared — which is exactly why simulation exists.
 */

import { isNativeToken } from "@spdex/chain";
import {
  canonicalize,
  isAddressEqual,
  PERMIT2_ADDRESS,
  type Address,
  type GuardViolation,
  type ModuleManifest,
  type SwapIntent,
  type TxPlan,
} from "@spdex/core";

export interface StaticCheckInput {
  plan: TxPlan;
  /** The intent the user was actually shown. */
  expectedIntent: SwapIntent;
  manifest: ModuleManifest;
  /** Contracts the user chose to trust beyond the module's manifest. */
  extraTrustedContracts: readonly Address[];
  chainId: number;
  nowSeconds: bigint;
}

export function runStaticChecks(input: StaticCheckInput): GuardViolation[] {
  const { plan, expectedIntent, manifest, extraTrustedContracts, chainId, nowSeconds } = input;
  const violations: GuardViolation[] = [];

  // The plan must carry the very intent the user approved. Comparing canonical
  // encodings rather than object identity means a module cannot slip in a
  // structurally-different-but-similar-looking intent.
  if (canonicalize(plan.intent) !== canonicalize(expectedIntent)) {
    violations.push({
      code: "INTENT_MISMATCH",
      message: "plan does not carry the intent the user approved",
    });
    // Everything below reasons *from* the intent, so once it is untrustworthy
    // there is nothing meaningful left to check.
    return violations;
  }

  if (plan.intent.chainId !== chainId) {
    violations.push({
      code: "CHAIN_MISMATCH",
      message: `intent targets chain ${plan.intent.chainId}, host is on ${chainId}`,
      detail: { expected: String(chainId), actual: String(plan.intent.chainId) },
    });
  }

  if (plan.intent.deadline <= nowSeconds) {
    violations.push({
      code: "DEADLINE_EXPIRED",
      message: "intent deadline has already passed",
      detail: { deadline: plan.intent.deadline.toString(), now: nowSeconds.toString() },
    });
  }

  const trusted = new Set<Address>([
    ...manifest.contracts,
    ...extraTrustedContracts,
  ]);

  for (const [i, call] of plan.calls.entries()) {
    if (!trusted.has(call.to)) {
      violations.push({
        code: "UNDECLARED_TARGET",
        message: `call ${i} targets ${call.to}, which the module never declared`,
        detail: { index: String(i), target: call.to, moduleId: manifest.id },
      });
    }
  }

  // Permit2 is refused by name, before trust is consulted. It keeps
  // allowances of its own, which a call to it can set with no signature and
  // which outlive the swap; once the user has given Permit2 the ERC-20
  // permission (a batched tip asks for it, unlimited), such an allowance lets
  // its holder take the whole balance later. Simulation sees one being set
  // (effects.ts), but without simulation a verdict is `unverified` and still
  // signable, so this layer must refuse it on its own. No venue spDEX ships
  // needs Permit2; one that does would need a Guard that bounds Permit2's own
  // allowances first, not a declaration or a trust entry.
  for (const [i, call] of plan.calls.entries()) {
    if (isAddressEqual(call.to, PERMIT2_ADDRESS)) {
      violations.push({
        code: "PERMIT2_TARGET",
        message: `call ${i} goes to Permit2, whose allowances would outlive this swap`,
        detail: { index: String(i), target: call.to },
      });
    }
  }

  for (const [i, approval] of plan.approvals.entries()) {
    if (isAddressEqual(approval.spender, PERMIT2_ADDRESS)) {
      violations.push({
        code: "PERMIT2_TARGET",
        message: `approval ${i} names Permit2 as the spender, which a swap never needs`,
        detail: { index: String(i), spender: approval.spender },
      });
    }
    if (!trusted.has(approval.spender)) {
      violations.push({
        code: "APPROVAL_UNDECLARED_SPENDER",
        message: `approval ${i} would authorise ${approval.spender}, which the module never declared`,
        detail: { index: String(i), spender: approval.spender },
      });
    }

    // Approving a token the user never agreed to spend is never legitimate for
    // a swap, regardless of amount.
    if (!isAddressEqual(approval.token, plan.intent.tokenIn)) {
      violations.push({
        code: "APPROVAL_EXCEEDS_INTENT",
        message: `approval ${i} is for ${approval.token}, not the token being sold`,
        detail: { index: String(i), token: approval.token, tokenIn: plan.intent.tokenIn },
      });
      continue;
    }

    // Bounds the classic "infinite approval" — representable, but it must not
    // exceed what the user agreed to part with.
    if (approval.amount > plan.intent.maxAmountIn) {
      violations.push({
        code: "APPROVAL_EXCEEDS_INTENT",
        message: `approval ${i} exceeds the amount the user agreed to spend`,
        detail: {
          index: String(i),
          amount: approval.amount.toString(),
          maxAmountIn: plan.intent.maxAmountIn.toString(),
        },
      });
    }
  }

  // ── Native ETH ──
  //
  // Bounded from the plan's declared call values, which are unambiguous. The
  // simulation layer checks the *observed* native delta separately; this is the
  // cheap check that catches a plan asking for more than the user agreed to
  // before an RPC round-trip is spent on it.
  const declaredValue = plan.calls.reduce((sum, c) => sum + c.value, 0n);

  if (isNativeToken(plan.intent.tokenIn)) {
    if (declaredValue > plan.intent.maxAmountIn) {
      violations.push({
        code: "UNEXPECTED_ETH_TRANSFER",
        message: "plan sends more native ETH than the user agreed to spend",
        detail: {
          declaredValue: declaredValue.toString(),
          maxAmountIn: plan.intent.maxAmountIn.toString(),
        },
      });
    }
    // Native assets have no allowance mechanism, so an approval alongside a
    // native sale is either confused or an attempt to authorise something else.
    if (plan.approvals.length > 0) {
      violations.push({
        code: "APPROVAL_EXCEEDS_INTENT",
        message: "plan requests a token approval while selling native ETH",
        detail: { approvals: String(plan.approvals.length) },
      });
    }
  } else if (declaredValue > 0n) {
    // Selling an ERC-20 never requires sending ETH along with it.
    violations.push({
      code: "UNEXPECTED_ETH_TRANSFER",
      message: "plan moves native ETH, which an ERC-20 sale never requires",
      detail: { declaredValue: declaredValue.toString() },
    });
  }

  // The module's own quote already failing the intent is worth catching before
  // paying for a simulation.
  if (plan.meta.quotedAmountOut < plan.intent.minAmountOut) {
    violations.push({
      code: "MIN_OUT_NOT_MET",
      message: "module's own quote is below the promised minimum",
      detail: {
        quoted: plan.meta.quotedAmountOut.toString(),
        minOut: plan.intent.minAmountOut.toString(),
      },
    });
  }

  return violations;
}
