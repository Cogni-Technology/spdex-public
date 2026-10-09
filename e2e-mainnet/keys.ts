/**
 * The agent wallets' keys: cast keystores in `SPDEX_SMOKE_HOME/keystores`,
 * all opened by one password in `SPDEX_SMOKE_HOME/password`.
 *
 * cast makes and opens them, so the files are the ones `cast send --keystore`
 * takes by hand. The password reaches cast through its environment
 * (`CAST_PASSWORD`, `CAST_UNSAFE_PASSWORD`), never a command line, where
 * every process on the machine could read it, and a key comes back over a
 * pipe into this process's memory: nothing here prints, logs or writes one.
 *
 * Whatever can read the password file can spend from these wallets. That is
 * the whole of their protection, so they hold small amounts, and the
 * harness's budget (budget.ts) bounds what one run sends out of them.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addressOfKey } from "../packages/chain/src/index.js";
import { AGENT_NAMES, type AgentName } from "./settings.js";

type Hex = `0x${string}`;

export const keystoreName = (name: AgentName) => `spdex-smoke-${name}`;
const keystoreDir = (home: string) => join(home, "keystores");
const passwordFile = (home: string) => join(home, "password");

/** The password, refusing a file other users could read. */
function readPassword(home: string): string {
  const path = passwordFile(home);
  if (!existsSync(path)) throw new Error(`no password file at ${path}: make the wallets with pnpm mainnet:smoke:wallets`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} is readable by other users: chmod 600 it`);
  return readFileSync(path, "utf8").trim();
}

/**
 * Make whichever of the three keystores is missing, and the password file if
 * it is: a random one, readable by this user alone. Never replaces either.
 * Returns every agent's address, and which were made now.
 */
export function makeWallets(home: string): { name: AgentName; address: Hex; made: boolean }[] {
  mkdirSync(keystoreDir(home), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(keystoreDir(home), 0o700);
  if (!existsSync(passwordFile(home))) writeFileSync(passwordFile(home), randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const password = readPassword(home);
  return AGENT_NAMES.map((name) => {
    const file = join(keystoreDir(home), keystoreName(name));
    let made = false;
    if (!existsSync(file)) {
      execFileSync("cast", ["wallet", "new", keystoreDir(home), keystoreName(name)], {
        env: { ...process.env, CAST_PASSWORD: password },
        stdio: ["ignore", "ignore", "pipe"],
      });
      made = true;
    }
    chmodSync(file, 0o600);
    return { name, address: addressOfKey(openKeystore(home, name)) as Hex, made };
  });
}

/** One agent's key, from its keystore. */
export function openKeystore(home: string, name: AgentName): Hex {
  const file = join(keystoreDir(home), keystoreName(name));
  if (!existsSync(file)) throw new Error(`no keystore at ${file}: make the wallets with pnpm mainnet:smoke:wallets`);
  let out: string;
  try {
    out = execFileSync("cast", ["wallet", "decrypt-keystore", keystoreName(name), "-k", keystoreDir(home)], {
      env: { ...process.env, CAST_UNSAFE_PASSWORD: readPassword(home) },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch {
    // Not rethrown: the error object carries cast's stdout.
    throw new Error(`cast could not open ${file}`);
  }
  const key = /private key is: (0x[0-9a-fA-F]{64})\b/.exec(out)?.[1];
  // cast says "Mac Mismatch" on stdout or stderr and exits 0, so the answer's
  // shape is the check. The message never includes what came back.
  if (!key) throw new Error(`cast could not open ${file} with the password in ${passwordFile(home)}`);
  return key.toLowerCase() as Hex;
}
