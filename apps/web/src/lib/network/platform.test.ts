/**
 * The Collective DCA panel's words and cache. The reads themselves are
 * `@spdex/vault`'s, pinned in `packages/vault/src/platform.test.ts` and on the
 * fork; here `readPlatform` is replaced, so what is tested is when it is
 * asked and how its answer is written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpc } from "@spdex/chain";
import type { Address } from "@spdex/core";
import { summarisePlatform, type PlatformRead, type PlatformVault, type VaultTerms } from "@spdex/vault";

const readPlatform = vi.hoisted(() => vi.fn());
vi.mock("@spdex/vault", async (importOriginal) => ({ ...(await importOriginal<typeof import("@spdex/vault")>()), readPlatform }));

const {
  PLATFORM_CACHE_MS,
  cachedPlatformRead,
  collectiveFooter,
  collectiveRows,
  collectiveSummary,
  collectiveTiles,
  loadMorePlatform,
  loadPlatform,
  notDeployedText,
  notOfferedText,
  openHint,
  partialNotes,
  readFailedText,
  readMoreLabel,
  vaultIdentities,
  windowShareFigure,
} = await import("./platform.js");

const ETHER = 10n ** 18n;
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c" as Address;
const FACTORY = "0xe4a1410a9ee0833d41e7514306e65ad729b7199e" as Address;
const V2_FACTORY = "0x164080e374f3a924245c3a99fbadbd2c98ed48eb" as Address;
const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

function terms(overrides: Partial<VaultTerms> = {}): VaultTerms {
  return {
    tokenOut: SPX,
    pair: address(1),
    oraclePool: address(2),
    amountPerBuy: ETHER / 100n,
    interval: 86_400n,
    maxBuys: 10n,
    startAt: 0n,
    keeperReward: ETHER / 10_000n,
    maxSlippageBps: 200n,
    communityWindow: null,
    turnBuckets: null,
    ...overrides,
  };
}

/** A v1 vault: no community window, no window count. */
function vault(n: number, overrides: Partial<PlatformVault> = {}): PlatformVault {
  return {
    vault: address(0x1000 + n),
    release: "v1",
    owner: address(0xa0 + (n % 2)),
    terms: terms(),
    closed: false,
    buysDone: 3n,
    totalOut: 123_456_789_012n,
    wethBalance: ETHER / 50n,
    windowBuys: null,
    ...overrides,
  };
}

/** A v2 vault: a 30-minute window, and `windowBuys` of its buys made by SPX holders inside it. */
function v2Vault(n: number, buysDone: bigint, windowBuys: bigint, overrides: Partial<PlatformVault> = {}): PlatformVault {
  return vault(n, { release: "v2", terms: terms({ communityWindow: 1_800n, turnBuckets: 0n }), buysDone, windowBuys, ...overrides });
}

type Extra = { count?: bigint; listed?: number; unreadable?: Address[] };

function deployment(release: "v1" | "v2", vaults: PlatformVault[], extra: Extra = {}): PlatformRead["deployments"][number] {
  return {
    id: release,
    release,
    factory: release === "v1" ? FACTORY : V2_FACTORY,
    state: "read",
    count: extra.count ?? BigInt(vaults.length + (extra.unreadable?.length ?? 0)),
    listed: extra.listed ?? vaults.length + (extra.unreadable?.length ?? 0),
    unreadable: extra.unreadable ?? [],
    vaults,
  };
}

/** v1's factory alone, as before v2's was read. */
function readOf(vaults: PlatformVault[], extra: Extra = {}): PlatformRead {
  return { block: 26_001_248n, requests: 13, deployments: [deployment("v1", vaults, extra)] };
}

/** Both factories, oldest first, as `readPlatform` reads them. */
function readBoth(v1: PlatformVault[], v2: PlatformVault[], extra: { v1?: Extra; v2?: Extra } = {}): PlatformRead {
  return { block: 26_001_248n, requests: 16, deployments: [deployment("v1", v1, extra.v1), deployment("v2", v2, extra.v2)] };
}

function figures(read: PlatformRead) {
  const summary = summarisePlatform(read);
  if (summary.state !== "read") throw new Error("expected figures");
  return summary;
}

