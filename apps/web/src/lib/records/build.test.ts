import { describe, expect, it } from "vitest";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import type { Address, DcaPlan, Hex } from "@spdex/core";
import { MAINNET_BATCHER, V1_MAINNET_BATCHER } from "@spdex/vault";
import type { DcaLedger, DcaLedgerEntry, DcaRun } from "../dca/ledger.js";
import type { VaultHistory, VaultHistoryEntry } from "../dca/vault.js";
import { feesEarnedFromOthers, type BatchResult } from "../network/batch.js";
import type { TxFacts } from "./attribution.js";
import { buildRows, pendingReads, rowsFor, unattributedNote, type BlockFacts, type BuildInput, type ReceiptsRead } from "./build.js";
import { parseReceipt, planBuyReceipts, type StoredReceipt } from "./store.js";
import type { StoredRates } from "./values.js";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const SOMEONE = "0x3333333333333333333333333333333333333333" as Address;
const KEEPER = "0x4444444444444444444444444444444444444444" as Address;
const VAULT = "0x5555555555555555555555555555555555555555" as Address;
const SPX = TOKENS.SPX.address.toLowerCase() as Address;
const WETH = TOKENS.WETH.address.toLowerCase() as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const T0 = 1_790_000_000;

const plan: DcaPlan = {
  id: "daily-spx",
  label: "Daily SPX",
  paused: false,
  chainId: 1,
  sell: NATIVE_TOKEN,
  buy: SPX,
  amountPerBuy: "10000000000000000",
  intervalSeconds: 86_400,
  maxBuys: 69,
  startAt: T0,
  signer: "wallet",
};
const vaultPlan: DcaPlan = { ...plan, id: "vault-spx", label: "Vault SPX", paused: true, signer: "vault", vault: VAULT };

function run(slot: number, overrides: Partial<DcaRun> = {}): DcaRun {
  return { slot, at: (T0 + slot * 86_400 + 60) * 1000, status: "confirmed", amountIn: plan.amountPerBuy, hashes: [], ...overrides };
}

const entry: DcaLedgerEntry = {
  planId: plan.id,
  chainId: 1,
  owner: ME,
  signer: ME,
  startedAt: T0 * 1000,
  // Five buys, of which the record keeps two: the first three were let go.
  buysDone: 5,
  committed: "50000000000000000",
  lastSlot: 5,
  consecutiveFailures: 0,
  measured: { buys: 4, amountIn: "0", amountOut: "0" },
  runs: [
    run(3, { hashes: [hash(20)], amountOut: "690000000000" }),
    run(4, { status: "failed", hashes: [hash(21)] }),
    run(5, { hashes: [hash(22), hash(23)], codes: ["PARTIAL"] }),
  ],
};
const ledger: DcaLedger = { version: 1, entries: { [`1:${plan.id}`]: entry } };

const swap: StoredReceipt = {
  id: `swap:1:${hash(1)}`,
  kind: "swap",
  chainId: 1,
  at: T0 + 10,
  hashes: [hash(1), hash(2)],
  sold: { token: WETH, amount: "10000000000000000", measured: true },
  bought: { token: SPX, amount: "691230000000", measured: true },
};
const strangersSwap: StoredReceipt = { ...swap, id: `swap:1:${hash(3)}`, at: T0 + 20, hashes: [hash(3)] };
const unreadSwap: StoredReceipt = { ...swap, id: `swap:1:${hash(4)}`, at: T0 + 30, hashes: [hash(4)], bought: { token: SPX, amount: null, measured: false } };
const otherChain: StoredReceipt = { ...swap, id: `swap:5:${hash(5)}`, chainId: 5, hashes: [hash(5)] };
const tip: StoredReceipt = {
  id: `tip:1:${hash(6)}`,
  kind: "tip",
  chainId: 1,
  at: T0 + 11,
  hashes: [hash(6)],
  sold: { token: SPX, amount: "6900000000", measured: true },
  bought: { token: SPX, amount: "0", measured: true },
};

