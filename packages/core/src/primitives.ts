/**
 * Primitive types shared by every package.
 *
 * Defined here rather than imported from viem so `@spdex/core` stays
 * dependency-light — these are structurally identical to viem's, so they
 * interoperate with it without the coupling.
 */

import { z } from "zod";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const HexSchema = z
  .string()
  .regex(HEX_RE, "must be 0x-prefixed hex")
  .transform((s) => s.toLowerCase() as Hex);

/**
 * Addresses are normalised to lowercase on parse.
 *
 * Every address comparison in the Guard is an equality check, and a
 * checksummed address comparing unequal to its lowercase twin is exactly the
 * kind of bug that silently disables a safety check. Normalising at the schema
 * boundary means no downstream code has to remember.
 */
export const AddressSchema = z
  .string()
  .regex(ADDRESS_RE, "must be a 20-byte hex address")
  .transform((s) => s.toLowerCase() as Address);

/** Accepts bigint, decimal string, or safe integer; always yields bigint. */
export const BigIntSchema = z
  .union([z.bigint(), z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

export const ChainIdSchema = z.number().int().positive();

export function isAddressEqual(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
