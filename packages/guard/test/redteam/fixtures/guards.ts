/**
 * Every Guard path that simulates, with one honest plan each and the logs an
 * honest simulation of it shows: what the second-opinion tests run through
 * each Guard class the Engine builds (apps/web/src/lib/engine.ts).
 *
 * The plans and logs are the ones the per-Guard red-team files start from
 * (attacks, tips, tips-permit2, budget, schedule, vault, vault-batch), kept
 * small: each path here only has to come back `verified` when both services
 * agree, so that what changes it is the second opinion alone.
 */

import {
  NATIVE,
  NATIVE_AMOUNT_IN,
  NATIVE_HONEST_OUT,
  NATIVE_MIN_OUT,
  NOW,
  ROUTER,
  SPX,
  USER,
  WETH,
  addressTopic,
  approvalLog,
  honestIntent,
  honestManifest,
  honestPlan,
  nativeIntent,
  nativePlan,
  transferLog,
  uint256Data,
  AMOUNT_IN,
  HONEST_OUT,
} from "@spdex/testing";
import {
  MAX_UINT256,
  PERMIT2_ADDRESS,
  PERMIT2_CODE_HASH,
  encodePermit2Approval,
  encodePermit2BatchTransfer,
  encodeTipTransfer,
  type Address,
  type DcaPlan,
  type GuardVerdict,
  type Hex,
  type TipIntent,
  type TipPermissionPlan,
  type TipPlan,
} from "@spdex/core";
import type { SimLog, SimulationProvider } from "@spdex/chain";
import {
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  buyFee,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  predictVault,
  termsOfPlan,
  type VaultPlan,
  type VaultTerms,
} from "@spdex/vault";
import { Guard, type GuardInput } from "../../../src/guard.js";
import { ScheduledBuyGuard } from "../../../src/schedule.js";
import { TipGuard, type TipGuardOptions } from "../../../src/tips.js";
import { VaultGuard, type VaultClaim, type VaultTxPlan } from "../../../src/vault.js";
import { batchPlan, honestBatchLogs } from "./batch.js";

/** The Guard classes the Engine constructs, by name as `new …(` spells them. */
export type GuardClass = "Guard" | "TipGuard" | "ScheduledBuyGuard" | "VaultGuard";

export interface GuardPath {
  name: string;
  guard: GuardClass;
  /** What an honest simulation of the path's plan shows. */
  logs: () => SimLog[];
  /** The path's honest check, through `provider`. */
  check: (provider: SimulationProvider, requireSimulation: boolean) => Promise<GuardVerdict>;
  /**
   * What the verdict becomes when the second service doesn't answer and
   * `requireSimulation` is off: `unverified`, or `rejected` on the paths that
   * never sign unchecked. Never `verified`.
   */
  unavailable: "unverified" | "rejected";
}

// ── A swap ──

const swapInput = (): GuardInput => ({
  plan: honestPlan(),
  expectedIntent: honestIntent(),
  manifest: honestManifest(),
  extraTrustedContracts: [],
  nowSeconds: NOW,
});
const swapLogs = (): SimLog[] => [transferLog(SPX, USER, ROUTER, AMOUNT_IN), transferLog(WETH, ROUTER, USER, HONEST_OUT)];

// ── Tips ──

const RECIPIENT = "0x4444444444444444444444444444444444444444" as const;
const SECOND = "0x5555555555555555555555555555555555555555" as const;
const DELIVERED = 10_000n * 10n ** 8n;
const EACH = (DELIVERED * 25n) / 10_000n;
const TIP_NOW = 1_790_000_000;

const TIP_OPTIONS = (requireSimulation: boolean): TipGuardOptions => ({
  chainId: 1,
  requireSimulation,
  now: () => TIP_NOW,
  permit2CodeHash: async () => PERMIT2_CODE_HASH,
  permit2Allowance: async () => MAX_UINT256,
});

