/**
 * The test tip entries: anvil's development accounts, for a local fork only.
 *
 * What matters about them is that they are exactly what they say — public
 * development accounts, marked as tests — so every guard that keeps them off
 * a real network (the engine's chain gate, `PLACEHOLDER_REGISTRIES`,
 * `PUBLIC_DEV_ACCOUNTS`) recognises every one.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPublicDevAccount, ModuleManifestSchema, WireTipCandidateSchema, type WireTipCandidate } from "@spdex/core";
import { tipListProblems } from "@spdex/chain";
import { BrokerSession, CapabilityBroker, NativeRuntime, QuickJSRuntime } from "@spdex/host";
import fixturesModule from "../../index.mjs";

const manifest = ModuleManifestSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), "utf8")),
);
const source = readFileSync(fileURLToPath(new URL("../../module.js", import.meta.url)), "utf8");

const broker = () =>
  new CapabilityBroker({
    manifest,
    chain: {
      multicall: () => {
        throw new Error("a registry must never reach the chain");
      },
    },
  });

async function entries(): Promise<WireTipCandidate[]> {
  const loaded = await new NativeRuntime().loadRegistry({ kind: "object", module: fixturesModule }, broker());
  try {
    return await loaded.listRecipients(new BrokerSession());
  } finally {
    loaded.dispose();
  }
}

describe("tiplist-dev-fixtures", () => {
  it("is a tip list with nothing reachable", () => {
    expect(manifest.kind).toBe("tiplist");
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.contracts).toEqual([]);
    expect(manifest.description).toMatch(/not real people/);
  });

  it("lists only public development accounts, each marked as a test", async () => {
    const list = await entries();
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(() => WireTipCandidateSchema.parse(entry)).not.toThrow();
      expect(isPublicDevAccount(entry.address)).toBe(true);
      expect(entry.test).toBe(true);
      expect(entry.label).toMatch(/^Placeholder: /);
    }
  });

  it("keeps the list rules other than the one about development accounts", async () => {
    expect(tipListProblems(await entries(), { allowDevAccounts: true })).toEqual([]);
  });

  it("produces byte-identical output in the sandbox", async () => {
    const native = await new NativeRuntime().loadRegistry({ kind: "object", module: fixturesModule }, broker());
    const sandboxed = await new QuickJSRuntime().loadRegistry({ kind: "code", code: source }, broker());
    expect(JSON.stringify(await sandboxed.listRecipients(new BrokerSession()))).toBe(
      JSON.stringify(await native.listRecipients(new BrokerSession())),
    );
    native.dispose();
    sandboxed.dispose();
  });
});
