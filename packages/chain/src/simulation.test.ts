/**
 * What `EthSimulateV1Provider` asks the endpoint, with and without a pinned
 * block and gas.
 *
 * The second opinion runs one request on two services and compares
 * the answers, which means only if both ran exactly the same thing: the same
 * base block, the same header for the block being simulated, the same gas.
 * These tests pin how `SimulationRequest.block` and `.gas` reach the wire,
 * and that a request without them is sent exactly as before.
 */

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "@spdex/core";
import {
  EthSimulateV1Provider,
  isMethodMissing,
  probeSimulateV1,
  type SimulationBlock,
  type SimulationRequest,
} from "./simulation.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const BASE_HASH = `0x${"ab".repeat(32)}` as Hex;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

const REQUEST: SimulationRequest = {
  chainId: 1,
  account: ACCOUNT,
  calls: [
    { to: TARGET, data: "0x", value: 1n },
    { to: TARGET, data: "0xdeadbeef", value: 0n },
  ],
};

const BLOCK: SimulationBlock = {
  baseHash: BASE_HASH,
  overrides: {
    number: 26_000_001n,
    time: 1_790_000_012n,
    gasLimit: 60_000_000n,
    feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
    prevRandao: ZERO32,
    baseFeePerGas: 0n,
  },
};

/** A provider over a scripted endpoint that records every request. */
function scripted(answer: unknown = [{ calls: [] }]) {
  const sent: { method: string; params: unknown[] }[] = [];
  const provider = new EthSimulateV1Provider(async (method, params) => {
    sent.push({ method, params });
    // The probe's answer is ignored; only its not throwing matters.
    return answer;
  });
  return { provider, sent };
}

