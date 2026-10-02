/**
 * Your stack: the SPX in this wallet, what spDEX has stacked for it, what went
 * in, and a goal counted in SPX.
 *
 * No price, no value now, no gain or loss, no chart: lib/culture/stack.ts
 * says why. The one money figure, in Put in's hint, is what went in valued
 * when it went in, and it sits inside `stack-put-in` so a test can hold every
 * other figure to having none.
 *
 * In a tile (`open` defined, the "Your SPX" tile) it drops its own panel and
 * title, says in one line what connecting a wallet shows rather than showing
 * nothing, and reports the SPX in this wallet as the header's summary:
 * "4,267.12 SPX", or "not read yet", "reading…", "unknown", never 0 for a
 * figure it doesn't have.
 */

import { useState, type JSX, type ReactNode } from "react";
import { Brand, Button, Panel, Progress, Stat } from "@spdex/ui";
import { TOKENS, type JsonRpc } from "@spdex/chain";
import type { Address, DcaPlan } from "@spdex/core";
import type { AutoBuy } from "../../lib/dca/useAutoBuy.js";
import type { Pricing } from "../../lib/money/pricing.js";
import type { RecordRow } from "../../lib/records/types.js";
import { STACK_GOAL_PRESETS_SPX } from "../../lib/culture/presets.js";
import {
  buysText,
  feesText,
  goalProgress,
  putInText,
  putInValue,
  putInValueText,
  STACK_GOAL,
  spxText,
  summariseStack,
  type StackSummary,
  type StackVault,
  type TruncatedPlan,
} from "../../lib/culture/stack.js";
import { cardAmount } from "../../lib/culture/card.js";
import { plansBuysLeft, stackVaults, unreadVaults, type UnreadVaults } from "../../lib/culture/stackInputs.js";
import { parseDecimal } from "../../lib/money/parse.js";
import { pageStorage } from "../../lib/page.js";
import { createPrefStore, usePref, type PrefStorage } from "../../lib/prefs.js";
import { formatAmount } from "../../lib/tokens.js";
import type { TilePanelProps, TileSummary } from "../../lib/tiles.js";
import { useBalance } from "../../lib/useBalance.js";
import { InfoTerm } from "../dca/common.js";
import { useTileSummary } from "../dca/tilePanel.js";
import { SayingLine } from "./SayingLine.js";
import "./culture.css";
import { formatCount } from "../../lib/money/format.js";

/** The chains Your stack shows on: Ethereum, and the local fork of it. */
const STACK_CHAINS: ReadonlySet<number> = new Set([1, 690069]);

/** SPX's whole supply: 1,000,000,000, with 8 decimals. A goal above it can't be reached by anyone. */
const SPX_SUPPLY = 1_000_000_000n * 10n ** 8n;

export interface YourStackProps extends TilePanelProps {
  account: Address | null;
  chainId: number;
  /** SPX in the wallet now; null while unread or when the read failed. */
  holding: bigint | null;
  /**
   * Where the wallet's SPX read stands, which `holding` alone can't say:
   * not asked for yet, being read, read, or failed. Read when not given.
   */
  holdingState?: HoldingState;
  /** Connects a wallet: the button a tile shows in place of an empty stack. */
  onConnect?(): void;
  rows: readonly RecordRow[];
  vaults: readonly StackVault[];
  truncated: readonly TruncatedPlan[];
  /** Buys the account's plans have left, together; null when unknown. */
  buysLeft: number | null;
  /**
   * Vault plans whose vault is still being read, or couldn't be
   * (`unreadVaults`). While one is being read the totals say "reading…";
   * one that couldn't be read makes them "at least", with a note.
   */
  unreadVaults?: UnreadVaults;
  pricing: Pricing | null;
  onMakeCard(row: RecordRow): void;
  /** `useRecords`' state. Until the records are read, what they would add is "reading", never 0. */
  recordsState?: "idle" | "loading" | "ready" | "unavailable";
  /** Stands in for this browser's storage in tests. */
  storage?: PrefStorage | null;
}

/** Where the read of the wallet's SPX stands. */
export type HoldingState = "idle" | "reading" | "read" | "unreadable";

/** What Your stack is given beyond the records and the page's rates. */
export type StackInputs = Pick<YourStackProps, "holding" | "holdingState" | "vaults" | "buysLeft" | "unreadVaults">;

