/**
 * `pnpm keeper:smoke` — the keeper's Docker image, end to end, against the
 * local fork: build it, let the fork profile's keeper batch two due vaults,
 * and check everything an operator would rely on.
 *
 *  1. The fork answers as chain 690069 (`pnpm anvil:fork`; SPDEX_FORK_URL
 *     points at another one).
 *  2. Fresh keys: a funder, two owners, the keeper and a cold `rewardTo`. Only
 *     these are given ether.
 *  3. v2's SPX holder registry, factory and batcher, through the deterministic
 *     deployer, in that order, if absent.
 *  4. Two daily v2 vaults, $5 and $25 a buy, each with its buy fee, started an
 *     hour ago: due at once, and their first community window (30 minutes)
 *     already over, so the cold `rewardTo`, which never proved any SPX, may be
 *     paid for them like anyone.
 *  5. The image is built; `keeper-fork --once` runs with only these vaults allowed.
 *  6. Both vaults bought once; `rewardTo` holds both fees and the batcher
 *     nothing; the JSONL has `start`, `batch_sent` and `batch_mined` (with the
 *     receipt's own hash and both buys); no key or URL is in any log or output;
 *     the heartbeat is fresh and the healthcheck passes inside the container.
 *  7. `report-fork` over the same blocks lists exactly those two buys and that
 *     batch, each buy this keeper's, made after its community window.
 *  8. The image holds no environment file, key or URL, in its files or its history.
 *  9. A multi-platform build, when the builder has an arm64 platform; otherwise
 *     reported as skipped, never as passed.
 * Finally both vaults are closed, and the key file and the fork profile's data
 * volume are deleted, so a keeper run by hand afterwards starts afresh.
 *
 * It never moves the fork's time, reverts it, touches its base fee or a dev
 * account's balance, or mines a block except by sending its own transactions.
 * It prints no URL and no key. Needs Docker with host networking (rootful, Linux).
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { TOKENS, addressOfKey, httpRpc, prepareTransaction, signPrepared } from "@spdex/chain";
import { resolvedEnv } from "../../../scripts/env.mjs";
import {
  DEFAULT_TURN_BUCKETS,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  MAINNET_REGISTRY,
  VAULT_ABI,
  buyFee,
  defaultCommunityWindow,
  deployReleaseCalls,
  encodeClose,
  encodeCreateVault,
  vaultBudget,
  vaultsCreatedBy,
} from "../src/index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const COMPOSE = ["compose", "-f", join(ROOT, "docker/keeper/compose.yaml"), "--profile", "fork"];
const KEY_FILE = join(ROOT, "docker/keeper/secrets/fork_key");
const REPORT_DIR = join(ROOT, "docker/keeper/report/smoke");
const CHAIN_ID = 690069;

const env = resolvedEnv();
const forkUrl = env.SPDEX_FORK_URL || "http://127.0.0.1:8545";
const rpc = httpRpc(forkUrl);
const ETHER = 10n ** 18n;
const DAY = 86_400n;
/** $5 and $25 a buy at the fee examples' ETH price, $2,643.94 (fee.ts). */
const AMOUNTS = [1_891_117_045_016_150n, 9_455_585_225_080_750n];

const results = [];
const secrets = new Set(Object.entries(env).filter(([name, value]) => name.endsWith("_URL") && value).map(([, value]) => value));
let keeperKey = null;

function check(name, ok, detail = "") {
  results.push({ name, status: ok ? "passed" : "failed", detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function skip(name, reason) {
  results.push({ name, status: "skipped", detail: reason });
  console.log(`skip ${name} — ${reason}`);
}

/**
 * What `text` gives away: the keeper's key (with or without 0x, in either
 * case), any configured URL — whole, as host and path, or its path alone, where
 * API keys live — and, unless `anyUrl` is false, anything shaped like a URL.
 * Names what leaked, never the value.
 */
function leaks(text, { anyUrl = true } = {}) {
  const found = [];
  if (keeperKey && text.toLowerCase().includes(keeperKey.slice(2).toLowerCase())) found.push("the keeper key");
  for (const url of secrets) {
    if (text.includes(url)) found.push("a configured URL");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path.length >= 16 && text.includes(path)) found.push("a configured URL's path");
    if (path && text.includes(`${parsed.host}${path}`)) found.push("a configured URL's host and path");
  }
  if (anyUrl && /\b[a-z][a-z0-9+.-]*:\/\/\S+/i.test(text)) found.push("something shaped like a URL");
  return [...new Set(found)];
}

function docker(args, extraEnv = {}, input) {
  const run = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...extraEnv }, input });
  if (run.error) throw run.error;
  return run;
}

