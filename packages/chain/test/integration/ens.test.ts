/**
 * ENS on the pinned fork: the registry address spDEX pins is the registry,
 * and a name resolves through two plain reads on the person's own service.
 *
 * The name looked up is ENS's own (`ens.eth`), and nothing asserts which
 * address it points at: what is checked is that the two reads agree with
 * each other and with the registry, not anyone's address. A name nobody
 * registered reads as unresolved, never as an address.
 *
 * Requires a running fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { namehash } from "viem/ens";
import { ENS_REGISTRY, resolveEnsName } from "../../src/ens.js";
import { httpRpc } from "../../src/reader.js";

const FORK_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const rpc = httpRpc(FORK_URL);

beforeAll(async () => {
  try {
    await rpc("eth_chainId", []);
  } catch (error) {
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

describe("ENS through the fork", () => {
  it("finds the registry at the pinned address: code there, and an owner for the root", async () => {
    const code = (await rpc("eth_getCode", [ENS_REGISTRY, "latest"])) as string;
    expect(code.length).toBeGreaterThan(2);
    // owner(bytes32 0x0): the root's owner is set on the real registry.
    const owner = (await rpc("eth_call", [{ to: ENS_REGISTRY, data: `0x02571be3${"00".repeat(32)}` }, "latest"])) as string;
    expect(owner).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(owner)).not.toBe(0n);
  });

  it("resolves a registered name to the address its own resolver gives", async () => {
    const result = await resolveEnsName(rpc, "ENS.eth");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("ens.eth");
    expect(result.address).toMatch(/^0x[0-9a-f]{40}$/);
    // The same two reads, by hand: the registry's resolver, then its addr.
    const node = namehash("ens.eth").slice(2);
    const resolver = (await rpc("eth_call", [{ to: ENS_REGISTRY, data: `0x0178b8bf${node}` }, "latest"])) as string;
    expect(`0x${resolver.slice(26)}`).toBe(result.resolver);
    const addr = (await rpc("eth_call", [{ to: result.resolver, data: `0x3b3b57de${node}` }, "latest"])) as string;
    expect(`0x${addr.slice(26)}`).toBe(result.address);
  });

  it("reads a name nobody registered as unresolved", async () => {
    const result = await resolveEnsName(rpc, "spdex-no-such-name-4c1e9a.eth");
    expect(result).toMatchObject({ ok: false, reason: "unresolved" });
  });
});
