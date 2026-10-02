/**
 * Guard verdicts — the vocabulary of refusal.
 *
 * Every rejection names a specific violated invariant. "Transaction looks
 * unsafe" is useless to a user deciding whether to sign and useless to an
 * agent deciding whether a test regressed; `MIN_OUT_NOT_MET, expected
 * 1000000, simulated 412` is actionable for both.
 */

export const GUARD_VIOLATIONS = [
  // ── Static layer ──
  /** A call targets a contract the module never declared in its manifest. */
  "UNDECLARED_TARGET",
  /** tokenOut would land somewhere other than the intent's recipient. */
  "RECIPIENT_MISMATCH",
  /** An approval names a spender the module never declared. */
  "APPROVAL_UNDECLARED_SPENDER",
  /** An approval exceeds the intent's maxAmountIn. */
  "APPROVAL_EXCEEDS_INTENT",
  /** The plan's intent is not the one the user was shown. */
  "INTENT_MISMATCH",
  /** The plan targets a different chain than the intent. */
  "CHAIN_MISMATCH",
  /** The intent has already expired. */
  "DEADLINE_EXPIRED",
  /** Calldata could not be decoded well enough to reason about. */
  "UNDECODABLE_CALLDATA",
  /**
   * A swap calls Permit2, or approves it as a spender. Permit2 keeps
   * allowances of its own, which outlive the swap and which the swap Guard
   * does not bound, so a swap may not reach them, whoever declared or
   * trusted Permit2.
   */
  "PERMIT2_TARGET",

  // ── Simulation layer ──
  /** Simulated output is below the promised minimum. The core invariant. */
  "MIN_OUT_NOT_MET",
  /** Simulation spends more of tokenIn than the intent allows. */
  "MAX_IN_EXCEEDED",
  /** Some token other than tokenIn leaves the account. */
  "UNEXPECTED_TOKEN_TRANSFER",
  /** More ETH leaves than the plan's calls declared. */
  "UNEXPECTED_ETH_TRANSFER",
  /** Simulation grants an approval to a spender the plan never declared. */
  "UNEXPECTED_APPROVAL",
  /** The transaction reverts. */
  "SIMULATION_REVERTED",
  /** The endpoint cannot simulate, and config demands that it must. */
  "SIMULATION_UNAVAILABLE",
  /** Effects were observed that could not be decoded, so cannot be judged. */
  "UNDECODABLE_EFFECTS",

  // ── Oracle layer ──
  /** Execution price diverges from an independent feed beyond tolerance. */
  "ORACLE_DIVERGENCE",

  // ── Tip splits ──
  /** Tips total more than the host's hard ceiling, or more than configured. */
  "TIP_EXCEEDS_LIMIT",
  /** A tip call is not the plain ERC-20 transfer its intent describes. */
  "TIP_MALFORMED",
  /** Simulation shows a declared recipient receiving less than promised. */
  "TIP_NOT_DELIVERED",

  // ── Scheduled buys ──
  /**
   * A scheduled buy is not the plan the user wrote: another pair, chain,
   * signer or recipient, no price floor, or a plan that is paused.
   */
  "SCHEDULE_MISMATCH",
  /** A scheduled buy spends more than one buy's amount, summed across legs. */
  "SCHEDULE_EXCEEDS_BUY",
  /**
   * A scheduled buy would take its plan past the total budget or the number of
   * buys — or the record of what the plan has spent is unknown, which is
   * treated as exhausted rather than as zero.
   */
  "SCHEDULE_EXCEEDS_BUDGET",
  /** A scheduled buy is not due: too early, or its window already had one. */
  "SCHEDULE_NOT_DUE",

  // ── Vaults ──
  /**
   * A vault transaction is not the one its intent describes: another target,
   * calldata, value, chain or plan; a vault the factory did not make for this
   * account on these terms; a creation with a buy fee above the app's
   * ceiling; or, in simulation, a vault created for someone else, on other
   * terms, somewhere else, or a buy credited to another caller.
   */
  "VAULT_MALFORMED",
  /**
   * Simulation shows a vault transaction falling short: the vault not holding
   * what was paid in, the owner receiving less than the buy's floor or less
   * than a closing vault held, or the caller less than its reward.
   */
  "VAULT_NOT_DELIVERED",
  /**
   * A batch of vault buys would pay its caller WETH that someone sent the
   * batcher (`Batch.swept` above zero). Nobody can say whose it is, so the
   * caller is never made its receiver. `detail.swept` is the amount, in wei.
   */
  "VAULT_BATCH_UNACCOUNTED",

  // ── Second opinion ──
  /**
   * The user's two network services disagree: their test-runs of the same
   * request at the same block differ, or they could not be brought to the
   * same block (heads more than 3 apart, or different hashes at one height,
   * each after a retry). A violation. `detail.host` names the second
   * service's host and `detail.reason` is `result`, `heads` or `block-hash`.
   */
  "SECOND_OPINION_DISAGREES",
  /**
   * The second service failed to answer (an error or a timeout), so the plan
   * was checked on the main service only. A warning that turns `verified`
   * into `unverified`; a refusal wherever a path never signs unchecked. Only
   * the second service's own failure produces it, never anything the main
   * service reports. `detail.host` names the second service's host.
   */
  "SECOND_OPINION_UNAVAILABLE",
] as const;

export type GuardViolationCode = (typeof GUARD_VIOLATIONS)[number];

export interface GuardViolation {
  code: GuardViolationCode;
  message: string;
  /** Machine-readable specifics — expected vs actual, offending address, etc. */
  detail?: Record<string, string>;
}

/**
 * Verdict levels.
 *
 * `unverified` is deliberately distinct from `verified`. When the RPC cannot
 * simulate, the static layer alone passed — a real but much weaker statement.
 * Collapsing the two would let a downgraded RPC silently weaken the security
 * model, which is precisely the failure the UNVERIFIED banner exists to
 * prevent. The Guard never decides on the user's behalf whether that is
 * acceptable; it reports honestly and the UI makes it impossible to miss.
 */
export type GuardLevel = "verified" | "unverified" | "rejected";

export interface GuardVerdict {
  level: GuardLevel;
  /** True only for `verified` and `unverified`; never for `rejected`. */
  signable: boolean;
  violations: GuardViolation[];
  /** Non-blocking notes — e.g. simulation unavailable, high price impact. */
  warnings: GuardViolation[];
}

export function rejected(violations: GuardViolation[]): GuardVerdict {
  return { level: "rejected", signable: false, violations, warnings: [] };
}

export function verified(warnings: GuardViolation[] = []): GuardVerdict {
  return { level: "verified", signable: true, violations: [], warnings };
}

export function unverified(warnings: GuardViolation[]): GuardVerdict {
  return { level: "unverified", signable: true, violations: [], warnings };
}
