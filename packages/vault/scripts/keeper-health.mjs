/**
 * The keeper's Docker healthcheck: liveness only. Exits 0 when the heartbeat
 * file was written recently — within three intervals, and never less than
 * three minutes — and 1 otherwise.
 *
 * It says nothing about whether the endpoint answers or batches land: an RPC
 * outage shows in the heartbeat as `ok: false` and in its `attention` list,
 * not here, because restarting the container fixes neither. A keeper whose
 * ticks stop completing exits on its own watchdog, and Compose's restart
 * policy brings it back; plain Compose never acts on health (docs/KEEPER.md).
 *
 * Reads SPDEX_KEEPER_HEARTBEAT_FILE, else $SPDEX_KEEPER_DATA_DIR/heartbeat.json,
 * else the newest ./.keeper/<chainId>/heartbeat.json.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvedEnv } from "../../../scripts/env.mjs";

const env = resolvedEnv();

function heartbeatFile() {
  if (env.SPDEX_KEEPER_HEARTBEAT_FILE) return env.SPDEX_KEEPER_HEARTBEAT_FILE;
  if (env.SPDEX_KEEPER_DATA_DIR) return join(env.SPDEX_KEEPER_DATA_DIR, "heartbeat.json");
  if (!existsSync(".keeper")) return null;
  const candidates = readdirSync(".keeper")
    .map((dir) => join(".keeper", dir, "heartbeat.json"))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function unhealthy(reason) {
  console.error(`keeper-health: ${reason}`);
  process.exit(1);
}

const file = heartbeatFile();
if (!file || !existsSync(file)) unhealthy("no heartbeat file yet");

let heartbeat;
try {
  heartbeat = JSON.parse(readFileSync(file, "utf8"));
} catch {
  unhealthy("the heartbeat file is not JSON");
}
const written = Date.parse(heartbeat.ts ?? "");
if (!Number.isFinite(written)) unhealthy("the heartbeat has no time");

const interval = Number(env.SPDEX_KEEPER_INTERVAL_SECONDS || 60);
const allowed = Math.max(180, 3 * (Number.isFinite(interval) && interval > 0 ? interval : 60));
const age = (Date.now() - written) / 1000;
if (age > allowed) unhealthy(`the last heartbeat is ${Math.round(age)} s old (allowed ${allowed} s)`);
console.log(`keeper-health: ok (heartbeat ${Math.round(age)} s old${heartbeat.ok === false ? "; the last tick was not ok" : ""})`);
process.exit(0);
