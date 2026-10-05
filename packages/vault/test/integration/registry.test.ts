/**
 * The SPX holder registry on the local fork, through @spdex/vault: a real
 * mainnet holder proven from its recorded mainnet proof by a fresh key, read
 * back as eligible, then paid inside a community window through v2's batcher;
 * proofs the registry must refuse, asked about with `eth_call` and named; and a
 * proof built against the fork itself, for a block the fork took from mainnet,
 * byte for byte the recorded one.
 *
 * The forge tests (`test/forge/Registry.t.sol`, `Holder.t.sol`) prove the
 * registry's rules on proofs of every age and shape. This proves that what the
 * TypeScript builds, encodes and decodes is what the deployed registry
 * accepts, and that the app's eligibility read agrees with the registry's.
 *
 * Anvil can't prove the blocks it mines — their state roots aren't real — so
 * the holder is `0xb007…bb8e`, an ordinary account with 1,210 SPX at the
 * pinned block, and its proofs are mainnet's (`test/fixtures/proofs`). Anyone
 * may submit anyone's proof, so nothing signs for it: it only receives fees.
 * On a fork other suites share it may be proven already, which `validUntil`
 * says. Proofs of other holders are only ever simulated, so every other
 * address stays as mainnet left it. Every other address is fresh, the fork's
 * clock is never touched, and the vaults made here are closed at the end.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { HeaderHashMismatchError, TOKENS, httpRpc } from "@spdex/chain";
import {
  MAINNET_BATCHER,
  MAINNET_FACTORY,
  MAINNET_REGISTRY,
  MIN_SPX,
  PROOF_TTL,
  REGISTRY_ABI,
  REGISTRY_LIMITS,
  SPX_TOKEN,
  HISTORY_CONTRACT,
  buildHolderProof,
  buyFee,
  buyMaker,
  decodeBatcherEvent,
  decodeVaultError,
  decodeVaultEvent,
  describeRegistryError,
  encodeClose,
  encodeCreateVault,
  encodeExecuteBatch,
  encodeProve,
  provenBy,
  readHolderStatus,
  readVault,
  vaultBudget,
  vaultsCreatedBy,
  VAULT_LOGS_FROM_BLOCK,
  type RawLog,
  type VaultPlan,
} from "../../src/index.js";
import {
  CHAIN_ID,
  FORK_URL,
  HOLDER,
  ensureHolderProven,
  ensureRelease,
  freshAccount,
  holderProofOf,
  recordedProof,
  revertOf,
  sendRaw,
  validUntilOf,
} from "./fork.js";

const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const WETH = TOKENS.WETH.address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** `Proven(address,uint256,uint256,uint64)`: the registry's one event. */
const PROVEN_TOPIC = "0x899c4dc60873db3d707c4ae0cd1fdb927d924f249998fcdd2ce20f994384b686";

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  const data = (await rpc("eth_call", [{ to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner] }) }, "latest"])) as Hex;
  return decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data });
}

/** A registry constant, asked of the deployed registry. */
async function registryView(name: string): Promise<unknown> {
  const abi = parseAbi([`function ${name}() view returns (${name === "SPX" || name === "HISTORY" ? "address" : "uint256"})`]);
  const data = (await rpc("eth_call", [{ to: MAINNET_REGISTRY, data: encodeFunctionData({ abi, functionName: name as never }) }, "latest"])) as Hex;
  return decodeFunctionResult({ abi, functionName: name as never, data });
}

/** What the registry would say to `prove` with this calldata, from a fresh address: its revert, decoded and worded. */
async function refusalOf(data: Hex) {
  const from = (await freshAccount()).address;
  const error = decodeVaultError(await revertOf({ from, to: MAINNET_REGISTRY, data }));
  return { error, words: describeRegistryError(error) };
}

