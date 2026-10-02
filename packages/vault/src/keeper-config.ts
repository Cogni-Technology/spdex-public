/**
 * A keeper's configuration: `keeperConfig` for code, `keeperEnvFrom` for
 * the environment an operator sets.
 *
 * Every error names the variable that is wrong and never repeats its value:
 * the values include the endpoint URLs, whose paths carry API keys, and the
 * key itself. Reading a `_FILE` is the caller's (`readFile`), so this file
 * stays free of Node APIs and testable with a plain object.
 */

import type { Address, Hex } from "@spdex/core";
import { addressOfKey } from "@spdex/chain";
import { BATCHER_LIMITS, DEPLOYMENTS, MAINNET_DEPLOYMENT, type Deployment } from "./artifacts.js";
import { DEFAULT_KEEPER_POLICY, MAX_BATCH_GAS_CEILING, type KeeperPolicy } from "./keeper-plan.js";

export interface KeeperConfig {
  chainId: number;
  /** Every release whose vaults this keeper serves; each batch goes to its own factory's batcher. */
  deployments: readonly Deployment[];
  weth: Address;
  /** Absent: a dry run, which decides and logs and never signs. */
  keeperKey?: Hex;
  /** Where batch rewards go; null for the keeper's own address. */
  rewardTo: Address | null;
  /** An allowlist; null for every vault in every release's list. */
  vaults: readonly Address[] | null;
  /** The send endpoint is private and revert-protected. */
  privateSend: boolean;
  policy: KeeperPolicy;
}

export class KeeperConfigError extends Error {
  constructor(
    /** The variable or field at fault. */
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = "KeeperConfigError";
  }
}

/**
 * A keeper's configuration with every default filled in and checked: the
 * registry's releases, mainnet's WETH, no allowlist, a public send, the default
 * policy with `policy`'s overrides.
 */
export function keeperConfig(input: {
  chainId: number;
  deployments?: readonly Deployment[];
  weth?: Address;
  keeperKey?: Hex;
  rewardTo?: Address;
  vaults?: readonly Address[];
  privateSend?: boolean;
  policy?: Partial<KeeperPolicy>;
}): KeeperConfig {
  const policy: KeeperPolicy = { ...DEFAULT_KEEPER_POLICY, ...input.policy };
  checkPolicy(policy, (field) => field);
  return {
    chainId: input.chainId,
    deployments: input.deployments ?? DEPLOYMENTS,
    weth: lower(input.weth ?? MAINNET_DEPLOYMENT.weth),
    ...(input.keeperKey ? { keeperKey: input.keeperKey } : {}),
    rewardTo: input.rewardTo ? lower(input.rewardTo) : null,
    vaults: input.vaults ? input.vaults.map(lower) : null,
    privateSend: input.privateSend ?? false,
    policy,
  };
}

/** The keeper's own address, or null for a dry run. */
export function keeperAddress(config: KeeperConfig): Address | null {
  return config.keeperKey ? addressOfKey(config.keeperKey) : null;
}

/** Where rewards go: the configured `rewardTo`, else the keeper itself. */
export function rewardToOf(config: KeeperConfig): Address | null {
  return config.rewardTo ?? keeperAddress(config);
}

function checkPolicy(policy: KeeperPolicy, name: (field: keyof KeeperPolicy) => string): void {
  const fail = (field: keyof KeeperPolicy, rule: string): never => {
    throw new KeeperConfigError(name(field), `${name(field)} ${rule}`);
  };
  if (policy.maxBatchGas > MAX_BATCH_GAS_CEILING) fail("maxBatchGas", `must be at most ${MAX_BATCH_GAS_CEILING}`);
  if (policy.maxBatchGas < 1_000_000n) fail("maxBatchGas", "must be at least 1000000");
  if (policy.maxVaultsPerBatch < 1 || policy.maxVaultsPerBatch > Number(BATCHER_LIMITS.MAX_VAULTS)) {
    fail("maxVaultsPerBatch", `must be between 1 and ${BATCHER_LIMITS.MAX_VAULTS}`);
  }
  if (policy.cheapPercentileStart < 0 || policy.cheapPercentileEnd > 100 || policy.cheapPercentileStart > policy.cheapPercentileEnd) {
    fail("cheapPercentileStart", "and its end must be percentiles, start at or below end");
  }
  if (policy.deadlineMinSeconds > policy.deadlineMaxSeconds) fail("deadlineMinSeconds", "must be at most the maximum");
  if (policy.urgentTip > policy.maxTip) fail("urgentTip", "must be at most the maximum tip");
  if (policy.confirmations < 1) fail("confirmations", "must be at least 1");
  if (policy.intervalSeconds < 12) fail("intervalSeconds", "must be at least 12");
}

