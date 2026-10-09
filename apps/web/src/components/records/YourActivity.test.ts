import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import { YourActivity, activitySummary, fillResultText } from "./YourActivity.js";
import type { Address, Hex } from "@spdex/core";
import type { Records } from "../../lib/records/store.js";
import type { RecordRow, VaultBuyFacts } from "../../lib/records/types.js";

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

describe("who made a vault buy, in the row", () => {
  const ME = "0x00000000000000000000000000000000000a11ce" as Address;
  const KEEPER = "0x4444444444444444444444444444444444444444" as Address;
  const AT = 1_789_683_000;
  const row = (n: number, overrides: Partial<RecordRow> = {}): RecordRow => ({
    id: `row-${n}`,
    kind: "vault-buy",
    chainId: 1,
    account: ME,
    at: { unix: AT - n, source: "block" },
    block: 26_001_249n,
    hashes: [`0x${n.toString(16).padStart(64, "0")}` as Hex],
    sold: { token: TOKENS.WETH.address, amount: 10n ** 16n, measured: true },
    bought: { token: TOKENS.SPX.address, amount: 6_912_34567891n, measured: true },
    buyFee: 0n,
    networkFee: 0n,
    valueUsd: null,
    rates: null,
    valueSource: null,
    planId: "daily",
    planLabel: "Daily SPX",
    buyIndex: { n: 2, of: 69 },
    ...overrides,
  });
  const facts = (maker: VaultBuyFacts["maker"]): VaultBuyFacts => ({ caller: KEEPER, rewardTo: KEEPER, dueSince: AT - 900, maker });
  const records = (rows: RecordRow[]): Records => ({
    rows,
    state: "ready",
    notes: [],
    truncated: [],
    unattributed: 0,
    fillable: 0,
    filling: false,
    fill: async () => ({ read: 0, failed: 0, left: 0 }),
  });
  const render = (rows: RecordRow[]) =>
    renderToStaticMarkup(createElement(YourActivity, { records: records(rows), account: ME, chainId: 1, rpc: null, pricing: null, open: true }));
  /** Each row's maker line, by row, as rendered: `[data-maker, text]`, or null without one. */
  const makers = (html: string) =>
    html
      .split('data-testid="activity-row"')
      .slice(1)
      .map((part) => {
        const found = /data-testid="activity-maker" data-maker="([a-z]+)">([^<]*)</.exec(part);
        return found === null ? null : [found[1], found[2]!.replaceAll("&#x27;", "'")];
      });

  it("says it in one quiet line under the figures, only for a vault buy whose maker is known", () => {
    const html = render([
      row(1, { vaultBuy: facts("community") }),
      row(2, { vaultBuy: facts("owner") }),
      row(3, { vaultBuy: facts("open") }),
      row(4, { vaultBuy: facts("returned") }),
      row(5, { vaultBuy: { caller: KEEPER, rewardTo: null, dueSince: null, maker: "caller" } }),
      row(6, { vaultBuy: facts(null) }),
      row(7, { kind: "swap", sold: { token: NATIVE_TOKEN, amount: 10n ** 16n, measured: true } }),
      row(8, { vaultBuy: { caller: ME, rewardTo: null, dueSince: null, maker: "owner" } }),
    ]);
    expect(makers(html)).toEqual([
      ["community", "Made by a community keeper"],
      ["owner", "Made by you"],
      ["open", "Made after the community window, when anyone could"],
      ["returned", "Made by someone else; the fee came back to you"],
      // v1 buys keep their rows as they were: no new line under them.
      null,
      null,
      null,
      null,
    ]);
    // In the line under the figures that holds the badge, and in the What cell's tooltip.
    expect(html).toContain('<span class="spdex-activity__extra"><span class="spdex-activity__maker" data-testid="activity-maker" data-maker="community">');
    expect(html).toContain('title="Vault buy · “Daily SPX”, buy 2 of 69. Made by a community keeper."');
    expect(html).not.toMatch(/reward/i);
  });
});
