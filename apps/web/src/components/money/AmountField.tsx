/**
 * An amount field that takes money or the token, and always shows the token.
 *
 * One row, one unit control, nothing stacked beside it:
 *
 *   AMOUNT                                 Balance 3.6 ETH · Max ⓘ
 *   [ $ | 25                                          | USD ▾ ]
 *   [$6.90] [$69] [$690]      or      = 0.0102 ETH · avg 10:40 · sources
 *
 * The unit is the box's trailing cell (UnitSelect): the field's own units,
 * then "Change currency" for the rest. The balance and Max sit on the label
 * row. Under the box, one line: the one-tap amounts while the field is
 * empty, or, once something is typed, what it comes to. A money amount
 * always says the token amount it was sized to and when the price was read,
 * because that token amount, not the money, is what is quoted, saved and
 * signed. Where the rates come from, and why six currencies aren't offered,
 * is the "sources" ⓘ at the end of that line.
 *
 * What the field never does:
 * - **Re-size on its own.** A money amount is sized when the person types,
 *   switches unit, or presses "Use it" / "Use the price now". A newer price
 *   arriving is offered, not applied.
 * - **Read "20" again in another unit.** Switching from money to the token
 *   writes the token amount it came to; any other switch clears the field.
 * - **Guess.** No price, a price too old, or a currency without a rate is
 *   said as such, with "Switch to ETH" as the way on. When the network
 *   service is why (busy, or no answer), it says that instead, with "Try
 *   again": ETH can't be priced either while the service fails.
 * - **Move focus.** Choosing a unit leaves focus on the menu; Tab carries on.
 *
 * Typing mistakes ("0,5" where the mark is ".") are shown once the field is
 * left, with buttons that type the fix and the number-style menu beside
 * them, so nothing flashes while someone is halfway through typing a number
 * and nobody is sent up the page to fix it.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Term } from "@spdex/ui";
import { formatAmount, type TokenInfo } from "../../lib/tokens.js";
import { fiatOf, fallsBack } from "../../lib/money/convert.js";
import { currencySymbol, isCurrencyCode, MISSING_CURRENCIES_HINT, symbolLeads } from "../../lib/money/currency.js";
import { formatAmountForField, formatFiat, weekdayClockText } from "../../lib/money/format.js";
import { moneyStore, rememberUnit } from "../../lib/money/prefs.js";
import { perfNow } from "../../lib/page.js";
import { moneyView, useRatesNeeded } from "../../lib/money/rates.js";
import {
  afterCurrencyChange,
  afterTokenChange,
  rateUnavailableLead,
  usdcPegNote,
  readTime,
  resolveField,
  serviceRatesText,
  sameUnit,
  storedUnit,
  unitChoices,
  unitCurrency,
  withFrozen,
} from "../../lib/money/resolve.js";
import type { AmountInput, AmountUnit, MoneyPrefs, Pricing, StoredUnit } from "../../lib/money/pricing.js";
import { NumberStyleSelect } from "./NumberStyleSelect.js";
import { UnitSelect } from "./UnitSelect.js";
import "./money.css";

/**
 * Where the figures come from, and why some currencies aren't offered: the
 * "sources" ⓘ at the end of the hint line. "avg 14:08" in that line is this
 * 10-minute average, and its own tip says so.
 */
export const RATE_SOURCES_TIP =
  "Dollar prices are spDEX's 10-minute average from Uniswap, the one its safety check compares against. " +
  "Other currencies use Chainlink's rate against the dollar. Both are read through your network service, and USDC " +
  "counts as exactly $1. You pay the token amount shown; money is only how you typed it. " +
  MISSING_CURRENCIES_HINT;

