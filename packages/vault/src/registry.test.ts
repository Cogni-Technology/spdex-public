/**
 * The SPX holder registry's TypeScript side against scripted services and
 * recorded mainnet proofs: no node, no network.
 *
 * The proofs are `test/fixtures/proofs/*.json`, recorded from an archive
 * endpoint by `scripts/record-proofs.mjs` — the same files the registry's
 * forge tests prove on chain (`test/forge/Registry.t.sol`). What these pin is
 * everything that happens before a proof is offered for signing: a header
 * that doesn't hash to its block is refused, so is a proof of the wrong
 * block's state or the wrong slot, and so is a holding below the minimum; a
 * service that won't answer `eth_getProof` is told apart from one that failed;
 * a pasted proof is believed only as far as the person's own service confirms
 * it; and eligibility reads unknown, never zero or false. That the registry
 * accepts what is built here is `test/integration/registry.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, fromRlp, keccak256, toFunctionSelector, toRlp } from "viem";
import type { Address, Hex } from "@spdex/core";
import { HeaderHashMismatchError, type JsonRpc, type RpcBlockHeader } from "@spdex/chain";
import { MAINNET_REGISTRY, REGISTRY_ABI, SPX_TOKEN } from "./artifacts.js";
import {
  BlockOutOfReachError,
  HoldingBelowMinimumError,
  MIN_SPX,
  PROOF_HISTORY_BLOCKS,
  PROOF_LAPSE_WARNING_SECONDS,
  PROOF_TTL,
  PROVE_GAS_CAP,
  PastedProofError,
  ProofUnavailableError,
  buildHolderProof,
  checkPastedProof,
  decodeRegistryEvent,
  describeRegistryError,
  encodeProve,
  holderReasonText,
  parsePastedProof,
  proofRequests,
  proveCall,
  proveGasLimit,
  provenBy,
  readHolderStatus,
  spxBalanceSlot,
} from "./registry.js";
import block25999900 from "../../chain/test/fixtures/block-25999900.json";
import holder25999900 from "../test/fixtures/proofs/holder-b0072e68-25999900.json";
import holder26000000 from "../test/fixtures/proofs/holder-b0072e68-26000000.json";
import below25999000 from "../test/fixtures/proofs/holder-d75110fc-25999000.json";
import short26000000 from "../test/fixtures/proofs/holder-cc01ef33-26000000.json";

interface Recorded {
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

const HOLDER = holder25999900.holder.toLowerCase() as Address;
const DAY = 86_400n;

/** The names of a header's fields, in order, and which are quantities. */
const FIELDS: [keyof RpcBlockHeader, boolean][] = [
  ["parentHash", false],
  ["sha3Uncles", false],
  ["miner", false],
  ["stateRoot", false],
  ["transactionsRoot", false],
  ["receiptsRoot", false],
  ["logsBloom", false],
  ["difficulty", true],
  ["number", true],
  ["gasLimit", true],
  ["gasUsed", true],
  ["timestamp", true],
  ["extraData", false],
  ["mixHash", false],
  ["nonce", false],
  ["baseFeePerGas", true],
  ["withdrawalsRoot", false],
  ["blobGasUsed", true],
  ["excessBlobGas", true],
  ["parentBeaconBlockRoot", false],
  ["requestsHash", false],
];

/**
 * A block's JSON as a service answers it, from a recorded header: for the
 * fixtures recorded without one. `@spdex/chain`'s header tests hold the
 * rebuilding to real JSON; here it only has to give back the same bytes.
 */
function blockOf(recorded: Recorded): RpcBlockHeader {
  const items = fromRlp(recorded.header as Hex, "hex") as Hex[];
  const block: Record<string, string> = { hash: recorded.blockHash };
  items.forEach((item, i) => {
    const [name, quantity] = FIELDS[i]!;
    block[name] = quantity ? `0x${(item === "0x" ? 0n : BigInt(item)).toString(16)}` : item;
  });
  return block as unknown as RpcBlockHeader;
}

/** `eth_getProof`'s answer for a recorded proof, as a node gives it. */
function proofAnswer(recorded: Recorded) {
  return {
    address: SPX_TOKEN,
    accountProof: recorded.accountProof,
    balance: "0x0",
    codeHash: `0x${"ab".repeat(32)}`,
    nonce: "0x1",
    storageHash: keccak256(recorded.storageProof[0] as Hex),
    storageProof: [{ key: recorded.storageKey, value: `0x${BigInt(recorded.balance).toString(16)}`, proof: recorded.storageProof }],
  };
}

