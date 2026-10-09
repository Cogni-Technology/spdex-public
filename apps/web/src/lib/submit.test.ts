/**
 * Submission tests, focused on the one behaviour that matters most: spDEX must
 * never quietly broadcast publicly when the user asked for privacy.
 *
 * A silent downgrade is worse than having no privacy feature at all, because
 * the user sizes their trade believing they are protected from front-running.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GAS_HEADROOM_BPS, transactionHash } from "@spdex/chain";
import type { SubmitterConfig } from "@spdex/core";
import {
  PrivateSubmissionUnavailable,
  RawTransactionRejected,
  gasWithFloor,
  gasWithHeadroom,
  isAlreadyKnown,
  privateGasPrice,
  submit,
  submitPrivately,
} from "./submit.js";
import type { Eip1193Provider } from "./wallet.js";
import { MIN_TIP } from "./fees.js";
import { legacySigned, type SignRequestFields } from "./signedTx.fixture.js";

const FROM = "0x1111111111111111111111111111111111111111" as const;
const CALL = { to: "0x2222222222222222222222222222222222222222" as const, data: "0xdeadbeef" as const, value: 0n };
const RELAY = "https://relay.invalid/rpc";

type SignRequest = SignRequestFields;

/**
 * A wallet that answers chain queries and optionally signs: what it was
 * asked, unless `alter` changes the request first (a wallet that fills in its
 * own fees).
 */
function fakeWallet(options: { signs: boolean; alter?: (tx: SignRequest) => SignRequest }): Eip1193Provider & {
  sent: unknown[];
  signRequests: unknown[];
  lastSigned: string | null;
} {
  const sent: unknown[] = [];
  const signRequests: unknown[] = [];
  const wallet = {
    sent,
    signRequests,
    lastSigned: null as string | null,
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_getTransactionCount": return "0x5";
        case "eth_chainId": return "0x1";
        case "eth_gasPrice": return "0x3b9aca00";
        // 0.5 gwei: its eighth and the tip stay under the 1 gwei asked above,
        // so the endpoint's figure is the one signed.
        case "eth_getBlockByNumber": return { baseFeePerGas: "0x1dcd6500" };
        case "eth_estimateGas": return "0x30d40";
        case "eth_signTransaction":
          if (!options.signs) {
            const error = Object.assign(new Error("not supported"), { code: 4200 });
            throw error;
          }
          signRequests.push(params);
          {
            const asked = (params as [SignRequest])[0];
            const tx = options.alter ? options.alter(asked) : asked;
            wallet.lastSigned = legacySigned({
              nonce: BigInt(tx.nonce),
              gasPrice: BigInt(tx.gasPrice),
              gas: BigInt(tx.gas),
              to: tx.to,
              value: BigInt(tx.value),
              data: tx.data,
              chainId: BigInt(tx.chainId),
            });
            return wallet.lastSigned;
          }
        case "eth_sendTransaction":
          sent.push(params);
          return "0xpublichash";
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return wallet;
}

const privateConfig: SubmitterConfig = { mode: "private", url: RELAY };
const walletConfig: SubmitterConfig = { mode: "wallet", url: null };

describe("private submission", () => {
  it("signs locally and posts the raw transaction to the relay", async () => {
    // Capture the request in a closure rather than reading mock.calls: the
    // typing of a global fetch mock is more trouble than the assertion is worth.
    let relayBody: { method?: string; params?: unknown[] } = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      relayBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xprivatehash" }), {
        status: 200,
      });
    });

    const wallet = fakeWallet({ signs: true });
    const result = await submitPrivately(wallet, FROM, CALL, RELAY);

    expect(result).toEqual({ hash: "0xprivatehash", via: "private" });
    // Never through the wallet's own broadcast path — that is the mempool.
    expect(wallet.sent).toHaveLength(0);

    expect(relayBody.method).toBe("eth_sendRawTransaction");
    expect(relayBody.params?.[0]).toBe(wallet.lastSigned);
    vi.unstubAllGlobals();
  });

  it("signs with the gas estimate plus the signer's headroom, never the bare estimate", async () => {
    // The wallet signs the limit it is handed, so a private swap has only the
    // margin added here. Without it, a swap that needs a little more gas than
    // was measured (the pair's price record written in a new block) runs out,
    // reverts, and still pays the fee.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xprivatehash" })));
    const wallet = fakeWallet({ signs: true });
    // The estimate comes from the user's endpoint, not the wallet's.
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x186a1" : "0x1");
    await submitPrivately(wallet, FROM, CALL, RELAY, reads);
    vi.unstubAllGlobals();

    expect(DEFAULT_GAS_HEADROOM_BPS).toBe(2_000);
    // 100,001 × 1.2 = 120,001.2, rounded up: one unit short is a failed swap.
    const [[signed]] = wallet.signRequests as [[{ gas: string; nonce: string; gasPrice: string }]];
    expect(BigInt(signed.gas)).toBe(120_002n);
    expect(signed.gas).toBe("0x1d4c2");
  });

  it("pads any estimate by the same rule as @spdex/chain's signer", () => {
    expect(gasWithHeadroom(200_000n)).toBe(240_000n);
    expect(gasWithHeadroom(100_001n)).toBe(120_002n);
    expect(gasWithHeadroom(21_000n)).toBe(25_200n);
  });

  it("refuses to sign when the endpoint returns no gas estimate, and signs nothing", async () => {
    const wallet = fakeWallet({ signs: true });
    const reads = async (method: string) => (method === "eth_estimateGas" ? null : "0x1");
    await expect(submitPrivately(wallet, FROM, CALL, RELAY, reads)).rejects.toThrow(/could not read a gas estimate/);
    expect(wallet.signRequests).toHaveLength(0);
  });

  it("reports unavailability when the wallet will not sign without broadcasting", async () => {
    await expect(submitPrivately(fakeWallet({ signs: false }), FROM, CALL, RELAY)).rejects.toThrow(
      PrivateSubmissionUnavailable,
    );
  });
});

