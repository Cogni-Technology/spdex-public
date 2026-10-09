/**
 * An honest proof of SPX held, sent to the SPX holder registry, and the log a
 * simulation of it shows — the proof itself a real one, recorded from mainnet
 * for a real holder (`packages/vault/test/fixtures/proofs`, written by
 * `scripts/record-proofs.mjs`): the header of block 26,000,000, which hashes
 * to that block's real hash, and the account and storage proofs down to
 * 0xb007…bb8e's 1,210 SPX. `vault.test.ts` pins that the `Proven` log decodes
 * with the vault package's own decoder, and changes one thing per case.
 */

import { USER, addressTopic, uint256Data } from "@spdex/testing";
import type { Address, Hex } from "@spdex/core";
import { parseHeaderRlp, type SimLog } from "@spdex/chain";
import { MAINNET_REGISTRY, PROOF_TTL, encodeProve } from "@spdex/vault";
import type { VaultProveIntent, VaultProveTxPlan } from "../../../src/vault.js";
import recorded26000000 from "../../../../vault/test/fixtures/proofs/holder-b0072e68-26000000.json";
import recorded25999900 from "../../../../vault/test/fixtures/proofs/holder-b0072e68-25999900.json";

/** A recorded proof, as `record-proofs.mjs` writes it. */
interface Recorded {
  holder: string;
  blockNumber: number;
  blockHash: string;
  stateRoot: string;
  timestamp: number;
  balance: string;
  header: string;
  accountProof: string[];
  storageProof: string[];
}

export interface Proof {
  holder: Address;
  blockNumber: bigint;
  blockHash: Hex;
  stateRoot: Hex;
  timestamp: bigint;
  balance: bigint;
  header: Hex;
  accountProof: Hex[];
  storageProof: Hex[];
  /** `timestamp + PROOF_TTL`: what the registry records. */
  validUntil: bigint;
}

const proofOf = (r: Recorded): Proof => ({
  holder: r.holder.toLowerCase() as Address,
  blockNumber: BigInt(r.blockNumber),
  blockHash: r.blockHash.toLowerCase() as Hex,
  stateRoot: r.stateRoot.toLowerCase() as Hex,
  timestamp: BigInt(r.timestamp),
  balance: BigInt(r.balance),
  header: r.header.toLowerCase() as Hex,
  accountProof: r.accountProof.map((n) => n.toLowerCase() as Hex),
  storageProof: r.storageProof.map((n) => n.toLowerCase() as Hex),
  validUntil: BigInt(r.timestamp) + PROOF_TTL,
});

/** 0xb007…bb8e's 1,210 SPX at the end of block 26,000,000, the fork's pinned block. */
export const PROOF: Proof = proofOf(recorded26000000);
/** The same holder's 1,308 SPX a hundred blocks earlier: a real proof of another block. */
export const EARLIER: Proof = proofOf(recorded25999900);
export const HOLDER: Address = PROOF.holder;

export const REGISTRY: Address = MAINNET_REGISTRY;

/**
 * Block 26,000,000's header with its state root replaced by another's — block
 * 25,999,900's, whose real proof of the holder's 1,308 SPX goes with it: a
 * header made up to say whatever its maker likes about the state, which
 * hashes, as any bytes do, to a hash of its own. Everything in a proof built
 * on it (`FORGED`) agrees with itself, the halves starting from the header's
 * state root included; only the chain's own hash for that block tells it
 * apart.
 */
export const FORGED_HEADER: Hex = PROOF.header.replace(PROOF.stateRoot.slice(2), EARLIER.stateRoot.slice(2)) as Hex;
/** What `FORGED_HEADER` hashes to: not block 26,000,000's hash. */
export const FORGED_HASH: Hex = parseHeaderRlp(FORGED_HEADER)!.hash;
/** The forged proof whole: block 26,000,000 by number and header, 25,999,900's state root and proof halves. */
export const FORGED: Proof = {
  ...PROOF,
  blockHash: FORGED_HASH,
  stateRoot: EARLIER.stateRoot,
  header: FORGED_HEADER,
  balance: EARLIER.balance,
  accountProof: EARLIER.accountProof,
  storageProof: EARLIER.storageProof,
};

/**
 * The person's network service, as `VaultGuardOptions.blockHash` asks it:
 * the real hash of each block these proofs are of, and nothing for any other.
 */
export const serviceBlockHash = async (blockNumber: bigint): Promise<Hex | null> =>
  blockNumber === PROOF.blockNumber ? PROOF.blockHash : blockNumber === EARLIER.blockNumber ? EARLIER.blockHash : null;

/** The proof as the app hands it over: the connected wallet proving `HOLDER` ("Prove another address"). */
export function proveIntent(overrides: Partial<VaultProveIntent> = {}, proof: Proof = PROOF): VaultProveIntent {
  return {
    version: 1,
    action: "prove",
    chainId: 1,
    account: USER,
    holder: proof.holder,
    blockNumber: proof.blockNumber,
    blockHash: proof.blockHash,
    header: proof.header,
    accountProof: [...proof.accountProof],
    storageProof: [...proof.storageProof],
    ...overrides,
  };
}

/** The one call the host builds for `intent`, exactly. */
export function provePlan(overrides: Partial<VaultProveIntent> = {}, proof: Proof = PROOF): VaultProveTxPlan {
  const intent = proveIntent(overrides, proof);
  return {
    version: 1,
    intent,
    calls: [
      {
        to: REGISTRY,
        data: encodeProve({ holder: intent.holder, header: intent.header, accountProof: [...intent.accountProof], storageProof: [...intent.storageProof] }),
        value: 0n,
      },
    ],
  };
}

/** `Proven(holder indexed, blockNumber indexed, balance, validUntil)`. */
export const PROVEN_TOPIC = "0x899c4dc60873db3d707c4ae0cd1fdb927d924f249998fcdd2ce20f994384b686" as Hex;

export interface ProvenFigures {
  holder: Address;
  blockNumber: bigint;
  balance: bigint;
  validUntil: bigint;
}

export const provenLog = (figures: Partial<ProvenFigures> = {}, emitter: Address = REGISTRY): SimLog => {
  const f: ProvenFigures = { holder: HOLDER, blockNumber: PROOF.blockNumber, balance: PROOF.balance, validUntil: PROOF.validUntil, ...figures };
  return {
    address: emitter,
    topics: [PROVEN_TOPIC, addressTopic(f.holder), uint256Data(f.blockNumber)],
    data: `0x${uint256Data(f.balance).slice(2)}${uint256Data(f.validUntil).slice(2)}` as Hex,
  };
};

/** What the registry logs for the honest proof: one record, and nothing moves. */
export const honestProofLogs = (): SimLog[] => [provenLog()];

/** `NotNewer(uint64 validUntil)`'s revert data: the holder is already proven until `validUntil`. */
export const notNewerData = (validUntil: bigint): Hex => `0xce3358be${uint256Data(validUntil).slice(2)}` as Hex;
