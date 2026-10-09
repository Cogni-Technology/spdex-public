// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, IV2FactoryTest, IV2PairTest, IV3PoolTest, IWETHTest} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {ImpostorPair, MockOraclePool} from "./utils/Mocks.sol";
import {PlainToken, IV3FactoryCreate, IV3PoolLiquidity} from "./Hardening.t.sol";
import {Market, SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";
import {TickMath} from "../../contracts/libraries/TickMath.sol";

/// The factory's market list: what it accepts at deployment, and every refusal.
///
/// The list is the answer to the phase-5a reviews — nobody creating a vault can name
/// a pair, a pool or a token — so it is only worth what these checks are. Each is shown on
/// a real market at the pinned block, or on one built from nothing on Uniswap's own
/// factories, except where the point is an imitation of Uniswap.
contract MarketsTest is ForkTest {
    bytes4 internal constant MARKETS_DISAGREE = bytes4(keccak256("MarketsDisagree(uint256,uint256,uint256)"));

    /// USDC/WETH 0.05%: a genuine, deep, busy pool — for the wrong token.
    address internal constant USDC_WETH_POOL_005 = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    int24 internal constant FULL_LOWER = -887_220;
    int24 internal constant FULL_UPPER = 887_220;

    function expectListingRevert(Market[] memory list, bytes memory reason) internal {
        vm.expectRevert(reason);
        deployFactory(list);
    }

    function refusedAt(bytes4 selector, uint256 index) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector, index);
    }

    // ─── The list itself ─────────────────────────────────────────────────────────

    /// Mainnet's list passes every check at the pinned block, with room to spare; deploying
    /// the factory (and with it the implementation) is a one-time cost.
    function test_theMainnetListIsAccepted() public {
        uint256 g = gasleft();
        SpdexVaultFactory f = deployFactory(spxMarkets());
        console.log("factory deployment gas, implementation and list check included", g - gasleft());
        assertEq(f.marketCount(), 1, "one market");
        assertTrue(f.implementation().code.length > 0, "the implementation deployed with it");
    }

    function test_aListNeedsAMarketAndUniswapsFactories() public {
        expectListingRevert(new Market[](0), abi.encodeWithSelector(SpdexVaultFactory.NoMarkets.selector));

        vm.expectRevert(abi.encodeWithSelector(SpdexVaultFactory.NotAUniswapFactory.selector));
        new SpdexVaultFactory(WETH, stranger, V3_FACTORY, registry, spxMarkets());
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultFactory.NotAUniswapFactory.selector));
        new SpdexVaultFactory(WETH, V2_FACTORY, stranger, registry, spxMarkets());
    }

    function test_aMarketCannotBuyWethOrNothing() public {
        expectListingRevert(
            oneMarket(WETH, SPX_WETH_PAIR, SPX_WETH_POOL), refusedAt(SpdexVaultFactory.InvalidToken.selector, 0)
        );
        expectListingRevert(
            oneMarket(address(0), SPX_WETH_PAIR, SPX_WETH_POOL), refusedAt(SpdexVaultFactory.InvalidToken.selector, 0)
        );
    }

    /// One entry per token: a second index for the same market would be two names for one thing.
    function test_aTokenIsListedOnce() public {
        Market[] memory list = new Market[](2);
        list[0] = spxMarkets()[0];
        list[1] = spxMarkets()[0];
        expectListingRevert(list, refusedAt(SpdexVaultFactory.DuplicateMarket.selector, 1));
    }

    // ─── Authenticity ────────────────────────────────────────────────────────────

    /// A pair is genuine when Uniswap v2's factory lists it for WETH and the token — which
    /// an impostor answering every read exactly as the real pair does is not, and neither is
    /// a genuine pair for another token.
    function test_aPairNotListedByUniswapIsRefused() public {
        bytes memory refused = refusedAt(SpdexVaultFactory.PairNotFromUniswap.selector, 0);
        ImpostorPair impostor = new ImpostorPair(SPX_WETH_PAIR);
        (uint112 r0, uint112 r1,) = impostor.getReserves();
        (uint112 real0, uint112 real1,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        assertTrue(r0 == real0 && r1 == real1, "the impostor reads exactly like the real pair");

        expectListingRevert(oneMarket(SPX, address(impostor), SPX_WETH_POOL), refused);
        expectListingRevert(oneMarket(SPX, USDC_WETH_PAIR, SPX_WETH_POOL), refused);
        expectListingRevert(oneMarket(SPX, stranger, SPX_WETH_POOL), refused);
        expectListingRevert(oneMarket(SPX, address(0), SPX_WETH_POOL), refused);
    }

    /// A pool is genuine when Uniswap v3's factory lists it under WETH, the token and the fee
    /// tier the pool reports. An imitation reporting the genuine pool's tier is not the pool
    /// listed there; one reporting a tier with nothing listed, or another pool's tier, is not
    /// either; and something that cannot say its tier at all is not a pool.
    function test_aPoolNotListedByUniswapIsRefused() public {
        bytes memory refused = refusedAt(SpdexVaultFactory.PoolNotFromUniswap.selector, 0);
        MockOraclePool impostor = new MockOraclePool(SPX, WETH);
        assertEq(impostor.fee(), 3000, "claims the 0.3% tier, like the genuine pool");
        expectListingRevert(oneMarket(SPX, SPX_WETH_PAIR, address(impostor)), refused);

        // A wrong fee tier, both ways: one where Uniswap lists no pool at all, and one where
        // it lists a different pool.
        impostor.setFee(1234);
        expectListingRevert(oneMarket(SPX, SPX_WETH_PAIR, address(impostor)), refused);
        impostor.setFee(10_000);
        expectListingRevert(oneMarket(SPX, SPX_WETH_PAIR, address(impostor)), refused);

        // A genuine pool for another token, an account with no code, and the v2 pair, which
        // has no `fee` to report.
        expectListingRevert(oneMarket(SPX, SPX_WETH_PAIR, USDC_WETH_POOL_005), refused);
        expectListingRevert(oneMarket(SPX, SPX_WETH_PAIR, stranger), refused);
        expectListingRevert(oneMarket(SPX, SPX_WETH_PAIR, SPX_WETH_PAIR), refused);
    }

    // ─── The oracle and the pair agree ───────────────────────────────────────────

    /// A genuine pool whose history does not yet reach back ten minutes cannot answer the
    /// average, and is refused until it can.
    function test_aPoolThatCannotAnswerTenMinutesIsRefusedUntilItCan() public {
        (PlainToken token, address pair, address pool) = builtMarket(0, false);
        expectListingRevert(
            oneMarket(address(token), pair, pool), refusedAt(SpdexVaultFactory.OracleUnavailable.selector, 0)
        );

        vm.warp(block.timestamp + 601);
        vm.roll(block.number + 50);
        deployFactory(oneMarket(address(token), pair, pool));
    }

    /// The pool's ten-minute average must agree with the pair's mid price within
    /// MAX_MARKET_GAP_BPS (2%): 5% apart is refused with both figures, 1.5% is accepted.
    function test_aPoolDisagreeingWithItsPairIsRefused() public {
        assertEq(factory.MAX_MARKET_GAP_BPS(), 200, "2%");
        (PlainToken token, address pair, address pool) = builtMarket(488, true); // 1.0001^488 ≈ 1.050
        vm.expectPartialRevert(MARKETS_DISAGREE);
        deployFactory(oneMarket(address(token), pair, pool));

        (token, pair, pool) = builtMarket(150, true); // 1.0001^150 ≈ 1.015
        deployFactory(oneMarket(address(token), pair, pool));
    }

    // ─── A market built from nothing ─────────────────────────────────────────────

    /// A fresh token with a v2 pair at 10 WETH : 10 tokens (price 1) and a 0.3% v3 pool with
    /// 50 WETH of full-range liquidity and 100 observations, its price set `tick` ticks off
    /// the pair's (towards more token per WETH, whichever way round the pool holds them).
    /// `quiet` leaves it untouched for ten minutes afterwards, so it can answer the average.
    function builtMarket(int24 tick, bool quiet) internal returns (PlainToken token, address pair, address pool) {
        token = new PlainToken();
        token.mint(address(this), 1e30);
        vm.deal(address(this), 1_000 ether);
        IWETHTest(WETH).deposit{value: 1_000 ether}();

        pair = IV2FactoryTest(V2_FACTORY).createPair(address(token), WETH);
        IERC20Test(WETH).transfer(pair, 10 ether);
        token.transfer(pair, 10 ether);
        IV2PairTest(pair).mint(address(this));

        pool = IV3FactoryCreate(V3_FACTORY).createPool(address(token), WETH, 3000);
        // A pool's price is token1 per token0: more token per WETH is a higher tick when
        // WETH is token0 and a lower one when it is token1.
        int24 signed = WETH < address(token) ? tick : -tick;
        IV3PoolTest(pool).initialize(TickMath.getSqrtRatioAtTick(signed));
        IV3PoolLiquidity(pool).increaseObservationCardinalityNext(100);

        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);
        IV3PoolLiquidity(pool).mint(address(this), FULL_LOWER, FULL_UPPER, 50 ether, "");
        if (quiet) {
            vm.warp(block.timestamp + 601);
            vm.roll(block.number + 50);
        }
    }

    /// Pays for a mint on any pool this test created, from this contract's balances.
    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        if (owed0 > 0) IERC20Test(IV3PoolLiquidity(msg.sender).token0()).transfer(msg.sender, owed0);
        if (owed1 > 0) IERC20Test(IV3PoolLiquidity(msg.sender).token1()).transfer(msg.sender, owed1);
    }
}
