/**
 * The batcher's TypeScript surface against scripted data: no node, no network.
 *
 * What these pin is what a keeper, a report and the app build on: the
 * registry ends with this build, the batcher's address follows from its code
 * and its factory, a simulation's answer lines up with the list it was asked
 * about, every reason a keeper will meet has a name, and a log another
 * contract wrote is never read as the batcher's. That the contract does what
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
  BATCHER_SALT,
  DEPLOYMENTS,
  DETERMINISTIC_DEPLOYER,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  MAX_EXECUTE_GAS_LIMIT,
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

describe("the registry and the batcher's address", () => {
  it("pins the batcher's limits; each vault gets exactly what a keeper lets one buy use", () => {
    expect(BATCHER_LIMITS).toEqual({ EXECUTE_GAS_CAP: 400_000n, MAX_VAULTS: 150n, MIN_GAS_PER_ATTEMPT: 460_000n });
    expect(BATCHER_LIMITS.EXECUTE_GAS_CAP).toBe(MAX_EXECUTE_GAS_LIMIT);
  });

  it("agrees with itself: salt, code hash, and the batcher bound to mainnet's factory", () => {
    expect(BATCHER_SALT).toBe(keccak256(toBytes("spdex.vault.batcher.v1")));
    expect(BATCHER_SALT).toBe("0x015db2dbb1d1dbeb1122646de77d5f4686cd4b3a16493fc58452916455efd143");
    expect(keccak256(BATCHER_CREATION_CODE)).toBe(BATCHER_CREATION_CODE_HASH);
    expect(batcherAddress(MAINNET_FACTORY)).toBe(MAINNET_BATCHER);
    // By hand: CREATE2 from the deterministic deployer over the creation code and the factory.
    expect(MAINNET_BATCHER).toBe(
      getContractAddress({
        opcode: "CREATE2",
        from: DETERMINISTIC_DEPLOYER,
        salt: BATCHER_SALT,
        bytecode: `${BATCHER_CREATION_CODE}${encodeAbiParameters([{ type: "address" }], [MAINNET_FACTORY]).slice(2)}`,
      }).toLowerCase(),
    );
    // Bound to another factory, it is another batcher.
    expect(batcherAddress(A)).not.toBe(MAINNET_BATCHER);
    expect(batcherAddress(A)).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("ends with this build, and its ids run v1, v2, … with no gap", () => {
    expect(DEPLOYMENTS.length).toBeGreaterThan(0);
    DEPLOYMENTS.forEach((deployment, i) => {
      expect(deployment.id).toBe(`v${i + 1}`);
      expect(deployment.factory).toMatch(/^0x[0-9a-f]{40}$/);
      expect(deployment.batcher).toMatch(/^0x[0-9a-f]{40}$/);
    });
    expect(DEPLOYMENTS.at(-1)).toMatchObject({ id: `v${DEPLOYMENTS.length}`, factory: MAINNET_FACTORY, batcher: MAINNET_BATCHER });
    // Every release before the last reached mainnet, and so has its blocks.
    for (const earlier of DEPLOYMENTS.slice(0, -1)) expect(earlier.factoryBlock).not.toBeNull();
  });

  it("is deployed through the deterministic deployer: salt, then init code, with no value", () => {
    const call = deployBatcherCall(MAINNET_FACTORY);
    expect(call.to).toBe(DETERMINISTIC_DEPLOYER);
    expect(call.value).toBe(0n);
    expect(call.batcher).toBe(MAINNET_BATCHER);
    expect(call.data.slice(0, 66)).toBe(BATCHER_SALT);
    expect(call.data.slice(66)).toBe(batcherInitCode(MAINNET_FACTORY).slice(2));
    expect(batcherInitCode(MAINNET_FACTORY).endsWith(MAINNET_FACTORY.slice(2))).toBe(true);
  });
});

describe("encodeExecuteBatch", () => {
  it("carries the vaults in order, where the rewards go, and the least the caller accepts", () => {
    const data = encodeExecuteBatch([A, B], REWARD_TO, 123n);
    expect(data.slice(0, 10)).toBe("0xf4ccdffc");
    expect(data.slice(0, 10)).toBe(toFunctionSelector("executeBatch(address[],address,uint256)"));
    const decoded = decodeFunctionData({ abi: BATCHER_ABI, data });
    expect(decoded.functionName).toBe("executeBatch");
    expect(decoded.args.map((arg) => (Array.isArray(arg) ? arg.map((a: string) => a.toLowerCase()) : typeof arg === "string" ? arg.toLowerCase() : arg))).toEqual([
      [A, B],
      REWARD_TO,
      123n,
    ]);
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
  it("names every refusal a keeper will meet: the vault's, the batcher's and Solidity's own", () => {
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
      "0x86764874": "TooManyVaults",
      "0x78ecf410": "RewardTransferFailed",
      "0x97133cf8": "NoFactory",
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
  const eventInputs = (name: "Batch" | "Triggered" | "NotTriggered") => {
    const event = BATCHER_ABI.find((item) => item.type === "event" && item.name === name);
    if (event?.type !== "event") throw new Error(`no event ${name}`);
    return event.inputs.filter((input) => !input.indexed);
  };

  const batchLog = (address: string, logIndex?: string | number) => ({
    address,
    topics: encodeEventTopics({ abi: BATCHER_ABI, eventName: "Batch", args: { caller: KEEPER, rewardTo: REWARD_TO } }) as Hex[],
    data: encodeAbiParameters(eventInputs("Batch"), [3n, 2n, 1n, 5_000n, 7n]),
    ...(logIndex === undefined ? {} : { logIndex }),
  });

  it("knows its events by the topics the contract emits", () => {
    expect(BATCHER_EVENT_TOPICS).toEqual({
      Batch: "0x1e048d0563704be3cfcbd9b79728ada66cb33aff02ed72e583428009b5216c77",
      Triggered: "0xdf3dd2ca88a00202ce95068ac9e4bac0de22ee6bde7cd801c4c12514e1bee499",
      NotTriggered: "0xf6d9b55a91640d8cf119e10d155d45ea8331e8c0ef5b1e634f3d054573beac55",
    });
  });

  it("reads Batch, Triggered and NotTriggered, with their log index, lowercasing addresses", () => {
    expect(decodeBatcherEvent(BATCHER, batchLog(BATCHER.toUpperCase().replace("0X", "0x"), "0x9"))).toEqual({
      name: "Batch",
      emitter: BATCHER,
      logIndex: 9,
      caller: KEEPER,
      rewardTo: REWARD_TO,
      listed: 3n,
      tried: 2n,
      bought: 1n,
      earned: 5_000n,
      swept: 7n,
    });
    expect(
      decodeBatcherEvent(BATCHER, {
        address: BATCHER,
        topics: encodeEventTopics({ abi: BATCHER_ABI, eventName: "Triggered", args: { vault: A } }) as Hex[],
        data: encodeAbiParameters(eventInputs("Triggered"), [12_345n, 101_000n]),
        logIndex: 4,
      }),
    ).toEqual({ name: "Triggered", emitter: BATCHER, logIndex: 4, vault: A, received: 12_345n, gasUsed: 101_000n });
    expect(
      decodeBatcherEvent(BATCHER, {
        address: BATCHER,
        topics: encodeEventTopics({ abi: BATCHER_ABI, eventName: "NotTriggered", args: { vault: B, reason: "0xE86F59EA" } }) as Hex[],
        data: encodeAbiParameters(eventInputs("NotTriggered"), [11_000n]),
        logIndex: "0x5",
      }),
    ).toEqual({ name: "NotTriggered", emitter: BATCHER, logIndex: 5, vault: B, reason: TOO_SOON, reasonName: "TooSoon", gasUsed: 11_000n });
  });

  it("returns null for a log another contract wrote, even one shaped exactly like the batcher's", () => {
    expect(decodeBatcherEvent(BATCHER, batchLog(A, "0x1"))).toBeNull();
    expect(decodeBatcherEvent(A, batchLog(BATCHER, "0x1"))).toBeNull();
    expect(decodeBatcherEvent(A.toUpperCase().replace("0X", "0x") as Address, batchLog(A, "0x1"))).toMatchObject({ emitter: A });
  });

  it("returns null for a log of the batcher's that is none of its events, and leaves a vault's Bought to decodeVaultEvent", () => {
    const bought = {
      address: BATCHER,
      topics: encodeEventTopics({ abi: VAULT_ABI, eventName: "Bought", args: { slot: 0n, keeper: BATCHER } }) as Hex[],
      data: encodeAbiParameters(Array(6).fill({ type: "uint256" }), [1n, 2n, 3n, 4n, 1n, 5n]),
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
    log(VAULT_ABI, "Bought", { slot: 0n, amountIn: 10n, amountOut: 20n, keeper: BATCHER, reward: 1n, floorOut: 19n, buyNumber: 1n, oracleDepth: 30n }, vault, logIndex);
  const triggered = (vault: Address, logIndex: number, emitter: Address = BATCHER) => log(BATCHER_ABI, "Triggered", { vault, received: 20n, gasUsed: 5n }, emitter, logIndex);
  const batch = (logIndex: number) => log(BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: REWARD_TO, listed: 2n, tried: 2n, bought: 1n, earned: 1n, swept: 0n }, BATCHER, logIndex);

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
    expect(runs[0]!.triggered).toMatchObject([{ event: { vault: A, logIndex: 11 }, bought: { name: "Bought", emitter: A, buyNumber: 1n } }]);
    expect(runs[1]).toMatchObject({ batch: null, triggered: [{ event: { vault: C }, bought: null }] });
  });

  it("reads nothing from a batcher it was not told of", () => {
    expect(joinBatchLogs([bought(A, 0), triggered(A, 1, OTHER), batch(2)], (address) => address === OTHER)).toMatchObject([
      { batcher: OTHER, batch: null, triggered: [{ bought: { emitter: A } }] },
    ]);
    expect(joinBatchLogs([bought(A, 0), triggered(A, 1, OTHER)], (address) => address === BATCHER)).toEqual([]);
  });
});
