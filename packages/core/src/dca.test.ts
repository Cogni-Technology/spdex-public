import { describe, expect, it } from "vitest";
import {
  DCA_SIGNERS,
  DcaPlanSchema,
  DcaPolicySchema,
  MAX_DCA_PLANS,
  MIN_DCA_INTERVAL_SECONDS,
  planBudget,
  slotAt,
  slotOpensAt,
  type DcaPlan,
} from "./dca.js";
import { scheduleRequest, vetScheduleDecision, type WireScheduleDecision } from "./scheduler.js";

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const DAY = 86_400;

const plan: DcaPlan = {
  id: "dca-0a1b2c3d",
  paused: false,
  chainId: 1,
  sell: ETH,
  buy: SPX,
  amountPerBuy: "10000000000000000",
  intervalSeconds: DAY,
  maxBuys: 10,
  startAt: 1_790_000_000,
  signer: "wallet",
};

describe("DcaPlanSchema", () => {
  it("parses a plan and lowercases its token addresses", () => {
    const parsed = DcaPlanSchema.parse({ ...plan, buy: SPX.toUpperCase().replace("0X", "0x") });
    expect(parsed.buy).toBe(SPX);
  });

  it("refuses amounts that are not positive whole base units", () => {
    // A number would export to TOML as a float at 1e18; a zero or fractional
    // string is not an amount anyone meant.
    for (const amountPerBuy of ["0", "1.5", "-1", "01", ""]) {
      expect(() => DcaPlanSchema.parse({ ...plan, amountPerBuy })).toThrow();
    }
    expect(() => DcaPlanSchema.parse({ ...plan, amountPerBuy: 1 })).toThrow();
  });

  it("refuses an interval below the constant floor, whatever the file said", () => {
    expect(() =>
      DcaPlanSchema.parse({ ...plan, intervalSeconds: MIN_DCA_INTERVAL_SECONDS - 1 }),
    ).toThrow();
    expect(DcaPlanSchema.parse({ ...plan, intervalSeconds: MIN_DCA_INTERVAL_SECONDS }).intervalSeconds).toBe(
      MIN_DCA_INTERVAL_SECONDS,
    );
  });

  it("refuses a plan with no end, and one that buys what it sells", () => {
    expect(() => DcaPlanSchema.parse({ ...plan, maxBuys: 0 })).toThrow();
    expect(() => DcaPlanSchema.parse({ ...plan, buy: ETH })).toThrow();
  });
});

describe("DcaPlanSchema, for a vault plan", () => {
  const VAULT = "0x6de035555360a81c068559954bd7ee97cde8e201";
  const vaultPlan: DcaPlan = { ...plan, signer: "vault", paused: true };

  it("parses one before its vault exists and after, lowercasing the vault's address", () => {
    expect(DcaPlanSchema.parse(vaultPlan)).toEqual(vaultPlan);
    const created = DcaPlanSchema.parse({ ...vaultPlan, vault: VAULT.toUpperCase().replace("0X", "0x") });
    expect(created.vault).toBe(VAULT);
  });

  it("refuses one that is not paused, since this tab never runs it", () => {
    // `false` would claim a runner that does not exist; the vault runs itself.
    const error = DcaPlanSchema.safeParse({ ...vaultPlan, paused: false }).error;
    expect(error?.issues.map((issue) => issue.path)).toEqual([["paused"]]);
  });

  it("refuses one that sells anything but ether", () => {
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const error = DcaPlanSchema.safeParse({ ...vaultPlan, sell: usdc }).error;
    expect(error?.issues.map((issue) => issue.path)).toEqual([["sell"]]);
  });

  it("refuses a vault on any other plan, and the zero address as a vault", () => {
    expect(() => DcaPlanSchema.parse({ ...plan, vault: VAULT })).toThrow(/only a vault plan has a vault/);
    expect(() => DcaPlanSchema.parse({ ...vaultPlan, vault: `0x${"0".repeat(40)}` })).toThrow(/zero address/);
    expect(() => DcaPlanSchema.parse({ ...vaultPlan, vault: "0x1234" })).toThrow();
  });

  it("leaves a wallet plan exactly as it was, paused or not", () => {
    for (const paused of [true, false]) {
      expect(DcaPlanSchema.parse({ ...plan, signer: "wallet", paused })).toEqual({ ...plan, signer: "wallet", paused });
    }
  });
});

