/**
 * The second opinion on the local fork: two real services, the same fork
 * under two host names, agree on a real ETH → SPX swap at a pinned block, and
 * a service that lies about it — a proxy in this process that rewrites the
 * fork's answers — is refused.
 *
 * The red-team suite scripts both services and proves the Guard's verdicts;
 * this proves the other half: that a real node, asked the pinned request the
 * second opinion builds, answers it identically under two host names, so an
 * honest pair agrees; and that one changed event, or a head moved, is caught.
 *
 * Nothing here changes the fork but one fresh account's balance: every swap
 * is only simulated. Its clock is never touched.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex, SwapIntent, TxPlan } from "@spdex/core";
import { CONTRACTS, EthSimulateV1Provider, NATIVE_TOKEN, TOKENS, TOPICS, addressOfKey, generateSpendingKey, httpRpc, type JsonRpc } from "@spdex/chain";
import { MAINNET_DEPLOYMENT } from "@spdex/vault";
import { honestManifest } from "@spdex/testing";
import { Guard, type GuardInput } from "../../src/guard.js";
import { SecondOpinionPair, secondOpinionHost } from "../../src/second-opinion.js";
import { passThrough, startProxy, type Proxy, type Rewrite } from "./proxy.js";

/** The environment, read without Node's types, which this package does not carry. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const FORK_URL = env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
/** The same fork under another host name: a second service that must agree. */
const SAME_FORK_URL = FORK_URL.includes("127.0.0.1") ? FORK_URL.replace("127.0.0.1", "localhost") : FORK_URL.replace("localhost", "127.0.0.1");
const CHAIN_ID = Number(env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const AMOUNT = ETHER / 100n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const word = (v: bigint | string): string => (typeof v === "bigint" ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, "0");

let account: Address;
let input: GuardInput;
const proxies: Proxy[] = [];

afterEach(async () => {
  while (proxies.length > 0) await proxies.pop()!.close();
});

/** SwapRouter02's `exactInputSingle`: WETH → SPX through the market's v3 pool, paid with ether. */
function swapCall(recipient: Address, fee: bigint): Hex {
  // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  const selector = "0x04e45aaf";
  return `${selector}${word(TOKENS.WETH.address)}${word(TOKENS.SPX.address)}${word(fee)}${word(recipient)}${word(AMOUNT)}${word(1n)}${word(0n)}` as Hex;
}

beforeAll(async () => {
  expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
  // A fresh account, given a balance: the Guard simulates from it, with no state override.
  account = addressOfKey(generateSpendingKey());
  expect(await rpc("eth_getCode", [account, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [account, hex(ETHER)]);

  const pool = MAINNET_DEPLOYMENT.markets[0].oraclePool;
  const fee = BigInt((await rpc("eth_call", [{ to: pool, data: "0xddca3f43" }, "latest"])) as string);
  const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  const intent: SwapIntent = {
    version: 1,
    chainId: CHAIN_ID,
    account,
    recipient: account,
    tokenIn: NATIVE_TOKEN,
    tokenOut: TOKENS.SPX.address,
    maxAmountIn: AMOUNT,
    minAmountOut: 1n,
    deadline: BigInt(latest.timestamp) + 3_600n,
    nonce: "0x5ec0d0b1",
  };
  const plan: TxPlan = {
    version: 1,
    intent,
    approvals: [],
    calls: [{ to: CONTRACTS.uniV3SwapRouter02, data: swapCall(account, fee), value: AMOUNT }],
    meta: { venueId: "venue-uniswap-v3", poolIds: [pool], quotedAmountOut: 1n, gasEstimate: 200_000n },
  };
  input = { plan, expectedIntent: intent, manifest: honestManifest(), extraTrustedContracts: [], nowSeconds: BigInt(latest.timestamp) };
});

/** A Guard over the fork, with `second` as its second opinion. */
function guardWith(second: string | JsonRpc, options: { timeoutMs?: number; primary?: JsonRpc } = {}) {
  const primary = options.primary ?? rpc;
  const secondRpc = typeof second === "string" ? httpRpc(second) : second;
  const pair = new SecondOpinionPair({
    primaryRpc: primary,
    secondRpc,
    host: typeof second === "string" ? secondOpinionHost(second) : "proxy",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return new Guard(pair.provider(new EthSimulateV1Provider(primary)), { chainId: CHAIN_ID, requireSimulation: false, oracleDivergenceBps: 10_000 });
}

async function proxy(rewrite: Rewrite): Promise<Proxy> {
  const started = await startProxy(FORK_URL, rewrite);
  proxies.push(started);
  return started;
}

describe("a second opinion on the fork", () => {
  it("the swap is verified without one (the baseline)", async () => {
    const verdict = await new Guard(new EthSimulateV1Provider(rpc), { chainId: CHAIN_ID, requireSimulation: true, oracleDivergenceBps: 10_000 }).check(input);
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("two host names for one fork agree on the swap, at a pinned block", async () => {
    const verdict = await guardWith(SAME_FORK_URL).check(input);
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("a proxy that passes everything through agrees too, and was asked the pinned test-run", async () => {
    const through = await proxy(passThrough);
    expect((await guardWith(through.url).check(input)).level).toBe("verified");
    expect(through.methods).toEqual(expect.arrayContaining(["eth_blockNumber", "eth_getBlockByNumber", "eth_simulateV1"]));
  });

  it("a second service that rewrites one Transfer in its test-run is refused: SECOND_OPINION_DISAGREES", async () => {
    let rewritten = 0;
    const lying = await proxy(async (method, params, upstream) => {
      const answer = await upstream();
      if (method !== "eth_simulateV1") return answer;
      const blocks = answer.result as { calls: { logs: { address: string; topics: string[]; data: string }[] }[] }[];
      for (const call of blocks[0]?.calls ?? []) {
        // The first real token transfer: SPX arriving, 1 unit less.
        const log = call.logs.find((l) => l.topics[0]?.toLowerCase() === TOPICS.transfer && l.address.toLowerCase() !== NATIVE_TOKEN);
        if (log && rewritten === 0) {
          log.data = `0x${word(BigInt(log.data) - 1n)}`;
          rewritten += 1;
        }
      }
      return answer;
    });
    const verdict = await guardWith(lying.url).check(input);
    expect(rewritten).toBe(1);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ reason: "result" });
  });

  it("a second service whose head is 100 ahead is refused: SECOND_OPINION_DISAGREES (heads)", async () => {
    const ahead = await proxy(async (method, _params, upstream) => {
      const answer = await upstream();
      return method === "eth_blockNumber" ? { result: hex(BigInt(answer.result as string) + 100n) } : answer;
    });
    const verdict = await guardWith(ahead.url).check(input);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ reason: "heads" });
  });

  it("a main service whose head is 100 ahead is refused just the same, never downgraded", async () => {
    const ahead = await proxy(async (method, _params, upstream) => {
      const answer = await upstream();
      return method === "eth_blockNumber" ? { result: hex(BigInt(answer.result as string) + 100n) } : answer;
    });
    const verdict = await guardWith(SAME_FORK_URL, { primary: httpRpc(ahead.url) }).check(input);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["SECOND_OPINION_DISAGREES"]);
  });

  it("a second service reporting another hash for the agreed block is refused (block-hash)", async () => {
    const forked = await proxy(async (method, _params, upstream) => {
      const answer = await upstream();
      if (method !== "eth_getBlockByNumber" || answer.result === null) return answer;
      return { result: { ...(answer.result as object), hash: `0x${"ee".repeat(32)}` } };
    });
    const verdict = await guardWith(forked.url).check(input);
    expect(verdict.violations.map((v) => v.code)).toEqual(["SECOND_OPINION_DISAGREES"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ reason: "block-hash" });
  });

  it("a second service that never answers leaves the swap unverified, checked on one service", async () => {
    const silent = await proxy(async (method, _params, upstream) => (method === "eth_simulateV1" ? "hang" : upstream()));
    const verdict = await guardWith(silent.url, { timeoutMs: 1_000 }).check(input);
    expect(verdict.level).toBe("unverified");
    expect(verdict.warnings.map((w) => w.code)).toEqual(["SECOND_OPINION_UNAVAILABLE"]);
  });
});
