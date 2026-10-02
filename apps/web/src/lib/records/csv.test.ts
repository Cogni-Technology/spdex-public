import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { CSV_COLUMNS, csvCell, csvFileName, machineAmount, recordsCsv, utcDate } from "./csv.js";
import type { RecordRow } from "./types.js";

const ME = "0xab5801a7d398351b8be11c439e05c5b3259aec9b" as Address;
const SPX = TOKENS.SPX.address.toLowerCase() as Address;
const USDC = TOKENS.USDC.address.toLowerCase() as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const T = 1_758_145_763; // 2025-09-17T21:49:23Z

function row(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: "swap:1:x",
    kind: "swap",
    chainId: 1,
    account: ME,
    at: { unix: T, source: "block" },
    block: 26_000_000n,
    hashes: [hash(1), hash(2)],
    sold: { token: NATIVE_TOKEN, amount: 8_158_900_000_000_000n, measured: true },
    bought: { token: SPX, amount: 6_912_30000001n, measured: true },
    buyFee: 0n,
    networkFee: 123_456_789_000_000n,
    valueUsd: 20_000_000n,
    rates: {
      block: 26_000_000n,
      chainTime: T,
      rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: T - 60 } },
      usdc: null,
    },
    valueSource: "twap-seen",
    ...overrides,
  };
}

/** The file's lines as cells, for rows with no quoted commas. */
const cells = (text: string) => text.trimEnd().split("\r\n").map((line) => line.split(","));