describe("never downgrading silently", () => {
  it("aborts rather than broadcasting publicly when no consent handler is given", async () => {
    // The default must be refusal. A caller that forgets to ask gets an error,
    // not a public broadcast.
    const wallet = fakeWallet({ signs: false });
    await expect(submit(privateConfig, FROM, CALL, undefined, wallet)).rejects.toThrow(
      PrivateSubmissionUnavailable,
    );
    expect(wallet.sent).toHaveLength(0);
  });

  it("aborts when the user declines the public fallback", async () => {
    const wallet = fakeWallet({ signs: false });
    const asked = vi.fn(() => false);

    await expect(submit(privateConfig, FROM, CALL, asked, wallet)).rejects.toThrow(
      PrivateSubmissionUnavailable,
    );
    expect(asked).toHaveBeenCalledOnce();
    expect(wallet.sent).toHaveLength(0);
  });

  it("broadcasts publicly only after explicit consent, and says so", async () => {
    const wallet = fakeWallet({ signs: false });
    const result = await submit(privateConfig, FROM, CALL, () => true, wallet);

    // `via` reports what actually happened, not what was configured.
    expect(result.via).toBe("wallet");
    expect(wallet.sent).toHaveLength(1);
  });

  it("passes the wallet's reason to the consent handler", async () => {
    // "Your wallet would not sign" is actionable; "something went wrong" is not.
    let reason = "";
    const asked = (given: string) => {
      reason = given;
      return false;
    };
    await expect(
      submit(privateConfig, FROM, CALL, asked, fakeWallet({ signs: false })),
    ).rejects.toThrow();
    expect(reason).toMatch(/not supported/i);
  });

  it("refuses private mode with no relay configured", async () => {
    await expect(
      submit({ mode: "private", url: null }, FROM, CALL, () => true, fakeWallet({ signs: true })),
    ).rejects.toThrow(/no relay endpoint/i);
  });
});

describe("public submission", () => {
  it("goes straight through the wallet", async () => {
    const wallet = fakeWallet({ signs: true });
    const result = await submit(walletConfig, FROM, CALL, undefined, wallet);

    expect(result).toEqual({ hash: "0xpublichash", via: "wallet" });
    expect(wallet.sent).toHaveLength(1);
  });

  it("tells the wallet what to bid: the tip blocks are taking, and twice the base fee as the most", async () => {
    const wallet = fakeWallet({ signs: true });
    const reads = async (method: string): Promise<unknown> => {
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x5f5e100" }; // 0.1 gwei
      if (method === "eth_feeHistory") return { reward: [["0xbebc200"], ["0xbebc200"], ["0x0"]] }; // 0.2, 0.2, 0 gwei
      throw new Error(`unexpected ${method}`);
    };
    await submit(walletConfig, FROM, CALL, undefined, wallet, reads);
    expect(wallet.sent[0]).toEqual([
      { from: FROM, to: CALL.to, data: CALL.data, value: "0x0", maxFeePerGas: `0x${(400_000_000n).toString(16)}`, maxPriorityFeePerGas: "0xbebc200" },
    ]);
  });

  it("leaves the fee to the wallet when it can't be read, rather than not sending", async () => {
    const wallet = fakeWallet({ signs: true });
    const reads = async (method: string): Promise<unknown> => {
      throw new Error(`no ${method} today`);
    };
    await submit(walletConfig, FROM, CALL, undefined, wallet, reads);
    expect(wallet.sent[0]).toEqual([{ from: FROM, to: CALL.to, data: CALL.data, value: "0x0" }]);
  });
});

