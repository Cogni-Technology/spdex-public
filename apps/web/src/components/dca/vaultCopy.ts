/**
 * What the vault choice and a vault plan's card say, as pure functions.
 *
 * The figures come from lib/dca/vault.ts, which reads them from the chain;
 * this file only decides how they read. It is kept apart from the components
 * for the reason view.ts is: a sentence that names a figure has rules — a
 * balance that couldn't be read is never "nothing", a buy fee is paid as WETH
 * and says so, a time is shown in this device's clock but counted in the
 * chain's — and rules are easier to pin in a test than in JSX.
 *
 * The copy style is the rest of auto-buy's: plain words on the default path,
 * the precise word one hover away (`VAULT_TIPS`), and every limit stated where
 * the decision is made.
 */

import type { PreparedFees } from "@spdex/chain";
import type { Address } from "@spdex/core";
import {
  BUY_FEE_CEILING_BPS,
  BUY_FEE_SHARE_BPS,
  CHEAP_BATCHED_BUY_THRESHOLD,
  NETWORK_PART,
  SOURCES,
  V1_BUY_FEE_MARKUP_BPS,
  coversCheapBatchedBuy,
  feeShareBps,
  type BuyFee,
  type SourceId,
} from "@spdex/vault";
import { ethText, ethUpTo } from "../../lib/dca/format.js";
import { percentText, type FeeRead } from "../../lib/dca/form.js";
import {
  deviceTimeOf,
  feePerGasNow,
  VAULT_SLIPPAGE_CHOICES,
  vaultHistorySentence,
  VAULT_GAS,
  type VaultCardStatus,
  type VaultCosts,
  type VaultFigures,
  type VaultHistoryEntry,
  type VaultPlanState,
  type VaultRetryTerms,
  type VaultTerms,
} from "../../lib/dca/vault.js";
import { dateTime } from "../../lib/dca/view.js";
import { localClock } from "../../lib/steps.js";
import { fiatCostText, type MoneyView } from "../../lib/money/convert.js";
import { COMMUNITY_KEEPING_TEXT } from "../../lib/network/batch.js";
import { bpsPercentText, formatCount, formatNumber } from "../../lib/money/format.js";

/**
 * The buy fee's ceiling, "0.69", and what it asks for beyond the network
 * cost, "0.25" of the buy, as the copy states them: from the release's
 * constants, so the words can't drift from the fee. v1's vaults keep v1's
 * rule, a tenth of the network cost ("10"), and their cards say that one.
 * Functions rather than constants, like every figure below: the page's number
 * format ("0,69" in German) is only known once the money settings are read,
 * after this module loads.
 */
const ceilingPercent = (): string => bpsPercentText(Number(BUY_FEE_CEILING_BPS));
const sharePercent = (): string => bpsPercentText(Number(BUY_FEE_SHARE_BPS));
const v1MarkupPercent = (): string => bpsPercentText(Number(V1_BUY_FEE_MARKUP_BPS));

/**
 * The buy fee's rule in one phrase, for every sentence that states it: "a
 * fixed amount for network fees plus 0.25% of the buy, never more than 0.69%
 * of the buy". "Fixed", because the network part is a release constant
 * (`buyFee`), the same for every plan and every buy; "network cost plus …"
 * read as if it followed the gas price of the moment up to the ceiling.
 */
export const vaultFeeRule = (): string =>
  `a fixed amount for network fees plus ${sharePercent()}% of the buy, never more than ${ceilingPercent()}% of the buy`;

/**
 * The words a vault adds, for `<Term tip={…}>`.
 *
 * Its own "10-minute average" rather than the glossary's, because the
 * glossary's describes the app's cross-check, which warns; a vault's refuses,
 * and a tip that said "warns you" beside a vault would understate it.
 */
