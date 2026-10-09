/**
 * The executor's promises: every call of every leg is sent, in order;
 * permissions only when the allowance is short; nothing at all when any leg is
 * unsignable or was checked for another account; and a stop part-way says how
 * far it got.
 */

import { describe, expect, it } from "vitest";
import type { GuardVerdict, TxPlan } from "@spdex/core";
import type { LegPlan, QuoteResult } from "./engine.js";
import { ExecutionError, OwnerWalletLock, executeQuote, type TxSender } from "./execute.js";
import type { SendableCall } from "./wallet.js";

const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const OTHER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;
const TOKEN = "0x6b175474e89094c44da98b954eedeac495271d0f" as const;
const SPENDER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as const;
const ROUTER = "0xe592427a0aece92de3edee1f18e0157c05861564" as const;

const VERIFIED: GuardVerdict = { level: "verified", signable: true, violations: [], warnings: [] };
const REJECTED: GuardVerdict = {
  level: "rejected",
  signable: false,
  violations: [{ code: "MIN_OUT_NOT_MET", message: "short" }],
  warnings: [],
};

function leg(options: {
  calls?: SendableCall[];
  approvals?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint }[];
  verdict?: GuardVerdict;
  account?: `0x${string}`;
  label?: string;
}): LegPlan {
  const plan: TxPlan = {
    version: 1,
    intent: {
      version: 1,
      chainId: 1,
      account: options.account ?? ACCOUNT,
      recipient: options.account ?? ACCOUNT,
      tokenIn: TOKEN,
      tokenOut: TOKEN,
      maxAmountIn: 100n,
      minAmountOut: 1n,
      deadline: 9_999_999_999n,
      nonce: "0x01",
    },
    approvals: options.approvals ?? [],
    calls: options.calls ?? [{ to: ROUTER, data: "0xaa", value: 0n }],
    meta: { venueId: "v", poolIds: [], quotedAmountOut: 1n, gasEstimate: 1n },
  };
  return {
    poolId: "0xpool000000000000000000000000000000000001",
    venueId: "v",
    ...(options.label === undefined ? {} : { label: options.label }),
    shareBps: 10_000,
    amountIn: 100n,
    amountOut: 1n,
    plan,
    verdict: options.verdict ?? VERIFIED,
  };
}

function quoteOf(legs: LegPlan[], verdict: GuardVerdict = VERIFIED): QuoteResult {
  return {
    route: { amountIn: 100n, amountOut: 1n, legs: [] } as unknown as QuoteResult["route"],
    pools: [],
    legs,
    verdict,
    minAmountOut: 1n,
    previewOnly: false,
  };
}

/**
 * A chain: allowances, and receipts that say success unless told otherwise.
 *
 * `allowances` answers `allowance(owner, spender)` on a token contract by
 * decoding the call, keyed `token|owner|spender`; anything else it is asked is
 * a failure of the test. `allowance` answers every read the same.
 */
function fakeReads(
  options: { allowance?: bigint; allowances?: Map<string, bigint>; reverted?: Set<string>; missing?: Set<string> } = {},
) {
  return async (method: string, params: unknown[]) => {
    if (method === "eth_call" && options.allowances) {
      const { to, data } = params[0] as { to: string; data: string };
      if (!data.startsWith("0xdd62ed3e") || data.length !== 2 + 8 + 128) throw new Error(`not an allowance call: ${data}`);
      const owner = `0x${data.slice(10 + 24, 10 + 64)}`;
      const spender = `0x${data.slice(10 + 64 + 24)}`;
      const amount = options.allowances.get(`${to.toLowerCase()}|${owner}|${spender}`) ?? 0n;
      return `0x${amount.toString(16).padStart(64, "0")}`;
    }
    if (method === "eth_call") return `0x${(options.allowance ?? 0n).toString(16).padStart(64, "0")}`;
    if (method === "eth_getTransactionReceipt") {
      const hash = params[0] as string;
      if (options.missing?.has(hash)) return null;
      return { status: options.reverted?.has(hash) ? "0x0" : "0x1" };
    }
    throw new Error(`unexpected ${method}`);
  };
}

