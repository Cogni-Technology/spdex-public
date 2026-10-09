/**
 * The Collective DCA panel's side of `@spdex/vault`'s platform reader: when
 * to read, what to keep, and how each figure is written.
 *
 * - **Read on demand.** Nothing is read until the panel is opened, and then
 *   at most once per five minutes per network service, unless the person
 *   presses Read again. No polling: the figures are history, not a ticker.
 * - **Owners and terms once per network service.** They can't change (a
 *   vault's address commits to both), so each is read once per service and
 *   chain for the session, and the owner search shares them. Not across
 *   services: what a replaced service said is dropped with it, as its rates
 *   are.
 * - **Counts, not money.** The panel shows no fiat anywhere: collective
 *   figures stay counts of ETH and SPX, with the exact figure a tap away.
 */

import type { JsonRpc } from "@spdex/chain";
import {
  LATEST_RELEASE,
  MAX_PLATFORM_VAULTS,
  platformReadCost,
  readPlatform,
  type Known,
  type PlatformRead,
  type PlatformSummary,
  type VaultIdentityCache,
} from "@spdex/vault";
import { formatSignificant } from "../dca/format.js";
import { formatCount } from "../money/format.js";
import { networkName } from "../networks.js";
import { formatAmount, TOKEN_LIST } from "../tokens.js";

/** How long a read is shown without asking the network service again. */
export const PLATFORM_CACHE_MS = 5 * 60_000;

export type ReadSummary = Extract<PlatformSummary, { state: "read" }>;

interface CachedRead {
  at: number;
  read: PlatformRead;
}

// Keyed by the endpoint itself: a new network service is a new Engine and a
// new `rpc`, so its figures are never shown for another's.
const reads = new WeakMap<JsonRpc, CachedRead>();
const pending = new WeakMap<JsonRpc, Promise<PlatformRead>>();
const identities = new WeakMap<JsonRpc, Map<number, VaultIdentityCache>>();

/** Owners and terms already read through `rpc` on `chainId`, shared by the panel and the owner search. */
export function vaultIdentities(rpc: JsonRpc, chainId: number): VaultIdentityCache {
  let byChain = identities.get(rpc);
  if (!byChain) {
    byChain = new Map();
    identities.set(rpc, byChain);
  }
  let cache = byChain.get(chainId);
  if (!cache) {
    cache = new Map();
    byChain.set(chainId, cache);
  }
  return cache;
}

/** The last read through `rpc` while it is under five minutes old, or null. Reads nothing. */
export function cachedPlatformRead(rpc: JsonRpc, nowMs: number = Date.now()): PlatformRead | null {
  const cached = reads.get(rpc);
  return cached !== undefined && nowMs - cached.at < PLATFORM_CACHE_MS ? cached.read : null;
}

/**
 * The figures through `rpc`: the cached read when it's fresh and `force`
 * isn't set, otherwise a new one. Two panels asking at once share one read. A
 * failed read isn't kept, so the next open or Try again asks afresh.
 */
export async function loadPlatform(
  rpc: JsonRpc,
  chainId: number,
  options: { force?: boolean; nowMs?: () => number } = {},
): Promise<PlatformRead> {
  const now = options.nowMs ?? Date.now;
  if (options.force !== true) {
    const cached = cachedPlatformRead(rpc, now());
    if (cached !== null) return cached;
  }
  return remember(rpc, now, () => readPlatform(rpc, { cache: vaultIdentities(rpc, chainId) }));
}

/** The vaults `previous` stopped short of, read at its block and added to it. */
export async function loadMorePlatform(
  rpc: JsonRpc,
  chainId: number,
  previous: PlatformRead,
  options: { nowMs?: () => number } = {},
): Promise<PlatformRead> {
  return remember(rpc, options.nowMs ?? Date.now, () => readPlatform(rpc, { previous, cache: vaultIdentities(rpc, chainId) }));
}

function remember(rpc: JsonRpc, now: () => number, read: () => Promise<PlatformRead>): Promise<PlatformRead> {
  const inFlight = pending.get(rpc);
  if (inFlight) return inFlight;
  const promise = read()
    .then((result) => {
      reads.set(rpc, { at: now(), read: result });
      return result;
    })
    .finally(() => pending.delete(rpc));
  pending.set(rpc, promise);
  return promise;
}

// ─── Words ────────────────────────────────────────────────────────────────────

export const COLLECTIVE_TITLE = "Collective DCA: auto-buy vaults";

/** The line under the title: what the figures are, in one breath. */
export const COLLECTIVE_SUBTITLE = "Every spDEX vault, read from chain.";

/** "What's counted?", folded under the figures. Both releases' factories: v1's vaults and v2's, together. */
export const COLLECTIVE_CAVEAT =
  "Only vaults from spDEX's factories. Swaps and confirm-each-buy plans carry no spDEX marker — one would label every user. " +
  "Owners are addresses, not people. Buy fees go to whoever made each buy, or a wallet they named. What open vaults hold " +
  "includes finished ones not yet closed, and WETH anyone sent them. These reads don't name your address.";

