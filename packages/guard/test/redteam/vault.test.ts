/**
 * Red team: the four transactions around an auto-buy vault, and the proof of
 * SPX held.
 *
 * A vault holds a plan's budget and makes each buy itself, so what the user's
 * wallet signs is only what the host composes around it: creating the vault
 * (funded or not), funding it, closing it, and triggering a due buy. The claim
 * under test is that each is exactly what it says — the claimed release's
 * factory's vault, for this account, on the plan's terms — and that its
 * effects in simulation are the vault's: the money arrives where it should,
 * and nothing else moves. Vaults are created on v2's factory only, with a
 * community window inside the factory's bounds; v1's are still funded, closed
 * and triggered as v1 takes it. Trigger now on a v2 vault is the owner's own,
 * and pays its fee back to the owner.
 *
 * A proof that an address held SPX is the sixth transaction: sent to the
 * registry with no ether, exactly the proof stated, of a block whose hash the
 * person's own service vouches for — a proof built against another block is
 * refused even when every part of it agrees with the rest.
 *
 * The host builds them all itself, and reads the vault's owner, nonce, terms,
 * release and balance, and the proof, over the network. That buys it nothing
 * here. Each case starts from an honest transaction and its honest simulated
 * logs — the shapes a real simulation on the mainnet fork produced, and a
 * proof recorded from mainnet — and changes one thing, so the diff from
 * honest *is* the attack.
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
import type { SimLog, SimulationOutcome } from "@spdex/chain";
import {
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  MAINNET_REGISTRY,
  MIN_SPX,
  V1_MAINNET_FACTORY,
  VAULT_EVENT_TOPICS,
  buyFee,
  decodeRegistryEvent,
  decodeVaultEvent,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeExecuteV1,
  encodeFund,
  encodeProve,
  feeCeiling,
  fundingRoom,
  predictVault,
  registryAddress,
  termsOfPlan,
  vaultBudget,
  type VaultPlan,
  type VaultTerms,
} from "@spdex/vault";
import {
  MAX_PROOF_NODES,
  VaultGuard,
  findVaultNonce,
  readBlockHash,
  runVaultChecks,
  vaultTermsMismatches,
  type VaultClaim,
  type VaultGuardOptions,
  type VaultProveTxPlan,
  type VaultTxPlan,
} from "../../src/vault.js";
import { runScheduleChecks } from "../../src/schedule.js";
import {
  EARLIER,
  FORGED,
  FORGED_HASH,
  FORGED_HEADER,
  HOLDER,
  PROOF,
  PROVEN_TOPIC,
  REGISTRY,
  honestProofLogs,
  notNewerData,
  proveIntent,
  provePlan,
  provenLog,
  serviceBlockHash,
} from "./fixtures/proof.js";

/** The person's own service answers for the proofs' blocks (fixtures/proof.ts); nothing else here asks it. */
const OPTIONS: VaultGuardOptions = { chainId: 1, requireSimulation: false, blockHash: serviceBlockHash };
const FACTORY = MAINNET_FACTORY;
const PAIR = MAINNET_DEPLOYMENT.markets[0].pair;

// ─── The plan, its vault, and what a simulation of each step shows ─────────────

const AMOUNT = 10n ** 16n;
/** The buy fee spDEX proposes for this amount (`buyFee`): 126,000 gas at 0.15 gwei and 0.25% of the buy. */
const REWARD = buyFee(AMOUNT).reward;
const PER_BUY = AMOUNT + REWARD;

/**
 * The vault terms the user chose: three hourly buys of 0.01 ETH of SPX, 3%
 * slippage, and SPX holders' first claim on each buy's fee for 15 minutes (a
 * quarter of the hour: the app's default for it).
 */
const TERMS: VaultPlan = {
  marketIndex: 0n,
  amountPerBuy: AMOUNT,
  interval: 3_600n,
  maxBuys: 3n,
  startAt: NOW,
  keeperReward: REWARD,
  maxSlippageBps: 300n,
  communityWindow: 900n,
  turnBuckets: 0n,
};
const VAULT_TERMS: VaultTerms = termsOfPlan(TERMS);
const VAULT = predictVault({ factory: FACTORY, owner: USER, nonce: 0n, terms: VAULT_TERMS });

/** The same plan's vault had it been made on v1's factory: no window, no turns, 112 bytes of terms. */
const V1_TERMS: VaultTerms = { ...VAULT_TERMS, communityWindow: null, turnBuckets: null };
const V1_VAULT = predictVault({ factory: V1_MAINNET_FACTORY, owner: USER, nonce: 0n, terms: V1_TERMS });

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
  release: "v2",
  ...overrides,
});
const v1Claim = (overrides: Partial<VaultClaim> = {}): VaultClaim => claim({ address: V1_VAULT, terms: { ...V1_TERMS }, release: "v1", ...overrides });

// The factory's and the vault's events, laid out as the contracts emit them.
// The topics are pinned by `decodeVaultEvent` in the first test below: a wrong
// one would decode as nothing, and every honest case would fail.
const TOPIC = {
  created: "0xdde8252e5a53aa5c8343f11a49aae2e554697fa9299741622d063d3152646729",
  bought: "0xa4e7d498bb99e1cbc60382035c43839f92324815f578268f03ea5b8ba4224764",
  v1Bought: "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6",
  funded: "0xc4c14883ae9fd8e26d5d59e3485ed29fd126d781d7e498a4ca5c54c8268e4936",
  closed: "0x6cc09e7b5c3e49861ebe8f6867e1618fbfc14c8d0e968fde37c4243ca02a6f83",
  deposit: "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
  withdrawal: "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
} as const satisfies Record<string, Hex>;

