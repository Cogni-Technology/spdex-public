/**
 * `pnpm keeper` — make due spDEX vault buys, many to a transaction, for their
 * buy fees. `docs/KEEPER.md` is the operator's guide; `src/keeper.ts` says
 * what one tick does and why.
 *
 * This file is everything around the tick that needs Node: the environment
 * and the key file, the endpoints (with timeouts, so a hung request fails its
 * tick instead of hanging it), a lease so two processes never sign with one
 * key, the state file (written atomically, and ahead of every broadcast), the
 * daily JSONL log, the heartbeat file, a watchdog that exits when ticks stop
 * completing, and a clean stop on SIGTERM.
 *
 * Environment (the real environment, then `.env.local`, then `.env.defaults`;
 * the full table is in docs/KEEPER.md):
 *
 *   SPDEX_KEEPER_RPC_URL(_FILE)   the endpoint for reads (and sends, without a send URL). Required.
 *   SPDEX_KEEPER_SEND_URL(_FILE)  a private, revert-protected endpoint for sends only. Optional.
 *   SPDEX_KEEPER_KEY_FILE         the key; without one this is a dry run that never signs.
 *   SPDEX_KEEPER_REWARD_TO        where batch rewards go (default: the keeper itself). To be paid inside the
 *                                 community windows it must be an account that held 690 SPX, proven.
 *   SPDEX_KEEPER_VAULTS           an allowlist, comma-separated (default: every listed vault).
 *   SPDEX_KEEPER_DATA_DIR         state, lease, heartbeat and logs (default ./.keeper/<chainId>).
 *   SPDEX_KEEPER_PROVE            1: prove rewardTo's SPX to the registry before its proof lapses (default 0).
 *   SPDEX_KEEPER_MIN_RUNWAY_DAYS  warn when the key's ether covers fewer days of sends (default 7; 0 never).
 *
 * Nothing is contacted but the endpoints configured here (and the optional
 * heartbeat URL), no URL or key is ever printed, and free text in the log is
 * redacted of both.
 *
 * Flags: --once, --dry-run, --now, --deploy-batcher, --print-address,
 * --reset-state, --reset-trapped, --forget 0x…, --break-lock.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { Address } from "@spdex/core";
import { addressOfKey } from "@spdex/chain";
import { resolvedEnv } from "../../../scripts/env.mjs";
import {
  KeeperStateError,
  checkKeeperStateIdentity,
  deployMissingBatchers,
  forgetVault,
  keeperConfig,
  keeperEnvFrom,
  keeperTick,
  makeRedactor,
  newKeeperState,
  parseKeeperState,
  resetTraps,
  rewardToOf,
  serializeKeeperState,
  settleInFlight,
  stampRecord,
  toJsonLine,
  type KeeperEnv,
  type KeeperLogBody,
  type KeeperLogRecord,
  type KeeperPolicy,
  type KeeperState,
  type KeeperTickResult,
} from "../src/keeper.js";
import { readVaultCount, type Deployment } from "../src/index.js";
import { fetchRpc, messageOf, packageVersion, writeAtomic } from "./io.js";

const FLAGS = ["--once", "--dry-run", "--now", "--deploy-batcher", "--print-address", "--reset-state", "--reset-trapped", "--break-lock", "--forget"];
const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
for (const [i, arg] of argv.entries()) {
  if (!FLAGS.includes(arg) && argv[i - 1] !== "--forget") fail(`unknown argument ${JSON.stringify(arg.slice(0, 40))}; flags: ${FLAGS.join(" ")}`);
}
const forget = has("--forget") ? argv[argv.indexOf("--forget") + 1] : undefined;
if (has("--forget") && !/^0x[0-9a-fA-F]{40}$/.test(forget ?? "")) fail("--forget takes a vault address");

/** The lease this process holds, if any: released on every exit, so a failed start never blocks the next. */
let lease: Lease | null = null;

function fail(message: string): never {
  console.error(`keeper: ${message}`);
  releaseLease();
  process.exit(1);
}

// ─── Configuration ────────────────────────────────────────────────────────────

