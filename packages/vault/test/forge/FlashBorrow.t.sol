// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, Plan} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultBatcher} from "../../contracts/SpdexVaultBatcher.sol";
import {SpxHolderRegistry} from "../../contracts/SpxHolderRegistry.sol";

// A known limit, measured rather than argued (`docs/V2_UPGRADE.md`, decision 17, "What a
// flash loan can and can't do"). The registry proves that an address held 690 SPX when a
// block closed, which borrowed SPX never does; but the check at the moment of a buy is a
// `balanceOf`, and SPX borrowed inside the same transaction meets it. Uniswap v4's
// `PoolManager` lends any token it holds for nothing within one transaction (`take`, then
// `sync` and `settle` before `unlock` returns), and one borrow covers a whole batch.
//
// So this file asserts that the borrow WORKS: a real holder proves from its recorded mainnet
// proof, sends all its SPX away, and is still paid for a batch of buys inside their community
// windows by borrowing 690 SPX from v4 around the batch. It logs what that costs over the same
// batch sent by the holder still holding its SPX, and the fee v4 charged (none). Those are
// the figures the release publishes. Nothing in the contracts stops it, and nothing should
// pretend to: the balance check still stops a holder who sold and wrote no contract for it.
//
// The searcher in the spec's "Why" ran single-use EIP-7702 accounts; the borrower here is the
// same shape: the holder's own address delegated to a small contract (`vm.etch` of the
// 23-byte designator, `0xef0100` and the delegate's address, exactly what a delegation puts
// there), sending to itself. The registry pays only accounts — no code, or a designator and
// nothing else — since a contract could pass a fee on to anyone; an account delegated by its
// own key is still its holder's, and it borrows as easily. The delegate's code is loaded cold,
// as a real transaction finds it.

/// Cheatcodes this file needs beyond the shared harness.
struct FlashCallGas {
    uint64 gasLimit;
    uint64 gasTotalUsed;
    uint64 gasMemoryUsed;
    int64 gasRefunded;
    uint64 gasRemaining;
}

interface VmFlash {
    function etch(address target, bytes calldata code) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    /// Marks an account and every storage slot of it cold, as at the start of a transaction.
    function cool(address target) external;
    /// The gas the last call used, from the callee's side, with the refunds it earned.
    function lastCallGas() external view returns (FlashCallGas memory);
}

/// The four functions of Uniswap v4's `PoolManager` a flash borrow uses. `Currency` is an
/// address in the ABI.
interface IPoolManagerFlash {
    function unlock(bytes calldata data) external returns (bytes memory);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
}

