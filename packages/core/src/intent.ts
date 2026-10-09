/**
 * A swap intent is the promise the user is shown, expressed as data.
 *
 * Everything downstream exists to enforce it. The module proposes calls; the
 * Guard's job is to prove those calls satisfy *this* object and nothing more.
 * Splitting "what was promised" from "how it is achieved" is what lets an
 * untrusted module build the transaction — the mechanism is theirs, the
 * guarantee is ours.
 *
 * It is also deliberately signable. v0 never signs one, but automation (a
 * keeper executing a scheduled buy while the user is away) needs exactly this
 * shape: a bounded, expiring, replay-resistant statement of intent. Designing
 * it as a serialisable value now costs nothing and keeps that door open.
 */

import { z } from "zod";
import {
  AddressSchema,
  BigIntSchema,
  ChainIdSchema,
  HexSchema,
  type Address,
  type Hex,
} from "./primitives.js";

export const SwapIntentSchema = z.object({
  version: z.literal(1),
  chainId: ChainIdSchema,

  /** Whose balances the Guard asserts against, and who signs. */
  account: AddressSchema,
  /** Where tokenOut must land. Usually `account`; never silently anything else. */
  recipient: AddressSchema,

  tokenIn: AddressSchema,
  tokenOut: AddressSchema,

  /** Upper bound on what may leave the account. */
  maxAmountIn: BigIntSchema,
  /** Lower bound on what must arrive. The invariant everything protects. */
  minAmountOut: BigIntSchema,

  /** Unix seconds. Supplied by the host — modules have no clock. */
  deadline: BigIntSchema,
  /** Replay resistance for signed intents. Host-generated; modules have no randomness. */
  nonce: HexSchema,
});

export type SwapIntent = z.infer<typeof SwapIntentSchema>;

/** A raw call the host will submit on the user's behalf. */
export const CallSchema = z.object({
  to: AddressSchema,
  data: HexSchema,
  value: BigIntSchema,
});
export type Call = z.infer<typeof CallSchema>;

/**
 * An ERC-20 approval a plan requires.
 *
 * Declared separately from `calls` rather than buried among them so the Guard
 * and the UI can reason about "what am I authorising, and to whom" without
 * decoding calldata to find out. Unlimited approvals are representable but the
 * Guard bounds them against the intent.
 */
export const ApprovalRequestSchema = z.object({
  token: AddressSchema,
  spender: AddressSchema,
  amount: BigIntSchema,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const TxPlanMetaSchema = z.object({
  /** Module that produced this plan. */
  venueId: z.string().min(1),
  /** Pools the route touches, in execution order. */
  poolIds: z.array(z.string()),
  /** What the module claims the user will receive. The Guard verifies it. */
  quotedAmountOut: BigIntSchema,
  /** Module's gas estimate, used by the router's split economics. */
  gasEstimate: BigIntSchema,
});
export type TxPlanMeta = z.infer<typeof TxPlanMetaSchema>;

export const TxPlanSchema = z.object({
  version: z.literal(1),
  intent: SwapIntentSchema,
  approvals: z.array(ApprovalRequestSchema),
  calls: z.array(CallSchema),
  meta: TxPlanMetaSchema,
});

export type TxPlan = z.infer<typeof TxPlanSchema>;

export type { Address, Hex };
