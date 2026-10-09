/**
 * ENS through the person's own service: two reads, the registry then the
 * name's own resolver, and every way that can fail said in words. No
 * CCIP-Read and no wildcard parent: either is "paste the address".
 */

import { describe, expect, it } from "vitest";
import { namehash } from "viem/ens";
import { ENS_MESSAGES, ENS_REGISTRY, looksLikeEnsName, OFFCHAIN_LOOKUP_SELECTOR, resolveEnsName } from "./ens.js";
import type { JsonRpc } from "./reader.js";

const RESOLVER = "0x0000000000000000000000000000000000000abc";
const TARGET = "0x00000000000000000000000000000000000a11ce";
const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

/** A service that answers the two reads from a script, and records every request. */
function service(answer: {
  resolver?: string | Error;
  addr?: string | Error;
}): { rpc: JsonRpc; calls: { method: string; to: string; data: string }[] } {
  const calls: { method: string; to: string; data: string }[] = [];
  const rpc: JsonRpc = async (method, params) => {
    const call = params[0] as { to: string; data: string };
    calls.push({ method, to: call.to, data: call.data });
    const reply = call.to === ENS_REGISTRY ? answer.resolver : answer.addr;
    if (reply instanceof Error) throw reply;
    return reply ?? "0x";
  };
  return { rpc, calls };
}

/** An error shaped as `httpRpc` throws for a revert. */
const reverted = (data: string) => Object.assign(new Error("eth_call: execution reverted"), { code: 3, data });

describe("resolveEnsName", () => {
  it("reads the registry, then the name's own resolver, and nothing else", async () => {
    const { rpc, calls } = service({ resolver: word(RESOLVER), addr: word(TARGET) });
    const result = await resolveEnsName(rpc, " Example.ETH ");
    expect(result).toEqual({ ok: true, name: "example.eth", address: TARGET, resolver: RESOLVER });
    const node = namehash("example.eth").slice(2);
    expect(calls).toEqual([
      { method: "eth_call", to: ENS_REGISTRY, data: `0x0178b8bf${node}` },
      { method: "eth_call", to: RESOLVER, data: `0x3b3b57de${node}` },
    ]);
  });

  it("says a name with no resolver of its own isn't resolved here, without asking a parent", async () => {
    const { rpc, calls } = service({ resolver: word("0x0000000000000000000000000000000000000000") });
    const result = await resolveEnsName(rpc, "sub.example.eth");
    expect(result).toEqual({ ok: false, reason: "unresolved", message: ENS_MESSAGES.unresolved });
    expect(calls).toHaveLength(1);
  });

  it("never follows CCIP-Read: an OffchainLookup revert asks for the address", async () => {
    const { rpc, calls } = service({ resolver: word(RESOLVER), addr: reverted(`${OFFCHAIN_LOOKUP_SELECTOR}${"00".repeat(64)}`) });
    const result = await resolveEnsName(rpc, "example.eth");
    expect(result).toMatchObject({ ok: false, reason: "offchain" });
    expect(ENS_MESSAGES.offchain).toContain("won't ask a third party");
    expect(calls).toHaveLength(2);
  });

  it("reads any other revert from the resolver as unresolved", async () => {
    const { rpc } = service({ resolver: word(RESOLVER), addr: reverted("0x") });
    expect(await resolveEnsName(rpc, "example.eth")).toMatchObject({ ok: false, reason: "unresolved" });
  });

  it("says when a name has no address set", async () => {
    const { rpc } = service({ resolver: word(RESOLVER), addr: word("0x0000000000000000000000000000000000000000") });
    expect(await resolveEnsName(rpc, "example.eth")).toEqual({
      ok: false,
      reason: "no-address",
      message: "No address set for this name.",
    });
  });

  it("tells a service that didn't answer apart from a name that isn't there", async () => {
    const { rpc } = service({ resolver: new TypeError("fetch failed") });
    expect(await resolveEnsName(rpc, "example.eth")).toMatchObject({ ok: false, reason: "unreadable" });
    const limited = service({ resolver: Object.assign(new Error("eth_call: rate limited"), { code: -32005 }) });
    expect(await resolveEnsName(limited.rpc, "example.eth")).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("refuses what ENSIP-15 won't normalise, before asking anyone", async () => {
    const { rpc, calls } = service({});
    expect(await resolveEnsName(rpc, "exa mple.eth")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await resolveEnsName(rpc, "example")).toMatchObject({ ok: false, reason: "invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("looksLikeEnsName", () => {
  it("reads a dotted name as ENS and hex as an address", () => {
    expect(looksLikeEnsName("example.eth")).toBe(true);
    expect(looksLikeEnsName(TARGET)).toBe(false);
    expect(looksLikeEnsName("example")).toBe(false);
  });
});
