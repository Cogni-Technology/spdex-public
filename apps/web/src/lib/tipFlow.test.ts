/**
 * The order of a tip's steps, and what each refusal turns into.
 *
 * Driven with fakes for every read, check, signature and send, so each path
 * can be taken on purpose: the batch with and without the standing
 * permission, a declined permission, a wallet that cannot sign typed data, a
 * declined signature, a Guard that refuses, and one recipient, which never
 * batches. e2e (features.spec) takes the main path against a real fork.
 *
 * The order is the point: the signature first, then the permission when it
 * is needed, then the batch. So a wallet that can't sign typed data is never
 * asked for a permission it could not use.
 */

import { describe, expect, it } from "vitest";
import {
  encodePermit2Approval,
  permit2NoncePosition,
  PERMIT2_ADDRESS,
  verified,
  rejected,
  unverified,
  type GuardVerdict,
  type TipTransfer,
} from "@spdex/core";
import { StepCounter, type Step } from "./steps.js";
import { sendTips, type TipCall, type TipChecks, type TipFlowDeps } from "./tipFlow.js";
import { choosePermit2Nonce } from "./tips.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const SPX = { address: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c" as const, symbol: "SPX", decimals: 8 };
const TWO: TipTransfer[] = [
  { recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", amount: 25_00000000n, label: "a" },
  { recipient: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", amount: 25_00000000n, label: "b" },
];
const SIGNATURE = `0x${"ab".repeat(65)}`;
const NOW_MS = 1_790_000_000_000;

const rejection = () => Object.assign(new Error("user rejected the request"), { code: 4001 });

interface Recorded {
  steps: Step["kind"][];
  /** The steps as shown, numbering and all. */
  shown: Step[];
  sent: TipCall[];
  typed: string[];
  checked: string[];
  /**
   * What the wallet was asked, in order, whether it said yes or not: "sign"
   * for typed data, and for a transaction "permission", "batch" or
   * "transfer" by what it calls. Recorded by the fakes the harness wraps, so
   * an override of `signTypedData` or `send` is still counted.
   */
  asked: string[];
}

/** What a tip transaction is, by the call it makes. */
function kindOf(call: TipCall): string {
  if (call.to === PERMIT2_ADDRESS) return "batch";
  if (call.data.startsWith("0x095ea7b3")) return "permission";
  if (call.data.startsWith("0xa9059cbb")) return "transfer";
  return "other";
}

function harness(overrides: Omit<Partial<TipFlowDeps>, "checks"> & { checks?: Partial<TipChecks> } = {}) {
  const recorded: Recorded = { steps: [], shown: [], sent: [], typed: [], checked: [], asked: [] };
  const ok = async (): Promise<GuardVerdict> => verified();
  const checks: TipChecks = {
    checkTips: async (plan) => {
      recorded.checked.push(`tips:${plan.mode ?? "transfers"}`);
      return overrides.checks?.checkTips ? overrides.checks.checkTips(plan) : ok();
    },
    checkTipSignature: async (request) => {
      recorded.checked.push("signature");
      return overrides.checks?.checkTipSignature ? overrides.checks.checkTipSignature(request) : ok();
    },
    checkTipPermission: async (plan) => {
      recorded.checked.push(`permission:${plan.kind}`);
      return overrides.checks?.checkTipPermission ? overrides.checks.checkTipPermission(plan) : ok();
    },
    permit2Available: overrides.checks?.permit2Available ?? (async () => true),
  };
  const { checks: _checks, signTypedData, send, ...rest } = overrides;
  const deps: TipFlowDeps = {
    checks,
    chainId: 1,
    account: ACCOUNT,
    token: SPX,
    delivered: 10_000_00000000n,
    transfers: TWO,
    readAllowance: async () => (1n << 256n) - 1n,
    readNonceBitmap: async () => 0n,
    signTypedData: async (typedData) => {
      recorded.asked.push("sign");
      if (signTypedData) return signTypedData(typedData);
      recorded.typed.push(typedData);
      return SIGNATURE;
    },
    send: async (call) => {
      recorded.asked.push(kindOf(call));
      if (send) return send(call);
      recorded.sent.push(call);
    },
    onStep: (step) => {
      recorded.steps.push(step.kind);
      recorded.shown.push(step);
    },
    now: () => NOW_MS,
    random: (length) => new Uint8Array(length).fill(1),
    ...rest,
  };
  return { deps, recorded };
}

/** A wallet that doesn't have `eth_signTypedData_v4` at all. */
const unsupported = () => Promise.reject(Object.assign(new Error("method not supported"), { code: 4200 }));

/** The note's line for a signature a declined or failed permission left unused. */
const SIGNATURE_UNUSED =
  " The signature you gave goes unused and expires within 20 minutes; only a transaction you send could spend it.";

describe("two or more recipients", () => {
  it("asks for one signature and sends one transaction, to Permit2", async () => {
    const { deps, recorded } = harness();
    const outcome = await sendTips(deps);
    expect(outcome.mode).toBe("permit2-batch");
    expect(outcome.note).toBe(" Tipped 50 SPX to 2 people in one transaction.");
    expect(recorded.typed).toHaveLength(1);
    expect(recorded.sent).toHaveLength(1);
    expect(recorded.sent[0]!.to).toBe(PERMIT2_ADDRESS);
    // The signature is checked before it is asked for, the transaction before it is sent.
    expect(recorded.checked).toEqual(["signature", "tips:permit2-batch"]);
    expect(recorded.steps).toEqual(["tip-sign", "tip-batch"]);
    expect(recorded.asked).toEqual(["sign", "batch"]);
  });

  it("asks for the signature first, then the standing permission, then the batch", async () => {
    const { deps, recorded } = harness({ readAllowance: async () => 0n });
    const outcome = await sendTips(deps);
    expect(outcome.mode).toBe("permit2-batch");
    expect(recorded.asked).toEqual(["sign", "permission", "batch"]);
    expect(recorded.steps).toEqual(["tip-sign", "tip-permission", "tip-batch"]);
    expect(recorded.sent).toHaveLength(2);
    expect(recorded.sent[0]).toEqual({ to: SPX.address, data: encodePermit2Approval("grant"), value: 0n });
    // Each checked before the wallet is asked for it. The permission is
    // checked before the signature too: a grant the Guard refuses means no
    // batch, and a signature asked for first would be one nothing used.
    expect(recorded.checked).toEqual(["permission:grant", "signature", "tips:permit2-batch"]);
    // The signing step says what comes between it and the transaction.
    const sign = recorded.shown.find((step) => step.kind === "tip-sign");
    expect(sign && sign.kind === "tip-sign" ? sign.permissionNext : null).toBe(true);
    // Given and then used: nothing about it left behind to mention.
    expect(outcome.note).toBe(" Tipped 50 SPX to 2 people in one transaction.");
  });

  it("asks for the permission when the allowance can't be read, rather than assume it", async () => {
    const { deps, recorded } = harness({ readAllowance: () => Promise.reject(new Error("429")) });
    await sendTips(deps);
    expect(recorded.asked).toEqual(["sign", "permission", "batch"]);
  });

  it("sends separate transfers when the permission is declined, and says the signature goes unused", async () => {
    const { deps, recorded } = harness({
      readAllowance: async () => 0n,
      send: async (call) => {
        if (kindOf(call) === "permission") throw rejection();
        recorded.sent.push(call);
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.mode).toBe("transfers");
    expect(outcome.note).toBe(
      ` Tipped 50 SPX to 2 people, in 2 separate transfers: you declined the permission for Permit2.${SIGNATURE_UNUSED}`,
    );
    // Signed, then the permission declined, then a transfer each.
    expect(recorded.asked).toEqual(["sign", "permission", "transfer", "transfer"]);
    expect(recorded.typed).toHaveLength(1);
    expect(recorded.sent.map((call) => call.to)).toEqual([SPX.address, SPX.address]);
    expect(recorded.checked).toEqual(["permission:grant", "signature", "tips:transfers"]);
    expect(outcome.batchUnusable).toBeUndefined();
  });

  it("says the signature goes unused when the permission fails, and sends nothing", async () => {
    const { deps, recorded } = harness({
      readAllowance: async () => 0n,
      send: async (call) => {
        if (kindOf(call) === "permission") throw new Error("transaction 0xab… reverted on chain");
        recorded.sent.push(call);
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome).toEqual({
      note: ` Tips not sent: the permission for Permit2 failed (transaction 0xab… reverted on chain).${SIGNATURE_UNUSED}`,
      mode: "none",
    });
    expect(recorded.asked).toEqual(["sign", "permission"]);
  });

  it("sends separate transfers when the Guard refuses the permission, asking for nothing else first", async () => {
    const { deps, recorded } = harness({
      readAllowance: async () => 0n,
      checks: { checkTipPermission: async () => rejected([{ code: "TIP_MALFORMED", message: "no" }]) },
    });
    const outcome = await sendTips(deps);
    expect(outcome.note).toContain("spDEX refused the permission for Permit2 (TIP_MALFORMED)");
    // Neither the refused permission nor a signature it would have left
    // unused was asked of the wallet.
    expect(recorded.asked).toEqual(["transfer", "transfer"]);
    expect(recorded.typed).toHaveLength(0);
    expect(recorded.sent).toHaveLength(2);
  });

  it("sends separate transfers when the wallet can't sign typed data, never asking for the permission", async () => {
    const { deps, recorded } = harness({ readAllowance: async () => 0n, signTypedData: unsupported });
    const outcome = await sendTips(deps);
    expect(outcome.mode).toBe("transfers");
    // No permission was given, so none is said to stay.
    expect(outcome.note).toBe(" Tipped 50 SPX to 2 people, in 2 separate transfers: your wallet can't sign one permit for all of them.");
    expect(recorded.asked).toEqual(["sign", "transfer", "transfer"]);
    expect(recorded.steps).not.toContain("tip-permission");
    expect(recorded.sent).toHaveLength(2);
    // Found out once, and remembered by the page for the session.
    expect(outcome.batchUnusable).toBe("your wallet couldn't sign one permit for all of them");
  });

  it("sends nothing when the signature is declined: that is an answer, and no permission is asked", async () => {
    const { deps, recorded } = harness({ readAllowance: async () => 0n, signTypedData: () => Promise.reject(rejection()) });
    const outcome = await sendTips(deps);
    expect(outcome).toEqual({ note: " Tips not sent: you declined the signature.", mode: "none" });
    expect(recorded.asked).toEqual(["sign"]);
    expect(recorded.sent).toHaveLength(0);
  });

  it("never asks for a signature the Guard refused", async () => {
    const { deps, recorded } = harness({
      checks: { checkTipSignature: async () => rejected([{ code: "TIP_MALFORMED", message: "spender" }]) },
    });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(" Tips not sent — spDEX refused them: TIP_MALFORMED.");
    expect(recorded.typed).toHaveLength(0);
    expect(recorded.sent).toHaveLength(0);
  });

  it("never sends a batch the Guard refused", async () => {
    const { deps, recorded } = harness({
      checks: {
        checkTips: async (plan) =>
          plan.mode === "permit2-batch"
            ? rejected([{ code: "TIP_NOT_DELIVERED", message: "b receives 0" }])
            : verified(),
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(" Tips not sent — spDEX refused them: TIP_NOT_DELIVERED.");
    expect(recorded.typed).toHaveLength(1);
    expect(recorded.sent).toHaveLength(0);
  });

  it("sends separate transfers when the batch would only revert, and says why", async () => {
    // An account whose own code answers for its signatures, and doesn't.
    const { deps, recorded } = harness({
      checks: {
        checkTips: async (plan) =>
          plan.mode === "permit2-batch"
            ? rejected([{ code: "SIMULATION_REVERTED", message: "InvalidSigner()" }])
            : verified(),
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.mode).toBe("transfers");
    expect(outcome.note).toBe(
      " Tipped 50 SPX to 2 people, in 2 separate transfers: the one transaction would fail on chain (InvalidSigner()).",
    );
    expect(recorded.sent.map((call) => call.to)).toEqual([SPX.address, SPX.address]);
    expect(outcome.batchUnusable).toBe("one transaction for all of them would fail for this wallet");
  });

  it("sends separate transfers when the signature expired while the permission was confirmed", async () => {
    // The permission's confirmation outlasted the permit's twenty minutes:
    // the Guard finds the deadline passed. A dead permit, not a wallet that
    // can't batch, so nothing is remembered against the wallet.
    const { deps, recorded } = harness({
      readAllowance: async () => 0n,
      checks: {
        checkTips: async (plan) =>
          plan.mode === "permit2-batch"
            ? rejected([{ code: "DEADLINE_EXPIRED", message: "the permit's deadline has passed" }])
            : verified(),
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.mode).toBe("transfers");
    expect(outcome.note).toBe(
      " Tipped 50 SPX to 2 people, in 2 separate transfers: the signature expired before the one transaction could " +
        "use it. The Permit2 permission you gave stays until you revoke it in Settings → Tips.",
    );
    expect(recorded.asked).toEqual(["sign", "permission", "transfer", "transfer"]);
    expect(outcome.batchUnusable).toBeUndefined();
  });

  it("sends separate transfers where Permit2 isn't the contract spDEX knows, or can't be told", async () => {
    for (const [answer, why] of [
      [false, "Permit2 on this network isn't the contract spDEX knows"],
      ["unknown", "spDEX couldn't confirm Permit2 on this network"],
    ] as const) {
      const { deps, recorded } = harness({ checks: { permit2Available: async () => answer } });
      const outcome = await sendTips(deps);
      expect(outcome.note).toBe(` Tipped 50 SPX to 2 people, in 2 separate transfers: ${why}.`);
      expect(recorded.typed).toHaveLength(0);
      expect(recorded.steps).toEqual(["tip", "tip"]);
    }
  });

  it("signs a deadline twenty minutes out by the page's clock", async () => {
    const { deps, recorded } = harness();
    await sendTips(deps);
    const typed = JSON.parse(recorded.typed[0]!) as { message: { deadline: string; spender: string } };
    expect(typed.message.deadline).toBe(String(NOW_MS / 1000 + 20 * 60));
    expect(typed.message.spender).toBe(ACCOUNT);
  });

  it("says the permission stays when it was given and then nothing used it", async () => {
    const stays = " The Permit2 permission you gave stays until you revoke it in Settings → Tips.";
    // Only after the signature can a permission be left unused: the batch
    // then reverts for the account, the Guard refuses it, or the person
    // declines it.
    const reverted = await sendTips(
      harness({
        readAllowance: async () => 0n,
        checks: {
          checkTips: async (plan) =>
            plan.mode === "permit2-batch" ? rejected([{ code: "SIMULATION_REVERTED", message: "InvalidSigner()" }]) : verified(),
        },
      }).deps,
    );
    expect(reverted.note.endsWith(stays)).toBe(true);

    const refused = await sendTips(
      harness({
        readAllowance: async () => 0n,
        checks: {
          checkTips: async (plan) =>
            plan.mode === "permit2-batch" ? rejected([{ code: "TIP_NOT_DELIVERED", message: "b receives 0" }]) : verified(),
        },
      }).deps,
    );
    expect(refused.note).toBe(` Tips not sent — spDEX refused them: TIP_NOT_DELIVERED.${stays}`);

    const declined = await sendTips(
      harness({
        readAllowance: async () => 0n,
        send: async (call) => {
          if (kindOf(call) === "batch") throw rejection();
        },
      }).deps,
    );
    expect(declined.note).toBe(` Tips not sent: you declined in your wallet.${stays}`);

    // Given and used as meant: nothing to add.
    const batched = await sendTips(harness({ readAllowance: async () => 0n }).deps);
    expect(batched.note).not.toContain("stays");
    // Never given, because the signature came first and was declined, or
    // could not be given: nothing to add either.
    const unsigned = await sendTips(harness({ readAllowance: async () => 0n, signTypedData: unsupported }).deps);
    expect(unsigned.note).not.toContain("stays");
    const already = await sendTips(harness({ signTypedData: () => Promise.reject(rejection()) }).deps);
    expect(already.note).toBe(" Tips not sent: you declined the signature.");
  });

  it("keeps the wallet's own error when it failed at signing rather than lacking the method", async () => {
    const { deps } = harness({ signTypedData: () => Promise.reject(new Error("device disconnected")) });
    const outcome = await sendTips(deps);
    expect(outcome.note).toContain("your wallet can't sign one permit for all of them (device disconnected)");
  });

  it("goes straight to separate transfers once a batch is known not to work for this wallet", async () => {
    const { deps, recorded } = harness({
      readAllowance: async () => 0n,
      batchUnusable: "your wallet couldn't sign one permit for all of them",
    });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(
      " Tipped 50 SPX to 2 people, in 2 separate transfers: your wallet couldn't sign one permit for all of them earlier in this session.",
    );
    // No permission, no signature: only the two transfers.
    expect(recorded.steps).toEqual(["tip", "tip"]);
    expect(recorded.typed).toHaveLength(0);
    expect(recorded.checked).toEqual(["tips:transfers"]);
  });

  it("never asks for the permission untested", async () => {
    for (const verdict of [
      unverified([{ code: "SIMULATION_UNAVAILABLE", message: "no eth_simulateV1" }]),
      rejected([{ code: "SIMULATION_UNAVAILABLE", message: "no eth_simulateV1" }]),
    ]) {
      const { deps, recorded } = harness({ readAllowance: async () => 0n, checks: { checkTipPermission: async () => verdict } });
      const outcome = await sendTips(deps);
      expect(outcome.note).toBe(
        " Tipped 50 SPX to 2 people, in 2 separate transfers: your network service can't test-run the permission " +
          "for Permit2, and spDEX never asks for it untested.",
      );
      expect(recorded.steps).toEqual(["tip", "tip"]);
    }
  });

  it("says a permission waits for both services when the second opinion didn't answer, and sends the tips one by one", async () => {
    const waits = rejected([
      {
        code: "SECOND_OPINION_UNAVAILABLE",
        message: "your second network service didn't answer (no answer in time), and this is never signed on one service's test-run alone",
        detail: { host: "second.example", failure: "no answer in time" },
      },
    ]);
    const { deps, recorded } = harness({ readAllowance: async () => 0n, checks: { checkTipPermission: async () => waits } });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(
      " Tipped 50 SPX to 2 people, in 2 separate transfers: your second network service didn't answer, and a permission " +
        "for Permit2 waits until both services agree.",
    );
    expect(outcome.note).not.toMatch(/SECOND_OPINION_UNAVAILABLE|checked on one service/);
    // No permission and no signature were asked for: only the two transfers.
    expect(recorded.steps).toEqual(["tip", "tip"]);
    expect(recorded.typed).toHaveLength(0);
  });

  it("says so when the tips went out checked but not test-run", async () => {
    const untested = unverified([{ code: "SIMULATION_UNAVAILABLE", message: "no eth_simulateV1" }]);
    const { deps, recorded } = harness({ checks: { checkTips: async () => untested } });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(
      " Tipped 50 SPX to 2 people in one transaction. spDEX checked the tips but couldn't test-run them: your network service can't.",
    );
    const batch = recorded.shown.find((step) => step.kind === "tip-batch");
    expect(batch && batch.kind === "tip-batch" ? batch.tested : null).toBe(false);
  });

  it("numbers every prompt, continuing the swap's count, and settles it as it learns", async () => {
    // Two swap prompts already shown, and the tips counted as three before
    // the swap (the permission might be needed).
    const counter = new StepCounter(5);
    counter.next();
    counter.next();
    const { deps, recorded } = harness({ counter });
    await sendTips(deps);
    // The permission was there already: two prompts, numbered 3 and 4 of 4.
    expect(recorded.shown.map((step) => ("step" in step ? `${step.step}/${step.of}` : ""))).toEqual(["3/4", "4/4"]);

    const declined = new StepCounter(5);
    declined.next();
    declined.next();
    const second = harness({
      counter: declined,
      readAllowance: async () => 0n,
      send: async (call) => {
        if (kindOf(call) === "permission") throw rejection();
      },
    });
    await sendTips(second.deps);
    // The signature as step 3 of 5 and the permission as 4 of 5; declined,
    // two transfers where the one batch would have been, so the count grows
    // by the one prompt more rather than ever printing "6 of 5".
    expect(second.recorded.shown.map((step) => ("step" in step ? `${step.step}/${step.of}` : ""))).toEqual([
      "3/5",
      "4/5",
      "5/6",
      "6/6",
    ]);
    expect(second.recorded.steps).toEqual(["tip-sign", "tip-permission", "tip", "tip"]);
    // And each transfer's prompt says why it is a transfer.
    const transfer = second.recorded.shown[2];
    expect(transfer?.kind === "tip" ? transfer.why : null).toBe("you declined the permission for Permit2");

    // A wallet that can't sign: the signature was step 3 of 5, and the two
    // transfers settle the count at 5, with no permission in it.
    const unable = new StepCounter(5);
    unable.next();
    unable.next();
    const third = harness({ counter: unable, readAllowance: async () => 0n, signTypedData: unsupported });
    await sendTips(third.deps);
    expect(third.recorded.shown.map((step) => ("step" in step ? `${step.step}/${step.of}` : ""))).toEqual([
      "3/5",
      "4/5",
      "5/5",
    ]);
    expect(third.recorded.steps).toEqual(["tip-sign", "tip", "tip"]);
  });

  it("describes the signature and the batch as the wallet will show them", async () => {
    const { deps, recorded } = harness();
    await sendTips(deps);
    const sign = recorded.shown.find((step) => step.kind === "tip-sign");
    expect(sign).toMatchObject({
      symbol: "SPX",
      amounts: [
        { shown: "25", raw: "2500000000" },
        { shown: "25", raw: "2500000000" },
      ],
      minutes: 20,
      // The permission is already given, so the transaction comes next.
      permissionNext: false,
    });
    const batch = recorded.shown.find((step) => step.kind === "tip-batch");
    expect(batch).toMatchObject({
      symbol: "SPX",
      payments: [
        { name: "a", shown: "25" },
        { name: "b", shown: "25" },
      ],
      tested: true,
    });
  });

  it("never throws, even when a send fails for a reason nobody planned for", async () => {
    const { deps } = harness({ send: () => Promise.reject(new Error("transaction 0xab… reverted on chain")) });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(" Tips not sent: transaction 0xab… reverted on chain.");
  });
});

describe("one recipient", () => {
  it("is one plain transfer: no Permit2, no signature, no permission", async () => {
    let asked = false;
    const { deps, recorded } = harness({
      transfers: [TWO[0]!],
      checks: {
        permit2Available: async () => {
          asked = true;
          return true;
        },
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(" Tipped 25 SPX to 1 person.");
    expect(asked).toBe(false);
    expect(recorded.typed).toHaveLength(0);
    expect(recorded.sent).toHaveLength(1);
    expect(recorded.sent[0]!.to).toBe(SPX.address);
  });

  it("reports how far separate transfers got when one is declined", async () => {
    let calls = 0;
    const { deps } = harness({
      checks: { permit2Available: async () => false },
      send: async () => {
        calls += 1;
        if (calls === 2) throw rejection();
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.note).toBe(" Tips stopped after 1 of 2: you declined in your wallet.");
  });
});

describe("choosePermit2Nonce", () => {
  it("returns a nonce whose bit is unused in its word", async () => {
    const nonce = await choosePermit2Nonce(async () => 0n, (length) => new Uint8Array(length).fill(2));
    expect(permit2NoncePosition(nonce)).toEqual({ word: BigInt(`0x${"02".repeat(31)}`), bit: 2 });
  });

  it("picks again when the bit is already used", async () => {
    let draw = 0;
    const words: bigint[] = [];
    const nonce = await choosePermit2Nonce(
      async (word) => {
        words.push(word);
        // The first word has every bit used; the second has none.
        return words.length === 1 ? (1n << 256n) - 1n : 0n;
      },
      (length) => new Uint8Array(length).fill(++draw),
    );
    expect(words).toHaveLength(2);
    expect(permit2NoncePosition(nonce).bit).toBe(2);
  });

  it("gives up rather than loop when every pick reads as used", async () => {
    await expect(choosePermit2Nonce(async () => (1n << 256n) - 1n)).rejects.toThrow(/reads as used/);
  });

  it("does not treat an unreadable bitmap as empty", async () => {
    await expect(choosePermit2Nonce(() => Promise.reject(new Error("429")))).rejects.toThrow("429");
  });
});

describe("what goes into this browser's record", () => {
  /** A sender that answers each call with a hash of its own, as the page's sender does. */
  const hashingSend = () => {
    let n = 0;
    return async (): Promise<`0x${string}`> => `0x${(++n).toString(16).padStart(64, "0")}`;
  };
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

  it("keeps a batch as one payment to everyone, with the permission it needed first", async () => {
    const { deps } = harness({ readAllowance: async () => 0n, send: hashingSend() });
    const outcome = await sendTips(deps);
    expect(outcome.sent).toEqual([{ token: SPX.address, hashes: [hash(1), hash(2)], amount: 50_00000000n, recipients: 2 }]);
  });

  it("keeps each separate transfer as its own payment", async () => {
    const { deps } = harness({ checks: { permit2Available: async () => false }, send: hashingSend() });
    const outcome = await sendTips(deps);
    expect(outcome.sent).toEqual([
      { token: SPX.address, hashes: [hash(1)], amount: 25_00000000n, recipients: 1 },
      { token: SPX.address, hashes: [hash(2)], amount: 25_00000000n, recipients: 1 },
    ]);
  });

  it("keeps the transfers that went out when a later one was declined", async () => {
    const send = hashingSend();
    let calls = 0;
    const { deps } = harness({
      checks: { permit2Available: async () => false },
      send: async () => {
        calls += 1;
        if (calls === 2) throw rejection();
        return send();
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.sent).toEqual([{ token: SPX.address, hashes: [hash(1)], amount: 25_00000000n, recipients: 1 }]);
  });

  it("counts a permission nothing used with the first transfer, whose tipping it was for", async () => {
    const { deps } = harness({
      readAllowance: async () => 0n,
      send: hashingSend(),
      checks: {
        checkTips: async (plan) =>
          plan.mode === "permit2-batch"
            ? rejected([{ code: "DEADLINE_EXPIRED", message: "the permit's deadline has passed" }])
            : verified(),
      },
    });
    const outcome = await sendTips(deps);
    expect(outcome.sent?.map((payment) => payment.hashes)).toEqual([[hash(1), hash(2)], [hash(3)]]);
  });

  it("records nothing when the sender gives no hashes, and nothing when nothing went out", async () => {
    expect((await sendTips(harness().deps)).sent).toBeUndefined();
    const declined = harness({ send: async () => Promise.reject(rejection()) });
    expect((await sendTips(declined.deps)).sent).toBeUndefined();
  });
});
