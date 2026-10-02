/**
 * Minimal .env reader shared by the fork script and both test configs.
 *
 * Deliberately not dotenv: the only behaviour needed is "later files win, real
 * environment wins over both", and three copies of six lines had already
 * started drifting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

export function loadEnvFiles(files = [".env.defaults", ".env.local"]) {
  const env = {};
  for (const file of files) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return env;
}

/** Real environment variables take precedence over files. */
export function resolvedEnv(files) {
  return { ...loadEnvFiles(files), ...process.env };
}
