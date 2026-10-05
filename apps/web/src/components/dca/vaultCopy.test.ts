/**
 * The vault UI's sentences: each names only figures it has, says a buy fee is
 * WETH, counts time in the chain's clock and shows it in the device's, never
 * turns an unknown into "nothing", and calls the fee a buy fee — never a
 * "reward", which is the contract's word, kept to the Expert details.
 *
 * The dollar figures use the rate the fee examples were worked out at, ETH at
 * $2,643.94, so the figures below are the ones docs/ARCHITECTURE.md gives
 * under "The buy fee".
 */

import { describe, expect, it } from "vitest";
import type { PreparedFees } from "@spdex/chain";
import type { Address } from "@spdex/core";
import { CHEAP_BATCHED_BUY_THRESHOLD, MAINNET_BATCHER, MAINNET_FACTORY, NETWORK_PART, buyFee } from "@spdex/vault";
import { vaultCardStatus, vaultErrorText, vaultCosts, VAULT_LIMITS, type VaultCardStatus, type VaultFigures, type VaultHistoryEntry, type VaultPlanState } from "../../lib/dca/vault.js";
import type { FeeRead } from "../../lib/dca/form.js";
import recurringFormSource from "./RecurringForm.tsx?raw";
import vaultCardSource from "./VaultCard.tsx?raw";
import autoBuysPanelSource from "./AutoBuysPanel.tsx?raw";
import {
  allowanceText,
  closeConfirmText,
  closedVaultText,
  COMMUNITY_WINDOW_HINT,
  communityWindowLine,
  communityWindowLiveText,
  vaultTurnsLine,
  createSendsText,
  deployFee,
  dueText,
  factoryDeployMillions,
  FEE_PAYEE,
  HELD_BELOW,
  SIGNER_CHOICE_TITLES,
  retryFeeNote,
  retryPayeeText,
  retryRewardText,
  retryRulesText,
  strayVaultLine,
  triggerCostText,
  triggerGasCost,
  vaultCheaperText,
  vaultFeeRule,
  VAULT_TIPS,
  vaultCostText,
  vaultFeeNotes,
  vaultHistoryRows,
  vaultHoldsText,
  vaultLine,
  vaultRewardText,
  vaultSetupText,
  vaultTermsTail,
  WALLET_BUY_TYPICAL_GAS,
  walletFeeText,
  windowOptionLabel,
} from "./vaultCopy.js";
import { fiatCostText, type MoneyView } from "../../lib/money/convert.js";

/** Dollar prices alone, in dollars and en-US. */
const dollarView = (usd: ReadonlyMap<string, bigint>): MoneyView => ({ usd, fx: null, currency: "USD", locale: "en-US" });

const ETHER = 10n ** 18n;
const MILLI = ETHER / 1000n;
const GWEI = 10n ** 9n;
const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c" as Address;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const KEEPER = "0x00000000000000000000000000000000000000bb" as Address;

/** ETH at $2,643.94, as the page's rates hold it: USD (6 decimals) per whole ETH, keyed by WETH, shown in dollars. */
const RATES: MoneyView = dollarView(new Map([[WETH, 2_643_940_000n]]));

/** $1, $5, $10 and $69 a buy at that rate: four of those examples' amounts. */
const USD1 = 378_223_409_003_230n;
const USD5 = 1_891_117_045_016_150n;
const USD10 = 3_782_234_090_032_301n;
const USD69 = 26_097_415_221_222_872n;
/** $6.90 a buy, the smallest preset: its fee is held at the ceiling. */
const USD690_CENTS = 2_609_741_522_122_287n;

/** The most a buy of a thousandth of an ether can pay: 0.69% of it, 0.0000069 ETH. */
const FEE = (MILLI * 69n) / 10_000n;

/** A block charging 0.132 gwei: the week's median base fee, 0.112, and a 0.02 tip. */
const MEDIAN: FeeRead = { kind: "ok", fees: { type: "eip1559", maxFeePerGas: 2n * 112_000_000n + 20_000_000n, maxPriorityFeePerGas: 20_000_000n } };

function figures(patch: Partial<VaultFigures> = {}): VaultFigures {
  return {
    vault: "0x00000000000000000000000000000000000000cc" as Address,
    owner: OWNER,
    mine: true,
    terms: {
      tokenOut: SPX,
      pair: "0x52c77b0cb827afbad022e6d6caf2c44452edbc39" as Address,
      oraclePool: "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3" as Address,
      amountPerBuy: MILLI,
      interval: 86_400n,
      maxBuys: 3n,
      startAt: 1_000n,
      keeperReward: FEE,
      maxSlippageBps: 200n,
      communityWindow: 1_800n,
      turnBuckets: 0n,
    },
    closed: false,
    buysDone: 0,
    maxBuys: 3,
    buysLeft: 3,
    spent: 0n,
    received: 0n,
    rewardsPaid: 0n,
    balance: 3n * (MILLI + FEE),
    funded: true,
    fundingRoom: 0n,
    due: false,
    nextBuyAt: 87_400,
    canTrigger: false,
    waitingFor: "not due",
    quote: null,
    clock: { seconds: 2_000, readAtMs: 0 },
    mismatches: [],
    fromFactory: true,
    release: "v2",
    source: "v2",
    factory: MAINNET_FACTORY as Address,
    communityWindow: 1_800,
    dueSince: 87_400,
    windowEndsAt: 89_200,
    windowBuys: 0,
    turnBuckets: 0,
    turnEndsAt: null,
    ...patch,
  };
}

const active = (patch: Partial<VaultFigures> = {}): VaultPlanState => ({ kind: "active", ...figures(patch) });

/** $10 a day for 30 days, fees read at the median. */
const costs = vaultCosts({ amountPerBuy: USD10, maxBuys: 30, fees: MEDIAN.kind === "ok" ? MEDIAN.fees : null })!;

