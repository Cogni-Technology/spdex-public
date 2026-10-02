// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.33;

import {FullMath} from "./FullMath.sol";
import {TickMath} from "./TickMath.sol";
import {IUniswapV3OracleMinimal} from "../interfaces/External.sol";

/// @title OracleQuote: a time-weighted price, and how deep the market behind it is
/// @notice The pieces of Uniswap v3-periphery's `OracleLibrary` (GPL-2.0-or-later) the
///         vault needs: `consult` — the arithmetic-mean tick and the harmonic-mean
///         liquidity over a window — and `getQuoteAtTick`. The arithmetic is Uniswap's;
///         the changes are Solidity 0.8 casts, reading `observe` through a minimal
///         interface, and returning the liquidity unnarrowed (see `means`). `wethDepth` is
///         this project's: the standard virtual-reserve formula, so that a depth can be
///         stated in WETH.
/// @dev This is the same kind of reference the app's oracle cross-check already uses
///      (`packages/chain/src/oracle.ts`, also a 600-second v3 TWAP): a price that has to
///      be held off-market for the whole window to be moved, which costs real money for
///      every block of it, rather than the spot price of the pool being traded, which an
///      attacker who moved that pool has moved as well. "Costs real money" holds only
///      while someone is providing liquidity where the price is, which is why the
///      liquidity half is here too: a pool nobody provides to can be moved for nothing.
library OracleQuote {
    /// @notice The pool's arithmetic-mean tick and harmonic-mean in-range liquidity over
    ///         the last `window` seconds, in one `observe`.
    /// @dev Reverts (with the pool's own reason, "OLD") when the pool's recorded history
    ///      does not reach back `window` seconds.
    function consult(address pool, uint32 window) internal view returns (int24 meanTick, uint256 meanLiquidity) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s) =
            IUniswapV3OracleMinimal(pool).observe(secondsAgos);
        return means(tickCumulatives, secondsPerLiquidityCumulativeX128s, window);
    }

    /// @notice `consult` for a caller that must not revert: `answered` is false, and the
    ///         other two zero, when the pool cannot give a `window`-second average right now.
    /// @dev A view that reports a vault's state should still answer while its pool cannot
    ///      ("OLD": a history that does not reach back the window), and the factory wants its
    ///      own error rather than the pool's. Only the call is guarded: a pool that answers
    ///      with fewer than two entries still reverts in `means`, and no pool Uniswap's
    ///      factory lists can.
    function tryConsult(address pool, uint32 window)
        internal
        view
        returns (bool answered, int24 meanTick, uint256 meanLiquidity)
    {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try IUniswapV3OracleMinimal(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s
        ) {
            (meanTick, meanLiquidity) = means(tickCumulatives, secondsPerLiquidityCumulativeX128s, window);
            answered = true;
        } catch {}
    }

    /// @notice `consult`'s arithmetic, on cumulatives already read: `observe([window, 0])`'s
    ///         two answers.
    /// @dev The mean tick rounds toward negative infinity, as Uniswap's OracleLibrary does.
    ///      Truncating toward zero instead would bias every pair whose tick is negative —
    ///      and since a pool orders its tokens by address, that is an arbitrary half of them.
    ///
    ///      The pool adds `seconds × 2^128 / liquidity` to its seconds-per-liquidity
    ///      accumulator (counting an empty range as liquidity 1), so `window × 2^128` over
    ///      the difference is the harmonic mean of the liquidity in range across the
    ///      window. A harmonic mean is dominated by its smallest terms: a few seconds spent
    ///      where nobody provides liquidity drag it towards zero, which is the property the
    ///      vault wants. Uniswap narrows the result to uint128; that silently truncates the
    ///      answer for an accumulator that grew by less than the window, which no genuine
    ///      pool reports but an impostor could, so here it stays 256 bits. A difference of
    ///      zero — infinite liquidity — is impossible for a genuine pool and is answered
    ///      as none at all.
    function means(int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s, uint32 window)
        internal
        pure
        returns (int24 meanTick, uint256 meanLiquidity)
    {
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 span = int56(uint56(window));
        // A mean of ticks, each within ±887272, is within that range too.
        // forge-lint: disable-next-line(unsafe-typecast)
        meanTick = int24(delta / span);
        if (delta < 0 && (delta % span != 0)) meanTick--;

        uint160 secondsPerLiquidity;
        // The accumulator is a uint160 that Uniswap lets wrap; the difference is taken
        // modulo 2^160 as the original's 0.7 arithmetic does.
        unchecked {
            secondsPerLiquidity = secondsPerLiquidityCumulativeX128s[1] - secondsPerLiquidityCumulativeX128s[0];
        }
        if (secondsPerLiquidity != 0) {
            meanLiquidity = (uint256(window) * type(uint160).max) / (uint256(secondsPerLiquidity) << 32);
        }
    }

    /// @notice How much WETH the pool behaves as if it held at `tick`, given `liquidity`
    ///         in range: its virtual WETH reserve, `L / √P` when WETH is token0 and
    ///         `L · √P` when it is token1.
    /// @dev A constant-product pool holding this much WETH (and the matching other side)
    ///      would move its price exactly as the pool does for a small trade here. It says
    ///      nothing about how far that depth extends: one narrow position can have a large
    ///      virtual reserve and very little actual WETH behind it.
    function wethDepth(int24 tick, uint256 liquidity, bool wethIsToken0) internal pure returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        return wethIsToken0
            ? FullMath.mulDiv(liquidity, 1 << 96, sqrtRatioX96)
            : FullMath.mulDiv(liquidity, sqrtRatioX96, 1 << 96);
    }

    /// @notice How much `quoteToken` `baseAmount` of `baseToken` is worth at `tick`,
    ///         in raw units, at the mid price (no fee, no price impact).
    /// @dev Uniswap's `getQuoteAtTick`: squares the Q64.96 square-root price with full
    ///      precision where that fits in 256 bits, and via a Q128 intermediate where it
    ///      does not. The direction follows the pool's convention that the price is
    ///      token1 per token0, and token0 is the lower address.
    function quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }
}
