/**
 * Block headers and state proofs, from the answers every Ethereum node gives:
 * `eth_getBlockByNumber` and `eth_getProof`, through the caller's own
 * `JsonRpc`.
 *
 * A contract can check a past block's state only through that block's hash,
 * which the chain itself keeps (`BLOCKHASH` for the last 256 blocks, EIP-2935's
 * history contract for the last 8,191). Everything else a proof carries — the
 * header, the account and storage proofs — comes from a network service, and
 * is believed only once it hashes back to that one value. So the header here
 * is rebuilt, field by field, from the service's JSON answer, and refused
 * unless its keccak256 is the hash the same answer states: a service that
 * leaves a field out, adds one, or rounds one, produces a header that hashes
 * to something else, and nothing is built on it.
 *
 * ## The header's fields
 *
 * The fifteen of the original yellow paper, then one field per hard fork that
 * added one, each present from its fork on, in fork order: London's base fee,
 * Shanghai's withdrawals root, Cancun's blob gas used, excess blob gas and
 * parent beacon block root, and Prague's requests hash — 21 fields on mainnet
 * on 2 October 2026. A header never skips one: a block with Prague's field has
 * Cancun's.
 *
 * ## A fork this file doesn't know
 *
 * A hard fork that adds a header field appends it after the last one, and
 * nodes then name it in `eth_getBlockByNumber`'s answer. `blockHeaderRlp`
 * encodes only the fields above, so after such a fork its header hashes to
 * something other than the block's hash. Rather than stop every proof until a
 * new build ships (proofs last 30 days, and community windows would open to
 * everyone as they lapsed), `checkedHeaderOf` then tries the answer's other
 * hex fields after the known ones — at most `MAX_UNKNOWN_HEADER_FIELDS`, in
 * each order, each as bytes and as a quantity — and keeps the one header, if
 * any, that hashes to the block's hash. That trusts no guess: a header is
 * accepted only as the preimage of the block's hash, exactly as one built
 * from known fields is, and the known fields keep their places, so its fields
 * 3, 8 and 11 (state root, number, time) are the answer's own. A change it
 * can't follow this way (a field the answer doesn't name, or one moved) is
 * still refused, and needs a new build.
 *
 * Quantities (difficulty, number, the gas figures, timestamp, base fee, blob
 * gas) are encoded as their minimal big-endian bytes, zero as no bytes at all;
 * hashes, the miner's address, the bloom, `extraData` and the 8-byte nonce as
 * the bytes they are.
 *
 * Nothing here signs, and nothing here makes a request but through the `rpc`
 * it is given: the person's own network service, or an operator's.
 */

import { fromRlp, keccak256, toRlp } from "viem";
import type { Address, Hex } from "@spdex/core";
import type { JsonRpc } from "./reader.js";

// ─── The header, from JSON ────────────────────────────────────────────────────

/**
 * A block as `eth_getBlockByNumber` answers it: the header's fields as hex
 * strings, its `hash`, and whatever else the service adds (transactions,
 * withdrawals, size, uncles), which a header does not include and this
 * ignores.
 */
export interface RpcBlockHeader {
  hash: string;
  parentHash: string;
  sha3Uncles: string;
  miner: string;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  logsBloom: string;
  difficulty: string;
  number: string;
  gasLimit: string;
  gasUsed: string;
  timestamp: string;
  extraData: string;
  mixHash: string;
  nonce: string;
  baseFeePerGas?: string | null;
  withdrawalsRoot?: string | null;
  blobGasUsed?: string | null;
  excessBlobGas?: string | null;
  parentBeaconBlockRoot?: string | null;
  requestsHash?: string | null;
}

/** What a field is, which decides how it is encoded: a quantity, or bytes of a fixed or any length. */
type FieldKind = { quantity: true } | { bytes: number | null };

const QUANTITY: FieldKind = { quantity: true };
const bytes = (length: number | null): FieldKind => ({ bytes: length });

/** The fifteen fields every header has, in order. */
const BASE_FIELDS: readonly (readonly [keyof RpcBlockHeader, FieldKind])[] = [
  ["parentHash", bytes(32)],
  ["sha3Uncles", bytes(32)],
  ["miner", bytes(20)],
  ["stateRoot", bytes(32)],
  ["transactionsRoot", bytes(32)],
  ["receiptsRoot", bytes(32)],
  ["logsBloom", bytes(256)],
  ["difficulty", QUANTITY],
  ["number", QUANTITY],
  ["gasLimit", QUANTITY],
  ["gasUsed", QUANTITY],
  ["timestamp", QUANTITY],
  ["extraData", bytes(null)],
  ["mixHash", bytes(32)],
  ["nonce", bytes(8)],
];

