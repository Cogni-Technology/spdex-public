/**
 * Wiring: config in, executable plan out.
 *
 * This is where the pieces meet — module registry, capability broker, chain
 * reader, router and Guard — and it is deliberately the only place that knows
 * how they fit together. Everything above it deals in a quote and a verdict.
 *
 * The one rule enforced here rather than left to callers: a plan is never
 * returned without a Guard verdict attached. Making them arrive together means
 * a UI cannot accidentally render a swap button for a transaction nobody
 * checked.
 */

import {
  EthSimulateV1Provider,
  UnavailableSimulationProvider,
  Multicall3Reader,
  SwapLogVolumeReader,
  UniswapV3TwapOracle,
  codeHashAt,
  hasDuplicateIds,
  httpRpc,
  probeSimulateV1,
  readFxRates,
  NATIVE_TOKEN,
  TOKENS,
  TOPICS,
  type FxRead,
  type PoolVolume,
  type JsonRpc,
  type SimulationProvider,
} from "@spdex/chain";
import {
  BrokerSession,
  CapabilityBroker,
  NativeRuntime,
  QuickJSRuntime,
  assertLoadable,
  type LoadedModule,
} from "@spdex/host";
import {
  Guard,
  ScheduledBuyGuard,
  SecondOpinionPair,
  TipGuard,
  VaultGuard,
  readBlockHash,
  secondOpinionHost,
  type GuardInput,
  type VaultBatchIntent,
  type VaultBatchTxPlan,
  type VaultProveIntent,
  type VaultProveTxPlan,
  type VaultTxPlan,
} from "@spdex/guard";
import { encodeExecuteBatch, encodeProve } from "@spdex/vault";
import { SCHEDULER_MODULE_ID, TIPLIST_MODULE_ID } from "@spdex/config";
import {
  candidatesFromQuotes,
  chunkGrid,
  planRoute,
  linearGasModel,
  IGNORE_GAS,
  type GasModel,
  type RoutePlan,
} from "@spdex/router";
import {
  isPermit2CodeHash,
  ModuleManifestSchema,
  PERMIT2_ADDRESS,
  PLACEHOLDER_CHAINS,
  type DcaPlan,
  type DcaProgress,
  type GuardVerdict,
  type SpdexConfig,
  type TipPermissionPlan,
  type TipPlan,
  type TipSignatureRequest,
  type TxPlan,
  type Address,
  type WirePoolStats,
  type WirePoolRef,
  type WireScheduleDecision,
  type WireScheduleRequest,
  type WireTipCandidate,
  type WireVenueQuote,
} from "@spdex/core";
import v3Module from "../../../../modules/venue-uniswap-v3/index.mjs";
import v3Source from "../../../../modules/venue-uniswap-v3/module.js?raw";
import v3ManifestJson from "../../../../modules/venue-uniswap-v3/manifest.json";
import v2Module from "../../../../modules/venue-uniswap-v2/index.mjs";
import v2Source from "../../../../modules/venue-uniswap-v2/module.js?raw";
import v2ManifestJson from "../../../../modules/venue-uniswap-v2/manifest.json";
import tiplistModule from "../../../../modules/tiplist-spx-community/index.mjs";
import tiplistSource from "../../../../modules/tiplist-spx-community/module.js?raw";
import tiplistManifestJson from "../../../../modules/tiplist-spx-community/manifest.json";
import devTipsModule from "../../../../modules/tiplist-dev-fixtures/index.mjs";
import devTipsSource from "../../../../modules/tiplist-dev-fixtures/module.js?raw";
import devTipsManifestJson from "../../../../modules/tiplist-dev-fixtures/manifest.json";
import trackerModule from "../../../../modules/tracker-pool-stats/index.mjs";
import trackerSource from "../../../../modules/tracker-pool-stats/module.js?raw";
import trackerManifestJson from "../../../../modules/tracker-pool-stats/manifest.json";
import schedulerModule from "../../../../modules/scheduler-dca/index.mjs";
import schedulerSource from "../../../../modules/scheduler-dca/module.js?raw";
import schedulerManifestJson from "../../../../modules/scheduler-dca/manifest.json";
import { isNative, tradedAs, type TokenInfo } from "./tokens.js";
import { REFUSED_TIP_RECIPIENTS } from "./tiplist/contracts.js";
import { allowance } from "./erc20.js";
import { quantity } from "./receipts.js";
import { loadUsdRates } from "./stats.js";
import {
  DefiniteSimulationProvider,
  ObservedSimulationProvider,
  SecondOpinionMonitor,
  normalizeServiceUrl,
  sameOperatorWarning,
  sameService,
  sharedOperator,
  withTimeout,
  type SecondOpinionStatus,
} from "./simulation.js";

/**
 * The most slippage a scheduled buy is quoted with, in basis points: 3%, or
 * the Router's setting if that is lower.
 *
 * A manual swap uses the setting as it is — a person chose it and watches
 * the result. A scheduled buy is broadcast with nobody looking, time after
 * time, and its floor is exactly what a sandwich can take: at the 50% the
 * setting allows (or an imported config carries), every buy would hand up to
 * half its value to whoever trades around it. A constant, like the interval
 * floor, so no setting can widen it; a buy the market moves by more than this
 * between quote and inclusion reverts rather than fills at any price.
 */
export const MAX_SCHEDULED_SLIPPAGE_BPS = 300;

/**
 * Venues that ship with the app.
 *
 * Each is loadable two ways from one source of truth: the resolved module for
 * the native runtime, and the same file's text for the sandbox. Adding a venue
 * is an entry here plus a config module id — the host, router and Guard need no
 * changes, which is the modular claim actually holding up.
 */
interface BuiltinVenue {
  manifest: ReturnType<typeof ModuleManifestSchema.parse>;
  module: unknown;
  source: string;
}

const BUILTIN_VENUES: BuiltinVenue[] = [
  // v2 first: it holds the overwhelming majority of SPX liquidity, so it is the
  // venue most quotes will actually route through.
  { manifest: ModuleManifestSchema.parse(v2ManifestJson), module: v2Module, source: v2Source },
  { manifest: ModuleManifestSchema.parse(v3ManifestJson), module: v3Module, source: v3Source },
];

/**
 * A registry that ships with the app, and when it is asked.
 *
 * Both are switched on by the tip list's own module switch (the Tips
 * feature). The test entries are asked only on a local test network: their
 * addresses are public development accounts, whose keys anyone has.
 */
interface BuiltinRegistry extends BuiltinVenue {
  /** The config module whose switch turns this registry on. */
  enabledBy: string;
  /** The networks it is asked on; every network when absent. */
  onlyOn?: ReadonlySet<number>;
}

/**
 * Registries that ship with the app: the real list, and the test entries the
 * fork specs tip (modules/tiplist-dev-fixtures), which are never asked
 * outside `PLACEHOLDER_CHAINS`.
 *
 * Same two-way loading as a venue, from one source of truth, for the same
 * reason: the parity gate compares the two, and a second copy of the source
 * would make "identical output" a comparison between different programs.
 */
const BUILTIN_REGISTRIES: BuiltinRegistry[] = [
  {
    manifest: ModuleManifestSchema.parse(tiplistManifestJson),
    module: tiplistModule,
    source: tiplistSource,
    enabledBy: TIPLIST_MODULE_ID,
  },
  {
    manifest: ModuleManifestSchema.parse(devTipsManifestJson),
    module: devTipsModule,
    source: devTipsSource,
    enabledBy: TIPLIST_MODULE_ID,
    onlyOn: PLACEHOLDER_CHAINS,
  },
];

/**
 * Trackers that ship with the app.
 *
 * Loaded exactly like a venue or a registry — the third kind through the same
 * broker, the same manifest checks and the same two runtimes.
 */