describe("the CSV", () => {
  it("has the header, then a line per row, CRLF-ended", () => {
    const text = recordsCsv([row(), row()], "USD");
    expect(text.split("\r\n")[0]).toBe(CSV_COLUMNS.join(","));
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.split("\r\n")).toHaveLength(4);
  });

  it("writes every digit in machine format, whatever the page's number style", () => {
    const [, line] = cells(recordsCsv([row()], "USD"));
    const at = (column: (typeof CSV_COLUMNS)[number]) => line![CSV_COLUMNS.indexOf(column)];
    expect(at("date_utc")).toBe("2025-09-17T21:49:23Z");
    expect(at("date_source")).toBe("block");
    expect(at("account")).toBe("0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B");
    expect(at("sold_token")).toBe("ETH");
    expect(at("sold_amount")).toBe("0.0081589");
    expect(at("bought_token")).toBe("SPX");
    expect(at("bought_amount")).toBe("6912.30000001");
    expect(at("bought_measured")).toBe("true");
    expect(at("buy_fee_eth")).toBe("0");
    expect(at("network_fee_eth")).toBe("0.000123456789");
    expect(at("value_usd_at_time")).toBe("20");
    expect(at("value_source")).toBe("twap-seen");
    expect(at("tx_hash")).toBe(`${hash(1)} ${hash(2)}`);
    expect(at("block")).toBe("26000000");
  });

  it("gives the value in the currency chosen at export, from the row's own rates, and leaves it empty for dollars", () => {
    const at = (text: string, column: (typeof CSV_COLUMNS)[number]) => cells(text)[1]![CSV_COLUMNS.indexOf(column)];
    const eur = recordsCsv([row()], "EUR");
    expect(at(eur, "value_local_at_time")).toBe("17.420085");
    expect(at(eur, "local_currency")).toBe("EUR");
    const usd = recordsCsv([row()], "USD");
    expect(at(usd, "value_local_at_time")).toBe("");
    expect(at(usd, "local_currency")).toBe("");
    // A currency the row has no answer for is blank, not converted as dollars.
    expect(at(recordsCsv([row()], "GBP"), "value_local_at_time")).toBe("");
  });

  it("leaves every unknown blank, never 0", () => {
    const unknown = row({
      account: null,
      at: { unix: T, source: "device" },
      block: null,
      sold: { token: USDC, amount: null, measured: false },
      bought: { token: SPX, amount: null, measured: false },
      buyFee: null,
      networkFee: null,
      valueUsd: null,
      rates: null,
      valueSource: null,
    });
    const line = cells(recordsCsv([unknown], "EUR"))[1]!;
    const blank = ["account", "sold_amount", "bought_amount", "buy_fee_eth", "network_fee_eth", "value_usd_at_time", "value_local_at_time", "value_source", "block"];
    for (const column of blank) expect(line[CSV_COLUMNS.indexOf(column as (typeof CSV_COLUMNS)[number])], column).toBe("");
    expect(line[CSV_COLUMNS.indexOf("sold_measured")]).toBe("false");
    expect(line[CSV_COLUMNS.indexOf("date_source")]).toBe("device");
  });

  it("writes a tip's bought side blank, and a vault buy's exact 8-decimal SPX and fee", () => {
    const tip = cells(recordsCsv([row({ kind: "tip", sold: { token: SPX, amount: 1n, measured: true }, bought: { token: SPX, amount: 0n, measured: true } })], "USD"))[1]!;
    expect(tip.slice(CSV_COLUMNS.indexOf("sold_token"), CSV_COLUMNS.indexOf("buy_fee_eth"))).toEqual(["SPX", "0.00000001", "true", "", "", ""]);
    const vault = cells(recordsCsv([row({ kind: "vault-buy", buyFee: 36_000_000_000_000n, networkFee: 0n })], "USD"))[1]!;
    expect(vault[CSV_COLUMNS.indexOf("buy_fee_eth")]).toBe("0.000036");
    expect(vault[CSV_COLUMNS.indexOf("network_fee_eth")]).toBe("0");
  });

  it("writes buy fees received with no sold side and no value, as the statement shows them", () => {
    const WETH = TOKENS.WETH.address.toLowerCase() as Address;
    const fees = cells(
      recordsCsv(
        [
          row({
            kind: "buy-fees-earned",
            sold: { token: WETH, amount: 0n, measured: true },
            bought: { token: WETH, amount: 5n * 10n ** 14n, measured: true },
            valueUsd: null,
            rates: null,
            valueSource: null,
          }),
        ],
        "EUR",
      ),
    )[1]!;
    const at = (column: (typeof CSV_COLUMNS)[number]) => fees[CSV_COLUMNS.indexOf(column)];
    for (const column of ["sold_token", "sold_amount", "sold_measured", "value_usd_at_time", "value_local_at_time", "value_source"] as const) {
      expect(at(column), column).toBe("");
    }
    expect([at("bought_token"), at("bought_amount")]).toEqual(["WETH", "0.0005"]);
  });

  it("never lets a plan name run as a formula, and quotes what needs quoting", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r", "\n"]) expect(csvCell(`${lead}1+1`).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell("Daily, forever")).toBe('"Daily, forever"');
    expect(csvCell("line\r\nbreak")).toBe('"line\r\nbreak"');
    expect(csvCell("plain")).toBe("plain");
    const text = recordsCsv([row({ planLabel: "=cmd|' /C calc'!A0", planId: "p" })], "USD");
    expect(text).toContain(",'=cmd|' /C calc'!A0,");
  });

  it("names an unlisted token by its address and writes no amount for it", () => {
    const stranger = "0x9999999999999999999999999999999999999999" as Address;
    const line = cells(recordsCsv([row({ bought: { token: stranger, amount: 5n, measured: true } })], "USD"))[1]!;
    expect(line[CSV_COLUMNS.indexOf("bought_token")]).toBe(stranger);
    expect(line[CSV_COLUMNS.indexOf("bought_amount")]).toBe("");
  });

  it("names the file for the network, the wallet and the day", () => {
    expect(csvFileName(1, ME, new Date(2026, 8, 7))).toBe("spdex-activity-1-ab5801-2026-09-07.csv");
  });

  it("writes amounts exactly", () => {
    expect(machineAmount(0n, 18)).toBe("0");
    expect(machineAmount(10n ** 18n, 18)).toBe("1");
    expect(machineAmount(1n, 8)).toBe("0.00000001");
    expect(machineAmount(123_456_789n, 0)).toBe("123456789");
    expect(utcDate(0)).toBe("1970-01-01T00:00:00Z");
  });
});
