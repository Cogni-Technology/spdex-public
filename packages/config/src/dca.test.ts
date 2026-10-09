import { describe, expect, it } from "vitest";
import { MAX_DCA_PLANS, SpdexConfigSchema, type DcaPlan, type SpdexConfig } from "@spdex/core";
import { recommendedConfig } from "./presets.js";
import { migrateConfig } from "./migrate.js";
import { exportJson } from "./io.js";
import { DCA_FEATURE_ID, SCHEDULER_MODULE_ID, featureById, setFeature } from "./features.js";
import { addDcaPlan, removeDcaPlan, updateDcaPlan, type DcaEdit, type DcaPlanPatch } from "./dca.js";

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function plan(overrides: Partial<DcaPlan> = {}): DcaPlan {
  return {
    id: "dca-0a1b2c3d",
    paused: false,
    chainId: 1,
    sell: ETH,
    buy: SPX,
    amountPerBuy: "10000000000000000",
    intervalSeconds: 86_400,
    maxBuys: 30,
    startAt: 1_790_000_000,
    signer: "wallet",
    ...overrides,
  };
}

/** Auto-buy switched on through the feature, holding exactly these plans. */
function running(...plans: DcaPlan[]): SpdexConfig {
  const on = setFeature(recommendedConfig(), DCA_FEATURE_ID, true);
  return { ...on, dca: { ...on.dca, plans } };
}

function schedulerOn(config: SpdexConfig): boolean {
  return config.modules.some((m) => m.id === SCHEDULER_MODULE_ID && m.enabled);
}

/**
 * Freeze a config all the way down, so a helper that edited its input in place
 * would throw here (modules are strict mode) rather than pass by accident.
 */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

function accepted(edit: DcaEdit): SpdexConfig {
  if (!edit.ok) throw new Error(`expected the edit to be accepted: ${edit.error}`);
  return edit.config;
}

function refused(edit: DcaEdit): string {
  if (edit.ok) throw new Error("expected the edit to be refused");
  return edit.error;
}

