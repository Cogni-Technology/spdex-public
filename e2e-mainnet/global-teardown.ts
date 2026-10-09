/**
 * After the last spec, pass or fail: settle what was mined, and say what the
 * run cost, transaction by transaction, and what each agent holds now. Also
 * written to `.mainnet-smoke/runs/<id>.summary.json`.
 *
 * Nothing here signs: a vault a failed spec left open is listed, and its
 * spec's own clean-up is what closes it (or `pnpm mainnet:smoke:sweep`).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readVault } from "../packages/vault/src/index.js";
import { runRecord } from "./budget.js";
import { FACTORIES, ethBalance, rpc } from "./chain.js";
import { AGENT_NAMES, RUNS_DIR, currentRun, eth } from "./settings.js";
import { agentVaults, settleMined } from "./wallet.js";

export default async function globalTeardown(): Promise<void> {
  let run;
  try {
    run = currentRun();
  } catch {
    return; // The global setup refused the run: nothing was sent.
  }
  const { unmined } = await settleMined(run.mode === "fork" ? 0 : 120_000);
  const record = runRecord(run);

  const rows = record.map((tx) => ({
    what: tx.what,
    wallet: tx.wallet,
    hash: tx.hash,
    status: tx.settled ? tx.settled.status : "not mined",
    gasUsed: tx.settled ? Number(tx.settled.gasUsed) : null,
    costEth: eth(BigInt(tx.settled ? tx.settled.cost : tx.maxCost)),
    networkFeeEth: tx.settled ? eth(BigInt(tx.settled.cost) - (tx.settled.status === "success" ? BigInt(tx.value) : 0n)) : null,
  }));
  const spent = record.reduce((sum, tx) => sum + BigInt(tx.settled ? tx.settled.cost : tx.maxCost), 0n);
  const networkFees = record.reduce(
    (sum, tx) => sum + (tx.settled ? BigInt(tx.settled.cost) - (tx.settled.status === "success" ? BigInt(tx.value) : 0n) : 0n),
    0n,
  );
  const gasUsed = record.reduce((sum, tx) => sum + (tx.settled ? BigInt(tx.settled.gasUsed) : 0n), 0n);

  const balances = Object.fromEntries(
    await Promise.all(
      AGENT_NAMES.map(async (name) => {
        const now = await ethBalance(run.agents[name].address);
        return [name, { start: eth(BigInt(run.startBalances[name])), now: eth(now), change: eth(now - BigInt(run.startBalances[name])) }] as const;
      }),
    ),
  );

  const open: string[] = [];
  try {
    // Every release's factory: an earlier run's v1 vault left open is listed too.
    for (const vault of await agentVaults()) {
      const state = await readVault(rpc, vault, { factories: FACTORIES });
      // Every buy made and nothing left is finished, not open.
      if (state !== null && !state.closed && state.status.wethBalance !== 0n) open.push(vault);
    }
  } catch (error) {
    // The summary is still worth having; what couldn't be checked says so.
    open.push(`unknown (${(error as Error).message})`);
  }

  const summary = { run: run.id, mode: run.mode, transactions: rows, gasUsed: gasUsed.toString(), networkFeesEth: eth(networkFees), sentOutEth: eth(spent), balances, unmined, openVaults: open };
  writeFileSync(join(RUNS_DIR, `${run.id}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);

  const width = Math.max(...rows.map((r) => r.what.length), 4);
  console.log(
    [
      "",
      `spDEX mainnet smoke ${run.id}: ${rows.length} transactions, ${gasUsed} gas, ${eth(networkFees)} ETH in network fees`,
      ...rows.map((r) => `  ${r.what.padEnd(width)}  ${r.wallet.padEnd(6)}  ${r.status.padEnd(9)}  ${String(r.gasUsed ?? "").padStart(8)} gas  ${r.networkFeeEth ?? `up to ${r.costEth}`} ETH fee  ${r.hash}`),
      ...AGENT_NAMES.map((name) => `  ${name.padEnd(7)} ${balances[name]!.start} → ${balances[name]!.now} ETH (${balances[name]!.change})`),
      ...(unmined.length > 0 ? [`  NOT MINED: ${unmined.join(", ")}`] : []),
      ...(open.length > 0 ? [`  STILL OPEN: ${open.join(", ")} (the next run closes it, or pnpm mainnet:smoke:sweep)`] : []),
      `  ${join(RUNS_DIR, `${run.id}.summary.json`)}`,
    ].join("\n"),
  );
}