/**
 * A vault transaction is checked for one chain, and the check is seconds
 * older than the signature. A wallet switched in those seconds signed for
 * whatever network it was on by then, where the checked addresses may hold no
 * code and ether sent to them is lost. The chain now goes with the call.
 */
describe("a call checked for one chain", () => {
  const ON_MAINNET = { ...CALL, value: 5n, chainId: 1 };

  it("is refused before anything is signed when the wallet is on another chain, publicly or privately", async () => {
    const wallet = fakeWallet({ signs: true });
    await expect(submit(walletConfig, FROM, { ...ON_MAINNET, chainId: 690069 }, undefined, wallet)).rejects.toMatchObject({
      name: "WalletChainChanged",
      expected: 690069,
      actual: 1,
    });
    expect(wallet.sent).toHaveLength(0);
    await expect(submitPrivately(wallet, FROM, { ...ON_MAINNET, chainId: 690069 }, RELAY)).rejects.toMatchObject({ name: "WalletChainChanged" });
    expect(wallet.signRequests).toHaveLength(0);
  });

  it("carries the chain id with it, so a wallet that checks it refuses a switch made in the last instant", async () => {
    const wallet = fakeWallet({ signs: true });
    // The fake wallet's block has a 0.5 gwei base fee and it keeps no fee
    // history, so the suggestion is twice that and the floor tip.
    const fees = { maxFeePerGas: `0x${(1_050_000_000n).toString(16)}`, maxPriorityFeePerGas: `0x${MIN_TIP.toString(16)}` };
    await submit(walletConfig, FROM, ON_MAINNET, undefined, wallet);
    expect(wallet.sent).toEqual([[{ from: FROM, to: CALL.to, data: CALL.data, value: "0x5", chainId: "0x1", ...fees }]]);
    // A call that names no chain is sent exactly as before.
    await submit(walletConfig, FROM, CALL, undefined, wallet);
    expect(wallet.sent[1]).toEqual([{ from: FROM, to: CALL.to, data: CALL.data, value: "0x0", ...fees }]);
  });
});

/**
 * A vault's buy estimated on a quiet pool needs about 57,000 more when a
 * trade lands on the pool first; the estimate plus 20% ran out and the owner
 * paid the fee. A call with a floor is signed with at least it.
 */
describe("a call with a gas floor", () => {
  it("is signed with the larger of the padded estimate and the floor, privately", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xprivatehash" })));
    const wallet = fakeWallet({ signs: true });
    // 253,700 quiet: 304,440 with 20%, under the keeper's 384,000.
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x3df04" : "0x1");
    await submitPrivately(wallet, FROM, { ...CALL, gasFloor: 384_000n }, RELAY, reads);
    const [[low]] = wallet.signRequests as [[{ gas: string }]];
    expect(BigInt(low.gas)).toBe(384_000n);
    // An estimate whose padding is above the floor keeps its padding.
    const high = async (method: string) => (method === "eth_estimateGas" ? `0x${(350_000).toString(16)}` : "0x1");
    await submitPrivately(wallet, FROM, { ...CALL, gasFloor: 384_000n }, RELAY, high);
    const [, [padded]] = wallet.signRequests as [[{ gas: string }], [{ gas: string }]];
    expect(BigInt(padded.gas)).toBe(420_000n);
    vi.unstubAllGlobals();
  });

  it("carries its limit through the wallet too, from the endpoint's estimate, or the floor when there is none", async () => {
    const wallet = fakeWallet({ signs: true });
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x3df04" : "0x1");
    await submit(walletConfig, FROM, { ...CALL, gasFloor: 384_000n }, undefined, wallet, reads);
    expect(wallet.sent[0]).toEqual([{ from: FROM, to: CALL.to, data: CALL.data, value: "0x0", gas: `0x${(384_000).toString(16)}` }]);
    const failing = async (): Promise<unknown> => {
      throw new Error("execution reverted");
    };
    await submit(walletConfig, FROM, { ...CALL, gasFloor: 384_000n }, undefined, wallet, failing);
    expect(wallet.sent[1]).toEqual([{ from: FROM, to: CALL.to, data: CALL.data, value: "0x0", gas: `0x${(384_000).toString(16)}` }]);
  });

  it("is the padded estimate, never under the floor", () => {
    expect(gasWithFloor(253_700n, 384_000n)).toBe(384_000n);
    expect(gasWithFloor(350_000n, 384_000n)).toBe(420_000n);
    expect(gasWithFloor(null, 384_000n)).toBe(384_000n);
  });
});

