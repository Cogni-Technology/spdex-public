// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.33;

/// @title TickMath: the square-root price at a Uniswap v3 tick
/// @notice Vendored from Uniswap v3-core (`contracts/libraries/TickMath.sol`,
///         GPL-2.0-or-later, which this project's AGPL-3.0-or-later may include).
///         Only `getSqrtRatioAtTick` is here; the vault never needs the inverse.
/// @dev The magic constants are successive powers of sqrt(1.0001) in Q128.128, copied
///      from the original rather than recomputed: they are consensus values, and a
///      derivation that rounded differently would disagree with the pool by a tick at
///      the boundaries. The same constants are transcribed in TypeScript in
///      `packages/chain/src/oracle.ts`, which the app's oracle already relies on.
///
///      Changes from the original, all forced by Solidity 0.8: the body is `unchecked`,
///      because the original was written for 0.7 and relies on wrapping (the
///      `ratio * constant` products are meant to overflow into the high bits that the
///      `>> 128` then discards — they cannot actually exceed 256 bits, but the
///      compiler cannot prove it); `int24` to `uint256` goes through `int256`, which 0.8
///      requires for sign changes; and the out-of-range `require` is a custom error.
library TickMath {
    /// @notice The tick is outside the range Uniswap v3 prices can take.
    error TickOutOfRange();

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// @notice sqrt(1.0001^tick) as a Q64.96 fixed-point number: sqrt(token1 / token0).
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast) — the magnitude of an int24.
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            // forge-lint: disable-next-line(unsafe-typecast) — MAX_TICK is positive.
            if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfRange();

            uint256 ratio =
                absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            // The loop computed 1 / sqrt(1.0001^|tick|); a positive tick wants the inverse.
            if (tick > 0) ratio = type(uint256).max / ratio;

            // Q128.128 down to Q64.96, rounding up so the result never understates the
            // price. That makes getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t in the
            // original, and is kept here for the same answers at the same ticks.
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