const facts: Record<string, TxFacts> = {
  [hash(1)]: { chainId: 1, from: ME, fee: 100n, block: 500n, blockHash: hash(900), status: "success" },
  [hash(2)]: { chainId: 1, from: ME, fee: 200n, block: 501n, blockHash: hash(901), status: "success" },
  [hash(3)]: { chainId: 1, from: SOMEONE, fee: 100n, block: 502n, blockHash: hash(902), status: "success" },
  [hash(6)]: { chainId: 1, from: ME, fee: 50n, block: 503n, blockHash: hash(903), status: "success" },
  [hash(20)]: { chainId: 1, from: ME, fee: 70n, block: 400n, blockHash: hash(904), status: "success" },
};
const times: Record<string, number> = { "1:501": T0 + 5, "1:400": T0 + 3 * 86_400 };
const seen: Record<string, StoredRates> = {
  [hash(2)]: { at: T0, usd: { [WETH]: "2451310000" }, fx: null },
};

function receipts(list: StoredReceipt[], extra: { blocks?: Record<string, BlockFacts> } = {}): ReceiptsRead {
  return {
    receipts: list,
    dropped: 0,
    seen: (h) => seen[h] ?? null,
    tx: (h) => facts[h] ?? null,
    block: (chainId, block) => extra.blocks?.[`${chainId}:${block}`] ?? (times[`${chainId}:${block}`] === undefined ? null : { time: times[`${chainId}:${block}`]!, chainlink: null }),
  };
}

const history: VaultHistory = {
  entries: [
    { kind: "bought", hash: hash(31), blockNumber: 610n, logIndex: 2, at: T0 + 9_000, amountIn: 10n ** 16n, amountOut: 700_00000000n, keeper: KEEPER, reward: 36_000_000_000_000n },
    { kind: "bought", hash: hash(30), blockNumber: 600n, logIndex: 1, at: null, amountIn: 10n ** 16n, amountOut: 710_00000000n, keeper: KEEPER, reward: 36_000_000_000_000n },
    { kind: "funded", hash: hash(29), blockNumber: 590n, logIndex: 0, at: T0, amount: 10n ** 17n },
  ],
  fromBlock: 0n,
  toBlock: 700n,
  missingBuys: 1,
  note: "Earlier buys not shown",
};

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    chainId: 1,
    receipts: receipts([swap, strangersSwap, unreadSwap, otherChain, tip]),
    ledger,
    plans: [plan, vaultPlan],
    vaults: [{ plan: vaultPlan, owner: ME, tokenOut: SPX, maxBuys: 10, buysDone: 3, history }],
    ...overrides,
  };
}

describe("a vault buy the owner triggered themselves", () => {
  const own: VaultHistory = {
    ...history,
    missingBuys: 0,
    entries: [{ kind: "bought", hash: hash(40), blockNumber: 620n, logIndex: 3, at: T0 + 9_500, amountIn: 10n ** 16n, amountOut: 1n, keeper: ME, reward: 36_000_000_000_000n }],
  };
  const vaults = [{ plan: vaultPlan, owner: ME, tokenOut: SPX, maxBuys: 10, buysDone: 1, history: own }];

  it("has its network fee read from the receipt (unknown until then), and no net buy fee, since it came back to them", () => {
    const unread = buildRows(input({ vaults })).rows.find((row) => row.kind === "vault-buy")!;
    expect(unread).toMatchObject({ networkFee: null, buyFee: 0n });
    expect(pendingReads(input({ vaults })).hashes).toContain(hash(40));

    const read = receipts([swap]);
    const withFacts: ReceiptsRead = {
      ...read,
      tx: (h) => (h === hash(40) ? { chainId: 1, from: ME, fee: 298_897n, block: 620n, blockHash: hash(905), status: "success" } : read.tx(h)),
    };
    const row = buildRows(input({ receipts: withFacts, vaults })).rows.find((r) => r.kind === "vault-buy")!;
    expect(row).toMatchObject({ networkFee: 298_897n, buyFee: 0n });
    expect(pendingReads(input({ receipts: withFacts, vaults })).hashes).not.toContain(hash(40));
  });

  it("keeps a keeper's buy at a known zero network fee and the reward as the owner's buy fee", () => {
    const row = buildRows(input()).rows.find((r) => r.kind === "vault-buy")!;
    expect(row).toMatchObject({ networkFee: 0n, buyFee: 36_000_000_000_000n });
    expect(pendingReads(input()).hashes).not.toContain(hash(31));
  });
});