/**
 * A batch of vault buys is checked at one gas limit and priced at one gas
 * price: the batcher skips vaults it can't afford, so another limit is
 * another transaction, and whether it pays for itself was worked out at that
 * price. Both are signed exactly as given, and nothing is estimated or read.
 */
describe("a call with an exact gas limit and price", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const EXACT = { ...CALL, gas: 3_060_000n, gasPrice: 1_234_567_891n };

  /** Reads that record what was asked, answering like the fake wallet does. */
  function recordingReads() {
    const asked: string[] = [];
    const reads = async (method: string) => {
      asked.push(method);
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x1dcd6500" };
      return method === "eth_getTransactionCount" ? "0x5" : method === "eth_gasPrice" ? "0x3b9aca00" : "0x30d40";
    };
    return { asked, reads };
  }

  it("is signed privately with exactly that limit and price, with no estimate and no price read", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xprivatehash" })));
    const wallet = fakeWallet({ signs: true });
    const { asked, reads } = recordingReads();
    await submitPrivately(wallet, FROM, EXACT, RELAY, reads);

    const [[signed]] = wallet.signRequests as [[{ gas: string; gasPrice: string }]];
    expect(signed.gas).toBe(`0x${(3_060_000).toString(16)}`);
    expect(signed.gasPrice).toBe(`0x${(1_234_567_891).toString(16)}`);
    expect(asked).toEqual(["eth_getTransactionCount"]);
  });

  it("takes each on its own: a price alone still estimates, a limit alone still reads the price", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xprivatehash" })));
    const wallet = fakeWallet({ signs: true });

    const priced = recordingReads();
    await submitPrivately(wallet, FROM, { ...CALL, gasPrice: 7n }, RELAY, priced.reads);
    expect(priced.asked.sort()).toEqual(["eth_estimateGas", "eth_getTransactionCount"]);

    const limited = recordingReads();
    await submitPrivately(wallet, FROM, { ...CALL, gas: 50_000n }, RELAY, limited.reads);
    expect(limited.asked.sort()).toEqual(["eth_feeHistory", "eth_gasPrice", "eth_getBlockByNumber", "eth_getTransactionCount"]);

    const [[first], [second]] = wallet.signRequests as [[{ gas: string; gasPrice: string }], [{ gas: string; gasPrice: string }]];
    // 200,000 estimated, plus 20%.
    expect(first).toMatchObject({ gas: `0x${(240_000).toString(16)}`, gasPrice: "0x7" });
    expect(second).toMatchObject({ gas: `0x${(50_000).toString(16)}`, gasPrice: "0x3b9aca00" });
  });

  it("goes to the wallet as given on a public send too", async () => {
    const wallet = fakeWallet({ signs: true });
    const { asked, reads } = recordingReads();
    await submit(walletConfig, FROM, EXACT, undefined, wallet, reads);
    expect(wallet.sent[0]).toEqual([
      {
        from: FROM,
        to: CALL.to,
        data: CALL.data,
        value: "0x0",
        gas: `0x${(3_060_000).toString(16)}`,
        gasPrice: `0x${(1_234_567_891).toString(16)}`,
      },
    ]);
    expect(asked).toEqual([]);
  });

  it("refuses a limit or price that isn't positive, or a limit beside a floor, before anything is read or signed", async () => {
    const bad = [
      { ...CALL, gas: 0n },
      { ...CALL, gasPrice: 0n },
      { ...CALL, gas: -1n },
      { ...CALL, gas: 3_060_000n, gasFloor: 384_000n },
    ];
    for (const call of bad) {
      const wallet = fakeWallet({ signs: true });
      const { asked, reads } = recordingReads();
      await expect(submitPrivately(wallet, FROM, call, RELAY, reads)).rejects.toThrow(/nothing was sent/);
      await expect(submit(walletConfig, FROM, call, undefined, wallet, reads)).rejects.toThrow(/nothing was sent/);
      expect(asked).toEqual([]);
      expect(wallet.signRequests).toHaveLength(0);
      expect(wallet.sent).toHaveLength(0);
    }
  });
});

