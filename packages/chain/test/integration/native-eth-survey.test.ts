/**
 * How much would native ETH actually add?
 *
 * This exists because the question is easy to answer wrongly. `docs/UNISWAP-V4.md`
 * said there was "genuine v4 liquidity for SPX, and it is worth having", which
 * was true of the first half and not measured for the second. These assertions
 * are the measurement, pinned so the conclusion cannot rot silently while the
 * roadmap still leans on it.
 *
 * Two findings, and the first is structural rather than empirical:
 *
 *   1. **v2 and v3 have no native-ETH pools, and cannot.** Both factories take
 *      two ERC-20 addresses; every "ETH" pair in them is WETH, and the routers
 *      wrap at the edges. So scanning them for native ETH finds precisely
 *      nothing — there is no pool to find.
 *   2. **v4 does treat native ETH as a currency**, and for SPX that is one
 *      pool holding under a tenth of what the v2 pair holds.
 *
 * Deliberately loose bounds. The fork is long-lived and other suites trade
 * against it, so anything tight would fail for drift rather than for a change
 * in the finding. What must hold is the order of magnitude.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { CONTRACTS, TOKENS, UNI_V4_TIER_SPACING, ZERO_ADDRESS } from "../../src/constants.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const SPX = TOKENS.SPX.address;
const WETH = TOKENS.WETH.address;

let id = 0;
async function ethCall(to: string, data: string): Promise<string | null> {
  const response = await fetch(FORK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const json = (await response.json()) as { result?: string; error?: { message: string } };
  return json.error ? null : (json.result ?? null);
}

const POOL_KEY = [
  { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" },
] as const;

const stateAbi = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const Q96 = 2n ** 96n;
const V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";

/**
 * A v4 pool's in-range virtual reserves, from its liquidity and price.
 *
 * `x = L/sqrtP`, `y = L*sqrtP` — the amounts a full-range position with this
 * liquidity would hold. Concentrated positions hold *less* than that for the
 * same L, so this is an upper bound on the pool's real TVL, which is the safe
 * direction for an argument that the pool is small.
 */
async function v4Reserves(other: string, fee: number, spacing: number) {
  const [c0, c1] = BigInt(other) < BigInt(SPX) ? [other, SPX] : [SPX, other];
  const poolId = keccak256(
    encodeAbiParameters(POOL_KEY, [c0 as `0x${string}`, c1 as `0x${string}`, fee, spacing, ZERO_ADDRESS]),
  );
  const raw = await ethCall(
    CONTRACTS.uniV4StateView,
    encodeFunctionData({ abi: stateAbi, functionName: "getLiquidity", args: [poolId] }),
  );
  if (!raw || raw === "0x") return null;
  const liquidity = decodeFunctionResult({ abi: stateAbi, functionName: "getLiquidity", data: raw as `0x${string}` });
  if (liquidity === 0n) return null;

  const slot0 = await ethCall(
    CONTRACTS.uniV4StateView,
    encodeFunctionData({ abi: stateAbi, functionName: "getSlot0", args: [poolId] }),
  );
  if (!slot0) return null;
  const [sqrtPriceX96] = decodeFunctionResult({ abi: stateAbi, functionName: "getSlot0", data: slot0 as `0x${string}` });
  if (sqrtPriceX96 === 0n) return null;

  const amount0 = (liquidity * Q96) / sqrtPriceX96;
  const amount1 = (liquidity * sqrtPriceX96) / Q96;
  const spxIsCurrency0 = c0.toLowerCase() === SPX;
  return { spx: spxIsCurrency0 ? amount0 : amount1, other: spxIsCurrency0 ? amount1 : amount0 };
}

beforeAll(async () => {
  if ((await ethCall(WETH, "0x")) === null && (await ethCall(SPX, "0x")) === null) {
    throw new Error(`No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.`);
  }
});

describe("native ETH across Uniswap versions", () => {
  it("finds no native-ETH pool in v2 or v3, because there cannot be one", async () => {
    // Both factories are typed on two ERC-20 addresses. Asking for the zero
    // address is not a query that returns nothing interesting — it is not a
    // query the protocol can answer, and both return the zero address.
    for (const fee of Object.keys(UNI_V4_TIER_SPACING).map(Number)) {
      const raw = await ethCall(
        CONTRACTS.uniV3Factory,
        encodeFunctionData({ abi: v3FactoryAbi, functionName: "getPool", args: [SPX, ZERO_ADDRESS, fee] }),
      );
      const pool = raw
        ? decodeFunctionResult({ abi: v3FactoryAbi, functionName: "getPool", data: raw as `0x${string}` })
        : ZERO_ADDRESS;
      expect(pool.toLowerCase()).toBe(ZERO_ADDRESS);
    }

    const pairRaw = await ethCall(
      V2_FACTORY,
      encodeFunctionData({ abi: v2FactoryAbi, functionName: "getPair", args: [SPX, ZERO_ADDRESS] }),
    );
    const pair = pairRaw
      ? decodeFunctionResult({ abi: v2FactoryAbi, functionName: "getPair", data: pairRaw as `0x${string}` })
      : ZERO_ADDRESS;
    expect(pair.toLowerCase()).toBe(ZERO_ADDRESS);
  });

  it("does find a native-ETH v4 pool for SPX", async () => {
    // The premise is real: v4 makes native ETH a first-class currency, and SPX
    // has a pool using it. The next test is about how much that is worth.
    const reserves = await v4Reserves(ZERO_ADDRESS, 10_000, 200);
    expect(reserves).not.toBeNull();
    expect(reserves!.other).toBeGreaterThan(10n ** 18n);
  });

  it("shows that pool holding a small fraction of what the v2 pair holds", async () => {
    /*
     * The number the roadmap turns on. Measured in ETH terms on both sides so
     * no price feed is involved: the comparison is WETH in the v2 pair against
     * native ETH in the v4 pool.
     *
     * Bounded at a tenth rather than at the measured ~0.9% so that ordinary
     * drift, or a genuine doubling of the v4 pool, does not fail the suite —
     * what would fail it is v4 becoming a serious venue for SPX, which is
     * exactly when this conclusion should be revisited.
     */
    const v4 = await v4Reserves(ZERO_ADDRESS, 10_000, 200);
    expect(v4).not.toBeNull();

    const pairRaw = await ethCall(
      V2_FACTORY,
      encodeFunctionData({ abi: v2FactoryAbi, functionName: "getPair", args: [SPX, WETH] }),
    );
    const pair = decodeFunctionResult({ abi: v2FactoryAbi, functionName: "getPair", data: pairRaw as `0x${string}` });
    const balanceRaw = await ethCall(
      WETH,
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [pair] }),
    );
    const v2Weth = BigInt(balanceRaw ?? "0x0");

    expect(v2Weth).toBeGreaterThan(1000n * 10n ** 18n);
    // Upper bound on v4 against a real balance for v2, so the ratio is if
    // anything generous to v4.
    expect(v4!.other * 10n).toBeLessThan(v2Weth);
  });
});
