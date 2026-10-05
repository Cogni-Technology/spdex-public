/**
 * Help run the network: which due buys a batch from a tab makes, what it may
 * cost, and what is read back once it settled.
 *
 * The rules pinned here are the ones money depends on: nothing is offered
 * unless the test-run's fees cover its gas at the very price signed, the
 * batch is always the test-run's own list, the reward always goes to the
 * wallet that sends it, a buy inside its community window is offered only to
 * a wallet the registry finds eligible, and only the batcher's own `Batch`
 * says what was earned — of which the wallet's own vaults' fees are its own
 * budget coming back, never earnings. v2's batcher holds no
 * WETH, so there is nothing else in a batch to account for.
 */

import { describe, expect, it } from "vitest";
import { TOKENS, transactionHash, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import {
  BATCHER_EVENT_TOPICS,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  MIN_SPX,
  batchGasLimit,
  bucketOf,
  predictVault,
  turnOf,
  type BatchCandidate,
  type DueCandidate,
  type HolderStatus,
  type VaultTerms,
} from "@spdex/vault";
import type { VaultClaim } from "@spdex/guard";
import { clockText } from "../money/format.js";
import { GAS_RESERVE_WEI } from "../tokens.js";
import {
  COMMUNITY_KEEPING_TEXT,
  KEEPER_TEXT,
  NONE_DUE_TEXT,
  PUBLIC_SENDING_TEXT,
  TERMS_TEXT,
  affordablePrefix,
  batchIntent,
  buttonText,
  chooseVaults,
  claimsOf,
  eligibleInNextBlock,
  feesEarnedFromOthers,
  holdersFirstText,
  ifFirstRelayText,
  introText,
  minRewardsFor,
  modelledFee,
  needsBalanceText,
  needsEligibility,
  noneWouldBuyText,
  notCoveredText,
  planHelpRun,
  preflight,
  batchResultOf,
  resultText,
  revertProtected,
  splitByWindow,
  spxText,
  turnHeldText,
  waitForBatch,
  walletFeeText,
  walletKeeperText,
  youGetText,
  youPayText,
} from "./batch.js";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
/** v2's batcher: the only one Help run sends to. */
/** The listed batcher, bound to no factory, which every release from v2 on shares. */
const BATCHER = MAINNET_BATCHER as Address;
const TOPICS = BATCHER_EVENT_TOPICS.v2;
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
/** v2's `Bought`: `rewardTo` indexed after `keeper`, and `dueSince` last. */
const BOUGHT_TOPIC = transactionHash(hexOf("Bought(uint256,uint256,uint256,address,uint256,uint256,uint256,uint256,address,uint256)"));

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
/** A v2 vault's `Bought`, made through the batcher (`keeper`) and paid to `rewardTo`, the wallet that sent the batch. */
const boughtLog = (vault: Address, keeper: Address, reward: bigint, rewardTo: Address = ME): Log => ({
  address: vault,
  topics: [BOUGHT_TOPIC, `0x${word(1)}`, `0x${addressWord(keeper)}`, `0x${addressWord(rewardTo)}`],
  data: `0x${word(10n ** 16n)}${word(6_900n * 10n ** 8n)}${word(reward)}${word(6_000n * 10n ** 8n)}${word(1)}${word(10n ** 20n)}${word(1_790_000_000n)}`,
});
const triggeredLog = (vault: Address, received: bigint, from = BATCHER): Log => ({
  address: from,
  topics: [TOPICS.Triggered, `0x${addressWord(vault)}`],
  data: `0x${word(received)}${word(150_000)}`,
});
const notTriggeredLog = (vault: Address, reason: Hex): Log => ({
  address: BATCHER,
  topics: [TOPICS.NotTriggered, `0x${addressWord(vault)}`, `0x${bytes4Word(reason)}`],
  data: `0x${word(30_000)}`,
});
/** v2's `Batch`: listed, tried, bought, earned. No `swept`: no WETH passes through v2's batcher. */
const batchLog = (fields: { listed: number; bought: number; earned: bigint; from?: Address; caller?: Address }): Log => ({
  address: fields.from ?? BATCHER,
  topics: [TOPICS.Batch, `0x${addressWord(fields.caller ?? ME)}`, `0x${addressWord(fields.caller ?? ME)}`],
  data: `0x${word(fields.listed)}${word(fields.listed)}${word(fields.bought)}${word(fields.earned)}`,
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
  failWith?: Error;
}) {
  const asked: { vaults: Address[]; gas: bigint; from: string; to: string }[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method !== "eth_simulateV1") throw new Error(`unexpected ${method}`);
    if (options.failWith) throw options.failWith;
    const call = (params[0] as { blockStateCalls: { calls: { from: string; to: string; data: string; gas: string }[] }[] })
      .blockStateCalls[0]!.calls[0]!;
    // executeBatch(address[],address,uint256,uint256): the array's offset is
    // the first word, and its length the word there.
    const body = call.data.slice(10);
    const at = Number(BigInt(`0x${body.slice(0, 64)}`)) / 32;
    const count = Number(BigInt(`0x${body.slice(64 * at, 64 * (at + 1))}`));
    const vaults = Array.from({ length: count }, (_, i) => `0x${body.slice(64 * (at + 1 + i) + 24, 64 * (at + 2 + i))}` as Address);
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
    logs.push(batchLog({ listed: count, bought, earned: reward * BigInt(bought) }));
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

  it("models a fee from the keeper's gas figures, a v2 buy's", () => {
    expect(modelledFee([{ firstBuy: false }], GWEI)).toBe((160_000n + 110_000n) * GWEI);
    expect(modelledFee([{ firstBuy: true }], GWEI)).toBe((160_000n + 110_000n + 51_000n) * GWEI);
  });
});

