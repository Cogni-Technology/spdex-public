/**
 * Re-verify every hardcoded mainnet constant against the pinned fork.
 *
 * The addresses in `src/constants.ts` were checked on-chain when written, but
 * "was correct once" is not a property a repo can rely on — a transposed
 * character survives review easily and fails in a way that looks like a routing
 * bug rather than a typo. This suite makes that class of error impossible to
 * merge.
 *
 * It also pins SPX's decimals. Assuming 18 instead of the real 8 would misprice
 * every quote in the app by ten orders of magnitude while looking entirely
 * plausible in a diff.
 *
 * Requires a running fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { CHAINLINK_FEEDS, CONTRACTS, TOKENS } from "../../src/constants.js";

const FORK_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const EXPECTED_BLOCK = BigInt(process.env.SPDEX_FORK_BLOCK ?? "26000000");

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(FORK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** Decode an ABI-encoded `string` return value. */
function decodeString(hex: string): string {
  const body = hex.slice(2);
  const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
  const length = Number.parseInt(body.slice(offset, offset + 64), 16) * 2;
  const chars = body.slice(offset + 64, offset + 64 + length);
  const bytes = new Uint8Array(
    (chars.match(/.{2}/g) ?? []).map((byte) => Number.parseInt(byte, 16)),
  );
  return new TextDecoder().decode(bytes);
}

