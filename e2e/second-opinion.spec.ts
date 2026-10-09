/**
 * The second opinion (config `guard.secondOpinion.url`): every test-run the
 * Guard relies on, run on a second network service too, on a block both
 * vouch for, and compared.
 *
 * ## One fork, two names
 *
 * Two services only agree when they hold the same chain, so the second
 * opinion here is the fork itself under its other host name (`127.0.0.1` ↔
 * `localhost`): another address as far as the browser and spDEX's "same
 * service?" rule are concerned, the same state as far as the chain is. A
 * second fork would not do: forks of the same block with different histories
 * since are two chains, and the Guard would rightly refuse to compare them.
 *
 * A second service that lies or goes quiet is made by routing that host name
 * in the page (`page.route`): a test-run answer with one transfer changed by
 * one unit, or no answer at all. The main service is never touched, so every
 * refusal here comes from the comparison alone.
 */

import type { Page, Request, Route } from "@playwright/test";
import { recommendedConfig } from "../packages/config/src/index.js";
import { FORK_CHAIN_ID, FORK_URL, NATIVE_ETH, expect, installWallet, seedConfig, test, openSection, openTile } from "./fixtures.js";

/** The fork under its other host name: the same chain, another service by address. */
const SECOND_URL = otherHostFor(FORK_URL);
const SECOND_ORIGIN = new URL(SECOND_URL).origin;

function otherHostFor(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === "127.0.0.1") parsed.hostname = "localhost";
  else if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
  else throw new Error(`the second-opinion spec needs the fork at 127.0.0.1 or localhost, not ${parsed.hostname}`);
  return parsed.toString().replace(/\/$/, "");
}

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function rpcMethod(request: Request): string | null {
  try {
    const body = JSON.parse(request.postData() ?? "null") as { method?: unknown } | null;
    return typeof body?.method === "string" ? body.method : null;
  } catch {
    return null;
  }
}

/** Every JSON-RPC method the page asks the second service, in order. */
function watchSecond(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== SECOND_ORIGIN || request.method() !== "POST") return;
    asked.push(rpcMethod(request) ?? "?");
  });
  return asked;
}

/** A config with the second opinion set, as a saved setting would leave it. */
function withSecondOpinion(url: string | null) {
  const base = recommendedConfig();
  return { preset: "custom", guard: { ...base.guard, secondOpinion: { url } } };
}

/** Connect and ask for a price for `amount` ETH → SPX. */
async function quoteEth(page: Page, amount: string) {
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await page.getByTestId("token-in").selectOption("ETH");
  await page.getByTestId("amount-input").fill(amount);
  await page.getByTestId("quote-button").click();
}

/**
 * `answer` with the first ERC-20 `Transfer` in any call's logs made one unit
 * larger, in place; false when it has none (a probe, or the 1-wei ether
 * test, whose only records are the `traceTransfers` pseudo-logs).
 */
function bumpFirstTransfer(answer: { result?: unknown }): boolean {
  const blocks = Array.isArray(answer.result) ? (answer.result as { calls?: { logs?: { address: string; topics: string[]; data: string }[] }[] }[]) : [];
  for (const block of blocks) {
    for (const call of block.calls ?? []) {
      for (const log of call.logs ?? []) {
        if (log.topics[0]?.toLowerCase() !== TRANSFER || log.address.toLowerCase() === NATIVE_ETH) continue;
        log.data = `0x${(BigInt(log.data) + 1n).toString(16).padStart(64, "0")}`;
        return true;
      }
    }
  }
  return false;
}

