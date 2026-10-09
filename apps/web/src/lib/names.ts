/**
 * What each listed token is called, for display only.
 *
 * The token list (tokens.ts) is a trust decision and carries only what the
 * chain says: address, symbol, decimals. A symbol alone is a puzzle to a
 * newcomer ("WETH?"), so the selects show "WETH — Wrapped Ether". The names
 * live here, apart from the list, because nothing may ever branch on them: an
 * `<option>`'s value stays the bare symbol, which is what the app and the tests
 * select by.
 */

export const TOKEN_NAMES: Readonly<Record<string, string>> = {
  ETH: "Ether",
  SPX: "SPX6900",
  WETH: "Wrapped Ether",
  USDC: "USD Coin",
};

/** "ETH — Ether"; just the symbol for a token with no name here. */
export function tokenOptionText(symbol: string): string {
  const name = TOKEN_NAMES[symbol];
  return name === undefined ? symbol : `${symbol} — ${name}`;
}

/**
 * What the unavoidable words mean, for `<Term tip={GLOSSARY.x}>`.
 *
 * One definition per word, shared by every screen that uses it, so "network
 * service" can't mean one thing in the status strip and another in the
 * recurring form. A tip is real text in the DOM and counts toward its
 * parent's `textContent`, which is why none of these says "Refused" (the
 * preview banner must never contain it) or "depth " (the expert pool picker
 * must never contain it); names.test.ts pins both.
 */
export const GLOSSARY = {
  networkService:
    "spDEX has no server. It reads prices and sends your transactions through a network service (an RPC endpoint): the one you choose when you first open it. Whoever runs it sees your IP address, what you look up and what you send.",
  network: "Which blockchain you're using. Your wallet has to be on the same one as spDEX.",
  networkFee:
    "A small payment in ETH to the network for processing a transaction. It goes to the network, not to spDEX.",
  priceTolerance:
    "How far the price may move against you before the swap cancels itself. At 0.5% you get at least 99.5% of the estimate, or the swap cancels itself and you pay only the network fee.",
  safetyCheck:
    "Before you sign, spDEX test-runs this exact transaction on the live network without sending it, and only lets you sign if the result matches what you were shown. It needs a network service that can test-run transactions.",
  permission:
    "Before an exchange can take a token (not ETH) from your wallet, you give it permission for exactly this amount. Your wallet asks you to confirm that, then the swap.",
  market: "A pool of two tokens anyone can swap against. Bigger pools move less when you swap.",
  part: "A swap can be split across several markets for a better price. Each part is its own transaction.",
  weth: "Wrapped Ether: ETH as a token, always worth exactly 1 ETH.",
  dollarCostAveraging:
    "Buying a fixed amount on a schedule instead of all at once, so over time you pay roughly the average price.",
  buyTime:
    "Time is split into equal slots the length of your interval. spDEX makes at most one buy per slot and skips a slot it missed. The Expert view calls a slot a window.",
  spendingWallet:
    "A separate wallet an earlier version of spDEX made in this browser to buy for you without asking. spDEX doesn't use it any more. Its key has no password: anyone who can use this browser, or a malicious extension in it, could take it, so take back what's in it.",
  tenMinuteAverage:
    "When Uniswap v3 has one for the pair, spDEX compares each swap's price with the average over the last 10 minutes and warns you when they're far apart. Not every pair has one.",
  privateSending:
    "Sending your transaction to a private relay instead of the public queue, so it isn't visible where bots watch for swaps to jump ahead of. The relay's operators and the block builders it passes it to still see it.",
  plugIn:
    "Code spDEX loads to add a capability, like an exchange or pool statistics. Plug-ins can suggest a swap; they can't sign anything.",
  key: "The secret that controls a wallet. Whoever has it can spend what the wallet holds.",
} as const satisfies Record<string, string>;
