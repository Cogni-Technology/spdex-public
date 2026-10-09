/**
 * The module interface — one contract, implemented by first- and third-party
 * modules alike, executed by both runtimes.
 *
 * ## Everything crosses as a wire type
 *
 * Values here use decimal strings rather than bigint, and plain JSON-safe
 * shapes throughout. That is not a concession to QuickJS: it is what makes the
 * parity gate mean anything. If the native runtime passed rich JS values while
 * the sandbox marshalled through JSON, the two would be running genuinely
 * different code and "identical output" would prove nothing. Both runtimes
 * encode through *this* format, so a module cannot behave differently depending
 * on where it runs.
 *
 * ## Modules do not author intent
 *
 * A module returns the approvals and calls it wants, plus what it claims the
 * user will receive. It never constructs the SwapIntent — the host attaches the
 * intent it showed the user. A module therefore cannot propose a plan whose
 * promise differs from the one on screen; that whole class of attack is closed
 * by construction rather than by a check.
 */

import { z } from "zod";

/** Decimal, unsigned. bigint does not survive the sandbox boundary. */
const AmountSchema = z.string().regex(/^\d+$/, "decimal string");
const AddressLikeSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const HexLikeSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const WireTokenPairSchema = z.object({
  tokenA: AddressLikeSchema,
  tokenB: AddressLikeSchema,
});
export type WireTokenPair = z.infer<typeof WireTokenPairSchema>;

export const WirePoolRefSchema = z.object({
  /** Stable across machines so it can live in an exported config. */
  poolId: z.string().min(1),
  token0: AddressLikeSchema,
  token1: AddressLikeSchema,
  /** Hundredths of a bip, where the venue has tiers. */
  fee: z.number().int().nonnegative(),
  /**
   * A venue-defined depth proxy: larger means deeper, comparable only within a
   * venue. Display and ordering only — never trusted for routing, which uses
   * real quotes.
   *
   * Deliberately not "liquidity". Reading a pool's liquidity() means reading a
   * contract whose address is only known at runtime, which a manifest
   * cannot allowlist in advance. Letting each venue derive depth from sources
   * it already declares keeps the rule absolute: a module never reads an
   * address it did not obtain from an allowlisted contract.
   */
  depth: AmountSchema,
  label: z.string().max(64).optional(),
});
export type WirePoolRef = z.infer<typeof WirePoolRefSchema>;

export const WireQuoteRequestSchema = z.object({
  tokenIn: AddressLikeSchema,
  tokenOut: AddressLikeSchema,
  amountIn: AmountSchema,
});
export type WireQuoteRequest = z.infer<typeof WireQuoteRequestSchema>;

export const WireVenueQuoteSchema = z.object({
  poolId: z.string().min(1),
  /** Carried on the quote so a build cannot drift from what was priced. */
  tokenIn: AddressLikeSchema,
  tokenOut: AddressLikeSchema,
  amountIn: AmountSchema,
  amountOut: AmountSchema,
  gasEstimate: AmountSchema,
  /**
   * Opaque venue-private scratch space, round-tripped unchanged by the host.
   *
   * Lets a venue carry whatever a build needs — a fee tier, a pool key — without
   * the core schema growing a field per venue. Safe precisely because it is
   * never interpreted: the host treats it as bytes, and the plan it helps
   * produce is still simulated and checked against the user's intent like any
   * other. A module lying here can only mislead itself.
   */
  venueData: z.string().max(256).optional(),
});
export type WireVenueQuote = z.infer<typeof WireVenueQuoteSchema>;

/**
 * What a module returns from buildCalls.
 *
 * Note the absence of an intent: the host supplies that. The module describes
 * mechanism only.
 */
