/**
 * Red team: the security claim, as a test suite.
 *
 * spDEX tells users that an untrusted module cannot steal from them. That is a
 * falsifiable claim, so it is written here as tests a hostile module must fail.
 * Each case starts from `honestPlan()` and changes exactly one thing — the diff
 * from honest *is* the attack.
 *
 * If any test in this file goes green-to-red, do not ship. If one starts
 * passing for a new reason, check it is still testing what it claims.
 */

import { describe, expect, it } from "vitest";
import {
  ATTACKER,
  COLD_WALLET,
  NATIVE,
  NATIVE_AMOUNT_IN,
  NATIVE_HONEST_OUT,
  NATIVE_MIN_OUT,
  nativeIntent,
  nativePlan,
  AMOUNT_IN,
  HONEST_OUT,
  MIN_OUT,
  NOW,
  ROUTER,
  SPX,
  USDC,
  USER,
  WETH,
  approvalLog,
  honestIntent,
  honestManifest,
  honestPlan,
  malformedTransferLog,
  permit2ApprovalLog,
  permit2PermitLog,
  transferLog,
  FlakySimulationProvider,
  NoSimulationProvider,
  ScriptedSimulationProvider,
} from "@spdex/testing";
import { PERMIT2_ADDRESS, type GuardViolationCode } from "@spdex/core";
import type { SimLog } from "@spdex/chain";
import { Guard, type GuardInput, type OracleProvider } from "../../src/guard.js";

const OPTIONS = { chainId: 1, requireSimulation: false, oracleDivergenceBps: 200 };

/** The log stream an honest Uniswap swap produces. */
const honestLogs = (): SimLog[] => [
  transferLog(SPX, USER, ROUTER, AMOUNT_IN),
  transferLog(WETH, ROUTER, USER, HONEST_OUT),
];

const guardWith = (logs: SimLog[]) =>
  new Guard(ScriptedSimulationProvider.succeedingWith(logs), OPTIONS);

const input = (overrides: Partial<GuardInput> = {}): GuardInput => ({
  plan: honestPlan(),
  expectedIntent: honestIntent(),
  manifest: honestManifest(),
  extraTrustedContracts: [],
  nowSeconds: NOW,
  ...overrides,
});

const codes = (v: { violations: { code: GuardViolationCode }[] }) =>
  v.violations.map((x) => x.code);

describe("Guard — the honest baseline", () => {
  it("permits a well-formed swap", async () => {
    // If this ever fails, every rejection below is meaningless: a Guard that
    // refuses everything is trivially "secure" and completely useless.
    const verdict = await guardWith(honestLogs()).check(input());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
    expect(verdict.signable).toBe(true);
  });
});

