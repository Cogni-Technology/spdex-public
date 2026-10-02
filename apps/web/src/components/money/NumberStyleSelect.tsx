/**
 * The number-style menu (`number-style-select`): how amounts are written and
 * read, "1,234.56", "1.234,56" and the rest, or whatever this browser uses.
 *
 * A phone's decimal keypad follows the phone's region, which can differ from
 * the browser's language, so a person whose "0,5" is refused needs a way to
 * say which mark they mean. That is this. It changes how every amount is
 * shown and read, and never an amount: a refused amount stays refused until
 * it is typed again.
 */

import { numberStyleLabel } from "../../lib/money/currency.js";
import { moneyStore, useMoneyPrefs } from "../../lib/money/prefs.js";
import { NUMBER_STYLES, type NumberStyle } from "../../lib/money/pricing.js";
import "./money.css";

function isNumberStyle(value: string): value is NumberStyle {
  return (NUMBER_STYLES as readonly string[]).includes(value);
}

/**
 * The select alone, for a place that labels it itself: the settings, and an
 * amount refused for its decimal mark, which puts it beside the fix
 * (`amount-number-style`). `onChosen` hears each choice, after it is made.
 */
export function NumberStyleSelect({
  testId = "number-style-select",
  onChosen,
}: {
  testId?: string;
  onChosen?: () => void;
}) {
  const prefs = useMoneyPrefs();
  return (
    <select
      className="spdex-select spdex-money-select"
      data-testid={testId}
      aria-label="Number style"
      value={prefs.numbers}
      onChange={(event) => {
        const next = event.target.value;
        if (isNumberStyle(next)) moneyStore().set({ ...moneyStore().get(), numbers: next });
        onChosen?.();
      }}
    >
      {NUMBER_STYLES.map((style) => (
        <option key={style} value={style}>
          {numberStyleLabel(style)}
        </option>
      ))}
    </select>
  );
}
