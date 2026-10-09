/**
 * The conformance kit.
 *
 * Published so that anyone writing a module can prove it satisfies the contract
 * before asking a user to install it — and so spDEX can prove the same of its
 * own modules, with the same harness, on every commit.
 *
 * "Anyone can write a module" is only a credible offer if what a module must do
 * is written down and checkable. This is that, executable.
 *
 * ## One harness, every kind
 *
 * The checks every module owes are the same whatever it is for: its manifest
 * parses, it loads in the sandbox, its one characteristic call returns
 * well-formed output, identical inputs give identical bytes, and it stays
 * inside its call budget. What differs by kind is which call that is and what
 * else is worth asking, so the kit dispatches on the manifest's kind through
 * `EXERCISES` — one row per kind the host can load, required by the type, so a
 * kind cannot become loadable without this kit learning how to check it.
 */

import {
  ModuleManifestSchema,
  canonicalDigest,
  vetScheduleDecision,
  type ModuleManifest,
  type WirePoolRef,
  type WireScheduleDecision,
  type WireScheduleRequest,
} from "@spdex/core";
import {
  AuthoredIntentError,
  BrokerSession,
  CapabilityBroker,
  QuickJSRuntime,
  assertLoadable,
  isLoadableKind,
  type ChainReader,
  type KindViews,
  type LoadableKind,
} from "@spdex/host";

export interface ConformanceTarget {
  manifest: unknown;
  /** Self-contained module source, as it would be installed. */
  code: string;
  /** Deterministic chain stub. Real RPC would make results irreproducible. */
  chain: ChainReader;
  /** Inputs the module is exercised with. */
  samplePair?: { tokenA: string; tokenB: string };
  /** The pools a tracker is asked to scan. Defaults to one pool of the sample pair. */
  samplePools?: WirePoolRef[];
  /**
   * What a scheduler is asked. Defaults to a request with one plan in each
   * state a plan can be in, including one that missed a window.
   */
  sampleSchedule?: WireScheduleRequest;
}

export interface ConformanceCheck {
  id: string;
  description: string;
  passed: boolean;
  detail?: string;
}

export interface ConformanceReport {
  passed: boolean;
  checks: ConformanceCheck[];
}

const DEFAULT_PAIR = {
  tokenA: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c",
  tokenB: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
};

/** The real SPX/WETH 1% pool, holding the default pair. */
const DEFAULT_POOLS: WirePoolRef[] = [
  {
    poolId: "0x00ed26e794b949e18b142f9108429b74ce08ac99",
    token0: DEFAULT_PAIR.tokenA,
    token1: DEFAULT_PAIR.tokenB,
    fee: 10_000,
    depth: "0",
  },
];

const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NOW = 1_790_000_000;
const HOUR = 3_600;
const DAY = 86_400;

/**
 * One plan per state, listed out of id order.
 *
 * `dca-a-due` missed window 2 and is in window 3, so a scheduler that makes up
 * missed buys proposes two and is refused. `dca-b-waiting` has not started,
 * `dca-c-finished` has made every buy, and `dca-d-bought` already bought in the
 * window open now. An honest scheduler proposes exactly one buy: window 3 of
 * `dca-a-due`, at most its per-buy amount.
 */
const DEFAULT_SCHEDULE: WireScheduleRequest = {
  now: String(NOW),
  plans: [
    { id: "dca-d-bought", sell: ETH, buy: DEFAULT_PAIR.tokenA, amountPerBuy: "5000000000000000",
      intervalSeconds: String(2 * HOUR), startAt: String(NOW - HOUR), maxBuys: 4 },
    { id: "dca-a-due", sell: ETH, buy: DEFAULT_PAIR.tokenA, amountPerBuy: "1000000000000000",
      intervalSeconds: String(HOUR), startAt: String(NOW - 3 * HOUR - 100), maxBuys: 10 },
    { id: "dca-c-finished", sell: DEFAULT_PAIR.tokenB, buy: DEFAULT_PAIR.tokenA, amountPerBuy: "20000000000000000",
      intervalSeconds: String(DAY), startAt: String(NOW - 10 * DAY), maxBuys: 2 },
    { id: "dca-b-waiting", sell: ETH, buy: DEFAULT_PAIR.tokenA, amountPerBuy: "3000000000000000",
      intervalSeconds: String(DAY), startAt: String(NOW + 600), maxBuys: 5 },
  ],
  progress: [
    { planId: "dca-a-due", buysDone: 1, lastSlot: 1 },
    { planId: "dca-c-finished", buysDone: 2, lastSlot: 5 },
    { planId: "dca-d-bought", buysDone: 1, lastSlot: 0 },
  ],
};

