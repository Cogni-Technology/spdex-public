/**
 * The keeper's ticks against a scripted chain.
 *
 * `FakeChain` answers the calls a keeper makes — the head, Multicall3 reads of
 * vaults, the factory's list, the batcher's simulation — and mines what it is
 * sent: a batch buys each vault the way the vault would (or refuses it the way
 * a test says it will on chain), and pays its fees. The tests drive ticks
 * through it and look at what the keeper sent, logged and remembered.
 *
 * A tick that signs and sends for real is exercised on the fork
 * (`test/integration/keeper.test.ts`); here are the rules a real chain cannot
 * easily be made to show: a listed vault never distrusted, discovery bounded,
 * each simulated and on-chain refusal's consequence, traps and their expiry,
 * missed windows, stale heads, and the nonce manager's resends, cancels,
 * abandonments, late receipts and reorgs.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  parseTransaction,
  type Abi,
} from "viem";
import type { Address, Hex } from "@spdex/core";
import { addressOfKey } from "@spdex/chain";
import { BATCHER_ABI, DETERMINISTIC_DEPLOYER, FACTORY_ABI, MAINNET_DEPLOYMENT, VAULT_ABI, VAULT_LIMITS, type Deployment } from "./artifacts.js";
import type { VaultTerms } from "./index.js";
import {
  deployMissingBatchers,
  keeperConfig,
  keeperTick,
  makeRedactor,
  newKeeperState,
  parseKeeperState,
  serializeKeeperState,
  settleInFlight,
  toJsonLine,
  type KeeperLogRecord,
  type KeeperPolicy,
  type KeeperState,
} from "./keeper.js";

const FACTORY: Address = "0x00000000000000000000000000000000000000ff";
const BATCHER: Address = "0x00000000000000000000000000000000000000bb";
const V1: Deployment = { id: "v1", factory: FACTORY, batcher: BATCHER, factoryBlock: null, batcherBlock: null };
const SPX: Address = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const PAIR: Address = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";
const POOL: Address = "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3";
const WETH = MAINNET_DEPLOYMENT.weth;
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
const KEY: Hex = `0x${"11".repeat(32)}`;
const KEEPER = addressOfKey(KEY);
const COLD: Address = "0x00000000000000000000000000000000000000c0";
const OWNER: Address = "0x00000000000000000000000000000000000000d0";
/** A URL the fake endpoint quotes in its errors, as anvil quotes its upstream: the log must never carry it. */
const UPSTREAM = "https://archive.example/v2/SECRETSECRETSECRETSECRET";
const ETHER = 10n ** 18n;
const HOUR = 3_600n;
const DAY = 86_400n;
const T0 = 1_790_000_000n;

const REASON = {
  BOUGHT: "0x00000000",
  TooSoon: "0xe86f59ea",
  PriceBelowFloor: "0xd6e7da92",
  OracleTooThin: "0x9de2f4e2",
  NotStarted: "0x03454d3b",
  NoBuysLeft: "0xb58de46f",
  InsufficientBalance: "0xcf479181",
  VaultClosed: "0xdf23397a",
  NotFromFactory: "0xb1391cf3",
  EmptyRevert: "0x23b3fa42",
} as const satisfies Record<string, Hex>;

// ─── The scripted chain ───────────────────────────────────────────────────────

interface FakeVault {
  owner: Address;
  terms: VaultTerms;
  buysDone: bigint;
  lastBuyAt: bigint;
  closed: boolean;
  balance: bigint;
  quote: { spotOut: bigint; floorOut: bigint; oracleDepth: bigint } | null;
  /** On the factory's list (and so vouched for). */
  listed: boolean;
  /** Refused by the batcher's simulation with this reason, whatever the reads say. */
  simulated?: Hex;
  /** Refused on chain with this reason and gas, though it simulated fine. */
  onChain?: { reason: Hex; gasUsed: bigint };
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)"]);
const pairAbi = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
const multicallAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/** A log as a node gives it: topics from the indexed arguments, data from the rest. */
function eventLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address) {
  const event = abi.find((item) => item.type === "event" && item.name === eventName) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const plain = event.inputs.filter((input) => !input.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[],
    data: encodeAbiParameters(plain, plain.map((input) => args[input.name])),
  };
}

class FakeChain {
  block = 26_000_000n;
  time = T0;
  baseFee = 100_000_000n;
  readonly blockTimes = new Map<bigint, bigint>([[26_000_000n, T0]]);
  readonly vaults = new Map<Address, FakeVault>();
  readonly list: Address[] = [];
  /** The keeper's mined nonce count. */
  nonce = 0;
  keeperBalance = ETHER;
  keeperWeth = 0n;
  readonly weth = new Map<Address, bigint>();
  /** Mine what is sent at once; when false, sends wait in `mempool` for `mine()`. */
  autoMine = true;
  readonly mempool = new Map<number, Hex>();
  readonly receipts = new Map<Hex, unknown>();
  readonly methods: string[] = [];
  readonly calls: string[] = [];
  readonly sentRaw: Hex[] = [];
  /** Throw from the next batcher simulation with no revert data, quoting the upstream URL. */
  failNextSimulation = false;
  /** Addresses with no code yet. */
  readonly codeless = new Set<Address>();

  addVault(vault: Address, overrides: Omit<Partial<FakeVault>, "terms"> & { terms?: Partial<VaultTerms> } = {}): Address {
    const { terms, ...rest } = overrides;
    const v: FakeVault = {
      owner: OWNER,
      terms: { tokenOut: SPX, pair: PAIR, oraclePool: POOL, amountPerBuy: ETHER / 100n, interval: DAY, maxBuys: 3n, startAt: this.time, keeperReward: 87_300_000_000_000n, maxSlippageBps: 300n, ...terms },
      buysDone: 0n,
      lastBuyAt: 0n,
      closed: false,
      balance: 0n,
      quote: { spotOut: 1_000n, floorOut: 970n, oracleDepth: 60n * ETHER },
      listed: true,
      ...rest,
    };
    if (overrides.balance === undefined) v.balance = v.terms.maxBuys * (v.terms.amountPerBuy + v.terms.keeperReward);
    this.vaults.set(vault, v);
    if (v.listed) this.list.push(vault);
    return vault;
  }

  /** Advance the chain by empty blocks. */
  advance(seconds: bigint, blocks = 1n): void {
    for (let i = 0n; i < blocks; i++) {
      this.block += 1n;
      this.time += seconds / blocks;
      this.blockTimes.set(this.block, this.time);
    }
  }

  earliest(v: FakeVault): bigint {
    if (v.lastBuyAt === 0n) return v.terms.startAt;
    const next = v.terms.startAt + ((v.lastBuyAt - v.terms.startAt) / v.terms.interval + 1n) * v.terms.interval;
    const spaced = v.lastBuyAt + v.terms.interval / 2n;
    return next > spaced ? next : spaced;
  }

