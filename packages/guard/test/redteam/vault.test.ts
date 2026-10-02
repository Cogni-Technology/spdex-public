/**
 * Red team: the four transactions around an auto-buy vault.
 *
 * A vault holds a plan's budget and makes each buy itself, so what the user's
 * wallet signs is only what the host composes around it: creating the vault
 * (funded or not), funding it, closing it, and triggering a due buy. The claim
 * under test is that each is exactly what it says — the factory's vault, for
 * this account, on the plan's terms — and that its effects in simulation are
 * the vault's: the money arrives where it should, and nothing else moves.
 *
 * The host builds all four itself, and reads the vault's owner, nonce, terms
 * and balance over the network. That buys it nothing here. Each case starts
 * from an honest transaction and its honest simulated logs — the shapes a real
 * simulation on the mainnet fork produced — and changes one thing, so the diff
 * from honest *is* the attack.
 *
 * If any of these goes green-to-red, do not ship.
 */

import { describe, expect, it } from "vitest";
import {
  ATTACKER,
  COLD_WALLET,
  NATIVE,
  NOW,
  SPX,
  USDC,
  USER,
  WETH,
  addressTopic,
  approvalLog,
  malformedTransferLog,
  transferLog,
  uint256Data,
  FlakySimulationProvider,
  NoSimulationProvider,
  ScriptedSimulationProvider,
} from "@spdex/testing";
import type { Address, DcaPlan, DcaProgress, GuardViolationCode, Hex, SwapIntent } from "@spdex/core";
import type { SimLog } from "@spdex/chain";
import {
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  buyFee,
  decodeVaultEvent,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  feeCeiling,
  fundingRoom,
  predictVault,
  termsOfPlan,
  vaultBudget,
  type VaultPlan,
  type VaultTerms,
} from "@spdex/vault";
import {
  VaultGuard,
  findVaultNonce,
  runVaultChecks,
  vaultTermsMismatches,
  type VaultClaim,
  type VaultTxPlan,
} from "../../src/vault.js";
import { runScheduleChecks } from "../../src/schedule.js";

const OPTIONS = { chainId: 1, requireSimulation: false };
const FACTORY = MAINNET_FACTORY;
const PAIR = MAINNET_DEPLOYMENT.markets[0].pair;

// ─── The plan, its vault, and what a simulation of each step shows ─────────────

const AMOUNT = 10n ** 16n;
/** The buy fee spDEX proposes for this amount (`buyFee`): 122,000 gas at 0.15 gwei and a tenth more. */
const REWARD = buyFee(AMOUNT).reward;
const PER_BUY = AMOUNT + REWARD;

/** The vault terms the user chose: three hourly buys of 0.01 ETH of SPX, 3% slippage. */
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
const VAULT = predictVault({ factory: FACTORY, owner: USER, nonce: 0n, terms: VAULT_TERMS });

/** The same plan as the config holds it. */
function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
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
  };
}

const claim = (overrides: Partial<VaultClaim> = {}): VaultClaim => ({
  address: VAULT,
  owner: USER,
  nonce: 0n,
  terms: { ...VAULT_TERMS },
  ...overrides,
});

// The factory's and the vault's events, laid out as the contracts emit them.
// The topics are pinned by `decodeVaultEvent` in the first test below: a wrong
// one would decode as nothing, and every honest case would fail.
const TOPIC = {
  created: "0xb888b71d90fcdc2e1651a455bddf729f7b1b568ec746d390afa2c35ac599e961",
  bought: "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6",
  funded: "0xc4c14883ae9fd8e26d5d59e3485ed29fd126d781d7e498a4ca5c54c8268e4936",
  closed: "0x6cc09e7b5c3e49861ebe8f6867e1618fbfc14c8d0e968fde37c4243ca02a6f83",
  deposit: "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
  withdrawal: "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
} as const satisfies Record<string, Hex>;

const words = (...values: (bigint | Address)[]): Hex =>
  `0x${values.map((v) => (typeof v === "bigint" ? uint256Data(v).slice(2) : addressTopic(v).slice(2))).join("")}`;

function createdLog(
  owner: Address,
  vault: Address,
  terms: VaultTerms = VAULT_TERMS,
  emitter: Address = FACTORY,
  marketIndex = 0n,
  funded = 0n,
): SimLog {
  const t = terms;
  return {
    address: emitter,
    topics: [TOPIC.created, addressTopic(owner), addressTopic(vault)],
    data: words(marketIndex, t.tokenOut, t.pair, t.oraclePool, t.amountPerBuy, t.interval, t.maxBuys, t.startAt, t.keeperReward, t.maxSlippageBps, funded),
  };
}
/** `Bought`: amountIn, amountOut, reward, then the floor it was held to, its number and the oracle's depth. */
const boughtLog = (vault: Address, keeper: Address, out: bigint, amountIn = AMOUNT, reward = REWARD): SimLog => ({
  address: vault,
  topics: [TOPIC.bought, uint256Data(0n), addressTopic(keeper)],
  data: words(amountIn, out, reward, FLOOR, 1n, 20n * 10n ** 18n),
});
const fundedLog = (vault: Address, amount: bigint): SimLog => ({ address: vault, topics: [TOPIC.funded], data: words(amount) });
const closedLog = (vault: Address, amount: bigint): SimLog => ({ address: vault, topics: [TOPIC.closed], data: words(amount) });
const depositLog = (who: Address, amount: bigint): SimLog => ({ address: WETH, topics: [TOPIC.deposit, addressTopic(who)], data: words(amount) });
const withdrawalLog = (who: Address, amount: bigint): SimLog => ({
  address: WETH,
  topics: [TOPIC.withdrawal, addressTopic(who)],
  data: words(amount),
});

