/**
 * For tests: what a wallet that signs exactly what it is asked returns for
 * `eth_signTransaction`, as a legacy EIP-155 transaction. Its signature is
 * a placeholder, since nothing in the app checks one: `submitPrivately`
 * reads the fields back (lib/signedTx.ts) and a relay would check the rest.
 */

/** The fields `submitPrivately` asks a wallet to sign, as hex quantities. */
export interface SignRequestFields {
  to: string;
  data: string;
  value: string;
  nonce: string;
  chainId: string;
  gas: string;
  gasPrice: string;
}

export function legacySigned(tx: { nonce: bigint; gasPrice: bigint; gas: bigint; to: string; value: bigint; data: string; chainId: bigint }): string {
  return rlpList([
    uintBytes(tx.nonce),
    uintBytes(tx.gasPrice),
    uintBytes(tx.gas),
    hexBytes(tx.to),
    uintBytes(tx.value),
    hexBytes(tx.data),
    uintBytes(tx.chainId * 2n + 35n),
    uintBytes(1n),
    uintBytes(1n),
  ]);
}

/** `legacySigned` for an `eth_signTransaction` request's params, as the wallet received them. */
export function signAsAsked(params: unknown): string {
  const tx = (params as [SignRequestFields])[0];
  return legacySigned({
    nonce: BigInt(tx.nonce),
    gasPrice: BigInt(tx.gasPrice),
    gas: BigInt(tx.gas),
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    chainId: BigInt(tx.chainId),
  });
}

function rlpList(items: readonly Uint8Array[]): string {
  const body = items.flatMap((b) => (b.length === 1 && b[0]! < 0x80 ? [...b] : [...lengthPrefix(b.length, 0x80), ...b]));
  return `0x${[...lengthPrefix(body.length, 0xc0), ...body].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function lengthPrefix(n: number, short: number): number[] {
  if (n < 56) return [short + n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [short + 55 + bytes.length, ...bytes];
}

function hexBytes(hex: string): Uint8Array {
  const digits = hex.replace(/^0x/, "");
  const even = digits.length % 2 === 0 ? digits : `0${digits}`;
  return Uint8Array.from(even.match(/../g) ?? [], (h) => parseInt(h, 16));
}

const uintBytes = (n: bigint): Uint8Array => (n === 0n ? new Uint8Array() : hexBytes(n.toString(16)));
