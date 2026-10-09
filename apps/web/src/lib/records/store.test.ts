import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOPICS, TOKENS } from "@spdex/chain";
import type { Address, DcaPlan, Hex } from "@spdex/core";
import type { DcaLedgerEntry } from "../dca/ledger.js";
import type { ChainReceipt } from "../receipts.js";
import { ExecutionError } from "../execute.js";
import type { RateSnapshot } from "../money/pricing.js";
import {
  MAX_RECEIPTS,
  RECEIPTS_KEY,
  RECEIPTS_LOCK,
  ReceiptStore,
  keepPlanBuys,
  recordBuyFeesEarned,
  recordSwap,
  type ReceiptLocks,
  type RecordSwapInput,
  type StoredReceipt,
} from "./store.js";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const POOL = "0x2222222222222222222222222222222222222222" as Address;
const FRIEND = "0x3333333333333333333333333333333333333333" as Address;
const SPX = TOKENS.SPX.address.toLowerCase() as Address;
const WETH = TOKENS.WETH.address.toLowerCase() as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const T0 = 1_790_000_000;

class MemoryStorage {
  readonly map = new Map<string, string>();
  refuse = false;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.refuse) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
}

/** Web Locks as a queue: one holder at a time, in the order asked. */
function queueLocks(): ReceiptLocks & { asked: string[] } {
  let tail: Promise<unknown> = Promise.resolve();
  const asked: string[] = [];
  return {
    asked,
    request(name, callback) {
      asked.push(name);
      const run = tail.then(() => callback());
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

function receipt(n: number, overrides: Partial<StoredReceipt> = {}): StoredReceipt {
  return {
    id: `swap:1:${hash(n)}`,
    kind: "swap",
    chainId: 1,
    at: T0 + n,
    hashes: [hash(n)],
    sold: { token: WETH, amount: "1", measured: true },
    bought: { token: SPX, amount: "2", measured: true },
    ...overrides,
  };
}

const newStore = (storage = new MemoryStorage(), locks: ReceiptLocks | null = null) =>
  new ReceiptStore(storage, { locks, events: null });

describe("the store", () => {
  it("starts empty, and keeps what is written", async () => {
    const store = newStore();
    expect(store.read()).toMatchObject({ receipts: [], dropped: 0 });
    expect(await store.write((draft) => draft.addReceipt(receipt(1)))).toBe(true);
    expect((store.read() as { receipts: readonly StoredReceipt[] }).receipts).toEqual([receipt(1)]);
  });

  it("keeps the latest 1,000 swaps and tips, oldest let go first, and counts them", async () => {
    const store = newStore();
    await store.write((draft) => {
      for (let n = 1; n <= MAX_RECEIPTS + 2; n++) draft.addReceipt(receipt(n));
    });
    const read = store.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(read.receipts).toHaveLength(MAX_RECEIPTS);
    expect(read.receipts[0]!.id).toBe(receipt(3).id);
    expect(read.dropped).toBe(2);
    await store.write((draft) => draft.addReceipt(receipt(5_000)));
    expect((store.read() as { dropped: number }).dropped).toBe(3);
  });

  it("replaces a receipt recorded again under the same id", async () => {
    const store = newStore();
    await store.write((draft) => draft.addReceipt(receipt(1)));
    await store.write((draft) => draft.addReceipt(receipt(1, { at: T0 + 99 })));
    expect((store.read() as { receipts: readonly StoredReceipt[] }).receipts.map((r) => r.at)).toEqual([T0 + 99]);
  });

  it("loses nothing when two tabs write at once: every write is made under the lock", async () => {
    const storage = new MemoryStorage();
    const locks = queueLocks();
    const a = newStore(storage, locks);
    const b = newStore(storage, locks);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).write((draft) => draft.addReceipt(receipt(i + 1)))),
    );
    const read = a.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(read.receipts).toHaveLength(40);
    expect(new Set(locks.asked)).toEqual(new Set([RECEIPTS_LOCK]));
    expect(locks.asked).toHaveLength(40);
  });

  it("never writes over a file it can't read, or one a later version wrote", async () => {
    for (const text of ["{not json", JSON.stringify({ v: 2, receipts: [] }), JSON.stringify([])]) {
      const storage = new MemoryStorage();
      storage.map.set(RECEIPTS_KEY, text);
      const store = newStore(storage);
      expect(store.read()).toBe("unavailable");
      expect(await store.write((draft) => draft.addReceipt(receipt(1)))).toBe(false);
      expect(storage.map.get(RECEIPTS_KEY)).toBe(text);
    }
  });

  it("keeps entries it doesn't understand exactly as they were", async () => {
    const storage = new MemoryStorage();
    const future = { id: "buy-fees-earned:1:0xabc", kind: "buy-fees-earned", chainId: 1, extra: { a: 1 } };
    storage.map.set(RECEIPTS_KEY, JSON.stringify({ v: 1, receipts: [future], dropped: 0, seen: {}, tx: {}, blocks: {}, fx: {}, later: true }));
    const store = newStore(storage);
    expect((store.read() as { receipts: readonly StoredReceipt[] }).receipts).toEqual([]);
    await store.write((draft) => draft.addReceipt(receipt(1)));
    const written = JSON.parse(storage.map.get(RECEIPTS_KEY)!);
    expect(written.receipts[0]).toEqual(future);
    expect(written.later).toBe(true);
  });

  it("says so, and writes nothing, when storage refuses", async () => {
    const storage = new MemoryStorage();
    storage.refuse = true;
    expect(await newStore(storage).write((draft) => draft.addReceipt(receipt(1)))).toBe(false);
    expect(await new ReceiptStore(null, { locks: null, events: null }).write(() => undefined)).toBe(false);
  });

  it("shares a currency read between the trades seen with it, and lets it go when none needs it", async () => {
    const storage = new MemoryStorage();
    const store = newStore(storage);
    const fx = { block: "26000000", chainTime: T0, rates: { EUR: { answer: "114810000", decimals: 8, updatedAt: T0 - 60 } }, usdc: null };
    const rates = { at: T0, usd: { [WETH]: "2451310000" }, fx };
    await store.write((draft) => {
      draft.setSeen(hash(1), 1, rates);
      draft.setSeen(hash(2), 1, rates);
    });
    const file = JSON.parse(storage.map.get(RECEIPTS_KEY)!);
    expect(Object.keys(file.fx)).toEqual(["1:26000000"]);
    expect(file.seen[hash(1)].fx).toBe("1:26000000");
    const read = store.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(read.seen(hash(2))).toEqual(rates);
    expect(read.seen(hash(3))).toBeNull();
  });

  it("tells another tab's store when it writes", async () => {
    const store = newStore();
    let heard = 0;
    store.subscribe(() => (heard += 1));
    await store.write((draft) => draft.addReceipt(receipt(1)));
    expect(heard).toBe(1);
  });
});

