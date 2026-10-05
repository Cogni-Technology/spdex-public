/**
 * Running the keeper from a spec: the package's own `keeperTick`, what
 * `pnpm keeper` runs, from the keeper agent's key, tick after tick until the
 * spec has what it waited for.
 *
 * The keeper signs for itself, so the harness can't price or check its
 * transactions before signing, as it does the page's. Each tick is bounded
 * from outside instead: room in the budget for one batch at the highest price
 * the policy lets it bid, a send hook that lets one transaction out a tick,
 * and `maxSends` in the run, and refuses any other, and the keeper's own rule
 * (`assertKeeperMaySign`) that it signs nothing but a batch to a listed
 * batcher (proving is off: `SPDEX_KEEPER_PROVE` is never set here, and the
 * holder agent is proven by `3-prove`). Each transaction is recorded in the
 * budget from its signed bytes before it leaves, and settled at its real cost
 * once mined.
 *
 * The keeper's `rewardTo` is the holder agent, a community keeper, so it
 * makes v2 buys inside their community window at once; one that weren't
 * would wait each window out (`holders-first`).
 *
 * On a fork, and only there, a block is mined before each tick: an idle fork
 * makes no blocks, so its time stands still and no later buy would ever fall
 * due. Ethereum makes one every 12 seconds by itself. The fork is this run's
 * own (`pnpm mainnet:smoke:fork`), never the gate's shared one.
 */

import { transactionHash } from "../packages/chain/src/index.js";
import { batchGasLimit } from "../packages/vault/src/index.js";
import { keeperConfig, keeperTick, newKeeperState, type KeeperTickResult } from "../packages/vault/src/keeper.js";
import { assertRoom, reserve } from "./budget.js";
import { rpc, settings } from "./chain.js";
import { currentRun, feeRateCap } from "./settings.js";
import { MINED_WITHIN_MS, agents, settleMined } from "./wallet.js";

type Hex = `0x${string}`;
type Mined = KeeperTickResult["mined"][number];

const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

export interface KeeperRun {
  /** Every batch mined, in order. */
  mined: Mined[];
  /** Every tick's result, for a failure's message. */
  ticks: KeeperTickResult[];
}

/**
 * Tick the keeper over `vaults` until `done()` says so, or `timeoutMs` passes
 * (then it throws, with what the last ticks said). Fees go to `rewardTo`, as
 * `SPDEX_KEEPER_REWARD_TO` sends them. `what` names the batches in the
 * budget's record.
 */
