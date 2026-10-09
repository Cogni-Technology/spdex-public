// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {
    ForkTest,
    IERC20Test,
    IV2FactoryTest,
    IV2PairTest,
    IV3PoolTest,
    IWETHTest,
    IV2RouterTest,
    Plan
} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {MockOraclePool} from "./utils/Mocks.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";
import {TickMath} from "../../contracts/libraries/TickMath.sol";

// Review 1 (economics, oracle and keepers): the findings that stay true whatever the
// fixes are, kept as regression tests. Each pins a property the keeper, the app or the
// threat model must be written against:
//
//   1. A vault whose token is its maker's own code can lie to a keeper's simulation, and a
//      reverted buy leaves its window open. When the review was written, the factory would
//      create such a vault for anyone; since phase 5b its fixed market list means it cannot,
//      so only a vault made by hand can — one the factory does not vouch for. The keeper
//      (`src/keeper.ts`) triggers only vaults the factory vouches for, and still bounds its
//      own gas, simulates with the fees it will pay, and never again triggers a vault whose
//      buy burned at least half its gas limit on chain.
//   2. The SPX/WETH 0.3% pool is thin next to the v2 pair, so one block held over a
//      boundary moves the ten-minute floor, and a push of the pool's price now refuses a
//      buy inside one block, for the pool's fee alone; the contract header's cost figures
//      come from here, and are asserted here, so a change that moved them fails.
//   3. At the pinned depth, sandwiching even the largest buy the cap allows loses money.
//
// The fee-on-transfer finding this review also made is fixed rather than pinned: see
// `test_aFeeOnTransferTokenIsRefusedEvenInsideTheFloor` in Hardening.t.sol.

/// Cheatcodes this review needs beyond the shared harness.
interface VmReview {
    function txGasPrice(uint256 newGasPrice) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
}

