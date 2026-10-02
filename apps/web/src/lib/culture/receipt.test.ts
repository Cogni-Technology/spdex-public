import { describe, expect, it } from "vitest";
import { TOKENS, TOPICS, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { MAINNET_DEPLOYMENT, factoryAddress } from "@spdex/vault";
import { VAULT_EVENT_TOPICS } from "../dca/vault.js";
import {
  boughtEmitters,
  receiptFragment,
  receiptFromUrl,
  sourceText,
  spxDeliveries,
  spxPoolsOf,
  spxTransfers,
  verifyReceipt,
} from "./receipt.js";
import type { ReceiptLog } from "../receipts.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;
const PAIR = MAINNET_DEPLOYMENT.markets[0]!.pair;
const FACTORY = factoryAddress(MAINNET_DEPLOYMENT);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const VAULT = "0x00000000000000000000000000000000000fa017" as Address;
const ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as Address;

const word = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, "0");
const topic = (address: string) => `0x${word(address)}`;

function transfer(token: string, from: string, to: string, amount: bigint): ReceiptLog {
  return { address: token, topics: [TOPICS.transfer, topic(from), topic(to)], data: `0x${word(amount)}` };
}
const USDC_PAIR = "0xeb8261a88ebf20f6fc6fd402a50e864ffcefd4c6" as Address;
const V3_POOL = "0x00000000000000000000000000000000000f3f3f" as Address;
/** A v2 pair's Swap paying `spxOut` SPX to `to`; in the SPX/WETH and SPX/USDC pairs SPX is token1. */
const v2Swap = (pool: string, to: string = ALICE, spxOut = 0n): ReceiptLog => ({
  address: pool,
  topics: [TOPICS.uniV2Swap, topic(ROUTER), topic(to)],
  data: `0x${[10n ** 16n, 0n, 0n, spxOut].map(word).join("")}`,
});
/** A v3 pool's Swap with SPX as token1: paid in 1e16 of token0, `spxOut` SPX left the pool for `to`. */
const v3Swap = (pool: string, to: string, spxOut: bigint): ReceiptLog => ({
  address: pool,
  topics: [TOPICS.uniV3Swap, topic(ROUTER), topic(to)],
  data: `0x${[10n ** 16n, BigInt.asUintN(256, -spxOut), 1n, 1n, 0n].map(word).join("")}`,
});
function bought(vault: string, amountOut: bigint): ReceiptLog {
  const data = [10n ** 16n, amountOut, 10n ** 14n, amountOut, 1n, 10n ** 20n].map(word).join("");
  return { address: vault, topics: [VAULT_EVENT_TOPICS.Bought, `0x${word(0n)}`, topic(ALICE)], data: `0x${data}` };
}

describe("receiptFromUrl", () => {
  it("reads <chainId>:<hash>, and a bare hash as Ethereum", () => {
    expect(receiptFromUrl(`#receipt=690069:${HASH}`)).toEqual({ chainId: 690069, hash: HASH });
    expect(receiptFromUrl(`receipt=1:${HASH}`)).toEqual({ chainId: 1, hash: HASH });
    expect(receiptFromUrl(`#receipt=${HASH}`)).toEqual({ chainId: 1, hash: HASH });
    expect(receiptFromUrl(`#receipt=1:${HASH.toUpperCase().replace("0X", "0x")}`)).toEqual({ chainId: 1, hash: HASH });
    expect(receiptFromUrl(`#receipt=1%3A${HASH}`)).toEqual({ chainId: 1, hash: HASH });
  });

  it.each([
    ["", "nothing"],
    ["#config=abc", "another fragment"],
    [`#receipt=1:${HASH.slice(0, 65)}`, "a short hash"],
    [`#receipt=1:${HASH}00`, "a long hash"],
    [`#receipt=0:${HASH}`, "chain 0"],
    [`#receipt=01:${HASH}`, "a leading zero"],
    [`#receipt=-1:${HASH}`, "a negative chain"],
    [`#receipt=99999999999999999:${HASH}`, "a chain past a safe integer"],
    [`#receipt=1:${HASH}&config=x`, "something riding along"],
    [`#receipt= 1:${HASH}`, "a space"],
    [`#receipt=1:${HASH.replace("0x", "")}`, "no 0x"],
    ["#receipt=%E0%A4%A", "broken percent-encoding"],
  ])("refuses %j (%s)", (fragment) => {
    expect(receiptFromUrl(fragment)).toBeNull();
  });

  it("writes the fragment it reads back", () => {
    const target = { chainId: 690069, hash: HASH };
    expect(receiptFragment(target)).toBe(`#receipt=690069:${HASH}`);
    expect(receiptFromUrl(receiptFragment(target))).toEqual(target);
  });
});

