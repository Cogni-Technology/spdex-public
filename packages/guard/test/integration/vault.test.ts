/**
 * `VaultGuard` against real simulations of the four vault transactions, of
 * both releases, and of a proof of SPX held, on the local fork.
 *
 * The red-team suite scripts the simulated logs, in the shapes a simulation on
 * this fork produced, and proves the Guard's verdict on each. This proves the
 * other half: that `eth_simulateV1` reports a vault's creation, funding, buy
 * and closing, and the registry's record of a proof, the way those scripts
 * assume — ether by value as traced transfers, WETH wrapped and unwrapped as
 * `Deposit` and `Withdrawal` with no `Transfer`, the factory's announcement,
 * the vault's own events and the registry's `Proven` — so that an honest
 * transaction built with `@spdex/vault`'s encoders comes back `verified`, and
 * one whose creation lands anywhere but predicted, or whose proof is of
 * another block, does not.
 *
 * The transactions really sent: each vault's creation, from a fresh address,
 * funded for one buy, because funding, triggering and closing need a vault to
 * act on — a v2 vault, and a v1 vault on v1's frozen factory, which the app
 * still funds, triggers and closes. Those three are only simulated, and each
 * vault is then closed for real, so nothing is left on the shared fork for a
 * keeper to find. The v2 vault's buy is triggered inside its community window:
 * the owner's exception, which needs no SPX holder. Proofs are only
 * simulated, except that the one holder the fork suites share, 0xb007…bb8e,
 * is proven from its recorded proof by a fresh key when nothing has proven it
 * yet, as every suite that needs it does. Its clock is never touched. Each
 * release is deployed first if the fork doesn't have it yet, from a fresh
 * address, as the vault package's own tests do.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Address, DcaPlan, Hex } from "@spdex/core";
import {
  EthSimulateV1Provider,
  NATIVE_TOKEN,
  TOKENS,
  addressOfKey,
  generateSpendingKey,
  httpRpc,
  prepareTransaction,
  signPrepared,
  type SimulationProvider,
} from "@spdex/chain";
import {
  MAINNET_DEPLOYMENT,
  MAINNET_REGISTRY,
  V1_MAINNET_FACTORY,
  buyFee,
  buildHolderProof,
  defaultCommunityWindow,
  deployReleaseCalls,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeExecuteV1,
  encodeFund,
  encodeProve,
  factoryAddress,
  fundingRoom,
  predictVault,
  proveGasLimit,
  readVault,
  readVaultNonce,
  termsOfPlan,
  v1BuyFee,
  vaultsCreatedBy,
  type VaultPlan,
  type VaultRelease,
  type VaultState,
} from "@spdex/vault";
import { VaultGuard, findVaultNonce, readBlockHash, type VaultClaim, type VaultGuardOptions, type VaultTxPlan } from "../../src/vault.js";
import { SecondOpinionPair, pinnedBlock } from "../../src/second-opinion.js";
import { EARLIER, FORGED, FORGED_HASH, PROOF, PROVEN_TOPIC, provePlan } from "../redteam/fixtures/proof.js";

/** The environment, read without Node's types, which this package does not carry. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const FORK_URL = env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** A key nobody has used, given a balance. Only fresh addresses are ever given one. */
async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

interface Receipt {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string; logIndex: string }[];
}

/** Sign locally, send raw, wait for the receipt (succeeded or not). */
async function sendRaw(key: Hex, to: Address, data: Hex, value = 0n, gas?: bigint): Promise<Receipt> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, gas === undefined ? prepared : { ...prepared, gas });
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

/** Sign locally, send raw, wait for the receipt, insist it succeeded. */
async function send(key: Hex, to: Address, data: Hex, value = 0n): Promise<Receipt> {
  const receipt = await sendRaw(key, to, data, value);
  expect(BigInt(receipt.status)).toBe(1n);
  return receipt;
}

const hasCode = async (address: Address): Promise<boolean> => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

/**
 * Put `release`'s contracts on the fork, those not there yet, in the order
 * their constructors need, from a fresh key. Whichever fork test runs first
 * deploys them, and one that loses the race reverts with the code there all
 * the same, so only the code is checked afterwards.
 */
