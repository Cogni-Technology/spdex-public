/**
 * A pinned simulation on a real node.
 *
 * The second opinion compares two services' test-runs of one request, which
 * means something only if each runs exactly what it was asked to: on the base
 * block named by hash, with the next block's header as given, and each call
 * at the gas given. The unit tests pin what `EthSimulateV1Provider` sends;
 * this asks the fork whether it does what was sent, by reading the block's
 * fields from inside the simulated block, and whether two host names for the
 * same fork answer identically.
 *
 * Nothing here changes the fork: a simulation is a read. The account is a
 * fresh address, funded only inside the simulation by a state override.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, TOKENS } from "../../src/constants.js";
import { httpRpc, type JsonRpc } from "../../src/reader.js";
import {
  EthSimulateV1Provider,
  type SimulationBlock,
  type SimulationOutcome,
  type SimulationRequest,
} from "../../src/simulation.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
/** The same fork under another host name: two "services" that must agree. */
const SAME_FORK_URL = FORK_URL.replace("127.0.0.1", "localhost");

/** A fresh address, never used on the fork; funded only by a state override. */
const ACCOUNT: Address = "0x5ec0d0b1ce0000000000000000000000000b2b2b";
const RECIPIENT: Address = "0x5ec0d0b1ce0000000000000000000000000c3c3c";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ETHER = 10n ** 18n;
/** `traceTransfers` reports an ether movement as a Transfer log from this address. */
const PSEUDO_LOG_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const MULTICALL3_ABI = parseAbi([
  "function getBlockNumber() view returns (uint256)",
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function getCurrentBlockGasLimit() view returns (uint256)",
  "function getCurrentBlockCoinbase() view returns (address)",
  "function getBasefee() view returns (uint256)",
  "function getCurrentBlockDifficulty() view returns (uint256)",
  "function getBlockHash(uint256 blockNumber) view returns (bytes32)",
]);
const WETH_ABI = parseAbi(["function deposit() payable"]);

const rpc = httpRpc(FORK_URL);

interface Header {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  gasLimit: bigint;
}

async function latestHeader(read: JsonRpc): Promise<Header> {
  const block = (await read("eth_getBlockByNumber", ["latest", false])) as {
    number: Hex;
    hash: Hex;
    timestamp: Hex;
    gasLimit: Hex;
  };
  return {
    number: BigInt(block.number),
    hash: block.hash,
    timestamp: BigInt(block.timestamp),
    gasLimit: BigInt(block.gasLimit),
  };
}

/** The pin the second opinion uses: B's hash, and B + 1's header fixed from B's. */
function pinAt(header: Header): SimulationBlock {
  return {
    baseHash: header.hash,
    overrides: {
      number: header.number + 1n,
      time: header.timestamp + 12n,
      gasLimit: header.gasLimit,
      feeRecipient: ZERO_ADDRESS,
      prevRandao: ZERO32,
      baseFeePerGas: 0n,
    },
  };
}

/** A provider over `url` that also keeps each raw `eth_simulateV1` answer, for the return data it drops. */
function capturing(url: string): { provider: EthSimulateV1Provider; answers: unknown[] } {
  const inner = httpRpc(url);
  const answers: unknown[] = [];
  const provider = new EthSimulateV1Provider(async (method, params) => {
    const answer = await inner(method, params);
    if (method === "eth_simulateV1") answers.push(answer);
    return answer;
  });
  return { provider, answers };
}

function returnData(answer: unknown): Hex[] {
  const calls = (answer as { calls?: { returnData?: Hex }[] }[])[0]?.calls ?? [];
  return calls.map((call) => call.returnData ?? "0x");
}

const funded = { [ACCOUNT]: { balance: ETHER } } as Record<Address, { balance?: bigint }>;

/** One wei to a fresh address, then one wei wrapped: an ether movement and a token log. */
function transferAndWrap(gas?: bigint): SimulationRequest {
  return {
    chainId: 0,
    account: ACCOUNT,
    calls: [
      { to: RECIPIENT, data: "0x", value: 1n },
      { to: TOKENS.WETH.address, data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value: 1n },
    ],
    stateOverrides: funded,
    ...(gas === undefined ? {} : { gas }),
  };
}

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

