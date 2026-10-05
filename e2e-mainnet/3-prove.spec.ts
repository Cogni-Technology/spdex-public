/**
 * The holder agent proves its SPX, once: Collective DCA → Help run the
 * network → Community keeping → **Prove my SPX**, from the holder agent's own
 * page (settings.ts, `HOLDER`). One transaction to the SPX holder registry,
 * with no ether, built in the page from the `finalized` block, checked by the
 * Guard, and read back from the registry's own `Proven` event. From then on
 * the holder agent may be paid inside a v2 vault's community window, which
 * the specs after this one need: the keeper's `rewardTo` and Help run's
 * connected wallet are the holder agent.
 *
 * Once, not every run. `validUntil` is read first, as the panel reads it: a
 * proof valid for more than five more days needs nothing, and the panel
 * offers none (a newer one would only move its date). Then this spec checks
 * that the panel says the wallet is a community keeper, and sends nothing.
 * A proof that wouldn't move `validUntil` would revert `NotNewer`, so the
 * harness's wallet refuses to sign one (wallet.ts), and this spec checks that
 * too, on the very transaction it just sent.
 *
 * On a fork the holder agent can't be proven for real: its 690 SPX was
 * written there, never held at a block anyone can prove (global-setup.ts
 * writes its registry record too). So on a fork it takes the "already
 * proven" path, and the registry's real transaction is rehearsed with
 * **Prove another address**, for a real account that held 690 SPX at the
 * fork's `finalized` block: the same proof built in the page, the same
 * Guard, the same one call, paid for by the holder agent. Never on mainnet:
 * there the harness signs a proof of the holder agent only.
 */

import type { Page } from "@playwright/test";
import { PROOF_LAPSE_WARNING_SECONDS, provenBy, type RawLog } from "../packages/vault/src/index.js";
import { expect, openTile, seedConfig, test } from "../e2e/fixtures.js";
import { REGISTRY, holderStatus, minedReceipt, rpc, validUntilOf } from "./chain.js";
import { HOLDER, currentRun } from "./settings.js";
import { MINED_WITHIN_MS, agents, pageWallet, refusal, settleMined, type PageWallet } from "./wallet.js";

type Hex = `0x${string}`;

test.describe.configure({ mode: "serial" });
test.afterEach(async () => {
  await settleMined();
});

/** The page's own waits: a block, its receipt poll, and its reads after. */
const UI_WAIT = () => MINED_WITHIN_MS() + 60_000;

const ELIGIBLE = "Your wallet is a community keeper: buys inside their community window can pay it.";

/** Collective DCA, then Community keeping unfolded, with the wallet's standing read. */
async function openKeeping(page: Page): Promise<void> {
  await openTile(page, "community");
  await expect(page.getByTestId("help-run")).toBeVisible({ timeout: 60_000 });
  const panel = page.getByTestId("keeper-panel");
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) await page.getByTestId("keeper-panel-summary").click();
  await expect(page.getByTestId("keeper-standing").or(page.getByTestId("keeper-read-failed"))).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("keeper-read-failed")).toHaveCount(0);
}

/**
 * Wait for the panel to say a proof was included, then check that one
 * transaction went, to the registry, with no ether, and that the registry
 * recorded `holder` from it. Returns the receipt's `Proven`, the calldata
 * and its gas.
 */
async function provenFromPage(page: Page, wallet: PageWallet, sentBefore: number, holder: Hex) {
  await expect(page.getByTestId("keeper-result-text")).toHaveText(/^Proven: valid until .+\.$/, { timeout: UI_WAIT() });
  // Public sending, as the page is set up: one transaction, broadcast, and nothing signed to hand back.
  expect(wallet.hashes).toHaveLength(sentBefore + 1);
  expect(wallet.signed).toHaveLength(0);
  const hash = wallet.hashes.at(-1)!;
  const receipt = await minedReceipt(hash, MINED_WITHIN_MS());
  const tx = (await rpc("eth_getTransactionByHash", [hash])) as { to: string; value: string; input: Hex };
  expect(tx.to.toLowerCase()).toBe(REGISTRY);
  expect(BigInt(tx.value)).toBe(0n);
  const proven = provenBy(REGISTRY, receipt.logs as RawLog[]);
  expect(proven).toHaveLength(1);
  expect(proven[0]!.holder).toBe(holder);
  expect(await validUntilOf(holder)).toBe(proven[0]!.validUntil);
  return { proven: proven[0]!, data: tx.input.toLowerCase() as Hex, gasUsed: BigInt(receipt.gasUsed) };
}

