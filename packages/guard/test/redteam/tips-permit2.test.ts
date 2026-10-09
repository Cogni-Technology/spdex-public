/**
 * Red team: tips batched through Permit2.
 *
 * Batching adds two things to sign besides a transaction — a typed-data
 * signature, and once per token a standing permission for Permit2 — and both
 * move money as surely as a transfer does. So each goes through the Guard, and
 * each case below starts from an honest request and changes one thing, the
 * way the plain tip cases in tips.test.ts do.
 *
 * The threat is the same as there: not a malicious module (none is involved),
 * but a bug in the host, a corrupted config, a hostile link, or a page that
 * was tampered with between the check and the wallet. At the moment of
 * signing those look identical, and the Guard does not need to tell them
 * apart.
 *
 * If any of these goes green-to-red, do not ship.
 */

import { describe, expect, it } from "vitest";
import {
  ATTACKER,
  SPX,
  USDC,
  USER,
  WETH,
  approvalLog,
  permit2ApprovalLog,
  permit2PermitLog,
  transferLog,
  FlakySimulationProvider,
  NoSimulationProvider,
  ScriptedSimulationProvider,
} from "@spdex/testing";
import {
  encodePermit2Approval,
  encodePermit2BatchTransfer,
  encodeTipTransfer,
  permit2BatchTypedData,
  permit2BatchTypedDataJson,
  MAX_PERMIT2_DEADLINE_SECONDS,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  PERMIT2_CODE_HASH,
  type Address,
  type Hex,
  type TipIntent,
  type TipPermissionPlan,
  type TipPlan,
  type TipSignatureRequest,
} from "@spdex/core";
import type { SimLog } from "@spdex/chain";
import { TipGuard, runTipStaticChecks, type TipGuardOptions } from "../../src/tips.js";

/**
 * Made-up addresses standing in for recipients: never the user, never the
 * attacker, and never a public development account, which the Guard refuses
 * on chain 1.
 */
const FIRST = "0x4444444444444444444444444444444444444444" as const;
const SECOND = "0x5555555555555555555555555555555555555555" as const;

/** 10,000 SPX delivered, 50 bps tipped across two = 25 SPX each. */
const DELIVERED = 10_000n * 10n ** 8n;
const EACH = (DELIVERED * 25n) / 10_000n;

/** A fixed clock, so a deadline means the same thing on every run. */
const NOW = 1_790_000_000;
const DEADLINE = BigInt(NOW + 20 * 60);
/** Word 7, bit 3: any well-formed unordered nonce. */
const NONCE = (7n << 8n) | 3n;
/** The Guard never verifies a signature (Permit2 does, in simulation), only its shape. */
const SIGNATURE = `0x${"ab".repeat(64)}1b` as Hex;

const OPTIONS: TipGuardOptions = {
  chainId: 1,
  requireSimulation: false,
  now: () => NOW,
  permit2CodeHash: async () => PERMIT2_CODE_HASH,
  // What the first batched tip leaves: the maximum.
  permit2Allowance: async () => MAX_UINT256,
};

function honestIntent(): TipIntent {
  return {
    version: 1,
    chainId: 1,
    account: USER,
    token: SPX,
    deliveredAmount: DELIVERED,
    transfers: [
      { recipient: FIRST, amount: EACH, label: "Placeholder: dev fund" },
      { recipient: SECOND, amount: EACH, label: "Placeholder: meme fund" },
    ],
    nonce: "0xdeadbeefdeadbeefdeadbeefdeadbeef",
  };
}

const permit = { nonce: NONCE, deadline: DEADLINE, signature: SIGNATURE };

/** The batch transaction, built as the host builds it. */
function honestBatch(): TipPlan {
  const intent = honestIntent();
  return {
    version: 1,
    intent,
    mode: "permit2-batch",
    permit: { ...permit },
    calls: [{ to: PERMIT2_ADDRESS, data: encodePermit2BatchTransfer(intent, permit), value: 0n }],
  };
}

/** The batch's calldata, encoded from an intent that differs from the plan's own in one way. */
function batchCalling(change: (intent: TipIntent) => TipIntent): TipPlan {
  const plan = honestBatch();
  plan.calls[0]!.data = encodePermit2BatchTransfer(change(honestIntent()), permit);
  return plan;
}

const honestBatchLogs = (): SimLog[] => [
  transferLog(SPX, USER, FIRST, EACH),
  transferLog(SPX, USER, SECOND, EACH),
];

