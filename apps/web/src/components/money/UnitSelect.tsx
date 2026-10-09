/**
 * The amount field's unit (`${prefix}-unit`): one native select, the box's
 * trailing cell, so the unit sits where the amount is and nothing stacks up
 * beside the label.
 *
 * Three groups (lib/money/resolve.ts, `unitChoices`):
 *
 * 1. The field's own units, "ETH", "USD" and the chosen currency when it
 *    isn't dollars, by code: where the sign leads, the box shows it. Choosing
 *    one sets only this field's unit.
 * 2. "Change currency": every other currency, as "GBP £". Choosing one
 *    changes the page's currency, then puts this field in it.
 * 3. "No rate: INR HKD …", disabled: asked for, and not offered, because no
 *    rate for them on Ethereum can be read without asking a third party.
 *    The "sources" ⓘ under the field says so in words.
 *
 * A native select, so on a phone it is the phone's own picker. Focus never
 * moves when it changes: Tab carries the person on to the amount.
 */

import type { JSX } from "react";
import type { UnitChoice } from "../../lib/money/resolve.js";
import type { StoredUnit } from "../../lib/money/pricing.js";
import "./money.css";

export function UnitSelect({
  testId,
  value,
  units,
  others,
  missing,
  onChoose,
}: {
  testId: string;
  value: StoredUnit;
  units: readonly UnitChoice[];
  others: readonly UnitChoice[];
  missing: readonly string[];
  /** A choice, and whether it came from "Change currency" (group 2). */
  onChoose: (value: StoredUnit, changesCurrency: boolean) => void;
}): JSX.Element {
  const option = (choice: UnitChoice) => (
    <option key={choice.value} value={choice.value} title={choice.title}>
      {choice.text}
    </option>
  );
  return (
    <span className="spdex-amount__unit">
      <select
        className="spdex-amount__unit-select"
        data-testid={testId}
        aria-label="Amount unit"
        value={value}
        onChange={(event) => {
          const next = event.target.value as StoredUnit;
          onChoose(next, others.some((choice) => choice.value === next));
        }}
      >
        {units.map(option)}
        {others.length > 0 ? <optgroup label="Change currency">{others.map(option)}</optgroup> : null}
        {missing.length > 0 ? <optgroup label={`No rate: ${missing.join(" ")}`} disabled /> : null}
      </select>
    </span>
  );
}