describe("the tiles", () => {
  it("are the six figures in the panel's order, counts in whole numbers and no money anywhere", () => {
    const tiles = collectiveTiles(figures(readOf([vault(0), vault(1, { closed: true }), vault(2, { buysDone: 10n })])));
    expect(tiles.map((t) => [t.id, t.label])).toEqual([
      ["buys", "Buys made"],
      ["spx", "SPX delivered"],
      ["open", "Vaults still buying"],
      ["owners", "Owner addresses"],
      ["eth", "ETH spent on buys"],
      ["fees", "WETH paid in buy fees"],
    ]);
    const byId = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(byId["buys"]!.figure).toEqual({ short: "16", exact: null, atLeast: false });
    expect(byId["spx"]!.figure).toEqual({ short: "3,703", exact: "3,703.70367036 SPX", atLeast: false });
    expect(byId["spx"]!.hint).toBe("to vault owners");
    expect(byId["open"]!.figure.short).toBe("1");
    expect(byId["owners"]!.hint).toBe("addresses, not people");
    expect(byId["eth"]!.figure).toEqual({ short: "0.16", exact: null, atLeast: false });
    expect(byId["fees"]!.figure).toEqual({ short: "0.0016", exact: null, atLeast: false });
    expect(byId["fees"]!.hint).toBe("to whoever made each buy, or a wallet they named");
    const text = JSON.stringify(tiles) + JSON.stringify(collectiveRows(figures(readOf([vault(0)]))));
    expect(text).not.toMatch(/[$€£¥]|USD|EUR/);
  });

  it("shows SPX under one whole unit as less than 1, never 0", () => {
    const tile = collectiveTiles(figures(readOf([vault(0, { totalOut: 5n })]))).find((t) => t.id === "spx")!;
    expect(tile.figure).toEqual({ short: "less than 1", exact: "0.00000005 SPX", atLeast: false });
  });

  it("marks every figure at least when a vault couldn't be read", () => {
    const summary = figures(readOf([vault(0)], { unreadable: [address(0x99)] }));
    for (const tile of collectiveTiles(summary)) expect(tile.figure.atLeast).toBe(true);
    expect(openHint(summary)).toEqual({ made: "2", rest: "at least 0 finished · at least 0 closed" });
  });

  it("says how many were made, finished and closed under the vaults still buying", () => {
    const summary = figures(readOf([vault(0), vault(1, { closed: true }), vault(2, { buysDone: 10n })]));
    expect(openHint(summary)).toEqual({ made: "3", rest: "1 finished · 1 closed" });
  });
});

describe("the tile header's summary", () => {
  it("counts every vault buy, and says where the read stands otherwise; nothing is read for it", () => {
    const summary = summarisePlatform(readOf([vault(0), vault(1, { buysDone: 32n })]));
    expect(collectiveSummary({ kind: "ready", summary })).toBe("35 vault buys");
    expect(collectiveSummary({ kind: "ready", summary: summarisePlatform(readOf([vault(0, { buysDone: 1n })])) })).toBe("1 vault buy");
    const partial = summarisePlatform(readOf([vault(0)], { unreadable: [address(0x2000)] }));
    expect(collectiveSummary({ kind: "ready", summary: partial })).toBe("at least 3 vault buys");
    expect(collectiveSummary({ kind: "idle" })).toBe("read on open");
    expect(collectiveSummary({ kind: "reading" })).toBe("reading…");
    expect(collectiveSummary({ kind: "failed" })).toBe("unknown");
    expect(collectiveSummary({ kind: "not-offered" })).toBe("not on this network");
    expect(collectiveSummary({ kind: "no-service" })).toBe("no network service");
    expect(readPlatform).not.toHaveBeenCalled();
  });
});

describe("the rows", () => {
  it("say what the budget and the held WETH are, and keep other markets apart in their own units", () => {
    const other = address(0xbeef);
    const rows = collectiveRows(figures(readOf([vault(0), vault(1, { terms: terms({ tokenOut: other }), totalOut: 42n })])));
    expect(rows.map((r) => [r.id, r.label, r.hint])).toEqual([
      ["committed", "Budget committed", "for buys still to come"],
      ["held", "Still held by open vaults", "finished ones not yet closed included, and WETH anyone sent them"],
      ["window", "v2 buys paid to community keepers", "inside each buy's community window"],
      [`other-${other}`, "Delivered on another market (0x0000…beef)", "vaults buying a token other than SPX"],
    ]);
    expect(rows[3]!.figure.short).toBe("42 base units");
  });
});