/** The signature request, built as the host builds it. */
function honestRequest(): TipSignatureRequest {
  const intent = honestIntent();
  return { version: 1, intent, signer: USER, typedData: permit2BatchTypedDataJson(intent, NONCE, DEADLINE) };
}

/** A request whose typed data was edited after it was built. */
function requestWith(edit: (typed: ReturnType<typeof permit2BatchTypedData>) => void): TipSignatureRequest {
  const request = honestRequest();
  const typed = permit2BatchTypedData(request.intent, NONCE, DEADLINE);
  edit(typed);
  return { ...request, typedData: JSON.stringify(typed) };
}

function honestGrant(): TipPermissionPlan {
  return {
    version: 1,
    kind: "grant",
    chainId: 1,
    account: USER,
    token: SPX,
    tip: honestIntent(),
    call: { to: SPX, data: encodePermit2Approval("grant"), value: 0n },
  };
}

function honestRevoke(): TipPermissionPlan {
  return {
    version: 1,
    kind: "revoke",
    chainId: 1,
    account: USER,
    token: SPX,
    call: { to: SPX, data: encodePermit2Approval("revoke"), value: 0n },
  };
}

/** approve(spender, amount), for calls that are not the permission they claim. */
const approve = (spender: Address, amount: bigint): Hex =>
  `0x095ea7b3${spender.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}` as Hex;

const guardWith = (logs: SimLog[], options: Partial<TipGuardOptions> = {}) =>
  new TipGuard(ScriptedSimulationProvider.succeedingWith(logs), { ...OPTIONS, ...options });

const codes = (verdict: { violations: { code: string }[] }) => verdict.violations.map((v) => v.code);

// ── The batch transaction ─────────────────────────────────────────────────

describe("an honest batch", () => {
  it("is verified", async () => {
    const verdict = await guardWith(honestBatchLogs()).check(honestBatch());
    expect(verdict.level).toBe("verified");
    expect(verdict.signable).toBe(true);
  });

  it("passes the static layer with nothing to say", () => {
    expect(runTipStaticChecks(honestBatch(), BigInt(NOW))).toEqual([]);
  });

  it("tolerates Permit2's own allowance going down as it spends it", async () => {
    // OpenZeppelin's ERC-20 logs an Approval when transferFrom spends an
    // allowance short of the maximum. That is the permission being used, not
    // granted, and refusing it would refuse every such token's batch.
    const verdict = await guardWith([
      ...honestBatchLogs(),
      approvalLog(SPX, USER, PERMIT2_ADDRESS, 10n ** 12n),
    ]).check(honestBatch());
    expect(verdict.level).toBe("verified");
  });
});

