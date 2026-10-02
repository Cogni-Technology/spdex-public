import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TOKENS } from "@spdex/chain";
import { ContractBadge } from "../../components/culture/ContractBadge.js";
import { SPX_CONTRACT, SPX_CONTRACT_SOURCES, checksumAddress, hexGroups } from "./contract.js";

const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

describe("checksumAddress (EIP-55)", () => {
  // The EIP's own examples: all caps, all lower, and mixed.
  const EIP_55 = [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it.each(EIP_55)("writes %s as the EIP does, from any case", (expected) => {
    expect(checksumAddress(expected.toLowerCase())).toBe(expected);
    expect(checksumAddress(expected.toUpperCase().replace("0X", "0x"))).toBe(expected);
  });

  it("refuses what isn't an address, and writes a wrongly cased one in its checksummed form", () => {
    expect(() => checksumAddress("0x1234")).toThrow(/not an address/);
    expect(() => checksumAddress("E0f63A424a4439cBE457D80E4f4b51aD25b2c56C")).toThrow(/not an address/);
    expect(checksumAddress("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).not.toBe("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  });
});

describe("SPX6900's address", () => {
  it("is TOKENS.SPX's, checksummed, and is the text CoinMarketCap prints, case for case", () => {
    expect(SPX_CONTRACT).toBe(checksumAddress(TOKENS.SPX.address));
    expect(SPX_CONTRACT.toLowerCase()).toBe(TOKENS.SPX.address.toLowerCase());
    // As CoinMarketCap's page shows it: an independent check that the casing is right.
    expect(SPX_CONTRACT).toBe("0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C");
  });

  it("is grouped in fours for reading", () => {
    expect(hexGroups(SPX_CONTRACT)).toEqual(["0xE0f6", "3A42", "4a44", "39cB", "E457", "D80E", "4f4b", "51aD", "25b2", "c56C"]);
    expect(hexGroups(SPX_CONTRACT).join("")).toBe(SPX_CONTRACT);
  });

  it("the badge's text holds the whole checksummed address, case for case, and no spaced copy of it", () => {
    const html = renderToStaticMarkup(createElement(ContractBadge));
    const text = textOf(html);
    expect(text).toContain(SPX_CONTRACT);
    expect(text).toContain("SPX6900 on Ethereum is");
    expect(text).toContain("A token with the same name at any other address is not it.");
    expect(text).not.toMatch(/official/i);
  });

  it("links the listings, and only as links", () => {
    expect(SPX_CONTRACT_SOURCES.map((s) => s.name)).toEqual(["spx6900.com", "CoinGecko", "CoinMarketCap", "Etherscan"]);
    for (const source of SPX_CONTRACT_SOURCES) expect(source.url).toMatch(/^https:\/\//);
    const html = renderToStaticMarkup(createElement(ContractBadge));
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(SPX_CONTRACT_SOURCES.length);
    for (const link of links) expect(link).toContain('rel="noreferrer noopener"');
  });
});
