/**
 * Vault plans in the app: every pure piece of vault.ts, pinned — chain time,
 * the terms and what they cost, whether a vault can be offered, what a read
 * of a vault means for its card, the four transactions (each checked against
 * the vault Guard's own static layer, so the builders and the Guard cannot
 * drift apart), sending, the history's narrowing and its honesty about what
 * it did not find, and the record of a creation under way.
 *
 * Nothing here touches a network: every endpoint is a script. What the chain
 * actually says about a vault is `test/integration/vault.test.ts`'s to prove.
 */

import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOKEN, TOKENS, type JsonRpc, type PreparedFees } from "@spdex/chain";
import type { Address, DcaPlan, GuardVerdict, Hex, SpdexConfig } from "@spdex/core";
import { addDcaPlan, recommendedConfig, updateDcaPlan } from "@spdex/config";
import { runVaultChecks } from "@spdex/guard";
import {
  DEPLOYMENTS,
  MAINNET_DEPLOYMENT,
  batcherAddress,
  buyFee,
  decodeVaultEvent,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  factoryAddress,
  predictVault,
  termsOfPlan,
  VAULT_LOGS_FROM_BLOCK,
  type VaultAvailability,
  type VaultState,
  type VaultTerms,
} from "@spdex/vault";
import type { TxSender } from "../execute.js";
import { removedPlanCount } from "./view.js";
import {
  CREATION_GRACE_MS,
  DEFAULT_VAULT_SLIPPAGE_BPS,
  MIN_VAULT_BUY_WEI,
  VAULT_EVENT_TOPICS,
  VAULT_GAS,
  VaultDrafts,
  VaultTxRefused,
  chainNow,
  closeVaultTx,
  createVaultTx,
  feePerGasNow,
  fundVaultTx,
  readChainClock,
  readVaultHistory,
  readVaultPlan,
  readVaultSupport,
  revertText,
  sendVaultTx,
  vaultCheckNote,
  settleCreation,
  triggerVaultTx,
  vaultCardStatus,
  vaultClaim,
  deviceTimeOf,
  vaultAverageStat,
  vaultBoughtStat,
  vaultCosts,
  vaultDeployment,
  vaultHistorySentence,
  vaultNextBuyStat,
  vaultProgress,
  vaultErrorText,
  vaultPlanOf,
  vaultPlanProblems,
  vaultPlanState,
  vaultRemovalWarning,
  vaultRetryTerms,
  vaultStartAt,
  vaultSupportFrom,
  keepVaultPlans,
  createVault,
  closedAndEmpty,
  foundFromPlan,
  mergeVaultSearches,
  withListSearch,
  planFromVault,
  readFoundVault,
  searchAccountVaults,
  strayVaultList,
  vaultPlanId,
  provenVaults,
  vaultSearchFailed,
  vaultSearchNote,
  vaultSearchRetryAt,
  VAULT_SEARCH_RETRY_MS,
  type FoundVault,
  type VaultCreation,
  type VaultPlanState,
} from "./vault.js";

const CHAIN = 690069;
const ETHER = 10n ** 18n;
const GWEI = 10n ** 9n;
const SPX = TOKENS.SPX.address;
const FACTORY = factoryAddress(MAINNET_DEPLOYMENT);
const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const STRANGER = "0x00000000000000000000000000000000000000b2" as Address;
const MARKET = MAINNET_DEPLOYMENT.markets[0]!;
const AMOUNT = ETHER / 100n;
/** This release's buy fee for AMOUNT (`buyFee`): 122,000 gas at 0.15 gwei and a tenth more, 0.21% of the buy. */
const REWARD = 20_130_000_000_000n;
const START = 1_000_000;

const TERMS: VaultTerms = {
  tokenOut: MARKET.tokenOut,
  pair: MARKET.pair,
  oraclePool: MARKET.oraclePool,
  amountPerBuy: AMOUNT,
  interval: 3_600n,
  maxBuys: 5n,
  startAt: BigInt(START),
  keeperReward: REWARD,
  maxSlippageBps: 200n,
};
const NONCE = 3n;
const VAULT = predictVault({ factory: FACTORY, owner: OWNER, nonce: NONCE, terms: TERMS });

const PLAN: DcaPlan = {
  id: "dca-vault",
  paused: true,
  chainId: CHAIN,
  sell: NATIVE_TOKEN,
  buy: SPX,
  amountPerBuy: AMOUNT.toString(),
  intervalSeconds: 3_600,
  maxBuys: 5,
  startAt: START,
  signer: "vault",
  vault: VAULT,
};
const { vault: _none, ...UNCREATED } = PLAN;

/** A vault two buys in, funded for the other three, waiting for its next window. */
function state(overrides: Partial<Omit<VaultState, "status">> & { status?: Partial<VaultState["status"]> } = {}): VaultState {
  const { status, ...rest } = overrides;
  return {
    address: VAULT,
    owner: OWNER,
    terms: TERMS,
    closed: false,
    buysDone: 2n,
    totalOut: 123_456n,
    totalRewards: 2n * REWARD,
    quote: { spotOut: 1_000n, floorOut: 900n, oracleDepth: 20n * ETHER },
    fromFactory: true,
    chainTime: 1_005_000n,
    ...rest,
    status: { due: false, nextBuyAt: 1_007_200n, buysLeft: 3n, wethBalance: 3n * (AMOUNT + REWARD), funded: true, ...status },
  };
}

/** Due now by the vault's own clock, the price inside the floor: a trigger would buy. */
const dueNow = (overrides: Parameters<typeof state>[0] = {}) =>
  state({ ...overrides, status: { due: true, nextBuyAt: 1_004_000n, ...overrides.status } });

const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** A JSON-RPC endpoint from a table of methods; anything unlisted throws, as an endpoint without it would. */
function scripted(handlers: Record<string, (params: unknown[]) => unknown>): JsonRpc & { calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`the method ${method} does not exist`);
    return handler(params);
  }) as JsonRpc & { calls: typeof calls };
  rpc.calls = calls;
  return rpc;
}

describe("where vaults are offered", () => {
  it("offers mainnet's factory on Ethereum and the local fork, and nowhere else", () => {
    expect(vaultDeployment(1)).toBe(MAINNET_DEPLOYMENT);
    expect(vaultDeployment(CHAIN)).toBe(MAINNET_DEPLOYMENT);
    expect(vaultDeployment(11155111)).toBeNull();
  });
});

describe("chain time", () => {
  it("reads the latest block's timestamp where there is no pending one, and refuses an answer without either", async () => {
    const rpc = scripted({ eth_getBlockByNumber: ([tag]) => (tag === "pending" ? null : { timestamp: "0xf4240" }) });
    expect(await readChainClock(rpc, 5_000)).toEqual({ seconds: 1_000_000, readAtMs: 5_000 });
    const refused = scripted({
      eth_getBlockByNumber: ([tag]) => {
        if (tag === "pending") throw new Error("pending is not supported");
        return { timestamp: "0xf4240" };
      },
    });
    expect((await readChainClock(refused, 5_000)).seconds).toBe(1_000_000);
    await expect(readChainClock(scripted({ eth_getBlockByNumber: () => ({}) }))).rejects.toThrow(/chain's time/);
  });

  /**
   * On an idle chain the latest block is stamped when it was made, minutes
   * ago on the local fork (the reviewers measured 362 s), and the next block
   * will carry the time it is made. A start of "latest + 5 minutes" was then
   * due the moment its vault was mined. The pending block's time is what the
   * next block would get now.
   */
  it("prefers the pending block's timestamp, which an idle chain's latest block runs behind", async () => {
    const latest = 1_789_761_832;
    const pending = latest + 362;
    const rpc = scripted({
      eth_getBlockByNumber: ([tag]) => ({ timestamp: `0x${(tag === "pending" ? pending : latest).toString(16)}` }),
    });
    const clock = await readChainClock(rpc, 5_000);
    expect(clock.seconds).toBe(pending);
    // "In 5 minutes" is five minutes after the next block, not after the last one.
    expect(vaultStartAt(1_300, 1_000, clock.seconds)).toBe(pending + 300);
    // A pending block behind the latest is a stale view, not the chain's time.
    const stale = scripted({
      eth_getBlockByNumber: ([tag]) => ({ timestamp: `0x${(tag === "pending" ? latest - 50 : latest).toString(16)}` }),
    });
    expect((await readChainClock(stale)).seconds).toBe(latest);
  });

  it("carries the chain's clock forward by the time elapsed here, never backwards", () => {
    const clock = { seconds: 1_000_000, readAtMs: 50_000 };
    expect(chainNow(clock, 50_000)).toBe(1_000_000);
    expect(chainNow(clock, 110_900)).toBe(1_000_060);
    // A device clock set back after the read is not a chain going backwards.
    expect(chainNow(clock, 10_000)).toBe(1_000_000);
  });

  it("puts a vault's start in chain time: now is the chain's now, and a later start keeps its distance", () => {
    // The device is five days ahead of the chain, as the local fork is.
    const device = 1_790_000_000;
    const chain = device - 5 * 86_400;
    expect(vaultStartAt(device, device, chain)).toBe(chain);
    expect(vaultStartAt(device + 3_600, device, chain)).toBe(chain + 3_600);
    expect(vaultStartAt(device - 60, device, chain)).toBe(chain);
  });
});

describe("the terms a vault is created with", () => {
  const choices = { maxSlippageBps: DEFAULT_VAULT_SLIPPAGE_BPS, keeperReward: REWARD };

  it("are the plan's figures, the one market, and the two choices a plan has no field for", () => {
    expect(vaultPlanOf(PLAN, choices)).toEqual({
      marketIndex: 0n,
      amountPerBuy: AMOUNT,
      interval: 3_600n,
      maxBuys: 5n,
      startAt: BigInt(START),
      keeperReward: REWARD,
      maxSlippageBps: 200n,
    });
    expect(termsOfPlan(vaultPlanOf(PLAN, choices))).toEqual(TERMS);
  });

  it("find nothing wrong with a plan the factory would take", () => {
    expect(vaultPlanProblems(PLAN, choices, START)).toEqual([]);
  });

  it("say what the factory would refuse, in words that say what to change", () => {
    expect(vaultPlanProblems({ ...PLAN, sell: TOKENS.WETH.address }, choices, START)).toContain("A vault pays with ETH only.");
    expect(vaultPlanProblems({ ...PLAN, buy: TOKENS.USDC.address }, choices, START)).toContain("A vault buys SPX only.");
    expect(vaultPlanProblems({ ...PLAN, amountPerBuy: (ETHER / 5n).toString() }, choices, START)).toEqual([
      "You can put at most 0.5 ETH into a vault: every buy plus its buy fee. Buy less each time, or fewer times.",
    ]);
    // One wei past 0.69% of the buy, the network cost included: the factory's limit, and so the app's.
    expect(vaultPlanProblems(PLAN, { ...choices, keeperReward: (AMOUNT * 69n) / 10_000n }, START)).toEqual([]);
    expect(vaultPlanProblems(PLAN, { ...choices, keeperReward: (AMOUNT * 69n) / 10_000n + 1n }, START)).toEqual([
      "The buy fee can be at most 0.69% of the buy.",
    ]);
    expect(vaultPlanProblems(PLAN, { ...choices, maxSlippageBps: 600 }, START)).toEqual([
      "The price allowance must be more than 0% and at most 5%.",
    ]);
    // Judged against chain time: two years on, the same start is refused.
    expect(vaultPlanProblems(PLAN, choices, START + 2 * 366 * 86_400)).toEqual(["The first buy must be within a year of now."]);
  });
});

describe("what a vault costs", () => {
  const eip1559: PreparedFees = { type: "eip1559", maxFeePerGas: 2n * 3n * GWEI + GWEI, maxPriorityFeePerGas: GWEI };

  it("prices gas at what a block charges now, base fee plus tip", () => {
    expect(feePerGasNow(eip1559)).toBe(4n * GWEI);
    expect(feePerGasNow({ type: "legacy", gasPrice: 7n * GWEI })).toBe(7n * GWEI);
  });

  it("charges this release's buy fee, and the budget as the factory counts it", () => {
    const costs = vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 10, fees: eip1559 })!;
    expect(costs.fee).toEqual(buyFee(AMOUNT));
    expect(costs.fee.reward).toBe(REWARD);
    expect(costs.rewardsTotal).toBe(10n * REWARD);
    expect(costs.budget).toBe(10n * (AMOUNT + REWARD));
    expect(costs.createFee).toBe(VAULT_GAS.createAndFund * 4n * GWEI);
  });

  /** The buy fee depends on the amount and the release, never on the moment: only the creation's gas waits for fees. */
  it("knows the buy fee and the budget before any fee is read", () => {
    const unread = vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 10, fees: null })!;
    const read = vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 10, fees: eip1559 })!;
    expect(unread).toEqual({ ...read, createFee: null });
    const dear = vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 10, fees: { type: "legacy", gasPrice: 200n * GWEI } })!;
    expect(dear.fee).toEqual(read.fee);
  });

  it("holds a small buy's fee at 0.69%, and says it did", () => {
    const costs = vaultCosts({ amountPerBuy: 10n ** 15n, maxBuys: 3, fees: eip1559 })!;
    expect(costs.fee).toMatchObject({ reward: 6_900_000_000_000n, atCeiling: true, shareBps: 69 });
  });

  it("has no figures before there is a plan to cost", () => {
    expect(vaultCosts({ amountPerBuy: 0n, maxBuys: 10, fees: eip1559 })).toBeNull();
    expect(vaultCosts({ amountPerBuy: AMOUNT, maxBuys: 0, fees: eip1559 })).toBeNull();
  });

  it("refuses a buy too small to pay a buy fee, before the factory would take it", () => {
    const choices = { maxSlippageBps: DEFAULT_VAULT_SLIPPAGE_BPS, keeperReward: 0n };
    const small = { ...PLAN, amountPerBuy: (MIN_VAULT_BUY_WEI - 1n).toString() };
    expect(vaultPlanProblems(small, choices, START)).toEqual(["Each buy must be at least 0.000001 ETH so it can pay a buy fee."]);
    expect(vaultPlanProblems({ ...PLAN, amountPerBuy: MIN_VAULT_BUY_WEI.toString() }, choices, START)).toEqual([]);
    // Nothing at all is the factory's own refusal, in its words.
    expect(vaultPlanProblems({ ...PLAN, amountPerBuy: "0" }, choices, START)).toEqual(["Each buy must be more than 0 and at most 0.5 ETH."]);
  });
});