export const VAULT_TIPS = {
  vault:
    "A small contract you create for one plan. It holds the plan's budget and makes each buy when anyone triggers a due one — no spDEX tab needed, though somebody has to trigger it. Its terms are fixed when it's made: nobody, not spDEX, can change them or take the funds. Only you can close it and take back what's left.",
  keeper:
    "Whoever makes a due buy happen: a bot (for example one that makes many vaults' buys in one transaction, which costs less per buy), a spDEX tab, or you. " +
    `${COMMUNITY_KEEPING_TEXT} ` +
    "Nobody is obliged to make a buy: a buy time nobody triggers is skipped. A keeper picks only the moment, inside a due buy time, and who its own fee goes to; the vault fixes the amount, the price floor and where the tokens go.",
  /** "Keeper" on a v1 vault's card: a v1 vault pays whoever triggers it, and has no community window. */
  keeperV1:
    "Whoever sends the transaction that makes a due buy happen: a bot (for example one that makes many vaults' buys in one transaction, which costs less per buy), a spDEX tab, or you. The vault pays them the buy fee. Nobody is obliged to: a buy time nobody triggers is skipped. A keeper picks only the moment, inside a due buy time; the vault fixes the amount, the price floor and where the tokens go.",
  // The last sentence is the disclosure the how list makes, here too: this
  // tip is the only explanation of the fee on a vault's card.
  get fee(): string {
    return `Set once, when the vault is created, and paid from its budget as WETH to the keeper that makes each buy — or back to you when you trigger it: a fixed estimate of one buy's network fee when many buys share a transaction, plus ${sharePercent()}% of the buy, and never more than ${ceilingPercent()}% of the buy. No vault can be created with more, and nobody can change it afterwards, spDEX included. The keeper may be one run by spDEX's developers, who keep what's left of it after the network fee.`;
  },
  /** The fee tip on a v1 vault's card: v1's rule, which that vault keeps for good. */
  get feeV1(): string {
    return `Set once, when the vault was created, and paid from its budget as WETH to whoever triggers each buy: a fixed estimate of one buy's network fee when many buys share a transaction, plus ${v1MarkupPercent()}% of that estimate, and never more than ${ceilingPercent()}% of the buy. Nobody can change it, spDEX included. Whoever triggers a buy may be a keeper run by spDEX's developers, who keep what's left of it after the network fee.`;
  },
  weth: "Wrapped Ether: ETH as a token, always worth exactly 1 ETH. A vault holds its budget, and pays its buy fees, as WETH; closing it sends what's left back to you as ETH.",
  tenMinuteAverage:
    "Uniswap v3's own average price for SPX over the last 10 minutes, read on chain. A vault refuses a buy that would get more than your allowance less than that average, or than the price now if that's better for you. Moving a 10-minute average means holding the price there for minutes, not one swap.",
} as const satisfies Record<string, string>;

/**
 * "Keeper" on a card for a vault built from `source`: one that pays the
 * `rewardTo` its trigger names, with a community window (v2 on), or one that
 * pays whoever triggers it (v1). By what the source can do, not its name.
 */
export function keeperTipFor(source: SourceId): string {
  return SOURCES[source].features.executeTakesRewardTo ? VAULT_TIPS.keeper : VAULT_TIPS.keeperV1;
}

/**
 * The buy fee's tip by the rule a source's plans were offered, which each of
 * its vaults keeps for good. Keyed by source and typed so: a new source does
 * not compile without its own sentence, since what fee its plans are offered
 * is a release decision (`SOURCE_BUYS` in @spdex/vault); a release built from
 * an existing source shares its row.
 */
const FEE_TIPS: Record<SourceId, () => string> = {
  v1: () => VAULT_TIPS.feeV1,
  v2: () => VAULT_TIPS.fee,
};

/** The buy fee's tip on a card for a vault built from `source`. */
export const feeTipFor = (source: SourceId): string => FEE_TIPS[source]();

/**
 * A vault with turns, in one line: "The first half of each community window
 * is shared out in turns among 4 groups of SPX holders; then any holder can
 * earn the fee, and after the window anyone can." Null for a vault without
 * turns (0, every vault spDEX creates until decision 29 of docs/DESIGN.md
 * calls for them) and for one whose source has none.
 */
export function vaultTurnsLine(turnBuckets: number | null): string | null {
  if (turnBuckets === null || turnBuckets === 0) return null;
  return `The first half of each community window is shared out in turns among ${formatCount(turnBuckets)} groups of SPX holders; then any holder can earn the fee, and after the window anyone can.`;
}

/**
 * Gas the vault factory's one-time deployment uses: about 3,850,000 for this
 * release's, estimated on the shared fork as a plain creation (3,894,464) and
 * scaled as v1's estimate was to its measured 3,562,618 through the
 * deterministic deployer, rounded up. For the cost sentence only; the wallet
 * sets the real limit.
 */
export const FACTORY_DEPLOY_GAS = 3_850_000n;

/**
 * Gas the SPX holder registry's one-time deployment uses, the factory's first
 * step where it isn't on the chain yet: about 1,760,000, estimated the same
 * way (1,777,825 as a plain creation).
 */
export const REGISTRY_DEPLOY_GAS = 1_760_000n;

/**
 * What setting vaults up on a network deploys, in gas: the factory, and the
 * registry before it when `registryMissing`.
 */
export const setupGas = (registryMissing: boolean): bigint => FACTORY_DEPLOY_GAS + (registryMissing ? REGISTRY_DEPLOY_GAS : 0n);

