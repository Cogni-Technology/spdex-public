/**
 * useAutoBuy: the auto-buy runtime of one tab, as React state.
 *
 * The only React hook under lib/. Everything it does is someone else's logic —
 * the runner decides when a buy is due (runner.ts), the ledger records it
 * (ledger.ts), and vault.ts reads and drives vaults — and this file only
 * wires them to a page: it owns their lifetimes, turns their
 * answers into state a component can render, and turns a click into the one
 * call that click means.
 *
 * ## Lifetimes, and why each is what it is
 *
 * - **One `LedgerStore` per page**, made on first use and never disposed. It
 *   is a view of storage that outlives any render, and two copies of the
 *   ledger in one page could each write from a stale read.
 * - **One `DcaRunner` per tab, rebuilt whenever the engine or the config
 *   changes**, and stopped in the effect's cleanup. A runner's config is fixed
 *   when it is built (a plan added, paused or resumed takes effect only in a
 *   runner built from the new config), so rebuilding is how a change reaches
 *   it. `start()` is idempotent and `stop()` lets the lock go only after a buy
 *   already under way has finished, so React's StrictMode double mount, and a
 *   rebuild in the middle of a buy, are both safe.
 * - **The first buy after Start is handed to the rebuilt runner**, not the one
 *   that was running when Start was pressed: that one was built from a config
 *   without the new plan. The click leaves the plan's id in a ref, and the
 *   effect that builds the next runner makes the buy once it is running. It
 *   is deferred a tick, so StrictMode's throwaway first mount can't take it.
 *
 * ## Vault plans
 *
 * A vault plan is run by its vault, on chain, so it has no runner and no
 * ledger entry: the hook reads each vault plan's vault from the chain
 * (vault.ts) on the same beat as the balances, and a click sends the one
 * transaction it means — create, fund, close or trigger — through the vault
 * Guard and the owner's wallet. Its card reads `vaultFor` / `vaultStatusFor`,
 * not the runner's state, which reports every vault plan as paused because
 * this tab never runs one. Countdowns use chain time (`chainNow`).
 *
 * A vault the config no longer points at still holds its budget and buys, so
 * the hook also looks for the connected account's vaults on chain, once per
 * account per network service (not per Engine: one rebuilt for another
 * setting keeps what was found), whenever asked ("Look again"), and again by
 * itself after a search that failed, and lists those no plan points at
 * (`strayVaults`). A vault plan deleted here joins that list at once, from its
 * last read, without waiting for a search. Vault plans' vaults count toward
 * the factory's count, so the list never calls a vault on the page missing.
 *
 * ## Autopilot plans
 *
 * Until config version 8 an autopilot plan bought from a spending wallet this
 * browser generated; the migration made each such plan a paused wallet plan.
 * Nothing reads those wallets any more: no release ever made one, so their
 * listing, withdrawal and key export were removed (2026-10-02).
 *
 * ## Unknown is never zero
 *
 * Every figure read from the network — the owner's balance, today's fees,
 * whether the service can run the safety test — is kept as "not read yet",
 * "read" or "couldn't be read", and each renders differently. A balance that
 * failed to read is `null`, shown "unknown", never 0: a 0 would be a claim
 * nobody made.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import {
  addDcaPlan,
  DCA_FEATURE_ID,
  removeDcaPlan,
  setFeature,
  updateDcaPlan,
  type DcaPlanPatch,
} from "@spdex/config";
import type { Address, DcaPlan, DcaSigner, SpdexConfig } from "@spdex/core";
import { buyFee } from "@spdex/vault";
import type { Engine } from "../engine.js";
import { balanceOf } from "../erc20.js";
import type { OwnerWalletLock } from "../execute.js";
import { friendlyError, guardSentence } from "../errors.js";
import { readFeeLevel, readWalletFees } from "../fees.js";
import { networkLabel } from "../networks.js";
import { walletSender } from "../senders.js";
import { secondOpinionRefusalText } from "../simulation.js";
import { TOKEN_LIST } from "../tokens.js";
import { isUserRejection } from "../wallet.js";
import { amountText, shortAddress } from "./format.js";
import type { FeeRead } from "./form.js";
import type { Pricing } from "../money/pricing.js";
import { vaultIdentities } from "../network/platform.js";
import { searchVaultsFromFactoryList } from "./factoryListSearch.js";
import {
  bindToOwner,
  browserStorage,
  canMoveStart,
  entryOf,
  LedgerBusyError,
  LedgerRebindError,
  LedgerStore,
  LedgerUnavailableError,
  removeEntry,
  resume,
  startEntry,
  type DcaLedger,
  type DcaLedgerEntry,
  type EntryRef,
} from "./ledger.js";
import { keepPlanBuys } from "../records/store.js";
import {
  DcaRunner,
  readLease,
  type BuyOutcome,
  type PlanState,
  type RunnerLease,
  type RunnerSnapshot,
} from "./runner.js";
import { nextBuyAt as soonestNextBuy } from "../ticker.js";
import {
  cardStatus,
  removedPlanCount,
  stripText as stripSummary,
  type CardStatus,
  type SafetyState,
  type StripCard,
} from "./view.js";
import {
  DEFAULT_VAULT_SLIPPAGE_BPS,
  VaultDrafts,
  VaultTxFailed,
  VaultTxRefused,
  chainNow as carryClock,
  keepVaultPlans,
  closeVault as closeVaultOnChain,
  closedAndEmpty,
  createVault as createVaultOnChain,
  defaultVaultWindow,
  deployVaultFactory as deployFactoryOnChain,
  factoryCountsOf,
  foundFromPlan,
  fundVault as fundVaultOnChain,
  mergeVaultSearches,
  provenVaults,
  readChainClock,
  readFoundVault,
  readVaultHistory,
  readVaultPlan,
  readVaultSupport,
  searchAccountVaults,
  withListSearch,
  settleCreation,
  strayVaultList,
  triggerVault as triggerVaultOnChain,
  vaultCardStatus,
  vaultCosts,
  vaultDeployment,
  vaultPlanProblems,
  vaultClaim,
  vaultRetryTerms,
  vaultSearchFailed,
  vaultSearchNote,
  vaultSearchRetryAt,
  vaultStartAt,
  vaultStartLead,
  type ChainClock,
  type FoundVault,
  type OwnerVaults,
  type ShownVault,
  type VaultCardStatus,
  type VaultChoices,
  type VaultCosts,
  type VaultHistory,
  type VaultOpDeps,
  type VaultPlanState,
  type VaultRetryTerms,
  type VaultSearchNote,
  type VaultStep,
  type VaultSupport,
} from "./vault.js";

// ── The seam with App ─────────────────────────────────────────────────────

export interface AutoBuyDeps {
  engine: Engine | null;
  config: SpdexConfig;
  /**
   * App's `applyConfig`. A change to plans alone must not clear the One-time
   * quote on screen — no quote depends on them — and App sees to that.
   */
  applyConfig: (next: SpdexConfig) => void;
  account: `0x${string}` | null;
  /** The wallet is connected and on `config.chainId`. */
  walletChainOk: boolean;
  onConnect: () => void;
  /** The one lock on the owner's wallet, shared with the manual swap. */
  ownerLock: OwnerWalletLock;
  mode: "recommended" | "expert";
  /**
   * Whether the network service can run the safety test, as App already
   * asked it: one question per engine for the whole page, rather than a
   * second `eth_simulateV1` from here.
   */
  safety: SafetyState;
  /**
   * The Recurring tab is on screen. With no plan, no old spending wallet and
   * Auto-buy off, nothing here needs the network until then, so nothing is
   * read but one thing: once a wallet connects where vaults are offered, the
   * search for its vaults (two reads for an account that has created none;
   * log queries only for one that has, and none when its plans here already
   * show every vault it created). A vault can exist that no plan here knows of, and
   * it holds money. Otherwise a page that never uses auto-buy costs its
   * network service nothing for it.
   */
  recurringOpen: boolean;
  /**
   * The page's rates and money preferences (lib/money): the same prices the
   * One-time card's "≈" figures come from, in the person's currency, and an
   * amount typed in money. Display and input only: a plan is saved, and every
   * buy signed, in token amounts, and nothing that buys reads it. A figure
   * whose rates aren't read yet is left off, never shown as zero.
   */
  pricing: Pricing;
}

/** A card's result line: what the last action came to, when the reason line can't say it. */
export interface Notice {
  tone: "ok" | "warn" | "danger";
  title: string;
  text: string;
  /** Guard codes, shown small beside the sentence. */
  codes?: string[];
  /** The raw message, for "Details". */
  detail?: string;
  /**
   * Bring the notice into view and move focus to it when it appears: it
   * answers a click made somewhere else on the page ("Add back to my plans"
   * puts a card among the plans, far above the button), and otherwise the
   * answer is off screen and focus is lost.
   */
  arrive?: boolean;
}

/** What a card is doing that the runner doesn't know about: a vault transaction, a result. */
export interface CardActivity {
  /** A step of an action under way ("Waiting for the network…"), or null. */
  busy: string | null;
  notice: Notice | null;
  /** A due buy's fresh quote carried a price warning of this many basis points; "Buy anyway" accepts it. */
  consentBps: number | null;
  /** The buy time that warning was for: it is shown, and accepted, for that buy time only. */
  consentSlot: number | null;
}

export interface NewPlanInput {
  plan: DcaPlan;
  signer: DcaSigner;
  /**
   * Whether the first buy is now. The Start click is then the first buy's
   * confirmation — a wallet plan never opens the wallet on a timer, so the
   * click is the moment the person is there to confirm it.
   */
  firstBuyNow: boolean;
  /**
   * A vault plan's choices (`signer: "vault"`): the price allowance, the buy
   * fee when not this release's default (`vaultCostsFor`), the community
   * window when Expert chose one (the plan's default, `defaultVaultWindow`,
   * otherwise), and the wei sent with the creation — the whole budget when
   * left out, so one confirmation creates and funds it.
   */
  vault?: { maxSlippageBps: number; keeperReward?: bigint; communityWindow?: number; fund?: bigint };
}

/** A vault plan's history as last asked for. */
export type VaultHistoryRead =
  | { kind: "loading" }
  /** `buysDone` is the vault's count the history was read for; it is read again when that moves. */
  | { kind: "ok"; history: VaultHistory; buysDone: number }
  | { kind: "error"; message: string };

/** The activity key of the vault factory's one-time deployment. */
export const VAULT_FACTORY_ACTIVITY = "vault-factory";

/** The activity key of a vault found on chain that no plan points at. */
export function strayVaultKey(vault: string): string {
  return `stray-vault:${vault.toLowerCase()}`;
}

/**
 * The connected account's vaults on chain that no plan here points at, as the
 * panel lists them. Built from every search on this page
 * (`searchAccountVaults`), plus any vault whose plan was deleted here, less
 * every vault a plan points at.
 */
export interface StrayVaultsView {
  /** A search is running now. */
  searching: boolean;
  /** Why the last search failed, or null. Unknown, not "none": it says nothing about whether any exist. */
  error: string | null;
  /** A search that failed or read nothing will be tried again by itself (`vaultSearchRetryAt`). */
  retrying: boolean;
  /**
   * The factory counts vaults the page doesn't show (`vaultSearchNote`): how
   * many and why; null when every one is shown, a plan's vault included.
   */
  note: VaultSearchNote | null;
  /** When the last search finished, device time, and how many vaults the factory counts, all shown; null otherwise. */
  checked: { at: number; expected: number } | null;
  /** The ones that matter, each with its card's pill and line in chain time. */
  listed: (FoundVault & { status: VaultCardStatus })[];
  /** Closed, with nothing left in them: listed apart, collapsed. */
  closed: FoundVault[];
  /** A vault among `closed` was closed from its card on this page. */
  closedHere: boolean;
}

