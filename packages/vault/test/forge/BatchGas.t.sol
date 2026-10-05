// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IV3PoolTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultBatcher} from "../../contracts/SpdexVaultBatcher.sol";

// What a batch of buys costs, pinned against the figures `src/fee.ts` prices the buy fee
// from — `BATCH_PER_BUY_GAS`, `BATCH_FIXED_GAS` and `BATCH_FIRST_BUY_EXTRA_GAS`, mirrored
// below as literals, as `Gas.t.sol` mirrors `EXECUTE_GAS` — and what the richer `Bought`
// and `VaultCreated` and the factory's vault list added to a buy and a creation.
//
// A figure here is a transaction's receipt gas, not a call's: the 21,000 base and the
// calldata, then the call as the callee spent it (forge's `lastCallGas`), less the refunds a
// transaction gets back (at most a fifth of it). Refunds matter here: each swap's lock on
// the pair gives back 2,800. (v1's batcher also had its WETH balance written from zero and
// emptied in the same transaction, which gave back 19,900; v2's never holds WETH.)
// Everything a transaction starts cold with is cooled first, and what the measured
// transaction reads was written by earlier ones, in `setUp`, so no slot is found already
// dirty. Measured this way, the contracts at e31a86e gave 187,209 for a funded creation, the
// same figure a real transaction on the fork gave in the research this fee comes from.
//
// v2's buys here are made inside their community window and paid to an eligible
// `rewardTo`, so each asks the registry: the dear path, and the one the fee is priced for,
// since it is what community keepers send (a buy after its window skips the question, and
// `test_afterItsWindowABatchAsksTheRegistryNothing` measures that too). The registry is the
// real `SpxHolderRegistry`, cooled with the market, as a transaction would find it: the
// first vault in a batch pays for its account, the holder's record and SPX's balance slot
// cold, and each later vault paying the same `rewardTo` finds them warm.
//
// A figure over its bound is a stop, not an edit: the fee's constants are a release
// decision, and every table of the fee depends on them.

/// Cheatcodes this file needs beyond the shared harness.
struct CallGas {
    uint64 gasLimit;
    uint64 gasTotalUsed;
    uint64 gasMemoryUsed;
    int64 gasRefunded;
    uint64 gasRemaining;
}

interface VmBatchGas {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    /// Marks an account and every storage slot of it cold, as at the start of a transaction.
    function cool(address target) external;
    /// The gas the last call used, from the callee's side, with the refunds it earned.
    function lastCallGas() external view returns (CallGas memory);
}

