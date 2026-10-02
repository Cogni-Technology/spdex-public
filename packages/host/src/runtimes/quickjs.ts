/**
 * QuickJS runtime — the jail untrusted modules run in.
 *
 * ## Why QuickJS rather than a Web Worker
 *
 * A Worker still has `fetch`, `WebSocket` and `importScripts`; removing them
 * means deleting globals in a prelude, which is a denylist — and denylists leak.
 * QuickJS starts with no host bindings whatsoever and you inject only what you
 * choose, so reach is an allowlist by construction. Verified empirically: inside
 * the VM, `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `process`,
 * `require`, `window` and `localStorage` are all `undefined`. It also keeps the
 * page's CSP free of `unsafe-eval` — WASM needs only `wasm-unsafe-eval`.
 *
 * ## Why the sandbox is synchronous, and the host drives I/O
 *
 * The obvious design gives the module an async `ctx.multicall` backed by an
 * asyncified host function, so it can await chain reads directly. That was the
 * first implementation, and it is not safe: quickjs-emscripten's asyncify
 * tolerates exactly one suspension per evaluation. A second one returns
 * **silently corrupted data** — a probe expecting "okok" received "ÈaQ" — and a
 * third traps the WASM. Any real venue adapter reads at least twice (find the
 * pools, then price them), so that ceiling is not one we can live under, and
 * silent corruption is the worst possible failure mode for a component whose
 * entire job is to be trustworthy.
 *
 * So nothing suspends. `ctx.multicall` is synchronous: it replays results the
 * host has already fetched, and when it runs out it throws a sentinel that
 * unwinds the module. The host then performs the reads it asked for and runs
 * the module again from the top with a longer cache. Repeat until it returns.
 *
 * Three things fall out of that, all good:
 *
 *   - No asyncify, so the smaller and faster synchronous WASM build is enough.
 *   - Determinism stops being a rule module authors must follow and becomes
 *     structural: a module that issued different reads on replay would never
 *     converge, and `maxRounds` catches it immediately.
 *   - Module source does not change. Authors still write `await ctx.multicall(…)`
 *     — awaiting a plain value is legal — so the same file runs unmodified in
 *     the native runtime, where the context really is async. That is what keeps
 *     the parity gate meaningful.
 *
 * The cost is that a module's own logic re-executes once per round. For the two
 * rounds a venue adapter needs, that is microseconds against a network call.
 *
 * ## Containment
 *
 * Runaway modules are bounded four ways, each verified against real hostile
 * code: an interrupt-driven fuel budget (infinite loop -> `interrupted`), a
 * memory ceiling (allocation bomb -> `out of memory`), a stack ceiling
 * (unbounded recursion -> `stack overflow`), and a cap on host round-trips so a
 * module cannot loop the host forever by asking for one more read each time.
 */

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSContext, QuickJSWASMModule, QuickJSHandle } from "quickjs-emscripten-core";
// Pinned to the one variant that is actually used.
//
// The umbrella `quickjs-emscripten` package re-exports every build — sync and
// asyncify, debug and release — and a bundler cannot tell which will be needed
// at runtime, so all four .wasm files end up in the output. That was 4.2MB for
// a bundle meant to be pinned to IPFS and audited by hand. Importing the single
// release-sync variant directly brings it to one 503KB file (236KB brotli).
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import { isApiVersionCompatible, HOST_API_VERSION, type WireChainCall } from "@spdex/core";
import { BrokerSession } from "../broker.js";
import type { CapabilityBroker } from "../broker.js";
import { bindView, isKindMethod, specFor } from "./kinds.js";
import {
  ModuleExecutionError,
  ModuleLoadError,
  type KindViews,
  type LoadableKind,
  type LoadedModule,
  type LoadedRegistry,
  type LoadedTracker,
  type ModuleRuntime,
  type ModuleSource,
} from "./types.js";

/**
 * Ceiling on host round-trips for one module call.
 *
 * A venue adapter needs two. Anything approaching this is a module that is
 * either non-deterministic (so its replayed reads never line up) or trying to
 * grind the host.
 */
const DEFAULT_MAX_ROUNDS = 8;

