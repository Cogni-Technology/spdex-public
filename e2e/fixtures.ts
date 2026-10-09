/**
 * Shared e2e setup.
 *
 * Two things every spec needs: a wallet in the page, and a config that skips
 * the first-run screen. Both are injected before load rather than clicked
 * through, so a spec about swapping is not also a spec about onboarding — the
 * onboarding spec covers that explicitly.
 */

import { test as base, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { headlessWalletScript } from "../packages/testing/src/wallet.js";
import { recommendedConfig } from "../packages/config/src/index.js";
import { DISCLAIMER_KEY, DISCLAIMER_VERSION } from "../apps/web/src/lib/disclaimer.js";

export const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";

/** Mainnet addresses the specs trade, lowercase as the app writes them. */
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
/** The pseudo-address the app and its config use for native ether. */
export const NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * The chain id the fork reports.
 *
 * Derived rather than hardcoded so the suite follows the fork wherever it is
 * configured. The wallet and the seeded config both use it, because the app
 * refuses to trade when they disagree — which is the check working, not a
 * problem to route around.
 */
export const FORK_CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");

/**
 * anvil's default accounts, each funded with 10,000 ETH.
 *
 * Tests take one each rather than sharing the first. That is the isolation
 * mechanism here, and it replaced snapshot-and-revert, which looked tidier and
 * did not work: rewinding the chain under anvil's transaction pool left a later
 * `eth_sendTransaction` waiting for a receipt that never came, so a swap test
 * passed alone and timed out in a full run. Separate accounts have no shared
 * balances or allowances to leak, and nothing to rewind.
 */
export const ANVIL_ACCOUNTS = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
] as const;

/** Kept for specs that only need "some account". */
export const TEST_ACCOUNT = ANVIL_ACCOUNTS[0];

const STORAGE_KEY = "spdex.config.v1";

export async function installWallet(
  page: Page,
  options: {
    rejectTransactions?: boolean;
    refuseSignTransaction?: boolean;
    refuseSignTypedData?: boolean;
    rejectApprovalsTo?: string;
    address?: string;
  } = {},
) {
  await page.addInitScript(
    headlessWalletScript({
      rpcUrl: FORK_URL,
      address: options.address ?? TEST_ACCOUNT,
      chainId: FORK_CHAIN_ID,
      ...(options.rejectTransactions === undefined ? {} : { rejectTransactions: options.rejectTransactions }),
      ...(options.refuseSignTransaction === undefined
        ? {}
        : { refuseSignTransaction: options.refuseSignTransaction }),
      ...(options.refuseSignTypedData === undefined ? {} : { refuseSignTypedData: options.refuseSignTypedData }),
      ...(options.rejectApprovalsTo === undefined ? {} : { rejectApprovalsTo: options.rejectApprovalsTo }),
    }),
  );
}

const FEATURES_SEEN_KEY = "spdex.features.seen.v1";
/** The One-time tab's remembered pair (apps/web/src/lib/prefs.ts). */
const SWAP_PAIR_KEY = "spdex.swap.pair.v1";
/** Whether this browser hid the Welcome panel ("hidden" when it did). */
export const WELCOME_KEY = "spdex.welcome.v1";
/** This browser's money preferences (`MONEY_PREFS_KEY` in apps/web/src/lib/money/pricing.ts). */
export const MONEY_KEY = "spdex.money.v1";

/**
 * The unit each amount field starts in: "token", or a currency code such as
 * "USD". Stored as `StoredUnit` (apps/web/src/lib/money/pricing.ts).
 */
export interface SeededUnits {
  once: string;
  recurring: string;
}

/**
 * Every spec types token amounts unless it says otherwise, as every spec did
 * before amounts could be typed in money.
 */
export const TOKEN_UNITS: SeededUnits = { once: "token", recurring: "token" };

