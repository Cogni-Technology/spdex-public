/**
 * Ethereum mainnet constants.
 *
 * Every address here was verified on-chain (code present, ERC-20 identity read
 * via symbol/name/decimals) rather than transcribed from memory or docs.
 * `packages/chain/test/integration/constants.test.ts` re-verifies them against
 * the pinned fork, so a typo cannot survive CI.
 */

import { toEventSelector } from "viem";
import type { Address } from "@spdex/core";

export const MAINNET_CHAIN_ID = 1;

export const CONTRACTS = {
  /** Same address on every chain. Batches the router's quote reads. */
  multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  /**
   * Uniswap v2's factory. The TWAP oracle checks each v3 pool's average
   * against the v2 pair this lists for the same two tokens.
   */
  uniV2Factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
  uniV3Factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  uniV3QuoterV2: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
  uniV3SwapRouter02: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  uniV4PoolManager: "0x000000000004444c5dc75cb358380d2e3de08a90",
  /** Quotes v4 pools. Verified on-chain; see docs/UNISWAP-V4.md. */
  uniV4Quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
  /** Reads v4 pool state (slot0, liquidity) by pool id. */
  uniV4StateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
} as const satisfies Record<string, Address>;

/**
 * Fee tier to tick spacing, as Uniswap v4 conventionally pairs them.
 *
 * v4 makes tick spacing part of the pool key rather than deriving it from the
 * fee, so a pool exists at (fee, spacing) rather than at (fee) alone. These are
 * the combinations actually in use for the pairs spDEX cares about — confirmed
 * by probing live pools at the pinned block.
 */
export const UNI_V4_TIER_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10_000: 200,
};

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export const TOKENS = {
  /**
   * SPX6900. Note decimals: 8, not 18.
   *
   * Verified on-chain — assuming 18 here would misprice every quote in the app
   * by ten orders of magnitude, and it is exactly the kind of thing that looks
   * right in review.
   */
  SPX: {
    address: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c",
    symbol: "SPX",
    decimals: 8,
  },
  WETH: {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    symbol: "WETH",
    decimals: 18,
  },
  USDC: {
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    decimals: 6,
  },
} as const satisfies Record<string, TokenInfo>;

/** A Chainlink price feed: the proxy contract, and the decimals its answers carry. */
export interface ChainlinkFeed {
  address: Address;
  decimals: number;
}

/**
 * Chainlink price feeds, each answering in US dollars per one unit of what
 * its key names ("EUR / USD" is dollars per euro).
 *
 * The app reads them through Multicall3, on the person's own network service,
 * for two things only: showing a figure in their currency, and turning an
 * amount they typed in a currency into a token amount they then see and sign.
 * The Guard never reads one. A proxy is upgradeable by its operator, so these
 * are a display and input trust, never a check (see oracle.ts).
 *
 * The sixteen currencies are every one with a feed on Ethereum that answered
 * at the pinned block. USDC is here for the note shown when it drifts from
 * $1, which dollar figures assume, and ETH for a trade's value at its block.
 * EUR is the `eur-usd` proxy, not the `-svr` one at 0xEbc15….
 *
 * Every entry was read at the pinned block (description, decimals and a
 * live answer), and `test/integration/constants.test.ts` reads them again.
 * The decimals are not all 8: PHP's feed answers with 18. They are checked
 * against what each feed reports in the same read, so a repointed proxy that
 * changed them makes the rate unknown instead of scaling every amount.
 */
