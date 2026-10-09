/**
 * Does a planned split actually beat single-pool execution on real liquidity?
 *
 * The unit tests prove the allocator behaves correctly on a constant-product
 * curve. They cannot prove the curve resembles Uniswap v3, which is
 * concentrated rather than constant-product, or that a plan survives contact
 * with a real router. So this suite plans a route against live mainnet state,
 * executes every leg, and compares what landed in the wallet against both the
 * plan and the best single pool the router rejected.
 *
 * WETH -> USDC, because it has four live fee tiers with genuinely comparable
 * depth. SPX/WETH cannot demonstrate splitting at this block: its 0.3% pool
 * holds essentially all the liquidity and the others are dust, so the correct
 * route is a single leg and there would be nothing to show.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { Multicall3Reader, httpRpc, CONTRACTS, TOKENS } from "@spdex/chain";
import { BrokerSession, CapabilityBroker, NativeRuntime } from "@spdex/host";
import { ModuleManifestSchema, type WireVenueQuote } from "@spdex/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import venueModule from "../../../../modules/venue-uniswap-v3/index.mjs";
import { candidatesFromQuotes } from "../../src/assemble.js";
import { chunkGrid, planRoute } from "../../src/route.js";
import { IGNORE_GAS } from "../../src/gas.js";

const RPC_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const rpc = httpRpc(RPC_URL);

const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const ROUTER = CONTRACTS.uniV3SwapRouter02;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

const manifest = ModuleManifestSchema.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../../modules/venue-uniswap-v3/manifest.json", import.meta.url)), "utf8"),
  ),
);

/** 1000 WETH — large enough that concentrated liquidity actually runs out. */
const AMOUNT_IN = 1000n * 10n ** 18n;
const CHUNKS = 10;

let account: string;
let snapshot: string | null = null;

const hex = (v: bigint) => `0x${v.toString(16)}`;

async function balanceOf(token: string, owner: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner as `0x${string}`] });
  return BigInt((await rpc("eth_call", [{ to: token, data }, "latest"])) as string);
}

async function send(step: string, tx: Record<string, unknown>): Promise<void> {
  const hash = (await rpc("eth_sendTransaction", [tx])) as string;
  let receipt: { status: string } | null = null;
  for (let attempt = 0; attempt < 50 && receipt === null; attempt++) {
    receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
    if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!receipt) throw new Error(`step "${step}" produced no receipt (${hash})`);
  if (BigInt(receipt.status) !== 1n) throw new Error(`step "${step}" reverted (${hash})`);
}

function loadVenue() {
  return new NativeRuntime().load(
    { kind: "object", module: venueModule },
    new CapabilityBroker({ manifest, chain: new Multicall3Reader(rpc) }),
  );
}