describe("the buy fee's words", () => {
  it("states the rule and the terms a newcomer hovers over", () => {
    // v2's rule: the network cost and a quarter of a percent of the buy. No "tenth" any more.
    expect(vaultFeeRule()).toBe("a fixed amount for network fees plus 0.25% of the buy, never more than 0.69% of the buy");
    expect(VAULT_TIPS.keeper).toBe(
      "Whoever makes a due buy happen: a bot (for example one that makes many vaults' buys in one transaction, which costs less per buy), a spDEX tab, or you. Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar. Nobody is obliged to make a buy: a buy time nobody triggers is skipped. A keeper picks only the moment, inside a due buy time, and who its own fee goes to; the vault fixes the amount, the price floor and where the tokens go.",
    );
    expect(VAULT_TIPS.fee).toBe(
      "Set once, when the vault is created, and paid from its budget as WETH to the keeper that makes each buy — or back to you when you trigger it: a fixed estimate of one buy's network fee when many buys share a transaction, plus 0.25% of the buy, and never more than 0.69% of the buy. No vault can be created with more, and nobody can change it afterwards, spDEX included. The keeper may be one run by spDEX's developers, who keep what's left of it after the network fee.",
    );
    // A v1 vault keeps v1's rule, and pays whoever triggers it: its card says so.
    expect(VAULT_TIPS.feeV1).toBe(
      "Set once, when the vault was created, and paid from its budget as WETH to whoever triggers each buy: a fixed estimate of one buy's network fee when many buys share a transaction, plus 10% of that estimate, and never more than 0.69% of the buy. Nobody can change it, spDEX included. Whoever triggers a buy may be a keeper run by spDEX's developers, who keep what's left of it after the network fee.",
    );
    expect(VAULT_TIPS.keeperV1).toBe(
      "Whoever sends the transaction that makes a due buy happen: a bot (for example one that makes many vaults' buys in one transaction, which costs less per buy), a spDEX tab, or you. The vault pays them the buy fee. Nobody is obliged to: a buy time nobody triggers is skipped. A keeper picks only the moment, inside a due buy time; the vault fixes the amount, the price floor and where the tokens go.",
    );
    // Keeping is paid work, never a return on a holding.
    for (const tip of Object.values(VAULT_TIPS)) expect(tip).not.toMatch(/\b(APR|APY|yield|earnings)\b/i);
    expect(VAULT_TIPS.weth).toBe(
      "Wrapped Ether: ETH as a token, always worth exactly 1 ETH. A vault holds its budget, and pays its buy fees, as WETH; closing it sends what's left back to you as ETH.",
    );
  });

  /** Nearest cent, not the cent below: a $0.0476 fee cut to "$0.04" would understate it by a sixth. */
  it("prices a cost in dollars to the nearest cent, and never as nothing", () => {
    expect(fiatCostText(buyFee(USD690_CENTS).reward, RATES)).toBe("≈\u00a0$0.05");
    // $0.2225: the network cost and 0.25% of $69.
    expect(fiatCostText(buyFee(USD69).reward, RATES)).toBe("≈\u00a0$0.22");
    expect(fiatCostText(buyFee(USD1).reward, RATES)).toBe("≈\u00a0$0.01");
    expect(fiatCostText(10n ** 12n, RATES)).toBe("<\u00a0$0.01");
    expect(fiatCostText(10n ** 15n, undefined)).toBeNull();
    expect(fiatCostText(10n ** 15n, dollarView(new Map()))).toBeNull();
  });

  it("prices a cost in the page's currency, and in dollars where that currency has no rate", () => {
    const fx = { block: 1n, chainTime: 10_000, rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: 9_000 } }, usdc: null };
    const euros: MoneyView = { ...RATES, fx, currency: "EUR" };
    // $0.2225 at $1.1481 a euro: €0.1938.
    expect(fiatCostText(buyFee(USD69).reward, euros)).toBe("≈\u00a0€0.19");
    expect(fiatCostText(buyFee(USD69).reward, { ...euros, currency: "GBP" })).toBe("≈\u00a0$0.22");
  });
});

describe("the vault choice's cost line", () => {
  it("says an allowance as a person reads it", () => {
    expect(allowanceText(200)).toBe("2%");
    expect(allowanceText(150n)).toBe("1.5%");
  });

  it("states the one confirmation, its fee, and the buy fee in dollars, ETH and as a share", () => {
    expect(vaultCostText(costs, MEDIAN, RATES)).toBe(
      "1 confirmation creates and funds it (≈\u00a0$0.08 network fee). " +
        "Buy fee: ≈\u00a0$0.07 (0.0000261 ETH, 0.69%) a buy, the most it can be, paid to the keeper that makes it — maybe spDEX's developers.",
    );
    // No rate: ether alone, never a guessed dollar figure.
    expect(vaultCostText(costs, MEDIAN)).toBe(
      "1 confirmation creates and funds it (≈ 0.00002904 ETH network fee). " +
        "Buy fee: 0.0000261 ETH (0.69%) a buy, the most it can be, paid to the keeper that makes it — maybe spDEX's developers.",
    );
    // $69 a buy pays the network cost and 0.25% of the buy, under the ceiling.
    const larger = vaultCosts({ amountPerBuy: USD69, maxBuys: 30, fees: null })!;
    expect(vaultCostText(larger, { kind: "reading" }, RATES)).toBe(
      "1 confirmation creates and funds it; its network fee is unknown until fees are read. " +
        "Buy fee: ≈\u00a0$0.22 (0.00008415 ETH, 0.33%) a buy, paid to the keeper that makes it — maybe spDEX's developers.",
    );
  });

  it("says when the buy fee is held at its ceiling", () => {
    const small = vaultCosts({ amountPerBuy: USD1, maxBuys: 30, fees: null })!;
    expect(small.fee.atCeiling).toBe(true);
    expect(vaultCostText({ ...small, createFee: 29_040_000_000_000n }, MEDIAN, RATES)).toBe(
      "1 confirmation creates and funds it (≈\u00a0$0.08 network fee). " +
        "Buy fee: ≈\u00a0$0.01 (0.00000261 ETH, 0.69%) a buy, the most it can be, paid to the keeper that makes it — maybe spDEX's developers.",
    );
    expect(vaultCostText(small, { kind: "reading" })).toBe(
      "1 confirmation creates and funds it; its network fee is unknown until fees are read. " +
        "Buy fee: 0.00000261 ETH (0.69%) a buy, the most it can be, paid to the keeper that makes it — maybe spDEX's developers.",
    );
  });

  /** The buy fee needs no fee read; only the creation's gas does, and it is never shown as nothing. */
  it("names the buy fee before fees are read, and the creation's network fee only once they are", () => {
    const unread = { ...costs, createFee: null };
    expect(vaultCostText(unread, { kind: "reading" }, RATES)).toBe(
      "1 confirmation creates and funds it; its network fee is unknown until fees are read. " +
        "Buy fee: ≈\u00a0$0.07 (0.0000261 ETH, 0.69%) a buy, the most it can be, paid to the keeper that makes it — maybe spDEX's developers.",
    );
    expect(vaultCostText(unread, { kind: "error", message: "no" }, RATES)).toBe(
      "1 confirmation creates and funds it; its network fee is unknown: current fees couldn't be read. " +
        "Buy fee: ≈\u00a0$0.07 (0.0000261 ETH, 0.69%) a buy, the most it can be, paid to the keeper that makes it — maybe spDEX's developers.",
    );
    // No amount yet: the ceiling, as a bound.
    expect(vaultCostText(null, { kind: "reading" })).toBe(
      "1 confirmation creates and funds it. Buy fee: up to 0.69% a buy, paid to the keeper that makes it — maybe spDEX's developers.",
    );
  });

  it("splits what the creation sends into the buys and their buy fees", () => {
    expect(vaultSetupText(costs, 30n * USD10)).toBe(
      "Created and funded in 1 confirmation: 0.1143 ETH goes in — 0.113467 ETH for the buys and 0.000783 ETH for their buy fees.",
    );
    expect(vaultSetupText(null, 50n * MILLI)).toBe("Created and funded in 1 confirmation, with the plan's whole budget.");
  });

  /**
   * A buy's typical gas, not `EXECUTE_GAS` (320,000), which sizes a limit:
   * quoted as a cost it said triggering lost money when it didn't. A first
   * buy writes more from zero than a later one.
   */
  it("prices a trigger and the factory's deployment only from fees it has", () => {
    const fees: PreparedFees = { type: "eip1559", maxFeePerGas: 2n * 3n * GWEI + GWEI, maxPriorityFeePerGas: GWEI };
    // The base fee is recovered from the bid (2 × base + tip): 3 gwei + 1 gwei tip.
    expect(triggerGasCost({ kind: "ok", fees }, true)).toBe(305_000n * 4n * GWEI);
    expect(triggerGasCost({ kind: "ok", fees }, false)).toBe(240_000n * 4n * GWEI);
    expect(triggerGasCost({ kind: "reading" }, true)).toBeNull();
    expect(triggerGasCost({ kind: "error", message: "no" }, false)).toBeNull();
    // About 3.85 million for this release's factory, and 1.76 million more
    // where the SPX holder registry it needs isn't deployed either.
    expect(deployFee(fees)).toBe(3_850_000n * 4n * GWEI);
    expect(factoryDeployMillions()).toBe("3.9");
    expect(deployFee(fees, true)).toBe((3_850_000n + 1_760_000n) * 4n * GWEI);
    expect(factoryDeployMillions(true)).toBe("5.6");
    expect(deployFee(null)).toBeNull();
  });

  /** Trigger now pays the buy fee back, which reads like money back; when the gas is more, it is a cost. */
  it("says when triggering yourself costs more than the buy fee it pays back", () => {
    const gas = triggerGasCost(MEDIAN, false)!;
    expect(gas).toBe(240_000n * 132_000_000n);
    expect(triggerCostText(MEDIAN, gas - 1n, false)).toBe("That network fee is more than the buy fee, so waiting for a keeper costs you less.");
    expect(triggerCostText(MEDIAN, gas, false)).toBeNull();
    // A first buy costs more, so the same fee can be a loss there and not later.
    expect(triggerCostText(MEDIAN, gas, true)).not.toBeNull();
    expect(triggerCostText({ kind: "reading" }, 1n, true)).toBeNull();
  });

  /** Dollars first on both figures, so the two can be weighed; the fee to six digits, as the card gives it. */
  it("gives the due banner's buy fee and network fee side by side", () => {
    const gas = triggerGasCost(MEDIAN, true)!;
    expect(dueText(buyFee(USD10).reward, gas, RATES)).toBe(
      "A keeper may trigger it for its buy fee, ≈\u00a0$0.07 (0.0000260974 WETH). Or trigger it yourself: " +
        "you pay the network fee, ≈\u00a0$0.11 (0.00004026 ETH) today, and get the buy fee as WETH.",
    );
    expect(dueText(buyFee(USD10).reward, gas)).toBe(
      "A keeper may trigger it for its buy fee, 0.0000260974 WETH. Or trigger it yourself: " +
        "you pay the network fee, about 0.00004026 ETH today, and get the buy fee as WETH.",
    );
    expect(dueText(buyFee(USD10).reward, null, RATES)).toBe(
      "A keeper may trigger it for its buy fee, ≈\u00a0$0.07 (0.0000260974 WETH). Or trigger it yourself: " +
        "you pay the network fee and get the buy fee as WETH.",
    );
  });
});