// ── create ──

/** Create and fund one buy in the same transaction, as the app offers it. */
function createPlan(value = PER_BUY): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "create", chainId: 1, account: USER, plan: plan(), terms: { ...TERMS }, nonce: 0n, nowSeconds: NOW },
    calls: [{ to: FACTORY, data: encodeCreateVault(TERMS), value }],
  };
}
/** What the fork showed for it: ether to the factory, wrapped, passed on to the new vault as WETH. */
const createLogs = (value = PER_BUY): SimLog[] => [
  transferLog(NATIVE, USER, FACTORY, value),
  createdLog(USER, VAULT, VAULT_TERMS, FACTORY, 0n, value),
  transferLog(NATIVE, FACTORY, WETH, value),
  depositLog(FACTORY, value),
  transferLog(WETH, FACTORY, VAULT, value),
];

// ── fund ──

/** One buy already funded at creation; the other two go in now. */
const HELD = PER_BUY;
const ROOM = 3n * PER_BUY - HELD;

function fundPlan(value = ROOM): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "fund", chainId: 1, account: USER, plan: plan({ vault: VAULT }), vault: claim(), buysDone: 0n, wethBalance: HELD },
    calls: [{ to: VAULT, data: encodeFund(), value }],
  };
}
const fundLogs = (value = ROOM, vault: Address = VAULT): SimLog[] => [
  transferLog(NATIVE, USER, vault, value),
  transferLog(NATIVE, vault, WETH, value),
  depositLog(vault, value),
  fundedLog(vault, value),
];

// ── close ──

function closePlan(): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "close", chainId: 1, account: USER, plan: plan({ vault: VAULT }), vault: claim() },
    calls: [{ to: VAULT, data: encodeClose(), value: 0n }],
  };
}
/** Two buys' worth left: unwrapped, and sent to the owner as ether. */
const LEFT = 2n * PER_BUY;
const closeLogs = (vault: Address = VAULT, left = LEFT): SimLog[] => [
  transferLog(NATIVE, WETH, vault, left),
  withdrawalLog(vault, left),
  transferLog(NATIVE, vault, USER, left),
  closedLog(vault, left),
];

// ── trigger ──

const OUT = 4_877_097_969n;
const FLOOR = 4_800_000_000n;

function triggerPlan(): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "trigger", chainId: 1, account: USER, plan: plan({ vault: VAULT }), vault: claim(), floorOut: FLOOR },
    calls: [{ to: VAULT, data: encodeExecute(), value: 0n }],
  };
}
/** The pair is paid from the vault's WETH and pays the owner; the caller's reward follows. */
const triggerLogs = (owner: Address = USER, vault: Address = VAULT, keeper: Address = USER, reward = REWARD): SimLog[] => [
  transferLog(WETH, vault, PAIR, AMOUNT),
  transferLog(SPX, PAIR, owner, OUT),
  transferLog(WETH, vault, keeper, reward),
  boughtLog(vault, keeper, OUT, AMOUNT, reward),
];

// ─── Harness ──────────────────────────────────────────────────────────────────

const guardWith = (logs: SimLog[], options: Partial<typeof OPTIONS> = {}) =>
  new VaultGuard(ScriptedSimulationProvider.succeedingWith(logs), { ...OPTIONS, ...options });

const codes = (v: { violations: { code: GuardViolationCode }[] }) => v.violations.map((x) => x.code);
const codeSet = (v: { violations: { code: GuardViolationCode }[] }) => new Set(codes(v));
const staticCodes = (p: VaultTxPlan) => runVaultChecks(p, 1).map((v) => v.code);

// ─── Honest ───────────────────────────────────────────────────────────────────