async function ensureRelease(release: VaultRelease): Promise<void> {
  let deployer: { key: Hex } | null = null;
  for (const call of deployReleaseCalls(release)) {
    if (await hasCode(call.address)) continue;
    deployer ??= await freshAccount(ETHER);
    await sendRaw(deployer.key, call.to, call.data, call.value).catch(() => null);
    expect(await hasCode(call.address), `${release}'s ${call.name}`).toBe(true);
  }
}

/** The person's own service, as the Engine hands it to the Guard: the block's hash, by number. */
const serviceBlockHash: NonNullable<VaultGuardOptions["blockHash"]> = (n) => readBlockHash(rpc, n);

/** `validUntil(holder)` on the registry, at the latest block: the one record it keeps. */
async function validUntilOf(holder: Address): Promise<bigint> {
  return BigInt((await rpc("eth_call", [{ to: MAINNET_REGISTRY, data: `0x9604fd85${holder.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"])) as string);
}

/** `inner`, counting its test-runs: a refusal before any shows the static layer refused. */
function counting(inner: SimulationProvider): SimulationProvider & { runs: number } {
  const counted = {
    kind: inner.kind,
    runs: 0,
    isAvailable: () => inner.isAvailable(),
    simulate: (request: Parameters<SimulationProvider["simulate"]>[0]) => {
      counted.runs += 1;
      return inner.simulate(request);
    },
  };
  return counted;
}

describe("VaultGuard on the fork", () => {
  const factory = factoryAddress(MAINNET_DEPLOYMENT);
  // `requireSimulation` on, so a simulation that did not happen cannot pass as one that did.
  const guard = new VaultGuard(new EthSimulateV1Provider(rpc), { chainId: CHAIN_ID, requireSimulation: true });

  let owner: { key: Hex; address: Address };
  let terms: VaultPlan;
  let plan: DcaPlan;
  let nonce: bigint;
  let chainTime: bigint;

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureRelease("v2");
    expect(await hasCode(factory)).toBe(true);
    owner = await freshAccount(ETHER);
    // Chain time as the creation's block will have it: the fork mines only
    // when sent a transaction, and its idle head lags the time it keeps by as
    // long as it has been idle. Anvil's pending block carries the next one's.
    chainTime = BigInt(((await rpc("eth_getBlockByNumber", ["pending", false])) as { timestamp: string }).timestamp);
    const amountPerBuy = ETHER / 100n;
    terms = {
      marketIndex: 0n,
      amountPerBuy,
      interval: 3_600n,
      maxBuys: 3n,
      startAt: chainTime,
      // The buy fee the app proposes, within the 0.69% ceiling the Guard and the factory hold a creation to.
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      // The app's default for an hourly plan: a quarter of it, 15 minutes.
      communityWindow: defaultCommunityWindow(3_600n),
      turnBuckets: 0n,
    };
    plan = {
      id: "dca-guard-fork",
      paused: true,
      chainId: CHAIN_ID,
      sell: NATIVE_TOKEN,
      buy: TOKENS.SPX.address,
      amountPerBuy: amountPerBuy.toString(),
      intervalSeconds: 3_600,
      maxBuys: 3,
      startAt: Number(chainTime),
      signer: "vault",
    };
    nonce = await readVaultNonce(rpc, factory, owner.address);
  });

  const perBuy = () => terms.amountPerBuy + terms.keeperReward;
  const creation = (withNonce = nonce): VaultTxPlan => ({
    version: 1,
    intent: { version: 1, action: "create", chainId: CHAIN_ID, account: owner.address, plan, terms, nonce: withNonce, nowSeconds: chainTime },
    calls: [{ to: factory, data: encodeCreateVault(terms), value: perBuy() }],
  });

  it("verifies an honest creation, and refuses one expected anywhere but where it lands, or paying more than the ceiling", async () => {
    const verdict = await guard.check(creation());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");

    // The host's nonce one too high: the simulated vault is not where the
    // plan would record it.
    const misplaced = await guard.check(creation(nonce + 1n));
    expect(misplaced.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);

    // A buy fee of 1%: past the 0.69% ceiling. The factory would refuse it too;
    // the Guard says so first, with the figures, and nothing is sent.
    const dear = { ...terms, keeperReward: terms.amountPerBuy / 100n };
    const refused = await guard.check({
      ...creation(),
      intent: { ...creation().intent, terms: dear } as VaultTxPlan["intent"],
      calls: [{ to: factory, data: encodeCreateVault(dear), value: dear.amountPerBuy + dear.keeperReward }],
    });
    expect(refused.violations.map((v) => v.code)).toContain("VAULT_MALFORMED");
    expect(refused.violations.map((v) => v.message).join(" ")).toContain("above the 0.69% ceiling");

    // The same creation aimed at v1's factory, which is there on the fork
    // and would make a vault with no community window: refused unsimulated.
    await ensureRelease("v1");
    const counted = counting(new EthSimulateV1Provider(rpc));
    const onV1 = await new VaultGuard(counted, { chainId: CHAIN_ID, requireSimulation: true }).check({
      ...creation(),
      calls: [{ to: V1_MAINNET_FACTORY, data: encodeCreateVault(terms), value: perBuy() }],
    });
    expect(onV1.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);
    expect(onV1.violations[0]!.detail).toMatchObject({ release: "v1" });
    expect(counted.runs).toBe(0);
  });

  describe("once the vault exists", () => {
    let vault: Address;
    let state: VaultState;
    let claim: VaultClaim;

    beforeAll(async () => {
      await send(owner.key, factory, encodeCreateVault(terms), perBuy());
      vault = predictVault({ factory, owner: owner.address, nonce, terms: termsOfPlan(terms) });
      const read = await readVault(rpc, vault, { factory });
      if (read === null) throw new Error(`no vault at ${vault}`);
      state = read;
      expect(state.release).toBe("v2");
      expect(state.terms.communityWindow).toBe(terms.communityWindow);
      // What the host does with a vault the config names: find its nonce from
      // what the vault says about itself.
      const found = findVaultNonce({ factory, owner: state.owner, terms: state.terms, vault, below: nonce + 1n });
      expect(found).toBe(nonce);
      claim = { address: vault, owner: state.owner, nonce: found!, terms: state.terms, release: state.release };
      plan = { ...plan, vault };
    });

    it("verifies funding the rest of the budget", async () => {
      const room = fundingRoom(state);
      expect(room).toBe(2n * perBuy());
      const verdict = await guard.check({
        version: 1,
        intent: { version: 1, action: "fund", chainId: CHAIN_ID, account: owner.address, plan, vault: claim, buysDone: state.buysDone, wethBalance: state.status.wethBalance },
        calls: [{ to: vault, data: encodeFund(), value: room }],
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");
    });

    it("verifies the owner triggering the first buy inside its community window, held to the vault's own floor, the fee back to the owner", async () => {
      expect(state.quote).not.toBeNull();
      // Due since its start, and its 15-minute window still open: only the
      // owner's exception lets this buy be paid to anyone not proven.
      expect(state.status.dueSince).toBe(terms.startAt);
      expect(state.status.windowEndsAt).toBe(terms.startAt + terms.communityWindow);
      expect(state.chainTime).not.toBeNull();
      expect(state.chainTime!).toBeLessThan(state.status.windowEndsAt!);
      const verdict = await guard.check({
        version: 1,
        intent: { version: 1, action: "trigger", chainId: CHAIN_ID, account: owner.address, plan, vault: claim, floorOut: state.quote!.floorOut, rewardTo: owner.address },
        calls: [{ to: vault, data: encodeExecute(owner.address), value: 0n }],
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");
    });

    it("verifies closing, then closes for real", async () => {
      const closing: VaultTxPlan = {
        version: 1,
        intent: { version: 1, action: "close", chainId: CHAIN_ID, account: owner.address, plan, vault: claim },
        calls: [{ to: vault, data: encodeClose(), value: 0n }],
      };
      const verdict = await guard.check(closing);
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");

      await send(owner.key, vault, encodeClose());
      expect((await readVault(rpc, vault, { factory }))?.closed).toBe(true);
    });
  });
});

/**
 * v1's vaults are still the app's to fund, trigger and close, for good: a
 * claim that says v1 is proved against v1's frozen factory and its 112-byte
 * layout, and a buy is v1's `execute()`, the fee to whoever sends it.
 */
describe("VaultGuard on the fork, a v1 vault", () => {
  const guard = new VaultGuard(new EthSimulateV1Provider(rpc), { chainId: CHAIN_ID, requireSimulation: true });

  let owner: { key: Hex; address: Address };
  let vault: Address;
  let state: VaultState;
  let claim: VaultClaim;
  let plan: DcaPlan;

  beforeAll(async () => {
    await ensureRelease("v1");
    owner = await freshAccount(ETHER);
    // As the creation's block will have it (see the first suite).
    const chainTime = BigInt(((await rpc("eth_getBlockByNumber", ["pending", false])) as { timestamp: string }).timestamp);
    const amountPerBuy = ETHER / 100n;
    // The fee spDEX proposed for a buy this size when it made v1 vaults.
    const keeperReward = v1BuyFee(amountPerBuy).reward;
    const nonce = await readVaultNonce(rpc, V1_MAINNET_FACTORY, owner.address);
    // v1's `createVault(uint256 × 7)`, hand-encoded as the Guard's tests never
    // pull in an ABI codec: no community window. The factory's own
    // `VaultCreated`, decoded below as v1's, is what pins it.
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const create = `0x3f8f7b79${[0n, amountPerBuy, 3_600n, 2n, chainTime, keeperReward, 300n].map(word).join("")}` as Hex;
    const receipt = await send(owner.key, V1_MAINNET_FACTORY, create, amountPerBuy + keeperReward);
    const [created] = vaultsCreatedBy(V1_MAINNET_FACTORY, receipt.logs);
    expect(created).toMatchObject({ source: "v1", owner: owner.address.toLowerCase() });
    vault = created!.vault;
    expect(predictVault({ factory: V1_MAINNET_FACTORY, owner: owner.address, nonce, terms: created!.terms })).toBe(vault);
    const read = await readVault(rpc, vault, { factory: V1_MAINNET_FACTORY });
    if (read === null) throw new Error(`no vault at ${vault}`);
    state = read;
    expect(state.release).toBe("v1");
    expect(state.terms.communityWindow).toBeNull();
    claim = { address: vault, owner: state.owner, nonce, terms: state.terms, release: state.release };
    plan = {
      id: "dca-guard-fork-v1",
      paused: true,
      chainId: CHAIN_ID,
      sell: NATIVE_TOKEN,
      buy: TOKENS.SPX.address,
      amountPerBuy: amountPerBuy.toString(),
      intervalSeconds: 3_600,
      maxBuys: 2,
      startAt: Number(chainTime),
      signer: "vault",
      vault,
    };
  });

  it("verifies funding the rest of its budget", async () => {
    const verdict = await guard.check({
      version: 1,
      intent: { version: 1, action: "fund", chainId: CHAIN_ID, account: owner.address, plan, vault: claim, buysDone: state.buysDone, wethBalance: state.status.wethBalance },
      calls: [{ to: vault, data: encodeFund(), value: fundingRoom(state) }],
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("verifies its owner triggering its due buy with v1's `execute()`, the fee to the caller, and refuses v2's call on it", async () => {
    expect(state.quote).not.toBeNull();
    const trigger = (data: Hex): VaultTxPlan => ({
      version: 1,
      intent: { version: 1, action: "trigger", chainId: CHAIN_ID, account: owner.address, plan, vault: claim, floorOut: state.quote!.floorOut, rewardTo: owner.address },
      calls: [{ to: vault, data, value: 0n }],
    });
    const verdict = await guard.check(trigger(encodeExecuteV1()));
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
    expect((await guard.check(trigger(encodeExecute(owner.address)))).violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);
  });

  it("refuses it claimed as a v2 vault", async () => {
    const verdict = await guard.check({
      version: 1,
      intent: { version: 1, action: "close", chainId: CHAIN_ID, account: owner.address, plan, vault: { ...claim, release: "v2" } },
      calls: [{ to: vault, data: encodeClose(), value: 0n }],
    });
    expect(verdict.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);
  });

  it("verifies closing, then closes for real", async () => {
    const verdict = await guard.check({
      version: 1,
      intent: { version: 1, action: "close", chainId: CHAIN_ID, account: owner.address, plan, vault: claim },
      calls: [{ to: vault, data: encodeClose(), value: 0n }],
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");

    await send(owner.key, vault, encodeClose());
    expect((await readVault(rpc, vault, { factory: V1_MAINNET_FACTORY }))?.closed).toBe(true);
  });
});

/**
 * The sixth transaction on the fork: real proofs, recorded from mainnet for
 * blocks the fork took from it (anvil can't prove the blocks it mines), sent
 * to the registry this build deploys. A proof is only ever simulated here,
 * but for the one holder every fork suite shares, which is proven by a fresh
 * key the way the vault package's suites do it, so that "already proven" is
 * a state this file can count on.
 */
describe("VaultGuard on the fork, a proof of SPX held", () => {
  const SAME_FORK_URL = FORK_URL.includes("127.0.0.1") ? FORK_URL.replace("127.0.0.1", "localhost") : FORK_URL.replace("localhost", "127.0.0.1");
  /** Another real holder, 1,992 SPX at the pinned block, that no suite ever proves: only simulated. */
  const UNPROVEN: Address = "0xd75110fc7a983e50e4b3a03434a8b524db4b5b7e";
  const guardOn = (provider: SimulationProvider) =>
    new VaultGuard(provider, { chainId: CHAIN_ID, requireSimulation: true, blockHash: serviceBlockHash });

  let prover: { key: Hex; address: Address };

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureRelease("v2");
    prover = await freshAccount(ETHER);
  });

  /** `inner`, test-running as of `base`: the block after it, pinned as the second opinion pins one. A read of the past; nothing is sent. */
  async function asOf(inner: SimulationProvider, base: bigint): Promise<SimulationProvider> {
    const header = (await rpc("eth_getBlockByNumber", [hex(base), false])) as { hash: Hex; timestamp: string; gasLimit: string };
    const block = pinnedBlock({ number: base, hash: header.hash, timestamp: BigInt(header.timestamp), gasLimit: BigInt(header.gasLimit) });
    return { kind: inner.kind, isAvailable: () => inner.isAvailable(), simulate: (request) => inner.simulate({ ...request, block }) };
  }

  it("reads the pinned block's hash from the fork as mainnet's: the hash the recorded proof was built against", async () => {
    expect(await serviceBlockHash(PROOF.blockNumber)).toBe(PROOF.blockHash);
    expect(await serviceBlockHash(EARLIER.blockNumber)).toBe(EARLIER.blockHash);
  });

  it("verifies 0xb007…bb8e's recorded proof of block 26,000,000, as of a block before anything on this fork proved it", async () => {
    let provider: SimulationProvider = new EthSimulateV1Provider(rpc);
    if ((await validUntilOf(PROOF.holder)) >= PROOF.validUntil) {
      // Proven here already, by another suite or an earlier run: test-run it
      // as of the block before the registry's first record of it.
      const records = (await rpc("eth_getLogs", [
        { address: MAINNET_REGISTRY, topics: [PROVEN_TOPIC, `0x${PROOF.holder.slice(2).padStart(64, "0")}`], fromBlock: hex(PROOF.blockNumber + 1n), toBlock: "latest" },
      ])) as { blockNumber: string }[];
      expect(records.length).toBeGreaterThan(0);
      provider = await asOf(provider, BigInt(records[0]!.blockNumber) - 1n);
    }
    const verdict = await guardOn(provider).check(provePlan({ chainId: CHAIN_ID, account: prover.address }));
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");
  });

  it("refuses it once the holder is proven, saying so in words (`NotNewer`), on one service and on two", async () => {
    if ((await validUntilOf(PROOF.holder)) < PROOF.validUntil) {
      // As anyone may, and as the vault package's suites do: from a fresh key.
      const data = encodeProve(PROOF);
      const estimate = BigInt((await rpc("eth_estimateGas", [{ from: prover.address, to: MAINNET_REGISTRY, data }])) as string);
      const receipt = await sendRaw(prover.key, MAINNET_REGISTRY, data, 0n, proveGasLimit(estimate));
      if (BigInt(receipt.status) !== 1n) expect((await validUntilOf(PROOF.holder)) >= PROOF.validUntil, "proven by another suite in between").toBe(true);
    }
    expect(await validUntilOf(PROOF.holder)).toBeGreaterThanOrEqual(PROOF.validUntil);

    const plan = provePlan({ chainId: CHAIN_ID, account: prover.address });
    const verdict = await guardOn(new EthSimulateV1Provider(rpc)).check(plan);
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["SIMULATION_REVERTED"]);
    expect(verdict.violations[0]!.message).toMatch(/^the proof would revert: this address is already proven until /);

    const pair = new SecondOpinionPair({ primaryRpc: rpc, secondRpc: httpRpc(SAME_FORK_URL), host: "localhost" });
    const both = await guardOn(pair.provider(new EthSimulateV1Provider(rpc))).check(plan);
    expect(both.level).toBe("rejected");
    expect(both.violations.map((v) => v.code)).toEqual(["SIMULATION_REVERTED"]);
  });

  it("verifies a holder nobody has proven here, its proof built from the fork by the app's own builder, with a second opinion", async () => {
    const proof = await buildHolderProof(rpc, UNPROVEN, { block: PROOF.blockNumber });
    expect(proof.blockHash).toBe(PROOF.blockHash);
    const plan = provePlan({
      chainId: CHAIN_ID,
      account: prover.address,
      holder: proof.holder,
      blockNumber: proof.blockNumber,
      blockHash: proof.blockHash,
      header: proof.header,
      accountProof: proof.accountProof,
      storageProof: proof.storageProof,
    });
    const pair = new SecondOpinionPair({ primaryRpc: rpc, secondRpc: httpRpc(SAME_FORK_URL), host: "localhost" });
    const verdict = await guardOn(pair.provider(new EthSimulateV1Provider(rpc))).check(plan);
    if ((await validUntilOf(UNPROVEN)) < proof.validUntil) {
      expect(verdict.violations).toEqual([]);
      expect(verdict.warnings).toEqual([]);
      expect(verdict.level).toBe("verified");
    } else {
      // Proven by something else on this fork after all: the registry refuses it instead.
      expect(verdict.level).toBe("rejected");
      expect(verdict.violations.map((v) => v.code)).toEqual(["SIMULATION_REVERTED"]);
    }
  });

  it("refuses the same proof claimed for a different block number, before any test-run", async () => {
    // Block 25,999,999, with the hash the fork itself gives it.
    const counted = counting(new EthSimulateV1Provider(rpc));
    const other = PROOF.blockNumber - 1n;
    const otherHash = await serviceBlockHash(other);
    expect(otherHash).not.toBeNull();
    const verdict = await guardOn(counted).check(provePlan({ chainId: CHAIN_ID, account: prover.address, blockNumber: other, blockHash: otherHash! }));
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED", "VAULT_MALFORMED"]);
    // Or with block 26,000,000's hash kept, and only the number changed.
    const renumbered = await guardOn(counted).check(provePlan({ chainId: CHAIN_ID, account: prover.address, blockNumber: other }));
    expect(renumbered.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);
    expect(counted.runs).toBe(0);
  });

  it("refuses a made-up header for block 26,000,000 that agrees with itself, by the fork's own hash for that block", async () => {
    const counted = counting(new EthSimulateV1Provider(rpc));
    const verdict = await guardOn(counted).check(provePlan({ chainId: CHAIN_ID, account: prover.address }, FORGED));
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);
    expect(verdict.violations[0]!.detail).toMatchObject({ expected: PROOF.blockHash, actual: FORGED_HASH });
    expect(counted.runs).toBe(0);
  });
});