// ── Holders first ─────────────────────────────────────────────────────────────

const REGISTRY = "0x2c7f732a453fe0a4a65f36ac564ff16007b5610d" as Address;
const SPX_UNIT = 10n ** 8n;
/** When the window the fixtures are in ends, chain time. */
const ENDS = 1_790_001_800n;

/** A daily plan's terms, starting a day before the window the fixtures are in, with no turns. */
const DUE_TERMS: VaultTerms = {
  tokenOut: MAINNET_DEPLOYMENT.markets[0]!.tokenOut,
  pair: MAINNET_DEPLOYMENT.markets[0]!.pair,
  oraclePool: MAINNET_DEPLOYMENT.markets[0]!.oraclePool,
  amountPerBuy: 5n * 10n ** 16n,
  interval: 86_400n,
  maxBuys: 10n,
  startAt: ENDS - 1_800n - 86_400n,
  keeperReward: 360_000n * GWEI,
  maxSlippageBps: 200n,
  communityWindow: 1_800n,
  turnBuckets: 0n,
};

function due(n: number, overrides: Partial<DueCandidate> = {}): DueCandidate {
  return {
    ...candidate(n),
    buysDone: 1n,
    weth: 10n ** 18n,
    spotOut: 10n ** 12n,
    floorOut: 10n ** 11n,
    dueSince: ENDS - 1_800n,
    windowEndsAt: ENDS,
    inWindow: false,
    release: "v2",
    terms: DUE_TERMS,
    turnBuckets: 0n,
    turnEndsAt: null,
    inTurn: false,
    ...overrides,
  };
}

function standing(overrides: Partial<Extract<HolderStatus, { state: "read" }>> = {}): HolderStatus {
  return {
    state: "read",
    registry: REGISTRY,
    holder: ME,
    block: 26_000_000n,
    chainTime: ENDS - 600n,
    eligible: false,
    validUntil: 0n,
    proofValid: false,
    lapsesSoon: false,
    isAccount: true,
    balance: 120n * SPX_UNIT,
    shortfall: 570n * SPX_UNIT,
    reason: "not-proven",
    ...overrides,
  };
}

