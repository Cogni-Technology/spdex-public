/**
 * What the keeper knows about the chain: which vaults it watches, and what
 * each one's progress, balance and price were when it last looked.
 *
 * Discovery reads the listed factories' own lists (or checks an allowlist
 * against them) and adds each vault they vouch for, of every release alike,
 * each read with its release's own source's ABI (`decodeTerms`); the accounting pass reads every
 * watched vault's progress and balance every `accountingSeconds`, and retires
 * what is closed or finished; and every tick reads, in each release's SPX
 * holder registry, whether the keeper's `rewardTo` may be paid inside that
 * release's community windows. The reads themselves take an endpoint and the
 * WETH address, never the tick, and a figure one could not get comes back
 * null — unknown, never zero, and never eligible.
 *
 * Nothing here decides whether to send, or signs: `keeper.ts` plans from what
 * this file cached, and `keeper-pending.ts` follows what was sent.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "@spdex/core";
import { CONTRACTS, Multicall3Reader, type JsonRpc } from "@spdex/chain";
import { FACTORY_ABI, VAULT_ABI, type Deployment } from "./artifacts.js";
import {
  WETH_ABI,
  decodeOr,
  decodeTerms,
  decodeVaultProgress,
  findVaultNonce,
  onTurn,
  readHolderStatus,
  vaultProgressCallCount,
  vaultProgressCalls,
  type VaultProgress,
  type VaultTerms,
} from "./index.js";
import { dueSinceAt, earliestBuyAt, turnEndsAtOf, urgentFrom, windowOf } from "./keeper-plan.js";
import { revertDataOf } from "./keeper-send.js";
import type { VaultEntry } from "./keeper-state.js";
import type { Tick } from "./keeper.js";

/**
 * Clones proven per tick, at most. A proof is a search over the owner's nonces,
 * at most `MAX_VAULT_NONCE_SEARCH` (4,096) CREATE2 addresses, about a quarter
 * of a second; an honest owner's count is a handful. The bound is for an
 * endpoint that lies about the count, which can make the search long and fail,
 * never succeed: so a tick spends at most a few seconds on it, and a failed
 * vault rests an hour.
 */
const PROOFS_PER_TICK = 10;

/** Vaults read from a factory's list per call. */
const DISCOVERY_PAGE = 500n;
/** Discovery's `eth_call`s per tick, at most: a keeper starting late catches up over several ticks. */
const DISCOVERY_MAX_CALLS = 20;
/** Vaults per Multicall3 call. */
const VAULTS_PER_CALL = 30;
/** Vaults per Multicall3 call when only their WETH is read. */
const BALANCES_PER_CALL = 200;
const MULTICALL_GAS = 30_000_000n;
/** How long an address no listed factory vouches for, or a vault that cannot pay, waits before it is read again. */
export const RECHECK_SECONDS = 3_600n;
/** A transaction sent now lands in a later block: about this much later, on Ethereum. */
const NEXT_BLOCK_SECONDS = 12n;

const PAIR_ABI = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);

// ─── Blocks ───────────────────────────────────────────────────────────────────

export interface Head {
  number: bigint;
  timestamp: bigint;
  baseFee: bigint | null;
  gasUsed: bigint;
  gasLimit: bigint;
}

export async function readHead(rpc: JsonRpc): Promise<Head> {
  const b = (await rpc("eth_getBlockByNumber", ["latest", false])) as {
    number: string;
    timestamp: string;
    baseFeePerGas?: string | null;
    gasUsed: string;
    gasLimit: string;
  } | null;
  if (!b) throw new Error("the endpoint returned no latest block");
  return {
    number: BigInt(b.number),
    timestamp: BigInt(b.timestamp),
    baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null,
    gasUsed: BigInt(b.gasUsed),
    gasLimit: BigInt(b.gasLimit),
  };
}

