/**
 * Conformance: what a module must do, and what it must not be able to do.
 *
 * The honest fixture must pass every check — otherwise the kit is just a
 * rejection machine and proves nothing. Each hostile fixture must fail, and
 * fail for the stated reason rather than incidentally.
 */

import { describe, expect, it } from "vitest";
import {
  HONEST_MODULE,
  HONEST_SCHEDULER,
  HOSTILE_MODULES,
  HOSTILE_SCHEDULERS,
  SAMPLE_SCHEDULE,
  SPX,
  StubChainReader,
  honestManifest,
  schedulerManifest,
} from "@spdex/testing";
import { CONTRACTS } from "@spdex/chain";
import {
  BrokerSession,
  CapabilityBroker,
  QuickJSRuntime,
  CapabilityDeniedError,
} from "@spdex/host";
import { runConformance } from "../../src/conformance.js";

const manifest = (overrides: Parameters<typeof honestManifest>[0] = {}) =>
  honestManifest(overrides);

describe("conformance kit", () => {
  it("passes an honest module on every check", async () => {
    const report = await runConformance({
      manifest: manifest(),
      code: HONEST_MODULE,
      chain: new StubChainReader(),
    });

    const failures = report.checks.filter((c) => !c.passed);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("runs every venue check it always has, in the same order", async () => {
    // The kit dispatches on kind now. A venue author's report must not lose a
    // check in the move; the one addition is the kind check before loading.
    const report = await runConformance({
      manifest: manifest(),
      code: HONEST_MODULE,
      chain: new StubChainReader(),
    });
    expect(report.checks.map((c) => c.id)).toEqual([
      "manifest.valid",
      "kind.supported",
      "sandbox.loads",
      "interface.discoverPools",
      "determinism.repeatable",
      "budget.respected",
      "interface.quoteBatch",
      "interface.buildCalls",
      "interface.noIntent",
    ]);
  });

  it("refuses a kind it has no checks for before loading anything", async () => {
    // Without this, a manifest declaring a kind the host cannot load would be
    // exercised as a venue and could come back conformant.
    for (const kind of ["policy", "tokenlist"] as const) {
      const report = await runConformance({
        manifest: manifest({ kind }),
        code: HONEST_MODULE,
        chain: new StubChainReader(),
      });
      expect(report.passed).toBe(false);
      expect(report.checks.map((c) => c.id)).toEqual(["manifest.valid", "kind.supported"]);
      expect(report.checks[1]?.detail).toBe(`no conformance checks for ${kind} modules yet`);
    }
  });

  it("reports a module that reaches for a clock as non-deterministic", async () => {
    // `Date` and `Math.random` are removed from the VM, so this fixture throws
    // rather than drifting — either way it must not be reported conformant.
    const report = await runConformance({
      manifest: manifest(),
      code: HOSTILE_MODULES.nonDeterministic,
      chain: new StubChainReader(),
    });
    expect(report.passed).toBe(false);
  });

  it("fails a venue that authors the swap intent, which the schema alone would strip unseen", async () => {
    const report = await runConformance({
      manifest: manifest(),
      code: HOSTILE_MODULES.authorsIntent,
      chain: new StubChainReader(),
    });
    expect(HOSTILE_MODULES.authorsIntent).toContain("intent:");
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === "interface.buildCalls")?.passed).toBe(true);
    expect(report.checks.find((c) => c.id === "interface.noIntent")).toMatchObject({ passed: false });
  });

  it("rejects a module whose output does not match the interface", async () => {
    const report = await runConformance({
      manifest: manifest(),
      code: HOSTILE_MODULES.malformedOutput,
      chain: new StubChainReader(),
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === "interface.discoverPools")?.passed).toBe(false);
  });

  it("refuses to load a module targeting an incompatible host API", async () => {
    const report = await runConformance({
      manifest: manifest({ apiVersion: "9.0.0" }),
      code: HOSTILE_MODULES.wrongApiVersion,
      chain: new StubChainReader(),
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === "sandbox.loads")?.passed).toBe(false);
  });

  it("rejects a manifest that does not match the schema", async () => {
    const report = await runConformance({
      manifest: { id: "Not Kebab Case", version: "v1" },
      code: HONEST_MODULE,
      chain: new StubChainReader(),
    });
    expect(report.passed).toBe(false);
    expect(report.checks[0]?.id).toBe("manifest.valid");
  });
});