/// A token whose transfer out of its v2 pair behaves one way inside a simulation and
/// another inside a real transaction. `eth_call` and `eth_estimateGas` sent without fee
/// fields run with `tx.gasprice == 0` (reth and anvil both, checked against the archive
/// endpoint and the local fork); a mined transaction never does.
///
/// Simulated: burns `burn` gas, then pays out normally, so the call succeeds and the
/// estimate comes back large. Mined: burns every unit of gas it is given, so the pair's
/// payout fails, `execute` reverts, and nothing in the vault changes.
contract GasTrapToken {
    mapping(address => uint256) public balanceOf;
    address public pair;
    uint256 public burn;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address pair_, uint256 burn_) external {
        pair = pair_;
        burn = burn_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (msg.sender == pair && pair != address(0)) {
            if (tx.gasprice != 0) {
                // A mined transaction: spend everything, fail out of gas.
                while (true) {}
            }
            uint256 stop = gasleft() - burn;
            while (gasleft() > stop) {}
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract Review1Test is ForkTest {
    VmReview internal constant vmr = VmReview(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// `a` within `toleranceBps` of `b`: for a figure the docs quote as "about".
    function assertNear(uint256 a, uint256 b, uint256 toleranceBps, string memory message) internal pure {
        uint256 gap = a > b ? a - b : b - a;
        assertTrue(gap * 10_000 <= b * toleranceBps, message);
    }

    // ─── 1. A vault with a hostile token can drain a keeper that trusts simulation ─

    /// The keeper as the review found it discovered every vault the factory created, never
    /// asked whether its pair, pool or token were genuine, simulated `execute` with no fee
    /// fields, took `eth_estimateGas` + 20% as its gas limit, and sent when limit × fee ≤
    /// reward. A vault owner who picks their own token can make that simulation lie: cheap
    /// and successful in simulation, every unit of gas burnt and reverted when mined. The
    /// window is not used, so the next pass does it again.
    ///
    /// Now the factory refuses to list such a market — here because its oracle is not a
    /// pool Uniswap's factory lists; a genuine pool for the trap token would have to hold
    /// ten WETH of depth and a long history, and would still only get it onto the list of a
    /// factory of the attacker's own, at another address — so the trap can only be a vault
    /// made by hand, which the factory does not vouch for and a keeper does not trigger.
    function test_aHostileVaultPassesSimulationThenBurnsTheKeepersGas() public {
        GasTrapToken token = new GasTrapToken();
        token.mint(address(this), 100 ether);
        address pair = IV2FactoryTest(V2_FACTORY).createPair(address(token), WETH);
        vm.deal(address(this), 100 ether);
        IWETHTest(WETH).deposit{value: 100 ether}();
        IERC20Test(WETH).transfer(pair, 100 ether);
        token.transfer(pair, 100 ether);
        IV2PairTest(pair).mint(address(this));
        MockOraclePool oracle = new MockOraclePool(address(token), WETH);
        oracle.setTick(0, 600);

        vm.expectRevert(abi.encodeWithSelector(SpdexVaultFactory.PoolNotFromUniswap.selector, 0));
        deployFactory(oneMarket(address(token), pair, address(oracle)));

        // The largest reward the factory allows: one buy of 0.45 ETH, 0.69% reward. (A vault
        // made by hand could promise more; this one stays inside what a real one can.)
        Plan memory t = defaultPlan();
        t.amountPerBuy = 0.45 ether;
        t.keeperReward = 0.003105 ether;
        t.maxBuys = 1;
        SpdexDcaVault vault = handMadeFunded(address(token), pair, address(oracle), t);
        assertTrue(!factory.isVault(address(vault)), "made by hand: the factory does not vouch for it");
        token.arm(pair, 2_000_000);

        // What the keeper sees before it signs: due, inside the floor, and a call that works.
        (bool due,,,,,,,,) = vault.status();
        (uint256 spotOut, uint256 floorOut,) = vault.quote();
        assertTrue(due && spotOut >= floorOut, "whyNotNow() returns null");

        uint256 snapshot = vmr.snapshotState();
        vmr.txGasPrice(0);
        vm.prank(keeper);
        uint256 g = gasleft();
        (bool simulated,) = address(vault).call{gas: 40_000_000}(abi.encodeCall(SpdexDcaVault.execute, (keeper)));
        uint256 estimate = g - gasleft();
        assertTrue(simulated, "the keeper's eth_call and eth_estimateGas succeed");
        vmr.revertToState(snapshot);

        // The keeper's own arithmetic: limit = estimate + 20%; it sends when limit × fee <= reward.
        uint256 limit = (estimate * 12_000) / 10_000;
        uint256 fee = 1 gwei;
        assertGe(t.keeperReward, limit * fee, "the profitability check passes at 1 gwei");
        assertGe(3 * t.keeperReward, limit * (2 * fee), "and so does the fee ceiling (3 x reward)");

        // Mined: every unit of the limit is spent, and the vault is untouched.
        vmr.txGasPrice(fee);
        vm.prank(keeper);
        g = gasleft();
        (bool mined,) = address(vault).call{gas: limit}(abi.encodeCall(SpdexDcaVault.execute, (keeper)));
        uint256 burnt = g - gasleft();
        assertTrue(!mined, "the real transaction reverts");
        assertGe(burnt, (limit * 95) / 100, "having used (almost) the whole limit");
        assertEq(vault.buysDone(), 0, "no buy counted");
        assertEq(vault.lastBuyAt(), 0, "and the window is still open");
        assertEq(wethOf(keeper), 0, "no reward");
        (due,,,,,,,,) = vault.status();
        assertTrue(due, "so the next keeper pass sees the same due vault and pays again");

        console.log("keeper gas limit per attempt", limit);
        console.log("keeper loss per attempt at 1 gwei (wei)", burnt * fee);
        console.log("reward that justified it (wei)", t.keeperReward);
    }

    // ─── 2. The 10-minute floor against the pool it is read from ─────────────────

    /// Push the SPX/WETH 0.3% pool's tick up by `ticks` at the end of one block, hold it
    /// over the boundary (12 s), and swap back first thing in the next: what a searcher
    /// that controls two consecutive block positions can do. Returns the round trip's
    /// cost in wei of WETH at the v2 mid price, and leaves the TWAP carrying 12 s of the
    /// pushed tick.
    function pushOracleUpForOneBlock(int24 ticks)
        internal
        returns (uint256 costWei, uint256 wethMoved, uint256 oneWayWei)
    {
        address attacker = address(this);
        (uint160 start, int24 tick0,,,,,) = IV3PoolTest(SPX_WETH_POOL).slot0();
        giveSpx(attacker, 50_000_000 * 1e8);
        vm.deal(attacker, 10_000 ether);
        IWETHTest(WETH).deposit{value: 10_000 ether}();
        uint256 spx0 = spxOf(attacker);
        uint256 weth0 = wethOf(attacker);

        // SPX in, WETH out: the price in SPX per WETH rises (WETH is token0).
        IV3PoolTest(SPX_WETH_POOL)
            .swap(attacker, false, int256(40_000_000 * 1e8), TickMath.getSqrtRatioAtTick(tick0 + ticks), "");
        wethMoved = wethOf(attacker) - weth0;
        {
            // What the push alone costs, if an arbitrageur rather than the attacker takes
            // the other side in the next block: SPX paid at market, less WETH received.
            (uint112 rw, uint112 rs,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
            uint256 spxInAsWeth = ((spx0 - spxOf(attacker)) * rw) / rs;
            oneWayWei = spxInAsWeth - wethMoved;
            console.log("  one-way cost if arbitraged (wei of WETH)", oneWayWei);
        }

        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);
        // WETH back in, to the starting price.
        IV3PoolTest(SPX_WETH_POOL).swap(attacker, true, int256(10_000 ether), start, "");

        // Both legs pay the pool's fee, so both balances end below where they began.
        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        int256 spxDelta = int256(spxOf(attacker)) - int256(spx0);
        int256 wethDelta = int256(wethOf(attacker)) - int256(weth0);
        int256 net = wethDelta + (spxDelta * int256(uint256(reserveWeth))) / int256(uint256(reserveSpx));
        costWei = net < 0 ? uint256(-net) : 0;
    }

    function test_oneBlockOnTheOraclePoolRefusesEveryBuyForTenMinutes() public {
        Plan memory t = defaultPlan(); // 3% floor, 0.01 ETH a buy
        t.interval = 300;
        t.communityWindow = defaultWindow(300);
        SpdexDcaVault vault = createFunded(t);
        (uint256 spot0, uint256 floor0,) = vault.quote();
        console.log("before: spot / floor (bps)", (spot0 * 10_000) / floor0);

        uint256 start = block.timestamp;
        (uint256 cost, uint256 wethMoved, uint256 oneWay) = pushOracleUpForOneBlock(16_000);
        console.log("round-trip cost of the push (wei of WETH)", cost);
        console.log("WETH taken out of the pool at the top", wethMoved);

        (uint256 spot1, uint256 floor1,) = vault.quote();
        console.log("after: floor moved by (bps of the old floor)", (floor1 * 10_000) / floor0);
        assertLt(spot1, floor1, "one 12-second block puts the floor above every honest price");
        // The figures the contract header and THREAT-MODEL quote, held to them: a change
        // that moved them has to change those words too.
        assertNear(floor1 * 10_000 / floor0, 10_325, 20, "the average moves by about 3.25%");
        assertNear(cost, 0.17 ether, 1500, "about 0.17 ETH to a searcher holding both block positions");
        assertNear(oneWay, 18 ether, 1500, "about 18 ETH if an arbitrageur takes the reversal");
        vm.prank(keeper);
        vm.expectPartialRevert(SpdexDcaVault.PriceBelowFloor.selector);
        vault.execute(keeper);

        // Still refused ten minutes on, while the pushed 12 seconds are all still inside the window...
        vm.warp(start + 600);
        (spot1, floor1,) = vault.quote();
        assertLt(spot1, floor1, "refused for the whole window");
        // ...and allowed again once it has.
        vm.warp(start + 600 + 13);
        (spot1, floor1,) = vault.quote();
        assertGe(spot1, floor1, "the average recovers on its own");

        // Two 300-second windows passed with no buy; they are skipped, not made up.
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 1, "one buy where three windows opened");
    }

    /// The markets those figures were measured on, as the header describes them: SPX's
    /// pair holds about 2,500 WETH, its 0.3% pool about 30 WETH and 254,000 SPX.
    function test_theMarketsTheHeaderDescribes() public view {
        (uint112 reserveWeth,,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        assertNear(uint256(reserveWeth), 2_500 ether, 500, "about 2,500 WETH in the pair");
        assertNear(wethOf(SPX_WETH_POOL), 30 ether, 1000, "about 30 WETH in the pool");
        assertNear(spxOf(SPX_WETH_POOL), 254_000 * 1e8, 1000, "and about 254,000 SPX");
    }

    /// The cheapest way to refuse a buy. The floor takes the better, for the owner, of the
    /// ten-minute average and the pool's price now, so pushing the price now the owner's way
    /// — SPX into the thin 0.3% pool, so it quotes more SPX per WETH — raises the floor inside
    /// the same block, with no block boundary to hold. Whoever orders transactions around a
    /// public `execute` can do it and swap straight back: the buy is refused
    /// (`PriceBelowFloor`), no money of the owner's moves, and the push costs the pool's fee
    /// both ways on what it moved — not the 0.17 ETH of holding the average over a boundary.
    /// `pnpm keeper` treats that early refusal as "wait for the next window", so each such
    /// push costs a keeper its window and the owner that buy time. The same window buys once
    /// the push is undone.
    ///
    /// It is also the stricter direction of a gap between pool and pair: a pool quoting more
    /// SPX per WETH than the pair holds back any buy whose allowance is smaller than the gap
    /// less the pair's 0.3% fee. (The looser direction is
    /// `test_r5b_buysContinueWhileThePoolAndPairDisagreeBeyondTheListingGap` in Review5b0.t.sol.)
    function test_pushingThePoolsPriceNowRefusesABuyForItsFeesAlone() public {
        Plan memory t = defaultPlan(); // 3% floor, 0.01 ETH a buy
        SpdexDcaVault vault = createFunded(t);
        (uint256 spot0, uint256 floor0,) = vault.quote();
        assertGe(spot0, floor0, "an honest buy goes through before the push");

        (uint160 start, int24 tick0,,,,,) = IV3PoolTest(SPX_WETH_POOL).slot0();
        giveSpx(address(this), 50_000_000 * 1e8);
        vm.deal(address(this), 1_000 ether);
        IWETHTest(WETH).deposit{value: 1_000 ether}();
        int24 ticks = smallestRefusingPush(vault, tick0);
        console.log("ticks the pool's price now must move to refuse a 3% buy", uint256(int256(ticks)));

        uint256 spx0 = spxOf(address(this));
        uint256 weth0 = wethOf(address(this));
        pushPoolNow(tick0 + ticks);
        uint256 wethMoved = wethOf(address(this)) - weth0;
        {
            (uint256 spot1, uint256 floor1,) = vault.quote();
            assertLt(spot1, floor1, "the floor is above the pair's price, inside one block");
        }
        vm.prank(keeper);
        vm.expectPartialRevert(SpdexDcaVault.PriceBelowFloor.selector);
        vault.execute(keeper);

        // Straight back, in the same block: WETH in, to the starting price.
        IV3PoolTest(SPX_WETH_POOL).swap(address(this), true, int256(1_000 ether), start, "");
        uint256 cost = costAtPairMid(spx0, weth0);
        console.log("WETH moved out of the pool by the push (wei)", wethMoved);
        console.log("round-trip cost of refusing one buy (wei of WETH)", cost);

        // The header's figures, held to them: about 275 ticks, 0.75 WETH through the pool and
        // 0.0045 ETH for the round trip, a fortieth of the 0.17 ETH of holding the average.
        assertNear(uint256(int256(ticks)), 275, 1000, "a push of about 275 ticks (2.8%)");
        assertNear(wethMoved, 0.75 ether, 1500, "about 0.75 WETH through the pool");
        assertNear(cost, 0.0045 ether, 2000, "for about 0.0045 ETH: the pool's fee both ways");
        assertLt(cost * 20, 0.17 ether, "far below the 0.17 ETH of holding the average over a boundary");
        assertEq(vault.buysDone(), 0, "nothing bought, nothing of the owner's moved");
        (bool due,,,,,,,,) = vault.status();
        assertTrue(due, "and the window is still open");
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 1, "once the push is undone, the same window buys");
    }

    /// The fewest ticks the pool's price now must move up from `tick0` for `vault`'s floor to
    /// sit above what the pair pays: a search over snapshots, leaving the state as it was.
    function smallestRefusingPush(SpdexDcaVault vault, int24 tick0) internal returns (int24 hi) {
        int24 lo = 0;
        hi = 4_000;
        for (uint256 i; i < 13; i++) {
            int24 mid = (lo + hi) / 2;
            uint256 s = vmr.snapshotState();
            pushPoolNow(tick0 + mid);
            (uint256 spot, uint256 floorOut,) = vault.quote();
            vmr.revertToState(s);
            if (spot < floorOut) hi = mid;
            else lo = mid;
        }
    }

    /// What this contract lost since holding `spx0` SPX and `weth0` WETH, valued in WETH at
    /// the pair's mid price; zero if it gained.
    function costAtPairMid(uint256 spx0, uint256 weth0) internal view returns (uint256) {
        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        int256 spxDelta = int256(spxOf(address(this))) - int256(spx0);
        int256 wethDelta = int256(wethOf(address(this))) - int256(weth0);
        int256 net = wethDelta + (spxDelta * int256(uint256(reserveWeth))) / int256(uint256(reserveSpx));
        return net < 0 ? uint256(-net) : 0;
    }

    /// SPX into the 0.3% pool until its tick reaches `target`: its price now, in SPX per WETH, up.
    function pushPoolNow(int24 target) internal {
        IV3PoolTest(SPX_WETH_POOL)
            .swap(address(this), false, int256(40_000_000 * 1e8), TickMath.getSqrtRatioAtTick(target), "");
    }

    // ─── 3. What sandwiching a real SPX buy earns ────────────────────────────────

    /// A keeper that front-runs its own trigger on v2, pushing the price as far as the
    /// floor allows, and sells back straight after. At the pinned block's depth (about
    /// 2,500 WETH in the pair) the round trip's 0.6% in fees costs far more than the
    /// largest buy the cap allows can give up.
    function test_sandwichingTheLargestAllowedSpxBuyLosesMoney() public {
        Plan memory t = defaultPlan();
        t.amountPerBuy = 0.45 ether;
        t.keeperReward = 0.003105 ether;
        t.maxBuys = 1;
        t.maxSlippageBps = 500;
        SpdexDcaVault vault = createFunded(t);
        (uint256 honestOut, uint256 floorOut,) = vault.quote();

        // Find the largest front-run that keeps the buy inside the floor.
        uint256 lo = 0;
        uint256 hi = 200 ether;
        for (uint256 i; i < 40; i++) {
            uint256 mid = (lo + hi) / 2;
            uint256 s = vmr.snapshotState();
            pushV2(mid);
            (uint256 spot,,) = vault.quote();
            vmr.revertToState(s);
            if (spot >= floorOut) lo = mid;
            else hi = mid;
        }

        // A keeper that holds SPX, paid the reward: the sandwicher's best case. Inside a
        // community window only an eligible one can be paid; one that is not can still make
        // the buy by naming the owner as `rewardTo`, and does the same sandwich without the
        // reward, so it loses more.
        address sandwicher = fresh("sandwicher");
        makeEligible(sandwicher);
        // Whatever SPX it holds to be eligible is its own, not the sandwich's: only what the
        // front-run bought is sold back.
        uint256 spxHeld = spxOf(sandwicher);
        vm.deal(sandwicher, lo);
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = SPX;
        vm.prank(sandwicher);
        IV2RouterTest(V2_ROUTER).swapExactETHForTokens{value: lo}(0, path, sandwicher, block.timestamp);

        vm.prank(sandwicher);
        (uint256 received,) = vault.execute(sandwicher);

        // Sell every SPX the front-run bought back through the pair directly.
        {
            uint256 spx = spxOf(sandwicher) - spxHeld;
            (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
            uint256 inWithFee = spx * 997;
            uint256 wethOut = (inWithFee * reserveWeth) / (uint256(reserveSpx) * 1000 + inWithFee);
            vm.prank(sandwicher);
            IERC20Test(SPX).transfer(SPX_WETH_PAIR, spx);
            vm.prank(sandwicher);
            IV2PairTestSwap(SPX_WETH_PAIR).swap(wethOut, 0, sandwicher, "");
        }

        uint256 back = wethOf(sandwicher); // the reward, plus the sale
        uint256 ownerLossBps = ((honestOut - received) * 10_000) / honestOut;
        console.log("front-run size (wei)", lo);
        console.log("owner's loss vs an honest buy (bps)", ownerLossBps);
        console.log("sandwicher put in (wei)", lo);
        console.log("sandwicher got back incl. reward (wei)", back);
        assertLt(back, lo, "the sandwich loses money even with the reward");
        assertGe(ownerLossBps, 300, "while still costing the owner most of the 5% allowance");
        // The header's figure, held to it.
        assertNear(lo - back, 0.29 ether, 1500, "the sandwicher ends about 0.29 ETH down, reward included");
    }
}

interface IV2PairTestSwap {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
