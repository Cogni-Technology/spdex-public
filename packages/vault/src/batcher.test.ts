/**
 * The batcher's TypeScript surface against scripted data: no node, no network.
 *
 * What these pin is what a keeper, a report and the app build on: the
 * record ends with this build, after v1's, v1's batcher's address follows
 * from its code and v1's factory and the shared one's from its code and WETH
 * alone, each batcher's `executeBatch` is encoded for its own ABI, a
 * simulation's answer lines up with the list it was asked about, every reason
 * a keeper will meet has a name in every source, every source's batches
 * decode, and a log another contract wrote is never read as the batcher's. That the contract does what
 * these decode is the forge suite's (`test/forge/Batcher.t.sol`), and that the
 * two agree on a real chain is `test/integration/batcher.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getContractAddress,
  keccak256,
  toBytes,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
} from "viem";
import type { Address, Hex } from "@spdex/core";
import {
  BATCHER_ABI,
  BATCHER_CREATION_CODE,
  BATCHER_CREATION_CODE_HASH,
  BATCHER_EVENT_TOPICS,
  BATCHER_LIMITS,
  BATCHERS,
  BATCHER_SALT,
  DEPLOYMENTS,
  DETERMINISTIC_DEPLOYER,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  MAINNET_REGISTRY,
  MAX_EXECUTE_GAS_LIMIT,
  V1_BATCHER_ABI,
  V1_BATCHER_LIMITS,
  V1_BATCHER_SALT,
  V1_MAINNET_BATCHER,
  V1_MAINNET_FACTORY,
  V1_VAULT_ABI,
  VAULT_ABI,
  batcherAddress,
  batcherInitCode,
  decodeBatchRevert,
  decodeBatcherEvent,
  decodeExecuteBatchResult,
  decodeVaultEvent,
  deployBatcherCall,
  encodeExecuteBatch,
  joinBatchLogs,
  reasonName,
} from "./index.js";

const A: Address = "0x00000000000000000000000000000000000000a1";
const B: Address = "0x00000000000000000000000000000000000000a2";
const C: Address = "0x00000000000000000000000000000000000000a3";
const REWARD_TO: Address = "0x00000000000000000000000000000000000000b1";
const KEEPER: Address = "0x00000000000000000000000000000000000000c1";

const TOO_SOON: Hex = "0xe86f59ea";
const NOT_FROM_FACTORY: Hex = "0xb1391cf3";
const BOUGHT: Hex = "0x00000000";

describe("the record and the batchers' addresses", () => {
  const WETH = MAINNET_DEPLOYMENT.weth as Address;

  it("pins the batcher's limits; a keeper gives each vault the least a batch may, and v1's fixed cap was the same", () => {
    expect(BATCHER_LIMITS).toEqual({ MIN_EXECUTE_GAS: 400_000n, MAX_EXECUTE_GAS: 10_000_000n, MAX_VAULTS: 150n, ATTEMPT_OVERHEAD: 53_650n });
    expect(V1_BATCHER_LIMITS).toEqual({ EXECUTE_GAS_CAP: 400_000n, MAX_VAULTS: 150n, MIN_GAS_PER_ATTEMPT: 460_000n });
    expect(BATCHER_LIMITS.MIN_EXECUTE_GAS).toBe(MAX_EXECUTE_GAS_LIMIT);
    expect(V1_BATCHER_LIMITS.EXECUTE_GAS_CAP).toBe(MAX_EXECUTE_GAS_LIMIT);
  });

  it("agrees with itself: salt, code hash, and the batcher built for mainnet's WETH, bound to no factory", () => {
    expect(BATCHER_SALT).toBe(keccak256(toBytes("spdex.vault.batcher.v2")));
    expect(BATCHER_SALT).toBe("0x4a5007433992179ad77c23cdb0a2ce750542c88019f33b6cb7acab3da9ccc305");
    expect(V1_BATCHER_SALT).toBe("0x015db2dbb1d1dbeb1122646de77d5f4686cd4b3a16493fc58452916455efd143");
    // Where the forge suite's deployment test puts it (`test_deployedThroughTheDeterministicDeployerLandsWhereExpected`).
    expect(MAINNET_BATCHER).toBe("0xd1f8327aa8398997bd88165f420412c703ebfed0");
    expect(keccak256(BATCHER_CREATION_CODE)).toBe(BATCHER_CREATION_CODE_HASH);
    expect(batcherAddress(WETH)).toBe(MAINNET_BATCHER);
    // By hand: CREATE2 from the deterministic deployer over the creation code and WETH.
    expect(MAINNET_BATCHER).toBe(
      getContractAddress({
        opcode: "CREATE2",
        from: DETERMINISTIC_DEPLOYER,
        salt: BATCHER_SALT,
        bytecode: `${BATCHER_CREATION_CODE}${encodeAbiParameters([{ type: "address" }], [WETH]).slice(2)}`,
      }).toLowerCase(),
    );
    // No factory goes into it: the latest release's factory, built for it, would be another contract.
    expect(batcherAddress(MAINNET_FACTORY)).not.toBe(MAINNET_BATCHER);
    // v1's is bound to v1's factory, from v1's source.
    expect(batcherAddress(V1_MAINNET_FACTORY, "v1")).toBe(V1_MAINNET_BATCHER);
  });

  it("ends with this build, after v1's frozen release, and its ids run v1, v2, … with no gap", () => {
    expect(DEPLOYMENTS.length).toBeGreaterThan(1);
    DEPLOYMENTS.forEach((deployment, i) => {
      expect(deployment.id).toBe(`v${i + 1}`);
      expect(deployment.factory).toMatch(/^0x[0-9a-f]{40}$/);
      expect(deployment.batcher).toMatch(/^0x[0-9a-f]{40}$/);
    });
    expect(DEPLOYMENTS.at(-1)).toMatchObject({ id: `v${DEPLOYMENTS.length}`, factory: MAINNET_FACTORY, batcher: MAINNET_BATCHER, registry: MAINNET_REGISTRY });
    // v1, on mainnet since block 26,100,366, with no registry and its own batcher.
    expect(DEPLOYMENTS[0]).toEqual({
      id: "v1",
      source: "v1",
      factory: V1_MAINNET_FACTORY,
      registry: null,
      batcher: V1_MAINNET_BATCHER,
      markets: MAINNET_DEPLOYMENT.markets,
      factoryBlock: 26_100_366n,
      registryBlock: null,
      batcherBlock: 26_100_368n,
    });
    // Every release before the last reached mainnet, and so has its blocks.
    for (const earlier of DEPLOYMENTS.slice(0, -1)) expect(earlier.factoryBlock).not.toBeNull();
  });

  it("lists the batchers bound to no factory apart, the newest last, and every release from v2 on sends through it", () => {
    expect(BATCHERS.length).toBeGreaterThan(0);
    expect(BATCHERS.at(-1)!.batcher).toBe(MAINNET_BATCHER);
    for (const b of BATCHERS) expect(b.batcher).toMatch(/^0x[0-9a-f]{40}$/);
    // Only the last may be undeployed.
    for (const b of BATCHERS.slice(0, -1)) expect(b.batcherBlock).not.toBeNull();
    for (const d of DEPLOYMENTS.slice(1)) {
      expect(d.batcher).toBe(MAINNET_BATCHER);
      expect(d.batcherBlock).toBe(BATCHERS.at(-1)!.batcherBlock);
    }
  });

  it("is deployed through the deterministic deployer: salt, then init code, with no value", () => {
    const call = deployBatcherCall();
    expect(call).toEqual(deployBatcherCall(MAINNET_BATCHER));
    expect(call.to).toBe(DETERMINISTIC_DEPLOYER);
    expect(call.value).toBe(0n);
    expect(call.batcher).toBe(MAINNET_BATCHER);
    expect(call.data.slice(0, 66)).toBe(BATCHER_SALT);
    expect(call.data.slice(66)).toBe(batcherInitCode(WETH).slice(2));
    expect(batcherInitCode(WETH).endsWith(WETH.slice(2))).toBe(true);
    // v1's, from its frozen source, built for v1's factory, lands where v1's is on mainnet.
    const v1 = deployBatcherCall(V1_MAINNET_BATCHER);
    expect(v1).toMatchObject({ to: DETERMINISTIC_DEPLOYER, value: 0n, batcher: V1_MAINNET_BATCHER });
    expect(v1.data.slice(0, 66)).toBe(V1_BATCHER_SALT);
    expect(v1.data.endsWith(V1_MAINNET_FACTORY.slice(2))).toBe(true);
  });

  it("deploys only a batcher spDEX lists: a factory, or any other address, is not one", () => {
    expect(() => deployBatcherCall(MAINNET_FACTORY)).toThrow(RangeError);
    expect(() => deployBatcherCall(V1_MAINNET_FACTORY)).toThrow(RangeError);
    expect(() => deployBatcherCall("0x00000000000000000000000000000000000000f5")).toThrow(RangeError);
    // Case does not matter.
    expect(deployBatcherCall(MAINNET_BATCHER.toUpperCase().replace("0X", "0x") as Address).batcher).toBe(MAINNET_BATCHER);
  });
});

describe("encodeExecuteBatch", () => {
  const plain = (args: readonly unknown[]) =>
    args.map((arg) => (Array.isArray(arg) ? arg.map((a: string) => a.toLowerCase()) : typeof arg === "string" ? arg.toLowerCase() : arg));

  it("carries the vaults in order, where the rewards go, the least the caller accepts, and each vault's gas, for a batcher bound to no factory", () => {
    const data = encodeExecuteBatch([A, B], REWARD_TO, 123n);
    expect(data.slice(0, 10)).toBe("0x4ec08f53");
    expect(data.slice(0, 10)).toBe(toFunctionSelector("executeBatch(address[],address,uint256,uint256)"));
    const decoded = decodeFunctionData({ abi: BATCHER_ABI, data });
    expect(decoded.functionName).toBe("executeBatch");
    // The least a batch may give each vault, by default: what a keeper sends.
    expect(plain(decoded.args)).toEqual([[A, B], REWARD_TO, 123n, BATCHER_LIMITS.MIN_EXECUTE_GAS]);
    expect(encodeExecuteBatch([A, B], REWARD_TO, 123n, { batcher: MAINNET_BATCHER })).toBe(data);
    const more = decodeFunctionData({ abi: BATCHER_ABI, data: encodeExecuteBatch([A], REWARD_TO, 0n, { gasPerVault: 1_000_000n }) });
    expect(plain(more.args)).toEqual([[A], REWARD_TO, 0n, 1_000_000n]);
  });

  it("carries v1's three arguments for v1's batcher, which takes no gas", () => {
    const data = encodeExecuteBatch([A, B], REWARD_TO, 123n, { batcher: V1_MAINNET_BATCHER, gasPerVault: 1_000_000n });
    expect(data.slice(0, 10)).toBe("0xf4ccdffc");
    expect(data.slice(0, 10)).toBe(toFunctionSelector("executeBatch(address[],address,uint256)"));
    const decoded = decodeFunctionData({ abi: V1_BATCHER_ABI, data });
    expect(plain(decoded.args)).toEqual([[A, B], REWARD_TO, 123n]);
  });
});

describe("a simulated batch", () => {
  it("that goes through: what each vault did, aligned with the list", () => {
    const data = encodeFunctionResult({ abi: BATCHER_ABI, functionName: "executeBatch", result: [1n, 5_000n, [BOUGHT, TOO_SOON]] });
    expect(decodeExecuteBatchResult([A, B], data)).toEqual({
      kind: "ok",
      bought: 1n,
      earned: 5_000n,
      minRewards: null,
      outcomes: [
        { vault: A, bought: true, reason: null, reasonName: null },
        { vault: B, bought: false, reason: TOO_SOON, reasonName: "TooSoon" },
      ],
    });
  });

  it("whose answer does not line up with the list is not an answer about it", () => {
    const data = encodeFunctionResult({ abi: BATCHER_ABI, functionName: "executeBatch", result: [1n, 5_000n, [BOUGHT]] });
    expect(() => decodeExecuteBatchResult([A, B], data)).toThrow(RangeError);
  });

  it("where nothing bought: every vault's reason, in order", () => {
    const data = encodeErrorResult({ abi: BATCHER_ABI, errorName: "NothingBought", args: [[TOO_SOON, NOT_FROM_FACTORY, "0xdeadbeef"]] });
    expect(decodeBatchRevert([A, B, C], data)).toEqual({
      kind: "NothingBought",
      bought: 0n,
      earned: null,
      minRewards: null,
      outcomes: [
        { vault: A, bought: false, reason: TOO_SOON, reasonName: "TooSoon" },
        { vault: B, bought: false, reason: NOT_FROM_FACTORY, reasonName: "NotFromFactory" },
        { vault: C, bought: false, reason: "0xdeadbeef", reasonName: null },
      ],
    });
    // An empty list reverts NothingBought too, with no reasons.
    expect(decodeBatchRevert([], encodeErrorResult({ abi: BATCHER_ABI, errorName: "NothingBought", args: [[]] }))).toMatchObject({
      kind: "NothingBought",
      outcomes: [],
    });
  });

  it("where the rewards fell short of the caller's minimum: what it would have earned, and against what", () => {
    const data = encodeErrorResult({ abi: BATCHER_ABI, errorName: "TooLittle", args: [5_000n, 10_000n, [BOUGHT, TOO_SOON]] });
    expect(decodeBatchRevert([A, B], data)).toEqual({
      kind: "TooLittle",
      bought: 1n,
      earned: 5_000n,
      minRewards: 10_000n,
      outcomes: [
        { vault: A, bought: true, reason: null, reasonName: null },
        { vault: B, bought: false, reason: TOO_SOON, reasonName: "TooSoon" },
      ],
    });
  });

  it("that reverts for any other reason, or with reasons for another list, is not one this decodes", () => {
    expect(decodeBatchRevert([A], encodeErrorResult({ abi: BATCHER_ABI, errorName: "BadRewardTo", args: [REWARD_TO] }))).toBeNull();
    expect(decodeBatchRevert([A], encodeErrorResult({ abi: BATCHER_ABI, errorName: "Reentrancy" }))).toBeNull();
    expect(decodeBatchRevert([A], "0x")).toBeNull();
    expect(decodeBatchRevert([A], "0x08c379a0")).toBeNull();
    const two = encodeErrorResult({ abi: BATCHER_ABI, errorName: "NothingBought", args: [[TOO_SOON, TOO_SOON]] });
    expect(decodeBatchRevert([A], two)).toBeNull();
  });
});

describe("reasonName", () => {
  it("names every refusal a keeper will meet: every source's vaults' and batchers' (v1's NotFromFactory too), the registry's and Solidity's own", () => {
    const names: Record<string, string> = {
      "0xe86f59ea": "TooSoon",
      "0xd6e7da92": "PriceBelowFloor",
      "0x9de2f4e2": "OracleTooThin",
      "0x03454d3b": "NotStarted",
      "0xb58de46f": "NoBuysLeft",
      "0xcf479181": "InsufficientBalance",
      "0xdf23397a": "VaultClosed",
      "0xaa2da6ee": "DeliveredShort",
      "0x39f1c8d9": "TransferFailed",
      "0xab143c06": "Reentrancy",
      "0xb1391cf3": "NotFromFactory",
      "0x23b3fa42": "EmptyRevert",
      "0x81abc716": "EmptyReturn",
      "0x51d43e40": "NotTried",
      "0x2aae24c2": "NothingBought",
      "0x098ad2ef": "TooLittle",
      "0xb21ce01b": "BadRewardTo",
      "0x5863fc24": "NotEligible",
      [toFunctionSelector("NotYourTurn(address,uint256,uint256)")]: "NotYourTurn",
      [toFunctionSelector("GasOutOfRange(uint256,uint256,uint256)")]: "GasOutOfRange",
      [toFunctionSelector("NoWeth(address)")]: "NoWeth",
      "0x86764874": "TooManyVaults",
      "0x78ecf410": "RewardTransferFailed",
      "0x97133cf8": "NoFactory",
      "0xce3358be": "NotNewer",
      "0x08c379a0": "Error",
      "0x4e487b71": "Panic",
    };
    for (const [code, name] of Object.entries(names)) expect(reasonName(code as Hex), code).toBe(name);
    expect(reasonName("0xE86F59EA")).toBe("TooSoon");
  });

  it("says nothing about a selector it does not know, rather than guessing", () => {
    expect(reasonName("0xdeadbeef")).toBeNull();
    expect(reasonName(BOUGHT)).toBeNull();
  });
});

describe("decodeBatcherEvent", () => {
  const BATCHER = MAINNET_BATCHER;
  const eventInputs = (name: "Batch" | "Triggered" | "NotTriggered", abi: typeof BATCHER_ABI | typeof V1_BATCHER_ABI = BATCHER_ABI) => {
    const event = (abi as readonly { type: string; name?: string; inputs?: readonly { indexed?: boolean }[] }[]).find(
      (item) => item.type === "event" && item.name === name,
    );
    if (!event?.inputs) throw new Error(`no event ${name}`);
    return event.inputs.filter((input) => !input.indexed) as never;
  };

  /** v2's Batch: no `swept`, since no WETH passes through its batcher. */
  const batchLog = (address: string, logIndex?: string | number) => ({
    address,
    topics: encodeEventTopics({ abi: BATCHER_ABI, eventName: "Batch", args: { caller: KEEPER, rewardTo: REWARD_TO } }) as Hex[],
    data: encodeAbiParameters(eventInputs("Batch"), [3n, 2n, 1n, 5_000n] as never),
    ...(logIndex === undefined ? {} : { logIndex }),
  });

  /** v1's Batch, with what its batcher swept beside the rewards. */
  const v1BatchLog = (address: string, logIndex: string | number) => ({
    address,
    topics: encodeEventTopics({ abi: V1_BATCHER_ABI, eventName: "Batch", args: { caller: KEEPER, rewardTo: REWARD_TO } }) as Hex[],
    data: encodeAbiParameters(eventInputs("Batch", V1_BATCHER_ABI), [3n, 2n, 1n, 5_000n, 7n] as never),
    logIndex,
  });

  it("knows its events by the topics each source's batcher emits", () => {
    const same = {
      Triggered: "0xdf3dd2ca88a00202ce95068ac9e4bac0de22ee6bde7cd801c4c12514e1bee499",
      NotTriggered: "0xf6d9b55a91640d8cf119e10d155d45ea8331e8c0ef5b1e634f3d054573beac55",
    };
    expect(BATCHER_EVENT_TOPICS).toEqual({
      v1: { Batch: "0x1e048d0563704be3cfcbd9b79728ada66cb33aff02ed72e583428009b5216c77", ...same },
      v2: { Batch: "0x18aae53c6f7554fe43a6ec800cb4234575499796cb6bf91dade26afb14ff01fc", ...same },
    });
  });

  it("reads Batch, Triggered and NotTriggered, with their log index, lowercasing addresses", () => {
    expect(decodeBatcherEvent(BATCHER, batchLog(BATCHER.toUpperCase().replace("0X", "0x"), "0x9"))).toEqual({
      name: "Batch",
      emitter: BATCHER,
      source: "v2",
      logIndex: 9,
      caller: KEEPER,
      rewardTo: REWARD_TO,
      listed: 3n,
      tried: 2n,
      bought: 1n,
      earned: 5_000n,
      // Not unknown: a batcher from v2 on holds no WETH and moves none, so there is nothing to sweep.
      swept: 0n,
    });
    expect(
      decodeBatcherEvent(BATCHER, {
        address: BATCHER,
        topics: encodeEventTopics({ abi: BATCHER_ABI, eventName: "Triggered", args: { vault: A } }) as Hex[],
        data: encodeAbiParameters(eventInputs("Triggered"), [12_345n, 101_000n] as never),
        logIndex: 4,
      }),
    ).toEqual({ name: "Triggered", emitter: BATCHER, logIndex: 4, vault: A, received: 12_345n, gasUsed: 101_000n });
    expect(
      decodeBatcherEvent(BATCHER, {
        address: BATCHER,
        topics: encodeEventTopics({ abi: BATCHER_ABI, eventName: "NotTriggered", args: { vault: B, reason: "0xE86F59EA" } }) as Hex[],
        data: encodeAbiParameters(eventInputs("NotTriggered"), [11_000n] as never),
        logIndex: "0x5",
      }),
    ).toEqual({ name: "NotTriggered", emitter: BATCHER, logIndex: 5, vault: B, reason: TOO_SOON, reasonName: "TooSoon", gasUsed: 11_000n });
  });

  it("reads v1's Batch too, with what it swept", () => {
    expect(decodeBatcherEvent(V1_MAINNET_BATCHER, v1BatchLog(V1_MAINNET_BATCHER, 2))).toEqual({
      name: "Batch",
      emitter: V1_MAINNET_BATCHER,
      source: "v1",
      logIndex: 2,
      caller: KEEPER,
      rewardTo: REWARD_TO,
      listed: 3n,
      tried: 2n,
      bought: 1n,
      earned: 5_000n,
      swept: 7n,
    });
  });

  it("returns null for a log another contract wrote, even one shaped exactly like the batcher's", () => {
    expect(decodeBatcherEvent(BATCHER, batchLog(A, "0x1"))).toBeNull();
    expect(decodeBatcherEvent(A, batchLog(BATCHER, "0x1"))).toBeNull();
    expect(decodeBatcherEvent(A.toUpperCase().replace("0X", "0x") as Address, batchLog(A, "0x1"))).toMatchObject({ emitter: A });
  });

  it("returns null for a log of the batcher's that is none of its events, and leaves a vault's Bought to decodeVaultEvent", () => {
    const bought = {
      address: BATCHER,
      topics: encodeEventTopics({ abi: VAULT_ABI, eventName: "Bought", args: { slot: 0n, keeper: BATCHER, rewardTo: REWARD_TO } }) as Hex[],
      data: encodeAbiParameters(Array(7).fill({ type: "uint256" }), [1n, 2n, 3n, 4n, 1n, 5n, 6n]),
      logIndex: 0,
    };
    expect(decodeBatcherEvent(BATCHER, bought)).toBeNull();
    expect(decodeVaultEvent(bought)).toMatchObject({ name: "Bought", buyNumber: 1n });
    expect(decodeVaultEvent(batchLog(BATCHER, 0))).toBeNull();
    expect(decodeBatcherEvent(BATCHER, { ...batchLog(BATCHER, 0), data: "0x1234" })).toBeNull();
  });

  it("throws for one of its events without a log index, which is what joins it to the vault's Bought", () => {
    expect(() => decodeBatcherEvent(BATCHER, batchLog(BATCHER))).toThrow(RangeError);
    expect(() => decodeBatcherEvent(BATCHER, batchLog(BATCHER, "nine"))).toThrow(RangeError);
  });
});

