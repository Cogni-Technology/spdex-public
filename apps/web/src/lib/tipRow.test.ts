/**
 * The Tip row: its even split, and how a chip maps to the config and back.
 *
 * The split is checked where it could go wrong quietly — a remainder that is
 * dropped sends less than the chip says, and one that is spread sends a
 * different amount to people who were promised the same. The edits are checked
 * for what they must never do: clamp instead of refuse, discard a list when
 * tips are switched off, or leave the registry module off while tips are on.
 */

import { describe, expect, it } from "vitest";
import { recommendedConfig, TIPLIST_MODULE_ID } from "@spdex/config";
import { MAX_TIP_RECIPIENTS, MAX_TOTAL_TIP_BPS, TipPolicySchema, type SpdexConfig } from "@spdex/core";
import {
  addTipRecipient,
  applyTipChip,
  bpsText,
  chipValue,
  isEvenSplit,
  DEV_TIPLIST_ID,
  labelAsMine,
  listsPlaceholders,
  NO_LISTED_YET,
  NO_VERIFIED_LIST,
  replaceTipRecipient,
  offeredCandidates,
  PLACEHOLDER_CHAINS,
  pillName,
  removeTipRecipient,
  restoreTipRecipient,
  splitEvenly,
  TIP_CHIPS,
  permit2Permission,
  tipConfirmations,
  tipCostText,
  tipDelivery,
  tipDeliveryFor,
  tipPrompts,
  tipShareOf,
  tipTransferCount,
  type TipCandidate,
  type TipEdit,
} from "./tipRow.js";
import devFixturesManifest from "../../../../modules/tiplist-dev-fixtures/manifest.json";

/** The dev-fixtures entries: anvil accounts #1–#3, offered on a local fork only. */
const A: TipCandidate = {
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  label: "Placeholder: dev fund",
  handle: "@spx_placeholder_1",
  registryId: DEV_TIPLIST_ID,
};
const B: TipCandidate = {
  address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  label: "Placeholder: meme fund",
  registryId: DEV_TIPLIST_ID,
};
const C: TipCandidate = {
  address: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  label: "Placeholder: translations",
  handle: "@spx_placeholder_3",
  registryId: DEV_TIPLIST_ID,
};

/** The config an edit produced, failing the test with the refusal if it was refused. */
function applied(edit: TipEdit): SpdexConfig {
  if (!edit.ok) throw new Error(`refused: ${edit.error}`);
  return edit.config;
}

const tiplistOn = (config: SpdexConfig) =>
  config.modules.find((module) => module.id === TIPLIST_MODULE_ID)?.enabled ?? false;

describe("splitEvenly", () => {
  it("adds back up to exactly the total, with the remainder on the first person", () => {
    expect(splitEvenly(25, 1)).toEqual([25]);
    expect(splitEvenly(25, 2)).toEqual([13, 12]);
    expect(splitEvenly(25, 3)).toEqual([9, 8, 8]);
    expect(splitEvenly(50, 4)).toEqual([14, 12, 12, 12]);
    expect(splitEvenly(10, MAX_TIP_RECIPIENTS)).toEqual([2, 2, 2, 2, 2]);
    for (const total of [10, 25, 50, 37, MAX_TOTAL_TIP_BPS]) {
      for (let count = 1; count <= MAX_TIP_RECIPIENTS; count++) {
        const shares = splitEvenly(total, count)!;
        expect(shares.reduce((sum, bps) => sum + bps, 0)).toBe(total);
        // Nobody gets more than one basis point short of anybody else, bar the
        // remainder, which the first person carries.
        expect(Math.max(...shares.slice(1), shares[0]!) - Math.min(...shares)).toBeLessThan(count);
      }
    }
  });

  it("refuses a total that cannot give everyone at least one basis point", () => {
    expect(splitEvenly(3, 4)).toBeNull();
    expect(splitEvenly(2.5, 1)).toBeNull();
    expect(splitEvenly(10, 0)).toEqual([]);
  });

  it("every chip can be shared among the most people the config allows", () => {
    for (const chip of TIP_CHIPS.filter((bps) => bps > 0)) {
      expect(splitEvenly(chip, MAX_TIP_RECIPIENTS)?.every((bps) => bps >= 1)).toBe(true);
    }
  });
});

