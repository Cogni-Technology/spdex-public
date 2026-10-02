/**
 * The trade summary's figures and the shared-config summary.
 *
 * The rate is checked on the pair spDEX exists for (SPX has 8 decimals, ETH
 * 18), where a decimals mix-up is off by ten orders of magnitude and still
 * looks like a number. The staged summary is checked for what it must say —
 * auto-buys arrive paused and count from zero — and for staying silent when
 * nothing that moves money changed.
 */

import { describe, expect, it } from "vitest";
import { recommendedConfig, setFeature, TIP_FEATURE_ID, TIPLIST_MODULE_ID } from "@spdex/config";
import type { DcaPlan, SpdexConfig } from "@spdex/core";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import {
  confirmCountText,
  formatRate,
  highFeeNote,
  marketsLabel,
  maxConfirmations,
  networkFeeText,
  quotingKey,
  rateLine,
  safetyTestFrom,
  safetyTestText,
  secondOpinionStripText,
  stagedSummary,
  swapNetworkFee,
} from "./summary.js";
import type { MoneyView } from "./money/convert.js";

const ETH = { symbol: "ETH", decimals: 18 };
const SPX = { symbol: "SPX", decimals: 8 };

describe("rate", () => {
  it("accounts for each side's decimals", () => {
    // 0.25 ETH for 326.96 SPX is 1,307.84 SPX per ETH.
    expect(rateLine(ETH, SPX, 25n * 10n ** 16n, 32_696_000_000n)).toBe("1 ETH = 1,307.84 SPX");
  });

  it("keeps the digits of a rate below one", () => {
    expect(formatRate(1_000n * 10n ** 8n, 8, 764n * 10n ** 15n, 18)).toBe("0.000764");
  });

  it("has no rate for nothing in", () => {
    expect(formatRate(0n, 18, 5n, 8)).toBeNull();
    expect(rateLine(ETH, SPX, 0n, 5n)).toBeNull();
  });
});

describe("confirmations", () => {
  const leg = (approvals: number) => ({ plan: { approvals: Array.from({ length: approvals }, () => ({})) } });

  it("counts each approval and each swap, then each tip", () => {
    expect(maxConfirmations([leg(0)], 0)).toBe(1);
    expect(maxConfirmations([leg(1)], 0)).toBe(2);
    expect(maxConfirmations([leg(1), leg(1)], 2)).toBe(6);
  });

  it("says 'once' only for one", () => {
    expect(confirmCountText(1)).toBe("will ask you to confirm once");
    expect(confirmCountText(2)).toBe("will ask you to confirm up to 2 times");
  });

  it("prices a swap's network fee from its venues' gas, and a typical permission for each one declared", () => {
    const gwei = 10n ** 9n;
    expect(swapNetworkFee([leg(0)], 150_000n, gwei)).toEqual({ wei: 150_000n * gwei, upTo: false });
    expect(swapNetworkFee([leg(1), leg(1)], 300_000n, gwei)).toEqual({ wei: 400_000n * gwei, upTo: true });
    // Ether alone without a rate, dollars first with one; "up to" when a permission may already exist.
    expect(networkFeeText({ wei: 150_000n * gwei, upTo: false }, undefined)).toBe("≈ 0.00015 ETH");
    const dollars: MoneyView = { usd: new Map([[TOKENS.WETH.address.toLowerCase(), 2_643_940_000n]]), fx: null, currency: "USD", locale: "en-US" };
    expect(networkFeeText({ wei: 150_000n * gwei, upTo: true }, dollars)).toBe("up to ≈\u00a0$0.40 (0.00015 ETH)");
  });

  it("counts markets", () => {
    expect(marketsLabel(1)).toBe("1 market");
    expect(marketsLabel(3)).toBe("3 markets");
  });
});

function plan(id: string): DcaPlan {
  return {
    id,
    chainId: 1,
    sell: NATIVE_TOKEN,
    buy: TOKENS.SPX.address,
    amountPerBuy: "10000000000000000",
    intervalSeconds: 86_400,
    maxBuys: 10,
    startAt: 1_700_000_000,
    signer: "wallet",
    paused: true,
  } as DcaPlan;
}

const withPlans = (config: SpdexConfig, ...ids: string[]): SpdexConfig => ({
  ...config,
  dca: { enabled: ids.length > 0, plans: ids.map(plan) },
});

