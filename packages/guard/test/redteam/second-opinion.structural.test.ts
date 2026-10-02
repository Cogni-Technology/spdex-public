/**
 * Red team, structural: the second opinion reaches every Guard the Engine
 * builds, and no path can sign what it refuses.
 *
 * A second opinion that one Guard forgot would be the one a lying main
 * service aims at. So every Guard class the Engine constructs is run here
 * through every path of it that simulates (fixtures/guards.ts), with
 * `requireSimulation` off — the setting under which a path could otherwise
 * sign something unchecked — and:
 *
 *   - a second service that disagrees → rejected, on every path;
 *   - a second service that doesn't answer → `unverified` at best, never
 *     `verified`, and `rejected` where the path never signs unchecked;
 *   - a provider that reports a disagreement *without* the revert → still
 *     rejected, which proves each path applies the second opinion itself and
 *     does not only lean on the revert.
 *
 * The `redteam` project only runs this directory, so it can't see the Engine
 * by importing it. It reads apps/web/src/lib/engine.ts as text instead, and
 * fails when the Engine constructs a Guard class this file doesn't cover, or
 * constructs one on a provider that isn't wrapped by `this.#checked(…)`.
 */

import { describe, expect, it } from "vitest";
import { ScriptedPairProvider, ScriptedSimulationProvider } from "@spdex/testing";
import { EthSimulateV1Provider, type SimLog, type SimulationOutcome, type SimulationProvider } from "@spdex/chain";
import * as guards from "../../src/index.js";
import { SecondOpinionPair } from "../../src/second-opinion.js";
import { GUARD_PATHS, type GuardClass } from "./fixtures/guards.js";