const env = resolvedEnv() as Record<string, string | undefined>;
let settings: KeeperEnv;
try {
  settings = keeperEnvFrom(env, { readFile: (path) => readFileSync(path, "utf8") });
} catch (error) {
  // Errors from the parser name the variable and never repeat its value.
  fail(messageOf(error));
}
const redact = makeRedactor(settings.secrets);
const key = settings.keeperKey;

if (has("--print-address")) {
  if (!key) fail("no key: set SPDEX_KEEPER_KEY_FILE to a file holding the keeper's private key");
  const keeper = addressOfKey(key);
  console.log(`keeper   ${keeper}`);
  console.log(`rewardTo ${settings.rewardTo ?? keeper}`);
  process.exit(0);
}

const rpcUrl = settings.rpcUrl ?? fail("set SPDEX_KEEPER_RPC_URL (or SPDEX_KEEPER_RPC_URL_FILE) to the endpoint to read from");
// Reads time out after 15 s and sends after 30 s, so a hung endpoint fails a tick rather than stalling it.
const rpc = fetchRpc(rpcUrl, 15_000);
const sendRpc = fetchRpc(settings.sendUrl ?? rpcUrl, 30_000);

let chainId: number;
try {
  chainId = Number(BigInt((await rpc("eth_chainId", [])) as string));
} catch (error) {
  fail(`the endpoint did not answer eth_chainId: ${redact(messageOf(error))}`);
}

const dryRun = has("--dry-run") || !key;
const signingKey = dryRun ? null : key;
const keeper: Address | null = signingKey ? addressOfKey(signingKey) : null;
const policy: KeeperPolicy = { ...settings.policy, ...(has("--now") ? { sendWhen: "now" as const } : {}) };
// A dry run with a key still simulates with the address its rewards would go to.
const rewardTo = settings.rewardTo ?? (key ? addressOfKey(key) : null);
const config = keeperConfig({
  chainId,
  ...(signingKey ? { keeperKey: signingKey } : {}),
  ...(rewardTo ? { rewardTo } : {}),
  ...(settings.vaults ? { vaults: settings.vaults } : {}),
  privateSend: settings.sendPrivate,
  prove: settings.prove,
  gasPerVault: settings.gasPerVault,
  policy,
});

const dataDir = resolve(settings.dataDir ?? join(".keeper", String(chainId)));
const statePath = join(dataDir, "state.json");
const lockPath = join(dataDir, "keeper.lock");
const heartbeatPath = settings.heartbeatFile ? resolve(settings.heartbeatFile) : join(dataDir, "heartbeat.json");
// A dry run writes nothing: no state, lease, heartbeat or log file, so it can run beside a real keeper.
const writesFiles = !dryRun;
if (writesFiles) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);

// ─── The log ──────────────────────────────────────────────────────────────────

let state: KeeperState = newKeeperState({ chainId, keeper, deployments: config.deployments });
const logToFile = writesFiles && settings.logFile !== "-";

function write(record: KeeperLogRecord): void {
  const { line, invalid } = toJsonLine(record, redact);
  process.stdout.write(`${line}\n`);
  if (logToFile) {
    const path = settings.logFile ? resolve(settings.logFile) : join(dataDir, `keeper-${record.ts.slice(0, 10)}.jsonl`);
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  }
  if (invalid.length > 0) emit({ type: "error", where: "log", message: `fields written as null: ${invalid.join(", ")}` });
}

function emit(body: KeeperLogBody): void {
  write(stampRecord(state, keeper, Date.now(), body));
}

// ─── The lease ────────────────────────────────────────────────────────────────

interface Lease {
  pid: number;
  host: string;
  startedAt: string;
  renewedAt: string;
}

/**
 * One signer per key: the lease file is created exclusively, renewed every
 * tick, and a second process finding one renewed within the watchdog period
 * refuses to start. A stale one — its holder gone — is taken over.
 */