/** Runs before module code, in every fresh context. */
const BOOTSTRAP = `
  // Determinism: identical inputs must produce byte-identical output, and both
  // the conformance suite and the replay loop below depend on it. A module
  // reaching for these is a bug in the module, so they are removed outright.
  delete globalThis.Date;
  delete globalThis.performance;
  Math.random = undefined;

  globalThis.__spdex_logs = [];
  globalThis.__spdex_cache = [];
  globalThis.__spdex_cursor = 0;
  globalThis.__spdex_need = null;
  globalThis.__spdex_status = "pending";
  globalThis.__spdex_result = null;

  // Thrown to unwind the module when it asks for data the host has not fetched
  // yet. Identified by a marker property rather than by identity, because the
  // module may catch and rethrow across frames.
  var __SPDEX_SUSPEND = { __spdex_suspend: true };

  globalThis.__spdex_ctx = {
    multicall: function (calls) {
      // Replay: the host already has this round's answer.
      if (globalThis.__spdex_cursor < globalThis.__spdex_cache.length) {
        return globalThis.__spdex_cache[globalThis.__spdex_cursor++];
      }
      // Miss: record what is needed and unwind. The host will fetch it and run
      // this module again from the top with a longer cache.
      globalThis.__spdex_need = calls;
      throw __SPDEX_SUSPEND;
    },
    call: function (call) {
      return globalThis.__spdex_ctx.multicall([call])[0];
    },
    log: function (message) {
      // Bounded: a module must not be able to exhaust memory through logging.
      if (globalThis.__spdex_logs.length < 200) {
        globalThis.__spdex_logs.push(String(message).slice(0, 1000));
      }
    },
  };
  Object.freeze(globalThis.__spdex_ctx);
`;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
/** Lazily loaded so users who enable no sandboxed modules never fetch the WASM. */
function getQuickJS(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return modulePromise;
}

interface QuickJSRuntimeOptions {
  maxRounds?: number;
}

function readErrorMessage(vm: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const messageHandle = vm.getProp(handle, "message");
    const message = vm.getString(messageHandle);
    messageHandle.dispose();
    return message || "module threw";
  } catch {
    return "module threw a non-Error value";
  }
}

function readGlobalString(vm: QuickJSContext, name: string): string | null {
  const handle = vm.getProp(vm.global, name);
  const value = vm.typeof(handle) === "string" ? vm.getString(handle) : null;
  handle.dispose();
  return value;
}

/**
 * A sandboxed module, executed in a fresh VM per invocation.
 *
 * Fresh rather than reused so a module cannot carry state between calls even
 * if it tries — determinism becomes a property of the architecture rather than
 * of any one module's good behaviour. Measured at ~1.4ms to create a context,
 * bootstrap it and evaluate module source, against 50-300ms for the RPC
 * round-trip that follows.
 *
 * This class knows nothing about kinds: it evaluates code and calls a named
 * method. What a caller may ask of it is decided by the view `bindView` builds
 * around `invoke`, from the kind's row in `KIND_SPECS` — so a module loaded as
 * a registry cannot be asked to quote, at runtime as well as in the types.
 * (It used to carry every kind's methods, and only the type said otherwise.)
 */
class QuickJSModule {
  constructor(
    private readonly quickjs: QuickJSWASMModule,
    private readonly code: string,
    readonly apiVersion: string,
    private readonly broker: CapabilityBroker,
    private readonly options: QuickJSRuntimeOptions = {},
  ) {}

