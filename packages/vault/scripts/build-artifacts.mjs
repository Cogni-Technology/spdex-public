#!/usr/bin/env node
/**
 * Generate `src/artifacts.ts` from forge's build output — or, with `--check`,
 * rebuild and fail if the committed file is stale.
 *
 * ## Why the artifacts are committed at all
 *
 * The app must not need Foundry to build, so the ABIs and the creation code
 * live in TypeScript. But a hand-maintained copy is exactly the kind of thing
 * that drifts: an ABI that no longer matches the contract decodes garbage, and
 * creation code that no longer matches the source means the address the app
 * trusts is not the one anybody can rebuild. So the file is generated, and
 * `--check` — part of the verify gate's `contracts` stage — recompiles from
 * source and refuses a committed copy that differs by a byte. The same spirit
 * as `verify-reproducible.mjs`: a published address is only worth something
 * while anyone can check it.
 *
 * ## Sources and releases
 *
 * Two things are kept apart here, because they change at different rates.
 *
 * A **source** is one version of the contracts' code: `SOURCES` below, one row
 * each. v1's is frozen in `releases/v1/contracts`, built by foundry.toml's `v1`
 * profile; the current one is `contracts/`, built by the default profile.
 * Everything the app and the keeper need to know about a source — its ABIs,
 * creation code, constructor shapes, limits, and what its contracts can do
 * (`features`) — is read from its build, not written here: a feature is a
 * fact about an ABI (does `execute` take `rewardTo`? do the terms carry a
 * community window?), so a later source with the same ABIs has the same
 * features without anyone saying so.
 *
 * A **release** is one deployment: a factory, built from a source with
 * constructor arguments (WETH, Uniswap's factories, from v2 the registry its
 * vaults ask, and the market list). Two releases can share a source — the same
 * code with another market list, or another registry — and then the second is
 * one more entry in `deployments.json`, and nothing else.
 *
 * The **batcher** is neither. From v2 it is bound to no factory (it measures
 * what its caller's `rewardTo` earned, and trusts nothing a vault says), so it
 * serves every release whose vaults take `execute(rewardTo)` and pay in WETH,
 * and `deployments.json` lists batchers apart from releases. A later release
 * shares the one already deployed; a fixed batcher is one more batcher entry,
 * with no new factory. v1's batcher, bound to v1's factory, stays in v1's
 * release entry, as it was deployed.
 *
 * ## The record: `deployments.json`
 *
 * `{ "releases": [...], "batchers": [...] }`, each oldest first, each
 * append-only: keepers and reports serve every release that reached mainnet.
 * An entry is frozen once its blocks are filled in, by hand, after its
 * deployment; no frozen entry is ever edited or removed.
 *
 * - v1's release entry keeps the five keys it was written with (`id`,
 *   `factory`, `batcher`, `factoryBlock`, `batcherBlock`), byte for byte.
 * - Every later release: `id`, `source`, `factory`, `registry`, `markets`,
 *   `factoryBlock`, `registryBlock`. `factory` is always recomputed from the
 *   other four and refused when it differs; for an entry not yet deployed it
 *   is rewritten. So a release built from an existing source is added by
 *   appending an entry with `"factory": null`, and the build fills it in.
 * - A batcher: `source`, `batcher`, `batcherBlock`.
 *
 * What the build appends by itself: a release for the current source when no
 * release lists it and its factory is not one already listed, and a batcher
 * for the current source when its address is not already listed. A trailing
 * entry not yet deployed is rewritten instead of appended to.
 *
 * What it refuses: a deployed entry that no longer builds to what it records
 * (frozen source changed, or the current source changed after it reached
 * mainnet without being frozen first — `docs/RELEASE.md`); one factory in two
 * entries (keepers and reports go by factory, and would count its vaults
 * twice); and an entry whose source this build has no row for.
 *
 *   node packages/vault/scripts/build-artifacts.mjs          # write
 *   node packages/vault/scripts/build-artifacts.mjs --check  # verify
 *
 * ## Freezing a source, before changing `contracts/`
 *
 * Once a release built from the current source reaches mainnet, `contracts/`
 * may change only after that source is frozen: copy `contracts/` to
 * `releases/<id>/contracts`, add a `[profile.<id>]` to foundry.toml (a profile
 * inherits nothing, so repeat the settings), set its row below to
 * `frozen: true` with that profile, and add a row for the next source with the
 * default profile. Nothing else here changes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, encodeAbiParameters, getContractAddress, keccak256, toBytes } from "viem";
import { SOLC_VERSION, solcArgs } from "./solc.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(PACKAGE_ROOT, "src", "artifacts.ts");
const DEPLOYMENTS_FILE = join(PACKAGE_ROOT, "deployments.json");
const CHECK = process.argv.includes("--check");

/** The standard deterministic deployer (Arachnid's), at the same address on every EVM chain that has it. */
const DETERMINISTIC_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

/**
 * Salts, derived rather than arbitrary, so a reader can recompute them; the
 * forge tests use the same derivations.
 */
const salt = (preimage) => ({ preimage, value: keccak256(toBytes(preimage)) });

/**
 * Every source of the contracts, oldest first. The last is the current one,
 * `contracts/`, built by the default profile; every other is frozen under
 * `releases/`. See "Freezing a source" above.
 */
const SOURCES = [
  {
    id: "v1",
    frozen: true,
    profile: "v1",
    out: "out-v1",
    dir: "releases/v1/contracts",
    salts: { factory: salt("spdex.vault.factory.v1"), batcher: salt("spdex.vault.batcher.v1"), registry: null },
  },
  {
    id: "v2",
    frozen: false,
    profile: "default",
    out: "out",
    dir: "contracts",
    salts: {
      factory: salt("spdex.vault.factory.v2"),
      batcher: salt("spdex.vault.batcher.v2"),
      registry: salt("spdex.vault.registry.v2"),
    },
  },
];
const CURRENT = SOURCES.at(-1);
if (CURRENT.frozen || CURRENT.profile !== "default" || CURRENT.dir !== "contracts") {
  throw new Error("SOURCES: the last row is the current source, contracts/, built by the default profile, and not frozen");
}
if (SOURCES.slice(0, -1).some((s) => !s.frozen)) throw new Error("SOURCES: every row but the last is frozen");