/** "3.9" ("3,9" in German): the setup's gas in millions, as the setup banner says it. */
export const factoryDeployMillions = (registryMissing = false): string =>
  formatNumber(Number(setupGas(registryMissing)) / 1e6, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Gas a wallet plan's buy of SPX with ETH uses: what confirming each buy
 * yourself costs, for the note that says when that is cheaper than a vault's
 * buy fee. Measured on the pinned fork (`eth_simulateV1`, 0.002 ETH): through
 * Uniswap v2, 137,716 to an owner already holding SPX and 154,816 to one
 * holding none; through v3's 0.3% pool, 131,795 and 158,495. A plan's first
 * buy is the dear case and the rest the cheap one, so 150,000 errs towards
 * the dear end, which keeps the note from promising a saving too soon.
 */
export const WALLET_BUY_TYPICAL_GAS = 150_000n;

/**
 * What one wallet buy of SPX with ETH costs in gas at today's fees
 * (`WALLET_BUY_TYPICAL_GAS` at the fee a block would charge now), or null
 * when fees aren't read. An estimate, where the summary box's "up to" is a
 * bound: it is the figure set beside a vault's buy fee, so both are typical.
 */
export function walletBuyGasCost(fees: FeeRead): bigint | null {
  return fees.kind === "ok" ? WALLET_BUY_TYPICAL_GAS * feePerGasNow(fees.fees) : null;
}

/** "2%", "1.5%": a basis-point allowance as a person reads it. */
export function allowanceText(bps: number | bigint): string {
  return `${percentText(Number(bps) / 100)}%`;
}

/** The allowance chips, 1% / 2% / 3%: the form's, and a not-yet-created vault card's. */
export const VAULT_SLIPPAGE_OPTIONS = VAULT_SLIPPAGE_CHOICES.map((bps) => ({ value: String(bps), label: allowanceText(bps) }));

/**
 * A cost as the form leads with it: "≈ $0.52 (0.0001984 ETH)", money first
 * when a rate is known, else "0.0001984 ETH". The ether figure is rounded up,
 * as every figure someone is asked to pay is. A `share` goes inside the same
 * brackets: "≈ $0.05 (0.00002013 ETH, 0.08%)", or "0.00002013 ETH (0.08%)".
 */
export function feeLead(wei: bigint, money: MoneyView | undefined, share?: string): string {
  const worth = fiatCostText(wei, money);
  const ether = `${ethUpTo(wei)} ETH`;
  const pct = share === undefined ? "" : `${share}%`;
  if (worth === null) return pct === "" ? ether : `${ether} (${pct})`;
  return `${worth} (${pct === "" ? ether : `${ether}, ${pct}`})`;
}

/**
 * Who a new vault's buy fee goes to, said wherever the fee is: the keeper
 * that makes the buy, maybe spDEX's developers'. Who may be paid first, SPX
 * holders in each buy's community window, is said once, by the window's own
 * line (`communityWindowLine`), not again beside every fee.
 */
export const FEE_PAYEE = "paid to the keeper that makes it — maybe spDEX's developers";

/**
 * The two ways a Recurring plan runs, as their choice cards are titled.
 * "Set and forget" is the name the user chose for a vault plan; the card's
 * short line says what it is ("a vault … no tab needed").
 */
export const SIGNER_CHOICE_TITLES = {
  wallet: "Confirm each buy myself",
  vault: "Set and forget",
} as const;

/**
 * The wallet ChoiceCard's network fee for a plan paying with ETH: "≈ $0.05 a
 * buy (1.05%)", worked out as the vault's buy fee is shown beside it, so the
 * two cards can be compared at a glance. Null until fees are read, and for a
 * plan with no amount yet.
 */
export function walletFeeText(amountPerBuy: bigint, fees: FeeRead, money?: MoneyView): string | null {
  const gas = walletBuyGasCost(fees);
  if (gas === null || amountPerBuy <= 0n) return null;
  return `${moneyOrEth(gas, money)} a buy (${bpsPercentText(feeShareBps(gas, amountPerBuy))}%)`;
}

/** "≈ $0.10" when a rate is known, else "0.0000393 ETH": one figure, where a line has room for one. */
function moneyOrEth(wei: bigint, money: MoneyView | undefined): string {
  return fiatCostText(wei, money) ?? `${ethUpTo(wei)} ETH`;
}

/**
 * The line the wallet choice's fee warning adds when, at today's fees, a
 * vault would cost this plan less in all — its buy fees plus creating it,
 * against a wallet buy's network fee for every buy — or null. The warning
 * otherwise only says to buy less often, while the cheaper choice sits one
 * card below; the figure is the whole plan's, so creating the vault is in it.
 */
export function vaultCheaperText(
  costs: Pick<VaultCosts, "fee" | "rewardsTotal" | "createFee">,
  input: { maxBuys: number; fees: FeeRead; money?: MoneyView },
): string | null {
  const wallet = walletBuyGasCost(input.fees);
  if (wallet === null || costs.createFee === null) return null;
  if (costs.rewardsTotal + costs.createFee >= BigInt(input.maxBuys) * wallet) return null;
  const short = (wei: bigint) => fiatCostText(wei, input.money) ?? `${ethUpTo(wei)} ETH`;
  return (
    `A vault would cost this plan less at today's fees: a buy fee of ${short(costs.fee.reward)} a buy, ` +
    `plus ${short(costs.createFee)} once to create the vault.`
  );
}

/**
 * The vault ChoiceCard's cost line: what creating it costs, then the buy fee
 * each buy pays — in money when a rate is known, else in ETH, and as a share
 * of the buy, which is the figure a newcomer can judge — and who it is paid
 * to: "≈ $0.49 to create, then ≈ $0.10 a buy (0.5%), paid to the keeper that
 * makes it — maybe spDEX's developers.", shaped as the wallet choice's cost
 * beside it. Its ETH figures are in the summary's breakdown.
 *
 * The buy fee is known as soon as there is an amount: it depends on nothing
 * else. Only the creation's network fee waits for current fees, and while it
 * does, or when they couldn't be read, the line says it is unknown. Without
 * an amount the fee is its ceiling, as a bound: "up to 0.69%".
 */
export function vaultCostText(costs: VaultCosts | null, fees: FeeRead, money?: MoneyView): string {
  if (costs === null) return `Buy fee: up to ${ceilingPercent()}% a buy, ${FEE_PAYEE}.`;
  const creation =
    costs.createFee !== null
      ? `${fiatCostText(costs.createFee, money) ?? `≈ ${ethUpTo(costs.createFee)} ETH`} to create`
      : fees.kind === "error"
        ? "Creating it: fee unknown (current fees couldn't be read)"
        : "Creating it: fee unknown until fees are read";
  const fee = costs.fee;
  const share = `${bpsPercentText(fee.shareBps)}%${fee.atCeiling ? ", the most it can be" : ""}`;
  return `${creation}, then ${moneyOrEth(fee.reward, money)} a buy (${share}), ${FEE_PAYEE}.`;
}

/**
 * The summary box's extra line for a vault: what the one confirmation sends.
 * "One confirmation puts in 0.03006039 ETH: the buys and their fees." The
 * split is in the fees' breakdown.
 */
export function vaultSetupText(costs: VaultCosts | null, buysTotal: bigint | null): string {
  if (costs === null || buysTotal === null) return "One confirmation puts in the plan's whole budget.";
  return `One confirmation puts in ${ethUpTo(costs.budget)} ETH: the buys and their fees.`;
}

/** One of the notes under the vault choice about what its buy fee means for this plan. */
export interface VaultFeeNote {
  /** Fixed, for e2e: `dca-form-vault-small`, `-held` or `-wallet-cheaper`. */
  testId: string;
  /** A banner's tone and title, or null for a plain line. */
  banner: { tone: "warn" | "ok"; title: string } | null;
  /** The note itself. Its first "keeper" is the word the form explains with a `Term`. */
  text: string;
}

/** "≥ $3.88" or, without a rate, "≥ 0.0015 ETH": the amount a buy that avoids a note starts at. */
function fromAmountText(threshold: bigint, money: MoneyView | undefined): string {
  const worth = fiatCostText(threshold, money)?.replace(/^≈\s/, "");
  return `≥ ${worth ?? `${ethText(threshold, 2, "up")} ETH`}`;
}

/**
 * What the buy fee means for this plan, as notes in the order the form shows
 * them, or none. The buy fee is fixed by the release, never sized from the
 * network fee of the moment, so what a person needs to know is what it pays
 * for:
 *
 * - **May be skipped** (`!coversCheapBatchedBuy`): the fee, 0.69% of a buy
 *   this small, is less than one batched buy's network cost even at a cheap
 *   block. Nothing obliges a keeper to pay the difference, so the honest
 *   word is "may".
 * - **Depends on low network fees** (held at the ceiling below the network
 *   part, and covering a cheap batched buy): less than one batched buy's
 *   network cost at the release's reference fee, which larger buys pay in
 *   full, so a keeper's cost is covered only while fees stay low, and none is
 *   promised.
 * - **Your wallet is cheaper** (fees read, and the fee more than twice what a
 *   wallet buy's gas costs now): at fees this low a vault costs more than
 *   confirming each buy, and the person should know that the fee is what the
 *   convenience costs. Twice, so that the next hour's fees don't make it false.
 *
 * No note says that every vault buy rests on keepers sharing transactions:
 * that is true of all of them, and the fee's own tip says it.
 */
export function vaultFeeNotes(fee: BuyFee, input: { amountPerBuy: bigint; fees: FeeRead; money?: MoneyView }): VaultFeeNote[] {
  const notes: VaultFeeNote[] = [];
  const lead = feeLead(fee.reward, input.money);
  const tier = feeTier(fee.reward, input.amountPerBuy);
  if (tier === "small") {
    notes.push({
      testId: "dca-form-vault-small",
      banner: { tone: "warn", title: "Buys this small may be skipped" },
      text: `Their buy fee is below a keeper's cost even when network fees are low. ${fromAmountText(CHEAP_BATCHED_BUY_THRESHOLD, input.money)} a buy avoids this.`,
    });
  } else if (tier === "held") {
    notes.push({
      testId: "dca-form-vault-held",
      banner: { tone: "ok", title: "Small buys depend on low network fees" },
      text: `Held at ${ceilingPercent()}%, their buy fee may not cover a keeper's cost unless network fees are low. ${fromAmountText(HELD_BELOW, input.money)} a buy avoids this.`,
    });
  }
  const wallet = walletBuyGasCost(input.fees);
  if (wallet !== null && fee.reward > 2n * wallet) {
    const walletWorth = fiatCostText(wallet, input.money)?.replace(/^≈\s/, "");
    notes.push({
      testId: "dca-form-vault-wallet-cheaper",
      banner: null,
      text: `At today's network fees, confirming each buy yourself costs less: about ${walletWorth ?? `${ethUpTo(wallet)} ETH`} a buy, against a buy fee of ${lead}.`,
    });
  }
  return notes;
}

/**
 * The least buy whose fee, held at the 0.69% ceiling, still covers one
 * batched buy's network cost at the release's reference fee (`NETWORK_PART`):
 * about 0.00274 ETH. Below it, a fee is "held" under that cost.
 */
export const HELD_BELOW = (NETWORK_PART * 10_000n + BUY_FEE_CEILING_BPS - 1n) / BUY_FEE_CEILING_BPS;

/**
 * Which of the two buy-fee warnings a fee earns, the form's and a card's
 * alike: "small" when it is less than one batched buy's network cost even at
 * a cheap block, "held" when it covers that but the ceiling holds it under
 * that cost at the release's reference fee, which larger buys pay in full
 * (`NETWORK_PART`), or null. Only the ceiling can hold a fee under the network
 * part: unheld, a fee is that part and its share of the buy.
 */
function feeTier(reward: bigint, amountPerBuy: bigint): "small" | "held" | null {
  if (!coversCheapBatchedBuy(reward)) return "small";
  return amountPerBuy > 0n && reward < NETWORK_PART ? "held" : null;
}

/**
 * The line a not-yet-created vault's card shows under its buy fee, or null:
 * the form's first two notes, judged on the fee the click would send (a kept
 * one may be lower than today's default), as a line rather than a banner.
 */
export function retryFeeNote(reward: bigint, amountPerBuy: bigint): { testId: string; text: string } | null {
  if (amountPerBuy <= 0n) return null;
  switch (feeTier(reward, amountPerBuy)) {
    case "small":
      return {
        testId: "dca-vault-retry-small",
        text: "Buys this small may be skipped: the buy fee is below a keeper's cost even when network fees are low.",
      };
    case "held":
      return {
        testId: "dca-vault-retry-held",
        text: `Held at the ${ceilingPercent()}% ceiling: may only be made when network fees are low. Untriggered times are skipped.`,
      };
    default:
      return null;
  }
}

/**
 * What triggering a buy yourself costs in gas at today's fees, or null when
 * fees aren't read: `VAULT_GAS.firstTrigger` for a vault's first buy, which
 * writes more from zero, `VAULT_GAS.trigger` for a later one, at the fee a
 * block would charge now. The figure the due banner quotes, and weighs
 * against the buy fee it pays back.
 */
export function triggerGasCost(fees: FeeRead, firstBuy: boolean): bigint | null {
  if (fees.kind !== "ok") return null;
  return (firstBuy ? VAULT_GAS.firstTrigger : VAULT_GAS.trigger) * feePerGasNow(fees.fees);
}

/**
 * The due banner's line, to the owner: a keeper may make the buy, and so may
 * they, at the cost of the network fee, with the buy fee coming back. The fee
 * is the vault's own figure, to six digits as the card gives it; the network
 * fee is an estimate at today's fees (`triggerGasCost`, null when unread).
 * Dollars lead both when a rate is known, so that $0.61 against $0.08 can be
 * seen at a glance, where 0.00024816 against 0.0000323834 could not.
 */
export function dueText(reward: bigint, gas: bigint | null, money?: MoneyView): string {
  const feeWorth = fiatCostText(reward, money);
  const fee = feeWorth === null ? `${ethText(reward, 6)} WETH` : `${feeWorth} (${ethText(reward, 6)} WETH)`;
  const network = gas === null ? "" : `, ${fiatCostText(gas, money) === null ? `about ${ethUpTo(gas)} ETH` : feeLead(gas, money)} today,`;
  return `A keeper may trigger it for its buy fee, ${fee}. Or trigger it yourself: you pay the network fee${network} and get the buy fee as WETH.`;
}

/**
 * The due banner's line when triggering costs more than the buy fee it pays
 * back, or null. "The buy fee comes back to you" reads like money back; below
 * this it is a net cost, and the owner should hear so before pressing. The
 * figures are in the line above it.
 */
export function triggerCostText(fees: FeeRead, reward: bigint, firstBuy: boolean): string | null {
  const gas = triggerGasCost(fees, firstBuy);
  if (gas === null || gas <= reward) return null;
  return "That network fee is more than the buy fee, so waiting for a keeper costs you less.";
}

/**
 * What setting vaults up costs at today's fees — the factory's one-time
 * deployment, and the registry's before it when `registryMissing` — or null
 * when fees aren't read.
 */
export function deployFee(fees: PreparedFees | null, registryMissing = false): bigint | null {
  return fees === null ? null : setupGas(registryMissing) * feePerGasNow(fees);
}

/**
 * "Holds": what the vault has left, and how many of its remaining buys that
 * covers. Every figure is the vault's own, read at one block, so none of them
 * is a guess; a vault that holds nothing says what to do about it.
 */
export function vaultHoldsText(figures: Pick<VaultFigures, "closed" | "balance" | "buysLeft" | "terms">): string {
  const { balance, buysLeft, terms } = figures;
  if (figures.closed) return balance === 0n ? "Nothing — it's closed" : `${ethText(balance, 6)} WETH, sent to it after it closed`;
  if (balance === 0n) return buysLeft === 0 ? "Nothing" : "Nothing — fund it to go on";
  const perBuy = terms.amountPerBuy + terms.keeperReward;
  if (buysLeft === 0) return `${ethText(balance, 6)} WETH · every buy is done`;
  const covers = perBuy > 0n ? balance / perBuy : 0n;
  if (covers >= BigInt(buysLeft)) return `${ethText(balance, 6)} WETH · covers every buy left`;
  return `${ethText(balance, 6)} WETH · enough for ${covers.toString()} of the ${formatCount(buysLeft)} buys left`;
}

/**
 * "0.00002013 WETH a buy (≈ $0.05, 0.21% of each) · 0.00004026 WETH paid so far": the
 * vault's buy fee, and what it has paid keepers. The vault's own figure to
 * six digits, as every figure on the card is, with the dollars and the share
 * of each buy the form gave it in, which are what a newcomer can judge.
 */
export function vaultRewardText(figures: Pick<VaultFigures, "terms" | "rewardsPaid">, money?: MoneyView): string {
  const { keeperReward, amountPerBuy } = figures.terms;
  if (keeperReward === 0n) return "None: nothing pays a keeper to trigger its buys";
  const share = amountPerBuy > 0n ? `${bpsPercentText(feeShareBps(keeperReward, amountPerBuy))}% of each` : null;
  const worth = fiatCostText(keeperReward, money);
  const aside = [worth, share].filter((part) => part !== null).join(", ");
  const each = `${ethText(keeperReward, 6)} WETH a buy${aside === "" ? "" : ` (${aside})`}`;
  return figures.rewardsPaid === 0n ? `${each} · none paid yet` : `${each} · ${ethText(figures.rewardsPaid, 6)} WETH paid so far`;
}

/**
 * The "Close and withdraw" question: what comes back, and that it is final.
 * A vault has no pause and no reopen; saying so here is the last chance to.
 */
export function closeConfirmText(figures: Pick<VaultFigures, "balance">): string {
  const back =
    figures.balance === 0n
      ? "It holds nothing, so nothing comes back."
      : `Everything it holds — ${ethText(figures.balance, 6)} WETH — comes back to your wallet as ETH.`;
  return `${back} It never buys again and can't be reopened.`;
}

/**
 * The card's one reason line where `vaultCardStatus` leaves it to the card
 * (a vault simply waiting for its next buy time), or words the chain's own
 * phrasing would make awkward — a buy due by the clock carried forward that no
 * block has shown yet reads as a wait for that block, not as an ISO timestamp.
 * A vault without a community window (v1) is anyone's once due; one with a
 * window is SPX holders' first, which its due banner says
 * (`communityWindowLiveText`), so its wait says no more than that it waits.
 */
export function vaultLine(status: VaultCardStatus, state: VaultPlanState): string {
  const figures = state.kind === "active" || state.kind === "someone-else" ? state : null;
  if (status.vault === "waiting-price" && figures !== null && !figures.due) {
    return "The next buy is due about now. It can be triggered once the network's next block shows it.";
  }
  if (status.vault === "waiting") {
    const wait = figures !== null && figures.buysDone === 0 ? "Waiting for the first buy time." : "Waiting for the next buy time.";
    return figures !== null && !SOURCES[figures.source].features.communityWindow ? `${wait} Then anyone can trigger it.` : wait;
  }
  return status.reason ?? "";
}

/**
 * The end of a vault card's terms line, around the word "vault" (which the
 * card makes a `Term`): what the vault does for this plan now. A closed vault
 * no longer "buys it", and one not yet created doesn't yet.
 */
export function vaultTermsTail(state: VaultPlanState): [before: string, after: string] {
  switch (state.kind) {
    case "not-created":
    case "creating":
      return ["a ", " will buy it, once created"];
    case "loading":
    case "unavailable":
      return ["bought by a ", ""];
    default:
      break;
  }
  if (state.closed) return ["its ", " is closed"];
  if (state.buysLeft === 0) return ["its ", " has made every buy"];
  // Unfunded, it buys nothing yet, with spDEX open or not.
  if (!state.funded) return [state.kind === "someone-else" ? "someone else's " : "a ", " will buy it once funded"];
  // "When triggered": it buys only when someone sends the buy, and nobody is
  // obliged to.
  if (state.kind === "someone-else") return ["someone else's ", " buys it when triggered, with or without spDEX open"];
  return ["a ", " buys it when triggered, with or without spDEX open"];
}

/**
 * The line under a vault plan's "Create and fund vault": what the one
 * confirmation sends — worked out from the very terms the click sends
 * (`vaultRetryTerms`), not from today's default — and roughly what creating
 * costs in gas, once fees are read. Null until the buy fee is known.
 */
export function createSendsText(retry: Pick<VaultRetryTerms, "fund"> | null, costs: Pick<VaultCosts, "createFee"> | null): string | null {
  if (retry === null || retry.fund === null) return null;
  const fee = costs === null || costs.createFee === null ? "" : `, plus ≈ ${ethUpTo(costs.createFee)} ETH network fee`;
  return `Sends ${ethText(retry.fund, 6, "up")} ETH (every buy and its buy fee) in 1 confirmation${fee}.`;
}

/**
 * The buy fee a not-yet-created vault would pay, for its card: in ETH and as
 * a share of each buy, and whose figure it is — the one kept from when the
 * plan was set up, or the current default for its amount. Unknown only for a
 * plan whose amount per buy isn't one. Who it is paid to is the line under it
 * (`retryPayeeText`).
 */
export function retryRewardText(retry: Pick<VaultRetryTerms, "keeperReward" | "keptReward">, amountPerBuy: bigint): string {
  if (retry.keeperReward === null || amountPerBuy <= 0n) return "unknown: the plan's amount per buy can't be read";
  const share = bpsPercentText(feeShareBps(retry.keeperReward, amountPerBuy));
  return `${ethUpTo(retry.keeperReward)} ETH a buy, ${share}% of each · ${retry.keptReward ? "as you set it up" : "the current default"}`;
}

/**
 * Who a not-yet-created vault's buy fee goes to, on the line under its figure:
 * `FEE_PAYEE`, as the form's cost line says it (UI rule R6,
 * docs/ARCHITECTURE.md: visible, not only in the fee's tip).
 */
export function retryPayeeText(): string {
  return `Each buy's fee is ${FEE_PAYEE}.`;
}

/**
 * The line above "Create and fund vault": the limits a newcomer must see
 * before the one click that puts the whole budget into an unaudited vault
 * (UI rule R6). A plan imported from a settings link reaches
 * this card without ever seeing the Recurring form that says them. Anyone can
 * make a due buy, but SPX holders have first claim for its community window:
 * both halves stay in view.
 */
export function retryRulesText(cap: string): string {
  return `Anyone can make its due buys, SPX holders first; nobody has to. Only closing it stops it. At most ${cap}.`;
}

// ── The community window ──────────────────────────────────────────────────

/**
 * A community window's length after "its first": "30 minutes", "75 seconds",
 * "minute", "hour". Whole minutes as minutes, anything else in seconds.
 */
function windowLength(seconds: number): string {
  if (seconds === 60) return "minute";
  if (seconds === 3_600) return "hour";
  return seconds % 60 === 0 ? `${formatCount(seconds / 60)} minutes` : `${formatCount(seconds)} seconds`;
}

/**
 * Who may earn a vault plan's fee, and for how long (decision 3 of
 * docs/DESIGN.md), in the form's "How auto-buy works" and on a vault's
 * retry. The choice card says "SPX holders first" in view (UI rule R6). "SPX holders
 * can earn this plan's fee for its first 30 minutes after each buy falls due;
 * then anyone can." Earn, not "be paid": the owner's own Trigger now is paid
 * the fee back, which is no one earning it.
 */
export function communityWindowLine(seconds: number): string {
  return `SPX holders can earn this plan's fee for its first ${windowLength(seconds)} after each buy falls due; then anyone can.`;
}

/** Expert's one hint beside the window's choice, as decision 26 words it. */
export const COMMUNITY_WINDOW_HINT =
  "Shorter: your buy happens sooner when no holder is online. Longer: holders have more time to earn your fee.";

/** "1 min", "75 s": a window in the select's short form. */
function windowShort(seconds: number): string {
  return seconds % 60 === 0 ? `${formatCount(seconds / 60)} min` : `${formatCount(seconds)} s`;
}

/** An option of Expert's window select: "30 min", or "A quarter of the interval (75 s)". */
export function windowOptionLabel(option: { value: string; seconds: number }): string {
  return option.value === "quarter" ? `A quarter of the interval (${windowShort(option.seconds)})` : windowShort(option.seconds);
}

/**
 * The due banner's line on a vault while its buy is inside its community
 * window: "Community window until 14:32, then open to anyone." Inside the
 * first half of a window shared out in turns, it says that too: "This buy's
 * turn until 14:17, for SPX holders in its group; then any SPX holder until
 * 14:32, then anyone." Null for a vault without a window (v1), one whose buy
 * isn't due by the clock, after the window, and when the chain's clock is
 * unknown. The times are chain time, shown in this device's clock
 * (`deviceTimeOf`), as the card's other times.
 */
export function communityWindowLiveText(
  figures: Pick<VaultFigures, "source" | "windowEndsAt" | "nextBuyAt"> & Partial<Pick<VaultFigures, "turnEndsAt">>,
  chainNow: number | null,
  nowMs: number,
): string | null {
  const { windowEndsAt, nextBuyAt } = figures;
  if (!SOURCES[figures.source].features.communityWindow || windowEndsAt === null || nextBuyAt === null || chainNow === null) return null;
  if (chainNow < nextBuyAt || chainNow >= windowEndsAt) return null;
  const windowEnds = localClock(deviceTimeOf(windowEndsAt, chainNow, nowMs));
  const turnEndsAt = figures.turnEndsAt ?? null;
  if (turnEndsAt !== null && chainNow < turnEndsAt) {
    const turnEnds = localClock(deviceTimeOf(turnEndsAt, chainNow, nowMs));
    return `This buy's turn until ${turnEnds}, for SPX holders in its group; then any SPX holder until ${windowEnds}, then anyone.`;
  }
  return `Community window until ${windowEnds}, then open to anyone.`;
}

/** One row of a vault's history, as the card lists it. */
export interface VaultHistoryRow {
  /** Stable while newer rows arrive: counted from the oldest row read. */
  seq: number;
  kind: VaultHistoryEntry["kind"];
  text: string;
  hash: VaultHistoryEntry["hash"];
}

/**
 * A vault's history rows, newest first: "#2 · Sep 21, 14:05 · Bought 13.07
 * SPX for 0.01 ETH · triggered by you, paid you its 0.00002013 WETH buy fee".
 *
 * Buys are numbered as the vault counts them: when earlier ones weren't read
 * (`missingBuys`), the oldest shown is not #1. Times are block times carried
 * into this device's clock (`deviceTimeOf`), the same as every countdown on
 * the card; a block whose time couldn't be read shows none rather than a
 * guess, and so does every row while the chain's clock is unknown.
 */
export function vaultHistoryRows(input: {
  entries: readonly VaultHistoryEntry[];
  missingBuys: number;
  terms: Pick<VaultTerms, "tokenOut">;
  account: Address | null;
  chainNow: number | null;
  nowMs: number;
}): VaultHistoryRow[] {
  const oldestFirst = [...input.entries].reverse();
  let buy = input.missingBuys;
  const rows = oldestFirst.map((entry, index) => {
    const parts: string[] = [];
    if (entry.kind === "bought") {
      buy += 1;
      parts.push(`#${formatCount(buy)}`);
    }
    if (entry.at !== null && input.chainNow !== null) {
      parts.push(dateTime(deviceTimeOf(entry.at, input.chainNow, input.nowMs) * 1000));
    }
    parts.push(vaultHistorySentence(entry, input.terms, input.account));
    return { seq: index, kind: entry.kind, text: parts.join(" · "), hash: entry.hash };
  });
  return rows.reverse();
}

/** "0x7099…79c8 (you)": a vault's owner, marked when it is the connected wallet. */
export function ownerText(owner: Address, mine: boolean | null): string {
  return mine === true ? `${owner} (you)` : owner;
}

/**
 * A found vault's one line: a vault on chain that no plan points at. Its card
 * is a compact one, with no Trigger now and no Fund, so where a plan card's
 * line would point at one of those, this points at the button that brings
 * them back.
 */
export function strayVaultLine(status: VaultCardStatus, state: VaultPlanState): string {
  // Closed: how far it got. Where what it held went is the Holds row's, and
  // the notice's when it was closed from here, and the owner is the viewer.
  if (status.vault === "closed") return `${closedVaultText(state)}.`;
  if (status.vault === "due") {
    return "The next buy is due — waiting for a keeper. Add it back to your plans to trigger it yourself.";
  }
  if (status.vault === "unfunded") {
    return "It can't cover its next buy and its buy fee. Add it back to your plans to fund it, or close it.";
  }
  return vaultLine(status, state);
}

/** A closed, empty vault's row in "Closed vaults": how far it got. */
export function closedVaultText(state: VaultPlanState): string {
  if (state.kind !== "active" && state.kind !== "someone-else") return "Closed";
  const count = (n: number) => formatCount(n);
  return `Closed after ${count(state.buysDone)} of ${count(state.maxBuys)} ${state.maxBuys === 1 ? "buy" : "buys"}`;
}