/**
 * The fork profile's data volume, by the name Compose gives it: its project's, which COMPOSE_PROJECT_NAME can
 * change. Without resolving env_file, which the mainnet keeper's .env may not exist for.
 */
function forkVolume(extraEnv) {
  const config = docker([...COMPOSE, "config", "--no-env-resolution", "--format", "json"], extraEnv);
  return config.status === 0 ? (JSON.parse(config.stdout).volumes?.["keeper-fork-data"]?.name ?? null) : null;
}

// ─── The fork ─────────────────────────────────────────────────────────────────

const hex = (v) => `0x${v.toString(16)}`;
/** The time the fork will give its next block: its clock runs on with the wall clock while its head waits. A read. */
const forkNow = async () => BigInt((await rpc("eth_getBlockByNumber", ["pending", false])).timestamp);
const hasCode = async (address) => (await rpc("eth_getCode", [address, "latest"])) !== "0x";

async function receiptOf(hash) {
  for (let i = 0; i < 400; i++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

async function send(key, to, data, value = 0n) {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, prepared);
  await rpc("eth_sendRawTransaction", [raw]);
  const receipt = await receiptOf(hash);
  if (BigInt(receipt.status) !== 1n) throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/** A key nobody has used; only such fresh addresses are ever given a balance. */
async function freshAccount(balance) {
  const key = `0x${randomBytes(32).toString("hex")}`;
  const address = addressOfKey(key);
  if ((await rpc("eth_getCode", [address, "latest"])) !== "0x" || BigInt(await rpc("eth_getTransactionCount", [address, "latest"])) !== 0n) {
    throw new Error("a fresh key was already in use");
  }
  if (balance) await rpc("anvil_setBalance", [address, hex(balance)]);
  return { key, address };
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
async function wethOf(owner) {
  const data = await rpc("eth_call", [{ to: TOKENS.WETH.address, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner] }) }, "latest"]);
  return decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data });
}

async function buysDoneOf(vault) {
  const data = await rpc("eth_call", [{ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "buysDone" }) }, "latest"]);
  return BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data }));
}

// ─── The run ──────────────────────────────────────────────────────────────────

