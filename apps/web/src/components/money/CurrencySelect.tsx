/**
 * The currency menu (`currency-select`): the 17 currencies spDEX can show
 * and take amounts in.
 *
 * A native select, so it is the phone's own picker. Choosing one changes
 * every "≈" figure and the money unit of both amount fields; it moves no
 * money and changes no plan, which stay in token amounts. The choice is this
 * browser's, never part of the settings (lib/money/prefs.ts), and choosing a
 * currency makes no request: every currency's rate is read every time.
 */

import { CURRENCY_NAMES, currencySymbol, isCurrencyCode, numberLocale } from "../../lib/money/currency.js";
import { moneyStore, useMoneyPrefs } from "../../lib/money/prefs.js";
import { CURRENCY_CODES, type CurrencyCode } from "../../lib/money/pricing.js";
import "./money.css";

/** "EUR € — euros", or "CHF — Swiss francs" where the sign is the code. */
export function currencyOptionText(code: CurrencyCode, locale: string): string {
  const symbol = currencySymbol(code, locale);
  return symbol === code ? `${code} — ${CURRENCY_NAMES[code]}` : `${code} ${symbol} — ${CURRENCY_NAMES[code]}`;
}

/**
 * The select alone, for a place that labels it itself: the settings, which
 * put `MISSING_CURRENCIES_HINT` in a `Term` on its label. An amount field
 * changes the currency from its own unit menu ("Change currency"), so this
 * is the one place that lists all 17 by name. `onChosen` hears each choice,
 * after it is made.
 */
export function CurrencySelect({
  testId = "currency-select",
  onChosen,
}: {
  testId?: string;
  onChosen?: () => void;
}) {
  const prefs = useMoneyPrefs();
  const locale = numberLocale(prefs.numbers);
  return (
    <select
      className="spdex-select spdex-money-select"
      data-testid={testId}
      aria-label="Currency"
      value={prefs.currency}
      onChange={(event) => {
        const next = event.target.value;
        if (isCurrencyCode(next)) moneyStore().set({ ...moneyStore().get(), currency: next });
        onChosen?.();
      }}
    >
      {CURRENCY_CODES.map((code) => (
        <option key={code} value={code}>
          {currencyOptionText(code, locale)}
        </option>
      ))}
    </select>
  );
}
