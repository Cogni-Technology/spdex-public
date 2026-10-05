/**
 * The Recurring tab of the Trade card: setting up an auto-buy.
 *
 * Stacked fields and one live sentence rather than a sentence built of
 * controls: each control keeps a real label, and it reads the same on a phone.
 * Everything the form says is computed by lib/dca/form.ts from exactly what
 * Start would save, so the summary, the fee line and the plan can't disagree.
 *
 * Every limit is stated here, where the decision is made, not in a help page:
 * buys you confirm need you and an open tab, missed buy times are skipped,
 * fees are shown as a share of the plan, and a network service that can't run
 * the safety test blocks Start rather than producing a plan that silently
 * never buys (every scheduled buy is checked, and a check that can't run
 * skips it).
 *
 * There are two ways to buy, for the two things people want from a recurring
 * buy: to be asked each time, or to set it and forget it. (A third, autopilot,
 * bought without asking but only while a tab was open, which is neither; it
 * was removed in config version 8.) The second, a vault, changes more than who
 * signs: its buys happen whether or not any spDEX tab is open, so the limits
 * and the "how it works" lines describe it instead of the tab's, and the risk
 * line states what the contract is — unaudited, capped at 0.5 ETH going in,
 * withdrawable only by its owner, unchangeable by anyone. A vault buys SPX
 * with ETH and nothing else (the factory's one market), so choosing it sets
 * the pair and holds it.
 *
 * The words are short on purpose (UI rules R5 and R6, docs/ARCHITECTURE.md):
 * each visible line is one short sentence or one line of figures, and the
 * reasons behind it are one tap away (a `Term`, or the closed "How auto-buy
 * works"). What must never be a tap away stays visible: UNAUDITED and the
 * 0.5 ETH cap; that anyone can trigger a vault's buy, SPX holders first for its
 * community window, and nobody has to; that
 * only closing it stops it; who the buy fee is paid to; that missed times are
 * skipped and the plan ends later; that a plan you confirm needs spDEX open;
 * and every refusal.
 *
 * Starting a plan keeps the form where it is: the banner that says so stays
 * under Start, with a button that shows the new plan in Auto-buys.
 *
 * Test ids are all `dca-form-*`, so nothing here collides with the One-time
 * tab, which stays mounted beside it.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Banner, Button, ChoiceCard, Disclosure, Field, Term, Toggle } from "@spdex/ui";
import { NATIVE_TOKEN } from "@spdex/chain";
import { MAX_SCHEDULED_SLIPPAGE_BPS } from "../../lib/engine.js";
import {
  balanceWarning,
  buildPlan,
  buyChoices,
  CUSTOM_FREQUENCY,
  feeEstimate,
  feesBreakdown,
  feesText,
  feeWarningTitle,
  fixedAmountNote,
  fixedAmountWhy,
  FORM_FREQUENCIES,
  initialFields,
  localDate,
  parseForm,
  planIdFrom,
  planPreview,
  startLabel,
  summaryText,
  validationError,
  vaultBalanceWarning,
  vaultFormError,
  walletCostText,
  withSell,
  type FormMoney,
  type RecurringFields,
} from "../../lib/dca/form.js";
import { tokenFor } from "../../lib/dca/format.js";
import { VAULT_FACTORY_ACTIVITY, type AutoBuy, type AutoBuyDeps } from "../../lib/dca/useAutoBuy.js";
import {
  DEFAULT_VAULT_SLIPPAGE_BPS,
  vaultCapText,
  vaultWindowChoiceOf,
  vaultWindowOf,
  vaultWindowOptions,
  vaultWindowValue,
  type VaultWindowChoice,
} from "../../lib/dca/vault.js";
import { GLOSSARY, tokenOptionText } from "../../lib/names.js";
import { networkLabel } from "../../lib/networks.js";
import { formatAmount, TOKEN_LIST } from "../../lib/tokens.js";
import { CULTURE_COUNT_PRESETS, RECURRING_AMOUNT_PRESETS_USD_CENTS } from "../../lib/culture/presets.js";
import { formatCount } from "../../lib/money/format.js";
import { moneyStore } from "../../lib/money/prefs.js";
import type { AmountInput } from "../../lib/money/pricing.js";
import { moneyView, useRatesNeeded } from "../../lib/money/rates.js";
import { prefilledInput, presetInput, presetsBlocked, startingUnit, withFrozen } from "../../lib/money/resolve.js";
import { AmountField } from "../money/AmountField.js";
import { PresetChips, presetFieldText } from "../culture/PresetChips.js";
import { GoTo } from "../../lib/places.js";
import { useTiles } from "../../lib/tiles.js";
import { AddToCalendar, InfoTerm, NoticeBanner } from "./common.js";
import { SayingLine } from "../culture/SayingLine.js";
import { AllowanceHint, UnauditedBadge, VaultFactorySetup, WithKeeperTerm } from "./VaultCard.js";
import {
  allowanceText,
  COMMUNITY_WINDOW_HINT,
  communityWindowLine,
  FEE_PAYEE,
  SIGNER_CHOICE_TITLES,
  VAULT_SLIPPAGE_OPTIONS as SLIPPAGE_OPTIONS,
  VAULT_TIPS,
  vaultCheaperText,
  vaultCostText,
  vaultFeeNotes,
  vaultSetupText,
  walletFeeText,
  windowOptionLabel,
} from "./vaultCopy.js";
import { BUY_FEE_CEILING_BPS, LATEST_RELEASE } from "@spdex/vault";
import { RegistryAdvisory } from "../network/RegistryAdvisory.js";
import { bpsPercentText } from "../../lib/money/format.js";

function newDraftId(): string {
  return planIdFrom(globalThis.crypto.getRandomValues(new Uint8Array(4)));
}

/**
 * What a vault is and does, behind "How vaults work" on its choice card: the
 * card itself keeps only the words that must stay in view.
 */