describe("a batch whose call is not its intent", () => {
  it("refuses a batch paying another recipient", async () => {
    const plan = batchCalling((intent) => ({
      ...intent,
      transfers: [intent.transfers[0]!, { ...intent.transfers[1]!, recipient: ATTACKER }],
    }));
    const verdict = await guardWith(honestBatchLogs()).check(plan);
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses a batch paying another amount", async () => {
    const plan = batchCalling((intent) => ({
      ...intent,
      transfers: [intent.transfers[0]!, { ...intent.transfers[1]!, amount: EACH * 10n }],
    }));
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses the same pairs in another order", async () => {
    // Every amount goes to someone the user chose, but not the one they chose
    // it for: with uneven shares, that is money moved between people.
    const plan = batchCalling((intent) => ({ ...intent, transfers: [...intent.transfers].reverse() }));
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses an extra entry", async () => {
    const plan = batchCalling((intent) => ({
      ...intent,
      transfers: [...intent.transfers, { recipient: ATTACKER, amount: EACH, label: "" }],
    }));
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a batch moving another token", async () => {
    const plan = batchCalling((intent) => ({ ...intent, token: WETH }));
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a batch drawn from another owner", async () => {
    const plan = batchCalling((intent) => ({ ...intent, account: ATTACKER }));
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a call that is not to Permit2", async () => {
    const plan = honestBatch();
    plan.calls[0]!.to = ATTACKER;
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses ether attached to the batch", async () => {
    const plan = honestBatch();
    plan.calls[0]!.value = 1n;
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a second call riding along", async () => {
    const plan = honestBatch();
    plan.calls.push({ to: SPX, data: encodeTipTransfer(ATTACKER, EACH), value: 0n });
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a batch with no permit to check it against", async () => {
    const { permit: _permit, ...plan } = honestBatch();
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a permit whose deadline is further off than thirty minutes", async () => {
    const long = BigInt(NOW + MAX_PERMIT2_DEADLINE_SECONDS + 60);
    const plan = honestBatch();
    plan.permit = { ...permit, deadline: long };
    plan.calls[0]!.data = encodePermit2BatchTransfer(plan.intent, plan.permit);
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a permit that has already expired", async () => {
    const plan = honestBatch();
    plan.permit = { ...permit, deadline: BigInt(NOW - 1) };
    plan.calls[0]!.data = encodePermit2BatchTransfer(plan.intent, plan.permit);
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("DEADLINE_EXPIRED");
  });

  it("refuses a nonce that is not a uint256", async () => {
    const plan = honestBatch();
    plan.permit = { ...permit, nonce: MAX_UINT256 + 1n };
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a signature that is not a signature's length", async () => {
    const plan = honestBatch();
    plan.permit = { ...permit, signature: "0xabcd" };
    plan.calls[0]!.data = encodePermit2BatchTransfer(plan.intent, plan.permit);
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a batch over the ceiling, like any tip", async () => {
    const huge = DELIVERED / 4n;
    const plan = honestBatch();
    plan.intent.transfers = plan.intent.transfers.map((transfer) => ({ ...transfer, amount: huge }));
    plan.calls[0]!.data = encodePermit2BatchTransfer(plan.intent, permit);
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("TIP_EXCEEDS_LIMIT");
  });

  it("refuses a batch labelled as transfers, and transfers labelled as a batch", async () => {
    const asTransfers: TipPlan = { ...honestBatch(), mode: "transfers" };
    expect(codes(await guardWith(honestBatchLogs()).check(asTransfers))).toContain("TIP_MALFORMED");

    const intent = honestIntent();
    const asBatch: TipPlan = {
      version: 1,
      intent,
      mode: "permit2-batch",
      permit: { ...permit },
      calls: intent.transfers.map((t) => ({ to: SPX, data: encodeTipTransfer(t.recipient, t.amount), value: 0n })),
    };
    expect(codes(await guardWith(honestBatchLogs()).check(asBatch))).toContain("TIP_MALFORMED");
  });

  it("refuses a batch aimed at another chain", async () => {
    const plan = honestBatch();
    plan.intent.chainId = 8453;
    expect(codes(await guardWith(honestBatchLogs()).check(plan))).toContain("CHAIN_MISMATCH");
  });
});

describe("Permit2 has to be Permit2", () => {
  it("refuses a batch when the code at Permit2's address is something else", async () => {
    const verdict = await guardWith(honestBatchLogs(), {
      permit2CodeHash: async () => `0x${"11".repeat(32)}`,
    }).check(honestBatch());
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses a batch when that code could not be read", async () => {
    // Unknown is not "fine": the reader failing is the one case where the
    // check would otherwise have nothing to say.
    const unread = await guardWith(honestBatchLogs(), { permit2CodeHash: async () => null }).check(honestBatch());
    expect(codes(unread)).toContain("TIP_MALFORMED");
    const failing = await guardWith(honestBatchLogs(), {
      permit2CodeHash: () => Promise.reject(new Error("rate limited")),
    }).check(honestBatch());
    expect(codes(failing)).toContain("TIP_MALFORMED");
    const { permit2CodeHash: _reader, ...withoutReader } = OPTIONS;
    const noReader = await new TipGuard(ScriptedSimulationProvider.succeedingWith(honestBatchLogs()), withoutReader).check(
      honestBatch(),
    );
    expect(codes(noReader)).toContain("TIP_MALFORMED");
  });
});

