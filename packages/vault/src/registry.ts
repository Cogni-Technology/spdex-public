/**
 * The SPX holder registry, from TypeScript: whether an address may be paid as
 * a community keeper, and the proof that makes it so.
 *
 * `SpxHolderRegistry` (contracts/SpxHolderRegistry.sol) is ownerless and
 * immutable, and stores one timestamp per address that has proven: until when
 * its proof is valid. An address is eligible inside a v2 vault's community
 * window while three things hold: a proof that it held at least `MIN_SPX`
 * (690 SPX) at the end of a recent block is still valid (`chainTime ≤
 * validUntil`, inclusive, as the contract has it), it is an account — no code,
 * or only an EIP-7702 delegation — and it holds at least `MIN_SPX` now. A
 * contract can never be eligible, whatever it holds: one that pays out what it
 * is paid (a Uniswap pair's `skim`) would let anyone take every window's fee.
 *
 * A proof is built from Ethereum's own state and checked by the registry
 * against the block's real hash (EIP-2935's history for the last 8,191
 * blocks, `BLOCKHASH` for the last 256): the block's header, the account
 * proof from its state root to SPX, and the storage proof from SPX's storage
 * root to the holder's balance. The app and the keeper prove the `finalized`
 * block (decision 15 of docs/V2_UPGRADE.md), which no reorg can change.
 *
 * ## Built here, checked here, sent elsewhere
 *
 * `buildHolderProof` asks the person's own network service for the block and
 * the proof, rebuilds the header and refuses it unless it hashes to the
 * block's hash, and checks the proof's first nodes against the header's state
 * root before anything is offered for signing. Some services refuse
 * `eth_getProof` (`ProofUnavailableError`): then `proofRequests` gives the
 * exact requests to run against another service, by hand, and
 * `checkPastedProof` checks what comes back against the person's own
 * service's hash for that block. Nothing here ever contacts another service
 * (AGENTS.md rule 4).
 *
 * Nothing here signs, and nothing here decides whether to: the Guard checks a
 * `prove` as VaultGuard's sixth transaction, and the keeper's fifth signing
 * shape is a `prove` for its own `rewardTo`. Every figure that cannot be read
 * is `null` — unknown, never zero.
 */

import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import {
  CONTRACTS,
  HeaderHashMismatchError,
  Multicall3Reader,
  checkedHeaderOf,
  getProof,
  parseAccountProof,
  readCheckedHeader,
  type AccountProof,
  type CheckedHeader,
  type JsonRpc,
  type RpcBlockHeader,
} from "@spdex/chain";
import { MAINNET_REGISTRY, REGISTRY_ABI, REGISTRY_LIMITS, SPX_TOKEN } from "./artifacts.js";
// index.ts re-exports this file; these are only ever called, never used while the modules load.
import { decodeOr, type RawLog } from "./index.js";

// ─── The registry's constants ─────────────────────────────────────────────────

/** The least SPX a holder proves and holds, raw units (8 decimals): 690 SPX, fixed in the registry (decision 1). */
export const MIN_SPX = REGISTRY_LIMITS.MIN_SPX;

/** How long a proof lasts from its block's time, in seconds: 30 days (decision 2). */
export const PROOF_TTL = REGISTRY_LIMITS.PROOF_TTL;

/** How far back a proven block may be: EIP-2935 keeps the last 8,191 blocks' hashes, about 27 hours. */
export const PROOF_HISTORY_BLOCKS = REGISTRY_LIMITS.HISTORY_BLOCKS;

/** From how long before a proof lapses the app warns, and reminds (decision 25): 5 days. */
export const PROOF_LAPSE_WARNING_SECONDS = 5n * 86_400n;

/**
 * The most gas a `prove` is ever sent with: 750,000. A proof costs about
 * 520,000–550,000 to check and about 655,000–685,000 as a transaction (its
 * eight kilobytes of calldata; `test/forge/Registry.t.sol` measures it), far
 * more than docs/V2_UPGRADE.md first estimated.
 */
export const PROVE_GAS_CAP = 750_000n;

/**
 * The gas limit a `prove` is signed with: its estimate and a fifth more, at
 * most `PROVE_GAS_CAP`; the cap itself when there is no estimate. Throws
 * (RangeError) for an estimate already above the cap: a proof that dear is
 * not the proof this file builds, and is not sent.
 */