describe("the chips and the config", () => {
  it("starts Off, with nobody chosen and the registry module off", () => {
    const config = recommendedConfig();
    expect(chipValue(config.tips)).toBe("0");
    expect(tipTransferCount(config.tips)).toBe(0);
    expect(tiplistOn(config)).toBe(false);
  });

  it("a share with nobody chosen turns tips on, with the registry, and sends nothing yet", () => {
    const next = applied(applyTipChip(recommendedConfig(), 25));
    expect(next.tips).toEqual({ enabled: true, recipients: [] });
    expect(chipValue(next.tips)).toBe("unset");
    expect(tipTransferCount(next.tips)).toBe(0);
    expect(tiplistOn(next)).toBe(true);
    expect(next.preset).toBe("custom");
  });

  it("adding someone gives them the whole chip; a second person halves it", () => {
    const on = applied(applyTipChip(recommendedConfig(), 25));
    const one = applied(addTipRecipient(on, A, 25));
    expect(one.tips.recipients).toEqual([
      {
        address: A.address.toLowerCase(),
        label: A.label,
        handle: A.handle,
        source: DEV_TIPLIST_ID,
        bps: 25,
      },
    ]);
    expect(chipValue(one.tips)).toBe("25");
    expect(tipTransferCount(one.tips)).toBe(1);

    const two = applied(addTipRecipient(one, B, 25));
    expect(two.tips.recipients.map((r) => r.bps)).toEqual([13, 12]);
    expect(two.tips.recipients[1]).not.toHaveProperty("handle");
    expect(chipValue(two.tips)).toBe("25");
    expect(isEvenSplit(two.tips.recipients)).toBe(true);
    expect(TipPolicySchema.safeParse(two.tips).success).toBe(true);
  });

  it("picking another chip re-divides the new total across the same people", () => {
    const two = applied(addTipRecipient(applied(addTipRecipient(recommendedConfig(), A, 25)), B, 25));
    const half = applied(applyTipChip(two, 50));
    expect(half.tips.recipients.map((r) => r.bps)).toEqual([25, 25]);
    expect(chipValue(half.tips)).toBe("50");
    const tenth = applied(applyTipChip(half, 10));
    expect(tenth.tips.recipients.map((r) => r.bps)).toEqual([5, 5]);
    expect(chipValue(tenth.tips)).toBe("10");
  });

  it("Off stops the tipping and keeps the list, and a share brings it back", () => {
    const one = applied(addTipRecipient(recommendedConfig(), A, 25));
    const off = applied(applyTipChip(one, 0));
    expect(off.tips.enabled).toBe(false);
    expect(off.tips.recipients).toHaveLength(1);
    expect(chipValue(off.tips)).toBe("0");
    expect(tipTransferCount(off.tips)).toBe(0);
    expect(tiplistOn(off)).toBe(false);

    const back = applied(applyTipChip(off, 10));
    expect(back.tips).toMatchObject({ enabled: true, recipients: [{ address: A.address.toLowerCase(), bps: 10 }] });
    expect(tiplistOn(back)).toBe(true);
  });

  it("removing someone keeps the total, and the last one out leaves nobody chosen", () => {
    const three = [A, B, C].reduce<SpdexConfig>((config, who) => applied(addTipRecipient(config, who, 50)), recommendedConfig());
    expect(three.tips.recipients.map((r) => r.bps)).toEqual([18, 16, 16]);

    const two = applied(removeTipRecipient(three, B.address.toUpperCase().replace("0X", "0x")));
    expect(two.tips.recipients.map((r) => r.address)).toEqual([A.address.toLowerCase(), C.address]);
    expect(two.tips.recipients.map((r) => r.bps)).toEqual([25, 25]);

    const none = applied(removeTipRecipient(applied(removeTipRecipient(two, A.address)), C.address));
    expect(none.tips).toEqual({ enabled: true, recipients: [] });
    expect(chipValue(none.tips)).toBe("unset");
  });

  it("an uneven split set in Expert shows as custom, and a chip evens it out", () => {
    const one = applied(addTipRecipient(recommendedConfig(), A, 25));
    const custom: SpdexConfig = {
      ...one,
      tips: { enabled: true, recipients: [{ ...one.tips.recipients[0]!, bps: 30 }, { ...one.tips.recipients[0]!, address: B.address as `0x${string}`, bps: 5 }] },
    };
    expect(chipValue(custom.tips)).toBe("custom");
    expect(isEvenSplit(custom.tips.recipients)).toBe(false);
    expect(applied(applyTipChip(custom, 25)).tips.recipients.map((r) => r.bps)).toEqual([13, 12]);
  });
});