export const CHAINLINK_FEEDS = {
  EUR: { address: "0xb49f677943bc038e9857d61e7d053caa2c1734c1", decimals: 8 },
  GBP: { address: "0x5c0ab2d9b5a7ed9f470386e82bb36a3613cdd4b5", decimals: 8 },
  JPY: { address: "0xbce206cae7f0ec07b545edde332a47c2f75bbeb3", decimals: 8 },
  KRW: { address: "0x01435677fb11763550905594a16b645847c1d0f3", decimals: 8 },
  CNY: { address: "0xef8a4af35cd47424672e3c590abd37fbb7a7759a", decimals: 8 },
  CHF: { address: "0x449d117117838ffa61263b61da6301aa2a88b13a", decimals: 8 },
  CAD: { address: "0xa34317db73e77d453b1b8d04550c44d10e981c8e", decimals: 8 },
  AUD: { address: "0x77f9710e7d0a19669a13c055f62cd80d313df022", decimals: 8 },
  SGD: { address: "0xe25277ff4bbf9081c75ab0eb13b4a13a721f3e13", decimals: 8 },
  NZD: { address: "0x3977cfc9e4f29c184d4675f4eb8e0013236e5f3e", decimals: 8 },
  BRL: { address: "0x3126e7f38d5f60f4e2b6ec3511c7bdbd79317df1", decimals: 8 },
  MXN: { address: "0xdb4881ab0ad6b8423f76dd8c9d65542749a1db77", decimals: 8 },
  TRY: { address: "0xb09fc5fd3f11cf9eb5e1c5dba43114e3c9f477b5", decimals: 8 },
  IDR: { address: "0x91b99c9b75af469a71ee1ab528e8da994a5d7030", decimals: 8 },
  ARS: { address: "0xe41cd2dcc63eb63a9d9e62f2a3d9b49e6d0c0a1d", decimals: 8 },
  PHP: { address: "0x3c7db4d25deab7c89660512c5494dc9a3fc40f78", decimals: 18 },
  USDC: { address: "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6", decimals: 8 },
  ETH: { address: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", decimals: 8 },
} as const satisfies Record<string, ChainlinkFeed>;

/** Fee tiers Uniswap v3 pools can be deployed at, in hundredths of a bip. */
export const UNI_V3_FEE_TIERS = [100, 500, 3000, 10_000] as const;
export type UniV3FeeTier = (typeof UNI_V3_FEE_TIERS)[number];

/**
 * Event topics, derived at load rather than pasted.
 *
 * A mistyped topic would silently match nothing, so the Guard would observe no
 * transfers and conclude a draining transaction was clean. Deriving them from
 * the signature makes that failure mode impossible.
 */
export const TOPICS = {
  transfer: toEventSelector("Transfer(address,address,uint256)"),
  approval: toEventSelector("Approval(address,address,uint256)"),
  /**
   * The two Swap events spDEX knows how to read.
   *
   * Distinct signatures, so one `eth_getLogs` filtered on both topics covers
   * v2 pairs and v3 pools together. v2 reports four unsigned amounts (in and
   * out, per side); v3 reports two signed ones, negative meaning leaving the
   * pool. Both are decoded in `logs.ts`.
   */
  uniV2Swap: toEventSelector("Swap(address,uint256,uint256,uint256,uint256,address)"),
  uniV3Swap: toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  /**
   * Permit2's own allowances, which live inside Permit2 rather than in the
   * token. `approve` logs the first; `permit`, which sets one from a
   * signature, logs the second. Both index the owner, the token and the
   * spender, in that order, and begin their data with the amount.
   *
   * Neither is an ERC-20 `Approval`, so a Guard that read only that event
   * would not see a transaction leave one of these behind: an allowance
   * that lets its spender take the owner's tokens through Permit2 later,
   * with no signature, for as long as Permit2 holds the ERC-20 permission.
   */
  permit2Approval: toEventSelector("Approval(address,address,address,uint160,uint48)"),
  permit2Permit: toEventSelector("Permit(address,address,address,uint160,uint48,uint48)"),
} as const;

/** The zero address, used to detect mint/burn in Transfer logs. */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * Native ETH's pseudo-address.
 *
 * Not merely a convention here: `eth_simulateV1` with `traceTransfers` reports
 * native value movement as an ordinary ERC-20 `Transfer` log emitted by *this*
 * address. That was verified against a live node rather than assumed — the
 * shape is what the Guard would need to account for native balances, and
 * `packages/chain/test/integration/constants.test.ts` pins it so a provider
 * that reported it differently would fail CI rather than silently produce
 * unchecked swaps.
 */
export const NATIVE_TOKEN: Address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * Uniswap v4 denotes native ETH as the zero address in a pool key.
 *
 * Deliberately distinct from NATIVE_TOKEN above: one is how a *simulation
 * result* labels native value, the other is how a *pool key* does. Conflating
 * them is an easy and expensive mistake.
 */
export const UNI_V4_NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** True for spDEX's canonical native-asset marker. */
export function isNativeToken(address: string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN;
}