export function proveGasLimit(estimate: bigint | null): bigint {
  if (estimate === null) return PROVE_GAS_CAP;
  if (estimate < 0n) throw new RangeError("a gas estimate cannot be negative");
  if (estimate > PROVE_GAS_CAP) throw new RangeError(`the proof's estimate, ${estimate} gas, is above the ${PROVE_GAS_CAP} a proof is ever sent with`);
  const limit = (estimate * 6n + 4n) / 5n;
  return limit < PROVE_GAS_CAP ? limit : PROVE_GAS_CAP;
}

/**
 * The storage slot of `holder`'s SPX balance: `keccak256(abi.encode(holder,
 * 1))`, SPX's balances being the mapping at slot 1 (checked against
 * `balanceOf` for every recorded proof).
 */
export function spxBalanceSlot(holder: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [lower(holder), REGISTRY_LIMITS.BALANCE_SLOT]));
}

// ─── A proof ──────────────────────────────────────────────────────────────────

/** A proof that `holder` held `balance` SPX at the end of block `blockNumber`, ready to send. */
export interface HolderProof {
  holder: Address;
  blockNumber: bigint;
  blockHash: Hex;
  /** The block's time, which the proof's validity is counted from. */
  timestamp: bigint;
  /** SPX, raw units, at the block: at least `MIN_SPX`, or no proof is built. */
  balance: bigint;
  /** The block's header, RLP-encoded: `keccak256(header) === blockHash`. */
  header: Hex;
  accountProof: Hex[];
  storageProof: Hex[];
  /** Until when, inclusive, the proof makes `holder` eligible: `timestamp + PROOF_TTL`. */
  validUntil: bigint;
}

/**
 * The network service refused `eth_getProof` — the method itself, or the
 * state of the block asked for. Many hosted services do. The app offers to
 * paste a proof built elsewhere (`proofRequests`, `checkPastedProof`); the
 * keeper logs it and goes on.
 */
export class ProofUnavailableError extends Error {
  constructor(
    readonly blockNumber: bigint,
    /** What the service said, as it was thrown. */
    refusal: unknown,
  ) {
    super(`the network service won't answer eth_getProof for block ${blockNumber}: ${messageOf(refusal)}`, { cause: refusal });
    this.name = "ProofUnavailableError";
  }
}

/** At the block proven, the holder held less than `MIN_SPX`: the registry would refuse the proof (`BelowMinimum`). */
export class HoldingBelowMinimumError extends Error {
  constructor(
    readonly holder: Address,
    readonly blockNumber: bigint,
    readonly balance: bigint,
  ) {
    super(`${holder} held ${spxText(balance)} SPX at block ${blockNumber}; proving takes at least ${spxText(MIN_SPX)}`);
    this.name = "HoldingBelowMinimumError";
  }
}

/**
 * A block the registry could not check by the time a proof of it lands: one
 * the network service's newest (`head`) is not yet at, or one more than
 * 8,191 blocks behind the block that would include the proof.
 */
export class BlockOutOfReachError extends Error {
  constructor(
    readonly blockNumber: bigint,
    readonly head: bigint,
  ) {
    super(
      blockNumber > head
        ? `block ${blockNumber} is newer than the network service's newest, ${head}`
        : `block ${blockNumber} is too old to prove: the registry can check only the last ${PROOF_HISTORY_BLOCKS} blocks, and the newest is ${head}`,
    );
    this.name = "BlockOutOfReachError";
  }
}

/**
 * Whether the registry can check block `number` in a proof sent now, with the
 * network service's newest block at `head`: the proof lands at the earliest
 * in the next block, and the registry reads the hash of a block before the
 * one it runs in, among the last 8,191 (EIP-2935). Shared by every path that
 * offers a proof for signing, so a block the registry can only answer
 * `UnknownBlock` for is refused before anyone pays to hear it.
 */
function withinReach(head: bigint, number: bigint): boolean {
  return number <= head && head + 1n - number <= PROOF_HISTORY_BLOCKS;
}

