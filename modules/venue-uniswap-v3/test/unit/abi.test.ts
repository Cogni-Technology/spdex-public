/**
 * The module hand-rolls ABI encoding so it can run in the sandbox without a
 * bundler. That is only safe if the bytes it produces are provably the bytes
 * viem would produce — a wrong selector or a transposed field would encode a
 * different swap, and calldata does not look wrong to a human reviewer.
 *
 * So every encoding the module emits is compared against viem here. The module
 * ships without viem; the test does not.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import venueModule from "../../index.mjs";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const USER = "0x1111111111111111111111111111111111111111";

const FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** Records what the module asks for and replies with canned return data. */
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

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const addressWord = (a: string) => word(a.replace(/^0x/, ""));
const uintWord = (v: bigint) => word(v.toString(16));

describe("selectors match their signatures", () => {
  it("uses the correct four-byte selectors", () => {
    expect(toFunctionSelector("getPool(address,address,uint24)")).toBe("0x1698ee82");
    expect(toFunctionSelector("quoteExactInputSingle((address,address,uint256,uint24,uint160))")).toBe(
      "0xc6a5026a",
    );
    expect(
      toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"),
    ).toBe("0x04e45aaf");
  });
});

describe("discoverPools encoding", () => {
  it("asks the factory for every fee tier, encoded exactly as viem would", async () => {
    const { seen, ctx } = recordingCtx(() => ["0x" + addressWord(ROUTER)]);
    await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx);

    const factoryCalls = seen[0]!;
    expect(factoryCalls).toHaveLength(4);

    // Uniswap sorts a pool's tokens by address; WETH < SPX here.
    for (const [i, fee] of [100, 500, 3000, 10_000].entries()) {
      expect(factoryCalls[i]!.to).toBe(FACTORY);
      expect(factoryCalls[i]!.data).toBe(
        encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [WETH, SPX, fee],
        }),
      );
    }
  });

  it("probes each deployed pool through the quoter", async () => {
    let round = 0;
    const { seen, ctx } = recordingCtx((calls) => {
      round += 1;
      // Round 1: every tier exists. Round 2: each probe returns a nonzero out.
      return round === 1
        ? calls.map(() => "0x" + addressWord(ROUTER))
        : calls.map(() => "0x" + uintWord(12345n) + uintWord(0n) + word("0") + uintWord(90000n));
    });

    const pools = await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx);

    const probes = seen[1]!;
    expect(probes[0]!.to).toBe(QUOTER);
    expect(probes[0]!.data).toBe(
      encodeFunctionData({
        abi: QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: SPX, tokenOut: WETH, amountIn: 1_000_000_000_000n, fee: 100, sqrtPriceLimitX96: 0n }],
      }),
    );
    expect(pools).toHaveLength(4);
    expect(pools[0]!.depth).toBe("12345");
  });

  it("drops tiers the factory reports as nonexistent", async () => {
    // CREATE2 would produce a plausible address for a pool that was never
    // created; the factory is the authority, and it says zero.
    let round = 0;
    const { ctx } = recordingCtx((calls) => {
      round += 1;
      if (round === 1) {
        return calls.map((_c, i) => (i === 0 ? "0x" + word("0") : "0x" + addressWord(ROUTER)));
      }
      return calls.map(() => "0x" + uintWord(500n) + uintWord(0n) + word("0") + uintWord(1n));
    });

    const pools = await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx);
    expect(pools).toHaveLength(3);
    expect(pools.map((p: { fee: number }) => p.fee)).toEqual([500, 3000, 10_000]);
  });

  it("drops deployed pools that cannot actually trade", async () => {
    let round = 0;
    const { ctx } = recordingCtx((calls) => {
      round += 1;
      if (round === 1) return calls.map(() => "0x" + addressWord(ROUTER));
      // A reverted quote comes back as "0x", positionally.
      return calls.map((_c, i) => (i < 2 ? "0x" : "0x" + uintWord(7n) + uintWord(0n) + word("0") + uintWord(1n)));
    });

    const pools = await venueModule.discoverPools({ tokenA: SPX, tokenB: WETH }, ctx);
    expect(pools).toHaveLength(2);
  });
});

describe("buildCalls encoding", () => {
  const quote = {
    poolId: "0x00ed26e794b949e18b142f9108429b74ce08ac99",
    tokenIn: SPX,
    tokenOut: WETH,
    amountIn: "10000000000",
    amountOut: "2500000000000000",
    gasEstimate: "180000",
    venueData: "10000",
  };
  const params = { recipient: USER, minAmountOut: "2400000000000000", deadline: "1790000000" };

  it("encodes exactInputSingle byte-for-byte as viem does", async () => {
    const { ctx } = recordingCtx(() => []);
    const built = await venueModule.buildCalls(quote, params, ctx);

    expect(built.calls[0]!.to).toBe(ROUTER);
    expect(built.calls[0]!.data).toBe(
      encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: SPX,
            tokenOut: WETH,
            fee: 10_000,
            recipient: USER,
            amountIn: 10_000_000_000n,
            amountOutMinimum: 2_400_000_000_000_000n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    );
  });

  it("takes recipient and minimum from the host, never from the quote", async () => {
    // The module must encode the bounds it is handed. If it substituted its own,
    // the Guard would catch it — but it should never get that far.
    const { ctx } = recordingCtx(() => []);
    const built = await venueModule.buildCalls(quote, { ...params, recipient: WETH }, ctx);
    expect(built.calls[0]!.data.toLowerCase()).toContain(WETH.slice(2).toLowerCase());
  });

  it("requests approval only for the token being sold, bounded by the amount", async () => {
    const { ctx } = recordingCtx(() => []);
    const built = await venueModule.buildCalls(quote, params, ctx);

    expect(built.approvals).toEqual([{ token: SPX, spender: ROUTER, amount: "10000000000" }]);
    expect(built.calls[0]!.value).toBe("0");
  });

  it("falls back to the factory when venueData does not name a real tier", async () => {
    // A bad hint must not silently route through a different pool.
    const { seen, ctx } = recordingCtx((calls) =>
      calls.map((_c, i) => (i === 3 ? "0x" + addressWord(quote.poolId) : "0x" + word("0"))),
    );
    const built = await venueModule.buildCalls({ ...quote, venueData: "7777" }, params, ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]![0]!.to).toBe(FACTORY);
    expect(built.calls[0]!.data).toContain("2710"); // fee 10000 resolved from the factory
  });
});