describe("the notes under the vault choice", () => {
  const notes = (amountPerBuy: bigint, fees: FeeRead = MEDIAN) => vaultFeeNotes(buyFee(amountPerBuy), { amountPerBuy, fees, money: RATES });
  const ids = (amountPerBuy: bigint, fees?: FeeRead) => notes(amountPerBuy, fees).map((n) => n.testId);

  it("warns that buys too small to cover a cheap batched buy may be skipped, and says what avoids it", () => {
    expect(notes(USD1)[0]).toEqual({
      testId: "dca-form-vault-small",
      banner: { tone: "warn", title: "Buys this small may be skipped" },
      text: "Their buy fee is below a keeper's cost even when network fees are low. ≥ $4.01 a buy avoids this.",
    });
    // Without a rate, ether alone.
    expect(vaultFeeNotes(buyFee(USD1), { amountPerBuy: USD1, fees: MEDIAN })[0]!.text).toBe(
      "Their buy fee is below a keeper's cost even when network fees are low. ≥ 0.0016 ETH a buy avoids this.",
    );
  });

  it("says small buys held at the ceiling depend on low network fees, and says what avoids it", () => {
    expect(notes(USD5)[0]).toEqual({
      testId: "dca-form-vault-held",
      banner: { tone: "ok", title: "Small buys depend on low network fees" },
      text: "Held at 0.69%, their buy fee may not cover a keeper's cost unless network fees are low. ≥ $7.24 a buy avoids this.",
    });
    expect(vaultFeeNotes(buyFee(USD5), { amountPerBuy: USD5, fees: MEDIAN })[0]!.text).toBe(
      "Held at 0.69%, their buy fee may not cover a keeper's cost unless network fees are low. ≥ 0.0028 ETH a buy avoids this.",
    );
  });

  /**
   * "Held" ends where 0.69% of the buy reaches one batched buy's network cost
   * at the release's reference (`NETWORK_PART`): the fee there is still held
   * at the ceiling, but it covers what larger buys pay for the network.
   */
  it("changes tier exactly at each threshold, and says nothing of either once the fee covers the network cost", () => {
    expect(ids(CHEAP_BATCHED_BUY_THRESHOLD - 1n)[0]).toBe("dca-form-vault-small");
    expect(ids(CHEAP_BATCHED_BUY_THRESHOLD)[0]).toBe("dca-form-vault-held");
    expect(ids(HELD_BELOW - 1n)[0]).toBe("dca-form-vault-held");
    expect(buyFee(HELD_BELOW - 1n).reward).toBeLessThan(NETWORK_PART);
    expect(buyFee(HELD_BELOW).reward).toBe(NETWORK_PART);
    // Fees unread, so the wallet's note, which needs them, says nothing either.
    expect(ids(HELD_BELOW, { kind: "reading" })).toEqual([]);
    expect(ids(USD10, { kind: "reading" })).toEqual([]);
    expect(ids(USD69, { kind: "reading" })).toEqual([]);
  });

  /**
   * A wallet buy's gas at 0.05 gwei is about $0.02, under half a $10 buy's
   * fee. At the median it is about $0.05, more than half of it: no note.
   */
  it("says when confirming each buy in a wallet costs less than the vault's buy fee", () => {
    const quiet: FeeRead = { kind: "ok", fees: { type: "eip1559", maxFeePerGas: 2n * 30_000_000n + 20_000_000n, maxPriorityFeePerGas: 20_000_000n } };
    expect(notes(USD10, quiet).find((n) => n.testId === "dca-form-vault-wallet-cheaper")).toEqual({
      testId: "dca-form-vault-wallet-cheaper",
      banner: null,
      text:
        "At today's network fees, confirming each buy yourself costs less: about $0.02 a buy, " +
        "against a buy fee of ≈\u00a0$0.07 (0.0000261 ETH).",
    });
    expect(ids(USD69, quiet)).toContain("dca-form-vault-wallet-cheaper");
    expect(ids(USD10)).not.toContain("dca-form-vault-wallet-cheaper");
    // A larger buy's fee grows with it (0.25% of the buy): at the median, $69's
    // is more than twice a wallet buy's gas, and the note says so.
    expect(ids(USD69)).toContain("dca-form-vault-wallet-cheaper");
    // More than twice a wallet buy's gas, not merely more.
    const wallet = WALLET_BUY_TYPICAL_GAS * 132_000_000n;
    const at = (reward: bigint) => vaultFeeNotes({ ...buyFee(USD69), reward }, { amountPerBuy: USD69, fees: MEDIAN }).map((n) => n.testId);
    expect(at(2n * wallet)).not.toContain("dca-form-vault-wallet-cheaper");
    expect(at(2n * wallet + 1n)).toContain("dca-form-vault-wallet-cheaper");
    // Only from fees that were read.
    expect(ids(USD69, { kind: "reading" })).not.toContain("dca-form-vault-wallet-cheaper");
    expect(ids(USD69, { kind: "error", message: "no" })).not.toContain("dca-form-vault-wallet-cheaper");
  });

  /** The wallet card's figure is worked out as the wallet-cheaper note's is, and given as the vault card gives its fee. */
  it("gives one wallet buy's network fee as the vault card gives its buy fee", () => {
    expect(walletFeeText(USD10, MEDIAN, RATES)).toBe("≈\u00a0$0.05 (0.0000198 ETH), 0.53% of the buy");
    expect(walletFeeText(USD10, MEDIAN)).toBe("0.0000198 ETH, 0.53% of the buy");
    expect(walletFeeText(USD10, { kind: "reading" }, RATES)).toBeNull();
    expect(walletFeeText(0n, MEDIAN, RATES)).toBeNull();
  });

  /**
   * Under the wallet's fee warning, when a vault would cost the whole plan
   * less at today's fees: its buy fees and creating it, against a wallet
   * buy's network fee for every buy.
   */
  it("says when a vault would cost the plan less than confirming each buy", () => {
    // 1 gwei a unit of gas: a wallet buy is 0.00015 ETH, and $10 buys' fees are well under that.
    const dear: FeeRead = { kind: "ok", fees: { type: "eip1559", maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 0n } };
    const plan = vaultCosts({ amountPerBuy: USD10, maxBuys: 10, fees: dear.kind === "ok" ? dear.fees : null })!;
    expect(vaultCheaperText(plan, { maxBuys: 10, fees: dear, money: RATES })).toBe(
      "A vault would cost this plan less at today's fees: a buy fee of ≈\u00a0$0.07 a buy, plus ≈\u00a0$0.58 once to create the vault.",
    );
    // One buy doesn't pay for creating the vault.
    const once = vaultCosts({ amountPerBuy: USD10, maxBuys: 1, fees: dear.kind === "ok" ? dear.fees : null })!;
    expect(vaultCheaperText(once, { maxBuys: 1, fees: dear, money: RATES })).toBeNull();
    // At the median a wallet buy costs about what the buy fee does, so thirty buys never pay back creating the vault.
    expect(vaultCheaperText(costs, { maxBuys: 30, fees: MEDIAN, money: RATES })).toBeNull();
    expect(vaultCheaperText(plan, { maxBuys: 10, fees: { kind: "reading" } })).toBeNull();
  });

  it("says nothing about a buy fee that needs no note", () => {
    expect(ids(10n * MILLI, { kind: "reading" })).toEqual([]);
  });
});

