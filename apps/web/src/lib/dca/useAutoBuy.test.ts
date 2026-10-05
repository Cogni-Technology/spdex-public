/**
 * The hook's pure pieces: how an error reads on a card, which key a card's
 * activity lives under, and which price warning a "Buy anyway" accepts. The
 * hook itself needs a DOM and is exercised in the browser; these are the
 * words it shows and the one rule it keeps about consent.
 */

import { describe, expect, it } from "vitest";
import { LedgerBusyError, LedgerRebindError, LedgerUnavailableError } from "./ledger.js";
import { VaultTxFailed, VaultTxRefused } from "./vault.js";
import { consentFor, noticeFor, strayVaultKey, type CardActivity } from "./useAutoBuy.js";

describe("noticeFor", () => {
  it("says a busy ledger is another tab, and to try again, as a warning", () => {
    expect(noticeFor(new LedgerBusyError(), null)).toEqual({
      tone: "warn",
      title: "Try again in a moment",
      text: "Another spDEX tab is busy — try again in a moment.",
    });
  });

  it("treats a decline in the wallet as a cancel, not a failure", () => {
    const declined = Object.assign(new Error("user rejected the request"), { code: 4001 });
    expect(noticeFor(declined, null)).toEqual({
      tone: "warn",
      title: "Cancelled",
      text: "Cancelled in your wallet. Nothing was sent.",
    });
  });

  it("says an unreadable record stops the action", () => {
    expect(noticeFor(new LedgerUnavailableError(), null)).toMatchObject({ tone: "danger", text: expect.stringMatching(/Nothing was changed/) });
  });

  it("explains a refused vault transaction by the vault's own reason when its simulation reverted with one", () => {
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const refused = new VaultTxRefused({
      level: "rejected",
      signable: false,
      violations: [{ code: "SIMULATION_REVERTED", message: `execution reverted: 0xd6e7da92${word(8n)}${word(9n)}` }],
      warnings: [],
    });
    expect(noticeFor(refused, null)).toMatchObject({
      tone: "danger",
      title: "Blocked by the safety check",
      text: "Nothing was sent. The price is outside this vault's allowance right now, so it won't buy. It waits for the market.",
      codes: ["SIMULATION_REVERTED"],
    });
    const malformed = new VaultTxRefused({
      level: "rejected",
      signable: false,
      violations: [{ code: "VAULT_MALFORMED", message: "not the plan's vault" }],
      warnings: [],
    });
    expect(noticeFor(malformed, null).text).toBe("Nothing was sent. This didn't match your vault or its plan (the contract, the amount or the terms).");
  });

  /** A v2 vault's refusal of a fee named for someone who may not be paid it inside the window, in words. */
  it("explains a v2 vault's community-window refusal in the vault's own terms", () => {
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const refused = new VaultTxRefused({
      level: "rejected",
      signable: false,
      // NotEligible(address rewardTo, uint256 windowEndsAt)
      violations: [{ code: "SIMULATION_REVERTED", message: `execution reverted: 0x5863fc24${word(0xbbn)}${word(1_000n)}` }],
      warnings: [],
    });
    expect(noticeFor(refused, null).text).toBe(
      "Nothing was sent. Inside its community window, a buy's fee can be paid only to a community keeper (an account proven to hold 690 SPX) or the vault's owner.",
    );
  });

  it("says a vault transaction refused because the second opinion didn't answer waits for both services, never a fault", () => {
    const refused = new VaultTxRefused({
      level: "rejected",
      signable: false,
      violations: [
        {
          code: "SECOND_OPINION_UNAVAILABLE",
          message: "your second network service, second.example, didn't answer (no answer in time), and this is never signed on one service's test-run alone",
          detail: { host: "second.example", failure: "no answer in time" },
        },
      ],
      warnings: [],
    });
    const notice = noticeFor(refused, null);
    expect(notice).toMatchObject({ tone: "danger", title: "Blocked by the safety check", codes: ["SECOND_OPINION_UNAVAILABLE"] });
    expect(notice.text).toBe(
      "Not sent — your second network service didn't answer. A transaction that sends ETH or grants a permission waits until both agree.",
    );
    // Never the warning's own sentence, which says it was checked on one service.
    expect(notice.text).not.toMatch(/checked on one service/);
  });

  it("says a vault transaction that was sent and then failed by its hash, and one not yet mined as still on its way", () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    expect(noticeFor(new VaultTxFailed(hash, new Error(`transaction ${hash.slice(0, 10)}… reverted on chain`)), null)).toMatchObject({
      tone: "danger",
      title: "The transaction failed",
      text: "It was sent (0xabab…abab) and the network rejected it, so nothing changed but the network fee.",
    });
    expect(noticeFor(new VaultTxFailed(hash, new Error("transaction 0xabab… has not been mined after 120s.")), null)).toMatchObject({
      tone: "warn",
      title: "Still waiting for the network",
    });
  });

  it("says a plan migrated from autopilot waits for its spending wallet's last buy before it resumes", () => {
    const notice = noticeFor(new LedgerRebindError("plan \"dca-1\" has a buy from its spending wallet (window 3) that hasn't settled"), null);
    expect(notice).toMatchObject({ tone: "warn", title: "Not resumed yet", text: expect.stringMatching(/old spending wallet hasn't been confirmed/) });
    expect(notice.detail).toMatch(/window 3/);
  });

  it("keeps the raw message of anything else for Details", () => {
    const notice = noticeFor(new Error("Failed to fetch"), "http://127.0.0.1:8545");
    expect(notice.tone).toBe("danger");
    expect(notice.detail).toBe("Failed to fetch");
    expect(notice.text).toContain("http://127.0.0.1:8545");
  });
});

describe("activity keys", () => {
  it("keys a vault no plan points at by its address, whatever its case, apart from any plan's", () => {
    expect(strayVaultKey("0xABCdef0000000000000000000000000000000001")).toBe("stray-vault:0xabcdef0000000000000000000000000000000001");
    // A plan id is lowercase letters, digits and dashes: never with a colon.
    expect(strayVaultKey("0x01")).toMatch(/:/);
  });
});

describe("consentFor", () => {
  const activity = (bps: number | null, slot: number | null): CardActivity => ({
    busy: null,
    notice: null,
    consentBps: bps,
    consentSlot: slot,
  });

  it("accepts a price warning only for the buy time it was shown for", () => {
    expect(consentFor(activity(250, 4), { kind: "due", slot: 4, endsAt: 0 })).toBe(250);
    // Yesterday's warning, left unanswered, is not today's "Buy anyway".
    expect(consentFor(activity(250, 4), { kind: "due", slot: 5, endsAt: 0 })).toBeNull();
    expect(consentFor(activity(250, 4), { kind: "waiting", nextAt: 0 })).toBeNull();
    expect(consentFor(activity(null, null), { kind: "due", slot: 4, endsAt: 0 })).toBeNull();
    expect(consentFor(undefined, { kind: "due", slot: 4, endsAt: 0 })).toBeNull();
  });
});

describe("a notice when the built-in service doesn't answer", () => {
  it("says it may be busy before it sends anyone to choose another service", () => {
    const own = noticeFor(new TypeError("Failed to fetch"), "https://rpc.example/key", false);
    const builtIn = noticeFor(new TypeError("Failed to fetch"), "https://rpc.example/key", true);
    expect(builtIn.text).toMatch(/^spDEX's built-in network service didn't answer\. It may be busy/);
    expect(own.text).not.toMatch(/built-in/);
  });
});
