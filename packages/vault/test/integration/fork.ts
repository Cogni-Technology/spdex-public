/**
 * What the vault's fork tests share: putting a release's contracts on the
 * shared fork, and making the one real SPX holder they borrow eligible.
 *
 * ## Releases
 *
 * Neither release is on the fork at its pinned block: v1 reached mainnet at
 * block 26,100,366, after it, and v2 not at all yet. Each suite deploys what it
 * needs the way anyone would, through the deterministic deployer, in the order
 * the constructors need (`deployReleaseCalls`: v2's registry, factory and
 * batcher; v1's factory and batcher from its frozen source). Another suite on
 * the same fork may deploy a contract first — even between the check and the
 * send — and a deployment that loses that race reverts with the code there all
 * the same, so only the code is checked afterwards. v1's land exactly at
 * `DEPLOYMENTS[0]`'s addresses: the frozen source is v1's, byte for byte.
 *
 * ## The eligible holder
 *
 * Anvil can't prove the blocks it mines (their state roots aren't real), so the
 * fork tests borrow a real mainnet SPX holder, `0xb007…bb8e`, an ordinary
 * account holding 1,210 SPX at the pinned block, and prove it from proofs
 * recorded from mainnet (`test/fixtures/proofs`) by a fresh key: anyone may
 * submit anyone's proof. Nothing ever signs for it; it only receives fees. On a
 * fork other suites share, it may be proven already: `validUntil` is read
 * first, and a `NotNewer` from a race means the same.
 *
 * Every key is fresh, nothing moves the fork's clock, and nothing is mined but
 * by sending a transaction.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "@spdex/core";
import { addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import {
  DEPLOYMENTS,
  MAINNET_REGISTRY,
  PROOF_TTL,
  REGISTRY_ABI,
  decodeVaultError,
  deployReleaseCalls,
  proveCall,
  proveGasLimit,
  type HolderProof,
  type VaultRelease,
} from "../../src/index.js";

export const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const ETHER = 10n ** 18n;

/** The real mainnet SPX holder the fork tests make eligible: an account (no code), 1,210 SPX at the pinned block. */
export const HOLDER: Address = "0xb0072e684e532bd1dcc442b5ed22097db205bb8e";

/** A proof recorded from mainnet, as `scripts/record-proofs.mjs` writes it. */
export interface RecordedProof {
  holder: string;
  blockNumber: number;
  blockHash: string;
  stateRoot: string;
  timestamp: number;
  balance: string;
  storageKey: string;
  header: string;
  accountProof: string[];
  storageProof: string[];
}