describe("both factories, and SPX holders' share of v2 buys", () => {
  const share = (summary: ReturnType<typeof figures>) => collectiveRows(summary).find((r) => r.id === "window") ?? null;

  it("adds v1's and v2's vaults into every total", () => {
    const summary = figures(readBoth([vault(0, { buysDone: 4n })], [v2Vault(1, 6n, 2n)]));
    expect(collectiveTiles(summary).find((t) => t.id === "buys")!.figure).toEqual({ short: "10", exact: null, atLeast: false });
    expect(summary.made).toBe(2n);
  });

  it("shows the share of v2 buys SPX holders made inside their window, with the counts a tap away", () => {
    const row = share(figures(readBoth([vault(0, { buysDone: 40n })], [v2Vault(1, 3n, 2n), v2Vault(2, 7n, 3n)])));
    expect(row).toEqual({
      id: "window",
      label: "v2 buys paid to community keepers",
      figure: { short: "50%", exact: "5 of 10 v2 buys", atLeast: false },
      hint: "inside each buy's community window",
    });
    // Rounded down, and never shown as 0% when some were.
    expect(share(figures(readBoth([], [v2Vault(1, 3n, 2n)])))!.figure.short).toBe("66%");
    expect(share(figures(readBoth([], [v2Vault(1, 1_000n, 1n)])))!.figure.short).toBe("less than 1%");
    // A true none is a true 0%.
    expect(share(figures(readBoth([], [v2Vault(1, 4n, 0n)])))!.figure).toEqual({ short: "0%", exact: "0 of 4 v2 buys", atLeast: false });
  });

  it("says none yet while no v2 buy has been made: 0 of 0 is no share", () => {
    expect(share(figures(readBoth([vault(0)], [])))!.figure).toEqual({ short: "none yet", exact: null, atLeast: false });
    expect(share(figures(readBoth([vault(0)], [v2Vault(1, 0n, 0n)])))!.figure.short).toBe("none yet");
    // Before v2's factory is read at all, there are no v2 buys either.
    expect(share(figures(readOf([vault(0)])))!.figure.short).toBe("none yet");
  });

  it("leaves the row out, never shows a share or a zero, while any v2 vault is unread or unreadable", () => {
    expect(share(figures(readBoth([], [v2Vault(1, 3n, 2n)], { v2: { unreadable: [address(0x99)] } })))).toBeNull();
    expect(share(figures(readBoth([], [v2Vault(1, 3n, 2n)], { v2: { count: 5n, listed: 1 } })))).toBeNull();
    // A v2 vault whose window count is unknown is unknown, not none.
    expect(share(figures(readBoth([], [v2Vault(1, 3n, 2n), v2Vault(2, 3n, 0n, { windowBuys: null })])))).toBeNull();
    // A v1 vault that couldn't be read says nothing about v2's buys.
    expect(share(figures(readBoth([vault(0)], [v2Vault(1, 4n, 1n)], { v1: { unreadable: [address(0x98)] } })))!.figure.short).toBe("25%");
    const unknown = figures(readBoth([], [v2Vault(1, 3n, 2n)], { v2: { unreadable: [address(0x99)] } }));
    expect(windowShareFigure(unknown)).toBeNull();
  });
});

describe("the notes", () => {
  it("footer: the block, the reads, and that no read names the person", () => {
    expect(collectiveFooter({ block: 26_001_248n, requests: 13 })).toBe(
      "Read at block 26,001,248 through your network service (13 reads). These reads don't name your address.",
    );
    expect(collectiveFooter({ block: 1n, requests: 1 })).toContain("(1 read)");
  });

  it("say what the totals leave out, and nothing when they leave out nothing", () => {
    expect(partialNotes(figures(readOf([vault(0)])))).toEqual([]);
    expect(partialNotes(figures(readOf([vault(0), vault(1)], { unreadable: [address(9)] })))).toEqual([
      "1 of 3 vaults couldn't be read just now; these totals leave them out.",
    ]);
    expect(partialNotes(figures(readOf([vault(0)], { count: 7_001n, listed: 1 })))).toEqual(["These totals cover the first 1 of 7,001 vaults."]);
  });

  it("offer the rest of the vaults with what that costs, only when some weren't read", () => {
    expect(readMoreLabel(figures(readOf([vault(0)])))).toBeNull();
    expect(readMoreLabel(figures(readOf([vault(0)], { count: 8n, listed: 1 })))).toBe("Read the other 7 vaults (up to 2 more reads)");
    // Each costed as a v2 vault, the dearer to read: a ceiling whichever factory lists it.
    expect(readMoreLabel(figures(readOf([vault(0)], { count: 7_001n, listed: 1 })))).toBe(
      "Read 5,000 more of the other 7,000 vaults (up to 180 more reads)",
    );
  });

  it("name the network, and put what the service said in the refusal", () => {
    expect(notOfferedText(11155111)).toBe("Vaults aren't offered on Sepolia test network.");
    expect(notDeployedText(1)).toBe("spDEX's vault factories aren't deployed on Ethereum, so there's no vault activity to read here.");
    expect(readFailedText(new Error("eth_call: header not found."))).toBe(
      "Couldn't read a factory's list (eth_call: header not found). Nothing is shown rather than a guess.",
    );
    expect(readFailedText(new Error("x".repeat(400)))).toMatch(/^Couldn't read a factory's list \(x{159}…\)/);
  });
});