describe("conformance for schedulers", () => {
  const run = (code: string, overrides: Parameters<typeof schedulerManifest>[0] = {}, chain = new StubChainReader()) =>
    runConformance({ manifest: schedulerManifest(overrides), code, chain, sampleSchedule: SAMPLE_SCHEDULE });
  const check = (report: Awaited<ReturnType<typeof runConformance>>, id: string) =>
    report.checks.find((c) => c.id === id);

  it("passes an honest scheduler on every check, including its own", async () => {
    const report = await run(HONEST_SCHEDULER);
    const failures = report.checks.filter((c) => !c.passed);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    expect(report.checks.map((c) => c.id)).toEqual([
      "manifest.valid",
      "kind.supported",
      "sandbox.loads",
      "interface.dueBuys",
      "determinism.repeatable",
      "budget.respected",
      "scheduler.withinPlan",
      "scheduler.noChainRead",
    ]);
    expect(report.passed).toBe(true);
  });

  it("passes an honest scheduler on the kit's own sample too", async () => {
    const report = await runConformance({
      manifest: schedulerManifest(),
      code: HONEST_SCHEDULER,
      chain: new StubChainReader(),
    });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("fails a scheduler that keeps its own time", async () => {
    // `Date` is absent in the sandbox, so the clock-reader cannot answer at all.
    const report = await run(HOSTILE_SCHEDULERS.readsClock);
    expect(report.passed).toBe(false);
    expect(check(report, "interface.dueBuys")?.passed).toBe(false);
    expect(check(report, "interface.dueBuys")?.detail).toMatch(/Date/);
  });

  it("fails a scheduler that proposes more than one buy's amount", async () => {
    const report = await run(HOSTILE_SCHEDULERS.oversizes);
    expect(report.passed).toBe(false);
    // Everything else about it is well-formed: the envelope is what catches it.
    expect(report.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["scheduler.withinPlan"]);
    expect(check(report, "scheduler.withinPlan")?.detail).toMatch(/dca-a-due window 3: larger than one buy/);
  });

  it("fails a scheduler that makes up missed windows", async () => {
    const report = await run(HOSTILE_SCHEDULERS.bunchesMissedWindows);
    expect(report.passed).toBe(false);
    expect(report.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["scheduler.withinPlan"]);
    expect(check(report, "scheduler.withinPlan")?.detail).toMatch(/window 2: not for the window open now/);
  });

  it("fails a scheduler that reads the chain, whether or not it was allowed to", async () => {
    // Allowed: the read succeeds, and the declaration is what fails.
    const allowed = new StubChainReader();
    const granted = await run(
      HOSTILE_SCHEDULERS.readsChain,
      {
        capabilities: ["chain:read"],
        contracts: [SPX],
        limits: { maxFuel: 1_000_000n, maxMemory: 8_388_608n, maxCallsPerQuote: 1 },
      },
      allowed,
    );
    expect(granted.passed).toBe(false);
    expect(granted.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["scheduler.noChainRead"]);
    expect(check(granted, "scheduler.noChainRead")?.detail).toBe(
      `declares chain:read; declares contracts ${SPX}; read the chain 3 times`,
    );
    expect(allowed.calls.length).toBeGreaterThan(0);

    // Not allowed: the broker denies the read before it happens, so the
    // module cannot answer and the chain is never touched.
    const denied = new StubChainReader();
    const refused = await run(HOSTILE_SCHEDULERS.readsChain, {}, denied);
    expect(refused.passed).toBe(false);
    expect(check(refused, "interface.dueBuys")?.passed).toBe(false);
    expect(denied.calls).toHaveLength(0);
  });

  it("fails venue code presented as a scheduler, at load", async () => {
    const report = await run(HONEST_MODULE);
    expect(report.passed).toBe(false);
    expect(check(report, "sandbox.loads")?.detail).toMatch(/does not implement dueBuys/);
  });
});

describe("conformance for registries and trackers", () => {
  const REGISTRY = `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async listRecipients() {
        return [{ address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", label: "one" }];
      },
    };
  `;
  const TRACKER = `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async scanPools(pools, ctx) {
        var calls = [];
        pools.forEach(function (p) {
          calls.push({ to: p.token0, data: "0x70a08231" }, { to: p.token1, data: "0x70a08231" });
        });
        var out = await ctx.multicall(calls);
        return pools.map(function (p, i) {
          return { poolId: p.poolId, supported: true, token0: p.token0, token1: p.token1,
            balance0: BigInt(out[2 * i]).toString(), balance1: BigInt(out[2 * i + 1]).toString(), fee: p.fee };
        });
      },
    };
  `;

  it("passes an honest registry, calling it by its own method", async () => {
    const report = await runConformance({
      manifest: manifest({ kind: "tiplist", capabilities: [], contracts: [] }),
      code: REGISTRY,
      chain: new StubChainReader(),
    });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.checks.map((c) => c.id)).toContain("interface.listRecipients");
  });

  it("passes an honest tracker, within its budget", async () => {
    const report = await runConformance({
      manifest: manifest({ kind: "tracker" }),
      code: TRACKER,
      chain: new StubChainReader(),
    });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.checks.find((c) => c.id === "budget.respected")?.detail).toBe("used 2 of 64");
  });

  it("fails a module whose code is not the kind its manifest declares", async () => {
    const report = await runConformance({
      manifest: manifest({ kind: "tracker" }),
      code: REGISTRY,
      chain: new StubChainReader(),
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === "sandbox.loads")?.detail).toMatch(/does not implement scanPools/);
  });
});

