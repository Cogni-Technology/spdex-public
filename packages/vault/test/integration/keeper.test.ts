/**
 * The keeper on the local fork: real vaults, a real batcher, real batches.
 *
 * The unit tests (`src/keeper*.test.ts`) pin each decision against scripted
 * endpoints. This proves the pieces agree with deployed bytes and a real
 * node: that one tick finds due vaults on the allowlist, reads them, prices a
 * batch, simulates it, signs it through the nonce manager and processes its
 * receipt — every fee landing at `rewardTo`, nothing left in the batcher; that
 * a vault not yet due, a block not cheap enough and fees that don't cover the
 * gas all mean no send; that a dry run never signs; that a keeper that died
 * between persisting a batch and broadcasting it finishes the job on restart;
 * and that `pnpm keeper --once` writes its JSONL, state and heartbeat, and
 * resumes from them.
 *
 * The shared fork's clock and base fee are never touched, and no block is
 * mined but by sending this file's own transactions: vaults start at the
 * chain's own time, so their first buy is due at once, and every keeper here
 * is limited to this file's vaults by an allowlist, with `confirmations: 1`
 * and the head-lag check off (an idle fork's head is days old). Every key is
 * fresh, and every vault is closed at the end.
 *
 * Requires a fork: `pnpm anvil:fork` (point SPDEX_FORK_URL at another port to
 * use a second one).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { TOKENS, addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import {
  BATCHER_LIMITS,
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  buyFee,
  decodeBatcherEvent,
  deployBatcherCall,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  vaultBudget,
  vaultsCreatedBy,
  type VaultPlan,
} from "../../src/index.js";
import {
  keeperConfig,
  keeperTick,
  makeRedactor,
  newKeeperState,
  parseKeeperState,
  serializeKeeperState,
  toJsonLine,
  type KeeperLogRecord,
  type KeeperPolicy,
  type KeeperState,
} from "../../src/keeper.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ROOT = new URL("../../../../", import.meta.url).pathname;

const WETH = TOKENS.WETH.address;
const ETHER = 10n ** 18n;
const GWEI = 10n ** 9n;
const HOUR = 3_600n;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

async function wethOf(owner: Address): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: WETH, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner] }) },
    "latest",
  ])) as Hex;
  return decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data });
}

/** A key nobody has used, funded with `amount` if asked. Only fresh addresses are ever given a balance. */
async function freshAccount(amount?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  if (amount !== undefined) await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

interface Receipt {
  transactionHash: Hex;
  status: string;
  gasUsed: string;
  logs: { address: string; topics: string[]; data: string; logIndex: string }[];
}

async function receiptOf(hash: Hex): Promise<Receipt> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

async function send(key: Hex, to: Address, data: Hex, value = 0n): Promise<Receipt> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, prepared);
  await rpc("eth_sendRawTransaction", [raw]);
  return receiptOf(hash);
}

const hasCode = async (address: Address) => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

/** Deploy through the deterministic deployer unless it is there; a deployment that loses a race reverts, and the code is there all the same. */
async function ensureDeployed(deployer: Hex, call: { to: Address; data: Hex }, at: Address): Promise<void> {
  if (!(await hasCode(at))) await send(deployer, call.to, call.data);
  expect(await hasCode(at)).toBe(true);
}

const chainNow = async (): Promise<bigint> => BigInt(((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string }).timestamp);

/** Every config here: this file's vaults only, one confirmation, no head-lag check. */
const FORK_POLICY: Partial<KeeperPolicy> = { sendWhen: "now", confirmations: 1, maxHeadLagSeconds: 0n };

