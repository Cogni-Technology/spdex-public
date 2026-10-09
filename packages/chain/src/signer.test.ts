/**
 * The spending-wallet signer, against a scripted endpoint.
 *
 * What is pinned here is what an unattended signature depends on: the exact
 * bytes a fixed key produces (so a library upgrade that changed them fails
 * here, not on chain), which fee type a chain gets, how far a gas estimate is
 * padded, which nonce wins, and the sweep's arithmetic down to the wei. Every
 * endpoint answer is scripted, so each test states the chain it believes in.
 *
 * The first signing vector is not ours: it is the worked example in EIP-155
 * itself, so the legacy path is checked against the specification rather
 * than against a snapshot of what the code happened to produce.
 */

import { describe, expect, it } from "vitest";
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import type { Address, Hex } from "@spdex/core";
import type { JsonRpc } from "./reader.js";
import {
  DEFAULT_GAS_HEADROOM_BPS,
  FeeCeilingError,
  addressOfKey,
  estimateBuyGas,
  generateSpendingKey,
  maxCostOf,
  maxFeeOf,
  prepareTransaction,
  readFees,
  signPrepared,
  transactionHash,
  type PreparedTransaction,
} from "./signer.js";

/** EIP-155's example key, and the address it signs as. */
const EIP155_KEY: Hex = "0x4646464646464646464646464646464646464646464646464646464646464646";
const EIP155_ADDRESS: Address = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";

const WALLET: Address = "0x5d3ec0de0000000000000000000000000000beef";
const OWNER: Address = "0x2222222222222222222222222222222222222222";
const ROUTER: Address = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const CHAIN_ID = 690069;

const GWEI = 10n ** 9n;
const hex = (v: bigint | number): Hex => `0x${v.toString(16)}`;

/**
 * A scripted endpoint: a table of answers by method, and a log of what was
 * asked. An answer that is an Error is thrown, the way `httpRpc` throws —
 * `${method}: ${message}` — so tests see what the real transport produces.
 * A method with no answer is "Method not found", as a real endpoint says it.
 */
function endpoint(answers: Record<string, unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: JsonRpc = async (method, params) => {
    calls.push({ method, params });
    if (!(method in answers)) throw new Error(`${method}: Method not found`);
    const answer = answers[method];
    if (answer instanceof Error) throw new Error(`${method}: ${answer.message}`);
    return answer;
  };
  return { rpc, calls, asked: (method: string) => calls.filter((c) => c.method === method) };
}

/** An EIP-1559 chain on chain CHAIN_ID: base fee 10 gwei, tip 1 gwei. */
function londonChain(overrides: Record<string, unknown> = {}) {
  return endpoint({
    eth_chainId: hex(CHAIN_ID),
    eth_getBlockByNumber: { number: "0x1", baseFeePerGas: hex(10n * GWEI) },
    eth_maxPriorityFeePerGas: hex(GWEI),
    eth_gasPrice: hex(11n * GWEI),
    eth_getTransactionCount: hex(5),
    eth_estimateGas: hex(100_000),
    eth_getBalance: hex(10n ** 18n),
    ...overrides,
  });
}

const buy = { from: WALLET, to: ROUTER, data: "0x7ff36ab5" as Hex, value: 10n ** 16n, chainId: CHAIN_ID };

