#!/usr/bin/env node
/**
 * spDEX single verification gate.
 *
 * One command an agent can run unattended: `pnpm verify`. Exit 0 means every
 * required stage passed; exit 1 means something is wrong and the report says
 * exactly what; exit 2 means the arguments were refused and nothing ran.
 *
 * ## The skip contract
 *
 * Some stages need things an agent may not have (Foundry for fork tests, a
 * browser for e2e). Those stages SKIP rather than fail — but a skip is never
 * silent and never counts as success. It is reported as its own status, the
 * summary line names it, and `--strict` turns any skip into a failure so CI can
 * demand full coverage while a laptop need not.
 *
 * A green run that quietly skipped the integration suite would be a lie, and
 * this whole repo is built on the premise that the test output can be trusted
 * without a human reading it.
 *
 * ## Arguments
 *
 * `--strict`, `--json` and `--only=<stage>[,<stage>…]`. Listed stages run in
 * the gate's own order, not the order typed, because that order is deliberate
 * (`contracts` last). Anything else, or a stage id that doesn't exist, is
 * refused with exit 2 before any stage runs (see verify-args.mjs).
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { resolvedEnv } from "./env.mjs";
import { parseVerifyArgs } from "./verify-args.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const REPORT_DIR = join(ROOT, ".verify");
const REPORT_PATH = join(REPORT_DIR, "report.json");

/**
 * Recursively count files matching a pattern.
 *
 * Playwright with `--pass-with-no-tests` prints nothing and exits 0, so an
 * empty suite is indistinguishable from a passing one by output alone. Counting
 * spec files on disk detects it structurally instead — the same guarantee the
 * vitest stages get from parsing "No test files found".
 */
function countFiles(dir, pattern) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name), pattern);
    else if (pattern.test(entry.name)) total += 1;
  }
  return total;
}

