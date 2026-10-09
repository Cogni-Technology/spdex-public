/**
 * Red team: the second opinion.
 *
 * With a second network service set, every test-run the Guard relies on runs
 * on both, at one block both vouch for, and the two are compared
 * (src/second-opinion.ts). The claims under test:
 *
 *   1. A disagreement refuses, whatever `requireSimulation` says.
 *   2. Agreement changes nothing, and never un-refuses.
 *   3. Only the second service's own failure makes it "unavailable"
 *      (signable as "Checked on one service"); anything the main service
 *      reports that stops the comparison — a head far off, a header of its
 *      own making — refuses instead. A lying main service must not be able to
 *      turn a disagreement it expects into something the user can sign, and
 *      that includes failing the one request the comparison needs: the
 *      second service's answer is still compared, or judged.
 *   4. The simulated block's time comes from the agreed header, so a contract
 *      that behaves only before some time can't be shown at an early time.
 *   5. With a second opinion, a verdict is never better than without one,
 *      including when either service lags and the chain changed since.
 *   6. One check waits at most 12 s on the second service in all.
 *
 * Both services are scripted (`ScriptedPairProvider`): an honest chain, and
 * one departure from it per case. If any goes green-to-red, do not ship.
 */

import { describe, expect, it } from "vitest";
import {
  AMOUNT_IN,
  ATTACKER,
  HONEST_OUT,
  NATIVE,
  NATIVE_AMOUNT_IN,
  NOW,
  ROUTER,
  SCRIPTED_HEAD,
  SPX,
  USER,
  WETH,
  honestIntent,
  honestManifest,
  honestPlan,
  nativeIntent,
  nativePlan,
  transferLog,
  ScriptedPairProvider,
  type ScriptedResult,
  type ScriptedRun,
  type ScriptedService,
} from "@spdex/testing";
import { EthSimulateV1Provider, type SimLog, type SimulationOutcome } from "@spdex/chain";
import { rejected, unverified, verified, type Address, type GuardVerdict } from "@spdex/core";
import { Guard, type GuardInput } from "../../src/guard.js";
import {
  AgreeingSimulationProvider,
  MAX_SIMULATED_CALL_GAS,
  SECOND_OPINION_BUDGET_MS,
  SECOND_OPINION_HEADER_SHARE_MS,
  SECOND_OPINION_REVERT_PREFIX,
  SECOND_OPINION_RETRY_MS,
  SECOND_OPINION_TIMEOUT_MS,
  SecondOpinionPair,
  applySecondOpinion,
  compareOutcomes,
  secondOpinionHost,
  type SecondOpinionOptions,
} from "../../src/second-opinion.js";
import { GUARD_PATHS } from "./fixtures/guards.js";

const HOST = "second.example";
const OPTIONS = { chainId: 1, requireSimulation: false, oracleDivergenceBps: 200 };

const swapInput = (overrides: Partial<GuardInput> = {}): GuardInput => ({
  plan: honestPlan(),
  expectedIntent: honestIntent(),
  manifest: honestManifest(),
  extraTrustedContracts: [],
  nowSeconds: NOW,
  ...overrides,
});

/** An honest SPX → WETH swap on chain. */
const honestLogs = (): SimLog[] => [transferLog(SPX, USER, ROUTER, AMOUNT_IN), transferLog(WETH, ROUTER, USER, HONEST_OUT)];
const honest = (): ScriptedResult => ({ status: "success", logs: honestLogs() });

interface Setup {
  pair: ScriptedPairProvider;
  provider: AgreeingSimulationProvider;
  sleeps: number[];
  guard: (options?: Partial<typeof OPTIONS>) => Guard;
}

/** Two scripted services, and the Guard that compares them. */
function setup(
  services: { run?: (run: ScriptedRun) => ScriptedResult; primary?: ScriptedService; second?: ScriptedService } = {},
  options: Partial<SecondOpinionOptions> = {},
): Setup {
  const pair = new ScriptedPairProvider({
    run: services.run ?? honest,
    ...(services.primary === undefined ? {} : { primary: services.primary }),
    ...(services.second === undefined ? {} : { second: services.second }),
  });
  const sleeps: number[] = [];
  const provider = new SecondOpinionPair({
    primaryRpc: pair.primary,
    secondRpc: pair.second,
    host: HOST,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeoutMs: 50,
    ...options,
  }).provider(new EthSimulateV1Provider(pair.primary));
  return { pair, provider, sleeps, guard: (o = {}) => new Guard(provider, { ...OPTIONS, ...o }) };
}

/** A log only the second service reports: enough to disagree about, on any path. */
const EXTRA: SimLog = { address: "0x00000000000000000000000000000000000000aa", topics: [], data: "0x" };

const codes = (v: GuardVerdict) => v.violations.map((x) => x.code);
const warningCodes = (v: GuardVerdict) => v.warnings.map((x) => x.code);
const simulations = (requests: { method: string; params: unknown[] }[]) => requests.filter((r) => r.method === "eth_simulateV1" && hasCalls(r.params));
const hasCalls = (params: unknown[]) => ((params[0] as { blockStateCalls: { calls: unknown[] }[] }).blockStateCalls[0]?.calls.length ?? 0) > 0;

// ─── The honest baseline ──────────────────────────────────────────────────────

