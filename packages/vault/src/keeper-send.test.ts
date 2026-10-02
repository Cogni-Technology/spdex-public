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
import { BATCHER_ABI, DETERMINISTIC_DEPLOYER, MAINNET_DEPLOYMENT, VAULT_ABI, type Deployment } from "./artifacts.js";
import { deployBatcherCall, encodeExecuteBatch } from "./batcher.js";
import { keeperConfig } from "./keeper-config.js";
import { newKeeperState, type PendingTx } from "./keeper-state.js";
import {
  CANCEL_GAS,
  KeeperSignRefused,
  assertKeeperMaySign,
  buildTransaction,
  classifySendError,
  decodeBatchReceipt,
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
const V1: Deployment = { id: "v1", factory: "0x00000000000000000000000000000000000000f1", batcher: "0x00000000000000000000000000000000000000b1", factoryBlock: null, batcherBlock: null };
const OTHER_FACTORY: Address = "0x00000000000000000000000000000000000000f9";
const VAULT: Address = "0x00000000000000000000000000000000000000a1";
const FEES = { type: "eip1559" as const, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 20_000_000n };

const config = (rewardTo: Address | null = COLD) =>
  keeperConfig({ chainId: 1, deployments: [V1], keeperKey: KEY, ...(rewardTo ? { rewardTo } : {}) });
const tx = (to: Address, data: Hex, overrides: Partial<PreparedTransaction> = {}): PreparedTransaction => ({
  ...buildTransaction({ from: KEEPER, chainId: 1, nonce: 0, to, data, gas: 500_000n, fees: FEES }),
  ...overrides,
});
const withdraw = encodeFunctionData({ abi: parseAbi(["function withdraw(uint256)"]), functionName: "withdraw", args: [10n ** 15n] });

describe("assertKeeperMaySign", () => {
  it("allows the four shapes", () => {
    expect(() => assertKeeperMaySign(tx(V1.batcher, encodeExecuteBatch([VAULT], COLD, 0n)), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(DETERMINISTIC_DEPLOYER, deployBatcherCall(V1.factory).data), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(KEEPER, "0x", { gas: CANCEL_GAS }), config())).not.toThrow();
    expect(() => assertKeeperMaySign(tx(WETH, withdraw), config(null))).not.toThrow();
  });

  it("refuses every near miss", () => {
    const refused: [string, PreparedTransaction, ReturnType<typeof config>][] = [
      ["a batcher not listed", tx("0x00000000000000000000000000000000000000b9", encodeExecuteBatch([VAULT], COLD, 0n)), config()],
      ["ether on a batch", tx(V1.batcher, encodeExecuteBatch([VAULT], COLD, 0n), { value: 1n }), config()],
      ["another selector to the batcher", tx(V1.batcher, "0x61461954"), config()],
      ["a batch paying someone else", tx(V1.batcher, encodeExecuteBatch([VAULT], VAULT, 0n)), config()],
      ["an unlisted factory's batcher deployment", tx(DETERMINISTIC_DEPLOYER, deployBatcherCall(OTHER_FACTORY).data), config()],
      ["anything else to the deployer", tx(DETERMINISTIC_DEPLOYER, "0x1234"), config()],
      ["a self-transfer with data", tx(KEEPER, "0x00"), config()],
      ["a self-transfer with ether", tx(KEEPER, "0x", { value: 1n }), config()],
      ["an unwrap while rewards go elsewhere", tx(WETH, withdraw), config()],
      ["another call to WETH", tx(WETH, encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [COLD, 1n] })), config(null)],
      ["a call to a vault", tx(VAULT, "0x61461954"), config()],
      ["another chain", tx(V1.batcher, encodeExecuteBatch([VAULT], COLD, 0n), { chainId: 5 }), config()],
      ["another sender", tx(V1.batcher, encodeExecuteBatch([VAULT], COLD, 0n), { from: COLD }), config()],
    ];
    for (const [why, transaction, cfg] of refused) {
      expect(() => assertKeeperMaySign(transaction, cfg), why).toThrow(KeeperSignRefused);
    }
    expect(() => assertKeeperMaySign(tx(KEEPER, "0x"), keeperConfig({ chainId: 1, deployments: [V1] }))).toThrow(/no key/);
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
    const transaction = tx(V1.batcher, encodeExecuteBatch([VAULT], COLD, 0n), { gas: 698_000n });
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
        tx: tx(V1.batcher, encodeExecuteBatch([VAULT], COLD, 0n)),
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
    eventLog(VAULT_ABI, "Bought", { slot: 2n, amountIn: 10n ** 16n, amountOut: 5n * 10n ** 20n, keeper: V1.batcher, reward, floorOut: 4n * 10n ** 20n, buyNumber: 3n, oracleDepth: 60n * 10n ** 18n }, vault, logIndex);
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
        eventLog(BATCHER_ABI, "Triggered", { vault: A, received: 5n * 10n ** 20n, gasUsed: 101_000n }, V1.batcher, 4),
        eventLog(BATCHER_ABI, "NotTriggered", { vault: B, reason: "0xe86f59ea", gasUsed: 21_000n }, V1.batcher, 5),
        eventLog(BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: COLD, listed: 3n, tried: 2n, bought: 1n, earned: 7n, swept: 1_000n }, V1.batcher, 6),
      ]),
    );
    expect(mined).toMatchObject({ status: "success", earnedWei: 7n, sweptWei: 1_000n, costWei: 30_000_000_000_000n, netWei: 7n - 30_000_000_000_000n, listed: 3n, tried: 2n });
    expect(mined.bought).toEqual([
      { vault: A, slot: 2n, buyNumber: 3n, amountIn: 10n ** 16n, amountOut: 5n * 10n ** 20n, floorOut: 4n * 10n ** 20n, oracleDepth: 60n * 10n ** 18n, reward: 7n, gasUsed: 101_000n, secondsIntoWindow: 90n },
    ]);
    expect(mined.refused).toEqual([{ vault: B, reason: "0xe86f59ea", reasonName: "TooSoon", gasUsed: 21_000n }]);
    expect(mined.notTried).toEqual([C]);
  });

  it("reads nothing from a look-alike: another emitter's Triggered, or a Bought not from the vault it names", () => {
    const mined = decode(
      receipt([
        bought(B, 0, 7n),
        eventLog(BATCHER_ABI, "Triggered", { vault: A, received: 1n, gasUsed: 1n }, V1.batcher, 1),
        bought(A, 2, 7n),
        eventLog(BATCHER_ABI, "Triggered", { vault: A, received: 1n, gasUsed: 1n }, "0x00000000000000000000000000000000000000b9", 3),
        eventLog(BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: COLD, listed: 3n, tried: 3n, bought: 0n, earned: 999n, swept: 0n }, "0x00000000000000000000000000000000000000b9", 4),
      ]),
    );
    expect(mined.bought).toEqual([]);
    expect(mined.earnedWei).toBe(0n);
  });

  it("books a reverted batch as its cost, with nothing bought", () => {
    const mined = decode(receipt([], 0n));
    expect(mined).toMatchObject({ status: "reverted", bought: [], earnedWei: 0n, netWei: -30_000_000_000_000n, notTried: [] });
  });
});
