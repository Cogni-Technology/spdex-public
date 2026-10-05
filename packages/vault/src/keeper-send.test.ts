/**
 * The nonce manager's own pieces: what it will sign, that it records before
 * it broadcasts, what an endpoint's refusal means, and what a receipt says.
 *
 * Its flows across ticks — a resend, a cancel, an abandoned nonce, a late
 * receipt, a reorg — run through `keeperTick` against a scripted chain in
 * `keeper.test.ts`, since each is a sequence of ticks.
 */

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, parseTransaction, type Abi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { addressOfKey, type PreparedTransaction } from "@spdex/chain";
import {
  BATCHER_ABI,
  DETERMINISTIC_DEPLOYER,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  REGISTRY_ABI,
  SOURCES,
  V1_BATCHER_ABI,
  V1_VAULT_ABI,
  VAULT_ABI,
  batcherInitCode,
  v1BatcherAddress,
  type Deployment,
} from "./artifacts.js";
import { encodeExecute, encodeProve } from "./index.js";
import { keeperConfig } from "./keeper-config.js";
import { newKeeperState, type PendingTx } from "./keeper-state.js";
import {
  CANCEL_GAS,
  KeeperSignRefused,
  PROVE_SELECTOR,
  assertKeeperMaySign,
  batcherDeploymentOf,
  batcherSourceOfDeployment,
  buildTransaction,
  classifySendError,
  decodeBatchReceipt,
  encodeBatchFor,
  gasPerVaultOf,
  isConfirmed,
  newBatchId,
  nextNonceFor,
  signRecordSend,
  type RpcReceipt,
} from "./keeper-send.js";

const KEY: Hex = `0x${"42".repeat(32)}`;
const KEEPER = addressOfKey(KEY);
const COLD: Address = "0x00000000000000000000000000000000000000c0";
const WETH = MAINNET_DEPLOYMENT.weth;
const MARKETS = MAINNET_DEPLOYMENT.markets;
const V1_FACTORY: Address = "0x00000000000000000000000000000000000000f1";
/** A v1 release on its own factory: its batcher is v1's code bound to that factory, where that code lands. */
const V1: Deployment = {
  id: "v1",
  source: "v1",
  factory: V1_FACTORY,
  batcher: v1BatcherAddress(V1_FACTORY),
  registry: null,
  markets: MARKETS,
  factoryBlock: null,
  batcherBlock: null,
  registryBlock: null,
};
/** A v2 release: its batcher is the one bound to no factory, built for WETH, that every such release shares. */
const V2: Deployment = {
  id: "v2",
  source: "v2",
  factory: "0x00000000000000000000000000000000000000f2",
  batcher: MAINNET_BATCHER,
  registry: "0x00000000000000000000000000000000000000e2",
  markets: MARKETS,
  factoryBlock: null,
  batcherBlock: null,
  registryBlock: null,
};
const OTHER_FACTORY: Address = "0x00000000000000000000000000000000000000f9";
const OTHER_REGISTRY: Address = "0x00000000000000000000000000000000000000e9";
const USDC: Address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const VAULT: Address = "0x00000000000000000000000000000000000000a1";
const FEES = { type: "eip1559" as const, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 20_000_000n };
const GAS = 400_000n;

const config = (rewardTo: Address | null = COLD, options: { prove?: boolean; gasPerVault?: bigint } = {}) =>
  keeperConfig({
    chainId: 1,
    deployments: [V1, V2],
    keeperKey: KEY,
    ...(rewardTo ? { rewardTo } : {}),
    prove: options.prove ?? true,
    ...(options.gasPerVault ? { gasPerVault: options.gasPerVault } : {}),
  });
