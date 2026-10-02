#!/usr/bin/env node
/**
 * Generate `src/artifacts.ts` from forge's build output — or, with `--check`,
 * rebuild and fail if the committed file is stale.
 *
 * ## Why the artifacts are committed at all
 *
 * The app must not need Foundry to build, so the ABIs and the factory's
 * creation code live in TypeScript. But a hand-maintained copy is exactly the
 * kind of thing that drifts: an ABI that no longer matches the contract
 * decodes garbage, and creation code that no longer matches the source means
 * the factory address the app trusts is not the one anybody can rebuild. So
 * the file is generated, and `--check` — part of the verify gate's
 * `contracts` stage — recompiles from source and refuses a committed copy
 * that differs by a byte. The same spirit as `verify-reproducible.mjs`: a
 * published address is only worth something while anyone can check it.
 *
 * ## What is in it
 *
 * The three ABIs `as const` (viem infers every argument and result type from
 * them), the factory's and the batcher's creation code, the deterministic
 * deployer, the salts, mainnet's deployment — WETH, Uniswap's two factories
 * and the market list, the factory's constructor arguments — with
 * `factoryAddress(deployment)` and `batcherAddress(factory)` and the addresses
 * they give, the registry of releases (`DEPLOYMENTS`), and the limits, parsed
 * from the Solidity constants so the UI's numbers cannot disagree with the
 * contracts'.
 *
 * ## The registry: `deployments.json`
 *
 * Every release of the contracts that ever reached mainnet stays listed, oldest
 * first, so that keepers and reports go on serving the vaults of every one of
 * them. An entry is frozen once its `factoryBlock` is filled in, by hand, after
 * the deployment; that is the only hand edit ever made to an entry, and no
 * entry is ever removed. The trailing entry, while it has no block, is the
 * release being built: writing rewrites it to this build's addresses, and when
 * the trailing entry is frozen and this build differs from it, writing appends
 * the next one. `--check` refuses a registry that does not end with this build.
 *
 *   node packages/vault/scripts/build-artifacts.mjs          # write
 *   node packages/vault/scripts/build-artifacts.mjs --check  # verify
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, encodeAbiParameters, getContractAddress, keccak256, toBytes } from "viem";
import { SOLC_VERSION, solcArgs } from "./solc.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PACKAGE_ROOT, "out");
const TARGET = join(PACKAGE_ROOT, "src", "artifacts.ts");
const REGISTRY = join(PACKAGE_ROOT, "deployments.json");
const CHECK = process.argv.includes("--check");

/** The standard deterministic deployer (Arachnid's), at the same address on every EVM chain that has it. */
const DETERMINISTIC_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
/** Derived rather than arbitrary, so a reader can recompute it. The forge tests use the same derivation. */
const SALT_PREIMAGE = "spdex.vault.factory.v1";
const FACTORY_SALT = keccak256(toBytes(SALT_PREIMAGE));
/** The batcher's, derived the same way. A batcher bound to another factory is another address all the same. */
const BATCHER_SALT_PREIMAGE = "spdex.vault.batcher.v1";
const BATCHER_SALT = keccak256(toBytes(BATCHER_SALT_PREIMAGE));
/**
 * Mainnet's deployment: the factory's constructor arguments. The market list is
 * what the phase-5a reviews led to — exactly WETH to SPX, on SPX's
 * Uniswap v2 pair, floored by its 0.3% v3 pool — and another list is another
 * factory. The local fork is mainnet, so it is the fork's too. The factory
 * address for these arguments is written out as a literal, for docs and greps.
 */
