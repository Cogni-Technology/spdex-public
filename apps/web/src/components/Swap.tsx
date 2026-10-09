/**
 * The Trade card: a one-time swap, or (in the Recurring tab) an auto-buy.
 *
 * Three things here are load-bearing rather than decorative:
 *
 * The safety check's verdict is rendered before the swap button and gates it.
 * A refused plan has no button at all — not a disabled one with a tooltip —
 * because the whole premise is that spDEX refuses rather than warns.
 *
 * The route is always available in full: which markets, what share, and why a
 * split was or was not taken. It now sits one click down, under a summary a
 * newcomer can read ("You pay / You get / At least"), and opens by itself in
 * Expert. A router that silently decides where your money goes is the thing
 * this project exists not to be, so the detail is folded, never removed.
 *
 * Both tabs stay mounted. The inactive one carries the `hidden` attribute, so
 * a swap in progress keeps its status when someone glances at Recurring, and
 * theme.css's `[hidden] { display: none !important }` makes sure no classed
 * block inside overrides it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Banner, Button, Disclosure, Field, Panel, Row, Term, Toggle } from "@spdex/ui";
import type { GuardVerdict, GuardViolation, SpdexConfig, TipPolicy } from "@spdex/core";
import type { DiscoveredRecipient, QuoteResult } from "../lib/engine.js";
import { guardSentence, uniqueByCode } from "../lib/errors.js";
import { secondOpinionRefusalText } from "../lib/simulation.js";
import { GLOSSARY, tokenOptionText } from "../lib/names.js";
import { GoTo } from "../lib/places.js";
import type { TilePanelProps } from "../lib/tiles.js";
import { confirmCountText, highFeeNote, marketsLabel, maxConfirmations, networkFeeText, rateLine } from "../lib/summary.js";
import { CULTURE_AMOUNT_PRESETS_USD_CENTS } from "../lib/culture/presets.js";
import { fiatOf, usdToFiat } from "../lib/money/convert.js";
import { formatAmountForField, formatFiat, formatNumber } from "../lib/money/format.js";
import { shareText } from "../lib/stats.js";
import type { AmountInput, FiatAmount, Pricing, RateSnapshot } from "../lib/money/pricing.js";
import { moneyView, useRatesNeeded } from "../lib/money/rates.js";
import { presetInput, presetsBlocked, readTime, resolveField, unitCurrency, withFrozen } from "../lib/money/resolve.js";
import { AmountField } from "./money/AmountField.js";
import { ContractLine } from "./culture/ContractBadge.js";
import { PresetChips, presetFieldText } from "./culture/PresetChips.js";
import {
  bpsText,
  recipientsTotal,
  tipConfirmations,
  tipCostText,
  tipDeliveryFor,
  tipShareOf,
  tipTransferCount,
  type TipDelivery,
} from "../lib/tipRow.js";
import { TipRow } from "./TipRow.js";
import { TxRef } from "./dca/common.js";
import {
  formatAmount,
  isNative,
  spendableBalance,
  TOKEN_LIST,
  type TokenInfo,
} from "../lib/tokens.js";

type Mode = "recommended" | "expert";

/** The network fee row's tip: where the figure comes from, and what decides the real one. */
const NETWORK_FEE_TIP =
  "An estimate at today's fees, from each market's usual gas and a typical permission where one may be asked first. Tips, if any, add theirs. Your wallet shows the real fee before you confirm.";
export type BuyMode = "once" | "recurring";

// ── The frame ─────────────────────────────────────────────────────────────

/**
 * "Buy SPX", with the One-time | Recurring switch first and no subtitle, so
 * nothing above the switch changes when it is clicked.
 *
 * Inside a tile (`open` defined, the panel contract in lib/tiles.ts) the
 * tile's header is the title, so the card drops its own panel and keeps its
 * `swap-panel` test id on a plain wrapper. Its summary is App's to compute.
 *
 * The two bodies are plain, classless divs on purpose: a classed wrapper with
 * a `display` of its own would beat the browser's `[hidden]` rule, and both
 * tabs would show.
 */
export function TradeCard({
  buyMode,
  onBuyMode,
  oneTime,
  recurring,
  open,
}: {
  buyMode: BuyMode;
  onBuyMode: (mode: BuyMode) => void;
  oneTime: ReactNode;
  recurring: ReactNode;
} & Pick<TilePanelProps, "open">) {
  const body = (
    <>
      <div className="spdex-buy-mode">
        <Toggle
          testId="buy-mode"
          value={buyMode}
          onChange={onBuyMode}
          options={[
            { value: "once", label: "One-time" },
            { value: "recurring", label: "Recurring" },
          ]}
        />
      </div>
      <div hidden={buyMode !== "once"}>{oneTime}</div>
      <div hidden={buyMode !== "recurring"}>{recurring}</div>
    </>
  );
  if (open !== undefined) return <div data-testid="swap-panel">{body}</div>;
  return (
    <Panel title="Buy SPX" testId="swap-panel">
      {body}
    </Panel>
  );
}

// ── The safety check ──────────────────────────────────────────────────────

/**
 * The verdict level, as a small tag after the banner's title.
 *
 * The span holds exactly the lowercase word the tests compare with
 * `toHaveText`; any brackets or capitals are the stylesheet's
 * (`.spdex-guard-level`), never characters in here.
 */
function LevelTag({ level }: { level: string }) {
  return (
    <span className="spdex-guard-level" data-testid="guard-level">
      {level}
    </span>
  );
}

/**
 * One line per distinct code: the plain sentence, then the code itself.
 *
 * Deduplicated because a split route reports the same violation once per leg,
 * which said nothing new and gave two elements the same test id. Expert adds
 * the Guard's own message, which is exact and technical.
 */