const words = (...values: (bigint | Address)[]): Hex =>
  `0x${values.map((v) => (typeof v === "bigint" ? uint256Data(v).slice(2) : addressTopic(v).slice(2))).join("")}`;

/** v2's `VaultCreated`: owner and vault indexed, then the market, the eleven terms (the window and its turns last) and what was funded. */
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
    data: words(
      marketIndex,
      t.tokenOut,
      t.pair,
      t.oraclePool,
      t.amountPerBuy,
      t.interval,
      t.maxBuys,
      t.startAt,
      t.keeperReward,
      t.maxSlippageBps,
      t.communityWindow ?? 0n,
      t.turnBuckets ?? 0n,
      funded,
    ),
  };
}
/** When the buy fell due: the start of its slot. */
const DUE_SINCE = NOW;
/**
 * v2's `Bought`: slot, caller and `rewardTo` indexed; amountIn, amountOut,
 * reward, then the floor it was held to, its number, the oracle's depth and
 * when it fell due.
 */
const boughtLog = (vault: Address, keeper: Address, out: bigint, amountIn = AMOUNT, reward = REWARD, rewardTo: Address = keeper): SimLog => ({
  address: vault,
  topics: [TOPIC.bought, uint256Data(0n), addressTopic(keeper), addressTopic(rewardTo)],
  data: words(amountIn, out, reward, FLOOR, 1n, 20n * 10n ** 18n, DUE_SINCE),
});
/** v1's `Bought`: no `rewardTo` (it paid the caller) and no `dueSince` (it had no window). */
const v1BoughtLog = (vault: Address, keeper: Address, out: bigint, amountIn = AMOUNT, reward = REWARD): SimLog => ({
  address: vault,
  topics: [TOPIC.v1Bought, uint256Data(0n), addressTopic(keeper)],
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

/** Trigger now on the user's v2 vault: `execute(owner)`, the fee back to the owner, who sends it. */
function triggerPlan(): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "trigger", chainId: 1, account: USER, plan: plan({ vault: VAULT }), vault: claim(), floorOut: FLOOR, rewardTo: USER },
    calls: [{ to: VAULT, data: encodeExecute(USER), value: 0n }],
  };
}
/** The pair is paid from the vault's WETH and pays the owner; the fee follows, to `rewardTo`, the owner. */
const triggerLogs = (owner: Address = USER, vault: Address = VAULT, keeper: Address = USER, reward = REWARD, rewardTo: Address = owner): SimLog[] => [
  transferLog(WETH, vault, PAIR, AMOUNT),
  transferLog(SPX, PAIR, owner, OUT),
  transferLog(WETH, vault, rewardTo, reward),
  boughtLog(vault, keeper, OUT, AMOUNT, reward, rewardTo),
];

/** A due buy of the user's v1 vault: `execute()`, the fee to whoever sends it. */
function v1TriggerPlan(): VaultTxPlan {
  return {
    version: 1,
    intent: { version: 1, action: "trigger", chainId: 1, account: USER, plan: plan({ vault: V1_VAULT }), vault: v1Claim(), floorOut: FLOOR, rewardTo: USER },
    calls: [{ to: V1_VAULT, data: encodeExecuteV1(), value: 0n }],
  };
}
const v1TriggerLogs = (owner: Address = USER, vault: Address = V1_VAULT, keeper: Address = USER, reward = REWARD): SimLog[] => [
  transferLog(WETH, vault, PAIR, AMOUNT),
  transferLog(SPX, PAIR, owner, OUT),
  transferLog(WETH, vault, keeper, reward),
  v1BoughtLog(vault, keeper, OUT, AMOUNT, reward),
];

/** Funding and closing the user's v1 vault: the same calls as v2's, to a vault proved against v1's factory. */
function v1FundPlan(value = ROOM): VaultTxPlan {
  const p = fundPlan(value);
  p.intent = { ...p.intent, plan: plan({ vault: V1_VAULT }), vault: v1Claim() } as VaultTxPlan["intent"];
  p.calls[0]!.to = V1_VAULT;
  return p;
}
function v1ClosePlan(): VaultTxPlan {
  const p = closePlan();
  p.intent = { ...p.intent, plan: plan({ vault: V1_VAULT }), vault: v1Claim() } as VaultTxPlan["intent"];
  p.calls[0]!.to = V1_VAULT;
  return p;
}

// ─── Harness ──────────────────────────────────────────────────────────────────

const guardWith = (logs: SimLog[], options: Partial<typeof OPTIONS> = {}) =>
  new VaultGuard(ScriptedSimulationProvider.succeedingWith(logs), { ...OPTIONS, ...options });

const codes = (v: { violations: { code: GuardViolationCode }[] }) => v.violations.map((x) => x.code);
const codeSet = (v: { violations: { code: GuardViolationCode }[] }) => new Set(codes(v));
const staticCodes = (p: VaultTxPlan | VaultProveTxPlan) => runVaultChecks(p, 1).map((v) => v.code);

// ─── Honest ───────────────────────────────────────────────────────────────────