/**
 * The fields hard forks added, in the order they were added and appear: each
 * is encoded while present, and one present after one missing is refused.
 */
const FORK_FIELDS: readonly (readonly [keyof RpcBlockHeader, FieldKind])[] = [
  ["baseFeePerGas", QUANTITY], // London
  ["withdrawalsRoot", bytes(32)], // Shanghai
  ["blobGasUsed", QUANTITY], // Cancun
  ["excessBlobGas", QUANTITY], // Cancun
  ["parentBeaconBlockRoot", bytes(32)], // Cancun
  ["requestsHash", bytes(32)], // Prague
];

/** How many fields a header has with every fork this file knows: 21. */
export const KNOWN_HEADER_FIELDS = BASE_FIELDS.length + FORK_FIELDS.length;

/**
 * Keys an `eth_getBlockByNumber` answer carries beside the header's fields,
 * never tried as one (record-proofs.mjs keeps much the same list; Nethermind adds
 * `author`, the miner again). Values that aren't hex strings, such as the
 * transactions, are never tried either.
 */
const NOT_HEADER_FIELDS: ReadonlySet<string> = new Set(["hash", "size", "totalDifficulty", "author", "transactions", "uncles", "withdrawals", "sealFields"]);

/**
 * The most hex fields beyond the known ones a block's answer may carry for
 * `checkedHeaderOf` to try them as fields a newer fork appended: every order
 * of every choice of four, each as bytes and as a quantity, is at most 632
 * headers hashed. An answer with more is refused without trying.
 */
export const MAX_UNKNOWN_HEADER_FIELDS = 4;

/**
 * A block's header, RLP-encoded exactly as the chain hashes it, from its JSON:
 * the bytes whose keccak256 is the block's hash, and what the SPX holder
 * registry's `prove` takes.
 *
 * Throws (RangeError) for a field that is missing, isn't hex, or has the wrong
 * length, and for a fork's field present after an earlier fork's is missing.
 * Says nothing about whether the result is the block's header: `readCheckedHeader`
 * compares its hash, and nothing should use a header that hasn't been. A
 * field added by a fork newer than this file is not encoded here;
 * `checkedHeaderOf` tries the answer's other fields for it.
 */
export function blockHeaderRlp(block: RpcBlockHeader): Hex {
  const items: Hex[] = BASE_FIELDS.map(([name, kind]) => encodeField(block, name, kind, true)!);
  let ended: keyof RpcBlockHeader | null = null;
  for (const [name, kind] of FORK_FIELDS) {
    const item = encodeField(block, name, kind, false);
    if (item === null) {
      ended ??= name;
      continue;
    }
    if (ended !== null) throw new RangeError(`the block has ${name} but not ${ended}, which comes before it: no header skips a field`);
    items.push(item);
  }
  return toRlp(items) as Hex;
}

function encodeField(block: RpcBlockHeader, name: keyof RpcBlockHeader, kind: FieldKind, required: boolean): Hex | null {
  const raw = block[name];
  if (raw === undefined || raw === null) {
    if (required) throw new RangeError(`the block has no ${name}`);
    return null;
  }
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new RangeError(`the block's ${name} is not hex: ${JSON.stringify(raw)}`);
  if ("quantity" in kind) {
    if (raw === "0x") throw new RangeError(`the block's ${name} is not a quantity: "0x"`);
    return minimalQuantity(BigInt(raw));
  }
  const hex = raw.toLowerCase() as Hex;
  if (hex.length % 2 !== 0) throw new RangeError(`the block's ${name} is not whole bytes: ${raw}`);
  if (kind.bytes !== null && (hex.length - 2) / 2 !== kind.bytes) {
    throw new RangeError(`the block's ${name} is ${(hex.length - 2) / 2} bytes, not ${kind.bytes}`);
  }
  return hex;
}

// ─── A header checked against its hash ────────────────────────────────────────