describe("two honest services", () => {
  it("agree, and the swap is verified", async () => {
    // If this fails, every refusal below is meaningless.
    const { guard } = setup();
    const verdict = await guard().check(swapInput());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("are both asked the identical request, on the agreed block, with every header field pinned", async () => {
    const { pair, provider } = setup();
    const outcome = await provider.simulate({ chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x", value: 0n }, { to: ROUTER, data: "0x01", value: 1n }] });
    expect(outcome.secondOpinion).toEqual({ kind: "agrees", host: HOST });
    const [mine] = simulations(pair.requests.primary);
    const [theirs] = simulations(pair.requests.second);
    expect(mine).toBeDefined();
    expect(theirs!.params).toEqual(mine!.params);
    const header = pair.header(SCRIPTED_HEAD);
    const [body, tag] = mine!.params as [{ blockStateCalls: { blockOverrides: Record<string, string>; calls: { gas: string }[] }[] }, { blockHash: string }];
    expect(tag).toEqual({ blockHash: header.hash });
    expect(body.blockStateCalls[0]!.blockOverrides).toEqual({
      number: `0x${(SCRIPTED_HEAD + 1n).toString(16)}`,
      time: `0x${(header.timestamp + 12n).toString(16)}`,
      gasLimit: `0x${header.gasLimit.toString(16)}`,
      feeRecipient: "0x0000000000000000000000000000000000000000",
      prevRandao: `0x${"00".repeat(32)}`,
      baseFeePerGas: "0x0",
    });
    // Two calls share the block's gas, at most the per-transaction cap each.
    const each = header.gasLimit / 2n < MAX_SIMULATED_CALL_GAS ? header.gasLimit / 2n : MAX_SIMULATED_CALL_GAS;
    expect(body.blockStateCalls[0]!.calls.map((c) => BigInt(c.gas))).toEqual([each, each]);
  });

  it("keep a request's own gas (a batch of vault buys)", async () => {
    const { pair, provider } = setup();
    await provider.simulate({ chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x", value: 0n }], gas: 3_060_000n });
    for (const side of [pair.requests.primary, pair.requests.second]) {
      const [body] = simulations(side)[0]!.params as [{ blockStateCalls: { calls: { gas: string }[] }[] }];
      expect(BigInt(body.blockStateCalls[0]!.calls[0]!.gas)).toBe(3_060_000n);
    }
  });

  it("pin the lower head when they are 1 apart", async () => {
    const { pair, provider } = setup({ primary: { head: (h) => h - 1n } });
    const outcome = await provider.simulate({ chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x", value: 0n }] });
    expect(outcome.secondOpinion?.kind).toBe("agrees");
    const [, tag] = simulations(pair.requests.second)[0]!.params as [unknown, { blockHash: string }];
    expect(tag.blockHash).toBe(pair.header(SCRIPTED_HEAD - 1n).hash);
  });

  it("give a main service 2 blocks behind a moment to catch up, and then compare at its new head", async () => {
    let reads = 0;
    const { pair, provider, sleeps } = setup({ primary: { head: (h) => (reads++ === 0 ? h - 2n : h) } });
    const outcome = await provider.simulate({ chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x", value: 0n }] });
    expect(outcome.secondOpinion?.kind).toBe("agrees");
    const [, tag] = simulations(pair.requests.second)[0]!.params as [unknown, { blockHash: string }];
    expect(tag.blockHash).toBe(pair.header(SCRIPTED_HEAD).hash);
    expect(sleeps).toEqual([500]);
  });

  it("give a second service a block behind a moment to catch up, so a check right after the user's own transaction sees it", async () => {
    let reads = 0;
    const { pair, provider, sleeps } = setup({ second: { head: (h) => (reads++ === 0 ? h - 1n : h) } });
    await provider.simulate({ chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x", value: 0n }] });
    const [, tag] = simulations(pair.requests.second)[0]!.params as [unknown, { blockHash: string }];
    expect(tag.blockHash).toBe(pair.header(SCRIPTED_HEAD).hash);
    expect(sleeps.length).toBe(1);
  });

  it("share the agreed header across the checks of one quote, for a few seconds only", async () => {
    let now = 1_000;
    const { pair, provider } = setup({}, { now: () => now });
    const request = { chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x" as const, value: 0n }] };
    const headerReads = () => pair.requests.second.filter((r) => r.method === "eth_getBlockByNumber").length;
    await provider.simulate(request);
    await provider.simulate(request);
    expect(headerReads()).toBe(1);
    // Heads are read afresh every time: a new block (the user's own
    // transaction) moves the pin, shared header or not.
    pair.advance();
    await provider.simulate(request);
    expect(headerReads()).toBe(2);
    now += SECOND_OPINION_HEADER_SHARE_MS;
    await provider.simulate(request);
    expect(headerReads()).toBe(3);
  });
});

// ─── Disagreements ────────────────────────────────────────────────────────────

describe("a disagreement is refused, whatever requireSimulation says", () => {
  const second = (logs: SimLog[]): ScriptedService => ({ run: () => ({ status: "success", logs }) });

  it("the main service clean, the second showing a shortfall", async () => {
    const { guard } = setup({ second: second([transferLog(SPX, USER, ROUTER, AMOUNT_IN), transferLog(WETH, ROUTER, USER, HONEST_OUT / 2n)]) });
    const verdict = await guard().check(swapInput());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ host: HOST, reason: "result" });
  });

  it("the second showing an extra outflow", async () => {
    const { guard } = setup({ second: second([...honestLogs(), transferLog(SPX, USER, ATTACKER, 1n)]) });
    expect(codes(await guard().check(swapInput()))).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("the second reverting", async () => {
    const { guard } = setup({ second: { run: () => ({ status: "reverted", reason: "execution reverted: STF" }) } });
    expect(codes(await guard().check(swapInput()))).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("the main service reverting and the second clean: refused with the main service's own code", async () => {
    const { guard } = setup({ primary: { run: () => ({ status: "reverted", reason: "execution reverted: TooLittleReceived" }) } });
    const verdict = await guard().check(swapInput());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toBe("execution reverted: TooLittleReceived");
  });

  it("one event's data off by 1 wei", async () => {
    const { guard } = setup({ second: second([transferLog(SPX, USER, ROUTER, AMOUNT_IN), transferLog(WETH, ROUTER, USER, HONEST_OUT + 1n)]) });
    expect(codes(await guard().check(swapInput()))).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("the events in another order", async () => {
    const { guard } = setup({ second: second([...honestLogs()].reverse()) });
    expect(codes(await guard().check(swapInput()))).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("ether moving differently", async () => {
    const plan = nativePlan();
    const input = swapInput({ plan, expectedIntent: nativeIntent() });
    const logs = (to: typeof ROUTER) => [transferLog(NATIVE, USER, to, NATIVE_AMOUNT_IN), transferLog(SPX, ROUTER, USER, HONEST_OUT)];
    const { guard } = setup({ run: () => ({ status: "success", logs: logs(ROUTER) }), second: second(logs(ATTACKER)) });
    expect(codes(await guard().check(input))).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("even with requireSimulation off and the main service's own checks passing", async () => {
    const { guard } = setup({ second: second([]) });
    const verdict = await guard({ requireSimulation: false }).check(swapInput());
    expect(verdict.signable).toBe(false);
  });
});

// ─── Agreements ───────────────────────────────────────────────────────────────

describe("an agreement", () => {
  it("is verified with identical results", async () => {
    const { guard } = setup();
    expect((await guard().check(swapInput())).level).toBe("verified");
  });

  it("is verified when only the traceTransfers pseudo-logs are ordered differently", async () => {
    const input = swapInput({ plan: nativePlan(), expectedIntent: nativeIntent() });
    const ether = [transferLog(NATIVE, USER, ROUTER, NATIVE_AMOUNT_IN), transferLog(NATIVE, ROUTER, WETH, NATIVE_AMOUNT_IN)];
    const tokens = [transferLog(SPX, ROUTER, USER, HONEST_OUT)];
    const { guard } = setup({
      run: () => ({ status: "success", logs: [...ether, ...tokens] }),
      second: { run: () => ({ status: "success", logs: [...tokens, ...[...ether].reverse()] }) },
    });
    const verdict = await guard().check(input);
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("never un-refuses: theft on both services is refused with the theft's code", async () => {
    const theft = [...honestLogs(), transferLog(USDCish(), USER, ATTACKER, 5n)];
    const { guard } = setup({ run: () => ({ status: "success", logs: theft }) });
    const verdict = await guard().check(swapInput());
    expect(codes(verdict)).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
  });

  it("ignores gas used and revert strings, which honest clients report differently", async () => {
    const { guard } = setup({
      run: () => ({ status: "success", logs: honestLogs(), gasUsed: 150_000n }),
      second: { run: () => ({ status: "success", logs: honestLogs(), gasUsed: 151_234n }) },
    });
    expect((await guard().check(swapInput())).level).toBe("verified");
    const reverting = setup({
      run: () => ({ status: "reverted", reason: "execution reverted: STF" }),
      second: { run: () => ({ status: "reverted", reason: "execution failed" }) },
    });
    // Both revert: refused, as the main service's revert, and not called a disagreement.
    expect(codes(await reverting.guard().check(swapInput()))).toEqual(["SIMULATION_REVERTED"]);
  });
});

function USDCish(): Address {
  return "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
}

// ─── Unavailable: only the second service's own failure ───────────────────────

describe("the second service not answering", () => {
  it("leaves a verified swap unverified, 'checked on one service', with the host named", async () => {
    const { guard } = setup({ second: { fail: ["eth_simulateV1"] } });
    const verdict = await guard().check(swapInput());
    expect(verdict.level).toBe("unverified");
    expect(verdict.signable).toBe(true);
    expect(warningCodes(verdict)).toEqual(["SECOND_OPINION_UNAVAILABLE"]);
    expect(verdict.warnings[0]!.detail).toMatchObject({ host: HOST });
  });

  it("is refused under requireSimulation", async () => {
    const { guard } = setup({ second: { fail: ["eth_simulateV1"] } });
    const verdict = await guard({ requireSimulation: true }).check(swapInput());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SECOND_OPINION_UNAVAILABLE"]);
  });

  it("still refuses theft the main service detects, with the theft's code", async () => {
    const theft = [...honestLogs(), transferLog(USDCish(), USER, ATTACKER, 1n)];
    const { guard } = setup({ run: () => ({ status: "success", logs: theft }), second: { fail: ["eth_simulateV1"] } });
    const verdict = await guard().check(swapInput());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
    expect(codes(verdict)).not.toContain("SECOND_OPINION_UNAVAILABLE");
  });

  it("covers a timeout on any of its reads, a missing head, a missing header, and a missing eth_simulateV1", async () => {
    const cases: ScriptedService[] = [
      { hang: ["eth_blockNumber"] },
      { hang: ["eth_getBlockByNumber"] },
      { hang: ["eth_simulateV1"] },
      { fail: ["eth_blockNumber"] },
      { fail: ["eth_getBlockByNumber"] },
      { header: () => null },
      { noSimulateV1: true },
    ];
    for (const second of cases) {
      const { guard } = setup({ second });
      const verdict = await guard().check(swapInput());
      expect(verdict.level, JSON.stringify(second)).toBe("unverified");
      expect(warningCodes(verdict), JSON.stringify(second)).toEqual(["SECOND_OPINION_UNAVAILABLE"]);
    }
  });

  it("falls back to exactly today's simulation when it fails before a block is agreed", async () => {
    const { pair, provider } = setup({ second: { fail: ["eth_blockNumber"] } });
    const outcome = await provider.simulate({ chainId: 1, account: USER, calls: [{ to: ROUTER, data: "0x", value: 0n }] });
    expect(outcome.secondOpinion?.kind).toBe("unavailable");
    const [, tag] = simulations(pair.requests.primary)[0]!.params;
    expect(tag).toBe("latest");
  });

  it("remembers a definite 'no eth_simulateV1', and asks again after an unclear answer", async () => {
    const definite = setup({ second: { noSimulateV1: true } });
    await definite.guard().check(swapInput());
    await definite.guard().check(swapInput());
    expect(definite.pair.requests.second.filter((r) => r.method === "eth_simulateV1").length).toBe(1);

    let failing = true;
    const pair = new ScriptedPairProvider({ run: honest });
    const flaky: typeof pair.second = async (method, params) => {
      if (method === "eth_simulateV1" && failing) throw new Error("fetch failed");
      return pair.second(method, params);
    };
    const provider = new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: flaky, host: HOST, sleep: async () => {}, timeoutMs: 50 }).provider(
      new EthSimulateV1Provider(pair.primary),
    );
    expect((await new Guard(provider, OPTIONS).check(swapInput())).level).toBe("unverified");
    failing = false;
    expect((await new Guard(provider, OPTIONS).check(swapInput())).level).toBe("verified");
  });

  it("gives one check 12 seconds of the second service's time in all, however many requests it takes", async () => {
    // Each request answered just inside its own timeout: without a budget
    // for the whole check, that is heads, catch-up, header and test-run in
    // turn, and the plan waits for all of them before it can be signed.
    const pair = new ScriptedPairProvider({ run: honest });
    const slow: typeof pair.second = (method, params) => new Promise((resolve) => setTimeout(resolve, 40)).then(() => pair.second(method, params));
    const provider = new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: slow, host: HOST, sleep: async () => {}, timeoutMs: 1_000, budgetMs: 100 }).provider(
      new EthSimulateV1Provider(pair.primary),
    );
    const started = Date.now();
    const verdict = await new Guard(provider, OPTIONS).check(swapInput());
    expect(Date.now() - started).toBeLessThan(400);
    expect(verdict.level).toBe("unverified");
    expect(warningCodes(verdict)).toEqual(["SECOND_OPINION_UNAVAILABLE"]);
    expect(SECOND_OPINION_BUDGET_MS).toBe(12_000);
  });

  it("counts only the second service's own time against that: a slow main service can't make it 'unavailable'", async () => {
    const pair = new ScriptedPairProvider({ run: honest });
    const slow: typeof pair.primary = (method, params) => new Promise((resolve) => setTimeout(resolve, 60)).then(() => pair.primary(method, params));
    const provider = new SecondOpinionPair({ primaryRpc: slow, secondRpc: pair.second, host: HOST, sleep: async () => {}, timeoutMs: 1_000, budgetMs: 100 }).provider(
      new EthSimulateV1Provider(slow),
    );
    const verdict = await new Guard(provider, OPTIONS).check(swapInput());
    expect(verdict.level).toBe("verified");
  });

  it("gives every request to the second service 8 seconds", () => {
    expect(SECOND_OPINION_TIMEOUT_MS).toBe(8_000);
    expect(SECOND_OPINION_RETRY_MS).toBe(2_000);
    expect(SECOND_OPINION_HEADER_SHARE_MS).toBe(4_000);
  });

  it("never quotes the second service's own error text, which could carry its URL", async () => {
    const pair = new ScriptedPairProvider({ run: honest });
    const leaky: typeof pair.second = async (method, params) => {
      if (method === "eth_simulateV1" && hasCalls(params)) throw new Error("eth_simulateV1: https://rpc.example/v2/SECRETKEY rate limited");
      return pair.second(method, params);
    };
    const provider = new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: leaky, host: HOST, sleep: async () => {} }).provider(
      new EthSimulateV1Provider(pair.primary),
    );
    const verdict = await new Guard(provider, OPTIONS).check(swapInput());
    expect(JSON.stringify(verdict)).not.toContain("SECRETKEY");
    expect(verdict.level).toBe("unverified");
  });
});

describe("the main service failing", () => {
  /** A main service that fails `primary`'s way, compared with an honest second. */
  const failingMain = (primary: ScriptedService, run: () => ScriptedResult = honest) => {
    const failing = new ScriptedPairProvider({ run, primary });
    const second = new ScriptedPairProvider({ run });
    return new SecondOpinionPair({ primaryRpc: failing.primary, secondRpc: second.second, host: HOST, sleep: async () => {} }).provider(
      // The probe answers: this is a service that simulates, failing now.
      new EthSimulateV1Provider(async (method, params) => (method === "eth_simulateV1" && !hasCalls(params) ? [{ calls: [] }] : failing.primary(method, params))),
    );
  };

  it("still refuses what its own test-run shows, when a read the pin needs fails but it can simulate", async () => {
    // Without a second opinion this theft is refused; failing eth_blockNumber must not make it signable.
    const theft = () => ({ status: "success" as const, logs: [...honestLogs(), transferLog(USDCish(), USER, ATTACKER, 1n)] });
    for (const primary of [{ fail: ["eth_blockNumber"] }, { fail: ["eth_getBlockByNumber"] }, { header: () => null }] as ScriptedService[]) {
      const verdict = await new Guard(failingMain(primary, theft), OPTIONS).check(swapInput());
      expect(verdict.level, JSON.stringify(primary)).toBe("rejected");
      expect(codes(verdict)).toEqual(["UNEXPECTED_TOKEN_TRANSFER"]);
    }
  });

  it("is refused under requireSimulation, and never verified", async () => {
    const verdict = await new Guard(failingMain({ fail: ["eth_blockNumber"] }), { ...OPTIONS, requireSimulation: true }).check(swapInput());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
  });

  it("is the Guard's usual 'not checked', never a second-opinion state", async () => {
    const cases = [{ fail: ["eth_blockNumber"] }, { fail: ["eth_getBlockByNumber"] }, { fail: ["eth_simulateV1"] }, { header: () => null }, { failPinned: true }];
    for (const primary of cases as ScriptedService[]) {
      const { pair } = setup();
      const failing = new ScriptedPairProvider({ run: honest, primary });
      const provider = new SecondOpinionPair({ primaryRpc: failing.primary, secondRpc: pair.second, host: HOST, sleep: async () => {} }).provider(
        // The probe answers: this is a service that simulates, failing now.
        new EthSimulateV1Provider(async (method, params) => (method === "eth_simulateV1" && !hasCalls(params) ? [{ calls: [] }] : failing.primary(method, params))),
      );
      const verdict = await new Guard(provider, OPTIONS).check(swapInput());
      expect(verdict.level, JSON.stringify(primary)).toBe("unverified");
      expect(warningCodes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
      // Told apart from a main service that simply can't test-run.
      expect(verdict.warnings[0]!.detail?.["failure"], JSON.stringify(primary)).toBeTypeOf("string");
    }
  });

  // Which of its own requests fail is the main service's choice. Failing the
  // one the comparison needs must not throw away what the second service said.
  describe("does not throw away the second service's answer", () => {
    const outflow = () => [...honestLogs(), transferLog(SPX, USER, ATTACKER, 1n)];
    const theft = (): ScriptedResult => ({ status: "success", logs: outflow() });

    it("failing only its test-run on the agreed block, while the second shows an outflow: refused", async () => {
      const { guard, pair } = setup({ primary: { failPinned: true }, second: { run: theft } });
      const verdict = await guard().check(swapInput());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
      expect(verdict.violations[0]!.message).toMatch(/without an agreed block/);
      // The second's test-run on the agreed block is the one compared.
      expect(simulations(pair.requests.second)).toHaveLength(1);
    });

    it("failing to give its head or the agreed header, while the second shows an outflow: refused", async () => {
      for (const primary of [{ fail: ["eth_blockNumber"] }, { fail: ["eth_getBlockByNumber"] }, { header: () => null }] as ScriptedService[]) {
        const { guard } = setup({ primary, second: { run: theft } });
        const verdict = await guard().check(swapInput());
        expect(verdict.level, JSON.stringify(primary)).toBe("rejected");
        expect(codes(verdict), JSON.stringify(primary)).toEqual(["SECOND_OPINION_DISAGREES"]);
      }
    });

    it("saying it can't test-run at all: the second's test-run is judged in its place", async () => {
      const refused = setup({ primary: { noSimulateV1: true }, second: { run: theft } });
      const verdict = await refused.guard().check(swapInput());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["MAX_IN_EXCEEDED"]);
      expect(simulations(refused.pair.requests.second)).toHaveLength(1);

      const clean = await setup({ primary: { noSimulateV1: true } }).guard().check(swapInput());
      expect(clean.level).toBe("unverified");
      expect(warningCodes(clean)).toEqual(["SIMULATION_UNAVAILABLE"]);
    });

    it("failing every test-run it's asked for: the second's is judged in its place", async () => {
      const failing = new ScriptedPairProvider({ run: honest, primary: { fail: ["eth_simulateV1"] } });
      const second = new ScriptedPairProvider({ run: theft });
      const provider = new SecondOpinionPair({ primaryRpc: failing.primary, secondRpc: second.second, host: HOST, sleep: async () => {} }).provider(
        // The probe answers: this is a service that simulates, failing now.
        new EthSimulateV1Provider(async (method, params) => (method === "eth_simulateV1" && !hasCalls(params) ? [{ calls: [] }] : failing.primary(method, params))),
      );
      const verdict = await new Guard(provider, OPTIONS).check(swapInput());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["MAX_IN_EXCEEDED"]);
    });

    it("stands alone, 'not checked', only when the second service fails as well", async () => {
      const { guard } = setup({ primary: { fail: ["eth_blockNumber"] }, second: { fail: ["eth_simulateV1"] } });
      const verdict = await guard().check(swapInput());
      expect(verdict.level).toBe("unverified");
      expect(warningCodes(verdict)).toEqual(["SIMULATION_UNAVAILABLE"]);
      const both = setup({ primary: { fail: ["eth_blockNumber"], run: theft }, second: { fail: ["eth_simulateV1"] } });
      expect(codes(await both.guard().check(swapInput()))).toEqual(["MAX_IN_EXCEEDED"]);
    });
  });
});

// ─── A main service that steers ───────────────────────────────────────────────

describe("a main service steering the comparison is refused, not downgraded", () => {
  it("reporting its head 100 ahead: refused after one retry", async () => {
    const { guard, pair, sleeps } = setup({ primary: { head: (h) => h + 100n } });
    const verdict = await guard().check(swapInput());
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ reason: "heads", host: HOST });
    expect(sleeps).toEqual([SECOND_OPINION_RETRY_MS]);
    expect(pair.requests.second.filter((r) => r.method === "eth_blockNumber").length).toBe(2);
  });

  it("reporting its head 100 behind", async () => {
    const { guard } = setup({ primary: { head: (h) => h - 100n } });
    const verdict = await guard().check(swapInput());
    expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ reason: "heads" });
  });

  it("2 or 3 blocks apart after a moment to catch up and a retry, whichever is behind: refused, never 'unavailable'", async () => {
    // A main service reporting its head ahead makes the second look behind:
    // that must not be the second service's own failure, or a lying main
    // service could make any disagreement signable.
    for (const [primary, second] of [
      [{ head: (h: bigint) => h - 2n }, {}],
      [{ head: (h: bigint) => h - 3n }, {}],
      [{}, { head: (h: bigint) => h - 2n }],
      [{}, { head: (h: bigint) => h - 3n }],
    ] as [ScriptedService, ScriptedService][]) {
      const { guard, sleeps } = setup({ primary, second });
      const verdict = await guard().check(swapInput());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
      expect(verdict.violations[0]!.detail).toMatchObject({ reason: "heads" });
      expect(sleeps).toContain(SECOND_OPINION_RETRY_MS);
    }
  });

  it("a service lagging 3 blocks can't have a token that changed since then checked as it was", async () => {
    // Harmless on top of blocks up to 2 back, a theft from the block before
    // the head on: the honest chain, as both services run it.
    const run = (r: ScriptedRun): ScriptedResult => (simulatedBlock(r) > SCRIPTED_HEAD - 1n ? { status: "success", logs: [...honestLogs(), transferLog(SPX, USER, ATTACKER, 1n)] } : honest());
    const alone = await new Guard(new EthSimulateV1Provider(new ScriptedPairProvider({ run }).primary), OPTIONS).check(swapInput());
    expect(alone.level).toBe("rejected");
    for (const lagging of ["primary", "second"] as const) {
      const { guard } = setup({ run, [lagging]: { head: (h: bigint) => h - 3n } });
      expect((await guard().check(swapInput())).level, lagging).toBe("rejected");
    }
  });

  it("with requireSimulation off, and even when its own test-run is clean", async () => {
    const { guard } = setup({ primary: { head: (h) => h + 4n } });
    expect((await guard({ requireSimulation: false }).check(swapInput())).signable).toBe(false);
  });

  it("reporting another hash for the agreed block: refused after one retry", async () => {
    const { guard, sleeps } = setup({ primary: { header: (h) => ({ ...h, hash: `0x${"ee".repeat(32)}` }) } });
    const verdict = await guard().check(swapInput());
    expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ reason: "block-hash" });
    expect(sleeps).toEqual([SECOND_OPINION_RETRY_MS]);
  });

  it("a one-block reorg at the tip is tolerated: the retry reads both again", async () => {
    let reads = 0;
    const { guard } = setup({ primary: { header: (h) => (reads++ === 0 ? { ...h, hash: `0x${"ee".repeat(32)}` } : h) } });
    expect((await guard().check(swapInput())).level).toBe("verified");
  });

  describe("a contract that behaves only before time T", () => {
    // Honest before T, theft from T on. T falls just before the agreed block's
    // time, so the real transaction, later still, is a theft.
    const T = pairTime() - 6n;
    const run = ({ time }: ScriptedRun): ScriptedResult =>
      time < T ? honest() : { status: "success", logs: [...honestLogs(), transferLog(SPX, USER, ATTACKER, AMOUNT_IN)] };

    it("without a second opinion, a main service that runs it early shows it clean (the attack)", async () => {
      const pair = new ScriptedPairProvider({ run, primary: { run: (r) => run({ ...r, time: T - 100n }) } });
      const verdict = await new Guard(new EthSimulateV1Provider(pair.primary), OPTIONS).check(swapInput());
      expect(verdict.level).toBe("verified");
    });

    it("is refused when the main service reports an early time in its header", async () => {
      const { guard } = setup({ run, primary: { header: (h) => ({ ...h, timestamp: h.timestamp - 100n }) } });
      const verdict = await guard().check(swapInput());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
    });

    it("is refused when the main service ignores the pinned time and runs it early", async () => {
      const { guard } = setup({ run, primary: { run: (r) => run({ ...r, time: T - 100n }) } });
      const verdict = await guard().check(swapInput());
      expect(verdict.level).toBe("rejected");
      expect(codes(verdict)).toEqual(["SECOND_OPINION_DISAGREES"]);
    });

    it("is refused by the main service's own checks when it runs it at the agreed time", async () => {
      const { guard } = setup({ run });
      // More SPX leaves than the swap sells: the main service's own code.
      expect(codes(await guard().check(swapInput()))).toEqual(["MAX_IN_EXCEEDED"]);
    });
  });
});

function pairTime(): bigint {
  return new ScriptedPairProvider({ run: honest }).header(SCRIPTED_HEAD).timestamp + 12n;
}

/** The block a scripted run simulates: the pinned one, else the one after the service's head, from its time. */
function simulatedBlock(run: ScriptedRun): bigint {
  return SCRIPTED_HEAD + (run.time - pairTime()) / 12n + 1n;
}

// ─── Across every Guard path ──────────────────────────────────────────────────

describe.each(GUARD_PATHS.map((path) => [path.name, path] as const))("across Guards: %s", (_, path) => {
  const pairFor = (second: ScriptedService = {}, primary: ScriptedService = {}) => {
    const pair = new ScriptedPairProvider({ run: () => ({ status: "success", logs: path.logs() }), primary, second });
    return new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: pair.second, host: HOST, sleep: async () => {}, timeoutMs: 50 }).provider(
      new EthSimulateV1Provider(pair.primary),
    );
  };

  it("a shortfall on the second is refused", async () => {
    const verdict = await path.check(pairFor({ run: () => ({ status: "success", logs: path.logs().slice(1) }) }), false);
    expect(verdict.level).toBe("rejected");
  });

  it("a main service with its head 100 ahead is refused", async () => {
    const verdict = await path.check(pairFor({}, { head: (h) => h + 100n }), false);
    expect(verdict.level).toBe("rejected");
  });

  it(`an unavailable second is ${path.unavailable}`, async () => {
    const verdict = await path.check(pairFor({ fail: ["eth_simulateV1"] }), false);
    expect(verdict.level).toBe(path.unavailable);
    expect([...verdict.violations, ...verdict.warnings].map((v) => v.code)).toContain("SECOND_OPINION_UNAVAILABLE");
  });

  // A lying main service failing the one request the comparison needs, and
  // faking the rest, while the second service reports more than it does.
  const more = (): ScriptedService => ({ run: () => ({ status: "success", logs: [...path.logs(), EXTRA] }) });

  it("a main service failing only its test-run on the agreed block, while the second shows more, is refused", async () => {
    const verdict = await path.check(pairFor(more(), { failPinned: true }), false);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toContain("SECOND_OPINION_DISAGREES");
  });

  it("a main service failing to give its head, while the second shows more, is refused", async () => {
    const verdict = await path.check(pairFor(more(), { fail: ["eth_blockNumber"] }), false);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toContain("SECOND_OPINION_DISAGREES");
  });

  it(`a main service that says it can't test-run is judged on the second's test-run, and is ${path.unavailable}, never verified`, async () => {
    const verdict = await path.check(pairFor({}, { noSimulateV1: true }), false);
    expect(verdict.level).toBe(path.unavailable);
    expect([...verdict.violations, ...verdict.warnings].map((v) => v.code)).toContain("SIMULATION_UNAVAILABLE");
  });
});


// ─── Never better with a second opinion ───────────────────────────────────────

describe("property: with a second opinion, a verdict is never better than without", () => {
  const rank = { rejected: 0, unverified: 1, verified: 2 } as const;
  const results: Record<string, () => ScriptedResult> = {
    clean: honest,
    theft: () => ({ status: "success", logs: [...honestLogs(), transferLog(SPX, USER, ATTACKER, 1n)] }),
    shortfall: () => ({ status: "success", logs: [transferLog(SPX, USER, ROUTER, AMOUNT_IN), transferLog(WETH, ROUTER, USER, 1n)] }),
    reverted: () => ({ status: "reverted", reason: "execution reverted" }),
  };
  const heads = [0n, 0n, 0n, 1n, -1n, 2n, -2n, 3n, -3n, 4n, -4n, 100n, -100n];
  const failures: (ScriptedService["fail"] | undefined)[] = [undefined, undefined, undefined, ["eth_simulateV1"], ["eth_blockNumber"], ["eth_getBlockByNumber"]];
  /** How the main service fails, when it does: including the one failure a lying service would pick. */
  const primaryFailures: ScriptedService[] = [
    { fail: ["eth_blockNumber"] },
    { fail: ["eth_getBlockByNumber"] },
    { fail: ["eth_simulateV1"] },
    { failPinned: true },
    { noSimulateV1: true },
  ];
  /**
   * The honest chain in 1 case in 5: a token harmless on top of blocks up to 2
   * back and a theft from the block before the head on. Both services run it;
   * which block a check lands on is what decides it. The main service is then
   * at the head, as it is when it reports honestly: a second service a block
   * behind it is the lag the two are allowed (MAX_HEAD_GAP), so a change made
   * within that one block is the residual the header states, not a failure.
   */
  const flipped = (run: ScriptedRun): ScriptedResult =>
    simulatedBlock(run) > SCRIPTED_HEAD - 1n ? results["theft"]!() : honest();

  /** mulberry32: a fixed sequence, so a failure reproduces. */
  function random(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("holds over 600 random pairs", async () => {
    const next = random(0x5ec0d);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const names = Object.keys(results);
    for (let i = 0; i < 600; i++) {
      const flip = next() < 0.2;
      const mine = pick(names);
      const theirs = next() < 0.5 ? mine : pick(names);
      const head = pick(heads);
      const secondHead = next() < 0.3 ? pick(heads) : 0n;
      const hashLie = next() < 0.1;
      const fail = pick(failures);
      const requireSimulation = next() < 0.3;
      const primaryFails = next() < 0.2 ? pick(primaryFailures) : null;
      const primary: ScriptedService = {
        ...(flip ? {} : { run: results[mine]! }),
        head: (h) => h + (flip ? 0n : head),
        ...(hashLie ? { header: (h) => ({ ...h, hash: `0x${"ee".repeat(32)}` }) } : {}),
        ...primaryFails,
      };
      const second: ScriptedService = {
        ...(flip ? {} : { run: results[theirs]! }),
        head: (h) => h + secondHead,
        ...(fail === undefined ? {} : { fail }),
      };
      const pair = new ScriptedPairProvider({ run: flip ? flipped : honest, primary, second });
      const without = await new Guard(new EthSimulateV1Provider(pair.primary), { ...OPTIONS, requireSimulation }).check(swapInput());
      const provider = new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: pair.second, host: HOST, sleep: async () => {}, timeoutMs: 50 }).provider(
        new EthSimulateV1Provider(pair.primary),
      );
      const withSecond = await new Guard(provider, { ...OPTIONS, requireSimulation }).check(swapInput());
      const scenario = JSON.stringify({ flip, mine, theirs, head: String(head), secondHead: String(secondHead), hashLie, fail, primaryFails, requireSimulation });
      expect(rank[withSecond.level], scenario).toBeLessThanOrEqual(rank[without.level]);
      if (flip || fail !== undefined) continue;
      // A main service that runs nothing makes no claim to disagree with:
      // the second's test-run is judged alone, and signable only when clean.
      const ranNothing = primaryFails?.noSimulateV1 === true || primaryFails?.fail?.includes("eth_simulateV1") === true;
      if (ranNothing) {
        if (withSecond.signable) expect(theirs, scenario).toBe("clean");
        continue;
      }
      // And a disagreement is never signable, whatever the main service fails.
      if (mine !== theirs) expect(withSecond.signable, scenario).toBe(false);
    }
  });
});

// ─── The pieces ───────────────────────────────────────────────────────────────

describe("applySecondOpinion", () => {
  const disagrees = { kind: "disagrees" as const, host: HOST, reason: "result" as const, detail: "event 1 differs" };
  const synthetic: Pick<SimulationOutcome, "status" | "revertReason" | "secondOpinion"> = {
    status: "reverted",
    revertReason: `${SECOND_OPINION_REVERT_PREFIX}event 1 differs`,
    secondOpinion: disagrees,
  };

  it("relabels the disagreement's own revert, once", () => {
    const verdict = rejected([
      { code: "SIMULATION_REVERTED", message: synthetic.revertReason! },
      { code: "SIMULATION_REVERTED", message: synthetic.revertReason! },
    ]);
    const out = applySecondOpinion(verdict, synthetic, { neverUnchecked: false });
    expect(out.violations.map((v) => v.code)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(out.violations[0]!.detail).toEqual({ host: HOST, reason: "result", difference: "event 1 differs" });
  });

  it("refuses a pass that carries a disagreement: a path that let the revert through still refuses", () => {
    const out = applySecondOpinion(verified(), { status: "success", secondOpinion: disagrees }, { neverUnchecked: false });
    expect(out.level).toBe("rejected");
  });

  it("keeps the main service's own refusal and its code", () => {
    const own = rejected([{ code: "SIMULATION_REVERTED", message: "execution reverted: STF" }]);
    expect(applySecondOpinion(own, { status: "reverted", revertReason: "execution reverted: STF", secondOpinion: disagrees }, { neverUnchecked: false })).toBe(own);
  });

  it("leaves a refusal a refusal when the second didn't answer, and warnings as warnings", () => {
    const unavailable = { status: "success" as const, secondOpinion: { kind: "unavailable" as const, host: HOST, reason: "timeout" } };
    const refusal = rejected([{ code: "MIN_OUT_NOT_MET", message: "x" }]);
    expect(applySecondOpinion(refusal, unavailable, { neverUnchecked: false })).toBe(refusal);
    const oracle = verified([{ code: "ORACLE_DIVERGENCE", message: "far" }]);
    const out = applySecondOpinion(oracle, unavailable, { neverUnchecked: false });
    expect(out.level).toBe("unverified");
    expect(out.warnings.map((w) => w.code)).toEqual(["ORACLE_DIVERGENCE", "SECOND_OPINION_UNAVAILABLE"]);
    expect(applySecondOpinion(unverified([]), unavailable, { neverUnchecked: true }).level).toBe("rejected");
  });

  it("changes nothing when the second agrees or none was asked", () => {
    const v = verified();
    expect(applySecondOpinion(v, { status: "success", secondOpinion: { kind: "agrees", host: HOST } }, { neverUnchecked: true })).toBe(v);
    expect(applySecondOpinion(v, { status: "success" }, { neverUnchecked: true })).toBe(v);
    expect(applySecondOpinion(v, undefined, { neverUnchecked: true })).toBe(v);
  });
});

describe("compareOutcomes", () => {
  const ok = (logs: SimLog[]): SimulationOutcome => ({ status: "success", gasUsed: 1n, logs });

  it("compares addresses, topics and data without regard to case", () => {
    const upper = honestLogs().map((l) => ({ ...l, data: l.data.toUpperCase().replace("0X", "0x") as typeof l.data }));
    expect(compareOutcomes(ok(honestLogs()), ok(upper))).toBeNull();
  });

  it("names the first difference", () => {
    expect(compareOutcomes(ok(honestLogs()), ok(honestLogs().slice(1)))).toMatch(/event 1 of 2/);
    expect(compareOutcomes(ok(honestLogs()), ok([...honestLogs(), transferLog(SPX, USER, ATTACKER, 1n)]))).toMatch(/2 events and the second 3/);
    expect(compareOutcomes(ok([]), { status: "reverted", gasUsed: 1n, logs: [] })).toMatch(/goes through on the main service and reverts on the second/);
  });

  it("sums ether per account, so the order and split of its pseudo-logs don't matter", () => {
    const a = [transferLog(NATIVE, USER, ROUTER, 10n), transferLog(NATIVE, ROUTER, WETH, 10n)];
    const b = [transferLog(NATIVE, ROUTER, WETH, 4n), transferLog(NATIVE, USER, ROUTER, 10n), transferLog(NATIVE, ROUTER, WETH, 6n)];
    expect(compareOutcomes(ok(a), ok(b))).toBeNull();
    expect(compareOutcomes(ok(a), ok([transferLog(NATIVE, USER, ATTACKER, 10n)]))).toMatch(/ether moves differently/);
  });
});

describe("secondOpinionHost", () => {
  it("is the host name alone, never the path that may hold a key", () => {
    expect(secondOpinionHost("https://eth-mainnet.g.alchemy.com/v2/SECRETKEY")).toBe("eth-mainnet.g.alchemy.com");
    expect(secondOpinionHost("http://LOCALHOST:8545/")).toBe("localhost");
    expect(secondOpinionHost("not a url")).toBe("");
  });
});
