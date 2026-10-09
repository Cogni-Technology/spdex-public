/**
 * v2 against real mainnet state.
 *
 * Two claims are checked here. First the usual one: a quote from this module
 * equals what the wallet actually receives. Second, the claim that motivated
 * building it at all — that v2 is where SPX liquidity lives. If that ever stops
 * being true the assertion below will say so, which is more useful than a
 * comment repeating a measurement taken once.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { Multicall3Reader, httpRpc, TOKENS } from "@spdex/chain";
import { BrokerSession, CapabilityBroker, NativeRuntime, QuickJSRuntime } from "@spdex/host";
import { ModuleManifestSchema } from "@spdex/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import venueModule from "../../index.mjs";

const RPC_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const rpc = httpRpc(RPC_URL);

const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

const manifest = ModuleManifestSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), "utf8")),
);
const moduleSource = readFileSync(fileURLToPath(new URL("../../module.js", import.meta.url)), "utf8");

let account: string;
let snapshot: string | null = null;

const hex = (v: bigint) => `0x${v.toString(16)}`;
const newBroker = () => new CapabilityBroker({ manifest, chain: new Multicall3Reader(rpc) });

async function balanceOf(token: string, owner: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner as `0x${string}`] });
  return BigInt((await rpc("eth_call", [{ to: token, data }, "latest"])) as string);
}

async function send(step: string, tx: Record<string, unknown>): Promise<void> {
  const hash = (await rpc("eth_sendTransaction", [tx])) as string;
  let receipt: { status: string } | null = null;
  for (let attempt = 0; attempt < 60 && receipt === null; attempt++) {
    receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
    if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!receipt) throw new Error(`step "${step}" produced no receipt`);
  if (BigInt(receipt.status) !== 1n) throw new Error(`step "${step}" reverted`);
}

beforeAll(async () => {
  try {
    account = ((await rpc("eth_accounts", [])) as string[])[2]!;
  } catch (error) {
    throw new Error(
      `No fork reachable at ${RPC_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

beforeEach(async () => {
  snapshot = (await rpc("evm_snapshot", [])) as string;
  void snapshot;
});

describe("v2 discovery", () => {
  it("finds the SPX/WETH pair and reports it as tradeable", async () => {
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const pools = await loaded.discoverPools({ tokenA: SPX, tokenB: WETH }, new BrokerSession());

      // v2 has exactly one pair per token pair — no fee tiers to pick between.
      expect(pools).toHaveLength(1);
      expect(pools[0]!.label).toBe("Uniswap v2");
      expect(BigInt(pools[0]!.depth)).toBeGreaterThan(0n);

      const code = (await rpc("eth_getCode", [pools[0]!.poolId, "latest"])) as string;
      expect(code).not.toBe("0x");
    } finally {
      loaded.dispose();
    }
  });

  it("is where SPX liquidity actually is", async () => {
    // The reason this module exists. Measured at the pinned block, the v2 pair
    // holds roughly 55x the WETH of the deepest v3 pool — so a router that knew
    // only about v3 would be quoting SPX against a couple of percent of its
    // market, and quoting it worse.
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const pools = await loaded.discoverPools({ tokenA: SPX, tokenB: WETH }, new BrokerSession());
      const v2Weth = await balanceOf(WETH, pools[0]!.poolId);

      // The deepest v3 SPX/WETH pool at this block.
      const v3Weth = await balanceOf(WETH, "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3");

      expect(v2Weth).toBeGreaterThan(v3Weth * 10n);
    } finally {
      loaded.dispose();
    }
  });
});

describe("v2 quotes match execution", () => {
  it("delivers exactly what it quoted", async () => {
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const amountIn = 10n ** 18n;

      await send("wrap ETH to WETH", {
        from: account,
        to: WETH,
        value: hex(amountIn),
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "deposit" }),
      });

      const pools = await loaded.discoverPools({ tokenA: WETH, tokenB: SPX }, new BrokerSession());
      const quotes = await loaded.quoteBatch(
        [{ tokenIn: WETH, tokenOut: SPX, amountIn: amountIn.toString() }],
        pools,
        new BrokerSession(),
      );
      expect(quotes).toHaveLength(1);

      const quote = quotes[0]!;
      const minOut = (BigInt(quote.amountOut) * 995n) / 1000n;
      const built = await loaded.buildCalls(
        quote,
        { recipient: account, minAmountOut: minOut.toString(), deadline: "9999999999" },
        new BrokerSession(),
      );

      const approval = built.approvals[0]!;
      await send("approve router", {
        from: account,
        to: approval.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [approval.spender as `0x${string}`, BigInt(approval.amount)],
        }),
      });

      const before = await balanceOf(SPX, account);
      await send("execute swap", {
        from: account,
        to: built.calls[0]!.to,
        data: built.calls[0]!.data,
        value: hex(BigInt(built.calls[0]!.value)),
        gas: hex(1_000_000n),
      });
      const received = (await balanceOf(SPX, account)) - before;

      // Nothing else touched the pair between quote and execution, so the
      // quote is the answer rather than an estimate.
      expect(received).toBe(BigInt(quote.amountOut));
    } finally {
      loaded.dispose();
    }
  }, 120_000);

  it("prices larger trades worse, as a constant-product pair must", async () => {
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const pools = await loaded.discoverPools({ tokenA: WETH, tokenB: SPX }, new BrokerSession());
      const quotes = await loaded.quoteBatch(
        [
          { tokenIn: WETH, tokenOut: SPX, amountIn: (10n ** 18n).toString() },
          { tokenIn: WETH, tokenOut: SPX, amountIn: (500n * 10n ** 18n).toString() },
        ],
        pools,
        new BrokerSession(),
      );

      const rate = (q: { amountIn: string; amountOut: string }) =>
        (BigInt(q.amountOut) * 10n ** 18n) / BigInt(q.amountIn);

      expect(rate(quotes[1]!)).toBeLessThan(rate(quotes[0]!));
    } finally {
      loaded.dispose();
    }
  }, 120_000);
});

describe("the sandbox reaches the same answer", () => {
  it("quotes identically in QuickJS against live chain state", async () => {
    const native = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    const sandboxed = await new QuickJSRuntime().load({ kind: "code", code: moduleSource }, newBroker());
    try {
      const pair = { tokenA: WETH, tokenB: SPX };
      const request = [{ tokenIn: WETH, tokenOut: SPX, amountIn: (10n ** 18n).toString() }];

      const nativePools = await native.discoverPools(pair, new BrokerSession());
      const sandboxPools = await sandboxed.discoverPools(pair, new BrokerSession());
      expect(sandboxPools).toEqual(nativePools);

      expect(await sandboxed.quoteBatch(request, sandboxPools, new BrokerSession())).toEqual(
        await native.quoteBatch(request, nativePools, new BrokerSession()),
      );
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 120_000);
});