function CodeList({
  items,
  kind,
  mode,
  said = null,
}: {
  items: readonly GuardViolation[];
  kind: "violation" | "warning";
  mode: Mode;
  /**
   * A code whose sentence the banner's own paragraph already says. Its line
   * keeps the code, which is the fact, but not the sentence, which would
   * say the same thing twice in a row.
   */
  said?: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="spdex-codes" {...(kind === "warning" ? { "data-testid": "guard-warnings" } : {})}>
      {uniqueByCode(items).map((item) => (
        <li key={item.code} data-testid={`${kind}-${item.code}`}>
          {/* As a refusal (only under "refuse anything unsimulated"), the
              second opinion's silence isn't "checked on one service". */}
          {item.code === said
            ? null
            : kind === "violation" && item.code === "SECOND_OPINION_UNAVAILABLE"
              ? secondOpinionRefusalText("strict")
              : guardSentence(item.code, item.detail)}{" "}
          <code className="spdex-code-tag">{item.code}</code>
          {mode === "expert" ? <span className="spdex-codes__message"> — {item.message}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the verified banner says follows the swap: the tips, and how they go
 * out. A batch names the signature it rests on, and the standing permission
 * for Permit2 when it will be (or may be) asked for, in the order the wallet
 * asks, since the sentence before it promises that the swap grants nothing
 * undeclared, and the tips are not the swap.
 */
export function tipsAfterText(tips: string, delivery: TipDelivery | null, symbol: string): string {
  if (delivery === null || delivery.kind === "none") return `Then ${tips} in tips goes out from what arrives.`;
  if (delivery.kind === "transfers") {
    return delivery.count === 1
      ? `Then ${tips} in tips goes out from what arrives, in a transaction of its own.`
      : `Then ${tips} in tips goes out from what arrives, one transaction per person.`;
  }
  const before =
    delivery.permission === "given"
      ? "after a signature"
      : delivery.permission === "needed"
        ? `after a signature and a standing permission for Permit2 on ${symbol}`
        : `after a signature and, if it isn't given yet, a standing permission for Permit2 on ${symbol}`;
  return `Then ${tips} in tips goes out from what arrives, in one transaction through Permit2, ${before}.`;
}

/**
 * Why a swap is "Not checked", from its SIMULATION_UNAVAILABLE warning:
 *
 * - `uncompared`: the main service failed before its test-run could be
 *   compared with the second opinion's on one block (the Guard's
 *   `detail.failure`). It may well have run the test and passed; only the
 *   comparison is missing, often for a moment.
 * - `missing`: the service said it can't test-run at all (the availability
 *   probe, `detail.provider`): it lacks eth_simulateV1.
 * - `failed`: the test-run failed as it ran, for a reason the Guard's message
 *   gives.
 */
export function notCheckedCause(warnings: readonly GuardViolation[]): "uncompared" | "missing" | "failed" {
  const unavailable = warnings.filter((w) => w.code === "SIMULATION_UNAVAILABLE");
  if (unavailable.some((w) => w.detail?.["failure"] !== undefined)) return "uncompared";
  if (unavailable.some((w) => w.detail?.["provider"] !== undefined)) return "missing";
  return "failed";
}

/**
 * The "Not checked" banner's words, by `notCheckedCause`. Where the cure is
 * another network service, the banner ends with the way there
 * (`GoTo networkService`), which these words lead into.
 */
export function notCheckedText(cause: ReturnType<typeof notCheckedCause>, mode: Mode): string {
  if (cause === "uncompared") {
    return (
      "Your main service failed before its test-run could be compared with your second opinion's. You can still " +
      "swap, or press Refresh price to ask both again."
    );
  }
  return (
    "Your network service can't run the safety test. You can still swap: past your price tolerance, it cancels itself." +
    (mode === "expert" && cause === "missing" ? " (The service lacks eth_simulateV1.)" : "")
  );
}

/**
 * The "Checked on one service" banner's words, two sentences: tested on the
 * main service only, because the second opinion (named by its host, when
 * known) didn't answer; and the way to ask both again. What the main
 * service's run says is `ONE_SERVICE_CHECKED`, under "What was checked".
 */
export function oneServiceText(host: string): string {
  const who = host === "" ? "your second opinion" : `your second opinion, ${host},`;
  return `Tested on your main service only: ${who} didn't answer. Swap, or press Refresh price to ask both again.`;
}

/**
 * Whether `GuardBanner` tells the person to press Refresh price: the second
 * opinion's answer is missing from this price (`oneServiceText`, the
 * `uncompared` "Not checked", or the refusal under "refuse anything
 * unsimulated"). The button stays on offer then, even while the price is
 * kept current on its own.
 */
export function saysRefreshPrice(verdict: GuardVerdict): boolean {
  if (verdict.level === "rejected") return verdict.violations.some((v) => v.code === "SECOND_OPINION_UNAVAILABLE");
  if (verdict.level !== "unverified") return false;
  if (!verdict.warnings.some((w) => w.code === "SIMULATION_UNAVAILABLE")) {
    return verdict.warnings.some((w) => w.code === "SECOND_OPINION_UNAVAILABLE");
  }
  return notCheckedCause(verdict.warnings) === "uncompared";
}

/** What the main service's test-run says, when it is the only one that answered. */
export const ONE_SERVICE_CHECKED =
  "Your main service's test-run says nothing else leaves your wallet and you get at least the amount shown.";

export function GuardBanner({
  verdict,
  previewOnly,
  mode,
  tips = null,
  delivery = null,
  symbol = "",
  atLeast = null,
  parts = 1,
}: {
  verdict: GuardVerdict;
  previewOnly: boolean;
  mode: Mode;
  /**
   * The tips this swap will send afterwards ("~3.15 SPX"), or null. They go
   * out after it, from what arrives, so "nothing else leaves your wallet" is
   * about the swap, and the banner says what follows it.
   */
  tips?: string | null;
  /**
   * How they go out, so the banner can say it, and name the standing
   * permission for Permit2 when a batch will ask for it: "no permission is
   * granted that wasn't declared" is about the swap alone.
   */
  delivery?: TipDelivery | null;
  /** The token the tips are sent in, for naming that permission. */
  symbol?: string;
  /** The least this swap delivers ("52.738145 SPX"), for the verified line; "the amount shown" without it. */
  atLeast?: string | null;
  /** How many separate transactions the route is: two or more says each part has its own minimum. */
  parts?: number;
}) {
  // Quoting before connecting is normal — people look at prices first — and
  // the price is real. Only the proof is missing, so this says that rather
  // than implying something was wrong. No glossary term here: a tip is DOM
  // text, and nothing in this banner may ever read "Refused".
  if (previewOnly) {
    return (
      <Banner
        tone="warn"
        title={
          <>
            <span>Price preview</span> <LevelTag level="preview" />
          </>
        }
        testId="guard-banner"
      >
        The price is real. Connect a wallet and spDEX test-runs the swap before you sign.
      </Banner>
    );
  }

  if (verdict.level === "rejected") {
    return (
      <Banner
        tone="danger"
        title={
          <>
            <span>
              Blocked by the <Term tip={GLOSSARY.safetyCheck}>safety check</Term>
            </span>{" "}
            <LevelTag level="rejected" />
          </>
        }
        testId="guard-banner"
      >
        spDEX won&apos;t let you send this:
        <CodeList items={verdict.violations} kind="violation" mode={mode} />
      </Banner>
    );
  }

  // The second opinion didn't answer, and the main service's own test-run
  // passed: checked, on one service. Only the second service's own failure
  // gets here (packages/guard/src/second-opinion.ts); a service that can't
  // test-run at all is the branch below.
  const oneService = verdict.warnings.find((w) => w.code === "SECOND_OPINION_UNAVAILABLE");
  if (verdict.level === "unverified" && oneService !== undefined && !verdict.warnings.some((w) => w.code === "SIMULATION_UNAVAILABLE")) {
    const host = oneService.detail?.["host"]?.trim() ?? "";
    return (
      <Banner
        tone="warn"
        title={
          <>
            <span>Checked on one service</span> <LevelTag level="unverified" />
          </>
        }
        testId="guard-banner"
      >
        {oneServiceText(host)}
        <Disclosure testId="guard-checked" summary="What was checked">
          <p className="spdex-banner__text">
            {ONE_SERVICE_CHECKED}
            {tips !== null ? ` ${tipsAfterText(tips, delivery, symbol)}` : null}
          </p>
        </Disclosure>
        <CodeList items={verdict.warnings} kind="warning" mode={mode} said="SECOND_OPINION_UNAVAILABLE" />
      </Banner>
    );
  }

  if (verdict.level === "unverified") {
    const cause = notCheckedCause(verdict.warnings);
    return (
      <Banner
        tone="warn"
        title={
          <>
            <span>
              Not <Term tip={GLOSSARY.safetyCheck}>checked</Term>
            </span>{" "}
            <LevelTag level="unverified" />
          </>
        }
        testId="guard-banner"
      >
        {notCheckedText(cause, mode)}
        {cause === "uncompared" ? null : (
          <>
            {" "}
            <GoTo place="networkService">Change service</GoTo>
          </>
        )}
        <CodeList items={verdict.warnings} kind="warning" mode={mode} said="SIMULATION_UNAVAILABLE" />
      </Banner>
    );
  }

  return (
    <Banner
      tone="ok"
      title={
        <>
          <Term tip={GLOSSARY.safetyCheck}>Checked</Term> <LevelTag level="verified" />
        </>
      }
      testId="guard-banner"
    >
      {parts < 2 ? (
        <>
          Test-ran on the live network. You get at least {atLeast ?? "the amount shown"}, or it cancels and only the{" "}
          <Term tip={GLOSSARY.networkFee}>network fee</Term> is spent.
        </>
      ) : (
        "Test-ran on the live network. Each part gets at least its minimum, or that part cancels. A later part can " +
        "fail after an earlier one went through."
      )}
      <Disclosure testId="guard-checked" summary="What was checked">
        <p className="spdex-banner__text">
          spDEX ran {parts < 2 ? "this exact transaction" : "each of these exact transactions"} against the live network
          first. Nothing else leaves your wallet, no permission is granted that wasn&apos;t declared, and past your
          price tolerance {parts < 2 ? "it cancels itself" : "a part cancels itself"}.
          {tips !== null ? ` ${tipsAfterText(tips, delivery, symbol)}` : null}
        </p>
      </Disclosure>
      <CodeList items={verdict.warnings} kind="warning" mode={mode} />
    </Banner>
  );
}

// ── A slow send ───────────────────────────────────────────────────────────

/** A transaction sent and not yet in a block, as the page follows it. */
export interface PendingSend {
  /** The one being waited for: a wallet's faster copy replaces the original (lib/wallet.ts). */
  hash: string;
  /** When it was sent, milliseconds by this device's clock. */
  since: number;
  via: "wallet" | "private";
  /** Whether its highest bid is below the base fee now; null until read, or when the service can't say. */
  underpriced: boolean | null;
}

/** How long a send waits before the page says so: a little more than a block's 12 seconds. */
export const SLOW_SEND_MS = 15_000;

/**
 * "Still waiting for a block: 24 s", with the transaction, and what can be
 * done about it, once a send has waited `SLOW_SEND_MS`. Not a live region:
 * the status line above already says it is waiting, and a counter read out
 * every second would drown it.
 */
function SlowSend({ pending, chainId }: { pending: PendingSend; chainId: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const waited = now - pending.since;
  if (waited < SLOW_SEND_MS) return null;
  const hint =
    pending.via === "private"
      ? "Sent privately: the relay offers it to each new block until one includes it."
      : pending.underpriced === true
        ? "Fees rose past what it bids. Speed it up in your wallet, or wait."
        : "Speeding it up in your wallet is safe: spDEX follows the faster copy.";
  return (
    <div className="spdex-slow-send" data-testid="swap-slow">
      <p className="spdex-dca-line spdex-dca-line--warn">
        Still waiting for a block: {Math.floor(waited / 1_000)} s. <TxRef chainId={chainId} hash={pending.hash} testId="swap-slow-tx" />
      </p>
      <p className="spdex-field__hint" data-testid="swap-slow-hint">
        {hint}
      </p>
    </div>
  );
}

// ── The route ─────────────────────────────────────────────────────────────

/**
 * What a multi-part route actually costs you.
 *
 * Each part is a separate transaction, because spDEX has no swap contract of
 * its own — its one contract is the auto-buy vault, which only makes that
 * vault's buys — and so has nowhere to batch them atomically. The per-part minimums
 * still hold — no part that executes can pay less than its floor — but a
 * later part can fail after an earlier one went through, which a newcomer
 * would never guess. Kept outside the route disclosure for that reason.
 */
export function SplitExecutionNotice({
  legs,
  mode,
  said = false,
}: {
  legs: number;
  mode: Mode;
  /** The verified banner under it already says a later part can fail; said once is enough. */
  said?: boolean;
}) {
  if (legs < 2) return null;
  return (
    <Banner tone="warn" title={`This swap is ${legs} separate transactions`} testId="split-notice">
      Split across {legs} markets for a better price.
      {said ? null : " A later part can fail after an earlier one went through."}
      {mode === "expert" ? " Set Maximum parts to 1 to always use one market." : null}
    </Banner>
  );
}

/**
 * How many tip transfers this swap will make: none when it pays out native
 * ether, which a tip (an ERC-20 transfer of what arrived) cannot send yet.
 */
function tipTransfersFor(config: SpdexConfig, tokenOut: TokenInfo): number {
  return isNative(tokenOut) ? 0 : tipTransferCount(config.tips);
}

/**
 * The tips a swap will send, estimated: "~3.146611 SPX", or null with none.
 *
 * From the expected output, because that is all that is known before the
 * swap runs. Execution recomputes from the delivered balance, so what is
 * actually sent can only be smaller than this if the swap underdelivers.
 */
export function tipEstimate(config: SpdexConfig, quote: QuoteResult, tokenOut: TokenInfo): string | null {
  if (tipTransfersFor(config, tokenOut) === 0) return null;
  const estimated = tipShareOf(quote.route.amountOut, recipientsTotal(config.tips.recipients));
  return `~${formatAmount(estimated, tokenOut.decimals)} ${tokenOut.symbol}`;
}

/**
 * The tip, as a line of the summary card, stated before signing rather than
 * after.
 *
 * A standing instruction to send a share of every swap is the kind of setting
 * people switch on once and forget. Restating it on the transaction it applies
 * to — with the amount, not just the percentage — is the difference between a
 * feature somebody chose and one that merely happened to them. Who gets it is
 * on the Tip row above; per-person shares are in Expert.
 */
export function TipSummaryRow({
  config,
  quote,
  tokenOut,
}: {
  config: SpdexConfig;
  quote: QuoteResult;
  tokenOut: TokenInfo;
}) {
  const people = tipTransfersFor(config, tokenOut);
  if (people === 0) return null;
  const bps = recipientsTotal(config.tips.recipients);

  const tip = tipShareOf(quote.route.amountOut, bps);
  const kept = quote.route.amountOut > tip ? quote.route.amountOut - tip : 0n;
  // "You get" is what the swap delivers; the tip leaves afterwards. With a
  // tip on, what stays in the wallet is its own row, so nobody reads the
  // swap's figure as theirs to keep.
  return (
    <>
      <div className="spdex-row" data-testid="tip-preview">
        <span className="spdex-row__label">Tip</span>
        <span className="spdex-row__value" data-testid="tip-preview-total">
          ≈ {formatAmount(tip, tokenOut.decimals)} {tokenOut.symbol}
          <span className="spdex-summary__aside">
            {" "}
            ({bpsText(bps)} to {people === 1 ? "1 person" : `${people} people`}, after the swap)
          </span>
        </span>
      </div>
      <div className="spdex-row" data-testid="tip-kept">
        <span className="spdex-row__label">You keep</span>
        <span className="spdex-row__value">
          ≈ {formatAmount(kept, tokenOut.decimals)} {tokenOut.symbol}
        </span>
      </div>
    </>
  );
}

/**
 * The You pay row. Token first, always: it is what is signed. An amount typed
 * in money names the money and when its price was read, and is never echoed
 * back through that same price as if that confirmed anything: "0.0081589 ETH
 * ($20.00 at 14:02)". When the money typed isn't the chosen currency, its
 * worth in that currency follows ("($20.00 at 14:02, ≈ €18.40)"). A token
 * amount keeps its "≈" figure.
 */
function youPay(
  amountIn: bigint,
  tokenIn: TokenInfo,
  typed: { typed: FiatAmount; at: RateSnapshot } | null,
  money: ReturnType<typeof moneyView>,
  pricing: Pricing | null,
): ReactNode {
  const amount = `${formatAmount(amountIn, tokenIn.decimals, { maxFraction: tokenIn.decimals })} ${tokenIn.symbol}`;
  if (typed !== null && pricing !== null) {
    const chosen = pricing.currency;
    const inChosen =
      typed.typed.currency === chosen || typed.typed.currency !== "USD" ? null : usdToFiat(typed.typed.minor6, typed.at.fx, chosen);
    return (
      <>
        {amount}{" "}
        <span className="spdex-summary__aside">
          ({formatFiat(typed.typed, pricing.locale)} at {readTime(typed.at)}
          {inChosen === null ? null : `, ${formatFiat(inChosen, pricing.locale, { approx: true })}`})
        </span>
      </>
    );
  }
  const worth = money === undefined ? null : fiatOf(amountIn, tokenIn.address, money);
  return (
    <>
      {formatAmount(amountIn, tokenIn.decimals)} {tokenIn.symbol}
      {worth === null ? null : (
        <span className="spdex-summary__aside"> {formatFiat(worth.value, money!.locale, { approx: true })}</span>
      )}
    </>
  );
}

/**
 * Whether a quote passed the safety check with nothing to say: verified, with
 * no warning. Only then does its banner fold under Advanced; every refusal,
 * warning or unchecked swap stays in view (UI rule R6).
 */
export function cleanPass(quote: QuoteResult): boolean {
  return !quote.previewOnly && quote.verdict.level === "verified" && quote.verdict.warnings.length === 0;
}

/** The ether side of a swap, for the fee's share of it: what goes in or comes out as ETH or WETH; null for neither. */
function etherSide(route: QuoteResult["route"], tokenIn: TokenInfo, tokenOut: TokenInfo): bigint | null {
  if (isNative(tokenIn) || tokenIn.symbol === "WETH") return route.amountIn;
  if (isNative(tokenOut) || tokenOut.symbol === "WETH") return route.amountOut;
  return null;
}

/**
 * The summary card: what is paid and got, the network fee (and a line when
 * it is high), and, for a split route, what that means.
 */
export function RouteView({
  quote,
  tokenIn,
  tokenOut,
  config,
  mode,
  delivery,
  pricing,
  typed = null,
  networkFee = null,
  feeLevel = null,
}: {
  quote: QuoteResult;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  config: SpdexConfig;
  mode: Mode;
  /** How the tips will go out; the Tip row states the same. */
  delivery: TipDelivery;
  /** The page's rates and currency, for "≈" figures; none without it. */
  pricing: Pricing | null;
  /** The money this quote's amount was typed in, and the price it was sized with; null when it was typed in the token. */
  typed?: { typed: FiatAmount; at: RateSnapshot } | null;
  /** What the swap's transactions come to in network fees at today's fees; null until read. */
  networkFee?: { wei: bigint; upTo: boolean } | null;
  /** The base fee now and its usual over the last few hours (`readFeeLevel`); null until read or unreadable. */
  feeLevel?: { base: bigint; usual: bigint } | null;
}) {
  const { route } = quote;
  const tick = useRatesNeeded(pricing, true);
  const money = moneyView(pricing, tick);
  // The same figures the Tip row states: transfers add to the count; a batch
  // gets a row of its own, in words and in the order the wallet asks, since
  // a signature is not a transaction.
  const confirmations = maxConfirmations(quote.legs, delivery.kind === "batch" ? 0 : tipConfirmations(delivery));
  const feeNote =
    networkFee === null ? null : highFeeNote({ feeWei: networkFee.wei, swapWei: etherSide(route, tokenIn, tokenOut), level: feeLevel });

  return (
    <div data-testid="route-view">
      <div className="spdex-summary">
        <Row label="You pay" value={youPay(route.amountIn, tokenIn, typed, money, pricing)} testId="you-pay" />
        <Row
          label="You get"
          value={`≈ ${formatAmount(route.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`}
          testId="amount-out"
        />
        {/* What sending it costs, said before Swap as the Recurring tab says it
            (UI rule R6): an estimate, since the wallet sets the real figure. */}
        {networkFee === null ? null : (
          <Row
            label={<Term tip={NETWORK_FEE_TIP}>Network fee</Term>}
            value={networkFeeText(networkFee, money)}
            testId="network-fee"
          />
        )}
        <TipSummaryRow config={config} quote={quote} tokenOut={tokenOut} />
        {/* Once is what anyone expects of a swap; Simple says the count only when it is more. */}
        {mode === "expert" || confirmations > 1 ? <Row label="Your wallet" value={confirmCountText(confirmations)} testId="confirm-count" /> : null}
        {delivery.kind === "batch" ? (
          <Row label="Then, for tips" value={tipCostText(delivery)} testId="confirm-count-tips" />
        ) : null}
      </div>

      {/* Advice, not a refusal: Swap stays, and the figure above says why. */}
      {feeNote === null ? null : (
        <p className="spdex-fee-high" data-testid="network-fee-high" role="note">
          {feeNote}
        </p>
      )}

      {/* The verified banner says a later part can fail only while it is in
          view; folded under Advanced, this says it (UI rule R6). */}
      <SplitExecutionNotice
        legs={route.legs.length}
        mode={mode}
        said={!quote.previewOnly && quote.verdict.level === "verified" && !cleanPass(quote)}
      />
    </div>
  );
}

/**
 * The least the swap delivers, after the price tolerance, and the rate it
 * works out to ("1 ETH = 5,231.91 SPX"), under Advanced.
 */
function QuoteLimits({ quote, tokenIn, tokenOut, config }: { quote: QuoteResult; tokenIn: TokenInfo; tokenOut: TokenInfo; config: SpdexConfig }) {
  const rate = rateLine(tokenIn, tokenOut, quote.route.amountIn, quote.route.amountOut);
  const tolerance = formatNumber(config.slippageBps / 100, { maximumFractionDigits: 2 });
  return (
    <div className="spdex-summary" data-testid="quote-limits">
      <Row
        label="At least"
        value={
          <>
            {formatAmount(quote.minAmountOut, tokenOut.decimals)} {tokenOut.symbol}
            <span className="spdex-summary__aside">
              {" "}
              (<Term tip={GLOSSARY.priceTolerance}>price tolerance</Term> {tolerance}%)
            </span>
          </>
        }
        testId="min-out"
      />
      {rate === null ? null : <Row label="Rate" value={rate} />}
    </div>
  );
}

/**
 * How the trade is routed, under Advanced. `route-legs` is always rendered,
 * folded or not, and its direct children are only the `route-leg-*` divs:
 * expert.spec counts them and reads the first one's id in Simple, folded.
 */
export function RouteDetails({ quote, tokenOut }: { quote: QuoteResult; tokenOut: TokenInfo }) {
  const { route } = quote;
  const single = route.rationale.bestSingle;
  return (
    <section className="spdex-route" data-testid="route-details">
      <p className="spdex-route__title">Route · {marketsLabel(route.legs.length)}</p>
      {/* Direct children: route-leg-* divs only (expert.spec reads them). */}
      <div data-testid="route-legs">
        {route.legs.map((leg) => (
          <div className="spdex-leg" key={leg.poolId} data-testid={`route-leg-${leg.poolId}`}>
            <span className="spdex-leg__share">{shareText(leg.shareBps)}</span>
            <span>{leg.label ?? leg.poolId}</span>
            <span className="spdex-num">{formatAmount(leg.amountOut, tokenOut.decimals)}</span>
          </div>
        ))}
      </div>

      <div className="spdex-route__rows">
        <Row
          label={<Term tip={GLOSSARY.part}>Parts</Term>}
          value={String(route.legs.length)}
          testId="leg-count"
        />
        <Row
          label={
            <>
              <Term tip={GLOSSARY.market}>Markets</Term> checked
            </>
          }
          value={String(route.rationale.consideredPools)}
        />
        {single ? (
          <Row
            label="If sent to one market only"
            value={`${formatAmount(single.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`}
            testId="best-single"
          />
        ) : null}
      </div>

      {route.rationale.rejectedSplit ? (
        <p className="spdex-field__hint" data-testid="split-rejected">
          A {route.rationale.rejectedSplit.legs}-part split was considered and not used: it would have
          gained {route.rationale.rejectedSplit.gainBps} bps (
          {formatNumber(route.rationale.rejectedSplit.gainBps / 100, { maximumFractionDigits: 2 })}%)
          against a {route.rationale.rejectedSplit.requiredBps} bps threshold, so the extra network fees
          weren&apos;t worth it.
        </p>
      ) : null}

      {quote.gasPricingNote ? (
        <p className="spdex-field__hint" data-testid="gas-note">
          {quote.gasPricingNote}
        </p>
      ) : null}
    </section>
  );
}

/**
 * "Balance 1.2 ETH · Max ⓘ", on the amount's label row.
 *
 * Read from the chain, not from the wallet's display. A wallet that has not
 * been told about a token shows nothing, which looks exactly like having no
 * balance. No digit or mark may be added inside balance-in beyond the balance
 * itself: native.spec strips every other character and parses what is left.
 * Connected but unread (an endpoint that failed, a token with no code on
 * this chain) is unknown, never zero; with no wallet there is nothing to say,
 * and Connect wallet is right below.
 *
 * Max hands over the spendable amount, which for ether is short of the full
 * balance, so there is still something to pay for the swap with: the ⓘ says
 * so. The caller writes it into its field in the field's own format.
 */
function BalanceLine({
  account,
  balance,
  token,
  onUseAll,
}: {
  account: `0x${string}` | null;
  balance: bigint | null;
  token: TokenInfo;
  onUseAll: (spendable: bigint) => void;
}) {
  if (balance === null) return account ? <>Balance unknown</> : null;
  const spendable = spendableBalance(balance, token);
  return (
    <span data-testid="balance-in">
      Balance {formatAmount(balance, token.decimals)} {token.symbol}
      {spendable > 0n ? (
        <>
          {" · "}
          <button type="button" className="spdex-max" data-testid="use-max" onClick={() => onUseAll(spendable)}>
            Max
          </button>
          {isNative(token) ? (
            <>
              {" "}
              {/* A screen reader says "About Max", not the glyph's name. */}
              <Term tip="Max keeps a little ETH back to pay the network fee.">
                <span aria-hidden="true">ⓘ</span>
                <span className="spdex-visually-hidden">About Max</span>
              </Term>
            </>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

// ── The One-time tab ──────────────────────────────────────────────────────

export function OneTimeSwap({
  config,
  mode,
  tokenIn,
  tokenOut,
  amountInput,
  onAmountInput,
  pricing,
  quote,
  quoteId,
  quoting,
  keptCurrent = false,
  swapping,
  status,
  quoteProblem = null,
  networkFee = null,
  feeLevel = null,
  pendingSend = null,
  afterSwap,
  account,
  balanceIn,
  balanceOut,
  autoBuyHoldsWallet,
  tipCandidates,
  tipsToPay,
  tipPermit2,
  onTokenIn,
  onTokenOut,
  onReverse,
  onQuote,
  onSwap,
  onConnect,
  onConfig,
}: {
  config: SpdexConfig;
  mode: Mode;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  /**
   * The amount field, in money or the token (lib/money): it says the token
   * amount a money amount comes to, and offers one-tap dollar amounts. The
   * token amount is what is quoted and signed.
   */
  amountInput: AmountInput;
  onAmountInput: (next: AmountInput) => void;
  /** The page's rates and currency. */
  pricing: Pricing;
  quote: QuoteResult | null;
  quoteId: number;
  quoting: boolean;
  /**
   * The price on screen is being asked again on its own (lib/quoteRefresh.ts),
   * so Refresh price would only ask early: it waits until that stops.
   */
  keptCurrent?: boolean;
  swapping: boolean;
  status: string | null;
  /**
   * Why the last Get price failed, in one short line (`quoteProblemLine`),
   * shown under the button in the status line; null when it didn't, or once
   * the amount or pair changed. The banner at the top of the page says the
   * rest, and on a phone it is a screen or more away from the button.
   */
  quoteProblem?: string | null;
  /** The swap's network fee at today's fees (`swapNetworkFee`), for the summary; null until fees are read. */
  networkFee?: { wei: bigint; upTo: boolean } | null;
  /** The base fee now and its usual over the last few hours, for the line that says fees are high. */
  feeLevel?: { base: bigint; usual: bigint } | null;
  /** The transaction a swap is waiting on, for the line that appears when it is slow; null when none is. */
  pendingSend?: PendingSend | null;
  /**
   * What a finished swap settled to (App's after-swap block: how final it is,
   * what arrived, a card), shown under "Swap complete" while that stays up.
   */
  afterSwap?: ReactNode;
  account: `0x${string}` | null;
  /** Null until a wallet is connected, or when the chain couldn't be read. */
  balanceIn: bigint | null;
  balanceOut: bigint | null;
  /** A wallet-mode auto-buy is being confirmed: the wallet is busy, so Swap waits. */
  autoBuyHoldsWallet: boolean;
  /** Who the tip registry names, for the Tip row's picker; null while it is asked. */
  tipCandidates: readonly DiscoveredRecipient[] | null;
  /**
   * Who this swap actually tips: `tippableRecipients`' answer as a policy
   * (lib/tiplist/checks.ts). Every figure and count about the tips reads
   * this, never `config.tips`, so a skipped share is never counted.
   */
  tipsToPay: TipPolicy;
  /**
   * What decides how two or more tips go out: whether Permit2 here is the one
   * spDEX knows (null until known), and its allowance on the token received
   * (null while there is no wallet, or it couldn't be read).
   */
  tipPermit2: { available: boolean | null; allowance: bigint | null; batchable: boolean };
  onTokenIn: (symbol: string) => void;
  onTokenOut: (symbol: string) => void;
  onReverse: () => void;
  onQuote: () => void;
  onSwap: () => void;
  onConnect: () => void;
  /** The Tip row writes the config, as the Features switch and Expert do. */
  onConfig: (next: SpdexConfig) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  // A money amount that is waiting on a price (still reading, or older than
  // five minutes) can't be quoted: Get price waits, and the field says why.
  const waitsOnRates =
    unitCurrency(amountInput.unit) !== null &&
    amountInput.text.trim() !== "" &&
    resolveField(amountInput, tokenIn, pricing, performance.now()).ratesProblem;
  // The money the shown quote was sized from, when it was: the You pay row names it.
  const quotedFrom =
    quote !== null && unitCurrency(amountInput.unit) !== null && amountInput.frozen?.raw === quote.route.amountIn
      ? { typed: amountInput.frozen.typed, at: amountInput.frozen.at }
      : null;
  const busy = quoting || swapping;
  // Refresh price once the price stops being kept current, or while the
  // banner says to press it.
  const offersQuote = !keptCurrent || (quote !== null && saysRefreshPrice(quote.verdict));
  // The button goes as the price it asked for lands, and focus on it would
  // fall to the page: it goes to the price instead, never to Swap (UI rule
  // R2, docs/ARCHITECTURE.md).
  const quoteRef = useRef<HTMLDivElement>(null);
  const offered = useRef(offersQuote);
  useLayoutEffect(() => {
    const was = offered.current;
    offered.current = offersQuote;
    if (!was || offersQuote) return;
    const at = document.activeElement;
    if (at === null || at === document.body) quoteRef.current?.focus({ preventScroll: true });
  }, [offersQuote]);
  const hasWeth = tokenIn.symbol === "WETH" || tokenOut.symbol === "WETH";
  const hasSpx = tokenIn.symbol === "SPX" || tokenOut.symbol === "SPX";
  const complete = status !== null && status.startsWith("Swap complete");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const statusView = status ? (
    complete ? (
      <Banner tone="ok" title="Done">
        <p className="spdex-status" data-testid="swap-status">
          {status}
        </p>
        {afterSwap}
      </Banner>
    ) : (
      <p className="spdex-status" data-testid="swap-status" aria-live="polite" ref={statusRef}>
        {status}
      </p>
    )
  ) : quoteProblem ? (
    <p className="spdex-status" data-testid="swap-status" data-problem="quote" aria-live="polite" ref={statusRef}>
      {quoteProblem}
    </p>
  ) : null;
  // While a quote is on screen, what the wallet is being asked goes under the
  // Swap button that started it. Above the quote, on a phone it sat a screen
  // or more away from the button, so each prompt's explanation (the Permit2
  // permission's above all) was never on screen while the wallet asked.
  const statusBesideSwap = quote !== null && !complete;
  // And it is brought into view as it changes, since the button can sit at
  // the bottom edge when it is tapped. "nearest" moves nothing when it is
  // already visible.
  useEffect(() => {
    if (statusBesideSwap && status) statusRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [status, statusBesideSwap]);
  // A failed Get price, likewise: the banner it adds at the top of the page
  // pushes the button down, off the bottom of a phone's screen.
  useEffect(() => {
    if (quoteProblem) statusRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [quoteProblem]);
  // The config as far as the tips go: only who is actually tipped.
  const paying: SpdexConfig = { ...config, tips: tipsToPay };
  const delivery = tipDeliveryFor(tipsToPay, {
    native: isNative(tokenOut),
    permit2: tipPermit2.available,
    allowance: tipPermit2.allowance,
    amountOut: quote ? quote.route.amountOut : null,
    batchable: tipPermit2.batchable,
  });

  // One banner, placed by `cleanPass`: in view, or under Advanced.
  const guardBanner =
    quote === null ? null : (
      <GuardBanner
        verdict={quote.verdict}
        previewOnly={quote.previewOnly}
        mode={mode}
        tips={tipEstimate(paying, quote, tokenOut)}
        delivery={delivery}
        symbol={tokenOut.symbol}
        atLeast={`${formatAmount(quote.minAmountOut, tokenOut.decimals)} ${tokenOut.symbol}`}
        parts={quote.route.legs.length}
      />
    );
  return (
    <>
      <div className="spdex-pair">
        <Field label="From">
          <select
            className="spdex-select"
            data-testid="token-in"
            value={tokenIn.symbol}
            onChange={(event) => onTokenIn(event.target.value)}
          >
            {TOKEN_LIST.map((token) => (
              <option key={token.symbol} value={token.symbol}>
                {tokenOptionText(token.symbol)}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="spdex-button spdex-button--ghost spdex-pair__reverse"
          data-testid="swap-reverse"
          aria-label="Swap From and To"
          title="Swap From and To"
          disabled={swapping}
          onClick={onReverse}
        >
          ⇅
        </button>
        <Field label="To">
          <select
            className="spdex-select"
            data-testid="token-out"
            value={tokenOut.symbol}
            onChange={(event) => onTokenOut(event.target.value)}
          >
            {TOKEN_LIST.map((token) => (
              <option key={token.symbol} value={token.symbol}>
                {tokenOptionText(token.symbol)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {/* One hint line under the pair: which contract is SPX, what WETH is,
          and, under To, how much of it the wallet holds. */}
      {hasSpx || hasWeth || balanceOut !== null ? (
        <div className="spdex-trade-hints">
          {hasSpx ? <ContractLine /> : null}
          {hasWeth ? (
            <span className="spdex-field__hint">
              <Term tip={GLOSSARY.weth}>What&apos;s WETH?</Term>
            </span>
          ) : null}
          {balanceOut !== null ? (
            <span className="spdex-field__hint spdex-trade-hints__held" data-testid="balance-out">
              You hold {formatAmount(balanceOut, tokenOut.decimals)} {tokenOut.symbol}
            </span>
          ) : null}
        </div>
      ) : null}

      <AmountField
        value={amountInput}
        onChange={onAmountInput}
        token={tokenIn}
        pricing={pricing}
        testIdPrefix="amount"
        inputTestId="amount-input"
        remember="once"
        onEnter={() => {
          if (!busy && !waitsOnRates) onQuote();
        }}
        balance={
          <BalanceLine
            account={account}
            balance={balanceIn}
            token={tokenIn}
            onUseAll={(spendable) =>
              // Max is an amount of the token, so the field switches to it.
              onAmountInput({
                text: formatAmountForField(spendable, tokenIn.decimals, pricing.locale),
                unit: "token",
                frozen: null,
              })
            }
          />
        }
        chips={
          tokenOut.symbol === "SPX" ? (
            <PresetChips
              context="amount"
              cents={CULTURE_AMOUNT_PRESETS_USD_CENTS}
              locale={pricing.locale}
              disabledReason={presetsBlocked(pricing, tokenIn, balanceIn, CULTURE_AMOUNT_PRESETS_USD_CENTS[0])}
              dollarsNote={pricing.currency !== "USD"}
              onPick={(cents) => {
                const text = presetFieldText(cents, pricing.locale);
                onAmountInput(withFrozen(presetInput(text, tokenIn), tokenIn, pricing, performance.now()));
              }}
            />
          ) : undefined
        }
      />

      {/* Above the buttons, so what a swap will send is settled before it is
          priced or signed. Locked while a swap runs: that swap's tips were
          fixed when it started. */}
      <TipRow
        config={config}
        candidates={tipCandidates}
        quote={quote}
        tokenOut={tokenOut}
        delivery={delivery}
        disabled={swapping}
        onChange={onConfig}
      />

      {offersQuote || !(account || quote?.previewOnly) ? (
        <div className="spdex-actions">
          {/* aria-disabled rather than disabled: a focused button that turns
              disabled drops focus to the page, and the next Tab lands anywhere.
              This one keeps it through "Getting price…", until the price lands. */}
          {offersQuote ? (
            <button
              type="button"
              className="spdex-button"
              data-testid="quote-button"
              aria-disabled={busy || waitsOnRates ? true : undefined}
              onClick={busy || waitsOnRates ? undefined : onQuote}
            >
              {quoting ? "Getting price…" : quote ? "Refresh price" : "Get price"}
            </button>
          ) : null}
          {/* With a preview showing, "Connect wallet to swap" under it is the one way on. */}
          {account || quote?.previewOnly ? null : (
            <Button variant="ghost" onClick={onConnect} testId="connect-button">
              Connect wallet
            </Button>
          )}
        </div>
      ) : null}

      {statusBesideSwap ? null : statusView}
      {statusBesideSwap || pendingSend === null ? null : <SlowSend pending={pendingSend} chainId={config.chainId} />}

      {quote ? (
        <div className="spdex-quote" ref={quoteRef} tabIndex={-1}>
          <RouteView
            quote={quote}
            tokenIn={tokenIn}
            tokenOut={tokenOut}
            config={paying}
            mode={mode}
            delivery={delivery}
            pricing={pricing}
            typed={quotedFrom}
            networkFee={networkFee}
            feeLevel={feeLevel}
          />
          {/* A clean pass, or a preview whose next step is the button below,
              folds under Advanced; anything to read stays here (UI rule R6). */}
          {cleanPass(quote) || quote.previewOnly ? null : guardBanner}

          <div className="spdex-actions">
            {/* No disabled button for a refused plan: refusal means there is
                nothing to sign, and offering a greyed-out control implies
                otherwise. */}
            {quote.previewOnly ? (
              <Button onClick={onConnect} testId="connect-to-swap">
                Connect wallet to swap
              </Button>
            ) : quote.verdict.signable ? (
              <Button onClick={onSwap} disabled={busy || autoBuyHoldsWallet} testId="swap-button">
                Swap
              </Button>
            ) : null}
          </div>
          {autoBuyHoldsWallet && quote.verdict.signable && !quote.previewOnly ? (
            <p className="spdex-field__hint">Waiting for your auto-buy to finish…</p>
          ) : null}
          {statusBesideSwap ? statusView : null}
          {statusBesideSwap && pendingSend !== null ? <SlowSend pending={pendingSend} chainId={config.chainId} /> : null}

          {/* The route, a clean safety check and the raw transaction: one
              fold, closed in Simple. Keyed by the quote: `open` applies only
              when the prop changes, so one closed in Expert would stay closed
              on the next quote; with the key, each quote opens it afresh there. */}
          <Disclosure
            key={quoteId}
            testId="swap-advanced"
            // "1 market" kept on one line when a phone wraps the summary.
            summary={`Advanced · ${marketsLabel(quote.route.legs.length).replace(" ", "\u00a0")}${cleanPass(quote) ? " · checked" : ""}`}
            open={mode === "expert"}
          >
            <QuoteLimits quote={quote} tokenIn={tokenIn} tokenOut={tokenOut} config={paying} />
            <RouteDetails quote={quote} tokenOut={tokenOut} />
            {cleanPass(quote) || quote.previewOnly ? guardBanner : null}
            <div className="spdex-actions">
              <Button variant="ghost" onClick={() => setShowRaw((v) => !v)} testId="toggle-raw-plan">
                {showRaw ? "Hide transaction" : "Inspect transaction"}
              </Button>
            </div>
            {showRaw ? (
              <>
                <p className="spdex-field__hint">What your wallet will sign.</p>
                <pre className="spdex-code" data-testid="raw-plan">
                  {JSON.stringify(
                    quote.legs.map((leg) => ({
                      pool: leg.label ?? leg.poolId,
                      verdict: leg.verdict.level,
                      approvals: leg.plan.approvals.map((a) => ({
                        token: a.token,
                        spender: a.spender,
                        amount: a.amount.toString(),
                      })),
                      calls: leg.plan.calls.map((c) => ({ to: c.to, data: c.data, value: c.value.toString() })),
                      minAmountOut: leg.plan.intent.minAmountOut.toString(),
                    })),
                    null,
                    2,
                  )}
                </pre>
              </>
            ) : null}
          </Disclosure>
        </div>
      ) : null}
    </>
  );
}
