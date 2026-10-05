/**
 * `pnpm keeper:report` — what spDEX's vault plans, buys, batches and keepers
 * did over a range of blocks, from public chain data and the operator's own
 * keeper logs. `docs/KEEPER.md` ("The report") lists the tables and the
 * questions each answers; `src/report.ts` does the aggregation, and this file
 * gathers its inputs.
 *
 *   pnpm keeper:report [--from-block N] [--to-block N|latest|finalized]
 *                      [--keeper-log GLOB]... [--keeper-state PATH]
 *                      [--reward-to 0x..]... [--vault 0x..]... [--tip-recipient 0x..]...
 *                      [--out DIR] [--format csv|json|both] [--eth-usd PRICE] [--cache]
 *
 * Environment: SPDEX_REPORT_RPC_URL (or _FILE), else SPDEX_KEEPER_RPC_URL (or
 * _FILE); SPDEX_REPORT_MAX_RPS, requests a second (default 5). A later flag
 * overrides an earlier one of the same name, except those that repeat.
 *
 * It contacts nothing but that endpoint, and never prints its URL. It is
 * careful with it too: a token bucket holds it to the rate asked for, a
 * refused log range is halved and widened again later, a rate limit is waited
 * out (never mistaken for a refusal), and with `--cache` finalized ranges are
 * kept on disk, so a second run asks for almost nothing. It is safe to run
 * again: the last block defaults to `finalized`, logs are deduplicated, every
 * output is written whole or not at all, and the same range gives the same
 * files.
 */

import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeFunctionResult, encodeEventTopics, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, Multicall3Reader, TOKENS, TOPICS, type JsonRpc } from "@spdex/chain";
import { resolvedEnv } from "../../../scripts/env.mjs";
import {
  BATCHERS,
  DEPLOYMENTS,
  SOURCES,
  VAULT_ABI,
  VAULT_LOGS_FROM_BLOCK,
  decodeBatcherEvent,
  decodeOr,
  decodeTerms,
  deploymentBlock,
  readVaultCount,
  readVaultsPage,
  vaultsCreatedBy,
  type Deployment,
} from "../src/index.js";
import { makeRedactor, parseKeeperState, urlFromEnv } from "../src/keeper.js";
import {
  LOG_WINDOW_START,
  REPORT_COLUMNS,
  alignedChunks,
  buildReport,
  dedupeKeeperRecords,
  nextLogWindow,
  parseKeeperLog,
  toCsv,
  toJson,
  type ChainBlock,
  type ChainLog,
  type ChainReceipt,
  type KeeperRecord,
  type LogWindow,
  type PricePoint,
  type Prices,
  type ReportTable,
  type VaultAtEnd,
} from "../src/report.js";
import { RpcError, fetchRpc, messageOf, packageVersion, writeAtomic } from "./io.js";

// ─── Arguments and environment ────────────────────────────────────────────────

const REPEATED = ["--keeper-log", "--reward-to", "--vault", "--tip-recipient"];
const SINGLE = ["--from-block", "--to-block", "--keeper-state", "--out", "--format", "--eth-usd"];
const argv = process.argv.slice(2);
const args = new Map<string, string[]>();
let useCache = false;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i]!;
  if (flag === "--cache") {
    useCache = true;
    continue;
  }
  if (![...REPEATED, ...SINGLE].includes(flag)) fail(`unknown argument ${JSON.stringify(flag.slice(0, 40))}`);
  const value = argv[++i];
  if (value === undefined) fail(`${flag} needs a value`);
  args.set(flag, REPEATED.includes(flag) ? [...(args.get(flag) ?? []), value] : [value]);
}
const one = (flag: string): string | undefined => args.get(flag)?.[0];
const many = (flag: string): string[] => args.get(flag) ?? [];
const addresses = (flag: string): Address[] =>
  many(flag).map((a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? (a.toLowerCase() as Address) : fail(`${flag} takes an address`)));