describe("DcaPlanSchema, for a signer that no longer exists", () => {
  it("knows two signers: the owner's wallet, and a vault", () => {
    expect(DCA_SIGNERS).toEqual(["wallet", "vault"]);
  });

  it("refuses an autopilot plan: version 8 migrates one into a paused wallet plan before it gets here", () => {
    // A current config naming it is not one this build wrote. Reading it as a
    // wallet plan would start one nobody chose; the migration does that on
    // purpose, paused, for a config that says it is older (@spdex/config).
    const error = DcaPlanSchema.safeParse({ ...plan, signer: "autopilot", paused: true }).error;
    expect(error?.issues.map((issue) => issue.path)).toEqual([["signer"]]);
  });
});

describe("DcaPolicySchema", () => {
  it("refuses duplicate ids and more plans than anyone can supervise", () => {
    expect(() => DcaPolicySchema.parse({ enabled: true, plans: [plan, plan] })).toThrow();
    const many = Array.from({ length: MAX_DCA_PLANS + 1 }, (_, i) => ({ ...plan, id: `dca-${i}` }));
    expect(() => DcaPolicySchema.parse({ enabled: true, plans: many })).toThrow();
  });
});

describe("plan arithmetic", () => {
  it("knows the most a plan can ever spend before it starts", () => {
    expect(planBudget(plan)).toBe(10n ** 17n);
  });

  it("divides time into windows from the start, and has none before it", () => {
    const start = BigInt(plan.startAt);
    expect(slotAt(plan, start - 1n)).toBeNull();
    expect(slotAt(plan, start)).toBe(0);
    expect(slotAt(plan, start + BigInt(DAY) - 1n)).toBe(0);
    expect(slotAt(plan, start + BigInt(DAY))).toBe(1);
    expect(slotOpensAt(plan, 3)).toBe(start + 3n * BigInt(DAY));
  });
});

describe("vetScheduleDecision", () => {
  const now = BigInt(plan.startAt) + 2n * BigInt(DAY) + 5n; // window 2
  const request = scheduleRequest([plan], [{ planId: plan.id, buysDone: 2, lastSlot: 1 }], now);
  const due = (overrides: Partial<WireScheduleDecision["due"][number]> = {}) => ({
    due: [{ planId: plan.id, slot: 2, amountIn: plan.amountPerBuy, ...overrides }],
    next: [],
  });

  it("accepts one full-size buy for the window open now", () => {
    expect(vetScheduleDecision(request, due()).accepted).toHaveLength(1);
  });

  it("accepts a smaller buy — a scheduler may spend less, never more", () => {
    expect(vetScheduleDecision(request, due({ amountIn: "1" })).accepted).toHaveLength(1);
  });

  it("refuses anything outside the plan", () => {
    const cases = [
      due({ amountIn: "10000000000000001" }), // oversized
      due({ amountIn: "0" }), // empty
      due({ slot: 1 }), // a window that already had its buy
      due({ slot: 3 }), // a window not open yet
      due({ planId: "dca-unknown" }), // a plan that does not exist
    ];
    for (const decision of cases) {
      const { accepted, refused } = vetScheduleDecision(request, decision);
      expect(accepted).toHaveLength(0);
      expect(refused).toHaveLength(1);
    }
  });

  it("takes one buy per plan per answer, however many are proposed", () => {
    const doubled = { due: [...due().due, ...due().due], next: [] };
    const { accepted, refused } = vetScheduleDecision(request, doubled);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });

  it("refuses a buy once the plan has used all of them", () => {
    const finished = scheduleRequest([plan], [{ planId: plan.id, buysDone: 10, lastSlot: 1 }], now);
    expect(vetScheduleDecision(finished, due()).accepted).toHaveLength(0);
  });
});
