#!/usr/bin/env node
/**
 * Record mainnet SPX balance proofs for the holder registry's tests.
 *
 * ## Why recorded proofs
 *
 * `SpxHolderRegistry.prove` checks a block header against the block's real
 * hash, then follows two Merkle-Patricia proofs from that header's state root
 * to a holder's SPX balance. A local fork cannot produce such a proof for a
 * block it mined: anvil leaves a mined block's `stateRoot` zero, and its
 * `eth_getProof` answers from a partial local trie. So the forge tests, which
 * fork mainnet at the pinned block (26,000,000), prove blocks at or before it,
 * from proofs recorded here once from an archive endpoint and committed as
 * fixtures (`test/fixtures/proofs`). The fork's EIP-2935 history contract and
 * `BLOCKHASH` hold those blocks' real hashes, so the registry checks them
 * exactly as it would on mainnet.
 *
 * ## What it checks before writing anything
 *
 * - The header is rebuilt from `eth_getBlockByNumber`'s fields, in the order
 *   the protocol hashes them (every field of the block's fork, so 21 after
 *   Prague), and the script refuses to write a fixture unless the keccak256 of
 *   that RLP equals the block's hash. A header the script got wrong would
 *   otherwise become a fixture that tests a different header.
 * - The proven storage value equals what SPX's own `balanceOf` answers for the
 *   holder at that block, so the slot (`keccak256(abi.encode(holder, 1))`) is
 *   checked against the token, not assumed.
 * - The first node of each proof hashes to the root it hangs from.
 *
 * ## Usage
 *
 *   node packages/vault/scripts/record-proofs.mjs                  # the tests' fixtures
 *   node packages/vault/scripts/record-proofs.mjs 0xHolder@25999000 [...]
 *   node packages/vault/scripts/record-proofs.mjs --out some/dir   # elsewhere
 *
 * It reads SPDEX_FORK_RPC_URL (an archive endpoint, usually in `.env.local`)
 * the way the fork script does, and never prints it: it holds an API key.
 * Fixtures are named `holder-<first 8 hex digits>-<block>.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, getAddress, hexToBigInt, keccak256, toRlp } from "viem";
import { resolvedEnv } from "../../../scripts/env.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(PACKAGE_ROOT, "test", "fixtures", "proofs");

/** SPX6900: 8 decimals; balances in mapping slot 1. The registry's SPX and BALANCE_SLOT. */
const SPX = "0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C";
const BALANCE_SLOT = 1n;
const SPX_DECIMALS = 8;

/**
 * The fixtures the forge tests read, and why each exists. The pinned block is
 * 26,000,000; in a forge fork there, `BLOCKHASH` serves the 256 blocks before
 * it and the EIP-2935 contract the 8,191 before it.
 */
const DEFAULT_SET = [
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_999_900, "An eligible holder, 100 blocks before the pinned block: proves through BLOCKHASH."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_995_000, "An eligible holder, 5,000 blocks before the pinned block: proves through the EIP-2935 history contract."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_991_900, "An eligible holder, 8,100 blocks before the pinned block: near the edge of EIP-2935's 8,191."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 26_000_000, "An eligible holder at the pinned block itself: provable once the fork has mined past it."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_999_744, "256 blocks before the pinned block: the oldest BLOCKHASH answers."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_999_743, "257 blocks before the pinned block: the newest that needs the EIP-2935 history contract."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_991_809, "8,191 blocks before the pinned block: the oldest the EIP-2935 history contract answers."],
  ["0xb0072e684e532bd1dcc442b5ed22097db205bb8e", 25_991_808, "8,192 blocks before the pinned block: one too old to prove."],
  ["0xd75110fc7a983e50e4b3a03434a8b524db4b5b7e", 25_999_000, "A holder of 213 SPX: a true proof of a balance below the minimum."],
  ["0xd75110fc7a983e50e4b3a03434a8b524db4b5b7e", 25_999_900, "No SPX at all: the balance key is absent from SPX's storage trie, and the proof is one of absence."],
  ["0xd75110fc7a983e50e4b3a03434a8b524db4b5b7e", 25_995_000, "A holder of 2,047 SPX who later sold: eligible at this block."],
  ["0xcc01ef33f793ff0a8da26d19b2c4428f62753f85", 26_000_000, "A holder of about 598.8 SPX at the pinned block: the shortfall case."],
  ["0x52c77b0cb827afbad022e6d6caf2c44452edbc39", 25_999_900, "Uniswap v2's SPX/WETH pair, a contract that hands anyone what it holds above its reserves: a true proof that must never make it eligible."],
];

