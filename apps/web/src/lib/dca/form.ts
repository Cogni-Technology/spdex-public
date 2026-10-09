/**
 * The Recurring form, as pure functions: what the fields mean, what is wrong
 * with them, and the sentences the form shows while they are being filled in.
 *
 * The form is where someone agrees to a standing instruction to spend money, so
 * everything it says is computed from exactly what would be saved — the same
 * parse feeds the summary, the fee line, the validation message and the plan
 * that Start writes. Nothing here reads a clock, the network or storage: the
 * component passes `now`, the fees it read and the balance it read, so every
 * sentence can be pinned by a test.
 *
 * Two rules carry over from the rest of the auto-buy layer:
 *
 * - **Refuse, never clamp.** A count of 1,500 is an error to show, not a
 *   quiet 1,000. What the person typed is what they agreed to, or nothing is.
 * - **Unknown is never zero.** A field that does not parse shows as "—" in the
 *   summary; a fee that was not read is "shown once current fees are read",
 *   never "0 ETH"; a balance that was not read produces no balance warning,
 *   because "enough for 0 buys" would be a claim.
 */

import { estimateBuyGas, isNativeToken, type PreparedFees } from "@spdex/chain";
import {
  MAX_DCA_BUYS,
  MAX_DCA_INTERVAL_SECONDS,
  MAX_DCA_PLANS,
  MIN_DCA_INTERVAL_SECONDS,
  type DcaPlan,
  type DcaSigner,
} from "@spdex/core";
import { buyFee } from "@spdex/vault";
import { fiatCostText, fiatOf, type MoneyView } from "../money/convert.js";
import { CURRENCY_NAMES } from "../money/currency.js";
import { bpsPercentText, formatCount, formatFiat, formatNumber } from "../money/format.js";
import { APP_NUMBER_LOCALE, parseDecimal } from "../money/parse.js";
import type { AmountInput, FiatAmount, Pricing, RateSnapshot } from "../money/pricing.js";
import { readTime, resolveField } from "../money/resolve.js";
import { formatAmount, TOKEN_LIST, tradedAs, type TokenInfo } from "../tokens.js";
import { ethUpTo, everyLabel, timesLabel } from "./format.js";
import {
  DEFAULT_VAULT_SLIPPAGE_BPS,
  defaultVaultWindow,
  VAULT_CAP_WEI,
  vaultCapText,
  vaultCosts,
  vaultPlanProblems,
  type VaultCosts,
} from "./vault.js";

/** The most a transaction with these fees can pay per gas. */
function feeCap(fees: PreparedFees): bigint {
  return fees.type === "eip1559" ? fees.maxFeePerGas : fees.gasPrice;
}

// ── Fields ────────────────────────────────────────────────────────────────

/**
 * How often, as the form offers it.
 *
 * Worded as the sentence reads ("Every day") rather than as format.ts's
 * compact labels, because a `<select>` shows its option text as the answer to
 * "How often". The ids and seconds are the same.
 */
export const FORM_FREQUENCIES = [
  { id: "1h", label: "Every hour", seconds: 3_600 },
  { id: "1d", label: "Every day", seconds: 86_400 },
  { id: "1w", label: "Every week", seconds: 604_800 },
  { id: "2w", label: "Every 2 weeks", seconds: 1_209_600 },
  { id: "30d", label: "Every 30 days", seconds: 2_592_000 },
] as const;

/** The Expert-only frequency: a number of minutes. */
export const CUSTOM_FREQUENCY = "custom";
export const MIN_CUSTOM_MINUTES = MIN_DCA_INTERVAL_SECONDS / 60;
export const MAX_CUSTOM_MINUTES = MAX_DCA_INTERVAL_SECONDS / 60;

export interface RecurringFields {
  /** Token symbols, as the selects hold them. */
  sell: string;
  buy: string;
  /** As typed. */
  amount: string;
  /** A `FORM_FREQUENCIES` id, or `CUSTOM_FREQUENCY`. */
  frequency: string;
  customMinutes: string;
  count: string;
  firstBuy: "now" | "later";
  /** A `datetime-local` value, read in this device's time zone. */
  startAt: string;
  label: string;
  signer: DcaSigner;
}