/**
 * Your stack's figures from what the page already holds (the auto-buy
 * panel's vault reads and ledger: lib/culture/stackInputs.ts), and the SPX in
 * the wallet: one `balanceOf`, once the stack has been on screen (`seen`),
 * and again after each swap (`refresh`) and each buy a plan or vault makes.
 * Unread or failed is null, which the stack shows as unknown, never 0.
 */
export function useStackInputs(input: {
  rpc: JsonRpc | null;
  account: Address | null;
  chainId: number;
  plans: readonly DcaPlan[];
  autoBuy: Pick<AutoBuy, "ledger" | "vaultFor" | "entryFor">;
  seen: boolean;
  /**
   * The SPX in the wallet as another part of the page read it (the trade
   * card, while SPX is one side of its pair), through the same service:
   * shown until the stack has read its own, and where its own read failed.
   */
  heldElsewhere?: bigint | null;
  /** Whose figures a balance is: this network, through this service. */
  balanceKey: string;
  refresh: string;
}): StackInputs {
  const { account, autoBuy } = input;
  const reads = { plans: input.plans, chainId: input.chainId, vaultFor: autoBuy.vaultFor, entryFor: autoBuy.entryFor };
  const vaults = account === null ? [] : stackVaults(reads, account);
  const planBuys = Object.values(autoBuy.ledger === "unavailable" ? {} : autoBuy.ledger.entries).reduce((sum, entry) => sum + entry.buysDone, 0);
  const vaultBuys = vaults.reduce((sum, v) => sum + v.buysDone, 0n);
  const holding = useBalance(input.rpc, TOKENS.SPX.address, account, {
    enabled: input.seen,
    key: input.balanceKey,
    refresh: `${input.refresh}:${planBuys}:${vaultBuys}`,
  });
  const elsewhere = account === null ? null : (input.heldElsewhere ?? null);
  const own = typeof holding === "bigint" ? holding : null;
  return {
    holding: own ?? elsewhere,
    holdingState:
      account === null
        ? "idle"
        : own !== null || elsewhere !== null
          ? "read"
          : !input.seen
            ? "idle"
            : holding === "unreadable"
              ? "unreadable"
              : "reading",
    vaults,
    buysLeft: account === null ? null : plansBuysLeft(reads, account),
    unreadVaults: unreadVaults(reads),
  };
}

/** The chains Your stack shows on, for the page: Ethereum and the local fork. */
export function stackShown(chainId: number): boolean {
  return STACK_CHAINS.has(chainId);
}

/**
 * The "Your SPX" tile header's part from the stack: the SPX in this wallet,
 * or why there is no figure. Never 0 for a figure that wasn't read.
 */
export function stackSummary(input: Pick<YourStackProps, "account" | "chainId" | "holding" | "holdingState">): TileSummary {
  if (input.account === null) return { text: "connect a wallet" };
  if (!STACK_CHAINS.has(input.chainId)) return { text: "Ethereum only" };
  const state = input.holdingState ?? (input.holding === null ? "unreadable" : "read");
  if (state === "idle") return { text: "not read yet" };
  if (state === "reading") return { text: "reading…" };
  if (state === "unreadable" || input.holding === null) return { text: "unknown" };
  return { text: spxText(input.holding) };
}

/** What a goal counts, one tap away. */
const GOAL_TIP = "A goal counts the SPX in this wallet, however it got there. It stays in this browser.";

