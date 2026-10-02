/**
 * Canonical serialisation — the foundation of the parity and conformance gates.
 *
 * Two claims in this repo reduce to byte-comparing structured values:
 *
 *   parity      the same module produces the same TxPlan in the native runtime
 *               and in QuickJS
 *   determinism the same module given the same inputs produces the same TxPlan
 *               twice
 *
 * `JSON.stringify` cannot express either. Key order follows insertion order, so
 * two structurally identical plans built by different code paths serialise
 * differently; and it throws outright on bigint, which is most of what a
 * transaction is made of. So we define one total, order-independent encoding
 * and compare that.
 *
 * Encoding rules:
 *   - object keys sorted by code unit, recursively
 *   - bigint as a decimal string with a `#` sentinel, so 1n and "1" cannot collide
 *   - arrays keep their order (order is meaning: call sequence)
 *   - undefined / functions / symbols throw rather than vanish
 *
 * That last rule matters: `JSON.stringify` silently drops an undefined field,
 * which would let an omitted safety-relevant value hash identically to a
 * present one. A throw is the honest outcome.
 */

export type Canonical =
  | string
  | number
  | boolean
  | null
  | bigint
  | Canonical[]
  | { [key: string]: Canonical };

export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalizationError";
  }
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "bigint":
      // `#` sentinel keeps 1n distinct from "1" — without it a module could
      // swap a numeric amount for a string and hash the same.
      return `"#${value.toString(10)}"`;
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number ${value}`, path);
      }
      // Integers only. A float's shortest round-trip repr is not stable enough
      // to hang a security comparison on, and nothing here needs one.
      if (!Number.isInteger(value)) {
        throw new CanonicalizationError(`non-integer number ${value}; use bigint`, path);
      }
      return value.toString(10);
    case "undefined":
      throw new CanonicalizationError("undefined is not encodable", path);
    case "function":
    case "symbol":
      throw new CanonicalizationError(`${typeof value} is not encodable`, path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(",")}]`;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new CanonicalizationError("only plain objects are encodable", path);
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const parts = entries.map(
    ([k, v]) => `${JSON.stringify(k)}:${encode(v, path ? `${path}.${k}` : k)}`,
  );
  return `{${parts.join(",")}}`;
}

/** Deterministic string encoding. Identical structures always yield identical output. */
export function canonicalize(value: unknown): string {
  return encode(value, "");
}

/** SHA-256 of the canonical encoding, hex-encoded. Used to compare plans across runtimes. */
export async function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