describe("stagedSummary", () => {
  const base: SpdexConfig = { ...recommendedConfig(), rpc: { url: "http://127.0.0.1:8545", source: "user" } };

  it("says nothing when nothing that moves money changed", () => {
    expect(stagedSummary(base, base)).toEqual([]);
    expect(stagedSummary(base, { ...base, router: { ...base.router, maxSplits: 2 } })).toEqual([]);
  });

  it("names a new network service", () => {
    expect(stagedSummary(base, { ...base, rpc: { url: "https://evil.example", source: "user" } })).toEqual([
      "Changes your network service to https://evil.example",
    ]);
  });

  it("names an allowlist", () => {
    const staged: SpdexConfig = {
      ...base,
      pools: { mode: "allowlist", allow: [{ venueId: "venue-uniswap-v2", poolId: "0xabc" }], deny: [] },
    };
    expect(stagedSummary(base, staged)).toEqual(["Limits swaps to 1 market"]);
  });

  it("names tips as a share and a count", () => {
    const staged: SpdexConfig = {
      ...base,
      tips: {
        ...base.tips,
        enabled: true,
        recipients: [
          { address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", label: "a", source: "x", bps: 25 },
          { address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", label: "b", source: "x", bps: 25 },
        ],
      },
    };
    expect(stagedSummary(base, staged)).toEqual(["Tips 0.5% of each swap to 2 addresses"]);
  });

  it("says auto-buys arrive paused and count from zero", () => {
    const [line] = stagedSummary(base, withPlans(base, "dca-aaaa1111"));
    expect(line).toContain("Adds 1 auto-buy.");
    expect(line).toContain("arrive paused");
    expect(line).toContain("counts each from zero");
  });

  it("counts auto-buys a link would remove", () => {
    expect(stagedSummary(withPlans(base, "dca-a", "dca-b"), withPlans(base, "dca-b"))).toEqual([
      "Removes 1 auto-buy you have",
    ]);
  });

  /**
   * A vault plan is none of "arrives paused", "resume" or "counts from zero":
   * its vault buys on chain and keeps its own count. And a link that drops
   * one, or points it elsewhere, is told it won't: its plan is the only way
   * back to the vault.
   */
  it("says vault plans apart: added, left out, or pointed at another vault", () => {
    const VAULT = "0x00000000000000000000000000000000000000aa";
    const vaultPlan = (id: string, vault?: string): DcaPlan =>
      ({ ...plan(id), signer: "vault", paused: true, ...(vault === undefined ? {} : { vault }) }) as DcaPlan;
    const withVault = (...plans: DcaPlan[]): SpdexConfig => ({ ...base, dca: { enabled: false, plans } });

    const added = stagedSummary(base, withVault(vaultPlan("dca-v", VAULT)));
    expect(added).toEqual([expect.stringMatching(/^Adds 1 vault plan\. A vault buys on chain/)]);
    expect(added[0]).not.toMatch(/arrive paused|counts each from zero/);

    const left = stagedSummary(withVault(vaultPlan("dca-v", VAULT)), base);
    expect(left).toEqual([expect.stringMatching(/^Leaves out 1 of your vault plans\. spDEX keeps any whose vault may still hold money/)]);

    const elsewhere = stagedSummary(withVault(vaultPlan("dca-v", VAULT)), withVault(vaultPlan("dca-v", "0x00000000000000000000000000000000000000bb")));
    expect(elsewhere).toEqual([expect.stringMatching(/^Points 1 of your vault plans at another vault, or at none\. spDEX keeps the vault/)]);
    // Its own older copy, from before the vault existed, is the same case.
    expect(stagedSummary(withVault(vaultPlan("dca-v", VAULT)), withVault(vaultPlan("dca-v")))).toEqual(elsewhere);
    expect(stagedSummary(withVault(vaultPlan("dca-v", VAULT)), withVault(vaultPlan("dca-v", VAULT.toUpperCase().replace("0X", "0x"))))).toEqual([]);
  });

  it("names a plan kept under the same id with new terms, and your running plans it pauses", () => {
    const mine = withPlans(base, "dca-a", "dca-b");
    mine.dca.plans = mine.dca.plans.map((p) => ({ ...p, paused: false }));
    // Your own link applied back: every plan arrives paused, nothing else changed.
    const own = { ...mine, dca: { ...mine.dca, plans: mine.dca.plans.map((p) => ({ ...p, paused: true })) } };
    expect(stagedSummary(mine, own)).toEqual(["Pauses 2 of your running auto-buys until you resume them"]);
    // A hostile one raises the amount under the same id.
    const raised = { ...own, dca: { ...own.dca, plans: own.dca.plans.map((p) => (p.id === "dca-a" ? { ...p, amountPerBuy: "990000000000000000" } : p)) } };
    const lines = stagedSummary(mine, raised);
    expect(lines).toContainEqual(expect.stringMatching(/^Changes the terms of 1 auto-buy you have/));
    expect(lines).toContain("Pauses 2 of your running auto-buys until you resume them");
  });

  it("names what weakens the checks: tolerance, trusted contracts, the safety test, the price warning", () => {
    const staged: SpdexConfig = {
      ...base,
      slippageBps: 5_000,
      extraTrustedContracts: ["0x000000000000000000000000000000000000dead"],
      guard: { ...base.guard, requireSimulation: false, oracleDivergenceBps: base.guard.oracleDivergenceBps + 1_000 },
    };
    const lines = stagedSummary({ ...base, guard: { ...base.guard, requireSimulation: true } }, staged);
    expect(lines).toContain(`Raises your price tolerance from ${base.slippageBps / 100}% to 50%`);
    expect(lines).toContain("Trusts 1 more contract that the safety check would otherwise flag");
    expect(lines).toContain("Lets you sign swaps the safety test couldn't run on");
    expect(lines).toContainEqual(expect.stringMatching(/^Warns about a price far from the 10-minute average only past/));
  });

  it("names a different way of sending, and plug-ins from outside spDEX", () => {
    const relay: SpdexConfig = { ...base, submitter: { mode: "private", url: "https://relay.example/rpc" } };
    expect(stagedSummary(base, relay)).toEqual(["Sends your transactions privately through https://relay.example/rpc"]);
    expect(stagedSummary(relay, base)).toEqual(["Turns private sending off: transactions go to the public queue"]);
    const plugin: SpdexConfig = {
      ...base,
      modules: [...base.modules, { id: "venue-stranger", version: "1.0.0", source: "url", location: "https://x.example/m.js", enabled: true }],
    };
    expect(stagedSummary(base, plugin)).toEqual(["Adds 1 plug-in from outside spDEX"]);
  });

  it("names a second opinion arriving, changing or going", () => {
    const withSecond = (url: string | null): SpdexConfig => ({ ...base, guard: { ...base.guard, secondOpinion: { url } } });
    expect(stagedSummary(base, withSecond("https://second.example/rpc"))).toEqual([
      "Also test-runs every transaction on https://second.example/rpc, which will see what you're about to sign",
    ]);
    expect(stagedSummary(withSecond("https://second.example/rpc"), withSecond("https://third.example/rpc"))).toEqual([
      "Also test-runs every transaction on https://third.example/rpc, which will see what you're about to sign",
    ]);
    expect(stagedSummary(withSecond("https://second.example/rpc"), base)).toEqual([
      "Turns off your second opinion: transactions are test-run on one service only",
    ]);
    expect(stagedSummary(withSecond("https://second.example/rpc"), withSecond("https://second.example/rpc"))).toEqual([]);
  });
});

describe("quotingKey", () => {
  it("ignores auto-buy plans and the preset marker, and nothing else", () => {
    const base = recommendedConfig();
    expect(quotingKey(withPlans(base, "dca-a"))).toBe(quotingKey({ ...base, preset: "custom" }));
    expect(quotingKey({ ...base, slippageBps: 99 })).not.toBe(quotingKey(base));
    // A second opinion changes what checks every quote, so it rebuilds the Engine.
    expect(quotingKey({ ...base, guard: { ...base.guard, secondOpinion: { url: "https://second.example/rpc" } } })).not.toBe(
      quotingKey(base),
    );
  });

  it("ignores tips and the tip registry, which no quote reads", () => {
    const base = recommendedConfig();
    const tipping = setFeature(
      {
        ...base,
        tips: {
          enabled: false,
          recipients: [{ address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", label: "someone", bps: 25 }],
        },
      },
      TIP_FEATURE_ID,
      true,
    );
    expect(tipping.modules.find((module) => module.id === TIPLIST_MODULE_ID)?.enabled).toBe(true);
    expect(quotingKey(tipping)).toBe(quotingKey(base));
    // A venue is still a venue: switching one off must still re-quote.
    expect(quotingKey(setFeature(base, "venue-uniswap-v3", false))).not.toBe(quotingKey(base));
  });
});

describe("second opinion in the strip", () => {
  const on = (last: "agrees" | "disagrees" | "unavailable" | null) =>
    ({ kind: "on", host: "second.example", last, sameOperator: null }) as const;

  it("says two services only while the main one can test-run and the last check heard both", () => {
    // Nothing has been checked yet, so it doesn't claim anything was.
    expect(secondOpinionStripText(on(null), "available")).toBe("checks on 2 services");
    expect(secondOpinionStripText(on("agrees"), "available")).toBe("checked on 2 services");
    expect(secondOpinionStripText(on("unavailable"), "available")).toBe("second opinion not answering");
    expect(secondOpinionStripText(on("agrees"), "unavailable")).toBeNull();
    expect(secondOpinionStripText(on("agrees"), "checking")).toBeNull();
  });

  it("says nothing without one, and says a copy of the main service doesn't count", () => {
    expect(secondOpinionStripText({ kind: "off" }, "available")).toBeNull();
    expect(secondOpinionStripText({ kind: "same" }, "available")).toBe("second opinion is your main service, so it doesn't count");
  });
});

describe("safety test", () => {
  it("says yes only for a definite yes", () => {
    expect(safetyTestText(safetyTestFrom(true))).toBe("available");
    expect(safetyTestText(safetyTestFrom(false))).toBe("not available on this service");
    expect(safetyTestText(safetyTestFrom("unknown"))).toBe("couldn't tell");
    expect(safetyTestText("checking")).toBe("checking…");
  });
});

describe("highFeeNote", () => {
  const ETH = 10n ** 18n;
  const GWEI = 10n ** 9n;
  // A $6.90 buy at about $2,700 an ether.
  const swapWei = 2_560_000_000_000_000n;

  it("says nothing at quiet fees: 1% of a $6.90 buy is what such a buy costs", () => {
    expect(highFeeNote({ feeWei: 25_000_000_000_000n, swapWei, level: { base: GWEI / 10n, usual: GWEI / 10n } })).toBeNull();
  });

  it("says the share when the fee is 3% of the swap or more", () => {
    // MetaMask's $0.87 on the $6.90 buy of 2026-10-01.
    expect(highFeeNote({ feeWei: 300_000_000_000_000n, swapWei, level: null })).toBe(
      "Network fees are high right now: 12% of this swap. If it can wait, try later.",
    );
    expect(highFeeNote({ feeWei: (swapWei * 34n) / 1_000n, swapWei, level: null })).toBe(
      "Network fees are high right now: 3.4% of this swap. If it can wait, try later.",
    );
    expect(highFeeNote({ feeWei: (swapWei * 29n) / 1_000n, swapWei, level: null })).toBeNull();
  });

  it("says a spike when the base fee is 3× its usual, whatever the swap's size", () => {
    expect(highFeeNote({ feeWei: ETH / 10_000n, swapWei: ETH, level: { base: 8n * GWEI, usual: 2n * GWEI } })).toBe(
      "Network fees are high right now: 4× the last few hours. If it can wait, try later.",
    );
    expect(highFeeNote({ feeWei: ETH / 10_000n, swapWei: ETH, level: { base: 29n * GWEI, usual: 10n * GWEI } })).toBeNull();
  });

  it("says it of a buy, for an auto-buy's due buy", () => {
    expect(highFeeNote({ feeWei: 300_000_000_000_000n, swapWei, level: null, of: "buy" })).toBe(
      "Network fees are high right now: 12% of this buy. If it can wait, try later.",
    );
  });

  it("says both together, and nothing it can't work out", () => {
    expect(highFeeNote({ feeWei: 300_000_000_000_000n, swapWei, level: { base: 6n * GWEI, usual: 2n * GWEI } })).toBe(
      "Network fees are high right now: 12% of this swap, 3× the last few hours. If it can wait, try later.",
    );
    // No ether side to compare with, no fee level read, or a usual of zero: no claim.
    expect(highFeeNote({ feeWei: ETH, swapWei: null, level: null })).toBeNull();
    expect(highFeeNote({ feeWei: ETH, swapWei: null, level: { base: GWEI, usual: 0n } })).toBeNull();
  });
});