type Recorder = (id: string, description: string, passed: boolean, detail?: string) => void;

interface Inputs {
  pair: { tokenA: string; tokenB: string };
  pools: WirePoolRef[];
  schedule: WireScheduleRequest;
}

interface ExtraContext {
  manifest: ModuleManifest;
  inputs: Inputs;
  record: Recorder;
  /** What the characteristic call returned the first time, already schema-checked. */
  firstRun: unknown;
  /** Chain reads made across every characteristic call. */
  callsUsed: number;
}

/** How to exercise one kind of module. */
interface Exercise<K extends LoadableKind> {
  /** The characteristic call; its check is recorded as `interface.<method>`. */
  method: string;
  description: string;
  call(view: KindViews[K], inputs: Inputs, session: BrokerSession): Promise<unknown>;
  /** Checks only this kind has, run after the shared ones. */
  extra?(view: KindViews[K], context: ExtraContext): Promise<void>;
}

const EXERCISES: { [K in LoadableKind]: Exercise<K> } = {
  venue: {
    method: "discoverPools",
    description: "discoverPools returns well-formed pools",
    call: (venue, inputs, session) => venue.discoverPools(inputs.pair, session),
    async extra(venue, { inputs, record }) {
      // ── Quote and build ──
      const { pair } = inputs;
      try {
        const pools = await venue.discoverPools(pair, new BrokerSession());
        const quotes = await venue.quoteBatch(
          [{ tokenIn: pair.tokenA, tokenOut: pair.tokenB, amountIn: "1000000000" }],
          pools,
          new BrokerSession(),
        );
        record("interface.quoteBatch", "quoteBatch returns well-formed quotes", quotes.length > 0,
          `returned ${quotes.length} quotes`);

        const firstQuote = quotes[0];
        if (firstQuote) {
          // A module must not author intent; the host attaches it. The host's
          // own view refuses an answer carrying one, by name, after checking
          // its shape — the schema strips unknown keys, so looking for the
          // key on the parsed result could never find it.
          let authored = false;
          let calls: unknown;
          try {
            const plan = await venue.buildCalls(
              firstQuote,
              {
                recipient: "0x1111111111111111111111111111111111111111",
                minAmountOut: "1",
                deadline: "1790000000",
              },
              new BrokerSession(),
            );
            calls = plan.calls;
          } catch (error) {
            if (!(error instanceof AuthoredIntentError)) throw error;
            authored = true;
          }
          record("interface.buildCalls", "buildCalls returns a well-formed build result",
            authored || Array.isArray(calls));
          record("interface.noIntent", "does not attempt to author the swap intent", !authored,
            authored ? "buildCalls returned an intent key" : undefined);
        }
      } catch (error) {
        record("interface.quoteBatch", "quoteBatch returns well-formed quotes", false, messageOf(error));
      }
    },
  },

  tiplist: {
    method: "listRecipients",
    description: "listRecipients returns well-formed recipients",
    call: (registry, _inputs, session) => registry.listRecipients(session),
  },

  tracker: {
    method: "scanPools",
    description: "scanPools returns well-formed pool statistics",
    call: (tracker, inputs, session) => tracker.scanPools(inputs.pools, session),
  },

  scheduler: {
    method: "dueBuys",
    description: "dueBuys returns a well-formed decision",
    call: (scheduler, inputs, session) => scheduler.dueBuys(inputs.schedule, session),
    async extra(_scheduler, { manifest, inputs, record, firstRun, callsUsed }) {
      // The same envelope the host applies before quoting anything. A
      // scheduler that fails it would have every proposal it makes refused,
      // so it is not doing its job — and one that tries to spend more, early,
      // twice in a window, or to make up missed windows fails here by name.
      const { refused } = vetScheduleDecision(inputs.schedule, firstRun as WireScheduleDecision);
      record("scheduler.withinPlan", "proposes only buys the plans allow", refused.length === 0,
        refused.length === 0
          ? undefined
          : refused.map((r) => `${r.buy.planId} window ${r.buy.slot}: ${r.reason}`).join("; "));

      // Judged on the declaration, not only on behaviour: a scheduler that
      // reads the chain only when some condition holds would pass on a sample
      // where it does not. Its answer decides when money moves, so it must be
      // a function of what the host hands it — which is also what lets the
      // host and the Guard check that answer against the same inputs. If a
      // strategy ever needs market data, the host passes it in the request.
      const declaresRead = manifest.capabilities.includes("chain:read");
      const declaresContracts = manifest.contracts.length > 0;
      const reasons = [
        ...(declaresRead ? ["declares chain:read"] : []),
        ...(declaresContracts ? [`declares contracts ${manifest.contracts.join(", ")}`] : []),
        ...(callsUsed > 0 ? [`read the chain ${callsUsed} times`] : []),
      ];
      record("scheduler.noChainRead", "decides from the request alone, reading nothing",
        reasons.length === 0, reasons.length === 0 ? undefined : reasons.join("; "));
    },
  },
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runConformance(target: ConformanceTarget): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const record: Recorder = (id, description, passed, detail) => {
    checks.push({ id, description, passed, ...(detail === undefined ? {} : { detail }) });
  };

  // ── Manifest ──
  const parsed = ModuleManifestSchema.safeParse(target.manifest);
  record("manifest.valid", "manifest matches the published schema", parsed.success,
    parsed.success ? undefined : parsed.error.issues.map((i) => i.message).join("; "));
  if (!parsed.success) return { passed: false, checks };
  const manifest = parsed.data;

  // ── Kind ──
  // Before loading, because what "loads" means — which methods a module must
  // define — depends on the kind. The same gate the host applies at its load
  // seam, so a module the kit passes is one the host would agree to load.
  const kind = manifest.kind;
  try {
    if (!isLoadableKind(kind)) throw new Error(`no conformance checks for ${kind} modules yet`);
    assertLoadable(manifest, kind);
    record("kind.supported", "is a kind the host can load and this kit can check", true, kind);
  } catch (error) {
    record("kind.supported", "is a kind the host can load and this kit can check", false, messageOf(error));
    return { passed: false, checks };
  }

  const inputs: Inputs = {
    pair: target.samplePair ?? DEFAULT_PAIR,
    pools: target.samplePools ?? DEFAULT_POOLS,
    schedule: target.sampleSchedule ?? DEFAULT_SCHEDULE,
  };
  return exercise(kind, manifest, target, inputs, checks, record);
}