export interface AmountFieldProps {
  value: AmountInput;
  onChange: (next: AmountInput) => void;
  token: TokenInfo;
  /** The page's rates and money preferences; null offers the token unit only. */
  pricing: Pricing | null;
  /** One-tap amounts, shown under the box while the field is empty. */
  chips?: ReactNode;
  /** "amount" or "dca-form-amount": the start of every test id here but the input's. */
  testIdPrefix: string;
  /** The input's own test id, which specs already use: `amount-input`, `dca-form-amount`. */
  inputTestId?: string;
  label?: string;
  /** The balance ("Balance 1.2 ETH · Max"), on the label row; the caller knows how to read it. Nothing shows for null. */
  balance?: ReactNode;
  /** Which field's unit to remember when the person switches it. */
  remember?: keyof MoneyPrefs["units"];
  /** Enter pressed in the field. */
  onEnter?: () => void;
}

export function AmountField({
  value,
  onChange,
  token,
  pricing,
  chips,
  testIdPrefix: prefix,
  inputTestId,
  label = "Amount",
  balance,
  remember,
  onEnter,
}: AmountFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;
  const [engaged, setEngaged] = useState(false);
  const [focused, setFocused] = useState(false);
  // Enter pressed on a typing mistake: say it now, though the field still has
  // focus, since the person has just asked for a price and got nothing.
  const [insisted, setInsisted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [reread, setReread] = useState<"idle" | "reading" | "failed">("idle");
  const styleFix = useRef<HTMLLabelElement>(null);

  const currency = unitCurrency(value.unit);
  const hasText = value.text.trim() !== "";
  // Rates are asked for when the field is first used, or holds money: the
  // page makes no reads for a field nobody has touched.
  const tick = useRatesNeeded(pricing, engaged || (currency !== null && hasText));
  // Sizing reads the clock itself; the tick only makes sure this re-renders.
  const now = Math.max(tick, perfNow());
  const locale = pricing?.locale ?? "en-US";
  // Null offers the token alone: a static unit, no menu.
  const menu = pricing === null ? null : unitChoices(token, pricing.currency, locale);

  // The chosen currency changed: an amount typed in one the field no longer
  // offers is cleared, never read again in another.
  const lastCurrency = useRef(pricing?.currency);
  useEffect(() => {
    const chosen = pricing?.currency;
    if (chosen === undefined || lastCurrency.current === chosen) return;
    lastCurrency.current = chosen;
    // A field that remembers no unit of its own keeps the one it has.
    const remembered = remember === undefined ? storedUnit(latest.current.unit) : moneyStore().get().units[remember];
    const next = afterCurrencyChange(latest.current, token, chosen, remembered);
    setNote(next.note);
    if (next.input !== latest.current) onChange(next.input);
    // Keyed on the currency alone: the field's own edits are not a change of currency.
  }, [pricing?.currency]);

  // A different token is a different trade: a money amount is sized for it
  // afresh, and a dollar amount in a USDC field is that many USDC.
  const lastToken = useRef(token.address);
  useEffect(() => {
    if (lastToken.current === token.address) return;
    lastToken.current = token.address;
    const moved = afterTokenChange(latest.current, token, pricing?.currency ?? "USD");
    onChange(pricing === null ? moved : withFrozen(moved, token, pricing, performance.now()));
  }, [token.address]);

  // A money amount typed before the first price arrived is sized once it
  // does: the first sizing, not a re-sizing.
  useEffect(() => {
    const current = latest.current;
    if (pricing === null || pricing.snapshot === null || unitCurrency(current.unit) === null || current.frozen !== null) return;
    const next = withFrozen(current, token, pricing, performance.now());
    if (next.frozen !== null) onChange(next);
  }, [pricing?.snapshot]);

  const type = (text: string) => {
    setNote(null);
    setReread("idle");
    setInsisted(false);
    const next = { ...value, text };
    onChange(pricing === null ? { ...next, frozen: null } : withFrozen(next, token, pricing, performance.now()));
  };

  const switchTo = (unit: AmountUnit) => {
    if (sameUnit(unit, value.unit)) return;
    // Money to the token keeps what the money came to; nothing else is
    // carried across, because "20" means something else in every unit.
    const carried =
      unit === "token" && value.frozen !== null ? formatAmountForField(value.frozen.raw, token.decimals, locale) : "";
    const next: AmountInput = { text: carried, unit, frozen: null };
    onChange(pricing === null ? next : withFrozen(next, token, pricing, performance.now()));
    setNote(null);
    setReread("idle");
    setEngaged(true);
    if (remember !== undefined) rememberUnit(remember, unit);
  };

  // The unit menu. A currency from "Change currency" becomes the page's
  // currency first, as the Settings menu would make it, then this field's
  // unit; the other field hears the change as it always has
  // (afterCurrencyChange). Focus stays on the menu.
  const chooseUnit = (stored: StoredUnit, changesCurrency: boolean) => {
    if (stored !== "token" && !isCurrencyCode(stored)) return;
    if (changesCurrency && stored !== "token") moneyStore().set({ ...moneyStore().get(), currency: stored });
    switchTo(stored === "token" ? "token" : { currency: stored });
  };

  const useNow = async () => {
    if (pricing === null) return;
    setReread("reading");
    const snapshot = await pricing.reread();
    if (snapshot === null) {
      setReread("failed");
      return;
    }
    setReread("idle");
    onChange(withFrozen({ ...latest.current, frozen: null }, token, { ...pricing, snapshot, state: "ready" }, performance.now()));
  };

  const field = pricing === null ? null : resolveField(value, token, pricing, now);
  const resolved = field?.resolved ?? null;
  const view = moneyView(pricing, now);
  // The first price is still on its way: a wait, not a problem.
  const waiting = currency !== null && hasText && pricing !== null && pricing.snapshot === null && pricing.state !== "unavailable";

  // ── The hint line ──
  let conversion: ReactNode = null;
  let fellBack = false;
  if (currency === null) {
    // The token itself: what it's worth, when there is a price to say so.
    const raw = resolved?.ok ? resolved.raw : 0n;
    const worth = raw > 0n && view !== undefined ? fiatOf(raw, token.address, view) : null;
    if (worth !== null) {
      conversion = (
        <>
          {formatFiat(worth.value, view!.locale, { approx: true })}
          {" · "}
          <Term tip={RATE_SOURCES_TIP} testId={`${prefix}-sources`}>
            sources
          </Term>
        </>
      );
    }
    fellBack = worth?.fellBack === true;
  } else if (hasText && resolved !== null) {
    if (resolved.ok && resolved.raw > 0n && resolved.at !== null) {
      const fx = currency === "USD" ? null : resolved.at.fx?.rates[currency];
      const read = readTime(resolved.at);
      // "avg 14:08" says what it is on a hover, tap or Tab, after the figure
      // money.spec parses.
      conversion = (
        <>
          = {formatAmount(resolved.raw, token.decimals, { maxFraction: token.decimals, locale })} {token.symbol} ·{" "}
          <Term tip={`The 10-minute average price, read at ${read}.`}>avg {read}</Term>
          {fx === null || fx === undefined ? null : ` · ${currency} rate ${weekdayClockText(fx.updatedAt)}`}
          {" · "}
          <Term tip={RATE_SOURCES_TIP} testId={`${prefix}-sources`}>
            sources
          </Term>
        </>
      );
    }
  }

  // ── What stops it, and the one tap that fixes it ──
  const switchButton = (
    <FixButton testId={`${prefix}-switch-token`} onClick={() => switchTo("token")}>
      Switch to {token.symbol}
    </FixButton>
  );
  // The network service failed the read (busy, no answer): read again, since
  // the token can't be priced either while it fails.
  const retryButton = (
    <FixButton testId={`${prefix}-retry-price`} disabled={reread === "reading"} onClick={() => void useNow()}>
      {reread === "reading" ? "Reading the price…" : "Try again"}
    </FixButton>
  );
  const serviceFailed = pricing?.failure ?? null;
  let problem: { text: string; fixes: ReactNode } | null = null;
  if (currency !== null && reread === "failed") {
    if (serviceFailed !== null) {
      problem = { text: serviceRatesText(serviceFailed), fixes: serviceFailed === "refused" ? null : retryButton };
    } else {
      const last = pricing?.snapshot ? ` (last read ${readTime(pricing.snapshot)})` : "";
      problem = { text: `spDEX couldn't read a current dollar price${last}. Type ${token.symbol} instead.`, fixes: switchButton };
    }
  } else if (resolved !== null && !resolved.ok && hasText && !waiting) {
    if (field!.ratesProblem) {
      problem = {
        text: resolved.error,
        fixes:
          resolved.fix?.kind === "reread" ? (
            <FixButton testId={`${prefix}-use-price-now`} disabled={reread === "reading"} onClick={() => void useNow()}>
              {reread === "reading" ? "Reading the price…" : "Use the price now"}
            </FixButton>
          ) : resolved.fix?.kind === "retry" ? (
            retryButton
          ) : serviceFailed === "refused" && pricing?.snapshot === null ? null : (
            switchButton
          ),
      };
    } else if (!focused || insisted) {
      const options = resolved.fix?.kind === "choose" ? resolved.fix.options : [];
      problem = {
        text: resolved.error,
        fixes: (
          <>
            {options.map((option, i) => (
              <FixButton key={option} testId={`${prefix}-choice-${i}`} onClick={() => type(option)}>
                {options.length === 1 ? `Use ${option}` : option}
              </FixButton>
            ))}
            {resolved.error.startsWith("In your number format") ? (
              // The setting itself, here, rather than a trip up the page to
              // it. Choosing a style that reads the amount clears the
              // problem, and this menu with it: focus goes back to the
              // amount rather than to nowhere.
              <label className="spdex-amount__style" ref={styleFix}>
                <span className="spdex-amount__style-label">Number style</span>
                <NumberStyleSelect
                  testId={`${prefix}-number-style`}
                  onChosen={() =>
                    requestAnimationFrame(() => {
                      if (styleFix.current === null) input.current?.focus({ preventScroll: true });
                    })
                  }
                />
              </label>
            ) : null}
          </>
        ),
      };
    }
  }

  // A newer price, offered and never applied by itself.
  const newer =
    currency !== null &&
    resolved?.ok === true &&
    value.frozen !== null &&
    pricing?.snapshot !== null &&
    pricing?.snapshot !== undefined &&
    pricing.snapshot.usdReadAt > value.frozen.at.usdReadAt
      ? pricing.snapshot
      : null;

  // Notes, only while there is something they explain. A figure shown in
  // dollars because the chosen currency has no rate says so, except where
  // the refusal above already has (a field in that very currency). USDC off
  // its dollar matters while money is being typed, since dollars are sized
  // as USDC.
  const notes: { testId: string; text: string }[] = [];
  const dollarsInstead =
    pricing !== null && view !== undefined && fallsBack(view) && (fellBack || (currency !== null && currency !== pricing.currency));
  if (hasText && dollarsInstead) {
    notes.push({
      testId: prefix === "amount" ? "money-fx-note" : `${prefix}-fx-note`,
      text: `${rateUnavailableLead(pricing.currency, pricing.snapshot)}; showing dollars.`,
    });
  }
  const peg = currency !== null && hasText && pricing !== null ? usdcPegNote(pricing.snapshot, pricing.locale) : null;
  if (peg !== null) notes.push({ testId: `${prefix}-usdc-note`, text: peg });

  const conversionId = `${id}-conversion`;
  const affix = unitAffix(value.unit, token, locale);
  const hints =
    conversion !== null || waiting || newer !== null ? (
      <div className="spdex-amount__hints" id={conversionId}>
        {conversion !== null ? (
          <span className="spdex-amount__hint" data-testid={`${prefix}-conversion`}>
            {conversion}
          </span>
        ) : waiting ? (
          <span className="spdex-amount__hint" data-testid={`${prefix}-conversion`}>
            Reading the price…
          </span>
        ) : null}
        {newer !== null ? (
          <span className="spdex-amount__hint" data-testid={`${prefix}-newer-price`}>
            Newer price from {readTime(newer)} ·{" "}
            <button
              type="button"
              className="spdex-amount__link"
              onClick={() => onChange(withFrozen({ ...value, frozen: null }, token, pricing!, performance.now()))}
            >
              Use it
            </button>
          </span>
        ) : null}
      </div>
    ) : null;
  // The one-tap amounts and the hint never show together: the chips only
  // while the field is empty, the hint only once something is typed.
  const foot = hasText ? hints : chips !== undefined ? <div className="spdex-amount__chips">{chips}</div> : null;

  return (
    <div className="spdex-amount" data-testid={`${prefix}-field`}>
      <div className="spdex-amount__head">
        <label className="spdex-field__label" htmlFor={id}>
          {label}
        </label>
        {balance === undefined || balance === null || balance === false ? null : (
          <span className="spdex-amount__balance">{balance}</span>
        )}
      </div>

      <div className="spdex-amount__box">
        {affix.leads ? (
          <span className="spdex-amount__affix spdex-amount__affix--lead" aria-hidden="true">
            {affix.text}
          </span>
        ) : null}
        <input
          ref={input}
          id={id}
          className="spdex-amount__input spdex-num"
          data-testid={inputTestId ?? `${prefix}-input`}
          inputMode="decimal"
          autoComplete="off"
          placeholder={`Amount in ${affix.name}`}
          aria-describedby={hasText && hints !== null ? conversionId : undefined}
          value={value.text}
          onFocus={() => {
            setEngaged(true);
            setFocused(true);
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => type(event.target.value)}
          onKeyDown={(event) => {
            // Enter asks for a price, as the button does. Only on Enter:
            // every quote runs module code and several chain reads.
            if (event.key !== "Enter") return;
            setInsisted(true);
            onEnter?.();
          }}
        />
        {menu === null ? (
          <span className="spdex-amount__affix spdex-amount__affix--trail" data-testid={`${prefix}-unit`}>
            {token.symbol}
          </span>
        ) : (
          <UnitSelect
            testId={`${prefix}-unit`}
            value={storedUnit(value.unit)}
            units={menu.units}
            others={menu.others}
            missing={menu.missing}
            onChoose={chooseUnit}
          />
        )}
      </div>

      {foot === null ? null : <div className="spdex-amount__foot">{foot}</div>}

      {problem !== null ? (
        <div className="spdex-amount__problem" data-testid={`${prefix}-problem`} role="status">
          <p className="spdex-amount__problem-text">{problem.text}</p>
          {problem.fixes === null ? null : <div className="spdex-amount__fixes">{problem.fixes}</div>}
        </div>
      ) : null}
      {note !== null ? (
        <p className="spdex-amount__note" data-testid={`${prefix}-note`} role="status">
          {note}
        </p>
      ) : null}
      {notes.map((n) => (
        <p key={n.testId} className="spdex-amount__note" data-testid={n.testId}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

function FixButton({
  children,
  onClick,
  testId,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="spdex-amount__fix"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The sign before the number ("$", where the locale writes it first; "25 €"
 * has none, the token none), and the unit as the placeholder names it:
 * "Amount in USD", short enough to fit beside the menu on a phone.
 */
function unitAffix(unit: AmountUnit, token: TokenInfo, locale: string): { text: string; leads: boolean; name: string } {
  if (unit === "token") return { text: token.symbol, leads: false, name: token.symbol };
  return { text: currencySymbol(unit.currency, locale), leads: symbolLeads(unit.currency, locale), name: unit.currency };
}
