/**
 * Plain summaries: what a trade will do, and what a shared config would change.
 *
 * Both are the sentences someone reads just before a decision, so both are
 * pure functions here and pinned by tests, rather than arithmetic scattered
 * through JSX. The same two rules as everywhere else:
 *
 * - **Unknown is never zero.** A figure that can't be computed (no dollar
 *   rate, a token not in the list) is `null` and left off the screen, never
 *   shown as 0.
 * - **Counts are upper bounds when the truth arrives later.** Whether an
 *   approval is needed is read at execution time, so the number of wallet
 *   prompts is "up to" n, never a promise.
 */

import type { SpdexConfig } from "@spdex/core";
import { TIPLIST_MODULE_ID } from "@spdex/config";
import { ethUpTo, formatSignificant } from "./dca/format.js";
import { fiatCostText, type MoneyView } from "./money/convert.js";
import { formatNumber } from "./money/format.js";
import type { SecondOpinionStatus } from "./simulation.js";

const WAD = 10n ** 18n;

// ── A trade ───────────────────────────────────────────────────────────────

/**
 * "1,307.85": how much of the output one whole input token buys, to six
 * significant figures, grouped. Null when the input is zero (no rate exists).
 */
export function formatRate(amountIn: bigint, decimalsIn: number, amountOut: bigint, decimalsOut: number): string | null {
  if (amountIn <= 0n || amountOut < 0n) return null;
  // Scaled to 18 decimals so formatSignificant can place the point, and so a
  // rate below one (1 SPX = 0.000764 ETH) keeps its digits.
  const scaled = (amountOut * 10n ** BigInt(decimalsIn) * WAD) / (amountIn * 10n ** BigInt(decimalsOut));
  return formatSignificant(scaled, 18, 6);
}

/** "1 ETH = 1,307.85 SPX", the one direction every rate on the page uses. */
export function rateLine(
  tokenIn: { symbol: string; decimals: number },
  tokenOut: { symbol: string; decimals: number },
  amountIn: bigint,
  amountOut: bigint,
): string | null {
  const rate = formatRate(amountIn, tokenIn.decimals, amountOut, tokenOut.decimals);
  return rate === null ? null : `1 ${tokenIn.symbol} = ${rate} ${tokenOut.symbol}`;
}

/**
 * Gas a typical ERC-20 permission (`approve`) uses, for the network-fee
 * estimate only: about 46,000 when the allowance was zero, rounded up. The
 * wallet sets the real limit, and shows the real fee.
 */
export const APPROVAL_GAS_TYPICAL = 50_000n;

/**
 * What a swap's transactions come to in network fees at `feePerGas` (a block's
 * base fee and tip now): each leg's gas as its venue estimated it, and a
 * typical permission for each one a leg declares. `upTo` when there is a
 * permission, since the wallet may already have given it.
 */
export function swapNetworkFee(
  legs: readonly { plan: { approvals: readonly unknown[] } }[],
  gasEstimate: bigint,
  feePerGas: bigint,
): { wei: bigint; upTo: boolean } {
  const approvals = legs.reduce((n, leg) => n + leg.plan.approvals.length, 0);
  return { wei: (gasEstimate + BigInt(approvals) * APPROVAL_GAS_TYPICAL) * feePerGas, upTo: approvals > 0 };
}

/** "≈ $0.37 (0.000152 ETH)", "up to ≈ $0.49 (0.0002 ETH)"; the ether alone without a rate. */
export function networkFeeText(fee: { wei: bigint; upTo: boolean }, money: MoneyView | undefined): string {
  const ether = `${ethUpTo(fee.wei)} ETH`;
  const worth = fiatCostText(fee.wei, money);
  return `${fee.upTo ? "up to " : ""}${worth === null ? `≈ ${ether}` : `${worth} (${ether})`}`;
}

/** A swap's network fee is high at this share of what is swapped, in basis points (3%)… */
export const HIGH_FEE_SHARE_BPS = 300n;
/** …or when the base fee is this many times its median over the last few hours (`readFeeLevel`). */
export const FEE_SPIKE_RATIO = 3n;

/**
 * "Network fees are high right now: 13% of this swap, 4× the last few hours.
 * If it can wait, try later." Or null when neither is so, or neither can be
 * said: a share needs the swap's size in ether (`swapWei`, null when neither
 * side is ETH or WETH), a spike needs the fee level (null when unread).
 * Advice only: nothing waits, and Swap stays where it was.
 */
