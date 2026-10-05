/**
 * The keeper's ticks against a scripted chain.
 *
 * `FakeChain` answers the calls a keeper makes — the head, Multicall3 reads of
 * vaults, both releases' factories' lists, the batchers' simulations, the SPX
 * holder registry and SPX balances, the finalized block and its proof — and
 * mines what it is sent: a batch buys each vault the way its release's vault
 * would (or refuses it the way a test says it will on chain), a v2 vault
 * inside its community window refusing a `rewardTo` the registry does not
 * find eligible; a proof records the holder as the registry would. The tests
 * drive ticks through it and look at what the keeper sent, logged and
 * remembered.
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
import { addressOfKey, type RpcBlockHeader } from "@spdex/chain";
import {
  BATCHER_ABI,
  DETERMINISTIC_DEPLOYER,
  FACTORY_ABI,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  REGISTRY_ABI,
  V1_BATCHER_ABI,
  V1_VAULT_ABI,
  VAULT_ABI,
  VAULT_LIMITS,
  v1BatcherAddress,
  type Deployment,
} from "./artifacts.js";
import { FEE_TIP_REFERENCE } from "./fee.js";
import { MIN_SPX, PROOF_TTL, bucketOf, encodeProve, predictVault, reasonName, turnOf, type VaultRelease, type VaultTerms } from "./index.js";
import {
  DEFAULT_KEEPER_POLICY,
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
import block25999900 from "../../chain/test/fixtures/block-25999900.json";
import holder25999900 from "../test/fixtures/proofs/holder-b0072e68-25999900.json";

const MARKETS = MAINNET_DEPLOYMENT.markets;
const FACTORY: Address = "0x00000000000000000000000000000000000000ff";
/** v1's batcher, bound to this test's v1 factory: where v1's code puts it. */
const BATCHER: Address = v1BatcherAddress(FACTORY);
const V1: Deployment = { id: "v1", source: "v1", factory: FACTORY, batcher: BATCHER, registry: null, markets: MARKETS, factoryBlock: null, batcherBlock: null, registryBlock: null };
const FACTORY_2: Address = "0x00000000000000000000000000000000000000fe";
/** The batcher bound to no factory that v2, and any later release like it, shares. */
const BATCHER_2: Address = MAINNET_BATCHER;
const REGISTRY: Address = "0x00000000000000000000000000000000000000ee";
const V2: Deployment = { id: "v2", source: "v2", factory: FACTORY_2, batcher: BATCHER_2, registry: REGISTRY, markets: MARKETS, factoryBlock: null, batcherBlock: null, registryBlock: null };
const SPX: Address = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const PAIR: Address = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";
const POOL: Address = "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3";
const WETH = MAINNET_DEPLOYMENT.weth;
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
const KEY: Hex = `0x${"11".repeat(32)}`;
const KEEPER = addressOfKey(KEY);
const COLD: Address = "0x00000000000000000000000000000000000000c0";
const OWNER: Address = "0x00000000000000000000000000000000000000d0";
/** A real SPX holder: its recorded proof at block 25,999,900 is what the fake chain serves as "finalized". */
const HOLDER = holder25999900.holder.toLowerCase() as Address;
/** Until when that proof makes it eligible: its block's time and 30 days. */
const PROVEN_UNTIL = BigInt(holder25999900.timestamp) + PROOF_TTL;
const PROVEN_BLOCK = BigInt(holder25999900.blockNumber);
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
  EmptyReturn: "0x81abc716",
  NotEligible: "0x5863fc24",
  NotYourTurn: "0x4027df4b",
} as const satisfies Record<string, Hex>;

// ─── The scripted chain ───────────────────────────────────────────────────────

interface FakeVault {
  owner: Address;
  /** Which release's factory made it, and so which batcher triggers it and how it answers. */
  release: VaultRelease;
  terms: VaultTerms;
  /** v2's count of buys inside their window paid to someone other than the owner. */
  windowBuys: bigint;
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
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function getBlockNumber() view returns (uint256)",
]);

