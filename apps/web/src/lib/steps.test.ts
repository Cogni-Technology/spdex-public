/**
 * Step copy for the swap and auto-buy status lines.
 *
 * These sentences are what a person reads while their wallet is open, and two
 * end-to-end rules hang on them: no step on the public path may say
 * "privately" (expert.spec checks the status after a public fallback), and the
 * word "Approving" is gone for good (native.spec checks ETH input never shows
 * it). Both are pinned here for every step, so a reword can't break them
 * without a unit failure first.
 */

import { describe, expect, it } from "vitest";
import { localClock, StepCounter, stepText, type Step } from "./steps.js";
import { PLACES } from "./places.js";

const clock = (unixSeconds: number) => `T${unixSeconds}`;

describe("stepText", () => {
  it("words the auto-buy preamble", () => {
    expect(stepText({ kind: "quote" })).toBe("Getting a price…");
    expect(stepText({ kind: "check" })).toBe("Running the safety check…");
  });

  it("names the token a permission is for, and counts only when there is more than one prompt", () => {
    expect(stepText({ kind: "permission", symbol: "WETH", step: 1, of: 2 })).toBe(
      "Confirm the permission to spend WETH in your wallet (step 1 of 2)…",
    );
    expect(stepText({ kind: "permission", symbol: "USDC", step: 1, of: 1 })).toBe(
      "Confirm the permission to spend USDC in your wallet…",
    );
  });

  it("states the deadline on the trade prompt", () => {
    expect(stepText({ kind: "swap", deadline: 1_700_000_000, step: 2, of: 2 }, { formatTime: clock })).toBe(
      "Confirm the swap in your wallet before T1700000000 (step 2 of 2)…",
    );
    expect(stepText({ kind: "buy", deadline: 42, step: 1, of: 1 }, { formatTime: clock })).toBe(
      "Confirm the buy in your wallet before T42…",
    );
  });

  it("promises no time when the deadline is unknown", () => {
    expect(stepText({ kind: "swap", deadline: null, step: 1, of: 1 })).toBe("Confirm the swap in your wallet…");
    expect(stepText({ kind: "buy", deadline: Number.NaN, step: 1, of: 3 })).toBe(
      "Confirm the buy in your wallet (step 1 of 3)…",
    );
  });

  it("words private posting, waiting and tips", () => {
    expect(stepText({ kind: "private" })).toBe("Sending privately…");
    expect(stepText({ kind: "wait" })).toBe("Waiting for the network…");
    expect(stepText({ kind: "tip", index: 2, count: 3, why: null, step: 4, of: 5 })).toBe(
      "Confirm tip 2 of 3 in your wallet (step 4 of 5)…",
    );
    expect(stepText({ kind: "tip", index: 1, count: 1, why: null, step: 3, of: 3 })).toBe(
      "Confirm the tip in your wallet (step 3 of 3)…",
    );
  });

  it("says why tips go one at a time when a batch was expected", () => {
    expect(
      stepText({ kind: "tip", index: 1, count: 2, why: "you declined the permission for Permit2", step: 4, of: 5 }),
    ).toBe(
      "Each tip goes as its own transaction: you declined the permission for Permit2. " +
        "Confirm tip 1 of 2 in your wallet (step 4 of 5)…",
    );
  });

  it("explains the Permit2 permission where it is asked: unlimited, standing, and not only spDEX's to use", () => {
    const text = stepText({ kind: "tip-permission", symbol: "SPX", step: 4, of: 5 });
    expect(text).toBe(
      "Asked once: let Permit2 (Uniswap's contract) move your SPX, with no limit, until you revoke it in Settings → Tips. " +
        "Permit2 moves it only on a signature or a Permit2 approval you give. spDEX checks the ones it asks for; " +
        "one another site asks for can move this SPX too. Confirm in your wallet (step 4 of 5), or decline: each " +
        "tip then goes as its own transaction, and the signature you just gave goes unused…",
    );
    // Where to revoke it is named as the page names that place.
    expect(text).toContain(`revoke it in ${PLACES.tips.label}.`);
    // What the review found untrue: spDEX never shows the signature, and
    // Permit2 can move tokens on an approval, with no signature per spend.
    expect(text).not.toMatch(/shows and checks|can't move anything without/);
    expect(text).not.toMatch(/one-time/);
  });

  it("describes the signature as the wallet will show it, and says it names nobody", () => {
    const amounts = [
      { shown: "0.643306", raw: "64330600" },
      { shown: "0.643306", raw: "64330600" },
    ];
    expect(stepText({ kind: "tip-sign", symbol: "SPX", amounts, minutes: 20, permissionNext: false, step: 4, of: 5 })).toBe(
      "Sign in your wallet (step 4 of 5). It shows Permit2, SPX 0.643306 each (64330600 in raw units), spender: " +
        "your own address, valid 20 minutes. spDEX checked it first. It names nobody and moves nothing by itself: " +
        "only the transaction you send next can use it, and that one names who gets paid…",
    );
    // The first time, the permission for Permit2 comes between the signature
    // and the transaction that uses it, and the text says so rather than
    // calling that transaction "next".
    expect(stepText({ kind: "tip-sign", symbol: "SPX", amounts, minutes: 20, permissionNext: true, step: 3, of: 5 })).toBe(
      "Sign in your wallet (step 3 of 5). It shows Permit2, SPX 0.643306 each (64330600 in raw units), spender: " +
        "your own address, valid 20 minutes. spDEX checked it first. It names nobody and moves nothing by itself: " +
        "only a transaction you send can use it. Next comes the permission for Permit2, then the transaction that " +
        "uses it and names who gets paid…",
    );
    const uneven = stepText({
      kind: "tip-sign",
      symbol: "SPX",
      amounts: [
        { shown: "0.5", raw: "50000000" },
        { shown: "0.3", raw: "30000000" },
        { shown: "0.2", raw: "20000000" },
      ],
      minutes: 20,
      permissionNext: false,
      step: 1,
      of: 2,
    });
    expect(uneven).toContain("It shows Permit2, SPX 0.5, 0.3 and 0.2 (50000000, 30000000 and 20000000 in raw units)");
    expect(uneven).not.toMatch(/not a transaction/);
  });

  it("names who the batch pays, and says whether it was test-run", () => {
    const payments = [
      { name: "Placeholder: dev fund", shown: "0.64" },
      { name: "Placeholder: meme fund", shown: "0.64" },
    ];
    expect(stepText({ kind: "tip-batch", symbol: "SPX", payments, tested: true, step: 5, of: 5 })).toBe(
      "Confirm the tip in your wallet (step 5 of 5): one transaction to Permit2 pays 0.64 SPX each to " +
        "Placeholder: dev fund and Placeholder: meme fund. spDEX checked and test-ran it…",
    );
    expect(
      stepText({
        kind: "tip-batch",
        symbol: "SPX",
        payments: [
          { name: "a", shown: "0.5" },
          { name: "b", shown: "0.3" },
        ],
        tested: false,
        step: 2,
        of: 2,
      }),
    ).toBe(
      "Confirm the tip in your wallet (step 2 of 2): one transaction to Permit2 pays 0.5 SPX to a and 0.3 SPX to b. " +
        "spDEX checked it, but your network service can't test-run it…",
    );
  });

  it("never says 'privately' on a public step, and never says 'Approving'", () => {
    const publicSteps: Step[] = [
      { kind: "quote" },
      { kind: "check" },
      { kind: "permission", symbol: "WETH", step: 1, of: 2 },
      { kind: "swap", deadline: 1_700_000_000, step: 2, of: 2 },
      { kind: "buy", deadline: null, step: 1, of: 1 },
      { kind: "wait" },
      { kind: "tip", index: 1, count: 1, why: null, step: 1, of: 1 },
      {
        kind: "tip-sign",
        symbol: "SPX",
        amounts: [{ shown: "1", raw: "100000000" }],
        minutes: 20,
        permissionNext: true,
        step: 1,
        of: 3,
      },
      { kind: "tip-permission", symbol: "SPX", step: 2, of: 3 },
      { kind: "tip-batch", symbol: "SPX", payments: [{ name: "a", shown: "1" }], tested: true, step: 3, of: 3 },
    ];
    for (const step of publicSteps) {
      const text = stepText(step, { formatTime: clock });
      expect(text).not.toMatch(/privately/i);
      expect(text).not.toMatch(/Approving/);
    }
  });
});

describe("localClock", () => {
  it("is a 24-hour HH:MM", () => {
    expect(localClock(1_700_000_000)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("StepCounter", () => {
  it("numbers prompts against the counted total", () => {
    const counter = new StepCounter(3);
    expect(counter.next()).toEqual({ step: 1, of: 3 });
    expect(counter.next()).toEqual({ step: 2, of: 3 });
    expect(counter.next()).toEqual({ step: 3, of: 3 });
  });

  it("grows the total rather than printing 'step 3 of 2'", () => {
    const counter = new StepCounter(2);
    counter.next();
    counter.next();
    expect(counter.next()).toEqual({ step: 3, of: 3 });
  });

  it("never counts fewer than one prompt", () => {
    expect(new StepCounter(0).next()).toEqual({ step: 1, of: 1 });
  });

  it("settles the rest of the count once it is known, up or down", () => {
    // A swap of two prompts, then tips counted as three before the swap.
    const counter = new StepCounter(5);
    counter.next();
    expect(counter.next()).toEqual({ step: 2, of: 5 });
    // The permission turned out to be there already: two tip prompts, not three.
    counter.expectMore(2);
    expect(counter.next()).toEqual({ step: 3, of: 4 });
    // Declined somewhere, and two transfers follow instead of the batch.
    counter.expectMore(2);
    expect(counter.next()).toEqual({ step: 4, of: 5 });
    expect(counter.next()).toEqual({ step: 5, of: 5 });
  });
});
