/**
 * A vault's whole life on the local fork, through the TypeScript layer the app
 * and the keeper use: deploy the factory the way the app offers to (through the
 * deterministic deployer, if it is not there yet — the phase-5a factory may
 * still be on the fork at its old address; nothing refers to it any more),
 * predict where a vault will land, create it from a fresh address with part of
 * its budget in the same transaction, find it exactly there with exactly the
 * code predicted and in the factory's list, top it up, let one keeper tick buy
 * it through the batcher, and close it. A second vault is bought the way
 * "Trigger now" buys one: a direct `execute` from a fresh address.
 *
 * The forge tests (`test/forge`) prove the contract's rules on a fork of their
 * own, with time moved freely. This proves the other half: that what the
 * encoders build is what the contracts accept, that `readVault` and the keeper
 * read the chain the way the contract means it, and that a real direct buy's
 * gas stays inside `EXECUTE_GAS`, the figure "Trigger now" sets its gas floor
 * above. The keeper's own cases are `keeper.test.ts`'s; here it only has to
 * agree with `readVault` about one vault.
 *
 * The shared fork's clock is never touched. Its blocks carry wall-clock time,
 * so the plan is given the shortest interval with its first window already
 * nearly over: one buy lands in it, and the test checks the next is refused
 * until half an interval after it. A second buy would mean waiting that out in
 * real time (150 seconds), so later buys, and every timing edge, are the forge
 * tests' to prove, where time can be moved. Every address is fresh:
 * anvil's default accounts carry an EIP-7702 delegation inherited from mainnet
 * (see modules/venue-uniswap-v2's native test) and are shared by every suite.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import {
  TOKENS,
  addressOfKey,
  generateSpendingKey,
  httpRpc,
  prepareTransaction,
  signPrepared,
} from "@spdex/chain";
import {
  DETERMINISTIC_DEPLOYER,
  EXECUTE_GAS,
  FACTORY_ABI,
  FACTORY_LIMITS,
  FACTORY_SALT,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  VAULT_ABI,
  VAULT_LIMITS,
  batcherAddress,
  buyFee,
  decodeBatcherEvent,
  decodeVaultEvent,
  deployBatcherCall,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  factoryAddress,
  implementationAddress,
  predictVault,
  readVault,
  readVaultCount,
  readVaultNonce,
  readVaultsPage,
  simulateFactoryDeployment,
  termsOfPlan,
  factoryInitCode,
  vaultAvailability,
  vaultBudget,
  vaultRuntimeCode,
  vaultsCreatedBy,
  whyNotNow,
  type VaultPlan,
  type VaultTerms,
} from "../../src/index.js";
import { keeperConfig, keeperTick, newKeeperState, type KeeperState } from "../../src/keeper.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);

const WETH = TOKENS.WETH.address;
const SPX = TOKENS.SPX.address;
/** Uniswap v2 SPX/WETH, and the 0.3% v3 pool: the markets `vaultAvailability` must find. */
const SPX_WETH_PAIR: Address = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";
const SPX_WETH_POOL: Address = "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3";
const ETHER = 10n ** 18n;
/** Seconds of the first buy window left when the vault is created: room for create, fund and one keeper tick. */
const FIRST_WINDOW_LEFT = 30n;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner] }) },
    "latest",
  ])) as Hex;
  return decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data });
}

const ethBalance = async (owner: Address) => BigInt((await rpc("eth_getBalance", [owner, "latest"])) as string);

/** A key nobody has used, funded with `amount` if asked. Only fresh addresses are ever given a balance. */
async function freshAccount(amount?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  if (amount !== undefined) await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

interface Receipt {
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string; logIndex?: string }[];
}

/** Sign locally, send raw, wait for the receipt, insist it succeeded. */
async function send(key: Hex, to: Address, data: Hex, value = 0n): Promise<Receipt> {
  const tx = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) {
      expect(BigInt(receipt.status)).toBe(1n);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

const feePaid = (receipt: Receipt) => BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);

