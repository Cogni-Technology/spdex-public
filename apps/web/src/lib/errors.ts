/**
 * Errors and Guard codes, said so a newcomer can act on them.
 *
 * The raw messages are written for whoever debugs spDEX: "every pool for this
 * pair is excluded by your current pool policy" is exact, and useless to
 * someone who has never seen the word "pool policy". So the banner leads with
 * a title and a sentence that say what to do, and the raw message stays one
 * click away, verbatim, in "Details". Nothing is hidden, only reordered.
 *
 * Two rules the matching keeps:
 *
 * - **The asserted substrings survive.** e2e reads the error banner's text for
 *   "greater than zero", "pool policy" and "does not wrap". The first and last
 *   stay in the sentence itself; "pool policy" survives in the raw message,
 *   which is always in the DOM (a closed disclosure's text still counts).
 * - **Specific before general.** A relay's "HTTP 429" is about the relay, not
 *   the network service, so it is matched before the rate-limit rule and the
 *   generic HTTP rule; a refusal ("turned this page away": a key allowlisted
 *   elsewhere, revoked, or out of its month, which also comes as a 429)
 *   before a rate limit ("busy"), and that before "didn't answer".
 * - **The built-in service is not the newcomer's to fix.** Most people never
 *   chose a service: the built-in one was there (lib/store.ts). When it is the
 *   one failing, the sentence says so and says to wait, and choosing another
 *   service comes second, not first; when it refused, waiting won't help, so
 *   the sentence says what BuiltInServiceNotice says. A capped key's refusal
 *   usually reaches the page as "Failed to fetch" (its 429 carries no CORS
 *   headers), so that is read as "may be busy" too.
 *
 * A sentence that sends someone to a setting names it as the page does
 * (`PLACES`, "Settings → Sending"), and says which in `place`, so the banner
 * can end with the button that goes there. The network service is named by
 * its host only (lib/rpcDisplay.ts): its address often carries a key.
 */

import { formatNumber } from "./money/format.js";
import { PLACES, type PlaceKey } from "./places.js";
import { maskRpcUrl } from "./rpcDisplay.js";
import { formatAmount } from "./tokens.js";

export interface FriendlyError {
  title: string;
  /** One or two plain sentences: what happened and what to do. */
  sentence: string;
  /** The message as it was thrown, for "Details". */
  raw: string;
  /** The place the sentence sends the person to, for a `GoTo` after it; absent when it names none. */
  place?: PlaceKey;
  /**
   * What the network service did, when the failure is the service's: it
   * turned the page away, it is busy, or it didn't answer. Absent for
   * anything else, a relay's failure included.
   */
  service?: ServiceTrouble;
  /**
   * True when the fix is in what was typed or picked just above Get price
   * (an amount, a pair), so the title alone says it and the line under the
   * button needn't send anyone to the top of the page.
   */
  input?: true;
}

/** How the network service failed a request: turned it away for good, busy for now, or no answer. */
export type ServiceTrouble = "refused" | "busy" | "unreachable";

export interface FriendlyErrorContext {
  /** The network service in use, named (by its host) in "couldn't reach" sentences. */
  rpcUrl?: string | null;
  /** Whether that is this copy's built-in service (source "bundled"), which the person may never have chosen. */
  builtIn?: boolean;
}

/** "choose another service in Settings → Network service." */
const CHOOSE_ANOTHER = `choose another service in ${PLACES.networkService.label}.`;

/** The service in use, by its host, for a sentence's subject: "spDEX's built-in network service" when it is that one. */
function serviceName(context: FriendlyErrorContext, fallback: string): string {
  if (context.builtIn) return "spDEX's built-in network service";
  return context.rpcUrl ? maskRpcUrl(context.rpcUrl) : fallback;
}