const MAINNET_DEPLOYMENT = {
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

/** The factory's constructor, as ABI parameters: (weth, uniswapV2Factory, uniswapV3Factory, markets). */
const CONSTRUCTOR_PARAMETERS = [
  { type: "address" },
  { type: "address" },
  { type: "address" },
  {
    type: "tuple[]",
    components: [
      { name: "tokenOut", type: "address" },
      { name: "pair", type: "address" },
      { name: "oraclePool", type: "address" },
    ],
  },
];
const constructorArgs = (d) => [d.weth, d.uniswapV2Factory, d.uniswapV3Factory, d.markets];

function forgeBuild() {
  // `--skip test`: what ships is the two contracts and their libraries. The
  // settings that make the bytecode reproducible are in foundry.toml.
  // `--force`: compile from source every time rather than trust forge's cache.
  // A check that can be answered from a cache is not a check — and another
  // forge command (`forge lint`, for one) can leave artifacts in `out/` that
  // have an ABI but no bytecode.
  const result = spawnSync("forge", ["build", "--force", "--skip", "test", "--skip", "script", ...solcArgs()], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`forge could not start: ${result.error.message} (is Foundry installed?)`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`forge build failed with exit code ${result.status}`);
  }
}

function artifact(name) {
  const json = JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), "utf8"));
  const bytecode = json.bytecode?.object;
  if (!Array.isArray(json.abi) || typeof bytecode !== "string" || !/^0x[0-9a-f]+$/i.test(bytecode)) {
    throw new Error(`${name}: forge output has no ABI or bytecode`);
  }
  // The pinned compiler or nothing: bytes from any other build would move the
  // factory's address, and writing them would publish that move.
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

/** Every `uint256 public constant` in a contract source file, evaluated; refuses if one expected is missing. */
function constants(file, expected) {
  const source = readFileSync(join(PACKAGE_ROOT, "contracts", file), "utf8");
  const found = {};
  for (const [, name, literal] of source.matchAll(/uint256\s+public\s+constant\s+([A-Z_]+)\s*=\s*([^;]+);/g)) {
    found[name] = evaluate(name, literal);
  }
  for (const name of expected) if (!(name in found)) throw new Error(`${file} has no public constant ${name}`);
  return found;
}

function limits() {
  return constants("VaultLimits.sol", [
    "MAX_FUNDING",
    "MIN_INTERVAL",
    "MAX_INTERVAL",
    "MAX_SLIPPAGE_BPS",
    "MAX_REWARD_BPS",
    "TWAP_WINDOW",
    "MIN_ORACLE_DEPTH",
    "MIN_OBSERVATIONS",
    "MAX_BUYS",
    "MAX_START_DRIFT",
  ]);
}

const lines = (object) =>
  Object.entries(object)
    .map(([name, value]) => `  ${name}: ${value}n,`)
    .join("\n");

// ─── The registry ────────────────────────────────────────────────────────────

const ENTRY_KEYS = ["id", "factory", "batcher", "factoryBlock", "batcherBlock"];
const isBlock = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);

/** The committed registry, checked entry by entry; `[]` when there is none yet. */
function readRegistry() {
  if (!existsSync(REGISTRY)) return [];
  const list = JSON.parse(readFileSync(REGISTRY, "utf8"));
  if (!Array.isArray(list)) throw new Error("deployments.json: not an array");
  list.forEach((entry, i) => {
    const where = `deployments.json entry ${i}`;
    if (typeof entry !== "object" || entry === null || Object.keys(entry).join() !== ENTRY_KEYS.join()) {
      throw new Error(`${where}: expected exactly ${ENTRY_KEYS.join(", ")}, in that order`);
    }
    // Ids run v1, v2, … with no gap: a gap is an entry someone removed.
    if (entry.id !== `v${i + 1}`) throw new Error(`${where}: id is ${JSON.stringify(entry.id)}, not "v${i + 1}"`);
    for (const key of ["factory", "batcher"]) {
      if (typeof entry[key] !== "string" || !/^0x[0-9a-f]{40}$/.test(entry[key])) {
        throw new Error(`${where}: ${key} is not a lowercase address`);
      }
    }
    if (!isBlock(entry.factoryBlock) || !isBlock(entry.batcherBlock)) {
      throw new Error(`${where}: a block is a non-negative integer, or null before the deployment`);
    }
    // A batcher's constructor reads its factory, so it cannot be deployed first.
    if (entry.factoryBlock === null && entry.batcherBlock !== null) {
      throw new Error(`${where}: has a batcherBlock but no factoryBlock`);
    }
    // Only the release being built can be undeployed; every one before it reached mainnet.
    if (entry.factoryBlock === null && i !== list.length - 1) {
      throw new Error(`${where}: only the last entry may be undeployed (factoryBlock null)`);
    }
  });
  return list;
}