// ─── From the environment ─────────────────────────────────────────────────────

/** Everything `pnpm keeper` reads from its environment. */
export interface KeeperEnv {
  /** Required to run, but not to print the address; the caller checks. */
  rpcUrl: string | null;
  sendUrl: string | null;
  sendPrivate: boolean;
  keeperKey: Hex | null;
  /** The key file, for the permissions warning; null when the key came from a variable or not at all. */
  keyFile: string | null;
  rewardTo: Address | null;
  vaults: Address[] | null;
  dataDir: string | null;
  /** "-" for stdout only; null for daily files in the data directory. */
  logFile: string | null;
  logLevel: "info" | "debug";
  heartbeatFile: string | null;
  heartbeatLogSeconds: number;
  heartbeatUrl: string | null;
  /** Exit when no tick completes for this long: five intervals, at least 300. */
  watchdogSeconds: number;
  deployBatcher: boolean;
  gitSha: string | null;
  policy: KeeperPolicy;
  /** Every URL and key the environment holds, for the log's redactor: never logged, only removed. */
  secrets: { key: Hex | null; urls: string[] };
  /** `SPDEX_KEEPER_*` names set but read by nothing here: a mistyped name would otherwise be ignored in silence. */
  unknown: string[];
}

type Env = Readonly<Record<string, string | undefined>>;
type ReadFile = (path: string) => string;

const P = "SPDEX_KEEPER_";

/** A variable's value, trimmed; an empty one counts as unset. */
const envValue = (env: Env, name: string): string | null => {
  const v = env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
};

/**
 * A secret from a variable or from the file its `_FILE` form names, never
 * both. A file's contents are trimmed, since `openssl` and `echo` end them
 * with a newline, and an empty value counts as unset. Reading the file is
 * `readFile`'s, so this stays free of Node APIs. Errors name the variable,
 * never its value.
 */
export function secretFromEnv(env: Env, name: string, readFile?: ReadFile, fileName = `${name}_FILE`): { value: string | null; file: string | null } {
  const direct = envValue(env, name);
  const file = envValue(env, fileName);
  if (direct !== null && file !== null) throw new KeeperConfigError(name, `set ${name} or ${fileName}, not both`);
  if (file === null) return { value: direct, file: null };
  if (!readFile) throw new KeeperConfigError(fileName, `${fileName} cannot be read here`);
  let contents: string;
  try {
    contents = readFile(file);
  } catch {
    throw new KeeperConfigError(fileName, `the file ${fileName} names could not be read`);
  }
  const trimmed = contents.trim();
  return { value: trimmed === "" ? null : trimmed, file };
}

