/**
 * Block headers rebuilt from JSON, and state proofs typed, against recorded
 * mainnet answers: no node, no network.
 *
 * The blocks are `eth_getBlockByNumber` answers recorded from the local fork,
 * which serves blocks up to the pinned one from mainnet as they were
 * (`test/fixtures/block-*.json`). The headers they must rebuild to were
 * recorded separately, by `packages/vault/scripts/record-proofs.mjs` from an
 * archive endpoint, with the proofs the SPX holder registry's forge tests
 * prove on chain: two recordings that agree to the byte, and a hash the chain
 * itself vouches for. What a header that fails to hash means for a proof is
 * `packages/vault/src/registry.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import { fromRlp, keccak256, toRlp } from "viem";
import type { Hex } from "@spdex/core";
import {
  HeaderHashMismatchError,
  KNOWN_HEADER_FIELDS,
  MAX_HEADER_FIELDS,
  MAX_UNKNOWN_HEADER_FIELDS,
  accountProofStorageRoot,
  blockHeaderRlp,
  checkedHeaderOf,
  getProof,
  parseAccountProof,
  parseHeaderRlp,
  proofRoot,
  readCheckedHeader,
  type RpcBlockHeader,
} from "./header.js";
import type { JsonRpc } from "./reader.js";
import block25999900 from "../test/fixtures/block-25999900.json";
import block26000000 from "../test/fixtures/block-26000000.json";
import recorded25999900 from "../../vault/test/fixtures/proofs/holder-b0072e68-25999900.json";
import recorded26000000 from "../../vault/test/fixtures/proofs/holder-b0072e68-26000000.json";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";

const BLOCKS: [string, RpcBlockHeader, { header: string; blockHash: string; blockNumber: number; stateRoot: string; timestamp: number }][] = [
  ["25,999,900", block25999900, recorded25999900],
  ["26,000,000, the block every test pins", block26000000, recorded26000000],
];

/** A copy of a block without the named fields. */
function without(block: RpcBlockHeader, ...fields: (keyof RpcBlockHeader)[]): RpcBlockHeader {
  const copy: Record<string, unknown> = { ...block };
  for (const field of fields) delete copy[field];
  return copy as unknown as RpcBlockHeader;
}

describe("blockHeaderRlp", () => {
  it.each(BLOCKS)("rebuilds block %s's header to the byte, and it hashes to the block's hash", (_name, block, recorded) => {
    const rlp = blockHeaderRlp(block);
    expect(rlp).toBe(recorded.header.toLowerCase());
    expect(keccak256(rlp)).toBe(recorded.blockHash);
    expect(keccak256(rlp)).toBe(block.hash);
    expect((fromRlp(rlp, "hex") as Hex[]).length).toBe(KNOWN_HEADER_FIELDS);
    expect(KNOWN_HEADER_FIELDS).toBe(21);
  });

  it("encodes a zero quantity as no bytes, and the hashes, bloom and 8-byte nonce as the bytes they are", () => {
    const items = fromRlp(blockHeaderRlp(block25999900), "hex") as Hex[];
    expect(block25999900.difficulty).toBe("0x0");
    expect(items[7]).toBe("0x");
    expect(items[14]).toBe("0x0000000000000000");
    expect(items[3]).toBe(block25999900.stateRoot);
    expect(items[2]).toBe(block25999900.miner);
    expect((items[6]!.length - 2) / 2).toBe(256);
    expect(BigInt(items[8]!)).toBe(25_999_900n);
    // A quantity is minimal however the service wrote it: "0x01b" and "0x1b" are one byte.
    const padded = { ...block25999900, gasUsed: `0x0${block25999900.gasUsed.slice(2)}` };
    expect(blockHeaderRlp(padded)).toBe(blockHeaderRlp(block25999900));
  });

  it("encodes a fork's fields while present, so an older block's header is shorter", () => {
    // A Cancun block, before Prague added requestsHash: twenty fields.
    const cancun = without(block25999900, "requestsHash");
    expect((fromRlp(blockHeaderRlp(cancun), "hex") as Hex[]).length).toBe(20);
    // A London block: sixteen.
    const london = without(block25999900, "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash");
    expect((fromRlp(blockHeaderRlp(london), "hex") as Hex[]).length).toBe(16);
    // Fields a service answers as null count as absent.
    expect(blockHeaderRlp({ ...block25999900, requestsHash: null })).toBe(blockHeaderRlp(cancun));
  });

  it("refuses a fork's field after a missing earlier one, a missing base field, and fields of the wrong length, rather than encoding them", () => {
    expect(() => blockHeaderRlp(without(block25999900, "parentBeaconBlockRoot"))).toThrow(/has requestsHash but not parentBeaconBlockRoot/);
    expect(() => blockHeaderRlp(without(block25999900, "mixHash"))).toThrow(/has no mixHash/);
    expect(() => blockHeaderRlp({ ...block25999900, parentHash: block25999900.parentHash.slice(0, -2) })).toThrow(/parentHash is 31 bytes, not 32/);
    expect(() => blockHeaderRlp({ ...block25999900, nonce: "0x00" })).toThrow(/nonce is 1 bytes, not 8/);
    expect(() => blockHeaderRlp({ ...block25999900, extraData: "0x123" })).toThrow(/not whole bytes/);
    expect(() => blockHeaderRlp({ ...block25999900, number: "25999900" })).toThrow(/not hex/);
    expect(() => blockHeaderRlp({ ...block25999900, timestamp: "0x" })).toThrow(/not a quantity/);
  });
});