describe("honest vault transactions", () => {
  it("are laid out as the contracts emit them", () => {
    // Pins the fixtures, not the Guard: decoded by the vault package's own ABI.
    expect(decodeVaultEvent(createdLog(USER, VAULT, VAULT_TERMS, FACTORY, 0n, PER_BUY))).toMatchObject({
      name: "VaultCreated",
      owner: USER,
      vault: VAULT,
      terms: VAULT_TERMS,
      funded: PER_BUY,
    });
    expect(decodeVaultEvent(boughtLog(VAULT, USER, OUT))).toMatchObject({
      name: "Bought",
      keeper: USER,
      amountOut: OUT,
      reward: REWARD,
      floorOut: FLOOR,
      buyNumber: 1n,
    });
    expect(decodeVaultEvent(fundedLog(VAULT, 1n))).toMatchObject({ name: "Funded", amount: 1n });
    expect(decodeVaultEvent(closedLog(VAULT, 1n))).toMatchObject({ name: "Closed", amount: 1n });
  });

  it("creates a vault and funds its first buy in one transaction", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith(createLogs());
    const verdict = await new VaultGuard(provider, OPTIONS).check(createPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
    // Simulated as the account that will sign it.
    expect(provider.lastRequest?.account).toBe(USER);
  });

  it("creates a vault with nothing in it, and with its whole budget", async () => {
    expect((await guardWith([createdLog(USER, VAULT)]).check(createPlan(0n))).level).toBe("verified");
    const budget = vaultBudget(TERMS);
    expect((await guardWith(createLogs(budget)).check(createPlan(budget))).level).toBe("verified");
  });

  it("funds the rest of the budget", async () => {
    expect((await guardWith(fundLogs()).check(fundPlan())).level).toBe("verified");
  });

  it("funds when the vault sends back what it did not need", async () => {
    // Someone sent the vault WETH after the host read its balance: it keeps
    // what the buys need and returns the rest, which is not a shortfall.
    const kept = ROOM - 1_000n;
    const logs = [
      transferLog(NATIVE, USER, VAULT, ROOM),
      transferLog(NATIVE, VAULT, WETH, kept),
      depositLog(VAULT, kept),
      fundedLog(VAULT, kept),
      transferLog(NATIVE, VAULT, USER, 1_000n),
    ];
    expect((await guardWith(logs).check(fundPlan())).level).toBe("verified");
  });

  it("closes, returning everything as ether", async () => {
    expect((await guardWith(closeLogs()).check(closePlan())).level).toBe("verified");
  });

  it("closes, returning WETH to an owner that cannot take ether", async () => {
    const logs = [
      transferLog(NATIVE, WETH, VAULT, LEFT),
      withdrawalLog(VAULT, LEFT),
      transferLog(NATIVE, VAULT, WETH, LEFT),
      depositLog(VAULT, LEFT),
      transferLog(WETH, VAULT, USER, LEFT),
      closedLog(VAULT, LEFT),
    ];
    expect((await guardWith(logs).check(closePlan())).level).toBe("verified");
  });

  it("triggers a due buy of the owner's own vault", async () => {
    const verdict = await guardWith(triggerLogs()).check(triggerPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("triggers a due buy of someone else's vault, as a keeper", async () => {
    // The tokens go to the vault's owner and the reward to whoever triggered.
    const theirs = predictVault({ factory: FACTORY, owner: COLD_WALLET, nonce: 0n, terms: VAULT_TERMS });
    const p = triggerPlan();
    p.intent = { ...p.intent, plan: plan({ vault: theirs }), vault: claim({ address: theirs, owner: COLD_WALLET }) } as VaultTxPlan["intent"];
    p.calls = [{ to: theirs, data: encodeExecute(), value: 0n }];
    expect((await guardWith(triggerLogs(COLD_WALLET, theirs, USER)).check(p)).level).toBe("verified");
  });

  it("passes the static layer with nothing to say, for all four", () => {
    for (const p of [createPlan(), fundPlan(), closePlan(), triggerPlan()]) expect(runVaultChecks(p, 1)).toEqual([]);
  });

  it("holds funding to the same figure as the vault package does", () => {
    // Exactly the room passes; a wei more does not.
    const room = fundingRoom({
      terms: VAULT_TERMS,
      status: { due: true, nextBuyAt: null, buysLeft: 3n, wethBalance: HELD, funded: true },
    });
    expect(room).toBe(ROOM);
    expect(staticCodes(fundPlan(room))).toEqual([]);
    expect(staticCodes(fundPlan(room + 1n))).toEqual(["VAULT_MALFORMED"]);
  });
});

// ─── Creating ─────────────────────────────────────────────────────────────────

describe("Red team — a creation that is not the plan's vault", () => {
  it("refuses a creation sent anywhere but the factory", async () => {
    // To an address with no code, the ether would simply be gone.
    const p = createPlan();
    p.calls[0]!.to = ATTACKER;
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses calldata for other terms than the intent's", async () => {
    // A buy fee of 0.69% of each buy, to whoever triggers — within the
    // ceiling, but the host's own intent says 0.2013%.
    const p = createPlan();
    p.calls[0]!.data = encodeCreateVault({ ...TERMS, keeperReward: feeCeiling(AMOUNT) });
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses terms that are not the plan's, even encoded faithfully", async () => {
    // Thirty buys where the plan says three: consistent bytes, wrong plan.
    const p = createPlan();
    const terms = { ...TERMS, maxBuys: 30n };
    p.intent = { ...p.intent, terms } as VaultTxPlan["intent"];
    p.calls[0]!.data = encodeCreateVault(terms);
    const verdict = await guardWith(createLogs()).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.detail).toMatchObject({ field: "maxBuys", plan: "3", vault: "30" });
  });

  it("refuses sending more than the plan's whole budget", async () => {
    const p = createPlan(vaultBudget(TERMS) + 1n);
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a second vault for a plan that has one", async () => {
    // The config would point at one and the money would sit in two.
    const p = createPlan();
    p.intent.plan = plan({ vault: VAULT });
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault for a plan that does not sign with one", async () => {
    const p = createPlan();
    p.intent.plan = plan({ signer: "wallet" });
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses terms the factory would refuse, before anyone pays to hear it", async () => {
    // A start two years back: past the factory's year either side of now.
    const p = createPlan(0n);
    const terms = { ...TERMS, startAt: TERMS.startAt - 2n * 366n * 86_400n };
    p.intent = { ...p.intent, plan: plan({ startAt: Number(terms.startAt) }), terms } as VaultTxPlan["intent"];
    p.calls[0]!.data = encodeCreateVault(terms);
    const verdict = await guardWith([]).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toBe("the factory would refuse these terms: StartOutOfRange");
  });

  it("says a buy fee the factory would refuse once, with its figures, not twice", async () => {
    // Half a buy: far past the factory's 0.69%. The ceiling's own refusal
    // names both figures, so the factory's bare `RewardTooLarge` is not added.
    const p = createPlan(0n);
    const terms = { ...TERMS, keeperReward: AMOUNT / 2n };
    p.intent = { ...p.intent, terms } as VaultTxPlan["intent"];
    p.calls[0]!.data = encodeCreateVault(terms);
    const verdict = await guardWith([]).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/above the 0\.69% ceiling/);
    expect(verdict.violations.map((v) => v.message).join(" ")).not.toMatch(/RewardTooLarge/);
  });

  it("refuses a market the factory does not list", async () => {
    const p = createPlan(0n);
    const terms = { ...TERMS, marketIndex: 1n };
    p.intent = { ...p.intent, terms } as VaultTxPlan["intent"];
    p.calls[0]!.data = encodeCreateVault(terms);
    const verdict = await guardWith([]).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/UnknownMarket/);
  });

  it("refuses a creation for another chain, and a plan written for one", async () => {
    const p = createPlan();
    p.intent.chainId = 8453;
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["CHAIN_MISMATCH"]);
    const q = createPlan();
    q.intent.plan = plan({ chainId: 690069 });
    expect(codes(await guardWith(createLogs()).check(q))).toEqual(["CHAIN_MISMATCH"]);
  });

  it("refuses a second call riding along", async () => {
    const p = createPlan();
    p.calls.push({ to: ATTACKER, data: "0x", value: 1n });
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses without simulating anything", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith(createLogs());
    const p = createPlan();
    p.calls[0]!.to = ATTACKER;
    await new VaultGuard(provider, OPTIONS).check(p);
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses an intent that is none of the four", async () => {
    const p = createPlan();
    (p.intent as { action: string }).action = "rescue";
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses an intent with no account, no plan or no usable nonce, rather than throwing", async () => {
    // In the pure checks alone: a caller that runs only them cannot skip these.
    const noAccount = createPlan();
    noAccount.intent.account = `0x${"0".repeat(40)}`;
    expect(staticCodes(noAccount)).toEqual(["VAULT_MALFORMED"]);

    const noPlan = createPlan();
    (noPlan.intent as { plan: unknown }).plan = undefined;
    expect(codes(await guardWith(createLogs()).check(noPlan))).toEqual(["VAULT_MALFORMED"]);

    const badNonce = createPlan();
    badNonce.intent = { ...badNonce.intent, nonce: -1n } as VaultTxPlan["intent"];
    expect(staticCodes(badNonce)).toEqual(["VAULT_MALFORMED"]);
  });
});