describe("a vault card's figures", () => {
  it("says how many of the buys left what the vault holds covers", () => {
    expect(vaultHoldsText(figures())).toBe("0.0030207 WETH · covers every buy left");
    expect(vaultHoldsText(figures({ balance: MILLI + FEE }))).toBe("0.0010069 WETH · enough for 1 of the 3 buys left");
    expect(vaultHoldsText(figures({ balance: MILLI }))).toBe("0.001 WETH · enough for 0 of the 3 buys left");
  });

  it("tells an empty vault from a closed one, and says what to do", () => {
    expect(vaultHoldsText(figures({ balance: 0n }))).toBe("Nothing — fund it to go on");
    expect(vaultHoldsText(figures({ balance: 0n, closed: true }))).toBe("Nothing — it's closed");
    expect(vaultHoldsText(figures({ balance: MILLI, closed: true }))).toBe("0.001 WETH, sent to it after it closed");
    expect(vaultHoldsText(figures({ balance: MILLI, buysLeft: 0 }))).toBe("0.001 WETH · every buy is done");
  });

  /** The vault's own figure to six digits, with what the form gave it in: dollars, and its share of each buy. */
  it("gives the buy fee in WETH, each and so far, with its dollars and share of each buy", () => {
    expect(vaultRewardText(figures())).toBe("0.0000069 WETH a buy (0.69% of each) · none paid yet");
    expect(vaultRewardText(figures({ rewardsPaid: 2n * FEE }))).toBe("0.0000069 WETH a buy (0.69% of each) · 0.0000138 WETH paid so far");
    const ten = figures({ terms: { ...figures().terms, amountPerBuy: USD10, keeperReward: buyFee(USD10).reward } });
    expect(vaultRewardText(ten, RATES)).toBe("0.0000260974 WETH a buy (≈\u00a0$0.07, 0.69% of each) · none paid yet");
    const sixtyNine = figures({ terms: { ...figures().terms, amountPerBuy: USD69, keeperReward: buyFee(USD69).reward } });
    expect(vaultRewardText(sixtyNine, RATES)).toBe("0.0000841435 WETH a buy (≈\u00a0$0.22, 0.33% of each) · none paid yet");
  });

  it("asks before closing with what comes back, and that it is final", () => {
    expect(closeConfirmText(figures())).toBe(
      "Everything it holds — 0.0030207 WETH — comes back to your wallet as ETH. It never buys again and can't be reopened.",
    );
    expect(closeConfirmText(figures({ balance: 0n }))).toMatch(/^It holds nothing, so nothing comes back/);
  });
});

