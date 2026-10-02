/**
 * The kind table, without a runtime.
 *
 * The parity suite proves both runtimes build the same views from this table.
 * These tests pin the table itself: that every row is a kind the host admits,
 * that a row's view carries exactly its own methods and parses every answer,
 * and that the gate the load seam relies on refuses what it should.
 */

import { describe, expect, it, vi } from "vitest";
import { isImplementedKind, type ModuleKind } from "@spdex/core";
import { BrokerSession } from "../broker.js";
import {
  KIND_SPECS,
  LOADABLE_KINDS,
  assertLoadable,
  bindView,
  isKindMethod,
  isLoadableKind,
  specFor,
  type Invoke,
} from "./kinds.js";
import { ModuleExecutionError, ModuleLoadError, type LoadableKind } from "./types.js";

/** Call every method a view has, with arguments the stub ignores. */
async function callEach(view: object, names: readonly string[]): Promise<PromiseSettledResult<unknown>[]> {
  const methods = view as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return Promise.allSettled(names.map((name) => methods[name]!(undefined, undefined, new BrokerSession())));
}

describe("KIND_SPECS", () => {
  it("lists exactly the four kinds that ship a module", () => {
    expect([...LOADABLE_KINDS]).toEqual(["venue", "tiplist", "tracker", "scheduler"]);
  });

  it("gives a runtime path only to kinds the host admits", () => {
    // `tracker` shipped while missing from IMPLEMENTED_MODULE_KINDS. Nothing
    // read that list then; `assertLoadable` does now, so a loadable kind the
    // list omits would be a module the host can run but always refuses.
    expect(LOADABLE_KINDS.every(isImplementedKind)).toBe(true);
  });

  it("names only plain identifiers as methods, since QuickJS splices them into code", () => {
    for (const kind of LOADABLE_KINDS) {
      const spec = KIND_SPECS[kind];
      expect(spec.methods.length).toBeGreaterThan(0);
      for (const method of spec.methods) expect(method).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
      expect(new Set(spec.methods).size).toBe(spec.methods.length);
      expect(spec.interfaceName).toMatch(/^[A-Z][A-Za-z]*Module$/);
    }
  });

  it("binds exactly the methods each kind requires", () => {
    // The one cast in bindView rests on this: a row's bound methods plus the
    // three shared members are the whole view.
    const invoke: Invoke = async () => null;
    for (const kind of LOADABLE_KINDS) {
      const spec = KIND_SPECS[kind];
      expect(Object.keys(spec.bind(invoke)).sort()).toEqual([...spec.methods].sort());
    }
  });

  it("calls each method by its own name and parses every answer", async () => {
    for (const kind of LOADABLE_KINDS) {
      const spec = KIND_SPECS[kind];
      const invoke = vi.fn<Invoke>(async () => ({ nonsense: true }));
      const results = await callEach(spec.bind(invoke), spec.methods);
      // Malformed output never reaches the caller, from any kind.
      for (const result of results) expect(result.status).toBe("rejected");
      expect(invoke.mock.calls.map(([method]) => method)).toEqual([...spec.methods]);
    }
  });

  it("returns a well-formed scheduler answer as given", async () => {
    const decision = {
      due: [{ planId: "dca-1", slot: 3, amountIn: "1000" }],
      next: [{ planId: "dca-1", at: "1790003600" }],
    };
    const invoke = vi.fn<Invoke>(async () => decision);
    const request = { now: "1790000000", plans: [], progress: [] };
    const { dueBuys } = KIND_SPECS.scheduler.bind(invoke);
    expect(await dueBuys(request, new BrokerSession())).toEqual(decision);
    expect(invoke).toHaveBeenCalledWith("dueBuys", [request], expect.any(BrokerSession));
  });
});