/**
 * Seed a config so the spec starts past first-run.
 *
 * Also marks the features dialog as already seen, because it opens by itself
 * the first time a user gets past the endpoint screen — which is the point of
 * it, and which would otherwise drop a modal over every spec in the suite. A
 * spec that wants that behaviour passes `showFeatures: true` and gets it.
 *
 * The Welcome panel is hidden for the same reason (`showWelcome: true` shows
 * it), and both amount fields start in token units, which a fresh browser
 * doesn't: it starts in the person's currency. A spec about that default
 * passes `moneyUnits: null`, and one that wants a field in money passes the
 * units. Like the config, the units are seeded again on every navigation, so
 * a unit switched in the page doesn't survive a reload unless the spec passed
 * `moneyUnits: null`. Only `units` is written, though: a currency or number
 * style the page chose does survive.
 */
export async function seedConfig(
  page: Page,
  overrides: Record<string, unknown> = {},
  options: { showFeatures?: boolean; showWelcome?: boolean; moneyUnits?: SeededUnits | null } = {},
) {
  const config = {
    ...recommendedConfig(),
    chainId: FORK_CHAIN_ID,
    rpc: { url: FORK_URL, source: "user" },
    ...overrides,
  };
  const units = options.moneyUnits === undefined ? TOKEN_UNITS : options.moneyUnits;
  await page.addInitScript(
    (seed: {
      key: string;
      value: string;
      seenKey: string;
      seen: boolean;
      pairKey: string;
      pair: string;
      welcomeKey: string;
      hideWelcome: boolean;
      moneyKey: string;
      units: SeededUnits | null;
    }) => {
      window.localStorage.setItem(seed.key, seed.value);
      if (seed.seen) window.localStorage.setItem(seed.seenKey, "1");
      // The app starts newcomers on ETH; the suite pins WETH so the default
      // path keeps exercising the permission step. In this same script so
      // every navigation re-seeds it, exactly as it does the config.
      window.localStorage.setItem(seed.pairKey, seed.pair);
      if (seed.hideWelcome) window.localStorage.setItem(seed.welcomeKey, "hidden");
      if (seed.units !== null) {
        let prefs: Record<string, unknown> = {};
        try {
          const stored: unknown = JSON.parse(window.localStorage.getItem(seed.moneyKey) ?? "null");
          if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) prefs = stored as Record<string, unknown>;
        } catch {
          // Not JSON: replaced below, as the app itself would fall back.
        }
        window.localStorage.setItem(seed.moneyKey, JSON.stringify({ ...prefs, units: seed.units }));
      }
    },
    {
      key: STORAGE_KEY,
      value: JSON.stringify(config),
      seenKey: FEATURES_SEEN_KEY,
      seen: !options.showFeatures,
      pairKey: SWAP_PAIR_KEY,
      pair: JSON.stringify({ in: "WETH", out: "SPX" }),
      welcomeKey: WELCOME_KEY,
      hideWelcome: !options.showWelcome,
      moneyKey: MONEY_KEY,
      units,
    },
  );
  return config;
}

/**
 * The fork failing to reach *its* upstream, as opposed to answering.
 *
 * Anvil fetches state it has not seen yet — any fresh address, any cold
 * storage slot — from the archive endpoint it forked, and reports a failed
 * fetch as an ordinary JSON-RPC error: "error sending request for url (…)",
 * sometimes a DNS failure. That is this machine's network, not spDEX and not
 * the chain, and it has failed a green suite on a single dropped lookup.
 *
 * Only that is retried, a few times with a short pause, and only in this
 * helper. A real answer — a revert, a bad parameter, a wrong balance — is
 * never retried, and nothing the app itself does is: the point is to keep the
 * suite measuring spDEX rather than the upstream, not to make failures quiet.
 */
function isUpstreamFetchFailure(message: string): boolean {
  return /error sending request for url|failed to get account for|dns error/i.test(message);
}

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(FORK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const json = (await response.json()) as { result?: T; error?: { message: string } };
    if (!json.error) return json.result as T;
    if (attempt < 4 && isUpstreamFetchFailure(json.error.message)) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      continue;
    }
    throw new Error(`${method}: ${json.error.message}`);
  }
}

