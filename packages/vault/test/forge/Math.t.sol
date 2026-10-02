// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {Test} from "./utils/Test.sol";
import {MockOraclePool} from "./utils/Mocks.sol";
import {FullMath} from "../../contracts/libraries/FullMath.sol";
import {TickMath} from "../../contracts/libraries/TickMath.sol";
import {OracleQuote} from "../../contracts/libraries/OracleQuote.sol";

/// The vendored libraries against the values Uniswap's own test suites pin.
///
/// These need no fork: they are pure arithmetic, and a transcription error in a magic
/// constant is exactly the kind of mistake that reads as correct. The expected values
/// are Uniswap's (v3-core's TickMath and FullMath specs, v3-periphery's OracleLibrary
/// spec), and they also agree with the TypeScript transcription in
/// `packages/chain/src/oracle.ts`, which the app's oracle uses.
contract MathTest is Test {
    uint256 private constant Q128 = 1 << 128;

    // Library calls are internal; these wrappers give `expectRevert` a call to watch.
    function sqrtAt(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }

    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return FullMath.mulDiv(a, b, d);
    }

    function test_getSqrtRatioAtTick_knownValues() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(-887272), 4295128739, "MIN_TICK");
        assertEq(TickMath.getSqrtRatioAtTick(-887271), 4295343490, "MIN_TICK + 1");
        assertEq(TickMath.getSqrtRatioAtTick(-50), 79030349367926598376800521322, "-50");
        assertEq(TickMath.getSqrtRatioAtTick(-1), 79224201403219477170569942574, "-1");
        assertEq(TickMath.getSqrtRatioAtTick(0), 1 << 96, "0 is exactly 2^96");
        assertEq(TickMath.getSqrtRatioAtTick(1), 79232123823359799118286999568, "1");
        assertEq(TickMath.getSqrtRatioAtTick(50), 79426470787362580746886972461, "50");
        assertEq(TickMath.getSqrtRatioAtTick(100), 79625275426524748796330556128, "100");
        assertEq(TickMath.getSqrtRatioAtTick(1000), 83290069058676223003182343270, "1000");
        assertEq(TickMath.getSqrtRatioAtTick(50000), 965075977353221155028623082916, "50000");
        assertEq(TickMath.getSqrtRatioAtTick(150000), 143194173941309278083010301478497, "150000");
        assertEq(TickMath.getSqrtRatioAtTick(500000), 5697689776495288729098254600827762987878, "500000");
        assertEq(TickMath.getSqrtRatioAtTick(738203), 847134979253254120489401328389043031315994541, "738203");
        assertEq(TickMath.getSqrtRatioAtTick(887271), 1461373636630004318706518188784493106690254656249, "MAX_TICK - 1");
        assertEq(TickMath.getSqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342, "MAX_TICK");
    }

    function test_getSqrtRatioAtTick_refusesOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(TickMath.TickOutOfRange.selector));
        this.sqrtAt(887273);
        vm.expectRevert(abi.encodeWithSelector(TickMath.TickOutOfRange.selector));
        this.sqrtAt(-887273);
    }

    function test_mulDiv_knownValues() public pure {
        uint256 max = type(uint256).max;
        assertEq(FullMath.mulDiv(Q128, (50 * Q128) / 100, (150 * Q128) / 100), Q128 / 3, "Q128 x 0.5 / 1.5");
        assertEq(FullMath.mulDiv(max, max, max), max, "max x max / max");
        assertEq(FullMath.mulDiv(Q128, 35 * Q128, 8 * Q128), (4375 * Q128) / 1000, "Q128 x 35 / 8");
        assertEq(FullMath.mulDiv(Q128, 1000 * Q128, 3000 * Q128), Q128 / 3, "Q128 x 1000 / 3000");
        // A product that needs all 512 bits, divided back into range.
        assertEq(FullMath.mulDiv(1 << 255, 4, 8), 1 << 254, "2^255 x 4 / 8");
        // And an ordinary one, which must agree with plain arithmetic.
        assertEq(FullMath.mulDiv(123456789, 987654321, 1000), (uint256(123456789) * 987654321) / 1000, "small");
    }

    function test_mulDiv_refusesZeroDenominatorAndOverflow() public {
        vm.expectRevert(abi.encodeWithSelector(FullMath.MulDivOverflow.selector));
        this.mulDiv(Q128, 5, 0);
        vm.expectRevert(abi.encodeWithSelector(FullMath.MulDivOverflow.selector));
        this.mulDiv(Q128, Q128, 0);
        vm.expectRevert(abi.encodeWithSelector(FullMath.MulDivOverflow.selector));
        this.mulDiv(Q128, Q128, 1);
        vm.expectRevert(abi.encodeWithSelector(FullMath.MulDivOverflow.selector));
        this.mulDiv(type(uint256).max, type(uint256).max, type(uint256).max - 1);
    }

    /// v3-periphery's OracleLibrary spec pins the extremes; the middle values check the
    /// ordinary case and both branches (sqrt price above and below 2^128).
    function test_quoteAtTick_knownValues() public pure {
        address low = address(0x1000);
        address high = address(0x2000);
        uint128 maxBase = type(uint128).max;

        assertEq(OracleQuote.quoteAtTick(-887272, maxBase, low, high), 1, "min tick, token0 base");
        assertEq(
            OracleQuote.quoteAtTick(-887272, maxBase, high, low),
            115783384738768196242144082653949453838306988932806144552194799290216044976282,
            "min tick, token1 base"
        );
        assertEq(
            OracleQuote.quoteAtTick(887272, maxBase, low, high),
            115783384785599357996676985412062652720342362943929506828539444553934033845703,
            "max tick, token0 base"
        );
        assertEq(OracleQuote.quoteAtTick(887272, maxBase, high, low), 1, "max tick, token1 base");

        assertEq(OracleQuote.quoteAtTick(0, 1e18, low, high), 1e18, "tick 0 is 1:1");
        assertEq(OracleQuote.quoteAtTick(0, 1e18, high, low), 1e18, "tick 0 is 1:1 either way");
        assertEq(OracleQuote.quoteAtTick(69081, 1e16, low, high), 9999993390433544930, "1.0001^69081 ~ 1000");
        assertEq(OracleQuote.quoteAtTick(69081, 1e16, high, low), 10000006609570, "and its inverse");
        assertEq(
            OracleQuote.quoteAtTick(500000, 1e18, low, high),
            5171760815372400971558161893748917540546,
            "above 2^128: the Q128 branch"
        );
        // SPX/WETH's 0.3% pool sat near this tick at the pinned block: 0.01 WETH ~ 49.7 SPX.
        assertEq(OracleQuote.quoteAtTick(-145154, 1e16, low, high), 4970007616, "SPX-sized");
    }

    /// The mean tick rounds toward negative infinity, as Uniswap's OracleLibrary does.
    /// Truncating toward zero would bias every pool whose tick is negative.
    function test_meanTick_roundsTowardNegativeInfinity() public {
        MockOraclePool pool = new MockOraclePool(address(0x1000), address(0x2000));

        pool.setCumulatives(0, 600);
        assertTrue(meanTick(pool) == 1, "600 / 600 = 1");
        pool.setCumulatives(0, 601);
        assertTrue(meanTick(pool) == 1, "601 / 600 floors to 1");
        pool.setCumulatives(0, -600);
        assertTrue(meanTick(pool) == -1, "-600 / 600 = -1 exactly");
        pool.setCumulatives(0, -601);
        assertTrue(meanTick(pool) == -2, "-601 / 600 floors to -2, not -1");
        pool.setCumulatives(1_000_000, 1_000_000 - 87_092_400);
        assertTrue(meanTick(pool) == -145154, "a real-sized window");
    }

    function meanTick(MockOraclePool pool) internal view returns (int24 tick) {
        (tick,) = OracleQuote.consult(address(pool), 600);
    }

    /// The liquidity half of `consult`: `window × 2^128` over the growth of the pool's
    /// seconds-per-liquidity accumulator, which is the harmonic mean of the liquidity in
    /// range across the window.
    function test_meanLiquidity_isTheHarmonicMean() public pure {
        int56[] memory ticks = new int56[](2);
        uint160[] memory perLiquidity = new uint160[](2);
        uint256 l = 1e18;

        // Constant liquidity: the mean is that liquidity, give or take the accumulator's
        // rounding (it floors each addition).
        perLiquidity[1] = uint160((uint256(600) << 128) / l);
        (, uint256 mean) = OracleQuote.means(ticks, perLiquidity, 600);
        assertGe(mean, l, "constant liquidity: at least l");
        assertLt(mean - l, l / 1e12, "and within a part per trillion");

        // Half the window at l, half at 3l: 2 / (1/l + 1/3l) = 1.5 l, not the arithmetic 2 l.
        perLiquidity[1] = uint160((uint256(300) << 128) / l + (uint256(300) << 128) / (3 * l));
        (, mean) = OracleQuote.means(ticks, perLiquidity, 600);
        assertLt(absDiff(mean, (3 * l) / 2), l / 1e12, "1.5 l");

        // One second of the window with nothing in range, which the pool counts as
        // liquidity 1: the mean collapses to about 600, whatever the other 599 seconds held.
        perLiquidity[1] = uint160((uint256(599) << 128) / l + (uint256(1) << 128));
        (, mean) = OracleQuote.means(ticks, perLiquidity, 600);
        assertLt(mean, 601, "one empty second is enough to empty the mean");

        // The accumulator wraps at 2^160, and so must the difference.
        perLiquidity[0] = type(uint160).max - uint160((uint256(300) << 128) / l) + 1;
        perLiquidity[1] = uint160((uint256(300) << 128) / l);
        (, mean) = OracleQuote.means(ticks, perLiquidity, 600);
        assertLt(absDiff(mean, l), l / 1e12, "across the wrap");

        // No growth at all would be infinite liquidity, which no genuine pool reports.
        perLiquidity[0] = 5;
        perLiquidity[1] = 5;
        (, mean) = OracleQuote.means(ticks, perLiquidity, 600);
        assertEq(mean, 0, "answered as none");
    }

    /// Depth is the pool's virtual WETH reserve: L / sqrt(P) when WETH is token0 and
    /// L * sqrt(P) when it is token1, with P in token1 per token0.
    function test_wethDepth_isTheVirtualReserve() public pure {
        uint256 l = 1e18;
        assertEq(OracleQuote.wethDepth(0, l, true), l, "at price 1, the reserve is L either way");
        assertEq(OracleQuote.wethDepth(0, l, false), l, "at price 1, the reserve is L either way");

        // At 1.0001^69081 ~ 1000 token1 per token0, sqrt(P) ~ 31.62.
        uint256 asToken0 = OracleQuote.wethDepth(69081, l, true);
        uint256 asToken1 = OracleQuote.wethDepth(69081, l, false);
        assertLt(absDiff(asToken0, l * 1e6 / 31_622_776), l / 1e6, "WETH as token0: L / 31.62");
        assertLt(absDiff(asToken1, l * 31_622_776 / 1e6), l / 1e3, "WETH as token1: L * 31.62");

        // SPX/WETH 0.3% at the pinned block: WETH is token0, the tick about -144,610 and the
        // liquidity about 4.17e16, which is about 57.6 WETH of depth.
        uint256 spx = OracleQuote.wethDepth(-144_610, 41_721_308_557_234_405, true);
        assertGt(spx, 57 ether, "about 57.6 WETH");
        assertLt(spx, 58 ether, "about 57.6 WETH");
    }

    function absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