describe("a v2 vault buy says who made it, as the vault judged it", () => {
  const WINDOW = 1_800;
  const DUE = T0 + 86_400;
  const REWARD = 36_000_000_000_000n;
  /** A v2 buy of the owner's vault, read from its log: due at DUE, made at `at`. */
  const v2Buy = (n: number, at: number | null, overrides: Partial<VaultHistoryEntry> = {}): VaultHistoryEntry => ({
    kind: "bought",
    hash: hash(n),
    blockNumber: BigInt(700 + n),
    logIndex: 0,
    at,
    amountIn: 10n ** 16n,
    amountOut: 700_00000000n,
    keeper: KEEPER,
    reward: REWARD,
    source: "v2",
    rewardTo: KEEPER,
    dueSince: DUE,
    communityWindow: WINDOW,
    sender: null,
    maker: null,
    ...overrides,
  });
  const vaultOf = (entries: VaultHistoryEntry[], communityWindow: bigint | null = BigInt(WINDOW)) => [
    { plan: vaultPlan, owner: ME, tokenOut: SPX, maxBuys: 10, buysDone: entries.length, communityWindow, history: { ...history, missingBuys: 0, entries } },
  ];
  const vaultRow = (built: ReturnType<typeof buildRows>, n: number) => built.rows.find((row) => row.id === `vault-buy:1:${hash(n)}:0`)!;
  const withTx = (tx: Record<string, TxFacts>): ReceiptsRead => {
    const read = receipts([swap]);
    return { ...read, tx: (h) => tx[h] ?? read.tx(h) };
  };

  it("tells a community keeper's buy from anyone's by the vault's own strict <: the window's last second is the community's, the next is open", () => {
    const vaults = vaultOf([
      v2Buy(50, DUE + WINDOW - 1, { keeper: MAINNET_BATCHER }),
      v2Buy(51, DUE + WINDOW, { keeper: MAINNET_BATCHER }),
      v2Buy(52, DUE + WINDOW + 1, { keeper: SOMEONE, rewardTo: SOMEONE }),
      v2Buy(53, DUE, { rewardTo: KEEPER }),
    ]);
    const built = buildRows(input({ vaults }));
    expect(vaultRow(built, 50).vaultBuy).toEqual({ caller: MAINNET_BATCHER, rewardTo: KEEPER, dueSince: DUE, maker: "community" });
    expect(vaultRow(built, 51).vaultBuy).toEqual({ caller: MAINNET_BATCHER, rewardTo: KEEPER, dueSince: DUE, maker: "open" });
    expect(vaultRow(built, 52).vaultBuy).toEqual({ caller: SOMEONE, rewardTo: SOMEONE, dueSince: DUE, maker: "open" });
    expect(vaultRow(built, 53).vaultBuy?.maker).toBe("community");
    // Someone else made each: the owner paid its buy fee and no gas, and nothing more is read.
    for (const n of [50, 51, 52, 53]) expect(vaultRow(built, n)).toMatchObject({ buyFee: REWARD, networkFee: 0n });
    expect(pendingReads(input({ vaults })).hashes.filter((h) => [hash(50), hash(51), hash(52), hash(53)].includes(h))).toEqual([]);
  });

  it("judges by the buy's block time, read later when the history had none", () => {
    const vaults = vaultOf([v2Buy(54, null, { blockNumber: 754n })]);
    const inside = buildRows(input({ vaults, receipts: receipts([swap], { blocks: { "1:754": { time: DUE + WINDOW - 1, chainlink: null } } }) }));
    expect(vaultRow(inside, 54).vaultBuy?.maker).toBe("community");
    const after = buildRows(input({ vaults, receipts: receipts([swap], { blocks: { "1:754": { time: DUE + WINDOW, chainlink: null } } }) }));
    expect(vaultRow(after, 54).vaultBuy?.maker).toBe("open");
  });

  it("says the owner made a Trigger now: no buy fee, since it came back, and the network fee they paid, from the receipt", () => {
    const vaults = vaultOf([v2Buy(55, DUE + 10, { keeper: ME, rewardTo: ME })]);
    const unread = vaultRow(buildRows(input({ vaults })), 55);
    expect(unread).toMatchObject({ buyFee: 0n, networkFee: null, vaultBuy: { caller: ME, rewardTo: ME, dueSince: DUE, maker: "owner" } });
    expect(pendingReads(input({ vaults })).hashes).toContain(hash(55));
    const read = vaultRow(buildRows(input({ vaults, receipts: withTx({ [hash(55)]: { chainId: 1, from: ME, fee: 298_897n, block: 755n, blockHash: hash(906), status: "success" } }) })), 55);
    expect(read).toMatchObject({ buyFee: 0n, networkFee: 298_897n, vaultBuy: { maker: "owner" } });
  });

  it("says the owner made a buy in their own Help run batch: no buy fee, and the batch's network fee left to its own row", () => {
    const vaults = vaultOf([v2Buy(56, DUE + 10, { keeper: MAINNET_BATCHER, rewardTo: ME, sender: ME })]);
    const row = vaultRow(buildRows(input({ vaults })), 56);
    expect(row).toMatchObject({ buyFee: 0n, networkFee: 0n, vaultBuy: { caller: MAINNET_BATCHER, rewardTo: ME, dueSince: DUE, maker: "owner" } });
    expect(pendingReads(input({ vaults })).hashes).not.toContain(hash(56));
  });

  /**
   * v2 pays an own vault's fee in the owner's own batch straight back to them,
   * and its buy row says so (no fee). The batch's "Buy fees earned" row is
   * then other people's fees alone (`feesEarnedFromOthers`): with the
   * batcher's whole `earned` there, the owner's own budget showed as income
   * the CSV and statement counted, where v1's two rows netted to zero.
   */
  it("counts an own vault's fee in the owner's own batch once, as paid back: the batch's earned row is other people's fees", () => {
    const OTHERS = 50_000_000_000_000n;
    const vaults = vaultOf([v2Buy(56, DUE + 10, { keeper: MAINNET_BATCHER, rewardTo: ME, sender: ME })]);
    // The batch paid this wallet its own vault's fee and another vault's.
    const result: BatchResult = { status: "success", made: 2, of: 2, earned: REWARD + OTHERS, ownFees: REWARD, fee: 900_000n, untriggered: [] };
    const earned: StoredReceipt = {
      id: `buy-fees-earned:1:${hash(56)}`,
      kind: "buy-fees-earned",
      chainId: 1,
      at: DUE + 10,
      hashes: [hash(56)],
      sold: { token: WETH, amount: "0", measured: true },
      bought: { token: WETH, amount: String(feesEarnedFromOthers(result)), measured: true },
    };
    const built = buildRows(input({ vaults, receipts: receipts([earned]) }));
    const income = built.rows.filter((r) => r.kind === "buy-fees-earned").reduce((sum, r) => sum + (r.bought.amount ?? 0n), 0n);
    const paid = built.rows.filter((r) => r.kind === "vault-buy").reduce((sum, r) => sum + (r.buyFee ?? 0n), 0n);
    expect(paid).toBe(0n);
    expect(income).toBe(OTHERS);
  });

  it("reads a batched buy's sender when the history didn't, to tell the owner's own batch from someone else's paying the owner", () => {
    const vaults = vaultOf([v2Buy(57, DUE + 10, { keeper: MAINNET_BATCHER, rewardTo: ME })]);
    // Who sent it is unknown, so who made it is too; what it cost the owner isn't.
    expect(vaultRow(buildRows(input({ vaults })), 57)).toMatchObject({ buyFee: 0n, networkFee: 0n, vaultBuy: { maker: null } });
    expect(pendingReads(input({ vaults })).hashes).toContain(hash(57));
    const facts = (from: Address): TxFacts => ({ chainId: 1, from, fee: 900_000n, block: 757n, blockHash: hash(907), status: "success" });
    const own = buildRows(input({ vaults, receipts: withTx({ [hash(57)]: facts(ME) }) }));
    expect(vaultRow(own, 57)).toMatchObject({ buyFee: 0n, networkFee: 0n, vaultBuy: { maker: "owner" } });
    const courtesy = buildRows(input({ vaults, receipts: withTx({ [hash(57)]: facts(SOMEONE) }) }));
    expect(vaultRow(courtesy, 57)).toMatchObject({ buyFee: 0n, networkFee: 0n, vaultBuy: { maker: "returned" } });
    expect(pendingReads(input({ vaults, receipts: withTx({ [hash(57)]: facts(ME) }) })).hashes).not.toContain(hash(57));
  });

  it("says someone else who named the owner paid the fee back: no buy fee and no network fee, and never that the owner made it", () => {
    const vaults = vaultOf([v2Buy(58, DUE + 10, { keeper: SOMEONE, rewardTo: ME })]);
    expect(vaultRow(buildRows(input({ vaults })), 58)).toMatchObject({ buyFee: 0n, networkFee: 0n, vaultBuy: { caller: SOMEONE, rewardTo: ME, maker: "returned" } });
    expect(pendingReads(input({ vaults })).hashes).not.toContain(hash(58));
  });

  it("says nothing about who made it while the vault's window is unknown, rather than guess one", () => {
    const unknown = vaultOf([v2Buy(59, DUE + 10, { communityWindow: null })], null);
    expect(vaultRow(buildRows(input({ vaults: unknown })), 59)).toMatchObject({ buyFee: REWARD, networkFee: 0n, vaultBuy: { rewardTo: KEEPER, dueSince: DUE, maker: null } });
    // The vault's own terms say it when the history wasn't told.
    const fromTerms = buildRows(input({ vaults: vaultOf([v2Buy(59, DUE + 599, { communityWindow: null }), v2Buy(63, DUE + 600, { communityWindow: null })], 600n) }));
    expect(vaultRow(fromTerms, 59).vaultBuy?.maker).toBe("community");
    expect(vaultRow(fromTerms, 63).vaultBuy?.maker).toBe("open");
  });

  it("leaves a v1 buy as it was: its caller was paid, and it says only who called", () => {
    const v1 = (n: number, keeper: Address): VaultHistoryEntry =>
      v2Buy(n, DUE + 10, { keeper, source: "v1", rewardTo: keeper, dueSince: null, communityWindow: null });
    const vaults = vaultOf([v1(60, KEEPER), v1(61, V1_MAINNET_BATCHER), v1(62, ME)], null);
    const built = buildRows(input({ vaults }));
    expect(vaultRow(built, 60)).toMatchObject({ buyFee: REWARD, networkFee: 0n, vaultBuy: { caller: KEEPER, rewardTo: null, dueSince: null, maker: "caller" } });
    expect(vaultRow(built, 61)).toMatchObject({ buyFee: REWARD, networkFee: 0n, vaultBuy: { caller: V1_MAINNET_BATCHER, rewardTo: null, dueSince: null, maker: "caller" } });
    expect(vaultRow(built, 62)).toMatchObject({ buyFee: 0n, networkFee: null, vaultBuy: { caller: ME, rewardTo: null, dueSince: null, maker: "owner" } });
    // The history read before releases were told apart: v1's.
    const legacy = buildRows(input()).rows.find((row) => row.kind === "vault-buy")!;
    expect(legacy.vaultBuy).toEqual({ caller: KEEPER, rewardTo: null, dueSince: null, maker: "caller" });
  });
});