/// Receipt gas for the last call, measured the way this file's header says.
abstract contract ReceiptGas is ForkTest {
    VmBatchGas internal constant vmg = VmBatchGas(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Two trades on SPX's 0.3% pool, a block apart, the second 12 seconds before `at`, and
    /// the clock at `at`: the pool is busy, as it is most hours on mainnet, so `observe`
    /// binary-searches its history (`Gas.t.sol` says why that is the dear case).
    function busyPoolAt(uint256 at) internal {
        vm.warp(at - 24);
        vm.roll(block.number + 1);
        vm.deal(address(this), 1 ether);
        IWETHTest(WETH).deposit{value: 1 ether}();
        (, int256 spxOut) = IV3PoolTest(SPX_WETH_POOL).swap(address(this), true, int256(1 ether), 4295128740, "");
        vm.warp(at - 12);
        vm.roll(block.number + 1);
        IV3PoolTest(SPX_WETH_POOL)
            .swap(address(this), false, -spxOut, 1461446703485210103287273052203988822378723970341, "");
        vm.warp(at);
        vm.roll(block.number + 1);
    }

    function coolMarket() internal {
        vmg.cool(address(factory));
        vmg.cool(factory.implementation());
        vmg.cool(registry);
        vmg.cool(WETH);
        vmg.cool(SPX);
        vmg.cool(SPX_WETH_PAIR);
        vmg.cool(SPX_WETH_POOL);
        vmg.cool(keeper);
    }

    /// The last call as a transaction with this calldata: base, calldata, execution, refunds.
    function receiptGas(bytes memory data) internal view returns (uint256) {
        CallGas memory g = vmg.lastCallGas();
        uint256 total = 21_000 + calldataCost(data) + g.gasTotalUsed;
        uint256 refund = g.gasRefunded > 0 ? uint256(int256(g.gasRefunded)) : 0;
        if (refund > total / 5) refund = total / 5;
        return total - refund;
    }

    function calldataCost(bytes memory data) internal pure returns (uint256 cost) {
        for (uint256 i; i < data.length; i++) {
            cost += data[i] == 0 ? 4 : 16;
        }
    }
}

/// v1, as deployed, measured 101,255 a later buy, 150,602 fixed (167,702 to a fresh
/// `rewardTo`) and 50,686 for a first buy. v2, with the real registry asked for every buy
/// (once cold, then warm for each later vault paying the same `rewardTo`): 105,969, 151,686
/// (168,786) and 50,686. The fixed part lost the forwarding of the rewards and gained the
/// registry's cold reads; a later buy gained the warm check, `Bought`'s two words and the
/// window's arithmetic. `BATCH_PER_BUY_GAS` rose from 106,000 to keep v1's headroom, which
/// moves `BATCHED_BUY_GAS` from 122,000 to 126,000. After the window, which asks nothing:
/// 102,968 a later buy and 142,680 fixed, so the check costs a batch about 9,000 once and
/// 3,000 a buy. (Before the registry read the holder's code, to pay accounts only, those
/// were 6,500 and 2,800, and the in-window figures 105,761 and 149,186.)
contract BatchGasTest is ReceiptGas {
    /// `BATCH_PER_BUY_GAS` in `src/fee.ts`: a later buy's share of a batch, on a busy pool.
    uint256 internal constant BATCH_PER_BUY_GAS = 110_000;
    /// `BATCH_FIXED_GAS`: what a batch pays once, whatever its size.
    uint256 internal constant BATCH_FIXED_GAS = 160_000;
    /// `BATCH_FIRST_BUY_EXTRA_GAS`: what a plan's first buy costs over a later one.
    uint256 internal constant BATCH_FIRST_BUY_EXTRA_GAS = 51_000;
    /// A `rewardTo` that has never held WETH has its balance written from zero, once.
    uint256 internal constant FRESH_REWARD_TO_EXTRA_GAS = 15_000;
    /// What asking the registry adds to a batch, once, for its first vault: the registry's
    /// account, the holder's record, the holder's own account (its code is read: only an
    /// account may be paid) and SPX's balance slot for the holder, all cold. Measured 9,006.
    uint256 internal constant COLD_CHECK_GAS = 10_000;
    /// What it adds to each later vault paying the same `rewardTo`, all of that warm, and
    /// the community buy counted in a slot the buy writes anyway. Measured 2,793 before the
    /// registry read the holder's code, and 3,001 since (the read itself, 100 warm, and its
    /// branch): the bound moved with that change, from 3,000, and the fee's own constants
    /// above did not need to.
    uint256 internal constant WARM_CHECK_GAS = 3_500;

    SpdexVaultBatcher internal batcher;
    /// Five vaults, each of a different owner, that have each bought once and are due again.
    address[] internal later;
    /// Five more of the same plan, started one window's length earlier, so that when the
    /// first five fall due these have been due for a whole window: open to anyone, at the
    /// same moment and on the same pool.
    address[] internal open;
    /// A vault due for its first buy, whose owner has never held SPX.
    address internal firstTimer;
    /// Holds WETH already: the steady state of a keeper's reward address.
    address internal rewardTo;
    /// Has never held WETH.
    address internal freshRewardTo;
    /// Holds WETH like `rewardTo`, and has never proven: who is paid after the window.
    address internal outsider;
    Plan internal plan;

    function setUp() public override {
        super.setUp();
        batcher = deployBatcher();
        Plan memory p = defaultPlan();
        plan = p;
        for (uint256 i; i < 6; i++) {
            // "gas-owner-1" to "gas-owner-6": owners of their own, as a batch's vaults are.
            address vault = createAs(string(abi.encodePacked("gas-owner-", bytes1(uint8(49 + i)))), p);
            if (i == 5) {
                firstTimer = vault;
                continue;
            }
            vm.prank(keeper);
            SpdexDcaVault(payable(vault)).execute(keeper);
            later.push(vault);
        }
        Plan memory early = defaultPlan();
        early.startAt = p.startAt - p.communityWindow;
        for (uint256 i; i < 5; i++) {
            address vault = createAs(string(abi.encodePacked("gas-owner-open-", bytes1(uint8(49 + i)))), early);
            vm.prank(keeper);
            SpdexDcaVault(payable(vault)).execute(keeper);
            open.push(vault);
        }
        rewardTo = fresh("reward-to");
        vm.deal(rewardTo, 1 ether);
        vm.prank(rewardTo);
        IWETHTest(WETH).deposit{value: 0.01 ether}();
        freshRewardTo = fresh("fresh-reward-to");
        // Community keepers: every buy below is inside its window.
        makeEligible(rewardTo);
        makeEligible(freshRewardTo);
        outsider = fresh("outsider");
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        IWETHTest(WETH).deposit{value: 0.01 ether}();

        busyPoolAt(p.startAt + p.interval);
    }

    function createAs(string memory name, Plan memory p) internal returns (address vault) {
        address who = fresh(name);
        vm.deal(who, 1 ether);
        vm.prank(who);
        vault = factory.createVault{value: budgetOf(p)}(
            p.marketIndex,
            p.amountPerBuy,
            p.interval,
            p.maxBuys,
            p.startAt,
            p.keeperReward,
            p.maxSlippageBps,
            p.communityWindow,
            p.turnBuckets
        );
    }

    /// One batch of `vaults`, paid to `to`, as a transaction's receipt gas; every vault in it
    /// must buy. The state is put back afterwards, so each measurement starts from `setUp`.
    function batchGas(address[] memory vaults, address to) internal returns (uint256 used) {
        uint256 snapshot = vmg.snapshotState();
        bytes memory data = abi.encodeCall(SpdexVaultBatcher.executeBatch, (vaults, to, 0, BATCH_GAS));
        coolMarket();
        vmg.cool(address(batcher));
        vmg.cool(to);
        for (uint256 i; i < vaults.length; i++) {
            vmg.cool(vaults[i]);
            vmg.cool(SpdexDcaVault(payable(vaults[i])).owner());
        }
        vm.prank(keeper);
        (bool ok, bytes memory returned) = address(batcher).call(data);
        assertTrue(ok, "the batch went through");
        used = receiptGas(data);
        (uint256 bought,,) = abi.decode(returned, (uint256, uint256, bytes4[]));
        assertEq(bought, vaults.length, "every vault bought");
        vmg.revertToState(snapshot);
    }

    function laterOnes(uint256 n) internal view returns (address[] memory list) {
        list = firstOf(later, n);
    }

    function firstOf(address[] storage from, uint256 n) internal view returns (address[] memory list) {
        list = new address[](n);
        for (uint256 i; i < n; i++) {
            list[i] = from[i];
        }
    }

    /// The marginal gas of a later buy: five in a batch against one, per extra buy.
    function perLaterBuy() internal returns (uint256) {
        uint256 one = batchGas(laterOnes(1), rewardTo);
        uint256 five = batchGas(laterOnes(5), rewardTo);
        console.log("batch of 1, later buy, busy pool: receipt gas", one);
        console.log("batch of 5, later buys, busy pool: receipt gas", five);
        return (five - one) / 4;
    }

    function test_aLaterBuyInABatchOnABusyPoolFitsBATCH_PER_BUY_GAS() public {
        uint256 perBuy = perLaterBuy();
        console.log("a later buy in a batch, busy pool: marginal gas", perBuy);
        assertLt(perBuy, BATCH_PER_BUY_GAS + 1, "within BATCH_PER_BUY_GAS");
    }

    function test_aBatchsFixedGasFitsBATCH_FIXED_GAS() public {
        uint256 perBuy = perLaterBuy();
        uint256 fixedSteady = batchGas(laterOnes(1), rewardTo) - perBuy;
        uint256 fixedFresh = batchGas(laterOnes(1), freshRewardTo) - perBuy;
        console.log("a batch's fixed gas, rewardTo holding WETH", fixedSteady);
        console.log("a batch's fixed gas, rewardTo holding none", fixedFresh);
        assertLt(fixedSteady, BATCH_FIXED_GAS + 1, "within BATCH_FIXED_GAS");
        assertLt(
            fixedFresh, BATCH_FIXED_GAS + FRESH_REWARD_TO_EXTRA_GAS + 1, "and a fresh rewardTo adds at most 15,000"
        );
    }

    /// After their windows the same batch, paid to an address that never proved, asks the
    /// registry nothing: what the in-window batch above pays over it is the check, once cold
    /// for the first vault (in the fixed part) and warm for each later one. Measured at the
    /// same moment, on the same busy pool, on vaults one window further on, so that only the
    /// check differs.
    function test_afterItsWindowABatchAsksTheRegistryNothing() public {
        uint256 inPerBuy = perLaterBuy();
        uint256 inFixed = batchGas(laterOnes(1), rewardTo) - inPerBuy;
        uint256 outOne = batchGas(firstOf(open, 1), outsider);
        uint256 outPerBuy = (batchGas(firstOf(open, 5), outsider) - outOne) / 4;
        uint256 outFixed = outOne - outPerBuy;
        assertEq(wethOf(outsider), 0.01 ether, "measured from copies: nothing kept");
        // Checked after measuring, so that these reads warm nothing the batches would find.
        (,,,,, uint256 dueSince, uint256 windowEndsAt,,) = SpdexDcaVault(payable(open[0])).status();
        assertEq(windowEndsAt, block.timestamp, "the open vaults' windows ended this second");
        assertEq(dueSince + plan.communityWindow, windowEndsAt, "a whole window after they fell due");
        (,,,,, dueSince,,,) = SpdexDcaVault(payable(later[0])).status();
        assertEq(dueSince, block.timestamp, "the others fell due this second");

        console.log("a later buy in a batch, inside its window: marginal gas", inPerBuy);
        console.log("a later buy in a batch, after its window: marginal gas", outPerBuy);
        console.log("a batch's fixed gas, inside the window", inFixed);
        console.log("a batch's fixed gas, after it", outFixed);
        console.log("the registry check, warm, per later buy", inPerBuy - outPerBuy);
        console.log("the registry check, cold, once a batch", inFixed - outFixed);
        assertLt(outPerBuy, inPerBuy, "a buy after its window is cheaper");
        assertLt(inPerBuy - outPerBuy, WARM_CHECK_GAS + 1, "the warm check costs at most 3,500");
        assertLt(inFixed - outFixed, COLD_CHECK_GAS + 1, "the cold check costs at most 10,000");
        assertLt(outPerBuy + outFixed / 10, BATCH_PER_BUY_GAS + BATCH_FIXED_GAS / 10, "within BATCHED_BUY_GAS");
    }

    function test_aFirstBuyInABatchAddsAtMostBATCH_FIRST_BUY_EXTRA_GAS() public {
        address[] memory withFirst = new address[](2);
        withFirst[0] = later[0];
        withFirst[1] = firstTimer;
        uint256 first = batchGas(withFirst, rewardTo);
        uint256 plain = batchGas(laterOnes(2), rewardTo);
        console.log("a first buy in a batch: gas over a later one", first - plain);
        assertLt(first - plain, BATCH_FIRST_BUY_EXTRA_GAS + 1, "within BATCH_FIRST_BUY_EXTRA_GAS");
    }
}

/// What v2 adds to a buy and to a creation, against v1 as deployed (`releases/v1`), measured
/// with this same `setUp` and method. Before v2 this compared the richer events and the
/// factory's vault list with the contracts before them (e31a86e: a later buy 234,209, a
/// funded creation 187,209); both are part of v1's figures below.
contract WhatV2AddsGasTest is ReceiptGas {
    /// A later buy on a busy pool, sent on its own, by v1 as deployed.
    uint256 internal constant V1_LATER_BUY = 235_073;
    /// A funded `createVault`, v1 as deployed.
    uint256 internal constant V1_CREATE_FUNDED = 214_637;
    /// What asking the registry may add to a buy: a buy inside its window paid to an
    /// eligible address, against the same buy paid to its owner, which asks nothing. The
    /// registry's account and a slot of its own cold, the holder's code, and the holder's
    /// SPX balance (whose account the buy would have warmed anyway). The spec put it at
    /// 7,000 to 9,000; with the real registry it measures 9,463, where the holder sends the
    /// buy itself and its account is warm. A cold wallet paid by a hot key adds 2,500 for
    /// its account, which the batch's fixed part above measures (`COLD_CHECK_GAS`).
    uint256 internal constant REGISTRY_CHECK_GAS = 10_000;
    /// What v2 may add to a buy that asks the registry nothing (paid to its owner, or after
    /// its window): working out `dueSince`, `Bought`'s two new words, and the address in the
    /// calldata.
    uint256 internal constant OPEN_BUY_EXTRA_GAS = 2_500;
    /// What v2's two terms, the window and its turns, may add to a creation: five more bytes
    /// of clone code, at 200 each, two calldata words, and two words of `VaultCreated`. The
    /// window alone measured about 2,000; turns, unused at launch, about 650 more.
    uint256 internal constant CREATE_EXTRA_GAS = 3_000;
    /// `EXECUTE_GAS` in `src/index.ts`, which `Gas.t.sol` pins for a first buy: a later buy
    /// is under it too.
    uint256 internal constant EXECUTE_GAS = 330_000;

    SpdexDcaVault internal vault;
    address internal creator;
    Plan internal plan;

    function setUp() public override {
        super.setUp();
        Plan memory p = defaultPlan();
        plan = p;
        vault = createFunded(p);
        vm.prank(keeper);
        vault.execute(keeper);
        // The owner holds WETH already, as the keeper does after its first reward, so that
        // paying either is the same write.
        vm.prank(owner);
        IWETHTest(WETH).deposit{value: 0.01 ether}();
        busyPoolAt(p.startAt + p.interval);
        creator = fresh("creator");
        vm.deal(creator, 1 ether);
    }

    function coolAll() internal {
        coolMarket();
        vmg.cool(address(vault));
        vmg.cool(owner);
        vmg.cool(creator);
    }

    /// The keeper's later buy, inside its window, paying `rewardTo`, as a transaction's
    /// receipt gas; then undone.
    function laterBuy(address rewardTo) internal returns (uint256 gas) {
        uint256 snapshot = vmg.snapshotState();
        coolAll();
        vm.prank(keeper);
        vault.execute(rewardTo);
        gas = receiptGas(abi.encodeCall(SpdexDcaVault.execute, (rewardTo)));
        vmg.revertToState(snapshot);
    }

    function test_whatV2AddsToABuyAndACreationIsWhatTheSpecSays() public {
        uint256 windowBuy = laterBuy(keeper); // an eligible address: the registry is asked
        uint256 ownerBuy = laterBuy(owner); // the owner: it is not

        bytes memory data = createCall(plan);
        coolAll();
        vm.prank(creator);
        (bool ok,) = address(factory).call{value: budgetOf(plan)}(data);
        assertTrue(ok, "created");
        uint256 create = receiptGas(data);

        console.log("v1's later buy on a busy pool, on its own: receipt gas", V1_LATER_BUY);
        console.log("v2's, paid to its owner (no registry): receipt gas", ownerBuy);
        console.log("v2's, inside its window, paid to a holder: receipt gas", windowBuy);
        console.log("v1's funded createVault: receipt gas", V1_CREATE_FUNDED);
        console.log("v2's: receipt gas", create);
        assertGt(windowBuy, ownerBuy, "asking the registry costs something");
        assertLt(windowBuy - ownerBuy, REGISTRY_CHECK_GAS + 1, "asking the registry costs at most 10,000");
        assertLt(ownerBuy, V1_LATER_BUY + OPEN_BUY_EXTRA_GAS + 1, "the rest of v2 costs a buy at most 2,500");
        assertLt(create, V1_CREATE_FUNDED + CREATE_EXTRA_GAS + 1, "v2's terms cost a creation at most 3,000");
        assertLt(windowBuy, EXECUTE_GAS + 1, "a later buy is within EXECUTE_GAS");
    }

    /// After its window a buy may pay anyone, and asks the registry nothing, so a buy paid to
    /// an address that never proved costs what the owner's own does at the same moment. The
    /// pool is made busy again at the window's end, so only the recipient differs.
    function test_aBuyAfterItsWindowCostsWhatTheOwnersOwnDoes() public {
        busyPoolAt(plan.startAt + plan.interval + plan.communityWindow);
        address outsider = fresh("outsider");
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        IWETHTest(WETH).deposit{value: 0.01 ether}();

        uint256 openBuy = laterBuy(outsider);
        uint256 ownerBuy = laterBuy(owner);
        console.log("v2's later buy after its window, paid to anyone: receipt gas", openBuy);
        console.log("v2's, at the same moment, paid to its owner: receipt gas", ownerBuy);
        uint256 gap = openBuy > ownerBuy ? openBuy - ownerBuy : ownerBuy - openBuy;
        assertLt(gap, 100, "the same, to within an address's calldata");
        assertLt(openBuy, V1_LATER_BUY + OPEN_BUY_EXTRA_GAS + 1, "v2 adds at most 2,500 to it");
    }
}