function takeLease(): void {
  if (has("--break-lock")) rmSync(lockPath, { force: true });
  const now = new Date().toISOString();
  const mine: Lease = { pid: process.pid, host: hostname(), startedAt: now, renewedAt: now };
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    writeSync(fd, JSON.stringify(mine));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let held: Partial<Lease> = {};
    try {
      held = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<Lease>;
    } catch {
      // Unreadable: treated as stale.
    }
    const age = Date.now() - Date.parse(held.renewedAt ?? "1970-01-01T00:00:00Z");
    if (age <= settings.watchdogSeconds * 1000) {
      fail(
        `another keeper holds ${lockPath} (pid ${held.pid} on ${held.host}, renewed ${Math.round(age / 1000)} s ago); ` +
          "stop it first, or pass --break-lock if it is gone",
      );
    }
    writeAtomic(lockPath, JSON.stringify(mine));
  }
  lease = mine;
}

function renewLease(): void {
  if (!lease) return;
  let held: Partial<Lease> = {};
  try {
    held = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<Lease>;
  } catch {
    // Gone: taken back below.
  }
  if (held.pid !== undefined && (held.pid !== lease.pid || held.host !== lease.host || held.startedAt !== lease.startedAt)) {
    emit({ type: "stop", reason: "fatal", detail: "another process took the lease" });
    process.exit(1);
  }
  lease = { ...lease, renewedAt: new Date().toISOString() };
  writeAtomic(lockPath, JSON.stringify(lease));
}

function releaseLease(): void {
  if (lease) rmSync(lockPath, { force: true });
  lease = null;
}

// ─── The state ────────────────────────────────────────────────────────────────

async function persist(s: KeeperState): Promise<void> {
  if (writesFiles) writeAtomic(statePath, serializeKeeperState(s));
}