/**
 * Mainnet's chain-wide addresses, and its market list: what the phase-5a
 * reviews led to — exactly WETH to SPX, on SPX's Uniswap v2 pair, floored by
 * its 0.3% v3 pool. v1's factory was deployed with this list; a release from
 * v2 on records its own (`markets` in its entry), and a release the build
 * appends by itself starts with this one. The local fork is mainnet, so it is
 * the fork's too.
 */
const MAINNET = {
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  uniswapV2Factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
  uniswapV3Factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  markets: [
    {
      tokenOut: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c",
      pair: "0x52c77b0cb827afbad022e6d6caf2c44452edbc39",
      oraclePool: "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3",
    },
  ],
};

// ─── Building a source ───────────────────────────────────────────────────────

function forgeBuild(source) {
  // `--skip test`: what ships is the contracts and their libraries. The
  // settings that make the bytecode reproducible are in foundry.toml.
  // `--force`: compile from source every time rather than trust forge's cache.
  // A check that can be answered from a cache is not a check — and another
  // forge command (`forge lint`, for one) can leave artifacts in `out/` that
  // have an ABI but no bytecode.
  const result = spawnSync("forge", ["build", "--force", "--skip", "test", "--skip", "script", ...solcArgs()], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: source.profile },
  });
  if (result.error) throw new Error(`forge could not start: ${result.error.message} (is Foundry installed?)`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`forge build (profile ${source.profile}) failed with exit code ${result.status}`);
  }
}

const hasContract = (source, name) => existsSync(join(PACKAGE_ROOT, source.dir, `${name}.sol`));

function artifact(source, name) {
  const json = JSON.parse(readFileSync(join(PACKAGE_ROOT, source.out, `${name}.sol`, `${name}.json`), "utf8"));
  const bytecode = json.bytecode?.object;
  if (!Array.isArray(json.abi) || typeof bytecode !== "string" || !/^0x[0-9a-f]+$/i.test(bytecode)) {
    throw new Error(`${name} (${source.id}): forge output has no ABI or bytecode`);
  }
  // Sources share contract names, and forge names an output file after the
  // contract, so make sure this one was compiled from this source and not
  // another's.
  const target = Object.keys(json.metadata?.settings?.compilationTarget ?? {})[0] ?? null;
  if (target !== `${source.dir}/${name}.sol`) {
    throw new Error(`${name} (${source.id}): built from ${target ?? "(unreported)"}, not ${source.dir}/${name}.sol`);
  }
  // The pinned compiler or nothing: bytes from any other build would move the
  // addresses, and writing them would publish that move.
  const compiler = json.metadata?.compiler?.version ?? null;
  if (compiler !== SOLC_VERSION) {
    throw new Error(`${name} was built by solc ${compiler ?? "(unreported)"}, not the pinned ${SOLC_VERSION}`);
  }
  return { abi: json.abi, bytecode: bytecode.toLowerCase(), compiler };
}

/**
 * Evaluate a Solidity constant's literal: an integer or decimal, underscores
 * allowed, optionally followed by one unit. Anything else is refused rather
 * than guessed — a mirrored limit that silently parsed wrong would be worse
 * than none.
 */
const UNITS = { wei: 1n, gwei: 10n ** 9n, ether: 10n ** 18n, seconds: 1n, minutes: 60n, hours: 3600n, days: 86_400n, weeks: 604_800n };
function evaluate(name, literal) {
  const match = /^([0-9][0-9_]*)(?:\.([0-9_]+))?(?:\s+(\w+))?$/.exec(literal.trim());
  if (!match) throw new Error(`${name}: cannot evaluate "${literal}"`);
  const [, whole, fraction = "", unitName] = match;
  const unit = unitName === undefined ? 1n : UNITS[unitName];
  if (unit === undefined) throw new Error(`${name}: unknown unit "${unitName}"`);
  const digits = fraction.replaceAll("_", "");
  const scaled = BigInt(whole.replaceAll("_", "") + digits) * unit;
  const divisor = 10n ** BigInt(digits.length);
  if (scaled % divisor !== 0n) throw new Error(`${name}: "${literal}" is not a whole number of wei`);
  return scaled / divisor;
}

const sourceText = (source, file) => readFileSync(join(PACKAGE_ROOT, source.dir, file), "utf8");

/** Every `uint256 <visibility> constant` in a source file, evaluated. */
function constants(source, file, visibility = "public") {
  const found = {};
  const pattern = new RegExp(`uint256\\s+${visibility}\\s+constant\\s+([A-Z_]+)\\s*=\\s*([^;]+);`, "g");
  for (const [, name, literal] of sourceText(source, file).matchAll(pattern)) found[name] = evaluate(name, literal);
  return found;
}

/** Every `address public constant` in a source file, lowercase. */
function addressConstants(source, file) {
  const found = {};
  for (const [, name, literal] of sourceText(source, file).matchAll(
    /address\s+public\s+constant\s+([A-Z_]+)\s*=\s*(0x[0-9a-fA-F]{40})\s*;/g,
  )) {
    found[name] = literal.toLowerCase();
  }
  return found;
}

const constructorOf = (abi) => abi.find((item) => item.type === "constructor")?.inputs ?? [];
/** A constructor input's name as the deployment fields name it: `weth_` is `weth`. */
const argName = (input) => input.name.replace(/_$/, "");

/**
 * What a source's contracts can do, read from their ABIs: the facts the app,
 * the Guard and the keeper branch on, so that none of them branches on a
 * release's name. A later source with the same ABIs has the same features.
 */
function featuresOf(vault, batcher, registry) {
  const execute = vault.abi.find((item) => item.type === "function" && item.name === "execute");
  const terms = vault.abi.find((item) => item.type === "function" && item.name === "terms")?.outputs?.[0]?.components;
  if (!execute || !terms) throw new Error("the vault has no execute or terms");
  const termNames = terms.map((c) => c.name);
  const batcherArgs = constructorOf(batcher.abi).map(argName);
  return {
    /** `execute(rewardTo)`, paying the address named; else v1's `execute()`, paying its caller. */
    executeTakesRewardTo: execute.inputs.length === 1,
    /** Terms carry `communityWindow`: inside it only the owner or an eligible holder may be paid. */
    communityWindow: termNames.includes("communityWindow"),
    /** Terms carry `turnBuckets`: a window's first half may be shared out in turns. */
    turns: termNames.includes("turnBuckets"),
    /** The source has an SPX holder registry a factory names. */
    registry: registry !== null,
    /** Its batcher is bound to no factory (constructed with WETH), and serves any release whose vaults take `rewardTo`. */
    sharedBatcher: batcherArgs.length === 1 && batcherArgs[0] === "weth",
  };
}

