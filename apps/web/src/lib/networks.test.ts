/**
 * Network names.
 *
 * The labels keep the chain number because two e2e assertions read it: the
 * wrong-network banner must still say "chain 1" for a wallet on mainnet, and a
 * network nobody named must still be identifiable by the number a wallet shows.
 */

import { describe, expect, it } from "vitest";
import { isNamedNetwork, networkLabel, networkName } from "./networks.js";

describe("networkName", () => {
  it("names the networks spDEX is built against", () => {
    expect(networkName(1)).toBe("Ethereum");
    expect(networkName(11155111)).toBe("Sepolia test network");
    expect(networkName(690069)).toBe("Local fork");
    expect(networkName(31337)).toBe("Local test network");
  });

  it("calls anything else by its number", () => {
    expect(networkName(8453)).toBe("Chain 8453");
    expect(isNamedNetwork(8453)).toBe(false);
  });
});

describe("networkLabel", () => {
  it("keeps the number beside the name", () => {
    expect(networkLabel(1)).toBe("Ethereum (chain 1)");
    expect(networkLabel(1)).toContain("chain 1");
    expect(networkLabel(690069)).toBe("Local fork (chain 690069)");
  });

  it("is just the number when there is no name", () => {
    expect(networkLabel(8453)).toBe("chain 8453");
  });

  it("does not mistake inherited properties for names", () => {
    // `constructor` is on every object's prototype; a lookup that used `in`
    // would call chain "constructor" a named network.
    expect(isNamedNetwork(Number("constructor"))).toBe(false);
  });
});