describe("addDcaPlan", () => {
  it("adds the plan, switches auto-buy on and marks the config custom", () => {
    const next = accepted(addDcaPlan(frozen(recommendedConfig()), plan()));

    expect(next.dca.plans).toEqual([plan()]);
    expect(next.dca.enabled).toBe(true);
    expect(schedulerOn(next)).toBe(true);
    expect(featureById(DCA_FEATURE_ID)?.isEnabled(next)).toBe(true);
    expect(next.preset).toBe("custom");
  });

  it("writes what the schema returns, so the next load reads back the same config", () => {
    // A checksummed address and a field the schema does not know. Storing
    // either as given would make the first reload quietly rewrite the config.
    const checksummed = "0xE0f63A424a4439cBE457D80E4f4b51AD25b2c56C" as const;
    const given = { ...plan({ buy: checksummed }), note: "not a field" } as DcaPlan;

    const next = accepted(addDcaPlan(recommendedConfig(), given));
    expect(next.dca.plans[0]).toEqual(plan({ buy: SPX }));
    expect(SpdexConfigSchema.parse(next)).toEqual(next);
    expect(migrateConfig(JSON.parse(exportJson(next)))).toEqual(next);
  });

  it("drops an undefined label rather than storing the key", () => {
    const unlabelled = { ...plan(), label: undefined } as DcaPlan;
    const next = accepted(addDcaPlan(recommendedConfig(), unlabelled));
    expect(Object.keys(next.dca.plans[0] ?? {})).not.toContain("label");
  });

  it.each<[string, Partial<DcaPlan>, RegExp]>([
    ["a zero amount", { amountPerBuy: "0" }, /amountPerBuy/],
    ["a fractional amount", { amountPerBuy: "1.5" }, /amountPerBuy/],
    ["an interval under five minutes", { intervalSeconds: 60 }, /intervalSeconds/],
    ["no buys at all", { maxBuys: 0 }, /maxBuys/],
    ["more buys than a plan may make", { maxBuys: 1_001 }, /maxBuys/],
    ["a start time that is not a whole second", { startAt: 1.5 }, /startAt/],
    // `\bid:` rather than `id`, which "not valid" would satisfy on its own.
    ["an id that is not lowercase", { id: "Plan One" }, /\bid: /],
    ["a plan that buys what it sells", { buy: ETH }, /cannot buy the token it sells/],
  ])("refuses %s, and leaves the config as it was", (_, overrides, reason) => {
    // Refused, never clamped: a config the schema rejects would be replaced
    // by the preset on the next load, endpoint and all.
    const config = frozen(running(plan({ id: "dca-kept" })));
    const snapshot = structuredClone(config);

    const error = refused(addDcaPlan(config, plan(overrides)));
    expect(error).toMatch(reason);
    expect(config).toEqual(snapshot);
  });

  it("refuses a second plan with the same id", () => {
    // The id keys this browser's record of what a plan has bought; two plans
    // sharing one would share a budget.
    const config = running(plan());
    expect(refused(addDcaPlan(config, plan({ amountPerBuy: "1" })))).toMatch(/already a plan/);
  });

  it(`refuses a plan past the ${MAX_DCA_PLANS}-plan limit`, () => {
    const full = running(
      ...Array.from({ length: MAX_DCA_PLANS }, (_, i) => plan({ id: `dca-${i}` })),
    );
    expect(refused(addDcaPlan(full, plan({ id: "dca-one-more" })))).toMatch(/At most/);
  });

  it("does not restart plans the master switch had stopped", () => {
    // The switch is how every plan is stopped at once. Adding a plan turns it
    // back on, and must start only the plan being added.
    const stopped = setFeature(running(plan({ id: "dca-old" })), DCA_FEATURE_ID, false);

    const next = accepted(addDcaPlan(frozen(stopped), plan({ id: "dca-new" })));
    expect(next.dca.enabled).toBe(true);
    expect(schedulerOn(next)).toBe(true);
    expect(next.dca.plans).toEqual([
      plan({ id: "dca-old", paused: true }),
      plan({ id: "dca-new" }),
    ]);
  });

  it("leaves every other plan alone when auto-buy is already running", () => {
    const config = running(plan({ id: "dca-old" }), plan({ id: "dca-held", paused: true }));
    const next = accepted(addDcaPlan(config, plan({ id: "dca-new" })));
    expect(next.dca.plans).toEqual([...config.dca.plans, plan({ id: "dca-new" })]);
    expect(next.modules).toEqual(config.modules);
  });

  it("treats a switch left on without its module as off", () => {
    // Only a hand-edited config gets here: nothing was running, so enabling
    // the module must not start the plans it would otherwise pick up.
    const config = running(plan({ id: "dca-old" }));
    const moduleOff = {
      ...config,
      modules: config.modules.map((m) =>
        m.id === SCHEDULER_MODULE_ID ? { ...m, enabled: false } : m,
      ),
    };

    const next = accepted(addDcaPlan(moduleOff, plan({ id: "dca-new" })));
    expect(schedulerOn(next)).toBe(true);
    expect(next.dca.plans.map((p) => [p.id, p.paused])).toEqual([
      ["dca-old", true],
      ["dca-new", false],
    ]);
  });
});

