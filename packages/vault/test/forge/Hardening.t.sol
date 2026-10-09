// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, IV2FactoryTest, IV2PairTest, IV3PoolTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {FeeOnTransferToken, MockOraclePool} from "./utils/Mocks.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";

// Regressions for the phase-5a reviews (security; economics, oracle and keepers). Each test
// here failed against the vault as first written and passes against the fix; the header of
// `contracts/SpdexDcaVault.sol` says what each fix buys and what it does not.
//
// Since phase 5b a vault's market comes from the factory's fixed list, so the refusals that
// were a vault's at its creation are the factory's at its own deployment: a factory whose
// list names such a market cannot be deployed. The market tests below build that list.
//
//   - An oracle pool nobody provides liquidity to, or too little, is refused — when the list
//     is checked, and at every buy, because liquidity can leave after the list is fixed.
//   - An oracle pool whose history one trade can rewrite is refused when the list is checked.
//   - The floor follows the pool's price now when that is better for the owner than the
//     ten-minute average, so a market that has just fallen back is not bought at the
//     stale average less the allowance.
//   - A wei of donated WETH cannot make the owner's exact funding revert.
//   - A vault can be created and funded in one transaction.
//   - A fee-on-transfer token is refused even when the fee fits inside the floor.
//   - Two buys are always at least half an interval apart.

/// Cheatcodes these tests need beyond the shared harness.
interface VmHardening {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    function store(address target, bytes32 slot, bytes32 value) external;
}

/// `quote()`'s first two answers. Declared here rather than taken from the vault so that
/// these tests compile against the vault before the fix too, whose `quote()` returned only
/// these two.
interface IQuoteTwo {
    function quote() external view returns (uint256 spotOut, uint256 floorOut);
}

