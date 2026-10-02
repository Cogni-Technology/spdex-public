/**
 * venue-uniswap-v2 — routes through Uniswap v2 pairs on Ethereum mainnet.
 *
 * ## Why this matters more than it looks
 *
 * v2 is the older protocol, and for SPX it is overwhelmingly the deeper one.
 * Measured on mainnet at the pinned block: the v2 SPX/WETH pair holds about
 * 2,505 WETH against 45 WETH in the best v3 pool — roughly 98% of the
 * WETH-side liquidity, and a better price with it. A router that knows only
 * about v3 is quoting SPX against a couple of percent of the market.
 *
 * ## Reads go through the Router, not the pair
 *
 * Pricing from reserves would be cheaper: one `getReserves` call, then constant
 * product maths locally for every chunk size, with no further round-trips.
 * It is not possible under the capability model, and that constraint is
 * working as intended — a pair's address is only known after `getPair` returns,
 * so no signed manifest could have declared it in advance. Reading through
 * `Router02.getAmountsOut`, whose address is fixed and declared, keeps the rule
 * absolute: a module never reads an address it did not obtain from an
 * allowlisted contract.
 *
 * The cost is one call per quoted size, which is the same shape as v3's quoter,
 * and the host batches them into a single round-trip anyway.
 */

const FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const ROUTER_02 = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";

/** Verified against viem in abi.test.ts. */
const SELECTORS = {
  getPair: "0xe6a43905", //  getPair(address,address)
  getAmountsOut: "0xd06ca61f", //  getAmountsOut(uint256,address[])
  swapExactTokensForTokens: "0x38ed1739", //  swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
  // The router's wrapping entry points. Same pools, different edges.
  swapExactETHForTokens: "0x7ff36ab5", //  swapExactETHForTokens(uint256,address[],address,uint256)
  swapExactTokensForETH: "0x18cbafe5", //  swapExactTokensForETH(uint256,uint256,address[],address,uint256)
};

/**
 * Base units used to test whether the pair can actually trade.
 *
 * Same reasoning as the v3 module: the module cannot read a token's decimals,
 * because token contracts are not in its manifest, so there is no universally
 * correct value. This exists to separate an existing pair from a tradeable
 * one, and `depth` is a coarse by-product rather than a routing input.
 */
const PROBE_AMOUNT = 1000000000000n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Minimal ABI codec ─────────────────────────────────────────────────────

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

/** v2 sorts a pair's tokens by address, like v3. */
function sortTokens(a, b) {
  const lowerA = String(a).toLowerCase();
  const lowerB = String(b).toLowerCase();
  return lowerA < lowerB ? [lowerA, lowerB] : [lowerB, lowerA];
}

function getPairCall(token0, token1) {
  return { to: FACTORY, data: SELECTORS.getPair + encAddress(token0) + encAddress(token1) };
}

/**
 * `getAmountsOut(amountIn, [tokenIn, tokenOut])`.
 *
 * One level of dynamic encoding: two head words, then an offset to the path
 * array, then the array itself. The offset is 0x40 because the head is exactly
 * two words long — a detail the unit tests check against viem rather than trust.
 */
function amountsOutCall(tokenIn, tokenOut, amountIn) {
  return {
    to: ROUTER_02,
    data:
      SELECTORS.getAmountsOut +
      encUint(amountIn) +
      encUint(64) +
      encUint(2) +
      encAddress(tokenIn) +
      encAddress(tokenOut),
  };
}

/** `uint256[]` returns as offset, length, then elements. */
function decodeAmountsOut(raw) {
  if (!hasWords(raw, 4)) return null;
  const length = decUint(raw, 1);
  if (length < 2n) return null;
  return decUint(raw, 3);
}

