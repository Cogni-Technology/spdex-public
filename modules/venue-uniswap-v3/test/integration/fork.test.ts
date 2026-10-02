/**
 * The claim this module exists to support: its quotes match reality.
 *
 * Everything else — encoding, discovery, the sandbox — is machinery. What a
 * user cares about is that the number on screen is the number they receive.
 * So this suite quotes against real mainnet state at the pinned block, then
 * *executes the swap* and compares what actually landed in the wallet.
 *
 * The swap runs WETH -> SPX rather than the other way round for a practical
 * reason: WETH can be minted from ETH by anyone, and anvil's default accounts
 * are funded with ETH. Sourcing SPX instead would mean impersonating a holder
 * and draining a pool, which perturbs the very reserves being measured.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { Multicall3Reader, httpRpc, CONTRACTS, TOKENS } from "@spdex/chain";
import { BrokerSession, CapabilityBroker, NativeRuntime, QuickJSRuntime } from "@spdex/host";
import { ModuleManifestSchema } from "@spdex/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import venueModule from "../../index.mjs";
import manifestJson from "../../manifest.json" with { type: "json" };

const RPC_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const rpc = httpRpc(RPC_URL);

const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;
const ROUTER = CONTRACTS.uniV3SwapRouter02;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

const manifest = ModuleManifestSchema.parse(manifestJson);
const moduleSource = readFileSync(
  fileURLToPath(new URL("../../module.js", import.meta.url)),
  "utf8",
);

let account: string;
let snapshot: string | null = null;

const hex = (v: bigint) => `0x${v.toString(16)}`;

async function balanceOf(token: string, owner: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner as `0x${string}`] });
  const raw = (await rpc("eth_call", [{ to: token, data }, "latest"])) as string;
  return BigInt(raw);
}

async function send(step: string, tx: Record<string, unknown>): Promise<void> {
  const hash = (await rpc("eth_sendTransaction", [tx])) as string;

  // Poll rather than read once. anvil automines, but the receipt is not
  // guaranteed to be queryable by the time sendTransaction returns, and a null
  // receipt read as "reverted" sends you hunting for a contract bug that is
  // actually a race.
  let receipt: { status: string } | null = null;
  for (let attempt = 0; attempt < 50 && receipt === null; attempt++) {
    receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
    if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  if (!receipt) throw new Error(`step "${step}" produced no receipt (${hash})`);
  if (BigInt(receipt.status) !== 1n) {
    // Re-run as a call to surface the revert reason; a bare hash tells you
    // nothing about which of three transactions failed, or why.
    let reason = "no reason available";
    try {
      await rpc("eth_call", [tx, "latest"]);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    throw new Error(`step "${step}" reverted (${hash}): ${reason}`);
  }
}

function newBroker() {
  return new CapabilityBroker({ manifest, chain: new Multicall3Reader(rpc) });
}

beforeAll(async () => {
  try {
    const accounts = (await rpc("eth_accounts", [])) as string[];
    account = accounts[0]!;
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
  // Unconditional. A failing test that mutated chain state must not leave the
  // fork dirty — the pinned-block assertion in another file caught exactly
  // that, reporting 26000002 instead of 26000000.
  if (snapshot) {
    await rpc("evm_revert", [snapshot]);
    snapshot = null;
  }
});

describe("pool discovery against real mainnet state", () => {
  it("finds the SPX/WETH pools that actually exist and trade", async () => {
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const pools = await loaded.discoverPools({ tokenA: SPX, tokenB: WETH }, new BrokerSession());

      // Asserted as a property rather than a fixed list, because which tiers
      // are *tradeable* depends on liquidity at the pinned block. Two real
      // exclusions happen here: the 0.01% tier was never deployed (the factory
      // returns zero, though CREATE2 would still name an address), and the
      // 0.05% tier is deployed but holds 0 WETH, so the quoter reverts. Both
      // are exactly what discovery is for.
      expect(pools.length).toBeGreaterThan(0);
      expect(pools.map((p) => p.fee)).toContain(3000);
      expect(pools.map((p) => p.fee)).not.toContain(100);
      for (const pool of pools) {
        const code = (await rpc("eth_getCode", [pool.poolId, "latest"])) as string;
        expect(code).not.toBe("0x");
        expect(BigInt(pool.depth)).toBeGreaterThan(0n);
      }
    } finally {
      loaded.dispose();
    }
  });

  it("stays within its declared call budget on a real pair", async () => {
    const session = new BrokerSession();
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      await loaded.discoverPools({ tokenA: SPX, tokenB: WETH }, session);
      expect(session.callsUsed).toBeLessThanOrEqual(manifest.limits.maxCallsPerQuote);
    } finally {
      loaded.dispose();
    }
  });
});

describe("quotes match on-chain execution", () => {
  it("delivers exactly what it quoted", async () => {
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const amountIn = 10n ** 18n; // 1 WETH

      // Mint WETH from the account's own ETH — no whale, no perturbed pool.
      await send("wrap ETH to WETH", {
        from: account,
        to: WETH,
        value: hex(amountIn),
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "deposit" }),
      });
      expect(await balanceOf(WETH, account)).toBeGreaterThanOrEqual(amountIn);

      const pools = await loaded.discoverPools({ tokenA: WETH, tokenB: SPX }, new BrokerSession());
      const quotes = await loaded.quoteBatch(
        [{ tokenIn: WETH, tokenOut: SPX, amountIn: amountIn.toString() }],
        pools,
        new BrokerSession(),
      );
      expect(quotes.length).toBeGreaterThan(0);

      // Take the best quote, as the router will.
      const best = quotes.reduce((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? b : a));
      const minOut = (BigInt(best.amountOut) * 995n) / 1000n;

      const built = await loaded.buildCalls(
        best,
        { recipient: account, minAmountOut: minOut.toString(), deadline: "9999999999" },
        new BrokerSession(),
      );

      // The approval the module asked for, granted by the host.
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

      // Nothing else touched these pools between quote and execution, so the
      // quote is not an estimate here — it is the answer.
      expect(received).toBe(BigInt(best.amountOut));
      expect(received).toBeGreaterThanOrEqual(minOut);
    } finally {
      loaded.dispose();
    }
  }, 120_000);

  it("prices larger trades worse, as a constant-product curve must", async () => {
    const loaded = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    try {
      const pools = await loaded.discoverPools({ tokenA: WETH, tokenB: SPX }, new BrokerSession());
      const quotes = await loaded.quoteBatch(
        [
          { tokenIn: WETH, tokenOut: SPX, amountIn: (10n ** 18n).toString() },
          { tokenIn: WETH, tokenOut: SPX, amountIn: (100n * 10n ** 18n).toString() },
        ],
        pools,
        new BrokerSession(),
      );

      const bestFor = (amountIn: bigint) =>
        quotes
          .filter((q) => BigInt(q.amountIn) === amountIn)
          .reduce((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? b : a));

      const small = bestFor(10n ** 18n);
      const large = bestFor(100n * 10n ** 18n);

      // Price per unit must degrade with size; if it did not, the split router
      // built on top of this would have nothing to optimise.
      const smallRate = (BigInt(small.amountOut) * 10n ** 18n) / BigInt(small.amountIn);
      const largeRate = (BigInt(large.amountOut) * 10n ** 18n) / BigInt(large.amountIn);
      expect(largeRate).toBeLessThan(smallRate);
    } finally {
      loaded.dispose();
    }
  }, 120_000);
});

describe("the sandbox reaches the same answer as native", () => {
  it("quotes identically in QuickJS against live chain state", async () => {
    // The parity gate proves this with stubbed reads. This proves it with real
    // ones, where a difference in batching or decoding would actually show up.
    const native = await new NativeRuntime().load({ kind: "object", module: venueModule }, newBroker());
    const sandboxed = await new QuickJSRuntime({ maxRounds: 8 }).load(
      { kind: "code", code: moduleSource },
      newBroker(),
    );
    try {
      const pair = { tokenA: WETH, tokenB: SPX };
      const request = [{ tokenIn: WETH, tokenOut: SPX, amountIn: (10n ** 18n).toString() }];

      const nativePools = await native.discoverPools(pair, new BrokerSession());
      const sandboxPools = await sandboxed.discoverPools(pair, new BrokerSession());
      expect(sandboxPools).toEqual(nativePools);

      const nativeQuotes = await native.quoteBatch(request, nativePools, new BrokerSession());
      const sandboxQuotes = await sandboxed.quoteBatch(request, sandboxPools, new BrokerSession());
      expect(sandboxQuotes).toEqual(nativeQuotes);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 120_000);
});
