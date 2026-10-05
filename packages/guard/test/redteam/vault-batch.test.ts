/**
 * Red team: a batch of due buys in other people's vaults ("Help run the
 * network"), sent from the user's wallet through the batcher.
 *
 * The user pays the network fee and is paid the vaults' buy fees. The claim
 * under test is that the one transaction they sign is exactly that: spDEX's
 * batcher, bound to no factory, every fee to their own account, no ether, the
 * host's own gas for each vault, the exact gas limit and price the simulation
 * ran at, every listed address proved — before anything is simulated — to be
 * a vault a listed factory made, every vault tried and each buy the vault's
 * own, paid by the vault straight to the account with nothing passing through
 * the batcher — and that nothing of theirs moves but the fees arriving. The
 * batcher calls whatever it is given, so the proof of each vault is the
 * Guard's alone. A vault that may not pay them inside its community window
 * costs only its attempt; a v1 vault is no part of it. It is never signed
 * unchecked.
 *
 * Each case starts from an honest batch and its honest simulated logs
 * (fixtures/batch.ts) and changes one thing. If any goes green-to-red, do not
 * ship.
 */

import { describe, expect, it } from "vitest";
import {
  ATTACKER,
  NATIVE,
  SPX,
  USDC,
  USER,
  WETH,
  approvalLog,
  transferLog,
  FlakySimulationProvider,
  NoSimulationProvider,
  ScriptedPairProvider,
  ScriptedSimulationProvider,
} from "@spdex/testing";
import { EthSimulateV1Provider, type SimLog, type SimulationOutcome } from "@spdex/chain";
import type { GuardViolationCode, Hex } from "@spdex/core";
import {
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  MAX_BATCH_GAS_CEILING,
  V1_MAINNET_BATCHER,
  V1_MAINNET_FACTORY,
  VAULT_EVENT_TOPICS,
  batchGasLimit,
  batcherAddress,
  decodeBatcherEvent,
  decodeVaultEvent,
  encodeExecuteBatch,
  predictVault,
  reasonName,
} from "@spdex/vault";
import { MAX_BATCH_TRIGGER_VAULTS, VaultGuard, runVaultChecks, type VaultBatchTxPlan, type VaultClaim } from "../../src/vault.js";
import { SecondOpinionPair } from "../../src/second-opinion.js";
import {
  AMOUNT,
  BATCHER,
  BOUGHT_TOPIC,
  CLAIMS,
  DUE_SINCE,
  EARNED,
  FLOOR,
  GAS_LIMIT,
  GAS_PRICE,
  MIN_REWARDS,
  O1,
  O2,
  OUT,
  PAIR,
  REASONS,
  REWARD,
  V1,
  V1_BOUGHT_TOPIC,
  V2,
  batchCall,
  batchLog,
  batchPlan,
  boughtLog,
  claimOf,
  honestBatchLogs,
  notTriggeredLog,
  nothingBoughtData,
  triggeredLog,
  v1BatchLog,
  v1BoughtLog,
  vaultBuy,
  VAULT_TERMS,
} from "./fixtures/batch.js";

const OPTIONS = { chainId: 1, requireSimulation: false };

const guardWith = (logs: SimLog[], options: Partial<typeof OPTIONS> = {}) =>
  new VaultGuard(ScriptedSimulationProvider.succeedingWith(logs), { ...OPTIONS, ...options });

const codes = (v: { violations: { code: GuardViolationCode }[] }) => v.violations.map((x) => x.code);
const staticCodes = (p: VaultBatchTxPlan) => runVaultChecks(p, 1).map((v) => v.code);

/** Where the honest logs keep the first vault's fee, paid straight to the account, and its `Bought`. */
const FEE_INDEX = 2;
const BOUGHT_INDEX = 3;

/** The honest logs with one replaced, by position. */
const replacing = (index: number, log: SimLog): SimLog[] => honestBatchLogs().map((l, i) => (i === index ? log : l));

// ─── Honest ───────────────────────────────────────────────────────────────────