/**
 * What the form starts at: ETH → SPX, every day, ten times, confirmed in the
 * wallet. ETH because it is what a newcomer arrives holding; the wallet
 * signer because it is the one that keeps spDEX from holding anything, and
 * because someone who wants to set a plan and forget it should choose that,
 * with its costs and its unaudited contract, on purpose.
 */
export function initialFields(): RecurringFields {
  return {
    sell: "ETH",
    buy: "SPX",
    amount: "",
    frequency: "1d",
    customMinutes: "60",
    count: "10",
    firstBuy: "now",
    startAt: "",
    label: "",
    signer: "wallet",
  };
}

/** True when the two are one asset (ETH and WETH): a "buy" between them would be a wrap. */
export function sameAsset(a: TokenInfo, b: TokenInfo): boolean {
  return tradedAs(a).address === tradedAs(b).address;
}

/**
 * What a plan paying with `sellSymbol` may buy: every listed token but the one
 * it pays with, and but its wrapped or unwrapped twin. Offering WETH to an ETH
 * plan would only produce a validation error one click later.
 */
export function buyChoices(sellSymbol: string, tokens: readonly TokenInfo[] = TOKEN_LIST): TokenInfo[] {
  const sell = tokens.find((token) => token.symbol === sellSymbol);
  return tokens.filter((token) => token.symbol !== sellSymbol && !(sell !== undefined && sameAsset(sell, token)));
}

/**
 * The fields after Pay with changed. Buy is kept when it is still allowed;
 * otherwise it moves to SPX, the token this app is about, or failing that to
 * the first allowed token — never left pointing at a pair the select no
 * longer offers.
 */
export function withSell(fields: RecurringFields, sell: string, tokens: readonly TokenInfo[] = TOKEN_LIST): RecurringFields {
  const choices = buyChoices(sell, tokens);
  if (choices.some((token) => token.symbol === fields.buy)) return { ...fields, sell };
  const buy = choices.find((token) => token.symbol === "SPX") ?? choices[0];
  return { ...fields, sell, buy: buy?.symbol ?? fields.buy };
}

/**
 * A `datetime-local` value ("2026-10-01T09:30") as unix seconds, in this
 * device's time zone, or null for anything else.
 */
