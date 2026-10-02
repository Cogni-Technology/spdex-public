/**
 * Module manifests — what a module declares about itself, before it runs.
 *
 * The manifest is the *cheap* layer of the security model: it bounds what a
 * module can reach at all, so the expensive layer (simulation in the Guard)
 * has less to catch. It is not the guarantee. A module that lies in its
 * manifest still fails simulation; a module that tells the truth still gets
 * simulated. Treat this as an allowlist that narrows the blast radius, never
 * as evidence of good behaviour.
 */

import { z } from "zod";
import { AddressSchema, BigIntSchema, HexSchema } from "./primitives.js";

/** `1.2.3`, optionally with a prerelease tag. */
const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "must be semver");

/**
 * Module kinds.
 *
 * `IMPLEMENTED_MODULE_KINDS` is the list of kinds the host admits — a manifest
 * of any other kind is refused before its code is looked at. Four of them have
 * shipped modules and a runtime path both runtimes exercise — `venue`,
 * `tiplist`, `tracker` and `scheduler` — and those are the only kinds the host
 * will load: its load seam (`assertLoadable` in @spdex/host) also requires a
 * runtime path, so `tokenlist`, `oracle` and `submitter`, admitted here, are
 * refused there until one exists. The app's oracle cross-check is host-side
 * (`UniswapV3TwapOracle`) rather than a module. Read the list as a statement
 * about what the host will admit, not about what exists.
 *
 * The rest (`panel`, `policy`) are declared but not yet admitted, on purpose:
 * adding a kind later should be filling in a branch the type system already
 * knows about, not widening a contract that every existing module has to be
 * re-checked against.
 */
export const MODULE_KINDS = [
  "venue",
  "tokenlist",
  /**
   * Answers "who can I tip?" — a name-to-address map, and the first kind other
   * than `venue` with a real module behind it. Untrusted for the same reason a
   * token list is: it decides which address a name points at.
   */
  "tiplist",
  "oracle",
  "submitter",
  // Reserved — see docs/ARCHITECTURE.md §Upgradeability.
  "panel",
  "policy",
  /** Reports what is in a pool. Never in the path of a signature. */
  "tracker",
  /**
   * Decides when a recurring buy is due and how large it is. Proposes only:
   * the Guard checks every buy against the plan the user wrote.
   */
  "scheduler",
] as const;

export const IMPLEMENTED_MODULE_KINDS = [
  "venue",
  "tiplist",
  "tracker",
  "scheduler",
  "tokenlist",
  "oracle",
  "submitter",
] as const;

export const ModuleKindSchema = z.enum(MODULE_KINDS);
export type ModuleKind = z.infer<typeof ModuleKindSchema>;

/**
 * Capabilities a module may request.
 *
 * This list is **additive-only**. Adding an entry is fine; changing or removing
 * one breaks every module already written against it, and a v1 module must still
 * load on a v3 host.
 */
export const CAPABILITIES = [
  /** Read chain state via ctx.call / ctx.multicall, restricted to `contracts`. */
  "chain:read",
  /** Emit to the module's own console pane. */
  "log",
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ModuleLimitsSchema = z.object({
  /** QuickJS interrupt budget per call. Exceeding it terminates the VM. */
  maxFuel: BigIntSchema,
  /** Bytes. Enforced by the QuickJS runtime allocator. */
  maxMemory: BigIntSchema,
  /**
   * Upper bound on chain reads per quote, so a module cannot grind the RPC.
   *
   * Zero is permitted and is not a degenerate case — it is the strongest
   * declaration a module can make. A registry returns a static list, so it has
   * no business reading the chain, and the broker denies any batch that would
   * take `callsUsed` past this. Requiring a positive number would have forced
   * such a module to declare a budget it does not want.
   */
  maxCallsPerQuote: z.number().int().nonnegative(),
});
export type ModuleLimits = z.infer<typeof ModuleLimitsSchema>;

export const ModuleManifestSchema = z.object({
  /** Stable identifier, e.g. `venue-uniswap-v3`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/, "lowercase kebab-case"),
  version: SemverSchema,

  /**
   * Host API version this module was written against. The host declares a
   * supported range and refuses anything outside it — explicitly, with a
   * message naming both versions, rather than failing mysteriously at runtime.
   */
  apiVersion: SemverSchema,

  kind: ModuleKindSchema,
  displayName: z.string().min(1).max(64),
  description: z.string().max(280),

  capabilities: z.array(CapabilitySchema),

  /**
   * Every contract this module may read from or direct a transaction to.
   *
   * The host rejects a `ctx.call` to anything absent from this list, and the
   * Guard rejects a TxPlan targeting one. This is what makes a leaked or
   * malicious module bounded rather than arbitrary.
   */
  contracts: z.array(AddressSchema),

  limits: ModuleLimitsSchema,

  /**
   * SHA-256 of the module's code.
   *
   * Declared ahead of the installer that will check it. Nothing produces or
   * verifies it yet — first-party manifests carry a placeholder — so it is a
   * format, not a guarantee, until that lands.
   */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex sha-256"),

  /** ed25519 public key of the author, and their signature over `sha256`. */
  publicKey: HexSchema,
  signature: HexSchema,
});

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export function isImplementedKind(kind: ModuleKind): boolean {
  return (IMPLEMENTED_MODULE_KINDS as readonly string[]).includes(kind);
}
