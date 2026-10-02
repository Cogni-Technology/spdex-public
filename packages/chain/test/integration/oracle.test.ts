/**
 * The TWAP oracle, against real Uniswap v3 state at the pinned block.
 *
 * The unit tests prove TickMath is arithmetically right. They cannot prove the
 * calldata is right, that the return value is decoded at the correct offsets,
 * or — the failure this suite exists for — that token ordering and raw-unit
 * conventions line up with what the Guard compares against.
 *
 * That last one is the dangerous one. A decimal correction applied here that
 * the Guard does not expect is a factor of 1e12 on a WETH/USDC pair, and the
 * resulting number is still a plausible-looking integer. The band assertions
 * below exist specifically to catch a mistake of that shape, which is why they
 * are stated as "an ether costs between $100 and $100,000" rather than pinned
 * to a price that would need updating every time the block moves.
 *
 * Requires a running fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import { NATIVE_TOKEN, TOKENS } from "../../src/constants.js";
import { httpRpc, Multicall3Reader, type JsonRpc } from "../../src/reader.js";
import { UniswapV3TwapOracle, priceX18AtTick } from "../../src/oracle.js";

const FORK_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const WAD = 10n ** 18n;

const rpc = httpRpc(FORK_URL);
const oracle = new UniswapV3TwapOracle(new Multicall3Reader(rpc));

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

describe("UniswapV3TwapOracle", () => {
  it("prices WETH in USDC within a sane band", async () => {
    const ratio = await oracle.priceRatio(TOKENS.WETH.address, TOKENS.USDC.address);
    expect(ratio).not.toBeNull();

    // ratio is USDC-raw per WETH-raw, scaled 1e18. Converting to the human
    // price: (raw ratio) * 1e18 / 1e6 = price * 1e6.
    const usdPerEth = Number(ratio!) / 1e6;
    expect(usdPerEth).toBeGreaterThan(100);
    expect(usdPerEth).toBeLessThan(100_000);
  });

  it("is reciprocal under reversed token order", async () => {
    // Token0/token1 ordering is by address and has nothing to do with which
    // side the user is selling. Getting the inversion wrong would produce a
    // number that is wrong by the square of the price and still non-null.
    const forward = await oracle.priceRatio(TOKENS.WETH.address, TOKENS.USDC.address);
    const reverse = await oracle.priceRatio(TOKENS.USDC.address, TOKENS.WETH.address);
    expect(forward).not.toBeNull();
    expect(reverse).not.toBeNull();

    const product = (forward! * reverse!) / WAD;
    const drift = product > WAD ? product - WAD : WAD - product;
    // Both directions round; a hair of drift is expected, a factor is not.
    expect(Number(drift) / Number(WAD)).toBeLessThan(0.0001);
  });

  it("prices SPX against WETH, the pair the app exists for", async () => {
    const ratio = await oracle.priceRatio(TOKENS.WETH.address, TOKENS.SPX.address);
    // Null is a legitimate answer if no v3 pool carries enough observation
    // history — the Guard treats it as "no opinion" — but it must never throw,
    // and it must never be zero or negative.
    if (ratio !== null) expect(ratio).toBeGreaterThan(0n);
  });

  it("prices native ether as WETH, rather than having no opinion", async () => {
    // The swap path names ether 0xeeee…eeee, which no v3 pool is keyed on. The
    // oracle used to pass it to the factory as-is, get "no pool" back, and so
    // leave every ether sale without a price check. Against real pools the
    // two must now be the same number, and a number rather than null.
    const native = await oracle.priceRatio(NATIVE_TOKEN, TOKENS.USDC.address);
    const wrapped = await oracle.priceRatio(TOKENS.WETH.address, TOKENS.USDC.address);
    expect(wrapped).not.toBeNull();
    expect(native).toBe(wrapped);
    // And for the pair a recurring buy defaults to, both ways round.
    await expect(oracle.priceRatio(NATIVE_TOKEN, TOKENS.SPX.address)).resolves.toBe(
      await oracle.priceRatio(TOKENS.WETH.address, TOKENS.SPX.address),
    );
    await expect(oracle.priceRatio(TOKENS.SPX.address, NATIVE_TOKEN)).resolves.toBe(
      await oracle.priceRatio(TOKENS.SPX.address, TOKENS.WETH.address),
    );
  });

  it("has no opinion about a pair with no v3 market", async () => {
    // A contract that exists but has no pool with WETH. The oracle must return
    // null rather than throwing: the Guard runs this in front of the swap
    // button, and an exception there would block a swap the oracle is not even
    // allowed to block.
    const multicall3 = "0xca11bde05977b3631167028862be2a173976ca11" as const;
    await expect(oracle.priceRatio(TOKENS.WETH.address, multicall3)).resolves.toBeNull();
  });

  it("has no opinion about a token against itself", async () => {
    await expect(oracle.priceRatio(TOKENS.WETH.address, TOKENS.WETH.address)).resolves.toBeNull();
  });

  it("returns null rather than throwing when the endpoint is unreachable", async () => {
    const broken = new UniswapV3TwapOracle(
      new Multicall3Reader(httpRpc("http://127.0.0.1:1")),
    );
    await expect(
      broken.priceRatio(TOKENS.WETH.address, TOKENS.USDC.address),
    ).resolves.toBeNull();
  });
});

describe("which pool SPX is priced from", () => {
  // SPX's three v3 pools against WETH, and its v2 pair. At the pinned block
  // the 0.05% pool keeps one observation and holds nothing in range, and the
  // 1% pool keeps 51 and holds a few millionths of an ether of depth: both
  // "averages" are whatever price their last trade left.
  const SPX_005: Address = "0xe60fba68aa34040a1da64cc661d06920853c16cf";
  const SPX_03: Address = "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3";
  const SPX_1: Address = "0x00ed26e794b949e18b142f9108429b74ce08ac99";
  const SPX_PAIR: Address = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";
  const WETH = TOKENS.WETH.address;
  const SPX = TOKENS.SPX.address;

  it("reads the 0.3% pool, checked against the v2 pair, and refuses the 0.05% and 1% pools", async () => {
    const market = (await oracle.market(SPX))!;
    expect(market.reference).toBe(SPX_PAIR);
    expect(market.chosen?.pool).toBe(SPX_03);
    expect(market.chosen?.agrees).toBe(true);

    const byPool = new Map(market.pools.map((pool) => [pool.pool, pool]));
    expect(byPool.get(SPX_005)?.refused).toBe("history");
    expect(byPool.get(SPX_1)?.refused).toBe("history");
    // Both would fail the depth test too: neither held even one WETH of depth
    // across the window, against a floor of ten.
    for (const pool of [SPX_005, SPX_1]) expect(byPool.get(pool)!.depth!).toBeLessThan(10n ** 18n);
  });

  it("has no opinion, rather than read the 0.05% or 1% pool, when either is all there is", async () => {
    for (const fee of [500, 10_000]) {
      const only = new UniswapV3TwapOracle(new Multicall3Reader(rpc), { feeTiers: [fee] });
      await expect(only.priceRatio(WETH, SPX)).resolves.toBeNull();
    }
  });

  it("does not choose them even when each is made deepest, with history to spare", async () => {
    // The attack the old rule fell to, played out in state overrides on the
    // eth_call alone, so the shared fork is not touched. Each pool gets far
    // more liquidity in range than SPX's own pool and 200 observations. The
    // last trade in either was long before the window, so Uniswap extrapolates
    // the window from the liquidity in range now: exactly what someone who
    // added a narrow position ten minutes ago, and was left alone, would get.
    const inflated = 10n ** 20n;
    const overrides: Record<string, { stateDiff: Record<Hex, Hex> }> = {};
    for (const pool of [SPX_005, SPX_1]) {
      const slot0 = BigInt((await rpc("eth_getStorageAt", [pool, "0x0", "latest"])) as string);
      // slot0 packs observationCardinality at bits 200–215 and
      // observationCardinalityNext at bits 216–231.
      const cleared = slot0 & ~(((1n << 32n) - 1n) << 200n);
      const withHistory = cleared | (200n << 200n) | (200n << 216n);
      overrides[pool] = { stateDiff: { [slotKey(0n)]: word(withHistory), [slotKey(4n)]: word(inflated) } };
    }
    const overridden: JsonRpc = (method, params) =>
      rpc(method, method === "eth_call" ? [...params, overrides] : params);
    const reader = new Multicall3Reader(overridden);

    // Under the rule this replaced — most liquidity in range right now, among
    // pools whose observe answers — one of these two would now be chosen.
    const [liquidity005, liquidity03, liquidity1] = (
      await reader.multicall([SPX_005, SPX_03, SPX_1].map((to) => ({ to: to as Address, data: "0x1a686502" as Hex })))
    ).map((data) => BigInt(data));
    expect(liquidity005).toBe(inflated);
    expect(liquidity1).toBe(inflated);
    expect(liquidity03!).toBeLessThan(inflated);

    const market = (await new UniswapV3TwapOracle(reader).market(SPX))!;
    const byPool = new Map(market.pools.map((pool) => [pool.pool, pool]));
    // They now pass the history and depth tests, and are deeper than the 0.3%
    // pool by thousands of times; what they fail is agreeing with the pair.
    for (const pool of [SPX_005, SPX_1]) {
      expect(byPool.get(pool)).toMatchObject({ observations: 200, refused: null, agrees: false });
      expect(byPool.get(pool)!.depth!).toBeGreaterThan(byPool.get(SPX_03)!.depth! * 1_000n);
    }
    // This rests on the fork's SPX pair and 0.3% pool still agreeing. If an
    // earlier suite traded one far from the other, restart the fork.
    expect(byPool.get(SPX_03)?.agrees, "the fork's SPX pair and 0.3% pool have drifted apart").toBe(true);
    expect(market.chosen?.pool).toBe(SPX_03);
  });

  it("prices SPX in dollars through WETH, not from a USDC pool that keeps one observation", async () => {
    const [spx, usdc] = await Promise.all([oracle.market(SPX), oracle.market(TOKENS.USDC.address)]);
    const spxTick = spx!.chosen!.meanTick!;
    const usdcTick = usdc!.chosen!.meanTick!;
    // SPX sorts above WETH and USDC below it: WETH per SPX is 1.0001^-spxTick,
    // USDC per WETH is 1.0001^-usdcTick, and the legs' ticks add.
    const ratio = await oracle.priceRatio(SPX, TOKENS.USDC.address);
    expect(ratio).toBe(priceX18AtTick(-spxTick - usdcTick));
    // Raw USDC per raw SPX, 1e18-scaled: times 1e8/1e6 for dollars per SPX.
    const usdPerSpx = (Number(ratio!) / 1e18) * 100;
    expect(usdPerSpx).toBeGreaterThan(0.01);
    expect(usdPerSpx).toBeLessThan(100);
  });
});

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const slotKey = word;