export async function blockAt(rpc: JsonRpc, number: bigint): Promise<{ timestamp: bigint; baseFee: bigint | null }> {
  const b = (await rpc("eth_getBlockByNumber", [hex(number), false])) as { timestamp: string; baseFeePerGas?: string | null } | null;
  if (!b) throw new Error(`the endpoint has no block ${number}`);
  return { timestamp: BigInt(b.timestamp), baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null };
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Find vaults: every vault in every release's factory list, or only the
 * allowlist. A listed vault is vouched for by construction — the same call
 * that set `isVault` appended it — so a lagging endpoint can never make one
 * look untrusted. Bounded per tick, so a keeper starting long after the
 * factory catches up over several ticks, saying `syncing` meanwhile.
 */
export async function discover(t: Tick): Promise<"syncing" | "running"> {
  if (t.config.vaults !== null) {
    await discoverAllowlisted(t, t.config.vaults);
    return "running";
  }
  const { state, policy } = t;
  const behind = () => Object.values(state.deployments).some((d) => d.vaultCount !== null && d.scannedCount < d.vaultCount);
  const due = state.discoveredAt === null || t.chainTime >= state.discoveredAt + policy.discoverySeconds || behind();
  if (!due) return behind() ? "syncing" : "running";

  let budget = DISCOVERY_MAX_CALLS;
  for (const deployment of t.config.deployments) {
    const known = state.deployments[deployment.id];
    if (!known || budget <= 0) continue;
    budget -= 1;
    const count = await callOrNull(t.rpc, deployment.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }), (data) =>
      decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", data }),
    );
    // No factory on this chain for this release: nothing to discover there.
    if (count === null) continue;
    known.vaultCount = count;
    while (known.scannedCount < count && budget > 0) {
      budget -= 1;
      const page = await callOrNull(
        t.rpc,
        deployment.factory,
        encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultsPage", args: [known.scannedCount, DISCOVERY_PAGE] }),
        (data) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", data }).map(lower),
      );
      if (page === null || page.length === 0) break;
      let progressed = true;
      for (let i = 0; i < page.length && budget > 0 && progressed; i += VAULTS_PER_CALL) {
        budget -= 1;
        const chunk = page.slice(i, i + VAULTS_PER_CALL);
        const read = await readOwnersAndTerms(t.rpc, chunk, []);
        for (const vault of chunk) {
          const r = read.get(vault);
          if (!r?.owner || r.termsData === undefined || r.termsData === "0x") {
            progressed = false;
            break;
          }
          // A factory lists only clones of its own implementation, so its vaults answer in its release's source's
          // shape. One that doesn't is not a vault this keeper can judge: passed over, and said so, never guessed at.
          const terms = decodeTerms(r.termsData, deployment.source);
          if (terms === null) {
            t.emit({ type: "error", where: "discover", message: `${vault} on ${deployment.id}'s list answers terms of another source than ${deployment.source}; it is passed over` });
          } else if (!state.vaults[vault] && !state.retired.includes(vault)) {
            addVault(t, vault, deployment.id, known.scannedCount, r.owner, terms);
          }
          known.scannedCount += 1n;
        }
      }
      t.emit({ type: "sync", deployment: deployment.id, scannedCount: known.scannedCount, vaultCount: count });
      await t.persist();
      if (!progressed) break;
    }
  }
  state.discoveredAt = t.chainTime;
  return behind() ? "syncing" : "running";
}

/**
 * The allowlist: each address not yet known is read once, with every listed
 * factory asked whether it vouches for it. One none vouches for is rechecked
 * hourly and never dropped for good: vouching can't be taken back, but an
 * endpoint can be wrong for a while.
 */