export function datetimeLocalToUnix(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  const ms = date.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ── Parsing ───────────────────────────────────────────────────────────────

/** The fields read as a plan's terms. Each is null when it does not parse. */
export interface ParsedForm {
  sell: TokenInfo | null;
  buy: TokenInfo | null;
  /** Base units; 0n when the amount is empty, zero or can't be read (all three stop the plan). */
  amountPerBuy: bigint;
  /**
   * Why the amount as typed can't be read, in words that say what to type
   * ("0,5" where the decimal mark is "."), or null. Never read some other way.
   */
  amountError: string | null;
  /**
   * The money the amount was typed in and the rates it was sized with, when
   * it was typed in money; null for a token amount. `amountPerBuy` is what
   * that came to, and is what the plan saves.
   */
  conversion: { typed: FiatAmount; at: RateSnapshot } | null;
  /**
   * The amount is in money and waits on the rates (still reading, too old
   * to size with, or a currency without one) rather than on what was typed:
   * Start waits for "Use the price now" or a switch to the token.
   */
  amountWaitsOnRates: boolean;
  intervalSeconds: number | null;
  /** The custom interval as typed, in minutes, when "Custom…" is chosen (for its own error). */
  customMinutes: number | null;
  custom: boolean;
  maxBuys: number | null;
  /** Why the count as typed can't be read ("2,5" where the decimal mark is "."), or null. */
  countError: string | null;
  /** Unix seconds of a chosen first buy, or null for "now". */
  startAt: number | null;
  /** A later first buy was asked for and its time does not parse. */
  startAtInvalid: boolean;
  label: string | undefined;
}

/**
 * The amount field as the form's money layer sees it: its unit and frozen
 * sizing (the text is `fields.amount`), the page's rates, and
 * `performance.now()`. Without it the amount is read in the token, in the
 * app's default number format.
 */
export interface FormMoney {
  input: Omit<AmountInput, "text">;
  pricing: Pricing;
  nowMs: number;
}

/** The amount in base units, why it can't be read, and what money it was typed in. */
function readAmount(
  fields: RecurringFields,
  sell: TokenInfo | null,
  money: FormMoney | undefined,
): { value: bigint; error: string | null; conversion: ParsedForm["conversion"]; waits: boolean } {
  if (sell === null) return { value: 0n, error: null, conversion: null, waits: false };
  if (money === undefined) {
    const parsed = parseDecimal(fields.amount, APP_NUMBER_LOCALE, sell.decimals, { symbol: sell.symbol });
    return parsed.ok
      ? { value: parsed.value, error: null, conversion: null, waits: false }
      : { value: 0n, error: parsed.error, conversion: null, waits: false };
  }
  const { resolved, ratesProblem } = resolveField({ ...money.input, text: fields.amount }, sell, money.pricing, money.nowMs);
  if (!resolved.ok) return { value: 0n, error: resolved.error, conversion: null, waits: ratesProblem };
  const conversion = resolved.typed !== null && resolved.at !== null ? { typed: resolved.typed, at: resolved.at } : null;
  return { value: resolved.raw, error: null, conversion, waits: false };
}

/**
 * Read the fields. Expert-only fields count only in Expert: a custom interval,
 * a later first buy and a name typed there and left behind when switching to
 * Simple must not quietly shape a plan the Simple form does not show.
 */
export function parseForm(
  fields: RecurringFields,
  options: { expert: boolean; tokens?: readonly TokenInfo[]; money?: FormMoney },
): ParsedForm {
  const tokens = options.tokens ?? TOKEN_LIST;
  const sell = tokens.find((token) => token.symbol === fields.sell) ?? null;
  const buy = tokens.find((token) => token.symbol === fields.buy) ?? null;
  const amount = readAmount(fields, sell, options.money);
  const amountPerBuy = amount.value;

  const custom = options.expert && fields.frequency === CUSTOM_FREQUENCY;
  let intervalSeconds: number | null = null;
  let customMinutes: number | null = null;
  if (custom) {
    const typed = fields.customMinutes.trim();
    customMinutes = /^\d{1,9}$/.test(typed) ? Number(typed) : null;
    intervalSeconds =
      customMinutes !== null && customMinutes >= MIN_CUSTOM_MINUTES && customMinutes <= MAX_CUSTOM_MINUTES
        ? customMinutes * 60
        : null;
  } else {
    intervalSeconds = FORM_FREQUENCIES.find((f) => f.id === fields.frequency)?.seconds ?? FORM_FREQUENCIES[1].seconds;
  }

  // Read as the amount is, in the page's number format: "1,000" and "1.000"
  // are a thousand where each is the group mark, and "2,5" is refused rather
  // than read as 25 (the comma-stripping this replaced).
  const countRead = parseDecimal(fields.count, options.money?.pricing.locale ?? APP_NUMBER_LOCALE, 0);
  const count = countRead.ok && fields.count.trim() !== "" && countRead.value <= 10_000_000n ? Number(countRead.value) : null;
  const maxBuys = count !== null && count >= 1 && count <= MAX_DCA_BUYS ? count : null;
  const countError = countRead.ok ? null : countRead.error;

  const later = options.expert && fields.firstBuy === "later";
  const startAt = later ? datetimeLocalToUnix(fields.startAt) : null;
  const label = options.expert && fields.label.trim() !== "" ? fields.label.trim().slice(0, 64) : undefined;

  return {
    sell,
    buy,
    amountPerBuy,
    amountError: amount.error,
    conversion: amount.conversion,
    amountWaitsOnRates: amount.waits,
    intervalSeconds,
    customMinutes,
    custom,
    maxBuys,
    countError,
    startAt,
    startAtInvalid: later && startAt === null,
    label,
  };
}

/**
 * The first thing wrong with the form, in the order the fields are read, or
 * null: one problem at a time, beside the field it is about, in words that
 * say what to type rather than which rule failed.
 */
export function validationError(
  parsed: ParsedForm,
  context: { nowMs: number; planCount: number },
): string | null {
  if (parsed.amountError !== null) return parsed.amountError;
  if (parsed.amountPerBuy <= 0n) return "Enter an amount greater than zero.";
  if (parsed.sell === null || parsed.buy === null || parsed.sell.symbol === parsed.buy.symbol) {
    return "Choose two different tokens.";
  }
  if (sameAsset(parsed.sell, parsed.buy)) return "ETH and WETH are the same asset, so that's a wrap, not a buy.";
  if (parsed.maxBuys === null) return parsed.countError ?? `Choose between 1 and ${formatCount(1_000)} buys.`;
  if (parsed.custom && parsed.intervalSeconds === null) {
    if (parsed.customMinutes !== null && parsed.customMinutes > MAX_CUSTOM_MINUTES) {
      return "The longest interval is 366 days.";
    }
    return "The shortest interval is 5 minutes.";
  }
  if (parsed.startAtInvalid || (parsed.startAt !== null && parsed.startAt * 1000 <= context.nowMs)) {
    return "Choose a first-buy time in the future.";
  }
  if (context.planCount >= MAX_DCA_PLANS) {
    return `You already have ${MAX_DCA_PLANS} auto-buys, the most spDEX allows. Delete one to add another.`;
  }
  return null;
}

// ── The plan Start writes ─────────────────────────────────────────────────

/** "dca-" and eight hex digits from four random bytes: the host makes ids, never a module. */
export function planIdFrom(bytes: Uint8Array): string {
  if (bytes.length < 4) throw new Error("a plan id needs four random bytes");
  return `dca-${[...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The plan a valid form describes.
 *
 * A wallet plan is written running: Start is the first buy's confirmation. A
 * vault plan is written paused and stays so — this tab never runs it; its
 * vault does — and its `nowSeconds` should be chain time (`vaultStartAt` in
 * vault.ts). The label is left out, not written empty, when there is none
 * (the schema refuses "").
 */
export function buildPlan(
  parsed: ParsedForm,
  options: { id: string; chainId: number; signer: DcaSigner; nowSeconds: number },
): DcaPlan {
  if (parsed.sell === null || parsed.buy === null || parsed.intervalSeconds === null || parsed.maxBuys === null) {
    throw new Error("the form is not complete");
  }
  return {
    id: options.id,
    ...(parsed.label === undefined ? {} : { label: parsed.label }),
    paused: options.signer === "vault",
    chainId: options.chainId,
    sell: parsed.sell.address,
    buy: parsed.buy.address,
    amountPerBuy: parsed.amountPerBuy.toString(),
    intervalSeconds: parsed.intervalSeconds,
    maxBuys: parsed.maxBuys,
    startAt: parsed.startAt ?? options.nowSeconds,
    signer: options.signer,
  };
}

// ── Sentences ─────────────────────────────────────────────────────────────

/** Formats unix seconds for a sentence: a date, with the time when it matters. */
export type DateFormatter = (unixSeconds: number, withTime: boolean) => string;

/** "Oct 1" or "Oct 1, 14:05", in this device's locale and time zone. */
export const localDate: DateFormatter = (unixSeconds, withTime) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).format(new Date(unixSeconds * 1000));

/** An amount of a token with every digit the person typed, grouped. */
function exact(value: bigint, token: TokenInfo): string {
  return formatAmount(value, token.decimals, { maxFraction: token.decimals });
}

/**
 * "≈ $2.60" or "≈ €2.26": what an amount of `token` is worth in the page's
 * currency, or null when that isn't known — no rates, none for this token, or
 * no amount yet.
 *
 * The rates are the page's (the same 10-minute average prices the safety
 * check compares against), so the two tabs can't name different figures for
 * the same amount. Null leaves the figure off the screen: a missing rate is
 * unknown, never "$0". For the same reason a real amount worth less than a
 * cent reads "< $0.01" rather than the "$0.00" rounding would print. Where
 * the currency's rate is unknown the figure is in dollars, and the amount
 * field says so.
 */
export function fiatText(amount: bigint, token: TokenInfo | null, money: MoneyView | undefined): string | null {
  if (token === null || money === undefined || amount <= 0n) return null;
  const value = fiatOf(amount, token.address, money);
  return value === null ? null : formatFiat(value.value, money.locale, { approx: true });
}

/** "$20.00 at 14:02": what was typed, and when the price it was sized with was read, as You pay says it. */
export function typedText(conversion: NonNullable<ParsedForm["conversion"]>, locale: string): string {
  return `${formatFiat(conversion.typed, locale)} at ${readTime(conversion.at)}`;
}

/** What the summary says until there is an amount: a sentence of dashes explains nothing. */
export const NO_AMOUNT_SUMMARY = "Enter an amount to see your plan.";

/**
 * The live one-sentence summary (`dca-form-summary`).
 *
 * "0.01 ETH of SPX every day, 10 times: 0.1 ETH in all ≈ $26.00, ending Oct 1
 * at the earliest." — "at the earliest" because a missed buy time is
 * skipped and the plan runs on past it. Until an amount is entered there is
 * no plan to describe, so it asks for one; an amount that can't be read one
 * way says what to type instead, here where it is seen while typing rather
 * than only after Start. After that, a field that does not parse reads "—",
 * so the sentence never states a figure the form does not hold. The total's
 * "≈" figure appears only when `money` prices what the plan pays with.
 *
 * An amount typed in money leads with the token amount it came to, then the
 * money in brackets with the time of the price: "0.0081589 ETH ($20.00 at
 * 14:02) of SPX every day". The total then has no "≈":
 * the money figure would only be the typed amount again, through the same
 * price, which confirms nothing.
 */
export function summaryText(
  parsed: ParsedForm,
  options: { signer: DcaSigner; nowMs: number; formatDate?: DateFormatter; money?: MoneyView },
): string {
  if (parsed.amountError !== null) return parsed.amountError;
  if (parsed.sell === null || parsed.amountPerBuy <= 0n) return NO_AMOUNT_SUMMARY;
  const date = options.formatDate ?? localDate;
  const sellSymbol = parsed.sell.symbol;
  const buySymbol = parsed.buy?.symbol ?? "—";
  const typed = parsed.conversion === null ? "" : ` (${typedText(parsed.conversion, options.money?.locale ?? "en-US")})`;
  const amount = `${exact(parsed.amountPerBuy, parsed.sell)} ${sellSymbol}${typed}`;
  const interval = parsed.intervalSeconds;
  const withTime = interval !== null && interval < 86_400;

  if (parsed.maxBuys === 1) {
    const when = parsed.startAt === null ? "now" : `on ${date(parsed.startAt, true)}`;
    return `${amount} of ${buySymbol} once, ${when}.`;
  }

  const every = interval === null ? "every —" : everyLabel(interval);
  const times = parsed.maxBuys === null ? "— times" : timesLabel(parsed.maxBuys);
  const totalAmount = parsed.maxBuys === null ? null : parsed.amountPerBuy * BigInt(parsed.maxBuys);
  const total = totalAmount === null ? "—" : exact(totalAmount, parsed.sell);
  const worth = totalAmount === null || parsed.conversion !== null ? null : fiatText(totalAmount, parsed.sell, options.money);
  const totalWorth = worth === null ? "" : ` ${worth}`;
  const first = parsed.startAt === null ? "" : `, first buy ${date(parsed.startAt, true)}`;
  const start = parsed.startAt ?? Math.floor(options.nowMs / 1000);
  const end =
    interval !== null && parsed.maxBuys !== null ? date(start + (parsed.maxBuys - 1) * interval, withTime) : "—";

  let sentence = `${amount} of ${buySymbol} ${every}, ${times}: ${total} ${sellSymbol} in all${totalWorth}${first}, ending ${end} at the earliest.`;
  if (options.signer === "wallet" && interval !== null && interval < 86_400) {
    const perDay = Math.ceil(86_400 / interval) * (isNativeToken(parsed.sell.address) ? 1 : 2);
    sentence += ` You'd confirm ${formatCount(perDay)} times a day.`;
  }
  return sentence;
}

