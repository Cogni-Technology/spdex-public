/**
 * The Markets tile header's summary: the pair, its liquidity and how many
 * pools hold it, or where the panel is. Never 0 for a figure it doesn't have.
 */

import { describe, expect, it } from "vitest";
import { summariseLogError } from "@spdex/chain";
import { marketsSummary, shortPair, volumeNoteText } from "./PoolStats.js";

describe("the Markets tile's summary", () => {
  const ready = { pair: "ETH / SPX", phase: "ready" as const, pools: 3, priced: 3, discovered: 3, total: "$12.5M" };

  it("names the pair, its liquidity and its pools", () => {
    expect(marketsSummary(ready)).toEqual({ text: "ETH/SPX · $12.5M in 3 pools" });
    expect(marketsSummary({ ...ready, pools: 1, priced: 1 })).toEqual({ text: "ETH/SPX · $12.5M in 1 pool" });
  });

  it("says where it is, and unknown rather than 0", () => {
    expect(marketsSummary({ ...ready, phase: "off" })).toEqual({ text: "off" });
    expect(marketsSummary({ ...ready, phase: "discovering" })).toEqual({ text: "reading…" });
    expect(marketsSummary({ ...ready, phase: "reading" })).toEqual({ text: "reading…" });
    expect(marketsSummary({ ...ready, priced: 0 })).toEqual({ text: "ETH/SPX · unknown" });
    expect(marketsSummary({ ...ready, pools: 0, priced: 0 })).toEqual({ text: "ETH/SPX · unknown" });
    expect(marketsSummary({ ...ready, pools: 0, priced: 0, discovered: 0 })).toEqual({ text: "ETH/SPX · no markets found" });
  });

  it("says unknown, never 'no markets found', when the network service didn't answer", () => {
    expect(marketsSummary({ ...ready, phase: "failed", pools: 0, priced: 0, discovered: 0 })).toEqual({ text: "ETH/SPX · unknown" });
  });

  it("shortens the pair the panel is given", () => {
    expect(shortPair("WETH / SPX")).toBe("WETH/SPX");
    expect(shortPair("ETH / SPX (the One-time pair)")).toBe("ETH/SPX");
  });
});

describe("the Volume unavailable banner", () => {
  it("opens with a fixed sentence, never a service's words made to start one", () => {
    const busy = summariseLogError(
      Object.assign(new Error("eth_getLogs: Your app has exceeded its compute units per second capacity."), { code: 429, status: 429 }),
    );
    const text = volumeNoteText(busy);
    expect(text).toBe("Couldn't read it: the network service is turning requests away for now.");
    expect(text).not.toMatch(/Eth_getLogs|eth_getLogs|compute units/);
    expect(text.length).toBeLessThan(400);
  });

  it("says a free key's cap on log ranges, the commonest reason, in a newcomer's words", () => {
    const capped = summariseLogError(new Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range."));
    expect(volumeNoteText(capped)).toBe("Your network service limits log reads.");
  });

  it("says a read that got no answer in plain words, not the browser's", () => {
    // A capped key's refusal without CORS headers reaches the page this way.
    const text = volumeNoteText(summariseLogError(new TypeError("Failed to fetch")));
    expect(text).toBe("Couldn't read it: the network service didn't answer.");
    expect(text).not.toMatch(/Failed to fetch/i);
  });

  it("keeps a shortened note's ellipsis, and adds no second full stop", () => {
    expect(volumeNoteText("something odd…")).toBe("Couldn't read it: something odd…");
    expect(volumeNoteText("the log query timed out")).toBe("Couldn't read it: the log query timed out.");
  });
});
