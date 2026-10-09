/**
 * Whether the endpoint can test-run a transaction, asked in a way that tells
 * "it cannot" from "it did not answer".
 *
 * The chain package's `EthSimulateV1Provider` probes once and remembers the
 * answer for the provider's life, a failure included. For a manual swap that
 * costs a person one "unverified" banner until the next config change. For a
 * scheduled buy it would cost every buy until the page reloads: a scheduled
 * buy is never signed unverified, so one dropped connection at the moment of
 * the first probe would skip every buy after it and stop the plan — "unknown"
 * turned into "unavailable for good". So the scheduled path asks through
 * `DefiniteSimulationProvider`, which remembers only a definite answer, and
 * so do swaps, tips and vault transactions: on the built-in service, shared by
 * every visitor and rate-limited, a probe refused for a moment is ordinary,
 * and it must not leave every later swap "not checked" until a reload.
 */

import {
  EthSimulateV1Provider,
  probeSimulateV1,
  type JsonRpc,
  type SecondOpinion,
  type SimulationOutcome,
  type SimulationProvider,
  type SimulationRequest,
} from "@spdex/chain";
import { SECOND_OPINION_TIMEOUT_MS, secondOpinionHost } from "@spdex/guard";

/**
 * `eth_simulateV1`, remembering only a definite answer.
 *
 * Available: remembered. "No such method": remembered — the endpoint will not
 * grow one before the config changes, and a config change builds a new
 * Engine. Anything else: this check is unverified, and the next one asks
 * again.
 */
export class DefiniteSimulationProvider extends EthSimulateV1Provider {
  readonly #probe: JsonRpc;
  #known: boolean | null = null;

  constructor(rpc: JsonRpc) {
    super(rpc);
    this.#probe = rpc;
  }

  override async isAvailable(): Promise<boolean> {
    if (this.#known !== null) return this.#known;
    const answer = await probeSimulateV1(this.#probe);
    if (answer !== "unknown") this.#known = answer;
    return answer === true;
  }
}

// ── A second opinion ─────────────────────────────────────────────────────────
//
// A second network service, run by someone else, test-runs every transaction
// too (config `guard.secondOpinion.url`; the comparison itself is the Guard's
// `AgreeingSimulationProvider`). What lives here is the app's side of it:
// telling whether the second service is really a second one, keeping it from
// holding a check up for ever, and remembering what the last check heard, for
// the status strip.

/**
 * How spDEX compares two service addresses: scheme and host lowercased, a
 * default port and a trailing "/" removed, and the rest (the path, where a
 * key usually sits) exactly as typed. Null when it isn't an http(s) address.
 */
export function normalizeServiceUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // URL already lowercases the scheme and host and drops a default port.
  const path = parsed.pathname.replace(/\/+$/, "");
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `${parsed.protocol}//${parsed.hostname}${port}${path}${parsed.search}`;
}

/** Whether two addresses name the same service, by `normalizeServiceUrl`; unreadable addresses are never the same. */
export function sameService(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = normalizeServiceUrl(a);
  return left !== null && left === normalizeServiceUrl(b);
}

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * The name two services share when they are probably run by the same
 * operator: the same host, or the same last two labels of it ("alchemy.com").
 * A heuristic, with no public-suffix list, so it only ever warns. An IP
 * address or a one-label name ("localhost") is compared whole: the last two
 * labels of an address say nothing about who runs it.
 */
export function sharedOperator(a: string, b: string): string | null {
  // The host alone, as the Guard names the second service: never the path, where a key sits.
  const left = secondOpinionHost(a.trim());
  const right = secondOpinionHost(b.trim());
  if (left === "" || right === "") return null;
  if (left === right) return left;
  if (IP_LITERAL.test(left) || IP_LITERAL.test(right)) return null;
  const tail = (host: string) => {
    const labels = host.split(".").filter((label) => label !== "");
    return labels.length < 2 ? null : labels.slice(-2).join(".");
  };
  const shared = tail(left);
  return shared !== null && shared === tail(right) ? shared : null;
}

/** The warning for two services that are probably one operator's. Never a refusal. */
export function sameOperatorWarning(domain: string): string {
  return `Both are at ${domain}: probably the same operator, so not much of a second opinion.`;
}

/**
 * What a refusal says when the second service didn't answer on a path that
 * never signs on one service's test-run alone. The Guard's code for it,
 * SECOND_OPINION_UNAVAILABLE, is a warning everywhere else ("checked on one
 * service only"), so a refusal needs words of its own:
 * - `vault`: a vault transaction that sends ether, or a Permit2 permission;
 * - `batch`: a batch of other people's vault buys;
 * - `strict`: anything, under "Refuse to sign anything unsimulated".
 */
export function secondOpinionRefusalText(path: "vault" | "batch" | "strict"): string {
  switch (path) {
    case "vault":
      return "Not sent — your second network service didn't answer. A transaction that sends ETH or grants a permission waits until both agree.";
    case "batch":
      return "Not sent — your second network service didn't answer, and a batch of vault buys is never sent on one service's test-run alone. Try again in a moment.";
    case "strict":
      return "Your second network service didn't answer, and you've set spDEX to refuse anything not fully checked. Press Refresh price to ask both again.";
  }
}

/** How long any one request to the second service may take: the Guard's own figure, so the two can't drift apart. */
export { SECOND_OPINION_TIMEOUT_MS };

/** Thrown when a request took longer than its limit; the request itself may still finish. */
export class RpcTimeout extends Error {
  constructor(
    readonly method: string,
    readonly ms: number,
  ) {
    super(`${method}: no answer within ${Math.round(ms / 1000)} s`);
    this.name = "RpcTimeout";
  }
}

/**
 * `rpc`, with every request given up after `ms`. A second opinion that
 * hangs must not hold a check up for ever: once it has taken too long, it
 * didn't answer, which is the one way it can make a check "unverified".
 */
export function withTimeout(rpc: JsonRpc, ms: number = SECOND_OPINION_TIMEOUT_MS): JsonRpc {
  return (method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcTimeout(method, ms)), ms);
      rpc(method, params).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}