describe("what simulation catches in a batch", () => {
  it("refuses when a recipient receives less than promised", async () => {
    const verdict = await guardWith([transferLog(SPX, USER, FIRST, EACH), transferLog(SPX, USER, SECOND, EACH / 2n)]).check(
      honestBatch(),
    );
    expect(codes(verdict)).toContain("TIP_NOT_DELIVERED");
  });

  it("refuses when more leaves the account than the tips total", async () => {
    const verdict = await guardWith([...honestBatchLogs(), transferLog(SPX, USER, ATTACKER, EACH)]).check(honestBatch());
    expect(codes(verdict)).toContain("TIP_EXCEEDS_LIMIT");
  });

  it("refuses when another token leaves the account", async () => {
    const verdict = await guardWith([...honestBatchLogs(), transferLog(WETH, USER, ATTACKER, 10n ** 18n)]).check(
      honestBatch(),
    );
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("refuses an allowance granted to anyone but Permit2, or on another token", async () => {
    const toAttacker = await guardWith([...honestBatchLogs(), approvalLog(SPX, USER, ATTACKER, MAX_UINT256)]).check(
      honestBatch(),
    );
    expect(codes(toAttacker)).toContain("UNEXPECTED_APPROVAL");
    const otherToken = await guardWith([...honestBatchLogs(), approvalLog(USDC, USER, PERMIT2_ADDRESS, MAX_UINT256)]).check(
      honestBatch(),
    );
    expect(codes(otherToken)).toContain("UNEXPECTED_APPROVAL");
  });

  it("refuses a batch that leaves an allowance inside Permit2", async () => {
    // Permit2 logs its own Approval, not the token's. A batch never needs one.
    const verdict = await guardWith([...honestBatchLogs(), permit2ApprovalLog(USER, SPX, ATTACKER, (1n << 160n) - 1n)]).check(
      honestBatch(),
    );
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("refuses a token that raises Permit2's allowance while the batch spends it", async () => {
    // What is let through is the allowance going down. Up is a grant.
    const before = 10n ** 12n;
    const raised = await guardWith([...honestBatchLogs(), approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256)], {
      permit2Allowance: async () => before,
    }).check(honestBatch());
    expect(codes(raised)).toContain("UNEXPECTED_APPROVAL");

    const spent = await guardWith([...honestBatchLogs(), approvalLog(SPX, USER, PERMIT2_ADDRESS, before - 2n * EACH)], {
      permit2Allowance: async () => before,
    }).check(honestBatch());
    expect(spent.level).toBe("verified");
  });

  it("refuses Permit2's allowance moving when what it was can't be read", async () => {
    // Unknown is not "as high as it gets": the change can't be told from a raise.
    const verdict = await guardWith([...honestBatchLogs(), approvalLog(SPX, USER, PERMIT2_ADDRESS, 10n ** 12n)], {
      permit2Allowance: () => Promise.reject(new Error("429")),
    }).check(honestBatch());
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("refuses a batch that reverts: a used nonce, a bad signature, no allowance", async () => {
    const guard = new TipGuard(ScriptedSimulationProvider.reverting("InvalidNonce()"), OPTIONS);
    expect(codes(await guard.check(honestBatch()))).toContain("SIMULATION_REVERTED");
  });

  it("follows requireSimulation when the endpoint cannot simulate", async () => {
    const lenient = await new TipGuard(new NoSimulationProvider(), OPTIONS).check(honestBatch());
    expect(lenient.level).toBe("unverified");
    const strict = await new TipGuard(new NoSimulationProvider(), { ...OPTIONS, requireSimulation: true }).check(
      honestBatch(),
    );
    expect(strict.signable).toBe(false);
  });
});

// ── The signature, before the wallet is asked ─────────────────────────────

describe("an honest signature request", () => {
  it("is verified", async () => {
    const verdict = await guardWith([]).checkSignature(honestRequest());
    expect(verdict.level).toBe("verified");
  });
});

describe("typed data that is not the tips' permit", () => {
  const refused = async (request: TipSignatureRequest, options: Partial<TipGuardOptions> = {}) => {
    const verdict = await guardWith([], options).checkSignature(request);
    expect(verdict.signable).toBe(false);
    return codes(verdict);
  };

  it("refuses a spender other than the account", async () => {
    // The one change that turns a tip into a theft: a permit whose spender is
    // somebody else lets them move these amounts wherever they like, with no
    // transaction from the user at all.
    expect(await refused(requestWith((typed) => void (typed.message.spender = ATTACKER)))).toContain("TIP_MALFORMED");
  });

  it("refuses another amount", async () => {
    expect(
      await refused(requestWith((typed) => void (typed.message.permitted[1]!.amount = (EACH * 100n).toString()))),
    ).toContain("TIP_MALFORMED");
  });

  it("refuses another token", async () => {
    expect(await refused(requestWith((typed) => void (typed.message.permitted[0]!.token = WETH)))).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses an extra entry", async () => {
    expect(
      await refused(requestWith((typed) => void typed.message.permitted.push({ token: SPX, amount: EACH.toString() }))),
    ).toContain("TIP_MALFORMED");
  });

  it("refuses the entries in another order", async () => {
    // Even amounts would read the same either way, so the intent is made
    // uneven first: the order is what ties each amount to its recipient.
    const intent = honestIntent();
    intent.transfers[1] = { ...intent.transfers[1]!, amount: EACH / 2n };
    const typed = permit2BatchTypedData(intent, NONCE, DEADLINE);
    typed.message.permitted.reverse();
    expect(await refused({ version: 1, intent, signer: USER, typedData: JSON.stringify(typed) })).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses a verifying contract that is not Permit2", async () => {
    expect(await refused(requestWith((typed) => void (typed.domain.verifyingContract = ATTACKER)))).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses a domain for another chain", async () => {
    expect(await refused(requestWith((typed) => void (typed.domain.chainId = 8453)))).toContain("TIP_MALFORMED");
  });

  it("refuses a deadline further off than thirty minutes", async () => {
    const intent = honestIntent();
    const long = BigInt(NOW + MAX_PERMIT2_DEADLINE_SECONDS + 1);
    const request = { version: 1 as const, intent, signer: USER, typedData: permit2BatchTypedDataJson(intent, NONCE, long) };
    expect(await refused(request)).toContain("TIP_MALFORMED");
  });

  it("refuses a nonce that is not a decimal uint256", async () => {
    const hex = honestRequest();
    hex.typedData = hex.typedData.replace(`"nonce":"${NONCE}"`, `"nonce":"0x${NONCE.toString(16)}"`);
    expect(await refused(hex)).toContain("TIP_MALFORMED");
    const huge = honestRequest();
    huge.typedData = huge.typedData.replace(`"nonce":"${NONCE}"`, `"nonce":"${MAX_UINT256 + 1n}"`);
    expect(await refused(huge)).toContain("TIP_MALFORMED");
  });

  it("refuses the same content in another spelling", async () => {
    // The check is on the bytes the wallet is handed. A string that parses to
    // the same object is still not the string that was checked.
    const request = honestRequest();
    request.typedData = JSON.stringify(JSON.parse(request.typedData), null, 2);
    expect(await refused(request)).toContain("TIP_MALFORMED");
  });

  it("refuses typed data that is not JSON", async () => {
    expect(await refused({ ...honestRequest(), typedData: "sign here" })).toContain("TIP_MALFORMED");
  });

  it("refuses a signature asked of someone other than the account", async () => {
    expect(await refused({ ...honestRequest(), signer: ATTACKER })).toContain("TIP_MALFORMED");
  });

  it("refuses a permit for tips over the ceiling", async () => {
    const intent = honestIntent();
    intent.transfers = intent.transfers.map((transfer) => ({ ...transfer, amount: DELIVERED / 4n }));
    const request = { version: 1 as const, intent, signer: USER, typedData: permit2BatchTypedDataJson(intent, NONCE, DEADLINE) };
    expect(await refused(request)).toContain("TIP_EXCEEDS_LIMIT");
  });

  it("refuses when Permit2 is not the contract spDEX knows", async () => {
    expect(await refused(honestRequest(), { permit2CodeHash: async () => `0x${"22".repeat(32)}` })).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses a request for another chain", async () => {
    const intent = { ...honestIntent(), chainId: 8453 };
    const request = { version: 1 as const, intent, signer: USER, typedData: permit2BatchTypedDataJson(intent, NONCE, DEADLINE) };
    expect(await refused(request)).toContain("CHAIN_MISMATCH");
  });
});

// ── The standing permission ───────────────────────────────────────────────

describe("an honest permission", () => {
  it("verifies a grant of exactly approve(Permit2, max) on the tip token", async () => {
    const verdict = await guardWith([approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256)]).checkPermission(honestGrant());
    expect(verdict.level).toBe("verified");
  });

  it("verifies a revoke, even when Permit2's code could not be read", async () => {
    // Taking a permission away is always allowed: nothing can be lost by it.
    const verdict = await guardWith([approvalLog(SPX, USER, PERMIT2_ADDRESS, 0n)], {
      permit2CodeHash: async () => null,
    }).checkPermission(honestRevoke());
    expect(verdict.level).toBe("verified");
  });
});

describe("a permission that is not the standing permission", () => {
  const grantLogs = () => [approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256)];

  it("refuses an approval to a spender other than Permit2", async () => {
    const plan = honestGrant();
    plan.call.data = approve(ATTACKER, MAX_UINT256);
    expect(codes(await guardWith([approvalLog(SPX, USER, ATTACKER, MAX_UINT256)]).checkPermission(plan))).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses an approval on another token", async () => {
    const plan = honestGrant();
    plan.call.to = USDC;
    expect(codes(await guardWith([approvalLog(USDC, USER, PERMIT2_ADDRESS, MAX_UINT256)]).checkPermission(plan))).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses a grant on a token the tip does not send", async () => {
    const plan = { ...honestGrant(), token: USDC, call: { to: USDC, data: encodePermit2Approval("grant"), value: 0n } };
    expect(codes(await guardWith([approvalLog(USDC, USER, PERMIT2_ADDRESS, MAX_UINT256)]).checkPermission(plan))).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses a grant that names no tip", async () => {
    const { tip: _tip, ...plan } = honestGrant();
    expect(codes(await guardWith(grantLogs()).checkPermission(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a grant for a tip to one person, which is never batched", async () => {
    const plan = honestGrant();
    plan.tip = { ...plan.tip!, transfers: [plan.tip!.transfers[0]!] };
    expect(codes(await guardWith(grantLogs()).checkPermission(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses a grant for someone else's tip", async () => {
    const plan = honestGrant();
    plan.tip = { ...plan.tip!, account: ATTACKER };
    expect(codes(await guardWith(grantLogs()).checkPermission(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses an amount that is neither the maximum nor zero", async () => {
    const plan = honestGrant();
    plan.call.data = approve(PERMIT2_ADDRESS, 12_345n);
    expect(codes(await guardWith([approvalLog(SPX, USER, PERMIT2_ADDRESS, 12_345n)]).checkPermission(plan))).toContain(
      "TIP_MALFORMED",
    );
  });

  it("refuses a revoke that grants", async () => {
    const plan = honestRevoke();
    plan.call.data = encodePermit2Approval("grant");
    expect(codes(await guardWith(grantLogs()).checkPermission(plan))).toContain("TIP_MALFORMED");
  });

  it("refuses ether attached, and ether itself", async () => {
    const withValue = honestGrant();
    withValue.call.value = 1n;
    expect(codes(await guardWith(grantLogs()).checkPermission(withValue))).toContain("TIP_MALFORMED");

    const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
    const onEther: TipPermissionPlan = { ...honestRevoke(), token: native, call: { ...honestRevoke().call, to: native } };
    expect(codes(await guardWith([]).checkPermission(onEther))).toContain("TIP_MALFORMED");
  });

  it("refuses a grant when Permit2 is not the contract spDEX knows", async () => {
    const verdict = await guardWith(grantLogs(), { permit2CodeHash: async () => `0x${"33".repeat(32)}` }).checkPermission(
      honestGrant(),
    );
    expect(codes(verdict)).toContain("TIP_MALFORMED");
  });

  it("refuses a permission for another chain", async () => {
    const plan = { ...honestGrant(), chainId: 8453 };
    expect(codes(await guardWith(grantLogs()).checkPermission(plan))).toContain("CHAIN_MISMATCH");
  });
});

describe("what simulation catches in a permission", () => {
  it("refuses a permission that moves tokens", async () => {
    const verdict = await guardWith([
      approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256),
      transferLog(SPX, USER, ATTACKER, EACH),
    ]).checkPermission(honestGrant());
    expect(codes(verdict)).toContain("UNEXPECTED_TOKEN_TRANSFER");
  });

  it("refuses a permission that approves anyone else too", async () => {
    const verdict = await guardWith([
      approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256),
      approvalLog(WETH, USER, ATTACKER, MAX_UINT256),
    ]).checkPermission(honestGrant());
    expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
  });

  it("refuses a permission that also leaves an allowance inside Permit2", async () => {
    for (const inside of [
      permit2ApprovalLog(USER, SPX, ATTACKER, (1n << 160n) - 1n),
      permit2PermitLog(USER, SPX, ATTACKER, (1n << 160n) - 1n),
    ]) {
      const verdict = await guardWith([approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256), inside]).checkPermission(
        honestGrant(),
      );
      expect(codes(verdict)).toContain("UNEXPECTED_APPROVAL");
    }
  });

  it("refuses a permission whose approval never shows", async () => {
    expect(codes(await guardWith([]).checkPermission(honestGrant()))).toContain("TIP_MALFORMED");
  });

  it("refuses a permission that reverts", async () => {
    const guard = new TipGuard(ScriptedSimulationProvider.reverting("paused"), OPTIONS);
    expect(codes(await guard.checkPermission(honestGrant()))).toContain("SIMULATION_REVERTED");
  });

  it("refuses outright when the config demands simulation and there is none", async () => {
    const guard = new TipGuard(new NoSimulationProvider(), { ...OPTIONS, requireSimulation: true });
    expect((await guard.checkPermission(honestGrant())).signable).toBe(false);
  });

  it("never lets a grant go untested, whatever requireSimulation says", async () => {
    // An unlimited, standing permission is not signed on the static checks
    // alone, as a scheduled buy is not.
    for (const provider of [new NoSimulationProvider(), new FlakySimulationProvider()]) {
      const verdict = await new TipGuard(provider, { ...OPTIONS, requireSimulation: false }).checkPermission(honestGrant());
      expect(verdict.signable).toBe(false);
      expect(codes(verdict)).toContain("SIMULATION_UNAVAILABLE");
    }
  });

  it("lets a revoke go untested when requireSimulation allows it: it can only take authority away", async () => {
    const verdict = await new TipGuard(new NoSimulationProvider(), { ...OPTIONS, requireSimulation: false }).checkPermission(
      honestRevoke(),
    );
    expect(verdict.level).toBe("unverified");
    expect(verdict.signable).toBe(true);
  });
});

// ── Where a batched tip may not go ────────────────────────────────────────

describe("a batch, its signature and its permission refuse the same recipients a transfer does", () => {
  const DEV_ACCOUNT_2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;
  /** The honest intent with its second recipient replaced. */
  const intentPaying = (recipient: Address): TipIntent => {
    const intent = honestIntent();
    intent.transfers = [intent.transfers[0]!, { recipient, amount: EACH, label: "from a settings link" }];
    return intent;
  };
  const reasonsOf = (verdict: { violations: { code: string; detail?: Record<string, string> }[] }) =>
    verdict.violations.filter((v) => v.code === "TIP_MALFORMED").map((v) => v.detail?.["reason"]);

  it("refuses a batch paying a public development account on Ethereum", async () => {
    const intent = intentPaying(DEV_ACCOUNT_2);
    const plan: TipPlan = {
      version: 1,
      intent,
      mode: "permit2-batch",
      permit: { ...permit },
      calls: [{ to: PERMIT2_ADDRESS, data: encodePermit2BatchTransfer(intent, permit), value: 0n }],
    };
    const verdict = await guardWith([transferLog(SPX, USER, FIRST, EACH), transferLog(SPX, USER, DEV_ACCOUNT_2, EACH)]).check(plan);
    expect(verdict.signable).toBe(false);
    expect(reasonsOf(verdict)).toContain("public-dev-account");
  });

  it("refuses to ask for the signature when a recipient is Permit2 itself", async () => {
    const intent = intentPaying(PERMIT2_ADDRESS);
    const request: TipSignatureRequest = {
      version: 1,
      intent,
      signer: USER,
      typedData: permit2BatchTypedDataJson(intent, NONCE, DEADLINE),
    };
    const verdict = await guardWith([]).checkSignature(request);
    expect(verdict.signable).toBe(false);
    expect(reasonsOf(verdict)).toContain("permit2");
  });

  it("refuses the standing permission for a tip to the token's own contract", async () => {
    const plan = { ...honestGrant(), tip: intentPaying(SPX) };
    const verdict = await guardWith([approvalLog(SPX, USER, PERMIT2_ADDRESS, MAX_UINT256)]).checkPermission(plan);
    expect(verdict.signable).toBe(false);
    expect(reasonsOf(verdict)).toContain("token-contract");
  });

  it("refuses a recipient the host names, in the signature request too", async () => {
    const intent = intentPaying(ATTACKER);
    const request: TipSignatureRequest = {
      version: 1,
      intent,
      signer: USER,
      typedData: permit2BatchTypedDataJson(intent, NONCE, DEADLINE),
    };
    expect((await guardWith([]).checkSignature(request)).signable).toBe(true);
    const verdict = await guardWith([], { refuseRecipients: [ATTACKER] }).checkSignature(request);
    expect(reasonsOf(verdict)).toContain("known-contract");
  });
});