/**
 * A buy fee is at most 0.69% of the buy, the network cost included: nobody who
 * triggers a buy, spDEX's developers among them, is ever paid more for it. The
 * factory refuses more, a constant for ever, and the Guard refuses it first,
 * by name and figure, before anyone pays gas to hear it: a draft sized under
 * an older rule (1.69%, and before that up to 10%) or terms from a link can't
 * ask for a vault that pays more.
 */
describe("Red team — a buy fee above the 0.69% ceiling", () => {
  const CEILING = feeCeiling(AMOUNT);
  const withFee = (keeperReward: bigint) => {
    const terms: VaultPlan = { ...TERMS, keeperReward };
    const vaultTerms = termsOfPlan(terms);
    return { terms, vaultTerms, vault: predictVault({ factory: FACTORY, owner: USER, nonce: 0n, terms: vaultTerms }) };
  };
  const createWith = (keeperReward: bigint): VaultTxPlan => {
    const p = createPlan(0n);
    const { terms } = withFee(keeperReward);
    p.intent = { ...p.intent, terms } as VaultTxPlan["intent"];
    p.calls[0]!.data = encodeCreateVault(terms);
    return p;
  };

  it("creates a vault whose buy fee is exactly at the ceiling", async () => {
    expect(CEILING).toBe(69_000_000_000_000n);
    const { vault, vaultTerms } = withFee(CEILING);
    const verdict = await guardWith([createdLog(USER, vault, vaultTerms)]).check(createWith(CEILING));
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("refuses one wei above it, by name and figure, before simulating anything", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith([]);
    const verdict = await new VaultGuard(provider, OPTIONS).check(createWith(CEILING + 1n));
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]).toMatchObject({
      message: "the buy fee is 69000000000001 wei, above the 0.69% ceiling (69000000000000 wei)",
      detail: { reward: "69000000000001", ceiling: "69000000000000" },
    });
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses what older rules allowed: 1.69%, and 10%", async () => {
    for (const reward of [(AMOUNT * 169n) / 10_000n, AMOUNT / 10n]) {
      const p = createWith(reward);
      expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
      const verdict = await guardWith([]).check(p);
      expect(verdict.violations.map((v) => v.message)).toEqual([expect.stringMatching(/above the 0\.69% ceiling/)]);
    }
  });

  // Only creations are held to the ceiling. This factory cannot make a vault
  // that pays more, but a later release with a lower ceiling would meet vaults
  // made under this one, and refusing to fund, close or trigger them would
  // trap their owners' money.
  it("still funds, closes and triggers a vault whose terms pay more than the ceiling", async () => {
    const reward = AMOUNT / 10n;
    const { vault, vaultTerms } = withFee(reward);
    const perBuy = AMOUNT + reward;
    const claim10 = claim({ address: vault, terms: vaultTerms });

    const fund = fundPlan(2n * perBuy);
    fund.intent = { ...fund.intent, plan: plan({ vault }), vault: claim10, wethBalance: perBuy } as VaultTxPlan["intent"];
    fund.calls[0]!.to = vault;
    expect((await guardWith(fundLogs(2n * perBuy, vault)).check(fund)).level).toBe("verified");

    const close = closePlan();
    close.intent = { ...close.intent, plan: plan({ vault }), vault: claim10 } as VaultTxPlan["intent"];
    close.calls[0]!.to = vault;
    expect((await guardWith(closeLogs(vault, 2n * perBuy)).check(close)).level).toBe("verified");

    const trigger = triggerPlan();
    trigger.intent = { ...trigger.intent, plan: plan({ vault }), vault: claim10 } as VaultTxPlan["intent"];
    trigger.calls[0]!.to = vault;
    const verdict = await guardWith(triggerLogs(USER, vault, USER, reward)).check(trigger);
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });
});