/** A header whose RLP hashes to the block's hash, with the fields a proof is checked against. */
export interface CheckedHeader {
  number: bigint;
  hash: Hex;
  stateRoot: Hex;
  /** Unix seconds: the block's own time, which a proof's validity is counted from. */
  timestamp: bigint;
  /** The header, RLP-encoded: `keccak256(rlp) === hash`. */
  rlp: Hex;
}

/**
 * A block's JSON whose rebuilt header does not hash to the hash it states: a
 * service that is not answering honestly, or that left a field out or added
 * one; or a hard fork that changed the header in a way this build can't
 * follow ("A fork this file doesn't know", above), which a newer build must.
 * Nothing may be built on it.
 */
export class HeaderHashMismatchError extends Error {
  constructor(
    readonly number: bigint,
    /** The hash the service stated. */
    readonly expected: Hex,
    /** keccak256 of the header rebuilt from its known fields. */
    readonly actual: Hex,
  ) {
    super(
      `block ${number}'s header, rebuilt from the network service's answer, hashes to ${actual}, not to the block's hash ${expected}: ` +
        "the service answered wrongly, or a hard fork changed the header in a way this build doesn't know and a newer one must",
    );
    this.name = "HeaderHashMismatchError";
  }
}

/**
 * A block's header from its JSON, checked: rebuilt with `blockHeaderRlp` and
 * refused (`HeaderHashMismatchError`) unless it hashes to the block's stated
 * hash — or, failing that, unless one choice of the fields a newer fork
 * appended, which the answer names and this file doesn't know, does
 * (`withNewerForkFields`). Throws RangeError for JSON that is not a block's.
 */
export function checkedHeaderOf(block: RpcBlockHeader): CheckedHeader {
  if (typeof block !== "object" || block === null) throw new RangeError("not a block");
  const known = blockHeaderRlp(block);
  const number = BigInt(block.number);
  if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new RangeError(`block ${number} has no hash`);
  const expected = block.hash.toLowerCase() as Hex;
  const actual = keccak256(known);
  const rlp = actual === expected ? known : withNewerForkFields(block, known, expected);
  if (rlp === null) throw new HeaderHashMismatchError(number, expected, actual);
  return { number, hash: expected, stateRoot: block.stateRoot.toLowerCase() as Hex, timestamp: BigInt(block.timestamp), rlp };
}

/**
 * The block's header with fields appended that a fork newer than this file
 * added, found from the service's answer: the known fields' header (`known`),
 * then some of the answer's other hex fields, in some order, each as bytes or
 * as a quantity — the first such header whose keccak256 is `expected`, or
 * null when none is. Tried only for a block with every field this file knows
 * (a new field comes after Prague's), and only when the answer has at most
 * `MAX_UNKNOWN_HEADER_FIELDS` other hex fields.
 *
 * Safe because nothing is believed but the hash: a header that hashes to the
 * block's hash is that block's header, however it was found, and the known
 * fields keep their places, so the state root, number and time read from the
 * answer are the header's fields 3, 8 and 11.
 */
function withNewerForkFields(block: RpcBlockHeader, known: Hex, expected: Hex): Hex | null {
  if (FORK_FIELDS.some(([name]) => block[name] === undefined || block[name] === null)) return null;
  const named = new Set<string>([...BASE_FIELDS, ...FORK_FIELDS].map(([name]) => name));
  const candidates: Hex[][] = [];
  for (const [name, raw] of Object.entries(block as unknown as Record<string, unknown>)) {
    if (named.has(name) || NOT_HEADER_FIELDS.has(name) || typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) continue;
    const hex = raw.toLowerCase() as Hex;
    const encodings = new Set<Hex>();
    if (hex.length % 2 === 0) encodings.add(hex);
    if (hex !== "0x") encodings.add(minimalQuantity(BigInt(hex)));
    candidates.push([...encodings]);
  }
  if (candidates.length === 0 || candidates.length > MAX_UNKNOWN_HEADER_FIELDS) return null;
  const search = (items: readonly Hex[], left: readonly Hex[][]): Hex | null => {
    for (const [i, encodings] of left.entries()) {
      const rest = left.filter((_, j) => j !== i);
      for (const encoding of encodings) {
        const next = [...items, encoding];
        const rlp = toRlp(next) as Hex;
        if (keccak256(rlp) === expected) return rlp;
        const deeper = search(next, rest);
        if (deeper !== null) return deeper;
      }
    }
    return null;
  };
  return search(fromRlp(known, "hex") as Hex[], candidates);
}