/** An http or https URL from a variable or its `_FILE` form (`secretFromEnv`); null when neither is set. */
export function urlFromEnv(env: Env, name: string, readFile?: ReadFile): string | null {
  const { value } = secretFromEnv(env, name, readFile);
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new KeeperConfigError(name, `${name} is not a URL`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new KeeperConfigError(name, `${name} must be an http or https URL`);
  return value;
}

/**
 * Everything the keeper reads from its environment — endpoints, key, files,
 * and the policy's overrides — parsed. An empty value counts as unset; a value
 * and its `_FILE` form both set is an error; a file's contents are trimmed,
 * since `openssl` and `echo` end them with a newline. Errors name the
 * variable, never its value.
 */
export function keeperEnvFrom(env: Env, options: { readFile?: ReadFile } = {}): KeeperEnv {
  // Every name looked at, so that one set and never looked at can be warned about.
  const read = new Set<string>();
  const value = (name: string): string | null => {
    read.add(name);
    return envValue(env, name);
  };
  const secret = (name: string, fileName = `${name}_FILE`) => {
    read.add(name).add(fileName);
    return secretFromEnv(env, name, options.readFile, fileName);
  };
  const fail = (name: string, rule: string): never => {
    throw new KeeperConfigError(name, `${name} ${rule}`);
  };
  const url = (name: string): string | null => {
    read.add(name).add(`${name}_FILE`);
    return urlFromEnv(env, name, options.readFile);
  };
  const decimal = (name: string, fallback: bigint, scale: bigint): bigint => {
    const v = value(name);
    if (v === null) return fallback;
    if (!/^\d+(\.\d+)?$/.test(v)) return fail(name, "must be a non-negative decimal number");
    return parseUnits(v, scale, () => fail(name, "has more decimals than it can hold"));
  };
  const whole = (name: string, fallback: bigint): bigint => {
    const v = value(name);
    if (v === null) return fallback;
    if (!/^\d+$/.test(v)) return fail(name, "must be a whole number");
    return BigInt(v);
  };
  const num = (name: string, fallback: number): number => Number(whole(name, BigInt(fallback)));
  const flag = (name: string, fallback: boolean): boolean => {
    const v = value(name);
    if (v === null) return fallback;
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    return fail(name, "must be 1 or 0");
  };
  const oneOf = <T extends string>(name: string, options: readonly T[], fallback: T): T => {
    const v = value(name) ?? fallback;
    return (options as readonly string[]).includes(v) ? (v as T) : fail(name, `must be ${options.join(", ")}`);
  };
  const address = (name: string): Address | null => {
    const v = value(name);
    if (v === null) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return fail(name, "must be an address");
    return lower(v);
  };

  const rpcUrl = url(`${P}RPC_URL`);
  const sendUrl = url(`${P}SEND_URL`);
  const heartbeatUrl = url(`${P}HEARTBEAT_URL`);

  const key = secret(`${P}KEY`, `${P}KEY_FILE`);
  let keeperKey: Hex | null = null;
  if (key.value !== null) {
    const hex = key.value.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) fail(key.file ? `${P}KEY_FILE` : `${P}KEY`, "must hold a 32-byte hex private key");
    keeperKey = `0x${hex.toLowerCase()}` as Hex;
    try {
      addressOfKey(keeperKey);
    } catch {
      fail(key.file ? `${P}KEY_FILE` : `${P}KEY`, "is not a usable private key");
    }
  }

  const vaultsRaw = value(`${P}VAULTS`);
  let vaults: Address[] | null = null;
  if (vaultsRaw !== null) {
    vaults = vaultsRaw.split(",").map((v) => v.trim()).filter(Boolean).map((v) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) fail(`${P}VAULTS`, "must be comma-separated addresses");
      return lower(v);
    });
  }

  const d = DEFAULT_KEEPER_POLICY;
  const sendWhen = oneOf(`${P}SEND_WHEN`, ["cheap", "deadline", "now"] as const, d.sendWhen);
  const logLevel = oneOf(`${P}LOG_LEVEL`, ["info", "debug"] as const, "info");
  const deadlineShare = decimal(`${P}DEADLINE_SHARE`, d.deadlineShareBps, 4n);
  if (deadlineShare > 10_000n) fail(`${P}DEADLINE_SHARE`, "must be at most 1");

  // Only what an operator's recipe in docs/KEEPER.md needs is a variable; every other field keeps its
  // default, as `trapSeconds` always has. A variable no longer read is named as unknown at start.
  const policy: KeeperPolicy = {
    ...d,
    sendWhen,
    deadlineShareBps: deadlineShare,
    deadlineMinSeconds: whole(`${P}DEADLINE_MIN_SECONDS`, d.deadlineMinSeconds),
    deadlineMaxSeconds: whole(`${P}DEADLINE_MAX_SECONDS`, d.deadlineMaxSeconds),
    tip: decimal(`${P}TIP_GWEI`, d.tip, 9n),
    maxFeePerGas: decimal(`${P}MAX_FEE_GWEI`, d.maxFeePerGas, 9n),
    maxLossPerBuy: decimal(`${P}MAX_LOSS_PER_BUY_ETH`, d.maxLossPerBuy, 18n),
    maxLossPerDay: decimal(`${P}MAX_LOSS_PER_DAY_ETH`, d.maxLossPerDay, 18n),
    maxLossPerVaultPerDay: decimal(`${P}MAX_LOSS_PER_VAULT_PER_DAY_ETH`, d.maxLossPerVaultPerDay, 18n),
    maxSubsidyPerOwnerPerDay: decimal(`${P}MAX_SUBSIDY_PER_OWNER_DAY_ETH`, d.maxSubsidyPerOwnerPerDay, 18n),
    subsidyMinBuy: decimal(`${P}SUBSIDY_MIN_BUY_ETH`, d.subsidyMinBuy, 18n),
    subsidyMinInterval: whole(`${P}SUBSIDY_MIN_INTERVAL_SECONDS`, d.subsidyMinInterval),
    confirmations: num(`${P}CONFIRMATIONS`, d.confirmations),
    maxHeadLagSeconds: whole(`${P}MAX_HEAD_LAG_SECONDS`, d.maxHeadLagSeconds),
    minEth: decimal(`${P}MIN_ETH`, d.minEth, 18n),
    intervalSeconds: num(`${P}INTERVAL_SECONDS`, d.intervalSeconds),
  };
  checkPolicy(policy, (field) => ENV_NAMES[field] ?? field);

  // Private sending changes what a send may cost (no pair cap, a minimum the batch must earn), so it must go
  // somewhere private: without a send URL every transaction would go to the public endpoint.
  const sendPrivate = flag(`${P}SEND_PRIVATE`, sendUrl !== null);
  if (sendPrivate && sendUrl === null) fail(`${P}SEND_PRIVATE`, `is 1, but there is no ${P}SEND_URL to send privately through`);

  // Every URL in the resolved environment is a secret to the log, the fork's included.
  const urls = new Set<string>();
  for (const [name, v] of Object.entries(env)) if (name.endsWith("_URL") && v?.trim()) urls.add(v.trim());
  for (const v of [rpcUrl, sendUrl, heartbeatUrl]) if (v) urls.add(v);

  const parsed = {
    rpcUrl,
    sendUrl,
    sendPrivate,
    keeperKey,
    keyFile: key.file,
    rewardTo: address(`${P}REWARD_TO`),
    vaults,
    dataDir: value(`${P}DATA_DIR`),
    logFile: value(`${P}LOG_FILE`),
    logLevel,
    heartbeatFile: value(`${P}HEARTBEAT_FILE`),
    heartbeatLogSeconds: num(`${P}HEARTBEAT_LOG_SECONDS`, 300),
    heartbeatUrl,
    watchdogSeconds: Math.max(5 * policy.intervalSeconds, 300),
    deployBatcher: flag(`${P}DEPLOY_BATCHER`, false),
    gitSha: value(`${P}GIT_SHA`),
    policy,
    secrets: { key: keeperKey, urls: [...urls] },
  };
  const unknown = Object.keys(env)
    .filter((name) => name.startsWith(P) && !read.has(name) && envValue(env, name) !== null)
    .sort();
  return { ...parsed, unknown };
}

/** The variable each policy field `checkPolicy` checks is read from, for errors about the policy as a whole. */
const ENV_NAMES: Partial<Record<keyof KeeperPolicy, string>> = {
  deadlineMinSeconds: `${P}DEADLINE_MIN_SECONDS`,
  confirmations: `${P}CONFIRMATIONS`,
  intervalSeconds: `${P}INTERVAL_SECONDS`,
};

/** A decimal string as an integer of `decimals` places ("0.02", 9 → 20,000,000). */
function parseUnits(v: string, decimals: bigint, tooPrecise: () => never): bigint {
  const [whole, fraction = ""] = v.split(".");
  const places = Number(decimals);
  if (fraction.replace(/0+$/, "").length > places) tooPrecise();
  return BigInt(whole!) * 10n ** decimals + BigInt(fraction.padEnd(places, "0").slice(0, places) || "0");
}

const lower = (a: string): Address => a.toLowerCase() as Address;
