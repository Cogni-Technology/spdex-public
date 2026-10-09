/**
 * One token balance of the connected wallet, for a panel that shows it:
 * read through the person's network service while `enabled`, and again
 * whenever `refresh` changes (after a swap, a plan's buy). Null until read;
 * "unreadable" when the read failed, which is never shown as 0.
 *
 * `key` names what the figure belongs to (the network and the service):
 * a figure read for another is never returned, even for the moment before
 * the next read lands.
 */

import { useEffect, useState } from "react";
import type { JsonRpc } from "@spdex/chain";
import { balanceOf } from "./erc20.js";

export function useBalance(
  rpc: JsonRpc | null,
  token: string,
  account: string | null,
  options: { enabled: boolean; key: string; refresh?: string },
): bigint | "unreadable" | null {
  const [read, setRead] = useState<{ key: string; value: bigint | "unreadable" } | null>(null);
  const key = `${options.key}:${token.toLowerCase()}:${account ?? ""}`;
  useEffect(() => {
    if (!options.enabled || rpc === null || account === null) return;
    let cancelled = false;
    balanceOf(rpc, token, account)
      .then((value): bigint | "unreadable" => value)
      .catch((): "unreadable" => "unreadable")
      .then((value) => {
        if (!cancelled) setRead({ key, value });
      });
    return () => {
      cancelled = true;
    };
  }, [options.enabled, rpc, token, account, key, options.refresh]);
  return read !== null && read.key === key ? read.value : null;
}