beforeAll(async () => {
  try {
    await rpc("eth_chainId", []);
  } catch (error) {
    // A clear instruction beats a connection-refused stack trace.
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

describe("the fork itself", () => {
  it("reports the configured chain id", async () => {
    // Not hardcoded to 1: the fork runs under its own id on purpose, so that a
    // wallet treats it as a custom network and prices gas from the node rather
    // than from a mainnet service. The id is cosmetic — the block-hash check
    // below is what proves the state really is mainnet's.
    const expected = Number(process.env.SPDEX_FORK_CHAIN_ID ?? "690069");
    expect(Number.parseInt(await rpc<string>("eth_chainId", []), 16)).toBe(expected);
  });

  it("was seeded at the expected block, with the expected history", async () => {
    // The invariant that matters is that the fork's history IS mainnet at the
    // pinned height — not that the chain has never moved. Other suites legitimately
    // mine blocks (a swap has to be executed to check a quote against reality),
    // and asserting exact equality made this fail for the wrong reason: it
    // reported a dirty fork when the real problem was a test that had not
    // restored its snapshot.
    const anchorHash = process.env.SPDEX_FORK_BLOCK_HASH?.toLowerCase();
    const pinned = (await rpc<{ hash: string } | null>("eth_getBlockByNumber", [
      `0x${EXPECTED_BLOCK.toString(16)}`,
      false,
    ]));

    expect(pinned).not.toBeNull();
    if (anchorHash) expect(pinned!.hash.toLowerCase()).toBe(anchorHash);

    const head = BigInt(await rpc<string>("eth_blockNumber", []));
    expect(head).toBeGreaterThanOrEqual(EXPECTED_BLOCK);
  });
});

describe("contract addresses", () => {
  it.each(Object.entries(CONTRACTS))("%s has deployed code", async (_name, address) => {
    const code = await rpc<string>("eth_getCode", [address, "latest"]);
    expect(code).not.toBe("0x");
    expect(code.length).toBeGreaterThan(2);
  });
});

describe("Chainlink feeds", () => {
  // At the pinned block: a feed's description and decimals are what the
  // build relies on, and they are fixed there. The answers themselves are
  // checked in fx.test.ts.
  const pinned = `0x${EXPECTED_BLOCK.toString(16)}`;

  it.each(Object.entries(CHAINLINK_FEEDS))("%s / USD is the feed its name says, with its decimals", async (name, feed) => {
    const description = decodeString(await rpc<string>("eth_call", [{ to: feed.address, data: "0x7284e416" }, pinned]));
    const decimals = Number.parseInt(await rpc<string>("eth_call", [{ to: feed.address, data: "0x313ce567" }, pinned]), 16);
    expect(description).toBe(`${name} / USD`);
    expect(decimals).toBe(feed.decimals);
  });
});

describe("native value in simulations", () => {
  it("reports native transfers as a Transfer log from the native pseudo-address", async () => {
    // Pinned deliberately. Phase 1 declined to account for native ETH from
    // simulation logs because the emitter address was implementation-defined,
    // so the Guard bounds ETH statically instead. This test records what a real
    // node actually does, so that when a venue needs native accounting the
    // decision rests on evidence — and so a provider that reports it
    // differently fails here rather than producing unchecked swaps.
    const from = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    const to = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

    const simulated = await rpc<{ calls: { status: string; logs: { address: string; topics: string[] }[] }[] }[]>(
      "eth_simulateV1",
      [
        {
          blockStateCalls: [{ calls: [{ from, to, value: "0xde0b6b3a7640000" }] }],
          traceTransfers: true,
          validation: false,
        },
        "latest",
      ],
    );

    const call = simulated[0]?.calls[0];
    expect(call).toBeDefined();
    expect(BigInt(call!.status)).toBe(1n);

    const [log] = call!.logs;
    expect(log).toBeDefined();
    expect(log!.address.toLowerCase()).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    // The standard ERC-20 Transfer topic, so one decoder handles both.
    expect(log!.topics[0]).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });
});

describe("native movement in simulation", () => {
  /*
   * The test above pins a *top-level* value transfer. This pins the internal
   * case, which is the one the ETH paths actually depend on: when a user sells
   * a token for ether, the value never moves at the top level at all — the
   * router takes delivery of WETH, unwraps it, and forwards ether from inside
   * the call.
   *
   * If `traceTransfers` reported only top-level movement, the Guard would see
   * the recipient receive nothing and refuse every swap that pays out ether,
   * with a message pointing at the wrong thing entirely. Cheap to assert, and
   * the alternative is discovering it from a baffling refusal.
   */
  it("reports ether forwarded by a contract, not only top-level sends", async () => {
    const [from] = await rpc<string[]>("eth_accounts", []);
    // Wrap, then unwrap: the withdrawal sends ether back from inside WETH9,
    // so nothing moves at the top level of the second call.
    const weth = TOKENS.WETH.address;

    const simulated = await rpc<{ calls: { status: string; logs: { address: string; topics: string[]; data: string }[] }[] }[]>(
      "eth_simulateV1",
      [
        {
          blockStateCalls: [
            {
              // Simulated as a plain account. Every anvil dev key inherits an
              // EIP-7702 delegation from mainnet, and WETH9 forwards ether with
              // a 2300-gas `transfer` — which the delegated code cannot run in,
              // so the unwrap reverts. The e2e fixtures strip that delegation
              // from the shared fork, which made this test pass only on a fork
              // some other suite had already touched. Overriding the code here
              // keeps it independent of run order and leaves the fork alone.
              stateOverrides: { [from!]: { code: "0x" } },
              calls: [
                // deposit()
                { from, to: weth, value: "0xde0b6b3a7640000", data: "0xd0e30db0" },
                //  withdraw(uint256)
                { from, to: weth, data: `0x2e1a7d4d${(10n ** 18n).toString(16).padStart(64, "0")}` },
              ],
            },
          ],
          traceTransfers: true,
          validation: false,
        },
        "latest",
      ],
    );

    const withdrawCall = simulated[0]?.calls[1];
    expect(withdrawCall).toBeDefined();
    expect(BigInt(withdrawCall!.status)).toBe(1n);

    // WETH9 sends the ether back from inside the call. That must appear as a
    // native Transfer, emitted by the pseudo-address, exactly like a top-level
    // one — which is what lets one decoder handle both.
    const native = withdrawCall!.logs.filter(
      (log) => log.address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );
    expect(native.length).toBeGreaterThan(0);

    const toWho = native.map((log) => `0x${log.topics[2]!.slice(26)}`.toLowerCase());
    expect(toWho).toContain(from!.toLowerCase());
  });
});

describe("token metadata", () => {
  it.each(Object.entries(TOKENS))(
    "%s matches its on-chain symbol and decimals",
    async (_name, token) => {
      const symbol = decodeString(
        await rpc<string>("eth_call", [{ to: token.address, data: "0x95d89b41" }, "latest"]),
      );
      const decimals = Number.parseInt(
        await rpc<string>("eth_call", [{ to: token.address, data: "0x313ce567" }, "latest"]),
        16,
      );

      expect(symbol).toBe(token.symbol);
      expect(decimals).toBe(token.decimals);
    },
  );

  it("SPX6900 has 8 decimals, not 18", async () => {
    // Called out explicitly because it is the single most expensive wrong
    // assumption available in this codebase.
    const decimals = Number.parseInt(
      await rpc<string>("eth_call", [{ to: TOKENS.SPX.address, data: "0x313ce567" }, "latest"]),
      16,
    );
    expect(decimals).toBe(8);
    expect(TOKENS.SPX.decimals).toBe(8);
  });
});