/** A batch to a release's batcher, in its own batcher's shape. */
const batch = (d: Deployment, rewardTo: Address = COLD, gas = GAS) => encodeBatchFor(d, [VAULT], rewardTo, 0n, gas);
/** The deterministic deployer's call for `initCode` under `source`'s batcher salt. */
const deployCall = (source: "v1" | "v2", initCode: Hex): Hex => `0x${SOURCES[source].batcherSalt.slice(2)}${initCode.slice(2)}` as Hex;
/** A proof of `holder`'s SPX: its bytes don't matter here, only whose it is and where it goes. */
const prove = (holder: Address) => encodeProve({ holder, header: "0xf901", accountProof: ["0xf8"], storageProof: ["0xe2"] });
const tx = (to: Address, data: Hex, overrides: Partial<PreparedTransaction> = {}): PreparedTransaction => ({
  ...buildTransaction({ from: KEEPER, chainId: 1, nonce: 0, to, data, gas: 500_000n, fees: FEES }),
  ...overrides,
});
const withdraw = encodeFunctionData({ abi: parseAbi(["function withdraw(uint256)"]), functionName: "withdraw", args: [10n ** 15n] });

describe("assertKeeperMaySign", () => {
  it("allows the five shapes", () => {
    // A batch, to each release's batcher in its own shape: v1's three arguments, the shared batcher's four.
    expect(() => assertKeeperMaySign(tx(V1.batcher, batch(V1)), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(V2.batcher, batch(V2)), config())).not.toThrow();
    // At a higher gas per vault, when the operator configured it.
    expect(() => assertKeeperMaySign(tx(V2.batcher, batch(V2, COLD, 600_000n)), config(COLD, { gasPerVault: 600_000n }))).not.toThrow();
    // Each release's batcher from its own code, where that code lands.
    expect(() => assertKeeperMaySign(tx(DETERMINISTIC_DEPLOYER, batcherDeploymentOf(V1, WETH)!.data), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(DETERMINISTIC_DEPLOYER, batcherDeploymentOf(V2, WETH)!.data), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(KEEPER, "0x", { gas: CANCEL_GAS }), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(WETH, withdraw), config(null))).not.toThrow();
    // A proof of the configured rewardTo's SPX, to a listed registry, with proving on — or of the keeper, its own rewardTo.
    expect(() => assertKeeperMaySign(tx(V2.registry!, prove(COLD), { gas: 750_000n }), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(V2.registry!, prove(KEEPER)), config(null))).not.toThrow();
    expect(prove(COLD).startsWith(PROVE_SELECTOR)).toBe(true);
  });

  it("refuses every near miss", () => {
    const off = config(COLD, { prove: false });
    const isEligible = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "isEligible", args: [COLD] });
    const v1Shaped = encodeFunctionData({ abi: V1_BATCHER_ABI, functionName: "executeBatch", args: [[VAULT], COLD, 0n] });
    const v2Shaped = encodeFunctionData({ abi: BATCHER_ABI, functionName: "executeBatch", args: [[VAULT], COLD, 0n, GAS] });
    const refused: [string, PreparedTransaction, ReturnType<typeof config>][] = [
      ["a batcher not listed", tx("0x00000000000000000000000000000000000000b9", batch(V2)), config()],
      ["ether on a batch", tx(V1.batcher, batch(V1), { value: 1n }), config()],
      ["another selector to the batcher", tx(V1.batcher, "0x61461954"), config()],
      ["a batch paying someone else", tx(V1.batcher, batch(V1, VAULT)), config()],
      ["a shared batch paying someone else", tx(V2.batcher, batch(V2, VAULT)), config()],
      // The shared batcher takes each vault's gas from its caller: only the configured figure is signed.
      ["a shared batch at another gas per vault", tx(V2.batcher, batch(V2, COLD, GAS + 1n)), config()],
      ["a shared batch above the configured gas", tx(V2.batcher, batch(V2, COLD, 10_000_000n)), config()],
      // Each batcher's own shape only.
      ["v1's three-argument batch to the shared batcher", tx(V2.batcher, v1Shaped), config()],
      ["a four-argument batch to v1's batcher", tx(V1.batcher, v2Shaped), config()],
      ["v1's batcher code bound to an unlisted factory", tx(DETERMINISTIC_DEPLOYER, deployCall("v1", batcherInitCode(OTHER_FACTORY, "v1"))), config()],
      // The wrong code for a listed batcher: a batcher at an address no release lists.
      ["v1's factory's batcher from the shared batcher's code", tx(DETERMINISTIC_DEPLOYER, deployCall("v2", batcherInitCode(V1.factory, "v2"))), config()],
      ["the shared batcher from v1's code", tx(DETERMINISTIC_DEPLOYER, deployCall("v1", batcherInitCode(WETH, "v1"))), config()],
      ["the shared batcher built for another token", tx(DETERMINISTIC_DEPLOYER, deployCall("v2", batcherInitCode(USDC, "v2"))), config()],
      ["anything else to the deployer", tx(DETERMINISTIC_DEPLOYER, "0x1234"), config()],
      ["a proof while proving is off", tx(V2.registry!, prove(COLD)), off],
      ["a proof of the keeper while rewards go elsewhere", tx(V2.registry!, prove(KEEPER)), config()],
      ["a proof of another holder", tx(V2.registry!, prove(VAULT)), config()],
      ["a proof with ether", tx(V2.registry!, prove(COLD), { value: 1n }), config()],
      ["a proof to a registry not listed", tx(OTHER_REGISTRY, prove(COLD)), config()],
      ["a proof to a batcher", tx(V2.batcher, prove(COLD)), config()],
      ["a proof to the deployer", tx(DETERMINISTIC_DEPLOYER, prove(COLD)), config()],
      ["another of the registry's functions", tx(V2.registry!, isEligible), config()],
      ["a proof's selector that does not decode", tx(V2.registry!, `${PROVE_SELECTOR}00`), config()],
      ["a v2 vault's execute, straight to the vault", tx(VAULT, encodeExecute(COLD)), config()],
      ["a self-transfer with data", tx(KEEPER, "0x00"), config()],
      ["a self-transfer with ether", tx(KEEPER, "0x", { value: 1n }), config()],
      ["an unwrap while rewards go elsewhere", tx(WETH, withdraw), config()],
      ["another call to WETH", tx(WETH, encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [COLD, 1n] })), config(null)],
      ["a call to a vault", tx(VAULT, "0x61461954"), config()],
      ["another chain", tx(V1.batcher, batch(V1), { chainId: 5 }), config()],
      ["another sender", tx(V1.batcher, batch(V1), { from: COLD }), config()],
    ];
    for (const [why, transaction, cfg] of refused) {
      expect(() => assertKeeperMaySign(transaction, cfg), why).toThrow(KeeperSignRefused);
    }
    expect(() => assertKeeperMaySign(tx(KEEPER, "0x"), keeperConfig({ chainId: 1, deployments: [V1] }))).toThrow(/no key/);
    // Off by default: a keeper configured without saying signs no proof at all.
    expect(() => assertKeeperMaySign(tx(V2.registry!, prove(COLD)), keeperConfig({ chainId: 1, deployments: [V1, V2], keeperKey: KEY, rewardTo: COLD }))).toThrow(
      /proving is off/,
    );
  });

  it("refuses a gas per vault the batcher itself would refuse, at configuration", () => {
    expect(() => config(COLD, { gasPerVault: GAS - 1n })).toThrow(/gasPerVault must be between 400000 and 10000000/);
    expect(() => config(COLD, { gasPerVault: 10_000_001n })).toThrow(/gasPerVault/);
  });
});