  /**
   * Run one module method to completion, driving its chain reads from the host.
   *
   * Each round evaluates the module from scratch against the results gathered
   * so far. The VM never suspends, so there is no asyncify state to corrupt.
   */
  async invoke(method: string, args: readonly unknown[], session: BrokerSession): Promise<unknown> {
    // The name is about to be spliced into code the VM evaluates, so it must
    // be one of the table's. Every caller passes one today; this makes that a
    // property of the runtime rather than of every caller, now and later.
    if (!isKindMethod(method)) {
      throw new ModuleExecutionError(
        `${JSON.stringify(method)} is not a method of any module kind`,
        this.broker.manifest.id,
        method,
      );
    }

    const maxRounds = this.options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const { limits } = this.broker.manifest;
    const moduleId = this.broker.manifest.id;
    const fail = (message: string) => new ModuleExecutionError(message, moduleId, method);

    /** Results of every host round so far, replayed to the module in order. */
    const cache: string[][] = [];

    for (let round = 0; round <= maxRounds; round++) {
      const vm = await this.quickjs.newContext();
      let fuelUsed = 0;

      try {
        vm.runtime.setMemoryLimit(Number(limits.maxMemory));
        vm.runtime.setMaxStackSize(512 * 1024);
        vm.runtime.setInterruptHandler(() => ++fuelUsed > Number(limits.maxFuel));

        vm.unwrapResult(vm.evalCode(BOOTSTRAP)).dispose();

        const loaded = vm.evalCode(this.code);
        if (loaded.error) {
          const message = readErrorMessage(vm, loaded.error);
          loaded.error.dispose();
          throw fail(message);
        }
        loaded.value.dispose();

        // Everything the module sees is embedded as a JSON literal: one
        // crossing, no handle lifetimes to leak, and no way for the module to
        // retain a reference to anything host-side.
        const driver = `
          globalThis.__spdex_cache = ${JSON.stringify(cache)};
          globalThis.__spdex_cursor = 0;
          globalThis.__spdex_need = null;
          globalThis.__spdex_status = "pending";
          globalThis.__spdex_result = null;
          (async function () {
            try {
              var m = globalThis.spdexModule;
              if (!m || typeof m.${method} !== "function") {
                throw new Error("module does not implement ${method}");
              }
              var args = ${JSON.stringify(args)};
              var out = await m.${method}.apply(m, args.concat([globalThis.__spdex_ctx]));
              globalThis.__spdex_result = JSON.stringify(out === undefined ? null : out);
              globalThis.__spdex_status = "done";
            } catch (err) {
              if (err && err.__spdex_suspend) {
                globalThis.__spdex_status = "suspend";
              } else {
                globalThis.__spdex_result = String((err && err.message) || err);
                globalThis.__spdex_status = "error";
              }
            }
          })();
        `;

        const evaluated = vm.evalCode(driver);
        if (evaluated.error) {
          const message = readErrorMessage(vm, evaluated.error);
          evaluated.error.dispose();
          throw fail(message);
        }
        evaluated.value.dispose();

        // The module body is an async function, so it settles on the microtask
        // queue. Draining is synchronous — nothing suspends.
        while (vm.runtime.hasPendingJob()) {
          const jobs = vm.runtime.executePendingJobs();
          if (jobs.error) {
            const message = readErrorMessage(vm, jobs.error);
            jobs.error.dispose();
            throw fail(message);
          }
        }

        this.#drainLogs(vm, session);

        const status = readGlobalString(vm, "__spdex_status");

        if (status === "done") {
          const json = readGlobalString(vm, "__spdex_result");
          if (json === null) throw fail("module produced no result");
          return JSON.parse(json);
        }

        if (status === "error") {
          throw fail(readGlobalString(vm, "__spdex_result") ?? "module threw");
        }

        if (status !== "suspend") {
          // "pending" means the module returned a promise that never settles
          // without external input — which, with no host suspension available,
          // it cannot obtain.
          throw fail("module did not settle");
        }

        // Suspended: fetch what it asked for, then replay with a longer cache.
        const needHandle = vm.getProp(vm.global, "__spdex_need");
        const need = vm.dump(needHandle) as WireChainCall[] | null;
        needHandle.dispose();
        if (!Array.isArray(need)) throw fail("module suspended without requesting reads");

        const ctx = this.broker.createContext(session);
        cache.push(await ctx.multicall(need));
      } finally {
        // Detach before disposal: tearing down a context that still has an
        // interrupt handler installed trips an assertion in the WASM.
        vm.runtime.removeInterruptHandler();
        vm.dispose();
      }
    }

    throw fail(
      `module exceeded ${maxRounds} host round-trips — it is either non-deterministic ` +
        `(so replayed reads never line up) or looping`,
    );
  }

  /** Move buffered module logs to the broker before the VM is discarded. */
  #drainLogs(vm: QuickJSContext, session: BrokerSession): void {
    try {
      const handle = vm.getProp(vm.global, "__spdex_logs");
      const lines = vm.dump(handle) as unknown;
      handle.dispose();
      if (Array.isArray(lines) && lines.length > 0) {
        const ctx = this.broker.createContext(session);
        for (const line of lines) ctx.log(String(line));
      }
    } catch {
      // Logging must never be able to fail a quote.
    }
  }

  // No dispose: each invocation disposes its own VM, so nothing outlives a
  // call. Refusing calls after the view is disposed is `bindView`'s job, the
  // same for both runtimes.
}

export class QuickJSRuntime implements ModuleRuntime {
  readonly kind = "quickjs" as const;