/**
 * The registry once this build is its last entry: the trailing entry rewritten
 * while it is undeployed, else left alone when it is this build already, else
 * the next entry appended. Frozen entries are never touched.
 */
function withThisBuild(list, factory, batcher) {
  const last = list.at(-1);
  const entry = (id) => ({ id, factory, batcher, factoryBlock: null, batcherBlock: null });
  if (last === undefined) return [entry("v1")];
  if (last.factoryBlock === null) return [...list.slice(0, -1), entry(last.id)];
  if (last.factory === factory && last.batcher === batcher) return list;
  return [...list, entry(`v${list.length + 1}`)];
}

const renderRegistry = (list) => `${JSON.stringify(list, null, 2)}\n`;
const tsBlock = (block) => (block === null ? "null" : `${block}n`);

function render(registry) {
  const factory = artifact("SpdexVaultFactory");
  const vault = artifact("SpdexDcaVault");
  const batcher = artifact("SpdexVaultBatcher");
  const mainnetFactory = getContractAddress({
    opcode: "CREATE2",
    from: DETERMINISTIC_DEPLOYER,
    salt: FACTORY_SALT,
    bytecode: concat([factory.bytecode, encodeAbiParameters(CONSTRUCTOR_PARAMETERS, constructorArgs(MAINNET_DEPLOYMENT))]),
  }).toLowerCase();
  // The implementation is the factory's first creation: CREATE from it at nonce 1.
  const mainnetImplementation = getContractAddress({ opcode: "CREATE", from: mainnetFactory, nonce: 1n }).toLowerCase();
  const mainnetBatcher = getContractAddress({
    opcode: "CREATE2",
    from: DETERMINISTIC_DEPLOYER,
    salt: BATCHER_SALT,
    bytecode: concat([batcher.bytecode, encodeAbiParameters([{ type: "address" }], [mainnetFactory])]),
  }).toLowerCase();
  const deployments = withThisBuild(registry, mainnetFactory, mainnetBatcher);
  const deploymentLines = deployments
    .map(
      (d) =>
        `  {\n    id: "${d.id}",\n    factory: "${d.factory}",\n    batcher: "${d.batcher}",\n    factoryBlock: ${tsBlock(d.factoryBlock)},\n    batcherBlock: ${tsBlock(d.batcherBlock)},\n  },`,
    )
    .join("\n");
  const factoryLimits = constants("SpdexVaultFactory.sol", ["MAX_MARKET_GAP_BPS"]);
  const batcherLimits = constants("SpdexVaultBatcher.sol", ["EXECUTE_GAS_CAP", "MAX_VAULTS", "MIN_GAS_PER_ATTEMPT"]);
  const marketLines = MAINNET_DEPLOYMENT.markets
    .map(
      (m) =>
        `    {\n      tokenOut: "${m.tokenOut}",\n      pair: "${m.pair}",\n      oraclePool: "${m.oraclePool}",\n    },`,
    )
    .join("\n");

  const text = `// GENERATED by packages/vault/scripts/build-artifacts.mjs from forge's output. Do not edit.
//
//   regenerate: pnpm --filter @spdex/vault build:artifacts
//   check:      pnpm --filter @spdex/vault check:artifacts  (the verify gate's \`contracts\` stage)
//
// Built by solc ${factory.compiler ?? "(version not reported)"} with the settings in
// packages/vault/foundry.toml: optimizer 200 runs, EVM cancun, no metadata hash and no
// CBOR trailer, so the bytes below are reproducible from source on any machine.

import { concat, encodeAbiParameters, getContractAddress } from "viem";

export const VAULT_ABI = ${JSON.stringify(vault.abi, null, 2)} as const;

export const FACTORY_ABI = ${JSON.stringify(factory.abi, null, 2)} as const;

export const BATCHER_ABI = ${JSON.stringify(batcher.abi, null, 2)} as const;

/** SpdexVaultFactory's creation code, without constructor arguments. */
export const FACTORY_CREATION_CODE =
  "${factory.bytecode}" as const;

/** keccak256 of the creation code above: a short fingerprint to compare builds by. */
export const FACTORY_CREATION_CODE_HASH = "${keccak256(factory.bytecode)}" as const;

/** The standard deterministic deployer. Deploys \`initCode\` at CREATE2(itself, salt, initCode) for anyone. */
export const DETERMINISTIC_DEPLOYER = "${DETERMINISTIC_DEPLOYER}" as const;

/** keccak256("${SALT_PREIMAGE}"). */
export const FACTORY_SALT = "${FACTORY_SALT}" as const;

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
  markets: readonly Market[];
}

/**
 * Mainnet's factory, and the local fork's: WETH to SPX, on SPX's Uniswap v2 pair,
 * floored by its 0.3% v3 pool. The only list there is; another is another factory.
 */
export const MAINNET_DEPLOYMENT = {
  weth: "${MAINNET_DEPLOYMENT.weth}",
  uniswapV2Factory: "${MAINNET_DEPLOYMENT.uniswapV2Factory}",
  uniswapV3Factory: "${MAINNET_DEPLOYMENT.uniswapV3Factory}",
  markets: [
${marketLines}
  ],
} as const satisfies FactoryDeployment;

const CONSTRUCTOR_PARAMETERS = ${JSON.stringify(CONSTRUCTOR_PARAMETERS)} as const;

/** The factory's init code for a deployment: creation code plus the constructor's arguments. */
export function factoryInitCode(deployment: FactoryDeployment): \`0x\${string}\` {
  return concat([
    FACTORY_CREATION_CODE,
    encodeAbiParameters(CONSTRUCTOR_PARAMETERS, [
      deployment.weth,
      deployment.uniswapV2Factory,
      deployment.uniswapV3Factory,
      deployment.markets,
    ]),
  ]);
}

/**
 * Where the factory for \`deployment\` lives, on any chain with the deterministic
 * deployer: a pure function of this bytecode — the vault's included — and its
 * constructor's arguments, the market list among them. Lowercase, like every
 * address spDEX compares.
 */
export function factoryAddress(deployment: FactoryDeployment): \`0x\${string}\` {
  return getContractAddress({
    opcode: "CREATE2",
    from: DETERMINISTIC_DEPLOYER,
    salt: FACTORY_SALT,
    bytecode: factoryInitCode(deployment),
  }).toLowerCase() as \`0x\${string}\`;
}

/** factoryAddress(MAINNET_DEPLOYMENT), written out. A unit test holds the two to agreement. */
export const MAINNET_FACTORY = "${mainnetFactory}" as const;

/** The implementation every mainnet vault is a clone of: the factory's first creation. */
export const MAINNET_IMPLEMENTATION = "${mainnetImplementation}" as const;

/** SpdexVaultFactory's own public constants, parsed from its source. */
export const FACTORY_LIMITS = {
${lines(factoryLimits)}
} as const;

/** The limits every vault is held to (contracts/VaultLimits.sol, which both contracts inherit), parsed from its source. */
export const VAULT_LIMITS = {
${lines(limits())}
} as const;

/** SpdexVaultBatcher's creation code, without its constructor's argument (the factory). */
export const BATCHER_CREATION_CODE =
  "${batcher.bytecode}" as const;

/** keccak256 of the batcher's creation code above. */
export const BATCHER_CREATION_CODE_HASH = "${keccak256(batcher.bytecode)}" as const;

/** keccak256("${BATCHER_SALT_PREIMAGE}"). */
export const BATCHER_SALT = "${BATCHER_SALT}" as const;

/** The batcher's init code for the factory it is bound to: creation code plus that factory's address. */
export function batcherInitCode(factory: \`0x\${string}\`): \`0x\${string}\` {
  return concat([BATCHER_CREATION_CODE, encodeAbiParameters([{ type: "address" }], [factory])]);
}

/**
 * Where the batcher bound to \`factory\` lives, on any chain with the deterministic
 * deployer: a pure function of this bytecode and the factory. Lowercase. Its
 * constructor reads the factory, so it can only be deployed after it.
 */
export function batcherAddress(factory: \`0x\${string}\`): \`0x\${string}\` {
  return getContractAddress({
    opcode: "CREATE2",
    from: DETERMINISTIC_DEPLOYER,
    salt: BATCHER_SALT,
    bytecode: batcherInitCode(factory),
  }).toLowerCase() as \`0x\${string}\`;
}

/** batcherAddress(MAINNET_FACTORY), written out. A unit test holds the two to agreement. */
export const MAINNET_BATCHER = "${mainnetBatcher}" as const;

/** SpdexVaultBatcher's own public constants, parsed from its source. */
export const BATCHER_LIMITS = {
${lines(batcherLimits)}
} as const;

/** One release of the contracts: a factory, the batcher bound to it, and the blocks they were deployed in. */
export interface Deployment {
  /** "v1", "v2", …: its place in the registry, oldest first. */
  id: string;
  factory: \`0x\${string}\`;
  batcher: \`0x\${string}\`;
  /** The block the factory was deployed in on mainnet; null while this release is not deployed. */
  factoryBlock: bigint | null;
  /** The block the batcher was deployed in on mainnet; null until then. */
  batcherBlock: bigint | null;
}

/**
 * Every release, oldest first, from packages/vault/deployments.json. It never
 * shrinks: keepers and reports serve the vaults of every release that reached
 * mainnet. The last entry is this build (\`MAINNET_FACTORY\`, \`MAINNET_BATCHER\`).
 */
export const DEPLOYMENTS: readonly Deployment[] = [
${deploymentLines}
];
`;
  return { text, registry: renderRegistry(deployments) };
}