  /** What the vault would do if `execute`d at `time`: the vault's own checks, in its order. */
  outcome(vault: Address, time: bigint, real: boolean): Hex {
    const v = this.vaults.get(vault);
    if (!v || !v.listed) return REASON.NotFromFactory;
    if (real && v.onChain) return v.onChain.reason;
    if (v.simulated) return v.simulated;
    if (v.closed) return REASON.VaultClosed;
    if (time < v.terms.startAt) return REASON.NotStarted;
    if (time < this.earliest(v)) return REASON.TooSoon;
    if (v.buysDone >= v.terms.maxBuys) return REASON.NoBuysLeft;
    if (v.balance < v.terms.amountPerBuy + v.terms.keeperReward) return REASON.InsufficientBalance;
    if (!v.quote || v.quote.oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH) return REASON.OracleTooThin;
    if (v.quote.spotOut < v.quote.floorOut) return REASON.PriceBelowFloor;
    return REASON.BOUGHT;
  }

  answer(to: Address, data: Hex): { success: boolean; returnData: Hex } {
    const ok = (returnData: Hex) => ({ success: true, returnData });
    const fail = { success: false, returnData: "0x" as Hex };
    const v = this.vaults.get(to);
    if (v) {
      const { functionName } = decodeFunctionData({ abi: VAULT_ABI, data });
      this.calls.push(functionName);
      const results: Record<string, unknown> = {
        owner: v.owner,
        terms: v.terms,
        buysDone: Number(v.buysDone),
        lastBuyAt: v.lastBuyAt,
        closed: v.closed,
        quote: v.quote ? [v.quote.spotOut, v.quote.floorOut, v.quote.oracleDepth] : undefined,
      };
      if (results[functionName] === undefined) return fail;
      return ok(encodeFunctionResult({ abi: VAULT_ABI, functionName: functionName as never, result: results[functionName] as never }));
    }
    if (to === FACTORY) {
      const decoded = decodeFunctionData({ abi: FACTORY_ABI, data });
      this.calls.push(decoded.functionName);
      if (decoded.functionName === "isVault") {
        return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", result: this.vaults.get(String(decoded.args![0]).toLowerCase() as Address)?.listed ?? false }));
      }
      if (decoded.functionName === "vaultCount") return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", result: BigInt(this.list.length) }));
      if (decoded.functionName === "vaultsPage") {
        const [offset, limit] = decoded.args as [bigint, bigint];
        return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", result: this.list.slice(Number(offset), Number(offset + limit)) }));
      }
      return fail;
    }
    if (to === WETH) {
      const { args } = decodeFunctionData({ abi: erc20, data });
      const who = String(args![0]).toLowerCase() as Address;
      const balance = this.vaults.get(who)?.balance ?? (who === KEEPER ? this.keeperWeth : (this.weth.get(who) ?? 0n));
      return ok(encodeFunctionResult({ abi: erc20, functionName: "balanceOf", result: balance }));
    }
    if (to === PAIR) return ok(encodeFunctionResult({ abi: pairAbi, functionName: "getReserves", result: [2_329n * ETHER, 10n ** 27n, 0] }));
    return fail;
  }

  /** The batcher, run at `time`: what each vault does, and what the batch earns. */
  runBatch(data: Hex, time: bigint, real: boolean) {
    const [vaults, rewardTo, minRewards] = decodeFunctionData({ abi: BATCHER_ABI, data }).args as [Address[], Address, bigint];
    const reasons = vaults.map((vault) => this.outcome(vault.toLowerCase() as Address, time, real));
    const earned = vaults.reduce((sum, vault, i) => sum + (reasons[i] === REASON.BOUGHT ? this.vaults.get(vault.toLowerCase() as Address)!.terms.keeperReward : 0n), 0n);
    const bought = reasons.filter((r) => r === REASON.BOUGHT).length;
    return { vaults: vaults.map((v) => v.toLowerCase() as Address), rewardTo: rewardTo.toLowerCase() as Address, minRewards, reasons, earned, bought };
  }