describe("a vault card's lines", () => {
  const status = (vault: VaultCardStatus["vault"], reason: string | null = null): VaultCardStatus => ({
    row: "vault",
    vault,
    pill: "running",
    reason,
    nextBuyAt: 87_400,
  });

  it("says what a vault between buys is waiting for", () => {
    // v1: anyone may make its buy, and be paid, once due.
    expect(vaultLine(status("waiting"), active({ release: "v1", source: "v1" }))).toBe("Waiting for the first buy time. Then anyone can trigger it.");
    expect(vaultLine(status("waiting"), active({ release: "v1", source: "v1", buysDone: 1 }))).toBe(
      "Waiting for the next buy time. Then anyone can trigger it.",
    );
    // v2: SPX holders first, which the due banner then says ("Community
    // window until 14:32, then open to anyone."); "Then anyone" before it
    // read as the opposite.
    expect(vaultLine(status("waiting"), active())).toBe("Waiting for the first buy time.");
    expect(vaultLine(status("waiting"), active({ buysDone: 1 }))).toBe("Waiting for the next buy time.");
  });

  it("reads a buy due by the clock carried forward, and not yet by a block, as a wait for that block", () => {
    const waiting = status("waiting-price", "Next buy is waiting: next buy due at 2026-09-21T10:00:00.000Z (chain time).");
    expect(vaultLine(waiting, active({ due: false }))).toBe(
      "The next buy is due about now. It can be triggered once the network's next block shows it.",
    );
    // A real wait — the price, the pool — keeps the vault's own reason.
    const price = status("waiting-price", "Next buy is waiting: the price is 2.10% outside its floor; the buy waits for the market.");
    expect(vaultLine(price, active({ due: true }))).toBe(price.reason);
  });

  it("passes every other state's reason through", () => {
    expect(vaultLine(status("closed", "Closed after 1 of 3 buys."), active({ closed: true }))).toBe("Closed after 1 of 3 buys.");
  });

  it("says what the vault does for the plan now, around the word the card explains", () => {
    expect(vaultTermsTail(active())).toEqual(["a ", " buys it when triggered, with or without spDEX open"]);
    expect(vaultTermsTail(active({ closed: true }))).toEqual(["its ", " is closed"]);
    expect(vaultTermsTail(active({ buysLeft: 0 }))).toEqual(["its ", " has made every buy"]);
    // Unfunded, it buys nothing yet, spDEX open or not.
    expect(vaultTermsTail(active({ funded: false, balance: 0n }))).toEqual(["a ", " will buy it once funded"]);
    expect(vaultTermsTail({ kind: "someone-else", ...figures({ mine: false, funded: false }) })).toEqual(["someone else's ", " will buy it once funded"]);
    expect(vaultTermsTail({ kind: "someone-else", ...figures({ mine: false }) })).toEqual(["someone else's ", " buys it when triggered, with or without spDEX open"]);
    expect(vaultTermsTail({ kind: "not-created", note: null })).toEqual(["a ", " will buy it, once created"]);
    expect(vaultTermsTail({ kind: "creating", vault: null, hash: null })).toEqual(["a ", " will buy it, once created"]);
    expect(vaultTermsTail({ kind: "loading" })).toEqual(["bought by a ", ""]);
  });

  /**
   * The figure is the one the click sends (`vaultRetryTerms`' fund), not an
   * "about" worked out from today's default fee, which a retry may not use.
   */
  it("says what creating a vault sends — the very figure the click sends — and its network fee once it can be priced", () => {
    const fund = 5n * (10n * MILLI + 7_681n * 10n ** 11n);
    expect(createSendsText({ fund }, costs)).toBe(
      "Sends 0.0538405 ETH (every buy and its buy fee) in 1 confirmation, plus ≈ 0.00002904 ETH network fee.",
    );
    const unpriced = "Sends 0.0538405 ETH (every buy and its buy fee) in 1 confirmation.";
    expect(createSendsText({ fund }, null)).toBe(unpriced);
    expect(createSendsText({ fund }, { createFee: null })).toBe(unpriced);
    expect(createSendsText({ fund: null }, costs)).toBeNull();
    expect(createSendsText(null, costs)).toBeNull();
  });

  it("names the buy fee a retry would pay, exactly as a share, and whose figure it is", () => {
    expect(retryRewardText({ keeperReward: FEE / 2n, keptReward: true }, MILLI)).toBe("0.00000345 ETH a buy, 0.35% of each · as you set it up");
    const today = buyFee(USD10).reward;
    expect(retryRewardText({ keeperReward: today, keptReward: false }, USD10)).toBe("0.0000261 ETH a buy, 0.69% of each · the current default");
    // Who gets it, on the line under it, as the form's cost line says it.
    expect(retryPayeeText()).toBe("Each buy's fee is paid to the keeper that makes it — maybe spDEX's developers.");
    expect(retryPayeeText()).toContain(FEE_PAYEE);
    // Who is paid first is the window line's to say (DESIGN §9: one plain
    // line); the payee beside it, on the choice card's cost line and here,
    // said it a second and third time.
    expect(FEE_PAYEE).not.toMatch(/SPX holders/);
    expect(retryRewardText({ keeperReward: null, keptReward: false }, MILLI)).toBe("unknown: the plan's amount per buy can't be read");
  });

  /** What stays visible above "Create and fund vault" (UI rule R6, docs/ARCHITECTURE.md), however the plan arrived. */
  it("says who may trigger it, that only closing stops it, and the cap, above the create button", () => {
    // R6: anyone can make its due buys and nobody has to — SPX holders first, for each buy's community window.
    expect(retryRulesText("0.5 ETH")).toBe("Anyone can make its due buys, SPX holders first; nobody has to. Only closing it stops it. At most 0.5 ETH.");
  });

  /** The form's first two notes, on the card, judged on the fee the click sends: a kept one may be lower than today's. */
  it("warns on the card when a retry's buy fee may not get its buys made, or depends on low network fees", () => {
    expect(retryFeeNote(buyFee(USD1).reward, USD1)).toEqual({
      testId: "dca-vault-retry-small",
      text: "Buys this small may be skipped: the buy fee is below a keeper's cost even when network fees are low.",
    });
    expect(retryFeeNote(buyFee(USD5).reward, USD5)).toEqual({
      testId: "dca-vault-retry-held",
      text: "Held at the 0.69% ceiling: may only be made when network fees are low. Untriggered times are skipped.",
    });
    expect(retryFeeNote(buyFee(USD10).reward, USD10)).toBeNull();
    // A kept fee lower than the plan's own ceiling, and below a cheap batched buy's cost.
    expect(retryFeeNote(10n ** 12n, USD10)?.testId).toBe("dca-vault-retry-small");
    expect(retryFeeNote(1n, 0n)).toBeNull();
  });
});

