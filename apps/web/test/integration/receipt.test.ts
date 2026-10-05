/**
 * `#receipt=` on the fork: what `verifyReceipt` says about real transactions,
 * each one made here, read back through the same endpoint.
 *
 * The unit tests pin the rules on hand-built logs. This proves they hold on
 * what the chain really emits: a swap built by the app's own routing is
 * "bought" from the pool that paid out; SPX sent to oneself delivers nothing;
 * SPX sent from one key to another is "received from" an account and never
 * "bought"; and a vault's buy, triggered by its owner, is delivered by a
 * vault its factory vouches for, asked through Multicall3 exactly as the view
 * asks: every release's factory, so a v1 vault's buy is still credited to it
 * once v2's factory makes the new ones.
 *
 * Every key is fresh, and the only vaults touched are the two this file
 * creates, closed at the end. Each release's contracts are deployed through
 * the deterministic deployer only if the fork doesn't have them yet. The
 * fork's clock is never moved: each vault starts at the chain's own time, so
 * its first buy is due at once, and v2's owner pays its fee back to itself,
 * which its community window allows. Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, Hex, SpdexConfig } from "@spdex/core";
import {
  MAINNET_FACTORY,
  V1_MAINNET_FACTORY,
  VAULT_LIMITS,
  buyFee,
  defaultCommunityWindow,
  deployReleaseCalls,
  encodeClose,
  encodeCreateVault,
  encodeTrigger,
  v1BuyFee,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultPlan,
  type VaultRelease,
} from "@spdex/vault";
import { Engine } from "../../src/lib/engine.js";
import { balanceOf } from "../../src/lib/erc20.js";
import { NATIVE_ETH, TOKEN_LIST, type TokenInfo } from "../../src/lib/tokens.js";
import { VAULT_FACTORIES, sourceText, spxPoolsFrom, verifyReceipt, type ReceiptOutcome, type SpxPool } from "../../src/lib/culture/receipt.js";

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

/**
 * v1's `createVault(marketIndex, amountPerBuy, interval, maxBuys, startAt,
 * keeperReward, maxSlippageBps)`: seven words after its selector (V1_FACTORY_ABI),
 * written out because this app encodes only v2's. A wrong selector would
 * revert, and the test would say so.
 */
const createVaultV1 = (args: readonly bigint[]): Hex => `0x3f8f7b79${args.map(word).join("")}`;

/** Put `release`'s contracts on the fork, those not there yet, in order; another suite may win the race, and the code is there all the same. */
async function ensureRelease(release: VaultRelease, deploy: () => Promise<{ key: Hex }>): Promise<void> {
  let deployer: { key: Hex } | null = null;
  for (const call of deployReleaseCalls(release)) {
    if (((await rpc("eth_getCode", [call.address, "latest"])) as string) !== "0x") continue;
    deployer ??= await deploy();
    await send(deployer.key, { to: call.to, data: call.data, value: call.value }).catch(() => undefined);
    expect((await rpc("eth_getCode", [call.address, "latest"])) as string).not.toBe("0x");
  }
}