function howVaultsWork(allowance: string): string {
  return (
    `Unaudited smart contract: you can put in at most ${vaultCapText()}. Only you can withdraw — nobody, not spDEX, can ` +
    `change it or take the funds. Anyone can trigger a due buy and be paid its buy fee, SPX holders first; each buy is refused if the price ` +
    `is more than ${allowance} worse than Uniswap's 10-minute average. It buys SPX only, paid with ETH, through the ` +
    "deepest SPX market."
  );
}

/**
 * The "Auto-buy started" banner's words once its first buy has an answer, or
 * null while it has none: "Confirm the first buy in your wallet now." is
 * true only until the wallet answers.
 */
export function firstRunText(run: { status: string } | undefined): string | null {
  switch (run?.status) {
    case undefined:
    case "pending":
    case "unknown":
      return null;
    case "confirmed":
      return "Its first buy went through.";
    case "declined":
      return "You declined the first buy in your wallet. It's still due: confirm it or skip it in Auto-buys.";
    default:
      return "Its first buy didn't go through; Auto-buys says why.";
  }
}

/** How long the "Auto-buy started" banner stays at least, however soon the first buy settles. */
const STARTED_MIN_MS = 20_000;

export function RecurringForm({ autoBuy, deps }: { autoBuy: AutoBuy; deps: AutoBuyDeps }) {
  const { config, account, walletChainOk, mode } = deps;
  const pricing = deps.pricing;
  const expert = mode === "expert";
  const [fields, setFields] = useState<RecurringFields>(initialFields);
  // The amount's unit, and a money amount's sizing, beside its text in
  // `fields.amount`. A browser that hasn't switched this field starts in its
  // currency.
  const [amountUnit, setAmountUnit] = useState<Omit<AmountInput, "text">>(() => ({
    unit: startingUnit(moneyStore().get().units.recurring, TOKEN_LIST.find((t) => t.symbol === "ETH")!, pricing.currency),
    frozen: null,
  }));
  // Rates are asked for while the tab is open: its figures and a money
  // amount need them, and a hidden tab needs nothing.
  const tick = useRatesNeeded(pricing, deps.recurringOpen);
  const now = Math.max(tick, performance.now());
  // The id the plan will have, fixed while it is being filled in so the
  // Expert preview shows exactly what Start saves.
  const [draftId, setDraftId] = useState(newDraftId);
  const [error, setError] = useState<string | null>(null);
  // The plan Start just made, and what to say about it: where it went and
  // what to do next there.
  const [started, setStarted] = useState<{ planId: string; text: string; atMs: number } | null>(null);
  // Leaving the tab ends the moment the banner was for.
  useEffect(() => {
    if (!deps.recurringOpen) setStarted(null);
  }, [deps.recurringOpen]);
  const [submitting, setSubmitting] = useState(false);
  const { reveal } = useTiles();
  // Where "Change service" comes back to: the container around Start (never
  // Start itself, UI rule R2).
  const actionsRef = useRef<HTMLDivElement>(null);
  // A vault's price allowance: not a field of the plan (the plan has no
  // place for it), but a term of the vault, fixed when it is created.
  const [vaultSlippage, setVaultSlippage] = useState<number>(DEFAULT_VAULT_SLIPPAGE_BPS);
  // A vault's community window, the same kind of term: Expert's choice, else
  // the plan's default, which Simple always uses (decision 26).
  const [vaultWindow, setVaultWindow] = useState<VaultWindowChoice>("default");
  const allowanceId = useId();

  const edit = (patch: Partial<RecurringFields>) => {
    setFields((previous) => ({ ...previous, ...patch }));
    setError(null);
    setStarted(null);
  };

  // A vault buys SPX with ETH and nothing else: the factory it is cloned from
  // lists that one market. Choosing it sets the pair, and an amount typed in
  // another token's units is cleared rather than silently read as ether.
  const chooseVault = () => {
    setFields((previous) => ({
      ...withSell(previous, "ETH"),
      buy: "SPX",
      amount: previous.sell === "ETH" ? previous.amount : "",
      signer: "vault",
    }));
    setError(null);
    setStarted(null);
  };

  const setAmount = (next: AmountInput) => {
    setFields((previous) => ({ ...previous, amount: next.text }));
    setAmountUnit({ unit: next.unit, frozen: next.frozen });
    setError(null);
    setStarted(null);
  };

  // "Set up again" on a card whose record can't be read: the same terms, as
  // a new plan with a new id and a new budget.
  const prefillNonce = autoBuy.prefill?.nonce;
  useEffect(() => {
    const plan = autoBuy.prefill?.plan;
    if (plan === undefined) return;
    const sell = tokenFor(plan.sell);
    const buy = tokenFor(plan.buy);
    const preset = FORM_FREQUENCIES.find((f) => f.seconds === plan.intervalSeconds);
    // A saved plan's amount is a token amount, so the field is prefilled in
    // the token, whatever unit it was left in: "0.01" must never be read as
    // dollars.
    const prefilled = sell === undefined || sell === null ? null : prefilledInput(BigInt(plan.amountPerBuy), sell, pricing.locale);
    if (prefilled !== null) setAmountUnit({ unit: prefilled.unit, frozen: null });
    setFields((previous) => ({
      ...previous,
      ...(sell && prefilled !== null ? { sell: sell.symbol, amount: prefilled.text } : {}),
      ...(buy ? { buy: buy.symbol } : {}),
      frequency: preset?.id ?? CUSTOM_FREQUENCY,
      customMinutes: String(Math.round(plan.intervalSeconds / 60)),
      count: String(plan.maxBuys),
      signer: plan.signer,
      label: plan.label ?? "",
    }));
    setError(null);
    setStarted(null);
    // The tab switch is App's; pressing its own control keeps the tab's state
    // in one place rather than adding a second way to set it. Then the
    // amount is shown wherever the form is: its tile opened, scrolled to,
    // focused.
    document.querySelector<HTMLButtonElement>('[data-testid="buy-mode-recurring"]')?.click();
    requestAnimationFrame(() => void reveal("dca-form-amount"));
    // Keyed on the press alone: the plan it carries is read from the same
    // render, and re-running on anything else would undo the person's edits.
  }, [prefillNonce]);

  const formMoney = (at: number): { money: FormMoney } => ({ money: { input: amountUnit, pricing, nowMs: at } });
  const parsed = useMemo(
    () => parseForm(fields, { expert, ...formMoney(now) }),
    // `now` moves with the rates tick, so a money amount turns stale on screen.
    [fields, expert, amountUnit, pricing, now],
  );
  const sell = parsed.sell;
  const money = moneyView(pricing, now);
  const vaultSupport = autoBuy.vaultSupport;
  // A vault that can't be offered here falls back to the wallet. While the
  // check is still running the choice stays: it usually comes back yes, and
  // Start waits for it.
  const vaultRefused = vaultSupport.kind === "unsupported" || vaultSupport.kind === "unavailable";
  const signer = fields.signer === "vault" && vaultRefused ? "wallet" : fields.signer;
  const vault = signer === "vault";
  const fees = autoBuy.fees.kind === "ok" ? autoBuy.fees.fees : null;
  const estimate = fees === null ? null : feeEstimate(parsed, signer, fees);
  const feeWarning = feeWarningTitle(estimate);
  const ownerBalance = sell === null ? undefined : autoBuy.ownerBalances[sell.address];
  // A vault's figures only mean something for an ether plan: its buy fee is
  // a share of each buy in ether, and an amount of another token isn't one.
  const paysEther = sell !== null && sell.address === NATIVE_TOKEN;
  const vaultCosts = paysEther && parsed.maxBuys !== null ? autoBuy.vaultCostsFor(parsed.amountPerBuy, parsed.maxBuys) : null;
  // An Expert-only choice counts only in Expert, as `parseForm` counts the
  // Expert-only fields: one left behind there must not shape a Simple plan.
  const windowSeconds = parsed.intervalSeconds === null ? null : vaultWindowOf(expert ? vaultWindow : "default", parsed.intervalSeconds);
  const vaultProblem = vault ? vaultFormError(parsed, vaultSlippage, money, windowSeconds) : null;
  // What the buy fee means for this plan — that buys this small may be
  // skipped, or made only while network fees are low — is said here, where
  // the choice is made, not just in the cost line.
  const feeNotes =
    vault && vaultCosts !== null && vaultProblem === null
      ? vaultFeeNotes(vaultCosts.fee, {
          amountPerBuy: parsed.amountPerBuy,
          fees: autoBuy.fees,
          ...(money === undefined ? {} : { money }),
        })
      : [];
  const shortWarning = vault ? vaultBalanceWarning(vaultCosts, ownerBalance) : balanceWarning(parsed, signer, ownerBalance);
  // The wallet card's network fee, given as the vault card's buy fee is, so
  // the two can be compared; and, under the wallet's fee warning, the vault's
  // cost when it would be the cheaper choice.
  const walletFee = paysEther ? walletFeeText(parsed.amountPerBuy, autoBuy.fees, money) : null;
  const vaultCheaper =
    !vault && !vaultRefused && feeWarning !== null && vaultCosts !== null && parsed.maxBuys !== null
      ? vaultCheaperText(vaultCosts, {
          maxBuys: parsed.maxBuys,
          fees: autoBuy.fees,
          ...(money === undefined ? {} : { money }),
        })
      : null;
  const summary = summaryText(parsed, {
    signer,
    nowMs: autoBuy.now,
    ...(money === undefined ? {} : { money }),
  });
  const fixedNote = fixedAmountNote(parsed, signer, money?.locale);
  const fixedWhy = fixedAmountWhy(parsed, signer);
  const breakdown = feesBreakdown(estimate);
  // Until there is an amount there is no plan to put a fee or a setup cost
  // against; the summary asks for the amount instead.
  const hasAmount = parsed.amountPerBuy > 0n;
  // Web Locks decide the one tab that runs plans; without them no tab buys,
  // so a plan you confirm could never ask. A vault needs no tab at all.
  const locksMissing = !autoBuy.webLocks;
  const effectiveSlippage = Math.min(config.slippageBps, MAX_SCHEDULED_SLIPPAGE_BPS) / 100;
  const allowance = allowanceText(vaultSlippage);
  const factoryNotice = autoBuy.activity[VAULT_FACTORY_ACTIVITY]?.notice ?? null;

  // Start's states, first match. Each disabled state says why beside it.
  let blocked: string | null = null;
  if (account !== null && !walletChainOk) blocked = `Switch your wallet to ${networkLabel(config.chainId)} first.`;
  // An amount that isn't a number: said beside Start rather than only above.
  // Pressed, Start never answered: leaving the field shows its own note under
  // it, which moved Start down under the pointer between press and release.
  // A money amount whose price is out of date is the last case below: the
  // field above offers the fix ("Use the price now"), and its own sentence
  // beside Start named no fix at all.
  else if (parsed.amountError !== null && !parsed.amountWaitsOnRates) blocked = parsed.amountError;
  // A vault is run by its keepers, not by a tab, so it doesn't need the
  // browser feature that decides which tab buys.
  else if (!vault && locksMissing) blocked = "This browser can't run a plan you confirm (see above).";
  else if (autoBuy.safety === "checking") blocked = "Checking your network service…";
  else if (autoBuy.safety !== "available") blocked = "This network service can't safety-check yet (see above).";
  else if (vault && vaultSupport.kind === "checking") blocked = "Checking whether a vault can be created here…";
  else if (vault && vaultSupport.kind === "deployable") blocked = "Set up vaults on this network first (above).";
  else if (vault && autoBuy.fees.kind === "reading") blocked = "Waiting for current network fees…";
  else if (vault && autoBuy.fees.kind === "error") {
    blocked = "Can't read current network fees. Try again in a moment.";
  } else if (vault && vaultProblem !== null) blocked = "Change the plan so a vault can take it (see above).";
  else if ((vault || (signer === "wallet" && parsed.startAt === null)) && autoBuy.ownerLockBusy) {
    blocked = "Waiting for your swap to finish…";
  } else if (parsed.amountWaitsOnRates) blocked = "The amount needs a current price first: the amount, above, says how.";

  // The banner is for the moment after Start: where the plan went, and the
  // one thing to do there next. Once that plan's first buy has settled or
  // been skipped, the next step is done and the banner goes — left up, it
  // sat above a live Start button a day later, pointing at nothing. A plan
  // deleted since takes its banner with it. A vault plan's next step is its
  // creation, so its banner goes once the card can show how that went.
  const startedPlan = started === null ? undefined : config.dca.plans.find((plan) => plan.id === started.planId);
  const startedEntry = startedPlan === undefined ? null : autoBuy.entryFor(startedPlan);
  const startedVault = startedPlan?.signer === "vault" ? autoBuy.vaultFor(startedPlan.id)?.kind : undefined;
  // How the first buy went, for a plan the person confirms: the newest record
  // that isn't a buy held for them. A decline gives its window back
  // (ledger.ts `releaseBuy`), so the buy is still due: not over.
  const firstRun =
    startedVault === undefined && startedEntry !== null && startedEntry !== "unavailable"
      ? [...startedEntry.runs].reverse().find((run) => run.status !== "held")
      : undefined;
  const firstBuyOver =
    startedVault !== undefined
      ? startedVault !== "loading" && startedVault !== "creating"
      : firstRun !== undefined && firstRun.status !== "pending" && firstRun.status !== "unknown" && firstRun.status !== "declined";
  // Held while its calendar panel is open, so the button someone is using
  // doesn't vanish under them when the first buy settles. And held for
  // STARTED_MIN_MS from Start: a first buy on a fast network settles within
  // a second, and the banner, with the calendar button in it, came and went
  // before anyone could press it, moving everything under Start twice.
  const [calendarHeld, setCalendarHeld] = useState(false);
  const [startedFresh, setStartedFresh] = useState(false);
  useEffect(() => {
    if (started === null) return;
    const left = started.atMs + STARTED_MIN_MS - Date.now();
    setStartedFresh(left > 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setStartedFresh(false), left);
    return () => clearTimeout(timer);
  }, [started]);
  const startedText =
    started === null || startedPlan === undefined || (firstBuyOver && !calendarHeld && !startedFresh)
      ? null
      : firstRunText(firstRun) ?? started.text;

  const onStart = async () => {
    // Read again at the press, on this moment's clock: an amount in money is
    // saved only while the price it was sized with is fresh.
    const atPress = parseForm(fields, { expert, ...formMoney(performance.now()) });
    if (atPress.amountPerBuy !== parsed.amountPerBuy || atPress.amountError !== null) {
      setError(atPress.amountError ?? "The amount changed. Check it and press Start again.");
      return;
    }
    const problem = validationError(parsed, { nowMs: Date.now(), planCount: config.dca.plans.length }) ?? vaultProblem;
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const plan = buildPlan(parsed, {
        id: draftId,
        chainId: config.chainId,
        signer,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      const result = await autoBuy.startPlan({
        plan,
        signer,
        firstBuyNow: parsed.startAt === null,
        // The buy fee and the window the card showed are the ones the vault is created with.
        ...(vault
          ? {
              vault: {
                maxSlippageBps: vaultSlippage,
                ...(vaultCosts === null ? {} : { keeperReward: vaultCosts.fee.reward }),
                ...(windowSeconds === null ? {} : { communityWindow: windowSeconds }),
              },
            }
          : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStarted({
        planId: plan.id,
        atMs: Date.now(),
        text: vault
          ? "Confirm creating and funding the vault in your wallet now."
          : parsed.startAt === null
            ? "Confirm the first buy in your wallet now."
            : `Its first buy is due ${localDate(parsed.startAt, true)}; confirm it in Auto-buys.`,
      });
      // A fresh form for the next plan, keeping the pair and how often.
      setFields((previous) => ({
        ...initialFields(),
        sell: previous.sell,
        buy: previous.buy,
        frequency: previous.frequency,
        customMinutes: previous.customMinutes,
        signer: previous.signer,
      }));
      setAmountUnit((previous) => ({ unit: previous.unit, frozen: null }));
      setDraftId(newDraftId());
    } finally {
      setSubmitting(false);
    }
  };

  const amountInput: AmountInput = { text: fields.amount, ...amountUnit };
  // The one-tap dollar amounts, while the plan buys SPX and the page has
  // prices to size them with.
  const presetBlock = sell === null ? null : presetsBlocked(pricing, sell, ownerBalance, RECURRING_AMOUNT_PRESETS_USD_CENTS[0]);
  const pickPreset = (cents: number) => {
    if (sell === null) return;
    setAmount(withFrozen(presetInput(presetFieldText(cents, pricing.locale), sell), sell, pricing, performance.now()));
  };

  // On the amount's label row, as the One-time card writes it: nothing
  // without a wallet (the Connect button says that), and never 0 for unread.
  const balanceHint =
    account === null
      ? null
      : sell === null || ownerBalance === undefined
        ? "Balance …"
        : ownerBalance === null
          ? "Balance unknown"
          : `Balance ${formatAmount(ownerBalance, sell.decimals)} ${sell.symbol}`;

  // Simple has no "Custom…": a custom interval left from Expert shows (and is
  // saved) as every day there, which is what the summary already says.
  const frequencyOptions = expert
    ? [...FORM_FREQUENCIES, { id: CUSTOM_FREQUENCY, label: "Custom…", seconds: 0 }]
    : FORM_FREQUENCIES;
  const frequencyShown = frequencyOptions.some((f) => f.id === fields.frequency) ? fields.frequency : "1d";
  const buysTotal = parsed.maxBuys === null ? null : parsed.amountPerBuy * BigInt(parsed.maxBuys);

  return (
    <div className="spdex-dca-form" data-testid="dca-form">
      <div className="spdex-dca-pair">
        <Field label="Pay with">
          <select
            className="spdex-select"
            data-testid="dca-form-sell"
            value={fields.sell}
            disabled={vault}
            onChange={(event) => {
              setFields((previous) => withSell(previous, event.target.value));
              setError(null);
              setStarted(null);
            }}
          >
            {TOKEN_LIST.map((token) => (
              <option key={token.symbol} value={token.symbol}>
                {tokenOptionText(token.symbol)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buy">
          <select
            className="spdex-select"
            data-testid="dca-form-buy"
            value={fields.buy}
            disabled={vault}
            onChange={(event) => edit({ buy: event.target.value })}
          >
            {buyChoices(fields.sell).map((token) => (
              <option key={token.symbol} value={token.symbol}>
                {tokenOptionText(token.symbol)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {vault ? (
        <p className="spdex-dca-hint" data-testid="dca-form-vault-pair">
          Vaults buy SPX with ETH only.
        </p>
      ) : fields.sell === "WETH" || fields.buy === "WETH" ? (
        <p className="spdex-dca-hint">
          <Term tip={GLOSSARY.weth}>WETH</Term> is ETH as a token, always worth exactly 1 ETH.
        </p>
      ) : null}

      {sell === null ? null : (
        <AmountField
          value={amountInput}
          onChange={setAmount}
          token={sell}
          pricing={pricing}
          testIdPrefix="dca-form-amount"
          inputTestId="dca-form-amount"
          label="Amount each time"
          remember="recurring"
          balance={balanceHint === null ? null : <span data-testid="dca-form-balance">{balanceHint}</span>}
          chips={
            fields.buy === "SPX" ? (
              <PresetChips
                context="dca-form"
                cents={RECURRING_AMOUNT_PRESETS_USD_CENTS}
                locale={pricing.locale}
                disabledReason={presetBlock}
                dollarsNote={pricing.currency !== "USD"}
                onPick={pickPreset}
              />
            ) : undefined
          }
        />
      )}

      <div className="spdex-dca-pair">
        <Field label="How often">
          <select
            className="spdex-select"
            data-testid="dca-form-frequency"
            value={frequencyShown}
            onChange={(event) => edit({ frequency: event.target.value })}
          >
            {frequencyOptions.map((frequency) => (
              <option key={frequency.id} value={frequency.id}>
                {frequency.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="spdex-dca-count">
          <Field label="How many buys" hint={`Up to ${formatCount(1_000)}. Every plan ends.`}>
            <input
              className="spdex-input"
              data-testid="dca-form-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              value={fields.count}
              onChange={(event) => edit({ count: event.target.value })}
            />
          </Field>
          {/* The community's own number, one tap away. Outside the field's
              label, so the label names only the input. */}
          <div className="spdex-dca-count__chips">
            {CULTURE_COUNT_PRESETS.map((count) => (
              <button
                key={count}
                type="button"
                className="spdex-presets__chip"
                data-testid={`dca-form-count-${count}`}
                aria-pressed={fields.count.trim() === String(count)}
                onClick={() => edit({ count: String(count) })}
              >
                {count} buys
              </button>
            ))}
          </div>
        </div>
      </div>

      {expert && fields.frequency === CUSTOM_FREQUENCY ? (
        <Field label="Every … minutes" hint="At least 5 minutes.">
          <input
            className="spdex-input"
            data-testid="dca-form-custom-minutes"
            type="number"
            inputMode="numeric"
            min={5}
            step={1}
            value={fields.customMinutes}
            onChange={(event) => edit({ customMinutes: event.target.value })}
          />
        </Field>
      ) : null}

      {expert ? (
        <>
          <div className="spdex-dca-pair">
            <Field label="First buy">
              <select
                className="spdex-select"
                data-testid="dca-form-first-buy"
                value={fields.firstBuy}
                onChange={(event) => edit({ firstBuy: event.target.value === "later" ? "later" : "now" })}
              >
                <option value="now">Now</option>
                <option value="later">At a time I choose</option>
              </select>
            </Field>
            {fields.firstBuy === "later" ? (
              <Field label="First buy at">
                <input
                  className="spdex-input"
                  data-testid="dca-form-start-at"
                  type="datetime-local"
                  value={fields.startAt}
                  onChange={(event) => edit({ startAt: event.target.value })}
                />
              </Field>
            ) : null}
          </div>
          <Field label="Name (optional)">
            <input
              className="spdex-input"
              data-testid="dca-form-label"
              maxLength={64}
              value={fields.label}
              onChange={(event) => edit({ label: event.target.value })}
            />
          </Field>
        </>
      ) : null}

      <div className="spdex-dca-summary">
        <p data-testid="dca-form-summary">{summary}</p>
        {fixedNote !== null ? (
          <p data-testid="dca-form-fiat-fixed">
            {fixedNote}
            {fixedWhy !== null ? <InfoTerm tip={fixedWhy} label="Why fixed?" /> : null}
          </p>
        ) : null}
        {hasAmount ? (
          <p data-testid="dca-form-fees">
            {/* The share is the warning's title when there is one: said once. */}
            {feesText(autoBuy.fees, estimate, money, { share: feeWarning === null })}
            {breakdown !== null ? <InfoTerm tip={breakdown} label="Breakdown" testId="dca-form-fees-breakdown" /> : null}
          </p>
        ) : null}
        {hasAmount && vault ? <p data-testid="dca-form-vault-setup-cost">{vaultSetupText(vaultCosts, buysTotal)}</p> : null}
        {vault && windowSeconds !== null ? <p data-testid="dca-form-vault-window-line">{communityWindowLine(windowSeconds)}</p> : null}
      </div>
      {/* Decision 31's notice: v2 vaults are still created, and say so. Nothing unless a build sets it. */}
      {vault ? <RegistryAdvisory release={LATEST_RELEASE} testId="dca-form-registry-advisory" /> : null}
      {feeWarning !== null ? (
        <Banner tone="warn" title={feeWarning} testId="dca-form-fee-warning">
          Fewer, larger buys cost less.
          {vaultCheaper === null ? null : (
            <>
              {" "}
              <span data-testid="dca-form-vault-cheaper">{vaultCheaper}</span>
            </>
          )}
        </Banner>
      ) : null}
      {shortWarning !== null ? (
        <Banner
          tone="warn"
          title={vault ? "Your wallet can't cover this vault" : "Your balance won't cover every buy"}
          testId="dca-form-balance-warning"
        >
          {shortWarning}
        </Banner>
      ) : null}

      <fieldset className="spdex-choices">
        <legend>How each buy is made</legend>
        <ChoiceCard
          name="dca-signer"
          value="wallet"
          checked={signer === "wallet"}
          onChange={() => edit({ signer: "wallet" })}
          testId="dca-form-signer-wallet"
          title={SIGNER_CHOICE_TITLES.wallet}
          description="Your wallet asks when a buy is due. Keep spDEX open."
          cost={
            <span className="spdex-choice__line">
              <span className="spdex-choice__tag">Cost</span> {walletCostText(sell, walletFee)}
            </span>
          }
        />
        <ChoiceCard
          name="dca-signer"
          value="vault"
          checked={vault}
          onChange={chooseVault}
          disabled={vaultRefused}
          testId="dca-form-signer-vault"
          // Not "buys automatically": a vault buys only when someone triggers
          // a due buy, and nobody is obliged to.
          title={SIGNER_CHOICE_TITLES.vault}
          description={
            vaultSupport.kind === "unsupported" ? (
              vaultSupport.reason
            ) : vaultSupport.kind === "unavailable" ? (
              "Not available right now — see why below."
            ) : (
              <>
                <UnauditedBadge testId="dca-form-vault-badge" /> A <Term tip={VAULT_TIPS.vault}>vault</Term> you own
                holds the budget — no tab needed. Anyone can make its due buys, SPX holders first; nobody has to. Only closing it
                stops it.{" "}
                <Term tip={howVaultsWork(allowance)}>How vaults work</Term>
              </>
            )
          }
          cost={
            <>
              <span className="spdex-choice__line">
                <span className="spdex-choice__tag">Cost</span> {vaultCostText(vaultCosts, autoBuy.fees, money)}
                <InfoTerm tip={VAULT_TIPS.fee} label="About the buy fee" />
              </span>
              <span className="spdex-choice__line">
                <span className="spdex-choice__tag">Risk</span> At most {vaultCapText()} · only you can withdraw
              </span>
              {/* Said under "Pay with" once the vault is chosen (dca-form-vault-pair). */}
              {vault ? null : (
                <span className="spdex-choice__line">
                  <span className="spdex-choice__tag">Buys</span> SPX with ETH only
                </span>
              )}
            </>
          }
        />
      </fieldset>
      {!vault && locksMissing ? (
        <Banner tone="warn" title="This browser can't run a plan you confirm" testId="dca-form-no-locks">
          It can&apos;t keep two spDEX tabs from making the same buy twice. Use a current browser
          {vaultRefused ? "." : `, or “${SIGNER_CHOICE_TITLES.vault}”, a vault that needs no tab.`}
        </Banner>
      ) : null}
      {vaultSupport.kind === "unavailable" ? (
        <Banner tone="warn" title="Vaults aren't available right now" testId="dca-form-vault-refused">
          {vaultSupport.reason}
        </Banner>
      ) : null}
      {factoryNotice !== null ? (
        <NoticeBanner notice={factoryNotice} onDismiss={() => autoBuy.clearNotice(VAULT_FACTORY_ACTIVITY)} />
      ) : null}

      {vault ? (
        <div className="spdex-dca-vault" data-testid="dca-form-vault">
          <div className="spdex-dca-chips" role="group" aria-labelledby={allowanceId}>
            <span className="spdex-field__label" id={allowanceId}>
              Price allowance
            </span>
            <Toggle
              testId="dca-form-vault-slippage"
              value={String(vaultSlippage)}
              onChange={(value) => setVaultSlippage(Number(value))}
              options={SLIPPAGE_OPTIONS}
            />
            <AllowanceHint allowance={allowance} />
          </div>
          {expert && parsed.intervalSeconds !== null ? (
            <Field label="Community window" hint={COMMUNITY_WINDOW_HINT}>
              <select
                className="spdex-select"
                data-testid="dca-form-vault-window"
                value={vaultWindowValue(vaultWindow, parsed.intervalSeconds)}
                onChange={(event) => {
                  setVaultWindow(vaultWindowChoiceOf(event.target.value));
                  setError(null);
                }}
              >
                {vaultWindowOptions(parsed.intervalSeconds).map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {windowOptionLabel(option)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <VaultFactorySetup autoBuy={autoBuy} deps={deps} testId="dca-form-vault-setup" />
          {vaultProblem !== null ? (
            <Banner tone="warn" title="A vault can't take this plan" testId="dca-form-vault-problem">
              {vaultProblem}
            </Banner>
          ) : null}
          {feeNotes.map((note) =>
            note.banner === null ? (
              <p key={note.testId} className="spdex-dca-hint" data-testid={note.testId}>
                <WithKeeperTerm text={note.text} />
              </p>
            ) : (
              <Banner key={note.testId} tone={note.banner.tone} title={note.banner.title} testId={note.testId}>
                <WithKeeperTerm text={note.text} />
              </Banner>
            ),
          )}
        </div>
      ) : null}

      <p className="spdex-dca-limits" data-testid="dca-form-limits">
        {vault ? (
          <>
            A due buy waits for someone (a <Term tip={VAULT_TIPS.keeper}>keeper</Term>) to trigger it. Untriggered times
            are skipped; the plan ends later.
          </>
        ) : (
          "Buys only while spDEX is open and awake. Missed times are skipped; the plan ends later."
        )}
      </p>

      <Disclosure summary="How auto-buy works" testId="dca-form-how" group="dca-form">
        <ul className="spdex-dca-how">
          {vault ? (
            <>
              <li>Anyone can trigger a due buy, SPX holders first: a community keeper, a keeper bot, you (Trigger now), or a keeper you run.</li>
              <li>Unaudited: nobody independent has reviewed it, so at most {vaultCapText()} goes in.</li>
              <li>No pause: only closing it stops it. Switching Auto-buy off doesn&apos;t.</li>
              <li>
                Each buy pays its buy fee (never more than {bpsPercentText(Number(BUY_FEE_CEILING_BPS))}%, network cost included) to
                the keeper that makes it, or back to you when you do — maybe a keeper run by spDEX&apos;s developers, who keep
                what&apos;s left after the network fee. The pool&apos;s 0.3% fee applies too.
              </li>
              <li>Sharing your plans shares the vault&apos;s address: anyone can watch it; only your wallet can fund or close it.</li>
              <li>Auto-buys never send tips.</li>
            </>
          ) : (
            <>
              <li>Keep a spDEX tab open and awake: browsers pause background tabs, and a paused tab doesn&apos;t buy.</li>
              <li>Your wallet never opens by itself: a due buy waits on its plan until you confirm it.</li>
              <li>The Guard prices and safety-checks each buy before you sign; a buy that can&apos;t be checked isn&apos;t made.</li>
              <li>
                Each buy uses one market and your <Term tip={GLOSSARY.priceTolerance}>price tolerance</Term> (
                {effectiveSlippage}%, never over {MAX_SCHEDULED_SLIPPAGE_BPS / 100}%).
              </li>
              <li>Amounts are saved in what you pay with, not dollars; to spend fixed dollars, pay with USDC.</li>
              <li>Auto-buys never send tips.</li>
            </>
          )}
        </ul>
        {/* After how it works, not at the top of the tab, where a line
            about believing read as a call to buy. */}
        <SayingLine id="believe" />
      </Disclosure>

      {expert ? (
        <Disclosure summary="What will be saved" testId="dca-form-preview" group="dca-form">
          <pre className="spdex-code">
            {planPreview(parsed, {
              id: draftId,
              chainId: config.chainId,
              signer,
              nowSeconds: Math.floor(autoBuy.now / 1000),
            })}
          </pre>
          {vault ? (
            <p className="spdex-dca-hint">
              A vault plan's start is rewritten in the network's time when it is saved, and its vault's address is added
              once the vault exists. The allowance ({vaultSlippage} bps), the community window
              {windowSeconds === null ? "" : ` (${formatCount(windowSeconds)} s)`} and the buy fee are the vault's, not the plan's.
            </p>
          ) : null}
        </Disclosure>
      ) : null}

      {autoBuy.safety === "unavailable" || autoBuy.safety === "unknown" ? (
        <Banner
          tone="warn"
          title={autoBuy.safety === "unavailable" ? "This service can't safety-check" : "Safety check not confirmed"}
          testId="dca-form-no-safety-test"
        >
          {vault
            ? autoBuy.safety === "unavailable"
              ? "spDEX won't send vault transactions through it."
              : "Vault transactions wait until it can. Retrying every minute."
            : autoBuy.safety === "unavailable"
              ? "Every buy would be skipped."
              : "Buys are skipped until it can. Retrying every minute."}{" "}
          <GoTo place="networkService" returnTo={actionsRef}>
            Change service
          </GoTo>
        </Banner>
      ) : null}
      {error !== null ? (
        <Banner tone="danger" title="Can't start this plan" testId="dca-form-error">
          {error}
        </Banner>
      ) : null}
      {startedText !== null ? (
        <Banner tone="ok" title={vault ? "Vault plan saved" : "Auto-buy started"} testId="dca-form-started">
          {startedText}{" "}
          {started !== null ? (
            <button
              type="button"
              className="spdex-goto"
              data-testid="dca-form-started-see"
              onClick={(event) => void reveal(`dca-plan-${started.planId}`, { block: "start", returnTo: event.currentTarget })}
            >
              See it in Auto-buys
            </button>
          ) : null}
          {/* The moment someone most wants reminding. A vault needs nobody
              present, so it gets no reminder that would say otherwise. */}
          {startedPlan !== undefined && startedPlan.signer === "wallet" ? (
            <AddToCalendar
              plan={startedPlan}
              buysLeft={startedPlan.maxBuys - (startedEntry !== null && startedEntry !== "unavailable" ? startedEntry.buysDone : 0)}
              label="Add the buy times to my calendar"
              onOpenChange={setCalendarHeld}
            />
          ) : null}
        </Banner>
      ) : null}

      <div className="spdex-dca-actions" ref={actionsRef}>
        {account === null ? (
          <Button testId="dca-form-connect" onClick={deps.onConnect}>
            Connect wallet to start
          </Button>
        ) : (
          <Button testId="dca-form-start" disabled={blocked !== null || submitting} onClick={() => void onStart()}>
            {/* With "At a time I choose" and no time chosen yet there is no
                first-buy time to name, and "first buy now" beside that
                choice said the opposite of it; the click asks for the time. */}
            {submitting
              ? "Starting…"
              : parsed.startAtInvalid && signer === "wallet"
                ? "Start auto-buy"
                : startLabel(signer, parsed.startAt)}
          </Button>
        )}
      </div>
      {account !== null && blocked !== null ? (
        <p className="spdex-dca-hint" data-testid="dca-form-blocked">
          {blocked}
        </p>
      ) : null}
      {!config.dca.enabled ? <p className="spdex-dca-hint">Starting a plan turns on Auto-buy.</p> : null}
    </div>
  );
}
