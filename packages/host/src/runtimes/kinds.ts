/**
 * The module kinds a runtime can load, as one table.
 *
 * Each row says three things about a kind: the name of its interface (for the
 * load error a user reads), the methods a module of that kind must define, and
 * how to turn a runtime's raw "call this method" into the typed view the host
 * uses — including the schema every answer is parsed with. Both runtimes build
 * their views from the same row, so output validation is literally the same
 * code whichever runtime ran the module. That is a stronger parity guarantee
 * than two hand-written copies of the same parse, which is what there was
 * before: three per runtime, one per kind.
 *
 * ## Why method names come only from here
 *
 * The QuickJS runtime calls a method by interpolating its name into code it
 * evaluates inside the VM. A name that came from a manifest, a config or a
 * module would therefore be code injection into the driver. So the names are
 * static, each row can name only its own (see `Invoke`), and the sandbox
 * checks a name against the table again before it uses one (`isKindMethod`).
 *
 * ## Why the kind gate is here and not inside the runtimes
 *
 * A runtime checks shape, never `manifest.kind`: it answers "can this code be
 * driven as a scheduler", not "should it be". `assertLoadable` answers the
 * second question, and the seam that chooses which module to load calls it.
 * Keeping the two apart lets the runtimes stay kind-agnostic, which is what
 * made adding kinds cheap in the first place.
 */

import {
  WireBuildResultSchema,
  WirePoolRefSchema,
  WirePoolStatsSchema,
  WireScheduleDecisionSchema,
  WireTipCandidateSchema,
  WireVenueQuoteSchema,
  isImplementedKind,
  type ModuleManifest,
} from "@spdex/core";
import type { BrokerSession } from "../broker.js";
import {
  ModuleExecutionError,
  ModuleLoadError,
  type KindViews,
  type LoadableKind,
  type RuntimeKind,
} from "./types.js";

/**
 * A venue's `buildCalls` answered with an `intent` of its own.
 *
 * The swap intent — who receives, how little is acceptable, by when — is the
 * host's, and the Guard checks a module's calls against the host's intent,
 * never one the module supplied. The schema would strip the key and say
 * nothing, so a module that tried would look like one that didn't; refusing
 * it by name is how the conformance kit (`interface.noIntent`) and a module's
 * author find out.
 */
export class AuthoredIntentError extends Error {
  constructor() {
    super("buildCalls returned an intent of its own; a module never authors the swap intent — the host attaches it");
    this.name = "AuthoredIntentError";
  }
}

/** What a view offers beyond the three members every view shares. */
type MethodsOf<V> = Omit<V, "kind" | "apiVersion" | "dispose">;
type MethodName<V> = keyof MethodsOf<V> & string;

/** Every method name any kind defines. The only strings a runtime will call. */
export type KindMethod = { [K in LoadableKind]: MethodName<KindViews[K]> }[LoadableKind];

/**
 * How a runtime runs one method of a loaded module.
 *
 * `args` are the host's own values and `session` meters the call. The result is
 * whatever the module returned after crossing the wire as JSON — untrusted and
 * unparsed; the kind's row parses it.
 *
 * Each row is handed an `Invoke` narrowed to its own method names, so a row
 * cannot even name another kind's method. A runtime implements the wide form
 * and checks the name itself, because it is the one that would act on a bad
 * one.
 */
export type Invoke<M extends string = string> = (
  method: M,
  args: readonly unknown[],
  session: BrokerSession,
) => Promise<unknown>;

export interface KindSpec<V> {
  /** Named in the native runtime's load error, e.g. "does not implement the VenueModule interface". */
  readonly interfaceName: string;
  /** Checked at load in both runtimes, so a missing method is a load error rather than a failed call. */
  readonly methods: readonly MethodName<V>[];
  /** The typed methods of the view, each parsing the module's answer before anyone sees it. */
  bind(invoke: Invoke<MethodName<V>>): MethodsOf<V>;
}

export const KIND_SPECS: { readonly [K in LoadableKind]: KindSpec<KindViews[K]> } = {
  venue: {
    interfaceName: "VenueModule",
    methods: ["discoverPools", "quoteBatch", "buildCalls"],
    bind: (invoke) => ({
      discoverPools: async (pair, session) =>
        WirePoolRefSchema.array().parse(await invoke("discoverPools", [pair], session)),
      quoteBatch: async (requests, pools, session) =>
        WireVenueQuoteSchema.array().parse(await invoke("quoteBatch", [requests, pools], session)),
      buildCalls: async (quote, params, session) => {
        const raw = await invoke("buildCalls", [quote, params], session);
        const built = WireBuildResultSchema.parse(raw);
        // Checked on the raw answer, after its shape: the parse strips keys.
        if (typeof raw === "object" && raw !== null && "intent" in raw) throw new AuthoredIntentError();
        return built;
      },
    }),
  },
  tiplist: {
    interfaceName: "RegistryModule",
    methods: ["listRecipients"],
    // Through the schema exactly as a venue's output is. A registry names the
    // addresses a user's money will be sent to, so "it is only a list" is the
    // reason to validate it, not to skip it.
    bind: (invoke) => ({
      listRecipients: async (session) =>
        WireTipCandidateSchema.array().parse(await invoke("listRecipients", [], session)),
    }),
  },
  tracker: {
    interfaceName: "TrackerModule",
    methods: ["scanPools"],
    bind: (invoke) => ({
      scanPools: async (pools, session) =>
        WirePoolStatsSchema.array().parse(await invoke("scanPools", [pools], session)),
    }),
  },
  scheduler: {
    interfaceName: "SchedulerModule",
    methods: ["dueBuys"],
    // The schema is the shape only. Whether a proposed buy fits the plan is a
    // separate question with its own answer (`vetScheduleDecision`, then the
    // Guard), because it depends on the request, not just on the reply.
    bind: (invoke) => ({
      dueBuys: async (request, session) =>
        WireScheduleDecisionSchema.parse(await invoke("dueBuys", [request], session)),
    }),
  },
};