forgeBuild();
const committedRegistry = readRegistry();
const { text, registry } = render(committedRegistry);

if (CHECK) {
  const committed = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // Missing counts as stale.
      return "";
    }
  };
  if (committed(REGISTRY) !== registry) {
    console.error(
      "packages/vault/deployments.json does not end with this build: its last entry is not the factory and\n" +
        "batcher the contracts compile to now. Run `pnpm --filter @spdex/vault build:artifacts` and commit the\n" +
        "result. Never edit or remove an entry that has a block: that release reached mainnet.",
    );
    process.exit(1);
  }
  if (committed(TARGET) !== text) {
    console.error(
      "packages/vault/src/artifacts.ts is stale: it does not match what the contracts compile to now.\n" +
        "Run `pnpm --filter @spdex/vault build:artifacts` and commit the result. If you did not change the\n" +
        "contracts, the compiler or its settings differ from the pinned ones — which would move the factory's address.",
    );
    process.exit(1);
  }
  console.log(
    `artifacts.ts and deployments.json are current (factory creation code ${keccak256(artifact("SpdexVaultFactory").bytecode)}, ` +
      `batcher creation code ${keccak256(artifact("SpdexVaultBatcher").bytecode)})`,
  );
} else {
  writeFileSync(REGISTRY, registry);
  writeFileSync(TARGET, text);
  console.log(`wrote ${REGISTRY}`);
  console.log(`wrote ${TARGET}`);
}
