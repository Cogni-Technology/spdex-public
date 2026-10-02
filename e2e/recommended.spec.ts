/**
 * The path a first-time SPX holder takes: open the app, pick an endpoint,
 * connect, swap.
 *
 * This is the claim that recommended mode is genuinely usable without
 * understanding any of the machinery underneath — and, just as importantly,
 * that it is the *same* machinery. The Guard verdict asserted here is the same
 * verdict expert mode shows.
 */

import {
  test,
  expect,
  fundWeth,
  installWallet,
  seedConfig,
  FORK_URL,
  FORK_CHAIN_ID,
  ensureWeth,
  openSection,
  openTile,
  skipDisclaimer,
} from "./fixtures.js";
import { headlessWalletScript } from "../packages/testing/src/wallet.js";
import { freshAccount, keyWallet } from "./vaults.js";

/** Enough WETH to swap, wrapped from the account's own ETH. */
const ONE_WETH = 10n ** 18n;

/**
 * A four-figure balance, specifically.
 *
 * Display formatting groups thousands, so anything under 1000 hides the
 * round-trip bug this exercises — "use all" wrote "10,000" into a field whose
 * parser rejected commas, and the app then insisted the amount was zero. Anvil
 * accounts hold 10,000 ETH, so wrapping 1,500 leaves plenty for gas.
 */
const GROUPED_WETH = 1_500n * 10n ** 18n;

