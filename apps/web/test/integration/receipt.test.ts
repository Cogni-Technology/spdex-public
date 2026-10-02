/**
 * `#receipt=` on the fork: what `verifyReceipt` says about real transactions,
 * each one made here, read back through the same endpoint.
 *
 * The unit tests pin the rules on hand-built logs. This proves they hold on
 * what the chain really emits: a swap built by the app's own routing is
 * "bought" from the pool that paid out; SPX sent to oneself delivers nothing;
 * SPX sent from one key to another is "received from" an account and never
 * "bought"; and a vault's buy, triggered by its owner, is delivered by a
 * vault the factory vouches for, asked through Multicall3 exactly as the view
 * asks.
 *
 * Every key is fresh, and the only vault touched is the one this file
 * creates, closed at the end. The factory is deployed through the
 * deterministic deployer only if the fork doesn't have it yet. The fork's
 * clock is never moved: the vault starts at the chain's own time, so its
 * first buy is due at once. Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, Hex, SpdexConfig } from "@spdex/core";
import {
  MAINNET_FACTORY,
  VAULT_LIMITS,
  buyFee,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultPlan,
} from "@spdex/vault";
import { Engine } from "../../src/lib/engine.js";
import { balanceOf } from "../../src/lib/erc20.js";
import { NATIVE_ETH, TOKEN_LIST, type TokenInfo } from "../../src/lib/tokens.js";
import { sourceText, spxPoolsFrom, verifyReceipt, type ReceiptOutcome, type SpxPool } from "../../src/lib/culture/receipt.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const SPX = TOKENS.SPX;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const word = (v: string | bigint) => (typeof v === "bigint" ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, "0");

/** A key nobody has used, given `amount` of ether. Only fresh addresses are ever given a balance. */
async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

interface Receipt {
  status: string;
  logs: RawLog[];
}