/**
 * The fork as a `JsonRpc`, for package code that takes one — the vault
 * keeper, its readers, `prepareTransaction` for a test's fresh keys — so that
 * it gets the same narrow retry on an upstream fetch failure as every read
 * here, and nothing more.
 */
export const forkRpc = (method: string, params: unknown[]): Promise<unknown> => rpc(method, params);

/**
 * Ether held by an address, from the fork.
 *
 * Read over RPC rather than from the page, so a spec checks what the app says
 * against the chain instead of against itself.
 */
export async function ethBalance(address: string): Promise<bigint> {
  return BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
}

/**
 * An ERC-20 balance, from the fork.
 *
 * A read that fails throws rather than returning zero. A spec asserting that
 * nothing arrived would otherwise pass on a balance nobody managed to read —
 * the same unknown-is-not-zero rule the app itself is held to.
 */
export async function tokenBalance(token: string, owner: string): Promise<bigint> {
  const data = `0x70a08231${owner.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const raw = await rpc<string>("eth_call", [{ to: token, data }, "latest"]);
  if (!/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`balanceOf(${owner}) on ${token} answered ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

/**
 * What a mined transaction paid the network: gas used times the price paid
 * per unit. Lets a spec account for every wei that left an address.
 */
export async function feePaid(hash: string): Promise<bigint> {
  const receipt = await rpc<{ gasUsed: string; effectiveGasPrice: string } | null>("eth_getTransactionReceipt", [hash]);
  if (receipt === null) throw new Error(`no receipt for ${hash}`);
  return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
}

/**
 * Follows the page's traffic to the fork, to tell when the app is idle.
 *
 * A spec that moves the page clock must do it only while nothing is waiting
 * on the network. Receipt polling, and every RPC call's own timeout, run on
 * the page's timers, so a clock jump in the middle of one fires them at once:
 * a mined transaction reports "not mined after 120s", or a read times out
 * that had not. "No request in flight, and none for a moment" is observable;
 * a fixed sleep is only a guess at it.
 */
export function watchRpc(page: Page): { quiet(ms?: number): Promise<void> } {
  const inFlight = new Set<Request>();
  let lastChange = Date.now();
  const toFork = (request: Request) => request.url().startsWith(FORK_URL);
  page.on("request", (request) => {
    if (!toFork(request)) return;
    inFlight.add(request);
    lastChange = Date.now();
  });
  const settled = (request: Request) => {
    if (inFlight.delete(request)) lastChange = Date.now();
  };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  return {
    async quiet(ms = 1_000) {
      await expect
        .poll(() => inFlight.size === 0 && Date.now() - lastChange >= ms, { timeout: 60_000, intervals: [100] })
        .toBe(true);
    },
  };
}

/** The auto-buy runner's heartbeat: when the leading tab last finished a look (apps/web/src/lib/dca/runner.ts). */
const LEASE_KEY = "spdex.dca.lease.v1";

async function lastLook(page: Page): Promise<number> {
  return page.evaluate((key) => {
    try {
      const lease = JSON.parse(window.localStorage.getItem(key) ?? "null") as { lastTick?: unknown } | null;
      return typeof lease?.lastTick === "number" ? lease.lastTick : 0;
    } catch {
      return 0;
    }
  }, LEASE_KEY);
}

/**
 * Make the auto-buy runner look at its plans, and wait until it has looked
 * with the page's current time.
 *
 * "Nothing happened" is only worth asserting after a look that could have
 * made something happen. The runner looks when the tab becomes visible, so a
 * `visibilitychange` asks for one, and its heartbeat, written after each look,
 * says when one finished. It takes two: a look already under way when the
 * clock moved finishes with a fresh heartbeat but judged the old time, and
 * looks never overlap, so the second heartbeat belongs to a look that started
 * after the first ended — after the clock moved.
 */
export async function runnerLooks(page: Page): Promise<void> {
  for (let round = 0; round < 2; round++) {
    const before = await lastLook(page);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => lastLook(page), { timeout: 60_000 }).toBeGreaterThan(before);
  }
}