describe("Red team — a creation whose simulation is not the plan's vault", () => {
  it("refuses a look-alike announcement from anyone but the factory", async () => {
    // Any contract can emit VaultCreated's exact signature.
    const logs = createLogs();
    logs[1] = createdLog(USER, VAULT, VAULT_TERMS, ATTACKER);
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault created for someone else", async () => {
    const logs = createLogs();
    logs[1] = createdLog(ATTACKER, VAULT);
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault created on another market", async () => {
    const logs = createLogs();
    logs[1] = createdLog(USER, VAULT, VAULT_TERMS, FACTORY, 1n);
    const verdict = await guardWith(logs).check(createPlan());
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/market 1/);
  });

  it("refuses a vault created on other terms", async () => {
    const logs = createLogs();
    logs[1] = createdLog(USER, VAULT, { ...VAULT_TERMS, maxSlippageBps: 500n });
    const verdict = await guardWith(logs).check(createPlan());
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/maxSlippageBps/);
  });

  it("refuses a vault created somewhere other than predicted", async () => {
    // The host records the predicted address in the plan; a vault elsewhere
    // would leave the config pointing at nothing.
    const elsewhere = predictVault({ factory: FACTORY, owner: USER, nonce: 1n, terms: VAULT_TERMS });
    const logs = createLogs();
    logs[1] = createdLog(USER, elsewhere);
    logs[4] = transferLog(WETH, FACTORY, elsewhere, PER_BUY);
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses two vaults from one creation", async () => {
    const logs = [...createLogs(), createdLog(USER, VAULT)];
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses when the budget does not arrive in the vault", async () => {
    const logs = createLogs();
    logs[4] = transferLog(WETH, FACTORY, ATTACKER, PER_BUY);
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when more ether leaves the account than it sends", async () => {
    const logs = [...createLogs(), transferLog(NATIVE, USER, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["UNEXPECTED_ETH_TRANSFER"]);
  });

  it("refuses when a token leaves the account", async () => {
    for (const token of [SPX, WETH]) {
      const logs = [...createLogs(), transferLog(token, USER, ATTACKER, 1n)];
      expect(codes(await guardWith(logs).check(createPlan())), token).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
    }
  });

  it("refuses when the account's WETH is unwrapped out from under it", async () => {
    // No Transfer at all: only a Withdrawal says the account's WETH is gone.
    const logs = [...createLogs(), withdrawalLog(USER, 5n), transferLog(NATIVE, WETH, ATTACKER, 5n)];
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });

  it("refuses an allowance granted by the account", async () => {
    const logs = [...createLogs(), approvalLog(SPX, USER, ATTACKER, 2n ** 256n - 1n)];
    expect(codes(await guardWith(logs).check(createPlan()))).toEqual(["UNEXPECTED_APPROVAL"]);
  });

  it("refuses effects it cannot decode, a wrap included", async () => {
    expect(codes(await guardWith([...createLogs(), malformedTransferLog(SPX)]).check(createPlan()))).toEqual([
      "UNDECODABLE_EFFECTS",
    ]);
    const badWrap: SimLog = { address: WETH, topics: [TOPIC.deposit], data: "0x" };
    expect(codes(await guardWith([...createLogs(), badWrap]).check(createPlan()))).toEqual(["UNDECODABLE_EFFECTS"]);
  });

  it("refuses a reverting creation", async () => {
    const guard = new VaultGuard(ScriptedSimulationProvider.reverting("StartOutOfRange()"), OPTIONS);
    expect(codes(await guard.check(createPlan()))).toEqual(["SIMULATION_REVERTED"]);
  });
});

