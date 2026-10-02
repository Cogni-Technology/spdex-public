/**
 * The batcher on the local fork, through @spdex/vault: deploy it the way anyone
 * would (through the deterministic deployer, after its factory, if neither is
 * there yet), then make two vaults' first buys in one transaction, and read
 * back what happened — from the vaults' `Bought`, the batcher's `Triggered`
 * and `Batch`, joined by log index, and from the factory's own list — the way
 * a keeper and the report will. A batch that can only fail is asked about with
 * `eth_call` and decoded, not sent.
 *
 * The forge tests (`test/forge/Batcher.t.sol`, `BatchGas.t.sol`) prove the
 * contract's rules and pin its gas on a busy pool. This proves that the
 * encoders and decoders agree with the deployed bytes, and that a real
 * transaction's gas is inside the figures the buy fee is priced from.
 *
 * The shared fork's clock is never touched: each vault starts at the chain's
 * own time, so its first buy is due at once. Every address is fresh, the
 * vaults are this file's own, and it closes them at the end.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared } from "@spdex/chain";
import {
  BATCHED_BUY_GAS,
  BATCHER_ABI,
  BATCH_FIRST_BUY_EXTRA_GAS,
  BATCH_FIXED_GAS,
  BATCH_PER_BUY_GAS,
  FACTORY_ABI,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  VAULT_LIMITS,
  batcherAddress,
  buyFee,
  decodeBatchRevert,
  decodeBatcherEvent,
  decodeExecuteBatchResult,
  decodeVaultEvent,
  deployBatcherCall,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  encodeExecuteBatch,
  readVaultCount,
  readVaultsPage,
  vaultBudget,
  vaultsCreatedBy,
  type BatcherEvent,
  type RawLog,
  type VaultEvent,
  type VaultPlan,
} from "../../src/index.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);

const WETH = TOKENS.WETH.address;
const ETHER = 10n ** 18n;
/**
 * The gas limit a two-vault batch is sent with. Never `eth_estimateGas`'s: a
 * batch succeeds as soon as one vault buys, so the least gas that succeeds is
 * the gas for the first vault alone, with the rest `NotTried`.
 */
const TWO_VAULT_GAS_LIMIT = 2_000_000n;
/** What a `rewardTo` that has never held WETH costs a batch, once (see `BatchGas.t.sol`). */
const FRESH_REWARD_TO_EXTRA_GAS = 15_000n;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner] }) },
    "latest",
  ])) as Hex;
  return decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data });
}

/** A key nobody has used, funded with `amount` if asked. Only fresh addresses are ever given a balance. */
async function freshAccount(amount?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  if (amount !== undefined) await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

type ReceiptLog = RawLog & { logIndex: string };

interface Receipt {
  status: string;
  gasUsed: string;
  blockNumber: string;
  logs: ReceiptLog[];
}

/** Sign locally, send raw, wait for the receipt. `gas` replaces the estimate's limit when given. */
async function send(key: Hex, to: Address, data: Hex, options: { value?: bigint; gas?: bigint } = {}): Promise<Receipt> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value: options.value ?? 0n, chainId: CHAIN_ID });
  const tx = options.gas === undefined ? prepared : { ...prepared, gas: options.gas };
  const { raw, hash } = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

async function sendOk(key: Hex, to: Address, data: Hex, options: { value?: bigint; gas?: bigint } = {}): Promise<Receipt> {
  const receipt = await send(key, to, data, options);
  expect(BigInt(receipt.status)).toBe(1n);
  return receipt;
}

const hasCode = async (address: Address) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

/**
 * Deploy through the deterministic deployer unless the contract is there
 * already. Another suite on the same fork may deploy it first, even between the
 * check and the send; a deployment that loses that race reverts, and the code
 * is there all the same.
 */
async function ensureDeployed(deployer: Hex, call: { to: Address; data: Hex }, at: Address): Promise<void> {
  if (!(await hasCode(at))) await send(deployer, call.to, call.data);
  expect(await hasCode(at)).toBe(true);
}

/** The revert data an `eth_call` came back with; throws if it did not revert. */
async function revertOf(call: { from: Address; to: Address; data: Hex }): Promise<Hex> {
  try {
    await rpc("eth_call", [call, "latest"]);
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") return data as Hex;
    throw error;
  }
  throw new Error("the call did not revert");
}