describe("when the panel reads", () => {
  beforeEach(() => readPlatform.mockReset());
  const endpoint = (): JsonRpc => async () => null;

  it("reads once, then serves the same read for five minutes per network service", async () => {
    const rpc = endpoint();
    const read = readOf([vault(0)]);
    readPlatform.mockResolvedValue(read);
    let now = 1_000_000;
    const clock = () => now;
    expect(cachedPlatformRead(rpc, now)).toBeNull();
    expect(await loadPlatform(rpc, 690069, { nowMs: clock })).toBe(read);
    expect(await loadPlatform(rpc, 690069, { nowMs: clock })).toBe(read);
    expect(readPlatform).toHaveBeenCalledTimes(1);
    expect(readPlatform.mock.calls[0]![0]).toBe(rpc);
    expect(readPlatform.mock.calls[0]![1]).toEqual({ cache: vaultIdentities(rpc, 690069) });

    now += PLATFORM_CACHE_MS - 1;
    await loadPlatform(rpc, 690069, { nowMs: clock });
    expect(readPlatform).toHaveBeenCalledTimes(1);
    now += 1;
    await loadPlatform(rpc, 690069, { nowMs: clock });
    expect(readPlatform).toHaveBeenCalledTimes(2);

    // Another service has its own figures.
    await loadPlatform(endpoint(), 690069, { nowMs: clock });
    expect(readPlatform).toHaveBeenCalledTimes(3);
  });

  it("reads again on Read again, and shares one read between two asks at once", async () => {
    const rpc = endpoint();
    readPlatform.mockResolvedValue(readOf([vault(0)]));
    await loadPlatform(rpc, 690069);
    await loadPlatform(rpc, 690069, { force: true });
    expect(readPlatform).toHaveBeenCalledTimes(2);
    await Promise.all([loadPlatform(rpc, 690069, { force: true }), loadPlatform(rpc, 690069, { force: true })]);
    expect(readPlatform).toHaveBeenCalledTimes(3);
  });

  it("keeps no failed read, so the next open asks again", async () => {
    const rpc = endpoint();
    readPlatform.mockRejectedValueOnce(new Error("eth_call: rate limited"));
    await expect(loadPlatform(rpc, 690069)).rejects.toThrow("rate limited");
    expect(cachedPlatformRead(rpc)).toBeNull();
    readPlatform.mockResolvedValue(readOf([vault(0)]));
    await loadPlatform(rpc, 690069);
    expect(readPlatform).toHaveBeenCalledTimes(2);
  });

  it("reads the rest on from the earlier read, and keeps that as the cached one", async () => {
    const rpc = endpoint();
    const first = readOf([vault(0)], { count: 3n, listed: 1 });
    const whole = readOf([vault(0), vault(1), vault(2)]);
    readPlatform.mockResolvedValueOnce(whole);
    expect(await loadMorePlatform(rpc, 1, first)).toBe(whole);
    expect(readPlatform.mock.calls[0]![1]).toEqual({ previous: first, cache: vaultIdentities(rpc, 1) });
    expect(cachedPlatformRead(rpc)).toBe(whole);
  });

  it("keeps one owner-and-terms cache per network service and chain: a replaced service's answers go with it", () => {
    const rpc = endpoint();
    expect(vaultIdentities(rpc, 1)).toBe(vaultIdentities(rpc, 1));
    expect(vaultIdentities(rpc, 1)).not.toBe(vaultIdentities(rpc, 690069));
    expect(vaultIdentities(endpoint(), 1)).not.toBe(vaultIdentities(rpc, 1));
  });
});
