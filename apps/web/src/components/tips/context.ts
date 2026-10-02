/**
 * What the tip components share: this browser's "My tip list", the shipped
 * list as the registries named it, and who `tippableRecipients` says gets
 * paid. Provided once by App, read by the Tip row, the Settings section and
 * the settings-link prompt, so all three say the same thing about an address.
 */

import { createContext, useContext } from "react";
import type { JsonRpc } from "@spdex/chain";
import type { DiscoveredRecipient } from "../../lib/engine.js";
import { EMPTY_TIPLIST, tipListStore, type TipListState, type TipListStore } from "../../lib/tiplist/store.js";
import type { Tippable } from "../../lib/tiplist/checks.js";

export interface TipsEnv {
  list: TipListState;
  store: TipListStore;
  /**
   * The shipped entries (both registries), retired ones included; null until
   * they are read (once a network service is chosen, tips on or off). Null
   * is "not read", never "nobody listed".
   */
  defaults: readonly DiscoveredRecipient[] | null;
  /** Whether tips are on. */
  tipsOn: boolean;
  /** Lowercase addresses of listed entries whose signed claim verified. */
  signed: ReadonlySet<string>;
  /** The person's own network service, for ENS names and the code at an address; null before one is chosen. */
  rpc: JsonRpc | null;
  /** Their second opinion, when set: those two reads go through it too (lib/tiplist/lookup.ts). */
  second: { rpc: JsonRpc; host: string } | null;
  account: `0x${string}` | null;
  chainId: number;
  /** Who a swap tips now, and who it skips. */
  tippable: Tippable;
  /** How many chosen recipients the first load stamped confirmed, until the banner is dismissed. */
  migrated: number;
  dismissMigrated: () => void;
}

const FALLBACK: TipsEnv = {
  list: EMPTY_TIPLIST,
  get store() {
    return tipListStore();
  },
  defaults: null,
  tipsOn: false,
  signed: new Set(),
  rpc: null,
  second: null,
  account: null,
  chainId: 1,
  tippable: { pay: [], skipped: [] },
  migrated: 0,
  dismissMigrated: () => undefined,
};

export const TipsContext = createContext<TipsEnv>(FALLBACK);

export function useTips(): TipsEnv {
  return useContext(TipsContext);
}