if (writesFiles) {
  takeLease();
  if (has("--reset-state") && existsSync(statePath)) {
    const aside = `${statePath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    renameSync(statePath, aside);
    console.error(`keeper: moved the state aside to ${aside}`);
  }
  if (existsSync(statePath)) {
    try {
      state = parseKeeperState(readFileSync(statePath, "utf8"));
      checkKeeperStateIdentity(state, { chainId, keeper, deployments: config.deployments });
    } catch (error) {
      const field = error instanceof KeeperStateError ? ` (field ${error.field})` : "";
      fail(`${statePath}${field}: ${messageOf(error)}. Pass --reset-state to move it aside and start afresh.`);
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

emit({
  type: "start",
  rewardTo,
  chainId,
  dryRun,
  deployments: config.deployments.map((d) => ({
    id: d.id,
    factory: d.factory.toLowerCase() as Address,
    batcher: d.batcher.toLowerCase() as Address,
    registry: d.registry === null ? null : (d.registry.toLowerCase() as Address),
  })),
  sendMode: config.privateSend ? "private" : "public",
  prove: config.prove,
  sendWhen: policy.sendWhen,
  policy: { ...policy },
  version: packageVersion(),
  gitSha: settings.gitSha,
});
if (!dryRun && !settings.sendUrl) {
  emit({ type: "warn", code: "public-mempool", text: "sends go to the public mempool: copiers can take rewards and batches can be sandwiched; set SPDEX_KEEPER_SEND_URL" });
}
if (settings.keyFile && (statSync(settings.keyFile).mode & 0o077) !== 0) {
  emit({ type: "warn", code: "key-permissions", text: "the key file is readable by others; chmod 400 it" });
}
for (const name of settings.unknown) {
  emit({ type: "warn", code: "unknown-setting", text: `${name} is not a setting this keeper reads, so it is ignored; docs/KEEPER.md lists them all` });
}
if (settings.prove && dryRun) {
  emit({ type: "warn", code: "prove-dry-run", text: "SPDEX_KEEPER_PROVE is 1, but a dry run signs nothing: rewardTo is not proven, and its proof's lapse is only logged" });
}
for (const vault of has("--reset-trapped") ? resetTraps(state) : []) emit({ type: "untrapped", vault, why: "reset" });
if (forget && !forgetVault(state, forget.toLowerCase() as Address)) console.error(`keeper: ${forget} was not known`);
await persist(state);

// ─── Startup checks ───────────────────────────────────────────────────────────

const hasCode = async (address: string) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

try {
  const last = config.deployments.at(-1)!;
  const onChain: Deployment[] = [];
  for (const d of config.deployments) {
    if (await hasCode(d.factory)) onChain.push(d);
    else if (d === last) fail(`there is no spDEX vault factory at ${d.factory} on chain ${chainId}`);
    else emit({ type: "warn", code: "deployment-missing", text: `release ${d.id} has no factory on this chain; its vaults are skipped` });
  }
  // Without its registry a release's vaults find nobody eligible: their buys wait out each community window, then
  // open to anyone. Not a reason to stop; a reason to say so.
  for (const d of onChain) {
    if (d.registry !== null && !(await hasCode(d.registry))) {
      emit({ type: "warn", code: "registry-missing", text: `release ${d.id} has no SPX holder registry on this chain: nobody is eligible inside its community windows` });
    }
  }
  const missingBatchers = async () => {
    const missing: string[] = [];
    for (const d of onChain) if (!(await hasCode(d.batcher)) && (has("--deploy-batcher") || (await readVaultCount(rpc, d.factory)) > 0n)) missing.push(d.id);
    return missing;
  };
  let missing = await missingBatchers();
  if (has("--deploy-batcher") && dryRun) fail("--deploy-batcher signs a transaction: set SPDEX_KEEPER_KEY_FILE, and drop --dry-run");
  if (missing.length > 0 && state.pending && !dryRun) {
    // The last run left a transaction in flight — perhaps this very deployment. Nothing else may be signed
    // until it settles, so follow it first, as a tick would: its receipt, a rebroadcast, a replacement.
    const inFlight = await settleInFlight(rpc, { config, state, sendRpc, log: write, persist, waitForReceiptMs: 120_000 });
    if (inFlight) fail("a transaction from the last run is still in flight; it was sent again, and the next start follows it further");
    missing = await missingBatchers();
  }
  if (missing.length > 0) {
    if (!(has("--deploy-batcher") || settings.deployBatcher) || dryRun) {
      fail(`the batcher for release ${missing.join(", ")} is not deployed on this chain; deploy it once: pnpm keeper --deploy-batcher (anyone may)`);
    }
    const { deployed, pending } = await deployMissingBatchers(rpc, { config, state, sendRpc, log: write, persist, waitForReceiptMs: 120_000 });
    if (pending) fail("the batcher's deployment was sent but not mined within 120 s; run the keeper again to follow it");
    for (const d of deployed) console.error(`keeper: deployed ${d.deployment}'s batcher at ${d.batcher}`);
  }
} catch (error) {
  fail(`startup checks failed: ${redact(messageOf(error))}`);
}
if (has("--deploy-batcher")) {
  console.error("keeper: every listed batcher whose factory is on this chain is deployed");
  releaseLease();
  process.exit(0);
}

// ─── The loop ─────────────────────────────────────────────────────────────────

let stopping = false;
let wake: (() => void) | null = null;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Finish the tick in progress; the loop stops after it.
    stopping = true;
    wake?.();
  });
}

let lastTickDone = Date.now();
const watchdog = setInterval(() => {
  if (Date.now() - lastTickDone > settings.watchdogSeconds * 1000) {
    emit({ type: "stop", reason: "watchdog", detail: `no tick completed in ${settings.watchdogSeconds} s` });
    // Exit so the restart policy starts a fresh process; the lease goes with this one.
    releaseLease();
    process.exit(1);
  }
}, 5_000);
watchdog.unref();

