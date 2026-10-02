/*
 * tracker-pool-stats — what is actually sitting in each pool.
 *
 * ## The trick this module is built around
 *
 * A module may only call contracts its signed manifest declares, and a pool's
 * address is not known until a factory hands it over. That is why
 * `WirePoolRef.depth` is a venue-defined proxy and not a real number: no
 * manifest could have allowlisted the pool in advance.
 *
 * The way through is that the broker checks a call's *target*, not its
 * arguments. `balanceOf(pool)` is a call to the **token** — fixed address,
 * trivially declarable — and the pool is just a parameter. So this module
 * reads the true balance any pool holds without one dynamic address being
 * allowlisted, and without the capability model bending at all.
 *
 * ## What that costs, stated rather than hidden
 *
 * A tracker knows only the tokens it declared. KNOWN_TOKENS below mirrors the
 * manifest's `contracts` exactly, and a pool holding anything else comes back
 * `supported: false`. The duplication is deliberate: the module has to decide
 * *before* calling, because a denied call fails the whole batch rather than
 * one entry, and a fabricated zero would be indistinguishable from an empty
 * pool — which is a reason not to trade.
 *
 * ## No volume here
 *
 * Volume needs event logs, and `eth_getLogs` is not a capability the broker
 * offers. A log filter is a far larger surface than a batched `eth_call`, and
 * widening the broker to satisfy a display statistic would be a bad trade. The
 * host computes volume separately and attaches it. That also keeps this
 * module's output a pure function of its input at a given block, which is what
 * the conformance suite demands.
 */

/**
 * Tokens this tracker can read, lowercase.
 *
 * Must stay identical to `contracts` in manifest.json. If they drift, the
 * broker denies the call and the batch fails — loudly, which is the right
 * direction for a mismatch of this kind.
 */
const KNOWN_TOKENS = [
  "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c", // SPX
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
];

/** `balanceOf(address)`. */
const SELECTOR_BALANCE_OF = "0x70a08231";

function encAddress(address) {
  return String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function known(address) {
  return KNOWN_TOKENS.indexOf(String(address).toLowerCase()) !== -1;
}

/** Decode a uint256 return, treating a reverted "0x" as zero rather than throwing. */
function toAmount(result) {
  if (typeof result !== "string" || result === "0x" || result.length < 3) return "0";
  return BigInt(result).toString();
}

const spdexModule = {
  apiVersion: "1.0.0",

  /**
   * Two reads per supported pool, in one batch.
   *
   * Pools whose tokens are not declared are filtered out *before* the batch is
   * built, not after: the broker denies the whole call if any target is
   * unlisted, so including one would cost every other pool its statistics.
   */
  async scanPools(pools, ctx) {
    const list = Array.isArray(pools) ? pools : [];

    const readable = [];
    const unsupported = [];
    for (const pool of list) {
      if (known(pool.token0) && known(pool.token1)) readable.push(pool);
      else unsupported.push(pool);
    }

    const calls = [];
    for (const pool of readable) {
      calls.push({ to: pool.token0, data: SELECTOR_BALANCE_OF + encAddress(pool.poolId) });
      calls.push({ to: pool.token1, data: SELECTOR_BALANCE_OF + encAddress(pool.poolId) });
    }

    const results = calls.length > 0 ? await ctx.multicall(calls) : [];

    const stats = [];
    for (let i = 0; i < readable.length; i++) {
      const pool = readable[i];
      stats.push({
        poolId: String(pool.poolId).toLowerCase(),
        supported: true,
        token0: String(pool.token0).toLowerCase(),
        token1: String(pool.token1).toLowerCase(),
        balance0: toAmount(results[i * 2]),
        balance1: toAmount(results[i * 2 + 1]),
        fee: Number(pool.fee) || 0,
      });
    }

    for (const pool of unsupported) {
      stats.push({
        poolId: String(pool.poolId).toLowerCase(),
        supported: false,
        token0: String(pool.token0).toLowerCase(),
        token1: String(pool.token1).toLowerCase(),
        balance0: "0",
        balance1: "0",
        fee: Number(pool.fee) || 0,
      });
    }

    // Sorted by pool id so the output is a pure function of the input set
    // rather than of the order it arrived in. The conformance suite compares
    // bytes, and "same pools, different order" must not be a different answer.
    stats.sort((a, b) => (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
    return stats;
  },
};

globalThis.spdexModule = spdexModule;
