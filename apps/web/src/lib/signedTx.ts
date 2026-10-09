/**
 * What a wallet actually signed, read back from the bytes it returned for
 * `eth_signTransaction`, so the private path posts only the transaction the
 * Guard checked.
 *
 * A wallet asked to sign a call with an exact gas limit and price may fill in
 * its own fees or re-estimate the limit, and then signs a different
 * transaction: for a batch of vault buys, a lower limit leaves vaults
 * untried, and another price undoes the fee-against-rewards sum the Guard
 * approved. Nothing is posted unless the bytes say what was asked.
 *
 * Only the forms a request with `gasPrice` can come back as are read: a
 * legacy transaction (EIP-155, so it names its chain) and an EIP-2930 one.
 * Anything else is `null`, and the caller treats that as a mismatch.
 */

export interface SignedFields {
  type: "legacy" | "eip2930" | "other";
  /** Null for a legacy transaction signed without EIP-155, which names no chain. */
  chainId: bigint | null;
  nonce: bigint;
  gasPrice: bigint | null;
  gas: bigint;
  to: string | null;
  value: bigint;
  data: string;
}

type Rlp = Uint8Array | Rlp[];

/** The fields of a signed transaction, or null for bytes this can't read. */
export function readSignedTransaction(raw: string): SignedFields | null {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(raw)) return null;
  const bytes = Uint8Array.from(raw.slice(2).match(/../g)!, (h) => parseInt(h, 16));
  const first = bytes[0]!;
  try {
    if (first >= 0xc0) {
      const fields = listOf(decode(bytes));
      if (fields === null || fields.length !== 9) return null;
      const [nonce, gasPrice, gas, to, value, data, v] = fields;
      const vNumber = uint(v);
      // EIP-155: v = chainId × 2 + 35 or 36; 27 or 28 is a signature for every chain.
      const chainId = vNumber >= 35n ? (vNumber - 35n) / 2n : null;
      return { type: "legacy", chainId, nonce: uint(nonce), gasPrice: uint(gasPrice), gas: uint(gas), to: address(to), value: uint(value), data: hex(data) };
    }
    if (first === 0x01) {
      const fields = listOf(decode(bytes.subarray(1)));
      if (fields === null || fields.length !== 11) return null;
      const [chainId, nonce, gasPrice, gas, to, value, data] = fields;
      return { type: "eip2930", chainId: uint(chainId), nonce: uint(nonce), gasPrice: uint(gasPrice), gas: uint(gas), to: address(to), value: uint(value), data: hex(data) };
    }
    return null;
  } catch {
    return null;
  }
}

/** One RLP item, which must fill `bytes` exactly. */
function decode(bytes: Uint8Array): Rlp {
  const [item, end] = readItem(bytes, 0);
  if (end !== bytes.length) throw new Error("trailing bytes");
  return item;
}

function readItem(bytes: Uint8Array, at: number): [Rlp, number] {
  const lead = bytes[at];
  if (lead === undefined) throw new Error("truncated");
  if (lead < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  if (lead < 0xb8) return string(bytes, at + 1, lead - 0x80);
  if (lead < 0xc0) {
    const size = lead - 0xb7;
    return string(bytes, at + 1 + size, length(bytes, at + 1, size));
  }
  if (lead < 0xf8) return list(bytes, at + 1, lead - 0xc0);
  const size = lead - 0xf7;
  return list(bytes, at + 1 + size, length(bytes, at + 1, size));
}

function length(bytes: Uint8Array, at: number, size: number): number {
  if (at + size > bytes.length) throw new Error("truncated");
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i]!;
  return n;
}

function string(bytes: Uint8Array, at: number, size: number): [Rlp, number] {
  if (at + size > bytes.length) throw new Error("truncated");
  return [bytes.subarray(at, at + size), at + size];
}

function list(bytes: Uint8Array, at: number, size: number): [Rlp, number] {
  const end = at + size;
  if (end > bytes.length) throw new Error("truncated");
  const items: Rlp[] = [];
  let i = at;
  while (i < end) {
    const [item, next] = readItem(bytes, i);
    items.push(item);
    i = next;
  }
  if (i !== end) throw new Error("misaligned list");
  return [items, end];
}

function listOf(item: Rlp): Rlp[] | null {
  return Array.isArray(item) ? item : null;
}

function bytesOf(item: Rlp | undefined): Uint8Array {
  if (item === undefined || Array.isArray(item)) throw new Error("expected bytes");
  return item;
}

function uint(item: Rlp | undefined): bigint {
  const b = bytesOf(item);
  return b.length === 0 ? 0n : BigInt(hex(b));
}

function hex(item: Rlp | undefined): string {
  return `0x${[...bytesOf(item)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function address(item: Rlp | undefined): string | null {
  const b = bytesOf(item);
  if (b.length === 0) return null;
  if (b.length !== 20) throw new Error("not an address");
  return hex(b);
}

/** The request the wallet was asked to sign, as `submitPrivately` sent it. */
export interface AskedToSign {
  to: string;
  data: string;
  value: bigint;
  chainId: bigint;
  nonce: bigint;
  /** Checked only when the call's limit was exact. */
  gas: bigint | null;
  /** Checked only when the call's price was exact; then only a transaction priced by `gasPrice` will do. */
  gasPrice: bigint | null;
}

/** Why what was signed isn't what was asked, in a phrase, or null when it is. */
export function signedMismatch(signed: SignedFields | null, asked: AskedToSign): string | null {
  if (signed === null) return "its signed transaction couldn't be read";
  if (signed.to === null || signed.to.toLowerCase() !== asked.to.toLowerCase()) return "it signed a different recipient";
  if (signed.data.toLowerCase() !== asked.data.toLowerCase()) return "it signed different call data";
  if (signed.value !== asked.value) return "it signed a different amount of ether";
  if (signed.chainId !== asked.chainId) return "it signed for another network, or for none";
  if (signed.nonce !== asked.nonce) return "it signed a different nonce";
  if (asked.gas !== null && signed.gas !== asked.gas) return "it signed a different gas limit";
  if (asked.gasPrice !== null && signed.gasPrice !== asked.gasPrice) return "it signed a different gas price";
  return null;
}
