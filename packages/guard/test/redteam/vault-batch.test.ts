/**
 * Red team: a batch of due buys in other people's vaults ("Help run the
 * network"), sent from the user's wallet through the batcher.
 *
 * The user pays the network fee and is paid the vaults' buy fees. The claim
 * under test is that the one transaction they sign is exactly that: the
 * batcher bound to spDEX's factory, every fee to their own account, no ether,
 * the exact gas limit and price the simulation ran at, every listed vault
 * tried and each buy the vault's own — and that nothing of theirs moves but
 * the fees arriving. It is never signed unchecked.
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
  MAINNET_FACTORY,
  MAX_BATCH_GAS_CEILING,
  batchGasLimit,
  batcherAddress,
  decodeBatcherEvent,
  decodeVaultEvent,
  encodeExecuteBatch,
  reasonName,
} from "@spdex/vault";
import { MAX_BATCH_TRIGGER_VAULTS, VaultGuard, runVaultChecks, type VaultBatchTxPlan } from "../../src/vault.js";
import { SecondOpinionPair } from "../../src/second-opinion.js";
import {
  AMOUNT,
  BATCHER,
  EARNED,
  GAS_LIMIT,
  GAS_PRICE,
  MIN_REWARDS,
  O1,
  O2,
  PAIR,
  REASONS,
  REWARD,
  V1,
  V2,
  batchCall,
  batchLog,
  batchPlan,
  boughtLog,
  honestBatchLogs,
  notTriggeredLog,
  nothingBoughtData,
  triggeredLog,
  vaultBuy,
} from "./fixtures/batch.js";

const OPTIONS = { chainId: 1, requireSimulation: false };

const guardWith = (logs: SimLog[], options: Partial<typeof OPTIONS> = {}) =>
  new VaultGuard(ScriptedSimulationProvider.succeedingWith(logs), { ...OPTIONS, ...options });

const codes = (v: { violations: { code: GuardViolationCode }[] }) => v.violations.map((x) => x.code);
const staticCodes = (p: VaultBatchTxPlan) => runVaultChecks(p, 1).map((v) => v.code);

/** Where the honest logs keep the batcher's transfer of the fees to the account. */
const FEES_INDEX = 10;

/** The honest logs with one replaced, by position. */
const replacing = (index: number, log: SimLog): SimLog[] => honestBatchLogs().map((l, i) => (i === index ? log : l));

// ─── Honest ───────────────────────────────────────────────────────────────────

describe("an honest batch", () => {
  it("is laid out as the batcher and the vaults emit it", () => {
    // Pins the fixtures, not the Guard: decoded by the vault package's own ABI.
    expect(BATCHER).toBe(batcherAddress(MAINNET_FACTORY));
    const at = (log: SimLog, logIndex: number) => ({ ...log, logIndex });
    expect(decodeBatcherEvent(BATCHER, at(batchLogFor(), 0))).toMatchObject({ name: "Batch", caller: USER, rewardTo: USER, bought: 2n, earned: EARNED, swept: 0n });
    expect(decodeBatcherEvent(BATCHER, at(triggeredLog(V1), 1))).toMatchObject({ name: "Triggered", vault: V1 });
    expect(decodeBatcherEvent(BATCHER, at(notTriggeredLog(V1, REASONS.TooSoon), 2))).toMatchObject({ name: "NotTriggered", vault: V1, reasonName: "TooSoon" });
    expect(decodeVaultEvent(boughtLog(V1, BATCHER))).toMatchObject({ name: "Bought", emitter: V1, keeper: BATCHER, amountIn: AMOUNT, reward: REWARD });
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
    const logs = [...vaultBuy(V1, O1), notTriggeredLog(V2, REASONS.TooSoon), transferLog(WETH, BATCHER, USER, REWARD), batchLog({ bought: 1n, earned: REWARD })];
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

  it("refuses the fees going to anyone but the account, in the intent or in the calldata", async () => {
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
    mixed.intent = { ...mixed.intent, vaults: [V1, V1.replace("7a01", "7A01") as typeof V1] };
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
      return new VaultGuard(provider, OPTIONS).check(batchPlan());
    };
    // MIN_REWARDS covers 150,000 gas at GAS_PRICE, not 400,000.
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
  /** Where the honest logs keep the fee transfer to the account, and the `Batch` after it. */
  const BATCH_INDEX = 11;

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

  it("refuses WETH swept from the batcher to the account, by its own code", async () => {
    const swept = 10n ** 17n;
    const logs = replacing(BATCH_INDEX, batchLog({ swept }));
    logs[FEES_INDEX] = transferLog(WETH, BATCHER, USER, EARNED + swept);
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.signable).toBe(false);
    const violation = verdict.violations.find((v) => v.code === "VAULT_BATCH_UNACCOUNTED");
    expect(violation?.detail?.["swept"]).toBe(swept.toString());
  });

  it("refuses earnings below the least reward", async () => {
    const verdict = await guardWith(replacing(BATCH_INDEX, batchLog({ earned: MIN_REWARDS - 1n }))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
  });

  it("refuses a count of buys that isn't the vaults triggered", async () => {
    const verdict = await guardWith(replacing(BATCH_INDEX, batchLog({ bought: 1n }))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_MALFORMED");
  });
});

// ─── Where the money goes ─────────────────────────────────────────────────────

describe("where the money goes", () => {
  it("refuses the fees landing elsewhere", async () => {
    const verdict = await guardWith(replacing(FEES_INDEX, transferLog(WETH, BATCHER, ATTACKER, EARNED))).check(batchPlan());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
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
  it("refuses a buy credited to anyone but the batcher", async () => {
    const verdict = await guardWith(replacing(3, boughtLog(V1, ATTACKER))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_MALFORMED");
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
    const verdict = await guardWith(replacing(3, boughtLog(V1, BATCHER, 1n))).check(batchPlan());
    expect(codes(verdict)).toContain("VAULT_NOT_DELIVERED");
  });

  it("refuses a vault that made no buy losing WETH", async () => {
    const logs = [
      ...vaultBuy(V1, O1),
      transferLog(WETH, V2, ATTACKER, 1n),
      notTriggeredLog(V2, REASONS.TooSoon),
      transferLog(WETH, BATCHER, USER, REWARD),
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
    logs[3] = { ...boughtLog(V1, BATCHER), address: ATTACKER };
    expect(codes(await guardWith(logs).check(batchPlan()))).toContain("VAULT_MALFORMED");
    const missing = honestBatchLogs().filter((_, i) => i !== 3);
    expect(codes(await guardWith(missing).check(batchPlan()))).toContain("VAULT_MALFORMED");
  });

  it("refuses a listed vault the factory doesn't vouch for", async () => {
    const logs = [...vaultBuy(V1, O1), notTriggeredLog(V2, REASONS.NotFromFactory), transferLog(WETH, BATCHER, USER, REWARD), batchLog({ bought: 1n, earned: REWARD })];
    expect(codes(await guardWith(logs).check(batchPlan()))).toContain("VAULT_MALFORMED");
  });

  it("refuses a listed vault left NotTried: no event, and fewer tried than listed", async () => {
    const logs = [...vaultBuy(V1, O1), transferLog(WETH, BATCHER, USER, REWARD), batchLog({ tried: 1n, bought: 1n, earned: REWARD })];
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
    logs.splice(4, 0, transferLog(NATIVE, PAIR, O1, 1n));
    const verdict = await guardWith(logs).check(batchPlan());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
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
    const { guard } = pairWith({ run: () => ({ status: "success", logs: replacing(FEES_INDEX, transferLog(WETH, BATCHER, USER, EARNED - 1n)) }) });
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