async function discoverAllowlisted(t: Tick, allowlist: readonly Address[]): Promise<void> {
  const { state } = t;
  const toCheck = allowlist.filter((vault) => {
    if (state.vaults[vault] || state.retired.includes(vault)) return false;
    const notVouched = state.notVouched[vault];
    return !notVouched || t.chainTime >= notVouched.recheckAt;
  });
  for (let i = 0; i < toCheck.length; i += VAULTS_PER_CALL) {
    const chunk = toCheck.slice(i, i + VAULTS_PER_CALL);
    const read = await readOwnersAndTerms(t.rpc, chunk, t.config.deployments);
    for (const vault of chunk) {
      const r = read.get(vault);
      const deployment = r?.vouchedBy ?? null;
      const listed = t.config.deployments.find((d) => d.id === deployment);
      // Its terms as its vouching release's source lays them out: a vault of that factory answers in no other shape.
      const terms = listed ? decodeTerms(r?.termsData, listed.source) : null;
      if (r?.owner && terms && deployment && listed) {
        delete state.notVouched[vault];
        addVault(t, vault, deployment, null, r.owner, terms);
        continue;
      }
      const detail = !r?.termsData || r.termsData === "0x" || (listed && !terms) ? "not a vault" : "no listed factory vouches for it";
      if (!state.notVouched[vault]) {
        t.emit({ type: "skip", vault, slot: null, code: "not-vouched", detail });
      }
      state.notVouched[vault] = { since: state.notVouched[vault]?.since ?? t.chainTime, recheckAt: t.chainTime + RECHECK_SECONDS };
      t.result.skipped.push({ vault, code: "not-vouched", detail });
    }
  }
}

function addVault(t: Tick, vault: Address, deployment: string, index: bigint | null, owner: Address, terms: VaultTerms): void {
  t.state.vaults[vault] = {
    deployment,
    index,
    owner,
    terms,
    nonce: null,
    buysDone: 0n,
    lastBuyAt: 0n,
    closed: false,
    balance: null,
    readAt: null,
    recheckAt: null,
    restingUntil: null,
    paidRefusals: null,
    lastSkip: null,
    watchedSlot: null,
  };
  // The market list its release records it was deployed with (deployments.json). A factory deployed with another
  // list is another release, so the index is the one its own list gives; one no market matches is left unknown
  // rather than guessed, and the report takes it from `VaultCreated` in any case.
  const markets = t.config.deployments.find((d) => d.id === deployment)?.markets ?? [];
  const marketIndex = markets.findIndex((m) => lower(m.tokenOut) === terms.tokenOut && lower(m.pair) === terms.pair && lower(m.oraclePool) === terms.oraclePool);
  t.emit({
    type: "vault_found",
    vault,
    deployment,
    index,
    owner,
    marketIndex: marketIndex === -1 ? null : marketIndex,
    tokenOut: terms.tokenOut,
    amountPerBuy: terms.amountPerBuy,
    interval: terms.interval,
    maxBuys: terms.maxBuys,
    startAt: terms.startAt,
    keeperReward: terms.keeperReward,
    maxSlippageBps: terms.maxSlippageBps,
    communityWindow: terms.communityWindow,
    turnBuckets: terms.turnBuckets,
  });
}

/** A vault that is closed or has made its last buy: never read again. */
export function retire(t: Tick, vault: Address, reason: "closed" | "done"): void {
  delete t.state.vaults[vault];
  delete t.state.trapped[vault];
  if (!t.state.retired.includes(vault)) t.state.retired.push(vault);
  t.outcomes.delete(vault);
  t.emit({ type: "vault_retired", vault, reason });
}

// ─── Proving a vault is its factory's ─────────────────────────────────────────

/**
 * Prove, before any of `vaults` is first sent, that each is its factory's
 * clone, without believing the endpoint: its CREATE2 address is recomputed from
 * the factory, the owner and terms it answers, and a nonce below the factory's
 * `nonces(owner)` (`findVaultNonce`), and it is admitted only when that is its
 * address. The batcher from v2 on asks no factory whether it is calling a
 * vault, so this is what stands between an endpoint that lists a hostile
 * contract in a factory's `vaultsPage`, and answers its simulation as well, and
 * this key paying that contract up to `gasPerVault` a batch. A lying endpoint
 * can only make a proof fail — then the vault is skipped (`unproven`) and
 * rested an hour — never make one pass: an address that matches is the
 * factory's clone with exactly those terms, on the real chain.
 *
 * The owner and terms are read again for the proof, so a read the endpoint got
 * wrong at discovery does not keep a vault out for good; when the proof holds,
 * they replace the cached ones. The nonce is kept, and a vault is proven once.
 * v1's batcher still asks its factory, and its vaults are proven the same way.
 */