/**
 * The header's fields in the order the protocol hashes them. The first fifteen
 * are in every header since Frontier; the rest were appended by forks, in this
 * order, and a block carries exactly those of its own fork. A field a future
 * fork appends is not listed here, so a header that needs it fails the hash
 * check below rather than being written wrong.
 */
const BASE_FIELDS = [
  ["parentHash", "data"],
  ["sha3Uncles", "data"],
  ["miner", "data"],
  ["stateRoot", "data"],
  ["transactionsRoot", "data"],
  ["receiptsRoot", "data"],
  ["logsBloom", "data"],
  ["difficulty", "quantity"],
  ["number", "quantity"],
  ["gasLimit", "quantity"],
  ["gasUsed", "quantity"],
  ["timestamp", "quantity"],
  ["extraData", "data"],
  ["mixHash", "data"],
  ["nonce", "data"],
];
const TRAILING_FIELDS = [
  ["baseFeePerGas", "quantity"], // London (EIP-1559)
  ["withdrawalsRoot", "data"], // Shanghai (EIP-4895)
  ["blobGasUsed", "quantity"], // Cancun (EIP-4844)
  ["excessBlobGas", "quantity"], // Cancun (EIP-4844)
  ["parentBeaconBlockRoot", "data"], // Cancun (EIP-4788)
  ["requestsHash", "data"], // Prague (EIP-7685)
];
/** Keys of a block object that are not header fields. */
const NOT_HEADER = new Set(["hash", "size", "totalDifficulty", "transactions", "uncles", "withdrawals", "sealFields"]);

function fail(message) {
  console.error(`record-proofs: ${message}`);
  process.exit(1);
}

/** A JSON-RPC quantity as RLP wants it: big-endian, no leading zero bytes, zero as the empty string. */
function quantityBytes(hex) {
  const n = hexToBigInt(hex);
  if (n === 0n) return "0x";
  const digits = n.toString(16);
  return `0x${digits.length % 2 ? "0" : ""}${digits}`;
}

/** The block header's RLP, rebuilt from `eth_getBlockByNumber`'s fields. */
export function headerRlp(block) {
  const fields = BASE_FIELDS.map(([key, kind]) => {
    if (block[key] === undefined) throw new Error(`the block has no ${key}`);
    return kind === "quantity" ? quantityBytes(block[key]) : block[key];
  });
  let ended = false;
  for (const [key, kind] of TRAILING_FIELDS) {
    if (block[key] === undefined || block[key] === null) {
      ended = true;
      continue;
    }
    if (ended) throw new Error(`the block has ${key} after a field it lacks: not a header any fork produces`);
    fields.push(kind === "quantity" ? quantityBytes(block[key]) : block[key]);
  }
  return toRlp(fields);
}

function unknownKeys(block) {
  const known = new Set([...BASE_FIELDS, ...TRAILING_FIELDS].map(([key]) => key));
  return Object.keys(block).filter((key) => !known.has(key) && !NOT_HEADER.has(key));
}