interface IV3PoolLiquidity {
    function increaseObservationCardinalityNext(uint16 next) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV3FactoryCreate {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IV2PairSwap {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// An ordinary ERC-20 with a public mint: the token of a market these tests build from
/// nothing, on Uniswap's own factories, so that its depth and history are theirs to set.
contract PlainToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract HardeningTest is ForkTest {
    VmHardening internal constant vmh = VmHardening(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// SPX's other two v3 pools at the pinned block. The 0.05% pool is empty (no liquidity
    /// in range) and keeps one observation; the 1% pool holds dust and keeps 51.
    address internal constant SPX_WETH_POOL_005 = 0xE60FbA68Aa34040a1da64Cc661d06920853C16CF;
    address internal constant SPX_WETH_POOL_100 = 0x00Ed26e794b949E18B142F9108429b74CE08aC99;

    /// Full range for the 0.3% tier, whose ticks are spaced 60 apart.
    int24 internal constant FULL_LOWER = -887_220;
    int24 internal constant FULL_UPPER = 887_220;

    /// The factory's refusals name the list entry: (index, figure, minimum).
    bytes4 internal constant ORACLE_HISTORY_TOO_SHORT =
        bytes4(keccak256("OracleHistoryTooShort(uint256,uint256,uint256)"));
    bytes4 internal constant LISTED_ORACLE_TOO_THIN = bytes4(keccak256("OracleTooThin(uint256,uint256,uint256)"));
    /// The vault's own, at a buy: (depth, minimum).
    bytes4 internal constant ORACLE_TOO_THIN = bytes4(keccak256("OracleTooThin(uint256,uint256)"));
    bytes4 internal constant TOO_SOON = bytes4(keccak256("TooSoon(uint256)"));
    bytes4 internal constant DELIVERED_SHORT = bytes4(keccak256("DeliveredShort(uint256,uint256)"));
    bytes4 internal constant FUNDING_EXCEEDS_NEED = bytes4(keccak256("FundingExceedsNeed(uint256)"));

    // ─── A market built from nothing ─────────────────────────────────────────────

    /// A fresh token with a v2 pair (10 WETH : 10 tokens, so tick 0) and a 0.3% v3 pool at
    /// the same price, holding `liquidity` across the full range and keeping up to
    /// `observations` observations, then left quiet for ten minutes so that it can answer
    /// a ten-minute average. Every contract is Uniswap's own: nothing here is a mock.
    function syntheticMarket(uint128 liquidity, uint16 observations)
        internal
        returns (PlainToken token, address pair, address pool)
    {
        token = new PlainToken();
        token.mint(address(this), 1e30);
        vm.deal(address(this), 1_000 ether);
        IWETHTest(WETH).deposit{value: 1_000 ether}();

        pair = IV2FactoryTest(V2_FACTORY).createPair(address(token), WETH);
        IERC20Test(WETH).transfer(pair, 10 ether);
        token.transfer(pair, 10 ether);
        IV2PairTest(pair).mint(address(this));

        pool = IV3FactoryCreate(V3_FACTORY).createPool(address(token), WETH, 3000);
        IV3PoolTest(pool).initialize(1 << 96);
        if (observations > 1) IV3PoolLiquidity(pool).increaseObservationCardinalityNext(observations);

        // A later block, so the mint writes an observation (and the pool adopts the larger
        // history it was asked to keep).
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);
        if (liquidity > 0) IV3PoolLiquidity(pool).mint(address(this), FULL_LOWER, FULL_UPPER, liquidity, "");

        vm.warp(block.timestamp + 601);
        vm.roll(block.number + 50);
    }

    /// Pays for a mint on any pool this test created, from this contract's balances.
    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        if (owed0 > 0) IERC20Test(IV3PoolLiquidity(msg.sender).token0()).transfer(msg.sender, owed0);
        if (owed1 > 0) IERC20Test(IV3PoolLiquidity(msg.sender).token1()).transfer(msg.sender, owed1);
    }

    /// A factory whose list is this one market, or the revert its deployment met.
    function listing(PlainToken token, address pair, address pool) internal returns (SpdexVaultFactory) {
        return deployFactory(oneMarket(address(token), pair, pool));
    }

    function expectListingRevert(address token, address pair, address pool, bytes memory reason) internal {
        vm.expectRevert(reason);
        deployFactory(oneMarket(token, pair, pool));
    }

    // ─── The oracle pool must be one someone is providing to ─────────────────────

    /// SPX's 0.05% and 1% pools are genuine Uniswap pools with the right tokens, and both
    /// answered `observe([600, 0])` at the pinned block, which was the whole check. The
    /// 0.05% pool is empty — anyone can move it anywhere for nothing, and its price was
    /// already 35% off — and the 1% pool held dust. Neither can be listed: both are refused
    /// for their history before their depth is even read.
    function test_spxsEmptyAndDustPoolsCannotBeListed() public {
        expectListingRevert(
            SPX, SPX_WETH_PAIR, SPX_WETH_POOL_005, abi.encodeWithSelector(ORACLE_HISTORY_TOO_SHORT, 0, 1, 100)
        );
        expectListingRevert(
            SPX, SPX_WETH_PAIR, SPX_WETH_POOL_100, abi.encodeWithSelector(ORACLE_HISTORY_TOO_SHORT, 0, 51, 100)
        );
    }

    /// A genuine pool with a long enough history but 1 WETH of depth: the review's thin
    /// market, where a keeper could move the average with pocket money and sandwich the
    /// buy 55% below the honest price. It cannot be listed, and the refusal says what depth
    /// was measured.
    function test_aThinPoolCannotBeListed() public {
        (PlainToken token, address pair, address pool) = syntheticMarket(1 ether, 100);
        vm.expectPartialRevert(LISTED_ORACLE_TOO_THIN);
        listing(token, pair, pool);

        // The same market with 50 WETH of depth behind the price is listed, and a vault on it
        // can be created.
        (token, pair, pool) = syntheticMarket(50 ether, 100);
        createOn(listing(token, pair, pool), defaultPlan());
    }

    /// Liquidity can leave after a market is listed, and the list is fixed. Once it has, the
    /// harmonic mean over the window falls within seconds — a second in a range nobody
    /// provides to counts as liquidity 1 — and every buy is refused, including after someone
    /// moves the now-empty pool wherever they like for free.
    function test_aBuyIsRefusedOnceTheOraclePoolsLiquidityLeaves() public {
        (PlainToken token, address pair, address pool) = syntheticMarket(50 ether, 100);
        SpdexDcaVault vault = createFundedOn(listing(token, pair, pool), defaultPlan());

        IV3PoolLiquidity(pool).burn(FULL_LOWER, FULL_UPPER, 50 ether);
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);

        vm.prank(keeper);
        vm.expectPartialRevert(ORACLE_TOO_THIN);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 0, "nothing bought against an empty pool");

        // A month on it is still refused, and the owner's way out is `close`.
        vm.warp(block.timestamp + 30 days);
        vm.prank(keeper);
        vm.expectPartialRevert(ORACLE_TOO_THIN);
        vault.execute(keeper);
    }

    // ─── The oracle pool must keep a history one trade cannot rewrite ────────────

