/**
 * Red team: tip splits.
 *
 * A tip is a transaction that takes the user's money and gives it to somebody
 * else. That is the exact shape of every attack the Guard exists to refuse, so
 * the fact that the host composes these calls itself buys them nothing — each
 * case below starts from an honest plan and changes one thing.
 *
 * The threat here is not a malicious module; no module is involved. It is a bug
 * in the host, a corrupted config, or a UI that computed the wrong number. By
 * the time a transaction reaches the signer those are indistinguishable from
 * malice, and the Guard is the layer that does not need to tell them apart.
 *
 * If any of these goes green-to-red, do not ship.
 */

import { describe, expect, it } from "vitest";
import {
  ATTACKER,
  ROUTER,
  SPX,
  USER,
  transferLog,
  malformedTransferLog,
  approvalLog,
  NoSimulationProvider,
  ScriptedSimulationProvider,
} from "@spdex/testing";
import { encodeTipTransfer, MAX_TOTAL_TIP_BPS, PERMIT2_ADDRESS, type TipPlan } from "@spdex/core";
import type { SimLog } from "@spdex/chain";
import { TipGuard, runTipStaticChecks } from "../../src/tips.js";

const OPTIONS = { chainId: 1, requireSimulation: false };

/**
 * A made-up address standing in for a recipient: never the user, never the
 * attacker, and never a public development account, which the Guard refuses
 * on chain 1 (see "where a tip may not go" below).
 */
const RECIPIENT = "0x4444444444444444444444444444444444444444" as const;
const SECOND = "0x5555555555555555555555555555555555555555" as const;

/** 10,000 SPX delivered, 25 bps tipped = 25 SPX. */
const DELIVERED = 10_000n * 10n ** 8n;
const TIP = (DELIVERED * 25n) / 10_000n;

function honestTipPlan(): TipPlan {
  return {
    version: 1,
    intent: {
      version: 1,
      chainId: 1,
      account: USER,
      token: SPX,
      deliveredAmount: DELIVERED,
      transfers: [{ recipient: RECIPIENT, amount: TIP, label: "Placeholder: dev fund" }],
      nonce: "0xdeadbeefdeadbeefdeadbeefdeadbeef",
    },
    calls: [{ to: SPX, data: encodeTipTransfer(RECIPIENT, TIP), value: 0n }],
  };
}

const honestLogs = (): SimLog[] => [transferLog(SPX, USER, RECIPIENT, TIP)];

const guardWith = (logs: SimLog[]) =>
  new TipGuard(ScriptedSimulationProvider.succeedingWith(logs), OPTIONS);

const codes = (verdict: { violations: { code: string }[] }) => verdict.violations.map((v) => v.code);

describe("an honest tip", () => {
  it("is verified", async () => {
    const verdict = await guardWith(honestLogs()).check(honestTipPlan());
    expect(verdict.level).toBe("verified");
    expect(verdict.signable).toBe(true);
  });

  it("passes the static layer with nothing to say", () => {
    expect(runTipStaticChecks(honestTipPlan())).toEqual([]);
  });
});

describe("calldata that does not match its intent", () => {
  it("refuses a transfer redirected to another address", async () => {
    // The attack the whole design is aimed at: the intent names a recipient the
    // user chose, the calldata names somebody else. Caught statically, before
    // an RPC round-trip is spent on it.
    const plan = honestTipPlan();
    plan.calls[0]!.data = encodeTipTransfer(ATTACKER, TIP);
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses a transfer inflated beyond its intent", async () => {
    const plan = honestTipPlan();
    plan.calls[0]!.data = encodeTipTransfer(RECIPIENT, DELIVERED);
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses a call against a different token", async () => {
    // Pointing the transfer at a token the user was not tipping would move a
    // balance they never agreed to touch.
    const plan = honestTipPlan();
    plan.calls[0]!.to = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses ether attached to a token transfer", async () => {
    const plan = honestTipPlan();
    plan.calls[0]!.value = 10n ** 18n;
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses more calls than the intent declares", async () => {
    const plan = honestTipPlan();
    plan.calls.push({ to: SPX, data: encodeTipTransfer(ATTACKER, TIP), value: 0n });
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses arbitrary calldata wearing a transfer's clothes", async () => {
    // Right target, right length, wrong function.
    const plan = honestTipPlan();
    plan.calls[0]!.data = `0x095ea7b3${"0".repeat(128)}`;
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });
});