export async function proveClones(t: Tick, vaults: readonly Address[]): Promise<void> {
  const todo = vaults.filter((vault) => t.state.vaults[vault]?.nonce === null).slice(0, PROOFS_PER_TICK);
  if (todo.length === 0) return;
  const factoryOf = (vault: Address) => {
    const e = t.state.vaults[vault]!;
    return t.config.deployments.find((d) => d.id === e.deployment) ?? null;
  };
  const calls = todo.flatMap((vault) => {
    const e = t.state.vaults[vault]!;
    const factory = lower(factoryOf(vault)?.factory ?? vault);
    return [
      { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) },
      { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "terms" }) },
      { to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "nonces", args: [e.owner] }) },
    ];
  });
  let results: string[];
  try {
    results = await reader(t.rpc, 3 * VAULTS_PER_CALL).multicall(calls);
  } catch {
    // Nothing read: nothing proven, and nothing sent unproven. The next tick tries again.
    for (const vault of todo) unproven(t, vault, "its owner, terms and factory nonce could not be read", false);
    return;
  }
  todo.forEach((vault, i) => {
    const e = t.state.vaults[vault]!;
    const deployment = factoryOf(vault);
    const at = (k: number) => results[i * 3 + k];
    const owner = decodeOr(at(0), (data) => lower(decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data })));
    if (owner !== null && owner !== e.owner) {
      // The owner read now is not the one cached: the count was asked for the wrong one. Asked again for this one
      // next tick; nothing about it is believed until then.
      e.owner = owner;
      unproven(t, vault, "its owner read now differs from the one cached; its factory nonce is read again", false);
      return;
    }
    const terms = deployment === null ? null : decodeTerms(at(1), deployment.source);
    const below = decodeOr(at(2), (data) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "nonces", data }));
    const nonce =
      deployment === null || owner === null || terms === null || below === null
        ? null
        : findVaultNonce({ factory: lower(deployment.factory), owner, terms, vault, below });
    if (nonce === null) {
      unproven(t, vault, `its address is not where ${deployment?.id ?? "its"} factory puts a vault for the owner and terms read`, true);
      return;
    }
    e.owner = owner!;
    e.terms = terms!;
    e.nonce = nonce;
  });
}

/** A vault not proven its factory's: skipped, and, when the reads answered and did not match, rested an hour. */
function unproven(t: Tick, vault: Address, detail: string, rest: boolean): void {
  const e = t.state.vaults[vault];
  if (!e) return;
  if (rest) e.restingUntil = t.chainTime + RECHECK_SECONDS;
  t.result.skipped.push({ vault, code: "unproven", detail });
  t.outcomes.set(vault, { code: "unproven", detail });
}

// ─── Accounting ───────────────────────────────────────────────────────────────

/**
 * Every active vault's progress and balance, and the keeper's own ether (and
 * WETH, when its rewards come to it), every `accountingSeconds` whether or not
 * anything is due: what retires finished vaults, notices other keepers' buys,
 * and keeps the heartbeat's figures true. No prices: the oracle's `observe`
 * is the dear part of a read, and only vaults about to be sent need it.
 */
export async function accountingRead(t: Tick): Promise<void> {
  const { state } = t;
  // A vault that could not pay for its next buy when last read can neither buy nor be bought until it is
  // topped up, so between hourly full reads only its WETH is read, many to a call: vaults made and never
  // funded cost little to create, and must not cost every keeper four reads each, every pass, for good.
  const idle = new Set(
    entries(state.vaults)
      .filter(([, e]) => e.readAt !== null && t.chainTime < e.readAt + RECHECK_SECONDS && e.balance !== null && e.balance < e.terms.amountPerBuy + e.terms.keeperReward)
      .map(([vault]) => vault),
  );
  const vaults = (Object.keys(state.vaults) as Address[]).filter((vault) => !idle.has(vault));
  const reads = await readVaults(t.rpc, t.config.weth, vaults, false);
  for (const vault of vaults) {
    const read = reads.get(vault);
    if (read && applyRead(t, vault, read)) t.outcomes.set(vault, t.outcomes.get(vault) ?? "ok");
  }
  // A top-up shows here, and the vault is read in full when it is next due.
  for (const [vault, balance] of await readBalances(t.rpc, t.config.weth, [...idle])) if (balance !== null) state.vaults[vault]!.balance = balance;
  if (t.keeper !== null) {
    const balance = BigInt((await t.rpc("eth_getBalance", [t.keeper, "latest"])) as string);
    state.balanceWei = balance;
    if (balance < t.policy.minEth && !state.lowBalance) {
      state.lowBalance = true;
      t.emit({ type: "low_balance", etherWei: balance, thresholdWei: t.policy.minEth, neededWei: null });
    } else if (balance >= t.policy.minEth) {
      state.lowBalance = false;
    }
    if (t.rewardTo === t.keeper) {
      t.keeperWeth = await callOrNull(t.rpc, t.config.weth, encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [t.keeper] }), (data) =>
        decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data }),
      );
    }
  }
  state.accountedAt = t.chainTime;
}