/**
 * A network service: `blocks` by number and for "finalized", `proofs` by
 * block number (or a refusal to throw), and a head. Notes every request.
 */
function service(input: {
  blocks: Record<string, RpcBlockHeader | null>;
  proofs?: Record<string, unknown>;
  refuse?: Error;
  head?: bigint;
}) {
  const asked: { method: string; params: unknown[] }[] = [];
  const rpc: JsonRpc = async (method, params) => {
    asked.push({ method, params });
    if (method === "eth_blockNumber") return `0x${(input.head ?? 26_000_000n).toString(16)}`;
    if (method === "eth_getBlockByNumber") return input.blocks[params[0] as string] ?? null;
    if (method === "eth_getProof") {
      if (input.refuse) throw input.refuse;
      return input.proofs?.[params[2] as string] ?? null;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, asked };
}

const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;

/** A service holding the recorded block 25,999,900 as "finalized", and the holder's proof at it. */
const holderService = (overrides: Partial<Parameters<typeof service>[0]> = {}) =>
  service({
    blocks: { finalized: block25999900, [hex(25_999_900)]: block25999900 },
    proofs: { [hex(25_999_900)]: proofAnswer(holder25999900) },
    ...overrides,
  });

/**
 * Block 25,999,900 as a service would answer it after a hard fork this build
 * doesn't know added a 22nd header field: the answer names it
 * (`blockAccessListHash`, a hash), and the block's hash is that 22-field
 * header's.
 */
function afterNewFork(): { block: RpcBlockHeader; header: Hex } {
  const added = `0x${"cd".repeat(32)}` as Hex;
  const header = toRlp([...(fromRlp(holder25999900.header as Hex, "hex") as Hex[]), added]) as Hex;
  return { block: { ...block25999900, blockAccessListHash: added, hash: keccak256(header) } as unknown as RpcBlockHeader, header };
}

describe("the registry's constants", () => {
  it("are 690 SPX, 30 days, the last 8,191 blocks, and a warning from 5 days before a proof lapses", () => {
    expect(MIN_SPX).toBe(690n * 10n ** 8n);
    expect(PROOF_TTL).toBe(30n * DAY);
    expect(PROOF_HISTORY_BLOCKS).toBe(8_191n);
    expect(PROOF_LAPSE_WARNING_SECONDS).toBe(5n * DAY);
    expect(PROVE_GAS_CAP).toBe(750_000n);
  });

  it("finds a holder's SPX balance at the slot every recorded proof was taken at", () => {
    for (const recorded of [holder25999900, holder26000000, below25999000, short26000000] as Recorded[]) {
      expect(spxBalanceSlot(recorded.holder as Address)).toBe(recorded.storageKey);
      // Whatever the address's case.
      expect(spxBalanceSlot(recorded.holder.toUpperCase().replace("0X", "0x") as Address)).toBe(recorded.storageKey);
    }
  });
});

describe("sending a proof", () => {
  it("encodes prove(holder, header, accountProof, storageProof), to the registry, with no ether", () => {
    const proof = { holder: HOLDER, header: holder25999900.header as Hex, accountProof: holder25999900.accountProof as Hex[], storageProof: holder25999900.storageProof as Hex[] };
    const data = encodeProve(proof);
    expect(data.slice(0, 10)).toBe("0x0c4ce46d");
    expect(data.slice(0, 10)).toBe(toFunctionSelector("prove(address,bytes,bytes[],bytes[])"));
    const decoded = decodeFunctionData({ abi: REGISTRY_ABI, data });
    expect(decoded.functionName).toBe("prove");
    expect(decoded.args).toEqual([
      expect.stringMatching(new RegExp(HOLDER.slice(2), "i")),
      holder25999900.header.toLowerCase(),
      holder25999900.accountProof.map((n) => n.toLowerCase()),
      holder25999900.storageProof.map((n) => n.toLowerCase()),
    ]);
    expect(proveCall(proof)).toEqual({ to: MAINNET_REGISTRY, data, value: 0n });
    expect(proveCall(proof, "0x00000000000000000000000000000000000000AB" as Address).to).toBe("0x00000000000000000000000000000000000000ab");
  });

  it("is signed with its estimate and a fifth, at most 750,000 gas, and never with less than its estimate", () => {
    expect(proveGasLimit(560_000n)).toBe(672_000n);
    expect(proveGasLimit(659_010n)).toBe(750_000n);
    expect(proveGasLimit(750_000n)).toBe(750_000n);
    expect(proveGasLimit(null)).toBe(750_000n);
    expect(() => proveGasLimit(750_001n)).toThrow(RangeError);
    expect(() => proveGasLimit(-1n)).toThrow(RangeError);
  });

  it("reads the registry's Proven, and only from the registry itself", () => {
    const log = (address: string) => ({
      address,
      topics: encodeEventTopics({ abi: REGISTRY_ABI, eventName: "Proven", args: { holder: HOLDER, blockNumber: 25_999_900n } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [130_823_540_032n, 1_792_272_539n]),
    });
    expect(log(MAINNET_REGISTRY).topics[0]).toBe("0x899c4dc60873db3d707c4ae0cd1fdb927d924f249998fcdd2ce20f994384b686");
    const proven = { name: "Proven", emitter: MAINNET_REGISTRY, holder: HOLDER, blockNumber: 25_999_900n, balance: 130_823_540_032n, validUntil: 1_792_272_539n };
    expect(decodeRegistryEvent(log(MAINNET_REGISTRY.toUpperCase().replace("0X", "0x")))).toEqual(proven);
    const forger = "0x00000000000000000000000000000000000000f0";
    expect(provenBy(MAINNET_REGISTRY, [log(forger), log(MAINNET_REGISTRY)])).toEqual([proven]);
    expect(decodeRegistryEvent({ ...log(MAINNET_REGISTRY), data: "0x12" })).toBeNull();
  });

  it("words every refusal the registry can give, and every way a proof fails to match as one", () => {
    expect(describeRegistryError({ name: "NotNewer", args: [1_792_272_539n] })).toBe("this address is already proven until 2026-10-17, by a proof as new or newer");
    expect(describeRegistryError({ name: "BelowMinimum", args: [21_300_000_000n, MIN_SPX] })).toBe("the address held 213 SPX at that block; proving takes at least 690");
    expect(describeRegistryError({ name: "UnknownBlock", args: [25_991_808n] })).toMatch(/block 25991808 is not one of the last 8191/);
    expect(describeRegistryError({ name: "WrongBlockHash", args: [] })).toMatch(/not the block's/);
    expect(describeRegistryError({ name: "ProofMismatch", args: ["MerkleTrie: invalid large internal hash"] })).toBe("the proof does not match the block's state");
    expect(describeRegistryError({ name: "BadProofValue", args: [] })).toBe("the proof does not match the block's state");
    expect(describeRegistryError({ name: "TooSoon", args: [1n] })).toBeNull();
    expect(describeRegistryError(null)).toBeNull();
  });
});

describe("buildHolderProof", () => {
  it("proves the finalized block's holding from the service's own answers, the header rebuilt and checked", async () => {
    const { rpc, asked } = holderService();
    const proof = await buildHolderProof(rpc, HOLDER);
    expect(proof).toEqual({
      holder: HOLDER,
      blockNumber: 25_999_900n,
      blockHash: holder25999900.blockHash,
      timestamp: BigInt(holder25999900.timestamp),
      balance: BigInt(holder25999900.balance),
      header: holder25999900.header.toLowerCase(),
      accountProof: holder25999900.accountProof.map((n) => n.toLowerCase()),
      storageProof: holder25999900.storageProof.map((n) => n.toLowerCase()),
      validUntil: BigInt(holder25999900.timestamp) + PROOF_TTL,
    });
    // The finalized block first, then the proof pinned to its number, never to a tag.
    expect(asked).toEqual([
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
      { method: "eth_getProof", params: [SPX_TOKEN, [holder25999900.storageKey], "0x18cba1c"] },
    ]);
  });

  it("builds at a block it is given, by number, once the service's newest block says the registry can still check it", async () => {
    const { rpc, asked } = holderService();
    expect((await buildHolderProof(rpc, HOLDER, { block: 25_999_900n })).blockNumber).toBe(25_999_900n);
    expect(asked).toEqual([
      { method: "eth_blockNumber", params: [] },
      { method: "eth_getBlockByNumber", params: ["0x18cba1c", false] },
      { method: "eth_getProof", params: [SPX_TOKEN, [holder25999900.storageKey], "0x18cba1c"] },
    ]);
  });

  it("refuses a block given by number that the registry could no longer check when the proof lands, or that the service hasn't reached, asking nothing more", async () => {
    const BLOCK = 25_999_900n;
    const at = (head: bigint) => holderService({ head });
    // Landing at the earliest in the next block: 8,191 back from it is the oldest the registry checks, as for a pasted proof.
    await expect(buildHolderProof(at(BLOCK + PROOF_HISTORY_BLOCKS - 1n).rpc, HOLDER, { block: BLOCK })).resolves.toMatchObject({ blockNumber: BLOCK });
    const tooOld = at(BLOCK + PROOF_HISTORY_BLOCKS);
    const old = await buildHolderProof(tooOld.rpc, HOLDER, { block: BLOCK }).catch((e: unknown) => e);
    expect(old).toBeInstanceOf(BlockOutOfReachError);
    expect(old).toMatchObject({ blockNumber: BLOCK, head: BLOCK + PROOF_HISTORY_BLOCKS });
    expect((old as Error).message).toBe(`block ${BLOCK} is too old to prove: the registry can check only the last 8191 blocks, and the newest is ${BLOCK + PROOF_HISTORY_BLOCKS}`);
    expect(tooOld.asked.map((a) => a.method)).toEqual(["eth_blockNumber"]);
    await expect(buildHolderProof(at(BLOCK).rpc, HOLDER, { block: BLOCK })).resolves.toMatchObject({ blockNumber: BLOCK });
    const ahead = at(BLOCK - 1n);
    await expect(buildHolderProof(ahead.rpc, HOLDER, { block: BLOCK })).rejects.toThrow(`block ${BLOCK} is newer than the network service's newest, ${BLOCK - 1n}`);
    expect(ahead.asked.map((a) => a.method)).toEqual(["eth_blockNumber"]);
  });

  it("refuses a block whose header doesn't hash to its hash, before asking for any proof", async () => {
    const { requestsHash: _gone, ...missing } = block25999900;
    const { rpc, asked } = holderService({ blocks: { finalized: missing as RpcBlockHeader } });
    await expect(buildHolderProof(rpc, HOLDER)).rejects.toThrow(HeaderHashMismatchError);
    expect(asked.map((a) => a.method)).toEqual(["eth_getBlockByNumber"]);
  });

  it("builds from a block of a hard fork this build doesn't know, with the field its service names appended, rather than stop proving until a new build", async () => {
    const { block, header } = afterNewFork();
    const { rpc } = holderService({ blocks: { finalized: block } });
    const proof = await buildHolderProof(rpc, HOLDER);
    expect(proof.header).toBe(header);
    expect((fromRlp(proof.header, "hex") as Hex[]).length).toBe(22);
    expect(proof).toMatchObject({ blockNumber: 25_999_900n, blockHash: keccak256(header), timestamp: BigInt(holder25999900.timestamp) });
    expect(proof.accountProof).toEqual(holder25999900.accountProof.map((n) => n.toLowerCase()));
  });

  it("refuses a holding below 690 SPX at the block, with what it held", async () => {
    const recorded = below25999000 as Recorded;
    const { rpc } = service({ blocks: { finalized: blockOf(recorded) }, proofs: { [hex(recorded.blockNumber)]: proofAnswer(recorded) } });
    const holder = recorded.holder as Address;
    await expect(buildHolderProof(rpc, holder)).rejects.toThrow(HoldingBelowMinimumError);
    await expect(buildHolderProof(rpc, holder)).rejects.toMatchObject({ balance: 21_300_000_000n, blockNumber: 25_999_000n });
    await expect(buildHolderProof(rpc, holder)).rejects.toThrow(/held 213 SPX at block 25999000; proving takes at least 690/);
  });

  it("says the service won't give proofs when it refuses the method or the block's state, and passes on any other failure", async () => {
    const refusals = [
      Object.assign(new Error("eth_getProof: the method eth_getProof does not exist/is not available"), { code: -32601 }),
      Object.assign(new Error("eth_getProof: method not supported"), { code: -32004 }),
      new Error("eth_getProof: missing trie node 1f2e… (path ) state 0x… is not available"),
      new Error("eth_getProof: proofs are available only for the 'latest' block"),
      new Error("eth_getProof: distance to target block exceeds maximum proof window"),
    ];
    for (const refuse of refusals) {
      const error = await buildHolderProof(holderService({ refuse }).rpc, HOLDER).catch((e: unknown) => e);
      expect(error, refuse.message).toBeInstanceOf(ProofUnavailableError);
      expect(error).toMatchObject({ blockNumber: 25_999_900n, cause: refuse });
    }
    const down = new Error("fetch failed");
    await expect(buildHolderProof(holderService({ refuse: down }).rpc, HOLDER)).rejects.toBe(down);
  });

  it("refuses a proof of another block's state, of another holder's slot, or of another contract", async () => {
    const other = holder26000000 as Recorded;
    const another = (answer: unknown) => holderService({ proofs: { [hex(25_999_900)]: answer } }).rpc;
    // The pinned block's proof, offered for block 25,999,900.
    await expect(buildHolderProof(another(proofAnswer(other)), HOLDER)).rejects.toThrow(/does not start from block 25999900's state root/);
    // Another holder's slot.
    await expect(buildHolderProof(another(proofAnswer(below25999000 as Recorded)), HOLDER)).rejects.toThrow();
    const wrongSlot = { ...proofAnswer(holder25999900 as Recorded), storageProof: [{ ...proofAnswer(holder25999900 as Recorded).storageProof[0]!, key: (short26000000 as Recorded).storageKey }] };
    await expect(buildHolderProof(another(wrongSlot), HOLDER)).rejects.toThrow(/another slot than/);
    await expect(buildHolderProof(another({ ...proofAnswer(holder25999900 as Recorded), address: MAINNET_REGISTRY }), HOLDER)).rejects.toThrow(/not of SPX/);
    await expect(buildHolderProof(another({ ...proofAnswer(holder25999900 as Recorded), storageHash: `0x${"00".repeat(32)}` }), HOLDER)).rejects.toThrow(
      /storage root/,
    );
  });
});

describe("a proof pasted from another service", () => {
  const BLOCK = 25_999_900n;

  it("is asked for with the exact requests to run elsewhere: the block, and SPX's proof of the holder's slot at it", () => {
    expect(proofRequests(HOLDER, BLOCK)).toEqual([
      {
        method: "eth_getBlockByNumber",
        params: ["0x18cba1c", false],
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x18cba1c",false]}',
      },
      {
        method: "eth_getProof",
        params: [SPX_TOKEN, [holder25999900.storageKey], "0x18cba1c"],
        body: `{"jsonrpc":"2.0","id":2,"method":"eth_getProof","params":["${SPX_TOKEN}",["${holder25999900.storageKey}"],"0x18cba1c"]}`,
      },
    ]);
  });

  const response = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
  const pastedText = `${response(1, block25999900)}\n${response(2, proofAnswer(holder25999900))}`;

  it("reads the two answers as they were pasted: one after the other, in a batch, either order, or bare results", () => {
    const parsed = parsePastedProof(pastedText, HOLDER);
    expect(parsed.holder).toBe(HOLDER);
    expect(parsed.block.hash).toBe(holder25999900.blockHash);
    expect(parsed.proof.storageProof[0]!.key).toBe(holder25999900.storageKey);
    const batch = `[${response(2, proofAnswer(holder25999900))}, ${response(1, block25999900)}]`;
    expect(parsePastedProof(batch, HOLDER)).toEqual(parsed);
    const bare = `  ${JSON.stringify(proofAnswer(holder25999900))}\n\n${JSON.stringify(block25999900)}  `;
    expect(parsePastedProof(bare, HOLDER)).toEqual(parsed);
  });

  it("says what is wrong with pasted text that isn't the two answers", () => {
    const refuses = (text: string, words: RegExp) => {
      expect(() => parsePastedProof(text, HOLDER)).toThrow(PastedProofError);
      expect(() => parsePastedProof(text, HOLDER)).toThrow(words);
    };
    refuses("", /isn't JSON/);
    refuses("curl: (6) Could not resolve host", /isn't JSON/);
    refuses(`${response(1, block25999900)} trailing words`, /isn't JSON/);
    refuses(response(1, block25999900), /no proof/);
    refuses(response(2, proofAnswer(holder25999900)), /no block/);
    refuses(`${pastedText}${response(3, block25999900)}`, /more than one block/);
    refuses(`${pastedText}${JSON.stringify({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "missing trie node" } })}`, /is an error/);
  });

  it("is checked against the person's own service before it is offered: the same block, recent enough, and enough SPX", async () => {
    const pasted = parsePastedProof(pastedText, HOLDER);
    const own = holderService();
    const proof = await checkPastedProof(own.rpc, pasted);
    expect(proof).toEqual(await buildHolderProof(holderService().rpc, HOLDER));
    // Only the head and the block's hash were asked of the person's own service: never the proof.
    expect(own.asked.map((a) => a.method)).toEqual(["eth_blockNumber", "eth_getBlockByNumber"]);
  });

  it("takes a pasted block of a hard fork this build doesn't know, when the field its answer names makes it hash", async () => {
    const { block, header } = afterNewFork();
    const pasted = parsePastedProof(`${response(1, block)}\n${response(2, proofAnswer(holder25999900))}`, HOLDER);
    const own = holderService({ blocks: { [hex(BLOCK)]: block } });
    expect((await checkPastedProof(own.rpc, pasted)).header).toBe(header);
  });

  it("refuses a pasted block the person's own service has another hash for, or none", async () => {
    const pasted = parsePastedProof(pastedText, HOLDER);
    const elsewhere = service({ blocks: { [hex(BLOCK)]: { ...block25999900, hash: `0x${"11".repeat(32)}` } } });
    await expect(checkPastedProof(elsewhere.rpc, pasted)).rejects.toThrow(/isn't the block 25999900 your network service has/);
    await expect(checkPastedProof(service({ blocks: {} }).rpc, pasted)).rejects.toThrow(/has no block 25999900/);
  });

  it("refuses a pasted block too old for the registry to check, or newer than the person's own service knows", async () => {
    const pasted = parsePastedProof(pastedText, HOLDER);
    const at = (head: bigint) => holderService({ head }).rpc;
    // Landing at the earliest in the next block: 8,191 back from it is the oldest the registry checks.
    await expect(checkPastedProof(at(BLOCK + PROOF_HISTORY_BLOCKS - 1n), pasted)).resolves.toMatchObject({ blockNumber: BLOCK });
    await expect(checkPastedProof(at(BLOCK + PROOF_HISTORY_BLOCKS), pasted)).rejects.toThrow(/too old: the registry can check only the last 8191 blocks/);
    await expect(checkPastedProof(at(BLOCK), pasted)).resolves.toMatchObject({ blockNumber: BLOCK });
    await expect(checkPastedProof(at(BLOCK - 1n), pasted)).rejects.toThrow(/newer than your network service's newest/);
  });

  it("refuses a pasted block that doesn't hash to its own hash, and a proof that doesn't match it, before asking anything", async () => {
    const pasted = parsePastedProof(pastedText, HOLDER);
    const own = holderService();
    await expect(checkPastedProof(own.rpc, { ...pasted, block: { ...pasted.block, timestamp: "0x1" } })).rejects.toThrow(/doesn't hash to the hash it states/);
    expect(own.asked).toEqual([]);
    const wrong = parsePastedProof(`${response(1, block25999900)}${response(2, proofAnswer(holder26000000))}`, HOLDER);
    await expect(checkPastedProof(own.rpc, wrong)).rejects.toThrow(PastedProofError);
    await expect(checkPastedProof(own.rpc, { ...pasted, holder: (short26000000 as Recorded).holder as Address })).rejects.toThrow(/another slot/);
  });

  it("refuses a pasted holding below 690 SPX with what it held", async () => {
    const recorded = below25999000 as Recorded;
    const pasted = parsePastedProof(`${response(1, blockOf(recorded))}${response(2, proofAnswer(recorded))}`, recorded.holder as Address);
    const own = service({ blocks: { [hex(recorded.blockNumber)]: blockOf(recorded) } });
    await expect(checkPastedProof(own.rpc, pasted)).rejects.toThrow(HoldingBelowMinimumError);
  });
});

describe("readHolderStatus", () => {
  const NOW = 1_790_000_000n;
  const BLOCK_NUMBER = 26_000_100n;
  const sel = (signature: string) => toFunctionSelector(signature);
  const word = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);

  /**
   * A chain where the registry holds `validUntil` for the holder and answers
   * `eligible`, SPX holds `balance`, and the holder's code is `code`; any of
   * them `undefined` is a call that fails.
   */
  function chain(input: { validUntil?: bigint | undefined; eligible?: boolean | undefined; balance?: bigint | undefined; code?: string | undefined; registryCode?: string; now?: bigint }) {
    const reads: { calls: { to: Address; data: Hex }[]; blockTag: unknown }[] = [];
    const answers: Record<string, Hex | undefined> = {
      [`${MAINNET_REGISTRY}:${sel("validUntil(address)")}`]:
        input.validUntil === undefined ? undefined : encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "validUntil", result: input.validUntil }),
      [`${MAINNET_REGISTRY}:${sel("isEligible(address)")}`]:
        input.eligible === undefined ? undefined : encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "isEligible", result: input.eligible }),
      [`${SPX_TOKEN}:${sel("balanceOf(address)")}`]: input.balance === undefined ? undefined : word(input.balance),
      [`0xca11bde05977b3631167028862be2a173976ca11:${sel("getCurrentBlockTimestamp()")}`]: word(input.now ?? NOW),
      [`0xca11bde05977b3631167028862be2a173976ca11:${sel("getBlockNumber()")}`]: word(BLOCK_NUMBER),
    };
    const reader = {
      multicall: async (calls: { to: Address; data: Hex }[], options: { blockTag?: unknown } = {}) => {
        reads.push({ calls, blockTag: options.blockTag });
        return calls.map((call) => answers[`${call.to.toLowerCase()}:${call.data.slice(0, 10)}`] ?? "0x");
      },
    };
    const codes: unknown[][] = [];
    const rpc: JsonRpc = async (method, params) => {
      if (method !== "eth_getCode") throw new Error(`unexpected ${method}`);
      codes.push(params);
      const at = params[0] as string;
      const code = at === MAINNET_REGISTRY ? (input.registryCode ?? "0x60") : input.code;
      if (code === undefined) throw new Error("eth_getCode: upstream timed out");
      return code;
    };
    return { rpc, reader, reads, codes };
  }

  const eligibleHolder = { validUntil: NOW + 20n * DAY, eligible: true, balance: 1_210n * 10n ** 8n, code: "0x" };

  it("reads an eligible account's every figure at one block: its proof, its code and its SPX", async () => {
    const { rpc, reader, reads, codes } = chain(eligibleHolder);
    expect(await readHolderStatus(rpc, HOLDER, { reader })).toEqual({
      state: "read",
      registry: MAINNET_REGISTRY,
      holder: HOLDER,
      block: BLOCK_NUMBER,
      chainTime: NOW,
      eligible: true,
      validUntil: NOW + 20n * DAY,
      proofValid: true,
      lapsesSoon: false,
      isAccount: true,
      balance: 1_210n * 10n ** 8n,
      shortfall: 0n,
      reason: null,
    });
    // One Multicall3 call, then the holder's code at the block it was answered at.
    expect(reads).toHaveLength(1);
    expect(reads[0]!.blockTag).toBe("latest");
    expect(codes).toEqual([[HOLDER, `0x${BLOCK_NUMBER.toString(16)}`]]);
  });

  it("counts a proof valid through the second it names, and not one after, as the registry does", async () => {
    const through = chain({ ...eligibleHolder, validUntil: NOW });
    expect(await readHolderStatus(through.rpc, HOLDER, { reader: through.reader })).toMatchObject({ proofValid: true, lapsesSoon: true, reason: null });
    const after = chain({ ...eligibleHolder, validUntil: NOW - 1n, eligible: false });
    const lapsed = await readHolderStatus(after.rpc, HOLDER, { reader: after.reader });
    expect(lapsed).toMatchObject({ proofValid: false, lapsesSoon: false, reason: "lapsed" });
    expect(holderReasonText(lapsed)).toBe("Its proof lapsed on 2026-09-21; prove it again.");
  });

  it("warns from five days before a proof lapses, and not a second sooner", async () => {
    const at = async (left: bigint) => {
      const c = chain({ ...eligibleHolder, validUntil: NOW + left });
      const status = await readHolderStatus(c.rpc, HOLDER, { reader: c.reader });
      return status.state === "read" ? status.lapsesSoon : undefined;
    };
    expect(await at(PROOF_LAPSE_WARNING_SECONDS)).toBe(true);
    expect(await at(PROOF_LAPSE_WARNING_SECONDS + 1n)).toBe(false);
  });

  it("says a contract can never be paid as a community keeper, whatever it holds, and a delegated account can", async () => {
    const contract = chain({ ...eligibleHolder, eligible: false, code: "0x6080604052" });
    const status = await readHolderStatus(contract.rpc, HOLDER, { reader: contract.reader });
    expect(status).toMatchObject({ isAccount: false, eligible: false, proofValid: true, shortfall: 0n, reason: "contract" });
    expect(holderReasonText(status)).toBe("Only an ordinary account can be paid as a community keeper; this address is a contract.");
    // An EIP-7702 delegation designator: 0xef0100 and an address, 23 bytes, is still an account.
    const delegated = chain({ ...eligibleHolder, code: `0xef0100${"12".repeat(20)}` });
    expect(await readHolderStatus(delegated.rpc, HOLDER, { reader: delegated.reader })).toMatchObject({ isAccount: true, reason: null });
    // Anything longer is a contract's code.
    const longer = chain({ ...eligibleHolder, eligible: false, code: `0xef0100${"12".repeat(21)}` });
    expect(await readHolderStatus(longer.rpc, HOLDER, { reader: longer.reader })).toMatchObject({ isAccount: false, reason: "contract" });
  });

  it("tells a contract that never proved, or whose proof lapsed, that it is a contract: never invited to pay for a proof that can't make it eligible", async () => {
    // The SPX/WETH pair, say: millions of SPX, code, and no proof yet; or a proof that lapsed.
    for (const validUntil of [0n, NOW - 1n]) {
      const contract = chain({ validUntil, eligible: false, balance: 13_000_000n * 10n ** 8n, code: "0x6080604052" });
      const status = await readHolderStatus(contract.rpc, HOLDER, { reader: contract.reader });
      expect(status, String(validUntil)).toMatchObject({ isAccount: false, proofValid: false, reason: "contract" });
      expect(holderReasonText(status)).toBe("Only an ordinary account can be paid as a community keeper; this address is a contract.");
    }
    // Whether it is one unknown, nothing a proof could fix is said either: the panel offers no proof on a guess.
    const unknownCode = chain({ validUntil: 0n, eligible: false, balance: 0n, code: undefined });
    const unknown = await readHolderStatus(unknownCode.rpc, HOLDER, { reader: unknownCode.reader });
    expect(unknown).toMatchObject({ isAccount: null, validUntil: 0n, reason: null });
    expect(holderReasonText(unknown)).toBeNull();
  });

  it("says how far a holder is short of 690 SPX, and that an address that never proved hasn't", async () => {
    const short = chain({ ...eligibleHolder, eligible: false, balance: 59_880_169_405n });
    const status = await readHolderStatus(short.rpc, HOLDER, { reader: short.reader });
    expect(status).toMatchObject({ shortfall: MIN_SPX - 59_880_169_405n, reason: "below-minimum" });
    expect(holderReasonText(status)).toBe("It holds 598 of the 690 SPX it needs now.");
    const never = chain({ ...eligibleHolder, validUntil: 0n, eligible: false });
    const unproven = await readHolderStatus(never.rpc, HOLDER, { reader: never.reader });
    expect(unproven).toMatchObject({ validUntil: 0n, proofValid: false, reason: "not-proven" });
    expect(holderReasonText(unproven)).toBe("This address has never proven its SPX.");
  });

  it("reads a figure it can't get as unknown, never zero or false", async () => {
    const blind = chain({ validUntil: NOW + DAY, eligible: undefined, balance: undefined, code: undefined });
    const status = await readHolderStatus(blind.rpc, HOLDER, { reader: blind.reader });
    expect(status).toMatchObject({ state: "read", eligible: null, balance: null, shortfall: null, isAccount: null, proofValid: true, reason: null });
    expect(holderReasonText(status)).toBeNull();
    const noProofFigure = chain({ ...eligibleHolder, validUntil: undefined });
    expect(await readHolderStatus(noProofFigure.rpc, HOLDER, { reader: noProofFigure.reader })).toMatchObject({
      validUntil: null,
      proofValid: null,
      lapsesSoon: null,
      reason: null,
    });
  });

  it("tells a registry that isn't deployed from one that couldn't be read, at a block it is given", async () => {
    const missing = chain({ registryCode: "0x" });
    expect(await readHolderStatus(missing.rpc, HOLDER, { reader: missing.reader, block: 26_000_050n })).toEqual({
      state: "not-deployed",
      registry: MAINNET_REGISTRY,
      holder: HOLDER,
      block: 26_000_050n,
      chainTime: NOW,
    });
    expect(missing.reads[0]!.blockTag).toBe(`0x${(26_000_050n).toString(16)}`);
    expect(missing.codes[0]).toEqual([MAINNET_REGISTRY, `0x${(26_000_050n).toString(16)}`]);
    const unread = chain({});
    expect(await readHolderStatus(unread.rpc, HOLDER, { reader: unread.reader })).toMatchObject({ state: "read", eligible: null, validUntil: null });
  });
});