  readonly rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    this.methods.push(method);
    const hex = (v: bigint | number) => `0x${v.toString(16)}`;
    switch (method) {
      case "eth_chainId":
        return "0x1";
      case "eth_blockNumber":
        return hex(this.block);
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        const number = tag === "latest" ? this.block : BigInt(tag);
        return { number: hex(number), timestamp: hex(this.blockTimes.get(number) ?? this.time), baseFeePerGas: hex(this.baseFee), gasUsed: hex(15_000_000n), gasLimit: hex(30_000_000n) };
      }
      case "eth_getTransactionCount":
        return hex(this.nonce);
      case "eth_getBalance":
        return hex(this.keeperBalance);
      case "eth_getCode":
        return this.codeless.has((params[0] as string).toLowerCase() as Address) ? "0x" : "0x60";
      case "eth_estimateGas":
        return hex(800_000n);
      case "eth_call": {
        const call = params[0] as { to: Address; data: Hex };
        const to = call.to.toLowerCase() as Address;
        if (to === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: multicallAbi, data: call.data });
          return encodeFunctionResult({
            abi: multicallAbi,
            functionName: "aggregate3",
            result: args[0].map((c) => this.answer(c.target.toLowerCase() as Address, c.callData)),
          });
        }
        if (to === BATCHER) {
          this.calls.push("executeBatch");
          if (this.failNextSimulation) {
            this.failNextSimulation = false;
            throw new Error(`eth_call: upstream ${UPSTREAM} did not answer`);
          }
          const run = this.runBatch(call.data, this.time, false);
          const revert = (data: Hex) => Object.assign(new Error("execution reverted"), { data });
          if (run.bought === 0) throw revert(encodeErrorResult({ abi: BATCHER_ABI, errorName: "NothingBought", args: [run.reasons] }));
          if (run.earned < run.minRewards) throw revert(encodeErrorResult({ abi: BATCHER_ABI, errorName: "TooLittle", args: [run.earned, run.minRewards, run.reasons] }));
          return encodeFunctionResult({ abi: BATCHER_ABI, functionName: "executeBatch", result: [BigInt(run.bought), run.earned, run.reasons] });
        }
        const answer = this.answer(to, call.data);
        if (!answer.success) throw Object.assign(new Error("execution reverted"), { data: "0x" });
        return answer.returnData;
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        const hash = keccak256(raw);
        if (this.receipts.has(hash)) throw new Error("already known");
        if (tx.nonce! < this.nonce) throw new Error("nonce too low");
        this.sentRaw.push(raw);
        this.mempool.set(tx.nonce!, raw);
        if (this.autoMine) this.mine();
        return hash;
      }
      case "eth_getTransactionReceipt":
        return this.receipts.get(params[0] as Hex) ?? null;
      default:
        throw new Error(`unscripted ${method}`);
    }
  };

  /** Mine the transaction waiting at the keeper's next nonce, if any, in a new block. */
  mine(): Hex | null {
    const raw = this.mempool.get(this.nonce);
    if (!raw) return null;
    this.mempool.clear();
    this.advance(12n);
    const tx = parseTransaction(raw);
    const hash = keccak256(raw);
    const to = tx.to!.toLowerCase() as Address;
    const price = tx.type === "legacy" ? tx.gasPrice! : this.baseFee + (tx.maxPriorityFeePerGas! < tx.maxFeePerGas! - this.baseFee ? tx.maxPriorityFeePerGas! : tx.maxFeePerGas! - this.baseFee);
    let status = 1n;
    let gasUsed = 21_000n;
    const logs: ReturnType<typeof eventLog>[] = [];
    if (to === BATCHER) {
      const run = this.runBatch(tx.data!, this.time, true);
      gasUsed = 160_000n;
      if (run.bought === 0 || run.earned < run.minRewards) {
        status = 0n;
      } else {
        run.vaults.forEach((vault, i) => {
          const reason = run.reasons[i]!;
          const v = this.vaults.get(vault);
          if (reason === REASON.BOUGHT && v) {
            v.buysDone += 1n;
            v.lastBuyAt = this.time;
            v.balance -= v.terms.amountPerBuy + v.terms.keeperReward;
            const slot = (this.time - v.terms.startAt) / v.terms.interval;
            logs.push(eventLog(VAULT_ABI, "Bought", { slot, amountIn: v.terms.amountPerBuy, amountOut: 1_000n, keeper: BATCHER, reward: v.terms.keeperReward, floorOut: 970n, buyNumber: v.buysDone, oracleDepth: 60n * ETHER }, vault));
            logs.push(eventLog(BATCHER_ABI, "Triggered", { vault, received: 1_000n, gasUsed: 100_000n }, BATCHER));
            gasUsed += 100_000n;
          } else {
            const used = v?.onChain?.gasUsed ?? 20_000n;
            logs.push(eventLog(BATCHER_ABI, "NotTriggered", { vault, reason, gasUsed: used }, BATCHER));
            gasUsed += used;
          }
        });
        logs.push(eventLog(BATCHER_ABI, "Batch", { caller: KEEPER, rewardTo: run.rewardTo, listed: BigInt(run.vaults.length), tried: BigInt(run.vaults.length), bought: BigInt(run.bought), earned: run.earned, swept: 0n }, BATCHER));
        this.weth.set(run.rewardTo, (this.weth.get(run.rewardTo) ?? 0n) + run.earned);
      }
    } else if (to === DETERMINISTIC_DEPLOYER) {
      gasUsed = 700_000n;
      this.codeless.delete(BATCHER);
    } else if (to === WETH) {
      gasUsed = 35_000n;
      this.keeperBalance += this.keeperWeth;
      this.keeperWeth = 0n;
    }
    this.nonce += 1;
    this.receipts.set(hash, {
      transactionHash: hash,
      status: `0x${status.toString(16)}`,
      blockNumber: `0x${this.block.toString(16)}`,
      gasUsed: `0x${gasUsed.toString(16)}`,
      effectiveGasPrice: `0x${price.toString(16)}`,
      logs: logs.map((log, i) => ({ ...log, logIndex: `0x${i.toString(16)}` })),
    });
    return hash;
  }
}

// ─── Ticks ────────────────────────────────────────────────────────────────────

/** Every record every tick in this file wrote: the log's property test runs over all of them. */
const ALL_RECORDS: KeeperLogRecord[] = [];

/** Vault addresses in a range of their own, clear of the factory, batcher, owner and rewardTo. */
const vaultAt = (n: number): Address => `0xa${n.toString(16).padStart(39, "0")}`;

function setup(options: { policy?: Partial<KeeperPolicy>; vaults?: Address[] | null; rewardTo?: Address; privateSend?: boolean; dryRun?: boolean } = {}) {
  const chain = new FakeChain();
  const records: KeeperLogRecord[] = [];
  const policy: Partial<KeeperPolicy> = { sendWhen: "now", confirmations: 1, maxHeadLagSeconds: 0n, ...options.policy };
  const config = (extra: Partial<KeeperPolicy> = {}) =>
    keeperConfig({
      chainId: 1,
      deployments: [V1],
      weth: WETH,
      ...(options.dryRun ? {} : { keeperKey: KEY }),
      rewardTo: options.rewardTo ?? COLD,
      ...(options.vaults ? { vaults: options.vaults } : {}),
      privateSend: options.privateSend ?? false,
      policy: { ...policy, ...extra },
    });
  const state = newKeeperState({ chainId: 1, keeper: options.dryRun ? null : KEEPER, deployments: [V1] });
  const persisted: string[] = [];
  const tick = (extra: { waitForReceiptMs?: number; wallClockMs?: () => number; policy?: Partial<KeeperPolicy>; state?: KeeperState } = {}) =>
    keeperTick(chain.rpc, {
      config: config(extra.policy),
      state: extra.state ?? state,
      log: (record) => {
        records.push(record);
        ALL_RECORDS.push(record);
      },
      persist: async (s) => {
        persisted.push(serializeKeeperState(s));
      },
      sleep: async () => {},
      waitForReceiptMs: extra.waitForReceiptMs ?? 0,
      wallClockMs: extra.wallClockMs ?? (() => Number(chain.time) * 1000),
    });
  const ofType = <T extends KeeperLogRecord["type"]>(type: T) => records.filter((r): r is Extract<KeeperLogRecord, { type: T }> => r.type === type);
  return { chain, state, records, persisted, tick, ofType };
}