describe("a private submission that knows its hash before posting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  // What the fake wallet signs for CALL: nonce 5 on chain 1 at 1 gwei, the estimate with the headroom.
  const SIGNED = legacySigned({ nonce: 5n, gasPrice: 1_000_000_000n, gas: gasWithHeadroom(0x30d40n), to: CALL.to, value: 0n, data: CALL.data, chainId: 1n });
  const HASH = transactionHash(SIGNED);
  const relayAnswers = (answer: () => Response | Promise<Response>) => vi.stubGlobal("fetch", async () => answer());
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("records the hash of the signed bytes first, and reports that hash, not the relay's word", async () => {
    const order: string[] = [];
    relayAnswers(() => {
      order.push("posted");
      return json({ jsonrpc: "2.0", id: 1, result: HASH });
    });
    const result = await submitPrivately(fakeWallet({ signs: true }), FROM, CALL, RELAY, undefined, {
      onSigned: async (hash) => void order.push(`recorded ${hash}`),
    });
    expect(result).toEqual({ hash: HASH, via: "private" });
    expect(order).toEqual([`recorded ${HASH}`, "posted"]);
  });

  it("refuses a relay that names another hash, and takes 'already known' as sent", async () => {
    relayAnswers(() => json({ jsonrpc: "2.0", id: 1, result: `0x${"ab".repeat(32)}` }));
    await expect(
      submitPrivately(fakeWallet({ signs: true }), FROM, CALL, RELAY, undefined, { onSigned: () => {} }),
    ).rejects.toThrow(/reported hash .* but the transaction signed has hash/);

    relayAnswers(() => json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "already known" } }));
    await expect(
      submitPrivately(fakeWallet({ signs: true }), FROM, CALL, RELAY, undefined, { onSigned: () => {} }),
    ).resolves.toEqual({ hash: HASH, via: "private" });
  });

  it("only an answered JSON-RPC error is a refusal; a lost answer is not", async () => {
    relayAnswers(() => json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nonce too low" } }));
    await expect(
      submitPrivately(fakeWallet({ signs: true }), FROM, CALL, RELAY, undefined, { onSigned: () => {} }),
    ).rejects.toBeInstanceOf(RawTransactionRejected);

    for (const lost of [
      () => json({ oops: true }, 502),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      relayAnswers(lost);
      const error = await submitPrivately(fakeWallet({ signs: true }), FROM, CALL, RELAY, undefined, {
        onSigned: () => {},
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RawTransactionRejected);
    }
  });
});

describe("what the wallet signed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts nothing when the wallet signed another limit or price than the exact ones checked", async () => {
    let posted = 0;
    vi.stubGlobal("fetch", async () => {
      posted += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xhash" }), { status: 200 });
    });
    const exact = { ...CALL, gas: 400_000n, gasPrice: 2_000_000_000n };
    const lower = fakeWallet({ signs: true, alter: (tx) => ({ ...tx, gas: "0x1" }) });
    await expect(submitPrivately(lower, FROM, exact, RELAY)).rejects.toThrow(/different gas limit.*nothing was sent/);
    const repriced = fakeWallet({ signs: true, alter: (tx) => ({ ...tx, gasPrice: "0x1" }) });
    await expect(submitPrivately(repriced, FROM, exact, RELAY)).rejects.toThrow(/different gas price/);
    expect(posted).toBe(0);
    // Exactly as asked: posted.
    await expect(submitPrivately(fakeWallet({ signs: true }), FROM, exact, RELAY)).resolves.toMatchObject({ via: "private" });
    expect(posted).toBe(1);
  });

  it("posts nothing when the wallet signed another call, amount, nonce or chain, exact or not", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xhash" }), { status: 200 }));
    const changes: [Partial<SignRequest>, RegExp][] = [
      [{ to: "0x3333333333333333333333333333333333333333" }, /different recipient/],
      [{ data: "0xdeadbeee" }, /different call data/],
      [{ value: "0x1" }, /different amount of ether/],
      [{ nonce: "0x6" }, /different nonce/],
      [{ chainId: "0x2" }, /another network/],
    ];
    for (const [change, reason] of changes) {
      const wallet = fakeWallet({ signs: true, alter: (tx) => ({ ...tx, ...change }) });
      await expect(submitPrivately(wallet, FROM, CALL, RELAY)).rejects.toThrow(reason);
    }
    // A limit or price the wallet picks for a call that named none is its own business.
    const refilled = fakeWallet({ signs: true, alter: (tx) => ({ ...tx, gas: "0x1", gasPrice: "0x2" }) });
    await expect(submitPrivately(refilled, FROM, CALL, RELAY)).resolves.toMatchObject({ via: "private" });
  });

  it("posts nothing a wallet returns that isn't a readable transaction", async () => {
    const junk = { ...fakeWallet({ signs: true }), request: async ({ method }: { method: string }) => {
      if (method === "eth_signTransaction") return "0xf86b0180";
      return fakeWallet({ signs: true }).request({ method });
    } };
    await expect(submitPrivately(junk as Eip1193Provider, FROM, CALL, RELAY)).rejects.toBeInstanceOf(PrivateSubmissionUnavailable);
  });
});