/** Where the panel's read stands, as the tile header's summary needs it. */
export type CollectivePhase =
  | { kind: "not-offered" }
  | { kind: "no-service" }
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "failed" }
  | { kind: "ready"; summary: PlatformSummary };

/**
 * The "Collective DCA" tile header's part from the figures: "35 vault buys"
 * ("at least 35 vault buys" when a vault couldn't be read), or where the read
 * stands. Nothing is read for it: "read on open" until the panel is opened.
 */
export function collectiveSummary(phase: CollectivePhase): string {
  switch (phase.kind) {
    case "not-offered":
      return "not on this network";
    case "no-service":
      return "no network service";
    case "idle":
      return "read on open";
    case "reading":
      return "reading…";
    case "failed":
      return "unknown";
    case "ready": {
      const summary = phase.summary;
      if (summary.state !== "read") return "no vaults yet";
      const buys = summary.buys;
      return `${buys.atLeast ? "at least " : ""}${formatCount(buys.value)} vault ${buys.value === 1n ? "buy" : "buys"}`;
    }
  }
}

export function notOfferedText(chainId: number): string {
  return `Vaults aren't offered on ${networkName(chainId)}.`;
}

export function notDeployedText(chainId: number): string {
  return `spDEX's vault factories aren't deployed on ${networkName(chainId)}, so there's no vault activity to read here.`;
}

/** The refusal, with what the network service said, shortened and without a trailing full stop. */
export function readFailedText(error: unknown): string {
  const said = (error instanceof Error ? error.message : String(error)).trim().replace(/\s+/g, " ").replace(/\.$/, "");
  const reason = said === "" ? "no reason given" : said.length > 160 ? `${said.slice(0, 159)}…` : said;
  return `Couldn't read a factory's list (${reason}). Nothing is shown rather than a guess.`;
}

/** "Read at block 26,001,248." That the reads don't name your address is under "What's counted?" (`COLLECTIVE_CAVEAT`). */
export function collectiveFooter(summary: Pick<PlatformSummary, "block">): string {
  return `Read at block ${formatCount(summary.block)}.`;
}

/** What the totals leave out, one sentence per reason, or none when they cover every vault. */
export function partialNotes(summary: ReadSummary): string[] {
  const notes: string[] = [];
  if (summary.unreadable > 0) {
    const listed = summary.read + summary.unreadable;
    notes.push(`${formatCount(BigInt(summary.unreadable))} of ${formatCount(BigInt(listed))} vaults couldn't be read just now; these totals leave them out.`);
  }
  if (summary.unread > 0n) {
    const covered = summary.made - summary.unread;
    notes.push(`These totals cover the first ${formatCount(covered)} of ${formatCount(summary.made)} vaults.`);
  }
  return notes;
}

/**
 * The button for the vaults past the cap, saying what it costs, or null when
 * every vault was read. Owners and terms of vaults not read yet can't be in
 * the cache, and each is costed as a vault of the latest release, the dearest
 * to read (from v2 it adds `windowBuys`), so the count is a ceiling whichever
 * factory lists them.
 */
export function readMoreLabel(summary: ReadSummary): string | null {
  if (summary.unread === 0n) return null;
  const next = summary.unread < BigInt(MAX_PLATFORM_VAULTS) ? Number(summary.unread) : MAX_PLATFORM_VAULTS;
  const cost = platformReadCost([{ release: LATEST_RELEASE, vaults: next }], 0);
  const which = BigInt(next) === summary.unread ? `the other ${formatCount(summary.unread)} vaults` : `${formatCount(BigInt(next))} more of the other ${formatCount(summary.unread)} vaults`;
  return `Read ${which} (up to ${cost} more reads)`;
}

// ─── Figures ──────────────────────────────────────────────────────────────────

/** One figure as a tile or a row shows it: short, and exact on tap when that differs. */
export interface FigureText {
  /** What the tile shows: a count, whole SPX, or ETH to five significant digits. */
  short: string;
  /** Every digit, with its unit; null when `short` is already exact. */
  exact: string | null;
  atLeast: boolean;
}

export interface CollectiveTile {
  id: "buys" | "spx" | "open" | "owners" | "eth" | "fees";
  label: string;
  figure: FigureText;
  hint?: string;
}

/** The six tiles, in the panel's order. The "still buying" tile's hint is built by `openHint`. */
export function collectiveTiles(summary: ReadSummary): CollectiveTile[] {
  return [
    { id: "buys", label: "Buys made", figure: countFigure(summary.buys) },
    { id: "spx", label: "SPX bought", figure: spxFigure(summary.spxDelivered) },
    { id: "open", label: "Vaults still buying", figure: countFigure(summary.open) },
    { id: "owners", label: "Owners", figure: countFigure(summary.owners), hint: summary.owners.value === 1n && !summary.owners.atLeast ? "address" : "addresses" },
    { id: "eth", label: "ETH spent on buys", figure: ethFigure(summary.ethSpent) },
    // Paid in WETH, not ETH: the label names the unit, as "ETH spent on buys" does. A v2 buy pays
    // the wallet its maker names (an owner's Trigger now, the owner), a v1 buy its caller; the
    // caveat says so.
    { id: "fees", label: "Buy fees paid (WETH)", figure: unitFigure(summary.fees, 18, "", " WETH") },
  ];
}

