/**
 * venue-uniswap-v3 — routes through Uniswap v3 pools on Ethereum mainnet.
 *
 * ## Why this file has no imports
 *
 * A sandboxed module is a single self-contained script: QuickJS has no module
 * loader and no npm. This one needs viem only for ABI encoding, and every
 * signature it uses takes a *static* tuple — fixed-width words, no dynamic
 * offsets — so encoding them by hand is a few lines and removes the bundler
 * from the story entirely. Selectors are hardcoded and verified against viem in
 * `abi.test.ts`, so a transcription error cannot survive CI.
 *
 * ## Why discovery asks the factory instead of deriving addresses
 *
 * Uniswap v3 pool addresses are deterministic, so they can be computed with
 * CREATE2 and no RPC. Two reasons not to:
 *
 *   1. CREATE2 answers "where would this pool live", not "does it exist".
 *      Verified on mainnet: SPX/WETH has no 0.01% pool, yet the derivation
 *      still produces a perfectly plausible address with no code behind it.
 *      Quoting it would be noise at best.
 *   2. It needs keccak256, which would mean shipping a hash implementation
 *      inside the sandbox.
 *
 * Reads are batched anyway, so asking the factory costs nothing extra and is
 * authoritative. A probe quote then separates deployed-but-empty pools from
 * ones that can actually trade.
 */

const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const QUOTER_V2 = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const SWAP_ROUTER_02 = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";

/** Verified against viem in abi.test.ts. */
const SELECTORS = {
  getPool: "0x1698ee82", //  getPool(address,address,uint24)
  quoteExactInputSingle: "0xc6a5026a", //  quoteExactInputSingle((address,address,uint256,uint24,uint160))
  exactInputSingle: "0x04e45aaf", //  exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  // Receiving native ETH needs two router calls in one transaction: swap the
  // WETH to the router itself, then have it unwrap and forward.
  multicall: "0xac9650d8", //  multicall(bytes[])
  unwrapWETH9: "0x49404b7c", //  unwrapWETH9(uint256,address)
};

/**
 * SwapRouter02's sentinel for "pay this to the router".
 *
 * Not a real account. The router substitutes its own address when it sees it,
 * which is how the proceeds of a swap can be left in place for a second call
 * in the same transaction to unwrap.
 */
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

const FEE_TIERS = [100, 500, 3000, 10000];

/**
 * ABI-encode a `bytes[]` argument, without an ABI library.
 *
 * The layout, which is the whole of the difficulty:
 *
 *   word 0        offset to the array, always 0x20 for a lone argument
 *   word 1        number of elements
 *   words 2..n+1  offset of each element, measured from the start of word 2
 *   then          each element: its length, then its bytes, padded to 32
 *
 * The offsets being relative to the *end of the head* rather than to the start
 * of the encoding is the part that is easy to get wrong, and the failure mode
 * is not a revert — it is a transaction that decodes into some other call.
 * `test/unit/native.test.ts` compares the output against viem for exactly
 * that reason.
 */
function encodeBytesArray(items) {
  const bodies = items.map(function (item) {
    const hex = String(item).replace(/^0x/, "");
    const padded = hex + "0".repeat((64 - (hex.length % 64)) % 64);
    return { length: hex.length / 2, payload: padded };
  });

  let head = encUint(0x20) + encUint(bodies.length);
  // Each element's offset skips the remaining offset words, then every body
  // already laid out before it.
  let cursor = bodies.length * 32;
  for (let i = 0; i < bodies.length; i++) {
    head += encUint(cursor);
    cursor += 32 + bodies[i].payload.length / 2;
  }

  let tail = "";
  for (let i = 0; i < bodies.length; i++) {
    tail += encUint(bodies[i].length) + bodies[i].payload;
  }
  return head + tail;
}

/**
 * Base units used to test whether a pool can actually trade.
 *
 * There is no good universal value — the module cannot know a token's decimals
 * without reading it, and token contracts are not in its manifest. 1e12 is a
 * deliberate middle ground: large enough that a dead pool reverts or returns
 * zero, small enough not to move a live one. It exists to answer "can this pool
 * trade at all", and `depth` is a coarse by-product, never a routing input.
 */