export function highFeeNote(input: {
  feeWei: bigint;
  swapWei: bigint | null;
  level: { base: bigint; usual: bigint } | null;
  /** What the share is of: a swap, or an auto-buy's buy. */
  of?: "swap" | "buy";
}): string | null {
  const shareBps = input.swapWei !== null && input.swapWei > 0n ? (input.feeWei * 10_000n) / input.swapWei : null;
  const ratio = input.level !== null && input.level.usual > 0n ? input.level.base / input.level.usual : null;
  const parts: string[] = [];
  if (shareBps !== null && shareBps >= HIGH_FEE_SHARE_BPS) {
    const percent = formatNumber(Number(shareBps) / 100, { maximumFractionDigits: shareBps >= 1_000n ? 0 : 1 });
    parts.push(`${percent}% of this ${input.of ?? "swap"}`);
  }
  if (ratio !== null && ratio >= FEE_SPIKE_RATIO) parts.push(`${ratio}× the last few hours`);
  return parts.length === 0 ? null : `Network fees are high right now: ${parts.join(", ")}. If it can wait, try later.`;
}

/**
 * The most wallet prompts a trade can take: per leg, each declared approval
 * and the swap itself, then one per tip.
 */
export function maxConfirmations(
  legs: readonly { plan: { approvals: readonly unknown[] } }[],
  tipRecipients: number,
): number {
  return legs.reduce((sum, leg) => sum + leg.plan.approvals.length + 1, 0) + Math.max(0, tipRecipients);
}

/**
 * "will ask you to confirm once" or "will ask you to confirm up to 3 times".
 *
 * A batch of tips is not folded into the count: a signature is not a
 * transaction, and counting it as one would say it was. The summary card
 * gives the batch a row of its own instead ("Then, for tips"), in the order
 * the wallet asks (`tipCostText`: the signature, the standing permission for
 * Permit2 when it is needed, then the transaction), which also keeps either
 * line short enough for a phone.
 */
export function confirmCountText(count: number): string {
  return count <= 1 ? "will ask you to confirm once" : `will ask you to confirm up to ${count} times`;
}

/** "1 market", "3 markets". */
export function marketsLabel(count: number): string {
  return count === 1 ? "1 market" : `${count} markets`;
}

// ── The network service ───────────────────────────────────────────────────

/**
 * Whether the network service can run the safety test: still asking, yes, no,
 * or no definite answer (a rate limit, an error), which is never shown as yes.
 */
export type SafetyTest = "checking" | "available" | "unavailable" | "unknown";

/** What the status strip and the Network service panel say about it. */
export function safetyTestText(state: SafetyTest): string {
  switch (state) {
    case "checking":
      return "checking…";
    case "available":
      return "available";
    case "unavailable":
      return "not available on this service";
    case "unknown":
      return "couldn't tell";
  }
}

/** The engine's answer (`true`, `false` or `"unknown"`) as a state. */
export function safetyTestFrom(answer: boolean | "unknown"): SafetyTest {
  return answer === true ? "available" : answer === false ? "unavailable" : "unknown";
}

/**
 * What the strip adds after "Safety test: …" about the second opinion, or
 * null when there is nothing to add: none is set, or the main service can't
 * test-run anything (then nothing is checked on two services either).
 *
 * "Checked on 2 services" is said only while the last check heard back from
 * both; after one where the second didn't answer, it says so until one does.
 * Before any check has run (just after loading, or after the setting is
 * saved) it says what will happen, "checks on 2 services", since nothing has
 * been checked yet.
 */
export function secondOpinionStripText(status: SecondOpinionStatus, safety: SafetyTest): string | null {
  switch (status.kind) {
    case "off":
      return null;
    case "same":
      return "second opinion is your main service, so it doesn't count";
    case "on":
      if (safety !== "available") return null;
      if (status.last === null) return "checks on 2 services";
      return status.last === "unavailable" ? "second opinion not answering" : "checked on 2 services";
  }
}

// ── A shared config ───────────────────────────────────────────────────────

/** Everything that makes a plan the plan it is, apart from whether it is paused. */
function planTerms(plan: SpdexConfig["dca"]["plans"][number]): string {
  const { paused: _paused, ...terms } = plan;
  return JSON.stringify(terms, Object.keys(terms).sort());
}