describe("the ceiling", () => {
  it("refuses tips beyond the hard limit, whatever the config said", async () => {
    // The ceiling is a constant, not a setting. A config that asked for half
    // the swap — through a bug, a bad import, or a hostile shared link — gets
    // refused here rather than honoured.
    const plan = honestTipPlan();
    const huge = DELIVERED / 2n;
    plan.intent.transfers = [{ recipient: RECIPIENT, amount: huge, label: "greedy" }];
    plan.calls = [{ to: SPX, data: encodeTipTransfer(RECIPIENT, huge), value: 0n }];
    const verdict = await guardWith([transferLog(SPX, USER, RECIPIENT, huge)]).check(plan);
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("TIP_EXCEEDS_LIMIT");
  });

  it("allows exactly the ceiling", async () => {
    // The boundary itself is legal; an off-by-one here would make the maximum
    // configurable share impossible to actually use.
    const plan = honestTipPlan();
    const max = (DELIVERED * BigInt(MAX_TOTAL_TIP_BPS)) / 10_000n;
    plan.intent.transfers = [{ recipient: RECIPIENT, amount: max, label: "at the line" }];
    plan.calls = [{ to: SPX, data: encodeTipTransfer(RECIPIENT, max), value: 0n }];
    const verdict = await guardWith([transferLog(SPX, USER, RECIPIENT, max)]).check(plan);
    expect(verdict.level).toBe("verified");
  });

  it("refuses tipping a share of nothing", async () => {
    const plan = honestTipPlan();
    plan.intent.deliveredAmount = 0n;
    const verdict = await guardWith(honestLogs()).check(plan);
    expect(codes(verdict)).toContain("TIP_EXCEEDS_LIMIT");
  });

  it("counts recipients together, not one at a time", async () => {
    // Each under the ceiling, the sum over it. Checking per-transfer would let
    // any limit be evaded by splitting it.
    const each = (DELIVERED * 300n) / 10_000n;
    const plan = honestTipPlan();
    plan.intent.transfers = [
      { recipient: RECIPIENT, amount: each, label: "a" },
      { recipient: SECOND, amount: each, label: "b" },
    ];
    plan.calls = [
      { to: SPX, data: encodeTipTransfer(RECIPIENT, each), value: 0n },
      { to: SPX, data: encodeTipTransfer(SECOND, each), value: 0n },
    ];
    const verdict = await guardWith([
      transferLog(SPX, USER, RECIPIENT, each),
      transferLog(SPX, USER, SECOND, each),
    ]).check(plan);
    expect(codes(verdict)).toContain("TIP_EXCEEDS_LIMIT");
  });
});