describe("EthSimulateV1Provider without a pinned block", () => {
  it("sends exactly what it always has: latest, no header, no per-call gas", async () => {
    const { provider, sent } = scripted();
    await provider.simulate(REQUEST);

    const simulate = sent.at(-1)!;
    expect(simulate.method).toBe("eth_simulateV1");
    expect(simulate.params).toEqual([
      {
        blockStateCalls: [
          {
            calls: [
              { from: ACCOUNT, to: TARGET, data: "0x", value: "0x1" },
              { from: ACCOUNT, to: TARGET, data: "0xdeadbeef", value: "0x0" },
            ],
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      "latest",
    ]);
  });
});

describe("EthSimulateV1Provider with a pinned block and gas", () => {
  it("runs on the base block by hash, with every header field pinned", async () => {
    const { provider, sent } = scripted();
    await provider.simulate({ ...REQUEST, block: BLOCK });

    const [body, blockTag] = sent.at(-1)!.params as [{ blockStateCalls: Record<string, unknown>[] }, unknown];
    expect(blockTag).toEqual({ blockHash: BASE_HASH });
    expect(body.blockStateCalls[0]!["blockOverrides"]).toEqual({
      number: "0x18cba81",
      time: "0x6ab13b8c",
      gasLimit: "0x3938700",
      feeRecipient: "0x0000000000000000000000000000000000000000",
      prevRandao: ZERO32,
      baseFeePerGas: "0x0",
    });
    // No gas asked for, none sent.
    for (const call of body.blockStateCalls[0]!["calls"] as Record<string, unknown>[]) {
      expect(call).not.toHaveProperty("gas");
    }
  });

  it("gives every call the request's gas", async () => {
    const { provider, sent } = scripted();
    await provider.simulate({ ...REQUEST, gas: 3_060_000n });

    const [body, blockTag] = sent.at(-1)!.params as [{ blockStateCalls: Record<string, unknown>[] }, unknown];
    expect(blockTag).toBe("latest");
    expect(body.blockStateCalls[0]).not.toHaveProperty("blockOverrides");
    const calls = body.blockStateCalls[0]!["calls"] as Record<string, unknown>[];
    expect(calls.map((call) => call["gas"])).toEqual(["0x2eb120", "0x2eb120"]);
  });

  it("lowercases the hex it pins, so two services are sent identical bytes", async () => {
    const { provider, sent } = scripted();
    const upper = `0x${"AB".repeat(32)}` as Hex;
    await provider.simulate({
      ...REQUEST,
      block: {
        baseHash: upper,
        overrides: { ...BLOCK.overrides, prevRandao: upper, feeRecipient: `0x${"CD".repeat(20)}` as Address },
      },
    });
    const [body, blockTag] = sent.at(-1)!.params as [{ blockStateCalls: Record<string, unknown>[] }, unknown];
    expect(blockTag).toEqual({ blockHash: BASE_HASH });
    const overrides = body.blockStateCalls[0]!["blockOverrides"] as Record<string, string>;
    expect(overrides["prevRandao"]).toBe(BASE_HASH);
    expect(overrides["feeRecipient"]).toBe(`0x${"cd".repeat(20)}`);
  });

  it("refuses a malformed pin before anything is sent", async () => {
    const cases: SimulationRequest[] = [
      { ...REQUEST, gas: 0n },
      { ...REQUEST, gas: -1n },
      { ...REQUEST, block: { ...BLOCK, baseHash: "0x1234" as Hex } },
      { ...REQUEST, block: { ...BLOCK, overrides: { ...BLOCK.overrides, prevRandao: "0x00" as Hex } } },
      { ...REQUEST, block: { ...BLOCK, overrides: { ...BLOCK.overrides, feeRecipient: "0x0" as Address } } },
      { ...REQUEST, block: { ...BLOCK, overrides: { ...BLOCK.overrides, time: -1n } } },
    ];
    for (const request of cases) {
      const { provider, sent } = scripted();
      await expect(provider.simulate(request)).rejects.toBeInstanceOf(RangeError);
      expect(sent).toEqual([]);
    }
  });

  it("reads the answer as before: a reverting call reverts the plan", async () => {
    const { provider } = scripted([
      {
        calls: [
          { status: "0x1", gasUsed: "0x5208", logs: [] },
          { status: "0x0", gasUsed: "0x100", error: { message: "execution reverted: TooSoon" }, logs: [] },
        ],
      },
    ]);
    const outcome = await provider.simulate({ ...REQUEST, block: BLOCK, gas: 1_000_000n });
    expect(outcome).toEqual({
      status: "reverted",
      revertReason: "execution reverted: TooSoon",
      gasUsed: 0x5308n,
      logs: [],
    });
    // A single service never claims a second opinion.
    expect(outcome).not.toHaveProperty("secondOpinion");
  });
});

describe("EthSimulateV1Provider's return data", () => {
  it("keeps the reverting call's revert data, from the error where geth puts it", async () => {
    const { provider } = scripted([
      { calls: [{ status: "0x0", gasUsed: "0x100", returnData: "0x", error: { message: "execution reverted", data: "0x2AAE24C2" }, logs: [] }] },
    ]);
    const outcome = await provider.simulate(REQUEST);
    expect(outcome.status).toBe("reverted");
    expect(outcome.returnData).toBe("0x2aae24c2");
  });

  it("keeps the reverting call's revert data from returnData, where anvil puts it", async () => {
    const { provider } = scripted([
      { calls: [{ status: "0x0", gasUsed: "0x100", returnData: "0x2aae24c2", error: { message: "execution failed" }, logs: [] }] },
    ]);
    expect((await provider.simulate(REQUEST)).returnData).toBe("0x2aae24c2");
  });

  it("keeps the last call's return data on success, and leaves it out when there is none or it isn't hex bytes", async () => {
    const answered = scripted([{ calls: [{ status: "0x1", gasUsed: "0x1", logs: [], returnData: "0x01" }, { status: "0x1", gasUsed: "0x1", logs: [], returnData: "0xABCD" }] }]);
    expect((await answered.provider.simulate(REQUEST)).returnData).toBe("0xabcd");
    const silent = scripted([{ calls: [{ status: "0x1", gasUsed: "0x1", logs: [] }] }]);
    expect(await silent.provider.simulate(REQUEST)).not.toHaveProperty("returnData");
    const odd = scripted([{ calls: [{ status: "0x1", gasUsed: "0x1", logs: [], returnData: "0xabc" }] }]);
    expect(await odd.provider.simulate(REQUEST)).not.toHaveProperty("returnData");
  });
});

describe("isMethodMissing and probeSimulateV1", () => {
  const answered = (message: string, code?: number) => Object.assign(new Error(`eth_simulateV1: ${message}`), code === undefined ? {} : { code });

  it("reads 'no such method' from the code or the wording endpoints use, and nothing else", () => {
    expect(isMethodMissing(answered("whatever", -32601))).toBe(true);
    expect(isMethodMissing(answered("the method eth_simulateV1 does not exist/is not available"))).toBe(true);
    expect(isMethodMissing(answered("Method not found"))).toBe(true);
    expect(isMethodMissing(answered("Unsupported method: eth_simulateV1"))).toBe(true);
    // A rate limit or a dropped connection says nothing about the method.
    expect(isMethodMissing(answered("rate limited", 429))).toBe(false);
    expect(isMethodMissing(new Error("fetch failed"))).toBe(false);
    expect(isMethodMissing(new Error("eth_blockNumber: Method not found"))).toBe(false);
  });

  it("answers true, false or unknown", async () => {
    expect(await probeSimulateV1(async () => [])).toBe(true);
    expect(
      await probeSimulateV1(async () => {
        throw answered("Method not found");
      }),
    ).toBe(false);
    expect(
      await probeSimulateV1(async () => {
        throw new Error("fetch failed");
      }),
    ).toBe("unknown");
  });
});
