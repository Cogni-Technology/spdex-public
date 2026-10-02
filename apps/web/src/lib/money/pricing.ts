/**
 * The money layer's shared shapes: which currencies there are, what a rate
 * read returns, what a fiat figure is, and what an amount field holds.
 *
 * Types, and the constants that define them, nothing else. They were fixed
 * first, so the features building on them could be built at the same time,
 * and from here they only grow: a change that isn't additive breaks
 * someone else's half-built feature. The functions that work on them are
 * beside this file, in convert.ts, resolve.ts, format.ts, rates.ts and
 * prefs.ts.
 *
 * Two rules hold for every figure these describe:
 * - **Unknown is never zero.** A rate that couldn't be read, is stale, or is
 *   outside its band is null or absent, and a figure built on it is dropped
 *   or refused. It is never shown as 0.
 * - **Money is for typing and reading only.** Every plan and swap is saved,
 *   checked and signed in token amounts. A currency is a way to arrive at a
 *   token amount, never a unit anything is stored or signed in.
 */


// ─── Currencies ───────────────────────────────────────────────────────────────

/**
 * US dollars, and the 16 currencies with a Chainlink rate on Ethereum that
 * spDEX can read through the person's own network service.
 *
 * Others people ask for (INR, HKD, SEK, NOK, PLN, ZAR) have no such rate, and
 * reading one from anywhere else would mean asking a third party.
 */
export const CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "KRW",
  "CNY",
  "CHF",
  "CAD",
  "AUD",
  "SGD",
  "NZD",
  "BRL",
  "MXN",
  "TRY",
  "IDR",
  "ARS",
  "PHP",
] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** The currencies priced through a Chainlink feed: every one but USD. */
export type FxCurrencyCode = Exclude<CurrencyCode, "USD">;

// ─── Rate reads ───────────────────────────────────────────────────────────────

/** One Chainlink feed's answer, as read. */
export interface FxAnswer {
  /** The raw answer: US dollars per one unit of the currency, times 10^decimals. */
  answer: bigint;
  /** The feed's decimals as read in the same call, which must equal the build's table. */
  decimals: number;
  /** When the feed last updated, in unix seconds of chain time. */
  updatedAt: number;
}

/**
 * One read of every FX feed, and USDC/USD, in a single request.
 *
 * The request is identical whatever currency the person uses, USD included,
 * so the network service learns nothing about where they are from it.
 */
export interface FxSnapshot {
  /** The block the read was answered at. */
  block: bigint;
  /**
   * That block's timestamp, in unix seconds. Staleness is measured against
   * this, never the device clock, as the vault code does.
   */
  chainTime: number;
  /** A currency that is absent is unknown. */
  rates: Partial<Record<FxCurrencyCode, FxAnswer>>;
  /** USDC/USD, for the note when USDC drifts from $1; null when unknown. */
  usdc: FxAnswer | null;
  /**
   * ETH/USD, which the 10-minute average's ether price is checked against
   * (convert.ts `usdRateOf`) and a record's ether is priced by at its block;
   * absent or null when unknown.
   */
  eth?: FxAnswer | null;
}

/** Everything one rate read gave, and when, by this tab's clock. */
export interface RateSnapshot {
  /**
   * Raw USDC per raw token, times 1e18, by lowercase token address, as
   * `loadUsdRates` (stats.ts) returns them. A token that is absent is unpriced.
   */
  usd: ReadonlyMap<string, bigint>;
  /**
   * `performance.now()` when `usd` was read. Never the wall clock: the
   * 5-minute bound on sizing must not move when someone changes the device's
   * time.
   */
  usdReadAt: number;
  /** Null until the FX feeds have been read once. */
  fx: FxSnapshot | null;
  /** `performance.now()` when `fx` was read, or null with it. */
  fxReadAt: number | null;
}

/**
 * How old a snapshot may be and still turn typed money into a token amount
 * that gets signed: 5 minutes, by `performance.now()`. A snapshot read before
 * the tab was last hidden can't size an amount either, however young it is.
 */
export const SIZING_MAX_AGE_MS = 300_000;

/**
 * How old a snapshot may be and still be shown as a "≈" figure: 30 minutes.
 * Past that the figure is unknown, and dropped. The looser bound only governs
 * what is shown; the stricter one above governs what is signed.
 */
export const DISPLAY_MAX_AGE_MS = 1_800_000;

/** Where a page's rates come from: the two Engine methods the money layer uses. */
export interface RateSource {
  /** The same answers as `loadUsdRates`, from the Engine's own 10-minute average oracle. */
  usdRates(tokens: readonly string[]): Promise<Map<string, bigint>>;
  /** One read of every FX feed; null when it failed. */
  fxRates(): Promise<FxSnapshot | null>;
}

/** How the network service failed a rate read: turned the page away, busy, or no answer. */
export type RatesFailure = "refused" | "busy" | "unreachable";