describe("a vault's history rows", () => {
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
  const bought = (n: number, at: number | null, keeper: Address = KEEPER): VaultHistoryEntry => ({
    kind: "bought",
    hash: hash(n),
    blockNumber: BigInt(n),
    logIndex: 0,
    at,
    amountIn: MILLI,
    amountOut: 4_855_75n * 10n ** 3n,
    keeper,
    reward: FEE,
  });

  it("numbers buys as the vault counts them, newest first, with ids that don't shift", () => {
    const rows = vaultHistoryRows({
      entries: [bought(3, null), bought(2, null)],
      missingBuys: 1,
      terms: { tokenOut: SPX },
      account: null,
      chainNow: null,
      nowMs: 0,
    });
    expect(rows.map((row) => row.text.split(" · ")[0])).toEqual(["#3", "#2"]);
    expect(rows.map((row) => row.seq)).toEqual([1, 0]);
    expect(rows[0]!.hash).toBe(hash(3));
  });

  it("shows a block's time in this device's clock, and none it couldn't read", () => {
    // The chain is a day behind this device: a buy an hour ago on the chain was an hour ago here.
    const nowMs = Date.UTC(2026, 8, 23, 12, 0);
    const chainNow = Math.floor(nowMs / 1000) - 86_400;
    const [row] = vaultHistoryRows({
      entries: [bought(2, chainNow - 3_600, OWNER)],
      missingBuys: 0,
      terms: { tokenOut: SPX },
      account: OWNER,
      chainNow,
      nowMs,
    });
    const shown = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(nowMs - 3_600_000));
    expect(row!.text).toBe(`#1 · ${shown} · Bought 4.85575 SPX for 0.001 ETH · triggered by you, paid you its 0.0000069 WETH buy fee`);
    const [untimed] = vaultHistoryRows({
      entries: [bought(2, null)],
      missingBuys: 0,
      terms: { tokenOut: SPX },
      account: null,
      chainNow,
      nowMs,
    });
    expect(untimed!.text).toMatch(/^#1 · Bought /);
  });

  /**
   * A v2 buy says who made it, from its `Bought` (`maker`, `buyMaker`), and
   * whom its fee went to (`rewardTo`), which need not be whoever sent it.
   */
  it("says who made each v2 buy, and whom its fee was paid", () => {
    const HOLDER = "0x00000000000000000000000000000000000000dd" as Address;
    const BATCHER = MAINNET_BATCHER as Address;
    const v2 = (patch: Partial<VaultHistoryEntry>): VaultHistoryEntry => ({
      ...bought(2, null),
      source: "v2",
      dueSince: 1_000,
      communityWindow: 1_800,
      sender: null,
      ...patch,
    });
    const text = (entry: VaultHistoryEntry, account: Address | null) =>
      vaultHistoryRows({ entries: [entry], missingBuys: 0, terms: { tokenOut: SPX }, account, chainNow: null, nowMs: 0 })[0]!.text;
    const head = "#1 · Bought 4.85575 SPX for 0.001 ETH";
    // Trigger now: the owner's, the fee back to the owner.
    const own = v2({ keeper: OWNER, rewardTo: OWNER, maker: "owner" });
    expect(text(own, OWNER)).toBe(`${head} · triggered by you, paid you its 0.0000069 WETH buy fee`);
    expect(text(own, KEEPER)).toBe(`${head} · triggered by its owner, paid its owner its 0.0000069 WETH buy fee`);
    // Someone else named the owner: the fee came back, but not by the owner's doing.
    expect(text(v2({ keeper: KEEPER, rewardTo: OWNER, maker: "returned" }), OWNER)).toBe(
      `${head} · triggered by 0x0000…00bb, paid you its 0.0000069 WETH buy fee`,
    );
    expect(text(v2({ keeper: BATCHER, rewardTo: OWNER, sender: KEEPER, maker: "returned" }), OWNER)).toBe(
      `${head} · triggered by 0x0000…00bb, paid you its 0.0000069 WETH buy fee`,
    );
    // Inside the window, a community keeper; after it, anyone.
    expect(text(v2({ keeper: BATCHER, rewardTo: HOLDER, maker: "community" }), OWNER)).toBe(
      `${head} · triggered by a community keeper, paid 0x0000…00dd its 0.0000069 WETH buy fee`,
    );
    // After it: who sent it, as for any other buy ("by anyone" read as if nobody in particular had).
    expect(text(v2({ keeper: KEEPER, rewardTo: KEEPER, maker: "open" }), OWNER)).toBe(
      `${head} · triggered by 0x0000…00bb after its community window, paid 0x0000…00bb its 0.0000069 WETH buy fee`,
    );
    expect(text(v2({ keeper: BATCHER, rewardTo: HOLDER, maker: "open" }), OWNER)).toBe(
      `${head} · triggered in a batch after its community window, paid 0x0000…00dd its 0.0000069 WETH buy fee`,
    );
    expect(text(v2({ keeper: KEEPER, rewardTo: KEEPER, maker: "open" }), KEEPER)).toBe(
      `${head} · triggered by you after its community window, paid you its 0.0000069 WETH buy fee`,
    );
    // The connected wallet was the community keeper.
    expect(text(v2({ keeper: BATCHER, rewardTo: HOLDER, maker: "community" }), HOLDER)).toBe(
      `${head} · triggered by a community keeper, paid you its 0.0000069 WETH buy fee`,
    );
    // Who made it unknown (no block time): who was paid, and how it was sent, but no guess at the window.
    expect(text(v2({ keeper: BATCHER, rewardTo: HOLDER, maker: null }), OWNER)).toBe(
      `${head} · triggered in a batch, paid 0x0000…00dd its 0.0000069 WETH buy fee`,
    );
    // v1 reads as it always has: the caller was paid.
    expect(text({ ...bought(2, null), source: "v1", rewardTo: KEEPER, dueSince: null, maker: "caller" }, OWNER)).toBe(
      `${head} · triggered by 0x0000…00bb, paid them its 0.0000069 WETH buy fee`,
    );
  });

  it("leaves fundings and closings unnumbered", () => {
    const rows = vaultHistoryRows({
      entries: [
        { kind: "closed", hash: hash(4), blockNumber: 4n, logIndex: 0, at: null, amount: MILLI },
        bought(3, null),
      ],
      missingBuys: 0,
      terms: { tokenOut: SPX },
      account: null,
      chainNow: null,
      nowMs: 0,
    });
    expect(rows.map((row) => row.text)).toEqual([
      "Closed: 0.001 ETH sent back to its owner",
      "#1 · Bought 4.85575 SPX for 0.001 ETH · triggered by 0x0000…00bb, paid them its 0.0000069 WETH buy fee",
    ]);
  });
});

