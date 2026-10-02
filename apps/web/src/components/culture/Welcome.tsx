/**
 * "Welcome, new aeon": four steps from nothing to a first SPX, on Ethereum.
 *
 * It is how-to, never why-to: a wallet, ETH on Ethereum rather than another
 * network, the SPX6900 contract, and a first buy of a few dollars. One short
 * line a step; the rest is one tap away (a `Term`). That spDEX is a
 * community project is said by the masthead, the disclaimer and the footer,
 * so it isn't said again here.
 *
 * Each step's tick comes from the page's own state (a wallet connected, ETH
 * in it), never from a click, so it can't say a step is done when it isn't.
 * The contract check has no state to read, so it opens with the first buy
 * once the first two are done.
 *
 * The last two steps point at the trade card rather than repeating it: the
 * contract check is the one-line "SPX6900 · 0xE0f6…c56c" under its To select
 * (`ContractLine`), and the dollar chips are the ones under its amount. So
 * the check stays on the page once Welcome is hidden, the page never offers
 * the same chips twice, and on a phone the card isn't pushed two screens down.
 * Each of those buttons hands the page the button pressed, so the page can
 * offer "← Back to steps" once it has shown the place.
 *
 * On a phone it is a stepper: done steps fold to one line, and only the
 * current step is open. From 621px it is a grid of four cards, all open.
 *
 * In a tile (`open` defined) it drops its own panel and title, which the
 * tile's header says, and reports "2 of 4 done" as the header's summary.
 *
 * Hiding it is remembered in this browser (`spdex.welcome.v1`), like the
 * theme, and never in the config. `welcomeStore()` is the page's one copy of
 * that choice, for the page to know when Welcome is on screen and to bring it
 * back ("Getting started").
 */

import { useCallback, type JSX, type ReactNode } from "react";
import { Button, Term } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Address } from "@spdex/core";
import type { RecordRow } from "../../lib/records/types.js";
import { CULTURE_AMOUNT_PRESETS_USD_CENTS } from "../../lib/culture/presets.js";
import { checksumAddress } from "../../lib/culture/contract.js";
import { canCard } from "../../lib/culture/stack.js";
import { networkName } from "../../lib/networks.js";
import { createPrefStore, usePref, type Pref, type PrefStorage, type PrefStore } from "../../lib/prefs.js";
import { balanceText } from "../../lib/dca/view.js";
import { shortAddress } from "../../lib/dca/format.js";
import { NATIVE_ETH } from "../../lib/tokens.js";
import { useTiles, type TilePanelProps, type TileSummary } from "../../lib/tiles.js";
import { useBalance } from "../../lib/useBalance.js";
import { CopyButton, InfoTerm } from "../dca/common.js";
import { useTileSummary } from "../dca/tilePanel.js";
import { presetLabel } from "./PresetChips.js";
import "./culture.css";

/** The chains Welcome shows on: Ethereum, and the local fork of it. */
export const WELCOME_CHAINS: ReadonlySet<number> = new Set([1, 690069]);

/** ethereum.org's list of places to buy ETH, by country: one neutral link, naming no company. */
export const GET_ETH_URL = "https://ethereum.org/get-eth/";

/** ethereum.org's wallet finder: one neutral link for someone with no wallet yet, naming no company. */
export const FIND_WALLET_URL = "https://ethereum.org/wallets/find-wallet/";

export interface WelcomeProps extends TilePanelProps {
  account: Address | null;
  chainId: number;
  /** Null while it is being read (or with no wallet); "unreadable" when the read failed. */
  ethBalance: bigint | null | "unreadable";
  /** Whether this browser has a wallet spDEX can connect to (an injected one). */
  walletAvailable: boolean;
  onConnect(): void;
  /**
   * Set the One-time swap to ETH → SPX and open the trade card's contract
   * line, in view. `from` is the step's button, for "← Back to steps".
   */
  onShowContract(from?: HTMLElement): void;
  /** Set the One-time swap to ETH → SPX and bring the trade card's dollar chips into view. */
  onGoToAmount(from?: HTMLElement): void;
  onGoToRecurring(from?: HTMLElement): void;
  onOpenFeatures(): void;
  /** This account's first SPX buy recorded here, once there is one. */
  firstBuy: RecordRow | null;
  onMakeCard(row: RecordRow): void;
  /** The number format the trade card's dollar chips are written in, for naming them; en-US when not given. */
  locale?: string;
  /** Stands in for the page's store in tests. */
  store?: PrefStore<boolean>;
}

