/**
 * The tip list spDEX ships, through both runtimes, and every entry in it held
 * to the listing rules.
 *
 * The list is data a maintainer fills in (module.js says how), so these tests
 * are written for any list, empty included: a well-formed entry passes, and a
 * malformed one fails here, before any browser sees it. Today it holds one,
 * spDEX's own donation vault. The rules themselves are `tipListProblems`
 * (packages/chain/src/tipList.ts), which has its own tests with made-up
 * entries.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModuleManifestSchema, SPDEX_DONATION_ADDRESS, WireTipCandidateSchema, type WireTipCandidate } from "@spdex/core";
import { shippedIdProblems, tipClaimSigned, tipListProblems } from "@spdex/chain";
import { BrokerSession, CapabilityBroker, NativeRuntime, QuickJSRuntime } from "@spdex/host";
import registryModule from "../../index.mjs";

const manifest = ModuleManifestSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), "utf8")),
);
const source = readFileSync(fileURLToPath(new URL("../../module.js", import.meta.url)), "utf8");
const readJson = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as unknown;

/** Every id the list has shipped, with its address: append-only (shipped-ids.json says how). */
const SHIPPED = (readJson("../../shipped-ids.json") as { ids: Record<string, string> }).ids;

/**
 * The contracts spDEX knows beyond `@spdex/chain`'s own, which no entry may
 * be: the vault factory and batcher, and every contract a shipped venue
 * declares. (The web app refuses the same, and more, at runtime.)
 */
const KNOWN_ELSEWHERE = new Map<string, string>([
  ...(readJson("../../../../packages/vault/deployments.json") as { factory: string; batcher: string }[]).flatMap(
    (deployment) =>
      [
        [deployment.factory.toLowerCase(), "the vault factory"],
        [deployment.batcher.toLowerCase(), "the vault batcher"],
      ] as const,
  ),
  ...["venue-uniswap-v2", "venue-uniswap-v3"].flatMap((venue) =>
    (readJson(`../../../${venue}/manifest.json`) as { contracts: string[] }).contracts.map(
      (address) => [address.toLowerCase(), `a contract ${venue} uses`] as const,
    ),
  ),
]);

/** No chain access is granted, and the module asks for none. */
const broker = () =>
  new CapabilityBroker({
    manifest,
    chain: {
      multicall: () => {
        throw new Error("a registry must never reach the chain");
      },
    },
  });

/** The shipped entries, as the native runtime returns them. */
async function shipped(): Promise<WireTipCandidate[]> {
  const loaded = await new NativeRuntime().loadRegistry({ kind: "object", module: registryModule }, broker());
  try {
    return await loaded.listRecipients(new BrokerSession());
  } finally {
    loaded.dispose();
  }
}

describe("tiplist-spx-community", () => {
  it("declares no capabilities and no contracts", () => {
    // The strongest statement available about a module: not that it behaves,
    // but that it was handed nothing to misbehave with.
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.contracts).toEqual([]);
    expect(manifest.kind).toBe("tiplist");
  });

  it("no longer describes itself as placeholders: the test entries moved to tiplist-dev-fixtures", () => {
    expect(manifest.description).not.toMatch(/placeholder|not real people|development address/i);
    expect(manifest.version).not.toBe("1.0.0");
  });

  it("loads natively and returns schema-valid candidates", async () => {
    for (const recipient of await shipped()) {
      expect(() => WireTipCandidateSchema.parse(recipient)).not.toThrow();
    }
  });

  it("holds every shipped entry to the listing rules", async () => {
    // Checksummed, unique ids and addresses, no two alike at either end, no
    // public development account, a note and an https proof on each, a
    // replacedBy that names an entry, clean names. Empty is a valid list.
    expect(tipListProblems(await shipped(), { real: true, refuse: KNOWN_ELSEWHERE, own: SPDEX_DONATION_ADDRESS })).toEqual([]);
  });

  it("lists spDEX's own donation vault first, as a builder, at the address the host names", async () => {
    // The host calls an entry spDEX's own from its own constant, never from
    // the list: the two must agree, or the picker would show a proofless
    // entry with nothing to vouch for it.
    const [first] = await shipped();
    expect(first?.id).toBe("spdex-donation-vault");
    expect(first?.address).toBe(SPDEX_DONATION_ADDRESS);
    expect(first?.kind).toBe("builder");
    expect(first?.proof).toBeUndefined();
  });

  it("keeps every id on the address it first shipped with", async () => {
    // An entry edited in place to a new address would move money for everyone
    // who picked it; a replacement is a new id and a retired old one.
    expect(shippedIdProblems(await shipped(), SHIPPED)).toEqual([]);
  });

  it("ships only claims that verify", async () => {
    // A claim that doesn't recover its own address would show "proof link
    // only" next to an entry the maintainer believed was signed: caught here.
    for (const entry of await shipped()) {
      if (entry.claim !== undefined) expect(await tipClaimSigned(entry), entry.id).toBe(true);
    }
  });

  it("produces byte-identical output in the sandbox", async () => {
    // The parity claim, for a kind that is not a venue. A registry running
    // differently under QuickJS would mean the sandbox is not a faithful
    // execution environment, which would undermine every other module too.
    const native = await new NativeRuntime().loadRegistry(
      { kind: "object", module: registryModule },
      broker(),
    );
    const sandboxed = await new QuickJSRuntime().loadRegistry({ kind: "code", code: source }, broker());

    const a = await native.listRecipients(new BrokerSession());
    const b = await sandboxed.listRecipients(new BrokerSession());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

    native.dispose();
    sandboxed.dispose();
  });

  it("hands each caller its own copy", async () => {
    const loaded = await new NativeRuntime().loadRegistry({ kind: "object", module: registryModule }, broker());
    const first = await loaded.listRecipients(new BrokerSession());
    first.push({ address: "0x0000000000000000000000000000000000000001", label: "added by a caller" });
    expect(await loaded.listRecipients(new BrokerSession())).toHaveLength(first.length - 1);
    loaded.dispose();
  });

  it("is refused by the venue loader", async () => {
    // Kinds are not interchangeable. Asking a registry to quote should fail at
    // load with a readable message, not at the first call with a TypeError.
    await expect(
      new NativeRuntime().load({ kind: "object", module: registryModule }, broker()),
    ).rejects.toThrow(/VenueModule/);
  });
});