/** One account's search on one chain, and what it led to. */
interface FoundVaults {
  search: { kind: "idle" } | { kind: "searching" } | { kind: "done" } | { kind: "error"; message: string };
  /**
   * What the searches on this page found, the last one's count, bound and
   * refusal with every earlier find folded in (`mergeVaultSearches`); null
   * before one has finished, and where there is no factory to search.
   */
  last: OwnerVaults | null;
  /**
   * Every vault known to be the account's: found by any search on this page,
   * or pointed at by a plan deleted here. Kept across searches, so a later one
   * that an endpoint cut short never hides a vault an earlier one found: a
   * vault, once created, is on chain for good.
   */
  known: Address[];
  /**
   * The vaults of the factory's count the page accounts for: named by a
   * search, or on the page and proved one of them by address
   * (`provenVaults`). Never shrinks: a vault counted once was created before
   * that count for good, and a later read that fails doesn't unprove it.
   */
  accounted: Address[];
  /** Each vault as last read, by lowercase address. */
  reads: Record<string, FoundVault>;
  /** Searches in a row that failed or read nothing (`vaultSearchFailed`). */
  failures: number;
  /** When to search again by itself, device time; null when it needn't, or its retries are spent. */
  retryAt: number | null;
  /** When the last search finished, device time; null before one has. */
  checkedAt: number | null;
  /** Vaults closed from their card on this page: their line in "Closed vaults" keeps the panel up. */
  closedHere: Address[];
}

const NO_FOUND_VAULTS: FoundVaults = {
  search: { kind: "idle" },
  last: null,
  known: [],
  accounted: [],
  reads: {},
  failures: 0,
  retryAt: null,
  checkedAt: null,
  closedHere: [],
};

/**
 * What vault state describes: the chain and the network service it was read
 * from. It is kept while the Engine is rebuilt for any other setting — Add back
 * with Auto-buy off switches Auto-buy on, which adds the scheduler module and
 * rebuilds the Engine, and that used to wipe the vaults the search had found
 * and the card Add back had just made. The chain didn't change.
 */
const networkOf = (config: Pick<SpdexConfig, "chainId" | "rpc">): string => `${config.chainId}|${config.rpc.url ?? ""}`;

/** `known` with `more` added, each once, lowercased, in the order first seen. */
const withKnown = (known: readonly Address[], more: readonly Address[]): Address[] => [
  ...new Set([...known, ...more].map((vault) => vault.toLowerCase() as Address)),
];

export interface AutoBuy {
  /** Short line for the status strip (`strip-dca`), or null when there are no plans. */
  stripText: string | null;
  /**
   * The soonest next buy among running plans, unix seconds by this device's
   * clock (a vault's carried over from chain time), or null: the strip's own
   * figure, for the ticker. A buy already due has none.
   */
  nextBuyAt: number | null;
  /** True while any plan's buy is due for its owner to confirm — App prefixes document.title with "● Buy due — ". */
  buyDue: boolean;
  /** Plans exist, or an old spending wallet, or a vault no plan points at — App renders <AutoBuysPanel> only then. */
  hasPanel: boolean;
  /**
   * Called by App BEFORE a config change that replaces the plans (reset,
   * import, accepting a shared link): asks when plans would go, and resolves
   * to the config to apply — `next`, with each vault plan that may still hold
   * money or buy kept as it is (`keepVaultPlans`) — or null for no.
   */
  confirmPlanRemoval(next: SpdexConfig): Promise<SpdexConfig | null>;

  // What the components read.
  now: number;
  snapshot: RunnerSnapshot | null;
  ledger: DcaLedger | "unavailable";
  entryFor(plan: Pick<DcaPlan, "id" | "chainId">): DcaLedgerEntry | null | "unavailable";
  stateFor(planId: string): PlanState | undefined;
  statusFor(planId: string): CardStatus | undefined;
  safety: SafetyState;
  fees: FeeRead;
  /** The base fee now and its usual over the last few hours (`readFeeLevel`), for a due buy's high-fee line; null unread. */
  feeLevel: { base: bigint; usual: bigint } | null;
  /**
   * Whether this browser has Web Locks, which decide the one tab that runs
   * plans: without them no tab buys, so a plan you confirm can't be started
   * here. A vault doesn't need them.
   */
  webLocks: boolean;
  /** The connected account's balances by token address: undefined not read, null couldn't be read. */
  ownerBalances: Record<string, bigint | null>;
  priceCheck: Record<string, boolean | "checking">;
  ownerLockBusy: boolean;
  lease: (RunnerLease & { thisTab: boolean }) | null;
  activity: Record<string, CardActivity>;
  /** The open removal question: plans that go, a sentence per vault plan kept, and why none can be kept, if so. */
  removal: { count: number; kept: string[]; error: string | null } | null;
  answerRemoval(ok: boolean): void;
  /** A plan to prefill the Recurring form with ("Set up again"), bumped each time. */
  prefill: { plan: DcaPlan; nonce: number } | null;

  // What a click does.
  startPlan(input: NewPlanInput): Promise<{ ok: true } | { ok: false; error: string }>;
  confirmDue(planId: string): Promise<void>;
  skipDue(planId: string): Promise<void>;
  pause(planId: string): void;
  /**
   * Resume a paused or stopped plan: binds this browser for a plan with no
   * record here, and a plan that was an autopilot plan to its owner.
   */
  resumePlan(planId: string): Promise<void>;
  enableAutoBuy(): void;
  deletePlan(planId: string): Promise<boolean>;
  recreate(planId: string): void;
  clearNotice(key: string): void;
  refresh(): void;

  // Vault plans (signer "vault"): read from the chain, never from this browser's record.
  /** Whether a vault can be offered on this chain now; `checking` until the first read. */
  vaultSupport: VaultSupport | { kind: "checking" };
  /** A vault plan's vault as last read (`loading` until then); undefined for any other plan. */
  vaultFor(planId: string): VaultPlanState | undefined;
  /** A vault plan's pill and line (also what `statusFor` returns for it, as `row: "vault"`). */
  vaultStatusFor(planId: string): VaultCardStatus | undefined;
  /**
   * Chain time now, unix seconds: the plan's vault's clock when given one
   * that has been read, else the chain's latest block as last read, carried
   * forward. Null until a read. Countdowns and a vault plan's start use this,
   * never `Date.now()`.
   */
  chainNow(planId?: string): number | null;
  /**
   * The form's vault figures: the buy fee and its share, the budget, and the
   * creation's network fee once current fees are read. Null without an amount.
   */
  vaultCostsFor(amountPerBuy: bigint, maxBuys: number): VaultCosts | null;
  /** Each vault plan's history, once asked for with `loadVaultHistory`. */
  vaultHistory: Record<string, VaultHistoryRead>;
  loadVaultHistory(planId: string): Promise<void>;
  /**
   * The terms a vault plan's vault would be created with from its card
   * (`vaultRetryTerms`): `chosen` is an allowance picked there. Null for a
   * plan that isn't a vault plan.
   */
  vaultRetryFor(planId: string, chosen: number | null): VaultRetryTerms | null;
  /**
   * Create (and fund) a vault plan's vault: the retry for a plan whose
   * creation didn't happen. The card passes the terms it showed
   * (`vaultRetryFor`); none is defaulted silently.
   */
  createVault(
    planId: string,
    options?: { maxSlippageBps?: number; keeperReward?: bigint; communityWindow?: number; fund?: bigint },
  ): Promise<void>;
  /** Fund a vault plan's vault; everything its remaining buys still need when `amount` is left out. */
  fundVault(planId: string, amount?: bigint): Promise<void>;
  /** Close a vault plan's vault: everything it holds goes back to its owner. The only stop a vault has. */
  closeVault(planId: string): Promise<void>;
  /** Make a vault plan's due buy from the connected wallet, its owner's, which the buy fee (as WETH) comes back to. */
  triggerVault(planId: string): Promise<void>;
  /** Send the vault factory's one-time deployment (activity key `VAULT_FACTORY_ACTIVITY`). */
  deployVaultFactory(): Promise<void>;
  refreshVaults(): void;

  // Vaults on chain no plan points at (activity key `strayVaultKey`).
  /** Null with no wallet connected, or on a chain vaults aren't offered on. */
  strayVaults: StrayVaultsView | null;
  /** "Look again": search the chain for the connected account's vaults, and read every one known again. */
  lookForVaults(): void;
  /**
   * Vaults a factory-list search elsewhere on the page found for the
   * connected account (Trust and exits' "Find my vaults from the factory's
   * list"): the ones no plan points at are listed here too, to close or add
   * back, once each is read like any other found vault.
   */
  addFoundVaults(result: OwnerVaults): void;
  /** Close a found vault through the vault Guard, as a plan's card closes its own: everything comes back to the owner. */
  closeStrayVault(vault: Address): Promise<void>;
  /**
   * "Add back to my plans": the plan its terms describe (`planFromVault`),
   * written with `addDcaPlan` once its address proves it the account's on
   * those terms (`vaultClaim`).
   */
  addStrayVault(vault: Address): Promise<void>;
}

// ── Page-wide objects ─────────────────────────────────────────────────────

let pageLedger: LedgerStore | null = null;
function ledgerStore(): LedgerStore {
  pageLedger ??= new LedgerStore(browserStorage());
  return pageLedger;
}

/** Whether this browser has Web Locks: see `AutoBuy.webLocks`. */
function hasWebLocks(): boolean {
  return Boolean((globalThis as { navigator?: Navigator }).navigator?.locks);
}

let pageDrafts: VaultDrafts | null = null;
/** Vault plans' choices and creations under way, in this browser's storage: a convenience (see VaultDrafts). */
function vaultDrafts(): VaultDrafts {
  pageDrafts ??= new VaultDrafts(browserStorage());
  return pageDrafts;
}

const EMPTY_ACTIVITY: CardActivity = { busy: null, notice: null, consentBps: null, consentSlot: null };
const TICK_MS = 15_000;
/**
 * What a ledger write that waited too long for the leading tab tells the
 * person: nothing was written, and pressing again once that tab's buy is
 * recorded will work.
 */
const LEDGER_BUSY_TEXT = "Another spDEX tab is busy — try again in a moment.";
/** Why nothing is resumed while this browser's record can't be read. */
const LEDGER_UNREADABLE_TEXT =
  "spDEX can't read this browser's record of its auto-buys, so it won't work out what this plan has left. Nothing was changed.";

const refOf = (plan: Pick<DcaPlan, "id" | "chainId">): EntryRef => ({ planId: plan.id, chainId: plan.chainId });
const lower = (address: string) => address.toLowerCase() as `0x${string}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The price warning a due buy's "Buy anyway" accepts, or null.
 *
 * Only for the buy time it was shown for. A warning left over from a buy
 * time that ended unanswered would otherwise sit on the next one's banner,
 * and its click would accept that day's divergence for a fresh quote nobody
 * has seen the figure of.
 */
export function consentFor(activity: CardActivity | undefined, state: PlanState | undefined): number | null {
  if (activity?.consentBps == null || state?.kind !== "due") return null;
  return activity.consentSlot === state.slot ? activity.consentBps : null;
}

/** An error as a card's result line: plain words first, the raw message kept for Details. */
export function noticeFor(error: unknown, rpcUrl: string | null, builtIn = false): Notice {
  if (error instanceof LedgerBusyError) return { tone: "warn", title: "Try again in a moment", text: LEDGER_BUSY_TEXT };
  if (error instanceof LedgerUnavailableError) return { tone: "danger", title: "Can't read this browser's record", text: LEDGER_UNREADABLE_TEXT };
  if (error instanceof LedgerRebindError) {
    return {
      tone: "warn",
      title: "Not resumed yet",
      text:
        "A buy this plan made from its old spending wallet hasn't been confirmed by the network yet. spDEX checks it " +
        "while Auto-buy is on; resume once it has. Nothing was changed.",
      detail: error.message,
    };
  }
  if (error instanceof VaultTxRefused) {
    // The second service not answering is the one refusal that isn't about
    // the transaction: said as waiting for both services, not as a fault.
    // Anything else the Guard refused for is still named after it.
    if (error.codes.includes("SECOND_OPINION_UNAVAILABLE")) {
      const others = error.codes.filter((code) => code !== "SECOND_OPINION_UNAVAILABLE");
      return {
        tone: "danger",
        title: "Blocked by the safety check",
        text: [secondOpinionRefusalText("vault"), ...others.map((code) => guardSentence(code))].join(" ").trim(),
        codes: error.codes,
        detail: error.message,
      };
    }
    return {
      tone: "danger",
      title: "Blocked by the safety check",
      text: `Nothing was sent. ${error.vaultReason ?? error.codes.map((code) => guardSentence(code)).join(" ")}`.trim(),
      codes: error.codes,
      detail: error.message,
    };
  }
  if (isUserRejection(error)) return { tone: "warn", title: "Cancelled", text: "Cancelled in your wallet. Nothing was sent." };
  if (error instanceof VaultTxFailed) {
    const reverted = /reverted on chain/.test(error.message);
    return {
      tone: reverted ? "danger" : "warn",
      title: reverted ? "The transaction failed" : "Still waiting for the network",
      text: reverted
        ? `It was sent (${shortAddress(error.hash)}) and the network rejected it, so nothing changed but the network fee.`
        : `It was sent (${shortAddress(error.hash)}) and hasn't confirmed yet. It may still go through — check it before trying again.`,
      detail: error.message,
    };
  }
  const friendly = friendlyError(messageOf(error), { rpcUrl, builtIn });
  return { tone: "danger", title: friendly.title, text: friendly.sentence, detail: friendly.raw };
}