const env = resolvedEnv() as Record<string, string | undefined>;
const rpcUrl = secretUrl("SPDEX_REPORT_RPC_URL") ?? secretUrl("SPDEX_KEEPER_RPC_URL") ?? fail("set SPDEX_REPORT_RPC_URL (or SPDEX_KEEPER_RPC_URL) to the endpoint to read from");
const redact = makeRedactor({ urls: [rpcUrl, ...Object.entries(env).filter(([k, v]) => k.endsWith("_URL") && v).map(([, v]) => v!)] });
const maxRps = Number(env["SPDEX_REPORT_MAX_RPS"] || 5);
if (!Number.isFinite(maxRps) || maxRps <= 0) fail("SPDEX_REPORT_MAX_RPS must be a positive number");
const format = one("--format") ?? "both";
if (!["csv", "json", "both"].includes(format)) fail("--format is csv, json or both");
const outDir = resolve(one("--out") ?? "keeper-report");
/** Every file is written whole or not at all (`writeAtomic`), with the mode any file gets: the umask decides who reads it. */
const SHARED = 0o666;

function fail(message: string): never {
  console.error(`keeper-report: ${message}`);
  process.exit(1);
}

/** A URL from a variable or its `_FILE` form, read as the keeper reads its own; the error names the variable, never the value. */
function secretUrl(name: string): string | null {
  try {
    return urlFromEnv(env, name, (path) => readFileSync(path, "utf8"));
  } catch (error) {
    return fail(messageOf(error));
  }
}

const note = (message: string) => console.error(`keeper-report: ${redact(message)}`);

// An error nobody planned for still names no secret: a transport error can quote the endpoint.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => fail(redact(messageOf(error))));
}

// ─── The endpoint, politely ───────────────────────────────────────────────────

let tokens = maxRps;
let refilledAt = Date.now();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A token bucket: at most `maxRps` requests a second, in bursts of up to that many. */
async function takeToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(maxRps, tokens + ((now - refilledAt) / 1000) * maxRps);
    refilledAt = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(((1 - tokens) / maxRps) * 1000);
  }
}

const endpoint = fetchRpc(rpcUrl, 30_000);

/**
 * One request, at most `maxRps` a second, waiting out rate limits and brief
 * outages: exponential backoff with jitter, up to about two minutes in all.
 * Any other error is the endpoint's answer, and the caller decides what it
 * means.
 */