/** The kinds with a runtime path, in table order. */
export const LOADABLE_KINDS: readonly LoadableKind[] = Object.freeze(
  Object.keys(KIND_SPECS) as LoadableKind[],
);

/**
 * Whether a runtime can load this kind.
 *
 * An own-property check rather than `in`, so "constructor" or "toString" —
 * which every object inherits — are not mistaken for kinds.
 */
export function isLoadableKind(kind: string): kind is LoadableKind {
  return Object.hasOwn(KIND_SPECS, kind);
}

const KIND_METHODS: ReadonlySet<string> = new Set(
  LOADABLE_KINDS.flatMap((kind) => KIND_SPECS[kind].methods),
);

/** Whether a string is one of the table's method names — the check before a name reaches evaluated code. */
export function isKindMethod(method: string): method is KindMethod {
  return KIND_METHODS.has(method);
}

/**
 * A kind's row, or a load error naming the kind.
 *
 * Unreachable from typed callers. It exists for the ones that are not — a
 * cast, or plain JavaScript — so an unknown kind is refused with a message
 * rather than a TypeError from reading a row that is not there.
 */
export function specFor<K extends LoadableKind>(moduleKind: K, moduleId: string): KindSpec<KindViews[K]> {
  if (!isLoadableKind(moduleKind)) {
    throw new ModuleLoadError(`this host has no runtime path for ${String(moduleKind)} modules`, moduleId);
  }
  return KIND_SPECS[moduleKind];
}

/**
 * Refuse to load a module as anything other than the kind its manifest declares.
 *
 * The check the host makes before loading a module it has chosen for a job.
 * The runtimes cannot make it themselves (see the header), and without it a
 * module whose code happened to define `dueBuys` could be run as a scheduler
 * while its manifest — the thing a user reviewed — said it was a tip list.
 *
 * Three conditions, each with its own message: the host implements the kind
 * (`IMPLEMENTED_MODULE_KINDS`), a runtime can load it (`LOADABLE_KINDS`), and
 * the manifest declares exactly that kind. The first also holds the table to
 * the manifest schema at compile time: `isImplementedKind` accepts only a
 * `ModuleKind`, so a row keyed on anything a manifest cannot declare — a
 * runtime path no module could ever reach — fails to typecheck here.
 */
export function assertLoadable(
  manifest: Pick<ModuleManifest, "id" | "kind">,
  expected: LoadableKind,
): void {
  if (!isImplementedKind(expected)) {
    throw new ModuleLoadError(`${expected} modules are not implemented by this host`, manifest.id);
  }
  if (!isLoadableKind(expected)) {
    throw new ModuleLoadError(`this host has no runtime path for ${String(expected)} modules`, manifest.id);
  }
  if (manifest.kind !== expected) {
    throw new ModuleLoadError(
      `module ${manifest.id} declares kind "${manifest.kind}" and cannot be loaded as a ${expected} module`,
      manifest.id,
    );
  }
}

export interface ViewParts {
  runtime: RuntimeKind;
  /** The version the load handshake checked, fixed for the view's lifetime. */
  apiVersion: string;
  moduleId: string;
  invoke: Invoke;
}

/**
 * Build a kind's view around a runtime's `invoke`.
 *
 * The only place a view is made, so what every view guarantees is written
 * once: it carries exactly its kind's methods, its answers are parsed by the
 * kind's schema, it is frozen, and after `dispose` every call is refused.
 * The last used to be true of the sandbox only; a native module kept
 * answering after disposal, which is the kind of drift the parity gate exists
 * to rule out.
 */
export function bindView<K extends LoadableKind>(moduleKind: K, parts: ViewParts): KindViews[K] {
  const spec = specFor(moduleKind, parts.moduleId);
  let disposed = false;
  const invoke: Invoke = async (method, args, session) => {
    if (disposed) throw new ModuleExecutionError("module has been disposed", parts.moduleId, method);
    return parts.invoke(method, args, session);
  };
  // The one cast: TypeScript cannot correlate `K` between the row and the view
  // map, so it cannot see that this row's methods plus the three shared
  // members are exactly `KindViews[K]`. kinds.test.ts checks it at runtime.
  return Object.freeze({
    ...spec.bind(invoke),
    kind: parts.runtime,
    apiVersion: parts.apiVersion,
    dispose(): void {
      disposed = true;
    },
  }) as unknown as KindViews[K];
}