const spdexModule = {
  apiVersion: "1.0.0",

  async discoverPools(pair, ctx) {
    const [token0, token1] = sortTokens(pair.tokenA, pair.tokenB);

    const [rawPair] = await ctx.multicall([getPairCall(token0, token1)]);
    if (!hasWords(rawPair, 1)) return [];

    const pairAddress = decAddress(rawPair, 0);
    // The factory returns the zero address for a pair that was never created.
    if (pairAddress === ZERO_ADDRESS) return [];

    // A pair can exist and hold nothing; the Router reverts when it does, and
    // the host returns "0x" for that entry rather than failing the batch.
    const [rawProbe] = await ctx.multicall([
      amountsOutCall(pair.tokenA, pair.tokenB, PROBE_AMOUNT),
    ]);
    const probe = decodeAmountsOut(rawProbe);
    if (probe === null || probe === 0n) {
      ctx.log("v2 pair exists but cannot trade");
      return [];
    }

    ctx.log("discovered the v2 pair");
    return [
      {
        poolId: pairAddress,
        token0: token0,
        token1: token1,
        // v2 has a single fixed 0.30% fee; there are no tiers to choose between.
        fee: 3000,
        depth: probe.toString(),
        label: "Uniswap v2",
      },
    ];
  },

  async quoteBatch(requests, pools, ctx) {
    if (pools.length === 0 || requests.length === 0) return [];

    // v2 has exactly one pair per token pair, so this is one call per requested
    // size rather than a cross-product.
    const results = await ctx.multicall(
      requests.map(function (r) {
        return amountsOutCall(r.tokenIn, r.tokenOut, r.amountIn);
      }),
    );

    const quotes = [];
    for (let i = 0; i < results.length; i++) {
      const amountOut = decodeAmountsOut(results[i]);
      if (amountOut === null || amountOut === 0n) continue;

      quotes.push({
        poolId: pools[0].poolId,
        tokenIn: String(requests[i].tokenIn).toLowerCase(),
        tokenOut: String(requests[i].tokenOut).toLowerCase(),
        amountIn: String(requests[i].amountIn),
        amountOut: amountOut.toString(),
        // A v2 swap is a fixed amount of work: transferFrom, swap, transfer.
        gasEstimate: "150000",
      });
    }
    return quotes;
  },

  /*
   * Three entry points, one pool.
   *
   * v2 pairs are always ERC-20/ERC-20 — there is no native-ETH pair and there
   * cannot be one, since the factory is typed on two token addresses. What the
   * router offers is wrapping at its own edges, so selling ETH is the same
   * pool reached through a different function, not a different pool.
   *
   * That is why the path is unchanged in all three cases: it is always
   * [WETH, token]. Only the entry point and where the value rides differ.
   */
  async buildCalls(quote, params, ctx) {
    const nativeIn = params.nativeIn === true;
    const nativeOut = params.nativeOut === true;

    // swapExactETHForTokens(amountOutMin, path, to, deadline) — the input
    // arrives as msg.value, so there is no amountIn word and, crucially, no
    // approval: nobody needs an allowance to spend their own ether.
    if (nativeIn) {
      const data =
        SELECTORS.swapExactETHForTokens +
        encUint(params.minAmountOut) +
        encUint(128) +
        encAddress(params.recipient) +
        encUint(params.deadline) +
        encUint(2) +
        encAddress(quote.tokenIn) +
        encAddress(quote.tokenOut);

      return {
        approvals: [],
        calls: [{ to: ROUTER_02, data: data, value: String(quote.amountIn) }],
        quotedAmountOut: String(quote.amountOut),
        gasEstimate: String(quote.gasEstimate),
        poolIds: [String(quote.poolId).toLowerCase()],
      };
    }

    // swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline) — the
    // router takes delivery of the WETH itself, unwraps it and forwards ether
    // to `to`. Same head layout as the token-to-token form.
    const selector = nativeOut
      ? SELECTORS.swapExactTokensForETH
      : SELECTORS.swapExactTokensForTokens;

    const data =
      selector +
      encUint(quote.amountIn) +
      // Recipient, minimum and deadline all come from the host's intent.
      encUint(params.minAmountOut) +
      encUint(160) +
      encAddress(params.recipient) +
      encUint(params.deadline) +
      encUint(2) +
      encAddress(quote.tokenIn) +
      encAddress(quote.tokenOut);

    return {
      approvals: [
        {
          token: String(quote.tokenIn).toLowerCase(),
          spender: ROUTER_02,
          amount: String(quote.amountIn),
        },
      ],
      calls: [{ to: ROUTER_02, data: data, value: "0" }],
      quotedAmountOut: String(quote.amountOut),
      gasEstimate: String(quote.gasEstimate),
      poolIds: [String(quote.poolId).toLowerCase()],
    };
  },
};

globalThis.spdexModule = spdexModule;