/** Does a binary exist on PATH? Used to decide skip-vs-run, never to hide failure. */
async function hasBinary(name) {
  return new Promise((resolve) => {
    const p = spawn(process.platform === "win32" ? "where" : "which", [name], {
      stdio: "ignore",
    });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

/**
 * Stage definitions.
 *
 * `precondition` returns null to run, or a human-readable reason to skip.
 * Order matters: cheap and fast first, so an agent learns about a typo in
 * seconds rather than after a 90-second browser suite — except `contracts`,
 * which runs last so its burst of archive requests can't slow the fork-backed
 * stages (see its entry).
 */
const STAGES = [
  {
    id: "typecheck",
    description: "TypeScript at the root and in every workspace package",
    // Two commands: `pnpm -r` skips the root package, so scripts/ and the
    // config files would go unchecked and this stage would pass vacuously.
    cmds: [
      ["pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.json"],
      ["pnpm", "-r", "--if-present", "typecheck"],
    ],
  },
  {
    id: "lint",
    description: "Lint scripts, where a package defines one — none does yet, so this checks nothing",
    cmd: ["pnpm", "-r", "--if-present", "lint"],
  },
  {
    id: "unit",
    description: "Unit tests — mocked RPC, no network",
    cmd: ["pnpm", "vitest", "run", "--project", "unit", "--passWithNoTests"],
  },
  {
    id: "integration",
    description: "Fork tests against real mainnet state at the pinned block",
    cmd: ["pnpm", "vitest", "run", "--project", "integration", "--passWithNoTests"],
    async precondition() {
      return (await hasBinary("anvil"))
        ? null
        : "anvil not on PATH — install Foundry (see docs/DEVELOPMENT.md)";
    },
  },
  {
    id: "parity",
    description: "Native and QuickJS runtimes agree, fixture by fixture, for every loadable module kind",
    cmd: ["pnpm", "vitest", "run", "--project", "parity", "--passWithNoTests"],
  },
  {
    id: "conformance",
    description: "Module interface + capability-escape attempts that must fail",
    cmd: ["pnpm", "vitest", "run", "--project", "conformance", "--passWithNoTests"],
  },
  {
    id: "redteam",
    description:
      "Guard refuses malicious plans: swaps, tips, scheduled buys, budget transfers, vault transactions (a Trigger now paying anyone but the owner; a holder proof sent anywhere but the release's registry, with ether, or for the wrong block), and Help run batches paying anyone but the account",
    cmd: ["pnpm", "vitest", "run", "--project", "redteam", "--passWithNoTests"],
  },
  {
    id: "reproducible",
    description: "Two release builds produce the same IPFS address",
    cmd: ["node", "scripts/verify-reproducible.mjs"],
    // Not gated on anything: it needs no chain and no browser. The release
    // claim — that anyone can rebuild the source and check the pinned CID — is
    // only true for as long as this passes, so it is checked on every run
    // rather than at release time, when finding out is too late.
  },
  {
    id: "e2e",
    description: "Playwright + headless wallet against a fork",
    cmd: ["pnpm", "playwright", "test", "--pass-with-no-tests"],
    async precondition() {
      if (!(await hasBinary("anvil"))) return "anvil not on PATH";
      if (process.env.SPDEX_SKIP_E2E === "1") return "SPDEX_SKIP_E2E=1 set";
      return null;
    },
    isEmpty: () => countFiles(join(ROOT, "e2e"), /\.spec\.ts$/) === 0,
  },
  {
    id: "contracts",
    description:
      "The vault contracts: artifacts.ts (the registry, factory and batcher addresses) matches a fresh build, every frozen source still builds to the releases deployments.json records, deployments.json lists this build's release and batcher, and the forge fork tests pass, the SPX holder registry's real, false and fuzzed proofs included",
    // Last, after the stages that run against the shared local fork. The forge
    // tests fork mainnet from the archive endpoint themselves, every test its
    // own fork, and the local fork fetches any state it hasn't seen from that
    // same endpoint. Run a few seconds before e2e, the burst left the endpoint
    // throttling, and the fork's first cold fetch afterwards waited about 30
    // seconds on its retries: e2e's first swap test took a full minute, a hair
    // inside its timeout (measured: a fresh account's first read took 30,069
    // ms right after this stage, and 51 ms otherwise).
    //
    // Freshness first: it is the cheap check, and a stale artifacts.ts means
    // the factory address the app ships is not the one the source builds to.
    // The forge tests fork mainnet at the pinned block from the archive
    // endpoint themselves; forge.mjs hands them the repo's .env files.
    //
    // One suite at a time (`-j 1`). In parallel, 15 suites forking at once hit
    // a free-tier endpoint's rate limit, and a 429 fails a test with no
    // assertion broken — 4 of 111 in one run. The tests wait on the endpoint,
    // not the CPU, so serial is no slower: 113 passed in 93 s, against 110 s
    // for the parallel run that failed.
    cmds: [
      ["node", "packages/vault/scripts/build-artifacts.mjs", "--check"],
      ["node", "packages/vault/scripts/forge.mjs", "test", "-j", "1"],
    ],
    async precondition() {
      if (!(await hasBinary("forge"))) return "forge not on PATH — install Foundry (see docs/DEVELOPMENT.md)";
      if (!resolvedEnv().SPDEX_FORK_RPC_URL) {
        return "SPDEX_FORK_RPC_URL is not set — the forge tests fork mainnet from an archive endpoint (see docs/DEVELOPMENT.md)";
      }
      return null;
    },
  },
];

const parsed = parseVerifyArgs(process.argv.slice(2), STAGES.map((s) => s.id));
const STRICT = parsed.strict;
const JSON_ONLY = parsed.json;

if (!parsed.ok) {
  // Refused before anything runs. The report is still written, as a failure:
  // an agent told to read .verify/report.json rather than stdout would
  // otherwise find the previous run's report and take it for this one's.
  const now = new Date().toISOString();
  const report = {
    schema: "spdex.verify/1",
    ok: false,
    strict: STRICT,
    startedAt: now,
    finishedAt: now,
    error: parsed.error,
    totals: { passed: 0, failed: 0, skipped: 0, empty: 0 },
    forkBlock: process.env.SPDEX_FORK_BLOCK ?? null,
    stages: [],
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (JSON_ONLY) console.log(JSON.stringify(report, null, 2));
  console.error(`\x1b[31mVERIFY REFUSED\x1b[0m  nothing ran.\n${parsed.error}`);
  process.exit(2);
}

const only = parsed.only === null ? null : new Set(parsed.only);

function run(cmd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, shell: false });
    let output = "";
    const capture = (d) => {
      const s = d.toString();
      output += s;
      if (!JSON_ONLY) process.stdout.write(s);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (err) => {
      resolve({ code: 127, output: `${output}\n${err.message}`, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output, ms: Date.now() - started });
    });
  });
}