function fakeSender(options: { failOn?: number; error?: unknown; account?: `0x${string}` } = {}) {
  const sent: SendableCall[] = [];
  let n = 0;
  const reads = fakeReads();
  const sender: TxSender & { sent: SendableCall[] } = {
    sent,
    account: options.account ?? ACCOUNT,
    kind: "wallet",
    confirm: { rpc: reads, timeoutMs: 1_000 },
    async send(call) {
      n += 1;
      if (options.failOn === n) throw options.error ?? new Error("nope");
      sent.push(call);
      return { hash: `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`, via: "wallet" };
    },
  };
  return sender;
}

const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("executeQuote", () => {
  it("sends every call of every leg, in order, and reports every hash", async () => {
    const sender = fakeSender();
    const quote = quoteOf([
      leg({ calls: [{ to: ROUTER, data: "0x01", value: 0n }, { to: ROUTER, data: "0x02", value: 5n }] }),
      leg({ calls: [{ to: ROUTER, data: "0x03", value: 0n }], label: "second" }),
    ]);
    const steps: string[] = [];
    const sentHashes: string[] = [];
    const result = await executeQuote(quote, sender, fakeReads(), {
      onStep: (s) => steps.push(`${s.kind} ${s.leg}/${s.legs} ${s.label}`),
      onSent: (hash, kind) => void sentHashes.push(`${kind}:${hash}`),
    });
    expect(sender.sent.map((c) => c.data)).toEqual(["0x01", "0x02", "0x03"]);
    expect(result).toEqual({ via: "wallet", hashes: [hashOf(1), hashOf(2), hashOf(3)], legsDone: 2 });
    expect(steps).toEqual(["swap 1/2 0xpool0000", "swap 2/2 second"]);
    expect(sentHashes).toEqual([`swap:${hashOf(1)}`, `swap:${hashOf(2)}`, `swap:${hashOf(3)}`]);
  });

  it("approves exactly, and only when the allowance is short", async () => {
    const approvals = [{ token: TOKEN, spender: SPENDER, amount: 100n }];
    const short = fakeSender();
    const steps: string[] = [];
    await executeQuote(quoteOf([leg({ approvals })]), short, fakeReads({ allowance: 99n }), {
      onStep: (s) => steps.push(s.kind),
    });
    expect(steps).toEqual(["approve", "swap"]);
    expect(short.sent).toHaveLength(2);
    expect(short.sent[0]).toEqual({
      to: TOKEN,
      // approve(spender, 100)
      data: `0x095ea7b3${SPENDER.slice(2).padStart(64, "0")}${(100).toString(16).padStart(64, "0")}`,
      value: 0n,
    });

    const enough = fakeSender();
    await executeQuote(quoteOf([leg({ approvals })]), enough, fakeReads({ allowance: 100n }));
    expect(enough.sent).toHaveLength(1);
  });

  it("reads the allowance the sender gave the spender, on the token approved — not any other pair", async () => {
    const approvals = [{ token: TOKEN, spender: SPENDER, amount: 100n }];
    const OTHER_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    // Plenty the other way round, and on another token; none where it counts.
    const decoys = new Map([
      [`${TOKEN}|${SPENDER}|${ACCOUNT}`, 10n ** 30n],
      [`${OTHER_TOKEN}|${ACCOUNT}|${SPENDER}`, 10n ** 30n],
    ]);
    const short = fakeSender();
    await executeQuote(quoteOf([leg({ approvals })]), short, fakeReads({ allowances: decoys }));
    expect(short.sent).toHaveLength(2);
    expect(short.sent[0]!.to).toBe(TOKEN);

    const granted = new Map([[`${TOKEN}|${ACCOUNT}|${SPENDER}`, 100n]]);
    const enough = fakeSender();
    await executeQuote(quoteOf([leg({ approvals })]), enough, fakeReads({ allowances: granted }));
    expect(enough.sent).toHaveLength(1);
  });

  it("an allowance that cannot be read stops before this step's transaction, saying nothing of it left", async () => {
    const approvals = [{ token: TOKEN, spender: SPENDER, amount: 100n }];
    const sender = fakeSender();
    const reads = async (method: string, params: unknown[]) => {
      if (method === "eth_call") throw new Error("eth_call: upstream timeout");
      return fakeReads()(method, params);
    };
    const error = (await executeQuote(quoteOf([leg({}), leg({ approvals })]), sender, reads).catch((e: unknown) => e)) as ExecutionError;
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.stage).toBe("check");
    expect(error.legsDone).toBe(1);
    expect(error.hashes).toEqual([hashOf(1)]);
    expect(sender.sent).toHaveLength(1);
  });

  it("says which step each sent transaction was, for the record of a scheduled buy", async () => {
    const approvals = [{ token: TOKEN, spender: SPENDER, amount: 100n }];
    const steps: string[] = [];
    await executeQuote(quoteOf([leg({ approvals })]), fakeSender(), fakeReads(), {
      onSent: (_hash, kind) => {
        steps.push(kind);
      },
    });
    expect(steps).toEqual(["approve", "swap"]);
  });

  it("refuses the whole quote before sending anything if any leg is unsignable", async () => {
    const sender = fakeSender();
    const quote = quoteOf([leg({}), leg({ verdict: REJECTED })]);
    const error = await executeQuote(quote, sender, fakeReads()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect((error as ExecutionError).stage).toBe("check");
    expect((error as ExecutionError).message).toMatch(/leg 2 of 2 was refused/);
    expect(sender.sent).toHaveLength(0);

    await expect(executeQuote(quoteOf([leg({})], REJECTED), sender, fakeReads())).rejects.toThrow(/refused/);
    expect(sender.sent).toHaveLength(0);
  });

  it("refuses a quote checked for a different account than the sender's", async () => {
    const sender = fakeSender({ account: OTHER });
    await expect(executeQuote(quoteOf([leg({})]), sender, fakeReads())).rejects.toThrow(/checked for/);
    expect(sender.sent).toHaveLength(0);
  });

  it("a stop part-way carries the legs done, every hash sent, and the cause unchanged", async () => {
    const rejection = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const sender = fakeSender({ failOn: 2, error: rejection });
    const error = (await executeQuote(quoteOf([leg({}), leg({})]), sender, fakeReads()).catch((e: unknown) => e)) as ExecutionError;
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error.legsDone).toBe(1);
    expect(error.hashes).toEqual([hashOf(1)]);
    expect(error.stage).toBe("send");
    expect(error.cause).toBe(rejection);
    expect(error.message).toBe("User rejected the request.");
  });

  it("a revert stops the sequence at the confirm stage, with the reverted hash included", async () => {
    const sender = fakeSender();
    const reverted = new Set([hashOf(1)]);
    const reads = fakeReads({ reverted });
    const withReceipts = { ...sender, confirm: { rpc: reads, timeoutMs: 1_000 }, send: sender.send };
    const error = (await executeQuote(quoteOf([leg({}), leg({})]), withReceipts, reads).catch((e: unknown) => e)) as ExecutionError;
    expect(error.stage).toBe("confirm");
    expect(error.legsDone).toBe(0);
    expect(error.hashes).toEqual([hashOf(1)]);
    expect(error.message).toMatch(/reverted on chain/);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("OwnerWalletLock", () => {
  it("one holder at a time, and says so to subscribers", () => {
    const lock = new OwnerWalletLock();
    const seen: boolean[] = [];
    lock.subscribe(() => seen.push(lock.isBusy()));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
    expect(seen).toEqual([true, false, true]);
  });
});
