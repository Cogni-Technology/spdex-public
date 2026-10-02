/**
 * Tracker modules — what a pool is, as opposed to what it will quote.
 *
 * A venue answers "what do I get for this trade". A tracker answers "what is
 * this pool" — how much is in it, what it charges, how busy it is. Different
 * question, different module kind, and a different set of things that can go
 * wrong: a tracker that lies costs the user a bad decision rather than a bad
 * transaction, so it is never in the path of a signature.
 *
 * ## The capability puzzle, and why it has a clean answer
 *
 * Reading a pool's reserves looks impossible under the capability model. A
 * module may only call contracts its manifest declares, and a pool's
 * address is not known until a factory returns it — which is exactly why
 * `WirePoolRef.depth` is a venue-defined proxy rather than a real liquidity
 * figure.
 *
 * But the broker checks a call's *target*, not its arguments. `balanceOf` is a
 * call to the **token**, whose address is fixed and perfectly declarable, and
 * the pool is merely a parameter. So a tracker that declares the tokens it
 * cares about can read the true balance held by any pool, without a single
 * dynamic address being allowlisted and without widening the broker by a line.
 *
 * The cost is the honest one: a tracker knows only about tokens its manifest
 * names. A pool holding something it did not declare comes back `supported:
 * false` rather than with a fabricated number, and the UI says so.
 *
 * ## What a tracker cannot do
 *
 * Volume. It needs event logs, and `eth_getLogs` is not a module capability —
 * deliberately, since a log filter is a far larger surface than a batched
 * `eth_call`. Volume is therefore computed host-side and attached afterwards,
 * which also keeps the module's output deterministic: the same pools at the
 * same block produce the same bytes, which is what the conformance suite
 * requires and what makes the parity gate meaningful.
 */

import { z } from "zod";
import { WirePoolRefSchema } from "./venue.js";

const AmountSchema = z.string().regex(/^\d+$/, "decimal string");
const AddressLikeSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const WirePoolStatsSchema = z.object({
  poolId: z.string().min(1),
  /**
   * False when the tracker could not read one of the pool's tokens — normally
   * because its manifest does not declare it. Reported rather than guessed:
   * a zero that means "unknown" is indistinguishable from a zero that means
   * "empty", and one of those is a reason not to trade.
   */
  supported: z.boolean(),
  token0: AddressLikeSchema,
  token1: AddressLikeSchema,
  /** Raw balance of token0 held by the pool. Zero when unsupported. */
  balance0: AmountSchema,
  balance1: AmountSchema,
  /** The venue's fee, in hundredths of a bip, carried through for display. */
  fee: z.number().int().nonnegative(),
});
export type WirePoolStats = z.infer<typeof WirePoolStatsSchema>;

export const WirePoolScanRequestSchema = z.array(WirePoolRefSchema);

/**
 * The tracker interface.
 *
 * One method, batch-shaped like everything else crossing this boundary: a pair
 * can have half a dozen pools and each needs two reads, so asking one at a time
 * would turn a single round trip into twelve.
 */
export interface TrackerModule {
  readonly apiVersion: string;
  scanPools(pools: unknown[], ctx: unknown): Promise<WirePoolStats[]>;
}