/** Current network fees, as the form knows them. */
export type FeeRead = { kind: "reading" } | { kind: "ok"; fees: PreparedFees } | { kind: "error"; message: string };

export interface FeeEstimate {
  /** Wei: the most the plan's network fees can come to at today's fees. */
  upTo: bigint;
  /** `upTo` as a percentage of what the plan spends, or null when that isn't known in ETH. */
  sharePercent: number | null;
  /** Whether what the plan pays with has a price in ETH; when it has, a missing share only means no amount yet. */
  priced: boolean;
  /**
   * A vault plan's figures: its buys' gas is paid by whoever triggers them,
   * out of the buy fee each buy pays, so the plan's own cost is the buy fees
   * plus creating the vault. `upTo` is their sum.
   */
  vault?: VaultCosts;
}

/**
 * The network fees a plan can cost, sized at `maxFeePerGas` (so "up to").
 *
 * - Wallet: every buy's gas budget (`estimateBuyGas`: a swap, or a permission
 *   and a swap for a token) at today's fee cap.
 * - Vault: its buy fees and creating it (`vaultCosts`).
 *
 * The share is only worked out when the plan pays with ETH or WETH, which are
 * worth exactly one ETH each. For any other token it would need a price, and
 * a guessed price would make a guessed percentage.
 */