export async function runKeeper(input: {
  vaults: Hex[];
  rewardTo: Hex;
  done: (run: KeeperRun) => Promise<boolean>;
  timeoutMs: number;
  what: string;
  /** The most transactions the keeper may send in this run, all ticks together. */
  maxSends: number;
  /** Milliseconds between ticks; 15 s by default, a little more than a block. */
  everyMs?: number;
}): Promise<KeeperRun> {
  const { keeper } = agents();
  const fork = currentRun().mode === "fork";
  const rate = feeRateCap(settings);
  const subsidy = settings.keeperSubsidyWei;
  const config = keeperConfig({
    chainId: 1,
    keeperKey: keeper.key,
    rewardTo: input.rewardTo,
    vaults: input.vaults,
    policy: {
      sendWhen: "now",
      confirmations: 1,
      // A fork's head is as old as its last block.
      ...(fork ? { maxHeadLagSeconds: 0n } : {}),
      tip: settings.tipWei,
      urgentTip: settings.tipWei,
      maxTip: settings.tipWei,
      maxFeePerGas: rate,
      maxVaultsPerBatch: input.vaults.length,
      maxLossPerBuy: subsidy,
      maxLossPerDay: subsidy * BigInt(input.maxSends),
      maxLossPerVaultPerDay: subsidy * BigInt(input.maxSends),
      maxSubsidyPerOwnerPerDay: subsidy * BigInt(input.maxSends),
      subsidyMinBuy: 0n,
      subsidyMinInterval: 0n,
    },
  });
  const state = newKeeperState({ chainId: 1, keeper: keeper.address });
  const run: KeeperRun = { mined: [], ticks: [] };
  const worst = batchGasLimit(input.vaults.map(() => ({ firstBuy: true }))) * rate;
  const until = Date.now() + input.timeoutMs;
  let sends = 0;
  let outages = 0;

  for (;;) {
    try {
      if (await input.done(run)) return run;
      if (fork) await rpc("evm_mine", []);
      assertRoom(settings, worst, input.what);
      let sentThisTick = 0;
      const sendRpc = async (method: string, params: unknown[]) => {
        if (method === "eth_sendRawTransaction") {
          if (sentThisTick > 0) throw new Error("the keeper tried a second send in one tick; this suite lets one out");
          if (sends >= input.maxSends) throw new Error(`the keeper tried send ${sends + 1}; this run lets ${input.maxSends} out`);
          const raw = String(params[0]);
          const tx = readSigned(raw);
          const maxCost = tx.value + tx.gas * tx.maxFeePerGas;
          assertRoom(settings, maxCost, input.what);
          // Recorded before it leaves, as everything the agents sign is.
          reserve(settings, {
            what: input.what,
            wallet: keeper.name,
            hash: transactionHash(raw).toLowerCase(),
            to: tx.to,
            value: tx.value.toString(),
            maxCost: maxCost.toString(),
          });
          sends += 1;
          sentThisTick += 1;
        }
        return rpc(method, params);
      };
      const tick = await keeperTick(rpc, { config, state, sendRpc, waitForReceiptMs: MINED_WITHIN_MS() });
      run.ticks.push(tick);
      run.mined.push(...tick.mined);
      await settleMined(sentThisTick > 0 ? MINED_WITHIN_MS() : 0);
    } catch (error) {
      // A connection lost for longer than rpc.ts retries (about 30 s) ends
      // a tick, not the run: the next tick picks up whatever this one sent,
      // as `pnpm keeper`'s does. Anything else is a failure.
      if (!/still failing after \d+ tries/.test((error as Error).message)) throw error;
      outages += 1;
    }
    if (Date.now() > until) {
      const last = run.ticks.slice(-3).map((t) => ({ sent: t.sent, skipped: t.skipped, waiting: t.waiting, upcoming: t.upcoming }));
      throw new Error(`the keeper didn't finish within ${Math.round(input.timeoutMs / 60_000)} min (${outages} ticks lost to the connection); last ticks: ${json(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, input.everyMs ?? 15_000));
  }
}

/** What the budget needs from a signed EIP-1559 transaction, read from its bytes before it is sent. */
export function readSigned(raw: string): { to: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint } {
  const bytes = Buffer.from(raw.slice(2), "hex");
  if (bytes[0] !== 0x02) throw new Error(`the keeper signed a transaction of type ${bytes[0]}; this suite reads EIP-1559 ones only`);
  // [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList, yParity, r, s]
  const fields = rlpItems(bytes, 1);
  if (fields.length !== 12 || fields[5]!.length !== 20) throw new Error("the keeper's transaction doesn't read as EIP-1559");
  const int = (field: Buffer) => (field.length === 0 ? 0n : BigInt(`0x${field.toString("hex")}`));
  return { maxFeePerGas: int(fields[3]!), gas: int(fields[4]!), to: `0x${fields[5]!.toString("hex")}` as Hex, value: int(fields[6]!) };
}

/** The items of the RLP list that starts at `at`: each string's bytes, or a nested list's body. */
function rlpItems(bytes: Buffer, at: number): Buffer[] {
  const read = (i: number) => {
    const prefix = bytes[i]!;
    const length = (n: number) => Number(BigInt(`0x${bytes.subarray(i + 1, i + 1 + n).toString("hex")}`));
    if (prefix < 0x80) return { start: i, end: i + 1 };
    if (prefix < 0xb8) return { start: i + 1, end: i + 1 + prefix - 0x80 };
    if (prefix < 0xc0) return { start: i + 1 + prefix - 0xb7, end: i + 1 + prefix - 0xb7 + length(prefix - 0xb7) };
    if (prefix < 0xf8) return { start: i + 1, end: i + 1 + prefix - 0xc0 };
    return { start: i + 1 + prefix - 0xf7, end: i + 1 + prefix - 0xf7 + length(prefix - 0xf7) };
  };
  const list = read(at);
  const items: Buffer[] = [];
  for (let i = list.start; i < list.end; ) {
    const item = read(i);
    items.push(bytes.subarray(item.start, item.end));
    i = item.end;
  }
  return items;
}
