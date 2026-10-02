/**
 * Native ETH, end to end against the fork.
 *
 * The unit tests prove the calldata matches viem. They cannot prove the router
 * interprets it the way we think — that `swapExactETHForTokens` really wraps
 * the value, that `swapExactTokensForETH` really unwraps and forwards, or that
 * the Guard's effect analysis sees native movement at all.
 *
 * The last of those is the one worth stating. The Guard derives what moved from
 * ERC-20 Transfer logs, and native ether emits none. It works because
 * `eth_simulateV1` with `traceTransfers` reports native movement as a Transfer
 * from the `0xeeee…eeee` pseudo-address, which is the same address the intent
 * uses — so one mechanism covers both, with no native special case anywhere in
 * the effects layer. This asserts that rather than assuming it.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi } from "viem";
import { EthSimulateV1Provider, Multicall3Reader, NATIVE_TOKEN, TOKENS, httpRpc } from "@spdex/chain";
import { BrokerSession, CapabilityBroker, NativeRuntime } from "@spdex/host";
import { Guard } from "@spdex/guard";
import { ModuleManifestSchema, type TxPlan } from "@spdex/core";
import venueModule from "../../index.mjs";

const RPC_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(RPC_URL);

const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;
const ONE_ETH = 10n ** 18n;

const manifest = ModuleManifestSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), "utf8")),
);

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

let account: `0x${string}`;
let loaded: Awaited<ReturnType<NativeRuntime["load"]>>;

async function send(step: string, tx: Record<string, unknown>): Promise<void> {
  const hash = (await rpc("eth_sendTransaction", [tx])) as string;
  for (let attempt = 0; attempt < 80; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`${step} reverted`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${step} was not mined`);
}

const tokenBalance = async (token: string, owner: string) =>
  BigInt(
    (await rpc("eth_call", [
      { to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner as `0x${string}`] }) },
      "latest",
    ])) as string,
  );
const ethBalance = async (owner: string) => BigInt((await rpc("eth_getBalance", [owner, "latest"])) as string);

/**
 * A fresh address that can actually hold ether.
 *
 * Emphatically **not** one of anvil's default accounts. Their private keys are
 * published, so on real mainnet every one of them carries an EIP-7702
 * delegation installed by a sweeper bot — `eth_getCode` returns
 * `0xef0100…8a67b502…` for all ten — and a fork inherits that state along with
 * everything else. Any ether sent to them is forwarded out in the same
 * transaction.
 *
 * That is not a hypothetical. It broke this suite first, and the Guard was
 * right to reject the plan: the recipient genuinely did receive nothing. An
 * address with no mainnet history has no delegate, and `anvil_setBalance` plus
 * impersonation makes it usable without a key.
 */
async function cleanAccount(): Promise<`0x${string}`> {
  // An arbitrary address with no mainnet history, and therefore no delegate.
  const address = "0x5d3ec0de00000000000000000000000000000001" as const;
  await rpc("anvil_setBalance", [address, `0x${(1000n * 10n ** 18n).toString(16)}`]);
  await rpc("anvil_impersonateAccount", [address]);
  const code = (await rpc("eth_getCode", [address, "latest"])) as string;
  if (code !== "0x") throw new Error(`test account ${address} unexpectedly has code ${code}`);
  return address;
}

