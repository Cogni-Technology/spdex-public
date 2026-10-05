/**
 * Composition root.
 *
 * Simple and Expert are a view toggle over one config object, not two
 * applications. The view changes which controls are visible; it changes
 * nothing about how a swap is routed, checked or executed. The same holds for
 * the Trade card's two tabs: a one-time swap and a recurring buy share one
 * execution path (lib/execute.ts), one step vocabulary (lib/steps.ts) and one
 * lock on the owner's wallet.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Banner, Brand, Button, Disclosure, Term, Tile, TileGroup, type TileSummaryView } from "@spdex/ui";
import { featureById, recommendedConfig, TRACKER_FEATURE_ID } from "@spdex/config";
import { PERMIT2_ADDRESS, type Hex, type SpdexConfig } from "@spdex/core";
import { permit2NonceBitmap, tipClaimSigned } from "@spdex/chain";
import {
  Engine,
  type DiscoveredPool,
  type DiscoveredRecipient,
  type QuoteResult,
} from "./lib/engine.js";
import { allowance, balanceOf, totalSupply } from "./lib/erc20.js";
import { useBalance } from "./lib/useBalance.js";
import { ExecutionError, executeQuote, OwnerWalletLock, type SentVia } from "./lib/execute.js";
import { walletSender } from "./lib/senders.js";
import { buildPermit2Permission, tipTransfersFor } from "./lib/tips.js";
import { tipDeliveryFor, tipPrompts } from "./lib/tipRow.js";
import { sendTips as sendTipsFlow, type TipOutcome } from "./lib/tipFlow.js";
import { payablePolicy, tippableRecipients } from "./lib/tiplist/checks.js";
import { tipListStore, useTipList } from "./lib/tiplist/store.js";
import { TipsContext, type TipsEnv } from "./components/tips/context.js";
import { formatPoolMoney, priceStats } from "./lib/stats.js";
import { StepCounter, stepText } from "./lib/steps.js";
import { errorPlacement, friendlyError, notEnoughMessage, serviceRefusal, swapProblemLine } from "./lib/errors.js";
import { networkLabel } from "./lib/networks.js";
import { GLOSSARY } from "./lib/names.js";
import { quotingKey, safetyTestFrom, swapNetworkFee, type SafetyTest } from "./lib/summary.js";
import { createPrefStore, loadPair, loadView, pairAfterPick, savePair, saveView, usePref, type View } from "./lib/prefs.js";
import { useAutoBuy, type AutoBuyDeps } from "./lib/dca/useAutoBuy.js";
import { FeaturesModal } from "./components/Features.js";
import { PoolStatsPanel, type PoolStatsPhase, type PoolStatsView } from "./components/PoolStats.js";
import { Ticker } from "./components/Ticker.js";
import {
  autoBundledRpc,
  builtInServiceInUse,
  builtInServiceToSave,
  bundledRpcAvailable,
  clearUrlFragment,
  featuresSeen,
  loadConfig,
  markFeaturesSeen,
  OLDER_TAB_TEXT,
  publicFallbackRpc,
  readConfigForAdoption,
  saveConfig,
  stagedConfigFromUrl,
  watchConfigFromOtherTabs,
  withOwnService,
} from "./lib/store.js";
import {
  addAndSwitchChain,
  connect,
  confirmTransaction,
  currentChainId,
  delegationOf,
  detectProvider,
  isUserRejection,
  switchChain,
  watchWallet,
  PRIVATE_CONFIRM_TIMEOUT_MS,
  type ConfirmOptions,
  type ReadRpc,
} from "./lib/wallet.js";
import { readFeeLevel, readWalletFees } from "./lib/fees.js";
import { PrivateSubmissionUnavailable, privateGasPrice, submit } from "./lib/submit.js";
import { formatAmount, isNative, spendableBalance, tokenBySymbol, TOKEN_LIST, type TokenInfo } from "./lib/tokens.js";
import type { AmountInput } from "./lib/money/pricing.js";
import { moneyStore, useMoneyPrefs } from "./lib/money/prefs.js";
import { moneyView, usePricing } from "./lib/money/rates.js";
import { resolveAmount, startingUnit } from "./lib/money/resolve.js";
import { useRecordPriceSnapshots, useRecords, type RecordSwapInput } from "./lib/records/store.js";
import type { RecordRow } from "./lib/records/types.js";
import { firstSpxBuy } from "./lib/culture/stackInputs.js";
import { feePerGasNow, vaultDeployment } from "./lib/dca/vault.js";
import { shareableAppUrl } from "./lib/links.js";
import { useSeenOnScreen } from "./lib/onScreen.js";
import { pageEvents, pageStorage } from "./lib/page.js";
import { scrollBehavior } from "./lib/a11y.js";
import { GoTo, isExpertOnly } from "./lib/places.js";
import { serviceNameOf } from "./lib/rpcDisplay.js";
import {
  ARM_AFTER_MS,
  initialOpen,
  marketsSummary,
  receiptSummary,
  settingsSummary,
  startSummary,
  TILE_ORDER,
  TILES,
  TilesContext,
  tradeSummary,
  useArmed,
  useTilesState,
  yoursSummary,
  type TileId,
  type TileSummary,
} from "./lib/tiles.js";
import { DISCLAIMER_PREF, DISCLAIMER_VERSION, disclaimerSeen } from "./lib/disclaimer.js";
import { onBuyDueClick, onProofLapseClick } from "./lib/reminders/notify.js";
import { BuiltInServiceNotice, FirstRun } from "./components/FirstRun.js";
import { OneTimeSwap, SLOW_SEND_MS, TradeCard, type BuyMode, type PendingSend } from "./components/Swap.js";
import { OlderSavePrompt, StagedConfigPrompt } from "./components/ConfigIo.js";
import { Masthead } from "./components/shell/Masthead.js";
import { DisplayDock } from "./components/shell/DisplayDock.js";
import { StatusWidget } from "./components/shell/StatusWidget.js";
import { Footer } from "./components/shell/Footer.js";
import { DisclaimerGate } from "./components/shell/DisclaimerGate.js";
import { featuresOn, SettingsTile } from "./components/shell/SettingsTile.js";
import { Stickers } from "./components/shell/art/Stickers.js";
import { LinkMap } from "./components/shell/art/LinkMap.js";
import { Backdrop } from "./components/shell/art/Backdrop.js";
import { RecurringForm } from "./components/dca/RecurringForm.js";
import { AutoBuysPanel } from "./components/dca/AutoBuysPanel.js";
import {
  Welcome,
  WELCOME_CHAINS,
  useWelcome,
  welcomeBackLabel,
  welcomeStore,
  welcomeSteps,
} from "./components/culture/Welcome.js";
import { CONTRACT_LINE_ID } from "./components/culture/ContractBadge.js";
import { CULTURE_AMOUNT_PRESETS_USD_CENTS } from "./lib/culture/presets.js";
import { YourStack, useStackInputs } from "./components/culture/YourStack.js";
import { IBoughtCard } from "./components/culture/IBoughtCard.js";
import { ReceiptView, useReceiptLink } from "./components/culture/ReceiptView.js";
import { VAULT_FACTORIES } from "./lib/culture/receipt.js";
import { AfterSwap, statusAfterSwap, useAfterSwap } from "./components/records/AfterSwap.js";
import { YourActivity } from "./components/records/YourActivity.js";
import { CollectiveDca, useCollectiveBuys } from "./components/network/CollectiveDca.js";
import { HelpRunPanel } from "./components/network/HelpRunNetwork.js";
import { WalkawayPanel } from "./components/network/WalkawayPanel.js";

/** The token whose supply the ticker's "% to flip" is worked from. */
const SPX = tokenBySymbol("SPX");

/** The tokens a tip can be sent in, and so the ones Permit2 may hold a permission for. */
const TIP_TOKENS = TOKEN_LIST.filter((token) => !isNative(token));

/**
 * How often SPX's total supply is read again: hourly after an answer, since a
 * token's supply moves rarely and by little and a four-digit percentage would
 * not show a small change; five minutes after a failure, since until then the
 * ticker has no "% to flip" to show.
 */
const SUPPLY_REFRESH_MS = 60 * 60_000;
const SUPPLY_RETRY_MS = 5 * 60_000;
/** How long after the network service failed to answer for a pair's markets discovery asks again. */
const DISCOVERY_RETRY_MS = 60_000;

/** Where the page was when it last asked for pools and statistics; see the Markets panel's phases. */
interface Fetched {
  engine: Engine | null;
  key: string;
}

