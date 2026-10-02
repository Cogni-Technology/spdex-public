/**
 * Canonical fixtures: a well-formed swap, and the cast of addresses attacks
 * are staged against.
 *
 * Every red-team case starts from `honestPlan()` and changes exactly one thing,
 * so a test's diff from honest *is* the attack. That keeps each case readable
 * and stops a test passing for an unrelated reason.
 */

import { TOKENS, CONTRACTS, NATIVE_TOKEN } from "@spdex/chain";
import type {
  Address,
  ModuleManifest,
  SwapIntent,
  TxPlan,
} from "@spdex/core";

export const USER: Address = "0x1111111111111111111111111111111111111111";
export const ATTACKER: Address = "0x6666666666666666666666666666666666666666";
/**
 * A second address the user controls — e.g. a cold wallet they direct proceeds to.
 *
 * Exists so tests can distinguish `account` from `recipient`. With them always
 * equal, a Guard that measured the output delta at the wrong one would pass every
 * test while being exploitable; mutation testing caught exactly that.
 */
export const COLD_WALLET: Address = "0x2222222222222222222222222222222222222222";
export const ROUTER: Address = CONTRACTS.uniV3SwapRouter02;

export const SPX = TOKENS.SPX.address;
/**
 * The native asset, as both an intent token and a simulation log emitter.
 *
 * Deliberately the same address in both roles: `eth_simulateV1` reports native
 * movement as a Transfer from this address, so one decoder and one delta map
 * cover ETH and ERC-20s alike.
 */
export const NATIVE = NATIVE_TOKEN;
export const WETH = TOKENS.WETH.address;
export const USDC = TOKENS.USDC.address;

/** 100 SPX, at SPX's real 8 decimals. */
export const AMOUNT_IN = 100_00000000n;
/** The floor the user is promised. */
export const MIN_OUT = 1_000_000_000_000_000n;
/** What an honest route actually returns — comfortably above the floor. */
export const HONEST_OUT = 1_200_000_000_000_000n;

export const NOW = 1_790_000_000n;

export function honestIntent(overrides: Partial<SwapIntent> = {}): SwapIntent {
  return {
    version: 1,
    chainId: 1,
    account: USER,
    recipient: USER,
    tokenIn: SPX,
    tokenOut: WETH,
    maxAmountIn: AMOUNT_IN,
    minAmountOut: MIN_OUT,
    deadline: NOW + 600n,
    nonce: "0xcafebabe",
    ...overrides,
  };
}

export function honestManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: "venue-uniswap-v3",
    version: "1.0.0",
    apiVersion: "1.0.0",
    kind: "venue",
    displayName: "Uniswap v3",
    description: "Routes through Uniswap v3 pools.",
    capabilities: ["chain:read"],
    contracts: [SPX, WETH, ROUTER, CONTRACTS.uniV3QuoterV2, CONTRACTS.multicall3],
    limits: { maxFuel: 1_000_000n, maxMemory: 16_777_216n, maxCallsPerQuote: 64 },
    sha256: "a".repeat(64),
    publicKey: "0xabcd",
    signature: "0x1234",
    ...overrides,
  };
}

/** 1 ETH in, at 18 decimals. */
export const NATIVE_AMOUNT_IN = 10n ** 18n;
/** What an honest ETH -> SPX route returns, in SPX's real 8 decimals. */
export const NATIVE_HONEST_OUT = 5000_00000000n;
export const NATIVE_MIN_OUT = 4900_00000000n;

/** An intent that sells native ETH rather than an ERC-20. */
export function nativeIntent(overrides: Partial<SwapIntent> = {}): SwapIntent {
  return honestIntent({
    tokenIn: NATIVE,
    tokenOut: SPX,
    maxAmountIn: NATIVE_AMOUNT_IN,
    minAmountOut: NATIVE_MIN_OUT,
    ...overrides,
  });
}

/**
 * A plan selling native ETH.
 *
 * Note what differs from `honestPlan`: value on the call rather than an
 * approval. Native assets have no allowance mechanism, so an approval here
 * would be authorising something other than the swap.
 */
export function nativePlan(overrides: Partial<TxPlan> = {}): TxPlan {
  const intent = overrides.intent ?? nativeIntent();
  return {
    version: 1,
    intent,
    approvals: [],
    calls: [{ to: ROUTER, data: "0xdeadbeef", value: NATIVE_AMOUNT_IN }],
    meta: {
      venueId: "venue-uniswap-v3",
      poolIds: ["0xpool"],
      quotedAmountOut: NATIVE_HONEST_OUT,
      gasEstimate: 150_000n,
    },
    ...overrides,
  };
}

export function honestPlan(overrides: Partial<TxPlan> = {}): TxPlan {
  const intent = overrides.intent ?? honestIntent();
  return {
    version: 1,
    intent,
    approvals: [{ token: SPX, spender: ROUTER, amount: AMOUNT_IN }],
    calls: [{ to: ROUTER, data: "0xdeadbeef", value: 0n }],
    meta: {
      venueId: "venue-uniswap-v3",
      poolIds: ["0xpool"],
      quotedAmountOut: HONEST_OUT,
      gasEstimate: 150_000n,
    },
    ...overrides,
  };
}