export const WireBuildResultSchema = z.object({
  approvals: z.array(
    z.object({
      token: AddressLikeSchema,
      spender: AddressLikeSchema,
      amount: AmountSchema,
    }),
  ),
  calls: z.array(
    z.object({
      to: AddressLikeSchema,
      data: HexLikeSchema,
      value: AmountSchema,
    }),
  ),
  quotedAmountOut: AmountSchema,
  gasEstimate: AmountSchema,
  poolIds: z.array(z.string()),
});
export type WireBuildResult = z.infer<typeof WireBuildResultSchema>;

/**
 * The bounds the host imposes on a build, taken from the intent it showed the
 * user.
 *
 * A venue router needs a recipient and a minimum output to encode a swap, but a
 * module must never choose them — that is precisely the value being protected.
 * So the host passes them down and the module only encodes what it is given.
 * It still cannot lie: the Guard checks the resulting calls against the same
 * intent these came from.
 */
export const WireBuildParamsSchema = z.object({
  recipient: AddressLikeSchema,
  minAmountOut: AmountSchema,
  deadline: AmountSchema,
  /**
   * Sell native ETH, or receive it, rather than its wrapped form.
   *
   * The pool is the same either way — v2 and v3 pools are always ERC-20 pairs,
   * and every "ETH" pool in them is really WETH. These flags select the
   * router's wrapping entry points, so the wrap happens inside the swap rather
   * than as a transaction of its own.
   *
   * Additive and optional, so a module written before they existed still
   * loads. Such a module ignores them and builds the wrapped path, which then
   * *fails the Guard* — the intent says native, the simulation shows WETH
   * moving, and `MIN_OUT_NOT_MET` fires. Silently wrong is the one outcome
   * that was not acceptable here, so the fallback is loudly wrong instead.
   */
  nativeIn: z.boolean().optional(),
  nativeOut: z.boolean().optional(),
});
export type WireBuildParams = z.infer<typeof WireBuildParamsSchema>;

/** A single chain read a module asks the host to perform on its behalf. */
export const WireChainCallSchema = z.object({
  to: AddressLikeSchema,
  data: HexLikeSchema,
});
export type WireChainCall = z.infer<typeof WireChainCallSchema>;

/**
 * The capability surface a module sees. Nothing else is reachable.
 *
 * `multicall` is the only primitive that crosses the boundary, and it is
 * batch-shaped on purpose. Split routing quotes roughly pools x chunks per
 * keystroke; as individual crossings that is the bottleneck, so a module asks
 * for everything it needs at once and the host answers in one round-trip.
 * `call` exists as sugar and is implemented in terms of it.
 *
 * Absent by design: fetch, storage, the signer, the DOM, a clock, randomness.
 * The last two are omitted for determinism as much as for privacy — identical
 * inputs must produce byte-identical output, and the conformance suite checks it.
 */
export interface VenueContext {
  multicall(calls: WireChainCall[]): Promise<string[]>;
  call(call: WireChainCall): Promise<string>;
  log(message: string): void;
}

export interface VenueModule {
  /** Semver. The host declares a supported range and refuses anything outside it. */
  readonly apiVersion: string;
  discoverPools(pair: WireTokenPair, ctx: VenueContext): Promise<WirePoolRef[]>;
  quoteBatch(
    requests: WireQuoteRequest[],
    pools: WirePoolRef[],
    ctx: VenueContext,
  ): Promise<WireVenueQuote[]>;
  buildCalls(
    quote: WireVenueQuote,
    params: WireBuildParams,
    ctx: VenueContext,
  ): Promise<WireBuildResult>;
}

/** Host API version. Bump the minor for additive capabilities; never break shape. */
export const HOST_API_VERSION = "1.0.0";

/** Parse `major.minor.patch`; a module loads when its major matches the host's. */
export function isApiVersionCompatible(moduleApiVersion: string, hostVersion: string): boolean {
  const moduleMajor = moduleApiVersion.split(".")[0];
  const hostMajor = hostVersion.split(".")[0];
  return moduleMajor !== undefined && moduleMajor === hostMajor;
}