describe("spending keys", () => {
  it("derives the address EIP-155's example key signs as, in lowercase", () => {
    expect(addressOfKey(EIP155_KEY)).toBe(EIP155_ADDRESS);
    expect(addressOfKey(EIP155_KEY.toUpperCase().replace("0X", "0x") as Hex)).toBe(EIP155_ADDRESS);
  });

  it("generates distinct, usable keys", () => {
    const keys = new Set(Array.from({ length: 16 }, () => generateSpendingKey()));
    expect(keys.size).toBe(16);
    for (const key of keys) {
      expect(key).toMatch(/^0x[0-9a-f]{64}$/);
      expect(addressOfKey(key)).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("refuses what is not a key, without repeating it", () => {
    // An error message ends up on screen and in bug reports. A malformed key is
    // often a real key with a typo, so none of these may appear in one.
    const zero = `0x${"0".repeat(64)}`;
    const order = "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
    const short = EIP155_KEY.slice(0, 64);
    const notHex = `0x${"g".repeat(64)}`;
    for (const bad of [zero, order, short, notHex, EIP155_KEY.slice(2)]) {
      let message = "";
      try {
        addressOfKey(bad as Hex);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^not a private key/);
      expect(message).not.toContain(bad.slice(2, 20));
    }
  });
});

describe("readFees", () => {
  it("bids EIP-1559 where the latest block has a base fee: max = 2 × base + tip", async () => {
    const { rpc } = londonChain();
    await expect(readFees(rpc)).resolves.toEqual({
      type: "eip1559",
      maxFeePerGas: 21n * GWEI,
      maxPriorityFeePerGas: GWEI,
    });
  });

  it("derives the tip from the gas price when the endpoint has no priority-fee method", async () => {
    const { rpc } = londonChain({ eth_maxPriorityFeePerGas: new Error("Method not found") });
    // gasPrice 11 gwei over a 10 gwei base: the endpoint's own tip is 1 gwei.
    await expect(readFees(rpc)).resolves.toEqual({
      type: "eip1559",
      maxFeePerGas: 21n * GWEI,
      maxPriorityFeePerGas: GWEI,
    });
  });

  it("reads a gas price at or below the base fee as no tip, not as a negative one", async () => {
    const { rpc } = londonChain({ eth_maxPriorityFeePerGas: null, eth_gasPrice: hex(9n * GWEI) });
    await expect(readFees(rpc)).resolves.toEqual({
      type: "eip1559",
      maxFeePerGas: 20n * GWEI,
      maxPriorityFeePerGas: 0n,
    });
  });

  it("bids legacy on a chain whose blocks have no base fee", async () => {
    const { rpc, asked } = londonChain({ eth_getBlockByNumber: { number: "0x1" } });
    await expect(readFees(rpc)).resolves.toEqual({ type: "legacy", gasPrice: 11n * GWEI });
    expect(asked("eth_maxPriorityFeePerGas")).toHaveLength(0);
  });

  it("throws with both of the endpoint's reasons when no fee can be read at all", async () => {
    // Unknown is not zero: a transaction bid at zero would sit unmined while
    // the plan believed it was on its way.
    const { rpc } = londonChain({
      eth_maxPriorityFeePerGas: new Error("Method not found"),
      eth_gasPrice: new Error("rate limited"),
    });
    const error = await readFees(rpc).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("eth_maxPriorityFeePerGas: Method not found");
    expect((error as Error).message).toContain("eth_gasPrice: rate limited");
  });

  it("refuses a missing block and a malformed base fee rather than guessing", async () => {
    await expect(readFees(londonChain({ eth_getBlockByNumber: null }).rpc)).rejects.toThrow(/latest block/);
    await expect(
      readFees(londonChain({ eth_getBlockByNumber: { baseFeePerGas: "ten gwei" } }).rpc),
    ).rejects.toThrow(/base fee.*"ten gwei".*not a hex quantity/);
  });
});

describe("prepareTransaction", () => {
  it("assembles a type-2 transaction from the endpoint's figures, with 20% gas headroom by default", async () => {
    const { rpc, asked } = londonChain();
    const tx = await prepareTransaction(rpc, buy);

    expect(DEFAULT_GAS_HEADROOM_BPS).toBe(2_000);
    expect(tx).toEqual({
      from: WALLET,
      chainId: CHAIN_ID,
      nonce: 5,
      to: ROUTER,
      data: "0x7ff36ab5",
      value: 10n ** 16n,
      gas: 120_000n,
      fees: { type: "eip1559", maxFeePerGas: 21n * GWEI, maxPriorityFeePerGas: GWEI },
    });

    // The nonce is the pending one, and the estimate is of exactly this call.
    expect(asked("eth_getTransactionCount")[0]!.params).toEqual([WALLET, "pending"]);
    expect(asked("eth_estimateGas")[0]!.params).toEqual([
      { from: WALLET, to: ROUTER, data: "0x7ff36ab5", value: hex(10n ** 16n) },
    ]);
  });

  it("pads the estimate by the headroom asked for, rounding up", async () => {
    const odd = londonChain({ eth_estimateGas: hex(100_001) });
    // 100,001 × 1.2 = 120,001.2 — a limit one unit short is a failed buy.
    expect((await prepareTransaction(odd.rpc, buy)).gas).toBe(120_002n);
    expect((await prepareTransaction(odd.rpc, { ...buy, headroomBps: 0 })).gas).toBe(100_001n);
    expect((await prepareTransaction(odd.rpc, { ...buy, headroomBps: 5_000 })).gas).toBe(150_002n);
  });

  it("refuses headroom that is negative, fractional or more than doubles the estimate", async () => {
    for (const headroomBps of [-1, 12.5, 10_001]) {
      await expect(prepareTransaction(londonChain().rpc, { ...buy, headroomBps })).rejects.toThrow(/headroom/);
    }
  });

  it("raises the nonce to the floor the host knows about, and never lowers it", async () => {
    // A transaction sent to a private relay is invisible to the public pending
    // count; reusing its nonce would replace it.
    const { rpc } = londonChain();
    expect((await prepareTransaction(rpc, { ...buy, nonceFloor: 9 })).nonce).toBe(9);
    expect((await prepareTransaction(rpc, { ...buy, nonceFloor: 2 })).nonce).toBe(5);
    expect((await prepareTransaction(rpc, { ...buy, nonceFloor: 5 })).nonce).toBe(5);
    await expect(prepareTransaction(rpc, { ...buy, nonceFloor: -1 })).rejects.toThrow(/nonce floor/);
  });

  it("carries the endpoint's reason when the call would revert", async () => {
    const { rpc } = londonChain({ eth_estimateGas: new Error("execution reverted: UniswapV2: EXPIRED") });
    await expect(prepareTransaction(rpc, buy)).rejects.toThrow(
      "could not read a gas estimate: eth_estimateGas: execution reverted: UniswapV2: EXPIRED",
    );
  });

  it("refuses an endpoint on another chain before reading anything else from it", async () => {
    const { rpc, calls } = londonChain({ eth_chainId: "0x1" });
    await expect(prepareTransaction(rpc, buy)).rejects.toThrow(/endpoint is on chain 1, not chain 690069/);
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("refuses a figure the endpoint did not actually give", async () => {
    await expect(prepareTransaction(londonChain({ eth_estimateGas: null }).rpc, buy)).rejects.toThrow(
      /gas estimate.*null.*not a hex quantity/,
    );
    await expect(prepareTransaction(londonChain({ eth_estimateGas: "0x0" }).rpc, buy)).rejects.toThrow(
      /estimated zero gas/,
    );
    await expect(prepareTransaction(londonChain({ eth_getTransactionCount: 5 }).rpc, buy)).rejects.toThrow(
      /pending nonce/,
    );
  });

  it("normalises addresses and calldata to lowercase, and refuses malformed ones", async () => {
    const { rpc } = londonChain();
    const tx = await prepareTransaction(rpc, {
      ...buy,
      to: "0x7A250D5630B4CF539739DF2C5DACB4C659F2488D",
      data: "0x7FF36AB5",
    });
    expect(tx.to).toBe(ROUTER);
    expect(tx.data).toBe("0x7ff36ab5");

    await expect(prepareTransaction(rpc, { ...buy, to: "0x1234" })).rejects.toThrow(/not an address/);
    await expect(prepareTransaction(rpc, { ...buy, data: "0x7ff36ab" as Hex })).rejects.toThrow(/calldata/);
    await expect(prepareTransaction(rpc, { ...buy, value: -1n })).rejects.toThrow(/value/);
    await expect(prepareTransaction(rpc, { ...buy, chainId: 0 })).rejects.toThrow(/chain id/);
  });

  it("prepares nothing whose fees could exceed the ceiling, and says by how much", async () => {
    // 120,000 gas at up to 21 gwei: at most 2,520,000 gwei in fees.
    const { rpc } = londonChain();
    const atCeiling = await prepareTransaction(rpc, { ...buy, feeCeiling: 2_520_000n * GWEI });
    expect(maxFeeOf(atCeiling)).toBe(2_520_000n * GWEI);

    const error = await prepareTransaction(rpc, { ...buy, feeCeiling: 2_519_999n * GWEI }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FeeCeilingError);
    expect((error as FeeCeilingError).maxFee).toBe(2_520_000n * GWEI);
    expect((error as FeeCeilingError).ceiling).toBe(2_519_999n * GWEI);
  });

  it("holds a lying endpoint's tip to the ceiling", async () => {
    // The attack the ceiling exists for: an endpoint that names a priority fee
    // large enough to hand the whole spending wallet to the block builder.
    const { rpc } = londonChain({ eth_maxPriorityFeePerGas: hex(10n ** 18n) });
    await expect(prepareTransaction(rpc, { ...buy, feeCeiling: 10n ** 16n })).rejects.toBeInstanceOf(
      FeeCeilingError,
    );
  });
});

describe("the per-gas fee ceiling", () => {
  it("refuses a price above it however small the gas limit, naming the rate", async () => {
    // The attack a per-transaction ceiling alone lets through: a tight gas
    // limit and a price near the whole allowance fit the total, and every
    // transaction then pays the most it may. 120,000 gas × 21 gwei is within
    // a 3,000,000 gwei total; 21 gwei is above a 20 gwei rate.
    const { rpc } = londonChain();
    const error = await prepareTransaction(rpc, { ...buy, feeCeiling: 3_000_000n * GWEI, feeRateCeiling: 20n * GWEI }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FeeCeilingError);
    expect(error).toMatchObject({ kind: "rate", feePerGas: 21n * GWEI, ceilingPerGas: 20n * GWEI });
    expect((error as Error).message).toMatch(/wei per gas/);

    const atRate = await prepareTransaction(rpc, { ...buy, feeCeiling: 3_000_000n * GWEI, feeRateCeiling: 21n * GWEI });
    expect(atRate.fees).toEqual({ type: "eip1559", maxFeePerGas: 21n * GWEI, maxPriorityFeePerGas: GWEI });
  });

  it("checks the tip too, and still enforces the per-transaction ceiling within the rate", async () => {
    const lying = londonChain({ eth_maxPriorityFeePerGas: hex(50n * GWEI) });
    await expect(prepareTransaction(lying.rpc, { ...buy, feeRateCeiling: 40n * GWEI })).rejects.toMatchObject({
      kind: "rate",
    });
    const { rpc } = londonChain();
    await expect(
      prepareTransaction(rpc, { ...buy, feeRateCeiling: 100n * GWEI, feeCeiling: 2_519_999n * GWEI }),
    ).rejects.toMatchObject({ kind: "total", maxFee: 2_520_000n * GWEI, feePerGas: 21n * GWEI });
  });
});

describe("maxCostOf", () => {
  const base: PreparedTransaction = {
    from: WALLET,
    chainId: CHAIN_ID,
    nonce: 0,
    to: ROUTER,
    data: "0x",
    value: 1_000n,
    gas: 21_000n,
    fees: { type: "eip1559", maxFeePerGas: 30n, maxPriorityFeePerGas: 2n },
  };

  it("is value plus the gas limit at the highest price the transaction allows", () => {
    expect(maxFeeOf(base)).toBe(630_000n);
    expect(maxCostOf(base)).toBe(631_000n);
    expect(maxCostOf({ ...base, fees: { type: "legacy", gasPrice: 7n } })).toBe(1_000n + 147_000n);
  });
});

describe("signPrepared", () => {
  it("reproduces the signed transaction in EIP-155's worked example, byte for byte", async () => {
    const tx: PreparedTransaction = {
      from: EIP155_ADDRESS,
      chainId: 1,
      nonce: 9,
      to: "0x3535353535353535353535353535353535353535",
      data: "0x",
      value: 10n ** 18n,
      gas: 21_000n,
      fees: { type: "legacy", gasPrice: 20n * GWEI },
    };
    const { raw, hash } = await signPrepared(EIP155_KEY, tx);
    expect(raw).toBe(
      "0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83",
    );
    expect(hash).toBe(keccak256(raw));
    expect(hash).toBe("0x33469b22e9f636356c4160a87eb19df52b7412e8eac32a4a55ffe88ea8350788");
  });

  const typed: PreparedTransaction = {
    from: EIP155_ADDRESS,
    chainId: CHAIN_ID,
    nonce: 7,
    to: ROUTER,
    data: "0x7ff36ab5",
    value: 10n ** 16n,
    gas: 180_000n,
    fees: { type: "eip1559", maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: GWEI },
  };
  const TYPED_RAW =
    "0x02f87a830a879507843b9aca008506fc23ac008302bf20947a250d5630b4cf539739df2c5dacb4c659f2488d872386f26fc10000847ff36ab5c080a017a070524524f09e3241a8923d9c5ba87913f14f0265887a07eac92f6259e1fda05aad95b8cc71d478f9148e7296d67835eda950ab91bb3cc0989a484e9b031204";

  it("signs a type-2 transaction to pinned bytes, and the same bytes every time", async () => {
    // Pinned so a signer that started adding entropy, or a serializer that
    // changed field order, fails here rather than as a hash the host recorded
    // and then never saw mined.
    const first = await signPrepared(EIP155_KEY, typed);
    const second = await signPrepared(EIP155_KEY, typed);
    expect(first.raw).toBe(TYPED_RAW);
    expect(second).toEqual(first);
    expect(first.hash).toBe("0x801bd14ef813f736f85ab89954b0125e95b9059ad69bfeb23efc8a031eb54562");
    expect(first.hash).toBe(keccak256(first.raw));
  });

  it("commits to exactly the prepared fields, signed by the prepared sender", async () => {
    // Read back through the parser and signature recovery, which is a
    // different path through the library from the one that wrote the bytes.
    const { raw } = await signPrepared(EIP155_KEY, typed);
    expect(raw.startsWith("0x02")).toBe(true);
    const parsed = parseTransaction(raw);
    expect(parsed).toMatchObject({
      type: "eip1559",
      chainId: CHAIN_ID,
      nonce: 7,
      to: ROUTER,
      data: "0x7ff36ab5",
      value: 10n ** 16n,
      gas: 180_000n,
      maxFeePerGas: 30n * GWEI,
      maxPriorityFeePerGas: GWEI,
    });
    expect((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase()).toBe(
      EIP155_ADDRESS,
    );
  });

  it("refuses a key that is not the one the transaction was prepared for", async () => {
    // The nonce and estimate were read for `from`; signed by anyone else they
    // describe an account the endpoint was never asked about.
    await expect(signPrepared(generateSpendingKey(), typed)).rejects.toThrow(/prepared for 0x9d8a62f6/);
  });

  it("refuses a fee pair no node would accept, and other malformed fields", async () => {
    const inverted = { type: "eip1559", maxFeePerGas: GWEI, maxPriorityFeePerGas: 2n * GWEI } as const;
    await expect(signPrepared(EIP155_KEY, { ...typed, fees: inverted })).rejects.toThrow(
      /priority fee exceeds the max fee/,
    );
    await expect(signPrepared(EIP155_KEY, { ...typed, gas: 0n })).rejects.toThrow(/gas limit/);
    await expect(signPrepared(EIP155_KEY, { ...typed, nonce: -1 })).rejects.toThrow(/nonce/);
    await expect(signPrepared(EIP155_KEY, { ...typed, chainId: 1.5 })).rejects.toThrow(/chain id/);
    await expect(signPrepared(`0x${"0".repeat(64)}`, typed)).rejects.toThrow(/not a private key/);
  });
});

describe("estimateBuyGas", () => {
  it("budgets a token sale its approval on top of a native buy's swap", () => {
    // The figures and their measurements are in the doc comment; the
    // integration suite holds real buys under them on the fork. What is pinned
    // here is the relation: the difference covers the dearest approval
    // measured (USDC's, estimated at 55,949) with 20% headroom, rounded up.
    expect(estimateBuyGas("native")).toBe(350_000n);
    expect(estimateBuyGas("token")).toBe(420_000n);
    expect(estimateBuyGas("token") - estimateBuyGas("native")).toBeGreaterThanOrEqual(67_139n);
    expect(() => estimateBuyGas("bridge" as never)).toThrow(/no gas budget/);
  });
});

describe("transactionHash", () => {
  it("is the hash signPrepared reports, computed from the bytes alone", async () => {
    const { rpc } = londonChain();
    const tx = await prepareTransaction(rpc, { ...buy, from: EIP155_ADDRESS });
    const signed = await signPrepared(EIP155_KEY, tx);
    expect(transactionHash(signed.raw)).toBe(signed.hash.toLowerCase());
    expect(transactionHash(signed.raw.toUpperCase().replace(/^0X/, "0x"))).toBe(signed.hash.toLowerCase());
    expect(() => transactionHash("0x123")).toThrow(/not a signed transaction/);
    expect(() => transactionHash("")).toThrow(/not a signed transaction/);
  });
});