beforeAll(async () => {
  try {
    account = ((await rpc("eth_accounts", [])) as string[])[0]!;
  } catch (error) {
    throw new Error(
      `No fork reachable at ${RPC_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

beforeEach(async () => {
  snapshot = (await rpc("evm_snapshot", [])) as string;
});

afterEach(async () => {
  if (snapshot) {
    await rpc("evm_revert", [snapshot]);
    snapshot = null;
  }
});

describe("split routing against live liquidity", () => {
  it("plans a split that beats the best single pool, and delivers it", async () => {
    const loaded = await loadVenue();
    try {
      const pair = { tokenA: WETH, tokenB: USDC };
      const pools = await loaded.discoverPools(pair, new BrokerSession());
      expect(pools.length).toBeGreaterThan(1);

      // The router's grid and the venue's quote request must be the same set of
      // amounts, or every lookup misses and the route comes back empty.
      const grid = chunkGrid(AMOUNT_IN, CHUNKS);
      const quotes = await loaded.quoteBatch(
        grid.map((amountIn) => ({ tokenIn: WETH, tokenOut: USDC, amountIn: amountIn.toString() })),
        pools,
        new BrokerSession(),
      );

      const candidates = candidatesFromQuotes(
        quotes,
        // Spread rather than assign: under exactOptionalPropertyTypes an
        // explicit `label: undefined` is not the same as an absent label.
        pools.map((p) => ({
          poolId: p.poolId,
          venueId: "venue-uniswap-v3",
          ...(p.label === undefined ? {} : { label: p.label }),
        })),
      );

      const plan = planRoute({
        amountIn: AMOUNT_IN,
        candidates,
        chunkCount: CHUNKS,
        maxSplits: 4,
        minSplitGainBps: 5,
        gas: IGNORE_GAS,
      });

      // Concentrated liquidity at this size should make splitting worthwhile.
      expect(plan.legs.length).toBeGreaterThan(1);
      expect(plan.rationale.bestSingle).not.toBeNull();
      expect(plan.amountOut).toBeGreaterThan(plan.rationale.bestSingle!.amountOut);
      expect(plan.legs.reduce((sum, leg) => sum + leg.amountIn, 0n)).toBe(AMOUNT_IN);

      // ── Execute every leg ──
      await send("wrap ETH to WETH", {
        from: account,
        to: WETH,
        value: hex(AMOUNT_IN),
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "deposit" }),
      });
      await send("approve router", {
        from: account,
        to: WETH,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [ROUTER as `0x${string}`, AMOUNT_IN],
        }),
      });

      // venueData carries the fee tier; recover it per pool from the quotes.
      const venueDataByPool = new Map<string, string | undefined>();
      for (const quote of quotes) venueDataByPool.set(quote.poolId.toLowerCase(), quote.venueData);

      const before = await balanceOf(USDC, account);
      for (const [i, leg] of plan.legs.entries()) {
        const legQuote: WireVenueQuote = {
          poolId: leg.poolId,
          tokenIn: WETH,
          tokenOut: USDC,
          amountIn: leg.amountIn.toString(),
          amountOut: leg.amountOut.toString(),
          gasEstimate: leg.gasEstimate.toString(),
          ...(venueDataByPool.get(leg.poolId.toLowerCase()) === undefined
            ? {}
            : { venueData: venueDataByPool.get(leg.poolId.toLowerCase())! }),
        };

        const built = await loaded.buildCalls(
          legQuote,
          {
            recipient: account,
            // Legs run on distinct pools and do not interact, so each should
            // deliver its quote; the small tolerance covers the dust added to
            // the largest leg.
            minAmountOut: ((leg.amountOut * 99n) / 100n).toString(),
            deadline: "9999999999",
          },
          new BrokerSession(),
        );

        await send(`execute leg ${i} (${leg.label ?? leg.poolId})`, {
          from: account,
          to: built.calls[0]!.to,
          data: built.calls[0]!.data,
          value: hex(BigInt(built.calls[0]!.value)),
          gas: hex(1_500_000n),
        });
      }
      const received = (await balanceOf(USDC, account)) - before;

      // The plan deliberately under-promises: dust goes to the largest leg
      // without crediting extra output for it.
      expect(received).toBeGreaterThanOrEqual(plan.amountOut);

      // The point of the whole exercise: the executed split really did beat
      // the single-pool route the router rejected.
      expect(received).toBeGreaterThan(plan.rationale.bestSingle!.amountOut);
    } finally {
      loaded.dispose();
    }
  }, 180_000);

  it("collapses to one leg when gas makes splitting uneconomic", async () => {
    // Same liquidity, same amount — only the gas model changes. A router that
    // ignored gas would split here too, and lose money doing it.
    const loaded = await loadVenue();
    try {
      const pair = { tokenA: WETH, tokenB: USDC };
      const pools = await loaded.discoverPools(pair, new BrokerSession());
      const grid = chunkGrid(AMOUNT_IN, CHUNKS);
      const quotes = await loaded.quoteBatch(
        grid.map((amountIn) => ({ tokenIn: WETH, tokenOut: USDC, amountIn: amountIn.toString() })),
        pools,
        new BrokerSession(),
      );
      const candidates = candidatesFromQuotes(
        quotes,
        pools.map((p) => ({ poolId: p.poolId, venueId: "venue-uniswap-v3" })),
      );

      const shared = { amountIn: AMOUNT_IN, candidates, chunkCount: CHUNKS, maxSplits: 4, minSplitGainBps: 5 };
      const free = planRoute({ ...shared, gas: IGNORE_GAS });
      const expensive = planRoute({
        ...shared,
        // Absurd gas: 5000 gwei, and USDC priced so each leg costs a fortune.
        gas: {
          costInTokenOut: (gasUnits: bigint) => gasUnits * 5_000_000n,
        },
      });

      expect(free.legs.length).toBeGreaterThan(1);
      expect(expensive.legs.length).toBe(1);
      expect(expensive.rationale.bestSingle).not.toBeNull();
    } finally {
      loaded.dispose();
    }
  }, 180_000);
});