describe("a pinned simulation on the fork", () => {
  it("runs on top of the named block, in a block whose every header field is the one given", async () => {
    const header = await latestHeader(rpc);
    const block = pinAt(header);
    const { provider, answers } = capturing(FORK_URL);
    const read = (functionName: (typeof MULTICALL3_ABI)[number]["name"], args: readonly unknown[] = []) => ({
      to: CONTRACTS.multicall3 as Address,
      data: encodeFunctionData({ abi: MULTICALL3_ABI, functionName, args } as never),
      value: 0n,
    });

    const outcome = await provider.simulate({
      chainId: 0,
      account: ACCOUNT,
      calls: [
        read("getBlockNumber"),
        read("getCurrentBlockTimestamp"),
        read("getCurrentBlockGasLimit"),
        read("getCurrentBlockCoinbase"),
        read("getBasefee"),
        read("getCurrentBlockDifficulty"),
        read("getBlockHash", [header.number]),
      ],
      block,
    });
    expect(outcome.status).toBe("success");

    const [number, time, gasLimit, coinbase, basefee, randao, parentHash] = returnData(answers.at(-1));
    const decode = (functionName: (typeof MULTICALL3_ABI)[number]["name"], data: Hex | undefined) =>
      decodeFunctionResult({ abi: MULTICALL3_ABI, functionName, data: data! } as never) as unknown;
    expect(decode("getBlockNumber", number)).toBe(header.number + 1n);
    expect(decode("getCurrentBlockTimestamp", time)).toBe(header.timestamp + 12n);
    expect(decode("getCurrentBlockGasLimit", gasLimit)).toBe(header.gasLimit);
    expect(String(decode("getCurrentBlockCoinbase", coinbase)).toLowerCase()).toBe(ZERO_ADDRESS);
    expect(decode("getBasefee", basefee)).toBe(0n);
    expect(decode("getCurrentBlockDifficulty", randao)).toBe(0n);
    // The base is the block named, not whatever "latest" became meanwhile.
    expect(decode("getBlockHash", parentHash)).toBe(header.hash);
  });

  it("gives each call the request's gas: short of it a wrap runs out and reverts, with room it goes through", async () => {
    const provider = new EthSimulateV1Provider(rpc);
    const block = pinAt(await latestHeader(rpc));

    // Enough for a plain transfer (21,000) but not for a wrap's storage writes.
    const short = await provider.simulate({ ...transferAndWrap(30_000n), block });
    expect(short.status).toBe("reverted");

    const roomy = await provider.simulate({ ...transferAndWrap(100_000n), block });
    expect(roomy.status).toBe("success");
    expect(roomy.logs.some((log) => log.address === TOKENS.WETH.address)).toBe(true);
  });

  it("answers byte-identically on two host names for the same fork, pseudo-logs included", async () => {
    const block = pinAt(await latestHeader(rpc));
    const request = { ...transferAndWrap(100_000n), block };
    const [first, second]: [SimulationOutcome, SimulationOutcome] = await Promise.all([
      new EthSimulateV1Provider(httpRpc(FORK_URL)).simulate(request),
      new EthSimulateV1Provider(httpRpc(SAME_FORK_URL)).simulate(request),
    ]);
    expect(first.status).toBe("success");
    expect(second).toEqual(first);
    // The ether movement is there as a log, which is what two services' net
    // ether per account is compared from.
    expect(first.logs.filter((log) => log.address === PSEUDO_LOG_ADDRESS).length).toBeGreaterThanOrEqual(2);
  });

  it("is an error, never an answer about some other state, for a base block the node doesn't have", async () => {
    const header = await latestHeader(rpc);
    const unknown: SimulationBlock = { ...pinAt(header), baseHash: `0x${"5e".repeat(32)}` as Hex };
    await expect(new EthSimulateV1Provider(rpc).simulate({ ...transferAndWrap(100_000n), block: unknown })).rejects.toThrow();
  });
});
