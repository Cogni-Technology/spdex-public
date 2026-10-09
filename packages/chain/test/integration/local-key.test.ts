/**
 * A locally held key (a keeper's), end to end against the fork.
 *
 * The unit tests pin the bytes and the arithmetic against a scripted endpoint.
 * They cannot show that a real node agrees: that it accepts a type-2
 * transaction this code signed, that the hash recorded before sending is the
 * hash the node reports, or that a swap signed by one address really delivers
 * to another. This does.
 *
 * It is also where `estimateBuyGas` is held to account. The figures in that
 * function's comment were measured once; these tests measure again on every
 * run, so a change that made buys dearer than the budgeted gas fails here
 * rather than as a plan that stalls weeks into its schedule.
 *
 * Every address is fresh. anvil's default accounts carry an EIP-7702 sweeper
 * delegation inherited from mainnet (see modules/venue-uniswap-v2's native
 * test), so ether sent to one is forwarded away; and their balances are shared
 * by every suite, so they are never `anvil_setBalance`d. A key generated here
 * has no history, no code and no delegate.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { TOKENS } from "../../src/constants.js";
import { httpRpc } from "../../src/reader.js";
import {
  addressOfKey,
  estimateBuyGas,
  generateSpendingKey,
  maxCostOf,
  prepareTransaction,
  signPrepared,
  type PreparedTransaction,
} from "../../src/signer.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);

const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;
const V2_ROUTER: Address = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
/** Far in the future, as the other fork suites use: the fork's clock is not the wall's. */
const DEADLINE = 9_999_999_999n;
const ETHER = 10n ** 18n;

const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const ethBalance = async (owner: Address) => BigInt((await rpc("eth_getBalance", [owner, "latest"])) as string);
const tokenBalance = async (token: Address, owner: Address) =>
  BigInt(
    (await rpc("eth_call", [
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }) },
      "latest",
    ])) as string,
  );

/** The v2 router's own quote, less 5%: the floor a host would promise. */
async function minOut(amountIn: bigint, path: Address[]): Promise<bigint> {
  const data = encodeFunctionData({ abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path] });
  const raw = (await rpc("eth_call", [{ to: V2_ROUTER, data }, "latest"])) as Hex;
  const amounts = decodeFunctionResult({ abi: routerAbi, functionName: "getAmountsOut", data: raw });
  const out = amounts[amounts.length - 1]!;
  expect(out).toBeGreaterThan(0n);
  return (out * 95n) / 100n;
}

/** A fresh address with no history and no code; funded only if asked. */
async function freshAddress(fund?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  const code = (await rpc("eth_getCode", [address, "latest"])) as string;
  if (code !== "0x") throw new Error(`fresh address ${address} unexpectedly has code ${code}`);
  if (fund !== undefined) await rpc("anvil_setBalance", [address, hex(fund)]);
  return { key, address };
}

interface Receipt {
  status: string;
  type: string;
  from: string;
  gasUsed: string;
}

/**
 * Sign locally, send raw, wait for the receipt — the host's path, minus the
 * Guard, which judges what is sent rather than how it is signed.
 *
 * The balance check is the host's pre-flight, done here the same way so a
 * test that underfunds a wallet fails on the check rather than on the node.
 */
