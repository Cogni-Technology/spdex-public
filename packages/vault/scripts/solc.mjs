/**
 * Which solc builds the vault, for the two scripts that run forge.
 *
 * The factory's address is a pure function of its bytecode, so the compiler is
 * pinned: exactly `SOLC_VERSION`, with the settings in foundry.toml. It is
 * pinned by version rather than by path. `foundry.toml` names the version, and
 * where it is not installed forge fetches the official build from
 * binaries.soliditylang.org and checks it against the published checksum — a
 * statically linked binary, so it runs on NixOS too. That build and Nix's
 * produce byte-identical output here (checked when this was written; the
 * `check:artifacts` step would catch any difference, because it compares a
 * fresh build against the committed bytes).
 *
 * Where the solc on PATH is exactly that build, it is used instead
 * (`--use <path>`), so a machine that has it — the NixOS development box —
 * never downloads a compiler, and needs no network to build.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The compiler the committed artifacts were built with, commit included. */
export const SOLC_VERSION = "0.8.33+commit.64118f21";

/** The first executable `solc` on PATH, or null. */
function solcOnPath(env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "solc");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/**
 * The arguments that point forge at the PATH solc when it is exactly
 * `SOLC_VERSION`, or none, in which case forge uses (or fetches) the version
 * foundry.toml names. A different solc on PATH is ignored rather than used:
 * it would build a different factory.
 */
export function solcArgs(env = process.env) {
  const path = solcOnPath(env);
  if (!path) return [];
  const result = spawnSync(path, ["--version"], { encoding: "utf8", env });
  return result.status === 0 && result.stdout.includes(`Version: ${SOLC_VERSION}`) ? ["--use", path] : [];
}