/** Record a read in the cache: someone else's buy is `overtaken`, a closed or finished vault retires. False when it cannot be used. */
export function applyRead(t: Tick, vault: Address, read: VaultProgress): boolean {
  const e = t.state.vaults[vault];
  if (!e || read.buysDone === null || read.lastBuyAt === null || read.closed === null) return false;
  if (e.readAt !== null && read.buysDone > e.buysDone) {
    t.emit({ type: "overtaken", vault, slot: windowOf(e.terms, read.lastBuyAt).slot });
  }
  e.buysDone = read.buysDone;
  e.lastBuyAt = read.lastBuyAt;
  e.closed = read.closed;
  if (read.balance !== null) e.balance = read.balance;
  e.readAt = t.chainTime;
  if (e.closed) {
    retire(t, vault, "closed");
    return false;
  }
  const slot = currentSlot(t, e);
  if (slot === null) {
    retire(t, vault, "done");
    return false;
  }
  e.watchedSlot ??= slot;
  return true;
}

/** The window a vault's next buy falls in: the one open now once it is due, else the one it comes due in; null when it has no buy left. */
export function currentSlot(t: Pick<Tick, "chainTime">, e: VaultEntry): bigint | null {
  const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
  return earliest === null ? null : windowOf(e.terms, earliest > t.chainTime ? earliest : t.chainTime).slot;
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Whether the keeper's `rewardTo` may be paid inside each listed release's
 * community windows, read every tick from each release's SPX holder registry
 * (`readHolderStatus`: the registry's own `isEligible`, `validUntil`, the SPX
 * balance and whether it is an account, at the head), into
 * `state.eligibility`. Nothing is read without a `rewardTo` — a dry run with
 * no key and none configured — and then nothing is eligible. A registry with
 * no code answers not eligible: its vaults fail closed, and their buys open to
 * anyone when their windows end.
 */
export async function readEligibility(t: Tick): Promise<void> {
  const holder = t.rewardTo;
  for (const d of t.config.deployments) {
    if (d.registry === null) continue;
    const registry = lower(d.registry);
    if (holder === null) {
      delete t.state.eligibility[d.id];
      continue;
    }
    const status = await readHolderStatus(t.rpc, holder, { registry, reader: reader(t.rpc, VAULTS_PER_CALL) });
    t.state.eligibility[d.id] =
      status.state === "not-deployed"
        ? { registry, holder, eligible: null, validUntil: null, spx: null, isAccount: null, readAt: t.chainTime }
        : { registry, holder, eligible: status.eligible, validUntil: status.validUntil, spx: status.balance, isAccount: status.isAccount, readAt: t.chainTime };
  }
}

/**
 * Whether this keeper's `rewardTo` may be paid inside `e`'s community window,
 * by this tick's read: it is the vault's owner (always allowed, and the fee
 * comes back to them), or its release's registry answered `isEligible` true
 * at this head and its proof is still valid in the next block — the earliest
 * a buy sent now is made, and where the vault asks; a proof that lapses
 * before then would only buy a `NotEligible`. Anything unknown — no
 * `rewardTo`, no read this tick, a read that failed — is "no": a keeper never
 * assumes it is eligible.
 */
export function mayBePaidInWindow(t: Pick<Tick, "rewardTo" | "chainTime" | "state">, e: VaultEntry): boolean {
  if (t.rewardTo === null) return false;
  if (t.rewardTo === e.owner) return true;
  const read = t.state.eligibility[e.deployment];
  return (
    read !== undefined &&
    read.holder === t.rewardTo &&
    read.readAt === t.chainTime &&
    read.eligible === true &&
    read.validUntil !== null &&
    read.validUntil >= t.chainTime + NEXT_BLOCK_SECONDS
  );
}

/**
 * A vault's community window around its next buy, as the vault will judge it
 * at `now` (`dueSinceAt`): when the buy fell due, the first second it is open
 * to anyone (`endsAt`), and from when an eligible keeper bids the urgent tip
 * (`urgentAt`, decision 19). Null for a vault whose source has no window
 * (v1's), and for one with no buy left.
 */
export function communityWindowOf(e: VaultEntry, now: bigint): { dueSince: bigint; endsAt: bigint; urgentAt: bigint } | null {
  const window = e.terms.communityWindow;
  if (window === null) return null;
  const dueSince = dueSinceAt(e.terms, e.buysDone, e.lastBuyAt, now);
  if (dueSince === null) return null;
  const endsAt = dueSince + window;
  return { dueSince, endsAt, urgentAt: urgentFrom(endsAt, window) };
}

/**
 * Until when another bucket of holders has first claim on `vault`'s due buy, for
 * a keeper that may be paid inside its window but whose `rewardTo` is not in the
 * slot's bucket: the end of its turn (`turnEndsAtOf`), the window's first half,
 * after which any eligible holder may be paid. Null when the plan has no turns,
 * the buy is not due or its turn is over, or `rewardTo` is the owner or in the
 * bucket (`onTurn`) — then nothing about turns holds it back. Recomputed from
 * the head every tick, never kept.
 */
export function turnHeldUntil(t: Pick<Tick, "rewardTo" | "chainTime">, vault: Address, e: VaultEntry): bigint | null {
  if (t.rewardTo === null) return null;
  const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
  if (earliest === null || t.chainTime < earliest) return null;
  const turnEndsAt = turnEndsAtOf(e.terms, e.buysDone, e.lastBuyAt, t.chainTime);
  if (turnEndsAt === null || t.chainTime >= turnEndsAt) return null;
  const dueSince = dueSinceAt(e.terms, e.buysDone, e.lastBuyAt, t.chainTime);
  if (dueSince === null) return null;
  return onTurn({ vault, owner: e.owner, rewardTo: t.rewardTo, terms: e.terms, dueSince, now: t.chainTime }) ? null : turnEndsAt;
}

/**
 * Until when SPX holders have first claim on `e`'s due buy, for a keeper
 * that may not be paid inside its window; null when a buy sent now is open
 * to anyone (or the vault is v1's, or not due). That is the window's end —
 * unless the buy's slot ends before a transaction sent now could land: then
 * it would land in the next slot, as that slot's buy, inside that slot's own
 * window (decision 10), and the vault would refuse it. So then it is the
 * next slot's window's end. Recomputed from the head every tick, never kept.
 */
export function holdersFirstUntil(e: VaultEntry, now: bigint): bigint | null {
  const earliest = earliestBuyAt(e.terms, e.buysDone, e.lastBuyAt);
  const window = communityWindowOf(e, now);
  if (earliest === null || window === null || now < earliest) return null;
  if (now < window.endsAt) return window.endsAt;
  const slotEnd = windowOf(e.terms, now).windowEnd;
  return now + NEXT_BLOCK_SECONDS >= slotEnd ? slotEnd + e.terms.communityWindow! : null;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * `owner()` and `terms()` of each vault — the terms as the vault answered them,
 * for the caller to decode with the source of the release that vouches for it
 * (`decodeTerms`): one selector, an answer of each source's shape — and, when
 * `vouching` names releases, which of their factories vouches for it.
 */
async function readOwnersAndTerms(
  rpc: JsonRpc,
  vaults: readonly Address[],
  vouching: readonly Deployment[],
): Promise<Map<Address, { owner: Address | null; termsData: string | undefined; vouchedBy: string | null }>> {
  const per = 2 + vouching.length;
  const calls = vaults.flatMap((vault) => [
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "owner" }) },
    { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "terms" }) },
    ...vouching.map((d) => ({ to: lower(d.factory), data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "isVault", args: [vault] }) })),
  ]);
  const results = await reader(rpc, per * VAULTS_PER_CALL).multicall(calls);
  const out = new Map<Address, { owner: Address | null; termsData: string | undefined; vouchedBy: string | null }>();
  vaults.forEach((vault, i) => {
    const at = (k: number) => results[i * per + k];
    const owner = decodeOr(at(0), (data) => lower(decodeFunctionResult({ abi: VAULT_ABI, functionName: "owner", data })));
    const vouchedBy = vouching.find((_, k) => decodeOr(at(2 + k), (data) => decodeFunctionResult({ abi: FACTORY_ABI, functionName: "isVault", data })) === true)?.id ?? null;
    out.set(vault, { owner, termsData: at(1), vouchedBy });
  });
  return out;
}