interface Rule {
  test: RegExp;
  /** A fixed title, or one built from the raw message. */
  title: string | ((raw: string) => string);
  /** A fixed sentence, or one built from the raw message and context. */
  sentence: string | ((raw: string, context: FriendlyErrorContext) => string);
  place?: PlaceKey;
  service?: ServiceTrouble;
  input?: true;
}

/** What the built-in service answers when it won't serve this page, whatever the status. */
const REFUSED =
  /Monthly capacity limit exceeded|not on whitelist|not on (?:the )?allowlist|Must be authenticated|Invalid (?:access|API) key|App is inactive/i;

/**
 * The message Get price throws when the amount is more than the connected
 * wallet holds, which the rule above reads back: "Not enough ETH in your
 * wallet: it holds 0.02 ETH, and this swap needs 1 ETH and its network fee.
 * Enter less, or tap Max."
 */
export function notEnoughMessage(input: {
  symbol: string;
  held: bigint;
  wanted: bigint;
  decimals: number;
  /** Ether pays the network fee too, so the sentence says it is needed on top. */
  native: boolean;
  /** Whether Max offers anything: an empty wallet has nothing to fill in. */
  maxAvailable: boolean;
}): string {
  const { symbol, held, wanted, decimals } = input;
  const needs = `${formatAmount(wanted, decimals)} ${symbol}${input.native ? " and its network fee" : ""}`;
  const fix = input.maxAvailable ? "Enter less, or tap Max." : `Add ${symbol} to your wallet first.`;
  return `Not enough ${symbol} in your wallet: it holds ${formatAmount(held, decimals)} ${symbol}, and this swap needs ${needs}. ${fix}`;
}

/** What `notEnoughMessage` starts with; its group is the token's symbol. */
const NOT_ENOUGH = /^Not enough (\S+) in your wallet: it/;