  constructor(private readonly options: QuickJSRuntimeOptions = {}) {}

  async load(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedModule> {
    return this.loadKind("venue", source, broker);
  }

  async loadRegistry(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedRegistry> {
    return this.loadKind("tiplist", source, broker);
  }

  async loadTracker(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedTracker> {
    return this.loadKind("tracker", source, broker);
  }

  /**
   * Validate the module once, then keep only its source.
   *
   * The sandbox has no notion of kind; the kind's required methods are what
   * distinguish one load from another. A module that does not define
   * `listRecipients` fails here rather than at the first call, which is the
   * difference between a load error naming the problem and a runtime error
   * deep inside an invocation.
   */
  async loadKind<K extends LoadableKind>(
    moduleKind: K,
    source: ModuleSource,
    broker: CapabilityBroker,
  ): Promise<KindViews[K]> {
    const id = broker.manifest.id;
    const spec = specFor(moduleKind, id);
    const sandboxed = await this.#validate(source, broker, spec.methods);
    return bindView(moduleKind, {
      runtime: "quickjs",
      apiVersion: sandboxed.apiVersion,
      moduleId: id,
      invoke: (method, args, session) => sandboxed.invoke(method, args, session),
    });
  }

  /**
   * Loading proves the code evaluates, assigns `globalThis.spdexModule`,
   * defines the required methods, and declares the API version its manifest
   * claims. The VM used for that check is discarded — every
   * invocation builds its own.
   */
  async #validate(
    source: ModuleSource,
    broker: CapabilityBroker,
    requiredMethods: readonly string[],
  ): Promise<QuickJSModule> {
    const id = broker.manifest.id;
    if (source.kind !== "code") {
      throw new ModuleLoadError("quickjs runtime requires module source code", id);
    }

    const quickjs = await getQuickJS();
    const { limits } = broker.manifest;
    const vm = await quickjs.newContext();

    try {
      vm.runtime.setMemoryLimit(Number(limits.maxMemory));
      vm.runtime.setMaxStackSize(512 * 1024);
      // A module that loops forever at load must not hang the host before it
      // has done anything.
      let fuelUsed = 0;
      vm.runtime.setInterruptHandler(() => ++fuelUsed > Number(limits.maxFuel));

      const bootstrapped = vm.evalCode(BOOTSTRAP);
      if (bootstrapped.error) {
        bootstrapped.error.dispose();
        throw new ModuleLoadError("sandbox bootstrap failed", id);
      }
      bootstrapped.value.dispose();

      const evaluated = vm.evalCode(source.code);
      if (evaluated.error) {
        const message = readErrorMessage(vm, evaluated.error);
        evaluated.error.dispose();
        throw new ModuleLoadError(message, id);
      }
      evaluated.value.dispose();

      const declared = vm.getProp(vm.global, "spdexModule");
      if (vm.typeof(declared) !== "object") {
        declared.dispose();
        throw new ModuleLoadError("module did not assign globalThis.spdexModule", id);
      }
      const versionHandle = vm.getProp(declared, "apiVersion");
      const apiVersion = vm.typeof(versionHandle) === "string" ? vm.getString(versionHandle) : "";
      versionHandle.dispose();

      // Checked at load, not at first call. A module missing a method it was
      // loaded as is a packaging mistake, and naming it here beats a failure
      // several seconds later inside a quote the user is waiting on.
      const missing: string[] = [];
      for (const method of requiredMethods) {
        const handle = vm.getProp(declared, method);
        if (vm.typeof(handle) !== "function") missing.push(method);
        handle.dispose();
      }
      declared.dispose();

      if (missing.length > 0) {
        throw new ModuleLoadError(`module does not implement ${missing.join(", ")}`, id);
      }

      if (!isApiVersionCompatible(apiVersion, HOST_API_VERSION)) {
        throw new ModuleLoadError(
          `module targets host API ${apiVersion || "<none>"}, this host provides ${HOST_API_VERSION}`,
          id,
        );
      }
      if (apiVersion !== broker.manifest.apiVersion) {
        throw new ModuleLoadError(
          `module reports API ${apiVersion} but its manifest declares ${broker.manifest.apiVersion}`,
          id,
        );
      }

      return new QuickJSModule(quickjs, source.code, apiVersion, broker, this.options);
    } finally {
      vm.runtime.removeInterruptHandler();
      vm.dispose();
    }
  }
}

export { BrokerSession };
