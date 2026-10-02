/**
 * Help run the network: which due buys a batch from a tab makes, what it may
 * cost, and what is read back once it settled.
 *
 * The rules pinned here are the ones money depends on: nothing is offered
 * unless the test-run's fees cover its gas at the very price signed, the
 * batch is always the test-run's own list, the reward always goes to the
 * wallet that sends it, WETH someone left in the batcher is never passed on,
 * and only the batcher's own `Batch` says what was earned.
 */

import { describe, expect, it } from "vitest";
import { TOKENS, transactionHash, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import { BATCHER_EVENT_TOPICS, batchGasLimit, type BatchCandidate } from "@spdex/vault";
import { GAS_RESERVE_WEI } from "../tokens.js";
import {
  affordablePrefix,
  batchIntent,
  buttonText,
  chooseVaults,
  ifFirstRelayText,
  introText,
  minRewardsFor,
  modelledFee,
  needsBalanceText,
  noneWouldBuyText,
  notCoveredText,
  planHelpRun,
  preflight,
  batchResultOf,
  resultText,
  revertProtected,
  unaccountedText,
  waitForBatch,
  walletFeeText,
  youGetText,
  youPayText,
} from "./batch.js";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
const BATCHER = "0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0" as Address;
const GWEI = 1_000_000_000n;
const vaultAt = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

// ── Hand-made ABI encoding (the web app has no viem) ──────────────────────────

const hexOf = (text: string) => `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const selector = (signature: string) => transactionHash(hexOf(signature)).slice(0, 10) as Hex;
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");
const addressWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const bytes4Word = (b: Hex) => b.slice(2).padEnd(64, "0");
const BOUGHT_REASON = "0x00000000" as Hex;
const TOO_SOON = selector("TooSoon(uint256)");
const BELOW_FLOOR = selector("PriceBelowFloor(uint256,uint256)");
const BOUGHT_TOPIC = transactionHash(hexOf("Bought(uint256,uint256,uint256,address,uint256,uint256,uint256,uint256)"));

/** `(uint256 bought, uint256 earned, bytes4[] reasons)`. */
function batchReturn(bought: number, earned: bigint, reasons: readonly Hex[]): Hex {
  return `0x${word(bought)}${word(earned)}${word(96)}${word(reasons.length)}${reasons.map(bytes4Word).join("")}` as Hex;
}
function nothingBought(reasons: readonly Hex[]): Hex {
  return `${selector("NothingBought(bytes4[])")}${word(32)}${word(reasons.length)}${reasons.map(bytes4Word).join("")}` as Hex;
}

interface Log {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
}
const boughtLog = (vault: Address, keeper: Address, reward: bigint): Log => ({
  address: vault,
  topics: [BOUGHT_TOPIC, `0x${word(1)}`, `0x${addressWord(keeper)}`],
  data: `0x${word(10n ** 16n)}${word(6_900n * 10n ** 8n)}${word(reward)}${word(6_000n * 10n ** 8n)}${word(1)}${word(10n ** 20n)}`,
});
const triggeredLog = (vault: Address, received: bigint, from = BATCHER): Log => ({
  address: from,
  topics: [BATCHER_EVENT_TOPICS.Triggered, `0x${addressWord(vault)}`],
  data: `0x${word(received)}${word(150_000)}`,
});
const notTriggeredLog = (vault: Address, reason: Hex): Log => ({
  address: BATCHER,
  topics: [BATCHER_EVENT_TOPICS.NotTriggered, `0x${addressWord(vault)}`, `0x${bytes4Word(reason)}`],
  data: `0x${word(30_000)}`,
});
const batchLog = (fields: { listed: number; bought: number; earned: bigint; swept?: bigint; from?: Address; caller?: Address }): Log => ({
  address: fields.from ?? BATCHER,
  topics: [BATCHER_EVENT_TOPICS.Batch, `0x${addressWord(fields.caller ?? ME)}`, `0x${addressWord(fields.caller ?? ME)}`],
  data: `0x${word(fields.listed)}${word(fields.listed)}${word(fields.bought)}${word(fields.earned)}${word(fields.swept ?? 0n)}`,
});
const indexed = (logs: Log[]): Log[] => logs.map((log, i) => ({ ...log, logIndex: `0x${i.toString(16)}` }));

// ── Candidates ────────────────────────────────────────────────────────────────

function candidate(n: number, overrides: Partial<BatchCandidate> = {}): BatchCandidate {
  return {
    vault: vaultAt(n),
    owner: OTHER,
    order: BigInt(n),
    pair: vaultAt(9_000),
    amountPerBuy: 5n * 10n ** 16n,
    interval: 86_400n,
    reward: 360_000n * GWEI,
    firstBuy: false,
    urgent: false,
    deadline: 1_000n,
    subsidised24h: 0n,
    ...overrides,
  };
}

/**
 * A network service whose test-run answers per list of vaults: each vault
 * listed buys when `buys` says so, earning `reward`, and the batch uses
 * `gasPer` a vault plus 60,000.
 */
function simulatingRpc(options: {
  buys: (vault: Address) => boolean;
  reward?: bigint;
  gasPer?: bigint;
  swept?: bigint;
  failWith?: Error;
}) {
  const asked: { vaults: Address[]; gas: bigint; from: string; to: string }[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method !== "eth_simulateV1") throw new Error(`unexpected ${method}`);
    if (options.failWith) throw options.failWith;
    const call = (params[0] as { blockStateCalls: { calls: { from: string; to: string; data: string; gas: string }[] }[] })
      .blockStateCalls[0]!.calls[0]!;
    // executeBatch(address[],address,uint256): the array starts at word 3.
    const body = call.data.slice(10);
    const count = Number(BigInt(`0x${body.slice(64 * 3, 64 * 4)}`));
    const vaults = Array.from({ length: count }, (_, i) => `0x${body.slice(64 * (4 + i) + 24, 64 * (5 + i))}` as Address);
    asked.push({ vaults, gas: BigInt(call.gas), from: call.from, to: call.to });
    const reward = options.reward ?? 360_000n * GWEI;
    const reasons = vaults.map((v) => (options.buys(v) ? BOUGHT_REASON : TOO_SOON));
    const bought = reasons.filter((r) => r === BOUGHT_REASON).length;
    const gasUsed = 60_000n + BigInt(count) * (options.gasPer ?? 120_000n);
    if (bought === 0) {
      return [{ calls: [{ status: "0x0", gasUsed: `0x${gasUsed.toString(16)}`, returnData: nothingBought(reasons), logs: [] }] }];
    }
    const logs: Log[] = [];
    for (const vault of vaults) {
      if (options.buys(vault)) logs.push(boughtLog(vault, BATCHER, reward), triggeredLog(vault, reward));
      else logs.push(notTriggeredLog(vault, TOO_SOON));
    }
    logs.push(batchLog({ listed: count, bought, earned: reward * BigInt(bought), swept: options.swept ?? 0n }));
    return [
      {
        calls: [
          {
            status: "0x1",
            gasUsed: `0x${gasUsed.toString(16)}`,
            returnData: batchReturn(bought, reward * BigInt(bought), reasons),
            logs: indexed(logs),
          },
        ],
      },
    ];
  };
  return { rpc, asked };
}

describe("choosing and sizing", () => {
  it("takes small buys first, at most 20, among the person's ticks when given", () => {
    const due = [candidate(1, { amountPerBuy: 9n * 10n ** 16n }), candidate(2, { amountPerBuy: 10n ** 16n }), candidate(3)];
    expect(chooseVaults(due, GWEI).map((v) => v.vault)).toEqual([vaultAt(2), vaultAt(3), vaultAt(1)]);
    expect(chooseVaults(due, GWEI, new Set([vaultAt(1), vaultAt(3)])).map((v) => v.vault)).toEqual([vaultAt(3), vaultAt(1)]);
    const many = Array.from({ length: 30 }, (_, i) => candidate(i + 1));
    expect(chooseVaults(many, GWEI)).toHaveLength(20);
  });

  it("plans no loss: fees that don't pay for their gas are left out", () => {
    expect(chooseVaults([candidate(1, { reward: 1_000n })], GWEI)).toEqual([]);
  });

  it("rounds minRewards up, with 10% on top of the test-run's gas at the price signed", () => {
    expect(minRewardsFor(300_000n, GWEI)).toBe(330_000n * GWEI);
    expect(minRewardsFor(1n, 1n)).toBe(2n); // 1.1 → 2
    expect(minRewardsFor(10n, 1n)).toBe(11n);
  });

  it("takes the longest start of the batch whose maximum network fee the wallet can put up, keeping the reserve", () => {
    const list = [candidate(1), candidate(2), candidate(3)];
    const two = batchGasLimit(list.slice(0, 2)) * GWEI;
    expect(affordablePrefix(list, GWEI, GAS_RESERVE_WEI + two)).toHaveLength(2);
    expect(affordablePrefix(list, GWEI, GAS_RESERVE_WEI + two - 1n)).toHaveLength(1);
    expect(affordablePrefix(list, GWEI, GAS_RESERVE_WEI)).toHaveLength(0);
  });

  it("models a fee from the keeper's gas figures", () => {
    expect(modelledFee([{ firstBuy: false }], GWEI)).toBe((160_000n + 106_000n) * GWEI);
    expect(modelledFee([{ firstBuy: true }], GWEI)).toBe((160_000n + 106_000n + 51_000n) * GWEI);
  });
});

describe("preflight", () => {
  it("test-runs executeBatch(list, account, 0) from the account at the signed gas limit, and reads its figures", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const run = await preflight(rpc, { account: ME, batcher: BATCHER, vaults: [vaultAt(1), vaultAt(2)], gasLimit: 774_000n });
    expect(asked).toEqual([{ vaults: [vaultAt(1), vaultAt(2)], gas: 774_000n, from: ME, to: BATCHER }]);
    expect(run).toMatchObject({ kind: "ran", gasUsed: 300_000n, bought: 2n, earned: 720_000n * GWEI, swept: 0n });
  });

  it("reads NothingBought's reasons, vault by vault", async () => {
    const { rpc } = simulatingRpc({ buys: () => false });
    const run = await preflight(rpc, { account: ME, batcher: BATCHER, vaults: [vaultAt(1)], gasLimit: 647_000n });
    expect(run).toMatchObject({ kind: "ran", bought: 0n, earned: null });
    expect(run.kind === "ran" && run.outcomes.map((o) => o.reasonName)).toEqual(["TooSoon"]);
  });

  it("says why when the test-run can't be read", async () => {
    const { rpc } = simulatingRpc({ buys: () => true, failWith: new Error("eth_simulateV1: rate limited") });
    expect(await preflight(rpc, { account: ME, batcher: BATCHER, vaults: [vaultAt(1)], gasLimit: 1n })).toEqual({
      kind: "failed",
      reason: "eth_simulateV1: rate limited",
    });
    const empty = async () => [{ calls: [] }];
    expect((await preflight(empty, { account: ME, batcher: BATCHER, vaults: [vaultAt(1)], gasLimit: 1n })).kind).toBe("failed");
    const other = async () => [{ calls: [{ status: "0x0", gasUsed: "0x1", returnData: "0x08c379a0" }] }];
    expect((await preflight(other, { account: ME, batcher: BATCHER, vaults: [vaultAt(1)], gasLimit: 1n })).kind).toBe("failed");
  });
});

describe("planHelpRun", () => {
  const plenty = 10n ** 18n;

  it("offers the test-run's own list, with minRewards from its gas at the price read", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const due = [candidate(1), candidate(2)];
    const plan = await planHelpRun({ rpc, account: ME, batcher: BATCHER, due, gasPrice: GWEI, balance: plenty });
    expect(plan.kind).toBe("offer");
    if (plan.kind !== "offer") return;
    expect(plan.vaults.map((v) => v.vault)).toEqual([vaultAt(1), vaultAt(2)]);
    expect(plan.gasLimit).toBe(batchGasLimit(due));
    expect(plan.gasUsed).toBe(300_000n);
    expect(plan.minRewards).toBe(330_000n * GWEI);
    expect(plan.earned).toBe(720_000n * GWEI);
    expect(asked).toHaveLength(1);

    // The intent pays the account, and nobody else.
    expect(batchIntent(plan, ME, 690069)).toEqual({
      version: 1,
      action: "batch",
      chainId: 690069,
      account: ME,
      vaults: [vaultAt(1), vaultAt(2)],
      rewardTo: ME,
      minRewards: 330_000n * GWEI,
      gasLimit: batchGasLimit(due),
      gasPrice: GWEI,
    });
  });

  it("drops the vaults that wouldn't buy and test-runs the rest again, so the figures are the batch's own", async () => {
    const { rpc, asked } = simulatingRpc({ buys: (v) => v !== vaultAt(2) });
    const plan = await planHelpRun({
      rpc,
      account: ME,
      batcher: BATCHER,
      due: [candidate(1), candidate(2), candidate(3)],
      gasPrice: GWEI,
      balance: plenty,
    });
    expect(asked.map((a) => a.vaults)).toEqual([
      [vaultAt(1), vaultAt(2), vaultAt(3)],
      [vaultAt(1), vaultAt(3)],
    ]);
    expect(plan.kind === "offer" && plan.vaults.map((v) => v.vault)).toEqual([vaultAt(1), vaultAt(3)]);
    expect(plan.kind === "offer" && plan.gasLimit).toBe(asked[1]!.gas);
  });

  it("says nothing is due, or that none would go through, naming the vaults' reasons", async () => {
    const { rpc } = simulatingRpc({ buys: () => false });
    expect(await planHelpRun({ rpc, account: ME, batcher: BATCHER, due: [], gasPrice: GWEI, balance: plenty })).toEqual({ kind: "none-due" });
    expect(await planHelpRun({ rpc, account: ME, batcher: BATCHER, due: [candidate(1)], gasPrice: GWEI, balance: plenty })).toEqual({
      kind: "none-would-buy",
      reasons: ["TooSoon"],
    });
  });

  it("offers nothing when the fees don't cover the network fee at the price signed", async () => {
    // The keeper's model says it pays, but the test-run used far more gas.
    const { rpc } = simulatingRpc({ buys: () => true, gasPer: 400_000n });
    const plan = await planHelpRun({ rpc, account: ME, batcher: BATCHER, due: [candidate(1)], gasPrice: GWEI, balance: plenty });
    expect(plan).toEqual({ kind: "not-covered", due: 1, fees: 360_000n * GWEI, cost: 460_000n * GWEI });
    // And the keeper's model alone can already say no.
    const poor = await planHelpRun({ rpc, account: ME, batcher: BATCHER, due: [candidate(1, { reward: 1_000n })], gasPrice: GWEI, balance: plenty });
    expect(poor).toEqual({ kind: "not-covered", due: 1, fees: 1_000n, cost: modelledFee([candidate(1)], GWEI) });
  });

  it("never offers a batch that would pass on WETH someone sent the batcher", async () => {
    const { rpc } = simulatingRpc({ buys: () => true, swept: 5n });
    expect(await planHelpRun({ rpc, account: ME, batcher: BATCHER, due: [candidate(1)], gasPrice: GWEI, balance: plenty })).toEqual({
      kind: "unaccounted",
      swept: 5n,
    });
  });

  it("cuts the batch to what the wallet can put up, and test-runs the shorter one", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const due = [candidate(1), candidate(2), candidate(3)];
    const balance = GAS_RESERVE_WEI + batchGasLimit(due.slice(0, 2)) * GWEI;
    const plan = await planHelpRun({ rpc, account: ME, batcher: BATCHER, due, gasPrice: GWEI, balance });
    expect(asked.map((a) => a.vaults)).toEqual([[vaultAt(1), vaultAt(2)]]);
    expect(plan.kind === "offer" && plan.vaults).toHaveLength(2);
  });

  it("says what the wallet would need when not even one buy fits", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const plan = await planHelpRun({ rpc, account: ME, batcher: BATCHER, due: [candidate(1)], gasPrice: GWEI, balance: 10n ** 15n });
    expect(plan).toEqual({
      kind: "needs-balance",
      need: batchGasLimit([candidate(1)]) * GWEI + GAS_RESERVE_WEI,
      fee: modelledFee([candidate(1)], GWEI),
      balance: 10n ** 15n,
    });
    expect(asked).toEqual([]);
  });
});

describe("what a settled batch did", () => {
  const hash = `0x${"ab".repeat(32)}` as Hex;
  /** The batch's receipt as a node gives it: 300,000 gas at 1 gwei. */
  const node = (logs: Log[], status = "0x1") => ({
    from: ME,
    status,
    blockNumber: "0x18cba81",
    blockHash: `0x${"cd".repeat(32)}`,
    gasUsed: "0x493e0",
    effectiveGasPrice: "0x3b9aca00",
    logs: indexed(logs),
  });
  const receipt = (logs: Log[], status = "0x1") => async (method: string) => {
    if (method !== "eth_getTransactionReceipt") throw new Error(`unexpected ${method}`);
    return node(logs, status);
  };
  const settled = async (rpc: JsonRpc, vaults: Address[]) =>
    (await waitForBatch(rpc, { hash, batcher: BATCHER, vaults }, { timeoutMs: 0 }))?.result ?? null;

  it("reads what was earned from the batcher's own Batch event, and names each vault that didn't buy", async () => {
    const reward = 360_000n * GWEI;
    const rpc = receipt([
      boughtLog(vaultAt(1), BATCHER, reward),
      triggeredLog(vaultAt(1), reward),
      notTriggeredLog(vaultAt(2), BELOW_FLOOR),
      batchLog({ listed: 2, bought: 1, earned: reward }),
    ]);
    const result = await settled(rpc, [vaultAt(1), vaultAt(2)]);
    expect(result).toEqual({
      status: "success",
      made: 1,
      of: 2,
      earned: reward,
      fee: 300_000n * GWEI,
      untriggered: [{ vault: vaultAt(2), reason: "PriceBelowFloor" }],
    });
    expect(resultText(result!)).toBe("Made 1 of 2 buys. You received 0.00036 WETH in buy fees. Network fee paid: 0.0003 ETH.");
  });

  it("believes no Batch another contract emitted", async () => {
    const result = await settled(receipt([batchLog({ listed: 1, bought: 1, earned: 10n ** 18n, from: OTHER })]), [vaultAt(1)]);
    expect(result?.earned).toBeNull();
    expect(result?.made).toBe(0);
    expect(resultText(result!)).toBe("Made 0 of 1 buy. Network fee paid: 0.0003 ETH.");
  });

  it("reads a reverted batch as nothing made and nothing received, with its fee spent", async () => {
    const result = await settled(receipt([], "0x0"), [vaultAt(1)]);
    expect(result).toMatchObject({ status: "reverted", made: 0, earned: 0n, fee: 300_000n * GWEI });
    expect(resultText(result!)).toBe(
      "Nothing was bought, so you received nothing. Someone may have made these buys first. Network fee paid: 0.0003 ETH.",
    );
  });

  it("asks until the receipt arrives, hands back the receipt it read, and gives up at the deadline", async () => {
    let asked = 0;
    let time = 0;
    const rpc: JsonRpc = async () => (++asked < 3 ? null : node([batchLog({ listed: 1, bought: 1, earned: 5n })]));
    const clock = { sleep: async (ms: number) => void (time += ms), now: () => time };
    const read = await waitForBatch(rpc, { hash, batcher: BATCHER, vaults: [vaultAt(1)] }, { timeoutMs: 10_000, ...clock });
    expect(asked).toBe(3);
    expect(read?.receipt).toMatchObject({ hash, from: ME.toLowerCase(), status: "success", fee: 300_000n * GWEI });
    expect(batchResultOf(read!.receipt, { batcher: BATCHER, vaults: [vaultAt(1)] })).toEqual(read!.result);
    expect(await waitForBatch(async () => null, { hash, batcher: BATCHER, vaults: [] }, { timeoutMs: 5_000, ...clock })).toBeNull();
  });

  it("reads a receipt whose batcher logs can't be joined as not settled yet, never as a batch that didn't go out", async () => {
    // A batcher log with no logIndex is what `joinBatchLogs` refuses; the batch was still sent.
    let time = 0;
    const clock = { sleep: async (ms: number) => void (time += ms), now: () => time };
    const rpc: JsonRpc = async () => ({ ...node([]), logs: [batchLog({ listed: 1, bought: 1, earned: 5n })] });
    expect(await waitForBatch(rpc, { hash, batcher: BATCHER, vaults: [vaultAt(1)] }, { timeoutMs: 5_000, ...clock })).toBeNull();
  });
});

describe("relays", () => {
  it("counts only Flashbots Protect and MEV Blocker's /noreverts as leaving out a failing transaction", () => {
    expect(revertProtected("https://rpc.flashbots.net/fast")).toBe(true);
    expect(revertProtected("https://rpc.flashbots.net")).toBe(true);
    expect(revertProtected("https://rpc.mevblocker.io/noreverts")).toBe(true);
    expect(revertProtected("https://rpc.mevblocker.io")).toBe(false);
    expect(revertProtected("https://rpc.mevblocker.io/fast")).toBe(false);
    expect(revertProtected("http://rpc.flashbots.net")).toBe(false);
    expect(revertProtected("https://rpc.flashbots.net.evil.example")).toBe(false);
    // Options can change what a relay does with a failing transaction, so only the plain forms count.
    expect(revertProtected("https://rpc.flashbots.net/fast?useMempool=true")).toBe(false);
    expect(revertProtected("https://rpc.flashbots.net?hint=calldata")).toBe(false);
    expect(revertProtected("https://rpc.flashbots.net/other")).toBe(false);
    expect(revertProtected("https://rpc.flashbots.net/fast/")).toBe(true);
    expect(revertProtected("https://rpc.mevblocker.io/noreverts?x=1")).toBe(false);
    expect(revertProtected(null)).toBe(false);
    expect(ifFirstRelayText("https://rpc.flashbots.net/fast")).toBe(
      "Your relay doesn't include a transaction that would fail, so then it costs nothing.",
    );
    expect(ifFirstRelayText("https://relay.example")).toBe("Your relay may still include it, and then it costs its network fee.");
  });
});

describe("words", () => {
  const money = {
    usd: new Map([[TOKENS.WETH.address.toLowerCase(), 2_200_000_000n]]),
    fx: null,
    currency: "USD" as const,
    locale: "en-US",
  };

  it("says what is paid and got, with money only when a rate is fresh", () => {
    expect(introText(3)).toBe(
      "3 vault buys are due right now. Any wallet can make a due buy and is paid its buy fee — " +
        "that's how vaults keep buying with spDEX closed. You'd make them in one transaction.",
    );
    // Fewer offered than due: the list below counts every due one, so this can't say only one is due.
    expect(introText(1, 10)).toMatch(/^1 vault buy pays for itself right now, of the 10 due\. .* You'd make it in one transaction\.$/);
    expect(introText(2, 3)).toMatch(/^2 vault buys pay for themselves right now, of the 3 due\./);
    expect(introText(1, 3, false)).toMatch(/^1 vault buy pays for itself right now, of the 3 ticked\./);
    expect(youPayText(210_000n * GWEI)).toBe("about 0.00021 ETH network fee");
    expect(youPayText(210_000n * GWEI, money)).toBe("about 0.00021 ETH network fee (≈\u00a0$0.46 at today's fees)");
    expect(youGetText(380_000n * GWEI, money)).toBe(
      "0.00038 WETH in buy fees (≈\u00a0$0.84). WETH is ETH as a token; turning it back into ETH costs a network fee too.",
    );
    expect(walletFeeText(3_060_000n * GWEI)).toBe(
      "Your wallet will show a maximum network fee of up to 0.00306 ETH: each vault is given room to run. You pay only for what's used.",
    );
    // A maximum is never shown below itself; an estimate is short.
    expect(walletFeeText(3_060_001n * GWEI)).toContain("up to 0.00307 ETH");
    expect(youPayText(267_690n * GWEI)).toBe("about 0.00027 ETH network fee");
    expect(buttonText(3)).toBe("Make 3 buys for these vaults");
    expect(buttonText(1)).toBe("Make 1 buy for this vault");
  });

  it("says why nothing is offered", () => {
    expect(notCoveredText(2, 20_000n * GWEI, 300_000n * GWEI)).toBe(
      "2 buys due · their buy fees (0.00002 WETH) are below the network fee (≈ 0.0003 ETH). Not offered.",
    );
    expect(notCoveredText(1, 20_000n * GWEI, 300_000n * GWEI)).toBe(
      "1 buy due · its buy fee (0.00002 WETH) is below the network fee (≈ 0.0003 ETH). Not offered.",
    );
    expect(noneWouldBuyText(["TooSoon", "PriceBelowFloor"])).toBe("No vault buy would go through right now (TooSoon, PriceBelowFloor).");
    expect(needsBalanceText(10_647_000n * GWEI, 266_000n * GWEI, 10n ** 15n)).toBe(
      "Your wallet needs at least 0.0107 ETH on hand to send this, though only about 0.00027 ETH is spent. It holds 0.001 ETH.",
    );
    expect(unaccountedText(5n * 10n ** 14n)).toBe(
      "The batcher holds 0.0005 WETH someone sent it, and this batch would pass it to you. spDEX won't make you the receiver of money it can't account for.",
    );
  });
});
