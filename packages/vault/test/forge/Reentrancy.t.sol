// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, IV2FactoryTest, IV2PairTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {DoubleKeeper, FeeOnTransferToken, MockOraclePool, OwnerContract, ReenteringToken} from "./utils/Mocks.sol";
import {SpdexDcaVault, Terms} from "../../contracts/SpdexDcaVault.sol";

/// Hostile parties that get control mid-transaction: a token, an owner contract, and a
/// keeper contract. Each attempt must be refused while the honest action around it
/// completes.
///
/// A hostile token cannot reach a vault mainnet's factory vouches for any more: its market
/// would have to be on that factory's list, which names SPX alone — chosen by hand, because
/// the listing checks vet markets, not tokens (`Review5b0.t.sol`). The lock is still what
/// stops one if it did, so the
/// token tests run on vaults made by hand — clones of the same implementation, outside the
/// factory — whose oracle is a mock pool at tick 0 and whose v2 pair is a real Uniswap v2
/// pair, created on the fork, holding them 1:1 against WETH. The owner and keeper tests
/// run on factory vaults.
contract ReentrancyTest is ForkTest {
    /// A real v2 pair for `token` against WETH, 10:10, and a mock oracle agreeing with it.
    function market(address token, uint256 tokenSent) internal returns (address pair, address oracle) {
        pair = IV2FactoryTest(V2_FACTORY).createPair(token, WETH);
        vm.deal(address(this), 10 ether);
        IWETHTest(WETH).deposit{value: 10 ether}();
        IERC20Test(WETH).transfer(pair, 10 ether);
        IERC20Test(token).transfer(pair, tokenSent);
        IV2PairTest(pair).mint(address(this));
        MockOraclePool pool = new MockOraclePool(token, WETH);
        pool.setTick(0, 600);
        oracle = address(pool);
    }

    function planWith(uint256 slippageBps) internal view returns (Plan memory t) {
        t = defaultPlan();
        t.maxSlippageBps = slippageBps;
    }

    function test_aTokenCannotReenterDuringTheBuy() public {
        ReenteringToken token = new ReenteringToken();
        token.mint(address(this), 10 ether);
        (address pair, address oracle) = market(address(token), 10 ether);
        SpdexDcaVault vault = handMadeFunded(address(token), pair, oracle, planWith(100));
        token.arm(vault);

        vm.prank(keeper);
        (uint256 received,) = vault.execute(keeper);

        assertEq(token.attempts(), 1, "the token tried, from inside the pair's payout");
        assertEq(token.lastRevert(), abi.encodeWithSelector(SpdexDcaVault.Reentrancy.selector), "and was refused");
        assertEq(vault.buysDone(), 1, "one buy, not two");
        assertEq(token.balanceOf(owner), received, "the honest buy completed");
        assertEq(wethOf(keeper), vault.terms().keeperReward, "one reward, not two");
    }

    function test_aFeeOnTransferTokenFailsLoudly() public {
        FeeOnTransferToken token = new FeeOnTransferToken();
        // Sent so that the pair receives exactly 10 after the token's 1% cut.
        uint256 sent = 10_101_010_101_010_101_010;
        token.mint(address(this), sent);
        (address pair, address oracle) = market(address(token), sent);
        SpdexDcaVault vault = handMadeFunded(address(token), pair, oracle, planWith(50));

        (uint256 spotOut, uint256 floorOut,) = vault.quote();
        assertGe(spotOut, floorOut, "the pair's price is inside the floor");
        uint256 delivered = spotOut - spotOut / 100;

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.DeliveredShort.selector, delivered, spotOut));
        vault.execute(keeper);
    }

    function test_anOwnerContractCannotReenterWhileBeingPaid() public {
        OwnerContract ownerContract = new OwnerContract();
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = ownerContract.create(factory, createCall(t));
        vm.deal(address(this), 1 ether);
        ownerContract.fund{value: budgetOf(t)}();
        ownerContract.setMode(OwnerContract.Mode.Reenter);

        uint256 before = address(ownerContract).balance;
        ownerContract.close();

        bytes memory refused = abi.encodeWithSelector(SpdexDcaVault.Reentrancy.selector);
        assertEq(ownerContract.executeRevert(), refused, "execute refused mid-close");
        assertEq(ownerContract.fundRevert(), refused, "fund refused mid-close");
        assertEq(ownerContract.closeRevert(), refused, "close refused mid-close");
        assertEq(address(ownerContract).balance - before, budgetOf(t), "and the close still paid out in full");
        assertEq(vault.buysDone(), 0, "no buy slipped in");
    }

    function test_aKeeperContractCannotBuyTwiceInOneTransaction() public {
        SpdexDcaVault vault = createFunded(defaultPlan());
        DoubleKeeper doubleKeeper = new DoubleKeeper();
        address rewardTo = fresh("double-keeper-reward-to");
        makeEligible(rewardTo);
        doubleKeeper.run(vault, rewardTo);

        Terms memory t = vault.terms();
        assertEq(
            doubleKeeper.secondRevert(),
            abi.encodeWithSelector(SpdexDcaVault.TooSoon.selector, t.startAt + t.interval),
            "the second call in the same window is refused"
        );
        assertEq(vault.buysDone(), 1, "one buy");
        assertEq(wethOf(rewardTo), t.keeperReward, "one reward");
    }
}
