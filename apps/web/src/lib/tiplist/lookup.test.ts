/**
 * A new tip address's two reads, through the main service and the second
 * opinion: a name both point the same way is used, one they disagree about
 * is refused, and code is compared too. No network: each service is a
 * script. Every address is made up.
 */

import { describe, expect, it } from "vitest";
import { ENS_REGISTRY, type JsonRpc } from "@spdex/chain";
import { readTipCode, resolveTipName, type TipServices } from "./lookup.js";

const RESOLVER = "0x0000000000000000000000000000000000000abc";
const FRIEND = "0x00000000000000000000000000000000000a11ce";
const ATTACKER = "0x0000000000000000000000000000000000000bad";
const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

/** A service whose name points at `target`, and whose code at any address is `code`. */
function service(target: string | Error, code: string | Error = "0x"): JsonRpc {
  return async (method, params) => {
    if (method === "eth_getCode") {
      if (code instanceof Error) throw code;
      return code;
    }
    const call = params[0] as { to: string };
    if (target instanceof Error) throw target;
    return call.to === ENS_REGISTRY ? word(RESOLVER) : word(target);
  };
}

const services = (main: JsonRpc, second: JsonRpc | null): TipServices => ({
  main,
  second: second === null ? null : { rpc: second, host: "second.example" },
});

describe("resolveTipName", () => {
  it("uses the main service alone when no second opinion is set", async () => {
    expect(await resolveTipName(services(service(FRIEND), null), "friend.eth")).toEqual({
      ok: true,
      name: "friend.eth",
      address: FRIEND,
      checkedByBoth: false,
    });
  });

  it("uses a name both services point at the same address", async () => {
    expect(await resolveTipName(services(service(FRIEND), service(FRIEND)), "friend.eth")).toMatchObject({ ok: true, checkedByBoth: true });
  });

  it("refuses a name the two services point at different addresses", async () => {
    const lied = await resolveTipName(services(service(ATTACKER), service(FRIEND)), "friend.eth");
    expect(lied).toMatchObject({ ok: false });
    expect(!lied.ok && lied.message).toMatch(/^Your two network services disagree about where this name points/);
    expect(!lied.ok && lied.message).toContain("second.example");
  });

  it("says so when the second opinion can't read the name, rather than passing it", async () => {
    const result = await resolveTipName(services(service(FRIEND), service(new Error("fetch failed"))), "friend.eth");
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toMatch(/second opinion, second.example, couldn't read this name/);
  });
});

describe("readTipCode", () => {
  it("reads through both services, and says when they differ", async () => {
    expect(await readTipCode(services(service(FRIEND, "0x"), null), FRIEND)).toBe("none");
    expect(await readTipCode(services(service(FRIEND, "0x"), service(FRIEND, "0x")), FRIEND)).toBe("none");
    expect(await readTipCode(services(service(FRIEND, "0x"), service(FRIEND, "0x6080")), FRIEND)).toBe("disputed");
    expect(await readTipCode(services(service(FRIEND, "0x"), service(FRIEND, new Error("down"))), FRIEND)).toBe("unknown");
    expect(await readTipCode(services(service(FRIEND, new Error("down")), null), FRIEND)).toBe("unknown");
  });
});