declare global {
  interface ImportMeta {
    glob(pattern: string | string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

const engineSource = Object.values(import.meta.glob("../../../../apps/web/src/lib/engine.ts", { query: "?raw", import: "default", eager: true }))[0];

const HOST = "second.example";
/** A log only the second service reports: enough to disagree about. */
const EXTRA: SimLog = { address: "0x00000000000000000000000000000000000000aa", topics: [], data: "0x" };

/** An `AgreeingSimulationProvider` over two scripted services, both honest unless told otherwise. */
function agreeing(logs: () => SimLog[], second: ConstructorParameters<typeof ScriptedPairProvider>[0]["second"] = {}): SimulationProvider {
  const pair = new ScriptedPairProvider({ run: () => ({ status: "success", logs: logs() }), second });
  return new SecondOpinionPair({ primaryRpc: pair.primary, secondRpc: pair.second, host: HOST, sleep: async () => {}, timeoutMs: 50 }).provider(
    new EthSimulateV1Provider(pair.primary),
  );
}

const codes = (v: { violations: { code: string }[]; warnings: { code: string }[] }) => [...v.violations, ...v.warnings].map((x) => x.code);

/**
 * Each `new …Guard(` in `source` whose provider isn't wrapped by
 * `this.#checked(`, as the text that follows it. `ScheduledBuyGuard` takes a
 * Guard, which this scan checks where it is built; the preview Guard, which
 * simulates nothing, is built on an `UnavailableSimulationProvider`.
 */
function uncheckedGuards(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bnew\s+((?:[A-Z][A-Za-z0-9]*)?Guard)\s*\(\s*/g)) {
    if (match[1] === "ScheduledBuyGuard") continue;
    const after = source.slice(match.index! + match[0].length);
    if (after.startsWith("this.#checked(") || after.startsWith("new UnavailableSimulationProvider(")) continue;
    found.push(`${match[1]}(${/^[^,\n]*/.exec(after)![0]}…`);
  }
  return found;
}

describe("the Guard classes the Engine builds", () => {
  const covered = new Set<GuardClass>(GUARD_PATHS.map((path) => path.guard));

  it("finds the Engine's source", () => {
    expect(engineSource, "apps/web/src/lib/engine.ts").toBeTypeOf("string");
    expect(engineSource!.length).toBeGreaterThan(1_000);
  });

  it("are each covered here: a Guard class the Engine constructs and this file doesn't run fails this", () => {
    const constructed = new Set([...engineSource!.matchAll(/\bnew\s+((?:[A-Z][A-Za-z0-9]*)?Guard)\s*\(/g)].map((m) => m[1]!));
    // All four today; the plain Guard three times (swaps, scheduled buys' legs, previews).
    expect([...constructed].sort()).toEqual(expect.arrayContaining(["Guard", "ScheduledBuyGuard", "TipGuard", "VaultGuard"]));
    const missing = [...constructed].filter((name) => !covered.has(name as GuardClass));
    expect(missing, "Guard classes the Engine builds that the second opinion isn't tested through").toEqual([]);
  });

  it("each simulate through the second opinion: every construction's provider is `this.#checked(…)`", () => {
    // Which classes are built says nothing about how: a Guard handed a raw
    // provider would skip the second opinion with every other test here green.
    expect(uncheckedGuards(engineSource!), "Guards the Engine builds without this.#checked(…)").toEqual([]);
    // The scan itself catches that edit, on a copy with one wrapper dropped.
    const mutated = engineSource!.replace(
      /new VaultGuard\(this\.#checked\((new DefiniteSimulationProvider\(this\.#rpc\))\)/,
      "new VaultGuard($1",
    );
    expect(mutated).not.toBe(engineSource);
    expect(uncheckedGuards(mutated)).toEqual(["VaultGuard(new DefiniteSimulationProvider(this.#rpc)…"]);
  });

  it("are every Guard class the package exports", () => {
    const exported = Object.keys(guards).filter((name) => /^(?:[A-Z][A-Za-z0-9]*)?Guard$/.test(name));
    expect(exported.sort()).toEqual([...covered].sort());
  });
});

describe.each(GUARD_PATHS.map((path) => [path.name, path] as const))("%s", (_, path) => {
  it("is verified when both services agree (the baseline every case below departs from)", async () => {
    const verdict = await path.check(agreeing(path.logs), false);
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("is rejected when the second service disagrees, with requireSimulation off", async () => {
    const verdict = await path.check(agreeing(path.logs, { run: () => ({ status: "success", logs: [...path.logs(), EXTRA] }) }), false);
    expect(verdict.level).toBe("rejected");
    expect(verdict.signable).toBe(false);
    expect(codes(verdict)).toContain("SECOND_OPINION_DISAGREES");
  });

  it("is rejected when the second service reverts where the main one doesn't", async () => {
    const verdict = await path.check(agreeing(path.logs, { run: () => ({ status: "reverted", reason: "execution reverted" }) }), false);
    expect(verdict.level).toBe("rejected");
  });

  it(`is ${path.unavailable}, never verified, when the second service doesn't answer`, async () => {
    const verdict = await path.check(agreeing(path.logs, { fail: ["eth_simulateV1"] }), false);
    expect(verdict.level).not.toBe("verified");
    expect(verdict.level).toBe(path.unavailable);
    expect(codes(verdict)).toContain("SECOND_OPINION_UNAVAILABLE");
  });

  it("is rejected when the second service doesn't answer and requireSimulation is on", async () => {
    const verdict = await path.check(agreeing(path.logs, { hang: ["eth_blockNumber"] }), true);
    expect(verdict.level).toBe("rejected");
  });

  it("is rejected by a provider that reports a disagreement without reverting: the path applies the second opinion itself", async () => {
    const outcome: SimulationOutcome = {
      status: "success",
      gasUsed: 150_000n,
      logs: path.logs(),
      secondOpinion: { kind: "disagrees", host: HOST, reason: "result", detail: "scripted" },
    };
    const verdict = await path.check(new ScriptedSimulationProvider(outcome), false);
    expect(verdict.level).toBe("rejected");
    expect(codes(verdict)).toContain("SECOND_OPINION_DISAGREES");
  });

  it("is never verified by a provider that reports the second service unavailable", async () => {
    const outcome: SimulationOutcome = {
      status: "success",
      gasUsed: 150_000n,
      logs: path.logs(),
      secondOpinion: { kind: "unavailable", host: HOST, reason: "scripted" },
    };
    const verdict = await path.check(new ScriptedSimulationProvider(outcome), false);
    expect(verdict.level).toBe(path.unavailable);
  });
});