// ─── recordSwap ───────────────────────────────────────────────────────────────

const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TOPICS.transfer, topic(from), topic(to)],
  data: word(value),
});

interface FakeTx {
  from?: string;
  status?: "0x1" | "0x0";
  block: number;
  logs?: ReturnType<typeof transfer>[];
  value?: bigint;
}

/** A network service that knows the transactions it is given, and nothing else. */
function fakeRpc(txs: Record<string, FakeTx>, extra: { balance?: bigint } = {}) {
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(method);
    const tx = txs[params[0] as string];
    switch (method) {
      case "eth_getTransactionReceipt":
        return tx === undefined
          ? null
          : {
              from: tx.from ?? ME,
              status: tx.status ?? "0x1",
              blockNumber: `0x${tx.block.toString(16)}`,
              blockHash: word(BigInt(tx.block)),
              gasUsed: "0x5208",
              effectiveGasPrice: "0x3b9aca00",
              logs: tx.logs ?? [],
            };
      case "eth_getTransactionByHash":
        return tx === undefined ? null : { value: `0x${(tx.value ?? 0n).toString(16)}` };
      case "eth_getBlockByNumber":
        return { timestamp: `0x${(T0 + Number(BigInt(params[0] as string))).toString(16)}` };
      case "eth_getBalance":
        return `0x${(extra.balance ?? 0n).toString(16)}`;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, calls };
}

const FEE = 21_000n * 1_000_000_000n;

function quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): RecordSwapInput["quote"] {
  return {
    legs: [{ plan: { intent: { tokenIn, tokenOut } } }],
    route: { amountIn },
  } as unknown as RecordSwapInput["quote"];
}

const clock = { nowUnix: () => T0 + 1_000, nowPerf: () => 100_000 };

