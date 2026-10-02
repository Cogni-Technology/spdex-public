// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, IV3PoolTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";

// What an `execute` transaction sent on its own costs when the oracle pool is busy — the
// dear path, and the usual one for SPX on mainnet — pinned against the figures `src/index.ts`
// sizes "Trigger now" and its gas limit from. (A buy in a batch, which is how a keeper sends
// buys and what the buy fee is priced from, is `BatchGas.t.sol`'s.) The integration test
// measures real transactions on the shared fork, but that fork's pool is quiet (nothing
// trades on it unless a test does), so until this file the busy path was measured by hand
// and asserted nowhere (phase-5b review 2, finding 4).
//
// "Busy" means the pool's tick moved within the last ten minutes: `observe` then has to
// binary-search its 1,800 observations for the one ten minutes back, where on a quiet pool
// it extends the latest. The difference is about 57,000 gas.

/// Cheatcodes this file needs beyond the shared harness.
interface VmGas {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    /// Marks an account and every storage slot of it cold, as at the start of a transaction.
    function cool(address target) external;
}

interface IV3PoolObservations {
    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );
}

contract ExecuteGasTest is ForkTest {
    VmGas internal constant vmg = VmGas(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// `EXECUTE_GAS` in `src/index.ts`: what one buy sent on its own is sized from.
    uint256 internal constant EXECUTE_GAS = 320_000;
    /// `KEEPER_GAS_HEADROOM_BPS`: a wallet signs a lone `execute` with its estimate plus 20%.
    uint256 internal constant KEEPER_GAS_HEADROOM_BPS = 12_000;
    /// `MAX_EXECUTE_GAS_LIMIT`: the gas the batcher gives each vault (`EXECUTE_GAS_CAP`).
    uint256 internal constant MAX_EXECUTE_GAS_LIMIT = 400_000;
    /// What a transaction pays before its first opcode: the 21,000 base, and the calldata —
    /// `execute()`'s selector, four non-zero bytes at 16 each.
    uint256 internal constant INTRINSIC = 21_000 + 4 * 16;

    SpdexDcaVault internal vault;
    uint256 internal lastTradeAt;

    /// Two trades on SPX's 0.3% pool, a block apart — 1 WETH in and the SPX back out, each
    /// moving the tick by hundreds, so each writes an observation — then a vault created
    /// and funded a block later. Done here rather than in the test so that it is an earlier
    /// transaction than the buy, as it would be on chain: the slots it writes are not the
    /// buy's to find already dirty.
    function setUp() public override {
        super.setUp();
        vm.deal(address(this), 1 ether);
        IWETHTest(WETH).deposit{value: 1 ether}();
        (int256 wethIn, int256 spxOut) =
            IV3PoolTest(SPX_WETH_POOL).swap(address(this), true, int256(1 ether), 4295128740, "");
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);
        IV3PoolTest(SPX_WETH_POOL)
            .swap(address(this), false, -spxOut, 1461446703485210103287273052203988822378723970341, "");
        assertGt(uint256(wethIn), 0, "traded in");
        lastTradeAt = block.timestamp;
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);

        vault = createFunded(defaultPlan());
    }

    /// The accounts one buy touches, cold again: in a transaction nothing is warm but the
    /// sender and the vault it is sent to, and the measurement below charges for the vault
    /// too (2,500 gas a real transaction does not pay), so it errs high.
    function coolAll() internal {
        vmg.cool(address(vault));
        vmg.cool(factory.implementation());
        vmg.cool(WETH);
        vmg.cool(SPX);
        vmg.cool(SPX_WETH_PAIR);
        vmg.cool(SPX_WETH_POOL);
    }

    /// A buy's gas as a transaction would use it: the call from cold, plus the intrinsic.
    function measuredBuy() internal returns (uint256) {
        coolAll();
        vm.prank(keeper);
        uint256 g = gasleft();
        vault.execute();
        return g - gasleft() + INTRINSIC;
    }

    /// The least gas limit the buy succeeds with — what `eth_estimateGas` would answer —
    /// found by bisection on copies of this moment.
    function estimatedBuy() internal returns (uint256) {
        uint256 low = 50_000;
        uint256 high = 1_000_000;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            uint256 snapshot = vmg.snapshotState();
            coolAll();
            vm.prank(keeper);
            (bool ok,) = address(vault).call{gas: middle}(abi.encodeCall(SpdexDcaVault.execute, ()));
            vmg.revertToState(snapshot);
            if (ok) high = middle;
            else low = middle + 1;
        }
        return low + INTRINSIC;
    }

    function poolIsBusy() internal view returns (bool) {
        (,, uint16 index,,,,) = IV3PoolTest(SPX_WETH_POOL).slot0();
        (uint32 newest,,,) = IV3PoolObservations(SPX_WETH_POOL).observations(index);
        return newest + 600 > block.timestamp;
    }

    /// The dear case `EXECUTE_GAS` has to cover: a first buy (an owner who never held SPX, a
    /// keeper who never held WETH, the vault's counters written from zero) on a pool that
    /// traded a block ago.
    function test_aFirstBuyOnABusyPoolFitsEXECUTE_GAS() public {
        assertTrue(poolIsBusy(), "the pool traded within the last ten minutes");
        assertEq(spxOf(owner) + wethOf(keeper), 0, "a fresh owner and keeper");
        uint256 used = measuredBuy();
        assertEq(vault.buysDone(), 1, "it bought");
        console.log("execute, first buy, busy pool: transaction gas (at most)", used);
        assertLt(used, EXECUTE_GAS + 1, "within EXECUTE_GAS");
    }

    /// And the gas limit a wallet would sign it with, estimate plus 20%, is within what the
    /// batcher gives a vault.
    function test_aKeepersLimitForAFirstBuyOnABusyPoolIsUnderItsCap() public {
        assertTrue(poolIsBusy(), "the pool traded within the last ten minutes");
        uint256 estimate = estimatedBuy();
        uint256 limit = (estimate * KEEPER_GAS_HEADROOM_BPS + 9_999) / 10_000;
        console.log("execute, first buy, busy pool: eth_estimateGas (about)", estimate);
        console.log("execute, first buy, busy pool: gas limit, estimate plus 20%", limit);
        assertLt(limit, MAX_EXECUTE_GAS_LIMIT + 1, "under the batcher's cap");
        // And under the least limit a lone `execute` is signed with, so a Trigger now
        // estimated on a quiet pool still has the gas when a trade lands first
        // (`KEEPER_MIN_EXECUTE_GAS_LIMIT`).
        assertLt(estimate, (EXECUTE_GAS * KEEPER_GAS_HEADROOM_BPS) / 10_000 + 1, "under the Trigger now floor");
    }

    /// The cheap case, for the record and to check this file's method against a real
    /// transaction: the same first buy once the pool has been quiet for ten minutes. The
    /// integration test measured 247,341 for it on the shared fork.
    function test_aFirstBuyOnAQuietPool() public {
        vm.warp(lastTradeAt + 601);
        assertTrue(!poolIsBusy(), "the pool has been quiet for ten minutes");
        uint256 used = measuredBuy();
        console.log("execute, first buy, quiet pool: transaction gas (at most)", used);
        assertLt(used, EXECUTE_GAS + 1, "within EXECUTE_GAS");
    }
}