describe("a release's batcher, by its data", () => {
  it("takes the listed batcher's own source, or, for one spDEX does not list, its release's", () => {
    // The shared batcher this build lists, whichever release names it.
    expect(batcherSourceOfDeployment(V2)).toBe("v2");
    expect(batcherSourceOfDeployment({ ...V2, id: "v1", source: "v1" })).toBe("v2");
    // v1's code bound to a test's factory: not listed, so its release's source.
    expect(batcherSourceOfDeployment(V1)).toBe("v1");
    // A hand-edited config naming a source this build has no code for: refused, never guessed.
    expect(() => batcherSourceOfDeployment({ ...V1, batcher: "0x00000000000000000000000000000000000000b9", source: "v9" } as unknown as Deployment)).toThrow(
      /v9, which this keeper has no code for/,
    );
  });

  it("gives each vault the configured gas through a batcher that takes it, and v1's fixed cap through v1's", () => {
    expect(gasPerVaultOf({ gasPerVault: 600_000n }, V2)).toBe(600_000n);
    expect(gasPerVaultOf({ gasPerVault: 600_000n }, V1)).toBe(400_000n);
  });

  it("serves a later release built from v2's source with no code of its own: it shares the batcher", () => {
    // v3: another market list on v2's code, so another factory, the same shared batcher.
    const v3 = { ...V2, id: "v3", factory: OTHER_FACTORY } as unknown as Deployment;
    const third = keeperConfig({ chainId: 1, deployments: [V1, V2, v3], keeperKey: KEY, rewardTo: COLD });
    expect(() => assertKeeperMaySign(tx(v3.batcher, batch(v3)), third)).not.toThrow();
    expect(batcherDeploymentOf(v3, WETH)).toEqual(batcherDeploymentOf(V2, WETH));
    // A release whose listed batcher its own code does not land at has no deployment to allow.
    const misplaced = { ...V1, batcher: "0x00000000000000000000000000000000000000b9" } as Deployment;
    expect(batcherDeploymentOf(misplaced, WETH)).toBeNull();
  });
});