describe("batched buys on the fork, through @spdex/vault", () => {
  let owner: { key: Hex; address: Address };
  let keeper: { key: Hex; address: Address };
  let rewardTo: Address;
  let plan: VaultPlan;
  const vaults: Address[] = [];

  /** A vault of `owner`'s, funded in full, whose first buy is due at once. */
  async function createDueVault(): Promise<Address> {
    const receipt = await sendOk(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), { value: vaultBudget(plan) });
    const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
    if (!created) throw new Error("no VaultCreated from the factory in the receipt");
    expect(created.funded).toBe(vaultBudget(plan));
    vaults.push(created.vault);
    return created.vault;
  }

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    owner = await freshAccount(2n * ETHER);
    keeper = await freshAccount(ETHER / 10n);
    rewardTo = (await freshAccount()).address;
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 100n;
    plan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: VAULT_LIMITS.MIN_INTERVAL,
      maxBuys: 2n,
      // Chain time, never the wall clock: the next block is at or after it, so the first buy is due.
      startAt: BigInt(latest.timestamp),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
    };
  });

  afterAll(async () => {
    // Every vault this file made goes back to its owner.
    for (const vault of vaults) await sendOk(owner.key, vault, encodeClose());
  });

  it("deploys the batcher through the deterministic deployer, after its factory, where the artifacts say", async () => {
    const deployer = await freshAccount(ETHER);
    const factoryCall = deployFactoryCall();
    expect(factoryCall.factory).toBe(MAINNET_FACTORY);
    await ensureDeployed(deployer.key, factoryCall, MAINNET_FACTORY);

    const call = deployBatcherCall(MAINNET_FACTORY);
    expect(call.batcher).toBe(MAINNET_BATCHER);
    expect(batcherAddress(MAINNET_FACTORY)).toBe(MAINNET_BATCHER);
    await ensureDeployed(deployer.key, call, MAINNET_BATCHER);

    const view = async (functionName: "factory" | "weth") =>
      decodeFunctionResult({
        abi: BATCHER_ABI,
        functionName,
        data: (await rpc("eth_call", [{ to: MAINNET_BATCHER, data: encodeFunctionData({ abi: BATCHER_ABI, functionName }) }, "latest"])) as Hex,
      });
    expect((await view("factory")).toLowerCase()).toBe(MAINNET_FACTORY);
    expect((await view("weth")).toLowerCase()).toBe(WETH);
  });

  it("buys two vaults in one transaction, and its events join the vaults' by log index", async () => {
    const first = await createDueVault();
    const second = await createDueVault();
    const reward = plan.keeperReward;

    const receipt = await sendOk(keeper.key, MAINNET_BATCHER, encodeExecuteBatch([first, second], rewardTo, 0n), {
      gas: TWO_VAULT_GAS_LIMIT,
    });

    const vaultEvents = receipt.logs
      .map((log) => ({ log, event: decodeVaultEvent(log) }))
      .filter((entry): entry is { log: ReceiptLog; event: Extract<VaultEvent, { name: "Bought" }> } => entry.event?.name === "Bought");
    const batcherEvents = receipt.logs
      .map((log) => decodeBatcherEvent(MAINNET_BATCHER, log))
      .filter((event): event is BatcherEvent => event !== null);

    expect(vaultEvents.map(({ event }) => event.emitter)).toEqual([first, second]);
    for (const { log, event } of vaultEvents) {
      // Each vault paid its caller: the batcher.
      expect(event).toMatchObject({ keeper: MAINNET_BATCHER, reward, buyNumber: 1n, amountIn: plan.amountPerBuy });
      expect(event.amountOut >= event.floorOut).toBe(true);
      expect(event.floorOut > 0n).toBe(true);
      expect(event.oracleDepth >= VAULT_LIMITS.MIN_ORACLE_DEPTH).toBe(true);
      // The batcher's Triggered is the very next log, and says what the owner received.
      const triggered = batcherEvents.find((e) => e.name === "Triggered" && e.logIndex === Number(BigInt(log.logIndex)) + 1);
      expect(triggered).toMatchObject({ name: "Triggered", vault: event.emitter, received: event.amountOut });
    }

    const batch = batcherEvents.find((e) => e.name === "Batch");
    expect(batch).toMatchObject({
      name: "Batch",
      emitter: MAINNET_BATCHER,
      caller: keeper.address,
      rewardTo,
      listed: 2n,
      tried: 2n,
      bought: 2n,
      earned: 2n * reward,
      swept: 0n,
    });
    expect(batcherEvents.filter((e) => e.name === "NotTriggered")).toEqual([]);
    expect(await balanceOf(WETH, rewardTo)).toBe(2n * reward);
    expect(await balanceOf(WETH, MAINNET_BATCHER)).toBe(0n);
    expect(await balanceOf(WETH, keeper.address)).toBe(0n);

    // Two first buys, paid to a rewardTo that had never held WETH, inside what the fee is priced from.
    const gasUsed = BigInt(receipt.gasUsed);
    const bound = BATCH_FIXED_GAS + FRESH_REWARD_TO_EXTRA_GAS + 2n * (BATCH_PER_BUY_GAS + BATCH_FIRST_BUY_EXTRA_GAS);
    console.log(`a batch of two first buys on the fork: ${gasUsed} gas (bound ${bound}; ${BATCHED_BUY_GAS} a buy is what the fee prices)`);
    expect(gasUsed <= bound).toBe(true);
  });

  it("finds both vaults in the factory's own list, oldest first", async () => {
    const count = await readVaultCount(rpc, MAINNET_FACTORY);
    expect(count >= 2n).toBe(true);
    const listed: Address[] = [];
    for (let offset = 0n; offset < count; offset += 500n) listed.push(...(await readVaultsPage(rpc, MAINNET_FACTORY, offset, 500n)));
    expect(BigInt(listed.length)).toBe(count);
    const [first, second] = vaults;
    expect(listed.indexOf(first!)).toBeGreaterThanOrEqual(0);
    expect(listed.indexOf(second!)).toBeGreaterThan(listed.indexOf(first!));
    expect(await readVaultsPage(rpc, MAINNET_FACTORY, count, 500n)).toEqual([]);

    const isVault = async (vault: Address) =>
      decodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "isVault",
        data: (await rpc("eth_call", [
          { to: MAINNET_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [vault] }) },
          "latest",
        ])) as Hex,
      });
    expect(await isVault(first!)).toBe(true);
    expect(await isVault(second!)).toBe(true);
  });

  it("says why a hopeless batch would fail, and what one short of its minimum would earn, without sending either", async () => {
    const [first, second] = vaults as [Address, Address];
    // Both bought a moment ago: each is TooSoon, so nothing would buy.
    const hopeless = await revertOf({ from: keeper.address, to: MAINNET_BATCHER, data: encodeExecuteBatch([first, second], rewardTo, 0n) });
    const nothing = decodeBatchRevert([first, second], hopeless);
    expect(nothing).toMatchObject({ kind: "NothingBought", bought: 0n, earned: null, minRewards: null });
    expect(nothing!.outcomes.map((outcome) => [outcome.vault, outcome.bought, outcome.reasonName])).toEqual([
      [first, false, "TooSoon"],
      [second, false, "TooSoon"],
    ]);

    // A third vault is due: with it, the batch would buy one — but not earn a whole ether.
    const third = await createDueVault();
    const short = await revertOf({ from: keeper.address, to: MAINNET_BATCHER, data: encodeExecuteBatch([third, first], rewardTo, ETHER) });
    const tooLittle = decodeBatchRevert([third, first], short);
    expect(tooLittle).toMatchObject({ kind: "TooLittle", bought: 1n, earned: plan.keeperReward, minRewards: ETHER });
    expect(tooLittle!.outcomes.map((outcome) => [outcome.vault, outcome.bought, outcome.reasonName])).toEqual([
      [third, true, null],
      [first, false, "TooSoon"],
    ]);

    // With no minimum it would go through: the simulation's answer, decoded.
    const answer = (await rpc("eth_call", [
      { from: keeper.address, to: MAINNET_BATCHER, data: encodeExecuteBatch([third, first], rewardTo, 0n) },
      "latest",
    ])) as Hex;
    expect(decodeExecuteBatchResult([third, first], answer)).toMatchObject({
      kind: "ok",
      bought: 1n,
      earned: plan.keeperReward,
      outcomes: [
        { vault: third, bought: true, reason: null },
        { vault: first, bought: false, reasonName: "TooSoon" },
      ],
    });
  });
});