/** "301 made · 16 finished · 273 closed", in parts, so the made count can carry its own test id. */
export function openHint(summary: ReadSummary): { made: string; rest: string } {
  const count = (k: Known<bigint>) => `${k.atLeast ? "at least " : ""}${formatCount(k.value)}`;
  return { made: formatCount(summary.made), rest: `${count(summary.finished)} finished · ${count(summary.closed)} closed` };
}

export interface CollectiveRow {
  id: string;
  label: string;
  figure: FigureText;
  hint?: string;
}

/**
 * The rows under the grid: the budget still committed, the WETH still held,
 * the share of v2 buys paid to community keepers inside their window (only
 * when known), and any other market.
 */
export function collectiveRows(summary: ReadSummary): CollectiveRow[] {
  const rows: CollectiveRow[] = [
    { id: "committed", label: "Budget committed", figure: ethFigure(summary.committed, " ETH"), hint: "for buys still to come" },
    // What it includes (finished vaults not yet closed, WETH anyone sent) is in the caveat.
    { id: "held", label: "Held by open vaults", figure: ethFigure(summary.held, " ETH") },
  ];
  const window = windowShareFigure(summary);
  if (window !== null) {
    // The vault counts a buy by whom it paid (`windowBuys`): a community
    // keeper, inside the window. Who sent it, it doesn't record.
    rows.push({ id: "window", label: "Buys paid to SPX holders", figure: window, hint: "inside the buy's window" });
  }
  for (const { tokenOut, delivered } of summary.otherDelivered) {
    const token = TOKEN_LIST.find((t) => t.address.toLowerCase() === tokenOut);
    rows.push({
      id: `other-${tokenOut}`,
      label: `Delivered on another market (${token?.symbol ?? shortened(tokenOut)})`,
      figure:
        token === undefined
          ? { short: `${formatCount(delivered.value)} base units`, exact: null, atLeast: delivered.atLeast }
          : unitFigure(delivered, token.decimals, ` ${token.symbol}`),
      hint: "vaults buying a token other than SPX",
    });
  }
  return rows;
}

/**
 * The share of buys with a community window that SPX holders made inside it
 * (`communityWindowBuys` of `v2Buys`), as a whole percentage rounded down,
 * with "37 of 100 buys with a community window" a tap away; "none yet" while none has been
 * made, since 0 of 0 is no share at all. Null, and the row left out, while
 * either figure is only a lower bound: a share of a partial read is not a
 * bound of anything, and unknown is never shown as zero. Display only.
 */
export function windowShareFigure(summary: ReadSummary): FigureText | null {
  const { v2Buys, communityWindowBuys: holders } = summary;
  if (v2Buys.atLeast || holders.atLeast) return null;
  if (v2Buys.value === 0n) return { short: "none yet", exact: null, atLeast: false };
  const percent = (holders.value * 100n) / v2Buys.value;
  const short = percent === 0n && holders.value > 0n ? "less than 1%" : `${formatCount(percent)}%`;
  return { short, exact: `${formatCount(holders.value)} of ${formatCount(v2Buys.value)} buys with a community window`, atLeast: false };
}

function countFigure(k: Known<bigint>): FigureText {
  return { short: formatCount(k.value), exact: null, atLeast: k.atLeast };
}

/** Whole SPX, rounded down: a total never reads higher than what was delivered. */
function spxFigure(k: Known<bigint>): FigureText {
  const whole = k.value / 10n ** 8n;
  const short = whole === 0n && k.value > 0n ? "less than 1" : formatCount(whole);
  const exact = `${formatAmount(k.value, 8, { maxFraction: 8 })} SPX`;
  return { short, exact: exact === `${short} SPX` ? null : exact, atLeast: k.atLeast };
}

/** ETH to five significant digits; a tile's label names the unit, a row's figure carries it (`unit`). */
function ethFigure(k: Known<bigint>, unit = ""): FigureText {
  return unitFigure(k, 18, unit, " ETH");
}

function unitFigure(k: Known<bigint>, decimals: number, unit: string, exactUnit = unit): FigureText {
  const short = `${formatSignificant(k.value, decimals, 5, "down")}${unit}`;
  const exact = `${formatAmount(k.value, decimals, { maxFraction: decimals })}${exactUnit}`;
  return { short, exact: exact === `${formatSignificant(k.value, decimals, 5, "down")}${exactUnit}` ? null : exact, atLeast: k.atLeast };
}

function shortened(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
