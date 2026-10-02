/**
 * The parity gate.
 *
 * spDEX runs first-party modules natively for speed and everything else in a
 * QuickJS sandbox. That is only defensible if the two runtimes are
 * indistinguishable from the module's point of view — otherwise the sandbox
 * path is exercised solely by strangers, silently under-specifies, and the
 * "one interface" claim quietly becomes false.
 *
 * So: the same module source, run both ways, must produce byte-identical
 * output, and must be refused identically when it oversteps. A native module
 * is faster. It is not more trusted, and it is not allowed to be more capable.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest, type ModuleManifest } from "@spdex/core";
import {
  HONEST_MODULE,
  HONEST_SCHEDULER,
  HOSTILE_MODULES,
  HOSTILE_SCHEDULERS,
  SAMPLE_SCHEDULE,
  WIRE_SENSITIVE_MODULE,
  StubChainReader,
  honestManifest,
  loadNative,
  schedulerManifest,
} from "@spdex/testing";
import { BrokerSession, CapabilityBroker } from "../../src/broker.js";
import { KIND_SPECS } from "../../src/runtimes/kinds.js";
import { NativeRuntime } from "../../src/runtimes/native.js";
import { QuickJSRuntime } from "../../src/runtimes/quickjs.js";
import {
  ModuleExecutionError,
  type KindViews,
  type LoadableKind,
  type LoadedModule,
  type ModuleRuntime,
  type ModuleSource,
  type RuntimeKind,
} from "../../src/runtimes/types.js";

const PAIR = {
  tokenA: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c",
  tokenB: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
};

type ManifestOverrides = Parameters<typeof honestManifest>[0];

async function loadBoth(code: string, overrides: ManifestOverrides = {}) {
  const nativeChain = new StubChainReader();
  const sandboxChain = new StubChainReader();

  const native = await new NativeRuntime().load(
    { kind: "object", module: loadNative(code) },
    new CapabilityBroker({ manifest: honestManifest(overrides), chain: nativeChain }),
  );
  const sandboxed = await new QuickJSRuntime({ maxRounds: 8 }).load(
    { kind: "code", code },
    new CapabilityBroker({ manifest: honestManifest(overrides), chain: sandboxChain }),
  );

  return { native, sandboxed, nativeChain, sandboxChain };
}

/** Exercise the full module surface and return everything it produced. */
async function exercise(module: LoadedModule) {
  const pools = await module.discoverPools(PAIR, new BrokerSession());
  const quotes = await module.quoteBatch(
    [
      { tokenIn: PAIR.tokenA, tokenOut: PAIR.tokenB, amountIn: "10000000000" },
      { tokenIn: PAIR.tokenA, tokenOut: PAIR.tokenB, amountIn: "20000000000" },
    ],
    pools,
    new BrokerSession(),
  );
  const built = quotes[0]
    ? await module.buildCalls(
        quotes[0],
        {
          recipient: "0x1111111111111111111111111111111111111111",
          minAmountOut: "1",
          deadline: "1790000000",
        },
        new BrokerSession(),
      )
    : null;
  return { pools, quotes, built };
}

