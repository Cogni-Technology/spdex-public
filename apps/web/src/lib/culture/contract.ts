/**
 * Which contract is SPX6900: the address, as a newcomer should see it and copy
 * it, and the places that list it.
 *
 * Lookalikes exist: tokens with the same name at other addresses, on Ethereum
 * and elsewhere. The one defence a newcomer can use is the address itself,
 * compared with the listings people already trust. So the address is shown in
 * full, checksummed, and computed from `TOKENS.SPX` rather than written out a
 * second time, where a typo would be a second truth nobody checks.
 *
 * spDEX never calls the token, itself or anyone "official" or "unofficial":
 * SPX6900 has no official team for either word to measure against. It says
 * which address spx6900.com, CoinGecko and CoinMarketCap list, and links
 * them so anyone can compare.
 */

import { TOKENS } from "@spdex/chain";
import type { Address } from "@spdex/core";
import { checksumAddress as viemChecksum } from "@spdex/vault";

/**
 * An address in its EIP-55 checksummed form: the same characters, with each
 * letter capitalised where keccak256 of the lowercase hex says so. Wallets and
 * explorers show addresses this way, and a mistyped letter then fails their
 * check instead of pointing somewhere else.
 *
 * viem's `getAddress`, reached through @spdex/vault (the app has no direct
 * dependency on viem), so the app has one checksum and not two; the unit test
 * holds it to the EIP's own examples. Throws on anything that isn't 20 bytes
 * of hex, in a sentence of its own rather than viem's.
 */
export function checksumAddress(address: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an address: ${address}`);
  return viemChecksum(address);
}

/** SPX6900 on Ethereum, checksummed. */
export const SPX_CONTRACT: Address = checksumAddress(TOKENS.SPX.address);

/**
 * ["0xE0f6", "3A42", "4a44", …]: an address or a hash in groups of four, so
 * it can be read aloud and compared a group at a time. For showing only: the
 * groups are set apart by spacing, never by a typed space, so what is
 * selected or copied is the value itself.
 */
export function hexGroups(hex: string): string[] {
  const groups = hex.slice(2).match(/.{1,4}/g) ?? [];
  if (groups.length === 0) return [hex];
  return [`0x${groups[0]}`, ...groups.slice(1)];
}

export interface ContractSource {
  name: string;
  url: string;
}

/**
 * Where SPX6900's address is listed. Links the person follows, never pages
 * spDEX reads: nothing here is fetched.
 */
export const SPX_CONTRACT_SOURCES: readonly ContractSource[] = [
  { name: "spx6900.com", url: "https://www.spx6900.com/" },
  { name: "CoinGecko", url: "https://www.coingecko.com/en/coins/spx6900" },
  { name: "CoinMarketCap", url: "https://coinmarketcap.com/currencies/spx6900/" },
  { name: "Etherscan", url: `https://etherscan.io/token/${SPX_CONTRACT}` },
];

/** The badge's sentence, in the parts the badge sets around the address and its Copy button. */
export const SPX_CONTRACT_TEXT = {
  lead: "SPX6900 on Ethereum is",
  listed: "It's the contract spx6900.com, CoinGecko and CoinMarketCap list.",
  warning: "A token with the same name at any other address is not it.",
} as const;