describe("whether a vault can be offered", () => {
  const availability = (overrides: Partial<VaultAvailability> = {}): VaultAvailability => ({
    available: true,
    factory: FACTORY,
    factoryDeployed: true,
    factoryDeployable: null,
    market: { index: 0, ...MARKET },
    marketHealthy: true,
    oracleDepth: 20n * ETHER,
    marketGapBps: 10n,
    reasons: [],
    ...overrides,
  });

  it("is available when the factory is there and its market healthy", () => {
    expect(vaultSupportFrom(CHAIN, availability())).toMatchObject({ kind: "available", factory: FACTORY });
  });

  it("offers the factory's deployment when it is absent and its deployment would succeed", () => {
    const support = vaultSupportFrom(
      CHAIN,
      availability({
        available: false,
        factoryDeployed: false,
        factoryDeployable: true,
        reasons: ["the vault factory is not deployed on this chain yet; deploying it is one transaction anyone can send"],
      }),
    );
    expect(support).toMatchObject({
      kind: "deployable",
      reason: "The vault factory is not deployed on this chain yet; deploying it is one transaction anyone can send.",
    });
  });

  it("says why when something else is in the way", () => {
    const support = vaultSupportFrom(
      CHAIN,
      availability({ available: false, marketHealthy: false, reasons: ["the market's v2 pair holds no liquidity"] }),
    );
    expect(support).toEqual(expect.objectContaining({ kind: "unavailable", reason: "The market's v2 pair holds no liquidity." }));
    expect(
      vaultSupportFrom(CHAIN, availability({ available: false, factoryDeployed: false, factoryDeployable: false, reasons: ["refused"] })).kind,
    ).toBe("unavailable");
  });

  it("refuses a chain vaults aren't offered on without asking its endpoint anything", async () => {
    const rpc = scripted({});
    expect(await readVaultSupport(rpc, 11155111)).toEqual({
      kind: "unsupported",
      reason: "Vaults aren't offered on Sepolia test network (chain 11155111): spDEX's vault factory buys on Ethereum's SPX market only.",
    });
    expect(rpc.calls).toEqual([]);
  });

  it("offers the deployment on a chain where the factory's address has no code, having simulated it", async () => {
    // The factory's address answers with no code; the plain creation that
    // `simulateFactoryDeployment` runs succeeds; the market read fails.
    const rpc = scripted({
      eth_getCode: () => "0x",
      eth_call: (params) => {
        const call = params[0] as { to?: string };
        if (call.to === undefined) return "0x6080";
        throw new Error("upstream unavailable");
      },
    });
    const support = await readVaultSupport(rpc, CHAIN);
    expect(support.kind).toBe("deployable");
    if (support.kind !== "deployable") return;
    expect(support.factory).toBe(FACTORY);
    expect(support.reason).toMatch(/not deployed on this chain yet; deploying it is one transaction anyone can send/);
    expect(support.reason).toMatch(/could not read the market/i);
  });

  it("is unavailable, with the endpoint's word, when nothing could be read", async () => {
    const support = await readVaultSupport(scripted({}), CHAIN);
    expect(support.kind).toBe("unavailable");
    if (support.kind === "unavailable") expect(support.reason).toMatch(/could not check whether the vault factory is deployed/i);
  });
});