function build(source) {
  const vault = artifact(source, "SpdexDcaVault");
  const factory = artifact(source, "SpdexVaultFactory");
  const batcher = artifact(source, "SpdexVaultBatcher");
  const registry = hasContract(source, "SpxHolderRegistry") ? artifact(source, "SpxHolderRegistry") : null;
  const features = featuresOf(vault, batcher, registry);
  if (features.registry !== (source.salts.registry !== null)) {
    throw new Error(`${source.id}: a source with a registry needs a registry salt, and only one with a registry`);
  }
  const vaultArgsLength = constants(source, "libraries/VaultArgs.sol", "internal").LENGTH;
  if (vaultArgsLength === undefined) throw new Error(`${source.id}: libraries/VaultArgs.sol has no LENGTH`);
  const built = {
    source,
    vault,
    factory,
    batcher,
    registry,
    features,
    vaultArgsLength,
    factoryConstructor: constructorOf(factory.abi),
    batcherConstructor: constructorOf(batcher.abi),
    vaultLimits: constants(source, "VaultLimits.sol"),
    factoryLimits: constants(source, "SpdexVaultFactory.sol"),
    vaultConstants: constants(source, "SpdexDcaVault.sol"),
    batcherLimits: constants(source, "SpdexVaultBatcher.sol"),
    registryLimits: registry ? constants(source, "SpxHolderRegistry.sol") : null,
    registryAddresses: registry ? addressConstants(source, "SpxHolderRegistry.sol") : null,
  };
  built.registryAddress = registry ? create2(source.salts.registry.value, registry.bytecode) : null;
  built.batcherAddress = features.sharedBatcher ? create2(source.salts.batcher.value, withArgs(built.batcherConstructor, batcher.bytecode, MAINNET)) : null;
  return built;
}

const create2 = (saltValue, initCode) =>
  getContractAddress({ opcode: "CREATE2", from: DETERMINISTIC_DEPLOYER, salt: saltValue, bytecode: initCode }).toLowerCase();
/** A factory's implementation is its first creation: CREATE from it at nonce 1. */
const firstCreation = (factory) => getContractAddress({ opcode: "CREATE", from: factory, nonce: 1n }).toLowerCase();
/** Creation code and its constructor's arguments, each taken from `args` by its input's name. */
function withArgs(inputs, code, args) {
  const values = inputs.map((input) => {
    const value = args[argName(input)];
    if (value === undefined || value === null) throw new Error(`no value for constructor argument ${input.name}`);
    return value;
  });
  return concat([code, encodeAbiParameters(inputs, values)]);
}
/** Where a source's factory with these arguments lands. */
const factoryOf = (built, args) => create2(built.source.salts.factory.value, withArgs(built.factoryConstructor, built.factory.bytecode, args));

// ─── The record ──────────────────────────────────────────────────────────────

const V1_RELEASE_KEYS = ["id", "factory", "batcher", "factoryBlock", "batcherBlock"];
const RELEASE_KEYS = ["id", "source", "factory", "registry", "markets", "factoryBlock", "registryBlock"];
const BATCHER_KEYS = ["source", "batcher", "batcherBlock"];
const MARKET_KEYS = ["tokenOut", "pair", "oraclePool"];
const isBlock = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
const isAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
const sameKeys = (object, keys) => typeof object === "object" && object !== null && Object.keys(object).join() === keys.join();

/** The committed record, checked entry by entry for its shape. */
function readDeployments() {
  if (!existsSync(DEPLOYMENTS_FILE)) throw new Error("deployments.json is missing: it must list v1, which is on mainnet");
  const record = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
  if (!sameKeys(record, ["releases", "batchers"]) || !Array.isArray(record.releases) || !Array.isArray(record.batchers)) {
    throw new Error('deployments.json: expected { "releases": [...], "batchers": [...] }');
  }
  const sourceIds = SOURCES.map((s) => s.id);
  record.releases.forEach((entry, i) => {
    const where = `deployments.json release ${i}`;
    const keys = i === 0 ? V1_RELEASE_KEYS : RELEASE_KEYS;
    if (!sameKeys(entry, keys)) throw new Error(`${where}: expected exactly ${keys.join(", ")}, in that order`);
    // Ids run v1, v2, … with no gap: a gap is an entry someone removed.
    if (entry.id !== `v${i + 1}`) throw new Error(`${where}: id is ${JSON.stringify(entry.id)}, not "v${i + 1}"`);
    for (const key of keys.filter((k) => k.endsWith("Block"))) {
      if (!isBlock(entry[key])) throw new Error(`${where}: ${key} is a non-negative integer, or null before the deployment`);
    }
    if (i === 0) {
      if (!isAddress(entry.factory) || !isAddress(entry.batcher)) throw new Error(`${where}: factory and batcher are lowercase addresses`);
      if (entry.factoryBlock === null) throw new Error(`${where}: v1 is on mainnet; its blocks are recorded`);
      return;
    }
    if (!sourceIds.includes(entry.source)) throw new Error(`${where}: source ${JSON.stringify(entry.source)} is no row of SOURCES`);
    if (entry.factory !== null && !isAddress(entry.factory)) throw new Error(`${where}: factory is a lowercase address, or null to have it worked out`);
    if (!isAddress(entry.registry)) throw new Error(`${where}: registry is a lowercase address`);
    if (!Array.isArray(entry.markets) || entry.markets.length === 0) throw new Error(`${where}: markets is a non-empty list`);
    for (const market of entry.markets) {
      if (!sameKeys(market, MARKET_KEYS) || !MARKET_KEYS.every((k) => isAddress(market[k]))) {
        throw new Error(`${where}: each market is exactly ${MARKET_KEYS.join(", ")}, lowercase addresses`);
      }
    }
    // A factory's constructor reads its registry, so that comes first.
    if (entry.factoryBlock === null && entry.registryBlock !== null && !record.releases.slice(0, i).some((e) => e.registry === entry.registry)) {
      throw new Error(`${where}: has a registryBlock but no factoryBlock; fill in a release's blocks together`);
    }
    if (entry.factoryBlock !== null && (entry.registryBlock === null || entry.registryBlock > entry.factoryBlock)) {
      throw new Error(`${where}: a deployed release's registry has a block, at or before its factory's`);
    }
    // Only the last release can be undeployed; every one before it reached mainnet.
    if (entry.factoryBlock === null && i !== record.releases.length - 1) {
      throw new Error(`${where}: only the last release may be undeployed (factoryBlock null)`);
    }
  });
  record.batchers.forEach((entry, i) => {
    const where = `deployments.json batcher ${i}`;
    if (!sameKeys(entry, BATCHER_KEYS)) throw new Error(`${where}: expected exactly ${BATCHER_KEYS.join(", ")}, in that order`);
    if (!sourceIds.includes(entry.source)) throw new Error(`${where}: source ${JSON.stringify(entry.source)} is no row of SOURCES`);
    if (!isAddress(entry.batcher)) throw new Error(`${where}: batcher is a lowercase address`);
    if (!isBlock(entry.batcherBlock)) throw new Error(`${where}: batcherBlock is a non-negative integer, or null before the deployment`);
    if (entry.batcherBlock === null && i !== record.batchers.length - 1) {
      throw new Error(`${where}: only the last batcher may be undeployed (batcherBlock null)`);
    }
  });
  return record;
}