describe("buy fees received (Help run the network)", () => {
  it("has no value then, even with rates seen: it sold nothing, and $0 would be a false known zero", () => {
    const fees: StoredReceipt = {
      id: `buy-fees-earned:1:${hash(2)}`,
      kind: "buy-fees-earned",
      chainId: 1,
      at: T0,
      hashes: [hash(2)],
      sold: { token: WETH, amount: "0", measured: true },
      bought: { token: WETH, amount: "500000000000000", measured: true },
    };
    const row = buildRows(input({ receipts: receipts([fees]), vaults: [] })).rows.find((r) => r.kind === "buy-fees-earned")!;
    expect(row).toMatchObject({ valueUsd: null, rates: null, valueSource: null, networkFee: 200n });
  });
});

describe("building the rows", () => {
  const built = buildRows(input());
  const byId = (id: string) => built.rows.find((row) => row.id === id)!;

  it("lists this network's swaps, tips, plan buys and vault buys, newest first", () => {
    expect(built.rows.map((row) => row.kind)).toEqual(["plan-buy", "plan-buy", "vault-buy", "swap", "swap", "tip", "swap"]);
    expect(built.rows.some((row) => row.chainId !== 1)).toBe(false);
  });

  it("gives a swap the tips that name it, and no swap a tip recorded before tips named one", () => {
    // The fixture's tip predates `forSwap`: no swap's.
    expect(byId(swap.id).tips).toBeUndefined();
    const sentWith = (n: number, recipients?: number): StoredReceipt => ({
      ...tip,
      id: `tip:1:${hash(n)}`,
      hashes: [hash(n + 100), hash(n)],
      forSwap: swap.id,
      ...(recipients === undefined ? {} : { recipients }),
    });
    const one = buildRows(input({ receipts: receipts([swap, strangersSwap, sentWith(7, 3)]) }));
    expect(one.rows.find((row) => row.id === swap.id)!.tips).toEqual({ hashes: [hash(7)], recipients: 3 });
    expect(one.rows.find((row) => row.id === strangersSwap.id)!.tips).toBeUndefined();
    // The tip keeps its own row too.
    expect(one.rows.filter((row) => row.kind === "tip")).toHaveLength(1);
    expect(one.rows.find((row) => row.kind === "tip")!.tips).toBeUndefined();
    // Several tip transactions add up; one whose count wasn't read makes the whole count unknown.
    const two = buildRows(input({ receipts: receipts([swap, sentWith(7, 1), sentWith(8, 1)]) }));
    expect(two.rows.find((row) => row.id === swap.id)!.tips).toEqual({ hashes: [hash(7), hash(8)], recipients: 2 });
    const unread = buildRows(input({ receipts: receipts([swap, sentWith(7, 1), sentWith(8)]) }));
    expect(unread.rows.find((row) => row.id === swap.id)!.tips).toEqual({ hashes: [hash(7), hash(8)], recipients: null });
    // Another network's tip is never this network's swap's.
    const elsewhere = buildRows(input({ receipts: receipts([swap, { ...sentWith(7, 3), chainId: 5 }]) }));
    expect(elsewhere.rows.find((row) => row.id === swap.id)!.tips).toBeUndefined();
  });

  it("credits each row to its first transaction's sender, and a vault buy to the vault's owner", () => {
    expect(byId(swap.id).account).toBe(ME);
    expect(byId(strangersSwap.id).account).toBe(SOMEONE);
    expect(byId(unreadSwap.id).account).toBeNull();
    expect(built.rows.find((row) => row.kind === "vault-buy")!.account).toBe(ME);
  });

  it("dates a row by its block once read, and by this device until then", () => {
    expect(byId(swap.id).at).toEqual({ unix: T0 + 5, source: "block" });
    expect(byId(swap.id).block).toBe(501n);
    expect(byId(strangersSwap.id).at).toEqual({ unix: T0 + 20, source: "device" });
  });

  it("leaves every unknown blank, never zero", () => {
    const unread = byId(unreadSwap.id);
    expect(unread.networkFee).toBeNull();
    expect(unread.block).toBeNull();
    expect(unread.bought.amount).toBeNull();
    expect(unread.valueUsd).toBeNull();
    expect(unread.valueSource).toBeNull();
    expect(unread.rates).toBeNull();
    const partial = built.rows.find((row) => row.id === "plan-buy:1:daily-spx:5")!;
    expect(partial.sold.amount).toBeNull();
    expect(partial.bought.amount).toBeNull();
    expect(partial.networkFee).toBeNull();
  });

  it("sums a row's fees over all its transactions", () => {
    expect(byId(swap.id).networkFee).toBe(300n);
    expect(byId(swap.id).buyFee).toBe(0n);
  });

  it("values a row by the rates seen with its last transaction", () => {
    expect(byId(swap.id).valueUsd).toBe(24_513_100n);
    expect(byId(swap.id).valueSource).toBe("twap-seen");
  });

  it("values a row by Chainlink at its block once filled in", () => {
    const eth = { answer: 245_131_000_000n, decimals: 8, updatedAt: T0 };
    const chainlink = { block: 502n, chainTime: T0 + 60, rates: {}, usdc: null, eth };
    const filled = buildRows(input({ receipts: receipts([strangersSwap], { blocks: { "1:502": { time: T0 + 60, chainlink } } }) }));
    const row = filled.rows.find((r) => r.id === strangersSwap.id)!;
    expect(row.valueUsd).toBe(24_513_100n);
    expect(row.valueSource).toBe("chainlink-at-block");
    expect(row.rates).toBe(chainlink);
  });

  it("keeps a tip as what left the wallet, which bought nothing", () => {
    expect(byId(tip.id).sold).toEqual({ token: SPX, amount: 6_900_000_000n, measured: true });
    expect(byId(tip.id).bought.amount).toBe(0n);
  });

  it("numbers plan buys from the newest, whatever the record let go", () => {
    const buys = built.rows.filter((row) => row.kind === "plan-buy");
    expect(buys.map((row) => row.buyIndex)).toEqual([
      { n: 5, of: 69 },
      { n: 4, of: 69 },
    ]);
    expect(buys[1]).toMatchObject({
      sold: { token: NATIVE_TOKEN, amount: 10n ** 16n, measured: false },
      bought: { token: SPX, amount: 690_000_000_000n, measured: true },
      planLabel: "Daily SPX",
      networkFee: 70n,
      at: { unix: T0 + 3 * 86_400, source: "block" },
    });
    expect(built.truncated).toEqual([{ planId: plan.id, planLabel: "Daily SPX", missing: 3 }]);
  });

  it("takes a vault buy from the chain: the owner paid its buy fee and no network fee", () => {
    const buy = built.rows.find((row) => row.kind === "vault-buy")!;
    expect(buy).toMatchObject({
      hashes: [hash(31)],
      block: 610n,
      sold: { token: WETH, amount: 10n ** 16n, measured: true },
      bought: { token: SPX, amount: 700_00000000n, measured: true },
      buyFee: 36_000_000_000_000n,
      networkFee: 0n,
      buyIndex: { n: 3, of: 10 },
    });
  });

  it("says what it doesn't list, and why", () => {
    expect(built.notes).toEqual([
      "The first 3 buys of plan “Daily SPX” aren't listed: this browser keeps the latest 100.",
      "“Vault SPX”: the vault's first 1 buy isn't listed: your network service didn't return its older history.",
      "1 vault buy isn't listed because spDEX couldn't read when it happened. Opening this again tries again.",
    ]);
    const unreadable = buildRows(input({ receipts: "unavailable", ledger: "unavailable", vaults: [{ plan: vaultPlan, owner: ME, tokenOut: SPX, maxBuys: 10, buysDone: 3, error: "429" }] }));
    expect(unreadable.rows).toEqual([]);
    expect(unreadable.notes).toEqual([
      "This browser's record of your swaps and tips couldn't be read, so they aren't listed. spDEX left it as it was.",
      "This browser's record of your plans' buys couldn't be read, so they aren't listed.",
      "“Vault SPX”: spDEX couldn't read the vault's buys (429).",
    ]);
    const dropped = buildRows(input({ receipts: { ...receipts([]), dropped: 2 } }));
    expect(dropped.notes[0]).toBe("The oldest 2 swaps and tips recorded here aren't listed: this browser keeps the latest 1,000.");
  });

  it("lists a deleted plan's buys from the receipts it kept, exactly as its record listed them, and once", () => {
    const kept = planBuyReceipts(plan, entry);
    // The two confirmed buys the record holds, oldest first, with the plan's name and their numbers.
    expect(kept.map((r) => [r.id, r.plan])).toEqual([
      [`plan-buy:1:${plan.id}:3`, { id: plan.id, label: "Daily SPX", n: 4, of: 69 }],
      [`plan-buy:1:${plan.id}:5`, { id: plan.id, label: "Daily SPX", n: 5, of: 69 }],
    ]);
    // Stored as JSON and read back unchanged.
    expect(kept.map((r) => parseReceipt(JSON.parse(JSON.stringify(r))))).toEqual(kept);
    const before = built.rows.filter((row) => row.kind === "plan-buy");
    // The plan and its record gone, the kept receipts list the same rows.
    const after = buildRows(input({ plans: [vaultPlan], ledger: { version: 1, entries: {} }, receipts: receipts([swap, strangersSwap, unreadSwap, otherChain, tip, ...kept]) }));
    const rows = after.rows.filter((row) => row.kind === "plan-buy");
    expect(rows.map(({ id, sold, bought, planId, planLabel, buyIndex, networkFee, at }) => ({ id, sold, bought, planId, planLabel, buyIndex, networkFee, at }))).toEqual(
      before.map(({ id, sold, bought, planId, planLabel, buyIndex, networkFee, at }) => ({ id, sold, bought, planId, planLabel, buyIndex, networkFee, at })),
    );
    expect(after.notes.some((note) => note.includes("no longer in your settings"))).toBe(false);
    // A record that outlived its delete (removing it failed) doesn't list them twice.
    const both = buildRows(input({ receipts: receipts([swap, ...kept]) }));
    expect(both.rows.filter((row) => row.kind === "plan-buy")).toHaveLength(2);
    // A kept buy without its plan is not one.
    expect(parseReceipt({ ...kept[0], plan: undefined })).toBeNull();
  });

  it("keeps a tip's swap and count through storage, and drops either alone when it doesn't parse", () => {
    const linked: StoredReceipt = { ...tip, forSwap: swap.id, recipients: 3 };
    expect(parseReceipt(JSON.parse(JSON.stringify(linked)))).toEqual(linked);
    expect(parseReceipt({ ...linked, forSwap: "swap:1:0xnot-a-hash" })).toEqual({ ...tip, recipients: 3 });
    expect(parseReceipt({ ...linked, recipients: 0 })).toEqual({ ...tip, forSwap: swap.id });
    expect(parseReceipt({ ...linked, recipients: "3" })).toEqual({ ...tip, forSwap: swap.id });
    // Only a tip names a swap.
    expect(parseReceipt({ ...swap, forSwap: swap.id, recipients: 3 })).toEqual(swap);
  });

  it("can't list the buys of a plan no longer in the settings, and says so", () => {
    const orphaned = buildRows(input({ plans: [vaultPlan] }));
    expect(orphaned.rows.some((row) => row.kind === "plan-buy")).toBe(false);
    expect(orphaned.notes).toContain("2 buys of plans no longer in your settings aren't listed.");
  });
});