async function signAndSend(key: Hex, tx: PreparedTransaction): Promise<Receipt> {
  expect(await ethBalance(tx.from)).toBeGreaterThanOrEqual(maxCostOf(tx));
  const { raw, hash } = await signPrepared(key, tx);
  // The hash the host would record before broadcasting is the one the node reports.
  expect(await rpc("eth_sendRawTransaction", [raw])).toBe(hash);
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) {
      expect(BigInt(receipt.status)).toBe(1n);
      expect(receipt.from.toLowerCase()).toBe(tx.from);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

beforeAll(async () => {
  try {
    const chainId = BigInt((await rpc("eth_chainId", [])) as string);
    if (chainId !== BigInt(CHAIN_ID)) throw new Error(`fork is chain ${chainId}, expected ${CHAIN_ID}`);
  } catch (error) {
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

describe("a locally held key on the fork", () => {
  it("signs a type-2 transaction the node accepts, under the hash computed before sending", async () => {
    const wallet = await freshAddress(ETHER);
    const payee = await freshAddress();

    const tx = await prepareTransaction(rpc, {
      from: wallet.address,
      to: payee.address,
      data: "0x",
      value: 10n ** 15n,
      chainId: CHAIN_ID,
    });
    // The fork has a base fee, so this must be EIP-1559, not a legacy fallback.
    expect(tx.fees.type).toBe("eip1559");
    expect(tx.nonce).toBe(0);

    const receipt = await signAndSend(wallet.key, tx);
    expect(receipt.type).toBe("0x2");
    expect(await ethBalance(payee.address)).toBe(10n ** 15n);
    expect(BigInt((await rpc("eth_getTransactionCount", [wallet.address, "latest"])) as string)).toBe(1n);
  });

  it("buys with ether and delivers to a different address, inside the native gas budget", async () => {
    // The autopilot shape: the spending wallet pays, the owner receives. The
    // Guard measures delivery at the recipient; this shows the router honours
    // a recipient that is not the signer, from a key this code holds.
    const wallet = await freshAddress(ETHER);
    const owner = await freshAddress();
    const amountIn = 10n ** 16n;
    const floor = await minOut(amountIn, [WETH, SPX]);

    const tx = await prepareTransaction(rpc, {
      from: wallet.address,
      to: V2_ROUTER,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "swapExactETHForTokens",
        args: [floor, [WETH, SPX], owner.address, DEADLINE],
      }),
      value: amountIn,
      chainId: CHAIN_ID,
    });
    // The recipient holds no SPX yet, which is the dearer case the budget covers.
    expect(tx.gas).toBeLessThanOrEqual(estimateBuyGas("native"));

    const receipt = await signAndSend(wallet.key, tx);
    expect(BigInt(receipt.gasUsed)).toBeLessThanOrEqual(tx.gas);
    expect(await tokenBalance(SPX, owner.address)).toBeGreaterThanOrEqual(floor);
    expect(await tokenBalance(SPX, wallet.address)).toBe(0n);
  });

  it("sells a token for someone else — an exact approval, then the swap — inside the token gas budget", async () => {
    const wallet = await freshAddress(ETHER);
    const owner = await freshAddress();

    // Stock the wallet with a little SPX, the way a token-budget plan would be funded.
    const stock = await prepareTransaction(rpc, {
      from: wallet.address,
      to: V2_ROUTER,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "swapExactETHForTokens",
        args: [await minOut(5n * 10n ** 15n, [WETH, SPX]), [WETH, SPX], wallet.address, DEADLINE],
      }),
      value: 5n * 10n ** 15n,
      chainId: CHAIN_ID,
    });
    await signAndSend(wallet.key, stock);
    const amountIn = await tokenBalance(SPX, wallet.address);
    expect(amountIn).toBeGreaterThan(0n);

    // The Guard allows an approval of exactly the amount sold and no more, so
    // every token buy pays for one; the budget has to include it.
    const approve = await prepareTransaction(rpc, {
      from: wallet.address,
      to: SPX,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [V2_ROUTER, amountIn] }),
      value: 0n,
      chainId: CHAIN_ID,
    });
    await signAndSend(wallet.key, approve);

    const floor = await minOut(amountIn, [SPX, WETH]);
    const ownerBefore = await ethBalance(owner.address);
    const swap = await prepareTransaction(rpc, {
      from: wallet.address,
      to: V2_ROUTER,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "swapExactTokensForETH",
        args: [amountIn, floor, [SPX, WETH], owner.address, DEADLINE],
      }),
      value: 0n,
      chainId: CHAIN_ID,
    });
    // Sequential nonces from the pending count, with nothing reused.
    expect([stock.nonce, approve.nonce, swap.nonce]).toEqual([0, 1, 2]);
    expect(approve.gas + swap.gas).toBeLessThanOrEqual(estimateBuyGas("token"));

    await signAndSend(wallet.key, swap);
    expect((await ethBalance(owner.address)) - ownerBefore).toBeGreaterThanOrEqual(floor);
    expect(await tokenBalance(SPX, wallet.address)).toBe(0n);
  });
});
