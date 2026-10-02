import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CULTURE_AMOUNT_PRESETS_USD_CENTS,
  CULTURE_COUNT_PRESETS,
  RECURRING_AMOUNT_PRESETS_USD_CENTS,
  STACK_GOAL_PRESETS_SPX,
} from "../../lib/culture/presets.js";
import { parseDecimal } from "../../lib/money/parse.js";
import { PresetChips, presetFieldText, presetLabel } from "./PresetChips.js";

const LOCALES = ["en-US", "de-DE", "fr-FR", "de-CH", "en-IN"];
const ascending = (list: readonly number[]) => list.every((v, i) => i === 0 || list[i - 1]! < v);

describe("the presets", () => {
  it("are in ascending order, so nothing nudges upward", () => {
    for (const list of [CULTURE_AMOUNT_PRESETS_USD_CENTS, RECURRING_AMOUNT_PRESETS_USD_CENTS, CULTURE_COUNT_PRESETS, STACK_GOAL_PRESETS_SPX]) {
      expect(ascending(list)).toBe(true);
    }
  });

  it.each(LOCALES)("each dollar preset reads back as exactly its cents in %s", (locale) => {
    for (const cents of CULTURE_AMOUNT_PRESETS_USD_CENTS) {
      const text = presetFieldText(cents, locale);
      expect(parseDecimal(text, locale, 2)).toEqual({ ok: true, value: BigInt(cents) });
    }
  });

  it("is written in the locale's own decimal mark, with no grouping", () => {
    expect(presetFieldText(690, "en-US")).toBe("6.90");
    expect(presetFieldText(690, "de-DE")).toBe("6,90");
    expect(presetFieldText(690, "fr-FR")).toBe("6,90");
    expect(presetFieldText(69_000, "en-IN")).toBe("690");
    expect(presetFieldText(123_456_78, "de-DE")).toBe("123456,78");
  });

  it("says dollars, as the locale writes them", () => {
    expect(CULTURE_AMOUNT_PRESETS_USD_CENTS.map((c) => presetLabel(c, "en-US"))).toEqual(["$6.90", "$69", "$690"]);
    expect(presetLabel(690, "de-DE")).toBe("6,90 $");
    expect(presetLabel(6_900, "not-a-locale-tag")).toBe("$69");
  });

  it("refuses what isn't a whole number of cents", () => {
    expect(() => presetFieldText(6.9, "en-US")).toThrow(RangeError);
    expect(() => presetLabel(0, "en-US")).toThrow(RangeError);
  });
});

describe("PresetChips", () => {
  const render = (disabledReason: string | null) =>
    renderToStaticMarkup(
      createElement(PresetChips, { context: "amount", cents: CULTURE_AMOUNT_PRESETS_USD_CENTS, locale: "en-US", disabledReason, onPick: () => {} }),
    );

  it("names each chip <context>-preset-<cents>, in order", () => {
    const ids = [...render(null).matchAll(/data-testid="(amount-preset-\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["amount-preset-690", "amount-preset-6900", "amount-preset-69000"]);
  });

  it("disables every chip and says why", () => {
    const html = render("No dollar price right now.");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("No dollar price right now.");
    expect(render(null)).not.toContain("disabled");
  });

  it("never labels a chip recommended", () => {
    expect(render(null)).not.toMatch(/recommend/i);
  });
});