/** A quantity as an RLP item: its minimal big-endian bytes, zero as none. */
function minimalQuantity(value: bigint): Hex {
  if (value === 0n) return "0x";
  const digits = value.toString(16);
  return `0x${digits.length % 2 === 0 ? digits : `0${digits}`}`;
}

/**
 * A block's header from the network service, checked against its own hash:
 * `eth_getBlockByNumber(tag, false)`, rebuilt, and refused unless it hashes to
 * the hash the service stated (`HeaderHashMismatchError`) — or, asked for a
 * number, unless it is that block.
 *
 * `"finalized"` is the block a proof is built at (decision 15 of
 * docs/V2_UPGRADE.md): no reorg can change its hash, so a proof built on it
 * never fails for that reason. Throws when the service has no such block.
 */
export async function readCheckedHeader(rpc: JsonRpc, tag: "finalized" | "safe" | "latest" | bigint): Promise<CheckedHeader> {
  const asked = typeof tag === "bigint" ? hexQuantity(tag) : tag;
  const block = (await rpc("eth_getBlockByNumber", [asked, false])) as RpcBlockHeader | null;
  if (block === null || typeof block !== "object") throw new Error(`the network service has no block ${typeof tag === "bigint" ? tag : `"${tag}"`}`);
  const header = checkedHeaderOf(block);
  if (typeof tag === "bigint" && header.number !== tag) {
    throw new Error(`asked for block ${tag}, the network service answered block ${header.number}`);
  }
  return header;
}

/**
 * The most fields a header the registry can read has: its vendored RLP reader
 * (Optimism's `RLPReader`, `MAX_LIST_LENGTH`) stops at 32 items, and a longer
 * list fails with `Panic(0x32)`. A header has 21 today.
 */
export const MAX_HEADER_FIELDS = 32;

/**
 * What a header says, from its RLP alone, read the way the SPX holder registry
 * reads it: its hash, and fields 8 (number), 3 (state root) and 11
 * (timestamp). `null` for bytes the registry would refuse as a header (not a
 * list, fewer than 12 fields or more than `MAX_HEADER_FIELDS`, a state root
 * that isn't 32 bytes, a number or timestamp longer than 8), rather than a
 * throw: a check that asks this of untrusted bytes wants a "no", not an
 * exception.
 */
export function parseHeaderRlp(rlp: string): { hash: Hex; number: bigint; stateRoot: Hex; timestamp: bigint; fields: number } | null {
  if (typeof rlp !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(rlp)) return null;
  let decoded: unknown;
  try {
    decoded = fromRlp(rlp as Hex, "hex");
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length < 12 || decoded.length > MAX_HEADER_FIELDS) return null;
  const [stateRoot, number, timestamp] = [decoded[3], decoded[8], decoded[11]];
  if (typeof stateRoot !== "string" || typeof number !== "string" || typeof timestamp !== "string") return null;
  if (stateRoot.length !== 66 || number.length > 18 || timestamp.length > 18) return null;
  return {
    hash: keccak256(rlp as Hex),
    number: number === "0x" ? 0n : BigInt(number),
    stateRoot: stateRoot.toLowerCase() as Hex,
    timestamp: timestamp === "0x" ? 0n : BigInt(timestamp),
    fields: decoded.length,
  };
}

// ─── State proofs ─────────────────────────────────────────────────────────────

/** One storage slot's proof, as `eth_getProof` answers it. */
export interface StorageProof {
  /** The slot, as 32 bytes. */
  key: Hex;
  value: bigint;
  /** The trie's nodes from the account's storage root down to the slot, RLP-encoded. */
  proof: Hex[];
}

/** An account's proof and its slots', at one block (EIP-1186). */
export interface AccountProof {
  address: Address;
  /** The state trie's nodes from the block's state root down to the account, RLP-encoded. */
  accountProof: Hex[];
  balance: bigint;
  codeHash: Hex;
  nonce: bigint;
  /** The account's storage root: the root every storage proof starts from. */
  storageHash: Hex;
  storageProof: StorageProof[];
}

/**
 * `eth_getProof(address, slots, blockNumber)`, typed: the account's proof
 * from the block's state root and each slot's from the account's storage
 * root. Pinned to a number, never a tag, so the proof is of the block whose
 * header was checked.
 *
 * Throws whatever the service threw — some refuse the method outright, and
 * many keep the state for only the last 128 blocks — and throws (Error) for an
 * answer that is not a proof of these slots. Checks nothing against a state
 * root: that is what the caller has the checked header for.
 */