describe("holders first", () => {
  /**
   * docs/V2_UPGRADE.md's Help run row: "Buys still inside their window are
   * offered only to an eligible wallet." The wallet's own vault is no
   * exception: its card's Trigger now makes that buy at any time.
   */
  it("offers a buy past its window to anyone, and one inside it only to an eligible wallet, its own vault's included", () => {
    const open = due(1);
    const inside = due(2, { inWindow: true, windowEndsAt: ENDS + 60n });
    const sooner = due(3, { inWindow: true, windowEndsAt: ENDS });
    const mine = due(4, { inWindow: true, owner: ME, windowEndsAt: ENDS + 120n });
    const all = [open, inside, sooner, mine];

    // Not eligible, or not known to be: only the open buy.
    for (const eligible of [false, null]) {
      const split = splitByWindow(all, eligible);
      expect(split.offered.map((c) => c.vault)).toEqual([open.vault]);
      expect(split.heldBack.map((c) => c.vault)).toEqual([inside.vault, sooner.vault, mine.vault]);
      // When the first of them opens to anyone.
      expect(split.until).toBe(ENDS);
    }
    // Eligible: every one.
    expect(splitByWindow(all, true)).toEqual({ offered: all, heldBack: [], byTurn: 0, until: null });
  });

  /**
   * A plan with turns (dormant: every vault spDEX creates has none): for the
   * first half of a window, only an eligible wallet in the buy's group is
   * paid, so another eligible wallet is told the buy is another group's turn,
   * and when it opens to it, the turn's end — never offered a buy the vault
   * would refuse `NotYourTurn`. From the turn's end it is offered.
   */
  it("offers a buy inside its turn only to an eligible wallet in that turn's group", () => {
    const k = 4n;
    const turnEndsAt = ENDS - 900n;
    const turnTerms = { ...DUE_TERMS, turnBuckets: k };
    const vault = vaultAt(7);
    const slot = (ENDS - 1_800n - turnTerms.startAt) / turnTerms.interval;
    const turn = turnOf(vault, slot, k);
    const wallet = (inGroup: boolean) => {
      for (let n = 0x100; ; n++) if ((bucketOf(vaultAt(n), k) === turn) === inGroup) return vaultAt(n);
    };
    const inTurn = due(7, { inWindow: true, terms: turnTerms, turnBuckets: k, turnEndsAt, inTurn: true });

    const onTurn = splitByWindow([inTurn], true, wallet(true));
    expect(onTurn).toEqual({ offered: [inTurn], heldBack: [], byTurn: 0, until: null });
    const offTurn = splitByWindow([inTurn], true, wallet(false));
    expect(offTurn).toEqual({ offered: [], heldBack: [inTurn], byTurn: 1, until: turnEndsAt });
    // An ineligible wallet waits for the window's end, as for any plan.
    expect(splitByWindow([inTurn], false, wallet(true))).toMatchObject({ byTurn: 0, until: ENDS });
    // Past the turn, any eligible wallet.
    expect(splitByWindow([{ ...inTurn, inTurn: false }], true, wallet(false)).offered).toHaveLength(1);
    expect(turnHeldText(0)).toBeNull();
    expect(turnHeldText(1)).toMatch(/^1 of them is another group's turn/);
  });

  it("reads the wallet's standing whenever a buy is inside its window, its own vault's too", () => {
    expect(needsEligibility([due(1), due(2)])).toBe(false);
    expect(needsEligibility([due(1, { inWindow: true, owner: ME })])).toBe(true);
    expect(needsEligibility([due(1), due(2, { inWindow: true })])).toBe(true);
  });

  /**
   * The vault asks the registry again in the block the batch lands in, at
   * least a block after the standing was read. A proof that lapses in between
   * would only buy `NotEligible`: the keeper keeps the same margin
   * (`mayBePaidInWindow`).
   */
  it("counts the wallet as eligible only while its proof is still valid a block after the read", () => {
    const now = ENDS - 600n;
    const eligible = { eligible: true, proofValid: true, reason: null, balance: MIN_SPX, shortfall: 0n } as const;
    expect(eligibleInNextBlock(standing({ ...eligible, validUntil: now + 12n }))).toBe(true);
    expect(eligibleInNextBlock(standing({ ...eligible, validUntil: now + 11n }))).toBe(false);
    expect(eligibleInNextBlock(standing({ ...eligible, validUntil: now }))).toBe(false);
    expect(eligibleInNextBlock(standing())).toBe(false);
    // Unknown is never a yes.
    expect(eligibleInNextBlock(standing({ ...eligible, validUntil: null }))).toBeNull();
    expect(eligibleInNextBlock(standing({ ...eligible, validUntil: now + 600n, chainTime: null }))).toBeNull();
    expect(eligibleInNextBlock(standing({ eligible: null }))).toBeNull();
    expect(eligibleInNextBlock(null)).toBeNull();
    expect(eligibleInNextBlock({ state: "not-deployed", registry: REGISTRY, holder: ME, block: null, chainTime: null })).toBeNull();
    // A wallet whose proof lapses before the next block has its in-window buys held back.
    const lapsing = standing({ ...eligible, validUntil: now + 5n });
    expect(splitByWindow([due(1, { inWindow: true })], eligibleInNextBlock(lapsing)).offered).toEqual([]);
  });

  it("says holders have first claim when every due buy is held back, and test-runs nothing", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const base = { rpc, account: ME, batcher: BATCHER, due: [], gasPrice: GWEI, balance: 10n ** 18n };
    expect(await planHelpRun({ ...base, heldBack: { count: 2, until: ENDS } })).toEqual({ kind: "holders-first", due: 2, until: ENDS });
    expect(await planHelpRun({ ...base, heldBack: null })).toEqual({ kind: "none-due" });
    expect(await planHelpRun({ ...base, heldBack: { count: 0, until: ENDS } })).toEqual({ kind: "none-due" });
    expect(asked).toEqual([]);
  });

  it("offers the open buys beside held-back ones as before: the batch is the offered buys' alone", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const split = splitByWindow([due(1), due(2, { inWindow: true })], false);
    const plan = await planHelpRun({
      rpc,
      account: ME,
      batcher: BATCHER,
      due: split.offered,
      gasPrice: GWEI,
      balance: 10n ** 18n,
      heldBack: { count: split.heldBack.length, until: split.until! },
    });
    expect(plan.kind === "offer" && plan.vaults.map((v) => v.vault)).toEqual([vaultAt(1)]);
    expect(asked.map((a) => a.vaults)).toEqual([[vaultAt(1)]]);
  });

  it("says when holders' first claim ends, in this device's time", () => {
    const at = Number(ENDS) * 1000;
    expect(holdersFirstText(ENDS)).toBe(`SPX holders have first claim until ${clockText(at)}.`);
    expect(holdersFirstText(ENDS)).toMatch(/^SPX holders have first claim until \d{2}:\d{2}\.$/);
    expect(holdersFirstText(ENDS, 2)).toBe(`2 more buys are due; SPX holders have first claim until ${clockText(at)}.`);
    expect(holdersFirstText(ENDS, 1)).toMatch(/^1 more buy is due; SPX holders/);
  });

  it("says why the wallet isn't a keeper: a contract first, then its shortfall, then its proof; never a guess", () => {
    expect(walletKeeperText(standing())).toBe("You hold 120 of the 690 SPX.");
    expect(walletKeeperText(standing({ balance: 59_880_000_000n, shortfall: 9_120_000_000n }))).toBe("You hold 598 of the 690 SPX.");
    expect(walletKeeperText(standing({ isAccount: false, reason: "contract" }))).toBe(
      "Only an ordinary account can be paid as a community keeper; this address is a contract.",
    );
    expect(walletKeeperText(standing({ balance: MIN_SPX, shortfall: 0n }))).toBe("Your wallet holds enough SPX, but hasn't proven it.");
    const lapsed = standing({ balance: 2_000n * SPX_UNIT, shortfall: 0n, validUntil: ENDS - 86_400n, reason: "lapsed" });
    expect(walletKeeperText(lapsed)).toMatch(/^Your wallet's proof lapsed on [A-Z][a-z]{2} \d{1,2}\.$/);
    expect(walletKeeperText(standing({ balance: 2_000n * SPX_UNIT, shortfall: 0n, reason: null, validUntil: ENDS, proofValid: true }))).toBe(
      "Your wallet isn't a community keeper right now.",
    );
    // Unknown is said, never a shortfall of 690 or a "no".
    expect(walletKeeperText(null)).toBe("Whether your wallet is a community keeper couldn't be read just now.");
    expect(walletKeeperText(standing({ isAccount: null, reason: null }))).toBe("Whether your wallet is a community keeper couldn't be read just now.");
    // A holding that couldn't be read is never said to be enough.
    expect(walletKeeperText(standing({ balance: null, shortfall: null, reason: "not-proven" }))).toBe("Your wallet hasn't proven its SPX.");
    expect(walletKeeperText({ state: "not-deployed", registry: REGISTRY, holder: ME, block: null, chainTime: null })).toMatch(/registry isn't on this network/);
    expect(spxText(5n)).toBe("less than 1");
    expect(spxText(0n)).toBe("0");
  });

  it("describes keeping as paid work, and no figure as a return", () => {
    const copy = [
      introText(3),
      TERMS_TEXT,
      COMMUNITY_KEEPING_TEXT,
      KEEPER_TEXT,
      NONE_DUE_TEXT,
      PUBLIC_SENDING_TEXT,
      holdersFirstText(ENDS, 2),
      walletKeeperText(standing()),
      walletKeeperText(null),
    ];
    expect(COMMUNITY_KEEPING_TEXT).toBe("Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar.");
    for (const text of copy) expect(text).not.toMatch(/\bAPR\b|\bAPY\b|yield|projected|earnings|reward/i);
  });
});

describe("each vault's claim", () => {
  /**
   * The batcher calls whatever it is given, so the Guard proves each batched
   * vault as it proves the account's own: by where its release's factory puts
   * that owner's vault with that nonce and those terms. A vault none puts
   * there is left out of every offer; one read per owner finds the count.
   */
  it("finds each due vault's nonce under its release's factory, reading each owner's count once, and leaves out one it can't", async () => {
    const real = predictVault({ factory: MAINNET_FACTORY, owner: OTHER, nonce: 1n, terms: DUE_TERMS });
    const alsoReal = predictVault({ factory: MAINNET_FACTORY, owner: OTHER, nonce: 0n, terms: DUE_TERMS });
    const asked: unknown[] = [];
    const rpc: JsonRpc = async (method, params) => {
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      asked.push(params);
      const call = params[0] as { to: string; data: string };
      expect(call.to.toLowerCase()).toBe(MAINNET_FACTORY);
      expect(call.data.slice(-40)).toBe(OTHER.slice(2));
      return `0x${word(2n)}`;
    };
    const claims = await claimsOf(rpc, [due(1, { vault: real }), due(2, { vault: alsoReal }), due(3)], { release: "v2", block: 26_000_000n });
    expect(asked).toHaveLength(1);
    expect(claims.get(real)).toEqual({ address: real, owner: OTHER, nonce: 1n, terms: DUE_TERMS, release: "v2" });
    expect(claims.get(alsoReal)?.nonce).toBe(0n);
    expect(claims.has(vaultAt(3))).toBe(false);
    // An owner whose count can't be read: none of theirs.
    const refusing: JsonRpc = async () => {
      throw new Error("refused");
    };
    expect((await claimsOf(refusing, [due(1, { vault: real })], { release: "v2" })).size).toBe(0);
  });
});

describe("preflight", () => {
  it("test-runs executeBatch(list, account, 0) from the account at the signed gas limit, and reads its figures", async () => {
    const { rpc, asked } = simulatingRpc({ buys: () => true });
    const run = await preflight(rpc, { account: ME, batcher: BATCHER, vaults: [vaultAt(1), vaultAt(2)], gasLimit: 774_000n });
    expect(asked).toEqual([{ vaults: [vaultAt(1), vaultAt(2)], gas: 774_000n, from: ME, to: BATCHER }]);
    // What it earned is the batcher's own answer; nothing else is read from a batch that holds nothing.
    expect(run.kind === "ran" && { ...run, outcomes: run.outcomes.length }).toEqual({ kind: "ran", gasUsed: 300_000n, bought: 2n, earned: 720_000n * GWEI, outcomes: 2 });
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

    // The intent pays the account, and nobody else, and proves each vault by its claim.
    const claimOf = (vault: Address): VaultClaim => ({ address: vault, owner: OTHER, nonce: 0n, terms: DUE_TERMS, release: "v2" });
    const claims = new Map([vaultAt(1), vaultAt(2)].map((vault) => [vault, claimOf(vault)]));
    expect(() => batchIntent(plan, ME, 690069, new Map())).toThrow(/no claim/);
    expect(batchIntent(plan, ME, 690069, claims)).toEqual({
      version: 1,
      action: "batch",
      chainId: 690069,
      account: ME,
      vaults: [vaultAt(1), vaultAt(2)],
      claims: [claimOf(vaultAt(1)), claimOf(vaultAt(2))],
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
      ownFees: 0n,
      fee: 300_000n * GWEI,
      untriggered: [{ vault: vaultAt(2), reason: "PriceBelowFloor" }],
    });
    expect(resultText(result!)).toBe("Made 1 of 2 buys. You received 0.00036 WETH in buy fees. Network fee paid: 0.0003 ETH.");
  });

  /**
   * A buy past its window is anyone's, its owner's too, so a wallet's own
   * vault can ride in its own batch. The vault pays its fee back to its owner,
   * and that vault's buy row counts it as paid back (no fee): counted as
   * earned as well, it would show the owner's own budget as income.
   */
  it("tells the fees the wallet's own vaults paid back from those it earned from other people's", async () => {
    const reward = 360_000n * GWEI;
    const own = 250_000n * GWEI;
    const logs = [
      boughtLog(vaultAt(1), BATCHER, reward),
      triggeredLog(vaultAt(1), reward),
      boughtLog(vaultAt(2), BATCHER, own),
      triggeredLog(vaultAt(2), own),
      notTriggeredLog(vaultAt(3), TOO_SOON),
      batchLog({ listed: 3, bought: 2, earned: reward + own }),
    ];
    const read = await waitForBatch(
      receipt(logs),
      { hash, batcher: BATCHER, vaults: [vaultAt(1), vaultAt(2), vaultAt(3)], owned: [vaultAt(2), vaultAt(3)] },
      { timeoutMs: 0 },
    );
    const result = read!.result;
    // The panel says what arrived; the record, what was earned.
    expect(result).toMatchObject({ earned: reward + own, ownFees: own });
    expect(resultText(result)).toContain("You received 0.00061 WETH in buy fees.");
    expect(feesEarnedFromOthers(result)).toBe(reward);
    // Only its own vaults: none listed, none subtracted.
    expect(feesEarnedFromOthers(batchResultOf(read!.receipt, { batcher: BATCHER, vaults: [vaultAt(1), vaultAt(2)] }))).toBe(reward + own);
    // An own vault's buy whose Bought can't be read leaves the figure unknown, never a guess.
    const unread = receipt([triggeredLog(vaultAt(2), own), batchLog({ listed: 1, bought: 1, earned: own })]);
    const blind = (await waitForBatch(unread, { hash, batcher: BATCHER, vaults: [vaultAt(2)], owned: [vaultAt(2)] }, { timeoutMs: 0 }))!.result;
    expect(blind).toMatchObject({ earned: own, ownFees: null });
    expect(feesEarnedFromOthers(blind)).toBeNull();
    // A reverted batch paid nothing, of either kind.
    expect(feesEarnedFromOthers((await settled(receipt([], "0x0"), [vaultAt(2)]))!)).toBe(0n);
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
      "3 v2 vault buys are due right now. Whoever makes a due buy is paid its buy fee (SPX holders first, then anyone) — " +
        "that's how vaults keep buying with spDEX closed. You'd make them in one transaction.",
    );
    // Help run counts v2's buys only (decision 27): with v1 buys due, "no vault
    // buy is due" was false beside a v1 card's "Buy 1 is due".
    expect(NONE_DUE_TEXT).toBe("No v2 vault buy is due right now; v1 vaults' buys are left to keepers.");
    // The caller chooses when and is paid; nothing about the buy.
    expect(TERMS_TEXT).toContain("you choose only when, and its fee is paid to you.");
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
  });
});
