/**
 * Native runtime — in-process execution for modules whose code already ships
 * with the app.
 *
 * The important detail is what it does *not* do: it grants no capability the
 * sandbox lacks, and it validates the module's output exactly as strictly. Its
 * only advantage is skipping the VM.
 *
 * It also marshals through the same wire encoding as QuickJS. That looks like
 * pointless ceremony — the values are right there — but it is the reason the
 * parity gate proves anything. If native passed rich JS values while the sandbox
 * round-tripped JSON, the two runtimes would be executing meaningfully different
 * code and identical output would be a coincidence rather than a guarantee.
 */

import { isApiVersionCompatible, HOST_API_VERSION } from "@spdex/core";
import type { CapabilityBroker } from "../broker.js";
import { bindView, specFor, type Invoke } from "./kinds.js";
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

/** Round-trip through JSON so native sees precisely what the sandbox would. */
function throughWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type ModuleMethod = (...args: unknown[]) => unknown;

/** A resolved module object declaring an API version and defining every named method. */
function hasMethods(
  value: unknown,
  methods: readonly string[],
): value is { readonly apiVersion: string; readonly [member: string]: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m["apiVersion"] === "string" && methods.every((name) => typeof m[name] === "function");
}

export class NativeRuntime implements ModuleRuntime {
  readonly kind = "native" as const;

  async load(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedModule> {
    return this.loadKind("venue", source, broker);
  }

  async loadRegistry(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedRegistry> {
    return this.loadKind("tiplist", source, broker);
  }

  async loadTracker(source: ModuleSource, broker: CapabilityBroker): Promise<LoadedTracker> {
    return this.loadKind("tracker", source, broker);
  }

  async loadKind<K extends LoadableKind>(
    moduleKind: K,
    source: ModuleSource,
    broker: CapabilityBroker,
  ): Promise<KindViews[K]> {
    const id = broker.manifest.id;
    const spec = specFor(moduleKind, id);

    if (source.kind !== "object") {
      // Evaluating source in-process would need `unsafe-eval` and would hand
      // untrusted code the host's own scope — the exact thing the sandbox exists
      // to prevent. Untrusted code goes to QuickJS.
      throw new ModuleLoadError(
        "native runtime loads resolved modules only; source code must run in the sandbox",
        id,
      );
    }

    const module = source.module;
    if (!hasMethods(module, spec.methods)) {
      throw new ModuleLoadError(`module does not implement the ${spec.interfaceName} interface`, id);
    }

    const apiVersion = module.apiVersion;
    assertApiVersion(apiVersion, broker, id);

    // Resolved once, here, so the functions that passed the shape check are the
    // functions that get called — and only the kind's own methods are reachable
    // through the view, as in the sandbox, which evaluates the module afresh
    // for every call and so can never see one swapped in after load.
    const methods = new Map<string, ModuleMethod>(
      spec.methods.map((name) => [name, module[name] as ModuleMethod]),
    );

    const invoke: Invoke = async (method, args, session) => {
      const fn = methods.get(method);
      if (fn === undefined) {
        throw new ModuleExecutionError(`module does not implement ${method}`, id, method);
      }
      // The host's own values, marshalled outside the module's frame: a value
      // that cannot cross the wire is a host bug, and must not be reported as
      // the module's fault. The sandbox fails the same way, host-side.
      const input = args.map((arg) => throughWire(arg));
      const ctx = broker.createContext(session);
      try {
        const raw = await fn.apply(module, [...input, ctx]);
        // Serialising the answer is part of the module's call, as it is in the
        // sandbox — where `JSON.stringify` runs inside the VM, so a bigint, a
        // cycle or a throwing `toJSON` fails the call — and `undefined`
        // becomes `null`, as the sandbox's driver makes it. Without both, the
        // same bad answer failed differently depending on which runtime ran it.
        return throughWire(raw === undefined ? null : raw);
      } catch (error) {
        // Module exceptions become ModuleExecutionError; the host never sees raw throws.
        throw new ModuleExecutionError(error instanceof Error ? error.message : String(error), id, method);
      }
    };

    return bindView(moduleKind, { runtime: "native", apiVersion, moduleId: id, invoke });
  }
}

/**
 * The version handshake, shared by both load paths.
 *
 * Two checks that look like one. The first is compatibility — can this host run
 * this module at all. The second is that the code agrees with the *signed*
 * manifest about which API it targets, which catches a module swapped underneath
 * a manifest that vouches for something else.
 */
function assertApiVersion(apiVersion: string, broker: CapabilityBroker, id: string): void {
  if (!isApiVersionCompatible(apiVersion, HOST_API_VERSION)) {
    throw new ModuleLoadError(
      `module targets host API ${apiVersion}, this host provides ${HOST_API_VERSION}`,
      id,
    );
  }
  if (apiVersion !== broker.manifest.apiVersion) {
    throw new ModuleLoadError(
      `module reports API ${apiVersion} but its manifest declares ${broker.manifest.apiVersion}`,
      id,
    );
  }
}
