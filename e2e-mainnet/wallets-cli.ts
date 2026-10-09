/**
 * `pnpm mainnet:smoke:wallets`: make the three agent wallets, once, and print
 * their addresses to fund. Run again, it makes nothing new and prints the
 * same addresses. docs/MAINNET-SMOKE.md says how much each needs.
 */

import { makeWallets } from "./keys.js";
import { smokeHome } from "./settings.js";

const home = smokeHome();
const wallets = makeWallets(home);
console.log(`Agent wallets in ${home} (keystores/, opened by the password file beside it):`);
for (const wallet of wallets) console.log(`  ${wallet.name.padEnd(7)} ${wallet.address}${wallet.made ? "  (made now)" : ""}`);
console.log("\nFund them from your own wallet; pnpm mainnet:smoke:sweep <your address> sends everything back.");
