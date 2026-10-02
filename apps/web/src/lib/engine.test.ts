/**
 * The engine's scheduler seam, without a chain: the built-in scheduler module
 * loads as its declared kind in both runtimes and answers identically, the
 * off switch is an error rather than an empty answer, and the safety-test
 * probe tells "the endpoint said no" from "no answer".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDcaPlan, recommendedConfig, setFeature, DCA_FEATURE_ID } from "@spdex/config";
import { NATIVE_TOKEN, TOKENS, TOPICS } from "@spdex/chain";
import { scheduleRequest, vetScheduleDecision, type DcaPlan, type SpdexConfig } from "@spdex/core";
import type { VaultBatchIntent } from "@spdex/guard";
import { batcherAddress, encodeExecuteBatch } from "@spdex/vault";
import { Engine, testSecondOpinion } from "./engine.js";

const PLAN: DcaPlan = {
  id: "spx-hourly",
  paused: false,
  chainId: 690069,
  sell: NATIVE_TOKEN,
  buy: TOKENS.SPX.address,
  amountPerBuy: "10000000000000000",
  intervalSeconds: 3600,
  maxBuys: 5,
  startAt: 1_790_000_000,
  signer: "wallet",
};

function config(strictSandbox = false): SpdexConfig {
  const base: SpdexConfig = {
    ...recommendedConfig(),
    chainId: 690069,
    strictSandbox,
    rpc: { url: "http://127.0.0.1:1/unused", source: "user" },
  };
  const added = addDcaPlan(base, PLAN);
  if (!added.ok) throw new Error(added.error);
  return added.config;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Engine.dueBuys", () => {
  const request = scheduleRequest([PLAN], [{ planId: PLAN.id, buysDone: 1, lastSlot: 0 }], BigInt(PLAN.startAt + 3 * 3600 + 5));

  it("answers with one buy for the window open now, identically in both runtimes", async () => {
    const native = await new Engine(config(false)).dueBuys(request);
    const sandboxed = await new Engine(config(true)).dueBuys(request);
    expect(native).toEqual({
      due: [{ planId: PLAN.id, slot: 3, amountIn: PLAN.amountPerBuy }],
      next: [{ planId: PLAN.id, at: String(PLAN.startAt + 4 * 3600) }],
    });
    expect(JSON.stringify(sandboxed)).toBe(JSON.stringify(native));
    expect(vetScheduleDecision(request, native).refused).toEqual([]);
  });

  it("throws, rather than answering nothing, when the scheduler is switched off", async () => {
    const off = setFeature(config(false), DCA_FEATURE_ID, false);
    await expect(new Engine(off).dueBuys(request)).rejects.toThrow("The auto-buy scheduler is turned off in Features.");
  });
});

describe("Engine.safetyTestAvailable", () => {
  const respond = (body: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));

  it("true when the endpoint simulates, false when it answers that it cannot, unknown when it does not answer", async () => {
    const engine = new Engine(config());
    respond({ jsonrpc: "2.0", id: 1, result: [] });
    expect(await engine.safetyTestAvailable()).toBe(true);
    respond({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    expect(await engine.safetyTestAvailable()).toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await engine.safetyTestAvailable()).toBe("unknown");
  });

  it("an answer that is not 'no such method' — a rate limit, an internal error — is unknown, not a no", async () => {
    const engine = new Engine(config());
    respond({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } });
    expect(await engine.safetyTestAvailable()).toBe("unknown");
    respond({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } });
    expect(await engine.safetyTestAvailable()).toBe("unknown");
    // No code, in geth's words: still a definite no.
    respond({ jsonrpc: "2.0", id: 1, error: { message: "the method eth_simulateV1 does not exist/is not available" } });
    expect(await engine.safetyTestAvailable()).toBe(false);
  });
});

// ── A service that is busy or down ────────────────────────────────────────────

describe("Engine, when the network service doesn't answer", () => {
  const WETH = { ...TOKENS.WETH };
  const SPX = { ...TOKENS.SPX };

  it("says so rather than \"no market\", and asks again the next time", async () => {
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked += 1;
      throw new TypeError("Failed to fetch");
    });
    const engine = new Engine(config());
    await expect(engine.discoverPools(WETH, SPX)).rejects.toThrow("Failed to fetch");
    const first = asked;
    expect(first).toBeGreaterThan(0);
    // Not remembered: a quote asks the venues again, and fails with the reason.
    await expect(engine.quote({ tokenIn: WETH, tokenOut: SPX, amountIn: 10n ** 16n, account: null })).rejects.toThrow("Failed to fetch");
    expect(asked).toBeGreaterThan(first);
  });

  it("says why when every venue fails to quote, rather than \"no executable route\"", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const engine = new Engine(config());
    // Markets found earlier; the service stops answering before the quote.
    engine.discoverPools = async () => [
      { poolId: "0x52c77b0cb827afbad022e6d6caf2c44452edbc39", token0: SPX.address, token1: WETH.address, fee: 3000, depth: "1", venueId: "venue-uniswap-v2" },
    ];
    const quoting = engine.quote({ tokenIn: WETH, tokenOut: SPX, amountIn: 10n ** 16n, account: null });
    await expect(quoting).rejects.toThrow("Failed to fetch");
    await expect(quoting).rejects.not.toThrow("no executable route");
  });

  it("asks swaps', tips' and vaults' Guards whether it can test-run in a way that forgets a busy answer", () => {
    // One refused probe on a shared, rate-limited service must not make every
    // later check "not checked" (lib/simulation.ts DefiniteSimulationProvider).
    const source = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
    for (const guard of ["new Guard(", "new TipGuard(", "new VaultGuard(", "new ScheduledBuyGuard(new Guard("]) {
      expect(source, guard).toContain(`${guard}this.#checked(new DefiniteSimulationProvider(this.#rpc))`);
    }
  });
});

describe("Engine.usdRates", () => {
  const PRICED = [TOKENS.WETH.address, TOKENS.SPX.address];

  it("throws the service's own failure when it priced nothing because the service failed", async () => {
    // The oracle turns every failure into "no opinion"; the read says why.
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(new Engine(config()).usdRates(PRICED)).rejects.toThrow("Failed to fetch");

    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "daily request count exceeded, request rate limited" } }), {
        status: 200,
      });
    });
    await expect(new Engine(config()).usdRates(PRICED)).rejects.toThrow("request rate limited");
  });

  it("returns what it priced, never throwing, when the service answered", async () => {
    // The service answers every request, with nothing the oracle can read:
    // no price, and no failure of the service's.
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { id, method } = JSON.parse(init.body) as { id: number; method: string };
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      // Multicall3's aggregate3 answer with no results.
      const empty = `0x${"20".padStart(64, "0")}${"0".padStart(64, "0")}`;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: empty }), { status: 200 });
    });
    const rates = await new Engine(config()).usdRates(PRICED);
    expect([...rates.keys()]).toEqual([TOKENS.USDC.address.toLowerCase()]);
  });

  it("asks nothing, and throws nothing, for USDC alone", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const rates = await new Engine(config()).usdRates([TOKENS.USDC.address]);
    expect([...rates.keys()]).toEqual([TOKENS.USDC.address.toLowerCase()]);
  });
});

// ── The second opinion ────────────────────────────────────────────────────────

const MAIN = "http://127.0.0.1:1/unused";

function withSecond(url: string | null, rpcUrl = MAIN): SpdexConfig {
  const base = config();
  return { ...base, rpc: { url: rpcUrl, source: "user" }, guard: { ...base.guard, secondOpinion: { url } } };
}

describe("Engine.secondOpinionStatus", () => {
  it("is off without one, and doesn't count the main service twice", () => {
    expect(new Engine(withSecond(null)).secondOpinionStatus()).toEqual({ kind: "off" });
    // Another spelling of the same address is the same service.
    expect(new Engine(withSecond("HTTP://127.0.0.1:1/unused/")).secondOpinionStatus()).toEqual({ kind: "same" });
  });

  it("is on, by host, with nothing heard yet, and names an operator both seem to share", () => {
    expect(new Engine(withSecond("https://second.example/rpc/KEY")).secondOpinionStatus()).toEqual({
      kind: "on",
      host: "second.example",
      last: null,
      sameOperator: null,
    });
    const shared = new Engine(withSecond("https://eth.alchemy.com/v2/b", "https://eth-mainnet.g.alchemy.com/v2/a"));
    expect(shared.secondOpinionStatus()).toMatchObject({ kind: "on", sameOperator: "alchemy.com" });
  });

  it("reads rates through the second service only when one is set", async () => {
    expect(await new Engine(withSecond(null)).secondOpinionRates([TOKENS.WETH.address])).toBeNull();
    expect(await new Engine(withSecond(MAIN)).secondOpinionRates([TOKENS.WETH.address])).toBeNull();
  });
});

describe("Engine.checkVaultBatch", () => {
  const ME = "0x00000000000000000000000000000000000000aa" as const;
  const VAULT = "0x00000000000000000000000000000000000000cc" as const;
  const intent = (patch: Partial<VaultBatchIntent> = {}): VaultBatchIntent => ({
    version: 1,
    action: "batch",
    chainId: 690069,
    account: ME,
    vaults: [VAULT],
    rewardTo: ME,
    minRewards: 330_000n * 10n ** 9n,
    gasLimit: 647_000n,
    gasPrice: 10n ** 9n,
    ...patch,
  });

  it("builds the one call itself: to the factory's batcher, the batch's own calldata, no value, the exact gas and price", async () => {
    const engine = new Engine(config());
    // Refused by the static layer, so nothing is asked of the network.
    vi.stubGlobal("fetch", async () => {
      throw new Error("a refused batch must not reach the network");
    });
    const { plan, verdict } = await engine.checkVaultBatch(intent({ rewardTo: "0x00000000000000000000000000000000000000ee" }));
    expect(plan.calls).toEqual([
      {
        to: batcherAddress(engine.vaultFactory).toLowerCase(),
        data: encodeExecuteBatch([VAULT], "0x00000000000000000000000000000000000000ee", 330_000n * 10n ** 9n),
        value: 0n,
        gas: 647_000n,
        gasPrice: 10n ** 9n,
      },
    ]);
    expect(engine.vaultBatcher).toBe(batcherAddress(engine.vaultFactory).toLowerCase());
    // The reward goes to the account that sends it, and nobody else.
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toContain("VAULT_MALFORMED");
  });
});

/** A fake network service: a chain, a head, and what its test-runs report. */
interface FakeService {
  chainId?: number;
  head?: bigint;
  blockHash?: string;
  /** The logs a test-run reports; the default is the 1-wei transfer record. */
  logs?: (from: string, to: string) => unknown[];
  down?: boolean;
  noSimulate?: boolean;
}

