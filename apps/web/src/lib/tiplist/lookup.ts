/**
 * The two reads a new tip address depends on, through the person's own
 * services: where an ENS name points, and whether there is code at the
 * address.
 *
 * Both through the main network service, as everything is; and, when the
 * person set a second opinion (Settings → Safety), through that one too.
 * The Guard's test-run can't catch a lie here: a transfer to the wrong
 * address runs exactly like one to the right address. So a name the two
 * services answer differently is refused, the way the Guard refuses a plan
 * they disagree about, and code they read differently is said, as a danger.
 * Every request goes to one of the two services the person chose (rule 4).
 */

import { resolveEnsName, type EnsLookup, type JsonRpc } from "@spdex/chain";
import type { Address } from "@spdex/core";
import { codeKind, type CodeKind } from "./checks.js";

/** The person's services: the main one, and the second opinion when one is set. */
export interface TipServices {
  main: JsonRpc;
  second: { rpc: JsonRpc; host: string } | null;
}

export type NameLookup =
  | { ok: true; name: string; address: Address; checkedByBoth: boolean }
  | { ok: false; message: string };

/** What refusing a name the two services disagree about says, in the words of SECOND_OPINION_DISAGREES. */
export function namesDisagree(host: string): string {
  return (
    `Your two network services disagree about where this name points, so spDEX won't use it. ` +
    `Either one could be wrong, your main service included. Paste the address, or try again in a moment; ` +
    `if it keeps happening, try another main service rather than removing your second opinion, ${host}.`
  );
}

/**
 * `name` to an address through the main service and, when set, the second
 * opinion: the same address from both, or no address at all. A second
 * opinion that can't read the name leaves it unchecked, which is said
 * rather than passed over.
 */
export async function resolveTipName(services: TipServices, name: string): Promise<NameLookup> {
  const main: EnsLookup = await resolveEnsName(services.main, name);
  if (!main.ok) return { ok: false, message: main.message };
  if (services.second === null) return { ok: true, name: main.name, address: main.address, checkedByBoth: false };
  const second = await resolveEnsName(services.second.rpc, name);
  if (!second.ok && second.reason === "unreadable") {
    return {
      ok: false,
      message: `Your second opinion, ${services.second.host}, couldn't read this name, so it can't be checked. Try again, or paste the address.`,
    };
  }
  if (!second.ok || second.address.toLowerCase() !== main.address.toLowerCase()) {
    return { ok: false, message: namesDisagree(services.second.host) };
  }
  return { ok: true, name: main.name, address: main.address, checkedByBoth: true };
}

/** One service's answer about the code at `address`; unread is "unknown", never "none". */
async function codeAt(rpc: JsonRpc, address: string): Promise<CodeKind> {
  try {
    return codeKind(await rpc("eth_getCode", [address, "latest"]));
  } catch {
    return "unknown";
  }
}

/**
 * What is at `address`, read through the main service and the second opinion
 * when one is set. Both must read it, and alike: a service that can't is
 * "unknown", and two that differ are "disputed".
 */
export async function readTipCode(services: TipServices, address: string): Promise<CodeKind> {
  const main = await codeAt(services.main, address);
  if (services.second === null || main === "unknown") return main;
  const second = await codeAt(services.second.rpc, address);
  if (second === "unknown") return "unknown";
  return second === main ? main : "disputed";
}