/** `eth_getProof`'s answer for the recorded proof, as a node gives it; `value` overrides the balance it shows. */
function proofAnswer(value = BigInt(holder25999900.balance)) {
  return {
    address: SPX,
    accountProof: holder25999900.accountProof,
    balance: "0x0",
    codeHash: `0x${"ab".repeat(32)}`,
    nonce: "0x1",
    storageHash: keccak256(holder25999900.storageProof[0] as Hex),
    storageProof: [{ key: holder25999900.storageKey, value: `0x${value.toString(16)}`, proof: holder25999900.storageProof }],
  };
}

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
  /** Each release's factory's list. */
  readonly lists: Record<VaultRelease, Address[]> = { v1: [], v2: [] };
  /** Each release's factory's `nonces(owner)`: how many vaults it has made for each owner. */
  readonly nonces: Record<VaultRelease, Map<Address, bigint>> = { v1: new Map(), v2: new Map() };
  /** The registry's one record: until when each holder's proof is valid (0: never proved). */
  readonly validUntil = new Map<Address, bigint>();
  readonly spx = new Map<Address, bigint>();
  /** Addresses with no code at all: what the registry pays, and every key. */
  readonly accounts = new Set<Address>([KEEPER, COLD, OWNER, HOLDER]);
  /** What "finalized" answers; null for a chain with no finality to report. */
  finalized: RpcBlockHeader | null = block25999900 as unknown as RpcBlockHeader;
  /** What `eth_getProof` answers for the finalized block: the recorded proof, another balance in it, or a refusal. */
  proof: { value?: bigint } | "refused" = {};
  /** The registry refuses every proof sent to it, as a false one is. */
  proveReverts = false;
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
  /** The gas per vault each batch run gave (the shared batcher's fourth argument); null for v1's, which takes none. */
  readonly gasPerVault: (bigint | null)[] = [];

  /**
   * A vault, made as its release's factory makes one: given `vaultAt(n)`, it is
   * put where the factory puts `owner`'s next vault with these terms
   * (`predictVault`), counted in the factory's `nonces(owner)`, and `vaultAt(n)`
   * answers that address from then on. Given any other address, it is put
   * there as given: a contract a lying endpoint could list, which no factory
   * made, and which the keeper must never send.
   */
  addVault(vault: Address, overrides: Omit<Partial<FakeVault>, "terms"> & { terms?: Partial<VaultTerms> } = {}): Address {
    const { terms, ...rest } = overrides;
    const release = overrides.release ?? "v1";
    const v: FakeVault = {
      owner: OWNER,
      release,
      terms: {
        tokenOut: SPX,
        pair: PAIR,
        oraclePool: POOL,
        amountPerBuy: ETHER / 100n,
        interval: DAY,
        maxBuys: 3n,
        startAt: this.time,
        keeperReward: 87_300_000_000_000n,
        maxSlippageBps: 300n,
        communityWindow: release === "v2" ? 1_800n : null,
        turnBuckets: release === "v2" ? 0n : null,
        ...terms,
      },
      windowBuys: 0n,
      buysDone: 0n,
      lastBuyAt: 0n,
      closed: false,
      balance: 0n,
      quote: { spotOut: 1_000n, floorOut: 970n, oracleDepth: 60n * ETHER },
      listed: true,
      ...rest,
    };
    if (overrides.balance === undefined) v.balance = v.terms.maxBuys * (v.terms.amountPerBuy + v.terms.keeperReward);
    const n = placeholderIndex(vault);
    if (n !== null) {
      const factory = release === "v1" ? FACTORY : FACTORY_2;
      const nonce = this.nonces[release].get(v.owner) ?? 0n;
      this.nonces[release].set(v.owner, nonce + 1n);
      vault = predictVault({ factory, owner: v.owner, nonce, terms: v.terms });
      made.set(n, vault);
    }
    this.vaults.set(vault, v);
    if (v.listed) this.lists[release].push(vault);
    return vault;
  }

  /** Make `holder` eligible as a real proof would: a record valid until `until`, and 690 SPX or more. */
  makeEligible(holder: Address, until = PROVEN_UNTIL, spx = 1_210n * 10n ** 8n): void {
    this.validUntil.set(holder, until);
    this.spx.set(holder, spx);
  }

  /** The registry's `isEligible` at `time`: a valid proof, an account, and 690 SPX now. */
  eligible(holder: Address, time: bigint): boolean {
    return time <= (this.validUntil.get(holder) ?? 0n) && this.accounts.has(holder) && (this.spx.get(holder) ?? 0n) >= MIN_SPX;
  }

  /** The vault's own `dueSince` at `time`: the later of its `_nextBuyAt` and the start of the slot `time` is in. */
  dueSince(v: FakeVault, time: bigint): bigint {
    const slotStart = time <= v.terms.startAt ? v.terms.startAt : v.terms.startAt + ((time - v.terms.startAt) / v.terms.interval) * v.terms.interval;
    const next = this.earliest(v);
    return next > slotStart ? next : slotStart;
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

  /** What the vault would do if `execute`d at `time` by `batcher`, paying `rewardTo`: the vault's own checks, in its order. */
  outcome(vault: Address, time: bigint, real: boolean, batcher: Address, rewardTo: Address): Hex {
    const v = this.vaults.get(vault);
    if (batcher === BATCHER) {
      // v1's batcher triggers only its own factory's vaults.
      if (!v || !v.listed || v.release !== "v1") return REASON.NotFromFactory;
    } else {
      // The shared batcher asks no factory: it calls whatever it is given. An account answers nothing; a v1 vault has
      // no execute(address); a contract that is no factory's runs as it likes.
      if (!v) return REASON.EmptyReturn;
      if (v.release === "v1") return REASON.EmptyRevert;
    }
    if (real && v.onChain) return v.onChain.reason;
    if (v.simulated) return v.simulated;
    if (v.closed) return REASON.VaultClosed;
    if (time < v.terms.startAt) return REASON.NotStarted;
    if (time < this.earliest(v)) return REASON.TooSoon;
    if (v.buysDone >= v.terms.maxBuys) return REASON.NoBuysLeft;
    if (v.balance < v.terms.amountPerBuy + v.terms.keeperReward) return REASON.InsufficientBalance;
    if (v.release === "v2" && time < this.dueSince(v, time) + v.terms.communityWindow! && rewardTo !== v.owner) {
      if (!this.eligible(rewardTo, time)) return REASON.NotEligible;
      // A plan with turns: the window's first half is the slot's bucket's.
      const k = v.terms.turnBuckets ?? 0n;
      const dueSince = this.dueSince(v, time);
      if (k > 0n && time < dueSince + v.terms.communityWindow! / 2n) {
        const slot = (dueSince - v.terms.startAt) / v.terms.interval;
        if (bucketOf(rewardTo, k) !== turnOf(vault, slot, k)) return REASON.NotYourTurn;
      }
    }
    if (!v.quote || v.quote.oracleDepth < VAULT_LIMITS.MIN_ORACLE_DEPTH) return REASON.OracleTooThin;
    if (v.quote.spotOut < v.quote.floorOut) return REASON.PriceBelowFloor;
    return REASON.BOUGHT;
  }

  answer(to: Address, data: Hex): { success: boolean; returnData: Hex } {
    const ok = (returnData: Hex) => ({ success: true, returnData });
    const fail = { success: false, returnData: "0x" as Hex };
    // An address with no code answers a call with nothing, and successfully.
    if (this.codeless.has(to)) return ok("0x");
    const v = this.vaults.get(to);
    if (v) {
      // The two releases' vaults share every selector read here; only the answer to `terms()` has another shape.
      const { functionName } = decodeFunctionData({ abi: VAULT_ABI, data });
      this.calls.push(functionName);
      const { communityWindow: _window, turnBuckets: _turns, ...v1Terms } = v.terms;
      const results: Record<string, unknown> = {
        owner: v.owner,
        terms: v.release === "v1" ? v1Terms : v.terms,
        buysDone: Number(v.buysDone),
        lastBuyAt: v.lastBuyAt,
        closed: v.closed,
        quote: v.quote ? [v.quote.spotOut, v.quote.floorOut, v.quote.oracleDepth] : undefined,
        windowBuys: v.release === "v2" ? Number(v.windowBuys) : undefined,
      };
      if (results[functionName] === undefined) return fail;
      const abi = (v.release === "v1" ? V1_VAULT_ABI : VAULT_ABI) as typeof VAULT_ABI;
      return ok(encodeFunctionResult({ abi, functionName: functionName as never, result: results[functionName] as never }));
    }
    if (to === FACTORY || to === FACTORY_2) {
      const release: VaultRelease = to === FACTORY ? "v1" : "v2";
      const list = this.lists[release];
      const decoded = decodeFunctionData({ abi: FACTORY_ABI, data });
      this.calls.push(decoded.functionName);
      if (decoded.functionName === "isVault") {
        const vault = this.vaults.get(String(decoded.args![0]).toLowerCase() as Address);
        return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", result: (vault?.listed ?? false) && vault?.release === release }));
      }
      if (decoded.functionName === "vaultCount") return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", result: BigInt(list.length) }));
      if (decoded.functionName === "nonces") {
        const owner = String(decoded.args![0]).toLowerCase() as Address;
        return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "nonces", result: this.nonces[release].get(owner) ?? 0n }));
      }
      if (decoded.functionName === "vaultsPage") {
        const [offset, limit] = decoded.args as [bigint, bigint];
        return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", result: list.slice(Number(offset), Number(offset + limit)) }));
      }
      return fail;
    }
    if (to === REGISTRY) {
      const decoded = decodeFunctionData({ abi: REGISTRY_ABI, data });
      this.calls.push(decoded.functionName);
      const holder = String(decoded.args![0]).toLowerCase() as Address;
      if (decoded.functionName === "validUntil") return ok(encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "validUntil", result: this.validUntil.get(holder) ?? 0n }));
      if (decoded.functionName === "isEligible") return ok(encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "isEligible", result: this.eligible(holder, this.time) }));
      return fail;
    }
    if (to === MULTICALL3) {
      const { functionName } = decodeFunctionData({ abi: multicallAbi, data });
      if (functionName === "getCurrentBlockTimestamp") return ok(encodeFunctionResult({ abi: multicallAbi, functionName, result: this.time }));
      if (functionName === "getBlockNumber") return ok(encodeFunctionResult({ abi: multicallAbi, functionName, result: this.block }));
      return fail;
    }
    if (to === WETH || to === SPX) {
      const { args } = decodeFunctionData({ abi: erc20, data });
      const who = String(args![0]).toLowerCase() as Address;
      const balance = to === SPX ? (this.spx.get(who) ?? 0n) : (this.vaults.get(who)?.balance ?? (who === KEEPER ? this.keeperWeth : (this.weth.get(who) ?? 0n)));
      return ok(encodeFunctionResult({ abi: erc20, functionName: "balanceOf", result: balance }));
    }
    if (to === PAIR) return ok(encodeFunctionResult({ abi: pairAbi, functionName: "getReserves", result: [2_329n * ETHER, 10n ** 27n, 0] }));
    return fail;
  }

  /** `batcher`, run at `time`: what each vault does, and what the batch earns. Each batcher in its own shape. */
  runBatch(data: Hex, time: bigint, real: boolean, batcher: Address) {
    const abi = (batcher === BATCHER ? V1_BATCHER_ABI : BATCHER_ABI) as typeof BATCHER_ABI;
    const [vaults, rewardToRaw, minRewards, gasPerVault] = decodeFunctionData({ abi, data }).args as unknown as [Address[], Address, bigint, bigint?];
    this.gasPerVault.push(gasPerVault ?? null);
    const rewardTo = rewardToRaw.toLowerCase() as Address;
    const reasons = vaults.map((vault) => this.outcome(vault.toLowerCase() as Address, time, real, batcher, rewardTo));
    const earned = vaults.reduce((sum, vault, i) => sum + (reasons[i] === REASON.BOUGHT ? this.vaults.get(vault.toLowerCase() as Address)!.terms.keeperReward : 0n), 0n);
    const bought = reasons.filter((r) => r === REASON.BOUGHT).length;
    return { vaults: vaults.map((v) => v.toLowerCase() as Address), rewardTo, minRewards, reasons, earned, bought };
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
        if (tag === "finalized") return this.finalized;
        const number = tag === "latest" ? this.block : BigInt(tag);
        return { number: hex(number), timestamp: hex(this.blockTimes.get(number) ?? this.time), baseFeePerGas: hex(this.baseFee), gasUsed: hex(15_000_000n), gasLimit: hex(30_000_000n) };
      }
      case "eth_getProof": {
        if (this.proof === "refused") throw Object.assign(new Error("the method eth_getProof does not exist/is not available"), { code: -32601 });
        return params[2] === hex(PROVEN_BLOCK) ? proofAnswer(this.proof.value) : null;
      }
      case "eth_getTransactionCount":
        return hex(this.nonce);
      case "eth_getBalance":
        return hex(this.keeperBalance);
      case "eth_getCode": {
        const address = (params[0] as string).toLowerCase() as Address;
        return this.codeless.has(address) || this.accounts.has(address) ? "0x" : "0x60";
      }
      case "eth_estimateGas": {
        const call = params[0] as { to: Address; data: Hex };
        if (call.to.toLowerCase() !== REGISTRY) return hex(800_000n);
        // A proof that would not move validUntil reverts, as the registry's does.
        const holder = String(decodeFunctionData({ abi: REGISTRY_ABI, data: call.data }).args![0]).toLowerCase() as Address;
        const stored = this.validUntil.get(holder) ?? 0n;
        if (stored >= PROVEN_UNTIL) throw Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: REGISTRY_ABI, errorName: "NotNewer", args: [stored] }) });
        return hex(550_000n);
      }
      case "eth_call": {
        const call = params[0] as { to: Address; data: Hex };
        const to = call.to.toLowerCase() as Address;
        if (to === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: multicallAbi, data: call.data });
          const calls = args![0] as readonly { target: Address; callData: Hex }[];
          return encodeFunctionResult({
            abi: multicallAbi,
            functionName: "aggregate3",
            result: calls.map((c) => this.answer(c.target.toLowerCase() as Address, c.callData)),
          });
        }
        if (to === BATCHER || to === BATCHER_2) {
          this.calls.push("executeBatch");
          if (this.failNextSimulation) {
            this.failNextSimulation = false;
            throw new Error(`eth_call: upstream ${UPSTREAM} did not answer`);
          }
          const run = this.runBatch(call.data, this.time, false, to);
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
    if (to === BATCHER || to === BATCHER_2) {
      // Each release's batcher logs its own release's events: v1's `Batch` carries a sweep, v2's `Bought` whom it paid.
      const v2 = to === BATCHER_2;
      const batcherAbi = (v2 ? BATCHER_ABI : V1_BATCHER_ABI) as Abi;
      const run = this.runBatch(tx.data!, this.time, true, to);
      gasUsed = 160_000n;
      if (run.bought === 0 || run.earned < run.minRewards) {
        status = 0n;
      } else {
        run.vaults.forEach((vault, i) => {
          const reason = run.reasons[i]!;
          const v = this.vaults.get(vault);
          if (reason === REASON.BOUGHT && v) {
            const dueSince = this.dueSince(v, this.time);
            if (v2 && this.time < dueSince + v.terms.communityWindow! && run.rewardTo !== v.owner) v.windowBuys += 1n;
            v.buysDone += 1n;
            v.lastBuyAt = this.time;
            v.balance -= v.terms.amountPerBuy + v.terms.keeperReward;
            const slot = (this.time - v.terms.startAt) / v.terms.interval;
            const bought = { slot, amountIn: v.terms.amountPerBuy, amountOut: 1_000n, keeper: to, reward: v.terms.keeperReward, floorOut: 970n, buyNumber: v.buysDone, oracleDepth: 60n * ETHER };
            logs.push(v2 ? eventLog(VAULT_ABI, "Bought", { ...bought, rewardTo: run.rewardTo, dueSince }, vault) : eventLog(V1_VAULT_ABI as Abi, "Bought", bought, vault));
            logs.push(eventLog(batcherAbi, "Triggered", { vault, received: 1_000n, gasUsed: 100_000n }, to));
            gasUsed += 100_000n;
          } else {
            const used = v?.onChain?.gasUsed ?? 20_000n;
            logs.push(eventLog(batcherAbi, "NotTriggered", { vault, reason, gasUsed: used }, to));
            gasUsed += used;
          }
        });
        const batch = { caller: KEEPER, rewardTo: run.rewardTo, listed: BigInt(run.vaults.length), tried: BigInt(run.vaults.length), bought: BigInt(run.bought), earned: run.earned };
        logs.push(eventLog(batcherAbi, "Batch", v2 ? batch : { ...batch, swept: 0n }, to));
        this.weth.set(run.rewardTo, (this.weth.get(run.rewardTo) ?? 0n) + run.earned);
      }
    } else if (to === REGISTRY) {
      gasUsed = 660_000n;
      const holder = String(decodeFunctionData({ abi: REGISTRY_ABI, data: tx.data! }).args![0]).toLowerCase() as Address;
      if (this.proveReverts || (this.validUntil.get(holder) ?? 0n) >= PROVEN_UNTIL) {
        status = 0n;
      } else {
        this.validUntil.set(holder, PROVEN_UNTIL);
        logs.push(eventLog(REGISTRY_ABI, "Proven", { holder, blockNumber: PROVEN_BLOCK, balance: BigInt(holder25999900.balance), validUntil: PROVEN_UNTIL }, REGISTRY));
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

/**
 * The vaults a test's chain made, by the number it named them with: `vaultAt(n)`
 * names one before it exists, and is where its factory put it after
 * (`FakeChain.addVault`). Cleared for every test.
 */
const made = new Map<number, Address>();
/** A name in a range of its own, clear of the factory, batcher, owner and rewardTo. */
const placeholder = (n: number): Address => `0xa${n.toString(16).padStart(39, "0")}`;
/** The number a placeholder names; null for any other address. */
function placeholderIndex(address: Address): number | null {
  if (!address.startsWith("0xa")) return null;
  const n = Number.parseInt(address.slice(3), 16);
  return Number.isSafeInteger(n) && placeholder(n) === address ? n : null;
}
/** Vault `n`: where its factory put it, once made; its name until then. */
const vaultAt = (n: number): Address => made.get(n) ?? placeholder(n);
/** An address as the chain knows it now: a made vault's own, for its name. */
const resolved = (address: Address): Address => {
  const n = placeholderIndex(address);
  return n === null ? address : vaultAt(n);
};

function setup(
  options: {
    policy?: Partial<KeeperPolicy>;
    vaults?: Address[] | null;
    rewardTo?: Address | null;
    privateSend?: boolean;
    dryRun?: boolean;
    /** v1 alone, as before v2, unless a test serves v2 too. */
    deployments?: Deployment[];
    prove?: boolean;
    gasPerVault?: bigint;
  } = {},
) {
  made.clear();
  const chain = new FakeChain();
  const records: KeeperLogRecord[] = [];
  const deployments = options.deployments ?? [V1];
  const policy: Partial<KeeperPolicy> = { sendWhen: "now", confirmations: 1, maxHeadLagSeconds: 0n, ...options.policy };
  const rewardTo = options.rewardTo === undefined ? COLD : options.rewardTo;
  const config = (extra: Partial<KeeperPolicy> = {}, restart: { prove?: boolean; rewardTo?: Address } = {}) =>
    keeperConfig({
      chainId: 1,
      deployments,
      weth: WETH,
      ...(options.dryRun ? {} : { keeperKey: KEY }),
      ...(restart.rewardTo ? { rewardTo: restart.rewardTo } : rewardTo === null ? {} : { rewardTo }),
      // An allowlist names vaults before they are made: each is resolved to where its factory put it.
      ...(options.vaults ? { vaults: options.vaults.map(resolved) } : {}),
      privateSend: options.privateSend ?? false,
      prove: restart.prove ?? options.prove ?? false,
      ...(options.gasPerVault ? { gasPerVault: options.gasPerVault } : {}),
      policy: { ...policy, ...extra },
    });
  const state = newKeeperState({ chainId: 1, keeper: options.dryRun ? null : KEEPER, deployments });
  const persisted: string[] = [];
  /** One tick; `restart` runs it as a keeper restarted with proving or `rewardTo` set otherwise. */
  const tick = (
    extra: { waitForReceiptMs?: number; wallClockMs?: () => number; policy?: Partial<KeeperPolicy>; state?: KeeperState; restart?: { prove?: boolean; rewardTo?: Address } } = {},
  ) =>
    keeperTick(chain.rpc, {
      config: config(extra.policy, extra.restart),
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
    // Its index in the market list its release records (deployments.json), whichever factory that is.
    expect(ofType("vault_found")[0]).toMatchObject({ vault: vaultAt(1), deployment: "v1", index: 0n, owner: OWNER, marketIndex: 0 });

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
    const { chain, state, tick, ofType } = setup({ vaults: [vaultAt(9)] });
    const stranger = chain.addVault(vaultAt(9), { listed: false });
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

  it("does nothing on a head dated ahead of the wall clock by more than the lag allowed, and says so", async () => {
    const { chain, tick } = setup({ policy: { maxHeadLagSeconds: 120n } });
    chain.addVault(vaultAt(1));
    const result = await tick({ wallClockMs: () => Number(chain.time - 121n) * 1000 });
    expect(result.waiting).toEqual({ reason: "stale-head", candidates: 0 });
    expect(result.health).toMatchObject({ ok: false, headLagSeconds: -121n });
    expect(result.health.attention).toContain("stale_head");
    expect(chain.calls).toEqual([]);
    // Within the allowance either way, it goes on.
    expect((await tick({ wallClockMs: () => Number(chain.time - 120n) * 1000 })).waiting?.reason).not.toBe("stale-head");
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
    // A keeper that has kept its spend for a week: one younger than a day has no runway to report yet.
    state.spendSince = T0 - 7n * DAY;
    const result = await tick({ waitForReceiptMs: 1 });
    expect(result.health.attention).toEqual(expect.arrayContaining(["low_balance", "public_mempool"]));
    expect(result.health).toMatchObject({ ok: true, active: 1, due: 1, lastBatchHash: result.sent[0]!.hash, balanceWei: ETHER / 1_000n });
    expect(result.health.runwayDays).not.toBeNull();
    // Rewards come to the keeper and its ether is low: its WETH is unwrapped, through the nonce manager.
    expect(state.pending?.purpose).toBe("unwrap");
  });
});

// ─── v2: the community window ─────────────────────────────────────────────────

describe("the community window", () => {
  const both = { deployments: [V1, V2] };

  it("leaves a buy inside its window to SPX holders when rewardTo is not eligible, ticks again as the window ends, and makes it then", async () => {
    const { chain, state, tick, ofType } = setup(both);
    // A 5-minute plan's shortest window: a minute of first claim.
    chain.addVault(vaultAt(1), { release: "v2", terms: { interval: 300n, communityWindow: 60n } });
    const first = await tick();
    expect(first.sent).toEqual([]);
    expect(first.skipped).toContainEqual({ vault: vaultAt(1), code: "holders-first", detail: `SPX holders have first claim until ${T0 + 60n} (chain time)` });
    expect(first.waiting).toEqual({ reason: "holders-first", candidates: 1 });
    // A buy left to holders is never priced, test-run or sent.
    expect(chain.calls).not.toContain("quote");
    expect(chain.calls).not.toContain("executeBatch");
    expect(state.eligibility["v2"]).toMatchObject({ registry: REGISTRY, holder: COLD, eligible: false, validUntil: 0n, readAt: T0 });
    // Twenty seconds on, the next tick is planned for the window's end.
    chain.advance(20n);
    expect((await tick()).nextTickSeconds).toBe(40);
    chain.advance(40n);
    const open = await tick({ waitForReceiptMs: 1 });
    expect(open.sent.map((s) => s.vaults)).toEqual([[vaultAt(1)]]);
    expect(open.mined[0]!.bought).toEqual([expect.objectContaining({ vault: vaultAt(1), rewardTo: COLD, dueSince: T0, inCommunityWindow: false })]);
    expect(open.mined[0]!.sweptWei).toBeNull();
    expect(chain.weth.get(COLD)).toBe(87_300_000_000_000n);
    expect(chain.vaults.get(vaultAt(1))!.windowBuys).toBe(0n);
    expect(ofType("batch_sent")[0]).toMatchObject({ deployment: "v2", batcher: BATCHER_2, vaults: [expect.objectContaining({ communityWindowEndsAt: null })] });
    // Said once, and cleared by the buy.
    expect(ofType("skip").filter((r) => r.code === "holders-first")).toHaveLength(1);
    expect(ofType("skip_cleared")).toContainEqual(expect.objectContaining({ vault: vaultAt(1), code: "holders-first" }));
  });

  it("counts eligibility it cannot read as none: a registry with no code, or a dry run with no rewardTo", async () => {
    const missing = setup(both);
    missing.chain.codeless.add(REGISTRY);
    missing.chain.makeEligible(COLD);
    missing.chain.addVault(vaultAt(1), { release: "v2" });
    expect((await missing.tick()).skipped.map((s) => s.code)).toEqual(["holders-first"]);
    expect(missing.state.eligibility["v2"]).toMatchObject({ eligible: null, validUntil: null });

    const dry = setup({ ...both, dryRun: true, rewardTo: null });
    dry.chain.addVault(vaultAt(1), { release: "v2" });
    dry.chain.addVault(vaultAt(2), { release: "v2", terms: { startAt: T0 - HOUR } });
    const result = await dry.tick();
    // Only the buy open to anyone is test-run, with the dry run's stand-in rewardTo.
    expect(result.skipped).toContainEqual(expect.objectContaining({ vault: vaultAt(1), code: "holders-first" }));
    expect(result.waiting).toEqual({ reason: "dry-run", candidates: 1 });
    expect(dry.state.eligibility).toEqual({});
    expect(dry.chain.calls).not.toContain("isEligible");
  });

  it("takes a buy inside its window at once when rewardTo is eligible, at the patient tip, even while waiting for cheap blocks", async () => {
    const { chain, tick, ofType } = setup({ ...both, rewardTo: HOLDER, policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    chain.makeEligible(HOLDER);
    chain.addVault(vaultAt(1), { release: "v2" });
    const result = await tick({ waitForReceiptMs: 1 });
    expect(result.sent).toHaveLength(1);
    expect(ofType("batch_sent")[0]).toMatchObject({
      reason: "window",
      urgent: false,
      maxPriorityFeePerGas: FEE_TIP_REFERENCE,
      vaults: [expect.objectContaining({ vault: vaultAt(1), communityWindowEndsAt: T0 + 1_800n })],
    });
    expect(parseTransaction(chain.sentRaw[0]!).maxPriorityFeePerGas).toBe(FEE_TIP_REFERENCE);
    expect(result.mined[0]!.bought).toEqual([expect.objectContaining({ rewardTo: HOLDER, dueSince: T0, inCommunityWindow: true })]);
    expect(chain.weth.get(HOLDER)).toBe(87_300_000_000_000n);
    expect(chain.vaults.get(vaultAt(1))!.windowBuys).toBe(1n);
    expect(result.health.eligible).toBe(true);
  });

  it("bids the urgent tip in a window's last two minutes, and in the last quarter of a window under eight minutes", async () => {
    const sentWith = async (terms: Partial<VaultTerms>, secondsLeft: bigint) => {
      const { chain, tick, ofType } = setup({ ...both, rewardTo: HOLDER, policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
      chain.makeEligible(HOLDER);
      chain.addVault(vaultAt(1), { release: "v2", terms: { ...terms, startAt: T0 - (terms.communityWindow! - secondsLeft) } });
      await tick();
      const sent = ofType("batch_sent")[0]!;
      return [sent.reason, sent.urgent, sent.maxPriorityFeePerGas];
    };
    const patient = ["window", false, FEE_TIP_REFERENCE];
    const urgent = ["deadline", true, DEFAULT_KEEPER_POLICY.urgentTip];
    // A daily plan's 30 minutes: patient until two minutes are left.
    expect(await sentWith({ communityWindow: 1_800n }, 121n)).toEqual(patient);
    expect(await sentWith({ communityWindow: 1_800n }, 120n)).toEqual(urgent);
    // A 7-minute window: its last quarter, 105 seconds.
    expect(await sentWith({ interval: 1_680n, communityWindow: 420n }, 106n)).toEqual(patient);
    expect(await sentWith({ interval: 1_680n, communityWindow: 420n }, 105n)).toEqual(urgent);
    // The 5-minute plan's 75 seconds: an 18-second tail, urgent though the plan is short.
    expect(await sentWith({ interval: 300n, communityWindow: 75n }, 19n)).toEqual(patient);
    expect(await sentWith({ interval: 300n, communityWindow: 75n }, 18n)).toEqual(urgent);
  });

  it("never bids up against other holders inside the window: sends the batch again as it was until its urgent point, then replaces it at the urgent tip", async () => {
    const { chain, state, tick, ofType } = setup({ ...both, rewardTo: HOLDER });
    chain.makeEligible(HOLDER);
    chain.autoMine = false;
    chain.addVault(vaultAt(1), { release: "v2" });
    await tick();
    const first = chain.sentRaw[0]!;
    expect(parseTransaction(first).maxPriorityFeePerGas).toBe(FEE_TIP_REFERENCE);
    // Well past the resend interval, deep inside the window: broadcast again, unchanged.
    for (let i = 0; i < 5; i++) {
      chain.advance(120n, 10n);
      await tick();
    }
    expect(ofType("batch_replaced")).toEqual([]);
    expect(state.pending?.attempts).toHaveLength(1);
    expect(chain.sentRaw.at(-1)).toBe(first);
    // Its last two minutes: replaced at the urgent tip, at the same nonce.
    chain.advance(1_800n - 600n - 120n, 10n);
    await tick();
    expect(ofType("batch_replaced")).toHaveLength(1);
    const replaced = parseTransaction(chain.sentRaw.at(-1)!);
    expect(replaced.nonce).toBe(parseTransaction(first).nonce);
    expect(replaced.maxPriorityFeePerGas! >= DEFAULT_KEEPER_POLICY.urgentTip).toBe(true);
    chain.mine();
    expect((await tick()).mined[0]?.bought.map((b) => [b.rewardTo, b.inCommunityWindow])).toEqual([[HOLDER, true]]);
  });

  it("never bids up a buy inside its window because a buy open to anyone rides with it: the batch waits as it was until the window's urgent point", async () => {
    const { chain, state, tick, ofType } = setup({ ...both, rewardTo: HOLDER });
    chain.makeEligible(HOLDER);
    chain.autoMine = false;
    // Inside its first window, and a buy whose window ended half an hour ago, its slot's deadline hours off.
    chain.addVault(vaultAt(1), { release: "v2" });
    chain.addVault(vaultAt(2), { release: "v2", terms: { startAt: T0 - HOUR } });
    await tick();
    expect(ofType("batch_sent")).toEqual([
      expect.objectContaining({ urgent: false, maxPriorityFeePerGas: FEE_TIP_REFERENCE, vaults: [expect.objectContaining({ vault: vaultAt(1) }), expect.objectContaining({ vault: vaultAt(2) })] }),
    ]);
    const first = chain.sentRaw[0]!;
    // Twelve minutes of resend intervals inside the window: broadcast again, never replaced, never a wei more.
    for (let i = 0; i < 6; i++) {
      chain.advance(120n, 10n);
      await tick();
    }
    expect(ofType("batch_replaced")).toEqual([]);
    expect(state.pending?.attempts).toHaveLength(1);
    expect(chain.sentRaw.at(-1)).toBe(first);
    // The window's last two minutes: now both go at the urgent tip, at the same nonce.
    chain.advance(1_800n - 720n - 120n, 10n);
    await tick();
    expect(ofType("batch_replaced")).toHaveLength(1);
    expect(parseTransaction(chain.sentRaw.at(-1)!).maxPriorityFeePerGas! >= DEFAULT_KEEPER_POLICY.urgentTip).toBe(true);
    chain.mine();
    expect((await tick()).mined[0]?.bought.map((b) => [b.vault, b.inCommunityWindow])).toEqual([
      [vaultAt(1), true],
      [vaultAt(2), false],
    ]);
  });

  it("never lends a buy inside its window the urgent tip of one past its slot's deadline: the hurried buy goes alone, the patient one after it", async () => {
    const { chain, tick, ofType } = setup({ ...both, rewardTo: HOLDER, policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    chain.makeEligible(HOLDER);
    chain.addVault(vaultAt(1), { release: "v2" });
    // Its slot ends in an hour, its deadline passed an hour ago, its window long over: open to anyone, and hurried.
    chain.addVault(vaultAt(2), { release: "v2", terms: { startAt: T0 - DAY + HOUR } });
    await tick({ waitForReceiptMs: 1 });
    await tick({ waitForReceiptMs: 1 });
    expect(ofType("batch_sent").map((r) => [r.vaults.map((v) => v.vault), r.reason, r.urgent, r.maxPriorityFeePerGas])).toEqual([
      [[vaultAt(2)], "deadline", true, DEFAULT_KEEPER_POLICY.urgentTip],
      [[vaultAt(1)], "window", false, FEE_TIP_REFERENCE],
    ]);
    expect(chain.vaults.get(vaultAt(1))!.windowBuys).toBe(1n);
  });

  it("sends the patient buy instead when the hurried one can't pay its way alone, and never the two together", async () => {
    const { chain, tick, ofType } = setup({ ...both, rewardTo: HOLDER });
    chain.makeEligible(HOLDER);
    chain.addVault(vaultAt(1), { release: "v2" });
    // A fee that covers its own first buy at the urgent tip, but not the batch's fixed gas besides.
    chain.addVault(vaultAt(2), { release: "v2", terms: { startAt: T0 - DAY + HOUR, keeperReward: 40_000_000_000_000n } });
    const result = await tick({ waitForReceiptMs: 1 });
    expect(ofType("batch_sent").map((r) => [r.vaults.map((v) => v.vault), r.urgent, r.maxPriorityFeePerGas])).toEqual([[[vaultAt(1)], false, FEE_TIP_REFERENCE]]);
    expect(result.skipped).toContainEqual({ vault: vaultAt(2), code: "economics", detail: "fees-below-gas" });
  });

  it("sends the patient buy at the patient tip when the urgent tip is above the fee cap, rather than nothing", async () => {
    // The next block's 0.1 gwei and the urgent 0.1 tip are above a 0.15 cap; the patient 0.02 tip is not.
    const { chain, tick, ofType } = setup({ ...both, rewardTo: HOLDER, policy: { sendWhen: "cheap", cheapBaseFee: 0n, maxFeePerGas: 150_000_000n } });
    chain.makeEligible(HOLDER);
    chain.addVault(vaultAt(1), { release: "v2" });
    chain.addVault(vaultAt(2), { release: "v2", terms: { startAt: T0 - DAY + HOUR } });
    await tick({ waitForReceiptMs: 1 });
    expect(ofType("batch_sent").map((r) => [r.vaults.map((v) => v.vault), r.urgent, r.maxPriorityFeePerGas])).toEqual([[[vaultAt(1)], false, FEE_TIP_REFERENCE]]);
    // The hurried one waits for fees under the cap, the way any buy does.
    expect((await tick()).waiting).toEqual({ reason: "fees-above-max", candidates: 1 });
  });

  it("prices a buy inside its window by the window alone, even when an operator's deadline share puts its slot's deadline inside it", async () => {
    const sentAt = async (secondsBeforeWindowEnds: bigint) => {
      // A 4-hour plan with an hour's window, due 7,140 seconds into its slot by the spacing rule after a buy late in
      // the slot before. A deadline share of 0.3 puts the slot's deadline 10,080 seconds in: inside the window.
      const { chain, tick, ofType } = setup({ ...both, rewardTo: HOLDER, policy: { sendWhen: "cheap", cheapBaseFee: 0n, deadlineShareBps: 3_000n } });
      chain.makeEligible(HOLDER);
      const slotStart = T0 - 10_740n + secondsBeforeWindowEnds;
      chain.addVault(vaultAt(1), {
        release: "v2",
        buysDone: 1n,
        lastBuyAt: slotStart - 60n,
        terms: { interval: 4n * HOUR, communityWindow: HOUR, startAt: slotStart - 4n * HOUR },
      });
      await tick();
      const sent = ofType("batch_sent")[0]!;
      return [sent.reason, sent.urgent, sent.maxPriorityFeePerGas, sent.vaults[0]!.communityWindowEndsAt === T0 + secondsBeforeWindowEnds];
    };
    // Past the slot's deadline, ten minutes before the window ends: still the patient tip.
    expect(await sentAt(640n)).toEqual(["window", false, FEE_TIP_REFERENCE, true]);
    expect(await sentAt(121n)).toEqual(["window", false, FEE_TIP_REFERENCE, true]);
    // Its last two minutes, as any window's.
    expect(await sentAt(120n)).toEqual(["deadline", true, DEFAULT_KEEPER_POLICY.urgentTip, true]);
  });

  it("withdraws a patient batch that lost its race to another holder, without waiting for its urgent point", async () => {
    const { chain, state, tick, ofType } = setup({ ...both, rewardTo: HOLDER });
    chain.makeEligible(HOLDER);
    chain.autoMine = false;
    chain.addVault(vaultAt(1), { release: "v2" });
    await tick();
    // Another holder makes the buy, and the batch in flight can no longer buy anything.
    const v = chain.vaults.get(vaultAt(1))!;
    v.buysDone = 1n;
    v.lastBuyAt = chain.time + 12n;
    v.windowBuys = 1n;
    chain.advance(120n, 10n);
    await tick();
    // In the public pool it could still land and cost gas: cancelled, minutes before the window's tail.
    expect(ofType("overtaken").map((r) => r.vault)).toEqual([vaultAt(1)]);
    expect(ofType("batch_cancel_sent")).toHaveLength(1);
    expect(ofType("batch_replaced")).toEqual([]);
    expect(state.vaults[vaultAt(1)]!.buysDone).toBe(1n);
  });

  it("rests a buy its rewardTo turns out not to be eligible for, in a test-run or on chain, until the window ends; never a trap", async () => {
    const { chain, state, tick } = setup({ ...both, rewardTo: HOLDER });
    chain.makeEligible(HOLDER);
    chain.addVault(vaultAt(1), { release: "v2", simulated: REASON.NotEligible });
    chain.addVault(vaultAt(2), { release: "v2", onChain: { reason: REASON.NotEligible, gasUsed: 30_000n } });
    chain.addVault(vaultAt(3), { release: "v2" });
    const result = await tick({ waitForReceiptMs: 1 });
    expect(reasonName(REASON.NotEligible)).toBe("NotEligible");
    expect(result.skipped).toContainEqual({ vault: vaultAt(1), code: "sim-refused", detail: "NotEligible" });
    expect(state.vaults[vaultAt(1)]!.restingUntil).toBe(T0 + 1_800n);
    expect(result.mined[0]!.refused).toEqual([expect.objectContaining({ vault: vaultAt(2), reasonName: "NotEligible" })]);
    expect(state.vaults[vaultAt(2)]!.restingUntil).toBe(T0 + 1_800n);
    expect(result.mined[0]!.bought.map((b) => b.vault)).toEqual([vaultAt(3)]);
    expect(state.trapped).toEqual({});
    // Taken as unknown for the rest of that tick, and read again at the next.
    chain.advance(12n);
    await tick();
    expect(state.eligibility["v2"]).toMatchObject({ eligible: true, readAt: chain.time });
  });

  it("counts rewardTo as eligible inside the windows of the vaults it owns, and no others", async () => {
    const { chain, tick } = setup({ ...both, rewardTo: OWNER });
    chain.addVault(vaultAt(1), { release: "v2" });
    chain.addVault(vaultAt(2), { release: "v2", owner: COLD });
    const result = await tick({ waitForReceiptMs: 1 });
    expect(result.sent.map((s) => s.vaults)).toEqual([[vaultAt(1)]]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ vault: vaultAt(2), code: "holders-first" }));
    // The fee came back to the owner, and is no window buy.
    expect(chain.weth.get(OWNER)).toBe(87_300_000_000_000n);
    expect(chain.vaults.get(vaultAt(1))!.windowBuys).toBe(0n);
  });

  it("takes a buy inside its window only while its proof is still valid in the next block, where the vault asks", async () => {
    const at = async (validFor: bigint) => {
      const { chain, tick } = setup({ ...both, rewardTo: HOLDER });
      chain.makeEligible(HOLDER, T0 + validFor);
      chain.addVault(vaultAt(1), { release: "v2" });
      const result = await tick({ waitForReceiptMs: 1 });
      return [result.sent.length, result.skipped.map((s) => s.code), chain.vaults.get(vaultAt(1))!.windowBuys];
    };
    // Valid now, lapsed by the next block: a batch would only buy a NotEligible.
    expect(await at(11n)).toEqual([0, ["holders-first"], 0n]);
    // Valid through the next block's second, inclusive: the buy is made, and is a window buy.
    expect(await at(12n)).toEqual([1, [], 1n]);
  });

  it("waits for the next slot's window when the slot ends before a buy sent now could land", async () => {
    const { chain, tick } = setup(both);
    // Its first window ended long ago, but its slot ends in 5 seconds: a batch would land in the next slot, inside that slot's own window.
    chain.addVault(vaultAt(1), { release: "v2", terms: { interval: 300n, communityWindow: 60n, startAt: T0 - 295n } });
    const result = await tick();
    expect(result.sent).toEqual([]);
    expect(result.skipped).toContainEqual({ vault: vaultAt(1), code: "holders-first", detail: `SPX holders have first claim until ${T0 + 65n} (chain time)` });
  });
});

// ─── Turns ────────────────────────────────────────────────────────────────────

describe("turns", () => {
  const both = { deployments: [V1, V2] };
  /** An account the registry finds eligible, in bucket `turn` of `k` (`inIt`) or out of it. */
  function holderIn(chain: FakeChain, turn: bigint, k: bigint, inIt: boolean): Address {
    for (let i = 1; ; i++) {
      const holder = `0x${(0xc000 + i).toString(16).padStart(40, "0")}` as Address;
      if ((bucketOf(holder, k) === turn) !== inIt) continue;
      chain.makeEligible(holder, T0 + 30n * DAY);
      chain.accounts.add(holder);
      return holder;
    }
  }

  it("leaves another bucket's turn to it, ticks again as the turn ends, and makes the buy then, inside the window", async () => {
    const { chain, tick } = setup(both);
    const vault = chain.addVault(vaultAt(1), { release: "v2", terms: { turnBuckets: 4n } });
    const off = holderIn(chain, turnOf(vault, 0n, 4n), 4n, false);
    const first = await tick({ restart: { rewardTo: off } });
    expect(first.sent).toEqual([]);
    // The turn is the 30-minute window's first half.
    expect(first.skipped).toContainEqual({ vault, code: "other-turn", detail: `holders in another bucket have first claim until ${T0 + 900n} (chain time)` });

    chain.advance(900n);
    const later = await tick({ restart: { rewardTo: off }, waitForReceiptMs: 1 });
    expect(later.sent.map((s) => s.vaults)).toEqual([[vault]]);
    // After the turn, still inside the window: a community window buy, paid to the eligible holder.
    expect(chain.vaults.get(vault)!.windowBuys).toBe(1n);
    expect(chain.weth.get(off)).toBe(87_300_000_000_000n);
  });

  it("makes the buy at once for a holder in the slot's bucket, and a plan without turns has none to wait for", async () => {
    const { chain, tick } = setup(both);
    const vault = chain.addVault(vaultAt(1), { release: "v2", terms: { turnBuckets: 4n } });
    const on = holderIn(chain, turnOf(vault, 0n, 4n), 4n, true);
    const result = await tick({ restart: { rewardTo: on }, waitForReceiptMs: 1 });
    expect(result.sent.map((s) => s.vaults)).toEqual([[vault]]);

    const plain = setup(both);
    const none = plain.chain.addVault(vaultAt(1), { release: "v2" });
    const anyone = holderIn(plain.chain, 1n, 4n, true);
    const sent = await plain.tick({ restart: { rewardTo: anyone }, waitForReceiptMs: 1 });
    expect(sent.sent.map((s) => s.vaults)).toEqual([[none]]);
  });

  it("rests a vault its batch found inside another bucket's turn until the turn ends", async () => {
    const { chain, state, tick } = setup(both);
    const vault = chain.addVault(vaultAt(1), { release: "v2", terms: { turnBuckets: 4n } });
    const off = holderIn(chain, turnOf(vault, 0n, 4n), 4n, false);
    // The keeper's own judgement says the turn is over; the vault says not.
    chain.vaults.get(vault)!.simulated = REASON.NotYourTurn;
    chain.advance(900n);
    await tick({ restart: { rewardTo: off } });
    expect(reasonName(REASON.NotYourTurn)).toBe("NotYourTurn");
    // Its turn ended at T0 + 900: the vault rests until the end of the window it is in now.
    expect(state.vaults[vault]!.restingUntil).toBe(T0 + 1_800n);
  });
});

// ─── Proving a vault is its factory's ─────────────────────────────────────────

describe("proving each vault its factory's clone", () => {
  const both = { deployments: [V1, V2] };
  /** A contract a lying endpoint lists in v2's factory's list: it answers like a vault, and no factory made it. */
  const FORGED: Address = "0x0bad00000000000000000000000000000000ba5e";

  it("never batches a listed address that is not where its factory puts a vault with the owner and terms it answers", async () => {
    const { chain, state, tick } = setup({ ...both, rewardTo: COLD });
    // Both after their windows, so any rewardTo may be paid: only the proof stands between the forged one and a batch.
    const startAt = T0 - 2n * HOUR;
    chain.addVault(FORGED, { release: "v2", terms: { startAt } });
    const real = chain.addVault(vaultAt(1), { release: "v2", terms: { startAt } });
    const first = await tick({ waitForReceiptMs: 1 });
    expect(first.sent.map((s) => s.vaults)).toEqual([[real]]);
    expect(first.skipped).toContainEqual({ vault: FORGED, code: "unproven", detail: expect.stringContaining("not where v2 factory puts a vault") });
    expect(state.vaults[FORGED]).toMatchObject({ nonce: null, restingUntil: T0 + HOUR });
    expect(state.vaults[real]!.nonce).toBe(0n);
    // The shared batcher calls whatever it is sent: it was never sent the forged address, in a simulation or a batch.
    const batched = chain.sentRaw.map((raw) => (decodeFunctionData({ abi: BATCHER_ABI, data: parseTransaction(raw).data! }).args![0] as Address[]).map((v) => v.toLowerCase()));
    expect(batched).toEqual([[real]]);

    // An hour on it is tried again, and still never sent.
    chain.advance(HOUR + 1n);
    const later = await tick({ waitForReceiptMs: 1 });
    expect(later.sent.flatMap((s) => s.vaults)).not.toContain(FORGED);
    expect(state.vaults[FORGED]!.nonce).toBeNull();
  });

  it("proves each vault once, at the nonce its factory made it with, and remembers it", async () => {
    const { chain, state, tick } = setup();
    const first = chain.addVault(vaultAt(1));
    const second = chain.addVault(vaultAt(2), { terms: { amountPerBuy: ETHER / 50n, keeperReward: 156_000_000_000_000n } });
    await tick({ waitForReceiptMs: 1 });
    expect([state.vaults[first]!.nonce, state.vaults[second]!.nonce]).toEqual([0n, 1n]);
    const asked = chain.calls.filter((c) => c === "nonces").length;
    expect(asked).toBe(2);
    // The next slot's buys: no proof asked for again.
    chain.advance(DAY);
    const next = await tick({ waitForReceiptMs: 1 });
    expect(next.sent.flatMap((s) => s.vaults).sort()).toEqual([first, second].sort());
    expect(chain.calls.filter((c) => c === "nonces").length).toBe(asked);
  });

  it("gives each vault the configured gas through the shared batcher, and v1's its fixed cap", async () => {
    const { chain, tick } = setup({ ...both, gasPerVault: 600_000n, policy: { sendWhen: "now" } });
    const v2 = chain.addVault(vaultAt(1), { release: "v2", terms: { startAt: T0 - 2n * HOUR } });
    const v1 = chain.addVault(vaultAt(2));
    await tick({ waitForReceiptMs: 1 });
    await tick({ waitForReceiptMs: 1 });
    expect(chain.vaults.get(v1)!.buysDone + chain.vaults.get(v2)!.buysDone).toBe(2n);
    // Every simulation and every batch: v2's through the shared batcher at 600,000, v1's through its own, which takes none.
    expect(new Set(chain.gasPerVault)).toEqual(new Set([600_000n, null]));
  });
});

describe("v1 and v2 together", () => {
  it("sends each release's due buys to its own batcher, one batch a tick, and v1's exactly as v1 did", async () => {
    const { chain, state, tick, ofType } = setup({ deployments: [V1, V2] });
    chain.addVault(vaultAt(1));
    // A v2 vault whose first window ended half an hour ago: open to anyone.
    chain.addVault(vaultAt(2), { release: "v2", terms: { startAt: T0 - HOUR } });
    const first = await tick({ waitForReceiptMs: 1 });
    const second = await tick({ waitForReceiptMs: 1 });
    expect(ofType("vault_found").map((r) => [r.vault, r.deployment, r.communityWindow])).toEqual([
      [vaultAt(1), "v1", null],
      [vaultAt(2), "v2", 1_800n],
    ]);
    expect(ofType("batch_sent").map((r) => [r.deployment, r.batcher, r.vaults.map((v) => v.vault)])).toEqual([
      ["v1", BATCHER, [vaultAt(1)]],
      ["v2", BATCHER_2, [vaultAt(2)]],
    ]);
    // v1's batch: its batcher is the caller its vault paid, and it swept nothing; v2's paid rewardTo itself, and has no sweep at all.
    expect(first.mined[0]).toMatchObject({ sweptWei: 0n, bought: [expect.objectContaining({ rewardTo: BATCHER, dueSince: null, inCommunityWindow: null })] });
    expect(second.mined[0]).toMatchObject({ sweptWei: null, bought: [expect.objectContaining({ rewardTo: COLD, dueSince: T0 - HOUR, inCommunityWindow: false })] });
    expect(chain.weth.get(COLD)).toBe(2n * 87_300_000_000_000n);
    expect([state.vaults[vaultAt(1)]!.buysDone, state.vaults[vaultAt(2)]!.buysDone]).toEqual([1n, 1n]);
  });
});

describe("the SPX holder registry", () => {
  it("logs when rewardTo's proof lapses, whether or not it proves: when it changes, once a day besides, and in the tick's health", async () => {
    const { chain, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER });
    chain.makeEligible(HOLDER, T0 + 3n * DAY);
    const first = await tick();
    expect(ofType("eligibility")).toEqual([
      expect.objectContaining({
        deployment: "v2",
        registry: REGISTRY,
        rewardTo: HOLDER,
        eligible: true,
        validUntil: T0 + 3n * DAY,
        daysLeft: 3,
        spxWei: 1_210n * 10n ** 8n,
        minSpxWei: MIN_SPX,
        isAccount: true,
        reason: null,
      }),
    ]);
    expect(first.health).toMatchObject({ eligible: true, proofValidUntil: T0 + 3n * DAY, proofDaysLeft: 3 });
    expect(first.health.attention).toContain("proof_lapsing");
    // Proving is off: nothing is built or signed.
    expect(chain.methods).not.toContain("eth_getProof");
    expect(ofType("prove_sent")).toEqual([]);
    // An hour on, the same: not said again. A day on, said again, a day less.
    chain.advance(HOUR);
    await tick();
    expect(ofType("eligibility")).toHaveLength(1);
    chain.advance(DAY - HOUR);
    await tick();
    expect(ofType("eligibility").at(-1)).toMatchObject({ eligible: true, daysLeft: 2 });
    // Lapsed: said at once, and why; and an operator who once proved is told it is no longer eligible.
    chain.advance(3n * DAY);
    const lapsed = await tick();
    expect(ofType("eligibility").at(-1)).toMatchObject({ eligible: false, daysLeft: -1, reason: "lapsed" });
    expect(lapsed.health).toMatchObject({ eligible: false, proofDaysLeft: -1 });
    expect(lapsed.health.attention).toEqual(expect.arrayContaining(["not_eligible"]));
    expect(lapsed.health.attention).not.toContain("proof_lapsing");
  });

  it("with proving on, proves rewardTo against the finalized block once its proof has five days or less left, through the nonce manager", async () => {
    const { chain, state, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true });
    chain.makeEligible(HOLDER, T0 + 6n * DAY);
    await tick();
    // Six days left: nothing to do yet.
    expect(ofType("prove_sent")).toEqual([]);
    expect(chain.methods).not.toContain("eth_getProof");
    chain.advance(DAY + 1n);
    await tick({ waitForReceiptMs: 1 });
    expect(ofType("prove_sent")).toEqual([
      expect.objectContaining({
        deployment: "v2",
        registry: REGISTRY,
        holder: HOLDER,
        provenBlock: PROVEN_BLOCK,
        // Its estimate and a fifth.
        gasLimit: 660_000n,
        maxPriorityFeePerGas: FEE_TIP_REFERENCE,
        validUntil: PROVEN_UNTIL,
      }),
    ]);
    const tx = parseTransaction(chain.sentRaw.at(-1)!);
    expect(tx.to).toBe(REGISTRY);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.data).toBe(
      encodeProve({
        holder: HOLDER,
        header: holder25999900.header.toLowerCase() as Hex,
        accountProof: holder25999900.accountProof.map((n) => n.toLowerCase() as Hex),
        storageProof: holder25999900.storageProof.map((n) => n.toLowerCase() as Hex),
      }),
    );
    expect(ofType("prove_mined")).toEqual([expect.objectContaining({ deployment: "v2", status: "success", validUntil: PROVEN_UNTIL })]);
    expect(chain.validUntil.get(HOLDER)).toBe(PROVEN_UNTIL);
    expect(state.pending).toBeNull();
    // Proven for 30 days from its block: nothing more to prove.
    chain.advance(HOUR);
    await tick();
    expect(ofType("prove_sent")).toHaveLength(1);
    expect(ofType("eligibility").at(-1)).toMatchObject({ validUntil: PROVEN_UNTIL });
  });

  it("bids a proof left unmined higher, as any other transaction, and withdraws one whose block is about to leave the registry's reach", async () => {
    const { chain, state, tick, ofType } = setup({ deployments: [V2], rewardTo: HOLDER, prove: true });
    chain.makeEligible(HOLDER, T0 + DAY);
    chain.autoMine = false;
    await tick();
    expect(state.pending).toMatchObject({ purpose: "prove", proveBlock: PROVEN_BLOCK });
    const first = parseTransaction(chain.sentRaw[0]!);
    chain.advance(120n, 10n);
    await tick();
    expect(ofType("batch_replaced")).toHaveLength(1);
    expect(parseTransaction(chain.sentRaw.at(-1)!).maxPriorityFeePerGas! * 100n >= first.maxPriorityFeePerGas! * 110n).toBe(true);
    // 7,000 blocks after the block it proves, of the 8,191 the registry can check: cancelled, for a newer proof next time.
    chain.advance(7_000n * 12n, 7_000n);
    await tick();
    expect(ofType("batch_cancel_sent")).toHaveLength(1);
    expect(parseTransaction(chain.sentRaw.at(-1)!)).toMatchObject({ to: KEEPER, gas: 21_000n });
  });

  it("withdraws a proof in flight that someone else's proof overtook, rather than bid it up for 7,000 blocks with every batch behind it", async () => {
    for (const privateSend of [true, false]) {
      const { chain, state, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true, privateSend });
      chain.makeEligible(HOLDER, T0 + DAY);
      chain.autoMine = false;
      await tick();
      expect(state.pending).toMatchObject({ purpose: "prove" });
      // Someone proves the same holder from the same block ("Prove another address"): this proof would now revert NotNewer.
      chain.validUntil.set(HOLDER, PROVEN_UNTIL);
      chain.addVault(vaultAt(1));
      chain.advance(120n, 10n);
      await tick();
      expect(ofType("prove_skipped")).toEqual([expect.objectContaining({ deployment: "v2", holder: HOLDER, reason: "not-newer" })]);
      expect(ofType("batch_replaced")).toEqual([]);
      if (privateSend) {
        // Not sent again: a private relay never includes a revert, and lets it expire.
        expect(state.pending).toMatchObject({ purpose: "prove", stoppedResending: true });
        chain.advance(12n * 25n, 25n);
        const after = await tick();
        expect(ofType("batch_abandoned")).toEqual([expect.objectContaining({ why: "expired" })]);
        // The batch behind it goes in the same tick, minutes on, not a day.
        expect(after.sent.map((sent) => sent.vaults)).toEqual([[vaultAt(1)]]);
      } else {
        // In the public pool it would land and revert at ~650,000 gas: a cancel, at 21,000.
        expect(ofType("batch_cancel_sent")).toHaveLength(1);
        expect(parseTransaction(chain.sentRaw.at(-1)!)).toMatchObject({ to: KEEPER, gas: 21_000n });
      }
    }
  });

  it("withdraws a proof in flight it may no longer sign, rather than fail every tick: proving turned off, or rewardTo another since a restart", async () => {
    for (const restart of [{ prove: false }, { rewardTo: COLD }]) {
      const { chain, state, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true });
      chain.makeEligible(HOLDER, T0 + DAY);
      chain.autoMine = false;
      await tick();
      expect(state.pending).toMatchObject({ purpose: "prove" });
      for (let i = 0; i < 3; i++) {
        chain.advance(120n, 10n);
        await expect(tick({ restart })).resolves.toBeDefined();
      }
      expect(ofType("prove_skipped")).toEqual([expect.objectContaining({ holder: HOLDER, reason: "prove" in restart ? "off" : "other-holder" })]);
      // A cancel, which is the keeper's to sign whatever it proves, bid up until it lands: never the proof again.
      expect(ofType("batch_cancel_sent")).toHaveLength(1);
      const signed = [...new Set(chain.sentRaw)];
      expect(signed.length).toBeGreaterThan(1);
      expect(signed.slice(1).every((raw) => parseTransaction(raw).to === KEEPER)).toBe(true);
    }
  });

  it("sends no proof for a day after one reverted on chain, whatever its test-run says, and says so", async () => {
    const { chain, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true });
    chain.makeEligible(HOLDER, T0 + DAY);
    // An endpoint whose test-runs pass and whose chain refuses every proof.
    chain.proveReverts = true;
    await tick({ waitForReceiptMs: 1 });
    expect(ofType("prove_mined")).toEqual([expect.objectContaining({ status: "reverted", validUntil: null })]);
    chain.advance(600n);
    const backingOff = await tick();
    expect(ofType("prove_sent")).toHaveLength(1);
    expect(backingOff.health.attention).toContain("prove_reverted");
    chain.advance(DAY - 600n);
    const again = await tick({ waitForReceiptMs: 1 });
    expect(ofType("prove_sent")).toHaveLength(2);
    expect(again.health.attention).toContain("prove_reverted");
  });

  it("sends at most one proof a day by its own clock, however an endpoint's receipts, records and clock say otherwise", async () => {
    const { chain, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true });
    let wall = Number(chain.time) * 1000;
    const wallClockMs = () => wall;
    chain.makeEligible(HOLDER, T0 + DAY);
    await tick({ waitForReceiptMs: 1, wallClockMs });
    expect(ofType("prove_mined")).toEqual([expect.objectContaining({ status: "success" })]);
    // An endpoint that lies: every proof "lands", its record never moves, and its head runs more than a day ahead each
    // tick while this machine's clock moves an accounting period and a second. A real chain would refuse each such
    // proof NotNewer, at about 650,000 gas a time: chain time and receipts are the endpoint's to say, the wall clock is
    // not. Twenty such ticks are under two hours of it.
    for (let i = 0; i < 20; i++) {
      chain.validUntil.set(HOLDER, 0n);
      chain.advance(DAY + 600n);
      wall += 301_000;
      await tick({ waitForReceiptMs: 1, wallClockMs });
    }
    expect(ofType("prove_sent")).toHaveLength(1);
    expect(ofType("prove_mined")).toHaveLength(1);
    // A day of this machine's clock after the last one, another.
    wall = Number(T0) * 1000 + Number(DAY) * 1000;
    chain.validUntil.set(HOLDER, 0n);
    chain.advance(600n);
    await tick({ waitForReceiptMs: 1, wallClockMs });
    expect(ofType("prove_sent")).toHaveLength(2);
  });

  it("keeps the day after a reverted proof by its own clock, not by the endpoint's head", async () => {
    const { chain, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true });
    let wall = Number(chain.time) * 1000;
    const wallClockMs = () => wall;
    chain.makeEligible(HOLDER, T0 + DAY);
    chain.proveReverts = true;
    await tick({ waitForReceiptMs: 1, wallClockMs });
    expect(ofType("prove_mined")).toEqual([expect.objectContaining({ status: "reverted" })]);
    // The endpoint's head two days on, ten minutes of this machine's: still backing off, and saying so.
    chain.advance(2n * DAY);
    wall += 600_000;
    const result = await tick({ waitForReceiptMs: 1, wallClockMs });
    expect(ofType("prove_sent")).toHaveLength(1);
    expect(result.health.attention).toContain("prove_reverted");
  });

  it("says once, and signs nothing, when it cannot make a proof: eth_getProof refused, too little SPX, a header that does not hash, a contract, or one as new already there", async () => {
    const skipped = async (arrange: (chain: FakeChain) => void) => {
      const { chain, tick, ofType } = setup({ deployments: [V1, V2], rewardTo: HOLDER, prove: true });
      chain.makeEligible(HOLDER, T0 + DAY);
      arrange(chain);
      await tick();
      // An accounting period on, it tries again, and says no more.
      chain.advance(600n);
      await tick();
      expect(ofType("prove_sent")).toEqual([]);
      expect(chain.methods).not.toContain("eth_sendRawTransaction");
      const skips = ofType("prove_skipped");
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ deployment: "v2", holder: HOLDER });
      return skips[0]!.reason;
    };
    expect(await skipped((c) => (c.proof = "refused"))).toBe("unsupported");
    expect(await skipped((c) => (c.proof = { value: MIN_SPX - 1n }))).toBe("below-min-spx");
    expect(await skipped((c) => (c.finalized = { ...(block25999900 as unknown as RpcBlockHeader), hash: `0x${"00".repeat(32)}` }))).toBe("header-mismatch");
    expect(await skipped((c) => c.accounts.delete(HOLDER))).toBe("contract");
    // Proven already, by anyone, as far as this proof would take it: no NotNewer is ever sent.
    expect(
      await skipped((c) => {
        c.makeEligible(HOLDER, PROVEN_UNTIL);
        c.advance(PROVEN_UNTIL - c.time - DAY);
      }),
    ).toBe("not-newer");
  });
});