describe("isLoadableKind / isKindMethod", () => {
  it("knows the table's kinds, and nothing every object inherits", () => {
    for (const kind of LOADABLE_KINDS) expect(isLoadableKind(kind)).toBe(true);
    for (const kind of ["tokenlist", "policy", "constructor", "toString", "__proto__", ""]) {
      expect(isLoadableKind(kind)).toBe(false);
    }
  });

  it("admits only the table's method names", () => {
    expect(isKindMethod("dueBuys")).toBe(true);
    expect(isKindMethod("discoverPools")).toBe(true);
    for (const name of ["constructor", "toString", "dueBuys; globalThis.x = 1", "apiVersion", "dispose", ""]) {
      expect(isKindMethod(name)).toBe(false);
    }
  });
});

describe("specFor", () => {
  it("refuses a kind with no row with a load error, not a TypeError", () => {
    expect(() => specFor("tokenlist" as LoadableKind, "some-module")).toThrow(ModuleLoadError);
    expect(() => specFor("tokenlist" as LoadableKind, "some-module")).toThrow(/no runtime path for tokenlist/);
  });
});

describe("bindView", () => {
  const parts = (invoke: Invoke) => ({ runtime: "native" as const, apiVersion: "1.0.0", moduleId: "m-1", invoke });

  it("carries only its own kind's methods and the three shared members", () => {
    const view = bindView("scheduler", parts(async () => null));
    expect(Object.keys(view).sort()).toEqual(["apiVersion", "dispose", "dueBuys", "kind"]);
    expect(view.kind).toBe("native");
    expect(view.apiVersion).toBe("1.0.0");
    expect("discoverPools" in view).toBe(false);
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("refuses every call after dispose, without reaching the runtime", async () => {
    const invoke = vi.fn<Invoke>(async () => ({ due: [], next: [] }));
    const view = bindView("scheduler", parts(invoke));
    await view.dueBuys({ now: "1", plans: [], progress: [] }, new BrokerSession());
    view.dispose();
    await expect(view.dueBuys({ now: "1", plans: [], progress: [] }, new BrokerSession())).rejects.toThrow(
      ModuleExecutionError,
    );
    await expect(view.dueBuys({ now: "1", plans: [], progress: [] }, new BrokerSession())).rejects.toThrow(
      /disposed/,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("assertLoadable", () => {
  const manifest = (kind: ModuleKind) => ({ id: "scheduler-dca", kind });

  it("accepts a module as the kind its manifest declares", () => {
    for (const kind of LOADABLE_KINDS) expect(() => assertLoadable(manifest(kind), kind)).not.toThrow();
  });

  it("refuses a module as any other kind, naming both", () => {
    // Shape alone would let code that happens to define `dueBuys` run as a
    // scheduler under a manifest the user reviewed as a tip list.
    expect(() => assertLoadable(manifest("scheduler"), "venue")).toThrow(ModuleLoadError);
    expect(() => assertLoadable(manifest("scheduler"), "venue")).toThrow(/"scheduler".*venue/);
    expect(() => assertLoadable(manifest("tiplist"), "scheduler")).toThrow(/"tiplist".*scheduler/);
    expect(() => assertLoadable(manifest("venue"), "tracker")).toThrow(ModuleLoadError);
  });

  it("refuses a kind the host does not implement, even when the manifest agrees", () => {
    expect(() => assertLoadable(manifest("policy"), "policy" as LoadableKind)).toThrow(/not implemented/);
  });

  it("refuses an admitted kind that has no runtime path yet", () => {
    // `tokenlist` is in IMPLEMENTED_MODULE_KINDS but has no row: admitting it
    // here would let a caller past the gate into a runtime that cannot load it.
    expect(() => assertLoadable(manifest("tokenlist"), "tokenlist" as LoadableKind)).toThrow(/no runtime path/);
  });

  it("names the module in the error", () => {
    try {
      assertLoadable(manifest("venue"), "scheduler");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleLoadError);
      expect((error as ModuleLoadError).moduleId).toBe("scheduler-dca");
    }
  });
});
