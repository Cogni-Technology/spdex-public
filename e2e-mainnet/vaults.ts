/**
 * Vault helpers for the smoke specs: reading a vault's events from a receipt,
 * and closing whatever this run's agents left open.
 */

import { expect } from "@playwright/test";
import { decodeVaultEvent, encodeClose, readVault, type VaultEvent, type VaultState } from "../packages/vault/src/index.js";
import { FACTORY, rpc, type Receipt } from "./chain.js";
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

/** The vault as the app and the keeper read it. Throws when nothing there answers like one the factory made. */
export async function vaultOnChain(vault: string): Promise<VaultState> {
  const state = await readVault(rpc, vault.toLowerCase() as Hex, { factory: FACTORY });
  if (state === null) throw new Error(`${vault} does not answer like a vault`);
  return state;
}

/**
 * Close every vault an agent owns that still holds something, this run's or
 * one an earlier run left (a run cut off by a lost connection, say), from its
 * owner's key, so nothing stays funded for a keeper to find. Returns what it
 * closed.
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