test.describe("recommended mode", () => {
  test("asks for an endpoint on first run, then remembers it", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await page.goto("/");
    await skipDisclaimer(page);
    await openTile(page, "trade");

    // No backend means no default that works everywhere: the bundled key is
    // allowlisted to the canonical origin, so a local copy has to be told.
    await expect(page.getByTestId("first-run")).toBeVisible();
    await expect(page.getByTestId("rpc-privacy-notice")).toContainText("IP address");

    await page.getByTestId("rpc-url-input").fill(FORK_URL);
    await page.getByTestId("rpc-save").click();

    await expect(page.getByTestId("first-run")).toBeHidden();
    await expect(page.getByTestId("rpc-label")).toContainText(FORK_URL);

    // Survives a reload: the config is persisted, not held in memory.
    await page.reload();
    await openTile(page, "trade");
    await expect(page.getByTestId("first-run")).toBeHidden();
  });

  test("rejects an endpoint that is not a URL", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await page.goto("/");
    await skipDisclaimer(page);
    await openTile(page, "trade");

    await page.getByTestId("rpc-url-input").fill("not-a-url");
    await page.getByTestId("rpc-save").click();

    await expect(page.getByTestId("rpc-error")).toBeVisible();
    await expect(page.getByTestId("first-run")).toBeVisible();
  });

  test("quotes a route and shows a verified Guard verdict", async ({ page, account }) => {
    await fundWeth(ONE_WETH, account);
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));

    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();

    // The route is always shown: which pools, what share.
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("leg-count")).not.toBeEmpty();

    // anvil supports eth_simulateV1, so the Guard can actually prove the
    // outcome rather than degrade to UNVERIFIED.
    await expect(page.getByTestId("guard-level")).toHaveText("verified");
    await expect(page.getByTestId("swap-button")).toBeVisible();
  });

  test("previews a route before a wallet is connected, without crying refusal", async ({ page }) => {
    // Looking at prices before connecting is the first thing anyone does. It
    // used to quote against the zero address, which holds nothing, so the
    // simulation reverted and the very first screen said REFUSED — "spDEX will
    // not offer this transaction for signing" — about a perfectly good route.
    // Nothing was being refused; there was simply no account to simulate for.
    await installWallet(page);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();

    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("guard-level")).toHaveText("preview");

    // The alarming parts must be absent, not merely reworded.
    await expect(page.getByTestId("violation-SIMULATION_REVERTED")).toHaveCount(0);
    await expect(page.getByTestId("guard-banner")).not.toContainText("Refused");

    // And it points at the actual next step rather than a dead disabled button.
    await expect(page.getByTestId("connect-to-swap")).toBeVisible();
  });

  test("upgrades a preview to a verified quote once connected", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("guard-level")).toHaveText("preview", { timeout: 60_000 });

    await page.getByTestId("connect-to-swap").click();
    await page.getByTestId("quote-button").click();

    await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 60_000 });
    await expect(page.getByTestId("swap-button")).toBeVisible();
  });

  test("executes a swap and reports completion", async ({ page, account }) => {
    await fundWeth(ONE_WETH, account);
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("swap-button").click();

    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", {
      timeout: 120_000,
    });

    // The quote is cleared after execution: leaving a stale route on screen
    // would invite a second swap against prices that no longer exist.
    await expect(page.getByTestId("route-view")).toBeHidden();
  });

  test("handles a wallet rejection without claiming failure", async ({ page, account }) => {
    // A user declining in their wallet is an ordinary outcome, not an error,
    // and must not leave the app stuck mid-swap.
    await fundWeth(ONE_WETH, account);
    await installWallet(page, { rejectTransactions: true, address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("route-view")).toBeVisible({ timeout: 60_000 });

    // On a phone the quote is taller than the screen. What the wallet was
    // asked, and what came of it, is said beside the button that was
    // pressed, where it can be read, not a screen above it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("swap-button").click();

    await expect(page.getByTestId("swap-status")).toContainText("Cancelled", { timeout: 60_000 });
    await expect(page.getByTestId("swap-status")).toBeInViewport();
    await expect(page.getByTestId("error-banner")).toBeHidden();
  });

  test("shows balances read from the chain, not from the wallet", async ({ page, account }) => {
    // A wallet that has not been told about a token displays nothing, which is
    // indistinguishable from holding none of it. spDEX reads balances itself,
    // so the app is right even when MetaMask looks empty.
    await installWallet(page, { address: account });
    await fundWeth(ONE_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await expect(page.getByTestId("balance-in")).toHaveCount(0);
    await page.getByTestId("connect-button").click();

    await expect(page.getByTestId("balance-in")).toContainText("WETH", { timeout: 30_000 });
    await expect(page.getByTestId("balance-out")).toContainText("SPX");

    // "use all" fills the field with the full balance, at full precision.
    await page.getByTestId("use-max").click();
    await expect(page.getByTestId("amount-input")).not.toHaveValue("");
  });

  test("'use all' produces an amount the app can actually read back", async ({ page, account }) => {
    // The regression test for a round-trip failure between the formatter and
    // the parser. It only appears once the balance is large enough to be
    // grouped, which is why this funds four figures rather than one.
    await installWallet(page, { address: account });
    // Top up rather than wrap unconditionally: this account is reused run to
    // run, and repeatedly spending 1,500 ETH on it eventually runs it dry.
    await ensureWeth(GROUPED_WETH, account);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("balance-in")).toContainText("WETH", { timeout: 30_000 });

    // The displayed balance is grouped — that is the display's job. Matched as
    // a shape rather than an exact figure: the fork is long-lived and an
    // account may carry WETH wrapped by an earlier run, so asserting "1,500"
    // exactly would fail on a second pass for a reason that is not the bug.
    await expect(page.getByTestId("balance-in")).toHaveText(/Balance \d,\d{3}/);

    await page.getByTestId("use-max").click();

    // The field is not grouped, and that is the whole bug: a grouped value here
    // is one the amount parser rejects, so the app reported an empty amount
    // while visibly holding the user's entire balance.
    await expect(page.getByTestId("amount-input")).toHaveValue(/^\d{4}(\.\d+)?$/);

    // Asserted as "no error of this kind exists" rather than
    // `not.toContainText`, which fails outright when the banner is absent —
    // and absent is the passing case.
    await page.getByTestId("quote-button").click();
    await expect(
      page.getByTestId("error-banner").filter({ hasText: "greater than zero" }),
    ).toHaveCount(0);
  });

  test("notices when the wallet moves to another chain after connecting", async ({ page, account }) => {
    /*
     * The regression test for a signing dialog full of nonsense.
     *
     * spDEX checked the chain once, at connect, and then trusted it forever.
     * MetaMask returns to Ethereum Mainnet on reload, so the app went on
     * quoting against the fork while the wallet prepared to sign on mainnet —
     * and the first thing the user saw was a gas estimate priced on a chain
     * they were not trading on, against balances that were not there.
     *
     * Dropping the connected account is the assertion that matters: there is
     * no safe partial state when the two disagree about which chain the
     * money is on.
     */
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));
    await expect(page.getByTestId("wrong-chain")).toBeHidden();

    // The wallet switches to Ethereum Mainnet underneath the app.
    await page.evaluate(() => {
      (window as unknown as { ethereum: { _emit: (e: string, ...a: unknown[]) => void } }).ethereum._emit(
        "chainChanged",
        "0x1",
      );
    });

    await expect(page.getByTestId("wrong-chain")).toBeVisible();
    await expect(page.getByTestId("wrong-chain")).toContainText("chain 1");
    // The account is dropped rather than left connected on the wrong chain.
    await expect(page.getByTestId("account-label")).toContainText("not connected");
  });

  test("drops the account when the wallet disconnects the site", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));

    // An empty accounts array is how a wallet says "this site is no longer
    // permitted", and it must not leave a stale address on screen.
    await page.evaluate(() => {
      (window as unknown as { ethereum: { _emit: (e: string, ...a: unknown[]) => void } }).ethereum._emit(
        "accountsChanged",
        [],
      );
    });

    await expect(page.getByTestId("account-label")).toContainText("not connected");
  });

  test("heals a stored config whose chain id has drifted from its endpoint", async ({ page, account }) => {
    /*
     * The regression test for a dead end.
     *
     * `chainId` is saved next to the endpoint but was only ever probed when the
     * endpoint was chosen, so a config written while the fork ran as chain 1
     * went on claiming chain 1 after the fork moved to its own id. The app then
     * compared the wallet against that stale number and blamed the wallet —
     * which was right — instead of the config, which was not. The only way out
     * was re-entering the identical URL.
     *
     * The endpoint is the authority: it is the node answering every query.
     */
    await installWallet(page, { address: account });
    // Right endpoint, wrong remembered chain — exactly what an older session left.
    await seedConfig(page, { chainId: 1 });
    await page.goto("/");
    await openTile(page, "trade");

    await expect(page.getByTestId("chain-adopted")).toBeVisible();
    await expect(page.getByTestId("chain-label")).toHaveText(String(FORK_CHAIN_ID));

    // And having healed, there is no mismatch left to report.
    await expect(page.getByTestId("wrong-chain")).toBeHidden();

    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));
  });

  test("does not offer to add a network the wallet defines for itself", async ({ page, account }) => {
    /*
     * Offering "add this network" for chain 1 would ask the wallet to point its
     * own idea of Ethereum Mainnet at whatever endpoint spDEX is using. A
     * wallet that refuses makes the button useless; one that accepts makes it
     * dangerous. Neither is worth shipping.
     *
     * The wallet is left on the fork's id while the app is pinned to chain 1,
     * which is the only way to hold the two apart now that a live endpoint
     * heals the config.
     */
    await installWallet(page, { address: account });
    await seedConfig(page, { chainId: 1, rpc: { url: "http://127.0.0.1:1", source: "user" } });
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("connect-button").click();

    await expect(page.getByTestId("wrong-chain")).toBeVisible();
    await expect(page.getByTestId("add-network")).toHaveCount(0);
    // Asking the wallet to switch to a network it knows is fine: that redefines nothing.
    await expect(page.getByTestId("switch-network")).toHaveText(/^Switch my wallet to Ethereum/);
    await expect(page.getByTestId("switch-network-hint")).toBeVisible();
  });

  test("on a phone, Connect on the wrong network brings the banner that says so into view", async ({ page, account }) => {
    /*
     * The banner sits at the top of the page, a screen or more above the
     * Connect button on a phone: without being brought into view, the button
     * simply seemed not to work.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(headlessWalletScript({ rpcUrl: FORK_URL, address: account, chainId: 1 }));
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("amount-input").scrollIntoViewIfNeeded();
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("wrong-chain")).toBeInViewport();
    await expect(page.getByTestId("add-network")).toBeVisible();
  });

  test("says an amount above what the wallet holds beside Get price, and offers no swap", async ({ page }) => {
    /*
     * A test-run of a swap the wallet can't pay for fails for want of funds,
     * which read as "your network service can't run the safety test", with
     * Swap offered anyway. The balance is known, so it is said before
     * anything is quoted, where the amount is.
     */
    const poor = await freshAccount(2n * 10n ** 16n);
    await installWallet(page, { address: poor.address });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("balance-in")).toContainText("Balance 0.02 ETH");

    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("swap-status")).toHaveText("Couldn't get a price: not enough ETH in your wallet.");
    await expect(page.getByTestId("error-banner")).toContainText(
      "Your wallet holds 0.02 ETH, and this swap needs 1 ETH and its network fee. Enter less, or tap Max.",
    );
    await expect(page.getByTestId("swap-button")).toHaveCount(0);

    // A token it holds none of: no network fee to add, and no Max to tap.
    await page.getByTestId("token-in").selectOption("USDC");
    await page.getByTestId("amount-input").fill("5");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("swap-status")).toHaveText("Couldn't get a price: not enough USDC in your wallet.");
    await expect(page.getByTestId("error-banner")).toContainText("Add USDC to your wallet first.");
  });

  test("a swap that stops for want of funds says so beside its button, not only at the top of the page", async ({ page }) => {
    /*
     * Everything but the network fee: Get price has nothing to refuse, and
     * the wallet is what says no. On a phone the banner is a screen or more
     * above the Swap button that was just pressed.
     */
    const poor = await freshAccount(2n * 10n ** 16n);
    await page.setViewportSize({ width: 390, height: 844 });
    // A fresh key the fork doesn't hold: the wallet signs with it.
    await keyWallet(page.context(), poor);
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("balance-in")).toContainText("Balance 0.02 ETH");
    await page.getByTestId("amount-input").fill("0.01999");
    await page.getByTestId("quote-button").click();
    await page.getByTestId("swap-button").click();
    const line = page.getByTestId("swap-status");
    await expect(line).toHaveText("Swap stopped: not enough ETH for this and its network fee. More at the top of the page.", {
      timeout: 60_000,
    });
    await expect(line).toBeInViewport();
    await expect(page.getByTestId("error-banner")).toContainText("nothing was sent");
  });

  test("Change service keeps the service in use until another is chosen, with a way back to it", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "settings");
    await openSection(page, "settings-network");
    const inUse = (await page.getByTestId("settings-rpc-label").textContent()) ?? "";

    await page.getByTestId("change-rpc").click();
    await expect(page.getByTestId("first-run")).toContainText("Change network service");
    await expect(page.getByTestId("rpc-keep")).toHaveText(`Keep ${inUse}`);
    // Still in use while choosing: the status panel keeps reading through it.
    await expect(page.getByTestId("status-widget")).not.toContainText("NO SERVICE");

    await page.getByTestId("rpc-keep").click();
    await expect(page.getByTestId("first-run")).toHaveCount(0);
    await expect(page.getByTestId("settings-rpc-label")).toHaveText(inUse);
  });

  test("says a swap's network fee beside its price, before Swap", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.01");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("network-fee")).toContainText(/≈.*ETH/, { timeout: 60_000 });
  });

  test("folds the route, a clean check and Inspect transaction under Advanced, closed, with Swap in view", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.01");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 60_000 });

    const advanced = page.getByTestId("swap-advanced");
    await expect(page.getByTestId("swap-advanced-summary")).toHaveText("Advanced · 1 market · checked");
    await expect(advanced).not.toHaveAttribute("open");
    await expect(page.getByTestId("swap-button")).toBeVisible();
    // A clean pass is inside the fold, and so is everything else it holds.
    await expect(advanced.getByTestId("guard-banner")).toBeHidden();
    await expect(advanced.getByTestId("route-legs")).toBeHidden();
    await expect(page.getByTestId("toggle-raw-plan")).toBeHidden();

    await page.getByTestId("swap-advanced-summary").click();
    await expect(advanced.getByTestId("guard-banner")).toBeVisible();
    await expect(advanced.getByTestId("route-legs")).toBeVisible();
    await page.getByTestId("toggle-raw-plan").click();
    await expect(page.getByTestId("raw-plan")).toBeVisible();
  });

  test("says a send is slow after 15 seconds, with its transaction, and goes once it is mined", async ({ page, account }) => {
    /*
     * The fork mines at once, so the receipt is held back here instead: the
     * page asks, and is told "not yet" until released. Its clock is moved on,
     * not waited out, and only by 16 seconds, well inside the two minutes
     * after which it would stop watching.
     */
    await page.clock.install();
    let hold = true;
    await page.route(
      (url) => url.href.startsWith(FORK_URL),
      async (route) => {
        const request = route.request();
        let parsed: unknown = null;
        try {
          parsed = request.method() === "POST" ? JSON.parse(request.postData() ?? "null") : null;
        } catch {
          parsed = null;
        }
        const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { id?: unknown; method?: unknown }) : null;
        if (!hold || body === null || body.method !== "eth_getTransactionReceipt") return route.continue();
        return route.fulfill({
          status: 200,
          headers: { "access-control-allow-origin": "*" },
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }),
        });
      },
    );
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.01");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 60_000 });
    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toHaveText("Waiting for the network…", { timeout: 60_000 });
    await expect(page.getByTestId("swap-slow")).toHaveCount(0);

    await page.clock.fastForward("00:16");
    const slow = page.getByTestId("swap-slow");
    await expect(slow).toContainText(/^Still waiting for a block: 1[6-9] s\./);
    await expect(page.getByTestId("swap-slow-hint")).toHaveText("Speeding it up in your wallet is safe: spDEX follows the faster copy.");
    await expect(slow.getByTestId("swap-slow-tx")).toBeVisible();

    hold = false;
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 60_000 });
    await expect(page.getByTestId("swap-slow")).toHaveCount(0);
  });

  test("says when the network fee is a large share of the swap, and not when it isn't", async ({ page, account }) => {
    // The fork's base fee is a few wei, so the fee is about the tip times the
    // gas: thousands of times a 0.0001 ETH swap's 3%, and nowhere near 1 ETH's.
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await page.getByTestId("connect-button").click();
    await page.getByTestId("amount-input").fill("0.0001");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("network-fee-high")).toHaveText(
      /^Network fees are high right now: [\d.,]+% of this swap(, \d+× the last few hours)?\. If it can wait, try later\.$/,
      { timeout: 60_000 },
    );
    // Advice only: Swap is still offered.
    await expect(page.getByTestId("swap-button")).toBeVisible();

    await page.getByTestId("amount-input").fill("1");
    await page.getByTestId("quote-button").click();
    await expect(page.getByTestId("you-pay")).toContainText(/^1 ETH/, { timeout: 60_000 });
    await expect(page.getByTestId("network-fee")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("network-fee-high")).toHaveCount(0);
  });

  test("picking the token already on the other side swaps the two, never one token twice", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    await page.getByTestId("token-in").selectOption("ETH");
    await expect(page.getByTestId("token-out")).toHaveValue("SPX");
    await page.getByTestId("token-in").selectOption("SPX");
    await expect(page.getByTestId("token-in")).toHaveValue("SPX");
    await expect(page.getByTestId("token-out")).toHaveValue("ETH");
    await page.getByTestId("token-out").selectOption("SPX");
    await expect(page.getByTestId("token-in")).toHaveValue("ETH");
    await expect(page.getByTestId("token-out")).toHaveValue("SPX");
  });

  test("refuses an amount of zero rather than quoting nothing", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await page.getByTestId("amount-input").fill("0");
    await page.getByTestId("quote-button").click();

    await expect(page.getByTestId("error-banner")).toContainText("greater than zero");
  });

  test("shows the connected account and the endpoint in use", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");

    await expect(page.getByTestId("account-label")).toContainText("not connected");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).toContainText(account.slice(0, 6));
    await expect(page.getByTestId("preset-label")).toContainText("recommended");
  });
});
