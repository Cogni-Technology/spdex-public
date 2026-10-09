/**
 * Networks by name.
 *
 * A newcomer does not know that 690069 is the local fork or that 1 is
 * Ethereum, and "Wallet is on chain 11155111" tells them nothing they can act
 * on. So every place the app names a network says its name first and keeps the
 * number beside it: the number is what a wallet's network settings show, and it
 * is what tests and bug reports quote.
 *
 * The list is short on purpose. It names the networks spDEX is built and
 * tested against; anything else is called by its number rather than by a name
 * nobody here has checked.
 */

const NAMES: Readonly<Record<number, string>> = {
  1: "Ethereum",
  11155111: "Sepolia test network",
  690069: "Local fork",
  31337: "Local test network",
};

/** True when the network has a name here (and so a label reads "{name} (chain {id})"). */
export function isNamedNetwork(chainId: number): boolean {
  return Object.hasOwn(NAMES, chainId);
}

/** "Ethereum", "Local fork", or "Chain 8453" for a network this list does not name. */
export function networkName(chainId: number): string {
  return NAMES[chainId] ?? `Chain ${chainId}`;
}

/**
 * "Ethereum (chain 1)", or "chain 8453" when there is no name.
 *
 * Used in sentences ("Your wallet is on …"), where the number must survive:
 * it is what the user will look for in their wallet, and "chain 1" is how the
 * wrong-network banner has always identified mainnet.
 */
export function networkLabel(chainId: number): string {
  return isNamedNetwork(chainId) ? `${networkName(chainId)} (chain ${chainId})` : `chain ${chainId}`;
}