const percent = (bps: number) => `${formatNumber(bps / 100, { maximumFractionDigits: 2 })}%`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * One line per change that can move money, or weaken what checks it, for the
 * "this link carries settings" prompt.
 *
 * The raw diff below it lists everything, exactly; these lines are the part a
 * person must not miss: a different network service (which sees and can lie
 * about everything); fewer markets; tips; auto-buys arriving, going, changing
 * terms under the same id or being paused; a wider price tolerance; contracts
 * trusted beyond the modules' own; the safety test made optional or its price
 * warning widened; a different way of sending; and plug-ins from outside
 * spDEX. Anything else is in the diff alone — which the prompt says.
 */
export function stagedSummary(current: SpdexConfig, staged: SpdexConfig): string[] {
  const lines: string[] = [];

  if (staged.rpc.url !== null && staged.rpc.url !== current.rpc.url) {
    lines.push(`Changes your network service to ${staged.rpc.url}`);
  }

  if (staged.pools.mode === "allowlist" && JSON.stringify(staged.pools) !== JSON.stringify(current.pools)) {
    const count = staged.pools.allow.length;
    lines.push(`Limits swaps to ${count === 1 ? "1 market" : `${count} markets`}`);
  }

  const tipsOn = (tips: SpdexConfig["tips"]) => tips.enabled && tips.recipients.length > 0;
  if (tipsOn(staged.tips) && JSON.stringify(staged.tips) !== JSON.stringify(current.tips)) {
    const bps = staged.tips.recipients.reduce((sum, r) => sum + r.bps, 0);
    const count = staged.tips.recipients.length;
    const percent = formatNumber(bps / 100, { maximumFractionDigits: 2 });
    lines.push(`Tips ${percent}% of each swap to ${count === 1 ? "1 address" : `${count} addresses`}`);
  }

  // Vault plans are said apart: none of "arrives paused", "resume" or "this
  // browser counts it" is true of a plan whose vault buys on chain and keeps
  // its own count.
  const vaultPlan = (plan: { signer: string }) => plan.signer === "vault";
  const currentIds = new Set(current.dca.plans.map((plan) => plan.id));
  const stagedIds = new Set(staged.dca.plans.map((plan) => plan.id));
  const arriving = staged.dca.plans.filter((plan) => !currentIds.has(plan.id));
  const leaving = current.dca.plans.filter((plan) => !stagedIds.has(plan.id));
  const added = arriving.filter((plan) => !vaultPlan(plan)).length;
  const addedVaults = arriving.filter(vaultPlan).length;
  const removed = leaving.filter((plan) => !vaultPlan(plan)).length;
  const removedVaults = leaving.filter(vaultPlan).length;
  if (added > 0) {
    lines.push(
      `Adds ${added === 1 ? "1 auto-buy" : `${added} auto-buys`}. They arrive paused and won't buy until you resume them. ` +
        "This browser counts each from zero, even if it ran elsewhere.",
    );
  }
  if (addedVaults > 0) {
    lines.push(
      `Adds ${plural(addedVaults, "vault plan", "vault plans")}. A vault buys on chain whenever anyone triggers a due buy — ` +
        "nothing here pauses or resumes it — and keeps its own count. A vault that isn't yours is shown read-only.",
    );
  }
  if (removed > 0) lines.push(`Removes ${removed === 1 ? "1 auto-buy" : `${removed} auto-buys`} you have`);
  if (removedVaults > 0) {
    lines.push(
      `Leaves out ${plural(removedVaults, "of your vault plans", "of your vault plans")}. spDEX keeps any whose vault may still ` +
        "hold money or buy: its plan is the only way back to it from here, and closing a vault is the only way to stop it.",
    );
  }

  // Same id, different plan: this browser's record of it is keyed by the id,
  // so what it already bought would count against the new terms.
  const kept = current.dca.plans
    .map((mine) => ({ mine, theirs: staged.dca.plans.find((plan) => plan.id === mine.id && plan.chainId === mine.chainId) }))
    .filter((pair): pair is { mine: (typeof pair)["mine"]; theirs: NonNullable<(typeof pair)["theirs"]> } => pair.theirs !== undefined);
  // A vault plan pointed at another vault, or at none: a plan's vault is
  // written once, so spDEX keeps the one it has (`keepVaultPlans`).
  const repointed = kept.filter(
    ({ mine, theirs }) => vaultPlan(mine) && mine.vault !== undefined && theirs.vault?.toLowerCase() !== mine.vault.toLowerCase(),
  ).length;
  if (repointed > 0) {
    lines.push(
      `Points ${plural(repointed, "of your vault plans", "of your vault plans")} at another vault, or at none. ` +
        "spDEX keeps the vault each already has: a plan's vault can't change.",
    );
  }
  const changed = kept.filter(({ mine, theirs }) => !vaultPlan(mine) && planTerms(mine) !== planTerms(theirs)).length;
  if (changed > 0) {
    lines.push(
      `Changes the terms of ${plural(changed, "auto-buy", "auto-buys")} you have — amount, pair, schedule or who signs. ` +
        "What this browser recorded as bought counts against the new terms.",
    );
  }
  // Every plan from outside arrives paused, your own running ones included.
  const paused = kept.filter(({ mine, theirs }) => !mine.paused && theirs.paused).length;
  if (paused > 0) {
    lines.push(`Pauses ${plural(paused, "of your running auto-buys", "of your running auto-buys")} until you resume ${paused === 1 ? "it" : "them"}`);
  }

  if (staged.slippageBps > current.slippageBps) {
    lines.push(`Raises your price tolerance from ${percent(current.slippageBps)} to ${percent(staged.slippageBps)}`);
  }

  const trusted = new Set(current.extraTrustedContracts.map((address) => address.toLowerCase()));
  const newlyTrusted = staged.extraTrustedContracts.filter((address) => !trusted.has(address.toLowerCase())).length;
  if (newlyTrusted > 0) {
    lines.push(`Trusts ${plural(newlyTrusted, "more contract", "more contracts")} that the safety check would otherwise flag`);
  }

  if (current.guard.requireSimulation && !staged.guard.requireSimulation) {
    lines.push("Lets you sign swaps the safety test couldn't run on");
  }

  // Both ways matter. A second service sees every transaction before it is
  // signed, which is exactly what a link could slip in; and dropping one
  // takes a check away that the person may believe is still running.
  const secondBefore = current.guard.secondOpinion?.url ?? null;
  const secondAfter = staged.guard.secondOpinion?.url ?? null;
  if (secondAfter !== null && secondAfter !== secondBefore) {
    lines.push(`Also test-runs every transaction on ${secondAfter}, which will see what you're about to sign`);
  } else if (secondAfter === null && secondBefore !== null) {
    lines.push("Turns off your second opinion: transactions are test-run on one service only");
  }
  if (staged.guard.oracleDivergenceBps > current.guard.oracleDivergenceBps) {
    lines.push(
      `Warns about a price far from the 10-minute average only past ${percent(staged.guard.oracleDivergenceBps)} ` +
        `(now ${percent(current.guard.oracleDivergenceBps)})`,
    );
  }

  if (JSON.stringify(staged.submitter) !== JSON.stringify(current.submitter)) {
    if (staged.submitter.mode === "private" && staged.submitter.url !== null) {
      lines.push(`Sends your transactions privately through ${staged.submitter.url}`);
    } else if (current.submitter.mode === "private" && staged.submitter.mode !== "private") {
      lines.push("Turns private sending off: transactions go to the public queue");
    }
  }

  const installed = new Set(current.modules.map((module) => module.id));
  const outside = staged.modules.filter((module) => module.source !== "builtin" && module.enabled && !installed.has(module.id)).length;
  if (outside > 0) lines.push(`Adds ${plural(outside, "plug-in", "plug-ins")} from outside spDEX`);

  return lines;
}

/**
 * Everything a quote is built from, for "did anything that affects quoting
 * change?" — so everything but auto-buy plans, the preset marker, and tips.
 *
 * Tips are left out, with the registry module that names who to tip, because
 * no quote depends on them: the Guard judges the swap alone, and what a tip
 * would send is worked out from the config each time the page draws. Leaving
 * them in made every tap on the Trade card's Tip row throw away the price on
 * screen, rebuild the Engine and re-read every market, for a number that is
 * one multiplication away.
 */
export function quotingKey(config: SpdexConfig): string {
  const { dca: _dca, preset: _preset, tips: _tips, ...rest } = config;
  return JSON.stringify({ ...rest, modules: rest.modules.filter((module) => module.id !== TIPLIST_MODULE_ID) });
}
