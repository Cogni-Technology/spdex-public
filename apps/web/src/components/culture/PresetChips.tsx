/**
 * One-tap amounts: "$6.90 · $69 · $690".
 *
 * 69 and its tens are the SPX6900 community's own numbers, so the choices
 * speak its language, in ascending order so nothing nudges anyone upward.
 * They always say dollars, the meme's own unit, whatever currency is chosen,
 * and they are written the way the person's number format writes dollars
 * ("6,90 $" in German). A chip only fills a field: nothing is quoted, saved
 * or sent until the person presses the button that does that.
 *
 * Each chip's test id is `<context>-preset-<cents>`, such as
 * `amount-preset-6900` or `dca-form-preset-690`.
 */

import type { JSX } from "react";
import "./culture.css";

export interface PresetChipsProps {
  /** Where the chips sit, which also names their test ids. */
  context: "amount" | "dca-form";
  /** Dollar amounts in cents, in ascending order (lib/culture/presets.ts). */
  cents: readonly number[];
  /** The number format the chips are written in. */
  locale: string;
  /** Why no chip can be picked right now, shown as the hint; null when they can. */
  disabledReason: string | null;
  /**
   * Say the chips are in US dollars: for someone whose currency is another,
   * a chip switches their field to dollars, which shouldn't be a surprise.
   */
  dollarsNote?: boolean;
  onPick(cents: number): void;
}

export function PresetChips({ context, cents, locale, disabledReason, dollarsNote = false, onPick }: PresetChipsProps): JSX.Element | null {
  if (cents.length === 0) return null;
  const disabled = disabledReason !== null;
  return (
    <div className="spdex-presets" data-testid={`${context}-presets`}>
      <div className="spdex-presets__chips" role="group" aria-label="Fill in an amount in dollars">
        {cents.map((c) => (
          <button
            key={c}
            type="button"
            className="spdex-presets__chip"
            data-testid={`${context}-preset-${c}`}
            disabled={disabled}
            onClick={() => onPick(c)}
          >
            {presetLabel(c, locale)}
          </button>
        ))}
      </div>
      {disabled ? (
        <span className="spdex-field__hint" data-testid={`${context}-presets-hint`}>
          {disabledReason}
        </span>
      ) : dollarsNote ? (
        <span className="spdex-field__hint" data-testid={`${context}-presets-hint`}>
          In US dollars, the meme&apos;s own unit.
        </span>
      ) : null}
    </div>
  );
}

/** Whole cents as "6.90" or "69", in plain digits: the exact decimal, never a float. */
function centsDecimal(cents: number): { whole: string; fraction: string } {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new RangeError(`a preset is a positive whole number of cents (got ${cents})`);
  const whole = Math.floor(cents / 100).toString();
  const fraction = cents % 100 === 0 ? "" : (cents % 100).toString().padStart(2, "0");
  return { whole, fraction };
}

/** "$6.90", "$69", "6,90 $": a chip's label, in dollars, as `locale` writes them. */
export function presetLabel(cents: number, locale: string): string {
  const { whole, fraction } = centsDecimal(cents);
  const digits = fraction === "" ? 0 : 2;
  const format = (tag: string) =>
    new Intl.NumberFormat(tag, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
  // A label only: two decimals of a few dollars survive a float exactly, and
  // what a chip types into a field is `presetFieldText`, which never uses one.
  const value = Number(whole) + Number(fraction || "0") / 100;
  try {
    return format(locale).format(value);
  } catch {
    return format("en-US").format(value);
  }
}

/**
 * "6.90" in en-US, "6,90" in de-DE, "690" for $690: what a chip types into a
 * dollar field, in the field's number format with no grouping, so it reads
 * back as exactly those cents (`parseDecimal`).
 */
export function presetFieldText(cents: number, locale: string): string {
  const { whole, fraction } = centsDecimal(cents);
  if (fraction === "") return whole;
  let mark = ".";
  try {
    mark = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  } catch {
    // An unknown tag: en-US's mark, as the app's other readers fall back.
  }
  return `${whole}${mark}${fraction}`;
}
