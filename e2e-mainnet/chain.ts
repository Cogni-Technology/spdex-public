/**
 * Reading the chain from the harness, through the same endpoint the page
 * uses (rpc.ts says what is retried), and the addresses the suite trusts.
 */

import { MAINNET_BATCHER, MAINNET_DEPLOYMENT, factoryAddress } from "../packages/vault/src/index.js";
import { smokeRpc } from "./rpc.js";
import { smokeSettings } from "./settings.js";

type Hex = `0x${string}`;

export const settings = smokeSettings();

export const FACTORY = factoryAddress(MAINNET_DEPLOYMENT).toLowerCase() as Hex;
export const BATCHER = MAINNET_BATCHER.toLowerCase() as Hex;
export const WETH = MAINNET_DEPLOYMENT.weth.toLowerCase() as Hex;
export const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c" as Hex;
/** Uniswap v2's Router02 and v3's SwapRouter02: the two venues' only targets (modules/venue-uniswap-v*). */
export const ROUTERS: readonly Hex[] = ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d", "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45"];

export const rpc = smokeRpc(settings.rpcUrl);

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export async function ethBalance(address: string): Promise<bigint> {
  return BigInt((await rpc("eth_getBalance", [address, "latest"])) as string);
}

/** An ERC-20 balance. Throws rather than reading zero from an answer that isn't one. */
export async function tokenBalance(token: string, owner: string): Promise<bigint> {
  const raw = (await rpc("eth_call", [{ to: token, data: `0x70a08231${word(owner)}` }, "latest"])) as string;
  if (!/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error(`balanceOf(${owner}) on ${token} answered ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

export async function hasCode(address: string): Promise<boolean> {
  return ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";
}

/** Whether the factory vouches for `address` as one of its vaults: `isVault(address)`. */
export async function isVault(address: string): Promise<boolean> {
  const raw = (await rpc("eth_call", [{ to: FACTORY, data: `0x652b9b41${word(address)}` }, "latest"])) as string;
  if (!/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error(`isVault(${address}) answered ${JSON.stringify(raw)}`);
  return BigInt(raw) === 1n;
}

export async function headBlock(): Promise<bigint> {
  return BigInt((await rpc("eth_blockNumber", [])) as string);
}

export async function chainTime(): Promise<bigint> {
  const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  return BigInt(block.timestamp);
}

export async function baseFee(): Promise<bigint> {
  const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas?: string };
  if (!block.baseFeePerGas) throw new Error("the latest block has no base fee");
  return BigInt(block.baseFeePerGas);
}

/** Whether the endpoint is anvil: a fork, where nothing is real. */
export async function isFork(): Promise<boolean> {
  const version = (await rpc("web3_clientVersion", [])) as string;
  return /^anvil\//i.test(version);
}

export interface Receipt {
  transactionHash: Hex;
  status: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice: string;
  from: string;
  to: string | null;
  logs: { address: Hex; topics: Hex[]; data: Hex; blockNumber?: string }[];
}

export async function receiptOf(hash: string): Promise<Receipt | null> {
  return (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
}

/**
 * Wait for `hash` to be mined, for up to `timeoutMs`, and return its
 * receipt; throws if it reverted or never came. A fork mines at once; a
 * mainnet transaction takes a block or several.
 */
export async function minedReceipt(hash: string, timeoutMs: number): Promise<Receipt> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await receiptOf(hash);
    if (receipt !== null) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`${hash} reverted`);
      return receipt;
    }
    if (Date.now() > until) throw new Error(`${hash} was not mined within ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** What a mined transaction cost its sender: gas used times the price paid. */
export function feeOf(receipt: Receipt): bigint {
  return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
}