function formatSpx(raw) {
  const s = raw.toString().padStart(SPX_DECIMALS + 1, "0");
  const whole = s.slice(0, -SPX_DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = s.slice(-SPX_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

let rpcId = 0;
/**
 * One JSON-RPC call. Errors name the method, never the endpoint (its URL holds a
 * key). An archive endpoint's free tier rate-limits; a 429 is retried with a
 * growing pause rather than reported.
 */
async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
    } catch {
      throw new Error(`${method}: the endpoint could not be reached`);
    }
    if (response.status === 429 && attempt < 6) {
      await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }
}

/** One fixture: the header and both proofs for `holder`'s SPX balance at `blockNumber`, checked. */
export async function record(url, holder, blockNumber, note) {
  const tag = `0x${blockNumber.toString(16)}`;
  const block = await rpc(url, "eth_getBlockByNumber", [tag, false]);
  if (!block) throw new Error(`block ${blockNumber} not found`);
  const header = headerRlp(block);
  if (keccak256(header) !== block.hash) {
    const extra = unknownKeys(block);
    throw new Error(
      `block ${blockNumber}: the rebuilt header hashes to ${keccak256(header)}, not the block's hash ${block.hash}` +
        (extra.length ? ` (the block has fields this script does not know: ${extra.join(", ")})` : ""),
    );
  }

  const storageKey = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BALANCE_SLOT]));
  const proof = await rpc(url, "eth_getProof", [SPX, [storageKey], tag]);
  const slot = proof.storageProof?.[0];
  if (!slot || slot.key.toLowerCase() !== storageKey.toLowerCase()) {
    throw new Error(`block ${blockNumber}: the endpoint answered a proof for another key`);
  }
  if (keccak256(proof.accountProof[0]) !== block.stateRoot) {
    throw new Error(`block ${blockNumber}: the account proof does not start at the block's state root`);
  }
  if (slot.proof.length > 0 && keccak256(slot.proof[0]) !== proof.storageHash) {
    throw new Error(`block ${blockNumber}: the storage proof does not start at SPX's storage root`);
  }

  const balance = hexToBigInt(slot.value);
  const balanceOfCall = `0x70a08231${encodeAbiParameters([{ type: "address" }], [holder]).slice(2)}`;
  const answered = hexToBigInt(await rpc(url, "eth_call", [{ to: SPX, data: balanceOfCall }, tag]));
  if (answered !== balance) {
    throw new Error(
      `block ${blockNumber}: SPX's balanceOf says ${answered} but slot ${BALANCE_SLOT} holds ${balance}: not SPX's balance slot`,
    );
  }

  return {
    holder: getAddress(holder),
    blockNumber,
    blockHash: block.hash,
    stateRoot: block.stateRoot,
    timestamp: Number(hexToBigInt(block.timestamp)),
    balance: balance.toString(),
    storageKey,
    header,
    accountProof: proof.accountProof,
    storageProof: slot.proof,
    note: `${formatSpx(balance)} SPX at block ${blockNumber.toLocaleString("en-US")}. ${note ?? ""}`.trim(),
  };
}

export function fixtureName(holder, blockNumber) {
  return `holder-${holder.toLowerCase().slice(2, 10)}-${blockNumber}.json`;
}

async function main() {
  const args = process.argv.slice(2);
  let out = DEFAULT_OUT;
  const requests = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      if (!args[i + 1]) fail("--out needs a directory");
      out = resolve(args[++i]);
    } else if (/^0x[0-9a-fA-F]{40}@\d+$/.test(args[i])) {
      const [holder, block] = args[i].split("@");
      requests.push([holder, Number(block), ""]);
    } else {
      fail(`unknown argument ${JSON.stringify(args[i])}: expected --out <dir> or <holder>@<block>`);
    }
  }
  const list = requests.length ? requests : DEFAULT_SET;

  const url = resolvedEnv().SPDEX_FORK_RPC_URL;
  if (!url) fail("SPDEX_FORK_RPC_URL is not set: it needs an archive endpoint (see docs/DEVELOPMENT.md)");

  mkdirSync(out, { recursive: true });
  for (const [holder, blockNumber, note] of list) {
    let fixture;
    try {
      fixture = await record(url, holder, blockNumber, note);
    } catch (error) {
      fail(`${holder} at ${blockNumber}: ${error.message}`);
    }
    const path = join(out, fixtureName(holder, blockNumber));
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    const bytes = (list) => list.reduce((sum, node) => sum + (node.length - 2) / 2, 0);
    console.log(
      `${fixtureName(holder, blockNumber)}: ${formatSpx(BigInt(fixture.balance))} SPX; header ${bytes([fixture.header])} bytes; ` +
        `account proof ${fixture.accountProof.length} nodes, ${bytes(fixture.accountProof)} bytes; ` +
        `storage proof ${fixture.storageProof.length} nodes, ${bytes(fixture.storageProof)} bytes`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