/** The page's rates and money preferences, as every money figure reads them. */
export interface Pricing {
  /** The latest successful read, or null before the first. */
  snapshot: RateSnapshot | null;
  /**
   * "idle" until something on screen needs a rate, since the default page
   * makes no background reads; "unavailable" when the last read failed and
   * nothing usable is held.
   */
  state: "idle" | "reading" | "ready" | "unavailable";
  /**
   * Why the last dollar read failed, when the network service failed it: it
   * turned the page away, is busy, or didn't answer (lib/errors.ts
   * `ServiceTrouble`). Absent or null when the read worked, or failed with the
   * service answering. Only says why; `state` still says whether a price is
   * held.
   */
  failure?: RatesFailure | null;
  /** The currency the person chose, or the one their browser's region implies. */
  currency: CurrencyCode;
  /** The number format amounts are read and written in, as a BCP 47 tag. */
  locale: string;
  /** `performance.now()` when the tab was last hidden, or null if it hasn't been. */
  lastHiddenAt: number | null;
  /** Something on screen needs rates: start the first read, or keep refreshes going. */
  request(): void;
  /** Read now, before sizing an amount. Resolves to the new snapshot, or null when the read failed. */
  reread(): Promise<RateSnapshot | null>;
}

// ─── Figures and amounts ──────────────────────────────────────────────────────

/** An amount of money, never of a token. */
export interface FiatAmount {
  /** Millionths of the currency's unit, whatever the currency; formatting rounds to its own digits. */
  minor6: bigint;
  currency: CurrencyCode;
}

/**
 * What an amount field's text is in: the field's own token, or a currency.
 * A currency is carried by its code, so "20" can never be read again in
 * another one.
 */
export type AmountUnit = "token" | { currency: CurrencyCode };

/** What an amount field holds. */
export interface AmountInput {
  /** Exactly as typed. */
  text: string;
  unit: AmountUnit;
  /**
   * The token amount a money amount was sized to, and the rates it was sized
   * with. Kept so that re-renders and background refreshes never convert it
   * again: only the person, pressing "Use the price now", does. Null for
   * token units, and until a money amount is first resolved.
   */
  frozen: { raw: bigint; typed: FiatAmount; at: RateSnapshot } | null;
}

/**
 * How a refused amount can be put right with one tap: read the price again
 * and use it ("Use the price now"), type one of the options, or, when the
 * network service failed the read, try the read again ("Try again").
 */
export type AmountFix = { kind: "reread" } | { kind: "choose"; options: string[] } | { kind: "retry" };

/** A field's amount in the token's base units, or the sentence that says why there is none. */
export type ResolvedAmount =
  | {
      ok: true;
      raw: bigint;
      /** What was typed, when it was money; null for token units. */
      typed: FiatAmount | null;
      /** The rates a money amount was sized with; null for token units. */
      at: RateSnapshot | null;
    }
  | { ok: false; error: string; fix?: AmountFix };

export interface FormatFiatOptions {
  /** Compact notation, as pool tables use ("$1.2M"). */
  compact?: boolean;
  /** Lead with "≈". */
  approx?: boolean;
}

// ─── Preferences ──────────────────────────────────────────────────────────────

/**
 * Where this browser keeps its money preferences.
 *
 * They are facts about the person, not instructions to move money, so they
 * stay in this browser and never enter the config, exports or share links:
 * in a shared config a currency would mark the preset as customised and add
 * noise to the one diff people have to read.
 *
 * The stored JSON may hold only some of `MoneyPrefs`, and a reader takes each
 * field on its own, falling back field by field, and never throws. The e2e
 * fixtures (e2e/fixtures.ts) write exactly
 * `{"units":{"once":"token","recurring":"token"}}` and nothing else.
 */
export const MONEY_PREFS_KEY = "spdex.money.v1";

/**
 * How numbers are written: "auto" follows the browser, and each other style
 * is the locale that writes numbers that way (1,234.56 · 1.234,56 · 1 234,56 ·
 * 1’234.56 · 1,23,456.78).
 */
export const NUMBER_STYLES = ["auto", "en-US", "de-DE", "fr-FR", "de-CH", "en-IN"] as const;

export type NumberStyle = (typeof NUMBER_STYLES)[number];

/** An amount unit as stored: "token" or a currency code, never a word like "local" that could change meaning. */
export type StoredUnit = "token" | CurrencyCode;

export interface MoneyPrefs {
  currency: CurrencyCode;
  numbers: NumberStyle;
  /**
   * The unit each amount field was last switched to. Null until the person
   * first switches it, and then the field starts in `currency`.
   */
  units: { once: StoredUnit | null; recurring: StoredUnit | null };
}

/** The page's one copy of the money preferences, shared by every component and kept in step across tabs. */
export interface MoneyStore {
  get(): MoneyPrefs;
  set(p: MoneyPrefs): void;
  subscribe(listener: () => void): () => void;
}