let failures = 0;
let lastError: string | null = null;
let lastPing = 0;
for (;;) {
  let result: KeeperTickResult | null = null;
  try {
    result = await keeperTick(rpc, {
      config,
      state,
      sendRpc,
      log: write,
      persist,
      debug: settings.logLevel === "debug",
      waitForReceiptMs: has("--once") ? 120_000 : 0,
    });
    failures = 0;
    lastError = null;
  } catch (error) {
    failures += 1;
    lastError = redact(messageOf(error));
    emit({ type: "error", where: "tick", message: messageOf(error) });
  }
  await persist(state);
  await heartbeat(result);
  if (writesFiles) renewLease();
  lastTickDone = Date.now();
  if (has("--once") || stopping) break;
  // After a failed tick, back off: 12 s, 24 s, 48 s… up to the interval.
  const seconds = result ? result.nextTickSeconds : Math.min(12 * 2 ** (failures - 1), policy.intervalSeconds);
  await new Promise<void>((resolveSleep) => {
    const timer = setTimeout(resolveSleep, seconds * 1000);
    wake = () => {
      clearTimeout(timer);
      resolveSleep();
    };
  });
  wake = null;
  if (stopping) break;
}

if (stopping) emit({ type: "stop", reason: "signal", detail: "stopped by a signal after finishing its tick" });
await persist(state);
releaseLease();
process.exit(has("--once") && failures > 0 ? 1 : 0);

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * The heartbeat file, rewritten every tick (the healthcheck reads its `ts`);
 * a `heartbeat` record every `HEARTBEAT_LOG_SECONDS` (the source of uptime
 * figures); and, when the operator set one, a ping to their dead-man's switch
 * after a healthy tick, at the same pace.
 */
async function heartbeat(result: KeeperTickResult | null): Promise<void> {
  const attention = [...(result?.health.attention ?? [])];
  if (failures >= 3) attention.push("rpc_errors");
  // The tick's own account of itself; after a failed tick only what the state kept is known, and the rest —
  // how many were due, the runway — is unknown rather than zero.
  const pending = state.pending;
  const last = pending?.attempts.at(-1);
  // After a failed tick, the proof's lapse is still known from the last read, though whether it is eligible now is not.
  const lastRead = [...config.deployments]
    .reverse()
    .flatMap((d) => (d.registry !== null && state.eligibility[d.id]?.holder === rewardToOf(config) ? [state.eligibility[d.id]!] : []))[0];
  const health = result?.health ?? {
    ok: false,
    headLagSeconds: null,
    active: Object.keys(state.vaults).length,
    due: null,
    pending: pending && last ? { batchId: pending.batchId, nonce: pending.nonce, hash: last.hash, sentBlock: last.sentBlock } : null,
    lastBatchHash: state.lastBatch?.hash ?? null,
    lastBatchAt: state.lastBatch?.at ?? null,
    balanceWei: state.balanceWei,
    runwayDays: null,
    eligible: null,
    proofValidUntil: lastRead?.validUntil ?? null,
    proofDaysLeft: null,
  };
  const body = {
    phase: result?.phase ?? "running",
    ok: health.ok,
    lastError,
    pending: health.pending,
    active: health.active,
    due: health.due,
    lastBatchHash: health.lastBatchHash,
    balanceWei: health.balanceWei,
    runwayDays: health.runwayDays,
    attention,
    eligible: health.eligible,
    proofValidUntil: health.proofValidUntil,
    proofDaysLeft: health.proofDaysLeft,
  } as const;
  if (writesFiles) {
    writeAtomic(
      heartbeatPath,
      json({
        v: 1,
        ts: new Date().toISOString(),
        keeper,
        ...body,
        block: result?.block ?? null,
        chainTime: result?.chainTime ?? null,
        headLagSeconds: health.headLagSeconds,
        lastBatchAt: health.lastBatchAt,
      }),
    );
  }
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (state.lastHeartbeatLogAt === null || nowSeconds - state.lastHeartbeatLogAt >= BigInt(settings.heartbeatLogSeconds)) {
    state.lastHeartbeatLogAt = nowSeconds;
    emit({ type: "heartbeat", ...body, attention: [...attention] });
  }
  if (health.ok && settings.heartbeatUrl && Date.now() - lastPing >= settings.heartbeatLogSeconds * 1000) {
    lastPing = Date.now();
    try {
      await fetch(settings.heartbeatUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      emit({ type: "error", where: "heartbeat-url", message: messageOf(error) });
    }
  }
}
