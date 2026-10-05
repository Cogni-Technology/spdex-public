/**
 * Friendly errors and Guard sentences.
 *
 * The e2e suite reads the error banner's text for three substrings — "greater
 * than zero", "pool policy" and "does not wrap" — and the banner now shows a
 * friendly title and sentence first, with the raw message in a closed
 * "Details". These tests pin that each asserted substring survives: in the
 * visible sentence where it can, and always in `raw`, which the banner keeps
 * in the DOM. The messages are the ones the code actually throws.
 */

import { describe, expect, it } from "vitest";
import { GUARD_VIOLATIONS } from "@spdex/core";
import {
  bpsAsPercent,
  errorPlacement,
  friendlyError,
  guardSentence,
  notEnoughMessage,
  quoteProblemLine,
  serviceRefusal,
  swapProblemLine,
  uniqueByCode,
} from "./errors.js";
import { PLACES } from "./places.js";

const THROWN = {
  zero: "Enter an amount greater than zero.",
  same: "Choose two different tokens.",
  wrap: "ETH and WETH are the same asset — spDEX swaps, it does not wrap. Use the WETH contract.",
  policy: "every pool for this pair is excluded by your current pool policy",
  noPools: "no pools found for this pair on any enabled venue",
  noRoute: "no executable route found",
  noWallet: "no EIP-1193 wallet found in this browser",
  reverted: "transaction 0x12345678… reverted on chain",
  notMined: "transaction 0x12345678… has not been mined after 120s. It may still confirm.",
  noRelay: "private submission is selected but no relay endpoint is configured",
  relayHttp: "relay returned HTTP 429",
  fetch: "Failed to fetch",
  firefox: "NetworkError when attempting to fetch resource.",
  http: "endpoint returned HTTP 503",
};