describe("an honest batch", () => {
  it("is laid out as the batcher and the vaults emit it", () => {
    // Pins the fixtures, not the Guard: decoded by the vault package's own ABI.
    // Built for WETH and bound to no factory: one address, whatever the release.
    expect(BATCHER).toBe(batcherAddress(MAINNET_DEPLOYMENT.weth));
    // And each vault is where v2's factory puts its owner's first vault.
    expect(CLAIMS.map((c) => predictVault({ factory: MAINNET_FACTORY, owner: c.owner, nonce: c.nonce, terms: c.terms }))).toEqual([V1, V2]);
    expect([BOUGHT_TOPIC, V1_BOUGHT_TOPIC]).toEqual([VAULT_EVENT_TOPICS.v2.Bought, VAULT_EVENT_TOPICS.v1.Bought]);
    const at = (log: SimLog, logIndex: number) => ({ ...log, logIndex });
    // v2's `Batch` has no `swept`: decoded, it is 0 by construction, not a figure.
    expect(decodeBatcherEvent(BATCHER, at(batchLogFor(), 0))).toMatchObject({ name: "Batch", source: "v2", caller: USER, rewardTo: USER, bought: 2n, earned: EARNED, swept: 0n });
    expect(decodeBatcherEvent(BATCHER, at(v1BatchLog({ swept: 5n }), 0))).toMatchObject({ name: "Batch", source: "v1", swept: 5n });
    expect(decodeBatcherEvent(BATCHER, at(triggeredLog(V1), 1))).toMatchObject({ name: "Triggered", vault: V1 });
    expect(decodeBatcherEvent(BATCHER, at(notTriggeredLog(V1, REASONS.TooSoon), 2))).toMatchObject({ name: "NotTriggered", vault: V1, reasonName: "TooSoon" });
    expect(decodeVaultEvent(boughtLog(V1))).toMatchObject({
      name: "Bought",
      source: "v2",
      emitter: V1,
      keeper: BATCHER,
      rewardTo: USER,
      amountIn: AMOUNT,
      amountOut: OUT,
      reward: REWARD,
      floorOut: FLOOR,
      dueSince: DUE_SINCE,
    });
    expect(decodeVaultEvent(v1BoughtLog(V1))).toMatchObject({ name: "Bought", source: "v1", keeper: BATCHER, rewardTo: BATCHER, dueSince: null });
    for (const [name, code] of Object.entries(REASONS)) expect(reasonName(code)).toBe(name);
  });

  it("passes the static layer with nothing to say", () => {
    expect(runVaultChecks(batchPlan(), 1)).toEqual([]);
  });

  it("is verified, simulated from the account at exactly its gas limit", async () => {
    const provider = ScriptedSimulationProvider.succeedingWith(honestBatchLogs());
    const verdict = await new VaultGuard(provider, OPTIONS).check(batchPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
    expect(provider.lastRequest).toMatchObject({ account: USER, gas: GAS_LIMIT, calls: [{ to: BATCHER, value: 0n }] });
    // The call as simulated carries no gas fields of its own: the request's `gas` is the limit.
    expect(Object.keys(provider.lastRequest!.calls[0]!).sort()).toEqual(["data", "to", "value"]);
  });

  it("is verified when one vault isn't due, which only costs its attempt", async () => {
    const logs = [...vaultBuy(V1, O1), notTriggeredLog(V2, REASONS.TooSoon), batchLog({ bought: 1n, earned: REWARD })];
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("is verified when one vault may not pay the account inside its community window, which only costs its attempt too", async () => {
    // An eligibility that lapsed between the offer and the test-run, or a
    // window still open: the vault refuses (`NotEligible`), its owner is no
    // worse off, and the batch still pays for itself.
    const logs = [...vaultBuy(V1, O1), notTriggeredLog(V2, REASONS.NotEligible), batchLog({ bought: 1n, earned: REWARD })];
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });
});

function batchLogFor(): SimLog {
  return batchLog();
}

// ─── Where it goes, and with what ─────────────────────────────────────────────

describe("addresses and value", () => {
  it("refuses a batcher look-alike", async () => {
    const plan = batchPlan();
    plan.calls[0]!.to = "0xb752bf5bdf4dc36fd47ff84038141d5e6027ba08";
    expect(staticCodes(plan)).toContain("VAULT_MALFORMED");
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("VAULT_MALFORMED");
  });

  it("refuses v1's own batcher: Help run sends to the batcher bound to no factory alone, before simulating anything", async () => {
    // v1's takes three arguments, not four, so this calldata would only revert
    // there; refused for its target all the same (decision 27).
    expect(V1_MAINNET_BATCHER).not.toBe(BATCHER);
    const plan = batchPlan();
    plan.calls[0]!.to = V1_MAINNET_BATCHER;
    expect(staticCodes(plan)).toEqual(["VAULT_MALFORMED"]);
    const provider = ScriptedSimulationProvider.succeedingWith(honestBatchLogs());
    const verdict = await new VaultGuard(provider, OPTIONS).check(plan);
    expect(codes(verdict)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]).toMatchObject({ detail: { expected: BATCHER, actual: V1_MAINNET_BATCHER.toLowerCase() } });
    expect(provider.lastRequest).toBeNull();
  });

  it("refuses the fees going to anyone but the account, in the intent or in the calldata (a Help run batch whose rewardTo isn't the connected wallet)", async () => {
    const intent = batchPlan({ rewardTo: ATTACKER });
    expect(staticCodes(intent)).toContain("VAULT_MALFORMED");
    const calldata = batchPlan();
    calldata.calls[0]!.data = encodeExecuteBatch([V1, V2], ATTACKER, MIN_REWARDS);
    expect(staticCodes(calldata)).toContain("VAULT_MALFORMED");
  });

  it("refuses ether attached", () => {
    const plan = batchPlan();
    plan.calls[0]!.value = 1n;
    expect(staticCodes(plan)).toContain("VAULT_MALFORMED");
  });

  it("refuses another chain", () => {
    expect(staticCodes(batchPlan({ chainId: 8453 }))).toContain("CHAIN_MISMATCH");
  });

  it("refuses an account that can't send it", () => {
    expect(staticCodes(batchPlan({ account: "0x0000000000000000000000000000000000000000", rewardTo: "0x0000000000000000000000000000000000000000" }))).toContain("VAULT_MALFORMED");
  });
});

describe("the vault list", () => {
  it("refuses calldata that lists other vaults than the intent", () => {
    const plan = batchPlan();
    plan.calls[0]!.data = encodeExecuteBatch([V1, ATTACKER], USER, MIN_REWARDS);
    expect(staticCodes(plan)).toContain("VAULT_MALFORMED");
  });

  it("refuses a vault listed twice", () => {
    expect(staticCodes(batchPlan({ vaults: [V1, V1] }))).toContain("VAULT_MALFORMED");
    // In another case, too: an address is the same account whatever its case.
    const mixed = batchPlan();
    mixed.intent = { ...mixed.intent, vaults: [V1, `0x${V1.slice(2).toUpperCase()}` as typeof V1] };
    expect(staticCodes(mixed)).toContain("VAULT_MALFORMED");
  });

  it(`refuses ${MAX_BATCH_TRIGGER_VAULTS + 1} vaults, and none`, () => {
    const many = Array.from({ length: MAX_BATCH_TRIGGER_VAULTS + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "7")}` as typeof V1);
    const big = batchPlan({ vaults: many, gasLimit: batchGasLimit(many.map(() => ({ firstBuy: false }))) });
    expect(staticCodes(big)).toContain("VAULT_MALFORMED");
    expect(staticCodes(batchPlan({ vaults: [] }))).toContain("VAULT_MALFORMED");
  });

  it("refuses something that isn't an address in the list", () => {
    const plan = batchPlan();
    plan.intent = { ...plan.intent, vaults: [V1, "0x1234" as typeof V1] };
    expect(staticCodes(plan)).toContain("VAULT_MALFORMED");
  });
});

describe("parameters, gas and price", () => {
  it("refuses a least reward of 0", () => {
    expect(staticCodes(batchPlan({ minRewards: 0n }))).toContain("VAULT_MALFORMED");
  });

  it("refuses a gas limit below what every listed vault needs", () => {
    const least = batchGasLimit([{ firstBuy: false }, { firstBuy: false }]);
    expect(staticCodes(batchPlan({ gasLimit: least }))).toEqual([]);
    expect(staticCodes(batchPlan({ gasLimit: least - 1n }))).toContain("VAULT_MALFORMED");
  });

  it("refuses a gas limit above the ceiling", () => {
    expect(staticCodes(batchPlan({ gasLimit: MAX_BATCH_GAS_CEILING }))).toEqual([]);
    expect(staticCodes(batchPlan({ gasLimit: MAX_BATCH_GAS_CEILING + 1n }))).toContain("VAULT_MALFORMED");
  });

  it("refuses a call signed at another gas limit or price than the intent's", () => {
    const gas = batchPlan();
    gas.calls[0]!.gas = GAS_LIMIT + 1n;
    expect(staticCodes(gas)).toContain("VAULT_MALFORMED");
    const price = batchPlan();
    price.calls[0]!.gasPrice = GAS_PRICE * 2n;
    expect(staticCodes(price)).toContain("VAULT_MALFORMED");
    const missing = batchPlan();
    delete (missing.calls[0] as { gas?: bigint }).gas;
    expect(staticCodes(missing)).toContain("VAULT_MALFORMED");
  });

  it("refuses a zero price", () => {
    expect(staticCodes(batchPlan({ gasPrice: 0n }))).toContain("VAULT_MALFORMED");
  });
});

// "Offered only when the fees cover it" is the Guard's own check, from the gas
// its own test-run used, not the host's word from an earlier test-run.
describe("it pays for itself", () => {
  const GAS_USED = 150_000n;
  const verdictAt = (gasUsed: bigint, overrides: Parameters<typeof batchPlan>[0]) =>
    new VaultGuard(ScriptedSimulationProvider.succeedingWith(honestBatchLogs(), gasUsed), OPTIONS).check(batchPlan(overrides));

  it("passes a least reward exactly covering the network fee its test-run used", async () => {
    const verdict = await verdictAt(GAS_USED, { minRewards: GAS_USED * GAS_PRICE });
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("refuses a least reward below that fee, which the batch could meet and still cost more than it earns", async () => {
    const verdict = await verdictAt(GAS_USED, { minRewards: GAS_USED * GAS_PRICE - 1n });
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["VAULT_NOT_DELIVERED"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ fee: (GAS_USED * GAS_PRICE).toString(), gasUsed: GAS_USED.toString() });
  });

  it("refuses an absurd gas price: at it, what the batch earns can't cover its fee", async () => {
    const absurd = 10n ** 15n;
    const verdict = await verdictAt(GAS_USED, { gasPrice: absurd });
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
    // And sized honestly for that price, the least reward is more than the batch earns.
    const sized = await verdictAt(GAS_USED, { gasPrice: absurd, minRewards: GAS_USED * absurd });
    expect(codes(sized)).toContain("VAULT_NOT_DELIVERED");
  });

  it("with a second opinion, counts the larger of the two services' gas: a main service can't understate it alone", async () => {
    const withGas = (primary: bigint, second: bigint) => {
      const pair = new ScriptedPairProvider({
        run: () => ({ status: "success", logs: honestBatchLogs(), gasUsed: primary }),
        second: { run: () => ({ status: "success", logs: honestBatchLogs(), gasUsed: second }) },
      });
      const provider = new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: pair.second, host: "second.example", sleep: async () => {}, timeoutMs: 50 }).provider(
        new EthSimulateV1Provider(pair.primary),
      );
      // A least reward that covers 150,000 gas at GAS_PRICE, and not 400,000.
      return new VaultGuard(provider, OPTIONS).check(batchPlan({ minRewards: 150_000n * GAS_PRICE }));
    };
    expect((await withGas(1_000n, 150_000n)).level).toBe("verified");
    const understated = await withGas(1_000n, 400_000n);
    expect(understated.level).toBe("rejected");
    expect(codes(understated)).toEqual(["VAULT_NOT_DELIVERED"]);
    expect(codes(await withGas(400_000n, 1_000n))).toEqual(["VAULT_NOT_DELIVERED"]);
  });
});

describe("extra calls", () => {
  it("refuses a second call riding along", () => {
    const plan = batchPlan();
    plan.calls.push({ ...batchCall(plan.intent), to: SPX, data: "0xa9059cbb" as Hex });
    expect(staticCodes(plan)).toContain("VAULT_MALFORMED");
  });
});

// ─── What the batcher says it did ─────────────────────────────────────────────

describe("the Batch event", () => {
  /** Where the honest logs keep the `Batch`, last. */
  const BATCH_INDEX = 10;

  it("refuses a Batch from another emitter", async () => {
    const verdict = await guardWith(replacing(BATCH_INDEX, batchLog({}, ATTACKER))).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("VAULT_MALFORMED");
  });

  it("refuses a Batch credited to another caller or receiver", async () => {
    for (const figures of [{ caller: ATTACKER }, { rewardTo: ATTACKER }]) {
      const verdict = await guardWith(replacing(BATCH_INDEX, batchLog(figures))).check(batchPlan());
      expect(codes(verdict)).toContain("VAULT_MALFORMED");
    }
  });

  it("refuses a Batch in v1's layout from v2's batcher: not what its code logs", async () => {
    const verdict = await guardWith(replacing(BATCH_INDEX, v1BatchLog())).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(verdict.violations.some((v) => v.code === "VAULT_MALFORMED" && /v1 batch/.test(v.message))).toBe(true);
  });

  it("refuses earnings below the least reward", async () => {
    const verdict = await guardWith(replacing(BATCH_INDEX, batchLog({ earned: MIN_REWARDS - 1n }))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
  });

  it("refuses earnings that aren't the sum of the fees its vaults paid", async () => {
    // `earned` is how much the account's WETH rose; every vault is proved, and
    // pays only its fee to it, so a figure that isn't the fees' sum is money
    // from elsewhere, or not that batcher's figure at all.
    for (const earned of [EARNED + 1n, EARNED - 1n]) {
      const verdict = await guardWith(replacing(BATCH_INDEX, batchLog({ earned }))).check(batchPlan());
      expect(verdict.violations.some((v) => v.code === "VAULT_MALFORMED" && /its vaults pay/.test(v.message)), String(earned)).toBe(true);
    }
  });

  it("refuses a count of buys that isn't the vaults triggered", async () => {
    const verdict = await guardWith(replacing(BATCH_INDEX, batchLog({ bought: 1n }))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_MALFORMED");
  });
});

// ─── Where the money goes ─────────────────────────────────────────────────────

describe("where the money goes", () => {
  it("refuses a fee landing elsewhere", async () => {
    const verdict = await guardWith(replacing(FEE_INDEX, transferLog(WETH, V1, ATTACKER, REWARD))).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
  });

  it("refuses a simulation whose Bought pays anyone but the account", async () => {
    // The vault's own word on who it paid. Even with the WETH arriving where
    // it should, a `Bought` naming another `rewardTo` is not this batch's buy.
    const verdict = await guardWith(replacing(BOUGHT_INDEX, boughtLog(V1, BATCHER, OUT, AMOUNT, REWARD, FLOOR, ATTACKER))).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(verdict.violations.some((v) => v.code === "VAULT_MALFORMED" && v.detail?.["rewardTo"] === ATTACKER)).toBe(true);
  });

  it("refuses a fee paid to the batcher and passed on: in v2 nothing passes through it", async () => {
    // v1's way: the vault pays its caller, the batcher forwards. The account
    // ends with the same WETH, so only the movements themselves show it.
    const logs = honestBatchLogs();
    logs[FEE_INDEX] = transferLog(WETH, V1, BATCHER, REWARD);
    logs.splice(BOUGHT_INDEX + 2, 0, transferLog(WETH, BATCHER, USER, REWARD));
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(expect.arrayContaining(["VAULT_MALFORMED", "VAULT_BATCH_UNACCOUNTED"]));
  });

  it("refuses WETH the batcher held passed to the account, by its own code and figure", async () => {
    // Someone sent the batcher WETH; v2's has no way to pay it out, so a
    // simulation that does is not v2's batcher, and nobody can say whose it is.
    const stray = 10n ** 17n;
    const verdict = await guardWith([...honestBatchLogs(), transferLog(WETH, BATCHER, USER, stray)]).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toEqual(["VAULT_BATCH_UNACCOUNTED"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ swept: stray.toString(), token: WETH.toLowerCase() });
  });

  it("refuses ether or a token leaving the batcher too", async () => {
    for (const out of [transferLog(NATIVE, BATCHER, USER, 1n), transferLog(SPX, BATCHER, USER, 1n)]) {
      const verdict = await guardWith([...honestBatchLogs(), out]).check(batchPlan());
      expect(codes(verdict)).toEqual(["VAULT_BATCH_UNACCOUNTED"]);
    }
  });

  it("refuses the account losing SPX, ether or WETH", async () => {
    for (const theft of [transferLog(SPX, USER, ATTACKER, 1n), transferLog(NATIVE, USER, ATTACKER, 1n), transferLog(WETH, USER, ATTACKER, 1n)]) {
      const verdict = await guardWith([...honestBatchLogs(), theft]).check(batchPlan());
      expect(verdict.signable).toBe(false);
      expect(codes(verdict).some((c) => c === "UNEXPECTED_TOKEN_TRANSFER" || c === "UNEXPECTED_ETH_TRANSFER" || c === "VAULT_NOT_DELIVERED")).toBe(true);
    }
  });

  it("refuses the account granting an allowance", async () => {
    const verdict = await guardWith([...honestBatchLogs(), approvalLog(USDC, USER, ATTACKER, 1n)]).check(batchPlan());
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });
});

// ─── Each vault ───────────────────────────────────────────────────────────────

describe("vault behaviour", () => {
  it("refuses a buy made by anyone but the batcher", async () => {
    const verdict = await guardWith(replacing(BOUGHT_INDEX, boughtLog(V1, ATTACKER))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_MALFORMED");
  });

  it("refuses a buy logged in v1's layout: each vault is proved a v2 vault, and its code logs v2's", async () => {
    const verdict = await guardWith(replacing(BOUGHT_INDEX, v1BoughtLog(V1))).check(batchPlan());
    expect(verdict.violations.some((v) => v.code === "VAULT_MALFORMED" && /v1 vault's/.test(v.message))).toBe(true);
  });

  it("refuses a vault losing more than its buy and its fee", async () => {
    const verdict = await guardWith([...honestBatchLogs(), transferLog(WETH, V1, ATTACKER, 1n)]).check(batchPlan());
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("refuses a vault losing anything else", async () => {
    const verdict = await guardWith([...honestBatchLogs(), transferLog(SPX, V2, ATTACKER, 1n)]).check(batchPlan());
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("refuses a buy below its own floor", async () => {
    const verdict = await guardWith(replacing(BOUGHT_INDEX, boughtLog(V1, BATCHER, 1n))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
  });

  it("refuses a vault that made no buy losing WETH", async () => {
    const logs = [
      ...vaultBuy(V1, O1),
      transferLog(WETH, V2, ATTACKER, 1n),
      notTriggeredLog(V2, REASONS.TooSoon),
      batchLog({ bought: 1n, earned: REWARD }),
    ];
    expect(codes(await guardWith(logs).check(batchPlan()))).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });
});

describe("log structure", () => {
  it("refuses a Triggered for a vault it doesn't list", async () => {
    const verdict = await guardWith([...vaultBuy(ATTACKER, O2), ...honestBatchLogs()]).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_MALFORMED");
  });

  it("refuses a Triggered with no buy of the vault's own right before it", async () => {
    const logs = honestBatchLogs();
    // V1's Bought, emitted by someone else: anyone can emit that shape.
    logs[BOUGHT_INDEX] = { ...boughtLog(V1, BATCHER), address: ATTACKER };
    expect(codes(await guardWith(logs).check(batchPlan()))).toContain("VAULT_MALFORMED");
    const missing = honestBatchLogs().filter((_, i) => i !== BOUGHT_INDEX);
    expect(codes(await guardWith(missing).check(batchPlan()))).toContain("VAULT_MALFORMED");
  });

  it("refuses a listed vault reported as no vault at all: v1's batcher's NotFromFactory, or a call that found no code", async () => {
    // `EmptyReturn`: the claim named the address the factory would put that
    // vault at, and it isn't there yet. A batch on it pays for nothing.
    for (const reason of [REASONS.NotFromFactory, REASONS.EmptyReturn]) {
      const logs = [...vaultBuy(V1, O1), notTriggeredLog(V2, reason), batchLog({ bought: 1n, earned: REWARD })];
      expect(codes(await guardWith(logs).check(batchPlan())), reason).toContain("VAULT_MALFORMED");
    }
  });

  it("refuses a listed vault left NotTried: no event, and fewer tried than listed", async () => {
    const logs = [...vaultBuy(V1, O1), batchLog({ tried: 1n, bought: 1n, earned: REWARD })];
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(verdict.violations.some((v) => v.code === "VAULT_MALFORMED" && /untried|tries 1 of 2/.test(v.message))).toBe(true);
  });

  it("refuses a vault tried twice", async () => {
    const logs = [...vaultBuy(V1, O1), notTriggeredLog(V1, REASONS.TooSoon), ...honestBatchLogs().slice(5)];
    expect(codes(await guardWith(logs).check(batchPlan()))).toContain("VAULT_MALFORMED");
  });

  it("reads through the traceTransfers pseudo-logs, which are not logs on chain", async () => {
    // A buy with ether moving between its Bought and Triggered: the join is by position among real logs.
    const logs = honestBatchLogs();
    logs.splice(BOUGHT_INDEX + 1, 0, transferLog(NATIVE, PAIR, O1, 1n));
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });
});

// ─── Each address is a vault, proved before anything runs ─────────────────────

/**
 * The batcher calls whatever it is given and trusts nothing it says, so
 * nothing on chain any longer refuses a contract that only looks like a vault.
 * One could answer like a buy in a test-run and burn the account's gas in the
 * block, or move a token the account once approved it for. The Guard proves
 * each address statically, from the host's claim, and refuses before it
 * simulates: `provider.lastRequest` stays null.
 */
describe("Red team — a batch that lists something that isn't a listed factory's vault", () => {
  const refusedBeforeSimulating = async (plan: VaultBatchTxPlan) => {
    expect(staticCodes(plan)).toContain("VAULT_MALFORMED");
    const provider = ScriptedSimulationProvider.succeedingWith(honestBatchLogs());
    const verdict = await new VaultGuard(provider, OPTIONS).check(plan);
    expect(verdict.signable).toBe(false);
    expect(provider.lastRequest).toBeNull();
    return verdict;
  };
  /** A batch of `vaults` with `claims`, encoded exactly as the host would. */
  const listing = (vaults: (typeof V1)[], claims: readonly VaultClaim[]) => batchPlan({ vaults, claims });

  it("refuses a contract that answers like a buy, claimed with a vault's honest-looking terms", async () => {
    // ATTACKER's code would pay the account and log a perfect `Bought` in the
    // test-run; its address is no factory's vault for any owner and nonce.
    await refusedBeforeSimulating(listing([V1, ATTACKER], [CLAIMS[0]!, claimOf(ATTACKER, O2)]));
  });

  it("refuses a contract that would move the account's tokens, however honest its test-run", async () => {
    // A test-run in which it moves nothing proves nothing about the block: the
    // refusal is static, so its logs are never even asked for.
    const verdict = await refusedBeforeSimulating(listing([ATTACKER], [claimOf(ATTACKER, USER)]));
    expect(verdict.violations.some((v) => /is not v2's factory's vault/.test(v.message))).toBe(true);
  });

  it("refuses a real vault's address claimed for another owner, nonce or terms: the address commits to all three", async () => {
    for (const lie of [{ owner: O2 }, { nonce: 1n }, { terms: { ...VAULT_TERMS, turnBuckets: 4n } }, { terms: { ...VAULT_TERMS, interval: 7_200n } }]) {
      await refusedBeforeSimulating(listing([V1, V2], [claimOf(V1, O1, lie), CLAIMS[1]!]));
    }
  });

  it("refuses a vault with no claim, claims out of step with the list, or none at all", async () => {
    await refusedBeforeSimulating(listing([V1, V2], [CLAIMS[0]!]));
    await refusedBeforeSimulating(listing([V1, V2], [CLAIMS[1]!, CLAIMS[0]!]));
    const none = batchPlan();
    none.intent = { ...none.intent, claims: undefined } as unknown as VaultBatchTxPlan["intent"];
    await refusedBeforeSimulating(none);
  });

  it("refuses a claim of a release spDEX doesn't list, or of none", async () => {
    for (const release of ["v3", undefined, 2]) {
      await refusedBeforeSimulating(listing([V1, V2], [{ ...CLAIMS[0]!, release } as unknown as VaultClaim, CLAIMS[1]!]));
    }
  });

  it("refuses a v1 vault, genuine and proved: it pays whoever calls, and a batch can't pay the account for it", async () => {
    const v1Terms = { ...VAULT_TERMS, communityWindow: null, turnBuckets: null };
    const v1Vault = predictVault({ factory: V1_MAINNET_FACTORY, owner: O1, nonce: 0n, terms: v1Terms });
    const verdict = await refusedBeforeSimulating(listing([v1Vault, V2], [claimOf(v1Vault, O1, { terms: v1Terms, release: "v1" }), CLAIMS[1]!]));
    expect(verdict.violations.some((v) => v.detail?.["release"] === "v1")).toBe(true);
  });

  it("refuses a v2 vault claimed as v1's, or a v1 vault's terms claimed as v2's", async () => {
    await refusedBeforeSimulating(listing([V1, V2], [claimOf(V1, O1, { release: "v1", terms: { ...VAULT_TERMS, communityWindow: null, turnBuckets: null } }), CLAIMS[1]!]));
    await refusedBeforeSimulating(listing([V1, V2], [claimOf(V1, O1, { terms: { ...VAULT_TERMS, communityWindow: null } }), CLAIMS[1]!]));
  });
});

describe("Red team — the batcher, and the gas each vault is given", () => {
  it("refuses a batch giving each vault other gas than the host's: more is more of the account's gas a vault could burn", async () => {
    for (const gasPerVault of [1_000_000n, 10_000_000n]) {
      const plan = batchPlan();
      plan.calls[0]!.data = encodeExecuteBatch([V1, V2], USER, MIN_REWARDS, { gasPerVault });
      expect(staticCodes(plan), String(gasPerVault)).toEqual(["VAULT_MALFORMED"]);
      const provider = ScriptedSimulationProvider.succeedingWith(honestBatchLogs());
      expect((await new VaultGuard(provider, OPTIONS).check(plan)).signable).toBe(false);
      expect(provider.lastRequest).toBeNull();
    }
  });

  it("refuses a batcher spDEX doesn't list: one built for another token, or anyone's", async () => {
    for (const to of [batcherAddress(USDC.toLowerCase() as typeof V1), ATTACKER, MAINNET_FACTORY]) {
      const plan = batchPlan();
      plan.calls[0]!.to = to;
      expect(staticCodes(plan), to).toEqual(["VAULT_MALFORMED"]);
    }
  });

  it("refuses v1's three-argument executeBatch, even to the right batcher", () => {
    const plan = batchPlan();
    plan.calls[0]!.data = encodeExecuteBatch([V1, V2], USER, MIN_REWARDS, { batcher: V1_MAINNET_BATCHER });
    expect(staticCodes(plan)).toEqual(["VAULT_MALFORMED"]);
  });
});

// ─── Never signed unchecked ───────────────────────────────────────────────────

describe("simulation state", () => {
  it("refuses when the endpoint can't simulate, with requireSimulation off", async () => {
    const verdict = await new VaultGuard(new NoSimulationProvider(), OPTIONS).check(batchPlan());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
  });

  it("refuses when the simulation fails, with requireSimulation off", async () => {
    const verdict = await new VaultGuard(new FlakySimulationProvider(), OPTIONS).check(batchPlan());
    expect(verdict.level).toBe("rejected");
  });

  it("refuses a revert, naming each vault's reason when the service reported them", async () => {
    const provider = new ScriptedSimulationProvider({
      status: "reverted",
      revertReason: "execution failed",
      gasUsed: 90_000n,
      logs: [],
      returnData: nothingBoughtData([REASONS.TooSoon, REASONS.TooSoon]),
    } satisfies SimulationOutcome);
    const verdict = await new VaultGuard(provider, OPTIONS).check(batchPlan());
    expect(codes(verdict)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toContain("NothingBought (TooSoon)");
  });

  it("refuses a batch every vault of which refuses the account inside its window, and says so", async () => {
    // An account that isn't an eligible SPX holder, offered only in-window
    // buys: nothing is bought, and the reason is the vaults' own.
    const provider = new ScriptedSimulationProvider({
      status: "reverted",
      revertReason: "execution failed",
      gasUsed: 90_000n,
      logs: [],
      returnData: nothingBoughtData([REASONS.NotEligible, REASONS.NotEligible]),
    } satisfies SimulationOutcome);
    const verdict = await new VaultGuard(provider, OPTIONS).check(batchPlan());
    expect(codes(verdict)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toContain("NothingBought (NotEligible)");
  });

  const pairWith = (second: ConstructorParameters<typeof ScriptedPairProvider>[0]["second"]) => {
    const pair = new ScriptedPairProvider({ run: () => ({ status: "success", logs: honestBatchLogs() }), ...(second === undefined ? {} : { second }) });
    const provider = new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: pair.second, host: "second.example", sleep: async () => {}, timeoutMs: 50 }).provider(
      new EthSimulateV1Provider(pair.primary),
    );
    return { pair, guard: new VaultGuard(provider, OPTIONS) };
  };

  it("is verified when the second opinion agrees, both run at the batch's own gas limit", async () => {
    const { pair, guard } = pairWith(undefined);
    const verdict = await guard.check(batchPlan());
    expect(verdict.level).toBe("verified");
    for (const side of [pair.requests.primary, pair.requests.second]) {
      const simulate = side.filter((r) => r.method === "eth_simulateV1").at(-1)!;
      const call = (simulate.params[0] as { blockStateCalls: { calls: { gas?: string }[] }[] }).blockStateCalls[0]!.calls[0]!;
      expect(BigInt(call.gas!)).toBe(GAS_LIMIT);
    }
  });

  it("refuses when the second opinion disagrees", async () => {
    const { guard } = pairWith({ run: () => ({ status: "success", logs: replacing(FEE_INDEX, transferLog(WETH, V1, USER, REWARD - 1n)) }) });
    const verdict = await guard.check(batchPlan());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("refuses when the second opinion doesn't answer, with requireSimulation off", async () => {
    const { guard } = pairWith({ fail: ["eth_simulateV1"] });
    const verdict = await guard.check(batchPlan());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SECOND_OPINION_UNAVAILABLE"]);
  });
});
