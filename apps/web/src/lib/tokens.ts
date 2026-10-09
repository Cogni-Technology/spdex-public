/**
 * The built-in token list.
 *
 * Small and hardcoded on purpose. A token list is a trust decision — it decides
 * which contract the word "USDC" points at — so it belongs to the user, and the
 * `tokenlist` module kind exists to let them supply their own. Until that lands,
 * shipping a handful of verified entries is more honest than shipping a large
 * list nobody has checked.
 *
 * Decimals were read on-chain, not assumed. SPX has 8, not 18.
 *
 * One entry is not a contract at all: native ether, carried under the
 * pseudo-address the simulation layer already uses for it. See `NATIVE_ETH`.
 */

import { NATIVE_TOKEN, TOKENS, isNativeToken } from "@spdex/chain";
import { decimalMark, displayLocale } from "./money/format.js";

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

/**
 * Native ether, as a token the user can pick.
 *
 * `0xeeee…eeee` is not a contract. It is the pseudo-address `eth_simulateV1`
 * uses when reporting native movement as a Transfer log, and reusing it here
 * means the intent, the Guard's effect analysis and the UI all name the native
 * asset the same way — rather than each carrying its own special case.
 *
 * There is no native pool behind it. v2 and v3 pools are always ERC-20 pairs,
 * so every route still goes through WETH; what changes is which of the
 * router's entry points the venue encodes, so the wrap happens inside the swap
 * instead of as a transaction of its own.
 */
export const NATIVE_ETH: TokenInfo = {
  address: NATIVE_TOKEN,
  symbol: "ETH",
  decimals: 18,
};

/** ETH first: it is what someone arrives holding. */
export const TOKEN_LIST: TokenInfo[] = [NATIVE_ETH, TOKENS.SPX, TOKENS.WETH, TOKENS.USDC];

/** True when this is native ether rather than an ERC-20. */
export function isNative(token: TokenInfo): boolean {
  return isNativeToken(token.address);
}

/**
 * The ERC-20 a token trades as.
 *
 * Native ether has no pool of its own, so discovery, quoting and routing all
 * operate on WETH and only the final encoding differs. Everything upstream of
 * `buildCalls` should be asking for this rather than branching on ETH.
 */
export function tradedAs(token: TokenInfo): TokenInfo {
  return isNative(token) ? TOKENS.WETH : token;
}

export function tokenBySymbol(symbol: string): TokenInfo {
  const token = TOKEN_LIST.find((t) => t.symbol === symbol);
  if (!token) throw new Error(`unknown token ${symbol}`);
  return token;
}

/**
 * Ether held back from "use all", so the swap can still be paid for.
 *
 * Selling every last wei leaves nothing to sign with, and the failure arrives
 * *after* the user has committed — the approval or the swap simply cannot be
 * broadcast. A hundredth of an ether covers a swap at any plausible gas price
 * and is small enough not to feel like the app is keeping something back.
 *
 * Only applies to native ether. An ERC-20 balance is spendable to the last
 * unit, because gas is paid in something else.
 */
export const GAS_RESERVE_WEI = 10n ** 16n;

/** What "use all" should actually fill in for a given token. */
export function spendableBalance(balance: bigint, token: TokenInfo): bigint {
  if (!isNative(token)) return balance;
  return balance > GAS_RESERVE_WEI ? balance - GAS_RESERVE_WEI : 0n;
}

export interface FormatOptions {
  /** Digits after the point. Defaults to 6. */
  maxFraction?: number;
  /**
   * Thousands separators. On for display, off for anything that will be read
   * back — an input field, a config value, a test assertion.
   */
  group?: boolean;
  /**
   * The number format: its grouping and decimal mark. The page's own
   * (`displayLocale`, en-US until the person's is set) when unset.
   */
  locale?: string;
}

/**
 * Format base units for display, trimming trailing zeros.
 *
 * `group` exists because this function has two callers with opposite needs:
 * the one rendering a balance wants "10,000.5", and the one filling the amount
 * field wants something `parseDecimal` (lib/money/parse.ts) will read back
 * exactly. Grouping is therefore opt-out rather than unconditional.
 */
export function formatAmount(
  value: bigint,
  decimals: number,
  options: number | FormatOptions = {},
): string {
  // The third argument used to be a bare `maxFraction`; both spellings work so
  // existing call sites keep meaning what they say.
  const { maxFraction = 6, group = true, locale = displayLocale() } =
    typeof options === "number" ? { maxFraction: options } : options;

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const wholeText = group ? whole.toLocaleString(locale) : whole.toString();
  const text = fraction ? `${wholeText}${decimalMark(locale)}${fraction}` : wholeText;
  return negative ? `-${text}` : text;
}

/**
 * The exact amount in machine format: full precision, no grouping, and "."
 * as the decimal mark whatever the person's number format.
 *
 * Machine format because what reads it back is code, not a field: tip flows
 * compare it with what a wallet reports. A field is written with the
 * person's own decimal mark instead (`formatAmountForField`, money/format.ts),
 * so "use all" reads back in their format.
 */
export function formatAmountExact(value: bigint, decimals: number): string {
  return formatAmount(value, decimals, { maxFraction: decimals, group: false, locale: "en-US" });
}