export function YourStack(props: YourStackProps): JSX.Element | null {
  const { account } = props;
  const inTile = props.open !== undefined;
  useTileSummary(props.onSummary, stackSummary(props));
  if (account === null || !STACK_CHAINS.has(props.chainId)) {
    if (!inTile) return null;
    // In a tile, one line and what to do about it, never an empty body.
    return account === null ? (
      <section className="spdex-stack spdex-stack--empty" data-testid="yours-empty">
        <p className="spdex-stack__emptyline">Connect a wallet to see your SPX and records.</p>
        {props.onConnect ? (
          <Button testId="yours-connect" onClick={props.onConnect}>
            Connect wallet
          </Button>
        ) : null}
      </section>
    ) : (
      <section className="spdex-stack spdex-stack--empty" data-testid="yours-empty">
        <p className="spdex-stack__emptyline">Your SPX shows on Ethereum only.</p>
      </section>
    );
  }
  const unread = props.unreadVaults ?? { reading: 0, failed: 0 };
  const summary = summariseStack({
    account,
    chainId: props.chainId,
    rows: props.rows,
    vaults: props.vaults,
    truncated: props.truncated,
    unreadVaults: unread.failed,
  });
  const currency = props.pricing?.currency ?? "USD";
  const locale = props.pricing?.locale ?? "en-US";
  const state = props.recordsState ?? "ready";
  // A vault still being read may hold most of what was stacked, so nothing is totalled until it is.
  const reading = state === "loading" || state === "idle" || unread.reading > 0;
  const unreadable = state === "unavailable";

  const valueHint = putInValueText(putInValue(summary, currency), locale, currency);
  // Before anything was bought here, "Put in: nothing yet" says what
  // "Stacked: 0 SPX" already does, so it waits for a first buy.
  const nothingYet = !reading && !unreadable && summary.buys.total === 0 && !summary.stacked.atLeast && !summary.putIn.atLeast;

  const body = (
    <>
      <div className="spdex-statgrid spdex-stack__grid">
        <Stat
          label="Holding"
          value={props.holding === null ? null : spxText(props.holding)}
          hint="in this wallet"
          testId="stack-holding"
        />
        <Stat
          label={<>Stacked with <Brand /></>}
          value={reading ? "reading…" : unreadable ? null : counted(summary.stacked.atLeast, spxText(summary.stacked.amount))}
          hint={reading || unreadable ? recordsHint(state) : stackedHint(summary)}
          testId="stack-stacked"
        />
        {nothingYet ? null : (
        <div className="spdex-stat spdex-stack__putin" data-testid="stack-put-in">
          <span className="spdex-stat__label">Put in</span>
          <span
            className={`spdex-stat__value${unreadable ? " spdex-stat__value--unknown" : ""}`}
            data-testid="stack-put-in-value"
          >
            {reading ? "reading…" : unreadable ? "unknown" : counted(summary.putIn.atLeast, putInText(summary.putIn.tokens))}
          </span>
          {!reading && !unreadable ? (
            <>
              {valueHint === null ? null : <span className="spdex-stat__hint">{valueHint}</span>}
              <span className="spdex-stat__hint">{feesText(summary.vaultFees)}</span>
            </>
          ) : null}
        </div>
        )}
      </div>

      {summary.notes.length > 0 ? (
        <ul className="spdex-stack__notes" data-testid="stack-notes">
          {summary.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <FirstAndLatest summary={summary} onMakeCard={props.onMakeCard} locale={locale} />

      <Goal
        holding={props.holding}
        buysLeft={props.buysLeft}
        locale={locale}
        storage={props.storage === undefined ? pageStorage() : props.storage}
      />

      <footer className="spdex-stack__footer" data-testid="stack-footer">
        <SayingLine id="persist" />
      </footer>
    </>
  );

  return inTile ? (
    <section className="spdex-stack spdex-subpanel" data-testid="stack-card">
      {body}
    </section>
  ) : (
    <Panel title="Your stack" testId="stack-card">
      {body}
    </Panel>
  );
}

/**
 * "at least 3,610.3 SPX" when something couldn't be counted; the figure alone
 * otherwise. The "at least" sits small above the figure, so the figure keeps
 * its line in a quarter of the width.
 */
function counted(atLeast: boolean, text: string): ReactNode {
  return atLeast ? (
    <>
      <span className="spdex-stack__atleast">at least</span> {text}
    </>
  ) : (
    text
  );
}

function recordsHint(state: NonNullable<YourStackProps["recordsState"]>): string {
  if (state === "unavailable") return "This browser's records couldn't be read just now.";
  return state === "ready" ? "Reading your vaults…" : "Reading this browser's records…";
}

function stackedHint(summary: StackSummary): string {
  const sold = summary.soldSpx;
  const soldText =
    sold === null ? "" : ` · sold ${sold.atLeast ? "at least " : ""}${spxText(sold.amount)} with spDEX, which isn't taken off`;
  return `${buysText(summary.buys)}${soldText}`;
}

/**
 * A day as Your activity writes it: this device's time zone and the page's
 * format, so a buy is on the same day in both. (A card says the UTC day, and
 * says so.)
 */
function stackDay(unix: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(new Date(unix * 1000));
}

function FirstAndLatest({ summary, onMakeCard, locale }: { summary: StackSummary; onMakeCard(row: RecordRow): void; locale: string }) {
  const latest = summary.latest;
  if (summary.firstBuyAt === null && latest === null) return null;
  return (
    <div className="spdex-stack__first">
      {summary.firstBuyAt !== null ? (
        <p>
          First buy recorded here: <strong data-testid="stack-first">{stackDay(summary.firstBuyAt, locale)}</strong>
        </p>
      ) : null}
      {latest !== null && latest.bought.amount !== null ? (
        <p className="spdex-stack__latest">
          <span>
            Latest: <strong>{cardAmount(latest.bought.amount)}</strong>, {stackDay(latest.at.unix, locale)}
          </span>
          <Button variant="ghost" testId="make-card" onClick={() => onMakeCard(latest)}>
            Make a card
          </Button>
        </p>
      ) : null}
    </div>
  );
}

// ─── The goal ─────────────────────────────────────────────────────────────────

function Goal({
  holding,
  buysLeft,
  locale,
  storage,
}: {
  holding: bigint | null;
  buysLeft: number | null;
  locale: string;
  storage: PrefStorage | null;
}) {
  const [store] = useState(() => createPrefStore(STACK_GOAL, storage));
  const goal = usePref(store);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const setGoal = (next: bigint | null) => {
    store.set(next);
    setTyped("");
    setError(null);
  };

  if (goal === null) {
    const submit = () => {
      const parsed = parseDecimal(typed, locale, 8);
      if (!parsed.ok) return setError(parsed.error);
      if (parsed.value <= 0n) return setError("Enter a goal greater than zero.");
      if (parsed.value > SPX_SUPPLY) return setError(`That's more SPX than there is: at most ${formatCount(1_000_000_000)}.`);
      setGoal(parsed.value);
    };
    // Folded until asked for: a form with three chips, a field and a button
    // is most of the panel, for something few people set.
    return (
      <details className="spdex-stack__goal spdex-stack__goal--folded" data-testid="stack-goal">
        <summary className="spdex-stack__goalhead" data-testid="stack-goal-open">
          Set a goal, in SPX
        </summary>
        <div className="spdex-presets__chips" role="group" aria-label="Goals in SPX">
          {STACK_GOAL_PRESETS_SPX.map((spx) => (
            <button
              key={spx}
              type="button"
              className="spdex-presets__chip"
              data-testid={`stack-goal-${spx}`}
              onClick={() => setGoal(BigInt(spx) * 10n ** 8n)}
            >
              {formatCount(spx)} SPX
            </button>
          ))}
        </div>
        <form
          className="spdex-stack__goalform"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="spdex-stack__goalinput">
            <span className="spdex-sr">Your own goal, in SPX</span>
            <input
              className="spdex-input"
              inputMode="decimal"
              placeholder="Or your own, in SPX"
              value={typed}
              data-testid="stack-goal-input"
              onChange={(event) => {
                setTyped(event.target.value);
                setError(null);
              }}
            />
            <span className="spdex-stack__affix" aria-hidden="true">
              SPX
            </span>
          </label>
          <Button variant="ghost" type="submit" testId="stack-goal-set">
            Set goal
          </Button>
        </form>
        {error !== null ? (
          <p className="spdex-stack__error" data-testid="stack-goal-error" role="alert">
            {error}
          </p>
        ) : null}
        <span className="spdex-field__hint">
          Counts this wallet&apos;s SPX.
          <InfoTerm tip={GOAL_TIP} label="What counts?" />
        </span>
      </details>
    );
  }

  const progress = goalProgress(holding, goal);
  const goalText = `${formatAmount(goal, 8, { maxFraction: 8 })} SPX`;
  const holdingText = holding === null ? null : formatAmount(holding, 8, { maxFraction: holding >= 10n ** 8n ? 2 : 8 });
  return (
    <div className="spdex-stack__goal" data-testid="stack-goal">
      <p className="spdex-stack__goalhead" data-testid="stack-goal-status">
        {progress.reached === true ? <strong>{goalText} goal reached</strong> : <>Goal: {goalText} in this wallet</>}
      </p>
      <Progress
        value={progress.percent}
        max={100}
        label="Progress toward your goal"
        valueText={progress.percent === null ? "unknown" : `${progress.percent}%`}
        testId="stack-goal-progress"
      />
      <p className="spdex-field__hint">
        {holdingText === null ? "This wallet's SPX couldn't be read just now." : `${holdingText} of ${goalText}.`}
        <InfoTerm tip={GOAL_TIP} label="What counts?" />
      </p>
      <p className="spdex-stack__goalfoot">
        {buysLeft === null ? null : (
          <span data-testid="stack-buys-left">
            {buysLeft === 0 ? "Your plans have no buys left." : `Your plans have ${formatCount(buysLeft)} ${buysLeft === 1 ? "buy" : "buys"} left.`}{" "}
          </span>
        )}
        <button type="button" className="spdex-linkbutton" data-testid="stack-goal-remove" onClick={() => setGoal(null)}>
          Remove goal
        </button>
      </p>
    </div>
  );
}