describe("sandbox escape attempts", () => {
  const load = async (code: string, manifestOverrides = {}) => {
    const chain = new StubChainReader();
    const broker = new CapabilityBroker({ manifest: manifest(manifestOverrides), chain });
    const runtime = new QuickJSRuntime({ maxRounds: 8 });
    return { loaded: await runtime.load({ kind: "code", code }, broker), chain };
  };

  it("has no network: fetch is not defined inside the VM", async () => {
    // Not blocked — absent. QuickJS ships no host bindings, so there is nothing
    // to delete and nothing to leak past a denylist.
    const { loaded } = await load(HOSTILE_MODULES.reachesForNetwork);
    try {
      await expect(
        loaded.buildCalls(
          { poolId: "p", tokenIn: "0x" + "1".repeat(40), tokenOut: "0x" + "2".repeat(40), amountIn: "1", amountOut: "1", gasEstimate: "1" },
          { recipient: "0x1111111111111111111111111111111111111111", minAmountOut: "1", deadline: "1790000000" },
          new BrokerSession(),
        ),
      ).rejects.toThrow(/'?fetch'? is not defined|not a function/i);
    } finally {
      loaded.dispose();
    }
  });

  it("cannot read a contract its manifest does not declare", async () => {
    const { loaded, chain } = await load(HOSTILE_MODULES.readsUndeclaredContract);
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow();
      // The denial happens before the read, not after: the RPC is never touched.
      expect(chain.calls).toHaveLength(0);
    } finally {
      loaded.dispose();
    }
  });

  it("cannot exceed its declared call budget", async () => {
    const { loaded, chain } = await load(HOSTILE_MODULES.exceedsCallBudget);
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow();
      expect(chain.calls).toHaveLength(0);
    } finally {
      loaded.dispose();
    }
  });

  it("cannot loop forever — the fuel budget interrupts it", async () => {
    const { loaded } = await load(HOSTILE_MODULES.infiniteLoop, {
      limits: { maxFuel: 50_000n, maxMemory: 16_777_216n, maxCallsPerQuote: 64 },
    });
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow(/interrupt/i);
    } finally {
      loaded.dispose();
    }
  }, 30_000);

  it("cannot exhaust memory — the allocator ceiling stops it", async () => {
    const { loaded } = await load(HOSTILE_MODULES.memoryBomb, {
      limits: { maxFuel: 100_000_000n, maxMemory: 4_194_304n, maxCallsPerQuote: 64 },
    });
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow(/out of memory/i);
    } finally {
      loaded.dispose();
    }
  }, 30_000);

  it("cannot hang idly — a promise that never settles is caught structurally", async () => {
    // A promise that never settles burns no CPU, so no interrupt ever fires.
    // Under the synchronous replay design it cannot hang the host either: the
    // VM never suspends, so after the microtask queue drains the module has
    // simply not produced a result, and there is nothing that could later
    // deliver one. That is detected immediately rather than waited out — no
    // wall-clock timeout, and no thread left parked for ten seconds.
    const { loaded } = await load(HOSTILE_MODULES.neverSettles);
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow(/did not settle/i);
    } finally {
      loaded.dispose();
    }
  }, 30_000);

  it("bounds host round-trips — a module that never converges is stopped", async () => {
    // The sandbox is synchronous: the host runs the module, fetches whatever it
    // asked for, and runs it again from the top with a longer cache. That loop
    // needs a ceiling, or a module could keep the host fetching forever by
    // requesting one more read each time.
    const { loaded } = await load(HOSTILE_MODULES.neverConverges);
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow(/round-trips/i);
    } finally {
      loaded.dispose();
    }
  }, 30_000);

  it("replays multi-round reads deterministically", async () => {
    // The honest venue fixture reads twice: once to find pools, once to price
    // them. Two rounds is the ordinary case, and it must produce the same
    // answer every time the module is re-run from the top.
    const { loaded, chain } = await load(HONEST_MODULE);
    try {
      const pair = { tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) };
      const first = await loaded.discoverPools(pair, new BrokerSession());
      const callsAfterFirst = chain.calls.length;
      const second = await loaded.discoverPools(pair, new BrokerSession());

      expect(second).toEqual(first);
      // Identical work each time — replay must not multiply host reads.
      expect(chain.calls.length - callsAfterFirst).toBe(callsAfterFirst);
    } finally {
      loaded.dispose();
    }
  }, 30_000);

  it("denies chain access to a module that never requested the capability", async () => {
    const { loaded, chain } = await load(HONEST_MODULE, { capabilities: ["log"] });
    try {
      await expect(
        loaded.discoverPools({ tokenA: "0x" + "1".repeat(40), tokenB: "0x" + "2".repeat(40) }, new BrokerSession()),
      ).rejects.toThrow();
      expect(chain.calls).toHaveLength(0);
    } finally {
      loaded.dispose();
    }
  });
});

