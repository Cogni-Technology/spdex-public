/**
 * The Guard.
 *
 * Every TxPlan reaches the signer through here — from the QuickJS sandbox and
 * from the native runtime alike. There is no bypass and no fast path: a
 * first-party module is faster to execute, never more trusted.
 *
 * Three layers, in increasing cost and increasing strength:
 *
 *   1. static      what the plan references          (always)
 *   2. simulation  what the plan would actually do   (when the RPC can)
 *   3. oracle      whether the price is sane         (when a feed exists)
 *
 * Layer 2 carries the real guarantee. A module can claim anything; it cannot
 * make a simulated transfer appear that does not happen, nor hide one that does.
 * A network service can, which is why the user may name a second one: every
 * simulation then runs on both at one agreed block, and a disagreement refuses
 * (second-opinion.ts, applied last in every path that simulates).
 */

import type { SimulationOutcome, SimulationProvider } from "@spdex/chain";
import { SimulationUnavailableError } from "@spdex/chain";
import {
  rejected,
  unverified,
  verified,
  type Address,
  type Call,
  type GuardVerdict,
  type GuardViolation,
  type ModuleManifest,
  type SwapIntent,
  type TxPlan,
} from "@spdex/core";
import { deltaFor, observeEffects, unexpectedOutflows } from "./effects.js";
import { applySecondOpinion } from "./second-opinion.js";
import { runStaticChecks } from "./static.js";

/** Independent price source for the sanity cross-check. */
export interface OracleProvider {
  /**
   * How much tokenOut one unit of tokenIn is worth, scaled by 1e18.
   * Returns null when the pair is unknown — absence is not a failure.
   */
  priceRatio(tokenIn: Address, tokenOut: Address): Promise<bigint | null>;
}

export interface GuardOptions {
  chainId: number;
  /** Reject rather than degrade when simulation is unavailable. */
  requireSimulation: boolean;
  /**
   * Tolerance before an oracle disagreement is reported. Always as a warning:
   * the oracle never refuses a plan (AGENTS.md rule 2).
   */
  oracleDivergenceBps: number;
  oracle?: OracleProvider;
}

export interface GuardInput {
  plan: TxPlan;
  expectedIntent: SwapIntent;
  manifest: ModuleManifest;
  extraTrustedContracts: readonly Address[];
  nowSeconds: bigint;
}

export class Guard {
  constructor(
    private readonly simulation: SimulationProvider,
    private readonly options: GuardOptions,
  ) {}

