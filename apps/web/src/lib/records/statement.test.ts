import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address } from "@spdex/core";
import { isBuyFeesRow, kindLabel, makerText, statementOf, statementWhat, valuesLine } from "./statement.js";
import type { RecordRow } from "./types.js";

const ME = "0xab5801a7d398351b8be11c439e05c5b3259aec9b" as Address;
const SPX = TOKENS.SPX.address.toLowerCase() as Address;

function row(overrides: Partial<RecordRow>): RecordRow {
  return {
    id: String(Math.random()),
    kind: "swap",
    chainId: 1,
    account: ME,
    at: { unix: 1_000, source: "block" },
    block: 1n,
    hashes: [],
    sold: { token: NATIVE_TOKEN, amount: 10n ** 16n, measured: true },
    bought: { token: SPX, amount: 100_00000000n, measured: true },
    buyFee: 0n,
    networkFee: 1n,
    valueUsd: null,
    rates: null,
    valueSource: null,
    ...overrides,
  };
}

describe("the statement", () => {
  const statement = statementOf({
    rows: [
      row({ at: { unix: 3_000, source: "block" } }),
      row({ kind: "plan-buy", at: { unix: 2_000, source: "device" }, bought: { token: SPX, amount: null, measured: false } }),
      row({ kind: "tip", sold: { token: SPX, amount: 5_00000000n, measured: true }, bought: { token: SPX, amount: 0n, measured: true } }),
      row({ account: null, sold: { token: NATIVE_TOKEN, amount: 10n ** 18n, measured: true } }),
      row({ account: "0x3333333333333333333333333333333333333333" }),
    ],
    account: ME,
    chainId: 1,
    currency: "EUR",
    generatedAt: 5_000,
    notes: [
      "The first 3 buys of plan “Daily” aren't listed: this browser keeps the latest 100.",
      "Couldn't tell which wallet made 1 of these; they're left out of the totals.",
    ],
  });

  it("names the wallet in full, the network, and the dates it covers", () => {
    expect(statement.title).toBe("spDEX activity statement");
    expect(statement.account).toBe("0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B");
    expect(statement.network).toBe("Ethereum (chain 1)");
    expect(statement.first).toBe(1_000);
    expect(statement.last).toBe(3_000);
  });

  it("totals each token's sold, bought and tipped amounts, saying how many aren't known, and averages nothing", () => {
    const eth = statement.totals.find((t) => t.token === NATIVE_TOKEN)!;
    const spx = statement.totals.find((t) => t.token === SPX)!;
    expect(eth.sold).toEqual({ amount: 2n * 10n ** 16n, unknown: 0, rows: 2 });
    expect(spx.bought).toEqual({ amount: 100_00000000n, unknown: 1, rows: 2 });
    expect(spx.tipped).toEqual({ amount: 5_00000000n, unknown: 0, rows: 1 });
    expect(Object.keys(spx)).toEqual(["token", "info", "sold", "bought", "tipped", "feesReceived"]);
    expect(spx.feesReceived).toEqual({ amount: 0n, unknown: 0, rows: 0 });
  });

  it("counts only this wallet's rows, and says what it left out", () => {
    expect(statement.rows).toHaveLength(3);
    expect(statement.notes).toEqual([
      "The first 3 buys of plan “Daily” aren't listed: this browser keeps the latest 100.",
      "Your activity also lists 1 row whose wallet couldn't be told; it's left out of this statement.",
    ]);
    expect(statement.footnote).toBe(
      "This browser's record, plus what the chain shows for your vaults. The chain is the source of truth. Nothing was uploaded. Not tax advice.",
    );
  });

  it("says which currencies the values are in", () => {
    expect(statement.valuesLine).toBe(
      "Values at the time are in USD and EUR where known, from spDEX's 10-minute average price or Chainlink; blank where unknown.",
    );
    expect(valuesLine("USD")).toBe(
      "Values at the time are in USD where known, from spDEX's 10-minute average price or Chainlink; blank where unknown.",
    );
  });
});