/** One recorded proof, by its file's name in `test/fixtures/proofs`. */
export function recordedProof(name: string): RecordedProof {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/proofs/${name}.json`, import.meta.url)), "utf8")) as RecordedProof;
}

/** A recorded proof as `HolderProof`, ready for `proveCall`. */
export function holderProofOf(recorded: RecordedProof): HolderProof {
  return {
    holder: recorded.holder.toLowerCase() as Address,
    blockNumber: BigInt(recorded.blockNumber),
    blockHash: recorded.blockHash as Hex,
    timestamp: BigInt(recorded.timestamp),
    balance: BigInt(recorded.balance),
    header: recorded.header.toLowerCase() as Hex,
    accountProof: recorded.accountProof.map((n) => n.toLowerCase() as Hex),
    storageProof: recorded.storageProof.map((n) => n.toLowerCase() as Hex),
    validUntil: BigInt(recorded.timestamp) + PROOF_TTL,
  };
}

const rpc = httpRpc(FORK_URL);
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** A key nobody has used, funded with `amount` if asked. Only fresh addresses are ever given a balance. */
export async function freshAccount(amount?: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  if (amount !== undefined) await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

export interface Receipt {
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string; logIndex: string }[];
}

/** Sign locally, send raw, wait for the receipt (succeeded or not). `gas` replaces the estimate's limit when given. */
export async function sendRaw(key: Hex, to: Address, data: Hex, options: { value?: bigint; gas?: bigint } = {}): Promise<Receipt> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value: options.value ?? 0n, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, options.gas === undefined ? prepared : { ...prepared, gas: options.gas });
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

export const hasCode = async (address: Address): Promise<boolean> => ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

/**
 * Put `release`'s contracts on the fork, those not there yet, in order, from
 * a fresh key, tolerating a race with another suite. Returns their addresses.
 */
export async function ensureRelease(release: VaultRelease): Promise<Record<"registry" | "factory" | "batcher", Address | null>> {
  const calls = deployReleaseCalls(release);
  let deployer: { key: Hex } | null = null;
  for (const call of calls) {
    if (await hasCode(call.address)) continue;
    deployer ??= await freshAccount(2n * ETHER);
    try {
      await sendRaw(deployer.key, call.to, call.data, { value: call.value });
    } catch {
      // Refused at the estimate: most likely deployed by another suite in between. The code says.
    }
    expect(await hasCode(call.address), `${release}'s ${call.name} at ${call.address}`).toBe(true);
  }
  const at = (name: "registry" | "factory" | "batcher") => calls.find((call) => call.name === name)?.address ?? null;
  if (release === "v1") {
    // The frozen source lands exactly where v1 is on mainnet.
    expect([at("factory"), at("batcher")]).toEqual([DEPLOYMENTS[0]!.factory, DEPLOYMENTS[0]!.batcher]);
  }
  return { registry: at("registry"), factory: at("factory"), batcher: at("batcher") };
}

/** `validUntil(holder)` on this build's registry, at the latest block. */
export async function validUntilOf(holder: Address, registry: Address = MAINNET_REGISTRY): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "validUntil", args: [holder] }) },
    "latest",
  ])) as Hex;
  return BigInt(decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "validUntil", data }));
}

/** The revert data an `eth_call` came back with; throws if it did not revert. */
export async function revertOf(call: { from?: Address; to: Address; data: Hex }, client: JsonRpc = rpc): Promise<Hex> {
  try {
    await client("eth_call", [call, "latest"]);
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") return data as Hex;
    throw error;
  }
  throw new Error("the call did not revert");
}

/**
 * Make `HOLDER` eligible on the fork, as anyone could: submit its newest
 * recorded proof (the pinned block's) from a fresh key, or the one 100 blocks
 * before it where the fork can no longer check the pinned one — unless it is
 * proven already, by this proof or a newer one, which `validUntil` says.
 * Returns how the holder came to be proven, and its `validUntil`.
 */
export async function ensureHolderProven(): Promise<{ sent: Receipt | null; validUntil: bigint }> {
  await ensureRelease("v2");
  for (const name of ["holder-b0072e68-26000000", "holder-b0072e68-25999900"]) {
    const proof = holderProofOf(recordedProof(name));
    const stored = await validUntilOf(HOLDER);
    if (stored >= proof.validUntil) return { sent: null, validUntil: stored };
    const call = proveCall(proof);
    const prover = await freshAccount(ETHER / 10n);
    let estimate: bigint;
    try {
      estimate = BigInt((await rpc("eth_estimateGas", [{ from: prover.address, to: call.to, data: call.data }])) as string);
    } catch (error) {
      const refusal = decodeVaultError((error as { data?: string }).data ?? "0x");
      // Proven by another suite in between: as good.
      if (refusal?.name === "NotNewer") return { sent: null, validUntil: await validUntilOf(HOLDER) };
      // The fork can no longer check this block's hash: try the older proof.
      continue;
    }
    const receipt = await sendRaw(prover.key, call.to, call.data, { gas: proveGasLimit(estimate) });
    if (BigInt(receipt.status) === 1n) return { sent: receipt, validUntil: await validUntilOf(HOLDER) };
  }
  throw new Error(`${HOLDER} could not be proven on the fork from its recorded proofs`);
}