function tipIntent(recipients: readonly Address[]): TipIntent {
  return {
    version: 1,
    chainId: 1,
    account: USER,
    token: SPX,
    deliveredAmount: DELIVERED,
    transfers: recipients.map((recipient, i) => ({ recipient, amount: EACH, label: `Placeholder ${i}` })),
    nonce: "0xdeadbeefdeadbeefdeadbeefdeadbeef",
  };
}
const oneTip = (): TipPlan => ({
  version: 1,
  intent: tipIntent([RECIPIENT]),
  calls: [{ to: SPX, data: encodeTipTransfer(RECIPIENT, EACH), value: 0n }],
});
const permit = { nonce: (7n << 8n) | 3n, deadline: BigInt(TIP_NOW + 20 * 60), signature: `0x${"ab".repeat(64)}1b` as Hex };
const batchedTips = (): TipPlan => {
  const intent = tipIntent([RECIPIENT, SECOND]);
  return {
    version: 1,
    intent,
    mode: "permit2-batch",
    permit: { ...permit },
    calls: [{ to: PERMIT2_ADDRESS, data: encodePermit2BatchTransfer(intent, permit), value: 0n }],
  };
};
const permission = (kind: "grant" | "revoke"): TipPermissionPlan => ({
  version: 1,
  kind,
  chainId: 1,
  account: USER,
  token: SPX,
  ...(kind === "grant" ? { tip: tipIntent([RECIPIENT, SECOND]) } : {}),
  call: { to: SPX, data: encodePermit2Approval(kind), value: 0n },
});

// ── A scheduled buy ──

const INTERVAL = 3_600;
const SLOT = 3;
const scheduledBuy = () => {
  const plan: DcaPlan = {
    id: "eth-to-spx",
    paused: false,
    chainId: 1,
    sell: NATIVE,
    buy: SPX,
    amountPerBuy: NATIVE_AMOUNT_IN.toString(),
    intervalSeconds: INTERVAL,
    maxBuys: 10,
    startAt: Number(NOW) - SLOT * INTERVAL - 60,
    signer: "wallet",
  };
  const intent = nativeIntent({ maxAmountIn: NATIVE_AMOUNT_IN, minAmountOut: NATIVE_MIN_OUT });
  const leg: GuardInput = {
    plan: nativePlan({ intent, calls: [{ to: ROUTER, data: "0xdeadbeef", value: NATIVE_AMOUNT_IN }] }),
    expectedIntent: intent,
    manifest: honestManifest(),
    extraTrustedContracts: [],
    nowSeconds: NOW,
  };
  return {
    plan,
    progress: { planId: plan.id, chainId: 1, owner: USER, signer: USER, buysDone: 3, committed: 3n * NATIVE_AMOUNT_IN, lastSlot: 2 },
    slot: SLOT,
    legs: [leg],
    chainId: 1,
    nowSeconds: NOW,
  };
};
const scheduledLogs = (): SimLog[] => [transferLog(NATIVE, USER, ROUTER, NATIVE_AMOUNT_IN), transferLog(SPX, ROUTER, USER, NATIVE_HONEST_OUT)];

// ── The vault's own transactions (as vault.test.ts lays them out) ──

const AMOUNT = 10n ** 16n;
const REWARD = buyFee(AMOUNT).reward;
const PER_BUY = AMOUNT + REWARD;
const TERMS: VaultPlan = {
  marketIndex: 0n,
  amountPerBuy: AMOUNT,
  interval: 3_600n,
  maxBuys: 3n,
  startAt: NOW,
  keeperReward: REWARD,
  maxSlippageBps: 300n,
};
const VAULT_TERMS: VaultTerms = termsOfPlan(TERMS);
const VAULT = predictVault({ factory: MAINNET_FACTORY, owner: USER, nonce: 0n, terms: VAULT_TERMS });
const PAIR = MAINNET_DEPLOYMENT.markets[0].pair;
const OUT = 4_877_097_969n;
const FLOOR = 4_800_000_000n;

const TOPIC = {
  created: "0xb888b71d90fcdc2e1651a455bddf729f7b1b568ec746d390afa2c35ac599e961",
  bought: "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6",
  deposit: "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
  withdrawal: "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
} as const satisfies Record<string, Hex>;

const words = (...values: (bigint | Address)[]): Hex =>
  `0x${values.map((v) => (typeof v === "bigint" ? uint256Data(v).slice(2) : addressTopic(v).slice(2))).join("")}` as Hex;

