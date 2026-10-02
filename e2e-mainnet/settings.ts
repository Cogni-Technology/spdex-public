/**
 * The mainnet smoke suite's settings, read once from the environment and the
 * repo's .env files (docs/MAINNET-SMOKE.md lists them).
 *
 * Every limit has a default, and a mainnet run is refused unless
 * `SPDEX_SMOKE_MAINNET=yes` says it may spend real ether: a missing variable
 * must never be the reason money moves.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { resolvedEnv } from "../scripts/env.mjs";

export const GWEI = 10n ** 9n;
export const ETHER = 10n ** 18n;

export interface SmokeSettings {
  /** The endpoint the page and the harness both use: a fork of Ethereum, or Ethereum itself. */
  rpcUrl: string;
  /** Where the app is served: the published IPFS address, or a local build of the same source. */
  baseUrl: string;
  /** Keystores, their password file and the spending ledger. Never inside the repo. */
  home: string;
  /** A private relay for Help run the network on mainnet (a fork always uses itself). Null skips that spec there. */
  relayUrl: string | null;
  /** `SPDEX_SMOKE_MAINNET=yes`: a run against a real network may spend real ether. */
  mainnetAllowed: boolean;
  /** The most ether one run may send out of the agent wallets, network fees included. */
  maxRunWei: bigint;
  /** The same over any 24 hours, from the ledger. Mainnet only: a fork's ether is not real. */
  maxDayWei: bigint;
  /** No transaction is signed while the base fee is above this. */
  maxBaseFeeWei: bigint;
  /** The priority fee every transaction the harness prices itself bids at least. */
  tipWei: bigint;
  /** The one-time swap's size, in ETH. */
  swapWei: bigint;
  /** Each vault buy's size, in ETH. */
  buyWei: bigint;
  /** Help run the network is skipped when a buy whose fee covers a batch would need more than this. */
  helpRunMaxBuyWei: bigint;
  /** What the keeper spec may lose on its one buy, as a keeper's subsidy. */
  keeperSubsidyWei: bigint;
}

function decimal(name: string, value: string | undefined, fallback: string, decimals: bigint): bigint {
  const text = (value ?? fallback).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`${name} must be a plain decimal number, not ${JSON.stringify(text)}`);
  const fraction = match[2] ?? "";
  if (BigInt(fraction.length) > decimals) throw new Error(`${name} has more than ${decimals} decimals`);
  return BigInt(match[1]!) * 10n ** decimals + BigInt(fraction.padEnd(Number(decimals), "0") || "0");
}

function httpUrl(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set (docs/MAINNET-SMOKE.md)`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http(s) URL`);
  return value;
}

/** `SPDEX_SMOKE_HOME`, or ~/.config/spdex-agents: all the wallet commands need. */
export function smokeHome(env: Record<string, string | undefined> = resolvedEnv()): string {
  return env["SPDEX_SMOKE_HOME"] ?? join(homedir(), ".config", "spdex-agents");
}

export function smokeSettings(env: Record<string, string | undefined> = resolvedEnv()): SmokeSettings {
  const e = (name: string) => env[`SPDEX_SMOKE_${name}`];
  return {
    rpcUrl: httpUrl("SPDEX_SMOKE_RPC_URL", e("RPC_URL")),
    baseUrl: httpUrl("SPDEX_SMOKE_BASE_URL", e("BASE_URL")),
    home: smokeHome(env),
    relayUrl: e("RELAY_URL") ? httpUrl("SPDEX_SMOKE_RELAY_URL", e("RELAY_URL")) : null,
    mainnetAllowed: e("MAINNET") === "yes",
    maxRunWei: decimal("SPDEX_SMOKE_MAX_RUN_ETH", e("MAX_RUN_ETH"), "0.03", 18n),
    maxDayWei: decimal("SPDEX_SMOKE_MAX_DAY_ETH", e("MAX_DAY_ETH"), "0.1", 18n),
    maxBaseFeeWei: decimal("SPDEX_SMOKE_MAX_BASE_FEE_GWEI", e("MAX_BASE_FEE_GWEI"), "2", 9n),
    tipWei: decimal("SPDEX_SMOKE_TIP_GWEI", e("TIP_GWEI"), "0.05", 9n),
    swapWei: decimal("SPDEX_SMOKE_SWAP_ETH", e("SWAP_ETH"), "0.001", 18n),
    buyWei: decimal("SPDEX_SMOKE_BUY_ETH", e("BUY_ETH"), "0.001", 18n),
    helpRunMaxBuyWei: decimal("SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH", e("HELP_RUN_MAX_BUY_ETH"), "0.02", 18n),
    keeperSubsidyWei: decimal("SPDEX_SMOKE_KEEPER_SUBSIDY_ETH", e("KEEPER_SUBSIDY_ETH"), "0.001", 18n),
  };
}

/** The most any transaction may bid per gas: twice the highest base fee allowed, and the tip. */
export function feeRateCap(settings: SmokeSettings): bigint {
  return 2n * settings.maxBaseFeeWei + settings.tipWei;
}

/** Wei as ETH, every digit kept, trailing zeros dropped. */
export function eth(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const fraction = (abs % ETHER).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / ETHER}${fraction ? `.${fraction}` : ""}`;
}

export function gwei(wei: bigint): string {
  const fraction = (wei % GWEI).toString().padStart(9, "0").slice(0, 3).replace(/0+$/, "");
  return `${wei / GWEI}${fraction ? `.${fraction}` : ""}`;
}

/** What a run hands from the global setup to the specs, through the environment. */
export interface SmokeRun {
  id: string;
  /** "fork": anvil, fresh keys, nothing real. "mainnet": the agent wallets, real ether. */
  mode: "fork" | "mainnet";
  /** The relay Help run the network posts to, or null when there is none to use. */
  relayUrl: string | null;
  /** How many vaults the factory had listed when the run started: this run's are listed after them. */
  startVaultCount: string;
  /** The agents' addresses, and on a fork their throwaway keys (a mainnet run decrypts its keystores in each worker). */
  agents: Record<AgentName, { address: `0x${string}`; key?: `0x${string}` }>;
  /** Each agent's ether when the run started, for the summary. */
  startBalances: Record<AgentName, string>;
}

export const AGENT_NAMES = ["owner", "helper", "keeper"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const RUN_ENV = "SPDEX_SMOKE_RUN_JSON";

export function currentRun(): SmokeRun {
  const raw = process.env[RUN_ENV];
  if (!raw) throw new Error(`${RUN_ENV} is not set: run the suite with pnpm mainnet:smoke, whose global setup sets it`);
  return JSON.parse(raw) as SmokeRun;
}

/** The repo-local directory for run records (gitignored). */
export const RUNS_DIR = new URL("../.mainnet-smoke/runs/", import.meta.url).pathname;