describe("the price a private transaction is signed at", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const GWEI = 1_000_000_000n;
  /** An endpoint quoting `gasPrice`, whose latest block had `baseFee` (none: a chain without one). */
  const endpoint =
    (gasPrice: bigint, baseFee: bigint | null) =>
    async (method: string): Promise<unknown> => {
      if (method === "eth_gasPrice") return `0x${gasPrice.toString(16)}`;
      if (method === "eth_getBlockByNumber") return baseFee === null ? { number: "0x1" } : { baseFeePerGas: `0x${baseFee.toString(16)}` };
      if (method === "eth_getTransactionCount") return "0x5";
      if (method === "eth_estimateGas") return "0x30d40";
      throw new Error(`unexpected ${method}`);
    };

  it("tips a builder even when the endpoint quotes the base fee and 1 wei", async () => {
    // Alchemy's eth_gasPrice: the latest base fee plus 1 wei, which tips
    // nothing and is stranded by the first block that raises the base fee.
    const base = 373_715_661n;
    const price = await privateGasPrice(endpoint(base + 1n, base));
    expect(price).toBe(base + (base + 7n) / 8n + MIN_TIP);
    // Still includable after the most one block can add to the base fee, with the tip left over.
    expect(price - (base * 9n) / 8n).toBeGreaterThanOrEqual(MIN_TIP);
  });

  it("follows an endpoint that asks more, and a chain with no base fee", async () => {
    expect(await privateGasPrice(endpoint(5n * GWEI, GWEI))).toBe(5n * GWEI);
    expect(await privateGasPrice(endpoint(3n * GWEI, null))).toBe(3n * GWEI);
  });

  it("signs a private send at that price, and signs nothing when it can't be read", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xprivatehash" })));
    const base = 200_000_000n;
    const wallet = fakeWallet({ signs: true });
    await submitPrivately(wallet, FROM, CALL, RELAY, endpoint(base + 1n, base));
    const [[signed]] = wallet.signRequests as [[{ gasPrice: string }]];
    expect(BigInt(signed.gasPrice)).toBe(base + base / 8n + MIN_TIP);

    const unread = fakeWallet({ signs: true });
    const noBlock = async (method: string) => (method === "eth_getBlockByNumber" ? { baseFeePerGas: "not a number" } : endpoint(base, base)(method));
    await expect(submitPrivately(unread, FROM, CALL, RELAY, noBlock)).rejects.toThrow(/could not read the base fee/);
    expect(unread.signRequests).toHaveLength(0);
  });
});

describe("isAlreadyKnown", () => {
  it("recognises a node that holds the transaction, and nothing that merely contains the words", () => {
    expect(isAlreadyKnown("already known")).toBe(true);
    expect(isAlreadyKnown("ALREADY KNOWN")).toBe(true);
    expect(isAlreadyKnown("known transaction: 0xabc")).toBe(true);
    expect(isAlreadyKnown("eth_sendRawTransaction: Known transaction")).toBe(true);
    // A refusal: read as success, the buy would wait for a receipt that never comes.
    expect(isAlreadyKnown("unknown transaction type")).toBe(false);
    expect(isAlreadyKnown("rlp: unknown transaction type 0x7f")).toBe(false);
    expect(isAlreadyKnown("nonce too low")).toBe(false);
  });
});