describe("#receipt on the fork: what the chain says a transaction did with SPX", () => {
  const config: SpdexConfig = { ...recommendedConfig(), chainId: CHAIN_ID, rpc: { url: FORK_URL, source: "user" } };
  const engine = new Engine(config);
  let spxPools: SpxPool[];
  let buyer: { key: Hex; address: Address };
  let friend: { key: Hex; address: Address };
  const vaults: { owner: Hex; vault: Address }[] = [];

  const read = (hash: Hex, factories: readonly Address[] = VAULT_FACTORIES) => verifyReceipt(rpc, { hash, spxPools, factories });
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

  /** A one-buy vault of `release`, due at once, made by a fresh owner; the owner and its address. */
  async function oneBuyVault(release: VaultRelease): Promise<{ owner: { key: Hex; address: Address }; vault: Address }> {
    await ensureRelease(release, () => freshAccount(ETHER));
    const owner = await freshAccount(ETHER);
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 100n;
    const interval = VAULT_LIMITS.MIN_INTERVAL;
    const factory = release === "v1" ? V1_MAINNET_FACTORY : MAINNET_FACTORY;
    let created: { receipt: Receipt };
    if (release === "v1") {
      const keeperReward = v1BuyFee(amountPerBuy).reward;
      const args = [0n, amountPerBuy, interval, 1n, BigInt(latest.timestamp), keeperReward, 300n];
      created = await send(owner.key, { to: factory, data: createVaultV1(args), value: vaultBudget({ maxBuys: 1n, amountPerBuy, keeperReward }) });
    } else {
      const plan: VaultPlan = {
        marketIndex: 0n,
        amountPerBuy,
        interval,
        maxBuys: 1n,
        startAt: BigInt(latest.timestamp),
        keeperReward: buyFee(amountPerBuy).reward,
        maxSlippageBps: 300n,
        communityWindow: defaultCommunityWindow(interval),
        turnBuckets: 0n,
      };
      created = await send(owner.key, { to: factory, data: encodeCreateVault(plan), value: vaultBudget(plan) });
    }
    const [vault] = vaultsCreatedBy(factory, created.receipt.logs);
    // Laid out as its release's source: v1's, or v2's for the latest.
    expect(vault).toMatchObject({ source: release, owner: owner.address.toLowerCase() });
    vaults.push({ owner: owner.key, vault: vault!.vault });
    return { owner, vault: vault!.vault };
  }

  /** The owner's own trigger (Trigger now): v2's pays its fee back to the owner, v1's to its caller, the owner. */
  async function triggerOwn(release: VaultRelease, made: { owner: { key: Hex; address: Address }; vault: Address }): Promise<{ hash: Hex; arrived: bigint }> {
    const before = await balanceOf(rpc, SPX.address, made.owner.address);
    const { hash } = await send(made.owner.key, { to: made.vault, data: encodeTrigger({ release, owner: made.owner.address }) });
    return { hash, arrived: (await balanceOf(rpc, SPX.address, made.owner.address)) - before };
  }

  it("a v2 vault's buy, triggered by its owner, was delivered by a vault its factory vouches for", async () => {
    const made = await oneBuyVault("v2");
    const { hash, arrived } = await triggerOwn("v2", made);

    const outcome = delivered(await read(hash));
    expect(outcome.vaults).toBe("checked");
    expect(outcome.deliveries).toEqual([{ to: made.owner.address, amount: arrived, source: { kind: "vault", vault: made.vault } }]);
    expect(sourceText(outcome.deliveries[0]!.source)).toMatch(/^delivered by a vault the factory vouches for/);

    // Without a factory's word, the same buy is only what it also is: the pair's payout.
    const unvouched = delivered(await read(hash, []));
    expect(unvouched.deliveries[0]!.source.kind).toBe("pool");
  });

  it("a v1 vault's buy is still its vault's: only v1's factory vouches for it, and the view asks both", async () => {
    const made = await oneBuyVault("v1");
    const { hash, arrived } = await triggerOwn("v1", made);

    const outcome = delivered(await read(hash));
    expect(outcome.vaults).toBe("checked");
    expect(outcome.deliveries).toEqual([{ to: made.owner.address, amount: arrived, source: { kind: "vault", vault: made.vault } }]);

    // Asked of this build's factory alone, as the view once was, a v1 vault's buy loses its vault.
    const v2Only = delivered(await read(hash, [MAINNET_FACTORY]));
    expect(v2Only).toMatchObject({ vaults: "checked", deliveries: [{ to: made.owner.address, amount: arrived, source: { kind: "pool" } }] });
  });

  it("a hash the service doesn't know is said to be unknown", async () => {
    expect(await read(`0x${"00".repeat(31)}01`)).toEqual({ kind: "unknown" });
  });
});
