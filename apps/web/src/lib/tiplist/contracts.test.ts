/**
 * The contracts a tip is lost in, as the page actually uses them: the list
 * names the routers, the tokens and the vault contracts, and the Engine hands
 * it to TipGuard, so a transfer to one is refused there whatever the config
 * says. Deleting the Engine's `refuseRecipients` line fails the second case.
 * No network: every check here is refused by the Guard's static layer, before
 * anything would be test-run.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { recommendedConfig } from "@spdex/config";
import { CONTRACTS, TOKENS } from "@spdex/chain";
import type { SpdexConfig } from "@spdex/core";
import {
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  MAINNET_IMPLEMENTATION,
  MAINNET_REGISTRY,
  V1_MAINNET_BATCHER,
  V1_MAINNET_FACTORY,
  V1_MAINNET_IMPLEMENTATION,
} from "@spdex/vault";
import { Engine } from "../engine.js";
import { buildTipPlan } from "../tips.js";
import { KNOWN_CONTRACTS, knownContract, REFUSED_TIP_RECIPIENTS } from "./contracts.js";

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KNOWN_CONTRACTS", () => {
  it("names the tokens, the routers and the vault contracts", () => {
    expect(knownContract(TOKENS.SPX.address)).toBe("the SPX token contract");
    expect(knownContract(TOKENS.WETH.address.toUpperCase().replace("0X", "0x"))).toBe("the WETH token contract");
    expect(knownContract(CONTRACTS.uniV3SwapRouter02)).toBe("a Uniswap router");
    expect(knownContract(CONTRACTS.universalRouter)).toBe("a Uniswap router");
    expect(knownContract(MAINNET_FACTORY)).toBe("the vault factory");
    expect(knownContract(MAINNET_BATCHER)).toBe("the vault batcher");
    expect(knownContract(MAINNET_IMPLEMENTATION)).toBe("the vault contract");
    expect(knownContract(MAINNET_REGISTRY)).toBe("the SPX holder registry");
    expect(knownContract(V1_MAINNET_FACTORY)).toBe("the v1 vault factory");
    expect(knownContract(V1_MAINNET_BATCHER)).toBe("the v1 vault batcher");
    expect(knownContract(V1_MAINNET_IMPLEMENTATION)).toBe("the v1 vault contract");
    expect(REFUSED_TIP_RECIPIENTS).toHaveLength(KNOWN_CONTRACTS.size);
  });
});

describe("the Engine's TipGuard", () => {
  function engine(): Engine {
    const config: SpdexConfig = { ...recommendedConfig(), rpc: { url: "http://127.0.0.1:1/unused", source: "user" } };
    return new Engine(config);
  }

  it("refuses a tip to a router or another token's contract, as a known contract", async () => {
    // Nothing may reach a network: the refusal is static.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in a unit test");
    });
    for (const recipient of [CONTRACTS.uniV3SwapRouter02, TOKENS.WETH.address, MAINNET_FACTORY]) {
      const plan = buildTipPlan({
        chainId: 1,
        account: ACCOUNT,
        token: TOKENS.SPX.address,
        delivered: 10n ** 8n,
        transfers: [{ recipient, amount: 10n ** 5n, label: "someone" }],
      });
      const verdict = await engine().checkTips(plan);
      expect(verdict.level, recipient).toBe("rejected");
      expect(verdict.violations.map((v) => [v.code, v.detail?.["reason"]]), recipient).toContainEqual(["TIP_MALFORMED", "known-contract"]);
    }
  });

  it("refuses a tip to the token's own contract on its own", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in a unit test");
    });
    const plan = buildTipPlan({
      chainId: 1,
      account: ACCOUNT,
      token: TOKENS.SPX.address,
      delivered: 10n ** 8n,
      transfers: [{ recipient: TOKENS.SPX.address, amount: 10n ** 5n, label: "SPX" }],
    });
    const verdict = await engine().checkTips(plan);
    expect(verdict.violations.map((v) => v.detail?.["reason"])).toContain("token-contract");
  });
});

describe("the shipped tip lists", () => {
  it("are read while tips are off only when asked to be, and hold no known contract", async () => {
    const off: SpdexConfig = { ...recommendedConfig(), chainId: 690069, rpc: { url: "http://127.0.0.1:1/unused", source: "user" } };
    const reader = new Engine(off);
    // Tips are off in the recommended config: the switch says the list is off.
    expect(await reader.tipCandidates(off.modules)).toEqual([]);
    // Asked to read it anyway (the page's checks do): the fork's test entries.
    const read = await reader.tipCandidates(off.modules, { evenIfOff: true });
    expect(read.length).toBeGreaterThan(0);
    for (const entry of read) expect(knownContract(entry.address), entry.address).toBeNull();
    // On Ethereum, only the real list, which holds no contract either.
    const mainnet = await new Engine({ ...off, chainId: 1 }).tipCandidates(off.modules, { evenIfOff: true });
    for (const entry of mainnet) expect(knownContract(entry.address), entry.address).toBeNull();
  });
});
