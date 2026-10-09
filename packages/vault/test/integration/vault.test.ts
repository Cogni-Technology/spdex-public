/**
 * A vault's whole life on the local fork, through the TypeScript layer the app
 * and the keeper use: deploy the SPX holder registry and the factory the way
 * the app offers to (through the deterministic deployer, registry first, if
 * they are not there yet), predict where a vault will land, create it from a
 * fresh address with part of its budget in the same transaction, find it
 * exactly there with exactly the code predicted and in the factory's list, top
 * it up, let one keeper tick buy it through the batcher once its community
 * window is over, and close it. A second vault, inside its window, refuses a
 * stranger who names itself and is bought the way "Trigger now" buys one: a
 * direct `execute(owner)`, here from a fresh address. Vaults made with turns
 * work out their buckets and turns as the TypeScript does, and refuse an
 * eligible holder off its turn exactly when `onTurn` says. A v1 vault, made on
 * v1's frozen factory, still reads, buys for whoever calls it, funds and
 * closes.
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
 * so the plan is given the shortest interval with its first slot already
 * nearly over, and so its 75-second community window long over: one buy lands
 * in it, from a keeper paying an address that never proved anything, and the
 * test checks the next is refused until half an interval after it. A second
 * buy would mean waiting that out in real time (150 seconds), so later buys,
 * and every timing edge, are the forge tests' to prove, where time can be
 * moved (`test/forge/Window.t.sol`). Every address is fresh:
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
  MAINNET_REGISTRY,
  V1_FACTORY_ABI,
  V1_MAINNET_FACTORY,
  VAULT_ABI,
  VAULT_LIMITS,
  batcherAddress,
  buyFee,
  buyMaker,
  communityWindowEndsAt,
  decodeVaultError,
  defaultCommunityWindow,
  deployRegistryCall,
  encodeExecuteV1,
  encodeTrigger,
  v1BuyFee,
  vaultCommunityWindow,
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
  DEFAULT_TURN_BUCKETS,
  bucketOf,
  onTurn,
  turnEndsAtOf,
  turnOf,
  type VaultPlan,
  type VaultTerms,
} from "../../src/index.js";
import { keeperConfig, keeperTick, newKeeperState, type KeeperState } from "../../src/keeper.js";
import { HOLDER, ensureHolderProven, ensureRelease, revertOf } from "./fork.js";

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
  /** A second vault, bought inside its community window by a direct `execute(owner)`. */
  let directVault: Address;
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

  it("finds the registry and the factory, deploying them through the deterministic deployer if they are absent, registry first", async () => {
    expect(factory).toBe(MAINNET_FACTORY);
    const hasCode = async (address: Address) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";
    /** Another suite may deploy it first, even between the check and the send: the code is there either way. */
    const deploy = async (call: { to: Address; data: Hex; value: bigint }, at: Address, what: string) => {
      const deployer = await freshAccount(ETHER);
      try {
        gas[what] = BigInt((await send(deployer.key, call.to, call.data, call.value)).gasUsed);
      } catch {
        // Refused at the estimate: deployed in between.
      }
      expect(await hasCode(at)).toBe(true);
    };
    if (!(await hasCode(MAINNET_REGISTRY))) {
      // Neither is there: the app says the registry goes first, and can't judge the factory's deployment yet.
      expect(await vaultAvailability(rpc)).toMatchObject({ available: false, factoryDeployed: false, registryDeployed: false, factoryDeployable: null });
      const call = deployRegistryCall();
      expect(call.registry).toBe(MAINNET_REGISTRY);
      await deploy(call, MAINNET_REGISTRY, "deploy registry");
    }
    if (!(await hasCode(factory))) {
      // Not offered yet: the app would say why, and offer this transaction — having
      // simulated it, since through the deployer a refusal would say nothing.
      expect(await vaultAvailability(rpc)).toMatchObject({ available: false, factoryDeployed: false, registryDeployed: true, factoryDeployable: true });
      const call = deployFactoryCall();
      expect(call.factory).toBe(factory);
      await deploy(call, factory, "deploy factory");
    }
    expect((await factoryView<string>(factory, "weth")).toLowerCase()).toBe(WETH);
    expect((await factoryView<string>(factory, "registry")).toLowerCase()).toBe(MAINNET_REGISTRY);
    expect(await factoryView<bigint>(factory, "marketCount")).toBe(1n);
    const market = await factoryView<readonly [string, string, string]>(factory, "markets", [0n]);
    expect(market.map((a) => a.toLowerCase())).toEqual([SPX, SPX_WETH_PAIR, SPX_WETH_POOL]);
    expect((await factoryView<string>(factory, "implementation")).toLowerCase()).toBe(implementationAddress(factory));
  });

  it("finds the batcher, deploying it the same way if it is absent", async () => {
    // Anyone may deploy it, once: its address commits to its code and WETH's, and to no factory.
    expect(batcherAddress(WETH)).toBe(MAINNET_BATCHER);
    if (((await rpc("eth_getCode", [MAINNET_BATCHER, "latest"])) as string) === "0x") {
      const deployer = await freshAccount(ETHER);
      const call = deployBatcherCall();
      expect(call.batcher).toBe(MAINNET_BATCHER);
      try {
        gas["deploy batcher"] = BigInt((await send(deployer.key, call.to, call.data, call.value)).gasUsed);
      } catch {
        // Deployed by another suite in between: the code says.
      }
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
      registryDeployed: true,
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
      // first slot closes FIRST_WINDOW_LEFT seconds after this block, and its
      // community window, which opened at startAt, closed long before.
      startAt: BigInt(block.timestamp) - VAULT_LIMITS.MIN_INTERVAL + FIRST_WINDOW_LEFT,
      // The buy fee the app proposes: one batched buy's network cost and 0.25% of it, at most 0.69%.
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      // A quarter of the five-minute interval: 75 seconds.
      communityWindow: defaultCommunityWindow(VAULT_LIMITS.MIN_INTERVAL),
      // No turns, as every plan the app creates.
      turnBuckets: DEFAULT_TURN_BUCKETS,
    };
    expect(plan.communityWindow).toBe(75n);
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
      plan.communityWindow,
      plan.turnBuckets,
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
    expect(created.source).toBe("v2");
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

    // Asked of every release's factory, as the app asks: this build's vouches for it.
    const state = await readVault(rpc, vault);
    expect(state).not.toBeNull();
    expect(state!.release).toBe("v2");
    expect(state!.source).toBe("v2");
    expect(state!.owner).toBe(owner.address);
    expect(state!.terms).toEqual(terms);
    expect(state!.fromFactory).toBe(true);
    expect(state!.factory).toBe(factory);
    expect(state!.windowBuys).toBe(0n);
    // Due from its start, and its 75-second community window long over: open to anyone.
    expect(state!.status).toMatchObject({
      due: true,
      funded: true,
      buysLeft: 3n,
      wethBalance: vaultBudget(terms),
      dueSince: plan.startAt,
      windowEndsAt: plan.startAt + 75n,
      // No turns: none to wait for, and every address in the one bucket.
      turnEndsAt: plan.startAt,
      turn: 0n,
    });
    expect(vaultCommunityWindow(state!)).toEqual({ dueSince: plan.startAt, endsAt: plan.startAt + 75n, inWindow: false });
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

  it("one keeper tick buys it through the batcher after its window, and the vault pays the fee straight to rewardTo", async () => {
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
    // The vault paid rewardTo itself — an address that never proved anything,
    // its window being over — and no WETH passed through the batcher; the
    // keeper's hot key got none.
    expect(await balanceOf(WETH, rewardTo)).toBe(terms.keeperReward);
    expect(await balanceOf(WETH, MAINNET_BATCHER)).toBe(0n);
    expect(await balanceOf(WETH, keeper.address)).toBe(0n);

    // The receipt says the same, joined by log index: the vault's Bought names
    // the batcher as its caller and rewardTo as the one paid, and the
    // batcher's Triggered follows it.
    const receipt = (await rpc("eth_getTransactionReceipt", [mined.hash])) as Receipt;
    const vaultEvents = receipt.logs.map(decodeVaultEvent);
    const batcherEvents = receipt.logs.map((log) => decodeBatcherEvent(MAINNET_BATCHER, log));
    const at = vaultEvents.findIndex((event) => event?.name === "Bought");
    const bought = vaultEvents[at] as Extract<ReturnType<typeof decodeVaultEvent>, { name: "Bought" }>;
    expect(bought).toMatchObject({
      emitter: vault,
      source: "v2",
      keeper: MAINNET_BATCHER,
      rewardTo,
      amountIn: terms.amountPerBuy,
      amountOut: received,
      reward: terms.keeperReward,
      buyNumber: 1n,
      dueSince: plan.startAt,
    });
    const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };
    expect(buyMaker({ ...bought, owner: owner.address, at: BigInt(block.timestamp), communityWindow: terms.communityWindow })).toBe("open");
    expect(bought.amountOut).toBeGreaterThanOrEqual(bought.floorOut);
    expect(bought.oracleDepth).toBeGreaterThanOrEqual(VAULT_LIMITS.MIN_ORACLE_DEPTH);
    expect(batcherEvents[at + 1]).toMatchObject({ name: "Triggered", vault, received });
    expect(batcherEvents.find((event) => event?.name === "Batch")).toMatchObject({
      source: "v2",
      caller: keeper.address,
      rewardTo,
      bought: 1n,
      earned: terms.keeperReward,
      swept: 0n,
    });

    const after = await readVault(rpc, vault);
    expect(after!.buysDone).toBe(1n);
    expect(after!.totalOut).toBe(received);
    expect(after!.totalRewards).toBe(terms.keeperReward);
    expect(after!.status.due).toBe(false);
    // Made after its window: not the community's.
    expect(after!.windowBuys).toBe(0n);
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

  it("inside its community window, refuses a stranger who names itself, and says until when", async () => {
    // Its own vault, due at once, with a 15-minute window: inside it for the rest of this file.
    const latest = await mineNow();
    const direct: VaultPlan = { ...plan, interval: 3_600n, communityWindow: 900n, maxBuys: 1n, startAt: BigInt(latest.timestamp) };
    const created = vaultsCreatedBy(factory, (await send(owner.key, factory, encodeCreateVault(direct), vaultBudget(direct))).logs)[0]!;
    directVault = created.vault;
    const state = (await readVault(rpc, directVault))!;
    expect(state.status).toMatchObject({ due: true, dueSince: direct.startAt, windowEndsAt: direct.startAt + 900n });
    expect(vaultCommunityWindow(state)).toEqual({ dueSince: direct.startAt, endsAt: direct.startAt + 900n, inWindow: true });
    // The TypeScript arithmetic agrees with the vault's, at the vault's own time.
    expect(communityWindowEndsAt(created.terms, 0n, 0n, state.chainTime!)).toBe(state.status.windowEndsAt);

    const stranger = await freshAccount(ETHER / 10n);
    const refused = decodeVaultError(await revertOf({ from: stranger.address, to: directVault, data: encodeExecute(stranger.address) }));
    expect(refused).toEqual({ name: "NotEligible", args: [expect.stringMatching(new RegExp(stranger.address.slice(2), "i")), direct.startAt + 900n] });
    // Paying the vault itself, or nobody, is refused inside the window and out.
    expect(decodeVaultError(await revertOf({ from: stranger.address, to: directVault, data: encodeExecute(directVault) }))).toMatchObject({ name: "BadRewardTo" });
  });

  it("a due buy triggered directly, paying the owner as Trigger now does, stays inside EXECUTE_GAS, even sent by someone else", async () => {
    const caller = await freshAccount(ETHER / 10n);
    const ownerWeth = await balanceOf(WETH, owner.address);
    // Trigger now's calldata: execute(owner), which the window never refuses.
    const data = encodeTrigger({ release: "v2", owner: owner.address });
    expect(data).toBe(encodeExecute(owner.address));
    const receipt = await send(caller.key, directVault, data);
    // The dearest buy there is: a plan's first, which writes its slots from zero.
    gas["execute (first buy, direct)"] = BigInt(receipt.gasUsed);
    expect(BigInt(receipt.gasUsed)).toBeLessThanOrEqual(EXECUTE_GAS);
    const bought = receipt.logs.map(decodeVaultEvent).find((event) => event?.name === "Bought") as Extract<ReturnType<typeof decodeVaultEvent>, { name: "Bought" }>;
    const terms = (await readVault(rpc, directVault))!.terms;
    expect(bought).toMatchObject({ emitter: directVault, keeper: caller.address, rewardTo: owner.address, reward: terms.keeperReward, buyNumber: 1n });
    // The fee came back to the owner, and the caller got nothing for its gas.
    expect((await balanceOf(WETH, owner.address)) - ownerWeth).toBe(terms.keeperReward);
    expect(await balanceOf(WETH, caller.address)).toBe(0n);
    const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };
    // Not the owner's doing, though the owner was paid: "returned".
    expect(buyMaker({ ...bought, owner: owner.address, sender: caller.address, at: BigInt(block.timestamp), communityWindow: 900n })).toBe("returned");
    // One buy was all it had: it is done, holds nothing more, and none of its buys was the community's.
    const state = (await readVault(rpc, directVault))!;
    expect(state.status).toMatchObject({ due: false, buysLeft: 0n, dueSince: null, windowEndsAt: null });
    expect(state.windowBuys).toBe(0n);
    expect(await balanceOf(WETH, directVault)).toBe(0n);
  });

  it("a vault with turns works out buckets and turns as the TypeScript does, and refuses an eligible holder off its turn exactly when onTurn says", async () => {
    await ensureHolderProven();
    // Two buckets: the one eligible address the fork has, HOLDER, is on a vault's turn about half the time.
    // Vaults are made until it has been both on and off: each its own, due at once, inside the first half of its window.
    const outcomes = new Set<boolean>();
    const stranger = await freshAccount(ETHER / 10n);
    for (let made = 0; made < 12 && outcomes.size < 2; made++) {
      const latest = await mineNow();
      const turned: VaultPlan = { ...plan, interval: 3_600n, communityWindow: 900n, maxBuys: 1n, startAt: BigInt(latest.timestamp), turnBuckets: 2n };
      const created = vaultsCreatedBy(factory, (await send(owner.key, factory, encodeCreateVault(turned), vaultBudget(turned))).logs)[0]!;
      expect(created.terms.turnBuckets).toBe(2n);
      const v = created.vault;
      const view = async (functionName: "bucketOf" | "turnOf", arg: Address | bigint) =>
        decodeFunctionResult({
          abi: VAULT_ABI,
          functionName,
          data: (await rpc("eth_call", [{ to: v, data: encodeFunctionData({ abi: VAULT_ABI, functionName, args: [arg] as never }) }, "latest"])) as Hex,
        });
      // The vault's own hashes are the TypeScript's.
      expect(await view("bucketOf", HOLDER)).toBe(bucketOf(HOLDER, 2n));
      expect(await view("bucketOf", stranger.address)).toBe(bucketOf(stranger.address, 2n));
      for (const slot of [0n, 1n, 7n]) expect(await view("turnOf", slot)).toBe(turnOf(v, slot, 2n));

      const state = (await readVault(rpc, v))!;
      expect(state.status).toMatchObject({ due: true, dueSince: turned.startAt, turnEndsAt: turned.startAt + 450n, turn: turnOf(v, 0n, 2n) });
      expect(turnEndsAtOf(created.terms, 0n, 0n, state.chainTime!)).toBe(state.status.turnEndsAt);
      const now = state.chainTime!;
      expect(now < turned.startAt + 450n).toBe(true);

      const expected = onTurn({ vault: v, owner: owner.address, rewardTo: HOLDER, terms: created.terms, dueSince: turned.startAt, now });
      outcomes.add(expected);
      let refusal: { name: string; args: readonly unknown[] } | null = null;
      try {
        await rpc("eth_call", [{ from: stranger.address, to: v, data: encodeExecute(HOLDER) }, "latest"]);
      } catch (error) {
        refusal = decodeVaultError((error as { data?: string }).data ?? "0x");
      }
      if (expected) {
        // On its turn: past the window's checks. (The market, not the turn, could still refuse it.)
        expect(refusal?.name ?? "bought", "an eligible holder on its turn").not.toMatch(/^(NotYourTurn|NotEligible)$/);
      } else {
        expect(refusal).toEqual({ name: "NotYourTurn", args: [expect.stringMatching(new RegExp(HOLDER.slice(2), "i")), turnOf(v, 0n, 2n), turned.startAt + 450n] });
      }
      // The owner may always be paid, and a stranger is no holder: the window's own rules, turn or not.
      expect(onTurn({ vault: v, owner: owner.address, rewardTo: owner.address, terms: created.terms, dueSince: turned.startAt, now })).toBe(true);
      expect(decodeVaultError(await revertOf({ from: stranger.address, to: v, data: encodeExecute(stranger.address) }))).toMatchObject({ name: "NotEligible" });
      // Done with it: closed, so it holds nothing.
      await send(owner.key, v, encodeClose());
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it("a v1 vault, made on v1's frozen factory, still reads, buys for whoever calls it, takes a top-up and closes", async () => {
    const v1 = await ensureRelease("v1");
    expect(v1.factory).toBe(V1_MAINNET_FACTORY);
    const latest = await mineNow();
    const v1Owner = await freshAccount(ETHER);
    const amountPerBuy = ETHER / 100n;
    const v1Plan = { ...plan, maxBuys: 2n, startAt: BigInt(latest.timestamp), keeperReward: v1BuyFee(amountPerBuy).reward };
    const args = [v1Plan.marketIndex, v1Plan.amountPerBuy, v1Plan.interval, v1Plan.maxBuys, v1Plan.startAt, v1Plan.keeperReward, v1Plan.maxSlippageBps] as const;
    const v1Terms = { ...termsOfPlan(v1Plan), communityWindow: null, turnBuckets: null };
    // Where it will be: computed here for v1's layout, and asked of v1's factory.
    const predicted = predictVault({ factory: V1_MAINNET_FACTORY, owner: v1Owner.address, nonce: 0n, terms: v1Terms });
    const asked = decodeFunctionResult({
      abi: V1_FACTORY_ABI,
      functionName: "predictVault",
      data: (await rpc("eth_call", [
        { to: V1_MAINNET_FACTORY, data: encodeFunctionData({ abi: V1_FACTORY_ABI, functionName: "predictVault", args: [v1Owner.address, 0n, ...args] }) },
        "latest",
      ])) as Hex,
    });
    expect(asked.toLowerCase()).toBe(predicted);

    const firstBuy = v1Plan.amountPerBuy + v1Plan.keeperReward;
    const receipt = await send(v1Owner.key, V1_MAINNET_FACTORY, encodeFunctionData({ abi: V1_FACTORY_ABI, functionName: "createVault", args }), firstBuy);
    const [created] = vaultsCreatedBy(V1_MAINNET_FACTORY, receipt.logs);
    expect(created).toMatchObject({ source: "v1", vault: predicted, owner: v1Owner.address, terms: v1Terms, funded: firstBuy });
    expect(await rpc("eth_getCode", [predicted, "latest"])).toBe(vaultRuntimeCode(implementationAddress(V1_MAINNET_FACTORY), v1Owner.address, v1Terms));

    // Read as the app reads any vault: by the shape of its answers, vouched for by v1's factory.
    const state = (await readVault(rpc, predicted))!;
    expect(state).toMatchObject({ release: "v1", source: "v1", terms: v1Terms, fromFactory: true, factory: V1_MAINNET_FACTORY, windowBuys: null });
    expect(state.status).toMatchObject({ due: true, funded: true, buysLeft: 2n, dueSince: null, windowEndsAt: null, turnEndsAt: null, turn: null });
    expect(vaultCommunityWindow(state)).toBeNull();

    // Topped up to its budget, with the same encoder as v2's.
    await send(v1Owner.key, predicted, encodeFund(), vaultBudget(v1Plan));
    expect(await balanceOf(WETH, predicted)).toBe(vaultBudget(v1Plan));

    // v1's execute() pays whoever calls it: no window, no rewardTo.
    const caller = await freshAccount(ETHER / 10n);
    const bought = (await send(caller.key, predicted, encodeExecuteV1())).logs.map(decodeVaultEvent).find((event) => event?.name === "Bought");
    expect(bought).toMatchObject({ source: "v1", emitter: predicted, keeper: caller.address, rewardTo: caller.address, reward: v1Plan.keeperReward, dueSince: null });
    expect(await balanceOf(WETH, caller.address)).toBe(v1Plan.keeperReward);
    expect(buyMaker({ ...(bought as Extract<typeof bought, { name: "Bought" }>), owner: v1Owner.address, at: null, communityWindow: null })).toBe("caller");
    // v2's execute(address) is nothing a v1 vault knows.
    await expect(rpc("eth_call", [{ from: caller.address, to: predicted, data: encodeExecute(caller.address) }, "latest"])).rejects.toThrow();

    const left = await balanceOf(WETH, predicted);
    await send(v1Owner.key, predicted, encodeClose());
    expect(await balanceOf(WETH, predicted)).toBe(0n);
    expect((await readVault(rpc, predicted))!).toMatchObject({ closed: true, status: { buysLeft: 0n } });
    expect(left).toBe(vaultBudget(v1Plan) - firstBuy);
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