const rpc: JsonRpc = async (method, params) => {
  for (let attempt = 0; ; attempt++) {
    await takeToken();
    try {
      return await endpoint(method, params);
    } catch (error) {
      const transient = error instanceof RpcError ? error.rateLimited : error instanceof TypeError || (error as Error).name === "TimeoutError";
      if (!transient || attempt >= 8) throw error;
      await sleep(Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }
};

/** The same endpoint, with every `eth_call` made at `block` instead of the latest one. */
const atBlock = (block: bigint): JsonRpc => (method, params) =>
  rpc(method, method === "eth_call" && params[1] === "latest" ? [params[0], hex(block)] : params);

const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

// ─── The cache ────────────────────────────────────────────────────────────────

const cacheDir = join(outDir, "cache");
let finalized: bigint | null = null;

/** A value kept on disk when it can never change: everything at or below the finalized block. */
async function cached<T>(key: unknown, finalAt: bigint | null, compute: () => Promise<T>): Promise<T> {
  const cacheable = useCache && finalized !== null && finalAt !== null && finalAt <= finalized;
  const file = join(cacheDir, `${createHash("sha256").update(JSON.stringify(key)).digest("hex")}.json`);
  if (cacheable && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"), revive) as T;
  const value = await compute();
  if (cacheable) {
    mkdirSync(cacheDir, { recursive: true });
    writeAtomic(file, toJson(value), SHARED);
  }
  return value;
}

/** Bigints were written as decimal strings; a string of digits under a numeric key comes back a bigint. */
function revive(key: string, value: unknown): unknown {
  return typeof value === "string" && /^-?\d+$/.test(value) && BIGINT_KEYS.has(key) ? BigInt(value) : value;
}
const BIGINT_KEYS = new Set(["blockNumber", "number", "timestamp", "baseFee", "gasUsed", "effectiveGasPrice", "at", "answer"]);

// ─── Blocks, logs and receipts ────────────────────────────────────────────────

interface RpcBlock {
  number: string;
  hash: Hex;
  timestamp: string;
  baseFeePerGas?: string | null;
}

async function header(tag: bigint | "latest" | "finalized"): Promise<RpcBlock> {
  const block = (await rpc("eth_getBlockByNumber", [typeof tag === "bigint" ? hex(tag) : tag, false])) as RpcBlock | null;
  if (!block) throw new Error(`the endpoint has no block ${tag}`);
  return block;
}

const blocks = new Map<bigint, ChainBlock>();
async function blockOf(number: bigint): Promise<ChainBlock> {
  const known = blocks.get(number);
  if (known) return known;
  const block = await cached(["block", number.toString()], number, async (): Promise<ChainBlock> => {
    const b = await header(number);
    return { number, timestamp: BigInt(b.timestamp), baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null };
  });
  blocks.set(number, block);
  return block;
}

interface RpcLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  transactionHash: Hex;
  logIndex: string;
  removed?: boolean;
}

const toChainLog = (log: RpcLog): ChainLog => ({
  address: log.address.toLowerCase() as Address,
  topics: log.topics,
  data: log.data,
  blockNumber: BigInt(log.blockNumber),
  transactionHash: log.transactionHash.toLowerCase() as Hex,
  logIndex: Number(BigInt(log.logIndex)),
});

const uncovered: { fromBlock: bigint; toBlock: bigint; what: string }[] = [];
let window: LogWindow = { blocks: LOG_WINDOW_START, successes: 0 };
const CACHE_CHUNK = 10_000n;

/**
 * Every log matching `filter` in `[from, to]`, in chunks aligned to 10,000
 * blocks (so a cached chunk is found again whatever range a later run asks
 * for), each read in windows that narrow when the endpoint refuses one. A
 * block the endpoint will not serve at all is listed as uncovered.
 */
async function logsOf(what: string, filter: { address?: Address[]; topics?: (Hex | Hex[] | null)[] }, from: bigint, to: bigint): Promise<ChainLog[]> {
  const out: ChainLog[] = [];
  for (const [start, end] of alignedChunks(from, to, CACHE_CHUNK)) {
    const endHash = useCache && finalized !== null && end <= finalized ? (await header(end)).hash : null;
    const key = ["logs", filter.address?.slice().sort() ?? null, filter.topics ?? null, start.toString(), end.toString(), endHash];
    const logs = await cached(key, endHash === null ? null : end, () => logsInWindows(what, filter, start, end));
    out.push(...logs);
  }
  return out;
}

async function logsInWindows(what: string, filter: { address?: Address[]; topics?: (Hex | Hex[] | null)[] }, from: bigint, to: bigint): Promise<ChainLog[]> {
  const out: ChainLog[] = [];
  let cursor = from;
  let refusedAtOne = 0;
  while (cursor <= to) {
    const end = cursor + window.blocks - 1n < to ? cursor + window.blocks - 1n : to;
    try {
      const logs = (await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(cursor), toBlock: hex(end) }])) as RpcLog[];
      // A log a reorg removed is not history.
      out.push(...logs.filter((log) => !log.removed).map(toChainLog));
      window = nextLogWindow(window, "answered");
      cursor = end + 1n;
      refusedAtOne = 0;
    } catch (error) {
      if (window.blocks > 1n) {
        window = nextLogWindow(window, "refused");
        continue;
      }
      if (++refusedAtOne < 3) continue;
      note(`${what}: the endpoint would not serve block ${cursor} (${messageOf(error)}); it is listed as uncovered`);
      uncovered.push({ fromBlock: cursor, toBlock: cursor, what });
      cursor += 1n;
      refusedAtOne = 0;
    }
  }
  return out;
}

interface RpcReceipt {
  transactionHash: Hex;
  blockNumber: string;
  from: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  logs: RpcLog[];
}