const BUILTIN_TRACKERS: BuiltinVenue[] = [
  {
    manifest: ModuleManifestSchema.parse(trackerManifestJson),
    module: trackerModule,
    source: trackerSource,
  },
];

/**
 * Schedulers that ship with the app: the fourth kind, loaded the same way.
 *
 * One, and it is the arithmetic of a fixed amount on a fixed beat. What it
 * answers is only ever a proposal — `vetScheduleDecision` and then the
 * `ScheduledBuyGuard` hold every buy to the plan the user wrote — so a
 * different strategy could replace it without being trusted with the budget.
 */
const BUILTIN_SCHEDULERS: BuiltinVenue[] = [
  {
    manifest: ModuleManifestSchema.parse(schedulerManifestJson),
    module: schedulerModule,
    source: schedulerSource,
  },
];

/** A tip candidate, plus which registry vouched for it. */
export type DiscoveredRecipient = WireTipCandidate & { registryId: string };

/** A pool, plus which venue found it — the wire type carries no venue id. */
export type DiscoveredPool = WirePoolRef & { venueId: string };

export interface QuoteRequest {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  /**
   * The account that would sign, or null before a wallet is connected.
   *
   * Nullable on purpose: quoting without a wallet is a normal thing to do —
   * people look at prices before connecting — and the route is real either way.
   * Only the simulation depends on knowing whose balances to use.
   */
  account: `0x${string}` | null;
  /**
   * Where the output goes. Defaults to `account`.
   *
   * A manual swap never sets it. A scheduled buy does, to the owner its
   * record names — the account that signs it too — and the Guard verifies
   * delivery by measuring what arrives *there*, not at the signer.
   */
  recipient?: `0x${string}`;
}

/** What `quoteScheduled` is given: the plan, its record, and the buy the scheduler proposed. */
export interface ScheduledQuoteInput {
  plan: DcaPlan;
  /** This browser's record of the plan before this buy is claimed. Signer and owner come from here. */
  progress: DcaProgress;
  slot: number;
  amountIn: bigint;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  /**
   * The clock the buy is judged at, unix seconds. The runner passes the moment
   * it decided the buy was due, so the window it proposed and the window the
   * Guard checks are the same one. Defaults to now.
   */
  nowSeconds?: bigint;
  /**
   * Called once the route is built and before the Guard runs, so a status
   * line can move from "Getting a price…" to "Running the safety check…".
   * Display only: nothing it does can change what is checked.
   */
  onCheck?: () => void;
}

export interface LegPlan {
  poolId: string;
  venueId: string;
  label?: string;
  shareBps: number;
  amountIn: bigint;
  amountOut: bigint;
  plan: TxPlan;
  verdict: GuardVerdict;
}

export interface QuoteResult {
  route: RoutePlan;
  /**
   * Every pool discovered for the pair, including ones the user's policy
   * excludes. The expert picker needs the excluded ones to be able to show them
   * as unticked rather than absent.
   */
  pools: DiscoveredPool[];
  legs: LegPlan[];
  /** Lowest verdict across legs — a swap is only as safe as its worst leg. */
  verdict: GuardVerdict;
  minAmountOut: bigint;
  /** Set when gas could not be priced, so the route ignored it. */
  gasPricingNote?: string;
  /**
   * True when the quote was produced without a connected wallet.
   *
   * The route is real; the outcome simply has not been proven, because there
   * was no account to simulate against.
   */
  previewOnly: boolean;
}