export function Welcome(props: WelcomeProps): JSX.Element | null {
  const store = props.store ?? welcomeStore();
  const hidden = usePref(store);
  const hide = () => store.set(true);
  const states = welcomeSteps(props.account, props.ethBalance);
  useTileSummary(props.onSummary, welcomeSummary(states, props.firstBuy));
  if (hidden || !WELCOME_CHAINS.has(props.chainId)) return null;
  const inTile = props.open !== undefined;

  if (props.firstBuy !== null) {
    const row = props.firstBuy;
    const after = (
      <p className="spdex-welcome__after">
        <span>Your first SPX is in.</span>
        {canCard(row) ? (
          <Button testId="make-card" onClick={() => props.onMakeCard(row)}>
            Make a card?
          </Button>
        ) : null}
        <button type="button" className="spdex-linkbutton" data-testid="welcome-hide" onClick={hide}>
          Hide
        </button>
      </p>
    );
    return inTile ? (
      <div className="spdex-welcome spdex-welcome--after spdex-welcome--tile" data-testid="welcome-panel">
        {after}
      </div>
    ) : (
      <section className="spdex-panel spdex-welcome spdex-welcome--after" data-testid="welcome-panel">
        {after}
      </section>
    );
  }

  const content = (
    <>
      <p className="spdex-welcome__lede">Four steps to your first SPX on Ethereum.</p>

      <ol className="spdex-welcome__steps">
        <Step n={1} title="Get a wallet" state={states[0]} status={<WalletStatus {...props} />}>
          <p>
            Use a browser-extension wallet, or your wallet app&apos;s browser.{" "}
            <Term tip="QR-code and passkey wallets can't connect yet.">Which wallets?</Term>
          </p>
        </Step>

        <Step
          n={2}
          title="Get ETH on Ethereum"
          state={states[1]}
          status={
            props.account === null ? null : (
              <p className="spdex-welcome__status" data-testid="welcome-balance">
                {welcomeBalanceText(props.ethBalance, props.chainId)}
              </p>
            )
          }
        >
          <p>
            Withdraw ETH to your wallet on Ethereum — not Base, Arbitrum, BNB or Solana.
            {/* ⓘ, not a word: "Tip" beside Buy SPX's Tip row, which sends money, read as that. */}
            <InfoTerm tip="Keep a little extra for fees. spDEX vouches for no exchange." label="Before you withdraw" />
          </p>
          <p>
            <a href={GET_ETH_URL} target="_blank" rel="noreferrer noopener" data-testid="welcome-get-eth">
              Where to buy ETH ↗
            </a>
          </p>
        </Step>

        <Step n={3} title="Check the contract" state={states[2]} status={null}>
          <p>Match the SPX address with spx6900.com or CoinGecko. Same name, other address = not SPX.</p>
          <p>
            <button
              type="button"
              className="spdex-linkbutton"
              data-testid="welcome-show-contract"
              onClick={(event) => props.onShowContract(event.currentTarget)}
            >
              Show me the contract →
            </button>
          </p>
        </Step>

        <Step n={4} title="Make a first buy" state={states[3]} status={null}>
          <p>Pick {chipNames(props.locale ?? "en-US")}. Nothing is sent until you press Swap.</p>
          <p>
            <button
              type="button"
              className="spdex-linkbutton"
              data-testid="welcome-to-amount"
              onClick={(event) => props.onGoToAmount(event.currentTarget)}
            >
              Pick an amount →
            </button>
          </p>
          <p>
            <button
              type="button"
              className="spdex-linkbutton"
              data-testid="welcome-recurring"
              onClick={(event) => props.onGoToRecurring(event.currentTarget)}
            >
              Or buy a little on a schedule →
            </button>
          </p>
        </Step>
      </ol>

      <div className="spdex-welcome__foot">
        <button type="button" className="spdex-linkbutton" data-testid="welcome-features" onClick={props.onOpenFeatures}>
          Choose features
        </button>
        <button type="button" className="spdex-linkbutton" data-testid="welcome-hide" onClick={hide}>
          Hide this
        </button>
      </div>
    </>
  );

  return inTile ? (
    <div className="spdex-welcome spdex-welcome--tile" data-testid="welcome-panel">
      {content}
    </div>
  ) : (
    <section className="spdex-panel spdex-welcome" data-testid="welcome-panel" aria-labelledby="spdex-welcome-title">
      <h2 className="spdex-panel__title" id="spdex-welcome-title">
        Welcome, new aeon
      </h2>
      {content}
    </section>
  );
}

