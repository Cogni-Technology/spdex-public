/**
 * `Engine.quoteScheduled`, against the fork: the one path that quotes a buy
 * made because a plan said so, rather than at the swap button.
 *
 * The runner's unit tests replace this method with a script, so they cannot
 * show what it actually builds. This does, with the real routing, the real
 * `ScheduledBuyGuard` and a real simulation: a buy large enough that a manual
 * swap splits it is still routed through one market; every intent is for the
 * plan's owner, who signs it, and delivers to them; the slippage floor is
 * capped whatever the setting; and a record at its budget is refused by the
 * scheduled Guard, the same verdict on every leg — which a quote checked by
 * the plain Guard would pass.
 *
 * Every address is fresh (see packages/chain/test/integration/local-key.test.ts
 * for why never a dev account). Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS, addressOfKey, generateSpendingKey, httpRpc } from "@spdex/chain";
import { addDcaPlan, recommendedConfig } from "@spdex/config";
import { slotAt, type DcaPlan, type DcaProgress, type SpdexConfig } from "@spdex/core";
import { Engine, MAX_SCHEDULED_SLIPPAGE_BPS, type QuoteResult } from "../../src/lib/engine.js";
import { TOKEN_LIST, type TokenInfo } from "../../src/lib/tokens.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
/**
 * Large against ETH/USDC's v3 pools, so a manual swap allowed four splits does
 * split it (two ways, at the pinned block). SPX's liquidity sits almost all in
 * one v2 pair, where nothing splits.
 */
const AMOUNT = 100n * ETHER;

const token = (address: string): TokenInfo => TOKEN_LIST.find((t) => t.address.toLowerCase() === address.toLowerCase())!;
const ETH = token(NATIVE_TOKEN);
const USDC = token(TOKENS.USDC.address);

/** A plan the owner confirms: the owner's wallet signs each buy, and receives it. */
const owner = addressOfKey(generateSpendingKey());
const signer = owner;
const now = BigInt(Math.floor(Date.now() / 1000));

const plan: DcaPlan = {
  id: "fork-scheduled",
  paused: false,
  chainId: CHAIN_ID,
  sell: NATIVE_TOKEN,
  buy: TOKENS.USDC.address,
  amountPerBuy: AMOUNT.toString(),
  intervalSeconds: 3_600,
  maxBuys: 2,
  startAt: Number(now) - 60,
  signer: "wallet",
};
const slot = slotAt(plan, now)!;

function engine(overrides: Partial<SpdexConfig> = {}): Engine {
  const base: SpdexConfig = {
    ...recommendedConfig(),
    chainId: CHAIN_ID,
    rpc: { url: FORK_URL, source: "user" },
    // Split whenever splitting pays at all, so the manual quote shows it does.
    router: { ...recommendedConfig().router, maxSplits: 4, minSplitGainBps: 0 },
    ...overrides,
  };
  const added = addDcaPlan(base, plan);
  if (!added.ok) throw new Error(added.error);
  return new Engine(added.config);
}

const progress = (committed: bigint): DcaProgress => ({
  planId: plan.id,
  chainId: CHAIN_ID,
  owner,
  signer,
  buysDone: 0,
  committed,
  lastSlot: null,
});

describe("Engine.quoteScheduled on the fork", () => {
  beforeAll(async () => {
    // The owner's wallet holds the buy and gas for it. A fresh address, never a dev account.
    await rpc("anvil_setBalance", [owner, `0x${(1_000n * ETHER).toString(16)}`]);
  });

  it("routes one market whatever the Router allows, for the owner, delivering to them, checked as a scheduled buy", async () => {
    const e = engine();
    // The same trade as a manual swap, which may split four ways, does split.
    const manual = await e.quote({ tokenIn: ETH, tokenOut: USDC, amountIn: AMOUNT, account: signer });
    expect(manual.legs.length).toBeGreaterThan(1);

    const scheduled = await e.quoteScheduled({
      plan,
      progress: progress(0n),
      slot,
      amountIn: AMOUNT,
      tokenIn: ETH,
      tokenOut: USDC,
      nowSeconds: now,
    });
    expect(scheduled.legs).toHaveLength(1);
    expect(scheduled.previewOnly).toBe(false);
    for (const leg of scheduled.legs) {
      expect(leg.plan.intent.account).toBe(signer);
      expect(leg.plan.intent.recipient).toBe(owner);
      expect(leg.plan.intent.deadline).toBe(now + BigInt(recommendedConfig().deadlineSeconds));
      expect(leg.verdict).toEqual(scheduled.verdict);
    }
    expect(scheduled.verdict).toMatchObject({ level: "verified", signable: true, violations: [] });
  });

  it("caps the slippage floor of a scheduled buy, whatever the setting", async () => {
    const loose = engine({ slippageBps: 5_000 });
    const quote: QuoteResult = await loose.quoteScheduled({
      plan,
      progress: progress(0n),
      slot,
      amountIn: ETHER,
      tokenIn: ETH,
      tokenOut: USDC,
      nowSeconds: now,
    });
    expect(quote.legs.length).toBeGreaterThan(0);
    for (const leg of quote.legs) {
      expect(leg.plan.intent.minAmountOut).toBe((leg.amountOut * BigInt(10_000 - MAX_SCHEDULED_SLIPPAGE_BPS)) / 10_000n);
    }
    // A manual swap keeps the setting.
    const manual = await loose.quote({ tokenIn: ETH, tokenOut: USDC, amountIn: ETHER, account: signer });
    expect(manual.legs[0]!.plan.intent.minAmountOut * 10_000n).toBeLessThan(manual.legs[0]!.amountOut * 9_000n);
  });

  it("refuses a buy past the plan's budget — the scheduled Guard's verdict, on every leg", async () => {
    const atBudget = await engine().quoteScheduled({
      plan,
      progress: progress(BigInt(plan.amountPerBuy) * BigInt(plan.maxBuys)),
      slot,
      amountIn: AMOUNT,
      tokenIn: ETH,
      tokenOut: USDC,
      nowSeconds: now,
    });
    expect(atBudget.verdict.signable).toBe(false);
    expect(atBudget.verdict.violations.map((v) => v.code)).toContain("SCHEDULE_EXCEEDS_BUDGET");
    expect(atBudget.legs.length).toBeGreaterThan(0);
    for (const leg of atBudget.legs) expect(leg.verdict).toEqual(atBudget.verdict);
  });
});