/**
 * Build a proof that `holder` held at least `MIN_SPX` at the end of `block`
 * (`"finalized"` by default), from the network service's own answers:
 *
 * 1. for a block given by number, that the registry can still check it once
 *    the proof lands (`BlockOutOfReachError`): the service's newest block
 *    first, one request more on that path alone. The `finalized` block is
 *    always within reach, about 64 blocks back;
 * 2. the block, whose header is rebuilt and refused unless it hashes to the
 *    block's hash (`HeaderHashMismatchError` from `@spdex/chain`);
 * 3. `eth_getProof(SPX, [the holder's balance slot], that block's number)` —
 *    `ProofUnavailableError` when the service refuses it;
 * 4. checks that the answer is the proof of that slot of SPX, at that block's
 *    state (each proof's first node hashes to its root), and that the balance
 *    is at least `MIN_SPX` (`HoldingBelowMinimumError` otherwise).
 *
 * The registry checks all of it again, against the chain's own hash of the
 * block; these checks are so that nobody pays gas for a proof that can only
 * revert. A fork's own mined blocks can't be proven (their state roots are not
 * real), and fail at step 4.
 */
export async function buildHolderProof(
  rpc: JsonRpc,
  holder: Address,
  options: { block?: "finalized" | bigint } = {},
): Promise<HolderProof> {
  if (typeof options.block === "bigint") {
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    if (!withinReach(head, options.block)) throw new BlockOutOfReachError(options.block, head);
  }
  const header = await readCheckedHeader(rpc, options.block ?? "finalized");
  let proof: AccountProof;
  try {
    proof = await getProof(rpc, SPX_TOKEN, [spxBalanceSlot(holder)], header.number);
  } catch (error) {
    if (refusesProofs(error)) throw new ProofUnavailableError(header.number, error);
    throw error;
  }
  return assembleProof(lower(holder), header, proof);
}

/**
 * Whether an error is a service saying it won't answer `eth_getProof`: the
 * method unknown or unsupported (-32601, -32004), or the block's state not
 * kept (a full node keeps about 128 blocks'; some services answer only for
 * the newest block, the app's public fallback among them), as nodes word it.
 */
function refusesProofs(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601 || code === -32004) return true;
  return /method not found|does not exist|not supported|unsupported|not available|not allowed|missing trie node|historical state|state.*(pruned|unavailable)|pruned|header not found|only.*latest|latest.*only|proof window|archive/i.test(
    messageOf(error),
  );
}

/** The checks a proof passes before it is offered for signing, whoever built it. */
function assembleProof(holder: Address, header: CheckedHeader, proof: AccountProof): HolderProof {
  const at = `block ${header.number}`;
  if (lower(proof.address) !== SPX_TOKEN) throw new Error(`the proof at ${at} is of ${proof.address}, not of SPX`);
  if (proof.accountProof.length === 0 || keccak256(proof.accountProof[0]!) !== header.stateRoot) {
    throw new Error(`the proof does not start from ${at}'s state root: it is not a proof of that block's state`);
  }
  const slot = proof.storageProof[0];
  if (proof.storageProof.length !== 1 || slot === undefined) throw new Error(`the proof at ${at} is not of one storage slot`);
  if (slot.key !== spxBalanceSlot(holder)) throw new Error(`the proof at ${at} is of another slot than ${holder}'s SPX balance`);
  if (slot.proof.length === 0 || keccak256(slot.proof[0]!) !== proof.storageHash) {
    throw new Error(`the balance proof does not start from SPX's storage root at ${at}`);
  }
  if (slot.value < MIN_SPX) throw new HoldingBelowMinimumError(holder, header.number, slot.value);
  return {
    holder,
    blockNumber: header.number,
    blockHash: header.hash,
    timestamp: header.timestamp,
    balance: slot.value,
    header: header.rlp,
    accountProof: proof.accountProof,
    storageProof: slot.proof,
    validUntil: header.timestamp + PROOF_TTL,
  };
}

// ─── A proof pasted from another service ──────────────────────────────────────

/** One JSON-RPC request, and its body exactly as it is to be sent. */
export interface ProofRequest {
  method: "eth_getBlockByNumber" | "eth_getProof";
  params: unknown[];
  /** The request as a JSON-RPC body, for `curl --data`. */
  body: string;
}