const RULES: readonly Rule[] = [
  // Titled so that, as the line under Get price, each says what to fix on its
  // own: "enter an amount" beside an amount of 0 would not.
  { test: /greater than zero/, title: "Enter an amount above zero", sentence: (raw) => raw, input: true },
  { test: /Choose two different tokens/, title: "Pick two different tokens", sentence: (raw) => raw, input: true },
  {
    // Get price's own check against what the wallet holds (`notEnoughMessage`):
    // the fix is the amount, just above the button.
    test: NOT_ENOUGH,
    title: (raw) => `Not enough ${NOT_ENOUGH.exec(raw)?.[1] ?? "of it"} in your wallet`,
    sentence: (raw) => raw.replace(NOT_ENOUGH, "Your wallet"),
    input: true,
  },
  {
    // The wallet or the service refusing to send: the balance fell short of
    // the amount and the network fee together. A node estimating a
    // transaction that carries a fee says it another way: the gas it can
    // afford (the balance left after the value, over the fee per gas) is less
    // than the gas it needs, "gas required exceeds allowance (19999)". Only a
    // small allowance means that; one of a block's size (30 million and up)
    // means the transaction would use more gas than a block holds, which is
    // no shortage of ether.
    test: /insufficient funds|gas required exceeds allowance:? \(?\d{1,6}\)?(?!\d)/i,
    title: "Not enough ETH for this and its network fee",
    sentence:
      "Your wallet doesn't hold enough ETH to pay for this and its network fee, so nothing was sent. Enter less, or add ETH to your wallet.",
  },
  {
    test: /does not wrap/,
    title: "That's a wrap, not a swap",
    sentence:
      "ETH and WETH are the same asset, so there's nothing to swap. spDEX does not wrap — use your wallet or the WETH contract.",
  },
  {
    test: /excluded by your current pool policy/,
    title: "No markets allowed",
    sentence:
      `Your settings exclude every market for this pair. Change "Which markets may be used" in ${PLACES.markets.label}, or reset your settings.`,
    place: "markets",
  },
  {
    test: /no pools found/,
    title: "No market for this pair",
    sentence: "None of the exchanges switched on in Features has a market for this pair.",
  },
  {
    test: /no executable route/,
    title: "No way to make this swap",
    sentence: "spDEX couldn't find a route that works for this amount. Try a smaller amount.",
  },
  {
    test: /no EIP-1193 wallet/,
    title: "No wallet found",
    sentence: "Install a browser wallet such as MetaMask or Rabby, then reload this page.",
  },
  {
    // TransactionReplaced (lib/wallet.ts): the wallet's "Cancel", or another
    // send at the same nonce. The original can never be mined now.
    test: /was replaced in your wallet/,
    title: "Replaced in your wallet",
    sentence: "Your wallet sent something else in its place, so this didn't happen. Only that one's network fee was spent.",
  },
  {
    test: /reverted on chain/,
    title: "The transaction failed",
    sentence: "The network rejected it, so nothing was swapped. Only the network fee was spent.",
  },
  {
    test: /has not been mined after/,
    title: "Still waiting for the network",
    sentence:
      "Your transaction hasn't confirmed yet. It may still go through, so check your wallet before trying again.",
  },
  {
    test: /no relay endpoint/,
    title: "No private relay set",
    sentence: `Private sending is on but has no relay address. Add one in ${PLACES.sending.label}, or turn Private sending off in Features.`,
    place: "sending",
  },
  {
    test: /relay returned HTTP/,
    title: "The private relay didn't answer",
    sentence: "Try again, or turn Private sending off in Features.",
  },
  {
    // A key allowlisted to other sites, revoked, or out of its month: the same
    // answers `serviceRefusal` reads as a definite no. Before the busy rule,
    // since a monthly cap comes as a 429 and waiting a minute won't lift it.
    // On the built-in service, what BuiltInServiceNotice says.
    test: REFUSED,
    title: "The network service turned this page away",
    sentence: (_raw, context) =>
      context.builtIn
        ? `spDEX's built-in network service isn't serving this page, so spDEX can't read prices or check a swap through it. Choose another service in ${PLACES.networkService.label}.`
        : `${serviceName(context, "Your network service")} turned this page away, so spDEX can't read prices or check a swap through it. Check its key with its provider, or ${CHOOSE_ANOTHER}`,
    place: "networkService",
    service: "refused",
  },
  {
    // Alchemy's throughput limit, and the generic words for a rate limit.
    // After the relay rule: a relay's 429 is the relay's.
    test: /exceeded its compute units|\brate.?limit|too many requests|HTTP 429/i,
    title: "The network service is busy",
    sentence: (_raw, context) =>
      context.builtIn
        ? `spDEX's built-in network service is shared by everyone using this copy, and it's turning requests away for now. Try again in a minute. If it keeps happening, ${CHOOSE_ANOTHER}`
        : `${serviceName(context, "Your network service")} is turning requests away for now. Try again in a minute, or ${CHOOSE_ANOTHER}`,
    place: "networkService",
    service: "busy",
  },
  {
    test: /Failed to fetch|NetworkError|HTTP \d{3}/,
    title: "The network service didn't answer",
    sentence: (_raw, context) =>
      context.builtIn
        ? `spDEX's built-in network service didn't answer. It may be busy, or your internet may be down: try again in a minute. If it keeps happening, ${CHOOSE_ANOTHER}`
        : `spDEX couldn't reach ${serviceName(context, "your network service")}. Check your internet, or ${CHOOSE_ANOTHER}`,
    place: "networkService",
    service: "unreachable",
  },
];

const FALLBACK = {
  title: "Something went wrong",
  sentence: "spDEX couldn't finish that. The details below say what happened.",
};

/** A banner title and sentence for a thrown message; the message itself is kept as `raw`. */
export function friendlyError(message: string, context: FriendlyErrorContext = {}): FriendlyError {
  for (const rule of RULES) {
    if (!rule.test.test(message)) continue;
    const sentence = typeof rule.sentence === "string" ? rule.sentence : rule.sentence(message, context);
    return {
      title: typeof rule.title === "string" ? rule.title : rule.title(message),
      sentence,
      raw: message,
      ...(rule.place === undefined ? {} : { place: rule.place }),
      ...(rule.service === undefined ? {} : { service: rule.service }),
      ...(rule.input === undefined ? {} : { input: rule.input }),
    };
  }
  return { ...FALLBACK, raw: message };
}

