/**
 * SpdexConfig — the whole application as one serialisable value.
 *
 * Recommended mode and expert mode are not two applications; they are two ways
 * of editing this object. Recommended mode writes a shipped preset into it,
 * expert mode exposes it directly, and the diff view is just a comparison
 * between the two. That equivalence is the point: a beginner and a cypherpunk
 * are running identical code with different values, so there is no "simple
 * mode" that quietly behaves differently.
 *
 * It is versioned from the first commit because it is a user's property — they
 * export it, share it, pin it to IPFS — and a config exported from v0 must
 * still open in v2. Migrations live in @spdex/config.
 */

import { z } from "zod";
import { AddressSchema } from "./primitives.js";
import { TipPolicySchema } from "./tips.js";
import { DcaPolicySchema } from "./dca.js";

export const CONFIG_SCHEMA_VERSION = 9;

/** Where the RPC endpoint came from. Drives the privacy notice the user sees. */
export const RpcSourceSchema = z.enum([
  /**
   * This copy's built-in service: the key baked into the build, only
   * functional on its canonical origins. Means "this copy's", never a saved
   * key: the app replaces an older build's with its own, and a file or link
   * leaving the browser carries none.
   */
  "bundled",
  /** The user typed it. */
  "user",
  /** Public endpoint offered when the bundled key is unavailable. */
  "fallback",
]);

export const RpcConfigSchema = z.object({
  /**
   * Absent and null both mean "no endpoint configured yet".
   *
   * They have to be interchangeable because TOML has no null: exporting a
   * config with no RPC set simply omits the key, and a config that could be
   * written but not read back would make export a one-way door.
   */
  url: z
    .url()
    .nullish()
    .transform((value) => value ?? null),
  source: RpcSourceSchema,
});

/** How a pool is named in a config. Portable across machines — no local ids. */
export const PoolSelectorSchema = z.object({
  venueId: z.string().min(1),
  /** The pool's on-chain address, or for singleton venues its derived key hash. */
  poolId: z.string().min(1),
  /** Present for informational display and diffing; not trusted for routing. */
  label: z.string().optional(),
});
export type PoolSelector = z.infer<typeof PoolSelectorSchema>;

export const PoolPolicySchema = z.object({
  /**
   * `recommended` routes across whatever the enabled venues discover.
   * `allowlist` routes across `allow` and nothing else — this is the mode that
   * makes "pin to one pool and route through nothing else" literally true.
   */
  mode: z.enum(["recommended", "allowlist"]),
  allow: z.array(PoolSelectorSchema),
  /** Always subtracted, in both modes. A denial is never overridden. */
  deny: z.array(PoolSelectorSchema),
});

export const RouterConfigSchema = z.object({
  /** Granularity of split routing. More chunks = finer splits, more quoting. */
  chunkCount: z.number().int().min(1).max(100),
  /** Cap on pools in one route, so gas cannot be spent chasing dust. */
  maxSplits: z.number().int().min(1).max(8),
  /**
   * A split must beat single-pool execution by at least this much *after* gas.
   * Without it the router adds hops that look better on paper and lose money.
   */
  minSplitGainBps: z.number().int().min(0).max(10_000),
});

export const GuardConfigSchema = z.object({
  /**
   * When true, a plan that cannot be simulated is rejected rather than shown
   * as UNVERIFIED. Off by default so a user on a limited RPC can still swap —
   * but the UI makes the downgrade impossible to miss.
   */
  requireSimulation: z.boolean(),
  /**
   * Warn if the execution price diverges from the oracle by more than this.
   *
   * A warning, never a refusal: an oracle that can block swaps is an oracle
   * worth attacking into blocking them (AGENTS.md rule 2). A scheduled buy
   * that draws the warning is held for a person to decide rather than signed
   * unattended — the verdict itself stays signable.
   */
  oracleDivergenceBps: z.number().int().min(0).max(10_000),
  /**
   * A second network service, run by someone else, that test-runs every
   * transaction too; when the two disagree about what a transaction does,
   * the Guard refuses it. It closes the one gap simulation on a single
   * endpoint leaves: that endpoint faking its own test-run.
   *
   * `url` absent and null both mean "none", for the reason `rpc.url` gives:
   * TOML has no null, so a config exported with none set omits the key.
   * The service sees what the user is about to sign, as the main one does.
   */
  secondOpinion: z.object({
    url: z
      .url()
      .nullish()
      .transform((value) => value ?? null),
  }),
});

/**
 * How a signed transaction reaches the chain.
 *
 * `wallet` is ordinary public broadcast: the wallet sends it wherever it
 * normally does, and it sits in the public mempool where anyone can see it and
 * trade ahead of it.
 *
 * `private` sends a *signed raw transaction* straight to a relay such as
 * Flashbots Protect, so it never enters the public mempool. That requires the
 * wallet to sign without broadcasting (`eth_signTransaction`), which many
 * wallets refuse. When it is unavailable spDEX says so and asks, rather than
 * quietly broadcasting publicly under a label that promised otherwise — a
 * privacy feature that silently does nothing is worse than none, because the
 * user changes their behaviour based on it.
 */
export const SubmitterConfigSchema = z.object({
  mode: z.enum(["wallet", "private"]),
  /** Relay endpoint for `private`. Ignored for `wallet`. */
  url: z
    .url()
    .nullish()
    .transform((value) => value ?? null),
  label: z.string().max(64).optional(),
});
export type SubmitterConfig = z.infer<typeof SubmitterConfigSchema>;

export const ModuleRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  /** `builtin` ships with the app; `url`/`ipfs` were installed by the user. */
  source: z.enum(["builtin", "url", "ipfs"]),
  location: z.string().optional(),
  enabled: z.boolean(),
});
export type ModuleRef = z.infer<typeof ModuleRefSchema>;

export const SpdexConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),

  /** Provenance for the diff view: did the user depart from the preset? */
  preset: z.enum(["recommended", "custom"]),

  chainId: z.number().int().positive(),
  rpc: RpcConfigSchema,

  slippageBps: z.number().int().min(1).max(5_000),
  deadlineSeconds: z.number().int().min(30).max(86_400),

  /**
   * Force every module through the QuickJS sandbox, including first-party ones
   * that would otherwise run natively. Exists so a user can verify for
   * themselves that the fast path was never load-bearing.
   */
  strictSandbox: z.boolean(),

  modules: z.array(ModuleRefSchema),
  submitter: SubmitterConfigSchema,
  pools: PoolPolicySchema,
  router: RouterConfigSchema,
  guard: GuardConfigSchema,

  /**
   * Who, if anyone, receives a share of each swap.
   *
   * Lives in the config rather than anywhere else because it is a standing
   * instruction to move the user's money, and everything of that kind in spDEX
   * is a value the user can read, export, diff and hand to someone else. It
   * also means the share travels with a shared config — visibly, in the diff,
   * which is exactly how a hostile shared config would try to smuggle one in.
   */
  tips: TipPolicySchema,

  /**
   * Recurring buys the user has set up, if any.
   *
   * Here for the same reason as `tips`, and more so: a plan spends on a timer
   * with nobody clicking anything at the moment it happens. Holding it in the
   * config means it is exported, diffed and reviewed like every other
   * instruction to move money — and a plan that arrives in a shared link shows
   * up in the diff, paused. What has already been bought is not config; it is
   * a fact about one browser and is kept there.
   */
  dca: DcaPolicySchema,

  /** Extra contracts the user has chosen to trust beyond module manifests. */
  extraTrustedContracts: z.array(AddressSchema),
});

export type SpdexConfig = z.infer<typeof SpdexConfigSchema>;
