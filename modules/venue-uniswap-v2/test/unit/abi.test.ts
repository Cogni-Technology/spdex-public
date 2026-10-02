/**
 * The v2 module hand-encodes its calldata so it can run in the sandbox without
 * a bundler. Two of its three encodings contain a dynamic `address[]`, where a
 * wrong offset produces calldata that decodes to a *different swap* rather than
 * failing — so every encoding is compared byte-for-byte against viem.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import venueModule from "../../index.mjs";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const USER = "0x1111111111111111111111111111111111111111";
const PAIR = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";

const FACTORY_ABI = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

const ROUTER_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address[]" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "address" },
      { type: "uint256" },
    ],
    outputs: [{ type: "uint256[]" }],
  },
] as const;

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const addressWord = (a: string) => word(a.replace(/^0x/, ""));
const uintWord = (v: bigint) => word(v.toString(16));

/** `uint256[]` of length 2, as the Router returns it. */
const amountsOut = (a0: bigint, a1: bigint) =>
  "0x" + uintWord(32n) + uintWord(2n) + uintWord(a0) + uintWord(a1);

function recordingCtx(replies: (calls: { to: string; data: string }[]) => string[]) {
  const seen: { to: string; data: string }[][] = [];
  return {
    seen,
    ctx: {
      async multicall(calls: { to: string; data: string }[]) {
        seen.push(calls);
        return replies(calls);
      },
      async call(c: { to: string; data: string }) {
        return (await this.multicall([c]))[0]!;
      },
      log() {},
    },
  };
}

describe("selectors", () => {
  it("match their signatures", () => {
    expect(toFunctionSelector("getPair(address,address)")).toBe("0xe6a43905");
    expect(toFunctionSelector("getAmountsOut(uint256,address[])")).toBe("0xd06ca61f");
    expect(
      toFunctionSelector("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"),
    ).toBe("0x38ed1739");
  });
});

describe("discovery", () => {
  it("asks the factory for the sorted pair, exactly as viem would encode it", async () => {
    let round = 0;
    const { seen, ctx } = recordingCtx((calls) => {
      round += 1;
      return round === 1
        ? ["0x" + addressWord(PAIR)]
        : calls.map(() => amountsOut(1000000000000n, 4242n));
    });

    const pools = await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx);

    expect(seen[0]![0]!.to).toBe(FACTORY);
    expect(seen[0]![0]!.data).toBe(
      // WETH sorts before SPX.
      encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPair", args: [WETH, SPX] }),
    );
    expect(pools).toHaveLength(1);
    expect(pools[0]!.poolId).toBe(PAIR);
    expect(pools[0]!.depth).toBe("4242");
  });

  it("probes with getAmountsOut encoded exactly as viem would", async () => {
    let round = 0;
    const { seen, ctx } = recordingCtx((calls) => {
      round += 1;
      return round === 1
        ? ["0x" + addressWord(PAIR)]
        : calls.map(() => amountsOut(1000000000000n, 99n));
    });

    await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx);

    expect(seen[1]![0]!.to).toBe(ROUTER);
    expect(seen[1]![0]!.data).toBe(
      encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [1_000_000_000_000n, [SPX, WETH]],
      }),
    );
  });

  it("returns nothing when the pair was never created", async () => {
    const { ctx } = recordingCtx(() => ["0x" + word("0")]);
    expect(await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx)).toEqual([]);
  });

  it("returns nothing when the pair exists but cannot trade", async () => {
    // A pair with no reserves makes the Router revert, which arrives as "0x".
    let round = 0;
    const { ctx } = recordingCtx(() => {
      round += 1;
      return round === 1 ? ["0x" + addressWord(PAIR)] : ["0x"];
    });
    expect(await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx)).toEqual([]);
  });
});

describe("quoting", () => {
  it("returns one quote per requested size, carrying its tokens", async () => {
    const { ctx } = recordingCtx((calls) =>
      calls.map((_c, i) => amountsOut(10n ** 18n, BigInt(5000 + i))),
    );

    const quotes = await venueModule.quoteBatch(
      [
        { tokenIn: WETH, tokenOut: SPX, amountIn: (10n ** 18n).toString() },
        { tokenIn: WETH, tokenOut: SPX, amountIn: (2n * 10n ** 18n).toString() },
      ],
      [{ poolId: PAIR, token0: WETH, token1: SPX, fee: 3000, depth: "1" }],
      ctx,
    );

    expect(quotes).toHaveLength(2);
    expect(quotes[0]!.tokenIn).toBe(WETH);
    expect(quotes[0]!.amountOut).toBe("5000");
    expect(quotes[1]!.amountOut).toBe("5001");
  });

  it("skips a size the pair cannot quote rather than reporting zero", async () => {
    const { ctx } = recordingCtx((calls) =>
      calls.map((_c, i) => (i === 0 ? "0x" : amountsOut(1n, 7n))),
    );

    const quotes = await venueModule.quoteBatch(
      [
        { tokenIn: WETH, tokenOut: SPX, amountIn: "1" },
        { tokenIn: WETH, tokenOut: SPX, amountIn: "2" },
      ],
      [{ poolId: PAIR, token0: WETH, token1: SPX, fee: 3000, depth: "1" }],
      ctx,
    );

    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.amountOut).toBe("7");
  });
});

describe("building", () => {
  const quote = {
    poolId: PAIR,
    tokenIn: WETH,
    tokenOut: SPX,
    amountIn: "1000000000000000000",
    amountOut: "522900000000",
    gasEstimate: "150000",
  };
  const params = { recipient: USER, minAmountOut: "520000000000", deadline: "1790000000" };

  it("encodes swapExactTokensForTokens byte-for-byte as viem does", async () => {
    // The dynamic path array is where a hand-rolled encoder goes wrong, and a
    // wrong offset yields calldata that decodes to a different swap rather than
    // reverting.
    const { ctx } = recordingCtx(() => []);
    const built = await venueModule.buildCalls(quote, params, ctx);

    expect(built.calls[0]!.to).toBe(ROUTER);
    expect(built.calls[0]!.data).toBe(
      encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [10n ** 18n, 520_000_000_000n, [WETH, SPX], USER, 1_790_000_000n],
      }),
    );
  });

  it("approves only the token being sold, bounded by the amount", async () => {
    const { ctx } = recordingCtx(() => []);
    const built = await venueModule.buildCalls(quote, params, ctx);

    expect(built.approvals).toEqual([
      { token: WETH, spender: ROUTER, amount: "1000000000000000000" },
    ]);
    expect(built.calls[0]!.value).toBe("0");
    expect(built.poolIds).toEqual([PAIR]);
  });

  it("takes the recipient from the host, never from the quote", async () => {
    const { ctx } = recordingCtx(() => []);
    const built = await venueModule.buildCalls(quote, { ...params, recipient: SPX }, ctx);
    expect(built.calls[0]!.data.toLowerCase()).toContain(SPX.slice(2).toLowerCase());
  });
});