/**
 * The line under Get price when a price couldn't be got: the banner's title
 * as a clause, and where the rest is. Short on purpose, since on a phone the
 * banner at the top of the page is a screen or more above the button, and
 * the line only has to say that something went wrong and where to look.
 * When the fix is in the fields just above the button (`input`), the title
 * says it and the line sends nobody to the top.
 */
export function quoteProblemLine(title: string, { input = false }: { input?: boolean } = {}): string {
  const clause = title.charAt(0).toLowerCase() + title.slice(1);
  const said = `Couldn't get a price: ${clause.replace(/[.]$/, "")}.`;
  return input ? said : `${said} More at the top of the page.`;
}

/**
 * The line under Swap when a swap stopped with an error: the banner's title
 * as a clause, and where the rest is, for the reason `quoteProblemLine`
 * gives. A person who declined, or a wallet that can't send privately, gets
 * its own line instead (App's `onSwap`).
 */
export function swapProblemLine(title: string): string {
  const clause = title.charAt(0).toLowerCase() + title.slice(1);
  return `Swap stopped: ${clause.replace(/[.]$/, "")}. More at the top of the page.`;
}

/** BuiltInServiceNotice's title, for the line under Get price while the notice stands in for the banner. */
export const BUILT_IN_REFUSED_TITLE = "The built-in network service isn't working here";

/**
 * Where the page says an error: the banner at the top, and, when a Get price
 * failed, the line under the button.
 *
 * While the built-in service's refusal notice is up, an error about the
 * network service (busy, no answer, turned away) gets no banner: under the
 * notice it would say the same thing again, and "busy, try again in a minute"
 * of a service that won't come back. The line under the button then names
 * the notice's title instead.
 */
export function errorPlacement(
  friendly: FriendlyError | null,
  { refusedNoticeShown, fromQuote }: { refusedNoticeShown: boolean; fromQuote: boolean },
): { banner: FriendlyError | null; quoteLine: string | null } {
  if (friendly === null) return { banner: null, quoteLine: null };
  const banner = refusedNoticeShown && friendly.service !== undefined ? null : friendly;
  const quoteLine = !fromQuote
    ? null
    : banner === null
      ? quoteProblemLine(BUILT_IN_REFUSED_TITLE)
      : quoteProblemLine(friendly.title, { input: friendly.input === true });
  return { banner, quoteLine };
}

/**
 * The service's answer when it definitely refused (not merely busy or
 * unreachable), else null: for the built-in-service notice.
 *
 * Definite means the page read an answer that says no: HTTP 401 or 403, a
 * JSON-RPC "invalid request" (-32600) to a question as plain as
 * `eth_chainId`, or one of Alchemy's refusals (a key allowlisted elsewhere,
 * deleted, or out of its month). A busy answer (429, -32005) or no answer at
 * all is not: the failing read's own message says the service is busy or
 * didn't answer, and the next read may work. (The status panel says BUSY or
 * OFFLINE only when its own read, on load or ↻, meets that; it doesn't poll,
 * so it can still say ONLINE.) A browser reads no answer from a refusal without CORS
 * headers ("Failed to fetch"), so this can say null where the service did
 * refuse; it never says refused where it didn't.
 */
export function serviceRefusal(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const message = error instanceof Error ? error.message : String(error);
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (REFUSED.test(message)) return message;
  if (status === 401 || status === 403) return message;
  if (status === 429 || code === 429 || code === -32005) return null;
  if (code === -32600) return message;
  return null;
}