describe("a vault plan's vault, as its card shows it", () => {
  it("is the owner's, with every figure from the chain", () => {
    const read = vaultPlanState({ plan: PLAN, account: OWNER, read: state(), readAtMs: 7_000 });
    expect(read).toMatchObject({
      kind: "active",
      mine: true,
      vault: VAULT,
      owner: OWNER,
      buysDone: 2,
      maxBuys: 5,
      buysLeft: 3,
      spent: 2n * AMOUNT,
      received: 123_456n,
      rewardsPaid: 2n * REWARD,
      balance: 3n * (AMOUNT + REWARD),
      funded: true,
      fundingRoom: 0n,
      due: false,
      nextBuyAt: 1_007_200,
      canTrigger: false,
      clock: { seconds: 1_005_000, readAtMs: 7_000 },
      mismatches: [],
    });
    // In words, and at this device's time: the keeper's log line ("next buy
    // due at 2026-…Z (chain time)") no longer reaches the card.
    if (read.kind === "active") expect(read.waitingFor).toMatch(/^Its next buy isn't due until /);
    if (read.kind === "active") expect(read.waitingFor).not.toMatch(/chain time|T\d\d:/);
  });

  it("can't say whose it is with no wallet connected, and is someone else's for another account", () => {
    expect(vaultPlanState({ plan: PLAN, account: null, read: state(), readAtMs: 0 })).toMatchObject({ kind: "active", mine: null });
    expect(vaultPlanState({ plan: PLAN, account: STRANGER, read: state(), readAtMs: 0 })).toMatchObject({
      kind: "someone-else",
      mine: false,
      owner: OWNER,
    });
  });

  it("can be triggered only when a read says the buy would go through", () => {
    expect(vaultPlanState({ plan: PLAN, account: OWNER, read: dueNow(), readAtMs: 0 })).toMatchObject({ canTrigger: true, waitingFor: null });
    const priced = vaultPlanState({
      plan: PLAN,
      account: OWNER,
      read: dueNow({ quote: { spotOut: 800n, floorOut: 900n, oracleDepth: 20n * ETHER } }),
      readAtMs: 0,
    });
    expect(priced).toMatchObject({ canTrigger: false, due: true });
    if (priced.kind === "active") expect(priced.waitingFor).toBe("The price is 11.11% outside this vault's allowance right now, so the buy waits for the market.");
    const thin = vaultPlanState({
      plan: PLAN,
      account: OWNER,
      read: dueNow({ quote: { spotOut: 1_000n, floorOut: 900n, oracleDepth: ETHER } }),
      readAtMs: 0,
    });
    if (thin.kind === "active") expect(thin.waitingFor).toBe("The market the price is checked against is too thin right now, so the vault won't buy.");
    const unpriced = vaultPlanState({ plan: PLAN, account: OWNER, read: dueNow({ quote: null }), readAtMs: 0 });
    if (unpriced.kind === "active") expect(unpriced.waitingFor).toMatch(/^The 10-minute average price can't be read right now/);
  });

  it("counts what funding would add, and nothing once closed", () => {
    const short = state({ status: { wethBalance: AMOUNT + REWARD, funded: true } });
    expect(vaultPlanState({ plan: PLAN, account: OWNER, read: short, readAtMs: 0 })).toMatchObject({ fundingRoom: 2n * (AMOUNT + REWARD) });
    expect(vaultPlanState({ plan: PLAN, account: OWNER, read: state({ closed: true }), readAtMs: 0 })).toMatchObject({ fundingRoom: 0n });
  });

  it("names where the vault's terms differ from the plan", () => {
    const read = vaultPlanState({ plan: { ...PLAN, maxBuys: 7 }, account: OWNER, read: state(), readAtMs: 0 });
    expect(read).toMatchObject({ mismatches: [{ field: "maxBuys", plan: "7", vault: "5" }] });
  });

  it("is no vault when nothing there answers like one, or the factory disowns it", () => {
    expect(vaultPlanState({ plan: PLAN, account: OWNER, read: null, readAtMs: 0 })).toMatchObject({
      kind: "unavailable",
      code: "not-a-vault",
    });
    expect(vaultPlanState({ plan: PLAN, account: OWNER, read: state({ fromFactory: false }), readAtMs: 0 })).toMatchObject({
      kind: "unavailable",
      code: "not-a-vault",
    });
    // Unknown is not "yes" either. The factory answers nothing when it has no
    // code — every chain it isn't deployed on — and there any contract that
    // answers a vault's views, with `owner()` naming the viewer, was shown as
    // their funded, due vault. Only the factory's yes shows figures.
    expect(vaultPlanState({ plan: PLAN, account: OWNER, read: state({ fromFactory: null }), readAtMs: 0 })).toMatchObject({
      kind: "unavailable",
      code: "unconfirmed",
      reason: expect.stringMatching(/can't confirm that its vault factory made .* shows none of its figures and sends nothing to it/),
    });
  });

  it("is not read at all on another chain, or where vaults aren't offered, or before the vault exists", async () => {
    const rpc = scripted({});
    const base = { account: OWNER, factory: FACTORY };
    expect(await readVaultPlan(rpc, { ...base, plan: PLAN, chainId: 1 })).toMatchObject({ kind: "unavailable", code: "chain" });
    expect(await readVaultPlan(rpc, { ...base, plan: { ...PLAN, chainId: 11155111 }, chainId: 11155111 })).toMatchObject({
      kind: "unavailable",
      code: "unsupported",
    });
    expect(await readVaultPlan(rpc, { ...base, plan: UNCREATED, chainId: CHAIN })).toEqual({ kind: "not-created", note: null });
    expect(rpc.calls).toEqual([]);
  });

  it("is unknown, never empty, when the read fails", async () => {
    const read = await readVaultPlan(scripted({}), { plan: PLAN, chainId: CHAIN, account: OWNER, factory: FACTORY });
    expect(read).toMatchObject({ kind: "unavailable", code: "unreadable" });
  });

  /**
   * A rate-limit page or a proxy's error comes back as a JSON parse error,
   * and it was shown on the card as it was ("Unexpected token 'd', "down" is
   * not valid JSON"). The sentence says what it means; the service's own words
   * go to Details.
   */
  it("says a failed read in plain words, keeping the service's own for Details", async () => {
    const down = scripted({
      eth_call: () => {
        throw new Error(`Unexpected token 'd', "down" is not valid JSON`);
      },
    });
    const read = await readVaultPlan(down, { plan: PLAN, chainId: CHAIN, account: OWNER, factory: FACTORY });
    expect(read).toMatchObject({ kind: "unavailable", code: "unreadable", detail: expect.stringContaining("is not valid JSON") });
    if (read.kind === "unavailable") {
      expect(read.reason).toBe(
        "spDEX couldn't read this vault from your network service right now. It tries again every 30 seconds; until then, what the vault holds is unknown.",
      );
    }
  });
});

describe("a vault plan's pill and line", () => {
  const active = (read: VaultState, account: Address | null = OWNER): VaultPlanState =>
    vaultPlanState({ plan: PLAN, account, read, readAtMs: 0 });

  it("says what isn't known yet, and what is wrong, before anything about timing", () => {
    expect(vaultCardStatus({ kind: "loading" }, null)).toMatchObject({ row: "vault", vault: "loading", pill: "paused" });
    expect(vaultCardStatus({ kind: "unavailable", code: "unreadable", reason: "No." }, null)).toMatchObject({
      vault: "unavailable",
      pill: "attention",
      reason: "No.",
    });
    expect(vaultCardStatus(active(state({ closed: true, buysDone: 3n })), 1_005_000)).toMatchObject({
      vault: "closed",
      pill: "done",
      reason: "Closed after 3 of 5 buys: what it held went back to your wallet.",
    });
    // Read with no wallet connected, whose it is isn't known here; one buy is one buy.
    const single = { ...TERMS, maxBuys: 1n };
    expect(
      vaultCardStatus(
        vaultPlanState({ plan: { ...PLAN, maxBuys: 1 }, account: null, read: state({ closed: true, buysDone: 0n, terms: single }), readAtMs: 0 }),
        1_005_000,
      ),
    ).toMatchObject({ reason: "Closed after 0 of 1 buy: what it held went back to its owner." });
    expect(vaultCardStatus(vaultPlanState({ plan: { ...PLAN, maxBuys: 7 }, account: OWNER, read: dueNow(), readAtMs: 0 }), 1_005_000)).toMatchObject({
      vault: "mismatch",
      pill: "attention",
    });
  });

  it("asks for the vault to be created, and shows one being created", () => {
    expect(vaultCardStatus({ kind: "not-created", note: null }, null)).toMatchObject({ vault: "not-created", pill: "action", pillLabel: "Create vault" });
    expect(vaultCardStatus({ kind: "not-created", note: "It failed." }, null).reason).toBe("It failed.");
    expect(vaultCardStatus({ kind: "creating", vault: VAULT, hash: null }, null)).toMatchObject({ vault: "creating", pill: "running" });
  });

  it("is finished when every buy is made, and says what is left to take back", () => {
    const done = state({ buysDone: 5n, status: { buysLeft: 0n, wethBalance: 0n, funded: false, nextBuyAt: null } });
    expect(vaultCardStatus(active(done), 1_005_000)).toMatchObject({ vault: "done", pill: "done", reason: "Finished: 5 of 5 bought." });
    const left = state({ buysDone: 5n, status: { buysLeft: 0n, wethBalance: 7n, funded: false, nextBuyAt: null } });
    expect(vaultCardStatus(active(left), 1_005_000).reason).toMatch(/still holds some WETH — close it/);
  });

  it("asks for funding when the vault can't cover its next buy", () => {
    const empty = state({ status: { wethBalance: 0n, funded: false } });
    expect(vaultCardStatus(active(empty), 1_005_000)).toMatchObject({ vault: "unfunded", pill: "action", pillLabel: "Needs funding" });
  });

  it("keeps a due buy the keeper's to make — running, not the person's turn — and says they may trigger it", () => {
    expect(vaultCardStatus(active(dueNow()), 1_005_000)).toMatchObject({
      vault: "due",
      pill: "running",
      pillLabel: "Buy due",
      reason: "The next buy is due — waiting for a keeper. You can trigger it yourself; its buy fee comes back to you.",
      nextBuyAt: 1_004_000,
    });
  });

  it("says what a due buy is waiting for when a moment can change it", () => {
    const priced = active(dueNow({ quote: { spotOut: 800n, floorOut: 900n, oracleDepth: 20n * ETHER } }));
    const status = vaultCardStatus(priced, 1_005_000);
    expect(status).toMatchObject({ vault: "waiting-price", pill: "running" });
    expect(status.reason).toBe("The price is 11.11% outside this vault's allowance right now, so the buy waits for the market.");
  });

  it("counts down to the next buy otherwise, and shows someone else's vault as theirs", () => {
    expect(vaultCardStatus(active(state()), 1_005_000)).toMatchObject({ vault: "waiting", pill: "running", reason: null, nextBuyAt: 1_007_200 });
    expect(vaultCardStatus(active(state(), STRANGER), 1_005_000)).toMatchObject({
      vault: "theirs",
      pillLabel: "Not yours",
      reason: `This vault belongs to ${OWNER}. You can watch it here; only its owner can fund or close it.`,
    });
  });

  /**
   * Someone else's unfunded vault read "Next buy: Due now · Wed 13:40", and a
   * due one a weekday already past, where its owner sees "waiting for a
   * keeper". An unfunded vault has no next buy; a due one waits for a keeper
   * whoever looks at it.
   */
  it("gives someone else's vault a next buy only when one can happen, and a past one no weekday", () => {
    const nowMs = 1_005_000 * 1000;
    const unfunded = vaultCardStatus(active(state({ status: { wethBalance: 0n, funded: false, nextBuyAt: 1_004_000n } }), STRANGER), 1_005_000);
    expect(unfunded).toMatchObject({ vault: "theirs", nextBuyAt: null });
    expect(vaultNextBuyStat(unfunded, 1_005_000, nowMs)).toEqual({ value: "—", hint: null });
    const due = vaultCardStatus(active(dueNow(), STRANGER), 1_005_000);
    expect(vaultNextBuyStat(due, 1_005_000, nowMs)).toEqual({ value: "Due now", hint: "waiting for a keeper" });
  });
});

describe("keeping vault plans through a reset, an import or a shared link", () => {
  const cfg = (...plans: DcaPlan[]) => ({ ...recommendedConfig(), dca: { enabled: false, plans } }) as SpdexConfig;
  const OTHER = "0x00000000000000000000000000000000000000cc" as Address;
  const funded = vaultPlanState({ plan: PLAN, account: OWNER, read: state(), readAtMs: 0 });
  const closed = vaultPlanState({ plan: PLAN, account: OWNER, read: state({ closed: true, status: { wethBalance: 0n } }), readAtMs: 0 });
  const walletPlan: DcaPlan = { ...UNCREATED, id: "dca-wallet", signer: "wallet" };

  /**
   * The reviewers' case: a vault holding 0.5 ETH, Reset pressed, "spending
   * wallets stay listed" confirmed — and the plan, the vault's only pointer in
   * the app, was gone, with no Close left anywhere. Now it comes through.
   */
  it("keeps a vault plan a replacement leaves out, while its vault may still hold money", () => {
    const out = keepVaultPlans(cfg(PLAN, walletPlan), cfg(), () => funded);
    expect(out.error).toBeNull();
    expect(out.config.dca.plans).toEqual([PLAN]);
    expect(out.config.preset).toBe("custom");
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]).toMatchObject({ reason: "dropped" });
    expect(out.kept[0]!.text).toMatch(/^"Buying SPX" stays: its vault \(0x[0-9a-f]{4}…[0-9a-f]{4}\) still holds 0\.0300604 WETH and goes on buying whenever anyone triggers it, and only closing it stops it\. Close it, then delete the plan\.$/);
    // What goes is counted as before: the wallet plan.
    expect(removedPlanCount(cfg(PLAN, walletPlan), out.config)).toBe(1);
  });

  it("keeps one it can't read — unknown is never 'nothing' — and one still being created", () => {
    expect(keepVaultPlans(cfg(PLAN), cfg(), () => undefined).config.dca.plans).toEqual([PLAN]);
    const creating = keepVaultPlans(cfg(UNCREATED), cfg(), () => ({ kind: "creating", vault: VAULT, hash: null }));
    expect(creating.config.dca.plans).toEqual([UNCREATED]);
    expect(creating.kept[0]!.text).toMatch(/is still being created/);
  });

  it("lets go of what has nothing at stake: closed, someone else's, or never created", () => {
    expect(keepVaultPlans(cfg(PLAN), cfg(), () => closed)).toMatchObject({ kept: [], error: null });
    const theirs = vaultPlanState({ plan: PLAN, account: STRANGER, read: state(), readAtMs: 0 });
    expect(keepVaultPlans(cfg(PLAN), cfg(), () => theirs).kept).toEqual([]);
    expect(keepVaultPlans(cfg(UNCREATED), cfg(), () => ({ kind: "not-created", note: null })).kept).toEqual([]);
    // Nothing kept, nothing touched: the config is `next` itself.
    const next = cfg(walletPlan);
    expect(keepVaultPlans(cfg(PLAN), next, () => closed).config).toBe(next);
  });

  /**
   * An older export of the same plan, from before its vault existed, came
   * back with no `vault` — and its card offered "Create and fund vault", a
   * second budget. A copy pointing elsewhere showed the vault as someone
   * else's. A plan's vault is written once, whichever path writes the config.
   */
  it("keeps a plan's vault when the new settings have the plan without it, or pointed at another", () => {
    const older = keepVaultPlans(cfg(PLAN), cfg({ ...UNCREATED, label: "old copy" }), () => funded);
    expect(older.config.dca.plans).toEqual([PLAN]);
    expect(older.kept[0]).toMatchObject({ reason: "without-vault" });
    expect(older.kept[0]!.text).toMatch(/keeps its vault .*: the new settings have this plan without it, and a plan's vault can't be removed\.$/);
    const elsewhere = keepVaultPlans(cfg(PLAN), cfg({ ...PLAN, vault: OTHER }), () => funded);
    expect(elsewhere.config.dca.plans).toEqual([PLAN]);
    expect(elsewhere.kept[0]!.text).toMatch(/point it at another vault \(0x0000…00cc\), and a plan's vault can't change\.$/);
    // The same vault, any case: nothing to keep.
    expect(keepVaultPlans(cfg(PLAN), cfg({ ...PLAN, vault: VAULT.toUpperCase().replace("0X", "0x") as Address }), () => funded).kept).toEqual([]);
  });

  it("refuses rather than breaks the config when the plans can't be kept alongside the new ones", () => {
    // Another plan with the same id on another chain: ids are unique across chains.
    const clash = cfg({ ...walletPlan, id: PLAN.id, chainId: 1 });
    const out = keepVaultPlans(cfg(PLAN), clash, () => funded);
    expect(out.config).toBe(clash);
    expect(out.error).toMatch(/^spDEX can't keep your vault plans alongside these settings \(.*\)\. Close those vaults first, or cancel\.$/);
  });
});

describe("retrying a vault's creation from its card", () => {
  const plan = { amountPerBuy: AMOUNT.toString(), maxBuys: 5 };
  const today = buyFee(AMOUNT).reward;

  /**
   * The allowance and the buy fee are fixed in the vault for good, and a plan
   * has no field for either. A plan from a link, another browser or cleared
   * storage was created with a silent 2%, and a fee the card never showed.
   */
  it("asks for an allowance rather than defaulting one, and says which buy fee it sends", () => {
    expect(vaultRetryTerms({ plan, draft: null })).toEqual({
      maxSlippageBps: null,
      keeperReward: today,
      keptReward: false,
      fund: 5n * (AMOUNT + today),
    });
    expect(vaultRetryTerms({ plan, draft: null, chosen: 100 }).maxSlippageBps).toBe(100);
    // Only the chips the form offers.
    expect(vaultRetryTerms({ plan, draft: null, chosen: 450 }).maxSlippageBps).toBeNull();
  });

  it("uses the choices this browser kept while their fee is no more than today's, and today's otherwise", () => {
    const draft = { maxSlippageBps: 300, keeperReward: today.toString() };
    expect(vaultRetryTerms({ plan, draft })).toEqual({ maxSlippageBps: 300, keeperReward: today, keptReward: true, fund: 5n * (AMOUNT + today) });
    // A pick on the card wins over the draft's.
    expect(vaultRetryTerms({ plan, draft, chosen: 100 }).maxSlippageBps).toBe(100);
    // Lower than today's: the person's own, kept.
    const lower = { maxSlippageBps: 300, keeperReward: (today - 1n).toString() };
    expect(vaultRetryTerms({ plan, draft: lower })).toMatchObject({ keeperReward: today - 1n, keptReward: true });
    // Higher, even inside the ceiling: today's. So is a 10% draft from before
    // the ceiling, which the Guard would refuse to create.
    for (const kept of [today + 1n, AMOUNT / 10n]) {
      expect(vaultRetryTerms({ plan, draft: { maxSlippageBps: 300, keeperReward: kept.toString() } })).toMatchObject({
        keeperReward: today,
        keptReward: false,
        fund: 5n * (AMOUNT + today),
      });
    }
  });

  it("knows no buy fee only for an amount that isn't a buy", () => {
    for (const amountPerBuy of ["0", "ten"]) {
      expect(vaultRetryTerms({ plan: { amountPerBuy, maxBuys: 5 }, draft: null, chosen: 200 })).toEqual({
        maxSlippageBps: 200,
        keeperReward: null,
        keptReward: false,
        fund: null,
      });
    }
  });
});

describe("a vault plan's figures", () => {
  const figures = (read: VaultState) => {
    const out = vaultPlanState({ plan: PLAN, account: OWNER, read, readAtMs: 0 });
    if (out.kind !== "active") throw new Error("not active");
    return out;
  };

  it("counts down in chain time and names the moment in this device's time", () => {
    // The device five days ahead of the chain, as the local fork is.
    const chainNowSeconds = 1_005_000;
    const nowMs = (chainNowSeconds + 5 * 86_400) * 1000;
    const waiting = vaultCardStatus(figures(state()), chainNowSeconds);
    const stat = vaultNextBuyStat(waiting, chainNowSeconds, nowMs);
    expect(stat.value).toBe("36m");
    expect(deviceTimeOf(1_007_200, chainNowSeconds, nowMs)).toBe(1_007_200 + 5 * 86_400);
    expect(stat.hint).not.toBeNull();
    expect(vaultNextBuyStat(vaultCardStatus(figures(dueNow()), chainNowSeconds), chainNowSeconds, nowMs)).toEqual({ value: "Due now", hint: "waiting for a keeper" });
    expect(vaultNextBuyStat(vaultCardStatus({ kind: "loading" }, null), null, nowMs)).toEqual({ value: null, hint: null });
    expect(vaultNextBuyStat(waiting, null, nowMs)).toEqual({ value: null, hint: null });
    expect(vaultNextBuyStat(vaultCardStatus({ kind: "not-created", note: null }, null), null, nowMs).value).toBe("Not created");
  });

  it("shows progress, what arrived and the average rate from the vault's own totals", () => {
    const two = figures(state({ totalOut: 1_307_850_000n }));
    expect(vaultProgress(two)).toEqual({ value: 2, valueText: "2 of 5 buys · 0.02 of 0.05 ETH" });
    expect(vaultBoughtStat(two)).toBe("13.0785 SPX");
    // 13.0785 SPX for 0.02 ETH.
    expect(vaultAverageStat(two)).toBe("1 ETH = 653.925 SPX");
    const none = figures(state({ buysDone: 0n, totalOut: 0n, totalRewards: 0n }));
    expect(vaultBoughtStat(none)).toBe("none yet");
    expect(vaultAverageStat(none)).toBe("—");
  });

  it("words each history row, saying 'you' for a buy this wallet triggered", () => {
    const base = { hash: `0x${"1".repeat(64)}` as Hex, blockNumber: 1n, logIndex: 0, at: null };
    const buy = { ...base, kind: "bought" as const, amountIn: AMOUNT, amountOut: 1_307_850_000n, keeper: STRANGER, reward: 4n * 10n ** 14n };
    expect(vaultHistorySentence(buy, TERMS, OWNER)).toBe("Bought 13.0785 SPX for 0.01 ETH · triggered by 0x0000…00b2, paid them its 0.0004 WETH buy fee");
    expect(vaultHistorySentence(buy, TERMS, STRANGER)).toBe("Bought 13.0785 SPX for 0.01 ETH · triggered by you, paid you its 0.0004 WETH buy fee");
    expect(vaultHistorySentence({ ...base, kind: "funded", amount: ETHER / 50n }, TERMS, null)).toBe("Funded with 0.02 ETH");
    expect(vaultHistorySentence({ ...base, kind: "closed", amount: ETHER / 50n }, TERMS, null)).toBe("Closed: 0.02 ETH sent back to its owner");
  });

  /**
   * A batcher's address would name a contract, not whoever sent the batch, so
   * a buy it triggered says so — for every release's batcher, and for the one
   * bound to the factory this app uses, however the address is cased.
   */
  it("says a buy a batcher triggered was triggered in a batch", () => {
    const base = { hash: `0x${"1".repeat(64)}` as Hex, blockNumber: 1n, logIndex: 0, at: null };
    const batchers = [...DEPLOYMENTS.map((d) => d.batcher), batcherAddress(FACTORY)];
    for (const batcher of batchers) {
      for (const keeper of [batcher.toLowerCase(), `0x${batcher.slice(2).toUpperCase()}`] as Address[]) {
        const buy = { ...base, kind: "bought" as const, amountIn: AMOUNT, amountOut: 1_307_850_000n, keeper, reward: 4n * 10n ** 14n };
        expect(vaultHistorySentence(buy, TERMS, OWNER)).toBe("Bought 13.0785 SPX for 0.01 ETH · triggered in a batch, paid the keeper its 0.0004 WETH buy fee");
      }
    }
  });
});

describe("before a vault plan is removed", () => {
  const active = (read: VaultState) => vaultPlanState({ plan: PLAN, account: OWNER, read, readAtMs: 0 });

  it("warns while the vault holds money, is being created, or can't be read", () => {
    expect(vaultRemovalWarning(active(state()))).toMatch(/still holds WETH .* close it first/);
    // Yours: it moves to the list below at once, and only a search finds it after this page.
    expect(vaultRemovalWarning(active(state()))).toMatch(
      /It moves to "Vaults on chain not in your plans" below, where you can still close it; after you leave this page, spDEX finds it again only by searching/,
    );
    // Read with no wallet connected: nothing carries it over, so nothing says it will be listed.
    const unknownOwner = vaultPlanState({ plan: PLAN, account: null, read: state(), readAtMs: 0 });
    expect(vaultRemovalWarning(unknownOwner)).not.toMatch(/moves to/);
    expect(vaultRemovalWarning(unknownOwner)).toMatch(/Once the plan is gone, spDEX can find the vault only by searching/);
    expect(vaultRemovalWarning({ kind: "creating", vault: VAULT, hash: null })).toMatch(/hasn't confirmed yet/);
    expect(vaultRemovalWarning({ kind: "loading" })).toMatch(/can't tell whether it still holds money/);
  });

  it("has nothing to say once the vault is closed or empty and done, or for someone else's", () => {
    expect(vaultRemovalWarning(active(state({ closed: true })))).toBeNull();
    expect(vaultRemovalWarning(active(state({ status: { buysLeft: 0n, wethBalance: 0n } })))).toBeNull();
    expect(vaultRemovalWarning({ kind: "not-created", note: null })).toBeNull();
    expect(vaultRemovalWarning(vaultPlanState({ plan: PLAN, account: STRANGER, read: state(), readAtMs: 0 }))).toBeNull();
  });
});

describe("where a vault came from", () => {
  it("finds the nonce that puts a vault with its terms at its address, below the owner's count", async () => {
    const rpc = scripted({ eth_call: () => `0x${word(5n)}` });
    expect(await vaultClaim(rpc, FACTORY, state())).toEqual({ address: VAULT, owner: OWNER, nonce: NONCE, terms: TERMS });
  });

  it("finds none for a vault the factory didn't make on these terms", async () => {
    const rpc = scripted({ eth_call: () => `0x${word(5n)}` });
    expect(await vaultClaim(rpc, FACTORY, state({ terms: { ...TERMS, maxBuys: 6n } }))).toBeNull();
    // Nor below a count that doesn't reach its nonce.
    expect(await vaultClaim(scripted({ eth_call: () => `0x${word(NONCE)}` }), FACTORY, state())).toBeNull();
  });
});

describe("the four transactions", () => {
  const choices = { maxSlippageBps: 200, keeperReward: REWARD };
  const claim = { address: VAULT, owner: OWNER, nonce: NONCE, terms: TERMS };

  it("creates the plan's vault where the factory will put it, and passes the Guard's static checks", () => {
    const terms = vaultPlanOf(UNCREATED, choices);
    const budget = 5n * (AMOUNT + REWARD);
    const { tx, vault } = createVaultTx({
      chainId: CHAIN,
      account: OWNER,
      plan: UNCREATED,
      terms,
      nonce: NONCE,
      nowSeconds: BigInt(START),
      value: budget,
      factory: FACTORY,
    });
    expect(vault).toBe(VAULT);
    expect(tx.calls).toEqual([{ to: FACTORY, data: encodeCreateVault(terms), value: budget }]);
    expect(tx.intent).toMatchObject({ action: "create", account: OWNER, nonce: NONCE, nowSeconds: BigInt(START) });
    expect(runVaultChecks(tx, CHAIN)).toEqual([]);
    // One wei past the budget is the Guard's to refuse, not the builder's to hide.
    const over = createVaultTx({ chainId: CHAIN, account: OWNER, plan: UNCREATED, terms, nonce: NONCE, nowSeconds: BigInt(START), value: budget + 1n, factory: FACTORY });
    expect(runVaultChecks(over.tx, CHAIN).map((v) => v.code)).toContain("VAULT_MALFORMED");
  });

  it("funds, closes and triggers the plan's own vault, each passing the Guard's static checks", () => {
    const fund = fundVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim, buysDone: 2n, wethBalance: AMOUNT + REWARD, value: 2n * (AMOUNT + REWARD) });
    expect(fund.calls).toEqual([{ to: VAULT, data: encodeFund(), value: 2n * (AMOUNT + REWARD) }]);
    expect(runVaultChecks(fund, CHAIN)).toEqual([]);

    const close = closeVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim });
    expect(close.calls).toEqual([{ to: VAULT, data: encodeClose(), value: 0n }]);
    expect(runVaultChecks(close, CHAIN)).toEqual([]);

    // Anyone may trigger a due buy; the tokens go to the owner either way.
    const trigger = triggerVaultTx({ chainId: CHAIN, account: STRANGER, plan: PLAN, claim, floorOut: 900n });
    expect(trigger.calls).toEqual([{ to: VAULT, data: encodeExecute(), value: 0n }]);
    expect(runVaultChecks(trigger, CHAIN)).toEqual([]);
  });
});

