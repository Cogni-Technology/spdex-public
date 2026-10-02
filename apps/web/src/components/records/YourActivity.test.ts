import { describe, expect, it } from "vitest";
import { activitySummary, fillResultText } from "./YourActivity.js";
import type { Address } from "@spdex/core";
import type { RecordRow } from "../../lib/records/types.js";

describe("what a press of Fill in values says", () => {
  it("counts the blocks read, the ones that couldn't be, and those still to go", () => {
    expect(fillResultText({ read: 1, failed: 0, left: 0 })).toBe("Filled in values from Chainlink at 1 block.");
    expect(fillResultText({ read: 12, failed: 3, left: 40 })).toBe(
      "Filled in values from Chainlink at 12 blocks. 3 blocks couldn't be read: your network service may not keep state that old, so those cells stay blank. 40 blocks still to read: press again.",
    );
    expect(fillResultText({ read: 0, failed: 0, left: 0 })).toBe("Nothing left to fill in.");
  });
});

describe("the Your SPX tile's part from the records", () => {
  const ME = "0x00000000000000000000000000000000000a11ce" as Address;
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }) as RecordRow);

  it("counts the records, and adds nothing it doesn't know", () => {
    expect(activitySummary({ account: ME, records: { rows: rows(3), state: "ready" } })).toEqual({ text: "3 records" });
    expect(activitySummary({ account: ME, records: { rows: rows(1), state: "ready" } })).toEqual({ text: "1 record" });
    expect(activitySummary({ account: ME, records: { rows: [], state: "loading" } })).toEqual({ text: "" });
    expect(activitySummary({ account: null, records: { rows: rows(2), state: "ready" } })).toEqual({ text: "" });
  });
});