/** Each vault's progress (`vaultProgressCalls`), with `quote()` when asked: one Multicall3 call per 30 vaults. */
export async function readVaults(rpc: JsonRpc, weth: Address, vaults: readonly Address[], withQuote: boolean): Promise<Map<Address, VaultProgress>> {
  const per = vaultProgressCallCount(withQuote);
  const calls = vaults.flatMap((vault) => vaultProgressCalls(vault, weth, withQuote));
  const results = vaults.length === 0 ? [] : await reader(rpc, per * VAULTS_PER_CALL).multicall(calls);
  return new Map(vaults.map((vault, i) => [vault, decodeVaultProgress(results, i * per, withQuote)]));
}

/** Each vault's WETH alone; null where it could not be read. */
async function readBalances(rpc: JsonRpc, weth: Address, vaults: readonly Address[]): Promise<Map<Address, bigint | null>> {
  if (vaults.length === 0) return new Map();
  const token = lower(weth);
  const results = await reader(rpc, BALANCES_PER_CALL).multicall(
    vaults.map((vault) => ({ to: token, data: encodeFunctionData({ abi: WETH_ABI, functionName: "balanceOf", args: [vault] }) })),
  );
  return new Map(vaults.map((vault, i) => [vault, decodeOr(results[i], (data) => decodeFunctionResult({ abi: WETH_ABI, functionName: "balanceOf", data }))]));
}