/** How many of the four steps are done: the ticks `welcomeSteps` gives. */
export function stepsDone(states: readonly StepState[]): number {
  return states.filter((state) => state === "done").length;
}

/**
 * The tile header's summary: "2 of 4 done", or, after a first buy, "make a
 * card" (or "first SPX in" for a buy the card can't show).
 */
export function welcomeSummary(states: readonly StepState[], firstBuy: RecordRow | null): TileSummary {
  if (firstBuy !== null) return { text: canCard(firstBuy) ? "make a card" : "first SPX in" };
  return { text: `${stepsDone(states)} of ${states.length} done` };
}

/** What "← Back to …" says after a step's button showed a place: "steps (2 of 4)". */
export function welcomeBackLabel(account: Address | null, ethBalance: WelcomeProps["ethBalance"]): string {
  const states = welcomeSteps(account, ethBalance);
  return `steps (${stepsDone(states)} of ${states.length})`;
}

/** "$6.90, $69 or $690", as the trade card's chips write them in this number format. */
export function chipNames(locale: string): string {
  const names = CULTURE_AMOUNT_PRESETS_USD_CENTS.map((cents) => presetLabel(cents, locale));
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

export type StepState = "done" | "current" | "later";

/**
 * Where each step stands. A wallet is step 1 and ETH in it step 2; the
 * contract check and the first buy open together once both are done, since
 * reading an address is nothing the page can see happen.
 */
export function welcomeSteps(
  account: Address | null,
  ethBalance: WelcomeProps["ethBalance"],
): [StepState, StepState, StepState, StepState] {
  const hasWallet = account !== null;
  const hasEth = hasWallet && typeof ethBalance === "bigint" && ethBalance > 0n;
  const first: StepState = hasWallet ? "done" : "current";
  const second: StepState = hasEth ? "done" : hasWallet ? "current" : "later";
  const rest: StepState = hasEth ? "current" : "later";
  return [first, second, rest, rest];
}

function Step({
  n,
  title,
  state,
  status,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  /**
   * Where the step stands, in one line ("Connected: 0x…", the balance) or the
   * control that moves it on. It stays when a done step folds on a phone.
   */
  status: ReactNode;
  /** What the step says; folded away on a phone once the step is done, or until it is reached. */
  children: ReactNode;
}) {
  return (
    <li className={`spdex-welcome__step spdex-welcome__step--${state}`} data-testid={`welcome-step-${n}`} data-state={state}>
      <span className="spdex-welcome__num" aria-hidden="true">
        {state === "done" ? "✓" : n}
      </span>
      <div className="spdex-welcome__body">
        <h3 className="spdex-welcome__title">
          {title}
          {state === "done" ? <span className="spdex-sr"> (done)</span> : null}
        </h3>
        <div className="spdex-welcome__detail">{children}</div>
        {status}
      </div>
    </li>
  );
}

/** Step 1's line: connected (with the full address to copy, which step 2 needs), a Connect button, or no wallet. */
function WalletStatus({ account, walletAvailable, onConnect }: Pick<WelcomeProps, "account" | "walletAvailable" | "onConnect">) {
  if (account !== null) {
    const address = checksumAddress(account);
    return (
      <p className="spdex-welcome__status" data-testid="welcome-connected">
        <span>
          Connected: <code title={address}>{shortAddress(address)}</code>
        </span>{" "}
        <CopyButton text={address} testId="welcome-copy-address" />
      </p>
    );
  }
  if (!walletAvailable) {
    // Never a dead end: one neutral place to find a wallet, as step 2 has for ETH.
    return (
      <div className="spdex-welcome__status spdex-welcome__status--stack" data-testid="welcome-no-wallet">
        <p>No wallet found in this browser.</p>
        <p>
          <a href={FIND_WALLET_URL} target="_blank" rel="noreferrer noopener" data-testid="welcome-find-wallet">
            Find a wallet ↗
          </a>
          , then reload this page.
        </p>
      </div>
    );
  }
  return (
    <div className="spdex-welcome__status">
      <Button testId="welcome-connect" onClick={onConnect}>
        Connect wallet
      </Button>
    </div>
  );
}

/** The balance in three states; a balance that couldn't be read is never "no ETH". */
export function welcomeBalanceText(ethBalance: WelcomeProps["ethBalance"], chainId: number): string {
  if (ethBalance === "unreadable") return "spDEX couldn't read this wallet's ETH balance.";
  if (ethBalance === null) return "Reading this wallet's ETH balance…";
  if (ethBalance === 0n) return "No ETH in this wallet yet.";
  return `Your wallet holds ${balanceText(ethBalance, NATIVE_ETH)} on ${networkName(chainId)}.`;
}

// ─── Whether it is hidden ─────────────────────────────────────────────────────

/** "hidden" once the person hides Welcome in this browser; anything else shows it. */
export const WELCOME_KEY = "spdex.welcome.v1";

/**
 * Whether Welcome is hidden. Storage that throws or is missing reads as "not
 * hidden" and keeps a hide for this visit only: a newcomer's panel must never
 * vanish because a browser blocked storage.
 */
const WELCOME_HIDDEN: Pref<boolean> = {
  key: WELCOME_KEY,
  parse: (raw) => raw === "hidden",
  format: (hidden) => (hidden ? "hidden" : "shown"),
};

/** A Welcome-hidden store over `storage`: the page's is `welcomeStore()`. */
export function createWelcomeStore(storage: PrefStorage | null): PrefStore<boolean> {
  return createPrefStore(WELCOME_HIDDEN, storage);
}

let pageStore: PrefStore<boolean> | undefined;

/** The page's store, against this browser's storage: `set(false)` brings Welcome back ("Getting started"). */
export function welcomeStore(): PrefStore<boolean> {
  pageStore ??= createPrefStore(WELCOME_HIDDEN);
  return pageStore;
}

/** Whether Welcome is hidden, kept current: for the page's other parts that depend on it. */
export function useWelcomeHidden(store: PrefStore<boolean> = welcomeStore()): boolean {
  return usePref(store);
}

/** Welcome as the page needs it: whether it is on screen, the ETH its second step shows, and the way back. */
export interface WelcomeOnPage {
  /** Hidden in this browser (then the strip offers "Getting started"). */
  hidden: boolean;
  /** On screen: a network service is chosen, it is on Ethereum or the fork, and it isn't hidden. */
  shown: boolean;
  /** The wallet's ETH, for the second step. */
  ethBalance: WelcomeProps["ethBalance"];
  /** Brings Welcome back and shows it: its tile opened, scrolled to ("Getting started"). */
  showAgain(): void;
}

/**
 * The page's Welcome. Its ETH is the One-time card's balance while the card
 * pays with ETH and has read it (`cardEth`); otherwise one read of its own,
 * while Welcome is on screen, again whenever `refresh` changes. A read that
 * failed is "unreadable", never "no ETH".
 */
export function useWelcome(input: {
  rpc: JsonRpc | null;
  chainId: number;
  account: Address | null;
  /** The card's ETH balance when it pays with ETH; undefined when it doesn't. */
  cardEth: bigint | "unreadable" | null | undefined;
  /** Whose figures a balance is: this network, through this service. */
  balanceKey: string;
  refresh: string;
  /**
   * The page's `reveal` (lib/tiles.ts), for "Getting started" to open
   * Welcome's tile. The page calls this hook above its own tiles provider, so
   * it hands `reveal` in; without it Welcome is only scrolled to.
   */
  reveal?: (target: string, opts?: { block?: ScrollLogicalPosition }) => Promise<boolean>;
}): WelcomeOnPage {
  const hidden = useWelcomeHidden();
  const shown = input.rpc !== null && !hidden && WELCOME_CHAINS.has(input.chainId);
  const own = useBalance(input.rpc, NATIVE_ETH.address, input.account, {
    enabled: shown && (input.cardEth === undefined || input.cardEth === null),
    key: input.balanceKey,
    refresh: input.refresh,
  });
  const tiles = useTiles();
  const reveal = input.reveal ?? tiles.reveal;
  const showAgain = useCallback(() => {
    welcomeStore().set(false);
    // After the commit that puts it back on the page.
    requestAnimationFrame(() => void reveal("welcome-panel", { block: "start" }));
  }, [reveal]);
  return { hidden, shown, ethBalance: input.cardEth ?? own, showAgain };
}