describe("updateDcaPlan", () => {
  it("resumes a plan and marks the config custom, leaving the master switch alone", () => {
    // Switching auto-buy on here would also restart every other plan it had
    // stopped. The resumed plan waits for the switch instead.
    const off = {
      ...setFeature(running(plan({ paused: true })), DCA_FEATURE_ID, false),
      preset: "recommended" as const,
    };

    const next = accepted(updateDcaPlan(frozen(off), "dca-0a1b2c3d", { paused: false }));
    expect(next.dca.plans).toEqual([plan({ paused: false })]);
    expect(next.dca.enabled).toBe(false);
    expect(schedulerOn(next)).toBe(false);
    expect(next.preset).toBe("custom");
  });

  it("changes only the plan it names", () => {
    const usdc = { sell: USDC, amountPerBuy: "5000000" } as const;
    const config = running(plan({ id: "dca-a" }), plan({ id: "dca-b", ...usdc }));
    const next = accepted(updateDcaPlan(config, "dca-b", { label: "weekly USDC", maxBuys: 52 }));
    expect(next.dca.plans).toEqual([
      plan({ id: "dca-a" }),
      plan({ id: "dca-b", ...usdc, label: "weekly USDC", maxBuys: 52 }),
    ]);
  });

  it("clears a label set to undefined, removing the key", () => {
    const config = running(plan({ label: "old name" }));
    const next = accepted(updateDcaPlan(config, "dca-0a1b2c3d", { label: undefined }));
    expect(next.dca.plans).toEqual([plan()]);
    expect(Object.keys(next.dca.plans[0] ?? {})).not.toContain("label");
  });

  it("refuses an unknown plan, a new id, and an edit the schema rejects", () => {
    const config = frozen(running(plan()));
    const snapshot = structuredClone(config);

    expect(refused(updateDcaPlan(config, "dca-missing", { paused: true }))).toMatch(/no plan/);
    // Not in the patch type, which is the point: a caller has to go out of
    // its way, and is then refused rather than silently ignored.
    const newId = { id: "dca-renamed" } as unknown as { paused: boolean };
    expect(refused(updateDcaPlan(config, "dca-0a1b2c3d", newId))).toMatch(/id cannot be changed/);
    expect(refused(updateDcaPlan(config, "dca-0a1b2c3d", { intervalSeconds: 299 }))).toMatch(
      /intervalSeconds/,
    );
    expect(refused(updateDcaPlan(config, "dca-0a1b2c3d", { amountPerBuy: "-1" }))).toMatch(
      /amountPerBuy/,
    );
    // Undefined removes a field, and a plan cannot do without this one.
    expect(refused(updateDcaPlan(config, "dca-0a1b2c3d", { paused: undefined }))).toMatch(/paused/);
    expect(config).toEqual(snapshot);
  });

  it("accepts a patch that restates the id unchanged", () => {
    const config = running(plan());
    const same = { id: "dca-0a1b2c3d", paused: true } as unknown as { paused: boolean };
    expect(accepted(updateDcaPlan(config, "dca-0a1b2c3d", same)).dca.plans).toEqual([
      plan({ paused: true }),
    ]);
  });
});

describe("removeDcaPlan", () => {
  it("removes one plan, keeps the rest in order and leaves auto-buy as it was", () => {
    const config = frozen({
      ...running(plan({ id: "dca-a" }), plan({ id: "dca-b" }), plan({ id: "dca-c" })),
      preset: "recommended" as const,
    });

    const next = accepted(removeDcaPlan(config, "dca-b"));
    expect(next.dca.plans.map((p) => p.id)).toEqual(["dca-a", "dca-c"]);
    expect(next.dca.enabled).toBe(true);
    expect(next.modules).toEqual(config.modules);
    expect(next.preset).toBe("custom");

    // Removing the last one does not switch the feature off either.
    const empty = accepted(removeDcaPlan(running(plan()), "dca-0a1b2c3d"));
    expect(empty.dca).toEqual({ enabled: true, plans: [] });
  });

  it("refuses a plan that is not there", () => {
    expect(refused(removeDcaPlan(running(plan()), "dca-missing"))).toMatch(/no plan/);
  });
});