const word = (v: bigint | string) => (typeof v === "string" ? v.slice(2).toLowerCase().padStart(64, "0") : v.toString(16).padStart(64, "0"));
const transferRecord = (from: string, to: string) => [
  { address: NATIVE_TOKEN, topics: [TOPICS.transfer, `0x${word(from)}`, `0x${word(to)}`], data: `0x${word(1n)}` },
];

function serve(services: Record<string, FakeService>) {
  const asked: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    const service = services[url];
    asked.push({ url, method });
    if (service === undefined || service.down) throw new TypeError("fetch failed");
    const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    const head = service.head ?? 26_000_010n;
    switch (method) {
      case "eth_chainId":
        return answer(`0x${(service.chainId ?? 690069).toString(16)}`);
      case "eth_blockNumber":
        return answer(`0x${head.toString(16)}`);
      case "eth_getBlockByNumber":
        return answer({
          number: params[0],
          hash: service.blockHash ?? `0x${"ab".repeat(32)}`,
          timestamp: "0x6a000000",
          gasLimit: "0x2255100",
        });
      case "eth_simulateV1": {
        if (service.noSimulate) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }), { status: 200 });
        }
        const block = (params[0] as { blockStateCalls: { calls: { from: string; to: string }[] }[] }).blockStateCalls[0]!;
        if (block.calls.length === 0) return answer([]);
        const call = block.calls[0]!;
        const logs = (service.logs ?? transferRecord)(call.from, call.to);
        return answer([{ calls: [{ status: "0x1", gasUsed: "0x5208", logs }] }]);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return asked;
}

