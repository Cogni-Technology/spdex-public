/**
 * The capability broker.
 *
 * Every capability a module has, it has because this file handed it over. There
 * is no other channel: the native runtime gets its context from here just as the
 * sandbox does, so a first-party module has exactly the reach of a stranger's.
 * That equality is the reason the fast path is a performance decision and not a
 * trust decision.
 *
 * Three invariants, enforced here rather than trusted to callers:
 *
 *   1. A module may only read from contracts its manifest declares.
 *   2. A module may not exceed its declared call budget.
 *   3. A module's log output goes to its own pane, never to the host console.
 *
 * The broker is deliberately additive-only: capabilities may be added over time,
 * but an existing method's shape never changes, so a module written against v1
 * still loads on a v3 host.
 */

import { CONTRACTS } from "@spdex/chain";
import type { Address, ModuleManifest, VenueContext, WireChainCall } from "@spdex/core";

/**
 * Contracts a module may never call, whatever its manifest says.
 *
 * Multicall3 is how the *host* batches reads. A module that named it in its
 * manifest could hand over a nested `aggregate3` payload and reach any contract
 * on chain through it — the broker would check the outer target, find it
 * allowed, and the inner calls would never be examined. That is a complete
 * bypass of the contract allowlist, which is the mechanism the whole capability
 * model rests on.
 *
 * Denying it unconditionally is right rather than merely convenient: a module
 * has no reason to call an aggregator, because batching is a service the host
 * already provides. This is not a denylist standing in for an allowlist — it is
 * a carve-out preventing the allowlist from being turned against itself.
 */
const FORBIDDEN_TARGETS: ReadonlySet<string> = new Set<string>([CONTRACTS.multicall3]);

/** How the host actually reaches the chain. Injected so tests need no network. */
export interface ChainReader {
  /** Execute reads as one batch; returns raw return data, positionally. */
  multicall(calls: { to: Address; data: `0x${string}` }[]): Promise<string[]>;
}

export class CapabilityDeniedError extends Error {
  constructor(
    message: string,
    readonly moduleId: string,
    readonly capability: string,
  ) {
    super(message);
    this.name = "CapabilityDeniedError";
  }
}

export interface BrokerOptions {
  manifest: ModuleManifest;
  chain: ChainReader;
  /** Contracts the user chose to trust beyond the manifest. */
  extraTrustedContracts?: readonly Address[];
  /** Receives the module's log output. Defaults to discarding it. */
  onLog?: (moduleId: string, message: string) => void;
}

/** Accounting for one module invocation, so budgets are per-quote not per-session. */
export class BrokerSession {
  callsUsed = 0;
  readonly logs: string[] = [];
}

export class CapabilityBroker {
  readonly #allowed: Set<string>;

  constructor(private readonly options: BrokerOptions) {
    this.#allowed = new Set<string>([
      ...options.manifest.contracts,
      ...(options.extraTrustedContracts ?? []),
    ]);
  }

  get manifest(): ModuleManifest {
    return this.options.manifest;
  }

  /** A fresh context per invocation — budgets must not leak between quotes. */
  createContext(session: BrokerSession): VenueContext {
    const { manifest, chain, onLog } = this.options;
    const canRead = manifest.capabilities.includes("chain:read");
    const canLog = manifest.capabilities.includes("log");
    const allowed = this.#allowed;

    const multicall = async (calls: WireChainCall[]): Promise<string[]> => {
      if (!canRead) {
        throw new CapabilityDeniedError(
          `module ${manifest.id} did not request the chain:read capability`,
          manifest.id,
          "chain:read",
        );
      }

      // Budget first: a module that would blow its allowance must not get to
      // make the reads and then be told off afterwards.
      if (session.callsUsed + calls.length > manifest.limits.maxCallsPerQuote) {
        throw new CapabilityDeniedError(
          `module ${manifest.id} exceeded its call budget ` +
            `(${session.callsUsed + calls.length} > ${manifest.limits.maxCallsPerQuote})`,
          manifest.id,
          "chain:read",
        );
      }

      for (const call of calls) {
        const to = call.to.toLowerCase() as Address;

        if (FORBIDDEN_TARGETS.has(to)) {
          throw new CapabilityDeniedError(
            `module ${manifest.id} tried to call the host's aggregator at ${to}; ` +
              `batching is provided by the host and calling it directly would bypass ` +
              `the contract allowlist`,
            manifest.id,
            "chain:read",
          );
        }

        if (!allowed.has(to)) {
          // The message names the contract so a user reviewing a rejected
          // module can see exactly what it reached for.
          throw new CapabilityDeniedError(
            `module ${manifest.id} tried to read ${to}, which its manifest does not declare`,
            manifest.id,
            "chain:read",
          );
        }
      }

      session.callsUsed += calls.length;
      return chain.multicall(
        calls.map((c) => ({ to: c.to.toLowerCase() as Address, data: c.data as `0x${string}` })),
      );
    };

    return {
      multicall,
      // Sugar over the batch primitive: one crossing shape to audit, not two.
      async call(call: WireChainCall): Promise<string> {
        const [result] = await multicall([call]);
        return result ?? "0x";
      },
      log(message: string): void {
        if (!canLog) return;
        const trimmed = String(message).slice(0, 1000);
        session.logs.push(trimmed);
        onLog?.(manifest.id, trimmed);
      },
    };
  }
}