export function feeEstimate(parsed: ParsedForm, signer: DcaSigner, fees: PreparedFees): FeeEstimate | null {
  if (parsed.sell === null || parsed.maxBuys === null) return null;
  if (signer === "vault") {
    const costs = vaultCosts({ amountPerBuy: parsed.amountPerBuy, maxBuys: parsed.maxBuys, fees });
    if (costs === null || costs.createFee === null) return null;
    const upTo = costs.rewardsTotal + costs.createFee;
    const total = parsed.amountPerBuy * BigInt(parsed.maxBuys);
    const sharePercent = total > 0n ? Number((upTo * 1_000_000n) / total) / 10_000 : null;
    return { upTo, sharePercent, priced: true, vault: costs };
  }
  const sellIsNative = isNativeToken(parsed.sell.address);
  const upTo = BigInt(parsed.maxBuys) * estimateBuyGas(sellIsNative ? "native" : "token") * feeCap(fees);
  const priceInEth = sellIsNative || tradedAs(parsed.sell).address === tradedAs(TOKEN_LIST[0]!).address;
  const total = parsed.amountPerBuy * BigInt(parsed.maxBuys);
  const sharePercent = priceInEth && total > 0n ? Number((upTo * 1_000_000n) / total) / 10_000 : null;
  return { upTo, sharePercent, priced: priceInEth };
}