/**
 * The two requests to run against another network service, by hand, when the
 * person's own refuses `eth_getProof`: the block, and SPX's proof of
 * `holder`'s balance at it. `blockNumber` should come from the person's own
 * service (its `finalized` block), so that the pasted answer can be checked
 * against it. The app shows these; it never sends them anywhere itself.
 */
export function proofRequests(holder: Address, blockNumber: bigint): ProofRequest[] {
  const block = hexQuantity(blockNumber);
  const requests: Omit<ProofRequest, "body">[] = [
    { method: "eth_getBlockByNumber", params: [block, false] },
    { method: "eth_getProof", params: [SPX_TOKEN, [spxBalanceSlot(holder)], block] },
  ];
  return requests.map((request, i) => ({
    ...request,
    body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: request.method, params: request.params }),
  }));
}

/** What a person pasted: a block and a proof, for `holder`, not yet checked against anything. */
export interface PastedProof {
  holder: Address;
  block: RpcBlockHeader;
  proof: AccountProof;
}

/** Text that isn't the two answers `proofRequests` asks for. */
export class PastedProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PastedProofError";
  }
}

/**
 * The block and the proof in pasted text, for `holder`: the two answers to
 * `proofRequests`, as JSON — whole JSON-RPC responses or just their results,
 * one after the other or in an array, in either order. Each is told by its
 * shape (a block has a `stateRoot` and a `hash`; a proof an `accountProof`).
 * Throws `PastedProofError`, in words for the person, when it can't find
 * exactly one of each. Checks nothing else: `checkPastedProof` does.
 */
export function parsePastedProof(text: string, holder: Address): PastedProof {
  let values: unknown[];
  try {
    values = splitJsonValues(text);
  } catch {
    throw new PastedProofError("the pasted text isn't JSON: paste the two answers exactly as the service gave them");
  }
  const found = values.flatMap((value) => (Array.isArray(value) ? value : [value])).map(resultOf);
  const blocks = found.filter(isBlock);
  const proofs = found.map(parseAccountProof).filter((proof): proof is AccountProof => proof !== null);
  if (found.some((value) => value === null)) throw new PastedProofError("one of the pasted answers is an error, not a result: run that request again");
  if (blocks.length !== 1) throw new PastedProofError(blocks.length === 0 ? "the pasted text has no block in it" : "the pasted text has more than one block in it");
  if (proofs.length !== 1) throw new PastedProofError(proofs.length === 0 ? "the pasted text has no proof in it" : "the pasted text has more than one proof in it");
  return { holder: lower(holder), block: blocks[0]!, proof: proofs[0]! };
}

/**
 * A pasted proof, checked before anything is offered for signing:
 *
 * - the pasted block's header, rebuilt, hashes to the hash it states;
 * - the person's own network service has that same hash at that height
 *   (`eth_getBlockByNumber`): the other service is believed about nothing
 *   the person's own can't confirm;
 * - the block is a past one, recent enough for the registry to check (the
 *   last 8,191 by the time it lands);
 * - the proof is SPX's, of this holder's balance slot, from that block's state
 *   root, and shows at least `MIN_SPX`.
 *
 * Throws, in words for the person, at the first that fails; returns the same
 * proof `buildHolderProof` would.
 */
export async function checkPastedProof(rpc: JsonRpc, pasted: PastedProof): Promise<HolderProof> {
  let header: CheckedHeader;
  try {
    header = checkedHeaderOf(pasted.block);
  } catch (error) {
    if (error instanceof HeaderHashMismatchError) throw new PastedProofError(
        "the pasted block's header doesn't hash to the hash it states: paste the answer whole, or, if it was, Ethereum's blocks have changed in a way this copy of spDEX doesn't know",
      );
    throw new PastedProofError(`the pasted block can't be read: ${messageOf(error)}`);
  }
  const head = BigInt((await rpc("eth_blockNumber", [])) as string);
  // The registry looks the hash up in the block that includes the proof, at
  // the earliest the next one: it must still be within the last 8,191 then.
  if (!withinReach(head, header.number)) {
    throw new PastedProofError(
      header.number > head
        ? `the pasted block, ${header.number}, is newer than your network service's newest, ${head}`
        : `the pasted block, ${header.number}, is too old: the registry can check only the last ${PROOF_HISTORY_BLOCKS} blocks`,
    );
  }
  const own = (await rpc("eth_getBlockByNumber", [hexQuantity(header.number), false])) as { hash?: unknown } | null;
  if (own === null || typeof own.hash !== "string") throw new PastedProofError(`your network service has no block ${header.number}`);
  if (own.hash.toLowerCase() !== header.hash) {
    throw new PastedProofError(`the pasted block isn't the block ${header.number} your network service has: its hash is another`);
  }
  try {
    return assembleProof(pasted.holder, header, pasted.proof);
  } catch (error) {
    if (error instanceof HoldingBelowMinimumError) throw error;
    throw new PastedProofError(messageOf(error));
  }
}