const PROBE_AMOUNT = 1000000000000n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Minimal ABI codec: static types only ──────────────────────────────────

function word(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}
function encAddress(address) {
  return word(String(address).toLowerCase().replace(/^0x/, ""));
}
function encUint(value) {
  return word(BigInt(value).toString(16));
}
function decAddress(data, index) {
  return "0x" + data.slice(2 + index * 64 + 24, 2 + (index + 1) * 64);
}
function decUint(data, index) {
  const slice = data.slice(2 + index * 64, 2 + (index + 1) * 64);
  return slice.length === 0 ? 0n : BigInt("0x" + slice);
}
function hasWords(data, count) {
  return typeof data === "string" && data.length >= 2 + count * 64;
}

/** Uniswap orders a pool's tokens by address; callers may pass either order. */
function sortTokens(a, b) {
  const lowerA = String(a).toLowerCase();
  const lowerB = String(b).toLowerCase();
  return lowerA < lowerB ? [lowerA, lowerB] : [lowerB, lowerA];
}

function getPoolCall(token0, token1, fee) {
  return {
    to: FACTORY,
    data: SELECTORS.getPool + encAddress(token0) + encAddress(token1) + encUint(fee),
  };
}

function quoteCall(tokenIn, tokenOut, amountIn, fee) {
  return {
    to: QUOTER_V2,
    data:
      SELECTORS.quoteExactInputSingle +
      encAddress(tokenIn) +
      encAddress(tokenOut) +
      encUint(amountIn) +
      encUint(fee) +
      encUint(0), // sqrtPriceLimitX96 = 0 means "no limit"
  };
}