/** "3.5", "0.04", "120": a percentage with the precision that says something. */
export function percentText(value: number): string {
  return formatNumber(value, { maximumFractionDigits: value < 1 ? 2 : 1 });
}

/**
 * The `dca-form-fees` line: what the plan costs over its life, as one line
 * of figures. A wallet plan's is a bound (every buy's gas limit at today's
 * fee cap), so it says "up to"; a vault's is an estimate (fixed buy fees and
 * the creation's estimated gas), so it says "≈". In money when a rate is
 * known, else in ETH, then the share of the plan: "Fees ≈ $1.47 (0.74%)
 * over the plan". A vault's parts are in `feesBreakdown`, one tap away.
 *
 * `share: false` leaves the share of the plan out, for when the fee warning's
 * title already says it ("Fees could reach 540.7% of this plan"): the figure
 * once, not twice in two lines.
 */
export function feesText(read: FeeRead, estimate: FeeEstimate | null, money?: MoneyView, opts?: { share?: boolean }): string {
  if (read.kind === "reading") return "Network fees: shown once current fees are read.";
  if (read.kind === "error") return "Network fees: unknown — spDEX couldn't read current fees.";
  if (estimate === null) return "Network fees: —";
  // "≈ $1.47", or the ETH figure when no rate is known.
  const worth = fiatCostText(estimate.upTo, money);
  const v = estimate.vault;
  if (v !== undefined && v.createFee !== null) {
    // A keeper pays each buy's gas and is paid the buy fee from the vault, so
    // the buy fees are what the buys cost; creating the vault is the one
    // transaction the owner's wallet pays gas for.
    const share = estimate.sharePercent === null || opts?.share === false ? "" : ` (${percentText(estimate.sharePercent)}%)`;
    return `Fees ${worth ?? `≈ ${ethUpTo(estimate.upTo)} ETH`}${share} over the plan, at today's fees.`;
  }
  // With no amount yet there is no share to give, and "share unknown" would
  // read as if a price were missing.
  const share =
    opts?.share === false
      ? ""
      : estimate.sharePercent !== null
        ? ` (${percentText(estimate.sharePercent)}%)`
        : estimate.priced
          ? ""
          : " (share unknown)";
  return `Network fees: up to ${worth?.replace(/^≈\s/, "") ?? `${ethUpTo(estimate.upTo)} ETH`}${share} over the plan, at today's fees.`;
}

