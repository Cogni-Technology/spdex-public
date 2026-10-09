/**
 * Vault helpers for the smoke specs: reading a vault's events from a receipt,
 * and closing whatever this run's agents left open.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import { decodeVaultEvent, encodeClose, readVault, type VaultEvent, type VaultState } from "../packages/vault/src/index.js";
import { parseEther } from "../e2e/vaults.js";
import { FACTORIES, rpc, type Receipt } from "./chain.js";
import { agentVaults, agents, sendAs } from "./wallet.js";

type Hex = `0x${string}`;

/** The one event of a kind that `emitter` emitted in a mined transaction. */
export function eventIn<N extends VaultEvent["name"]>(receipt: Receipt, emitter: string, name: N): Extract<VaultEvent, { name: N }> {
  const events = receipt.logs
    .map((log) => decodeVaultEvent(log))
    .filter((event): event is Extract<VaultEvent, { name: N }> => event?.name === name && event.emitter === emitter.toLowerCase());
  expect(events, `${name} events from ${emitter} in ${receipt.transactionHash}`).toHaveLength(1);
  return events[0]!;
}

/** The vault as the app and the keeper read it, of either release. Throws when nothing there answers like a vault. */
export async function vaultOnChain(vault: string): Promise<VaultState> {
  const state = await readVault(rpc, vault.toLowerCase() as Hex, { factories: FACTORIES });
  if (state === null) throw new Error(`${vault} does not answer like a vault`);
  return state;
}

/**
 * Close every vault an agent owns that still holds something, on either
 * release's factory, this run's or one an earlier run left (a run cut off by
 * a lost connection, say), from its owner's key, so nothing stays funded for
 * a keeper to find. Returns what it closed.
 */
export async function closeOpenVaults(): Promise<Hex[]> {
  const byAddress = new Map(Object.values(agents()).map((agent) => [agent.address, agent]));
  const closed: Hex[] = [];
  for (const vault of await agentVaults()) {
    const state = await vaultOnChain(vault);
    // Closed, or every buy made and nothing left: closing would only cost gas.
    if (state.closed || state.status.wethBalance === 0n) continue;
    const owner = byAddress.get(state.owner.toLowerCase() as Hex);
    if (!owner) continue;
    await sendAs(owner, { to: vault, data: encodeClose() }, "clean-up: close a vault left open");
    closed.push(vault);
  }
  return closed;
}

/**
 * Connect, open Recurring and fill in a vault plan in the Expert view:
 * `amount` ETH → SPX every `minutes` minutes (How often → Custom…), `count`
 * times, at the default 2% allowance and the default community window. The
 * gate's `fillVaultForm` (e2e/vaults.ts) checks the Simple view, where no
 * window can be chosen; this is the same form as Expert shows it, with the
 * window's choice beside the line everyone sees. Returns Start, enabled, and
 * what the form says goes in for the buys.
 */
export async function fillExpertVaultForm(page: Page, amount: string, count: number, minutes: number): Promise<{ start: Locator; forBuys: bigint }> {
  await page.getByTestId("connect-button").click();
  await page.getByTestId("buy-mode-recurring").click();
  // The vault first: choosing it resets the pair, and with it an amount typed for another token.
  const choice = page.getByTestId("dca-form-signer-vault");
  await expect(choice.getByRole("radio")).toBeEnabled({ timeout: 60_000 });
  await expect(choice.locator(".spdex-choice__title")).toHaveText("Set and forget");
  await choice.getByRole("radio").check();
  await page.getByTestId("dca-form-amount").fill(amount);
  await page.getByTestId("dca-form-count").fill(String(count));
  await expect(choice.getByTestId("dca-form-vault-badge")).toHaveText("Unaudited");
  await expect(page.getByTestId("dca-form-sell")).toHaveValue("ETH");
  await expect(page.getByTestId("dca-form-buy")).toHaveValue("SPX");
  await expect(page.getByTestId("dca-form-vault-slippage-200")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("dca-form-frequency").selectOption("custom");
  await page.getByTestId("dca-form-custom-minutes").fill(String(minutes));
  // The default window: 30 minutes, or a quarter of the interval when that is
  // shorter (75 seconds at five minutes), shown as the preset it equals, if any.
  const window = Math.min(1_800, Math.floor((minutes * 60) / 4));
  const length = window === 60 ? "minute" : window % 60 === 0 ? `${window / 60} minutes` : `${window} seconds`;
  // In How auto-buy works, one tap away: the line is in the page either way.
  await expect(page.getByTestId("dca-form-vault-window-line")).toHaveText(
    `SPX holders can earn this plan's fee for its first ${length} after each buy falls due; then anyone can.`,
  );
  await expect(page.getByTestId("dca-form-vault-window")).toHaveValue([60, 300, 900, 1_800, 3_600].includes(window) ? String(window) : "quarter");

  const start = page.getByTestId("dca-form-start");
  await expect(start).toHaveText("Create and fund vault");
  await expect(start).toBeEnabled({ timeout: 60_000 });
  // Every buy, exactly: the summary's "Y ETH in all".
  const summary = ((await page.getByTestId("dca-form-summary").textContent()) ?? "").replace(/\s+/g, " ");
  const forBuys = /: ([\d.]+) ETH in all/.exec(summary);
  expect(forBuys, summary).not.toBeNull();
  return { start, forBuys: parseEther(forBuys![1]!) };
}