describe("the community window's words", () => {
  it("says, in one line, who may earn the plan's fee and for how long", () => {
    expect(communityWindowLine(1_800)).toBe(
      "SPX holders can earn this plan's fee for its first 30 minutes after each buy falls due; then anyone can.",
    );
    expect(communityWindowLine(75)).toBe("SPX holders can earn this plan's fee for its first 75 seconds after each buy falls due; then anyone can.");
    expect(communityWindowLine(60)).toMatch(/for its first minute after/);
    expect(communityWindowLine(900)).toMatch(/for its first 15 minutes after/);
    expect(communityWindowLine(3_600)).toMatch(/for its first hour after/);
  });

  it("gives Expert the spec's one hint, and short option labels", () => {
    expect(COMMUNITY_WINDOW_HINT).toBe(
      "Shorter: your buy happens sooner when no holder is online. Longer: holders have more time to earn your fee.",
    );
    expect(windowOptionLabel({ value: "60", seconds: 60 })).toBe("1 min");
    expect(windowOptionLabel({ value: "3600", seconds: 3_600 })).toBe("60 min");
    expect(windowOptionLabel({ value: "quarter", seconds: 75 })).toBe("A quarter of the interval (75 s)");
    expect(windowOptionLabel({ value: "quarter", seconds: 900 })).toBe("A quarter of the interval (15 min)");
  });

  /** "until 14:32": the window's end, chain time, in this device's clock, as the card's other times. */
  it("says on a due v2 card until when holders have first claim, and nothing outside the window or on v1", () => {
    const nowMs = Date.UTC(2026, 9, 3, 12, 0);
    // The chain is a day behind this device; the window ends ten minutes from now on the chain.
    const chainNow = Math.floor(nowMs / 1000) - 86_400;
    const due = figures({ nextBuyAt: chainNow - 60, dueSince: chainNow - 60, windowEndsAt: chainNow + 600 });
    const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(nowMs + 600_000));
    expect(communityWindowLiveText(due, chainNow, nowMs)).toBe(`Community window until ${clock}, then open to anyone.`);
    // Its last second is inside; the next is open to anyone, and says nothing.
    expect(communityWindowLiveText(due, chainNow + 599, nowMs)).not.toBeNull();
    expect(communityWindowLiveText(due, chainNow + 600, nowMs)).toBeNull();
    // Not due yet by the clock.
    expect(communityWindowLiveText(figures({ nextBuyAt: chainNow + 60, dueSince: chainNow + 60, windowEndsAt: chainNow + 1_860 }), chainNow, nowMs)).toBeNull();
    // A v1 vault has no window, and its card is unchanged.
    expect(communityWindowLiveText({ ...due, source: "v1", windowEndsAt: null }, chainNow, nowMs)).toBeNull();
    expect(communityWindowLiveText(due, null, nowMs)).toBeNull();
  });

  /**
   * A plan with turns (dormant: every vault spDEX creates has none) says so in
   * one line, and while a buy is in its turn the due banner says when the turn
   * ends, then the window. A plan without turns says nothing of them.
   */
  it("says when a buy's turn ends, and nothing of turns for a plan without", () => {
    const nowMs = Date.UTC(2026, 9, 3, 12, 0);
    const chainNow = Math.floor(nowMs / 1000) - 86_400;
    expect(vaultTurnsLine(0)).toBeNull();
    expect(vaultTurnsLine(null)).toBeNull();
    expect(vaultTurnsLine(4)).toBe(
      "The first half of each community window is shared out in turns among 4 groups of SPX holders; then any holder can earn the fee, and after the window anyone can.",
    );
    const clockAt = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    const turned = figures({ nextBuyAt: chainNow - 60, dueSince: chainNow - 60, windowEndsAt: chainNow + 840, turnBuckets: 4, turnEndsAt: chainNow + 390 });
    expect(communityWindowLiveText(turned, chainNow, nowMs)).toBe(
      `This buy's turn until ${clockAt(nowMs + 390_000)}, for SPX holders in its group; then any SPX holder until ${clockAt(nowMs + 840_000)}, then anyone.`,
    );
    // From the turn's end, the window's line as for a plan without turns.
    expect(communityWindowLiveText(turned, chainNow + 390, nowMs + 390_000)).toBe(`Community window until ${clockAt(nowMs + 840_000)}, then open to anyone.`);
  });
});

describe("a vault on chain no plan points at", () => {
  const status = (vault: VaultCardStatus["vault"], reason: string | null = null): VaultCardStatus => ({
    row: "vault",
    vault,
    pill: "running",
    reason,
    nextBuyAt: 87_400,
  });

  /**
   * Its card has no Trigger now and no Fund: a line that pointed at either
   * would point at nothing. It points at the button that brings them back.
   */
  it("points at Add back where a plan's card would point at a button it doesn't have", () => {
    const due = status("due", "The next buy is due — waiting for a keeper. You can trigger it yourself; its buy fee comes back to you.");
    expect(strayVaultLine(due, active({ due: true, canTrigger: true }))).toBe(
      "The next buy is due — waiting for a keeper. Add it back to your plans to trigger it yourself.",
    );
    const unfunded = status("unfunded", "The vault can't cover its next buy and its buy fee. Fund it to go on.");
    expect(strayVaultLine(unfunded, active({ funded: false, balance: 0n }))).toBe(
      "It can't cover its next buy and its buy fee. Add it back to your plans to fund it, or close it.",
    );
    // Everything else reads as it does on a plan's card.
    expect(strayVaultLine(status("waiting"), active())).toBe(vaultLine(status("waiting"), active()));
    // Closed: how far it got. Where its money went is the Holds row's and the
    // close's own notice, and "its owner" here is the person reading.
    const closed = status("closed", "Closed after 1 of 3 buys: what it held went back to your wallet.");
    expect(strayVaultLine(closed, active({ closed: true, buysDone: 1, maxBuys: 3 }))).toBe("Closed after 1 of 3 buys.");
  });

  it("says how far a closed vault got, and no more than it knows", () => {
    expect(closedVaultText(active({ closed: true, buysDone: 2, maxBuys: 3 }))).toBe("Closed after 2 of 3 buys");
    expect(closedVaultText(active({ closed: true, buysDone: 0, maxBuys: 1 }))).toBe("Closed after 0 of 1 buy");
    expect(closedVaultText({ kind: "loading" })).toBe("Closed");
  });
});

/**
 * "Buy fee" throughout: "reward" is the contract's word (`keeperReward`), and
 * beside "network fee" and "trading fee" it read as a fourth thing. It stays
 * only in the Expert details' "Buy fee (keeperReward)" label.
 */