describe("malformed intents", () => {
  it("refuses a zero transfer", async () => {
    const plan = honestTipPlan();
    plan.intent.transfers = [{ recipient: RECIPIENT, amount: 0n, label: "nothing" }];
    plan.calls = [{ to: SPX, data: encodeTipTransfer(RECIPIENT, 0n), value: 0n }];
    expect(codes(await guardWith([]).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses paying the sender", async () => {
    const plan = honestTipPlan();
    plan.intent.transfers = [{ recipient: USER, amount: TIP, label: "me" }];
    plan.calls = [{ to: SPX, data: encodeTipTransfer(USER, TIP), value: 0n }];
    expect(codes(await guardWith([]).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses burning the tip", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const plan = honestTipPlan();
    plan.intent.transfers = [{ recipient: zero, amount: TIP, label: "void" }];
    plan.calls = [{ to: SPX, data: encodeTipTransfer(zero, TIP), value: 0n }];
    expect(codes(await guardWith([]).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses the same recipient twice", async () => {
    const plan = honestTipPlan();
    plan.intent.transfers = [
      { recipient: RECIPIENT, amount: TIP, label: "a" },
      { recipient: RECIPIENT, amount: TIP, label: "a again" },
    ];
    plan.calls = [
      { to: SPX, data: encodeTipTransfer(RECIPIENT, TIP), value: 0n },
      { to: SPX, data: encodeTipTransfer(RECIPIENT, TIP), value: 0n },
    ];
    expect(codes(await guardWith([]).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a plan aimed at another chain", async () => {
    const plan = honestTipPlan();
    plan.intent.chainId = 8453;
    expect(codes(await guardWith(honestLogs()).check(plan))).toContain("CHAIN_MISMATCH");
  });
});

describe("what simulation catches that static checks cannot", () => {
  it("refuses when the recipient receives less than promised", async () => {
    // Correct calldata, a token that does not honour it — a fee-on-transfer
    // token is the honest version of this and an outright malicious one the
    // rest. Either way the recipient does not get what the user was told.
    const verdict = await guardWith([transferLog(SPX, USER, RECIPIENT, TIP / 2n)]).check(
      honestTipPlan(),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("TIP_NOT_DELIVERED");
  });

  it("refuses when the recipient receives nothing at all", async () => {
    expect(codes(await guardWith([]).check(honestTipPlan()))).toContain("TIP_NOT_DELIVERED");
  });

  it("refuses when more leaves the account than the tips total", async () => {
    const verdict = await guardWith([
      transferLog(SPX, USER, RECIPIENT, TIP),
      transferLog(SPX, USER, ATTACKER, TIP * 4n),
    ]).check(honestTipPlan());
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("TIP_EXCEEDS_LIMIT");
  });

  it("refuses when a different token leaves the account", async () => {
    const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const verdict = await guardWith([
      transferLog(SPX, USER, RECIPIENT, TIP),
      transferLog(WETH, USER, ATTACKER, 10n ** 18n),
    ]).check(honestTipPlan());
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("refuses when an allowance is granted", async () => {
    // A transfer never needs one. Its presence means the call was not the
    // transfer it claimed to be, whatever its calldata looked like.
    const verdict = await guardWith([
      transferLog(SPX, USER, RECIPIENT, TIP),
      approvalLog(SPX, USER, ATTACKER, 2n ** 256n - 1n),
    ]).check(honestTipPlan());
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("refuses effects it cannot decode", async () => {
    const verdict = await guardWith([
      transferLog(SPX, USER, RECIPIENT, TIP),
      malformedTransferLog(SPX),
    ]).check(honestTipPlan());
    expect(codes(verdict)).toContain("UNDECODABLE_EFFECTS");
  });

  it("refuses a reverting transfer", async () => {
    const guard = new TipGuard(ScriptedSimulationProvider.reverting("insufficient balance"), OPTIONS);
    expect(codes(await guard.check(honestTipPlan()))).toContain("SIMULATION_REVERTED");
  });
});

describe("when simulation is unavailable", () => {
  it("reports unverified rather than verified", async () => {
    const guard = new TipGuard(new NoSimulationProvider(), OPTIONS);
    const verdict = await guard.check(honestTipPlan());
    expect(verdict.level).toBe("unverified");
    expect(verdict.warnings.map((w) => w.code)).toContain("SIMULATION_UNAVAILABLE");
  });

  it("refuses outright when the config demands simulation", async () => {
    const guard = new TipGuard(new NoSimulationProvider(), { ...OPTIONS, requireSimulation: true });
    const verdict = await guard.check(honestTipPlan());
    expect(verdict.level).toBe("rejected");
    expect(verdict.signable).toBe(false);
  });
});

describe("where a tip may not go, whoever chose it", () => {
  /*
   * Decision 5 of the tip registry: refusal only, so nothing that passed
   * before passes more easily now. Each recipient below is one a token sent
   * to is lost at, or taken from, and each could arrive in a settings link,
   * an imported tip list or a typo, not only from a list spDEX ships. The
   * refusal is TIP_MALFORMED with a `detail.reason`, like paying the sender.
   */
  const OPTIONS_WITH_ROUTER = { ...OPTIONS, refuseRecipients: [ROUTER] };
  const DEV_ACCOUNT_1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;

  /** The honest plan with its one transfer paying `recipient` instead. */
  function paying(recipient: `0x${string}`, chainId = 1): TipPlan {
    const plan = honestTipPlan();
    plan.intent.chainId = chainId;
    plan.intent.transfers = [{ recipient, amount: TIP, label: "Unlisted · named by loaded settings" }];
    plan.calls = [{ to: SPX, data: encodeTipTransfer(recipient, TIP), value: 0n }];
    return plan;
  }
  const reasons = (verdict: { violations: { code: string; detail?: Record<string, string> }[] }) =>
    verdict.violations.filter((v) => v.code === "TIP_MALFORMED").map((v) => v.detail?.["reason"]);

  it("refuses a tip to the SPX contract itself, as a share link would set it", async () => {
    // A settings link naming the token's own contract as a recipient, labelled
    // as if the shipped list vouched for it. The token would be stuck there.
    const verdict = await guardWith([transferLog(SPX, USER, SPX, TIP)]).check(paying(SPX));
    expect(verdict.signable).toBe(false);
    expect(reasons(verdict)).toContain("token-contract");
    expect(runTipStaticChecks(paying(SPX)).map((v) => v.detail?.["reason"])).toContain("token-contract");
  });

  it("refuses a tip to Permit2", async () => {
    const verdict = await guardWith([transferLog(SPX, USER, PERMIT2_ADDRESS, TIP)]).check(paying(PERMIT2_ADDRESS));
    expect(verdict.signable).toBe(false);
    expect(reasons(verdict)).toContain("permit2");
  });

  it("refuses a tip to the burn address", async () => {
    const dead = "0x000000000000000000000000000000000000dEaD" as const;
    const verdict = await guardWith([transferLog(SPX, USER, dead, TIP)]).check(paying(dead));
    expect(reasons(verdict)).toContain("burn");
  });

  it("refuses a tip to a router the host names, and only because the host named it", async () => {
    const plan = paying(ROUTER);
    const logs = [transferLog(SPX, USER, ROUTER, TIP)];
    const refused = await new TipGuard(ScriptedSimulationProvider.succeedingWith(logs), OPTIONS_WITH_ROUTER).check(plan);
    expect(refused.signable).toBe(false);
    expect(reasons(refused)).toContain("known-contract");
    // The list is the host's, handed in; the Guard has no router list of its own.
    expect(runTipStaticChecks(plan)).toEqual([]);
    // Checked case-insensitively, as every address comparison in the Guard is.
    const upper = new TipGuard(ScriptedSimulationProvider.succeedingWith(logs), {
      ...OPTIONS,
      refuseRecipients: [ROUTER.toUpperCase().replace("0X", "0x") as `0x${string}`],
    });
    expect(reasons(await upper.check(plan))).toContain("known-contract");
  });

  it("refuses anvil account #1 on Ethereum, whose key anyone has", async () => {
    const verdict = await guardWith([transferLog(SPX, USER, DEV_ACCOUNT_1, TIP)]).check(paying(DEV_ACCOUNT_1));
    expect(verdict.signable).toBe(false);
    expect(reasons(verdict)).toContain("public-dev-account");
  });

  it("lets the same account be tipped on a local fork, where the flow is tested", async () => {
    const fork = new TipGuard(ScriptedSimulationProvider.succeedingWith([transferLog(SPX, USER, DEV_ACCOUNT_1, TIP)]), {
      ...OPTIONS,
      chainId: 690069,
    });
    const verdict = await fork.check(paying(DEV_ACCOUNT_1, 690069));
    expect(verdict.level).toBe("verified");
  });

  it("refuses the whole plan when one of two recipients is refused, rather than paying the other alone", async () => {
    const plan = honestTipPlan();
    plan.intent.transfers = [
      { recipient: RECIPIENT, amount: TIP, label: "a" },
      { recipient: SPX, amount: TIP, label: "b" },
    ];
    plan.calls = [
      { to: SPX, data: encodeTipTransfer(RECIPIENT, TIP), value: 0n },
      { to: SPX, data: encodeTipTransfer(SPX, TIP), value: 0n },
    ];
    const verdict = await guardWith([transferLog(SPX, USER, RECIPIENT, TIP), transferLog(SPX, USER, SPX, TIP)]).check(plan);
    expect(verdict.signable).toBe(false);
    expect(reasons(verdict)).toEqual(["token-contract"]);
  });
});
