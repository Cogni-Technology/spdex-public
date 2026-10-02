/**
 * The tip spDEX bids and suggests: what recent blocks took, kept between a
 * floor (an endpoint may say 1 wei) and a ceiling (an endpoint may say
 * anything, and a tip is paid in full).
 */

import { describe, expect, it } from "vitest";
import { FEE_LEVEL_BLOCKS, MAX_TIP, MIN_TIP, TIP_BLOCKS, readFeeLevel, readWalletFees, suggestedTip } from "./fees.js";

const GWEI = 1_000_000_000n;
const hex = (n: bigint) => `0x${n.toString(16)}`;

/** An endpoint whose last blocks' middle tips were `tips`, and whose latest base fee is `base` (null: no base fee). */
function endpoint(tips: bigint[] | Error, base: bigint | null = GWEI / 10n, gasPrice = 3n * GWEI) {
  const asked: { method: string; params: unknown[] }[] = [];
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    asked.push({ method, params });
    if (method === "eth_feeHistory") {
      if (tips instanceof Error) throw tips;
      return { baseFeePerGas: [], reward: tips.map((t) => [hex(t)]) };
    }
    if (method === "eth_getBlockByNumber") return base === null ? { number: "0x1" } : { baseFeePerGas: hex(base) };
    if (method === "eth_gasPrice") return hex(gasPrice);
    throw new Error(`unexpected ${method}`);
  };
  return { read, asked };
}

describe("suggestedTip", () => {
  it("is the median of the last blocks' middle tips, asked for once", async () => {
    const { read, asked } = endpoint([GWEI / 5n, GWEI / 10n, GWEI / 4n, GWEI / 8n, GWEI / 5n]);
    expect(await suggestedTip(read)).toBe(GWEI / 5n);
    expect(asked).toEqual([{ method: "eth_feeHistory", params: [hex(BigInt(TIP_BLOCKS)), "latest", [50]] }]);
  });

  it("never bids less than the floor: blocks of empty tips, or an endpoint that says 1 wei", async () => {
    expect(await suggestedTip(endpoint([0n, 1n, 0n]).read)).toBe(MIN_TIP);
    expect(await suggestedTip(endpoint([]).read)).toBe(MIN_TIP);
  });

  it("never more than the ceiling, whatever the endpoint says blocks took", async () => {
    expect(await suggestedTip(endpoint([50n * GWEI, 80n * GWEI, 99n * GWEI]).read)).toBe(MAX_TIP);
  });

  it("is the floor when the endpoint can't say, or says something unreadable", async () => {
    expect(await suggestedTip(endpoint(new Error("method not found")).read)).toBe(MIN_TIP);
    const garbled = async (method: string) => (method === "eth_feeHistory" ? { reward: [["lots"]] } : null);
    expect(await suggestedTip(garbled)).toBe(MIN_TIP);
  });
});

describe("readWalletFees", () => {
  it("bids twice the base fee and the tip as the most per gas, and the tip", async () => {
    const fees = await readWalletFees(endpoint([GWEI / 20n, GWEI / 5n, GWEI / 5n]).read);
    expect(fees).toEqual({ type: "eip1559", maxFeePerGas: 2n * (GWEI / 10n) + GWEI / 5n, maxPriorityFeePerGas: GWEI / 5n });
  });

  it("is the endpoint's gas price on a chain with no base fee", async () => {
    expect(await readWalletFees(endpoint([GWEI], null, 7n * GWEI).read)).toEqual({ type: "legacy", gasPrice: 7n * GWEI });
  });
});

describe("readFeeLevel", () => {
  const history = (baseFees: bigint[] | Error) => async (method: string, params: unknown[]): Promise<unknown> => {
    expect(method).toBe("eth_feeHistory");
    expect(params).toEqual([hex(BigInt(FEE_LEVEL_BLOCKS)), "latest", []]);
    if (baseFees instanceof Error) throw baseFees;
    return { baseFeePerGas: baseFees.map(hex), reward: [] };
  };

  it("is the next block's base fee, and the median of the blocks before it", async () => {
    // The last entry of a fee history is the next block's.
    expect(await readFeeLevel(history([GWEI, 3n * GWEI, 2n * GWEI, 9n * GWEI]))).toEqual({ base: 9n * GWEI, usual: 2n * GWEI });
  });

  it("is unknown, never a figure, when the endpoint can't say", async () => {
    expect(await readFeeLevel(history(new Error("method not found")))).toBeNull();
    expect(await readFeeLevel(history([GWEI]))).toBeNull();
    expect(await readFeeLevel(async () => ({ baseFeePerGas: ["lots", "0x1"] }))).toBeNull();
  });
});