describe("runway", () => {
  it("warns once when the key's ether covers fewer days than minRunwayDays at its last week's spend, and clears when topped up", async () => {
    const { chain, state, tick, ofType } = setup();
    // A keeper that has run for a week: 0.01 ETH spent in it, 0.005 left: three and a half days.
    state.spendSince = T0 - 7n * DAY;
    state.spend.push([T0 - DAY, 10n ** 16n]);
    chain.keeperBalance = 5n * 10n ** 15n;
    const first = await tick();
    expect(first.health.runwayDays).toBe(3.5);
    expect(first.health.attention).toContain("low_runway");
    expect(ofType("low_runway")).toEqual([expect.objectContaining({ runwayDays: 3.5, thresholdDays: 7, etherWei: 5n * 10n ** 15n, spentWeekWei: 10n ** 16n })]);
    chain.advance(60n);
    await tick();
    expect(ofType("low_runway")).toHaveLength(1);
    chain.keeperBalance = ETHER;
    chain.advance(300n);
    const topped = await tick();
    expect(topped.health.attention).not.toContain("low_runway");
    expect(state.lowRunway).toBe(false);

    // 0 days: never warns.
    const off = setup({ policy: { minRunwayDays: 0 } });
    off.state.spendSince = T0 - 7n * DAY;
    off.state.spend.push([T0 - DAY, 10n ** 16n]);
    off.chain.keeperBalance = 10n ** 15n;
    expect((await off.tick()).health.attention).not.toContain("low_runway");
    expect(off.ofType("low_runway")).toEqual([]);
  });

  it("measures runway over the time its spend covers: a keeper a day old has not spent a day's worth in a week, and one younger can't say", async () => {
    // Started a day ago, 0.001 ETH spent since, 0.005 left: five days, not the thirty-five a week's division would say.
    const young = setup();
    young.state.spend.push([T0 - HOUR, 10n ** 15n]);
    young.chain.keeperBalance = 5n * 10n ** 15n;
    const started = await young.tick();
    expect(young.state.spendSince).toBe(T0);
    // Its first tick: an hour's spend, which says nothing yet of a day's.
    expect(started.health.runwayDays).toBeNull();
    young.chain.advance(DAY - HOUR);
    const dayOld = await young.tick();
    expect(dayOld.health.runwayDays).toBe(5);
    expect(dayOld.health.attention).toContain("low_runway");
    expect(young.ofType("low_runway")).toEqual([expect.objectContaining({ runwayDays: 5, thresholdDays: 7 })]);
    // Past a week, the week alone.
    young.chain.advance(7n * DAY);
    young.state.spend.push([young.chain.time - DAY, 10n ** 15n]);
    expect((await young.tick()).health.runwayDays).toBe(35);
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
    expect(decodeFunctionData({ abi: V1_BATCHER_ABI, data: parseTransaction(chain.sentRaw.at(-1)!).data! }).args![0]).toHaveLength(2);
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
    // A release listed for a chain where its factory is not.
    const elsewhere: Deployment = { ...V2, factory: "0x00000000000000000000000000000000000000f0", batcher: "0x00000000000000000000000000000000000000b0" };
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
  for (const type of [
    "vault_found",
    "batch_sent",
    "batch_mined",
    "skip",
    "skip_cleared",
    "wait",
    "trapped",
    "untrapped",
    "window_missed",
    "batch_replaced",
    "batch_cancel_sent",
    "batch_cancelled",
    "batch_abandoned",
    "overtaken",
    "vault_retired",
    "error",
    "unwrap_sent",
    "batcher_deployed",
    "low_balance",
    "sync",
    "eligibility",
    "prove_sent",
    "prove_mined",
    "prove_skipped",
    "low_runway",
  ]) {
    expect(types, type).toContain(type);
  }
  expect(ALL_RECORDS.some((r) => r.type === "skip" && r.code === "holders-first")).toBe(true);
  expect(ALL_RECORDS.some((r) => r.type === "wait" && r.reason === "holders-first")).toBe(true);
});