describe("honest vault transactions", () => {
  it("are laid out as the contracts emit them", () => {
    // Pins the fixtures, not the Guard: decoded by the vault package's own ABI.
    expect([TOPIC.created, TOPIC.bought, TOPIC.v1Bought]).toEqual([VAULT_EVENT_TOPICS.v2.VaultCreated, VAULT_EVENT_TOPICS.v2.Bought, VAULT_EVENT_TOPICS.v1.Bought]);
    expect(decodeVaultEvent(createdLog(USER, VAULT, VAULT_TERMS, FACTORY, 0n, PER_BUY))).toMatchObject({
      name: "VaultCreated",
      source: "v2",
      owner: USER,
      vault: VAULT,
      terms: VAULT_TERMS,
      funded: PER_BUY,
    });
    expect(VAULT_TERMS.communityWindow).toBe(900n);
    expect(decodeVaultEvent(boughtLog(VAULT, USER, OUT))).toMatchObject({
      name: "Bought",
      source: "v2",
      keeper: USER,
      rewardTo: USER,
      amountOut: OUT,
      reward: REWARD,
      floorOut: FLOOR,
      buyNumber: 1n,
      dueSince: DUE_SINCE,
    });
    expect(decodeVaultEvent(boughtLog(VAULT, COLD_WALLET, OUT, AMOUNT, REWARD, USER))).toMatchObject({ keeper: COLD_WALLET, rewardTo: USER });
    expect(decodeVaultEvent(v1BoughtLog(V1_VAULT, USER, OUT))).toMatchObject({ name: "Bought", source: "v1", keeper: USER, rewardTo: USER, dueSince: null });
    expect(decodeVaultEvent(fundedLog(VAULT, 1n))).toMatchObject({ name: "Funded", amount: 1n });
    expect(decodeVaultEvent(closedLog(VAULT, 1n))).toMatchObject({ name: "Closed", amount: 1n });
  });

  it("are v2 vaults, and v1's are where v1's factory puts them", () => {
    // The two layouts: the same plan is a different vault on each factory, and
    // neither is the other's on the other's terms.
    expect(V1_VAULT).not.toBe(VAULT);
    expect(predictVault({ factory: FACTORY, owner: USER, nonce: 0n, terms: V1_TERMS })).not.toBe(V1_VAULT);
    expect(new VaultGuard(new NoSimulationProvider(), OPTIONS).v1Factory).toBe(V1_MAINNET_FACTORY);
    expect(new VaultGuard(new NoSimulationProvider(), OPTIONS).factory).toBe(FACTORY);
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

  it("triggers a due buy of the owner's own vault, its fee back to the owner, inside the community window or after it", async () => {
    // Trigger now names the owner: the one `rewardTo` the window never refuses.
    const verdict = await guardWith(triggerLogs()).check(triggerPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("funds, closes and triggers a v1 vault as v1 takes it: `execute()`, the fee to the caller", async () => {
    expect((await guardWith(fundLogs(ROOM, V1_VAULT)).check(v1FundPlan())).level).toBe("verified");
    expect((await guardWith(closeLogs(V1_VAULT)).check(v1ClosePlan())).level).toBe("verified");
    const verdict = await guardWith(v1TriggerLogs()).check(v1TriggerPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("triggers a due buy of someone else's v1 vault, as a keeper", async () => {
    // The tokens go to the vault's owner and the fee to whoever triggered:
    // v1's rule, for v1's vaults, for good.
    const theirs = predictVault({ factory: V1_MAINNET_FACTORY, owner: COLD_WALLET, nonce: 0n, terms: V1_TERMS });
    const p = v1TriggerPlan();
    p.intent = { ...p.intent, plan: plan({ vault: theirs }), vault: v1Claim({ address: theirs, owner: COLD_WALLET }) } as VaultTxPlan["intent"];
    p.calls = [{ to: theirs, data: encodeExecuteV1(), value: 0n }];
    expect((await guardWith(v1TriggerLogs(COLD_WALLET, theirs, USER)).check(p)).level).toBe("verified");
  });

  it("passes the static layer with nothing to say, for all four, of both releases, and a proof", () => {
    for (const p of [createPlan(), fundPlan(), closePlan(), triggerPlan(), v1FundPlan(), v1ClosePlan(), v1TriggerPlan(), provePlan()]) {
      expect(runVaultChecks(p, 1)).toEqual([]);
    }
  });

  it("holds funding to the same figure as the vault package does", () => {
    // Exactly the room passes; a wei more does not.
    const room = fundingRoom({
      terms: VAULT_TERMS,
      status: { due: true, nextBuyAt: null, buysLeft: 3n, wethBalance: HELD, funded: true, dueSince: null, windowEndsAt: null, turnEndsAt: null, turn: null },
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
    // A buy fee of 0.69% of each buy — within the ceiling, but the host's own
    // intent says the fee spDEX proposes for it, 0.4390%.
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

  it("refuses a creation sent to v1's factory, which would make a vault with no community window", async () => {
    // v1's factory still makes vaults for whoever asks, at their own address
    // with their own terms; spDEX creates on v2's only.
    const p = createPlan();
    p.calls[0]!.to = V1_MAINNET_FACTORY;
    const provider = ScriptedSimulationProvider.succeedingWith(createLogs());
    const verdict = await new VaultGuard(provider, OPTIONS).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]).toMatchObject({ detail: { release: "v1", expected: FACTORY, actual: V1_MAINNET_FACTORY } });
    expect(verdict.violations[0]!.message).toMatch(/v1's factory.*created only on v2's/);
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses a community window out of the factory's bounds, by the factory's own error name", async () => {
    // A minute at least; at most a quarter of the interval, and an hour.
    for (const [interval, communityWindow] of [
      [3_600n, 59n],
      [3_600n, 901n],
      [86_400n, 3_601n],
      [300n, 76n],
    ] as const) {
      const p = createPlan(0n);
      const terms = { ...TERMS, interval, communityWindow };
      p.intent = { ...p.intent, plan: plan({ intervalSeconds: Number(interval) }), terms } as VaultTxPlan["intent"];
      p.calls[0]!.data = encodeCreateVault(terms);
      const verdict = await guardWith([]).check(p);
      expect(codes(verdict), `${communityWindow}s of ${interval}s`).toEqual(["VAULT_MALFORMED"]);
      expect(verdict.violations[0]?.message).toBe("the factory would refuse these terms: CommunityWindowOutOfRange");
    }
    // Each bound itself is a window the factory takes.
    for (const [interval, communityWindow] of [
      [3_600n, 60n],
      [3_600n, 900n],
      [86_400n, 3_600n],
      [300n, 75n],
    ] as const) {
      const p = createPlan(0n);
      const terms = { ...TERMS, interval, communityWindow };
      p.intent = { ...p.intent, plan: plan({ intervalSeconds: Number(interval) }), terms } as VaultTxPlan["intent"];
      p.calls[0]!.data = encodeCreateVault(terms);
      expect(staticCodes(p), `${communityWindow}s of ${interval}s`).toEqual([]);
    }
  });

  it("refuses calldata for another community window than the intent's", async () => {
    const p = createPlan();
    p.calls[0]!.data = encodeCreateVault({ ...TERMS, communityWindow: 60n });
    expect(codes(await guardWith(createLogs()).check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a creation whose terms carry no community window, rather than throwing", async () => {
    const p = createPlan(0n);
    const { communityWindow: _, ...windowless } = TERMS;
    p.intent = { ...p.intent, terms: windowless } as unknown as VaultTxPlan["intent"];
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
  });

  // ── Turns: dormant, every plan the app makes has none, but part of what is checked ──

  it("refuses a creation whose terms carry no turns, rather than throwing", () => {
    const p = createPlan(0n);
    const { turnBuckets: _, ...turnless } = TERMS;
    p.intent = { ...p.intent, terms: turnless } as unknown as VaultTxPlan["intent"];
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses turns the factory would: one bucket, or more than MAX_TURN_BUCKETS", () => {
    for (const turnBuckets of [1n, 65n]) {
      const terms = { ...TERMS, turnBuckets };
      const p = createPlan(0n);
      p.intent = { ...p.intent, terms } as VaultTxPlan["intent"];
      p.calls[0]!.data = encodeCreateVault(terms);
      const violations = runVaultChecks(p, 1);
      expect(violations.map((v) => v.code), String(turnBuckets)).toEqual(["VAULT_MALFORMED"]);
      expect(violations[0]!.detail).toMatchObject({ error: "TurnsOutOfRange" });
    }
  });

  it("lets a plan with turns through the static layer: a later app may create them, and the Guard holds them to the plan", () => {
    const terms = { ...TERMS, turnBuckets: 4n };
    const p = createPlan(0n);
    p.intent = { ...p.intent, terms } as VaultTxPlan["intent"];
    p.calls[0]!.data = encodeCreateVault(terms);
    expect(staticCodes(p)).toEqual([]);
  });

  it("refuses calldata for other turns than the intent's", () => {
    const p = createPlan(0n);
    p.calls[0]!.data = encodeCreateVault({ ...TERMS, turnBuckets: 4n });
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a creation whose factory announces other turns than the plan's", async () => {
    const logs = createLogs();
    logs[1] = createdLog(USER, VAULT, { ...VAULT_TERMS, turnBuckets: 4n }, FACTORY, 0n, PER_BUY);
    const verdict = await guardWith(logs).check(createPlan());
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/turnBuckets/);
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

  it("refuses a vault created with another community window", async () => {
    const logs = createLogs();
    logs[1] = createdLog(USER, VAULT, { ...VAULT_TERMS, communityWindow: 60n }, FACTORY, 0n, PER_BUY);
    const verdict = await guardWith(logs).check(createPlan());
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]?.message).toMatch(/communityWindow/);
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
    p.calls[0]!.data = encodeExecute(USER);
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
    p.calls[0]!.data = encodeExecute(USER);
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

  it("refuses when the fee is paid to someone else", async () => {
    const logs = triggerLogs(USER, VAULT, USER, REWARD, ATTACKER);
    expect(codeSet(await guardWith(logs).check(triggerPlan()))).toEqual(new Set(["VAULT_MALFORMED", "VAULT_NOT_DELIVERED"]));
    const v1 = v1TriggerLogs(USER, V1_VAULT, ATTACKER);
    expect(codeSet(await guardWith(v1).check(v1TriggerPlan()))).toEqual(new Set(["VAULT_MALFORMED", "VAULT_NOT_DELIVERED"]));
  });

  it("refuses a buy made by another caller than the account", async () => {
    // The fee still reaches the owner; the `Bought` names someone else as
    // having made it, so this simulation is not of the transaction signed.
    const verdict = await guardWith(triggerLogs(USER, VAULT, ATTACKER)).check(triggerPlan());
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]!.message).toMatch(/made by/);
  });

  it("refuses when the vault parts with more than one buy and its reward", async () => {
    const logs = [...triggerLogs(), transferLog(WETH, VAULT, ATTACKER, AMOUNT)];
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });

  it("refuses when the vault parts with anything but WETH", async () => {
    const logs = [...triggerLogs(), transferLog(SPX, VAULT, ATTACKER, 1n)];
    expect(codes(await guardWith(logs).check(triggerPlan()))).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });

  it("refuses when anything leaves the owner of a v1 vault someone else triggers", async () => {
    const theirs = predictVault({ factory: V1_MAINNET_FACTORY, owner: COLD_WALLET, nonce: 0n, terms: V1_TERMS });
    const p = v1TriggerPlan();
    p.intent = { ...p.intent, plan: plan({ vault: theirs }), vault: v1Claim({ address: theirs, owner: COLD_WALLET }) } as VaultTxPlan["intent"];
    p.calls[0]!.to = theirs;
    for (const token of [USDC, WETH]) {
      const logs = [...v1TriggerLogs(COLD_WALLET, theirs, USER), transferLog(token, COLD_WALLET, ATTACKER, 1n)];
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

/**
 * Trigger now on a v2 vault is `execute(owner)`: the one `rewardTo` its
 * community window never refuses, and one that pays the fee back to the
 * owner. Naming anyone else is a fee the owner didn't mean to pay, and sending
 * it from anyone else is a network fee spent on someone else's fee.
 */
describe("Red team — Trigger now on a v2 vault", () => {
  it("refuses a Trigger now whose rewardTo isn't the vault's owner, before simulating anything", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith(triggerLogs(USER, VAULT, USER, REWARD, ATTACKER));
    const p = triggerPlan();
    p.intent = { ...p.intent, rewardTo: ATTACKER } as VaultTxPlan["intent"];
    const verdict = await new VaultGuard(provider, OPTIONS).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]).toMatchObject({ detail: { rewardTo: ATTACKER, owner: USER } });
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses calldata that pays anyone else, while the intent says the owner", async () => {
    const p = triggerPlan();
    p.calls[0]!.data = encodeExecute(ATTACKER);
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a Trigger now from anyone but the owner", async () => {
    // Paid back to the owner and sent by someone else: their network fee,
    // the owner's fee. Help run is how anyone else makes a v2 vault's buy.
    const p = triggerPlan();
    p.intent = { ...p.intent, account: COLD_WALLET } as VaultTxPlan["intent"];
    const verdict = await guardWith(triggerLogs(USER, VAULT, COLD_WALLET)).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]).toMatchObject({ detail: { owner: USER, account: COLD_WALLET } });
  });

  it("refuses a Trigger now naming nobody, or something that isn't an address, rather than throwing", () => {
    for (const rewardTo of [undefined, `0x${"0".repeat(40)}`, "0x1234"]) {
      const p = triggerPlan();
      p.intent = { ...p.intent, rewardTo } as unknown as VaultTxPlan["intent"];
      expect(staticCodes(p), String(rewardTo)).toEqual(["VAULT_MALFORMED"]);
    }
  });

  it("refuses v1's `execute()` on a v2 vault, and v2's `execute(owner)` on a v1 vault", () => {
    const v2 = triggerPlan();
    v2.calls[0]!.data = encodeExecuteV1();
    expect(staticCodes(v2)).toEqual(["VAULT_MALFORMED"]);
    const v1 = v1TriggerPlan();
    v1.calls[0]!.data = encodeExecute(USER);
    expect(staticCodes(v1)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a v1 buy said to pay anyone but the account, which v1 pays whoever calls", () => {
    const p = v1TriggerPlan();
    p.intent = { ...p.intent, rewardTo: COLD_WALLET } as VaultTxPlan["intent"];
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a buy logged in the other release's layout", async () => {
    // A v1 vault cannot log v2's `Bought`, nor a v2 vault v1's: the
    // simulation is of some other vault's code.
    const v2 = triggerLogs();
    v2[3] = v1BoughtLog(VAULT, USER, OUT);
    expect(codes(await guardWith(v2).check(triggerPlan()))).toEqual(["VAULT_MALFORMED"]);
    const v1 = v1TriggerLogs();
    v1[3] = boughtLog(V1_VAULT, USER, OUT);
    expect(codes(await guardWith(v1).check(v1TriggerPlan()))).toEqual(["VAULT_MALFORMED"]);
  });
});

/**
 * Which release a vault is decides which factory proves it and which call
 * buys with it. The host reads it from the factory that vouches for the
 * vault; it is believed only as far as the address agrees.
 */
describe("Red team — a claim that lies about its release", () => {
  it("refuses a v1 vault claimed as v2's, with or without a window made up for it", () => {
    for (const terms of [V1_TERMS, VAULT_TERMS]) {
      const p = v1TriggerPlan();
      p.intent = { ...p.intent, vault: v1Claim({ release: "v2", terms: { ...terms } }) } as VaultTxPlan["intent"];
      expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
    }
  });

  it("refuses a v2 vault claimed as v1's, with or without its window", () => {
    for (const terms of [VAULT_TERMS, V1_TERMS]) {
      const p = fundPlan();
      p.intent = { ...p.intent, vault: claim({ release: "v1", terms: { ...terms } }) } as VaultTxPlan["intent"];
      expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
    }
  });

  it("refuses a release it doesn't know, or none", () => {
    for (const release of ["v3", undefined, 2]) {
      const p = closePlan();
      p.intent = { ...p.intent, vault: { ...claim(), release } } as unknown as VaultTxPlan["intent"];
      expect(staticCodes(p), String(release)).toEqual(["VAULT_MALFORMED"]);
    }
  });

  it("refuses a v2 vault's window, or its turns, changed in the claim: the address commits to both", () => {
    for (const terms of [{ ...VAULT_TERMS, communityWindow: 60n }, { ...VAULT_TERMS, turnBuckets: 4n }]) {
      const p = triggerPlan();
      p.intent = { ...p.intent, vault: claim({ terms }) } as VaultTxPlan["intent"];
      const violations = runVaultChecks(p, 1);
      expect(violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);
      expect(violations[0]!.message).toMatch(/is not v2's factory's vault/);
    }
  });

  it("refuses a v1 vault claimed with turns, and a v2 vault claimed without them", () => {
    const p = v1TriggerPlan();
    p.intent = { ...p.intent, vault: v1Claim({ terms: { ...V1_TERMS, turnBuckets: 0n } }) } as VaultTxPlan["intent"];
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
    const q = triggerPlan();
    q.intent = { ...q.intent, vault: claim({ terms: { ...VAULT_TERMS, turnBuckets: null } }) } as VaultTxPlan["intent"];
    expect(staticCodes(q)).toEqual(["VAULT_MALFORMED"]);
  });
});

// ─── A proof of SPX held ──────────────────────────────────────────────────────

const proveGuard = (logs: SimLog[] = honestProofLogs(), options: Partial<VaultGuardOptions> = {}) =>
  new VaultGuard(ScriptedSimulationProvider.succeedingWith(logs), { ...OPTIONS, ...options });

describe("an honest proof of SPX held", () => {
  it("is a real proof, and its record is laid out as the registry logs it", () => {
    // Pins the fixtures, not the Guard: the header hashes to the block's
    // real hash (recorded from mainnet), and the log decodes with the vault
    // package's own ABI.
    expect(PROOF.blockNumber).toBe(26_000_000n);
    expect(PROOF.balance).toBeGreaterThanOrEqual(MIN_SPX);
    expect(REGISTRY).toBe(registryAddress());
    expect(REGISTRY).toBe(MAINNET_DEPLOYMENT.registry);
    expect(new VaultGuard(new NoSimulationProvider(), OPTIONS).registry).toBe(MAINNET_REGISTRY);
    expect(decodeRegistryEvent(provenLog())).toEqual({
      name: "Proven",
      emitter: REGISTRY,
      holder: HOLDER,
      blockNumber: PROOF.blockNumber,
      balance: PROOF.balance,
      validUntil: PROOF.validUntil,
    });
    expect(provenLog().topics[0]).toBe(PROVEN_TOPIC);
  });

  it("passes the static layer with nothing to say", () => {
    expect(runVaultChecks(provePlan(), 1)).toEqual([]);
  });

  it("is verified, proving another address from the connected wallet", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith(honestProofLogs());
    const verdict = await new VaultGuard(provider, OPTIONS).check(provePlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
    expect(provider.lastRequest).toMatchObject({ account: USER, calls: [{ to: REGISTRY, value: 0n }] });
  });

  it("is verified, proving the connected wallet itself", async () => {
    const verdict = await proveGuard().check(provePlan({ account: HOLDER }));
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("asks the person's own service for the block's hash, by number", async () => {
    const asked: bigint[] = [];
    const verdict = await proveGuard(honestProofLogs(), {
      blockHash: async (n) => {
        asked.push(n);
        return serviceBlockHash(n);
      },
    }).check(provePlan());
    expect(verdict.level).toBe("verified");
    expect(asked).toEqual([PROOF.blockNumber]);
  });

  it("reads a block's hash as the service answers it, and nothing for another block or a non-answer", async () => {
    const answer = (block: unknown) => async (method: string, params: unknown[]) => {
      expect([method, params]).toEqual(["eth_getBlockByNumber", ["0x18cba80", false]]);
      return block;
    };
    expect(await readBlockHash(answer({ number: "0x18cba80", hash: PROOF.blockHash.toUpperCase().replace("0X", "0x") }), 26_000_000n)).toBe(PROOF.blockHash);
    expect(await readBlockHash(answer({ number: "0x18cba7f", hash: PROOF.blockHash }), 26_000_000n)).toBeNull();
    expect(await readBlockHash(answer(null), 26_000_000n)).toBeNull();
    expect(await readBlockHash(answer({ number: "0x18cba80", hash: "0x1234" }), 26_000_000n)).toBeNull();
  });
});

describe("Red team — a proof sent anywhere but the registry, or with ether", () => {
  it("refuses a proof sent to another address, before simulating anything", async () => {
    for (const to of [ATTACKER, FACTORY, VAULT, V1_MAINNET_FACTORY]) {
      const provider = ScriptedSimulationProvider.succeedingWith(honestProofLogs());
      const p = provePlan();
      p.calls[0]!.to = to;
      const verdict = await new VaultGuard(provider, OPTIONS).check(p);
      expect(codes(verdict), to).toEqual(["VAULT_MALFORMED"]);
      expect(verdict.violations[0]).toMatchObject({ detail: { expected: REGISTRY, actual: to.toLowerCase() } });
      expect(provider.lastRequest).toBeNull();
    }
  });

  it("refuses a proof carrying ether, a wei of it", async () => {
    const p = provePlan();
    p.calls[0]!.value = 1n;
    expect(codes(await proveGuard().check(p))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a second call riding along", () => {
    const p = provePlan();
    p.calls.push({ to: SPX, data: "0xa9059cbb" as Hex, value: 0n });
    expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses another chain", () => {
    expect(staticCodes(provePlan({ chainId: 8453 }))).toEqual(["CHAIN_MISMATCH"]);
  });

  it("refuses no account to send it, and no holder to prove, rather than throwing", () => {
    expect(staticCodes(provePlan({ account: `0x${"0".repeat(40)}` }))).toEqual(["VAULT_MALFORMED"]);
    const noHolder = provePlan();
    noHolder.intent = { ...noHolder.intent, holder: `0x${"0".repeat(40)}` };
    expect(staticCodes(noHolder)).toEqual(["VAULT_MALFORMED"]);
  });
});

describe("Red team — a proof that isn't the one stated, or of another block", () => {
  it("refuses calldata that differs from the stated proof: another holder, or the halves swapped", () => {
    const other = provePlan();
    other.calls[0]!.data = encodeProve({ holder: ATTACKER, header: PROOF.header, accountProof: PROOF.accountProof, storageProof: PROOF.storageProof });
    expect(staticCodes(other)).toEqual(["VAULT_MALFORMED"]);
    const swapped = provePlan();
    swapped.calls[0]!.data = encodeProve({ holder: HOLDER, header: PROOF.header, accountProof: PROOF.storageProof, storageProof: PROOF.accountProof });
    expect(staticCodes(swapped)).toEqual(["VAULT_MALFORMED"]);
    const earlier = provePlan();
    earlier.calls[0]!.data = encodeProve(EARLIER);
    expect(staticCodes(earlier)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a header for a different block than the one stated: its hash isn't the stated one, nor its number", async () => {
    // Block 25,999,900's real header, sent as block 26,000,000's proof.
    const provider = ScriptedSimulationProvider.succeedingWith(honestProofLogs());
    const p = provePlan({ header: EARLIER.header, accountProof: [...EARLIER.accountProof], storageProof: [...EARLIER.storageProof] });
    const verdict = await new VaultGuard(provider, OPTIONS).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED", "VAULT_MALFORMED"]);
    expect(verdict.violations[0]).toMatchObject({ detail: { expected: PROOF.blockHash, actual: EARLIER.blockHash } });
    expect(verdict.violations[1]).toMatchObject({ detail: { expected: "26000000", actual: "25999900" } });
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses a block hash stated for another block than the header's", () => {
    expect(staticCodes(provePlan({ blockHash: EARLIER.blockHash }))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a header whose number isn't the block stated, even with the hash that goes with it", () => {
    // The real proof of 25,999,900 claimed as block 26,000,000's.
    const p = provePlan({ blockNumber: PROOF.blockNumber }, EARLIER);
    expect(runVaultChecks(p, 1).map((v) => v.detail?.["actual"])).toEqual(["25999900"]);
  });

  it("refuses a proof built against another block even when it agrees with itself: the Guard's own read of the block's hash", async () => {
    // A made-up header for block 26,000,000, its hash stated with it, a state
    // root its proof halves start from, and the calldata exactly that proof:
    // everything consistent but the chain.
    const provider = ScriptedSimulationProvider.succeedingWith(honestProofLogs());
    const p = provePlan({}, FORGED);
    expect(p.intent).toMatchObject({ blockNumber: PROOF.blockNumber, blockHash: FORGED_HASH, header: FORGED_HEADER });
    expect(staticCodes(p)).toEqual([]);
    const verdict = await new VaultGuard(provider, OPTIONS).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]!.message).toMatch(/built against another block/);
    expect(verdict.violations[0]).toMatchObject({ detail: { blockNumber: "26000000", expected: PROOF.blockHash, actual: FORGED_HASH } });
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses a proof whose block the service can't vouch for: no answer, an error, or no way to ask", async () => {
    for (const blockHash of [async () => null, async () => Promise.reject(new Error("HTTP 503")), undefined]) {
      const provider = ScriptedSimulationProvider.succeedingWith(honestProofLogs());
      const options: VaultGuardOptions = { chainId: 1, requireSimulation: false, ...(blockHash === undefined ? {} : { blockHash }) };
      const verdict = await new VaultGuard(provider, options).check(provePlan());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
      expect(verdict.violations[0]!.message).toMatch(/could not be read from your network service/);
      expect(provider.lastRequest).toBeNull();
    }
  });

  it("refuses proof halves of another block's state under the right header, before anything is test-run: they can only revert", async () => {
    // Block 26,000,000's real header, its real hash, the calldata exactly the
    // intent — and the halves of block 25,999,900's state, a real proof of
    // another state. The registry would revert at ~650,000 gas, signed
    // unchecked or not; the host's own builder refuses it, and so does this.
    expect(EARLIER.stateRoot).not.toBe(PROOF.stateRoot);
    for (const [halves, words] of [
      [{ accountProof: [...EARLIER.accountProof], storageProof: [...EARLIER.storageProof] }, /does not start from block 26000000's state root/],
      // The account half the block's own, the balance half another block's: SPX's storage root moved in between.
      [{ storageProof: [...EARLIER.storageProof] }, /balance proof does not start from the storage root its account proof states/],
    ] as const) {
      const provider = ScriptedSimulationProvider.succeedingWith(honestProofLogs());
      const p = provePlan(halves);
      expect(staticCodes(p)).toEqual(["VAULT_MALFORMED"]);
      for (const guard of [new VaultGuard(provider, OPTIONS), new VaultGuard(new NoSimulationProvider(), OPTIONS)]) {
        const verdict = await guard.check(p);
        expect(verdict.level).toBe("rejected");
        expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
        expect(verdict.violations[0]!.message).toMatch(words);
      }
      expect(provider.lastRequest).toBeNull();
    }
  });

  it("refuses a header the registry couldn't read, and a block that isn't stated", () => {
    expect(staticCodes(provePlan({ header: "0x1234" as Hex }))).toEqual(["VAULT_MALFORMED"]);
    expect(staticCodes(provePlan({ blockHash: "0x1234" as Hex }))).toEqual(["VAULT_MALFORMED"]);
    expect(staticCodes(provePlan({ blockNumber: -1n }))).toEqual(["VAULT_MALFORMED"]);
  });

  it(`refuses a proof half that is empty, not bytes, or longer than ${MAX_PROOF_NODES} nodes`, () => {
    // The intent alone changed: such a half can't even be encoded into a call.
    const withIntent = (overrides: Partial<VaultProveTxPlan["intent"]>): VaultProveTxPlan => {
      const p = provePlan();
      p.intent = { ...p.intent, ...overrides };
      return p;
    };
    for (const nodes of [[], ["0x"], ["0xzz"], "0x1234", Array.from({ length: MAX_PROOF_NODES + 1 }, () => PROOF.accountProof[0]!)]) {
      expect(staticCodes(withIntent({ accountProof: nodes as Hex[] })), String(nodes)).toEqual(["VAULT_MALFORMED"]);
      expect(staticCodes(withIntent({ storageProof: nodes as Hex[] })), String(nodes)).toEqual(["VAULT_MALFORMED"]);
    }
  });
});

describe("Red team — a proof whose simulation isn't the registry recording it", () => {
  it("refuses a revert, and says in words that the holder is already proven (`NotNewer`)", async () => {
    const until = PROOF.validUntil + 86_400n;
    const provider = new ScriptedSimulationProvider({
      status: "reverted",
      revertReason: "execution reverted",
      gasUsed: 90_000n,
      logs: [],
      returnData: notNewerData(until),
    } satisfies SimulationOutcome);
    const verdict = await new VaultGuard(provider, OPTIONS).check(provePlan());
    expect(codes(verdict)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toMatch(/^the proof would revert: this address is already proven until /);
    expect(verdict.violations[0]!.detail).toEqual({ reason: "NotNewer" });
  });

  it("refuses a revert it can't read, in the service's own words", async () => {
    const verdict = await new VaultGuard(ScriptedSimulationProvider.reverting("out of gas"), OPTIONS).check(provePlan());
    expect(codes(verdict)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toBe("out of gas");
  });

  it("refuses a simulation in which the registry records nothing: a look-alike's record is no record", async () => {
    expect(codes(await proveGuard([]).check(provePlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
    expect(codes(await proveGuard([provenLog({}, ATTACKER)]).check(provePlan()))).toEqual(["VAULT_NOT_DELIVERED"]);
  });

  it("refuses two records from one proof", async () => {
    expect(codes(await proveGuard([provenLog(), provenLog()]).check(provePlan()))).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses a record for another holder, another block, below the minimum, or valid for another time", async () => {
    for (const figures of [
      { holder: ATTACKER },
      { blockNumber: EARLIER.blockNumber },
      { balance: MIN_SPX - 1n },
      { validUntil: PROOF.validUntil + 1n },
    ]) {
      const verdict = await proveGuard([provenLog(figures)]).check(provePlan());
      expect(codes(verdict), JSON.stringify(figures, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toEqual(["VAULT_MALFORMED"]);
    }
  });

  it("refuses anything leaving the account or the holder, and any allowance either grants", async () => {
    for (const [log, code] of [
      [transferLog(SPX, HOLDER, ATTACKER, 1n), "UNEXPECTED_TOKEN_TRANSFER"],
      [transferLog(WETH, USER, ATTACKER, 1n), "UNEXPECTED_TOKEN_TRANSFER"],
      [transferLog(NATIVE, USER, ATTACKER, 1n), "UNEXPECTED_ETH_TRANSFER"],
      [transferLog(NATIVE, HOLDER, ATTACKER, 1n), "UNEXPECTED_ETH_TRANSFER"],
      [approvalLog(SPX, HOLDER, ATTACKER, 1n), "UNEXPECTED_APPROVAL"],
      [approvalLog(USDC, USER, ATTACKER, 1n), "UNEXPECTED_APPROVAL"],
      [malformedTransferLog(SPX), "UNDECODABLE_EFFECTS"],
    ] as const) {
      expect(codes(await proveGuard([...honestProofLogs(), log]).check(provePlan())), code).toEqual([code]);
    }
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

  it("reports one that sends none as unverified, so closing stays possible, and proving", async () => {
    for (const p of [createPlan(0n), closePlan(), triggerPlan(), v1ClosePlan(), v1TriggerPlan(), provePlan()]) {
      const verdict = await new VaultGuard(new NoSimulationProvider(), OPTIONS).check(p);
      expect(verdict.level).toBe("unverified");
      expect(verdict.warnings.map((w) => w.code)).toEqual(["SIMULATION_UNAVAILABLE"]);
      const flaky = await new VaultGuard(new FlakySimulationProvider(), OPTIONS).check(p);
      expect(flaky.level).toBe("unverified");
    }
  });

  it("refuses those too when the config demands simulation", async () => {
    for (const p of [closePlan(), provePlan()]) {
      const verdict = await new VaultGuard(new NoSimulationProvider(), { ...OPTIONS, requireSimulation: true }).check(p);
      expect(verdict.level).toBe("rejected");
    }
  });

  it("still applies the static checks, and a proof's block check", async () => {
    const p = closePlan();
    p.calls[0]!.to = ATTACKER;
    const verdict = await new VaultGuard(new NoSimulationProvider(), OPTIONS).check(p);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    // A proof built against another block is refused, not merely unchecked.
    const forged = await new VaultGuard(new NoSimulationProvider(), OPTIONS).check(provePlan({}, FORGED));
    expect(forged.level).toBe("rejected");
    expect(codes(forged)).toEqual(["VAULT_MALFORMED"]);
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
