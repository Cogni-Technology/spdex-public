/**
 * The v2 router's ETH entry points, byte for byte.
 *
 * Hand-encoded calldata is the one place in a module where being wrong
 * produces a transaction that succeeds at doing the wrong thing, so every
 * encoding here is compared against viem rather than eyeballed. The shapes
 * differ in a way that is easy to get subtly wrong: dropping the `amountIn`
 * word for the payable form shifts the array offset from 160 to 128, and an
 * offset that is wrong by one word decodes into a plausible-looking path.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import venueModule from "../../index.mjs";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const routerAbi = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);

const AMOUNT_IN = 10n ** 18n;
const MIN_OUT = 4_900_00000000n;
const DEADLINE = 1_800_000_000n;

const quote = (tokenIn: string, tokenOut: string) => ({
  poolId: "0x52c77b0cb827afbad022e6d6caf2c44452edbc39",
  tokenIn,
  tokenOut,
  amountIn: AMOUNT_IN.toString(),
  amountOut: "500000000000",
  gasEstimate: "150000",
});

const params = (over: Record<string, unknown> = {}) => ({
  recipient: USER,
  minAmountOut: MIN_OUT.toString(),
  deadline: DEADLINE.toString(),
  ...over,
});

const build = (tokenIn: string, tokenOut: string, over: Record<string, unknown> = {}) =>
  (venueModule as { buildCalls: (q: unknown, p: unknown, c: unknown) => Promise<{
    approvals: { token: string; spender: string; amount: string }[];
    calls: { to: string; data: string; value: string }[];
  }> }).buildCalls(quote(tokenIn, tokenOut), params(over), {});

describe("selling native ETH", () => {
  it("encodes swapExactETHForTokens exactly as viem does", async () => {
    const result = await build(WETH, SPX, { nativeIn: true });
    const expected = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactETHForTokens",
      args: [MIN_OUT, [WETH, SPX], USER, DEADLINE],
    });
    expect(result.calls[0]!.data.toLowerCase()).toBe(expected.toLowerCase());
    expect(result.calls[0]!.to.toLowerCase()).toBe(ROUTER);
  });

  it("carries the input as call value", async () => {
    const result = await build(WETH, SPX, { nativeIn: true });
    expect(result.calls[0]!.value).toBe(AMOUNT_IN.toString());
  });

  it("requests no approval, because nobody needs one to spend their own ether", async () => {
    // Also load-bearing in the Guard: a plan that both sells native ETH and
    // asks for a token allowance is rejected outright.
    const result = await build(WETH, SPX, { nativeIn: true });
    expect(result.approvals).toEqual([]);
  });
});

describe("receiving native ETH", () => {
  it("encodes swapExactTokensForETH exactly as viem does", async () => {
    const result = await build(SPX, WETH, { nativeOut: true });
    const expected = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForETH",
      args: [AMOUNT_IN, MIN_OUT, [SPX, WETH], USER, DEADLINE],
    });
    expect(result.calls[0]!.data.toLowerCase()).toBe(expected.toLowerCase());
  });

  it("still needs an allowance, and sends no value", async () => {
    const result = await build(SPX, WETH, { nativeOut: true });
    expect(result.calls[0]!.value).toBe("0");
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]!.token).toBe(SPX);
    expect(result.approvals[0]!.spender).toBe(ROUTER);
  });
});

describe("the wrapped path is unchanged", () => {
  it("still encodes swapExactTokensForTokens when no flag is set", async () => {
    // The regression that matters most: ETH support must not alter the path
    // every existing swap takes.
    const result = await build(SPX, WETH);
    const expected = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [AMOUNT_IN, MIN_OUT, [SPX, WETH], USER, DEADLINE],
    });
    expect(result.calls[0]!.data.toLowerCase()).toBe(expected.toLowerCase());
    expect(result.calls[0]!.value).toBe("0");
  });

  it("treats the flags as false when absent, not as undefined", async () => {
    const explicit = await build(SPX, WETH, { nativeIn: false, nativeOut: false });
    const implicit = await build(SPX, WETH);
    expect(explicit.calls[0]!.data).toBe(implicit.calls[0]!.data);
  });
});