test("the holder agent proves its SPX once, and the panel says it is a community keeper", async ({ page, context }) => {
  const run = currentRun();
  const holder = agents()[HOLDER];
  const wallet = await pageWallet(context, holder, "prove: the holder agent's SPX");
  await seedConfig(page);
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();

  // Read first, as the panel does: whether a proof would do anything at all.
  const before = await holderStatus(holder.address);
  expect(before.isAccount, "the holder agent must be an ordinary account").toBe(true);
  const needsProof = before.proofValid !== true || before.validUntil! - before.chainTime! <= PROOF_LAPSE_WARNING_SECONDS;
  await openKeeping(page);
  await expect(page.getByTestId("keeper-holding")).toContainText("690 is the bar.");

  if (!needsProof) {
    // Proven, for more than five more days: nothing to send, and nothing offered.
    await expect(page.getByTestId("keeper-standing")).toHaveAttribute("data-eligible", "true");
    await expect(page.getByTestId("keeper-eligible")).toHaveText(ELIGIBLE);
    await expect(page.getByTestId("keeper-proof")).toContainText("Its proof is valid until");
    await expect(page.getByTestId("keeper-prove")).toHaveCount(0);
    expect(wallet.hashes).toHaveLength(0);
    const until = new Date(Number(before.validUntil) * 1000).toISOString();
    test.info().annotations.push({ type: "holder agent", description: `proven until ${until}${run.mode === "fork" ? " (written on the fork)" : ""}: nothing sent` });
    console.log(`  the holder agent is proven until ${until}: nothing sent`);
    return;
  }

  // ── Prove my SPX: first, what proving publishes, unless it proved before ──
  await page.getByTestId("keeper-prove").click();
  if (before.validUntil === 0n) {
    await expect(page.getByTestId("keeper-publish")).toBeVisible();
    await page.getByTestId("keeper-prove-continue").click();
  }
  const { proven, data, gasUsed } = await provenFromPage(page, wallet, 0, holder.address);
  expect(proven.validUntil).toBeGreaterThan(before.validUntil!);
  expect(proven.balance).toBeGreaterThanOrEqual(690n * 10n ** 8n);
  test.info().annotations.push({ type: "prove gas", description: `${gasUsed} (block ${proven.blockNumber})` });

  // The page reads the standing again: now a community keeper.
  await expect(page.getByTestId("keeper-standing")).toHaveAttribute("data-eligible", "true", { timeout: 60_000 });
  await expect(page.getByTestId("keeper-eligible")).toHaveText(ELIGIBLE);
  expect((await holderStatus(holder.address)).eligible).toBe(true);

  // The same proof again could only revert NotNewer: the wallet refuses it before any key is used.
  expect(await refusal({ from: holder.address, to: REGISTRY, data, value: 0n })).toMatch(/NotNewer/);
});

test("on a fork, the registry's transaction is rehearsed for a real holder through Prove another address", async ({ page, context }) => {
  const run = currentRun();
  test.skip(run.mode !== "fork", "a fork rehearsal only: on mainnet the harness proves the holder agent alone");
  const skip = (reason: string) => {
    // Said on the console too: the list reporter shows a skip, not its reason.
    console.log(`  skipped: ${reason}`);
    test.skip(true, reason);
  };
  const real = run.rehearsalHolder;
  if (real === null) skip("the global setup found no real account holding 690 SPX at the fork's finalized block");
  const holder = agents()[HOLDER];
  const wallet = await pageWallet(context, holder, "prove: a real holder, on the fork");
  await seedConfig(page);
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await openKeeping(page);

  // The fork's finalized block must still be one of Ethereum's: anvil can't
  // prove a block it mined. It counts back 64 blocks from the newest.
  const finalized = (await rpc("eth_getBlockByNumber", ["finalized", false])) as { stateRoot: string };
  if (/^0x0+$/.test(finalized.stateRoot)) skip("the fork has mined more than 64 blocks, so its finalized block is anvil's own: restart pnpm mainnet:smoke:fork");

  // An earlier rehearsal on this fork may have proven it, at an older block.
  const earlier = await validUntilOf(real!);
  await page.getByTestId("keeper-other-summary").click();
  await page.getByTestId("keeper-other-address").fill(real!);
  await page.getByTestId("keeper-prove-other").click();
  if (earlier === 0n) {
    // Never proven: what proving publishes, then Continue.
    await expect(page.getByTestId("keeper-publish")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("keeper-prove-continue").click();
  }
  const { proven, data, gasUsed } = await provenFromPage(page, wallet, 0, real!);
  expect(proven.validUntil).toBeGreaterThan(earlier);
  expect(proven.balance).toBeGreaterThanOrEqual(690n * 10n ** 8n);
  test.info().annotations.push({ type: "prove gas (rehearsal)", description: `${gasUsed} (block ${proven.blockNumber})` });
  console.log(`  rehearsed: proved ${real} at block ${proven.blockNumber}, ${gasUsed} gas`);

  // The same proof again could only revert NotNewer: the wallet refuses it before any key is used.
  expect(await refusal({ from: holder.address, to: REGISTRY, data, value: 0n })).toMatch(/NotNewer/);
});