const vaultPlan = (overrides: Partial<DcaPlan> = {}): DcaPlan => ({
  id: "dca-vault",
  paused: true,
  chainId: 1,
  sell: NATIVE,
  buy: SPX,
  amountPerBuy: AMOUNT.toString(),
  intervalSeconds: 3_600,
  maxBuys: 3,
  startAt: Number(NOW),
  signer: "vault",
  ...overrides,
});
const claim = (): VaultClaim => ({ address: VAULT, owner: USER, nonce: 0n, terms: { ...VAULT_TERMS } });

const createPlan = (value: bigint): VaultTxPlan => ({
  version: 1,
  intent: { version: 1, action: "create", chainId: 1, account: USER, plan: vaultPlan(), terms: { ...TERMS }, nonce: 0n, nowSeconds: NOW },
  calls: [{ to: MAINNET_FACTORY, data: encodeCreateVault(TERMS), value }],
});
const createdLog = (funded: bigint): SimLog => {
  const t = VAULT_TERMS;
  return {
    address: MAINNET_FACTORY,
    topics: [TOPIC.created, addressTopic(USER), addressTopic(VAULT)],
    data: words(0n, t.tokenOut, t.pair, t.oraclePool, t.amountPerBuy, t.interval, t.maxBuys, t.startAt, t.keeperReward, t.maxSlippageBps, funded),
  };
};
const createLogs = (value: bigint): SimLog[] =>
  value === 0n
    ? [createdLog(0n)]
    : [
        transferLog(NATIVE, USER, MAINNET_FACTORY, value),
        createdLog(value),
        transferLog(NATIVE, MAINNET_FACTORY, WETH, value),
        { address: WETH, topics: [TOPIC.deposit, addressTopic(MAINNET_FACTORY)], data: words(value) },
        transferLog(WETH, MAINNET_FACTORY, VAULT, value),
      ];

const HELD = PER_BUY;
const ROOM = 3n * PER_BUY - HELD;
const fundPlan = (): VaultTxPlan => ({
  version: 1,
  intent: { version: 1, action: "fund", chainId: 1, account: USER, plan: vaultPlan({ vault: VAULT }), vault: claim(), buysDone: 0n, wethBalance: HELD },
  calls: [{ to: VAULT, data: encodeFund(), value: ROOM }],
});
const fundLogs = (): SimLog[] => [
  transferLog(NATIVE, USER, VAULT, ROOM),
  transferLog(NATIVE, VAULT, WETH, ROOM),
  { address: WETH, topics: [TOPIC.deposit, addressTopic(VAULT)], data: words(ROOM) },
];

const closePlan = (): VaultTxPlan => ({
  version: 1,
  intent: { version: 1, action: "close", chainId: 1, account: USER, plan: vaultPlan({ vault: VAULT }), vault: claim() },
  calls: [{ to: VAULT, data: encodeClose(), value: 0n }],
});
const LEFT = 2n * PER_BUY;
const closeLogs = (): SimLog[] => [
  transferLog(NATIVE, WETH, VAULT, LEFT),
  { address: WETH, topics: [TOPIC.withdrawal, addressTopic(VAULT)], data: words(LEFT) },
  transferLog(NATIVE, VAULT, USER, LEFT),
];

const triggerPlan = (): VaultTxPlan => ({
  version: 1,
  intent: { version: 1, action: "trigger", chainId: 1, account: USER, plan: vaultPlan({ vault: VAULT }), vault: claim(), floorOut: FLOOR },
  calls: [{ to: VAULT, data: encodeExecute(), value: 0n }],
});
const triggerLogs = (): SimLog[] => [
  transferLog(WETH, VAULT, PAIR, AMOUNT),
  transferLog(SPX, PAIR, USER, OUT),
  transferLog(WETH, VAULT, USER, REWARD),
  {
    address: VAULT,
    topics: [TOPIC.bought, uint256Data(0n), addressTopic(USER)],
    data: words(AMOUNT, OUT, REWARD, FLOOR, 1n, 20n * 10n ** 18n),
  },
];

// ── Every path ──