describe("refusals", () => {
  it("refuses the same person twice, whatever the casing", () => {
    const one = applied(addTipRecipient(recommendedConfig(), A, 25));
    const again = addTipRecipient(one, { ...A, address: A.address.toUpperCase().replace("0X", "0x") }, 25);
    expect(again).toEqual({ ok: false, error: `${A.label} is already chosen.` });
  });

  it(`refuses a ${MAX_TIP_RECIPIENTS + 1}th person rather than dropping one`, () => {
    let config = recommendedConfig();
    for (let index = 0; index < MAX_TIP_RECIPIENTS; index++) {
      config = applied(
        addTipRecipient(config, { ...B, address: `0x${(index + 1).toString(16).padStart(40, "0")}` }, 50),
      );
    }
    const edit = addTipRecipient(config, A, 50);
    expect(edit.ok).toBe(false);
    expect(config.tips.recipients).toHaveLength(MAX_TIP_RECIPIENTS);
  });

  it("refuses a total over the ceiling instead of clamping it", () => {
    const edit = addTipRecipient(recommendedConfig(), A, MAX_TOTAL_TIP_BPS + 1);
    expect(edit).toEqual({ ok: false, error: "Tips cannot total more than 5% of a swap." });
  });

  it("refuses a total too small to share", () => {
    const one = applied(addTipRecipient(recommendedConfig(), A, 1));
    expect(addTipRecipient(one, B, 1).ok).toBe(false);
  });
});

describe("display helpers", () => {
  it("states a share as a percentage", () => {
    expect(bpsText(25)).toBe("0.25%");
    expect(bpsText(10)).toBe("0.1%");
    expect(bpsText(MAX_TOTAL_TIP_BPS)).toBe("5%");
  });

  it("rounds a share down, as the transfer does", () => {
    expect(tipShareOf(10_000n, 25)).toBe(25n);
    expect(tipShareOf(399n, 25)).toBe(0n);
    expect(tipShareOf(0n, 25)).toBe(0n);
    expect(tipShareOf(10_000n, 0)).toBe(0n);
  });

  it("flags the dev-fixtures list as placeholders, and the real list as not", () => {
    expect(listsPlaceholders([A, B])).toBe(true);
    // The real list holds real entries only, since the test entries moved out.
    expect(listsPlaceholders([{ registryId: TIPLIST_MODULE_ID }])).toBe(false);
    expect(listsPlaceholders([])).toBe(false);
    expect(devFixturesManifest.id).toBe(DEV_TIPLIST_ID);
  });

  /**
   * The placeholders are anvil's development accounts, whose keys are public.
   * On Ethereum a tip to one is money anyone can take — bots sweep them — so
   * a picker offers them only on a local test network: any entry from the
   * dev fixtures, and any public development account whichever list names it.
   */
  it("offers test entries and public development accounts only on a local test network", () => {
    const real = { address: "0x4444444444444444444444444444444444444444", label: "Example Cause", registryId: TIPLIST_MODULE_ID };
    const devInRealList = { ...A, registryId: TIPLIST_MODULE_ID };
    expect(offeredCandidates([A, B], 690069)).toEqual({ offered: [A, B], withheld: 0 });
    expect(offeredCandidates([A, B], 31337)).toEqual({ offered: [A, B], withheld: 0 });
    expect(offeredCandidates([A, B], 1)).toEqual({ offered: [], withheld: 2 });
    expect(offeredCandidates([A, real], 1)).toEqual({ offered: [real], withheld: 1 });
    expect(offeredCandidates([devInRealList, real], 1)).toEqual({ offered: [real], withheld: 1 });
    expect(PLACEHOLDER_CHAINS.has(1)).toBe(false);
    expect(NO_VERIFIED_LIST).toMatch(/offered only on a local test network/);
    expect(NO_LISTED_YET).toBe("No listed people yet — add your own.");
  });

  it("names a pill by its handle, or its label when there is none", () => {
    expect(pillName({ label: A.label, handle: "@spx_placeholder_1" })).toBe("@spx_placeholder_1");
    expect(pillName({ label: B.label })).toBe(B.label);
    expect(pillName({ label: B.label, handle: "" })).toBe(B.label);
  });
});