describe("the broker itself", () => {
  it("throws CapabilityDeniedError naming the contract reached for", async () => {
    const chain = new StubChainReader();
    const broker = new CapabilityBroker({ manifest: manifest(), chain });
    const ctx = broker.createContext(new BrokerSession());

    await expect(
      ctx.call({ to: "0x6666666666666666666666666666666666666666", data: "0x" }),
    ).rejects.toThrowError(CapabilityDeniedError);
  });

  it("refuses the host's aggregator even when the manifest declares it", async () => {
    // The allowlist turned against itself: Multicall3 is how the host batches
    // reads, so a module allowed to call it directly could pass a nested
    // aggregate3 and reach any contract on chain. The broker would check the
    // outer target, find it permitted, and never look at the inner calls.
    const chain = new StubChainReader();
    const withAggregator = manifest({
      contracts: [...honestManifest().contracts, CONTRACTS.multicall3],
    });
    const broker = new CapabilityBroker({ manifest: withAggregator, chain });
    const ctx = broker.createContext(new BrokerSession());

    await expect(
      ctx.call({ to: CONTRACTS.multicall3, data: "0x82ad56cb" }),
    ).rejects.toThrowError(CapabilityDeniedError);
    expect(chain.calls).toHaveLength(0);
  });

  it("scopes budgets per session, not per module lifetime", async () => {
    // Budgets that leaked between quotes would make a module fail on its
    // fourth keystroke for no reason the user could understand.
    const chain = new StubChainReader();
    const broker = new CapabilityBroker({ manifest: manifest(), chain });

    for (let i = 0; i < 5; i++) {
      const session = new BrokerSession();
      const ctx = broker.createContext(session);
      await ctx.call({ to: manifest().contracts[0]!, data: "0x01" });
      expect(session.callsUsed).toBe(1);
    }
  });
});