describe("whose rows", () => {
  const built = buildRows(input());

  it("shows the connected account's rows and the ones no wallet could be told for, never another wallet's", () => {
    const mine = rowsFor(built, ME.toUpperCase().replace("0X", "0x"));
    expect(mine.some((row) => row.account === SOMEONE)).toBe(false);
    expect(mine.filter((row) => row.account === null).map((row) => row.id)).toEqual(["plan-buy:1:daily-spx:5", unreadSwap.id]);
    expect(unattributedNote(mine)).toBe("Couldn't tell which wallet made 2 of these; they're left out of the totals.");
    expect(rowsFor(built, null)).toEqual([]);
    expect(unattributedNote(rowsFor(built, SOMEONE).filter((row) => row.account !== null))).toBeNull();
  });
});

describe("what still has to be read", () => {
  it("asks for receipts not yet read, newest first, and block times not yet known", () => {
    const pending = pendingReads(input());
    // The failed buy's transaction isn't needed: a failed buy isn't a row.
    expect(pending.hashes).toEqual([hash(4), hash(22), hash(23)]);
    expect(pending.blocks).toEqual([503n, 502n, 600n]);
  });

  it("asks for nothing when the store can't be read", () => {
    expect(pendingReads(input({ receipts: "unavailable" }))).toEqual({ hashes: [], blocks: [] });
  });
});