/**
 * What the app knows about the second opinion, for the status strip:
 * - `off`: none is set;
 * - `same`: the one set is the main service again, so it isn't used (a
 *   config link can do this; the setting can't);
 * - `on`: one is set, and `last` is what the latest check heard from it
 *   (null before any check has run).
 */
export type SecondOpinionStatus =
  | { kind: "off" }
  | { kind: "same" }
  | { kind: "on"; host: string; last: SecondOpinion["kind"] | null; sameOperator: string | null };

/**
 * A simulation provider that passes everything through untouched and tells
 * `onSecondOpinion` what each check's second opinion said. It never changes
 * an outcome: the Guard sees exactly what the comparing provider returned.
 */
export class ObservedSimulationProvider implements SimulationProvider {
  constructor(
    private readonly inner: SimulationProvider,
    private readonly onSecondOpinion: (opinion: SecondOpinion) => void,
  ) {}

  get kind(): SimulationProvider["kind"] {
    return this.inner.kind;
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    const outcome = await this.inner.simulate(request);
    if (outcome.secondOpinion !== undefined) {
      try {
        this.onSecondOpinion(outcome.secondOpinion);
      } catch {
        // What the strip shows must never change what a check returns.
      }
    }
    return outcome;
  }
}

/**
 * The second opinion's status, kept current and subscribable
 * (`useSyncExternalStore`). One per Engine: a new second service is a new
 * config, and a new config builds a new Engine.
 */
export class SecondOpinionMonitor {
  #status: SecondOpinionStatus;
  readonly #listeners = new Set<() => void>();

  constructor(initial: SecondOpinionStatus) {
    this.#status = initial;
  }

  get status(): SecondOpinionStatus {
    return this.#status;
  }

  /** Record what a check heard. Only an `on` status has anything to record. */
  heard(opinion: SecondOpinion): void {
    const current = this.#status;
    if (current.kind !== "on" || current.last === opinion.kind) return;
    this.#status = { ...current, last: opinion.kind };
    for (const listener of [...this.#listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