beforeAll(async () => {
  try {
    account = await cleanAccount();
  } catch (error) {
    throw new Error(
      `No fork reachable at ${RPC_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  loaded = await new NativeRuntime().load(
    { kind: "object", module: venueModule },
    new CapabilityBroker({ manifest, chain: new Multicall3Reader(rpc) }),
  );
});

/** Quote the pair, then build with whichever native flags are asked for. */
async function buildLeg(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  flags: { nativeIn?: boolean; nativeOut?: boolean },
) {
  const pools = await loaded.discoverPools({ tokenA: tokenIn, tokenB: tokenOut }, new BrokerSession());
  expect(pools.length).toBeGreaterThan(0);
  const quotes = await loaded.quoteBatch(
    [{ tokenIn, tokenOut, amountIn: amountIn.toString() }],
    pools,
    new BrokerSession(),
  );
  expect(quotes.length).toBeGreaterThan(0);
  const quote = quotes[0]!;
  const minOut = (BigInt(quote.amountOut) * 95n) / 100n;

  const built = await loaded.buildCalls(
    quote,
    {
      recipient: account,
      minAmountOut: minOut.toString(),
      deadline: "9999999999",
      ...flags,
    },
    new BrokerSession(),
  );
  return { quote, minOut, built };
}

/** The plan the host would assemble, with the user's own tokens in the intent. */
function planFor(options: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  built: Awaited<ReturnType<typeof buildLeg>>["built"];
}): TxPlan {
  return {
    version: 1,
    intent: {
      version: 1,
      chainId: CHAIN_ID,
      account,
      recipient: account,
      tokenIn: options.tokenIn as `0x${string}`,
      tokenOut: options.tokenOut as `0x${string}`,
      maxAmountIn: options.amountIn,
      minAmountOut: options.minOut,
      deadline: 9999999999n,
      nonce: "0xabad1deaabad1deaabad1deaabad1dea",
    },
    approvals: options.built.approvals.map((a) => ({
      token: a.token as `0x${string}`,
      spender: a.spender as `0x${string}`,
      amount: BigInt(a.amount),
    })),
    calls: options.built.calls.map((c) => ({
      to: c.to as `0x${string}`,
      data: c.data as `0x${string}`,
      value: BigInt(c.value),
    })),
    meta: {
      venueId: manifest.id,
      poolIds: options.built.poolIds,
      quotedAmountOut: BigInt(options.built.quotedAmountOut),
      gasEstimate: BigInt(options.built.gasEstimate),
    },
  };
}

const guard = () =>
  new Guard(new EthSimulateV1Provider(rpc), {
    chainId: CHAIN_ID,
    requireSimulation: true,
    oracleDivergenceBps: 10_000,
  });

describe("selling native ETH", () => {
  it("is verified by the Guard, with native movement seen in the logs", async () => {
    const { minOut, built } = await buildLeg(WETH, SPX, ONE_ETH, { nativeIn: true });

    // The plan pays with value and asks for no allowance.
    expect(built.approvals).toEqual([]);
    expect(BigInt(built.calls[0]!.value)).toBe(ONE_ETH);

    const plan = planFor({ tokenIn: NATIVE_TOKEN, tokenOut: SPX, amountIn: ONE_ETH, minOut, built });
    const verdict = await guard().check({
      plan,
      expectedIntent: plan.intent,
      manifest,
      extraTrustedContracts: [],
      nowSeconds: 1n,
    });

    // `verified`, not merely `signable`: the Guard actually simulated it and
    // measured native ether arriving and leaving.
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("really delivers, executed against the fork", async () => {
    const { built } = await buildLeg(WETH, SPX, ONE_ETH, { nativeIn: true });
    const before = await tokenBalance(SPX, account);

    await send("swapExactETHForTokens", {
      from: account,
      to: built.calls[0]!.to,
      data: built.calls[0]!.data,
      value: `0x${BigInt(built.calls[0]!.value).toString(16)}`,
      gas: "0x2dc6c0",
    });

    expect(await tokenBalance(SPX, account)).toBeGreaterThan(before);
  });
});

describe("receiving native ETH", () => {
  it("is verified, and pays a fresh account in ether rather than WETH", async () => {
    const spxHeld = await tokenBalance(SPX, account);
    expect(spxHeld).toBeGreaterThan(0n);
    const amountIn = spxHeld / 4n;

    const { minOut, built } = await buildLeg(SPX, WETH, amountIn, { nativeOut: true });
    expect(built.approvals).toHaveLength(1);
    expect(BigInt(built.calls[0]!.value)).toBe(0n);

    const plan = planFor({ tokenIn: SPX, tokenOut: NATIVE_TOKEN, amountIn, minOut, built });

    const verdict = await guard().check({
      plan,
      expectedIntent: plan.intent,
      manifest,
      extraTrustedContracts: [],
      nowSeconds: 1n,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");

    // And on chain. Measured on the sender, whose ether can only have gone up
    // by more than gas if the unwrap really forwarded.
    await send("approve", {
      from: account,
      to: SPX,
      gas: "0x30d40",
      data: encodeFunctionData({
        abi: erc20,
        functionName: "approve",
        args: [built.approvals[0]!.spender as `0x${string}`, BigInt(built.approvals[0]!.amount)],
      }),
    });

    const ethBefore = await ethBalance(account);
    const wethBefore = await tokenBalance(WETH, account);
    await send("swapExactTokensForETH", {
      from: account,
      to: built.calls[0]!.to,
      data: built.calls[0]!.data,
      gas: "0x2dc6c0",
    });

    expect(await ethBalance(account)).toBeGreaterThan(ethBefore);
    // Ether, not its wrapper: paying out WETH here would satisfy a careless
    // check while giving the user something they did not ask for.
    expect(await tokenBalance(WETH, account)).toBe(wethBefore);
  });
});
