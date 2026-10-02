/**
 * One interface, two runtimes.
 *
 * `native` runs a module in-process: full speed, ordinary debugging, ordinary
 * npm dependencies. `quickjs` runs it in a capability-zero VM. The choice is
 * about *cost*, never about trust — both receive their context from the same
 * broker, and every plan either produces passes through the same Guard.
 *
 * Three mechanisms keep the fast path honest, because a trusted fast path that
 * nobody exercises is how a module interface silently rots:
 *
 *   1. The parity gate runs fixtures of every loadable kind through both
 *      runtimes, and each first-party module compares the two in its own tests.
 *   2. `strictSandbox` forces everything through the VM, so a user can check
 *      the fast path was never load-bearing.
 *   3. The native runtime is granted no capability the sandbox lacks.
 */

import type {
  WireBuildParams,
  WireBuildResult,
  WirePoolRef,
  WireQuoteRequest,
  WirePoolStats,
  WireScheduleDecision,
  WireScheduleRequest,
  WireTipCandidate,
  WireTokenPair,
  WireVenueQuote,
} from "@spdex/core";
import type { BrokerSession, CapabilityBroker } from "../broker.js";

export type RuntimeKind = "native" | "quickjs";

/**
 * How a module's code reaches a runtime.
 *
 * `object` is a module already resolved in-process — how first-party modules
 * ship, with no eval and a CSP that needs no `unsafe-eval`.
 * `code` is self-contained source, which is how anything untrusted arrives.
 */
export type ModuleSource =
  | { kind: "object"; module: unknown }
  | { kind: "code"; code: string };

export interface LoadedModule {
  readonly kind: RuntimeKind;
  readonly apiVersion: string;
  discoverPools(pair: WireTokenPair, session: BrokerSession): Promise<WirePoolRef[]>;
  quoteBatch(
    requests: WireQuoteRequest[],
    pools: WirePoolRef[],
    session: BrokerSession,
  ): Promise<WireVenueQuote[]>;
  buildCalls(
    quote: WireVenueQuote,
    params: WireBuildParams,
    session: BrokerSession,
  ): Promise<WireBuildResult>;
  dispose(): void;
}

/**
 * A module that answers "who can I tip?".
 *
 * A separate interface rather than optional methods on `LoadedModule`, because
 * the two kinds have nothing in common beyond being sandboxed code: a venue
 * with a dormant `listRecipients` that throws is a worse description of reality
 * than two interfaces, and it would let a caller ask a registry to quote.
 *
 * Adding this was the first real test of whether the module boundary was
 * general or merely venue-shaped. The answer was mostly the latter —
 * `LoadedModule` hardcoded the three venue methods, so `MODULE_KINDS` could
 * name `tokenlist` and `oracle` while no runtime could load either. The
 * sandbox itself turned out to be kind-agnostic already; only the host's typed
 * view of it needed widening.
 */
export interface LoadedRegistry {
  readonly kind: RuntimeKind;
  readonly apiVersion: string;
  listRecipients(session: BrokerSession): Promise<WireTipCandidate[]>;
  dispose(): void;
}

/**
 * A module that reports on pools rather than quoting them.
 *
 * The third kind, and the point at which three near-identical load paths
 * started asking to be one. See `KindViews` for what happened at the fourth.
 */
export interface LoadedTracker {
  readonly kind: RuntimeKind;
  readonly apiVersion: string;
  scanPools(pools: WirePoolRef[], session: BrokerSession): Promise<WirePoolStats[]>;
  dispose(): void;
}

/**
 * A module that says which recurring buys are due, and how large each is.
 *
 * It is handed the plans, a summary of what has been bought, and the time — a
 * module has no clock — and it proposes. The host vets the answer against the
 * plans (`vetScheduleDecision`) and the Guard checks every resulting buy again
 * when it is signed, so a scheduler that lies can make the app skip a buy or
 * buy less, never spend more, more often, or anywhere else.
 */
export interface LoadedScheduler {
  readonly kind: RuntimeKind;
  readonly apiVersion: string;
  dueBuys(request: WireScheduleRequest, session: BrokerSession): Promise<WireScheduleDecision>;
  dispose(): void;
}

/**
 * Every kind a runtime can load, and the view each one gets.
 *
 * The fourth kind is where the load path stopped being one hand-written method
 * per kind on each runtime and became a table (`KIND_SPECS` in kinds.ts): a
 * kind is a row naming its interface, its methods, and the schema each
 * method's output is parsed with, and both runtimes build their views from
 * that one row. What the separate methods were protecting survives the change —
 * each view is still precisely typed and carries only its own kind's methods,
 * so nothing can ask a tracker to quote or a scheduler to scan.
 *
 * The key is the manifest's module kind, which is why `tiplist` maps to a view
 * called `LoadedRegistry`: the kind names what the module is for, the view
 * names what the host can ask of it.
 */
export interface KindViews {
  venue: LoadedModule;
  tiplist: LoadedRegistry;
  tracker: LoadedTracker;
  scheduler: LoadedScheduler;
}
export type LoadableKind = keyof KindViews;

export interface ModuleRuntime {
  readonly kind: RuntimeKind;
  load(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedModule>;
  /**
   * Same validation, same broker, same sandbox — a different expected shape.
   * Kept as a separate entry point so a caller must say which kind it wants
   * rather than discovering it from whatever the module happened to define.
   */
  loadRegistry(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedRegistry>;
  loadTracker(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedTracker>;
  /**
   * The one load path the three above delegate to.
   *
   * The caller still names the kind it wants, for the same reason the separate
   * entry points existed. `moduleKind` is the manifest's kind, and is named so
   * because `kind` already means the runtime on every view and the source's
   * form on `ModuleSource`.
   *
   * A runtime checks only that the module has the named kind's shape; it does
   * not read `broker.manifest.kind`. Whether a module *may* be loaded as that
   * kind is decided at the seam that picks it, with `assertLoadable`.
   */
  loadKind<K extends LoadableKind>(
    moduleKind: K,
    source: ModuleSource,
    broker: CapabilityBroker,
  ): Promise<KindViews[K]>;
}

export class ModuleLoadError extends Error {
  constructor(message: string, readonly moduleId: string) {
    super(message);
    this.name = "ModuleLoadError";
  }
}

export class ModuleExecutionError extends Error {
  constructor(
    message: string,
    readonly moduleId: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "ModuleExecutionError";
  }
}
