/**
 * Development accounts whose private keys are public, and the networks where
 * they may be tipped.
 *
 * ## Why the host refuses these, whatever any list says
 *
 * Anvil, Hardhat and most local test tools derive their prefunded accounts
 * from one published mnemonic ("test test … junk"). Their private keys are in
 * every tutorial, so on a real network money sent to one is money anyone can
 * take, and bots sweep those accounts within blocks. They are fine to tip on a
 * local fork, where the flow is exercised end to end and the tip can be
 * watched arriving, and nowhere else.
 *
 * So the list here is data the host checks against, not a list anyone picks
 * from: the Tip row's picker withholds these outside `PLACEHOLDER_CHAINS`,
 * "My tip list" refuses them, `tippableRecipients` skips them, and TipGuard
 * refuses a transfer to one (`TIP_MALFORMED`, reason `public-dev-account`).
 *
 * Plain data, like the rest of core: no derivation at runtime. A unit test in
 * `packages/chain` derives the same twenty with viem and compares, so a typo
 * here cannot hide.
 */

import type { Address } from "./primitives.js";

/**
 * The first twenty accounts of the mnemonic
 * `test test test test test test test test test test test junk`, at the path
 * `m/44'/60'/0'/0/i`, lowercase. Twenty because that is how many anvil and
 * Hardhat prefund by default.
 */
export const PUBLIC_DEV_ACCOUNTS: readonly Address[] = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  "0xbcd4042de499d14e55001ccbb24a551f3b954096",
  "0x71be63f3384f5fb98995898a86b02fb2426c5788",
  "0xfabb0ac9d68b0b445fb7357272ff202c5651694a",
  "0x1cbd3b2770909d4e10f157cabc84c7264073c9ec",
  "0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097",
  "0xcd3b766ccdd6ae721141f452c550ca635964ce71",
  "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
  "0xbda5747bfd65f08deb54cb465eb87d40e51b197e",
  "0xdd2fd4581271e230360230f9337d5c0430bf44c0",
  "0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199",
];

const DEV_ACCOUNTS: ReadonlySet<string> = new Set(PUBLIC_DEV_ACCOUNTS);

/** True for one of `PUBLIC_DEV_ACCOUNTS`, in any casing. */
export function isPublicDevAccount(address: string): boolean {
  return DEV_ACCOUNTS.has(address.toLowerCase());
}

/**
 * The networks where test tip entries are offered and a public development
 * account may be tipped: the local fork (690069) and a local test network
 * (31337). Never Ethereum (1), where a tip to one is lost to whoever sweeps it.
 */
export const PLACEHOLDER_CHAINS: ReadonlySet<number> = new Set([690069, 31337]);

/** True on a network where test entries and public development accounts are allowed. */
export function isPlaceholderChain(chainId: number): boolean {
  return PLACEHOLDER_CHAINS.has(chainId);
}