describe("checkedHeaderOf", () => {
  it("gives the number, hash, state root, time and RLP of a header that hashes to its block", () => {
    expect(checkedHeaderOf(block26000000)).toEqual({
      number: 26_000_000n,
      hash: recorded26000000.blockHash,
      stateRoot: recorded26000000.stateRoot,
      timestamp: BigInt(recorded26000000.timestamp),
      rlp: recorded26000000.header.toLowerCase(),
    });
  });

  it("refuses a header with a field left out: it no longer hashes to the block", () => {
    // What a field this file doesn't know looks like from here: the service's
    // block has it, and the rebuilt header doesn't.
    const missing = without(block25999900, "requestsHash");
    expect(() => checkedHeaderOf(missing)).toThrow(HeaderHashMismatchError);
    try {
      checkedHeaderOf(missing);
    } catch (error) {
      expect(error).toMatchObject({ number: 25_999_900n, expected: block25999900.hash, actual: keccak256(blockHeaderRlp(missing)) });
      expect((error as Error).message).toMatch(/hashes to 0x[0-9a-f]{64}, not to the block's hash 0x4da3449d/);
    }
  });

  it("refuses a header with a field added: a block whose real header has twenty fields, answered with twenty-one", () => {
    // The hash a Cancun-era block would have, with a requestsHash it never had.
    const twenty = blockHeaderRlp(without(block25999900, "requestsHash"));
    const extra = { ...block25999900, hash: keccak256(twenty) };
    expect(() => checkedHeaderOf(extra)).toThrow(HeaderHashMismatchError);
    // Without the extra field it is that block's header, and passes.
    expect(checkedHeaderOf(without(extra, "requestsHash")).rlp).toBe(twenty);
  });

  it("refuses a header with any field changed, a state root above all", () => {
    expect(() => checkedHeaderOf({ ...block25999900, stateRoot: block26000000.stateRoot })).toThrow(HeaderHashMismatchError);
    expect(() => checkedHeaderOf({ ...block25999900, timestamp: `0x${(BigInt(block25999900.timestamp) + 1n).toString(16)}` })).toThrow(
      HeaderHashMismatchError,
    );
    expect(() => checkedHeaderOf({ ...block25999900, number: "0x18cba1d" })).toThrow(HeaderHashMismatchError);
  });
});

/**
 * A block as a service would answer it after a hard fork this file doesn't
 * know: `block`'s header with `added` appended, in that order, each given as
 * the RLP item it is in the header, and named in the answer as `json` says
 * (in the answer's own key order, which need not be the header's), with the
 * hash that header has.
 */
function afterNewFork(block: RpcBlockHeader, added: [name: string, item: Hex, json: string][], extra: Record<string, unknown> = {}) {
  const items = [...(fromRlp(blockHeaderRlp(block), "hex") as Hex[]), ...added.map(([, item]) => item)];
  const rlp = toRlp(items) as Hex;
  const answer: Record<string, unknown> = { ...block, ...extra };
  for (const [name, , json] of [...added].reverse()) answer[name] = json;
  answer["hash"] = keccak256(rlp);
  return { block: answer as unknown as RpcBlockHeader, rlp, fields: items.length };
}

describe("a header from a hard fork this file doesn't know", () => {
  const ACCESS_LIST_HASH = `0x00${"ab".repeat(31)}` as Hex;

  it("appends a field the answer names and this file doesn't, when that is what hashes to the block: 22 fields", () => {
    const { block, rlp, fields } = afterNewFork(block26000000, [["blockAccessListHash", ACCESS_LIST_HASH, ACCESS_LIST_HASH]]);
    expect(fields).toBe(KNOWN_HEADER_FIELDS + 1);
    // The header the known fields alone give no longer hashes to the block.
    expect(keccak256(blockHeaderRlp(block))).not.toBe(block.hash);
    const checked = checkedHeaderOf(block);
    expect(checked.rlp).toBe(rlp);
    expect(keccak256(checked.rlp)).toBe(block.hash);
    // Fields 3, 8 and 11 are still the block's, where the registry reads them.
    expect(checked).toMatchObject({ number: 26_000_000n, stateRoot: recorded26000000.stateRoot, timestamp: BigInt(recorded26000000.timestamp) });
    expect(parseHeaderRlp(checked.rlp)).toMatchObject({ hash: block.hash, number: 26_000_000n, stateRoot: recorded26000000.stateRoot, fields: 22 });
  });

  it("finds two new fields in the header's order whatever the answer's, each as bytes or as a quantity, past keys that are no header's", async () => {
    // A slot number, a quantity the answer writes as "0x5" and the header as one byte, then a hash.
    const { block, rlp } = afterNewFork(
      block25999900,
      [
        ["slotNumber", "0x05", "0x5"],
        ["blockAccessListHash", ACCESS_LIST_HASH, ACCESS_LIST_HASH],
      ],
      { author: block25999900.miner, totalDifficulty: "0xc70d815d562d3cfa955", someClientsExtra: "0x1234" },
    );
    expect(Object.keys(block).indexOf("blockAccessListHash")).toBeLessThan(Object.keys(block).indexOf("slotNumber"));
    expect(checkedHeaderOf(block).rlp).toBe(rlp);
    // A zero quantity is no bytes at all.
    const zero = afterNewFork(block25999900, [["slotNumber", "0x", "0x0"]]);
    expect(checkedHeaderOf(zero.block).rlp).toBe(zero.rlp);
    // And through the service, as a proof is built.
    const rpc: JsonRpc = async () => block;
    expect((await readCheckedHeader(rpc, "finalized")).rlp).toBe(rlp);
  });

  it("still refuses a new field the answer doesn't name, one after a known fork's that is missing, a known field changed, and an answer with too many unknown fields to try", () => {
    const { block } = afterNewFork(block26000000, [["blockAccessListHash", ACCESS_LIST_HASH, ACCESS_LIST_HASH]]);
    expect(() => checkedHeaderOf(without(block, "blockAccessListHash" as keyof RpcBlockHeader))).toThrow(HeaderHashMismatchError);
    // Never put where a known fork's field should be: a block without Prague's field gets no field after it.
    const cancun = without(block25999900, "requestsHash");
    const skipped = afterNewFork(cancun, [["blockAccessListHash", ACCESS_LIST_HASH, ACCESS_LIST_HASH]]);
    expect(() => checkedHeaderOf(skipped.block)).toThrow(HeaderHashMismatchError);
    // A known field changed is refused whatever else the answer names.
    expect(() => checkedHeaderOf({ ...block, stateRoot: block25999900.stateRoot })).toThrow(HeaderHashMismatchError);
    // Four unknown fields are tried; a fifth and none are.
    const four = { blockAccessListHash: ACCESS_LIST_HASH, a: "0x01", b: "0x02", c: "0x03" };
    expect(checkedHeaderOf({ ...block, ...four }).rlp).toBe(afterNewFork(block26000000, [["blockAccessListHash", ACCESS_LIST_HASH, ACCESS_LIST_HASH]]).rlp);
    expect(MAX_UNKNOWN_HEADER_FIELDS).toBe(4);
    const five = { ...four, d: "0x04" };
    expect(() => checkedHeaderOf({ ...block, ...five })).toThrow(HeaderHashMismatchError);
    // The refusal says what it may mean.
    expect(() => checkedHeaderOf({ ...block, ...five })).toThrow(/the service answered wrongly, or a hard fork changed the header in a way this build doesn't know/);
  });
});

describe("readCheckedHeader", () => {
  /** A service that answers `eth_getBlockByNumber` with `block`, noting what it was asked. */
  function serving(block: RpcBlockHeader | null) {
    const asked: unknown[][] = [];
    const rpc: JsonRpc = async (method, params) => {
      expect(method).toBe("eth_getBlockByNumber");
      asked.push(params);
      return block;
    };
    return { rpc, asked };
  }

  it("asks for the block by tag or by number, without its transactions, and checks it", async () => {
    const finalized = serving(block25999900);
    expect((await readCheckedHeader(finalized.rpc, "finalized")).number).toBe(25_999_900n);
    expect(finalized.asked).toEqual([["finalized", false]]);
    const byNumber = serving(block25999900);
    expect((await readCheckedHeader(byNumber.rpc, 25_999_900n)).hash).toBe(recorded25999900.blockHash);
    expect(byNumber.asked).toEqual([["0x18cba1c", false]]);
  });

  it("refuses another block than the one asked for, a block that doesn't hash, and no block at all", async () => {
    await expect(readCheckedHeader(serving(block25999900).rpc, 26_000_000n)).rejects.toThrow(/asked for block 26000000, the network service answered block 25999900/);
    await expect(readCheckedHeader(serving(without(block25999900, "requestsHash")).rpc, "finalized")).rejects.toThrow(HeaderHashMismatchError);
    await expect(readCheckedHeader(serving(null).rpc, "finalized")).rejects.toThrow(/no block "finalized"/);
  });
});

describe("parseHeaderRlp", () => {
  it("reads fields 8, 3 and 11 and the hash, the way the registry reads a header", () => {
    expect(parseHeaderRlp(recorded25999900.header)).toEqual({
      hash: recorded25999900.blockHash,
      number: 25_999_900n,
      stateRoot: recorded25999900.stateRoot,
      timestamp: BigInt(recorded25999900.timestamp),
      fields: 21,
    });
  });

  it("says no, rather than throwing, to bytes the registry would refuse as a header", () => {
    const items = fromRlp(recorded25999900.header as Hex, "hex") as Hex[];
    for (const bad of [
      "",
      "0x",
      "0x80",
      "0xc0",
      "0x123",
      "not hex",
      `0xa0${"11".repeat(32)}`,
      toRlp(items.slice(0, 11)),
      toRlp([...items.slice(0, 3), "0x1234", ...items.slice(4)]),
      toRlp([...items.slice(0, 8), "0x010203040506070809", ...items.slice(9)]),
      recorded25999900.header.slice(0, -2),
    ]) {
      expect(parseHeaderRlp(bad), bad.slice(0, 20)).toBeNull();
    }
    // Twelve fields are enough for the registry, and so for this.
    expect(parseHeaderRlp(toRlp(items.slice(0, 12)))).toMatchObject({ number: 25_999_900n, fields: 12 });
  });

  it("says no to a header of more than 32 fields, which the registry's RLP reader can't read, and yes to 32", () => {
    const items = fromRlp(recorded25999900.header as Hex, "hex") as Hex[];
    const padded = (count: number) => toRlp([...items, ...Array.from({ length: count - items.length }, () => "0x01" as Hex)]);
    expect(MAX_HEADER_FIELDS).toBe(32);
    expect(parseHeaderRlp(padded(32))).toMatchObject({ number: 25_999_900n, fields: 32 });
    expect(parseHeaderRlp(padded(33))).toBeNull();
  });
});

describe("accountProofStorageRoot", () => {
  it("reads the storage root from an account proof's leaf: the root its storage proof starts from, in every recorded proof", () => {
    for (const recorded of [recorded25999900, recorded26000000]) {
      const root = accountProofStorageRoot(recorded.accountProof);
      expect(root).toBe(keccak256(recorded.storageProof[0] as Hex));
    }
  });

  it("finds the root a proof starts from, the hash of its first node: its block's state root for an account proof", () => {
    expect(proofRoot(recorded25999900.accountProof)).toBe(recorded25999900.stateRoot);
    expect(proofRoot(recorded26000000.accountProof)).toBe(recorded26000000.stateRoot);
    expect(proofRoot(recorded25999900.accountProof.map((n) => n.toUpperCase().replace("0X", "0x")))).toBe(recorded25999900.stateRoot);
    for (const nodes of [[], ["0x"], ["0x1"], ["not hex"]]) expect(proofRoot(nodes), String(nodes)).toBeNull();
  });

  it("says null, never throwing, when the last node is no account's leaf", () => {
    const nodes = recorded25999900.accountProof;
    // A branch node: what a proof that the account is absent ends with.
    expect(accountProofStorageRoot(nodes.slice(0, 1))).toBeNull();
    expect(accountProofStorageRoot([])).toBeNull();
    expect(accountProofStorageRoot(["0x"])).toBeNull();
    expect(accountProofStorageRoot(["0x12zz"])).toBeNull();
    expect(accountProofStorageRoot([toRlp(["0x20", toRlp(["0x01", "0x02"])])])).toBeNull();
  });
});

describe("getProof", () => {
  const slot = recorded25999900.storageKey as Hex;
  /** `eth_getProof`'s answer for the recorded holder's balance, as a node gives it. */
  const answer = {
    address: SPX,
    accountProof: recorded25999900.accountProof,
    balance: "0x0",
    codeHash: "0x" + "ab".repeat(32),
    nonce: "0x1",
    storageHash: keccak256(recorded25999900.storageProof[0] as Hex),
    storageProof: [{ key: slot, value: `0x${BigInt(recorded25999900.balance).toString(16)}`, proof: recorded25999900.storageProof }],
  };

  it("asks for the slots at the block's number, and types the answer", async () => {
    const asked: unknown[][] = [];
    const rpc: JsonRpc = async (method, params) => {
      expect(method).toBe("eth_getProof");
      asked.push(params);
      return answer;
    };
    const proof = await getProof(rpc, SPX, [slot], 25_999_900n);
    expect(asked).toEqual([[SPX, [slot], "0x18cba1c"]]);
    expect(proof).toMatchObject({ address: SPX, balance: 0n, nonce: 1n, storageHash: answer.storageHash });
    expect(proof.accountProof).toEqual(recorded25999900.accountProof.map((node) => node.toLowerCase()));
    expect(proof.storageProof).toEqual([{ key: slot, value: BigInt(recorded25999900.balance), proof: recorded25999900.storageProof.map((n) => n.toLowerCase()) }]);
    // The state root's node is the account proof's first.
    expect(keccak256(proof.accountProof[0]!)).toBe(recorded25999900.stateRoot);
  });

  it("reads a key some services answer as a quantity as the 32-byte slot it is", () => {
    const short = parseAccountProof({ ...answer, storageProof: [{ ...answer.storageProof[0], key: "0x1" }] });
    expect(short!.storageProof[0]!.key).toBe(`0x${"0".repeat(63)}1`);
  });

  it("throws for an answer that is not a proof of these slots, and passes on the service's own refusal", async () => {
    const answering = (value: unknown): JsonRpc => async () => value;
    await expect(getProof(answering(null), SPX, [slot], 1n)).rejects.toThrow(/is not a proof/);
    await expect(getProof(answering({ ...answer, accountProof: ["0x12", 7] }), SPX, [slot], 1n)).rejects.toThrow(/is not a proof/);
    await expect(getProof(answering({ ...answer, storageHash: "0x12" }), SPX, [slot], 1n)).rejects.toThrow(/is not a proof/);
    await expect(getProof(answering({ ...answer, storageProof: [] }), SPX, [slot], 1n)).rejects.toThrow(/0 storage proofs for 1 slots/);
    const refusing: JsonRpc = async () => {
      throw Object.assign(new Error("eth_getProof: the method eth_getProof does not exist/is not available"), { code: -32601 });
    };
    await expect(getProof(refusing, SPX, [slot], 1n)).rejects.toMatchObject({ code: -32601 });
  });
});