function freshRates(readAt = 100_000 - 60_000): Pick<{ snapshot: RateSnapshot }, "snapshot"> {
  return {
    snapshot: {
      usd: new Map([[WETH, 2_451_310_000n]]),
      usdReadAt: readAt,
      fx: null,
      fxReadAt: null,
    },
  };
}

describe("recordSwap", () => {
  it("records what the swap measurably sold and bought, who sent it, what it cost and what it was worth", async () => {
    const { rpc } = fakeRpc({
      [hash(1)]: { block: 10 },
      [hash(2)]: { block: 11, logs: [transfer(WETH, ME, POOL, 10n ** 16n), transfer(SPX, POOL, ME, 6_912_30000000n)] },
    });
    const store = newStore();
    const recorded = await recordSwap({
      rpc,
      chainId: 1,
      account: ME,
      quote: quote(WETH, SPX, 10n ** 16n),
      result: { via: "wallet", hashes: [hash(1), hash(2)], legsDone: 1 },
      pricing: freshRates(),
      store,
      clock,
    });
    expect(recorded?.saved).toBe(true);
    expect(recorded?.row).toMatchObject({
      kind: "swap",
      account: ME,
      at: { unix: T0 + 11, source: "block" },
      block: 11n,
      hashes: [hash(1), hash(2)],
      sold: { token: WETH, amount: 10n ** 16n, measured: true },
      bought: { token: SPX, amount: 6_912_30000000n, measured: true },
      networkFee: 2n * FEE,
      valueUsd: 24_513_100n,
      valueSource: "twap-seen",
    });
    // Read back from the store, the row is the same.
    const read = store.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(read.receipts).toHaveLength(1);
    expect(read.tx(hash(2))?.from).toBe(ME);
    expect(read.block(1, 11n)?.time).toBe(T0 + 11);
  });

  it("records a partial swap: the legs that went through, and the fee of the one that didn't", async () => {
    const { rpc } = fakeRpc({
      [hash(1)]: { block: 10, logs: [transfer(WETH, ME, POOL, 5n), transfer(SPX, POOL, ME, 700n)] },
      [hash(2)]: { block: 11, status: "0x0" },
    });
    const partial = new ExecutionError(new Error("reverted"), 1, [hash(1), hash(2)], "confirm");
    const recorded = await recordSwap({
      rpc,
      chainId: 1,
      account: ME,
      quote: quote(WETH, SPX, 10n),
      result: { partial },
      pricing: null,
      store: newStore(),
      clock,
    });
    expect(recorded?.row).toMatchObject({
      sold: { amount: 5n, measured: true },
      bought: { amount: 700n, measured: true },
      networkFee: 2n * FEE,
      valueUsd: null,
      valueSource: null,
    });
  });

  it("records nothing when nothing was swapped", async () => {
    const { rpc, calls } = fakeRpc({});
    const partial = new ExecutionError(new Error("declined"), 0, [hash(1)], "send");
    expect(await recordSwap({ rpc, chainId: 1, account: ME, quote: quote(WETH, SPX, 1n), result: { partial }, pricing: null, store: newStore(), clock })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("measures ETH sold by value and ETH bought by balance", async () => {
    const sell = fakeRpc({ [hash(1)]: { block: 10, value: 10n ** 16n, logs: [transfer(SPX, POOL, ME, 9n)] } });
    const sold = await recordSwap({ rpc: sell.rpc, chainId: 1, account: ME, quote: quote(NATIVE_TOKEN, SPX, 10n ** 16n), result: { via: "wallet", hashes: [hash(1)], legsDone: 1 }, pricing: null, store: newStore(), clock });
    expect(sold?.row.sold).toEqual({ token: NATIVE_TOKEN, amount: 10n ** 16n, measured: true });

    const buy = fakeRpc({ [hash(1)]: { block: 10, logs: [transfer(SPX, ME, POOL, 9n)] } }, { balance: 1_000n + 10n ** 15n - FEE });
    const bought = await recordSwap({
      rpc: buy.rpc,
      chainId: 1,
      account: ME,
      quote: quote(SPX, NATIVE_TOKEN, 9n),
      result: { via: "wallet", hashes: [hash(1)], legsDone: 1 },
      pricing: null,
      ethBefore: 1_000n,
      store: newStore(),
      clock,
    });
    expect(bought?.row.bought).toEqual({ token: NATIVE_TOKEN, amount: 10n ** 15n, measured: true });
  });

  it("keeps the swap, unattributed and unmeasured, when the network service can't say anything", async () => {
    const rpc = async () => {
      throw new Error("offline");
    };
    const store = newStore();
    const recorded = await recordSwap({ rpc, chainId: 1, account: ME, quote: quote(WETH, SPX, 10n ** 16n), result: { via: "wallet", hashes: [hash(1)], legsDone: 1 }, pricing: freshRates(), store, clock });
    expect(recorded?.row).toMatchObject({
      account: null,
      at: { unix: T0 + 1_000, source: "device" },
      // An exact-input swap that went through whole sold what was quoted: kept, marked unmeasured.
      sold: { token: WETH, amount: 10n ** 16n, measured: false },
      bought: { token: SPX, amount: null, measured: false },
      networkFee: null,
    });
    expect(recorded?.saved).toBe(true);
  });

  it("leaves the value blank when the page's rates are older than 10 minutes", async () => {
    const { rpc } = fakeRpc({ [hash(1)]: { block: 10, logs: [transfer(WETH, ME, POOL, 10n ** 16n)] } });
    const recorded = await recordSwap({ rpc, chainId: 1, account: ME, quote: quote(WETH, SPX, 10n ** 16n), result: { via: "wallet", hashes: [hash(1)], legsDone: 1 }, pricing: freshRates(100_000 - 600_001), store: newStore(), clock });
    expect(recorded?.row.valueUsd).toBeNull();
  });

  it("records each tip transaction, with the permission it needed counted in its fee", async () => {
    const { rpc } = fakeRpc({
      [hash(1)]: { block: 10, logs: [transfer(WETH, ME, POOL, 1n), transfer(SPX, POOL, ME, 100_00000000n)] },
      [hash(2)]: { block: 11 },
      [hash(3)]: { block: 12, logs: [transfer(SPX, ME, FRIEND, 2_00000000n), transfer(SPX, ME, POOL, 1_00000000n)] },
    });
    const recorded = await recordSwap({
      rpc,
      chainId: 1,
      account: ME,
      quote: quote(WETH, SPX, 1n),
      result: { via: "wallet", hashes: [hash(1)], legsDone: 1 },
      pricing: null,
      tips: { note: "", mode: "permit2-batch", sent: [{ token: SPX, hashes: [hash(2), hash(3)], amount: 3_00000000n, recipients: 2 }] },
      store: newStore(),
      clock,
    });
    expect(recorded?.tips).toHaveLength(1);
    expect(recorded?.tips[0]).toMatchObject({
      kind: "tip",
      account: ME,
      hashes: [hash(2), hash(3)],
      sold: { token: SPX, amount: 3_00000000n, measured: true },
      bought: { amount: 0n, measured: true },
      networkFee: 2n * FEE,
    });
    // The swap's row carries its tip transaction, and how many addresses its receipt shows it paid.
    expect(recorded?.row.tips).toEqual({ hashes: [hash(3)], recipients: 2 });
  });

  it("keeps each tip's swap, and its count only when its receipt was read", async () => {
    const { rpc } = fakeRpc({
      [hash(1)]: { block: 10, logs: [transfer(WETH, ME, POOL, 1n), transfer(SPX, POOL, ME, 100_00000000n)] },
      [hash(4)]: { block: 11, logs: [transfer(SPX, ME, FRIEND, 1_00000000n), transfer(SPX, ME, FRIEND, 1_00000000n)] },
    });
    const store = newStore();
    const recorded = await recordSwap({
      rpc,
      chainId: 1,
      account: ME,
      quote: quote(WETH, SPX, 1n),
      result: { via: "wallet", hashes: [hash(1)], legsDone: 1 },
      pricing: null,
      tips: {
        note: "",
        mode: "transfers",
        sent: [
          { token: SPX, hashes: [hash(4)], amount: 2_00000000n, recipients: 1 },
          // Sent, but its receipt can't be read: no count.
          { token: SPX, hashes: [hash(5)], amount: 1_00000000n, recipients: 1 },
        ],
      },
      store,
      clock,
    });
    const kept = (store.read() as { receipts: readonly StoredReceipt[] }).receipts.filter((r) => r.kind === "tip");
    expect(kept.map((r) => [r.forSwap, r.recipients])).toEqual([
      [`swap:1:${hash(1)}`, 1],
      [`swap:1:${hash(1)}`, undefined],
    ]);
    expect(recorded?.row.tips).toEqual({ hashes: [hash(4), hash(5)], recipients: null });
  });

  it("still answers when storage refuses", async () => {
    const storage = new MemoryStorage();
    storage.refuse = true;
    const { rpc } = fakeRpc({ [hash(1)]: { block: 10, logs: [transfer(SPX, POOL, ME, 5n)] } });
    const recorded = await recordSwap({ rpc, chainId: 1, account: ME, quote: quote(WETH, SPX, 1n), result: { via: "wallet", hashes: [hash(1)], legsDone: 1 }, pricing: null, store: newStore(storage), clock });
    expect(recorded?.saved).toBe(false);
    expect(recorded?.row.bought.amount).toBe(5n);
  });
});

describe("keepPlanBuys", () => {
  const plan: DcaPlan = {
    id: "daily-spx",
    label: "Daily SPX",
    paused: false,
    chainId: 1,
    sell: NATIVE_TOKEN,
    buy: SPX,
    amountPerBuy: "10",
    intervalSeconds: 86_400,
    maxBuys: 3,
    startAt: T0,
    signer: "wallet",
  };
  const entry: DcaLedgerEntry = {
    planId: plan.id,
    chainId: 1,
    owner: ME,
    signer: ME,
    startedAt: T0 * 1000,
    buysDone: 1,
    committed: "10",
    lastSlot: 1,
    consecutiveFailures: 0,
    measured: { buys: 1, amountIn: "10", amountOut: "7" },
    runs: [
      { slot: 0, at: T0 * 1000, status: "declined", amountIn: "10", hashes: [] },
      { slot: 1, at: (T0 + 86_400) * 1000, status: "confirmed", amountIn: "10", amountOut: "7", hashes: [hash(9)] },
    ],
  };

  it("keeps a plan's confirmed buys with the swaps and tips, and says whether it could", async () => {
    const storage = new MemoryStorage();
    const store = newStore(storage);
    expect(await keepPlanBuys(plan, entry, store)).toBe(true);
    const read = store.read();
    if (read === "unavailable") throw new Error("unreadable");
    expect(read.receipts).toEqual([
      {
        id: `plan-buy:1:${plan.id}:1`,
        kind: "plan-buy",
        chainId: 1,
        at: T0 + 86_400,
        hashes: [hash(9)],
        sold: { token: NATIVE_TOKEN.toLowerCase(), amount: "10", measured: false },
        bought: { token: SPX, amount: "7", measured: true },
        plan: { id: plan.id, label: "Daily SPX", n: 1, of: 3 },
      },
    ]);
    // Nothing to keep is kept.
    expect(await keepPlanBuys(plan, { ...entry, runs: [entry.runs[0]!] }, newStore())).toBe(true);
    // A store that can't be written says so, and the plan's record must then stay.
    storage.refuse = true;
    expect(await keepPlanBuys(plan, entry, newStore(storage))).toBe(false);
  });
});

describe("recordBuyFeesEarned", () => {
  const batch = (status: "success" | "reverted"): ChainReceipt => ({
    hash: hash(7),
    from: ME,
    status,
    blockNumber: 20n,
    blockHash: hash(1_020),
    fee: FEE,
    logs: [],
  });

  it("keeps a batch as the buy fees it was paid and the network fee it cost, reading only its block's time", async () => {
    const { rpc, calls } = fakeRpc({});
    const store = newStore();
    const recorded = await recordBuyFeesEarned({ rpc, chainId: 1, account: ME, receipt: batch("success"), earned: 360_000n, weth: WETH, pricing: null, store, clock });
    expect(calls).toEqual(["eth_getBlockByNumber"]);
    expect(recorded?.saved).toBe(true);
    expect(recorded?.row).toMatchObject({
      kind: "buy-fees-earned",
      account: ME,
      at: { unix: T0 + 20, source: "block" },
      sold: { token: WETH, amount: 0n, measured: true },
      bought: { token: WETH, amount: 360_000n, measured: true },
      networkFee: FEE,
    });
  });

  it("keeps a reverted batch too, with nothing received and its fee spent", async () => {
    const { rpc } = fakeRpc({});
    const recorded = await recordBuyFeesEarned({ rpc, chainId: 1, account: ME, receipt: batch("reverted"), earned: 360_000n, weth: WETH, pricing: null, store: newStore(), clock });
    expect(recorded?.row).toMatchObject({ bought: { amount: 0n, measured: true }, networkFee: FEE });
  });
});