describe("discovery", () => {
  it("reads the factory's own list, bounded per tick, saying syncing until it has caught up", async () => {
    const { chain, state, tick, ofType } = setup({ policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    for (let i = 1; i <= 700; i++) chain.addVault(vaultAt(i), { terms: { startAt: T0 + 30n * DAY } });
    const first = await tick();
    expect(first.phase).toBe("syncing");
    expect(state.deployments["v1"]).toMatchObject({ scannedCount: 500n, vaultCount: 700n });
    expect(Object.keys(state.vaults)).toHaveLength(500);
    // The factory's list says who is vouched for: nobody asked isVault.
    expect(chain.calls).not.toContain("isVault");
    expect(ofType("sync").at(-1)).toMatchObject({ deployment: "v1", scannedCount: 500n, vaultCount: 700n });
    // This test's factory is not this build's, so its market list is not known here: the index is left unknown.
    expect(ofType("vault_found")[0]).toMatchObject({ vault: vaultAt(1), deployment: "v1", index: 0n, owner: OWNER, marketIndex: null });

    const second = await tick();
    expect(second.phase).toBe("running");
    expect(state.deployments["v1"]!.scannedCount).toBe(700n);
    expect(ofType("vault_found")).toHaveLength(700);

    // Nothing new, and not due for another look: no list reads at all.
    chain.calls.length = 0;
    await tick();
    expect(chain.calls).not.toContain("vaultCount");
    // A new vault is found once the discovery interval has passed.
    chain.addVault(vaultAt(701), { terms: { startAt: T0 + 30n * DAY } });
    chain.advance(300n);
    await tick();
    expect(state.vaults[vaultAt(701)]).toMatchObject({ index: 700n });
  });

  it("never distrusts a listed vault, even when an endpoint's isVault says otherwise", async () => {
    const { chain, state, tick } = setup();
    chain.addVault(vaultAt(1));
    const result = await tick({ waitForReceiptMs: 1 });
    expect(state.vaults[vaultAt(1)]).toBeDefined();
    expect(result.sent.map((s) => s.vaults)).toEqual([[vaultAt(1)]]);
  });

  it("rechecks an allowlisted address no factory vouches for every hour, and never drops it", async () => {
    const stranger = vaultAt(9);
    const { chain, state, tick, ofType } = setup({ vaults: [stranger] });
    chain.addVault(stranger, { listed: false });
    const first = await tick();
    expect(first.skipped).toEqual([{ vault: stranger, code: "not-vouched", detail: "no listed factory vouches for it" }]);
    expect(state.notVouched[stranger]).toEqual({ since: T0, recheckAt: T0 + HOUR });
    expect(ofType("skip")).toHaveLength(1);

    chain.calls.length = 0;
    chain.advance(60n);
    await tick();
    expect(chain.calls).not.toContain("isVault");

    // An hour on, the factory vouches for it after all (an endpoint was wrong): it is found.
    chain.vaults.get(stranger)!.listed = true;
    chain.advance(HOUR);
    await tick({ waitForReceiptMs: 1 });
    expect(state.notVouched[stranger]).toBeUndefined();
    expect(state.vaults[stranger]).toMatchObject({ deployment: "v1", index: null });
    expect(ofType("skip")).toHaveLength(1);
  });
});

describe("reads", () => {
  it("reads every vault without prices for accounting, and prices only what is about to be sent", async () => {
    const { chain, tick } = setup({ policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    chain.addVault(vaultAt(1));
    chain.addVault(vaultAt(2), { terms: { startAt: T0 + DAY } });
    await tick();
    // Due by the clock but never cheap: the first tick's accounting read, and no quote.
    expect(chain.calls.filter((c) => c === "buysDone")).toHaveLength(2);
    expect(chain.calls).not.toContain("quote");

    chain.calls.length = 0;
    chain.advance(60n);
    await tick();
    expect(chain.calls).toEqual([]);

    // Cheap now: the due vault is read with its price, the other not at all.
    chain.calls.length = 0;
    chain.baseFee = 0n;
    await tick({ waitForReceiptMs: 1 });
    expect(chain.calls.filter((c) => c === "quote")).toHaveLength(1);
    expect(chain.calls.filter((c) => c === "buysDone")).toHaveLength(1);
  });

  it("reads a vault that cannot pay only for its WETH between hourly full reads, and still notices a top-up", async () => {
    const { chain, state, tick } = setup();
    chain.addVault(vaultAt(1), { balance: 0n });
    await tick();
    expect(state.vaults[vaultAt(1)]).toMatchObject({ balance: 0n });
    const fullReads = () => chain.calls.filter((c) => c === "buysDone").length;
    const before = fullReads();
    chain.advance(300n);
    await tick();
    expect(fullReads()).toBe(before);
    // Topped up: the next pass sees it, and it is read in full and bought.
    chain.vaults.get(vaultAt(1))!.balance = ETHER;
    chain.advance(300n);
    const result = await tick();
    expect(result.sent.map((s) => s.vaults)).toEqual([[vaultAt(1)]]);
    expect(fullReads()).toBeGreaterThan(before);
  });

  it("says overtaken when another buy lands, and retires closed and finished vaults", async () => {
    const { chain, state, tick, ofType } = setup({ policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    chain.addVault(vaultAt(1));
    chain.addVault(vaultAt(2));
    chain.addVault(vaultAt(3), { terms: { maxBuys: 1n } });
    await tick();
    const v1 = chain.vaults.get(vaultAt(1))!;
    v1.buysDone = 1n;
    v1.lastBuyAt = chain.time;
    chain.vaults.get(vaultAt(2))!.closed = true;
    const v3 = chain.vaults.get(vaultAt(3))!;
    v3.buysDone = 1n;
    v3.lastBuyAt = chain.time;
    chain.advance(300n);
    await tick();
    // Vault 3's only buy was someone else's too: overtaken, and then done.
    expect(ofType("overtaken").map((r) => [r.vault, r.slot])).toEqual([
      [vaultAt(1), 0n],
      [vaultAt(3), 0n],
    ]);
    expect(ofType("vault_retired").map((r) => [r.vault, r.reason])).toEqual([
      [vaultAt(2), "closed"],
      [vaultAt(3), "done"],
    ]);
    expect(state.retired).toEqual([vaultAt(2), vaultAt(3)]);
    expect(Object.keys(state.vaults)).toEqual([vaultAt(1)]);
  });

  it("skips what cannot buy — unfunded, thin oracle, price outside the floor, no fee — once each", async () => {
    const { chain, tick, ofType } = setup();
    chain.addVault(vaultAt(1), { balance: 1n });
    chain.addVault(vaultAt(2), { quote: { spotOut: 1_000n, floorOut: 970n, oracleDepth: ETHER } });
    chain.addVault(vaultAt(3), { quote: { spotOut: 900n, floorOut: 970n, oracleDepth: 60n * ETHER } });
    chain.addVault(vaultAt(4), { terms: { keeperReward: 0n } });
    chain.addVault(vaultAt(5), { quote: null });
    const result = await tick();
    expect(result.sent).toEqual([]);
    expect(new Map(result.skipped.map((s) => [s.vault, s.code]))).toEqual(
      new Map([
        [vaultAt(1), "unfunded"],
        [vaultAt(2), "oracle-thin"],
        [vaultAt(3), "below-floor"],
        [vaultAt(4), "zero-reward"],
        [vaultAt(5), "oracle-unavailable"],
      ]),
    );
    expect(ofType("skip").find((s) => s.vault === vaultAt(3))).toMatchObject({ spotOut: 900n, floorOut: 970n, depth: 60n * ETHER });
    // The same reasons next tick: nothing new logged.
    const skips = ofType("skip").length;
    chain.advance(12n);
    await tick();
    expect(ofType("skip")).toHaveLength(skips);
    // The price comes back inside the floor: the skip clears, with how long it lasted, and the vault buys.
    chain.vaults.get(vaultAt(3))!.quote = { spotOut: 1_000n, floorOut: 970n, oracleDepth: 60n * ETHER };
    chain.advance(48n);
    await tick({ waitForReceiptMs: 1 });
    expect(ofType("skip_cleared")).toEqual([expect.objectContaining({ vault: vaultAt(3), code: "below-floor", seconds: 60n })]);
  });
});

describe("a batch", () => {
  it("buys every due vault in one transaction, small buys first, and pays rewardTo", async () => {
    const { chain, state, tick, ofType } = setup();
    chain.addVault(vaultAt(2), { terms: { amountPerBuy: ETHER / 50n, keeperReward: 156_000_000_000_000n } });
    chain.addVault(vaultAt(1));
    const result = await tick({ waitForReceiptMs: 5_000 });
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]!.vaults).toEqual([vaultAt(1), vaultAt(2)]);
    expect(result.mined[0]).toMatchObject({ status: "success", earnedWei: 87_300_000_000_000n + 156_000_000_000_000n, notTried: [] });
    expect(chain.weth.get(COLD)).toBe(87_300_000_000_000n + 156_000_000_000_000n);
    expect(state.vaults[vaultAt(1)]).toMatchObject({ buysDone: 1n, lastBuyAt: chain.time });
    expect(state.lastBatch?.hash).toBe(result.sent[0]!.hash);
    // The keeper's own gas limit, never an estimate.
    const tx = parseTransaction(chain.sentRaw[0]!);
    const sent = ofType("batch_sent")[0]!;
    expect(tx.gas).toBe(sent.gasLimit);
    expect(sent.gasLimit).toBe(60_000n + 2n * 178_000n + 460_000n);
    expect(chain.methods).not.toContain("eth_estimateGas");
    // The calibration moved: 360,000 used against a model of 474,000 keeps it at 1.
    expect(state.gasModel).toEqual({ ratioPpm: 1_000_000n, samples: 1 });
    expect(result.nextTickSeconds).toBeGreaterThanOrEqual(12);
  });

  it("sends one chunk a tick when the due vaults don't fit one transaction", async () => {
    const { chain, tick } = setup({ policy: { maxVaultsPerBatch: 2 } });
    for (let i = 1; i <= 3; i++) chain.addVault(vaultAt(i));
    const first = await tick({ waitForReceiptMs: 1 });
    expect(first.sent[0]!.vaults).toHaveLength(2);
    const second = await tick({ waitForReceiptMs: 1 });
    expect(second.sent[0]!.vaults).toHaveLength(1);
    expect(new Set([...first.sent[0]!.vaults, ...second.sent[0]!.vaults])).toEqual(new Set([vaultAt(1), vaultAt(2), vaultAt(3)]));
  });

  it("waits for a cheap block, sends at the deadline anyway, and a standby keeper only then", async () => {
    const { chain, tick } = setup({ policy: { sendWhen: "cheap", cheapBaseFee: 50_000_000n } });
    chain.addVault(vaultAt(1));
    expect((await tick()).waiting).toEqual({ reason: "not-cheap", candidates: 1 });
    // Two hours before the window closes, it goes whatever the fee.
    chain.advance(DAY - 7_200n);
    const late = await tick({ waitForReceiptMs: 1 });
    expect(late.sent).toHaveLength(1);
    expect(late.sent[0]!.urgent).toBe(true);
    // An urgent send bids the urgent tip.
    expect(parseTransaction(chain.sentRaw[0]!).maxPriorityFeePerGas).toBe(100_000_000n);

    const standby = setup({ policy: { sendWhen: "deadline" } });
    standby.chain.addVault(vaultAt(1));
    expect((await standby.tick()).sent).toEqual([]);
    standby.chain.advance(DAY - 7_200n);
    expect((await standby.tick({ waitForReceiptMs: 1 })).sent).toHaveLength(1);
  });

  it("refuses to bid above the fee cap", async () => {
    const { chain, tick } = setup();
    chain.addVault(vaultAt(1));
    chain.baseFee = 3_000_000_000n;
    expect((await tick()).waiting).toEqual({ reason: "fees-above-max", candidates: 1 });
    expect(chain.sentRaw).toEqual([]);
  });

  it("does not send what the key cannot pay for at its highest price", async () => {
    const { chain, tick, ofType } = setup();
    chain.addVault(vaultAt(1));
    chain.keeperBalance = 1_000n;
    expect((await tick()).waiting).toEqual({ reason: "low-balance", candidates: 1 });
    expect(ofType("low_balance")).toHaveLength(1);
    expect(chain.sentRaw).toEqual([]);
  });

  it("a dry run decides, reads and simulates, and never signs", async () => {
    const { chain, tick } = setup({ dryRun: true });
    chain.addVault(vaultAt(1));
    const result = await tick();
    expect(result.waiting).toEqual({ reason: "dry-run", candidates: 1 });
    expect(chain.calls).toContain("executeBatch");
    expect(chain.methods).not.toContain("eth_sendRawTransaction");
    expect(chain.methods).not.toContain("eth_getTransactionCount");
  });
});

describe("simulation", () => {
  it("maps each refusal to its consequence and sends the rest", async () => {
    const { chain, state, tick } = setup({ vaults: [vaultAt(1), vaultAt(2), vaultAt(3), vaultAt(4), vaultAt(5), vaultAt(6)] });
    chain.addVault(vaultAt(1), { simulated: REASON.TooSoon });
    chain.addVault(vaultAt(2), { simulated: REASON.PriceBelowFloor });
    chain.addVault(vaultAt(3), { simulated: REASON.InsufficientBalance });
    chain.addVault(vaultAt(4), { simulated: REASON.EmptyRevert });
    chain.addVault(vaultAt(5), { simulated: REASON.NotFromFactory });
    chain.addVault(vaultAt(6));
    const result = await tick({ waitForReceiptMs: 1 });
    expect(result.sent.map((s) => s.vaults)).toEqual([[vaultAt(6)]]);
    expect(new Map(result.skipped.filter((s) => s.code === "sim-refused").map((s) => [s.vault, s.detail]))).toEqual(
      new Map([
        [vaultAt(1), "TooSoon"],
        [vaultAt(2), "PriceBelowFloor"],
        [vaultAt(3), "InsufficientBalance"],
        [vaultAt(4), "EmptyRevert"],
        [vaultAt(5), "NotFromFactory"],
      ]),
    );
    // Someone else bought it: read it again. The price: this tick only. Unfunded: an hour. EmptyRevert: the window.
    expect(state.vaults[vaultAt(1)]!.readAt).toBeNull();
    expect(state.vaults[vaultAt(2)]).toMatchObject({ restingUntil: null, recheckAt: null });
    expect(state.vaults[vaultAt(3)]!.recheckAt).toBe(T0 + HOUR);
    expect(state.vaults[vaultAt(4)]!.restingUntil).toBe(T0 + DAY);
    // An allowlisted vault the batcher's factory does not vouch for: rechecked hourly.
    expect(state.vaults[vaultAt(5)]).toBeUndefined();
    expect(state.notVouched[vaultAt(5)]).toEqual({ since: T0, recheckAt: T0 + HOUR });
    // A simulation never traps.
    expect(state.trapped).toEqual({});
  });

  it("simulates at most twice, and sends nothing when nothing survives", async () => {
    const { chain, tick } = setup();
    chain.addVault(vaultAt(1), { simulated: REASON.TooSoon });
    const result = await tick();
    expect(result.sent).toEqual([]);
    expect(chain.calls.filter((c) => c === "executeBatch")).toHaveLength(1);
  });

  it("takes an answer without revert data as unknown, never a refusal", async () => {
    const { chain, state, tick, ofType } = setup();
    chain.addVault(vaultAt(1));
    chain.failNextSimulation = true;
    const result = await tick();
    expect(result.sent).toEqual([]);
    expect(ofType("error").at(-1)).toMatchObject({ where: "simulate" });
    expect(state.vaults[vaultAt(1)]).toMatchObject({ restingUntil: null, recheckAt: null });
    expect(state.trapped).toEqual({});
    expect((await tick({ waitForReceiptMs: 1 })).sent).toHaveLength(1);
  });
});

describe("refusals on chain", () => {
  it("rests a paid refusal, then for the rest of the window after the second", async () => {
    const { chain, state, tick } = setup();
    chain.addVault(vaultAt(1), { onChain: { reason: REASON.PriceBelowFloor, gasUsed: 60_000n } });
    chain.addVault(vaultAt(2));
    await tick({ waitForReceiptMs: 1 });
    const v = state.vaults[vaultAt(1)]!;
    expect(v.paidRefusals).toEqual({ slot: 0n, count: 1 });
    expect(v.restingUntil).toBe(T0 + 600n);

    chain.advance(600n);
    chain.addVault(vaultAt(3));
    await tick({ waitForReceiptMs: 1 });
    expect(state.vaults[vaultAt(1)]).toMatchObject({ paidRefusals: { slot: 0n, count: 2 }, restingUntil: T0 + DAY });
  });

  it("traps a vault that burned its gas with no reason, for a week of chain time, on the chain's evidence only", async () => {
    const { chain, state, tick, ofType } = setup();
    chain.addVault(vaultAt(1), { onChain: { reason: REASON.EmptyRevert, gasUsed: 400_000n } });
    chain.addVault(vaultAt(2));
    const first = await tick({ waitForReceiptMs: 1 });
    expect(state.trapped[vaultAt(1)]).toMatchObject({ txHash: first.sent[0]!.hash, batcher: BATCHER, cap: 400_000n, slot: 0n });
    expect(ofType("trapped")).toEqual([expect.objectContaining({ vault: vaultAt(1), gasUsed: 400_000n })]);

    // A day later it is due again, and still trapped.
    chain.advance(DAY);
    const later = await tick({ waitForReceiptMs: 1 });
    expect(later.skipped).toContainEqual({ vault: vaultAt(1), code: "trapped", detail: expect.any(String) });
    // A week on, the trap expires and the vault is tried again.
    chain.advance(7n * DAY);
    delete chain.vaults.get(vaultAt(1))!.onChain;
    const week = await tick({ waitForReceiptMs: 1 });
    expect(ofType("untrapped")).toEqual([expect.objectContaining({ vault: vaultAt(1), why: "expired" })]);
    expect(week.mined.flatMap((m) => m.bought.map((b) => b.vault))).toContain(vaultAt(1));
  });

  it("holds nothing against a vault another buy got to first", async () => {
    const { chain, state, tick, ofType } = setup();
    chain.addVault(vaultAt(1), { onChain: { reason: REASON.TooSoon, gasUsed: 25_000n } });
    chain.addVault(vaultAt(2));
    await tick({ waitForReceiptMs: 1 });
    expect(ofType("overtaken").map((r) => r.vault)).toEqual([vaultAt(1)]);
    expect(state.vaults[vaultAt(1)]).toMatchObject({ readAt: null, restingUntil: null });
    expect(state.trapped).toEqual({});
  });
});

describe("windows", () => {
  it("says a window was missed, and why: unfunded, the keeper down, or skipped", async () => {
    const { chain, tick, ofType } = setup({ policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    chain.addVault(vaultAt(1), { balance: 1n });
    chain.addVault(vaultAt(2));
    // Its first window opens after the keeper stops, and closes before it comes back.
    chain.addVault(vaultAt(3), { terms: { startAt: T0 + DAY + HOUR } });
    await tick();
    // The keeper runs through vault 2's first window, never finding a cheap block.
    for (let i = 0; i < 4; i++) {
      chain.advance(DAY / 4n);
      await tick();
    }
    const missed = new Map(ofType("window_missed").map((r) => [r.vault, r.class]));
    expect(missed.get(vaultAt(1))).toBe("unfunded");
    expect(missed.get(vaultAt(2))).toBe("unknown");
    expect(missed.get(vaultAt(3))).toBeUndefined();

    // Nothing runs for two days: vault 3's first window passes with the keeper down.
    chain.advance(2n * DAY);
    await tick();
    const late = ofType("window_missed").filter((r) => r.vault === vaultAt(3));
    expect(late.map((r) => r.class)).toEqual(["keeper-down"]);
  });

  it("classes a window as skipped, with the last reason, when the keeper skipped it", async () => {
    const { chain, tick, ofType } = setup();
    chain.addVault(vaultAt(1), { quote: { spotOut: 900n, floorOut: 970n, oracleDepth: 60n * ETHER } });
    await tick();
    for (let i = 0; i < 4; i++) {
      chain.advance(DAY / 4n);
      await tick();
    }
    expect(ofType("window_missed")[0]).toMatchObject({ vault: vaultAt(1), slot: 0n, class: "keeper-skipped", lastSkip: "below-floor" });
  });
});

describe("the head", () => {
  it("does nothing on a stale head, and says so", async () => {
    const { chain, tick } = setup({ policy: { maxHeadLagSeconds: 120n } });
    chain.addVault(vaultAt(1));
    const result = await tick({ wallClockMs: () => Number(chain.time + 121n) * 1000 });
    expect(result.waiting).toEqual({ reason: "stale-head", candidates: 0 });
    expect(result.health).toMatchObject({ ok: false, headLagSeconds: 121n });
    expect(result.health.attention).toContain("stale_head");
    expect(chain.calls).toEqual([]);
  });

  it("does nothing on a head behind one already seen", async () => {
    const { chain, state, tick } = setup();
    await tick();
    state.maxHeadSeen = chain.block + 5n;
    chain.addVault(vaultAt(1));
    expect((await tick()).waiting?.reason).toBe("stale-head");
    expect(chain.sentRaw).toEqual([]);
  });
});

describe("health", () => {
  it("reports what a restart would not fix", async () => {
    const { chain, state, tick } = setup({ rewardTo: KEEPER });
    chain.addVault(vaultAt(1));
    chain.keeperBalance = ETHER / 1_000n;
    chain.keeperWeth = 5n * ETHER / 1_000n;
    const result = await tick({ waitForReceiptMs: 1 });
    expect(result.health.attention).toEqual(expect.arrayContaining(["low_balance", "public_mempool"]));
    expect(result.health).toMatchObject({ ok: true, active: 1, due: 1, lastBatchHash: result.sent[0]!.hash, balanceWei: ETHER / 1_000n });
    expect(result.health.runwayDays).not.toBeNull();
    // Rewards come to the keeper and its ether is low: its WETH is unwrapped, through the nonce manager.
    expect(state.pending?.purpose).toBe("unwrap");
  });
});

// ─── The nonce manager, across ticks ──────────────────────────────────────────

describe("the transaction in flight", () => {
  let base: ReturnType<typeof setup>;

  beforeEach(() => {
    base = setup({ policy: { sendWhen: "now" } });
  });

  it("keeps one transaction in flight: a pending batch blocks another batch and an unwrap", async () => {
    const { chain, state, tick } = setup({ rewardTo: KEEPER });
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    chain.keeperBalance = ETHER / 1_000n;
    chain.keeperWeth = ETHER / 100n;
    await tick();
    expect(state.pending?.purpose).toBe("batch");
    chain.addVault(vaultAt(2));
    const next = await tick();
    expect(next.sent).toEqual([]);
    expect(next.waiting?.reason).toBe("pending-tx");
    expect(chain.mempool.size).toBe(1);
    expect(state.pending?.purpose).toBe("batch");
  });

  it("confirms by head − block + 1, and one confirmation needs no further block", async () => {
    const { chain, state, tick } = base;
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    await tick();
    chain.mine();
    const settled = await tick();
    expect(settled.mined).toHaveLength(1);
    expect(state.pending).toBeNull();
    expect(state.nextNonce).toBe(1);

    const two = setup({ policy: { confirmations: 2 } });
    two.chain.autoMine = false;
    two.chain.addVault(vaultAt(1));
    await two.tick();
    two.chain.mine();
    expect((await two.tick()).mined).toEqual([]);
    expect(two.state.pending?.receiptBlock).toBe(two.chain.block);
    two.chain.advance(12n);
    expect((await two.tick()).mined).toHaveLength(1);
  });

  it("puts a transaction back in flight when its receipt vanishes twice before its confirmations", async () => {
    const { chain, state, tick } = setup({ policy: { confirmations: 3 } });
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    await tick();
    const hash = chain.mine()!;
    await tick();
    expect(state.pending?.receiptBlock).toBe(chain.block);
    const receipt = chain.receipts.get(hash);
    chain.receipts.delete(hash);
    await tick();
    expect(state.pending?.receiptBlock).toBe(chain.block);
    await tick();
    expect(state.pending).toMatchObject({ receiptBlock: null, missedReceiptChecks: 0 });
    chain.receipts.set(hash, receipt);
  });

  it("rebuilds and replaces a batch not mined, with fees up at least 10%, at the resend interval", async () => {
    const { chain, state, tick, ofType } = base;
    chain.autoMine = false;
    chain.addVault(vaultAt(1), { terms: { interval: 300n } });
    await tick();
    const first = parseTransaction(chain.sentRaw[0]!);
    // A five-minute plan: after 2 blocks its window has 23 blocks left, so it waits 7; after 8, it has 17 left and waits 5.
    chain.advance(24n, 2n);
    await tick();
    expect(ofType("batch_replaced")).toHaveLength(0);
    chain.advance(72n, 6n);
    await tick();
    expect(ofType("batch_replaced")).toHaveLength(1);
    const second = parseTransaction(chain.sentRaw.at(-1)!);
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxPriorityFeePerGas! * 100n >= first.maxPriorityFeePerGas! * 110n).toBe(true);
    expect(second.maxFeePerGas! * 100n >= first.maxFeePerGas! * 110n).toBe(true);
    expect(state.pending?.attempts).toHaveLength(2);
    // Either attempt's receipt settles it.
    chain.mine();
    expect((await tick()).mined[0]?.hash).toBe(keccak256(chain.sentRaw.at(-1)!));
    expect(chain.methods).not.toContain("eth_estimateGas");
  });

  it("processes an earlier attempt that is mined with what it carried, not with what the rebuild carried", async () => {
    const { chain, tick, ofType } = base;
    chain.autoMine = false;
    chain.addVault(vaultAt(1), { terms: { interval: 300n } });
    chain.addVault(vaultAt(2), { terms: { interval: 300n, startAt: T0 + 60n } });
    await tick();
    const firstRaw = chain.sentRaw[0]!;
    // The second vault comes due, and the rebuild at the same nonce carries both.
    chain.advance(96n, 8n);
    await tick();
    expect(ofType("batch_replaced")).toHaveLength(1);
    expect(decodeFunctionData({ abi: BATCHER_ABI, data: parseTransaction(chain.sentRaw.at(-1)!).data! }).args![0]).toHaveLength(2);
    // But the first attempt is the one mined.
    chain.mempool.set(chain.nonce, firstRaw);
    chain.mine();
    const settled = await tick();
    expect(settled.mined).toHaveLength(1);
    expect(settled.mined[0]).toMatchObject({ hash: keccak256(firstRaw), notTried: [] });
    expect(settled.mined[0]!.bought.map((b) => b.vault)).toEqual([vaultAt(1)]);
    expect(ofType("error").filter((e) => /not tried/.test(e.message))).toEqual([]);
  });

  it("in the public pool, replaces a batch no longer worth sending with a cancel, and books its cost as a loss", async () => {
    const { chain, state, tick, ofType } = base;
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    await tick();
    // Another keeper buys it: the rebuild is empty.
    const v = chain.vaults.get(vaultAt(1))!;
    v.buysDone = 1n;
    v.lastBuyAt = chain.time;
    state.vaults[vaultAt(1)]!.readAt = null;
    chain.advance(120n, 10n);
    await tick();
    expect(ofType("batch_cancel_sent")).toHaveLength(1);
    const cancel = parseTransaction(chain.sentRaw.at(-1)!);
    expect(cancel).toMatchObject({ to: KEEPER, gas: 21_000n });
    expect(cancel.value ?? 0n).toBe(0n);
    chain.mine();
    await tick();
    const cancelled = ofType("batch_cancelled")[0]!;
    expect(cancelled.costWei > 0n).toBe(true);
    expect(state.lossLedger.at(-1)).toMatchObject({ lossWei: cancelled.costWei, vault: null, owner: null });
    expect(state.pending).toBeNull();
  });

  it("through a private relay, stops resending an empty rebuild and abandons it after it expires", async () => {
    const { chain, state, tick, ofType } = setup({ privateSend: true });
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    await tick();
    const nonce = state.pending!.nonce;
    chain.vaults.get(vaultAt(1))!.closed = true;
    state.vaults[vaultAt(1)]!.readAt = null;
    chain.advance(120n, 10n);
    await tick();
    expect(state.pending?.stoppedResending).toBe(true);
    expect(ofType("batch_cancel_sent")).toEqual([]);
    chain.advance(180n, 15n);
    await tick();
    expect(ofType("batch_abandoned")).toEqual([expect.objectContaining({ why: "expired", nonce })]);
    expect(state.pending).toBeNull();
    // The nonce is used again by the next batch, as its next use.
    expect(state.nextNonce).toBe(nonce);
    expect(state.orphans).toHaveLength(1);
  });

  it("waits confirmations + 5 blocks before abandoning a nonce something else used, then processes a late receipt", async () => {
    const { chain, state, tick, ofType } = base;
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    await tick();
    const raw = chain.sentRaw[0]!;
    const hash = keccak256(raw);
    // The nonce is used, and this endpoint cannot see our receipt.
    const receipt = (() => {
      chain.mine();
      const r = chain.receipts.get(hash);
      chain.receipts.delete(hash);
      return r;
    })();
    for (let i = 0; i < 5; i++) {
      await tick();
      expect(state.pending).not.toBeNull();
      chain.advance(12n);
    }
    await tick();
    expect(ofType("batch_abandoned")).toEqual([expect.objectContaining({ why: "nonce-consumed", hashes: [hash] })]);
    expect(state.orphans.map((o) => o.hash)).toEqual([hash]);
    // The receipt turns up: the orphan is processed, late.
    chain.receipts.set(hash, receipt);
    chain.advance(12n * 25n, 25n);
    await tick();
    expect(ofType("batch_mined").at(-1)).toMatchObject({ hash, late: true, status: "success" });
    expect(state.orphans).toEqual([]);
  });

  it("finishes after a restart what was persisted but never broadcast", async () => {
    const { chain, state, persisted, tick } = base;
    chain.autoMine = false;
    chain.addVault(vaultAt(1));
    await tick();
    const writeAhead = persisted.find((s) => (JSON.parse(s) as { pending: { attempts: unknown[] } | null }).pending?.attempts.length === 1)!;
    // The broadcast never happened: the pool is empty.
    chain.mempool.clear();
    chain.sentRaw.length = 0;
    const restored = parseKeeperState(writeAhead);
    await tick({ state: restored });
    expect(chain.sentRaw).toEqual([restored.pending!.attempts[0]!.raw]);
    chain.mine();
    const settled = await tick({ state: restored });
    expect(settled.mined.map((m) => m.hash)).toEqual([restored.pending?.attempts[0]?.hash ?? settled.mined[0]!.hash]);
    expect(restored.pending).toBeNull();
    expect(state.seq).toBeGreaterThan(0);
  });
});

describe("deployMissingBatchers", () => {
  it("deploys a listed release's missing batcher through the nonce manager, once, and only where its factory is", async () => {
    const chain = new FakeChain();
    chain.codeless.add(BATCHER);
    const elsewhere: Deployment = { id: "v0", factory: "0x00000000000000000000000000000000000000f0", batcher: "0x00000000000000000000000000000000000000b0", factoryBlock: 1n, batcherBlock: 2n };
    chain.codeless.add(elsewhere.factory);
    chain.codeless.add(elsewhere.batcher);
    const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [elsewhere, V1] });
    const records: KeeperLogRecord[] = [];
    const input = {
      config: keeperConfig({ chainId: 1, deployments: [elsewhere, V1], weth: WETH, keeperKey: KEY }),
      state,
      log: (r: KeeperLogRecord) => {
        records.push(r);
        ALL_RECORDS.push(r);
      },
      sleep: async () => {},
      waitForReceiptMs: 1,
    };
    const result = await deployMissingBatchers(chain.rpc, input);
    const hash = keccak256(chain.sentRaw[0]!);
    expect(result).toEqual({ deployed: [{ deployment: "v1", batcher: BATCHER, hash }], pending: false });
    const tx = parseTransaction(chain.sentRaw[0]!);
    // The one estimate the keeper ever uses, plus 20%.
    expect(tx).toMatchObject({ to: DETERMINISTIC_DEPLOYER, gas: 960_000n });
    expect(records.filter((r) => r.type === "batcher_deployed")).toEqual([expect.objectContaining({ deployment: "v1", hash, address: BATCHER })]);
    expect(state).toMatchObject({ pending: null, nextNonce: 1 });

    const again = await deployMissingBatchers(chain.rpc, input);
    expect(again.deployed).toEqual([]);
    expect(chain.sentRaw).toHaveLength(1);
  });

  it("follows a deployment the last run left in flight, so the next start is never stuck behind it", async () => {
    const chain = new FakeChain();
    chain.codeless.add(BATCHER);
    chain.autoMine = false;
    const state = newKeeperState({ chainId: 1, keeper: KEEPER, deployments: [V1] });
    const records: KeeperLogRecord[] = [];
    const input = {
      config: keeperConfig({ chainId: 1, deployments: [V1], weth: WETH, keeperKey: KEY, policy: { confirmations: 1 } }),
      state,
      log: (r: KeeperLogRecord) => records.push(r),
      sleep: async () => {},
      waitForReceiptMs: 1,
    };
    // Sent, not mined in time: it stays in flight, and a second deployment is refused rather than signed.
    expect(await deployMissingBatchers(chain.rpc, input)).toEqual({ deployed: [], pending: true });
    await expect(deployMissingBatchers(chain.rpc, input)).rejects.toThrow(/already in flight/);
    // The next start follows it: broadcast again while it waits, settled once mined.
    chain.mempool.clear();
    expect(await settleInFlight(chain.rpc, input)).toBe(true);
    expect(chain.mempool.size).toBe(1);
    chain.mine();
    expect(await settleInFlight(chain.rpc, input)).toBe(false);
    expect(state).toMatchObject({ pending: null, nextNonce: 1 });
    expect(chain.codeless.has(BATCHER)).toBe(false);
    expect(records.filter((r) => r.type === "batcher_deployed")).toHaveLength(1);
  });
});

// ─── The log, over everything this file produced ──────────────────────────────

afterAll(() => {
  // Run last, over every record every tick above wrote: typed fields valid, free text clean.
  const redact = makeRedactor({ key: KEY, urls: [UPSTREAM, "http://127.0.0.1:8545"] });
  expect(ALL_RECORDS.length).toBeGreaterThan(100);
  const types = new Set<string>();
  for (const record of ALL_RECORDS) {
    types.add(record.type);
    const { line, invalid } = toJsonLine(record, redact);
    expect(invalid, `${record.type}: ${line}`).toEqual([]);
    expect(line).not.toContain(UPSTREAM);
    expect(line).not.toContain("SECRETSECRETSECRETSECRET");
    expect(line.toLowerCase()).not.toContain(KEY.slice(2));
    if (record.type === "batch_mined") expect((JSON.parse(line) as { hash: string }).hash).toBe(record.hash);
  }
  for (const type of ["vault_found", "batch_sent", "batch_mined", "skip", "skip_cleared", "wait", "trapped", "untrapped", "window_missed", "batch_replaced", "batch_cancel_sent", "batch_cancelled", "batch_abandoned", "overtaken", "vault_retired", "error", "unwrap_sent", "batcher_deployed", "low_balance", "sync"]) {
    expect(types, type).toContain(type);
  }
});