/**
 * A vault plan's fees in parts, for the tip at the end of `feesText`: the buy
 * fees (each, and its share of a buy) and creating the vault. Null for a
 * wallet plan, whose line is already one figure.
 */
export function feesBreakdown(estimate: FeeEstimate | null): string | null {
  const v = estimate?.vault;
  if (v === undefined || v.createFee === null) return null;
  return (
    `${ethUpTo(v.rewardsTotal)} ETH in buy fees (${ethUpTo(v.fee.reward)} ETH a buy, ` +
    `${bpsPercentText(v.fee.shareBps)}% of each${v.fee.atCeiling ? ", the most it can be" : ""}) and about ` +
    `${ethUpTo(v.createFee)} ETH in network fees to create the vault.`
  );
}

/** Above this share of the plan, the form warns (it never blocks). */
export const FEE_WARNING_PERCENT = 5;

/** The fee warning's title, or null when fees are a reasonable share (or the share isn't known). */
export function feeWarningTitle(estimate: FeeEstimate | null): string | null {
  if (estimate === null || estimate.sharePercent === null || estimate.sharePercent <= FEE_WARNING_PERCENT) return null;
  // "Could reach": the figure is every gas limit at the most each unit of
  // gas may cost today, a bound the buys usually come in well under.
  return `Fees could reach ${percentText(estimate.sharePercent)}% of this plan`;
}

/**
 * The wallet ChoiceCard's cost line. `networkFee` is one buy's network fee at
 * today's fees, as the card beside it gives the vault's buy fee (vaultCopy's
 * `walletFeeText`); null until fees are read, and for a token plan, whose
 * permission and buy aren't the one ETH buy that figure is for.
 */
export function walletCostText(sell: TokenInfo | null, networkFee: string | null = null): string {
  if (sell !== null && !isNativeToken(sell.address)) return "2 confirmations and 2 network fees per buy: a permission, then the buy.";
  return networkFee === null ? "1 network fee a buy." : `${networkFee}, at today's fees.`;
}

/**
 * The balance warning (wallet plans only), or null.
 *
 * Only from a balance that was read: an unread one is not zero, and "enough
 * for 0 of 10 buys" from a failed read would be a false alarm stated as fact.
 */
export function balanceWarning(parsed: ParsedForm, signer: DcaSigner, balance: bigint | null | undefined): string | null {
  if (signer !== "wallet" || balance === null || balance === undefined) return null;
  if (parsed.sell === null || parsed.amountPerBuy <= 0n || parsed.maxBuys === null) return null;
  const covered = balance / parsed.amountPerBuy;
  if (covered >= BigInt(parsed.maxBuys)) return null;
  return (
    `Your wallet holds ${formatAmount(balance, parsed.sell.decimals)} ${parsed.sell.symbol}: ` +
    `enough for ${covered.toString()} of ${formatCount(parsed.maxBuys)} buys. ` +
    "A buy your wallet can't pay for is skipped."
  );
}

/** The Start button's words for a startable form. */
export function startLabel(signer: DcaSigner, startAt: number | null, formatDate: DateFormatter = localDate): string {
  if (signer === "vault") return "Create and fund vault";
  return startAt === null ? "Start auto-buy — first buy now" : `Start auto-buy — first buy ${formatDate(startAt, true)}`;
}

/**
 * "What will be saved": the plan as the config will hold it, for Expert.
 * Built from the same `buildPlan` Start uses, so it can't disagree with it.
 */
export function planPreview(
  parsed: ParsedForm,
  options: { id: string; chainId: number; signer: DcaSigner; nowSeconds: number },
): string {
  try {
    return JSON.stringify(buildPlan(parsed, options), null, 2);
  } catch {
    return "(complete the form to see the plan)";
  }
}

