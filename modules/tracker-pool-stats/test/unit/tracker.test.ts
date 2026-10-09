/**
 * The pool-statistics tracker.
 *
 * The assertions that matter are about the capability model, not the
 * arithmetic: that reserves are read by calling `balanceOf` on a *declared
 * token* rather than on the pool, that a pool holding an undeclared token is
 * reported as unsupported instead of as empty, and that the module is
 * deterministic enough for the parity gate to mean something.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModuleManifestSchema, WirePoolStatsSchema } from "@spdex/core";
import { BrokerSession, CapabilityBroker, NativeRuntime, QuickJSRuntime } from "@spdex/host";
import trackerModule from "../../index.mjs";

const manifest = ModuleManifestSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), "utf8")),
);
const source = readFileSync(fileURLToPath(new URL("../../module.js", import.meta.url)), "utf8");

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"; // not declared

const pool = (poolId: string, token0: string, token1: string, fee = 3000) => ({
  poolId,
  token0,
  token1,
  fee,
  depth: "0",
});

/** Records every target asked for, and answers with a fixed balance. */
class RecordingChain {
  readonly targets: string[] = [];
  constructor(private readonly value: bigint = 1234n) {}
  async multicall(calls: { to: string; data: string }[]): Promise<string[]> {
    for (const call of calls) this.targets.push(call.to.toLowerCase());
    return calls.map(() => `0x${this.value.toString(16).padStart(64, "0")}`);
  }
}

const load = (chain: RecordingChain) =>
  new NativeRuntime().loadTracker(
    { kind: "object", module: trackerModule },
    new CapabilityBroker({ manifest, chain }),
  );

describe("tracker-pool-stats", () => {
  it("reads balances from the tokens, never from the pool", async () => {
    // The whole design in one assertion. A pool address as a *target* could
    // never be allowlisted; as an argument to a declared token's balanceOf it
    // needs no permission at all.
    const chain = new RecordingChain();
    const tracker = await load(chain);
    await tracker.scanPools([pool("0xaaa0000000000000000000000000000000000001", SPX, WETH)], new BrokerSession());

    expect(chain.targets).toEqual([SPX, WETH]);
    expect(chain.targets).not.toContain("0xaaa0000000000000000000000000000000000001");
    tracker.dispose();
  });

  it("returns schema-valid stats carrying the fee through", async () => {
    const tracker = await load(new RecordingChain(5n * 10n ** 18n));
    const [stats] = await tracker.scanPools(
      [pool("0xaaa0000000000000000000000000000000000001", SPX, WETH, 10_000)],
      new BrokerSession(),
    );
    expect(() => WirePoolStatsSchema.parse(stats)).not.toThrow();
    expect(stats!.supported).toBe(true);
    expect(stats!.balance0).toBe((5n * 10n ** 18n).toString());
    expect(stats!.fee).toBe(10_000);
    tracker.dispose();
  });

  it("reports an undeclared token as unsupported rather than as empty", async () => {
    // Zero would be a lie with the same shape as the truth: an empty pool and
    // an unreadable one are different facts, and one of them is a reason not
    // to trade.
    const chain = new RecordingChain();
    const tracker = await load(chain);
    const [stats] = await tracker.scanPools(
      [pool("0xbbb0000000000000000000000000000000000002", DAI, WETH)],
      new BrokerSession(),
    );
    expect(stats!.supported).toBe(false);
    // And it did not even attempt the read, because one denied target fails
    // the entire batch and would cost every other pool its statistics.
    expect(chain.targets).toEqual([]);
    tracker.dispose();
  });

  it("does not let one unreadable pool cost the others their stats", async () => {
    const tracker = await load(new RecordingChain());
    const stats = await tracker.scanPools(
      [
        pool("0xbbb0000000000000000000000000000000000002", DAI, WETH),
        pool("0xaaa0000000000000000000000000000000000001", SPX, WETH),
      ],
      new BrokerSession(),
    );
    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.poolId.startsWith("0xaaa"))!.supported).toBe(true);
    expect(stats.find((s) => s.poolId.startsWith("0xbbb"))!.supported).toBe(false);
    tracker.dispose();
  });

  it("is order-independent, so identical pools give identical bytes", async () => {
    const a = await load(new RecordingChain());
    const b = await load(new RecordingChain());
    const one = pool("0xaaa0000000000000000000000000000000000001", SPX, WETH);
    const two = pool("0xccc0000000000000000000000000000000000003", WETH, SPX, 500);

    const forward = await a.scanPools([one, two], new BrokerSession());
    const reverse = await b.scanPools([two, one], new BrokerSession());
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    a.dispose();
    b.dispose();
  });

  it("produces byte-identical output in the sandbox", async () => {
    const native = await load(new RecordingChain());
    const sandboxed = await new QuickJSRuntime().loadTracker(
      { kind: "code", code: source },
      new CapabilityBroker({ manifest, chain: new RecordingChain() }),
    );
    const pools = [
      pool("0xaaa0000000000000000000000000000000000001", SPX, WETH),
      pool("0xbbb0000000000000000000000000000000000002", DAI, WETH),
    ];
    const x = await native.scanPools(pools, new BrokerSession());
    const y = await sandboxed.scanPools(pools, new BrokerSession());
    expect(JSON.stringify(y)).toBe(JSON.stringify(x));
    native.dispose();
    sandboxed.dispose();
  });

  it("declares exactly the tokens its code knows about", async () => {
    // The module has to filter before calling, so its KNOWN_TOKENS list and the
    // manifest's `contracts` are two copies of one fact. If they drift, the
    // broker denies a call and a whole batch fails.
    for (const token of [SPX, WETH, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]) {
      expect(manifest.contracts).toContain(token);
    }
    expect(manifest.contracts).toHaveLength(3);
    expect(source).toContain(SPX);
    expect(source).toContain(WETH);
  });

  it("is refused by the venue and registry loaders", async () => {
    const broker = () => new CapabilityBroker({ manifest, chain: new RecordingChain() });
    await expect(
      new NativeRuntime().load({ kind: "object", module: trackerModule }, broker()),
    ).rejects.toThrow(/VenueModule/);
    await expect(
      new NativeRuntime().loadRegistry({ kind: "object", module: trackerModule }, broker()),
    ).rejects.toThrow(/RegistryModule/);
  });
});