/** What the page asked the headless wallet to send, in order (packages/testing/src/wallet.ts). */
export interface ProposedTransaction {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
}

export async function sentTransactions(page: Page): Promise<ProposedTransaction[]> {
  return page.evaluate(() => (window as unknown as { ethereum: { _sent: ProposedTransaction[] } }).ethereum._sent);
}

/** What the page asked the headless wallet to sign without sending. */
export async function signedTransactions(page: Page): Promise<ProposedTransaction[]> {
  return page.evaluate(() => (window as unknown as { ethereum: { _signed: ProposedTransaction[] } }).ethereum._signed);
}

/** A typed-data signature the page asked for (eth_signTypedData_v4), as the wallet received it. */
export interface TypedSignatureRequest {
  primaryType?: string;
  domain?: { name?: string; chainId?: number; verifyingContract?: string };
  message?: { spender?: string; permitted?: { token: string; amount: string }[] };
}

export async function typedSignatures(page: Page): Promise<TypedSignatureRequest[]> {
  return page.evaluate(() => (window as unknown as { ethereum: { _typed: TypedSignatureRequest[] } }).ethereum._typed);
}

/**
 * One request the page made of the headless wallet: a transaction to send or
 * sign, or typed data to sign.
 */
export interface WalletPrompt {
  method: "eth_sendTransaction" | "eth_signTransaction" | "eth_signTypedData_v4";
  to?: string;
  data?: string;
}

/**
 * Every request `sentTransactions`, `signedTransactions` and
 * `typedSignatures` record, in the order the page made them, which those
 * three can't say across each other.
 */
export async function walletPrompts(page: Page): Promise<WalletPrompt[]> {
  return page.evaluate(() => (window as unknown as { ethereum: { _prompts: WalletPrompt[] } }).ethereum._prompts);
}

/**
 * Take back a token's Permit2 permission from an account, by sending the
 * account's own `approve(PERMIT2, 0)`.
 *
 * Accounts are reused across runs on a long-lived fork, so a spec about the
 * first batched tip, the one that asks for the permission, has to start from
 * an account that never gave it. This is an ordinary transaction from the
 * account (anvil signs for it), not a rewrite of the fork's state.
 */
export async function revokePermit2(token: string, account: string): Promise<void> {
  await approvePermit2(token, account, "0".repeat(64), "revoking");
}

/**
 * Give Permit2 the standing permission on a token, as the app asks for it:
 * the account's own `approve(PERMIT2, max)`. For a spec that starts from a
 * permission already given, such as revoking it from Expert → Tips.
 */
export async function grantPermit2(token: string, account: string): Promise<void> {
  await approvePermit2(token, account, "f".repeat(64), "granting");
}

