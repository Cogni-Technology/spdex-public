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
// the pair gives back 2,800, and the batcher's WETH balance, written from zero and emptied
// in the same transaction, gives back 19,900. Everything a transaction starts cold with is
// cooled first, and what the measured transaction reads was written by earlier ones, in
// `setUp`, so no slot is found already dirty. Measured this way, the contracts at e31a86e
// gave 187,209 for a funded creation, the same figure a real transaction on the fork gave
// in the research this fee comes from.
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

contract BatchGasTest is ReceiptGas {
    /// `BATCH_PER_BUY_GAS` in `src/fee.ts`: a later buy's share of a batch, on a busy pool.
    uint256 internal constant BATCH_PER_BUY_GAS = 106_000;
    /// `BATCH_FIXED_GAS`: what a batch pays once, whatever its size.
    uint256 internal constant BATCH_FIXED_GAS = 160_000;
    /// `BATCH_FIRST_BUY_EXTRA_GAS`: what a plan's first buy costs over a later one.
    uint256 internal constant BATCH_FIRST_BUY_EXTRA_GAS = 51_000;
    /// A `rewardTo` that has never held WETH has its balance written from zero, once.
    uint256 internal constant FRESH_REWARD_TO_EXTRA_GAS = 15_000;

    SpdexVaultBatcher internal batcher;
    /// Five vaults, each of a different owner, that have each bought once and are due again.
    address[] internal later;
    /// A vault due for its first buy, whose owner has never held SPX.
    address internal firstTimer;
    /// Holds WETH already: the steady state of a keeper's reward address.
    address internal rewardTo;
    /// Has never held WETH.
    address internal freshRewardTo;

    function setUp() public override {
        super.setUp();
        batcher = deployBatcher();
        Plan memory p = defaultPlan();
        for (uint256 i; i < 6; i++) {
            // "gas-owner-1" to "gas-owner-6": owners of their own, as a batch's vaults are.
            address who = fresh(string(abi.encodePacked("gas-owner-", bytes1(uint8(49 + i)))));
            vm.deal(who, 1 ether);
            vm.prank(who);
            address vault = factory.createVault{value: budgetOf(p)}(
                p.marketIndex, p.amountPerBuy, p.interval, p.maxBuys, p.startAt, p.keeperReward, p.maxSlippageBps
            );
            if (i == 5) {
                firstTimer = vault;
                continue;
            }
            vm.prank(keeper);
            SpdexDcaVault(payable(vault)).execute();
            later.push(vault);
        }
        rewardTo = fresh("reward-to");
        vm.deal(rewardTo, 1 ether);
        vm.prank(rewardTo);
        IWETHTest(WETH).deposit{value: 0.01 ether}();
        freshRewardTo = fresh("fresh-reward-to");

        busyPoolAt(p.startAt + p.interval);
    }

    /// One batch of `vaults`, paid to `to`, as a transaction's receipt gas; every vault in it
    /// must buy. The state is put back afterwards, so each measurement starts from `setUp`.
    function batchGas(address[] memory vaults, address to) internal returns (uint256 used) {
        uint256 snapshot = vmg.snapshotState();
        bytes memory data = abi.encodeCall(SpdexVaultBatcher.executeBatch, (vaults, to, 0));
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
        list = new address[](n);
        for (uint256 i; i < n; i++) {
            list[i] = later[i];
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

/// What the richer events and the vault list cost, against the same figures measured on the
/// contracts before them (e31a86e), with this same `setUp` and method.
contract EventAndListGasTest is ReceiptGas {
    /// A later buy on a busy pool, sent on its own, at e31a86e: the old `Bought`.
    uint256 internal constant OLD_LATER_BUY = 234_209;
    /// A funded `createVault` at e31a86e: no list, and a `VaultCreated` without `funded`.
    uint256 internal constant OLD_CREATE_FUNDED = 187_209;
    /// What `Bought`'s three new words may add to a buy.
    uint256 internal constant BOUGHT_EXTRA_GAS = 1_000;
    /// What the list's push and `VaultCreated.funded` may add to a creation.
    uint256 internal constant CREATE_EXTRA_GAS = 31_000;
    /// `EXECUTE_GAS` in `src/index.ts`, which `Gas.t.sol` pins for a first buy: a later buy
    /// is under it too.
    uint256 internal constant EXECUTE_GAS = 320_000;

    SpdexDcaVault internal vault;
    address internal creator;

    function setUp() public override {
        super.setUp();
        Plan memory p = defaultPlan();
        vault = createFunded(p);
        vm.prank(keeper);
        vault.execute();
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

    function test_theEventAndListChangesCostWhatTheSpecSays() public {
        uint256 snapshot = vmg.snapshotState();
        coolAll();
        vm.prank(keeper);
        vault.execute();
        uint256 buy = receiptGas(abi.encodeCall(SpdexDcaVault.execute, ()));
        vmg.revertToState(snapshot);

        Plan memory p = defaultPlan();
        bytes memory data = createCall(p);
        coolAll();
        vm.prank(creator);
        (bool ok,) = address(factory).call{value: budgetOf(p)}(data);
        assertTrue(ok, "created");
        uint256 create = receiptGas(data);

        console.log("a later buy on a busy pool, on its own: receipt gas", buy);
        console.log("  over the old Bought", buy - OLD_LATER_BUY);
        console.log("a funded createVault: receipt gas", create);
        console.log("  over the old factory", create - OLD_CREATE_FUNDED);
        assertLt(buy, OLD_LATER_BUY + BOUGHT_EXTRA_GAS + 1, "Bought's three words cost at most 1,000 a buy");
        assertLt(create, OLD_CREATE_FUNDED + CREATE_EXTRA_GAS + 1, "the list and funded cost at most 31,000 a creation");
        assertLt(buy, EXECUTE_GAS + 1, "a later buy is within EXECUTE_GAS");
    }
}