async function receiptOf(hash: Hex, block: bigint): Promise<{ receipt: ChainReceipt; logs: ChainLog[] }> {
  return cached(["receipt", hash], block, async () => {
    const r = (await rpc("eth_getTransactionReceipt", [hash])) as RpcReceipt | null;
    if (!r) throw new Error(`the endpoint has no receipt for ${hash}`);
    return {
      receipt: {
        transactionHash: r.transactionHash.toLowerCase() as Hex,
        blockNumber: BigInt(r.blockNumber),
        from: r.from.toLowerCase() as Address,
        status: BigInt(r.status) === 1n ? ("success" as const) : ("reverted" as const),
        gasUsed: BigInt(r.gasUsed),
        effectiveGasPrice: BigInt(r.effectiveGasPrice),
      },
      logs: r.logs.filter((log) => !log.removed).map(toChainLog),
    };
  });
}

// ─── Vaults at the last block ─────────────────────────────────────────────────

const WETH_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * Each vault's owner, terms, buy count, whether it is closed, its WETH and —
 * a vault whose source has a community window — its count of community window
 * buys, as they stood at the last block: one Multicall3 per 30 vaults, each
 * read allowed to fail on its own (a failure is unknown, never zero). Terms are
 * read with the source of the release whose factory lists the vault
 * (`decodeTerms`); a v1 vault has no `windowBuys()`, and its call's failure
 * leaves it null, as it should be.
 */
async function readVaults(list: { vault: Address; deployment: string; index: bigint | null }[], toBlock: bigint): Promise<VaultAtEnd[]> {
  const reader = new Multicall3Reader(atBlock(toBlock), { batchSize: 180, gasLimit: 30_000_000n, multicall3: CONTRACTS.multicall3 });
  const calls = list.flatMap(({ vault }) => [
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "terms" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "buysDone" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "closed" }) },
    { to: TOKENS.WETH.address, data: encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [vault] }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "windowBuys" }) },
  ]);
  const answers = await reader.multicall(calls);
  return list.map((v, i) => {
    const [owner, terms, buysDone, closed, balance, windowBuys] = answers.slice(i * 6, i * 6 + 6);
    const decodedTerms = decodeTerms(terms, deployments.find((d) => d.id === v.deployment)?.source);
    return {
      ...v,
      owner: decodeOr(owner, (data) => lower(decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data }))),
      terms: decodedTerms,
      buysDone: decodeOr(buysDone, (data) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data }))),
      closed: decodeOr(closed, (data) => decodeFunctionResult({ abi: VAULT_ABI, functionName: "closed", data })),
      balance: decodeOr(balance, (data) => decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data })),
      windowBuys:
        decodedTerms === null || decodedTerms.communityWindow === null
          ? null
          : decodeOr(windowBuys, (data) => BigInt(decodeFunctionResult({ abi: VAULT_ABI, functionName: "windowBuys", data }))),
    };
  });
}

const lower = (a: string): Address => a.toLowerCase() as Address;

// ─── ETH/USD ──────────────────────────────────────────────────────────────────