/**
 * The record once every entry is checked against what its source builds to,
 * and this build's release and batcher are in it: undeployed entries
 * rewritten, missing ones appended. Deployed entries are never touched.
 */
function reconcile(record, builds) {
  const byId = new Map(builds.map((b) => [b.source.id, b]));
  const current = byId.get(CURRENT.id);
  const v1 = byId.get("v1");

  // v1, as deployed: the frozen source must still give its factory and batcher.
  const v1Entry = record.releases[0];
  const v1Factory = factoryOf(v1, MAINNET);
  const v1Batcher = create2(v1.source.salts.batcher.value, withArgs(v1.batcherConstructor, v1.batcher.bytecode, { factory: v1Factory }));
  if (v1Factory !== v1Entry.factory || v1Batcher !== v1Entry.batcher) {
    throw new Error(
      "v1's frozen source no longer builds to its deployed addresses:\n" +
        `  factory ${v1Factory}, deployments.json says ${v1Entry.factory}\n` +
        `  batcher ${v1Batcher}, deployments.json says ${v1Entry.batcher}\n` +
        "releases/v1/contracts, the compiler or foundry.toml's v1 profile has changed. v1 is on mainnet\n" +
        "and immutable: put its source and settings back; never edit its entry.",
    );
  }

  const releases = [v1Entry];
  for (const entry of record.releases.slice(1)) {
    const built = byId.get(entry.source);
    const deployed = entry.factoryBlock !== null;
    let registry = entry.registry;
    // An undeployed release from a source with a registry asks that source's
    // registry, unless it names one an earlier release deployed (shared).
    if (!deployed && built.registryAddress && !releases.some((e) => e.registry === registry)) registry = built.registryAddress;
    const factory = factoryOf(built, { ...MAINNET, registry, markets: entry.markets });
    if (deployed && (factory !== entry.factory || registry !== entry.registry)) {
      throw new Error(
        `${entry.id} reached mainnet, built from source ${entry.source}, but that source no longer builds to it:\n` +
          `  factory ${factory}, deployments.json says ${entry.factory}\n` +
          (entry.source === CURRENT.id
            ? "contracts/ changed after it was deployed. Freeze it first (releases/" + entry.source + ", a profile and its\n" +
              "SOURCES row; see the top of this script), then change contracts/ as the next source."
            : `releases/${entry.source}, the compiler or its foundry.toml profile has changed. Put them back.`),
      );
    }
    releases.push({ ...entry, factory, registry });
  }
  // One factory to one release: everything that reads the record goes by them.
  releases.forEach((entry, i) => {
    const earlier = releases.slice(0, i).find((e) => e.factory === entry.factory);
    if (earlier) throw new Error(`deployments.json: ${entry.id}'s factory is ${earlier.id}'s too; one factory belongs to one release`);
  });

  // The current source's own release, when nothing lists it yet.
  const currentFactory = factoryOf(current, { ...MAINNET, registry: current.registryAddress, markets: MAINNET.markets });
  if (!releases.some((e) => e.source === CURRENT.id) && !releases.some((e) => e.factory === currentFactory)) {
    const last = releases.at(-1);
    if (last.factoryBlock === null) {
      throw new Error(`${last.id} is not deployed yet; deploy it, or remove it, before the current source appends another`);
    }
    releases.push({
      id: `v${releases.length + 1}`,
      source: CURRENT.id,
      factory: currentFactory,
      registry: current.registryAddress,
      markets: MAINNET.markets,
      factoryBlock: null,
      registryBlock: null,
    });
  }

  // Batchers: each listed one must still build from its source; the current
  // source's shared batcher is listed, rewriting an undeployed last entry.
  const batchers = record.batchers.map((entry, i) => {
    const built = byId.get(entry.source);
    if (!built.features.sharedBatcher) throw new Error(`deployments.json batcher ${i}: source ${entry.source}'s batcher is bound to a factory`);
    if (entry.batcherBlock !== null && built.batcherAddress !== entry.batcher) {
      throw new Error(
        `batcher ${entry.batcher} reached mainnet, built from source ${entry.source}, which now builds ${built.batcherAddress}.\n` +
          (entry.source === CURRENT.id ? "Freeze the source before changing the batcher (see the top of this script)." : "Put its source back."),
      );
    }
    return { ...entry, batcher: built.batcherAddress };
  });
  if (current.features.sharedBatcher && !batchers.some((b) => b.batcher === current.batcherAddress)) {
    const last = batchers.at(-1);
    if (last && last.batcherBlock === null) batchers[batchers.length - 1] = { source: CURRENT.id, batcher: current.batcherAddress, batcherBlock: null };
    else batchers.push({ source: CURRENT.id, batcher: current.batcherAddress, batcherBlock: null });
  }
  if (batchers.length === 0 && releases.length > 1) throw new Error("deployments.json: releases from v2 on need a batcher");
  return { releases, batchers };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const renderDeployments = (record) => {
  // Markets on one line each, the rest as JSON prints it: a market list reads as a list.
  return `${JSON.stringify(record, null, 2)}\n`;
};
const tsBlock = (block) => (block === null ? "null" : `${block}n`);
const tsAddress = (address) => (address === null ? "null" : `"${address}"`);
const lines = (object, indent = "  ") =>
  Object.entries(object)
    .map(([name, value]) => `${indent}${name}: ${value}n,`)
    .join("\n");
const marketLines = (markets, indent) =>
  markets
    .map((m) => `${indent}{ tokenOut: "${m.tokenOut}", pair: "${m.pair}", oraclePool: "${m.oraclePool}" },`)
    .join("\n");

function renderSource(b) {
  const P = `${b.source.id.toUpperCase()}_`;
  const where = b.source.frozen ? `${b.source.dir}, frozen` : `${b.source.dir}, the current source`;
  const parts = [
    `// ─── Source ${b.source.id}: packages/vault/${where} ${"─".repeat(Math.max(3, 60 - where.length))}`,
    "",
    `export const ${P}VAULT_ABI = ${JSON.stringify(b.vault.abi, null, 2)} as const;`,
    "",
    `export const ${P}FACTORY_ABI = ${JSON.stringify(b.factory.abi, null, 2)} as const;`,
    "",
    `export const ${P}BATCHER_ABI = ${JSON.stringify(b.batcher.abi, null, 2)} as const;`,
    "",
  ];
  if (b.registry) {
    parts.push(`export const ${P}REGISTRY_ABI = ${JSON.stringify(b.registry.abi, null, 2)} as const;`, "");
  }
  parts.push(
    `/** ${b.source.id}'s SpdexVaultFactory creation code, without constructor arguments. */`,
    `export const ${P}FACTORY_CREATION_CODE =\n  "${b.factory.bytecode}" as const;`,
    "",
    `/** keccak256 of the factory's creation code above: a short fingerprint to compare builds by. */`,
    `export const ${P}FACTORY_CREATION_CODE_HASH = "${keccak256(b.factory.bytecode)}" as const;`,
    "",
    `/** keccak256("${b.source.salts.factory.preimage}"). */`,
    `export const ${P}FACTORY_SALT = "${b.source.salts.factory.value}" as const;`,
    "",
    `/** ${b.source.id}'s SpdexVaultBatcher creation code, without its constructor's argument (${b.features.sharedBatcher ? "WETH" : "the factory it is bound to"}). */`,
    `export const ${P}BATCHER_CREATION_CODE =\n  "${b.batcher.bytecode}" as const;`,
    "",
    `/** keccak256 of the batcher's creation code above. */`,
    `export const ${P}BATCHER_CREATION_CODE_HASH = "${keccak256(b.batcher.bytecode)}" as const;`,
    "",
    `/** keccak256("${b.source.salts.batcher.preimage}"). */`,
    `export const ${P}BATCHER_SALT = "${b.source.salts.batcher.value}" as const;`,
    "",
  );
  if (b.registry) {
    parts.push(
      `/** ${b.source.id}'s SpxHolderRegistry creation code. It has no constructor arguments: this is its whole init code. */`,
      `export const ${P}REGISTRY_CREATION_CODE =\n  "${b.registry.bytecode}" as const;`,
      "",
      `/** keccak256 of the registry's creation code above. */`,
      `export const ${P}REGISTRY_CREATION_CODE_HASH = "${keccak256(b.registry.bytecode)}" as const;`,
      "",
      `/** keccak256("${b.source.salts.registry.preimage}"). */`,
      `export const ${P}REGISTRY_SALT = "${b.source.salts.registry.value}" as const;`,
      "",
      `/** SpxHolderRegistry's own public constants, parsed from its source. */`,
      `export const ${P}REGISTRY_LIMITS = {\n${lines(b.registryLimits)}\n} as const;`,
      "",
      `/** The SPX token whose balance the registry proves and checks (\`SpxHolderRegistry.SPX\`). */`,
      `export const ${P}SPX_TOKEN = "${b.registryAddresses.SPX}" as const;`,
      "",
      `/** EIP-2935's history contract, which the registry reads past blocks' hashes from (\`SpxHolderRegistry.HISTORY\`). */`,
      `export const ${P}HISTORY_CONTRACT = "${b.registryAddresses.HISTORY}" as const;`,
      "",
    );
  }
  parts.push(
    `/** The limits every ${b.source.id} vault is held to (VaultLimits.sol, which the vault and the factory inherit), parsed from its source. */`,
    `export const ${P}VAULT_LIMITS = {\n${lines(b.vaultLimits)}\n} as const;`,
    "",
    `/** ${b.source.id}'s SpdexVaultFactory constants, parsed from its source. */`,
    `export const ${P}FACTORY_LIMITS = {\n${lines(b.factoryLimits)}\n} as const;`,
    "",
    `/** ${b.source.id}'s SpdexDcaVault constants of its own, parsed from its source. */`,
    `export const ${P}VAULT_CONSTANTS = {${Object.keys(b.vaultConstants).length ? `\n${lines(b.vaultConstants)}\n` : ""}} as const;`,
    "",
    `/** ${b.source.id}'s SpdexVaultBatcher constants, parsed from its source. */`,
    `export const ${P}BATCHER_LIMITS = {\n${lines(b.batcherLimits)}\n} as const;`,
    "",
  );
  return parts.join("\n");
}

function renderSourceRow(b) {
  const P = `${b.source.id.toUpperCase()}_`;
  const f = b.features;
  return `  ${b.source.id}: {
    id: "${b.source.id}",
    frozen: ${b.source.frozen},
    vaultAbi: ${P}VAULT_ABI,
    factoryAbi: ${P}FACTORY_ABI,
    batcherAbi: ${P}BATCHER_ABI,
    registryAbi: ${b.registry ? `${P}REGISTRY_ABI` : "null"},
    factoryCreationCode: ${P}FACTORY_CREATION_CODE,
    factorySalt: ${P}FACTORY_SALT,
    factoryConstructor: ${JSON.stringify(b.factoryConstructor)},
    batcherCreationCode: ${P}BATCHER_CREATION_CODE,
    batcherSalt: ${P}BATCHER_SALT,
    batcherConstructor: ${JSON.stringify(b.batcherConstructor)},
    registryCreationCode: ${b.registry ? `${P}REGISTRY_CREATION_CODE` : "null"},
    registrySalt: ${b.registry ? `${P}REGISTRY_SALT` : "null"},
    vaultArgsLength: ${b.vaultArgsLength},
    features: {
      executeTakesRewardTo: ${f.executeTakesRewardTo},
      communityWindow: ${f.communityWindow},
      turns: ${f.turns},
      registry: ${f.registry},
      sharedBatcher: ${f.sharedBatcher},
    },
    vaultLimits: ${P}VAULT_LIMITS,
    factoryLimits: ${P}FACTORY_LIMITS,
    vaultConstants: ${P}VAULT_CONSTANTS,
    batcherLimits: ${P}BATCHER_LIMITS,
  },`;
}

/** The current source's names, unprefixed: what creating a vault on the latest release uses. */
function renderAliases(b) {
  const P = `${b.source.id.toUpperCase()}_`;
  const names = [
    "VAULT_ABI",
    "FACTORY_ABI",
    "BATCHER_ABI",
    "FACTORY_CREATION_CODE",
    "FACTORY_CREATION_CODE_HASH",
    "FACTORY_SALT",
    "BATCHER_CREATION_CODE",
    "BATCHER_CREATION_CODE_HASH",
    "BATCHER_SALT",
    "VAULT_LIMITS",
    "FACTORY_LIMITS",
    "VAULT_CONSTANTS",
    "BATCHER_LIMITS",
    ...(b.registry
      ? ["REGISTRY_ABI", "REGISTRY_CREATION_CODE", "REGISTRY_CREATION_CODE_HASH", "REGISTRY_SALT", "REGISTRY_LIMITS", "SPX_TOKEN", "HISTORY_CONTRACT"]
      : []),
  ];
  return names.map((name) => `export const ${name} = ${P}${name};`).join("\n");
}

function render(builds, record) {
  const current = builds.at(-1);
  const v1 = builds[0];
  const ids = record.releases.map((d) => JSON.stringify(d.id)).join(" | ");
  const sourceIds = builds.map((b) => JSON.stringify(b.source.id)).join(" | ");
  const latestBatcher = record.batchers.at(-1);
  const latest = record.releases.at(-1);
  const v1Entry = record.releases[0];
  const v1Factory = v1Entry.factory;

  const releaseLines = record.releases
    .map((d, i) => {
      const own = i === 0;
      const markets = own ? MAINNET.markets : d.markets;
      return (
        `  {\n    id: "${d.id}",\n    source: "${own ? "v1" : d.source}",\n    factory: "${d.factory}",\n` +
        `    registry: ${tsAddress(own ? null : d.registry)},\n` +
        `    batcher: "${own ? d.batcher : latestBatcher.batcher}",\n` +
        `    markets: [\n${marketLines(markets, "      ")}\n    ],\n` +
        `    factoryBlock: ${tsBlock(d.factoryBlock)},\n` +
        `    registryBlock: ${tsBlock(own ? null : d.registryBlock)},\n` +
        `    batcherBlock: ${tsBlock(own ? d.batcherBlock : latestBatcher.batcherBlock)},\n  },`
      );
    })
    .join("\n");
  const batcherLines = record.batchers
    .map((b) => `  { source: "${b.source}", batcher: "${b.batcher}", batcherBlock: ${tsBlock(b.batcherBlock)} },`)
    .join("\n");

  const text = `// GENERATED by packages/vault/scripts/build-artifacts.mjs from forge's output. Do not edit.
//
//   regenerate: pnpm --filter @spdex/vault build:artifacts
//   check:      pnpm --filter @spdex/vault check:artifacts  (the verify gate's \`contracts\` stage)
//
// Built by solc ${current.factory.compiler ?? "(version not reported)"} with the settings in
// packages/vault/foundry.toml: optimizer 200 runs, EVM cancun, no metadata hash and no
// CBOR trailer, so the bytes below are reproducible from source on any machine.
//
// Sources and releases. A source is one version of the contracts' code: every one is
// exported under its own prefix (\`V1_\`, \`V2_\`, …) and described in \`SOURCES\`, with what
// its contracts can do (\`features\`, read from its ABIs). The current source, built from
// packages/vault/contracts, is also exported under unprefixed names (\`VAULT_ABI\`, …): use
// those only for what is always the current source's, such as creating a vault; anything
// about a vault that exists goes by its release's source. Frozen sources are built from
// packages/vault/releases, and the build refuses to write unless each still gives the
// releases deployments.json records for it. A release is one deployment of a source:
// \`DEPLOYMENTS\`, oldest first. Batchers from v2 on serve every release whose vaults take
// \`execute(rewardTo)\`, and are listed apart: \`BATCHERS\`.

import { concat, encodeAbiParameters, getContractAddress } from "viem";

/** The standard deterministic deployer. Deploys \`initCode\` at CREATE2(itself, salt, initCode) for anyone. */
export const DETERMINISTIC_DEPLOYER = "${DETERMINISTIC_DEPLOYER}" as const;

/** One market a factory's vaults can buy on: \`markets(i)\` on the factory. */
export interface Market {
  tokenOut: \`0x\${string}\`;
  /** The Uniswap v2 WETH/tokenOut pair every buy trades on. */
  pair: \`0x\${string}\`;
  /** The Uniswap v3 WETH/tokenOut pool each buy's floor is read from. */
  oraclePool: \`0x\${string}\`;
}

/** A factory's constructor arguments: everything its address depends on besides its bytecode. */
export interface FactoryDeployment {
  weth: \`0x\${string}\`;
  uniswapV2Factory: \`0x\${string}\`;
  uniswapV3Factory: \`0x\${string}\`;
  /** The SPX holder registry every vault of the factory asks inside a community window. */
  registry: \`0x\${string}\`;
  markets: readonly Market[];
}

/** v1's factory's constructor arguments: v2's without the registry, which v1 does not have. */
export interface V1FactoryDeployment {
  weth: \`0x\${string}\`;
  uniswapV2Factory: \`0x\${string}\`;
  uniswapV3Factory: \`0x\${string}\`;
  markets: readonly Market[];
}

${builds.map(renderSource).join("\n")}
// ─── Every source, as data ───────────────────────────────────────────────────

/**
 * Every source of the contracts, by id: its ABIs, creation code, salts and
 * constructors, its limits, and what its contracts can do (\`features\`, read
 * from its ABIs). Code that handles a vault of any release goes by these, never
 * by a release's name.
 */
export const SOURCES = {
${builds.map(renderSourceRow).join("\n")}
} as const;

export type SourceId = ${sourceIds};
export type Source = (typeof SOURCES)[SourceId];
export type SourceFeatures = Source["features"];

/** The source packages/vault/contracts is: the one this build creates vaults with. */
export const CURRENT_SOURCE = "${current.source.id}" as const;

// ─── The current source, unprefixed ──────────────────────────────────────────

${renderAliases(current)}

// ─── Where contracts land ────────────────────────────────────────────────────

type ConstructorArgs = Partial<Record<string, unknown>>;

/** Creation code with its constructor's arguments, each taken from \`args\` by its input's name (\`weth_\` is \`weth\`). */
function withArgs(code: \`0x\${string}\`, inputs: readonly { name: string; type: string }[], args: ConstructorArgs): \`0x\${string}\` {
  const values = inputs.map((input) => {
    const value = args[input.name.replace(/_$/, "")];
    if (value === undefined || value === null) throw new RangeError(\`no value for constructor argument \${input.name}\`);
    return value;
  });
  return concat([code, encodeAbiParameters(inputs as never, values as never)]);
}

const create2 = (salt: \`0x\${string}\`, bytecode: \`0x\${string}\`): \`0x\${string}\` =>
  getContractAddress({ opcode: "CREATE2", from: DETERMINISTIC_DEPLOYER, salt, bytecode }).toLowerCase() as \`0x\${string}\`;

/** A factory's init code, from \`source\` (the current one by default): its creation code and its constructor's arguments. */
export function factoryInitCode(deployment: FactoryDeployment | V1FactoryDeployment, source: SourceId = CURRENT_SOURCE): \`0x\${string}\` {
  const s = SOURCES[source];
  return withArgs(s.factoryCreationCode, s.factoryConstructor, deployment as unknown as ConstructorArgs);
}

/**
 * Where the factory for \`deployment\` lives, on any chain with the deterministic
 * deployer: a pure function of its source's bytecode — the vault's included —
 * and its constructor's arguments, the registry and the market list among them.
 * Lowercase, like every address spDEX compares.
 */
export function factoryAddress(deployment: FactoryDeployment | V1FactoryDeployment, source: SourceId = CURRENT_SOURCE): \`0x\${string}\` {
  return create2(SOURCES[source].factorySalt, factoryInitCode(deployment, source));
}

/**
 * A batcher's init code: its creation code and its constructor's one argument —
 * WETH for a batcher bound to no factory (v2 on), the factory for v1's.
 */
export function batcherInitCode(argument: \`0x\${string}\`, source: SourceId = CURRENT_SOURCE): \`0x\${string}\` {
  const s = SOURCES[source];
  return concat([s.batcherCreationCode, encodeAbiParameters([{ type: "address" }], [argument])]);
}

/** Where that batcher lives, on any chain with the deterministic deployer. Lowercase. */
export function batcherAddress(argument: \`0x\${string}\`, source: SourceId = CURRENT_SOURCE): \`0x\${string}\` {
  return create2(SOURCES[source].batcherSalt, batcherInitCode(argument, source));
}

/** A registry's init code: its creation code, since its constructor takes nothing. Throws for a source without one. */
export function registryInitCode(source: SourceId = CURRENT_SOURCE): \`0x\${string}\` {
  const code = SOURCES[source].registryCreationCode;
  if (code === null) throw new RangeError(\`source \${source} has no registry\`);
  return code;
}

/**
 * Where a source's registry lives, on any chain with the deterministic
 * deployer: a pure function of its bytecode alone — the vendored proof verifier's
 * included. Lowercase. It is deployed first: the factory's constructor checks it.
 */
export function registryAddress(source: SourceId = CURRENT_SOURCE): \`0x\${string}\` {
  const salt = SOURCES[source].registrySalt;
  if (salt === null) throw new RangeError(\`source \${source} has no registry\`);
  return create2(salt, registryInitCode(source));
}

/** v1's factory's init code for a deployment. */
export const v1FactoryInitCode = (deployment: V1FactoryDeployment): \`0x\${string}\` => factoryInitCode(deployment, "v1");
/** Where v1's factory for \`deployment\` lives. Lowercase. */
export const v1FactoryAddress = (deployment: V1FactoryDeployment): \`0x\${string}\` => factoryAddress(deployment, "v1");
/** v1's batcher's init code for the factory it is bound to. */
export const v1BatcherInitCode = (factory: \`0x\${string}\`): \`0x\${string}\` => batcherInitCode(factory, "v1");
/** Where v1's batcher bound to \`factory\` lives. Lowercase. */
export const v1BatcherAddress = (factory: \`0x\${string}\`): \`0x\${string}\` => batcherAddress(factory, "v1");

// ─── Mainnet ─────────────────────────────────────────────────────────────────

/** v1's mainnet factory's constructor arguments. */
export const V1_MAINNET_DEPLOYMENT = {
  weth: "${MAINNET.weth}",
  uniswapV2Factory: "${MAINNET.uniswapV2Factory}",
  uniswapV3Factory: "${MAINNET.uniswapV3Factory}",
  markets: [
${marketLines(MAINNET.markets, "    ")}
  ],
} as const satisfies V1FactoryDeployment;

/** v1FactoryAddress(V1_MAINNET_DEPLOYMENT), written out: v1's factory on mainnet, \`DEPLOYMENTS[0].factory\`. */
export const V1_MAINNET_FACTORY = "${v1Factory}" as const;
/** The implementation every v1 vault is a clone of: v1's factory's first creation. */
export const V1_MAINNET_IMPLEMENTATION = "${firstCreation(v1Factory)}" as const;
/** v1BatcherAddress(V1_MAINNET_FACTORY), written out: v1's batcher on mainnet, \`DEPLOYMENTS[0].batcher\`. */
export const V1_MAINNET_BATCHER = "${v1Entry.batcher}" as const;

/**
 * The latest release's factory's constructor arguments (\`DEPLOYMENTS\`' last):
 * WETH to SPX, on SPX's Uniswap v2 pair, floored by its 0.3% v3 pool, asking
 * the registry at its mainnet address. The only list there is; another is
 * another factory, and another release.
 */
export const MAINNET_DEPLOYMENT = {
  weth: "${MAINNET.weth}",
  uniswapV2Factory: "${MAINNET.uniswapV2Factory}",
  uniswapV3Factory: "${MAINNET.uniswapV3Factory}",
  registry: "${latest.registry}",
  markets: [
${marketLines(latest.markets, "    ")}
  ],
} as const satisfies FactoryDeployment;

/** registryAddress(), written out: the current source's registry, which the latest release asks. A unit test holds the two to agreement. */
export const MAINNET_REGISTRY = "${current.registryAddress}" as const;
/** factoryAddress(MAINNET_DEPLOYMENT, \`${latest.source}\`), written out: the latest release's factory. */
export const MAINNET_FACTORY = "${latest.factory}" as const;
/** The implementation every vault of the latest release is a clone of: its factory's first creation. */
export const MAINNET_IMPLEMENTATION = "${firstCreation(latest.factory)}" as const;
/** The newest batcher (\`BATCHERS\`' last): batcherAddress(WETH), written out. It serves every release from v2 on. */
export const MAINNET_BATCHER = "${latestBatcher.batcher}" as const;

// ─── The record: deployments.json ────────────────────────────────────────────

/**
 * One release of the contracts: a factory built from \`source\` with these
 * markets and, from v2, the SPX holder registry its vaults ask; the batcher a
 * keeper sends its vaults' buys through; and the blocks they were deployed in.
 */
export interface Deployment {
  /** "v1", "v2", …: its place in deployments.json, oldest first. */
  id: ${ids};
  /** The source its factory and vaults were built from: \`SOURCES[source]\` says what they can do. */
  source: SourceId;
  factory: \`0x\${string}\`;
  /** The SPX holder registry its vaults ask inside a community window; null for v1, which has none. */
  registry: \`0x\${string}\` | null;
  /**
   * The batcher its vaults' buys are batched through: v1's own, bound to v1's
   * factory; from v2 on, the newest of \`BATCHERS\`, bound to no factory.
   */
  batcher: \`0x\${string}\`;
  /** The markets its factory was deployed with, by index. */
  markets: readonly Market[];
  /** The block the factory was deployed in on mainnet; null while this release is not deployed. */
  factoryBlock: bigint | null;
  /** The block the registry was deployed in on mainnet; null until then, and for v1. */
  registryBlock: bigint | null;
  /** The block \`batcher\` was deployed in on mainnet; null until then. */
  batcherBlock: bigint | null;
}

/**
 * Every release, oldest first, from packages/vault/deployments.json. It never
 * shrinks: keepers and reports serve the vaults of every release that reached
 * mainnet. The last is the one this build creates vaults on (\`MAINNET_FACTORY\`).
 */
export const DEPLOYMENTS: readonly Deployment[] = [
${releaseLines}
];

/** One batcher bound to no factory: the source it was built from, where it lives, and its block. */
export interface BatcherDeployment {
  source: SourceId;
  batcher: \`0x\${string}\`;
  /** The block it was deployed in on mainnet; null while it is not deployed. */
  batcherBlock: bigint | null;
}

/**
 * Every batcher from v2 on, oldest first: each serves every release whose
 * vaults take \`execute(rewardTo)\`. A keeper sends through the newest
 * (\`MAINNET_BATCHER\`); a report reads every one's logs. v1's batcher is in v1's
 * release instead.
 */
export const BATCHERS: readonly BatcherDeployment[] = [
${batcherLines}
];
`;
  return text;
}

// ─── Main ────────────────────────────────────────────────────────────────────

for (const source of SOURCES) forgeBuild(source);
const builds = SOURCES.map(build);
const record = reconcile(readDeployments(), builds);
const text = render(builds, record);
const deployments = renderDeployments(record);
const current = builds.at(-1);

if (CHECK) {
  const committed = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // Missing counts as stale.
      return "";
    }
  };
  if (committed(DEPLOYMENTS_FILE) !== deployments) {
    console.error(
      "packages/vault/deployments.json is not what this build makes of it: an entry the build fills in or appends\n" +
        "differs. Run `pnpm --filter @spdex/vault build:artifacts` and commit the result. Never edit or remove an\n" +
        "entry that has a block: it reached mainnet.",
    );
    process.exit(1);
  }
  if (committed(TARGET) !== text) {
    console.error(
      "packages/vault/src/artifacts.ts is stale: it does not match what the contracts compile to now.\n" +
        "Run `pnpm --filter @spdex/vault build:artifacts` and commit the result. If you did not change the\n" +
        "contracts, the compiler or its settings differ from the pinned ones — which would move the addresses.",
    );
    process.exit(1);
  }
  console.log(
    `artifacts.ts and deployments.json are current (${CURRENT.id}: registry creation code ${keccak256(current.registry.bytecode)}, ` +
      `factory ${keccak256(current.factory.bytecode)}, batcher ${keccak256(current.batcher.bytecode)}); ` +
      `every frozen source still builds to what deployments.json records`,
  );
} else {
  writeFileSync(DEPLOYMENTS_FILE, deployments);
  writeFileSync(TARGET, text);
  console.log(`wrote ${DEPLOYMENTS_FILE}`);
  console.log(`wrote ${TARGET}`);
  const latest = record.releases.at(-1);
  console.log(`${latest.id}: registry ${latest.registry}, factory ${latest.factory}; batcher ${record.batchers.at(-1).batcher}`);
}
