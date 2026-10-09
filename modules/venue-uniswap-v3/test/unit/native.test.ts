/**
 * The v3 router's ETH paths, byte for byte against viem.
 *
 * The multicall encoding is the reason this file exists. It is a dynamic array
 * of dynamic byte strings written by hand in a sandbox with no ABI library,
 * and its failure mode is not a revert — an offset wrong by one word decodes
 * into a different, valid-looking call. Nothing about that is visible by
 * reading the hex.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import venueModule from "../../index.mjs";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[])",
]);

const AMOUNT_IN = 10n ** 18n;
const MIN_OUT = 4_900_00000000n;
const FEE = 3000;

const quote = (tokenIn: string, tokenOut: string) => ({
  poolId: "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3",
  tokenIn,
  tokenOut,
  amountIn: AMOUNT_IN.toString(),
  amountOut: "500000000000",
  gasEstimate: "180000",
  venueData: String(FEE),
});

const build = (tokenIn: string, tokenOut: string, over: Record<string, unknown> = {}) =>
  (venueModule as { buildCalls: (q: unknown, p: unknown, c: unknown) => Promise<{
    approvals: unknown[];
    calls: { to: string; data: string; value: string }[];
  }> }).buildCalls(
    quote(tokenIn, tokenOut),
    { recipient: USER, minAmountOut: MIN_OUT.toString(), deadline: "1800000000", ...over },
    { multicall: async () => [] },
  );

const singleParams = (tokenIn: string, tokenOut: string, recipient: string) => ({
  tokenIn: tokenIn as `0x${string}`,
  tokenOut: tokenOut as `0x${string}`,
  fee: FEE,
  recipient: recipient as `0x${string}`,
  amountIn: AMOUNT_IN,
  amountOutMinimum: MIN_OUT,
  sqrtPriceLimitX96: 0n,
});

describe("selling native ETH", () => {
  it("uses identical calldata to the wrapped path, and pays with value", async () => {
    // Not an oversight that there is no ETH-specific encoding: SwapRouter02
    // wraps its own balance when the input token is WETH. The only difference
    // a caller makes is attaching the value.
    const native = await build(WETH, SPX, { nativeIn: true });
    const wrapped = await build(WETH, SPX);
    expect(native.calls[0]!.data).toBe(wrapped.calls[0]!.data);
    expect(native.calls[0]!.value).toBe(AMOUNT_IN.toString());
    expect(wrapped.calls[0]!.value).toBe("0");
  });

  it("matches viem, and asks for no approval", async () => {
    const result = await build(WETH, SPX, { nativeIn: true });
    expect(result.calls[0]!.data.toLowerCase()).toBe(
      encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [singleParams(WETH, SPX, USER)] }).toLowerCase(),
    );
    expect(result.approvals).toEqual([]);
  });
});

describe("receiving native ETH", () => {
  it("encodes multicall(swap -> router, unwrap -> user) exactly as viem does", async () => {
    const result = await build(SPX, WETH, { nativeOut: true });

    const swapCall = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [singleParams(SPX, WETH, ADDRESS_THIS)],
    });
    const unwrapCall = encodeFunctionData({
      abi: routerAbi,
      functionName: "unwrapWETH9",
      args: [MIN_OUT, USER],
    });
    const expected = encodeFunctionData({
      abi: routerAbi,
      functionName: "multicall",
      args: [[swapCall, unwrapCall]],
    });

    expect(result.calls[0]!.data.toLowerCase()).toBe(expected.toLowerCase());
  });

  it("sends the swap output to the router, not to the user", async () => {
    // The user must not be paid in WETH when they asked for ether, and the
    // sentinel is what keeps the proceeds in place for the unwrap.
    const result = await build(SPX, WETH, { nativeOut: true });
    expect(result.calls[0]!.data.toLowerCase()).toContain(ADDRESS_THIS.slice(2).toLowerCase());
    expect(result.calls[0]!.value).toBe("0");
  });

  it("repeats the minimum on the unwrap", async () => {
    // Checked twice rather than assumed to have held between the two calls.
    const result = await build(SPX, WETH, { nativeOut: true });
    const unwrap = encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [MIN_OUT, USER] });
    expect(result.calls[0]!.data.toLowerCase()).toContain(unwrap.slice(2).toLowerCase());
  });

  it("still needs an allowance for the token being sold", async () => {
    const result = await build(SPX, WETH, { nativeOut: true });
    expect(result.approvals).toHaveLength(1);
  });
});

describe("the wrapped path is unchanged", () => {
  it("is a single exactInputSingle with no value", async () => {
    const result = await build(SPX, WETH);
    expect(result.calls[0]!.data.toLowerCase()).toBe(
      encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [singleParams(SPX, WETH, USER)] }).toLowerCase(),
    );
    expect(result.calls[0]!.value).toBe("0");
  });
});