describe("testSecondOpinion", () => {
  const SECOND = "https://second.example/rpc";
  const run = (url = SECOND, mainUrl: string | null = MAIN) => testSecondOpinion({ mainUrl, url, chainId: 690069 });

  it("passes a service on the same chain whose test-run of a 1-wei transfer matches, ether record included", async () => {
    const asked = serve({ [MAIN]: {}, [SECOND]: {} });
    expect(await run()).toEqual({ ok: true, warning: null });
    // Both services were asked, and nothing else.
    expect(new Set(asked.map((a) => a.url))).toEqual(new Set([MAIN, SECOND]));
    expect(asked.filter((a) => a.url === SECOND).map((a) => a.method)).toContain("eth_simulateV1");
  });

  it("refuses the main service again, anything that isn't a web address, and another chain", async () => {
    serve({ [MAIN]: {}, [SECOND]: { chainId: 1 } });
    expect(await run("http://127.0.0.1:1/unused/")).toEqual({
      ok: false,
      error: "That's your main service. A second opinion has to come from somewhere else.",
    });
    expect((await run("ftp://second.example")).ok).toBe(false);
    expect(await run()).toEqual({ ok: false, error: "That service is on chain 1, not 690069." });
    expect(await run(SECOND, null)).toEqual({ ok: false, error: "Choose your main network service first." });
  });

  it("refuses a service whose test-runs don't match, or that leaves out the ether record like the main one", async () => {
    serve({ [MAIN]: {}, [SECOND]: { logs: () => [] } });
    expect(await run()).toEqual({
      ok: false,
      error: "That service's test-runs don't match your main service's, so it can't be a second opinion.",
    });
    serve({ [MAIN]: { logs: () => [] }, [SECOND]: { logs: () => [] } });
    expect(await run()).toEqual({
      ok: false,
      error: "That service's test-runs don't match your main service's, so it can't be a second opinion.",
    });
  });

  it("says what failed on the second service, and never passes one that can't test-run", async () => {
    serve({ [MAIN]: {}, [SECOND]: { down: true } });
    expect(await run()).toEqual({ ok: false, error: "That service didn't answer, so it can't be checked. Check the address and try again." });
    serve({ [MAIN]: {}, [SECOND]: { noSimulate: true } });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^That service can't be used: /);
  });

  it("warns, without refusing, when both are probably one operator's", async () => {
    const main = "https://eth-mainnet.g.alchemy.com/v2/a";
    const second = "https://eth.alchemy.com/v2/b";
    serve({ [main]: {}, [second]: {} });
    expect(await run(second, main)).toEqual({
      ok: true,
      warning: "Both are at alchemy.com: probably the same operator, so not much of a second opinion.",
    });
  });
});