describe("joinBatchLogs", () => {
  const BATCHER = MAINNET_BATCHER;
  const OTHER: Address = "0x00000000000000000000000000000000000000b9";
  const log = (abi: Abi, eventName: string, args: Record<string, unknown>, address: Address, logIndex: number) => {
    const plain = abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName)!.inputs.filter((input) => !input.indexed);
    return {
      address,
      topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[],
      data: encodeAbiParameters(plain, plain.map((input) => args[input.name!])),
      logIndex,
    };
  };
  const bought = (vault: Address, logIndex: number) =>
    log(
      VAULT_ABI,
      "Bought",
      { slot: 0n, amountIn: 10n, amountOut: 20n, keeper: BATCHER, reward: 1n, floorOut: 19n, buyNumber: 1n, oracleDepth: 30n, rewardTo: REWARD_TO, dueSince: 7n },
      vault,
      logIndex,
    );
  const triggered = (vault: Address, logIndex: number, emitter: Address = BATCHER) => log(BATCHER_ABI, "Triggered", { vault, received: 20n, gasUsed: 5n }, emitter, logIndex);
  const batch = (logIndex: number) => log(BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: REWARD_TO, listed: 2n, tried: 2n, bought: 1n, earned: 1n }, BATCHER, logIndex);

  it("joins each Triggered to the vault's own Bought right before it, one run per Batch", () => {
    const runs = joinBatchLogs(
      [
        bought(A, 10),
        triggered(A, 11),
        log(BATCHER_ABI, "NotTriggered", { vault: B, reason: TOO_SOON, gasUsed: 3n }, BATCHER, 12),
        batch(13),
        // A second call in the same transaction, whose Triggered follows another vault's Bought.
        bought(B, 14),
        triggered(C, 15),
      ],
      (address) => address === BATCHER,
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ batcher: BATCHER, batch: { name: "Batch", logIndex: 13 }, notTriggered: [{ vault: B, reasonName: "TooSoon" }] });
    // From v2 on the vault names the batcher as its caller, and pays the batch's rewardTo itself.
    expect(runs[0]!.triggered).toMatchObject([
      { event: { vault: A, logIndex: 11 }, bought: { name: "Bought", emitter: A, buyNumber: 1n, keeper: BATCHER, rewardTo: REWARD_TO, dueSince: 7n } },
    ]);
    expect(runs[1]).toMatchObject({ batch: null, triggered: [{ event: { vault: C }, bought: null }] });
  });

  it("joins a v1 batch the same way, its Bought naming the batcher as the one paid", () => {
    const v1Bought = log(
      V1_VAULT_ABI as Abi,
      "Bought",
      { slot: 0n, amountIn: 10n, amountOut: 20n, keeper: V1_MAINNET_BATCHER, reward: 1n, floorOut: 19n, buyNumber: 2n, oracleDepth: 30n },
      A,
      0,
    );
    const v1Triggered = log(V1_BATCHER_ABI as Abi, "Triggered", { vault: A, received: 20n, gasUsed: 5n }, V1_MAINNET_BATCHER, 1);
    const v1Batch = log(
      V1_BATCHER_ABI as Abi,
      "Batch",
      { caller: KEEPER, rewardTo: REWARD_TO, listed: 1n, tried: 1n, bought: 1n, earned: 1n, swept: 0n },
      V1_MAINNET_BATCHER,
      2,
    );
    const [run] = joinBatchLogs([v1Bought, v1Triggered, v1Batch], (address) => address === V1_MAINNET_BATCHER);
    expect(run).toMatchObject({ batch: { source: "v1", swept: 0n }, triggered: [{ bought: { source: "v1", keeper: V1_MAINNET_BATCHER, rewardTo: V1_MAINNET_BATCHER, dueSince: null } }] });
  });

  it("reads nothing from a batcher it was not told of", () => {
    expect(joinBatchLogs([bought(A, 0), triggered(A, 1, OTHER), batch(2)], (address) => address === OTHER)).toMatchObject([
      { batcher: OTHER, batch: null, triggered: [{ bought: { emitter: A } }] },
    ]);
    expect(joinBatchLogs([bought(A, 0), triggered(A, 1, OTHER)], (address) => address === BATCHER)).toEqual([]);
  });
});
