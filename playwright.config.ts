import { defineConfig, devices } from "@playwright/test";
import { resolvedEnv } from "./scripts/env.mjs";

const env = resolvedEnv();

/**
 * Where to find a Chromium that actually runs.
 *
 * Playwright's own download is a generic Linux build and does not start on
 * NixOS — it cannot find libxcb, because nothing has patched its interpreter.
 * nixpkgs ships a patched build, but at a different revision than Playwright
 * expects, so pointing PLAYWRIGHT_BROWSERS_PATH at it fails a version check.
 * An explicit executablePath sidesteps both problems, and leaving it unset
 * falls back to Playwright's normal behaviour on machines where that works.
 */
const executablePath = env["SPDEX_CHROMIUM_PATH"];
const launchOptions = executablePath ? { executablePath } : {};

/**
 * E2E runs the app against a pinned mainnet fork with a headless wallet.
 *
 * Playwright starts Vite, but *not* anvil. The split is deliberate: a dev
 * server either binds its port or does not, and a failure is unambiguous,
 * whereas a fork can come up, answer, and still be seeded from the wrong chain
 * — and diagnosing that from inside a browser test is miserable. So the fork is
 * a precondition `pnpm verify` checks explicitly (and `scripts/anvil-fork.mjs`
 * verifies its block hash before serving), while the web server is just
 * plumbing Playwright can own.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One shared fork; parallel workers would race on its state.
  workers: 1,
  timeout: 90_000,
  reporter: process.env.CI ? "list" : "html",
  // The fork's settings live in .env.defaults / .env.local; specs read them to
  // stay agnostic about which chain id the fork is running under.
  ...(() => {
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("SPDEX_") && process.env[key] === undefined) process.env[key] = value;
    }
    return {};
  })(),

  use: {
    baseURL: process.env.SPDEX_E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
  },
  projects: [
    {
      name: "recommended",
      testMatch: /recommended\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    { name: "expert", testMatch: /expert\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    // Features and tip splits. Separate from the two mode specs because it cuts
    // across both: the modal is a recommended-mode surface for config the
    // expert editor also exposes.
    { name: "features", testMatch: /features\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    // Pool statistics, which need the fork's real balances rather than a stub.
    { name: "tracker", testMatch: /tracker\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    // Native ether. Separate because every spec needs its own clean account —
    // and a longer budget: these specs set an account up and then execute one
    // or two real swaps, which the default 90s does not comfortably cover.
    {
      name: "native",
      testMatch: /native\.spec\.ts/,
      timeout: 240_000,
      /*
       * One retry, and only here.
       *
       * These specs execute real transactions against a forked mainnet, and
       * the fork lazily fetches state from an upstream archive endpoint that
       * rate-limits. Under a full suite run that occasionally leaves a send
       * waiting on anvil for longer than any sane timeout, while the identical
       * spec completes in half a second on its own.
       *
       * The retry masks an environmental failure, not a product one — the
       * swap paths themselves are covered by fork integration tests in
       * `modules/venue-uniswap-v2/test/integration/native.test.ts`, which
       * assert the Guard verdict and the delivered balance directly. If a
       * retry ever stops being enough, that is a real signal.
       */
      retries: 1,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // Auto-buy. Separate because these are the only specs that move the page
    // clock — a day at a time, to make buys fall due — and each makes several
    // real buys in a row, each confirmed in the wallet, so it gets the native
    // project's longer budget.
    {
      name: "dca",
      testMatch: /dca\.spec\.ts/,
      timeout: 240_000,
      /*
       * No retry, set here so CI's default of two doesn't apply either. These
       * specs follow a standing order that moves money on a timer, and a
       * failure that passes on a second try is the kind to investigate: the
       * gate does not report flaky tests as failures, so a retry here would
       * turn one into a pass nobody reads.
       */
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // Vaults. Separate because these specs bring their own accounts — fresh
    // keys, funded for the test and signed for outside the page
    // (e2e/vaults.ts) — and run a keeper tick, through the batcher, from the
    // test while no page is open.
    // Each creates, triggers and closes a vault with real transactions, so it
    // gets the auto-buy project's budget, and its rule on retries for the same
    // reason: a vault moves money on its own, and a failure that passes on a
    // second try is one to investigate, not to count as a pass.
    {
      name: "vault",
      testMatch: /vault\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // Money: amounts typed in dollars or another currency, the currency
    // select and number styles. These check what is quoted and saved, not
    // what is sent, so the default budget holds. Specs about the default unit
    // opt out of the fixtures' token-unit seed with
    // `seedConfig(page, {}, { moneyUnits: null })`.
    { name: "money", testMatch: /money\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    // What a swap leaves behind (the finality badge, Your stack, Your activity
    // and its CSV) and a plan's calendar file. The swap specs make a real swap
    // and read its record back, so they get the vault project's budget, and
    // its rule on retries: a record that is right only on a second try is one
    // to investigate, and the gate doesn't report a flaky pass.
    {
      name: "records",
      testMatch: /records\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // The Welcome panel. Every other spec starts with it hidden, as it starts
    // with the Features dialog seen; these opt in with `showWelcome: true`.
    { name: "welcome", testMatch: /welcome\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    // The "I bought" card and the #receipt= view: a real swap, a card made
    // from it, and the view opened from that link in a fresh context. Real
    // transactions, so the same budget and retry rule as records.
    {
      name: "receipt",
      testMatch: /receipt\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // Collective DCA, which reads the vault factory's list on the fork, and
    // Trust and exits beside it. Both send nothing, so the default budget holds.
    { name: "collective", testMatch: /collective\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    // The second opinion: the same fork under a second host name agrees, a
    // routed answer that disagrees or doesn't come is refused or marked
    // "Checked on one service", an older tab's save can't switch it off, and
    // the setting tests a service before saving it. A swap is made, so the
    // vault project's budget, and its rule on retries: a safety check that
    // passes only on a second try is one to investigate, and the gate doesn't
    // report a flaky pass.
    {
      name: "second-opinion",
      testMatch: /second-opinion\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // Help run the network: one fresh key makes the due buy of a vault another
    // fresh key created in the spec, with private sending to the fork, and is
    // paid its buy fee; every other vault the panel lists is unticked first,
    // so no vault the spec didn't make is ever triggered. Real transactions,
    // so the same budget and the same rule on retries.
    // The page's shell: the tiles and their keys, the display dock, the
    // status widget's reads and the disclaimer gate. Nothing is sent, but one
    // spec waits a minute on an idle page to show the widget doesn't poll, so
    // it gets a longer budget than the default.
    {
      name: "shell",
      testMatch: /shell\.spec\.ts/,
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    {
      name: "help-run",
      testMatch: /help-run\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    // The tip registry: "My tip list", the picker's two lists, the first-tip
    // check, and a swap that tips only who was confirmed. One spec makes a
    // real swap and follows the tip to the address, so the records project's
    // budget and its rule on retries: a tip that reaches the right address
    // only on a second try is one to investigate.
    {
      name: "tips",
      testMatch: /tips\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
  ],

  webServer: {
    command: "pnpm --filter @spdex/web dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