  async check(input: GuardInput): Promise<GuardVerdict> {
    const staticViolations = runStaticChecks({
      plan: input.plan,
      expectedIntent: input.expectedIntent,
      manifest: input.manifest,
      extraTrustedContracts: input.extraTrustedContracts,
      chainId: this.options.chainId,
      nowSeconds: input.nowSeconds,
    });

    // Static failures are dispositive: there is no point simulating a plan that
    // is already out of contract, and doing so would leak the user's intent to
    // the RPC for nothing.
    if (staticViolations.length > 0) return rejected(staticViolations);

    if (!(await this.simulation.isAvailable())) {
      const warning: GuardViolation = {
        code: "SIMULATION_UNAVAILABLE",
        message:
          "this RPC cannot simulate transactions — static checks passed, but the " +
          "outcome has not been verified",
        detail: { provider: this.simulation.kind },
      };
      return this.options.requireSimulation ? rejected([warning]) : unverified([warning]);
    }

    let outcome;
    try {
      outcome = await this.simulation.simulate({
        chainId: this.options.chainId,
        account: input.plan.intent.account,
        // Approvals are simulated alongside the calls, in that order, because
        // that is the sequence that will actually run. Simulating the swap
        // alone means simulating it without the allowance it depends on, so it
        // reverts and the Guard rejects every first-time swap — the user has no
        // allowance yet precisely because they have not swapped yet.
        //
        // These synthesised calls are not trusted input: each one is built by
        // the host from an approval the static layer has already bounded
        // against the intent, so nothing a module supplied reaches the chain
        // through this path.
        calls: [...input.plan.approvals.map(approvalCall), ...input.plan.calls],
      });
    } catch (error) {
      // A provider that claimed availability and then failed is a degraded
      // state, not a safe one. Never fall through to `verified`.
      const violation: GuardViolation = {
        code: "SIMULATION_UNAVAILABLE",
        message:
          error instanceof SimulationUnavailableError
            ? error.message
            : `simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      return this.options.requireSimulation ? rejected([violation]) : unverified([violation]);
    }

    // The second opinion, when there is one, has the last word: after this
    // service's own checks have run in full (see second-opinion.ts).
    const judged = await this.#judge(input.plan, outcome);
    return applySecondOpinion(judged, outcome, { neverUnchecked: this.options.requireSimulation });
  }

  /** This service's test-run, judged: a revert, then the effects, then the oracle's warnings. */
  async #judge(plan: TxPlan, outcome: SimulationOutcome): Promise<GuardVerdict> {
    if (outcome.status === "reverted") {
      return rejected([
        {
          code: "SIMULATION_REVERTED",
          message: outcome.revertReason ?? "transaction reverts",
        },
      ]);
    }

    const violations = this.#checkEffects(plan, outcome.logs);
    if (violations.length > 0) return rejected(violations);

    const warnings = await this.#oracleCrossCheck(plan, outcome.logs);
    return verified(warnings);
  }

  #checkEffects(plan: TxPlan, logs: Parameters<typeof observeEffects>[0]): GuardViolation[] {
    const { intent } = plan;
    const effects = observeEffects(logs);
    const violations: GuardViolation[] = [];

    // Effects we could not decode cannot be judged, and unjudged effects must
    // not be waved through.
    if (effects.undecodable > 0) {
      violations.push({
        code: "UNDECODABLE_EFFECTS",
        message: `${effects.undecodable} transfer/approval events could not be decoded`,
        detail: { count: String(effects.undecodable) },
      });
    }

    // ── The core invariant ──
    // Measured at the *recipient*, so redirecting the proceeds elsewhere shows
    // up here as a shortfall rather than slipping past.
    const received = deltaFor(effects, intent.tokenOut, intent.recipient);
    if (received < intent.minAmountOut) {
      violations.push({
        code: received <= 0n ? "RECIPIENT_MISMATCH" : "MIN_OUT_NOT_MET",
        message:
          received <= 0n
            ? `recipient ${intent.recipient} receives nothing`
            : "simulated output is below the promised minimum",
        detail: {
          recipient: intent.recipient,
          received: received.toString(),
          minAmountOut: intent.minAmountOut.toString(),
        },
      });
    }

    const spent = -deltaFor(effects, intent.tokenIn, intent.account);
    if (spent > intent.maxAmountIn) {
      violations.push({
        code: "MAX_IN_EXCEEDED",
        message: "simulation spends more than the user agreed to",
        detail: { spent: spent.toString(), maxAmountIn: intent.maxAmountIn.toString() },
      });
    }

    // Anything else leaving the account is theft, whatever the module called it.
    for (const outflow of unexpectedOutflows(effects, intent.account, intent.tokenIn)) {
      violations.push({
        code: "UNEXPECTED_TOKEN_TRANSFER",
        message: `${(-outflow.delta).toString()} of ${outflow.token} leaves the account`,
        detail: { token: outflow.token, amount: (-outflow.delta).toString() },
      });
    }

    // Approvals the simulation reveals but the plan never declared. The static
    // layer bounds declared approvals; this catches the undeclared ones.
    const declared = new Set(
      plan.approvals.map((a) => `${a.token}:${a.spender}`),
    );
    // An allowance inside Permit2 is never declared: a plan can only declare
    // ERC-20 approvals, which the static layer bounds to the amount sold,
    // and one for the same token and spender says nothing about this one.
    for (const granted of effects.approvals) {
      if (granted.owner !== intent.account) continue;
      if (granted.amount === 0n) continue; // revocations are always safe
      if (granted.via === "permit2" || !declared.has(`${granted.token}:${granted.spender}`)) {
        violations.push({
          code: "UNEXPECTED_APPROVAL",
          message:
            granted.via === "permit2"
              ? `an allowance inside Permit2 on ${granted.token} for ${granted.spender}, which could take it later without a signature`
              : `undeclared approval of ${granted.token} to ${granted.spender}`,
          detail: {
            token: granted.token,
            spender: granted.spender,
            amount: granted.amount.toString(),
            ...(granted.via === undefined ? {} : { via: granted.via }),
          },
        });
      }
    }

    return violations;
  }

  async #oracleCrossCheck(
    plan: TxPlan,
    logs: Parameters<typeof observeEffects>[0],
  ): Promise<GuardViolation[]> {
    const oracle = this.options.oracle;
    if (!oracle) return [];

    const { intent } = plan;
    const ratio = await oracle.priceRatio(intent.tokenIn, intent.tokenOut);
    // An unknown pair is not a red flag; plenty of real pairs have no feed.
    if (ratio === null) return [];

    const effects = observeEffects(logs);
    const received = deltaFor(effects, intent.tokenOut, intent.recipient);
    const spent = -deltaFor(effects, intent.tokenIn, intent.account);
    if (spent <= 0n || received <= 0n) return [];

    const executed = (received * 10n ** 18n) / spent;
    const diff = executed > ratio ? executed - ratio : ratio - executed;
    const divergenceBps = (diff * 10_000n) / ratio;

    if (divergenceBps > BigInt(this.options.oracleDivergenceBps)) {
      return [
        {
          code: "ORACLE_DIVERGENCE",
          // Worded to say what it actually measured. The executed price is
          // net of the pool fee and the trade's own price impact, while the
          // oracle reports a mid price — so a large trade through a 1% pool
          // diverges by design. Saying "differs by N bps" without that context
          // reads as an accusation and teaches people to dismiss the warning,
          // which is the last thing this check should do.
          message:
            `the price this swap executes at differs from the time-weighted ` +
            `market price by ${divergenceBps} bps. Pool fees and the size of this ` +
            `swap both count toward that, so a large swap in a high-fee pool ` +
            `diverges legitimately — but so does a manipulated one`,
          detail: {
            divergenceBps: divergenceBps.toString(),
            toleranceBps: String(this.options.oracleDivergenceBps),
            executedX18: executed.toString(),
            oracleX18: ratio.toString(),
          },
        },
      ];
    }
    return [];
  }
}


/**
 * Encode `approve(spender, amount)` for simulation.
 *
 * Hand-encoded: two static words, and pulling an ABI codec into the Guard to
 * write forty bytes would add a dependency to the most security-sensitive
 * package in the repo.
 */
function approvalCall(approval: { token: Address; spender: Address; amount: bigint }): Call {
  const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return {
    to: approval.token,
    data: `0x095ea7b3${word(approval.spender)}${word(approval.amount.toString(16))}` as `0x${string}`,
    value: 0n,
  };
}