export async function getProof(rpc: JsonRpc, address: Address, slots: readonly Hex[], blockNumber: bigint): Promise<AccountProof> {
  const answer = await rpc("eth_getProof", [address, [...slots], hexQuantity(blockNumber)]);
  const proof = parseAccountProof(answer);
  if (proof === null) throw new Error(`the network service's answer to eth_getProof at block ${blockNumber} is not a proof`);
  if (proof.storageProof.length !== slots.length) {
    throw new Error(`the network service answered eth_getProof with ${proof.storageProof.length} storage proofs for ${slots.length} slots`);
  }
  return proof;
}

/**
 * The root a Merkle-Patricia proof starts from: the hash of its first node,
 * which is the root node itself. Null for a proof with no first node, or one
 * that isn't bytes. A proof of block N's state starts from N's state root;
 * one that doesn't is a proof of some other state, and can only revert.
 */
export function proofRoot(nodes: readonly string[]): Hex | null {
  const first = nodes[0];
  return typeof first === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(first) ? keccak256(first.toLowerCase() as Hex) : null;
}

/**
 * The storage root an account proof ends at, read from the proof alone: its
 * last node is the account's leaf, `[path, rlp([nonce, balance, storageRoot,
 * codeHash])]` (a secure trie's keys are all 32 bytes, so a value is only
 * ever in a leaf). Null when the last node is no such leaf, as in a proof
 * that the account is absent. Nothing here checks that the leaf is on a path
 * from any root: that is the registry's job, on chain. It is for tying a
 * proof's two halves together before anyone pays to send them — the storage
 * proof must start from this root — the way a proof's first node must hash
 * to its block's state root.
 */
export function accountProofStorageRoot(accountProof: readonly string[]): Hex | null {
  const last = accountProof.at(-1);
  if (typeof last !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(last)) return null;
  try {
    const leaf = fromRlp(last as Hex, "hex");
    if (!Array.isArray(leaf) || leaf.length !== 2 || typeof leaf[1] !== "string") return null;
    const account = fromRlp(leaf[1] as Hex, "hex");
    if (!Array.isArray(account) || account.length !== 4 || typeof account[2] !== "string" || account[2].length !== 66) return null;
    return account[2].toLowerCase() as Hex;
  } catch {
    return null;
  }
}

/**
 * An `eth_getProof` answer, typed and lowercased, or null when it isn't one.
 * Also for a proof pasted from another service: the shape is checked here, and
 * what it proves by whoever uses it.
 */
export function parseAccountProof(answer: unknown): AccountProof | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as Record<string, unknown>;
  const hexList = (value: unknown): Hex[] | null =>
    Array.isArray(value) && value.every((node) => typeof node === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(node))
      ? value.map((node: string) => node.toLowerCase() as Hex)
      : null;
  const quantity = (value: unknown): bigint | null =>
    typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : value === "0x" ? 0n : null;
  const word = (value: unknown): Hex | null => (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value.toLowerCase() as Hex) : null);

  const accountProof = hexList(a["accountProof"]);
  const storageHash = word(a["storageHash"]);
  const codeHash = word(a["codeHash"]);
  const balance = quantity(a["balance"]);
  const nonce = quantity(a["nonce"]);
  const address = typeof a["address"] === "string" && /^0x[0-9a-fA-F]{40}$/.test(a["address"]) ? (a["address"].toLowerCase() as Address) : null;
  if (!accountProof || !storageHash || !codeHash || balance === null || nonce === null || !address || !Array.isArray(a["storageProof"])) return null;
  const storageProof: StorageProof[] = [];
  for (const entry of a["storageProof"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    // Some services answer the key as a quantity ("0x1") rather than 32 bytes.
    const key = quantity(e["key"]);
    const value = quantity(e["value"]);
    const proof = hexList(e["proof"]);
    if (key === null || value === null || proof === null) return null;
    storageProof.push({ key: `0x${key.toString(16).padStart(64, "0")}`, value, proof });
  }
  return { address, accountProof, balance, codeHash, nonce, storageHash, storageProof };
}

/** A block number as a JSON-RPC quantity: minimal hex, "0x0" for zero. */
const hexQuantity = (n: bigint): Hex => `0x${n.toString(16)}`;