const log = (s) => {
  if (!JSON_ONLY) console.log(s);
};

const results = [];
const startedAt = new Date().toISOString();

for (const stage of STAGES) {
  if (only && !only.has(stage.id)) continue;

  const skipReason = stage.precondition ? await stage.precondition() : null;
  if (skipReason) {
    log(`\n\x1b[33m⊘ ${stage.id}\x1b[0m — SKIPPED: ${skipReason}`);
    results.push({
      id: stage.id,
      description: stage.description,
      status: "skipped",
      reason: skipReason,
      ms: 0,
    });
    continue;
  }

  log(`\n\x1b[36m▶ ${stage.id}\x1b[0m — ${stage.description}`);
  const commands = stage.cmds ?? [stage.cmd];
  let code = 0;
  let output = "";
  let ms = 0;
  for (const command of commands) {
    const r = await run(command);
    output += r.output;
    ms += r.ms;
    code = r.code;
    if (code !== 0) break; // first failure is the informative one
  }
  // A suite that matched zero test files must never read the same as one that
  // ran and passed. `--passWithNoTests` keeps stages green before their phase
  // lands, which is convenient and, left unlabelled, a lie — `redteam` above
  // all, whose entire purpose is to fail loudly.
  const ranNothing =
    /No tests? (?:files? )?found/i.test(output) || (stage.isEmpty?.() ?? false);
  const status = code !== 0 ? "failed" : ranNothing ? "empty" : "passed";
  log(
    status === "passed"
      ? `\x1b[32m✓ ${stage.id}\x1b[0m (${ms}ms)`
      : status === "empty"
        ? `\x1b[33m○ ${stage.id}\x1b[0m — ran, but contains no tests yet (${ms}ms)`
        : `\x1b[31m✗ ${stage.id}\x1b[0m exit ${code} (${ms}ms)`,
  );
  results.push({
    id: stage.id,
    description: stage.description,
    status,
    exitCode: code,
    ms,
    ...(status === "empty" ? { reason: "no test files matched this project" } : {}),
    // Tail only: enough for an agent to diagnose without a multi-megabyte report.
    outputTail: output.split("\n").slice(-60).join("\n"),
  });
}

const failed = results.filter((r) => r.status === "failed");
const skipped = results.filter((r) => r.status === "skipped");
const empty = results.filter((r) => r.status === "empty");
const passed = results.filter((r) => r.status === "passed");
// --strict refuses to call a partially-executed run green: neither a skipped
// stage nor one that contained no tests counts as coverage.
//
// A run with no stage in it is never green, whatever the arguments said. The
// parser refuses every --only that could select nothing, so this cannot happen
// today; it is here so a future change to the parsing can't bring back a
// VERIFY OK that checked nothing.
const ok =
  results.length > 0 &&
  failed.length === 0 &&
  (!STRICT || (skipped.length === 0 && empty.length === 0));

const report = {
  schema: "spdex.verify/1",
  ok,
  strict: STRICT,
  startedAt,
  finishedAt: new Date().toISOString(),
  totals: {
    passed: passed.length,
    failed: failed.length,
    skipped: skipped.length,
    empty: empty.length,
  },
  forkBlock: process.env.SPDEX_FORK_BLOCK ?? null,
  stages: results,
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log(
    `\n${ok ? "\x1b[32mVERIFY OK\x1b[0m" : "\x1b[31mVERIFY FAILED\x1b[0m"}  ` +
      `${passed.length} passed · ${failed.length} failed · ${skipped.length} skipped · ` +
      `${empty.length} empty`,
  );
  if (empty.length > 0) {
    log(
      `\x1b[33mEmpty stages\x1b[0m (ran, zero tests): ${empty.map((s) => s.id).join(", ")}. ` +
        `These prove nothing until their phase lands.`,
    );
  }
  if (skipped.length > 0) {
    log(
      `\x1b[33mNot everything ran.\x1b[0m Skipped: ${skipped.map((s) => s.id).join(", ")}. ` +
        `Use --strict to treat skips as failures.`,
    );
  }
  log(`Report: ${REPORT_PATH}`);
}

process.exit(ok ? 0 : 1);