/** The values in text holding one or more JSON values, one after another. Throws for anything else. */
function splitJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      if (depth === 0) throw new SyntaxError("a bare string");
      inString = true;
    } else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth < 0) throw new SyntaxError("unbalanced");
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(c)) {
      throw new SyntaxError("text between values");
    }
  }
  if (depth !== 0 || inString || values.length === 0) throw new SyntaxError("incomplete");
  return values;
}

/** A JSON-RPC response's result, or the value itself when it isn't a response; null for an error response. */
function resultOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if ("jsonrpc" in v || "id" in v) return "error" in v ? null : v["result"];
  return value;
}

const isBlock = (value: unknown): value is RpcBlockHeader =>
  typeof value === "object" && value !== null && typeof (value as RpcBlockHeader).stateRoot === "string" && typeof (value as RpcBlockHeader).hash === "string";

// ─── Sending a proof ──────────────────────────────────────────────────────────

/** `prove(holder, header, accountProof, storageProof)`'s calldata, selector 0x0c4ce46d. */
export function encodeProve(proof: Pick<HolderProof, "holder" | "header" | "accountProof" | "storageProof">): Hex {
  return encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "prove",
    args: [lower(proof.holder), proof.header, [...proof.accountProof], [...proof.storageProof]],
  });
}

/**
 * The one transaction that submits a proof: to the registry (this build's by
 * default), no ether, `encodeProve`'s calldata. Anyone may send anyone's
 * proof: it states a fact. One that would not move `validUntil` reverts
 * `NotNewer`, so read `readHolderStatus` first.
 */
export function proveCall(
  proof: Pick<HolderProof, "holder" | "header" | "accountProof" | "storageProof">,
  registry: Address = MAINNET_REGISTRY,
): { to: Address; data: Hex; value: 0n } {
  return { to: lower(registry), data: encodeProve(proof), value: 0n };
}

/** The registry's one event: `holder` proven at `blockNumber`, eligible until `validUntil`. */
export interface ProvenEvent {
  name: "Proven";
  emitter: Address;
  holder: Address;
  blockNumber: bigint;
  /** SPX held at that block, raw units. */
  balance: bigint;
  validUntil: bigint;
}

/**
 * A `Proven` log, decoded; null for any other log. Which contract emitted it
 * is reported as `emitter`: anyone can emit a log shaped like it, so a caller
 * that cares checks it is the registry (`provenBy`).
 */
export function decodeRegistryEvent(log: RawLog): ProvenEvent | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: REGISTRY_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
  } catch {
    return null;
  }
  if (decoded.eventName !== "Proven") return null;
  const { holder, blockNumber, balance, validUntil } = decoded.args;
  return { name: "Proven", emitter: lower(log.address), holder: lower(holder), blockNumber, balance, validUntil: BigInt(validUntil) };
}

/** The `Proven` events `registry` itself emitted in these logs; look-alikes from any other emitter are left out. */
export function provenBy(registry: Address, logs: readonly RawLog[]): ProvenEvent[] {
  const expected = lower(registry);
  return logs.map(decodeRegistryEvent).filter((event): event is ProvenEvent => event?.emitter === expected);
}

/**
 * A registry refusal in words, from `decodeVaultError`'s name and arguments;
 * null for an error that is not the registry's.
 */