/** Chainlink's ETH/USD proxy on Ethereum; the fork has it too, frozen at the pinned block. */
const ETH_USD_PROXY: Address = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const FEED_ABI = parseAbi([
  "function aggregator() view returns (address)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);
const ANSWER_UPDATED = encodeEventTopics({ abi: FEED_ABI, eventName: "AnswerUpdated" })[0] as Hex;

/**
 * The feed's readings over the range: its `AnswerUpdated` logs, from the
 * aggregator the proxy pointed to at each end, and the reading in force at
 * the first block, to open the first day.
 */
async function ethUsd(from: bigint, to: bigint): Promise<{ prices: Prices; source: string }> {
  const fixed = one("--eth-usd");
  if (fixed !== undefined) {
    if (!/^\d+(\.\d{1,8})?$/.test(fixed)) fail("--eth-usd is a price in dollars, like 2643.94");
    const [whole, fraction = ""] = fixed.split(".");
    return { prices: { kind: "fixed", answer: BigInt(whole!) * 10n ** 8n + BigInt(fraction.padEnd(8, "0")) }, source: "fixed (--eth-usd)" };
  }
  try {
    const call = async <T>(block: bigint, functionName: "aggregator" | "latestRoundData"): Promise<T> =>
      decodeFunctionResult({
        abi: FEED_ABI,
        functionName,
        data: (await rpc("eth_call", [{ to: ETH_USD_PROXY, data: encodeFunctionData({ abi: FEED_ABI, functionName }) }, hex(block)])) as Hex,
      }) as T;
    const aggregators = [...new Set([lower(await call<string>(from, "aggregator")), lower(await call<string>(to, "aggregator"))])];
    const [, answer, , updatedAt] = await call<readonly [bigint, bigint, bigint, bigint, bigint]>(from, "latestRoundData");
    const points: PricePoint[] = [{ at: updatedAt, answer }];
    for (const log of await logsOf("ETH/USD", { address: aggregators, topics: [ANSWER_UPDATED] }, from, to)) {
      points.push({ at: BigInt(log.data), answer: BigInt.asIntN(256, BigInt(log.topics[1]!)) });
    }
    return { prices: { kind: "feed", points }, source: `chainlink ${ETH_USD_PROXY}` };
  } catch (error) {
    note(`no ETH/USD price (${messageOf(error)}); dollar figures are left empty`);
    return { prices: { kind: "none" }, source: "none" };
  }
}

// ─── Keeper logs and state ────────────────────────────────────────────────────

function keeperInputs(chainId: number) {
  const dataDir = env["SPDEX_KEEPER_DATA_DIR"] || join(".keeper", String(chainId));
  const patterns = many("--keeper-log");
  const files = [...new Set((patterns.length > 0 ? patterns : [join(dataDir, "keeper-*.jsonl")]).flatMap((p) => globSync(p)))].sort();
  const all: KeeperRecord[] = [];
  const logFiles = files.flatMap((path) => {
    const bytes = readFileSync(path);
    const { records, truncated, bad } = parseKeeperLog(bytes.toString("utf8"));
    // A data directory belongs to one chain (the keeper refuses a state from another), so a file whose
    // keeper started on another chain is another chain's.
    const other = records.find((r) => r.type === "start" && r["chainId"] !== chainId);
    if (other) {
      note(`${path} is chain ${String(other["chainId"])}'s log; it is left out`);
      return [];
    }
    if (truncated) note(`${path}: its last line was cut short, and is skipped`);
    if (bad > 0) note(`${path}: ${bad} line(s) are not keeper records, and are skipped`);
    all.push(...records);
    return [{ path, sha256: sha256(bytes), records: records.length, truncated, bad }];
  });

  const statePath = one("--keeper-state") ?? (existsSync(join(dataDir, "state.json")) ? join(dataDir, "state.json") : undefined);
  let state: { trapped: Address[]; notVouched: Address[] } | null = null;
  let stateFile: { path: string; sha256: string } | null = null;
  if (statePath !== undefined && existsSync(statePath)) {
    const bytes = readFileSync(statePath);
    try {
      const parsed = parseKeeperState(bytes.toString("utf8"));
      state = { trapped: Object.keys(parsed.trapped) as Address[], notVouched: Object.keys(parsed.notVouched) as Address[] };
      stateFile = { path: statePath, sha256: sha256(bytes) };
    } catch (error) {
      note(`${statePath} was not read (${messageOf(error)}); trapped and not_vouched are left empty`);
    }
  } else if (one("--keeper-state") !== undefined) note(`${statePath} does not exist; trapped and not_vouched are left empty`);
  return { records: dedupeKeeperRecords(all), state, logFiles, stateFile };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// ─── The run ──────────────────────────────────────────────────────────────────

const chainId = Number(BigInt((await rpc("eth_chainId", [])) as string));
const onFork = chainId === 690069;

// The last block: finalized, so nothing reported can be reorganised away; the
// fork has no finality, and an endpoint that refuses the tag gets `latest`.
try {
  if (!onFork) finalized = BigInt((await header("finalized")).number);
} catch {
  note("the endpoint does not know the finalized block; reporting to the latest, and caching nothing");
}
const toTag = one("--to-block") ?? "finalized";
if (!/^(\d+|latest|finalized)$/.test(toTag)) fail("--to-block is a block number, latest or finalized");
const toBlock = /^\d+$/.test(toTag) ? BigInt(toTag) : toTag === "finalized" && finalized !== null ? finalized : BigInt((await header("latest")).number);
const deployments = await deploymentsWithCode(toBlock);
if (!/^\d+$/.test(one("--from-block") ?? "0")) fail("--from-block is a block number");
const fromBlock = one("--from-block") !== undefined ? BigInt(one("--from-block")!) : await defaultFromBlock(deployments);
if (fromBlock > toBlock) fail(`nothing to report: the range starts at block ${fromBlock}, after its end, ${toBlock}`);
const [first, last] = [await header(fromBlock), await header(toBlock)];
note(`chain ${chainId}, blocks ${fromBlock} to ${toBlock}${useCache ? ", with the cache" : ""}`);

async function deploymentsWithCode(block: bigint): Promise<Deployment[]> {
  const out: Deployment[] = [];
  for (const d of DEPLOYMENTS) {
    if (((await rpc("eth_getCode", [d.factory, hex(block)])) as string) !== "0x") out.push(d);
    else note(`release ${d.id} has no factory on this chain at block ${block}; it is left out`);
  }
  if (out.length === 0) fail("no spDEX vault factory is deployed on this chain");
  return out;
}

/**
 * The earliest listed factory's block; else the first block any factory from
 * this repository can be in; else a search. Not on the local fork: the blocks
 * listed are Ethereum's, and a fork of an earlier block has the factory only
 * where something deployed it after the pinned block, below any listed one.
 */
async function defaultFromBlock(ds: readonly Deployment[]): Promise<bigint> {
  if (onFork) return VAULT_LOGS_FROM_BLOCK;
  const known = ds.map((d) => d.factoryBlock).filter((b): b is bigint => b !== null);
  if (known.length === ds.length && known.length > 0) return known.reduce((a, b) => (b < a ? b : a));
  if (chainId === 1) return VAULT_LOGS_FROM_BLOCK;
  note("searching for the factory's deployment block (this needs an archive endpoint)");
  const found = await Promise.all(ds.map((d) => deploymentBlock(rpc, d.factory)));
  return found.reduce((a, b) => (b < a ? b : a));
}

// Every vault a listed factory vouches for: its list at the last block, and its creations in the range.
const factories = deployments.map((d) => lower(d.factory));
// Each release's batcher, and, where a release shares one, every shared batcher listed, older ones included.
const batchers = [
  ...new Set([
    ...deployments.map((d) => lower(d.batcher)),
    ...(deployments.some((d) => SOURCES[d.source].features.sharedBatcher) ? BATCHERS.map((b) => lower(b.batcher)) : []),
  ]),
];
const listed: { vault: Address; deployment: string; index: bigint | null }[] = [];
for (const d of deployments) {
  const at = atBlock(toBlock);
  const count = await readVaultCount(at, d.factory);
  for (let offset = 0n; offset < count; offset += 1_000n) {
    (await readVaultsPage(at, d.factory, offset, 1_000n)).forEach((vault, i) => listed.push({ vault, deployment: d.id, index: offset + BigInt(i) }));
  }
}
const factoryLogs = await logsOf("factory", { address: factories }, fromBlock, toBlock);
for (const d of deployments) {
  for (const { vault } of vaultsCreatedBy(d.factory, factoryLogs)) {
    if (!listed.some((l) => l.vault === vault)) listed.push({ vault, deployment: d.id, index: null });
  }
}

const selected = many("--vault").length > 0 ? addresses("--vault") : null;
for (const vault of selected ?? []) if (!listed.some((l) => l.vault === vault)) note(`${vault} is not a vault any listed factory vouches for; it is left out`);
const isSelected = (vault: Address) => selected === null || selected.includes(vault);
const chosen = listed.filter((l) => isSelected(l.vault));
note(`${listed.length} vault(s) listed${selected ? `, ${chosen.length} selected` : ""}`);

const vaultLogs: ChainLog[] = [];
for (let i = 0; i < chosen.length; i += 100) {
  vaultLogs.push(...(await logsOf("vaults", { address: chosen.slice(i, i + 100).map((c) => c.vault) }, fromBlock, toBlock)));
}
const batcherLogs = await logsOf("batchers", { address: batchers }, fromBlock, toBlock);

// Receipts for the batches that touched a selected vault: their gas, and every buy they made.
const batchTxs = new Map<Hex, bigint>();
for (const log of batcherLogs) {
  const event = decodeBatcherEvent(log.address, log);
  if (event && event.name !== "Batch" && isSelected(event.vault)) batchTxs.set(log.transactionHash, log.blockNumber);
}
const receipts: ChainReceipt[] = [];
const receiptLogs: ChainLog[] = [];
for (const [hash, block] of batchTxs) {
  const { receipt, logs } = await receiptOf(hash, block);
  receipts.push(receipt);
  receiptLogs.push(...logs);
}

const keeper = keeperInputs(chainId);
const tipRecipients = addresses("--tip-recipient");
const tips =
  tipRecipients.length === 0
    ? null
    : await logsOf("tips", { topics: [TOPICS.transfer, null, tipRecipients.map((a) => `0x${a.slice(2).padStart(64, "0")}` as Hex)] }, fromBlock, toBlock);
const { prices, source: priceSource } = await ethUsd(fromBlock, toBlock);
const atEnd = chosen.length > 0 ? await readVaults(chosen, toBlock) : [];
const universe: VaultAtEnd[] = [
  ...atEnd,
  ...listed.filter((l) => !isSelected(l.vault)).map((l) => ({ ...l, owner: null, terms: null, buysDone: null, closed: null, balance: null, windowBuys: null })),
];

// Every block anything happened in, for its time and base fee.
const logs = [...factoryLogs, ...vaultLogs, ...batcherLogs, ...receiptLogs];
const minedBlocks = keeper.records.flatMap((r) => (r.type === "batch_mined" && /^\d+$/.test(String(r["block"])) ? [BigInt(String(r["block"]))] : []));
const wanted = new Set([fromBlock, toBlock, ...logs.map((l) => l.blockNumber), ...(tips ?? []).map((l) => l.blockNumber), ...minedBlocks.filter((b) => b >= fromBlock && b <= toBlock)]);
for (const number of [...wanted].sort((a, b) => (a < b ? -1 : 1))) await blockOf(number);

// Reorg-safe: the range must end where it did when the run began.
if ((await header(toBlock)).hash !== last.hash) fail(`block ${toBlock} changed during the run (a reorganisation); run the report again`);

const report = buildReport({
  chainId,
  deployments,
  batchers,
  range: { fromBlock, toBlock, fromTime: BigInt(first.timestamp), toTime: BigInt(last.timestamp), fromHash: first.hash, toHash: last.hash },
  vaults: universe,
  selected,
  logs,
  receipts,
  blocks: [...blocks.values()],
  records: keeper.records,
  state: keeper.state,
  rewardTo: addresses("--reward-to"),
  prices,
  tips,
  uncovered,
  provenance: {
    tool: `spdex keeper-report ${packageVersion()}`,
    endpointHost: new URL(rpcUrl).host,
    priceSource,
    logFiles: keeper.logFiles,
    stateFile: keeper.stateFile,
  },
});

mkdirSync(outDir, { recursive: true });
const written: string[] = [];
for (const [table, rows] of Object.entries(report.tables) as [ReportTable, NonNullable<(typeof report.tables)[ReportTable]>][]) {
  if (format !== "json") {
    writeAtomic(join(outDir, `${table}.csv`), toCsv(REPORT_COLUMNS[table], rows), SHARED);
    written.push(`${table}.csv`);
  }
  if (format !== "csv") {
    writeAtomic(join(outDir, `${table}.json`), toJson(rows), SHARED);
    written.push(`${table}.json`);
  }
}
writeAtomic(join(outDir, "summary.json"), toJson(report.summary), SHARED);
written.push("summary.json");
note(`wrote ${written.join(", ")} to ${outDir}${uncovered.length > 0 ? `; ${uncovered.length} block range(s) are uncovered (summary.json q18)` : ""}`);
