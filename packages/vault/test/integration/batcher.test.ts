/**
 * The batcher on the local fork, through @spdex/vault: deploy it the way anyone
 * would (through the deterministic deployer, built for WETH and bound to no
 * factory, if it isn't there yet), then make two vaults' first buys in one
 * transaction, and read back what happened — from the vaults' `Bought`, the
 * batcher's `Triggered` and `Batch`, joined by log index, and from the
 * factory's own list — the way a keeper and the report will. A clone no
 * factory vouches for is triggered like any vault: the batcher trusts nothing
 * a vault says, and measures what `rewardTo` received. A batch that can
 * only fail is asked about with `eth_call` and decoded, not sent: one whose
 * vaults are all inside their community window, for an address that never
 * proved anything, buys nothing; the same batch paying the vaults' owner buys.
 * Paying a proven SPX holder inside the window is `registry.test.ts`'s.
 *
 * The forge tests (`test/forge/Batcher.t.sol`, `BatchGas.t.sol`) prove the
 * contract's rules and pin its gas on a busy pool. This proves that the
 * encoders and decoders agree with the deployed bytes, and that a real
 * transaction's gas is inside the figures the buy fee is priced from.
 *
 * The shared fork's clock is never touched: the vaults bought for anyone start
 * half a slot back, so their 75-second community windows are already over and
 * their first buys due at once; the in-window ones start at the chain's own
 * time with a 15-minute window. Every address is fresh, the vaults are this
 * file's own, and it closes them at the end.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, getContractAddress, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared } from "@spdex/chain";
import {
  BATCHED_BUY_GAS,
  BATCHER_ABI,
  BATCHER_LIMITS,
  BATCH_FIRST_BUY_EXTRA_GAS,
  BATCH_FIXED_GAS,
  BATCH_PER_BUY_GAS,
  FACTORY_ABI,
  DEFAULT_TURN_BUCKETS,
  DETERMINISTIC_DEPLOYER,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  VAULT_LIMITS,
  batcherAddress,
  implementationAddress,
  termsOfPlan,
  vaultRuntimeCode,
  buyFee,
  decodeBatchRevert,
  decodeBatcherEvent,
  decodeExecuteBatchResult,
  decodeVaultEvent,
  deployBatcherCall,
  deployReleaseCalls,
  readVault,
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
/**
 * What a `rewardTo` that has never held WETH costs a batch, once: the first
 * vault's transfer to it writes its balance from zero (about 17,100 measured
 * in `BatchGas.t.sol`, inside the 15,000 it allows beside the batch's fixed
 * budget's headroom).
 */
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

  /** A vault of `owner`'s, funded in full, whose first buy is due at once: after its window, or (`inWindow`) inside it. */
  async function createDueVault(inWindow = false): Promise<Address> {
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const terms: VaultPlan = inWindow ? { ...plan, interval: 3_600n, communityWindow: 900n, startAt: BigInt(latest.timestamp) } : plan;
    const receipt = await sendOk(owner.key, MAINNET_FACTORY, encodeCreateVault(terms), { value: vaultBudget(terms) });
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
      // Chain time, never the wall clock: half a slot back, so the first buy is
      // due, and the 75-second community window that opened with it is over.
      startAt: BigInt(latest.timestamp) - 150n,
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      communityWindow: 75n,
      turnBuckets: DEFAULT_TURN_BUCKETS,
    };
  });

  afterAll(async () => {
    // Every vault this file made goes back to its owner.
    for (const vault of vaults) await sendOk(owner.key, vault, encodeClose());
  });

  it("deploys the batcher through the deterministic deployer, built for WETH and bound to no factory, where the artifacts say", async () => {
    const deployer = await freshAccount(ETHER);
    const [registryCall, factoryCall, batcherCall] = deployReleaseCalls("v2");
    for (const call of [registryCall!, factoryCall!]) await ensureDeployed(deployer.key, call, call.address);
    expect(factoryCall!.address).toBe(MAINNET_FACTORY);

    const call = deployBatcherCall();
    expect(call.batcher).toBe(MAINNET_BATCHER);
    expect(batcherCall).toMatchObject({ name: "batcher", data: call.data, address: MAINNET_BATCHER });
    expect(batcherAddress(WETH)).toBe(MAINNET_BATCHER);
    await ensureDeployed(deployer.key, call, MAINNET_BATCHER);

    const view = async (functionName: "weth" | "MIN_EXECUTE_GAS") =>
      decodeFunctionResult({
        abi: BATCHER_ABI,
        functionName,
        data: (await rpc("eth_call", [{ to: MAINNET_BATCHER, data: encodeFunctionData({ abi: BATCHER_ABI, functionName }) }, "latest"])) as Hex,
      });
    // What it measures `earned` in: WETH, and nothing about any factory.
    expect(String(await view("weth")).toLowerCase()).toBe(WETH);
    expect(await view("MIN_EXECUTE_GAS")).toBe(BATCHER_LIMITS.MIN_EXECUTE_GAS);
    expect(BATCHER_ABI.some((item) => item.type === "function" && (item.name as string) === "factory")).toBe(false);
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
      // Each vault was called by the batcher, and paid rewardTo itself.
      expect(event).toMatchObject({ source: "v2", keeper: MAINNET_BATCHER, rewardTo, reward, buyNumber: 1n, amountIn: plan.amountPerBuy, dueSince: plan.startAt });
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
      source: "v2",
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
    // No WETH passed through the batcher: every Transfer of it went from a vault to rewardTo or the pair.
    expect(await balanceOf(WETH, MAINNET_BATCHER)).toBe(0n);
    expect(await balanceOf(WETH, keeper.address)).toBe(0n);
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const touches = receipt.logs
      .filter((log) => log.address.toLowerCase() === WETH && log.topics[0] === transferTopic)
      .flatMap((log) => [log.topics[1], log.topics[2]].map((topic) => `0x${topic!.slice(26)}`));
    expect(touches).not.toContain(MAINNET_BATCHER);

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
  it("triggers a clone no factory vouches for like any vault, and earns what rewardTo received, at the gas the caller gives each", async () => {
    // A clone of the factory's implementation with the plan's terms, made outside the factory through the
    // deterministic deployer: the same code, but nothing vouches for it.
    const terms = termsOfPlan(plan);
    const runtime = vaultRuntimeCode(implementationAddress(MAINNET_FACTORY), owner.address, terms);
    const initCode = `0x61${((runtime.length - 2) / 2).toString(16).padStart(4, "0")}3d81600a3d39f3${runtime.slice(2)}` as Hex;
    const salt = `0x${"5a".repeat(31)}${(vaults.length + 1).toString(16).padStart(2, "0")}` as Hex;
    const deployer = await freshAccount(ETHER / 10n);
    await sendOk(deployer.key, DETERMINISTIC_DEPLOYER, `${salt}${initCode.slice(2)}` as Hex);
    const clone = getContractAddress({ opcode: "CREATE2", from: DETERMINISTIC_DEPLOYER, salt, bytecode: initCode }).toLowerCase() as Address;
    expect(await rpc("eth_getCode", [clone, "latest"])).toBe(runtime);
    vaults.push(clone);
    await sendOk(owner.key, clone, encodeFunctionData({ abi: parseAbi(["function fund() payable"]), functionName: "fund" }), { value: vaultBudget(plan) });
    const isVault = decodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "isVault",
      data: (await rpc("eth_call", [{ to: MAINNET_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [clone] }) }, "latest"])) as Hex,
    });
    expect(isVault).toBe(false);

    const listed = await createDueVault();
    const payee = (await freshAccount()).address;
    const receipt = await sendOk(keeper.key, MAINNET_BATCHER, encodeExecuteBatch([listed, clone], payee, 0n, { gasPerVault: 600_000n }), {
      gas: TWO_VAULT_GAS_LIMIT + 400_000n,
    });
    const batch = receipt.logs.map((log) => decodeBatcherEvent(MAINNET_BATCHER, log)).find((event) => event?.name === "Batch");
    // Both bought; earned is the rise in the payee's WETH, both fees.
    expect(batch).toMatchObject({ bought: 2n, earned: 2n * plan.keeperReward });
    expect(await balanceOf(WETH, payee)).toBe(2n * plan.keeperReward);
    const bought = receipt.logs.map(decodeVaultEvent).filter((event) => event?.name === "Bought").map((event) => event!.emitter);
    expect(bought).toEqual([listed, clone]);
  });

  it("inside their community windows buys nothing for an address that never proved, and buys for the vaults' owner", async () => {
    const [a, b] = [await createDueVault(true), await createDueVault(true)];
    const stranger = (await freshAccount()).address;
    const refused = decodeBatchRevert([a, b], await revertOf({ from: keeper.address, to: MAINNET_BATCHER, data: encodeExecuteBatch([a, b], stranger, 0n) }));
    expect(refused).toMatchObject({ kind: "NothingBought", bought: 0n });
    expect(refused!.outcomes.map((outcome) => [outcome.vault, outcome.reasonName])).toEqual([
      [a, "NotEligible"],
      [b, "NotEligible"],
    ]);
    // The owner may always be paid: the same batch naming the vaults' owner buys both, for the owner.
    const forOwner = (await rpc("eth_call", [{ from: keeper.address, to: MAINNET_BATCHER, data: encodeExecuteBatch([a, b], owner.address, 0n) }, "latest"])) as Hex;
    expect(decodeExecuteBatchResult([a, b], forOwner)).toMatchObject({ kind: "ok", bought: 2n });
    // And a vault past its window beside one inside it: only the one past its window buys for the stranger.
    const past = await createDueVault();
    const mixed = (await rpc("eth_call", [{ from: keeper.address, to: MAINNET_BATCHER, data: encodeExecuteBatch([a, past], stranger, 0n) }, "latest"])) as Hex;
    expect(decodeExecuteBatchResult([a, past], mixed).outcomes.map((outcome) => [outcome.bought, outcome.reasonName])).toEqual([
      [false, "NotEligible"],
      [true, null],
    ]);
    // readVault agrees: a and b are inside their windows, which end 15 minutes after they fell due.
    const state = (await readVault(rpc, a))!;
    expect(state.status.windowEndsAt! - state.status.dueSince!).toBe(900n);
    expect(state.chainTime! < state.status.windowEndsAt!).toBe(true);
  });
});