describe("sending a vault transaction", () => {
  const HASH = `0x${"ab".repeat(32)}` as Hex;
  const claim = { address: VAULT, owner: OWNER, nonce: NONCE, terms: TERMS };
  const close = closeVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim });
  const fund = fundVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim, buysDone: 2n, wethBalance: 0n, value: AMOUNT });
  const verified: GuardVerdict = { level: "verified", signable: true, violations: [], warnings: [] };
  const receiptLogs = [{ address: VAULT, topics: [VAULT_EVENT_TOPICS.Closed], data: `0x${word(123n)}` }];

  function sender(rpc: JsonRpc, account: Address = OWNER) {
    const send = vi.fn(async () => ({ hash: HASH, via: "wallet" as const }));
    const tx: TxSender = { account, kind: "wallet", send, confirm: { rpc, timeoutMs: 5_000 } };
    return { tx, send };
  }
  const chain = () => scripted({ eth_getTransactionReceipt: () => ({ status: "0x1", logs: receiptLogs }) });

  it("checks, sends from the owner's wallet, waits, and hands back the receipt's logs", async () => {
    const rpc = chain();
    const { tx, send } = sender(rpc);
    const steps: string[] = [];
    const sent: string[] = [];
    const out = await sendVaultTx(close, {
      engine: { checkVault: async () => verified },
      sender: tx,
      rpc,
      sendLabel: "Confirm closing",
      onStep: (step) => steps.push(step.phase),
      onSent: (hash) => void sent.push(hash),
    });
    // With the chain it was checked for: a wallet switched meanwhile is refused before it signs.
    expect(send).toHaveBeenCalledWith({ to: VAULT, data: encodeClose(), value: 0n, chainId: CHAIN });
    expect(out.hash).toBe(HASH);
    expect(out.logs).toEqual(receiptLogs);
    expect(steps).toEqual(["check", "send", "confirm"]);
    expect(sent).toEqual([HASH]);
    expect(decodeVaultEvent(out.logs[0]!)).toMatchObject({ name: "Closed", amount: 123n });
  });

  it("sends nothing the Guard refuses, and says the vault's own reason when its simulation reverted", async () => {
    const { tx, send } = sender(chain());
    const reverted: GuardVerdict = {
      level: "rejected",
      signable: false,
      violations: [{ code: "SIMULATION_REVERTED", message: `execution reverted: custom error 0xd6e7da92${word(800n)}${word(900n)}` }],
      warnings: [],
    };
    const refusal = sendVaultTx(close, { engine: { checkVault: async () => reverted }, sender: tx, rpc: chain(), sendLabel: "" });
    await expect(refusal).rejects.toBeInstanceOf(VaultTxRefused);
    await expect(refusal).rejects.toMatchObject({
      codes: ["SIMULATION_REVERTED"],
      vaultReason: "The price is outside this vault's allowance right now, so it won't buy. It waits for the market.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("never sends ether unchecked, even on a verdict the Guard would call signable", async () => {
    const { tx, send } = sender(chain());
    const unverified: GuardVerdict = {
      level: "unverified",
      signable: true,
      violations: [],
      warnings: [{ code: "SIMULATION_UNAVAILABLE", message: "no simulation" }],
    };
    await expect(sendVaultTx(fund, { engine: { checkVault: async () => unverified }, sender: tx, rpc: chain(), sendLabel: "" })).rejects.toMatchObject({
      codes: ["SIMULATION_UNAVAILABLE"],
    });
    expect(send).not.toHaveBeenCalled();
    // A close sends none, and follows the verdict: closing must stay possible on an endpoint that can't simulate.
    await expect(sendVaultTx(close, { engine: { checkVault: async () => unverified }, sender: tx, rpc: chain(), sendLabel: "" })).resolves.toMatchObject({
      hash: HASH,
    });
  });

  it("says, before the wallet asks and after, when a close or a buy was checked on one service", async () => {
    const { tx } = sender(chain());
    const silent: GuardVerdict = {
      level: "unverified",
      signable: true,
      violations: [],
      warnings: [{ code: "SECOND_OPINION_UNAVAILABLE", message: "timeout", detail: { host: "second.example", failure: "timeout" } }],
    };
    const labels: string[] = [];
    await sendVaultTx(close, {
      engine: { checkVault: async () => silent },
      sender: tx,
      rpc: chain(),
      sendLabel: "Confirm closing the vault in your wallet…",
      onStep: (step) => void labels.push(step.label),
    });
    expect(labels[1]).toBe("Checked on one service: your second opinion, second.example, didn't answer. Confirm closing the vault in your wallet…");
    expect(vaultCheckNote(verified)).toBeNull();
    expect(vaultCheckNote({ ...silent, warnings: [{ code: "SIMULATION_UNAVAILABLE", message: "no simulation" }] })).toBe(
      "Not checked: this wasn't test-run in advance.",
    );
    expect(vaultCheckNote({ ...silent, warnings: [{ code: "SECOND_OPINION_UNAVAILABLE", message: "timeout" }] })).toBe(
      "Checked on one service: your second opinion didn't answer.",
    );
  });

  it("refuses to send from any account but the one it was checked for", async () => {
    const check = vi.fn(async () => verified);
    const { tx, send } = sender(chain(), STRANGER);
    await expect(sendVaultTx(close, { engine: { checkVault: check }, sender: tx, rpc: chain(), sendLabel: "" })).rejects.toThrow(/not 0x0+a1/);
    expect(check).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a transaction that reverted on chain by its hash", async () => {
    const rpc = scripted({ eth_getTransactionReceipt: () => ({ status: "0x0", logs: [] }) });
    const { tx } = sender(rpc);
    await expect(sendVaultTx(close, { engine: { checkVault: async () => verified }, sender: tx, rpc, sendLabel: "" })).rejects.toMatchObject({
      name: "VaultTxFailed",
      hash: HASH,
    });
  });

  /**
   * A buy estimated on a quiet pool needs about 57,000 more gas when a trade
   * lands on the pool first, more than an estimate's 20% covers: "Trigger
   * now" ran out of gas and the owner paid the fee. The keeper's floor goes
   * with the call; the other three need none.
   */
  it("sends a trigger with the keeper's gas floor, and nothing else with one", async () => {
    const { tx, send } = sender(chain());
    const trigger = triggerVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim, floorOut: 900n });
    await sendVaultTx(trigger, { engine: { checkVault: async () => verified }, sender: tx, rpc: chain(), sendLabel: "" });
    expect(send).toHaveBeenCalledWith({ to: VAULT, data: encodeExecute(), value: 0n, chainId: CHAIN, gasFloor: 384_000n });
    await sendVaultTx(fund, { engine: { checkVault: async () => verified }, sender: tx, rpc: chain(), sendLabel: "" });
    expect(send).toHaveBeenLastCalledWith({ to: VAULT, data: encodeFund(), value: AMOUNT, chainId: CHAIN });
  });
});