describe("how the tips will go out", () => {
  const withPeople = (count: number) =>
    applied(
      [A, B, C]
        .slice(0, count)
        .reduce<TipEdit>((edit, candidate) => addTipRecipient(applied(edit), candidate, 50), applyTipChip(recommendedConfig(), 50)),
    ).tips;
  const known = { native: false, permit2: true, permission: "given" as const };

  it("sends one person a transfer, and never batches it", () => {
    expect(tipDelivery(withPeople(1), known)).toEqual({ kind: "transfers", count: 1 });
    expect(tipCostText({ kind: "transfers", count: 1 })).toBe("1 extra confirmation");
  });

  it("batches two or more: one signature and one confirmation", () => {
    const delivery = tipDelivery(withPeople(2), known);
    expect(delivery).toEqual({ kind: "batch", people: 2, permission: "given" });
    expect(tipCostText(delivery)).toBe("1 signature + 1 confirmation");
    expect(tipConfirmations(delivery)).toBe(1);
  });

  it("names the standing permission after the signature, when it will be asked for or may be", () => {
    // In the order the wallet asks (the signature first, so a wallet that
    // can't sign typed data is never asked for the permission), and
    // "standing", not "one-time": it is asked once and then stays,
    // unlimited, until revoked.
    const needed = tipDelivery(withPeople(3), { ...known, permission: "needed" });
    expect(tipCostText(needed)).toBe("1 signature, a standing Permit2 permission, then 1 confirmation");
    expect(tipConfirmations(needed)).toBe(2);
    const unknown = tipDelivery(withPeople(2), { ...known, permission: "unknown" });
    expect(tipCostText(unknown)).toBe("1 signature, a standing Permit2 permission the first time, then 1 confirmation");
    expect(tipConfirmations(unknown)).toBe(2);
    expect(tipCostText(needed)).not.toMatch(/one-time/);
  });

  it("counts every wallet prompt the tips add, signatures included, for the step count", () => {
    expect(tipPrompts({ kind: "none" })).toBe(0);
    expect(tipPrompts({ kind: "transfers", count: 3 })).toBe(3);
    expect(tipPrompts({ kind: "batch", people: 2, permission: "given" })).toBe(2);
    expect(tipPrompts({ kind: "batch", people: 2, permission: "needed" })).toBe(3);
    expect(tipPrompts({ kind: "batch", people: 2, permission: "unknown" })).toBe(3);
  });

  it("sends a transfer each once a batch has failed for this wallet in the session", () => {
    const delivery = tipDelivery(withPeople(2), { ...known, batchable: false });
    expect(delivery).toEqual({ kind: "transfers", count: 2 });
    expect(tipCostText(delivery)).toBe("2 extra confirmations");
  });

  it("works the delivery out from what the page read, the same way everywhere", () => {
    const tips = withPeople(2);
    const base = { native: false, permit2: true, amountOut: 1_000_000n };
    expect(tipDeliveryFor(tips, { ...base, allowance: (1n << 256n) - 1n })).toEqual({
      kind: "batch",
      people: 2,
      permission: "given",
    });
    expect(tipDeliveryFor(tips, { ...base, allowance: 0n })).toEqual({ kind: "batch", people: 2, permission: "needed" });
    expect(tipDeliveryFor(tips, { ...base, allowance: null })).toEqual({ kind: "batch", people: 2, permission: "unknown" });
    expect(tipDeliveryFor(tips, { ...base, allowance: 0n, batchable: false })).toEqual({ kind: "transfers", count: 2 });
  });

  it("falls back to a transfer each where Permit2 isn't the one spDEX knows", () => {
    const delivery = tipDelivery(withPeople(2), { ...known, permit2: false });
    expect(delivery).toEqual({ kind: "transfers", count: 2 });
    expect(tipCostText(delivery)).toBe("2 extra confirmations");
    // Not yet known is shown as the batch it will be on Ethereum.
    expect(tipDelivery(withPeople(2), { ...known, permit2: null }).kind).toBe("batch");
  });

  it("sends nothing for ether out, tips off, or nobody chosen", () => {
    expect(tipDelivery(withPeople(2), { ...known, native: true })).toEqual({ kind: "none" });
    expect(tipDelivery(recommendedConfig().tips, known)).toEqual({ kind: "none" });
    expect(tipCostText({ kind: "none" })).toBe("");
    expect(tipConfirmations({ kind: "none" })).toBe(0);
  });

  it("reads the permission from Permit2's allowance, and unknown from no reading", () => {
    expect(permit2Permission(null, 5n)).toBe("unknown");
    expect(permit2Permission((1n << 256n) - 1n, null)).toBe("given");
    expect(permit2Permission(0n, null)).toBe("needed");
    expect(permit2Permission(10n, 5n)).toBe("given");
    expect(permit2Permission(4n, 5n)).toBe("needed");
    // Some allowance, and no estimate to hold it against, is not a known yes.
    expect(permit2Permission(10n, null)).toBe("unknown");
  });
});