describe("the SPX holder registry on the fork", () => {
  let owner: { key: Hex; address: Address };
  const vaults: Address[] = [];

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureRelease("v2");
    owner = await freshAccount(ETHER);
  });

  afterAll(async () => {
    for (const vault of vaults) expect(BigInt((await sendRaw(owner.key, vault, encodeClose())).status)).toBe(1n);
  });

  it("is where the artifacts say, holding the constants they mirror", async () => {
    expect(await rpc("eth_getCode", [MAINNET_REGISTRY, "latest"])).not.toBe("0x");
    expect(await registryView("MIN_SPX")).toBe(REGISTRY_LIMITS.MIN_SPX);
    expect(await registryView("PROOF_TTL")).toBe(REGISTRY_LIMITS.PROOF_TTL);
    expect(await registryView("BALANCE_SLOT")).toBe(REGISTRY_LIMITS.BALANCE_SLOT);
    expect(await registryView("HISTORY_BLOCKS")).toBe(REGISTRY_LIMITS.HISTORY_BLOCKS);
    expect(String(await registryView("SPX")).toLowerCase()).toBe(SPX_TOKEN);
    expect(String(await registryView("HISTORY")).toLowerCase()).toBe(HISTORY_CONTRACT);
  });

  it("proves the recorded holder from a fresh key, once, and then reads it eligible, as the registry does", async () => {
    const recorded = holderProofOf(recordedProof("holder-b0072e68-26000000"));
    const { sent, validUntil } = await ensureHolderProven();
    if (sent !== null) {
      // This suite proved it: exactly one Proven, from the registry, for this holder and block.
      const proven = provenBy(MAINNET_REGISTRY, sent.logs);
      expect(proven).toHaveLength(1);
      expect(proven[0]).toMatchObject({ holder: HOLDER, validUntil });
      expect([25_999_900n, 26_000_000n]).toContain(proven[0]!.blockNumber);
      expect(proven[0]!.balance).toBeGreaterThanOrEqual(MIN_SPX);
    }
    // Whoever proved it on this fork, the registry's own log says so, and decodes.
    const logs = (await rpc("eth_getLogs", [
      {
        address: MAINNET_REGISTRY,
        fromBlock: `0x${VAULT_LOGS_FROM_BLOCK.toString(16)}`,
        toBlock: "latest",
        topics: [PROVEN_TOPIC, `0x${HOLDER.slice(2).padStart(64, "0")}`],
      },
    ])) as RawLog[];
    const proven = provenBy(MAINNET_REGISTRY, logs);
    expect(proven.length).toBeGreaterThan(0);
    expect(proven.at(-1)).toMatchObject({ holder: HOLDER, validUntil });
    // Valid until its block's time and 30 days: the pinned block's proof, or one newer.
    expect(validUntil).toBeGreaterThanOrEqual(BigInt(recordedProof("holder-b0072e68-25999900").timestamp) + PROOF_TTL);
    expect(await validUntilOf(HOLDER)).toBe(validUntil);

    const status = await readHolderStatus(rpc, HOLDER);
    expect(status).toMatchObject({
      state: "read",
      registry: MAINNET_REGISTRY,
      eligible: true,
      validUntil,
      proofValid: true,
      isAccount: true,
      shortfall: 0n,
      reason: null,
    });
    if (status.state !== "read") throw new Error("the registry should be deployed");
    expect(status.balance).toBe(1_210n * 10n ** 8n);

    // The same proof again would change nothing: refused, and worded.
    if (validUntil >= recorded.validUntil) {
      const { error, words } = await refusalOf(encodeProve(recorded));
      expect(error).toEqual({ name: "NotNewer", args: [validUntil] });
      expect(words).toMatch(/^this address is already proven until \d{4}-\d{2}-\d{2}, by a proof as new or newer$/);
    }
  });

  it("refuses a proof of the wrong block's state, a header that isn't the block's, a block too old, and a holding too small", async () => {
    const at25999900 = holderProofOf(recordedProof("holder-b0072e68-25999900"));
    const at26000000 = holderProofOf(recordedProof("holder-b0072e68-26000000"));
    // Block 25,999,900's header, with the account proof of the pinned block's state.
    const wrongState = await refusalOf(encodeProve({ ...at25999900, accountProof: at26000000.accountProof }));
    expect(wrongState.error?.name).toBe("ProofMismatch");
    expect(wrongState.words).toBe("the proof does not match the block's state");
    // One byte of the header changed: no longer the block's.
    const header = `${at25999900.header.slice(0, -2)}${at25999900.header.endsWith("00") ? "01" : "00"}` as Hex;
    expect((await refusalOf(encodeProve({ ...at25999900, header }))).error?.name).toBe("WrongBlockHash");
    // 8,192 blocks before the pinned one: past what EIP-2935 keeps.
    const tooOld = await refusalOf(encodeProve(holderProofOf(recordedProof("holder-b0072e68-25991808"))));
    expect(tooOld.error).toEqual({ name: "UnknownBlock", args: [25_991_808n] });
    // A real proof, of a holder with 598.8 SPX.
    const short = await refusalOf(encodeProve(holderProofOf(recordedProof("holder-cc01ef33-26000000"))));
    expect(short.error).toEqual({ name: "BelowMinimum", args: [59_880_169_405n, MIN_SPX] });
    expect(short.words).toBe("the address held 598 SPX at that block; proving takes at least 690");
  });

  it("builds a proof against the fork for a block it took from mainnet, the recorded bytes exactly, and it proves", async () => {
    const recorded = holderProofOf(recordedProof("holder-b0072e68-26000000"));
    const built = await buildHolderProof(rpc, HOLDER, { block: 26_000_000n });
    expect(built).toEqual(recorded);

    // Another real holder, never proven here: its proof, built the same way, is one the registry accepts.
    const other: Address = "0xd75110fc7a983e50e4b3a03434a8b524db4b5b7e";
    const proof = await buildHolderProof(rpc, other, { block: 26_000_000n });
    expect(proof.balance).toBeGreaterThanOrEqual(MIN_SPX);
    const from = (await freshAccount()).address;
    const stored = await validUntilOf(other);
    if (stored < proof.validUntil) {
      const answer = (await rpc("eth_call", [{ from, to: MAINNET_REGISTRY, data: encodeProve(proof) }, "latest"])) as Hex;
      expect(BigInt(decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "prove", data: answer }))).toBe(proof.validUntil);
    } else {
      // Proven by another suite: then the registry says so instead.
      expect((await refusalOf(encodeProve(proof))).error?.name).toBe("NotNewer");
    }
  });

  it("refuses to build a proof on a block the fork mined itself, whose state root isn't real, rather than offer it", async () => {
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    expect(head).toBeGreaterThan(26_000_000n);
    // Anvil's own header hashes to its own hash; the proof it answers is of its partial local trie, not of that root.
    const refused = await buildHolderProof(rpc, HOLDER, { block: head }).catch((error: unknown) => error);
    expect(refused).not.toBeInstanceOf(HeaderHashMismatchError);
    expect((refused as Error).message).toBe(`the proof does not start from block ${head}'s state root: it is not a proof of that block's state`);
  });

  it("pays the proven holder inside its community window through v2's batcher, the WETH straight to it", async () => {
    await ensureHolderProven();
    const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const amountPerBuy = ETHER / 100n;
    const plan: VaultPlan = {
      marketIndex: 0n,
      amountPerBuy,
      interval: 3_600n,
      maxBuys: 2n,
      // Due at once, with a 15-minute window: inside it for the rest of this test.
      startAt: BigInt(latest.timestamp),
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
      communityWindow: 900n,
      turnBuckets: 0n,
    };
    for (let i = 0; i < 2; i++) {
      const receipt = await sendRaw(owner.key, MAINNET_FACTORY, encodeCreateVault(plan), { value: vaultBudget(plan) });
      vaults.push(vaultsCreatedBy(MAINNET_FACTORY, receipt.logs)[0]!.vault);
    }
    const [a, b] = vaults as [Address, Address];
    expect((await readVault(rpc, a))!.status).toMatchObject({ due: true, dueSince: plan.startAt, windowEndsAt: plan.startAt + 900n });

    const keeper = await freshAccount(ETHER / 10n);
    const before = await balanceOf(WETH, HOLDER);
    const receipt = await sendRaw(keeper.key, MAINNET_BATCHER, encodeExecuteBatch([a, b], HOLDER, 2n * plan.keeperReward), { gas: 2_000_000n });
    expect(BigInt(receipt.status)).toBe(1n);
    // Both bought, every fee at the holder, none through the batcher or to the keeper.
    expect((await balanceOf(WETH, HOLDER)) - before).toBe(2n * plan.keeperReward);
    expect(await balanceOf(WETH, MAINNET_BATCHER)).toBe(0n);
    expect(await balanceOf(WETH, keeper.address)).toBe(0n);

    const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string };
    const bought = receipt.logs.map(decodeVaultEvent).filter((event) => event?.name === "Bought") as Extract<ReturnType<typeof decodeVaultEvent>, { name: "Bought" }>[];
    expect(bought.map((event) => [event.emitter, event.keeper, event.rewardTo, event.dueSince])).toEqual([
      [a, MAINNET_BATCHER, HOLDER, plan.startAt],
      [b, MAINNET_BATCHER, HOLDER, plan.startAt],
    ]);
    for (const event of bought) {
      expect(buyMaker({ ...event, owner: owner.address, sender: keeper.address, at: BigInt(block.timestamp), communityWindow: 900n })).toBe("community");
    }
    expect(receipt.logs.map((log) => decodeBatcherEvent(MAINNET_BATCHER, log)).find((event) => event?.name === "Batch")).toMatchObject({
      source: "v2",
      caller: keeper.address,
      rewardTo: HOLDER,
      bought: 2n,
      earned: 2n * plan.keeperReward,
      swept: 0n,
    });
    // Each vault counts its buy as the community's.
    for (const vault of [a, b]) expect((await readVault(rpc, vault))!.windowBuys).toBe(1n);
  });
});
