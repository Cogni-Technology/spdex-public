import { defineConfig, devices } from "@playwright/test";
import { resolvedEnv } from "./scripts/env.mjs";
import { smokeSettings } from "./e2e-mainnet/settings.js";

/**
 * The mainnet smoke suite (`pnpm mainnet:smoke`): the published app, driven
 * in a real browser by agent wallets, against Ethereum or a fork of it.
 * docs/MAINNET-SMOKE.md says how to set it up and what it may spend.
 *
 * Not a `pnpm verify` stage and never one: prices move, blocks come when they
 * come, and a mainnet run spends real ether. The gate's determinism rules
 * are for the pinned fork; this suite is the other half, the one the pinned
 * fork can't do.
 */

const env = resolvedEnv();
// Read here so a missing setting stops the run before a browser starts.
const settings = smokeSettings(env);
const executablePath = env["SPDEX_CHROMIUM_PATH"];
const launchOptions = executablePath ? { executablePath } : {};

// e2e/fixtures.ts's page helpers (seedConfig, openTile…) read the endpoint
// and the chain from these; here they are the smoke run's, not the pinned fork's.
process.env["SPDEX_FORK_URL"] = settings.rpcUrl;
process.env["SPDEX_FORK_CHAIN_ID"] = "1";

export default defineConfig({
  testDir: "./e2e-mainnet",
  outputDir: "./.mainnet-smoke/results",
  // One wallet set, one chain: specs run one after another, in file order.
  workers: 1,
  fullyParallel: false,
  // A retry would send real transactions again, for a failure worth reading.
  retries: 0,
  // Mainnet transactions wait for blocks; a vault's spec makes several in a row.
  timeout: 20 * 60_000,
  reporter: [["list"]],
  globalSetup: "./e2e-mainnet/global-setup.ts",
  globalTeardown: "./e2e-mainnet/global-teardown.ts",
  use: {
    ...devices["Desktop Chrome"],
    launchOptions,
    baseURL: settings.baseUrl,
    // Kept only for a failed test, and only here: traces hold the endpoint's
    // URL and every request, so .mainnet-smoke/ is gitignored.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
  },
});