describe("friendlyError", () => {
  it("keeps every substring the e2e suite asserts", () => {
    const zero = friendlyError(THROWN.zero);
    expect(zero.sentence).toContain("greater than zero");
    expect(zero.raw).toContain("greater than zero");

    const wrap = friendlyError(THROWN.wrap);
    expect(wrap.sentence).toContain("does not wrap");
    expect(wrap.raw).toContain("does not wrap");

    const policy = friendlyError(THROWN.policy);
    expect(policy.raw).toContain("pool policy");
    expect(policy.title).toBe("No markets allowed");
  });

  it("reads a node's small gas allowance as too little ether, and a block-sized one as nothing of the kind", () => {
    // What anvil and geth say when the balance left after the value can't buy
    // the gas at the fee the transaction carries.
    for (const raw of ["Out of gas: gas required exceeds allowance: 19999", "gas required exceeds allowance (21000)"]) {
      expect(friendlyError(raw).title).toBe("Not enough ETH for this and its network fee");
    }
    // A transaction that would use more gas than a block holds: no shortage of ether.
    expect(friendlyError("gas required exceeds allowance (30000000)").title).not.toBe("Not enough ETH for this and its network fee");
  });

  it("says a transaction the wallet replaced with something else didn't happen", () => {
    const raw = `transaction 0xaaaaaaaa… was replaced in your wallet by 0xbbbbbbbb…, which doesn't make it; nothing it would have done happened`;
    expect(friendlyError(raw)).toMatchObject({ title: "Replaced in your wallet" });
    expect(friendlyError(raw).sentence).toContain("didn't happen");
  });

  it("titles each known failure", () => {
    expect(friendlyError(THROWN.zero)).toMatchObject({ title: "Enter an amount above zero", sentence: THROWN.zero, input: true });
    expect(friendlyError(THROWN.same)).toMatchObject({ title: "Pick two different tokens", sentence: THROWN.same });
    expect(friendlyError(THROWN.wrap).title).toBe("That's a wrap, not a swap");
    expect(friendlyError(THROWN.noPools).title).toBe("No market for this pair");
    expect(friendlyError(THROWN.noRoute).title).toBe("No way to make this swap");
    expect(friendlyError(THROWN.noWallet).title).toBe("No wallet found");
    expect(friendlyError(THROWN.reverted).title).toBe("The transaction failed");
    expect(friendlyError(THROWN.notMined).title).toBe("Still waiting for the network");
    expect(friendlyError(THROWN.noRelay).title).toBe("No private relay set");
  });

  it("blames the relay, not the network service, for a relay's HTTP error", () => {
    expect(friendlyError(THROWN.relayHttp).title).toBe("The private relay didn't answer");
  });

  it("names the network service it couldn't reach", () => {
    for (const message of [THROWN.fetch, THROWN.firefox, THROWN.http]) {
      const friendly = friendlyError(message, { rpcUrl: "http://127.0.0.1:8545" });
      expect(friendly.title).toBe("The network service didn't answer");
      expect(friendly.sentence).toContain("http://127.0.0.1:8545");
    }
    expect(friendlyError(THROWN.fetch).sentence).toContain("your network service");
  });

  it("names the network service by its host only: an address can carry a key", () => {
    const friendly = friendlyError(THROWN.fetch, { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef" });
    expect(friendly.sentence).toContain("https://eth-mainnet.g.alchemy.com.");
    expect(friendly.sentence).not.toContain("abcdef0123456789");
    expect(friendly.sentence).not.toContain("/v2/");
  });

  it("names the setting it sends someone to as the page does, and says which for the banner's button", () => {
    const service = friendlyError(THROWN.fetch);
    expect(service.sentence).toContain(`choose another service in ${PLACES.networkService.label}.`);
    expect(service.place).toBe("networkService");
    const relay = friendlyError(THROWN.noRelay);
    expect(relay.sentence).toContain(`Add one in ${PLACES.sending.label},`);
    expect(relay.place).toBe("sending");
    // Nothing to go to: no place.
    expect(friendlyError(THROWN.zero).place).toBeUndefined();
    expect(friendlyError(THROWN.relayHttp).place).toBeUndefined();
    for (const message of Object.values(THROWN)) {
      expect(friendlyError(message).sentence).not.toMatch(/\bin Expert\b|Expert →/);
    }
  });

  it("says a rate limit is the service being busy, never \"something went wrong\"", () => {
    for (const message of [
      "eth_call: Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.",
      "eth_call: HTTP 429",
      "eth_call: rate limit exceeded",
      "eth_getLogs: Too Many Requests",
    ]) {
      const friendly = friendlyError(message, { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef" });
      expect(friendly.title, message).toBe("The network service is busy");
      expect(friendly.sentence, message).toContain("Try again in a minute");
      expect(friendly.sentence, message).toContain("https://eth-mainnet.g.alchemy.com is");
      expect(friendly.sentence, message).not.toContain("abcdef0123456789");
      expect(friendly.place, message).toBe("networkService");
      expect(friendly.service, message).toBe("busy");
    }
    // A relay's 429 is still the relay's, and not the network service's.
    expect(friendlyError(THROWN.relayHttp).title).toBe("The private relay didn't answer");
    expect(friendlyError(THROWN.relayHttp).service).toBeUndefined();
  });

  it("says a refusal is one, never \"busy, try again in a minute\": a monthly cap doesn't lift in a minute", () => {
    const monthly =
      "eth_blockNumber: Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.";
    for (const message of [
      monthly,
      // Without a JSON-RPC body the transport's "HTTP 429" is in it too; the refusal wins.
      "eth_call: HTTP 429: Monthly capacity limit exceeded.",
      "eth_call: Origin not on whitelist.",
      "eth_chainId: Unspecified origin not on whitelist",
      "eth_call: Must be authenticated!",
      "eth_call: Invalid API key",
    ]) {
      const builtIn = friendlyError(message, { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef", builtIn: true });
      expect(builtIn.title, message).toBe("The network service turned this page away");
      expect(builtIn.service, message).toBe("refused");
      expect(builtIn.place, message).toBe("networkService");
      // What BuiltInServiceNotice says: not serving this page, choose another.
      expect(builtIn.sentence, message).toBe(
        `spDEX's built-in network service isn't serving this page, so spDEX can't read prices or check a swap through it. Choose another service in ${PLACES.networkService.label}.`,
      );
      expect(builtIn.sentence, message).not.toMatch(/try again|in a minute|busy/i);
      expect(builtIn.sentence, message).not.toContain("alchemy");

      const chosen = friendlyError(message, { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef" });
      expect(chosen.title, message).toBe("The network service turned this page away");
      expect(chosen.sentence, message).toMatch(/^https:\/\/eth-mainnet\.g\.alchemy\.com turned this page away/);
      expect(chosen.sentence, message).toContain(`choose another service in ${PLACES.networkService.label}.`);
      expect(chosen.sentence, message).not.toContain("abcdef0123456789");
      expect(chosen.sentence, message).not.toMatch(/in a minute/i);
    }
  });

  it("says which way the network service failed, and nothing for anything else", () => {
    expect(friendlyError(THROWN.fetch).service).toBe("unreachable");
    expect(friendlyError(THROWN.firefox).service).toBe("unreachable");
    expect(friendlyError(THROWN.http).service).toBe("unreachable");
    expect(friendlyError("eth_call: HTTP 429").service).toBe("busy");
    expect(friendlyError("eth_call: Monthly capacity limit exceeded.").service).toBe("refused");
    for (const message of [THROWN.zero, THROWN.noPools, THROWN.noRoute, THROWN.noRelay, THROWN.relayHttp, "something nobody anticipated"]) {
      expect(friendlyError(message).service, message).toBeUndefined();
    }
  });

  it("on the built-in service, says wait first and choosing another service second", () => {
    for (const message of [THROWN.fetch, THROWN.firefox, "eth_call: HTTP 403"]) {
      const friendly = friendlyError(message, { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef", builtIn: true });
      expect(friendly.title, message).toBe("The network service didn't answer");
      expect(friendly.sentence, message).toMatch(/^spDEX's built-in network service didn't answer\. It may be busy/);
      expect(friendly.sentence, message).toContain("try again in a minute");
      expect(friendly.sentence, message).toContain(`If it keeps happening, choose another service in ${PLACES.networkService.label}.`);
      expect(friendly.sentence.indexOf("try again"), message).toBeLessThan(friendly.sentence.indexOf("choose another"));
      expect(friendly.sentence, message).not.toContain("alchemy");
    }
    const busy = friendlyError("eth_call: HTTP 429", { builtIn: true });
    expect(busy.title).toBe("The network service is busy");
    expect(busy.sentence).toMatch(/^spDEX's built-in network service is shared by everyone using this copy/);
    expect(busy.sentence.indexOf("Try again")).toBeLessThan(busy.sentence.indexOf("choose another"));
    // A service the person chose keeps the plain sentence.
    expect(friendlyError(THROWN.fetch, { builtIn: false }).sentence).toBe(
      `spDEX couldn't reach your network service. Check your internet, or choose another service in ${PLACES.networkService.label}.`,
    );
  });

  it("puts a short line under Get price that says where the rest is", () => {
    expect(quoteProblemLine(friendlyError("eth_call: HTTP 429", { builtIn: true }).title)).toBe(
      "Couldn't get a price: the network service is busy. More at the top of the page.",
    );
    expect(quoteProblemLine(friendlyError(THROWN.noPools).title)).toBe(
      "Couldn't get a price: no market for this pair. More at the top of the page.",
    );
    expect(quoteProblemLine("The built-in network service isn't working here")).toBe(
      "Couldn't get a price: the built-in network service isn't working here. More at the top of the page.",
    );
  });

  it("says an amount or pair problem in full under the button, and sends nobody to the top", () => {
    // An amount of 0 is in the field right above: "enter an amount" would be wrong.
    const zero = friendlyError(THROWN.zero);
    expect(errorPlacement(zero, { refusedNoticeShown: false, fromQuote: true })).toEqual({
      banner: zero,
      quoteLine: "Couldn't get a price: enter an amount above zero.",
    });
    // The banner keeps the thrown sentence, which e2e reads.
    expect(zero.sentence).toContain("greater than zero");
    expect(errorPlacement(friendlyError(THROWN.same), { refusedNoticeShown: false, fromQuote: true }).quoteLine).toBe(
      "Couldn't get a price: pick two different tokens.",
    );
    // Only those two: a wrap's title needs the banner's sentence.
    expect(friendlyError(THROWN.wrap).input).toBeUndefined();
    expect(friendlyError(THROWN.noRoute).input).toBeUndefined();
    expect(friendlyError(THROWN.fetch, { builtIn: true }).input).toBeUndefined();
  });

  it("leaves the banner out under the built-in service's refusal notice for the service's errors only", () => {
    const busy = friendlyError("eth_call: HTTP 429", { builtIn: true });
    const refused = friendlyError("eth_call: Monthly capacity limit exceeded.", { builtIn: true });
    const unreachable = friendlyError(THROWN.fetch, { builtIn: true });
    const noPools = friendlyError(THROWN.noPools, { builtIn: true });
    const notice = { refusedNoticeShown: true, fromQuote: true };
    for (const friendly of [busy, refused, unreachable]) {
      expect(errorPlacement(friendly, notice), friendly.title).toEqual({
        banner: null,
        quoteLine: "Couldn't get a price: the built-in network service isn't working here. More at the top of the page.",
      });
    }
    // Anything else still has its banner under the notice.
    expect(errorPlacement(noPools, notice)).toEqual({
      banner: noPools,
      quoteLine: "Couldn't get a price: no market for this pair. More at the top of the page.",
    });
    // Without the notice, every banner shows; the line only for a failed quote.
    expect(errorPlacement(busy, { refusedNoticeShown: false, fromQuote: true })).toEqual({
      banner: busy,
      quoteLine: "Couldn't get a price: the network service is busy. More at the top of the page.",
    });
    expect(errorPlacement(busy, { refusedNoticeShown: false, fromQuote: false })).toEqual({ banner: busy, quoteLine: null });
    expect(errorPlacement(null, notice)).toEqual({ banner: null, quoteLine: null });
  });

  it("says an amount above what the wallet holds beside the amount, with the balance and what to do", () => {
    const eth = notEnoughMessage({ symbol: "ETH", held: 2n * 10n ** 16n, wanted: 10n ** 18n, decimals: 18, native: true, maxAvailable: true });
    expect(eth).toBe(
      "Not enough ETH in your wallet: it holds 0.02 ETH, and this swap needs 1 ETH and its network fee. Enter less, or tap Max.",
    );
    const friendly = friendlyError(eth);
    expect(friendly).toMatchObject({
      title: "Not enough ETH in your wallet",
      sentence: "Your wallet holds 0.02 ETH, and this swap needs 1 ETH and its network fee. Enter less, or tap Max.",
      input: true,
    });
    // Beside Get price, the title says it all: nobody is sent to the top.
    expect(errorPlacement(friendly, { refusedNoticeShown: false, fromQuote: true }).quoteLine).toBe(
      "Couldn't get a price: not enough ETH in your wallet.",
    );
    // A token pays no network fee, and an empty wallet has no Max to tap.
    const usdc = notEnoughMessage({ symbol: "USDC", held: 0n, wanted: 5_000_000n, decimals: 6, native: false, maxAvailable: false });
    expect(usdc).toBe("Not enough USDC in your wallet: it holds 0 USDC, and this swap needs 5 USDC. Add USDC to your wallet first.");
    expect(friendlyError(usdc).title).toBe("Not enough USDC in your wallet");
  });

  it("says a send refused for want of funds is that, never \"something went wrong\", and says the swap stopped beside its button", () => {
    const refused = friendlyError("Insufficient funds for gas * price + value");
    expect(refused.title).toBe("Not enough ETH for this and its network fee");
    expect(refused.sentence).toContain("nothing was sent");
    expect(swapProblemLine(refused.title)).toBe("Swap stopped: not enough ETH for this and its network fee. More at the top of the page.");
    expect(swapProblemLine(friendlyError("something nobody anticipated").title)).toBe(
      "Swap stopped: something went wrong. More at the top of the page.",
    );
  });

  it("falls back without losing the message", () => {
    const friendly = friendlyError("something nobody anticipated");
    expect(friendly.title).toBe("Something went wrong");
    expect(friendly.raw).toBe("something nobody anticipated");
  });
});

describe("serviceRefusal", () => {
  const error = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

  it("names a definite no: 401, 403, an invalid request, or Alchemy's refusals", () => {
    expect(serviceRefusal(error("eth_chainId: HTTP 403", { status: 403 }))).toBe("eth_chainId: HTTP 403");
    expect(serviceRefusal(error("eth_chainId: HTTP 401", { status: 401 }))).toBe("eth_chainId: HTTP 401");
    expect(serviceRefusal(error("eth_chainId: Origin not on whitelist.", { code: -32600 }))).toBe("eth_chainId: Origin not on whitelist.");
    expect(serviceRefusal(error("eth_chainId: Unspecified origin not on whitelist"))).not.toBeNull();
    expect(serviceRefusal(error("eth_chainId: Must be authenticated!", { code: -32600 }))).not.toBeNull();
    // Out of its month: 429 on the wire, a refusal all the same.
    expect(serviceRefusal(error("eth_chainId: HTTP 429: Monthly capacity limit exceeded.", { status: 429 }))).not.toBeNull();
  });

  it("is null for busy, unreachable, or anything else", () => {
    expect(serviceRefusal(error("eth_chainId: HTTP 429", { status: 429 }))).toBeNull();
    expect(serviceRefusal(error("eth_chainId: Your app has exceeded its compute units per second capacity.", { code: 429 }))).toBeNull();
    expect(serviceRefusal(error("eth_chainId: limit exceeded", { code: -32005 }))).toBeNull();
    expect(serviceRefusal(new TypeError("Failed to fetch"))).toBeNull();
    expect(serviceRefusal(error("eth_chainId: HTTP 503", { status: 503 }))).toBeNull();
    expect(serviceRefusal(error("eth_chainId: internal error", { code: -32603 }))).toBeNull();
    expect(serviceRefusal("a string")).toBeNull();
    expect(serviceRefusal(null)).toBeNull();
  });
});

describe("guardSentence", () => {
  it("has a sentence for every Guard code", () => {
    for (const code of GUARD_VIOLATIONS) {
      expect(guardSentence(code), code).not.toContain("see the code");
    }
  });

  it("states the divergence as a percentage", () => {
    expect(guardSentence("ORACLE_DIVERGENCE", { divergenceBps: "2458" })).toBe(
      "The price is 24.58% away from the 10-minute average price. It's still checked; just worth a second look.",
    );
  });

  it("never invents a divergence it wasn't given", () => {
    const sentence = guardSentence("ORACLE_DIVERGENCE");
    expect(sentence).toContain("far from");
    expect(sentence).not.toMatch(/%/);
    expect(guardSentence("ORACLE_DIVERGENCE", { divergenceBps: "not a number" })).toContain("far from");
  });

  it("names the second service without blaming it when the two disagree", () => {
    expect(guardSentence("SECOND_OPINION_DISAGREES", { host: "alchemy.com", reason: "result" })).toBe(
      "Your two network services disagree about what this would do, so spDEX won't let you sign it. " +
        "Either one could be wrong, your main service included. Try again in a moment. " +
        "If it keeps happening, try another main service rather than removing your second opinion, alchemy.com (Settings → Safety).",
    );
    const heads = guardSentence("SECOND_OPINION_DISAGREES", { host: "alchemy.com", reason: "heads" });
    expect(heads).toContain("too far apart to compare their test-runs");
    expect(heads).toContain("your main service included");
    const hash = guardSentence("SECOND_OPINION_DISAGREES", { host: "alchemy.com", reason: "block-hash" });
    expect(hash).toContain("can't compare their test-runs");
    // A lying main service disagrees with the second on everything it
    // targets, so no reason may steer the person to delete the second.
    for (const reason of ["result", "heads", "block-hash", undefined]) {
      const sentence = guardSentence("SECOND_OPINION_DISAGREES", { host: "alchemy.com", ...(reason ? { reason } : {}) });
      expect(sentence).not.toMatch(/remove it|keeps disagreeing|check alchemy/);
      expect(sentence).toContain("rather than removing your second opinion, alchemy.com (Settings → Safety)");
    }
  });

  it("tells a main service that failed before the comparison from one that can't test-run", () => {
    expect(guardSentence("SIMULATION_UNAVAILABLE")).toBe("Your network service can't run the safety test.");
    expect(guardSentence("SIMULATION_UNAVAILABLE", { failure: "its test-run on the agreed block failed" })).toBe(
      "Your main network service failed before its test-run could be compared with your second opinion's, so this wasn't checked.",
    );
  });

  it("still points at the setting when the disagreement names no host", () => {
    for (const detail of [undefined, {}, { host: "  " }, { reason: "heads" }]) {
      const sentence = guardSentence("SECOND_OPINION_DISAGREES", detail);
      expect(sentence).toContain("your second opinion (Settings → Safety)");
      expect(sentence).not.toContain("undefined");
    }
  });

  it("says a second opinion that didn't answer left one service's check", () => {
    expect(guardSentence("SECOND_OPINION_UNAVAILABLE")).toBe(
      "Your second network service didn't answer, so this was checked on one service only.",
    );
  });

  it("states the unaccounted WETH exactly, and never as 0", () => {
    expect(guardSentence("VAULT_BATCH_UNACCOUNTED", { swept: "1" })).toBe(
      "This batch would move 0.000000000000000001 WETH out of the vault batcher, which holds and passes on nothing. " +
        "spDEX won't make you the receiver of money it can't account for.",
    );
    expect(guardSentence("VAULT_BATCH_UNACCOUNTED", { swept: "250000000000000000" })).toContain("move 0.25 WETH out");
    // v2's batcher has no sweep: nothing says someone's WETH is waiting there to be passed on.
    expect(guardSentence("VAULT_BATCH_UNACCOUNTED", { swept: "1" })).not.toMatch(/someone sent|pass it to you/);
    // Another token than WETH carries no `swept`: said without a figure.
    const other = { token: "0x00000000000000000000000000000000000000cc", amount: "5" };
    for (const detail of [undefined, other, { swept: "" }, { swept: "0" }, { swept: "-5" }, { swept: "1e18" }]) {
      const sentence = guardSentence("VAULT_BATCH_UNACCOUNTED", detail);
      expect(sentence).toContain("This batch would move money out of the vault batcher");
      expect(sentence).not.toMatch(/\d/);
    }
  });

  it("still says something for a code it doesn't know", () => {
    expect(guardSentence("SOMETHING_NEW")).toContain("see the code");
  });

  it("contains no 'Refused', which the preview banner must never show", () => {
    for (const code of GUARD_VIOLATIONS) expect(guardSentence(code)).not.toMatch(/refused/i);
  });
});

describe("bpsAsPercent", () => {
  it("converts whole basis points", () => {
    expect(bpsAsPercent(50)).toBe("0.5");
    expect(bpsAsPercent("300")).toBe("3");
    expect(bpsAsPercent("2458")).toBe("24.58");
  });

  it("refuses what isn't a figure", () => {
    expect(bpsAsPercent(undefined)).toBeNull();
    expect(bpsAsPercent("")).toBeNull();
    expect(bpsAsPercent("1.5")).toBeNull();
    expect(bpsAsPercent(-1)).toBeNull();
  });
});

describe("uniqueByCode", () => {
  it("keeps the first of each code, in order", () => {
    const items = [
      { code: "A", n: 1 },
      { code: "B", n: 2 },
      { code: "A", n: 3 },
    ];
    expect(uniqueByCode(items)).toEqual([
      { code: "A", n: 1 },
      { code: "B", n: 2 },
    ]);
  });
});