/** " Checked on one service: …", the check a close or a buy was signed on, after the notice's own sentence (`vaultCheckNote`). */
const withNote = (note: string | null): string => (note === null ? "" : ` ${note}`);

/**
 * "0.00307042 ETH": six significant digits for a result line, as the history
 * shows it, where eighteen decimals of a swept balance would bury the
 * sentence. Expert's history keeps the exact figure.
 */
function roughAmount(amount: bigint, token: string): string {
  return amountText(amount, token, undefined, "rounded");
}

// ── The hook ──────────────────────────────────────────────────────────────

export function useAutoBuy(deps: AutoBuyDeps): AutoBuy {
  const { engine, config, account, ownerLock, safety } = deps;
  // Async actions read the latest props through this, not the ones captured
  // when the click happened: a vault's creation waits minutes for the
  // network, and the config it records the vault in must be the one on
  // screen by then.
  const latest = useRef(deps);
  latest.current = deps;

  const store = ledgerStore();
  const webLocks = useMemo(() => hasWebLocks(), []);

  const [now, setNow] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState<RunnerSnapshot | null>(null);
  /** Buys a replaced runner is still finishing, by plan: shown as buying until they end. */
  const [retiring, setRetiring] = useState<ReadonlyMap<DcaRunner, Record<string, PlanState>>>(() => new Map());
  const [ledger, setLedger] = useState<DcaLedger | "unavailable">(() => store.read());
  const [fees, setFees] = useState<FeeRead>({ kind: "reading" });
  const [feeLevel, setFeeLevel] = useState<{ base: bigint; usual: bigint } | null>(null);
  const [ownerBalances, setOwnerBalances] = useState<Record<string, bigint | null>>({});
  const [priceCheck, setPriceCheck] = useState<Record<string, boolean | "checking">>({});
  const [ownerLockBusy, setOwnerLockBusy] = useState(() => ownerLock.isBusy());
  const [activity, setActivityState] = useState<Record<string, CardActivity>>({});
  const [removal, setRemoval] = useState<{ count: number; kept: string[]; error: string | null } | null>(null);
  const [prefill, setPrefill] = useState<{ plan: DcaPlan; nonce: number } | null>(null);
  const [vaultSupport, setVaultSupport] = useState<VaultSupport | { kind: "checking" }>({ kind: "checking" });
  const [vaultStates, setVaultStates] = useState<Record<string, VaultPlanState>>({});
  const [vaultHistory, setVaultHistory] = useState<Record<string, VaultHistoryRead>>({});
  /** The chain's latest block time as last read on its own (the form's clock; a vault's own read carries one too). */
  const [chainClock, setChainClock] = useState<ChainClock | null>(null);
  /** The connected account's vaults found on chain, by `${chainId}:${account}` (see `strayVaults`). */
  const [found, setFound] = useState<Record<string, FoundVaults>>({});
  const foundRef = useRef(found);
  foundRef.current = found;
  /** The accounts searched for on this engine: once each, and again only when asked. */
  const searched = useRef(new Set<string>());
  /**
   * The latest read started of each found vault, by a count of reads: a read
   * that finishes after a newer one started (the 30-second beat's, overtaken
   * by the one after a close) describes an earlier moment and is dropped.
   */
  const strayReads = useRef({ count: 0, latest: new Map<string, number>() });
  const drafts = vaultDrafts();
  /** Vault plans whose creation this page is sending now: shown as creating, never offered again meanwhile. */
  const creatingHere = useRef(new Map<string, { vault: Address | null; hash: `0x${string}` | null }>());
  /** What happened to a vault plan's last creation attempt, for its card, until it is retried. */
  const creationNotes = useRef(new Map<string, string>());
  const vaultStatesRef = useRef(vaultStates);
  vaultStatesRef.current = vaultStates;

  const runnerRef = useRef<DcaRunner | null>(null);
  const pendingFirstBuy = useRef<string | null>(null);
  const removalAnswer = useRef<((ok: boolean) => void) | null>(null);

  const setActivity = useCallback((key: string, patch: Partial<CardActivity>) => {
    setActivityState((previous) => ({ ...previous, [key]: { ...(previous[key] ?? EMPTY_ACTIVITY), ...patch } }));
  }, []);

  // ── The runner ──────────────────────────────────────────────────────────

  /** What a button press on the runner came to, as the card should show it. */
  const onOutcome = useCallback(
    (planId: string, outcome: BuyOutcome, slot: number | null = null) => {
      switch (outcome.kind) {
        case "bought":
          setActivity(planId, { consentBps: null, consentSlot: null, notice: null });
          return;
        case "needs-price-consent":
          setActivity(planId, { consentBps: outcome.needsPriceConsent, consentSlot: slot, notice: null });
          return;
        case "declined":
        case "skipped":
        case "failed":
        case "unknown":
          // Already in the history, and on the reason line as the last outcome.
          setActivity(planId, { consentBps: null, consentSlot: null });
          return;
        case "busy":
          setActivity(planId, {
            notice: {
              tone: "warn",
              title: "Your wallet is busy",
              text: "Waiting for your swap to finish… Confirm this buy once it's done.",
            },
          });
          return;
        case "refused":
          setActivity(planId, {
            consentBps: null,
            consentSlot: null,
            notice: {
              tone: "danger",
              title: "Not bought",
              text: outcome.codes?.length
                ? outcome.codes.map((code) => guardSentence(code)).join(" ")
                : outcome.reason,
              ...(outcome.codes?.length ? { codes: outcome.codes } : {}),
            },
          });
          return;
        case "not-due":
        case "unavailable":
          setActivity(planId, { notice: { tone: "warn", title: "This buy didn't start", text: outcome.reason } });
          return;
      }
    },
    [setActivity],
  );

  useEffect(() => {
    if (engine === null || !config.dca.enabled) {
      setSnapshot(null);
      return;
    }
    const runConfig = config;
    const runner: DcaRunner = new DcaRunner({
      engine,
      config: runConfig,
      ledger: store,
      account: () => latest.current.account,
      walletChainOk: () => latest.current.walletChainOk,
      // Scheduled buys never fall back to a public broadcast: that prompt is
      // for a person at the swap button (senders.ts). `notAfter` keeps a late
      // private signature from being posted; `onSigned` records its hash first.
      walletSender: (owner, { notAfter, onSigned }) =>
        walletSender({
          submitter: runConfig.submitter,
          account: owner,
          onPublicFallback: () => false,
          reads: engine.rpc,
          notAfter,
          onSigned,
        }),
      ownerWalletLock: ownerLock,
      onChange: (next) => {
        if (runnerRef.current === runner) {
          setSnapshot(next);
          // Countdowns are read against the clock of the render: a snapshot
          // with a fresh next-buy time shown against a clock up to one tick
          // old would read "1d 0h" for a buy exactly a day away.
          setNow(Date.now());
          return;
        }
        // A runner replaced mid-buy finishes that buy first; keep showing it.
        const buying = Object.fromEntries(Object.entries(next.plans).filter(([, state]) => state.kind === "buying"));
        setRetiring((previous) => {
          if (Object.keys(buying).length === 0 && !previous.has(runner)) return previous;
          const map = new Map(previous);
          if (Object.keys(buying).length > 0) map.set(runner, buying);
          else map.delete(runner);
          return map;
        });
      },
    });
    runnerRef.current = runner;
    runner.start();

    // The first buy of a plan just started, on the runner built from the
    // config that contains it: the Start click was its confirmation. Deferred
    // so StrictMode's discarded first mount can't take it and then be stopped.
    const handOver = setTimeout(() => {
      const planId = pendingFirstBuy.current;
      if (planId === null || runnerRef.current !== runner) return;
      const plan = runConfig.dca.plans.find((p) => p.id === planId);
      if (!plan || plan.paused) return;
      pendingFirstBuy.current = null;
      runner.confirmDue(planId).then(
        (outcome) => onOutcome(planId, outcome),
        (error: unknown) => setActivity(planId, { notice: noticeFor(error, runConfig.rpc.url, runConfig.rpc.source === "bundled") }),
      );
    }, 0);

    return () => {
      clearTimeout(handOver);
      if (runnerRef.current === runner) runnerRef.current = null;
      runner.stop();
    };
  }, [engine, config, ownerLock, store, onOutcome, setActivity]);

  // The runner asks for the account through a function, so it needn't be
  // rebuilt when the wallet connects; it only needs to look again.
  useEffect(() => {
    void runnerRef.current?.tick();
  }, [account, deps.walletChainOk]);

  // ── Subscriptions ───────────────────────────────────────────────────────

  useEffect(() => store.subscribe(() => setLedger(store.read())), [store]);

  useEffect(() => {
    setOwnerLockBusy(ownerLock.isBusy());
    return ownerLock.subscribe(() => setOwnerLockBusy(ownerLock.isBusy()));
  }, [ownerLock]);

  /**
   * Whether anything on the page needs auto-buy's reads from the network:
   * Auto-buy is on, a plan exists, or the Recurring tab is open. Without one of those, no balance, fee or price-check read is
   * made for auto-buy at all — every read goes to the user's own network
   * service, which may be a free one that rate-limits their swaps.
   */
  const active = config.dca.enabled || config.dca.plans.length > 0 || deps.recurringOpen;
  const activeRef = useRef(active);
  activeRef.current = active;
  // Vault plans are read from the chain whatever else is on: they buy whether
  // or not auto-buy is on here. Whether a vault can be offered at all is
  // read only while the Recurring tab is open or a vault plan exists.
  const vaultPlanKey = config.dca.plans
    .filter((plan) => plan.signer === "vault")
    .map((plan) => `${plan.chainId}:${plan.id}:${plan.vault ?? ""}`)
    .join(",");
  const hasVaultPlansRef = useRef(false);
  hasVaultPlansRef.current = vaultPlanKey !== "";
  const needsVaultSupport = vaultPlanKey !== "" || deps.recurringOpen;
  const needsVaultSupportRef = useRef(needsVaultSupport);
  needsVaultSupportRef.current = needsVaultSupport;
  // The connected account's vaults on chain are looked for wherever vaults
  // are offered, whether or not it has a plan here: a vault the config lost
  // is exactly one with no plan.
  const foundKey = account === null || vaultDeployment(config.chainId) === null ? null : `${config.chainId}:${account.toLowerCase()}`;
  const foundKeyRef = useRef(foundKey);
  foundKeyRef.current = foundKey;

  const refreshBalances = useCallback(async () => {
    const { engine: current, account: owner, config: cfg } = latest.current;
    if (current === null || !activeRef.current) return;
    const read = (token: string, holder: string) => balanceOf(current.rpc, token, holder).catch(() => null);
    const ownerEntries =
      owner === null
        ? []
        : await Promise.all(TOKEN_LIST.map(async (token) => [token.address, await read(token.address, owner)] as const));
    // A read begun under another engine or account describes something else.
    if (latest.current.engine !== current || latest.current.account !== owner) return;
    setOwnerBalances(Object.fromEntries(ownerEntries));
  }, []);

  const refreshFees = useCallback(async () => {
    const current = latest.current.engine;
    if (current === null || !activeRef.current) return;
    try {
      // The fees every wallet send here is asked to bid, so the cost lines say what the wallet will.
      const [read, level] = await Promise.all([readWalletFees(current.rpc), readFeeLevel(current.rpc)]);
      if (latest.current.engine === current) {
        setFees({ kind: "ok", fees: read });
        setFeeLevel(level);
      }
    } catch (error) {
      if (latest.current.engine === current) setFees({ kind: "error", message: messageOf(error) });
    }
  }, []);

  /**
   * Record a vault plan's vault in the config: the address the chain shows
   * the creation made, never one hoped for, since it can be written only
   * once. A plan removed while its vault was being created comes back with
   * it — the plan's money is in that vault, and this is the only way back to
   * it from this browser.
   */
  const recordVault = useCallback(
    (plan: DcaPlan, vault: Address): boolean => {
      const cfg = latest.current.config;
      const existing = cfg.dca.plans.find((p) => p.id === plan.id && p.chainId === plan.chainId);
      if (existing?.vault !== undefined && existing.vault.toLowerCase() === vault) {
        drafts.set(plan.chainId, plan.id, null);
        return true;
      }
      const edit = existing === undefined ? addDcaPlan(cfg, { ...plan, vault }) : updateDcaPlan(cfg, plan.id, { vault });
      if (!edit.ok) {
        setActivity(plan.id, {
          notice: {
            tone: "danger",
            title: "Vault created — not saved in your plans",
            text: `The vault is at ${vault}, and spDEX couldn't add it to this plan: ${edit.error} Keep that address.`,
          },
        });
        return false;
      }
      latest.current.applyConfig(edit.config);
      // The vault exists: a draft was only ever for creating it.
      drafts.set(plan.chainId, plan.id, null);
      creationNotes.current.delete(plan.id);
      return true;
    },
    [drafts, setActivity],
  );

  /** One vault plan, as its card should show it now. Never throws. */
  const readVaultState = useCallback(
    async (plan: DcaPlan): Promise<VaultPlanState> => {
      const { engine: current, config: cfg, account: acct } = latest.current;
      if (current === null) return { kind: "loading" };
      if (plan.vault === undefined && plan.chainId === cfg.chainId && vaultDeployment(cfg.chainId) !== null) {
        const here = creatingHere.current.get(plan.id);
        if (here !== undefined) return { kind: "creating", vault: here.vault, hash: here.hash };
        const draft = drafts.get(plan.chainId, plan.id);
        const creation = draft?.creation;
        if (draft !== null && creation !== undefined) {
          try {
            const outcome = await settleCreation(current.rpc, { plan, creation, nowMs: Date.now() });
            if (outcome.kind === "pending") return { kind: "creating", vault: creation.vault, hash: creation.hash };
            if (outcome.kind === "failed") {
              const { creation: _gone, ...rest } = draft;
              drafts.set(plan.chainId, plan.id, rest);
              creationNotes.current.set(plan.id, outcome.note);
            } else if (recordVault(plan, outcome.vault)) {
              return readVaultPlan(current.rpc, { plan: { ...plan, vault: outcome.vault }, chainId: cfg.chainId, account: acct });
            }
          } catch (error) {
            return {
              kind: "unavailable",
              code: "unreadable",
              reason: `spDEX couldn't check on this vault's creation right now (${messageOf(error)}).`,
            };
          }
        }
        return { kind: "not-created", note: creationNotes.current.get(plan.id) ?? null };
      }
      return readVaultPlan(current.rpc, { plan, chainId: cfg.chainId, account: acct });
    },
    [drafts, recordVault],
  );

  const vaultSeq = useRef(0);
  const refreshVaults = useCallback(async () => {
    const current = latest.current.engine;
    if (current === null) return;
    const plans = latest.current.config.dca.plans.filter((plan) => plan.signer === "vault");
    const seq = ++vaultSeq.current;
    const [read, clock] = await Promise.all([
      Promise.all(plans.map(async (plan) => [plan.id, await readVaultState(plan)] as const)),
      // The chain's time with them: a vault's own read carries the latest
      // block's, which an idle chain leaves behind (see `chainNowFor`).
      readChainClock(current.rpc).catch(() => null),
    ]);
    // An older read finishing late describes an earlier moment.
    if (seq !== vaultSeq.current || latest.current.engine !== current) return;
    setVaultStates(Object.fromEntries(read));
    if (clock !== null) setChainClock(clock);
  }, [readVaultState]);

  /** Whether a vault can be offered here, and the chain's clock: for the form and a vault plan waiting to be created. */
  const refreshVaultSupport = useCallback(async () => {
    const { engine: current, config: cfg } = latest.current;
    if (current === null) return;
    const [support, clockRead] = await Promise.all([
      readVaultSupport(current.rpc, cfg.chainId),
      readChainClock(current.rpc).catch(() => null),
    ]);
    if (latest.current.engine !== current) return;
    setVaultSupport(support);
    if (clockRead !== null) setChainClock(clockRead);
  }, []);

  const updateFound = useCallback((key: string, change: (entry: FoundVaults) => FoundVaults) => {
    setFound((previous) => ({ ...previous, [key]: change(previous[key] ?? NO_FOUND_VAULTS) }));
  }, []);

  /**
   * Read the account's known vaults that no plan points at: `missing`, those
   * never read; `open`, every one but those already read closed and empty,
   * which stay so on the 30-second beat; `all`, every one ("Look again", which
   * is how WETH sent to a closed vault since comes to light); or the ones
   * named. A failed read is a state that says so.
   */
  const readStrays = useCallback(
    async (key: string, which: "missing" | "open" | "all" | Address[]) => {
      const { engine: current, config: cfg, account: acct } = latest.current;
      if (current === null || acct === null || key !== `${cfg.chainId}:${acct.toLowerCase()}`) return;
      const entry = foundRef.current[key];
      if (entry === undefined) return;
      const referenced = new Set(
        cfg.dca.plans.filter((plan) => plan.chainId === cfg.chainId && plan.vault !== undefined).map((plan) => plan.vault!.toLowerCase()),
      );
      const known = entry.known;
      const targets = Array.isArray(which)
        ? which.map(lower)
        : known.filter(
            (vault) =>
              !referenced.has(vault) &&
              (which === "all" || (which === "missing" ? entry.reads[vault] === undefined : !closedAndEmpty(entry.reads[vault]))),
          );
      if (targets.length === 0) return;
      const network = networkOf(cfg);
      const count = ++strayReads.current.count;
      for (const vault of targets) strayReads.current.latest.set(vault, count);
      const reads = await Promise.all(
        targets.map((vault) => readFoundVault(current.rpc, { vault, chainId: cfg.chainId, account: acct })),
      );
      // A read from another network service describes another chain, or none;
      // one from an Engine rebuilt for another setting is as good as new.
      if (networkOf(latest.current.config) !== network) return;
      const fresh = reads.filter((read) => strayReads.current.latest.get(read.vault) === count);
      if (fresh.length === 0) return;
      updateFound(key, (e) => ({ ...e, reads: { ...e.reads, ...Object.fromEntries(fresh.map((read) => [read.vault, read])) } }));
    },
    [updateFound],
  );

  /**
   * The account's vaults the page has read, with their terms: each vault
   * plan's here, and each found one. A search counts them toward the
   * factory's count once their address proves them among it (`provenVaults`).
   * Any read will do, whichever wallet was connected for it: the proof is for
   * `acct`, from the address.
   */
  const shownVaults = (key: string, cfg: SpdexConfig, acct: Address): ShownVault[] => {
    const owner = acct.toLowerCase();
    const out: ShownVault[] = [];
    const add = (state: VaultPlanState | undefined) => {
      if (state !== undefined && (state.kind === "active" || state.kind === "someone-else") && state.owner === owner) {
        out.push({ vault: state.vault, terms: state.terms });
      }
    };
    for (const plan of cfg.dca.plans) {
      if (plan.signer === "vault" && plan.chainId === cfg.chainId) add(vaultStatesRef.current[plan.id]);
    }
    for (const read of Object.values(foundRef.current[key]?.reads ?? {})) add(read.state);
    return out;
  };

  /**
   * Search the chain for the connected account's vaults (`searchAccountVaults`),
   * handing it the ones the page already shows, so that a plan's vault never
   * counts as missing and a search the plans cover reads no log. The vaults it
   * finds are read by the effect that follows what is known, so that the read
   * sees this result rather than the one before it.
   *
   * `again` is the person's "Look again": it reads every known vault again too,
   * and starts the retries afresh. A search that fails, or reads nothing while
   * vaults are missing, is tried again by itself (`vaultSearchRetryAt`).
   */
  const lookForVaults = useCallback(
    async (reason: "first" | "again" | "retry") => {
      const { engine: current, config: cfg, account: acct } = latest.current;
      if (current === null || acct === null || vaultDeployment(cfg.chainId) === null) return;
      const key = `${cfg.chainId}:${acct.toLowerCase()}`;
      const network = networkOf(cfg);
      searched.current.add(key);
      if (reason === "again") void readStrays(key, "all");
      const shown = shownVaults(key, cfg, acct);
      updateFound(key, (entry) => ({
        ...entry,
        search: { kind: "searching" },
        retryAt: null,
        ...(reason === "again" ? { failures: 0 } : {}),
      }));
      try {
        let result: OwnerVaults | null = await searchAccountVaults(current.rpc, {
          chainId: cfg.chainId,
          account: acct,
          known: shown,
        });
        // A network service that caps log searches stops the log search
        // short. The factories' own lists reach every vault on any service
        // that answers `eth_call`, reading each listed vault's owner instead
        // (lib/dca/factoryListSearch.ts). Its failure leaves the log search's
        // answer, whose note says what is missing.
        if (result !== null && !result.complete) {
          const listed = await searchVaultsFromFactoryList(current.rpc, acct, {
            cache: vaultIdentities(current.rpc, cfg.chainId),
          }).catch(() => null);
          if (listed !== null) result = withListSearch(result, listed);
        }
        if (networkOf(latest.current.config) !== network) return;
        const now = Date.now();
        updateFound(key, (entry) => {
          if (result === null) return { ...entry, search: { kind: "done" }, last: null, failures: 0, retryAt: null, checkedAt: now };
          const last = mergeVaultSearches(entry.last, result);
          const proven = provenVaults({ shown, counts: factoryCountsOf(result), account: acct });
          const accounted = withKnown(entry.accounted, [...last.vaults, ...proven]);
          const failures = vaultSearchFailed(last, accounted.length) ? entry.failures + 1 : 0;
          return {
            ...entry,
            search: { kind: "done" },
            last,
            // A plan's vault proved here is known too: if its plan goes, it
            // is listed rather than lost.
            known: withKnown(entry.known, [...last.vaults, ...proven]),
            accounted,
            failures,
            retryAt: failures === 0 ? null : vaultSearchRetryAt(failures, now),
            checkedAt: now,
          };
        });
      } catch (error) {
        if (networkOf(latest.current.config) !== network) return;
        const now = Date.now();
        updateFound(key, (entry) => ({
          ...entry,
          search: { kind: "error", message: messageOf(error) },
          failures: entry.failures + 1,
          retryAt: vaultSearchRetryAt(entry.failures + 1, now),
          checkedAt: now,
        }));
      }
    },
    [updateFound, readStrays],
  );

  const addFoundVaults = useCallback(
    (result: OwnerVaults) => {
      const { config: cfg, account: acct } = latest.current;
      if (acct === null || vaultDeployment(cfg.chainId) === null) return;
      const key = `${cfg.chainId}:${acct.toLowerCase()}`;
      updateFound(key, (entry) => {
        // The factory's own count for the owner, when a log search read it,
        // stays the figure missing vaults are counted against.
        const last = entry.last === null ? result : withListSearch(entry.last, result);
        return { ...entry, last, known: withKnown(entry.known, last.vaults), accounted: withKnown(entry.accounted, result.vaults) };
      });
    },
    [updateFound],
  );

  // Everything read from the network is read again for a new engine: a new
  // engine is a new network service, or new settings for the same one. The
  // first read waits until something needs it.
  useEffect(() => {
    if (engine === null) return;
    setFees({ kind: "reading" });
    setPriceCheck({});
  }, [engine]);

  // What was read about vaults describes the chain, as that network service
  // told it, so it goes only when either changes (`networkOf`): not when the
  // Engine is rebuilt for another setting.
  const networkKey = networkOf(config);
  useEffect(() => {
    setVaultSupport({ kind: "checking" });
    setVaultStates({});
    setVaultHistory({});
    setChainClock(null);
    setFound({});
    searched.current.clear();
  }, [networkKey]);

  // The connected account's vaults, looked for once per account on each
  // network service (after the reset above, which runs first when the service
  // is new), and once its vault plans here have been read: those count as
  // shown, and when they are every vault the account has, no log is read.
  const vaultPlansRead = config.dca.plans.every((plan) => {
    if (plan.signer !== "vault" || plan.vault === undefined || plan.chainId !== config.chainId) return true;
    const state = vaultStates[plan.id];
    return state !== undefined && state.kind !== "loading";
  });
  useEffect(() => {
    if (engine === null || foundKey === null || !vaultPlansRead || searched.current.has(foundKey)) return;
    void lookForVaults("first");
  }, [engine, foundKey, vaultPlansRead, lookForVaults]);

  // What is known changed — a search finished, a plan was deleted here, a plan
  // was added back — so read any vault no plan points at that hasn't been.
  const foundHere = foundKey === null ? undefined : found[foundKey];
  const knownKey = foundHere === undefined ? "" : foundHere.known.join(",");
  const referencedKey = config.dca.plans.map((plan) => plan.vault ?? "").join(",");
  useEffect(() => {
    if (engine === null || foundKey === null || knownKey === "") return;
    void readStrays(foundKey, "missing");
  }, [engine, foundKey, knownKey, referencedKey, readStrays]);

  // A vault on the page read since the last search — a plan's vault whose
  // read came in, one carried over from a deleted card, a found one read —
  // counts toward the search's count once its address proves it one of them.
  const shownKey =
    foundKey === null
      ? ""
      : [
          ...config.dca.plans.map((plan) => {
            const state = vaultStates[plan.id];
            return state !== undefined && (state.kind === "active" || state.kind === "someone-else") ? state.vault : "";
          }),
          ...Object.values(foundHere?.reads ?? {}).map((read) => `${read.vault}:${read.state.kind}`),
        ].join(",");
  const searchedCount = foundHere?.last?.expected.toString() ?? "";
  useEffect(() => {
    const acct = latest.current.account;
    if (engine === null || foundKey === null || acct === null || searchedCount === "") return;
    const entry = foundRef.current[foundKey];
    if (entry === undefined || entry.last === null) return;
    const proven = provenVaults({
      shown: shownVaults(foundKey, latest.current.config, acct),
      counts: factoryCountsOf(entry.last),
      account: acct,
    }).filter((vault) => !entry.accounted.includes(vault));
    if (proven.length === 0) return;
    updateFound(foundKey, (e) => ({ ...e, accounted: withKnown(e.accounted, proven), known: withKnown(e.known, proven) }));
    // shownVaults reads the latest states through refs; shownKey is what says they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, foundKey, shownKey, searchedCount, updateFound]);
  useEffect(() => {
    if (engine !== null && active) void refreshFees();
  }, [engine, active, refreshFees]);

  // Another wallet or another network service: the old figures describe
  // something else, so they go before the new ones are read.
  useEffect(() => {
    setOwnerBalances({});
    void refreshBalances();
  }, [engine, account, active, refreshBalances]);

  // A buy settling changes what the owner holds.
  useEffect(() => {
    void refreshBalances();
  }, [ledger, refreshBalances]);

  // One clock for every countdown, read from the wall each time (never by
  // counting ticks, which a throttled background tab would drift). The slower
  // reads ride on it — balances every 30 s, fees every minute — and only
  // while something needs them (`active`).
  useEffect(() => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      setNow(Date.now());
      if (ticks % 2 === 0) {
        void refreshBalances();
        if (hasVaultPlansRef.current) void refreshVaults();
        const key = foundKeyRef.current;
        if (key !== null && hasStraysRef.current) void readStrays(key, "open");
      }
      // A search that failed or read nothing, tried again when its time comes.
      const searchKey = foundKeyRef.current;
      const search = searchKey === null ? undefined : foundRef.current[searchKey];
      if (search !== undefined && search.retryAt !== null && search.search.kind !== "searching" && Date.now() >= search.retryAt) {
        void lookForVaults("retry");
      }
      if (ticks % 4 === 0) void refreshFees();
      if (ticks % 8 === 0 && needsVaultSupportRef.current) void refreshVaultSupport();
    }, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshBalances, refreshFees, refreshVaults, refreshVaultSupport, readStrays, lookForVaults]);

  // Vault plans are read from the chain: on a new engine, account or plan
  // list, then every 30 s with the balances. Whether a vault can be offered
  // at all is read while the Recurring tab is open or a vault plan exists,
  // then every two minutes.
  useEffect(() => {
    if (engine === null) return;
    if (vaultPlanKey === "") {
      setVaultStates({});
      return;
    }
    void refreshVaults();
  }, [engine, account, vaultPlanKey, refreshVaults]);
  useEffect(() => {
    if (engine !== null && needsVaultSupport) void refreshVaultSupport();
  }, [engine, needsVaultSupport, refreshVaultSupport]);

  // Whether the Guard's price cross-check can see each plan's pair, once per
  // plan per engine: a fact for Plan details, never a gate.
  useEffect(() => {
    if (engine === null) return;
    for (const plan of config.dca.plans) {
      if (plan.id in priceCheck) continue;
      setPriceCheck((previous) => ({ ...previous, [plan.id]: "checking" }));
      void engine.priceCheckAvailable(plan.sell, plan.buy).then((available) => {
        if (latest.current.engine === engine) setPriceCheck((previous) => ({ ...previous, [plan.id]: available }));
      });
    }
  }, [engine, config.dca.plans, priceCheck]);

  // ── Derived state ───────────────────────────────────────────────────────

  const merged = useMemo<RunnerSnapshot | null>(() => {
    if (snapshot === null || retiring.size === 0) return snapshot;
    const plans = { ...snapshot.plans };
    for (const buying of retiring.values()) Object.assign(plans, buying);
    return { ...snapshot, plans };
  }, [snapshot, retiring]);
  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  const entryFor = useCallback(
    (plan: Pick<DcaPlan, "id" | "chainId">): DcaLedgerEntry | null | "unavailable" =>
      ledger === "unavailable" ? "unavailable" : (entryOf(ledger, refOf(plan)) ?? null),
    [ledger],
  );

  /**
   * Chain time now for a vault plan's figures, carried forward: the later of
   * its own read's clock (the latest block's time, which the vault's figures
   * were judged at) and the chain's as last read on its own (the pending
   * block's, `readChainClock`). On an idle chain the latest block runs behind
   * by however long it has been idle, and a countdown from it overstated the
   * wait by that much; a vault due by the pending time and not yet by the
   * latest block says so in its line ("once the network's next block shows
   * it").
   */
  const chainNowOf = useCallback(
    (state: VaultPlanState | undefined): number | null => {
      const own = state !== undefined && "clock" in state && state.clock !== null ? carryClock(state.clock, now) : null;
      const chain = chainClock === null ? null : carryClock(chainClock, now);
      if (own === null) return chain;
      return chain === null ? own : Math.max(own, chain);
    },
    [chainClock, now],
  );
  const chainNowFor = useCallback(
    (planId?: string): number | null => chainNowOf(planId === undefined ? undefined : vaultStates[planId]),
    [vaultStates, chainNowOf],
  );

  const vaultStatuses = useMemo(() => {
    const out: Record<string, VaultCardStatus> = {};
    for (const plan of config.dca.plans) {
      if (plan.signer !== "vault") continue;
      out[plan.id] = vaultCardStatus(vaultStates[plan.id] ?? { kind: "loading" }, chainNowFor(plan.id));
    }
    return out;
  }, [config.dca.plans, vaultStates, chainNowFor]);

  const statuses = useMemo(() => {
    const out: Record<string, CardStatus> = {};
    for (const plan of config.dca.plans) {
      // A vault plan's card is its vault's: the runner reports it paused, since this tab never runs it.
      const vaultStatus = vaultStatuses[plan.id];
      if (vaultStatus !== undefined) {
        out[plan.id] = vaultStatus;
        continue;
      }
      out[plan.id] = cardStatus({
        plan,
        config,
        entry: entryFor(plan),
        state: merged?.plans[plan.id],
        account,
        safety,
        nowMs: now,
      });
    }
    return out;
  }, [config, entryFor, merged, account, safety, now, vaultStatuses]);

  // One card a plan, for the strip and the ticker alike, so the two never
  // disagree about the next buy.
  const stripCards = useMemo(
    (): StripCard[] =>
      // A vault plan not read yet says nothing: "all paused" for the moment
      // it takes to read would be a claim about a vault that is buying.
      config.dca.plans
        .filter((plan) => vaultStatuses[plan.id]?.vault !== "loading")
        .map((plan) => {
          const status = statuses[plan.id]!;
          const state = merged?.plans[plan.id];
          const vault = vaultStatuses[plan.id];
          if (vault !== undefined) {
            // The strip counts down by this device's clock, the vault by the
            // chain's: carry the gap over rather than the chain's time. A
            // buy already due has nothing to count down to — it waits for
            // whoever triggers it, which "next in < 1m" said wrongly for as
            // long as nobody came.
            const chainSeconds = chainNowFor(plan.id);
            const waiting =
              vault.pill === "running" &&
              (vault.vault === "due" ||
                vault.vault === "waiting-price" ||
                (vault.nextBuyAt !== null && chainSeconds !== null && vault.nextBuyAt <= chainSeconds));
            const nextAt =
              vault.pill === "running" && !waiting && vault.nextBuyAt !== null && chainSeconds !== null
                ? Math.floor(now / 1000) + (vault.nextBuyAt - chainSeconds)
                : null;
            return { pill: vault.pill, due: false, nextAt, keeper: waiting };
          }
          return {
            pill: status.pill,
            due: status.row === "due",
            nextAt: status.pill === "running" && state?.kind === "waiting" ? state.nextAt : null,
          };
        }),
    [config.dca.plans, statuses, merged, now, vaultStatuses, chainNowFor],
  );
  const strip = useMemo(() => stripSummary(stripCards, now), [stripCards, now]);
  const nextBuyAt = useMemo(
    () => soonestNextBuy(stripCards.map((card) => ({ running: card.pill === "running", nextAt: card.nextAt }))),
    [stripCards],
  );

  const buyDue = config.dca.plans.some((plan) => statuses[plan.id]?.row === "due");

  const strayVaults = useMemo((): StrayVaultsView | null => {
    if (foundHere === undefined) return null;
    const { listed, closed } = strayVaultList({
      known: foundHere.known,
      reads: foundHere.reads,
      plans: config.dca.plans,
      chainId: config.chainId,
      inHand: (vault) => {
        const card = activity[strayVaultKey(vault)];
        return card !== undefined && (card.busy !== null || card.notice !== null);
      },
    });
    const last = foundHere.last;
    const note = last === null ? null : vaultSearchNote(last, foundHere.accounted.length);
    return {
      searching: foundHere.search.kind === "searching",
      error: foundHere.search.kind === "error" ? foundHere.search.message : null,
      retrying: foundHere.retryAt !== null,
      note,
      checked:
        last !== null && note === null && foundHere.search.kind === "done" && foundHere.checkedAt !== null
          ? { at: foundHere.checkedAt, expected: Number(last.expected) }
          : null,
      listed: listed.map((vault) => ({ ...vault, status: vaultCardStatus(vault.state, chainNowOf(vault.state)) })),
      closed,
      closedHere: closed.some((found) => foundHere.closedHere.includes(found.vault)),
    };
  }, [foundHere, config.dca.plans, config.chainId, chainNowOf, activity]);
  const hasStraysRef = useRef(false);
  hasStraysRef.current = (strayVaults?.listed.length ?? 0) > 0;

  // Vaults on chain no plan points at bring the panel up, plan or no plan:
  // they hold money and buy. So does a search
  // that couldn't find every vault the factory counts, since those exist too,
  // and a vault closed from its card here, whose line moves to "Closed
  // vaults" once read rather than vanishing with the panel. A search that
  // failed outright doesn't while it is being retried: it says nothing about
  // whether any vault exists, and most accounts have none. Once the retries
  // are spent it does, since "couldn't look" and "none" would otherwise look
  // the same for the rest of the visit.
  const hasPanel =
    config.dca.plans.length > 0 ||
    (strayVaults !== null &&
      (strayVaults.listed.length > 0 ||
        strayVaults.note !== null ||
        strayVaults.closedHere ||
        (strayVaults.error !== null && !strayVaults.retrying)));
  const lease = merged?.lease ?? (merged === null ? leaseWithoutRunner() : null);

  // Closing the tab mid-buy could leave a transaction nobody is watching for;
  // ask first, but only then. A buy is seconds; a question held
  // open any longer would stand in the way of every reload.
  const inFlight = Object.values(merged?.plans ?? {}).some((state) => state.kind === "buying");
  useEffect(() => {
    if (!inFlight) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [inFlight]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const fail = useCallback(
    (key: string, error: unknown) => {
      setActivity(key, { busy: null, notice: noticeFor(error, latest.current.config.rpc.url, latest.current.config.rpc.source === "bundled") });
    },
    [setActivity],
  );

  const planById = (planId: string): DcaPlan | undefined =>
    latest.current.config.dca.plans.find((plan) => plan.id === planId);

  const readEntry = (plan: Pick<DcaPlan, "id" | "chainId">): DcaLedgerEntry | undefined => {
    const read = store.read();
    return read === "unavailable" ? undefined : entryOf(read, refOf(plan));
  };

  /**
   * A plan's record where an unreadable ledger must stop the action rather
   * than read as "no record": resuming would move a start time that buys were
   * already counted from, and bind a record that may already be bound.
   */
  const readEntryOrRefuse = (plan: Pick<DcaPlan, "id" | "chainId">): DcaLedgerEntry | undefined => {
    const read = store.read();
    if (read === "unavailable") throw new LedgerUnavailableError();
    return entryOf(read, refOf(plan));
  };

  /** Refuse a send from the owner's wallet while it is on another chain than the plan's. */
  const requireWalletChain = () => {
    const { walletChainOk, config: cfg } = latest.current;
    // The wallet sends on whatever chain it is on; the Guard checked the
    // transaction for the plan's. Sent on the wrong one, it does something
    // nobody checked.
    if (!walletChainOk) throw new Error(`Switch your wallet to ${networkLabel(cfg.chainId)} first. Nothing was sent.`);
  };

  /** Apply a config edit that must succeed, or throw its reason. */
  const apply = (edit: { ok: true; config: SpdexConfig } | { ok: false; error: string }): SpdexConfig => {
    if (!edit.ok) throw new Error(edit.error);
    latest.current.applyConfig(edit.config);
    return edit.config;
  };

  const startPlan = useCallback(
    async (input: NewPlanInput): Promise<{ ok: true } | { ok: false; error: string }> => {
      const { config: current, account: owner } = latest.current;
      if (owner === null) return { ok: false, error: "Connect your wallet first." };
      const { plan } = input;
      const ref = refOf(plan);
      const couldntSave = (error: string) => ({ ok: false as const, error: `spDEX couldn't save this plan: ${error.replace(/\.$/, "")}.` });
      try {
        if (input.signer === "wallet") {
          // The record first, so the runner never sees the plan without it.
          await store.updateShared((l) => startEntry(l, { ...ref, owner, signer: owner, at: Date.now() }));
          const added = addDcaPlan(current, plan);
          if (!added.ok) {
            await store.updateShared((l) => removeEntry(l, ref)).catch(() => undefined);
            return couldntSave(added.error);
          }
          if (input.firstBuyNow) pendingFirstBuy.current = plan.id;
          latest.current.applyConfig(added.config);
          return { ok: true };
        }

        return await startVaultPlan(plan, input.vault);
      } catch (error) {
        if (error instanceof LedgerBusyError) return { ok: false, error: LEDGER_BUSY_TEXT };
        return couldntSave(messageOf(error));
      }
    },
    [store],
  );

  const onRunner = useCallback(
    async (planId: string, act: (runner: DcaRunner) => Promise<BuyOutcome>) => {
      const runner = runnerRef.current;
      if (runner === null) {
        setActivity(planId, {
          notice: { tone: "warn", title: "Auto-buy isn't running", text: "Switch Auto-buy on to make this buy." },
        });
        return;
      }
      // The buy time this press was about, for a price warning it comes back with.
      const state = mergedRef.current?.plans[planId];
      const slot = state?.kind === "due" ? state.slot : null;
      setActivity(planId, { notice: null });
      try {
        onOutcome(planId, await act(runner), slot);
      } catch (error) {
        fail(planId, error);
      }
    },
    [onOutcome, fail, setActivity],
  );

  const activityRef = useRef(activity);
  activityRef.current = activity;
  const confirmDue = useCallback(
    (planId: string) =>
      onRunner(planId, (runner) => {
        const consent = consentFor(activityRef.current[planId], mergedRef.current?.plans[planId]);
        return runner.confirmDue(planId, consent === null ? {} : { acceptDivergenceBps: consent });
      }),
    [onRunner],
  );
  const skipDue = useCallback((planId: string) => onRunner(planId, (runner) => runner.skipDue(planId)), [onRunner]);

  const pause = useCallback(
    (planId: string) => {
      try {
        apply(updateDcaPlan(latest.current.config, planId, { paused: true }));
        setActivity(planId, { notice: null, consentBps: null, consentSlot: null });
      } catch (error) {
        fail(planId, error);
      }
    },
    [fail, setActivity],
  );

  const enableAutoBuy = useCallback(() => {
    latest.current.applyConfig(setFeature(latest.current.config, DCA_FEATURE_ID, true));
  }, []);

  /**
   * Unpause a plan. Its first buy time moves to now only while none has been
   * used (`canMoveStart`): windows are numbered from `startAt`, and moving it
   * after a buy would renumber what the record says was bought. Switching
   * Auto-buy back on for it leaves every other plan paused, as adding a plan
   * does: one Resume must not restart plans the switch had stopped.
   *
   * A plan that was an autopilot plan has its record bound to its owner
   * first (`bindToOwner`): the record names its old spending wallet, and the
   * Guard would refuse every buy its owner confirms until it names the owner.
   * Everything the record counted stays, so it goes on from where it stopped.
   */
  const unpause = async (plan: DcaPlan) => {
    const current = latest.current.config;
    const entry = readEntryOrRefuse(plan);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const patch: DcaPlanPatch = { paused: false };
    if (canMoveStart(entry) && plan.startAt <= nowSeconds) patch.startAt = nowSeconds;
    if (entry !== undefined && entry.signer !== entry.owner) await store.updateShared((l) => bindToOwner(l, refOf(plan)));
    if (entry?.halted !== undefined) await store.updateShared((l) => resume(l, refOf(plan)));
    let next = current;
    if (!next.dca.enabled) {
      next = setFeature(
        { ...next, dca: { ...next.dca, plans: next.dca.plans.map((p) => (p.id === plan.id ? p : { ...p, paused: true })) } },
        DCA_FEATURE_ID,
        true,
      );
    }
    const updated = updateDcaPlan(next, plan.id, patch);
    if (!updated.ok) throw new Error(updated.error);
    latest.current.applyConfig(updated.config);
  };

  /** The owner's wallet as a sender for a transaction a person just asked for. */
  const ownerSender = (owner: `0x${string}`) => {
    const { engine: current, config: cfg } = latest.current;
    return walletSender({ submitter: cfg.submitter, account: owner, onPublicFallback: () => false, reads: current!.rpc });
  };

  const resumePlan = useCallback(
    async (planId: string) => {
      const plan = planById(planId);
      if (!plan) return;
      const { account: owner } = latest.current;
      setActivity(planId, { busy: "Resuming…", notice: null });
      try {
        const entry = readEntryOrRefuse(plan);
        if (entry === undefined) {
          // No record here: an imported plan, or one started elsewhere. It is
          // bound to the wallet connected now, which is where it will deliver.
          if (owner === null) throw new Error("Connect your wallet first.");
          await store.updateShared((l) => startEntry(l, { ...refOf(plan), owner, signer: owner, at: Date.now() }));
        }
        await unpause(plan);
        setActivity(planId, { busy: null, notice: null, consentBps: null, consentSlot: null });
      } catch (error) {
        fail(planId, error);
      } finally {
        setActivity(planId, { busy: null });
      }
    },
    [fail, setActivity],
  );

  /** Keep a deleted vault plan's vault in sight, among those no plan points at (`foundFromPlan`). */
  const adoptVault = (plan: DcaPlan) => {
    const key = foundKeyRef.current;
    const acct = latest.current.account;
    if (key === null || acct === null || plan.chainId !== latest.current.config.chainId) return;
    const carried = foundFromPlan(plan, vaultStatesRef.current[plan.id], acct);
    if (carried === null) return;
    updateFound(key, (entry) => ({
      ...entry,
      known: withKnown(entry.known, [carried.vault]),
      reads: { ...entry.reads, [carried.vault]: carried },
    }));
  };

  /**
   * Delete a plan: the config entry, then this browser's record. The buys
   * that record holds are kept first, with the swaps and tips
   * (records/store.ts `keepPlanBuys`), so Your activity, its CSV and
   * statement, and Your stack still list them; if they can't be kept, the
   * record stays, and Your activity says it has buys of a plan no longer in
   * the settings. An old spending wallet filed under its id is not touched:
   * it stays listed, with whatever is in it, until it is withdrawn.
   */
  const deletePlan = useCallback(
    async (planId: string): Promise<boolean> => {
      const plan = planById(planId);
      if (!plan) return false;
      try {
        apply(removeDcaPlan(latest.current.config, planId));
        // A vault plan's draft goes with it, unless a creation is recorded
        // there: that is the one way back to a vault still being made.
        if (plan.signer === "vault" && drafts.get(plan.chainId, plan.id)?.creation === undefined) drafts.set(plan.chainId, plan.id, null);
        // Its vault is still on chain, holding what it held. If it is the
        // connected account's, it joins the vaults no plan points at now,
        // from its last read, rather than after a search.
        if (plan.signer === "vault") adoptVault(plan);
        const read = store.read();
        const entry = read === "unavailable" ? undefined : entryOf(read, refOf(plan));
        const kept = entry === undefined ? true : await keepPlanBuys(plan, entry);
        if (kept) await store.updateShared((l) => removeEntry(l, refOf(plan))).catch(() => undefined);
        setActivityState((previous) => {
          const { [planId]: _gone, ...rest } = previous;
          return rest;
        });
        return true;
      } catch (error) {
        fail(planId, error);
        return false;
      }
    },
    [store, fail, updateFound],
  );

  /**
   * "Set up again" on a plan whose record can't be read. The old plan is
   * paused first: the record may only be unreadable for a moment (a write
   * that failed once), and if it comes back, the old plan and its
   * replacement would both buy.
   */
  const recreate = useCallback(
    (planId: string) => {
      const plan = planById(planId);
      if (!plan) return;
      try {
        if (!plan.paused) apply(updateDcaPlan(latest.current.config, planId, { paused: true }));
      } catch (error) {
        fail(planId, error);
        return;
      }
      setPrefill((previous) => ({ plan, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [fail],
  );

  // ── Vault plans ─────────────────────────────────────────────────────────

  /** The deps every vault transaction takes: the engine, the owner's wallet, and the card's status line. */
  const vaultDeps = (key: string, onAsked?: () => void): VaultOpDeps => {
    const { engine: current, account: owner, config: cfg } = latest.current;
    if (current === null) throw new Error("Choose a network service first.");
    if (owner === null) throw new Error("Connect your wallet first.");
    requireWalletChain();
    return {
      engine: current,
      sender: ownerSender(owner),
      chainId: cfg.chainId,
      onStep: (step: VaultStep) => {
        if (step.phase === "send") onAsked?.();
        setActivity(key, { busy: step.label });
      },
    };
  };

  /**
   * Create a vault plan's vault, funded with `fund` wei, from the owner's
   * wallet, and record it in the plan. Where it will land is written down
   * before anything is sent (`VaultDrafts`), so a tab closed mid-creation
   * finds it afterwards rather than offering a second vault; a creation that
   * provably sent nothing — refused, declined, failed before the wallet was
   * asked — is forgotten at once.
   */
  const runCreate = async (plan: DcaPlan, choices: VaultChoices, fund: bigint) => {
    const key = plan.id;
    creationNotes.current.delete(plan.id);
    let asked = false;
    const deps = vaultDeps(key, () => {
      asked = true;
    });
    const owner = lower(deps.sender.account);
    if (!ownerLock.tryAcquire()) throw new Error("Waiting for your swap to finish… Try again when it's done.");
    const base = {
      maxSlippageBps: choices.maxSlippageBps,
      keeperReward: choices.keeperReward.toString(),
      communityWindow: choices.communityWindow,
      fund: fund.toString(),
    };
    // Where it is sent: a creation is read back from this factory's receipt.
    const factory = lower(deps.engine.vaultFactory);
    const here: { vault: Address | null; hash: `0x${string}` | null } = { vault: null, hash: null };
    creatingHere.current.set(plan.id, here);
    try {
      const created = await createVaultOnChain(
        {
          ...deps,
          onPrepared: ({ vault, nonce }) => {
            here.vault = vault;
            drafts.set(plan.chainId, plan.id, {
              ...base,
              creation: { owner, vault, factory, nonce: nonce.toString(), hash: null, at: Date.now() },
            });
            setVaultStates((previous) => ({ ...previous, [plan.id]: { kind: "creating", vault, hash: null } }));
          },
          onSent: (hash) => {
            here.hash = hash;
            const draft = drafts.get(plan.chainId, plan.id);
            if (draft?.creation !== undefined) drafts.set(plan.chainId, plan.id, { ...draft, creation: { ...draft.creation, hash } });
          },
        },
        { plan, choices, fund },
      );
      if (created.vault === null) {
        // Confirmed, and the receipt didn't say where the vault is. The
        // creation stays recorded, with its hash, and the next read settles
        // it from the chain (`settleCreation`) rather than from a guess.
        setActivity(key, {
          busy: null,
          notice: {
            tone: "ok",
            title: "Vault created",
            text: "The network confirmed it. spDEX is reading where the vault landed; its card updates in a moment.",
          },
        });
        return;
      }
      // A vault the config couldn't take has already said so, with its address.
      if (!recordVault(plan, created.vault)) return;
      setActivity(key, {
        busy: null,
        notice: {
          tone: "ok",
          title: "Vault created",
          text:
            fund > 0n
              ? `Created and funded with ${roughAmount(fund, NATIVE_TOKEN)}. Its buys are made whenever anyone triggers a due one — whether or not spDEX is open.`
              : "Created. Fund it to start its buys.",
        },
      });
    } catch (error) {
      if (!asked || isUserRejection(error) || error instanceof VaultTxRefused) drafts.set(plan.chainId, plan.id, base);
      throw error;
    } finally {
      creatingHere.current.delete(plan.id);
      ownerLock.release();
      void refreshVaults();
    }
  };

  /**
   * Start a vault plan: the plan goes into the config first — paused, as a
   * vault plan always is, with its start in chain time — and then its vault
   * is created and funded in one confirmation, as a wallet plan's first buy
   * follows its Start. A creation that doesn't happen leaves the plan waiting
   * on its card to be created (`createVault`) or deleted.
   */
  const startVaultPlan = async (
    plan: DcaPlan,
    options: NewPlanInput["vault"],
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { engine: current, config: cfg, walletChainOk } = latest.current;
    if (current === null) return { ok: false, error: "Choose a network service first." };
    // What would stop the creation is said before the plan is saved, so a
    // Start that can't go ahead leaves nothing behind.
    if (!walletChainOk) return { ok: false, error: `Switch your wallet to ${networkLabel(cfg.chainId)} first.` };
    if (ownerLock.isBusy()) return { ok: false, error: "Waiting for your swap to finish… Try again when it's done." };
    const support = await readVaultSupport(current.rpc, cfg.chainId);
    setVaultSupport(support);
    if (support.kind !== "available") return { ok: false, error: support.reason };
    const clock = await readChainClock(current.rpc);
    setChainClock(clock);
    // The window the form showed, else the plan's default: the same figure
    // for a Simple plan, since it depends on the interval alone.
    const communityWindow = options?.communityWindow ?? defaultVaultWindow(plan.intervalSeconds);
    if (communityWindow === null) return { ok: false, error: "The plan's interval isn't a whole number of seconds." };
    const startAt = vaultStartAt(plan.startAt, Math.floor(Date.now() / 1000), clock.seconds, communityWindow);
    const vaultPlan: DcaPlan = { ...plan, paused: true, signer: "vault", startAt };
    delete (vaultPlan as { vault?: string }).vault;
    const maxSlippageBps = options?.maxSlippageBps ?? DEFAULT_VAULT_SLIPPAGE_BPS;
    const amountPerBuy = BigInt(plan.amountPerBuy);
    if (amountPerBuy <= 0n) return { ok: false, error: "Enter an amount greater than zero." };
    // The buy fee the form showed, else this release's for the amount: the
    // two are the same figure, since it depends on nothing else.
    const keeperReward = options?.keeperReward ?? buyFee(amountPerBuy).reward;
    const choices: VaultChoices = { maxSlippageBps, keeperReward, communityWindow };
    const problem = vaultPlanProblems(vaultPlan, choices, clock.seconds)[0];
    if (problem !== undefined) return { ok: false, error: problem };
    const fund = options?.fund ?? BigInt(plan.maxBuys) * (amountPerBuy + keeperReward);
    const added = addDcaPlan(latest.current.config, vaultPlan);
    if (!added.ok) return { ok: false, error: `spDEX couldn't save this plan: ${added.error.replace(/\.$/, "")}.` };
    drafts.set(vaultPlan.chainId, vaultPlan.id, {
      maxSlippageBps,
      keeperReward: keeperReward.toString(),
      communityWindow,
      fund: fund.toString(),
    });
    latest.current.applyConfig(added.config);
    setActivity(vaultPlan.id, { busy: "Getting ready…", notice: null });
    void runCreate(vaultPlan, choices, fund)
      .catch((error: unknown) => fail(vaultPlan.id, error))
      .finally(() => setActivity(vaultPlan.id, { busy: null }));
    return { ok: true };
  };

  const createVault = useCallback(
    async (planId: string, options: { maxSlippageBps?: number; keeperReward?: bigint; communityWindow?: number; fund?: bigint } = {}) => {
      const plan = planById(planId);
      if (!plan || plan.signer !== "vault") return;
      setActivity(planId, { busy: "Getting ready…", notice: null });
      try {
        if (plan.vault !== undefined) throw new Error("This plan already has its vault.");
        if (creatingHere.current.has(planId) || vaultStatesRef.current[planId]?.kind === "creating") {
          throw new Error("This plan's vault is already being created. Wait for it to confirm.");
        }
        const current = latest.current.engine;
        if (current === null) throw new Error("Choose a network service first.");
        const clock = await readChainClock(current.rpc);
        setChainClock(clock);
        // The terms the card showed, passed through as the form passes its
        // own; anything the card left out is worked out the way the card
        // works it out (`vaultRetryTerms`), never defaulted silently: the
        // allowance and the buy fee are fixed in the vault for good.
        const retry = vaultRetryTerms({ plan, draft: drafts.get(plan.chainId, plan.id), chosen: options.maxSlippageBps ?? null });
        const maxSlippageBps = retry.maxSlippageBps;
        if (maxSlippageBps === null) throw new Error("Choose a price allowance for the vault first.");
        const keeperReward = options.keeperReward ?? retry.keeperReward;
        if (keeperReward === null) throw new Error("spDEX couldn't work out this plan's buy fee. Try again in a moment.");
        const communityWindow = options.communityWindow ?? retry.communityWindow;
        if (communityWindow === null) throw new Error("spDEX couldn't work out this plan's community window.");
        // A start already past moves to now: the first buy is then due at
        // creation, as it would have been, and a retry days later isn't held
        // to a start the factory might refuse as too far back. "Now" is held
        // back as Start holds it (`vaultStartLead`), so the first buy keeps its
        // community window when the creation is slow to land.
        let toCreate = plan;
        const earliest = clock.seconds + vaultStartLead(communityWindow);
        if (plan.startAt < earliest) {
          const moved = updateDcaPlan(latest.current.config, plan.id, { startAt: earliest });
          if (!moved.ok) throw new Error(moved.error);
          latest.current.applyConfig(moved.config);
          toCreate = { ...plan, startAt: earliest };
        }
        const choices: VaultChoices = { maxSlippageBps, keeperReward, communityWindow };
        const problem = vaultPlanProblems(toCreate, choices, clock.seconds)[0];
        if (problem !== undefined) throw new Error(problem);
        const fund = options.fund ?? BigInt(plan.maxBuys) * (BigInt(plan.amountPerBuy) + keeperReward);
        await runCreate(toCreate, choices, fund);
      } catch (error) {
        fail(planId, error);
      } finally {
        setActivity(planId, { busy: null });
      }
    },
    // runCreate and the rest read through `latest` and the page-wide stores.
    [fail, setActivity, drafts],
  );

  /**
   * One vault transaction: the owner's lock around it, the card's line
   * (activity `key`) through it, and `after` once it is over, however it
   * ended, for the re-read.
   */
  const runVault = async <T,>(
    key: string,
    plan: DcaPlan,
    send: (deps: VaultOpDeps, plan: DcaPlan) => Promise<T>,
    done: (result: T, plan: DcaPlan) => Notice,
    after: () => void,
  ) => {
    setActivity(key, { busy: "Getting ready…", notice: null });
    try {
      const deps = vaultDeps(key);
      if (!ownerLock.tryAcquire()) throw new Error("Waiting for your swap to finish… Try again when it's done.");
      let result: T;
      try {
        result = await send(deps, plan);
      } finally {
        ownerLock.release();
      }
      setActivity(key, { busy: null, notice: done(result, plan) });
    } catch (error) {
      fail(key, error);
    } finally {
      setActivity(key, { busy: null });
      after();
      void refreshBalances();
    }
  };

  /** One vault transaction on a plan's card, and a re-read of every vault plan after. */
  const onVault = async <T,>(planId: string, send: (deps: VaultOpDeps, plan: DcaPlan) => Promise<T>, done: (result: T, plan: DcaPlan) => Notice) => {
    const plan = planById(planId);
    if (!plan || plan.signer !== "vault") return;
    await runVault(planId, plan, send, done, () => void refreshVaults());
  };

  /** What closing a vault came to, for the card that closed it. */
  const closedNotice = (result: { returned: bigint | null; note: string | null }): Notice => ({
    tone: "ok",
    title: "Closed",
    text:
      (result.returned === null
        ? "The vault is closed, and what it held was sent back to your wallet."
        : result.returned === 0n
          ? "The vault is closed. It held nothing, so nothing was sent back."
          : `The vault is closed and sent ${roughAmount(result.returned, NATIVE_TOKEN)} back to your wallet.`) + withNote(result.note),
  });

  const fundVault = useCallback(
    (planId: string, amount?: bigint) =>
      onVault(
        planId,
        (deps, plan) => fundVaultOnChain(deps, { plan, ...(amount === undefined ? {} : { amount }) }),
        (result) => ({ tone: "ok", title: "Funded", text: `Added ${roughAmount(result.amount, NATIVE_TOKEN)} to the vault.` }),
      ),
    // onVault reads everything else through `latest`.
    [],
  );

  const closeVault = useCallback(
    (planId: string) => onVault(planId, (deps, plan) => closeVaultOnChain(deps, { plan }), closedNotice),
    [],
  );

  /**
   * Close a vault no plan points at. The vault Guard holds a close to a plan
   * that points at the vault, and the one it is given is the plan the
   * vault's own terms describe (`planFromVault`), so it is checked exactly as
   * a plan card's close is: the vault proved the factory's and the account's
   * by its address, the call byte for byte, the ether back to the owner only.
   */
  const closeStrayVault = useCallback(async (vault: Address) => {
    const key = foundKeyRef.current;
    const address = lower(vault);
    const plan = key === null ? null : (foundRef.current[key]?.reads[address]?.plan ?? null);
    if (key === null || plan === null) return;
    await runVault(
      strayVaultKey(address),
      plan,
      (deps, p) => closeVaultOnChain(deps, { plan: p }),
      (result) => {
        // Closed from here: once its line is read it joins "Closed vaults",
        // and the panel stays up for it rather than vanishing with it.
        updateFound(key, (entry) => ({ ...entry, closedHere: withKnown(entry.closedHere, [address]) }));
        return closedNotice(result);
      },
      () => {
        void readStrays(key, [address]);
      },
    );
  }, []);

  /**
   * "Add back to my plans": the plan the vault's own terms describe, written
   * with `addDcaPlan`, so that the vault has a card again. Its id comes from
   * its address (`vaultPlanId`), so it can't be added twice. Only a vault read
   * as the factory's and the account's is added, and only once its address
   * proves it (`vaultClaim`: the account's vault with some nonce below the
   * factory's count, on exactly those terms), the proof a close or a funding
   * makes before it is sent. The terms written are then the vault's by
   * CREATE2, not merely by what a read said. Nothing is sent.
   */
  const addStrayVault = useCallback(
    async (vault: Address) => {
      const key = foundKeyRef.current;
      const address = lower(vault);
      const read = key === null ? undefined : foundRef.current[key]?.reads[address];
      const activityKeyOf = strayVaultKey(address);
      const { engine: current, account: acct } = latest.current;
      if (
        current === null ||
        acct === null ||
        read === undefined ||
        read.plan === null ||
        read.state.kind !== "active" ||
        read.state.mine !== true
      ) {
        setActivity(activityKeyOf, {
          notice: { tone: "warn", title: "Not added yet", text: "spDEX hasn't read this vault from the chain yet. Try again in a moment." },
        });
        return;
      }
      const { plan, state } = read;
      setActivity(activityKeyOf, { busy: "Checking the vault's address…", notice: null });
      let proved: boolean;
      try {
        proved =
          (await vaultClaim(current.rpc, { address, owner: lower(acct), terms: state.terms, factory: state.factory, release: state.release })) !==
          null;
      } catch (error) {
        fail(activityKeyOf, error);
        return;
      } finally {
        setActivity(activityKeyOf, { busy: null });
      }
      if (!proved) {
        setActivity(activityKeyOf, {
          notice: {
            tone: "danger",
            title: "Not added",
            text: "spDEX couldn't prove from its address that this is your vault, on the terms it read, so it wasn't added. Nothing was sent.",
          },
        });
        return;
      }
      const edit = addDcaPlan(latest.current.config, plan);
      if (!edit.ok) {
        setActivity(activityKeyOf, { notice: { tone: "danger", title: "Not added", text: edit.error } });
        return;
      }
      // Its card starts from what was just read, rather than "Checking".
      setVaultStates((previous) => ({ ...previous, [plan.id]: state }));
      latest.current.applyConfig(edit.config);
      setActivity(activityKeyOf, { notice: null });
      setActivity(plan.id, {
        notice: {
          tone: "ok",
          title: "Added to your plans",
          text: "This vault has a card in your plans now. Nothing was sent: the vault didn't change.",
          arrive: true,
        },
      });
    },
    [setActivity, fail],
  );

  const triggerVault = useCallback(
    (planId: string) =>
      onVault(
        planId,
        (deps, plan) => triggerVaultOnChain(deps, { plan }),
        (result, plan) => ({
          tone: "ok",
          title: "Bought",
          text:
            (result.received === null
              ? "The buy went through."
              : `Bought ${roughAmount(result.received, plan.buy)} for ${roughAmount(BigInt(plan.amountPerBuy), plan.sell)}` +
                (result.reward === null || result.reward === 0n
                  ? "."
                  : `; your wallet was paid ${roughAmount(result.reward, TOKENS.WETH.address)} for triggering it.`)) +
            withNote(result.note),
        }),
      ),
    [],
  );

  const deployVaultFactory = useCallback(async () => {
    const key = VAULT_FACTORY_ACTIVITY;
    setActivity(key, { busy: "Getting ready…", notice: null });
    try {
      const { engine: current, account: owner, config: cfg } = latest.current;
      if (current === null) throw new Error("Choose a network service first.");
      if (owner === null) throw new Error("Connect your wallet first.");
      requireWalletChain();
      if (!ownerLock.tryAcquire()) throw new Error("Waiting for your swap to finish… Try again when it's done.");
      try {
        await deployFactoryOnChain({
          rpc: current.rpc,
          sender: ownerSender(owner),
          chainId: cfg.chainId,
          onStep: (step) => setActivity(key, { busy: step.label }),
        });
      } finally {
        ownerLock.release();
      }
      setActivity(key, {
        busy: null,
        notice: { tone: "ok", title: "Vault factory deployed", text: "Vaults can be created on this network now." },
      });
    } catch (error) {
      fail(key, error);
    } finally {
      setActivity(key, { busy: null });
      void refreshVaultSupport();
    }
  }, [ownerLock, fail, setActivity, refreshVaultSupport]);

  const loadVaultHistory = useCallback(
    async (planId: string) => {
      const current = latest.current.engine;
      const state = vaultStatesRef.current[planId];
      if (current === null || state === undefined || (state.kind !== "active" && state.kind !== "someone-else")) return;
      setVaultHistory((previous) => ({ ...previous, [planId]: { kind: "loading" } }));
      try {
        const history = await readVaultHistory(current.rpc, {
          vault: state.vault,
          buysDone: state.buysDone,
          startAt: Number(state.terms.startAt),
          chainId: latest.current.config.chainId,
          owner: state.owner,
          communityWindow: state.terms.communityWindow,
        });
        if (latest.current.engine === current) {
          setVaultHistory((previous) => ({ ...previous, [planId]: { kind: "ok", history, buysDone: state.buysDone } }));
        }
      } catch (error) {
        if (latest.current.engine === current) {
          setVaultHistory((previous) => ({ ...previous, [planId]: { kind: "error", message: messageOf(error) } }));
        }
      }
    },
    [],
  );

  // A history on screen follows its vault: a buy counted since it was read
  // (by a keeper, or this page's trigger) reads it again.
  useEffect(() => {
    for (const [planId, read] of Object.entries(vaultHistory)) {
      const state = vaultStates[planId];
      if (read.kind !== "ok" || state === undefined || (state.kind !== "active" && state.kind !== "someone-else")) continue;
      if (state.buysDone !== read.buysDone) void loadVaultHistory(planId);
    }
  }, [vaultStates, vaultHistory, loadVaultHistory]);

  const vaultCostsFor = useCallback(
    (amountPerBuy: bigint, maxBuys: number): VaultCosts | null =>
      vaultCosts({ amountPerBuy, maxBuys, fees: fees.kind === "ok" ? fees.fees : null }),
    [fees],
  );

  const vaultRetryFor = useCallback(
    (planId: string, chosen: number | null): VaultRetryTerms | null => {
      const plan = config.dca.plans.find((p) => p.id === planId);
      if (!plan || plan.signer !== "vault") return null;
      return vaultRetryTerms({ plan, draft: drafts.get(plan.chainId, plan.id), chosen });
    },
    [config.dca.plans, drafts],
  );

  const clearNotice = useCallback((key: string) => setActivity(key, { notice: null }), [setActivity]);

  const refresh = useCallback(() => {
    void refreshBalances();
    void refreshFees();
    void refreshVaults();
  }, [refreshBalances, refreshFees, refreshVaults]);

  const confirmPlanRemoval = useCallback((next: SpdexConfig): Promise<SpdexConfig | null> => {
    const current = latest.current.config;
    // Vault plans that may still hold money or buy come through as they are
    // (`keepVaultPlans` says why); the question counts only what goes.
    const kept = keepVaultPlans(current, next, (plan) => vaultStatesRef.current[plan.id]);
    const count = removedPlanCount(current, kept.config);
    if (count === 0 && kept.kept.length === 0) return Promise.resolve(next);
    // An earlier question nobody answered is a no.
    removalAnswer.current?.(false);
    return new Promise<SpdexConfig | null>((resolve) => {
      removalAnswer.current = (ok) => resolve(ok && kept.error === null ? kept.config : null);
      setRemoval({ count, kept: kept.kept.map((k) => k.text), error: kept.error });
    });
  }, []);

  const answerRemoval = useCallback((ok: boolean) => {
    const answer = removalAnswer.current;
    removalAnswer.current = null;
    setRemoval(null);
    answer?.(ok);
  }, []);

  return {
    stripText: strip,
    nextBuyAt,
    buyDue,
    hasPanel,
    confirmPlanRemoval,
    now,
    snapshot: merged,
    ledger,
    entryFor,
    stateFor: (planId) => merged?.plans[planId],
    statusFor: (planId) => statuses[planId],
    safety,
    fees,
    feeLevel,
    webLocks,
    ownerBalances,
    priceCheck,
    ownerLockBusy,
    lease,
    activity,
    removal,
    answerRemoval,
    prefill,
    startPlan,
    confirmDue,
    skipDue,
    pause,
    resumePlan,
    enableAutoBuy,
    deletePlan,
    recreate,
    clearNotice,
    refresh,
    vaultSupport,
    vaultFor: (planId) => {
      const plan = config.dca.plans.find((p) => p.id === planId);
      return plan?.signer === "vault" ? (vaultStates[planId] ?? { kind: "loading" }) : undefined;
    },
    vaultStatusFor: (planId) => vaultStatuses[planId],
    chainNow: chainNowFor,
    vaultCostsFor,
    vaultHistory,
    loadVaultHistory,
    vaultRetryFor,
    createVault,
    fundVault,
    closeVault,
    triggerVault,
    deployVaultFactory,
    refreshVaults: () => {
      void refreshVaults();
      void refreshVaultSupport();
    },
    strayVaults,
    lookForVaults: () => void lookForVaults("again"),
    addFoundVaults,
    closeStrayVault,
    addStrayVault,
  };
}

/** The heartbeat with no runner in this tab (Auto-buy off here): another tab's, if any. */
function leaseWithoutRunner(): (RunnerLease & { thisTab: boolean }) | null {
  const lease = readLease();
  return lease === null ? null : { ...lease, thisTab: false };
}