describe("creating a vault", () => {
  const HASH = `0x${"ef".repeat(32)}` as Hex;
  const verified: GuardVerdict = { level: "verified", signable: true, violations: [], warnings: [] };
  const choices = { maxSlippageBps: 200, keeperReward: REWARD };
  const plan: DcaPlan = { ...UNCREATED, startAt: 1_005_000 };

  /** An endpoint for one creation: chain time, the factory's nonce, and the receipt's logs. */
  const endpoint = (logs: unknown[] | null) =>
    scripted({
      eth_getBlockByNumber: () => ({ timestamp: `0x${(1_005_000).toString(16)}` }),
      eth_call: () => `0x${word(NONCE)}`,
      eth_getTransactionReceipt: () => (logs === null ? null : { status: "0x1", logs }),
    });
  // The confirmation reads its own receipt; what `createVault` reads after it is the engine's.
  const confirmed = scripted({ eth_getTransactionReceipt: () => ({ status: "0x1", logs: [] }) });
  const deps = (rpc: JsonRpc) => ({
    engine: { checkVault: async () => verified, vaultFactory: FACTORY, rpc } as never,
    sender: {
      account: OWNER,
      kind: "wallet" as const,
      send: async () => ({ hash: HASH, via: "wallet" as const }),
      confirm: { rpc: confirmed, timeoutMs: 5_000 },
    },
    chainId: CHAIN,
  });

  /**
   * The prediction was made from a nonce read before the wallet was asked; the
   * same account creating a vault elsewhere meanwhile moves this one to the
   * next nonce's address. Recorded, a guess would have pointed the plan for
   * good at an empty address and orphaned the real vault.
   */
  it("returns no address when the receipt doesn't name the vault, rather than the prediction", async () => {
    const prepared: Address[] = [];
    const out = await createVault({ ...deps(endpoint([])), onPrepared: (p) => void prepared.push(p.vault) }, { plan, choices, fund: 0n });
    expect(out.vault).toBeNull();
    expect(prepared).toHaveLength(1);
    const unread = await createVault(deps(endpoint(null)), { plan, choices, fund: 0n });
    expect(unread.vault).toBeNull();
  });
});

