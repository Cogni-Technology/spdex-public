/**
 * Screenshots, not a gate.
 *
 * Deliberately a separate config rather than a third project in the main one:
 * `pnpm verify` runs `playwright test` with no project filter, so a project
 * added there would make screenshot capture part of the release gate. It is
 * not — a colour scheme has no pass/fail, and the images exist for a human to
 * look at.
 *
 *   pnpm shots        # needs a fork running: pnpm anvil:fork
 *
 * The spec itself is invisible to the main run because no project there has
 * a testMatch that selects it.
 */

import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.js";

const launchOptions = process.env["SPDEX_CHROMIUM_PATH"]
  ? { executablePath: process.env["SPDEX_CHROMIUM_PATH"] }
  : {};

export default defineConfig({
  ...base,
  reporter: "list",
  projects: [
    {
      name: "theme",
      testMatch: /theme\.screenshot\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
  ],
});