const spdexModule = {
  apiVersion: "1.0.0",

  async discoverPools(pair, ctx) {
    const [token0, token1] = sortTokens(pair.tokenA, pair.tokenB);

    // Round one: which tiers exist at all.
    const poolResults = await ctx.multicall(
      FEE_TIERS.map(function (fee) {
        return getPoolCall(token0, token1, fee);
      }),
    );

    const candidates = [];
    for (let i = 0; i < FEE_TIERS.length; i++) {
      const raw = poolResults[i];
      if (!hasWords(raw, 1)) continue;
      const address = decAddress(raw, 0);
      // The factory returns the zero address for a tier that was never created.
      if (address === ZERO_ADDRESS) continue;
      candidates.push({ poolId: address, fee: FEE_TIERS[i] });
    }

    if (candidates.length === 0) return [];

    // Round two: which of them can actually trade. A pool can be deployed and
    // hold nothing, in which case the quoter reverts and the host hands back
    // "0x" for that entry — positional, so it still lines up with its pool.
    const probes = await ctx.multicall(
      candidates.map(function (c) {
        return quoteCall(pair.tokenA, pair.tokenB, PROBE_AMOUNT, c.fee);
      }),
    );

    const pools = [];
    for (let i = 0; i < candidates.length; i++) {
      const raw = probes[i];
      if (!hasWords(raw, 1)) continue;
      const amountOut = decUint(raw, 0);
      if (amountOut === 0n) continue;

      pools.push({
        poolId: candidates[i].poolId,
        token0: token0,
        token1: token1,
        fee: candidates[i].fee,
        depth: amountOut.toString(),
        label: "Uniswap v3 " + (candidates[i].fee / 10000).toFixed(2) + "%",
      });
    }

    ctx.log("discovered " + pools.length + " tradeable pools of " + candidates.length + " deployed");
    return pools;
  },

  async quoteBatch(requests, pools, ctx) {
    if (pools.length === 0 || requests.length === 0) return [];

    // Every (request, pool) combination in a single crossing. Split routing
    // needs each pool priced at each chunk size, and doing that one call at a
    // time is what makes a sandboxed quote feel slow.
    const calls = [];
    const index = [];
    for (let r = 0; r < requests.length; r++) {
      for (let p = 0; p < pools.length; p++) {
        calls.push(quoteCall(requests[r].tokenIn, requests[r].tokenOut, requests[r].amountIn, pools[p].fee));
        index.push({ request: r, pool: p });
      }
    }

    const results = await ctx.multicall(calls);

    const quotes = [];
    for (let i = 0; i < results.length; i++) {
      const raw = results[i];
      // A reverted quote means no route at this size — ordinary, not an error.
      if (!hasWords(raw, 1)) continue;
      const amountOut = decUint(raw, 0);
      if (amountOut === 0n) continue;

      const gasEstimate = hasWords(raw, 4) ? decUint(raw, 3) : 0n;
      quotes.push({
        poolId: pools[index[i].pool].poolId,
        tokenIn: String(requests[index[i].request].tokenIn).toLowerCase(),
        tokenOut: String(requests[index[i].request].tokenOut).toLowerCase(),
        venueData: String(pools[index[i].pool].fee),
        amountIn: String(requests[index[i].request].amountIn),
        amountOut: amountOut.toString(),
        // QuoterV2 reports the swap's own gas; the router adds overhead on top.
        gasEstimate: (gasEstimate > 0n ? gasEstimate + 40000n : 180000n).toString(),
      });
    }

    return quotes;
  },

  async buildCalls(quote, params, ctx) {
    const pool = (quote.poolId || "").toLowerCase();

    // The fee tier travels with the quote in venueData, so the common path
    // needs no extra round-trip. It is only a hint: if it is missing or does
    // not name the pool that was priced, fall back to asking the factory
    // rather than encoding a swap through some other pool.
    let resolvedFee = null;
    const hinted = quote.venueData ? parseInt(quote.venueData, 10) : NaN;
    if (FEE_TIERS.indexOf(hinted) !== -1) {
      resolvedFee = hinted;
    }

    if (resolvedFee === null) {
      const [token0, token1] = sortTokens(quote.tokenIn, quote.tokenOut);
      const results = await ctx.multicall(
        FEE_TIERS.map(function (f) {
          return getPoolCall(token0, token1, f);
        }),
      );
      for (let i = 0; i < FEE_TIERS.length; i++) {
        if (hasWords(results[i], 1) && decAddress(results[i], 0) === pool) {
          resolvedFee = FEE_TIERS[i];
          break;
        }
      }
    }
    if (resolvedFee === null) {
      throw new Error("cannot resolve fee tier for pool " + pool);
    }

    const nativeIn = params.nativeIn === true;
    const nativeOut = params.nativeOut === true;

    /*
     * Selling native ETH needs no different calldata at all.
     *
     * SwapRouter02 pays a pool by wrapping its own balance when the input
     * token is WETH and it is holding enough ether, so the identical
     * exactInputSingle simply arrives with a value attached. That is worth
     * stating because it looks like an omission: there is no ETH-specific
     * encoding here because the router does not need one.
     *
     * Receiving it is the opposite. The swap has to deliver to the router
     * rather than to the user, so a second call can unwrap and forward — and
     * two calls in one transaction is what `multicall` is for.
     */
    const swapData =
      SELECTORS.exactInputSingle +
      encAddress(quote.tokenIn) +
      encAddress(quote.tokenOut) +
      encUint(resolvedFee) +
      // Recipient and minimum come from the host's intent, never from here.
      encAddress(nativeOut ? ADDRESS_THIS : params.recipient) +
      encUint(quote.amountIn) +
      encUint(params.minAmountOut) +
      encUint(0);

    let data = swapData;
    if (nativeOut) {
      // unwrapWETH9 repeats the minimum. The router checks it again before
      // forwarding, so the floor the user was shown is enforced twice rather
      // than assumed to have held across the two calls.
      const unwrapData =
        SELECTORS.unwrapWETH9 + encUint(params.minAmountOut) + encAddress(params.recipient);
      data = SELECTORS.multicall + encodeBytesArray([swapData, unwrapData]);
    }

    return {
      // No allowance when the input is ether: there is nothing to approve.
      approvals: nativeIn
        ? []
        : [
            { token: String(quote.tokenIn).toLowerCase(), spender: SWAP_ROUTER_02, amount: String(quote.amountIn) },
          ],
      calls: [{ to: SWAP_ROUTER_02, data: data, value: nativeIn ? String(quote.amountIn) : "0" }],
      quotedAmountOut: String(quote.amountOut),
      gasEstimate: String(quote.gasEstimate),
      poolIds: [pool],
    };
  },
};

globalThis.spdexModule = spdexModule;