export function describeRegistryError(error: { name: string; args: readonly unknown[] } | null): string | null {
  if (error === null) return null;
  const [a, b] = error.args;
  switch (error.name) {
    case "NotNewer":
      return `this address is already proven until ${dateText(a as bigint)}, by a proof as new or newer`;
    case "BelowMinimum":
      return `the address held ${spxText(a as bigint)} SPX at that block; proving takes at least ${spxText(b as bigint)}`;
    case "UnknownBlock":
      return `block ${a} is not one of the last ${PROOF_HISTORY_BLOCKS} the registry can check: build the proof again from a newer block`;
    case "WrongBlockHash":
      return "the header is not the block's: its hash is not the one the chain keeps for that block";
    case "BadHeader":
      return "the header can't be read as a block's";
    case "ZeroHolder":
      return "no address to prove";
    case "BadProofValue":
    case "ProofMismatch":
      return "the proof does not match the block's state";
    default:
      return null;
  }
}

// ─── Reading eligibility ──────────────────────────────────────────────────────

/**
 * Why an address isn't eligible: first the one a proof can't fix (it is a
 * contract), then in the order the registry checks.
 */
export type HolderReason = "not-proven" | "lapsed" | "contract" | "below-minimum";

export type HolderStatus =
  | { state: "not-deployed"; registry: Address; holder: Address; block: bigint | null; chainTime: bigint | null }
  | {
      state: "read";
      registry: Address;
      holder: Address;
      /** The block every figure was read at, when the read named one or could say. */
      block: bigint | null;
      /** That block's time: what validity is judged against, never the wall clock. */
      chainTime: bigint | null;
      /** The registry's own answer, `isEligible(holder)`. */
      eligible: boolean | null;
      /** Until when, inclusive, its proof is valid; 0 when it never proved. */
      validUntil: bigint | null;
      /** Whether a proof is valid at `chainTime` (`chainTime ≤ validUntil`). */
      proofValid: boolean | null;
      /** A valid proof that lapses within `PROOF_LAPSE_WARNING_SECONDS`. */
      lapsesSoon: boolean | null;
      /** No code, or only an EIP-7702 delegation: the only kind of address the registry finds eligible. */
      isAccount: boolean | null;
      /** SPX held now, raw units. */
      balance: bigint | null;
      /** How much SPX short of `MIN_SPX` it is now: 0 when it holds enough. */
      shortfall: bigint | null;
      /**
       * The first reason it isn't eligible — "contract" before any other,
       * since no proof can fix it — then by the registry's own order; null
       * when it is eligible, or when unknown (its code unread included).
       */
      reason: HolderReason | null;
    };

const SPX_BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MULTICALL3_CLOCK_ABI = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)", "function getBlockNumber() view returns (uint256)"]);

/**
 * Whether `holder` may be paid as a community keeper, and every figure that
 * decides it, at one block (`block`, or the newest): the registry's own
 * `isEligible`, `validUntil`, SPX's `balanceOf` and the block's time and
 * number in one Multicall3 call, then the holder's code at that block — so a
 * contract is told that it can't be a keeper's `rewardTo` before anyone pays
 * for a proof. A registry with no code is `not-deployed`. Every figure that
 * can't be read is `null`, never zero or false.
 */