describe("sending", () => {
  it("records the attempt and persists it before the broadcast", async () => {
    const order: string[] = [];
    const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [V1] });
    const pending = { batchId: "b", nonce: 0, attempts: [] } as unknown as PendingTx;
    const sendRpc = async (method: string, params: unknown[]) => {
      order.push(`${method}:${state.pending?.attempts.length}`);
      return (params[0] as string).length > 0 ? "0x" : null;
    };
    const persist = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`persist:${state.pending?.attempts.length}`);
    };
    const transaction = tx(V1.batcher, batch(V1), { gas: 698_000n });
    const { attempt, refused } = await signRecordSend({ sendRpc, config: config(), state, pending, tx: transaction, kind: "batch", sentBlock: 9n, persist });
    expect(order).toEqual(["persist:1", "eth_sendRawTransaction:1"]);
    expect(refused).toBeNull();
    expect(state.pending).toBe(pending);
    expect(pending.attempts).toEqual([attempt]);
    // The limit signed is the keeper's own, exactly.
    expect(parseTransaction(attempt.raw).gas).toBe(698_000n);
    expect(attempt).toMatchObject({ kind: "batch", sentBlock: 9n, fees: FEES });
  });

  it("never signs what it may not, and never broadcasts it", async () => {
    const sent: string[] = [];
    const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [V1] });
    const pending = { batchId: "b", nonce: 0, attempts: [] } as unknown as PendingTx;
    await expect(
      signRecordSend({
        sendRpc: async (method) => sent.push(method),
        config: config(),
        state,
        pending,
        tx: tx(VAULT, "0x61461954"),
        kind: "batch",
        sentBlock: 1n,
        persist: async () => {},
      }),
    ).rejects.toThrow(KeeperSignRefused);
    expect(sent).toEqual([]);
    expect(state.pending).toBeNull();
  });

  it("reports an endpoint's refusal and keeps the attempt; 'already known' is a success", async () => {
    const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [V1] });
    const run = (message: string) =>
      signRecordSend({
        sendRpc: async () => {
          throw new Error(message);
        },
        config: config(),
        state,
        pending: { batchId: "b", nonce: 0, attempts: [] } as unknown as PendingTx,
        tx: tx(V1.batcher, batch(V1)),
        kind: "batch",
        sentBlock: 1n,
        persist: async () => {},
      });
    expect((await run("eth_sendRawTransaction: already known")).refused).toBeNull();
    expect((await run("eth_sendRawTransaction: nonce too low")).refused).toMatchObject({ kind: "nonce-too-low" });
    expect(state.pending?.attempts).toHaveLength(1);
  });

  it("classifies what an endpoint's refusal means", () => {
    expect(classifySendError(new Error("already known"))).toBe("known");
    expect(classifySendError(new Error("known transaction: 0xabc"))).toBe("known");
    expect(classifySendError(new Error("nonce too low: next nonce 5, tx nonce 4"))).toBe("nonce-too-low");
    expect(classifySendError(new Error("replacement transaction underpriced"))).toBe("underpriced");
    expect(classifySendError(new Error("transaction underpriced"))).toBe("underpriced");
    expect(classifySendError(new Error("insufficient funds for gas * price + value"))).toBe("other");
  });

  it("takes the later of the chain's latest nonce and its own", async () => {
    const rpc = async (method: string, params: unknown[]) => {
      expect(method).toBe("eth_getTransactionCount");
      // `latest`, never `pending`: a public endpoint cannot see a private relay's transaction.
      expect(params[1]).toBe("latest");
      return "0x5";
    };
    expect(await nextNonceFor(rpc, KEEPER, { nextNonce: null })).toBe(5);
    expect(await nextNonceFor(rpc, KEEPER, { nextNonce: 3 })).toBe(5);
    expect(await nextNonceFor(rpc, KEEPER, { nextNonce: 7 })).toBe(7);
  });

  it("names a batch by keeper, nonce and how many batches that nonce has carried", () => {
    const state = newKeeperState({ chainId: 1, keeper: KEEPER });
    expect(newBatchId(state, KEEPER, 4)).toBe(`${KEEPER}:4:0`);
    expect(newBatchId(state, KEEPER, 4)).toBe(`${KEEPER}:4:1`);
    expect(newBatchId(state, KEEPER, 5)).toBe(`${KEEPER}:5:0`);
  });

  it("counts a receipt's own block as its first confirmation", () => {
    expect(isConfirmed(10n, 10n, 1)).toBe(true);
    expect(isConfirmed(10n, 10n, 2)).toBe(false);
    expect(isConfirmed(11n, 10n, 2)).toBe(true);
  });
});