describe("what the logs say", () => {
  const context = { spxPools: [{ address: PAIR.toUpperCase().replace("0X", "0x"), spxIsToken0: false }], vaultOwners: new Map<Address, Address>() };
  const pairOnly = [{ address: PAIR, spxIsToken0: false }];

  it("counts only SPX's own Transfer logs", () => {
    const fake = { ...transfer(SPX, PAIR, ALICE, 5n), address: "0x000000000000000000000000000000000000dead" };
    const malformed = { ...transfer(SPX, PAIR, ALICE, 5n), data: "0x05" };
    expect(spxTransfers([fake, malformed, transfer(WETH, ALICE, PAIR, 7n)])).toEqual([]);
    expect(spxTransfers([transfer(SPX, PAIR, ALICE, 5n)])).toEqual([{ from: PAIR, to: ALICE, amount: 5n }]);
  });

  it("a swap from a pool spDEX finds: bought, from the named pool, whatever case the pool list uses", () => {
    const logs = [transfer(WETH, ROUTER, PAIR, 10n ** 16n), transfer(SPX, PAIR, ALICE, 6_912_34567891n), v2Swap(PAIR, ALICE, 6_912_34567891n)];
    const [delivery, ...rest] = spxDeliveries(logs, context);
    expect(rest).toEqual([]);
    expect(delivery).toEqual({
      to: ALICE,
      amount: 6_912_34567891n,
      source: { kind: "pool", pool: PAIR, venue: "Uniswap v2", pairedWith: "WETH" },
    });
    expect(sourceText(delivery!.source)).toBe("bought from the Uniswap v2 SPX/WETH pool 0x52c77b0CB827aFbAD022E6d6CAF2C44452eDbc39");
  });

  it("a transfer between two people is received, never bought", () => {
    const [delivery] = spxDeliveries([transfer(SPX, BOB, ALICE, 100n)], context);
    expect(delivery!.source).toEqual({ kind: "account", from: BOB });
    expect(sourceText(delivery!.source)).toMatch(/^received from 0x0000000000000000000000000000000000000B0b \(an account\)$/);
    expect(sourceText(delivery!.source)).not.toMatch(/bought/i);
  });

  it("SPX that only passed through, or went to its own sender, delivered nothing", () => {
    expect(spxDeliveries([transfer(SPX, ALICE, ALICE, 100n)], context)).toEqual([]);
    const through = [transfer(SPX, BOB, ROUTER, 100n), transfer(SPX, ROUTER, BOB, 100n)];
    expect(spxDeliveries(through, context)).toEqual([]);
  });

  it("nets in against out per address", () => {
    const logs = [transfer(SPX, PAIR, ALICE, 100n), v2Swap(PAIR, ALICE, 100n), transfer(SPX, ALICE, BOB, 30n)];
    expect(spxDeliveries(logs, context).map((d) => [d.to, d.amount, d.source.kind])).toEqual([
      [ALICE, 70n, "pool"],
      [BOB, 30n, "account"],
    ]);
  });

  it("a pool that isn't one spDEX finds is an account like any other", () => {
    const logs = [transfer(SPX, PAIR, ALICE, 100n), v2Swap(PAIR, ALICE, 100n)];
    const [delivery] = spxDeliveries(logs, { spxPools: [], vaultOwners: new Map() });
    expect(delivery!.source.kind).toBe("account");
  });

  it("a vault the factory vouches for delivered its owner's buy", () => {
    const logs = [transfer(SPX, PAIR, ALICE, 500n), v2Swap(PAIR, ALICE, 500n), bought(VAULT, 500n)];
    expect(boughtEmitters(logs)).toEqual([VAULT]);
    const [delivery] = spxDeliveries(logs, { spxPools: pairOnly, vaultOwners: new Map([[VAULT, ALICE]]) });
    expect(delivery!.source).toEqual({ kind: "vault", vault: VAULT });
    expect(sourceText(delivery!.source)).toMatch(/^delivered by a vault the factory vouches for \(0x/);
    // A vouched vault owned by someone else says nothing about Alice's SPX.
    const [other] = spxDeliveries(logs, { spxPools: pairOnly, vaultOwners: new Map([[VAULT, BOB]]) });
    expect(other!.source.kind).toBe("pool");
  });

  it("credits only what a swap paid: a dust buy can't vouch for a large transfer beside it", () => {
    const logs = [transfer(SPX, PAIR, ALICE, 1n), v2Swap(PAIR, ALICE, 1n), transfer(SPX, BOB, ALICE, 10n ** 17n)];
    const deliveries = spxDeliveries(logs, context);
    expect(deliveries.map((d) => [d.to, d.amount, d.source.kind])).toEqual([
      [ALICE, 1n, "pool"],
      [ALICE, 10n ** 17n, "account"],
    ]);
    expect(sourceText(deliveries[1]!.source)).not.toMatch(/bought/i);
  });

  it("the same for a vault's buy: it delivered what it bought, and the rest was received", () => {
    const logs = [transfer(SPX, PAIR, ALICE, 500n), v2Swap(PAIR, ALICE, 500n), bought(VAULT, 500n), transfer(SPX, BOB, ALICE, 10n ** 17n)];
    expect(spxDeliveries(logs, { spxPools: pairOnly, vaultOwners: new Map([[VAULT, ALICE]]) })).toEqual([
      { to: ALICE, amount: 500n, source: { kind: "vault", vault: VAULT } },
      { to: ALICE, amount: 10n ** 17n, source: { kind: "account", from: BOB } },
    ]);
  });

  it("a pool paying out with no swap (liquidity taken out, fees collected) is never a purchase", () => {
    const [withdrawn] = spxDeliveries([transfer(SPX, PAIR, ALICE, 700n)], context);
    expect(withdrawn!.source).toEqual({ kind: "pool-payout", pool: PAIR });
    expect(sourceText(withdrawn!.source)).toMatch(/without a swap: liquidity or fees taken out, not a purchase$/);
    expect(sourceText(withdrawn!.source)).not.toMatch(/bought/i);
    // Nor with a dust swap beside it: only what the swap says it paid counts.
    const skim = [transfer(SPX, PAIR, ALICE, 10n ** 17n + 1n), v2Swap(PAIR, ALICE, 1n)];
    expect(spxDeliveries(skim, context).map((d) => [d.amount, d.source.kind])).toEqual([
      [1n, "pool"],
      [10n ** 17n, "pool-payout"],
    ]);
    // A Swap log paying someone else doesn't count for Alice.
    expect(spxDeliveries([transfer(SPX, PAIR, ALICE, 5n), v2Swap(PAIR, BOB, 5n)], context)[0]!.source.kind).toBe("pool-payout");
  });

  it("a sale pays SPX into the pool: the pool is never a receiver", () => {
    const sale = [transfer(SPX, ALICE, PAIR, 477_773n), transfer(WETH, PAIR, ALICE, 10n ** 15n)];
    expect(spxDeliveries(sale, context)).toEqual([]);
  });

  it("names several senders when the rest came from more than one", () => {
    const logs = [transfer(SPX, BOB, ALICE, 5n), transfer(SPX, ROUTER, ALICE, 9n)];
    const [delivery] = spxDeliveries(logs, context);
    expect(delivery).toEqual({ to: ALICE, amount: 14n, source: { kind: "account", from: ROUTER, others: 1 } });
    expect(sourceText(delivery!.source)).toMatch(/\(an account\) and 1 other sender$/);
  });

  it("reads a v3 pool's swap, and any SPX pool, whatever it is paired with", () => {
    const pools = spxPoolsOf([
      { poolId: PAIR, token0: WETH, token1: SPX },
      { poolId: USDC_PAIR, token0: TOKENS.USDC.address, token1: SPX },
      { poolId: V3_POOL, token0: WETH, token1: SPX },
      { poolId: "0x000000000000000000000000000000000000beef", token0: WETH, token1: TOKENS.USDC.address },
      { poolId: PAIR.toUpperCase().replace("0X", "0x"), token0: WETH, token1: SPX },
    ]);
    expect(pools).toEqual([
      { address: PAIR.toLowerCase(), spxIsToken0: false },
      { address: USDC_PAIR, spxIsToken0: false },
      { address: V3_POOL, spxIsToken0: false },
    ]);
    const usdc = [transfer(TOKENS.USDC.address, ROUTER, USDC_PAIR, 20_000_000n), transfer(SPX, USDC_PAIR, ALICE, 900n), v2Swap(USDC_PAIR, ALICE, 900n)];
    const [bought] = spxDeliveries(usdc, { spxPools: pools, vaultOwners: new Map() });
    expect(bought).toMatchObject({ amount: 900n, source: { kind: "pool", pool: USDC_PAIR, venue: "Uniswap v2", pairedWith: "USDC" } });
    const v3 = [transfer(SPX, V3_POOL, ALICE, 800n), v3Swap(V3_POOL, ALICE, 800n)];
    expect(spxDeliveries(v3, { spxPools: pools, vaultOwners: new Map() })[0]).toMatchObject({ amount: 800n, source: { kind: "pool", venue: "Uniswap v3" } });
  });
});

describe("verifyReceipt", () => {
  const receipt = (logs: ReceiptLog[], status = "0x1") => ({ from: ALICE, status, blockNumber: "0x18cba81", blockHash: HASH, logs });
  function scripted(answer: unknown, calls: string[] = []): JsonRpc {
    return async (method, params) => {
      calls.push(method);
      if (method === "eth_getTransactionReceipt") {
        expect(params).toEqual([HASH]);
        return answer;
      }
      if (method === "eth_getBlockByNumber") return { timestamp: "0x68cb2d53" };
      throw new Error(`unexpected ${method}`);
    };
  }
  const pools = [{ address: PAIR, spxIsToken0: false }];

  it("says so when the service doesn't know the transaction", async () => {
    expect(await verifyReceipt(scripted(null), { hash: HASH, spxPools: pools, factory: FACTORY })).toEqual({ kind: "unknown" });
  });

  it("a failed transaction delivered nothing, whatever its logs", async () => {
    const outcome = await verifyReceipt(scripted(receipt([transfer(SPX, PAIR, ALICE, 5n)], "0x0")), { hash: HASH, spxPools: pools, factory: FACTORY });
    expect(outcome).toEqual({ kind: "failed", block: 26_000_001n, time: 0x68cb2d53 });
  });

  it("no SPX, no delivery; and a transaction with no vault in it asks the factory nothing", async () => {
    const calls: string[] = [];
    const outcome = await verifyReceipt(scripted(receipt([transfer(WETH, ALICE, BOB, 5n)]), calls), { hash: HASH, spxPools: pools, factory: FACTORY });
    expect(outcome.kind).toBe("no-spx");
    expect(calls).toEqual(["eth_getTransactionReceipt", "eth_getBlockByNumber"]);
  });

  it("asks the factory about each vault in one batch, and believes only its yes", async () => {
    const asked: { to: string; data: string }[][] = [];
    const reader = {
      async multicall(calls: { to: Address; data: Hex }[]) {
        asked.push(calls);
        return [`0x${word(1n)}`, `0x${word(ALICE)}`];
      },
    };
    const logs = [transfer(SPX, PAIR, ALICE, 500n), v2Swap(PAIR, ALICE, 500n), bought(VAULT, 500n)];
    const outcome = await verifyReceipt(scripted(receipt(logs)), { hash: HASH, spxPools: pools, factory: FACTORY, reader });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.map((c) => c.to)).toEqual([FACTORY, VAULT]);
    // isVault(address), as viem's toFunctionSelector gives it.
    expect(asked[0]![0]!.data).toBe(`0x652b9b41${word(VAULT)}`);
    expect(asked[0]![1]!.data).toBe("0x8da5cb5b");
    expect(outcome).toMatchObject({ kind: "delivered", vaults: "checked", deliveries: [{ to: ALICE, source: { kind: "vault", vault: VAULT } }] });

    const refused = { multicall: async () => [`0x${word(0n)}`, `0x${word(ALICE)}`] };
    const notVouched = await verifyReceipt(scripted(receipt(logs)), { hash: HASH, spxPools: pools, factory: FACTORY, reader: refused });
    expect(notVouched).toMatchObject({ kind: "delivered", deliveries: [{ source: { kind: "pool" } }] });

    const garbage = { multicall: async () => ["0x", "0x1234"] };
    const unread = await verifyReceipt(scripted(receipt(logs)), { hash: HASH, spxPools: pools, factory: FACTORY, reader: garbage });
    expect(unread).toMatchObject({ kind: "delivered", deliveries: [{ source: { kind: "pool" } }] });
  });

  it("a failed vault check credits no vault, and says the check didn't happen", async () => {
    const failing = { multicall: async () => Promise.reject(new Error("rate limited")) };
    const logs = [transfer(SPX, PAIR, ALICE, 500n), v2Swap(PAIR, ALICE, 500n), bought(VAULT, 500n)];
    const outcome = await verifyReceipt(scripted(receipt(logs)), { hash: HASH, spxPools: pools, factory: FACTORY, reader: failing });
    expect(outcome).toMatchObject({ kind: "delivered", vaults: "unavailable", deliveries: [{ source: { kind: "pool" } }] });
  });

  it("with no factory, a vault's Bought is never asked about", async () => {
    const reader = { multicall: async () => Promise.reject(new Error("must not be called")) };
    const logs = [transfer(SPX, PAIR, ALICE, 500n), v2Swap(PAIR, ALICE, 500n), bought(VAULT, 500n)];
    const outcome = await verifyReceipt(scripted(receipt(logs)), { hash: HASH, spxPools: pools, factory: null, reader });
    expect(outcome).toMatchObject({ kind: "delivered", vaults: "none" });
  });

  it("an unreadable block leaves the time unknown, not the answer", async () => {
    const rpc: JsonRpc = async (method) => {
      if (method === "eth_getTransactionReceipt") return receipt([transfer(SPX, BOB, ALICE, 1n)]);
      throw new Error("no");
    };
    expect(await verifyReceipt(rpc, { hash: HASH, spxPools: pools, factory: null })).toMatchObject({ kind: "delivered", time: null });
  });

  it("throws when the service can't be asked at all, so the view can offer to try again", async () => {
    const rpc: JsonRpc = async () => Promise.reject(new Error("connection refused"));
    await expect(verifyReceipt(rpc, { hash: HASH, spxPools: pools, factory: null })).rejects.toThrow("connection refused");
  });
});