export async function readHolderStatus(
  rpc: JsonRpc,
  holder: Address,
  options: { registry?: Address; block?: bigint; reader?: Pick<Multicall3Reader, "multicall"> } = {},
): Promise<HolderStatus> {
  const registry = lower(options.registry ?? MAINNET_REGISTRY);
  const who = lower(holder);
  const reader = options.reader ?? new Multicall3Reader(rpc);
  const blockTag = options.block === undefined ? "latest" : hexQuantity(options.block);
  const results = await reader.multicall(
    [
      { to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "validUntil", args: [who] }) },
      { to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "isEligible", args: [who] }) },
      { to: SPX_TOKEN, data: encodeFunctionData({ abi: SPX_BALANCE_ABI, functionName: "balanceOf", args: [who] }) },
      { to: CONTRACTS.multicall3, data: encodeFunctionData({ abi: MULTICALL3_CLOCK_ABI, functionName: "getCurrentBlockTimestamp" }) },
      { to: CONTRACTS.multicall3, data: encodeFunctionData({ abi: MULTICALL3_CLOCK_ABI, functionName: "getBlockNumber" }) },
    ],
    { blockTag },
  );
  const validUntil = decodeOr(results[0], (d) => BigInt(decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "validUntil", data: d })));
  const eligible = decodeOr(results[1], (d) => decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "isEligible", data: d }));
  const balance = decodeOr(results[2], (d) => decodeFunctionResult({ abi: SPX_BALANCE_ABI, functionName: "balanceOf", data: d }));
  const chainTime = decodeOr(results[3], (d) => decodeFunctionResult({ abi: MULTICALL3_CLOCK_ABI, functionName: "getCurrentBlockTimestamp", data: d }));
  const block = options.block ?? decodeOr(results[4], (d) => decodeFunctionResult({ abi: MULTICALL3_CLOCK_ABI, functionName: "getBlockNumber", data: d }));
  const at = block === null ? "latest" : hexQuantity(block);

  // Through Multicall3, an address with no code answers nothing, as a call that
  // failed does: only its code tells "not deployed" from "unreadable".
  if (validUntil === null && eligible === null && (await codeAt(rpc, registry, at)) === "0x") {
    return { state: "not-deployed", registry, holder: who, block, chainTime };
  }
  const code = await codeAt(rpc, who, at);
  const isAccount = code === null ? null : code === "0x" || (code.length === 2 + 2 * 23 && code.toLowerCase().startsWith("0xef0100"));
  const proofValid = validUntil === null || chainTime === null ? null : chainTime <= validUntil;
  const lapsesSoon = proofValid === null ? null : proofValid && validUntil! - chainTime! <= PROOF_LAPSE_WARNING_SECONDS;
  const shortfall = balance === null ? null : balance >= MIN_SPX ? 0n : MIN_SPX - balance;
  return {
    state: "read",
    registry,
    holder: who,
    block,
    chainTime,
    eligible,
    validUntil,
    proofValid,
    lapsesSoon,
    isAccount,
    balance,
    shortfall,
    reason: reasonOf({ validUntil, proofValid, isAccount, shortfall }),
  };
}

/**
 * The first reason it isn't eligible; null when none applies, or when one is
 * unknown before any is found. The one reason no proof can fix comes first:
 * a contract that never proved, or whose proof lapsed, is told it is a
 * contract, not invited to pay about 650,000 gas for a proof the registry
 * would record and never honour. Then the registry's own order: a proof, then
 * the holding now.
 */
function reasonOf(s: { validUntil: bigint | null; proofValid: boolean | null; isAccount: boolean | null; shortfall: bigint | null }): HolderReason | null {
  if (s.isAccount === null) return null;
  if (!s.isAccount) return "contract";
  if (s.validUntil === null || s.proofValid === null) return null;
  if (s.validUntil === 0n) return "not-proven";
  if (!s.proofValid) return "lapsed";
  if (s.shortfall === null) return null;
  return s.shortfall > 0n ? "below-minimum" : null;
}

/** An address's code at a block, or null when the service won't say. */
async function codeAt(rpc: JsonRpc, address: Address, block: Hex | "latest"): Promise<string | null> {
  try {
    const code = await rpc("eth_getCode", [address, block]);
    return typeof code === "string" && /^0x[0-9a-fA-F]*$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Why a read status isn't eligible, in plain words for the panel and the
 * keeper's log; null when it is eligible or the reason is unknown.
 */
export function holderReasonText(status: HolderStatus): string | null {
  if (status.state !== "read") return null;
  switch (status.reason) {
    case "not-proven":
      return "This address has never proven its SPX.";
    case "lapsed":
      return `Its proof lapsed on ${dateText(status.validUntil!)}; prove it again.`;
    case "contract":
      return "Only an ordinary account can be paid as a community keeper; this address is a contract.";
    case "below-minimum":
      return `It holds ${spxText(status.balance!)} of the ${spxText(MIN_SPX)} SPX it needs now.`;
    default:
      return null;
  }
}

// ─── Plumbing ─────────────────────────────────────────────────────────────────

const lower = (a: string): Address => a.toLowerCase() as Address;

const hexQuantity = (n: bigint): Hex => `0x${n.toString(16)}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whole SPX, rounded down, with thousands separated: "1,210". */
function spxText(raw: bigint): string {
  return (raw / 100_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A chain time as a UTC date: "2026-10-26". */
function dateText(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}