describe("native and QuickJS produce identical results", () => {
  it("returns byte-identical output for the same module source", async () => {
    const { native, sandboxed } = await loadBoth(HONEST_MODULE);
    try {
      const a = await exercise(native);
      const b = await exercise(sandboxed);

      // Canonical digests, not deep-equality: this is the same comparison the
      // determinism check uses, so a difference in encoding counts as a
      // difference in behaviour.
      expect(await canonicalDigest(a)).toBe(await canonicalDigest(b));
      expect(a.pools).toEqual(b.pools);
      expect(a.quotes).toEqual(b.quotes);
      expect(a.built).toEqual(b.built);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("issues the same chain reads in the same order", async () => {
    // Identical output from different reads would mean one runtime is quietly
    // taking a different path to the same answer.
    const { native, sandboxed, nativeChain, sandboxChain } = await loadBoth(HONEST_MODULE);
    try {
      await exercise(native);
      await exercise(sandboxed);
      expect(nativeChain.calls).toEqual(sandboxChain.calls);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("marshals identically for output that depends on serialisation", async () => {
    // `liquidity` arrives as an object carrying toJSON. The sandbox always
    // marshals through JSON; native matches only if it performs the same
    // round-trip. Mutation testing proved the other fixtures cannot detect a
    // native runtime that skips it, because their output is already JSON-safe.
    const { native, sandboxed } = await loadBoth(WIRE_SENSITIVE_MODULE);
    try {
      const a = await exercise(native);
      const b = await exercise(sandboxed);

      expect(await canonicalDigest(a)).toBe(await canonicalDigest(b));
      expect(a.pools[0]?.depth).toBe("42");
      expect(b.pools[0]?.depth).toBe("42");
      expect(a.quotes[0]?.amountOut).toBe("99");
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("reports the same apiVersion", async () => {
    const { native, sandboxed } = await loadBoth(HONEST_MODULE);
    try {
      expect(native.apiVersion).toBe(sandboxed.apiVersion);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);
});

describe("native is not more permissive than the sandbox", () => {
  it("denies an undeclared contract in both runtimes", async () => {
    // The central claim of the two-runtime design. If native were more
    // permissive here, the fast path would be a privilege escalation.
    const { native, sandboxed, nativeChain, sandboxChain } = await loadBoth(
      HOSTILE_MODULES.readsUndeclaredContract,
    );
    try {
      await expect(native.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
      await expect(sandboxed.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
      expect(nativeChain.calls).toHaveLength(0);
      expect(sandboxChain.calls).toHaveLength(0);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("denies an over-budget module in both runtimes", async () => {
    const { native, sandboxed, nativeChain, sandboxChain } = await loadBoth(
      HOSTILE_MODULES.exceedsCallBudget,
    );
    try {
      await expect(native.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
      await expect(sandboxed.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
      expect(nativeChain.calls).toHaveLength(0);
      expect(sandboxChain.calls).toHaveLength(0);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("denies chain access without the capability in both runtimes", async () => {
    const { native, sandboxed } = await loadBoth(HONEST_MODULE, { capabilities: ["log"] });
    try {
      await expect(native.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
      await expect(sandboxed.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("rejects malformed module output in both runtimes", async () => {
    const { native, sandboxed } = await loadBoth(HOSTILE_MODULES.malformedOutput);
    try {
      await expect(native.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
      await expect(sandboxed.discoverPools(PAIR, new BrokerSession())).rejects.toThrow();
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  }, 30_000);

  it("refuses an incompatible apiVersion in both runtimes", async () => {
    const code = HOSTILE_MODULES.wrongApiVersion;
    const overrides = { apiVersion: "9.0.0" } as ManifestOverrides;
    const chain = new StubChainReader();

    await expect(
      new NativeRuntime().load(
        { kind: "object", module: loadNative(code) },
        new CapabilityBroker({ manifest: honestManifest(overrides), chain }),
      ),
    ).rejects.toThrow(/host API/i);

    await expect(
      new QuickJSRuntime().load(
        { kind: "code", code },
        new CapabilityBroker({ manifest: honestManifest(overrides), chain }),
      ),
    ).rejects.toThrow(/host API/i);
  }, 30_000);
});

describe("the native runtime refuses to evaluate source", () => {
  it("will not run raw code in-process", async () => {
    // Evaluating untrusted source natively would need `unsafe-eval` and hand
    // that code the host's own scope — precisely what the sandbox exists to
    // prevent. Source goes to QuickJS or nowhere.
    const chain = new StubChainReader();
    await expect(
      new NativeRuntime().load(
        { kind: "code", code: HONEST_MODULE },
        new CapabilityBroker({ manifest: honestManifest(), chain }),
      ),
    ).rejects.toThrow(/sandbox/i);
  });
});

/** An inline registry, so registry parity is about the runtimes rather than one module's contents. */
const REGISTRY_SOURCE = `
  globalThis.spdexModule = {
    apiVersion: "1.0.0",
    async listRecipients() {
      return [
        { address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", label: "one", handle: "@one" },
        { address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", label: "two" },
      ];
    },
  };
`;

/**
 * Parity for a kind that is not a venue.
 *
 * Adding the tip registry was the first time anything other than a venue was
 * loaded, and it is exactly where a "one interface, two runtimes" claim would
 * quietly stop being true: the sandbox path for a new kind is the one nobody
 * exercises until a stranger ships a module that uses it.
 *
 * The registry that ships with the app is covered in its own package; this is
 * the gate, and it uses a module defined inline so the claim is about the
 * runtimes rather than about one module's contents.
 */
describe("registry modules load identically in both runtimes", () => {
  /** A registry declares no capabilities, so neither side gets a chain reader. */
  const brokerFor = () =>
    new CapabilityBroker({
      manifest: honestManifest({ capabilities: [], contracts: [] }),
      chain: new StubChainReader(),
    });

  it("returns byte-identical lists", async () => {
    const sandboxed = await new QuickJSRuntime().loadRegistry(
      { kind: "code", code: REGISTRY_SOURCE },
      brokerFor(),
    );
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- mirrors the
    // native loader's contract: a resolved object, not evaluated source.
    const resolved = new Function(`${REGISTRY_SOURCE}; return globalThis.spdexModule;`)();
    const native = await new NativeRuntime().loadRegistry(
      { kind: "object", module: resolved },
      brokerFor(),
    );

    const a = await native.listRecipients(new BrokerSession());
    const b = await sandboxed.listRecipients(new BrokerSession());
    // Awaited, because canonicalDigest is async. Forgetting compares two
    // distinct Promise objects, which are never identical — so it fails
    // loudly rather than passing for anything, but on a message ("no visual
    // difference") that sends you looking at the module instead of the test.
    expect(await canonicalDigest(b)).toBe(await canonicalDigest(a));

    native.dispose();
    sandboxed.dispose();
  });

  it("refuse a module missing the method, identically", async () => {
    const EMPTY = `globalThis.spdexModule = { apiVersion: "1.0.0" };`;
    await expect(
      new QuickJSRuntime().loadRegistry({ kind: "code", code: EMPTY }, brokerFor()),
    ).rejects.toThrow(/listRecipients/);
    await expect(
      new NativeRuntime().loadRegistry(
        { kind: "object", module: { apiVersion: "1.0.0" } },
        brokerFor(),
      ),
    ).rejects.toThrow(/RegistryModule/);
  });

  it("refuse a venue asked to be a registry, in both runtimes", async () => {
    // Kinds are not interchangeable, and the failure must be at load with a
    // readable message rather than at the first call with a TypeError.
    await expect(
      new QuickJSRuntime().loadRegistry({ kind: "code", code: HONEST_MODULE }, brokerFor()),
    ).rejects.toThrow(/listRecipients/);
    await expect(
      new NativeRuntime().loadRegistry(
        { kind: "object", module: await loadNative(HONEST_MODULE) },
        brokerFor(),
      ),
    ).rejects.toThrow(/RegistryModule/);
  });
});

const TOKEN_A = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const TOKEN_B = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** An inline tracker that reads both tokens' balances for every pool, in one batch. */
const TRACKER_SOURCE = `
  globalThis.spdexModule = {
    apiVersion: "1.0.0",
    async scanPools(pools, ctx) {
      const calls = [];
      for (const pool of pools) {
        calls.push({ to: pool.token0, data: "0x70a08231" });
        calls.push({ to: pool.token1, data: "0x70a08231" });
      }
      const results = await ctx.multicall(calls);
      return pools.map((pool, i) => ({
        poolId: String(pool.poolId).toLowerCase(),
        supported: true,
        token0: String(pool.token0).toLowerCase(),
        token1: String(pool.token1).toLowerCase(),
        balance0: BigInt(results[i * 2] || "0x0").toString(),
        balance1: BigInt(results[i * 2 + 1] || "0x0").toString(),
        fee: Number(pool.fee) || 0,
      }));
    },
  };
`;

const POOLS = [
  { poolId: "0xaaa0000000000000000000000000000000000001", token0: TOKEN_A, token1: TOKEN_B, fee: 3000, depth: "0" },
];

/**
 * Parity for the third kind.
 *
 * A tracker is the first non-venue module that actually reads the chain, so it
 * is the first place where a registry's "no capabilities" shortcut stops
 * applying: both runtimes have to drive the same `ctx.multicall` round trips
 * in the same order and produce the same bytes from the same answers.
 */
describe("tracker modules load identically in both runtimes", () => {
  const brokerFor = () =>
    new CapabilityBroker({
      manifest: honestManifest({ contracts: [TOKEN_A, TOKEN_B] }),
      chain: new StubChainReader(),
    });

  it("drive the same reads and return the same bytes", async () => {
    const sandboxed = await new QuickJSRuntime().loadTracker(
      { kind: "code", code: TRACKER_SOURCE },
      brokerFor(),
    );
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- mirrors the
    // native loader's contract: a resolved object, not evaluated source.
    const resolved = new Function(`${TRACKER_SOURCE}; return globalThis.spdexModule;`)();
    const native = await new NativeRuntime().loadTracker(
      { kind: "object", module: resolved },
      brokerFor(),
    );

    const a = await native.scanPools(POOLS, new BrokerSession());
    const b = await sandboxed.scanPools(POOLS, new BrokerSession());
    expect(await canonicalDigest(b)).toBe(await canonicalDigest(a));

    native.dispose();
    sandboxed.dispose();
  });

  it("refuse the same undeclared read, in both runtimes", async () => {
    // The capability model is the reason a tracker can be shipped at all. It
    // has to bind identically whichever runtime is executing.
    const SNOOP = `
      globalThis.spdexModule = {
        apiVersion: "1.0.0",
        async scanPools(pools, ctx) {
          await ctx.multicall([{ to: "0x000000000000000000000000000000000000dead", data: "0x70a08231" }]);
          return [];
        },
      };
    `;
    const sandboxed = await new QuickJSRuntime().loadTracker({ kind: "code", code: SNOOP }, brokerFor());
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- see above.
    const resolved = new Function(`${SNOOP}; return globalThis.spdexModule;`)();
    const native = await new NativeRuntime().loadTracker(
      { kind: "object", module: resolved },
      brokerFor(),
    );

    await expect(sandboxed.scanPools(POOLS, new BrokerSession())).rejects.toThrow();
    await expect(native.scanPools(POOLS, new BrokerSession())).rejects.toThrow();

    native.dispose();
    sandboxed.dispose();
  });
});

/**
 * Parity for the fourth kind.
 *
 * A scheduler decides when money moves, so "the sandbox answer is the same
 * answer" matters more here than anywhere: a user running with strictSandbox
 * must get the buys a native user gets, at the same moments, of the same
 * size. It is also the first kind loaded only through `loadKind`.
 */
describe("scheduler modules load identically in both runtimes", () => {
  const brokerFor = (manifest: ModuleManifest = schedulerManifest(), chain = new StubChainReader()) =>
    new CapabilityBroker({ manifest, chain });

  async function loadBoth(code: string, manifest?: ModuleManifest) {
    const nativeChain = new StubChainReader();
    const sandboxChain = new StubChainReader();
    const native = await new NativeRuntime().loadKind(
      "scheduler",
      { kind: "object", module: loadNative(code) },
      brokerFor(manifest, nativeChain),
    );
    const sandboxed = await new QuickJSRuntime().loadKind(
      "scheduler",
      { kind: "code", code },
      brokerFor(manifest, sandboxChain),
    );
    return { native, sandboxed, nativeChain, sandboxChain };
  }

  it("return byte-identical decisions", async () => {
    const { native, sandboxed } = await loadBoth(HONEST_SCHEDULER);
    try {
      const a = await native.dueBuys(SAMPLE_SCHEDULE, new BrokerSession());
      const b = await sandboxed.dueBuys(SAMPLE_SCHEDULE, new BrokerSession());
      expect(await canonicalDigest(b)).toBe(await canonicalDigest(a));
      // And the answer is the one the sample was built to produce, so the
      // equality above is not two runtimes agreeing on nothing.
      expect(a.due).toEqual([{ planId: "dca-a-due", slot: 3, amountIn: "1000000000000000" }]);
      expect(a.next.map((n) => n.planId)).toEqual(["dca-a-due", "dca-b-waiting", "dca-c-finished", "dca-d-bought"]);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  });

  it("refuse a module missing the method, identically", async () => {
    const EMPTY = `globalThis.spdexModule = { apiVersion: "1.0.0" };`;
    await expect(
      new QuickJSRuntime().loadKind("scheduler", { kind: "code", code: EMPTY }, brokerFor()),
    ).rejects.toThrow(/does not implement dueBuys/);
    await expect(
      new NativeRuntime().loadKind("scheduler", { kind: "object", module: loadNative(EMPTY) }, brokerFor()),
    ).rejects.toThrow(/SchedulerModule/);
  });

  it("refuse a venue asked to be a scheduler, and a scheduler asked to be a venue", async () => {
    await expect(
      new QuickJSRuntime().loadKind("scheduler", { kind: "code", code: HONEST_MODULE }, brokerFor()),
    ).rejects.toThrow(/dueBuys/);
    await expect(
      new NativeRuntime().loadKind("scheduler", { kind: "object", module: loadNative(HONEST_MODULE) }, brokerFor()),
    ).rejects.toThrow(/SchedulerModule/);
    await expect(
      new QuickJSRuntime().load({ kind: "code", code: HONEST_SCHEDULER }, brokerFor()),
    ).rejects.toThrow(/discoverPools/);
    await expect(
      new NativeRuntime().load({ kind: "object", module: loadNative(HONEST_SCHEDULER) }, brokerFor()),
    ).rejects.toThrow(/VenueModule/);
  });

  it("deny a scheduler's chain read in both runtimes, before the read", async () => {
    // The fixture manifest grants nothing. Error classes differ between the
    // runtimes here (the sandbox's denial is raised host-side), so only the
    // refusal and the untouched chain are asserted.
    const { native, sandboxed, nativeChain, sandboxChain } = await loadBoth(HOSTILE_SCHEDULERS.readsChain);
    try {
      await expect(native.dueBuys(SAMPLE_SCHEDULE, new BrokerSession())).rejects.toThrow();
      await expect(sandboxed.dueBuys(SAMPLE_SCHEDULE, new BrokerSession())).rejects.toThrow();
      expect(nativeChain.calls).toHaveLength(0);
      expect(sandboxChain.calls).toHaveLength(0);
    } finally {
      native.dispose();
      sandboxed.dispose();
    }
  });
});

/**
 * Answers that cannot cross the wire fail the same way in both runtimes.
 *
 * The sandbox serialises a module's answer inside the VM, so a bigint or a
 * throwing `toJSON` fails the call as the module's error, and `undefined`
 * arrives as `null` and is refused by the schema. Native used to serialise
 * outside the module's frame and to choke on `undefined` with a SyntaxError,
 * so each of these answers failed with one error natively and a different one
 * in the sandbox. The assertions are on the error class because that is what
 * the collapse onto one load path made identical.
 */
describe("the runtimes fail identically on answers that cannot cross the wire", () => {
  const answering = (answer: string) => `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async dueBuys() { ${answer} },
    };
  `;

  async function failureOf(code: string) {
    const results: string[] = [];
    for (const runtime of [new NativeRuntime(), new QuickJSRuntime()] as const) {
      const source: ModuleSource =
        runtime.kind === "native" ? { kind: "object", module: loadNative(code) } : { kind: "code", code };
      const view = await runtime.loadKind(
        "scheduler",
        source,
        new CapabilityBroker({ manifest: schedulerManifest(), chain: new StubChainReader() }),
      );
      try {
        await view.dueBuys(SAMPLE_SCHEDULE, new BrokerSession());
        results.push("resolved");
      } catch (error) {
        results.push(error instanceof Error ? error.name : typeof error);
      } finally {
        view.dispose();
      }
    }
    return results;
  }

  it("a bigint in the answer is the module's error in both", async () => {
    expect(await failureOf(answering("return { due: [], next: [], extra: 1n };"))).toEqual([
      "ModuleExecutionError",
      "ModuleExecutionError",
    ]);
  });

  it("a throwing toJSON is the module's error in both", async () => {
    const code = answering(`return { toJSON: function () { throw new Error("no"); } };`);
    expect(await failureOf(code)).toEqual(["ModuleExecutionError", "ModuleExecutionError"]);
  });

  it("no answer at all is refused by the schema in both", async () => {
    expect(await failureOf(answering("return undefined;"))).toEqual(["ZodError", "ZodError"]);
  });

  it("a disposed module refuses every call in both", async () => {
    for (const runtime of [new NativeRuntime(), new QuickJSRuntime()] as const) {
      const source: ModuleSource =
        runtime.kind === "native"
          ? { kind: "object", module: loadNative(HONEST_SCHEDULER) }
          : { kind: "code", code: HONEST_SCHEDULER };
      const view = await runtime.loadKind(
        "scheduler",
        source,
        new CapabilityBroker({ manifest: schedulerManifest(), chain: new StubChainReader() }),
      );
      view.dispose();
      await expect(view.dueBuys(SAMPLE_SCHEDULE, new BrokerSession())).rejects.toThrow(ModuleExecutionError);
    }
  });
});

/**
 * `loadKind` is the old entry points, generalised — nothing more.
 *
 * `load`, `loadRegistry` and `loadTracker` now delegate to it. Each kind is
 * loaded both ways in both runtimes and must give the same bytes, the same
 * view, and the same refusal: the existing parity tests above then stand as
 * regression tests for the one load path underneath.
 */
describe("loadKind is equivalent to the legacy entry points", () => {
  interface Case<K extends LoadableKind> {
    source: string;
    manifest: () => ModuleManifest;
    legacy(runtime: ModuleRuntime, source: ModuleSource, broker: CapabilityBroker): Promise<KindViews[K]>;
    run(view: KindViews[K]): Promise<unknown>;
  }

  function equivalence<K extends LoadableKind>(moduleKind: K, c: Case<K>) {
    const broker = () => new CapabilityBroker({ manifest: c.manifest(), chain: new StubChainReader() });
    const sources = (code: string): Record<RuntimeKind, ModuleSource> => ({
      native: { kind: "object", module: loadNative(code) },
      quickjs: { kind: "code", code },
    });
    const runtimes = [new NativeRuntime(), new QuickJSRuntime()] as const;

    it(`${moduleKind}: the same bytes, both ways, in both runtimes`, async () => {
      const digests: string[] = [];
      for (const runtime of runtimes) {
        const source = sources(c.source)[runtime.kind];
        for (const view of [
          await c.legacy(runtime, source, broker()),
          await runtime.loadKind(moduleKind, source, broker()),
        ]) {
          digests.push(await canonicalDigest(await c.run(view)));
          view.dispose();
        }
      }
      expect(new Set(digests).size).toBe(1);
    });

    it(`${moduleKind}: the same view, carrying only its own kind's methods`, async () => {
      // The sandbox's view used to carry every kind's methods at runtime, with
      // only the type saying otherwise.
      const expected = ["apiVersion", "dispose", "kind", ...KIND_SPECS[moduleKind].methods].sort();
      for (const runtime of runtimes) {
        const source = sources(c.source)[runtime.kind];
        for (const view of [
          await c.legacy(runtime, source, broker()),
          await runtime.loadKind(moduleKind, source, broker()),
        ]) {
          expect(Object.keys(view).sort()).toEqual(expected);
          expect(view.kind).toBe(runtime.kind);
          view.dispose();
        }
      }
    });

    it(`${moduleKind}: the same refusal for a module with no methods`, async () => {
      const EMPTY = `globalThis.spdexModule = { apiVersion: "1.0.0" };`;
      for (const runtime of runtimes) {
        const source = sources(EMPTY)[runtime.kind];
        const messages = await Promise.all([
          c.legacy(runtime, source, broker()).then(() => "loaded", (e: Error) => e.message),
          runtime.loadKind(moduleKind, source, broker()).then(() => "loaded", (e: Error) => e.message),
        ]);
        expect(messages[0]).not.toBe("loaded");
        expect(messages[1]).toBe(messages[0]);
      }
    });
  }

  equivalence("venue", {
    source: HONEST_MODULE,
    manifest: () => honestManifest(),
    legacy: (runtime, source, broker) => runtime.load(source, broker),
    run: exercise,
  });

  equivalence("tiplist", {
    source: REGISTRY_SOURCE,
    manifest: () => honestManifest({ kind: "tiplist", capabilities: [], contracts: [] }),
    legacy: (runtime, source, broker) => runtime.loadRegistry(source, broker),
    run: (registry) => registry.listRecipients(new BrokerSession()),
  });

  equivalence("tracker", {
    source: TRACKER_SOURCE,
    manifest: () => honestManifest({ kind: "tracker", contracts: [TOKEN_A, TOKEN_B] }),
    legacy: (runtime, source, broker) => runtime.loadTracker(source, broker),
    run: (tracker) => tracker.scanPools(POOLS, new BrokerSession()),
  });
});