/** Each distinct pair's WETH reserve, for the public pair cap; null where it could not be read. */
export async function readReserves(rpc: JsonRpc, weth: Address, terms: readonly VaultTerms[]): Promise<Map<Address, bigint | null>> {
  const pairs = [...new Map(terms.map((x) => [x.pair, x])).values()];
  const results = await reader(rpc, VAULTS_PER_CALL).multicall(pairs.map((x) => ({ to: x.pair, data: encodeFunctionData({ abi: PAIR_ABI, functionName: "getReserves" }) })));
  const token = lower(weth);
  return new Map(
    pairs.map((x, i) => {
      const reserves = decodeOr(results[i], (data) => decodeFunctionResult({ abi: PAIR_ABI, functionName: "getReserves", data }));
      // Uniswap v2 orders a pair's tokens by address.
      return [x.pair, reserves === null ? null : BigInt(token < x.tokenOut ? reserves[0] : reserves[1])];
    }),
  );
}

/** An `eth_call`'s answer decoded; null for a call that failed, or returned nothing (no code there). */
async function callOrNull<T>(rpc: JsonRpc, to: Address, data: Hex, decode: (data: Hex) => T): Promise<T | null> {
  let answer: Hex;
  try {
    answer = (await rpc("eth_call", [{ to, data }, "latest"])) as Hex;
  } catch (error) {
    if (revertDataOf(error) !== null) return null;
    throw error;
  }
  return decodeOr(answer, decode);
}

function reader(rpc: JsonRpc, batchSize: number): Multicall3Reader {
  return new Multicall3Reader(rpc, { batchSize, gasLimit: MULTICALL_GAS, multicall3: CONTRACTS.multicall3 });
}

const entries = (vaults: Record<Address, VaultEntry>): [Address, VaultEntry][] => Object.entries(vaults) as [Address, VaultEntry][];
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const lower = (a: string): Address => a.toLowerCase() as Address;
