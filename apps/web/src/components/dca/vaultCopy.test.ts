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
import { CHEAP_BATCHED_BUY_THRESHOLD, FULL_FEE_BUY_THRESHOLD, buyFee } from "@spdex/vault";
import { vaultCardStatus, vaultErrorText, vaultCosts, VAULT_LIMITS, type VaultCardStatus, type VaultFigures, type VaultHistoryEntry, type VaultPlanState } from "../../lib/dca/vault.js";
import type { FeeRead } from "../../lib/dca/form.js";
import recurringFormSource from "./RecurringForm.tsx?raw";
import vaultCardSource from "./VaultCard.tsx?raw";
import autoBuysPanelSource from "./AutoBuysPanel.tsx?raw";
import {
  allowanceText,
  closeConfirmText,
  closedVaultText,
  createSendsText,
  deployFee,
  dueText,
  factoryDeployMillions,
  FEE_PAYEE,
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
    ...patch,
  };
}

const active = (patch: Partial<VaultFigures> = {}): VaultPlanState => ({ kind: "active", ...figures(patch) });

/** $10 a day for 30 days, fees read at the median. */
const costs = vaultCosts({ amountPerBuy: USD10, maxBuys: 30, fees: MEDIAN.kind === "ok" ? MEDIAN.fees : null })!;