const swapOptions = (requireSimulation: boolean) => ({ chainId: 1, requireSimulation, oracleDivergenceBps: 200 });
const vaultOptions = (requireSimulation: boolean) => ({ chainId: 1, requireSimulation });

export const GUARD_PATHS: readonly GuardPath[] = [
  {
    name: "Guard.check (a swap)",
    guard: "Guard",
    logs: swapLogs,
    check: (provider, requireSimulation) => new Guard(provider, swapOptions(requireSimulation)).check(swapInput()),
    unavailable: "unverified",
  },
  {
    name: "TipGuard.check (one tip)",
    guard: "TipGuard",
    logs: () => [transferLog(SPX, USER, RECIPIENT, EACH)],
    check: (provider, requireSimulation) => new TipGuard(provider, TIP_OPTIONS(requireSimulation)).check(oneTip()),
    unavailable: "unverified",
  },
  {
    name: "TipGuard.check (tips batched through Permit2)",
    guard: "TipGuard",
    logs: () => [transferLog(SPX, USER, RECIPIENT, EACH), transferLog(SPX, USER, SECOND, EACH)],
    check: (provider, requireSimulation) => new TipGuard(provider, TIP_OPTIONS(requireSimulation)).check(batchedTips()),
    unavailable: "unverified",
  },
  {
    name: "TipGuard.checkPermission (a grant)",
    guard: "TipGuard",
    logs: () => [approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256)],
    check: (provider, requireSimulation) => new TipGuard(provider, TIP_OPTIONS(requireSimulation)).checkPermission(permission("grant")),
    // A standing permission is never asked for untested, nor on one service's word.
    unavailable: "rejected",
  },
  {
    name: "TipGuard.checkPermission (a revoke)",
    guard: "TipGuard",
    logs: () => [approvalLog(SPX, USER, PERMIT2_ADDRESS, 0n)],
    check: (provider, requireSimulation) => new TipGuard(provider, TIP_OPTIONS(requireSimulation)).checkPermission(permission("revoke")),
    unavailable: "unverified",
  },
  {
    name: "ScheduledBuyGuard.check (a scheduled buy)",
    guard: "ScheduledBuyGuard",
    logs: scheduledLogs,
    check: (provider, requireSimulation) =>
      new ScheduledBuyGuard(new Guard(provider, swapOptions(requireSimulation))).check(scheduledBuy()),
    // Nobody reads a banner when an auto-buy runs.
    unavailable: "rejected",
  },
  {
    name: "VaultGuard.check (a creation that sends ether)",
    guard: "VaultGuard",
    logs: () => createLogs(PER_BUY),
    check: (provider, requireSimulation) => new VaultGuard(provider, vaultOptions(requireSimulation)).check(createPlan(PER_BUY)),
    unavailable: "rejected",
  },
  {
    name: "VaultGuard.check (a creation that sends none)",
    guard: "VaultGuard",
    logs: () => createLogs(0n),
    check: (provider, requireSimulation) => new VaultGuard(provider, vaultOptions(requireSimulation)).check(createPlan(0n)),
    unavailable: "unverified",
  },
  {
    name: "VaultGuard.check (a funding)",
    guard: "VaultGuard",
    logs: fundLogs,
    check: (provider, requireSimulation) => new VaultGuard(provider, vaultOptions(requireSimulation)).check(fundPlan()),
    unavailable: "rejected",
  },
  {
    name: "VaultGuard.check (closing)",
    guard: "VaultGuard",
    logs: closeLogs,
    check: (provider, requireSimulation) => new VaultGuard(provider, vaultOptions(requireSimulation)).check(closePlan()),
    unavailable: "unverified",
  },
  {
    name: "VaultGuard.check (a buy the owner triggers)",
    guard: "VaultGuard",
    logs: triggerLogs,
    check: (provider, requireSimulation) => new VaultGuard(provider, vaultOptions(requireSimulation)).check(triggerPlan()),
    unavailable: "unverified",
  },
  {
    name: "VaultGuard.check (a batch for other people's vaults)",
    guard: "VaultGuard",
    logs: honestBatchLogs,
    check: (provider, requireSimulation) => new VaultGuard(provider, vaultOptions(requireSimulation)).check(batchPlan()),
    unavailable: "rejected",
  },
];
