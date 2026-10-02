import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOPICS, TOKENS } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import type { ChainReceipt } from "../receipts.js";
import { accountOf, blockOf, eachLimited, measureSwap, networkFeeOf, transferTotal, type TxFacts } from "./attribution.js";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const POOL = "0x2222222222222222222222222222222222222222" as Address;
const SPX = TOKENS.SPX.address.toLowerCase() as Address;
const WETH = TOKENS.WETH.address.toLowerCase() as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const amount = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

function transfer(token: string, from: string, to: string, value: bigint) {
  return { address: token.toLowerCase(), topics: [TOPICS.transfer, topic(from), topic(to)], data: amount(value) };
}

function receipt(n: number, overrides: Partial<ChainReceipt> = {}): ChainReceipt {
  return {
    hash: hash(n),
    from: ME,
    status: "success",
    blockNumber: 100n + BigInt(n),
    blockHash: hash(1000 + n),
    fee: 21_000n * 10n ** 9n,
    logs: [],
    ...overrides,
  };
}

describe("attribution", () => {
  const facts = new Map<string, TxFacts>([
    [hash(1), { chainId: 1, from: ME, fee: 5n, block: 10n, blockHash: hash(9), status: "success" }],
    [hash(2), { chainId: 1, from: POOL, fee: 7n, block: 11n, blockHash: hash(9), status: "success" }],
    [hash(3), { chainId: 1, from: ME, fee: null, block: 12n, blockHash: hash(9), status: "success" }],
  ]);
  const of = (h: string) => facts.get(h) ?? null;

  it("credits a row to its first transaction's sender, and to nobody while that is unknown", () => {
    expect(accountOf([hash(1), hash(2)], of)).toBe(ME);
    expect(accountOf([hash(2), hash(1)], of)).toBe(POOL);
    expect(accountOf([hash(4), hash(1)], of)).toBeNull();
    expect(accountOf([], of)).toBeNull();
  });

  it("sums every fee, or none when one is unknown", () => {
    expect(networkFeeOf([hash(1), hash(2)], of)).toBe(12n);
    expect(networkFeeOf([hash(1), hash(3)], of)).toBeNull();
    expect(networkFeeOf([hash(1), hash(4)], of)).toBeNull();
    expect(networkFeeOf([], of)).toBeNull();
  });

  it("dates a row by its last transaction's block", () => {
    expect(blockOf([hash(1), hash(2)], of)).toBe(11n);
    expect(blockOf([hash(1), hash(4)], of)).toBeNull();
  });
});

describe("measuring", () => {
  it("counts Transfers from or to the account in successful receipts only", () => {
    const receipts = [
      receipt(1, { logs: [transfer(WETH, ME, POOL, 5n), transfer(SPX, POOL, ME, 700n)] }),
      receipt(2, { logs: [transfer(SPX, POOL, ME, 300n), transfer(SPX, POOL, POOL, 9n)] }),
      receipt(3, { status: "reverted", logs: [transfer(SPX, POOL, ME, 1_000n)] }),
    ];
    expect(transferTotal(receipts, SPX, { to: ME })).toBe(1_000n);
    expect(transferTotal(receipts, WETH, { from: ME })).toBe(5n);
    expect(transferTotal([...receipts, null], SPX, { to: ME })).toBeNull();
  });

  it("measures a token-for-token swap from its logs", () => {
    const measured = measureSwap({
      account: ME,
      tokenIn: WETH,
      tokenOut: SPX,
      receipts: [receipt(1), receipt(2, { logs: [transfer(WETH, ME, POOL, 10n ** 16n), transfer(SPX, POOL, ME, 6_912_30000000n)] })],
    });
    expect(measured).toEqual({
      sold: { token: WETH, amount: 10n ** 16n, measured: true },
      bought: { token: SPX, amount: 6_912_30000000n, measured: true },
    });
  });

  it("measures ETH sold by the transactions' value, leaving out a leg that reverted", () => {
    const measured = measureSwap({
      account: ME,
      tokenIn: NATIVE_TOKEN,
      tokenOut: SPX,
      receipts: [receipt(1, { logs: [transfer(SPX, POOL, ME, 5n)] }), receipt(2, { status: "reverted" })],
      values: [3n, 4n],
    });
    expect(measured.sold).toEqual({ token: NATIVE_TOKEN, amount: 3n, measured: true });
    expect(measured.bought.amount).toBe(5n);
    // A value that couldn't be read makes the total unknown, not smaller.
    expect(measureSwap({ account: ME, tokenIn: NATIVE_TOKEN, tokenOut: SPX, receipts: [receipt(1)], values: [null] }).sold).toEqual({
      token: NATIVE_TOKEN,
      amount: null,
      measured: false,
    });
  });

  it("measures ETH bought from the balance, adding back the fees paid meanwhile", () => {
    const measured = measureSwap({
      account: ME,
      tokenIn: SPX,
      tokenOut: NATIVE_TOKEN,
      receipts: [receipt(1, { fee: 100n, logs: [transfer(SPX, ME, POOL, 7n)] })],
      ethBalance: { before: 1_000n, after: 1_400n },
    });
    expect(measured.bought).toEqual({ token: NATIVE_TOKEN, amount: 500n, measured: true });
    expect(measureSwap({ account: ME, tokenIn: SPX, tokenOut: NATIVE_TOKEN, receipts: [receipt(1)] }).bought.amount).toBeNull();
  });

  it("measures nothing from receipts it couldn't read", () => {
    const measured = measureSwap({ account: ME, tokenIn: WETH, tokenOut: SPX, receipts: [receipt(1), null] });
    expect(measured.sold.amount).toBeNull();
    expect(measured.bought).toEqual({ token: SPX, amount: null, measured: false });
  });
});

describe("eachLimited", () => {
  it("runs every item, never more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(n);
      running -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
  });
});