describe("the buy fee's words", () => {
  it("states the rule and the terms a newcomer hovers over", () => {
    expect(vaultFeeRule()).toBe("a fixed amount for network fees plus 10% of that, never more than 0.69% of the buy");
    expect(VAULT_TIPS.keeper).toBe(
      "Whoever sends the transaction that makes a due buy happen: a bot (for example one that makes many vaults' buys in one transaction, which costs less per buy), a spDEX tab, or you. The vault pays them the buy fee. Nobody is obliged to: a buy time nobody triggers is skipped. A keeper picks only the moment, inside a due buy time; the vault fixes the amount, the price floor and where the tokens go.",
    );
    expect(VAULT_TIPS.fee).toBe(
      "Set once, when the vault is created, and paid from its budget as WETH to whoever triggers each buy: a fixed estimate of one buy's network fee when many buys share a transaction, plus 10% of that estimate, and never more than 0.69% of the buy. No vault can be created with more, and nobody can change it afterwards, spDEX included. Whoever triggers a buy may be a keeper run by spDEX's developers, who keep what's left of it after the network fee.",
    );
    expect(VAULT_TIPS.weth).toBe(
      "Wrapped Ether: ETH as a token, always worth exactly 1 ETH. A vault holds its budget, and pays its buy fees, as WETH; closing it sends what's left back to you as ETH.",
    );
  });

  /** Nearest cent, not the cent below: a $0.0476 fee cut to "$0.04" would understate it by a sixth. */
  it("prices a cost in dollars to the nearest cent, and never as nothing", () => {
    expect(fiatCostText(buyFee(USD690_CENTS).reward, RATES)).toBe("≈\u00a0$0.05");
    expect(fiatCostText(buyFee(USD69).reward, RATES)).toBe("≈\u00a0$0.05");
    expect(fiatCostText(buyFee(USD1).reward, RATES)).toBe("≈\u00a0$0.01");
    expect(fiatCostText(10n ** 12n, RATES)).toBe("<\u00a0$0.01");
    expect(fiatCostText(10n ** 15n, undefined)).toBeNull();
    expect(fiatCostText(10n ** 15n, dollarView(new Map()))).toBeNull();
  });

  it("prices a cost in the page's currency, and in dollars where that currency has no rate", () => {
    const fx = { block: 1n, chainTime: 10_000, rates: { EUR: { answer: 114_810_000n, decimals: 8, updatedAt: 9_000 } }, usdc: null };
    const euros: MoneyView = { ...RATES, fx, currency: "EUR" };
    // $0.05 (unrounded, $0.0532…) at $1.1481 a euro.
    expect(fiatCostText(buyFee(USD69).reward, euros)).toBe("≈\u00a0€0.05");
    expect(fiatCostText(buyFee(USD69).reward, { ...euros, currency: "GBP" })).toBe("≈\u00a0$0.05");
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
        "Buy fee: ≈\u00a0$0.05 (0.00002013 ETH, 0.54%) a buy, paid to whoever triggers it — maybe spDEX's developers.",
    );
    // No rate: ether alone, never a guessed dollar figure.
    expect(vaultCostText(costs, MEDIAN)).toBe(
      "1 confirmation creates and funds it (≈ 0.00002904 ETH network fee). " +
        "Buy fee: 0.00002013 ETH (0.54%) a buy, paid to whoever triggers it — maybe spDEX's developers.",
    );
  });

  it("says when the buy fee is held at its ceiling", () => {
    const small = vaultCosts({ amountPerBuy: USD1, maxBuys: 30, fees: null })!;
    expect(small.fee.atCeiling).toBe(true);
    expect(vaultCostText({ ...small, createFee: 29_040_000_000_000n }, MEDIAN, RATES)).toBe(
      "1 confirmation creates and funds it (≈\u00a0$0.08 network fee). " +
        "Buy fee: ≈\u00a0$0.01 (0.00000261 ETH, 0.69%) a buy, the most it can be, paid to whoever triggers it — maybe spDEX's developers.",
    );
    expect(vaultCostText(small, { kind: "reading" })).toBe(
      "1 confirmation creates and funds it; its network fee is unknown until fees are read. " +
        "Buy fee: 0.00000261 ETH (0.69%) a buy, the most it can be, paid to whoever triggers it — maybe spDEX's developers.",
    );
  });

  /** The buy fee needs no fee read; only the creation's gas does, and it is never shown as nothing. */
  it("names the buy fee before fees are read, and the creation's network fee only once they are", () => {
    const unread = { ...costs, createFee: null };
    expect(vaultCostText(unread, { kind: "reading" }, RATES)).toBe(
      "1 confirmation creates and funds it; its network fee is unknown until fees are read. " +
        "Buy fee: ≈\u00a0$0.05 (0.00002013 ETH, 0.54%) a buy, paid to whoever triggers it — maybe spDEX's developers.",
    );
    expect(vaultCostText(unread, { kind: "error", message: "no" }, RATES)).toBe(
      "1 confirmation creates and funds it; its network fee is unknown: current fees couldn't be read. " +
        "Buy fee: ≈\u00a0$0.05 (0.00002013 ETH, 0.54%) a buy, paid to whoever triggers it — maybe spDEX's developers.",
    );
    // No amount yet: the ceiling, as a bound.
    expect(vaultCostText(null, { kind: "reading" })).toBe(
      "1 confirmation creates and funds it. Buy fee: up to 0.69% a buy, paid to whoever triggers it — maybe spDEX's developers.",
    );
  });

  it("splits what the creation sends into the buys and their buy fees", () => {
    expect(vaultSetupText(costs, 30n * USD10)).toBe(
      "Created and funded in 1 confirmation: 0.1141 ETH goes in — 0.113467 ETH for the buys and 0.0006039 ETH for their buy fees.",
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
    expect(triggerGasCost({ kind: "ok", fees }, true)).toBe(300_000n * 4n * GWEI);
    expect(triggerGasCost({ kind: "ok", fees }, false)).toBe(230_000n * 4n * GWEI);
    expect(triggerGasCost({ kind: "reading" }, true)).toBeNull();
    expect(triggerGasCost({ kind: "error", message: "no" }, false)).toBeNull();
    // 3,562,618 measured for this release's factory.
    expect(deployFee(fees)).toBe(3_570_000n * 4n * GWEI);
    expect(factoryDeployMillions()).toBe("3.6");
    expect(deployFee(null)).toBeNull();
  });

  /** Trigger now pays the buy fee back, which reads like money back; when the gas is more, it is a cost. */
  it("says when triggering yourself costs more than the buy fee it pays back", () => {
    const gas = triggerGasCost(MEDIAN, false)!;
    expect(gas).toBe(230_000n * 132_000_000n);
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
      "A keeper may trigger it for its buy fee, ≈\u00a0$0.05 (0.00002013 WETH). Or trigger it yourself: " +
        "you pay the network fee, ≈\u00a0$0.10 (0.0000396 ETH) today, and get the buy fee as WETH.",
    );
    expect(dueText(buyFee(USD10).reward, gas)).toBe(
      "A keeper may trigger it for its buy fee, 0.00002013 WETH. Or trigger it yourself: " +
        "you pay the network fee, about 0.0000396 ETH today, and get the buy fee as WETH.",
    );
    expect(dueText(buyFee(USD10).reward, null, RATES)).toBe(
      "A keeper may trigger it for its buy fee, ≈\u00a0$0.05 (0.00002013 WETH). Or trigger it yourself: " +
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
      text: "Their buy fee is below a keeper's cost even when network fees are low. ≥ $3.88 a buy avoids this.",
    });
    // Without a rate, ether alone.
    expect(vaultFeeNotes(buyFee(USD1), { amountPerBuy: USD1, fees: MEDIAN })[0]!.text).toBe(
      "Their buy fee is below a keeper's cost even when network fees are low. ≥ 0.0015 ETH a buy avoids this.",
    );
  });

  it("says small buys held at the ceiling depend on low network fees, and says what avoids it", () => {
    expect(notes(USD5)[0]).toEqual({
      testId: "dca-form-vault-held",
      banner: { tone: "ok", title: "Small buys depend on low network fees" },
      text: "Held at 0.69%, their buy fee may not cover a keeper's cost unless network fees are low. ≥ $7.71 a buy avoids this.",
    });
    expect(vaultFeeNotes(buyFee(USD5), { amountPerBuy: USD5, fees: MEDIAN })[0]!.text).toBe(
      "Held at 0.69%, their buy fee may not cover a keeper's cost unless network fees are low. ≥ 0.003 ETH a buy avoids this.",
    );
  });

  it("changes tier exactly at each threshold, and says nothing of either once the fee is below its ceiling", () => {
    expect(ids(CHEAP_BATCHED_BUY_THRESHOLD - 1n)[0]).toBe("dca-form-vault-small");
    expect(ids(CHEAP_BATCHED_BUY_THRESHOLD)[0]).toBe("dca-form-vault-held");
    expect(ids(FULL_FEE_BUY_THRESHOLD - 1n)[0]).toBe("dca-form-vault-held");
    expect(buyFee(FULL_FEE_BUY_THRESHOLD).atCeiling).toBe(false);
    expect(ids(FULL_FEE_BUY_THRESHOLD)).toEqual([]);
    expect(ids(USD10)).toEqual([]);
    expect(ids(USD69)).toEqual([]);
  });

  /**
   * A wallet buy's gas at 0.05 gwei is about $0.02, under half the buy fee.
   * At the median it is about $0.05, as much as the fee: no note.
   */
  it("says when confirming each buy in a wallet costs less than the vault's buy fee", () => {
    const quiet: FeeRead = { kind: "ok", fees: { type: "eip1559", maxFeePerGas: 2n * 30_000_000n + 20_000_000n, maxPriorityFeePerGas: 20_000_000n } };
    expect(notes(USD10, quiet).find((n) => n.testId === "dca-form-vault-wallet-cheaper")).toEqual({
      testId: "dca-form-vault-wallet-cheaper",
      banner: null,
      text:
        "At today's network fees, confirming each buy yourself costs less: about $0.02 a buy, " +
        "against a buy fee of ≈\u00a0$0.05 (0.00002013 ETH).",
    });
    expect(ids(USD69, quiet)).toContain("dca-form-vault-wallet-cheaper");
    expect(ids(USD69)).not.toContain("dca-form-vault-wallet-cheaper");
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
      "A vault would cost this plan less at today's fees: a buy fee of ≈\u00a0$0.05 a buy, plus ≈\u00a0$0.58 once to create the vault.",
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
    expect(vaultRewardText(ten, RATES)).toBe("0.00002013 WETH a buy (≈\u00a0$0.05, 0.54% of each) · none paid yet");
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
    expect(vaultLine(status("waiting"), active())).toBe("Waiting for the first buy time. Then anyone can trigger it.");
    expect(vaultLine(status("waiting"), active({ buysDone: 1 }))).toBe("Waiting for the next buy time. Then anyone can trigger it.");
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
    expect(retryRewardText({ keeperReward: today, keptReward: false }, USD10)).toBe("0.00002013 ETH a buy, 0.54% of each · the current default");
    // Who gets it, on the line under it, as the form's cost line says it.
    expect(retryPayeeText()).toBe("Each buy's fee is paid to whoever triggers it — maybe spDEX's developers.");
    expect(retryPayeeText()).toContain(FEE_PAYEE);
    expect(retryRewardText({ keeperReward: null, keptReward: false }, MILLI)).toBe("unknown: the plan's amount per buy can't be read");
  });

  /** What stays visible above "Create and fund vault" (UI rule R6, docs/ARCHITECTURE.md), however the plan arrived. */
  it("says who may trigger it, that only closing stops it, and the cap, above the create button", () => {
    expect(retryRulesText("0.5 ETH")).toBe("Anyone can make its due buys; nobody has to. Only closing it stops it. At most 0.5 ETH.");
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
    for (const amount of [USD1, CHEAP_BATCHED_BUY_THRESHOLD, 10n ** 15n, USD5, FULL_FEE_BUY_THRESHOLD, USD10, USD69]) {
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
});

describe("the Recurring choice cards", () => {
  it("names the vault plan the way the user chose: Set and forget", () => {
    expect(SIGNER_CHOICE_TITLES).toEqual({ wallet: "Confirm each buy myself", vault: "Set and forget" });
    // The card takes its title from here, and its short line still says
    // what it is: a vault, with no tab needed.
    expect(recurringFormSource).toContain("title={SIGNER_CHOICE_TITLES.vault}");
    expect(recurringFormSource).toContain("holds the budget — no tab needed.");
    expect(recurringFormSource).not.toContain("Vault — no tab needed");
  });
});