describe("the keeper on the fork", () => {
  let owner: { key: Hex; address: Address };
  let keeper: { key: Hex; address: Address };
  let cold: Address;
  const opened: Address[] = [];
  const records: KeeperLogRecord[] = [];

  /** A funded vault of `owner`'s: due at once unless `startIn` puts its start later. */
  async function createVault(amountPerBuy: bigint, options: { startIn?: bigint; interval?: bigint; maxBuys?: bigint } = {}): Promise<{ vault: Address; plan: VaultPlan }> {
    const plan: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: options.interval ?? HOUR,
      maxBuys: options.maxBuys ?? 2n,
      startAt: (await chainNow()) + (options.startIn ?? 0n),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
    };
    const receipt = await send(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), vaultBudget(plan));
    expect(BigInt(receipt.status)).toBe(1n);
    const [created] = vaultsCreatedBy(MAINNET_FACTORY, receipt.logs);
    if (!created) throw new Error("no VaultCreated from the factory");
    opened.push(created.vault);
    return { vault: created.vault, plan };
  }

  function tick(input: { vaults: Address[]; state: KeeperState; policy?: Partial<KeeperPolicy>; dryRun?: boolean; via?: JsonRpc; persist?: (s: KeeperState) => Promise<void> }) {
    const config = keeperConfig({
      chainId: CHAIN_ID,
      ...(input.dryRun ? {} : { keeperKey: keeper.key }),
      rewardTo: cold,
      vaults: input.vaults,
      policy: { ...FORK_POLICY, ...input.policy },
    });
    return keeperTick(input.via ?? rpc, {
      config,
      state: input.state,
      log: (record) => records.push(record),
      waitForReceiptMs: 120_000,
      ...(input.persist ? { persist: input.persist } : {}),
    });
  }

  const freshState = () => newKeeperState({ chainId: CHAIN_ID, keeper: keeper.address });

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    const deployer = await freshAccount(ETHER);
    await ensureDeployed(deployer.key, deployFactoryCall(), MAINNET_FACTORY);
    await ensureDeployed(deployer.key, deployBatcherCall(MAINNET_FACTORY), MAINNET_BATCHER);
    owner = await freshAccount(5n * ETHER);
    keeper = await freshAccount(ETHER);
    cold = (await freshAccount()).address;
  });

  afterAll(async () => {
    for (const vault of opened) await send(owner.key, vault, encodeClose());
  });

  let firstBatch: { hash: Hex; vaults: Address[]; fees: bigint; gasUsed: bigint; expectedGas: bigint } | null = null;

  it("one tick at sendWhen now batches two due vaults and pays rewardTo", async () => {
    const a = await createVault(ETHER / 100n);
    const b = await createVault(ETHER / 50n);
    const state = freshState();
    const result = await tick({ vaults: [a.vault, b.vault], state });

    expect(result.sent).toHaveLength(1);
    // Small buys first.
    expect(result.sent[0]!.vaults).toEqual([a.vault, b.vault]);
    expect(result.mined).toHaveLength(1);
    const mined = result.mined[0]!;
    expect(mined).toMatchObject({ status: "success", hash: result.sent[0]!.hash, notTried: [], refused: [] });
    expect(mined.bought.map((x) => [x.vault, x.buyNumber])).toEqual([
      [a.vault, 1n],
      [b.vault, 1n],
    ]);
    const fees = a.plan.keeperReward + b.plan.keeperReward;
    expect(mined.earnedWei).toBe(fees);
    expect(state.vaults[a.vault]).toMatchObject({ buysDone: 1n });
    expect(state.vaults[b.vault]).toMatchObject({ buysDone: 1n });

    // The chain agrees: the batch paid the cold address, not the keeper, and the batcher kept nothing.
    const receipt = await receiptOf(mined.hash);
    const batch = receipt.logs.map((log) => decodeBatcherEvent(MAINNET_BATCHER, log)).find((e) => e?.name === "Batch");
    expect(batch).toMatchObject({ name: "Batch", caller: keeper.address, rewardTo: cold, bought: 2n, earned: fees, swept: 0n });
    expect(await wethOf(cold)).toBe(fees);
    expect(await wethOf(keeper.address)).toBe(0n);
    expect(await wethOf(MAINNET_BATCHER)).toBe(0n);

    // The log says so, with the receipt's own hash in full.
    const minedRecord = records.find((r) => r.type === "batch_mined" && r.hash === mined.hash);
    expect(minedRecord).toMatchObject({ type: "batch_mined", earnedWei: fees, status: "success", late: false });
    expect(receipt.transactionHash.toLowerCase()).toBe(mined.hash);
    const sentRecord = records.find((r) => r.type === "batch_sent" && r.hash === mined.hash);
    expect(sentRecord).toMatchObject({ type: "batch_sent", endpoint: "public", reason: "now", deployment: "v1", batcher: MAINNET_BATCHER });
    firstBatch = {
      hash: mined.hash,
      vaults: [a.vault, b.vault],
      fees,
      gasUsed: mined.gasUsed,
      expectedGas: sentRecord?.type === "batch_sent" ? sentRecord.expectedGas : 0n,
    };
  });

  it("the explicit gas limit is enough: no vault is left untried, and the receipt's gas is inside the model", () => {
    expect(firstBatch).not.toBeNull();
    const { gasUsed, expectedGas } = firstBatch!;
    console.log(`two first buys batched by the keeper: ${gasUsed} gas (model ${expectedGas})`);
    expect(expectedGas > 0n).toBe(true);
    expect(gasUsed <= expectedGas).toBe(true);
    // Each attempt had its whole cap: the limit carries MIN_GAS_PER_ATTEMPT after the last vault.
    expect(BATCHER_LIMITS.MIN_GAS_PER_ATTEMPT).toBe(460_000n);
  });

  let later: { vault: Address; plan: VaultPlan } | null = null;
  let due: { vault: Address; plan: VaultPlan } | null = null;
  let waitingState: KeeperState | null = null;

  it("a vault not yet due waits while the due one buys", async () => {
    later = await createVault(ETHER / 100n, { startIn: HOUR });
    due = await createVault(ETHER / 100n);
    waitingState = freshState();
    const result = await tick({ vaults: [later.vault, due.vault], state: waitingState });
    expect(result.sent.map((s) => s.vaults)).toEqual([[due.vault]]);
    expect(result.mined[0]?.bought.map((x) => x.vault)).toEqual([due.vault]);
    expect(result.upcoming).toContainEqual({ vault: later.vault, nextBuyAt: later.plan.startAt });
  });

  it("a second tick sends nothing, and says when each is next due", async () => {
    const methods: string[] = [];
    const watched: JsonRpc = (method, params) => {
      methods.push(method);
      return rpc(method, params);
    };
    const result = await tick({ vaults: [later!.vault, due!.vault], state: waitingState!, via: watched });
    expect(result.sent).toEqual([]);
    expect(methods).not.toContain("eth_sendRawTransaction");
    const boughtAt = waitingState!.vaults[due!.vault]!.lastBuyAt;
    expect(result.upcoming).toEqual(
      expect.arrayContaining([
        { vault: later!.vault, nextBuyAt: later!.plan.startAt },
        // The next window of an hourly plan, and at least half an interval after the buy.
        { vault: due!.vault, nextBuyAt: due!.plan.startAt + HOUR > boughtAt + HOUR / 2n ? due!.plan.startAt + HOUR : boughtAt + HOUR / 2n },
      ]),
    );
  });

  let unbought: { vault: Address; plan: VaultPlan } | null = null;

  it("sendWhen cheap with a cheap base fee of zero waits for a block that never comes", async () => {
    unbought = await createVault(ETHER / 100n);
    const result = await tick({ vaults: [unbought.vault], state: freshState(), policy: { sendWhen: "cheap", cheapBaseFee: 0n } });
    expect(result.sent).toEqual([]);
    expect(result.waiting).toEqual({ reason: "not-cheap", candidates: 1 });
    expect(records.at(-1)).toMatchObject({ type: "wait", reason: "not-cheap", targetWei: 0n });
  });

  it("a dry run decides and simulates, and never signs or sends", async () => {
    const methods: string[] = [];
    const watched: JsonRpc = (method, params) => {
      methods.push(method);
      return rpc(method, params);
    };
    const state = newKeeperState({ chainId: CHAIN_ID, keeper: null });
    const result = await tick({ vaults: [unbought!.vault], state, dryRun: true, via: watched });
    expect(result.sent).toEqual([]);
    expect(result.waiting).toEqual({ reason: "dry-run", candidates: 1 });
    expect(methods).toContain("eth_call");
    expect(methods).not.toContain("eth_sendRawTransaction");
    expect(methods).not.toContain("eth_getTransactionCount");
    expect(state.pending).toBeNull();
  });

  it("with no subsidy, a batch whose fees can't cover its gas is not sent; with one, it is", async () => {
    // The least buy the subsidy serves, whose fee is held at the 0.69% ceiling.
    const tiny = await createVault((3n * ETHER) / 10_000n);
    const state = freshState();
    // Only the keeper's own bid is raised, so that the batch cannot pay whatever the fork's base fee.
    const refused = await tick({ vaults: [tiny.vault], state, policy: { tip: GWEI, urgentTip: GWEI, maxTip: GWEI } });
    expect(refused.sent).toEqual([]);
    expect(refused.waiting).toEqual({ reason: "economics", candidates: 1 });
    expect(refused.skipped).toContainEqual({ vault: tiny.vault, code: "economics", detail: "no-subsidy" });

    const subsidised = await tick({ vaults: [tiny.vault], state, policy: { maxLossPerBuy: ETHER / 10_000n } });
    expect(subsidised.sent).toHaveLength(1);
    expect(subsidised.mined[0]?.bought.map((x) => x.vault)).toEqual([tiny.vault]);
    const sent = records.find((r) => r.type === "batch_sent" && r.hash === subsidised.sent[0]!.hash);
    if (sent?.type !== "batch_sent") throw new Error("no batch_sent record");
    expect(sent.allowedLossWei > 0n).toBe(true);
    expect(sent.vaults[0]!.subsidyWei).toBe(sent.allowedLossWei);
    // A realised loss is booked against the vault and its owner, for the daily caps. Whether there is one
    // depends on the fork's base fee, which falls with every near-empty block this file mines.
    const net = subsidised.mined[0]!.netWei;
    const booked = state.lossLedger.filter((l) => l.vault === tiny.vault && l.owner === owner.address);
    expect(booked.reduce((sum, l) => sum + l.lossWei, 0n)).toBe(net < 0n ? -net : 0n);
  });

  it("a keeper that died between persisting a batch and broadcasting it finishes the job on restart", async () => {
    const vault = unbought!.vault;
    const state = freshState();
    let saved: string | null = null;
    // The write-ahead persist is the one with an attempt recorded: "crash" right after it, before the broadcast.
    const crashing = async (s: KeeperState) => {
      if (saved === null && s.pending && s.pending.attempts.length > 0) {
        saved = serializeKeeperState(s);
        throw new Error("simulated crash after persisting");
      }
    };
    await expect(tick({ vaults: [vault], state, persist: crashing })).rejects.toThrow("simulated crash");
    expect(saved).not.toBeNull();

    const restored = parseKeeperState(saved!);
    const hash = restored.pending!.attempts[0]!.hash;
    expect(await rpc("eth_getTransactionReceipt", [hash])).toBeNull();
    const seqBefore = restored.seq;

    // The first tick after the restart broadcasts the recorded bytes again; the next one processes the receipt.
    const first = await tick({ vaults: [vault], state: restored });
    expect(first.sent).toEqual([]);
    // Anvil mines the rebroadcast in the background, and the nonce shows it
    // before the receipt does. A tick that reads the chain in between sees the
    // nonce used and no receipt, and rightly waits, where a live keeper's next
    // tick comes a block later. So wait for the block, as that tick would.
    if (first.mined.length === 0) await receiptOf(hash);
    const second = first.mined.length > 0 ? first : await tick({ vaults: [vault], state: restored });
    expect(second.mined.map((m) => m.hash)).toEqual([hash]);
    expect(second.mined[0]!.bought.map((x) => x.vault)).toEqual([vault]);
    expect(restored.pending).toBeNull();
    expect(restored.vaults[vault]).toMatchObject({ buysDone: 1n });
    expect(restored.seq).toBeGreaterThan(seqBefore);
  });

  it("every record serialises to one JSON line, with the key and the fork's URL nowhere in it", () => {
    const redact = makeRedactor({ key: keeper.key, urls: [FORK_URL, process.env["SPDEX_FORK_RPC_URL"] ?? ""] });
    const text = records.map((r) => toJsonLine(r, redact)).map(({ line, invalid }) => {
      expect(invalid).toEqual([]);
      expect(line).not.toContain("\n");
      return line;
    });
    const all = text.join("\n");
    expect(all).not.toContain(keeper.key.slice(2));
    expect(all.toLowerCase()).not.toContain(keeper.key.slice(2).toLowerCase());
    const forkUpstream = process.env["SPDEX_FORK_RPC_URL"];
    if (forkUpstream) expect(all).not.toContain(forkUpstream);
  });

  describe("pnpm keeper", () => {
    const work = mkdtempSync(join(tmpdir(), "spdex-keeper-"));
    const dataDir = join(work, "data");
    const keyFile = join(work, "keeper_key");

    afterAll(() => rmSync(work, { recursive: true, force: true }));

    function runKeeper(args: string[], vaults: Address[]) {
      const run = spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          "--import",
          join(ROOT, "packages/vault/scripts/ts-hooks.mjs"),
          join(ROOT, "packages/vault/scripts/keeper.ts"),
          ...args,
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 180_000,
          env: {
            ...process.env,
            SPDEX_KEEPER_RPC_URL: FORK_URL,
            SPDEX_KEEPER_KEY_FILE: keyFile,
            SPDEX_KEEPER_REWARD_TO: cold,
            SPDEX_KEEPER_VAULTS: vaults.join(","),
            SPDEX_KEEPER_DATA_DIR: dataDir,
            SPDEX_KEEPER_SEND_WHEN: "now",
            SPDEX_KEEPER_CONFIRMATIONS: "1",
            SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS: "0",
          },
        },
      );
      const lines = run.stdout.split("\n").filter(Boolean);
      return { ...run, records: lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
    }

    const secretFree = (text: string) => {
      expect(text).not.toContain(keeper.key.slice(2));
      const upstream = process.env["SPDEX_FORK_RPC_URL"];
      if (upstream) expect(text).not.toContain(upstream);
    };

    it("--once writes its JSONL, state and heartbeat; a second run resumes from them", async () => {
      // `openssl rand -hex 32 > keeper_key` writes a newline, and no 0x.
      writeFileSync(keyFile, `${keeper.key.slice(2)}\n`);
      chmodSync(keyFile, 0o400);
      const { vault, plan } = await createVault(ETHER / 100n);
      const coldBefore = await wethOf(cold);

      const first = runKeeper(["--once"], [vault]);
      expect(first.status, first.stderr).toBe(0);
      secretFree(first.stdout + first.stderr);
      const types = first.records.map((r) => r["type"]);
      expect(types).toEqual(expect.arrayContaining(["start", "vault_found", "batch_sent", "batch_mined", "heartbeat"]));
      const mined = first.records.find((r) => r["type"] === "batch_mined")!;
      expect(mined).toMatchObject({ status: "success", earnedWei: String(plan.keeperReward), keeper: keeper.address });
      expect((mined["bought"] as unknown[]).length).toBe(1);
      const receipt = await receiptOf(mined["hash"] as Hex);
      expect(receipt.transactionHash.toLowerCase()).toBe(mined["hash"]);
      expect(await wethOf(cold)).toBe(coldBefore + plan.keeperReward);

      // The same records, in today's JSONL file; the state and the heartbeat beside it; the lease released.
      const logs = readdirSync(dataDir).filter((f) => /^keeper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      expect(logs).toHaveLength(1);
      const fileText = readFileSync(join(dataDir, logs[0]!), "utf8");
      secretFree(fileText);
      expect(fileText.trim().split("\n").map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual(first.records.map((r) => r["seq"]));
      const state = parseKeeperState(readFileSync(join(dataDir, "state.json"), "utf8"));
      expect(state.keeper).toBe(keeper.address);
      expect(state.vaults[vault]).toMatchObject({ buysDone: 1n });
      const heartbeat = JSON.parse(readFileSync(join(dataDir, "heartbeat.json"), "utf8")) as { ts: string; ok: boolean };
      expect(heartbeat.ok).toBe(true);
      expect(Date.now() - Date.parse(heartbeat.ts)).toBeLessThan(60_000);
      expect(existsSync(join(dataDir, "keeper.lock"))).toBe(false);

      const health = spawnSync(process.execPath, [join(ROOT, "packages/vault/scripts/keeper-health.mjs")], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, SPDEX_KEEPER_DATA_DIR: dataDir },
      });
      expect(health.status, health.stderr).toBe(0);

      // Resumed: the vault is known, so not found again; the log's sequence carries on; nothing is due.
      const second = runKeeper(["--once"], [vault]);
      expect(second.status, second.stderr).toBe(0);
      secretFree(second.stdout + second.stderr);
      const types2 = second.records.map((r) => r["type"]);
      expect(types2).not.toContain("vault_found");
      expect(types2).not.toContain("batch_sent");
      const lastSeq = first.records.at(-1)!["seq"] as number;
      expect(second.records[0]!["seq"]).toBe(lastSeq + 1);
    });

    it("--once --dry-run writes nothing, signs nothing and prints no URL", async () => {
      const { vault } = await createVault(ETHER / 100n);
      const dryDir = join(work, "dry");
      const run = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", join(ROOT, "packages/vault/scripts/ts-hooks.mjs"), join(ROOT, "packages/vault/scripts/keeper.ts"), "--once", "--dry-run"],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 180_000,
          env: {
            ...process.env,
            SPDEX_KEEPER_RPC_URL: FORK_URL,
            SPDEX_KEEPER_VAULTS: vault,
            SPDEX_KEEPER_DATA_DIR: dryDir,
            SPDEX_KEEPER_SEND_WHEN: "now",
            SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS: "0",
          },
        },
      );
      expect(run.status, run.stderr).toBe(0);
      const output = run.stdout + run.stderr;
      expect(output).not.toMatch(/https?:\/\//);
      const printed = run.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(printed.find((r) => r["type"] === "wait")).toMatchObject({ reason: "dry-run", candidates: 1 });
      expect(printed.map((r) => r["type"])).not.toContain("batch_sent");
      expect(existsSync(dryDir)).toBe(false);
    });
  });
});