// ─── Receipts ─────────────────────────────────────────────────────────────────

/** A log as a node would give it: topics from the indexed arguments, data from the rest. */
function eventLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address, logIndex: number) {
  const event = abi.find((item) => item.type === "event" && item.name === eventName) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    event.inputs.filter((input) => !input.indexed).map((input) => args[input.name]),
  );
  return { address, topics, data, logIndex: `0x${logIndex.toString(16)}` };
}

describe("decodeBatchReceipt", () => {
  const A: Address = "0x00000000000000000000000000000000000000a1";
  const B: Address = "0x00000000000000000000000000000000000000a2";
  const C: Address = "0x00000000000000000000000000000000000000a3";
  const bought = (vault: Address, logIndex: number, reward: bigint) =>
    eventLog(V1_VAULT_ABI, "Bought", { slot: 2n, amountIn: 10n ** 16n, amountOut: 5n * 10n ** 20n, keeper: V1.batcher, reward, floorOut: 4n * 10n ** 20n, buyNumber: 3n, oracleDepth: 60n * 10n ** 18n }, vault, logIndex);
  const receipt = (logs: ReturnType<typeof eventLog>[], status = 1n): RpcReceipt => ({
    transactionHash: `0x${"ab".repeat(32)}`,
    status,
    blockNumber: 100n,
    gasUsed: 300_000n,
    effectiveGasPrice: 100_000_000n,
    logs,
  });
  const decode = (r: RpcReceipt) =>
    decodeBatchReceipt({
      receipt: r,
      batcher: V1.batcher,
      vaults: [A, B, C],
      clockOf: () => ({ startAt: 1_000n, interval: 3_600n }),
      blockTime: 1_000n + 2n * 3_600n + 90n,
      batchId: "b",
      nonce: 4,
      late: false,
    });

  it("joins each Bought to the Triggered right after it, and books earned apart from swept", () => {
    const mined = decode(
      receipt([
        bought(A, 3, 7n),
        eventLog(V1_BATCHER_ABI, "Triggered", { vault: A, received: 5n * 10n ** 20n, gasUsed: 101_000n }, V1.batcher, 4),
        eventLog(V1_BATCHER_ABI, "NotTriggered", { vault: B, reason: "0xe86f59ea", gasUsed: 21_000n }, V1.batcher, 5),
        eventLog(V1_BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: COLD, listed: 3n, tried: 2n, bought: 1n, earned: 7n, swept: 1_000n }, V1.batcher, 6),
      ]),
    );
    expect(mined).toMatchObject({ status: "success", earnedWei: 7n, sweptWei: 1_000n, costWei: 30_000_000_000_000n, netWei: 7n - 30_000_000_000_000n, listed: 3n, tried: 2n });
    // A v1 buy names only its caller, the batcher, and has no community window.
    expect(mined.bought).toEqual([
      {
        vault: A,
        slot: 2n,
        buyNumber: 3n,
        amountIn: 10n ** 16n,
        amountOut: 5n * 10n ** 20n,
        floorOut: 4n * 10n ** 20n,
        oracleDepth: 60n * 10n ** 18n,
        reward: 7n,
        gasUsed: 101_000n,
        secondsIntoWindow: 90n,
        rewardTo: V1.batcher,
        dueSince: null,
        inCommunityWindow: null,
      },
    ]);
    expect(mined.refused).toEqual([{ vault: B, reason: "0xe86f59ea", reasonName: "TooSoon", gasUsed: 21_000n }]);
    expect(mined.notTried).toEqual([C]);
  });

  it("reads nothing from a look-alike: another emitter's Triggered, or a Bought not from the vault it names", () => {
    const mined = decode(
      receipt([
        bought(B, 0, 7n),
        eventLog(V1_BATCHER_ABI, "Triggered", { vault: A, received: 1n, gasUsed: 1n }, V1.batcher, 1),
        bought(A, 2, 7n),
        eventLog(V1_BATCHER_ABI, "Triggered", { vault: A, received: 1n, gasUsed: 1n }, "0x00000000000000000000000000000000000000b9", 3),
        eventLog(V1_BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: COLD, listed: 3n, tried: 3n, bought: 0n, earned: 999n, swept: 0n }, "0x00000000000000000000000000000000000000b9", 4),
      ]),
    );
    expect(mined.bought).toEqual([]);
    expect(mined.earnedWei).toBe(0n);
  });

  it("books a reverted batch as its cost, with nothing bought", () => {
    const mined = decode(receipt([], 0n));
    expect(mined).toMatchObject({ status: "reverted", bought: [], earnedWei: 0n, sweptWei: null, netWei: -30_000_000_000_000n, notTried: [] });
  });

  it("reads a v2 batch: whom each buy paid, when it fell due, whether inside its community window, and no sweep", () => {
    const START = 1_000n;
    const HOUR = 3_600n;
    const boughtV2 = (vault: Address, logIndex: number, dueSince: bigint) =>
      eventLog(
        VAULT_ABI,
        "Bought",
        { slot: 2n, amountIn: 10n ** 16n, amountOut: 1n, keeper: V2.batcher, reward: 5n, floorOut: 1n, buyNumber: 3n, oracleDepth: 1n, rewardTo: COLD, dueSince },
        vault,
        logIndex,
      );
    const mined = decodeBatchReceipt({
      receipt: receipt([
        boughtV2(A, 0, START + 2n * HOUR),
        eventLog(BATCHER_ABI, "Triggered", { vault: A, received: 1n, gasUsed: 110_000n }, V2.batcher, 1),
        // Its buy fell due 2 hours and 100 seconds in: still inside its 900-second window at block time.
        boughtV2(B, 2, START + 2n * HOUR - 800n),
        eventLog(BATCHER_ABI, "Triggered", { vault: B, received: 1n, gasUsed: 105_000n }, V2.batcher, 3),
        eventLog(BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: COLD, listed: 3n, tried: 2n, bought: 2n, earned: 10n }, V2.batcher, 4),
      ]),
      batcher: V2.batcher,
      vaults: [A, B, C],
      clockOf: () => ({ startAt: START, interval: HOUR, communityWindow: 900n }),
      blockTime: START + 2n * HOUR + 120n,
      batchId: "b",
      nonce: 5,
      late: false,
    });
    expect(mined).toMatchObject({ status: "success", earnedWei: 10n, sweptWei: null, tried: 2n, notTried: [C] });
    expect(mined.bought.map((b) => [b.vault, b.rewardTo, b.dueSince, b.inCommunityWindow])).toEqual([
      [A, COLD, START + 2n * HOUR, true],
      [B, COLD, START + 2n * HOUR - 800n, false],
    ]);
  });
});