describe("switching and relabelling a chosen recipient", () => {
  const withTwo = () =>
    applied(addTipRecipient(applied(addTipRecipient(applied(applyTipChip(recommendedConfig(), 50)), A, 50)), B, 50));

  it("replaces a retired entry's address with its replacement, keeping the share", () => {
    const before = withTwo();
    const shareOfA = before.tips.recipients[0]!.bps;
    const next = applied(
      replaceTipRecipient(before, A.address, { address: C.address, label: C.label, registryId: DEV_TIPLIST_ID }),
    );
    expect(next.tips.recipients.map((r) => r.address)).toEqual([C.address.toLowerCase(), B.address.toLowerCase()]);
    expect(next.tips.recipients[0]!.bps).toBe(shareOfA);
  });

  it("only drops the old address when the replacement is already chosen", () => {
    const next = applied(replaceTipRecipient(withTwo(), A.address, B));
    expect(next.tips.recipients.map((r) => r.address)).toEqual([B.address.toLowerCase()]);
  });

  it("puts back someone taken out, at their place with their share, when it still fits", () => {
    const before = withTwo();
    const removed = applied(removeTipRecipient(before, B.address));
    expect(removed.tips.recipients.map((r) => [r.address, r.bps])).toEqual([[A.address.toLowerCase(), 50]]);
    const b = before.tips.recipients[1]!;
    const back = applied(restoreTipRecipient({ ...removed, tips: { ...removed.tips, recipients: [{ ...removed.tips.recipients[0]!, bps: 25 }] } }, b, 1));
    expect(back.tips.recipients.map((r) => [r.address, r.bps])).toEqual([
      [A.address.toLowerCase(), 25],
      [B.address.toLowerCase(), 25],
    ]);
    // Already back: nothing changes. Over the ceiling: refused, with the reason.
    expect(applied(restoreTipRecipient(before, b, 1))).toBe(before);
    const full = { ...removed, tips: { ...removed.tips, recipients: [{ ...removed.tips.recipients[0]!, bps: MAX_TOTAL_TIP_BPS }] } };
    expect(restoreTipRecipient(full, b, 1)).toMatchObject({ ok: false });
  });

  it("writes a saved recipient's label as My tip list, dropping any handle", () => {
    const next = labelAsMine(withTwo(), A.address, "My tip list", "my-tip-list");
    expect(next.tips.recipients[0]).toMatchObject({ label: "My tip list", source: "my-tip-list" });
    expect(next.tips.recipients[0]!.handle).toBeUndefined();
    expect(next.tips.recipients[1]!.label).toBe(B.label);
  });
});