// ─── Funding ──────────────────────────────────────────────────────────────────

describe("Red team — funding anything but the plan's own vault, within its needs", () => {
  it("refuses a vault the factory did not make", async () => {
    // The host read "a vault" at an address the config names. Its owner,
    // nonce and terms do not put a factory vault there.
    const p = fundPlan();
    p.intent = { ...p.intent, plan: plan({ vault: ATTACKER }), vault: claim({ address: ATTACKER }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = ATTACKER;
    expect(codes(await guardWith(fundLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses terms the real vault does not have, which would widen the room", async () => {
    // Claiming ten buys for a three-buy vault: the address gives it away.
    const p = fundPlan();
    p.intent = { ...p.intent, vault: claim({ terms: { ...VAULT_TERMS, maxBuys: 10n } }) } as VaultTxPlan["intent"];
    expect(codes(await guardWith(fundLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses someone else's genuine vault", async () => {
    // Real, made by the factory — and not the account's.
    const theirs = predictVault({ factory: FACTORY, owner: ATTACKER, nonce: 0n, terms: VAULT_TERMS });
    const p = fundPlan();
    p.intent = { ...p.intent, plan: plan({ vault: theirs }), vault: claim({ address: theirs, owner: ATTACKER }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = theirs;
    expect(codes(await guardWith(fundLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault other than the one the plan names", async () => {
    const other = predictVault({ factory: FACTORY, owner: USER, nonce: 1n, terms: VAULT_TERMS });
    const p = fundPlan();
    p.intent = { ...p.intent, vault: claim({ address: other, nonce: 1n }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = other;
    expect(codes(await guardWith(fundLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault whose terms differ from the plan", async () => {
    // A config edited to thirty buys, pointing at the three-buy vault.
    const p = fundPlan();
    p.intent.plan = plan({ vault: VAULT, maxBuys: 30 });
    expect(codes(await guardWith(fundLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses more than the remaining buys need", async () => {
    expect(codes(await guardWith(fundLogs()).check(fundPlan(ROOM + 1n)))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses funding a vault that already holds what it needs", async () => {
    const p = fundPlan(1n);
    p.intent = { ...p.intent, wethBalance: 3n * PER_BUY } as VaultTxPlan["intent"];
    const verdict = await guardWith(fundLogs(1n)).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/already holds what its remaining buys/);
  });

  it("refuses funding with nothing", async () => {
    expect(codes(await guardWith([]).check(fundPlan(0n)))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses progress that cannot be true", async () => {
    // More buys done than the vault has: the room would be negative.
    const p = fundPlan();
    p.intent = { ...p.intent, buysDone: 4n } as VaultTxPlan["intent"];
    const verdict = await guardWith(fundLogs()).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/progress or balance, as read, cannot be true/);
  });

  it("refuses a call that is not `fund`", async () => {
    const p = fundPlan();
    p.calls[0]!.data = encodeExecute();
    expect(codes(await guardWith(fundLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses when the vault's WETH does not rise by what left the account", async () => {
    const logs = fundLogs();
    logs[2] = depositLog(ATTACKER, ROOM);
    expect(codes(await guardWith(logs).check(fundPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when the vault keeps the ether without wrapping any of it", async () => {
    const logs = [transferLog(NATIVE, USER, VAULT, ROOM)];
    expect(codes(await guardWith(logs).check(fundPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when more ether leaves the account than the funding", async () => {
    const logs = [...fundLogs(), transferLog(NATIVE, USER, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(fundPlan()))).toEqual(["UNEXPECTED_ETH_TRANSFER"]);
  });
});

// ─── Closing ──────────────────────────────────────────────────────────────────

describe("Red team — closing", () => {
  it("refuses closing a vault the account does not own", async () => {
    const theirs = predictVault({ factory: FACTORY, owner: ATTACKER, nonce: 0n, terms: VAULT_TERMS });
    const p = closePlan();
    p.intent = { ...p.intent, plan: plan({ vault: theirs }), vault: claim({ address: theirs, owner: ATTACKER }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = theirs;
    expect(codes(await guardWith(closeLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a close sent to another contract", async () => {
    // `close()` on a contract the account once approved could spend that
    // allowance; only the proved vault is a close target.
    const p = closePlan();
    p.calls[0]!.to = ATTACKER;
    expect(codes(await guardWith(closeLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses ether attached to a close", async () => {
    const p = closePlan();
    p.calls[0]!.value = 1n;
    expect(codes(await guardWith(closeLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a call that is not `close`", async () => {
    const p = closePlan();
    p.calls[0]!.data = encodeExecute();
    expect(codes(await guardWith(closeLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("still closes a vault whose terms differ from the plan", async () => {
    // Getting one's money back is never held to the config agreeing.
    const p = closePlan();
    p.intent.plan = plan({ vault: VAULT, maxBuys: 30 });
    expect((await guardWith(closeLogs()).check(p)).level).toBe("verified");
  });

  it("refuses when the vault's money goes anywhere but the owner", async () => {
    const logs = closeLogs();
    logs[2] = transferLog(NATIVE, VAULT, ATTACKER, LEFT);
    expect(codes(await guardWith(logs).check(closePlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when the vault gives up any other token to someone else", async () => {
    const logs = [...closeLogs(), transferLog(SPX, VAULT, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(closePlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when anything leaves the account", async () => {
    const logs = [...closeLogs(), transferLog(SPX, USER, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(closePlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });
});

// ─── Triggering a buy ─────────────────────────────────────────────────────────

describe("Red team — a triggered buy", () => {
  it("refuses a buy with no floor to hold it to", async () => {
    const p = triggerPlan();
    p.intent = { ...p.intent, floorOut: 0n } as VaultTxPlan["intent"];
    expect(codes(await guardWith(triggerLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses ether attached to a trigger", async () => {
    const p = triggerPlan();
    p.calls[0]!.value = 1n;
    expect(codes(await guardWith(triggerLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a call that is not `execute`", async () => {
    const p = triggerPlan();
    p.calls[0]!.data = encodeClose();
    expect(codes(await guardWith(triggerLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault the factory did not make", async () => {
    const p = triggerPlan();
    p.intent = { ...p.intent, plan: plan({ vault: ATTACKER }), vault: claim({ address: ATTACKER }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = ATTACKER;
    expect(codes(await guardWith(triggerLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a vault whose terms differ from the plan", async () => {
    const p = triggerPlan();
    p.intent.plan = plan({ vault: VAULT, amountPerBuy: "1" });
    expect(codes(await guardWith(triggerLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses when the owner receives less than the floor", async () => {
    const logs = triggerLogs();
    logs[1] = transferLog(SPX, PAIR, USER, FLOOR - 1n);
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when the tokens go to anyone but the owner", async () => {
    const logs = triggerLogs();
    logs[1] = transferLog(SPX, PAIR, ATTACKER, OUT);
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses when the reward is credited to someone else", async () => {
    const logs = triggerLogs(USER, VAULT, ATTACKER);
    expect(codeSet(await guardWith(logs).check(triggerPlan()))).toEqual(new Set(["VAULT_MALFORMED", "VAULT_NOT_DELIVERED"]));
  });

  it("refuses when the vault parts with more than one buy and its reward", async () => {
    const logs = [...triggerLogs(), transferLog(WETH, VAULT, ATTACKER, AMOUNT)];
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });

  it("refuses when the vault parts with anything but WETH", async () => {
    const logs = [...triggerLogs(), transferLog(SPX, VAULT, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });

  it("refuses when anything leaves the owner of a vault someone else triggers", async () => {
    const theirs = predictVault({ factory: FACTORY, owner: COLD_WALLET, nonce: 0n, terms: VAULT_TERMS });
    const p = triggerPlan();
    p.intent = { ...p.intent, plan: plan({ vault: theirs }), vault: claim({ address: theirs, owner: COLD_WALLET }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = theirs;
    for (const token of [USDC, WETH]) {
      const logs = [...triggerLogs(COLD_WALLET, theirs, USER), transferLog(token, COLD_WALLET, ATTACKER, 1n)];
      expect(codes(await guardWith(logs).check(p)), token).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
    }
  });

  it("refuses a simulation that shows no buy, or two", async () => {
    const none = triggerLogs().filter((log) => log.topics[0] !== TOPIC.bought);
    expect(codes(await guardWith(none).check(triggerPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
    const two = [...triggerLogs(), boughtLog(VAULT, USER, OUT)];
    expect(codes(await guardWith(two).check(triggerPlan()))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses when anything leaves the account that triggers", async () => {
    // Balances are measured net, as everywhere in the Guard: a token the
    // account receives here and loses again shows up as receiving less.
    const logs = [...triggerLogs(), transferLog(USDC, USER, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
    const reward = [...triggerLogs(), transferLog(WETH, USER, ATTACKER, 1n)];
    expect(codes(await guardWith(reward).check(triggerPlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });
});

// ─── Without a simulation ─────────────────────────────────────────────────────

describe("when simulation is unavailable", () => {
  it("never signs a transaction that sends ether unchecked, whatever the setting", async () => {
    // The code at a fixed address is the one thing the static layer cannot
    // establish, and ether sent where there is none is lost.
    for (const p of [createPlan(), fundPlan()]) {
      for (const provider of [new NoSimulationProvider(), new FlakySimulationProvider()]) {
        const verdict = await new VaultGuard(provider, OPTIONS).check(p);
        expect(verdict.level).toBe("rejected");
        expect(codes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
      }
    }
  });

  it("reports one that sends none as unverified, so closing stays possible", async () => {
    for (const p of [createPlan(0n), closePlan(), triggerPlan()]) {
      const verdict = await new VaultGuard(new NoSimulationProvider(), OPTIONS).check(p);
      expect(verdict.level).toBe("unverified");
      expect(verdict.warnings.map((w) => w.code)).toEqual(["SIMULATION_UNAVAILABLE"]);
      const flaky = await new VaultGuard(new FlakySimulationProvider(), OPTIONS).check(p);
      expect(flaky.level).toBe("unverified");
    }
  });

  it("refuses those too when the config demands simulation", async () => {
    const verdict = await new VaultGuard(new NoSimulationProvider(), { ...OPTIONS, requireSimulation: true }).check(closePlan());
    expect(verdict.level).toBe("rejected");
  });

  it("still applies the static checks", async () => {
    const p = closePlan();
    p.calls[0]!.to = ATTACKER;
    const verdict = await new VaultGuard(new NoSimulationProvider(), OPTIONS).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
  });
});

// ─── The rest of the Guard, and the host's helpers ────────────────────────────

describe("a vault plan elsewhere in the Guard", () => {
  it("is never a scheduled buy, even with its pause removed", () => {
    // The schema pins a vault plan paused; a hand-built one without that is
    // still refused, by name, because its vault makes its buys.
    const intent: SwapIntent = {
      version: 1,
      chainId: 1,
      account: USER,
      recipient: USER,
      tokenIn: NATIVE,
      tokenOut: SPX,
      maxAmountIn: AMOUNT,
      minAmountOut: FLOOR,
      deadline: NOW + 600n,
      nonce: "0x01",
    };
    const progress: DcaProgress = { planId: "dca-vault", chainId: 1, owner: USER, signer: USER, buysDone: 0, committed: 0n, lastSlot: null };
    const violations = runScheduleChecks({
      plan: plan({ paused: false }),
      progress,
      slot: 0,
      intents: [intent],
      chainId: 1,
      nowSeconds: NOW,
    });
    expect(violations.map((v) => v.code)).toEqual(["SCHEDULE_MISMATCH"]);
    expect(violations[0]?.message).toMatch(/made by its vault, never by this tab/);
  });
});

describe("the host's helpers", () => {
  it("find the nonce a vault was made with, and nothing for a vault that is not one", () => {
    const third = predictVault({ factory: FACTORY, owner: USER, nonce: 2n, terms: VAULT_TERMS });
    expect(findVaultNonce({ factory: FACTORY, owner: USER, terms: VAULT_TERMS, vault: third, below: 5n })).toBe(2n);
    // Not below the factory's count yet, so not made yet.
    expect(findVaultNonce({ factory: FACTORY, owner: USER, terms: VAULT_TERMS, vault: third, below: 2n })).toBeNull();
    expect(findVaultNonce({ factory: FACTORY, owner: ATTACKER, terms: VAULT_TERMS, vault: third, below: 5n })).toBeNull();
  });

  it("name each field where a vault differs from its plan", () => {
    expect(vaultTermsMismatches(plan(), VAULT_TERMS)).toEqual([]);
    expect(vaultTermsMismatches(plan({ maxBuys: 4, startAt: 1 }), VAULT_TERMS)).toEqual([
      { field: "maxBuys", plan: "4", vault: "3" },
      { field: "startAt", plan: "1", vault: NOW.toString() },
    ]);
    // A field that is not a number differs, rather than being skipped.
    expect(vaultTermsMismatches(plan({ amountPerBuy: "ten" }), VAULT_TERMS).map((m) => m.field)).toEqual(["amountPerBuy"]);
  });
});
