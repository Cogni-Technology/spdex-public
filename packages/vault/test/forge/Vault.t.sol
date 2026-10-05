// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, IV2PairTest, IV3PoolTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {VmLog, console} from "./utils/Test.sol";
import {OwnerContract} from "./utils/Mocks.sol";
import {SpdexDcaVault, Terms} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";
import {TickMath} from "../../contracts/libraries/TickMath.sol";
import {OracleQuote} from "../../contracts/libraries/OracleQuote.sol";

/// `Bought`'s data: everything but the indexed slot, keeper and rewardTo.
struct BoughtData {
    uint256 amountIn;
    uint256 amountOut;
    uint256 reward;
    uint256 floorOut;
    uint256 buyNumber;
    uint256 oracleDepth;
    uint256 dueSince;
}

/// The vault — a clone the factory created — against real SPX/WETH markets at the pinned
/// block. Which markets a vault may use is `Markets.t.sol`'s subject; the clone mechanics
/// are `Clones.t.sol`'s.
contract VaultTest is ForkTest {
    // ─── Creation ────────────────────────────────────────────────────────────────

    function expectCreateRevert(Plan memory t, bytes memory reason) internal {
        vm.prank(owner);
        vm.expectRevert(reason);
        factory.createVault(
            t.marketIndex,
            t.amountPerBuy,
            t.interval,
            t.maxBuys,
            t.startAt,
            t.keeperReward,
            t.maxSlippageBps,
            t.communityWindow,
            t.turnBuckets
        );
    }

    function err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function windowOutOfRange(uint256 window, uint256 maximum) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SpdexVaultFactory.CommunityWindowOutOfRange.selector, window, 60, maximum);
    }

    function test_createAcceptsSoundTerms() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = create(t);
        Terms memory stored = vault.terms();
        assertEq(
            abi.encode(stored), abi.encode(termsOf(t)), "terms read back exactly as created, SPX's market included"
        );
        assertEq(stored.tokenOut, SPX, "buys SPX");
        assertEq(stored.pair, SPX_WETH_PAIR, "on its v2 pair");
        assertEq(stored.oraclePool, SPX_WETH_POOL, "floored by its 0.3% pool");
        assertEq(vault.owner(), owner, "the creator owns it");
        assertEq(address(vault.weth()), WETH, "pays with the factory's WETH");
        assertEq(vault.buysDone(), 0, "no buys yet");
        assertTrue(!vault.closed(), "open");
    }

    /// The plan's own terms. The market is not a term: a plan names an entry in the factory's
    /// list, and what the factory refuses to list is `Markets.t.sol`'s subject.
    function test_createValidatesEveryTerm() public {
        Plan memory t;

        // The market: an index into a list of one.
        t = defaultPlan();
        t.marketIndex = 1;
        expectCreateRevert(t, abi.encodeWithSelector(SpdexVaultFactory.UnknownMarket.selector, 1, 1));
        t.marketIndex = type(uint256).max;
        expectCreateRevert(t, abi.encodeWithSelector(SpdexVaultFactory.UnknownMarket.selector, type(uint256).max, 1));

        // Amounts.
        t = defaultPlan();
        t.amountPerBuy = 0;
        expectCreateRevert(t, err(SpdexVaultFactory.AmountOutOfRange.selector));
        t.amountPerBuy = 0.5 ether + 1;
        t.keeperReward = 0;
        t.maxBuys = 1;
        expectCreateRevert(t, err(SpdexVaultFactory.AmountOutOfRange.selector));

        // Interval.
        t = defaultPlan();
        t.interval = 299;
        expectCreateRevert(t, err(SpdexVaultFactory.IntervalOutOfRange.selector));
        t.interval = 366 days + 1;
        expectCreateRevert(t, err(SpdexVaultFactory.IntervalOutOfRange.selector));

        // Number of buys.
        t = defaultPlan();
        t.maxBuys = 0;
        expectCreateRevert(t, err(SpdexVaultFactory.BuysOutOfRange.selector));
        t.maxBuys = 1_001;
        expectCreateRevert(t, err(SpdexVaultFactory.BuysOutOfRange.selector));

        // Slippage: zero can never buy (the pair's fee alone exceeds it), and 5% is the most.
        t = defaultPlan();
        t.maxSlippageBps = 0;
        expectCreateRevert(t, err(SpdexVaultFactory.SlippageOutOfRange.selector));
        t.maxSlippageBps = 501;
        expectCreateRevert(t, err(SpdexVaultFactory.SlippageOutOfRange.selector));

        // The keeper's reward: at most 0.69% of a buy, and 10%, the old limit, is far past it.
        t = defaultPlan();
        t.keeperReward = (t.amountPerBuy * 69) / 10_000 + 1;
        expectCreateRevert(t, err(SpdexVaultFactory.RewardTooLarge.selector));
        t.keeperReward = t.amountPerBuy / 10;
        expectCreateRevert(t, err(SpdexVaultFactory.RewardTooLarge.selector));
        t.keeperReward = t.amountPerBuy + 1;
        expectCreateRevert(t, err(SpdexVaultFactory.RewardTooLarge.selector));

        // The hard cap: maxBuys x (amountPerBuy + keeperReward) <= 0.5 ETH. The rewards count:
        // fifty buys of 0.01 fit exactly, and do not once each carries its reward.
        t = defaultPlan();
        t.keeperReward = 0.000069 ether;
        t.maxBuys = 50; // 50 x 0.010069 = 0.50345
        expectCreateRevert(
            t, abi.encodeWithSelector(SpdexVaultFactory.FundingCapExceeded.selector, 0.50345 ether, 0.5 ether)
        );
        t.keeperReward = 0;
        t.maxBuys = 51; // 51 x 0.01 = 0.51
        expectCreateRevert(
            t, abi.encodeWithSelector(SpdexVaultFactory.FundingCapExceeded.selector, 0.51 ether, 0.5 ether)
        );

        // The start: within a year either side of now.
        t = defaultPlan();
        t.startAt = block.timestamp + 366 days + 1;
        expectCreateRevert(t, err(SpdexVaultFactory.StartOutOfRange.selector));
        t.startAt = block.timestamp - 366 days - 1;
        expectCreateRevert(t, err(SpdexVaultFactory.StartOutOfRange.selector));

        // The community window: none is not allowed, nor under a minute, nor over a quarter
        // of the interval (15 minutes here). Its every edge is `Window.t.sol`'s.
        // The refusal names the window and both bounds.
        t = defaultPlan();
        t.communityWindow = 0;
        expectCreateRevert(t, windowOutOfRange(0, 900));
        t.communityWindow = 59;
        expectCreateRevert(t, windowOutOfRange(59, 900));
        t.communityWindow = t.interval / 4 + 1;
        expectCreateRevert(t, windowOutOfRange(901, 900));
    }

    function test_createAcceptsEveryBoundary() public {
        Plan memory t = defaultPlan();
        t.keeperReward = (t.amountPerBuy * 69) / 10_000; // exactly 0.69%
        t.maxBuys = 49; // 49 x 0.010069 = 0.493381
        t.interval = 300;
        t.communityWindow = 75; // a quarter of the shortest interval
        t.maxSlippageBps = 500;
        t.startAt = block.timestamp + 366 days;
        create(t);

        t = defaultPlan();
        t.keeperReward = 0;
        t.maxBuys = 50; // exactly 0.5 ETH
        t.interval = 366 days;
        t.communityWindow = 1 hours; // the longest window
        t.startAt = block.timestamp - 366 days;
        create(t);

        t = defaultPlan();
        t.communityWindow = 60; // the shortest window
        create(t);

        t = defaultPlan();
        t.amountPerBuy = 0.0005 ether;
        t.keeperReward = 0;
        t.maxBuys = 1_000; // the most buys, exactly at the cap
        create(t);
    }

    // ─── Funding ─────────────────────────────────────────────────────────────────

    function test_fundIsOwnerOnlyAndCapped() public {
        Plan memory t = defaultPlan();
        uint256 budget = budgetOf(t);
        SpdexDcaVault vault = create(t);

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(err(SpdexDcaVault.Unauthorized.selector));
        vault.fund{value: 0.01 ether}();

        vm.prank(owner);
        vm.expectRevert(err(SpdexDcaVault.NothingToFund.selector));
        vault.fund{value: 0}();

        // Part now; then more than the rest, of which only the rest is kept and the
        // excess goes straight back; then not one wei more.
        vm.prank(owner);
        vault.fund{value: budget / 2}();
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.fund{value: budget}();
        assertEq(before - owner.balance, budget - budget / 2, "only what the plan still needed was kept");
        assertEq(wethOf(address(vault)), budget, "held as WETH");
        assertEq(address(vault).balance, 0, "no loose ether");

        vm.prank(owner);
        vm.expectRevert(err(SpdexDcaVault.FullyFunded.selector));
        vault.fund{value: 1}();

        // After a buy the need falls by exactly what the buy spent, so there is still no room.
        vm.prank(keeper);
        vault.execute(keeper);
        vm.prank(owner);
        vm.expectRevert(err(SpdexDcaVault.FullyFunded.selector));
        vault.fund{value: 1}();
    }

    function test_plainEtherIsRefused() public {
        SpdexDcaVault vault = create(defaultPlan());
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok, bytes memory reason) = address(vault).call{value: 1 ether}("");
        assertTrue(!ok, "a plain transfer bounces");
        assertEq(reason, err(SpdexDcaVault.OnlyWeth.selector), "with the reason");
    }

    // ─── Buying ──────────────────────────────────────────────────────────────────

    function test_firstBuyAtStartDeliversAtLeastTheFloorAndPaysTheKeeper() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        (uint256 spotOut, uint256 floorOut,) = vault.quote();
        assertGt(floorOut, 0, "the oracle priced it");
        assertGe(spotOut, floorOut, "an ordinary market is inside a 3% floor");

        uint256 spxBefore = spxOf(owner);
        vm.recordLogs();
        vm.prank(keeper);
        (uint256 received, uint256 reward) = vault.execute(keeper);

        assertEq(spxOf(owner) - spxBefore, received, "the owner received what execute reports");
        assertEq(received, spotOut, "exactly what quote() predicted");
        assertGe(received, floorOut, "at least the floor");
        assertEq(reward, t.keeperReward, "execute reports the reward");
        assertEq(wethOf(keeper), t.keeperReward, "the keeper was paid, in WETH");
        assertEq(wethOf(address(vault)), budgetOf(t) - t.amountPerBuy - t.keeperReward, "one buy spent");
        assertEq(spxOf(address(vault)), 0, "the vault never holds what it buys");
        assertEq(vault.buysDone(), 1, "one buy");
        assertEq(vault.lastBuyAt(), block.timestamp, "made now");
        assertEq(vault.totalOut(), received, "running total");
        assertEq(vault.totalRewards(), t.keeperReward, "rewards derived from buys");
        assertEq(bought(vm.getRecordedLogs(), address(vault)), 1, "one Bought event");
    }

    function test_theBoughtEventCarriesTheBuy() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        // Three buys, a window apart: each announces its number, and the floor and depth it
        // was judged against, which are what `quote()` said just before it.
        for (uint256 n = 1; n <= 3; n++) {
            vm.warp(t.startAt + (n - 1) * t.interval);
            (, uint256 floorOut, uint256 depth) = vault.quote();
            vm.recordLogs();
            // The keeper sends it; the first pays the keeper, the second a holder it names,
            // the third the owner: the caller and the paid are two fields.
            address paid = n == 1 ? keeper : n == 2 ? stranger : owner;
            if (n == 2) makeEligible(stranger);
            vm.prank(keeper);
            (uint256 received,) = vault.execute(paid);
            VmLog[] memory logs = vm.getRecordedLogs();
            uint256 found;
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].emitter != address(vault) || logs[i].topics[0] != BOUGHT_TOPIC) continue;
                found++;
                assertEq(uint256(logs[i].topics[1]), n - 1, "slot");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), keeper, "keeper");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), paid, "rewardTo");
                BoughtData memory b = abi.decode(logs[i].data, (BoughtData));
                assertEq(b.amountIn, t.amountPerBuy, "amount in");
                assertEq(b.amountOut, received, "amount out");
                assertEq(b.reward, t.keeperReward, "reward");
                assertEq(b.floorOut, floorOut, "the floor quote() gave");
                assertGe(b.amountOut, b.floorOut, "at least the floor");
                assertEq(b.buyNumber, n, "numbered from 1");
                assertEq(b.oracleDepth, depth, "the depth quote() gave");
                assertGe(b.oracleDepth, 10 ether, "deep enough to buy");
                assertEq(b.dueSince, t.startAt + (n - 1) * t.interval, "due from its slot's start");
            }
            assertEq(found, 1, "one Bought event");
        }
        assertEq(vault.buysDone(), 3, "three buys");
    }

    function test_aSecondCallInTheSameWindowReverts() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        vm.prank(keeper);
        vault.execute(keeper);

        bytes memory tooSoon = abi.encodeWithSelector(SpdexDcaVault.TooSoon.selector, t.startAt + t.interval);
        vm.prank(keeper);
        vm.expectRevert(tooSoon);
        vault.execute(keeper);

        // Still the same window one second before it ends.
        vm.warp(t.startAt + t.interval - 1);
        vm.prank(stranger);
        vm.expectRevert(tooSoon);
        vault.execute(stranger);
    }

    function test_afterOneIntervalTheNextBuyWorks() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        vm.prank(keeper);
        vault.execute(keeper);

        vm.warp(t.startAt + t.interval);
        (bool due, uint256 nextBuyAt,,,,,,,) = vault.status();
        assertTrue(due, "due at the start of the next window");
        assertEq(nextBuyAt, t.startAt + t.interval, "and says so");
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 2, "two buys");
        assertEq(vault.lastBuyAt(), t.startAt + t.interval, "the second at window 1's start");
    }

    function test_missedWindowsAreSkippedNotMadeUp() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        vm.prank(keeper);
        vault.execute(keeper);

        // Three intervals pass with nobody triggering: windows 1 and 2 are gone.
        vm.warp(t.startAt + 3 * t.interval + 10);
        vm.prank(keeper);
        vault.execute(keeper);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.TooSoon.selector, t.startAt + 4 * t.interval));
        vault.execute(keeper);

        assertEq(vault.buysDone(), 2, "one buy for the three windows, not three");
        assertEq(vault.lastBuyAt(), t.startAt + 3 * t.interval + 10, "the buy was in window 3");
        (,, uint256 buysLeft,,,,,,) = vault.status();
        assertEq(buysLeft, t.maxBuys - 2, "the skipped windows did not use up buys");
    }

    function test_maxBuysEndsIt() public {
        Plan memory t = defaultPlan();
        t.maxBuys = 2;
        SpdexDcaVault vault = createFunded(t);
        vm.prank(keeper);
        vault.execute(keeper);
        vm.warp(t.startAt + t.interval);
        vm.prank(keeper);
        vault.execute(keeper);

        vm.warp(t.startAt + 2 * t.interval);
        vm.prank(keeper);
        vm.expectRevert(err(SpdexDcaVault.NoBuysLeft.selector));
        vault.execute(keeper);

        (bool due, uint256 nextBuyAt, uint256 buysLeft, uint256 wethBalance,,,,,) = vault.status();
        assertTrue(!due, "nothing is due");
        assertEq(nextBuyAt, 0, "and nothing ever will be");
        assertEq(buysLeft, 0, "no buys left");
        assertEq(wethBalance, 0, "a fully funded plan spends exactly its budget");
    }

    function test_notBeforeStartAt() public {
        Plan memory t = defaultPlan();
        t.startAt = block.timestamp + 1 hours;
        SpdexDcaVault vault = createFunded(t);
        (bool due, uint256 nextBuyAt,,,,,,,) = vault.status();
        assertTrue(!due, "not due before the start");
        assertEq(nextBuyAt, t.startAt, "due at the start");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.NotStarted.selector, t.startAt));
        vault.execute(keeper);
    }

    function test_insufficientBalanceReverts() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = create(t);
        uint256 needed = t.amountPerBuy + t.keeperReward;

        (bool due,,,, bool funded,,,,) = vault.status();
        assertTrue(!due && !funded, "an empty vault is neither funded nor due");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.InsufficientBalance.selector, 0, needed));
        vault.execute(keeper);

        vm.prank(owner);
        vault.fund{value: needed - 1}();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.InsufficientBalance.selector, needed - 1, needed));
        vault.execute(keeper);

        vm.prank(owner);
        vault.fund{value: 1}();
        (due,,,, funded,,,,) = vault.status();
        assertTrue(due && funded, "one buy's worth is enough");
        vm.prank(keeper);
        vault.execute(keeper);
    }

    // ─── The price floor ─────────────────────────────────────────────────────────

    /// A large buy in the same block moves the pair's spot price but not the 10-minute
    /// average, so the vault refuses; once the average has caught up with the new price
    /// (the v3 pool trades there for a whole window), it buys again.
    function test_aSpotPricePushedFromTheAverageIsRefusedUntilTheAverageCatchesUp() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);

        pushV2(300 ether); // about a tenth of the pair's WETH: SPX costs ~25% more
        (bool due,,,,,,,,) = vault.status();
        assertTrue(due, "status() says nothing about price");
        (uint256 spotOut, uint256 floorOut,) = vault.quote();
        assertLt(spotOut, floorOut, "the spot price is now well outside the 3% floor");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.PriceBelowFloor.selector, spotOut, floorOut));
        vault.execute(keeper);
        assertEq(vault.buysDone(), 0, "nothing bought");
        assertEq(wethOf(keeper), 0, "nothing paid");

        // The v3 pool moves to the same price, and stays there for a full window.
        moveV3ToV2Price();
        vm.warp(block.timestamp + 601);
        (spotOut, floorOut,) = vault.quote();
        assertGe(spotOut, floorOut, "the average has caught up");
        vm.prank(keeper);
        (uint256 received,) = vault.execute(keeper);
        assertGe(received, floorOut, "and the buy goes through at the new price");
    }

    function test_quoteAndStatusAgreeWithExecute() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);

        // Due and priced: execute delivers exactly the quoted spot amount.
        (bool due,,,,,,,,) = vault.status();
        (uint256 spotOut, uint256 floorOut,) = vault.quote();
        assertTrue(due && spotOut >= floorOut, "due and inside the floor");
        vm.prank(keeper);
        (uint256 delivered,) = vault.execute(keeper);
        assertEq(delivered, spotOut, "delivered == quoted");

        // Not due: execute refuses.
        (due,,,,,,,,) = vault.status();
        assertTrue(!due, "not due again in the same window");
        vm.prank(keeper);
        vm.expectPartialRevert(SpdexDcaVault.TooSoon.selector);
        vault.execute(keeper);

        // Due, but priced outside the floor: execute refuses with the quoted figures.
        vm.warp(t.startAt + t.interval);
        pushV2(300 ether);
        (due,,,,,,,,) = vault.status();
        (spotOut, floorOut,) = vault.quote();
        assertTrue(due && spotOut < floorOut, "due, but outside the floor");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.PriceBelowFloor.selector, spotOut, floorOut));
        vault.execute(keeper);
    }

    /// The vendored TickMath and the oracle arithmetic against the live pool: the pool's
    /// own square-root price lies between its tick's and the next one's, the 10-minute
    /// quote agrees with the v2 pair's price to within a percent, and the depth the vault
    /// requires is there with room to spare.
    function test_theOracleArithmeticAgreesWithTheLiveMarkets() public view {
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IV3PoolTest(SPX_WETH_POOL).slot0();
        assertTrue(TickMath.getSqrtRatioAtTick(tick) <= sqrtPriceX96, "at or above the tick's price");
        assertTrue(sqrtPriceX96 < TickMath.getSqrtRatioAtTick(tick + 1), "below the next tick's");

        (int24 mean, uint256 liquidity) = OracleQuote.consult(SPX_WETH_POOL, 600);
        uint256 depth = OracleQuote.wethDepth(mean, liquidity, true);
        console.log("SPX/WETH 0.3% pool depth over ten minutes (wei of WETH)", depth);
        assertGt(depth, 50 ether, "about 60 WETH of depth");
        assertLt(depth, 70 ether, "and not a misread order of magnitude");
        uint256 fair = OracleQuote.quoteAtTick(mean, 1 ether, WETH, SPX);
        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        uint256 v2Mid = (uint256(reserveSpx) * 1 ether) / reserveWeth;
        uint256 gap = fair > v2Mid ? fair - v2Mid : v2Mid - fair;
        assertLt(gap * 100, v2Mid, "v3's average and v2's mid agree within 1%");
        console.log("SPX per WETH, v3 10-minute average (raw)", fair);
        console.log("SPX per WETH, v2 mid (raw)", v2Mid);
    }

    // ─── Closing and rescue ──────────────────────────────────────────────────────

    function test_closeReturnsEverythingAsEtherThenNothingElseWorks() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        vm.prank(keeper);
        vault.execute(keeper);

        vm.prank(stranger);
        vm.expectRevert(err(SpdexDcaVault.Unauthorized.selector));
        vault.close();

        uint256 held = wethOf(address(vault));
        uint256 ethBefore = owner.balance;
        vm.prank(owner);
        vault.close();
        assertEq(owner.balance - ethBefore, held, "everything back, as ether");
        assertEq(wethOf(address(vault)), 0, "no WETH left");
        assertEq(address(vault).balance, 0, "no ether left");
        assertTrue(vault.closed(), "closed");

        vm.warp(t.startAt + t.interval);
        vm.prank(keeper);
        vm.expectRevert(err(SpdexDcaVault.VaultClosed.selector));
        vault.execute(keeper);
        vm.prank(owner);
        vm.expectRevert(err(SpdexDcaVault.VaultClosed.selector));
        vault.fund{value: 0.01 ether}();
        (bool due,, uint256 buysLeft,,,,,,) = vault.status();
        assertTrue(!due && buysLeft == 0, "a closed vault has nothing due");

        // Closing again is harmless, and sweeps anything that arrived since.
        vm.prank(owner);
        vault.close();
    }

    function test_closeFallsBackToWethForAnOwnerThatRefusesEther() public {
        OwnerContract ownerContract = new OwnerContract();
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = ownerContract.create(factory, createCall(t));
        vm.deal(address(this), 1 ether);
        ownerContract.fund{value: budgetOf(t)}();
        ownerContract.setMode(OwnerContract.Mode.Refuse);

        ownerContract.close();
        assertEq(wethOf(address(ownerContract)), budgetOf(t), "paid in WETH instead, never stranded");
        assertEq(wethOf(address(vault)) + address(vault).balance, 0, "the vault is empty");
    }

    /// WETH sends a withdrawal with `transfer`'s 2,300-gas stipend, which a clone's `receive`
    /// fits in today. Should a fork reprice it past that, `withdraw` reverts — here, every
    /// `withdraw` WETH is asked for does — and `close` still stops the plan and returns the
    /// whole budget, as WETH, with `Closed` saying how much. Were the failed unwrap fatal, no
    /// owner could ever stop a plan again.
    function test_closeReturnsTheBudgetAsWethWhenUnwrappingFails() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        uint256 held = wethOf(address(vault));
        uint256 ethBefore = owner.balance;

        vm.mockCallRevert(WETH, abi.encodeWithSelector(bytes4(keccak256("withdraw(uint256)"))), "");
        vm.recordLogs();
        vm.prank(owner);
        vault.close();
        VmLog[] memory logs = vm.getRecordedLogs();
        vm.clearMockedCalls();

        assertTrue(vault.closed(), "closed");
        assertEq(wethOf(owner), held, "the whole budget back, as WETH");
        assertEq(owner.balance, ethBefore, "and no ether");
        assertEq(wethOf(address(vault)) + address(vault).balance, 0, "the vault is empty");
        uint256 closedEvents;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == keccak256("Closed(uint256)")) {
                assertEq(abi.decode(logs[i].data, (uint256)), held, "Closed reports what went back");
                closedEvents++;
            }
        }
        assertEq(closedEvents, 1, "one Closed");
    }

    function test_rescueReturnsStrayTokensAndWethOnlyOnceClosed() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        vm.prank(keeper);
        (uint256 received,) = vault.execute(keeper);

        // The owner sends the SPX they bought back to the vault by mistake.
        vm.prank(owner);
        IERC20Test(SPX).transfer(address(vault), received);

        vm.prank(stranger);
        vm.expectRevert(err(SpdexDcaVault.Unauthorized.selector));
        vault.rescue(SPX);

        vm.prank(owner);
        vault.rescue(SPX);
        assertEq(spxOf(address(vault)), 0, "the vault holds no SPX");
        assertEq(spxOf(owner), received, "the owner has it back");

        vm.prank(owner);
        vm.expectRevert(err(SpdexDcaVault.WethLockedUntilClosed.selector));
        vault.rescue(WETH);

        vm.prank(owner);
        vault.close();
        // WETH sent after closing comes back through rescue (or a second close).
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        IWETHTest(WETH).deposit{value: 1 ether}();
        IERC20Test(WETH).transfer(address(vault), 1 ether);
        vm.stopPrank();
        uint256 before = wethOf(owner);
        vm.prank(owner);
        vault.rescue(WETH);
        assertEq(wethOf(owner) - before, 1 ether, "rescued");
    }

    // ─── Gas ─────────────────────────────────────────────────────────────────────

    /// A buy's gas is what whoever triggers it pays, and creation's cost is what the clones
    /// are for, so both are measured, printed (`-vv`) and bounded here. These are in-test figures:
    /// one test is one transaction, so a slot an earlier step touched is warm for a later
    /// one, and none includes the 21,000 base or calldata. The integration test measures
    /// real transactions on the local fork.
    ///
    /// Before the clones (phase 5a, a full contract per vault), the same steps measured:
    /// createVault 2,278,083; fund 46,425; execute 200,290 (first) and 57,948 (later);
    /// close 19,905. v1 as deployed: createVault 175,650 (185,146 funding one buy); fund
    /// 48,303; execute 218,501 (first) and 61,215 (later); close 21,972. v2's buys here are
    /// both inside their community window, paid to an eligible keeper, so each asks the
    /// registry.
    /// The gas `createVault` spends for the owner, sending `value` along; as a direct call, so
    /// the figure is the factory's alone.
    function measureCreate(Plan memory t, uint256 value) internal returns (uint256 used, address made) {
        vm.prank(owner);
        uint256 g = gasleft();
        made = factory.createVault{value: value}(
            t.marketIndex,
            t.amountPerBuy,
            t.interval,
            t.maxBuys,
            t.startAt,
            t.keeperReward,
            t.maxSlippageBps,
            t.communityWindow,
            t.turnBuckets
        );
        used = g - gasleft();
    }

    function test_gas() public {
        Plan memory t = defaultPlan();

        (uint256 createGas, address made) = measureCreate(t, 0);
        SpdexDcaVault vault = SpdexDcaVault(payable(made));

        // The same plan again, created and funded with its first buy in one call.
        (uint256 createFundedGas,) = measureCreate(t, t.amountPerBuy + t.keeperReward);

        uint256 g;
        vm.prank(owner);
        g = gasleft();
        vault.fund{value: budgetOf(t)}();
        uint256 fundGas = g - gasleft();

        vm.prank(keeper);
        g = gasleft();
        vault.execute(keeper);
        uint256 firstExecuteGas = g - gasleft();

        vm.warp(t.startAt + t.interval);
        vm.prank(keeper);
        g = gasleft();
        vault.execute(keeper);
        uint256 laterExecuteGas = g - gasleft();

        vm.prank(owner);
        g = gasleft();
        vault.close();
        uint256 closeGas = g - gasleft();

        console.log("createVault gas", createGas);
        console.log("createVault gas, funding one buy", createFundedGas);
        console.log("fund gas", fundGas);
        console.log("execute gas (first buy)", firstExecuteGas);
        console.log("execute gas (later buy)", laterExecuteGas);
        console.log("close gas", closeGas);

        // Loose ceilings: a change that made a buy much dearer should be noticed, since
        // keepers pay it and the buy fee is priced from it; and creation is what the clones
        // exist to make cheap. The factory's vault list and `VaultCreated.funded` added about
        // 27,500 to a creation, which `BatchGas.t.sol` bounds at 31,000: these ceilings rose
        // by that bound, from 150,000 and 200,000. v2's window — a term, four bytes of clone
        // code, and the registry's answer for a buy inside it — fits under the same ceilings.
        assertLt(firstExecuteGas, 250_000, "first execute stays under 250k");
        assertLt(createGas, 181_000, "createVault stays under 181k");
        assertLt(createFundedGas, 231_000, "creating and funding stays under 231k");
    }
}
