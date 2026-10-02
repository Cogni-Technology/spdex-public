/**
 * The ERC-20 calls the app makes directly.
 *
 * Hand-encoded rather than pulling in an ABI codec: every one is static, two
 * words at most, and the app already ships a hand-rolled encoder inside the
 * venue module for the same reason.
 */

import { isNativeToken, type JsonRpc } from "@spdex/chain";

const SELECTOR_ALLOWANCE = "0xdd62ed3e";
const SELECTOR_APPROVE = "0x095ea7b3";
const SELECTOR_BALANCE_OF = "0x70a08231";
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export async function allowance(
  rpc: JsonRpc,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const data = `${SELECTOR_ALLOWANCE}${word(owner)}${word(spender)}`;
  const raw = (await rpc("eth_call", [{ to: token, data }, "latest"])) as string;
  return raw === "0x" ? 0n : BigInt(raw);
}

/**
 * A balance, whether or not the token is a contract.
 *
 * Native ether has no `balanceOf`, so it is read with `eth_getBalance`. Hiding
 * that behind one function keeps the branch out of every caller — and there
 * are several, each of which would otherwise have to remember that one of the
 * four tokens in the list is not a contract.
 *
 * `block` is "latest" unless a caller needs what is already promised too:
 * "pending" counts transactions the endpoint holds but has not mined.
 */
export async function balanceOf(
  rpc: JsonRpc,
  token: string,
  owner: string,
  block: "latest" | "pending" = "latest",
): Promise<bigint> {
  if (isNativeToken(token)) {
    return quantity(await rpc("eth_getBalance", [owner, block]), "ether balance");
  }
  const data = `${SELECTOR_BALANCE_OF}${word(owner)}`;
  return quantity(await rpc("eth_call", [{ to: token, data }, block]), "token balance");
}

/**
 * How many of a token exist, in its base units — for the ticker's "% to flip",
 * nothing that moves money.
 *
 * Refuses rather than defaulting, like `balanceOf`: a zero read from `"0x"`
 * (no contract at that address on this chain, or an endpoint that failed)
 * would put "0% to flip" on screen as though it had been measured.
 */
export async function totalSupply(rpc: JsonRpc, token: string): Promise<bigint> {
  return quantity(await rpc("eth_call", [{ to: token, data: SELECTOR_TOTAL_SUPPLY }, "latest"]), "total supply");
}

/**
 * A balance or a supply as the endpoint answered it, or a refusal.
 *
 * Never a default. An empty `"0x"` from `eth_call` is what a call to an
 * address with no code returns — or what an endpoint that failed says — and
 * neither is "holds none": read as zero, it would let a withdrawal skip a
 * token and sweep the ether that token needed for gas, or let a spending
 * wallet that still holds something be called empty and its key forgotten.
 * The callers that only show a balance already treat a failed read as unknown.
 */
function quantity(raw: unknown, what: string): bigint {
  if (typeof raw === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(raw)) return BigInt(raw);
  throw new Error(`could not read the ${what}: the endpoint answered ${JSON.stringify(raw) ?? String(raw)}`);
}

export function encodeApprove(spender: string, amount: bigint): `0x${string}` {
  return `${SELECTOR_APPROVE}${word(spender)}${word(amount.toString(16))}` as `0x${string}`;
}