describe("no vault sentence says reward", () => {
  const reward = /(?<![\w.$-])rewards?(?![\w-])/i;
  const fees: FeeRead[] = [MEDIAN, { kind: "reading" }, { kind: "error", message: "no" }];

  it("in any sentence a vault's copy makes", () => {
    const sentences: string[] = [...Object.values(VAULT_TIPS), vaultFeeRule()];
    for (const amount of [USD1, CHEAP_BATCHED_BUY_THRESHOLD, 10n ** 15n, USD5, HELD_BELOW, USD10, USD69]) {
      const planned = vaultCosts({ amountPerBuy: amount, maxBuys: 7, fees: null })!;
      for (const read of fees) {
        const priced = { ...planned, createFee: read.kind === "ok" ? 1n : null };
        sentences.push(vaultCostText(priced, read, RATES), vaultCostText(priced, read), vaultSetupText(priced, amount * 7n));
        sentences.push(...vaultFeeNotes(planned.fee, { amountPerBuy: amount, fees: read, money: RATES }).map((n) => n.text));
        sentences.push(triggerCostText(read, 1n, true) ?? "", retryFeeNote(planned.fee.reward, amount)?.text ?? "");
        sentences.push(dueText(planned.fee.reward, triggerGasCost(read, true), RATES), walletFeeText(amount, read, RATES) ?? "");
        sentences.push(vaultCheaperText({ ...planned, createFee: 1n }, { maxBuys: 7, fees: read, money: RATES }) ?? "");
      }
      sentences.push(retryRewardText({ keeperReward: planned.fee.reward, keptReward: false }, amount), createSendsText({ fund: planned.budget }, planned) ?? "");
    }
    sentences.push(vaultCostText(null, MEDIAN), retryRewardText({ keeperReward: null, keptReward: false }, 1n));
    sentences.push(communityWindowLine(75), communityWindowLine(1_800), COMMUNITY_WINDOW_HINT, retryPayeeText(), retryRulesText("0.5 ETH"));
    sentences.push(communityWindowLiveText(figures({ nextBuyAt: 100, windowEndsAt: 200 }), 150, 0) ?? "");
    for (const name of ["NotEligible", "BadRewardTo", "CommunityWindowOutOfRange"]) sentences.push(vaultErrorText({ name, args: [] }) ?? "");
    sentences.push(vaultRewardText(figures(), RATES), vaultRewardText(figures({ rewardsPaid: 1n })), vaultRewardText(figures({ terms: { ...figures().terms, keeperReward: 0n } })));
    for (const name of ["RewardTooLarge", "FundingCapExceeded", "InsufficientBalance", "FullyFunded"]) sentences.push(vaultErrorText({ name, args: [] }) ?? "");
    for (const state of [active({ funded: false, balance: 0n }), active({ due: true, canTrigger: true })]) {
      const status = vaultCardStatus(state, 100_000);
      sentences.push(status.reason ?? "", vaultLine(status, state), strayVaultLine(status, state));
    }
    for (const sentence of sentences) expect(sentence, sentence).not.toMatch(reward);
  });

  it("in the text the vault components render", () => {
    // Comments are the code's; everything else in these files is rendered or a
    // name, and a name has letters or a dot beside "reward" (`keeperReward`,
    // `fee.reward`, `dca-vault-reward`), which the pattern leaves alone.
    for (const [file, source] of [
      ["RecurringForm.tsx", recurringFormSource],
      ["VaultCard.tsx", vaultCardSource],
      ["AutoBuysPanel.tsx", autoBuysPanelSource],
    ] as const) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code.match(reward), file).toBeNull();
      expect(code, file).toContain("buy fee");
    }
    expect(vaultCardSource).toContain('"Buy fee (keeperReward)"');
  });

  /**
   * The vault pays inside its window only an address the registry finds
   * eligible — proven, an ordinary account, holding 690 SPX now — or its
   * owner. "An SPX holder" was too loose: a holder that never proved, or a
   * contract wallet, is refused `NotEligible`.
   */
  it("says who may be paid inside the window as the vault judges it: a proven account, not any holder", () => {
    const tip = /const OWN_KEEPER_TIP =\s*"([^"]*)"/.exec(autoBuysPanelSource)?.[1] ?? "";
    expect(tip).toContain("Out of the box it makes only buys whose fee covers that; the guide shows how to have it pay the difference for your own vaults.");
    expect(tip).toContain("Inside a buy's community window it is paid only when it names a community keeper (an account proven to hold 690 SPX) or the vault's owner.");
    expect(tip).not.toMatch(/an SPX holder or/);
    expect(vaultErrorText({ name: "NotEligible", args: [] })).toBe(
      "Inside its community window, a buy's fee can be paid only to a community keeper (an account proven to hold 690 SPX) or the vault's owner.",
    );
  });
});

describe("the Recurring choice cards", () => {
  it("names the vault plan the way the user chose: Set and forget", () => {
    expect(SIGNER_CHOICE_TITLES).toEqual({ wallet: "Confirm each buy myself", vault: "Set and forget" });
    // The card takes its title from here, and its short line still says
    // what it is: a vault, with no tab needed.
    expect(recurringFormSource).toContain("title={SIGNER_CHOICE_TITLES.vault}");
    expect(recurringFormSource).toContain("holds the budget — no tab needed.");
    expect(recurringFormSource).not.toContain("Vault — no tab needed");
    // R6, made true for v2: anyone can make its due buys, SPX holders first, and nobody has to.
    expect(recurringFormSource).toContain("Anyone can make its due buys, SPX holders first; nobody has to.");
  });

  /**
   * The window, as decisions 3 and 26 put it on screen: one plain line for
   * everyone, the choice in Expert alone. The form is a component the unit
   * project can only render statically, where it starts on the wallet choice,
   * so the wiring is pinned in its source, and what each piece says and
   * offers in `communityWindowLine`, `vaultWindowOptions` and `vaultWindowOf`
   * (lib/dca/vault.test.ts).
   */
  it("shows every vault plan the window line, and the window's choice in Expert alone", () => {
    const code = recurringFormSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // Simple always gets the plan's default, whatever was chosen in Expert.
    expect(code).toContain('vaultWindowOf(expert ? vaultWindow : "default", parsed.intervalSeconds)');
    // The line: for every vault plan, not behind Expert.
    expect(code).toMatch(/\{vault && windowSeconds !== null \? <p data-testid="dca-form-vault-window-line">\{communityWindowLine\(windowSeconds\)\}<\/p> : null\}/);
    // The select: Expert's, with the hint, each option disabled above a quarter of the interval.
    const select = code.slice(code.indexOf("{expert && parsed.intervalSeconds !== null ? ("), code.indexOf('data-testid="dca-form-vault-window"') + 200);
    expect(select).toContain('<Field label="Community window" hint={COMMUNITY_WINDOW_HINT}>');
    expect(select).toContain('data-testid="dca-form-vault-window"');
    expect(code).toContain("disabled={option.disabled}");
    // The vault is created with the window the form showed.
    expect(code).toContain("communityWindow: windowSeconds");
    // What will be saved writes it as Vault details does: "1,800 s".
    expect(code).toContain("` (${formatCount(windowSeconds)} s)`");
  });
});