    /// A pool keeping a single observation, quiet for ten minutes, answers a ten-minute
    /// average. Then any write — a trade that moves its tick, or a dust mint in range —
    /// replaces its only observation, and it answers "OLD" for the next ten minutes: one
    /// cheap transaction every ten minutes kept such a vault from ever buying. It cannot be
    /// listed.
    function test_aPoolKeepingOneObservationCannotBeListed() public {
        (PlainToken token, address pair, address pool) = syntheticMarket(50 ether, 1);
        expectListingRevert(address(token), pair, pool, abi.encodeWithSelector(ORACLE_HISTORY_TOO_SHORT, 0, 1, 100));
    }

    /// With a hundred observations kept, the same dust mint writes one more and the
    /// ten-minute average still answers from the ones before it.
    function test_aDustMintDoesNotJamAPoolWithHistory() public {
        (PlainToken token, address pair, address pool) = syntheticMarket(50 ether, 100);
        SpdexDcaVault vault = createFundedOn(listing(token, pair, pool), defaultPlan());
        IV3PoolLiquidity(pool).mint(address(this), -60, 60, 1_000, "");
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 1, "bought");
    }

    // ─── The floor follows a market that has just fallen back ────────────────────

    /// SPX gets about 25% dearer on both venues and stays there for a whole window, then
    /// falls back on both. Twelve seconds later the ten-minute average still says "dear",
    /// so a floor read from it alone sat 22% below what the market now gives, on a 3% plan
    /// — and a sandwich could take all of that. The floor now comes from the better of the
    /// average and the pool's price now.
    function test_theFloorFollowsTheMarketBackDown() public {
        Plan memory t = defaultPlan(); // 3% floor
        SpdexDcaVault vault = createFunded(t);
        (uint112 wethBefore,,) = IV2PairTest(SPX_WETH_PAIR).getReserves();

        pushV2(300 ether);
        moveV3ToV2Price();
        vm.warp(block.timestamp + 601);
        vm.roll(block.number + 50);

        sellSpxOnV2Until(wethBefore);
        moveV3ToV2Price();
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);

        (uint256 honestOut, uint256 floorOut) = IQuoteTwo(address(vault)).quote();
        console.log("floor as bps of what the market gives now", (floorOut * 10_000) / honestOut);
        assertGe(floorOut * 10_000, honestOut * 9_650, "the floor is 3% (and the pair's fee) below the market now");

        // The sandwich the stale floor allowed: push the pair up to just inside the floor,
        // let the buy land. It now costs the owner no more than the plan allows.
        uint256 frontRun = largestPushInsideTheFloor(vault, floorOut);
        pushV2(frontRun);
        vm.prank(keeper);
        (uint256 received,) = vault.execute(keeper);
        console.log("sandwiched buy as bps of the honest one", (received * 10_000) / honestOut);
        assertGe(received * 10_000, honestOut * 9_650, "a sandwich costs the owner at most the plan's 3%");
    }

    /// Sell SPX into the v2 pair until it holds `wethTarget` WETH again.
    function sellSpxOnV2Until(uint256 wethTarget) internal {
        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        uint256 wethOut = reserveWeth - wethTarget;
        uint256 spxIn = (uint256(reserveSpx) * wethOut * 1000) / ((reserveWeth - wethOut) * 997) + 1;
        address seller = fresh("seller");
        vmh.store(SPX, keccak256(abi.encode(seller, uint256(1))), bytes32(spxIn));
        vm.prank(seller);
        IERC20Test(SPX).transfer(SPX_WETH_PAIR, spxIn);
        vm.prank(seller);
        IV2PairSwap(SPX_WETH_PAIR).swap(wethOut, 0, seller, "");
    }

    function largestPushInsideTheFloor(SpdexDcaVault vault, uint256 floorOut) internal returns (uint256 lo) {
        uint256 hi = 200 ether;
        for (uint256 i; i < 40; i++) {
            uint256 mid = (lo + hi) / 2;
            uint256 snapshot = vmh.snapshotState();
            pushV2(mid);
            (uint256 spot,) = IQuoteTwo(address(vault)).quote();
            vmh.revertToState(snapshot);
            if (spot >= floorOut) lo = mid;
            else hi = mid;
        }
    }

    // ─── Funding ─────────────────────────────────────────────────────────────────

    /// Anyone could send the vault one wei of WETH ahead of the owner's funding, and the
    /// owner's exact `fund{value: budget}` then reverted for being a wei over the room —
    /// every time, for about 50k gas a go. Now the vault keeps what fits and returns the
    /// rest to the owner in the same call.
    function test_aDonatedWeiDoesNotBlockExactFunding() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = create(t);
        uint256 budget = budgetOf(t);

        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        IWETHTest(WETH).deposit{value: 1}();
        IERC20Test(WETH).transfer(address(vault), 1);
        vm.stopPrank();

        uint256 before = owner.balance;
        vm.prank(owner);
        vault.fund{value: budget}();
        assertEq(wethOf(address(vault)), budget, "funded to exactly the budget");
        assertEq(before - owner.balance, budget - 1, "the wei the donation covered came back");
        assertEq(address(vault).balance, 0, "no loose ether left behind");
    }

    /// Creating and funding were two transactions, and two confirmations. The factory now
    /// forwards ether to the new vault, which wraps it; more than the plan's budget is
    /// refused, since at creation nothing can have changed what the plan needs.
    function test_createAndFundInOneTransaction() public {
        Plan memory t = defaultPlan();
        uint256 budget = budgetOf(t);

        vm.prank(owner);
        (bool ok, bytes memory reason) = address(factory).call{value: budget + 1}(createCall(t));
        assertTrue(!ok, "a wei over the budget is refused");
        assertEq(reason, abi.encodeWithSelector(FUNDING_EXCEEDS_NEED, budget), "with the budget");

        vm.prank(owner);
        (ok, reason) = address(factory).call{value: budget}(createCall(t));
        assertTrue(ok, "created and funded at once");
        SpdexDcaVault vault = SpdexDcaVault(payable(abi.decode(reason, (address))));
        assertEq(wethOf(address(vault)), budget, "the budget, held as WETH");
        (bool due,,,, bool funded,,,,) = vault.status();
        assertTrue(due && funded, "and due straight away");
    }

    // ─── Delivery ────────────────────────────────────────────────────────────────

    /// A 1% transfer fee inside a 3% floor used to buy quietly, the owner receiving 1% less
    /// than the pair sent. The vault now requires every unit the pair sent to arrive.
    ///
    /// Such a token can no longer reach a vault the factory vouches for — its market is not
    /// on the list, and this one's mock oracle could not be — so the vault here is made by
    /// hand. The refusal is the vault's own, whoever made the clone.
    function test_aFeeOnTransferTokenIsRefusedEvenInsideTheFloor() public {
        FeeOnTransferToken token = new FeeOnTransferToken();
        token.mint(address(this), 101_010_101_010_101_010_102);
        address pair = IV2FactoryTest(V2_FACTORY).createPair(address(token), WETH);
        vm.deal(address(this), 100 ether);
        IWETHTest(WETH).deposit{value: 100 ether}();
        IERC20Test(WETH).transfer(pair, 100 ether);
        IERC20Test(address(token)).transfer(pair, 101_010_101_010_101_010_102);
        IV2PairTest(pair).mint(address(this));
        MockOraclePool oracle = new MockOraclePool(address(token), WETH);
        oracle.setTick(0, 600);

        expectListingRevert(
            address(token),
            pair,
            address(oracle),
            abi.encodeWithSelector(SpdexVaultFactory.PoolNotFromUniswap.selector, 0)
        );
        SpdexDcaVault vault = handMadeFunded(address(token), pair, address(oracle), defaultPlan());
        (uint256 spotOut, uint256 floorOut) = IQuoteTwo(address(vault)).quote();
        assertGe(spotOut - spotOut / 100, floorOut, "what arrives after the fee is still inside the floor");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DELIVERED_SHORT, spotOut - spotOut / 100, spotOut));
        vault.execute(keeper);
    }

    // ─── Spacing ─────────────────────────────────────────────────────────────────

    /// Windows are fixed buckets, so a buy in the last second of one window and another in
    /// the first second of the next were both allowed: one push of the price could cover
    /// two buys. A buy now also waits half an interval after the last one.
    function test_twoBuysAreAtLeastHalfAnIntervalApart() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        vm.warp(t.startAt + t.interval - 1);
        vm.prank(keeper);
        vault.execute(keeper);

        uint256 spaced = t.startAt + t.interval - 1 + t.interval / 2;
        vm.warp(t.startAt + t.interval);
        (bool due, uint256 nextBuyAt,,,,,,,) = vault.status();
        assertTrue(!due, "a new window, but too soon after the last buy");
        assertEq(nextBuyAt, spaced, "due half an interval after it");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TOO_SOON, spaced));
        vault.execute(keeper);

        vm.warp(spaced);
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 2, "the second buy, still in window 1");
    }
}