/**
 * For an amount typed in money, the tip after the summary (`dca-form-fiat-fixed`):
 * what the plan saves is the token amount the summary leads with, and each
 * buy spends exactly that, so its worth in money moves. Said before Start,
 * because "$20 each time" is what someone who typed $20 would otherwise
 * believe. Null for a token amount.
 */
export function fixedAmountWhy(parsed: ParsedForm, signer: DcaSigner): string | null {
  if (parsed.conversion === null || parsed.sell === null || parsed.amountPerBuy <= 0n) return null;
  const name = CURRENCY_NAMES[parsed.conversion.typed.currency];
  const symbol = parsed.sell.symbol;
  const whose = signer === "vault" ? `The ${symbol} shown is written into the vault` : `Each buy spends exactly the ${symbol} shown`;
  return `${whose}, so what a buy is worth in ${name} will go up and down.`;
}

// ── Vault plans ───────────────────────────────────────────────────────────

/**
 * What stops the form's plan becoming a vault, the first thing only, or null:
 * that it pays with ETH and buys SPX, that each buy is large enough to pay a
 * buy fee (`MIN_VAULT_BUY_WEI`), and every term the vault factory checks — the
 * 0.5 ETH you can put in included, which counts each buy's fee: `buyFee`'s,
 * the one the form shows, which depends on the amount alone — and the
 * community window: Expert's choice (`communityWindow`), else the plan's
 * default (`defaultVaultWindow`). A window chosen in Expert and then left
 * above a quarter of a shorter interval is refused here, never clamped. For
 * the vault choice, beside `validationError`, which covers the rest.
 */
export function vaultFormError(
  parsed: ParsedForm,
  maxSlippageBps = DEFAULT_VAULT_SLIPPAGE_BPS,
  money?: MoneyView,
  communityWindow?: number | null,
): string | null {
  if (parsed.sell === null || parsed.buy === null || parsed.amountPerBuy <= 0n) return null;
  if (parsed.intervalSeconds === null || parsed.maxBuys === null) return null;
  const window = communityWindow ?? defaultVaultWindow(parsed.intervalSeconds);
  if (window === null) return null;
  const problems = vaultPlanProblems(
    {
      sell: parsed.sell.address,
      buy: parsed.buy.address,
      amountPerBuy: parsed.amountPerBuy.toString(),
      intervalSeconds: parsed.intervalSeconds,
      maxBuys: parsed.maxBuys,
      // The start is judged against chain time when the vault is created; the
      // form checks everything else.
      startAt: 0,
    },
    { maxSlippageBps, keeperReward: buyFee(parsed.amountPerBuy).reward, communityWindow: window },
    0,
  );
  const problem = problems[0] ?? null;
  return problem === null ? null : withCapInMoney(problem, money);
}

/**
 * The vault's 0.5 ETH limit with its worth beside it, "0.5 ETH (≈ $1,225)",
 * for someone who typed money. Still a refusal: the limit is ether, and the
 * money only says how much that is today.
 */
function withCapInMoney(problem: string, money: MoneyView | undefined): string {
  const worth = fiatText(VAULT_CAP_WEI, TOKEN_LIST[0]!, money);
  const cap = vaultCapText();
  return worth === null ? problem : problem.replace(cap, `${cap} (${worth})`);
}

/**
 * The balance warning for a vault plan, or null: creating the vault sends
 * its whole budget, every buy and its buy fee, from the owner's wallet in one
 * transaction — which fails if the wallet can't cover it and its fee. Only
 * from a balance that was read. Before fees are read the budget alone is
 * weighed, and the creation's network fee is named without a figure.
 */
export function vaultBalanceWarning(costs: VaultCosts | null, balance: bigint | null | undefined): string | null {
  if (costs === null || balance === null || balance === undefined) return null;
  if (balance >= costs.budget + (costs.createFee ?? 0n)) return null;
  const fee = costs.createFee === null ? "its network fee" : `about ${ethUpTo(costs.createFee)} ETH in network fees`;
  return (
    `Your wallet holds ${formatAmount(balance, 18)} ETH. Creating this vault sends ${ethUpTo(costs.budget)} ETH — ` +
    `every buy and its buy fee — plus ${fee}.`
  );
}