describe("vault plans", () => {
  const VAULT = "0x6de035555360a81c068559954bd7ee97cde8e201";
  const OTHER_VAULT = "0x7777777777777777777777777777777777777777";
  const vaultPlan = (overrides: Partial<DcaPlan> = {}) =>
    plan({ id: "dca-vault", signer: "vault", paused: true, ...overrides });
  const created = () => running(vaultPlan({ vault: VAULT }));

  it("are added paused, switching auto-buy on as any plan does", () => {
    const next = accepted(addDcaPlan(frozen(recommendedConfig()), vaultPlan()));
    expect(next.dca.plans).toEqual([vaultPlan()]);
    expect(featureById(DCA_FEATURE_ID)?.isEnabled(next)).toBe(true);
  });

  it("are refused unpaused, or selling anything but ether", () => {
    expect(refused(addDcaPlan(recommendedConfig(), vaultPlan({ paused: false })))).toMatch(
      /paused: a vault plan is always paused here/,
    );
    expect(refused(addDcaPlan(recommendedConfig(), vaultPlan({ sell: USDC })))).toMatch(/sell: a vault plan sells ether/);
  });

  it("cannot be resumed, and setting them paused again changes nothing", () => {
    // Resuming would claim a runner there is none of; the vault runs itself,
    // and closing it is the only stop.
    const config = frozen(created());
    expect(refused(updateDcaPlan(config, "dca-vault", { paused: false }))).toMatch(
      /cannot be paused or resumed.*close the vault and withdraw/,
    );
    expect(accepted(updateDcaPlan(config, "dca-vault", { paused: true })).dca.plans).toEqual(config.dca.plans);
  });

  it("record their vault once, and never change or lose it after", () => {
    const made = accepted(updateDcaPlan(running(vaultPlan()), "dca-vault", { vault: VAULT }));
    expect(made.dca.plans).toEqual([vaultPlan({ vault: VAULT })]);

    const config = frozen(made);
    expect(refused(updateDcaPlan(config, "dca-vault", { vault: OTHER_VAULT }))).toMatch(/vault cannot be changed or removed/);
    expect(refused(updateDcaPlan(config, "dca-vault", { vault: undefined }))).toMatch(/vault cannot be changed or removed/);
    // Restating it, in any case, is not a change.
    const restated = updateDcaPlan(config, "dca-vault", { vault: VAULT.toUpperCase().replace("0X", "0x") as `0x${string}` });
    expect(accepted(restated).dca.plans).toEqual(config.dca.plans);
  });

  it("keep the terms their vault holds, once it exists, and nothing but the label changes", () => {
    const config = frozen(created());
    const snapshot = structuredClone(config);
    const edits: DcaPlanPatch[] = [
      { amountPerBuy: "20000000000000000" },
      { intervalSeconds: 3_600 },
      { maxBuys: 3 },
      { startAt: 1_790_000_001 },
      { buy: USDC },
      { chainId: 690069 },
    ];
    for (const patch of edits) {
      expect(refused(updateDcaPlan(config, "dca-vault", patch))).toMatch(/fixed in its vault on chain/);
    }
    expect(refused(updateDcaPlan(config, "dca-vault", { maxBuys: 3, label: "x" }))).toMatch(/\(maxBuys\)/);
    expect(config).toEqual(snapshot);

    const renamed = accepted(updateDcaPlan(config, "dca-vault", { label: "SPX, hourly", maxBuys: 30 }));
    expect(renamed.dca.plans).toEqual([vaultPlan({ vault: VAULT, label: "SPX, hourly" })]);
  });

  it("can have their terms edited before the vault exists", () => {
    const next = accepted(updateDcaPlan(running(vaultPlan()), "dca-vault", { maxBuys: 3, startAt: 1_790_000_600 }));
    expect(next.dca.plans).toEqual([vaultPlan({ maxBuys: 3, startAt: 1_790_000_600 })]);
  });

  it("cannot become another kind of plan, nor another plan a vault plan", () => {
    expect(refused(updateDcaPlan(created(), "dca-vault", { signer: "wallet" }))).toMatch(/to or from a vault plan/);
    expect(refused(updateDcaPlan(running(vaultPlan()), "dca-vault", { signer: "wallet" }))).toMatch(
      /to or from a vault plan/,
    );
    // A signer that no longer exists is refused by the schema, and names the field.
    const retired = { signer: "autopilot" } as unknown as DcaPlanPatch;
    expect(refused(updateDcaPlan(running(plan()), "dca-0a1b2c3d", retired))).toMatch(/signer/);
    const tab = running(plan());
    expect(refused(updateDcaPlan(tab, "dca-0a1b2c3d", { signer: "vault", paused: true }))).toMatch(/to or from a vault plan/);
    // And a tab plan has no vault to record.
    expect(refused(updateDcaPlan(tab, "dca-0a1b2c3d", { vault: VAULT }))).toMatch(/only a vault plan has a vault/);
  });

  it("can be removed, which forgets the vault and leaves it on chain", () => {
    const next = accepted(removeDcaPlan(created(), "dca-vault"));
    expect(next.dca.plans).toEqual([]);
  });
});