/**
 * One plain sentence per Guard code.
 *
 * Used wherever a code has to be explained to a person: the safety-check
 * banner, a skipped auto-buy's history row, a refused vault transaction. The
 * code itself is always shown beside the sentence (small, in mono), because
 * the sentence is a translation and the code is the fact.
 */
const GUARD_SENTENCES: Readonly<Record<string, string>> = {
  SIMULATION_REVERTED: "The test run failed: this transaction wouldn't go through right now.",
  SIMULATION_UNAVAILABLE: "Your network service can't run the safety test.",
  MIN_OUT_NOT_MET: "You'd receive less than the minimum shown.",
  RECIPIENT_MISMATCH: "The tokens wouldn't arrive in your wallet.",
  MAX_IN_EXCEEDED: "It would take more than the amount you entered.",
  UNEXPECTED_TOKEN_TRANSFER: "Another token would leave your wallet.",
  UNEXPECTED_ETH_TRANSFER: "ETH would leave your wallet that shouldn't.",
  UNEXPECTED_APPROVAL: "It would grant a permission that wasn't declared.",
  APPROVAL_EXCEEDS_INTENT: "It asks permission to spend more than this swap needs.",
  APPROVAL_UNDECLARED_SPENDER: "It asks permission for a contract the plug-in didn't declare.",
  UNDECLARED_TARGET: "It calls a contract the plug-in didn't declare.",
  PERMIT2_TARGET: "It reaches for Permit2, whose permissions would outlast this swap. A swap here never needs it.",
  INTENT_MISMATCH: "The transaction doesn't match the swap you asked for.",
  CHAIN_MISMATCH: "It's for a different network.",
  DEADLINE_EXPIRED: "The price is out of date. Get a fresh price.",
  UNDECODABLE_EFFECTS: "spDEX couldn't read what it would do.",
  UNDECODABLE_CALLDATA: "spDEX couldn't read what it would do.",
  TIP_EXCEEDS_LIMIT: "A tip didn't match what you set up.",
  TIP_MALFORMED: "A tip didn't match what you set up.",
  TIP_NOT_DELIVERED: "A tip didn't match what you set up.",
  SCHEDULE_MISMATCH: "This buy didn't match the plan (pair, network, wallet or price floor).",
  SCHEDULE_EXCEEDS_BUY: "This buy was bigger than the plan's amount per buy.",
  SCHEDULE_EXCEEDS_BUDGET: "This buy would go past the plan's total, or its record couldn't be read.",
  SCHEDULE_NOT_DUE: "This buy wasn't due yet, or its buy time already had a buy.",
  VAULT_MALFORMED: "This didn't match your vault or its plan (the contract, the amount or the terms).",
  VAULT_NOT_DELIVERED: "The money wouldn't arrive in full, in the vault or back with you.",
  SECOND_OPINION_UNAVAILABLE: "Your second network service didn't answer, so this was checked on one service only.",
};

/** The second service's host as the violation named it ("alchemy.com"), or null when it named none. */
function secondServiceName(detail: Readonly<Record<string, string>> | undefined): string | null {
  const host = detail?.["host"]?.trim();
  return host ? host : null;
}

/**
 * The second opinion's refusal. It names the host and where the setting is,
 * because a config pasted from a file is applied without the staged summary
 * that would otherwise have said a second opinion was switched on.
 *
 * It never blames the second service or suggests removing it. The Guard
 * can't tell which of the two is wrong, and the threat the second opinion
 * exists for is a main service that lies: that service disagrees with the
 * second on every transaction it targets, so "remove the one that keeps
 * disagreeing" would steer the person to delete the check that caught it.
 */