/// A community keeper's account that holds no SPX of its own and borrows the minimum around
/// each batch: `run`, sent by the account to itself, unlocks v4's `PoolManager`; inside
/// `unlockCallback` it takes `borrow` SPX, sends the batch paying itself, and pays the SPX
/// back. Its immutables are written into its code, so an account delegated to it runs it
/// unchanged, with the account's own address as `address(this)`.
contract FlashKeeper {
    error NotSelf();
    error NotPoolManager();

    IPoolManagerFlash internal immutable poolManager;
    SpdexVaultBatcher internal immutable batcher;
    IERC20Test internal immutable spx;
    uint256 internal immutable borrow;

    constructor(address poolManager_, address batcher_, address spx_, uint256 borrow_) {
        poolManager = IPoolManagerFlash(poolManager_);
        batcher = SpdexVaultBatcher(batcher_);
        spx = IERC20Test(spx_);
        borrow = borrow_;
    }

    /// Only the account itself may start a borrow, as an EIP-7702 account sending to itself.
    function run(address[] calldata vaults) external returns (uint256 bought, uint256 earned) {
        if (msg.sender != address(this)) revert NotSelf();
        (bought, earned) = abi.decode(poolManager.unlock(abi.encode(vaults)), (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        address[] memory vaults = abi.decode(data, (address[]));
        poolManager.take(address(spx), address(this), borrow);
        (uint256 bought, uint256 earned,) = batcher.executeBatch(vaults, address(this), 0, batcher.MIN_EXECUTE_GAS());
        poolManager.sync(address(spx));
        spx.transfer(address(poolManager), borrow);
        poolManager.settle();
        return abi.encode(bought, earned);
    }
}

contract FlashBorrowTest is ForkTest {
    VmFlash internal constant vmx = VmFlash(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Uniswap v4's singleton, `docs/UNISWAP-V4.md`: every v4 pool's tokens in one contract.
    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    /// Vaults in the batch.
    uint256 internal constant BATCH = 5;
    /// What a borrow around a batch may add: measured at about 42,600 at the pinned block
    /// (taking, syncing, paying back and settling 690 SPX, the `PoolManager`'s lock, the
    /// account's own call frame, its delegate's code loaded cold, and the registry reading a
    /// delegated account's 23 bytes of code for each vault), against `BATCHED_BUY_GAS`'s
    /// 126,000 for one buy. Spread over a batch it is a few thousand gas a buy, so it is no
    /// defence, and it is published as one of the release's figures.
    uint256 internal constant FLASH_BORROW_GAS = 50_000;

    SpdexVaultBatcher internal batcher;
    address[] internal vaults;
    Plan internal plan;

    /// Five vaults due now, inside their community windows, each of an owner of its own; the
    /// real holder proven from its recorded proof.
    function setUp() public override {
        super.setUp();
        batcher = deployBatcher();
        Plan memory p = defaultPlan();
        plan = p;
        for (uint256 i; i < BATCH; i++) {
            address who = fresh(string(abi.encodePacked("flash-owner-", bytes1(uint8(49 + i)))));
            vm.deal(who, 1 ether);
            vm.prank(who);
            vaults.push(
                factory.createVault{value: budgetOf(p)}(
                    p.marketIndex,
                    p.amountPerBuy,
                    p.interval,
                    p.maxBuys,
                    p.startAt,
                    p.keeperReward,
                    p.maxSlippageBps,
                    p.communityWindow,
                    p.turnBuckets
                )
            );
        }
        proveRecorded(HOLDER_PROOF);
    }

    /// What the batch touches, cold, as at the start of a transaction. The holder is the
    /// sender, so it is warm.
    function coolAll() internal {
        vmx.cool(address(batcher));
        vmx.cool(address(factory));
        vmx.cool(factory.implementation());
        vmx.cool(registry);
        vmx.cool(WETH);
        vmx.cool(SPX);
        vmx.cool(SPX_WETH_PAIR);
        vmx.cool(SPX_WETH_POOL);
        vmx.cool(POOL_MANAGER);
        for (uint256 i; i < vaults.length; i++) {
            vmx.cool(vaults[i]);
            vmx.cool(SpdexDcaVault(payable(vaults[i])).owner());
        }
    }

    /// The last call as a transaction with this calldata: base, calldata, execution, refunds
    /// (at most a fifth), as `BatchGas.t.sol` measures.
    function receiptGas(bytes memory data) internal view returns (uint256) {
        FlashCallGas memory g = vmx.lastCallGas();
        uint256 total = 21_000 + g.gasTotalUsed;
        for (uint256 i; i < data.length; i++) {
            total += data[i] == 0 ? 4 : 16;
        }
        uint256 refund = g.gasRefunded > 0 ? uint256(int256(g.gasRefunded)) : 0;
        if (refund > total / 5) refund = total / 5;
        return total - refund;
    }

    /// v4 holds SPX at the pinned block, from its two SPX/ETH pools: the measurement below
    /// borrows what is really there, with nothing dealt to the `PoolManager`.
    function test_v4sPoolManagerHoldsEnoughSpxToLendAtThePinnedBlock() public view {
        uint256 lendable = spxOf(POOL_MANAGER);
        console.log("SPX the v4 PoolManager holds at the pinned block (raw, 8 decimals)", lendable);
        console.log("that is, whole SPX", lendable / 1e8);
        assertGe(lendable, MIN_SPX, "at least 690 SPX to lend");
    }

    /// The batch sent by the holder itself, holding its own SPX: the baseline. Undone.
    function plainBatchGas() internal returns (uint256 gas) {
        bytes memory data = abi.encodeCall(SpdexVaultBatcher.executeBatch, (vaults, HOLDER, 0, BATCH_GAS));
        uint256 snapshot = vmx.snapshotState();
        coolAll();
        vm.prank(HOLDER);
        (bool ok,) = address(batcher).call(data);
        assertTrue(ok, "the plain batch went through");
        gas = receiptGas(data);
        vmx.revertToState(snapshot);
    }

    /// The holder sells, or moves its SPX to another wallet: the proof stands, the check
    /// fails, and the same batch is refused by every vault.
    function moveEverythingAway() internal {
        address elsewhere = fresh("elsewhere");
        uint256 held = spxOf(HOLDER);
        vm.prank(HOLDER);
        IERC20Test(SPX).transfer(elsewhere, held);
        assertEq(spxOf(HOLDER), 0, "holds no SPX");
        assertTrue(!SpxHolderRegistry(registry).isEligible(HOLDER), "not eligible without SPX");
        bytes4[] memory refused = new bytes4[](BATCH);
        for (uint256 i; i < BATCH; i++) {
            refused[i] = SpdexDcaVault.NotEligible.selector;
        }
        vm.prank(HOLDER);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, refused));
        batcher.executeBatch(vaults, HOLDER, 0, BATCH_GAS);
    }

    /// The same batch wrapped in a borrow, sent by the holder to itself, its account
    /// delegated to a flash keeper as EIP-7702 delegates one: the designator alone on it.
    function flashBatch() internal returns (uint256 gas, uint256 boughtCount, uint256 earned) {
        FlashKeeper delegate = new FlashKeeper(POOL_MANAGER, address(batcher), SPX, MIN_SPX);
        vmx.etch(HOLDER, abi.encodePacked(hex"ef0100", address(delegate)));
        assertTrue(!SpxHolderRegistry(registry).isEligible(HOLDER), "delegated, and still holding nothing");
        bytes memory data = abi.encodeCall(FlashKeeper.run, (vaults));
        coolAll();
        vmx.cool(address(delegate));
        vm.prank(HOLDER);
        (bool ok, bytes memory returned) = HOLDER.call(data);
        assertTrue(ok, "the flash-borrowed batch went through");
        gas = receiptGas(data);
        (boughtCount, earned) = abi.decode(returned, (uint256, uint256));
    }

    /// The holder sends the batch itself while holding its SPX: the baseline. Then it sends
    /// all its SPX away, and the same batch from it is refused by every vault. Delegated to a
    /// flash keeper, the same batch, wrapped in a 690-SPX borrow from v4, buys every vault
    /// inside its window and pays it every fee; v4 gets back exactly what it lent.
    function test_aFlashBorrowFromV4MeetsTheBalanceCheckForAProvenHolderThatHoldsNothing() public {
        assertGe(spxOf(POOL_MANAGER), MIN_SPX, "v4 has the SPX to lend");
        assertTrue(SpxHolderRegistry(registry).isEligible(HOLDER), "proven, and holding its own SPX");

        uint256 plainGas = plainBatchGas();
        moveEverythingAway();

        uint256 poolManagerBefore = spxOf(POOL_MANAGER);
        uint256 wethBefore = wethOf(HOLDER);
        (uint256 flashGas, uint256 boughtCount, uint256 earned) = flashBatch();

        assertLt(block.timestamp, plan.startAt + plan.communityWindow, "inside the community windows");
        assertEq(boughtCount, BATCH, "every vault bought");
        assertEq(earned, BATCH * plan.keeperReward, "every fee earned");
        assertEq(wethOf(HOLDER) - wethBefore, earned, "and paid to the holder's address");
        for (uint256 i; i < BATCH; i++) {
            assertEq(SpdexDcaVault(payable(vaults[i])).windowBuys(), 1, "each a community buy");
        }
        assertEq(spxOf(HOLDER), 0, "the borrowed SPX went back: the holder holds none");
        assertEq(spxOf(POOL_MANAGER), poolManagerBefore, "v4 holds exactly what it held");
        uint256 v4Fee = spxOf(POOL_MANAGER) - poolManagerBefore;

        console.log("SPX borrowed from v4 (raw)", MIN_SPX);
        console.log("v4's fee for the borrow (raw SPX)", v4Fee);
        console.log("batch of 5 in-window buys, holder holding SPX: receipt gas", plainGas);
        console.log("the same batch, flash-borrowed from v4: receipt gas", flashGas);
        console.log("what the borrow adds, per batch", flashGas - plainGas);
        console.log("what the borrow adds, per buy in a batch of 5", (flashGas - plainGas) / BATCH);
        assertEq(v4Fee, 0, "v4 lends for nothing");
        assertGt(flashGas, plainGas, "the borrow costs gas");
        assertLt(flashGas - plainGas, FLASH_BORROW_GAS + 1, "and not much: under half of one batched buy's gas");
    }
}