export function App() {
  // First, so the page's number format is in place before anything below
  // writes a figure: the currency and number style are this browser's, never
  // the config's (lib/money/prefs.ts).
  const moneyPrefs = useMoneyPrefs();
  // This copy's built-in network service: where it works (FirstRun's button),
  // and where it is used without asking (lib/store.ts). Fixed for the page.
  const [builtIn] = useState(() => ({ usable: bundledRpcAvailable(), automatic: autoBundledRpc() }));
  // A config that saved another build's key reads with this build's before
  // anything is read with it, in memory only (`builtInServiceInUse`); one with
  // no service yet waits for the disclaimer (below).
  const [config, setConfig] = useState<SpdexConfig>(() => builtInServiceInUse(loadConfig(), builtIn));
  // The config as of the latest write, for callbacks that must not be rebuilt
  // on every config change (the quoting-key comparison, the chain-adoption probe).
  const configRef = useRef(config);
  const [mode, setModeState] = useState<View>(() => loadView());
  const [staged, setStaged] = useState<SpdexConfig | null>(null);
  const [stagedError, setStagedError] = useState<string | null>(null);

  // Newcomers start on ETH → SPX, since ether is what they arrive holding; a
  // returning browser gets its last pair.
  const [initialPair] = useState(() => loadPair());
  const [tokenInSymbol, setTokenInSymbol] = useState(initialPair.in);
  const [tokenOutSymbol, setTokenOutSymbol] = useState(initialPair.out);
  // The One-time amount: its text, the unit it is in, and, for money, the
  // token amount it was sized to (lib/money). A browser that never switched
  // the field starts in its currency, since money is what a newcomer thinks
  // in; the token amount is always shown, and is what is quoted and signed.
  const [amountInput, setAmountInput] = useState<AmountInput>(() => {
    const prefs = moneyStore().get();
    return { text: "", unit: startingUnit(prefs.units.once, tokenBySymbol(initialPair.in), prefs.currency), frozen: null };
  });
  // Always One-time on load: every flow a newcomer (and every e2e spec) starts
  // from expects the swap controls without a click.
  const [buyMode, setBuyMode] = useState<BuyMode>("once");

  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteId, setQuoteId] = useState(0);
  const [pools, setPools] = useState<DiscoveredPool[]>([]);
  const [discoveredFor, setDiscoveredFor] = useState<Fetched | null>(null);
  // Where discovery last failed (the service busy, capped or refusing): the
  // markets are unknown there, never "none found". A retry, or a price got
  // since, clears it.
  const [discoveryFailed, setDiscoveryFailed] = useState<Fetched | null>(null);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const [statsFor, setStatsFor] = useState<Fetched | null>(null);
  // Null until the registry has answered for the current engine: "loading"
  // and "nobody" are different things to show.
  const [tipCandidates, setTipCandidates] = useState<DiscoveredRecipient[] | null>(null);
  const [stats, setStats] = useState<PoolStatsView>({ pools: [], loading: false, volumeBlocks: 0 });
  // The dollar rates pool statistics priced with: the ticker's "% to flip"
  // falls back to them before the page's own rates are read.
  const [statsRates, setStatsRates] = useState<ReadonlyMap<string, bigint>>(() => new Map());
  const [featuresOpen, setFeaturesOpen] = useState(false);
  // Set when the connected account runs someone else's code on receipt.
  const [delegate, setDelegate] = useState<string | null>(null);
  // Set when the wallet is on a different chain than the configured network service.
  const [wrongChain, setWrongChain] = useState<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The message of the last Get price that failed, for a line under the
  // button: on a phone the banner at the top is a screen or more above it.
  // Shown while `error` is still that message; cleared by the next quote, an
  // amount or pair change.
  const [quoteFailure, setQuoteFailure] = useState<string | null>(null);
  // What a block charges per gas now, read with each price, for the swap's
  // network-fee line; null until read, or when it couldn't be.
  const [quoteFeePerGas, setQuoteFeePerGas] = useState<bigint | null>(null);
  // The base fee now and its usual over the last few hours, for the line that
  // says fees are high (`highFeeNote`); null until read, or when unreadable.
  const [quoteFeeLevel, setQuoteFeeLevel] = useState<{ base: bigint; usual: bigint } | null>(null);
  // The transaction a swap is waiting on, for the line that says it is slow.
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  // What the last swap left under "Swap complete", and a count of the swaps
  // that moved money, for the balances read after them.
  const afterSwap = useAfterSwap();
  // The buy an "I bought" card is being made of, while its dialog is open.
  const [cardRow, setCardRow] = useState<RecordRow | null>(null);
  const [safety, setSafety] = useState<SafetyTest>("checking");
  // Set when private sending turned out to be impossible and the user has to
  // decide whether to broadcast publicly instead. Held as a pending promise so
  // the swap genuinely waits for an answer rather than guessing one.
  const [fallbackPrompt, setFallbackPrompt] = useState<{
    reason: string;
    resolve: (accepted: boolean) => void;
  } | null>(null);

  const tokenIn = tokenBySymbol(tokenInSymbol);
  const tokenOut = tokenBySymbol(tokenOutSymbol);

  const setMode = useCallback((next: View) => {
    setModeState(next);
    // Remembered per browser, never in the config: a view is not a setting,
    // and a config carrying it would stop matching the preset.
    saveView(next);
  }, []);

  // A shared transaction's `#receipt=` link, shown once a network service is
  // chosen and read through it. Its tile is the one open on load.
  const receipt = useReceiptLink();

  // The page's one polite live region, in the status widget: it says only
  // what the widget and `reveal` hand it.
  const [live, setLive] = useState("");
  const announce = useCallback((message: string) => setLive(message), []);

  // Which tile is open (on load: a shared receipt, else Welcome while it
  // shows, else Buy SPX), and `reveal` for everything that points at a place
  // (lib/tiles.ts, lib/places.tsx).
  const tiles = useTilesState({
    view: mode,
    setView: setMode,
    expertOnly: isExpertOnly,
    announce,
    initial: initialOpen({
      receiptPending: receipt.target !== null,
      // Welcome's own `shown` waits for the network service; this is what the
      // browser and the config already say (the same test as the Features
      // effect below).
      welcomeShown: !welcomeStore().get() && WELCOME_CHAINS.has(config.chainId),
    }),
  });
  const { reveal } = tiles;

  // ── The disclaimer, before anything else ────────────────────────────────

  // Shown on a first visit and whenever its text changes (its version), and
  // again from the footer for review. While it shows, the page behind is
  // inert; after it closes, the page stays inert a moment longer
  // (`ARM_AFTER_MS`), so neither the key or click that closed it nor the
  // second half of a double click or double tap can land on the page: on a
  // shared settings link, what sits under the pointer may be "Apply these
  // settings" (UI rule R2, docs/ARCHITECTURE.md).
  const [disclaimerStore] = useState(() => createPrefStore(DISCLAIMER_PREF, pageStorage(), pageEvents()));
  const disclaimerVersion = usePref(disclaimerStore);
  const [reviewing, setReviewing] = useState(false);
  const firstVisitGate = !disclaimerSeen(disclaimerVersion);
  const gateOpen = firstVisitGate || reviewing;
  const [pageInert, setPageInert] = useState(gateOpen);
  useEffect(() => {
    if (gateOpen) {
      setPageInert(true);
      return;
    }
    const timer = setTimeout(() => setPageInert(false), ARM_AFTER_MS);
    return () => clearTimeout(timer);
  }, [gateOpen]);
  // Where focus goes back to after a review: what opened it (the footer's
  // link). The dialog can't put it back itself, since the page is still inert
  // when the dialog closes; once the page takes input again, it goes back.
  const gateOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pageInert) return;
    const opener = gateOpener.current;
    gateOpener.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [pageInert]);
  const reviewDisclaimer = useCallback(() => {
    gateOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReviewing(true);
  }, []);
  const onGateDone = useCallback(() => {
    if (firstVisitGate) disclaimerStore.set(DISCLAIMER_VERSION);
    setReviewing(false);
  }, [firstVisitGate, disclaimerStore]);

  // Aa DISPLAY: the dock, in flow under the masthead (pinned open on wide
  // screens, at every text size).
  const [displayOpen, setDisplayOpen] = useState(false);

  // ── Quotes ──────────────────────────────────────────────────────────────

  // Every quote request gets a number, and only the newest may land. Without
  // this, a slow quote for yesterday's settings or last account could arrive
  // after a newer one and replace it on screen.
  const quoteSeq = useRef(0);
  const quoteRef = useRef<QuoteResult | null>(null);
  quoteRef.current = quote;

  const clearQuote = useCallback(() => {
    quoteSeq.current += 1;
    setQuote(null);
    setQuoting(false);
    setQuoteFailure(null);
  }, []);


  useEffect(() => {
    // Also on hashchange, not just on mount: pasting a config link into an
    // already-open tab is a normal thing to do, and a fragment-only navigation
    // does not reload the page, so a mount-only check would silently ignore it.
    const check = () => {
      const fromUrl = stagedConfigFromUrl();
      if (!fromUrl) return;
      if (fromUrl.kind === "error") setStagedError(fromUrl.error);
      else setStaged(fromUrl.config);
      clearUrlFragment();
    };

    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  /**
   * A new engine when anything it is built from changes — and only then.
   *
   * RPC, runtime choice and Guard settings are fixed at construction, so
   * reusing one across such a change would quietly keep the old settings. But
   * auto-buy plans and the preset marker are not among them: pausing a
   * plan or adding one rewrites the config, and rebuilding the Engine for that
   * would re-discover every pool and throw away the price on screen for no
   * reason. So the memo is keyed on the config without those two.
   */
  const engineKey = quotingKey(config);
  const engine = useMemo(
    () => (config.rpc.url ? new Engine(config) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on engineKey, which is `config` minus dca and preset
    [engineKey],
  );

  // The page's rates, read through this engine's network service only when
  // something on screen needs a money figure or an amount typed in money.
  const pricing = usePricing(engine, moneyPrefs);

  const applyConfig = useCallback(
    (next: SpdexConfig) => {
      // The previous quote was produced under different settings; keeping it
      // on screen would misrepresent what a swap would now do. Unless only
      // plans or the preset marker changed, which no quote depends on.
      if (quotingKey(next) !== quotingKey(configRef.current)) clearQuote();
      configRef.current = next;
      setConfig(next);
      saveConfig(next);
    },
    [clearQuote],
  );

  /**
   * The built-in service, with no screen, where this copy is published: a
   * config with no service yet gets it, and saves it, only once the first
   * visit's disclaimer, which names it, has been continued past. Nothing is
   * sent before: the Engine, and every read, exists only once there is a URL.
   * A service the person chose, or Change service's empty "user", is never
   * touched. Another build's key is never saved over here, only read as this
   * build's (`builtInServiceInUse`): two builds open side by side would
   * otherwise save their keys over each other's without end.
   */
  useEffect(() => {
    if (firstVisitGate) return;
    const current = configRef.current;
    const next = builtInServiceToSave(current, builtIn);
    if (next !== current) applyConfig(next);
  }, [firstVisitGate, builtIn, config.rpc.url, config.rpc.source, applyConfig]);

  /** Another tab running an older spDEX saved settings, and this tab put its own back (`OLDER_TAB_TEXT`). */
  const [olderTab, setOlderTab] = useState(false);

  /**
   * Adopt what another tab saved, as this tab's config, without saving it
   * again (see `watchConfigFromOtherTabs`). For auto-buy this is money: a plan
   * paused in one tab must be paused in the tab that runs the buys.
   */
  useEffect(
    () =>
      watchConfigFromOtherTabs(
        (saved) => {
          // Another build's key, from a tab left open across a release, reads
          // as this build's, and is not saved back (`builtInServiceInUse`).
          const next = builtInServiceInUse(saved, builtIn);
          if (quotingKey(next) !== quotingKey(configRef.current)) clearQuote();
          configRef.current = next;
          setConfig(next);
        },
        undefined,
        readConfigForAdoption,
        {
          // A tab running an older spDEX saved settings. They are never
          // adopted (they would drop what this version added, a second
          // opinion among them); this tab's go back into storage, and it
          // says so.
          current: () => configRef.current,
          onOlderTab: () => setOlderTab(true),
        },
      ),
    [clearQuote, builtIn],
  );

  // ── The wallet ──────────────────────────────────────────────────────────

  const accountRef = useRef(account);
  accountRef.current = account;

  /**
   * Keep up with the wallet after connecting.
   *
   * Checking the chain once at connect time is not enough, and the gap is not
   * theoretical: MetaMask commonly returns to Ethereum Mainnet on reload, and
   * the user can switch network or account whenever they like. Without this,
   * spDEX carried on quoting against its configured network service while the
   * wallet prepared to sign somewhere else entirely — so the price on screen
   * and the transaction in the wallet described two different chains.
   *
   * Dropping the account on a mismatch is deliberate. There is no safe partial
   * state here: an account on the wrong chain has the wrong balances, the
   * wrong allowances and the wrong nonce, so the honest move is to stop and
   * say so.
   */
  useEffect(() => {
    const stale = () => {
      setAccount(null);
      clearQuote();
      setStatus(null);
    };

    return watchWallet({
      onChainChanged: (chainId) => {
        if (chainId === config.chainId) {
          setWrongChain(null);
          return;
        }
        setWrongChain(chainId);
        stale();
      },
      onAccountsChanged: (next) => {
        // The same account again (some wallets repeat it on connect) changes
        // nothing, and clearing here would throw away the quote the connect
        // is about to upgrade.
        if (next === accountRef.current) return;
        // A different account has different balances and allowances; a null
        // one means the user disconnected the site in their wallet.
        setAccount(next);
        clearQuote();
      },
    });
  }, [config.chainId, clearQuote]);

  // Also on mount: a page can load with the wallet already on another chain,
  // which fires no event because, from the wallet's point of view, nothing
  // changed. Re-run on config.chainId so that choosing a matching service
  // *clears* the banner — the check has to be able to answer "no mismatch",
  // not only raise one, or a fixed setup keeps warning about itself.
  useEffect(() => {
    let cancelled = false;
    void currentChainId().then((chainId) => {
      // A late answer from a superseded config must not overwrite the current
      // one; without this, switching services quickly flips the banner back.
      if (cancelled) return;
      setWrongChain(chainId !== null && chainId !== config.chainId ? chainId : null);
    });
    return () => {
      cancelled = true;
    };
  }, [config.chainId]);

  // Adopt whatever chain the network service reports. A fork run under its
  // own id is the sane way to run one, and hardcoding 1 would leave the wallet
  // and the app permanently disagreeing with no way to fix it from the UI.
  const onChooseRpc = (url: string, source: "bundled" | "user" | "fallback", chainId: number) =>
    applyConfig({ ...config, chainId, rpc: { url, source } });

  /**
   * Keep adopting it, not just at first run.
   *
   * `chainId` is stored alongside the service but probed only when the
   * service is chosen, so the two drift: a config saved while the fork ran as
   * chain 1 kept claiming chain 1 after the fork moved to 690069. The app then
   * compared the wallet against a stale number and reported a mismatch that
   * did not exist — pointing at the wallet, which was correct, rather than at
   * the config, which was not.
   *
   * The service is the authority here. It is the thing actually answering
   * every query, so if it says 690069 then 690069 is the chain the user is
   * trading on, whatever a previous session wrote down. Probed once per
   * engine; the config is read when the answer arrives, so a plan written in
   * the meantime is not overwritten.
   */
  const [adoptedChain, setAdoptedChain] = useState<{ from: number; to: number } | null>(null);
  /** The built-in service's answer when it refused this engine's first question (`serviceRefusal`), for its notice. */
  const [builtInRefused, setBuiltInRefused] = useState<{ engine: Engine; answer: string } | null>(null);

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;

    void engine
      .rpc("eth_chainId", [])
      .then((raw) => {
        if (cancelled) return;
        const reported = Number.parseInt(raw as string, 16);
        const current = configRef.current;
        if (!Number.isFinite(reported) || reported === current.chainId) return;
        // Announced rather than silent: the chain id decides which chain every
        // signature is valid for, and rewriting it under the user without
        // saying so is exactly the kind of quiet change this app refuses to
        // make elsewhere.
        setAdoptedChain({ from: current.chainId, to: reported });
        applyConfig({ ...current, chainId: reported });
      })
      .catch((error: unknown) => {
        // An unreachable or busy service is already surfaced by the status
        // panel and the first failing quote. The built-in service saying no
        // (a key allowlisted elsewhere, revoked, or out of its month) is
        // different: nobody chose it, so the notice says what happened and
        // offers the ways on. It never switches service by itself.
        if (cancelled || configRef.current.rpc.source !== "bundled") return;
        const answer = serviceRefusal(error);
        if (answer !== null) setBuiltInRefused({ engine, answer });
      });

    return () => {
      cancelled = true;
    };
  }, [engine, applyConfig]);

  /**
   * Whether the network service can test-run a transaction, for the
   * strip and the Network service panel.
   *
   * Asked once per engine, which is after the user chose a service, or passed
   * the disclaimer that names the built-in one — never before, since asking
   * would send their IP address to a service they haven't been told of. An
   * answer that isn't a definite yes or no is shown as "couldn't tell", never
   * as available.
   */
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      engine
        .safetyTestAvailable()
        .then((answer) => safetyTestFrom(answer))
        .catch((): SafetyTest => "unknown")
        .then((state) => {
          if (cancelled) return;
          setSafety(state);
          // "Couldn't tell" is a rate limit or a hiccup, not an answer: ask
          // again in a minute, as the auto-buy screens say it will. A
          // definite yes or no stands for this engine.
          if (state === "unknown") retry = setTimeout(ask, 60_000);
        });
    };
    setSafety("checking");
    ask();
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [engine]);

  // Everything a quote reads, as of this render, for the callbacks below that
  // must stay stable (the connect handler is handed to the auto-buy layer).
  const latest = useRef({ engine, tokenIn, tokenOut, amountInput, pricing, account, balanceIn: null as bigint | null });
  latest.current = { engine, tokenIn, tokenOut, amountInput, pricing, account, balanceIn: null };

  const runQuote = useCallback(async (accountOverride?: `0x${string}`) => {
    const { engine, tokenIn, tokenOut, amountInput, pricing, account, balanceIn } = latest.current;
    if (!engine) return;
    // The token amount the field resolves to now, on this moment's clock: a
    // money amount only while the price it was sized with is fresh. A
    // refusal is not quoted and not an error: the field says what it is and
    // offers the fix, and Get price waits while the field waits on a price.
    const resolved = resolveAmount(amountInput, tokenIn, pricing, performance.now());
    if (!resolved.ok) return;
    const seq = (quoteSeq.current += 1);
    setError(null);
    setQuoteFailure(null);
    setStatus(null);
    afterSwap.clear();
    setQuote(null);
    setQuoting(true);
    try {
      const amountIn = resolved.raw;
      if (amountIn <= 0n) throw new Error("Enter an amount greater than zero.");
      if (tokenIn.symbol === tokenOut.symbol) throw new Error("Choose two different tokens.");
      // More than the connected wallet holds: said here, beside the amount,
      // before anything is quoted. Otherwise the test-run fails for want of
      // funds, reads as a network service that can't run it, and Swap is
      // offered for a transaction that cannot go through. Ether needs some
      // left over for the network fee, so all of it is too much as well.
      // An unread balance (null) is not a reason to refuse.
      const holding = accountOverride === undefined || accountOverride === account ? balanceIn : null;
      if (holding !== null && (isNative(tokenIn) ? amountIn >= holding : amountIn > holding)) {
        throw new Error(notEnoughMessage({ symbol: tokenIn.symbol, held: holding, wanted: amountIn, decimals: tokenIn.decimals, native: isNative(tokenIn), maxAvailable: spendableBalance(holding, tokenIn) > 0n }));
      }

      // A null account is a preview: the route is computed and statically
      // checked, but nothing is simulated, because there is no signer whose
      // balances a simulation could use.
      const result = await engine.quote({ tokenIn, tokenOut, amountIn, account: accountOverride ?? account });
      if (seq !== quoteSeq.current) return;
      setQuote(result);
      // The network fee is said beside the price, read from the service in
      // use once the route is known; a failed read leaves the line out. It is
      // the price the swap will bid: `privateGasPrice` sent privately, else
      // the fees the wallet is asked for (`readWalletFees`).
      setQuoteFeePerGas(null);
      const feeRead =
        configRef.current.submitter.mode === "private" ? privateGasPrice(engine.rpc) : readWalletFees(engine.rpc).then(feePerGasNow);
      void feeRead
        .then((perGas) => {
          if (seq === quoteSeq.current) setQuoteFeePerGas(perGas);
        })
        .catch(() => undefined);
      setQuoteFeeLevel(null);
      void readFeeLevel(engine.rpc).then((level) => {
        if (seq === quoteSeq.current) setQuoteFeeLevel(level);
      });
      setQuoteId(seq);
      setPools(result.pools);
      // The quote found the markets, so discovery's earlier failure is over.
      setDiscoveryFailed(null);
    } catch (quoteError) {
      if (seq === quoteSeq.current) {
        const message = quoteError instanceof Error ? quoteError.message : String(quoteError);
        setError(message);
        setQuoteFailure(message);
      }
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, []);

  const onQuote = useCallback(() => void runQuote(), [runQuote]);

  /**
   * The amount field changed. A price on screen for another amount goes: the
   * field and "You pay" must never disagree, and a quote is only ever for
   * the token amount the field resolves to now.
   */
  const onAmountInput = useCallback(
    (next: AmountInput) => {
      setAmountInput(next);
      // A failed price was for the amount that was there; the banner at the top stays.
      setQuoteFailure(null);
      const shown = quoteRef.current;
      if (shown === null) return;
      const { tokenIn, pricing } = latest.current;
      const resolved = resolveAmount(next, tokenIn, pricing, performance.now());
      if (!resolved.ok || resolved.raw !== shown.route.amountIn) clearQuote();
    },
    [clearQuote],
  );

  const onConnect = useCallback(async () => {
    setError(null);
    // A preview on screen is upgraded as soon as there is an account to check
    // it for: the person just connected so they could swap, and a second
    // click on "Refresh price" is a step they would have to discover.
    const hadPreview = quoteRef.current?.previewOnly === true;
    try {
      const { address, chainId } = await connect();
      if (chainId !== configRef.current.chainId) {
        // Not an error to read and solve by hand: offer to add the network,
        // which also saves it in the wallet for next time. The banner is at
        // the top of the page, a screen or more above the Connect button on
        // a phone, so it is brought into view: otherwise the button just
        // seemed not to work.
        setWrongChain(chainId);
        void reveal("wrong-chain", { block: "center" });
        return;
      }
      setWrongChain(null);
      setAccount(address);
      if (hadPreview) void runQuote(address);
    } catch (connectError) {
      if (!isUserRejection(connectError)) {
        setError(connectError instanceof Error ? connectError.message : String(connectError));
      }
    }
  }, [runQuote, reveal]);

  const onConnectClick = useCallback(() => void onConnect(), [onConnect]);

  /**
   * Chains a wallet defines for itself, and will not let a page redefine.
   *
   * Offering "add this network" for one of these is worse than useless. In the
   * best case the wallet refuses, because it already owns the definition of
   * chain 1. In the worst — a wallet that accepts it — the user has just
   * registered `http://127.0.0.1:8545` as their Ethereum Mainnet service,
   * which is a far bigger problem than the mismatch they were trying to fix.
   *
   * Deliberately short. It is not a registry of every public chain, just the
   * ones a wallet ships with, and the fallback for anything not listed is the
   * existing offer — which is correct for exactly the custom networks this
   * button exists to add.
   */
  const WALLET_DEFINED_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 11155111]);
  const canOfferAddNetwork = !WALLET_DEFINED_CHAINS.has(config.chainId);

  /** A network the wallet knows already: ask it to switch, then connect as before. */
  const onSwitchNetwork = async () => {
    setError(null);
    try {
      if (await switchChain(config.chainId)) {
        setWrongChain(null);
        await onConnect();
      }
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    }
  };

  const onAddNetwork = async () => {
    if (!config.rpc.url) return;
    setError(null);
    try {
      const added = await addAndSwitchChain({
        chainId: config.chainId,
        rpcUrl: config.rpc.url,
        chainName: `spDEX (chain ${config.chainId})`,
      });
      if (added) {
        setWrongChain(null);
        await onConnect();
      }
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  // ── Auto-buy (`AutoBuyDeps` is the whole of what it is given) ───────────

  // One lock on the owner's wallet for the whole page: a manual swap, a
  // confirmed auto-buy and a vault transaction must never interleave prompts.
  const ownerLock = useMemo(() => new OwnerWalletLock(), []);
  const subscribeLock = useCallback((listener: () => void) => ownerLock.subscribe(listener), [ownerLock]);
  const lockBusy = useSyncExternalStore(subscribeLock, () => ownerLock.isBusy());

  const walletChainOk = wrongChain === null && account !== null;
  const recurringOpen = buyMode === "recurring";
  const autoBuyDeps: AutoBuyDeps = useMemo(
    () => ({
      engine,
      config,
      applyConfig,
      account,
      walletChainOk,
      onConnect: onConnectClick,
      ownerLock,
      mode,
      pricing,
      safety,
      recurringOpen,
    }),
    [engine, config, applyConfig, account, walletChainOk, onConnectClick, ownerLock, mode, pricing, safety, recurringOpen],
  );
  const autoBuy = useAutoBuy(autoBuyDeps);

  // ── Balances, Welcome and records (Your activity, Your stack) ───────────

  // Each plan buy this page sees settle keeps the rates the page held then,
  // as its value at the time.
  useRecordPriceSnapshots(autoBuy.ledger, pricing, { chainId: config.chainId });

  const rpc = engine?.rpc ?? null;
  // Whose figures a balance read is: this network, through this service.
  const balanceKey = `${config.chainId}:${config.rpc.url ?? ""}`;

  // The One-time card's balances. They come from the chain rather than the
  // wallet: a wallet that has not been told about a token displays nothing,
  // which is indistinguishable from holding none of it. Read again after
  // each swap that moved money; one that can't be read is unknown.
  const refresh = String(afterSwap.settled);
  const balanceIn = useBalance(rpc, tokenIn.address, account, { enabled: true, key: balanceKey, refresh });
  // For Get price's check against what the wallet holds (`runQuote`).
  latest.current.balanceIn = balanceIn === "unreadable" ? null : balanceIn;
  const balanceOut = useBalance(rpc, tokenOut.address, account, { enabled: true, key: balanceKey, refresh });

  const welcome = useWelcome({
    rpc,
    chainId: config.chainId,
    account,
    cardEth: isNative(tokenIn) ? balanceIn : undefined,
    balanceKey,
    refresh,
    // The page's own reveal: this hook runs above the tiles' provider.
    reveal,
  });
  // Hiding Welcome while it is open leaves Buy SPX open in its place, never a
  // page of closed headers (the same rule as on load, lib/tiles.ts).
  const welcomeWasHidden = useRef(welcome.hidden);
  const { openId: openTileId, open: openTileById } = tiles;
  useEffect(() => {
    if (welcome.hidden && !welcomeWasHidden.current && openTileId === "start") openTileById("trade");
    welcomeWasHidden.current = welcome.hidden;
  }, [welcome.hidden, openTileId, openTileById]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [stackSeen, stackRef] = useSeenOnScreen<HTMLDivElement>();
  // One read of the records for the page, handed to every panel that shows
  // them. Reads happen only while one of those is in use: Your activity is
  // open, Your stack has been on screen, or Welcome is waiting for a first buy.
  const records = useRecords({
    active: activityOpen || stackSeen || (welcome.shown && account !== null),
    account,
    chainId: config.chainId,
    plans: config.dca.plans,
    ledger: autoBuy.ledger,
    vaultFor: autoBuy.vaultFor,
    rpc,
  });
  // Your stack reads the SPX the wallet holds only once it has been on
  // screen. The trade card reads it anyway while SPX is one side of its pair,
  // and the stack uses that until then: its tile's header said "not read
  // yet" beside a Buy tile saying how much had just arrived.
  const spxOnTradeCard =
    tokenOut.symbol === SPX.symbol && typeof balanceOut === "bigint"
      ? balanceOut
      : tokenIn.symbol === SPX.symbol && typeof balanceIn === "bigint"
        ? balanceIn
        : null;
  const stack = useStackInputs({
    heldElsewhere: spxOnTradeCard,
    rpc,
    account,
    chainId: config.chainId,
    plans: config.dca.plans,
    autoBuy,
    seen: stackSeen,
    balanceKey,
    refresh,
  });

  // "● Buy due — " in the tab title while a wallet-mode buy waits for a click,
  // so a person in another tab can see it without spDEX opening anything.
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (baseTitle.current === null) baseTitle.current = document.title;
    document.title = autoBuy.buyDue ? `● Buy due — ${baseTitle.current}` : baseTitle.current;
  }, [autoBuy.buyDue]);

  /**
   * Applies a config that may remove plans, after the person agrees to that —
   * with any vault plan that may still hold money or buy kept as it is, since
   * its config entry is spDEX's only way back to its vault.
   */
  const applyIfPlansAgreed = useCallback(
    async (incoming: SpdexConfig): Promise<boolean> => {
      // A shared or imported config with no service address keeps this
      // browser's service (`withOwnService`), as its review showed.
      const next = withOwnService(incoming, configRef.current);
      const agreed = await autoBuy.confirmPlanRemoval(next);
      if (agreed === null) return false;
      applyConfig(agreed);
      return true;
    },
    [autoBuy, applyConfig],
  );

  // The plans, from the status widget's PLANS row: the Auto-buys tile, opened at its panel.
  const toPlans = useCallback(() => void reveal("dca-panel", { block: "start" }), [reveal]);

  // A click on a "buy due" notification, once the tab is in front: the due
  // buy's banner, in the Auto-buys tile. Focus goes to the banner itself,
  // never to its Confirm button (UI rule R2, `reveal`).
  useEffect(
    () =>
      onBuyDueClick(() => {
        void reveal("dca-due", { block: "center" }).then((found) => {
          if (!found) void reveal("dca-panel", { block: "start" });
        });
      }),
    [reveal],
  );

  // A click on a "proof lapses soon" reminder: Community keeping, unfolded,
  // at the foot of Help run the network; or Help run itself, when it hasn't
  // been opened yet and so hasn't drawn the fold.
  useEffect(
    () =>
      onProofLapseClick(() => {
        void reveal("keeper-panel", { block: "center" }).then((found) => {
          if (!found) void reveal("help-run-panel", { block: "start" });
        });
      }),
    [reveal],
  );

  // The Tip row, from the Features dialog. The row itself takes focus, not a
  // tip chip: a chip changes a setting (UI rule R2).
  const goToTip = useCallback(() => {
    setFeaturesOpen(false);
    setBuyMode("once");
    // After the dialog unmounts, so the row is where it will stay.
    requestAnimationFrame(() => void reveal("tip-row", { block: "center" }));
  }, [reveal]);

  // The Recurring tab's amount, from the Features dialog or a Welcome step.
  // From a step, "← Back to steps (n of 4)" returns to it (`returnTo`).
  const goToRecurring = useCallback(
    (from?: HTMLElement, backLabel?: string) => {
      setFeaturesOpen(false);
      setBuyMode("recurring");
      // After the dialog unmounts and the tab shows, so the field can take focus.
      requestAnimationFrame(
        () => void reveal("dca-form-amount", from !== undefined ? { returnTo: from, ...(backLabel ? { backLabel } : {}) } : {}),
      );
    },
    [reveal],
  );

  // ── Pools, statistics and prices ────────────────────────────────────────

  const pairKey = `${tokenIn.address}>${tokenOut.address}`;

  /**
   * Discover markets for the pair on screen, in both views.
   *
   * The statistics panel and the expert picker both need the list, and
   * discovery is cached per pair on the Engine, so asking eagerly costs one
   * round trip per pair rather than one per render.
   */
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const key = pairKey;
    void engine
      .discoverPools(tokenIn, tokenOut)
      .then((found) => {
        if (cancelled) return;
        setPools(found);
        setDiscoveredFor({ engine, key });
        setDiscoveryFailed(null);
      })
      .catch(() => {
        // The service didn't answer (busy, capped, refusing): the swap panel
        // surfaces why, and the panels say the markets are unknown, never
        // that there are none. The Engine keeps no failed answer, so asking
        // again in a minute, or getting a price, reads them afresh.
        if (cancelled) return;
        setPools([]);
        setDiscoveredFor({ engine, key });
        setDiscoveryFailed({ engine, key });
        retry = setTimeout(() => setDiscoveryRetry((n) => n + 1), DISCOVERY_RETRY_MS);
      });
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pairKey stands in for the two tokens
  }, [engine, pairKey, discoveryRetry]);

  /**
   * Statistics for the markets on screen.
   *
   * Driven by the discovered list rather than by a quote, so the panel is
   * populated before anyone types an amount — "where is the liquidity" is a
   * question people ask *instead* of quoting, not after. Keyed on the pool ids
   * rather than on the array, whose identity changes on every render.
   */
  const poolKey = pools.map((pool) => pool.poolId).join(",");
  const lastPoolKey = useRef(poolKey);

  useEffect(() => {
    const key = poolKey;
    if (!engine || pools.length === 0) {
      setStats({ pools: [], loading: false, volumeBlocks: 0 });
      setStatsFor({ engine, key });
      return;
    }
    let cancelled = false;
    // Another pair's markets must not sit under this pair's heading while
    // these load; the same markets after a settings change may.
    const samePools = lastPoolKey.current === key;
    lastPoolKey.current = key;
    setStats((previous) => (samePools ? { ...previous, loading: true } : { pools: [], loading: true, volumeBlocks: 0 }));

    void engine
      .poolStats(pools)
      .then((result) => {
        if (cancelled) return;
        setStats({
          pools: priceStats({ stats: result.stats, volumes: result.volumes, rates: result.rates }),
          loading: false,
          volumeBlocks: result.volumeBlocks,
          ...(result.volumeNote === undefined ? {} : { volumeNote: result.volumeNote }),
        });
        // The same TWAP prices the Guard checks against, for the ticker.
        setStatsRates(result.rates);
        setStatsFor({ engine, key });
      })
      .catch(() => {
        // Statistics are never load-bearing; an empty panel is the failure mode.
        if (cancelled) return;
        setStats({ pools: [], loading: false, volumeBlocks: 0 });
        setStatsFor({ engine, key });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolKey stands in for `pools`
  }, [engine, poolKey]);

  const trackerOn = featureById(TRACKER_FEATURE_ID)?.isEnabled(config) ?? false;
  const discovering = engine !== null && (discoveredFor?.engine !== engine || discoveredFor.key !== pairKey);
  const discoveryDown = engine !== null && discoveryFailed?.engine === engine && discoveryFailed.key === pairKey;
  const reading = pools.length > 0 && (statsFor?.engine !== engine || statsFor.key !== poolKey);
  const statsPhase: PoolStatsPhase = !trackerOn
    ? "off"
    : discovering
      ? "discovering"
      : discoveryDown
        ? "failed"
        : reading
          ? "reading"
          : "ready";

  /**
   * SPX's total supply, for the ticker's "% to flip": market cap is the
   * supply times the dollar rate the statistics above already priced.
   *
   * One `eth_call` to the token, through this engine's network service like
   * every other read, and only while pool statistics are on: without them
   * there is no rate to multiply it by, and the read would ask the network for
   * a number nothing shows. Asked again now and then (`SUPPLY_REFRESH_MS`),
   * never on a render. A failed read is unknown, not zero, so the ticker
   * leaves the item out until one succeeds.
   *
   * Kept with the engine that read it, and used only while that engine is
   * current: a supply read through another service may be another chain's.
   */
  const [spxSupply, setSpxSupply] = useState<{ engine: Engine; supply: bigint } | null>(null);

  useEffect(() => {
    if (!engine || !trackerOn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      totalSupply(engine.rpc, SPX.address)
        .then((supply) => {
          if (cancelled) return;
          setSpxSupply({ engine, supply });
          timer = setTimeout(read, SUPPLY_REFRESH_MS);
        })
        .catch(() => {
          // An earlier answer for this engine stays: a supply an hour old is
          // still the supply, to four significant digits.
          if (!cancelled) timer = setTimeout(read, SUPPLY_RETRY_MS);
        });
    };
    read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [engine, trackerOn]);

  // Every vault's buys, as Collective DCA last read them, for the ticker.
  const collective = useCollectiveBuys(engine);

  /**
   * Offer the choice once, at the point it is a choice.
   *
   * "Opt in during selection" is the whole premise of the feature model, and a
   * dialog nobody is ever shown is not an opt-in — it is a default with extra
   * steps. So the first time a user gets past the network-service screen, the
   * features dialog opens by itself; after that it lives behind a button.
   *
   * Once, tracked outside the config. A dialog that reappeared on every visit
   * would be dismissed reflexively within a week, which is worse than not
   * asking because it teaches people that spDEX's prompts are noise.
   *
   * Not over Welcome, which carries its own way to Features, nor on a visit
   * that came to check a shared transaction: a dialog over either would stand
   * between the person and what they came for. It is then offered on a later
   * visit, not the moment Welcome is hidden, which would answer a click with
   * a dialog nobody asked for.
   */
  useEffect(() => {
    // Never over the disclaimer: it waits until that has closed.
    if (gateOpen || !config.rpc.url || featuresSeen()) return;
    if (receipt.cameFor) return;
    if (!welcomeStore().get() && WELCOME_CHAINS.has(config.chainId)) return;
    setFeaturesOpen(true);
    markFeaturesSeen();
    // Asked when a network service is first chosen, with the chain it reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.rpc.url, gateOpen]);

  /**
   * Warn if the connected account would not keep ether paid to it.
   *
   * Checked once per account rather than per swap: it is a property of the
   * address, and `eth_getCode` is cheap. The Guard would refuse such a swap
   * anyway — it measures what the recipient keeps — but it would do so with a
   * message about receiving nothing, which reads as a bug in spDEX rather than
   * as a fact about the user's wallet.
   */
  useEffect(() => {
    if (!engine || !account) {
      setDelegate(null);
      return;
    }
    let cancelled = false;
    void delegationOf(engine.rpc, account).then((found) => {
      if (!cancelled) setDelegate(found);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, account]);

  // The shipped tip lists, read once there is an engine, tips on or off: the
  // Tip row's picker and Settings → Tips list them, and every new tip address
  // (typed, imported, or in a settings link) is compared with them before
  // it is saved or tipped. Until they are read, those checks say so rather
  // than finding nothing. A registry declares no capabilities and reads
  // nothing, so this costs no RPC. Read whatever the list's switch says
  // (`evenIfOff`): the switch decides whether tips go out, not whether an
  // address is compared with the list.
  const tipsOn = config.tips.enabled;
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    setTipCandidates(null);
    void engine
      .tipCandidates(configRef.current.modules, { evenIfOff: true })
      .then((found) => {
        if (!cancelled) setTipCandidates(found);
      })
      .catch(() => {
        // Shown as an empty list, which the picker says in words.
        if (!cancelled) setTipCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  // ── Who is tipped: "My tip list" and the one function that decides ──────

  // This browser's own tip list (lib/tiplist/store.ts). On the first load of
  // a build that has it, the recipients the loaded config already names were
  // chosen before the first-tip check existed, so they are stamped confirmed,
  // once, and a banner says so. Done as the store is made, with the config
  // the page loaded with: a settings link applied later is not "already
  // chosen" and asks like any other.
  const [tipStore] = useState(() => {
    const store = tipListStore();
    store.migrate(config.tips.recipients, Date.now());
    return store;
  });
  const tipList = useTipList(tipStore);
  const [tipsMigrated, setTipsMigrated] = useState(() => tipStore.migratedNow());
  // The only answer to "who gets tipped" (lib/tiplist/checks.ts): the
  // transfers, the prompt count, the summary card and the Tip row all take
  // it, never `config.tips` directly. A skipped share is not sent.
  // The connected account is skipped rather than refused: TipGuard would
  // refuse the whole tip for it, the others' shares included.
  const tippable = useMemo(
    () => tippableRecipients(config.tips, tipList, tipCandidates, config.chainId, account),
    [config.tips, tipList, tipCandidates, config.chainId, account],
  );
  const tipsToPay = useMemo(() => payablePolicy(config.tips, tippable), [config.tips, tippable]);

  // Which listed entries' signed claims recover their own address: checked
  // here, offline (recovering a signer is arithmetic, not a request).
  const [signedClaims, setSignedClaims] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (tipCandidates === null) return;
    let cancelled = false;
    void Promise.all(
      tipCandidates.map(async (entry) => ((await tipClaimSigned(entry)) ? entry.address.toLowerCase() : null)),
    ).then((found) => {
      if (!cancelled) setSignedClaims(new Set(found.filter((address): address is string => address !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [tipCandidates]);

  // ── Permit2, for tips to two or more people ─────────────────────────────

  // Bumped after anything that may change a Permit2 permission (tips sent, a
  // revoke), so the reads below are taken again.
  const [permit2Reads, setPermit2Reads] = useState(0);

  // Whether Permit2 here is the one spDEX knows, per engine; null until the
  // answer arrives, and for an answer that isn't a definite yes or no.
  const [permit2Known, setPermit2Known] = useState<{ engine: Engine; available: boolean | null } | null>(null);
  useEffect(() => {
    if (!tipsOn || !engine) return;
    let cancelled = false;
    void engine.permit2Available().then((answer) => {
      if (!cancelled) setPermit2Known({ engine, available: answer === "unknown" ? null : answer });
    });
    return () => {
      cancelled = true;
    };
  }, [tipsOn, engine]);

  // Permit2's allowance on the token this swap delivers, for "a standing
  // Permit2 permission" on the Tip row and the summary card. Read only while
  // tips are on and a wallet is connected; unread is unknown, never zero.
  const [tipAllowance, setTipAllowance] = useState<{ key: string; value: bigint | null } | null>(null);
  const tipAllowanceKey = `${account ?? ""}:${tokenOut.address}:${permit2Reads}`;
  useEffect(() => {
    if (!tipsOn || !engine || !account || isNative(tokenOut)) return;
    let cancelled = false;
    allowance(engine.rpc, tokenOut.address, account, PERMIT2_ADDRESS)
      .then((value): bigint | null => value)
      .catch((): bigint | null => null)
      .then((value) => {
        if (!cancelled) setTipAllowance({ key: tipAllowanceKey, value });
      });
    return () => {
      cancelled = true;
    };
  }, [tipsOn, engine, account, tokenOut, tipAllowanceKey]);

  // Why a batch can't work for a wallet, found by a swap's tips earlier in
  // this session (it couldn't sign typed data, or the batch reverts for its
  // account), by lowercase address. Kept for the page's life only: asking
  // again would repeat the prompts before the same failure, and a standing
  // permission granted for nothing.
  const [tipBatchUnusable, setTipBatchUnusable] = useState<Readonly<Record<string, string>>>({});
  const batchUnusableFor = (who: string | null) => (who === null ? null : tipBatchUnusable[who.toLowerCase()] ?? null);

  const tipPermit2 = {
    available: permit2Known !== null && permit2Known.engine === engine ? permit2Known.available : null,
    allowance: tipAllowance !== null && tipAllowance.key === tipAllowanceKey ? tipAllowance.value : null,
    batchable: batchUnusableFor(account) === null,
  };

  const readPermit2Allowance = useCallback(
    (token: TokenInfo) => {
      if (!engine || !account) return Promise.reject(new Error("no wallet connected"));
      return allowance(engine.rpc, token.address, account, PERMIT2_ADDRESS);
    },
    [engine, account],
  );

  /**
   * Revoke the Permit2 permission on one token (Expert → Tips): exactly
   * `approve(PERMIT2, 0)`, checked by the Guard, then the wallet. Holds the
   * owner's wallet lock like any other prompt, so it never interleaves with
   * a swap or an auto-buy. Resolves to the sentence the panel shows.
   */
  const revokePermit2 = useCallback(
    async (token: TokenInfo, onSent?: () => void): Promise<string> => {
      if (!engine || !account) return "Connect a wallet first.";
      if (!ownerLock.tryAcquire()) return "Your wallet is busy with another request. Try again when it finishes.";
      try {
        const plan = buildPermit2Permission("revoke", {
          chainId: config.chainId,
          account,
          token: token.address,
        });
        const verdict = await engine.checkTipPermission(plan);
        if (!verdict.signable) {
          return `Not sent — spDEX refused it: ${verdict.violations.map((v) => v.code).join(", ")}.`;
        }
        const result = await submit(
          config.submitter,
          account,
          { ...plan.call, chainId: config.chainId },
          askPublicFallback,
          undefined,
          engine.rpc,
        );
        onSent?.();
        await confirmTransaction(result.hash, {
          rpc: engine.rpc,
          ...(config.submitter.mode === "private" ? { timeoutMs: PRIVATE_CONFIRM_TIMEOUT_MS } : {}),
        });
        return `Revoked: Permit2 can no longer move your ${token.symbol}.`;
      } catch (thrown) {
        if (isUserRejection(thrown)) return "Cancelled in your wallet.";
        return `Not revoked: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
      } finally {
        ownerLock.release();
        setPermit2Reads((n) => n + 1);
      }
    },
    // askPublicFallback only sets state; it is safe to capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, account, config.chainId, config.submitter, ownerLock],
  );

  const permit2Panel = useMemo(
    () => ({ account, tokens: TIP_TOKENS, readAllowance: readPermit2Allowance, revoke: revokePermit2 }),
    [account, readPermit2Allowance, revokePermit2],
  );

  // ── The One-time swap ───────────────────────────────────────────────────

  const choosePair = (next: { in: string; out: string }) => {
    setTokenInSymbol(next.in);
    setTokenOutSymbol(next.out);
    // A price for the old pair under the new pair's selects would describe a
    // trade nobody asked for.
    clearQuote();
    savePair(next);
  };

  /**
   * Ask before broadcasting publicly when privacy was requested.
   *
   * Resolves only when the user answers. Silently downgrading here would be the
   * worst option available: the user sized their trade believing it was
   * protected from front-running, and it would not have been.
   */
  const askPublicFallback = (reason: string) =>
    new Promise<boolean>((resolve) => setFallbackPrompt({ reason, resolve }));

  const answerFallback = (accepted: boolean) => {
    fallbackPrompt?.resolve(accepted);
    setFallbackPrompt(null);
  };

  /**
   * Send the tips, after the swap and only if it delivered something.
   *
   * Deliberately not fatal. By the time this runs the user's swap has already
   * executed and settled; throwing here would report a completed swap as a
   * failure and invite them to run it again. A tip that could not be sent is
   * reported as exactly that, and the swap is still reported as done. The
   * steps, and the fallbacks between one Permit2 transaction and a transfer
   * each, are lib/tipFlow.ts.
   *
   * The Guard is not optional even though the host composed these calls
   * itself — see packages/guard/src/tips.ts for why "we wrote it" has never
   * been grounds for skipping the check. That includes the signature a batch
   * rests on and the standing permission for Permit2.
   *
   * Resolves to the sentence for the status line, and the flow's whole
   * outcome when tips were attempted: its transactions go into this
   * browser's record with the swap.
   */
  const sendTips = async (options: {
    balanceBefore: bigint | null;
    askOnce: (reason: string) => Promise<boolean>;
    reads: ReadRpc;
    confirmOptions: ConfirmOptions;
    account: `0x${string}`;
    /** The swap's prompt counter, which the tips' prompts continue. */
    counter: StepCounter;
  }): Promise<{ note: string; outcome: TipOutcome | null }> => {
    const skipped = (note: string) => ({ note, outcome: null });
    if (!engine || !config.tips.enabled || config.tips.recipients.length === 0) return skipped("");
    // Chosen, but nobody `tippableRecipients` lets through: not confirmed,
    // retired, or an address no tip may go to. The Tip row says which.
    if (tipsToPay.recipients.length === 0) return skipped(" No tip sent: nobody chosen can be tipped yet.");
    // A tip is an ERC-20 transfer of what arrived, and ether is not an ERC-20.
    // Said rather than attempted: the Guard would refuse the transfer anyway,
    // and a refusal reads as something going wrong when nothing did. The Tip
    // row says the same before the swap.
    if (isNative(tokenOut)) return skipped(" No tip on this swap: tipping in ETH isn't built yet.");
    if (options.balanceBefore === null) {
      return skipped(" Tips skipped: the delivered amount could not be read.");
    }

    let delivered: bigint;
    try {
      delivered = (await balanceOf(engine.rpc, tokenOut.address, options.account)) - options.balanceBefore;
    } catch {
      return skipped(" Tips skipped: the delivered amount could not be read.");
    }
    const provider = detectProvider();
    const outcome = await sendTipsFlow({
      checks: engine,
      chainId: config.chainId,
      account: options.account,
      token: tokenOut,
      delivered,
      transfers: tipTransfersFor(tipsToPay, delivered),
      readAllowance: () => allowance(options.reads, tokenOut.address, options.account, PERMIT2_ADDRESS),
      readNonceBitmap: (word) => permit2NonceBitmap(options.reads, options.account, word),
      signTypedData: (typedData) => {
        if (!provider) return Promise.reject(new Error("no EIP-1193 wallet available"));
        return provider.request({ method: "eth_signTypedData_v4", params: [options.account, typedData] });
      },
      send: async (call) => {
        // The chain goes with each call, so a wallet switched to another
        // network while the checks ran is refused rather than signing there.
        const result = await submit(
          config.submitter,
          options.account,
          { ...call, chainId: config.chainId },
          options.askOnce,
          undefined,
          options.reads,
        );
        // The hash is what lets the tip be kept in this browser's record: the
        // one mined, which a wallet's "Speed up" may have replaced.
        return (await confirmTransaction(result.hash, options.confirmOptions)) as Hex;
      },
      onStep: (step) => setStatus(stepText(step)),
      counter: options.counter,
      batchUnusable: batchUnusableFor(options.account),
    });
    // A permission granted or a permit spent changes what the Tip row says
    // the next swap will ask for.
    setPermit2Reads((n) => n + 1);
    const unusable = outcome.batchUnusable;
    if (unusable !== undefined) {
      setTipBatchUnusable((was) => ({ ...was, [options.account.toLowerCase()]: unusable }));
    }
    return { note: outcome.note, outcome };
  };

  const onSwap = async () => {
    if (!engine || !quote || !account) return;
    if (!quote.verdict.signable) return;

    // The owner's wallet takes one sequence of prompts at a time. If a
    // wallet-mode auto-buy is being confirmed, the button is already disabled
    // with "Waiting for your auto-buy to finish…"; this is the backstop.
    setSwapping(true);
    if (!ownerLock.tryAcquire()) {
      setSwapping(false);
      return;
    }
    setError(null);
    afterSwap.clear();
    let lastVia: SentVia | null = null;

    // Asked once per swap, not once per transaction.
    //
    // A swap can send an approval and one call per leg, and a wallet that
    // cannot sign privately cannot sign privately for any of them — so asking
    // each time means up to five identical prompts for one decision. That is
    // not extra safety, it is prompt fatigue, which trains people to click
    // through exactly the dialog you most want them to read.
    let fallbackDecision: boolean | null = null;
    const askOnce = async (reason: string) => {
      if (fallbackDecision === null) fallbackDecision = await askPublicFallback(reason);
      return fallbackDecision;
    };

    // Receipts and gas estimates are read through the user's own service
    // rather than the wallet's — see the `reads` note in lib/submit.ts — and a
    // relay needs longer to land a transaction than a public broadcast does.
    const reads = engine.rpc;
    const confirmOptions = {
      rpc: reads,
      ...(config.submitter.mode === "private" ? { timeoutMs: PRIVATE_CONFIRM_TIMEOUT_MS } : {}),
    };

    // Read before anything executes. Tips are a share of what the swap actually
    // delivered, and the only honest way to know that is to measure it: the
    // quote is a prediction, and tipping a percentage of a prediction pays the
    // recipient out of the user's slippage whenever the swap underdelivers.
    let balanceBefore: bigint | null = null;
    try {
      balanceBefore = await balanceOf(engine.rpc, tokenOut.address, account);
    } catch {
      // A balance we could not read means tips are skipped below, with a note.
    }
    // What goes into this browser's record once the swap has moved money.
    const recordOf = (result: RecordSwapInput["result"]): RecordSwapInput => ({
      rpc: engine.rpc,
      chainId: config.chainId,
      account,
      quote,
      result,
      pricing,
      ...(isNative(tokenOut) ? { ethBefore: balanceBefore } : {}),
    });

    try {
      // "(step i of n)" must be exact, so the permissions still needed are
      // counted before the first prompt: every leg's allowance is read now,
      // and only a short one counts. An allowance that can't be read counts as
      // needed; execution reads it again and stops there if it still can't.
      let permissions = 0;
      for (const leg of quote.legs) {
        for (const approval of leg.plan.approvals) {
          try {
            if ((await allowance(reads, approval.token, account, approval.spender)) < approval.amount) permissions += 1;
          } catch {
            permissions += 1;
          }
        }
      }
      // The tips' prompts are counted too, from what the page knows now (the
      // same delivery the Tip row and the summary card state), so the swap's
      // own prompt never reads "step 2 of 2" with three more to come. The tip
      // flow settles the count once it has read what it needs.
      const tipsAfter =
        tipsToPay.enabled && tipsToPay.recipients.length > 0
          ? tipPrompts(
              tipDeliveryFor(tipsToPay, {
                native: isNative(tokenOut),
                permit2: tipPermit2.available,
                allowance: tipPermit2.allowance,
                amountOut: quote.route.amountOut,
                batchable: tipPermit2.batchable,
              }),
            )
          : 0;
      const counter = new StepCounter(permissions + quote.legs.length + tipsAfter);

      // The one path from a checked quote to the chain, shared with scheduled
      // buys (lib/execute.ts): every call of every leg, approvals only when
      // the allowance is short, each confirmed before the next.
      const result = await executeQuote(
        quote,
        walletSender({
          submitter: config.submitter,
          account,
          onPublicFallback: askOnce,
          reads,
          // Private sending only: the wallet has signed and spDEX is posting
          // it. Never called on a public broadcast, so "privately" never
          // appears on a path that isn't.
          onSigned: () => setStatus(stepText({ kind: "private" })),
        }),
        reads,
        {
          onStep: (step) =>
            setStatus(
              step.kind === "approve"
                ? stepText({ kind: "permission", symbol: tokenIn.symbol, ...counter.next() })
                : stepText({
                    kind: "swap",
                    deadline: Number(quote.legs[step.leg - 1]?.plan.intent.deadline ?? Number.NaN),
                    ...counter.next(),
                  }),
            ),
          onSent: (hash, _kind, via) => {
            setStatus(stepText({ kind: "wait" }));
            // A swap goes from the wallet or privately; "endpoint" is spDEX's own key, never a swap's.
            setPendingSend({ hash, since: Date.now(), via: via === "private" ? "private" : "wallet", underpriced: null });
          },
          // A wallet's "Speed up": the faster copy is the one waited for now.
          onReplaced: (hash) => setPendingSend((p) => (p === null ? p : { ...p, hash, underpriced: null })),
        },
      );
      // A local, not React state. State set inside this function is not
      // visible to the rest of it, so building the completion message from a
      // state variable read back the previous render's value and silently
      // dropped the "submitted privately" confirmation.
      lastVia = result.via;
      const tips = await sendTips({
        balanceBefore,
        askOnce,
        reads,
        confirmOptions,
        account,
        counter,
      });

      setStatus(
        `Swap complete — ${formatAmount(quote.route.amountOut, tokenOut.decimals)} ${tokenOut.symbol} expected` +
          `${lastVia === "private" ? ", submitted privately" : ""}.${tips.note}`,
      );
      clearQuote();
      afterSwap.moved({ ...recordOf(result), ...(tips.outcome === null ? {} : { tips: tips.outcome }) });
    } catch (thrown) {
      // A swap that stopped part-way still moved money: the legs that went
      // through are kept in the record, as a partial swap.
      if (thrown instanceof ExecutionError && thrown.legsDone > 0) afterSwap.moved(recordOf({ partial: thrown }));
      // Execution wraps what stopped it, with how far it got; the message is
      // the underlying one, and the cause is what says a person declined.
      const swapError = thrown instanceof ExecutionError ? thrown.cause : thrown;
      if (isUserRejection(swapError)) setStatus("Cancelled in your wallet.");
      else if (swapError instanceof PrivateSubmissionUnavailable) {
        setStatus("Cancelled — your wallet cannot submit privately.");
      } else {
        const message = swapError instanceof Error ? swapError.message : String(swapError);
        // The banner at the top says it all, and on a phone it is a screen or
        // more above the button that was just pressed: a line here says that
        // the swap stopped, and where the rest is.
        setStatus(swapProblemLine(friendlyError(message).title));
        setError(message);
      }
    } finally {
      ownerLock.release();
      setSwapping(false);
      setPendingSend(null);
    }
  };

  // A wallet send that is slow: whether the base fee has risen past its
  // highest bid, read once it has waited `SLOW_SEND_MS` and then about once
  // a block. Unknown, the line just says it is waiting.
  const pendingHash = pendingSend !== null && pendingSend.via === "wallet" ? pendingSend.hash : null;
  useEffect(() => {
    if (pendingHash === null || rpc === null) return;
    let stopped = false;
    const look = async () => {
      try {
        const [tx, block] = (await Promise.all([
          rpc("eth_getTransactionByHash", [pendingHash]),
          rpc("eth_getBlockByNumber", ["latest", false]),
        ])) as [{ maxFeePerGas?: string; gasPrice?: string } | null, { baseFeePerGas?: string } | null];
        const bid = tx?.maxFeePerGas ?? tx?.gasPrice;
        const base = block?.baseFeePerGas;
        if (stopped || bid === undefined || base === undefined) return;
        const underpriced = BigInt(bid) < BigInt(base);
        setPendingSend((p) => (p !== null && p.hash === pendingHash ? { ...p, underpriced } : p));
      } catch {
        // No news: the line says it is waiting, and nothing more.
      }
    };
    const first = setTimeout(() => void look(), SLOW_SEND_MS);
    const every = setInterval(() => void look(), SLOW_SEND_MS + 12_000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [pendingHash, rpc]);

  const bundled = builtIn.usable;
  const fallback = publicFallbackRpc();
  const friendly =
    error === null ? null : friendlyError(error, { rpcUrl: config.rpc.url, builtIn: config.rpc.source === "bundled" });
  /** The built-in service turned this engine away, and its notice is up. */
  const refusedNoticeShown = builtInRefused !== null && builtInRefused.engine === engine && config.rpc.source === "bundled";
  // The banner, left out under that notice for an error about the network
  // service; and the line under Get price while the error is a failed quote's.
  const { banner: errorShown, quoteLine: quoteProblem } = errorPlacement(friendly, {
    refusedNoticeShown,
    fromQuote: quoteFailure !== null && quoteFailure === error,
  });
  /** The built-in notice's "Choose a service": back to the chooser, as "user" so the built-in service doesn't come straight back. */
  const chooseAnotherService = () => applyConfig({ ...configRef.current, rpc: { url: null, source: "user" } });
  /**
   * Settings' Change service: the chooser, with the service in use kept until
   * another is chosen, and a way back to it. Clearing it at the press left
   * the page with no service and no way back, and someone's own URL, often
   * carrying a key, to type again.
   */
  const [changingService, setChangingService] = useState(false);
  const keepService = () => {
    setChangingService(false);
    void reveal("rpc-panel", { block: "start" });
  };

  /**
   * Welcome's last two steps point at the trade card rather than repeat it:
   * the One-time swap set to ETH → SPX (so the contract line and the dollar
   * chips are there), then `testId` brought into view in the Trade tile and
   * focused, with "← Back to steps (n of 4)" to return to the step. Nothing
   * is filled in, quoted or sent.
   */
  const welcomeState = welcomeSteps(account, welcome.ethBalance);
  const stepsBack = welcomeBackLabel(account, welcome.ethBalance);
  const toTradeCard = (testId: string, step?: HTMLElement) => {
    setBuyMode("once");
    if (tokenInSymbol !== "ETH" || tokenOutSymbol !== "SPX") choosePair({ in: "ETH", out: "SPX" });
    requestAnimationFrame(
      () => void reveal(testId, { block: "center", ...(step !== undefined ? { returnTo: step, backLabel: stepsBack } : {}) }),
    );
  };

  // ── The tiles' header summaries ──────────────────────────────────────────

  // What a panel reports about itself (`onSummary`, the panel contract in
  // lib/tiles.ts), by part: a tile with two panels joins their two. Until a
  // panel reports, the tile shows what the page itself can say.
  const [reported, setReported] = useState<Readonly<Record<string, TileSummary>>>({});
  const reportSummary = useCallback((part: string, summary: TileSummary) => {
    setReported((was) => {
      const old = was[part];
      return old !== undefined && old.text === summary.text && old.status === summary.status ? was : { ...was, [part]: summary };
    });
  }, []);
  const reporters = useMemo(() => {
    const make = (part: string) => (summary: TileSummary) => reportSummary(part, summary);
    return {
      receipt: make("receipt"),
      start: make("start"),
      autoBuys: make("auto-buys"),
      stack: make("yours.stack"),
      activity: make("yours.activity"),
      markets: make("markets"),
      collective: make("community.collective"),
      helpRun: make("community.helpRun"),
    };
  }, [reportSummary]);
  const joined = (...parts: (TileSummary | undefined)[]): TileSummary | undefined => {
    const present = parts.filter((part): part is TileSummary => part !== undefined && part.text !== "");
    if (present.length === 0) return undefined;
    const status = present.find((part) => part.status !== undefined)?.status;
    return { text: present.map((part) => part.text).join(" · "), ...(status === undefined ? {} : { status }) };
  };
  /** The panel contract's two props for a panel in tile `id`, reporting as `onSummary`. */
  const inTile = (id: TileId, onSummary: (summary: TileSummary) => void) => ({ open: isShownOpen(id), onSummary });

  const totalLiquidity = (() => {
    if (statsPhase !== "ready" || stats.pools.length === 0 || stats.pools.some((pool) => pool.tvlUsd === null)) return null;
    const total = stats.pools.reduce((sum, pool) => sum + (pool.tvlUsd ?? 0n), 0n);
    return formatPoolMoney(total, moneyView(pricing, performance.now()));
  })();
  const firstBuy = firstSpxBuy(records.rows, account);
  // Each market's name as its venue gave it at discovery ("Uniswap v2",
  // "Uniswap v3 0.30%"), for the Markets rows, which the pair alone can't tell apart.
  const poolLabels = useMemo(
    () => new Map(pools.flatMap((pool) => (pool.label === undefined ? [] : [[pool.poolId.toLowerCase(), pool.label] as const]))),
    [pools],
  );
  const summaries: Record<TileId, TileSummaryView | null> = {
    receipt: joined(reported["receipt"]) ?? (receipt.target === null ? null : receiptSummary(receipt.target.hash)),
    start: joined(reported["start"]) ?? startSummary(welcomeState, firstBuy !== null),
    trade: tradeSummary({ tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, recurring: buyMode === "recurring", swapping }),
    "auto-buys":
      joined(reported["auto-buys"]) ??
      (autoBuy.buyDue
        ? { text: "Buy due", status: "action" }
        : autoBuy.stripText === null
          ? null
          : { text: autoBuy.stripText }),
    yours:
      joined(reported["yours.stack"], reported["yours.activity"]) ??
      yoursSummary({
        account: account !== null,
        holding: typeof stack.holding === "bigint" ? formatAmount(stack.holding, SPX.decimals, 2) : null,
        seen: stackSeen,
        records: records.state === "ready" ? records.rows.length : null,
      }),
    markets:
      joined(reported["markets"]) ??
      marketsSummary({ phase: statsPhase, pair: `${tokenIn.symbol}/${tokenOut.symbol}`, pools: pools.length, total: totalLiquidity }),
    community: joined(reported["community.collective"], reported["community.helpRun"]) ?? { text: "read on open" },
    settings: settingsSummary({ view: mode, features: featuresOn(config).length, currency: moneyPrefs.currency }),
  };

  // ── Focus on a prompt that needs an answer, never on its answer (UI rule R2)

  // The "can't send privately" prompt appears in the middle of a swap: it is
  // brought into view and its container takes focus, so a keyboard user is
  // there without anything being pressed. Never "Send publicly".
  const fallbackRef = useRef<HTMLDivElement>(null);
  const fallbackShown = fallbackPrompt !== null;
  // It appears where a click may already be on its way (a double click on
  // Swap): "Send publicly" counts only after a moment on screen.
  const fallbackArmed = useArmed(fallbackShown && !pageInert);
  useEffect(() => {
    if (!fallbackShown) return;
    const box = fallbackRef.current;
    box?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    box?.focus({ preventScroll: true });
  }, [fallbackShown]);

  // ── Skip links ──────────────────────────────────────────────────────────

  const skipToTrade = () => {
    tiles.open("trade");
    requestAnimationFrame(() => document.getElementById("tile-trade-h")?.focus());
  };
  const skipToDisplay = () => {
    const button = document.getElementById("display-open");
    if (button !== null && button.getClientRects().length > 0) {
      button.focus();
      return;
    }
    // Pinned open on a wide screen: its first control.
    document.querySelector<HTMLElement>("#display-dock button")?.focus();
  };

  // The built-in service counts as chosen where it is used without asking,
  // even behind the disclaimer before its URL is set: the tiles render (with
  // no engine, so nothing is read), never the chooser.
  const serviceChosen =
    (config.rpc.url !== null && config.rpc.url !== "") || (builtIn.automatic !== null && config.rpc.source === "bundled");
  const receiptShown = receipt.target !== null && rpc !== null && engine !== null;
  const tileIds = TILE_ORDER.filter(
    (id) =>
      (id !== "receipt" || receiptShown) && (id !== "start" || welcome.shown) && (id !== "auto-buys" || autoBuy.hasPanel),
  );
  // The tile shown open: the chosen one, or Buy SPX when the chosen one isn't
  // on the page (Welcome on a chain it doesn't serve, or before the network
  // service is read), so the page never loads as a column of closed headers.
  // Render-time only: once Welcome appears, the stored choice shows again.
  const shownOpen =
    tiles.openId !== null && !tileIds.includes(tiles.openId) ? (tileIds.includes("trade") ? "trade" : null) : tiles.openId;
  const isShownOpen = (id: TileId) => shownOpen === id;
  const tile = (id: TileId) => ({ id, chip: TILES[id].chip, title: TILES[id].title, summary: summaries[id] });

  // What the Tip row, Settings → Tips and the settings-link prompt share.
  const tipsEnv: TipsEnv = {
    list: tipList,
    store: tipStore,
    defaults: tipCandidates,
    tipsOn,
    signed: signedClaims,
    rpc,
    second: engine?.secondOpinion() ?? null,
    account,
    chainId: config.chainId,
    tippable,
    migrated: tipsMigrated,
    dismissMigrated: () => setTipsMigrated(0),
  };

  return (
    <TilesContext.Provider value={tiles}>
      <TipsContext.Provider value={tipsEnv}>
      <div className="spdex-app" inert={pageInert}>
        {/* Fixed behind everything, never inside the centre column (a stacking context above the stickers). */}
        <Backdrop />
        <div className="spdex-skip">
          {serviceChosen ? (
            <button type="button" className="spdex-skip__link" onClick={skipToTrade}>
              Skip to Buy SPX
            </button>
          ) : null}
          <button type="button" className="spdex-skip__link" onClick={skipToDisplay}>
            Display settings
          </button>
        </div>

        <div className="spdex-shell">
          <div className="spdex-shell__left">
            <div className="spdex-shell__head">
              <Masthead displayOpen={displayOpen} onToggleDisplay={() => setDisplayOpen((open) => !open)} />
              <DisplayDock open={displayOpen} />
            </div>
            <Stickers side="left" />
          </div>

          <div className="spdex-shell__right">
            <StatusWidget
              config={config}
              rpc={rpc}
              secondOpinion={engine}
              account={account}
              onConnect={onConnectClick}
              safety={safety}
              plans={{ text: autoBuy.stripText, buyDue: autoBuy.buyDue, onOpen: toPlans }}
              live={live}
              announce={announce}
              locale={pricing.locale}
            />
            <Stickers side="right" />
          </div>

          <div className="spdex-shell__centre">
            <main className="spdex-main">
              {/* Mounted on every screen, first run included, so the page below
                  it never moves. Every figure in it is state held here, most of
                  it for another panel; the strip itself reads nothing. */}
              <Ticker
                statsRates={statsRates}
                pricing={pricing}
                spxSupply={spxSupply !== null && spxSupply.engine === engine ? spxSupply.supply : null}
                pools={statsPhase === "ready" ? stats.pools : null}
                pair={`${tokenIn.symbol}/${tokenOut.symbol}`}
                plans={config.dca.plans}
                autoBuy={autoBuy}
                vaultBuys={collective.buys}
              />

              {/* Notices: page-level, each only while it applies, so none can
                  hide inside a closed tile. */}
              <div className="spdex-notices">
                {olderTab ? (
                  <Banner tone="warn" title={<>Another tab has an older <Brand /></>} testId="older-tab">
                    {OLDER_TAB_TEXT}
                  </Banner>
                ) : null}

                <OlderSavePrompt onRestore={applyConfig} onKeep={() => saveConfig(configRef.current)} interactive={!pageInert} />

                {refusedNoticeShown && builtInRefused !== null ? (
                  <BuiltInServiceNotice
                    answer={builtInRefused.answer}
                    fallbackUrl={fallback}
                    onChoose={onChooseRpc}
                    onChooseAnother={chooseAnotherService}
                  />
                ) : null}

                {adoptedChain ? (
                  <Banner tone="ok" title="Network updated" testId="chain-adopted">
                    Your network service is on {networkLabel(adoptedChain.to)}, so spDEX is too. Your saved
                    settings said chain {adoptedChain.from}.
                  </Banner>
                ) : null}

                {stagedError ? (
                  <Banner tone="danger" title="This settings link couldn't be read" testId="staged-error">
                    {stagedError}
                  </Banner>
                ) : null}

                {staged ? (
                  <StagedConfigPrompt
                    // Reviewed as it would apply: with no service address, the
                    // person's own service stays (`withOwnService`).
                    staged={withOwnService(staged, config)}
                    current={config}
                    onAccept={() => {
                      void applyIfPlansAgreed(staged).then((applied) => {
                        if (applied) setStaged(null);
                      });
                    }}
                    onDismiss={() => setStaged(null)}
                    interactive={!pageInert}
                  />
                ) : null}

                {serviceChosen && errorShown ? (
                  <Banner tone="danger" title={errorShown.title} testId="error-banner">
                    <p className="spdex-banner__text">
                      {errorShown.sentence}
                      {errorShown.place !== undefined ? (
                        <>
                          {" "}
                          <GoTo place={errorShown.place} />
                        </>
                      ) : null}
                    </p>
                    {/* The raw message, verbatim and always in the DOM (a closed
                        disclosure still renders its body): it is what a bug report
                        needs, and what the tests read. */}
                    <Disclosure testId="error-details" summary="Details">
                      <code className="spdex-error-raw">{errorShown.raw}</code>
                    </Disclosure>
                  </Banner>
                ) : null}

                {serviceChosen && wrongChain !== null ? (
                  <Banner
                    tone="warn"
                    title={
                      <>
                        Wrong <Term tip={GLOSSARY.network}>network</Term> in your wallet
                      </>
                    }
                    testId="wrong-chain"
                  >
                    <p className="spdex-banner__text">
                      Wallet: {networkLabel(wrongChain)} · spDEX: {networkLabel(config.chainId)}.
                    </p>
                    {canOfferAddNetwork ? (
                      <div className="spdex-actions">
                        <Button testId="add-network" onClick={onAddNetwork}>
                          Add this network to my wallet
                        </Button>
                      </div>
                    ) : (
                      // A network the wallet defines for itself is not one spDEX
                      // may redefine: that would point the wallet's own idea of it
                      // at this service. Asking it to switch to its own is fine.
                      <>
                        <div className="spdex-actions">
                          <Button testId="switch-network" onClick={() => void onSwitchNetwork()}>
                            Switch my wallet to {networkLabel(config.chainId)}
                          </Button>
                        </div>
                        <p className="spdex-field__hint" data-testid="switch-network-hint">
                          Or switch to {networkLabel(config.chainId)} in your wallet yourself, then connect again.
                        </p>
                      </>
                    )}
                  </Banner>
                ) : null}

                {serviceChosen && delegate ? (
                  <Banner tone="danger" title="Your wallet forwards what it receives" testId="delegation-warning">
                    <p className="spdex-banner__text">
                      It runs code at <code>{delegate}</code> whenever it&apos;s paid (EIP-7702), so ETH payouts are refused.
                    </p>
                    <p className="spdex-banner__text">
                      Didn&apos;t set this up? Treat this key as compromised and move your funds.
                    </p>
                    <Disclosure testId="delegation-why" summary="Why?">
                      <p className="spdex-banner__text">
                        ETH paid to your address would leave again at once, so the swap would deliver nothing you keep.
                        Development keys published with test tools all have one, which is why they should never hold
                        real funds.
                      </p>
                    </Disclosure>
                  </Banner>
                ) : null}

                {serviceChosen && fallbackPrompt ? (
                  <div
                    className="spdex-prompt"
                    ref={fallbackRef}
                    tabIndex={-1}
                    role="group"
                    aria-labelledby="fallback-prompt-title"
                  >
                    <Banner tone="warn" title={<span id="fallback-prompt-title">Can&apos;t send privately</span>} testId="fallback-prompt">
                      <p className="spdex-banner__text">
                        Your wallet can&apos;t send <Term tip={GLOSSARY.privateSending}>privately</Term> (
                        {fallbackPrompt.reason}). Sent publicly, bots can front-run it.
                      </p>
                      <div className="spdex-actions">
                        <Button testId="fallback-accept" onClick={() => answerFallback(true)} ariaDisabled={!fallbackArmed}>
                          Send publicly
                        </Button>
                        <Button variant="ghost" testId="fallback-cancel" onClick={() => answerFallback(false)}>
                          Cancel
                        </Button>
                      </div>
                    </Banner>
                  </div>
                ) : null}
              </div>

              {!serviceChosen || changingService ? (
                <FirstRun
                  bundledUrl={bundled}
                  // Refused once in this visit: not offered again until a reload.
                  bundledRefused={builtInRefused !== null}
                  fallbackUrl={fallback}
                  onChoose={(url, source, chainId) => {
                    setChangingService(false);
                    onChooseRpc(url, source, chainId);
                  }}
                  pendingReceipt={receipt.target !== null}
                  {...(serviceChosen && changingService
                    ? { keep: { name: serviceNameOf(config.rpc), onKeep: keepService } }
                    : {})}
                />
              ) : (
                <TileGroup
                  ids={tileIds}
                  openId={shownOpen}
                  onOpenChange={(id) => (id === null ? tiles.close() : tiles.open(id as TileId))}
                  back={tiles.back}
                >
                  {/* A shared transaction is what this visit is for, so it comes
                      first, open, read through this person's own network service. */}
                  {receiptShown && receipt.target !== null && rpc !== null && engine !== null ? (
                    <Tile {...tile("receipt")}>
                      <ReceiptView
                        target={receipt.target}
                        rpc={rpc}
                        configChainId={config.chainId}
                        finder={engine}
                        factories={vaultDeployment(config.chainId) === null ? [] : VAULT_FACTORIES}
                        onClose={receipt.close}
                        {...inTile("receipt", reporters.receipt)}
                      />
                    </Tile>
                  ) : null}

                  {welcome.shown ? (
                    <Tile {...tile("start")}>
                      <Welcome
                        account={account}
                        chainId={config.chainId}
                        ethBalance={welcome.ethBalance}
                        walletAvailable={detectProvider() !== null}
                        onConnect={onConnectClick}
                        onShowContract={(from) => toTradeCard(CONTRACT_LINE_ID, from)}
                        onGoToAmount={(from) => toTradeCard(`amount-preset-${CULTURE_AMOUNT_PRESETS_USD_CENTS[0]}`, from)}
                        onGoToRecurring={(from) => goToRecurring(from, stepsBack)}
                        onOpenFeatures={() => setFeaturesOpen(true)}
                        firstBuy={firstBuy}
                        onMakeCard={setCardRow}
                        locale={pricing.locale}
                        {...inTile("start", reporters.start)}
                      />
                    </Tile>
                  ) : null}

                  <Tile {...tile("trade")}>
                    <TradeCard
                      open={isShownOpen("trade")}
                      buyMode={buyMode}
                      onBuyMode={setBuyMode}
                      oneTime={
                        <OneTimeSwap
                          config={config}
                          mode={mode}
                          tokenIn={tokenIn}
                          tokenOut={tokenOut}
                          amountInput={amountInput}
                          onAmountInput={onAmountInput}
                          pricing={pricing}
                          quote={quote}
                          quoteId={quoteId}
                          quoting={quoting}
                          swapping={swapping}
                          status={statusAfterSwap(status, afterSwap.shown)}
                          quoteProblem={quoteProblem}
                          networkFee={
                            quote !== null && quoteFeePerGas !== null
                              ? swapNetworkFee(quote.legs, quote.route.gasEstimate, quoteFeePerGas)
                              : null
                          }
                          feeLevel={quoteFeeLevel}
                          pendingSend={pendingSend}
                          afterSwap={
                            afterSwap.shown === null || rpc === null ? null : (
                              <AfterSwap left={afterSwap.shown} rpc={rpc} chainId={config.chainId} onMakeCard={setCardRow} />
                            )
                          }
                          account={account}
                          balanceIn={balanceIn === "unreadable" ? null : balanceIn}
                          balanceOut={balanceOut === "unreadable" ? null : balanceOut}
                          autoBuyHoldsWallet={lockBusy && !swapping}
                          tipCandidates={tipCandidates}
                          tipsToPay={tipsToPay}
                          tipPermit2={tipPermit2}
                          onTokenIn={(symbol) => choosePair(pairAfterPick({ in: tokenInSymbol, out: tokenOutSymbol }, "in", symbol))}
                          onTokenOut={(symbol) => choosePair(pairAfterPick({ in: tokenInSymbol, out: tokenOutSymbol }, "out", symbol))}
                          onReverse={() => choosePair({ in: tokenOutSymbol, out: tokenInSymbol })}
                          onQuote={onQuote}
                          onSwap={() => void onSwap()}
                          onConnect={onConnectClick}
                          onConfig={applyConfig}
                        />
                      }
                      recurring={<RecurringForm autoBuy={autoBuy} deps={autoBuyDeps} />}
                    />
                  </Tile>

                  {/* After Trade, so a plan started there is listed right below it. */}
                  {autoBuy.hasPanel ? (
                    <Tile {...tile("auto-buys")}>
                      <AutoBuysPanel autoBuy={autoBuy} deps={autoBuyDeps} {...inTile("auto-buys", reporters.autoBuys)} />
                    </Tile>
                  ) : null}

                  <Tile {...tile("yours")}>
                    {/* The stack's records are read once this place has been
                        on screen, which a closed tile never is. */}
                    <div ref={stackRef}>
                      <YourStack
                        {...stack}
                        account={account}
                        chainId={config.chainId}
                        rows={records.rows}
                        truncated={records.truncated}
                        pricing={pricing}
                        onMakeCard={setCardRow}
                        onConnect={onConnectClick}
                        recordsState={records.state}
                        {...inTile("yours", reporters.stack)}
                      />
                    </div>
                    <YourActivity
                      records={records}
                      account={account}
                      chainId={config.chainId}
                      rpc={rpc}
                      pricing={pricing}
                      onOpen={setActivityOpen}
                      onMakeCard={setCardRow}
                      {...inTile("yours", reporters.activity)}
                    />
                  </Tile>

                  <Tile {...tile("markets")}>
                    <PoolStatsPanel
                      view={stats}
                      tokens={TOKEN_LIST}
                      // The markets are read for the One-time pair; under a Recurring
                      // form set up for another pair, the title says whose they are.
                      pair={`${tokenIn.symbol} / ${tokenOut.symbol}${buyMode === "recurring" ? " (the One-time pair)" : ""}`}
                      phase={statsPhase}
                      discovered={pools.length}
                      labels={poolLabels}
                      mode={mode}
                      pricing={pricing}
                      {...inTile("markets", reporters.markets)}
                    />
                  </Tile>

                  <Tile {...tile("community")}>
                    <CollectiveDca
                      rpc={rpc}
                      chainId={config.chainId}
                      onRead={collective.onRead}
                      {...inTile("community", reporters.collective)}
                    />
                    {/* The Engine checks the batch with its own vault Guard, and
                        the page's one wallet lock keeps it from asking the wallet
                        while a swap, a tip or a plan's buy does. The panel hides
                        itself without a wallet on this network. */}
                    {engine !== null && vaultDeployment(config.chainId) !== null ? (
                      <HelpRunPanel
                        engine={engine}
                        chainId={config.chainId}
                        account={account}
                        walletChainOk={walletChainOk}
                        submitter={config.submitter}
                        pricing={pricing}
                        ownerLock={ownerLock}
                        {...inTile("community", reporters.helpRun)}
                      />
                    ) : null}
                  </Tile>

                  <Tile {...tile("settings")}>
                    <SettingsTile
                      open={isShownOpen("settings")}
                      config={config}
                      mode={mode}
                      onMode={setMode}
                      onOpenFeatures={() => setFeaturesOpen(true)}
                      safety={safety}
                      onChangeService={() => setChangingService(true)}
                      tipCandidates={tipCandidates}
                      permit2={permit2Panel}
                      pools={pools}
                      stats={stats.pools}
                      pricing={pricing}
                      onChange={applyConfig}
                      onImport={applyIfPlansAgreed}
                      // Reset restores the policy, not the service. Wiping the RPC
                      // would drop the user back to the first-run screen, which is
                      // not what "reset my settings" means to anyone — and matches
                      // the service being excluded from the preset comparison.
                      onReset={() => void applyIfPlansAgreed({ ...recommendedConfig(), rpc: config.rpc })}
                      trust={(open) => (
                        <WalkawayPanel
                          config={config}
                          rpc={rpc}
                          chainId={config.chainId}
                          account={account}
                          // What the factory's list shows is listed with the auto-buys too,
                          // where a vault no plan points at can be closed or added back.
                          onVaultsFound={autoBuy.addFoundVaults}
                          // In its Settings section: it reads once that is first opened.
                          open={open}
                        />
                      )}
                      {...(welcome.hidden && WELCOME_CHAINS.has(config.chainId)
                        ? // Brings the steps back and opens their tile at them.
                          { onGettingStarted: welcome.showAgain }
                        : {})}
                    />
                  </Tile>
                </TileGroup>
              )}
            </main>

            {/* After <main>, so it is the page's contentinfo landmark. */}
            <Footer onDisclaimer={reviewDisclaimer} firstRun={!serviceChosen} />
            {/* The drawing at the very end, under the footer: nothing sits on it. */}
            <LinkMap />
          </div>
        </div>

        {featuresOpen ? (
          <FeaturesModal
            config={config}
            onChange={applyConfig}
            onClose={() => setFeaturesOpen(false)}
            onGoToRecurring={() => goToRecurring()}
            onGoToTip={goToTip}
            mode={mode}
          />
        ) : null}

        {cardRow !== null ? (
          <IBoughtCard row={cardRow} chainId={config.chainId} appUrl={shareableAppUrl()} onClose={() => setCardRow(null)} />
        ) : null}
      </div>

      {gateOpen ? <DisclaimerGate review={!firstVisitGate} onDone={onGateDone} /> : null}
      </TipsContext.Provider>
    </TilesContext.Provider>
  );
}
