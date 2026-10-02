/**
 * The public development accounts: their shape and the networks they are
 * allowed on. That they are exactly the accounts the test mnemonic derives is
 * checked in `packages/chain/src/devAccounts.test.ts`, where viem is at hand.
 */

import { describe, expect, it } from "vitest";
import { isPlaceholderChain, isPublicDevAccount, PLACEHOLDER_CHAINS, PUBLIC_DEV_ACCOUNTS } from "./devAccounts.js";

describe("PUBLIC_DEV_ACCOUNTS", () => {
  it("holds twenty distinct lowercase addresses", () => {
    expect(PUBLIC_DEV_ACCOUNTS).toHaveLength(20);
    expect(new Set(PUBLIC_DEV_ACCOUNTS).size).toBe(20);
    for (const address of PUBLIC_DEV_ACCOUNTS) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("matches in any casing, and nothing else", () => {
    expect(isPublicDevAccount("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe(true);
    expect(isPublicDevAccount(PUBLIC_DEV_ACCOUNTS[19]!.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isPublicDevAccount("0x1111111111111111111111111111111111111111")).toBe(false);
  });
});

describe("PLACEHOLDER_CHAINS", () => {
  it("is the local fork and a local test network, never Ethereum", () => {
    expect([...PLACEHOLDER_CHAINS].sort()).toEqual([31337, 690069]);
    expect(isPlaceholderChain(1)).toBe(false);
    expect(isPlaceholderChain(690069)).toBe(true);
  });
});