const opened = [];
let exitCode = 1;
let volume = null;
try {
  let chainId;
  try {
    chainId = Number(BigInt(await rpc("eth_chainId", [])));
  } catch {
    chainId = null;
  }
  if (chainId !== CHAIN_ID) throw new Error("no fork answers at SPDEX_FORK_URL (default port 8545): start `pnpm anvil:fork`");
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) throw new Error("Docker is not running, or this user may not use it");
  const fromBlock = BigInt(await rpc("eth_blockNumber", []));

  const funder = await freshAccount(ETHER);
  const owners = [await freshAccount(ETHER), await freshAccount(ETHER)];
  const keeper = await freshAccount(ETHER / 10n);
  const cold = await freshAccount();
  keeperKey = keeper.key;
  // The factory's constructor asks the registry for code; the batcher, bound to no factory, needs nothing first.
  for (const call of deployReleaseCalls("v2")) {
    if (!(await hasCode(call.address))) await send(funder.key, call.to, call.data, call.value);
  }
  check(
    "registry, factory and batcher are deployed on the fork",
    (await hasCode(MAINNET_REGISTRY)) && (await hasCode(MAINNET_FACTORY)) && (await hasCode(MAINNET_BATCHER)),
  );

  const vaults = [];
  // An hour back: due at once, and the first 30-minute community window over, so a rewardTo nobody proved is paid.
  const startAt = (await forkNow()) - 3_600n;
  for (const [i, amountPerBuy] of AMOUNTS.entries()) {
    const plan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: DAY,
      maxBuys: 3n,
      startAt,
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      communityWindow: defaultCommunityWindow(DAY),
      turnBuckets: DEFAULT_TURN_BUCKETS,
    };
    const receipt = await send(owners[i].key, MAINNET_FACTORY, encodeCreateVault(plan), vaultBudget(plan));
    const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
    if (!created) throw new Error("the factory announced no vault");
    opened.push({ vault: created.vault, owner: owners[i] });
    vaults.push({ vault: created.vault, fee: plan.keeperReward });
  }
  console.log(`     vaults ${vaults.map((v) => v.vault).join(", ")}; rewardTo ${cold.address}`);

  // The keeper's key, as an operator would write it: hex and a newline, readable by its owner only.
  rmSync(KEY_FILE, { force: true });
  writeFileSync(KEY_FILE, `${keeper.key.slice(2)}\n`, { mode: 0o400 });
  chmodSync(KEY_FILE, 0o400);
  const composeEnv = {
    SPDEX_FORK_URL: forkUrl,
    SPDEX_FORK_VAULTS: vaults.map((v) => v.vault).join(","),
    SPDEX_FORK_REWARD_TO: cold.address,
    KEEPER_UID: String(process.getuid()),
    KEEPER_GID: String(process.getgid()),
  };

  const build = docker([...COMPOSE, "build", "keeper-fork"], composeEnv);
  if (!check("the image builds", build.status === 0, build.status === 0 ? "" : build.stderr.split("\n").slice(-5).join(" | "))) throw new Error("the build failed");
  const size = docker(["image", "inspect", "spdex-keeper:local", "--format", "{{.Size}}"]).stdout.trim();
  console.log(`     image spdex-keeper:local: ${(Number(size) / 1e6).toFixed(1)} MB of layers, compressed, the Node base included`);

  // A fresh data volume: the state of an earlier run belongs to another key, and the keeper would refuse it.
  volume = forkVolume(composeEnv);
  if (volume === null) throw new Error("docker compose config names no keeper-fork-data volume");
  docker(["volume", "rm", "-f", volume]);
  const run = docker([...COMPOSE, "run", "--rm", "keeper-fork", "--once"], composeEnv);
  check("keeper-fork --once exits 0", run.status === 0, run.status === 0 ? "" : run.stderr.split("\n").slice(-3).join(" | "));

  const bought = await Promise.all(vaults.map((v) => buysDoneOf(v.vault)));
  check("both vaults bought once", bought.every((n) => n === 1n), bought.join(", "));
  const fees = vaults.reduce((sum, v) => sum + v.fee, 0n);
  check("rewardTo holds both buy fees", (await wethOf(cold.address)) === fees, `${fees} wei`);
  check("the batcher holds nothing", (await wethOf(MAINNET_BATCHER)) === 0n);

  const cat = docker([...COMPOSE, "run", "--rm", "--entrypoint", "sh", "keeper-fork", "-c", "cat /data/keeper-*.jsonl"], composeEnv);
  const records = cat.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const types = new Set(records.map((r) => r.type));
  check("the JSONL has start, batch_sent and batch_mined", ["start", "batch_sent", "batch_mined"].every((t) => types.has(t)));
  const mined = records.find((r) => r.type === "batch_mined");
  const receipt = mined ? await rpc("eth_getTransactionReceipt", [mined.hash]) : null;
  check("batch_mined bought both, and names the receipt's own hash in full", mined?.bought?.length === 2 && receipt?.transactionHash?.toLowerCase() === mined.hash, mined?.hash ?? "");

  const heartbeat = docker([...COMPOSE, "run", "--rm", "--entrypoint", "cat", "keeper-fork", "/data/heartbeat.json"], composeEnv);
  const age = heartbeat.status === 0 ? (Date.now() - Date.parse(JSON.parse(heartbeat.stdout).ts)) / 1000 : Infinity;
  check("heartbeat.json is fresh", age < 180, `${Math.round(age)} s old`);
  const health = docker([...COMPOSE, "run", "--rm", "--entrypoint", "node", "keeper-fork", "packages/vault/scripts/keeper-health.mjs"], composeEnv);
  check("the healthcheck passes inside the container", health.status === 0, health.stdout.trim());

  const report = docker(
    [
      ...COMPOSE,
      "run",
      "--rm",
      "report-fork",
      ...["--from-block", String(fromBlock), "--to-block", "latest", "--out", "/report/smoke", "--format", "csv"],
      ...vaults.flatMap((v) => ["--vault", v.vault]),
    ],
    composeEnv,
  );
  check("report-fork exits 0", report.status === 0, report.status === 0 ? "" : report.stderr.split("\n").slice(-3).join(" | "));
  const rows = (file) => {
    const path = join(REPORT_DIR, file);
    if (!existsSync(path)) return [];
    const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
    const columns = header.split(",");
    return lines.map((line) => Object.fromEntries(line.split(",").map((cell, i) => [columns[i], cell])));
  };
  const buys = rows("buys.csv");
  check("buys.csv has exactly one row per vault", vaults.every((v) => buys.filter((b) => b.vault === v.vault).length === 1) && buys.length === 2);
  check(
    "buys.csv says each buy was this keeper's, made after its community window",
    buys.length === 2 && buys.every((b) => b.release === "v2" && b.made_by === "this-keeper" && b.in_community_window === "false"),
  );
  const batches = rows("batches.csv");
  check("batches.csv has exactly our batch", batches.length === 1 && batches[0].tx_hash === mined?.hash && batches[0].earned_matches_rewards === "true");

  const outputs = [run.stdout, run.stderr, cat.stdout, heartbeat.stdout, health.stdout, health.stderr, report.stdout, report.stderr].join("\n");
  const leaked = leaks(outputs);
  check("no key or URL in the JSONL, the heartbeat or any output", leaked.length === 0, leaked.join(", "));

  // The image: no environment file, key or URL in its history or its files.
  const history = docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", "spdex-keeper:local"]).stdout;
  // The base image's own steps name nodejs.org; only this run's secrets count here.
  const inHistory = leaks(history, { anyUrl: false });
  check("docker history names no key or URL", inHistory.length === 0, inHistory.join(", "));
  const listing = docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", "spdex-keeper:local", "-c", "cd /app && find . -path ./node_modules -prune -o -print"]).stdout;
  const badFiles = listing.split("\n").filter((path) => /(^|\/)\.env|(^|\/)secrets(\/|$)|fork_key|keeper_key|rpc_url|send_url|\.keeper(\/|$)|keeper-report(\/|$)/.test(path));
  check("the image's files include no .env file, secret, state or report", badFiles.length === 0, badFiles.join(", "));
  const app = docker(["run", "--rm", "--network", "none", "--entrypoint", "tar", "spdex-keeper:local", "-C", "/app", "-cf", "-", "."], {}, undefined);
  const inFiles = [...secrets].filter((url) => app.stdout.includes(url)).length;
  check("no configured URL appears in the image's files", inFiles === 0, `${secrets.size} URL(s) checked`);

  const builders = docker(["buildx", "ls"]).stdout;
  if (/linux\/arm64/.test(builders)) {
    const multi = docker(["buildx", "build", "--platform", "linux/amd64,linux/arm64", "-f", "docker/keeper/Dockerfile", "."]);
    check("the image builds for amd64 and arm64", multi.status === 0);
  } else {
    skip("the image builds for amd64 and arm64", "this machine's buildx builder lists no linux/arm64 platform");
  }
  exitCode = results.some((r) => r.status === "failed") ? 1 : 0;
} catch (error) {
  console.error(`keeper-smoke: ${leaks(String(error?.message ?? error)).length > 0 ? "an error that named a secret (not shown)" : (error?.message ?? error)}`);
  exitCode = 1;
} finally {
  for (const { vault, owner } of opened) {
    try {
      await send(owner.key, vault, encodeClose());
    } catch (error) {
      console.error(`keeper-smoke: could not close ${vault}: ${error?.message ?? error}`);
      exitCode = 1;
    }
  }
  rmSync(KEY_FILE, { force: true });
  // Its state belongs to the key just deleted: a keeper run by hand with another key would refuse it.
  if (volume !== null) docker(["volume", "rm", "-f", volume]);
}
const failed = results.filter((r) => r.status === "failed").length;
const skipped = results.filter((r) => r.status === "skipped").length;
console.log(`keeper-smoke: ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped${opened.length ? `; closed ${opened.length} vault(s)` : ""}`);
process.exit(exitCode);