describe("a vault's refusals, in words", () => {
  it("names the vault's and the factory's errors, and leaves anything else to the raw message", () => {
    expect(vaultErrorText({ name: "TooSoon", args: [1n] })).toBe("The vault's next buy isn't due yet.");
    expect(vaultErrorText({ name: "FundingCapExceeded", args: [1n, 2n] })).toMatch(/at most 0\.5 ETH/);
    expect(vaultErrorText({ name: "Unauthorized", args: [] })).toBe("Only the vault's owner can do that.");
    expect(vaultErrorText({ name: "SomethingElse", args: [] })).toBeNull();
    expect(vaultErrorText(null)).toBeNull();
  });

  it("finds the vault's error inside a revert message", () => {
    expect(revertText(`reverted with 0xe86f59ea${word(5n)}`)).toBe("The vault's next buy isn't due yet.");
    expect(revertText("0x82b42900")).toBe("Only the vault's owner can do that.");
    expect(revertText("execution reverted")).toBeNull();
    expect(revertText("reverted: 0xdeadbeef")).toBeNull();
  });
});

describe("the vault's event topics", () => {
  it("are the vault's own: each decodes as its event", () => {
    const keeper = `0x${"0".repeat(24)}${STRANGER.slice(2)}`;
    // Bought's data: amountIn, amountOut, reward, floorOut, buyNumber, oracleDepth.
    const data = `0x${[AMOUNT, 777n, REWARD, 700n, 3n, 20n * ETHER].map(word).join("")}`;
    expect(decodeVaultEvent({ address: VAULT, topics: [VAULT_EVENT_TOPICS.Bought, `0x${word(4n)}`, keeper], data })).toMatchObject({
      name: "Bought",
      slot: 4n,
      amountIn: AMOUNT,
      amountOut: 777n,
      keeper: STRANGER,
      reward: REWARD,
      floorOut: 700n,
      buyNumber: 3n,
      oracleDepth: 20n * ETHER,
    });
    expect(decodeVaultEvent({ address: VAULT, topics: [VAULT_EVENT_TOPICS.Funded], data: `0x${word(9n)}` })).toMatchObject({ name: "Funded", amount: 9n });
    expect(decodeVaultEvent({ address: VAULT, topics: [VAULT_EVENT_TOPICS.Closed], data: `0x${word(9n)}` })).toMatchObject({ name: "Closed", amount: 9n });
  });
});

describe("a vault's history", () => {
  const HEAD = 50_000n;
  const HEAD_TIME = 2_000_000;
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const keeper = `0x${"0".repeat(24)}${STRANGER.slice(2)}`;
  const bought = (block: bigint, index = 0, emitter: string = VAULT) => ({
    address: emitter,
    topics: [VAULT_EVENT_TOPICS.Bought, `0x${word(1n)}`, keeper],
    data: `0x${[AMOUNT, 777n, REWARD, 700n, 1n, 20n * ETHER].map(word).join("")}`,
    blockNumber: hex(block),
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    logIndex: hex(BigInt(index)),
  });
  const funded = (block: bigint) => ({
    address: VAULT,
    topics: [VAULT_EVENT_TOPICS.Funded],
    data: `0x${word(5n)}`,
    blockNumber: hex(block),
    transactionHash: `0x${"f".repeat(64)}`,
    logIndex: "0x0",
  });

  /** An endpoint holding `logs`, refusing any range wider than `maxRange` blocks. */
  function chain(logs: ReturnType<typeof bought>[], maxRange = 1_000_000n) {
    return scripted({
      eth_blockNumber: () => hex(HEAD),
      eth_getBlockByNumber: (params) => {
        const block = BigInt(params[0] as string);
        return { timestamp: hex(BigInt(HEAD_TIME) - (HEAD - block) * 12n) };
      },
      eth_getLogs: (params) => {
        const filter = params[0] as { fromBlock: string; toBlock: string; address: string };
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        if (to - from + 1n > maxRange) throw new Error("block range too large");
        return logs.filter((log) => {
          const at = BigInt(log.blockNumber);
          return at >= from && at <= to;
        });
      },
    });
  }

  it("reads the newest window once when it holds every buy, newest first, each with its block's time", async () => {
    const rpc = chain([bought(49_000n), bought(49_500n), funded(48_900n), bought(49_500n, 1, STRANGER)]);
    const history = await readVaultHistory(rpc, { vault: VAULT, buysDone: 2, startAt: HEAD_TIME - 100_000, chainId: 1 });
    expect(history.missingBuys).toBe(0);
    expect(history.note).toBeNull();
    // A look-alike from another address is not this vault's buy.
    expect(history.entries.map((e) => [e.kind, e.blockNumber])).toEqual([
      ["bought", 49_500n],
      ["bought", 49_000n],
      ["funded", 48_900n],
    ]);
    expect(history.entries[0]).toMatchObject({ amountIn: AMOUNT, amountOut: 777n, keeper: STRANGER, reward: REWARD, at: HEAD_TIME - 500 * 12 });
    expect(rpc.calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(1);
  });

  it("narrows the window when the endpoint refuses a wide one, and walks back until every buy is found", async () => {
    const rpc = chain([bought(49_950n), bought(49_700n), bought(49_200n)], 500n);
    const history = await readVaultHistory(rpc, { vault: VAULT, buysDone: 3, startAt: HEAD_TIME - 1_000_000, chainId: 1 });
    expect(history.missingBuys).toBe(0);
    expect(history.entries).toHaveLength(3);
    const ranges = rpc.calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => {
        const f = c.params[0] as { fromBlock: string; toBlock: string };
        return BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
      });
    expect(ranges.slice(0, 3)).toEqual([10_000n, 2_000n, 500n]);
  });

  it("says earlier buys aren't shown rather than guessing, when it reaches the vault's start without them", async () => {
    // Started 100 blocks' worth of time ago on Ethereum (a block a slot at
    // most), and the vault counts one more buy than the logs hold.
    const rpc = chain([bought(49_990n)]);
    const history = await readVaultHistory(rpc, { vault: VAULT, buysDone: 2, startAt: HEAD_TIME - 1_200, chainId: 1 });
    expect(history.missingBuys).toBe(1);
    expect(history.fromBlock).toBe(HEAD - 101n);
    expect(history.note).toBe(
      "Earlier buys not shown: spDEX read the vault's logs back to block 49899, which holds 1 of its 2 buys. The totals above count every buy.",
    );
  });

  it("bounds the walk back, and says so, on an endpoint that serves ten blocks at a time", async () => {
    const rpc = chain([bought(10n)], 10n);
    const history = await readVaultHistory(rpc, { vault: VAULT, buysDone: 1, startAt: 0, chainId: CHAIN, maxQueries: 8 });
    expect(rpc.calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(8);
    expect(history.missingBuys).toBe(1);
    expect(history.note).toMatch(/^Earlier buys not shown: spDEX read the vault's logs back to block 49961,/);
  });

  /**
   * A local fork mines a block per transaction and stamps several with the
   * same second, so a bound from time — one block a second — landed above a
   * buy it was meant to reach, and the card said a buy it held was "not
   * shown". Off Ethereum no bound comes from time.
   */
  it("off Ethereum, finds a buy many blocks back in the same second", async () => {
    const base = chain([bought(HEAD - 40n)]);
    const sameSecond: JsonRpc = async (method, params) =>
      method === "eth_getBlockByNumber" ? { timestamp: hex(BigInt(HEAD_TIME)) } : base(method, params);
    const history = await readVaultHistory(sameSecond, { vault: VAULT, buysDone: 1, startAt: HEAD_TIME - 2, chainId: CHAIN });
    expect(history.missingBuys).toBe(0);
    expect(history.note).toBeNull();
    expect(history.entries.map((e) => e.blockNumber)).toEqual([HEAD - 40n]);
  });

  it("says the endpoint refused, when it would serve no window at all", async () => {
    const rpc = chain([], 0n);
    const history = await readVaultHistory(rpc, { vault: VAULT, buysDone: 1, startAt: 0, chainId: CHAIN });
    expect(history.entries).toEqual([]);
    expect(history.note).toMatch(/wouldn't serve the vault's older logs \(block range too large\)/);
  });

  it("shows a buy with no date when its block's time can't be read", async () => {
    const rpc = chain([bought(49_999n)]);
    const flaky: JsonRpc = async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] === hex(49_999n)) throw new Error("unavailable");
      return rpc(method, params);
    };
    const history = await readVaultHistory(flaky, { vault: VAULT, buysDone: 1, startAt: HEAD_TIME - 100, chainId: 1 });
    expect(history.entries[0]?.at).toBeNull();
  });
});

