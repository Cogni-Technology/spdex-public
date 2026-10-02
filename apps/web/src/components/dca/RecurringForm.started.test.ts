/**
 * The "Auto-buy started" banner after Start: "Confirm the first buy in your
 * wallet now." is true only until the wallet answers, and a decline leaves
 * the buy due (ledger.ts `releaseBuy`), so the banner says so rather than
 * standing stale.
 */

import { describe, expect, it } from "vitest";
import { firstRunText } from "./RecurringForm.js";

describe("the started banner's words once the first buy has an answer", () => {
  it("keeps Start's own words while the wallet hasn't answered", () => {
    expect(firstRunText(undefined)).toBeNull();
    expect(firstRunText({ status: "pending" })).toBeNull();
    expect(firstRunText({ status: "unknown" })).toBeNull();
  });

  it("says how it went once it has", () => {
    expect(firstRunText({ status: "confirmed" })).toBe("Its first buy went through.");
    expect(firstRunText({ status: "declined" })).toBe(
      "You declined the first buy in your wallet. It's still due: confirm it or skip it in Auto-buys.",
    );
    expect(firstRunText({ status: "failed" })).toBe("Its first buy didn't go through; Auto-buys says why.");
    expect(firstRunText({ status: "skipped" })).toBe("Its first buy didn't go through; Auto-buys says why.");
  });
});