/** Sign locally, send raw, and wait for the receipt; the hash and the receipt. */
async function send(key: Hex, call: { to: Address; data: Hex; value?: bigint }): Promise<{ hash: Hex; receipt: Receipt }> {
  const tx = await prepareTransaction(rpc, { from: addressOfKey(key), to: call.to, data: call.data, value: call.value ?? 0n, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) {
      expect(BigInt(receipt.status)).toBe(1n);
      return { hash, receipt };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

const transferSpx = (to: Address, amount: bigint) => ({ to: SPX.address, data: `0xa9059cbb${word(to)}${word(amount)}` as Hex });

describe("#receipt on the fork: what the chain says a transaction did with SPX", () => {
  const config: SpdexConfig = { ...recommendedConfig(), chainId: CHAIN_ID, rpc: { url: FORK_URL, source: "user" } };
  const engine = new Engine(config);
  let spxPools: SpxPool[];
  let buyer: { key: Hex; address: Address };
  let friend: { key: Hex; address: Address };
  const vaults: { owner: Hex; vault: Address }[] = [];

  const read = (hash: Hex, factory: Address | null = MAINNET_FACTORY) => verifyReceipt(rpc, { hash, spxPools, factory });
  const delivered = (outcome: ReceiptOutcome) => {
    if (outcome.kind !== "delivered") throw new Error(`expected a delivery, got ${outcome.kind}`);
    return outcome;
  };

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    // What the view finds: the pools spDEX finds for SPX, paired with every token it lists.
    spxPools = await spxPoolsFrom(engine);
    // USDC/SPX pools among them, for the USDC buy below.
    expect(spxPools.length).toBeGreaterThan((await engine.discoverPools(NATIVE_ETH, SPX)).length);
    expect(spxPools.length).toBeGreaterThan(0);
    buyer = await freshAccount(ETHER);
    friend = await freshAccount(ETHER / 10n);
    // Pool discovery for SPX against every listed token: thousands of storage
    // reads, which a fork with nothing cached fetches from the archive endpoint
    // one at a time (CI's first run). Warm, it takes seconds.
  }, 600_000);

  afterAll(async () => {
    for (const { owner, vault } of vaults) await send(owner, { to: vault, data: encodeClose() });
  });

  let swapHash: Hex;

  it("a swap the app routed: bought, from the pool that paid out, for exactly what arrived", async () => {
    const quote = await engine.quote({ tokenIn: NATIVE_ETH, tokenOut: SPX, amountIn: ETHER / 100n, account: buyer.address });
    expect(quote.legs).toHaveLength(1);
    const before = await balanceOf(rpc, SPX.address, buyer.address);
    let last: Hex | null = null;
    for (const call of quote.legs[0]!.plan.calls) last = (await send(buyer.key, { to: call.to, data: call.data as Hex, value: call.value })).hash;
    swapHash = last!;
    const arrived = (await balanceOf(rpc, SPX.address, buyer.address)) - before;
    expect(arrived > 0n).toBe(true);

    const outcome = delivered(await read(swapHash));
    expect(outcome.deliveries).toHaveLength(1);
    const [delivery] = outcome.deliveries;
    expect(delivery!.to).toBe(buyer.address);
    expect(delivery!.amount).toBe(arrived);
    expect(delivery!.source.kind).toBe("pool");
    expect(spxPools.map((p) => p.address)).toContain(delivery!.source.kind === "pool" ? delivery!.source.pool : "");
    expect(sourceText(delivery!.source)).toMatch(/^bought from the Uniswap v[23] SPX\/WETH pool 0x[0-9a-fA-F]{40}$/);
    expect(outcome.vaults).toBe("none");
    expect(outcome.time).not.toBeNull();
  });

  /**
   * Swap `amountIn` of `tokenIn` for `tokenOut` as the app routes it,
   * approvals first; the last transaction's hash. One part only, so that one
   * receipt holds the whole trade.
   */
  async function swap(who: { key: Hex; address: Address }, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<Hex> {
    const quote = await engine.quote({ tokenIn, tokenOut, amountIn, account: who.address });
    expect(quote.legs).toHaveLength(1);
    let last: Hex | null = null;
    for (const leg of quote.legs) {
      for (const approval of leg.plan.approvals) {
        await send(who.key, { to: approval.token, data: `0x095ea7b3${word(approval.spender)}${word(approval.amount)}` as Hex });
      }
      for (const call of leg.plan.calls) last = (await send(who.key, { to: call.to, data: call.data as Hex, value: call.value })).hash;
    }
    return last!;
  }

  it("a USDC → SPX buy is bought from a USDC/SPX pool, not received from an account", async () => {
    const usdc = TOKEN_LIST.find((token) => token.symbol === "USDC")!;
    await swap(buyer, NATIVE_ETH, usdc, ETHER / 50n);
    const held = await balanceOf(rpc, usdc.address, buyer.address);
    expect(held > 0n).toBe(true);
    const before = await balanceOf(rpc, SPX.address, buyer.address);
    const hash = await swap(buyer, usdc, SPX, held / 2n);
    const arrived = (await balanceOf(rpc, SPX.address, buyer.address)) - before;
    const deliveries = delivered(await read(hash)).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ to: buyer.address, amount: arrived, source: { kind: "pool" } });
    expect(sourceText(deliveries[0]!.source)).toMatch(/^bought from the Uniswap v[23] SPX\/USDC pool 0x[0-9a-fA-F]{40}$/);
  });

  it("a sale pays SPX into a pool, which is never shown as receiving it", async () => {
    const hash = await swap(buyer, SPX, NATIVE_ETH, 10n ** 8n);
    expect((await read(hash)).kind).toBe("no-spx");
  });

  it("SPX sent to oneself delivered nothing", async () => {
    const { hash } = await send(buyer.key, transferSpx(buyer.address, 10n ** 8n));
    expect((await read(hash)).kind).toBe("no-spx");
  });

  it("SPX from one key to another was received from an account, never bought", async () => {
    const { hash } = await send(buyer.key, transferSpx(friend.address, 2n * 10n ** 8n));
    const [delivery, ...rest] = delivered(await read(hash)).deliveries;
    expect(rest).toEqual([]);
    expect(delivery).toEqual({ to: friend.address, amount: 2n * 10n ** 8n, source: { kind: "account", from: buyer.address } });
    expect(sourceText(delivery!.source)).toMatch(/^received from 0x[0-9a-fA-F]{40} \(an account\)$/);
    expect(sourceText(delivery!.source)).not.toMatch(/bought/i);
  });

  it("a vault's buy, triggered by its owner, was delivered by a vault the factory vouches for", async () => {
    const owner = await freshAccount(ETHER);
    if (((await rpc("eth_getCode", [MAINNET_FACTORY, "latest"])) as string) === "0x") {
      const deployer = await freshAccount(ETHER);
      const call = deployFactoryCall();
      // Another suite may deploy it first; losing that race reverts, and the code is there all the same.
      await send(deployer.key, { to: call.to, data: call.data }).catch(() => undefined);
    }
    expect((await rpc("eth_getCode", [MAINNET_FACTORY, "latest"])) as string).not.toBe("0x");

    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 100n;
    const plan: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: VAULT_LIMITS.MIN_INTERVAL,
      maxBuys: 1n,
      startAt: BigInt(latest.timestamp),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
    };
    const created = await send(owner.key, { to: MAINNET_FACTORY, data: encodeCreateVault(plan), value: vaultBudget(plan) });
    const [vault] = vaultsCreatedBy(MAINNET_FACTORY, created.receipt.logs);
    expect(vault).toBeDefined();
    vaults.push({ owner: owner.key, vault: vault!.vault });

    const before = await balanceOf(rpc, SPX.address, owner.address);
    const { hash } = await send(owner.key, { to: vault!.vault, data: encodeExecute() });
    const arrived = (await balanceOf(rpc, SPX.address, owner.address)) - before;

    const outcome = delivered(await read(hash));
    expect(outcome.vaults).toBe("checked");
    expect(outcome.deliveries).toEqual([{ to: owner.address, amount: arrived, source: { kind: "vault", vault: vault!.vault } }]);
    expect(sourceText(outcome.deliveries[0]!.source)).toMatch(/^delivered by a vault the factory vouches for/);

    // Without the factory's word, the same buy is only what it also is: the pair's payout.
    const unvouched = delivered(await read(hash, null));
    expect(unvouched.deliveries[0]!.source.kind).toBe("pool");
  });

  it("a hash the service doesn't know is said to be unknown", async () => {
    expect(await read(`0x${"00".repeat(31)}01`)).toEqual({ kind: "unknown" });
  });
});