async function exercise<K extends LoadableKind>(
  kind: K,
  manifest: ModuleManifest,
  target: ConformanceTarget,
  inputs: Inputs,
  checks: ConformanceCheck[],
  record: Recorder,
): Promise<ConformanceReport> {
  const spec: Exercise<K> = EXERCISES[kind];
  const broker = new CapabilityBroker({ manifest, chain: target.chain });
  const runtime = new QuickJSRuntime({ maxRounds: 8 });
  const interfaceCheck = `interface.${spec.method}`;
  let callsUsed = 0;
  const call = async (view: KindViews[K], session = new BrokerSession()) => {
    try {
      return await spec.call(view, inputs, session);
    } finally {
      callsUsed += session.callsUsed;
    }
  };

  // ── Loads in the sandbox ──
  // Checked first because everything else depends on it, and because a module
  // that only works natively is not installable by anyone.
  let loaded: KindViews[K];
  try {
    loaded = await runtime.loadKind(kind, { kind: "code", code: target.code }, broker);
    record("sandbox.loads", "loads inside the QuickJS sandbox", true);
  } catch (error) {
    record("sandbox.loads", "loads inside the QuickJS sandbox", false, messageOf(error));
    return { passed: false, checks };
  }

  try {
    // ── Interface ──
    let firstRun: unknown;
    try {
      firstRun = await call(loaded);
      record(interfaceCheck, spec.description, true);
    } catch (error) {
      record(interfaceCheck, spec.description, false, messageOf(error));
      return { passed: false, checks };
    }

    // ── Determinism ──
    // The parity gate and every reproducibility claim rest on this. A module
    // reaching for a clock or randomness fails here rather than producing
    // quietly different plans on two machines.
    try {
      const secondRun = await call(loaded);
      const a = await canonicalDigest(firstRun);
      const b = await canonicalDigest(secondRun);
      record("determinism.repeatable", "identical inputs produce identical output", a === b,
        a === b ? undefined : `digests differ: ${a.slice(0, 16)} vs ${b.slice(0, 16)}`);
    } catch (error) {
      record("determinism.repeatable", "identical inputs produce identical output", false, messageOf(error));
    }

    // ── Budget ──
    const session = new BrokerSession();
    try {
      await call(loaded, session);
      const withinBudget = session.callsUsed <= manifest.limits.maxCallsPerQuote;
      record("budget.respected", "stays within its declared call budget", withinBudget,
        `used ${session.callsUsed} of ${manifest.limits.maxCallsPerQuote}`);
    } catch (error) {
      record("budget.respected", "stays within its declared call budget", false, messageOf(error));
    }

    // ── What only this kind is asked ──
    await spec.extra?.(loaded, { manifest, inputs, record, firstRun, callsUsed });
  } finally {
    loaded.dispose();
  }

  return { passed: checks.every((c) => c.passed), checks };
}