test.describe("second opinion", () => {
  test("the same fork under another name agrees: checked on 2 services, verified, and the swap goes through", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, withSecondOpinion(SECOND_URL));
    const asked = watchSecond(page);
    await page.goto("/");
    await openTile(page, "trade");

    await quoteEth(page, "0.01");
    await expect(page.getByTestId("guard-level")).toHaveText("verified", { timeout: 90_000 });
    await expect(page.getByTestId("strip-safety")).toHaveText("available · checked on 2 services");
    // The second service really test-ran it, on a block it named itself.
    expect(asked).toContain("eth_simulateV1");
    expect(asked).toContain("eth_blockNumber");

    await page.getByTestId("swap-button").click();
    await expect(page.getByTestId("swap-status")).toContainText("Swap complete", { timeout: 120_000 });
  });

  test("a second service whose test-run differs by one unit is refused, with no way to swap", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, withSecondOpinion(SECOND_URL));
    let tampered = 0;
    await page.route(
      (url) => url.origin === SECOND_ORIGIN,
      async (route: Route) => {
        const request = route.request();
        if (request.method() !== "POST" || rpcMethod(request) !== "eth_simulateV1") return route.continue();
        const response = await route.fetch();
        const answer = (await response.json()) as { result?: unknown };
        if (bumpFirstTransfer(answer)) tampered += 1;
        return route.fulfill({ response, json: answer });
      },
    );
    await page.goto("/");
    await openTile(page, "trade");

    await quoteEth(page, "0.01");
    await expect(page.getByTestId("guard-level")).toHaveText("rejected", { timeout: 90_000 });
    await expect(page.getByTestId("violation-SECOND_OPINION_DISAGREES")).toBeVisible();
    await expect(page.getByTestId("violation-SECOND_OPINION_DISAGREES")).toContainText("disagree");
    // Either service could be the liar, so the refusal never tells the person
    // to drop the second opinion: that is what a lying main service would want.
    await expect(page.getByTestId("violation-SECOND_OPINION_DISAGREES")).toContainText("Either one could be wrong, your main service included.");
    await expect(page.getByTestId("swap-button")).toHaveCount(0);
    expect(tampered).toBeGreaterThan(0);
  });

  test("a second service that doesn't answer leaves the swap checked on one service, and says so", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, withSecondOpinion(SECOND_URL));
    // Its own failure, and only its own: the main service answers as always.
    await page.route((url) => url.origin === SECOND_ORIGIN, (route) => route.abort());
    await page.goto("/");
    await openTile(page, "trade");

    await quoteEth(page, "0.01");
    await expect(page.getByTestId("guard-banner")).toContainText("Checked on one service", { timeout: 90_000 });
    await expect(page.getByTestId("guard-level")).toHaveText("unverified");
    await expect(page.getByTestId("guard-banner")).toContainText("Tested on your main service only");
    await expect(page.getByTestId("warning-SECOND_OPINION_UNAVAILABLE")).toBeVisible();
    await expect(page.getByTestId("swap-button")).toBeVisible();
    await expect(page.getByTestId("strip-safety")).toHaveText("available · second opinion not answering");
  });

  test("an older spDEX saving in another tab never switches the second opinion off here", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, withSecondOpinion(SECOND_URL));
    await page.goto("/");
    await openTile(page, "trade");
    // Nothing has been checked yet, so the strip says what will happen.
    await expect(page.getByTestId("strip-safety")).toHaveText("available · checks on 2 services", { timeout: 60_000 });

    // What a tab running a version-8 spDEX writes: this config, without the
    // second opinion it has no field for. The storage event is the one the
    // browser sends every other tab of this origin.
    await page.evaluate(() => {
      const key = "spdex.config.v1";
      const current = JSON.parse(localStorage.getItem(key) ?? "{}") as { schemaVersion: number; guard: Record<string, unknown> };
      const { secondOpinion: _dropped, ...guard } = current.guard;
      localStorage.setItem(key, JSON.stringify({ ...current, schemaVersion: 8, guard }));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });

    await expect(page.getByTestId("older-tab")).toContainText(
      "Another spDEX tab running an older version just saved settings. Close or reload it; this tab kept yours.",
    );
    // This tab's settings went back into storage, so a reload opens with them.
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem("spdex.config.v1") ?? "{}") as { schemaVersion?: number; guard?: { secondOpinion?: { url?: string | null } } },
    );
    expect(stored.schemaVersion).toBe(9);
    expect(stored.guard?.secondOpinion?.url).toBe(SECOND_URL);
    await expect(page.getByTestId("strip-safety")).toHaveText("available · checks on 2 services");
  });

  test("an older spDEX's save found on load, with no newer tab open to answer it, is offered back rather than kept silently", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    const mine = await seedConfig(page, withSecondOpinion(SECOND_URL));
    // The state an older copy leaves when it saves with no newer tab open:
    // this version's last save under the key only it writes, and the older
    // one's version-8 config, without the second opinion, under the shared
    // key. Once only, before the page's first load: `seedConfig` re-seeds the
    // shared key on every navigation, and this runs after it.
    await page.addInitScript((kept: string) => {
      if (sessionStorage.getItem("older-save-seeded") === "1") return;
      sessionStorage.setItem("older-save-seeded", "1");
      const current = JSON.parse(kept) as { guard: Record<string, unknown> };
      const { secondOpinion: _dropped, ...guard } = current.guard;
      localStorage.setItem("spdex.config.newest.v1", JSON.stringify({ schemaVersion: 9, config: { ...current, schemaVersion: 9 } }));
      localStorage.setItem("spdex.config.v1", JSON.stringify({ ...current, schemaVersion: 8, guard }));
    }, JSON.stringify(mine));
    await page.goto("/");
    await openTile(page, "trade");

    await expect(page.getByTestId("older-save")).toContainText("An older spDEX saved settings in this browser");
    await expect(page.getByTestId("older-save")).toContainText("such as a second opinion");
    // Asked, not decided: until the person answers, the older save is what runs.
    await expect(page.getByTestId("strip-safety")).toHaveText("available", { timeout: 60_000 });

    await page.getByTestId("older-save-restore").click();
    await expect(page.getByTestId("older-save")).toHaveCount(0);
    await expect(page.getByTestId("strip-safety")).toHaveText("available · checks on 2 services");
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem("spdex.config.v1") ?? "{}") as { schemaVersion?: number; guard?: { secondOpinion?: { url?: string | null } } },
    );
    expect(stored.schemaVersion).toBe(9);
    expect(stored.guard?.secondOpinion?.url).toBe(SECOND_URL);
  });

  test("the setting tests a service before it can be used: not the main one, not another chain", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, { preset: "custom" });
    // A service on chain 1, made in the page: it answers eth_chainId and nothing else.
    const OTHER = "http://second-opinion.invalid:8545";
    await page.route(
      (url) => url.origin === new URL(OTHER).origin,
      async (route: Route) => {
        const request = route.request();
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
        const body = JSON.parse(request.postData() ?? "{}") as { id?: unknown; method?: string };
        const payload = body.method === "eth_chainId" ? { result: "0x1" } : { error: { code: -32601, message: "Method not found" } };
        return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }) });
      },
    );
    await page.goto("/");
    await openTile(page, "trade");
    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    await openSection(page, "expert-safety");

    const url = page.getByTestId("second-opinion-url");
    // Something that isn't an address: Test stays off, and a line says why.
    await url.fill("not an address");
    await expect(page.getByTestId("second-opinion-test")).toBeDisabled();
    await expect(page.getByTestId("second-opinion-invalid")).toHaveText("Enter a whole web address, starting with https:// or http://.");
    await url.fill(`${FORK_URL}/`);
    await expect(page.getByTestId("second-opinion-error")).toHaveText("That's your main service. A second opinion has to come from somewhere else.");
    await expect(page.getByTestId("second-opinion-test")).toBeDisabled();

    await url.fill(OTHER);
    await page.getByTestId("second-opinion-test").click();
    await expect(page.getByTestId("second-opinion-error")).toHaveText(`That service is on chain 1, not ${FORK_CHAIN_ID}.`, { timeout: 60_000 });
    await expect(page.getByTestId("second-opinion-save")).toHaveCount(0);

    await url.fill(SECOND_URL);
    await page.getByTestId("second-opinion-test").click();
    await expect(page.getByTestId("second-opinion-passed")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("second-opinion-save").click();
    await expect(page.getByTestId("second-opinion-current")).toContainText(SECOND_URL);
    await expect(page.getByTestId("strip-safety")).toHaveText("available · checks on 2 services");
    const saved = await page.evaluate(
      () => (JSON.parse(localStorage.getItem("spdex.config.v1") ?? "{}") as { guard?: { secondOpinion?: { url?: string | null } } }).guard?.secondOpinion?.url,
    );
    expect(saved).toBe(SECOND_URL);

    await page.getByTestId("second-opinion-remove").click();
    await expect(page.getByTestId("second-opinion-current")).toHaveCount(0);
    await expect(page.getByTestId("strip-safety")).toHaveText("available");
  });
});