describe("buy fees received for other people's vault buys", () => {
  const WETH = TOKENS.WETH.address.toLowerCase() as Address;
  const fees = row({
    kind: "buy-fees-earned",
    sold: { token: WETH, amount: 0n, measured: true },
    bought: { token: WETH, amount: 5n * 10n ** 14n, measured: true },
    valueUsd: null,
    rates: null,
    valueSource: null,
  });
  const statement = statementOf({
    rows: [row({}), fees],
    account: ME,
    chainId: 1,
    currency: "USD",
    generatedAt: 5_000,
    notes: [],
  });

  it("totals them apart: never bought, never sold", () => {
    const weth = statement.totals.find((t) => t.token === WETH)!;
    expect(weth.feesReceived).toEqual({ amount: 5n * 10n ** 14n, unknown: 0, rows: 1 });
    expect(weth.bought).toEqual({ amount: 0n, unknown: 0, rows: 0 });
    expect(weth.sold).toEqual({ amount: 0n, unknown: 0, rows: 0 });
    // The swap's own totals are untouched.
    expect(statement.totals.find((t) => t.token === SPX)!.bought.rows).toBe(1);
  });

  it("names the row for what it is, and nothing else is one", () => {
    expect(isBuyFeesRow(fees)).toBe(true);
    expect(kindLabel(fees.kind)).toBe("Buy fees earned");
    for (const kind of ["swap", "tip", "plan-buy", "vault-buy"] as const) expect(isBuyFeesRow({ kind })).toBe(false);
  });
});

describe("who made a vault buy, on screen and on paper", () => {
  const KEEPER = "0x4444444444444444444444444444444444444444" as Address;
  const vaultBuy = (maker: NonNullable<RecordRow["vaultBuy"]>["maker"]) =>
    row({ kind: "vault-buy", planLabel: "Daily SPX", vaultBuy: { caller: KEEPER, rewardTo: KEEPER, dueSince: 900, maker } });

  it("says it in a few words for each maker, and nothing it can't tell", () => {
    expect(makerText(vaultBuy("owner"))).toBe("Made by you");
    expect(makerText(vaultBuy("returned"))).toBe("Made by someone else; the fee came back to you");
    expect(makerText(vaultBuy("community"))).toBe("Made by a community keeper");
    expect(makerText(vaultBuy("open"))).toBe("Made after the community window, when anyone could");
    expect(makerText(vaultBuy(null))).toBeNull();
    expect(makerText(row({}))).toBeNull();
    // A v1 buy (no rewardTo) gets no line: v2 is what asks who made a buy,
    // and a v1 log names only the caller — the batcher, for the owner's own
    // Help run batch, which "Made by a keeper" got wrong.
    const v1 = (maker: NonNullable<RecordRow["vaultBuy"]>["maker"]) =>
      row({ kind: "vault-buy", planLabel: "Daily SPX", vaultBuy: { caller: KEEPER, rewardTo: null, dueSince: null, maker } });
    expect(makerText(v1("caller"))).toBeNull();
    expect(makerText(v1("owner"))).toBeNull();
    expect(statementWhat(v1("caller"))).toBe("Vault buy · Daily SPX");
    // Paid work, and the fee is a fee: never the contract's word for it, never a rate of return.
    for (const maker of ["owner", "returned", "community", "open"] as const) {
      expect(makerText(vaultBuy(maker))).not.toMatch(/reward|APR|APY|yield|earn/i);
    }
  });

  it("adds it to the statement's What, after the plan", () => {
    expect(statementWhat(vaultBuy("community"))).toBe("Vault buy · Daily SPX · made by a community keeper");
    expect(statementWhat(vaultBuy(null))).toBe("Vault buy · Daily SPX");
    expect(statementWhat(row({}))).toBe("Swap");
    expect(statementWhat(row({ kind: "plan-buy", planLabel: "Weekly" }))).toBe("Plan buy · Weekly");
  });
});