async function approvePermit2(token: string, account: string, amountWord: string, doing: string): Promise<void> {
  const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const data = `0x095ea7b3${PERMIT2.slice(2).padStart(64, "0")}${amountWord}`;
  const hash = await rpc<string>("eth_sendTransaction", [{ from: account, to: token, data }]);
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`${doing} the Permit2 permission reverted`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${doing} the Permit2 permission was not mined`);
}

/** Permit2's allowance from `owner` on `token`, from the fork. Throws rather than reading zero. */
export async function permit2Allowance(token: string, owner: string): Promise<bigint> {
  const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const data = `0xdd62ed3e${owner.replace(/^0x/, "").toLowerCase().padStart(64, "0")}${PERMIT2.slice(2).padStart(64, "0")}`;
  const raw = await rpc<string>("eth_call", [{ to: token, data }, "latest"]);
  if (!/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error(`allowance(${owner}, Permit2) on ${token} answered ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

/**
 * Give the test account WETH by wrapping its own ETH.
 *
 * The app does not wrap (it refuses an ETH ↔ WETH pair: that is a wrap, not a
 * trade), so a spec that sells WETH arranges its own. Wrapping beats
 * impersonating a whale: it needs no
 * external account and, crucially, does not drain a pool and move the very
 * prices the test is about to quote.
 *
 * This exists because of a false green. Two specs passed against a fork that a
 * manual debugging session had happened to leave funded, and failed the moment
 * it was clean. A test that depends on state it did not create is not testing
 * what it claims.
 */
export async function fundWeth(amountWei: bigint, account: string = TEST_ACCOUNT): Promise<void> {
  const hash = await rpc<string>("eth_sendTransaction", [
    { from: account, to: WETH, value: `0x${amountWei.toString(16)}`, data: "0xd0e30db0" },
  ]);

  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error("wrapping ETH reverted");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("wrapping ETH was not mined");
}

/**
 * Top an account up to a WETH balance, wrapping only the shortfall.
 *
 * `fundWeth` wraps unconditionally, which is fine for the 1 WETH most specs
 * need and wrong for a spec that wants four figures: the fork is long-lived
 * and accounts are reused across runs, so an unconditional 1,500 WETH wrap
 * spends 1,500 of the account's 10,000 ETH *every time the suite runs* and
 * eventually fails on an account that is simply out of ether — a failure that
 * looks like a product bug and is not one.
 *
 * Reading first makes the test idempotent against a fork that has been up all
 * day, which is the normal case during development.
 */
export async function ensureWeth(minimumWei: bigint, account: string = TEST_ACCOUNT): Promise<void> {
  const data = `0x70a08231${account.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const raw = await rpc<string>("eth_call", [{ to: WETH, data }, "latest"]);
  const balance = raw === "0x" ? 0n : BigInt(raw);
  if (balance >= minimumWei) return;
  await fundWeth(minimumWei - balance, account);
}

/**
 * Buy SPX for an account by spending its ether, over RPC.
 *
 * A spec that needs SPX in hand should not have to perform a swap through the
 * UI to get it — that is a second real transaction against a forked mainnet,
 * and every one of them is another chance for the upstream archive endpoint to
 * rate-limit and leave anvil waiting. Arranging the precondition directly keeps
 * each spec to the single swap it is actually about.
 *
 * Uses the router's ETH entry point, so no approval is needed either.
 */
export async function fundSpxWithEth(amountWei: bigint, account: string): Promise<void> {
  const ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
  const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  //  swapExactETHForTokens(amountOutMin, path, to, deadline) — the array offset
  //  is 0x80 because the head is four words with no amountIn.
  const data =
    "0x7ff36ab5" +
    word("0") +
    word("80") +
    word(account) +
    word("2540be3ff") +
    word("2") +
    word(WETH) +
    word(SPX);

  const hash = await rpc<string>("eth_sendTransaction", [
    { from: account, to: ROUTER, value: `0x${amountWei.toString(16)}`, data, gas: "0x2dc6c0" },
  ]);
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error("buying SPX reverted");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("buying SPX was not mined");
}

/**
 * Give an address an EIP-7702 delegation, for specs that need one.
 *
 * The designator is `0xef0100` followed by the delegate's twenty bytes. Set
 * explicitly rather than borrowing a real delegated account, because the
 * `account` fixture strips delegations from every anvil account it hands out —
 * so a spec relying on one would pass or fail depending on which other specs
 * had run first.
 */
export async function setDelegation(account: string, delegate: string): Promise<void> {
  await rpc("anvil_setCode", [account, `0xef0100${delegate.replace(/^0x/, "").toLowerCase()}`]);
}

/**
 * Make an anvil account able to hold ether.
 *
 * On a mainnet fork it cannot, by default. anvil's private keys are published,
 * so every one of its ten accounts carries an EIP-7702 delegation installed by
 * a sweeper bot on real mainnet — `eth_getCode` returns `0xef0100…` for all of
 * them — and a fork inherits that with the rest of mainnet state. Ether sent to
 * such an account is forwarded straight out in the same transaction.
 *
 * Harmless for ERC-20 swaps, which never call the account. Fatal for anything
 * paying out ether, where the Guard correctly reports the recipient received
 * nothing — which is how this was found.
 *
 * Clearing the code is better than switching to an impersonated address: an
 * unlocked account with a real key behaves like every other account in the
 * suite, whereas impersonated senders proved erratic under anvil's auto-mining
 * and produced transactions that were accepted and then never mined.
 */
export async function clearDelegation(account: string): Promise<void> {
  const code = await rpc<string>("eth_getCode", [account, "latest"]);
  if (code === "0x") return;
  await rpc("anvil_setCode", [account, "0x"]);
}

/** The fork's latest block number. */
export async function headBlock(): Promise<bigint> {
  return BigInt(await rpc<string>("eth_blockNumber"));
}

/**
 * The transactions `from` sent after block `since`, in order, found on the
 * chain. The page shows at most a short hash; a spec that wants the one the
 * account really sent reads it here, from the fork, not from the page.
 */
export async function transactionsSince(from: string, since: bigint): Promise<string[]> {
  const head = await headBlock();
  const found: string[] = [];
  for (let n = since + 1n; n <= head; n++) {
    const block = await rpc<{ transactions: { from: string; hash: string }[] }>("eth_getBlockByNumber", [
      `0x${n.toString(16)}`,
      true,
    ]);
    for (const tx of block.transactions) if (tx.from.toLowerCase() === from.toLowerCase()) found.push(tx.hash);
  }
  return found;
}

/**
 * Swap `amount` ETH for SPX through the page, from an account already
 * connected: quoted, verified by the Guard, and sent. Returns the SPX that
 * arrived and the transactions the account sent, both read from the fork.
 *
 * For the specs about what a swap leaves behind (records, the card and its
 * receipt), not about swapping itself, which native.spec.ts covers.
 */
export async function swapEthForSpx(
  page: Page,
  account: string,
  amount: string,
): Promise<{ delivered: bigint; hashes: string[] }> {
  await openTile(page, "trade");
  await page.getByTestId("token-in").selectOption("ETH");
  await page.getByTestId("amount-input").fill(amount);
  await page.getByTestId("quote-button").click();
  await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 60_000 });

  const since = await headBlock();
  const before = await tokenBalance(SPX, account);
  const asked = (await sentTransactions(page)).length;
  await page.getByTestId("swap-button").click();
  await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
  const delivered = (await tokenBalance(SPX, account)) - before;
  expect(delivered).toBeGreaterThan(0n);
  const hashes = await transactionsSince(account, since);
  // One transaction per market the route used, and nothing else: ether
  // needs no approval, and the suite's config leaves tips off.
  expect(hashes).toHaveLength((await sentTransactions(page)).length - asked);
  return { delivered, hashes };
}

/**
 * An 8-decimal amount (SPX) as the page writes it in en-US: grouped, and cut
 * to `places` decimals, never rounded up, with trailing zeros dropped.
 */
export function spxFigure(amount: bigint, places: number): string {
  const unit = 10n ** 8n;
  const fraction = (amount % unit).toString().padStart(8, "0").slice(0, places).replace(/0+$/, "");
  return `${(amount / unit).toLocaleString("en-US")}${fraction === "" ? "" : `.${fraction}`}`;
}

// ─── The page as tiles, and the disclaimer ────────────────────────────────────

/**
 * Waits until React has put something on the page, so "is there a tile?"
 * isn't answered before the first render.
 */
async function rendered(page: Page): Promise<void> {
  await page.locator("#root > *").first().waitFor();
}

/**
 * Opens tile `id` (TileId in apps/web/src/lib/tiles.ts) by clicking its
 * header, unless it is open already. A no-op where the page has no such tile:
 * one that comes and goes (Welcome, Auto-buys, a receipt) and isn't there, the
 * first-run screen, or a build laid out before tiles.
 *
 * One tile is open at a time, so a spec that goes from one tile to another
 * calls this at each move. While a dialog is open it does nothing: call it
 * again once the dialog has closed. Before any `toBeHidden()` or `not.toBeVisible()`
 * on something inside a tile, call this first, or assert `toHaveCount(0)`:
 * everything in a closed tile is hidden, so such an assertion would pass
 * without testing anything.
 */
export async function openTile(page: Page, id: string): Promise<void> {
  await rendered(page);
  const header = page.getByTestId(`tile-${id}`);
  if ((await header.count()) === 0) return;
  // Behind an open dialog (Features, the card, the disclaimer) the header can't
  // be clicked, and a spec that calls this there is still busy with the dialog.
  if ((await page.locator('[aria-modal="true"]').count()) > 0) return;
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

/**
 * Opens a Settings section (`settings-network`, `expert-safety`…) by clicking
 * `${testId}-summary`, unless it is open already. A no-op where the section
 * isn't there, or isn't a section (a panel of its own, before Settings was a
 * tile). The Settings tile has to be open first: `openTile(page, "settings")`.
 */
export async function openSection(page: Page, testId: string): Promise<void> {
  await rendered(page);
  const section = page.getByTestId(testId);
  if ((await section.count()) === 0) return;
  const closed = await section.evaluate((el) => el instanceof HTMLDetailsElement && !el.open);
  if (!closed) return;
  await page.getByTestId(`${testId}-summary`).click();
  await expect(section).toHaveAttribute("open", "");
}

/**
 * Continues past the disclaimer if it is showing; a no-op otherwise. Every
 * spec starts past it (the `disclaimerSeen` fixture), so this is a guard for
 * a page opened some other way.
 *
 * Enter is what continues, and only once the gate has been up for a moment,
 * so it is pressed until the gate goes, and never again after: an Enter that
 * reached the page behind it could press a button there.
 */
export async function skipDisclaimer(page: Page): Promise<void> {
  await rendered(page);
  const gate = page.getByTestId("disclaimer");
  await expect(async () => {
    if ((await gate.count()) === 0) return;
    await page.keyboard.press("Enter");
    await expect(gate).toHaveCount(0, { timeout: 750 });
  }).toPass({ timeout: 10_000 });
}

/**
 * Marks the current disclaimer as seen in every page of `context`, before
 * each load, as the `disclaimerSeen` fixture does for the default context.
 * For a spec that opens a context of its own (`browser.newContext`).
 */
export async function seedDisclaimer(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    (seed: { key: string; version: string }) => {
      try {
        window.localStorage.setItem(seed.key, seed.version);
      } catch {
        // A page with no storage (about:blank) has no gate to skip either.
      }
    },
    { key: DISCLAIMER_KEY, version: DISCLAIMER_VERSION },
  );
}

let nextAccount = 0;

/**
 * Each test gets its own account.
 *
 * The swaps here are small enough not to move the pools meaningfully, so shared
 * pool state is fine; what must not be shared are balances and allowances,
 * since leftovers there are exactly what let a broken approval path look
 * healthy.
 */
export const test = base.extend<{ account: string; showDisclaimer: boolean; disclaimerSeen: void }>({
  /**
   * Every spec starts with the disclaimer already seen, at the version the
   * app ships (imported, so a new version needs no edit here), as it starts
   * with the Features dialog seen. A spec about the disclaimer opts in to
   * seeing it with `test.use({ showDisclaimer: true })`.
   */
  showDisclaimer: [false, { option: true }],
  disclaimerSeen: [
    async ({ context, showDisclaimer }, use) => {
      if (!showDisclaimer) await seedDisclaimer(context);
      await use();
    },
    { auto: true },
  ],
  account: async ({}, use) => {
    const address = ANVIL_ACCOUNTS[nextAccount % ANVIL_ACCOUNTS.length]!;
    nextAccount += 1;
    // Unconditionally, for every spec: an account that silently forwards any
    // ether it receives is a trap the whole suite can walk into, and stripping
    // it here means no spec has to know the delegation exists.
    await clearDelegation(address);
    await use(address);
  },
});

export { expect } from "@playwright/test";