/**
 * Have the fork mine a block at the present moment, with an ordinary transfer
 * of one wei between two fresh addresses. Its clock is not moved: the block
 * simply carries the time the node already had.
 */
async function mineNow(): Promise<{ timestamp: string; number: string }> {
  const from = await freshAccount(ETHER / 100n);
  const to = await freshAccount();
  await send(from.key, to.address, "0x", 1n);
  return (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string; number: string };
}

/** A view on the factory, through its ABI. */
async function factoryView<T>(factory: Address, functionName: string, args: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: functionName as never, args: args as never });
  const result = (await rpc("eth_call", [{ to: factory, data }, "latest"])) as Hex;
  return decodeFunctionResult({ abi: FACTORY_ABI, functionName: functionName as never, data: result }) as T;
}

describe("a vault's life on the fork, through @spdex/vault", () => {
  const factory = factoryAddress(MAINNET_DEPLOYMENT);
  const gas: Record<string, bigint> = {};

  let owner: { key: Hex; address: Address };
  let keeper: { key: Hex; address: Address };
  /** Where the keeper's batches pay: an address of its operator's, not the keeper's hot key. */
  let rewardTo: Address;
  let plan: VaultPlan;
  let terms: VaultTerms;
  let vault: Address;
  /** The keeper's state across ticks, as `pnpm keeper` keeps it in its state file. */
  let keeperState: KeeperState;
  /**
   * One keeper tick, as `pnpm keeper` runs it, but limited to this file's
   * vault by an allowlist, sending as soon as a vault is due, and counting a
   * batch mined at one confirmation with the head-lag check off: an idle
   * fork's head is days behind the wall clock, and no block is mined here
   * but by this file's own transactions.
   */
  const tick = () =>
    keeperTick(rpc, {
      config: keeperConfig({
        chainId: CHAIN_ID,
        keeperKey: keeper.key,
        rewardTo,
        vaults: [vault],
        policy: { sendWhen: "now", confirmations: 1, maxHeadLagSeconds: 0n },
      }),
      state: keeperState,
      waitForReceiptMs: 120_000,
    });

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    owner = await freshAccount(2n * ETHER);
    keeper = await freshAccount(ETHER / 10n);
    rewardTo = (await freshAccount()).address;
    keeperState = newKeeperState({ chainId: CHAIN_ID, keeper: keeper.address });
  });

  it("finds the factory, deploying it through the deterministic deployer if it is absent", async () => {
    expect(factory).toBe(MAINNET_FACTORY);
    if (((await rpc("eth_getCode", [factory, "latest"])) as string) === "0x") {
      // Not offered yet: the app would say why, and offer this transaction — having
      // simulated it, since through the deployer a refusal would say nothing.
      expect(await vaultAvailability(rpc)).toMatchObject({ available: false, factoryDeployed: false, factoryDeployable: true });
      const deployer = await freshAccount(ETHER);
      const call = deployFactoryCall();
      expect(call.factory).toBe(factory);
      const receipt = await send(deployer.key, call.to, call.data, call.value);
      gas["deploy factory"] = BigInt(receipt.gasUsed);
    }
    expect(await rpc("eth_getCode", [factory, "latest"])).not.toBe("0x");
    expect((await factoryView<string>(factory, "weth")).toLowerCase()).toBe(WETH);
    expect(await factoryView<bigint>(factory, "marketCount")).toBe(1n);
    const market = await factoryView<readonly [string, string, string]>(factory, "markets", [0n]);
    expect(market.map((a) => a.toLowerCase())).toEqual([SPX, SPX_WETH_PAIR, SPX_WETH_POOL]);
    expect((await factoryView<string>(factory, "implementation")).toLowerCase()).toBe(implementationAddress(factory));
  });

  it("finds the factory's batcher, deploying it the same way if it is absent", async () => {
    // Anyone may deploy it, once: its address commits to its code and its factory.
    expect(batcherAddress(factory)).toBe(MAINNET_BATCHER);
    if (((await rpc("eth_getCode", [MAINNET_BATCHER, "latest"])) as string) === "0x") {
      const deployer = await freshAccount(ETHER);
      const call = deployBatcherCall(factory);
      expect(call.batcher).toBe(MAINNET_BATCHER);
      const receipt = await send(deployer.key, call.to, call.data, call.value);
      gas["deploy batcher"] = BigInt(receipt.gasUsed);
    }
    expect(await rpc("eth_getCode", [MAINNET_BATCHER, "latest"])).not.toBe("0x");
  });

  it("a deployment the listing checks refuse is named by simulating it, and says nothing through the deployer", async () => {
    // SPX's market with USDC's pool as its oracle: a pool Uniswap lists, but not for SPX.
    const wrong = {
      ...MAINNET_DEPLOYMENT,
      markets: [{ ...MAINNET_DEPLOYMENT.markets[0]!, oraclePool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" as Address }],
    };
    expect(await simulateFactoryDeployment(rpc)).toEqual({ deployable: true });
    expect(await simulateFactoryDeployment(rpc, wrong)).toEqual({
      deployable: false,
      error: { name: "PoolNotFromUniswap", args: [0n] },
      reason: "market 0's pool is not one Uniswap v3 lists on this chain",
    });
    // The same creation through the deterministic deployer: a revert with no reason at all.
    const through = rpc("eth_call", [
      { to: DETERMINISTIC_DEPLOYER, data: `0x${FACTORY_SALT.slice(2)}${factoryInitCode(wrong).slice(2)}` },
      "latest",
    ]);
    await expect(through).rejects.toMatchObject({ data: "0x" });
  });

  it("the implementation refuses to be called as a vault", async () => {
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "terms" });
    await expect(rpc("eth_call", [{ to: implementationAddress(factory), data }, "latest"])).rejects.toThrow();
  });

  it("offers a vault on SPX's market, the pair and pool the forge tests use", async () => {
    const availability = await vaultAvailability(rpc);
    expect(availability).toMatchObject({
      available: true,
      factory,
      factoryDeployed: true,
      market: { index: 0, tokenOut: SPX, pair: SPX_WETH_PAIR, oraclePool: SPX_WETH_POOL },
      factoryDeployable: null,
      marketHealthy: true,
      reasons: [],
    });
    expect(availability.oracleDepth).toBeGreaterThanOrEqual(VAULT_LIMITS.MIN_ORACLE_DEPTH);
    // The shared fork has no arbitrageurs, so this holds only while no test moves one venue
    // far from the other: the listing's allowance, either way.
    expect(availability.marketGapBps! <= FACTORY_LIMITS.MAX_MARKET_GAP_BPS).toBe(true);
    expect(availability.marketGapBps! >= -FACTORY_LIMITS.MAX_MARKET_GAP_BPS).toBe(true);
    // And no market past the end of the list.
    expect((await vaultAvailability(rpc, { marketIndex: 1 })).available).toBe(false);
  });

  it("creates a vault from a fresh address, funded in the same transaction, with the terms in the event", async () => {
    // The fork mines only when sent a transaction, so the latest block can be
    // minutes old. Mine one now, so its time is a fair guess at the next one's.
    const block = await mineNow();
    const amountPerBuy = ETHER / 100n;
    plan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: VAULT_LIMITS.MIN_INTERVAL,
      maxBuys: 3n,
      // Chain time, never the wall clock: the vault judges time by blocks. The
      // first window closes FIRST_WINDOW_LEFT seconds after this block.
      startAt: BigInt(block.timestamp) - VAULT_LIMITS.MIN_INTERVAL + FIRST_WINDOW_LEFT,
      // The buy fee the app proposes: one batched buy's network cost and a tenth more, at most 0.69%.
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
    };
    terms = termsOfPlan(plan);

    // Where it will be, before it exists: computed here, and asked of the factory.
    const nonce = await readVaultNonce(rpc, factory, owner.address);
    expect(nonce).toBe(0n);
    const predicted = predictVault({ factory, owner: owner.address, nonce, terms });
    const asked = await factoryView<string>(factory, "predictVault", [
      owner.address,
      nonce,
      plan.marketIndex,
      plan.amountPerBuy,
      plan.interval,
      plan.maxBuys,
      plan.startAt,
      plan.keeperReward,
      plan.maxSlippageBps,
    ]);
    expect(asked.toLowerCase()).toBe(predicted);
    expect(await rpc("eth_getCode", [predicted, "latest"])).toBe("0x");

    // One buy's worth now, with the creation: the rest comes in the next step.
    const firstBuy = plan.amountPerBuy + plan.keeperReward;
    const listedBefore = await readVaultCount(rpc, factory);
    const receipt = await send(owner.key, factory, encodeCreateVault(plan), firstBuy);
    gas["createVault (funding one buy)"] = BigInt(receipt.gasUsed);
    // Read the way the Guard must: only the factory's own log counts.
    const [created, ...others] = vaultsCreatedBy(factory, receipt.logs);
    expect(others).toEqual([]);
    if (!created) throw new Error("no VaultCreated from the factory in the receipt");
    expect(created.emitter).toBe(factory);
    expect(created.owner).toBe(owner.address);
    expect(created.marketIndex).toBe(0n);
    expect(created.terms).toEqual(terms);
    // What the creation carried, from the factory's event rather than WETH's logs.
    expect(created.funded).toBe(firstBuy);
    vault = created.vault;
    expect(vault).toBe(predicted);
    // And in the factory's own list, which keepers read instead of its logs. Other
    // files may create vaults too, so it is looked for from the count before, not at it.
    expect(await readVaultCount(rpc, factory)).toBeGreaterThan(listedBefore);
    expect(await readVaultsPage(rpc, factory, listedBefore, 1_000n)).toContain(vault);
    // Exactly the clone predicted: the proxy for the implementation, then these terms.
    expect(await rpc("eth_getCode", [vault, "latest"])).toBe(vaultRuntimeCode(implementationAddress(factory), owner.address, terms));
    expect(await balanceOf(WETH, vault)).toBe(firstBuy);
    expect(await readVaultNonce(rpc, factory, owner.address)).toBe(1n);
  });

  it("creating a vault costs a clone's worth of gas, not a contract's", async () => {
    // A second owner, the same plan, no ether: the bare cost of creation, for the record.
    const other = await freshAccount(ETHER / 10n);
    const receipt = await send(other.key, factory, encodeCreateVault(plan));
    gas["createVault (no funding)"] = BigInt(receipt.gasUsed);
    // The bound `Vault.t.sol`'s test_gas holds createVault to: about 29,000 of it
    // is the factory's list (a new slot and its length), which a clone's code is not.
    expect(BigInt(receipt.gasUsed)).toBeLessThan(181_000n);
  });

  it("tops it up to exactly its budget, sending back what the plan does not need", async () => {
    // Sent the whole budget again: only the rest is kept, and the excess comes back.
    const before = await ethBalance(owner.address);
    const receipt = await send(owner.key, vault, encodeFund(), vaultBudget(terms));
    gas["fund"] = BigInt(receipt.gasUsed);
    const firstBuy = terms.amountPerBuy + terms.keeperReward;
    expect(await balanceOf(WETH, vault)).toBe(vaultBudget(terms));
    expect(before - (await ethBalance(owner.address))).toBe(vaultBudget(terms) - firstBuy + feePaid(receipt));
    expect(await ethBalance(vault)).toBe(0n);

    const state = await readVault(rpc, vault, { factory });
    expect(state).not.toBeNull();
    expect(state!.owner).toBe(owner.address);
    expect(state!.terms).toEqual(terms);
    expect(state!.fromFactory).toBe(true);
    expect(state!.status).toMatchObject({ due: true, funded: true, buysLeft: 3n, wethBalance: vaultBudget(terms) });
    expect(state!.quote).not.toBeNull();
    expect(state!.quote!.spotOut).toBeGreaterThanOrEqual(state!.quote!.floorOut);
    // The vault's clock, read in the same batch: the latest block's, not the wall clock's.
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    expect(state!.chainTime).toBe(BigInt(latest.timestamp));
    expect(whyNotNow(state!)).toBeNull();

    // The depth the app reads before offering a vault is the depth the vault measures.
    const availability = await vaultAvailability(rpc);
    expect(availability.oracleDepth).toBe(state!.quote!.oracleDepth);
  });

  it("the limits are the ones mirrored into TypeScript, on the vault and the factory alike", async () => {
    for (const [name, value] of Object.entries(VAULT_LIMITS)) {
      const data = encodeFunctionData({ abi: VAULT_ABI, functionName: name as keyof typeof VAULT_LIMITS });
      expect(BigInt((await rpc("eth_call", [{ to: vault, data }, "latest"])) as string), name).toBe(value);
      expect(await factoryView<bigint>(factory, name), name).toBe(value);
    }
    expect(await factoryView<bigint>(factory, "MAX_MARKET_GAP_BPS")).toBe(FACTORY_LIMITS.MAX_MARKET_GAP_BPS);
  });

  it("one keeper tick buys it through the batcher, and the fee lands at rewardTo", async () => {
    const before = await readVault(rpc, vault);
    const spxBefore = await balanceOf(SPX, owner.address);
    const result = await tick();

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]!.vaults).toEqual([vault]);
    expect(result.mined).toHaveLength(1);
    const mined = result.mined[0]!;
    expect(mined).toMatchObject({ status: "success", refused: [], notTried: [], earnedWei: terms.keeperReward });
    expect(mined.bought.map((b) => [b.vault, b.buyNumber, b.reward])).toEqual([[vault, 1n, terms.keeperReward]]);

    const received = (await balanceOf(SPX, owner.address)) - spxBefore;
    expect(received).toBeGreaterThanOrEqual(before!.quote!.floorOut);
    expect(await balanceOf(SPX, vault)).toBe(0n);
    // The vault paid its caller, the batcher, which passed every wei on to
    // rewardTo in the same transaction and kept nothing; the keeper's hot key got none.
    expect(await balanceOf(WETH, rewardTo)).toBe(terms.keeperReward);
    expect(await balanceOf(WETH, MAINNET_BATCHER)).toBe(0n);
    expect(await balanceOf(WETH, keeper.address)).toBe(0n);

    // The receipt says the same, joined by log index: the vault's Bought names
    // the batcher as its caller, and the batcher's Triggered follows it.
    const receipt = (await rpc("eth_getTransactionReceipt", [mined.hash])) as Receipt;
    const vaultEvents = receipt.logs.map(decodeVaultEvent);
    const batcherEvents = receipt.logs.map((log) => decodeBatcherEvent(MAINNET_BATCHER, log));
    const at = vaultEvents.findIndex((event) => event?.name === "Bought");
    const bought = vaultEvents[at] as Extract<ReturnType<typeof decodeVaultEvent>, { name: "Bought" }>;
    expect(bought).toMatchObject({ emitter: vault, keeper: MAINNET_BATCHER, amountIn: terms.amountPerBuy, amountOut: received, reward: terms.keeperReward, buyNumber: 1n });
    expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
    expect(bought.oracleDepth).toBeGreaterThanOrEqual(VAULT_LIMITS.MIN_ORACLE_DEPTH);
    expect(batcherEvents[at + 1]).toMatchObject({ name: "Triggered", vault, received });
    expect(batcherEvents.find((event) => event?.name === "Batch")).toMatchObject({ caller: keeper.address, rewardTo, bought: 1n, earned: terms.keeperReward, swept: 0n });

    const after = await readVault(rpc, vault);
    expect(after!.buysDone).toBe(1n);
    expect(after!.totalOut).toBe(received);
    expect(after!.totalRewards).toBe(terms.keeperReward);
    expect(after!.status.due).toBe(false);
  });

  it("the next tick leaves it alone until half an interval after the buy, and says when", async () => {
    const lastBuyAt = BigInt(
      (await rpc("eth_call", [{ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "lastBuyAt" }) }, "latest"])) as string,
    );
    // The buy came in the last seconds of window 0, so window 1 opens first and the spacing decides.
    const spaced = lastBuyAt + terms.interval / 2n;
    expect(spaced).toBeGreaterThan(terms.startAt + terms.interval);
    expect((await readVault(rpc, vault))!.status).toMatchObject({ due: false, nextBuyAt: spaced });

    // The keeper works it out from the terms it cached, and agrees with the vault.
    const result = await tick();
    expect(result.sent).toEqual([]);
    expect(result.upcoming).toEqual([{ vault, nextBuyAt: spaced }]);
  });

  it("a due buy triggered directly, as Trigger now does, stays inside EXECUTE_GAS and pays its caller", async () => {
    // Its own vault, due at once: the first vault's next window is minutes away.
    const latest = await mineNow();
    const direct: VaultPlan = { ...plan, maxBuys: 1n, startAt: BigInt(latest.timestamp) };
    const created = vaultsCreatedBy(factory, (await send(owner.key, factory, encodeCreateVault(direct), vaultBudget(direct))).logs)[0]!;
    const caller = await freshAccount(ETHER / 10n);

    const receipt = await send(caller.key, created.vault, encodeExecute());
    // The dearest buy there is: a plan's first, which writes its slots from zero.
    gas["execute (first buy, direct)"] = BigInt(receipt.gasUsed);
    expect(BigInt(receipt.gasUsed)).toBeLessThanOrEqual(EXECUTE_GAS);
    const bought = receipt.logs.map(decodeVaultEvent).find((event) => event?.name === "Bought");
    expect(bought).toMatchObject({ emitter: created.vault, keeper: caller.address, reward: direct.keeperReward, buyNumber: 1n });
    expect(await balanceOf(WETH, caller.address)).toBe(direct.keeperReward);
    // One buy was all it had: it is done, and holds nothing more.
    expect((await readVault(rpc, created.vault))!.status).toMatchObject({ due: false, buysLeft: 0n });
    expect(await balanceOf(WETH, created.vault)).toBe(0n);
  });

  it("closing returns everything left to the owner as ether", async () => {
    const held = await balanceOf(WETH, vault);
    expect(held).toBe(vaultBudget(terms) - (terms.amountPerBuy + terms.keeperReward));
    const before = await ethBalance(owner.address);

    const receipt = await send(owner.key, vault, encodeClose());
    gas["close"] = BigInt(receipt.gasUsed);
    expect(await ethBalance(owner.address)).toBe(before - feePaid(receipt) + held);
    expect(await balanceOf(WETH, vault)).toBe(0n);
    expect(await ethBalance(vault)).toBe(0n);
    const closed = receipt.logs.map(decodeVaultEvent).find((event) => event?.name === "Closed");
    expect(closed).toMatchObject({ name: "Closed", emitter: vault, amount: held });

    const state = await readVault(rpc, vault);
    expect(state!.closed).toBe(true);
    expect(state!.status).toMatchObject({ due: false, buysLeft: 0n, nextBuyAt: null });

    // Printed so the figures in EXECUTE_GAS's comment can be re-checked by eye.
    console.log(
      "vault gas on the fork:",
      Object.entries(gas)
        .map(([what, used]) => `${what} ${used}`)
        .join(", "),
    );
  });
});