export class Engine {
  readonly #rpc: JsonRpc;
  readonly #chain: Multicall3Reader;
  readonly #guard: Guard;
  #modules: Map<string, LoadedModule> | null = null;
  /**
   * Discovered pools, keyed by pair.
   *
   * Discovery is a factory lookup plus a probe per fee tier per venue, and it
   * was being run twice for the same pair on the way to a single route — once
   * by the expert panel populating its picker, once inside `quote`. The result
   * cannot change under a given config, and a config change builds a new
   * Engine, so the cache's lifetime is exactly right without any invalidation.
   */
  readonly #poolCache = new Map<string, Promise<DiscoveredPool[]>>();
  /**
   * Used when no wallet is connected.
   *
   * Simulating a swap for an account that holds nothing reverts, and reporting
   * that as a refusal is both alarming and wrong — nothing was refused. Without
   * an account, simulation is genuinely *unavailable*, which the Guard already
   * models honestly: static checks run, the verdict is `unverified`, and the UI
   * says what is missing.
   */
  readonly #previewGuard: Guard;
  /** Tips get the same treatment as a swap; see packages/guard/src/tips.ts. */
  readonly #tipGuard: TipGuard;
  /**
   * Scheduled buys: the plan checks first, then each leg through a Guard
   * built from the very options object a manual swap's Guard is — so nothing
   * a scheduled buy needs can loosen what a manual swap is held to. The one
   * difference is its simulation provider, which remembers only a definite
   * answer about `eth_simulateV1` (see simulation.ts): a scheduled buy is
   * never signed unverified, so a probe that failed once must not stop every
   * later buy.
   */
  readonly #scheduledGuard: ScheduledBuyGuard;
  /**
   * The four transactions around an auto-buy vault — create, fund, close, and
   * a buy the user triggers; see packages/guard/src/vault.ts. Built lazily:
   * it hashes the factory's whole creation code to learn the factory's
   * address, which a page that never shows a vault need not pay for.
   */
  #vaultGuard: VaultGuard | null = null;
  /**
   * The code hash at Permit2's address, once it has been read as the known
   * one. Only a match is kept: Permit2 cannot be changed once deployed, so a
   * match stays true for the Engine's life, whereas a miss or a failed read
   * is asked again next time rather than remembered as "no".
   */
  #permit2Known: Promise<string> | null = null;
  /** Volume, which no module can read — see packages/chain/src/logs.ts. */
  readonly #volume: SwapLogVolumeReader;
  /** The Guard's oracle, reused for display pricing rather than duplicated. */
  readonly #oracle: UniswapV3TwapOracle;
  /**
   * The second opinion (config `guard.secondOpinion.url`): the second
   * service, and what the last check heard from it. Null `pair` when none is
   * set, or when the one set is the main service again, which would only be
   * the same answer twice.
   */
  readonly #second: {
    pair: SecondOpinionPair | null;
    monitor: SecondOpinionMonitor;
    /** For the 1% check on typed money only; built on first use. */
    rates: { rpc: JsonRpc; chain: Multicall3Reader; oracle: UniswapV3TwapOracle } | null;
  };
  /** The second service on its own, for reads a new tip address depends on; built on first use. */
  #secondReads: { rpc: JsonRpc; host: string } | null = null;
  /**
   * The last request the network service failed, and when
   * (`performance.now()`): what `usdRates` puts a read that priced nothing
   * down to, since the oracle it reads through turns every failure into "no
   * opinion". Recorded only; nothing else reads it.
   */
  #lastFailure: { error: unknown; at: number } | null = null;

  constructor(private readonly config: SpdexConfig) {
    if (!config.rpc.url) throw new Error("no RPC endpoint configured");
    const service = httpRpc(config.rpc.url);
    this.#rpc = async (method, params) => {
      try {
        return await service(method, params);
      } catch (error) {
        this.#lastFailure = { error, at: performance.now() };
        throw error;
      }
    };
    this.#chain = new Multicall3Reader(this.#rpc);
    this.#volume = new SwapLogVolumeReader(this.#rpc);
    this.#oracle = new UniswapV3TwapOracle(this.#chain);
    this.#second = secondOpinionOf(config, this.#rpc);
    const guardOptions = {
      chainId: config.chainId,
      requireSimulation: config.guard.requireSimulation,
      oracleDivergenceBps: config.guard.oracleDivergenceBps,
      // The third layer, actually connected. Reading Uniswap's own accumulator
      // through the endpoint the user already chose keeps the cross-check free
      // of any party the rest of the app does not already depend on — and the
      // oracle can only ever add a warning, so a pair it knows nothing about
      // costs the user nothing.
      oracle: this.#oracle,
    };
    // Every Guard that simulates does it through the second opinion when one
    // is set (`#checked`): a check that skipped it would be the one a lying
    // main service aims at. The preview Guard, which simulates nothing, is
    // the only one without.
    //
    // Swaps, tips and vault transactions ask whether the service can test-run
    // through `DefiniteSimulationProvider`, which remembers only a definite
    // answer: on a shared service that is busy for a moment (the built-in
    // one's rate limit), one refused probe must not make every later check on
    // this engine "not checked".
    this.#guard = new Guard(this.#checked(new DefiniteSimulationProvider(this.#rpc)), guardOptions);
    this.#tipGuard = new TipGuard(this.#checked(new DefiniteSimulationProvider(this.#rpc)), {
      chainId: config.chainId,
      requireSimulation: config.guard.requireSimulation,
      permit2CodeHash: () => this.#permit2CodeHash(),
      // Read by the Guard itself, not handed over by the flow that built the
      // batch: what a batch may move Permit2's allowance down from.
      permit2Allowance: (account, token) => allowance(this.#rpc, token, account, PERMIT2_ADDRESS),
      // The contracts a tip is lost in (lib/tiplist/contracts.ts): the listed
      // tokens, the vault factory, the markets' routers. The Guard refuses a
      // transfer to one whatever the config or a list says; the token, Permit2,
      // the burn address and public test accounts it refuses on its own.
      refuseRecipients: REFUSED_TIP_RECIPIENTS,
    });
    this.#scheduledGuard = new ScheduledBuyGuard(new Guard(this.#checked(new DefiniteSimulationProvider(this.#rpc)), guardOptions));
    // No oracle on this one: the cross-check compares against *simulated*
    // effects, and there is no simulation without an account to run it for.
    this.#previewGuard = new Guard(
      new UnavailableSimulationProvider("no wallet connected"),
      {
        chainId: config.chainId,
        // Never `requireSimulation` here: that would turn "you have not
        // connected yet" into a hard refusal on the first screen.
        requireSimulation: false,
        oracleDivergenceBps: config.guard.oracleDivergenceBps,
      },
    );
  }

  get rpc(): JsonRpc {
    return this.#rpc;
  }

  /**
   * `primary`, run past the second opinion when one is set: every simulation
   * also on the second service, on a block both vouch for, and compared (the
   * Guard's `AgreeingSimulationProvider`). What each check heard is kept for
   * the status strip; nothing about that changes what the Guard is given.
   */
  #checked(primary: SimulationProvider): SimulationProvider {
    const { pair, monitor } = this.#second;
    if (pair === null) return primary;
    return new ObservedSimulationProvider(pair.provider(primary), (opinion) => monitor.heard(opinion));
  }

  /**
   * The second opinion as the status strip shows it: none, the main service
   * again (so it doesn't count), or on, with what the last check heard.
   */
  secondOpinionStatus(): SecondOpinionStatus {
    return this.#second.monitor.status;
  }

  /** Called whenever `secondOpinionStatus()` changes. Returns the unsubscribe function. */
  subscribeSecondOpinion(listener: () => void): () => void {
    return this.#second.monitor.subscribe(listener);
  }

  /**
   * The second opinion as a service of its own, with its host name, for the
   * reads a new tip address depends on (where an ENS name points, the code
   * at an address: lib/tiplist/lookup.ts). Null when none is set, or when
   * the one set is the main service again.
   */
  secondOpinion(): { rpc: JsonRpc; host: string } | null {
    const url = this.config.guard.secondOpinion?.url ?? null;
    if (this.#second.pair === null || url === null) return null;
    this.#secondReads ??= { rpc: withTimeout(httpRpc(url)), host: secondOpinionHost(url.trim()) };
    return this.#secondReads;
  }

  /**
   * The rates money is sized with, read again through the second service:
   * the 10-minute average (its own oracle, reading through that service) for
   * `tokens`, and every Chainlink currency rate. Null when no second opinion
   * is set. Used only to compare with the main service's (lib/money/rates.ts):
   * typed money is sized only from prices both agree on to within 1%. A part
   * the second service couldn't read is null, which is its failure, never a
   * disagreement.
   */
  async secondOpinionRates(tokens: readonly string[]): Promise<{ usd: Map<string, bigint> | null; fx: FxRead | null } | null> {
    const url = this.config.guard.secondOpinion?.url ?? null;
    if (this.#second.pair === null || url === null) return null;
    this.#second.rates ??= (() => {
      const rpc = withTimeout(httpRpc(url));
      const chain = new Multicall3Reader(rpc);
      return { rpc, chain, oracle: new UniswapV3TwapOracle(chain) };
    })();
    const { chain, oracle } = this.#second.rates;
    const [usd, fx] = await Promise.all([
      loadUsdRates(tokens, (a, b) => oracle.priceRatio(a, b)).catch(() => null),
      readFxRates(chain).catch(() => null),
    ]);
    return { usd, fx };
  }

  /**
   * Who the enabled registries say can be tipped.
   *
   * Returned with the registry id attached so the UI can show where a name came
   * from. The list is advisory in the strictest sense: the user picks from it,
   * the resolved address is written to their config, and nothing here is ever
   * consulted again at execution time.
   *
   * A registry that fails is skipped, exactly as a venue is — one broken module
   * costs the user that module, not the feature.
   */
  /**
   * Who the enabled tip registries name.
   *
   * The module list is the caller's current one, not the one this Engine was
   * built with. Turning tips on switches the registry module on, and nothing
   * a quote depends on changes with it — so the Engine is deliberately not
   * rebuilt (see `quotingKey`), and reading its own copy would answer as if
   * the registry were still off.
   *
   * `evenIfOff` reads the shipped lists whatever their switch says: the page
   * compares every new tip address with them (lookalikes, a listed name at
   * another address) while tips are still off, and a list not read would
   * read as a list with nobody on it. They are data: no capabilities, no
   * requests.
   */
  async tipCandidates(
    modules: SpdexConfig["modules"] = this.config.modules,
    options: { evenIfOff?: boolean } = {},
  ): Promise<DiscoveredRecipient[]> {
    const enabled = new Set(modules.filter((m) => m.enabled).map((m) => m.id));
    const found: DiscoveredRecipient[] = [];

    for (const registry of BUILTIN_REGISTRIES) {
      if (!options.evenIfOff && !enabled.has(registry.enabledBy)) continue;
      if (registry.onlyOn !== undefined && !registry.onlyOn.has(this.config.chainId)) continue;
      const broker = new CapabilityBroker({ manifest: registry.manifest, chain: this.#chain });
      try {
        // Checked here as at every other seam, not only the newest one: a
        // manifest whose kind disagrees with how it is loaded is a module the
        // host should refuse by name rather than run and hope.
        assertLoadable(registry.manifest, "tiplist");
        const loaded = this.config.strictSandbox
          ? await new QuickJSRuntime().loadRegistry({ kind: "code", code: registry.source }, broker)
          : await new NativeRuntime().loadRegistry(
              { kind: "object", module: registry.module },
              broker,
            );
        try {
          const recipients = await loaded.listRecipients(new BrokerSession());
          // A list that names one id twice is refused whole: ids are what a
          // hidden entry and a replacement are keyed on, and a second entry
          // under one id is a list that can't be read one way only.
          if (hasDuplicateIds(recipients)) continue;
          found.push(...recipients.map((r) => ({ ...r, registryId: registry.manifest.id })));
        } finally {
          loaded.dispose();
        }
      } catch {
        // Surfaced as an empty list; the features modal says when nobody was found.
      }
    }

    return found;
  }

  /**
   * Pool statistics: what a tracker can read, priced and given a volume.
   *
   * Three sources, kept apart on purpose. The tracker reads balances inside
   * the sandbox with nothing but `chain:read` on three token contracts. Volume
   * comes from the host, because `eth_getLogs` is not a capability any module
   * gets. Pricing reuses the Guard's own TWAP oracle rather than a second feed
   * that could disagree with it.
   *
   * Nothing here is in the path of a signature, so everything degrades to
   * null rather than throwing: a statistic that cannot be produced is reported
   * as unknown, never as zero.
   */
  async poolStats(pools: DiscoveredPool[]): Promise<{
    stats: WirePoolStats[];
    volumes: Map<string, PoolVolume>;
    volumeNote?: string;
    /** Blocks the volume figures actually cover; 0 when there are none. */
    volumeBlocks: number;
    rates: Map<string, bigint>;
  }> {
    const empty = { stats: [], volumes: new Map(), rates: new Map(), volumeBlocks: 0 };
    if (pools.length === 0) return empty;

    const enabled = new Set(this.config.modules.filter((m) => m.enabled).map((m) => m.id));
    const tracker = BUILTIN_TRACKERS.find((t) => enabled.has(t.manifest.id));
    if (!tracker) return empty;

    let stats: WirePoolStats[] = [];
    try {
      const broker = new CapabilityBroker({ manifest: tracker.manifest, chain: this.#chain });
      assertLoadable(tracker.manifest, "tracker");
      const loaded = this.config.strictSandbox
        ? await new QuickJSRuntime().loadTracker({ kind: "code", code: tracker.source }, broker)
        : await new NativeRuntime().loadTracker({ kind: "object", module: tracker.module }, broker);
      try {
        stats = await loaded.scanPools(pools, new BrokerSession());
      } finally {
        loaded.dispose();
      }
    } catch {
      // A broken tracker costs the user statistics, never a swap.
      return empty;
    }

    // Volume and prices in parallel: neither depends on the other, and both
    // are slower than the scan that produced the pools. SPX is priced
    // whatever the pair: the ticker's "% to flip" is SPX's market cap, and
    // on a pair without it (WETH/USDC) the item vanished while its supply
    // went on being read.
    const [volumeWindow, rates] = await Promise.all([
      this.#volume.read(pools.map((p) => p.poolId.toLowerCase() as Address)),
      loadUsdRates(
        [...stats.flatMap((s) => [s.token0, s.token1]), TOKENS.SPX.address],
        (a, b) => this.#oracle.priceRatio(a, b),
      ),
    ]);

    return {
      stats,
      volumes: volumeWindow.byPool,
      volumeBlocks: volumeWindow.blocks,
      rates,
      ...(volumeWindow.note === undefined ? {} : { volumeNote: volumeWindow.note }),
    };
  }

  /**
   * Dollar prices for `tokens`: raw USDC per raw token, times 1e18, from the
   * Guard's own 10-minute average oracle (this Engine's, not a second one),
   * read through the person's network service. The same answers as the pool
   * statistics' rates, without needing the statistics switched on: a price is
   * read when something on screen needs one. A token with no price is left
   * out, never priced at zero; USDC is the unit and always present.
   *
   * For display and for sizing an amount typed in money, which the person
   * then sees as a token amount before anything is signed. The Guard never
   * reads it.
   */
  async usdRates(tokens: readonly string[]): Promise<Map<string, bigint>> {
    const startedAt = performance.now();
    const rates = await loadUsdRates(tokens, (a, b) => this.#oracle.priceRatio(a, b));
    // Nothing priced while the service failed a request: the service's
    // failure, thrown, so the money layer can say the service is busy or
    // didn't answer rather than that there is no price (lib/money/rates.ts).
    // A read that priced something, or failed with the service answering,
    // is returned as it came.
    const asked = tokens.filter((token) => token.toLowerCase() !== TOKENS.USDC.address.toLowerCase());
    const failure = this.#lastFailure;
    if (asked.length > 0 && asked.every((token) => !rates.has(token.toLowerCase())) && failure !== null && failure.at >= startedAt) {
      throw failure.error;
    }
    return rates;
  }

  /**
   * Every Chainlink currency rate and USDC/USD, in one request that is the
   * same whatever currency the person uses (packages/chain/src/fx.ts); null
   * when the read failed. Display and input only, like `usdRates`.
   */
  async fxRates(): Promise<FxRead | null> {
    try {
      return await readFxRates(this.#chain);
    } catch {
      return null;
    }
  }

  /**
   * Check a tip plan the way a swap plan is checked.
   *
   * Exposed on the Engine rather than built into `quote` because tips happen
   * *after* a swap settles, against the amount that actually arrived. Folding
   * them into the quote would mean tipping a share of a number that had not
   * happened yet.
   */
  async checkTips(plan: TipPlan): Promise<GuardVerdict> {
    return this.#tipGuard.check(plan);
  }

  /**
   * Check a request to sign a batch of tips, before the wallet is asked.
   * A signature request moves money as surely as a transaction does; see
   * `TipGuard.checkSignature`.
   */
  async checkTipSignature(request: TipSignatureRequest): Promise<GuardVerdict> {
    return this.#tipGuard.checkSignature(request);
  }

  /** Check the standing permission for Permit2, or its revocation. */
  async checkTipPermission(plan: TipPermissionPlan): Promise<GuardVerdict> {
    return this.#tipGuard.checkPermission(plan);
  }

  /**
   * Whether Permit2 on this endpoint's chain is the one spDEX knows: true,
   * false, or `"unknown"` when its code could not be read. Only true lets
   * tips be batched; the Guard asks the same question again before anything
   * that rests on it is signed.
   */
  async permit2Available(): Promise<boolean | "unknown"> {
    try {
      return isPermit2CodeHash(await this.#permit2CodeHash());
    } catch {
      return "unknown";
    }
  }

  #permit2CodeHash(): Promise<string> {
    if (this.#permit2Known) return this.#permit2Known;
    const read = codeHashAt(this.#rpc, PERMIT2_ADDRESS);
    void read.then(
      (hash) => {
        if (isPermit2CodeHash(hash)) this.#permit2Known = read;
      },
      () => {},
    );
    return read;
  }

  /**
   * Check one of the transactions spDEX composes around an auto-buy vault.
   *
   * The host builds them, as it builds tips, and they
   * are checked anyway: the plan may have arrived in a link and the vault's
   * address and state are reads over the network, and at the moment of
   * signing a bug in either looks exactly like an attack. The vault Guard
   * proves the vault is the factory's and the account's from its address
   * alone, and simulates the rest (lib/dca/vault.ts builds the plans).
   */
  async checkVault(plan: VaultTxPlan): Promise<GuardVerdict> {
    return this.#vaults().check(plan);
  }

  /** The factory the vault Guard holds a creation to: where spDEX expects vaults to come from. */
  get vaultFactory(): Address {
    return this.#vaults().factory;
  }

  #vaults(): VaultGuard {
    this.#vaultGuard ??= new VaultGuard(this.#checked(new DefiniteSimulationProvider(this.#rpc)), {
      chainId: this.config.chainId,
      requireSimulation: this.config.guard.requireSimulation,
      // A proof's block hash, read by the Guard itself from this service: what
      // ties a proof to the chain's block rather than to one that only agrees
      // with itself. Without it every proof is refused.
      blockHash: (blockNumber) => readBlockHash(this.#rpc, blockNumber),
    });
    return this.#vaultGuard;
  }

  /**
   * The batcher the vault Guard sends batches through: the one contract a
   * batch of vault buys may be sent to. Bound to no factory, it serves every
   * release whose vaults take `rewardTo`; the Guard's, not worked out here.
   */
  get vaultBatcher(): Address {
    return this.#vaults().batcher.toLowerCase() as Address;
  }

  /**
   * Check a batch of other people's due vault buys, made from the person's
   * wallet and paid to it (Help run the network), and return the one call it
   * may be sent as: exactly this plan, at exactly its gas limit and price.
   *
   * The plan is built here from the intent, never taken from a caller, so the
   * call that is checked is the call that is signed; the vault Guard proves
   * it goes to the listed batcher, that each vault in it is a listed factory's
   * (`intent.claims`), pays the account and nobody else,
   * passes on nothing it can't account for, and is never signed unchecked.
   */
  async checkVaultBatch(intent: VaultBatchIntent): Promise<{ plan: VaultBatchTxPlan; verdict: GuardVerdict }> {
    const plan: VaultBatchTxPlan = {
      version: 1,
      intent,
      calls: [
        {
          to: this.vaultBatcher,
          data: encodeExecuteBatch(intent.vaults, intent.rewardTo, intent.minRewards, { batcher: this.vaultBatcher }),
          value: 0n,
          gas: intent.gasLimit,
          gasPrice: intent.gasPrice,
        },
      ],
    };
    return { plan, verdict: await this.#vaults().check(plan) };
  }

  /** The SPX holder registry the vault Guard's factory names: the one contract a proof of SPX held may be sent to. */
  get vaultRegistry(): Address {
    return this.#vaults().registry;
  }

  /**
   * Check a proof that an address held 690 SPX (Community keeping, under
   * Help run the network), and return the one call it may be sent as.
   *
   * As for a batch, the plan is built here from the intent, never taken from
   * a caller: one call to the registry, no ether, exactly `encodeProve` of
   * the intent. The vault Guard ties the header to the block's hash as this
   * service reports it, and simulates the rest. A proof moves no money, so it
   * may be signed `unverified`; it never goes anywhere but the registry.
   */
  async checkVaultProof(intent: VaultProveIntent): Promise<{ plan: VaultProveTxPlan; verdict: GuardVerdict }> {
    const plan: VaultProveTxPlan = {
      version: 1,
      intent,
      calls: [
        {
          to: this.vaultRegistry,
          data: encodeProve({
            holder: intent.holder,
            header: intent.header,
            accountProof: [...intent.accountProof],
            storageProof: [...intent.storageProof],
          }),
          value: 0n,
        },
      ],
    };
    return { plan, verdict: await this.#vaults().check(plan) };
  }

  /**
   * Whether the endpoint can test-run a transaction before it is signed.
   *
   * A scheduled buy is never signed unchecked (`ScheduledBuyGuard` refuses an
   * `unverified` leg), so an endpoint without `eth_simulateV1` can run no
   * plan at all — better said before a plan is started than after it has
   * skipped its first buy. `false` only when the endpoint answered that it
   * has no such method; no answer, a rate limit or an internal error is
   * `"unknown"`, because none of those says what the endpoint can do, and
   * telling someone to change a working endpoint over a busy moment would be
   * wrong. Probed afresh every time, never remembered.
   */
  async safetyTestAvailable(): Promise<boolean | "unknown"> {
    return probeSimulateV1(this.#rpc);
  }

  /**
   * Whether the Guard's price cross-check can see this pair right now: the
   * same TWAP oracle the Guard asks (native ether priced as WETH) answers a
   * ratio for it.
   *
   * For the plan card's "price check: on / not available right now" row. The
   * oracle is fail-open — it answers null both for "no pool" and for "the read
   * failed" — so `false` means "not available right now", never "this pair has
   * no price"; and it can only ever add a warning, so its absence is stated,
   * not enforced.
   */
  async priceCheckAvailable(sell: Address, buy: Address): Promise<boolean> {
    try {
      return (await this.#oracle.priceRatio(sell, buy)) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Which recurring buys are due now, as the scheduler module proposes them.
   *
   * Loaded through the same broker and runtimes as every other kind, and
   * disposed after the one call. Unlike statistics, a failure here is thrown
   * rather than swallowed: automation that fails silently is automation
   * nobody knows has stopped. What comes back is a proposal only — the caller
   * vets it (`vetScheduleDecision`) and the Guard checks every buy again.
   */
  async dueBuys(request: WireScheduleRequest): Promise<WireScheduleDecision> {
    const enabled = new Set(this.config.modules.filter((m) => m.enabled).map((m) => m.id));
    if (!enabled.has(SCHEDULER_MODULE_ID)) {
      throw new Error("The auto-buy scheduler is turned off in Features.");
    }
    const scheduler = BUILTIN_SCHEDULERS.find((s) => s.manifest.id === SCHEDULER_MODULE_ID);
    if (!scheduler) throw new Error(`no built-in scheduler with the id ${SCHEDULER_MODULE_ID}`);

    // The seam that chooses a module for a job is where its declared kind is
    // checked — the runtimes check only that the code has the right shape.
    assertLoadable(scheduler.manifest, "scheduler");
    const broker = new CapabilityBroker({ manifest: scheduler.manifest, chain: this.#chain });
    const loaded = this.config.strictSandbox
      ? await new QuickJSRuntime().loadKind("scheduler", { kind: "code", code: scheduler.source }, broker)
      : await new NativeRuntime().loadKind("scheduler", { kind: "object", module: scheduler.module }, broker);
    try {
      return await loaded.dueBuys(request, new BrokerSession());
    } finally {
      loaded.dispose();
    }
  }

  /** Which runtime the venue is running in, for display. */
  get runtimeKind(): "native" | "quickjs" {
    return this.config.strictSandbox ? "quickjs" : "native";
  }

  /** Venues the user has enabled, loaded once and reused. */
  async #venues(): Promise<Map<string, LoadedModule>> {
    if (this.#modules) return this.#modules;

    const enabled = new Set(
      this.config.modules.filter((m) => m.enabled).map((m) => m.id),
    );
    const loaded = new Map<string, LoadedModule>();

    for (const venue of BUILTIN_VENUES) {
      if (!enabled.has(venue.manifest.id)) continue;
      assertLoadable(venue.manifest, "venue");
      const broker = new CapabilityBroker({ manifest: venue.manifest, chain: this.#chain });

      // strictSandbox routes first-party modules through QuickJS too, so a user
      // can verify the fast path was never load-bearing. Identical source either
      // way; the parity gate is what makes that claim checkable.
      loaded.set(
        venue.manifest.id,
        this.config.strictSandbox
          ? await new QuickJSRuntime().load({ kind: "code", code: venue.source }, broker)
          : await new NativeRuntime().load({ kind: "object", module: venue.module }, broker),
      );
    }

    this.#modules = loaded;
    return loaded;
  }

  #manifestFor(venueId: string) {
    const venue = BUILTIN_VENUES.find((v) => v.manifest.id === venueId);
    if (!venue) throw new Error(`unknown venue ${venueId}`);
    return venue.manifest;
  }

  /**
   * Every pool the enabled venues can find for this pair.
   *
   * Deliberately *unfiltered* by the user's pool policy. That separation is not
   * cosmetic: this list is what the expert picker renders, and a policy-filtered
   * list made a denied pool disappear from the very control used to deny it, so
   * the checkbox could be unticked and never ticked again. Discovery answers
   * "what exists"; `applyPoolPolicy`, which `quote` calls on the result,
   * answers "what may this route touch".
   *
   * A venue that fails is skipped rather than failing the whole quote: one
   * misbehaving module must not be able to deny the user access to the others.
   */
  async discoverPools(rawIn: TokenInfo, rawOut: TokenInfo): Promise<DiscoveredPool[]> {
    // Native ether has no pool of its own, so discovery always asks about the
    // ERC-20 it trades as. Doing the substitution here rather than at every
    // call site is what keeps ETH from becoming a branch in the router, the
    // tracker and the pool picker as well.
    const tokenIn = tradedAs(rawIn);
    const tokenOut = tradedAs(rawOut);

    // Keyed on the unordered pair: a venue's pools are the same either way
    // round, and quoting A→B then B→A is a single click apart.
    const [first, second] = [tokenIn.address, tokenOut.address].sort();
    const key = `${first}/${second}`;

    const cached = this.#poolCache.get(key);
    if (cached) return cached;

    // The in-flight promise is cached, not just the result, so the expert
    // panel's effect and a concurrent quote share one round trip rather than
    // racing to issue two.
    const forget = () => {
      if (this.#poolCache.get(key) === pending) this.#poolCache.delete(key);
    };
    const pending: Promise<DiscoveredPool[]> = this.#discoverPools(tokenIn, tokenOut).then(
      ({ pools, complete }) => {
        // What the venues that answered found is used, but not remembered: a
        // venue that failed may only have been busy, and remembering its
        // absence would route around its markets for the engine's life.
        if (!complete) forget();
        return pools;
      },
      (error: unknown) => {
        // A failed discovery must not be remembered as "no pools here forever".
        forget();
        throw error;
      },
    );
    this.#poolCache.set(key, pending);
    return pending;
  }

  async #discoverPools(tokenIn: TokenInfo, tokenOut: TokenInfo): Promise<{ pools: DiscoveredPool[]; complete: boolean }> {
    // Already unwrapped by the caller.
    const venues = await this.#venues();
    const found: DiscoveredPool[] = [];
    const failures: unknown[] = [];

    for (const [venueId, venue] of venues) {
      try {
        const pools = await venue.discoverPools(
          { tokenA: tokenIn.address, tokenB: tokenOut.address },
          new BrokerSession(),
        );
        found.push(...pools.map((pool) => ({ ...pool, venueId })));
      } catch (error) {
        // A broken venue costs the user that venue, not the swap.
        failures.push(error);
      }
    }

    // Nothing found and a venue failed: that is the failure, not "no market
    // for this pair". A busy or unreachable service fails every venue, and
    // saying there is no market would send the person looking for one.
    if (found.length === 0 && failures.length > 0) throw failures[0];
    return { pools: found, complete: failures.length === 0 };
  }

  async quote(request: QuoteRequest): Promise<QuoteResult> {
    const previewOnly = request.account === null;
    // A stand-in so the plan is still well-formed and the static checks still
    // mean something. Nothing is simulated against it.
    const account = request.account ?? PREVIEW_ACCOUNT;
    const recipient = (request.recipient ?? account).toLowerCase() as `0x${string}`;
    const guard = previewOnly ? this.#previewGuard : this.#guard;

    const built = await this.#buildLegs({
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      account,
      recipient,
      maxSplits: this.config.router.maxSplits,
      slippageBps: this.config.slippageBps,
    });

    const legs: LegPlan[] = [];
    for (const { leg, check } of built.legs) {
      const verdict = await guard.check({ ...check, nowSeconds: BigInt(Math.floor(Date.now() / 1000)) });
      legs.push({ ...leg, verdict });
    }

    return {
      route: built.route,
      // The full set, not the filtered one — see discoverPools.
      pools: built.discovered,
      legs,
      verdict: worstVerdict(legs.map((leg) => leg.verdict)),
      minAmountOut: built.minAmountOut,
      previewOnly,
      ...(built.note === undefined ? {} : { gasPricingNote: built.note }),
    };
  }

  /**
   * Quote one scheduled buy, fresh, and check it as one.
   *
   * Built by the same routing as a manual swap (`#buildLegs`), with the plan's
   * signer as the account and its owner as the recipient, then judged by the
   * `ScheduledBuyGuard`: the plan's envelope first — pair, size, budget,
   * window, delivery to the owner — and then every leg through the ordinary
   * Guard. The verdict is one decision about the whole buy, so every leg
   * carries it.
   *
   * **One market per buy.** Routed with `maxSplits = 1`, whatever the Router
   * setting says for manual swaps. A split buy is one transaction per leg, and
   * for a token sale one exact-amount permission per leg too, so every extra
   * leg is another wallet prompt and another network fee. With one market,
   * the costs the plan states are sized for one transaction per buy (two for
   * a token sale) rather than silently multiplied by a split. The price a
   * split might have saved on a buy this size is small next to that.
   *
   * **Slippage capped** at `MAX_SCHEDULED_SLIPPAGE_BPS`, whatever the setting:
   * a floor nobody watches is a floor a sandwich takes, every buy.
   */
  async quoteScheduled(input: ScheduledQuoteInput): Promise<QuoteResult> {
    const account = input.progress.signer.toLowerCase() as `0x${string}`;
    const recipient = input.progress.owner.toLowerCase() as `0x${string}`;
    const nowSeconds = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));

    const built = await this.#buildLegs({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      account,
      recipient,
      maxSplits: 1,
      // Capped: see MAX_SCHEDULED_SLIPPAGE_BPS.
      slippageBps: Math.min(this.config.slippageBps, MAX_SCHEDULED_SLIPPAGE_BPS),
      nowSeconds,
    });

    try {
      input.onCheck?.();
    } catch {
      // A status line that failed to update is not a reason to skip the check.
    }
    const verdict = await this.#scheduledGuard.check({
      plan: input.plan,
      progress: input.progress,
      slot: input.slot,
      legs: built.legs.map((l) => l.check),
      chainId: this.config.chainId,
      nowSeconds,
    });

    return {
      route: built.route,
      pools: built.discovered,
      legs: built.legs.map(({ leg }) => ({ ...leg, verdict })),
      verdict,
      minAmountOut: built.minAmountOut,
      previewOnly: false,
      ...(built.note === undefined ? {} : { gasPricingNote: built.note }),
    };
  }

  /**
   * Route a trade and have each leg built by its venue: everything a quote is
   * before the Guard sees it.
   *
   * Shared by `quote` and `quoteScheduled` so there is one copy of routing.
   * Returns, per leg, the leg as the UI shows it and exactly the input the
   * Guard will judge; the callers differ only in which Guard that is.
   */
  async #buildLegs(input: {
    tokenIn: TokenInfo;
    tokenOut: TokenInfo;
    amountIn: bigint;
    account: `0x${string}`;
    recipient: `0x${string}`;
    maxSplits: number;
    /** The floor under each leg's quoted output, in basis points. */
    slippageBps: number;
    /** The clock the deadline is set from; now, when omitted. */
    nowSeconds?: bigint;
  }): Promise<{
    route: RoutePlan;
    discovered: DiscoveredPool[];
    legs: { leg: Omit<LegPlan, "verdict">; check: GuardInput }[];
    minAmountOut: bigint;
    note?: string;
  }> {
    const venues = await this.#venues();
    const { amountIn, account, recipient } = input;

    /*
     * Two views of the same pair, and the distinction is load-bearing.
     *
     * `tokenIn`/`tokenOut` are what the *user* chose, and they are what the
     * intent says — because the intent is the promise the Guard judges, and it
     * has to describe what actually leaves and arrives. If the user sells
     * ether, the intent says ether, and the simulation had better show ether
     * moving.
     *
     * `tradedIn`/`tradedOut` are the ERC-20s the pools are denominated in.
     * Discovery, quoting and routing use those, because there is no native
     * pool to route through.
     */
    const tokenIn = input.tokenIn;
    const tokenOut = input.tokenOut;
    const tradedIn = tradedAs(tokenIn);
    const tradedOut = tradedAs(tokenOut);
    const nativeIn = isNative(tokenIn);
    const nativeOut = isNative(tokenOut);

    // ETH and WETH are the same asset, so this is a wrap rather than a swap —
    // and there is no pool that performs one. Caught here rather than in the
    // UI so it holds however the engine is driven, and named plainly because
    // "no pools available" would send someone looking for a liquidity problem
    // that does not exist.
    if (tradedIn.address === tradedOut.address) {
      throw new Error(
        `${tokenIn.symbol} and ${tokenOut.symbol} are the same asset — spDEX swaps, it does not wrap. ` +
          `Use your wallet or the WETH contract directly.`,
      );
    }

    // Two lists, on purpose. `routable` is what the router may use; `discovered`
    // is what the expert picker shows, and it has to include the pools the user
    // has excluded or they cannot be un-excluded.
    const discovered = await this.discoverPools(tokenIn, tokenOut);
    const pools = applyPoolPolicy(discovered, this.config);
    if (pools.length === 0) {
      throw new Error(
        discovered.length === 0
          ? "no pools found for this pair on any enabled venue"
          : "every pool for this pair is excluded by your current pool policy",
      );
    }

    // The router's grid and each venue's quote request must be the same set of
    // amounts, or every lookup misses and the route silently comes back empty.
    const grid = chunkGrid(amountIn, this.config.router.chunkCount);
    const requests = grid.map((amount) => ({
      tokenIn: tradedIn.address,
      tokenOut: tradedOut.address,
      amountIn: amount.toString(),
    }));

    // Quotes from every venue land in one candidate set, so the router compares
    // a v2 pair against a v3 pool on equal terms and can split across both.
    const candidates = [];
    const venueDataByPool = new Map<string, string | undefined>();
    const quoteFailures: unknown[] = [];

    for (const [venueId, venue] of venues) {
      const venuePools = pools.filter((pool) => pool.venueId === venueId);
      if (venuePools.length === 0) continue;

      let quotes;
      try {
        quotes = await venue.quoteBatch(requests, venuePools, new BrokerSession());
      } catch (error) {
        quoteFailures.push(error);
        continue; // one venue failing must not cost the user the others
      }

      for (const quote of quotes) venueDataByPool.set(quote.poolId.toLowerCase(), quote.venueData);

      candidates.push(
        ...candidatesFromQuotes(
          quotes,
          venuePools.map((pool) => ({
            poolId: pool.poolId,
            venueId,
            ...(pool.label === undefined ? {} : { label: pool.label }),
          })),
        ),
      );
    }

    // Every venue that was asked failed: say why, not "no route". A busy or
    // unreachable service fails them all, and "try a smaller amount" would
    // be advice about a problem that isn't there.
    if (candidates.length === 0 && quoteFailures.length > 0) throw quoteFailures[0];

    const { gas, note } = await this.#gasModel(tokenIn, candidates);

    const route = planRoute({
      amountIn,
      candidates,
      chunkCount: this.config.router.chunkCount,
      maxSplits: input.maxSplits,
      minSplitGainBps: this.config.router.minSplitGainBps,
      gas,
    });

    if (route.legs.length === 0) throw new Error("no executable route found");

    const minAmountOut =
      (route.amountOut * BigInt(10_000 - input.slippageBps)) / 10_000n;
    const nowSeconds = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
    const deadline = nowSeconds + BigInt(this.config.deadlineSeconds);

    const legs: { leg: Omit<LegPlan, "verdict">; check: GuardInput }[] = [];
    for (const leg of route.legs) {
      // Each leg's floor is its own share of the route's floor, so one leg
      // underperforming cannot be hidden by another overperforming.
      const legMinOut = (leg.amountOut * BigInt(10_000 - input.slippageBps)) / 10_000n;
      const venueData = venueDataByPool.get(leg.poolId.toLowerCase());

      const legQuote: WireVenueQuote = {
        poolId: leg.poolId,
        // The quote describes the pool, which is denominated in the wrapped
        // token whatever the user selected.
        tokenIn: tradedIn.address,
        tokenOut: tradedOut.address,
        amountIn: leg.amountIn.toString(),
        amountOut: leg.amountOut.toString(),
        gasEstimate: leg.gasEstimate.toString(),
        ...(venueData === undefined ? {} : { venueData }),
      };

      // Each leg is built by the venue that priced it.
      const legVenue = venues.get(leg.venueId);
      if (!legVenue) throw new Error(`no loaded venue for ${leg.venueId}`);
      const legManifest = this.#manifestFor(leg.venueId);

      const built = await legVenue.buildCalls(
        legQuote,
        {
          recipient,
          minAmountOut: legMinOut.toString(),
          deadline: deadline.toString(),
          // Which of the router's entry points to encode. A module that
          // ignores these builds the wrapped path and fails the Guard, which
          // is the right way round to be wrong.
          ...(nativeIn ? { nativeIn: true } : {}),
          ...(nativeOut ? { nativeOut: true } : {}),
        },
        new BrokerSession(),
      );

      // The host owns the intent. A module never authors the promise it is
      // going to be judged against.
      const plan: TxPlan = {
        version: 1,
        intent: {
          version: 1,
          chainId: this.config.chainId,
          account,
          recipient,
          // The user's choice, not the pool's denomination: this is the
          // promise the Guard checks against observed effects.
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          maxAmountIn: leg.amountIn,
          minAmountOut: legMinOut,
          deadline,
          nonce: randomNonce(),
        },
        approvals: built.approvals.map((a) => ({
          token: a.token as `0x${string}`,
          spender: a.spender as `0x${string}`,
          amount: BigInt(a.amount),
        })),
        calls: built.calls.map((c) => ({
          to: c.to as `0x${string}`,
          data: c.data as `0x${string}`,
          value: BigInt(c.value),
        })),
        meta: {
          venueId: leg.venueId,
          poolIds: built.poolIds,
          quotedAmountOut: BigInt(built.quotedAmountOut),
          gasEstimate: BigInt(built.gasEstimate),
        },
      };

      legs.push({
        leg: {
          poolId: leg.poolId,
          venueId: leg.venueId,
          ...(leg.label === undefined ? {} : { label: leg.label }),
          shareBps: leg.shareBps,
          amountIn: leg.amountIn,
          amountOut: leg.amountOut,
          plan,
        },
        check: {
          plan,
          expectedIntent: plan.intent,
          manifest: legManifest,
          extraTrustedContracts: this.config.extraTrustedContracts,
          // Replaced by each caller with the moment of its own check.
          nowSeconds,
        },
      });
    }

    return { route, discovered, legs, minAmountOut, ...(note === undefined ? {} : { note }) };
  }

  /**
   * Price gas in tokenOut, or admit that it cannot be done.
   *
   * Comparing "more output" against "more gas" needs both in one unit. When the
   * input token is the native asset the route itself supplies the rate. When it
   * is not, there is no honest rate available without an oracle, so gas is
   * ignored and the UI says so — rather than inventing a number that quietly
   * changes which route is chosen.
   */
  async #gasModel(
    tokenIn: TokenInfo,
    candidates: ReturnType<typeof candidatesFromQuotes>,
  ): Promise<{ gas: GasModel; note?: string }> {
    // Compared by address, not by symbol. A user-supplied token list is a
    // planned module, and once one lands, "WETH" is a string anybody can put
    // next to any contract — at which point a symbol check would happily price
    // gas off an impostor's quote.
    const isNativeIn = tradedAs(tokenIn).address.toLowerCase() === TOKENS.WETH.address;

    if (!isNativeIn) {
      return {
        gas: IGNORE_GAS,
        note: `Gas is not priced into this route: ${tokenIn.symbol} has no native-asset rate available without an oracle.`,
      };
    }

    const deepest = candidates
      .flatMap((c) => c.quotes)
      .reduce<{ amountIn: bigint; amountOut: bigint } | null>(
        (best, q) => (best === null || q.amountIn > best.amountIn ? q : best),
        null,
      );
    if (!deepest || deepest.amountIn === 0n) {
      return { gas: IGNORE_GAS, note: "Gas is not priced into this route: no quote to derive a rate from." };
    }

    let gasPriceWei = 0n;
    try {
      gasPriceWei = BigInt((await this.#rpc("eth_gasPrice", [])) as string);
    } catch {
      return { gas: IGNORE_GAS, note: "Gas is not priced into this route: the RPC did not report a gas price." };
    }

    // tokenOut per 1e18 wei, which is exactly what linearGasModel wants. Safe
    // because the branch above established tokenIn is WETH, so the quote's
    // input side is already denominated in the native asset.
    const tokenOutPerNative = (deepest.amountOut * 10n ** 18n) / deepest.amountIn;
    return { gas: linearGasModel({ gasPriceWei, tokenOutPerNative }) };
  }
}

/** Stands in for the signer while quoting without a wallet. */
const PREVIEW_ACCOUNT = "0x0000000000000000000000000000000000000000" as const;

/** Host-generated: modules have no randomness, and must not choose this. */
function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** `rejected` beats `unverified` beats `verified`. */
function worstVerdict(verdicts: GuardVerdict[]): GuardVerdict {
  const rejected = verdicts.find((v) => v.level === "rejected");
  if (rejected) return rejected;
  const unverified = verdicts.find((v) => v.level === "unverified");
  if (unverified) return unverified;
  return verdicts[0] ?? { level: "rejected", signable: false, violations: [], warnings: [] };
}

/**
 * Apply the user's pool policy.
 *
 * Denials are absolute and applied in both modes: a pool the user has excluded
 * must never come back because a preset thought otherwise.
 */
export function applyPoolPolicy<T extends WirePoolRef>(pools: T[], config: SpdexConfig): T[] {
  const denied = new Set(config.pools.deny.map((p) => p.poolId.toLowerCase()));
  const allowed = new Set(config.pools.allow.map((p) => p.poolId.toLowerCase()));

  return pools.filter((pool) => {
    const id = pool.poolId.toLowerCase();
    if (denied.has(id)) return false;
    if (config.pools.mode === "allowlist") return allowed.has(id);
    return true;
  });
}

/**
 * The second opinion a config asks for, as the Engine holds it: none; the
 * main service again, which isn't a second opinion and isn't used (a config
 * link can set this, the setting can't); or a pair of services the Guards
 * compare, with the second's host name for sentences.
 */
function secondOpinionOf(config: SpdexConfig, primaryRpc: JsonRpc): {
  pair: SecondOpinionPair | null;
  monitor: SecondOpinionMonitor;
  rates: null;
} {
  const url = config.guard.secondOpinion?.url ?? null;
  if (url === null) return { pair: null, monitor: new SecondOpinionMonitor({ kind: "off" }), rates: null };
  if (sameService(url, config.rpc.url)) return { pair: null, monitor: new SecondOpinionMonitor({ kind: "same" }), rates: null };
  const host = secondOpinionHost(url.trim());
  const pair = new SecondOpinionPair({ primaryRpc, secondRpc: httpRpc(url), host });
  const status: SecondOpinionStatus = {
    kind: "on",
    host,
    last: null,
    sameOperator: config.rpc.url === null ? null : sharedOperator(url, config.rpc.url),
  };
  return { pair, monitor: new SecondOpinionMonitor(status), rates: null };
}

// ── Testing a second opinion before it is saved ──────────────────────────────

/** How `testSecondOpinion` went: usable (perhaps with a warning), or why not. */
export type SecondOpinionTest = { ok: true; warning: string | null } | { ok: false; error: string };

/** The account the test's 1-wei transfer is made from, funded by a state override: nobody's real money. */
const TEST_FROM = "0x5d0e000000000000000000000000000000005d0e" as Address;
const TEST_TO = "0x5d0e00000000000000000000000000000000beef" as Address;

/**
 * Whether `url` can serve as a second opinion to the main service at
 * `mainUrl`, asked before it is saved (the Test button).
 *
 * It must be another service, on the configured chain, and its test-runs must
 * match the main service's: one fixed call, a 1-wei ether transfer from an
 * account funded by a state override, is test-run on both at a block both
 * vouch for, exactly as every check will be, and the results must be the
 * same, the ether-transfer record included. A client that leaves those
 * records out, or fills in overrides differently, would disagree about every
 * swap that moves ether, and so would refuse them all.
 *
 * Every request goes to the main service in use or the second one the person
 * typed.
 */
export async function testSecondOpinion(input: { mainUrl: string | null; url: string; chainId: number }): Promise<SecondOpinionTest> {
  const { mainUrl, url, chainId } = input;
  if (mainUrl === null) return { ok: false, error: "Choose your main network service first." };
  if (normalizeServiceUrl(url) === null) return { ok: false, error: "That isn't a web address spDEX can use: it has to start with https:// or http://." };
  if (sameService(url, mainUrl)) return { ok: false, error: "That's your main service. A second opinion has to come from somewhere else." };

  const second = httpRpc(url);
  let chain: number;
  try {
    const answer = quantity(await withTimeout(second)("eth_chainId", []));
    if (answer === null) throw new Error("not a chain id");
    chain = Number(answer);
  } catch {
    return { ok: false, error: "That service didn't answer, so it can't be checked. Check the address and try again." };
  }
  if (chain !== chainId) return { ok: false, error: `That service is on chain ${chain}, not ${chainId}.` };

  const main = httpRpc(mainUrl);
  const pair = new SecondOpinionPair({ primaryRpc: main, secondRpc: second, host: secondOpinionHost(url.trim()) });
  let outcome;
  try {
    outcome = await pair.provider(new EthSimulateV1Provider(main)).simulate({
      chainId,
      account: TEST_FROM,
      calls: [{ to: TEST_TO, data: "0x", value: 1n }],
      stateOverrides: { [TEST_FROM]: { balance: 10n ** 18n } },
    });
  } catch {
    return { ok: false, error: "Your main service couldn't run the test, so there's nothing to compare with. Try again in a moment." };
  }

  const opinion = outcome.secondOpinion;
  // The main service failed before the two could be compared on one block.
  // The provider then still asks the second (so its answer can refuse), but
  // an outcome without a pinned comparison says nothing about whether the
  // two match, so it can't pass this test, whoever's run came back.
  if (outcome.uncompared !== undefined && opinion?.kind !== "disagrees" && opinion?.kind !== "unavailable") {
    return { ok: false, error: "Your main service couldn't run the test, so there's nothing to compare with. Try again in a moment." };
  }
  if (opinion === undefined) return { ok: false, error: "The test didn't reach that service. Try again in a moment." };
  if (opinion.kind === "unavailable") return { ok: false, error: `That service can't be used: ${opinion.reason}.` };
  if (opinion.kind === "disagrees") {
    if (opinion.reason === "heads") {
      return {
        ok: false,
        error: "That service's latest block is more than 1 from your main one's, even after a moment to catch up, so their test-runs can't be compared. Try again in a moment.",
      };
    }
    if (opinion.reason === "block-hash") {
      return { ok: false, error: "That service reports a different block at the same height as your main one. Try again in a moment." };
    }
    return { ok: false, error: "That service's test-runs don't match your main service's, so it can't be a second opinion." };
  }
  // They agree; and what they agree on must include the ether moving, or two
  // clients that both leave it out would agree about nothing that matters.
  const recorded = outcome.logs.some(
    (log) =>
      log.address.toLowerCase() === NATIVE_TOKEN.toLowerCase() &&
      log.topics[0]?.toLowerCase() === TOPICS.transfer &&
      log.topics[2]?.toLowerCase().endsWith(TEST_TO.slice(2)) &&
      BigInt(log.data === "0x" ? 0 : log.data) === 1n,
  );
  if (!recorded) {
    return { ok: false, error: "That service's test-runs don't match your main service's, so it can't be a second opinion." };
  }
  const operator = sharedOperator(url, mainUrl);
  return { ok: true, warning: operator === null ? null : sameOperatorWarning(operator) };
}