describe("remembering a creation", () => {
  function memory() {
    const items = new Map<string, string>();
    return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
  }
  const creation: VaultCreation = { owner: OWNER, vault: VAULT, nonce: "3", hash: null, at: 1_000 };

  it("keeps a plan's choices and its creation, by chain and plan, and forgets them on request", () => {
    const storage = memory();
    const drafts = new VaultDrafts(storage);
    drafts.set(CHAIN, "dca-vault", { maxSlippageBps: 200, keeperReward: "400", fund: "1000", creation });
    expect(drafts.get(CHAIN, "dca-vault")).toEqual({ maxSlippageBps: 200, keeperReward: "400", fund: "1000", creation });
    expect(drafts.get(1, "dca-vault")).toBeNull();
    drafts.set(CHAIN, "dca-vault", null);
    expect(drafts.get(CHAIN, "dca-vault")).toBeNull();
  });

  it("reads nothing from storage it can't use, and never throws", () => {
    const storage = memory();
    storage.items.set("spdex.vault.drafts.v1", "{not json");
    expect(new VaultDrafts(storage).get(CHAIN, "x")).toBeNull();
    storage.items.set("spdex.vault.drafts.v1", JSON.stringify({ [`${CHAIN}:x`]: { maxSlippageBps: 200, keeperReward: "-1", fund: "0" } }));
    expect(new VaultDrafts(storage).get(CHAIN, "x")).toBeNull();
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(() => new VaultDrafts(refusing).set(CHAIN, "x", null)).not.toThrow();
    expect(new VaultDrafts(refusing).get(CHAIN, "x")).toBeNull();
    expect(new VaultDrafts(null).get(CHAIN, "x")).toBeNull();
  });

  const noCode = { eth_getCode: () => "0x" };

  it("is failed when the creation reverted on chain", async () => {
    const rpc = scripted({ ...noCode, eth_getTransactionReceipt: () => ({ status: "0x0", logs: [] }) });
    const outcome = await settleCreation(rpc, { plan: UNCREATED, creation: { ...creation, hash: `0x${"cd".repeat(32)}` }, factory: FACTORY, nowMs: 2_000 });
    expect(outcome).toEqual({ kind: "failed", note: "The last attempt to create the vault failed on chain; only its network fee was spent. Create it again." });
  });

  it("is still pending while the network holds it, or within the grace", async () => {
    const held = scripted({ ...noCode, eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => ({ hash: "0x" }) });
    expect(await settleCreation(held, { plan: UNCREATED, creation: { ...creation, hash: `0x${"cd".repeat(32)}` }, factory: FACTORY, nowMs: 10 ** 12 })).toEqual({
      kind: "pending",
    });
    const unknown = scripted({ ...noCode });
    expect(await settleCreation(unknown, { plan: UNCREATED, creation, factory: FACTORY, nowMs: creation.at + CREATION_GRACE_MS - 1 })).toEqual({
      kind: "pending",
    });
  });

  it("is failed once the grace has passed with no trace of it", async () => {
    const unknown = scripted({ ...noCode, eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null });
    const outcome = await settleCreation(unknown, { plan: UNCREATED, creation: { ...creation, hash: `0x${"cd".repeat(32)}` }, factory: FACTORY, nowMs: creation.at + CREATION_GRACE_MS });
    // Unknown, said as unknown: a creation sent through a wallet's own
    // private service can land later, and a retry then makes a second vault.
    expect(outcome).toMatchObject({ kind: "failed", note: expect.stringMatching(/^spDEX hasn't seen the last attempt .* wait for it rather than creating a second vault\.$/) });
    expect(outcome).not.toMatchObject({ note: expect.stringMatching(/never reached the network|nothing was spent/) });
  });

  /** The factory's `VaultCreated` for `owner`'s vault at `vault` on `TERMS`, as a receipt carries it. */
  const vaultCreated = (emitter: string, owner: Address) => {
    const address = (a: string) => word(BigInt(a));
    return {
      address: emitter,
      topics: [
        "0xb888b71d90fcdc2e1651a455bddf729f7b1b568ec746d390afa2c35ac599e961",
        `0x${address(owner)}`,
        `0x${address(VAULT)}`,
      ],
      data: `0x${[
        word(0n),
        address(TERMS.tokenOut),
        address(TERMS.pair),
        address(TERMS.oraclePool),
        word(TERMS.amountPerBuy),
        word(TERMS.interval),
        word(TERMS.maxBuys),
        word(TERMS.startAt),
        word(TERMS.keeperReward),
        word(TERMS.maxSlippageBps),
        // funded: what the creation sent, which it doesn't here.
        word(0n),
      ].join("")}`,
    };
  };

  it("is created when the receipt shows the factory made this owner's vault, and only the factory's word counts", async () => {
    expect(decodeVaultEvent(vaultCreated(FACTORY, OWNER))).toMatchObject({ name: "VaultCreated", owner: OWNER, vault: VAULT, terms: TERMS });
    const hash = `0x${"cd".repeat(32)}` as Hex;
    const late = creation.at + CREATION_GRACE_MS;
    const receipt = (logs: unknown[]) =>
      scripted({ ...noCode, eth_getTransactionReceipt: () => ({ status: "0x1", logs }), eth_getTransactionByHash: () => null });
    expect(await settleCreation(receipt([vaultCreated(FACTORY, OWNER)]), { plan: UNCREATED, creation: { ...creation, hash }, factory: FACTORY, nowMs: late })).toEqual({
      kind: "created",
      vault: VAULT,
    });
    // A look-alike from another emitter, or the factory's word about another owner, is not this creation.
    for (const log of [vaultCreated(STRANGER, OWNER), vaultCreated(FACTORY, STRANGER)]) {
      const outcome = await settleCreation(receipt([log]), { plan: UNCREATED, creation: { ...creation, hash }, factory: FACTORY, nowMs: late });
      expect(outcome.kind).toBe("failed");
    }
  });
});

describe("vaults on chain no plan points at", () => {
  const cfg = (...plans: DcaPlan[]) => ({ ...recommendedConfig(), dca: { enabled: false, plans } }) as SpdexConfig;
  const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const read = (overrides: Parameters<typeof state>[0] = {}, account: Address = OWNER): FoundVault => {
    const vaultState = state(overrides);
    const plan = planFromVault({ vault: vaultState.address, terms: vaultState.terms, chainId: CHAIN });
    return { vault: vaultState.address, plan, state: vaultPlanState({ plan, account, read: vaultState, readAtMs: 0 }) };
  };

  it("rebuilds a vault's plan from its own terms: a paused vault plan pointing at it, which its card sees as agreeing", () => {
    const plan = planFromVault({ vault: VAULT, terms: TERMS, chainId: CHAIN });
    expect(plan).toEqual({
      id: vaultPlanId(VAULT),
      paused: true,
      chainId: CHAIN,
      sell: NATIVE_TOKEN,
      buy: SPX,
      amountPerBuy: AMOUNT.toString(),
      intervalSeconds: 3_600,
      maxBuys: 5,
      startAt: START,
      signer: "vault",
      vault: VAULT,
    });
    const card = vaultPlanState({ plan, account: OWNER, read: state(), readAtMs: 0 });
    expect(card).toMatchObject({ kind: "active", mine: true, mismatches: [] });
  });

  it("is added back as a vault plan the config accepts once, and then holds to the vault's rules", () => {
    const plan = planFromVault({ vault: VAULT, terms: TERMS, chainId: CHAIN });
    const added = addDcaPlan(cfg(), plan);
    if (!added.ok) throw new Error(added.error);
    expect(added.config.dca.plans).toEqual([plan]);
    // The id comes from the address: a second click, or a second tab, can't add it twice.
    expect(vaultPlanId(VAULT.toUpperCase().replace("0X", "0x") as Address)).toBe(plan.id);
    expect(addDcaPlan(added.config, plan)).toMatchObject({ ok: false, error: expect.stringMatching(/already a plan/) });
    // Its terms are its vault's, fixed; it is never resumed; its vault never changes.
    expect(updateDcaPlan(added.config, plan.id, { maxBuys: 6 })).toMatchObject({ ok: false, error: expect.stringMatching(/fixed in its vault/) });
    expect(updateDcaPlan(added.config, plan.id, { paused: false })).toMatchObject({ ok: false });
    expect(updateDcaPlan(added.config, plan.id, { vault: at(0xdead) })).toMatchObject({ ok: false });
  });

  it("closes through the vault Guard's checks with that plan, as a card's close does, for its owner only", () => {
    const plan = planFromVault({ vault: VAULT, terms: TERMS, chainId: CHAIN });
    const claim = { address: VAULT, owner: OWNER, nonce: NONCE, terms: TERMS };
    expect(runVaultChecks(closeVaultTx({ chainId: CHAIN, account: OWNER, plan, claim }), CHAIN)).toEqual([]);
    expect(runVaultChecks(closeVaultTx({ chainId: CHAIN, account: STRANGER, plan, claim }), CHAIN).map((v) => v.code)).toContain(
      "VAULT_MALFORMED",
    );
    // A plan rebuilt for another vault doesn't close this one.
    const elsewhere = planFromVault({ vault: at(0xbeef), terms: TERMS, chainId: CHAIN });
    expect(runVaultChecks(closeVaultTx({ chainId: CHAIN, account: OWNER, plan: elsewhere, claim }), CHAIN).map((v) => v.code)).toContain(
      "VAULT_MALFORMED",
    );
  });

  it("carries a deleted plan's vault over from its last read, only when the account owns it", () => {
    const funded = vaultPlanState({ plan: PLAN, account: OWNER, read: state(), readAtMs: 0 });
    expect(foundFromPlan(PLAN, funded, OWNER)).toEqual({
      vault: VAULT,
      plan: planFromVault({ vault: VAULT, terms: TERMS, chainId: CHAIN }),
      state: { ...funded, mismatches: [] },
    });
    // Read while another wallet was connected: still the owner's, and said so.
    const watched = vaultPlanState({ plan: PLAN, account: STRANGER, read: state(), readAtMs: 0 });
    expect(foundFromPlan(PLAN, watched, OWNER)?.state).toMatchObject({ kind: "active", mine: true });
    expect(foundFromPlan(PLAN, watched, STRANGER)).toBeNull();
    // A plan that disagreed with its vault comes back as the vault's own terms.
    const differing = { ...PLAN, maxBuys: 9 };
    const disagreeing = vaultPlanState({ plan: differing, account: OWNER, read: state(), readAtMs: 0 });
    expect(foundFromPlan(differing, disagreeing, OWNER)).toMatchObject({ plan: { maxBuys: 5 }, state: { mismatches: [] } });
    // Nothing to carry: not read, unreadable, no vault.
    expect(foundFromPlan(PLAN, { kind: "loading" }, OWNER)).toBeNull();
    expect(foundFromPlan(PLAN, { kind: "unavailable", code: "unreadable", reason: "down" }, OWNER)).toBeNull();
    expect(foundFromPlan(UNCREATED, { kind: "not-created", note: null }, OWNER)).toBeNull();
  });

  it("lists every known vault no plan on this chain points at, the closed and empty ones apart, someone else's never", () => {
    const open = read();
    const closedEmpty = { ...read({ closed: true, status: { wethBalance: 0n } }), vault: at(2) };
    const closedHolding = { ...read({ closed: true, status: { wethBalance: 5n } }), vault: at(3) };
    const theirs = { ...read({}, STRANGER), vault: at(7) };
    const inPlan = at(5);
    const onOtherChain = at(6);
    const plans: DcaPlan[] = [
      { ...PLAN, id: "here", vault: inPlan },
      { ...PLAN, id: "there", chainId: 1, vault: onOtherChain },
    ];
    const reads = { [VAULT]: open, [at(2)]: closedEmpty, [at(3)]: closedHolding, [at(7)]: theirs };
    const { listed, closed } = strayVaultList({
      known: [VAULT, at(2), at(3), at(4), inPlan, onOtherChain, at(7), VAULT.toUpperCase().replace("0X", "0x") as Address],
      reads,
      plans,
      chainId: CHAIN,
    });
    expect(listed.map((f) => f.vault)).toEqual([VAULT, at(3), at(4), onOtherChain]);
    // Not read yet is "checking", never "nothing".
    expect(listed[2]).toEqual({ vault: at(4), plan: null, state: { kind: "loading" } });
    expect(closed.map((f) => f.vault)).toEqual([at(2)]);
    expect([open, closedEmpty, closedHolding, undefined].map(closedAndEmpty)).toEqual([false, true, false, false]);

    // Just closed from its card: it stays with the card, and the line that says what came back.
    const kept = strayVaultList({ known: [VAULT, at(2)], reads, plans, chainId: CHAIN, inHand: (vault) => vault === at(2) });
    expect(kept.listed.map((f) => f.vault)).toEqual([VAULT, at(2)]);
    expect(kept.closed).toEqual([]);
  });

  it("says how many of the factory's count the page doesn't show, and why; nothing when it shows them all", () => {
    const read = (from: bigint) => ({ vaults: [VAULT], expected: 3n, complete: false, searchedFrom: from });
    expect(vaultSearchNote({ vaults: [VAULT], expected: 1n, complete: true, searchedFrom: 10n }, 1)).toBeNull();
    // A plan's vault the search didn't reach is on the page: it counts.
    expect(vaultSearchNote(read(10n), 3)).toBeNull();
    expect(vaultSearchNote(read(10n), 2)).toEqual({
      missing: 1,
      expected: 3,
      text: "1 of your 3 vaults isn't shown here: it was created before the oldest block this network service let spDEX search.",
      refusal: null,
    });
    expect(vaultSearchNote(read(10n), 1)?.text).toBe(
      "2 of your 3 vaults aren't shown here: they were created before the oldest block this network service let spDEX search.",
    );
    expect(vaultSearchNote({ vaults: [], expected: 2n, complete: false, searchedFrom: 10n }, 0)?.text).toBe(
      "None of your 2 vaults are shown here: they were created before the oldest block this network service let spDEX search.",
    );
    expect(vaultSearchNote({ vaults: [], expected: 1n, complete: false, searchedFrom: 10n }, 0)?.text).toBe(
      "Your vault isn't shown here: it was created before the oldest block this network service let spDEX search.",
    );
    // No log read at all: the service's refusal, its words kept for Details.
    expect(vaultSearchNote({ vaults: [], expected: 2n, complete: false, refusal: "eth_getLogs is disabled" }, 1)).toEqual({
      missing: 1,
      expected: 2,
      text: "1 of your 2 vaults isn't shown here: this network service wouldn't let spDEX search the vault factory's records.",
      refusal: "eth_getLogs is disabled",
    });
  });

  it("counts a vault on the page toward a search's count only when its address proves it one of those counted", () => {
    // VAULT is OWNER's with nonce 3: the fourth vault OWNER created.
    const shown = [{ vault: VAULT, terms: TERMS }];
    expect(provenVaults({ shown, expected: 4n, factory: FACTORY, account: OWNER })).toEqual([VAULT]);
    // Made after a count of three was read: the account's, but not one of the three, and it mustn't stand in for one.
    expect(provenVaults({ shown, expected: 3n, factory: FACTORY, account: OWNER })).toEqual([]);
    // Someone else's, or read with other terms than its own: not the account's vault at that address.
    expect(provenVaults({ shown, expected: 4n, factory: FACTORY, account: STRANGER })).toEqual([]);
    expect(provenVaults({ shown: [{ vault: VAULT, terms: { ...TERMS, maxBuys: 6n } }], expected: 4n, factory: FACTORY, account: OWNER })).toEqual([]);
    // Once, whatever its case.
    const upper = VAULT.toUpperCase().replace("0X", "0x") as Address;
    expect(provenVaults({ shown: [...shown, { vault: upper, terms: TERMS }], expected: 4n, factory: FACTORY, account: OWNER })).toEqual([VAULT]);
  });

  it("searches again after a failure, less often each time, and then stops", () => {
    expect(VAULT_SEARCH_RETRY_MS).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(vaultSearchRetryAt(1, 1_000)).toBe(31_000);
    expect(vaultSearchRetryAt(5, 1_000)).toBe(481_000);
    expect(vaultSearchRetryAt(6, 1_000)).toBeNull();
    expect(vaultSearchRetryAt(0, 1_000)).toBeNull();
    // Worth asking again: no log read, vaults unaccounted for. Not: logs read and cut short, or nothing missing.
    expect(vaultSearchFailed({ vaults: [], expected: 2n, complete: false, refusal: "upstream timed out" }, 0)).toBe(true);
    expect(vaultSearchFailed({ vaults: [], expected: 2n, complete: false, refusal: "upstream timed out" }, 2)).toBe(false);
    expect(vaultSearchFailed({ vaults: [], expected: 2n, complete: false, searchedFrom: 10n }, 0)).toBe(false);
  });

  it("never unfinds a vault an earlier search found, when a later one is cut short", () => {
    const earlier = { vaults: [VAULT, at(1)], expected: 2n, complete: true, searchedFrom: 10n };
    const refused = { vaults: [], expected: 3n, complete: false, refusal: "rate limited" };
    expect(mergeVaultSearches(earlier, refused)).toEqual({ vaults: [VAULT, at(1)], expected: 3n, complete: false, refusal: "rate limited" });
    // What the later one found comes first; together they can make it complete.
    const newer = { vaults: [at(2)], expected: 3n, complete: false, searchedFrom: 50n };
    expect(mergeVaultSearches(earlier, newer)).toEqual({ vaults: [at(2), VAULT, at(1)], expected: 3n, complete: true, searchedFrom: 50n });
    expect(mergeVaultSearches(null, newer)).toEqual(newer);
  });

  it("folds a factory-list search into a log search cut short, keeping the factory's own count", () => {
    const cut = { vaults: [at(2)], expected: 3n, complete: false, searchedFrom: 50n };
    // Every listed owner read: all three found, and the search is complete.
    const whole = { vaults: [at(2), VAULT, at(1)], expected: 3n, complete: true };
    expect(withListSearch(cut, whole)).toEqual({ vaults: [at(2), VAULT, at(1)], expected: 3n, complete: true, searchedFrom: 50n });
    // Some owners unreadable: the list found only what it could, and the
    // count stays the factory's, so the note still says one is missing.
    const partial = { vaults: [VAULT], expected: 1n, complete: false };
    const merged = withListSearch(cut, partial);
    expect(merged).toEqual({ vaults: [VAULT, at(2)], expected: 3n, complete: false, searchedFrom: 50n });
    expect(vaultSearchNote(merged, merged.vaults.length)?.missing).toBe(1);
  });

  it("reads a found vault as unknown, never empty, when the read fails", async () => {
    const down = scripted({
      eth_call: () => {
        throw new Error("rate limited");
      },
    });
    const found = await readFoundVault(down, { vault: VAULT, chainId: CHAIN, account: OWNER, factory: FACTORY });
    expect(found).toMatchObject({ vault: VAULT, plan: null, state: { kind: "unavailable", code: "unreadable", detail: "rate limited" } });
  });

  /** `VaultCreated`'s topic: keccak256 of its signature, held to the factory's ABI by decoding a log that carries it. */
  const VAULT_CREATED = "0xb888b71d90fcdc2e1651a455bddf729f7b1b568ec746d390afa2c35ac599e961";
  const pad = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  const createdLog = (vault: Address, block: bigint) => ({
    address: FACTORY,
    topics: [VAULT_CREATED, pad(OWNER), pad(vault)],
    // The market's index, then the terms (a tuple of static words, inline),
    // then what the creation sent along.
    data: `0x${[0n, BigInt(TERMS.tokenOut), BigInt(TERMS.pair), BigInt(TERMS.oraclePool), AMOUNT, 3_600n, 5n, BigInt(START), REWARD, 200n, 0n].map(word).join("")}`,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: "0x0",
  });

  it("the test's VaultCreated log is one the factory's ABI decodes", () => {
    expect(decodeVaultEvent(createdLog(VAULT, 1n))).toMatchObject({ name: "VaultCreated", emitter: FACTORY, owner: OWNER, vault: VAULT, terms: TERMS });
  });

  it("searches only where there is a factory, and never before its first block", async () => {
    const nowhere = scripted({});
    expect(await searchAccountVaults(nowhere, { chainId: 11155111, account: OWNER, factory: FACTORY })).toBeNull();
    expect(nowhere.calls).toEqual([]);

    const undeployed = scripted({ eth_getCode: () => "0x" });
    expect(await searchAccountVaults(undeployed, { chainId: CHAIN, account: OWNER, factory: FACTORY })).toBeNull();
    expect(undeployed.calls.map((c) => c.method)).toEqual(["eth_getCode"]);

    const head = VAULT_LOGS_FROM_BLOCK + 50n;
    const windows: bigint[] = [];
    const deployed = scripted({
      eth_getCode: () => "0x6080",
      eth_call: () => `0x${word(2n)}`,
      eth_blockNumber: () => `0x${head.toString(16)}`,
      eth_getLogs: (params) => {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        windows.push(BigInt(filter.fromBlock));
        return [createdLog(at(1), VAULT_LOGS_FROM_BLOCK + 3n), createdLog(VAULT, VAULT_LOGS_FROM_BLOCK + 40n)];
      },
    });
    // Both vaults the factory counts, in one query that starts at its first block, not before.
    const found = await searchAccountVaults(deployed, { chainId: CHAIN, account: OWNER, factory: FACTORY });
    expect(found).toEqual({ vaults: [VAULT, at(1)], expected: 2n, complete: true, searchedFrom: VAULT_LOGS_FROM_BLOCK });
    expect(windows).toEqual([VAULT_LOGS_FROM_BLOCK]);
  });

  it("reads no log when the vaults the page shows are every one the factory counts", async () => {
    // Four counted, and the page shows all four: plans' vaults, read, with their terms.
    const shown = [0n, 1n, 2n, 3n].map((nonce) => ({ vault: predictVault({ factory: FACTORY, owner: OWNER, nonce, terms: TERMS }), terms: TERMS }));
    const covered = scripted({
      eth_getCode: () => "0x6080",
      eth_call: () => `0x${word(4n)}`,
      eth_blockNumber: () => `0x${(VAULT_LOGS_FROM_BLOCK + 50n).toString(16)}`,
    });
    expect(await searchAccountVaults(covered, { chainId: CHAIN, account: OWNER, factory: FACTORY, known: shown })).toEqual({
      vaults: [],
      expected: 4n,
      complete: true,
    });
    expect(covered.calls.map((c) => c.method)).toEqual(["eth_getCode", "eth_call", "eth_blockNumber", "eth_call"]);
  });
});