describe("Red team — theft via the transaction itself", () => {
  it("blocks proceeds redirected to the attacker", async () => {
    // The module builds a real swap, but WETH lands on the attacker. Every
    // static check passes; only measuring the delta at the *recipient* catches it.
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(WETH, ROUTER, ATTACKER, HONEST_OUT),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("RECIPIENT_MISMATCH");
  });

  it("permits proceeds sent to a different recipient the user named", async () => {
    // account !== recipient. Not an attack: the user asked for the output to
    // land on their cold wallet. A Guard measuring the delta at `account`
    // would wrongly reject this.
    const intent = honestIntent({ recipient: COLD_WALLET });
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(WETH, ROUTER, COLD_WALLET, HONEST_OUT),
    ]).check(input({ plan: honestPlan({ intent }), expectedIntent: intent }));

    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("blocks proceeds diverted to the account when another recipient was named", async () => {
    // The mirror image: the user said "send it to my cold wallet", the module
    // sends it to the hot wallet instead. Still a violated instruction, and the
    // case that proves the delta is measured at the recipient rather than the
    // signer. Without this, measuring at `account` passes every other test.
    const intent = honestIntent({ recipient: COLD_WALLET });
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(WETH, ROUTER, USER, HONEST_OUT),
    ]).check(input({ plan: honestPlan({ intent }), expectedIntent: intent }));

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("RECIPIENT_MISMATCH");
  });

  it("blocks a second token being swept out of the wallet", async () => {
    const verdict = await guardWith([
      ...honestLogs(),
      transferLog(USDC, USER, ATTACKER, 5_000_000_000n),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("blocks spending more of the input token than agreed", async () => {
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN * 3n),
      transferLog(WETH, ROUTER, USER, HONEST_OUT),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("MAX_IN_EXCEEDED");
  });

  it("blocks an output below the promised minimum", async () => {
    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(WETH, ROUTER, USER, MIN_OUT - 1n),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("MIN_OUT_NOT_MET");
  });

  it("blocks an undeclared approval granted mid-transaction", async () => {
    // The classic drainer: the swap is real, but it also leaves an allowance
    // behind for the attacker to empty the wallet later.
    const verdict = await guardWith([
      ...honestLogs(),
      approvalLog(USDC, USER, ATTACKER, 2n ** 256n - 1n),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("permits an approval revocation", async () => {
    // Zero-amount approvals reduce authority and must not be treated as attacks,
    // or routers that clean up after themselves become unusable.
    const verdict = await guardWith([
      ...honestLogs(),
      approvalLog(SPX, USER, ROUTER, 0n),
    ]).check(input());

    expect(verdict.signable).toBe(true);
  });
});

describe("What gets simulated", () => {
  it("simulates the plan's approvals before its calls", async () => {
    // Simulating the swap alone means simulating it without the allowance it
    // depends on, so it reverts — and the Guard rejects every first-time swap,
    // because the user has no allowance precisely because they have not
    // swapped yet. An e2e test found this by being honest about a clean chain.
    const provider = ScriptedSimulationProvider.succeedingWith(honestLogs());
    await new Guard(provider, OPTIONS).check(input());

    const simulated = provider.lastRequest?.calls ?? [];
    expect(simulated).toHaveLength(2);
    // approve(SPX -> router) first…
    expect(simulated[0]?.to).toBe(SPX);
    expect(simulated[0]?.data.startsWith("0x095ea7b3")).toBe(true);
    expect(simulated[0]?.data).toContain(ROUTER.slice(2));
    // …then the swap itself.
    expect(simulated[1]?.to).toBe(ROUTER);
  });

  it("does not flag a plan's own declared approval as unexpected", async () => {
    // The approval now appears in the simulated log stream because the Guard
    // put it there. Treating it as an undeclared grant would make every swap
    // self-reject.
    const verdict = await guardWith([
      approvalLog(SPX, USER, ROUTER, AMOUNT_IN),
      ...honestLogs(),
    ]).check(input());

    expect(verdict.signable).toBe(true);
    expect(codes(verdict)).not.toContain("UNEXPECTED_APPROVAL");
  });
});

describe("Red team — theft via the plan's declarations", () => {
  it("blocks a call to a contract the module never declared", async () => {
    const verdict = await guardWith(honestLogs()).check(
      input({ plan: honestPlan({ calls: [{ to: ATTACKER, data: "0xdead", value: 0n }] }) }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNDECLARED_TARGET");
  });

  it("blocks an approval to an undeclared spender", async () => {
    const verdict = await guardWith(honestLogs()).check(
      input({
        plan: honestPlan({ approvals: [{ token: SPX, spender: ATTACKER, amount: AMOUNT_IN }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("APPROVAL_UNDECLARED_SPENDER");
  });

  it("blocks an infinite approval beyond the agreed amount", async () => {
    const verdict = await guardWith(honestLogs()).check(
      input({
        plan: honestPlan({
          approvals: [{ token: SPX, spender: ROUTER, amount: 2n ** 256n - 1n }],
        }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("APPROVAL_EXCEEDS_INTENT");
  });

  it("blocks approving a token the user never agreed to sell", async () => {
    const verdict = await guardWith(honestLogs()).check(
      input({
        plan: honestPlan({ approvals: [{ token: USDC, spender: ROUTER, amount: 1n }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("APPROVAL_EXCEEDS_INTENT");
  });

  it("blocks a plan carrying a different intent than the user approved", async () => {
    // The screen says one thing, the plan says another. Caught by comparing
    // canonical encodings, so a structurally-different lookalike cannot pass.
    const verdict = await guardWith(honestLogs()).check(
      input({ plan: honestPlan({ intent: honestIntent({ recipient: ATTACKER }) }) }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("INTENT_MISMATCH");
  });

  it("blocks a plan that siphons native ETH", async () => {
    const verdict = await guardWith(honestLogs()).check(
      input({
        plan: honestPlan({ calls: [{ to: ROUTER, data: "0xdeadbeef", value: 10n ** 18n }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_ETH_TRANSFER");
  });

  it("blocks a module whose own quote undercuts the intent", async () => {
    const base = honestPlan();
    const verdict = await guardWith(honestLogs()).check(
      input({ plan: honestPlan({ meta: { ...base.meta, quotedAmountOut: MIN_OUT - 1n } }) }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("MIN_OUT_NOT_MET");
  });

  it("blocks an expired intent", async () => {
    const expired = honestIntent({ deadline: NOW - 1n });
    const verdict = await guardWith(honestLogs()).check(
      input({ plan: honestPlan({ intent: expired }), expectedIntent: expired }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("DEADLINE_EXPIRED");
  });

  it("blocks a plan for the wrong chain", async () => {
    const wrongChain = honestIntent({ chainId: 8453 });
    const verdict = await guardWith(honestLogs()).check(
      input({ plan: honestPlan({ intent: wrongChain }), expectedIntent: wrongChain }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("CHAIN_MISMATCH");
  });
});

describe("Red team — an allowance left inside Permit2", () => {
  /*
   * Permit2 keeps allowances of its own, apart from the token's. Once the
   * user has given Permit2 the ERC-20 permission (the first batched tip asks
   * for it, and many people gave it to Uniswap long ago), a swap that also
   * calls `Permit2.approve(token, attacker, max, never)` leaves the attacker
   * able to take the whole balance later with `Permit2.transferFrom`, and no
   * signature. Permit2 logs its own `Approval` event for that, not the
   * token's, so a Guard reading only ERC-20 events saw nothing.
   */
  const PERMIT2_MAX = (1n << 160n) - 1n;
  const withPermit2 = (contracts: readonly `0x${string}`[] = []) =>
    honestManifest({ contracts: [...honestManifest().contracts, PERMIT2_ADDRESS, ...contracts] });

  it("blocks a Permit2 allowance granted mid-swap", async () => {
    const verdict = await guardWith([
      ...honestLogs(),
      permit2ApprovalLog(USER, SPX, ATTACKER, PERMIT2_MAX),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("blocks a Permit2 allowance set from a signature mid-swap", async () => {
    const verdict = await guardWith([
      ...honestLogs(),
      permit2PermitLog(USER, WETH, ATTACKER, PERMIT2_MAX),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("does not let a declared ERC-20 approval cover a Permit2 allowance for the same pair", async () => {
    // The plan declares approve(SPX, router, amountIn), bounded by the static
    // layer. A Permit2 allowance for the same token and spender is another
    // permission, unbounded and outliving the swap.
    const verdict = await guardWith([
      approvalLog(SPX, USER, ROUTER, AMOUNT_IN),
      ...honestLogs(),
      permit2ApprovalLog(USER, SPX, ROUTER, PERMIT2_MAX),
    ]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("permits a Permit2 allowance being taken away", async () => {
    const verdict = await guardWith([...honestLogs(), permit2ApprovalLog(USER, SPX, ROUTER, 0n)]).check(input());
    expect(verdict.signable).toBe(true);
  });

  it("blocks a call to Permit2 before simulating, even from a module that declares it", async () => {
    // Without simulation the verdict would be `unverified`, which is signable,
    // so the static layer has to refuse this on its own.
    const provider = ScriptedSimulationProvider.succeedingWith(honestLogs());
    const verdict = await new Guard(provider, OPTIONS).check(
      input({
        manifest: withPermit2(),
        plan: honestPlan({ calls: [...honestPlan().calls, { to: PERMIT2_ADDRESS, data: "0x87517c45", value: 0n }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("PERMIT2_TARGET");
    expect(provider.lastRequest).toBeNull();
  });

  it("blocks a call to Permit2 even when the user trusts it", async () => {
    const verdict = await new Guard(new NoSimulationProvider(), OPTIONS).check(
      input({
        extraTrustedContracts: [PERMIT2_ADDRESS],
        plan: honestPlan({ calls: [{ to: PERMIT2_ADDRESS, data: "0x87517c45", value: 0n }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("PERMIT2_TARGET");
  });

  it("blocks an approval that names Permit2 as the spender, even declared", async () => {
    const verdict = await guardWith(honestLogs()).check(
      input({
        manifest: withPermit2(),
        plan: honestPlan({ approvals: [{ token: SPX, spender: PERMIT2_ADDRESS, amount: AMOUNT_IN }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("PERMIT2_TARGET");
  });
});

describe("Native ETH", () => {
  /** What an honest ETH -> SPX swap looks like in the log stream. */
  const nativeLogs = (): SimLog[] => [
    transferLog(NATIVE, USER, ROUTER, NATIVE_AMOUNT_IN),
    transferLog(SPX, ROUTER, USER, NATIVE_HONEST_OUT),
  ];

  const nativeInput = (overrides: Partial<GuardInput> = {}): GuardInput =>
    input({ plan: nativePlan(), expectedIntent: nativeIntent(), ...overrides });

  it("permits an honest swap that sells native ETH", async () => {
    // Native movement arrives as an ordinary Transfer log from the native
    // pseudo-address, so the same delta accounting covers ETH and ERC-20s.
    const verdict = await guardWith(nativeLogs()).check(nativeInput());

    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("blocks a plan sending more ETH than the user agreed to", async () => {
    const verdict = await guardWith(nativeLogs()).check(
      nativeInput({
        plan: nativePlan({
          calls: [{ to: ROUTER, data: "0xdeadbeef", value: NATIVE_AMOUNT_IN * 2n }],
        }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_ETH_TRANSFER");
  });

  it("blocks more ETH leaving than intended, even when the call value looks right", async () => {
    // The static check bounds what the plan *declares*; this is the simulation
    // catching what actually happens.
    const verdict = await guardWith([
      transferLog(NATIVE, USER, ROUTER, NATIVE_AMOUNT_IN * 3n),
      transferLog(SPX, ROUTER, USER, NATIVE_HONEST_OUT),
    ]).check(nativeInput());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("MAX_IN_EXCEEDED");
  });

  it("blocks an approval requested alongside a native sale", async () => {
    // Native assets have no allowance mechanism, so this is authorising
    // something other than the swap in front of the user.
    const verdict = await guardWith(nativeLogs()).check(
      nativeInput({
        plan: nativePlan({ approvals: [{ token: SPX, spender: ATTACKER, amount: 1n }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("APPROVAL_EXCEEDS_INTENT");
  });

  it("blocks an approval on the native marker itself", async () => {
    // The case only the native rule catches, and the reason it is not
    // redundant. A declared spender and a token matching the intent's tokenIn
    // satisfies every generic approval check — but tokenIn here is the native
    // pseudo-address, which has no allowance to grant. Mutation testing found
    // the previous case passing on the generic rules alone, so this one pins
    // the native rule specifically.
    const verdict = await guardWith(nativeLogs()).check(
      nativeInput({
        plan: nativePlan({
          approvals: [{ token: NATIVE, spender: ROUTER, amount: NATIVE_AMOUNT_IN }],
        }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("APPROVAL_EXCEEDS_INTENT");
  });

  it("blocks native proceeds landing on the wrong address", async () => {
    // The mirror case: selling SPX for ETH, with the ETH going elsewhere.
    const intent = honestIntent({ tokenIn: SPX, tokenOut: NATIVE, minAmountOut: 10n ** 17n });
    const plan = honestPlan({
      intent,
      meta: { ...honestPlan().meta, quotedAmountOut: 10n ** 18n },
    });

    const verdict = await guardWith([
      transferLog(SPX, USER, ROUTER, AMOUNT_IN),
      transferLog(NATIVE, ROUTER, ATTACKER, 10n ** 18n),
    ]).check(input({ plan, expectedIntent: intent }));

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("RECIPIENT_MISMATCH");
  });

  it("still forbids ETH moving during an ERC-20 sale", async () => {
    // The original rule survives: selling a token never requires sending ETH,
    // so a plan that does is either confused or siphoning.
    const verdict = await guardWith(honestLogs()).check(
      input({
        plan: honestPlan({ calls: [{ to: ROUTER, data: "0xdeadbeef", value: 10n ** 18n }] }),
      }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_ETH_TRANSFER");
  });

  it("blocks a second asset leaving during a native sale", async () => {
    const verdict = await guardWith([
      ...nativeLogs(),
      transferLog(USDC, USER, ATTACKER, 5_000_000_000n),
    ]).check(nativeInput());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("blocks a native swap that returns less than promised", async () => {
    const verdict = await guardWith([
      transferLog(NATIVE, USER, ROUTER, NATIVE_AMOUNT_IN),
      transferLog(SPX, ROUTER, USER, NATIVE_MIN_OUT - 1n),
    ]).check(nativeInput());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("MIN_OUT_NOT_MET");
  });
});

describe("Red team — degraded and ambiguous states", () => {
  it("reverts are rejected, not silently retried", async () => {
    const verdict = await new Guard(ScriptedSimulationProvider.reverting("STF"), OPTIONS).check(
      input(),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("SIMULATION_REVERTED");
  });

  it("refuses to judge effects it cannot decode", async () => {
    // Fail closed: an undecodable transfer might be anything, so it cannot be
    // waved through on the grounds that nothing recognisable went wrong.
    const verdict = await guardWith([...honestLogs(), malformedTransferLog(USDC)]).check(input());

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNDECODABLE_EFFECTS");
  });

  it("degrades to unverified — never to verified — without simulation", async () => {
    const verdict = await new Guard(new NoSimulationProvider(), OPTIONS).check(input());

    expect(verdict.level).toBe("unverified");
    expect(verdict.signable).toBe(true);
    expect(verdict.warnings.map((w) => w.code)).toContain("SIMULATION_UNAVAILABLE");
  });

  it("rejects rather than degrades when requireSimulation is set", async () => {
    const verdict = await new Guard(new NoSimulationProvider(), {
      ...OPTIONS,
      requireSimulation: true,
    }).check(input());

    expect(verdict.level).toBe("rejected");
    expect(verdict.signable).toBe(false);
  });

  it("does not fall through to verified when a simulation fails mid-flight", async () => {
    // A provider that claims availability then throws is the subtle path to a
    // false 'verified'. It must land in the same degraded state as no provider.
    const verdict = await new Guard(new FlakySimulationProvider(), OPTIONS).check(input());

    expect(verdict.level).toBe("unverified");
    expect(verdict.level).not.toBe("verified");
  });

  it("still applies static checks when simulation is unavailable", async () => {
    // Losing the strong layer must not disable the cheap one.
    const verdict = await new Guard(new NoSimulationProvider(), OPTIONS).check(
      input({ plan: honestPlan({ calls: [{ to: ATTACKER, data: "0x", value: 0n }] }) }),
    );

    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNDECLARED_TARGET");
  });
});

describe("The oracle cross-check — a warning, never a refusal", () => {
  /** The price the honest swap executes at, in the oracle's own units. */
  const EXECUTED_X18 = (HONEST_OUT * 10n ** 18n) / AMOUNT_IN;

  const guardWithOracle = (ratio: bigint | null) => {
    const asked: [string, string][] = [];
    const oracle: OracleProvider = {
      priceRatio: async (tokenIn, tokenOut) => {
        asked.push([tokenIn, tokenOut]);
        return ratio;
      },
    };
    const guard = new Guard(ScriptedSimulationProvider.succeedingWith(honestLogs()), { ...OPTIONS, oracle });
    return { guard, asked };
  };

  it("warns on a price far from the market's, and leaves the swap signable", async () => {
    // AGENTS.md rule 2: an oracle that can refuse is an oracle worth attacking
    // into refusing. Nothing tested this until now, so a change promoting the
    // warning to a violation — which the option's own comment used to describe
    // as what happens — would have passed every suite.
    const { guard, asked } = guardWithOracle(EXECUTED_X18 * 2n);
    const verdict = await guard.check(input());

    expect(verdict.level).toBe("verified");
    expect(verdict.signable).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings.map((w) => w.code)).toEqual(["ORACLE_DIVERGENCE"]);
    expect(verdict.warnings[0]?.detail?.divergenceBps).toBe("5000");
    // Asked about the intent's own pair, in the direction being sold.
    expect(asked).toEqual([[SPX, WETH]]);
  });

  it("says nothing when the price is within tolerance, or when it has no opinion", async () => {
    for (const ratio of [EXECUTED_X18, null]) {
      const verdict = await guardWithOracle(ratio).guard.check(input());
      expect(verdict.level).toBe("verified");
      expect(verdict.warnings).toEqual([]);
    }
  });
});