function secondOpinionDisagrees(detail: Readonly<Record<string, string>> | undefined): string {
  const host = secondServiceName(detail);
  const setting =
    host === null ? `your second opinion (${PLACES.safety.label})` : `your second opinion, ${host} (${PLACES.safety.label})`;
  const keep = `Try again in a moment. If it keeps happening, try another main service rather than removing ${setting}.`;
  switch (detail?.["reason"]) {
    case "heads":
      return (
        "Your two network services' latest blocks are too far apart to compare their test-runs, so spDEX won't let you sign this. " +
        `Either one could be behind, your main service included. ${keep}`
      );
    case "block-hash":
      return (
        "Your two network services report different blocks at the same height, so spDEX can't compare their test-runs and won't let you sign this. " +
        `Either one could be wrong, your main service included. ${keep}`
      );
    default:
      return (
        "Your two network services disagree about what this would do, so spDEX won't let you sign it. " +
        `Either one could be wrong, your main service included. ${keep}`
      );
  }
}

/** "The batcher holds 0.0001 WETH someone sent it, …", exact to the wei, or without a figure when none was given. */
function batchUnaccounted(detail: Readonly<Record<string, string>> | undefined): string {
  const swept = detail?.["swept"];
  // Strictly digits: a missing or garbled figure is left out, never shown as 0.
  const amount =
    typeof swept === "string" && /^\d+$/.test(swept) && BigInt(swept) > 0n
      ? `${formatAmount(BigInt(swept), 18, { maxFraction: 18 })} WETH`
      : "WETH";
  return (
    `The batcher holds ${amount} someone sent it, and this batch would pass it to you. ` +
    "spDEX won't make you the receiver of money it can't account for."
  );
}

/**
 * "24.58": a divergence in basis points as a percentage, or null when the
 * figure isn't a whole number of basis points (so it is never shown as 0).
 */
export function bpsAsPercent(bps: string | number | undefined): string | null {
  // Strings are read strictly: `Number("")` is 0, which would turn a missing
  // figure into "0% away".
  const value = typeof bps === "number" ? bps : typeof bps === "string" && /^\d+$/.test(bps) ? Number(bps) : Number.NaN;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return formatNumber(value / 100, { maximumFractionDigits: 2 });
}

/**
 * The sentence for a Guard code.
 *
 * `detail` is the violation's machine-readable detail; ORACLE_DIVERGENCE
 * reads its `divergenceBps` from there. Without it the sentence says "far
 * from" rather than inventing a figure. SECOND_OPINION_DISAGREES reads
 * `host` and `reason` (`heads`, `block-hash`, or anything else for a
 * disagreement about effects), SIMULATION_UNAVAILABLE reads `failure` (the
 * main service failed before a comparison with the second opinion), and
 * VAULT_BATCH_UNACCOUNTED reads `swept` (wei); each says less, never
 * something made up, when they are missing.
 * An unknown code gets a sentence that
 * still points at the code, so a code added to the Guard later is shown
 * rather than swallowed.
 */
export function guardSentence(code: string, detail?: Readonly<Record<string, string>>): string {
  if (code === "ORACLE_DIVERGENCE") {
    const percent = bpsAsPercent(detail?.["divergenceBps"]);
    const how = percent === null ? "far from" : `${percent}% away from`;
    return `The price is ${how} the 10-minute average price. It's still checked; just worth a second look.`;
  }
  if (code === "SECOND_OPINION_DISAGREES") return secondOpinionDisagrees(detail);
  // The same code for a main service that failed before its test-run could be
  // compared with the second opinion's: it may have run the test fine.
  if (code === "SIMULATION_UNAVAILABLE" && detail?.["failure"] !== undefined) {
    return "Your main network service failed before its test-run could be compared with your second opinion's, so this wasn't checked.";
  }
  if (code === "VAULT_BATCH_UNACCOUNTED") return batchUnaccounted(detail);
  return GUARD_SENTENCES[code] ?? "The safety check flagged this (see the code).";
}

/**
 * One entry per code, first occurrence kept.
 *
 * A split route reports the same violation once per leg; listing it twice
 * says nothing new, and two elements with the same test id make a
 * Playwright locator ambiguous.
 */
export function uniqueByCode<T extends { code: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.code) ? false : (seen.add(item.code), true)));
}
